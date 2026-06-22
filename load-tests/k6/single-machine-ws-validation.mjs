import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsPath = join(here, 'single-machine-ws-load.js');
const runnerPath = join(here, 'run-single-machine-ws-load.ps1');
const js = readFileSync(jsPath, 'utf8');
const runner = readFileSync(runnerPath, 'utf8');
let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Function ${name} not found`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (quote !== null) {
      if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Function ${name} is incomplete`);
}

function sourceChecks() {
  assert('setup returns only common absolute times',
    js.includes('loginStartAtMs: createdAtMs')
      && js.includes('readinessDeadlineAtMs')
      && js.includes('releaseAtMs')
      && !js.includes('sessions,'));
  assert('each table VU logs its own four credentials',
    js.includes('login(USERS[userIndex], userIndex, jar)')
      && js.includes('const PLAYERS_PER_TABLE = 4')
      && js.includes("executor: 'per-vu-iterations'"));
  assert('login spread precedes the common WS start',
    js.includes('LOGIN_SPREAD_SECONDS')
      && js.includes('loginOffsetMs')
      && js.includes('login phase missed the common WS start'));
  assert('ready table waits for deadline and release instead of immediate cleanup',
    !extractFunction(js, 'markReady').includes('beginCleanup(')
      && extractFunction(js, 'readinessDeadlineReached').includes('scheduleRelease(table)')
      && extractFunction(js, 'releaseTable').includes('beginCleanup(table, null)'));
  assert('attempt timeout callback owns its exact handle',
    js.includes('if (attempt.timeoutId !== timeoutId) return;')
      && js.includes('if (player.attemptTimeoutId === timeoutId)'));
  assert('full readiness and cleanup thresholds are present',
    ['login_attempts', 'login_ready_players', 'login_ready_tables', 'ws_cleanup_completed']
      .every((name) => new RegExp(`${name}: \\[`).test(js)));
  assert('failure thresholds include retry exhaustion and terminal failures',
    js.includes("ws_retry_exhausted: ['count==0']")
      && js.includes("ws_terminal_failures: ['count==0']"));
  assert('JavaScript and runner require explicit target URLs',
    js.includes("requireEnv('BASE_URL')") && js.includes("requireEnv('WS_URL')")
      && runner.includes('[Parameter(Mandatory = $true)][string]$BaseUrl')
      && runner.includes('[Parameter(Mandatory = $true)][string]$WsUrl'));
  assert('production defaults and port 3001 are absent',
    !js.includes('pika.bg') && !runner.includes('pika.bg')
      && !js.includes('3001') && !runner.includes('3001'));
  assert('coordinator and distributed dependencies are absent',
    !/coordinator|RUN_ID|TOKEN|heartbeat|matchmaking|ssh|tunnel/i.test(js + runner));
  assert('runner exposes login spread and hold parameters',
    runner.includes('[int]$LoginSpreadSeconds') && runner.includes('[int]$WsHoldSeconds')
      && runner.includes('LOGIN_SPREAD_SECONDS=') && runner.includes('WS_HOLD_SECONDS='));
  assert('runner uses Process.ExitCode for normal completion',
    runner.includes('$process.ExitCode') && !runner.includes('$LASTEXITCODE'));
  assert('runner drains both native streams live without ReadToEndAsync',
    runner.includes('StandardOutput.ReadLineAsync()')
      && runner.includes('StandardError.ReadLineAsync()')
      && !runner.includes('ReadToEndAsync'));
  assert('runner has an external process-tree hard watchdog',
    runner.includes('$hardTimeoutSeconds =')
      && runner.includes('Stop-ProcessTree $process')
      && runner.includes('$watchdogExitCode = 124'));
  assert('runner requests uncolored UTF-8 native output',
    runner.includes("'--no-color'")
      && runner.includes('$psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)'));
  assert('runner enables timestamped incremental k6 JSON output',
    runner.includes("'--out', \"json=$metricsPath\"")
      && runner.includes('$fileBase-metrics.jsonl'));
  assert('runner tails metrics by byte offset every five seconds',
    runner.includes('function Read-IncrementalMetrics')
      && runner.includes('$State.Offset += $totalRead')
      && runner.includes('$nextProgressAtSeconds += 5.0'));
  assert('runner writes progress and final normal/partial summaries',
    runner.includes("return ('PROGRESS elapsed=")
      && runner.includes('$fileBase-runner-summary.json')
      && runner.includes('$fileBase-partial-summary.json'));
  assert('metric parser failures cannot overwrite the process exit code',
    runner.includes('try { Read-IncrementalMetrics $metricsState $metricsPath -Final } catch { }')
      && runner.indexOf('$k6ExitCode = if ($watchdogTriggered)')
        < runner.indexOf('Read-IncrementalMetrics $metricsState $metricsPath -Final'));
}

class Scheduler {
  constructor() { this.now = 0; this.nextId = 1; this.tasks = new Map(); }
  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id;
  }
  setInterval(callback, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delay, callback, interval: delay });
    return id;
  }
  clearTimeout(id) { this.tasks.delete(id); }
  clearInterval(id) { this.tasks.delete(id); }
  callback(id) { return this.tasks.get(id)?.callback; }
  advance(ms) {
    const end = this.now + ms;
    while (true) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= end)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) break;
      const [id, task] = due[0];
      if (task.interval === undefined) this.tasks.delete(id);
      else this.tasks.set(id, { ...task, at: task.at + task.interval });
      this.now = task.at;
      task.callback();
    }
    this.now = end;
  }
}

const lifecycleFunctionNames = [
  'createPlayer', 'createTable', 'connectPlayer', 'markReady', 'failAttempt',
  'scheduleDeadline', 'readinessDeadlineReached', 'scheduleRelease', 'releaseTable',
  'deadlineFailure', 'terminalFailure', 'beginCleanup', 'closeAttempt',
  'finalizeAttempt', 'maybeFinishCleanup', 'clearAttemptTimeout', 'startAttemptPing',
  'clearAttemptPing', 'clearAttemptTimers', 'clearPlayerTimers', 'diagnosticLine',
  'isCurrent', 'parseJson', 'messageOf',
];

function createLifecycleHarness(config = {}) {
  const scheduler = new Scheduler();
  const sockets = [];
  const counts = {};
  const metric = (name) => ({ add: (value) => { counts[name] = (counts[name] || 0) + value; } });
  class FakeSocket {
    constructor() {
      this.readyState = 0;
      this.listeners = {};
      this.closeCalls = 0;
      this.sent = [];
      this.throwOnSend = false;
      this.closeHangs = false;
      sockets.push(this);
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    emit(name, event = {}) { if (this.listeners[name]) this.listeners[name](event); }
    open() { this.readyState = 1; this.emit('open'); }
    connected() { this.emit('message', { data: JSON.stringify({ type: 'connected' }) }); }
    error() { this.emit('error'); }
    send(value) {
      if (this.throwOnSend) throw new Error('fake send failure');
      this.sent.push(value);
    }
    close() {
      this.closeCalls += 1;
      if (this.closeHangs) return;
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', { code: 1000 });
    }
  }
  function WebSocket() { return new FakeSocket(); }
  const aborts = [];
  const diagnostics = [];
  const dependencies = {
    Date: { now: () => scheduler.now },
    setTimeout: scheduler.setTimeout.bind(scheduler),
    clearTimeout: scheduler.clearTimeout.bind(scheduler),
    setInterval: scheduler.setInterval.bind(scheduler),
    clearInterval: scheduler.clearInterval.bind(scheduler),
    WebSocket,
    WS_URL: 'ws://127.0.0.1:3101/ws',
    BASE_URL: 'http://127.0.0.1:3101',
    WS_ATTEMPT_TIMEOUT_SECONDS: config.attemptTimeoutSeconds ?? 0.1,
    WS_MAX_ATTEMPTS: config.maxAttempts ?? 3,
    WS_RETRY_BASE_DELAY_MS: config.retryBaseMs ?? 5,
    WS_RETRY_MAX_DELAY_MS: config.retryMaxMs ?? 20,
    CLEANUP_TIMEOUT_MS: config.cleanupTimeoutMs ?? 50,
    PING_INTERVAL_MS: config.pingIntervalMs ?? 20,
    WS_CLOSED: 3,
    exec: { test: { abort: (reason) => aborts.push(String(reason)) } },
    console: { error: (line) => diagnostics.push(String(line)) },
    wsAttempts: metric('wsAttempts'),
    wsRetries: metric('wsRetries'),
    wsAttemptTimeouts: metric('wsAttemptTimeouts'),
    wsFirstAttemptFailures: metric('wsFirstAttemptFailures'),
    wsRetryExhausted: metric('wsRetryExhausted'),
    wsRecoveredAfterRetry: metric('wsRecoveredAfterRetry'),
    wsReadyPlayers: metric('wsReadyPlayers'),
    wsReadyTables: metric('wsReadyTables'),
    wsDeadlinesExceeded: metric('wsDeadlinesExceeded'),
    wsTerminalFailures: metric('wsTerminalFailures'),
    wsCleanupStarted: metric('wsCleanupStarted'),
    wsCleanupCompleted: metric('wsCleanupCompleted'),
    wsCleanupFailures: metric('wsCleanupFailures'),
  };
  const names = Object.keys(dependencies);
  const productionFunctions = lifecycleFunctionNames.map((name) => extractFunction(js, name)).join('\n');
  const lifecycle = new Function(
    ...names,
    `${productionFunctions}\nreturn { ${lifecycleFunctionNames.join(', ')} };`,
  )(...names.map((name) => dependencies[name]));
  const players = Array.from({ length: 4 }, (_, index) => (
    lifecycle.createPlayer(index, index, { id: index })
  ));
  const deadlineAtMs = config.deadlineAtMs ?? 100;
  const releaseAtMs = config.releaseAtMs ?? 130;
  const table = lifecycle.createTable(0, players, deadlineAtMs, releaseAtMs);
  return { scheduler, sockets, counts, aborts, diagnostics, lifecycle, players, table };
}

function connectAll(harness) {
  harness.lifecycle.scheduleDeadline(harness.table);
  for (const player of harness.players) harness.lifecycle.connectPlayer(harness.table, player);
  for (const socket of harness.sockets) { socket.open(); socket.connected(); }
}

function lifecycleChecks() {
  const ping = createLifecycleHarness();
  ping.lifecycle.scheduleDeadline(ping.table);
  ping.lifecycle.connectPlayer(ping.table, ping.players[0]);
  ping.sockets[0].open();
  ping.scheduler.advance(20);
  assert('ping does not start before application connected readiness',
    ping.players[0].pingTimerId === null && ping.sockets[0].sent.length === 0);
  ping.sockets[0].connected();
  const firstPingHandle = ping.players[0].pingTimerId;
  ping.sockets[0].emit('message', { data: JSON.stringify({ type: 'pong' }) });
  assert('pong has no readiness or timer side effects',
    ping.players[0].ready && ping.players[0].pingTimerId === firstPingHandle);
  ping.scheduler.advance(20);
  assert('ready socket sends application ping every interval',
    ping.sockets[0].sent.length === 1
      && ping.sockets[0].sent[0] === JSON.stringify({ type: 'ping' }));

  const oldAttempt = [...ping.table.attempts][0];
  ping.sockets[0].error();
  assert('attempt failure clears its ping timer before retry',
    oldAttempt.pingTimerId === null && ping.players[0].pingTimerId === null);
  ping.scheduler.advance(5);
  ping.sockets[1].open();
  ping.sockets[1].connected();
  const newPingHandle = ping.players[0].pingTimerId;
  ping.lifecycle.clearAttemptPing(oldAttempt);
  assert('stale generation cannot clear the new ping timer',
    newPingHandle !== null && newPingHandle !== firstPingHandle
      && ping.players[0].pingTimerId === newPingHandle);
  ping.lifecycle.beginCleanup(ping.table, null);
  assert('normal cleanup clears every ping timer',
    ping.players.every((player) => player.pingTimerId === null)
      && ping.table.cleanupComplete && ping.scheduler.tasks.size === 0);

  const sendFailure = createLifecycleHarness();
  sendFailure.lifecycle.scheduleDeadline(sendFailure.table);
  sendFailure.lifecycle.connectPlayer(sendFailure.table, sendFailure.players[0]);
  sendFailure.sockets[0].open();
  sendFailure.sockets[0].connected();
  sendFailure.sockets[0].throwOnSend = true;
  sendFailure.scheduler.advance(20);
  assert('ping send exception uses normal attempt failure and retry path',
    !sendFailure.players[0].ready && sendFailure.players[0].pingTimerId === null
      && sendFailure.players[0].retryTimerId !== null);
  sendFailure.lifecycle.beginCleanup(sendFailure.table, null);

  const hold = createLifecycleHarness();
  connectAll(hold);
  assert('four ready sockets do not close immediately',
    hold.table.readyCounted && !hold.table.cleanupStarted
      && hold.table.attempts.size === 4 && hold.sockets.every((socket) => socket.closeCalls === 0));
  hold.scheduler.advance(100);
  assert('ready table remains connected at the common readiness deadline',
    !hold.table.cleanupStarted && hold.table.attempts.size === 4);
  hold.scheduler.advance(29);
  assert('ready table remains connected throughout the hold period',
    !hold.table.cleanupStarted && hold.sockets.every((socket) => socket.readyState === 1));
  hold.scheduler.advance(1);
  assert('common release closes all sockets cleanly',
    hold.table.cleanupComplete && hold.table.attempts.size === 0
      && hold.sockets.every((socket) => socket.closeCalls === 1)
      && hold.counts.wsCleanupCompleted === 1 && hold.aborts.length === 0
      && hold.diagnostics.length === 0);

  const ownership = createLifecycleHarness();
  ownership.lifecycle.scheduleDeadline(ownership.table);
  ownership.lifecycle.connectPlayer(ownership.table, ownership.players[0]);
  const firstHandle = ownership.players[0].attemptTimeoutId;
  const staleCallback = ownership.scheduler.callback(firstHandle);
  ownership.sockets[0].error();
  ownership.scheduler.advance(5);
  const newHandle = ownership.players[0].attemptTimeoutId;
  staleCallback();
  assert('stale attempt timeout cannot clear the new attempt handle',
    newHandle !== null && newHandle !== firstHandle
      && ownership.players[0].attemptTimeoutId === newHandle);
  ownership.lifecycle.beginCleanup(ownership.table, null);

  const timeout = createLifecycleHarness({ attemptTimeoutSeconds: 0.02 });
  timeout.lifecycle.scheduleDeadline(timeout.table);
  timeout.lifecycle.connectPlayer(timeout.table, timeout.players[0]);
  timeout.scheduler.advance(20);
  assert('real attempt timeout function closes and schedules retry',
    timeout.counts.wsAttemptTimeouts === 1 && timeout.table.attempts.size === 0);
  timeout.scheduler.advance(5);
  assert('real retry function creates the next generation',
    timeout.players[0].attempts === 2 && timeout.counts.wsRetries === 1);
  timeout.lifecycle.beginCleanup(timeout.table, null);

  const deadline = createLifecycleHarness();
  deadline.lifecycle.scheduleDeadline(deadline.table);
  for (let index = 0; index < 3; index += 1) {
    deadline.lifecycle.connectPlayer(deadline.table, deadline.players[index]);
    deadline.sockets[index].open();
    deadline.sockets[index].connected();
  }
  deadline.scheduler.advance(100);
  assert('not-ready table fails at the absolute readiness deadline',
    deadline.counts.wsDeadlinesExceeded === 1
      && deadline.counts.wsTerminalFailures === 1 && deadline.aborts.length === 1);
  assert('deadline failure cleans all real lifecycle resources',
    deadline.table.cleanupComplete && deadline.table.attempts.size === 0
      && deadline.scheduler.tasks.size === 0);

  const exhausted = createLifecycleHarness({ maxAttempts: 1 });
  exhausted.lifecycle.scheduleDeadline(exhausted.table);
  exhausted.lifecycle.connectPlayer(exhausted.table, exhausted.players[0]);
  exhausted.sockets[0].error();
  assert('retry exhaustion is terminal in production lifecycle functions',
    exhausted.counts.wsRetryExhausted === 1
      && exhausted.counts.wsTerminalFailures === 1 && exhausted.aborts.length === 1);
  assert('terminal diagnostic contains bounded state without secrets',
    exhausted.diagnostics.length === 1
      && /table=0 player=0 attempts=1 generation=1 readyPlayers=0\/4 activeAttempts=0/.test(
        exhausted.diagnostics[0],
      )
      && !/password|cookie|session/i.test(exhausted.diagnostics[0]));

  const cleanupTimeout = createLifecycleHarness({ maxAttempts: 1 });
  cleanupTimeout.lifecycle.scheduleDeadline(cleanupTimeout.table);
  cleanupTimeout.lifecycle.connectPlayer(cleanupTimeout.table, cleanupTimeout.players[0]);
  cleanupTimeout.sockets[0].closeHangs = true;
  cleanupTimeout.sockets[0].error();
  cleanupTimeout.scheduler.advance(50);
  assert('cleanup timeout emits focused diagnostic and aborts',
    cleanupTimeout.counts.wsCleanupFailures === 1 && cleanupTimeout.aborts.length === 1
      && cleanupTimeout.diagnostics.some((line) => (
        line.includes('[cleanup timeout] table=0 player=0 attempts=1 generation=2')
          && line.includes('activeAttempts=1')
      )));
}

function executableContractChecks() {
  const validateTargetPair = new Function(
    `return (${extractFunction(js, 'validateTargetPair')});`,
  )();
  let rejected = false;
  try { validateTargetPair('https://www.pika.bg', 'wss://www.pika.bg/ws'); } catch (_) { rejected = true; }
  assert('JavaScript production endpoint guard executes fail-closed', rejected);
  let accepted = true;
  try { validateTargetPair('http://185.203.117.14:3101', 'ws://185.203.117.14:3101/ws'); }
  catch (_) { accepted = false; }
  assert('JavaScript accepts the explicit load-test endpoint pair', accepted);

  const loadUsersSource = extractFunction(js, 'loadUsers');
  const loadUsers = (tables, users) => new Function(
    'TABLES', 'PLAYERS_PER_TABLE', 'open', 'parseJson',
    `${loadUsersSource}; return loadUsers();`,
  )(tables, 4, () => JSON.stringify({ users }), JSON.parse);
  const user = (index) => ({ email: `user${index}@example.test`, password: 'secret' });
  let tooFewRejected = false;
  try { loadUsers(2, Array.from({ length: 7 }, (_, index) => user(index))); } catch (_) {
    tooFewRejected = true;
  }
  assert('too few credentials are rejected by the real loader', tooFewRejected);
  assert('real loader selects exactly Tables x 4 credentials',
    loadUsers(2, Array.from({ length: 12 }, (_, index) => user(index))).length === 8);
}

function runPowerShell(args, options = {}) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    ...options,
  });
}

async function fakeK6RunnerChecks() {
  const temp = mkdtempSync(join(tmpdir(), 'belot-single-machine-runner-'));
  try {
    const tempRunner = join(temp, 'run-single-machine-ws-load.ps1');
    copyFileSync(runnerPath, tempRunner);
    writeFileSync(join(temp, 'single-machine-ws-load.js'), '// fake k6 input\n', 'utf8');
    writeFileSync(join(temp, 'loadtest-users.json.local'), JSON.stringify({ users: [0, 1, 2, 3].map(
      (index) => ({ email: `fake${index}@example.test`, password: 'secret' }),
    ) }), 'utf8');
    const marker = join(temp, 'invoked.txt');
    writeFileSync(join(temp, 'fake-k6.mjs'), `
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex < 0 || !args[outIndex + 1]?.startsWith('json=')) process.exit(91);
const metricsPath = args[outIndex + 1].slice(5);
const point = (metric, value) => JSON.stringify({
  type: 'Point', metric, data: { time: new Date().toISOString(), value, tags: {} },
});
const append = (samples) => appendFileSync(metricsPath, samples.map(
  ([metric, value]) => point(metric, value),
).join('\\n') + '\\n', 'utf8');
writeFileSync(${JSON.stringify(marker)}, 'invoked\\n', { flag: 'a' });
console.log('EARLY_STDOUT');
console.error('EARLY_STDERR');
console.log('КИРИЛИЦА');
append([
  ['login_attempts', 2], ['login_ready_players', 2], ['ws_attempts', 3], ['ws_retries', 1],
]);
await new Promise((resolve) => setTimeout(resolve, 250));
if (process.env.FAKE_K6_MODE === 'hang') {
  append([['ws_ready_players', 1], ['ws_terminal_failures', 0]]);
  appendFileSync(metricsPath, '{"type":"Point","metric":"ws_attempts"', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 60000));
} else {
  append([
    ['login_attempts', 2], ['login_failures', 0], ['login_ready_players', 2],
    ['login_ready_tables', 1], ['ws_attempts', 2], ['ws_retry_exhausted', 0],
    ['ws_ready_players', 4], ['ws_ready_tables', 1], ['ws_deadlines_exceeded', 0],
    ['ws_terminal_failures', 0], ['ws_cleanup_completed', 1], ['ws_cleanup_failures', 0],
  ]);
  appendFileSync(metricsPath, '{"type":"Point","metric":"ws_attempts"', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 650));
  console.log('LATE_STDOUT');
  process.exitCode = 37;
}
`, 'utf8');
    writeFileSync(join(temp, 'k6.cmd'), [
      '@echo off',
      'node "%~dp0fake-k6.mjs" %*',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'), 'utf8');
    const env = { ...process.env, PATH: `${temp};${process.env.PATH}` };
    const normalResults = join(temp, 'normal-results');
    const hangResults = join(temp, 'hang-results');
    mkdirSync(normalResults);
    mkdirSync(hangResults);
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempRunner,
      '-BaseUrl', 'http://127.0.0.1:3101', '-WsUrl', 'ws://127.0.0.1:3101/ws',
      '-Tables', '1', '-LoginSpreadSeconds', '0', '-WsStartDelaySeconds', '2',
      '-WsAttemptTimeoutSeconds', '1', '-WsDeadlineSeconds', '2', '-WsHoldSeconds', '1',
      '-CleanupTimeoutMs', '100', '-HardTimeoutGraceSeconds', '1',
      '-ResultsDirectory', normalResults,
    ];
    const child = spawn('powershell.exe', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let consoleOutput = '';
    let exited = false;
    let consoleObservedBeforeExit = false;
    let logObservedBeforeExit = false;
    const observeConsole = (chunk) => {
      consoleOutput += chunk.toString('utf8');
      if (!exited && consoleOutput.includes('EARLY_STDOUT') && consoleOutput.includes('EARLY_STDERR')) {
        consoleObservedBeforeExit = true;
      }
    };
    child.stdout.on('data', observeConsole);
    child.stderr.on('data', observeConsole);
    const observer = setInterval(() => {
      const logName = readdirSync(normalResults).find((name) => name.endsWith('.log'));
      if (!exited && logName) {
        const content = readFileSync(join(normalResults, logName), 'utf8');
        if (content.includes('EARLY_STDOUT') && content.includes('EARLY_STDERR')) {
          logObservedBeforeExit = true;
        }
      }
    }, 25);
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => { exited = true; resolve(code); });
    });
    clearInterval(observer);
    const logName = readdirSync(normalResults).find((name) => name.endsWith('.log'));
    const log = logName ? readFileSync(join(normalResults, logName), 'utf8') : '';
    const normalMetricsName = readdirSync(normalResults).find((name) => name.endsWith('-metrics.jsonl'));
    const normalSummaryName = readdirSync(normalResults).find(
      (name) => name.endsWith('-runner-summary.json'),
    );
    const normalSummary = normalSummaryName
      ? JSON.parse(readFileSync(join(normalResults, normalSummaryName), 'utf8')) : null;
    assert('fake-k6 stdout and stderr appear on the console before process exit',
      consoleObservedBeforeExit);
    assert('fake-k6 stdout and stderr are logged before process exit', logObservedBeforeExit);
    assert('fake-k6 stdout and stderr remain in the UTF-8 log',
      log.includes('EARLY_STDOUT') && log.includes('EARLY_STDERR'));
    assert('native UTF-8 Cyrillic is decoded without mojibake', log.includes('КИРИЛИЦА'));
    assert('runner returns the real non-zero fake-k6 exit code', exitCode === 37,
      `code=${exitCode}, output=${consoleOutput.slice(-500)}, log=${log.slice(-500)}`);
    assert('normal exit retains incremental metrics and writes runner summary',
      Boolean(normalMetricsName) && normalSummary?.status === 'normal'
        && normalSummary?.exitCode === 37 && normalSummary?.metricsFileFound === true
        && normalSummary?.metricsReadSucceeded === true);
    assert('normal runner summary contains accumulated metric counts',
      normalSummary?.metrics?.login_attempts === 4
        && normalSummary?.metrics?.login_ready_players === 4
        && normalSummary?.metrics?.login_ready_tables === 1
        && normalSummary?.metrics?.ws_attempts === 5
        && normalSummary?.metrics?.ws_retries === 1
        && normalSummary?.metrics?.ws_ready_players === 4
        && normalSummary?.metrics?.ws_ready_tables === 1
        && normalSummary?.metrics?.ws_cleanup_completed === 1);
    assert('normal final partial JSONL row is skipped and counted safely',
      normalSummary?.partialJsonLines === 1 && normalSummary?.invalidJsonLines === 0);

    const hangArgs = args.slice();
    hangArgs[hangArgs.length - 1] = hangResults;
    const hangEnv = { ...env, FAKE_K6_MODE: 'hang' };
    const hangStartedAt = Date.now();
    const hanging = spawn('powershell.exe', hangArgs, {
      env: hangEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let hangOutput = '';
    hanging.stdout.on('data', (chunk) => { hangOutput += chunk.toString('utf8'); });
    hanging.stderr.on('data', (chunk) => { hangOutput += chunk.toString('utf8'); });
    const hangExitCode = await new Promise((resolve, reject) => {
      const safety = setTimeout(() => {
        hanging.kill();
        reject(new Error('runner hard-watchdog E2E exceeded 15 seconds'));
      }, 15000);
      hanging.once('error', (error) => { clearTimeout(safety); reject(error); });
      hanging.once('exit', (code) => { clearTimeout(safety); resolve(code); });
    });
    const hangElapsedMs = Date.now() - hangStartedAt;
    const hangLogName = readdirSync(hangResults).find((name) => name.endsWith('.log'));
    const hangLog = hangLogName ? readFileSync(join(hangResults, hangLogName), 'utf8') : '';
    const hangMetricsName = readdirSync(hangResults).find((name) => name.endsWith('-metrics.jsonl'));
    const partialSummaryName = readdirSync(hangResults).find(
      (name) => name.endsWith('-partial-summary.json'),
    );
    const partialSummary = partialSummaryName
      ? JSON.parse(readFileSync(join(hangResults, partialSummaryName), 'utf8')) : null;
    assert('hard watchdog kills intentionally hanging fake-k6 process tree',
      hangExitCode === 124 && hangElapsedMs < 15000, `code=${hangExitCode}, ms=${hangElapsedMs}`);
    assert('hard watchdog preserves live stdout and stderr before termination',
      hangOutput.includes('EARLY_STDOUT') && hangOutput.includes('EARLY_STDERR')
        && hangLog.includes('EARLY_STDOUT') && hangLog.includes('EARLY_STDERR'));
    assert('hard watchdog writes a clear reason to the log',
      hangLog.includes('HARD WATCHDOG: k6 exceeded')
        && hangLog.includes('terminating process tree'));
    assert('watchdog retains metrics and writes partial summary with exit 124',
      Boolean(hangMetricsName) && partialSummary?.status === 'watchdog'
        && partialSummary?.exitCode === 124 && partialSummary?.metricsFileFound === true
        && partialSummary?.metricsReadSucceeded === true);
    assert('watchdog partial summary contains last available counts',
      partialSummary?.metrics?.login_attempts === 2
        && partialSummary?.metrics?.login_ready_players === 2
        && partialSummary?.metrics?.ws_attempts === 3
        && partialSummary?.metrics?.ws_retries === 1
        && partialSummary?.metrics?.ws_ready_players === 1);
    assert('watchdog partial JSONL row is skipped and counted safely',
      partialSummary?.partialJsonLines === 1 && partialSummary?.invalidJsonLines === 0);
    assert('five-second incremental parse emits compact progress log',
      hangLog.includes('PROGRESS elapsed=') && !hangLog.includes('"metrics":'));

    if (existsSync(marker)) unlinkSync(marker);
    const production = runPowerShell([
      '-File', tempRunner, '-BaseUrl', 'https://www.pika.bg',
      '-WsUrl', 'wss://www.pika.bg/ws', '-Tables', '1', '-ResultsDirectory', temp,
    ], { env });
    assert('runner production guard exits non-zero', production.status !== 0);
    assert('runner production guard is fail-closed before k6 invocation', !existsSync(marker));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  console.log('single-machine WebSocket load validation');
  sourceChecks();
  executableContractChecks();
  lifecycleChecks();
  await fakeK6RunnerChecks();
  console.log(`\nPassed: ${passed}; Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
