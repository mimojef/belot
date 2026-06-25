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

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
