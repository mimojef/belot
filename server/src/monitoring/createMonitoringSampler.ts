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

// Worker CPU е async (worker.cpuUsage() е Promise-базирана message round-trip
// към всеки worker) — не го семплираме на всяка 1s секунда за да избегнем
// излишен message traffic; 10s е достатъчно за forensic bucket резолюцията
// надолу по веригата (виж final audit §C, §16 performance).
const WORKER_CPU_SAMPLE_INTERVAL_MS = 10_000

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

  // Side-channel state за gameWorkerCpu — обновявана асинхронно на по-рядък
  // интервал (виж WORKER_CPU_SAMPLE_INTERVAL_MS), четена синхронно от
  // collectSample(). Никога не блокира 1s основния loop.
  let prevWorkerCpuUsageByWorkerId: Map<string, NodeJS.CpuUsage> | null = null
  let prevWorkerCpuSampleAtMs: number | null = null
  let lastGameWorkerCpuNowPercent: number | null = null
  let workerCpuIntervalId: ReturnType<typeof globalThis.setInterval> | null = null
  let isSamplingWorkerCpu = false

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

  async function collectWorkerCpuSample(): Promise<void> {
    if (isSamplingWorkerCpu || status === 'stopped') return
    if (context.getWorkerCpuUsages === undefined) return
    isSamplingWorkerCpu = true

    try {
      const entries = await context.getWorkerCpuUsages()
      const nowMs = deps.nowMs()

      // Ако нито един worker не поддържа cpuUsage() (feature-detect fail,
      // напр. по-стар Node), не претендираме за 0% — оставяме null.
      const anyUsageAvailable = entries.some((e) => e.cpuUsage !== null)
      if (!anyUsageAvailable) {
        prevWorkerCpuUsageByWorkerId = null
        prevWorkerCpuSampleAtMs = null
        lastGameWorkerCpuNowPercent = null
        return
      }

      if (prevWorkerCpuUsageByWorkerId !== null && prevWorkerCpuSampleAtMs !== null) {
        const elapsedMs = nowMs - prevWorkerCpuSampleAtMs
        if (elapsedMs > 0) {
          let totalDeltaUs = 0
          for (const entry of entries) {
            if (entry.cpuUsage === null) continue
            const prev = prevWorkerCpuUsageByWorkerId.get(entry.workerId)
            if (prev === undefined) continue
            const userDelta = entry.cpuUsage.user - prev.user
            const sysDelta = entry.cpuUsage.system - prev.system
            totalDeltaUs += Math.max(0, userDelta) + Math.max(0, sysDelta)
          }
          lastGameWorkerCpuNowPercent = Math.max(0, (totalDeltaUs / (elapsedMs * 1000)) * 100)
        }
      }

      const nextMap = new Map<string, NodeJS.CpuUsage>()
      for (const entry of entries) {
        if (entry.cpuUsage !== null) nextMap.set(entry.workerId, entry.cpuUsage)
      }
      prevWorkerCpuUsageByWorkerId = nextMap
      prevWorkerCpuSampleAtMs = nowMs
    } catch {
      // Best-effort — never let worker CPU sampling affect sampler health.
      lastGameWorkerCpuNowPercent = null
    } finally {
      isSamplingWorkerCpu = false
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

      const gameWorkerCpuNowPercent = lastGameWorkerCpuNowPercent
      const nonGameWorkerProcessCpuNowPercent =
        nodeCpuNowPercent !== null && gameWorkerCpuNowPercent !== null
          ? Math.max(0, nodeCpuNowPercent - gameWorkerCpuNowPercent)
          : null

      const eventLoopHealth = context.sampleEventLoopHealth?.() ?? {
        utilization: null,
        delayP50Ms: null,
        delayP99Ms: null,
      }

      lastError = null
      lastSnapshot = {
        samplerStatus: status,
        sampledAtMs: nowMs,
        sampledAtIso: new Date(nowMs).toISOString(),
        sampleWindowMs,

        serverCpuNowPercent,
        nodeCpuNowPercent,

        processCpuNowPercent: nodeCpuNowPercent,
        gameWorkerCpuNowPercent,
        nonGameWorkerProcessCpuNowPercent,

        eventLoopUtilization: eventLoopHealth.utilization,
        eventLoopDelayP50Ms: eventLoopHealth.delayP50Ms,
        eventLoopDelayP99Ms: eventLoopHealth.delayP99Ms,

        ramUsedMb: ram.ramUsedMb,
        ramTotalMb: ram.ramTotalMb,
        ramPercent: ram.ramPercent,
        processRssMb: ram.processRssMb,
        processHeapUsedMb: deps.processMemUsage().heapUsed / (1024 * 1024),
        processUptimeSec: deps.processUptime(),
        backendStartedAtIso: new Date(context.backendStartedAtMs).toISOString(),

        activeWsConnections: context.getWsConnectionCount(),
        uniqueOnlineRealPlayers: context.getUniqueOnlineRealPlayers(),
        totalMatchmakingWaiters: totalWaiters,
        matchmakingWaitersByStake: waitersByStake,

        activeRooms: context.getActiveRoomCount(),
        roomsByPhase: context.getRoomsByPhase(),
        rooms: context.getActiveRooms(),

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

  if (context.getWorkerCpuUsages !== undefined) {
    workerCpuIntervalId = deps.setInterval(() => {
      void collectWorkerCpuSample()
    }, WORKER_CPU_SAMPLE_INTERVAL_MS)
    void collectWorkerCpuSample()
  }

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
      if (workerCpuIntervalId !== null) {
        deps.clearInterval(workerCpuIntervalId)
        workerCpuIntervalId = null
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
    processCpuNowPercent: null,
    gameWorkerCpuNowPercent: null,
    nonGameWorkerProcessCpuNowPercent: null,
    eventLoopUtilization: null,
    eventLoopDelayP50Ms: null,
    eventLoopDelayP99Ms: null,
    ramUsedMb: ram.ramUsedMb,
    ramTotalMb: ram.ramTotalMb,
    ramPercent: ram.ramPercent,
    processRssMb: ram.processRssMb,
    processHeapUsedMb: deps.processMemUsage().heapUsed / (1024 * 1024),
    processUptimeSec: deps.processUptime(),
    backendStartedAtIso: new Date(context.backendStartedAtMs).toISOString(),
    activeWsConnections: 0,
    uniqueOnlineRealPlayers: 0,
    totalMatchmakingWaiters: 0,
    matchmakingWaitersByStake: {},
    activeRooms: 0,
    roomsByPhase: {},
    rooms: [],
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
      processCpuNowPercent: null,
      gameWorkerCpuNowPercent: null,
      nonGameWorkerProcessCpuNowPercent: null,
      eventLoopUtilization: null,
      eventLoopDelayP50Ms: null,
      eventLoopDelayP99Ms: null,
      ramUsedMb: 0,
      ramTotalMb: 0,
      ramPercent: 0,
      processRssMb: 0,
      processHeapUsedMb: 0,
      processUptimeSec: 0,
      backendStartedAtIso: new Date(context.backendStartedAtMs).toISOString(),
      activeWsConnections: 0,
      uniqueOnlineRealPlayers: 0,
      totalMatchmakingWaiters: 0,
      matchmakingWaitersByStake: {},
      activeRooms: 0,
      roomsByPhase: {},
      rooms: [],
      workerPool: null,
      lastError: null,
    }
  }
}
