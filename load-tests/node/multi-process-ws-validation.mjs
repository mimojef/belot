import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  createMetrics, extractSessionCookie, incrementMetric, readyTableIndexes,
  safeMetrics, setMetric, sliceCredentials, validateTargetPair,
} from './multi-process-ws-common.mjs';
import { WsWorker } from './multi-process-ws-worker.mjs';

let passed = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), message);
}
const test = async (name, operation) => {
  await operation();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};
const fake = (id, password = 'fake-password') => ({
  email: `fake-${id}@example.test`, password,
});

function config(overrides = {}) {
  const now = Date.now();
  return {
    baseUrl: 'http://127.0.0.1:3101', wsUrl: 'ws://127.0.0.1:3101/ws',
    loginStartAtMs: now + 10, wsStartAtMs: now + 80,
    readinessDeadlineAtMs: now + 240, releaseAtMs: now + 340,
    loginSpreadMs: 40, attemptTimeoutMs: 55, maxAttempts: 2,
    loginTimeoutMs: 150,
    retryBaseMs: 8, retryMaxMs: 16, jitter: 0,
    pingIntervalMs: 25, heartbeatIntervalMs: 20, cleanupTimeoutMs: 80,
    ...overrides,
  };
}

async function startFakeServers() {
  const attempts = new Map();
  const observed = {
    loginTimes: new Map(), loginCounts: new Map(), wsTimes: [], cookies: [], origins: [],
    pings: 0, activeSockets: 0,
  };
  const http = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/auth/login') {
      response.writeHead(404).end(); return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const id = body.email.match(/^fake-(.+)@example\.test$/)?.[1] ?? 'unknown';
    observed.loginTimes.set(id, Date.now());
    observed.loginCounts.set(id, (observed.loginCounts.get(id) ?? 0) + 1);
    const missing = body.password === 'missing-cookie';
    if (id.includes('late-login')) await sleep(90);
    response.writeHead(200, {
      'content-type': 'application/json',
      ...(missing ? {} : { 'set-cookie': `belot_session=${id}; HttpOnly; Path=/` }),
    });
    response.end(JSON.stringify({ ok: true, session: { profile: true } }));
  });
  const ws = new WebSocketServer({ server: http, path: '/ws' });
  ws.on('connection', (socket, request) => {
    observed.activeSockets += 1;
    socket.once('close', () => { observed.activeSockets -= 1; });
    observed.wsTimes.push(Date.now());
    observed.cookies.push(request.headers.cookie ?? '');
    observed.origins.push(request.headers.origin ?? '');
    const id = request.headers.cookie?.match(/belot_session=([^;]+)/)?.[1] ?? 'none';
    const count = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, count);
    if (id.includes('retry') && count === 1) {
      socket.close(1011, 'synthetic retry');
    } else if (id.includes('silent')) {
      // Open without the application connected event.
    } else {
      socket.send(JSON.stringify({ type: 'connected' }));
      if (id.includes('hold-close')) setTimeout(() => socket.close(1011, 'hold failure'), 25);
    }
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'ping') {
        observed.pings += 1;
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });
  });
  http.listen(3101, '127.0.0.1');
  await once(http, 'listening');
  return {
    observed,
    async close() {
      for (const client of ws.clients) client.terminate();
      await new Promise((resolve) => ws.close(resolve));
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

async function runWorker(credentials, overrides = {}, inspect = () => {}) {
  const messages = [];
  const worker = new WsWorker(config(overrides), credentials, (message) => messages.push(message));
  const results = await worker.start();
  await inspect(worker, messages, results);
  return { worker, messages, results };
}

async function main() {
  await test('target validation is allowlisted and fail-closed', () => {
    validateTargetPair('http://185.203.117.14:3101', 'ws://185.203.117.14:3101/ws');
    validateTargetPair('http://localhost:3101', 'ws://localhost:3101/ws');
    for (const pair of [
      ['https://pika.bg', 'wss://pika.bg/ws'],
      ['http://127.0.0.1:3001', 'ws://127.0.0.1:3001/ws'],
      ['http://127.0.0.1:3101/x', 'ws://127.0.0.1:3101/ws'],
      ['http://user@127.0.0.1:3101', 'ws://127.0.0.1:3101/ws'],
      ['http://localhost:3101', 'ws://127.0.0.1:3101/ws'],
    ]) assert.throws(() => validateTargetPair(...pair));
  });

  await test('credentials slices are exact and non-overlapping', () => {
    const all = Array.from({ length: 12 }, (_, index) => fake(index));
    const left = sliceCredentials(all, 0, 4);
    const right = sliceCredentials(all, 4, 4);
    assert.equal(new Set([...left, ...right].map((item) => item.email)).size, 8);
    assert.throws(() => sliceCredentials(all, 10, 4));
  });

  await test('cookie and metrics helpers expose only safe values', () => {
    assert.equal(extractSessionCookie(new Headers({
      'set-cookie': 'belot_session=fake-session; HttpOnly',
    })), 'fake-session');
    assert.throws(() => extractSessionCookie(new Headers()));
    const metrics = createMetrics();
    incrementMetric(metrics, 'loginSuccesses');
    setMetric(metrics, 'currentActiveSockets', 2);
    assert.equal(safeMetrics({ ...metrics, injected: 'secret', wsPongs: NaN }).wsPongs, 0);
    assert.equal('injected' in safeMetrics(metrics), false);
  });

  await test('ready tables require groups of four consecutive profiles', () => {
    assert.deepEqual(readyTableIndexes([0, 1, 2], 8), []);
    assert.deepEqual(readyTableIndexes([0, 1, 2, 3, 5, 6, 7], 8), [0]);
    assert.deepEqual(readyTableIndexes([0, 1, 2, 3, 4, 5, 6, 7], 8), [0, 1]);
  });

  const servers = await startFakeServers();
  try {
    await test('login succeeds once and WebSocket receives Cookie and Origin', async () => {
      await runWorker([fake('basic')], {}, (worker) => {
        assert.equal(worker.metrics.loginAttempts, 1);
        assert.equal(worker.metrics.loginSuccesses, 1);
      });
      assert.match(servers.observed.cookies.at(-1), /^belot_session=basic/);
      assert.equal(servers.observed.origins.at(-1), 'http://127.0.0.1:3101');
    });

    await test('missing cookie is a terminal login failure', async () => {
      const { worker, results } = await runWorker([fake('missing', 'missing-cookie')]);
      assert.equal(results[0].status, 'rejected');
      assert.equal(worker.metrics.loginFailures, 1);
      assert.equal(worker.metrics.wsAttempts, 0);
      assert.equal(worker.metrics.wsTerminalFailures, 0);
      assert.equal(worker.metrics.terminalProfileFailures, 1);
    });

    await test('one terminal profile failure does not stop successful profiles', async () => {
      const phases = config();
      const worker = new WsWorker(phases, [
        fake('isolated-failure', 'missing-cookie'), fake('isolated-success'),
      ]);
      const results = await worker.start();
      assert.equal(results[0].status, 'rejected');
      assert.equal(results[1].status, 'fulfilled');
      assert.equal(worker.metrics.terminalProfileFailures, 1);
      assert.equal(worker.metrics.peakReadyProfiles, 1);
      assert.equal(worker.metrics.stableProfilesAtRelease, 1);
      assert.ok(Date.now() >= phases.releaseAtMs - 5);
    });

    await test('four successful profiles preserve peak and stable ready table results', async () => {
      const { worker, messages } = await runWorker([
        fake('table-a'), fake('table-b'), fake('table-c'), fake('table-d'),
      ]);
      assert.equal(worker.metrics.peakReadyProfiles, 4);
      assert.equal(worker.metrics.peakReadyTables, 1);
      assert.equal(worker.metrics.stableProfilesAtRelease, 4);
      assert.equal(worker.metrics.stableTablesAtRelease, 1);
      const final = messages.find((message) => message.type === 'shutdown-complete');
      assert.deepEqual(final.readiness, {
        peakProfiles: 4, peakTables: 1, stableProfilesAtRelease: 4, stableTablesAtRelease: 1,
      });
    });

    await test('WebSocket retry reuses one login session', async () => {
      const { worker } = await runWorker([fake('retry-once')]);
      assert.equal(worker.metrics.loginAttempts, 1);
      assert.equal(worker.metrics.loginSuccesses, 1);
      assert.equal(worker.metrics.wsAttempts, 2);
      assert.equal(worker.metrics.wsRetries, 1);
      assert.equal(servers.observed.loginCounts.get('retry-once'), 1);
    });

    await test('WebSocket attempts do not start before common wsStartAtMs', async () => {
      const phases = config({ loginSpreadMs: 0 });
      const before = servers.observed.wsTimes.length;
      const worker = new WsWorker(phases, [fake('ws-pacing')]);
      await worker.start();
      assert.ok(servers.observed.wsTimes[before] >= phases.wsStartAtMs - 3);
    });

    await test('late login receives full loginTimeoutMs and joins after wsStartAtMs', async () => {
      const now = Date.now();
      const phases = config({
        loginStartAtMs: now, wsStartAtMs: now + 25, readinessDeadlineAtMs: now + 210,
        releaseAtMs: now + 270, loginSpreadMs: 0, loginTimeoutMs: 140,
      });
      const wsCountBefore = servers.observed.wsTimes.length;
      const worker = new WsWorker(phases, [fake('late-login')]);
      const results = await worker.start();
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(worker.metrics.loginSuccesses, 1);
      assert.equal(worker.metrics.peakReadyProfiles, 1);
      assert.ok(servers.observed.loginTimes.get('late-login') < phases.wsStartAtMs);
      assert.ok(servers.observed.wsTimes[wsCountBefore] > phases.wsStartAtMs + 40);
    });

    await test('login spread paces profiles across the configured window', async () => {
      const phases = config({ loginSpreadMs: 75, wsStartAtMs: Date.now() + 120,
        readinessDeadlineAtMs: Date.now() + 270, releaseAtMs: Date.now() + 340 });
      const worker = new WsWorker(phases, [fake('spread-a'), fake('spread-b'), fake('spread-c')]);
      await worker.start();
      const times = ['spread-a', 'spread-b', 'spread-c'].map((id) => servers.observed.loginTimes.get(id));
      assert.ok(times[1] - times[0] >= 25, `${times}`);
      assert.ok(times[2] - times[0] >= 60, `${times}`);
    });

    await test('open without connected fails at bounded readiness deadline', async () => {
      const now = Date.now();
      const { worker, results } = await runWorker([fake('silent')], {
        loginStartAtMs: now, wsStartAtMs: now + 10, readinessDeadlineAtMs: now + 105,
        releaseAtMs: now + 180, loginSpreadMs: 0, attemptTimeoutMs: 45, maxAttempts: 5,
      });
      assert.equal(results[0].status, 'rejected');
      assert.equal(worker.metrics.wsReadyProfiles, 0);
    });

    await test('close after connected during hold is terminal and removes readiness', async () => {
      const { worker, results } = await runWorker([fake('hold-close')]);
      assert.equal(results[0].status, 'rejected');
      assert.equal(worker.metrics.holdFailures, 1);
      assert.equal(worker.metrics.terminalProfileFailures, 1);
      assert.equal(worker.ready.size, 0);
    });

    await test('successful connected socket remains through hold until release', async () => {
      const phases = config();
      const worker = new WsWorker(phases, [fake('full-hold')]);
      const started = Date.now();
      const results = await worker.start();
      assert.equal(results[0].status, 'fulfilled');
      assert.ok(Date.now() >= phases.releaseAtMs - 5);
      assert.ok(Date.now() - started >= 250);
      assert.equal(worker.metrics.holdFailures, 0);
      assert.ok(worker.metrics.wsPings > 0 && worker.metrics.wsPongs > 0);
    });

    await test('heartbeat reports phase, progress time, RSS and heap without secrets', async () => {
      const { messages } = await runWorker([fake('heartbeat-secret', 'never-output-this')]);
      const heartbeat = messages.find((message) => message.type === 'heartbeat');
      assert.ok(heartbeat && typeof heartbeat.phase === 'string');
      assert.ok(heartbeat.lastProgressAtMs > 0 && heartbeat.rssBytes > 0 && heartbeat.heapUsedBytes > 0);
      assert.ok(Number.isFinite(heartbeat.eventLoopDelayMeanMs)
        && heartbeat.eventLoopDelayMeanMs >= 0);
      assert.ok(Number.isFinite(heartbeat.eventLoopDelayMaxMs)
        && heartbeat.eventLoopDelayMaxMs >= 0);
      assert.doesNotMatch(JSON.stringify(messages), /heartbeat-secret|never-output-this|belot_session/i);
    });

    await test('forked worker announces ready and exits cleanly after shutdown', async () => {
      const child = fork(new URL('./multi-process-ws-worker.mjs', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const messages = [];
      child.on('message', (message) => messages.push(message));
      try {
        await waitFor(() => messages.some((message) => message.type === 'worker-ready'),
          1_000, 'forked worker did not announce readiness');
        const now = Date.now();
        child.send({ type: 'start', config: config({
          loginStartAtMs: now, wsStartAtMs: now + 40,
          readinessDeadlineAtMs: now + 2_000, releaseAtMs: now + 3_000,
          loginSpreadMs: 0,
        }), credentials: [fake('fork-child')] });
        await waitFor(() => messages.some((message) => message.type === 'progress'),
          1_000, 'forked worker did not start');
        child.send({ type: 'shutdown' });
        const [exitCode] = await Promise.race([
          once(child, 'exit'),
          sleep(1_000).then(() => { throw new Error('forked worker did not exit'); }),
        ]);
        assert.equal(exitCode, 0);
        assert.notEqual(child.exitCode, null);
        assert.ok(messages.some((message) => message.type === 'shutdown-complete'));
        assert.doesNotMatch(JSON.stringify(messages), /fork-child|belot_session/i);
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });

    await test('forked active worker cleans up after parent IPC disconnect', async () => {
      const child = fork(new URL('./multi-process-ws-worker.mjs', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const messages = [];
      let stderr = '';
      child.on('message', (message) => messages.push(message));
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      try {
        await waitFor(() => messages.some((message) => message.type === 'worker-ready'),
          1_000, 'forked worker did not announce readiness');
        const now = Date.now();
        child.send({ type: 'start', config: config({
          loginStartAtMs: now, wsStartAtMs: now + 40,
          readinessDeadlineAtMs: now + 2_000, releaseAtMs: now + 5_000,
          loginSpreadMs: 0, heartbeatIntervalMs: 10,
        }), credentials: [fake('fork-disconnect')] });
        await waitFor(() => messages.some((message) => message.type === 'progress'),
          1_000, 'forked worker did not open an active socket');
        assert.ok(servers.observed.activeSockets > 0);
        const exitPromise = once(child, 'exit');
        child.disconnect();
        const [exitCode] = await Promise.race([
          exitPromise,
          sleep(1_000).then(() => { throw new Error('disconnected worker did not exit'); }),
        ]);
        assert.equal(exitCode, 0);
        assert.notEqual(child.exitCode, null);
        await waitFor(() => servers.observed.activeSockets === 0,
          500, 'disconnected worker left an active socket');
        assert.doesNotMatch(stderr, /ERR_IPC_CHANNEL_CLOSED|uncaught/i);
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });

    await test('shutdown settles a pending attempt and then settles start', async () => {
      const now = Date.now();
      const worker = new WsWorker(config({
        loginStartAtMs: now, wsStartAtMs: now + 60, readinessDeadlineAtMs: now + 5_000,
        releaseAtMs: now + 6_000, loginSpreadMs: 0, attemptTimeoutMs: 4_000,
      }), [fake('silent-pending')]);
      const startPromise = worker.start();
      const openDeadline = Date.now() + 500;
      while (worker.metrics.wsOpens === 0 && Date.now() < openDeadline) await sleep(5);
      assert.equal(worker.metrics.wsOpens, 1, JSON.stringify(safeMetrics(worker.metrics)));
      await worker.shutdown();
      const results = await Promise.race([
        startPromise, sleep(250).then(() => { throw new Error('start did not settle'); }),
      ]);
      assert.equal(results[0].status, 'rejected');
      assert.equal(worker.metrics.cleanupCompleted, 1);
    });

    await test('active socket gauges return to zero after cleanup', async () => {
      const { worker } = await runWorker([fake('gauge-a'), fake('gauge-b')]);
      assert.ok(worker.metrics.wsOpens >= 2);
      assert.ok(worker.metrics.peakActiveSockets >= 2);
      assert.equal(worker.metrics.currentActiveSockets, 0);
      assert.equal(worker.metrics.cleanupCompleted, 1);
    });
  } finally {
    await servers.close();
  }

  await test('callback from old generation cannot mark readiness after retry starts', async () => {
    const sockets = [];
    class FakeSocket extends EventEmitter {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor() {
        super(); this.readyState = FakeSocket.CONNECTING; sockets.push(this);
        setTimeout(() => { this.readyState = FakeSocket.OPEN; this.emit('open'); }, 0);
      }
      send() {}
      close() { this.terminate(); }
      terminate() {
        if (this.readyState === FakeSocket.CLOSED) return;
        this.readyState = FakeSocket.CLOSED; this.emit('close');
      }
    }
    const now = Date.now();
    const worker = new WsWorker(config({
      loginStartAtMs: now, wsStartAtMs: now, readinessDeadlineAtMs: now + 180,
      releaseAtMs: now + 230, loginSpreadMs: 0, attemptTimeoutMs: 25,
      retryBaseMs: 5, retryMaxMs: 5,
    }), [fake('stale')], () => {}, {
      WebSocket: FakeSocket,
      fetch: async () => ({ status: 200, headers: new Headers({
        'set-cookie': 'belot_session=stale-session; HttpOnly',
      }), json: async () => ({ ok: true, session: {} }) }),
    });
    const startPromise = worker.start();
    while (sockets.length < 2) await sleep(2);
    sockets[0].emit('message', Buffer.from('{"type":"connected"}'));
    assert.equal(worker.ready.size, 0);
    assert.equal(worker.metrics.wsReadyProfiles, 0);
    sockets[1].emit('message', Buffer.from('{"type":"connected"}'));
    await startPromise;
    assert.equal(worker.metrics.wsReadyProfiles, 0);
    assert.equal(worker.metrics.peakReadyProfiles, 1);
    assert.equal(worker.players[0].generation > 2, true);
  });

  console.log(`\nPassed: ${passed}; Failed: 0`);
}

main().catch((error) => {
  console.error('Validation failed:', error.message);
  process.exitCode = 1;
});
