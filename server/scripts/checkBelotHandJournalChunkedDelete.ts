/**
 * checkBelotHandJournalChunkedDelete.ts
 *
 * Изтриване на порции в belot hand журнала + maintenance instrumentation:
 *  [1]  deleteDayRange на порции ≡ единичен DELETE (същите оцелели редове)
 *  [2]  дупки в id диапазона; брой порции следва реалните редове
 *  [3]  редове от други дни, вплетени в id диапазона, не се засягат
 *  [4]  нови редове между порциите (вкл. на същия ден) не се засягат; няма
 *       отворена write транзакция по време на паузата
 *  [5]  нито една порция не трие повече от chunkRows
 *  [6]  истински event-loop yield между порциите (setImmediate/таймери минават)
 *  [7]  deleteDayIds: последователни и непоследователни id-та, липсващи id-та
 *  [8]  deleteDaysBefore / deleteDay / deleteScoredHandsBefore
 *  [9]  затворен store по средата → грешка, частично изтриване, без загуба
 *  [10] срив след N порции → архивът е траен преди първата порция;
 *       следващият reconcile довършва САМО архивираните id-та; без дубликати/загуба
 *  [11] report: точни бройки, deleteChunks/maxDeleteChunkMs/reclaimFreedPages/WAL
 *  [12] bounded timing labels + sync/async routing; всички изисквани label-и
 *  [13] хвърлящ timing hook не чупи поддръжката
 */

import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBelotHandJournalStore,
  getBelotHandJournalArchiveDirectory,
  toUtcDay,
  type BelotHandJournalStore,
  type BelotHandJournalStoredEvent,
} from '../src/diagnostics/belotHandJournal/belotHandJournalStore.js'
import {
  BELOT_HAND_JOURNAL_SCHEMA,
  BELOT_HAND_JOURNAL_SCHEMA_VERSION,
  type BelotHandJournalEvent,
} from '../src/diagnostics/belotHandJournal/belotHandJournalTypes.js'
import {
  BELOT_HAND_JOURNAL_TIMING_LABELS,
  isBelotHandJournalAsyncTimingLabel,
} from '../src/diagnostics/belotHandJournal/belotHandJournalTimingLabels.js'
import { loadBelotHandJournalEvents } from '../src/diagnostics/belotHandJournal/loadBelotHandJournalEvents.js'
import {
  runBelotHandJournalMaintenance,
  type BelotHandJournalMaintenanceDeps,
  type BelotHandJournalStorageConfig,
} from '../src/diagnostics/belotHandJournal/runBelotHandJournalMaintenance.js'
import { createBelotHandJournal } from '../src/diagnostics/belotHandJournal/createBelotHandJournal.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

console.log('\n═══ checkBelotHandJournalChunkedDelete ═══')

const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)
const GB = 1024 * 1024 * 1024
const FREE_OK: BelotHandJournalMaintenanceDeps['statfs'] = async () => ({ freeBytes: 100 * GB })

function config(overrides: Partial<BelotHandJournalStorageConfig> = {}): BelotHandJournalStorageConfig {
  return {
    activeDays: 7,
    maxAgeDays: 30,
    zstdLevel: 3,
    maxTotalBytes: 1.5 * GB,
    warnRatio: 0.8,
    startCleanupRatio: 0.95,
    targetRatio: 0.9,
    minFreeDiskBytes: 1024 * 1024 * 1024,
    ...overrides,
  }
}

const tempDirs: string[] = []
async function tempStore(): Promise<{ dir: string; store: BelotHandJournalStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'bhj-chunked-'))
  tempDirs.push(dir)
  return { dir, store: await createBelotHandJournalStore({ directory: dir }) }
}

let eventCounter = 0
function event(occurredAtMs: number, overrides: Partial<BelotHandJournalEvent> = {}): BelotHandJournalEvent {
  eventCounter += 1
  return {
    schema: BELOT_HAND_JOURNAL_SCHEMA,
    schemaVersion: BELOT_HAND_JOURNAL_SCHEMA_VERSION,
    eventType: 'card_played',
    severity: 'info',
    occurredAtMs,
    occurredAt: new Date(occurredAtMs).toISOString(),
    roomId: `room-${eventCounter % 7}`,
    matchId: `match-${eventCounter % 11}`,
    handId: `hand-${eventCounter}`,
    payload: { n: eventCounter, filler: 'x'.repeat(200) },
    ...overrides,
  } as BelotHandJournalEvent
}

function dayMs(offsetDays: number, hour = 8): number {
  const day = new Date(NOW - offsetDays * DAY)
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0)
}

// count реда на ден offset (в една транзакция на всеки 500).
function seedDay(store: BelotHandJournalStore, offsetDays: number, count: number): void {
  const start = dayMs(offsetDays)
  for (let offset = 0; offset < count; offset += 500) {
    const batch: BelotHandJournalEvent[] = []
    for (let index = offset; index < Math.min(count, offset + 500); index += 1) batch.push(event(start + index))
    store.insertEvents(batch)
  }
}

function allIds(store: BelotHandJournalStore): number[] {
  return store.queryEvents({}).map((item) => item.id)
}

function idsOfDay(store: BelotHandJournalStore, day: string): number[] {
  return store.queryEvents({}).filter((item) => toUtcDay(item.occurredAtMs) === day).map((item) => item.id)
}

function serialize(events: readonly BelotHandJournalStoredEvent[]): string {
  return JSON.stringify([...events].sort((a, b) => a.id - b.id))
}

async function loadAll(dir: string) {
  return loadBelotHandJournalEvents({ directory: dir, query: { sinceMs: 0 }, includeArchives: true })
}

// ─── [1] ─────────────────────────────────────────────────────────────────────
await check('[1] deleteDayRange на порции ≡ единичен DELETE (същите оцелели редове)', async () => {
  const chunked = await tempStore()
  const reference = await tempStore()
  for (const target of [chunked.store, reference.store]) {
    eventCounter = 0
    seedDay(target, 3, 120)
    seedDay(target, 2, 257)
    seedDay(target, 1, 90)
  }
  const day = toUtcDay(dayMs(2))
  const stats = chunked.store.getDayStats(day)!
  // Под-диапазон (не целия ден) — и границите се спазват.
  const minId = stats.minId + 5
  const maxId = stats.maxId - 9
  const result = await chunked.store.deleteDayRange(day, minId, maxId, { chunkRows: 17 })
  const sqlite = await import('node:sqlite')
  reference.store.close()
  const db = new sqlite.DatabaseSync(join(reference.dir, 'belot-hand-journal.sqlite'))
  const expectedDeleted = Number(db.prepare('DELETE FROM belot_hand_journal_events WHERE day = ? AND id BETWEEN ? AND ?').run(day, minId, maxId).changes)
  const expectedIds = (db.prepare('SELECT id FROM belot_hand_journal_events ORDER BY id').all() as { id: number }[]).map((row) => row.id)
  db.close()
  assert(result.deletedRows === expectedDeleted && expectedDeleted === maxId - minId + 1, `${result.deletedRows} vs ${expectedDeleted}`)
  assert(result.chunks === Math.ceil(expectedDeleted / 17), `chunks ${result.chunks}`)
  assert(JSON.stringify(allIds(chunked.store)) === JSON.stringify(expectedIds), 'surviving ids identical to single DELETE')
  chunked.store.close()
})

// ─── [2] ─────────────────────────────────────────────────────────────────────
await check('[2] дупки в id диапазона → всичко на деня изтрито; порциите следват реалните редове', async () => {
  const { store } = await tempStore()
  seedDay(store, 2, 200)
  const day = toUtcDay(dayMs(2))
  const stats = store.getDayStats(day)!
  // Голяма дупка + разпръснати дупки.
  const holes = [...Array.from({ length: 80 }, (_, i) => stats.minId + 50 + i), stats.minId + 3, stats.minId + 7, stats.maxId - 1]
  await store.deleteDayIds(day, holes)
  const remaining = store.getDayStats(day)!.count
  const result = await store.deleteDayRange(day, stats.minId, stats.maxId, { chunkRows: 25 })
  assert(result.deletedRows === remaining, `${result.deletedRows} vs ${remaining}`)
  assert(result.chunks === Math.ceil(remaining / 25), `chunks ${result.chunks} for ${remaining} rows`)
  assert(store.getDayStats(day) === null, 'day empty')
  store.close()
})

// ─── [3] ─────────────────────────────────────────────────────────────────────
await check('[3] редове от други дни, вплетени в id диапазона, не се засягат', async () => {
  const { store } = await tempStore()
  // Редуващи се дни в едни и същи batch-ове → id-тата на двата дни се преплитат.
  for (let batch = 0; batch < 10; batch += 1) {
    const events: BelotHandJournalEvent[] = []
    for (let index = 0; index < 30; index += 1) events.push(event(index % 3 === 0 ? dayMs(4) + batch * 100 + index : dayMs(3) + batch * 100 + index))
    store.insertEvents(events)
  }
  const target = toUtcDay(dayMs(3))
  const other = toUtcDay(dayMs(4))
  const otherBefore = idsOfDay(store, other)
  const stats = store.getDayStats(target)!
  assert(otherBefore.some((id) => id > stats.minId && id < stats.maxId), 'fixture interleaves ids')
  const result = await store.deleteDayRange(target, stats.minId, stats.maxId, { chunkRows: 13 })
  assert(result.deletedRows === stats.count, `${result.deletedRows} vs ${stats.count}`)
  assert(JSON.stringify(idsOfDay(store, other)) === JSON.stringify(otherBefore), 'other day untouched')
  assert(store.getDayStats(target) === null, 'target day empty')
  store.close()
})

// ─── [4] ─────────────────────────────────────────────────────────────────────
await check('[4] нови редове между порциите (вкл. същия ден) не се засягат; няма отворена транзакция по време на паузата', async () => {
  const { store } = await tempStore()
  seedDay(store, 2, 150)
  const day = toUtcDay(dayMs(2))
  const stats = store.getDayStats(day)!
  const insertedIds: number[] = []
  const result = await store.deleteDayRange(day, stats.minId, stats.maxId, {
    chunkRows: 20,
    yieldControl: async () => {
      // insertEvents ползва BEGIN IMMEDIATE — би хвърлил при вложена транзакция.
      store.insertEvents([event(dayMs(2, 23)), event(dayMs(0))])
      const latest = store.queryEvents({}).slice(-2).map((item) => item.id)
      insertedIds.push(...latest)
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    },
  })
  assert(result.deletedRows === stats.count, `${result.deletedRows} vs ${stats.count}`)
  const survivors = new Set(allIds(store))
  assert(insertedIds.length === result.chunks * 2, `inserted ${insertedIds.length}`)
  assert(insertedIds.every((id) => survivors.has(id)), 'all rows written between chunks survive (same day too)')
  assert(store.getDayStats(day)!.count === result.chunks, 'only the new same-day rows remain on that day')
  store.close()
})

// ─── [5] ─────────────────────────────────────────────────────────────────────
await check('[5] нито една порция не трие повече от chunkRows (range, ids, day, scored hands)', async () => {
  const { store } = await tempStore()
  seedDay(store, 3, 333)
  seedDay(store, 2, 101)
  const chunkRows = 32
  const perChunk: number[] = []
  let previous = store.queryEvents({}).length
  const trackYield = async () => {
    const current = store.queryEvents({}).length
    perChunk.push(previous - current)
    previous = current
  }
  const day3 = toUtcDay(dayMs(3))
  const stats = store.getDayStats(day3)!
  await store.deleteDayRange(day3, stats.minId, stats.maxId, { chunkRows, yieldControl: trackYield })
  await store.deleteDay(toUtcDay(dayMs(2)), { chunkRows, yieldControl: trackYield })
  assert(perChunk.length > 0 && perChunk.every((count) => count > 0 && count <= chunkRows), perChunk.join(','))
  assert(perChunk.reduce((sum, count) => sum + count, 0) === 434, 'all rows deleted')
  // deleteDayIds
  seedDay(store, 1, 100)
  const ids = idsOfDay(store, toUtcDay(dayMs(1)))
  perChunk.length = 0
  previous = store.queryEvents({}).length
  await store.deleteDayIds(toUtcDay(dayMs(1)), ids, { chunkRows, yieldControl: trackYield })
  assert(perChunk.every((count) => count <= chunkRows) && perChunk.reduce((s, c) => s + c, 0) === 100, perChunk.join(','))
  store.close()
})

// ─── [6] ─────────────────────────────────────────────────────────────────────
await check('[6] истински event-loop yield между порциите (setImmediate и таймер минават)', async () => {
  const { store } = await tempStore()
  seedDay(store, 2, 200)
  const day = toUtcDay(dayMs(2))
  const stats = store.getDayStats(day)!
  let immediateTicks = 0
  let timerTicks = 0
  let running = true
  const spinImmediate = () => {
    if (!running) return
    immediateTicks += 1
    setImmediate(spinImmediate)
  }
  setImmediate(spinImmediate)
  const timer = setInterval(() => {
    timerTicks += 1
  }, 0)
  const ticksAtChunk: number[] = []
  const result = await store.deleteDayRange(day, stats.minId, stats.maxId, {
    chunkRows: 10,
    afterChunk: () => ticksAtChunk.push(immediateTicks),
  })
  running = false
  clearInterval(timer)
  assert(result.chunks === 20, `chunks ${result.chunks}`)
  const strictlyIncreasing = ticksAtChunk.every((value, index) => index === 0 || value > ticksAtChunk[index - 1]!)
  assert(strictlyIncreasing, `other immediates ran between every pair of chunks: ${ticksAtChunk.join(',')}`)
  assert(timerTicks > 0, 'timers phase ran during the chunked delete')
  store.close()
})

// ─── [7] ─────────────────────────────────────────────────────────────────────
await check('[7] deleteDayIds: последователни, непоследователни и липсващи id-та', async () => {
  const { store } = await tempStore()
  seedDay(store, 2, 120)
  seedDay(store, 1, 10)
  const day = toUtcDay(dayMs(2))
  const ids = idsOfDay(store, day)
  const contiguous = ids.slice(0, 40)
  const nonContiguous = ids.slice(40).filter((_, index) => index % 3 === 0)
  const missing = [ids[0]!, ids[1]!, 999999, 1000000, -5]
  const otherDayIds = idsOfDay(store, toUtcDay(dayMs(1)))
  const first = await store.deleteDayIds(day, contiguous, { chunkRows: 15 })
  assert(first.deletedRows === 40 && first.chunks === 3, JSON.stringify(first))
  const second = await store.deleteDayIds(day, nonContiguous, { chunkRows: 7 })
  assert(second.deletedRows === nonContiguous.length, JSON.stringify(second))
  // Липсващи/вече изтрити id-та и id-та на ДРУГ ден (с грешния day) → 0.
  const third = await store.deleteDayIds(day, [...missing, ...otherDayIds], { chunkRows: 4 })
  assert(third.deletedRows === 0, JSON.stringify(third))
  const expected = ids.slice(40).filter((_, index) => index % 3 !== 0)
  assert(JSON.stringify(idsOfDay(store, day)) === JSON.stringify(expected), 'exact survivors')
  assert(idsOfDay(store, toUtcDay(dayMs(1))).length === 10, 'other day untouched')
  const empty = await store.deleteDayIds(day, [])
  assert(empty.deletedRows === 0 && empty.chunks === 0, 'empty list is a no-op')
  store.close()
})

// ─── [8] ─────────────────────────────────────────────────────────────────────
await check('[8] deleteDaysBefore / deleteDay / deleteScoredHandsBefore на порции', async () => {
  const { store } = await tempStore()
  seedDay(store, 40, 75)
  seedDay(store, 35, 60)
  seedDay(store, 31, 5)
  seedDay(store, 20, 50)
  const cutoff = toUtcDay(NOW - 30 * DAY)
  const before = await store.deleteDaysBefore(cutoff, { chunkRows: 16 })
  assert(before.deletedRows === 140, `deleted ${before.deletedRows}`)
  assert(before.days.length === 3 && before.days.every((day) => day < cutoff), before.days.join(','))
  assert(before.chunks === Math.ceil(75 / 16) + Math.ceil(60 / 16) + Math.ceil(5 / 16), `chunks ${before.chunks}`)
  assert(store.listDays().length === 1 && store.getDayStats(toUtcDay(dayMs(20)))!.count === 50, 'newer day kept')
  const none = await store.deleteDaysBefore(cutoff)
  assert(none.deletedRows === 0 && none.days.length === 0, 'idempotent')
  const dayResult = await store.deleteDay(toUtcDay(dayMs(20)), { chunkRows: 9 })
  assert(dayResult.deletedRows === 50 && dayResult.chunks === 6, JSON.stringify(dayResult))
  assert((await store.deleteDay('2020-01-01')).deletedRows === 0, 'missing day is a no-op')
  // Scored hands: само hand_scored записите създават редове в scored_hands.
  const scored = (offsetDays: number, count: number) => {
    const events: BelotHandJournalEvent[] = []
    for (let index = 0; index < count; index += 1) {
      events.push(event(dayMs(offsetDays) + index, { eventType: 'hand_scored', handId: `scored-${offsetDays}-${index}` }))
    }
    store.insertEvents(events)
  }
  scored(40, 47)
  scored(5, 12)
  const scoredResult = await store.deleteScoredHandsBefore(NOW - 30 * DAY, { chunkRows: 10 })
  assert(scoredResult.deletedRows === 47 && scoredResult.chunks === 5, JSON.stringify(scoredResult))
  const again = await store.deleteScoredHandsBefore(NOW - 30 * DAY, { chunkRows: 10 })
  assert(again.deletedRows === 0, 'scored hands idempotent')
  // Новите scored hands остават (дубликат на hand_scored се засича).
  const dup = store.insertEvents([event(dayMs(5) + 1, { eventType: 'hand_scored', handId: 'scored-5-1' })], (item) => ({ ...item, eventType: 'anomaly' }))
  assert(dup.duplicates.length === 1, 'recent scored hands kept (duplicate detected)')
  store.close()
})

// ─── [9] ─────────────────────────────────────────────────────────────────────
await check('[9] затворен store по средата на изтриването → грешка, частично изтриване, без отворена транзакция', async () => {
  const { dir, store } = await tempStore()
  seedDay(store, 2, 100)
  const day = toUtcDay(dayMs(2))
  const stats = store.getDayStats(day)!
  let chunksSeen = 0
  let committed = 0
  let error: unknown = null
  try {
    await store.deleteDayRange(day, stats.minId, stats.maxId, {
      chunkRows: 10,
      onChunkCommitted: () => {
        committed += 1
        // хвърлящ monitoring callback не бива да спира изтриването
        throw new Error('monitoring callback broken')
      },
      afterChunk: (done) => {
        chunksSeen = done
      },
      yieldControl: async () => {
        if (chunksSeen === 3) store.close()
      },
    })
  } catch (caught) {
    error = caught
  }
  assert(error instanceof Error && /closed/.test(error.message), String(error))
  assert(committed === 3, `onChunkCommitted saw every committed chunk before the failure (${committed})`)
  const reopened = await createBelotHandJournalStore({ directory: dir })
  assert(reopened.getDayStats(day)!.count === 70, `remaining ${reopened.getDayStats(day)?.count}`)
  reopened.close()
})

// ─── [10] ────────────────────────────────────────────────────────────────────
await check('[10] срив след N порции: архивът е траен преди първата порция; reconcile довършва само архивираните id-та', async () => {
  const { dir, store } = await tempStore()
  seedDay(store, 9, 260)
  seedDay(store, 2, 40)
  const day = toUtcDay(dayMs(9))
  const before = serialize((await loadAll(dir)).events)
  let archiveStateAtFirstChunk: { finals: string[]; tmps: string[] } | null = null
  const archiveDir = getBelotHandJournalArchiveDirectory(dir)
  const onTiming = (label: string) => {
    if (label === BELOT_HAND_JOURNAL_TIMING_LABELS.deleteDayChunk && archiveStateAtFirstChunk === null) {
      const names = existsSync(archiveDir) ? readdirSync(archiveDir) : []
      archiveStateAtFirstChunk = {
        finals: names.filter((name) => name.endsWith('.jsonl.zst') || name.endsWith('.jsonl.gz')),
        tmps: names.filter((name) => name.endsWith('.tmp')),
      }
    }
  }
  const crashed = await runBelotHandJournalMaintenance(store, config(), NOW, {
    statfs: FREE_OK,
    deleteChunkRows: 50,
    onTiming,
    hooks: { failDeleteAfterChunks: 2 },
  })
  const firstChunkState = archiveStateAtFirstChunk as { finals: string[]; tmps: string[] } | null
  assert(firstChunkState !== null && firstChunkState.finals.some((name) => name.includes(day)) && firstChunkState.tmps.length === 0, `archive finalized before first chunk: ${JSON.stringify(firstChunkState)}`)
  assert(crashed.warnings.some((w) => w.kind === 'archive_delete_incomplete'), crashed.warnings.map((w) => w.kind).join(','))
  assert(!crashed.warnings.some((w) => w.kind === 'archive_failed'), 'not reported as archive failure (archive is durable)')
  assert(crashed.archived.length === 0, 'incomplete day not reported as archived')
  // Monitoring броячите включват вече commit-натите порции въпреки прекъсването.
  assert(crashed.deleteChunks === 2, `deleteChunks counts committed chunks of the interrupted delete (${crashed.deleteChunks})`)
  assert(crashed.maxDeleteChunkMs > 0, 'maxDeleteChunkMs measured for the interrupted delete')
  assert(store.getDayStats(day)!.count === 160, `remaining after 2 chunks: ${store.getDayStats(day)?.count}`)
  const mid = await loadAll(dir)
  assert(serialize(mid.events) === before && mid.duplicatesSkipped === 160, `reader de-duplicates (${mid.duplicatesSkipped})`)
  // Нов (късен) ред на същия ден след срива — НЕ е в архива и не бива да се губи.
  store.insertEvents([event(dayMs(9, 22))])
  const lateId = store.queryEvents({}).at(-1)!.id
  const report = await runBelotHandJournalMaintenance(store, config(), NOW, { statfs: FREE_OK, deleteChunkRows: 50 })
  assert(report.status === 'completed', report.status)
  assert(report.reconciledRows === 160, `reconciled ${report.reconciledRows}`)
  assert(report.warnings.some((w) => w.kind === 'interrupted_archive_reconciled'), 'reconcile warning')
  const after = await loadAll(dir)
  const lateCopies = after.events.filter((item) => item.id === lateId)
  assert(lateCopies.length === 1, `late row present exactly once (${lateCopies.length})`)
  const afterWithoutLate = after.events.filter((item) => item.id !== lateId)
  assert(serialize(afterWithoutLate) === before, 'nothing lost')
  assert(after.duplicatesSkipped === 0, `no duplicates left (${after.duplicatesSkipped})`)
  store.close()
})

// ─── [11] ────────────────────────────────────────────────────────────────────
await check('[11] report: точни бройки на редове и monitoring полетата', async () => {
  const { store } = await tempStore()
  seedDay(store, 10, 210)
  seedDay(store, 9, 95)
  seedDay(store, 40, 33)
  seedDay(store, 1, 20)
  const report = await runBelotHandJournalMaintenance(store, config(), NOW, { statfs: FREE_OK, deleteChunkRows: 40 })
  assert(report.status === 'completed', report.status)
  const rows = Object.fromEntries(report.archived.map((item) => [item.day, item.rows]))
  assert(rows[toUtcDay(dayMs(10))] === 210 && rows[toUtcDay(dayMs(9))] === 95, JSON.stringify(rows))
  assert(report.expiredActiveRows === 33, `expired ${report.expiredActiveRows}`)
  assert(report.deleteChunks === Math.ceil(210 / 40) + Math.ceil(95 / 40) + Math.ceil(33 / 40), `chunks ${report.deleteChunks}`)
  assert(report.maxDeleteChunkMs > 0, 'maxDeleteChunkMs measured')
  assert(typeof report.walBytesBefore === 'number' && typeof report.walBytesAfter === 'number', 'wal bytes measured')
  assert(report.reclaimFreedPages >= 0, 'reclaimFreedPages')
  assert(store.listDays().length === 1, 'only the active day remains')
  store.close()
})

// ─── [12] ────────────────────────────────────────────────────────────────────
await check('[12] bounded timing labels + sync/async routing; всички изисквани label-и', async () => {
  const { store } = await tempStore()
  seedDay(store, 9, 1200)
  const labels = new Map<string, number>()
  const report = await runBelotHandJournalMaintenance(store, config(), NOW, {
    statfs: FREE_OK,
    deleteChunkRows: 100,
    onTiming: (label, ms) => {
      labels.set(label, (labels.get(label) ?? 0) + 1)
      assert(Number.isFinite(ms) && ms >= 0, `duration ${ms}`)
    },
  })
  assert(report.status === 'completed' && report.archived.length === 1, report.status)
  const known = new Set<string>(Object.values(BELOT_HAND_JOURNAL_TIMING_LABELS))
  const unknown = [...labels.keys()].filter((label) => !known.has(label))
  assert(unknown.length === 0, `unknown labels: ${unknown.join(',')}`)
  assert([...labels.keys()].every((label) => /^[A-Za-z.]{1,64}$/.test(label)), 'no digits/day/id in labels')
  const required = [
    'maintenance.deleteDayChunk', 'reclaim.freelistRead', 'reclaim.checkpoint', 'archive.pageRead', 'archive.pageEncode',
    'archive.compress', 'archive.verify', 'archive.fileSync', 'archive.directorySync', 'maintenance.reclaim.pre',
    'maintenance.reclaim.final',
  ]
  const missing = required.filter((label) => !labels.has(label))
  assert(missing.length === 0, `missing labels: ${missing.join(',')}`)
  assert(labels.get('maintenance.deleteDayChunk') === 12, `chunk label count ${labels.get('maintenance.deleteDayChunk')}`)
  assert(labels.get('archive.pageRead')! >= 3, 'one pageRead per 500-row page (+ final empty read)')
  // vacuumStep се появява само при freelist > 0 — след изтриването reclaim го има.
  assert(labels.has('reclaim.vacuumStep'), 'vacuum steps measured after delete')
  const asyncLabels = ['storageCheck', 'maintenance', 'archive.compress', 'archive.verify', 'archive.fileSync', 'archive.directorySync', 'maintenance.reclaim.pre', 'maintenance.reclaim.post', 'maintenance.reclaim.final']
  const syncLabels = ['maintenance.deleteDayChunk', 'maintenance.deleteDayIdsChunk', 'maintenance.deleteScoredHandsChunk', 'reclaim.freelistRead', 'reclaim.vacuumStep', 'reclaim.checkpoint', 'archive.pageRead', 'archive.pageEncode', 'flush', 'maintenance.listDays']
  assert(asyncLabels.every(isBelotHandJournalAsyncTimingLabel), 'async labels → journalAsync')
  assert(syncLabels.every((label) => !isBelotHandJournalAsyncTimingLabel(label)), 'sync labels → journal')
  store.close()

  // Size-limit път: 'pre' преди архивирането, 'post' след него.
  const sized = await tempStore()
  seedDay(sized.store, 3, 1200)
  seedDay(sized.store, 0, 10)
  const usage = (await (await import('../src/diagnostics/belotHandJournal/runBelotHandJournalMaintenance.js')).measureBelotHandJournalStorage(sized.store)).totalBytes
  const order: string[] = []
  const sizedReport = await runBelotHandJournalMaintenance(sized.store, config({ maxTotalBytes: usage / 0.96 }), NOW, {
    statfs: FREE_OK,
    onTiming: (label) => {
      if (label.startsWith('maintenance.reclaim.') || label === 'archive.compress') order.push(label)
    },
  })
  assert(sizedReport.archived.some((item) => item.reason === 'size_limit' && item.day === toUtcDay(dayMs(3))), JSON.stringify(sizedReport.archived))
  const compressAt = order.indexOf('archive.compress')
  assert(order.indexOf('maintenance.reclaim.pre') === 0 && compressAt > 0, `pre before archive: ${order.join(',')}`)
  assert(order.indexOf('maintenance.reclaim.post') > compressAt, `post after archive: ${order.join(',')}`)
  assert(order.at(-1) === 'maintenance.reclaim.final', `final last: ${order.join(',')}`)
  sized.store.close()
})

// ─── [13] ────────────────────────────────────────────────────────────────────
await check('[13] хвърлящ timing hook не чупи поддръжката (и през createBelotHandJournal)', async () => {
  const { dir, store } = await tempStore()
  seedDay(store, 9, 300)
  const before = serialize((await loadAll(dir)).events)
  let calls = 0
  const report = await runBelotHandJournalMaintenance(store, config(), NOW, {
    statfs: FREE_OK,
    deleteChunkRows: 64,
    onTiming: () => {
      calls += 1
      throw new Error('timing hook broken')
    },
  })
  assert(report.status === 'completed' && report.archived.length === 1 && report.archived[0]!.rows === 300, JSON.stringify(report.warnings))
  assert(calls > 10, `hook was invoked (${calls})`)
  const after = await loadAll(dir)
  assert(serialize(after.events) === before && after.duplicatesSkipped === 0, 'archive intact')
  store.close()

  const second = await tempStore()
  seedDay(second.store, 9, 120)
  const journal = createBelotHandJournal({
    store: second.store,
    now: () => NOW,
    scheduleFlush: (flush) => flush(),
    statfs: FREE_OK,
    storage: config(),
    onTiming: () => {
      throw new Error('timing hook broken')
    },
  })
  const journalReport = await journal.runMaintenanceNow()
  assert(journalReport !== null && journalReport.status === 'completed' && journalReport.archived.length === 1, JSON.stringify(journalReport?.warnings))
  journal.close()
})

for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
console.log(`\n  passed=${passed} failed=${failed}`)
if (failed > 0) process.exit(1)
