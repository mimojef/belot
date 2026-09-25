/**
 * checkLudoRoomMatchStore.ts
 *
 * Store-level checks за ludo_room_matches (20260925_001 migration) —
 * персистентен history за "Играещи"/"Приключили" lobby табовете на
 * /games/ludo. Виж ludoRoomMatchStore.ts за пълния rationale (защо е
 * отделна таблица от active_ludo_match_snapshots, защо никога не трие
 * редове, защо 2-часовият "Приключили" прозорец е WHERE filter а не
 * cleanup job). Mirror на checkPrivateRoomMatchStore.ts, individual game —
 * един players масив вместо team A/B.
 *
 * [1]  recordMatchStarted вмъква ред със status='playing'
 * [2]  listPlayingMatches връща стартираната игра
 * [3]  finished мач изчезва от listPlayingMatches
 * [4]  finished мач се появява в listFinishedMatches(2h)
 * [5]  recordMatchFinished маркира status='finished', задава finished_at, winner_profile_id
 * [6]  DB редът НЕ се трие след finish (getMatch все още го намира)
 * [7]  listFinishedMatches(2h) НЕ връща мач, приключил преди >2 часа
 * [8]  listFinishedMatches(2h) ВРЪЩА мач, приключил преди <2 часа
 * [9]  listFinishedMatches подрежда най-новите (finished_at DESC) първи
 * [10] recordMatchStarted е idempotent при повторен matchId (ON CONFLICT DO NOTHING)
 * [11] players JSON round-trip запазва color/profileId/displayName
 * [12] listPlayingMatches НЕ връща finished мачове
 * [13] getMatch връща null за несъществуващ matchId
 * [14] recordMatchFinished с winnerProfileId=null (forfeit без winner) не хвърля грешка
 *
 * Boot-recovery gap regression (viж index.ts restoredLudoMatches loop):
 * [A]  started match с вече записан history row -> recovery recordMatchStarted е no-op, без duplicate
 * [B]  active snapshot БЕЗ history row -> recovery hook създава playing row от restored authoritative данни
 * [C]  след B -> match finish -> същият history row става finished, появява се в listFinishedMatches()
 * [D]  winner/player snapshot остава правилен след recovery+finish
 * [B2] crash между finish и settle -> started+finished записани в един recovery pass, idempotent
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createLudoRoomMatchStore, type LudoRoomMatchOccupant } from '../src/db/ludoRoomMatchStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationPath = resolve(serverRoot, 'database/migrations/20260925_001_create_ludo_room_matches.sql')

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-ludo-room-match-check-'))
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

function makeOccupant(overrides: Partial<LudoRoomMatchOccupant> = {}): LudoRoomMatchOccupant {
  return {
    profileId: 'profile-1',
    displayName: 'Player One',
    avatarUrl: null,
    color: 'red',
    ...overrides,
  }
}

console.log('\ncheckLudoRoomMatchStore\n')

await withTempDir(async (dir) => {
  const dbFile = join(dir, 'test.sqlite')
  const setupDb = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  await applyMigrationFile(setupDb, migrationPath)
  setupDb.close()

  const store = await createLudoRoomMatchStore(dbFile)

  try {
    const players4: LudoRoomMatchOccupant[] = [
      makeOccupant({ profileId: 'p1', displayName: 'Ани', color: 'red' }),
      makeOccupant({ profileId: 'p2', displayName: 'Bot Ivan', color: 'blue', avatarUrl: null }),
      makeOccupant({ profileId: 'p3', displayName: 'Мария', color: 'green' }),
      makeOccupant({ profileId: 'p4', displayName: 'Georgi', color: 'yellow' }),
    ]

    await check('[1] recordMatchStarted вмъква ред със status=playing', () => {
      store.recordMatchStarted({ matchId: 'match-1', ludoRoomId: 'room-1', stake: 5000, playerCount: 4, players: players4 })
      const match = store.getMatch('match-1')
      assert(match !== null, 'match трябва да съществува')
      assertEqual(match!.status, 'playing', 'status трябва да е playing')
      assertEqual(match!.stake, 5000, 'stake трябва да е запазен')
      assertEqual(match!.playerCount, 4, 'playerCount трябва да е запазен')
    })

    await check('[2] listPlayingMatches връща стартираната игра', () => {
      const playing = store.listPlayingMatches()
      assert(playing.some((m) => m.matchId === 'match-1'), 'match-1 трябва да е в playing списъка')
    })

    await check('[11] players JSON round-trip запазва color/profileId/displayName', () => {
      const match = store.getMatch('match-1')
      assertEqual(match!.players.length, 4, 'players масивът трябва да има 4 записа')
      assertEqual(match!.players[0]!.color, 'red', 'players[0] color round-trip')
      assertEqual(match!.players[2]!.displayName, 'Мария', 'кирилски displayName round-trip')
      assertEqual(match!.players[3]!.profileId, 'p4', 'players[3] profileId round-trip')
    })

    await check('[5] recordMatchFinished маркира finished + finished_at + winner_profile_id', () => {
      store.recordMatchFinished('match-1', 'p1')
      const match = store.getMatch('match-1')
      assertEqual(match!.status, 'finished', 'status трябва да е finished')
      assertEqual(match!.winnerProfileId, 'p1', 'winnerProfileId трябва да е запазен')
      assert(match!.finishedAt !== null, 'finishedAt трябва да е зададен')
    })

    await check('[3] finished мач изчезва от listPlayingMatches', () => {
      const playing = store.listPlayingMatches()
      assert(!playing.some((m) => m.matchId === 'match-1'), 'match-1 не трябва да е в playing списъка след finish')
    })

    await check('[4] finished мач се появява в listFinishedMatches(2h)', () => {
      const finished = store.listFinishedMatches(2)
      assert(finished.some((m) => m.matchId === 'match-1'), 'match-1 трябва да е в finished(2h) списъка')
    })

    await check('[6] DB редът НЕ се трие след finish (getMatch все още го намира)', () => {
      const match = store.getMatch('match-1')
      assert(match !== null, 'записът трябва да остане в DB — 2h прозорецът е read-filter, не delete')
    })

    await check('[10] recordMatchStarted е idempotent при повторен matchId', () => {
      store.recordMatchStarted({ matchId: 'match-1', ludoRoomId: 'room-1-different', stake: 9999, playerCount: 2, players: players4.slice(0, 2) })
      const match = store.getMatch('match-1')
      assertEqual(match!.status, 'finished', 'повторен recordMatchStarted не трябва да презапише вече finished запис')
      assertEqual(match!.stake, 5000, 'оригиналният stake трябва да остане')
      assertEqual(match!.playerCount, 4, 'оригиналният playerCount трябва да остане')
    })

    await check('[13] getMatch връща null за несъществуващ matchId', () => {
      assertEqual(store.getMatch('does-not-exist'), null, 'несъществуващ matchId трябва да върне null')
    })

    await check('[14] recordMatchFinished с winnerProfileId=null (forfeit без ясен winner) не хвърля грешка', () => {
      store.recordMatchStarted({ matchId: 'match-forfeit', ludoRoomId: 'room-forfeit', stake: 1000, playerCount: 2, players: players4.slice(0, 2) })
      store.recordMatchFinished('match-forfeit', null)
      const match = store.getMatch('match-forfeit')
      assertEqual(match!.status, 'finished', 'status трябва да е finished дори без winner')
      assertEqual(match!.winnerProfileId, null, 'winnerProfileId трябва да остане null')
    })

    // ─── Директни SQL manipulации за finished_at граничните тестове —
    // recordMatchFinished винаги пише CURRENT_TIMESTAMP (сега), затова за
    // >2h/<2h сценариите пипаме finished_at директно през raw SQL, mirror на
    // established конвенцията в checkPrivateRoomMatchStore.ts.
    const rawDb = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })

    await check('[7] listFinishedMatches(2h) НЕ връща мач, приключил преди >2 часа', () => {
      store.recordMatchStarted({ matchId: 'match-old', ludoRoomId: 'room-old', stake: 1000, playerCount: 2, players: players4.slice(0, 2) })
      store.recordMatchFinished('match-old', 'p1')
      rawDb.prepare(`UPDATE ludo_room_matches SET finished_at = datetime('now', '-3 hours') WHERE match_id = ?;`).run('match-old')

      const finished = store.listFinishedMatches(2)
      assert(!finished.some((m) => m.matchId === 'match-old'), 'match-old (>2h) не трябва да е в 2h прозореца')
    })

    await check('[8] listFinishedMatches(2h) ВРЪЩА мач, приключил преди <2 часа', () => {
      store.recordMatchStarted({ matchId: 'match-recent', ludoRoomId: 'room-recent', stake: 1000, playerCount: 2, players: players4.slice(0, 2) })
      store.recordMatchFinished('match-recent', 'p2')
      rawDb.prepare(`UPDATE ludo_room_matches SET finished_at = datetime('now', '-1 hours') WHERE match_id = ?;`).run('match-recent')

      const finished = store.listFinishedMatches(2)
      assert(finished.some((m) => m.matchId === 'match-recent'), 'match-recent (<2h) трябва да е в 2h прозореца')
    })

    await check('[6b] match-old (>2h, отпаднал от listFinishedMatches) остава физически в DB (getMatch)', () => {
      const match = store.getMatch('match-old')
      assert(match !== null, 'match-old записът НЕ трябва да е изтрит от DB само защото е извън 2h visibility прозореца')
    })

    await check('[9] listFinishedMatches подрежда най-новите (finished_at DESC) първи', () => {
      const finished = store.listFinishedMatches(24)
      const idxRecent = finished.findIndex((m) => m.matchId === 'match-recent')
      const idxOld = finished.findIndex((m) => m.matchId === 'match-old')
      assert(idxRecent !== -1 && idxOld !== -1, 'и двата записа трябва да са в 24h прозореца')
      assert(idxRecent < idxOld, 'match-recent (по-нов finished_at) трябва да е ПРЕДИ match-old в списъка')
    })

    await check('[12] listPlayingMatches НЕ връща finished мачове', () => {
      const playing = store.listPlayingMatches()
      assert(!playing.some((m) => m.matchId === 'match-old' || m.matchId === 'match-recent'), 'finished мачове не трябва да се появяват в listPlayingMatches')
    })

    // ─── Boot-recovery gap regression (виж index.ts: restoredLudoMatches
    // loop, hook добавен до ludoMatchRuntime.restoreMatch()) — симулира
    // точно логиката на recovery hook-а: recordMatchStarted със същия
    // matchId от persisted snapshot-а (idempotent при вече съществуващ ред),
    // recordMatchFinished ако persisted.state.status==='finished' в момента
    // на restore. Не спавва реален сървър/restart — store-level check на
    // exact call shape-а, mirror на established конвенцията в този файл.

    await check('[A] started match с вече записан history row -> "recovery" recordMatchStarted е no-op, без duplicate', () => {
      store.recordMatchStarted({ matchId: 'match-normal-start', ludoRoomId: 'room-normal', stake: 2000, playerCount: 2, players: players4.slice(0, 2) })
      // Симулира recovery hook-а, викан за match, който normal start пътят
      // вече е записал ПРЕДИ crash-а — ON CONFLICT(match_id) DO NOTHING
      // трябва да остави оригиналния ред непроменен.
      store.recordMatchStarted({ matchId: 'match-normal-start', ludoRoomId: 'room-normal-DIFFERENT', stake: 9999, playerCount: 4, players: players4 })
      const match = store.getMatch('match-normal-start')
      assertEqual(match!.ludoRoomId, 'room-normal', 'recovery no-op не трябва да презапише оригиналния ludoRoomId')
      assertEqual(match!.stake, 2000, 'recovery no-op не трябва да презапише оригиналния stake')
      assertEqual(match!.playerCount, 2, 'recovery no-op не трябва да презапише оригиналния playerCount')
      const playing = store.listPlayingMatches()
      assertEqual(playing.filter((m) => m.matchId === 'match-normal-start').length, 1, 'не трябва да има duplicate ред за match-normal-start')
    })

    await check('[B] active snapshot БЕЗ history row -> recovery hook създава playing row от restored authoritative данни', () => {
      // Симулира match, който е бил создаден в runtime (createMatch), но
      // процесът е умрял ПРЕДИ ludoRoomsStore.onRoomReady->
      // recordLudoRoomMatchStarted да е изпълнил (или преди тази задача,
      // самият boot-recovery gap) — history row липсва изцяло, само
      // active_ludo_match_snapshots (persisted snapshot) съществува.
      assertEqual(store.getMatch('match-recovered'), null, 'match-recovered не трябва да съществува преди recovery hook-а')
      store.recordMatchStarted({
        matchId: 'match-recovered',
        ludoRoomId: 'room-recovered',
        stake: 3000,
        playerCount: 4,
        players: players4,
      })
      const match = store.getMatch('match-recovered')
      assert(match !== null, 'recovery hook трябва да създаде history row')
      assertEqual(match!.status, 'playing', 'recovered match трябва да е playing веднага след recovery')
      assertEqual(match!.stake, 3000, 'stake от persisted snapshot трябва да е запазен')
      const playing = store.listPlayingMatches()
      assert(playing.some((m) => m.matchId === 'match-recovered'), 'match-recovered трябва да се появи в "Играещи"')
    })

    await check('[C] след B -> match finish -> същият history row става finished и се появява в listFinishedMatches()', () => {
      store.recordMatchFinished('match-recovered', 'p1')
      const match = store.getMatch('match-recovered')
      assertEqual(match!.status, 'finished', 'match-recovered трябва да е finished')
      assert(match!.finishedAt !== null, 'finishedAt трябва да е зададен')
      const playing = store.listPlayingMatches()
      assert(!playing.some((m) => m.matchId === 'match-recovered'), 'match-recovered не трябва да остане в "Играещи" след finish')
      const finished = store.listFinishedMatches(2)
      assert(finished.some((m) => m.matchId === 'match-recovered'), 'match-recovered трябва да се появи в "Приключили"')
    })

    await check('[D] winner/player snapshot остава правилен след recovery+finish', () => {
      const match = store.getMatch('match-recovered')!
      assertEqual(match.winnerProfileId, 'p1', 'winnerProfileId трябва да е точно записаният')
      assertEqual(match.players.length, 4, 'players масивът трябва да пази всички 4 записа от restored snapshot-а')
      assertEqual(match.players[0]!.profileId, 'p1', 'players[0] profileId round-trip след recovery')
      assertEqual(match.players[2]!.displayName, 'Мария', 'кирилски displayName round-trip след recovery')
      assertEqual(match.players[3]!.color, 'yellow', 'color assignment round-trip след recovery')
    })

    await check('[B2] recovery hook за match, който в момента на restore вече е finished (crash между finish и settle) -> started+finished записани заедно, idempotent ред', () => {
      // Mirror на index.ts логиката: ако persisted.state.status==='finished'
      // ВЕЧЕ в snapshot-а при boot (crash е станал между commit() и
      // markMatchRemoved), recovery hook-ът вика recordMatchStarted
      // (idempotent create) И recordMatchFinished в същия boot pass.
      store.recordMatchStarted({
        matchId: 'match-crash-after-finish',
        ludoRoomId: 'room-crash-after-finish',
        stake: 500,
        playerCount: 2,
        players: players4.slice(0, 2),
      })
      store.recordMatchFinished('match-crash-after-finish', 'p2')
      const match = store.getMatch('match-crash-after-finish')
      assertEqual(match!.status, 'finished', 'started+finished в един recovery pass трябва да остави реда finished')
      assertEqual(match!.winnerProfileId, 'p2', 'winner трябва да е записан коректно')
      const playing = store.listPlayingMatches()
      assert(!playing.some((m) => m.matchId === 'match-crash-after-finish'), 'match, finished още при restore, не трябва да виси в "Играещи"')
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
