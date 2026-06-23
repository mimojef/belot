import process from 'node:process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import WebSocket from 'ws';
import {
  createMetrics, extractSessionCookie, incrementMetric, readyTableIndexes,
  safeMetrics, setMetric, sliceCredentials, validateTargetPair,
} from './multi-process-ws-common.mjs';

const PLAYERS_PER_TABLE = 4;
const MATCHMAKING_STAKE = 5000;
const SERVER_SEATS = Object.freeze(['bottom', 'right', 'top', 'left']);
const SERVER_SEAT_SET = new Set(SERVER_SEATS);
const AUTHORITATIVE_PHASES = new Set([
  'new-game', 'choose-first-dealer', 'cutting', 'cut-resolve',
  'deal-first-3', 'deal-next-2', 'bidding', 'deal-last-3',
  'playing', 'scoring', 'next-round', 'match-ended',
]);
const TERMINAL_SERVER_FAILURE_CODES = Object.freeze({
  error: 'server_error',
  matchmaking_expired: 'matchmaking_expired',
  matchmaking_left: 'matchmaking_left',
  session_displaced: 'session_displaced',
  session_in_game: 'session_in_game',
});

class ShutdownError extends Error {}

export class WsWorker {
  constructor(config, credentials, send = () => {}, dependencies = {}) {
    const target = validateTargetPair(config?.baseUrl, config?.wsUrl);
    if (!Array.isArray(credentials)) throw new Error('Worker credentials slice is required');
    this.config = parseConfig(config, target);
    this.credentials = sliceCredentials(credentials, 0, credentials.length);
    this.send = (message) => send(JSON.parse(JSON.stringify(message)));
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.WebSocket = dependencies.WebSocket ?? WebSocket;
    this.metrics = createMetrics();
    this.players = this.credentials.map((_, index) => ({
      index, tableIndex: Math.floor(index / PLAYERS_PER_TABLE),
      tableSeatIndex: index % PLAYERS_PER_TABLE, generation: 0, socket: null,
      attempt: null, ready: false, wsStarted: false, terminalCounted: false,
      terminalError: null, holdFailureCounted: false, holdResolve: null, holdReject: null,
      matchmakingJoinSent: false,
    }));
    this.tables = createLocalTables(this.players.length);
    this.ready = new Set();
    this.sockets = new Set();
    this.waiters = new Set();
    this.loginControllers = new Set();
    this.failedProfileIndexes = new Set();
    this.stopping = false;
    this.lastProgressAtMs = Date.now();
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.run();
    return this.startPromise;
  }

  async run() {
    this.stopPromise = new Promise((resolve) => { this.stopResolve = resolve; });
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    this.eventLoopDelay.enable();
    this.heartbeatTimer = setInterval(() => this.emitProgress('heartbeat'),
      this.config.heartbeatIntervalMs);
    this.releaseTimer = this.scheduleAt(this.config.releaseAtMs, () => this.release());
    this.tasks = this.players.map((player) => this.runPlayer(player).catch((error) => {
      if (!(error instanceof ShutdownError)) this.failProfile(player, error, false);
      throw error;
    }));
    const resultsPromise = Promise.allSettled(this.tasks);
    await this.stopPromise;
    const results = await resultsPromise;
    await this.shutdown();
    return results;
  }

  async runPlayer(player) {
    const loginAtMs = this.loginAtMs(player.index);
    await this.waitUntil(loginAtMs);
    const session = await this.login(player.index);
    await this.waitUntil(this.config.wsStartAtMs);
    await this.connectWithRetry(player, session);
    if (player.terminalError) throw player.terminalError;
    await new Promise((resolve, reject) => {
      player.holdResolve = resolve;
      player.holdReject = reject;
      if (player.terminalError) reject(player.terminalError);
      if (this.stopping) resolve();
    });
  }

  loginAtMs(index) {
    if (this.players.length <= 1) return this.config.loginStartAtMs;
    return this.config.loginStartAtMs
      + Math.floor((index * this.config.loginSpreadMs) / (this.players.length - 1));
  }

  async login(index) {
    incrementMetric(this.metrics, 'loginAttempts');
    this.progress();
    const timeoutMs = this.config.loginTimeoutMs;
    const controller = new AbortController();
    this.loginControllers.add(controller);
    try {
      const response = await this.fetch(`${this.config.baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(this.credentials[index]),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      });
      const body = await response.json().catch(() => null);
      if (response.status !== 200 || body?.ok !== true || body?.session === undefined) {
        throw new Error('Login validation failed');
      }
      const session = extractSessionCookie(response.headers);
      incrementMetric(this.metrics, 'loginSuccesses');
      this.progress();
      return session;
    } catch (error) {
      if (this.stopping) throw new ShutdownError('shutdown');
      incrementMetric(this.metrics, 'loginFailures');
      this.progress();
      throw error;
    } finally {
      this.loginControllers.delete(controller);
    }
  }

  async connectWithRetry(player, session) {
    player.wsStarted = true;
    let lastError = new Error('readiness deadline exceeded');
    for (let attempt = 1; attempt <= this.config.maxAttempts && !this.stopping; attempt += 1) {
      if (Date.now() >= this.config.readinessDeadlineAtMs) break;
      if (attempt > 1) incrementMetric(this.metrics, 'wsRetries');
      try {
        await this.connectAttempt(player, session);
        return;
      } catch (error) {
        lastError = error;
        if (this.stopping) throw new ShutdownError('shutdown');
        const remaining = this.config.readinessDeadlineAtMs - Date.now();
        if (attempt >= this.config.maxAttempts || remaining <= 0) break;
        const cap = Math.min(this.config.retryMaxMs,
          this.config.retryBaseMs * (2 ** (attempt - 1)));
        const jitter = cap * this.config.jitter * ((Math.random() * 2) - 1);
        await this.waitFor(Math.min(remaining, this.config.retryMaxMs,
          Math.max(0, Math.round(cap + jitter))));
      }
    }
    throw lastError;
  }

  connectAttempt(player, session) {
    incrementMetric(this.metrics, 'wsAttempts');
    this.progress();
    const generation = ++player.generation;
    return new Promise((resolve, reject) => {
      const attempt = { generation, player, socket: null, settled: false, ready: false,
        timeout: null, ping: null, resolve, reject, activeCounted: false };
      player.attempt = attempt;
      let socket;
      try {
        socket = new this.WebSocket(this.config.wsUrl, {
          headers: { Cookie: `belot_session=${session}`, Origin: this.config.baseUrl },
        });
      } catch {
        this.settleAttempt(attempt, new Error('WebSocket constructor failed'));
        return;
      }
      attempt.socket = socket;
      player.socket = socket;
      this.sockets.add(attempt);
      const remaining = Math.max(1, Math.min(this.config.attemptTimeoutMs,
        this.config.readinessDeadlineAtMs - Date.now()));
      attempt.timeout = setTimeout(() => {
        if (!this.isCurrent(attempt) || attempt.settled) return;
        incrementMetric(this.metrics, 'wsAttemptTimeouts');
        this.closeSocket(attempt, true);
        this.settleAttempt(attempt, new Error('WebSocket attempt timeout'));
      }, remaining);
      socket.on('open', () => this.handleOpen(attempt));
      socket.on('message', (data) => this.handleMessage(attempt, data));
      socket.on('error', () => this.handleSocketFailure(attempt, 'WebSocket error'));
      socket.on('close', () => this.handleClose(attempt));
    });
  }

  handleOpen(attempt) {
    if (!this.isCurrent(attempt) || attempt.activeCounted) return;
    attempt.activeCounted = true;
    incrementMetric(this.metrics, 'wsOpens');
    setMetric(this.metrics, 'currentActiveSockets', this.metrics.currentActiveSockets + 1);
    setMetric(this.metrics, 'peakActiveSockets', Math.max(
      this.metrics.peakActiveSockets, this.metrics.currentActiveSockets,
    ));
    this.progress();
  }

  handleMessage(attempt, data) {
    if (!this.isCurrent(attempt) || this.stopping) return;
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message?.type === 'pong') {
      incrementMetric(this.metrics, 'wsPongs');
      this.progress();
      return;
    }
    if (Object.hasOwn(TERMINAL_SERVER_FAILURE_CODES, message?.type)) {
      this.handleTerminalServerMessage(attempt, message);
      return;
    }
    if (message?.type === 'matchmaking_joined') {
      this.handleMatchmakingAck(attempt, message, 'joined');
      return;
    }
    if (message?.type === 'matchmaking_status') {
      this.handleMatchmakingAck(attempt, message, 'status');
      return;
    }
    if (message?.type === 'match_found') {
      this.handleMatchFound(attempt, message);
      return;
    }
    if (message?.type === 'room_snapshot') {
      this.handleRoomSnapshot(attempt, message);
      return;
    }
    if (message?.type !== 'connected' || attempt.ready || attempt.settled) return;
    attempt.ready = true;
    attempt.player.ready = true;
    this.ready.add(attempt.player.index);
    setMetric(this.metrics, 'wsReadyProfiles', this.ready.size);
    const readyTables = readyTableIndexes(this.ready, this.players.length).length;
    setMetric(this.metrics, 'wsReadyTables', readyTables);
    setMetric(this.metrics, 'peakReadyProfiles', Math.max(
      this.metrics.peakReadyProfiles, this.ready.size,
    ));
    setMetric(this.metrics, 'peakReadyTables', Math.max(
      this.metrics.peakReadyTables, readyTables,
    ));
    clearTimeout(attempt.timeout);
    attempt.timeout = null;
    attempt.ping = setInterval(() => this.sendPing(attempt), this.config.pingIntervalMs);
    this.settleAttempt(attempt, null, false);
    this.maybeStartMatchmakingForPlayer(attempt.player);
    this.emitProgress('progress');
  }

  allowMatchmakingTable(tableIndex) {
    if (!Number.isInteger(tableIndex) || tableIndex < 0) return false;
    const table = this.tables[tableIndex];
    if (!table || this.stopping || table.terminal) return false;
    if (this.tableHasTerminalProfile(table)) {
      this.failMatchmakingTable(table, 'profile_failed_before_join');
      return false;
    }
    if (!table.admitted) {
      table.admitted = true;
      incrementMetric(this.metrics, 'matchmakingAdmittedTables');
      this.progress();
    }
    this.maybeStartMatchmaking(table);
    this.emitProgress('progress');
    return true;
  }

  maybeStartMatchmakingForPlayer(player) {
    const table = this.tables[player.tableIndex];
    if (table) this.maybeStartMatchmaking(table);
  }

  maybeStartMatchmaking(table) {
    if (!table.admitted || table.joinStarted || table.terminal || this.stopping) return;
    if (this.tableHasTerminalProfile(table)) {
      this.failMatchmakingTable(table, 'profile_failed_before_join');
      return;
    }
    const players = table.profileIndexes.map((index) => this.players[index]);
    const allConnected = players.every((player) => {
      const attempt = player.attempt;
      return player.ready && attempt && this.isCurrent(attempt)
        && attempt.ready && attempt.socket?.readyState === this.WebSocket.OPEN;
    });
    if (!allConnected) return;

    table.joinStarted = true;
    this.recomputeMatchmakingTableGauges();
    for (const player of players) {
      if (!this.sendJoinMatchmaking(player)) {
        this.failMatchmakingTable(table, 'join_send_failure');
        return;
      }
    }
  }

  sendJoinMatchmaking(player) {
    if (player.matchmakingJoinSent) return true;
    const attempt = player.attempt;
    if (!attempt || !this.isCurrent(attempt) || !attempt.ready) return false;
    try {
      if (attempt.socket.readyState !== this.WebSocket.OPEN) return false;
      attempt.socket.send(JSON.stringify({ type: 'join_matchmaking', stake: MATCHMAKING_STAKE }));
      player.matchmakingJoinSent = true;
      incrementMetric(this.metrics, 'matchmakingJoinAttempts');
      this.progress();
      return true;
    } catch {
      return false;
    }
  }

  handleMatchmakingAck(attempt, message, ackType) {
    if (!this.isCurrent(attempt) || !attempt.player.matchmakingJoinSent) return;
    const table = this.tables[attempt.player.tableIndex];
    if (!table || table.terminal) return;
    if (message?.stake !== MATCHMAKING_STAKE) {
      this.failMatchmakingTable(table, 'stake_mismatch');
      return;
    }
    if (message?.requiredPlayers !== PLAYERS_PER_TABLE) {
      this.failMatchmakingTable(table, 'required_players_mismatch');
      return;
    }
    const target = ackType === 'joined' ? table.joinedAckProfileIndexes : table.statusAckProfileIndexes;
    if (target.has(attempt.player.index)) return;
    target.add(attempt.player.index);
    incrementMetric(this.metrics, ackType === 'joined' ? 'matchmakingJoinAcks' : 'matchmakingStatusAcks');
    this.emitProgress('progress');
  }

  handleMatchFound(attempt, message) {
    if (!this.isCurrent(attempt) || !attempt.player.matchmakingJoinSent) return;
    const table = this.tables[attempt.player.tableIndex];
    if (!table || table.terminal) return;
    const roomId = normalizeId(message.roomId);
    const seat = normalizeId(message.seat);
    if (message.stake !== MATCHMAKING_STAKE) {
      this.failMatchmakingTable(table, 'stake_mismatch');
      return;
    }
    if (!roomId || !seat) {
      this.failMatchmakingTable(table, 'match_found_missing_identity');
      return;
    }
    if (!SERVER_SEAT_SET.has(seat)) {
      this.failMatchmakingTable(table, 'unknown_seat');
      return;
    }
    if (message.humanPlayers !== PLAYERS_PER_TABLE || message.botPlayers !== 0) {
      this.failMatchmakingTable(table, 'match_found_not_full_human');
      return;
    }
    if (table.roomId !== null && table.roomId !== roomId) {
      this.failMatchmakingTable(table, 'mixed_room_id');
      return;
    }
    const existingSeat = table.matchFoundSeats.get(attempt.player.index);
    if (existingSeat !== undefined) {
      if (existingSeat === seat && table.roomId === roomId) return;
      this.failMatchmakingTable(table, 'conflicting_match_found');
      return;
    }
    const snapshotSeat = table.snapshotSeats.get(attempt.player.index);
    if (snapshotSeat !== undefined && snapshotSeat !== seat) {
      this.failMatchmakingTable(table, 'snapshot_seat_mismatch');
      return;
    }
    if (seatAlreadyUsed(table.matchFoundSeats, attempt.player.index, seat)) {
      this.failMatchmakingTable(table, 'duplicate_seat');
      return;
    }
    table.roomId = roomId;
    table.matchFoundProfileIndexes.add(attempt.player.index);
    table.matchFoundSeats.set(attempt.player.index, seat);
    incrementMetric(this.metrics, 'matchmakingMatchFounds');
    this.maybeMarkMatchmakingTableReady(table);
    this.emitProgress('progress');
  }

  handleRoomSnapshot(attempt, message) {
    if (!this.isCurrent(attempt) || !attempt.player.matchmakingJoinSent) return;
    const table = this.tables[attempt.player.tableIndex];
    if (!table || table.terminal) return;
    if (message.stakeAmount !== MATCHMAKING_STAKE) {
      this.failMatchmakingTable(table, 'stake_mismatch');
      return;
    }
    const roomId = normalizeId(message.roomId);
    const seat = normalizeId(message.yourSeat);
    if (!roomId || !seat) {
      this.failMatchmakingTable(table, 'snapshot_missing_identity');
      return;
    }
    if (table.roomId !== null && table.roomId !== roomId) {
      this.failMatchmakingTable(table, 'mixed_room_id');
      return;
    }
    const matchFoundSeat = table.matchFoundSeats.get(attempt.player.index);
    if (matchFoundSeat !== undefined && matchFoundSeat !== seat) {
      this.failMatchmakingTable(table, 'snapshot_seat_mismatch');
      return;
    }
    const roster = validateSnapshotRoster(message.seats, seat);
    if (!roster.ok) {
      this.failMatchmakingTable(table, roster.failureCode);
      return;
    }
    const existingSeat = table.snapshotSeats.get(attempt.player.index);
    const existingRoster = table.snapshotRosters.get(attempt.player.index);
    const phase = validateAuthoritativePhase(message.game?.authoritativePhase ?? null);
    if (!phase.ok) {
      this.failMatchmakingTable(table, phase.failureCode);
      return;
    }
    if (existingSeat !== undefined || existingRoster !== undefined) {
      if (existingSeat === seat && existingRoster === roster.key && table.roomId === roomId) {
        if (phase.value !== null) {
          table.authoritativePhases.set(attempt.player.index, phase.value);
          this.maybeMarkMatchmakingTableReady(table);
          this.emitProgress('progress');
        }
        return;
      }
      this.failMatchmakingTable(table, 'conflicting_snapshot');
      return;
    }
    if (seatAlreadyUsed(table.snapshotSeats, attempt.player.index, seat)) {
      this.failMatchmakingTable(table, 'duplicate_seat');
      return;
    }
    table.roomId = roomId;
    table.snapshotProfileIndexes.add(attempt.player.index);
    table.snapshotSeats.set(attempt.player.index, seat);
    table.snapshotRosters.set(attempt.player.index, roster.key);
    if (phase.value !== null) table.authoritativePhases.set(attempt.player.index, phase.value);
    incrementMetric(this.metrics, 'matchmakingSnapshots');
    this.maybeMarkMatchmakingTableReady(table);
    this.emitProgress('progress');
  }

  handleTerminalServerMessage(attempt, message) {
    if (!this.isCurrent(attempt)) return;
    const failureCode = TERMINAL_SERVER_FAILURE_CODES[message.type];
    const table = this.tables[attempt.player.tableIndex];
    if (message.type === 'matchmaking_expired' && message.stake !== MATCHMAKING_STAKE) {
      if (table?.admitted || attempt.player.matchmakingJoinSent) {
        this.failMatchmakingTable(table, 'stake_mismatch');
      } else {
        this.failTerminalProfileBeforeJoin(attempt.player, attempt, 'stake_mismatch');
      }
      return;
    }
    if (table?.admitted || attempt.player.matchmakingJoinSent) {
      this.failMatchmakingTable(table, failureCode);
      return;
    }
    this.failTerminalProfileBeforeJoin(attempt.player, attempt, failureCode);
  }

  maybeMarkMatchmakingTableReady(table) {
    if (table.terminal) return;
    if (table.matchFoundProfileIndexes.size !== PLAYERS_PER_TABLE
        || table.snapshotProfileIndexes.size !== PLAYERS_PER_TABLE) {
      return;
    }
    if (new Set(table.matchFoundSeats.values()).size !== PLAYERS_PER_TABLE
        || new Set(table.snapshotSeats.values()).size !== PLAYERS_PER_TABLE) {
      this.failMatchmakingTable(table, 'duplicate_seat');
      return;
    }
    table.confirmed = true;
    if (table.authoritativePhases.size !== PLAYERS_PER_TABLE) {
      table.started = false;
      table.ready = false;
      this.recomputeMatchmakingTableGauges();
      this.progress();
      return;
    }
    table.started = true;
    table.ready = true;
    this.recomputeMatchmakingTableGauges();
    this.progress();
  }

  tableHasTerminalProfile(table) {
    return table.profileIndexes.some((index) => this.players[index]?.terminalCounted === true);
  }

  failTerminalProfileBeforeJoin(player, attempt, failureCode) {
    player.ready = false;
    attempt.ready = false;
    this.ready.delete(player.index);
    setMetric(this.metrics, 'wsReadyProfiles', this.ready.size);
    setMetric(this.metrics, 'wsReadyTables', readyTableIndexes(this.ready, this.players.length).length);
    clearInterval(attempt.ping);
    attempt.ping = null;
    const error = new Error(failureCode);
    this.failProfile(player, error, false);
    player.holdReject?.(error);
    this.closeSocket(attempt, true);
  }

  recomputeMatchmakingTableGauges() {
    setMetric(this.metrics, 'matchmakingConfirmedTables',
      this.tables.filter((item) => item.confirmed && !item.terminal).length);
    setMetric(this.metrics, 'matchmakingStartedTables',
      this.tables.filter((item) => item.started && !item.terminal).length);
    setMetric(this.metrics, 'matchmakingReadyTables',
      this.tables.filter((item) => item.ready && !item.terminal).length);
    setMetric(this.metrics, 'matchmakingFailedTables',
      this.tables.filter((item) => item.failureCode).length);
  }

  sendPing(attempt) {
    if (!this.isCurrent(attempt) || this.stopping || !attempt.ready) return;
    try {
      if (attempt.socket.readyState !== this.WebSocket.OPEN) throw new Error('socket not open');
      attempt.socket.send(JSON.stringify({ type: 'ping' }));
      incrementMetric(this.metrics, 'wsPings');
      this.progress();
    } catch {
      this.failHold(attempt.player, attempt, 'ping send failure');
    }
  }

  handleSocketFailure(attempt, reason) {
    if (!this.isCurrent(attempt) || this.stopping) return;
    if (attempt.ready) this.failHold(attempt.player, attempt, reason);
    else {
      this.closeSocket(attempt, true);
      this.settleAttempt(attempt, new Error(reason));
    }
  }

  handleClose(attempt) {
    this.markSocketInactive(attempt);
    this.sockets.delete(attempt);
    if (!this.isCurrent(attempt) || this.stopping) return;
    if (attempt.ready) this.failHold(attempt.player, attempt, 'socket closed during hold');
    else this.settleAttempt(attempt, new Error('WebSocket closed before connected'));
  }

  failHold(player, attempt, reason) {
    if (!this.isCurrent(attempt) || !attempt.ready || this.stopping) return;
    const table = this.tables[player.tableIndex];
    if (table?.terminal) return;
    if (player.matchmakingJoinSent) {
      this.countHoldFailure(player);
      if (table) this.failMatchmakingTable(table, 'socket_lost_after_join');
      return;
    }
    attempt.ready = false;
    player.ready = false;
    this.ready.delete(player.index);
    setMetric(this.metrics, 'wsReadyProfiles', this.ready.size);
    setMetric(this.metrics, 'wsReadyTables', readyTableIndexes(this.ready, this.players.length).length);
    clearInterval(attempt.ping);
    attempt.ping = null;
    this.countHoldFailure(player);
    this.failProfile(player, new Error(reason), true);
    player.holdReject?.(new Error(reason));
    this.closeSocket(attempt, true);
  }

  countHoldFailure(player) {
    if (player.holdFailureCounted) return;
    player.holdFailureCounted = true;
    incrementMetric(this.metrics, 'holdFailures');
  }

  failMatchmakingTable(table, failureCode) {
    if (table.terminal) return;
    table.terminal = true;
    table.failureCode = failureCode;
    table.confirmed = false;
    table.started = false;
    table.ready = false;
    incrementMetric(this.metrics, 'matchmakingTableFailures');
    for (const index of table.profileIndexes) {
      const player = this.players[index];
      const error = new Error(failureCode);
      player.ready = false;
      this.ready.delete(player.index);
      this.failProfile(player, error, true);
      player.holdReject?.(error);
      const attempt = player.attempt;
      if (attempt) {
        attempt.ready = false;
        clearInterval(attempt.ping);
        attempt.ping = null;
        this.closeSocket(attempt, true);
      }
    }
    setMetric(this.metrics, 'wsReadyProfiles', this.ready.size);
    setMetric(this.metrics, 'wsReadyTables', readyTableIndexes(this.ready, this.players.length).length);
    this.recomputeMatchmakingTableGauges();
    this.emitProgress('progress');
  }

  failProfile(player, error, _holdFailure) {
    if (player.terminalCounted) return;
    player.terminalCounted = true;
    player.terminalError = error instanceof Error ? error : new Error('terminal profile failure');
    this.failedProfileIndexes.add(player.index);
    incrementMetric(this.metrics, 'terminalProfileFailures');
    if (player.wsStarted) incrementMetric(this.metrics, 'wsTerminalFailures');
    const table = this.tables[player.tableIndex];
    if (table?.admitted && !table.joinStarted && !table.terminal && !this.stopping) {
      this.failMatchmakingTable(table, 'profile_failed_before_join');
    }
    this.emitProgress('progress');
  }

  settleAttempt(attempt, error, clearPing = true) {
    if (attempt.settled) return;
    attempt.settled = true;
    clearTimeout(attempt.timeout);
    attempt.timeout = null;
    if (clearPing) { clearInterval(attempt.ping); attempt.ping = null; }
    if (error) attempt.reject(error); else attempt.resolve();
  }

  isCurrent(attempt) {
    return attempt.player.generation === attempt.generation
      && attempt.player.attempt === attempt;
  }

  markSocketInactive(attempt) {
    if (!attempt.activeCounted) return;
    attempt.activeCounted = false;
    setMetric(this.metrics, 'currentActiveSockets',
      Math.max(0, this.metrics.currentActiveSockets - 1));
    this.progress();
  }

  waitUntil(atMs) { return this.waitFor(Math.max(0, atMs - Date.now())); }

  waitFor(ms) {
    if (this.stopping) return Promise.reject(new ShutdownError('shutdown'));
    return new Promise((resolve, reject) => {
      const waiter = { timer: null, reject };
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); resolve(); }, ms);
      this.waiters.add(waiter);
    });
  }

  scheduleAt(atMs, callback) {
    return setTimeout(callback, Math.max(0, atMs - Date.now()));
  }

  release() {
    if (this.stopping) return;
    setMetric(this.metrics, 'stableProfilesAtRelease', this.ready.size);
    setMetric(this.metrics, 'stableTablesAtRelease',
      readyTableIndexes(this.ready, this.players.length).length);
    this.progress();
    this.beginShutdown();
  }

  beginShutdown() {
    if (this.stopping) return;
    this.stopping = true;
    this.stopResolve?.();
    for (const controller of this.loginControllers) controller.abort();
    this.loginControllers.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new ShutdownError('shutdown'));
    }
    this.waiters.clear();
    for (const player of this.players) {
      player.holdResolve?.();
      const attempt = player.attempt;
      if (attempt && !attempt.settled) this.settleAttempt(attempt, new ShutdownError('shutdown'));
    }
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.beginShutdown();
    this.shutdownPromise = this.cleanup();
    return this.shutdownPromise;
  }

  async cleanup() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.releaseTimer);
    this.eventLoopDelay?.disable();
    for (const player of this.players) {
      player.generation += 1;
      player.ready = false;
      const attempt = player.attempt;
      if (attempt) {
        clearTimeout(attempt.timeout);
        clearInterval(attempt.ping);
        attempt.timeout = null;
        attempt.ping = null;
        this.closeSocket(attempt, false);
      }
    }
    this.ready.clear();
    setMetric(this.metrics, 'wsReadyProfiles', 0);
    setMetric(this.metrics, 'wsReadyTables', 0);
    const deadline = Date.now() + this.config.cleanupTimeoutMs;
    while (this.sockets.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (const attempt of [...this.sockets]) {
      this.closeSocket(attempt, true);
      this.markSocketInactive(attempt);
      this.sockets.delete(attempt);
    }
    setMetric(this.metrics, 'currentActiveSockets', 0);
    incrementMetric(this.metrics, 'cleanupCompleted');
    this.progress();
    this.send({ type: 'shutdown-complete', phase: 'complete', readiness: {
      peakProfiles: this.metrics.peakReadyProfiles,
      peakTables: this.metrics.peakReadyTables,
      stableProfilesAtRelease: this.metrics.stableProfilesAtRelease,
      stableTablesAtRelease: this.metrics.stableTablesAtRelease,
    },
      matchmaking: this.safeMatchmakingState(),
      failedProfileIndexes: [...this.failedProfileIndexes], metrics: safeMetrics(this.metrics) });
  }

  closeSocket(attempt, terminate) {
    const socket = attempt.socket;
    if (!socket) return;
    try {
      if (terminate) socket.terminate();
      else if (socket.readyState < this.WebSocket.CLOSING) socket.close(1000, 'shutdown');
    } catch { /* Cleanup remains bounded by cleanupTimeoutMs. */ }
  }

  phase(now = Date.now()) {
    if (this.metrics.cleanupCompleted) return 'complete';
    if (this.stopping) return 'cleanup';
    if (now < this.config.loginStartAtMs) return 'login-wait';
    if (now < this.config.wsStartAtMs) return 'login';
    if (now < this.config.readinessDeadlineAtMs && this.ready.size < this.players.length) {
      return 'readiness';
    }
    return 'hold';
  }

  progress() { this.lastProgressAtMs = Date.now(); }

  safeMatchmakingState() {
    const admittedTableIndexes = tableIndexes(this.tables, (table) => table.admitted);
    const joinStartedTableIndexes = tableIndexes(this.tables, (table) => table.joinStarted);
    const confirmedTableIndexes = tableIndexes(this.tables,
      (table) => table.confirmed && !table.terminal);
    const startedTableIndexes = tableIndexes(this.tables,
      (table) => table.started && !table.terminal);
    const readyTableIndexes = tableIndexes(this.tables,
      (table) => table.ready && !table.terminal);
    const failedTables = this.tables.filter((table) => table.failureCode);
    return {
      admittedTables: admittedTableIndexes.length,
      joinStartedTables: joinStartedTableIndexes.length,
      confirmedTables: confirmedTableIndexes.length,
      startedTables: startedTableIndexes.length,
      readyTables: readyTableIndexes.length,
      failedTables: failedTables.length,
      admittedTableIndexes,
      joinStartedTableIndexes,
      confirmedTableIndexes,
      startedTableIndexes,
      readyTableIndexes,
      failures: failedTables
        .map((table) => ({ tableIndex: table.index, failureCode: table.failureCode })),
    };
  }

  emitProgress(type) {
    if (type === 'heartbeat') incrementMetric(this.metrics, 'heartbeats');
    const memory = process.memoryUsage();
    const eventLoopDelayMeanMs = finiteDelay(this.eventLoopDelay?.mean);
    const eventLoopDelayMaxMs = finiteDelay(this.eventLoopDelay?.max);
    this.send({ type, phase: this.phase(), timestampMs: Date.now(),
      lastProgressAtMs: this.lastProgressAtMs, rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed, eventLoopDelayMeanMs, eventLoopDelayMaxMs,
      readyProfiles: this.ready.size,
      readyTables: readyTableIndexes(this.ready, this.players.length).length,
      matchmaking: this.safeMatchmakingState(),
      failedProfileIndexes: [...this.failedProfileIndexes], metrics: safeMetrics(this.metrics) });
    if (type === 'heartbeat') this.eventLoopDelay?.reset();
  }
}

function parseConfig(config, target) {
  const result = {
    ...target,
    loginStartAtMs: finite(config.loginStartAtMs, 'loginStartAtMs'),
    wsStartAtMs: finite(config.wsStartAtMs, 'wsStartAtMs'),
    readinessDeadlineAtMs: finite(config.readinessDeadlineAtMs, 'readinessDeadlineAtMs'),
    releaseAtMs: finite(config.releaseAtMs, 'releaseAtMs'),
    loginSpreadMs: nonnegative(config.loginSpreadMs, 0),
    loginTimeoutMs: positive(config.loginTimeoutMs, 10_000),
    attemptTimeoutMs: positive(config.attemptTimeoutMs, 10_000),
    maxAttempts: integer(config.maxAttempts, 3), retryBaseMs: positive(config.retryBaseMs, 250),
    retryMaxMs: positive(config.retryMaxMs, 2_000), pingIntervalMs: positive(config.pingIntervalMs, 20_000),
    heartbeatIntervalMs: positive(config.heartbeatIntervalMs, 2_000),
    cleanupTimeoutMs: positive(config.cleanupTimeoutMs, 1_000),
    jitter: Number.isFinite(config.jitter) && config.jitter >= 0 && config.jitter <= 1
      ? config.jitter : 0.2,
  };
  if (!(result.loginStartAtMs <= result.wsStartAtMs
      && result.wsStartAtMs < result.readinessDeadlineAtMs
      && result.readinessDeadlineAtMs <= result.releaseAtMs)) {
    throw new Error('Invalid absolute phase ordering');
  }
  if (result.loginSpreadMs > result.wsStartAtMs - result.loginStartAtMs) {
    throw new Error('loginSpreadMs exceeds the login window');
  }
  if (result.retryBaseMs > result.retryMaxMs) throw new Error('Invalid retry bounds');
  return result;
}

function finite(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} is required`);
  return value;
}
function positive(value, fallback) { return Number.isFinite(value) && value > 0 ? value : fallback; }
function nonnegative(value, fallback) { return Number.isFinite(value) && value >= 0 ? value : fallback; }
function integer(value, fallback) { return Number.isInteger(value) && value > 0 ? value : fallback; }
function finiteDelay(nanoseconds) {
  const milliseconds = nanoseconds / 1e6;
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.round(milliseconds * 1000) / 1000 : 0;
}

function createLocalTables(playerCount) {
  const tables = [];
  for (let first = 0; first + PLAYERS_PER_TABLE - 1 < playerCount; first += PLAYERS_PER_TABLE) {
    tables.push({
      index: first / PLAYERS_PER_TABLE,
      profileIndexes: Array.from({ length: PLAYERS_PER_TABLE }, (_, offset) => first + offset),
      admitted: false,
      joinStarted: false,
      confirmed: false,
      started: false,
      ready: false,
      terminal: false,
      failureCode: null,
      roomId: null,
      joinedAckProfileIndexes: new Set(),
      statusAckProfileIndexes: new Set(),
      matchFoundProfileIndexes: new Set(),
      snapshotProfileIndexes: new Set(),
      matchFoundSeats: new Map(),
      snapshotSeats: new Map(),
      snapshotRosters: new Map(),
      authoritativePhases: new Map(),
    });
  }
  return tables;
}

function normalizeId(value) {
  if (typeof value === 'string' && value.trim() === value && value !== '') return value;
  return null;
}

function validateSnapshotRoster(seats, yourSeat) {
  if (!Array.isArray(seats)) return { ok: false, failureCode: 'snapshot_roster_invalid' };
  if (seats.length !== PLAYERS_PER_TABLE) {
    return { ok: false, failureCode: 'snapshot_roster_invalid' };
  }
  const occupiedSeats = seats.filter((item) => item?.isOccupied === true);
  if (occupiedSeats.length !== PLAYERS_PER_TABLE) {
    return { ok: false, failureCode: 'snapshot_roster_invalid' };
  }
  const uniqueSeats = new Set();
  for (const item of occupiedSeats) {
    const seat = normalizeId(item?.seat);
    if (!seat) return { ok: false, failureCode: 'snapshot_roster_invalid' };
    if (item?.isBot !== false) return { ok: false, failureCode: 'bot_detected' };
    if (item?.isControlledByBot !== false) {
      return { ok: false, failureCode: 'seat_controlled_by_bot' };
    }
    if (item?.isConnected !== true) return { ok: false, failureCode: 'seat_not_connected' };
    if (!SERVER_SEAT_SET.has(seat)) return { ok: false, failureCode: 'unknown_seat' };
    if (uniqueSeats.has(seat)) return { ok: false, failureCode: 'duplicate_seat' };
    uniqueSeats.add(seat);
  }
  if (!SERVER_SEATS.every((seat) => uniqueSeats.has(seat))) {
    return { ok: false, failureCode: 'snapshot_roster_invalid' };
  }
  if (!uniqueSeats.has(yourSeat)) {
    return { ok: false, failureCode: 'snapshot_your_seat_missing' };
  }
  return { ok: true, key: SERVER_SEATS.join('|') };
}

function validateAuthoritativePhase(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string' || !AUTHORITATIVE_PHASES.has(value)) {
    return { ok: false, failureCode: 'invalid_authoritative_phase' };
  }
  return { ok: true, value };
}

function tableIndexes(tables, predicate) {
  return tables
    .filter(predicate)
    .map((table) => table.index)
    .sort((left, right) => left - right);
}

function seatAlreadyUsed(seatsByProfileIndex, profileIndex, seat) {
  for (const [otherProfileIndex, otherSeat] of seatsByProfileIndex) {
    if (otherProfileIndex !== profileIndex && otherSeat === seat) return true;
  }
  return false;
}

if (typeof process.send === 'function') {
  let worker;
  const safeProcessSend = (message) => {
    if (!process.connected || typeof process.send !== 'function') return false;
    try {
      process.send(message, () => { /* A disconnect race is intentionally ignored. */ });
      return true;
    } catch {
      return false;
    }
  };
  const handleIpcMessage = async (message) => {
    try {
      if (message?.type === 'start' && !worker) {
        worker = new WsWorker(message.config, message.credentials, safeProcessSend);
        await worker.start();
      } else if (message?.type === 'allow-matchmaking') {
        const accepted = worker?.allowMatchmakingTable(message.tableIndex) === true;
        safeProcessSend({ type: 'matchmaking-admission', tableIndex: message.tableIndex,
          accepted });
      } else if (message?.type === 'shutdown') {
        await worker?.shutdown();
        await worker?.startPromise;
        if (process.connected) process.disconnect();
      }
    } catch {
      safeProcessSend({ type: 'failed', metrics: safeMetrics(worker?.metrics) });
    }
  };
  process.on('message', handleIpcMessage);
  process.on('disconnect', () => {
    void worker?.shutdown().then(() => worker?.startPromise).catch(() => {});
  });
  safeProcessSend({ type: 'worker-ready' });
}
