import type { ClosedIncident } from './cpuIncidentDetector.js'
import type { ActivityCountersSnapshot } from './activityCounters.js'
import type { BackgroundJobStatsSnapshot } from './backgroundJobMetrics.js'
import { emptyBackgroundJobStatsSnapshot } from './backgroundJobMetrics.js'
import type { GcStatsSnapshot } from './gcMetrics.js'
import { emptyGcStatsSnapshot } from './gcMetrics.js'
import {
  CPU_INCIDENT_RETENTION,
  CPU_INCIDENT_THRESHOLDS,
  type CpuIncidentDetectionType,
  type CpuIncidentSummary,
  type CpuIncidentTimelineSample,
  type CpuIncidentDetail,
  type CpuIncidentSpikeSampleDetail,
  type ForensicBucket,
  type RawCpuSample,
} from './cpuIncidentTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type CpuIncidentListItem = CpuIncidentSummary

export type CpuIncidentStore = {
  // Persist затворен incident. Ако последният persisted incident е от СЪЩИЯ
  // тип "sustained" family и endedAt-ът му е в рамките на
  // sustainedMergeGapMs преди новия incident-а — UPDATE-ва съществуващия
  // ред вместо INSERT (merge при persistence слоя, виж cpuIncidentDetector.ts
  // коментара за защо не на detector ниво).
  persistIncident(incident: ClosedIncident): void
  listIncidents(limit: number): CpuIncidentListItem[]
  getIncidentDetail(incidentId: number): CpuIncidentDetail | null
  purgeOlderThan(summaryCutoffMs: number, timelineCutoffMs: number): void
  close(): void
}

type IncidentRow = {
  id: number
  detection_type: string
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  process_cpu_max: number | null
  process_cpu_avg: number | null
  process_cpu_p95: number | null
  server_cpu_max: number | null
  game_worker_cpu_max: number | null
  non_game_worker_process_cpu_max: number | null
  event_loop_utilization_max: number | null
  event_loop_delay_p99_max_ms: number | null
  rss_max_mb: number | null
  online_players_avg: number | null
  active_matches_avg: number | null
  ws_connections_avg: number | null
  gameplay_per_min: number | null
  lobby_chat_per_min: number | null
  direct_chat_per_min: number | null
  pika_team_chat_per_min: number | null
  official_support_per_min: number | null
  private_room_chat_per_min: number | null
  topics_per_min: number | null
  lafche_per_min: number | null
  http_per_min: number | null
  top_http_categories_json: string | null
  top_ws_inbound_types_json: string | null
  top_ws_outbound_types_json: string | null
  background_jobs_json: string | null
  gc_json: string | null
}

function avgOf(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((s, v) => s + v, 0) / values.length
}

function maxOf(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.max(...values)
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
  return sorted[Math.max(0, idx)] ?? null
}

function topEntriesJson(counts: Record<string, number>, topN: number): string | null {
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
  if (entries.length === 0) return null
  return JSON.stringify(Object.fromEntries(entries))
}

function mergeCategoryCounts(buckets: ForensicBucket[], pick: (b: ForensicBucket) => Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const bucket of buckets) {
    const record = pick(bucket)
    for (const [key, value] of Object.entries(record)) {
      result[key] = (result[key] ?? 0) + value
    }
  }
  return result
}

function mergeCategoryCountsFromRecords(records: Array<Record<string, number>>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      result[key] = (result[key] ?? 0) + value
    }
  }
  return result
}

function sumBackgroundJobStats(snapshots: BackgroundJobStatsSnapshot[]): BackgroundJobStatsSnapshot | null {
  if (snapshots.length === 0) return null
  const result = emptyBackgroundJobStatsSnapshot()
  for (const snap of snapshots) {
    for (const name of Object.keys(result) as Array<keyof BackgroundJobStatsSnapshot>) {
      result[name].count += snap[name].count
      result[name].totalDurationMs += snap[name].totalDurationMs
      if (snap[name].maxDurationMs > result[name].maxDurationMs) {
        result[name].maxDurationMs = snap[name].maxDurationMs
      }
    }
  }
  return result
}

function sumGcStats(snapshots: GcStatsSnapshot[]): GcStatsSnapshot | null {
  if (snapshots.length === 0) return null
  // Ако НИТО един snapshot не е имал GC observation достъпна, връщаме
  // "not available" — не "0 събития" (виж diagnostic fix брифа т.6, "—" vs "0").
  const anyAvailable = snapshots.some((s) => s.available)
  if (!anyAvailable) return { available: false, count: 0, totalDurationMs: 0, maxDurationMs: 0 }
  const result = { available: true, count: 0, totalDurationMs: 0, maxDurationMs: 0 }
  for (const snap of snapshots) {
    if (!snap.available) continue
    result.count += snap.count
    result.totalDurationMs += snap.totalDurationMs
    if (snap.maxDurationMs > result.maxDurationMs) result.maxDurationMs = snap.maxDurationMs
  }
  return result
}

// Merge на два background/gc агрегата (виж final fix pass брифа §8) — null +
// measured = measured; null + null = null. Никога не презаписва измерени
// данни с null.
function mergeBackgroundJobStats(
  a: BackgroundJobStatsSnapshot | null,
  b: BackgroundJobStatsSnapshot | null,
): BackgroundJobStatsSnapshot | null {
  if (a === null) return b
  if (b === null) return a
  const result = emptyBackgroundJobStatsSnapshot()
  for (const name of Object.keys(result) as Array<keyof BackgroundJobStatsSnapshot>) {
    result[name].count = a[name].count + b[name].count
    result[name].totalDurationMs = a[name].totalDurationMs + b[name].totalDurationMs
    result[name].maxDurationMs = Math.max(a[name].maxDurationMs, b[name].maxDurationMs)
  }
  return result
}

function mergeGcStats(a: GcStatsSnapshot | null, b: GcStatsSnapshot | null): GcStatsSnapshot | null {
  if (a === null) return b
  if (b === null) return a
  // Ако нито един от двата фрагмента няма реална GC observation, резултатът
  // остава "not available" — не измислена нула.
  if (!a.available && !b.available) return { available: false, count: 0, totalDurationMs: 0, maxDurationMs: 0 }
  return {
    available: true,
    count: (a.available ? a.count : 0) + (b.available ? b.count : 0),
    totalDurationMs: (a.available ? a.totalDurationMs : 0) + (b.available ? b.totalDurationMs : 0),
    maxDurationMs: Math.max(a.available ? a.maxDurationMs : 0, b.available ? b.maxDurationMs : 0),
  }
}

// Diagnostic fix за false-zero (виж forensic audit): за extreme_spike
// incidents duringBuckets е ВИНАГИ [] по дизайн (spike-ът е по-кратък от
// 10s bucket резолюцията) — activity/context агрегатите по-долу ПРЕДИ тази
// поправка бяха гарантирано 0/null, независимо от реалната активност.
// Сега fallback-ваме към rawSpikeSamples[].context (1s snapshot, взет в
// момента на spike-а — виж index.ts wiring) когато duringBuckets е празен.
function buildSummaryFields(incident: ClosedIncident): Omit<IncidentRow, 'id'> {
  const allBuckets = [...incident.preBuffer, ...incident.duringBuckets, ...incident.postBuffer]
  const spikeContexts = incident.rawSpikeSamples
    .map((s) => s.context)
    .filter((c): c is NonNullable<typeof c> => c !== null)
  const hasBucketData = incident.duringBuckets.length > 0

  // За CPU max/avg/p95 предпочитаме during-buckets (реалния incident прозорец);
  // ако е чист extreme_spike без bucket данни, ползваме суровите 1s семпли.
  const duringCpuValues = incident.duringBuckets
    .map((b) => b.processCpuAvg)
    .filter((v): v is number => v !== null)
  const spikeCpuValues = incident.rawSpikeSamples.map((s) => s.processCpuPercent)
  const cpuValuesForStats = duringCpuValues.length > 0 ? duringCpuValues : spikeCpuValues

  const cpuMaxCandidates = [
    ...incident.duringBuckets.map((b) => b.processCpuMax).filter((v): v is number => v !== null),
    ...spikeCpuValues,
  ]

  const durationMs = incident.endedAtMs - incident.startedAtMs
  const durationMin = durationMs > 0 ? durationMs / 60_000 : 1 / 60 // avoid div-by-zero for instant spikes

  const activityTotals: ActivityCountersSnapshot[] = hasBucketData
    ? incident.duringBuckets.map((b) => b.activity)
    : spikeContexts.map((c) => c.activity)

  const sumActivity = (pick: (a: ActivityCountersSnapshot) => number): number =>
    activityTotals.reduce((s, a) => s + pick(a), 0)

  const httpCategoryTotals = hasBucketData
    ? mergeCategoryCounts(incident.duringBuckets, (b) => b.activity.httpRequestsByCategory)
    : mergeCategoryCountsFromRecords(spikeContexts.map((c) => c.activity.httpRequestsByCategory))
  const wsInboundTotals = hasBucketData
    ? mergeCategoryCounts(incident.duringBuckets, (b) => b.activity.wsInboundByType)
    : mergeCategoryCountsFromRecords(spikeContexts.map((c) => c.activity.wsInboundByType))
  const wsOutboundTotals = hasBucketData
    ? mergeCategoryCounts(incident.duringBuckets, (b) => b.activity.wsOutboundByType)
    : mergeCategoryCountsFromRecords(spikeContexts.map((c) => c.activity.wsOutboundByType))
  const httpTotal = Object.values(httpCategoryTotals).reduce((s, v) => s + v, 0)

  // Diagnostic fix §6/§7 (виж final fix pass брифа) — правило:
  //   duringBuckets.length > 0  → aggregate от duringBuckets (10s
  //     tenSecond-window агрегати, вече присъстват в ForensicBucket от §6
  //     промяната). Приложимо за sustained_high И sustained_with_spike.
  //   duringBuckets.length === 0 И има raw spike samples → aggregate от
  //     rawSpikeSamples[].context (чист extreme_spike).
  //   Нито едно от двете → null (unavailable), никога fake zero.
  // НЕ double-count-ваме rawSpikeSamples върху duringBuckets totals за
  // sustained_with_spike — spike sample-ите остават само за evidence в
  // spikeSamples[] detail масива (виж getIncidentDetail), не участват тук.
  const backgroundJobsAgg = hasBucketData
    ? sumBackgroundJobStats(incident.duringBuckets.map((b) => b.backgroundJobs))
    : sumBackgroundJobStats(spikeContexts.map((c) => c.backgroundJobs))
  const gcAgg = hasBucketData
    ? sumGcStats(incident.duringBuckets.map((b) => b.gc))
    : sumGcStats(spikeContexts.map((c) => c.gc))

  return {
    detection_type: incident.detectionType,
    started_at: incident.startedAtMs,
    ended_at: incident.endedAtMs,
    duration_ms: durationMs,

    process_cpu_max: maxOf(cpuMaxCandidates),
    process_cpu_avg: avgOf(cpuValuesForStats),
    process_cpu_p95: percentile95(cpuValuesForStats),

    server_cpu_max: hasBucketData
      ? maxOf(incident.duringBuckets.map((b) => b.serverCpuMax).filter((v): v is number => v !== null))
      : maxOf(spikeContexts.map((c) => c.serverCpuPercent).filter((v): v is number => v !== null)),

    game_worker_cpu_max: hasBucketData
      ? maxOf(incident.duringBuckets.map((b) => b.gameWorkerCpuMax).filter((v): v is number => v !== null))
      : maxOf(spikeContexts.map((c) => c.gameWorkerCpuPercent).filter((v): v is number => v !== null)),
    non_game_worker_process_cpu_max: hasBucketData
      ? maxOf(incident.duringBuckets.map((b) => b.nonGameWorkerProcessCpuMax).filter((v): v is number => v !== null))
      : maxOf(spikeContexts.map((c) => c.nonGameWorkerProcessCpuPercent).filter((v): v is number => v !== null)),

    event_loop_utilization_max: hasBucketData
      ? maxOf(incident.duringBuckets.map((b) => b.eventLoopUtilizationMax).filter((v): v is number => v !== null))
      : maxOf(spikeContexts.map((c) => c.eventLoopUtilization).filter((v): v is number => v !== null)),
    event_loop_delay_p99_max_ms: hasBucketData
      ? maxOf(incident.duringBuckets.map((b) => b.eventLoopDelayP99Ms).filter((v): v is number => v !== null))
      : maxOf(spikeContexts.map((c) => c.eventLoopDelayP99Ms).filter((v): v is number => v !== null)),

    rss_max_mb: hasBucketData
      ? maxOf(allBuckets.map((b) => b.rssMb).filter((v): v is number => v !== null))
      : maxOf(spikeContexts.map((c) => c.rssMb).filter((v): v is number => v !== null)),

    online_players_avg: hasBucketData
      ? avgOf(incident.duringBuckets.map((b) => b.onlinePlayers))
      : avgOf(spikeContexts.map((c) => c.onlinePlayers).filter((v): v is number => v !== null)),
    active_matches_avg: hasBucketData
      ? avgOf(incident.duringBuckets.map((b) => b.activeMatches))
      : avgOf(spikeContexts.map((c) => c.activeMatches).filter((v): v is number => v !== null)),
    ws_connections_avg: hasBucketData
      ? avgOf(incident.duringBuckets.map((b) => b.wsConnections))
      : avgOf(spikeContexts.map((c) => c.wsConnections).filter((v): v is number => v !== null)),

    gameplay_per_min: sumActivity(
      (a) => a.gameplayBidAccepted + a.gameplayCutAccepted + a.gameplayPlayAccepted,
    ) / durationMin,
    lobby_chat_per_min: sumActivity((a) => a.lobbyChatMessages) / durationMin,
    direct_chat_per_min: sumActivity((a) => a.directChatFriendMessages + a.directChatVipDmMessages) / durationMin,
    pika_team_chat_per_min: sumActivity((a) => a.directChatPikaTeamMessages) / durationMin,
    official_support_per_min: sumActivity((a) => a.officialSupportMessages) / durationMin,
    private_room_chat_per_min: sumActivity((a) => a.privateRoomChatMessages) / durationMin,
    topics_per_min: sumActivity((a) => a.topicRootsCreated + a.topicRepliesCreated) / durationMin,
    lafche_per_min: sumActivity((a) => a.lafcheRootsCreated + a.lafcheRepliesCreated) / durationMin,
    http_per_min: httpTotal / durationMin,

    top_http_categories_json: topEntriesJson(httpCategoryTotals, 5),
    top_ws_inbound_types_json: topEntriesJson(wsInboundTotals, 5),
    top_ws_outbound_types_json: topEntriesJson(wsOutboundTotals, 5),

    background_jobs_json: backgroundJobsAgg !== null ? JSON.stringify(backgroundJobsAgg) : null,
    gc_json: gcAgg !== null ? JSON.stringify(gcAgg) : null,
  }
}

function parseJsonSafe<T>(json: string | null): T | null {
  if (json === null) return null
  try {
    return JSON.parse(json) as T
  } catch {
    // Malformed/corrupt row данни не трябва да чупят цялото monitoring UI —
    // третираме като "не е измерено" (виж diagnostic fix брифа т.6).
    return null
  }
}

function rowToSummary(row: IncidentRow): CpuIncidentSummary {
  return {
    id: row.id,
    detectionType: row.detection_type as CpuIncidentDetectionType,
    startedAtMs: row.started_at,
    endedAtMs: row.ended_at,
    durationMs: row.duration_ms,
    processCpuMax: row.process_cpu_max,
    processCpuAvg: row.process_cpu_avg,
    processCpuP95: row.process_cpu_p95,
    serverCpuMax: row.server_cpu_max,
    gameWorkerCpuMax: row.game_worker_cpu_max,
    nonGameWorkerProcessCpuMax: row.non_game_worker_process_cpu_max,
    eventLoopUtilizationMax: row.event_loop_utilization_max,
    eventLoopDelayP99MaxMs: row.event_loop_delay_p99_max_ms,
    rssMaxMb: row.rss_max_mb,
    onlinePlayersAvg: row.online_players_avg,
    activeMatchesAvg: row.active_matches_avg,
    wsConnectionsAvg: row.ws_connections_avg,
    activityRates: {
      gameplayPerMin: row.gameplay_per_min ?? 0,
      lobbyChatPerMin: row.lobby_chat_per_min ?? 0,
      directChatPerMin: row.direct_chat_per_min ?? 0,
      pikaTeamChatPerMin: row.pika_team_chat_per_min ?? 0,
      officialSupportPerMin: row.official_support_per_min ?? 0,
      privateRoomChatPerMin: row.private_room_chat_per_min ?? 0,
      topicsPerMin: row.topics_per_min ?? 0,
      lafchePerMin: row.lafche_per_min ?? 0,
      httpPerMin: row.http_per_min ?? 0,
    },
    topHttpCategoriesJson: row.top_http_categories_json,
    topWsInboundTypesJson: row.top_ws_inbound_types_json,
    topWsOutboundTypesJson: row.top_ws_outbound_types_json,
    backgroundJobs: parseJsonSafe<BackgroundJobStatsSnapshot>(row.background_jobs_json),
    gc: parseJsonSafe<GcStatsSnapshot>(row.gc_json),
  }
}

function bucketToTimelineSample(bucket: ForensicBucket, resolutionMs: number): CpuIncidentTimelineSample {
  return {
    t: bucket.bucketStartMs,
    sampleResolutionMs: resolutionMs,
    processCpu: bucket.processCpuAvg,
    serverCpu: bucket.serverCpuAvg,
    gameWorkerCpu: bucket.gameWorkerCpuAvg,
    nonGameWorkerProcessCpu: bucket.nonGameWorkerProcessCpuAvg,
    eventLoopUtilization: bucket.eventLoopUtilizationMax,
    eventLoopDelayP99Ms: bucket.eventLoopDelayP99Ms,
    rssMb: bucket.rssMb,
    onlinePlayers: bucket.onlinePlayers,
    activeMatches: bucket.activeMatches,
    wsConnections: bucket.wsConnections,
  }
}

function rawSampleToTimelineSample(sample: RawCpuSample): CpuIncidentTimelineSample {
  return {
    t: sample.sampledAtMs,
    sampleResolutionMs: 1_000,
    processCpu: sample.processCpuPercent,
    serverCpu: null,
    gameWorkerCpu: null,
    nonGameWorkerProcessCpu: null,
    eventLoopUtilization: null,
    eventLoopDelayP99Ms: null,
    rssMb: null,
    onlinePlayers: null,
    activeMatches: null,
    wsConnections: null,
  }
}

export async function createCpuIncidentStore(databaseFilePath: string): Promise<CpuIncidentStore> {
  const sqliteModule = await import('node:sqlite')
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  db.exec('PRAGMA journal_mode = WAL;')

  const insertIncidentStatement = db.prepare(`
    INSERT INTO monitoring_cpu_incidents (
      detection_type, started_at, ended_at, duration_ms,
      process_cpu_max, process_cpu_avg, process_cpu_p95,
      server_cpu_max,
      game_worker_cpu_max, non_game_worker_process_cpu_max,
      event_loop_utilization_max, event_loop_delay_p99_max_ms,
      rss_max_mb,
      online_players_avg, active_matches_avg, ws_connections_avg,
      gameplay_per_min, lobby_chat_per_min, direct_chat_per_min,
      pika_team_chat_per_min, official_support_per_min, private_room_chat_per_min,
      topics_per_min, lafche_per_min, http_per_min,
      top_http_categories_json, top_ws_inbound_types_json, top_ws_outbound_types_json,
      background_jobs_json, gc_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const updateIncidentStatement = db.prepare(`
    UPDATE monitoring_cpu_incidents SET
      detection_type = ?, ended_at = ?, duration_ms = ?,
      process_cpu_max = ?, process_cpu_avg = ?, process_cpu_p95 = ?,
      server_cpu_max = ?,
      game_worker_cpu_max = ?, non_game_worker_process_cpu_max = ?,
      event_loop_utilization_max = ?, event_loop_delay_p99_max_ms = ?,
      rss_max_mb = ?,
      online_players_avg = ?, active_matches_avg = ?, ws_connections_avg = ?,
      gameplay_per_min = ?, lobby_chat_per_min = ?, direct_chat_per_min = ?,
      pika_team_chat_per_min = ?, official_support_per_min = ?, private_room_chat_per_min = ?,
      topics_per_min = ?, lafche_per_min = ?, http_per_min = ?,
      top_http_categories_json = ?, top_ws_inbound_types_json = ?, top_ws_outbound_types_json = ?,
      background_jobs_json = ?, gc_json = ?
    WHERE id = ?
  `)

  const selectLastIncidentStatement = db.prepare(`
    SELECT * FROM monitoring_cpu_incidents ORDER BY started_at DESC LIMIT 1
  `)

  const selectListStatement = db.prepare(`
    SELECT * FROM monitoring_cpu_incidents ORDER BY started_at DESC LIMIT ?
  `)

  const selectByIdStatement = db.prepare(`
    SELECT * FROM monitoring_cpu_incidents WHERE id = ?
  `)

  const insertSampleStatement = db.prepare(`
    INSERT INTO monitoring_cpu_incident_samples (
      incident_id, t, sample_resolution_ms,
      process_cpu, server_cpu, game_worker_cpu, non_game_worker_process_cpu,
      event_loop_utilization, event_loop_delay_p99_ms,
      rss_mb, online_players, active_matches, ws_connections
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const selectSamplesStatement = db.prepare(`
    SELECT t, sample_resolution_ms, process_cpu, server_cpu, game_worker_cpu,
           non_game_worker_process_cpu, event_loop_utilization, event_loop_delay_p99_ms,
           rss_mb, online_players, active_matches, ws_connections
    FROM monitoring_cpu_incident_samples
    WHERE incident_id = ?
    ORDER BY t ASC
  `)

  const deleteSamplesForIncidentStatement = db.prepare(`
    DELETE FROM monitoring_cpu_incident_samples WHERE incident_id = ?
  `)

  const insertSpikeSampleStatement = db.prepare(`
    INSERT INTO monitoring_cpu_incident_spike_samples (
      incident_id, sampled_at, process_cpu,
      server_cpu, game_worker_cpu, non_game_worker_process_cpu,
      event_loop_utilization, event_loop_delay_p99_ms,
      rss_mb, heap_used_mb,
      online_players, active_matches, ws_connections, matchmaking_waiters,
      activity_json, background_jobs_json, gc_json,
      game_worker_cpu_sample_age_ms, non_game_worker_process_cpu_sample_age_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const selectSpikeSamplesStatement = db.prepare(`
    SELECT sampled_at, process_cpu,
           server_cpu, game_worker_cpu, non_game_worker_process_cpu,
           event_loop_utilization, event_loop_delay_p99_ms,
           rss_mb, heap_used_mb,
           online_players, active_matches, ws_connections, matchmaking_waiters,
           activity_json, background_jobs_json, gc_json,
           game_worker_cpu_sample_age_ms, non_game_worker_process_cpu_sample_age_ms
    FROM monitoring_cpu_incident_spike_samples
    WHERE incident_id = ?
    ORDER BY sampled_at ASC
  `)

  const purgeIncidentsStatement = db.prepare(`
    DELETE FROM monitoring_cpu_incidents WHERE started_at < ?
  `)

  const purgeTimelineStatement = db.prepare(`
    DELETE FROM monitoring_cpu_incident_samples
    WHERE incident_id IN (
      SELECT id FROM monitoring_cpu_incidents WHERE started_at < ?
    )
  `)

  const purgeSpikeSamplesStatement = db.prepare(`
    DELETE FROM monitoring_cpu_incident_spike_samples
    WHERE incident_id IN (
      SELECT id FROM monitoring_cpu_incidents WHERE started_at < ?
    )
  `)

  function insertTimeline(incidentId: number, samples: CpuIncidentTimelineSample[]): void {
    for (const sample of samples) {
      insertSampleStatement.run(
        incidentId,
        sample.t,
        sample.sampleResolutionMs,
        sample.processCpu,
        sample.serverCpu,
        sample.gameWorkerCpu,
        sample.nonGameWorkerProcessCpu,
        sample.eventLoopUtilization,
        sample.eventLoopDelayP99Ms,
        sample.rssMb,
        sample.onlinePlayers,
        sample.activeMatches,
        sample.wsConnections,
      )
    }
  }

  function insertSpikeSamples(incidentId: number, incident: ClosedIncident): void {
    for (const sample of incident.rawSpikeSamples) {
      if (sample.context === null) continue
      const c = sample.context
      insertSpikeSampleStatement.run(
        incidentId,
        sample.sampledAtMs,
        sample.processCpuPercent,
        c.serverCpuPercent,
        c.gameWorkerCpuPercent,
        c.nonGameWorkerProcessCpuPercent,
        c.eventLoopUtilization,
        c.eventLoopDelayP99Ms,
        c.rssMb,
        c.heapUsedMb,
        c.onlinePlayers,
        c.activeMatches,
        c.wsConnections,
        c.matchmakingWaiters,
        JSON.stringify(c.activity),
        JSON.stringify(c.backgroundJobs),
        JSON.stringify(c.gc),
        c.gameWorkerCpuSampleAgeMs,
        c.nonGameWorkerProcessCpuSampleAgeMs,
      )
    }
  }

  function buildTimelineForIncident(incident: ClosedIncident): CpuIncidentTimelineSample[] {
    const bucketSamples = [...incident.preBuffer, ...incident.duringBuckets, ...incident.postBuffer].map((b) =>
      bucketToTimelineSample(b, 10_000),
    )
    // За чист extreme_spike (без during buckets — spike-ът е по-кратък от
    // 10s bucket resolution) добавяме сурови 1s семпли, за да покажем
    // истинската кратка продължителност (виж final audit §3, §10).
    const rawSamples = incident.duringBuckets.length === 0
      ? incident.rawSpikeSamples.map(rawSampleToTimelineSample)
      : []
    return [...bucketSamples, ...rawSamples].sort((a, b) => a.t - b.t)
  }

  function persistIncident(incident: ClosedIncident): void {
    // Merge-at-persistence: sustained family incidents мерджват се, ако
    // последният persisted incident е от sustained family и endedAt-ът му е
    // в рамките на sustainedMergeGapMs преди новия incident-а. extreme_spike
    // incidents никога не мерджват тук (merge-ват се на detector ниво чрез
    // extremeSpikeMergeGapMs, много по-кратък прозорец).
    const isSustainedFamily = incident.detectionType === 'sustained_high' || incident.detectionType === 'sustained_with_spike'

    if (isSustainedFamily) {
      const lastRow = selectLastIncidentStatement.get() as IncidentRow | undefined
      if (
        lastRow !== undefined &&
        (lastRow.detection_type === 'sustained_high' || lastRow.detection_type === 'sustained_with_spike') &&
        lastRow.ended_at !== null &&
        incident.startedAtMs - lastRow.ended_at <= CPU_INCIDENT_THRESHOLDS.sustainedMergeGapMs
      ) {
        // Merge: разшири съществуващия ред. Пресмятаме summary полетата
        // върху обединен bucket списък (старата timeline вече е в DB —
        // презаписваме aggregates от новия incident, тъй като началните
        // buckets на стария вече не са в паметта; приемливо приближение —
        // duration/started_at се пазят от стария ред, ended_at/останалите
        // aggregate стойности идват от новия close).
        const mergedType: CpuIncidentDetectionType =
          lastRow.detection_type === 'sustained_with_spike' || incident.detectionType === 'sustained_with_spike'
            ? 'sustained_with_spike'
            : 'sustained_high'

        const fields = buildSummaryFields(incident)
        const mergedDurationMs = incident.endedAtMs - lastRow.started_at

        // Merge fix (виж final fix pass брифа §8) — background/gc агрегати
        // от двата фрагмента се СЪБИРАТ (count/totalDurationMs sum,
        // maxDurationMs max), никога не се презаписват. null + measured =
        // measured; null + null = null — не губим evidence от първата
        // половина на merged incident-а.
        const mergedBackgroundJobs = mergeBackgroundJobStats(
          parseJsonSafe<BackgroundJobStatsSnapshot>(lastRow.background_jobs_json),
          parseJsonSafe<BackgroundJobStatsSnapshot>(fields.background_jobs_json),
        )
        const mergedGc = mergeGcStats(
          parseJsonSafe<GcStatsSnapshot>(lastRow.gc_json),
          parseJsonSafe<GcStatsSnapshot>(fields.gc_json),
        )

        // Persistence transaction (виж final fix pass брифа §11) —
        // established BEGIN IMMEDIATE/COMMIT/ROLLBACK pattern от
        // lobbyChatStore.ts. Обвива incident row update + timeline rows +
        // spike sample rows в ЕДНА атомарна транзакция — ако insertSpikeSamples
        // хвърли по средата, целият merge се rollback-ва, не оставя partial
        // state (row updated, но timeline/spike samples липсват).
        db.exec('BEGIN IMMEDIATE;')
        try {
          updateIncidentStatement.run(
            mergedType,
            incident.endedAtMs,
            mergedDurationMs,
            fields.process_cpu_max !== null && lastRow.process_cpu_max !== null
              ? Math.max(fields.process_cpu_max, lastRow.process_cpu_max)
              : (fields.process_cpu_max ?? lastRow.process_cpu_max),
            fields.process_cpu_avg,
            fields.process_cpu_p95,
            fields.server_cpu_max !== null && lastRow.server_cpu_max !== null
              ? Math.max(fields.server_cpu_max, lastRow.server_cpu_max)
              : (fields.server_cpu_max ?? lastRow.server_cpu_max),
            fields.game_worker_cpu_max,
            fields.non_game_worker_process_cpu_max,
            fields.event_loop_utilization_max,
            fields.event_loop_delay_p99_max_ms,
            fields.rss_max_mb,
            fields.online_players_avg,
            fields.active_matches_avg,
            fields.ws_connections_avg,
            fields.gameplay_per_min,
            fields.lobby_chat_per_min,
            fields.direct_chat_per_min,
            fields.pika_team_chat_per_min,
            fields.official_support_per_min,
            fields.private_room_chat_per_min,
            fields.topics_per_min,
            fields.lafche_per_min,
            fields.http_per_min,
            fields.top_http_categories_json,
            fields.top_ws_inbound_types_json,
            fields.top_ws_outbound_types_json,
            mergedBackgroundJobs !== null ? JSON.stringify(mergedBackgroundJobs) : null,
            mergedGc !== null ? JSON.stringify(mergedGc) : null,
            lastRow.id,
          )

          const timeline = buildTimelineForIncident(incident)
          insertTimeline(lastRow.id, timeline)
          insertSpikeSamples(lastRow.id, incident)
          db.exec('COMMIT;')
        } catch (error) {
          try {
            db.exec('ROLLBACK;')
          } catch {
            // ignore rollback failure, surface the original error below
          }
          throw error
        }
        return
      }
    }

    const fields = buildSummaryFields(incident)

    // Persistence transaction (виж final fix pass брифа §11) — same
    // established BEGIN IMMEDIATE/COMMIT/ROLLBACK pattern. Ако
    // insertSpikeSamples хвърли по средата, целият incident insert (row +
    // timeline + spike samples) се rollback-ва атомарно — никакъв partial
    // incident row без съответните timeline/spike детайли.
    db.exec('BEGIN IMMEDIATE;')
    try {
      const result = insertIncidentStatement.run(
        fields.detection_type,
        fields.started_at,
        fields.ended_at,
        fields.duration_ms,
        fields.process_cpu_max,
        fields.process_cpu_avg,
        fields.process_cpu_p95,
        fields.server_cpu_max,
        fields.game_worker_cpu_max,
        fields.non_game_worker_process_cpu_max,
        fields.event_loop_utilization_max,
        fields.event_loop_delay_p99_max_ms,
        fields.rss_max_mb,
        fields.online_players_avg,
        fields.active_matches_avg,
        fields.ws_connections_avg,
        fields.gameplay_per_min,
        fields.lobby_chat_per_min,
        fields.direct_chat_per_min,
        fields.pika_team_chat_per_min,
        fields.official_support_per_min,
        fields.private_room_chat_per_min,
        fields.topics_per_min,
        fields.lafche_per_min,
        fields.http_per_min,
        fields.top_http_categories_json,
        fields.top_ws_inbound_types_json,
        fields.top_ws_outbound_types_json,
        fields.background_jobs_json,
        fields.gc_json,
      )

      const incidentId = Number(result.lastInsertRowid)
      const timeline = buildTimelineForIncident(incident)
      insertTimeline(incidentId, timeline)
      insertSpikeSamples(incidentId, incident)
      db.exec('COMMIT;')
    } catch (error) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // ignore rollback failure, surface the original error below
      }
      throw error
    }
  }

  function listIncidents(limit: number): CpuIncidentListItem[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)))
    const rows = selectListStatement.all(boundedLimit) as IncidentRow[]
    return rows.map(rowToSummary)
  }

  function getIncidentDetail(incidentId: number): CpuIncidentDetail | null {
    const row = selectByIdStatement.get(incidentId) as IncidentRow | undefined
    if (row === undefined) return null

    const sampleRows = selectSamplesStatement.all(incidentId) as Array<{
      t: number
      sample_resolution_ms: number
      process_cpu: number | null
      server_cpu: number | null
      game_worker_cpu: number | null
      non_game_worker_process_cpu: number | null
      event_loop_utilization: number | null
      event_loop_delay_p99_ms: number | null
      rss_mb: number | null
      online_players: number | null
      active_matches: number | null
      ws_connections: number | null
    }>

    const timeline: CpuIncidentTimelineSample[] = sampleRows.map((r) => ({
      t: r.t,
      sampleResolutionMs: r.sample_resolution_ms,
      processCpu: r.process_cpu,
      serverCpu: r.server_cpu,
      gameWorkerCpu: r.game_worker_cpu,
      nonGameWorkerProcessCpu: r.non_game_worker_process_cpu,
      eventLoopUtilization: r.event_loop_utilization,
      eventLoopDelayP99Ms: r.event_loop_delay_p99_ms,
      rssMb: r.rss_mb,
      onlinePlayers: r.online_players,
      activeMatches: r.active_matches,
      wsConnections: r.ws_connections,
    }))

    const spikeSampleRows = selectSpikeSamplesStatement.all(incidentId) as Array<{
      sampled_at: number
      process_cpu: number
      server_cpu: number | null
      game_worker_cpu: number | null
      non_game_worker_process_cpu: number | null
      event_loop_utilization: number | null
      event_loop_delay_p99_ms: number | null
      rss_mb: number | null
      heap_used_mb: number | null
      online_players: number | null
      active_matches: number | null
      ws_connections: number | null
      matchmaking_waiters: number | null
      activity_json: string | null
      background_jobs_json: string | null
      gc_json: string | null
      game_worker_cpu_sample_age_ms: number | null
      non_game_worker_process_cpu_sample_age_ms: number | null
    }>

    const spikeSamples: CpuIncidentSpikeSampleDetail[] = spikeSampleRows.map((r) => {
      const activity = parseJsonSafe<ActivityCountersSnapshot>(r.activity_json)
      const backgroundJobs = parseJsonSafe<BackgroundJobStatsSnapshot>(r.background_jobs_json)
      const gc = parseJsonSafe<GcStatsSnapshot>(r.gc_json)
      return {
        sampledAtMs: r.sampled_at,
        processCpuPercent: r.process_cpu,
        context:
          activity !== null && backgroundJobs !== null && gc !== null
            ? {
                serverCpuPercent: r.server_cpu,
                gameWorkerCpuPercent: r.game_worker_cpu,
                nonGameWorkerProcessCpuPercent: r.non_game_worker_process_cpu,
                gameWorkerCpuSampleAgeMs: r.game_worker_cpu_sample_age_ms,
                nonGameWorkerProcessCpuSampleAgeMs: r.non_game_worker_process_cpu_sample_age_ms,
                eventLoopUtilization: r.event_loop_utilization,
                eventLoopDelayP99Ms: r.event_loop_delay_p99_ms,
                rssMb: r.rss_mb,
                heapUsedMb: r.heap_used_mb,
                onlinePlayers: r.online_players,
                activeMatches: r.active_matches,
                wsConnections: r.ws_connections,
                matchmakingWaiters: r.matchmaking_waiters,
                activity,
                backgroundJobs,
                gc,
              }
            : null,
      }
    })

    return { summary: rowToSummary(row), timeline, spikeSamples }
  }

  function purgeOlderThan(summaryCutoffMs: number, timelineCutoffMs: number): void {
    // Timeline retention е по-кратка от summary retention — изтрий детайлния
    // timeline по-рано, пази компактния summary ред по-дълго.
    purgeTimelineStatement.run(timelineCutoffMs)
    purgeSpikeSamplesStatement.run(timelineCutoffMs)
    purgeIncidentsStatement.run(summaryCutoffMs)
  }

  function close(): void {
    db.close()
  }

  return { persistIncident, listIncidents, getIncidentDetail, purgeOlderThan, close }
}

export function getDefaultSummaryRetentionCutoffMs(): number {
  return Date.now() - CPU_INCIDENT_RETENTION.summaryRetentionMs
}

export function getDefaultTimelineRetentionCutoffMs(): number {
  return Date.now() - CPU_INCIDENT_RETENTION.timelineRetentionMs
}
