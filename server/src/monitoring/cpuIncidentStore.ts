import type { ClosedIncident } from './cpuIncidentDetector.js'
import type { ActivityCountersSnapshot } from './activityCounters.js'
import {
  CPU_INCIDENT_RETENTION,
  CPU_INCIDENT_THRESHOLDS,
  type CpuIncidentDetectionType,
  type CpuIncidentSummary,
  type CpuIncidentTimelineSample,
  type CpuIncidentDetail,
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

function buildSummaryFields(incident: ClosedIncident): Omit<IncidentRow, 'id'> {
  const allBuckets = [...incident.preBuffer, ...incident.duringBuckets, ...incident.postBuffer]
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

  const activityTotals: ActivityCountersSnapshot[] = incident.duringBuckets.map((b) => b.activity)

  const sumActivity = (pick: (a: ActivityCountersSnapshot) => number): number =>
    activityTotals.reduce((s, a) => s + pick(a), 0)

  const httpCategoryTotals = mergeCategoryCounts(incident.duringBuckets, (b) => b.activity.httpRequestsByCategory)
  const wsInboundTotals = mergeCategoryCounts(incident.duringBuckets, (b) => b.activity.wsInboundByType)
  const wsOutboundTotals = mergeCategoryCounts(incident.duringBuckets, (b) => b.activity.wsOutboundByType)
  const httpTotal = Object.values(httpCategoryTotals).reduce((s, v) => s + v, 0)

  return {
    detection_type: incident.detectionType,
    started_at: incident.startedAtMs,
    ended_at: incident.endedAtMs,
    duration_ms: durationMs,

    process_cpu_max: maxOf(cpuMaxCandidates),
    process_cpu_avg: avgOf(cpuValuesForStats),
    process_cpu_p95: percentile95(cpuValuesForStats),

    server_cpu_max: maxOf(incident.duringBuckets.map((b) => b.serverCpuMax).filter((v): v is number => v !== null)),

    game_worker_cpu_max: maxOf(
      incident.duringBuckets.map((b) => b.gameWorkerCpuMax).filter((v): v is number => v !== null),
    ),
    non_game_worker_process_cpu_max: maxOf(
      incident.duringBuckets.map((b) => b.nonGameWorkerProcessCpuMax).filter((v): v is number => v !== null),
    ),

    event_loop_utilization_max: maxOf(
      incident.duringBuckets.map((b) => b.eventLoopUtilizationMax).filter((v): v is number => v !== null),
    ),
    event_loop_delay_p99_max_ms: maxOf(
      incident.duringBuckets.map((b) => b.eventLoopDelayP99Ms).filter((v): v is number => v !== null),
    ),

    rss_max_mb: maxOf(allBuckets.map((b) => b.rssMb).filter((v): v is number => v !== null)),

    online_players_avg: avgOf(incident.duringBuckets.map((b) => b.onlinePlayers)),
    active_matches_avg: avgOf(incident.duringBuckets.map((b) => b.activeMatches)),
    ws_connections_avg: avgOf(incident.duringBuckets.map((b) => b.wsConnections)),

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
      top_http_categories_json, top_ws_inbound_types_json, top_ws_outbound_types_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      top_http_categories_json = ?, top_ws_inbound_types_json = ?, top_ws_outbound_types_json = ?
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

  const purgeIncidentsStatement = db.prepare(`
    DELETE FROM monitoring_cpu_incidents WHERE started_at < ?
  `)

  const purgeTimelineStatement = db.prepare(`
    DELETE FROM monitoring_cpu_incident_samples
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
          lastRow.id,
        )

        const timeline = buildTimelineForIncident(incident)
        insertTimeline(lastRow.id, timeline)
        return
      }
    }

    const fields = buildSummaryFields(incident)
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
    )

    const incidentId = Number(result.lastInsertRowid)
    const timeline = buildTimelineForIncident(incident)
    insertTimeline(incidentId, timeline)
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

    return { summary: rowToSummary(row), timeline }
  }

  function purgeOlderThan(summaryCutoffMs: number, timelineCutoffMs: number): void {
    // Timeline retention е по-кратка от summary retention — изтрий детайлния
    // timeline по-рано, пази компактния summary ред по-дълго.
    purgeTimelineStatement.run(timelineCutoffMs)
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
