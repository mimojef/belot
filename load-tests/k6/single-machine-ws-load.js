import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';

const PLAYERS_PER_TABLE = 4;
const TABLES = parseInteger(__ENV.TABLES, 'TABLES', 1, 600);
const BASE_URL = trimTrailingSlashes(requireEnv('BASE_URL'));
const WS_URL = requireEnv('WS_URL');
validateTargetPair(BASE_URL, WS_URL);

const WS_START_DELAY_SECONDS = parseNumber(
  __ENV.WS_START_DELAY_SECONDS || '30', 'WS_START_DELAY_SECONDS', 1,
);
const LOGIN_SPREAD_SECONDS = parseNumber(
  __ENV.LOGIN_SPREAD_SECONDS || '20', 'LOGIN_SPREAD_SECONDS', 0,
);
const WS_ATTEMPT_TIMEOUT_SECONDS = parseNumber(
  __ENV.WS_ATTEMPT_TIMEOUT_SECONDS || '10', 'WS_ATTEMPT_TIMEOUT_SECONDS', 0.1,
);
const WS_DEADLINE_SECONDS = parseNumber(
  __ENV.WS_DEADLINE_SECONDS || '60', 'WS_DEADLINE_SECONDS', 1,
);
const WS_HOLD_SECONDS = parseNumber(
  __ENV.WS_HOLD_SECONDS || '5', 'WS_HOLD_SECONDS', 0.1,
);
const WS_MAX_ATTEMPTS = parseInteger(
  __ENV.WS_MAX_ATTEMPTS || '3', 'WS_MAX_ATTEMPTS', 1, 20,
);
const WS_RETRY_BASE_DELAY_MS = parseInteger(
  __ENV.WS_RETRY_BASE_DELAY_MS || '250', 'WS_RETRY_BASE_DELAY_MS', 1, 60000,
);
const WS_RETRY_MAX_DELAY_MS = parseInteger(
  __ENV.WS_RETRY_MAX_DELAY_MS || '2000', 'WS_RETRY_MAX_DELAY_MS', 1, 60000,
);
const CLEANUP_TIMEOUT_MS = parseInteger(
  __ENV.CLEANUP_TIMEOUT_MS || '5000', 'CLEANUP_TIMEOUT_MS', 100, 60000,
);
const SUMMARY_JSON_PATH = __ENV.SUMMARY_JSON_PATH || 'single-machine-ws-load-summary.json';
const USERS = loadUsers();
const PING_INTERVAL_MS = 20000;
const WS_OPEN = 1;
const WS_CLOSED = 3;

if (WS_RETRY_BASE_DELAY_MS > WS_RETRY_MAX_DELAY_MS) {
  throw new Error('WS_RETRY_BASE_DELAY_MS must be <= WS_RETRY_MAX_DELAY_MS');
}
if (WS_ATTEMPT_TIMEOUT_SECONDS >= WS_DEADLINE_SECONDS) {
  throw new Error('WS_ATTEMPT_TIMEOUT_SECONDS must be less than WS_DEADLINE_SECONDS');
}
if (LOGIN_SPREAD_SECONDS >= WS_START_DELAY_SECONDS) {
  throw new Error('LOGIN_SPREAD_SECONDS must be less than WS_START_DELAY_SECONDS');
}

export const options = {
  scenarios: {
    tables: {
      executor: 'per-vu-iterations',
      vus: TABLES,
      iterations: 1,
      maxDuration: `${Math.ceil(
        WS_START_DELAY_SECONDS + WS_DEADLINE_SECONDS + WS_HOLD_SECONDS + 30
      )}s`,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    login_failures: ['count==0'],
    login_attempts: [`count==${TABLES * PLAYERS_PER_TABLE}`],
    login_ready_players: [`count==${TABLES * PLAYERS_PER_TABLE}`],
    login_ready_tables: [`count==${TABLES}`],
    ws_terminal_failures: ['count==0'],
    ws_deadlines_exceeded: ['count==0'],
    ws_retry_exhausted: ['count==0'],
    ws_cleanup_failures: ['count==0'],
    ws_cleanup_completed: [`count==${TABLES}`],
    ws_ready_players: [`count==${TABLES * PLAYERS_PER_TABLE}`],
    ws_ready_tables: [`count==${TABLES}`],
  },
};

const loginAttempts = new Counter('login_attempts');
const loginFailures = new Counter('login_failures');
const loginReadyPlayers = new Counter('login_ready_players');
const loginReadyTables = new Counter('login_ready_tables');
const wsAttempts = new Counter('ws_attempts');
const wsFirstAttemptFailures = new Counter('ws_first_attempt_failures');
const wsRetries = new Counter('ws_retries');
const wsRecoveredAfterRetry = new Counter('ws_recovered_after_retry');
const wsAttemptTimeouts = new Counter('ws_attempt_timeouts');
const wsRetryExhausted = new Counter('ws_retry_exhausted');
const wsDeadlinesExceeded = new Counter('ws_deadlines_exceeded');
const wsReadyPlayers = new Counter('ws_ready_players');
const wsReadyTables = new Counter('ws_ready_tables');
const wsTerminalFailures = new Counter('ws_terminal_failures');
const wsCleanupStarted = new Counter('ws_cleanup_started');
const wsCleanupCompleted = new Counter('ws_cleanup_completed');
const wsCleanupFailures = new Counter('ws_cleanup_failures');

export function setup() {
  const createdAtMs = Date.now();
  const wsStartAtMs = createdAtMs + (WS_START_DELAY_SECONDS * 1000);
  const readinessDeadlineAtMs = wsStartAtMs + (WS_DEADLINE_SECONDS * 1000);
  return {
    loginStartAtMs: createdAtMs,
    wsStartAtMs,
    readinessDeadlineAtMs,
    releaseAtMs: readinessDeadlineAtMs + (WS_HOLD_SECONDS * 1000),
  };
}

export default function (setupData) {
  const tableIndex = __VU - 1;
  const players = [];

  for (let playerIndex = 0; playerIndex < PLAYERS_PER_TABLE; playerIndex += 1) {
    const userIndex = (tableIndex * PLAYERS_PER_TABLE) + playerIndex;
    const jar = new http.CookieJar();
    const loginOffsetMs = USERS.length > 1
      ? Math.floor((userIndex * LOGIN_SPREAD_SECONDS * 1000) / (USERS.length - 1))
      : 0;
    const loginWaitMs = setupData.loginStartAtMs + loginOffsetMs - Date.now();
    if (loginWaitMs > 0) sleep(loginWaitMs / 1000);
    try {
      login(USERS[userIndex], userIndex, jar);
    } catch (error) {
      loginFailures.add(1);
      exec.test.abort(`Terminal login failure for credential index ${userIndex}: ${messageOf(error)}`);
      return;
    }
    loginReadyPlayers.add(1);
    players.push(createPlayer(playerIndex, userIndex, jar));
  }
  loginReadyTables.add(1);

  const waitMs = setupData.wsStartAtMs - Date.now();
  if (waitMs <= 0) {
    exec.test.abort(`Table ${tableIndex}: login phase missed the common WS start`);
    return;
  }
  sleep(waitMs / 1000);

  const table = createTable(
    tableIndex, players, setupData.readinessDeadlineAtMs, setupData.releaseAtMs,
  );
  scheduleDeadline(table);
  for (const player of players) connectPlayer(table, player);
}

export function handleSummary(data) {
  return {
    [SUMMARY_JSON_PATH]: JSON.stringify(data, null, 2),
    stdout: formatSummary(data),
  };
}

function login(account, userIndex, jar) {
  loginAttempts.add(1);
  const response = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: account.email, password: account.password }),
    {
      jar,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      tags: { name: 'auth_login' },
    },
  );
  const body = parseJson(response.body);
  const ok = check(response, {
    'login status is 200': (r) => r.status === 200,
    'login response is ok': () => body !== null && body.ok === true,
    'login returned session profile': () => body !== null && body.session !== undefined,
  });
  const cookies = jar.cookiesForURL(BASE_URL);
  if (!ok || !cookies || !cookies.belot_session || cookies.belot_session.length === 0) {
    throw new Error(`login or belot_session validation failed for credential index ${userIndex}`);
  }
}

function createPlayer(playerIndex, userIndex, jar) {
  return {
    playerIndex,
    userIndex,
    jar,
    attempts: 0,
    generation: 0,
    attemptActive: false,
    attemptFailed: false,
    retryTimerId: null,
    attemptTimeoutId: null,
    pingTimerId: null,
    ready: false,
    readinessCounted: false,
    recoveredCounted: false,
  };
}

function createTable(tableIndex, players, readinessDeadlineAtMs, releaseAtMs) {
  return {
    tableIndex,
    players,
    deadlineAtMs: readinessDeadlineAtMs,
    releaseAtMs,
    deadlineTimerId: null,
    releaseTimerId: null,
    attempts: new Set(),
    terminal: false,
    failureReason: null,
    cleanupStarted: false,
    cleanupComplete: false,
    cleanupTimerId: null,
    readyCounted: false,
  };
}

function connectPlayer(table, player) {
  if (table.terminal || table.cleanupStarted || player.attemptActive || player.retryTimerId !== null) return;
  if (Date.now() >= table.deadlineAtMs) {
    deadlineFailure(table);
    return;
  }

  player.attempts += 1;
  player.generation += 1;
  const generation = player.generation;
  player.attemptActive = true;
  player.attemptFailed = false;
  wsAttempts.add(1);
  if (player.attempts > 1) wsRetries.add(1);

  let ws;
  try {
    ws = new WebSocket(WS_URL, null, {
      jar: player.jar,
      headers: { Origin: BASE_URL },
      tags: { name: 'single_machine_game_ws' },
    });
  } catch (error) {
    failAttempt(table, player, null, generation, `constructor error: ${messageOf(error)}`);
    return;
  }

  const attempt = {
    ws, player, generation, timeoutId: null, pingTimerId: null, closed: false,
  };
  table.attempts.add(attempt);
  const timeoutId = setTimeout(() => {
    if (attempt.timeoutId !== timeoutId) return;
    attempt.timeoutId = null;
    if (player.attemptTimeoutId === timeoutId) player.attemptTimeoutId = null;
    if (!isCurrent(player, generation) || player.ready || table.terminal) return;
    wsAttemptTimeouts.add(1);
    failAttempt(table, player, attempt, generation, 'attempt timeout');
  }, WS_ATTEMPT_TIMEOUT_SECONDS * 1000);
  attempt.timeoutId = timeoutId;
  player.attemptTimeoutId = timeoutId;

  ws.addEventListener('open', () => {
    if (table.terminal || !isCurrent(player, generation)) closeAttempt(table, attempt);
  });
  ws.addEventListener('message', (event) => {
    if (table.terminal || !isCurrent(player, generation)) {
      closeAttempt(table, attempt);
      return;
    }
    const message = typeof event.data === 'string' ? parseJson(event.data) : null;
    if (message && message.type === 'connected') {
      markReady(table, player, attempt, generation);
    } else if (message && message.type === 'pong') {
      return;
    }
  });
  ws.addEventListener('error', () => {
    if (!table.terminal && isCurrent(player, generation)) {
      failAttempt(table, player, attempt, generation, 'WebSocket error');
    }
  });
  ws.addEventListener('close', () => {
    finalizeAttempt(table, attempt);
    if (!table.terminal && isCurrent(player, generation) && (player.attemptActive || player.ready)) {
      failAttempt(table, player, null, generation, 'WebSocket closed before table readiness');
    }
  });
}

function markReady(table, player, attempt, generation) {
  if (!isCurrent(player, generation) || player.ready || table.terminal) return;
  clearAttemptTimeout(attempt);
  player.attemptActive = false;
  player.ready = true;
  startAttemptPing(table, player, attempt, generation);
  if (!player.readinessCounted) {
    player.readinessCounted = true;
    wsReadyPlayers.add(1);
  }
  if (player.attempts > 1 && !player.recoveredCounted) {
    player.recoveredCounted = true;
    wsRecoveredAfterRetry.add(1);
  }
  if (table.players.every((candidate) => candidate.ready) && !table.readyCounted) {
    table.readyCounted = true;
    wsReadyTables.add(1);
  }
}

function failAttempt(table, player, attempt, generation, reason) {
  if (!isCurrent(player, generation) || player.attemptFailed || table.terminal) return;
  player.attemptFailed = true;
  player.attemptActive = false;
  player.ready = false;
  if (attempt) {
    clearAttemptTimers(attempt);
    closeAttempt(table, attempt);
  } else {
    clearPlayerTimers(player);
  }
  if (player.attempts === 1) wsFirstAttemptFailures.add(1);
  if (Date.now() >= table.deadlineAtMs) {
    deadlineFailure(table);
    return;
  }
  if (player.attempts >= WS_MAX_ATTEMPTS) {
    wsRetryExhausted.add(1);
    terminalFailure(table, reason, player);
    return;
  }
  const delay = Math.min(
    WS_RETRY_MAX_DELAY_MS,
    WS_RETRY_BASE_DELAY_MS * (2 ** (player.attempts - 1)),
    Math.max(0, table.deadlineAtMs - Date.now()),
  );
  player.retryTimerId = setTimeout(() => {
    player.retryTimerId = null;
    connectPlayer(table, player);
  }, delay);
}

function scheduleDeadline(table) {
  const remaining = table.deadlineAtMs - Date.now();
  if (remaining <= 0) {
    deadlineFailure(table);
    return;
  }
  table.deadlineTimerId = setTimeout(() => {
    table.deadlineTimerId = null;
    readinessDeadlineReached(table);
  }, remaining);
}

function readinessDeadlineReached(table) {
  if (table.terminal) return;
  if (!table.players.every((player) => player.ready)) {
    deadlineFailure(table);
    return;
  }
  scheduleRelease(table);
}

function scheduleRelease(table) {
  if (table.terminal || table.releaseTimerId !== null) return;
  const remaining = table.releaseAtMs - Date.now();
  if (remaining <= 0) {
    releaseTable(table);
    return;
  }
  table.releaseTimerId = setTimeout(() => {
    table.releaseTimerId = null;
    releaseTable(table);
  }, remaining);
}

function releaseTable(table) {
  if (table.terminal) return;
  if (!table.players.every((player) => player.ready)) {
    terminalFailure(table, 'WebSocket lost during the common hold period');
    return;
  }
  beginCleanup(table, null);
}

function deadlineFailure(table) {
  if (table.terminal) return;
  wsDeadlinesExceeded.add(1);
  terminalFailure(table, 'absolute WS deadline exceeded');
}

function terminalFailure(table, reason, player = null) {
  if (table.terminal) return;
  wsTerminalFailures.add(1);
  console.error(diagnosticLine(table, player, reason, 'terminal failure'));
  beginCleanup(table, reason);
}

function beginCleanup(table, failureReason) {
  if (!table.cleanupStarted) {
    table.terminal = true;
    table.cleanupStarted = true;
    table.failureReason = failureReason;
    wsCleanupStarted.add(1);
    if (table.deadlineTimerId !== null) clearTimeout(table.deadlineTimerId);
    if (table.releaseTimerId !== null) clearTimeout(table.releaseTimerId);
    table.deadlineTimerId = null;
    table.releaseTimerId = null;
    for (const player of table.players) {
      player.generation += 1;
      player.attemptActive = false;
      clearPlayerTimers(player);
    }
    table.cleanupTimerId = setTimeout(() => {
      table.cleanupTimerId = null;
      if (table.cleanupComplete) return;
      wsCleanupFailures.add(1);
      const reason = table.failureReason || 'cleanup timeout';
      const activeAttempt = table.attempts.values().next().value;
      console.error(diagnosticLine(
        table, activeAttempt ? activeAttempt.player : null, reason, 'cleanup timeout',
      ));
      exec.test.abort(reason);
    }, CLEANUP_TIMEOUT_MS);
  }
  for (const attempt of Array.from(table.attempts)) closeAttempt(table, attempt);
  maybeFinishCleanup(table);
}

function closeAttempt(table, attempt) {
  if (!table.attempts.has(attempt)) return;
  clearAttemptTimers(attempt);
  if (attempt.ws.readyState === WS_CLOSED) {
    finalizeAttempt(table, attempt);
    return;
  }
  try {
    attempt.ws.close(1000, 'load test complete');
  } catch (_) {
    // The cleanup watchdog bounds sockets whose close operation fails.
  }
}

function finalizeAttempt(table, attempt) {
  if (!table.attempts.has(attempt)) return;
  clearAttemptTimers(attempt);
  attempt.closed = true;
  table.attempts.delete(attempt);
  maybeFinishCleanup(table);
}

function maybeFinishCleanup(table) {
  if (!table.cleanupStarted || table.cleanupComplete || table.attempts.size !== 0) return;
  if (table.players.some((player) => (
    player.retryTimerId !== null || player.attemptTimeoutId !== null
  ))) return;
  if (table.cleanupTimerId !== null) clearTimeout(table.cleanupTimerId);
  table.cleanupTimerId = null;
  table.cleanupComplete = true;
  wsCleanupCompleted.add(1);
  if (table.failureReason !== null) exec.test.abort(table.failureReason);
}

function clearAttemptTimeout(attempt) {
  if (attempt.timeoutId !== null) clearTimeout(attempt.timeoutId);
  if (attempt.player.attemptTimeoutId === attempt.timeoutId) {
    attempt.player.attemptTimeoutId = null;
  }
  attempt.timeoutId = null;
}

function startAttemptPing(table, player, attempt, generation) {
  if (attempt.pingTimerId !== null || table.terminal || !isCurrent(player, generation)) return;
  const pingTimerId = setInterval(() => {
    if (attempt.pingTimerId !== pingTimerId || player.pingTimerId !== pingTimerId) return;
    if (table.terminal || !isCurrent(player, generation) || !player.ready) {
      clearAttemptPing(attempt);
      return;
    }
    try {
      attempt.ws.send(JSON.stringify({ type: 'ping' }));
    } catch (error) {
      failAttempt(table, player, attempt, generation, `ping send failed: ${messageOf(error)}`);
    }
  }, PING_INTERVAL_MS);
  attempt.pingTimerId = pingTimerId;
  player.pingTimerId = pingTimerId;
}

function clearAttemptPing(attempt) {
  const pingTimerId = attempt.pingTimerId;
  if (pingTimerId === null) return;
  clearInterval(pingTimerId);
  if (attempt.player.pingTimerId === pingTimerId) attempt.player.pingTimerId = null;
  attempt.pingTimerId = null;
}

function clearAttemptTimers(attempt) {
  clearAttemptTimeout(attempt);
  clearAttemptPing(attempt);
}

function clearPlayerTimers(player) {
  if (player.retryTimerId !== null) clearTimeout(player.retryTimerId);
  if (player.attemptTimeoutId !== null) clearTimeout(player.attemptTimeoutId);
  if (player.pingTimerId !== null) clearInterval(player.pingTimerId);
  player.retryTimerId = null;
  player.attemptTimeoutId = null;
  player.pingTimerId = null;
}

function diagnosticLine(table, player, reason, kind) {
  const readyPlayers = table.players.filter((candidate) => candidate.ready).length;
  const playerIndex = player === null ? 'n/a' : player.playerIndex;
  const attempts = player === null ? 'n/a' : player.attempts;
  const generation = player === null ? 'n/a' : player.generation;
  return `[${kind}] table=${table.tableIndex} player=${playerIndex} attempts=${attempts}`
    + ` generation=${generation} readyPlayers=${readyPlayers}/${table.players.length}`
    + ` activeAttempts=${table.attempts.size} reason=${messageOf(reason)}`;
}

function isCurrent(player, generation) {
  return player.generation === generation;
}

function loadUsers() {
  const parsed = parseJson(open('./loadtest-users.json.local'));
  const required = TABLES * PLAYERS_PER_TABLE;
  if (!parsed || !Array.isArray(parsed.users)) {
    throw new Error('loadtest-users.json.local must have the structure: { "users": [...] }');
  }
  if (parsed.users.length < required) {
    throw new Error(`loadtest-users.json.local must contain at least ${required} users for TABLES=${TABLES}`);
  }
  const selected = parsed.users.slice(0, required);
  selected.forEach((user, index) => {
    if (!user || typeof user.email !== 'string' || user.email.trim() === '') {
      throw new Error(`User at index ${index} is missing email`);
    }
    if (typeof user.password !== 'string' || user.password === '') {
      throw new Error(`User at index ${index} is missing password`);
    }
  });
  return selected;
}

function validateTargetPair(baseUrl, wsUrl) {
  const allowed = (
    (baseUrl === 'http://185.203.117.14:3101' && wsUrl === 'ws://185.203.117.14:3101/ws')
    || (baseUrl === 'http://127.0.0.1:3101' && wsUrl === 'ws://127.0.0.1:3101/ws')
  );
  if (!allowed) throw new Error(`SAFETY: disallowed BASE_URL/WS_URL pair: ${baseUrl} + ${wsUrl}`);
}

function requireEnv(name) {
  const value = __ENV[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

function parseInteger(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseNumber(value, name, min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${name} must be >= ${min}`);
  return parsed;
}

function trimTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function messageOf(error) {
  return String(error && error.message ? error.message : error);
}

function formatSummary(data) {
  const names = [
    'login_attempts', 'login_failures', 'login_ready_players', 'login_ready_tables',
    'ws_attempts', 'ws_first_attempt_failures', 'ws_retries', 'ws_recovered_after_retry',
    'ws_attempt_timeouts', 'ws_retry_exhausted', 'ws_deadlines_exceeded',
    'ws_ready_players', 'ws_ready_tables', 'ws_terminal_failures',
    'ws_cleanup_started', 'ws_cleanup_completed', 'ws_cleanup_failures',
  ];
  const lines = ['', 'single-machine WebSocket load summary', ''];
  for (const name of names) {
    const metric = data.metrics && data.metrics[name];
    if (metric) lines.push(`${name}: ${JSON.stringify(metric.values)}`);
  }
  lines.push('');
  return lines.join('\n');
}
