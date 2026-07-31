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
    displayName: `E2E Player ${index + 1}`,
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
  `).run(profileId, `E2E Player ${index + 1}`, `e2e player ${index + 1}`)
  database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 100000);
  `).run(profileId)
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

function sumRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { total: number }).total
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
}

function getMatches(database: DatabaseSync, tournamentId: string): MatchInfo[] {
  return database.prepare(`
    SELECT tm.match_id AS matchId, tm.room_id AS roomId, tr.round_type AS roundType,
           tr.round_index AS roundIndex, tm.team_a_id AS teamAId, tm.team_b_id AS teamBId,
           tm.status, tm.result_kind AS resultKind, tm.winner_team_id AS winnerTeamId
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
    ORDER BY CASE tr.round_type WHEN 'semifinal' THEN 1 ELSE 2 END, tr.round_index ASC;
  `).all(tournamentId) as MatchInfo[]
}

function getRoomForMatch(rooms: Map<string, ServerRoom>, match: MatchInfo): ServerRoom {
  const room = rooms.get(match.roomId)
  if (!room) throw new Error(`Missing room ${match.roomId} for match ${match.matchId}`)
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
      finalScore: winnerTeam === 'A' ? { teamA: 151, teamB: 80 } : { teamA: 80, teamB: 151 },
      endedAt: Date.now(),
    },
    score: {
      ...state.score,
      match: winnerTeam === 'A' ? { teamA: 151, teamB: 80 } : { teamA: 80, teamB: 151 },
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
    ensureRoomRuntime: () => ({ ok: true }),
    settleTournamentPrizes: (tournamentId) => {
      const result = input.economyStore.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:00:00.000Z'))
      return result.ok
        ? { ok: true, alreadySettled: result.alreadySettled }
        : { ok: false, reason: result.reason }
    },
    notifyAssignment: () => {},
    notifyFeederMatchCompleted: () => {},
    notifyFeederScoreProgress: () => {},
    isConnectionAttached: ({ profileId, connectionId, roomId, seat }) => input.attachedConnections.has(`${profileId}:${connectionId}:${roomId}:${seat}`),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })
}

console.log('\ncheckTournamentEndToEnd')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-e2e-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let scheduler: Awaited<ReturnType<typeof createTournamentScheduler>> | null = null
let coordinator: Awaited<ReturnType<typeof createTournamentCoordinator>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  tournamentStore = await createTournamentStore(dbPath)
  economyStore = await createTournamentEconomyStore(dbPath)

  const profileIds = Array.from({ length: 8 }, () => randomUUID())
  profileIds.forEach((profileId, index) => insertProfile(db!, profileId, index))
  const profiles = new Map(profileIds.map((profileId, index) => [profileId, publicProfile(profileId, index)]))
  const rooms = new Map<string, ServerRoom>()
  const attachedConnections = new Set<string>()

  const created = tournamentStore.createTournament({
    kind: 'community',
    name: 'Full E2E Tournament',
    creatorProfileId: profileIds[0]!,
    visibility: 'public',
    entryFee: 10_000,
    startMode: 'fill',
  })
  let tournamentId = ''
  await check('creates tournament through tournament store', () => {
    assert(created.ok === true, JSON.stringify(created))
    if (created.ok) tournamentId = created.tournament.tournamentId
  })

  await check('eight profiles have enough starting balance', () => {
    assert([...walletBalances(db!, profileIds).values()].every((balance) => balance === 100_000), 'unexpected starting balances')
  })

  await check('eight real join operations create eight entry debits', () => {
    for (const profileId of profileIds) {
      const result = economyStore!.joinTournamentSoloAtomically(tournamentId, profileId)
      assert(result.ok === true, `join failed for ${profileId}: ${JSON.stringify(result)}`)
    }
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId) === 8, 'confirmed entry count mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_debit';`, tournamentId) === 8, 'entry debit count mismatch')
  })

  scheduler = await createTournamentScheduler({
    databaseFilePath: dbPath,
    economyStore,
    now: () => new Date('2026-07-30T10:00:00.000Z'),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })
  scheduler.tickNow()

  await check('scheduler starts tournament, locks four teams and writes financial snapshot', () => {
    const tournament = tournamentStore!.getTournamentById(tournamentId)
    assert(tournament?.status === 'starting', `status=${tournament?.status}`)
    assert(tournament.totalEntryAmount === 80_000 && tournament.prizePoolAmount === 64_000, 'financial snapshot mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_teams WHERE tournament_id = ? AND status = 'locked';`, tournamentId) === 4, 'locked teams mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, tournamentId) === 1, 'system fee count mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_matches tm JOIN tournament_rounds tr ON tr.round_id = tm.round_id WHERE tm.tournament_id = ? AND tr.round_type = 'semifinal';`, tournamentId) === 2, 'semifinal count mismatch')
  })

  coordinator = await createCoordinator({ dbPath, profiles, rooms, attachedConnections, economyStore })
  coordinator.tickNow()

  await check('coordinator persists two semifinal room assignments', () => {
    const matches = getMatches(db!, tournamentId).filter((match) => match.roundType === 'semifinal')
    assert(matches.length === 2, `semifinal matches=${matches.length}`)
    assert(matches.every((match) => match.roomId !== null && rooms.has(match.roomId)), 'missing semifinal room assignment')
    assert(new Set(matches.map((match) => match.roomId)).size === 2, 'duplicate semifinal room id')
  })

  let semifinalMatches = getMatches(db, tournamentId).filter((match) => match.roundType === 'semifinal')
  let normalSemi = semifinalMatches[0]!
  let botSemi = semifinalMatches[1]!

  let normalRoom = connectAllSeats(getRoomForMatch(rooms, normalSemi), 'normal-semi', attachedConnections)
  rooms.set(normalRoom.id, normalRoom)
  coordinator.tickNow()
  normalSemi = getMatches(db, tournamentId).find((match) => match.matchId === normalSemi.matchId)!
  forceCountdownElapsed(db, normalSemi.matchId)
  coordinator.tickNow()
  normalSemi = getMatches(db, tournamentId).find((match) => match.matchId === normalSemi.matchId)!
  normalRoom = getRoomForMatch(rooms, normalSemi)
  normalRoom = endRoom(normalRoom, 'A')
  rooms.set(normalRoom.id, normalRoom)
  coordinator.onTournamentRoomCompleted(normalRoom)

  await check('one semifinal completes as normally played', () => {
    const match = getMatches(db!, tournamentId).find((item) => item.matchId === normalSemi.matchId)!
    assert(match.status === 'completed' && match.resultKind === 'played' && match.winnerTeamId === match.teamAId, JSON.stringify(match))
  })

  coordinator.close()
  coordinator = await createCoordinator({ dbPath, profiles, rooms, attachedConnections, economyStore })
  coordinator.tickNow()

  await check('restart simulation keeps existing semifinal rooms unique', () => {
    const matches = getMatches(db!, tournamentId).filter((match) => match.roundType === 'semifinal')
    assert(matches.every((match) => match.roomId !== null), 'room assignment missing after restart')
    assert(new Set(matches.map((match) => match.roomId)).size === 2, 'room assignment duplicated after restart')
  })

  botSemi = getMatches(db, tournamentId).find((match) => match.matchId === botSemi.matchId)!
  let botRoom = getRoomForMatch(rooms, botSemi)
  botRoom = connectSeat(botRoom, 'bottom', 'bot-semi-bottom', attachedConnections)
  botRoom = connectSeat(botRoom, 'top', 'bot-semi-top', attachedConnections)
  rooms.set(botRoom.id, botRoom)
  forceAttendanceDeadlineElapsed(db, botSemi.matchId)
  coordinator.tickNow()

  await check('second semifinal resolves attendance as walkover and completes', () => {
    const match = getMatches(db!, tournamentId).find((item) => item.matchId === botSemi.matchId)!
    assert(match.status === 'completed' && match.resultKind === 'walkover' && match.winnerTeamId === match.teamAId, JSON.stringify(match))
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_match_no_show_replacements WHERE match_id = ?;`, botSemi.matchId) === 0, 'walkover should not insert bots')
  })

  coordinator.tickNow()
  let finalMatch = getMatches(db, tournamentId).find((match) => match.roundType === 'final')

  await check('final is created after two semifinal winners', () => {
    assert(finalMatch !== undefined, 'missing final match')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_rounds WHERE tournament_id = ? AND round_type = 'final';`, tournamentId) === 1, 'final round count mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_matches tm JOIN tournament_rounds tr ON tr.round_id = tm.round_id WHERE tm.tournament_id = ? AND tr.round_type = 'final';`, tournamentId) === 1, 'final match count mismatch')
    assert(finalMatch!.roomId !== null && rooms.has(finalMatch!.roomId), 'missing final room')
  })

  let finalRoom = connectAllSeats(getRoomForMatch(rooms, finalMatch!), 'final', attachedConnections)
  rooms.set(finalRoom.id, finalRoom)
  coordinator.tickNow()
  finalMatch = getMatches(db, tournamentId).find((match) => match.roundType === 'final')!
  forceCountdownElapsed(db, finalMatch.matchId)
  coordinator.tickNow()
  finalMatch = getMatches(db, tournamentId).find((match) => match.roundType === 'final')!
  finalRoom = getRoomForMatch(rooms, finalMatch)
  finalRoom = endRoom(finalRoom, 'A')
  rooms.set(finalRoom.id, finalRoom)
  const balancesBeforeSettlement = walletBalances(db, profileIds)
  coordinator.onTournamentRoomCompleted(finalRoom)

  await check('final completion atomically settles tournament', () => {
    const tournament = tournamentStore!.getTournamentById(tournamentId)
    assert(tournament?.status === 'finished' && tournament.settlementState === 'settled', `status=${tournament?.status}, settlement=${tournament?.settlementState}`)
    assert(tournament.championTeamId === finalMatch!.teamAId && tournament.runnerUpTeamId === finalMatch!.teamBId, 'champion/runner-up mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId) === 4, 'payout count mismatch')
    assert(sumRows(db!, `SELECT COALESCE(SUM(amount), 0) AS total FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId) === 64_000, 'payout sum mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ? AND status = 'champion';`, tournamentId) === 2, 'champion entries mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ? AND status = 'finalist';`, tournamentId) === 2, 'runner-up entries mismatch')
    const changedWallets = [...walletBalances(db!, profileIds)].filter(([profileId, balance]) => balance !== balancesBeforeSettlement.get(profileId))
    assert(changedWallets.length === 4, `credited wallets=${changedWallets.length}`)
  })

  await check('finished tournament is eligible for public last-10 finished list', () => {
    const rows = tournamentStore!.listTournaments({ statuses: ['finished'], orderBy: 'finished_desc', limit: 10 })
    assert(rows.some((row) => row.tournamentId === tournamentId), 'finished tournament missing from last-10 list')
  })

  const reconciliationCountsBefore = {
    rooms: countRows(db, `SELECT COUNT(DISTINCT room_id) AS count FROM tournament_matches WHERE tournament_id = ? AND room_id IS NOT NULL;`, tournamentId),
    events: countRows(db, `SELECT COUNT(*) AS count FROM tournament_events WHERE tournament_id = ?;`, tournamentId),
    systemFees: countRows(db, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, tournamentId),
    payouts: countRows(db, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId),
  }
  const walletSnapshotBeforeReconcile = walletBalances(db, profileIds)
  coordinator.tickNow()
  coordinator.tickNow()
  economyStore.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:01:00.000Z'))

  await check('repeated reconciliation does not duplicate rooms, events, fees, payouts or wallet credits', () => {
    assert(countRows(db!, `SELECT COUNT(DISTINCT room_id) AS count FROM tournament_matches WHERE tournament_id = ? AND room_id IS NOT NULL;`, tournamentId) === reconciliationCountsBefore.rooms, 'room count changed')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_events WHERE tournament_id = ?;`, tournamentId) === reconciliationCountsBefore.events, 'event count changed')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, tournamentId) === reconciliationCountsBefore.systemFees, 'system fee duplicated')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId) === reconciliationCountsBefore.payouts, 'payout duplicated')
    assert([...walletBalances(db!, profileIds)].every(([profileId, balance]) => balance === walletSnapshotBeforeReconcile.get(profileId)), 'wallet changed after reconcile')
  })

  await check('SQLite foreign_key_check and integrity_check pass', () => {
    const fkRows = db!.prepare('PRAGMA foreign_key_check;').all()
    const integrity = (db!.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
    assert(fkRows.length === 0, `foreign_key_check rows=${fkRows.length}`)
    assert(integrity === 'ok', `integrity_check=${integrity}`)
  })
} finally {
  try { coordinator?.close() } catch {}
  try { scheduler?.close() } catch {}
  try { economyStore?.close() } catch {}
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`checkTournamentEndToEnd failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkTournamentEndToEnd passed: ${passed} checks.`)
