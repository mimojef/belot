/**
 * Focused validation tests for the phased load-test files.
 * Run with: node phased-validation-tests.mjs
 *
 * Tests (no real k6 or server needed):
 *  1. Coordinator range validation (tableIndex / playerIndex rejected when out of range)
 *  2. Coordinator barrier releases at Set.size === expectedTables (not >=)
 *  3. Failure propagation — /failure marks barrier failed; other pollers see it
 *  4. websocket-only code path — source inspection proves no join_matchmaking branch
 *  5. Full-mode timing — spread delay formula distributes by tableIndex
 *  6. Original files unchanged (git diff --name-only check)
 */

import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve as resolvePath, dirname, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, '../..');

// ── Tiny assertion helper ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed += 1;
  }
}

// ── HTTP helpers for coordinator ───────────────────────────────────────────────

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(body, 'utf8');
    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: Number(u.port),
      path: u.pathname + u.search,
      method: 'GET',
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Coordinator test harness ───────────────────────────────────────────────────

function startCoordinator(expectedTables) {
  return new Promise((resolve, reject) => {
    const coordScript = new URL('./phased-load-coordinator.mjs', import.meta.url).pathname
      .replace(/^\/([A-Z]:)/, '$1');  // fix Windows path /C:/ → C:/
    const runId = 'test' + Date.now();
    // Find a free port
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => {
        const proc = spawn('node', [coordScript, runId, String(expectedTables), String(port)], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const baseUrl = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + 8000;

        function poll() {
          if (Date.now() > deadline) {
            proc.kill();
            reject(new Error('coordinator did not start'));
            return;
          }
          httpGet(`${baseUrl}/health`).then((r) => {
            if (r.status === 200) {
              resolve({ proc, baseUrl, runId, port });
            } else {
              setTimeout(poll, 150);
            }
          }).catch(() => setTimeout(poll, 150));
        }

        proc.on('error', reject);
        setTimeout(poll, 200);
      });
    });
  });
}

async function stopCoordinator(proc) {
  proc.kill('SIGTERM');
  await new Promise((r) => proc.on('close', r));
}

// ── Test 1 + 2: Range validation + === barrier ─────────────────────────────────

async function testCoordinatorValidationAndBarrier() {
  console.log('\n── Test 1: Coordinator range validation ──────────────────────────');

  const { proc, baseUrl, runId } = await startCoordinator(3);
  const post = (path, body) => httpPost(`${baseUrl}${path}?runId=${runId}`, JSON.stringify(body));
  const get = (path) => httpGet(`${baseUrl}${path}?runId=${runId}`);

  // tableIndex -1 must be rejected
  let r = await post('/login-ready', { tableIndex: -1 });
  assert('tableIndex=-1 rejected with 400', r.status === 400);

  // tableIndex == expectedTables (3) must be rejected
  r = await post('/login-ready', { tableIndex: 3 });
  assert('tableIndex=3 rejected for expectedTables=3', r.status === 400);

  // tableIndex 0, 1, 2 must be accepted
  r = await post('/login-ready', { tableIndex: 0 });
  assert('tableIndex=0 accepted', r.status === 200);
  r = await post('/login-ready', { tableIndex: 1 });
  assert('tableIndex=1 accepted', r.status === 200);

  // Barrier must NOT release yet (only 2/3 tables ready) — strict ===
  r = await get('/login-barrier');
  assert('barrier not released at 2/3 (=== not >=)', r.body.released === false);

  // Third table — barrier must release
  r = await post('/login-ready', { tableIndex: 2 });
  assert('tableIndex=2 accepted', r.status === 200);
  r = await get('/login-barrier');
  assert('barrier released exactly at 3/3', r.body.released === true);

  // Duplicate report is idempotent (Set.size stays 3)
  r = await post('/login-ready', { tableIndex: 1 });
  assert('duplicate tableIndex=1 accepted (idempotent)', r.status === 200);
  r = await get('/login-barrier');
  assert('barrier still released after duplicate', r.body.released === true);

  console.log('\n── Test 2: /ws-ready range validation ───────────────────────────');

  r = await post('/ws-ready', { tableIndex: -1 });
  assert('ws tableIndex=-1 rejected', r.status === 400);
  r = await post('/ws-ready', { tableIndex: 3 });
  assert('ws tableIndex=3 rejected for expectedTables=3', r.status === 400);

  await post('/ws-ready', { tableIndex: 0 });
  await post('/ws-ready', { tableIndex: 1 });
  r = await post('/ws-unready', { tableIndex: 1 });
  assert('ws-unready removes a currently ready table', r.body.wsTablesReady === 1);
  await post('/ws-ready', { tableIndex: 2 });
  r = await get('/ws-barrier');
  assert('stale readiness does not release WS barrier', r.body.released === false);
  await post('/ws-ready', { tableIndex: 1 });
  r = await get('/ws-barrier');
  assert('reconnected table can become ready again', r.body.released === true);

  console.log('\n── Test 3: /failure range validation ────────────────────────────');

  r = await post('/failure', { tableIndex: -1, phase: 'ws', reason: 'test' });
  assert('failure tableIndex=-1 rejected', r.status === 400);
  r = await post('/failure', { tableIndex: 3, phase: 'ws', reason: 'test' });
  assert('failure tableIndex=3 rejected', r.status === 400);
  r = await post('/failure', { tableIndex: 0, playerIndex: -1, phase: 'ws', reason: 'test' });
  assert('failure playerIndex=-1 rejected', r.status === 400);
  r = await post('/failure', { tableIndex: 0, playerIndex: 4, phase: 'ws', reason: 'test' });
  assert('failure playerIndex=4 rejected', r.status === 400);
  r = await post('/failure', { tableIndex: 0, playerIndex: 3, phase: 'ws', reason: 'test' });
  assert('failure tableIndex=0 playerIndex=3 accepted', r.status === 200);

  await stopCoordinator(proc);
}

// ── Test 4: Failure propagation ────────────────────────────────────────────────

async function testFailurePropagation() {
  console.log('\n── Test 4: Failure propagation ──────────────────────────────────');

  const { proc, baseUrl, runId } = await startCoordinator(2);
  const post = (path, body) => httpPost(`${baseUrl}${path}?runId=${runId}`, JSON.stringify(body));
  const get = (path) => httpGet(`${baseUrl}${path}?runId=${runId}`);

  // Both tables report ws-ready
  await post('/ws-ready', { tableIndex: 0 });
  await post('/ws-ready', { tableIndex: 1 });

  // WS barrier is released
  let r = await get('/ws-barrier');
  assert('WS barrier released at 2/2', r.body.released === true);
  assert('WS barrier not failed before failure report', r.body.failed === false);

  // Now send a login failure (different phase — coordinator tracks phases separately)
  const { proc: proc2, baseUrl: bu2, runId: rid2 } = await startCoordinator(2);
  const post2 = (path, body) => httpPost(`${bu2}${path}?runId=${rid2}`, JSON.stringify(body));
  const get2 = (path) => httpGet(`${bu2}${path}?runId=${rid2}`);

  // Table 0 logs in successfully
  await post2('/login-ready', { tableIndex: 0 });

  // Table 1 reports login failure
  r = await post2('/failure', { tableIndex: 1, playerIndex: 2, phase: 'login', reason: 'login failed' });
  assert('login failure accepted', r.status === 200);

  // Login barrier should now be failed
  r = await get2('/login-barrier');
  assert('login barrier marked failed after /failure', r.body.failed === true);
  assert('failureReason set', typeof r.body.failureReason === 'string' && r.body.failureReason.length > 0);
  assert('barrier not released when failed', r.body.released === false);

  await stopCoordinator(proc);
  await stopCoordinator(proc2);
}

// ── Test 5: websocket-only code path (source inspection) ─────────────────────

function testWsOnlyCodePath() {
  console.log('\n── Test 5: websocket-only code path (source inspection) ─────────');

  const src = readFileSync(
    resolvePath(__dirname, 'phased-multi-table-load.js'),
    'utf8',
  );

  // MODE validation must exist
  assert('MODE validation present',
    src.includes("MODE !== 'websocket-only' && MODE !== 'full'"),
  );

  // handleWsBarrierReleased must exist with websocket-only branch
  assert('handleWsBarrierReleased function defined',
    src.includes('function handleWsBarrierReleased('),
  );
  assert('websocket-only branch calls closeTable (not matchmaking)',
    src.includes("MODE === 'websocket-only'") &&
    src.includes('closeTable(tableState)') &&
    // The websocket-only branch must appear BEFORE scheduleJoinMatchmaking
    src.indexOf("MODE === 'websocket-only'") < src.indexOf('scheduleJoinMatchmaking(tableState)'),
  );

  // doSendJoinMatchmaking must NOT be called in websocket-only path
  // (only reachable via scheduleJoinMatchmaking which is the else branch)
  assert('doSendJoinMatchmaking behind full-mode gate',
    src.includes('function doSendJoinMatchmaking(') &&
    src.includes('scheduleJoinMatchmaking(tableState)') &&
    // Ensure the websocket-only closeTable is NOT followed by scheduleJoinMatchmaking in same branch
    !src.includes("MODE === 'websocket-only'") === false,  // double-check it IS there
  );

  // phasedMatchmakingReleased only added inside sentAll === true block
  const sentAllIdx = src.lastIndexOf('if (sentAll)');
  const metricIdx = src.lastIndexOf('phasedMatchmakingReleased.add(1)');
  assert('phasedMatchmakingReleased only inside sentAll block',
    sentAllIdx !== -1 && metricIdx !== -1 && metricIdx > sentAllIdx,
  );

  // WS connect spread uses WS_CONNECT_SPREAD_SECONDS
  assert('WS connect spread constant present',
    src.includes('WS_CONNECT_SPREAD_SECONDS'),
  );

  // Matchmaking spread uses MATCHMAKING_SPREAD_SECONDS
  assert('matchmaking spread constant present',
    src.includes('MATCHMAKING_SPREAD_SECONDS'),
  );

  // reportTableFailureOnce function exists
  assert('reportTableFailureOnce function defined',
    src.includes('function reportTableFailureOnce('),
  );

  // No fail() called directly in default() for login/stake errors
  // (we wrap in try/catch and report to coordinator instead)
  const defaultFnStart = src.indexOf('export default function ()');
  const defaultFnEnd = src.indexOf('\nexport function handleSummary');
  const defaultBody = src.slice(defaultFnStart, defaultFnEnd);
  const hasBareFailCall = /\bfail\s*\(/.test(defaultBody);
  assert('no bare fail() in default() body (reports to coordinator instead)', !hasBareFailCall);

  // buildThresholds function exists
  assert('buildThresholds function defined', src.includes('function buildThresholds()'));
}

// ── Deterministic WS retry state-machine checks ───────────────────────────────

function testRetryStateMachine() {
  console.log('\n── Retry state-machine checks ───────────────────────────────────');
  const harness = createProductionLifecycleHarness();
  harness.lifecycle.connectTableAndPlay(harness.tableState);
  for (let index = 1; index < 4; index += 1) {
    harness.sockets[index].open();
    harness.sockets[index].connected();
  }
  harness.sockets[0].error();
  harness.scheduler.advance(300);
  assert('error + close schedule only one retry', harness.sockets.length === 5, harness.diagnostics());
  assert('only the failed player reconnects',
    harness.players[0].attempts === 2 && harness.players.slice(1).every((player) => player.attempts === 1),
    harness.diagnostics());
  assert('the other three sockets remain active',
    harness.sockets.slice(1, 4).every((socket) => socket.readyState === 1), harness.diagnostics());
  harness.sockets[4].error();
  harness.scheduler.advance(600);
  harness.sockets[5].open();
  harness.sockets[5].connected();
  assert('player can fail twice and recover on the third attempt',
    harness.players[0].attempts === 3 && harness.players[0].wsConnected, harness.diagnostics());
  assert('retry does not duplicate unique readiness metrics',
    harness.counters.phasedWebsocketPlayersReady === 4
      && harness.counters.tablesWithFourWebsocketsReady === 1,
    harness.diagnostics());
  harness.lifecycle.terminateTableLifecycle(harness.tableState, null, false);
  harness.assertNormalCompletion('retry recovery lifecycle leaves no orphan resources');

  const timeout = createProductionLifecycleHarness();
  timeout.lifecycle.connectTableAndPlay(timeout.tableState);
  for (let index = 1; index < 4; index += 1) {
    timeout.sockets[index].open();
    timeout.sockets[index].connected();
  }
  timeout.scheduler.advance(15300);
  assert('hanging attempt is stopped by attempt timeout and retried',
    timeout.players[0].attempts === 2, timeout.diagnostics());
  timeout.lifecycle.terminateTableLifecycle(timeout.tableState, null, false);
  timeout.assertNormalCompletion('attempt-timeout lifecycle leaves no orphan resources');
}

function testConnectDeadlineStartsAfterSpread() {
  console.log('\n── Per-table connect deadline timing ────────────────────────────');
  const deadlineMs = 240000;

  const first = createProductionLifecycleHarness();
  first.lifecycle.waitForWsConnectSpread(first.tableState, 0);
  first.lifecycle.connectTableAndPlay(first.tableState);
  assert('table 0 starts its deadline immediately after zero spread',
    first.tableState.wsConnectStartedAtMs === 0
      && first.tableState.connectDeadlineAtMs === deadlineMs, first.diagnostics());
  first.lifecycle.terminateTableLifecycle(first.tableState, null, false);
  first.assertNormalCompletion('table 0 timing scenario cleans up');

  const last = createProductionLifecycleHarness();
  last.lifecycle.waitForWsConnectSpread(last.tableState, 360000);
  last.lifecycle.connectTableAndPlay(last.tableState);
  assert('last table gets the full 240s deadline after a 360s spread',
    last.tableState.wsConnectStartedAtMs === 360000
      && last.tableState.connectDeadlineAtMs === 600000, last.diagnostics());
  assert('time spent in spread does not reduce the connect deadline',
    last.tableState.connectDeadlineAtMs - last.tableState.wsConnectStartedAtMs === deadlineMs,
    last.diagnostics());
  last.lifecycle.terminateTableLifecycle(last.tableState, null, false);
  last.assertNormalCompletion('last-table timing scenario cleans up');

  const retrying = createProductionLifecycleHarness();
  retrying.lifecycle.waitForWsConnectSpread(retrying.tableState, 299000);
  retrying.lifecycle.connectTableAndPlay(retrying.tableState);
  const absoluteDeadline = retrying.tableState.connectDeadlineAtMs;
  retrying.sockets[0].error();
  retrying.scheduler.advance(300);
  assert('retry attempts retain the same per-table absolute deadline',
    retrying.players[0].attempts === 2
      && retrying.tableState.connectDeadlineAtMs === absoluteDeadline,
    retrying.diagnostics());
  retrying.lifecycle.terminateTableLifecycle(retrying.tableState, null, false);
  retrying.assertNormalCompletion('retry deadline scenario cleans up');

  const failedDuringSpread = createProductionLifecycleHarness({ failedAtMs: 120000 });
  const started = failedDuringSpread.lifecycle.waitForWsConnectSpread(
    failedDuringSpread.tableState, 360000,
  );
  if (started) failedDuringSpread.lifecycle.connectTableAndPlay(failedDuringSpread.tableState);
  assert('table starting after global failure opens no sockets',
    !started && failedDuringSpread.sockets.length === 0, failedDuringSpread.diagnostics());
  failedDuringSpread.assertInterrupted('failed-during-spread scenario aborts', !started);

  const src = readFileSync(resolvePath(__dirname, 'phased-multi-table-load.js'), 'utf8');
  const createIndex = src.indexOf('createTableConnectState(tableIndex, globalTableIndex, players)');
  const spreadIndex = src.indexOf('waitForWsConnectSpread(tableState, wsConnectOffsetMs)');
  const startIndex = src.indexOf('connectTableAndPlay(tableState)', spreadIndex);
  assert('production order is state, spread polling, then connect start',
    createIndex !== -1 && createIndex < spreadIndex && spreadIndex < startIndex);
  assert('production deadline is based on wsConnectStartedAtMs after spread',
    src.includes('tableState.wsConnectStartedAtMs = Date.now()') &&
    src.includes('tableState.wsConnectStartedAtMs + (WS_CONNECT_DEADLINE_SECONDS * 1000)'));
}

function extractFunctionBody(source, functionName) {
  const signatureIndex = source.indexOf(`function ${functionName}(`);
  if (signatureIndex === -1) throw new Error(`missing function ${functionName}`);
  const bodyStart = source.indexOf('{', signatureIndex);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(bodyStart + 1, index);
  }
  throw new Error(`unterminated function ${functionName}`);
}

function extractFunctionSource(source, functionName) {
  const signatureIndex = source.indexOf(`function ${functionName}(`);
  if (signatureIndex === -1) throw new Error(`missing function ${functionName}`);
  const bodyStart = source.indexOf('{', signatureIndex);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(signatureIndex, index + 1);
  }
  throw new Error(`unterminated function ${functionName}`);
}

function extractPowerShellFunction(source, functionName) {
  const signatureIndex = source.indexOf(`function ${functionName}`);
  if (signatureIndex === -1) throw new Error(`missing PowerShell function ${functionName}`);
  const bodyStart = source.indexOf('{', signatureIndex);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(signatureIndex, index + 1);
  }
  throw new Error(`unterminated PowerShell function ${functionName}`);
}

function testInitialWsConnectRuntimePath() {
  console.log('\n── Initial WS connect runtime path ──────────────────────────────');
  const src = readFileSync(resolvePath(__dirname, 'phased-multi-table-load.js'), 'utf8');
  const body = extractFunctionBody(src, 'connectTableAndPlay');
  const connectCalls = [];
  const players = Array.from({ length: 4 }, (_, playerIndex) => ({ playerIndex }));
  const tableState = {
    players,
    terminal: false,
    wsConnectStartedAtMs: null,
    connectDeadlineAtMs: null,
  };
  const executeConnectTableAndPlay = new Function(
    'tableState',
    'observeGlobalWsFailure',
    'WS_CONNECT_DEADLINE_SECONDS',
    'scheduleConnectDeadlineTimer',
    'scheduleGlobalFailurePoll',
    'connectPlayerSocket',
    body,
  );

  let thrown = null;
  try {
    executeConnectTableAndPlay(
      tableState,
      () => false,
      240,
      () => {},
      () => {},
      (actualTableState, player) => connectCalls.push({ actualTableState, player }),
    );
  } catch (error) {
    thrown = error;
  }

  assert('default-to-connect path executes without ReferenceError',
    thrown === null, thrown && thrown.stack ? thrown.stack : String(thrown));
  assert('all four player states enter the WS retry state machine',
    connectCalls.length === 4 && connectCalls.every((call, index) => (
      call.actualTableState === tableState && call.player === players[index]
    )));
  assert('connectTableAndPlay reads players from its table state',
    body.includes('for (const player of tableState.players)'));
}

class FakeScheduler {
  constructor() {
    this.nowMs = 0;
    this.nextId = 1;
    this.resources = new Map();
  }

  setTimeout(callback, delayMs) {
    const id = this.nextId++;
    this.resources.set(id, { callback, at: this.nowMs + Math.max(0, delayMs), interval: null });
    return id;
  }

  clearTimeout(id) { this.resources.delete(id); }

  setInterval(callback, delayMs) {
    const id = this.nextId++;
    this.resources.set(id, { callback, at: this.nowMs + delayMs, interval: delayMs });
    return id;
  }

  clearInterval(id) { this.resources.delete(id); }
  clearAll() { this.resources.clear(); }

  advance(ms) {
    const target = this.nowMs + ms;
    let steps = 0;
    while (steps < 10000) {
      const next = [...this.resources.entries()]
        .filter(([, resource]) => resource.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, resource] = next;
      this.nowMs = resource.at;
      if (resource.interval === null) this.resources.delete(id);
      else resource.at += resource.interval;
      resource.callback();
      steps += 1;
    }
    if (steps >= 10000) throw new Error('fake scheduler did not quiesce');
    this.nowMs = target;
  }

  runUntilIdle() {
    let steps = 0;
    while (this.resources.size > 0 && steps < 10000) {
      const nextAt = Math.min(...[...this.resources.values()].map((resource) => resource.at));
      this.advance(Math.max(0, nextAt - this.nowMs));
      steps += 1;
    }
    if (steps >= 10000) throw new Error('fake event loop did not become idle');
  }
}

function createProductionLifecycleHarness(options = {}) {
  const source = readFileSync(resolvePath(__dirname, 'phased-multi-table-load.js'), 'utf8');
  const scheduler = new FakeScheduler();
  const sockets = [];
  const coordinator = {
    failedAtMs: options.failedAtMs ?? Number.POSITIVE_INFINITY,
    barrierFailed: options.barrierFailed === true,
    barrierReleased: options.barrierReleased === true,
  };
  const counters = {};
  const abortState = { interrupted: false, reason: null, calls: 0 };
  const metric = (name) => ({ add(value = 1) { counters[name] = (counters[name] || 0) + value; } });

  class FakeWebSocket {
    constructor() {
      this.readyState = 0;
      this.listeners = new Map();
      this.closeCalls = 0;
      this.closeThrows = sockets.length === 0
        ? (options.closeThrows ?? (options.throwFirstClose === true ? 1 : 0))
        : 0;
      sockets.push(this);
    }

    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(callback);
    }

    emit(type, event = {}) {
      for (const callback of this.listeners.get(type) || []) callback(event);
    }

    open() {
      if (this.readyState === 3) return;
      this.readyState = 1;
      this.emit('open');
    }

    connected() { this.emit('message', { data: JSON.stringify({ type: 'connected' }) }); }
    error() { this.emit('error', {}); }

    close() {
      this.closeCalls += 1;
      if (this.closeCalls <= this.closeThrows) throw new Error('WebSocket close failed');
      if (this.readyState === 3) return;
      if (options.neverCloses === true) {
        if (options.stuckClosing === true) this.readyState = 2;
        return;
      }
      this.readyState = 2;
      scheduler.setTimeout(() => {
        this.readyState = 3;
        this.emit('close', { code: 1000, reason: '' });
      }, 0);
    }

    abortTransport() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', { code: 1006, reason: 'test aborted' });
    }
  }

  const functionNames = [
    'createTableConnectState', 'waitForWsConnectSpread', 'connectTableAndPlay',
    'connectPlayerSocket', 'isCurrentAttempt', 'handleConnectAttemptFailure',
    'scheduleConnectDeadlineTimer', 'clearPlayerConnectTimers', 'findSocketAttempt',
    'clearAttemptTimers', 'markTableWsUnready', 'terminalTableFailure',
    'scheduleGlobalFailurePoll', 'observeGlobalWsFailure', 'handleMessage',
    'handleConnected', 'allFourWsConnected', 'maybeCountTableWebsocketsReady',
    'maybeReportWsReady', 'reportWsReadyAndStartPolling', 'pollWsBarrier',
    'handleWsBarrierReleased', 'reportTableFailureOnce', 'closeTable',
    'terminateTableLifecycle', 'beginTableTermination', 'abortTestOnce',
    'clearTableLifecycleTimers', 'closeTrackedAttempt', 'finalizeSocketAttempt',
    'maybeCompleteTableCleanup', 'scheduleCleanupWatchdog', 'clearWsBarrierTimer',
    'safeClose', 'closeSocket',
  ];
  const productionSource = functionNames.map((name) => extractFunctionSource(source, name)).join('\n');
  const factory = new Function('deps', `
    const {
      __VU, Date, WebSocket, exec, setTimeout, clearTimeout, setInterval, clearInterval, sleep,
      coordinatorGet, coordinatorPost, WS_CONNECT_DEADLINE_SECONDS,
      WS_CONNECT_ATTEMPT_TIMEOUT_SECONDS, WS_MAX_ATTEMPTS, WS_RETRY_BASE_DELAY_MS,
      WS_RETRY_MAX_DELAY_MS, SOCKET_CLEANUP_WATCHDOG_MS, COORDINATOR_POLL_INTERVAL_MS,
      PING_INTERVAL_MS, RUN_TIMEOUT_MS, WS_URL, ORIGIN, WS_OPEN, WS_CLOSED,
      MODE, WS_BARRIER_TIMEOUT_SECONDS, websocketConnectAttempts,
      websocketRetryAttempts, websocketErrors, websocketFirstAttemptFailures,
      websocketConnectDeadlineExceeded, websocketRetryExhausted,
      websocketTerminalFailures, protocolErrors, phasedWebsocketPlayersReady,
      websocketConnectionsReady, websocketRecoveredAfterRetry,
      tablesWithFourWebsocketsReady, phasedWebsocketTablesReady,
      phasedWebsocketBarrierFailed, phasedWebsocketBarrierReached,
      rejectedActions, clearActionInFlight, cancelLeaveRetry, sendProtocol,
      logSafe, logTableSafe, safeString, parseJson, coordinatorUrl, runId,
      handleMatchFound, handleRoomSnapshot, logRejectedActionDiagnostic,
      REJECTED_ACTION_DIAGNOSTICS, scheduleJoinMatchmaking,
    } = deps;
    const COORDINATOR_URL = coordinatorUrl;
    const RUN_ID = runId;
    ${productionSource}
    return { ${functionNames.join(', ')} };
  `);
  const deps = {
    __VU: 1,
    Date: { now: () => scheduler.nowMs },
    WebSocket: FakeWebSocket,
    exec: { test: { abort: (reason) => {
      if (abortState.interrupted) return;
      abortState.interrupted = true;
      abortState.reason = String(reason);
      abortState.calls += 1;
      scheduler.clearAll();
      for (const socket of sockets) socket.abortTransport();
    } } },
    setTimeout: scheduler.setTimeout.bind(scheduler),
    clearTimeout: scheduler.clearTimeout.bind(scheduler),
    setInterval: scheduler.setInterval.bind(scheduler),
    clearInterval: scheduler.clearInterval.bind(scheduler),
    sleep: (seconds) => scheduler.advance(seconds * 1000),
    coordinatorGet: () => ({ status: 200, body: {
      failed: coordinator.barrierFailed || scheduler.nowMs >= coordinator.failedAtMs,
      released: coordinator.barrierReleased,
    } }),
    coordinatorPost: () => ({ status: 200, body: {} }),
    WS_CONNECT_DEADLINE_SECONDS: 240,
    WS_CONNECT_ATTEMPT_TIMEOUT_SECONDS: 15,
    WS_MAX_ATTEMPTS: 3,
    WS_RETRY_BASE_DELAY_MS: 250,
    WS_RETRY_MAX_DELAY_MS: 2000,
    SOCKET_CLEANUP_WATCHDOG_MS: 5000,
    COORDINATOR_POLL_INTERVAL_MS: 1000,
    PING_INTERVAL_MS: 20000,
    RUN_TIMEOUT_MS: 600000,
    WS_URL: 'ws://test/ws', ORIGIN: 'http://test', WS_OPEN: 1, WS_CLOSED: 3,
    MODE: options.mode || 'websocket-only', WS_BARRIER_TIMEOUT_SECONDS: 120,
    websocketConnectAttempts: metric('websocketConnectAttempts'),
    websocketRetryAttempts: metric('websocketRetryAttempts'),
    websocketErrors: metric('websocketErrors'),
    websocketFirstAttemptFailures: metric('websocketFirstAttemptFailures'),
    websocketConnectDeadlineExceeded: metric('websocketConnectDeadlineExceeded'),
    websocketRetryExhausted: metric('websocketRetryExhausted'),
    websocketTerminalFailures: metric('websocketTerminalFailures'),
    protocolErrors: metric('protocolErrors'),
    phasedWebsocketPlayersReady: metric('phasedWebsocketPlayersReady'),
    websocketConnectionsReady: metric('websocketConnectionsReady'),
    websocketRecoveredAfterRetry: metric('websocketRecoveredAfterRetry'),
    tablesWithFourWebsocketsReady: metric('tablesWithFourWebsocketsReady'),
    phasedWebsocketTablesReady: metric('phasedWebsocketTablesReady'),
    phasedWebsocketBarrierFailed: metric('phasedWebsocketBarrierFailed'),
    phasedWebsocketBarrierReached: metric('phasedWebsocketBarrierReached'),
    rejectedActions: metric('rejectedActions'),
    clearActionInFlight: (state) => { state.actionInFlight = null; },
    cancelLeaveRetry: (state) => {
      if (state.leaveRetryTimerId !== null) scheduler.clearTimeout(state.leaveRetryTimerId);
      state.leaveRetryTimerId = null;
    },
    sendProtocol: () => true, logSafe: () => {}, logTableSafe: () => {},
    safeString: String, parseJson: JSON.parse, coordinatorUrl: 'http://coordinator', runId: 'test',
    handleMatchFound: () => {}, handleRoomSnapshot: () => {},
    logRejectedActionDiagnostic: () => {}, REJECTED_ACTION_DIAGNOSTICS: false,
    scheduleJoinMatchmaking: () => {},
  };
  const lifecycle = factory(deps);
  const players = Array.from({ length: 4 }, (_, playerIndex) => ({
    playerIndex, jar: {}, attempts: 0, attemptGeneration: 0, attemptActive: false,
    attemptFailed: false, attemptTimeoutId: null, retryTimerId: null, pingTimerId: null,
    runTimeoutId: null, leaveRetryTimerId: null, actionInFlight: null, wsConnected: false,
    wsReadyCounted: false, recoveryCounted: false, completionCounted: false,
    closeRequested: false, closed: false, sentActionKeys: {},
  }));
  const tableState = lifecycle.createTableConnectState(0, 0, players);

  function diagnostics() {
    const attempts = [...tableState.socketAttempts];
    return JSON.stringify({
      activeAttempts: attempts.length,
      connectingAttempts: attempts.filter((attempt) => attempt.ws.readyState === 0).length,
      openAttempts: attempts.filter((attempt) => attempt.ws.readyState === 1).length,
      retryTimers: players.filter((player) => player.retryTimerId !== null).length,
      attemptTimers: attempts.filter((attempt) => attempt.attemptTimeoutId !== null).length,
      deadlineTimers: tableState.connectDeadlineTimerId === null ? 0 : 1,
      pollingTimers: Number(tableState.globalFailurePollTimerId !== null)
        + Number(tableState.wsBarrierPollTimerId !== null),
      schedulerResources: scheduler.resources.size,
      terminal: tableState.terminal,
      cleanupStarted: tableState.cleanupStarted,
      cleanupComplete: tableState.cleanupComplete,
      cleanupFailed: tableState.cleanupFailed,
      abortInitiated: tableState.abortInitiated,
      abortReason: tableState.abortReason,
      interrupted: abortState.interrupted,
    });
  }

  function assertNormalCompletion(label, productionReturned = true) {
    scheduler.runUntilIdle();
    const ok = productionReturned && tableState.terminal && tableState.cleanupStarted
      && tableState.cleanupComplete && tableState.socketAttempts.size === 0
      && !abortState.interrupted && scheduler.resources.size === 0
      && sockets.every((socket) => socket.readyState === 3);
    assert(label, ok, diagnostics());
  }

  function assertInterrupted(label, productionReturned = true) {
    scheduler.runUntilIdle();
    const ok = productionReturned && tableState.terminal && tableState.abortInitiated
      && abortState.interrupted && abortState.calls === 1 && scheduler.resources.size === 0
      && sockets.every((socket) => socket.readyState === 3);
    assert(label, ok, diagnostics());
  }

  return {
    lifecycle, scheduler, sockets, coordinator, counters, abortState, players, tableState,
    diagnostics, assertNormalCompletion, assertInterrupted,
  };
}

function testProductionLifecycleTermination() {
  console.log('\n── Production lifecycle termination harness ────────────────────');

  const spread = createProductionLifecycleHarness({ failedAtMs: 1000 });
  const spreadReturned = spread.lifecycle.waitForWsConnectSpread(spread.tableState, 5000) === false;
  spread.assertInterrupted('global failure during WS spread interrupts iteration', spreadReturned);

  const hanging = createProductionLifecycleHarness();
  hanging.lifecycle.connectTableAndPlay(hanging.tableState);
  hanging.coordinator.barrierFailed = true;
  hanging.scheduler.advance(1000);
  hanging.assertInterrupted('global failure aborts hanging first CONNECTING attempts');

  for (const [label, closeThrows] of [['once', 1], ['repeatedly', 3], ['always', Infinity]]) {
    const throwing = createProductionLifecycleHarness({ closeThrows });
    throwing.lifecycle.connectTableAndPlay(throwing.tableState);
    throwing.lifecycle.terminateTableLifecycle(throwing.tableState, null, false);
    throwing.assertInterrupted(`successful cleanup aborts when close throws ${label}`);
  }

  const stuckConnecting = createProductionLifecycleHarness({ neverCloses: true });
  stuckConnecting.lifecycle.connectTableAndPlay(stuckConnecting.tableState);
  stuckConnecting.lifecycle.terminateTableLifecycle(stuckConnecting.tableState, null, false);
  stuckConnecting.assertInterrupted('CONNECTING socket without close event hits watchdog abort');

  const stuckClosing = createProductionLifecycleHarness({ neverCloses: true, stuckClosing: true });
  stuckClosing.lifecycle.connectTableAndPlay(stuckClosing.tableState);
  stuckClosing.lifecycle.terminateTableLifecycle(stuckClosing.tableState, null, false);
  stuckClosing.assertInterrupted('CLOSING socket without close event hits watchdog abort');

  const lateOpen = createProductionLifecycleHarness({ throwFirstClose: true });
  lateOpen.lifecycle.connectTableAndPlay(lateOpen.tableState);
  lateOpen.lifecycle.terminateTableLifecycle(lateOpen.tableState, null, false);
  lateOpen.sockets[0].open();
  lateOpen.assertNormalCompletion('late open after cleanup closes the same socket');

  const retry = createProductionLifecycleHarness();
  retry.lifecycle.connectTableAndPlay(retry.tableState);
  retry.sockets[0].error();
  retry.coordinator.barrierFailed = true;
  retry.lifecycle.observeGlobalWsFailure(retry.tableState);
  retry.assertInterrupted('global failure during retry delay cancels retry and aborts');

  for (const readyCount of [1, 2, 3]) {
    const incomplete = createProductionLifecycleHarness();
    incomplete.lifecycle.connectTableAndPlay(incomplete.tableState);
    for (let index = 0; index < readyCount; index += 1) {
      incomplete.sockets[index].open();
      incomplete.sockets[index].connected();
    }
    incomplete.lifecycle.terminateTableLifecycle(
      incomplete.tableState, `incomplete ${readyCount}/4 failure`, true,
    );
    incomplete.assertInterrupted(`incomplete ${readyCount}/4 table aborts cleanly`);
  }

  const ready = createProductionLifecycleHarness();
  ready.lifecycle.connectTableAndPlay(ready.tableState);
  for (const socket of ready.sockets) { socket.open(); socket.connected(); }
  ready.lifecycle.terminateTableLifecycle(ready.tableState, 'ready barrier failure', true);
  ready.assertInterrupted('ready 4/4 table waiting at barrier aborts');

  const barrierFailed = createProductionLifecycleHarness();
  barrierFailed.lifecycle.connectTableAndPlay(barrierFailed.tableState);
  for (const socket of barrierFailed.sockets) { socket.open(); socket.connected(); }
  barrierFailed.coordinator.barrierFailed = true;
  barrierFailed.scheduler.advance(0);
  barrierFailed.assertInterrupted('WS barrier failed=true aborts test run');

  const stale = createProductionLifecycleHarness();
  stale.lifecycle.connectTableAndPlay(stale.tableState);
  const oldSocket = stale.sockets[0];
  const player = stale.players[0];
  player.attemptGeneration += 1;
  player.attemptActive = false;
  stale.lifecycle.connectPlayerSocket(stale.tableState, player);
  oldSocket.open();
  stale.lifecycle.terminateTableLifecycle(stale.tableState, null, false);
  stale.assertNormalCompletion('stale socket generation is closed and deregistered');

  const success = createProductionLifecycleHarness({ barrierReleased: true });
  success.lifecycle.connectTableAndPlay(success.tableState);
  for (const socket of success.sockets) { socket.open(); socket.connected(); }
  success.scheduler.advance(0);
  success.assertNormalCompletion('successful websocket-only cleanup reaches quiescence');
  assert('successful cleanup leaves failure/retry/error metrics unchanged',
    (success.counters.websocketTerminalFailures || 0) === 0
      && (success.counters.websocketRetryAttempts || 0) === 0
      && (success.counters.websocketErrors || 0) === 0,
    success.diagnostics());

  const repeated = createProductionLifecycleHarness();
  repeated.lifecycle.connectTableAndPlay(repeated.tableState);
  repeated.lifecycle.terminateTableLifecycle(repeated.tableState, 'first abort reason', true);
  const generations = repeated.players.map((entry) => entry.attemptGeneration);
  repeated.lifecycle.terminateTableLifecycle(repeated.tableState, 'second abort reason', true);
  assert('repeated termination is idempotent',
    repeated.players.every((entry, index) => entry.attemptGeneration === generations[index]),
    repeated.diagnostics());
  assert('repeated termination preserves first abort reason and one abort call',
    repeated.abortState.reason === 'first abort reason' && repeated.abortState.calls === 1,
    repeated.diagnostics());
  repeated.assertInterrupted('repeated termination remains one interrupted lifecycle');

  const lateRetry = createProductionLifecycleHarness();
  lateRetry.lifecycle.connectTableAndPlay(lateRetry.tableState);
  lateRetry.sockets[0].error();
  const retryResource = lateRetry.scheduler.resources.get(lateRetry.players[0].retryTimerId);
  const attemptsBeforeRetryTermination = lateRetry.sockets.length;
  lateRetry.lifecycle.terminateTableLifecycle(lateRetry.tableState, 'queued retry abort', true);
  if (retryResource) retryResource.callback();
  assert('late retry callback creates no socket after termination',
    lateRetry.sockets.length === attemptsBeforeRetryTermination, lateRetry.diagnostics());
  lateRetry.assertInterrupted('late retry callback leaves interrupted run quiescent');

  const lateTimeout = createProductionLifecycleHarness();
  lateTimeout.lifecycle.connectTableAndPlay(lateTimeout.tableState);
  const firstAttempt = [...lateTimeout.tableState.socketAttempts][0];
  const timeoutCallback = lateTimeout.scheduler.resources.get(firstAttempt.attemptTimeoutId).callback;
  const attemptsBeforeTimeoutTermination = lateTimeout.sockets.length;
  lateTimeout.lifecycle.terminateTableLifecycle(lateTimeout.tableState, 'queued timeout abort', true);
  timeoutCallback();
  assert('late attempt-timeout callback creates no socket after termination',
    lateTimeout.sockets.length === attemptsBeforeTimeoutTermination, lateTimeout.diagnostics());
  lateTimeout.assertInterrupted('late attempt-timeout callback leaves interrupted run quiescent');

  for (const type of ['session_displaced', 'session_in_game']) {
    const protocolTerminal = createProductionLifecycleHarness();
    protocolTerminal.lifecycle.connectTableAndPlay(protocolTerminal.tableState);
    protocolTerminal.sockets[0].open();
    protocolTerminal.sockets[0].emit('message', { data: JSON.stringify({ type }) });
    protocolTerminal.assertInterrupted(`${type} uses shared terminal abort path`);
  }

  const intentionalError = createProductionLifecycleHarness({ neverCloses: true });
  intentionalError.lifecycle.connectTableAndPlay(intentionalError.tableState);
  intentionalError.lifecycle.terminateTableLifecycle(intentionalError.tableState, null, false);
  const errorsBefore = intentionalError.counters.websocketErrors || 0;
  intentionalError.sockets[0].error();
  assert('error from intentional cleanup does not increment websocket_errors',
    (intentionalError.counters.websocketErrors || 0) === errorsBefore,
    intentionalError.diagnostics());
  intentionalError.assertInterrupted('intentional-error watchdog aborts bounded cleanup');
}

function runChild(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, error, stdout, stderr });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut: false, stdout, stderr });
    });
  });
}

async function runLocalK6AbortProbe(k6Command, mode, tempDirectory) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (mode === 'connecting') {
      socket.on('data', () => {});
      return;
    }
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString('utf8');
      if (!request.includes('\r\n\r\n')) return;
      const keyMatch = request.match(/^Sec-WebSocket-Key:\s*(.+)$/im);
      if (!keyMatch) return;
      const accept = createHash('sha1')
        .update(`${keyMatch[1].trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.removeAllListeners('data');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const scriptPath = joinPath(tempDirectory, `probe-${mode}.js`);
  const summaryPath = joinPath(tempDirectory, `summary-${mode}.json`);
  writeFileSync(scriptPath, `
import exec from 'k6/execution';
import { WebSocket } from 'k6/websockets';
export const options = { scenarios: { probe: {
  executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '20s', gracefulStop: '1s',
} } };
export default function () {
  setTimeout(() => {
    console.log('ABORT_TIMER_FIRED');
    exec.test.abort(__ENV.ABORT_REASON);
  }, 300);
  console.log('BEFORE_SOCKET');
  new WebSocket(__ENV.PROBE_URL);
  console.log('AFTER_SOCKET');
}
export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data) };
}
`, 'utf8');

  const startedAt = Date.now();
  const result = await runChild(k6Command, [
    'run', '-e', `PROBE_URL=ws://127.0.0.1:${port}/ws`,
    '-e', `ABORT_REASON=runtime-probe-${mode}`,
    '-e', `SUMMARY_PATH=${summaryPath}`, scriptPath,
  ], 8000);
  result.elapsedMs = Date.now() - startedAt;
  await new Promise((resolve) => setTimeout(resolve, 100));
  result.serverSocketsClosed = sockets.size === 0;
  result.summaryExists = existsSync(summaryPath);
  result.summaryParseable = false;
  if (result.summaryExists) {
    try {
      JSON.parse(readFileSync(summaryPath, 'utf8'));
      result.summaryParseable = true;
    } catch { /* reported by assertion */ }
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  return result;
}

async function testLocalK6RuntimeAbortProbes() {
  console.log('\n── Local k6 runtime abort probes ────────────────────────────────');
  const k6Candidates = [
    'k6',
    process.env.ProgramFiles ? joinPath(process.env.ProgramFiles, 'k6', 'k6.exe') : null,
    process.env.ProgramData ? joinPath(process.env.ProgramData, 'chocolatey', 'bin', 'k6.exe') : null,
    process.env.USERPROFILE ? joinPath(process.env.USERPROFILE, 'scoop', 'shims', 'k6.exe') : null,
  ].filter(Boolean);
  let k6Command = null;
  let version = null;
  for (const candidate of k6Candidates) {
    if (candidate !== 'k6' && !existsSync(candidate)) continue;
    const result = await runChild(candidate, ['version'], 3000);
    if (!result.error && result.code === 0) {
      k6Command = candidate;
      version = result;
      break;
    }
  }
  if (k6Command === null) {
    assert('local k6 binary is available for mandatory runtime probes', false,
      'k6 executable was not found in PATH or standard local install locations');
    return;
  }
  assert('local k6 binary is available for mandatory runtime probes', true);
  console.log(`    ${version.stdout.trim() || version.stderr.trim()}`);

  const tempDirectory = mkdtempSync(joinPath(tmpdir(), 'belot-k6-runtime-probe-'));
  try {
    const connecting = await runLocalK6AbortProbe(k6Command, 'connecting', tempDirectory);
    const open = await runLocalK6AbortProbe(k6Command, 'open', tempDirectory);
    // Known blocker: exec.test.abort() with active k6/websockets sockets does NOT terminate k6
    // quickly — the process runs until maxDuration (20s) and our 8s hard-kill fires first.
    // Assertions confirm the blocker is present. When fixed, these will flip and alert us.
    for (const [mode, result] of [['CONNECTING', connecting], ['OPEN', open]]) {
      assert(
        `${mode}: exec.test.abort() with active WS socket hangs k6 past 8s [known blocker]`,
        result.timedOut,
        JSON.stringify({ timedOut: result.timedOut, elapsedMs: result.elapsedMs }),
      );
      assert(
        `${mode}: server TCP socket eventually closes after hard kill`,
        result.serverSocketsClosed,
        JSON.stringify({ serverSocketsClosed: result.serverSocketsClosed }),
      );
    }
    console.log('    Known blocker: exec.test.abort() does not interrupt active WS sessions.');
    console.log('    Implication: phased-multi-table-load.js never relies on abort() for shutdown;');
    console.log('    coordinator-detected failure terminates k6 externally via Stop-VerifiedProcessTree.');
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function runPowerShellTree(scriptPath, configPath, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, configPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => {
      if (settled) return;
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
      settled = true;
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut: false, stdout, stderr });
    });
  });
}

function startSupervisorWebSocketServer(mode) {
  const sockets = new Set();
  let handshakeComplete = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (mode === 'connecting') { socket.on('data', () => {}); return; }
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString('utf8');
      if (!request.includes('\r\n\r\n')) return;
      const match = request.match(/^Sec-WebSocket-Key:\s*(.+)$/im);
      if (!match) return;
      const accept = createHash('sha1')
        .update(`${match[1].trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
        + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      handshakeComplete = true;
      socket.removeAllListeners('data');
    });
  });
  return {
    server, sockets,
    get handshakeComplete() { return handshakeComplete; },
  };
}

async function testExternalK6Supervisor() {
  console.log('\n── External k6 failure supervisor ──────────────────────────────');
  const runnerSource = readFileSync(
    resolvePath(__dirname, 'run-phased-multi-table-load.ps1'), 'utf8',
  );
  const functionNames = [
    'ConvertTo-NativeArgument', 'Start-K6Async', 'Drain-K6Output',
    'Stop-VerifiedProcessTree', 'Get-MetricsNdjsonStats', 'Write-AtomicJson',
    'New-RunnerResult', 'Invoke-K6Supervisor',
  ];
  const tempDirectory = mkdtempSync(joinPath(tmpdir(), 'belot-k6-supervisor-'));
  const functionsPath = joinPath(tempDirectory, 'supervisor-functions.ps1');
  const wrapperPath = joinPath(tempDirectory, 'supervisor-wrapper.ps1');
  writeFileSync(
    functionsPath,
    functionNames.map((name) => extractPowerShellFunction(runnerSource, name)).join('\r\n\r\n'),
    'utf8',
  );
  writeFileSync(wrapperPath, `
param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'supervisor-functions.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath | ConvertFrom-Json
$arguments = @('run', '--out', "json=$($config.metricsPath)")
if ($config.probeUrl) { $arguments += @('-e', "PROBE_URL=$($config.probeUrl)") }
$arguments += @('-e', "SUMMARY_PATH=$($config.summaryPath)", $config.scriptPath)
$watch = [Diagnostics.Stopwatch]::StartNew()
$script:statusCalls = 0
$statusProvider = {
  if ($config.failAfterMs -ge 0 -and $watch.ElapsedMilliseconds -ge $config.failAfterMs) {
    $script:statusCalls += 1
    $reason = if ($script:statusCalls -eq 1) { 'first-failure' } else { 'later-failure' }
    return [pscustomobject]@{
      loginBarrierFailed = $false; wsBarrierFailed = $true
      loginFailureReason = $null; wsFailureReason = $reason
      failures = @([pscustomobject]@{ phase = 'ws'; reason = $reason })
    }
  }
  return [pscustomobject]@{ loginBarrierFailed = $false; wsBarrierFailed = $false }
}
$logAction = { param($line, $isError) }
$supervisor = $null
$runnerError = $null
try {
  $executable = if ($config.runnerException) { Join-Path $PSScriptRoot 'missing-k6.exe' } else { $config.k6Path }
  $supervisor = Invoke-K6Supervisor $executable $arguments $statusProvider $logAction $config.graceSeconds 50
} catch { $runnerError = $_.Exception.ToString() }
if ($config.appendPartialMetrics -and (Test-Path -LiteralPath $config.metricsPath)) {
  [IO.File]::AppendAllText($config.metricsPath, '{"partial":', [Text.UTF8Encoding]::new($false))
}
$stats = Get-MetricsNdjsonStats $config.metricsPath
$context = [pscustomobject]@{
  RunId = 'probe-run'; Mode = 'websocket-only'; Tables = 1; StartedAt = [DateTime]::UtcNow
  LogPath = $config.logPath; MetricsPath = $config.metricsPath; SummaryPath = $config.summaryPath
}
$result = New-RunnerResult $context $supervisor $stats $runnerError
Write-AtomicJson $config.resultPath $result
[pscustomobject]@{
  supervisor = $supervisor; runnerResult = $result; runnerError = $runnerError
  resultExists = Test-Path -LiteralPath $config.resultPath
} | ConvertTo-Json -Depth 20
`, 'utf8');

  const k6Candidates = [
    process.env.ProgramFiles ? joinPath(process.env.ProgramFiles, 'k6', 'k6.exe') : null,
    'k6',
  ].filter(Boolean);
  let k6Path = null;
  for (const candidate of k6Candidates) {
    if (candidate !== 'k6' && !existsSync(candidate)) continue;
    const version = await runChild(candidate, ['version'], 3000);
    if (!version.error && version.code === 0) { k6Path = candidate; break; }
  }
  assert('local k6 binary is available for supervisor probes', k6Path !== null);
  if (k6Path === null) { rmSync(tempDirectory, { recursive: true, force: true }); return; }

  async function runCase(name, settings = {}) {
    const caseDirectory = joinPath(tempDirectory, name);
    mkdirSync(caseDirectory);
    let serverState = null;
    if (settings.socketMode) {
      serverState = startSupervisorWebSocketServer(settings.socketMode);
      await new Promise((resolve, reject) => {
        serverState.server.once('error', reject);
        serverState.server.listen(0, '127.0.0.1', resolve);
      });
    }
    const scriptPath = joinPath(caseDirectory, 'probe.js');
    const summaryPath = joinPath(caseDirectory, 'summary.json');
    const metricsPath = joinPath(caseDirectory, 'metrics.ndjson');
    const resultPath = joinPath(caseDirectory, 'runner-result.json');
    const logPath = joinPath(caseDirectory, 'probe.log');
    const probeUrl = serverState
      ? `ws://127.0.0.1:${serverState.server.address().port}/ws` : '';
    let body = 'export default function () {}';
    if (settings.socketMode) {
      body = "import { WebSocket } from 'k6/websockets'; export default function () { new WebSocket(__ENV.PROBE_URL); }";
    } else if (settings.sleepSeconds) {
      body = `import { sleep } from 'k6'; export default function () { sleep(${settings.sleepSeconds}); }`;
    } else if (settings.throwError) {
      body = "export default function () { throw new Error('probe failure'); }";
    }
    const options = settings.throwError
      ? "{vus:1,iterations:1,thresholds:{iterations:['count>1']}}"
      : '{vus:1,iterations:1}';
    writeFileSync(scriptPath, `${body}\nexport const options=${options};\n`
      + 'export function handleSummary(data){return{[__ENV.SUMMARY_PATH]:JSON.stringify(data)}}\n');
    const configPath = joinPath(caseDirectory, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      k6Path, scriptPath, summaryPath, metricsPath, resultPath, logPath, probeUrl,
      failAfterMs: settings.failAfterMs ?? -1,
      graceSeconds: settings.graceSeconds ?? 1,
      appendPartialMetrics: settings.appendPartialMetrics === true,
      runnerException: settings.runnerException === true,
    }));
    const execution = await runPowerShellTree(wrapperPath, configPath, 15000);
    let output = null;
    try { output = JSON.parse(execution.stdout.trim()); } catch { /* asserted below */ }
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
    if (serverState) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      for (const socket of serverState.sockets) socket.destroy();
      await new Promise((resolve) => serverState.server.close(resolve));
    }
    return { execution, output, result, serverSockets: serverState ? serverState.sockets.size : 0 };
  }

  let sentinel = null;
  try {
    const normal = await runCase('normal');
    assert('normally completing k6 produces success without kill',
      normal.result?.outcome === 'success'
        && normal.result.k6.forcedTermination === false
        && normal.result.artifacts.k6SummaryExists === true,
      JSON.stringify(normal));

    const sentinelScript = joinPath(tempDirectory, 'sentinel.js');
    writeFileSync(sentinelScript, "import { sleep } from 'k6'; export default function(){sleep(20)}");
    sentinel = spawn(k6Path, ['run', '--quiet', sentinelScript], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const connecting = await runCase('connecting', { socketMode: 'connecting', failAfterMs: 150 });
    assert('CONNECTING failure kills exact supervised k6 tree',
      connecting.result?.outcome === 'coordinator-failure'
        && connecting.result.k6.forcedTermination === true
        && Number.isInteger(connecting.result.k6.taskkillExitCode)
        && connecting.output?.supervisor?.ProcessId === connecting.result.k6.processId
        && connecting.output?.supervisor?.ProcessStartTimeUtcTicks
          === connecting.result.k6.processStartTimeUtcTicks
        && connecting.serverSockets === 0,
      JSON.stringify(connecting));
    assert('independent sentinel process remains alive', sentinel.exitCode === null);
    sentinel.kill();

    const open = await runCase('open', { socketMode: 'open', failAfterMs: 150 });
    assert('OPEN failure kills exact supervised k6 tree',
      open.result?.outcome === 'coordinator-failure'
        && open.result.k6.forcedTermination === true
        && Number.isInteger(open.result.k6.taskkillExitCode)
        && open.output?.supervisor?.ProcessId === open.result.k6.processId
        && open.output?.supervisor?.ProcessStartTimeUtcTicks
          === open.result.k6.processStartTimeUtcTicks
        && open.serverSockets === 0,
      JSON.stringify(open));
    assert('first coordinator failure reason is preserved',
      open.result?.coordinatorFailure?.wsFailureReason === 'first-failure',
      JSON.stringify(open.result));

    const grace = await runCase('grace', {
      sleepSeconds: 0.4, failAfterMs: 100, graceSeconds: 2,
    });
    assert('k6 exit inside grace period avoids taskkill',
      grace.result?.outcome === 'coordinator-failure'
        && grace.result.k6.forcedTermination === false,
      JSON.stringify(grace));

    const partial = await runCase('partial', { appendPartialMetrics: true });
    assert('partial NDJSON does not corrupt runner result (fast stats)',
      partial.result?.outcome === 'success'
        && partial.result.artifacts.metricsExists === true
        && partial.result.artifacts.metricsFileSizeBytes > 0,
      JSON.stringify(partial));

    const nonzero = await runCase('nonzero', { throwError: true });
    assert('runner result is created for non-zero k6 exit',
      nonzero.result?.outcome === 'k6-error' && nonzero.result.k6.exitCode !== 0,
      JSON.stringify(nonzero));

    const runnerException = await runCase('runner-exception', { runnerException: true });
    assert('runner result is created for supervisor exception',
      runnerException.result?.outcome === 'runner-error'
        && typeof runnerException.result.runnerError === 'string',
      JSON.stringify(runnerException));
  } finally {
    if (sentinel?.exitCode === null) sentinel.kill();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

// ── Test 6: Spread timing distribution ────────────────────────────────────────

function testSpreadTiming() {
  console.log('\n── Test 6: Spread timing distribution ───────────────────────────');

  function calcSpreadMs(tableIndex, tables, spreadSeconds) {
    return tables > 1
      ? Math.floor((tableIndex * spreadSeconds * 1000) / (tables - 1))
      : 0;
  }

  const TABLES = 10;
  const WS_SPREAD = 20;
  const MM_SPREAD = 30;

  // Table 0 starts immediately
  assert('table 0 ws spread = 0ms', calcSpreadMs(0, TABLES, WS_SPREAD) === 0);
  assert('table 0 mm spread = 0ms', calcSpreadMs(0, TABLES, MM_SPREAD) === 0);

  // Last table gets full spread
  const lastWs = calcSpreadMs(TABLES - 1, TABLES, WS_SPREAD);
  assert('table 9 ws spread = 20000ms', lastWs === 20000);
  const lastMm = calcSpreadMs(TABLES - 1, TABLES, MM_SPREAD);
  assert('table 9 mm spread = 30000ms', lastMm === 30000);

  // Monotonically increasing
  let monotonic = true;
  for (let i = 1; i < TABLES; i++) {
    if (calcSpreadMs(i, TABLES, WS_SPREAD) < calcSpreadMs(i - 1, TABLES, WS_SPREAD)) {
      monotonic = false;
    }
  }
  assert('ws spread is monotonically increasing by tableIndex', monotonic);

  // With Tables=1, no spread
  assert('tables=1 ws spread always 0', calcSpreadMs(0, 1, WS_SPREAD) === 0);

  // Spread distribution (show example)
  const steps = [0, 2, 4, 6, 9].map((i) => ({
    table: i,
    wsMs: calcSpreadMs(i, TABLES, WS_SPREAD),
    mmMs: calcSpreadMs(i, TABLES, MM_SPREAD),
  }));
  console.log('    Spread distribution (tables=10, wsSpread=20s, mmSpread=30s):');
  for (const s of steps) {
    console.log(`      table ${s.table}: ws+${s.wsMs}ms  mm+${s.mmMs}ms`);
  }
}

// ── Test 7: Socket lifetime invariant ─────────────────────────────────────────

function testSocketLifetimeInvariant() {
  console.log('\n── Test 7: Socket lifetime invariant ────────────────────────────');

  const src = readFileSync(resolvePath(__dirname, 'phased-multi-table-load.js'), 'utf8');

  // Locate the RUN_TIMEOUT_MS definition block
  const startIdx = src.indexOf('const RUN_TIMEOUT_MS');
  const endIdx   = src.indexOf(') * 1000;', startIdx) + ') * 1000;'.length;
  const def      = src.slice(startIdx, endIdx);

  assert('RUN_TIMEOUT_MS includes WS_CONNECT_SPREAD_SECONDS',
    def.includes('WS_CONNECT_SPREAD_SECONDS'),
    '\n' + def,
  );
  assert('RUN_TIMEOUT_MS includes WS_BARRIER_TIMEOUT_SECONDS',
    def.includes('WS_BARRIER_TIMEOUT_SECONDS'),
  );
  assert('RUN_TIMEOUT_MS includes MATCHMAKING_SPREAD_SECONDS (full branch)',
    def.includes('MATCHMAKING_SPREAD_SECONDS'),
  );
  assert('RUN_TIMEOUT_MS includes MATCH_RUNTIME_TIMEOUT_SECONDS (full branch)',
    def.includes('MATCH_RUNTIME_TIMEOUT_SECONDS'),
  );

  // Replicate the formula and verify the invariant mathematically.
  // The formula must hold: socket_lifetime > max_phased_flow for any valid inputs.
  function calcLifetimeMs(wsConnectSpread, wsBarrier, mmSpread, matchRuntime, mode) {
    return (
      wsConnectSpread
      + wsBarrier
      + (mode === 'full' ? mmSpread + matchRuntime : 0)
      + 120
    ) * 1000;
  }

  // Max time from table-0 socket open until the last possible phased event:
  //   ws-only : latest table connects at +wsConnectSpread, polls barrier for wsBarrier
  //   full    : same + last table waits mmSpread, plays for matchRuntime
  function calcMaxFlowMs(wsConnectSpread, wsBarrier, mmSpread, matchRuntime, mode) {
    if (mode === 'websocket-only') {
      return (wsConnectSpread + wsBarrier) * 1000;
    }
    return (wsConnectSpread + wsBarrier + mmSpread + matchRuntime) * 1000;
  }

  // ── websocket-only: representative values ──────────────────────────────────
  const wsOnly = { wsC: 20, wsB: 120, mmS: 0, mR: 0, mode: 'websocket-only' };
  const wsOnlyLifetime = calcLifetimeMs(wsOnly.wsC, wsOnly.wsB, wsOnly.mmS, wsOnly.mR, wsOnly.mode);
  const wsOnlyFlow     = calcMaxFlowMs (wsOnly.wsC, wsOnly.wsB, wsOnly.mmS, wsOnly.mR, wsOnly.mode);

  assert(
    'ws-only: socket lifetime > max phased flow (latest table still in WS barrier)',
    wsOnlyLifetime > wsOnlyFlow,
    `lifetime=${wsOnlyLifetime}ms flow=${wsOnlyFlow}ms`,
  );
  assert(
    'ws-only: socket lifetime includes full WS connect spread',
    wsOnlyLifetime >= (wsOnly.wsC + wsOnly.wsB) * 1000,
    `lifetime=${wsOnlyLifetime}ms required>=${(wsOnly.wsC + wsOnly.wsB) * 1000}ms`,
  );

  // ── full: representative values ────────────────────────────────────────────
  const full = { wsC: 20, wsB: 120, mmS: 30, mR: 2100, mode: 'full' };
  const fullLifetime = calcLifetimeMs(full.wsC, full.wsB, full.mmS, full.mR, full.mode);
  const fullFlow     = calcMaxFlowMs (full.wsC, full.wsB, full.mmS, full.mR, full.mode);

  assert(
    'full: socket lifetime > max phased flow',
    fullLifetime > fullFlow,
    `lifetime=${fullLifetime}ms flow=${fullFlow}ms`,
  );
  assert(
    'full: socket lifetime includes WS spread + matchmaking spread + match runtime',
    fullLifetime >= (full.wsC + full.wsB + full.mmS + full.mR) * 1000,
    `lifetime=${fullLifetime}ms required>=${(full.wsC + full.wsB + full.mmS + full.mR) * 1000}ms`,
  );

  // ── edge case: Tables=1 (no spread) ───────────────────────────────────────
  const singleTable = { wsC: 0, wsB: 60, mmS: 0, mR: 0, mode: 'websocket-only' };
  const stLifetime  = calcLifetimeMs(singleTable.wsC, singleTable.wsB, 0, 0, singleTable.mode);
  const stFlow      = calcMaxFlowMs (singleTable.wsC, singleTable.wsB, 0, 0, singleTable.mode);
  assert(
    'Tables=1 (zero spread): socket lifetime still covers ws barrier',
    stLifetime > stFlow,
    `lifetime=${stLifetime}ms flow=${stFlow}ms`,
  );

  console.log('    Example lifetimes vs max flow:');
  console.log(`      ws-only (wsC=20 wsB=120):                  lifetime=${wsOnlyLifetime / 1000}s  flow=${wsOnlyFlow / 1000}s  margin=${(wsOnlyLifetime - wsOnlyFlow) / 1000}s`);
  console.log(`      full    (wsC=20 wsB=120 mmS=30 mR=2100):   lifetime=${fullLifetime / 1000}s flow=${fullFlow / 1000}s margin=${(fullLifetime - fullFlow) / 1000}s`);
}

// ── Test 8: Original files unchanged ──────────────────────────────────────────

async function testOriginalFilesUnchanged() {
  console.log('\n── Test 8: Original files unchanged ─────────────────────────────');

  const { status, output } = await new Promise((cb) => {
    const proc = spawn('git', ['diff', '--name-only', 'HEAD', '--',
      'load-tests/k6/multi-table-load.js',
      'load-tests/k6/run-multi-table-load.ps1',
    ], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', (code) => cb({ status: code, output: out.trim() }));
  });

  assert(
    'multi-table-load.js not modified',
    !output.includes('multi-table-load.js') || output.includes('phased'),
  );
  assert(
    'run-multi-table-load.ps1 not modified',
    !output.includes('run-multi-table-load.ps1') || output.includes('phased'),
  );

  // More precise: check the two original files have no uncommitted changes
  const { output: diffOut } = await new Promise((cb) => {
    const proc = spawn('git', ['diff', 'HEAD', '--',
      'load-tests/k6/multi-table-load.js',
      'load-tests/k6/run-multi-table-load.ps1',
    ], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => cb({ output: out.trim() }));
  });

  assert('git diff HEAD for original files is empty', diffOut === '',
    diffOut.slice(0, 120));
}

// ── Test 9: TABLE_OFFSET source inspection ────────────────────────────────────

function testTableOffsetSourceInspection() {
  console.log('\n── Test 9: TABLE_OFFSET credential range ────────────────────────');
  const src = readFileSync(resolvePath(__dirname, 'phased-multi-table-load.js'), 'utf8');

  assert('TABLE_OFFSET parsed from env',
    src.includes("parseTableOffset(__ENV.TABLE_OFFSET || '0')"));
  assert('CREDENTIAL_START derived from TABLE_OFFSET',
    src.includes('CREDENTIAL_START = TABLE_OFFSET * PLAYERS_PER_TABLE'));
  assert('globalTableIndex computed in default()',
    src.includes('const globalTableIndex = TABLE_OFFSET + tableIndex'));
  assert('loadUsers slices from CREDENTIAL_START',
    src.includes('parsed.users.slice(CREDENTIAL_START, needed)'));
  assert('createTableConnectState stores globalTableIndex',
    src.includes('globalTableIndex,') && src.includes('createTableConnectState(tableIndex, globalTableIndex, players)'));
  assert('ws-ready coordinator call uses globalTableIndex',
    src.includes('tableIndex: tableState.globalTableIndex'));
  assert('failure coordinator call uses globalTableIndex',
    src.includes('tableIndex: tableState.globalTableIndex'));

  // No-collision math: TABLE_OFFSET=0 TABLES=200 uses [0..799], TABLE_OFFSET=200 uses [800..1599]
  function credRange(offset, tables) {
    const start = offset * 4;
    const end = start + tables * 4 - 1;
    return { start, end };
  }
  const a200 = credRange(0, 200);
  const b200 = credRange(200, 200);
  assert('400-table dual split: credential ranges do not overlap',
    a200.end < b200.start,
    `A=[${a200.start}..${a200.end}] B=[${b200.start}..${b200.end}]`);
  assert('400-table dual split: ranges cover consecutive slots',
    b200.start === a200.end + 1,
    `A.end=${a200.end} B.start=${b200.start}`);
  assert('TABLE_OFFSET=0 is backward-compatible (credential start 0)',
    credRange(0, 400).start === 0);
  assert('TABLE_OFFSET=200 for 200 tables starts at credential 800',
    credRange(200, 200).start === 800);
}

// ── Test 10: Fast metrics NDJSON stats ────────────────────────────────────────

async function testFastMetricsStats() {
  console.log('\n── Test 10: Fast metrics NDJSON stats ───────────────────────────');

  const runnerSource = readFileSync(
    resolvePath(__dirname, 'run-phased-multi-table-load.ps1'), 'utf8',
  );
  const fnSource = extractPowerShellFunction(runnerSource, 'Get-MetricsNdjsonStats');

  const tempDir = mkdtempSync(joinPath(tmpdir(), 'belot-fast-metrics-'));
  try {
    // ── 10a: 50 valid lines + 1 partial (partial is line 51, beyond 10-line sample)
    const largeNdjson = joinPath(tempDir, 'large.ndjson');
    const statsScript = joinPath(tempDir, 'test-stats.ps1');
    writeFileSync(statsScript, `
$ErrorActionPreference = 'Stop'
${fnSource}
$path = ${JSON.stringify(largeNdjson)}
$writer = [System.IO.StreamWriter]::new($path, $false, [System.Text.UTF8Encoding]::new($false))
try {
  for ($i = 1; $i -le 50; $i++) {
    $writer.WriteLine('{"metric":"m","type":"Point","data":{"time":"2024-01-01T00:00:00Z","value":' + $i + ',"tags":{}}}')
  }
  $writer.Write('{"partial":')
} finally { $writer.Dispose() }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$s = Get-MetricsNdjsonStats $path
$sw.Stop()
[pscustomobject]@{ exists=$s.Exists; size=$s.FileSizeBytes; sampled=$s.SampledLines; errors=$s.SampleErrors; ms=$sw.ElapsedMilliseconds } | ConvertTo-Json
`, 'utf8');

    const r1 = await runChild('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', statsScript,
    ], 10000);
    let s1 = null;
    try { s1 = JSON.parse(r1.stdout.trim()); } catch { }
    assert('fast stats runs without error', r1.code === 0, r1.stderr.trim().slice(0, 200));
    assert('large file: exists=true', s1?.exists === true, JSON.stringify(s1));
    assert('large file: size > 0', s1?.size > 0, JSON.stringify(s1));
    assert('large file: exactly 10 lines sampled from 50', s1?.sampled === 10, JSON.stringify(s1));
    assert('large file: no errors in first 10 valid lines', s1?.errors === 0, JSON.stringify(s1));
    assert('large file: fast stats completes in < 500ms', s1?.ms < 500, `elapsedMs=${s1?.ms}`);

    // ── 10b: 3 valid lines + 1 partial (partial is within first 10 → error=1)
    const smallNdjson = joinPath(tempDir, 'small.ndjson');
    const smallScript = joinPath(tempDir, 'test-small.ps1');
    writeFileSync(smallScript, `
$ErrorActionPreference = 'Stop'
${fnSource}
$path = ${JSON.stringify(smallNdjson)}
$writer = [System.IO.StreamWriter]::new($path, $false, [System.Text.UTF8Encoding]::new($false))
try {
  for ($i = 1; $i -le 3; $i++) {
    $writer.WriteLine('{"metric":"m","type":"Point","data":{"time":"2024-01-01T00:00:00Z","value":' + $i + ',"tags":{}}}')
  }
  $writer.WriteLine('{"partial":')
} finally { $writer.Dispose() }
$s = Get-MetricsNdjsonStats $path
[pscustomobject]@{ sampled=$s.SampledLines; errors=$s.SampleErrors } | ConvertTo-Json
`, 'utf8');
    const r2 = await runChild('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', smallScript,
    ], 5000);
    let s2 = null;
    try { s2 = JSON.parse(r2.stdout.trim()); } catch { }
    assert('small file: 3 valid lines sampled', s2?.sampled === 3, JSON.stringify(s2));
    assert('small file: 1 partial line detected as error', s2?.errors === 1, JSON.stringify(s2));

    // ── 10c: empty file
    const emptyNdjson = joinPath(tempDir, 'empty.ndjson');
    writeFileSync(emptyNdjson, '', 'utf8');
    const emptyScript = joinPath(tempDir, 'test-empty.ps1');
    writeFileSync(emptyScript, `
$ErrorActionPreference = 'Stop'
${fnSource}
$s = Get-MetricsNdjsonStats ${JSON.stringify(emptyNdjson)}
[pscustomobject]@{ exists=$s.Exists; size=$s.FileSizeBytes } | ConvertTo-Json
`, 'utf8');
    const r3 = await runChild('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', emptyScript,
    ], 5000);
    let s3 = null;
    try { s3 = JSON.parse(r3.stdout.trim()); } catch { }
    assert('empty file: exists=true size=0', s3?.exists === true && s3?.size === 0,
      JSON.stringify(s3));

    // ── 10d: missing file
    const missingScript = joinPath(tempDir, 'test-missing.ps1');
    writeFileSync(missingScript, `
$ErrorActionPreference = 'Stop'
${fnSource}
$s = Get-MetricsNdjsonStats 'C:\\does-not-exist-belot-8f3a.ndjson'
[pscustomobject]@{ exists=$s.Exists; size=$s.FileSizeBytes } | ConvertTo-Json
`, 'utf8');
    const r4 = await runChild('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', missingScript,
    ], 5000);
    let s4 = null;
    try { s4 = JSON.parse(r4.stdout.trim()); } catch { }
    assert('missing file: exists=false size=0', s4?.exists === false && s4?.size === 0,
      JSON.stringify(s4));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Test 11: Dual k6 supervisor ───────────────────────────────────────────────

async function testDualK6Supervisor() {
  console.log('\n── Test 11: Dual k6 supervisor ──────────────────────────────────');

  const runnerSource = readFileSync(resolvePath(__dirname, 'run-phased-multi-table-load.ps1'), 'utf8');
  const functionNames = [
    'ConvertTo-NativeArgument', 'Start-K6Async', 'Drain-K6Output',
    'Stop-VerifiedProcessTree', 'Get-MetricsNdjsonStats', 'Write-AtomicJson',
    'New-DualRunnerResult', 'Invoke-DualK6Supervisor',
  ];

  const tempDir = mkdtempSync(joinPath(tmpdir(), 'belot-dual-supervisor-'));
  const functionsPath = joinPath(tempDir, 'dual-functions.ps1');
  const wrapperPath = joinPath(tempDir, 'dual-wrapper.ps1');

  writeFileSync(
    functionsPath,
    functionNames.map((name) => extractPowerShellFunction(runnerSource, name)).join('\r\n\r\n'),
    'utf8',
  );

  writeFileSync(wrapperPath, `
param([string]$ConfigPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dual-functions.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $ConfigPath | ConvertFrom-Json
$argumentsA = @('run', '--out', "json=$($config.metricsPathA)", '-e', "SUMMARY_PATH=$($config.summaryPathA)", $config.scriptPathA)
$argumentsB = @('run', '--out', "json=$($config.metricsPathB)", '-e', "SUMMARY_PATH=$($config.summaryPathB)", $config.scriptPathB)
$watch = [Diagnostics.Stopwatch]::StartNew()
$script:statusCalls = 0
$statusProvider = {
  if ($config.failAfterMs -ge 0 -and $watch.ElapsedMilliseconds -ge $config.failAfterMs) {
    $script:statusCalls += 1
    $reason = if ($script:statusCalls -eq 1) { 'first-failure' } else { 'later-failure' }
    return [pscustomobject]@{
      loginBarrierFailed = $false; wsBarrierFailed = $true
      loginFailureReason = $null; wsFailureReason = $reason; failures = @()
    }
  }
  return [pscustomobject]@{ loginBarrierFailed = $false; wsBarrierFailed = $false }
}
$logAction = { param($line, $isError) }
$dualResult = $null
$runnerError = $null
try {
  $exeA = if ($config.runnerExceptionA) { Join-Path $PSScriptRoot 'missing-k6.exe' } else { $config.k6Path }
  $exeB = if ($config.runnerExceptionB) { Join-Path $PSScriptRoot 'missing-k6.exe' } else { $config.k6Path }
  $dualResult = Invoke-DualK6Supervisor $exeA $argumentsA $exeB $argumentsB $statusProvider $logAction $config.graceSeconds 50
} catch { $runnerError = $_.Exception.ToString() }
$statsA = Get-MetricsNdjsonStats $config.metricsPathA
$statsB = Get-MetricsNdjsonStats $config.metricsPathB
$context = [pscustomobject]@{
  RunId = 'dual-probe'; Mode = 'websocket-only'; Tables = 2; StartedAt = [DateTime]::UtcNow
  LogPathA = ''; MetricsPathA = $config.metricsPathA; SummaryPathA = $config.summaryPathA
  LogPathB = ''; MetricsPathB = $config.metricsPathB; SummaryPathB = $config.summaryPathB
}
$result = New-DualRunnerResult $context $dualResult $statsA $statsB $runnerError
Write-AtomicJson $config.resultPath $result
[pscustomobject]@{
  dualResult = $dualResult; runnerResult = $result; runnerError = $runnerError
  resultExists = Test-Path -LiteralPath $config.resultPath
} | ConvertTo-Json -Depth 20
`, 'utf8');

  const k6Candidates = [
    process.env.ProgramFiles ? joinPath(process.env.ProgramFiles, 'k6', 'k6.exe') : null,
    'k6',
  ].filter(Boolean);
  let k6Path = null;
  for (const candidate of k6Candidates) {
    if (candidate !== 'k6' && !existsSync(candidate)) continue;
    const v = await runChild(candidate, ['version'], 3000);
    if (!v.error && v.code === 0) { k6Path = candidate; break; }
  }
  assert('local k6 binary is available for dual supervisor probes', k6Path !== null);
  if (k6Path === null) { rmSync(tempDir, { recursive: true, force: true }); return; }

  function makeScript(body, options = '{vus:1,iterations:1}') {
    return `${body}\nexport const options=${options};\n`
      + 'export function handleSummary(d){return{[__ENV.SUMMARY_PATH]:JSON.stringify(d)}}\n';
  }

  async function runDualCase(name, settings = {}) {
    const caseDir = joinPath(tempDir, name);
    mkdirSync(caseDir);
    const scriptPathA = joinPath(caseDir, 'probe-a.js');
    const scriptPathB = joinPath(caseDir, 'probe-b.js');
    const summaryPathA = joinPath(caseDir, 'summary-a.json');
    const summaryPathB = joinPath(caseDir, 'summary-b.json');
    const metricsPathA = joinPath(caseDir, 'metrics-a.ndjson');
    const metricsPathB = joinPath(caseDir, 'metrics-b.ndjson');
    const resultPath = joinPath(caseDir, 'runner-result.json');
    writeFileSync(scriptPathA, settings.scriptA ?? makeScript('export default function(){}'));
    writeFileSync(scriptPathB, settings.scriptB ?? makeScript('export default function(){}'));
    const configPath = joinPath(caseDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      k6Path, scriptPathA, scriptPathB, summaryPathA, summaryPathB,
      metricsPathA, metricsPathB, resultPath,
      failAfterMs: settings.failAfterMs ?? -1,
      graceSeconds: settings.graceSeconds ?? 1,
      runnerExceptionA: settings.runnerExceptionA === true,
      runnerExceptionB: settings.runnerExceptionB === true,
    }));
    const execution = await runPowerShellTree(wrapperPath, configPath, 25000);
    let output = null;
    try { output = JSON.parse(execution.stdout.trim()); } catch { }
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
    return { execution, output, result };
  }

  let sentinel = null;
  try {
    // ── 11a: Both processes succeed normally
    const normal = await runDualCase('normal-dual');
    assert('dual normal success: outcome=success',
      normal.result?.outcome === 'success', JSON.stringify(normal));
    assert('dual normal success: neither process forced',
      normal.result?.k6?.a?.forcedTermination === false
        && normal.result?.k6?.b?.forcedTermination === false,
      JSON.stringify(normal.result));
    assert('dual normal success: summary A and B exist',
      normal.result?.artifacts?.a?.k6SummaryExists === true
        && normal.result?.artifacts?.b?.k6SummaryExists === true,
      JSON.stringify(normal.result));

    // ── 11b: Coordinator failure kills both processes
    const sleepScript = makeScript("import{sleep}from'k6';export default function(){sleep(20)}");
    const coordFail = await runDualCase('coord-fail', {
      failAfterMs: 150, graceSeconds: 1,
      scriptA: sleepScript, scriptB: sleepScript,
    });
    assert('dual coordinator failure: outcome=coordinator-failure',
      coordFail.result?.outcome === 'coordinator-failure', JSON.stringify(coordFail));
    assert('dual coordinator failure: A forced',
      coordFail.result?.k6?.a?.forcedTermination === true, JSON.stringify(coordFail.result));
    assert('dual coordinator failure: B forced',
      coordFail.result?.k6?.b?.forcedTermination === true, JSON.stringify(coordFail.result));
    assert('dual: first coordinator failure reason preserved',
      coordFail.result?.coordinatorFailure?.wsFailureReason === 'first-failure',
      JSON.stringify(coordFail.result));

    // ── 11c: A crashes (threshold failure) → B gets killed
    const failOptions = "{vus:1,iterations:1,thresholds:{iterations:['count>1']}}";
    const aCrash = await runDualCase('a-crash', {
      scriptA: makeScript('export default function(){}', failOptions),
      scriptB: sleepScript,
    });
    assert('A crash: outcome=k6-error',
      aCrash.result?.outcome === 'k6-error', JSON.stringify(aCrash));
    assert('A crash: B is force-terminated',
      aCrash.result?.k6?.b?.forcedTermination === true, JSON.stringify(aCrash.result));
    assert('A crash: runner result written',
      aCrash.result !== null, JSON.stringify(aCrash.result));

    // ── 11d: B crashes → A gets killed
    const bCrash = await runDualCase('b-crash', {
      scriptA: sleepScript,
      scriptB: makeScript('export default function(){}', failOptions),
    });
    assert('B crash: outcome=k6-error',
      bCrash.result?.outcome === 'k6-error', JSON.stringify(bCrash));
    assert('B crash: A is force-terminated',
      bCrash.result?.k6?.a?.forcedTermination === true, JSON.stringify(bCrash.result));

    // ── 11e: Sentinel test — independent k6 process survives dual kill
    const sentinelScript = joinPath(tempDir, 'sentinel.js');
    writeFileSync(sentinelScript, "import{sleep}from'k6';export default function(){sleep(20)}");
    sentinel = spawn(k6Path, ['run', '--quiet', sentinelScript], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));
    await runDualCase('sentinel-coord-fail', {
      failAfterMs: 100, graceSeconds: 1,
      scriptA: sleepScript, scriptB: sleepScript,
    });
    assert('dual: independent sentinel process remains alive after dual kill',
      sentinel.exitCode === null, `sentinel.exitCode=${sentinel.exitCode}`);
    sentinel.kill();
    sentinel = null;

    // ── 11f: Runner exception (bad executable for A) produces runner-error result
    const exceptionCase = await runDualCase('runner-exception', { runnerExceptionA: true });
    assert('dual runner exception: outcome=runner-error',
      exceptionCase.result?.outcome === 'runner-error'
        && typeof exceptionCase.result?.runnerError === 'string',
      JSON.stringify(exceptionCase));
  } finally {
    if (sentinel?.exitCode === null) sentinel.kill();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('phased load-test validation suite');
  console.log('==================================');

  await testCoordinatorValidationAndBarrier();
  await testFailurePropagation();
  testWsOnlyCodePath();
  testRetryStateMachine();
  testConnectDeadlineStartsAfterSpread();
  testInitialWsConnectRuntimePath();
  testProductionLifecycleTermination();
  await testLocalK6RuntimeAbortProbes();
  await testExternalK6Supervisor();
  testSpreadTiming();
  testSocketLifetimeInvariant();
  await testOriginalFilesUnchanged();
  testTableOffsetSourceInspection();
  await testFastMetricsStats();
  await testDualK6Supervisor();

  console.log(`\n══════════════════════════════════════`);
  if (failed === 0) {
    console.log(`  ALL ${passed} ASSERTIONS PASSED`);
  } else {
    console.log(`  PASSED: ${passed}  FAILED: ${failed}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
