import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentCoordinator } from '../src/tournament/tournamentCoordinator.js'
import type { PlayerPublicProfileSnapshot, Seat, ServerRoom } from '../src/core/serverTypes.js'

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
    displayName: `Stage8 Player ${index + 1}`,
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
  `).run(profileId, `Stage8 Player ${index + 1}`, `stage8 player ${index + 1}`)
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
  `).run(tournamentId, `Stage8 ${tournamentId.slice(0, 8)}`, creatorProfileId)
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
} {
  return database.prepare(`
    SELECT match_id as matchId, room_id as roomId, team_a_id as teamAId, team_b_id as teamBId, status
    FROM tournament_matches
    WHERE tournament_id = ?
    ORDER BY created_at ASC
    LIMIT 1;
  `).get(tournamentId) as { matchId: string; roomId: string; teamAId: string; teamBId: string; status: string }
}

function teamProfiles(database: DatabaseSync, teamId: string): string[] {
  return (database.prepare(`
    SELECT profile_id as profileId
    FROM tournament_entries
    WHERE team_id = ?
    ORDER BY created_at ASC;
  `).all(teamId) as Array<{ profileId: string }>).map((row) => row.profileId)
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

console.log('\ncheckTournamentStage8Behavior')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-stage8-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let coordinator: Awaited<ReturnType<typeof createTournamentCoordinator>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  economyStore = await createTournamentEconomyStore(dbPath)

  const profiles = Array.from({ length: 24 }, () => randomUUID())
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
    isConnectionAttached: ({ profileId, connectionId, roomId, seat }) => attachedConnections.has(`${profileId}:${connectionId}:${roomId}:${seat}`),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })

  const allPresentTournamentId = randomUUID()
  insertReadyTournament(db, allPresentTournamentId, profiles[0]!, profiles.slice(0, 8))
  check('all-present fixture starts', economyStore.startTournamentAtomically(allPresentTournamentId, new Date('2026-07-30T10:00:00.000Z')).ok)
  coordinator.tickNow()
  let allPresentMatch = firstMatch(db, allPresentTournamentId)
  let allPresentRoom = rooms.get(allPresentMatch.roomId)!
  allPresentRoom = connectSeat(allPresentRoom, 'bottom', 'conn-bottom', attachedConnections)
  allPresentRoom = connectSeat(allPresentRoom, 'top', 'conn-top', attachedConnections)
  allPresentRoom = connectSeat(allPresentRoom, 'right', 'conn-right', attachedConnections)
  allPresentRoom = connectSeat(allPresentRoom, 'left', 'conn-left', attachedConnections)
  rooms.set(allPresentRoom.id, allPresentRoom)
  coordinator.tickNow()
  allPresentMatch = firstMatch(db, allPresentTournamentId)
  check('all-present match enters countdown', allPresentMatch.status === 'countdown')
  db.prepare(`UPDATE tournament_matches SET game_start_at = '2026-07-30T09:59:00.000Z' WHERE match_id = ?;`).run(allPresentMatch.matchId)
  coordinator.tickNow()
  allPresentMatch = firstMatch(db, allPresentTournamentId)
  allPresentRoom = rooms.get(allPresentMatch.roomId)!
  check('all-present match starts game once countdown expires', allPresentMatch.status === 'in_progress' && allPresentRoom.game.authoritativeState !== null)
  check('all-present match does not insert no-show bots', countRows(db, `SELECT COUNT(*) as count FROM tournament_match_no_show_replacements WHERE tournament_id = ?;`, allPresentTournamentId) === 0)

  const walkoverTournamentId = randomUUID()
  insertReadyTournament(db, walkoverTournamentId, profiles[8]!, profiles.slice(8, 16))
  check('walkover fixture starts', economyStore.startTournamentAtomically(walkoverTournamentId, new Date('2026-07-30T10:10:00.000Z')).ok)
  coordinator.tickNow()
  const walkoverMatchInitial = firstMatch(db, walkoverTournamentId)
  let walkoverRoom = rooms.get(walkoverMatchInitial.roomId)!
  walkoverRoom = connectSeat(walkoverRoom, 'bottom', 'walk-bottom', attachedConnections)
  walkoverRoom = connectSeat(walkoverRoom, 'top', 'walk-top', attachedConnections)
  rooms.set(walkoverRoom.id, walkoverRoom)
  const walkoverBalanceBefore = walletTotal(db, profiles.slice(8, 16))
  db.prepare(`UPDATE tournament_matches SET attendance_deadline_at = '2026-07-30T09:59:00.000Z', no_show_deadline_at = '2026-07-30T09:59:00.000Z' WHERE match_id = ?;`).run(walkoverMatchInitial.matchId)
  coordinator.tickNow()
  const walkoverMatch = firstMatch(db, walkoverTournamentId)
  check('one-sided missing team resolves as walkover', walkoverMatch.status === 'completed' && countRows(db, `SELECT COUNT(*) as count FROM tournament_matches WHERE match_id = ? AND result_kind = 'walkover' AND winner_team_id = ?;`, walkoverMatch.matchId, walkoverMatch.teamAId) === 1)
  check('walkover does not create no-show replacements', countRows(db, `SELECT COUNT(*) as count FROM tournament_match_no_show_replacements WHERE tournament_id = ?;`, walkoverTournamentId) === 0)
  check('walkover does not mutate tournament wallets or prize ledger', walletTotal(db, profiles.slice(8, 16)) === walkoverBalanceBefore && countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, walkoverTournamentId) === 0)

  const botsTournamentId = randomUUID()
  insertReadyTournament(db, botsTournamentId, profiles[16]!, profiles.slice(16, 24))
  check('bot-fill fixture starts', economyStore.startTournamentAtomically(botsTournamentId, new Date('2026-07-30T10:20:00.000Z')).ok)
  coordinator.tickNow()
  let botsMatch = firstMatch(db, botsTournamentId)
  let botsRoom = rooms.get(botsMatch.roomId)!
  botsRoom = connectSeat(botsRoom, 'bottom', 'bot-bottom', attachedConnections)
  botsRoom = connectSeat(botsRoom, 'right', 'bot-right', attachedConnections)
  rooms.set(botsRoom.id, botsRoom)
  const botBalanceBefore = walletTotal(db, profiles.slice(16, 24))
  db.prepare(`UPDATE tournament_matches SET attendance_deadline_at = '2026-07-30T09:59:00.000Z', no_show_deadline_at = '2026-07-30T09:59:00.000Z' WHERE match_id = ?;`).run(botsMatch.matchId)
  coordinator.tickNow()
  botsMatch = firstMatch(db, botsTournamentId)
  botsRoom = rooms.get(botsMatch.roomId)!
  check('two-sided missing players insert bots and countdown', botsMatch.status === 'countdown' && countRows(db, `SELECT COUNT(*) as count FROM tournament_match_no_show_replacements WHERE match_id = ?;`, botsMatch.matchId) === 2)
  check('bot-fill does not mutate wallets or prize ledger', walletTotal(db, profiles.slice(16, 24)) === botBalanceBefore && countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, botsTournamentId) === 0)
  const replacement = db.prepare(`
    SELECT assigned_profile_id as profileId, assigned_seat as seat, reconnect_token as reconnectToken
    FROM tournament_match_no_show_replacements
    WHERE match_id = ?
    ORDER BY inserted_at ASC
    LIMIT 1;
  `).get(botsMatch.matchId) as { profileId: string; seat: Seat; reconnectToken: string }
  const wrongTakeover = coordinator.tryTakeoverNoShowBot({
    room: botsRoom,
    profileId: profiles[16]!,
    connectionId: 'wrong-conn',
    reconnectToken: replacement.reconnectToken,
  })
  check('bot takeover rejects wrong profile', !wrongTakeover.ok && wrongTakeover.reason === 'invalid_profile')
  const takeover = coordinator.tryTakeoverNoShowBot({
    room: botsRoom,
    profileId: replacement.profileId,
    connectionId: 'takeover-conn',
    reconnectToken: replacement.reconnectToken,
  })
  check('bot takeover restores the assigned human seat', takeover.ok && takeover.seat === replacement.seat && takeover.room.seats[replacement.seat].participant?.kind === 'human')
  check('bot takeover marks replacement completed', countRows(db, `SELECT COUNT(*) as count FROM tournament_match_no_show_replacements WHERE match_id = ? AND assigned_profile_id = ? AND status = 'completed';`, botsMatch.matchId, replacement.profileId) === 1)

  db.prepare(`UPDATE tournament_matches SET game_start_at = '2026-07-30T09:59:00.000Z' WHERE match_id = ?;`).run(botsMatch.matchId)
  coordinator.tickNow()
  botsMatch = firstMatch(db, botsTournamentId)
  check('bot-fill match starts after takeover/countdown', botsMatch.status === 'in_progress')
  check('coordinator health exposes Stage 8/9 counters', coordinator.getHealth().gameStartsLastTick >= 1 && typeof coordinator.getHealth().settlementAttemptsLastTick === 'number')
} finally {
  try { coordinator?.close() } catch {}
  try { economyStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentStage8Behavior failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentStage8Behavior passed: ${passed} checks`)
