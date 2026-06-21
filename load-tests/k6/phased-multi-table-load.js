/**
 * Phased multi-table load test — три координирани фази:
 *   Фаза 1 (Login)  — всички N маси логват 4 играча, после чакат глобален login barrier
 *   Фаза 2 (WS)     — всички N маси отварят 4 WS връзки, после чакат глобален WS barrier
 *   Фаза 3 (Play)   — всички N маси изпращат join_matchmaking едновременно и играят
 *
 * Разлики от multi-table-load.js:
 *  - timing-базираните barriers (MATCHMAKING_BARRIER_SECONDS и т.н.) са заменени с
 *    HTTP coordinator barriers (COORDINATOR_URL + RUN_ID)
 *  - нови метрики: phased_login_* и phased_websocket_*
 *  - нямa health_monitor сценарий (coordinator /status дава живо наблюдение)
 */
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';
import { sleep } from 'k6';
import { WebSocket } from 'k6/websockets';
import exec from 'k6/execution';

const TABLES = parseTables(__ENV.TABLES);
const TABLE_OFFSET = parseTableOffset(__ENV.TABLE_OFFSET || '0');
const PLAYERS_PER_TABLE = 4;
const CREDENTIAL_START = TABLE_OFFSET * PLAYERS_PER_TABLE;
const REQUIRED_USERS = TABLES * PLAYERS_PER_TABLE;
const USERS = loadUsers();

const LOGIN_SPREAD_SECONDS = parseSeconds(__ENV.LOGIN_SPREAD_SECONDS || '60', 'LOGIN_SPREAD_SECONDS');
const LOGIN_BARRIER_TIMEOUT_SECONDS = parseSeconds(
  __ENV.LOGIN_BARRIER_TIMEOUT_SECONDS || '300',
  'LOGIN_BARRIER_TIMEOUT_SECONDS',
);
const WS_CONNECT_SPREAD_SECONDS = parseSeconds(
  __ENV.WS_CONNECT_SPREAD_SECONDS || '0',
  'WS_CONNECT_SPREAD_SECONDS',
);
const WS_BARRIER_TIMEOUT_SECONDS = parseSeconds(
  __ENV.WS_BARRIER_TIMEOUT_SECONDS || '120',
  'WS_BARRIER_TIMEOUT_SECONDS',
);
const WS_CONNECT_DEADLINE_SECONDS = parsePositiveSeconds(
  __ENV.WS_CONNECT_DEADLINE_SECONDS || '120', 'WS_CONNECT_DEADLINE_SECONDS',
);
const WS_CONNECT_ATTEMPT_TIMEOUT_SECONDS = parsePositiveSeconds(
  __ENV.WS_CONNECT_ATTEMPT_TIMEOUT_SECONDS || '15', 'WS_CONNECT_ATTEMPT_TIMEOUT_SECONDS',
);
const WS_MAX_ATTEMPTS = parsePositiveInteger(__ENV.WS_MAX_ATTEMPTS || '3', 'WS_MAX_ATTEMPTS');
const WS_RETRY_BASE_DELAY_MS = parsePositiveInteger(
  __ENV.WS_RETRY_BASE_DELAY_MS || '250', 'WS_RETRY_BASE_DELAY_MS',
);
const WS_RETRY_MAX_DELAY_MS = parsePositiveInteger(
  __ENV.WS_RETRY_MAX_DELAY_MS || '2000', 'WS_RETRY_MAX_DELAY_MS',
);
const SUMMARY_JSON_PATH = __ENV.SUMMARY_JSON_PATH || 'phased-multi-table-load-summary.json';

const COORDINATOR_URL = trimTrailingSlashes(__ENV.COORDINATOR_URL || '');
const RUN_ID = __ENV.RUN_ID || '';
const COORDINATOR_TOKEN = __ENV.COORDINATOR_TOKEN || '';

if (!COORDINATOR_URL) {
  throw new Error('COORDINATOR_URL env var is required');
}
if (!RUN_ID) {
  throw new Error('RUN_ID env var is required');
}

const MODE = __ENV.MODE || '';
if (MODE !== 'websocket-only' && MODE !== 'full') {
  throw new Error('MODE must be "websocket-only" or "full"');
}

// MATCHMAKING_SPREAD_SECONDS and MATCH_RUNTIME_TIMEOUT_SECONDS only used in full mode
const MATCHMAKING_SPREAD_SECONDS = MODE === 'full'
  ? parseSeconds(__ENV.MATCHMAKING_SPREAD_SECONDS || '0', 'MATCHMAKING_SPREAD_SECONDS')
  : 0;
const MATCH_RUNTIME_TIMEOUT_SECONDS = MODE === 'full'
  ? parseSeconds(__ENV.MATCH_RUNTIME_TIMEOUT_SECONDS || '2100', 'MATCH_RUNTIME_TIMEOUT_SECONDS')
  : 0;

// ── k6 options ─────────────────────────────────────────────────────────────────

export const options = {
  scenarios: createScenarios(),
  thresholds: buildThresholds(),
};

// ── Existing metrics (same as multi-table-load.js) ────────────────────────────

const loginFailures = new Counter('login_failures');
const websocketErrors = new Counter('websocket_errors');
const protocolErrors = new Counter('protocol_errors');
const matchmakingSuccess = new Counter('matchmaking_success');
const fullHumanMatchSuccess = new Counter('full_human_match_success');
const roomsJoined = new Counter('rooms_joined');
const rejectedActions = new Counter('rejected_actions');
const humanSeatTakeovers = new Counter('human_seat_takeovers');
const matchesCompleted = new Counter('matches_completed');
const roomSnapshotsReceived = new Counter('room_snapshots_received');
const gameplayActionsSent = new Counter('gameplay_actions_sent');
const websocketConnectionsReady = new Counter('websocket_connections_ready');
const tablesWithFourWebsocketsReady = new Counter('tables_with_four_websockets_ready');
const matchmakingJoinMessagesSent = new Counter('matchmaking_join_messages_sent');
const websocketConnectAttempts = new Counter('websocket_connect_attempts');
const websocketFirstAttemptFailures = new Counter('websocket_first_attempt_failures');
const websocketRetryAttempts = new Counter('websocket_retry_attempts');
const websocketRecoveredAfterRetry = new Counter('websocket_recovered_after_retry');
const websocketRetryExhausted = new Counter('websocket_retry_exhausted');
const websocketConnectDeadlineExceeded = new Counter('websocket_connect_deadline_exceeded');
const websocketTerminalFailures = new Counter('websocket_terminal_failures');

// ── Phased barrier metrics (new) ───────────────────────────────────────────────

const phasedLoginPlayersReady = new Counter('phased_login_players_ready');
const phasedLoginTablesReady = new Counter('phased_login_tables_ready');
const phasedLoginBarrierReached = new Counter('phased_login_barrier_reached');
const phasedLoginBarrierTimeout = new Counter('phased_login_barrier_timeout');
const phasedLoginBarrierFailed = new Counter('phased_login_barrier_failed');
const phasedWebsocketPlayersReady = new Counter('phased_websocket_players_ready');
const phasedWebsocketTablesReady = new Counter('phased_websocket_tables_ready');
const phasedWebsocketBarrierReached = new Counter('phased_websocket_barrier_reached');
const phasedWebsocketBarrierTimeout = new Counter('phased_websocket_barrier_timeout');
const phasedWebsocketBarrierFailed = new Counter('phased_websocket_barrier_failed');
const phasedMatchmakingReleased = new Counter('phased_matchmaking_released');

// ── Game constants ─────────────────────────────────────────────────────────────

const BASE_URL = trimTrailingSlashes(__ENV.BASE_URL || 'https://www.pika.bg');
const WS_URL = __ENV.WS_URL || 'wss://www.pika.bg/ws';
const ORIGIN = BASE_URL;
const STAKE = Number(__ENV.STAKE || '5000');
const CUT_DELAY_MIN_MS = parseMilliseconds(__ENV.CUT_DELAY_MIN_MS || '1000', 'CUT_DELAY_MIN_MS');
const CUT_DELAY_MAX_MS = parseMilliseconds(__ENV.CUT_DELAY_MAX_MS || '3000', 'CUT_DELAY_MAX_MS');
const BID_DELAY_MIN_MS = parseMilliseconds(__ENV.BID_DELAY_MIN_MS || '1000', 'BID_DELAY_MIN_MS');
const BID_DELAY_MAX_MS = parseMilliseconds(__ENV.BID_DELAY_MAX_MS || '4000', 'BID_DELAY_MAX_MS');
const PLAY_DELAY_MIN_MS = parseMilliseconds(__ENV.PLAY_DELAY_MIN_MS || '700', 'PLAY_DELAY_MIN_MS');
const PLAY_DELAY_MAX_MS = parseMilliseconds(__ENV.PLAY_DELAY_MAX_MS || '3000', 'PLAY_DELAY_MAX_MS');
const ACTION_DEADLINE_SAFETY_MS = parseMilliseconds(
  __ENV.ACTION_DEADLINE_SAFETY_MS || '500',
  'ACTION_DEADLINE_SAFETY_MS',
);
// Per-WS timeout starts at socket open (table 0). The latest table connects after
// WS_CONNECT_SPREAD_SECONDS, then waits up to WS_BARRIER_TIMEOUT_SECONDS, then plays.
// Table 0's socket must stay alive until the last table finishes — hence spread is included.
const RUN_TIMEOUT_MS = (
  WS_CONNECT_SPREAD_SECONDS
  + WS_BARRIER_TIMEOUT_SECONDS
  + (MODE === 'full' ? MATCHMAKING_SPREAD_SECONDS + MATCH_RUNTIME_TIMEOUT_SECONDS : 0)
  + 120
) * 1000;
const PING_INTERVAL_MS = 20 * 1000;
const COORDINATOR_POLL_INTERVAL_MS = 1000;
const SOCKET_CLEANUP_WATCHDOG_MS = 5000;
const LEAVE_RETRY_INTERVAL_MS = 3000;
const LEAVE_MAX_RETRIES = 5;
const WS_OPEN = 1;
const WS_CLOSED = 3;
const LOG_PHASE_TRANSITIONS = TABLES <= 5;
const REJECTED_ACTION_DIAGNOSTICS = __ENV.REJECTED_ACTION_DIAGNOSTICS === '1';

if (!Number.isInteger(STAKE) || STAKE <= 0) {
  throw new Error('STAKE must be a positive integer');
}

validateDelayRange('CUT_DELAY', CUT_DELAY_MIN_MS, CUT_DELAY_MAX_MS);
validateDelayRange('BID_DELAY', BID_DELAY_MIN_MS, BID_DELAY_MAX_MS);
validateDelayRange('PLAY_DELAY', PLAY_DELAY_MIN_MS, PLAY_DELAY_MAX_MS);
validateDelayRange('WS_RETRY', WS_RETRY_BASE_DELAY_MS, WS_RETRY_MAX_DELAY_MS);

if (!WS_URL.startsWith('ws://') && !WS_URL.startsWith('wss://')) {
  throw new Error('WS_URL must start with ws:// or wss://');
}

// ── Export functions ───────────────────────────────────────────────────────────

export function setup() {
  // Timing is coordinator-driven; no setup data needed.
  return {};
}

export default function () {
  const tableIndex = tableIndexForVu(__VU);
  const globalTableIndex = TABLE_OFFSET + tableIndex;
  const players = [];

  // ── Фаза 1: Login ──────────────────────────────────────────────────────────
  for (let playerIndex = 0; playerIndex < PLAYERS_PER_TABLE; playerIndex += 1) {
    const account = accountForTablePlayer(tableIndex, playerIndex);
    const jar = new http.CookieJar();

    // Report failure to coordinator BEFORE stopping so other VUs can see failed=true
    let loginErr = null;
    try { login(account, jar); } catch (e) { loginErr = e; }
    if (loginErr !== null) {
      coordinatorPost(
        `${COORDINATOR_URL}/failure${coordQs()}`,
        JSON.stringify({ tableIndex: globalTableIndex, playerIndex, phase: 'login', reason: 'login failed' }),
      );
      return;
    }

    let stakeErr = null;
    try { validateStake(jar); } catch (e) { stakeErr = e; }
    if (stakeErr !== null) {
      coordinatorPost(
        `${COORDINATOR_URL}/failure${coordQs()}`,
        JSON.stringify({ tableIndex: globalTableIndex, playerIndex, phase: 'login', reason: 'stake validation failed' }),
      );
      return;
    }

    players.push(createPlayerState(tableIndex, playerIndex, account, jar));
    phasedLoginPlayersReady.add(1);
  }

  phasedLoginTablesReady.add(1);

  if (!pollLoginBarrier(tableIndex, globalTableIndex)) {
    return; // barrier timeout or failed — counters already incremented
  }

  // ── Фаза 2: WS connect — spread по tableIndex ─────────────────────────────
  const tableState = createTableConnectState(tableIndex, globalTableIndex, players);
  const wsConnectOffsetMs = TABLES > 1
    ? Math.floor((tableIndex * WS_CONNECT_SPREAD_SECONDS * 1000) / (TABLES - 1))
    : 0;
  if (!waitForWsConnectSpread(tableState, wsConnectOffsetMs)) return;
  connectTableAndPlay(tableState);
}

export function handleSummary(data) {
  return {
    [SUMMARY_JSON_PATH]: JSON.stringify(data, null, 2),
    stdout: formatTextSummary(data),
  };
}

// ── Phase 1: Login barrier (blocking, runs before WS) ─────────────────────────

function pollLoginBarrier(tableIndex, globalTableIndex) {
  const reportResp = coordinatorPost(
    `${COORDINATOR_URL}/login-ready${coordQs()}`,
    JSON.stringify({ tableIndex: globalTableIndex }),
  );

  if (reportResp.status !== 200) {
    phasedLoginBarrierFailed.add(1);
    logTable(tableIndex, `coordinator /login-ready failed status=${reportResp.status}`);
    return false;
  }

  logTable(tableIndex, 'reported login-ready to coordinator, polling login barrier');

  const deadlineMs = Date.now() + (LOGIN_BARRIER_TIMEOUT_SECONDS * 1000);

  while (true) {
    const pollResp = coordinatorGet(`${COORDINATOR_URL}/login-barrier${coordQs()}`);

    if (pollResp.status !== 200 || !pollResp.body) {
      phasedLoginBarrierFailed.add(1);
      logTable(tableIndex, `coordinator /login-barrier poll failed status=${pollResp.status}`);
      return false;
    }

    if (pollResp.body.released) {
      phasedLoginBarrierReached.add(1);
      logTable(tableIndex, 'login barrier released');
      return true;
    }

    if (pollResp.body.failed) {
      phasedLoginBarrierFailed.add(1);
      logTable(
        tableIndex,
        `login barrier failed: ${pollResp.body.failureReason || 'unknown'}`,
      );
      return false;
    }

    if (Date.now() >= deadlineMs) {
      phasedLoginBarrierTimeout.add(1);
      logTable(tableIndex, 'login barrier timeout');
      return false;
    }

    sleep(COORDINATOR_POLL_INTERVAL_MS / 1000);
  }
}

// ── Phase 2: WS connect + coordinator reporting (event-driven) ────────────────

function createTableConnectState(tableIndex, globalTableIndex, players) {
  const tableState = {
    vu: __VU,
    tableIndex,
    globalTableIndex,
    players,
    sockets: [],
    gameplayStarted: false,
    websocketReadyCounted: false,
    phasedWsReadyCounted: false,
    controllerReadyCounted: false,
    wsBarrierPollTimerId: null,
    wsReadyReported: false,
    wsBarrierFailed: false,
    failureReported: false,
    terminal: false,
    cleanupStarted: false,
    cleanupComplete: false,
    cleanupFailed: false,
    cleanupWatchdogTimerId: null,
    abortInitiated: false,
    abortReason: null,
    socketAttempts: new Set(),
    wsConnectStartedAtMs: null,
    connectDeadlineAtMs: null,
    connectDeadlineTimerId: null,
    globalFailurePollTimerId: null,
  };
  for (const player of players) player.tableState = tableState;
  return tableState;
}

function waitForWsConnectSpread(tableState, spreadDelayMs) {
  const spreadEndsAtMs = Date.now() + spreadDelayMs;
  while (Date.now() < spreadEndsAtMs) {
    if (observeGlobalWsFailure(tableState)) return false;
    const remainingMs = spreadEndsAtMs - Date.now();
    sleep(Math.min(COORDINATOR_POLL_INTERVAL_MS, remainingMs) / 1000);
    if (tableState.terminal) return false;
  }
  return !observeGlobalWsFailure(tableState);
}

function connectTableAndPlay(tableState) {
  if (tableState.terminal || observeGlobalWsFailure(tableState)) return;
  tableState.wsConnectStartedAtMs = Date.now();
  tableState.connectDeadlineAtMs = (
    tableState.wsConnectStartedAtMs + (WS_CONNECT_DEADLINE_SECONDS * 1000)
  );

  scheduleConnectDeadlineTimer(tableState);
  scheduleGlobalFailurePoll(tableState);

  for (const player of tableState.players) {
    connectPlayerSocket(tableState, player);
  }
}

function connectPlayerSocket(tableState, state) {
  if (tableState.terminal || tableState.cleanupStarted
      || state.retryTimerId !== null || state.attemptActive) {
    return;
  }
  if (Date.now() >= tableState.connectDeadlineAtMs) {
    websocketConnectDeadlineExceeded.add(1);
    terminalTableFailure(tableState, state.playerIndex, 'WS connect deadline exceeded');
    return;
  }

  state.attempts += 1;
  state.attemptGeneration += 1;
  const generation = state.attemptGeneration;
  state.attemptActive = true;
  state.attemptFailed = false;
  state.closed = false;
  state.closeRequested = false;
  websocketConnectAttempts.add(1);
  if (state.attempts > 1) {
    websocketRetryAttempts.add(1);
  }
  let ws;
  try {
    ws = new WebSocket(WS_URL, null, {
      jar: state.jar,
      headers: { Origin: ORIGIN },
      tags: { name: 'game_ws' },
    });
  } catch (error) {
    websocketErrors.add(1);
    handleConnectAttemptFailure(
      tableState, state, null, generation,
      `WebSocket constructor failed: ${safeString(error && error.message ? error.message : error)}`,
    );
    return;
  }

  const attempt = {
    ws,
    state,
    generation,
    attemptTimeoutId: null,
    pingTimerId: null,
    closeRetryTimerId: null,
    closeFailed: false,
    closed: false,
  };
  tableState.socketAttempts.add(attempt);
  tableState.sockets[state.playerIndex] = ws;

  attempt.attemptTimeoutId = setTimeout(() => {
    attempt.attemptTimeoutId = null;
    if (state.attemptTimeoutId !== null) state.attemptTimeoutId = null;
    if (!isCurrentAttempt(state, generation) || state.wsConnected || tableState.terminal) {
      if (tableState.terminal) closeTrackedAttempt(tableState, attempt);
      return;
    }
    handleConnectAttemptFailure(tableState, state, ws, generation, 'WS connect attempt timeout');
  }, WS_CONNECT_ATTEMPT_TIMEOUT_SECONDS * 1000);
  state.attemptTimeoutId = attempt.attemptTimeoutId;

  attempt.pingTimerId = setInterval(() => {
    if (state.closed || ws.readyState !== WS_OPEN) {
      return;
    }
    sendProtocol(ws, state, { type: 'ping' });
  }, PING_INTERVAL_MS);
  state.pingTimerId = attempt.pingTimerId;

  ws.addEventListener('open', () => {
    if (tableState.terminal || !isCurrentAttempt(state, generation)) {
      closeTrackedAttempt(tableState, attempt);
    }
  });

  ws.addEventListener('message', (event) => {
    if (tableState.terminal || !isCurrentAttempt(state, generation)) {
      closeTrackedAttempt(tableState, attempt);
      return;
    }
    handleMessage(ws, tableState, state, event.data);
  });

  ws.addEventListener('error', () => {
    if (tableState.terminal || !isCurrentAttempt(state, generation)) {
      closeTrackedAttempt(tableState, attempt);
      return;
    }
    websocketErrors.add(1);
    logSafe(state, 'WebSocket error');
    if (!tableState.gameplayStarted) {
      handleConnectAttemptFailure(tableState, state, ws, generation, 'WebSocket error');
    }
  });

  ws.addEventListener('close', (event) => {
    finalizeSocketAttempt(tableState, attempt);
    if (!isCurrentAttempt(state, generation)) return;
    const unexpected = !state.completionCounted && !state.closeRequested && !tableState.terminal;
    if (unexpected) {
      websocketErrors.add(1);
      if (!tableState.gameplayStarted) {
        handleConnectAttemptFailure(tableState, state, ws, generation, 'WebSocket closed unexpectedly');
      }
    }
    state.closed = true;
    state.attemptActive = false;
    state.wsConnected = false;
    clearActionInFlight(state);
    cancelLeaveRetry(state);
    clearAttemptTimers(attempt);
    const code = event && event.code !== undefined ? event.code : 'unknown';
    const reason = event && event.reason ? safeString(event.reason) : '';
    logSafe(state, `WebSocket closed code=${code} reason=${reason}`);
  });
}

function isCurrentAttempt(state, generation) {
  return state.attemptGeneration === generation;
}

function handleConnectAttemptFailure(tableState, state, ws, generation, reason) {
  if (!isCurrentAttempt(state, generation) || state.attemptFailed || tableState.terminal) return;
  state.attemptFailed = true;
  state.attemptActive = false;
  state.wsConnected = false;
  const attempt = findSocketAttempt(tableState, ws);
  if (attempt) clearAttemptTimers(attempt);
  else clearPlayerConnectTimers(state);
  markTableWsUnready(tableState);
  if (attempt) closeTrackedAttempt(tableState, attempt);
  else closeSocket(ws);

  if (state.attempts === 1) websocketFirstAttemptFailures.add(1);
  if (Date.now() >= tableState.connectDeadlineAtMs) {
    websocketConnectDeadlineExceeded.add(1);
    terminalTableFailure(tableState, state.playerIndex, 'WS connect deadline exceeded');
    return;
  }
  if (state.attempts >= WS_MAX_ATTEMPTS) {
    websocketRetryExhausted.add(1);
    terminalTableFailure(tableState, state.playerIndex, reason);
    return;
  }

  const exponential = WS_RETRY_BASE_DELAY_MS * (2 ** (state.attempts - 1));
  const capped = Math.min(WS_RETRY_MAX_DELAY_MS, exponential);
  const jittered = Math.min(
    WS_RETRY_MAX_DELAY_MS,
    Math.max(1, Math.floor(capped * (0.9 + (Math.random() * 0.2)))),
  );
  const remaining = tableState.connectDeadlineAtMs - Date.now();
  scheduleConnectDeadlineTimer(tableState);
  state.retryTimerId = setTimeout(() => {
    state.retryTimerId = null;
    connectPlayerSocket(tableState, state);
  }, Math.max(0, Math.min(jittered, remaining)));
}

function scheduleConnectDeadlineTimer(tableState) {
  if (tableState.terminal || tableState.connectDeadlineTimerId !== null) return;
  const remainingMs = tableState.connectDeadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    websocketConnectDeadlineExceeded.add(1);
    terminalTableFailure(tableState, null, 'WS connect deadline exceeded');
    return;
  }
  tableState.connectDeadlineTimerId = setTimeout(() => {
    tableState.connectDeadlineTimerId = null;
    if (tableState.terminal || allFourWsConnected(tableState)) return;
    websocketConnectDeadlineExceeded.add(1);
    terminalTableFailure(tableState, null, 'WS connect deadline exceeded');
  }, remainingMs);
}

function clearPlayerConnectTimers(state) {
  if (state.attemptTimeoutId !== null) clearTimeout(state.attemptTimeoutId);
  if (state.pingTimerId !== null) clearInterval(state.pingTimerId);
  state.attemptTimeoutId = null;
  state.pingTimerId = null;
}

function findSocketAttempt(tableState, ws) {
  for (const attempt of tableState.socketAttempts) {
    if (attempt.ws === ws) return attempt;
  }
  return null;
}

function clearAttemptTimers(attempt) {
  if (attempt.attemptTimeoutId !== null) clearTimeout(attempt.attemptTimeoutId);
  if (attempt.pingTimerId !== null) clearInterval(attempt.pingTimerId);
  if (attempt.state.attemptTimeoutId === attempt.attemptTimeoutId) {
    attempt.state.attemptTimeoutId = null;
  }
  if (attempt.state.pingTimerId === attempt.pingTimerId) attempt.state.pingTimerId = null;
  attempt.attemptTimeoutId = null;
  attempt.pingTimerId = null;
}

function markTableWsUnready(tableState) {
  if (!tableState.wsReadyReported || tableState.gameplayStarted || tableState.terminal) return;
  tableState.wsReadyReported = false;
  clearWsBarrierTimer(tableState);
  coordinatorPost(
    `${COORDINATOR_URL}/ws-unready${coordQs()}`,
    JSON.stringify({ tableIndex: tableState.globalTableIndex }),
  );
}

function terminalTableFailure(tableState, playerIndex, reason) {
  const firstFailure = !tableState.abortInitiated;
  beginTableTermination(tableState, true);
  if (firstFailure) {
    websocketTerminalFailures.add(1);
    reportTableFailureOnce(tableState, playerIndex, 'ws', reason);
  }
  abortTestOnce(tableState, reason);
}

function scheduleGlobalFailurePoll(tableState) {
  if (tableState.terminal || tableState.gameplayStarted) return;
  tableState.globalFailurePollTimerId = setTimeout(() => {
    tableState.globalFailurePollTimerId = null;
    if (observeGlobalWsFailure(tableState)) return;
    scheduleGlobalFailurePoll(tableState);
  }, COORDINATOR_POLL_INTERVAL_MS);
}

function observeGlobalWsFailure(tableState) {
  if (tableState.terminal) return true;
  const response = coordinatorGet(`${COORDINATOR_URL}/ws-barrier${coordQs()}`);
  if (response.status !== 200 || !response.body || !response.body.failed) return false;
  terminateTableLifecycle(
    tableState,
    `global WS failure: ${response.body.failureReason || 'unknown'}`,
    true,
  );
  return true;
}

// ── Message handling (same as multi-table-load.js) ────────────────────────────

function handleMessage(ws, tableState, state, rawData) {
  if (typeof rawData !== 'string') {
    protocolErrors.add(1);
    logSafe(state, 'non-text WebSocket message received');
    return;
  }

  const message = parseJson(rawData);
  if (message === null || typeof message.type !== 'string') {
    protocolErrors.add(1);
    logSafe(state, 'invalid JSON protocol message');
    return;
  }

  switch (message.type) {
    case 'connected':
      handleConnected(ws, tableState, state);
      break;

    case 'matchmaking_joined':
    case 'matchmaking_status':
      break;

    case 'match_found':
      handleMatchFound(tableState, state, message);
      break;

    case 'room_snapshot':
      handleRoomSnapshot(ws, tableState, state, message);
      break;

    case 'error':
      rejectedActions.add(1);
      if (REJECTED_ACTION_DIAGNOSTICS) {
        logRejectedActionDiagnostic(state, message);
      }
      clearActionInFlight(state);
      logSafe(state, `server error: ${safeString(message.message || message.code || 'unknown')}`);
      break;

    case 'session_displaced':
      protocolErrors.add(1);
      logSafe(state, 'session displaced');
      terminalTableFailure(tableState, state.playerIndex, 'session displaced');
      break;

    case 'session_in_game':
      protocolErrors.add(1);
      state.roomId = message.roomId || state.roomId;
      logSafe(state, 'session already in game');
      terminalTableFailure(tableState, state.playerIndex, 'session already in game');
      break;

    case 'left_active_room':
      safeClose(ws, state);
      break;

    case 'pong':
      break;

    default:
      break;
  }
}

// ── Phase 2: handleConnected triggers WS-ready reporting ──────────────────────

function handleConnected(ws, tableState, state) {
  if (state.closeRequested || tableState.wsBarrierFailed) {
    safeClose(ws, state);
    return;
  }

  state.wsConnected = true;
  state.attemptActive = false;
  const attempt = findSocketAttempt(tableState, ws);
  if (attempt && attempt.attemptTimeoutId !== null) {
    clearTimeout(attempt.attemptTimeoutId);
    attempt.attemptTimeoutId = null;
  }
  state.attemptTimeoutId = null;
  state.wsConnectedAtMs = Date.now();
  if (state.runTimeoutId === null) {
    state.runTimeoutId = setTimeout(() => {
      if (state.completionCounted || tableState.terminal) return;
      protocolErrors.add(1);
      logSafe(state, 'global runtime timeout reached; closing table');
      closeTable(tableState);
    }, RUN_TIMEOUT_MS);
  }

  if (!state.wsReadyCounted) {
    phasedWebsocketPlayersReady.add(1);
    websocketConnectionsReady.add(1);
    state.wsReadyCounted = true;
  }
  if (state.attempts > 1 && !state.recoveryCounted) {
    websocketRecoveredAfterRetry.add(1);
    state.recoveryCounted = true;
  }

  logSafe(state, 'WebSocket connected');
  maybeCountTableWebsocketsReady(tableState);
  maybeReportWsReady(tableState);
}

function allFourWsConnected(tableState) {
  return tableState.players.every((player) => {
    const ws = tableState.sockets[player.playerIndex];
    return player.wsConnected && ws && ws.readyState === WS_OPEN;
  });
}

function maybeCountTableWebsocketsReady(tableState) {
  if (tableState.websocketReadyCounted || !allFourWsConnected(tableState)) {
    return;
  }
  tablesWithFourWebsocketsReady.add(1);
  tableState.websocketReadyCounted = true;
  logTableSafe(tableState, 'four WebSockets connected and ready');
}

function maybeReportWsReady(tableState) {
  if (tableState.wsReadyReported || !allFourWsConnected(tableState)) {
    return;
  }
  if (tableState.connectDeadlineTimerId !== null) {
    clearTimeout(tableState.connectDeadlineTimerId);
    tableState.connectDeadlineTimerId = null;
  }
  tableState.wsReadyReported = true;
  // Defer out of the WS event callback so other WS events are not blocked
  tableState.wsBarrierPollTimerId = setTimeout(() => {
    tableState.wsBarrierPollTimerId = null;
    if (tableState.terminal) return;
    reportWsReadyAndStartPolling(tableState);
  }, 0);
}

// ── Phase 2→3: WS barrier via coordinator (timer-based, non-blocking) ─────────

function reportWsReadyAndStartPolling(tableState) {
  if (tableState.terminal) return;
  const reportResp = coordinatorPost(
    `${COORDINATOR_URL}/ws-ready${coordQs()}`,
    JSON.stringify({ tableIndex: tableState.globalTableIndex }),
  );

  if (reportResp.status !== 200) {
    logTableSafe(tableState, `coordinator /ws-ready failed status=${reportResp.status}`);
    terminalTableFailure(tableState, null, 'coordinator /ws-ready failed');
    return;
  }

  if (!tableState.phasedWsReadyCounted) {
    phasedWebsocketTablesReady.add(1);
    tableState.phasedWsReadyCounted = true;
  }
  logTableSafe(tableState, 'ws-ready reported to coordinator, polling WS barrier');
  pollWsBarrier(tableState, Date.now() + (WS_BARRIER_TIMEOUT_SECONDS * 1000));
}

function pollWsBarrier(tableState, deadlineMs) {
  if (tableState.terminal) return;
  const pollResp = coordinatorGet(`${COORDINATOR_URL}/ws-barrier${coordQs()}`);

  if (pollResp.status !== 200 || !pollResp.body) {
    phasedWebsocketBarrierFailed.add(1);
    logTableSafe(tableState, `coordinator /ws-barrier poll failed status=${pollResp.status}`);
    terminalTableFailure(tableState, null, 'coordinator /ws-barrier poll failed');
    return;
  }

  if (pollResp.body.released) {
    clearTimeout(tableState.connectDeadlineTimerId);
    tableState.connectDeadlineTimerId = null;
    if (tableState.globalFailurePollTimerId !== null) {
      clearTimeout(tableState.globalFailurePollTimerId);
      tableState.globalFailurePollTimerId = null;
    }
    phasedWebsocketBarrierReached.add(1);
    handleWsBarrierReleased(tableState);
    return;
  }

  if (pollResp.body.failed) {
    phasedWebsocketBarrierFailed.add(1);
    logTableSafe(
      tableState,
      `WS barrier failed: ${pollResp.body.failureReason || 'unknown'}`,
    );
    terminateTableLifecycle(
      tableState,
      `WS barrier failed: ${pollResp.body.failureReason || 'unknown'}`,
      true,
    );
    return;
  }

  if (Date.now() >= deadlineMs) {
    phasedWebsocketBarrierTimeout.add(1);
    logTableSafe(tableState, 'WS barrier timeout');
    terminalTableFailure(tableState, null, 'WS barrier timeout');
    return;
  }

  tableState.wsBarrierPollTimerId = setTimeout(() => {
    tableState.wsBarrierPollTimerId = null;
    if (tableState.terminal) return;
    pollWsBarrier(tableState, deadlineMs);
  }, COORDINATOR_POLL_INTERVAL_MS);
}

// ── Phase 3: MODE branch after WS barrier ─────────────────────────────────────

function handleWsBarrierReleased(tableState) {
  if (MODE === 'websocket-only') {
    logTableSafe(tableState, 'websocket-only: WS barrier released, closing sockets cleanly');
    terminateTableLifecycle(tableState, null, false);
    return;
  }
  logTableSafe(tableState, 'WS barrier released, scheduling join_matchmaking');
  scheduleJoinMatchmaking(tableState);
}

function scheduleJoinMatchmaking(tableState) {
  const spreadMs = TABLES > 1
    ? Math.floor((tableState.tableIndex * MATCHMAKING_SPREAD_SECONDS * 1000) / (TABLES - 1))
    : 0;
  if (spreadMs > 0) {
    // Reuse wsBarrierPollTimerId — barrier polling is complete at this point
    tableState.wsBarrierPollTimerId = setTimeout(() => {
      tableState.wsBarrierPollTimerId = null;
      if (tableState.terminal) return;
      doSendJoinMatchmaking(tableState);
    }, spreadMs);
  } else {
    doSendJoinMatchmaking(tableState);
  }
}

function doSendJoinMatchmaking(tableState) {
  let sentAll = true;

  for (const player of tableState.players) {
    const ws = tableState.sockets[player.playerIndex];

    if (player.closeRequested || !player.wsConnected || !ws || ws.readyState !== WS_OPEN) {
      if (!player.closeRequested) {
        protocolErrors.add(1);
        logSafe(player, 'WS not open when sending join_matchmaking after WS barrier');
      }
      sentAll = false;
      continue;
    }

    const sent = sendProtocol(ws, player, { type: 'join_matchmaking', stake: STAKE });
    if (sent) {
      player.matchmakingJoinSent = true;
      matchmakingJoinMessagesSent.add(1);
    } else {
      sentAll = false;
      protocolErrors.add(1);
      logSafe(player, 'failed to send join_matchmaking after WS barrier');
    }
  }

  if (sentAll) {
    phasedMatchmakingReleased.add(1);  // only when ALL 4 messages sent successfully
    logTableSafe(tableState, 'join_matchmaking sent for all four players');
  } else {
    closeTable(tableState);
  }
}

function reportTableFailureOnce(tableState, playerIndex, phase, reason) {
  if (tableState.failureReported) {
    return;
  }
  tableState.failureReported = true;
  coordinatorPost(
    `${COORDINATOR_URL}/failure${coordQs()}`,
    JSON.stringify({ tableIndex: tableState.globalTableIndex, playerIndex, phase, reason }),
  );
}

// ── Gameplay handlers (identical to multi-table-load.js) ──────────────────────

function handleMatchFound(tableState, state, message) {
  if (!message.roomId || !message.seat) {
    protocolErrors.add(1);
    logSafe(state, 'match_found is missing roomId or seat');
    closeTable(tableState);
    return;
  }

  state.matchFoundRoomId = message.roomId;
  state.roomId = message.roomId;
  state.seat = message.seat;
  if (message.humanPlayers !== PLAYERS_PER_TABLE || message.botPlayers !== 0) {
    protocolErrors.add(1);
    logSafe(
      state,
      `match_found is not full human match humanPlayers=${message.humanPlayers} botPlayers=${message.botPlayers}`,
    );
    closeTable(tableState);
    return;
  }
  if (!state.matchmakingCounted) {
    matchmakingSuccess.add(1);
    state.matchmakingCounted = true;
  }
  if (!state.fullHumanMatchCounted) {
    fullHumanMatchSuccess.add(1);
    state.fullHumanMatchCounted = true;
  }
  if (state.latestSnapshot && state.latestSnapshot.roomId !== state.matchFoundRoomId) {
    protocolErrors.add(1);
    logSafe(state, 'match_found roomId does not match this player room_snapshot roomId');
    closeTable(tableState);
    return;
  }
  logSafe(state, 'match found');
  maybeCountControllerReady(tableState);
  maybeStartTableGameplay(tableState, 'match_found');
}

function handleRoomSnapshot(ws, tableState, state, message) {
  roomSnapshotsReceived.add(1);

  if (!message.roomId || !message.yourSeat) {
    protocolErrors.add(1);
    logSafe(state, 'room_snapshot is missing roomId or yourSeat');
    return;
  }

  if (state.matchFoundRoomId && message.roomId !== state.matchFoundRoomId) {
    protocolErrors.add(1);
    logSafe(state, 'room_snapshot roomId does not match this player match_found roomId');
    closeTable(tableState);
    return;
  }

  state.latestSnapshot = message;
  state.roomId = message.roomId;
  state.seat = message.yourSeat;
  state.reconnectToken = message.reconnectToken || state.reconnectToken;
  maybeCountHumanSeatTakeover(state, message);

  if (!state.roomJoinedCounted && state.roomId && state.seat) {
    roomsJoined.add(1);
    state.roomJoinedCounted = true;
    logSafe(state, 'room joined');
  }

  if (message.roomStatus && message.roomStatus !== state.lastRoomStatus) {
    state.lastRoomStatus = message.roomStatus;
    logSafe(state, `room status ${message.roomStatus}`);
  }

  const game = message.game;
  if (!game) {
    maybeCountControllerReady(tableState);
    maybeStartTableGameplay(tableState, 'room_snapshot_without_game');
    return;
  }

  const phase = game.authoritativePhase || game.phase || 'unknown';
  if (phase !== state.lastPhase) {
    state.phaseSequence += 1;
    state.lastPhase = phase;
    logSafe(state, `phase ${phase}`, true);
  }

  const wasStarted = tableState.gameplayStarted;
  maybeCountControllerReady(tableState);
  maybeStartTableGameplay(tableState, 'room_snapshot');

  if (!tableState.gameplayStarted || !wasStarted) {
    return;
  }

  processGameplaySnapshot(ws, state, message, game);
}

function processGameplaySnapshot(ws, state, message, game) {
  if (game.authoritativePhase === 'match-ended' || game.phase === 'match-ended') {
    clearActionInFlight(state);
    if (!game.matchEnded || typeof game.matchEnded !== 'object') {
      protocolErrors.add(1);
      logSafe(state, 'match-ended phase is missing game.matchEnded snapshot');
      safeClose(ws, state);
      return;
    }
    handleMatchEnded(ws, state, message, game);
    return;
  }

  updateActionInFlightFromSnapshot(state);
  maybeSubmitCut(ws, state, message, game);
  maybeSubmitBid(ws, state, message, game);
  maybeSubmitPlay(ws, state, message, game);
}

function handleMatchEnded(ws, state, message, game) {
  const leaveVotes = game.matchEnded && Array.isArray(game.matchEnded.leaveVotes)
    ? game.matchEnded.leaveVotes
    : [];

  if (!state.completionCounted && state.seat && leaveVotes.indexOf(state.seat) !== -1) {
    cancelLeaveRetry(state);
    matchesCompleted.add(1);
    state.completionCounted = true;
    logSafe(state, 'match completion confirmed');
    setTimeout(() => safeClose(ws, state), 250);
    return;
  }

  if (!state.leaveVoteSent) {
    const sent = sendProtocol(ws, state, {
      type: 'request_leave_match',
      roomId: message.roomId,
    });
    if (sent) {
      state.leaveVoteSent = true;
      logSafe(state, 'leave requested after match-ended');
      scheduleLeaveRetry(ws, state, message.roomId);
    }
  }
}

// ── Gameplay action submission (identical to multi-table-load.js) ──────────────

function maybeSubmitCut(ws, state, message, game) {
  const cutting = game.cutting;
  if (!cutting || cutting.canSubmitCut !== true || cutting.selectedCutIndex != null) {
    return;
  }

  const cutIndex = chooseCutIndex(cutting.deckCount);
  if (cutIndex === null) {
    protocolErrors.add(1);
    logSafe(state, `cannot choose valid cut index from deckCount ${cutting.deckCount}`);
    return;
  }

  const key = cutActionKey(state, message, cutting);
  scheduleGameplayAction(ws, state, {
    actionType: 'cut',
    roomId: message.roomId,
    key,
    payload: { type: 'submit_cut_index', roomId: message.roomId, cutIndex },
    timerDeadlineAt: game.timerDeadlineAt,
    phase: game.authoritativePhase || game.phase || state.lastPhase,
    cutIndex,
    delayMs: randomDelayMs(CUT_DELAY_MIN_MS, CUT_DELAY_MAX_MS),
  });
}

function maybeSubmitBid(ws, state, message, game) {
  const bidding = game.bidding;
  if (!bidding || bidding.canSubmitBid !== true || bidding.currentBidderSeat !== message.yourSeat) {
    return;
  }

  const action = chooseBidAction(state, bidding, true);
  if (action === null) {
    return;
  }

  const key = bidActionKey(state, message, bidding);
  scheduleGameplayAction(ws, state, {
    actionType: 'bid',
    roomId: message.roomId,
    key,
    payload: { type: 'submit_bid_action', roomId: message.roomId, action },
    timerDeadlineAt: game.timerDeadlineAt,
    phase: game.authoritativePhase || game.phase || state.lastPhase,
    bidActionType: action.type,
    delayMs: randomDelayMs(BID_DELAY_MIN_MS, BID_DELAY_MAX_MS),
  });
}

function maybeSubmitPlay(ws, state, message, game) {
  const playing = game.playing;
  if (!playing || playing.currentTurnSeat !== message.yourSeat) {
    return;
  }

  const validCardIds = Array.isArray(playing.validCardIds) ? playing.validCardIds : [];
  if (validCardIds.length === 0) {
    protocolErrors.add(1);
    logSafe(state, 'current turn snapshot has no validCardIds');
    return;
  }

  const cardId = validCardIds[0];
  const key = playActionKey(state, message, playing, validCardIds);
  scheduleGameplayAction(ws, state, {
    actionType: 'play',
    roomId: message.roomId,
    key,
    payload: { type: 'submit_play_card', roomId: message.roomId, cardId, declarationKeys: [] },
    timerDeadlineAt: game.timerDeadlineAt,
    phase: game.authoritativePhase || game.phase || state.lastPhase,
    cardId,
    delayMs: randomDelayMs(PLAY_DELAY_MIN_MS, PLAY_DELAY_MAX_MS),
  });
}

function scheduleGameplayAction(ws, state, action) {
  if (state.actionInFlight !== null || state.sentActionKeys[action.key]) {
    return;
  }

  const effectiveDelayMs = clampDelayToTimerDeadline(action.delayMs, action.timerDeadlineAt);
  const scheduledAction = {
    actionType: action.actionType,
    roomId: action.roomId,
    key: action.key,
    payload: action.payload,
    timerDeadlineAt: action.timerDeadlineAt,
    phase: action.phase,
    cutIndex: Number.isInteger(action.cutIndex) ? action.cutIndex : null,
    bidActionType: action.bidActionType || null,
    cardId: action.cardId || null,
    timeoutId: null,
    sent: false,
    sentAtMs: null,
  };

  scheduledAction.timeoutId = setTimeout(() => {
    executeScheduledGameplayAction(ws, state, scheduledAction);
  }, effectiveDelayMs);

  state.actionInFlight = scheduledAction;
}

function executeScheduledGameplayAction(ws, state, action) {
  if (state.actionInFlight !== action) {
    return;
  }

  action.timeoutId = null;

  if (!isScheduledActionStillValid(state, action)) {
    state.actionInFlight = null;
    return;
  }

  const sent = sendOnce(ws, state, action.key, action.payload);
  if (!sent) {
    state.actionInFlight = null;
    return;
  }

  action.sent = true;
  action.sentAtMs = Date.now();

  if (REJECTED_ACTION_DIAGNOSTICS) {
    recordGameplayAction(state, action);
  }
}

function updateActionInFlightFromSnapshot(state) {
  const action = state.actionInFlight;
  if (action === null || isScheduledActionStillValid(state, action)) {
    return;
  }
  clearActionInFlight(state);
}

function clearActionInFlight(state) {
  const action = state.actionInFlight;
  if (action && action.timeoutId !== null) {
    clearTimeout(action.timeoutId);
  }
  state.actionInFlight = null;
}

function cancelLeaveRetry(state) {
  if (state.leaveRetryTimerId !== null) {
    clearTimeout(state.leaveRetryTimerId);
    state.leaveRetryTimerId = null;
  }
}

function scheduleLeaveRetry(ws, state, roomId) {
  if (state.closed || state.completionCounted) {
    return;
  }
  const isGiveUp = state.leaveRetryCount >= LEAVE_MAX_RETRIES;
  state.leaveRetryTimerId = setTimeout(() => {
    state.leaveRetryTimerId = null;
    if (state.closed || state.completionCounted) {
      return;
    }
    if (isGiveUp) {
      protocolErrors.add(1);
      logSafe(state, `leave vote not confirmed after ${LEAVE_MAX_RETRIES} retries; closing`);
      safeClose(ws, state);
      return;
    }
    state.leaveRetryCount += 1;
    const sent = sendProtocol(ws, state, { type: 'request_leave_match', roomId });
    if (sent) {
      logSafe(state, `leave retry ${state.leaveRetryCount}/${LEAVE_MAX_RETRIES}`);
    }
    scheduleLeaveRetry(ws, state, roomId);
  }, LEAVE_RETRY_INTERVAL_MS);
}

function isScheduledActionStillValid(state, action) {
  const message = state.latestSnapshot;
  const game = message && message.game;
  if (!message || !game || message.roomId !== action.roomId) {
    return false;
  }

  const phase = game.authoritativePhase || game.phase || 'unknown';
  if (phase !== action.phase) {
    return false;
  }

  const latestTimerDeadlineAt = numericOrNull(game.timerDeadlineAt);
  const scheduledTimerDeadlineAt = numericOrNull(action.timerDeadlineAt);
  const timerDeadlineAt = latestTimerDeadlineAt === null
    ? scheduledTimerDeadlineAt
    : latestTimerDeadlineAt;
  if (timerDeadlineAt !== null && Date.now() >= timerDeadlineAt) {
    return false;
  }

  if (action.actionType === 'cut') {
    return isCutActionStillValid(state, action, message, game);
  }
  if (action.actionType === 'bid') {
    return isBidActionStillValid(state, action, message, game);
  }
  if (action.actionType === 'play') {
    return isPlayActionStillValid(state, action, message, game);
  }

  return false;
}

function isCutActionStillValid(state, action, message, game) {
  const cutting = game.cutting;
  if (!cutting || cutting.canSubmitCut !== true || cutting.selectedCutIndex != null) {
    return false;
  }
  const cutIndex = chooseCutIndex(cutting.deckCount);
  return cutIndex === action.cutIndex && cutActionKey(state, message, cutting) === action.key;
}

function isBidActionStillValid(state, action, message, game) {
  const bidding = game.bidding;
  if (!bidding || bidding.canSubmitBid !== true || bidding.currentBidderSeat !== message.yourSeat) {
    return false;
  }
  const bidAction = chooseBidAction(state, bidding, false);
  return (
    bidAction !== null
    && bidAction.type === action.bidActionType
    && stableStringify(bidAction) === stableStringify(action.payload.action)
    && bidActionKey(state, message, bidding) === action.key
  );
}

function isPlayActionStillValid(state, action, message, game) {
  const playing = game.playing;
  if (!playing || playing.currentTurnSeat !== message.yourSeat) {
    return false;
  }
  const validCardIds = Array.isArray(playing.validCardIds) ? playing.validCardIds : [];
  return (
    validCardIds.indexOf(action.cardId) !== -1
    && playActionKey(state, message, playing, validCardIds) === action.key
  );
}

// ── Action key builders ────────────────────────────────────────────────────────

function cutActionKey(state, message, cutting) {
  return [
    message.roomId,
    'cutting',
    state.phaseSequence,
    cutting.cutterSeat || '',
    cutting.deckCount,
  ].join('|');
}

function bidActionKey(state, message, bidding) {
  return [
    message.roomId,
    'bidding',
    state.phaseSequence,
    bidding.currentBidderSeat || '',
    Array.isArray(bidding.entries) ? bidding.entries.length : 0,
    stableStringify(bidding.winningBid),
  ].join('|');
}

function playActionKey(state, message, playing, validCardIds) {
  return [
    message.roomId,
    'playing',
    state.phaseSequence,
    playing.currentTurnSeat || '',
    playing.completedTricksCount,
    Array.isArray(playing.currentTrickPlays) ? playing.currentTrickPlays.length : 0,
    validCardIds.join(','),
  ].join('|');
}

// ── Bid / cut choosers ─────────────────────────────────────────────────────────

function chooseBidAction(state, bidding, logMissingSuit) {
  const validActions = bidding.validActions || {};
  const hasNonPassBid = bidding.winningBid != null || hasNonPassBidEntry(bidding.entries);

  if (!hasNonPassBid) {
    const action = firstValidSuitAction(validActions.suits);
    if (action === null && logMissingSuit) {
      protocolErrors.add(1);
      logSafe(state, 'no valid suit bid available before first non-pass bid');
    }
    return action;
  }

  if (validActions.pass === true) {
    return { type: 'pass' };
  }

  return null;
}

function chooseCutIndex(deckCount) {
  if (!Number.isInteger(deckCount) || deckCount <= 2) {
    return null;
  }
  return Math.max(1, Math.min(deckCount - 1, Math.floor(deckCount / 2)));
}

// ── Controller / gameplay start ────────────────────────────────────────────────

function maybeCountHumanSeatTakeover(state, message) {
  if (state.takeoverCounted || !message || !message.yourSeat) {
    return;
  }
  const seatSnapshot = findSeatSnapshot(message.seats, message.yourSeat);
  if (!seatSnapshot || seatSnapshot.isControlledByBot !== true) {
    return;
  }
  state.takeoverCounted = true;
  humanSeatTakeovers.add(1);
  logSafe(state, 'human seat was taken over by server bot control');
}

function findSeatSnapshot(seats, seat) {
  if (!seats || !seat) {
    return null;
  }
  if (Array.isArray(seats)) {
    return seats.find((entry) => (
      entry
      && typeof entry === 'object'
      && (entry.seat === seat || entry.position === seat || entry.id === seat)
    )) || null;
  }
  if (typeof seats === 'object') {
    const directSeat = seats[seat];
    if (directSeat && typeof directSeat === 'object') {
      return directSeat;
    }
    for (const value of Object.values(seats)) {
      if (
        value
        && typeof value === 'object'
        && (value.seat === seat || value.position === seat || value.id === seat)
      ) {
        return value;
      }
    }
  }
  return null;
}

function maybeCountControllerReady(tableState) {
  if (tableState.controllerReadyCounted || !controllerHasFourPlayersReady(tableState)) {
    return;
  }
  tableState.controllerReadyCounted = true;
  logTableSafe(tableState, 'four local full-human players have match_found and room_snapshot');
}

function controllerHasFourPlayersReady(tableState) {
  return tableState.players.every((player) => (
    player.fullHumanMatchCounted
    && player.roomJoinedCounted
    && player.matchFoundRoomId
    && player.roomId
    && player.seat
    && player.latestSnapshot
    && player.latestSnapshot.roomId
    && player.latestSnapshot.yourSeat
    && player.latestSnapshot.roomId === player.matchFoundRoomId
  ));
}

function maybeStartTableGameplay(tableState, reason) {
  if (tableState.gameplayStarted || !controllerHasFourPlayersReady(tableState)) {
    return;
  }
  tableState.gameplayStarted = true;
  logTableSafe(tableState, `local gameplay started by ${reason}`);

  for (const player of tableState.players) {
    const ws = tableState.sockets[player.playerIndex];
    const snapshot = player.latestSnapshot;
    if (!ws || !snapshot || !snapshot.game) {
      continue;
    }
    processGameplaySnapshot(ws, player, snapshot, snapshot.game);
  }
}

// ── Send helpers ───────────────────────────────────────────────────────────────

function closeTable(tableState) {
  terminalTableFailure(tableState, null, 'local terminal WebSocket failure');
}

function terminateTableLifecycle(tableState, failureReason, wsBarrierFailed) {
  beginTableTermination(tableState, wsBarrierFailed);
  if (failureReason !== null && failureReason !== undefined) {
    abortTestOnce(tableState, failureReason);
    return;
  }
  scheduleCleanupWatchdog(tableState);
  maybeCompleteTableCleanup(tableState);
}

function beginTableTermination(tableState, wsBarrierFailed) {
  if (!tableState.cleanupStarted) {
    tableState.terminal = true;
    tableState.cleanupStarted = true;
    tableState.wsBarrierFailed = tableState.wsBarrierFailed || wsBarrierFailed;
    clearTableLifecycleTimers(tableState);

    for (const player of tableState.players) {
      player.attemptGeneration += 1;
      player.attemptActive = false;
      player.attemptFailed = true;
      player.wsConnected = false;
      player.closeRequested = true;
      if (player.retryTimerId !== null) clearTimeout(player.retryTimerId);
      if (player.runTimeoutId !== null) clearTimeout(player.runTimeoutId);
      player.retryTimerId = null;
      player.runTimeoutId = null;
      clearActionInFlight(player);
      cancelLeaveRetry(player);
    }
  }

  for (const attempt of Array.from(tableState.socketAttempts)) {
    clearAttemptTimers(attempt);
    closeTrackedAttempt(tableState, attempt);
  }
  maybeCompleteTableCleanup(tableState);
}

function abortTestOnce(tableState, reason) {
  if (tableState.abortInitiated) return;
  tableState.abortInitiated = true;
  tableState.abortReason = safeString(reason || 'terminal WebSocket failure');
  if (tableState.cleanupWatchdogTimerId !== null) {
    clearTimeout(tableState.cleanupWatchdogTimerId);
    tableState.cleanupWatchdogTimerId = null;
  }
  exec.test.abort(tableState.abortReason);
}

function clearTableLifecycleTimers(tableState) {
  clearWsBarrierTimer(tableState);
  if (tableState.connectDeadlineTimerId !== null) clearTimeout(tableState.connectDeadlineTimerId);
  if (tableState.globalFailurePollTimerId !== null) clearTimeout(tableState.globalFailurePollTimerId);
  tableState.connectDeadlineTimerId = null;
  tableState.globalFailurePollTimerId = null;
}

function closeTrackedAttempt(tableState, attempt) {
  if (!tableState.socketAttempts.has(attempt)) return;
  if (attempt.ws.readyState === WS_CLOSED) {
    finalizeSocketAttempt(tableState, attempt);
    return;
  }
  try {
    attempt.ws.close(1000);
  } catch (_) {
    attempt.closeFailed = true;
  }
}

function finalizeSocketAttempt(tableState, attempt) {
  if (!tableState.socketAttempts.has(attempt)) return;
  clearAttemptTimers(attempt);
  attempt.closed = true;
  tableState.socketAttempts.delete(attempt);
  if (tableState.sockets[attempt.state.playerIndex] === attempt.ws) {
    attempt.state.closed = true;
    attempt.state.attemptActive = false;
    attempt.state.wsConnected = false;
  }
  maybeCompleteTableCleanup(tableState);
}

function maybeCompleteTableCleanup(tableState) {
  if (!tableState.cleanupStarted || tableState.socketAttempts.size !== 0) return false;
  const playerTimerActive = tableState.players.some((player) => (
    player.retryTimerId !== null
    || player.attemptTimeoutId !== null
    || player.pingTimerId !== null
    || player.runTimeoutId !== null
    || player.leaveRetryTimerId !== null
    || player.actionInFlight !== null
  ));
  if (playerTimerActive || tableState.wsBarrierPollTimerId !== null
      || tableState.connectDeadlineTimerId !== null
      || tableState.globalFailurePollTimerId !== null) return false;
  if (tableState.cleanupWatchdogTimerId !== null) {
    clearTimeout(tableState.cleanupWatchdogTimerId);
    tableState.cleanupWatchdogTimerId = null;
  }
  tableState.cleanupComplete = true;
  return true;
}

function scheduleCleanupWatchdog(tableState) {
  if (tableState.cleanupComplete || tableState.abortInitiated
      || tableState.cleanupWatchdogTimerId !== null) return;
  tableState.cleanupWatchdogTimerId = setTimeout(() => {
    tableState.cleanupWatchdogTimerId = null;
    if (maybeCompleteTableCleanup(tableState)) return;
    tableState.cleanupFailed = true;
    abortTestOnce(
      tableState,
      `WebSocket cleanup watchdog expired with ${tableState.socketAttempts.size} active attempts`,
    );
  }, SOCKET_CLEANUP_WATCHDOG_MS);
}

function clearWsBarrierTimer(tableState) {
  if (tableState.wsBarrierPollTimerId !== null) {
    clearTimeout(tableState.wsBarrierPollTimerId);
    tableState.wsBarrierPollTimerId = null;
  }
}

function sendOnce(ws, state, key, payload) {
  if (state.sentActionKeys[key]) {
    return false;
  }
  const sent = sendProtocol(ws, state, payload);
  if (sent) {
    state.sentActionKeys[key] = true;
    gameplayActionsSent.add(1);
  }
  return sent;
}

function sendProtocol(ws, state, payload) {
  if (state.closed || ws.readyState !== WS_OPEN) {
    return false;
  }
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    websocketErrors.add(1);
    logSafe(state, `WebSocket send failed: ${safeString(error && error.message ? error.message : error)}`);
    return false;
  }
}

function safeClose(ws, state) {
  state.closeRequested = true;
  clearActionInFlight(state);
  cancelLeaveRetry(state);
  const tableState = state.tableState;
  const attempt = tableState ? findSocketAttempt(tableState, ws) : null;
  if (attempt) closeTrackedAttempt(tableState, attempt);
  else closeSocket(ws);
}

function closeSocket(ws) {
  if (!ws || ws.readyState === WS_CLOSED) return;
  try { ws.close(1000); } catch (_) { /* stale/connecting sockets may already be closing */ }
}

// ── Coordinator HTTP helpers ───────────────────────────────────────────────────

function coordQs() {
  return `?runId=${RUN_ID}`;
}

function coordinatorPost(url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (COORDINATOR_TOKEN) headers['X-Belot-Load-Token'] = COORDINATOR_TOKEN;
  const resp = http.post(url, body, {
    headers,
    timeout: '10s',
    tags: { name: 'coordinator' },
  });
  return { status: resp.status, body: parseJson(resp.body) };
}

function coordinatorGet(url) {
  const params = { timeout: '5s', tags: { name: 'coordinator' } };
  if (COORDINATOR_TOKEN) params.headers = { 'X-Belot-Load-Token': COORDINATOR_TOKEN };
  const resp = http.get(url, params);
  return { status: resp.status, body: parseJson(resp.body) };
}

// ── Diagnostics ────────────────────────────────────────────────────────────────

function recordGameplayAction(state, details) {
  if (!REJECTED_ACTION_DIAGNOSTICS) {
    return;
  }
  const sentAtMs = Date.now();
  const timerDeadlineAt = numericOrNull(details.timerDeadlineAt);
  state.recentGameplayActions.push({
    actionType: details.actionType,
    roomId: details.roomId,
    seat: state.seat,
    player: state.playerIndex + 1,
    key: details.key,
    sentAtMs,
    timerDeadlineAt,
    msBeforeDeadlineAtSend: timerDeadlineAt === null ? null : timerDeadlineAt - sentAtMs,
    phase: details.phase || state.lastPhase || '-',
    cardId: details.cardId || null,
    bidActionType: details.bidActionType || null,
    cutIndex: Number.isInteger(details.cutIndex) ? details.cutIndex : null,
  });
  if (state.recentGameplayActions.length > 6) {
    state.recentGameplayActions.shift();
  }
}

function logRejectedActionDiagnostic(state, message) {
  const now = Date.now();
  const recentActions = (state.recentGameplayActions || [])
    .slice()
    .reverse()
    .map((action) => {
      const timerDeadlineAt = numericOrNull(action.timerDeadlineAt);
      return {
        actionType: action.actionType || null,
        roomId: action.roomId || null,
        phase: action.phase || null,
        key: action.key || null,
        sentAtMs: numericOrNull(action.sentAtMs),
        actionAgeMs: Number.isFinite(action.sentAtMs) ? now - action.sentAtMs : null,
        timerDeadlineAt,
        msBeforeDeadlineAtSend: numericOrNull(action.msBeforeDeadlineAtSend),
        msAfterDeadlineAtError: timerDeadlineAt === null ? null : now - timerDeadlineAt,
        cardId: action.cardId || null,
        bidActionType: action.bidActionType || null,
        cutIndex: numericOrNull(action.cutIndex),
      };
    });

  console.log(
    `rejected-action-diagnostic ${JSON.stringify({
      error: String(message.message || message.code || 'unknown'),
      now,
      room: state.roomId || null,
      seat: state.seat || null,
      phase: state.lastPhase || null,
      vu: state.vu,
      table: state.tableIndex + 1,
      player: state.playerIndex + 1,
      recentActions,
    })}`,
  );
}

// ── Summary formatting ─────────────────────────────────────────────────────────

function formatTextSummary(data) {
  const metrics = data && data.metrics ? data.metrics : {};
  const metricNames = Object.keys(metrics).sort();
  const thresholdNames = metricNames.filter((name) => metrics[name].thresholds);
  const importantNames = [
    'checks',
    'http_req_failed',
    'http_req_duration',
    'login_failures',
    'websocket_errors',
    'websocket_connect_attempts',
    'websocket_first_attempt_failures',
    'websocket_retry_attempts',
    'websocket_recovered_after_retry',
    'websocket_retry_exhausted',
    'websocket_connect_deadline_exceeded',
    'websocket_terminal_failures',
    'protocol_errors',
    'rejected_actions',
    'human_seat_takeovers',
    'websocket_connections_ready',
    'tables_with_four_websockets_ready',
    'matchmaking_join_messages_sent',
    'matchmaking_success',
    'full_human_match_success',
    'rooms_joined',
    'matches_completed',
    'gameplay_actions_sent',
    'phased_login_players_ready',
    'phased_login_tables_ready',
    'phased_login_barrier_reached',
    'phased_login_barrier_timeout',
    'phased_login_barrier_failed',
    'phased_websocket_players_ready',
    'phased_websocket_tables_ready',
    'phased_websocket_barrier_reached',
    'phased_websocket_barrier_timeout',
    'phased_websocket_barrier_failed',
    'phased_matchmaking_released',
  ].filter((name) => metrics[name]);
  const names = uniqueStrings(importantNames.concat(thresholdNames));
  const lines = ['', 'k6 phased summary', ''];

  for (const name of names) {
    lines.push(`${name}: ${formatMetricValues(metrics[name].values || {})}`);
  }

  if (thresholdNames.length > 0) {
    lines.push('');
    lines.push('thresholds:');
    for (const name of thresholdNames) {
      const thresholds = metrics[name].thresholds || {};
      for (const expression of Object.keys(thresholds).sort()) {
        const threshold = thresholds[expression];
        const ok = threshold && threshold.ok === true ? 'ok' : 'failed';
        lines.push(`  ${name} ${expression}: ${ok}`);
      }
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function formatMetricValues(values) {
  const preferredOrder = ['count', 'rate', 'value', 'avg', 'min', 'med', 'p(90)', 'p(95)', 'max'];
  const parts = [];

  for (const key of preferredOrder) {
    if (values[key] !== undefined) {
      parts.push(`${key}=${formatMetricNumber(values[key])}`);
    }
  }

  for (const key of Object.keys(values).sort()) {
    if (preferredOrder.indexOf(key) === -1) {
      parts.push(`${key}=${formatMetricNumber(values[key])}`);
    }
  }

  return parts.length > 0 ? parts.join(' ') : '-';
}

function formatMetricNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(Math.round(value * 1000) / 1000);
}

function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    if (result.indexOf(value) === -1) {
      result.push(value);
    }
  }
  return result;
}

// ── Scenario creation ──────────────────────────────────────────────────────────

function createScenarios() {
  const scenarios = {};

  for (let tableIndex = 0; tableIndex < TABLES; tableIndex += 1) {
    const startDelayMs = Math.floor((tableIndex * LOGIN_SPREAD_SECONDS * 1000) / TABLES);
    const name = `table_${String(tableIndex + 1).padStart(3, '0')}`;

    scenarios[name] = {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      startTime: `${startDelayMs}ms`,
      maxDuration: `${Math.ceil(
        LOGIN_SPREAD_SECONDS
        + LOGIN_BARRIER_TIMEOUT_SECONDS
        + WS_CONNECT_SPREAD_SECONDS
        + WS_BARRIER_TIMEOUT_SECONDS
        + (MODE === 'full' ? MATCHMAKING_SPREAD_SECONDS + MATCH_RUNTIME_TIMEOUT_SECONDS : 0)
        + 120,
      )}s`,
      gracefulStop: '5s',
      env: {
        TABLE_INDEX: String(tableIndex),
      },
    };
  }

  return scenarios;
}

// ── Threshold builder ─────────────────────────────────────────────────────────

function buildThresholds() {
  const t = {
    login_failures: ['count==0'],
    protocol_errors: ['count==0'],
    rejected_actions: ['count==0'],
    human_seat_takeovers: ['count==0'],
    websocket_connections_ready: ['count==' + String(REQUIRED_USERS)],
    tables_with_four_websockets_ready: ['count==' + String(TABLES)],
    phased_login_players_ready: ['count==' + String(REQUIRED_USERS)],
    phased_login_tables_ready: ['count==' + String(TABLES)],
    phased_login_barrier_reached: ['count==' + String(TABLES)],
    phased_login_barrier_timeout: ['count==0'],
    phased_login_barrier_failed: ['count==0'],
    phased_websocket_players_ready: ['count==' + String(REQUIRED_USERS)],
    phased_websocket_tables_ready: ['count==' + String(TABLES)],
    phased_websocket_barrier_reached: ['count==' + String(TABLES)],
    phased_websocket_barrier_timeout: ['count==0'],
    phased_websocket_barrier_failed: ['count==0'],
    websocket_retry_exhausted: ['count==0'],
    websocket_connect_deadline_exceeded: ['count==0'],
    websocket_terminal_failures: ['count==0'],
  };
  if (MODE === 'full') {
    t.matchmaking_join_messages_sent = ['count==' + String(REQUIRED_USERS)];
    t.matchmaking_success = ['count==' + String(REQUIRED_USERS)];
    t.full_human_match_success = ['count==' + String(REQUIRED_USERS)];
    t.rooms_joined = ['count==' + String(REQUIRED_USERS)];
    t.matches_completed = ['count==' + String(REQUIRED_USERS)];
    t.phased_matchmaking_released = ['count==' + String(TABLES)];
  }
  return t;
}

// ── Utility functions ──────────────────────────────────────────────────────────

function tableIndexForVu(vu) {
  const index = Number(__ENV.TABLE_INDEX);
  if (!Number.isInteger(index) || index < 0 || index >= TABLES) {
    fail(`VU ${vu}: invalid scenario TABLE_INDEX; expected 0..${TABLES - 1}`);
  }
  return index;
}

function accountForTablePlayer(tableIndex, playerIndex) {
  const userIndex = (tableIndex * PLAYERS_PER_TABLE) + playerIndex;
  const user = USERS[userIndex];
  if (!user || !user.email || !user.password) {
    fail(`VU ${__VU}: missing email or password in credentials file for user index ${userIndex}`);
  }
  return { userIndex, email: user.email, password: user.password };
}

function createPlayerState(tableIndex, playerIndex, account, jar) {
  return {
    vu: __VU,
    tableIndex,
    playerIndex,
    userIndex: account.userIndex,
    jar,
    roomId: null,
    matchFoundRoomId: null,
    seat: null,
    reconnectToken: null,
    lastPhase: null,
    phaseSequence: 0,
    lastRoomStatus: null,
    wsConnected: false,
    wsConnectedAtMs: null,
    wsReadyCounted: false,
    recoveryCounted: false,
    attempts: 0,
    attemptGeneration: 0,
    attemptActive: false,
    attemptFailed: false,
    attemptTimeoutId: null,
    retryTimerId: null,
    pingTimerId: null,
    runTimeoutId: null,
    matchmakingJoinSent: false,
    matchmakingCounted: false,
    fullHumanMatchCounted: false,
    roomJoinedCounted: false,
    leaveVoteSent: false,
    leaveRetryTimerId: null,
    leaveRetryCount: 0,
    completionCounted: false,
    takeoverCounted: false,
    closed: false,
    closeRequested: false,
    latestSnapshot: null,
    actionInFlight: null,
    recentGameplayActions: REJECTED_ACTION_DIAGNOSTICS ? [] : null,
    sentActionKeys: {},
  };
}

function login(account, jar) {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: account.email, password: account.password }),
    {
      jar,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      tags: { name: 'auth_login' },
    },
  );

  const body = parseJson(res.body);
  const ok = check(res, {
    'login status is 200': (r) => r.status === 200,
    'login response is ok': () => body !== null && body.ok === true,
    'login returned session profile': () => body !== null && body.session !== undefined,
  });

  if (!ok) {
    loginFailures.add(1);
    fail(`VU ${__VU}: login failed for user index ${account.userIndex}`);
  }

  const cookies = jar.cookiesForURL(BASE_URL);
  const sessionCookies = cookies ? cookies.belot_session : null;
  if (!sessionCookies || sessionCookies.length === 0) {
    loginFailures.add(1);
    fail(`VU ${__VU}: login ok for user index ${account.userIndex} but belot_session cookie missing`);
  }
}

function validateStake(jar) {
  const res = http.get(`${BASE_URL}/api/rooms`, {
    jar,
    headers: { Accept: 'application/json' },
    tags: { name: 'rooms' },
  });

  const body = parseJson(res.body);
  const rooms = body !== null && Array.isArray(body.rooms) ? body.rooms : [];
  const stakeRoom = rooms.find((room) => Number(room.stakeAmount) === STAKE);
  const stakeEnabled = stakeRoom && (stakeRoom.isEnabled === true || stakeRoom.isEnabled === 1);

  const ok = check(res, {
    'rooms status is 200': (r) => r.status === 200,
    'rooms response is ok': () => body !== null && body.ok === true,
    'stake exists and is enabled': () => Boolean(stakeEnabled),
  });

  if (!ok) {
    protocolErrors.add(1);
    fail(`VU ${__VU}: stake ${STAKE} is not available or not enabled`);
  }
}

function loadUsers() {
  const raw = open('./loadtest-users.json.local');
  const parsed = parseJson(raw);

  if (!parsed || !Array.isArray(parsed.users)) {
    throw new Error('loadtest-users.json.local must have the structure: { "users": [...] }');
  }

  const needed = CREDENTIAL_START + REQUIRED_USERS;
  if (parsed.users.length < needed) {
    throw new Error(
      `loadtest-users.json.local must contain at least ${needed} users `
      + `(TABLE_OFFSET=${TABLE_OFFSET}, TABLES=${TABLES})`,
    );
  }

  for (let i = CREDENTIAL_START; i < needed; i += 1) {
    const user = parsed.users[i];
    if (!user || typeof user.email !== 'string' || user.email.trim() === '') {
      throw new Error(`User at index ${i} is missing email`);
    }
    if (!user || typeof user.password !== 'string' || user.password === '') {
      throw new Error(`User at index ${i} is missing password`);
    }
  }

  return parsed.users.slice(CREDENTIAL_START, needed);
}

// ── General utilities ──────────────────────────────────────────────────────────

function parseTables(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600) {
    throw new Error('TABLES must be an integer between 1 and 600');
  }
  return parsed;
}

function parseTableOffset(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('TABLE_OFFSET must be a non-negative integer');
  }
  return parsed;
}

function parseSeconds(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function parseMilliseconds(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer number of milliseconds`);
  }
  return parsed;
}

function parsePositiveSeconds(value, name) {
  const parsed = parseSeconds(value, name);
  if (parsed <= 0) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function validateDelayRange(name, minMs, maxMs) {
  if (minMs > maxMs) {
    throw new Error(`${name}_MIN_MS must be less than or equal to ${name}_MAX_MS`);
  }
}

function randomDelayMs(minMs, maxMs) {
  if (minMs === maxMs) {
    return minMs;
  }
  return minMs + Math.floor(Math.random() * ((maxMs - minMs) + 1));
}

function clampDelayToTimerDeadline(requestedDelayMs, timerDeadlineAtValue) {
  const timerDeadlineAt = numericOrNull(timerDeadlineAtValue);
  if (timerDeadlineAt === null) {
    return Math.max(0, requestedDelayMs);
  }
  const maximumSafeDelayMs = timerDeadlineAt - Date.now() - ACTION_DEADLINE_SAFETY_MS;
  if (maximumSafeDelayMs <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(requestedDelayMs, maximumSafeDelayMs));
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function stableStringify(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}

function trimTrailingSlashes(value) {
  return String(value).replace(/\/+$/, '');
}

function safeString(value) {
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 180);
}

function logSafe(state, message, isPhaseTransition = false) {
  if (isPhaseTransition && !LOG_PHASE_TRANSITIONS) {
    return;
  }
  const room = state.roomId || '-';
  const seat = state.seat || '-';
  const phase = state.lastPhase || '-';
  console.log(
    `VU ${state.vu}: table=${state.tableIndex + 1} player=${state.playerIndex + 1} `
    + `room=${room} seat=${seat} phase=${phase} ${message}`,
  );
}

function logTableSafe(tableState, message) {
  console.log(`VU ${tableState.vu}: table=${tableState.globalTableIndex + 1} ${message}`);
}

function logTable(tableIndex, message) {
  console.log(`VU ${__VU}: table=${TABLE_OFFSET + tableIndex + 1} ${message}`);
}

function firstValidSuitAction(suits) {
  if (!suits || typeof suits !== 'object') {
    return null;
  }
  const order = ['clubs', 'diamonds', 'hearts', 'spades'];
  for (const suit of order) {
    if (suits[suit] === true) {
      return { type: 'suit', suit };
    }
  }
  return null;
}

function hasNonPassBidEntry(entries) {
  if (!Array.isArray(entries)) {
    return false;
  }
  return entries.some((entry) => {
    const action = entry && entry.action;
    return action && action.type && action.type !== 'pass';
  });
}
