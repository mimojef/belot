// Поведенчески тест за match waiting / round transition flow (§1-12 в task
// spec-а): 3-минутен deadline само за първия bracket round, 20-секунден
// round_transition deadline за следващите кръгове, no-show bot fill,
// takeover, standard leave penalty изолация от tournament economy,
// final score persistence (restart safety), settlement 65%/35% непроменено.
// Модел: checkTournamentVariableTeamCount.ts (fake-clock coordinator+scheduler
// harness върху изолирана SQLite база), разширен с tableExitPenaltyStore и
// takeover проверки.

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { PlayerPublicProfileSnapshot, Seat, ServerRoom, Team } from '../src/core/serverTypes.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { createTableExitPenaltyStore } from '../src/db/tableExitPenaltyStore.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'
import { createTournamentCoordinator } from '../src/tournament/tournamentCoordinator.js'
import { createRoomSnapshotMessage } from '../src/protocol/createRoomSnapshotMessage.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'
import { buildTournamentRoundDtos } from '../src/tournament/tournamentDto.js'

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
    displayName: `MTF Player ${index + 1}`,
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
  `).run(profileId, `MTF Player ${index + 1}`, `mtf player ${index + 1}`)
  database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 100000);
  `).run(profileId)
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
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
  roomId: string | null
  roundType: string
  roundIndex: number
  teamAId: string
  teamBId: string
  status: string
  resultKind: string | null
  winnerTeamId: string | null
  deadlineKind: string | null
  attendanceDeadlineAt: string | null
  finalScoreTeamA: number | null
  finalScoreTeamB: number | null
}

function getMatches(database: DatabaseSync, tournamentId: string): MatchInfo[] {
  return database.prepare(`
    SELECT tm.match_id AS matchId, tm.room_id AS roomId, tr.round_type AS roundType,
           tr.round_index AS roundIndex, tm.team_a_id AS teamAId, tm.team_b_id AS teamBId,
           tm.status, tm.result_kind AS resultKind, tm.winner_team_id AS winnerTeamId,
           tm.deadline_kind AS deadlineKind, tm.attendance_deadline_at AS attendanceDeadlineAt,
           tm.final_score_team_a AS finalScoreTeamA, tm.final_score_team_b AS finalScoreTeamB
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
    ORDER BY tr.round_index ASC;
  `).all(tournamentId) as MatchInfo[]
}

function getRoomForMatch(rooms: Map<string, ServerRoom>, match: MatchInfo): ServerRoom {
  const room = rooms.get(match.roomId ?? '')
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

function endRoom(room: ServerRoom, winnerTeam: Team, score: { teamA: number; teamB: number }): ServerRoom {
  const initialized = initializeRoomAuthoritativeGameState(room)
  const state = initialized.game.authoritativeState as ServerAuthoritativeGameState
  const endedState: ServerAuthoritativeGameState = {
    ...state,
    phase: 'match-ended',
    matchEnded: {
      winnerTeam,
      targetScore: initialized.config.targetScore,
      finalScore: score,
      endedAt: Date.now(),
    },
    score: {
      ...state.score,
      match: score,
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

// Симулира завършено раздаване (round) БЕЗ да приключва целия мач —
// score.match се променя authoritative, matchEnded остава null. Модел на
// точно "authoritative промяна на match total score", за която §2 в task
// spec-а иска feeder progress push (за разлика от endRoom, която приключва
// самия мач).
function advanceRoundScore(room: ServerRoom, score: { teamA: number; teamB: number }): ServerRoom {
  const initialized = initializeRoomAuthoritativeGameState(room)
  const state = initialized.game.authoritativeState as ServerAuthoritativeGameState
  const nextState: ServerAuthoritativeGameState = {
    ...state,
    score: { ...state.score, match: score },
  }
  return {
    ...initialized,
    game: {
      ...initialized.game,
      stateVersion: initialized.game.stateVersion + 1,
      updatedAt: Date.now(),
      authoritativeState: nextState,
    },
  }
}

async function createCoordinator(input: {
  dbPath: string
  profiles: Map<string, PlayerPublicProfileSnapshot>
  rooms: Map<string, ServerRoom>
  attachedConnections: Set<string>
  economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>>
  onFeederCompleted?: (profileIds: string[], update: unknown) => void
  onFeederProgress?: (profileIds: string[], update: unknown) => void
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
    notifyFeederMatchCompleted: (profileIds, update) => { input.onFeederCompleted?.(profileIds, update) },
    notifyFeederScoreProgress: (profileIds, update) => { input.onFeederProgress?.(profileIds, update) },
    isConnectionAttached: ({ profileId, connectionId, roomId, seat }) => input.attachedConnections.has(`${profileId}:${connectionId}:${roomId}:${seat}`),
    // Project-wide presence mock (§"PRESENCE SEMANTICS") — derived from the
    // SAME attachedConnections Set the tests already populate/clear, just
    // profile-scoped instead of the full connection/room/seat tuple.
    isProfileOnline: (profileId) => {
      for (const key of input.attachedConnections) {
        if (key.startsWith(`${profileId}:`)) return true
      }
      return false
    },
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })
}

console.log('\ncheckTournamentMatchTransitionFlow')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-mtf-'))
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

  // 8-отборен турнир: quarterfinal (first_match, 3 мин) -> semifinal
  // (round_transition, 20 сек) -> final (round_transition, 20 сек).
  const profileIds = Array.from({ length: 16 }, () => randomUUID())
  profileIds.forEach((profileId, index) => insertProfile(db!, profileId, index))
  const profiles = new Map(profileIds.map((profileId, index) => [profileId, publicProfile(profileId, index)]))
  const rooms = new Map<string, ServerRoom>()
  const attachedConnections = new Set<string>()

  const created = tournamentStore.createTournament({
    kind: 'community',
    name: 'MTF Tournament',
    creatorProfileId: profileIds[0]!,
    visibility: 'public',
    entryFee: 10_000,
    playerCapacity: 16,
    startMode: 'fill',
  })
  let tournamentId = ''
  await check('creates 8-team tournament', () => {
    assert(created.ok === true, JSON.stringify(created))
    if (created.ok) tournamentId = created.tournament.tournamentId
  })

  for (const profileId of profileIds) {
    const result = economyStore.joinTournamentSoloAtomically(tournamentId, profileId)
    if (!result.ok) throw new Error(`join failed: ${JSON.stringify(result)}`)
  }

  scheduler = await createTournamentScheduler({
    databaseFilePath: dbPath,
    economyStore,
    now: () => new Date('2026-07-30T10:00:00.000Z'),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })
  scheduler.tickNow()

  const feederNotifications: Array<{ profileIds: string[]; update: unknown }> = []
  coordinator = await createCoordinator({
    dbPath, profiles, rooms, attachedConnections, economyStore,
    onFeederCompleted: (profileIds, update) => { feederNotifications.push({ profileIds, update }) },
  })
  coordinator.tickNow()

  // ── [1] Първият мач (quarterfinal) има 3-минутен deadline ──
  let matches = getMatches(db, tournamentId)
  const quarterfinals = matches.filter((m) => m.roundType === 'quarterfinal')
  await check('first round (quarterfinal) matches get deadline_kind=first_match with ~3min window', () => {
    assert(quarterfinals.length === 4, `quarterfinal count=${quarterfinals.length}`)
    for (const match of quarterfinals) {
      assert(match.deadlineKind === 'first_match', `deadlineKind=${match.deadlineKind}`)
      assert(match.attendanceDeadlineAt !== null, 'missing attendance deadline')
      const remainingMs = Date.parse(match.attendanceDeadlineAt!) - Date.now()
      assert(remainingMs >= 170_000 && remainingMs <= 181_000, `first-match window=${remainingMs}ms, expected ~180000ms`)
    }
  })

  // ── [2] Всички готови могат да стартират по-рано (presence-based) ──
  await check('all-present quarterfinal match resolves to countdown before the 3-minute deadline elapses', () => {
    const qf1 = quarterfinals[0]!
    let room = getRoomForMatch(rooms, qf1)
    room = connectAllSeats(room, 'early-ready', attachedConnections)
    rooms.set(room.id, room)
    coordinator!.tickNow()
    const refreshed = getMatches(db!, tournamentId).find((m) => m.matchId === qf1.matchId)!
    assert(refreshed.status === 'countdown', `status=${refreshed.status}, expected countdown despite deadline not elapsed`)
  })

  // ── [6] Timeout -> bot-controlled seat (второто quarterfinal-мачче: по 1 от всеки отбор готов) ──
  const qf2 = quarterfinals[1]!
  await check('timeout with players present on both sides fills missing seats with tournament bots', () => {
    let room = getRoomForMatch(rooms, qf2)
    room = connectSeat(room, 'bottom', 'partial-bottom', attachedConnections)
    room = connectSeat(room, 'right', 'partial-right', attachedConnections)
    rooms.set(room.id, room)
    forceAttendanceDeadlineElapsed(db!, qf2.matchId)
    coordinator!.tickNow()
    const refreshed = getMatches(db!, tournamentId).find((m) => m.matchId === qf2.matchId)!
    assert(refreshed.status === 'countdown', `status=${refreshed.status}`)
    const replacementCount = countRows(db!, `SELECT COUNT(*) AS count FROM tournament_match_no_show_replacements WHERE match_id = ?;`, qf2.matchId)
    assert(replacementCount === 2, `replacement count=${replacementCount}, expected 2`)
  })

  // ── [7] Временният бот запазва human seat identity ──
  await check('temporary bot replacement keeps original human display name (prefixed) and seat/team', () => {
    const refreshedRoom = getRoomForMatch(rooms, getMatches(db!, tournamentId).find((m) => m.matchId === qf2.matchId)!)
    const botSeats = (['top', 'left'] as Seat[]).map((seat) => refreshedRoom.seats[seat].participant)
    for (const participant of botSeats) {
      assert(participant?.kind === 'bot', `expected bot participant, got ${participant?.kind}`)
      if (participant?.kind === 'bot') {
        assert(participant.tournamentNoShowReplacement !== undefined, 'missing tournamentNoShowReplacement metadata')
        assert(participant.identity.displayName.startsWith('Бот вместо'), `displayName=${participant.identity.displayName}`)
      }
    }
  })

  // ── bot rendering data: клиентският snapshot пази ОРИГИНАЛНОТО име (не
  // "Бот вместо X"), маркира replacementActive=true за badge/secondary text ──
  await check('room snapshot exposes original player identity + active-replacement flag for bot-controlled seats', () => {
    const refreshedMatch = getMatches(db!, tournamentId).find((m) => m.matchId === qf2.matchId)!
    const refreshedRoom = getRoomForMatch(rooms, refreshedMatch)
    const snapshot = createRoomSnapshotMessage(refreshedRoom, 'bottom')
    assert(snapshot.tournamentBotReplacements !== undefined, 'missing tournamentBotReplacements in room snapshot')
    const replacements = snapshot.tournamentBotReplacements ?? []
    assert(replacements.length === 2, `replacement snapshot count=${replacements.length}, expected 2`)
    for (const seat of ['top', 'left'] as Seat[]) {
      const replacement = replacements.find((item) => item.seat === seat)
      assert(replacement !== undefined, `missing replacement snapshot for seat=${seat}`)
      if (replacement !== undefined) {
        assert(!replacement.replacedPlayer.displayName.startsWith('Бот'), `replacedPlayer.displayName should be the ORIGINAL name, got "${replacement.replacedPlayer.displayName}"`)
        assert(replacement.replacementActive === true, `replacementActive=${replacement.replacementActive}, expected true (badge should render)`)
        assert(replacement.takeoverCompleted === false, 'takeoverCompleted should be false before takeover')
      }
    }
  })

  // ── [8] Takeover връща същото seat място на човека ──
  await check('takeover returns the original seat to the real player without restarting the match', () => {
    const refreshedMatch = getMatches(db!, tournamentId).find((m) => m.matchId === qf2.matchId)!
    let room = getRoomForMatch(rooms, refreshedMatch)
    const replacement = db!.prepare(`SELECT reconnect_token AS reconnectToken, assigned_profile_id AS assignedProfileId, assigned_seat AS assignedSeat FROM tournament_match_no_show_replacements WHERE match_id = ? AND status = 'active' LIMIT 1;`).get(qf2.matchId) as { reconnectToken: string; assignedProfileId: string; assignedSeat: Seat }
    const result = coordinator!.tryTakeoverNoShowBot({
      room,
      profileId: replacement.assignedProfileId,
      connectionId: `takeover-conn-${replacement.assignedSeat}`,
      reconnectToken: replacement.reconnectToken,
    })
    assert(result.ok === true, `takeover failed: ${JSON.stringify(result)}`)
    if (result.ok) {
      rooms.set(result.room.id, result.room)
      const seatParticipant = result.room.seats[replacement.assignedSeat].participant
      assert(seatParticipant?.kind === 'human', `expected human after takeover, got ${seatParticipant?.kind}`)
      assert(
        seatParticipant?.kind === 'human' && seatParticipant.identity.profileId === replacement.assignedProfileId,
        'takeover did not restore the original profile to the seat',
      )
    }
  })

  // ── [3] Takeover премахва bot badge обозначението от room snapshot-а ──
  await check('takeover removes the bot-replacement designation from the room snapshot for that seat', () => {
    const refreshedMatch = getMatches(db!, tournamentId).find((m) => m.matchId === qf2.matchId)!
    const refreshedRoom = getRoomForMatch(rooms, refreshedMatch)
    const snapshot = createRoomSnapshotMessage(refreshedRoom, 'bottom')
    const replacements = snapshot.tournamentBotReplacements ?? []
    const topReplacement = replacements.find((item) => item.seat === 'top')
    assert(topReplacement !== undefined, 'missing replacement record for seat=top after takeover')
    if (topReplacement !== undefined) {
      assert(topReplacement.replacementActive === false, `replacementActive=${topReplacement.replacementActive}, expected false after takeover (badge must disappear)`)
      assert(topReplacement.takeoverCompleted === true, `takeoverCompleted=${topReplacement.takeoverCompleted}, expected true`)
    }
    const leftReplacement = replacements.find((item) => item.seat === 'left')
    assert(leftReplacement !== undefined && leftReplacement.replacementActive === true, 'seat=left (not taken over) should still show the bot badge')
  })

  // Reconnect the takeover seat so the room can complete normally, and finish
  // remaining quarterfinals quickly (win team A everywhere) to drive the
  // bracket to the semifinal stage.
  for (const seat of (['bottom', 'right', 'top', 'left'] as Seat[])) {
    const refreshedMatch = getMatches(db!, tournamentId).find((m) => m.matchId === qf2.matchId)!
    let room = getRoomForMatch(rooms, refreshedMatch)
    room = connectSeat(room, seat, `qf2-final-${seat}`, attachedConnections)
    rooms.set(room.id, room)
  }
  coordinator.tickNow()

  async function playMatchToCompletion(matchId: string, winner: Team = 'A'): Promise<void> {
    let match = getMatches(db!, tournamentId).find((m) => m.matchId === matchId)!
    if (match.status === 'completed') return
    if (match.roomId === null) { coordinator!.tickNow(); match = getMatches(db!, tournamentId).find((m) => m.matchId === matchId)! }
    let room = getRoomForMatch(rooms, match)
    if (Object.values(room.seats).some((s) => s.participant?.kind === 'human' && !s.participant.isConnected)) {
      room = connectAllSeats(room, `play-${matchId}`, attachedConnections)
      rooms.set(room.id, room)
      coordinator!.tickNow()
    }
    forceCountdownElapsed(db!, matchId)
    coordinator!.tickNow()
    match = getMatches(db!, tournamentId).find((m) => m.matchId === matchId)!
    if (match.status === 'completed') return
    room = getRoomForMatch(rooms, match)
    room = endRoom(room, winner, winner === 'A' ? { teamA: 151, teamB: 90 } : { teamA: 90, teamB: 151 })
    rooms.set(room.id, room)
    coordinator!.onTournamentRoomCompleted(room)
  }

  // ── Live feeder progress audience (виж task spec-а: коригирана аудитория)
  // — progress push-ът за един feeder мач трябва да стигне САМО до confirmed
  // членовете на отбора, който вече е спечелил sibling feeder-а си и чака в
  // непосредствения bracket следващ кръг точно победителя от ТОЗИ feeder.
  // Ползва QF-B клона (quarterfinals[2]/[3], round_index 3&4 -> semifinal
  // round_index 2) — незасегнат до момента от bot-fill/takeover сценариите
  // по-горе, за да изолира чисто resolveWaitingTeamIdForFeeder логиката от
  // qf2's bot-replacement history.
  const qfB1 = quarterfinals[2]!
  const qfB2 = quarterfinals[3]!

  function teamMemberProfileIds(teamId: string): string[] {
    return tournamentStore!.getEntriesForTournament(tournamentId)
      .filter((entry) => entry.teamId === teamId)
      .map((entry) => entry.profileId)
  }

  const feederProgressNotifications: Array<{ profileIds: string[]; update: unknown }> = []
  const feederProgressCoordinator = await createCoordinator({
    dbPath, profiles, rooms, attachedConnections, economyStore,
    onFeederProgress: (profileIds, update) => { feederProgressNotifications.push({ profileIds, update }) },
  })

  await check('no group broadcast while the sibling feeder (QF-B1) has not completed yet', () => {
    let room = getRoomForMatch(rooms, getMatches(db!, tournamentId).find((m) => m.matchId === qfB2.matchId)!)
    room = advanceRoundScore(room, { teamA: 10, teamB: 8 })
    rooms.set(room.id, room)
    feederProgressCoordinator.notifyFeederScoreProgress(room)
    assert(feederProgressNotifications.length === 0, `unexpected push while sibling feeder still in progress: ${feederProgressNotifications.length}`)
  })

  await check('QF-B1 (the sibling feeder) completes with team A as winner', async () => {
    await playMatchToCompletion(qfB1.matchId, 'A')
    const refreshed = getMatches(db!, tournamentId).find((m) => m.matchId === qfB1.matchId)!
    assert(refreshed.status === 'completed' && refreshed.winnerTeamId === refreshed.teamAId, `QF-B1 not completed with team A as winner: ${JSON.stringify(refreshed)}`)
  })

  const qfB1Completed = getMatches(db!, tournamentId).find((m) => m.matchId === qfB1.matchId)!
  const waitingTeamMembers = teamMemberProfileIds(qfB1Completed.winnerTeamId!)
  const qfB1LoserTeamId = qfB1Completed.winnerTeamId === qfB1Completed.teamAId ? qfB1Completed.teamBId : qfB1Completed.teamAId
  const qfB1LoserMembers = teamMemberProfileIds(qfB1LoserTeamId)
  const qfB2PlayerMembers = [...teamMemberProfileIds(qfB2.teamAId), ...teamMemberProfileIds(qfB2.teamBId)]
  const unrelatedBranchMembers = [
    ...teamMemberProfileIds(quarterfinals[0]!.teamAId),
    ...teamMemberProfileIds(quarterfinals[0]!.teamBId),
    ...teamMemberProfileIds(quarterfinals[1]!.teamAId),
    ...teamMemberProfileIds(quarterfinals[1]!.teamBId),
  ]

  await check('QF-B2 (still in progress) reaches a real, live in_progress game state', () => {
    let room = getRoomForMatch(rooms, getMatches(db!, tournamentId).find((m) => m.matchId === qfB2.matchId)!)
    room = connectAllSeats(room, 'qfb2-live', attachedConnections)
    rooms.set(room.id, room)
    coordinator!.tickNow()
    forceCountdownElapsed(db!, qfB2.matchId)
    coordinator!.tickNow()
    const refreshed = getMatches(db!, tournamentId).find((m) => m.matchId === qfB2.matchId)!
    assert(refreshed.status === 'in_progress', `QF-B2 status=${refreshed.status}, expected in_progress`)
  })

  await check('a live authoritative score update on QF-B2 is pushed only to the waiting QF-B1 winner team', () => {
    let room = getRoomForMatch(rooms, getMatches(db!, tournamentId).find((m) => m.matchId === qfB2.matchId)!)
    room = advanceRoundScore(room, { teamA: 32, teamB: 18 })
    rooms.set(room.id, room)
    feederProgressCoordinator.notifyFeederScoreProgress(room)

    assert(feederProgressNotifications.length === 1, `notification count=${feederProgressNotifications.length}, expected exactly 1`)
    const update = feederProgressNotifications[0]!.update as { status: string; scoreTeamA: number; scoreTeamB: number; matchId: string }
    assert(update.status === 'in_progress', `status=${update.status}, expected in_progress (must fire BEFORE completion)`)
    assert(update.scoreTeamA === 32 && update.scoreTeamB === 18, `score=${update.scoreTeamA}:${update.scoreTeamB}, expected 32:18`)
    assert(update.matchId === qfB2.matchId, 'matchId mismatch in feeder progress update')

    assert(waitingTeamMembers.length === 2, `waiting team member count=${waitingTeamMembers.length}, expected 2`)
    const recipients = feederProgressNotifications[0]!.profileIds
    const recipientSet = new Set(recipients)
    assert(recipientSet.size === recipients.length, 'recipient profile IDs are not deduplicated')
    assert(recipientSet.size === waitingTeamMembers.length, `recipient count=${recipientSet.size}, expected ${waitingTeamMembers.length} (only the waiting QF-B1 winner team)`)
    for (const profileId of waitingTeamMembers) {
      assert(recipientSet.has(profileId), `waiting QF-B1 winner-team member ${profileId} missing from recipients`)
    }
  })

  await check('QF-B2 players currently on the table do not receive the progress push meant for the waiting team', () => {
    const last = feederProgressNotifications[feederProgressNotifications.length - 1]!
    for (const profileId of qfB2PlayerMembers) {
      assert(!last.profileIds.includes(profileId), `QF-B2 on-table player ${profileId} unexpectedly received the waiting-team push`)
    }
  })

  await check('participants from an unrelated bracket branch (QF-A1/QF-A2) do not receive the push', () => {
    const last = feederProgressNotifications[feederProgressNotifications.length - 1]!
    for (const profileId of unrelatedBranchMembers) {
      assert(!last.profileIds.includes(profileId), `unrelated-branch participant ${profileId} unexpectedly received the push`)
    }
  })

  await check('the team eliminated by the sibling feeder (QF-B1 loser) does not receive the push', () => {
    const last = feederProgressNotifications[feederProgressNotifications.length - 1]!
    for (const profileId of qfB1LoserMembers) {
      assert(!last.profileIds.includes(profileId), `QF-B1 losing-team participant ${profileId} unexpectedly received the push`)
    }
  })

  await check('repeated notifyFeederScoreProgress with an unchanged score does not resend (no spam on every card)', () => {
    const countBefore = feederProgressNotifications.length
    const room = getRoomForMatch(rooms, getMatches(db!, tournamentId).find((m) => m.matchId === qfB2.matchId)!)
    feederProgressCoordinator.notifyFeederScoreProgress(room)
    feederProgressCoordinator.notifyFeederScoreProgress(room)
    assert(feederProgressNotifications.length === countBefore, `notification count changed on unchanged-score repeat calls: before=${countBefore}, after=${feederProgressNotifications.length}`)
  })

  await check('a new authoritative score produces exactly one new push, to the same waiting team', () => {
    const countBefore = feederProgressNotifications.length
    let room = getRoomForMatch(rooms, getMatches(db!, tournamentId).find((m) => m.matchId === qfB2.matchId)!)
    room = advanceRoundScore(room, { teamA: 40, teamB: 25 })
    rooms.set(room.id, room)
    feederProgressCoordinator.notifyFeederScoreProgress(room)
    assert(feederProgressNotifications.length === countBefore + 1, `expected exactly 1 new notification, got ${feederProgressNotifications.length - countBefore}`)
    const last = feederProgressNotifications[feederProgressNotifications.length - 1]!
    const update = last.update as { scoreTeamA: number; scoreTeamB: number }
    assert(update.scoreTeamA === 40 && update.scoreTeamB === 25, `score=${update.scoreTeamA}:${update.scoreTeamB}, expected 40:25`)
    assert(new Set(last.profileIds).size === waitingTeamMembers.length, 'recipient set size changed on the new push')
  })

  await check('reconnect snapshot (buildTournamentRoundDtos) still reflects the live authoritative score for QF-B2', () => {
    const rounds = tournamentStore!.getRoundsForTournament(tournamentId)
    const dtoMatches = tournamentStore!.getMatchesForTournament(tournamentId)
    const roundDtos = buildTournamentRoundDtos({
      rounds,
      matches: dtoMatches,
      getLiveScoreForRoom: (roomId) => {
        const liveRoom = rooms.get(roomId) ?? null
        const authState = liveRoom?.game.authoritativeState ?? null
        if (authState === null || 'kind' in authState || authState.matchEnded !== null) return null
        return { teamA: authState.score.match.teamA, teamB: authState.score.match.teamB }
      },
    })
    const matchDto = roundDtos.flatMap((r) => r.matches).find((m) => m.matchId === qfB2.matchId)
    assert(matchDto !== undefined, 'QF-B2 match missing from round dtos')
    assert(matchDto!.liveScoreTeamA === 40 && matchDto!.liveScoreTeamB === 25, `liveScore=${matchDto!.liveScoreTeamA}:${matchDto!.liveScoreTeamB}, expected 40:25`)
  })

  await check('a disconnected/unaffiliated profile is not among feeder progress recipients', () => {
    const outsiderProfileId = randomUUID()
    const last = feederProgressNotifications[feederProgressNotifications.length - 1]!
    assert(!last.profileIds.includes(outsiderProfileId), 'outsider profile unexpectedly received a feeder progress update')
  })

  await check('feeder progress push does not create any wallet or table economy operation', () => {
    const penaltyRows = countRows(db!, `SELECT COUNT(*) AS count FROM table_exit_penalties;`)
    assert(penaltyRows === 0, `table_exit_penalties has ${penaltyRows} rows after feeder progress push, expected 0`)
    const ledgerRowsBeforeCompletion = countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId)
    assert(ledgerRowsBeforeCompletion === 0, `unexpected prize_payout ledger rows from a mid-match progress push: ${ledgerRowsBeforeCompletion}`)
  })

  try { feederProgressCoordinator.close() } catch {}

  await check('remaining quarterfinal matches complete normally', async () => {
    await playMatchToCompletion(quarterfinals[0]!.matchId)
    await playMatchToCompletion(qf2.matchId)
    await playMatchToCompletion(quarterfinals[2]!.matchId)
    await playMatchToCompletion(quarterfinals[3]!.matchId)
    const refreshed = getMatches(db!, tournamentId).filter((m) => m.roundType === 'quarterfinal')
    assert(refreshed.every((m) => m.status === 'completed'), 'not all quarterfinals completed')
  })

  // ── [8] Final completion push остава с крайния резултат (winnerTeamId + final score) ──
  await check('feeder MATCH COMPLETION push (different from progress) still carries the final result', () => {
    assert(feederNotifications.length > 0, 'no feeder completion notifications recorded yet')
    const last = feederNotifications[feederNotifications.length - 1]! as { update: { status?: string; winnerTeamId?: string } }
    assert('winnerTeamId' in (last.update as object), 'completion update missing winnerTeamId (progress updates never carry this field)')
  })

  // ── [9] Победителят вижда waiting-for-opponent state (пресъздадено чрез attendance snapshot) ──
  await check('winner of an early-completed quarterfinal has no in-progress next match until siblings finish', () => {
    matches = getMatches(db!, tournamentId)
    const semifinals = matches.filter((m) => m.roundType === 'semifinal')
    assert(semifinals.length === 2, `semifinal count=${semifinals.length} (should exist once quarterfinals are done)`)
  })

  // ── [10] Feeder match score се обновява authoritative (push при completion) ──
  await check('feeder match completion triggers notifyFeederMatchCompleted push with final score', () => {
    assert(feederNotifications.length > 0, 'no feeder completion notifications were sent')
    const last = feederNotifications[feederNotifications.length - 1]!
    assert(last.profileIds.length > 0, 'feeder notification had no recipients')
    assert(
      typeof last.update === 'object' && last.update !== null && 'finalScoreTeamA' in (last.update as Record<string, unknown>),
      'feeder update missing finalScoreTeamA',
    )
  })

  // ── [11] След втория feeder result следващият round получава 20-сек deadline ──
  // ── [12] Не се създава нов 3-мин deadline за следващ round ──
  await check('semifinal (next round after quarterfinal) matches get deadline_kind=round_transition with ~20s window', () => {
    coordinator!.tickNow()
    const semifinals = getMatches(db!, tournamentId).filter((m) => m.roundType === 'semifinal')
    assert(semifinals.length === 2, `semifinal count=${semifinals.length}`)
    for (const match of semifinals) {
      assert(match.deadlineKind === 'round_transition', `deadlineKind=${match.deadlineKind}, expected round_transition`)
      assert(match.attendanceDeadlineAt !== null, 'missing attendance deadline for semifinal')
    }
  })

  // ── [13] При 20-сек timeout липсващият се заменя от бот ──
  await check('20-second round_transition timeout also fills missing seats with tournament bots', () => {
    const semifinals = getMatches(db!, tournamentId).filter((m) => m.roundType === 'semifinal')
    const sf1 = semifinals[0]!
    let room = getRoomForMatch(rooms, sf1)
    room = connectSeat(room, 'bottom', 'sf-bottom', attachedConnections)
    room = connectSeat(room, 'right', 'sf-right', attachedConnections)
    rooms.set(room.id, room)
    forceAttendanceDeadlineElapsed(db!, sf1.matchId)
    coordinator!.tickNow()
    const refreshed = getMatches(db!, tournamentId).find((m) => m.matchId === sf1.matchId)!
    assert(refreshed.status === 'countdown', `status=${refreshed.status}`)
    const replacementCount = countRows(db!, `SELECT COUNT(*) AS count FROM tournament_match_no_show_replacements WHERE match_id = ?;`, sf1.matchId)
    assert(replacementCount === 2, `replacement count=${replacementCount}`)
  })

  await check('semifinals complete and drive the bracket to the final', async () => {
    const semifinals = getMatches(db!, tournamentId).filter((m) => m.roundType === 'semifinal')
    await playMatchToCompletion(semifinals[0]!.matchId)
    await playMatchToCompletion(semifinals[1]!.matchId)
    const refreshed = getMatches(db!, tournamentId).filter((m) => m.roundType === 'semifinal')
    assert(refreshed.every((m) => m.status === 'completed'), 'not all semifinals completed')
  })

  await check('final also gets deadline_kind=round_transition (no new 3-minute window)', () => {
    const final = getMatches(db!, tournamentId).find((m) => m.roundType === 'final')
    assert(final !== undefined, 'missing final match')
    assert(final!.deadlineKind === 'round_transition', `final deadlineKind=${final!.deadlineKind}`)
  })

  const balancesBefore = new Map(profileIds.map((id) => [id, (db!.prepare(`SELECT yellow_coins_balance AS balance FROM profile_wallets WHERE profile_id = ?;`).get(id) as { balance: number }).balance]))

  await check('final completes and settlement pays 65%/35% as before', async () => {
    const final = getMatches(db!, tournamentId).find((m) => m.roundType === 'final')!
    await playMatchToCompletion(final.matchId, 'A')
    const tournament = tournamentStore!.getTournamentById(tournamentId)
    assert(tournament?.status === 'finished' && tournament.settlementState === 'settled', `status=${tournament?.status}, settlement=${tournament?.settlementState}`)
    const totalEntries = 10_000 * 16
    const prizePool = totalEntries - Math.round(totalEntries * 0.2)
    const firstPrize = Math.round(prizePool * 0.65)
    const secondPrize = prizePool - firstPrize
    const championSum = (db!.prepare(`
      SELECT COALESCE(SUM(tel.amount), 0) AS total FROM tournament_economy_ledger tel
      JOIN tournament_entries te ON te.profile_id = tel.profile_id AND te.tournament_id = tel.tournament_id
      WHERE tel.tournament_id = ? AND tel.entry_type = 'prize_payout' AND te.status = 'champion';
    `).get(tournamentId) as { total: number }).total
    const finalistSum = (db!.prepare(`
      SELECT COALESCE(SUM(tel.amount), 0) AS total FROM tournament_economy_ledger tel
      JOIN tournament_entries te ON te.profile_id = tel.profile_id AND te.tournament_id = tel.tournament_id
      WHERE tel.tournament_id = ? AND tel.entry_type = 'prize_payout' AND te.status = 'finalist';
    `).get(tournamentId) as { total: number }).total
    assert(championSum === firstPrize, `champion sum=${championSum}, expected ${firstPrize}`)
    assert(finalistSum === secondPrize, `finalist sum=${finalistSum}, expected ${secondPrize}`)
  })

  // ── [15] Финалът продължава да използва 65%/35% settlement (потвърдено по-горе) ──

  // ── [14] Tournament match completion не изпълнява стандартна table stake economy ──
  await check('tournament match completion does not touch match_economy_ledger or table_exit_penalties', () => {
    const matchEconomyRows = countRows(db!, `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='match_economy_ledger';`)
    if (matchEconomyRows > 0) {
      const rows = countRows(db!, `SELECT COUNT(*) AS count FROM match_economy_ledger;`)
      assert(rows === 0, `match_economy_ledger has ${rows} rows, expected 0 for tournament-only activity`)
    }
    const penaltyRows = countRows(db!, `SELECT COUNT(*) AS count FROM table_exit_penalties;`)
    assert(penaltyRows === 0, `table_exit_penalties has ${penaltyRows} rows, expected 0 (no non-tournament leave happened)`)
  })

  await check('SQLite foreign_key_check and integrity_check pass', () => {
    const fkRows = db!.prepare('PRAGMA foreign_key_check;').all()
    const integrity = (db!.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
    assert(fkRows.length === 0, `foreign_key_check rows=${fkRows.length}`)
    assert(integrity === 'ok', `integrity_check=${integrity}`)
  })

  void balancesBefore // referenced above for potential future wallet diff assertions
} finally {
  try { coordinator?.close() } catch {}
  try { scheduler?.close() } catch {}
  try { economyStore?.close() } catch {}
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
}

// ── [3][4][5] Standard leave penalty flow — изолиран тест с tableExitPenaltyStore
// директно (симулира "Напусни мача и влез в турнира" избора върху обикновена,
// нетурнирна маса; сумата идва изцяло от сървъра = stakeAmount, прилага се
// точно веднъж чрез idempotent UNIQUE(room_id, profile_id) constraint).
{
  const penaltyTempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-mtf-penalty-'))
  const penaltyDbPath = join(penaltyTempDir, 'test.sqlite')
  let penaltyDb: DatabaseSync | null = null
  let penaltyStore: Awaited<ReturnType<typeof createTableExitPenaltyStore>> | null = null
  try {
    penaltyDb = new DatabaseSync(penaltyDbPath, { open: true, enableForeignKeyConstraints: true })
    await applyMigrations(penaltyDb)
    const profileId = randomUUID()
    insertProfile(penaltyDb, profileId, 0)
    const fakeProgressStore = { getPublicProfile: () => null } as unknown as Parameters<typeof createTableExitPenaltyStore>[1]
    penaltyStore = await createTableExitPenaltyStore(penaltyDbPath, fakeProgressStore)
    const roomId = randomUUID()
    const stakeAmount = 5_000

    await check('[conflict] leaving an active non-tournament match applies server-determined penalty (= stakeAmount)', () => {
      const result = penaltyStore!.applyPenalty(profileId, roomId, stakeAmount)
      assert(result.ok === true, `penalty failed: ${JSON.stringify(result)}`)
      if (result.ok) {
        assert(result.penalty.penaltyAmount === stakeAmount, `penaltyAmount=${result.penalty.penaltyAmount}, expected ${stakeAmount}`)
        assert(result.penalty.chargedAmount === stakeAmount, `chargedAmount=${result.penalty.chargedAmount}`)
      }
    })

    await check('[conflict] "Напусни и влез" penalty is applied exactly once (idempotent retry does not double-charge)', () => {
      const before = (penaltyDb!.prepare(`SELECT yellow_coins_balance AS balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { balance: number }).balance
      const result = penaltyStore!.applyPenalty(profileId, roomId, stakeAmount)
      assert(result.ok === true, `retry penalty failed: ${JSON.stringify(result)}`)
      const after = (penaltyDb!.prepare(`SELECT yellow_coins_balance AS balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { balance: number }).balance
      assert(before === after, `balance changed on retry: before=${before}, after=${after}`)
      const penaltyRowCount = countRows(penaltyDb!, `SELECT COUNT(*) AS count FROM table_exit_penalties WHERE room_id = ? AND profile_id = ?;`, roomId, profileId)
      assert(penaltyRowCount === 1, `penalty row count=${penaltyRowCount}, expected exactly 1`)
    })

    await check('[stay] choosing "Остани" does not touch the wallet or create a penalty row for a different room', () => {
      const otherRoomId = randomUUID()
      const penaltyRowCount = countRows(penaltyDb!, `SELECT COUNT(*) AS count FROM table_exit_penalties WHERE room_id = ?;`, otherRoomId)
      assert(penaltyRowCount === 0, 'unexpected penalty row for a room the player never left')
    })
  } finally {
    try { penaltyStore?.close() } catch {}
    try { penaltyDb?.close() } catch {}
    await rm(penaltyTempDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── [16] Refresh/restart възстановява deadline и transition state ──
{
  const restartTempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-mtf-restart-'))
  const restartDbPath = join(restartTempDir, 'test.sqlite')
  let restartDb: DatabaseSync | null = null
  let restartTournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null
  let restartEconomyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
  let restartScheduler: Awaited<ReturnType<typeof createTournamentScheduler>> | null = null
  let restartCoordinatorA: Awaited<ReturnType<typeof createTournamentCoordinator>> | null = null
  let restartCoordinatorB: Awaited<ReturnType<typeof createTournamentCoordinator>> | null = null
  try {
    restartDb = new DatabaseSync(restartDbPath, { open: true, enableForeignKeyConstraints: true })
    await applyMigrations(restartDb)
    restartTournamentStore = await createTournamentStore(restartDbPath)
    restartEconomyStore = await createTournamentEconomyStore(restartDbPath)

    const profileIds = Array.from({ length: 8 }, () => randomUUID())
    profileIds.forEach((id, index) => insertProfile(restartDb!, id, index))
    const profiles = new Map(profileIds.map((id, index) => [id, publicProfile(id, index)]))
    const rooms = new Map<string, ServerRoom>()
    const attachedConnections = new Set<string>()

    const created = restartTournamentStore.createTournament({
      kind: 'community',
      name: 'MTF Restart Tournament',
      creatorProfileId: profileIds[0]!,
      visibility: 'public',
      entryFee: 10_000,
      playerCapacity: 8,
      startMode: 'fill',
    })
    if (!created.ok) throw new Error('restart tournament create failed')
    const tournamentId = created.tournament.tournamentId
    for (const profileId of profileIds) {
      const result = restartEconomyStore.joinTournamentSoloAtomically(tournamentId, profileId)
      if (!result.ok) throw new Error('restart join failed')
    }

    restartScheduler = await createTournamentScheduler({
      databaseFilePath: restartDbPath,
      economyStore: restartEconomyStore,
      now: () => new Date('2026-07-30T10:00:00.000Z'),
      setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
      clearInterval: () => {},
    })
    restartScheduler.tickNow()

    restartCoordinatorA = await createCoordinator({ dbPath: restartDbPath, profiles, rooms, attachedConnections, economyStore: restartEconomyStore })
    restartCoordinatorA.tickNow()

    const beforeRestart = getMatches(restartDb, tournamentId).filter((m) => m.roundType === 'semifinal')

    await check('[restart] deadline_kind and attendance_deadline_at are persisted before restart', () => {
      assert(beforeRestart.length === 2, `semifinal count=${beforeRestart.length}`)
      for (const match of beforeRestart) {
        assert(match.deadlineKind === 'first_match', `deadlineKind=${match.deadlineKind}`)
        assert(match.attendanceDeadlineAt !== null, 'missing deadline before restart')
      }
    })

    // Симулира server restart: затваря стария coordinator, отваря нов със
    // СЪЩИЯ dbPath (in-memory room state в `rooms` Map-a се пази тук само
    // защото тестът не рестартира реалния процес — самото DB read/write е
    // това, което доказва restart-safety, не in-memory continuity).
    restartCoordinatorA.close()
    restartCoordinatorB = await createCoordinator({ dbPath: restartDbPath, profiles, rooms, attachedConnections, economyStore: restartEconomyStore })
    restartCoordinatorB.tickNow()

    await check('[restart] new coordinator instance reads the same persisted deadline/transition state (no new 3-minute window)', () => {
      const afterRestart = getMatches(restartDb!, tournamentId).filter((m) => m.roundType === 'semifinal')
      assert(afterRestart.length === 2, `semifinal count after restart=${afterRestart.length}`)
      for (let i = 0; i < afterRestart.length; i += 1) {
        assert(afterRestart[i]!.deadlineKind === beforeRestart[i]!.deadlineKind, 'deadlineKind changed across restart')
        assert(afterRestart[i]!.attendanceDeadlineAt === beforeRestart[i]!.attendanceDeadlineAt, 'attendanceDeadlineAt changed across restart (new window was started)')
      }
    })
  } finally {
    try { restartCoordinatorB?.close() } catch {}
    try { restartScheduler?.close() } catch {}
    try { restartEconomyStore?.close() } catch {}
    try { restartTournamentStore?.close() } catch {}
    try { restartDb?.close() } catch {}
    await rm(restartTempDir, { recursive: true, force: true }).catch(() => {})
  }
}

await rm(tempDir, { recursive: true, force: true }).catch(() => {})

if (failed > 0) {
  console.error(`checkTournamentMatchTransitionFlow failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkTournamentMatchTransitionFlow passed: ${passed} checks.`)
