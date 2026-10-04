/**
 * checkTournamentTechnicalRematch.ts
 *
 * Deterministic, non-HTTP coordinator test for the "technical rematch from
 * 0-0" tournament policy (fix brief §7/§8/§9). The heavy HTTP tournament
 * E2E (checkTournamentRoomStartAndCleanup.ts) is currently blocked by an
 * unrelated registration-fixture issue (HTTP 400 before it even reaches
 * room logic) — per the brief's explicit instruction, that test is NOT
 * modified to force it green. Instead this file drives the REAL
 * createTournamentCoordinator + REAL abortQuarantinedRoom functions
 * directly against a real (temp) SQLite DB, using the exact same
 * fake-room-runtime DI pattern already proven in
 * checkTournamentStage8Behavior.ts (tickNow(), a plain `rooms` Map,
 * no HTTP, no real timers).
 *
 * Proves, end to end:
 *  [1] an active ('in_progress') tournament match's room can be torn down
 *      via the REAL, generic abortQuarantinedRoom (same function every
 *      other technical-abort scenario uses) WITHOUT touching
 *      tournament_matches.status/result_kind/winner_team_id/completed_at
 *      — i.e. no winner is fabricated, no walkover, no settlement
 *  [2] zero tournament_economy_ledger mutation (no prize_payout row, no
 *      wallet change) — the generic refund path finds nothing to refund,
 *      exactly as the stakeAmount=0 invariant predicts
 *  [3] the coordinator's OWN, already-shipped ensureMatchRoom() self-heal
 *      (driven by a normal tickNow(), not special-cased by this fix at
 *      all) notices the missing room on its very next tick and rebuilds a
 *      FRESH ('bootstrap' phase, no dealt hand — i.e. 0-0) room for the
 *      SAME match_id/room_id, with the same 4 participants reseated at
 *      their original seats
 *  [4] the OLD (corrupted) room object is gone — a reconnect using its
 *      state can no longer reach it; only the NEW room object is keyed
 *      under the room id going forward
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentCoordinator } from '../src/tournament/tournamentCoordinator.js'
import { abortQuarantinedRoom, type AbortQuarantinedRoomDependencies } from '../src/core/abortQuarantinedRoom.js'
import type { PlayerPublicProfileSnapshot, Seat, ServerRoom, ServerState } from '../src/core/serverTypes.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok ${label}`)
    passed += 1
  } else {
    console.error(`  FAIL ${label}`)
    failed += 1
  }
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function loadMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const getApplied = database.prepare(`SELECT filename FROM server_migrations WHERE filename = ? LIMIT 1;`)
  const insertApplied = database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`)
  for (const filename of await loadMigrationFileNames()) {
    if (getApplied.get(filename) !== undefined) continue
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      continue
    }
    database.exec('BEGIN;')
    try {
      database.exec(sql)
      insertApplied.run(filename)
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw new Error(`Failed to apply migration ${filename}: ${String(error)}`)
    }
  }
}

function publicProfile(profileId: string, index: number): PlayerPublicProfileSnapshot {
  return {
    profileId,
    displayName: `Rematch Player ${index + 1}`,
    avatarUrl: null,
    level: 1,
    rankTitle: 'Test',
    skillRating: 1000,
    completedGamesCount: 0,
    wonGamesCount: 0,
    currentRankGames: 0,
    nextRankGames: 10,
    gamesUntilNextRank: 10,
    rankProgressRatio: 0,
    averageRating: null,
    totalRatingsCount: null,
    yellowCoinsBalance: 100_000,
    galleryImages: [],
    gender: null,
    likesCount: null,
    hasLikedByMe: null,
    isBlockedByMe: null,
  }
}

function insertProfile(database: DatabaseSync, profileId: string, index: number): void {
  database.prepare(`
    INSERT INTO profiles (profile_id, display_name, normalized_display_name)
    VALUES (?, ?, ?);
  `).run(profileId, `Rematch Player ${index + 1}`, `rematch player ${index + 1}`)
  database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 100000);
  `).run(profileId)
}

function insertReadyTournament(database: DatabaseSync, tournamentId: string, creatorProfileId: string, profiles: string[]): void {
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 5000, 8, 'fill', NULL, 'open');
  `).run(tournamentId, `Rematch ${tournamentId.slice(0, 8)}`, creatorProfileId)
  for (const profileId of profiles) {
    database.prepare(`
      INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
      VALUES (?, ?, ?, NULL, 'solo', 'confirmed');
    `).run(randomUUID(), tournamentId, profileId)
    database.prepare(`
      INSERT INTO tournament_economy_ledger (
        ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after
      ) VALUES (?, ?, ?, ?, 'entry_fee_debit', 5000, 95000);
    `).run(randomUUID(), `tournament:${tournamentId}:profile:${profileId}:entry-fee-debit`, tournamentId, profileId)
    database.prepare(`UPDATE profile_wallets SET yellow_coins_balance = 95000 WHERE profile_id = ?;`).run(profileId)
  }
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

function firstMatch(database: DatabaseSync, tournamentId: string): {
  matchId: string
  roomId: string
  teamAId: string
  teamBId: string
  status: string
  resultKind: string | null
  winnerTeamId: string | null
  completedAt: string | null
} {
  return database.prepare(`
    SELECT match_id as matchId, room_id as roomId, team_a_id as teamAId, team_b_id as teamBId,
           status, result_kind as resultKind, winner_team_id as winnerTeamId, completed_at as completedAt
    FROM tournament_matches
    WHERE tournament_id = ?
    ORDER BY created_at ASC
    LIMIT 1;
  `).get(tournamentId) as {
    matchId: string; roomId: string; teamAId: string; teamBId: string
    status: string; resultKind: string | null; winnerTeamId: string | null; completedAt: string | null
  }
}

function connectSeat(room: ServerRoom, seat: Seat, connectionId: string, attachedConnections: Set<string>): ServerRoom {
  const participant = room.seats[seat].participant
  if (participant?.kind !== 'human' || participant.identity.profileId === null) return room
  const connected = {
    ...participant,
    connectionId,
    isConnected: true,
    lastSeenAt: Date.now(),
  }
  attachedConnections.add(`${participant.identity.profileId}:${connectionId}:${room.id}:${seat}`)
  return {
    ...room,
    seats: {
      ...room.seats,
      [seat]: { ...room.seats[seat], participant: connected },
    },
  }
}

function walletTotal(database: DatabaseSync, profiles: string[]): number {
  return (database.prepare(`
    SELECT COALESCE(SUM(yellow_coins_balance), 0) as total
    FROM profile_wallets
    WHERE profile_id IN (${profiles.map(() => '?').join(', ')});
  `).get(...profiles) as { total: number }).total
}

function seatedProfileIds(room: ServerRoom): string[] {
  const ids: string[] = []
  for (const seat of Object.keys(room.seats) as Seat[]) {
    const participant = room.seats[seat].participant
    if (participant?.kind === 'human' && participant.identity.profileId !== null) {
      ids.push(participant.identity.profileId)
    }
  }
  return ids.sort()
}

console.log('\ncheckTournamentTechnicalRematch')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-rematch-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let coordinator: Awaited<ReturnType<typeof createTournamentCoordinator>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  economyStore = await createTournamentEconomyStore(dbPath)

  const profiles = Array.from({ length: 8 }, () => randomUUID())
  profiles.forEach((profileId, index) => insertProfile(db!, profileId, index))
  const profileSnapshots = new Map(profiles.map((profileId, index) => [profileId, publicProfile(profileId, index)]))
  const rooms = new Map<string, ServerRoom>()
  const attachedConnections = new Set<string>()

  coordinator = await createTournamentCoordinator({
    databaseFilePath: dbPath,
    getPublicProfile: (profileId) => profileSnapshots.get(profileId) ?? null,
    getRoom: (roomId) => rooms.get(roomId) ?? null,
    commitRoom: (room) => { rooms.set(room.id, room) },
    ensureRoomRuntime: () => ({ ok: true }),
    settleTournamentPrizes: () => ({ ok: false, reason: 'not_final' }),
    notifyAssignment: () => {},
    notifyFeederMatchCompleted: () => {},
    notifyFeederScoreProgress: () => {},
    isConnectionAttached: ({ profileId, connectionId, roomId, seat }) => attachedConnections.has(`${profileId}:${connectionId}:${roomId}:${seat}`),
    isProfileOnline: (profileId) => {
      for (const key of attachedConnections) {
        if (key.startsWith(`${profileId}:`)) return true
      }
      return false
    },
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })

  const tournamentId = randomUUID()
  insertReadyTournament(db, tournamentId, profiles[0]!, profiles)
  check('[setup] fixture tournament starts', economyStore.startTournamentAtomically(tournamentId, new Date('2026-08-01T10:00:00.000Z')).ok)
  coordinator.tickNow()

  let match = firstMatch(db, tournamentId)
  let room = rooms.get(match.roomId)!
  room = connectSeat(room, 'bottom', 'conn-bottom', attachedConnections)
  room = connectSeat(room, 'top', 'conn-top', attachedConnections)
  room = connectSeat(room, 'right', 'conn-right', attachedConnections)
  room = connectSeat(room, 'left', 'conn-left', attachedConnections)
  rooms.set(room.id, room)
  coordinator.tickNow()
  match = firstMatch(db, tournamentId)
  check('[setup] match enters countdown once all 4 are present', match.status === 'countdown')

  db.prepare(`UPDATE tournament_matches SET game_start_at = '2026-08-01T09:59:00.000Z' WHERE match_id = ?;`).run(match.matchId)
  coordinator.tickNow()
  match = firstMatch(db, tournamentId)
  const corruptedRoomId = match.roomId
  const corruptedRoom = rooms.get(corruptedRoomId)!
  check('[setup] match is in_progress with a real authoritative game state', match.status === 'in_progress' && corruptedRoom.game.authoritativeState !== null)

  const originalSeatedProfiles = seatedProfileIds(corruptedRoom)
  check('[setup] all 4 original participants are seated', originalSeatedProfiles.length === 4)

  const prizePayoutsBefore = countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId)
  const ledgerRowsBefore = countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ?;`, tournamentId)
  const walletTotalBefore = walletTotal(db, profiles)

  // --- "the room becomes technically unrecoverable" — torn down via the
  // REAL, generic abortQuarantinedRoom, exactly as roomTickRecoveryPipeline
  // would after exhausting worker-level recovery. No tournament code is
  // called here at all.
  const fakeServerState: ServerState = { startedAt: 0, connections: {}, rooms: { [corruptedRoomId]: corruptedRoom } }
  let refundCallCount = 0
  const abortDeps: AbortQuarantinedRoomDependencies = {
    finalizeActiveTableGiftImagesForRoom: () => {},
    cleanupTempBotsFromRoom: () => {},
    markRoomSnapshotRemoved: () => {},
    removeRuntimeRoom: () => {},
    removeHealthTracking: () => {},
    isPrivateTableOriginRoom: () => false,
    deleteOrphanedPrivateMatchRow: () => false,
    forgetPrivateGameScoreDedup: () => {},
    broadcastPrivateGamesListToLobbyConnections: () => {},
    refundStakes: () => {
      refundCallCount += 1
      return { ok: true, refunds: [] }
    },
    log: () => {},
  }
  const abortResult = abortQuarantinedRoom(
    fakeServerState,
    corruptedRoomId,
    'simulated-deterministic-compute-failure',
    (roomId, state) => {
      rooms.delete(roomId)
      const nextRooms = { ...state.rooms }
      delete nextRooms[roomId]
      return { ...state, rooms: nextRooms }
    },
    abortDeps,
  )

  check('[1] abortQuarantinedRoom tears the corrupted room down successfully', abortResult.aborted === true && abortResult.refusalKind === null)
  check('[1] refund IS attempted (generic path) exactly once, and is a trivial no-op', refundCallCount === 1 && abortResult.refunds.length === 0)
  check('[1] the room is gone from the shared rooms registry the coordinator reads from', rooms.get(corruptedRoomId) === undefined)

  const matchRightAfterTeardown = firstMatch(db, tournamentId)
  check('[1] tournament_matches.status is UNCHANGED (still in_progress) — no winner/walkover/settlement fabricated', matchRightAfterTeardown.status === 'in_progress')
  check('[1] result_kind/winner_team_id/completed_at are all still null', matchRightAfterTeardown.resultKind === null && matchRightAfterTeardown.winnerTeamId === null && matchRightAfterTeardown.completedAt === null)

  check('[2] zero NEW tournament_economy_ledger rows (no prize_payout, no duplicate charge)', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ?;`, tournamentId) === ledgerRowsBefore)
  check('[2] zero prize_payout rows', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId) === prizePayoutsBefore)
  check('[2] wallet totals for all 8 participants are byte-for-byte unchanged', walletTotal(db, profiles) === walletTotalBefore)

  // --- the coordinator's OWN next reconciliation tick, completely
  // unaware anything special happened — it just sees a runnable
  // 'in_progress' match whose room_id no longer resolves to a room.
  coordinator.tickNow()

  const matchAfterRematch = firstMatch(db, tournamentId)
  check('[3] SAME match_id/room_id after the self-heal (no new match/bracket row)', matchAfterRematch.matchId === match.matchId && matchAfterRematch.roomId === corruptedRoomId)
  check('[3] match is still in_progress (never flipped to completed by this path)', matchAfterRematch.status === 'in_progress')

  const rebuiltRoom = rooms.get(corruptedRoomId)
  check('[3] a NEW room object now exists under the same room id', rebuiltRoom !== undefined)
  check('[4] the rebuilt room is a DIFFERENT object than the corrupted one — the old one cannot be reached again', rebuiltRoom !== corruptedRoom)
  // buildRoom() produces a fresh 'bootstrap'-phase room (no cards dealt
  // yet, no authoritative play state) — this IS the "0-0 rematch" proof:
  // the corrupted room was a real in-progress hand (checked above via
  // `corruptedRoom.game.authoritativeState !== null` with no 'kind'
  // discriminator), while the rebuilt one starts completely over, exactly
  // like any brand-new tournament match room.
  check(
    '[3] the rebuilt room is freshly bootstrapped (0-0 / no dealt hand) — a genuine fresh rematch, not the old hand\'s progress',
    rebuiltRoom?.game.phase === 'bootstrap',
  )
  check('[3] the same 4 original participants are reseated in the rebuilt room', JSON.stringify(seatedProfileIds(rebuiltRoom!)) === JSON.stringify(originalSeatedProfiles))
  check('[3] tournament-origin markers are preserved on the rebuilt room', rebuiltRoom?.config.isTournamentMatchOrigin === true && rebuiltRoom?.config.tournamentMatchId === match.matchId)

  check('[2] still zero prize_payout rows after the self-heal tick', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId) === prizePayoutsBefore)
  check('[2] wallet totals still unchanged after the self-heal tick', walletTotal(db, profiles) === walletTotalBefore)
} finally {
  try { coordinator?.close() } catch {}
  try { economyStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentTechnicalRematch failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentTechnicalRematch passed: ${passed} checks`)
