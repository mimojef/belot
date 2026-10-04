/**
 * checkDeleteOrphanedPrivateMatch.ts
 *
 * Deterministic, real-SQLite store tests for
 * privateRoomMatchStore.deleteOrphanedPlayingMatch — the ONLY new
 * private_room_matches write path added by the zombie-room second-layer
 * fix (root-cause audit: "session_in_game lock" §7 "Private room case").
 *
 * Deliberately a SEPARATE file from checkPrivateRoomMatchStore.ts (not
 * modifying that existing test) — mirrors its exact DB-setup pattern
 * (temp dir, real migration file, real createPrivateRoomMatchStore).
 *
 * This proves, against a real SQLite database:
 *  [1] a 'playing' row with EXACTLY the Hristina incident's signature
 *      (status='playing', finished_at=NULL, zero economy/result rows
 *      elsewhere — those tables are not even touched here) IS deleted
 *  [2] after deletion, getMatch() returns null and the row is gone from
 *      listPlayingMatches()
 *  [3] calling it a SECOND time for the same roomId is idempotent: returns
 *      false (nothing left to delete), does not throw
 *  [4] a 'finished' row (real match history) is NEVER deleted by this
 *      function, even if called directly on it — the safety guard this
 *      whole feature depends on
 *  [5] deleting an orphaned match does not affect ANY other room's row
 *      (playing or finished)
 *  [6] deleteOrphanedPlayingMatch on a roomId that never existed returns
 *      false without throwing
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
  const dir = await mkdtemp(join(tmpdir(), 'belot-orphan-private-match-check-'))
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

console.log('\ncheckDeleteOrphanedPrivateMatch\n')

await withTempDir(async (dir) => {
  const dbFile = join(dir, 'test.sqlite')
  const setupDb = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  await applyMigrationFile(setupDb, migrationPath)
  setupDb.close()

  const store = await createPrivateRoomMatchStore(dbFile)

  try {
    const teamA: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant] = [
      makeOccupant({ profileId: 'p1', displayName: 'Hristina' }),
      makeOccupant({ profileId: 'p2', displayName: 'Dario' }),
    ]
    const teamB: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant] = [
      makeOccupant({ profileId: 'p3', displayName: 'ANI777' }),
      makeOccupant({ profileId: 'p4', displayName: 'El888' }),
    ]

    // Exact shape of the Hristina incident: a 'playing' row, never
    // finished, never scored beyond its last update.
    store.recordMatchStarted({ roomId: 'zombie-room-1', privateRoomId: 'private-1', stake: 50000, teamA, teamB })

    await check('[1] a zombie-shaped "playing" row IS deleted', () => {
      const deleted = store.deleteOrphanedPlayingMatch('zombie-room-1')
      assert(deleted === true, 'deleteOrphanedPlayingMatch трябва да върне true при реално изтрит ред')
    })

    await check('[2] след изтриване getMatch() връща null и редът изчезва от listPlayingMatches()', () => {
      assertEqual(store.getMatch('zombie-room-1'), null, 'getMatch трябва да върне null')
      const playing = store.listPlayingMatches()
      assert(!playing.some((m) => m.roomId === 'zombie-room-1'), 'zombie-room-1 не трябва да е в playing списъка')
    })

    await check('[3] повторно извикване за същия roomId е idempotent (връща false, не хвърля)', () => {
      const deletedAgain = store.deleteOrphanedPlayingMatch('zombie-room-1')
      assertEqual(deletedAgain, false, 'втори опит не трябва да намери нищо за изтриване')
    })

    store.recordMatchStarted({ roomId: 'real-finished-room', privateRoomId: 'private-2', stake: 10000, teamA, teamB })
    store.recordMatchFinished('real-finished-room', 90, 60)

    await check('[4] "finished" ред (реална история) НИКОГА не се изтрива от deleteOrphanedPlayingMatch', () => {
      const deleted = store.deleteOrphanedPlayingMatch('real-finished-room')
      assertEqual(deleted, false, 'finished редовете трябва да останат напълно недосегнати')
      const match = store.getMatch('real-finished-room')
      assert(match !== null, 'finished match трябва да продължи да съществува')
      assertEqual(match!.status, 'finished', 'status трябва да остане finished')
      assertEqual(match!.teamAScore, 90, 'финалният резултат не трябва да се загуби')
    })

    store.recordMatchStarted({ roomId: 'other-still-playing', privateRoomId: 'private-3', stake: 20000, teamA, teamB })

    await check('[5] изтриване на orphan ред не засяга друга "playing"/"finished" ред', () => {
      store.recordMatchStarted({ roomId: 'zombie-room-2', privateRoomId: 'private-4', stake: 30000, teamA, teamB })
      store.deleteOrphanedPlayingMatch('zombie-room-2')

      const stillPlaying = store.getMatch('other-still-playing')
      assert(stillPlaying !== null && stillPlaying.status === 'playing', 'другата активна игра не трябва да бъде засегната')

      const stillFinished = store.getMatch('real-finished-room')
      assert(stillFinished !== null && stillFinished.status === 'finished', 'finished историята не трябва да бъде засегната')
    })

    await check('[6] deleteOrphanedPlayingMatch за никога несъществувал roomId връща false без грешка', () => {
      const deleted = store.deleteOrphanedPlayingMatch('never-existed-room')
      assertEqual(deleted, false, 'трябва да върне false, не да хвърли')
    })
  } finally {
    store.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
