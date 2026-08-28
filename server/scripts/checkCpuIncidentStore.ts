import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createCpuIncidentStore } from '../src/monitoring/cpuIncidentStore.js'
import { emptyForensicBucket } from '../src/monitoring/cpuIncidentDetector.js'
import type { ClosedIncident } from '../src/monitoring/cpuIncidentDetector.js'
import { emptyActivityCountersSnapshot } from '../src/monitoring/activityCounters.js'
import type { ForensicBucket } from '../src/monitoring/cpuIncidentTypes.js'
import { CPU_INCIDENT_THRESHOLDS } from '../src/monitoring/cpuIncidentTypes.js'

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

const migrationPath = fileURLToPath(
  new URL('../database/migrations/20260828_001_create_monitoring_cpu_incidents.sql', import.meta.url),
)

async function withTempDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-cpu-incident-store-check-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    const sql = await readFile(migrationPath, 'utf8')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec(sql)
    db.close()
    await fn(dbPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function makeBucket(bucketStartMs: number, cpu: number, overrides: Partial<ForensicBucket> = {}): ForensicBucket {
  const b = emptyForensicBucket(bucketStartMs)
  return { ...b, processCpuAvg: cpu, processCpuMax: cpu, ...overrides }
}

function makeIncident(overrides: Partial<ClosedIncident> = {}): ClosedIncident {
  return {
    detectionType: 'sustained_high',
    startedAtMs: 100_000,
    endedAtMs: 160_000,
    rawSpikeSamples: [],
    preBuffer: [makeBucket(80_000, 45), makeBucket(90_000, 48)],
    duringBuckets: [makeBucket(100_000, 92), makeBucket(110_000, 95), makeBucket(120_000, 93)],
    postBuffer: [makeBucket(130_000, 50), makeBucket(140_000, 48)],
    ...overrides,
  }
}

console.log('\n[1] persistIncident + listIncidents — basic insert round-trip')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  store.persistIncident(makeIncident())
  const list = store.listIncidents(50)
  assertEqual(list.length, 1, 'exactly one incident persisted')
  assertEqual(list[0]?.detectionType, 'sustained_high', 'detectionType round-trips')
  assertEqual(list[0]?.startedAtMs, 100_000, 'startedAtMs round-trips')
  assertEqual(list[0]?.endedAtMs, 160_000, 'endedAtMs round-trips')
  assert((list[0]?.processCpuMax ?? 0) >= 92, 'processCpuMax reflects duringBuckets max')
  store.close()
})

console.log('\n[2] persistIncident — activity rates computed correctly')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  const activity1 = { ...emptyActivityCountersSnapshot(), lobbyChatMessages: 10, gameplayBidAccepted: 5 }
  const activity2 = { ...emptyActivityCountersSnapshot(), lobbyChatMessages: 10, gameplayPlayAccepted: 5 }
  const incident = makeIncident({
    startedAtMs: 0,
    endedAtMs: 60_000, // exactly 1 minute duration
    duringBuckets: [
      makeBucket(0, 92, { activity: activity1 }),
      makeBucket(10_000, 93, { activity: activity2 }),
    ],
  })
  store.persistIncident(incident)
  const list = store.listIncidents(50)
  // Total lobby chat = 20 over 1 minute => 20/min
  assert(Math.abs((list[0]?.activityRates.lobbyChatPerMin ?? 0) - 20) < 0.01, 'lobbyChatPerMin computed correctly (20 msgs / 1 min)')
  // Total gameplay = 5 (bid) + 5 (play) = 10 over 1 minute => 10/min
  assert(Math.abs((list[0]?.activityRates.gameplayPerMin ?? 0) - 10) < 0.01, 'gameplayPerMin sums bid+cut+play correctly')
  store.close()
})

console.log('\n[3] getIncidentDetail — returns summary + full timeline')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  store.persistIncident(makeIncident())
  const list = store.listIncidents(50)
  const id = list[0]!.id
  const detail = store.getIncidentDetail(id)
  assert(detail !== null, 'detail found for a persisted incident id')
  assertEqual(detail?.summary.id, id, 'detail summary matches the requested id')
  // preBuffer(2) + duringBuckets(3) + postBuffer(2) = 7 timeline samples
  assertEqual(detail?.timeline.length, 7, 'timeline includes pre+during+post buckets')
  store.close()
})

console.log('\n[4] getIncidentDetail — unknown id returns null (no throw)')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  const detail = store.getIncidentDetail(999_999)
  assertEqual(detail, null, 'unknown incident id returns null, not a throw')
  store.close()
})

console.log('\n[5] Extreme spike incident with no bucket data — raw 1s samples become the timeline')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  const incident = makeIncident({
    detectionType: 'extreme_spike',
    startedAtMs: 5000,
    endedAtMs: 5000,
    rawSpikeSamples: [{ sampledAtMs: 5000, processCpuPercent: 105.9 }],
    duringBuckets: [],
    preBuffer: [],
    postBuffer: [],
  })
  store.persistIncident(incident)
  const list = store.listIncidents(50)
  const detail = store.getIncidentDetail(list[0]!.id)
  assertEqual(detail?.timeline.length, 1, 'raw spike sample becomes exactly one timeline entry')
  assertEqual(detail?.timeline[0]?.sampleResolutionMs, 1000, 'timeline entry carries 1s resolution, not 10s')
  assertEqual(detail?.timeline[0]?.processCpu, 105.9, 'raw CPU value preserved exactly')
  store.close()
})

console.log('\n[6] Sustained-family merge at persistence — short gap between two sustained incidents merges into one row')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  const first = makeIncident({
    detectionType: 'sustained_high',
    startedAtMs: 0,
    endedAtMs: 60_000,
  })
  store.persistIncident(first)
  const afterFirst = store.listIncidents(50)
  assertEqual(afterFirst.length, 1, 'one row after first incident')

  // Second incident starts well within sustainedMergeGapMs (30s) of the first's end.
  const gapMs = CPU_INCIDENT_THRESHOLDS.sustainedMergeGapMs - 5000
  const second = makeIncident({
    detectionType: 'sustained_high',
    startedAtMs: 60_000 + gapMs,
    endedAtMs: 60_000 + gapMs + 60_000,
  })
  store.persistIncident(second)
  const afterSecond = store.listIncidents(50)
  assertEqual(afterSecond.length, 1, 'still one row — the second incident merged into the first, not a new row')
  assertEqual(afterSecond[0]?.startedAtMs, 0, 'merged row keeps the ORIGINAL startedAtMs')
  assertEqual(afterSecond[0]?.endedAtMs, second.endedAtMs, 'merged row adopts the newer endedAtMs')
  store.close()
})

console.log('\n[7] Sustained-family — long gap does NOT merge, creates a second row')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  const first = makeIncident({ startedAtMs: 0, endedAtMs: 60_000 })
  store.persistIncident(first)

  const gapMs = CPU_INCIDENT_THRESHOLDS.sustainedMergeGapMs + 5000
  const second = makeIncident({ startedAtMs: 60_000 + gapMs, endedAtMs: 60_000 + gapMs + 60_000 })
  store.persistIncident(second)

  const list = store.listIncidents(50)
  assertEqual(list.length, 2, 'two separate rows when the gap exceeds sustainedMergeGapMs')
  store.close()
})

console.log('\n[8] extreme_spike incidents never merge at persistence, even with a short gap')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  const first = makeIncident({
    detectionType: 'extreme_spike',
    startedAtMs: 0,
    endedAtMs: 0,
    duringBuckets: [],
    preBuffer: [],
    postBuffer: [],
    rawSpikeSamples: [{ sampledAtMs: 0, processCpuPercent: 101 }],
  })
  store.persistIncident(first)
  const second = makeIncident({
    detectionType: 'extreme_spike',
    startedAtMs: 1000,
    endedAtMs: 1000,
    duringBuckets: [],
    preBuffer: [],
    postBuffer: [],
    rawSpikeSamples: [{ sampledAtMs: 1000, processCpuPercent: 102 }],
  })
  store.persistIncident(second)
  const list = store.listIncidents(50)
  assertEqual(list.length, 2, 'extreme_spike rows are never merged at the store layer')
  store.close()
})

console.log('\n[9] listIncidents — newest first, respects limit')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  for (let i = 0; i < 5; i++) {
    store.persistIncident(makeIncident({ startedAtMs: i * 200_000, endedAtMs: i * 200_000 + 60_000 }))
  }
  const list = store.listIncidents(3)
  assertEqual(list.length, 3, 'limit is respected')
  assert((list[0]?.startedAtMs ?? 0) > (list[1]?.startedAtMs ?? 0), 'newest incident is first')
  assert((list[1]?.startedAtMs ?? 0) > (list[2]?.startedAtMs ?? 0), 'strictly descending order')
  store.close()
})

console.log('\n[10] listIncidents — bounded limit, never returns an unrestricted huge list')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  for (let i = 0; i < 10; i++) {
    store.persistIncident(makeIncident({ startedAtMs: i * 200_000, endedAtMs: i * 200_000 + 60_000 }))
  }
  const list = store.listIncidents(100_000) // absurdly large requested limit
  assert(list.length <= 200, 'requesting an absurd limit is clamped to a sane maximum')
  store.close()
})

console.log('\n[11] purgeOlderThan — summary and timeline retention are independent')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  const oldIncident = makeIncident({ startedAtMs: 1000, endedAtMs: 61_000 })
  const recentIncident = makeIncident({ startedAtMs: 10_000_000, endedAtMs: 10_060_000 })
  store.persistIncident(oldIncident)
  store.persistIncident(recentIncident)

  // Purge timeline for anything older than 5_000_000 but keep summaries older than only 500.
  store.purgeOlderThan(500, 5_000_000)

  const list = store.listIncidents(50)
  assertEqual(list.length, 2, 'both summary rows survive (summary cutoff=500 is older than both incidents)')

  const oldDetail = store.getIncidentDetail(list.find((i) => i.startedAtMs === 1000)!.id)
  const recentDetail = store.getIncidentDetail(list.find((i) => i.startedAtMs === 10_000_000)!.id)
  assertEqual(oldDetail?.timeline.length, 0, 'old incident timeline purged (older than timeline cutoff)')
  assert((recentDetail?.timeline.length ?? 0) > 0, 'recent incident timeline survives (newer than timeline cutoff)')
  store.close()
})

console.log('\n[12] purgeOlderThan — summary purge removes the whole row (cascades to samples via FK)')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  store.persistIncident(makeIncident({ startedAtMs: 1000, endedAtMs: 61_000 }))
  store.purgeOlderThan(500_000, 500_000)
  const list = store.listIncidents(50)
  assertEqual(list.length, 0, 'old incident summary removed entirely')
  store.close()
})

console.log('\n[13] No content leak — persisted schema carries only numeric/JSON-category aggregates, no raw strings from user content')
await withTempDb(async (dbPath) => {
  const store = await createCpuIncidentStore(dbPath)
  store.persistIncident(makeIncident())
  const raw = new DatabaseSync(dbPath, { open: true })
  const row = raw.prepare('SELECT * FROM monitoring_cpu_incidents LIMIT 1').get() as Record<string, unknown>
  const columnNames = Object.keys(row)
  const forbiddenColumns = ['message_body', 'chat_text', 'username', 'profile_id', 'ip_address', 'raw_url', 'payload']
  for (const forbidden of forbiddenColumns) {
    assert(!columnNames.includes(forbidden), `schema does not have a "${forbidden}" column`)
  }
  raw.close()
  store.close()
})

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
