// Общи fixtures за belot hand journal benchmark-ите: production-like шаблонна
// база (истинската схема от createBelotHandJournalStore), реалистичен payload,
// fsync-нати свежи копия, четене на WAL-index header-а (-shm).

import { copyFile, mkdir, open, rm, stat } from 'node:fs/promises'
import { openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  createBelotHandJournalStore,
  getBelotHandJournalDatabasePath,
} from '../src/diagnostics/belotHandJournal/belotHandJournalStore.js'
import {
  BELOT_HAND_JOURNAL_SCHEMA,
  BELOT_HAND_JOURNAL_SCHEMA_VERSION,
  type BelotHandJournalEvent,
} from '../src/diagnostics/belotHandJournal/belotHandJournalTypes.js'

export function arg(name: string, fallback: string): string {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

export const BENCH_DAY_MS = 24 * 3600 * 1000
export const BENCH_FIRST_DAY_MS = Date.UTC(2026, 9, 13)
export const BENCH_TARGET_DAY_INDEX = 1

export function benchDay(index: number): string {
  return new Date(BENCH_FIRST_DAY_MS + index * BENCH_DAY_MS).toISOString().slice(0, 10)
}

const EVENT_TYPES = ['card_played', 'card_played', 'card_played', 'bid', 'trick_completed', 'hand_started', 'hand_scored', 'declarations', 'room_transition', 'timer']
let seed = 42
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
function token(length: number): string {
  let out = ''
  while (out.length < length) out += Math.floor(rand() * 36 ** 6).toString(36)
  return out.slice(0, length)
}
const SUITS = ['C', 'D', 'H', 'S']
const RANKS = ['7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
function cards(count: number): string[] {
  return Array.from({ length: count }, () => `${RANKS[Math.floor(rand() * 8)]}${SUITS[Math.floor(rand() * 4)]}`)
}

// Payload ≈ 1.3 KB JSON (≈ production: 203.6 MB / 129 394 реда ≈ 1.57 KB на архивен ред с meta).
export function buildBenchEvent(occurredAtMs: number, roomId: string, matchId: string, handNo: number): BelotHandJournalEvent {
  const eventType = EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)]!
  const payload = {
    seat: Math.floor(rand() * 4),
    origin: rand() < 0.7 ? 'human' : 'bot',
    trick: Math.floor(rand() * 8),
    contract: { suit: SUITS[Math.floor(rand() * 4)], level: 'all-trumps', doubled: rand() < 0.1, by: Math.floor(rand() * 4) },
    hands: [cards(8), cards(8), cards(8), cards(8)],
    tricksWon: [cards(4), cards(4)],
    score: { team0: Math.floor(rand() * 300), team1: Math.floor(rand() * 300), match: [Math.floor(rand() * 151), Math.floor(rand() * 151)] },
    declarations: [{ seat: Math.floor(rand() * 4), kind: 'tierce', cards: cards(3) }, { seat: Math.floor(rand() * 4), kind: 'belot', cards: cards(2) }],
    timing: { decisionMs: Math.floor(rand() * 15000), serverStep: Math.floor(rand() * 1e6), wallClock: new Date(occurredAtMs).toISOString() },
    check: { name: 'trick_rules', ok: true, detail: token(120) },
    stateHash: token(64),
    prevStateHash: token(64),
  }
  return {
    schema: BELOT_HAND_JOURNAL_SCHEMA,
    schemaVersion: BELOT_HAND_JOURNAL_SCHEMA_VERSION,
    eventType: eventType as BelotHandJournalEvent['eventType'],
    severity: rand() < 0.002 ? 'anomaly' : 'info',
    occurredAtMs,
    occurredAt: new Date(occurredAtMs).toISOString(),
    roomId,
    matchId,
    handId: `${matchId}:h${handNo}`,
    ...(eventType === 'hand_started' ? { profileIds: [token(12), token(12), token(12), token(12)] } : {}),
    payload,
  } as BelotHandJournalEvent
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
}

export async function seedBenchTemplate(dir: string, options: { days: number; rowsPerDay: number }): Promise<void> {
  const store = await createBelotHandJournalStore({ directory: dir })
  const started = performance.now()
  for (let day = 0; day < options.days; day += 1) {
    const dayStart = BENCH_FIRST_DAY_MS + day * BENCH_DAY_MS
    let batch: BelotHandJournalEvent[] = []
    let roomId = `room_${token(14)}`
    let matchId = `match_${token(16)}`
    let handNo = 0
    for (let index = 0; index < options.rowsPerDay; index += 1) {
      if (index % 120 === 0) {
        roomId = `room_${token(14)}`
        matchId = `match_${token(16)}`
        handNo = 0
      }
      if (index % 15 === 0) handNo += 1
      batch.push(buildBenchEvent(dayStart + Math.floor((index / options.rowsPerDay) * (BENCH_DAY_MS - 1000)), roomId, matchId, handNo))
      if (batch.length >= 500) {
        store.insertEvents(batch)
        batch = []
      }
    }
    if (batch.length > 0) store.insertEvents(batch)
  }
  await store.reclaimSpace()
  store.close()
  // Чист шаблон: WAL изпразнен.
  const sqlite = await import('node:sqlite')
  const db = new sqlite.DatabaseSync(getBelotHandJournalDatabasePath(dir))
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  db.close()
  const size = (await stat(getBelotHandJournalDatabasePath(dir))).size
  console.log(`template: ${options.days} days × ${options.rowsPerDay} rows, db ${(size / 1048576).toFixed(1)} MB, seeded in ${((performance.now() - started) / 1000).toFixed(1)} s`)
}

export async function freshBenchCopy(templateDir: string, name: string): Promise<string> {
  const dir = join(templateDir, '..', name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await copyFile(getBelotHandJournalDatabasePath(templateDir), getBelotHandJournalDatabasePath(dir))
  // Копието е „dirty“ в OS кеша — без fsync първият checkpoint на теста би
  // flush-нал целия файл и би изкривил времето на една порция.
  const handle = await open(getBelotHandJournalDatabasePath(dir), 'r+')
  await handle.sync()
  await handle.close()
  return dir
}

export function walFileSize(dir: string): number {
  try {
    return statSync(`${getBelotHandJournalDatabasePath(dir)}-wal`).size
  } catch {
    return 0
  }
}

// WAL-index header (-shm, native little-endian): mxFrame @16, salt1 @32,
// nBackfill @96 (WalCkptInfo). Autocheckpoint/PASSIVE checkpoint вдига
// nBackfill; следващият write след пълен checkpoint рестартира WAL (нов salt).
export type WalIndexState = { mxFrame: number; salt1: number; nBackfill: number }

export function createWalIndexReader(dir: string): () => WalIndexState {
  const fd = openSync(`${getBelotHandJournalDatabasePath(dir)}-shm`, 'r')
  const buffer = Buffer.alloc(100)
  return () => {
    readSync(fd, buffer, 0, 100, 0)
    return { mxFrame: buffer.readUInt32LE(16), salt1: buffer.readUInt32LE(32), nBackfill: buffer.readUInt32LE(96) }
  }
}

// Колко WAL frame-а са записани и колко са backfill-нати (checkpoint) между
// две снимки на един и същ синхронен span.
export function walDelta(before: WalIndexState, after: WalIndexState): { framesWritten: number; framesBackfilled: number; walReset: boolean } {
  const walReset = after.salt1 !== before.salt1
  return {
    walReset,
    framesWritten: walReset ? after.mxFrame : after.mxFrame - before.mxFrame,
    framesBackfilled: walReset ? after.nBackfill : after.nBackfill - before.nBackfill,
  }
}
