import os from 'node:os'
import {
  sumOsCpuTimes,
  calcServerCpuPercent,
  calcNodeCpuPercent,
  calcRamMetrics,
  sanitizeErrorMessage,
  type OsCpuSnapshot,
} from './systemMetrics.js'
import type {
  MonitoringDeps,
  MonitoringContext,
  MonitoringSnapshot,
  MonitoringSampler,
  SamplerStatus,
  MonitoringWorkerPoolSnapshot,
} from './monitoringTypes.js'

const SAMPLE_INTERVAL_MS = 1000

const defaultDeps: MonitoringDeps = {
  nowMs: () => Date.now(),
  processCpuUsage: () => process.cpuUsage(),
  osCpuTimes: () => os.cpus(),
  osFreeMem: () => os.freemem(),
  osTotalMem: () => os.totalmem(),
  processMemUsage: () => process.memoryUsage(),
  processUptime: () => process.uptime(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
}

export function createMonitoringSampler(
  context: MonitoringContext,
  deps: MonitoringDeps = defaultDeps,
): MonitoringSampler {
  let status: SamplerStatus = 'warming_up'
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null
  let isSampling = false

  let prevCpuTimes: OsCpuSnapshot | null = null
  let prevCpuUsage: NodeJS.CpuUsage | null = null
  let prevSampleAtMs: number | null = null

  let lastSnapshot: MonitoringSnapshot = buildWarmingSnapshotSafe(context, deps)
  let lastError: string | null = null

  function buildWorkerPoolSnapshot(): MonitoringWorkerPoolSnapshot | null {
    const health = context.getWorkerPoolHealth()
    if (health === null) return null
    return {
      state: health.state,
      workerCount: health.workerCount,
      readyWorkers: health.readyWorkers,
      failedWorkers: health.failedWorkers,
      totalAssignedRooms: health.totalAssignedRooms,
      maxRoomsPerWorker: health.maxRoomsPerWorker,
      workers: health.workers.map((w) => ({
        workerId: w.workerId,
        state: w.state,
        assignedRooms: w.assignedRooms,
        maxRooms: w.maxRooms,
        shadow: {
          desiredRooms: w.shadow.desiredRooms,
          confirmedRooms: w.shadow.confirmedRooms,
          pendingOperations: w.shadow.pendingOperations,
          workerState: w.shadow.workerState,
          isConsistent: w.shadow.isConsistent,
          isShuttingDown: w.shadow.isShuttingDown,
          lastError: w.shadow.lastError !== null ? sanitizeErrorMessage(w.shadow.lastError) : null,
        },
        lastError: w.lastError !== null ? sanitizeErrorMessage(w.lastError) : null,
      })),
    }
  }

  function collectSample(): void {
    if (isSampling || status === 'stopped') return
    isSampling = true

    try {
      const nowMs = deps.nowMs()
      const currCpuTimes = sumOsCpuTimes(deps.osCpuTimes())
      const currCpuUsage = deps.processCpuUsage()

      let serverCpuNowPercent: number | null = null
      let nodeCpuNowPercent: number | null = null
      let sampleWindowMs = 0

      if (
        prevCpuTimes !== null &&
        prevCpuUsage !== null &&
        prevSampleAtMs !== null
      ) {
        const elapsedMs = nowMs - prevSampleAtMs
        serverCpuNowPercent = calcServerCpuPercent(prevCpuTimes, currCpuTimes)
        nodeCpuNowPercent = calcNodeCpuPercent(prevCpuUsage, currCpuUsage, elapsedMs)
        sampleWindowMs = elapsedMs
        if (status === 'warming_up') {
          status = 'running'
        }
      }

      prevCpuTimes = currCpuTimes
      prevCpuUsage = currCpuUsage
      prevSampleAtMs = nowMs

      const ram = calcRamMetrics(deps)
      const waitersByStake = context.getMatchmakingWaitersByStake()
      const totalWaiters = Object.values(waitersByStake).reduce((s, n) => s + n, 0)

      lastError = null
      lastSnapshot = {
        samplerStatus: status,
        sampledAtMs: nowMs,
        sampledAtIso: new Date(nowMs).toISOString(),
        sampleWindowMs,

        serverCpuNowPercent,
        nodeCpuNowPercent,

        ramUsedMb: ram.ramUsedMb,
        ramTotalMb: ram.ramTotalMb,
        ramPercent: ram.ramPercent,
        processRssMb: ram.processRssMb,
        processUptimeSec: deps.processUptime(),
        backendStartedAtIso: new Date(context.backendStartedAtMs).toISOString(),

        activeWsConnections: context.getWsConnectionCount(),
        uniqueOnlineRealPlayers: context.getUniqueOnlineRealPlayers(),
        totalMatchmakingWaiters: totalWaiters,
        matchmakingWaitersByStake: waitersByStake,

        activeRooms: context.getActiveRoomCount(),
        roomsByPhase: context.getRoomsByPhase(),

        workerPool: buildWorkerPoolSnapshot(),
        lastError: null,
      }
    } catch (error: unknown) {
      lastError = sanitizeErrorMessage(error)
      lastSnapshot = {
        ...lastSnapshot,
        samplerStatus: status,
        lastError,
      }
    } finally {
      isSampling = false
    }
  }

  intervalId = deps.setInterval(collectSample, SAMPLE_INTERVAL_MS)
  collectSample()

  return {
    getSnapshot(): MonitoringSnapshot {
      return lastSnapshot
    },
    stop(): void {
      if (status === 'stopped') return
      status = 'stopped'
      if (intervalId !== null) {
        deps.clearInterval(intervalId)
        intervalId = null
      }
      lastSnapshot = { ...lastSnapshot, samplerStatus: 'stopped' }
    },
  }
}

function buildWarmingSnapshot(
  context: MonitoringContext,
  deps: MonitoringDeps,
): MonitoringSnapshot {
  const nowMs = deps.nowMs()
  const ram = calcRamMetrics(deps)
  return {
    samplerStatus: 'warming_up',
    sampledAtMs: nowMs,
    sampledAtIso: new Date(nowMs).toISOString(),
    sampleWindowMs: 0,
    serverCpuNowPercent: null,
    nodeCpuNowPercent: null,
    ramUsedMb: ram.ramUsedMb,
    ramTotalMb: ram.ramTotalMb,
    ramPercent: ram.ramPercent,
    processRssMb: ram.processRssMb,
    processUptimeSec: deps.processUptime(),
    backendStartedAtIso: new Date(context.backendStartedAtMs).toISOString(),
    activeWsConnections: 0,
    uniqueOnlineRealPlayers: 0,
    totalMatchmakingWaiters: 0,
    matchmakingWaitersByStake: {},
    activeRooms: 0,
    roomsByPhase: {},
    workerPool: null,
    lastError: null,
  }
}

function buildWarmingSnapshotSafe(
  context: MonitoringContext,
  deps: MonitoringDeps,
): MonitoringSnapshot {
  try {
    return buildWarmingSnapshot(context, deps)
  } catch {
    const nowMs = deps.nowMs()
    return {
      samplerStatus: 'warming_up',
      sampledAtMs: nowMs,
      sampledAtIso: new Date(nowMs).toISOString(),
      sampleWindowMs: 0,
      serverCpuNowPercent: null,
      nodeCpuNowPercent: null,
      ramUsedMb: 0,
      ramTotalMb: 0,
      ramPercent: 0,
      processRssMb: 0,
      processUptimeSec: 0,
      backendStartedAtIso: new Date(context.backendStartedAtMs).toISOString(),
      activeWsConnections: 0,
      uniqueOnlineRealPlayers: 0,
      totalMatchmakingWaiters: 0,
      matchmakingWaitersByStake: {},
      activeRooms: 0,
      roomsByPhase: {},
      workerPool: null,
      lastError: null,
    }
  }
}
