import type { MonitoringSnapshot } from './monitoringTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

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

export type MonitoringHistoryResult = {
  window: HistoryWindow
  points: MonitoringHistoryPoint[]
  peaks: MonitoringPeaks
}

export type MonitoringHistoryStore = {
  record(snapshot: MonitoringSnapshot): void
  queryHistory(window: HistoryWindow): MonitoringHistoryResult
  purgeOlderThan(cutoffMs: number): void
  close(): void
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const BUCKET_MS: Record<HistoryWindow, number> = {
  '1h':  60 * 1000,
  '24h': 15 * 60 * 1000,
  '7d':  60 * 60 * 1000,
}

const WINDOW_MS: Record<HistoryWindow, number> = {
  '1h':  1 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
}

export function isValidHistoryWindow(value: string): value is HistoryWindow {
  return value === '1h' || value === '24h' || value === '7d'
}

type HistoryRow = {
  t: number
  server_cpu: number | null
  node_cpu: number | null
  ram_used_mb: number
  ram_percent: number
  rss_mb: number
  ws_conns: number
  online_players: number
  active_rooms: number
  mm_waiters: number
}

type PeakRow = {
  server_cpu: number | null
  node_cpu: number | null
  ram_used_mb: number
  ram_percent: number
  rss_mb: number
  ws_conns: number
  online_players: number
  active_rooms: number
  mm_waiters: number
}

export async function createMonitoringHistoryStore(
  databaseFilePath: string,
): Promise<MonitoringHistoryStore> {
  const sqliteModule = await import('node:sqlite')
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  db.exec('PRAGMA journal_mode = WAL;')

  const insertStatement = db.prepare(`
    INSERT INTO monitoring_history
      (sampled_at, server_cpu, node_cpu, ram_used_mb, ram_percent, rss_mb,
       ws_conns, online_players, active_rooms, mm_waiters)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const purgeStatement = db.prepare(
    'DELETE FROM monitoring_history WHERE sampled_at < ?',
  )

  function record(snapshot: MonitoringSnapshot): void {
    if (snapshot.samplerStatus !== 'running') return
    insertStatement.run(
      snapshot.sampledAtMs,
      snapshot.serverCpuNowPercent ?? null,
      snapshot.nodeCpuNowPercent ?? null,
      snapshot.ramUsedMb,
      snapshot.ramPercent,
      snapshot.processRssMb,
      snapshot.activeWsConnections,
      snapshot.uniqueOnlineRealPlayers,
      snapshot.activeRooms,
      snapshot.totalMatchmakingWaiters,
    )
  }

  function queryHistory(window: HistoryWindow): MonitoringHistoryResult {
    const nowMs = Date.now()
    const fromMs = nowMs - WINDOW_MS[window]
    const bucketMs = BUCKET_MS[window]

    const points = db.prepare(`
      SELECT
        CAST(sampled_at / ? AS INTEGER) * ? AS t,
        AVG(server_cpu)     AS server_cpu,
        AVG(node_cpu)       AS node_cpu,
        AVG(ram_used_mb)    AS ram_used_mb,
        AVG(ram_percent)    AS ram_percent,
        AVG(rss_mb)         AS rss_mb,
        MAX(ws_conns)       AS ws_conns,
        MAX(online_players) AS online_players,
        MAX(active_rooms)   AS active_rooms,
        MAX(mm_waiters)     AS mm_waiters
      FROM monitoring_history
      WHERE sampled_at >= ?
      GROUP BY CAST(sampled_at / ? AS INTEGER)
      ORDER BY t ASC
    `).all(bucketMs, bucketMs, fromMs, bucketMs) as HistoryRow[]

    const peakRows = db.prepare(`
      SELECT
        MAX(server_cpu)     AS server_cpu,
        MAX(node_cpu)       AS node_cpu,
        MAX(ram_used_mb)    AS ram_used_mb,
        MAX(ram_percent)    AS ram_percent,
        MAX(rss_mb)         AS rss_mb,
        MAX(ws_conns)       AS ws_conns,
        MAX(online_players) AS online_players,
        MAX(active_rooms)   AS active_rooms,
        MAX(mm_waiters)     AS mm_waiters
      FROM monitoring_history
      WHERE sampled_at >= ?
    `).all(fromMs) as PeakRow[]

    const pr = peakRows[0] ?? null

    const peaks: MonitoringPeaks = pr !== null
      ? {
        serverCpu: pr.server_cpu ?? null,
        nodeCpu: pr.node_cpu ?? null,
        ramUsedMb: pr.ram_used_mb ?? 0,
        ramPercent: pr.ram_percent ?? 0,
        rssMb: pr.rss_mb ?? 0,
        wsConns: pr.ws_conns ?? 0,
        onlinePlayers: pr.online_players ?? 0,
        activeRooms: pr.active_rooms ?? 0,
        mmWaiters: pr.mm_waiters ?? 0,
      }
      : {
        serverCpu: null,
        nodeCpu: null,
        ramUsedMb: 0,
        ramPercent: 0,
        rssMb: 0,
        wsConns: 0,
        onlinePlayers: 0,
        activeRooms: 0,
        mmWaiters: 0,
      }

    return {
      window,
      points: points.map((row) => ({
        t: row.t,
        serverCpu: row.server_cpu ?? null,
        nodeCpu: row.node_cpu ?? null,
        ramUsedMb: row.ram_used_mb,
        ramPercent: row.ram_percent,
        rssMb: row.rss_mb,
        wsConns: row.ws_conns,
        onlinePlayers: row.online_players,
        activeRooms: row.active_rooms,
        mmWaiters: row.mm_waiters,
      })),
      peaks,
    }
  }

  function purgeOlderThan(cutoffMs: number): void {
    purgeStatement.run(cutoffMs)
  }

  function close(): void {
    db.close()
  }

  return { record, queryHistory, purgeOlderThan, close }
}

export function getDefaultRetentionCutoffMs(): number {
  return Date.now() - RETENTION_MS
}
