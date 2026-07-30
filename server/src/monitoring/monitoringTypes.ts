import type { GameWorkerPoolHealth } from '../game/createGameWorkerPool.js'
import type { ActiveRoomSnapshot } from '../core/computeActiveRoomsSnapshot.js'

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

  ramUsedMb: number
  ramTotalMb: number
  ramPercent: number

  processRssMb: number
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
}
