import type { GameWorkerPoolHealth, GameWorkerCpuUsageEntry } from '../game/createGameWorkerPool.js'
import type { ActiveRoomSnapshot } from '../core/computeActiveRoomsSnapshot.js'
import type { EventLoopHealthSnapshot } from './eventLoopHealth.js'

export type SamplerStatus = 'warming_up' | 'running' | 'stopped'

export type MonitoringWorkerPoolSnapshot = {
  state: string
  workerCount: number
  readyWorkers: number
  failedWorkers: number
  totalAssignedRooms: number
  maxRoomsPerWorker: number
  workers: Array<{
    workerId: string
    state: string
    assignedRooms: number
    maxRooms: number
    shadow: {
      desiredRooms: number
      confirmedRooms: number
      pendingOperations: number
      workerState: string
      isConsistent: boolean
      isShuttingDown: boolean
      lastError: string | null
    }
    lastError: string | null
  }>
}

export type MonitoringSnapshot = {
  samplerStatus: SamplerStatus
  sampledAtMs: number
  sampledAtIso: string
  sampleWindowMs: number

  serverCpuNowPercent: number | null
  nodeCpuNowPercent: number | null

  // processCpu = nodeCpuNowPercent (process.cpuUsage(), целия Node process —
  // main thread + libuv threadpool + всички worker_threads + GC/V8).
  // Дублирано под forensic-специфично име за яснота в incident detector-а;
  // не разчитай на второ независимо измерване.
  processCpuNowPercent: number | null

  // gameWorkerCpuNowPercent: агрегирано CPU% на gameplay worker_threads,
  // изчислено от delta на worker.cpuUsage() между два семпъла. null ако
  // worker.cpuUsage() липсва на текущия Node runtime, или ако все още няма
  // предишен семпъл за delta (warm-up).
  gameWorkerCpuNowPercent: number | null

  // Timestamp (ms epoch) на последния УСПЕШЕН worker CPU семпъл — worker CPU
  // се семплира на по-рядък WORKER_CPU_SAMPLE_INTERVAL_MS (10s) интервал,
  // независимо от 1s основния sample loop (виж final fix pass брифа §9,
  // createMonitoringSampler.ts collectWorkerCpuSample). Consumers трябва да
  // изчисляват freshness/age спрямо своя собствен sample timestamp, вместо
  // да третират gameWorkerCpuNowPercent като измерен "точно сега". null ако
  // все още няма нито един успешен worker CPU семпъл (warm-up или
  // unavailable).
  gameWorkerCpuSampledAtMs: number | null

  // nonGameWorkerProcessCpuNowPercent = processCpuNowPercent −
  // gameWorkerCpuNowPercent. ВАЖНО: това НЕ Е "main thread CPU" — remainder-ът
  // все още включва libuv threadpool, GC/V8 background threads и native
  // addon threads. null ако gameWorkerCpuNowPercent е null.
  nonGameWorkerProcessCpuNowPercent: number | null

  eventLoopUtilization: number | null
  eventLoopDelayP50Ms: number | null
  eventLoopDelayP99Ms: number | null

  ramUsedMb: number
  ramTotalMb: number
  ramPercent: number

  processRssMb: number
  processHeapUsedMb: number
  processUptimeSec: number
  backendStartedAtIso: string

  activeWsConnections: number
  uniqueOnlineRealPlayers: number
  totalMatchmakingWaiters: number
  matchmakingWaitersByStake: Record<string, number>

  activeRooms: number
  roomsByPhase: Record<string, number>
  rooms: ActiveRoomSnapshot[]

  workerPool: MonitoringWorkerPoolSnapshot | null
  lastError: string | null
}

export type MonitoringDeps = {
  nowMs: () => number
  processCpuUsage: () => NodeJS.CpuUsage
  osCpuTimes: () => Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>
  osFreeMem: () => number
  osTotalMem: () => number
  processMemUsage: () => NodeJS.MemoryUsage
  processUptime: () => number
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>
  clearInterval: (id: ReturnType<typeof globalThis.setInterval>) => void
}

export type MonitoringSampler = {
  getSnapshot(): MonitoringSnapshot
  stop(): void
}

export type MonitoringContext = {
  backendStartedAtMs: number
  getWsConnectionCount: () => number
  getUniqueOnlineRealPlayers: () => number
  getMatchmakingWaitersByStake: () => Record<string, number>
  getActiveRoomCount: () => number
  getRoomsByPhase: () => Record<string, number>
  getActiveRooms: () => ActiveRoomSnapshot[]
  getWorkerPoolHealth: () => GameWorkerPoolHealth | null
  // Monitoring-only, best-effort, may be omitted (worker pool absent in
  // some deployment modes) — sampler feature-detects via presence.
  getWorkerCpuUsages?: () => Promise<GameWorkerCpuUsageEntry[]>
  // Инжектиран event-loop sampler, за да остане createMonitoringSampler
  // тестваем чрез dependency injection (аналог на останалите MonitoringDeps).
  sampleEventLoopHealth?: () => EventLoopHealthSnapshot
}
