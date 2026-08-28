import type { ActivityCountersSnapshot } from './activityCounters.js'

// ─── Централизирани прагове (не magic numbers из файловете) ───────────────────

export const CPU_INCIDENT_THRESHOLDS = {
  // EXTREME SPIKE: единичен 1s семпъл >= прага веднага брои като spike.
  extremeSpikePercent: 100,
  // Gap между extreme семпли, под който се сливат в един и същ spike incident.
  extremeSpikeMergeGapMs: 5_000,

  // SUSTAINED HIGH: bucket-aligned state machine.
  warningPercent: 80,
  incidentPercent: 90,
  incidentMinDurationMs: 20_000, // = 2 x 10s bucket
  recoveryPercent: 70,
  recoveryMinDurationMs: 20_000, // bucket-aligned (2 x 10s), не 15s

  // Merge на два sustained incident-а при кратък gap между RECOVERY и
  // следващ INCIDENT.
  sustainedMergeGapMs: 30_000,

  // Merge на extreme spike в sustained incident, ако е в рамките на този
  // прозорец преди/след sustained-а — става detectionType='sustained_with_spike'.
  spikeToSustainedMergeWindowMs: 30_000,
} as const

export const CPU_INCIDENT_SAMPLING = {
  bucketMs: 10_000,
  ringBufferBuckets: 30, // 5 минути
  preIncidentBufferBuckets: 12, // 2 минути минимум context преди incident
} as const

export const CPU_INCIDENT_RETENTION = {
  summaryRetentionMs: 90 * 24 * 60 * 60 * 1000,
  timelineRetentionMs: 14 * 24 * 60 * 60 * 1000,
  purgeIntervalMs: 60 * 60 * 1000, // следва monitoringHistoryStore pattern-а
} as const

export type CpuIncidentDetectionType = 'extreme_spike' | 'sustained_high' | 'sustained_with_spike'

export type IncidentState = 'normal' | 'warning' | 'incident' | 'recovery'

// ─── Ring buffer bucket (10s резолюция, in-memory forensic контекст) ──────────

export type ForensicBucket = {
  bucketStartMs: number

  processCpuAvg: number | null
  processCpuMax: number | null
  serverCpuAvg: number | null
  serverCpuMax: number | null
  gameWorkerCpuAvg: number | null
  gameWorkerCpuMax: number | null
  nonGameWorkerProcessCpuAvg: number | null
  nonGameWorkerProcessCpuMax: number | null

  eventLoopUtilizationMax: number | null
  eventLoopDelayP50Ms: number | null
  eventLoopDelayP99Ms: number | null

  rssMb: number | null
  heapUsedMb: number | null

  onlinePlayers: number
  activeMatches: number
  wsConnections: number
  matchmakingWaiters: number

  activity: ActivityCountersSnapshot
}

// Суров 1s CPU семпъл — пазен само около EXTREME SPIKE прозорци, за да
// покажем истинската кратка продължителност (виж final audit §3).
export type RawCpuSample = {
  sampledAtMs: number
  processCpuPercent: number
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

  activityRates: {
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

  topHttpCategoriesJson: string | null
  topWsInboundTypesJson: string | null
  topWsOutboundTypesJson: string | null
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
}
