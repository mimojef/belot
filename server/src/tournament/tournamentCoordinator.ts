import { randomUUID } from 'node:crypto'
import {
  SERVER_SEAT_ORDER,
  SERVER_TEAM_A_SEATS,
  SERVER_TEAM_B_SEATS,
  type BotRoomParticipant,
  type ConnectionId,
  type ProfileId,
  type PlayerPublicProfileSnapshot,
  type Seat,
  type ServerRoom,
  type Team,
  type TournamentAttendancePlayerSummary,
  type TournamentAttendanceSnapshot,
  type TournamentBotReplacementSnapshot,
  type TournamentRoomBannerSnapshot,
} from '../core/serverTypes.js'
import { createServerRoom } from '../core/createServerRoom.js'
import { createHumanParticipant } from '../core/createHumanParticipant.js'
import { createBotParticipant } from '../core/createBotParticipant.js'
import { seatParticipantInRoom } from '../core/seatParticipantInRoom.js'
import { initializeRoomAuthoritativeGameState } from '../game/initializeRoomAuthoritativeGameState.js'
import { dbDateToUtc } from '../db/dbDate.js'
import type {
  TournamentId,
  TournamentMatchId,
  TournamentRoundType,
  TournamentTeamId,
} from './tournamentTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TournamentMatchAssignment = {
  tournamentId: TournamentId
  tournamentName: string
  matchId: TournamentMatchId
  roomId: string
  roundType: TournamentRoundType
  seat: Seat
  teamId: TournamentTeamId
  partnerProfileId: ProfileId
  opponentTeamId: TournamentTeamId
  reconnectToken: string | null
}

export type TournamentCoordinatorHealth = {
  state: 'idle' | 'running' | 'stopped'
  inFlight: boolean
  lastTickAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  processedLastTick: number
  createdRoomsLastTick: number
  recoveredRoomsLastTick: number
  attendanceMatchesTracked: number
  attendanceResolvedLastTick: number
  walkoversLastTick: number
  botFillMatchesLastTick: number
  gameStartsLastTick: number
  takeoversLastTick: number
  recoveryActionsLastTick: number
}

export type TournamentBotTakeoverResult =
  | { ok: true; room: ServerRoom; seat: Seat }
  | { ok: false; reason: 'not_available' | 'invalid_profile' | 'match_completed' | 'seat_not_replaceable' }

export type TournamentCoordinator = {
  start: () => void
  stop: () => void
  tickNow: () => void
  onTournamentRoomCompleted: (room: ServerRoom) => void
  tryTakeoverNoShowBot: (input: {
    room: ServerRoom
    profileId: ProfileId
    connectionId: ConnectionId
    reconnectToken: string
  }) => TournamentBotTakeoverResult
  getAssignmentForProfile: (profileId: ProfileId) => TournamentMatchAssignment | null
  getHealth: () => TournamentCoordinatorHealth
  close: () => void
}

type PublicProfile = PlayerPublicProfileSnapshot

type TournamentCoordinatorDeps = {
  databaseFilePath: string
  getPublicProfile: (profileId: ProfileId) => PublicProfile | null
  getRoom: (roomId: string) => ServerRoom | null
  commitRoom: (room: ServerRoom) => void
  ensureRoomRuntime: (room: ServerRoom) => { ok: true } | { ok: false; reason: string }
  notifyAssignment: (profileId: ProfileId, assignment: TournamentMatchAssignment) => void
  isConnectionAttached: (input: {
    profileId: ProfileId
    connectionId: ConnectionId
    roomId: string
    seat: Seat
  }) => boolean
  intervalMs?: number
  batchSize?: number
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>
  clearInterval?: (id: ReturnType<typeof globalThis.setInterval>) => void
  logError?: (message: string, error: unknown) => void
}

type TournamentRow = {
  tournament_id: string
  name: string
  status: string
}

type MatchRow = {
  match_id: string
  tournament_id: string
  round_id: string
  room_id: string | null
  team_a_id: string
  team_b_id: string
  status: string
  no_show_deadline_at: string | null
  attendance_started_at: string | null
  attendance_deadline_at: string | null
  attendance_resolved_at: string | null
  attendance_resolution_kind: 'all_present' | 'walkover' | 'bots_inserted' | null
  game_start_at: string | null
  winner_team_id: string | null
  result_kind: string | null
  completed_at: string | null
  tournament_name: string
  tournament_status: string
  round_type: string
  round_index: number
}

type TeamEntryRow = {
  profile_id: string
  joined_as: string
  created_at: string
}

type SeatAssignment = {
  seat: Seat
  team: Team
  teamId: TournamentTeamId
  opponentTeamId: TournamentTeamId
  profileId: ProfileId
  partnerProfileId: ProfileId
  publicProfile: PublicProfile
}

type FinalSeedRow = {
  match_id: string
  winner_team_id: string
  completed_at: string
}

type ReplacementRow = {
  replacement_id: string
  tournament_id: string
  match_id: string
  room_id: string
  assigned_profile_id: string
  assigned_seat: Seat
  status: 'active' | 'takeover_pending' | 'completed'
  reconnect_token: string
  inserted_at: string
  takeover_requested_at: string | null
  takeover_completed_at: string | null
}

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_BATCH_SIZE = 25
const ATTENDANCE_WAIT_MS = 180_000
const START_COUNTDOWN_MS = 5_000
const BANNER_TTL_MS = 20_000

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function dbChanges(result: unknown): number {
  return typeof result === 'object' && result !== null && 'changes' in result
    ? Number((result as { changes?: unknown }).changes ?? 0)
    : 0
}

function utcNow(): string {
  return new Date().toISOString()
}

function addMsIso(baseIso: string, ms: number): string {
  return new Date(Date.parse(baseIso) + ms).toISOString()
}

function getTeamBySeat(seat: Seat): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function getTeamIdForSeat(match: MatchRow, seat: Seat): TournamentTeamId {
  return getTeamBySeat(seat) === 'A' ? match.team_a_id : match.team_b_id
}

function isTournamentRoom(room: ServerRoom): boolean {
  return room.config.isTournamentMatchOrigin === true && !!room.config.tournamentMatchId
}

function sortTeamEntries(entries: TeamEntryRow[]): TeamEntryRow[] {
  return [...entries].sort((a, b) => {
    const byRole = a.joined_as.localeCompare(b.joined_as)
    if (byRole !== 0) return byRole
    return a.created_at.localeCompare(b.created_at)
  })
}

function createPlayerSummary(assignment: SeatAssignment): TournamentAttendancePlayerSummary {
  return {
    seat: assignment.seat,
    team: assignment.team,
    displayName: assignment.publicProfile.displayName,
    avatarUrl: assignment.publicProfile.avatarUrl,
  }
}

function isRealGameStarted(room: ServerRoom): boolean {
  const state = room.game.authoritativeState
  return state !== null && !('kind' in state)
}

export async function createTournamentCoordinator(
  deps: TournamentCoordinatorDeps,
): Promise<TournamentCoordinator> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(deps.databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  const setTimer = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms))
  const clearTimer = deps.clearInterval ?? ((id) => globalThis.clearInterval(id))
  const logError = deps.logError ?? ((message, error) => console.error(message, error))

  const matchSelectColumns = `
    tm.match_id, tm.tournament_id, tm.round_id, tm.room_id, tm.team_a_id, tm.team_b_id,
    tm.status, tm.no_show_deadline_at, tm.attendance_started_at, tm.attendance_deadline_at,
    tm.attendance_resolved_at, tm.attendance_resolution_kind, tm.game_start_at,
    tm.winner_team_id, tm.result_kind, tm.completed_at,
    t.name as tournament_name, t.status as tournament_status,
    tr.round_type, tr.round_index
  `

  const selectActiveTournamentsStatement = database.prepare(`
    SELECT tournament_id, name, status
    FROM tournaments
    WHERE status IN ('starting', 'semifinal_in_progress', 'final_in_progress')
    ORDER BY started_at ASC, created_at ASC
    LIMIT ?;
  `)

  const selectRunnableMatchesStatement = database.prepare(`
    SELECT ${matchSelectColumns}
    FROM tournament_matches tm
    JOIN tournaments t ON t.tournament_id = tm.tournament_id
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
      AND tm.status IN ('awaiting_players', 'countdown', 'in_progress')
    ORDER BY tr.round_type ASC, tr.round_index ASC, tm.created_at ASC;
  `)

  const selectMatchByRoomStatement = database.prepare(`
    SELECT ${matchSelectColumns}
    FROM tournament_matches tm
    JOIN tournaments t ON t.tournament_id = tm.tournament_id
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.room_id = ?
    LIMIT 1;
  `)

  const selectMatchByIdStatement = database.prepare(`
    SELECT ${matchSelectColumns}
    FROM tournament_matches tm
    JOIN tournaments t ON t.tournament_id = tm.tournament_id
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.match_id = ?
    LIMIT 1;
  `)

  const selectEntriesForTeamStatement = database.prepare(`
    SELECT profile_id, joined_as, created_at
    FROM tournament_entries
    WHERE tournament_id = ? AND team_id = ? AND status IN ('confirmed', 'finalist', 'champion')
    ORDER BY created_at ASC;
  `)

  const claimRoomIdStatement = database.prepare(`
    UPDATE tournament_matches
    SET room_id = ?
    WHERE match_id = ?
      AND room_id IS NULL
      AND status IN ('awaiting_players', 'countdown', 'in_progress');
  `)

  const ensureAttendanceStartedStatement = database.prepare(`
    UPDATE tournament_matches
    SET attendance_started_at = COALESCE(attendance_started_at, ?),
        attendance_deadline_at = COALESCE(attendance_deadline_at, ?),
        no_show_deadline_at = COALESCE(no_show_deadline_at, ?),
        attendance_revision = attendance_revision + 1
    WHERE match_id = ?
      AND room_id IS NOT NULL
      AND status = 'awaiting_players'
      AND attendance_started_at IS NULL;
  `)

  const resolveAllPresentStatement = database.prepare(`
    UPDATE tournament_matches
    SET status = 'countdown',
        attendance_resolved_at = COALESCE(attendance_resolved_at, ?),
        attendance_resolution_kind = 'all_present',
        game_start_at = COALESCE(game_start_at, ?),
        attendance_revision = attendance_revision + 1
    WHERE match_id = ?
      AND status = 'awaiting_players'
      AND attendance_resolution_kind IS NULL;
  `)

  const resolveBotsStatement = database.prepare(`
    UPDATE tournament_matches
    SET status = 'countdown',
        attendance_resolved_at = COALESCE(attendance_resolved_at, ?),
        attendance_resolution_kind = 'bots_inserted',
        game_start_at = COALESCE(game_start_at, ?),
        attendance_revision = attendance_revision + 1
    WHERE match_id = ?
      AND status = 'awaiting_players'
      AND attendance_resolution_kind IS NULL;
  `)

  const resolveWalkoverStatement = database.prepare(`
    UPDATE tournament_matches
    SET status = 'completed',
        result_kind = 'walkover',
        winner_team_id = ?,
        walkover_reason = ?,
        missing_profile_ids = ?,
        completed_at = COALESCE(completed_at, ?),
        attendance_resolved_at = COALESCE(attendance_resolved_at, ?),
        attendance_resolution_kind = 'walkover',
        attendance_revision = attendance_revision + 1
    WHERE match_id = ?
      AND status = 'awaiting_players'
      AND attendance_resolution_kind IS NULL
      AND (winner_team_id IS NULL OR winner_team_id = ?);
  `)

  const markMatchInProgressStatement = database.prepare(`
    UPDATE tournament_matches
    SET status = 'in_progress', started_at = COALESCE(started_at, ?)
    WHERE match_id = ?
      AND room_id = ?
      AND status = 'countdown';
  `)

  const completeMatchStatement = database.prepare(`
    UPDATE tournament_matches
    SET status = 'completed',
        result_kind = ?,
        winner_team_id = ?,
        walkover_reason = NULL,
        missing_profile_ids = NULL,
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
    WHERE match_id = ?
      AND status != 'completed'
      AND (winner_team_id IS NULL OR winner_team_id = ?);
  `)

  const selectSemifinalWinnersStatement = database.prepare(`
    SELECT tm.match_id, tm.winner_team_id, tm.completed_at
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
      AND tr.round_type = 'semifinal'
      AND tm.status = 'completed'
      AND tm.result_kind IN ('played', 'played_with_bots', 'walkover')
      AND tm.winner_team_id IS NOT NULL
    ORDER BY tr.round_index ASC, tm.completed_at ASC;
  `)

  const insertReplacementStatement = database.prepare(`
    INSERT INTO tournament_match_no_show_replacements (
      replacement_id, tournament_id, match_id, room_id, assigned_profile_id,
      assigned_seat, status, reconnect_token
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    ON CONFLICT(match_id, assigned_profile_id) DO NOTHING;
  `)

  const selectReplacementsForMatchStatement = database.prepare(`
    SELECT replacement_id, tournament_id, match_id, room_id, assigned_profile_id,
           assigned_seat, status, reconnect_token, inserted_at,
           takeover_requested_at, takeover_completed_at
    FROM tournament_match_no_show_replacements
    WHERE match_id = ?
    ORDER BY inserted_at ASC;
  `)

  const selectReplacementForTakeoverStatement = database.prepare(`
    SELECT replacement_id, tournament_id, match_id, room_id, assigned_profile_id,
           assigned_seat, status, reconnect_token, inserted_at,
           takeover_requested_at, takeover_completed_at
    FROM tournament_match_no_show_replacements
    WHERE room_id = ? AND assigned_profile_id = ? AND reconnect_token = ?
    LIMIT 1;
  `)

  const markReplacementPendingStatement = database.prepare(`
    UPDATE tournament_match_no_show_replacements
    SET status = 'takeover_pending',
        takeover_requested_at = COALESCE(takeover_requested_at, CURRENT_TIMESTAMP)
    WHERE replacement_id = ?
      AND status = 'active';
  `)

  const markReplacementCompletedStatement = database.prepare(`
    UPDATE tournament_match_no_show_replacements
    SET status = 'completed',
        takeover_completed_at = COALESCE(takeover_completed_at, CURRENT_TIMESTAMP)
    WHERE replacement_id = ?
      AND status IN ('active', 'takeover_pending');
  `)

  const countActiveReplacementsForMatchStatement = database.prepare(`
    SELECT COUNT(*) as count
    FROM tournament_match_no_show_replacements
    WHERE match_id = ?;
  `)

  const updateTournamentStatusStatement = database.prepare(`
    UPDATE tournaments
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND status = ?;
  `)

  const insertFinalRoundStatement = database.prepare(`
    INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index)
    VALUES (?, ?, 'final', 1)
    ON CONFLICT(tournament_id, round_type, round_index) DO NOTHING;
  `)

  const selectFinalRoundStatement = database.prepare(`
    SELECT round_id
    FROM tournament_rounds
    WHERE tournament_id = ? AND round_type = 'final' AND round_index = 1
    LIMIT 1;
  `)

  const insertFinalMatchStatement = database.prepare(`
    INSERT INTO tournament_matches (
      match_id, tournament_id, round_id, room_id, team_a_id, team_b_id,
      status, no_show_deadline_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'awaiting_players', NULL);
  `)

  const selectFinalMatchStatement = database.prepare(`
    SELECT ${matchSelectColumns}
    FROM tournament_matches tm
    JOIN tournaments t ON t.tournament_id = tm.tournament_id
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
      AND tr.round_type = 'final'
      AND tr.round_index = 1
    LIMIT 1;
  `)

  const updateFinalistTeamsStatement = database.prepare(`
    UPDATE tournament_teams
    SET status = 'finalist', updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND team_id IN (?, ?) AND status IN ('locked', 'finalist');
  `)

  const updateEliminatedTeamsStatement = database.prepare(`
    UPDATE tournament_teams
    SET status = 'eliminated', updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ?
      AND team_id NOT IN (?, ?)
      AND status IN ('locked', 'finalist');
  `)

  const updateFinalistEntriesStatement = database.prepare(`
    UPDATE tournament_entries
    SET status = 'finalist', updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND team_id IN (?, ?) AND status = 'confirmed';
  `)

  const updateEliminatedEntriesStatement = database.prepare(`
    UPDATE tournament_entries
    SET status = 'eliminated', updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ?
      AND team_id NOT IN (?, ?)
      AND status = 'confirmed';
  `)

  const updateChampionTeamStatement = database.prepare(`
    UPDATE tournament_teams
    SET status = 'champion', updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND team_id = ? AND status IN ('finalist', 'champion');
  `)

  const updateRunnerUpTeamStatement = database.prepare(`
    UPDATE tournament_teams
    SET status = 'finalist', updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND team_id = ? AND status IN ('finalist', 'locked');
  `)

  const updateChampionEntriesStatement = database.prepare(`
    UPDATE tournament_entries
    SET status = 'champion', updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND team_id = ? AND status IN ('finalist', 'champion');
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO tournament_events (
      event_id, tournament_id, event_type, actor_profile_id, actor_role, payload_json
    ) VALUES (?, ?, ?, NULL, 'system', ?);
  `)

  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null
  let stopped = false
  let inFlight = false
  let lastTickAt: string | null = null
  let lastSuccessAt: string | null = null
  let lastError: string | null = null
  let processedLastTick = 0
  let createdRoomsLastTick = 0
  let recoveredRoomsLastTick = 0
  let attendanceMatchesTracked = 0
  let attendanceResolvedLastTick = 0
  let walkoversLastTick = 0
  let botFillMatchesLastTick = 0
  let gameStartsLastTick = 0
  let takeoversLastTick = 0
  let recoveryActionsLastTick = 0

  function appendEvent(
    tournamentId: TournamentId,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    insertEventStatement.run(randomUUID(), tournamentId, eventType, JSON.stringify(payload))
  }

  function getTeamEntries(tournamentId: TournamentId, teamId: TournamentTeamId): TeamEntryRow[] {
    return sortTeamEntries(
      selectEntriesForTeamStatement.all(tournamentId, teamId) as TeamEntryRow[],
    )
  }

  function getSeatAssignments(match: MatchRow): SeatAssignment[] {
    const teamAEntries = getTeamEntries(match.tournament_id, match.team_a_id)
    const teamBEntries = getTeamEntries(match.tournament_id, match.team_b_id)
    if (teamAEntries.length !== 2 || teamBEntries.length !== 2) {
      throw new Error(
        `Tournament match has invalid team sizes match=${match.match_id} teamA=${teamAEntries.length} teamB=${teamBEntries.length}`,
      )
    }

    const seatPlans: Array<{ seat: Seat; entry: TeamEntryRow; team: Team; teamId: string; opponentTeamId: string; partnerEntry: TeamEntryRow }> = [
      { seat: SERVER_TEAM_A_SEATS[0]!, entry: teamAEntries[0]!, team: 'A', teamId: match.team_a_id, opponentTeamId: match.team_b_id, partnerEntry: teamAEntries[1]! },
      { seat: SERVER_TEAM_A_SEATS[1]!, entry: teamAEntries[1]!, team: 'A', teamId: match.team_a_id, opponentTeamId: match.team_b_id, partnerEntry: teamAEntries[0]! },
      { seat: SERVER_TEAM_B_SEATS[0]!, entry: teamBEntries[0]!, team: 'B', teamId: match.team_b_id, opponentTeamId: match.team_a_id, partnerEntry: teamBEntries[1]! },
      { seat: SERVER_TEAM_B_SEATS[1]!, entry: teamBEntries[1]!, team: 'B', teamId: match.team_b_id, opponentTeamId: match.team_a_id, partnerEntry: teamBEntries[0]! },
    ]

    return seatPlans.map((plan) => {
      const publicProfile = deps.getPublicProfile(plan.entry.profile_id)
      if (publicProfile === null) {
        throw new Error(`Tournament participant profile missing profile=${plan.entry.profile_id}`)
      }
      return {
        seat: plan.seat,
        team: plan.team,
        teamId: plan.teamId,
        opponentTeamId: plan.opponentTeamId,
        profileId: plan.entry.profile_id,
        partnerProfileId: plan.partnerEntry.profile_id,
        publicProfile,
      }
    })
  }

  function buildRoom(match: MatchRow, roomId: string): ServerRoom {
    let room = createServerRoom({
      roomId,
      config: {
        allowBots: false,
        isPrivate: true,
        joinCode: null,
        stakeAmount: 0,
        targetScore: 151,
        isTournamentMatchOrigin: true,
        tournamentId: match.tournament_id,
        tournamentMatchId: match.match_id,
        tournamentRoundType: match.round_type as TournamentRoundType,
      },
    })

    for (const assignment of getSeatAssignments(match)) {
      room = seatParticipantInRoom(
        room,
        assignment.seat,
        createHumanParticipant({
          connectionId: null,
          identity: {
            profileId: assignment.profileId,
            displayName: assignment.publicProfile.displayName,
            avatarUrl: assignment.publicProfile.avatarUrl,
            level: assignment.publicProfile.level,
            rankTitle: assignment.publicProfile.rankTitle,
            skillRating: assignment.publicProfile.skillRating ?? null,
            gender: assignment.publicProfile.gender ?? null,
          },
          publicProfile: assignment.publicProfile,
        }),
      )
    }

    return refreshTournamentRoomSnapshot(match, room)
  }

  function getReconnectToken(room: ServerRoom, seat: Seat): string | null {
    const participant = room.seats[seat].participant
    if (participant?.kind === 'human') return participant.reconnectToken
    const replacement = participant?.kind === 'bot'
      ? participant.tournamentNoShowReplacement
      : null
    if (!replacement) return null
    const rows = selectReplacementsForMatchStatement.all(replacement.matchId) as ReplacementRow[]
    return rows.find((row) => row.assigned_seat === seat)?.reconnect_token ?? null
  }

  function createAssignments(match: MatchRow, room: ServerRoom): TournamentMatchAssignment[] {
    return getSeatAssignments(match).map((assignment) => ({
      tournamentId: match.tournament_id,
      tournamentName: match.tournament_name,
      matchId: match.match_id,
      roomId: room.id,
      roundType: match.round_type as TournamentRoundType,
      seat: assignment.seat,
      teamId: assignment.teamId,
      partnerProfileId: assignment.partnerProfileId,
      opponentTeamId: assignment.opponentTeamId,
      reconnectToken: getReconnectToken(room, assignment.seat),
    }))
  }

  function notifyAssignments(match: MatchRow, room: ServerRoom): void {
    const seatAssignments = getSeatAssignments(match)
    for (const assignment of createAssignments(match, room)) {
      const profileId = seatAssignments.find((item) => item.seat === assignment.seat)?.profileId
      if (profileId !== undefined) {
        deps.notifyAssignment(profileId, assignment)
      }
    }
  }

  function getPresentSeats(match: MatchRow, room: ServerRoom): Set<Seat> {
    const present = new Set<Seat>()
    for (const assignment of getSeatAssignments(match)) {
      const participant = room.seats[assignment.seat].participant
      if (
        participant?.kind === 'human' &&
        participant.isConnected &&
        participant.connectionId !== null &&
        participant.identity.profileId === assignment.profileId &&
        deps.isConnectionAttached({
          profileId: assignment.profileId,
          connectionId: participant.connectionId,
          roomId: room.id,
          seat: assignment.seat,
        })
      ) {
        present.add(assignment.seat)
      }
    }
    return present
  }

  function getMissingAssignments(match: MatchRow, room: ServerRoom): SeatAssignment[] {
    const present = getPresentSeats(match, room)
    return getSeatAssignments(match).filter((assignment) => !present.has(assignment.seat))
  }

  function createAttendanceSnapshot(match: MatchRow, room: ServerRoom): TournamentAttendanceSnapshot {
    const nowIso = utcNow()
    const missing = getMissingAssignments(match, room).map(createPlayerSummary)
    const state =
      match.status === 'completed'
        ? 'completed'
        : match.status === 'in_progress'
          ? 'started'
          : match.status === 'countdown'
            ? 'countdown'
            : match.attendance_resolution_kind !== null
              ? 'resolved'
              : 'waiting'
    const deadlineAt = match.attendance_deadline_at ?? match.no_show_deadline_at
    const gameStartAt = match.game_start_at
    const winnerTeamId = match.winner_team_id
    const loserTeamId =
      winnerTeamId === null
        ? null
        : winnerTeamId === match.team_a_id
          ? match.team_b_id
          : match.team_a_id

    return {
      state,
      serverNow: nowIso,
      deadlineAt,
      secondsRemaining: deadlineAt === null ? 0 : Math.max(0, Math.ceil((Date.parse(deadlineAt) - Date.parse(nowIso)) / 1000)),
      missingPlayers: missing,
      missingByTeam: {
        A: missing.filter((player) => player.team === 'A'),
        B: missing.filter((player) => player.team === 'B'),
      },
      resolutionKind: match.attendance_resolution_kind,
      gameStartAt,
      startSecondsRemaining: gameStartAt === null ? 0 : Math.max(0, Math.ceil((Date.parse(gameStartAt) - Date.parse(nowIso)) / 1000)),
      walkover: match.result_kind === 'walkover' && winnerTeamId !== null && loserTeamId !== null && match.completed_at !== null
        ? {
            winnerTeamId,
            loserTeamId,
            reason: 'one_team_missing_players',
            completedAt: dbDateToUtc(match.completed_at),
          }
        : null,
    }
  }

  function createReplacementSnapshots(match: MatchRow, room: ServerRoom): TournamentBotReplacementSnapshot[] {
    const assignments = getSeatAssignments(match)
    const replacements = selectReplacementsForMatchStatement.all(match.match_id) as ReplacementRow[]
    return replacements.map((replacement) => {
      const assignment = assignments.find((item) => item.seat === replacement.assigned_seat)
      const summary = assignment !== undefined
        ? createPlayerSummary(assignment)
        : {
            seat: replacement.assigned_seat,
            team: getTeamBySeat(replacement.assigned_seat),
            displayName: 'Играч',
            avatarUrl: null,
          }
      const participant = room.seats[replacement.assigned_seat].participant
      return {
        seat: replacement.assigned_seat,
        replacedPlayer: summary,
        takeoverAvailableForMe: replacement.status !== 'completed',
        takeoverPending: replacement.status === 'takeover_pending',
        takeoverCompleted: replacement.status === 'completed',
        replacementActive: participant?.kind === 'bot' && replacement.status !== 'completed',
      }
    })
  }

  function addBanner(room: ServerRoom, banner: Omit<TournamentRoomBannerSnapshot, 'expiresAt'>): ServerRoom {
    const existing = room.config.tournamentBanners ?? []
    if (existing.some((item) => item.id === banner.id)) return room
    const expiresAt = addMsIso(banner.createdAt, BANNER_TTL_MS)
    return {
      ...room,
      config: {
        ...room.config,
        tournamentBanners: [...existing, { ...banner, expiresAt }],
      },
    }
  }

  function refreshTournamentRoomSnapshot(match: MatchRow, room: ServerRoom): ServerRoom {
    const now = Date.now()
    const banners = (room.config.tournamentBanners ?? []).filter((banner) => Date.parse(banner.expiresAt) > now)
    return {
      ...room,
      updatedAt: now,
      config: {
        ...room.config,
        tournamentAttendance: createAttendanceSnapshot(match, room),
        tournamentBotReplacements: createReplacementSnapshots(match, room),
        tournamentBanners: banners,
      },
    }
  }

  function commitSnapshot(match: MatchRow, room: ServerRoom): ServerRoom {
    const refreshed = refreshTournamentRoomSnapshot(match, room)
    deps.commitRoom(refreshed)
    return refreshed
  }

  function ensureMatchRoom(match: MatchRow): 'created' | 'recovered' | 'existing' {
    let roomId = match.room_id
    let createdByThisTick = false
    if (roomId === null) {
      const candidateRoomId = randomUUID()
      const claimResult = claimRoomIdStatement.run(candidateRoomId, match.match_id)
      if (dbChanges(claimResult) > 0) {
        roomId = candidateRoomId
        match.room_id = roomId
        createdByThisTick = true
      } else {
        const current = selectMatchByIdStatement.get(match.match_id) as MatchRow | undefined
        if (current === undefined || current.room_id === null) {
          throw new Error(`Could not claim tournament match room match=${match.match_id}`)
        }
        roomId = current.room_id
        match = current
      }
    }

    const startIso = utcNow()
    const deadlineIso = addMsIso(startIso, ATTENDANCE_WAIT_MS)
    if (match.attendance_started_at === null) {
      const result = ensureAttendanceStartedStatement.run(
        startIso,
        deadlineIso,
        deadlineIso,
        match.match_id,
      )
      if (dbChanges(result) > 0) {
        match = selectMatchByIdStatement.get(match.match_id) as MatchRow
        appendEvent(match.tournament_id, 'tournament_attendance_started', {
          matchId: match.match_id,
          roundType: match.round_type,
          deadlineAt: match.attendance_deadline_at,
        })
      }
    }

    const existingRoom = deps.getRoom(roomId)
    if (existingRoom !== null) {
      const room = commitSnapshot(match, existingRoom)
      const ensureResult = deps.ensureRoomRuntime(room)
      if (!ensureResult.ok) {
        throw new Error(`No runtime capacity for tournament room=${roomId}: ${ensureResult.reason}`)
      }
      notifyAssignments(match, room)
      return 'existing'
    }

    const room = buildRoom(match, roomId)
    const ensureResult = deps.ensureRoomRuntime(room)
    if (!ensureResult.ok) {
      throw new Error(`No runtime capacity for tournament room=${room.id}: ${ensureResult.reason}`)
    }
    deps.commitRoom(room)
    notifyAssignments(match, room)
    appendEvent(match.tournament_id, createdByThisTick ? 'tournament_match_room_created' : 'tournament_match_room_recovered', {
      matchId: match.match_id,
      roundType: match.round_type,
    })
    return createdByThisTick ? 'created' : 'recovered'
  }

  function createNoShowBot(assignment: SeatAssignment): BotRoomParticipant {
    return createBotParticipant({
      botCode: `TournamentNoShow-${assignment.seat}`,
      difficulty: 'normal',
      behaviorPreset: 'balanced',
      logicSource: 'existing-core-v1',
      identity: {
        accountId: null,
        profileId: null,
        username: `tournament_no_show_${assignment.seat}`,
        displayName: `Бот вместо ${assignment.publicProfile.displayName}`,
        avatarUrl: null,
        level: null,
        rankTitle: null,
        skillRating: null,
        gender: null,
      },
      publicProfile: {
        profileId: null,
        displayName: `Бот вместо ${assignment.publicProfile.displayName}`,
        avatarUrl: null,
        isBot: true,
        yellowCoinsBalance: null,
      },
    })
  }

  function attachReplacementMetadata(
    bot: BotRoomParticipant,
    match: MatchRow,
    assignment: SeatAssignment,
    replacement: ReplacementRow,
  ): BotRoomParticipant {
    return {
      ...bot,
      tournamentNoShowReplacement: {
        tournamentId: match.tournament_id,
        matchId: match.match_id,
        assignedProfileId: assignment.profileId,
        assignedSeat: assignment.seat,
        replacementReason: 'no_show',
        insertedAt: dbDateToUtc(replacement.inserted_at),
        status: replacement.status,
      },
    }
  }

  function ensureTournamentBotsInRuntime(match: MatchRow, room: ServerRoom): ServerRoom {
    const assignments = getSeatAssignments(match)
    const replacements = selectReplacementsForMatchStatement.all(match.match_id) as ReplacementRow[]
    let nextRoom = room
    for (const replacement of replacements) {
      if (replacement.status === 'completed') continue
      const assignment = assignments.find((item) => item.seat === replacement.assigned_seat)
      if (assignment === undefined) continue
      const current = nextRoom.seats[assignment.seat].participant
      if (current?.kind === 'bot' && current.tournamentNoShowReplacement?.assignedProfileId === assignment.profileId) {
        continue
      }
      const bot = attachReplacementMetadata(
        createNoShowBot(assignment),
        match,
        assignment,
        replacement,
      )
      nextRoom = seatParticipantInRoom(nextRoom, assignment.seat, bot)
    }
    return refreshTournamentRoomSnapshot(match, nextRoom)
  }

  function resolveAttendance(match: MatchRow): MatchRow {
    if (match.room_id === null || match.status !== 'awaiting_players') return match
    const room = deps.getRoom(match.room_id)
    if (room === null) return match
    const missing = getMissingAssignments(match, room)
    if (missing.length === 0) {
      const nowIso = utcNow()
      const gameStartAt = addMsIso(nowIso, START_COUNTDOWN_MS)
      if (dbChanges(resolveAllPresentStatement.run(nowIso, gameStartAt, match.match_id)) > 0) {
        attendanceResolvedLastTick += 1
        appendEvent(match.tournament_id, 'tournament_attendance_all_present', {
          matchId: match.match_id,
          gameStartAt,
        })
      }
      return selectMatchByIdStatement.get(match.match_id) as MatchRow
    }

    const deadlineAt = match.attendance_deadline_at ?? match.no_show_deadline_at
    if (deadlineAt === null || Date.parse(deadlineAt) > Date.now()) {
      commitSnapshot(match, room)
      return match
    }

    const missingTeamA = missing.filter((item) => item.team === 'A')
    const missingTeamB = missing.filter((item) => item.team === 'B')
    const oneSidedWalkover = missingTeamA.length === 0 || missingTeamB.length === 0

    if (oneSidedWalkover) {
      const winnerTeamId = missingTeamA.length === 0 ? match.team_a_id : match.team_b_id
      const loserTeamId = winnerTeamId === match.team_a_id ? match.team_b_id : match.team_a_id
      const nowIso = utcNow()
      const reason = {
        kind: 'one_team_missing_players',
        missingTeam: missingTeamA.length > 0 ? 'A' : 'B',
        winnerTeamId,
        loserTeamId,
      }
      const missingProfileIds = missing.map((item) => item.profileId)
      if (dbChanges(resolveWalkoverStatement.run(
        winnerTeamId,
        JSON.stringify(reason),
        JSON.stringify(missingProfileIds),
        nowIso,
        nowIso,
        match.match_id,
        winnerTeamId,
      )) > 0) {
        attendanceResolvedLastTick += 1
        walkoversLastTick += 1
        appendEvent(match.tournament_id, 'tournament_match_walkover', {
          matchId: match.match_id,
          roundType: match.round_type,
          winnerTeamId,
          loserTeamId,
          missingCount: missing.length,
        })
      }
      const resolved = selectMatchByIdStatement.get(match.match_id) as MatchRow
      commitSnapshot(resolved, room)
      advanceCompletedMatch(resolved)
      return resolved
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      for (const assignment of missing) {
        const current = room.seats[assignment.seat].participant
        const reconnectToken = current?.kind === 'human' && current.reconnectToken !== null
          ? current.reconnectToken
          : randomUUID()
        insertReplacementStatement.run(
          randomUUID(),
          match.tournament_id,
          match.match_id,
          room.id,
          assignment.profileId,
          assignment.seat,
          reconnectToken,
        )
      }
      const nowIso = utcNow()
      const gameStartAt = addMsIso(nowIso, START_COUNTDOWN_MS)
      resolveBotsStatement.run(nowIso, gameStartAt, match.match_id)
      database.exec('COMMIT;')
      attendanceResolvedLastTick += 1
      botFillMatchesLastTick += 1
      appendEvent(match.tournament_id, 'tournament_no_show_bots_inserted', {
        matchId: match.match_id,
        roundType: match.round_type,
        botSeats: missing.map((item) => item.seat),
        gameStartAt,
      })
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw error
    }

    const resolved = selectMatchByIdStatement.get(match.match_id) as MatchRow
    let botRoom = ensureTournamentBotsInRuntime(resolved, room)
    const names = missing.map((item) => item.publicProfile.displayName).join(', ')
    botRoom = addBanner(botRoom, {
      id: `bots:${match.match_id}`,
      kind: 'bots_inserted',
      message: `${names} се заместват временно от ботове. Те могат да поемат местата си, когато се присъединят.`,
      createdAt: utcNow(),
    })
    commitSnapshot(resolved, botRoom)
    return resolved
  }

  function startResolvedMatchIfDue(match: MatchRow): void {
    if (match.status !== 'countdown' || match.room_id === null || match.game_start_at === null) return
    if (Date.parse(match.game_start_at) > Date.now()) {
      const room = deps.getRoom(match.room_id)
      if (room !== null) commitSnapshot(match, room)
      return
    }
    const room = deps.getRoom(match.room_id)
    if (room === null) return
    const withBots = match.attendance_resolution_kind === 'bots_inserted'
      ? ensureTournamentBotsInRuntime(match, room)
      : room
    const initialized = initializeRoomAuthoritativeGameState(withBots)
    const startedAt = utcNow()
    const update = markMatchInProgressStatement.run(startedAt, match.match_id, initialized.id)
    if (dbChanges(update) > 0) {
      gameStartsLastTick += 1
      appendEvent(match.tournament_id, 'tournament_match_game_started', {
        matchId: match.match_id,
        roundType: match.round_type,
        resolutionKind: match.attendance_resolution_kind,
      })
    }
    const refreshed = selectMatchByIdStatement.get(match.match_id) as MatchRow
    const ensureResult = deps.ensureRoomRuntime(initialized)
    if (!ensureResult.ok) {
      throw new Error(`No runtime capacity for tournament room=${initialized.id}: ${ensureResult.reason}`)
    }
    commitSnapshot(refreshed, initialized)
  }

  function ensureFinalAfterSemifinals(tournamentId: TournamentId): MatchRow | null {
    const winners = selectSemifinalWinnersStatement.all(tournamentId) as FinalSeedRow[]
    if (winners.length !== 2 || winners.some((winner) => winner.winner_team_id === null)) {
      return null
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      insertFinalRoundStatement.run(randomUUID(), tournamentId)
      const finalRound = selectFinalRoundStatement.get(tournamentId) as { round_id: string }
      const existingFinal = selectFinalMatchStatement.get(tournamentId) as MatchRow | undefined
      if (existingFinal === undefined) {
        insertFinalMatchStatement.run(
          randomUUID(),
          tournamentId,
          finalRound.round_id,
          winners[0]!.winner_team_id,
          winners[1]!.winner_team_id,
        )
        updateFinalistTeamsStatement.run(tournamentId, winners[0]!.winner_team_id, winners[1]!.winner_team_id)
        updateEliminatedTeamsStatement.run(tournamentId, winners[0]!.winner_team_id, winners[1]!.winner_team_id)
        updateFinalistEntriesStatement.run(tournamentId, winners[0]!.winner_team_id, winners[1]!.winner_team_id)
        updateEliminatedEntriesStatement.run(tournamentId, winners[0]!.winner_team_id, winners[1]!.winner_team_id)
        updateTournamentStatusStatement.run('final_in_progress', tournamentId, 'semifinal_in_progress')
        appendEvent(tournamentId, 'tournament_final_created', {
          semifinalMatchIds: winners.map((winner) => winner.match_id),
          finalistTeamIds: winners.map((winner) => winner.winner_team_id),
        })
      } else {
        updateTournamentStatusStatement.run('final_in_progress', tournamentId, 'semifinal_in_progress')
      }
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw error
    }

    return selectFinalMatchStatement.get(tournamentId) as MatchRow | null
  }

  function completeFinalSideEffects(match: MatchRow, winnerTeamId: TournamentTeamId): void {
    const runnerUpTeamId = winnerTeamId === match.team_a_id ? match.team_b_id : match.team_a_id
    updateChampionTeamStatement.run(match.tournament_id, winnerTeamId)
    updateRunnerUpTeamStatement.run(match.tournament_id, runnerUpTeamId)
    updateChampionEntriesStatement.run(match.tournament_id, winnerTeamId)
    appendEvent(match.tournament_id, 'tournament_final_completed', {
      matchId: match.match_id,
      roomId: match.room_id,
      winnerTeamId,
      runnerUpTeamId,
      payoutPending: true,
    })
  }

  function advanceCompletedMatch(match: MatchRow): void {
    if (match.winner_team_id === null) return
    if (match.round_type === 'semifinal') {
      const final = ensureFinalAfterSemifinals(match.tournament_id)
      if (final !== null && final.status !== 'completed') ensureMatchRoom(final)
      return
    }
    if (match.round_type === 'final') {
      completeFinalSideEffects(match, match.winner_team_id)
    }
  }

  function reconcileTournament(tournament: TournamentRow): void {
    const matches = selectRunnableMatchesStatement.all(tournament.tournament_id) as MatchRow[]
    for (const initialMatch of matches) {
      const result = ensureMatchRoom(initialMatch)
      if (result === 'created') createdRoomsLastTick += 1
      if (result === 'recovered') recoveredRoomsLastTick += 1
      let match = selectMatchByIdStatement.get(initialMatch.match_id) as MatchRow
      attendanceMatchesTracked += match.status === 'awaiting_players' || match.status === 'countdown' ? 1 : 0
      match = resolveAttendance(match)
      startResolvedMatchIfDue(match)
      processedLastTick += 1
    }

    if (tournament.status === 'starting') {
      const semifinalMatches = matches.filter((match) => match.round_type === 'semifinal')
      if (semifinalMatches.length === 2 && semifinalMatches.every((match) => match.room_id !== null)) {
        updateTournamentStatusStatement.run('semifinal_in_progress', tournament.tournament_id, 'starting')
      }
    }

    const final = ensureFinalAfterSemifinals(tournament.tournament_id)
    if (final !== null && final.status !== 'completed') {
      const result = ensureMatchRoom(final)
      if (result === 'created') createdRoomsLastTick += 1
      if (result === 'recovered') recoveredRoomsLastTick += 1
    }
  }

  function runTick(): void {
    if (stopped || inFlight) return
    inFlight = true
    lastTickAt = utcNow()
    processedLastTick = 0
    createdRoomsLastTick = 0
    recoveredRoomsLastTick = 0
    attendanceMatchesTracked = 0
    attendanceResolvedLastTick = 0
    walkoversLastTick = 0
    botFillMatchesLastTick = 0
    gameStartsLastTick = 0
    recoveryActionsLastTick = 0
    try {
      const tournaments = selectActiveTournamentsStatement.all(batchSize) as TournamentRow[]
      for (const tournament of tournaments) {
        reconcileTournament(tournament)
      }
      lastSuccessAt = utcNow()
      lastError = null
    } catch (error) {
      lastError = sanitizeError(error)
      logError('[tournament-coordinator] tick failed', error)
    } finally {
      inFlight = false
    }
  }

  function onTournamentRoomCompleted(room: ServerRoom): void {
    if (!isTournamentRoom(room)) return
    const authState = room.game.authoritativeState
    if (authState === null || 'kind' in authState || authState.matchEnded === null) {
      return
    }
    const match = selectMatchByRoomStatement.get(room.id) as MatchRow | undefined
    if (match === undefined) {
      throw new Error(`Tournament room has no DB match room=${room.id}`)
    }
    const winnerTeamId = authState.matchEnded.winnerTeam === 'A'
      ? match.team_a_id
      : match.team_b_id
    const replacementCount = (countActiveReplacementsForMatchStatement.get(match.match_id) as { count: number }).count
    const resultKind = replacementCount > 0 ? 'played_with_bots' : 'played'

    const updateResult = completeMatchStatement.run(resultKind, winnerTeamId, match.match_id, winnerTeamId)
    if (dbChanges(updateResult) > 0) {
      appendEvent(match.tournament_id, 'tournament_match_completed', {
        matchId: match.match_id,
        roomId: room.id,
        roundType: match.round_type,
        resultKind,
        winnerTeamId,
        completedAt: dbDateToUtc(new Date().toISOString()),
      })
    } else {
      const current = selectMatchByRoomStatement.get(room.id) as MatchRow | undefined
      if (current?.winner_team_id !== winnerTeamId) {
        throw new Error(
          `Conflicting tournament winner room=${room.id} existing=${current?.winner_team_id ?? 'null'} next=${winnerTeamId}`,
        )
      }
    }

    const completed = selectMatchByRoomStatement.get(room.id) as MatchRow
    advanceCompletedMatch(completed)
    commitSnapshot(completed, room)
  }

  function tryTakeoverNoShowBot(input: {
    room: ServerRoom
    profileId: ProfileId
    connectionId: ConnectionId
    reconnectToken: string
  }): TournamentBotTakeoverResult {
    if (!isTournamentRoom(input.room)) return { ok: false, reason: 'not_available' }
    const match = selectMatchByRoomStatement.get(input.room.id) as MatchRow | undefined
    if (match === undefined) return { ok: false, reason: 'not_available' }
    if (match.status === 'completed' || match.result_kind === 'walkover') {
      return { ok: false, reason: 'match_completed' }
    }
    const replacement = selectReplacementForTakeoverStatement.get(
      input.room.id,
      input.profileId,
      input.reconnectToken,
    ) as ReplacementRow | undefined
    if (replacement === undefined) return { ok: false, reason: 'invalid_profile' }
    if (replacement.status === 'completed') return { ok: false, reason: 'match_completed' }
    const assignment = getSeatAssignments(match).find((item) => {
      return item.profileId === input.profileId && item.seat === replacement.assigned_seat
    })
    if (assignment === undefined) return { ok: false, reason: 'invalid_profile' }
    const participant = input.room.seats[assignment.seat].participant
    if (
      participant?.kind !== 'bot' ||
      participant.tournamentNoShowReplacement?.assignedProfileId !== input.profileId
    ) {
      return { ok: false, reason: 'seat_not_replaceable' }
    }

    markReplacementPendingStatement.run(replacement.replacement_id)
    let pendingRoom = addBanner(input.room, {
      id: `takeover-pending:${replacement.replacement_id}`,
      kind: 'takeover_pending',
      message: `${assignment.publicProfile.displayName} се присъедини. Ще поеме мястото си след текущото игрово действие.`,
      createdAt: utcNow(),
    })
    const human = createHumanParticipant({
      connectionId: input.connectionId,
      reconnectToken: input.reconnectToken,
      identity: {
        profileId: input.profileId,
        displayName: assignment.publicProfile.displayName,
        avatarUrl: assignment.publicProfile.avatarUrl,
        level: assignment.publicProfile.level,
        rankTitle: assignment.publicProfile.rankTitle,
        skillRating: assignment.publicProfile.skillRating ?? null,
        gender: assignment.publicProfile.gender ?? null,
      },
      publicProfile: assignment.publicProfile,
    })
    pendingRoom = seatParticipantInRoom(pendingRoom, assignment.seat, human)
    const authState = pendingRoom.game.authoritativeState
    if (authState !== null && !('kind' in authState)) {
      authState.players[assignment.seat] = {
        ...authState.players[assignment.seat],
        mode: 'human',
        controlledByBot: false,
      }
    }
    markReplacementCompletedStatement.run(replacement.replacement_id)
    takeoversLastTick += 1
    appendEvent(match.tournament_id, 'tournament_no_show_bot_takeover_completed', {
      matchId: match.match_id,
      seat: assignment.seat,
      roundType: match.round_type,
    })
    const completedRoom = addBanner(pendingRoom, {
      id: `takeover-completed:${replacement.replacement_id}`,
      kind: 'takeover_completed',
      message: `${assignment.publicProfile.displayName} пое управлението от бота.`,
      createdAt: utcNow(),
    })
    const refreshed = commitSnapshot(match, completedRoom)
    deps.ensureRoomRuntime(refreshed)
    return { ok: true, room: refreshed, seat: assignment.seat }
  }

  function getAssignmentForProfile(profileId: ProfileId): TournamentMatchAssignment | null {
    for (const tournament of selectActiveTournamentsStatement.all(batchSize) as TournamentRow[]) {
      const matches = selectRunnableMatchesStatement.all(tournament.tournament_id) as MatchRow[]
      for (const match of matches) {
        if (match.room_id === null || match.status === 'completed') continue
        const room = deps.getRoom(match.room_id)
        if (room === null) continue
        const assignment = createAssignments(match, room).find((item) => {
          const seatAssignment = getSeatAssignments(match).find((seatItem) => seatItem.seat === item.seat)
          return seatAssignment?.profileId === profileId
        })
        if (assignment !== undefined) {
          return assignment
        }
      }
    }
    return null
  }

  return {
    start(): void {
      if (intervalId !== null) return
      stopped = false
      runTick()
      intervalId = setTimer(runTick, intervalMs)
      if (typeof intervalId === 'object' && intervalId !== null && 'unref' in intervalId) {
        ;(intervalId as { unref: () => void }).unref()
      }
    },
    stop(): void {
      stopped = true
      if (intervalId !== null) {
        clearTimer(intervalId)
        intervalId = null
      }
    },
    tickNow(): void {
      runTick()
    },
    onTournamentRoomCompleted,
    tryTakeoverNoShowBot,
    getAssignmentForProfile,
    getHealth(): TournamentCoordinatorHealth {
      return {
        state: stopped ? 'stopped' : intervalId === null ? 'idle' : 'running',
        inFlight,
        lastTickAt,
        lastSuccessAt,
        lastError,
        processedLastTick,
        createdRoomsLastTick,
        recoveredRoomsLastTick,
        attendanceMatchesTracked,
        attendanceResolvedLastTick,
        walkoversLastTick,
        botFillMatchesLastTick,
        gameStartsLastTick,
        takeoversLastTick,
        recoveryActionsLastTick,
      }
    },
    close(): void {
      if (intervalId !== null) {
        clearTimer(intervalId)
        intervalId = null
      }
      stopped = true
      database.close()
    },
  }
}
