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
  processCpuNowPercent: number | null
  gameWorkerCpuNowPercent: number | null
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

// ─── CPU incident forensics (отделен слой, огледален на server/src/monitoring/cpuIncidentTypes.ts) ───

export type CpuIncidentDetectionType = 'extreme_spike' | 'sustained_high' | 'sustained_with_spike'

export type CpuIncidentActivityRates = {
  gameplayPerMin: number
  lobbyChatPerMin: number
  directChatPerMin: number
  pikaTeamChatPerMin: number
  officialSupportPerMin: number
  privateRoomChatPerMin: number
  topicsPerMin: number
  lafchePerMin: number
  httpPerMin: number
}

// Diagnostic fix — bounded, fixed-cardinality background job/GC forensic
// metrics (огледални на server/src/monitoring/backgroundJobMetrics.ts и
// gcMetrics.ts). null поле означава "не е измерено", НЕ "нула събития" —
// UI трябва да показва "—" за null, "0" само за реално измерена нула.
export type BackgroundJobName =
  | 'matchmakingTick'
  | 'gameRuntimeTick'
  | 'tournamentCoordinatorTick'
  | 'tournamentSchedulerTick'
  | 'topicPoll'
  | 'lobbyChatPoll'
  | 'monitoringHistoryPersist'
  | 'monitoringHistoryPurge'

export type BackgroundJobStat = {
  count: number
  totalDurationMs: number
  maxDurationMs: number
}

export type BackgroundJobStatsSnapshot = Record<BackgroundJobName, BackgroundJobStat>

export type GcStatsSnapshot = {
  available: boolean
  count: number
  totalDurationMs: number
  maxDurationMs: number
}

// Пълен forensic snapshot от точния 1-second прозорец на един extreme spike
// семпъл (огледален на server SpikeContext).
export type CpuIncidentSpikeContext = {
  serverCpuPercent: number | null
  gameWorkerCpuPercent: number | null
  nonGameWorkerProcessCpuPercent: number | null
  // Worker CPU freshness — до колко ms е "стара" gameWorkerCpuPercent
  // стойността спрямо sampledAtMs на този spike sample (worker CPU се
  // семплира само на 10s интервал, независимо от 1s spike sample-а). null
  // когато worker CPU е недостъпно.
  gameWorkerCpuSampleAgeMs: number | null
  nonGameWorkerProcessCpuSampleAgeMs: number | null
  eventLoopUtilization: number | null
  eventLoopDelayP99Ms: number | null
  rssMb: number | null
  heapUsedMb: number | null
  onlinePlayers: number | null
  activeMatches: number | null
  wsConnections: number | null
  matchmakingWaiters: number | null
  backgroundJobs: BackgroundJobStatsSnapshot
  gc: GcStatsSnapshot
}

export type CpuIncidentSpikeSampleDetail = {
  sampledAtMs: number
  processCpuPercent: number
  context: CpuIncidentSpikeContext | null
}

export type CpuIncidentSummary = {
  id: number
  detectionType: CpuIncidentDetectionType
  startedAtMs: number
  endedAtMs: number | null
  durationMs: number | null
  processCpuMax: number | null
  processCpuAvg: number | null
  processCpuP95: number | null
  serverCpuMax: number | null
  gameWorkerCpuMax: number | null
  nonGameWorkerProcessCpuMax: number | null
  eventLoopUtilizationMax: number | null
  eventLoopDelayP99MaxMs: number | null
  rssMaxMb: number | null
  onlinePlayersAvg: number | null
  activeMatchesAvg: number | null
  wsConnectionsAvg: number | null
  activityRates: CpuIncidentActivityRates
  topHttpCategoriesJson: string | null
  topWsInboundTypesJson: string | null
  topWsOutboundTypesJson: string | null
  backgroundJobs: BackgroundJobStatsSnapshot | null
  gc: GcStatsSnapshot | null
}

export type CpuIncidentTimelineSample = {
  t: number
  sampleResolutionMs: number
  processCpu: number | null
  serverCpu: number | null
  gameWorkerCpu: number | null
  nonGameWorkerProcessCpu: number | null
  eventLoopUtilization: number | null
  eventLoopDelayP99Ms: number | null
  rssMb: number | null
  onlinePlayers: number | null
  activeMatches: number | null
  wsConnections: number | null
}

export type CpuIncidentDetail = {
  summary: CpuIncidentSummary
  timeline: CpuIncidentTimelineSample[]
  spikeSamples: CpuIncidentSpikeSampleDetail[]
}
