import type { ActivityCountersSnapshot } from './activityCounters.js'
import type { BackgroundJobStatsSnapshot } from './backgroundJobMetrics.js'
import type { GcStatsSnapshot } from './gcMetrics.js'

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

  // Диагностичен fix pass §6 — 10s bucket-ът вече носи background job/GC
  // tenSecond-window агрегати (snapshotTenSecondAndReset()), за да не бъде
  // sustained_high/sustained_with_spike summary принудително null (виж
  // review findings).
  backgroundJobs: BackgroundJobStatsSnapshot
  gc: GcStatsSnapshot
}

// Пълен forensic snapshot от точния 1-second прозорец, в който CPU семпълът
// е достигнал extreme spike прага — НЕ 10s bucket агрегация.
//
// TEMPORAL ALIGNMENT (виж final fix pass брифа §5): activity/backgroundJobs/gc
// идват от snapshotOneSecondAndReset() на съответните dual-window
// accumulator-и, извикан В СЪЩИЯ 1s forensic sample tick, непосредствено
// след четенето на CPU snapshot-а — това е най-близкото практически
// достижимо подравняване между CPU семпъла и activity/background/gc
// прозореца в рамките на Node event-loop timer ordering. НЕ е гарантирано
// perfect millisecond-alignment (двата interval-а — monitoringSampler-ът и
// forensic sample tick-ът — не са phase-locked), но представлява completed
// 1-секунден прозорец, приключил максимум малко преди/по време на четенето
// на CPU snapshot-а, а НЕ up-to-10s cumulative данни (виж review findings,
// FALSE ATTRIBUTION RISK).
export type SpikeContext = {
  serverCpuPercent: number | null
  gameWorkerCpuPercent: number | null
  nonGameWorkerProcessCpuPercent: number | null

  // Worker CPU freshness (виж final fix pass брифа §9): gameWorkerCpuPercent
  // идва от createMonitoringSampler.ts, който семплира worker.cpuUsage()
  // само на всеки 10s (async round-trip, WORKER_CPU_SAMPLE_INTERVAL_MS) —
  // до ~10s по-стара от spike момента. Age полетата правят тази staleness
  // изрична вместо мълчаливо да представят стойността като "измерена точно
  // сега". null когато worker CPU е недостъпно (feature-detect fail).
  gameWorkerCpuSampleAgeMs: number | null
  // nonGameWorkerProcessCpuPercent се извежда от gameWorkerCpuPercent
  // (nodeCpu - gameWorkerCpu), затова наследява СЪЩАТА staleness incertitude.
  nonGameWorkerProcessCpuSampleAgeMs: number | null

  eventLoopUtilization: number | null
  eventLoopDelayP99Ms: number | null

  rssMb: number | null
  heapUsedMb: number | null

  onlinePlayers: number | null
  activeMatches: number | null
  wsConnections: number | null
  matchmakingWaiters: number | null

  // Completed one-second forensic window (виж TEMPORAL ALIGNMENT по-горе) —
  // НЕ cumulative peek.
  activity: ActivityCountersSnapshot
  backgroundJobs: BackgroundJobStatsSnapshot
  gc: GcStatsSnapshot
}

// Суров 1s CPU семпъл — пазен само около EXTREME SPIKE прозорци, за да
// покажем истинската кратка продължителност (виж final audit §3).
// `context` е null за семпли под extreme прага (никога снеман за тях, за
// да не удвоим O(n) online/connections/rooms работа на всяка секунда —
// виж diagnostic fix брифа т.3, снема се само when spike detected).
export type RawCpuSample = {
  sampledAtMs: number
  processCpuPercent: number
  context: SpikeContext | null
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

  // Background job / GC агрегати за incident прозореца (pre+during+post
  // buckets за sustained family; raw spike context-и за чист extreme_spike
  // — виж cpuIncidentStore buildSummaryFields). null поле означава "не е
  // измерено" (напр. GC observation недостъпна на runtime-а), НЕ "нула
  // събития" — UI трябва да разграничи двата случая (виж diagnostic fix
  // брифа т.6, "—" vs "0").
  backgroundJobs: BackgroundJobStatsSnapshot | null
  gc: GcStatsSnapshot | null
}

// Точен 1-секунден raw spike sample с пълен forensic context — за extreme
// spike incidents, това е ЕДИНСТВЕНИЯТ начин да видим какво реално е
// станало ВЪТРЕ в 1-2 сек прозореца (не 10s bucket агрегация, виж
// diagnostic fix брифа т.5).
export type CpuIncidentSpikeSampleDetail = {
  sampledAtMs: number
  processCpuPercent: number
  context: SpikeContext | null
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
  // Raw 1s spike samples с пълен context — само за incidents, чиито
  // detectionType включва extreme spike (extreme_spike/sustained_with_spike)
  // И имат реално снет context. Празен масив за чист sustained_high (няма
  // extreme spike компонент).
  spikeSamples: CpuIncidentSpikeSampleDetail[]
}
