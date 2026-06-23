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

const SERVER_SEATS = ['bottom', 'right', 'top', 'left'];

function fullHumanSnapshot(roomId, yourSeat, overrides = {}) {
  return {
    type: 'room_snapshot',
    roomId,
    yourSeat,
    seats: SERVER_SEATS.map((seat) => ({
      seat, isOccupied: true, isBot: false, isControlledByBot: false, isConnected: true,
    })),
    game: { authoritativePhase: 'cutting' },
    stakeAmount: 5000,
    ...overrides,
  };
}

async function startLocalFakeWorker(credentials, overrides = {}) {
  const sockets = [];
  const messages = [];
  class FakeSocket extends EventEmitter {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(_url, options) {
      super();
      this.options = options;
      this.readyState = FakeSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
      setTimeout(() => {
        if (this.readyState === FakeSocket.CLOSED) return;
        this.readyState = FakeSocket.OPEN;
        this.emit('open');
      }, 0);
    }
    send(data) {
      if (this.readyState !== FakeSocket.OPEN) throw new Error('fake socket not open');
      this.sent.push(JSON.parse(data.toString()));
    }
    serverSend(message) {
      this.emit('message', Buffer.from(JSON.stringify(message)));
    }
    close() { this.terminate(); }
    terminate() {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      this.emit('close');
    }
  }
  const now = Date.now();
  const worker = new WsWorker(config({
    loginStartAtMs: now, wsStartAtMs: now, readinessDeadlineAtMs: now + 1_000,
    releaseAtMs: now + 2_000, loginSpreadMs: 0, attemptTimeoutMs: 700,
    pingIntervalMs: 10_000, heartbeatIntervalMs: 20, ...overrides,
  }), credentials, (message) => messages.push(message), {
    WebSocket: FakeSocket,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const id = body.email.match(/^fake-(.+)@example\.test$/)?.[1] ?? 'local';
      return { status: 200, headers: new Headers({
        'set-cookie': `belot_session=${id}; HttpOnly`,
      }), json: async () => ({ ok: true, session: {} }) };
    },
  });
  const startPromise = worker.start();
  await waitFor(() => sockets.length === credentials.length, 500, 'fake sockets were not created');
  await waitFor(() => worker.metrics.wsOpens === credentials.length, 500, 'fake sockets did not open');
  return {
    worker,
    sockets,
    messages,
    startPromise,
    connect(count = sockets.length) {
      for (let index = 0; index < count; index += 1) {
        sockets[index].serverSend({ type: 'connected' });
      }
    },
    async stop() {
      await worker.shutdown();
      await startPromise;
    },
  };
}

async function startJoinedLocalTable(overrides = {}) {
  const harness = await startLocalFakeWorker([
    fake('local-a', 'secret-a'), fake('local-b', 'secret-b'),
    fake('local-c', 'secret-c'), fake('local-d', 'secret-d'),
  ], overrides);
  harness.worker.allowMatchmakingTable(0);
  harness.connect();
  await waitFor(() => harness.sockets.every((socket) => socket.sent.length === 1),
    500, 'join_matchmaking was not sent for all local sockets');
  return harness;
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
      const messages = [];
      const worker = new WsWorker(phases, [
        fake('isolated-failure', 'missing-cookie'), fake('isolated-success'),
      ], (message) => messages.push(message));
      const results = await worker.start();
      assert.equal(results[0].status, 'rejected');
      assert.equal(results[1].status, 'fulfilled');
      assert.ok(messages.some((message) => message.type === 'progress'
        && message.failedProfileIndexes.includes(0)));
      assert.equal(messages.some((message) => message.type === 'failed'), false);
      assert.equal(worker.metrics.loginAttempts, 2);
      assert.equal(worker.metrics.loginFailures, 1);
      assert.equal(worker.metrics.loginSuccesses, 1);
      assert.equal(worker.metrics.terminalProfileFailures, 1);
      assert.equal(worker.metrics.wsTerminalFailures, 0);
      assert.equal(worker.metrics.holdFailures, 0);
      assert.equal(worker.metrics.peakReadyProfiles, 1);
      assert.equal(worker.metrics.stableProfilesAtRelease, 1);
      const final = messages.find((message) => message.type === 'shutdown-complete');
      assert.deepEqual(final.failedProfileIndexes, [0]);
      assert.equal(final.metrics.loginFailures, 1);
      assert.equal(final.metrics.terminalProfileFailures, 1);
      assert.equal(final.metrics.wsTerminalFailures, 0);
      assert.equal(final.metrics.holdFailures, 0);
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

  await test('matchmaking sends exact join payload with numeric stake', async () => {
    const harness = await startJoinedLocalTable();
    try {
      for (const socket of harness.sockets) {
        assert.deepEqual(socket.sent, [{ type: 'join_matchmaking', stake: 5000 }]);
        assert.equal(typeof socket.sent[0].stake, 'number');
      }
      assert.equal(harness.worker.metrics.matchmakingJoinAttempts, 4);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking join waits for all four connected sockets', async () => {
    const harness = await startLocalFakeWorker([
      fake('wait-a'), fake('wait-b'), fake('wait-c'), fake('wait-d'),
    ]);
    try {
      harness.worker.allowMatchmakingTable(0);
      harness.connect(3);
      await sleep(40);
      assert.equal(harness.sockets.some((socket) => socket.sent.length > 0), false);
      harness.sockets[3].serverSend({ type: 'connected' });
      await waitFor(() => harness.sockets.every((socket) => socket.sent.length === 1),
        500, 'join was not sent after the fourth socket connected');
    } finally {
      await harness.stop();
    }
  });

  await test('safe matchmaking state reports worker-local table indexes for two local tables', async () => {
    const harness = await startLocalFakeWorker([
      fake('two-table-0a'), fake('two-table-0b'), fake('two-table-0c'), fake('two-table-0d'),
      fake('two-table-1a'), fake('two-table-1b'), fake('two-table-1c'), fake('two-table-1d'),
    ]);
    try {
      harness.connect();
      await waitFor(() => harness.worker.ready.size === 8, 500, 'fake sockets did not connect');
      const accepted = harness.worker.allowMatchmakingTable(1);
      assert.equal(accepted, true);
      await waitFor(() => harness.sockets.slice(4, 8).every((socket) => socket.sent.length === 1),
        500, 'table 1 did not send joins');
      assert.deepEqual(harness.sockets.slice(0, 4).map((socket) => socket.sent.length), [0, 0, 0, 0]);

      SERVER_SEATS.forEach((seat, offset) => {
        const socket = harness.sockets[4 + offset];
        socket.serverSend({
          type: 'match_found', roomId: 'room-local-table-1', seat, stake: 5000,
          humanPlayers: 4, botPlayers: 0,
        });
        socket.serverSend(fullHumanSnapshot('room-local-table-1', seat));
      });
      let state = harness.worker.safeMatchmakingState();
      assert.deepEqual(state.admittedTableIndexes, [1]);
      assert.deepEqual(state.joinStartedTableIndexes, [1]);
      assert.deepEqual(state.confirmedTableIndexes, [1]);
      assert.deepEqual(state.startedTableIndexes, [1]);
      assert.deepEqual(state.readyTableIndexes, [1]);
      assert.equal(state.admittedTables, 1);
      assert.equal(state.joinStartedTables, 1);
      assert.equal(state.confirmedTables, 1);
      assert.equal(state.startedTables, 1);
      assert.equal(state.readyTables, 1);

      harness.worker.allowMatchmakingTable(1);
      await sleep(30);
      assert.deepEqual(harness.sockets.slice(4, 8).map((socket) => socket.sent.length), [1, 1, 1, 1]);

      harness.worker.allowMatchmakingTable(0);
      harness.sockets[0].serverSend({ type: 'matchmaking_left' });
      await waitFor(() => harness.worker.tables[0].failureCode === 'matchmaking_left',
        500, 'table 0 did not fail');
      state = harness.worker.safeMatchmakingState();
      assert.deepEqual(state.failures, [
        { tableIndex: 0, failureCode: 'matchmaking_left' },
      ]);
      assert.deepEqual(state.readyTableIndexes, [1]);
      assert.deepEqual(state.startedTableIndexes, [1]);
      assert.equal(state.failedTables, 1);
      assert.equal(state.readyTables, 1);
      assert.equal(state.startedTables, 1);
    } finally {
      await harness.stop();
    }
  });

  await test('profile failure before admission rejects admission and sends no joins', async () => {
    const harness = await startLocalFakeWorker([
      fake('pre-admit-a'), fake('pre-admit-b'), fake('pre-admit-c'), fake('pre-admit-d'),
    ]);
    try {
      harness.worker.failProfile(harness.worker.players[0], new Error('synthetic pre-admission'), false);
      const accepted = harness.worker.allowMatchmakingTable(0);
      assert.equal(accepted, false);
      assert.equal(harness.worker.tables[0].failureCode, 'profile_failed_before_join');
      assert.equal(harness.worker.metrics.matchmakingAdmittedTables, 0);
      assert.equal(harness.worker.metrics.matchmakingJoinAttempts, 0);
      assert.deepEqual(harness.sockets.map((socket) => socket.sent.length), [0, 0, 0, 0]);
    } finally {
      await harness.stop();
    }
  });

  await test('admitted table fails immediately on profile failure before join', async () => {
    const harness = await startLocalFakeWorker([
      fake('admitted-fail-a'), fake('admitted-fail-b'),
      fake('admitted-fail-c'), fake('admitted-fail-d'),
    ]);
    try {
      const accepted = harness.worker.allowMatchmakingTable(0);
      assert.equal(accepted, true);
      harness.worker.failProfile(harness.worker.players[1], new Error('synthetic admitted failure'), false);
      assert.equal(harness.worker.tables[0].failureCode, 'profile_failed_before_join');
      assert.equal(harness.worker.metrics.matchmakingJoinAttempts, 0);
      assert.deepEqual(harness.sockets.map((socket) => socket.sent.length), [0, 0, 0, 0]);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking sends at most one join per profile', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.worker.allowMatchmakingTable(0);
      harness.connect();
      await sleep(30);
      assert.deepEqual(harness.sockets.map((socket) => socket.sent.length), [1, 1, 1, 1]);
      assert.equal(harness.worker.metrics.matchmakingJoinAttempts, 4);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking records joined and status acknowledgements', async () => {
    const harness = await startJoinedLocalTable();
    try {
      for (const socket of harness.sockets) {
        socket.serverSend({ type: 'matchmaking_joined', stake: 5000, requiredPlayers: 4 });
        socket.serverSend({ type: 'matchmaking_status', stake: 5000, requiredPlayers: 4 });
      }
      assert.equal(harness.worker.metrics.matchmakingJoinAcks, 4);
      assert.equal(harness.worker.metrics.matchmakingStatusAcks, 4);
    } finally {
      await harness.stop();
    }
  });

  await test('wrong-stake matchmaking_joined fails without ack counter', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({ type: 'matchmaking_joined', stake: 4999, requiredPlayers: 4 });
      assert.equal(harness.worker.tables[0].failureCode, 'stake_mismatch');
      assert.equal(harness.worker.metrics.matchmakingJoinAcks, 0);
    } finally {
      await harness.stop();
    }
  });

  await test('wrong-stake matchmaking_status fails without status counter', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({ type: 'matchmaking_status', stake: '5000', requiredPlayers: 4 });
      assert.equal(harness.worker.tables[0].failureCode, 'stake_mismatch');
      assert.equal(harness.worker.metrics.matchmakingStatusAcks, 0);
    } finally {
      await harness.stop();
    }
  });

  await test('wrong requiredPlayers matchmaking_joined fails without ack counter', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({ type: 'matchmaking_joined', stake: 5000, requiredPlayers: 3 });
      assert.equal(harness.worker.tables[0].failureCode, 'required_players_mismatch');
      assert.equal(harness.worker.metrics.matchmakingJoinAcks, 0);
    } finally {
      await harness.stop();
    }
  });

  await test('missing or wrong requiredPlayers matchmaking_status fails without status counter', async () => {
    const missing = await startJoinedLocalTable();
    try {
      missing.sockets[0].serverSend({ type: 'matchmaking_status', stake: 5000 });
      assert.equal(missing.worker.tables[0].failureCode, 'required_players_mismatch');
      assert.equal(missing.worker.metrics.matchmakingStatusAcks, 0);
    } finally {
      await missing.stop();
    }

    const wrong = await startJoinedLocalTable();
    try {
      wrong.sockets[0].serverSend({ type: 'matchmaking_status', stake: 5000, requiredPlayers: '4' });
      assert.equal(wrong.worker.tables[0].failureCode, 'required_players_mismatch');
      assert.equal(wrong.worker.metrics.matchmakingStatusAcks, 0);
    } finally {
      await wrong.stop();
    }
  });

  await test('wrong-stake match_found fails without match-found counter', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-wrong-stake', seat: 'bottom', stake: 10,
        humanPlayers: 4, botPlayers: 0,
      });
      assert.equal(harness.worker.tables[0].failureCode, 'stake_mismatch');
      assert.equal(harness.worker.metrics.matchmakingMatchFounds, 0);
    } finally {
      await harness.stop();
    }
  });

  await test('unknown match_found seat fails without match-found counter', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-unknown-match-seat', seat: 'north', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      assert.equal(harness.worker.tables[0].failureCode, 'unknown_seat');
      assert.equal(harness.worker.metrics.matchmakingMatchFounds, 0);
    } finally {
      await harness.stop();
    }
  });

  await test('server error after join fails the table without leaking details', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({
        type: 'error', message: 'secret room room-123 belot_session=leak',
      });
      assert.equal(harness.worker.tables[0].failureCode, 'server_error');
      await harness.stop();
      const final = harness.messages.find((message) => message.type === 'shutdown-complete');
      assert.deepEqual(final.matchmaking.failures, [
        { tableIndex: 0, failureCode: 'server_error' },
      ]);
      assert.doesNotMatch(JSON.stringify(harness.messages), /room-123|belot_session|leak/i);
    } finally {
      if (harness.worker.metrics.cleanupCompleted === 0) await harness.stop();
    }
  });

  await test('matchmaking_expired after join fails immediately', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({ type: 'matchmaking_expired', stake: 5000 });
      assert.equal(harness.worker.tables[0].failureCode, 'matchmaking_expired');
    } finally {
      await harness.stop();
    }
  });

  await test('wrong-stake matchmaking_expired fails with stake_mismatch', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({ type: 'matchmaking_expired', stake: null });
      assert.equal(harness.worker.tables[0].failureCode, 'stake_mismatch');
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking_left after join fails immediately', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({ type: 'matchmaking_left' });
      assert.equal(harness.worker.tables[0].failureCode, 'matchmaking_left');
    } finally {
      await harness.stop();
    }
  });

  await test('session_displaced before admission rejects future admission', async () => {
    const harness = await startLocalFakeWorker([
      fake('displaced-a'), fake('displaced-b'), fake('displaced-c'), fake('displaced-d'),
    ]);
    try {
      harness.connect();
      await waitFor(() => harness.worker.ready.size === 4, 500, 'fake sockets did not connect');
      harness.sockets[0].serverSend({ type: 'session_displaced' });
      const accepted = harness.worker.allowMatchmakingTable(0);
      assert.equal(accepted, false);
      assert.equal(harness.worker.tables[0].failureCode, 'profile_failed_before_join');
      assert.equal(harness.worker.metrics.matchmakingJoinAttempts, 0);
    } finally {
      await harness.stop();
    }
  });

  await test('session_in_game before admission rejects future admission', async () => {
    const harness = await startLocalFakeWorker([
      fake('in-game-a'), fake('in-game-b'), fake('in-game-c'), fake('in-game-d'),
    ]);
    try {
      harness.connect();
      await waitFor(() => harness.worker.ready.size === 4, 500, 'fake sockets did not connect');
      harness.sockets[0].serverSend({ type: 'session_in_game', roomId: 'secret-room' });
      const accepted = harness.worker.allowMatchmakingTable(0);
      assert.equal(accepted, false);
      assert.equal(harness.worker.tables[0].failureCode, 'profile_failed_before_join');
      assert.equal(harness.worker.metrics.matchmakingJoinAttempts, 0);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking accepts one room id with four distinct seats and snapshots', async () => {
    const harness = await startJoinedLocalTable();
    try {
      SERVER_SEATS.forEach((seat, index) => {
        harness.sockets[index].serverSend({
          type: 'match_found', roomId: 'room-ok', seat, stake: 5000,
          humanPlayers: 4, botPlayers: 0,
        });
        harness.sockets[index].serverSend(fullHumanSnapshot('room-ok', seat));
      });
      assert.equal(harness.worker.metrics.matchmakingMatchFounds, 4);
      assert.equal(harness.worker.metrics.matchmakingSnapshots, 4);
      assert.equal(harness.worker.metrics.matchmakingConfirmedTables, 1);
      assert.equal(harness.worker.metrics.matchmakingStartedTables, 1);
      assert.equal(harness.worker.metrics.matchmakingReadyTables, 1);
      assert.equal(harness.worker.tables[0].ready, true);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects snapshot before match_found with different seat', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend(fullHumanSnapshot('room-order', 'right'));
      harness.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-order', seat: 'bottom', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      assert.equal(harness.worker.tables[0].failureCode, 'snapshot_seat_mismatch');
    } finally {
      await harness.stop();
    }
  });

  await test('duplicate match_found for the same profile is idempotent', async () => {
    const harness = await startJoinedLocalTable();
    try {
      const message = {
        type: 'match_found', roomId: 'room-dupe-ok', seat: 'bottom', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      };
      harness.sockets[0].serverSend(message);
      harness.sockets[0].serverSend(message);
      assert.equal(harness.worker.metrics.matchmakingMatchFounds, 1);
      assert.equal(harness.worker.tables[0].failureCode, null);
    } finally {
      await harness.stop();
    }
  });

  await test('duplicate snapshot for the same profile is idempotent', async () => {
    const harness = await startJoinedLocalTable();
    try {
      const snapshot = fullHumanSnapshot('room-snap-dupe-ok', 'bottom');
      harness.sockets[0].serverSend(snapshot);
      harness.sockets[0].serverSend(snapshot);
      assert.equal(harness.worker.metrics.matchmakingSnapshots, 1);
      assert.equal(harness.worker.tables[0].failureCode, null);
    } finally {
      await harness.stop();
    }
  });

  await test('conflicting duplicate match_found fails the table', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-conflict', seat: 'bottom', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      harness.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-conflict', seat: 'right', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      assert.equal(harness.worker.tables[0].failureCode, 'conflicting_match_found');
      assert.equal(harness.worker.metrics.matchmakingTableFailures, 1);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects mixed room ids', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-a', seat: 'bottom', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      harness.sockets[1].serverSend({
        type: 'match_found', roomId: 'room-b', seat: 'right', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      assert.equal(harness.worker.tables[0].failureCode, 'mixed_room_id');
      assert.equal(harness.worker.metrics.matchmakingTableFailures, 1);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects duplicate seats', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-dupe', seat: 'bottom', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      harness.sockets[1].serverSend({
        type: 'match_found', roomId: 'room-dupe', seat: 'bottom', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      assert.equal(harness.worker.tables[0].failureCode, 'duplicate_seat');
      assert.equal(harness.worker.metrics.matchmakingTableFailures, 1);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects bot-occupied snapshots', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-bot', seat: 'bottom', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      harness.sockets[0].serverSend(fullHumanSnapshot('room-bot', 'bottom', {
        seats: SERVER_SEATS.map((seat, index) => ({
          seat, isOccupied: true, isBot: index === 3, isControlledByBot: false, isConnected: true,
        })),
      }));
      assert.equal(harness.worker.tables[0].failureCode, 'bot_detected');
      assert.equal(harness.worker.metrics.matchmakingTableFailures, 1);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects duplicate seat in snapshot roster', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend(fullHumanSnapshot('room-roster-dupe', 'bottom', {
        seats: ['bottom', 'bottom', 'top', 'left'].map((seat) => ({
          seat, isOccupied: true, isBot: false, isControlledByBot: false, isConnected: true,
        })),
      }));
      assert.equal(harness.worker.tables[0].failureCode, 'duplicate_seat');
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects snapshot when yourSeat is missing from roster', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend(fullHumanSnapshot('room-missing-your-seat', 'north'));
      assert.equal(harness.worker.tables[0].failureCode, 'snapshot_your_seat_missing');
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects unknown seat id in snapshot roster', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend(fullHumanSnapshot('room-unknown-seat', 'bottom', {
        seats: ['bottom', 'right', 'top', 'north'].map((seat) => ({
          seat, isOccupied: true, isBot: false, isControlledByBot: false, isConnected: true,
        })),
      }));
      assert.equal(harness.worker.tables[0].failureCode, 'unknown_seat');
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects snapshot roster with extra unoccupied seat', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend(fullHumanSnapshot('room-extra-seat', 'bottom', {
        seats: [
          ...SERVER_SEATS.map((seat) => ({
            seat, isOccupied: true, isBot: false,
            isControlledByBot: false, isConnected: true,
          })),
          {
            seat: 'spare', isOccupied: false, isBot: false,
            isControlledByBot: false, isConnected: false,
          },
        ],
      }));
      assert.equal(harness.worker.tables[0].failureCode, 'snapshot_roster_invalid');
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects snapshot roster with fewer or more than four seats', async () => {
    const fewer = await startJoinedLocalTable();
    try {
      fewer.sockets[0].serverSend(fullHumanSnapshot('room-fewer-seats', 'bottom', {
        seats: SERVER_SEATS.slice(0, 3).map((seat) => ({
          seat, isOccupied: true, isBot: false,
          isControlledByBot: false, isConnected: true,
        })),
      }));
      assert.equal(fewer.worker.tables[0].failureCode, 'snapshot_roster_invalid');
    } finally {
      await fewer.stop();
    }

    const more = await startJoinedLocalTable();
    try {
      more.sockets[0].serverSend(fullHumanSnapshot('room-more-seats', 'bottom', {
        seats: [...SERVER_SEATS, 'extra'].map((seat) => ({
          seat, isOccupied: true, isBot: false,
          isControlledByBot: false, isConnected: true,
        })),
      }));
      assert.equal(more.worker.tables[0].failureCode, 'snapshot_roster_invalid');
    } finally {
      await more.stop();
    }
  });

  await test('matchmaking rejects controlled-by-bot snapshot roster seats', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend(fullHumanSnapshot('room-controlled-seat', 'bottom', {
        seats: SERVER_SEATS.map((seat, index) => ({
          seat, isOccupied: true, isBot: false,
          isControlledByBot: index === 1, isConnected: true,
        })),
      }));
      assert.equal(harness.worker.tables[0].failureCode, 'seat_controlled_by_bot');
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects disconnected snapshot roster seats', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend(fullHumanSnapshot('room-disconnected-seat', 'bottom', {
        seats: SERVER_SEATS.map((seat, index) => ({
          seat, isOccupied: true, isBot: false,
          isControlledByBot: false, isConnected: index !== 2,
        })),
      }));
      assert.equal(harness.worker.tables[0].failureCode, 'seat_not_connected');
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking rejects wrong or missing snapshot stakeAmount', async () => {
    const wrongStake = await startJoinedLocalTable();
    try {
      wrongStake.sockets[0].serverSend(fullHumanSnapshot('room-wrong-snapshot-stake', 'bottom', {
        stakeAmount: 4999,
      }));
      assert.equal(wrongStake.worker.tables[0].failureCode, 'stake_mismatch');
      assert.equal(wrongStake.worker.metrics.matchmakingSnapshots, 0);
    } finally {
      await wrongStake.stop();
    }

    const missingStake = await startJoinedLocalTable();
    try {
      missingStake.sockets[0].serverSend(fullHumanSnapshot('room-missing-snapshot-stake', 'bottom', {
        stakeAmount: undefined,
      }));
      assert.equal(missingStake.worker.tables[0].failureCode, 'stake_mismatch');
      assert.equal(missingStake.worker.metrics.matchmakingSnapshots, 0);
    } finally {
      await missingStake.stop();
    }
  });

  await test('matchmaking rejects invalid authoritative phase values', async () => {
    for (const [label, value] of [
      ['object', { phase: 'cutting' }],
      ['number', 7],
      ['unknown', 'bogus-phase'],
    ]) {
      const harness = await startJoinedLocalTable();
      try {
        harness.sockets[0].serverSend(fullHumanSnapshot(`room-invalid-phase-${label}`, 'bottom', {
          game: { authoritativePhase: value },
        }));
        assert.equal(harness.worker.tables[0].failureCode, 'invalid_authoritative_phase');
        assert.equal(harness.worker.metrics.matchmakingStartedTables, 0);
      } finally {
        await harness.stop();
      }
    }
  });

  await test('matchmaking rejects snapshot seat mismatch', async () => {
    const mismatch = await startJoinedLocalTable();
    try {
      mismatch.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-snap', seat: 'bottom', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      mismatch.sockets[0].serverSend(fullHumanSnapshot('room-snap', 'right'));
      assert.equal(mismatch.worker.tables[0].failureCode, 'snapshot_seat_mismatch');
    } finally {
      await mismatch.stop();
    }
  });

  await test('null phase snapshots confirm before later phase snapshots start the table', async () => {
    const harness = await startJoinedLocalTable();
    try {
      SERVER_SEATS.forEach((seat, index) => {
        harness.sockets[index].serverSend({
          type: 'match_found', roomId: 'room-null-phase', seat, stake: 5000,
          humanPlayers: 4, botPlayers: 0,
        });
        harness.sockets[index].serverSend(fullHumanSnapshot('room-null-phase', seat, {
          game: { authoritativePhase: null },
        }));
      });
      assert.equal(harness.worker.metrics.matchmakingSnapshots, 4);
      assert.equal(harness.worker.metrics.matchmakingConfirmedTables, 1);
      assert.equal(harness.worker.metrics.matchmakingStartedTables, 0);
      assert.equal(harness.worker.metrics.matchmakingReadyTables, 0);

      SERVER_SEATS.forEach((seat, index) => {
        harness.sockets[index].serverSend(fullHumanSnapshot('room-null-phase', seat, {
          game: { authoritativePhase: 'cutting' },
        }));
      });
      assert.equal(harness.worker.metrics.matchmakingSnapshots, 4);
      assert.equal(harness.worker.metrics.matchmakingConfirmedTables, 1);
      assert.equal(harness.worker.metrics.matchmakingStartedTables, 1);
      assert.equal(harness.worker.metrics.matchmakingReadyTables, 1);
    } finally {
      await harness.stop();
    }
  });

  await test('socket close after matchmaking join is terminal and does not rejoin', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].terminate();
      await waitFor(() => harness.worker.tables[0].failureCode === 'socket_lost_after_join',
        500, 'socket close after join was not terminal');
      await sleep(40);
      assert.deepEqual(harness.sockets.map((socket) => socket.sent.length), [1, 1, 1, 1]);
      assert.equal(harness.sockets.length, 4);
      assert.equal(harness.worker.metrics.holdFailures, 1);
    } finally {
      await harness.stop();
    }
  });

  await test('ready matchmaking table becomes failed after socket loss', async () => {
    const harness = await startJoinedLocalTable();
    try {
      SERVER_SEATS.forEach((seat, index) => {
        harness.sockets[index].serverSend({
          type: 'match_found', roomId: 'room-loss-ready', seat, stake: 5000,
          humanPlayers: 4, botPlayers: 0,
        });
        harness.sockets[index].serverSend(fullHumanSnapshot('room-loss-ready', seat));
      });
      assert.equal(harness.worker.metrics.matchmakingReadyTables, 1);
      assert.equal(harness.worker.metrics.matchmakingStartedTables, 1);
      harness.sockets[0].terminate();
      await waitFor(() => harness.worker.tables[0].failureCode === 'socket_lost_after_join',
        500, 'socket close after ready was not terminal');
      assert.equal(harness.worker.tables[0].ready, false);
      assert.equal(harness.worker.metrics.matchmakingReadyTables, 0);
      assert.equal(harness.worker.metrics.matchmakingStartedTables, 0);
      assert.equal(harness.worker.metrics.matchmakingFailedTables, 1);
      assert.equal(harness.worker.metrics.holdFailures, 1);
    } finally {
      await harness.stop();
    }
  });

  await test('matchmaking cleanup reports safe failure codes without secrets', async () => {
    const harness = await startJoinedLocalTable();
    try {
      harness.sockets[0].serverSend({
        type: 'match_found', roomId: 'room-secret', seat: 'bottom', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      harness.sockets[1].serverSend({
        type: 'match_found', roomId: 'room-secret-2', seat: 'right', stake: 5000,
        humanPlayers: 4, botPlayers: 0,
      });
      await harness.stop();
      const final = harness.messages.find((message) => message.type === 'shutdown-complete');
      assert.equal(final.matchmaking.failedTables, 1);
      assert.deepEqual(final.matchmaking.failures, [
        { tableIndex: 0, failureCode: 'mixed_room_id' },
      ]);
      assert.doesNotMatch(JSON.stringify(harness.messages),
        /local-a|secret-a|belot_session|room-secret/i);
    } finally {
      if (harness.worker.metrics.cleanupCompleted === 0) await harness.stop();
    }
  });

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
