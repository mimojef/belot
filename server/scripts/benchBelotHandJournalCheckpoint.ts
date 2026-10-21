/**
 * benchBelotHandJournalCheckpoint.ts
 *
 * Focused checkpoint investigation за изтриването на порции (incident 18536).
 * НЕ променя production поведението — всички варианти са в raw DatabaseSync
 * връзка със СЪЩИТЕ SQL заявки като store-а.
 *
 * Всеки синхронен main-thread span се мери поотделно:
 *   delete     — една порция (SELECT hi + DELETE; autocommit, вкл. autocheckpoint)
 *   write      — нормален journal запис между порциите (BEGIN IMMEDIATE … COMMIT)
 *   checkpoint — explicit PRAGMA wal_checkpoint(PASSIVE) (само варианти C)
 *   post       — нормални записи СЛЕД изтриването (дали checkpoint-ът се е
 *                преместил в следващия journal flush)
 * Checkpoint в span-а се доказва от WAL-index header-а (-shm): nBackfill
 * расте (или WAL рестарт + nBackfill > 0) → backfill-нати frame-ове.
 *
 * Варианти:
 *   A  wal_autocheckpoint=1000 (текущ default), порции 250/500/1000/2000
 *   B  wal_autocheckpoint=128/256/512, порция 1000
 *   C  wal_autocheckpoint=0 + explicit PASSIVE след всяка / всяка 4-та порция
 *      (отделен span след yield); накрая explicit checkpoint, после
 *      wal_autocheckpoint се връща на 1000 за post фазата
 *   S  autocheckpoint=0 + explicit PASSIVE веднага след порцията, когато
 *      неback-fill-натите frame-ове ≥ 1000 → емулира A, но разделя времето
 *      DELETE до commit / checkpoint
 *   D  (диагностика) като A-1000, но synchronous=OFF → дял на fsync
 *
 * Употреба: npx tsx scripts/benchBelotHandJournalCheckpoint.ts [--rows=130000] [--days=3] [--dir=<tmp>] [--only=A-1000,C-1]
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBelotHandJournalDatabasePath } from '../src/diagnostics/belotHandJournal/belotHandJournalStore.js'
import {
  arg,
  BENCH_DAY_MS,
  BENCH_FIRST_DAY_MS,
  BENCH_TARGET_DAY_INDEX,
  benchDay,
  buildBenchEvent,
  createWalIndexReader,
  freshBenchCopy,
  percentile,
  seedBenchTemplate,
  walDelta,
  walFileSize,
} from './belotHandJournalBenchFixtures.js'

const ROWS_PER_DAY = Number(arg('rows', '130000'))
const DAYS = Number(arg('days', '3'))
const BASE_DIR = arg('dir', tmpdir())
const ONLY = arg('only', '').split(',').filter((item) => item !== '')
const WRITE_EVENTS = 5
const POST_WRITES = 400

type Variant = {
  name: string
  chunkRows: number
  autocheckpoint: number
  synchronous: 'NORMAL' | 'OFF'
  explicitEvery: number | null
  splitAtFrames: number | null
}

const VARIANTS: Variant[] = [
  { name: 'A-250', chunkRows: 250, autocheckpoint: 1000, synchronous: 'NORMAL', explicitEvery: null, splitAtFrames: null },
  { name: 'A-500', chunkRows: 500, autocheckpoint: 1000, synchronous: 'NORMAL', explicitEvery: null, splitAtFrames: null },
  { name: 'A-1000', chunkRows: 1000, autocheckpoint: 1000, synchronous: 'NORMAL', explicitEvery: null, splitAtFrames: null },
  { name: 'A-2000', chunkRows: 2000, autocheckpoint: 1000, synchronous: 'NORMAL', explicitEvery: null, splitAtFrames: null },
  { name: 'B-128', chunkRows: 1000, autocheckpoint: 128, synchronous: 'NORMAL', explicitEvery: null, splitAtFrames: null },
  { name: 'B-256', chunkRows: 1000, autocheckpoint: 256, synchronous: 'NORMAL', explicitEvery: null, splitAtFrames: null },
  { name: 'B-512', chunkRows: 1000, autocheckpoint: 512, synchronous: 'NORMAL', explicitEvery: null, splitAtFrames: null },
  { name: 'C-1', chunkRows: 1000, autocheckpoint: 0, synchronous: 'NORMAL', explicitEvery: 1, splitAtFrames: null },
  { name: 'C-4', chunkRows: 1000, autocheckpoint: 0, synchronous: 'NORMAL', explicitEvery: 4, splitAtFrames: null },
  { name: 'C-1/250', chunkRows: 250, autocheckpoint: 0, synchronous: 'NORMAL', explicitEvery: 1, splitAtFrames: null },
  { name: 'S-1000', chunkRows: 1000, autocheckpoint: 0, synchronous: 'NORMAL', explicitEvery: null, splitAtFrames: 1000 },
  { name: 'D-off', chunkRows: 1000, autocheckpoint: 1000, synchronous: 'OFF', explicitEvery: null, splitAtFrames: null },
]

type SpanKind = 'delete' | 'write' | 'checkpoint' | 'post'
type Span = { kind: SpanKind; ms: number; framesWritten: number; framesBackfilled: number }

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: values.length,
    max: sorted[sorted.length - 1] ?? 0,
    p99: percentile(sorted, 99),
    p95: percentile(sorted, 95),
    median: percentile(sorted, 50),
    sum: values.reduce((total, value) => total + value, 0),
  }
}

const sleepImmediate = () => new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))

async function runVariant(templateDir: string, variant: Variant) {
  const dir = await freshBenchCopy(templateDir, `ckpt-${variant.name.replace('/', '_')}`)
  const sqlite = await import('node:sqlite')
  const db = new sqlite.DatabaseSync(getBelotHandJournalDatabasePath(dir))
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(`PRAGMA synchronous = ${variant.synchronous};`)
  db.exec('PRAGMA journal_size_limit = 67108864;')
  db.exec(`PRAGMA wal_autocheckpoint = ${variant.autocheckpoint};`)
  const day = benchDay(BENCH_TARGET_DAY_INDEX)
  const range = db.prepare('SELECT COUNT(*) AS count, MIN(id) AS minId, MAX(id) AS maxId FROM belot_hand_journal_events WHERE day = ?').get(day) as { count: number; minId: number; maxId: number }
  const readWal = createWalIndexReader(dir)
  const selectUpper = db.prepare('SELECT MAX(id) AS hi FROM (SELECT id FROM belot_hand_journal_events WHERE day = ? AND id > ? AND id <= ? ORDER BY id ASC LIMIT ?)')
  const deleteRange = db.prepare('DELETE FROM belot_hand_journal_events WHERE day = ? AND id > ? AND id <= ?')
  const insert = db.prepare(`
    INSERT INTO belot_hand_journal_events
      (schema_version, occurred_at_ms, day, event_type, severity, room_id, match_id, hand_id, profile_ids, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const liveMs = BENCH_FIRST_DAY_MS + (DAYS + 1) * BENCH_DAY_MS
  const liveDay = benchDay(DAYS + 1)
  let handNo = 0
  const spans: Span[] = []
  let peakWal = walFileSize(dir)
  let peakFrames = 0

  const span = (kind: SpanKind, fn: () => void): Span => {
    const before = readWal()
    const startedAt = performance.now()
    fn()
    const ms = performance.now() - startedAt
    const after = readWal()
    const delta = walDelta(before, after)
    const item: Span = { kind, ms, framesWritten: delta.framesWritten, framesBackfilled: delta.framesBackfilled }
    spans.push(item)
    peakWal = Math.max(peakWal, walFileSize(dir))
    peakFrames = Math.max(peakFrames, after.mxFrame)
    return item
  }
  const normalWrite = (kind: SpanKind) =>
    span(kind, () => {
      handNo += 1
      db.exec('BEGIN IMMEDIATE;')
      for (let index = 0; index < WRITE_EVENTS; index += 1) {
        const event = buildBenchEvent(liveMs + handNo * 10 + index, 'room_live', 'match_live', handNo)
        insert.run(event.schemaVersion, event.occurredAtMs, liveDay, event.eventType, event.severity, event.roomId, event.matchId, event.handId, null, JSON.stringify(event.payload))
      }
      db.exec('COMMIT;')
    })
  const explicitCheckpoint = () => span('checkpoint', () => {
    db.exec('PRAGMA wal_checkpoint(PASSIVE);')
  })

  // ── delete фаза ──
  const splitBody: number[] = []
  const splitCheckpoint: number[] = []
  const startedAt = performance.now()
  let afterId = range.minId - 1
  let deleted = 0
  let chunks = 0
  while (afterId < range.maxId) {
    let hi: number | null = null
    const deleteSpan = span('delete', () => {
      hi = (selectUpper.get(day, afterId, range.maxId, variant.chunkRows) as { hi: number | null }).hi
      if (hi !== null) deleted += Number(deleteRange.run(day, afterId, hi).changes)
    })
    if (hi === null) {
      spans.pop()
      break
    }
    chunks += 1
    afterId = Number(hi)
    if (variant.splitAtFrames !== null) {
      const state = readWal()
      if (state.mxFrame - state.nBackfill >= variant.splitAtFrames) {
        // Емулация на autocheckpoint (PASSIVE в същия turn, веднага след commit).
        const checkpointSpan = explicitCheckpoint()
        splitBody.push(deleteSpan.ms)
        splitCheckpoint.push(checkpointSpan.ms)
      }
    }
    await sleepImmediate()
    normalWrite('write')
    await sleepImmediate()
    if (variant.explicitEvery !== null && chunks % variant.explicitEvery === 0) {
      explicitCheckpoint()
      await sleepImmediate()
    }
  }
  if (variant.autocheckpoint === 0) {
    // Преди връщане към нормалния режим: финален checkpoint на остатъка.
    explicitCheckpoint()
    await sleepImmediate()
  }
  const totalWallMs = performance.now() - startedAt
  const deletePhase = [...spans]

  // ── post фаза: нормални записи с production autocheckpoint ──
  if (variant.autocheckpoint === 0) db.exec('PRAGMA wal_autocheckpoint = 1000;')
  for (let index = 0; index < POST_WRITES; index += 1) {
    normalWrite('post')
    await sleepImmediate()
  }
  const postSpans = spans.filter((item) => item.kind === 'post')
  const remaining = (db.prepare('SELECT COUNT(*) AS count FROM belot_hand_journal_events WHERE day = ?').get(day) as { count: number }).count
  db.close()
  await rm(dir, { recursive: true, force: true })

  const checkpointed = deletePhase.filter((item) => item.framesBackfilled > 0)
  const deleteSpans = deletePhase.filter((item) => item.kind === 'delete')
  const deleteNoCkpt = deleteSpans.filter((item) => item.framesBackfilled === 0)
  const deleteWithCkpt = deleteSpans.filter((item) => item.framesBackfilled > 0)
  const writeSpans = deletePhase.filter((item) => item.kind === 'write')
  const explicitSpans = deletePhase.filter((item) => item.kind === 'checkpoint')
  const postCkpt = postSpans.filter((item) => item.framesBackfilled > 0)
  return {
    variant,
    correct: deleted === range.count && remaining === 0,
    chunks,
    all: stats(deletePhase.map((item) => item.ms)),
    totalWallMs,
    peakWalMb: peakWal / 1048576,
    peakFrames,
    checkpoints: checkpointed.length,
    checkpointsIn: {
      delete: deleteWithCkpt.length,
      write: writeSpans.filter((item) => item.framesBackfilled > 0).length,
      explicit: explicitSpans.filter((item) => item.framesBackfilled > 0).length,
    },
    slowestCheckpointMs: Math.max(0, ...checkpointed.map((item) => item.ms)),
    avgFramesPerCheckpoint: checkpointed.length ? checkpointed.reduce((s, i) => s + i.framesBackfilled, 0) / checkpointed.length : 0,
    framesPerDeleteChunk: deleteSpans.length ? deleteSpans.reduce((s, i) => s + i.framesWritten, 0) / deleteSpans.length : 0,
    deleteNoCkpt: stats(deleteNoCkpt.map((item) => item.ms)),
    deleteWithCkpt: stats(deleteWithCkpt.map((item) => item.ms)),
    over50: deletePhase.filter((item) => item.ms > 50).length,
    over50WithoutCkpt: deletePhase.filter((item) => item.ms > 50 && item.framesBackfilled === 0).length,
    writes: stats(writeSpans.map((item) => item.ms)),
    explicit: stats(explicitSpans.map((item) => item.ms)),
    post: stats(postSpans.map((item) => item.ms)),
    postCheckpoints: postCkpt.length,
    postSlowestCheckpointMs: Math.max(0, ...postCkpt.map((item) => item.ms)),
    postMaxBackfill: Math.max(0, ...postCkpt.map((item) => item.framesBackfilled)),
    split: splitBody.length > 0 ? { body: stats(splitBody), checkpoint: stats(splitCheckpoint) } : null,
  }
}

const f = (value: number, digits = 1) => value.toFixed(digits)
const root = await mkdtemp(join(BASE_DIR, 'bhj-ckpt-bench-'))
const templateDir = join(root, 'template')
await mkdir(templateDir, { recursive: true })
try {
  console.log(`node ${process.version}, platform ${process.platform}, write batch ${WRITE_EVENTS} events between chunks, ${POST_WRITES} post writes`)
  await seedBenchTemplate(templateDir, { days: DAYS, rowsPerDay: ROWS_PER_DAY })
  const selected = VARIANTS.filter((variant) => ONLY.length === 0 || ONLY.includes(variant.name))
  const results = []
  for (const variant of selected) {
    const result = await runVariant(templateDir, variant)
    results.push(result)
    console.log(`done ${variant.name}`)
  }
  console.log('\n── delete фаза: всички синхронни span-ове (delete + междинни writes + explicit checkpoints) ──')
  console.log('variant   chunks  maxSpan   p99    p95   median  >50ms(без ckpt)  syncΣ ms  wall ms  peakWAL MB  peakFrames  ckpts(del/wr/expl)  slowestCkpt  frames/ckpt  frames/chunk  ok')
  for (const r of results) {
    console.log([
      r.variant.name.padEnd(9), String(r.chunks).padStart(6), f(r.all.max).padStart(8), f(r.all.p99).padStart(6), f(r.all.p95).padStart(6), f(r.all.median).padStart(7),
      `${r.over50}(${r.over50WithoutCkpt})`.padStart(16), f(r.all.sum, 0).padStart(9), f(r.totalWallMs, 0).padStart(8), f(r.peakWalMb).padStart(11), String(r.peakFrames).padStart(11),
      `${r.checkpoints}(${r.checkpointsIn.delete}/${r.checkpointsIn.write}/${r.checkpointsIn.explicit})`.padStart(19), f(r.slowestCheckpointMs).padStart(12),
      f(r.avgFramesPerCheckpoint, 0).padStart(12), f(r.framesPerDeleteChunk, 0).padStart(13), String(r.correct).padStart(4),
    ].join(' '))
  }
  console.log('\n── разделяне: delete порции без / с checkpoint вътре; writes; explicit checkpoints ──')
  console.log('variant   delNoCkpt(n,max,p99,med)        delWithCkpt(n,max,med)     writes(max,p99)   explicit(n,max,p95,med)')
  for (const r of results) {
    console.log([
      r.variant.name.padEnd(9),
      `${r.deleteNoCkpt.count},${f(r.deleteNoCkpt.max)},${f(r.deleteNoCkpt.p99)},${f(r.deleteNoCkpt.median)}`.padEnd(31),
      `${r.deleteWithCkpt.count},${f(r.deleteWithCkpt.max)},${f(r.deleteWithCkpt.median)}`.padEnd(26),
      `${f(r.writes.max)},${f(r.writes.p99)}`.padEnd(17),
      r.explicit.count > 0 ? `${r.explicit.count},${f(r.explicit.max)},${f(r.explicit.p95)},${f(r.explicit.median)}` : '-',
    ].join(' '))
  }
  console.log('\n── S (емулация на autocheckpoint): DELETE до commit срещу checkpoint, в същите тригер точки ──')
  for (const r of results.filter((item) => item.split !== null)) {
    console.log(`${r.variant.name}: n=${r.split!.body.count}  body max/med ${f(r.split!.body.max)}/${f(r.split!.body.median)} ms   checkpoint max/p95/med ${f(r.split!.checkpoint.max)}/${f(r.split!.checkpoint.p95)}/${f(r.split!.checkpoint.median)} ms`)
  }
  console.log(`\n── post фаза: ${POST_WRITES} нормални journal записа СЛЕД изтриването (autocheckpoint=1000 за A/C/S, вариантът за B) ──`)
  console.log('variant   post max  post p99  ckpts  slowest ckpt  max backfill frames')
  for (const r of results) {
    console.log([r.variant.name.padEnd(9), f(r.post.max).padStart(8), f(r.post.p99).padStart(9), String(r.postCheckpoints).padStart(6), f(r.postSlowestCheckpointMs).padStart(13), String(r.postMaxBackfill).padStart(20)].join(' '))
  }
  if (results.some((r) => !r.correct)) {
    console.error('\nCORRECTNESS FAILURE')
    process.exitCode = 1
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
