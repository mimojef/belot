/**
 * checkPrivateRoomMatchStore.ts
 *
 * Store-level checks за private_room_matches (20260820_001 migration) —
 * персистентен history за "Играещи"/"Приключили" lobby табовете. Виж
 * privateRoomMatchStore.ts за пълния rationale (защо е отделна таблица от
 * active_room_snapshots/profile_match_results, защо никога не трие редове,
 * защо 2-часовият "Приключили" прозорец е WHERE filter а не cleanup job).
 *
 * [1]  recordMatchStarted вмъква ред със status='playing'
 * [2]  listPlayingMatches връща стартираната игра
 * [3]  recordMatchScoreUpdate обновява team scores, докато е 'playing'
 * [4]  recordMatchFinished маркира status='finished', задава finished_at, финален score
 * [5]  finished мач изчезва от listPlayingMatches
 * [6]  finished мач се появява в listFinishedMatches(2h)
 * [7]  DB редът НЕ се трие след finish (getMatch все още го намира)
 * [8]  listFinishedMatches(2h) НЕ връща мач, приключил преди >2 часа
 * [9]  listFinishedMatches(2h) ВРЪЩА мач, приключил преди <2 часа
 * [10] listFinishedMatches подрежда най-новите (finished_at DESC) първи
 * [11] recordMatchScoreUpdate след finish е no-op (WHERE status='playing' guard)
 * [12] recordMatchStarted е idempotent при повторен roomId (ON CONFLICT DO NOTHING)
 * [13] teamA/teamB occupant JSON round-trip запазва bot flag и profileId
 * [14] listPlayingMatches НЕ връща finished мачове
 * [15] getMatch връща null за несъществуващ roomId
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateRoomMatchStore, type PrivateRoomMatchOccupant } from '../src/db/privateRoomMatchStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationPath = resolve(serverRoot, 'database/migrations/20260820_001_create_private_room_matches.sql')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-private-room-match-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function applyMigrationFile(db: DatabaseSync, path: string): Promise<void> {
  const sql = await readFile(path, 'utf8')
  db.exec('BEGIN;')
  try {
    db.exec(sql)
    db.exec('COMMIT;')
  } catch (err) {
    db.exec('ROLLBACK;')
    throw err
  }
}

function makeOccupant(overrides: Partial<PrivateRoomMatchOccupant> = {}): PrivateRoomMatchOccupant {
  return {
    profileId: 'profile-1',
    displayName: 'Player One',
    avatarUrl: null,
    isBot: false,
    ...overrides,
  }
}

console.log('\ncheckPrivateRoomMatchStore\n')

await withTempDir(async (dir) => {
  const dbFile = join(dir, 'test.sqlite')
  const setupDb = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  await applyMigrationFile(setupDb, migrationPath)
  setupDb.close()

  const store = await createPrivateRoomMatchStore(dbFile)

  try {
    const teamA: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant] = [
      makeOccupant({ profileId: 'p1', displayName: 'Ани' }),
      makeOccupant({ profileId: null, displayName: 'Бот Иван', isBot: true }),
    ]
    const teamB: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant] = [
      makeOccupant({ profileId: 'p3', displayName: 'Мария' }),
      makeOccupant({ profileId: 'p4', displayName: 'Georgi' }),
    ]

    await check('[1] recordMatchStarted вмъква ред със status=playing', () => {
      store.recordMatchStarted({ roomId: 'room-1', privateRoomId: 'private-1', stake: 5000, teamA, teamB })
      const match = store.getMatch('room-1')
      assert(match !== null, 'match трябва да съществува')
      assertEqual(match!.status, 'playing', 'status трябва да е playing')
      assertEqual(match!.stake, 5000, 'stake трябва да е запазен')
    })

    await check('[2] listPlayingMatches връща стартираната игра', () => {
      const playing = store.listPlayingMatches()
      assert(playing.some((m) => m.roomId === 'room-1'), 'room-1 трябва да е в playing списъка')
    })

    await check('[13] teamA/teamB occupant JSON round-trip запазва bot flag и profileId', () => {
      const match = store.getMatch('room-1')
      assertEqual(match!.teamA[1].isBot, true, 'teamA[1] трябва да е бот')
      assertEqual(match!.teamA[1].profileId, null, 'бот без profileId трябва да остане null')
      assertEqual(match!.teamB[0].profileId, 'p3', 'teamB[0] profileId round-trip')
      assertEqual(match!.teamB[0].displayName, 'Мария', 'кирилски displayName round-trip')
    })

    await check('[3] recordMatchScoreUpdate обновява team scores докато е playing', () => {
      store.recordMatchScoreUpdate('room-1', 42, 17)
      const match = store.getMatch('room-1')
      assertEqual(match!.teamAScore, 42, 'teamAScore трябва да е обновен')
      assertEqual(match!.teamBScore, 17, 'teamBScore трябва да е обновен')
      assertEqual(match!.status, 'playing', 'score update не трябва да променя status')
    })

    await check('[4] recordMatchFinished маркира finished + финален score + finished_at', () => {
      store.recordMatchFinished('room-1', 151, 98)
      const match = store.getMatch('room-1')
      assertEqual(match!.status, 'finished', 'status трябва да е finished')
      assertEqual(match!.teamAScore, 151, 'финален teamAScore')
      assertEqual(match!.teamBScore, 98, 'финален teamBScore')
      assert(match!.finishedAt !== null, 'finishedAt трябва да е зададен')
    })

    await check('[5] finished мач изчезва от listPlayingMatches', () => {
      const playing = store.listPlayingMatches()
      assert(!playing.some((m) => m.roomId === 'room-1'), 'room-1 не трябва да е в playing списъка след finish')
    })

    await check('[6] finished мач се появява в listFinishedMatches(2h)', () => {
      const finished = store.listFinishedMatches(2)
      assert(finished.some((m) => m.roomId === 'room-1'), 'room-1 трябва да е в finished(2h) списъка')
    })

    await check('[7] DB редът НЕ се трие след finish (getMatch все още го намира)', () => {
      const match = store.getMatch('room-1')
      assert(match !== null, 'записът трябва да остане в DB — 2h прозорецът е read-filter, не delete')
    })

    await check('[11] recordMatchScoreUpdate след finish е no-op', () => {
      store.recordMatchScoreUpdate('room-1', 999, 999)
      const match = store.getMatch('room-1')
      assertEqual(match!.teamAScore, 151, 'teamAScore не трябва да се промени след finish (WHERE status=playing guard)')
      assertEqual(match!.teamBScore, 98, 'teamBScore не трябва да се промени след finish')
    })

    await check('[12] recordMatchStarted е idempotent при повторен roomId', () => {
      store.recordMatchStarted({ roomId: 'room-1', privateRoomId: 'private-1-different', stake: 9999, teamA, teamB })
      const match = store.getMatch('room-1')
      assertEqual(match!.status, 'finished', 'повторен recordMatchStarted не трябва да презапише вече finished запис')
      assertEqual(match!.stake, 5000, 'оригиналният stake трябва да остане')
    })

    await check('[15] getMatch връща null за несъществуващ roomId', () => {
      assertEqual(store.getMatch('does-not-exist'), null, 'несъществуващ roomId трябва да върне null')
    })

    // ─── Директни SQL manipulации за finished_at граничните тестове —
    // recordMatchFinished винаги пише CURRENT_TIMESTAMP (сега), затова за
    // >2h/<2h сценариите пипаме finished_at директно през raw SQL, mirror на
    // established конвенцията в checkTopicUnreadSeen.ts/likeStore checks за
    // time-window граници.
    const rawDb = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })

    await check('[8] listFinishedMatches(2h) НЕ връща мач, приключил преди >2 часа', () => {
      store.recordMatchStarted({ roomId: 'room-old', privateRoomId: 'private-old', stake: 1000, teamA, teamB })
      store.recordMatchFinished('room-old', 100, 50)
      rawDb.prepare(`UPDATE private_room_matches SET finished_at = datetime('now', '-3 hours') WHERE room_id = ?;`).run('room-old')

      const finished = store.listFinishedMatches(2)
      assert(!finished.some((m) => m.roomId === 'room-old'), 'room-old (>2h) не трябва да е в 2h прозореца')
    })

    await check('[9] listFinishedMatches(2h) ВРЪЩА мач, приключил преди <2 часа', () => {
      store.recordMatchStarted({ roomId: 'room-recent', privateRoomId: 'private-recent', stake: 1000, teamA, teamB })
      store.recordMatchFinished('room-recent', 80, 60)
      rawDb.prepare(`UPDATE private_room_matches SET finished_at = datetime('now', '-1 hours') WHERE room_id = ?;`).run('room-recent')

      const finished = store.listFinishedMatches(2)
      assert(finished.some((m) => m.roomId === 'room-recent'), 'room-recent (<2h) трябва да е в 2h прозореца')
    })

    await check('[7b] room-old (>2h, отпаднал от listFinishedMatches) остава физически в DB (getMatch)', () => {
      const match = store.getMatch('room-old')
      assert(match !== null, 'room-old записът НЕ трябва да е изтрит от DB само защото е извън 2h visibility прозореца')
    })

    await check('[10] listFinishedMatches подрежда най-новите (finished_at DESC) първи', () => {
      const finished = store.listFinishedMatches(24)
      const idxRecent = finished.findIndex((m) => m.roomId === 'room-recent')
      const idxOld = finished.findIndex((m) => m.roomId === 'room-old')
      assert(idxRecent !== -1 && idxOld !== -1, 'и двата записа трябва да са в 24h прозореца')
      assert(idxRecent < idxOld, 'room-recent (по-нов finished_at) трябва да е ПРЕДИ room-old в списъка')
    })

    await check('[14] listPlayingMatches НЕ връща finished мачове', () => {
      const playing = store.listPlayingMatches()
      assert(!playing.some((m) => m.roomId === 'room-old' || m.roomId === 'room-recent'), 'finished мачове не трябва да се появяват в listPlayingMatches')
    })

    rawDb.close()
  } finally {
    store.close()
  }
})

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
