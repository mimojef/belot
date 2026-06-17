import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Gauge } from 'k6/metrics';
import { sleep } from 'k6';
import { WebSocket } from 'k6/websockets';

const TABLES = parseTables(__ENV.TABLES);
const PLAYERS_PER_TABLE = 4;
const REQUIRED_USERS = TABLES * PLAYERS_PER_TABLE;
const USERS = loadUsers();
const LOGIN_SPREAD_SECONDS = parseSeconds(__ENV.LOGIN_SPREAD_SECONDS || '60', 'LOGIN_SPREAD_SECONDS');
const MATCHMAKING_BARRIER_SECONDS = parseSeconds(
  __ENV.MATCHMAKING_BARRIER_SECONDS || '120',
  'MATCHMAKING_BARRIER_SECONDS',
);
const WS_CONNECT_SPREAD_SECONDS = parseSeconds(__ENV.WS_CONNECT_SPREAD_SECONDS || '180', 'WS_CONNECT_SPREAD_SECONDS');
const WS_READY_BUFFER_SECONDS = parseSeconds(__ENV.WS_READY_BUFFER_SECONDS || '30', 'WS_READY_BUFFER_SECONDS');
const HEALTH_BARRIER_TIMEOUT_SECONDS = parseSeconds(
  __ENV.HEALTH_BARRIER_TIMEOUT_SECONDS || '15',
  'HEALTH_BARRIER_TIMEOUT_SECONDS',
);
const REQUIRED_ACTIVE_ROOMS = parseRequiredActiveRooms(__ENV.REQUIRED_ACTIVE_ROOMS || String(TABLES));
const SUMMARY_JSON_PATH = __ENV.SUMMARY_JSON_PATH || 'multi-table-load-summary.json';

export const options = {
  scenarios: createScenarios(),
  thresholds: {
    login_failures: ['count==0'],
    websocket_errors: ['count==0'],
    protocol_errors: ['count==0'],
    rejected_actions: ['count==0'],
    websocket_connections_ready: [`count==${REQUIRED_USERS}`],
    tables_with_four_websockets_ready: [`count==${TABLES}`],
    matchmaking_join_messages_sent: [`count==${REQUIRED_USERS}`],
    tables_missing_websockets_at_join_barrier: ['count==0'],
    health_barrier_reached: [`count==${TABLES}`],
    health_barrier_timeout: ['count==0'],
    matchmaking_success: [`count==${REQUIRED_USERS}`],
    full_human_match_success: [`count==${REQUIRED_USERS}`],
    rooms_joined: [`count==${REQUIRED_USERS}`],
    matches_completed: [`count==${REQUIRED_USERS}`],
  },
};

const loginFailures = new Counter('login_failures');
const websocketErrors = new Counter('websocket_errors');
const protocolErrors = new Counter('protocol_errors');
const matchmakingSuccess = new Counter('matchmaking_success');
const fullHumanMatchSuccess = new Counter('full_human_match_success');
const roomsJoined = new Counter('rooms_joined');
const rejectedActions = new Counter('rejected_actions');
const matchesCompleted = new Counter('matches_completed');
const roomSnapshotsReceived = new Counter('room_snapshots_received');
const gameplayActionsSent = new Counter('gameplay_actions_sent');
const websocketConnectionsReady = new Counter('websocket_connections_ready');
const tablesWithFourWebsocketsReady = new Counter('tables_with_four_websockets_ready');
const matchmakingJoinMessagesSent = new Counter('matchmaking_join_messages_sent');
const tablesMissingWebsocketsAtJoinBarrier = new Counter('tables_missing_websockets_at_join_barrier');
const healthBarrierReached = new Counter('health_barrier_reached');
const healthBarrierTimeout = new Counter('health_barrier_timeout');
const controllersWithFourPlayersReady = new Counter('controllers_with_four_players_ready');
const healthActiveRoomsObserved = new Gauge('health_active_rooms_observed');

const BASE_URL = trimTrailingSlashes(__ENV.BASE_URL || 'https://www.pika.bg');
const WS_URL = __ENV.WS_URL || 'wss://www.pika.bg/ws';
const ORIGIN = BASE_URL;
const STAKE = Number(__ENV.STAKE || '5000');
const RUN_TIMEOUT_MS = (
  (29 * 60)
  + WS_CONNECT_SPREAD_SECONDS
  + WS_READY_BUFFER_SECONDS
  + HEALTH_BARRIER_TIMEOUT_SECONDS
) * 1000;
const PING_INTERVAL_MS = 20 * 1000;
const HEALTH_POLL_INTERVAL_MS = 1000;
const WS_OPEN = 1;
const LOG_PHASE_TRANSITIONS = TABLES <= 5;

if (!Number.isInteger(STAKE) || STAKE <= 0) {
  throw new Error('STAKE must be a positive integer');
}

if (!WS_URL.startsWith('ws://') && !WS_URL.startsWith('wss://')) {
  throw new Error('WS_URL must start with ws:// or wss://');
}

export function setup() {
  const wsConnectWindowStartAtMs = Date.now() + (MATCHMAKING_BARRIER_SECONDS * 1000);

  return {
    wsConnectWindowStartAtMs,
    matchmakingJoinAtMs: wsConnectWindowStartAtMs
      + (WS_CONNECT_SPREAD_SECONDS * 1000)
      + (WS_READY_BUFFER_SECONDS * 1000),
  };
}

export default function (setupData) {
  const tableIndex = tableIndexForVu(__VU);
  const players = [];

  for (let playerIndex = 0; playerIndex < PLAYERS_PER_TABLE; playerIndex += 1) {
    const account = accountForTablePlayer(tableIndex, playerIndex);
    const jar = new http.CookieJar();

    login(account, jar);
    validateStake(jar);

    players.push(createPlayerState(tableIndex, playerIndex, account, jar));
  }

  waitForWebSocketConnect(tableIndex, setupData);
  connectTableAndPlay(tableIndex, players, setupData);
}

export function handleSummary(data) {
  return {
    [SUMMARY_JSON_PATH]: JSON.stringify(data, null, 2),
    stdout: formatTextSummary(data),
  };
}

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
    'protocol_errors',
    'rejected_actions',
    'websocket_connections_ready',
    'tables_with_four_websockets_ready',
    'matchmaking_join_messages_sent',
    'tables_missing_websockets_at_join_barrier',
    'health_barrier_reached',
    'health_barrier_timeout',
    'health_active_rooms_observed',
    'controllers_with_four_players_ready',
    'matchmaking_success',
    'full_human_match_success',
    'rooms_joined',
    'matches_completed',
    'gameplay_actions_sent',
  ].filter((name) => metrics[name]);
  const names = uniqueStrings(importantNames.concat(thresholdNames));
  const lines = [''];

  lines.push('k6 summary');
  lines.push('');

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

  return {
    userIndex,
    email: user.email,
    password: user.password,
  };
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
    matchmakingJoinSent: false,
    matchmakingCounted: false,
    fullHumanMatchCounted: false,
    roomJoinedCounted: false,
    leaveVoteSent: false,
    completionCounted: false,
    closed: false,
    closeRequested: false,
    latestSnapshot: null,
    recentGameplayActions: [],
    sentActionKeys: {},
  };
}

function login(account, jar) {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: account.email, password: account.password }),
    {
      jar,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
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
    fail(`VU ${__VU}: login failed for user index ${account.userIndex}; WebSocket connection was not opened`);
  }

  const cookies = jar.cookiesForURL(BASE_URL);
  const sessionCookies = cookies ? cookies.belot_session : null;
  if (!sessionCookies || sessionCookies.length === 0) {
    loginFailures.add(1);
    fail(
      `VU ${__VU}: login succeeded for user index ${account.userIndex} but belot_session cookie is missing; `
      + 'WebSocket connection was not opened',
    );
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
    fail(`VU ${__VU}: stake ${STAKE} is not available or not enabled; WebSocket connection was not opened`);
  }
}

function connectTableAndPlay(tableIndex, players, setupData) {
  const tableState = {
    vu: __VU,
    tableIndex,
    players,
    sockets: [],
    gameplayReleased: false,
    barrierFailed: false,
    websocketReadyCounted: false,
    missingWebsocketsAtJoinCounted: false,
    controllerReadyCounted: false,
    matchmakingJoinTimerId: null,
    healthPollTimerId: null,
    matchmakingJoinAtMs: setupData.matchmakingJoinAtMs,
    barrierDeadlineMs: setupData.matchmakingJoinAtMs + (HEALTH_BARRIER_TIMEOUT_SECONDS * 1000),
    lastHealthActiveRooms: null,
  };

  for (const player of players) {
    connectPlayerSocket(tableState, player);
  }

  scheduleMatchmakingJoin(tableState, setupData);
}

function connectPlayerSocket(tableState, state) {
  const ws = new WebSocket(WS_URL, null, {
    jar: state.jar,
    headers: {
      Origin: ORIGIN,
    },
    tags: { name: 'game_ws' },
  });

  tableState.sockets[state.playerIndex] = ws;

  const timeoutId = setTimeout(() => {
    if (state.completionCounted || state.closed) {
      return;
    }
    protocolErrors.add(1);
    logSafe(state, 'global timeout reached; closing WebSocket');
    safeClose(ws, state);
  }, RUN_TIMEOUT_MS);

  const pingId = setInterval(() => {
    if (state.closed || ws.readyState !== WS_OPEN) {
      return;
    }
    sendProtocol(ws, state, { type: 'ping' });
  }, PING_INTERVAL_MS);

  ws.addEventListener('message', (event) => {
    handleMessage(ws, tableState, state, event.data);
  });

  ws.addEventListener('error', () => {
    websocketErrors.add(1);
    logSafe(state, 'WebSocket error');
  });

  ws.addEventListener('close', (event) => {
    if (!state.completionCounted && !state.closeRequested) {
      websocketErrors.add(1);
    }
    state.closed = true;
    clearTimeout(timeoutId);
    clearInterval(pingId);
    const code = event && event.code !== undefined ? event.code : 'unknown';
    const reason = event && event.reason ? safeString(event.reason) : '';
    logSafe(state, `WebSocket closed code=${code} reason=${reason}`);
  });
}

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
      logRejectedActionDiagnostic(state, message);
      logSafe(state, `server error: ${safeString(message.message || message.code || 'unknown')}`);
      break;

    case 'session_displaced':
      protocolErrors.add(1);
      logSafe(state, 'session displaced');
      safeClose(ws, state);
      break;

    case 'session_in_game':
      protocolErrors.add(1);
      state.roomId = message.roomId || state.roomId;
      logSafe(state, 'session already in game');
      safeClose(ws, state);
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

function handleConnected(ws, tableState, state) {
  if (state.closeRequested || tableState.missingWebsocketsAtJoinCounted || tableState.barrierFailed) {
    safeClose(ws, state);
    return;
  }

  const now = Date.now();
  state.wsConnected = true;
  state.wsConnectedAtMs = now;

  if (!state.wsReadyCounted && now <= tableState.matchmakingJoinAtMs) {
    websocketConnectionsReady.add(1);
    state.wsReadyCounted = true;
  }

  logSafe(state, 'WebSocket connected');
  maybeCountTableWebsocketsReady(tableState);

  if (Date.now() >= tableState.barrierDeadlineMs) {
    safeClose(ws, state);
  }
}

function maybeCountTableWebsocketsReady(tableState) {
  if (tableState.websocketReadyCounted || !tableHasFourWebsocketsReady(tableState)) {
    return;
  }

  tablesWithFourWebsocketsReady.add(1);
  tableState.websocketReadyCounted = true;
  logTableSafe(tableState, 'four WebSockets connected and ready');
}

function tableHasFourWebsocketsReady(tableState) {
  return tableState.players.every((player) => {
    const ws = tableState.sockets[player.playerIndex];
    return (
      player.wsConnected
      && player.wsConnectedAtMs !== null
      && player.wsConnectedAtMs <= tableState.matchmakingJoinAtMs
      && ws
      && ws.readyState === WS_OPEN
    );
  });
}

function scheduleMatchmakingJoin(tableState, setupData) {
  const waitMs = setupData.matchmakingJoinAtMs - Date.now();

  tableState.matchmakingJoinTimerId = setTimeout(() => {
    tableState.matchmakingJoinTimerId = null;
    handleMatchmakingJoinBarrier(tableState);
  }, Math.max(0, waitMs));
}

function handleMatchmakingJoinBarrier(tableState) {
  maybeCountTableWebsocketsReady(tableState);

  if (!tableHasFourWebsocketsReady(tableState)) {
    if (!tableState.missingWebsocketsAtJoinCounted) {
      tablesMissingWebsocketsAtJoinBarrier.add(1);
      tableState.missingWebsocketsAtJoinCounted = true;
    }
    logTableSafe(tableState, 'matchmaking join barrier reached with missing WebSocket connections');
    closeTable(tableState);
    return;
  }

  let sentAll = true;

  for (const player of tableState.players) {
    const ws = tableState.sockets[player.playerIndex];
    const sent = sendProtocol(ws, player, { type: 'join_matchmaking', stake: STAKE });

    if (sent) {
      player.matchmakingJoinSent = true;
      matchmakingJoinMessagesSent.add(1);
    } else {
      sentAll = false;
      protocolErrors.add(1);
      logSafe(player, 'failed to send join_matchmaking at join barrier');
    }
  }

  if (!sentAll) {
    closeTable(tableState);
    return;
  }

  logTableSafe(tableState, 'sent four join_matchmaking messages');
  scheduleHealthBarrierPoll(tableState);
}

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
  maybeReleaseGameplay(tableState, 'match_found');
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
    maybeReleaseGameplay(tableState, 'room_snapshot_without_game');
    return;
  }

  const phase = game.authoritativePhase || game.phase || 'unknown';
  if (phase !== state.lastPhase) {
    state.phaseSequence += 1;
    state.lastPhase = phase;
    logSafe(state, `phase ${phase}`, true);
  }

  const wasReleased = tableState.gameplayReleased;
  maybeCountControllerReady(tableState);
  maybeReleaseGameplay(tableState, 'room_snapshot');

  if (!tableState.gameplayReleased || !wasReleased) {
    return;
  }

  processGameplaySnapshot(ws, state, message, game);
}

function processGameplaySnapshot(ws, state, message, game) {
  if (game.authoritativePhase === 'match-ended' || game.phase === 'match-ended') {
    if (!game.matchEnded || typeof game.matchEnded !== 'object') {
      protocolErrors.add(1);
      logSafe(state, 'match-ended phase is missing game.matchEnded snapshot');
      safeClose(ws, state);
      return;
    }
    handleMatchEnded(ws, state, message, game);
    return;
  }

  maybeSubmitCut(ws, state, message, game);
  maybeSubmitBid(ws, state, message, game);
  maybeSubmitPlay(ws, state, message, game);
}

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

  const key = [
    message.roomId,
    'cutting',
    state.phaseSequence,
    cutting.cutterSeat || '',
    cutting.deckCount,
  ].join('|');

  const sent = sendOnce(ws, state, key, {
    type: 'submit_cut_index',
    roomId: message.roomId,
    cutIndex,
  });
  if (sent) {
    recordGameplayAction(state, {
      actionType: 'cut',
      roomId: message.roomId,
      key,
      timerDeadlineAt: game.timerDeadlineAt,
      phase: game.authoritativePhase || game.phase || state.lastPhase,
      cutIndex,
    });
  }
}

function maybeSubmitBid(ws, state, message, game) {
  const bidding = game.bidding;
  if (!bidding || bidding.canSubmitBid !== true || bidding.currentBidderSeat !== message.yourSeat) {
    return;
  }

  const validActions = bidding.validActions || {};
  const hasNonPassBid = bidding.winningBid != null || hasNonPassBidEntry(bidding.entries);
  let action = null;

  if (!hasNonPassBid) {
    action = firstValidSuitAction(validActions.suits);
    if (action === null) {
      protocolErrors.add(1);
      logSafe(state, 'no valid suit bid available before first non-pass bid');
      return;
    }
  } else if (validActions.pass === true) {
    action = { type: 'pass' };
  } else {
    return;
  }

  const key = [
    message.roomId,
    'bidding',
    state.phaseSequence,
    bidding.currentBidderSeat || '',
    Array.isArray(bidding.entries) ? bidding.entries.length : 0,
    stableStringify(bidding.winningBid),
  ].join('|');

  const sent = sendOnce(ws, state, key, {
    type: 'submit_bid_action',
    roomId: message.roomId,
    action,
  });
  if (sent) {
    recordGameplayAction(state, {
      actionType: 'bid',
      roomId: message.roomId,
      key,
      timerDeadlineAt: game.timerDeadlineAt,
      phase: game.authoritativePhase || game.phase || state.lastPhase,
      bidActionType: action.type,
    });
  }
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
  const key = [
    message.roomId,
    'playing',
    state.phaseSequence,
    playing.currentTurnSeat || '',
    playing.completedTricksCount,
    Array.isArray(playing.currentTrickPlays) ? playing.currentTrickPlays.length : 0,
    validCardIds.join(','),
  ].join('|');

  const sent = sendOnce(ws, state, key, {
    type: 'submit_play_card',
    roomId: message.roomId,
    cardId,
    declarationKeys: [],
  });
  if (sent) {
    recordGameplayAction(state, {
      actionType: 'play',
      roomId: message.roomId,
      key,
      timerDeadlineAt: game.timerDeadlineAt,
      phase: game.authoritativePhase || game.phase || state.lastPhase,
      cardId,
    });
  }
}

function handleMatchEnded(ws, state, message, game) {
  if (!state.leaveVoteSent) {
    const leaveSent = sendOnce(ws, state, `${message.roomId}|match-ended|leave`, {
      type: 'request_leave_match',
      roomId: message.roomId,
    });
    if (leaveSent) {
      state.leaveVoteSent = true;
      logSafe(state, 'normal leave requested after match-ended');
    }
  }

  const leaveVotes = game.matchEnded && Array.isArray(game.matchEnded.leaveVotes)
    ? game.matchEnded.leaveVotes
    : [];

  if (!state.completionCounted && state.seat && leaveVotes.indexOf(state.seat) !== -1) {
    matchesCompleted.add(1);
    state.completionCounted = true;
    logSafe(state, 'match completion confirmed');
    setTimeout(() => safeClose(ws, state), 250);
  }
}

function maybeCountControllerReady(tableState) {
  if (tableState.controllerReadyCounted || !controllerHasFourPlayersReady(tableState)) {
    return;
  }

  controllersWithFourPlayersReady.add(1);
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

function scheduleHealthBarrierPoll(tableState) {
  const jitterMs = (tableState.tableIndex * 37) % 250;

  const poll = () => {
    if (tableState.gameplayReleased || tableState.barrierFailed) {
      return;
    }

    if (Date.now() >= tableState.barrierDeadlineMs) {
      pollHealthBarrier(tableState, false);
      maybeReleaseGameplay(tableState, 'health_deadline', true);
      return;
    }

    pollHealthBarrier(tableState);

    if (tableState.gameplayReleased || tableState.barrierFailed) {
      return;
    }

    const now = Date.now();
    if (now >= tableState.barrierDeadlineMs) {
      pollHealthBarrier(tableState, false);
      maybeReleaseGameplay(tableState, 'health_deadline', true);
      return;
    }

    tableState.healthPollTimerId = setTimeout(poll, HEALTH_POLL_INTERVAL_MS + jitterMs);
  };

  tableState.healthPollTimerId = setTimeout(poll, jitterMs);
}

function pollHealthBarrier(tableState, shouldTryRelease = true) {
  const res = http.get(`${BASE_URL}/health`, {
    headers: { Accept: 'application/json' },
    tags: { name: 'health' },
    timeout: '2s',
  });
  const body = parseJson(res.body);
  const activeRooms = body && body.gameRuntime ? Number(body.gameRuntime.activeRooms) : NaN;

  if (res.status !== 200 || !Number.isFinite(activeRooms)) {
    logTableSafe(tableState, `health poll did not return gameRuntime.activeRooms status=${res.status}`);
    return false;
  }

  tableState.lastHealthActiveRooms = activeRooms;
  healthActiveRoomsObserved.add(activeRooms);
  if (shouldTryRelease) {
    maybeReleaseGameplay(tableState, 'health');
  }
  return activeRooms >= REQUIRED_ACTIVE_ROOMS;
}

function maybeReleaseGameplay(tableState, reason, finalPollCompleted = false) {
  if (tableState.gameplayReleased || tableState.barrierFailed) {
    return;
  }

  const hasEnoughActiveRooms = () => (
    tableState.lastHealthActiveRooms !== null
    && tableState.lastHealthActiveRooms >= REQUIRED_ACTIVE_ROOMS
  );

  if (!hasEnoughActiveRooms()) {
    if (Date.now() < tableState.barrierDeadlineMs) {
      return;
    }

    if (!finalPollCompleted) {
      pollHealthBarrier(tableState, false);
    }
    if (!hasEnoughActiveRooms()) {
      failHealthBarrier(tableState);
      return;
    }
  }

  tableState.gameplayReleased = true;
  healthBarrierReached.add(1);
  clearHealthPoll(tableState);
  logTableSafe(
    tableState,
    `gameplay barrier released by ${reason}; activeRooms=${tableState.lastHealthActiveRooms}`,
  );

  for (const player of tableState.players) {
    const ws = tableState.sockets[player.playerIndex];
    const snapshot = player.latestSnapshot;
    if (!ws || !snapshot || !snapshot.game) {
      continue;
    }
    processGameplaySnapshot(ws, player, snapshot, snapshot.game);
  }
}

function failHealthBarrier(tableState) {
  if (tableState.gameplayReleased || tableState.barrierFailed) {
    return;
  }

  tableState.barrierFailed = true;
  healthBarrierTimeout.add(1);
  clearHealthPoll(tableState);
  logTableSafe(
    tableState,
    `health barrier timeout; lastActiveRooms=${tableState.lastHealthActiveRooms === null ? 'unknown' : tableState.lastHealthActiveRooms}; `
    + `requiredActiveRooms=${REQUIRED_ACTIVE_ROOMS}; controllerReady=${tableState.controllerReadyCounted}`,
  );
  closeTable(tableState);
}

function clearHealthPoll(tableState) {
  if (tableState.healthPollTimerId !== null) {
    clearTimeout(tableState.healthPollTimerId);
    tableState.healthPollTimerId = null;
  }
}

function clearMatchmakingJoinTimer(tableState) {
  if (tableState.matchmakingJoinTimerId !== null) {
    clearTimeout(tableState.matchmakingJoinTimerId);
    tableState.matchmakingJoinTimerId = null;
  }
}

function closeTable(tableState) {
  clearMatchmakingJoinTimer(tableState);
  clearHealthPoll(tableState);
  for (const player of tableState.players) {
    const ws = tableState.sockets[player.playerIndex];
    if (ws) {
      safeClose(ws, player);
    }
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

function recordGameplayAction(state, details) {
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
  const recentActions = state.recentGameplayActions
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

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

  if (state.closed || ws.readyState !== WS_OPEN) {
    return;
  }

  ws.close();
}

function parseTables(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new Error('TABLES must be an integer between 1 and 200');
  }

  return parsed;
}

function parseRequiredActiveRooms(value) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('REQUIRED_ACTIVE_ROOMS must be a positive integer');
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
      maxDuration: '40m',
      gracefulStop: '5s',
      env: {
        TABLE_INDEX: String(tableIndex),
      },
    };
  }

  return scenarios;
}

function waitForWebSocketConnect(tableIndex, setupData) {
  const connectOffsetMs = TABLES > 1
    ? Math.floor((tableIndex * WS_CONNECT_SPREAD_SECONDS * 1000) / (TABLES - 1))
    : 0;
  const waitMs = (setupData.wsConnectWindowStartAtMs + connectOffsetMs) - Date.now();

  if (waitMs > 0) {
    sleep(waitMs / 1000);
  }
}

function loadUsers() {
  const raw = open('./loadtest-users.json.local');
  const parsed = parseJson(raw);

  if (!parsed || !Array.isArray(parsed.users)) {
    throw new Error('loadtest-users.json.local must have the structure: { "users": [...] }');
  }

  if (parsed.users.length < REQUIRED_USERS) {
    throw new Error(`loadtest-users.json.local must contain at least ${REQUIRED_USERS} users for TABLES=${TABLES}`);
  }

  for (let i = 0; i < REQUIRED_USERS; i += 1) {
    const user = parsed.users[i];
    if (!user || typeof user.email !== 'string' || user.email.trim() === '') {
      throw new Error(`User at index ${i} is missing email`);
    }
    if (!user || typeof user.password !== 'string' || user.password === '') {
      throw new Error(`User at index ${i} is missing password`);
    }
  }

  return parsed.users.slice(0, REQUIRED_USERS);
}

function chooseCutIndex(deckCount) {
  if (!Number.isInteger(deckCount) || deckCount <= 2) {
    return null;
  }

  return Math.max(1, Math.min(deckCount - 1, Math.floor(deckCount / 2)));
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
  console.log(`VU ${tableState.vu}: table=${tableState.tableIndex + 1} ${message}`);
}
