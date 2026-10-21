/**
 * benchBelotHandJournalChunkedDelete.ts
 *
 * Benchmark на изтриването на архивиран ден от belot hand журнала върху
 * production-like база: истинската схема от createBelotHandJournalStore
 * (WAL, synchronous=NORMAL, auto_vacuum=INCREMENTAL, journal_size_limit,
 * всички 6 secondary индекса), ~130k реда на ден, payload ≈ 1.3 KB.
 *
 * За всеки размер на порцията (и за стария единичен DELETE като baseline)
 * се ползва СВЕЖО копие на една и съща шаблонна база. Между порциите се
 * симулират нормални journal записи (малък batch), за да се види, че те
 * минават, и се мери размерът на WAL файла.
 *
 * Употреба:
 *   npx tsx scripts/benchBelotHandJournalChunkedDelete.ts [--rows=130000] [--days=3] [--chunks=250,500,1000,2000] [--dir=<tmp>]
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBelotHandJournalStore,
  getBelotHandJournalDatabasePath,
  type BelotHandJournalStore,
} from '../src/diagnostics/belotHandJournal/belotHandJournalStore.js'
import { BELOT_HAND_JOURNAL_TIMING_LABELS } from '../src/diagnostics/belotHandJournal/belotHandJournalTimingLabels.js'
import {
  arg,
  BENCH_DAY_MS as DAY_MS,
  BENCH_FIRST_DAY_MS as FIRST_DAY_MS,
  BENCH_TARGET_DAY_INDEX as TARGET_DAY_INDEX,
  buildBenchEvent as buildEvent,
  freshBenchCopy as freshCopy,
  percentile,
  seedBenchTemplate,
  walFileSize as walSize,
} from './belotHandJournalBenchFixtures.js'

const ROWS_PER_DAY = Number(arg('rows', '130000'))
const DAYS = Number(arg('days', '3'))
const CHUNK_SIZES = arg('chunks', '250,500,1000,2000').split(',').map(Number)
const BASE_DIR = arg('dir', tmpdir())

type RunResult = {
  name: string
  chunks: number
  maxMs: number
  p95Ms: number
  p99Ms: number
  medianMs: number
  over25: number
  over50: number
  totalWallMs: number
  syncTotalMs: number
  peakWalMb: number
  deleted: number
  expected: number
  othersIntact: boolean
  interleavedWritesOk: boolean
  vacuumSteps: number
  vacuumMaxMs: number
  checkpointMs: number
}

async function otherDayCounts(store: BelotHandJournalStore): Promise<string> {
  return store.listDays().map((day) => `${day}:${store.getDayStats(day)?.count ?? 0}`).join(',')
}

async function runChunked(templateDir: string, chunkRows: number | null): Promise<RunResult> {
  const name = chunkRows === null ? 'single' : `chunk-${chunkRows}`
  const dir = await freshCopy(templateDir, name)
  const store = await createBelotHandJournalStore({ directory: dir })
  const targetDay = new Date(FIRST_DAY_MS + TARGET_DAY_INDEX * DAY_MS).toISOString().slice(0, 10)
  const stats = store.getDayStats(targetDay)!
  const othersBefore = (await otherDayCounts(store)).split(',').filter((item) => !item.startsWith(targetDay)).join(',')
  const chunkMs: number[] = []
  let peakWal = walSize(dir)
  let interleavedInserted = 0
  const started = performance.now()
  let deleted = 0
  if (chunkRows === null) {
    // Baseline: старото поведение — един DELETE в една autocommit транзакция.
    const sqlite = await import('node:sqlite')
    store.close()
    const db = new sqlite.DatabaseSync(getBelotHandJournalDatabasePath(dir))
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA journal_size_limit = 67108864;')
    const t0 = performance.now()
    deleted = Number(db.prepare('DELETE FROM belot_hand_journal_events WHERE day = ? AND id BETWEEN ? AND ?').run(targetDay, stats.minId, stats.maxId).changes)
    chunkMs.push(performance.now() - t0)
    peakWal = Math.max(peakWal, walSize(dir))
    db.close()
  } else {
    const result = await store.deleteDayRange(targetDay, stats.minId, stats.maxId, {
      chunkRows,
      onTiming: (label, ms) => {
        if (label === BELOT_HAND_JOURNAL_TIMING_LABELS.deleteDayChunk) chunkMs.push(ms)
      },
      yieldControl: async () => {
        peakWal = Math.max(peakWal, walSize(dir))
        // Нормален journal запис между порциите (нов ред на ДНЕШНИЯ ден).
        const now = FIRST_DAY_MS + (DAYS + 1) * DAY_MS
        store.insertEvents([buildEvent(now, 'room_live', 'match_live', 1), buildEvent(now + 1, 'room_live', 'match_live', 1)])
        interleavedInserted += 2
        await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
      },
    })
    deleted = result.deletedRows
  }
  const totalWallMs = performance.now() - started
  const verifyStore = chunkRows === null ? await createBelotHandJournalStore({ directory: dir }) : store
  const othersAfter = (await otherDayCounts(verifyStore)).split(',').filter((item) => !item.startsWith(targetDay) && !item.startsWith(new Date(FIRST_DAY_MS + (DAYS + 1) * DAY_MS).toISOString().slice(0, 10))).join(',')
  const liveDay = new Date(FIRST_DAY_MS + (DAYS + 1) * DAY_MS).toISOString().slice(0, 10)
  const liveCount = verifyStore.getDayStats(liveDay)?.count ?? 0
  const remainingTarget = verifyStore.getDayStats(targetDay)?.count ?? 0
  // Reclaim след изтриването — само информативно (поведението не е променено).
  let vacuumSteps = 0
  let vacuumMaxMs = 0
  let checkpointMs = 0
  await verifyStore.reclaimSpace({
    onTiming: (label, ms) => {
      if (label === BELOT_HAND_JOURNAL_TIMING_LABELS.reclaimVacuumStep) {
        vacuumSteps += 1
        vacuumMaxMs = Math.max(vacuumMaxMs, ms)
      }
      if (label === BELOT_HAND_JOURNAL_TIMING_LABELS.reclaimCheckpoint) checkpointMs = ms
    },
  })
  verifyStore.close()
  const sorted = [...chunkMs].sort((a, b) => a - b)
  await rm(dir, { recursive: true, force: true })
  return {
    name,
    chunks: chunkMs.length,
    maxMs: sorted[sorted.length - 1] ?? 0,
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    medianMs: percentile(sorted, 50),
    over25: chunkMs.filter((ms) => ms > 25).length,
    over50: chunkMs.filter((ms) => ms > 50).length,
    totalWallMs,
    syncTotalMs: chunkMs.reduce((sum, value) => sum + value, 0),
    peakWalMb: peakWal / 1048576,
    deleted,
    expected: stats.count,
    othersIntact: othersAfter === othersBefore && remainingTarget === 0,
    interleavedWritesOk: liveCount === interleavedInserted,
    vacuumSteps,
    vacuumMaxMs,
    checkpointMs,
  }
}

// Характеризиране: СЪЩИТЕ SQL заявки като store-а, но с изключен
// autocheckpoint (само в benchmark-а) → чистата цена на порцията без
// checkpoint/fsync. Checkpoint-ът се мери отделно накрая. Production
// поведението (autocheckpoint включен) е в runChunked.
async function runPure(templateDir: string, chunkRows: number): Promise<{ name: string; maxMs: number; p99Ms: number; p95Ms: number; medianMs: number; over25: number; over50: number; syncTotalMs: number; checkpointMs: number }> {
  const dir = await freshCopy(templateDir, `pure-${chunkRows}`)
  const sqlite = await import('node:sqlite')
  const db = new sqlite.DatabaseSync(getBelotHandJournalDatabasePath(dir))
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA wal_autocheckpoint = 0;')
  const targetDay = new Date(FIRST_DAY_MS + TARGET_DAY_INDEX * DAY_MS).toISOString().slice(0, 10)
  const stats = db.prepare('SELECT MIN(id) AS minId, MAX(id) AS maxId FROM belot_hand_journal_events WHERE day = ?').get(targetDay) as { minId: number; maxId: number }
  const selectUpper = db.prepare('SELECT MAX(id) AS hi FROM (SELECT id FROM belot_hand_journal_events WHERE day = ? AND id > ? AND id <= ? ORDER BY id ASC LIMIT ?)')
  const deleteRange = db.prepare('DELETE FROM belot_hand_journal_events WHERE day = ? AND id > ? AND id <= ?')
  const chunkMs: number[] = []
  let afterId = stats.minId - 1
  while (afterId < stats.maxId) {
    const startedAt = performance.now()
    const hi = (selectUpper.get(targetDay, afterId, stats.maxId, chunkRows) as { hi: number | null }).hi
    if (hi === null) break
    deleteRange.run(targetDay, afterId, hi)
    chunkMs.push(performance.now() - startedAt)
    afterId = Number(hi)
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
  }
  const checkpointStartedAt = performance.now()
  db.exec('PRAGMA wal_checkpoint(PASSIVE);')
  const checkpointMs = performance.now() - checkpointStartedAt
  db.close()
  await rm(dir, { recursive: true, force: true })
  const sorted = [...chunkMs].sort((a, b) => a - b)
  return {
    name: `pure-${chunkRows}`,
    maxMs: sorted[sorted.length - 1] ?? 0,
    p99Ms: percentile(sorted, 99),
    p95Ms: percentile(sorted, 95),
    medianMs: percentile(sorted, 50),
    over25: chunkMs.filter((ms) => ms > 25).length,
    over50: chunkMs.filter((ms) => ms > 50).length,
    syncTotalMs: chunkMs.reduce((sum, value) => sum + value, 0),
    checkpointMs,
  }
}

const root = await mkdtemp(join(BASE_DIR, 'bhj-delete-bench-'))
const templateDir = join(root, 'template')
await mkdir(templateDir, { recursive: true })
try {
  console.log(`node ${process.version}, platform ${process.platform}`)
  await seedBenchTemplate(templateDir, { days: DAYS, rowsPerDay: ROWS_PER_DAY })
  const results: RunResult[] = []
  results.push(await runChunked(templateDir, null))
  for (const chunkRows of CHUNK_SIZES) results.push(await runChunked(templateDir, chunkRows))
  console.log('\nname          chunks   max ms   p99 ms   p95 ms   med ms  >25ms  >50ms   sync Σ ms   wall ms   peak WAL MB  deleted/expected  intact  writes  vacuum(steps,max ms)  ckpt ms')
  for (const r of results) {
    console.log(
      [
        r.name.padEnd(12),
        String(r.chunks).padStart(7),
        r.maxMs.toFixed(1).padStart(8),
        r.p99Ms.toFixed(1).padStart(8),
        r.p95Ms.toFixed(1).padStart(8),
        r.medianMs.toFixed(1).padStart(8),
        String(r.over25).padStart(6),
        String(r.over50).padStart(6),
        r.syncTotalMs.toFixed(0).padStart(11),
        r.totalWallMs.toFixed(0).padStart(9),
        r.peakWalMb.toFixed(1).padStart(13),
        `${r.deleted}/${r.expected}`.padStart(17),
        String(r.othersIntact).padStart(7),
        String(r.interleavedWritesOk).padStart(7),
        `${r.vacuumSteps},${r.vacuumMaxMs.toFixed(1)}`.padStart(21),
        r.checkpointMs.toFixed(1).padStart(8),
      ].join(' '),
    )
  }
  console.log('\nчиста цена на порцията (autocheckpoint изключен САМО тук; checkpoint-ът накрая е отделно):')
  console.log('name          max ms   p99 ms   p95 ms   med ms  >25ms  >50ms   sync Σ ms   final ckpt ms')
  for (const chunkRows of CHUNK_SIZES) {
    const r = await runPure(templateDir, chunkRows)
    console.log(
      [
        r.name.padEnd(12),
        r.maxMs.toFixed(1).padStart(8),
        r.p99Ms.toFixed(1).padStart(8),
        r.p95Ms.toFixed(1).padStart(8),
        r.medianMs.toFixed(1).padStart(8),
        String(r.over25).padStart(6),
        String(r.over50).padStart(6),
        r.syncTotalMs.toFixed(0).padStart(11),
        r.checkpointMs.toFixed(1).padStart(15),
      ].join(' '),
    )
  }
  const bad = results.filter((r) => r.deleted !== r.expected || !r.othersIntact || (r.name !== 'single' && !r.interleavedWritesOk))
  if (bad.length > 0) {
    console.error(`\nCORRECTNESS FAILURE: ${bad.map((r) => r.name).join(', ')}`)
    process.exitCode = 1
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
