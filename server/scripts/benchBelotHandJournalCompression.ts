/**
 * benchBelotHandJournalCompression.ts
 *
 * Сравнение GZIP срещу ZSTD (нива 3/6/9) върху представителни данни от
 * belot hand журнала: симулират се пълни мачове с реалния engine, записват се
 * в журнала и се извличат ТОЧНО във формата на архивните редове.
 *
 *   npx tsx scripts/benchBelotHandJournalCompression.ts --matches=120 [--runs=5]
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { addBotToRoom } from '../src/core/addBotToRoom.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import type { ServerAntiBadLuckConfig } from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { advanceRoomAuthoritativeGame } from '../src/game/advanceRoomAuthoritativeGame.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { createBelotHandJournal } from '../src/diagnostics/belotHandJournal/createBelotHandJournal.js'
import { createBelotHandJournalStore } from '../src/diagnostics/belotHandJournal/belotHandJournalStore.js'

const args = new Map(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=') as [string, string]))
const MATCHES = Number(args.get('matches') ?? 120)
const RUNS = Number(args.get('runs') ?? 5)

type ZstdZlib = typeof zlib & {
  zstdCompressSync: (buffer: Buffer, options?: { params?: Record<number, number> }) => Buffer
  zstdDecompressSync: (buffer: Buffer) => Buffer
}
const z = zlib as ZstdZlib
if (typeof z.zstdCompressSync !== 'function') {
  console.error('Node няма вграден zlib ZSTD — нужен е Node >= 22.15')
  process.exit(1)
}

let fakeNow = Date.UTC(2026, 9, 1, 8)
const realDateNow = Date.now
Date.now = () => fakeNow

const directory = await mkdtemp(join(tmpdir(), 'bhj-bench-'))
const store = await createBelotHandJournalStore({ directory })
const journal = createBelotHandJournal({ store, now: () => fakeNow, scheduleFlush: (flush) => flush() })
const config = { threshold: 5, resetGeneration: 0 } as unknown as ServerAntiBadLuckConfig

const generationStart = realDateNow()
for (let match = 0; match < MATCHES; match += 1) {
  const id = `bench-room-${match}`
  const { room: r1 } = createRoomWithHumanHost({ roomId: id, connectionId: `${id}-1`, identity: { displayName: `Играч ${match}`, profileId: `profile-${match}-a` } as never })
  const { room: r2 } = addHumanToRoom(r1, { connectionId: `${id}-2`, identity: { displayName: `Партньор ${match}`, profileId: `profile-${match}-b` } as never })
  const { room: r3 } = addBotToRoom(r2, {} as never)
  let room = initializeRoomAuthoritativeGameState(addBotToRoom(r3, {} as never).room)
  journal.observeRoomTransition(null, room, 'worker_tick')
  for (let step = 0; step < 400000; step += 1) {
    fakeNow += 500
    const next = advanceRoomAuthoritativeGame(room, fakeNow, config)
    if (next !== room) {
      journal.observeRoomTransition(room, next, 'worker_tick')
      room = next
    }
    const state = room.game.authoritativeState as { phase?: string } | null
    if (state?.phase === 'match-ended') break
  }
}
journal.flushSync()
const generationMs = realDateNow() - generationStart

const lines: string[] = []
for (const day of store.listDays()) {
  const stats = store.getDayStats(day)!
  for await (const line of store.iterateDayArchiveLines(day, stats.minId, stats.maxId)) lines.push(line)
}
const hands = store.queryEvents({ eventTypes: ['hand_started'] }).length
const scored = store.queryEvents({ eventTypes: ['hand_scored'] }).length
journal.close()
await rm(directory, { recursive: true, force: true })
Date.now = realDateNow

const raw = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8')
const rawSha = createHash('sha256').update(raw).digest('hex')

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function measure(label: string, compress: (input: Buffer) => Buffer, decompress: (input: Buffer) => Buffer) {
  const compressTimes: number[] = []
  const decompressTimes: number[] = []
  let compressed: Buffer = Buffer.alloc(0)
  let identical = true
  for (let run = 0; run < RUNS; run += 1) {
    let start = performance.now()
    compressed = compress(raw)
    compressTimes.push(performance.now() - start)
    start = performance.now()
    const restored = decompress(compressed)
    decompressTimes.push(performance.now() - start)
    identical = identical && createHash('sha256').update(restored).digest('hex') === rawSha && restored.length === raw.length
  }
  const compressMs = median(compressTimes)
  const decompressMs = median(decompressTimes)
  return {
    label,
    bytes: compressed.length,
    ratio: raw.length / compressed.length,
    compressMs,
    compressMBps: raw.length / 1048576 / (compressMs / 1000),
    decompressMs,
    decompressMBps: raw.length / 1048576 / (decompressMs / 1000),
    identical,
  }
}

const zstd = (level: number) => (input: Buffer) =>
  z.zstdCompressSync(input, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: level, [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  })

const results = [
  measure('GZIP ниво 6 (досегашният)', (input) => zlib.gzipSync(input, { level: 6 }), (input) => zlib.gunzipSync(input)),
  measure('GZIP ниво 9', (input) => zlib.gzipSync(input, { level: 9 }), (input) => zlib.gunzipSync(input)),
  measure('ZSTD ниво 3', zstd(3), (input) => z.zstdDecompressSync(input)),
  measure('ZSTD ниво 6', zstd(6), (input) => z.zstdDecompressSync(input)),
  measure('ZSTD ниво 9', zstd(9), (input) => z.zstdDecompressSync(input)),
  measure('ZSTD ниво 12', zstd(12), (input) => z.zstdDecompressSync(input)),
  measure('ZSTD ниво 19', zstd(19), (input) => z.zstdDecompressSync(input)),
]

const mb = (bytes: number) => (bytes / 1048576).toFixed(2)
console.log(`Node ${process.version}, zstd ${process.versions.zstd ?? '?'}, zlib ${process.versions.zlib}`)
console.log(`Данни: ${MATCHES} мача, ${hands} раздавания (${scored} изиграни до точкуване), ${lines.length} събития; генериране ${(generationMs / 1000).toFixed(0)} s`)
console.log(`Некомпресиран размер: ${mb(raw.length)} MB (${raw.length} B), ${(raw.length / Math.max(1, scored) / 1024).toFixed(1)} KB на изиграно раздаване; медиана от ${RUNS} изпълнения`)
console.log('| Формат | Размер (MB) | Съотношение | Компресия (ms) | MB/s | Декомпресия (ms) | MB/s | Идентични данни |')
console.log('|---|---:|---:|---:|---:|---:|---:|---|')
for (const result of results) {
  console.log(
    `| ${result.label} | ${mb(result.bytes)} | ${result.ratio.toFixed(1)}× | ${result.compressMs.toFixed(0)} | ${result.compressMBps.toFixed(0)} | ${result.decompressMs.toFixed(0)} | ${result.decompressMBps.toFixed(0)} | ${result.identical ? 'да (SHA-256)' : 'НЕ'} |`,
  )
}
if (results.some((result) => !result.identical)) process.exit(1)
