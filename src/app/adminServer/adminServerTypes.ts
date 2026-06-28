export type HistoryWindow = '1h' | '24h' | '7d'

export type MonitoringHistoryPoint = {
  t: number
  serverCpu: number | null
  nodeCpu: number | null
  ramUsedMb: number
  ramPercent: number
  rssMb: number
  wsConns: number
  onlinePlayers: number
  activeRooms: number
  mmWaiters: number
}

export type MonitoringPeaks = {
  serverCpu: number | null
  nodeCpu: number | null
  ramUsedMb: number
  ramPercent: number
  rssMb: number
  wsConns: number
  onlinePlayers: number
  activeRooms: number
  mmWaiters: number
}

export type MonitoringPeakMoment = {
  value: number
  sampledAt: number | null
}

export type MonitoringPeakMoments = {
  wsConns: MonitoringPeakMoment
  onlinePlayers: MonitoringPeakMoment
  activeRooms: MonitoringPeakMoment
  mmWaiters: MonitoringPeakMoment
}

export type MonitoringHistoryResult = {
  window: HistoryWindow
  points: MonitoringHistoryPoint[]
  peaks: MonitoringPeaks
  peakMoments: MonitoringPeakMoments
}

export function isValidHistoryWindow(value: unknown): value is HistoryWindow {
  return value === '1h' || value === '24h' || value === '7d'
}

export type WsConnectionEntry = {
  connectionId: string
  readyStateLabel: string
  isOpen: boolean
  profileId: string | null
  displayName: string | null
  connectedAtMs: number
  lastSeenAtMs: number
  maskedIp: string | null
  userAgent: string | null
  currentRoomId: string | null
  hasActiveGameSession: boolean
  probablePendingSessionInGame: boolean
}

export type WsConnectionsSummary = {
  registrySize: number
  openSocketCount: number
  connectedStateCount: number
  uniqueOnlineProfiles: number
  guestOpenSockets: number
  authenticatedOpenSockets: number
  profilesWithMultipleOpenSockets: number
}

export type WsConnectionsResult = {
  entries: WsConnectionEntry[]
  summary: WsConnectionsSummary
}

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
