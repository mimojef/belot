import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  createMonitoringHistoryStore,
  getDefaultRetentionCutoffMs,
  isValidHistoryWindow,
} from '../src/monitoring/monitoringHistoryStore.js'
import type { MonitoringSnapshot } from '../src/monitoring/monitoringTypes.js'

// ─── Брояч ────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got ${String(actual)}, expected ${String(expected)})`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function withTempDb(
  fn: (dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-monitoring-history-check-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    // Изпълни migration ръчно
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitoring_history (
        id             INTEGER PRIMARY KEY,
        sampled_at     INTEGER NOT NULL,
        server_cpu     REAL,
        node_cpu       REAL,
        ram_used_mb    REAL    NOT NULL,
        ram_percent    REAL    NOT NULL,
        rss_mb         REAL    NOT NULL,
        ws_conns       INTEGER NOT NULL,
        online_players INTEGER NOT NULL,
        active_rooms   INTEGER NOT NULL,
        mm_waiters     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_monitoring_history_sampled_at
        ON monitoring_history(sampled_at);
    `)
    db.close()
    await fn(dbPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function makeRunningSnapshot(overrides: Partial<MonitoringSnapshot> = {}): MonitoringSnapshot {
  return {
    samplerStatus: 'running',
    sampledAtMs: Date.now(),
    sampledAtIso: new Date().toISOString(),
    sampleWindowMs: 1000,
    serverCpuNowPercent: 42.5,
    nodeCpuNowPercent: 15.3,
    ramUsedMb: 1200,
    ramTotalMb: 4096,
    ramPercent: 29.3,
    processRssMb: 220,
    processUptimeSec: 3600,
    backendStartedAtIso: new Date().toISOString(),
    activeWsConnections: 10,
    uniqueOnlineRealPlayers: 8,
    totalMatchmakingWaiters: 3,
    matchmakingWaitersByStake: { '5000': 2, '10000': 1 },
    activeRooms: 2,
    roomsByPhase: { bidding: 1, playing: 1 },
    workerPool: null,
    lastError: null,
    ...overrides,
  }
}

// ─── [1] isValidHistoryWindow ─────────────────────────────────────────────────

console.log('\n[1] isValidHistoryWindow — валидация')
assert(isValidHistoryWindow('1h'), '"1h" е валиден')
assert(isValidHistoryWindow('24h'), '"24h" е валиден')
assert(isValidHistoryWindow('7d'), '"7d" е валиден')
assert(!isValidHistoryWindow(''), 'празен стринг не е валиден')
assert(!isValidHistoryWindow('1d'), '"1d" не е валиден')
assert(!isValidHistoryWindow('7h'), '"7h" не е валиден')
assert(!isValidHistoryWindow('30d'), '"30d" не е валиден')
assert(!isValidHistoryWindow('1H'), 'case-sensitive: "1H" не е валиден')

// ─── [2] record + insert ──────────────────────────────────────────────────────

console.log('\n[2] record() — insert на running snapshot')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const snap = makeRunningSnapshot({ sampledAtMs: 1_700_000_000_000 })
  store.record(snap)

  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT * FROM monitoring_history').all() as Array<Record<string, unknown>>
  db.close()

  assertEqual(rows.length, 1, 'записан е точно 1 ред')
  const row = rows[0]!
  assertEqual(row['sampled_at'], 1_700_000_000_000, 'sampled_at съответства')
  assert(Math.abs((row['server_cpu'] as number) - 42.5) < 0.001, 'server_cpu = 42.5')
  assert(Math.abs((row['node_cpu'] as number) - 15.3) < 0.001, 'node_cpu = 15.3')
  assert(Math.abs((row['ram_used_mb'] as number) - 1200) < 0.001, 'ram_used_mb = 1200')
  assert(Math.abs((row['ram_percent'] as number) - 29.3) < 0.001, 'ram_percent = 29.3')
  assert(Math.abs((row['rss_mb'] as number) - 220) < 0.001, 'rss_mb = 220')
  assertEqual(row['ws_conns'], 10, 'ws_conns = 10')
  assertEqual(row['online_players'], 8, 'online_players = 8')
  assertEqual(row['active_rooms'], 2, 'active_rooms = 2')
  assertEqual(row['mm_waiters'], 3, 'mm_waiters = 3')

  store.close()
})

// ─── [3] null CPU стойности ───────────────────────────────────────────────────

console.log('\n[3] record() — null CPU (warming_up не трябва да се записва)')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)

  store.record(makeRunningSnapshot({ serverCpuNowPercent: null, nodeCpuNowPercent: null }))
  store.record({ ...makeRunningSnapshot(), samplerStatus: 'warming_up' })
  store.record({ ...makeRunningSnapshot(), samplerStatus: 'stopped' })

  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT * FROM monitoring_history').all() as Array<Record<string, unknown>>
  db.close()

  assertEqual(rows.length, 1, 'само running snapshot се записва (warming_up и stopped се пропускат)')
  assert(rows[0]!['server_cpu'] === null, 'server_cpu е NULL при null стойност')
  assert(rows[0]!['node_cpu'] === null, 'node_cpu е NULL при null стойност')

  store.close()
})

// ─── [4] queryHistory — празна история ───────────────────────────────────────

console.log('\n[4] queryHistory() — празна таблица')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const result = store.queryHistory('1h')

  assertEqual(result.window, '1h', 'window = 1h')
  assertEqual(result.points.length, 0, 'points е празен масив')
  assertEqual(result.peaks.serverCpu, null, 'peaks.serverCpu = null')
  assertEqual(result.peaks.nodeCpu, null, 'peaks.nodeCpu = null')
  assertEqual(result.peaks.ramUsedMb, 0, 'peaks.ramUsedMb = 0')
  assertEqual(result.peaks.wsConns, 0, 'peaks.wsConns = 0')
  assertEqual(result.peaks.onlinePlayers, 0, 'peaks.onlinePlayers = 0')
  assertEqual(result.peaks.activeRooms, 0, 'peaks.activeRooms = 0')
  assertEqual(result.peaks.mmWaiters, 0, 'peaks.mmWaiters = 0')

  store.close()
})

// ─── [5] queryHistory — aggregation buckets ───────────────────────────────────

console.log('\n[5] queryHistory() — bucket aggregation')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const nowMs = Date.now()

  // Използваме bucket-aligned timestamp-и за детерминизъм.
  // 1-минутен bucket при 1h window: (t / 60000) * 60000
  const bucketMs = 60_000
  const nowBucket = Math.floor(nowMs / bucketMs) * bucketMs

  // Двата записа са в един bucket (bucket1) — aligned към границата
  const b1t1 = nowBucket - 10 * bucketMs          // преди 10 мин, начало на bucket1
  const b1t2 = nowBucket - 10 * bucketMs + 5_000  // +5 сек — гарантирано в същия bucket
  // Третият запис е в отделен bucket (bucket2)
  const b2t1 = nowBucket - 5 * bucketMs           // преди 5 мин, отделен bucket

  store.record(makeRunningSnapshot({
    sampledAtMs: b1t1,
    serverCpuNowPercent: 20,
    activeWsConnections: 5,
  }))
  store.record(makeRunningSnapshot({
    sampledAtMs: b1t2,
    serverCpuNowPercent: 40,
    activeWsConnections: 8,
  }))
  store.record(makeRunningSnapshot({
    sampledAtMs: b2t1,
    serverCpuNowPercent: 60,
    activeWsConnections: 3,
  }))

  const result = store.queryHistory('1h')

  assert(result.points.length >= 2, `имаме ≥ 2 bucket точки (got ${result.points.length})`)

  // Намираме bucket1 по точния aligned timestamp
  const b1 = result.points.find((p) => p.t === nowBucket - 10 * bucketMs)
  if (b1) {
    assert(b1.serverCpu !== null && Math.abs(b1.serverCpu - 30) < 1, `bucket1 AVG serverCpu ≈ 30 (got ${b1.serverCpu})`)
    assertEqual(b1.wsConns, 8, 'bucket1 MAX wsConns = 8')
  } else {
    assert(false, `bucket1 (t=${nowBucket - 10 * bucketMs}) присъства в points`)
  }

  // Peaks: MAX cpu = 60, MAX ws = 8
  assert(result.peaks.serverCpu !== null && result.peaks.serverCpu >= 60 - 0.01, `peaks.serverCpu ≥ 60 (got ${result.peaks.serverCpu})`)
  assertEqual(result.peaks.wsConns, 8, 'peaks.wsConns = 8')

  store.close()
})

// ─── [6] peaks — правилни MAX стойности ──────────────────────────────────────

console.log('\n[6] peaks — MAX стойности')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const nowMs = Date.now()

  store.record(makeRunningSnapshot({
    sampledAtMs: nowMs - 30 * 60 * 1000,
    serverCpuNowPercent: 90,
    nodeCpuNowPercent: 120,
    ramUsedMb: 3500,
    ramPercent: 85,
    processRssMb: 400,
    activeWsConnections: 100,
    uniqueOnlineRealPlayers: 80,
    activeRooms: 20,
    totalMatchmakingWaiters: 15,
  }))
  store.record(makeRunningSnapshot({
    sampledAtMs: nowMs - 15 * 60 * 1000,
    serverCpuNowPercent: 10,
    nodeCpuNowPercent: 5,
    ramUsedMb: 500,
    ramPercent: 12,
    processRssMb: 100,
    activeWsConnections: 2,
    uniqueOnlineRealPlayers: 1,
    activeRooms: 0,
    totalMatchmakingWaiters: 0,
  }))

  const result = store.queryHistory('1h')
  const pk = result.peaks

  assert(pk.serverCpu !== null && Math.abs(pk.serverCpu - 90) < 0.01, `peaks.serverCpu = 90 (got ${pk.serverCpu})`)
  assert(pk.nodeCpu !== null && Math.abs(pk.nodeCpu - 120) < 0.01, `peaks.nodeCpu = 120 (got ${pk.nodeCpu})`)
  assert(Math.abs(pk.ramUsedMb - 3500) < 0.01, `peaks.ramUsedMb = 3500 (got ${pk.ramUsedMb})`)
  assert(Math.abs(pk.ramPercent - 85) < 0.01, `peaks.ramPercent = 85 (got ${pk.ramPercent})`)
  assert(Math.abs(pk.rssMb - 400) < 0.01, `peaks.rssMb = 400 (got ${pk.rssMb})`)
  assertEqual(pk.wsConns, 100, 'peaks.wsConns = 100')
  assertEqual(pk.onlinePlayers, 80, 'peaks.onlinePlayers = 80')
  assertEqual(pk.activeRooms, 20, 'peaks.activeRooms = 20')
  assertEqual(pk.mmWaiters, 15, 'peaks.mmWaiters = 15')

  store.close()
})

// ─── [7] retention purge ──────────────────────────────────────────────────────

console.log('\n[7] purgeOlderThan() — изтрива стари редове')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const nowMs = Date.now()

  const oldMs = nowMs - 31 * 24 * 60 * 60 * 1000  // преди 31 дни
  const newMs = nowMs - 1 * 60 * 60 * 1000          // преди 1 час

  store.record(makeRunningSnapshot({ sampledAtMs: oldMs }))
  store.record(makeRunningSnapshot({ sampledAtMs: newMs }))

  const db = new DatabaseSync(dbPath)
  const beforeCount = (db.prepare('SELECT COUNT(*) as n FROM monitoring_history').get() as { n: number }).n
  db.close()
  assertEqual(beforeCount, 2, 'преди purge: 2 реда')

  store.purgeOlderThan(getDefaultRetentionCutoffMs())

  const db2 = new DatabaseSync(dbPath)
  const afterCount = (db2.prepare('SELECT COUNT(*) as n FROM monitoring_history').get() as { n: number }).n
  db2.close()
  assertEqual(afterCount, 1, 'след purge: 1 ред (само новият е останал)')

  // Проверяваме, че оставшият запис е новият
  const db3 = new DatabaseSync(dbPath)
  const remaining = db3.prepare('SELECT sampled_at FROM monitoring_history').get() as { sampled_at: number }
  db3.close()
  assert(remaining.sampled_at >= newMs - 1000, 'останалият ред е новият запис')

  store.close()
})

// ─── [8] invalid window guard ─────────────────────────────────────────────────

console.log('\n[8] isValidHistoryWindow — невалидни window стойности')
const invalidWindows = ['', '0h', '2h', '48h', '30d', 'week', '1H', '24H', '7D', ' 1h', '1h ']
for (const w of invalidWindows) {
  assert(!isValidHistoryWindow(w), `"${w}" не е валиден window`)
}

// ─── [9] queryHistory — различни прозорци ─────────────────────────────────────

console.log('\n[9] queryHistory() — 24h и 7d прозорци')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const nowMs = Date.now()

  // Запис преди 2 часа — в 24h прозорец, в 7d прозорец, не в 1h прозорец
  store.record(makeRunningSnapshot({ sampledAtMs: nowMs - 2 * 60 * 60 * 1000 }))
  // Запис преди 25 часа — само в 7d прозорец
  store.record(makeRunningSnapshot({ sampledAtMs: nowMs - 25 * 60 * 60 * 1000 }))

  const r1h = store.queryHistory('1h')
  const r24h = store.queryHistory('24h')
  const r7d = store.queryHistory('7d')

  assertEqual(r1h.points.length, 0, '1h: записите преди 2ч и 25ч не са в прозореца')
  assert(r24h.points.length >= 1, `24h: ≥ 1 точка (got ${r24h.points.length})`)
  assert(r7d.points.length >= 2, `7d: ≥ 2 точки (got ${r7d.points.length})`)

  store.close()
})

// ─── [10] множество записи — без дублиране ────────────────────────────────────

console.log('\n[10] record() — множество последователни записи')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const nowMs = Date.now()

  for (let i = 0; i < 5; i++) {
    store.record(makeRunningSnapshot({ sampledAtMs: nowMs - i * 60_000 }))
  }

  const db = new DatabaseSync(dbPath)
  const count = (db.prepare('SELECT COUNT(*) as n FROM monitoring_history').get() as { n: number }).n
  db.close()
  assertEqual(count, 5, '5 последователни записа дават 5 реда')

  store.close()
})

// ─── [11] getDefaultRetentionCutoffMs ─────────────────────────────────────────

console.log('\n[11] getDefaultRetentionCutoffMs() — 30-дневен праг')
{
  const before = Date.now()
  const cutoff = getDefaultRetentionCutoffMs()
  const after = Date.now()
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  assert(cutoff <= before - thirtyDaysMs + 100, `cutoff ≤ now - 30d (got ${cutoff})`)
  assert(cutoff >= after - thirtyDaysMs - 100, `cutoff ≥ now - 30d - margin (got ${cutoff})`)
}

// ─── [12] peakMoments — timestamp на пиковия момент ─────────────────────────

console.log('\n[12] peakMoments — стойност и timestamp на пиков момент')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const nowMs = Date.now()

  const t1 = nowMs - 45 * 60 * 1000  // преди 45 мин — по-висока стойност
  const t2 = nowMs - 15 * 60 * 1000  // преди 15 мин — по-ниска стойност

  store.record(makeRunningSnapshot({
    sampledAtMs: t1,
    activeWsConnections: 50,
    uniqueOnlineRealPlayers: 40,
    activeRooms: 10,
    totalMatchmakingWaiters: 8,
  }))
  store.record(makeRunningSnapshot({
    sampledAtMs: t2,
    activeWsConnections: 20,
    uniqueOnlineRealPlayers: 12,
    activeRooms: 4,
    totalMatchmakingWaiters: 2,
  }))

  const result = store.queryHistory('1h')
  const pm = result.peakMoments

  assertEqual(pm.wsConns.value, 50, 'wsConns.value = 50 (пиковата)')
  assertEqual(pm.wsConns.sampledAt, t1, 'wsConns.sampledAt = t1 (timestamp на пика)')
  assertEqual(pm.onlinePlayers.value, 40, 'onlinePlayers.value = 40')
  assertEqual(pm.onlinePlayers.sampledAt, t1, 'onlinePlayers.sampledAt = t1')
  assertEqual(pm.activeRooms.value, 10, 'activeRooms.value = 10')
  assertEqual(pm.activeRooms.sampledAt, t1, 'activeRooms.sampledAt = t1')
  assertEqual(pm.mmWaiters.value, 8, 'mmWaiters.value = 8')
  assertEqual(pm.mmWaiters.sampledAt, t1, 'mmWaiters.sampledAt = t1')

  store.close()
})

// ─── [13] peakMoments — tie-breaking: при равни стойности печели по-нов запис

console.log('\n[13] peakMoments — tie-breaking при равна стойност')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const nowMs = Date.now()

  const tOld = nowMs - 50 * 60 * 1000  // по-стар
  const tNew = nowMs - 10 * 60 * 1000  // по-нов

  store.record(makeRunningSnapshot({
    sampledAtMs: tOld,
    activeWsConnections: 30,
    uniqueOnlineRealPlayers: 20,
    activeRooms: 5,
    totalMatchmakingWaiters: 4,
  }))
  store.record(makeRunningSnapshot({
    sampledAtMs: tNew,
    activeWsConnections: 30,
    uniqueOnlineRealPlayers: 20,
    activeRooms: 5,
    totalMatchmakingWaiters: 4,
  }))

  const result = store.queryHistory('1h')
  const pm = result.peakMoments

  assertEqual(pm.wsConns.sampledAt, tNew, 'wsConns tie-break: по-нов timestamp печели')
  assertEqual(pm.onlinePlayers.sampledAt, tNew, 'onlinePlayers tie-break: по-нов timestamp')
  assertEqual(pm.activeRooms.sampledAt, tNew, 'activeRooms tie-break: по-нов timestamp')
  assertEqual(pm.mmWaiters.sampledAt, tNew, 'mmWaiters tie-break: по-нов timestamp')

  store.close()
})

// ─── [14] peakMoments — запис извън прозореца не се брои ─────────────────────

console.log('\n[14] peakMoments — запис извън window не е пиков момент')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const nowMs = Date.now()

  const tOutside = nowMs - 2 * 60 * 60 * 1000  // преди 2ч — извън 1h прозорец
  const tInside  = nowMs - 30 * 60 * 1000       // преди 30мин — вътре в 1h прозорец

  store.record(makeRunningSnapshot({
    sampledAtMs: tOutside,
    activeWsConnections: 999,  // много висока стойност извън прозореца
    uniqueOnlineRealPlayers: 888,
    activeRooms: 77,
    totalMatchmakingWaiters: 66,
  }))
  store.record(makeRunningSnapshot({
    sampledAtMs: tInside,
    activeWsConnections: 10,
    uniqueOnlineRealPlayers: 5,
    activeRooms: 2,
    totalMatchmakingWaiters: 1,
  }))

  const result = store.queryHistory('1h')
  const pm = result.peakMoments

  assertEqual(pm.wsConns.value, 10, 'wsConns.value е от записа в прозореца (10), не от 999')
  assertEqual(pm.wsConns.sampledAt, tInside, 'wsConns.sampledAt = tInside')
  assertEqual(pm.onlinePlayers.value, 5, 'onlinePlayers.value = 5, не 888')
  assertEqual(pm.activeRooms.value, 2, 'activeRooms.value = 2, не 77')
  assertEqual(pm.mmWaiters.value, 1, 'mmWaiters.value = 1, не 66')

  store.close()
})

// ─── [15] peakMoments — празна история дава value:0, sampledAt:null ──────────

console.log('\n[15] peakMoments — празна таблица → нулеви стойности, null timestamp')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const result = store.queryHistory('1h')
  const pm = result.peakMoments

  assertEqual(pm.wsConns.value, 0, 'wsConns.value = 0 при празна история')
  assert(pm.wsConns.sampledAt === null, 'wsConns.sampledAt = null при празна история')
  assertEqual(pm.onlinePlayers.value, 0, 'onlinePlayers.value = 0')
  assert(pm.onlinePlayers.sampledAt === null, 'onlinePlayers.sampledAt = null')
  assertEqual(pm.activeRooms.value, 0, 'activeRooms.value = 0')
  assert(pm.activeRooms.sampledAt === null, 'activeRooms.sampledAt = null')
  assertEqual(pm.mmWaiters.value, 0, 'mmWaiters.value = 0')
  assert(pm.mmWaiters.sampledAt === null, 'mmWaiters.sampledAt = null')

  store.close()
})

// ─── [16] peakMoments.value съответства на peaks ──────────────────────────────

console.log('\n[16] peakMoments.value съвпада с peaks за activity метрики')
await withTempDb(async (dbPath) => {
  const store = await createMonitoringHistoryStore(dbPath)
  const nowMs = Date.now()

  store.record(makeRunningSnapshot({
    sampledAtMs: nowMs - 20 * 60 * 1000,
    activeWsConnections: 77,
    uniqueOnlineRealPlayers: 55,
    activeRooms: 13,
    totalMatchmakingWaiters: 9,
  }))
  store.record(makeRunningSnapshot({
    sampledAtMs: nowMs - 10 * 60 * 1000,
    activeWsConnections: 40,
    uniqueOnlineRealPlayers: 30,
    activeRooms: 8,
    totalMatchmakingWaiters: 3,
  }))

  const result = store.queryHistory('1h')
  const { peaks, peakMoments: pm } = result

  assertEqual(pm.wsConns.value, peaks.wsConns, 'wsConns: peakMoments.value === peaks.wsConns')
  assertEqual(pm.onlinePlayers.value, peaks.onlinePlayers, 'onlinePlayers: peakMoments.value === peaks.onlinePlayers')
  assertEqual(pm.activeRooms.value, peaks.activeRooms, 'activeRooms: peakMoments.value === peaks.activeRooms')
  assertEqual(pm.mmWaiters.value, peaks.mmWaiters, 'mmWaiters: peakMoments.value === peaks.mmWaiters')

  store.close()
})

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
