import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { PlayerPublicProfileSnapshot, Seat, ServerRoom, Team } from '../src/core/serverTypes.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'
import { createTournamentAdminStore } from '../src/tournament/tournamentAdmin.js'
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
    profileId,
    displayName: `Race Player ${index + 1}`,
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
  `).run(profileId, `Race Player ${index + 1}`, `race player ${index + 1}`)
  database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 100000);
  `).run(profileId)
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

function walletBalances(database: DatabaseSync, profileIds: string[]): Map<string, number> {
  const rows = database.prepare(`
    SELECT profile_id AS profileId, yellow_coins_balance AS balance
    FROM profile_wallets
    WHERE profile_id IN (${profileIds.map(() => '?').join(', ')});
  `).all(...profileIds) as Array<{ profileId: string; balance: number }>
  return new Map(rows.map((row) => [row.profileId, row.balance]))
}

function connectSeat(room: ServerRoom, seat: Seat, connectionId: string, attachedConnections: Set<string>): ServerRoom {
  const participant = room.seats[seat].participant
  if (participant?.kind !== 'human' || participant.identity.profileId === null) return room
  attachedConnections.add(`${participant.identity.profileId}:${connectionId}:${room.id}:${seat}`)
  return {
    ...room,
    seats: {
      ...room.seats,
      [seat]: {
        ...room.seats[seat],
        participant: {
          ...participant,
          connectionId,
          isConnected: true,
          lastSeenAt: Date.now(),
        },
      },
    },
  }
}

function connectAllSeats(room: ServerRoom, prefix: string, attachedConnections: Set<string>): ServerRoom {
  return (['bottom', 'right', 'top', 'left'] as Seat[]).reduce(
    (current, seat) => connectSeat(current, seat, `${prefix}-${seat}`, attachedConnections),
    room,
  )
}

type MatchInfo = {
  matchId: string
  roomId: string
  roundType: 'semifinal' | 'final'
  roundIndex: number
  teamAId: string
  teamBId: string
  status: string
  resultKind: string | null
  winnerTeamId: string | null
  attendanceResolutionKind: string | null
}

function getMatches(database: DatabaseSync, tournamentId: string): MatchInfo[] {
  return database.prepare(`
    SELECT tm.match_id AS matchId, tm.room_id AS roomId, tr.round_type AS roundType,
           tr.round_index AS roundIndex, tm.team_a_id AS teamAId, tm.team_b_id AS teamBId,
           tm.status, tm.result_kind AS resultKind, tm.winner_team_id AS winnerTeamId,
           tm.attendance_resolution_kind AS attendanceResolutionKind
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
    ORDER BY CASE tr.round_type WHEN 'semifinal' THEN 1 ELSE 2 END, tr.round_index ASC;
  `).all(tournamentId) as MatchInfo[]
}

function getRoom(rooms: Map<string, ServerRoom>, match: MatchInfo): ServerRoom {
  const room = rooms.get(match.roomId)
  if (!room) throw new Error(`Missing room ${match.roomId}`)
  return room
}

function forceAttendanceDeadlineElapsed(database: DatabaseSync, matchId: string): void {
  database.prepare(`
    UPDATE tournament_matches
    SET attendance_deadline_at = '2026-07-30T09:59:00.000Z',
        no_show_deadline_at = '2026-07-30T09:59:00.000Z'
    WHERE match_id = ?;
  `).run(matchId)
}

function forceCountdownElapsed(database: DatabaseSync, matchId: string): void {
  database.prepare(`
    UPDATE tournament_matches
    SET game_start_at = '2026-07-30T09:59:00.000Z'
    WHERE match_id = ?;
  `).run(matchId)
}

function endRoom(room: ServerRoom, winnerTeam: Team): ServerRoom {
  const initialized = initializeRoomAuthoritativeGameState(room)
  const state = initialized.game.authoritativeState as ServerAuthoritativeGameState
  const endedState: ServerAuthoritativeGameState = {
    ...state,
    phase: 'match-ended',
    matchEnded: {
      winnerTeam,
      targetScore: initialized.config.targetScore,
      finalScore: winnerTeam === 'A' ? { teamA: 151, teamB: 70 } : { teamA: 70, teamB: 151 },
      endedAt: Date.now(),
    },
    score: {
      ...state.score,
      match: winnerTeam === 'A' ? { teamA: 151, teamB: 70 } : { teamA: 70, teamB: 151 },
    },
  }
  return {
    ...initialized,
    status: 'finished',
    game: {
      ...initialized.game,
      phase: 'finished',
      stateVersion: initialized.game.stateVersion + 1,
      updatedAt: Date.now(),
      authoritativeState: endedState,
    },
  }
}

console.log('\ncheckTournamentConcurrency')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-concurrency-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let adminStore: Awaited<ReturnType<typeof createTournamentAdminStore>> | null = null
let scheduler: Awaited<ReturnType<typeof createTournamentScheduler>> | null = null
let coordinator: Awaited<ReturnType<typeof createTournamentCoordinator>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  tournamentStore = await createTournamentStore(dbPath)
  economyStore = await createTournamentEconomyStore(dbPath)
  adminStore = await createTournamentAdminStore({
    databaseFilePath: dbPath,
    getPublicProfile: () => null,
    runCoordinatorTick: () => coordinator?.tickNow(),
  })
  scheduler = await createTournamentScheduler({
    databaseFilePath: dbPath,
    economyStore,
    now: () => new Date('2026-07-30T10:00:00.000Z'),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })

  const profileIds = Array.from({ length: 160 }, () => randomUUID())
  profileIds.forEach((profileId, index) => insertProfile(db!, profileId, index))
  const profiles = new Map(profileIds.map((profileId, index) => [profileId, publicProfile(profileId, index)]))
  const rooms = new Map<string, ServerRoom>()
  const attachedConnections = new Set<string>()
  coordinator = await createTournamentCoordinator({
    databaseFilePath: dbPath,
    getPublicProfile: (profileId) => profiles.get(profileId) ?? null,
    getRoom: (roomId) => rooms.get(roomId) ?? null,
    commitRoom: (room) => { rooms.set(room.id, room) },
    ensureRoomRuntime: () => ({ ok: true }),
    settleTournamentPrizes: (tournamentId) => {
      const result = economyStore!.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:00:00.000Z'))
      return result.ok ? { ok: true, alreadySettled: result.alreadySettled } : { ok: false, reason: result.reason }
    },
    notifyAssignment: () => {},
    notifyFeederMatchCompleted: () => {},
    isConnectionAttached: ({ profileId, connectionId, roomId, seat }) => attachedConnections.has(`${profileId}:${connectionId}:${roomId}:${seat}`),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })

  let cursor = 0
  function nextProfiles(count: number): string[] {
    const slice = profileIds.slice(cursor, cursor + count)
    cursor += count
    if (slice.length !== count) throw new Error('test profile pool exhausted')
    return slice
  }

  function createTournament(creatorProfileId: string, name: string): string {
    const result = tournamentStore!.createTournament({
      kind: 'community',
      name,
      creatorProfileId,
      visibility: 'public',
      entryFee: 10_000,
      startMode: 'fill',
    })
    assert(result.ok === true, `create failed: ${JSON.stringify(result)}`)
    return result.tournament.tournamentId
  }

  function joinAll(tournamentId: string, participants: string[]): void {
    for (const profileId of participants) {
      const result = economyStore!.joinTournamentSoloAtomically(tournamentId, profileId)
      assert(result.ok === true, `join failed: ${JSON.stringify(result)}`)
    }
  }

  function createFullTournament(name: string): { tournamentId: string; participants: string[] } {
    const participants = nextProfiles(8)
    const tournamentId = createTournament(participants[0]!, name)
    joinAll(tournamentId, participants)
    return { tournamentId, participants }
  }

  function startFullTournament(name: string): { tournamentId: string; participants: string[] } {
    const fixture = createFullTournament(name)
    scheduler!.tickNow()
    coordinator!.tickNow()
    return fixture
  }

  function prepareFinalTournament(name: string): { tournamentId: string; participants: string[]; final: MatchInfo } {
    const fixture = startFullTournament(name)
    const semis = getMatches(db!, fixture.tournamentId).filter((match) => match.roundType === 'semifinal')
    for (const semi of semis) {
      db!.prepare(`
        UPDATE tournament_matches
        SET status = 'completed', result_kind = 'played', winner_team_id = ?, completed_at = '2026-07-30T11:00:00.000Z'
        WHERE match_id = ?;
      `).run(semi.teamAId, semi.matchId)
    }
    coordinator!.tickNow()
    const final = getMatches(db!, fixture.tournamentId).find((match) => match.roundType === 'final')
    assert(final !== undefined, 'final was not created')
    return { ...fixture, final }
  }

  await check('last-seat join race admits one entrant, no ninth participant and no duplicate debit', async () => {
    const participants = nextProfiles(9)
    const tournamentId = createTournament(participants[0]!, 'Last Seat Race')
    joinAll(tournamentId, participants.slice(0, 7))
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => economyStore!.joinTournamentSoloAtomically(tournamentId, participants[7]!)),
      Promise.resolve().then(() => economyStore!.joinTournamentSoloAtomically(tournamentId, participants[8]!)),
    ])
    assert([first.ok, second.ok].filter(Boolean).length === 1, `results=${JSON.stringify([first, second])}`)
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId) === 8, 'confirmed count mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_debit';`, tournamentId) === 8, 'debit count mismatch')
  })

  await check('join versus admin cancel-open leaves no retained entry/refund conflict', async () => {
    const participants = nextProfiles(3)
    const tournamentId = createTournament(participants[0]!, 'Join Cancel Race')
    joinAll(tournamentId, participants.slice(0, 1))
    await Promise.all([
      Promise.resolve().then(() => economyStore!.joinTournamentSoloAtomically(tournamentId, participants[1]!)),
      Promise.resolve().then(() => adminStore!.cancelOpenTournament(tournamentId, participants[2]!)),
    ])
    const status = tournamentStore!.getTournamentById(tournamentId)?.status
    assert(status === 'admin_cancelled', `status=${status}`)
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId) === 0, 'confirmed entries remain after cancel')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ? AND status = 'refunded';`, tournamentId) === countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`, tournamentId), 'refund rows do not match refunded entries')
  })

  await check('start before cancel creates one start transition and no refund', async () => {
    const { tournamentId } = createFullTournament('Start Before Cancel')
    await Promise.all([
      Promise.resolve().then(() => scheduler!.tickNow()),
      Promise.resolve().then(() => adminStore!.cancelOpenTournament(tournamentId, profileIds[0]!)),
    ])
    const status = tournamentStore!.getTournamentById(tournamentId)?.status
    assert(status === 'starting', `status=${status}`)
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, tournamentId) === 1, 'system fee mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`, tournamentId) === 0, 'unexpected refunds')
  })

  await check('cancel-open before start creates one cancel transition and no system fee', async () => {
    const { tournamentId } = createFullTournament('Cancel Before Start')
    await Promise.all([
      Promise.resolve().then(() => adminStore!.cancelOpenTournament(tournamentId, profileIds[1]!)),
      Promise.resolve().then(() => scheduler!.tickNow()),
    ])
    const status = tournamentStore!.getTournamentById(tournamentId)?.status
    assert(status === 'admin_cancelled', `status=${status}`)
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, tournamentId) === 0, 'unexpected system fee')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`, tournamentId) === 8, 'refund count mismatch')
  })

  await check('two coordinator ticks do not duplicate semifinal rooms', () => {
    const { tournamentId } = startFullTournament('Double Tick Rooms')
    coordinator!.tickNow()
    const semis = getMatches(db!, tournamentId).filter((match) => match.roundType === 'semifinal')
    assert(semis.length === 2, `semis=${semis.length}`)
    assert(semis.every((match) => match.roomId !== null), 'missing room id')
    assert(new Set(semis.map((match) => match.roomId)).size === 2, 'duplicate room id')
  })

  await check('attendance deadline versus last human reconnect follows transaction order', () => {
    const { tournamentId } = startFullTournament('Attendance Last Human')
    let match = getMatches(db!, tournamentId).find((item) => item.roundType === 'semifinal')!
    let room = getRoom(rooms, match)
    room = connectSeat(room, 'bottom', 'attendance-bottom', attachedConnections)
    room = connectSeat(room, 'right', 'attendance-right', attachedConnections)
    room = connectSeat(room, 'top', 'attendance-top', attachedConnections)
    rooms.set(room.id, room)
    coordinator!.tickNow()
    forceAttendanceDeadlineElapsed(db!, match.matchId)
    room = connectSeat(room, 'left', 'attendance-left', attachedConnections)
    rooms.set(room.id, room)
    coordinator!.tickNow()
    match = getMatches(db!, tournamentId).find((item) => item.matchId === match.matchId)!
    assert(match.status === 'countdown' && match.attendanceResolutionKind === 'all_present', JSON.stringify(match))
    assert(match.resultKind === null && match.winnerTeamId === null, 'walkover and game start conflict')
  })

  await check('bot insertion versus human takeover leaves one owner per seat', () => {
    const { tournamentId } = startFullTournament('Bot Insert Race')
    let match = getMatches(db!, tournamentId).find((item) => item.roundType === 'semifinal')!
    let room = getRoom(rooms, match)
    room = connectSeat(room, 'bottom', 'bot-bottom', attachedConnections)
    room = connectSeat(room, 'right', 'bot-right', attachedConnections)
    rooms.set(room.id, room)
    forceAttendanceDeadlineElapsed(db!, match.matchId)
    coordinator!.tickNow()
    match = getMatches(db!, tournamentId).find((item) => item.matchId === match.matchId)!
    room = getRoom(rooms, match)
    const replacement = db!.prepare(`
      SELECT assigned_profile_id AS profileId, assigned_seat AS seat, reconnect_token AS reconnectToken
      FROM tournament_match_no_show_replacements
      WHERE match_id = ?
      ORDER BY inserted_at ASC
      LIMIT 1;
    `).get(match.matchId) as { profileId: string; seat: Seat; reconnectToken: string }
    const takeover = coordinator!.tryTakeoverNoShowBot({
      room,
      profileId: replacement.profileId,
      connectionId: 'bot-takeover',
      reconnectToken: replacement.reconnectToken,
    })
    assert(takeover.ok === true, JSON.stringify(takeover))
    if (takeover.ok) rooms.set(takeover.room.id, takeover.room)
    const updatedRoom = rooms.get(room.id)!
    assert(updatedRoom.seats[replacement.seat].participant?.kind === 'human', 'seat was not restored to human')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_match_no_show_replacements WHERE match_id = ? AND assigned_seat = ? AND status IN ('active', 'takeover_pending');`, match.matchId, replacement.seat) === 0, 'active replacement remains for human seat')
  })

  await check('two final creation attempts keep one final round, one final match and one final room', () => {
    const { tournamentId } = prepareFinalTournament('Final Creation Race')
    coordinator!.tickNow()
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_rounds WHERE tournament_id = ? AND round_type = 'final';`, tournamentId) === 1, 'final round duplicated')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_matches tm JOIN tournament_rounds tr ON tr.round_id = tm.round_id WHERE tm.tournament_id = ? AND tr.round_type = 'final';`, tournamentId) === 1, 'final match duplicated')
    const finalRooms = countRows(db!, `SELECT COUNT(DISTINCT room_id) AS count FROM tournament_matches tm JOIN tournament_rounds tr ON tr.round_id = tm.round_id WHERE tm.tournament_id = ? AND tr.round_type = 'final' AND tm.room_id IS NOT NULL;`, tournamentId)
    assert(finalRooms === 1, `finalRooms=${finalRooms}`)
  })

  await check('two settlement attempts credit exactly four wallets once', () => {
    const { tournamentId, participants, final } = prepareFinalTournament('Settlement Race')
    db!.prepare(`
      UPDATE tournament_matches
      SET status = 'completed', result_kind = 'played', winner_team_id = ?, completed_at = '2026-07-30T12:00:00.000Z'
      WHERE match_id = ?;
    `).run(final.teamAId, final.matchId)
    const before = walletBalances(db!, participants)
    const first = economyStore!.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:00:00.000Z'))
    const second = economyStore!.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:00:01.000Z'))
    assert(first.ok === true && second.ok === true && second.alreadySettled === true, `settlement=${JSON.stringify([first, second])}`)
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId) === 4, 'payout rows mismatch')
    const credited = [...walletBalances(db!, participants)].filter(([profileId, balance]) => balance !== before.get(profileId))
    assert(credited.length === 4, `credited wallets=${credited.length}`)
    assert(tournamentStore!.getTournamentById(tournamentId)?.status === 'finished', 'tournament not finished')
  })

  await check('settlement versus repeated final completion does not duplicate payout or champion', () => {
    const { tournamentId, final } = prepareFinalTournament('Repeated Final Completion')
    let finalRoom = connectAllSeats(getRoom(rooms, final), 'repeat-final', attachedConnections)
    rooms.set(finalRoom.id, finalRoom)
    coordinator!.tickNow()
    forceCountdownElapsed(db!, final.matchId)
    coordinator!.tickNow()
    finalRoom = getRoom(rooms, getMatches(db!, tournamentId).find((match) => match.roundType === 'final')!)
    finalRoom = endRoom(finalRoom, 'A')
    rooms.set(finalRoom.id, finalRoom)
    coordinator!.onTournamentRoomCompleted(finalRoom)
    coordinator!.onTournamentRoomCompleted(finalRoom)
    const tournament = tournamentStore!.getTournamentById(tournamentId)
    assert(tournament?.championTeamId === final.teamAId, `champion=${tournament?.championTeamId}`)
    assert(tournament?.runnerUpTeamId === final.teamBId, `runnerUp=${tournament?.runnerUpTeamId}`)
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId) === 4, 'duplicate payout rows')
  })

  await check('public finished list read sees either pending or fully settled state around settlement', () => {
    const { tournamentId, final } = prepareFinalTournament('Public Read During Settlement')
    db!.prepare(`
      UPDATE tournament_matches
      SET status = 'completed', result_kind = 'played', winner_team_id = ?, completed_at = '2026-07-30T12:00:00.000Z'
      WHERE match_id = ?;
    `).run(final.teamAId, final.matchId)
    const beforeRows = tournamentStore!.listTournaments({ statuses: ['finished'], orderBy: 'finished_desc', limit: 10 })
    assert(!beforeRows.some((row) => row.tournamentId === tournamentId), 'pending settlement leaked as finished')
    const settlement = economyStore!.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:00:00.000Z'))
    assert(settlement.ok === true, JSON.stringify(settlement))
    const afterRows = tournamentStore!.listTournaments({ statuses: ['finished'], orderBy: 'finished_desc', limit: 10 })
    const row = afterRows.find((item) => item.tournamentId === tournamentId)
    assert(row?.settlementState === 'settled' && row.championTeamId !== null && row.runnerUpTeamId !== null, JSON.stringify(row))
  })

  await check('SQLite foreign_key_check and integrity_check pass after concurrency scenarios', () => {
    const fkRows = db!.prepare('PRAGMA foreign_key_check;').all()
    const integrity = (db!.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
    assert(fkRows.length === 0, `foreign_key_check rows=${fkRows.length}`)
    assert(integrity === 'ok', `integrity_check=${integrity}`)
  })
} finally {
  try { coordinator?.close() } catch {}
  try { scheduler?.close() } catch {}
  try { adminStore?.close() } catch {}
  try { economyStore?.close() } catch {}
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`checkTournamentConcurrency failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkTournamentConcurrency passed: ${passed} checks.`)
