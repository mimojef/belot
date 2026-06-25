export type MonitoringWorkerSnapshot = {
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
}

export type MonitoringWorkerPoolSnapshot = {
  state: string
  workerCount: number
  readyWorkers: number
  failedWorkers: number
  totalAssignedRooms: number
  maxRoomsPerWorker: number
  workers: MonitoringWorkerSnapshot[]
}

export type MonitoringSnapshot = {
  samplerStatus: 'warming_up' | 'running' | 'stopped'
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
  workerPool: MonitoringWorkerPoolSnapshot | null
  lastError: string | null
}
