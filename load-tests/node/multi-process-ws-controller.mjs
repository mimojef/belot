import process from 'node:process';
import { fork } from 'node:child_process';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  safeMetrics, sliceCredentials, validateTargetPair,
} from './multi-process-ws-common.mjs';

export const EXIT_CODES = Object.freeze({
  success: 0, workload: 1, configuration: 2, orchestration: 3, hardTimeout: 124,
});

const PLAYERS_PER_TABLE = 4;

const SUM_METRICS = Object.freeze([
  'loginAttempts', 'loginSuccesses', 'loginFailures', 'wsAttempts', 'wsOpens',
  'wsRetries', 'peakReadyProfiles', 'peakReadyTables', 'stableProfilesAtRelease',
  'stableTablesAtRelease', 'currentActiveSockets', 'peakActiveSockets',
  'terminalProfileFailures', 'wsTerminalFailures', 'holdFailures', 'wsPings',
  'wsPongs', 'cleanupCompleted',
]);

export class ControllerConfigError extends Error {
  constructor(message) { super(message); this.exitCode = EXIT_CODES.configuration; }
}

export function planCredentialSlices(credentials, tables, workerCount) {
  requireInteger(tables, 'tables', 1, 400);
  requireInteger(workerCount, 'workerCount', 1, 32);
  if (workerCount > tables) throw new ControllerConfigError('workerCount must not exceed tables');
  const requiredProfiles = tables * 4;
  if (!Array.isArray(credentials) || credentials.length < requiredProfiles) {
    throw new ControllerConfigError(`At least ${requiredProfiles} credentials are required`);
  }
  const baseTables = Math.floor(tables / workerCount);
  const extra = tables % workerCount;
  let profileOffset = 0;
  return Array.from({ length: workerCount }, (_, workerIndex) => {
    const tableCount = baseTables + (workerIndex < extra ? 1 : 0);
    const profileCount = tableCount * 4;
    const credentialsSlice = sliceCredentials(credentials, profileOffset, profileCount);
    const plan = { workerIndex, tableOffset: profileOffset / 4, tableCount,
      profileOffset, profileCount, credentials: credentialsSlice };
    profileOffset += profileCount;
    return plan;
  });
}

export async function atomicWriteJson(path, value, io = {}) {
  const makeDirectory = io.mkdir ?? mkdir;
  const write = io.writeFile ?? writeFile;
  const move = io.rename ?? rename;
  await makeDirectory(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await write(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await move(tempPath, path);
}

export function determineExitCode(summary) {
  if (summary.exitCode === EXIT_CODES.hardTimeout) return EXIT_CODES.hardTimeout;
  if (summary.metrics.workerCrashes > 0 || summary.metrics.heartbeatTimeouts > 0
      || summary.cleanup.forcedWorkers > 0 || summary.cleanup.incompleteWorkers > 0) {
    return EXIT_CODES.orchestration;
  }
  if (summary.matchmaking?.enabled === true
      && summary.matchmaking.completionStatus !== 'complete') {
    return EXIT_CODES.workload;
  }
  const expected = summary.expected;
  const metrics = summary.metrics;
  const workloadFailed = metrics.stableProfilesAtRelease !== expected.profiles
    || metrics.stableTablesAtRelease !== expected.tables
    || metrics.loginFailures > 0 || metrics.terminalProfileFailures > 0
    || metrics.wsTerminalFailures > 0 || metrics.holdFailures > 0;
  return workloadFailed ? EXIT_CODES.workload : EXIT_CODES.success;
}

export class MultiProcessWsController {
  constructor(config, dependencies = {}) {
    this.input = config ?? {};
    this.fork = dependencies.fork ?? fork;
    this.readFile = dependencies.readFile ?? readFile;
    this.writeSummary = dependencies.atomicWriteJson ?? atomicWriteJson;
    this.now = dependencies.now ?? Date.now;
    this.workerPath = dependencies.workerPath
      ?? new URL('./multi-process-ws-worker.mjs', import.meta.url);
    this.workers = [];
    this.workerCrashes = 0;
    this.heartbeatTimeouts = 0;
    this.forcedWorkers = 0;
    this.startedAtMs = this.now();
    this.writeChain = Promise.resolve();
    this.stopping = false;
  }

  async preflight() {
    const target = validateTargetPair(this.input.baseUrl, this.input.wsUrl);
    const tables = requireInteger(this.input.tables, 'tables', 1, 400);
    const workerCount = requireInteger(this.input.workerCount, 'workerCount', 1, 32);
    const credentialsPath = requireString(this.input.credentialsPath, 'credentialsPath');
    const outputDirectory = resolve(requireString(this.input.outputDirectory, 'outputDirectory'));
    const raw = await this.readFile(resolve(credentialsPath), 'utf8').catch(() => {
      throw new ControllerConfigError('Unable to read credentials JSON');
    });
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new ControllerConfigError('Invalid credentials JSON'); }
    if (!parsed || !Array.isArray(parsed.users)) {
      throw new ControllerConfigError('Credentials JSON must have a users array');
    }
    const slices = planCredentialSlices(parsed.users, tables, workerCount);
    const loginSpreadMs = nonnegative(this.input.loginSpreadMs, 'loginSpreadMs');
    const readinessDurationMs = positive(this.input.readinessDurationMs, 'readinessDurationMs');
    const holdDurationMs = positive(this.input.holdDurationMs, 'holdDurationMs');
    const heartbeatTimeoutMs = positive(this.input.heartbeatTimeoutMs, 'heartbeatTimeoutMs');
    const hardTimeoutMs = positive(this.input.hardTimeoutMs, 'hardTimeoutMs');
    const shutdownGraceMs = positive(this.input.shutdownGraceMs ?? 5_000, 'shutdownGraceMs');
    const partialIntervalMs = positive(
      this.input.partialIntervalMs ?? Math.max(100, Math.floor(heartbeatTimeoutMs / 2)),
      'partialIntervalMs',
    );
    const wsStartDelayMs = nonnegative(
      this.input.wsStartDelayMs ?? loginSpreadMs + 1_000, 'wsStartDelayMs',
    );
    if (loginSpreadMs > wsStartDelayMs) {
      throw new ControllerConfigError('loginSpreadMs exceeds WS start delay');
    }
    const heartbeatIntervalMs = positive(
      this.input.heartbeatIntervalMs ?? 2_000, 'heartbeatIntervalMs',
    );
    if (heartbeatIntervalMs >= heartbeatTimeoutMs) {
      throw new ControllerConfigError('heartbeatIntervalMs must be less than heartbeatTimeoutMs');
    }
    const retryBaseMs = positive(this.input.retryBaseMs ?? 250, 'retryBaseMs');
    const retryMaxMs = positive(this.input.retryMaxMs ?? 2_000, 'retryMaxMs');
    if (retryBaseMs > retryMaxMs) {
      throw new ControllerConfigError('retryBaseMs must not exceed retryMaxMs');
    }
    const matchmakingEnabled = parseBoolean(this.input.matchmakingEnabled ?? false, 'matchmakingEnabled');
    const matchmakingTableTimeoutMs = positive(
      this.input.matchmakingTableTimeoutMs ?? Math.max(1_000, readinessDurationMs),
      'matchmakingTableTimeoutMs',
    );
    const matchmakingAdmissionPauseMs = nonnegative(
      this.input.matchmakingAdmissionPauseMs ?? 0,
      'matchmakingAdmissionPauseMs',
    );
    return {
      ...target, tables, workerCount, credentialsPath: resolve(credentialsPath), outputDirectory,
      slices, profiles: tables * 4, loginSpreadMs, readinessDurationMs, holdDurationMs,
      heartbeatTimeoutMs, hardTimeoutMs, shutdownGraceMs, partialIntervalMs, wsStartDelayMs,
      loginTimeoutMs: positive(this.input.loginTimeoutMs ?? 10_000, 'loginTimeoutMs'),
      attemptTimeoutMs: positive(this.input.attemptTimeoutMs ?? 10_000, 'attemptTimeoutMs'),
      maxAttempts: requireInteger(this.input.maxAttempts ?? 3, 'maxAttempts', 1),
      retryBaseMs, retryMaxMs,
      pingIntervalMs: positive(this.input.pingIntervalMs ?? 20_000, 'pingIntervalMs'),
      heartbeatIntervalMs,
      cleanupTimeoutMs: positive(this.input.cleanupTimeoutMs ?? 1_000, 'cleanupTimeoutMs'),
      jitter: typeof this.input.jitter === 'number' ? this.input.jitter : 0.2,
      matchmakingEnabled, matchmakingTableTimeoutMs, matchmakingAdmissionPauseMs,
    };
  }

  async run() {
    try {
      this.config = await this.preflight();
    } catch (error) {
      const summary = this.preflightSummary(error);
      if (this.input.outputDirectory) {
        const finalPath = join(resolve(this.input.outputDirectory), 'multi-process-ws-final.json');
        try { await this.writeSummary(finalPath, summary); } catch {
          summary.exitCode = EXIT_CODES.orchestration;
          summary.exitReason = 'final summary write failed';
          console.error('Controller final summary write failed');
        }
      }
      return summary;
    }
    this.installSignalHandlers();
    this.donePromise = new Promise((resolveDone) => { this.resolveDone = resolveDone; });
    this.partialTimer = setInterval(() => this.queueSummaryWrite(false), this.config.partialIntervalMs);
    this.monitorTimer = setInterval(() => this.monitorWorkers(),
      Math.max(10, Math.min(250, Math.floor(this.config.heartbeatTimeoutMs / 4))));
    this.hardTimer = setTimeout(() => this.requestShutdown(
      'hard timeout', EXIT_CODES.hardTimeout,
    ), this.config.hardTimeoutMs);
    let spawnError = null;
    for (const slice of this.config.slices) {
      try { this.spawnWorker(slice); } catch (error) { spawnError = error; break; }
    }
    this.spawnComplete = true;
    if (spawnError) {
      this.workerCrashes += 1;
      this.requestShutdown('worker fork failed', EXIT_CODES.orchestration);
    }
    const summary = await this.donePromise;
    this.removeSignalHandlers();
    return summary;
  }

  spawnWorker(slice) {
    const child = this.fork(this.workerPath, [String(slice.workerIndex)], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const state = {
      child, slice, ready: false, started: false, shutdownComplete: false,
      exited: false, disconnected: false, forced: false, lastHeartbeatAtMs: this.now(),
      lastProgressAtMs: null, phase: 'boot', exitCode: null, signalCode: null,
      exitedAtMs: null, metrics: safeMetrics(), matchmaking: safeMatchmakingSnapshot(),
      memory: null, eventLoopDelay: null,
    };
    this.workers.push(state);
    child.on('message', (message) => this.handleMessage(state, message));
    child.on('error', () => this.handleWorkerFailure(state, 'worker error'));
    child.on('disconnect', () => {
      state.disconnected = true;
      if (!state.shutdownComplete && !this.stopping) this.handleWorkerFailure(state, 'IPC disconnect');
    });
    child.on('exit', (exitCode, signalCode) => {
      state.exited = true;
      state.exitCode = exitCode;
      state.signalCode = signalCode;
      state.exitedAtMs = this.now();
      const expectedForcedExit = state.forced
        && (this.requestedExitCode === EXIT_CODES.orchestration
          || this.requestedExitCode === EXIT_CODES.hardTimeout);
      if ((exitCode !== 0 || signalCode !== null) && !expectedForcedExit) {
        this.recordOrchestrationFailure(state, 'unexpected worker exit');
      } else if (!state.shutdownComplete && !this.stopping) {
        this.recordOrchestrationFailure(state, 'worker crash');
      }
      this.maybeFinalize();
    });
  }

  handleMessage(state, message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'worker-ready') {
      state.ready = true;
      state.lastHeartbeatAtMs = this.now();
      if (this.workers.length === this.config.workerCount
          && this.workers.every((worker) => worker.ready)) this.startWorkers();
      return;
    }
    if (message.type === 'heartbeat') state.lastHeartbeatAtMs = this.now();
    if (message.type === 'failed') {
      this.updateWorkerSnapshot(state, message);
      state.failed = true;
      this.recordOrchestrationFailure(state, 'worker reported failure');
      return;
    }
    if (message.type === 'heartbeat' || message.type === 'progress') {
      this.updateWorkerSnapshot(state, message);
      this.driveMatchmaking();
      return;
    }
    if (message.type === 'matchmaking-admission') {
      this.handleMatchmakingAdmissionAck(state, message);
      return;
    }
    if (message.type === 'shutdown-complete') {
      const failedMetrics = state.failed ? state.metrics : null;
      this.updateWorkerSnapshot(state, message);
      this.driveMatchmaking();
      if (failedMetrics) state.metrics = failedMetrics;
      state.shutdownComplete = true;
      this.safeSend(state, { type: 'shutdown' });
      if (this.workers.every((worker) => worker.shutdownComplete)) this.beginGracefulExit();
    }
  }

  startWorkers() {
    if (this.workloadStarted || this.stopping) return;
    this.workloadStarted = true;
    const createdAtMs = this.now();
    const loginStartAtMs = createdAtMs;
    const wsStartAtMs = createdAtMs + this.config.wsStartDelayMs;
    const readinessDeadlineAtMs = wsStartAtMs + this.config.readinessDurationMs;
    const releaseAtMs = readinessDeadlineAtMs + this.config.holdDurationMs;
    this.timestamps = { loginStartAtMs, wsStartAtMs, readinessDeadlineAtMs, releaseAtMs };
    this.initializeMatchmakingState();
    for (const state of this.workers) {
      state.started = this.safeSend(state, { type: 'start', config: {
        baseUrl: this.config.baseUrl, wsUrl: this.config.wsUrl, ...this.timestamps,
        loginSpreadMs: this.config.loginSpreadMs, loginTimeoutMs: this.config.loginTimeoutMs,
        attemptTimeoutMs: this.config.attemptTimeoutMs, maxAttempts: this.config.maxAttempts,
        retryBaseMs: this.config.retryBaseMs, retryMaxMs: this.config.retryMaxMs,
        pingIntervalMs: this.config.pingIntervalMs,
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
        cleanupTimeoutMs: this.config.cleanupTimeoutMs, jitter: this.config.jitter,
      }, credentials: state.slice.credentials });
      if (!state.started) this.handleWorkerFailure(state, 'failed to send worker start');
    }
  }

  updateWorkerSnapshot(state, message) {
    state.metrics = safeMetrics(message.metrics);
    state.matchmaking = safeMatchmakingSnapshot(message.matchmaking);
    this.scanWorkerMatchmakingFailures(state);
    this.scanWorkerTerminalProfileFailures(state);
    if (typeof message.phase === 'string') state.phase = message.phase;
    if (Number.isFinite(message.lastProgressAtMs)) {
      state.lastProgressAtMs = message.lastProgressAtMs;
    }
    if (Number.isFinite(message.rssBytes) && Number.isFinite(message.heapUsedBytes)) {
      state.memory = { rssBytes: message.rssBytes, heapUsedBytes: message.heapUsedBytes };
    }
    if (Number.isFinite(message.eventLoopDelayMeanMs)
        && Number.isFinite(message.eventLoopDelayMaxMs)) {
      state.eventLoopDelay = { meanMs: message.eventLoopDelayMeanMs,
        maxMs: message.eventLoopDelayMaxMs };
    }
  }

  monitorWorkers() {
    if (this.stopping) return;
    const now = this.now();
    for (const state of this.workers) {
      if (!state.exited && now - state.lastHeartbeatAtMs > this.config.heartbeatTimeoutMs) {
        this.heartbeatTimeouts += 1;
        this.requestShutdown(`heartbeat timeout for worker ${state.slice.workerIndex}`,
          EXIT_CODES.orchestration);
        return;
      }
    }
    this.checkMatchmakingReadinessDeadline(now);
    this.checkMatchmakingTimeout(now);
  }

  initializeMatchmakingState() {
    if (!this.config.matchmakingEnabled) {
      this.matchmaking = this.safeInitialMatchmakingState('disabled');
      return;
    }
    this.matchmaking = {
      enabled: true,
      status: 'waiting-ready',
      expectedTables: this.config.tables,
      admittedGlobalTableIndexes: new Set(),
      startedGlobalTableIndexes: new Set(),
      processedWorkerFailures: new Set(),
      processedTerminalFailureWorkers: new Set(),
      failedTables: [],
      failureCode: null,
      failureWorkerIndex: null,
      currentGlobalTableIndex: null,
      nextGlobalTableIndex: 0,
      tableStartedAtMs: null,
      completionStatus: 'pending',
    };
  }

  safeInitialMatchmakingState(status) {
    return {
      enabled: false,
      status,
      expectedTables: this.config?.tables ?? 0,
      admittedGlobalTableIndexes: new Set(),
      startedGlobalTableIndexes: new Set(),
      processedWorkerFailures: new Set(),
      processedTerminalFailureWorkers: new Set(),
      failedTables: [],
      failureCode: null,
      failureWorkerIndex: null,
      currentGlobalTableIndex: null,
      nextGlobalTableIndex: 0,
      tableStartedAtMs: null,
      completionStatus: status,
    };
  }

  driveMatchmaking() {
    if (!this.config?.matchmakingEnabled || this.stopping) return;
    if (!this.matchmaking) this.initializeMatchmakingState();
    if (this.matchmaking.completionStatus !== 'pending') return;
    this.updateCurrentMatchmakingTable();
    if (this.matchmaking.currentGlobalTableIndex !== null) return;
    if (!this.allExpectedProfilesReady()) {
      this.matchmaking.status = 'waiting-ready';
      return;
    }
    if (this.matchmaking.nextGlobalTableIndex >= this.config.tables) {
      this.matchmaking.status = 'complete';
      this.matchmaking.completionStatus = 'complete';
      this.clearMatchmakingTimer();
      this.queueSummaryWrite(false);
      return;
    }
    this.scheduleOrAdmitNextMatchmakingTable();
  }

  scheduleOrAdmitNextMatchmakingTable() {
    if (this.matchmakingPauseTimer) return;
    const pauseMs = this.matchmaking.lastStartedAtMs === undefined
      ? 0 : this.config.matchmakingAdmissionPauseMs;
    if (pauseMs > 0) {
      this.matchmaking.status = 'paused';
      this.matchmakingPauseTimer = setTimeout(() => {
        this.matchmakingPauseTimer = null;
        this.admitNextMatchmakingTable();
      }, pauseMs);
      return;
    }
    this.admitNextMatchmakingTable();
  }

  admitNextMatchmakingTable() {
    if (this.stopping || this.matchmaking.currentGlobalTableIndex !== null
        || this.matchmaking.nextGlobalTableIndex >= this.config.tables) {
      return;
    }
    const globalTableIndex = this.matchmaking.nextGlobalTableIndex;
    if (this.matchmaking.admittedGlobalTableIndexes.has(globalTableIndex)) return;
    const target = this.workerForGlobalTable(globalTableIndex);
    if (!target) {
      this.requestShutdown('matchmaking mapping failed', EXIT_CODES.orchestration);
      return;
    }
    const sent = this.safeSend(target.state, {
      type: 'allow-matchmaking',
      tableIndex: target.localTableIndex,
    });
    if (!sent) {
      this.handleWorkerFailure(target.state, 'failed to send matchmaking admission');
      return;
    }
    this.matchmaking.currentGlobalTableIndex = globalTableIndex;
    this.matchmaking.nextGlobalTableIndex += 1;
    this.matchmaking.admittedGlobalTableIndexes.add(globalTableIndex);
    this.matchmaking.tableStartedAtMs = this.now();
    this.matchmaking.status = 'admitted';
    this.clearMatchmakingTimer();
    this.matchmakingTimer = setTimeout(() => this.handleMatchmakingTimeout(globalTableIndex),
      this.config.matchmakingTableTimeoutMs);
    this.queueSummaryWrite(false);
  }

  handleMatchmakingAdmissionAck(state, message) {
    if (!this.config?.matchmakingEnabled || this.stopping) return;
    if (!Number.isInteger(message.tableIndex) || message.tableIndex < 0) return;
    const globalTableIndex = state.slice.tableOffset + message.tableIndex;
    if (globalTableIndex !== this.matchmaking?.currentGlobalTableIndex) return;
    if (message.accepted !== true) {
      this.failCurrentMatchmakingTable('admission_rejected');
    }
  }

  updateCurrentMatchmakingTable() {
    const globalTableIndex = this.matchmaking.currentGlobalTableIndex;
    if (globalTableIndex === null) return;
    const target = this.workerForGlobalTable(globalTableIndex);
    if (!target) {
      this.requestShutdown('matchmaking mapping failed', EXIT_CODES.orchestration);
      return;
    }
    const matchmaking = target.state.matchmaking;
    const started = matchmaking.startedTableIndexes.includes(target.localTableIndex)
      || matchmaking.readyTableIndexes.includes(target.localTableIndex);
    if (!started) return;
    if (!this.matchmaking.startedGlobalTableIndexes.has(globalTableIndex)) {
      this.matchmaking.startedGlobalTableIndexes.add(globalTableIndex);
      this.matchmaking.lastStartedAtMs = this.now();
    }
    this.matchmaking.currentGlobalTableIndex = null;
    this.matchmaking.tableStartedAtMs = null;
    this.matchmaking.status = 'started';
    this.clearMatchmakingTimer();
    this.queueSummaryWrite(false);
  }

  failCurrentMatchmakingTable(reason) {
    if (!this.matchmaking || this.matchmaking.completionStatus !== 'pending') return;
    const globalTableIndex = this.matchmaking.currentGlobalTableIndex;
    this.matchmaking.status = 'failed';
    this.matchmaking.completionStatus = 'failed';
    if (globalTableIndex !== null
        && !this.matchmaking.failedTables.some((item) => item.globalTableIndex === globalTableIndex)) {
      this.matchmaking.failedTables.push({ globalTableIndex, failureCode: reason });
    }
    this.clearMatchmakingTimer();
    clearTimeout(this.matchmakingPauseTimer);
    this.matchmakingPauseTimer = null;
    this.requestShutdown('matchmaking table failed', EXIT_CODES.workload);
  }

  scanWorkerMatchmakingFailures(state) {
    if (!this.config?.matchmakingEnabled) return;
    if (!this.matchmaking) this.initializeMatchmakingState();
    for (const failure of state.matchmaking.failures) {
      if (!Number.isInteger(failure.tableIndex)
          || failure.tableIndex < 0
          || failure.tableIndex >= state.slice.tableCount) {
        this.requestedExitCode = EXIT_CODES.orchestration;
        this.exitReason = 'invalid matchmaking failure index';
        this.requestShutdown('invalid matchmaking failure index', EXIT_CODES.orchestration);
        return;
      }
      const key = `${state.slice.workerIndex}:${failure.tableIndex}`;
      if (this.matchmaking.processedWorkerFailures.has(key)) continue;
      this.matchmaking.processedWorkerFailures.add(key);
      const globalTableIndex = state.slice.tableOffset + failure.tableIndex;
      this.recordMatchmakingTableFailure(globalTableIndex, failure.failureCode);
      return;
    }
  }

  scanWorkerTerminalProfileFailures(state) {
    if (!this.config?.matchmakingEnabled || !this.matchmaking) return;
    if ((state.metrics.terminalProfileFailures ?? 0) <= 0) return;
    const key = String(state.slice.workerIndex);
    if (this.matchmaking.processedTerminalFailureWorkers.has(key)) return;
    this.matchmaking.processedTerminalFailureWorkers.add(key);
    if (this.matchmaking.failedTables.length > 0 || this.hasStrongerFailure()) return;
    this.recordGenericMatchmakingFailure('profile_failure_before_admission',
      state.slice.workerIndex, 'matchmaking readiness failed');
  }

  recordMatchmakingTableFailure(globalTableIndex, failureCode) {
    if (!this.matchmaking.failedTables.some((item) => item.globalTableIndex === globalTableIndex)) {
      this.matchmaking.failedTables.push({ globalTableIndex, failureCode });
    }
    this.matchmaking.status = 'failed';
    this.matchmaking.completionStatus = 'failed';
    this.matchmaking.failureCode = failureCode;
    this.matchmaking.failureWorkerIndex = null;
    this.clearMatchmakingTimer();
    clearTimeout(this.matchmakingPauseTimer);
    this.matchmakingPauseTimer = null;
    if (this.requestedExitCode !== EXIT_CODES.orchestration
        && this.requestedExitCode !== EXIT_CODES.hardTimeout) {
      this.requestedExitCode = EXIT_CODES.workload;
      this.exitReason = 'matchmaking table failed';
    }
    if (!this.stopping) this.requestShutdown('matchmaking table failed', EXIT_CODES.workload);
  }

  recordGenericMatchmakingFailure(failureCode, workerIndex, exitReason) {
    if (!this.config?.matchmakingEnabled || !this.matchmaking || this.hasStrongerFailure()) return;
    if (this.matchmaking.failedTables.length > 0) return;
    this.matchmaking.status = 'failed';
    this.matchmaking.completionStatus = 'failed';
    this.matchmaking.failureCode = failureCode;
    this.matchmaking.failureWorkerIndex = Number.isInteger(workerIndex) ? workerIndex : null;
    this.clearMatchmakingTimer();
    clearTimeout(this.matchmakingPauseTimer);
    this.matchmakingPauseTimer = null;
    this.requestedExitCode = EXIT_CODES.workload;
    this.exitReason = exitReason;
    if (!this.stopping) this.requestShutdown(exitReason, EXIT_CODES.workload);
  }

  hasStrongerFailure() {
    return this.requestedExitCode === EXIT_CODES.orchestration
      || this.requestedExitCode === EXIT_CODES.hardTimeout;
  }

  checkMatchmakingReadinessDeadline(now) {
    if (!this.config?.matchmakingEnabled || !this.matchmaking
        || this.matchmaking.completionStatus !== 'pending'
        || !this.timestamps
        || now < this.timestamps.readinessDeadlineAtMs
        || this.allExpectedProfilesReady()) {
      return;
    }
    this.recordGenericMatchmakingFailure('readiness_timeout', null,
      'matchmaking readiness failed');
  }

  checkMatchmakingTimeout(now) {
    if (!this.config?.matchmakingEnabled || !this.matchmaking
        || this.matchmaking.currentGlobalTableIndex === null
        || this.matchmaking.completionStatus !== 'pending') {
      return;
    }
    if (now - this.matchmaking.tableStartedAtMs >= this.config.matchmakingTableTimeoutMs) {
      this.handleMatchmakingTimeout(this.matchmaking.currentGlobalTableIndex);
    }
  }

  handleMatchmakingTimeout(globalTableIndex) {
    if (this.stopping || !this.matchmaking || this.matchmaking.currentGlobalTableIndex !== globalTableIndex
        || this.matchmaking.completionStatus !== 'pending') {
      return;
    }
    this.matchmaking.status = 'timeout';
    this.matchmaking.completionStatus = 'timeout';
    this.matchmaking.failedTables.push({ globalTableIndex, failureCode: 'table_timeout' });
    this.clearMatchmakingTimer();
    this.requestShutdown('matchmaking table timeout', EXIT_CODES.workload);
  }

  clearMatchmakingTimer() {
    clearTimeout(this.matchmakingTimer);
    this.matchmakingTimer = null;
  }

  allExpectedProfilesReady() {
    if (this.workers.length !== this.config.workerCount) return false;
    return this.workers.every((state) => (
      (state.metrics.wsReadyProfiles ?? 0) >= state.slice.profileCount
    ));
  }

  workerForGlobalTable(globalTableIndex) {
    return this.workers.reduce((found, state) => {
      if (found) return found;
      const first = state.slice.tableOffset;
      const last = first + state.slice.tableCount;
      if (globalTableIndex < first || globalTableIndex >= last) return null;
      return { state, localTableIndex: globalTableIndex - first };
    }, null);
  }

  handleWorkerFailure(state, reason) {
    this.recordOrchestrationFailure(state, reason);
  }

  recordOrchestrationFailure(state, reason) {
    if (!state.crashCounted) { state.crashCounted = true; this.workerCrashes += 1; }
    if (this.requestedExitCode !== EXIT_CODES.hardTimeout) {
      this.requestedExitCode = EXIT_CODES.orchestration;
      this.exitReason = `${reason} for worker ${state.slice.workerIndex}`;
    }
    if (!this.stopping) this.requestShutdown(this.exitReason, EXIT_CODES.orchestration);
  }

  requestShutdown(reason, exitCode = EXIT_CODES.orchestration) {
    if (this.stopping) return this.shutdownPromise;
    this.stopping = true;
    this.exitReason = reason;
    this.requestedExitCode = exitCode;
    this.shutdownPromise = new Promise((resolveShutdown) => {
      for (const state of this.workers) {
        if (!state.exited) this.safeSend(state, { type: 'shutdown' });
      }
      this.graceTimer = setTimeout(() => {
        for (const state of this.workers) {
          if (!state.exited) {
            state.forced = true;
            this.forcedWorkers += 1;
            try { state.child.kill(); } catch { /* Only this controller's child is targeted. */ }
          }
        }
        resolveShutdown();
        this.maybeFinalize();
      }, this.config.shutdownGraceMs);
    });
    return this.shutdownPromise;
  }

  beginGracefulExit() {
    if (!this.stopping) {
      if (this.config?.matchmakingEnabled
          && this.matchmaking?.completionStatus !== 'complete') {
        this.recordGenericMatchmakingFailure('matchmaking_incomplete_at_release',
          null, 'matchmaking incomplete at release');
        return;
      }
      this.stopping = true;
      this.exitReason = 'release completed';
      for (const state of this.workers) this.safeSend(state, { type: 'shutdown' });
      this.graceTimer = setTimeout(() => {
        for (const state of this.workers) {
          if (!state.exited) {
            state.forced = true;
            this.forcedWorkers += 1;
            try { state.child.kill(); } catch { /* Bound to owned children. */ }
          }
        }
        this.maybeFinalize();
      }, this.config.shutdownGraceMs);
    }
  }

  safeSend(state, message) {
    if (state.exited || !state.child.connected) return false;
    try { state.child.send(message, () => {}); return true; } catch { return false; }
  }

  maybeFinalize() {
    if (this.finished || !this.spawnComplete || !this.workers.every((state) => state.exited)) return;
    this.finished = true;
    clearInterval(this.partialTimer);
    clearInterval(this.monitorTimer);
    clearTimeout(this.hardTimer);
    clearTimeout(this.graceTimer);
    this.clearMatchmakingTimer();
    clearTimeout(this.matchmakingPauseTimer);
    this.completedAtMs = this.now();
    const summary = this.buildSummary('final');
    summary.exitCode = this.requestedExitCode ?? determineExitCode(summary);
    summary.exitReason = this.exitReason ?? (summary.exitCode === 0 ? 'success' : 'workload failure');
    this.queueSummaryWrite(true, summary).then(() => this.resolveDone(summary)).catch(() => {
      summary.exitCode = EXIT_CODES.orchestration;
      summary.exitReason = 'final summary write failed';
      console.error('Controller final summary write failed');
      this.resolveDone(summary);
    });
  }

  aggregateMetrics() {
    const total = Object.fromEntries(SUM_METRICS.map((name) => [name, 0]));
    for (const state of this.workers) {
      for (const name of SUM_METRICS) total[name] += state.metrics[name] ?? 0;
    }
    total.workerCrashes = this.workerCrashes;
    total.heartbeatTimeouts = this.heartbeatTimeouts;
    return total;
  }

  buildSummary(status) {
    const workerSummaries = this.workers.map((state) => ({
      workerIndex: state.slice.workerIndex, tableOffset: state.slice.tableOffset,
      tableCount: state.slice.tableCount, profileOffset: state.slice.profileOffset,
      profileCount: state.slice.profileCount, ready: state.ready, started: state.started,
      shutdownComplete: state.shutdownComplete, exited: state.exited, forced: state.forced,
      failed: state.failed === true,
      exitCode: state.exitCode, signalCode: state.signalCode, exitedAtMs: state.exitedAtMs,
      phase: state.phase, lastHeartbeatAtMs: state.lastHeartbeatAtMs,
      lastProgressAtMs: state.lastProgressAtMs,
      metrics: state.metrics, memory: state.memory, eventLoopDelay: state.eventLoopDelay,
      matchmaking: state.matchmaking,
    }));
    return {
      schemaVersion: 1, status, generatedAtMs: this.now(),
      startedAtMs: this.startedAtMs, completedAtMs: status === 'final' ? this.completedAtMs : null,
      durationMs: (status === 'final' ? this.completedAtMs : this.now()) - this.startedAtMs,
      safeConfig: this.safeConfig(), timestamps: this.timestamps ?? null,
      expected: { tables: this.config.tables, profiles: this.config.profiles,
        workers: this.config.workerCount },
      metrics: this.aggregateMetrics(), matchmaking: this.safeControllerMatchmakingState(),
      workers: workerSummaries,
      cleanup: { completedWorkers: workerSummaries.filter((item) => item.shutdownComplete).length,
        incompleteWorkers: workerSummaries.filter((item) => !item.shutdownComplete).length
          + (this.config.workerCount - workerSummaries.length),
        forcedWorkers: this.forcedWorkers },
      exitReason: this.exitReason ?? null, exitCode: this.requestedExitCode ?? null,
    };
  }

  safeConfig() {
    return { tables: this.config.tables, workerCount: this.config.workerCount,
      baseUrl: this.config.baseUrl, wsUrl: this.config.wsUrl,
      loginSpreadMs: this.config.loginSpreadMs,
      readinessDurationMs: this.config.readinessDurationMs,
      holdDurationMs: this.config.holdDurationMs,
      heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
      hardTimeoutMs: this.config.hardTimeoutMs,
      matchmakingEnabled: this.config.matchmakingEnabled,
      matchmakingTableTimeoutMs: this.config.matchmakingTableTimeoutMs,
      matchmakingAdmissionPauseMs: this.config.matchmakingAdmissionPauseMs };
  }

  safeControllerMatchmakingState() {
    if (!this.matchmaking) return { enabled: false, status: 'disabled',
      completionStatus: 'disabled', expectedTables: this.config?.tables ?? 0,
      currentGlobalTableIndex: null, admittedTables: 0, startedTables: 0,
      failedTables: 0, failureCode: null, failureWorkerIndex: null,
      admittedTableIndexes: [], startedTableIndexes: [], failures: [] };
    const admittedTableIndexes = sortedIndexes(this.matchmaking.admittedGlobalTableIndexes);
    const startedTableIndexes = sortedIndexes(this.matchmaking.startedGlobalTableIndexes);
    const failures = [...this.matchmaking.failedTables]
      .sort((left, right) => left.globalTableIndex - right.globalTableIndex)
      .map((item) => ({
        globalTableIndex: item.globalTableIndex,
        failureCode: item.failureCode,
      }));
    return {
      enabled: this.matchmaking.enabled,
      status: this.matchmaking.status,
      completionStatus: this.matchmaking.completionStatus,
      expectedTables: this.matchmaking.expectedTables,
      currentGlobalTableIndex: this.matchmaking.currentGlobalTableIndex,
      admittedTables: admittedTableIndexes.length,
      startedTables: startedTableIndexes.length,
      failedTables: failures.length,
      failureCode: this.matchmaking.failureCode,
      failureWorkerIndex: this.matchmaking.failureWorkerIndex,
      admittedTableIndexes,
      startedTableIndexes,
      failures,
    };
  }

  queueSummaryWrite(final, summary = null) {
    if (!final && (this.stopping || this.partialWritePending || this.partialWriteFailed)) {
      return Promise.resolve();
    }
    const path = join(this.config.outputDirectory,
      final ? 'multi-process-ws-final.json' : 'multi-process-ws-partial.json');
    const value = summary ?? this.buildSummary('partial');
    if (!final) this.partialWritePending = true;
    const operation = this.writeChain.then(() => this.writeSummary(path, value)).finally(() => {
      if (!final) this.partialWritePending = false;
    });
    this.writeChain = operation.catch(() => {});
    if (final) return operation;
    operation.catch(() => {
      if (this.partialWriteFailed) return;
      this.partialWriteFailed = true;
      console.error('Controller partial summary write failed');
      this.requestShutdown('partial summary write failed', EXIT_CODES.orchestration);
    });
    return operation.catch(() => {});
  }

  preflightSummary(error) {
    const completedAtMs = this.now();
    return { schemaVersion: 1, status: 'final', generatedAtMs: completedAtMs,
      startedAtMs: this.startedAtMs, completedAtMs,
      durationMs: completedAtMs - this.startedAtMs, safeConfig: {},
      timestamps: null, expected: { tables: 0, profiles: 0, workers: 0 },
      metrics: { workerCrashes: 0, heartbeatTimeouts: 0 }, workers: [],
      cleanup: { completedWorkers: 0, incompleteWorkers: 0, forcedWorkers: 0 },
      exitReason: error instanceof ControllerConfigError ? error.message : 'preflight failure',
      exitCode: EXIT_CODES.configuration };
  }

  installSignalHandlers() {
    this.signalHandler = (signal) => this.requestShutdown(signal, EXIT_CODES.orchestration);
    process.once('SIGINT', this.signalHandler);
    process.once('SIGTERM', this.signalHandler);
  }

  removeSignalHandlers() {
    process.removeListener('SIGINT', this.signalHandler);
    process.removeListener('SIGTERM', this.signalHandler);
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new ControllerConfigError(`${name} is required`);
  return value;
}
function requireInteger(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ControllerConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new ControllerConfigError(`${name} must be positive`);
  return value;
}
function nonnegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new ControllerConfigError(`${name} must be non-negative`);
  return value;
}
function parseBoolean(value, name) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ControllerConfigError(`${name} must be true or false`);
}

function safeMatchmakingSnapshot(value = null) {
  const admittedTableIndexes = safeIndexArray(value?.admittedTableIndexes);
  const joinStartedTableIndexes = safeIndexArray(value?.joinStartedTableIndexes);
  const confirmedTableIndexes = safeIndexArray(value?.confirmedTableIndexes);
  const startedTableIndexes = safeIndexArray(value?.startedTableIndexes);
  const readyTableIndexes = safeIndexArray(value?.readyTableIndexes);
  const failures = Array.isArray(value?.failures) ? value.failures
    .filter((item) => Number.isInteger(item?.tableIndex) && item.tableIndex >= 0
      && typeof item.failureCode === 'string')
    .map((item) => ({ tableIndex: item.tableIndex, failureCode: item.failureCode }))
    .sort((left, right) => left.tableIndex - right.tableIndex) : [];
  return {
    admittedTables: admittedTableIndexes.length,
    joinStartedTables: joinStartedTableIndexes.length,
    confirmedTables: confirmedTableIndexes.length,
    startedTables: startedTableIndexes.length,
    readyTables: readyTableIndexes.length,
    failedTables: failures.length,
    admittedTableIndexes,
    joinStartedTableIndexes,
    confirmedTableIndexes,
    startedTableIndexes,
    readyTableIndexes,
    failures,
  };
}

function safeIndexArray(value) {
  return Array.isArray(value) ? [...new Set(value
    .filter((item) => Number.isInteger(item) && item >= 0))]
    .sort((left, right) => left - right) : [];
}

function sortedIndexes(set) {
  return [...set].sort((left, right) => left - right);
}

export function parseControllerArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new ControllerConfigError('Arguments must be --name value pairs');
    values[key.slice(2)] = value;
  }
  const number = (name) => values[name] === undefined ? undefined : Number(values[name]);
  return { tables: number('tables'), workerCount: number('workers'), baseUrl: values['base-url'],
    wsUrl: values['ws-url'], credentialsPath: values.credentials,
    outputDirectory: values['output-directory'], loginSpreadMs: number('login-spread-ms'),
    readinessDurationMs: number('readiness-duration-ms'), holdDurationMs: number('hold-duration-ms'),
    heartbeatTimeoutMs: number('heartbeat-timeout-ms'), hardTimeoutMs: number('hard-timeout-ms'),
    matchmakingEnabled: values['matchmaking-enabled'],
    matchmakingTableTimeoutMs: number('matchmaking-table-timeout-ms'),
    matchmakingAdmissionPauseMs: number('matchmaking-admission-pause-ms') };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let exitCode = EXIT_CODES.configuration;
  try {
    const controller = new MultiProcessWsController(parseControllerArgs(process.argv.slice(2)));
    const summary = await controller.run();
    exitCode = summary.exitCode;
  } catch { exitCode = EXIT_CODES.configuration; }
  process.exitCode = exitCode;
}
