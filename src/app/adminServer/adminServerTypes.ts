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

export type ActiveRoomSnapshot = {
  roomId: string
  phase: string
  connectedHumans: number
  disconnectedHumans: number
  bots: number
  occupiedSeats: number
  workerId: string | null
  createdAt: number
  lastActivityAt: number
}

/**
 * Праг за визуално маркиране на изоставена (bots-only) стая в admin панела.
 * Огледален на server/src/core/computeActiveRoomsSnapshot.ts::STALE_ACTIVE_ROOM_THRESHOLD_MS
 * — трябва да се държи синхронизиран, ако прагът се промени там.
 * Не се ползва за никаква lifecycle/cleanup логика, само визуален маркер.
 */
export const STALE_ACTIVE_ROOM_THRESHOLD_MS = 5 * 60 * 1000

export function isBotsOnlyActiveRoom(room: ActiveRoomSnapshot): boolean {
  return room.connectedHumans === 0 && room.disconnectedHumans === 0
}

export function isStaleActiveRoom(
  room: ActiveRoomSnapshot,
  nowMs: number = Date.now(),
): boolean {
  return (
    isBotsOnlyActiveRoom(room) &&
    nowMs - room.lastActivityAt > STALE_ACTIVE_ROOM_THRESHOLD_MS
  )
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
  rooms: ActiveRoomSnapshot[]
  workerPool: MonitoringWorkerPoolSnapshot | null
  lastError: string | null
}
