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
import { removeParticipantFromRoom } from '../core/removeParticipantFromRoom.js'
import { seatParticipantInRoom } from '../core/seatParticipantInRoom.js'
import { initializeRoomAuthoritativeGameState } from '../game/initializeRoomAuthoritativeGameState.js'
import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'
import { dbDateToUtc } from '../db/dbDate.js'
import type {
  TournamentId,
  TournamentMatchId,
  TournamentRoundType,
  TournamentTeamId,
} from './tournamentTypes.js'
import { getTournamentRoundLadder } from './tournamentTypes.js'

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
  // Позволява на клиента да реши кой popup вариант да покаже (3-минутен
  // "първи мач" текст срещу 20-секунден "следващ кръг" текст, виж §3/§9 в
  // task spec-а) без отделна заявка — попада null само преди
  // ensureMatchRoom да е стартирал attendance прозореца за match-а.
  deadlineKind: 'first_match' | 'round_transition' | null
  attendanceDeadlineAt: string | null
  gameStartAt: string | null
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
  settlementAttemptsLastTick: number
  tournamentsSettledLastTick: number
  recoveryActionsLastTick: number
}

export type TournamentFeederMatchUpdate = {
  tournamentId: TournamentId
  matchId: TournamentMatchId
  roundType: TournamentRoundType
  winnerTeamId: TournamentTeamId
  finalScoreTeamA: number | null
  finalScoreTeamB: number | null
}

// Live progress update, докато feeder мачът все още се играе (§2 в task
// spec-а) — за разлика от TournamentFeederMatchUpdate (изпраща се веднъж,
// при completion, с winnerTeamId), тук status е винаги 'in_progress' и
// НЕ носи winnerTeamId. Payload-ът е нарочно минимален (само необходимото
// за "Отбор H срещу Отбор I / 96:74 / Мачът е в ход" екрана) — teamAId/
// teamBId се подават вместо display labels, защото label-ите (A-P букви)
// вече се извеждат на клиента от tournament detail данните.
export type TournamentFeederProgressUpdate = {
  tournamentId: TournamentId
  matchId: TournamentMatchId
  teamAId: TournamentTeamId
  teamBId: TournamentTeamId
  scoreTeamA: number
  scoreTeamB: number
  status: 'in_progress'
}

export type TournamentBotTakeoverResult =
  | { ok: true; room: ServerRoom; seat: Seat }
  | { ok: false; reason: 'not_available' | 'invalid_profile' | 'match_completed' | 'seat_not_replaceable' }

export type TournamentCoordinator = {
  start: () => void
  stop: () => void
  tickNow: () => void
  onTournamentRoomCompleted: (room: ServerRoom) => void
  // Извиква се от произволен "authoritative room state advance" hook на
  // сървъра (виж commitServerRoomWithSnapshot в index.ts — единствената
  // истински универсална точка, през която минават и worker-tick и direct
  // submit_play_card commits) — coordinator-ът сам решава дали score-ът
  // реално се е променил (in-memory last-known map по matchId) и дали
  // изобщо има чакащи участници, преди да push-не нещо. No-op за
  // нетурнирни стаи или ако score-ът не се е променил след последния push.
  notifyFeederScoreProgress: (room: ServerRoom) => void
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
  // Извиква се веднъж, точно когато турнирен мач стане completed (walkover
  // или нормално изигран) — премахва runtime стаята от serverState/worker
  // pool ВЕДНАГА и detach-ва всички още свързани connections (виж коментара
  // при finishTournamentRoom/closeCompletedTournamentRoom по-долу).
  // Детерминирано и не зависи от TTL/reconnect-grace логиката на
  // shouldKeepRoomAlive, която иначе би държала стаята жива, докато победилият
  // отбор е все още свързан.
  closeCompletedRoom: (room: ServerRoom) => void
  ensureRoomRuntime: (room: ServerRoom) => { ok: true } | { ok: false; reason: string }
  settleTournamentPrizes: (tournamentId: TournamentId) => {
    ok: boolean
    alreadySettled?: boolean
    reason?: string
  }
  notifyAssignment: (profileId: ProfileId, assignment: TournamentMatchAssignment) => void
  // Push при завършек на всеки НЕ-финален турнирен мач (§8/§12 в task spec-а
  // — "live" feeder резултат) — само completion събитие, без per-точка
  // score (виж коментара при advanceCompletedMatch). Извиква се за всички
  // все още активни участници в турнира; клиентът сам решава дали match-ът
  // е този, който гледа в момента (сравнява по matchId).
  notifyFeederMatchCompleted: (profileIds: ProfileId[], update: TournamentFeederMatchUpdate) => void
  notifyFeederScoreProgress: (profileIds: ProfileId[], update: TournamentFeederProgressUpdate) => void
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
  player_capacity: number
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
  deadline_kind: 'first_match' | 'round_transition' | null
  game_start_at: string | null
  winner_team_id: string | null
  result_kind: string | null
  completed_at: string | null
  final_score_team_a: number | null
  final_score_team_b: number | null
  tournament_name: string
  tournament_status: string
  tournament_player_capacity: number
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

type RoundWinnerRow = {
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
// Първият bracket кръг (getTournamentRoundLadder(teamCapacity)[0]) получава
// пълен 3-минутен server-authoritative прозорец за всеки отбор — играчите
// тепърва се събират след tournament fill/scheduled start (виж §3 в task
// spec-а). Всеки следващ кръг (round_transition) използва много по-кратък
// 20-секунден прозорец — отборите вече знаят, че продължават (виж §9),
// затова не се чака ново 3-минутно "събиране".
const ATTENDANCE_WAIT_MS_FIRST_MATCH = 180_000
const ATTENDANCE_WAIT_MS_ROUND_TRANSITION = 20_000
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

// Определя дали даден мач е "първият за отбора" (пълен bracket ladder[0]
// round type за съответния teamCapacity) или "round transition" (всеки
// следващ ladder round) — виж коментара при ATTENDANCE_WAIT_MS_* по-горе.
function getMatchDeadlineKind(match: MatchRow): 'first_match' | 'round_transition' {
  const teamCapacity = match.tournament_player_capacity / 2
  const firstRoundType = getTournamentRoundLadder(teamCapacity)[0]
  return match.round_type === firstRoundType ? 'first_match' : 'round_transition'
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
    tm.attendance_resolved_at, tm.attendance_resolution_kind, tm.deadline_kind, tm.game_start_at,
    tm.winner_team_id, tm.result_kind, tm.completed_at,
    tm.final_score_team_a, tm.final_score_team_b,
    t.name as tournament_name, t.status as tournament_status, t.player_capacity as tournament_player_capacity,
    tr.round_type, tr.round_index
  `

  const selectActiveTournamentsStatement = database.prepare(`
    SELECT tournament_id, name, status, player_capacity
    FROM tournaments
    WHERE status IN ('starting', 'semifinal_in_progress', 'final_in_progress')
    ORDER BY started_at ASC, created_at ASC
    LIMIT ?;
  `)

  const selectSettlementDueTournamentsStatement = database.prepare(`
    SELECT DISTINCT t.tournament_id, t.name, t.status, t.player_capacity
    FROM tournaments t
    JOIN tournament_rounds tr
      ON tr.tournament_id = t.tournament_id
     AND tr.round_type = 'final'
     AND tr.round_index = 1
    JOIN tournament_matches tm
      ON tm.round_id = tr.round_id
     AND tm.status = 'completed'
     AND tm.result_kind IN ('played', 'played_with_bots', 'walkover')
     AND tm.winner_team_id IS NOT NULL
    WHERE t.status = 'final_in_progress'
      AND t.settlement_state = 'pending'
    ORDER BY t.updated_at ASC
    LIMIT ?;
  `)

  const selectConfirmedProfileIdsForTournamentStatement = database.prepare(`
    SELECT DISTINCT profile_id
    FROM tournament_entries
    WHERE tournament_id = ?
      AND status IN ('confirmed', 'finalist', 'champion', 'eliminated');
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

  // Намира sibling feeder мача на same round_type/round_index bracket слот —
  // ползва се от resolveWaitingTeamIdForFeeder, за да открие другия feeder
  // на споделения downstream мач БЕЗ downstream match row да съществува
  // вече (виж коментара при ensureNextRound: следващият кръг се създава
  // едва след като И ДВАТА sibling мача имат победител).
  const selectMatchByRoundPositionStatement = database.prepare(`
    SELECT ${matchSelectColumns}
    FROM tournament_matches tm
    JOIN tournaments t ON t.tournament_id = tm.tournament_id
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ? AND tr.round_type = ? AND tr.round_index = ?
    LIMIT 1;
  `)

  // Включва и 'eliminated' — веднъж назначени към даден match (team_a_id/
  // team_b_id са immutable за мача), участниците трябва да продължат да се
  // resolve-ват коректно в getSeatAssignments/createAttendanceSnapshot дори
  // след като advanceCompletedMatch вече е маркирал загубилия отбор като
  // eliminated в рамките на СЪЩИЯ tick (commitSnapshot се вика за completed
  // мача веднага след advanceCompletedMatch — виж onTournamentRoomCompleted).
  const selectEntriesForTeamStatement = database.prepare(`
    SELECT profile_id, joined_as, created_at
    FROM tournament_entries
    WHERE tournament_id = ? AND team_id = ? AND status IN ('confirmed', 'finalist', 'champion', 'eliminated')
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
        deadline_kind = COALESCE(deadline_kind, ?),
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
        final_score_team_a = ?,
        final_score_team_b = ?,
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
    WHERE match_id = ?
      AND status != 'completed'
      AND (winner_team_id IS NULL OR winner_team_id = ?);
  `)

  // round_type е bind параметър — преизползва се за всеки не-final кръг в
  // ladder-а (round_of_16/quarterfinal/semifinal), виж advanceCompletedRoundIfDue.
  const selectRoundWinnersStatement = database.prepare(`
    SELECT tm.match_id, tm.winner_team_id, tm.completed_at
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
      AND tr.round_type = ?
      AND tm.status = 'completed'
      AND tm.result_kind IN ('played', 'played_with_bots', 'walkover')
      AND tm.winner_team_id IS NOT NULL
    ORDER BY tr.round_index ASC, tm.completed_at ASC;
  `)

  // Общ брой мачове, зачислени за даден round_type (независимо от статус) —
  // ползва се за да разберем дали кръгът вече Е генериран (за да не се
  // опитаме да го генерираме повторно) и дали е напълно завършен.
  const countMatchesForRoundTypeStatement = database.prepare(`
    SELECT COUNT(*) as count
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ? AND tr.round_type = ?;
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

  // Generic версии за средните bracket кръгове (round_of_16 -> quarterfinal,
  // quarterfinal -> semifinal) — round_type/round_index са bind параметри,
  // за разлика от insertFinalRoundStatement/selectFinalRoundStatement, които
  // остават хардкоднати за 'final'/1 (финалът винаги е round_index=1,
  // независимо от bracket размера — не е "различен" случай за generalize).
  const insertNextRoundStatement = database.prepare(`
    INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tournament_id, round_type, round_index) DO NOTHING;
  `)

  const selectNextRoundIdStatement = database.prepare(`
    SELECT round_id
    FROM tournament_rounds
    WHERE tournament_id = ? AND round_type = ? AND round_index = ?
    LIMIT 1;
  `)

  const selectMatchesForRoundTypeStatement = database.prepare(`
    SELECT ${matchSelectColumns}
    FROM tournament_matches tm
    JOIN tournaments t ON t.tournament_id = tm.tournament_id
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ? AND tr.round_type = ?
    ORDER BY tr.round_index ASC;
  `)

  // Елиминира отбори, които НЕ продължават към следващия кръг (загубили в
  // средните rounds — round_of_16/quarterfinal — трябва да станат eliminated
  // веднага, не да чакат до финала, за разлика от предишната 4-отборна
  // логика, където единствената elimination точка беше финалът).
  const updateRoundLosersEliminatedTeamsStatement = database.prepare(`
    UPDATE tournament_teams
    SET status = 'eliminated', updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND team_id = ? AND status IN ('locked', 'finalist');
  `)

  const updateRoundLosersEliminatedEntriesStatement = database.prepare(`
    UPDATE tournament_entries
    SET status = 'eliminated', updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND team_id = ? AND status = 'confirmed';
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
  let settlementAttemptsLastTick = 0
  let tournamentsSettledLastTick = 0
  let settlementPendingLastTick = false
  let recoveryActionsLastTick = 0
  // Последно изпратен live score per match_id — само in-memory (не се
  // persist-ва, виж §2 в task spec-а: "DB не е задължително да persist-ва
  // всеки междинен резултат"). Reset-ва се естествено при server restart;
  // след restart чакащите клиенти получават текущия резултат чрез detail
  // fetch (final_score_* остава null докато мачът тече — snapshot-ът пита
  // самата активна room state directно, виж createTournamentDetailSnapshot
  // reconnect flow-a на клиента), не чрез този push механизъм.
  const lastNotifiedFeederScoreByMatchId = new Map<string, string>()

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
      deadlineKind: match.deadline_kind,
      attendanceDeadlineAt: match.attendance_deadline_at,
      gameStartAt: match.game_start_at,
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

  // Затваря runtime стаята на completed турнирен мач (walkover или нормално
  // изигран, виж resolveAttendance/onTournamentRoomCompleted) — root cause
  // на production инцидента: ServerRoom.status никъде другаде в кодовата
  // база не се задава на 'finished', а shouldKeepRoomAlive третира ВСЯКА
  // турнирна стая с status !== 'finished' като "пази вечно", независимо от
  // резултата на мача. active_room_snapshots.upsertRoom също решава
  // is_active/deletion единствено по room.status. Затова тук изрично
  // маркираме и status, и game.phase като 'finished' ПРЕДИ commit, и веднага
  // след това извикваме deps.closeCompletedRoom — детерминирано, независимо
  // дали печелившият отбор все още е свързан (roomHasConnectedHumanParticipants
  // би върнал true и би отложил обичайния TTL-basiran reap инак).
  function finishTournamentRoom(match: MatchRow, room: ServerRoom): ServerRoom {
    const refreshed = refreshTournamentRoomSnapshot(match, room)
    return {
      ...refreshed,
      status: 'finished',
      game: {
        ...refreshed.game,
        phase: 'finished',
      },
    }
  }

  function closeCompletedTournamentRoom(match: MatchRow, room: ServerRoom): void {
    const finishedRoom = finishTournamentRoom(match, room)
    deps.commitRoom(finishedRoom)
    deps.closeCompletedRoom(finishedRoom)
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
    const deadlineKind = getMatchDeadlineKind(match)
    const waitMs = deadlineKind === 'first_match' ? ATTENDANCE_WAIT_MS_FIRST_MATCH : ATTENDANCE_WAIT_MS_ROUND_TRANSITION
    const deadlineIso = addMsIso(startIso, waitMs)
    if (match.attendance_started_at === null) {
      const result = ensureAttendanceStartedStatement.run(
        startIso,
        deadlineIso,
        deadlineIso,
        deadlineKind,
        match.match_id,
      )
      if (dbChanges(result) > 0) {
        match = selectMatchByIdStatement.get(match.match_id) as MatchRow
        appendEvent(match.tournament_id, 'tournament_attendance_started', {
          matchId: match.match_id,
          roundType: match.round_type,
          deadlineAt: match.attendance_deadline_at,
          deadlineKind,
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
      nextRoom = seatParticipantInRoom(removeParticipantFromRoom(nextRoom, assignment.seat), assignment.seat, bot)
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
      closeCompletedTournamentRoom(resolved, room)
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

  // Генерира следващия bracket кръг за (currentRoundType -> nextRoundType)
  // веднага щом ВСИЧКИ мачове от currentRoundType са завършени с победител.
  // Pairing: winner[0] vs winner[1], winner[2] vs winner[3]... по match
  // order (round_index ASC) — устойчиво на bracket структурата, защото
  // самото seed pairing (high-vs-low) вече е "изпечено" в първия кръг
  // (createFirstRoundBracket), следващите кръгове само следват дървото.
  //
  // Ако nextRoundType === 'final': двамата финалисти стават 'finalist',
  // всички останали locked/finalist отбори стават 'eliminated' (пази
  // текущия settlement contract — само финалистите получават prize payout).
  // Ако nextRoundType Е междинен кръг (напр. quarterfinal -> semifinal):
  // само загубилите в currentRoundType стават 'eliminated' веднага —
  // победителите остават 'locked' до следващия round transition.
  function ensureNextRound(
    tournamentId: TournamentId,
    currentRoundType: TournamentRoundType,
    nextRoundType: TournamentRoundType,
  ): MatchRow[] | null {
    const currentMatches = selectMatchesForRoundTypeStatement.all(tournamentId, currentRoundType) as MatchRow[]
    if (currentMatches.length === 0) return null
    const winners = selectRoundWinnersStatement.all(tournamentId, currentRoundType) as RoundWinnerRow[]
    if (winners.length !== currentMatches.length || winners.some((winner) => winner.winner_team_id === null)) {
      return null
    }
    if (winners.length % 2 !== 0) {
      throw new Error(`Odd number of round winners for tournament=${tournamentId} round=${currentRoundType}`)
    }

    const nextMatchCount = winners.length / 2
    const existingNextMatches = selectMatchesForRoundTypeStatement.all(tournamentId, nextRoundType) as MatchRow[]
    if (existingNextMatches.length >= nextMatchCount) {
      return existingNextMatches
    }

    const loserTeamIds = currentMatches
      .filter((match) => match.winner_team_id !== null)
      .map((match) => (match.winner_team_id === match.team_a_id ? match.team_b_id : match.team_a_id))

    database.exec('BEGIN IMMEDIATE;')
    try {
      const isFinal = nextRoundType === 'final'
      const createdMatchIds: string[] = []
      for (let i = 0; i < nextMatchCount; i += 1) {
        const roundIndex = i + 1
        const teamAId = winners[i * 2]!.winner_team_id
        const teamBId = winners[i * 2 + 1]!.winner_team_id
        insertNextRoundStatement.run(randomUUID(), tournamentId, nextRoundType, roundIndex)
        const round = selectNextRoundIdStatement.get(tournamentId, nextRoundType, roundIndex) as { round_id: string }
        const existingMatch = existingNextMatches.find((match) => match.round_id === round.round_id)
        if (existingMatch === undefined) {
          const matchId = randomUUID()
          insertFinalMatchStatement.run(matchId, tournamentId, round.round_id, teamAId, teamBId)
          createdMatchIds.push(matchId)
          if (isFinal) {
            updateFinalistTeamsStatement.run(tournamentId, teamAId, teamBId)
            updateFinalistEntriesStatement.run(tournamentId, teamAId, teamBId)
          }
        }
      }

      if (isFinal) {
        updateEliminatedTeamsStatement.run(tournamentId, winners[0]!.winner_team_id, winners[1]!.winner_team_id)
        updateEliminatedEntriesStatement.run(tournamentId, winners[0]!.winner_team_id, winners[1]!.winner_team_id)
        if (createdMatchIds.length > 0) {
          updateTournamentStatusStatement.run('final_in_progress', tournamentId, 'semifinal_in_progress')
          appendEvent(tournamentId, 'tournament_final_created', {
            semifinalMatchIds: winners.map((winner) => winner.match_id),
            finalistTeamIds: winners.map((winner) => winner.winner_team_id),
          })
        }
      } else {
        for (const loserTeamId of loserTeamIds) {
          updateRoundLosersEliminatedTeamsStatement.run(tournamentId, loserTeamId)
          updateRoundLosersEliminatedEntriesStatement.run(tournamentId, loserTeamId)
        }
        if (createdMatchIds.length > 0) {
          appendEvent(tournamentId, 'tournament_round_advanced', {
            fromRoundType: currentRoundType,
            toRoundType: nextRoundType,
            winnerTeamIds: winners.map((winner) => winner.winner_team_id),
            eliminatedTeamIds: loserTeamIds,
          })
        }
      }
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw error
    }

    return selectMatchesForRoundTypeStatement.all(tournamentId, nextRoundType) as MatchRow[]
  }

  // Обхожда ladder-а от текущия round_type (или от началото, ако все още
  // никой мач не е завършен) до финала, генерирайки всеки следващ кръг,
  // веднага щом предишният е напълно завършен. Връща финалния мач (ако вече
  // съществува), за да поддържа съществуващия "ensureMatchRoom(final)" caller.
  function advanceBracketLadder(tournamentId: TournamentId, teamCapacity: number): MatchRow | null {
    const ladder = getTournamentRoundLadder(teamCapacity)
    for (let i = 0; i < ladder.length - 1; i += 1) {
      const currentRoundType = ladder[i] as TournamentRoundType
      const nextRoundType = ladder[i + 1] as TournamentRoundType
      ensureNextRound(tournamentId, currentRoundType, nextRoundType)
    }
    return (selectFinalMatchStatement.get(tournamentId) as MatchRow | undefined) ?? null
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
    settlementAttemptsLastTick += 1
    const settlement = deps.settleTournamentPrizes(match.tournament_id)
    if (settlement.ok) {
      if (settlement.alreadySettled !== true) {
        tournamentsSettledLastTick += 1
        appendEvent(match.tournament_id, 'tournament_finished', {
          matchId: match.match_id,
          winnerTeamId,
          runnerUpTeamId,
        })
      }
    } else {
      settlementPendingLastTick = true
      lastError = `tournament settlement pending: ${settlement.reason ?? 'failed'}`
    }
  }

  function advanceCompletedMatch(match: MatchRow): void {
    if (match.winner_team_id === null) return
    if (match.round_type === 'final') {
      completeFinalSideEffects(match, match.winner_team_id)
      return
    }
    // Всеки не-final round type (round_of_16/quarterfinal/semifinal) следва
    // общата ladder логика — не само 'semifinal' както преди.
    const final = advanceBracketLadder(match.tournament_id, match.tournament_player_capacity / 2)
    if (final !== null && final.status !== 'completed') ensureMatchRoom(final)

    const profileIds = (selectConfirmedProfileIdsForTournamentStatement.all(match.tournament_id) as Array<{ profile_id: ProfileId }>)
      .map((row) => row.profile_id)
    deps.notifyFeederMatchCompleted(profileIds, {
      tournamentId: match.tournament_id,
      matchId: match.match_id,
      roundType: match.round_type as TournamentRoundType,
      winnerTeamId: match.winner_team_id,
      finalScoreTeamA: match.final_score_team_a,
      finalScoreTeamB: match.final_score_team_b,
    })
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
      // Първият bracket кръг (винаги getTournamentRoundLadder(...)[0]) е
      // "текущият" кръг, докато турнирът е still 'starting' — веднага щом
      // всичките му мачове имат стая, статусът минава към 'semifinal_in_progress'
      // (генеричен "bracket-в-ход" маркер, виж коментара в advanceBracketLadder-а).
      const teamCapacity = tournament.player_capacity / 2
      const firstRoundType = getTournamentRoundLadder(teamCapacity)[0]
      const firstRoundMatches = matches.filter((match) => match.round_type === firstRoundType)
      if (
        firstRoundMatches.length === teamCapacity / 2 &&
        firstRoundMatches.every((match) => match.room_id !== null)
      ) {
        updateTournamentStatusStatement.run('semifinal_in_progress', tournament.tournament_id, 'starting')
      }
    }

    const final = advanceBracketLadder(tournament.tournament_id, tournament.player_capacity / 2)
    if (final !== null && final.status !== 'completed') {
      const result = ensureMatchRoom(final)
      if (result === 'created') createdRoomsLastTick += 1
      if (result === 'recovered') recoveredRoomsLastTick += 1
    }
  }

  function reconcileSettlementDueTournament(tournament: TournamentRow): void {
    settlementAttemptsLastTick += 1
    const settlement = deps.settleTournamentPrizes(tournament.tournament_id)
    if (settlement.ok) {
      if (settlement.alreadySettled !== true) {
        tournamentsSettledLastTick += 1
      }
      processedLastTick += 1
      return
    }
    settlementPendingLastTick = true
    lastError = `tournament settlement pending: ${settlement.reason ?? 'failed'}`
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
    settlementAttemptsLastTick = 0
    tournamentsSettledLastTick = 0
    settlementPendingLastTick = false
    recoveryActionsLastTick = 0
    try {
      const tournaments = selectActiveTournamentsStatement.all(batchSize) as TournamentRow[]
      for (const tournament of tournaments) {
        reconcileTournament(tournament)
      }
      const settlementDue = selectSettlementDueTournamentsStatement.all(batchSize) as TournamentRow[]
      for (const tournament of settlementDue) {
        reconcileSettlementDueTournament(tournament)
      }
      lastSuccessAt = utcNow()
      if (!settlementPendingLastTick) {
        lastError = null
      }
    } catch (error) {
      lastError = sanitizeError(error)
      logError('[tournament-coordinator] tick failed', error)
    } finally {
      inFlight = false
    }
  }

  // Открива отбора, който вече е спечелил своя предходен мач и в
  // непосредствения bracket следващ кръг чака точно победителя от
  // подадения feeder мач (generic за round_of_16→quarterfinal,
  // quarterfinal→semifinal, semifinal→final — без hardcoded round label
  // или bracket размер). Downstream match row-ът НЕ съществува все още,
  // докато и двата sibling мача не завършат (виж ensureNextRound по-горе),
  // затова pairing-ът се извежда directно от round_index bracket слота:
  // round_index 1&2 се сдвояват в следващия кръг, 3&4 и т.н.
  function resolveWaitingTeamIdForFeeder(match: MatchRow): TournamentTeamId | null {
    if (match.round_type === 'final') return null
    const teamCapacity = match.tournament_player_capacity / 2
    const ladder = getTournamentRoundLadder(teamCapacity)
    const ladderPosition = ladder.indexOf(match.round_type as TournamentRoundType)
    if (ladderPosition === -1 || ladderPosition === ladder.length - 1) return null

    const siblingRoundIndex = match.round_index % 2 === 1 ? match.round_index + 1 : match.round_index - 1
    const sibling = selectMatchByRoundPositionStatement.get(
      match.tournament_id,
      match.round_type,
      siblingRoundIndex,
    ) as MatchRow | undefined
    if (sibling === undefined) return null
    if (sibling.status !== 'completed' || sibling.winner_team_id === null) return null
    return sibling.winner_team_id
  }

  // Live feeder progress (§2 в task spec-а) — извиква се от произволен room
  // state commit hook на сървъра (виж коментара при notifyFeederScoreProgress
  // в TournamentCoordinator интерфейса по-горе). No-op fast paths за
  // нетурнирни стаи, все още неexistиращ mach row, приключен мач (final
  // completion push-ът вече покрива този случай, виж onTournamentRoomCompleted)
  // и — най-важно — когато score-ът не се е променил спрямо последния push,
  // за да НЕ праща update при всяка карта (само authoritative смяна на
  // score.match, което на практика значи "завършено раздаване").
  //
  // Аудиторията НЕ е вече цялото confirmed турнирно население — само
  // confirmed членовете на отбора, който вече е спечелил предходния си мач
  // и в непосредствения bracket следващ кръг чака точно победителя от този
  // feeder (виж resolveWaitingTeamIdForFeeder). Ако другият feeder на
  // същия downstream слот още не е завършил, няма кой да чака — тихо
  // излизаме без push (safe diagnostic no-op, не хвърля грешка, за да не
  // прекъсне game commit-а).
  function notifyFeederScoreProgress(room: ServerRoom): void {
    if (!isTournamentRoom(room) || !isRealGameStarted(room)) return
    const authState = room.game.authoritativeState as ServerAuthoritativeGameState
    if (authState.matchEnded !== null) return
    const scoreTeamA = authState.score.match.teamA
    const scoreTeamB = authState.score.match.teamB
    const signature = `${scoreTeamA}:${scoreTeamB}`
    if (lastNotifiedFeederScoreByMatchId.get(room.id) === signature) return

    const match = selectMatchByRoomStatement.get(room.id) as MatchRow | undefined
    if (match === undefined || match.status === 'completed') return

    lastNotifiedFeederScoreByMatchId.set(room.id, signature)

    const waitingTeamId = resolveWaitingTeamIdForFeeder(match)
    if (waitingTeamId === null) return
    const profileIds = Array.from(new Set(getTeamEntries(match.tournament_id, waitingTeamId).map((entry) => entry.profile_id)))
    if (profileIds.length === 0) return
    deps.notifyFeederScoreProgress(profileIds, {
      tournamentId: match.tournament_id,
      matchId: match.match_id,
      teamAId: match.team_a_id,
      teamBId: match.team_b_id,
      scoreTeamA,
      scoreTeamB,
      status: 'in_progress',
    })
  }

  function onTournamentRoomCompleted(room: ServerRoom): void {
    if (!isTournamentRoom(room)) return
    lastNotifiedFeederScoreByMatchId.delete(room.id)
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
    const finalScoreTeamA = authState.matchEnded.finalScore.teamA
    const finalScoreTeamB = authState.matchEnded.finalScore.teamB

    const updateResult = completeMatchStatement.run(
      resultKind,
      winnerTeamId,
      finalScoreTeamA,
      finalScoreTeamB,
      match.match_id,
      winnerTeamId,
    )
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
    closeCompletedTournamentRoom(completed, room)
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
    pendingRoom = seatParticipantInRoom(removeParticipantFromRoom(pendingRoom, assignment.seat), assignment.seat, human)
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
    notifyFeederScoreProgress,
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
        settlementAttemptsLastTick,
        tournamentsSettledLastTick,
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
