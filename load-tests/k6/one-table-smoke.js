import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';

export const options = {
  scenarios: {
    one_table_smoke: {
      executor: 'per-vu-iterations',
      vus: 4,
      iterations: 1,
      maxDuration: '30m',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    login_failures: ['count==0'],
    websocket_errors: ['count==0'],
    protocol_errors: ['count==0'],
    rejected_actions: ['count==0'],
    matchmaking_success: ['count==4'],
    full_human_match_success: ['count==4'],
    rooms_joined: ['count==4'],
    matches_completed: ['count==4'],
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

const REQUIRED_ENV = [
  'BASE_URL',
  'WS_URL',
  'STAKE',
  'USER_1_EMAIL',
  'USER_1_PASSWORD',
  'USER_2_EMAIL',
  'USER_2_PASSWORD',
  'USER_3_EMAIL',
  'USER_3_PASSWORD',
  'USER_4_EMAIL',
  'USER_4_PASSWORD',
];

const missingEnv = REQUIRED_ENV.filter((name) => !__ENV[name]);
if (missingEnv.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

const BASE_URL = trimTrailingSlashes(__ENV.BASE_URL);
const WS_URL = __ENV.WS_URL;
const ORIGIN = BASE_URL;
const STAKE = Number(__ENV.STAKE);
const RUN_TIMEOUT_MS = 29 * 60 * 1000;
const PING_INTERVAL_MS = 20 * 1000;
const WS_OPEN = 1;

if (!Number.isInteger(STAKE) || STAKE <= 0) {
  throw new Error('STAKE must be a positive integer');
}

if (!WS_URL.startsWith('ws://') && !WS_URL.startsWith('wss://')) {
  throw new Error('WS_URL must start with ws:// or wss://');
}

export default function () {
  const account = accountForVu(__VU);
  const jar = http.cookieJar();

  login(account, jar);
  validateStake(jar);
  connectAndPlay(jar);
}

function accountForVu(vu) {
  if (vu < 1 || vu > 4) {
    fail(`Unexpected VU number ${vu}; this scenario requires exactly 4 VUs`);
  }

  return {
    email: __ENV[`USER_${vu}_EMAIL`],
    password: __ENV[`USER_${vu}_PASSWORD`],
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
    fail(`VU ${__VU}: login failed; WebSocket connection was not opened`);
  }

  const cookies = jar.cookiesForURL(BASE_URL);
  const sessionCookies = cookies ? cookies.belot_session : null;
  if (!sessionCookies || sessionCookies.length === 0) {
    loginFailures.add(1);
    fail(`VU ${__VU}: login succeeded but belot_session cookie is missing; WebSocket connection was not opened`);
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

function connectAndPlay(jar) {
  const state = {
    vu: __VU,
    roomId: null,
    seat: null,
    reconnectToken: null,
    lastPhase: null,
    lastRoomStatus: null,
    matchmakingCounted: false,
    fullHumanMatchCounted: false,
    roomJoinedCounted: false,
    leaveVoteSent: false,
    completionCounted: false,
    closed: false,
    closeRequested: false,
    sentActionKeys: {},
  };

  const ws = new WebSocket(WS_URL, null, {
    jar,
    headers: {
      Origin: ORIGIN,
    },
    tags: { name: 'game_ws' },
  });

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

  ws.addEventListener('open', () => {
    console.log(`VU ${state.vu}: WebSocket opened`);
  });

  ws.addEventListener('message', (event) => {
    handleMessage(ws, state, event.data);
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

function handleMessage(ws, state, rawData) {
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
      sendProtocol(ws, state, { type: 'join_matchmaking', stake: STAKE });
      break;

    case 'matchmaking_joined':
    case 'matchmaking_status':
      break;

    case 'match_found':
      state.roomId = message.roomId || state.roomId;
      state.seat = message.seat || state.seat;
      if (message.humanPlayers !== 4 || message.botPlayers !== 0) {
        protocolErrors.add(1);
        logSafe(
          state,
          `match_found is not full human match humanPlayers=${message.humanPlayers} botPlayers=${message.botPlayers}`,
        );
        safeClose(ws, state);
        break;
      }
      if (!state.matchmakingCounted) {
        matchmakingSuccess.add(1);
        state.matchmakingCounted = true;
      }
      if (!state.fullHumanMatchCounted) {
        fullHumanMatchSuccess.add(1);
        state.fullHumanMatchCounted = true;
      }
      logSafe(state, 'match found');
      break;

    case 'room_snapshot':
      handleRoomSnapshot(ws, state, message);
      break;

    case 'error':
      rejectedActions.add(1);
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

function handleRoomSnapshot(ws, state, message) {
  roomSnapshotsReceived.add(1);

  state.roomId = message.roomId || state.roomId;
  state.seat = message.yourSeat || state.seat;
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
    return;
  }

  const phase = game.authoritativePhase || game.phase || 'unknown';
  if (phase !== state.lastPhase) {
    state.lastPhase = phase;
    logSafe(state, `phase ${phase}`);
  }

  if (phase === 'match-ended') {
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
    game.timerDeadlineAt || '',
    cutting.cutterSeat || '',
    cutting.deckCount,
  ].join('|');

  sendOnce(ws, state, key, {
    type: 'submit_cut_index',
    roomId: message.roomId,
    cutIndex,
  });
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
    game.timerDeadlineAt || '',
    bidding.currentBidderSeat || '',
    Array.isArray(bidding.entries) ? bidding.entries.length : 0,
    stableStringify(bidding.winningBid),
  ].join('|');

  sendOnce(ws, state, key, {
    type: 'submit_bid_action',
    roomId: message.roomId,
    action,
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
  const key = [
    message.roomId,
    'playing',
    game.timerDeadlineAt || '',
    playing.currentTurnSeat || '',
    playing.completedTricksCount,
    Array.isArray(playing.currentTrickPlays) ? playing.currentTrickPlays.length : 0,
    validCardIds.join(','),
  ].join('|');

  sendOnce(ws, state, key, {
    type: 'submit_play_card',
    roomId: message.roomId,
    cardId,
    declarationKeys: [],
  });
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

  if (state.closed || ws.readyState !== WS_OPEN) {
    return;
  }

  ws.close();
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

function logSafe(state, message) {
  const room = state.roomId || '-';
  const seat = state.seat || '-';
  const phase = state.lastPhase || '-';
  console.log(`VU ${state.vu}: room=${room} seat=${seat} phase=${phase} ${message}`);
}
