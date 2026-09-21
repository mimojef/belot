// Focused проверка на 5 conflict/race/recovery сценария върху вече одобрения
// dependency-based (per-bracket-слот) tournament progression fix в
// ensureNextRound/advanceBracketLadder (tournamentCoordinator.ts). Не е общ
// audit — покрива само:
//   1) concurrent/repeated coordinator ticks не duplicate-ват target match/room;
//   2) restart МЕЖДУ target match creation и room claim/attendance start;
//   3) двата QF->SF клона (SF1 от QF1+QF2, SF2 от QF3+QF4) стават eligible
//      едновременно, независимо и без duplicate;
//   4) mixed feeder pair: единия feeder resolved нормално (played), другия
//      през реалния production no-show bot-fill path (played_with_bots) —
//      walkover/result_kind='walkover' е dead code в момента (виж коментара
//      при resolveWalkoverStatement/resolveAttendance в tournamentCoordinator.ts
//      — "ПРЕМАХНИ WALKOVER ПОРАДИ NO-SHOW" продуктово изискване, statement-ът
//      никога не се извиква), затова bots_inserted->played_with_bots е
//      реалният production еквивалент на "abnormal resolution", не walkover.
// Сценарий 5 (attendance timing при immediate progression) е анализиран
// статично в отчета, не тестван тук — production кодът вече гарантира
// deadline clock-ът да стартира едва при target match creation (виж
// ensureNextMatchStartAtIfReady/ensureMatchRoom, извиквани в СЪЩИЯ tick),
// не от момента, в който първият feeder приключи.

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { PlayerPublicProfileSnapshot, Seat, ServerRoom } from '../src/core/serverTypes.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'
import { createTournamentCoordinator } from '../src/tournament/tournamentCoordinator.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`  FAIL ${label}: ${message}`)
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
    profileId, displayName: `Race Player ${index + 1}`, avatarUrl: null, level: 1, rankTitle: 'Test',
    skillRating: 1000, completedGamesCount: 0, wonGamesCount: 0, currentRankGames: 0, nextRankGames: 10,
    gamesUntilNextRank: 10, rankProgressRatio: 0, averageRating: null, totalRatingsCount: null,
    yellowCoinsBalance: 100_000, galleryImages: [], gender: null, likesCount: null, hasLikedByMe: null, isBlockedByMe: null,
  }
}

function insertProfile(database: DatabaseSync, profileId: string, index: number): void {
  database.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`)
    .run(profileId, `Race Player ${index + 1}`, `race player ${index + 1}`)
  database.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 100000);`).run(profileId)
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

type MatchInfo = {
  matchId: string
  roomId: string | null
  roundType: string
  roundIndex: number
  teamAId: string
  teamBId: string
  status: string
  resultKind: string | null
  winnerTeamId: string | null
  attendanceStartedAt: string | null
  attendanceDeadlineAt: string | null
}

function getMatches(database: DatabaseSync, tournamentId: string): MatchInfo[] {
  return database.prepare(`
    SELECT tm.match_id AS matchId, tm.room_id AS roomId, tr.round_type AS roundType,
           tr.round_index AS roundIndex, tm.team_a_id AS teamAId, tm.team_b_id AS teamBId,
           tm.status, tm.result_kind AS resultKind, tm.winner_team_id AS winnerTeamId,
           tm.attendance_started_at AS attendanceStartedAt, tm.attendance_deadline_at AS attendanceDeadlineAt
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
    ORDER BY tr.round_type ASC, tr.round_index ASC;
  `).all(tournamentId) as MatchInfo[]
}

function connectSeat(room: ServerRoom, seat: Seat, connectionId: string, attachedConnections: Set<string>): ServerRoom {
  const participant = room.seats[seat].participant
  if (participant?.kind !== 'human' || participant.identity.profileId === null) return room
  attachedConnections.add(`${participant.identity.profileId}:${connectionId}:${room.id}:${seat}`)
  return {
    ...room,
    seats: { ...room.seats, [seat]: { ...room.seats[seat], participant: { ...participant, connectionId, isConnected: true, lastSeenAt: Date.now() } } },
  }
}

function connectAllSeats(room: ServerRoom, prefix: string, attachedConnections: Set<string>): ServerRoom {
  return (['bottom', 'right', 'top', 'left'] as Seat[]).reduce((current, seat) => connectSeat(current, seat, `${prefix}-${seat}`, attachedConnections), room)
}

function forceAttendanceDeadlineElapsed(database: DatabaseSync, matchId: string): void {
  database.prepare(`UPDATE tournament_matches SET attendance_deadline_at = '2020-01-01T00:00:00.000Z' WHERE match_id = ?;`).run(matchId)
}

function endRoom(room: ServerRoom, winnerTeam: 'A' | 'B'): ServerRoom {
  const initialized = initializeRoomAuthoritativeGameState(room)
  const state = initialized.game.authoritativeState as ServerAuthoritativeGameState
  const score = winnerTeam === 'A' ? { teamA: 151, teamB: 80 } : { teamA: 80, teamB: 151 }
  const endedState: ServerAuthoritativeGameState = { ...state, phase: 'match-ended', matchEnded: { winnerTeam, targetScore: initialized.config.targetScore, finalScore: score, endedAt: Date.now() }, score: { ...state.score, match: score } }
  return { ...initialized, status: 'finished', game: { ...initialized.game, phase: 'finished', stateVersion: initialized.game.stateVersion + 1, updatedAt: Date.now(), authoritativeState: endedState } }
}

async function createCoordinator(input: {
  dbPath: string
  profiles: Map<string, PlayerPublicProfileSnapshot>
  rooms: Map<string, ServerRoom>
  attachedConnections: Set<string>
  economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>>
}) {
  return createTournamentCoordinator({
    databaseFilePath: input.dbPath,
    getPublicProfile: (profileId) => input.profiles.get(profileId) ?? null,
    getRoom: (roomId) => input.rooms.get(roomId) ?? null,
    commitRoom: (room) => { input.rooms.set(room.id, room) },
    closeCompletedRoom: (room) => { input.rooms.delete(room.id) },
    ensureRoomRuntime: () => ({ ok: true }),
    settleTournamentPrizes: (tournamentId) => {
      const result = input.economyStore.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:00:00.000Z'))
      return result.ok ? { ok: true, alreadySettled: result.alreadySettled } : { ok: false, reason: result.reason }
    },
    notifyAssignment: () => {},
    notifyFeederMatchCompleted: () => {},
    notifyFeederScoreProgress: () => {},
    isConnectionAttached: ({ profileId, connectionId, roomId, seat }) => input.attachedConnections.has(`${profileId}:${connectionId}:${roomId}:${seat}`),
    isProfileOnline: (profileId) => {
      for (const key of input.attachedConnections) if (key.startsWith(`${profileId}:`)) return true
      return false
    },
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })
}

async function setupTournament(input: { tempPrefix: string; teamCapacity: 4 | 8 }): Promise<{
  tempDir: string
  dbPath: string
  db: DatabaseSync
  tournamentStore: Awaited<ReturnType<typeof createTournamentStore>>
  economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>>
  tournamentId: string
  profiles: Map<string, PlayerPublicProfileSnapshot>
  rooms: Map<string, ServerRoom>
  attachedConnections: Set<string>
}> {
  const playerCapacity = input.teamCapacity * 2
  const tempDir = await mkdtemp(join(tmpdir(), input.tempPrefix))
  const dbPath = join(tempDir, 'test.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  const tournamentStore = await createTournamentStore(dbPath)
  const economyStore = await createTournamentEconomyStore(dbPath)

  const profileIds = Array.from({ length: playerCapacity }, () => randomUUID())
  profileIds.forEach((profileId, index) => insertProfile(db, profileId, index))
  const profiles = new Map(profileIds.map((profileId, index) => [profileId, publicProfile(profileId, index)]))
  const rooms = new Map<string, ServerRoom>()
  const attachedConnections = new Set<string>()

  const created = tournamentStore.createTournament({
    kind: 'community', name: `Race-${input.teamCapacity} Tournament`, creatorProfileId: profileIds[0]!,
    visibility: 'public', entryFee: 10_000, playerCapacity, startMode: 'fill',
  })
  assert(created.ok === true, `create failed: ${JSON.stringify(created)}`)
  const tournamentId = (created as { ok: true; tournament: { tournamentId: string } }).tournament.tournamentId
  for (const profileId of profileIds) {
    const result = economyStore.joinTournamentSoloAtomically(tournamentId, profileId)
    assert(result.ok === true, `join failed: ${JSON.stringify(result)}`)
  }

  const scheduler = await createTournamentScheduler({
    databaseFilePath: dbPath, economyStore,
    now: () => new Date('2026-07-30T10:00:00.000Z'),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })
  scheduler.tickNow()
  scheduler.close()

  return { tempDir, dbPath, db, tournamentStore, economyStore, tournamentId, profiles, rooms, attachedConnections }
}

function completeMatchDirectly(db: DatabaseSync, matchId: string, resultKind: 'played' | 'played_with_bots' = 'played'): void {
  db.prepare(`
    UPDATE tournament_matches
    SET status = 'completed', winner_team_id = team_a_id, result_kind = ?,
        final_score_team_a = 151, final_score_team_b = 80, completed_at = CURRENT_TIMESTAMP
    WHERE match_id = ?;
  `).run(resultKind, matchId)
}

console.log('\ncheckTournamentDependencyProgressionRaceScenarios')

// ════════════════════════════════════════════════════════════════
// 1) CONCURRENT / REPEATED COORDINATOR PROGRESSION
// ════════════════════════════════════════════════════════════════
await check('[1] concurrent/repeated progression: two near-simultaneous coordinator passes over the same persisted state create exactly one QF #1 match/room, no corruption', async () => {
  const setup = await setupTournament({ tempPrefix: 'belot-race-concurrent-', teamCapacity: 8 })
  try {
    const r16Before = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'quarterfinal')
    // teamCapacity=8 -> ladder starts at 'quarterfinal' (4 matches); use
    // round_of_16-equivalent depth via quarterfinal->semifinal transition,
    // matching the already-approved [16 teams] R16->QF proof's pattern one
    // level up the ladder, to keep this scenario's setup minimal (2 feeders
    // -> 1 target, 8-team tournament).
    assert(r16Before.length === 4, `expected 4 quarterfinal matches, got ${r16Before.length}`)
    const byIndex = new Map(r16Before.map((m) => [m.roundIndex, m]))
    const qf1 = byIndex.get(1)!
    const qf2 = byIndex.get(2)!
    completeMatchDirectly(setup.db, qf1.matchId)
    completeMatchDirectly(setup.db, qf2.matchId)

    // Two coordinator INSTANCES (not just two ticks on one instance) racing
    // over the SAME on-disk DB — the closest a single-process Node test can
    // get to two real server processes hitting persisted state back-to-back.
    // ensureNextRound's BEGIN IMMEDIATE serializes SQLite writers, so calling
    // tickNow() on both, interleaved, must still land on exactly one row.
    const coordinatorA = await createCoordinator({ dbPath: setup.dbPath, profiles: setup.profiles, rooms: setup.rooms, attachedConnections: setup.attachedConnections, economyStore: setup.economyStore })
    const coordinatorB = await createCoordinator({ dbPath: setup.dbPath, profiles: setup.profiles, rooms: setup.rooms, attachedConnections: setup.attachedConnections, economyStore: setup.economyStore })
    try {
      coordinatorA.tickNow()
      coordinatorB.tickNow()
      coordinatorA.tickNow()
      coordinatorB.tickNow()

      const afterMatches = getMatches(setup.db, setup.tournamentId)
      const sfMatches = afterMatches.filter((m) => m.roundType === 'semifinal')
      assert(sfMatches.length === 1, `expected exactly 1 semifinal match, got ${sfMatches.length} (duplicate target match)`)
      const sf1 = sfMatches[0]!
      assert(sf1.roundIndex === 1, `semifinal has roundIndex=${sf1.roundIndex}, expected 1`)
      assert(sf1.teamAId === qf1.teamAId, 'SF #1 teamA mismatch (should be QF #1 winner)')
      assert(sf1.teamBId === qf2.teamAId, 'SF #1 teamB mismatch (should be QF #2 winner)')
      assert(sf1.roomId !== null, 'SF #1 has no claimed room')

      // Exactly one room referenced by this match (no double claim across
      // the two coordinator instances).
      const roomRefCount = countRows(setup.db, `SELECT COUNT(*) AS count FROM tournament_matches WHERE tournament_id = ? AND room_id = ?;`, setup.tournamentId, sf1.roomId)
      assert(roomRefCount === 1, `room_id ${sf1.roomId} referenced by ${roomRefCount} matches, expected 1`)

      // No duplicate attendance/start bookkeeping: exactly one round row for
      // (semifinal, round_index=1) at the DB level (the actual UNIQUE
      // constraint that backs this, not just the in-memory existingMatch
      // check).
      const roundRowCount = countRows(setup.db, `SELECT COUNT(*) AS count FROM tournament_rounds WHERE tournament_id = ? AND round_type = 'semifinal' AND round_index = 1;`, setup.tournamentId)
      assert(roundRowCount === 1, `round row count for (semifinal, 1) = ${roundRowCount}, expected 1 — DB UNIQUE(tournament_id, round_type, round_index) is the actual guard`)

      assert(sf1.attendanceStartedAt !== null, 'SF #1 attendance never started')
      assert(sf1.attendanceDeadlineAt !== null, 'SF #1 missing attendance deadline')

      const fkRows = setup.db.prepare('PRAGMA foreign_key_check;').all()
      const integrity = (setup.db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
      assert(fkRows.length === 0, `foreign_key_check rows=${fkRows.length}`)
      assert(integrity === 'ok', `integrity_check=${integrity}`)
    } finally {
      try { coordinatorA.close() } catch {}
      try { coordinatorB.close() } catch {}
    }
  } finally {
    try { setup.economyStore.close() } catch {}
    try { setup.tournamentStore.close() } catch {}
    try { setup.db.close() } catch {}
    await rm(setup.tempDir, { recursive: true, force: true })
  }
})

// ════════════════════════════════════════════════════════════════
// 2) RESTART AFTER TARGET MATCH CREATION, BEFORE ROOM/START
// ════════════════════════════════════════════════════════════════
await check('[2] restart between target match creation and room claim: new coordinator instance reuses the existing match, claims its room, continues attendance normally', async () => {
  const setup = await setupTournament({ tempPrefix: 'belot-race-restart-', teamCapacity: 8 })
  try {
    const qfBefore = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'quarterfinal')
    const byIndex = new Map(qfBefore.map((m) => [m.roundIndex, m]))
    const qf1 = byIndex.get(1)!
    const qf2 = byIndex.get(2)!
    completeMatchDirectly(setup.db, qf1.matchId)
    completeMatchDirectly(setup.db, qf2.matchId)

    // Simulate "target match already inserted, but room/attendance lifecycle
    // never ran" by calling ensureNextRound's effect WITHOUT the room-claim
    // safety-net pass — i.e. insert the semifinal round+match row directly,
    // bypassing the coordinator entirely, so room_id/attendance start stay
    // NULL exactly like a crash between the INSERT and the room-claim step
    // would leave them.
    const roundId = randomUUID()
    setup.db.prepare(`INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, 'semifinal', 1);`).run(roundId, setup.tournamentId)
    const preCreatedMatchId = randomUUID()
    setup.db.prepare(`
      INSERT INTO tournament_matches (match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status, no_show_deadline_at)
      VALUES (?, ?, ?, NULL, ?, ?, 'awaiting_players', NULL);
    `).run(preCreatedMatchId, setup.tournamentId, roundId, qf1.teamAId, qf2.teamAId)

    const beforeRestart = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'semifinal')
    assert(beforeRestart.length === 1 && beforeRestart[0]!.roomId === null, 'pre-condition failed: semifinal match should exist with no room yet')

    // "Coordinator instance destroyed" + "new coordinator on the same DB" —
    // a fresh createTournamentCoordinator() call is the real restart-recovery
    // entrypoint (no separate recovery function exists; reconcileTournament
    // on the first tick re-derives everything from persisted state).
    const restartedCoordinator = await createCoordinator({ dbPath: setup.dbPath, profiles: setup.profiles, rooms: setup.rooms, attachedConnections: setup.attachedConnections, economyStore: setup.economyStore })
    try {
      restartedCoordinator.tickNow()

      const afterRestart = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'semifinal')
      assert(afterRestart.length === 1, `expected still exactly 1 semifinal match after restart tick, got ${afterRestart.length} (duplicate created)`)
      assert(afterRestart[0]!.matchId === preCreatedMatchId, 'restart tick created a NEW match instead of reusing the pre-existing one')
      assert(afterRestart[0]!.roomId !== null, 'restart tick did not claim a room for the pre-existing match')
      assert(afterRestart[0]!.attendanceStartedAt !== null, 'restart tick did not start attendance for the pre-existing match')
      assert(afterRestart[0]!.attendanceDeadlineAt !== null, 'restart tick did not set an attendance deadline')

      const claimedRoomId = afterRestart[0]!.roomId!
      restartedCoordinator.tickNow()
      restartedCoordinator.tickNow()
      const afterMoreTicks = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'semifinal')
      assert(afterMoreTicks.length === 1, `expected still exactly 1 semifinal match after further ticks, got ${afterMoreTicks.length}`)
      assert(afterMoreTicks[0]!.roomId === claimedRoomId, 'room_id changed across repeated post-restart ticks (duplicate claim)')
    } finally {
      try { restartedCoordinator.close() } catch {}
    }
  } finally {
    try { setup.economyStore.close() } catch {}
    try { setup.tournamentStore.close() } catch {}
    try { setup.db.close() } catch {}
    await rm(setup.tempDir, { recursive: true, force: true })
  }
})

// ════════════════════════════════════════════════════════════════
// 3) TWO BRACKET BRANCHES BECOME READY AT THE SAME TIME (SF1 + SF2)
// ════════════════════════════════════════════════════════════════
await check('[3] both QF->SF branches ready simultaneously: SF1 (from QF1+QF2) and SF2 (from QF3+QF4) both created independently in one pass, distinct rooms, no duplicates on repeated tick', async () => {
  const setup = await setupTournament({ tempPrefix: 'belot-race-both-branches-', teamCapacity: 8 })
  try {
    const qfBefore = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'quarterfinal')
    assert(qfBefore.length === 4, `expected 4 quarterfinal matches, got ${qfBefore.length}`)
    const byIndex = new Map(qfBefore.map((m) => [m.roundIndex, m]))
    for (const idx of [1, 2, 3, 4]) completeMatchDirectly(setup.db, byIndex.get(idx)!.matchId)

    const preTick = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'semifinal')
    assert(preTick.length === 0, `expected 0 semifinal matches before tick, got ${preTick.length}`)

    const coordinator = await createCoordinator({ dbPath: setup.dbPath, profiles: setup.profiles, rooms: setup.rooms, attachedConnections: setup.attachedConnections, economyStore: setup.economyStore })
    try {
      coordinator.tickNow()

      const afterOnePass = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'semifinal')
      assert(afterOnePass.length === 2, `expected exactly 2 semifinal matches after one pass, got ${afterOnePass.length}`)
      const sfByIndex = new Map(afterOnePass.map((m) => [m.roundIndex, m]))
      const sf1 = sfByIndex.get(1)
      const sf2 = sfByIndex.get(2)
      assert(sf1 !== undefined, 'SF #1 (round_index=1) missing')
      assert(sf2 !== undefined, 'SF #2 (round_index=2) missing')
      assert(sf1!.teamAId === byIndex.get(1)!.teamAId && sf1!.teamBId === byIndex.get(2)!.teamAId, 'SF #1 feeder pairing wrong (should be QF1+QF2 winners)')
      assert(sf2!.teamAId === byIndex.get(3)!.teamAId && sf2!.teamBId === byIndex.get(4)!.teamAId, 'SF #2 feeder pairing wrong (should be QF3+QF4 winners)')
      assert(sf1!.roomId !== null, 'SF #1 has no claimed room')
      assert(sf2!.roomId !== null, 'SF #2 has no claimed room')
      assert(sf1!.roomId !== sf2!.roomId, 'SF #1 and SF #2 share the same room_id (must be independent/separate claims)')

      const sf1MatchId = sf1!.matchId
      const sf2MatchId = sf2!.matchId
      const sf1RoomId = sf1!.roomId
      const sf2RoomId = sf2!.roomId

      coordinator.tickNow()
      coordinator.tickNow()
      coordinator.tickNow()
      const afterRepeatedTicks = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'semifinal')
      assert(afterRepeatedTicks.length === 2, `expected still exactly 2 semifinal matches after repeated ticks, got ${afterRepeatedTicks.length}`)
      const afterByIndex = new Map(afterRepeatedTicks.map((m) => [m.roundIndex, m]))
      assert(afterByIndex.get(1)!.matchId === sf1MatchId && afterByIndex.get(1)!.roomId === sf1RoomId, 'SF #1 identity/room changed across repeated ticks')
      assert(afterByIndex.get(2)!.matchId === sf2MatchId && afterByIndex.get(2)!.roomId === sf2RoomId, 'SF #2 identity/room changed across repeated ticks')

      const roundRowCount1 = countRows(setup.db, `SELECT COUNT(*) AS count FROM tournament_rounds WHERE tournament_id = ? AND round_type = 'semifinal' AND round_index = 1;`, setup.tournamentId)
      const roundRowCount2 = countRows(setup.db, `SELECT COUNT(*) AS count FROM tournament_rounds WHERE tournament_id = ? AND round_type = 'semifinal' AND round_index = 2;`, setup.tournamentId)
      assert(roundRowCount1 === 1 && roundRowCount2 === 1, `round row counts=${roundRowCount1},${roundRowCount2}, expected 1,1`)
    } finally {
      try { coordinator.close() } catch {}
    }
  } finally {
    try { setup.economyStore.close() } catch {}
    try { setup.tournamentStore.close() } catch {}
    try { setup.db.close() } catch {}
    await rm(setup.tempDir, { recursive: true, force: true })
  }
})

// ════════════════════════════════════════════════════════════════
// 4) MIXED RESOLUTION: NORMAL WIN + REAL NO-SHOW BOT-FILL PATH
// ════════════════════════════════════════════════════════════════
// walkover/result_kind='walkover' is unreachable dead code in the current
// production coordinator (resolveWalkoverStatement is defined but never
// .run() anywhere — see "ПРЕМАХНИ WALKOVER ПОРАДИ NO-SHOW" comment in
// resolveAttendance). The real abnormal-resolution production path that
// still exists end-to-end is no-show -> bot-fill -> normal game completion
// with result_kind='played_with_bots', exercised here through the ACTUAL
// resolveAttendance()/bot-fill/game-start/onTournamentRoomCompleted flow for
// feeder B, while feeder A is played out normally end-to-end for real too
// (not just DB-seeded), to keep this a genuine production-path proof.
await check('[4] mixed feeder pair (QF-A: normal played win, QF-B: real no-show bot-fill path) both count as resolved, target SF created immediately without waiting for the rest of the round', async () => {
  const setup = await setupTournament({ tempPrefix: 'belot-race-mixed-', teamCapacity: 8 })
  try {
    const qfBefore = getMatches(setup.db, setup.tournamentId).filter((m) => m.roundType === 'quarterfinal')
    const byIndex = new Map(qfBefore.map((m) => [m.roundIndex, m]))
    const qfA = byIndex.get(1)!
    const qfB = byIndex.get(2)!

    const coordinator = await createCoordinator({ dbPath: setup.dbPath, profiles: setup.profiles, rooms: setup.rooms, attachedConnections: setup.attachedConnections, economyStore: setup.economyStore })
    try {
      coordinator.tickNow() // claims rooms for the first-round matches

      // Feeder A: normal path — all seats connect, countdown elapses, game
      // is played to completion (result_kind='played').
      let matchA = getMatches(setup.db, setup.tournamentId).find((m) => m.matchId === qfA.matchId)!
      let roomA = setup.rooms.get(matchA.roomId!)!
      roomA = connectAllSeats(roomA, 'qfA', setup.attachedConnections)
      setup.rooms.set(roomA.id, roomA)
      coordinator.tickNow()
      matchA = getMatches(setup.db, setup.tournamentId).find((m) => m.matchId === qfA.matchId)!
      roomA = setup.rooms.get(matchA.roomId!)!
      roomA = endRoom(roomA, 'A')
      setup.rooms.set(roomA.id, roomA)
      coordinator.onTournamentRoomCompleted(roomA)

      // Feeder B: REAL no-show path — only 2 of 4 seats connect, attendance
      // deadline forced elapsed, coordinator tick triggers the actual
      // resolveAttendance() bot-fill branch, then the bot-filled game is
      // played to completion normally (result_kind='played_with_bots').
      let matchB = getMatches(setup.db, setup.tournamentId).find((m) => m.matchId === qfB.matchId)!
      let roomB = setup.rooms.get(matchB.roomId!)!
      roomB = connectSeat(roomB, 'bottom', 'qfB-bottom', setup.attachedConnections)
      roomB = connectSeat(roomB, 'right', 'qfB-right', setup.attachedConnections)
      setup.rooms.set(roomB.id, roomB)
      forceAttendanceDeadlineElapsed(setup.db, qfB.matchId)
      coordinator.tickNow()
      matchB = getMatches(setup.db, setup.tournamentId).find((m) => m.matchId === qfB.matchId)!
      assert(matchB.status === 'countdown', `feeder B status=${matchB.status}, expected countdown (real bot-fill did not trigger)`)
      const replacementCount = countRows(setup.db, `SELECT COUNT(*) AS count FROM tournament_match_no_show_replacements WHERE match_id = ?;`, qfB.matchId)
      assert(replacementCount === 2, `feeder B replacement count=${replacementCount}, expected 2 (real no-show bot-fill)`)
      roomB = setup.rooms.get(matchB.roomId!)!
      roomB = endRoom(roomB, 'A')
      setup.rooms.set(roomB.id, roomB)
      coordinator.onTournamentRoomCompleted(roomB)

      const afterBoth = getMatches(setup.db, setup.tournamentId)
      const feederA = afterBoth.find((m) => m.matchId === qfA.matchId)!
      const feederB = afterBoth.find((m) => m.matchId === qfB.matchId)!
      assert(feederA.status === 'completed' && feederA.resultKind === 'played' && feederA.winnerTeamId !== null, `feeder A: status=${feederA.status} resultKind=${feederA.resultKind} winner=${feederA.winnerTeamId}`)
      assert(feederB.status === 'completed' && feederB.resultKind === 'played_with_bots' && feederB.winnerTeamId !== null, `feeder B: status=${feederB.status} resultKind=${feederB.resultKind} winner=${feederB.winnerTeamId}`)

      // Target SF #1 (fed by QF #1+#2) must be created immediately — not
      // waiting for QF #3/#4, which are still 'awaiting_players'.
      const stillPending = afterBoth.filter((m) => m.roundType === 'quarterfinal' && (m.roundIndex === 3 || m.roundIndex === 4))
      assert(stillPending.length === 2 && stillPending.every((m) => m.status !== 'completed'), 'QF #3/#4 unexpectedly resolved')

      const sfMatches = afterBoth.filter((m) => m.roundType === 'semifinal')
      assert(sfMatches.length === 1, `expected exactly 1 semifinal match created (mixed feeder pair resolved), got ${sfMatches.length}`)
      const sf1 = sfMatches[0]!
      assert(sf1.roundIndex === 1, `SF has roundIndex=${sf1.roundIndex}, expected 1`)
      assert(sf1.teamAId === feederA.winnerTeamId && sf1.teamBId === feederB.winnerTeamId, 'SF #1 participants do not match the two feeder winners')
    } finally {
      try { coordinator.close() } catch {}
    }
  } finally {
    try { setup.economyStore.close() } catch {}
    try { setup.tournamentStore.close() } catch {}
    try { setup.db.close() } catch {}
    await rm(setup.tempDir, { recursive: true, force: true })
  }
})

if (failed > 0) {
  console.error(`checkTournamentDependencyProgressionRaceScenarios failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkTournamentDependencyProgressionRaceScenarios passed: ${passed} checks.`)
