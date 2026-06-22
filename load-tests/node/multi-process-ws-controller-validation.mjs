import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  ControllerConfigError, EXIT_CODES, MultiProcessWsController,
  atomicWriteJson, determineExitCode, planCredentialSlices,
} from './multi-process-ws-controller.mjs';

let passed = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const test = async (name, operation) => {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};
const fakeUser = (index, mode = 'normal') => ({
  email: `${mode}-${index}@example.test`, password: `fake-password-${index}`,
});

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), message);
}

async function createFixture(root) {
  const path = join(root, 'fake-worker.mjs');
  await writeFile(path, `
import process from 'node:process';
const index = Number(process.argv[2]);
let heartbeat;
let completed = false;
let mode = 'normal';
let profileCount = 0;
const send = (message) => {
  if (!process.connected) return;
  try { process.send(message, () => {}); } catch {}
};
const metrics = (profiles, overrides = {}) => ({
  loginAttempts: profiles, loginSuccesses: profiles, loginFailures: 0,
  wsAttempts: profiles, wsOpens: profiles, wsRetries: 0,
  peakReadyProfiles: profiles, peakReadyTables: profiles / 4,
  stableProfilesAtRelease: profiles, stableTablesAtRelease: profiles / 4,
  currentActiveSockets: 0, peakActiveSockets: profiles,
  terminalProfileFailures: 0, wsTerminalFailures: 0, holdFailures: 0,
  wsPings: profiles, wsPongs: profiles, cleanupCompleted: 1, ...overrides,
});
const finish = (profiles, overrides = {}) => {
  if (completed) return;
  completed = true;
  clearInterval(heartbeat);
  send({ type: 'shutdown-complete', metrics: metrics(profiles, overrides) });
};
setTimeout(() => send({ type: 'worker-ready' }), index * 12);
process.on('message', (message) => {
  if (message?.type === 'start') {
    const profiles = message.credentials.length;
    profileCount = profiles;
    mode = message.credentials[0]?.email.split('-')[0] ?? 'normal';
    send({ type: 'progress', phase: 'readiness', lastProgressAtMs: Date.now(),
      metrics: metrics(profiles), observedTimestamps: {
      loginStartAtMs: message.config.loginStartAtMs, wsStartAtMs: message.config.wsStartAtMs,
      readinessDeadlineAtMs: message.config.readinessDeadlineAtMs,
      releaseAtMs: message.config.releaseAtMs,
    }});
    if (mode === 'failedipc') {
      send({ type: 'failed', phase: 'readiness', lastProgressAtMs: Date.now(),
        metrics: metrics(profiles, { wsTerminalFailures: 1, terminalProfileFailures: 1 }) });
      return;
    }
    if (mode === 'crash') return setTimeout(() => process.exit(9), 25);
    if (mode === 'disconnect') return setTimeout(() => process.disconnect(), 25);
    if (mode !== 'no' && mode !== 'hang') {
      setTimeout(() => finish(profiles, mode === 'failure' ? {
        stableProfilesAtRelease: 0, stableTablesAtRelease: 0,
        terminalProfileFailures: profiles, wsTerminalFailures: profiles,
      } : {}), 90);
    }
    if (mode !== 'no') heartbeat = setInterval(() => send({ type: 'heartbeat',
      phase: 'hold', lastProgressAtMs: Date.now(),
      rssBytes: 1000 + index, heapUsedBytes: 500 + index,
      eventLoopDelayMeanMs: 1 + index, eventLoopDelayMaxMs: 2 + index,
      metrics: metrics(profiles) }), 15);
  }
  if (message?.type === 'shutdown') {
    if (mode === 'hang') return;
    finish(profileCount, mode === 'failedipc'
      ? { wsTerminalFailures: 1, terminalProfileFailures: 1 } : {});
    if (mode === 'postcomplete9') return setTimeout(() => process.exit(9), 5);
    setTimeout(() => { if (process.connected) process.disconnect(); }, 5);
  }
});
`, 'utf8');
  return path;
}

function baseConfig(credentialsPath, outputDirectory, overrides = {}) {
  return {
    tables: 4, workerCount: 4,
    baseUrl: 'http://127.0.0.1:3101', wsUrl: 'ws://127.0.0.1:3101/ws',
    credentialsPath, outputDirectory, loginSpreadMs: 0, wsStartDelayMs: 10,
    readinessDurationMs: 30, holdDurationMs: 30, heartbeatTimeoutMs: 1_000,
    hardTimeoutMs: 2_000, shutdownGraceMs: 80, partialIntervalMs: 20,
    heartbeatIntervalMs: 15, ...overrides,
  };
}

async function writeCredentials(path, count, mode = 'normal') {
  await writeFile(path, JSON.stringify({
    users: Array.from({ length: count }, (_, index) => fakeUser(index, mode)),
  }), 'utf8');
}

async function startRealWorkerServers() {
  const observed = { loginAttempts: 0, activeSockets: 0 };
  const http = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/auth/login') {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    observed.loginAttempts += 1;
    if (body.email === 'real-fail@example.test') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    const id = body.email.match(/^real-(\d+)@example\.test$/)?.[1] ?? 'unknown';
    response.writeHead(200, { 'content-type': 'application/json',
      'set-cookie': `belot_session=local-${id}; HttpOnly; Path=/` });
    response.end(JSON.stringify({ ok: true, session: { profile: true } }));
  });
  const ws = new WebSocketServer({ server: http, path: '/ws' });
  ws.on('connection', (socket) => {
    observed.activeSockets += 1;
    socket.once('close', () => { observed.activeSockets -= 1; });
    socket.send(JSON.stringify({ type: 'connected' }));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    });
  });
  http.listen(3101, '127.0.0.1');
  await once(http, 'listening');
  return { observed, async close() {
    for (const socket of ws.clients) socket.terminate();
    await new Promise((resolveClose) => ws.close(resolveClose));
    await new Promise((resolveClose) => http.close(resolveClose));
  } };
}

function trackedFork(workerPath, observation) {
  return (modulePath, args, options) => {
    const child = fork(workerPath ?? modulePath, args, options);
    observation.children.push(child);
    child.on('message', (message) => {
      if (message?.type === 'worker-ready') observation.readyTimes.push(Date.now());
      if (message?.observedTimestamps) observation.observedTimestamps.push(message.observedTimestamps);
    });
    const originalSend = child.send.bind(child);
    child.send = (message, ...rest) => {
      if (message?.type === 'start') {
        observation.startTimes.push(Date.now());
        observation.startMessages.push(message);
      }
      return originalSend(message, ...rest);
    };
    return child;
  };
}

async function runScenario(root, fixture, mode, overrides = {}) {
  const directory = join(root, `out-${mode}-${Date.now()}-${Math.random()}`);
  const credentialsPath = join(root, `credentials-${mode}-${Date.now()}-${Math.random()}.json`);
  await writeCredentials(credentialsPath, 16, mode);
  const observation = { children: [], readyTimes: [], startTimes: [],
    startMessages: [], observedTimestamps: [] };
  const controller = new MultiProcessWsController(
    baseConfig(credentialsPath, directory, overrides),
    { workerPath: fixture, fork: trackedFork(fixture, observation) },
  );
  const summary = await controller.run();
  return { controller, summary, observation, directory, credentialsPath };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'belot-controller-validation-'));
  try {
    const fixture = await createFixture(root);

    await test('credentials slicing covers 8 workers without overlaps or gaps', () => {
      const credentials = Array.from({ length: 1600 }, (_, index) => fakeUser(index));
      const slices = planCredentialSlices(credentials, 400, 8);
      assert.equal(slices.length, 8);
      assert.ok(slices.every((slice) => slice.tableCount === 50 && slice.profileCount === 200));
      const indexes = slices.flatMap((slice) => slice.credentials.map((user) => Number(
        user.email.match(/-(\d+)@/)?.[1],
      )));
      assert.deepEqual(indexes, Array.from({ length: 1600 }, (_, index) => index));
    });

    await test('insufficient credentials are rejected during slicing', () => {
      assert.throws(() => planCredentialSlices(
        Array.from({ length: 15 }, (_, index) => fakeUser(index)), 4, 4,
      ), ControllerConfigError);
    });

    await test('fail-closed table and worker limits accept 400 and reject overflow', () => {
      const credentials = Array.from({ length: 1604 }, (_, index) => fakeUser(index));
      assert.equal(planCredentialSlices(credentials, 400, 8).length, 8);
      assert.throws(() => planCredentialSlices(credentials, 401, 8), ControllerConfigError);
      assert.throws(() => planCredentialSlices(credentials, 400, 33), ControllerConfigError);
    });

    const normal = await runScenario(root, fixture, 'normal');
    await test('all workers are ready before start and receive identical timestamps', () => {
      assert.equal(normal.observation.readyTimes.length, 4);
      assert.equal(normal.observation.startTimes.length, 4);
      assert.ok(Math.min(...normal.observation.startTimes) >= Math.max(...normal.observation.readyTimes));
      const timestamps = normal.observation.startMessages.map((message) => JSON.stringify({
        loginStartAtMs: message.config.loginStartAtMs, wsStartAtMs: message.config.wsStartAtMs,
        readinessDeadlineAtMs: message.config.readinessDeadlineAtMs,
        releaseAtMs: message.config.releaseAtMs,
      }));
      assert.equal(new Set(timestamps).size, 1);
    });

    await test('controller sends exact credential slices only through IPC', () => {
      const slices = normal.observation.startMessages.map((message) => message.credentials);
      assert.ok(slices.every((slice) => slice.length === 4));
      assert.equal(new Set(slices.flatMap((slice) => slice.map((user) => user.email))).size, 16);
      for (const child of normal.observation.children) {
        assert.doesNotMatch(child.spawnargs.join(' '), /example\.test|fake-password/);
      }
    });

    await test('heartbeat, memory, event-loop and workload metrics aggregate', () => {
      assert.equal(normal.summary.metrics.loginAttempts, 16);
      assert.equal(normal.summary.metrics.stableProfilesAtRelease, 16);
      assert.equal(normal.summary.metrics.stableTablesAtRelease, 4);
      assert.ok(normal.summary.workers.every((worker) => worker.memory?.rssBytes > 0));
      assert.ok(normal.summary.workers.every((worker) => worker.eventLoopDelay?.maxMs >= 2));
    });

    await test('graceful success exits all children without orphans', () => {
      assert.equal(normal.summary.exitCode, EXIT_CODES.success);
      assert.equal(normal.summary.cleanup.completedWorkers, 4);
      assert.equal(normal.summary.cleanup.forcedWorkers, 0);
      assert.ok(normal.observation.children.every((child) => child.exitCode !== null));
    });

    await test('final summary includes lifecycle and real child exit status', () => {
      assert.ok(Number.isFinite(normal.summary.startedAtMs));
      assert.ok(Number.isFinite(normal.summary.completedAtMs));
      assert.equal(normal.summary.durationMs,
        normal.summary.completedAtMs - normal.summary.startedAtMs);
      assert.ok(normal.summary.durationMs >= 0);
      for (const worker of normal.summary.workers) {
        assert.equal(worker.exitCode, 0);
        assert.equal(worker.signalCode, null);
        assert.ok(Number.isFinite(worker.exitedAtMs));
        assert.equal(typeof worker.phase, 'string');
        assert.ok(Number.isFinite(worker.lastHeartbeatAtMs));
        assert.ok(Number.isFinite(worker.lastProgressAtMs));
      }
    });

    await test('partial and final summaries are valid atomic JSON without secrets', async () => {
      const partialPath = join(normal.directory, 'multi-process-ws-partial.json');
      const finalPath = join(normal.directory, 'multi-process-ws-final.json');
      const partial = JSON.parse(await readFile(partialPath, 'utf8'));
      const final = JSON.parse(await readFile(finalPath, 'utf8'));
      assert.equal(partial.status, 'partial');
      assert.equal(final.status, 'final');
      assert.equal(final.exitCode, 0);
      const files = await readdir(normal.directory);
      assert.ok(files.every((name) => !name.includes('.tmp-')));
      assert.doesNotMatch(JSON.stringify({ partial, final }), /fake-password|example\.test|belot_session/i);
    });

    await test('atomic writer renames a complete temporary JSON document', async () => {
      const calls = [];
      await atomicWriteJson(join(root, 'atomic', 'summary.json'), { ok: true }, {
        mkdir: async () => calls.push('mkdir'),
        writeFile: async (path, content) => { calls.push('write'); JSON.parse(content); assert.match(path, /\.tmp-/); },
        rename: async (from, to) => { calls.push('rename'); assert.match(from, /\.tmp-/); assert.match(to, /summary\.json$/); },
      });
      assert.deepEqual(calls, ['mkdir', 'write', 'rename']);
    });

    await test('heartbeat timeout returns orchestration exit code', async () => {
      const result = await runScenario(root, fixture, 'no', { heartbeatTimeoutMs: 300 });
      assert.equal(result.summary.exitCode, EXIT_CODES.orchestration);
      assert.equal(result.summary.metrics.heartbeatTimeouts, 1);
      assert.ok(result.observation.children.every((child) => child.exitCode !== null));
    });

    await test('worker crash returns orchestration exit code', async () => {
      const result = await runScenario(root, fixture, 'crash');
      assert.equal(result.summary.exitCode, EXIT_CODES.orchestration);
      assert.ok(result.summary.metrics.workerCrashes >= 1);
      assert.ok(result.observation.children.every((child) => child.exitCode !== null));
    });

    await test('unexpected IPC disconnect returns orchestration exit code', async () => {
      const result = await runScenario(root, fixture, 'disconnect');
      assert.equal(result.summary.exitCode, EXIT_CODES.orchestration);
      assert.ok(result.summary.metrics.workerCrashes >= 1);
      assert.ok(result.observation.children.every((child) => child.exitCode !== null));
    });

    await test('failed IPC triggers immediate orchestration shutdown', async () => {
      const startedAt = Date.now();
      const result = await runScenario(root, fixture, 'failedipc', { hardTimeoutMs: 2_000 });
      assert.equal(result.summary.exitCode, EXIT_CODES.orchestration);
      assert.ok(Date.now() - startedAt < 1_000);
      assert.equal(result.summary.workers.some((worker) => worker.failed), true);
      assert.equal(result.summary.metrics.wsTerminalFailures > 0, true);
      assert.notEqual(result.summary.exitCode, EXIT_CODES.hardTimeout);
    });

    await test('real worker profile failure remains workload failure', async () => {
      const servers = await startRealWorkerServers();
      try {
        const credentialsPath = join(root, 'credentials-real-worker.json');
        const directory = join(root, 'out-real-worker');
        await writeFile(credentialsPath, JSON.stringify({ users: [
          { email: 'real-fail@example.test', password: 'fake-password' },
          { email: 'real-1@example.test', password: 'fake-password' },
          { email: 'real-2@example.test', password: 'fake-password' },
          { email: 'real-3@example.test', password: 'fake-password' },
        ] }), 'utf8');
        const observation = { children: [], readyTimes: [], startTimes: [],
          startMessages: [], observedTimestamps: [] };
        const workerPath = new URL('./multi-process-ws-worker.mjs', import.meta.url);
        const controller = new MultiProcessWsController(baseConfig(
          credentialsPath, directory, {
            tables: 1, workerCount: 1, loginSpreadMs: 30, wsStartDelayMs: 80,
            readinessDurationMs: 300, holdDurationMs: 100,
            heartbeatTimeoutMs: 1_000, hardTimeoutMs: 3_000,
            shutdownGraceMs: 300, partialIntervalMs: 50,
            heartbeatIntervalMs: 25, loginTimeoutMs: 500,
            attemptTimeoutMs: 120, maxAttempts: 2, pingIntervalMs: 25,
            cleanupTimeoutMs: 100,
          },
        ), { workerPath, fork: trackedFork(workerPath, observation) });
        const summary = await controller.run();
        assert.equal(servers.observed.loginAttempts, 4);
        assert.equal(summary.metrics.loginAttempts, 4);
        assert.equal(summary.metrics.loginFailures, 1);
        assert.equal(summary.metrics.loginSuccesses, 3);
        assert.equal(summary.metrics.terminalProfileFailures, 1);
        assert.equal(summary.metrics.workerCrashes, 0);
        assert.equal(summary.exitCode, EXIT_CODES.workload);
        assert.notEqual(summary.exitCode, EXIT_CODES.orchestration);
        assert.equal(observation.children.length, 1);
        assert.equal(observation.children[0].exitCode, 0);
        await waitFor(() => servers.observed.activeSockets === 0,
          500, 'real worker left active sockets');
      } finally {
        await servers.close();
      }
    });

    await test('shutdown-complete followed by exit 9 cannot report success', async () => {
      const result = await runScenario(root, fixture, 'postcomplete9');
      assert.equal(result.summary.exitCode, EXIT_CODES.orchestration);
      assert.ok(result.summary.workers.some((worker) => worker.exitCode === 9));
      assert.ok(result.summary.metrics.workerCrashes > 0);
    });

    await test('forced shutdown kills only owned children after grace period', async () => {
      const credentialsPath = join(root, 'credentials-forced.json');
      const directory = join(root, 'out-forced');
      await writeCredentials(credentialsPath, 16, 'hang');
      const observation = { children: [], readyTimes: [], startTimes: [],
        startMessages: [], observedTimestamps: [] };
      const controller = new MultiProcessWsController(
        baseConfig(credentialsPath, directory, { shutdownGraceMs: 40, hardTimeoutMs: 2_000 }),
        { workerPath: fixture, fork: trackedFork(fixture, observation) },
      );
      const runPromise = controller.run();
      await waitFor(() => observation.startMessages.length === 4, 1_000, 'workers did not start');
      controller.requestShutdown('validation shutdown', EXIT_CODES.orchestration);
      const summary = await runPromise;
      assert.equal(summary.exitCode, EXIT_CODES.orchestration);
      assert.equal(summary.cleanup.forcedWorkers, 4);
      assert.ok(observation.children.every((child) => (
        child.exitCode !== null || child.signalCode !== null
      )));
    });

    await test('workload failure returns exit code 1', async () => {
      const result = await runScenario(root, fixture, 'failure');
      assert.equal(result.summary.exitCode, EXIT_CODES.workload);
    });

    await test('final summary write failure returns exit code 3 without retry recursion', async () => {
      const credentialsPath = join(root, 'credentials-final-write.json');
      const directory = join(root, 'out-final-write');
      await writeCredentials(credentialsPath, 16, 'normal');
      const observation = { children: [], readyTimes: [], startTimes: [],
        startMessages: [], observedTimestamps: [] };
      let finalAttempts = 0;
      const errors = [];
      const originalError = console.error;
      console.error = (message) => errors.push(String(message));
      try {
        const controller = new MultiProcessWsController(
          baseConfig(credentialsPath, directory), {
            workerPath: fixture, fork: trackedFork(fixture, observation),
            atomicWriteJson: async (path, value) => {
              if (path.endsWith('multi-process-ws-final.json')) {
                finalAttempts += 1;
                throw new Error('synthetic secret-free write error');
              }
              await atomicWriteJson(path, value);
            },
          },
        );
        const summary = await controller.run();
        assert.equal(summary.exitCode, EXIT_CODES.orchestration);
        assert.equal(summary.exitReason, 'final summary write failed');
        assert.equal(finalAttempts, 1);
        assert.deepEqual(errors, ['Controller final summary write failed']);
      } finally { console.error = originalError; }
    });

    await test('partial summary write failure triggers orchestration shutdown', async () => {
      const credentialsPath = join(root, 'credentials-partial-write.json');
      const directory = join(root, 'out-partial-write');
      await writeCredentials(credentialsPath, 16, 'hang');
      let partialAttempts = 0;
      const originalError = console.error;
      console.error = () => {};
      try {
        const controller = new MultiProcessWsController(
          baseConfig(credentialsPath, directory, { hardTimeoutMs: 2_000, shutdownGraceMs: 40 }), {
            workerPath: fixture,
            atomicWriteJson: async (path, value) => {
              if (path.endsWith('multi-process-ws-partial.json')) {
                partialAttempts += 1;
                throw new Error('synthetic partial write error');
              }
              await atomicWriteJson(path, value);
            },
          },
        );
        const summary = await controller.run();
        assert.equal(summary.exitCode, EXIT_CODES.orchestration);
        assert.equal(summary.exitReason, 'partial summary write failed');
        assert.equal(partialAttempts, 1);
      } finally { console.error = originalError; }
    });

    await test('configuration failure returns exit code 2 without children', async () => {
      const controller = new MultiProcessWsController(baseConfig(
        join(root, 'missing.json'), join(root, 'out-config'),
      ), { workerPath: fixture });
      const summary = await controller.run();
      assert.equal(summary.exitCode, EXIT_CODES.configuration);
      assert.equal(summary.workers.length, 0);
    });

    await test('hard timeout returns exit code 124 and leaves no children', async () => {
      const result = await runScenario(root, fixture, 'hang', {
        hardTimeoutMs: 80, shutdownGraceMs: 40, heartbeatTimeoutMs: 500,
      });
      assert.equal(result.summary.exitCode, EXIT_CODES.hardTimeout);
      assert.ok(result.observation.children.every((child) => (
        child.exitCode !== null || child.signalCode !== null
      )));
    });

    await test('exit-code classifier distinguishes success, workload and orchestration', () => {
      const base = { exitCode: null, expected: { profiles: 4, tables: 1 },
        cleanup: { forcedWorkers: 0, incompleteWorkers: 0 }, metrics: {
          stableProfilesAtRelease: 4, stableTablesAtRelease: 1, loginFailures: 0,
          terminalProfileFailures: 0, wsTerminalFailures: 0, holdFailures: 0,
          workerCrashes: 0, heartbeatTimeouts: 0,
        } };
      assert.equal(determineExitCode(base), 0);
      assert.equal(determineExitCode({ ...base, metrics: { ...base.metrics,
        stableProfilesAtRelease: 3 } }), 1);
      assert.equal(determineExitCode({ ...base, metrics: { ...base.metrics,
        workerCrashes: 1 } }), 3);
    });

    console.log(`\nPassed: ${passed}; Failed: 0`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Controller validation failed:', error.message);
  process.exitCode = 1;
});
