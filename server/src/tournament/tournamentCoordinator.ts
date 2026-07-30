import { randomUUID } from 'node:crypto'
import {
  SERVER_TEAM_A_SEATS,
  SERVER_TEAM_B_SEATS,
  type ProfileId,
  type PlayerPublicProfileSnapshot,
  type Seat,
  type ServerRoom,
} from '../core/serverTypes.js'
import { createServerRoom } from '../core/createServerRoom.js'
import { createHumanParticipant } from '../core/createHumanParticipant.js'
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
}

export type TournamentCoordinator = {
  start: () => void
  stop: () => void
  tickNow: () => void
  onTournamentRoomCompleted: (room: ServerRoom) => void
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

type FinalSeedRow = {
  match_id: string
  winner_team_id: string
  completed_at: string
}

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_BATCH_SIZE = 25

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function dbChanges(result: unknown): number {
  return typeof result === 'object' && result !== null && 'changes' in result
    ? Number((result as { changes?: unknown }).changes ?? 0)
    : 0
}

function isTournamentRoom(room: ServerRoom): boolean {
  return room.config.isTournamentMatchOrigin === true && !!room.config.tournamentMatchId
}

function getParticipantProfileId(room: ServerRoom, seat: Seat): ProfileId | null {
  const participant = room.seats[seat].participant
  if (participant?.kind !== 'human') return null
  return participant.identity.profileId ?? participant.publicProfile?.profileId ?? null
}

function getReconnectToken(room: ServerRoom, seat: Seat): string | null {
  const participant = room.seats[seat].participant
  return participant?.kind === 'human' ? participant.reconnectToken : null
}

function sortTeamEntries(entries: TeamEntryRow[]): TeamEntryRow[] {
  return [...entries].sort((a, b) => {
    const byRole = a.joined_as.localeCompare(b.joined_as)
    if (byRole !== 0) return byRole
    return a.created_at.localeCompare(b.created_at)
  })
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

  const selectActiveTournamentsStatement = database.prepare(`
    SELECT tournament_id, name, status
    FROM tournaments
    WHERE status IN ('starting', 'semifinal_in_progress', 'final_in_progress')
    ORDER BY started_at ASC, created_at ASC
    LIMIT ?;
  `)

  const selectRunnableMatchesStatement = database.prepare(`
    SELECT
      tm.match_id, tm.tournament_id, tm.round_id, tm.room_id, tm.team_a_id, tm.team_b_id,
      tm.status, tm.winner_team_id, tm.result_kind, tm.completed_at,
      t.name as tournament_name, t.status as tournament_status,
      tr.round_type, tr.round_index
    FROM tournament_matches tm
    JOIN tournaments t ON t.tournament_id = tm.tournament_id
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
      AND tm.status IN ('awaiting_players', 'countdown', 'in_progress')
    ORDER BY tr.round_type ASC, tr.round_index ASC, tm.created_at ASC;
  `)

  const selectMatchByRoomStatement = database.prepare(`
    SELECT
      tm.match_id, tm.tournament_id, tm.round_id, tm.room_id, tm.team_a_id, tm.team_b_id,
      tm.status, tm.winner_team_id, tm.result_kind, tm.completed_at,
      t.name as tournament_name, t.status as tournament_status,
      tr.round_type, tr.round_index
    FROM tournament_matches tm
    JOIN tournaments t ON t.tournament_id = tm.tournament_id
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.room_id = ?
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
    SET room_id = ?, status = 'in_progress', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
    WHERE match_id = ?
      AND room_id IS NULL
      AND status IN ('awaiting_players', 'countdown', 'in_progress');
  `)

  const markMatchInProgressStatement = database.prepare(`
    UPDATE tournament_matches
    SET status = 'in_progress', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
    WHERE match_id = ?
      AND room_id = ?
      AND status IN ('awaiting_players', 'countdown');
  `)

  const updateTournamentStatusStatement = database.prepare(`
    UPDATE tournaments
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND status = ?;
  `)

  const completeMatchStatement = database.prepare(`
    UPDATE tournament_matches
    SET status = 'completed',
        result_kind = 'played',
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
      AND tm.result_kind = 'played'
      AND tm.winner_team_id IS NOT NULL
    ORDER BY tr.round_index ASC, tm.completed_at ASC;
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
    SELECT
      tm.match_id, tm.tournament_id, tm.round_id, tm.room_id, tm.team_a_id, tm.team_b_id,
      tm.status, tm.winner_team_id, tm.result_kind, tm.completed_at,
      t.name as tournament_name, t.status as tournament_status,
      tr.round_type, tr.round_index
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

  function buildRoom(match: MatchRow, roomId: string): ServerRoom | null {
    const teamAEntries = getTeamEntries(match.tournament_id, match.team_a_id)
    const teamBEntries = getTeamEntries(match.tournament_id, match.team_b_id)
    if (teamAEntries.length !== 2 || teamBEntries.length !== 2) {
      throw new Error(
        `Tournament match has invalid team sizes match=${match.match_id} teamA=${teamAEntries.length} teamB=${teamBEntries.length}`,
      )
    }

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

    const seatPlans: Array<{ seat: Seat; entry: TeamEntryRow }> = [
      { seat: SERVER_TEAM_A_SEATS[0]!, entry: teamAEntries[0]! },
      { seat: SERVER_TEAM_A_SEATS[1]!, entry: teamAEntries[1]! },
      { seat: SERVER_TEAM_B_SEATS[0]!, entry: teamBEntries[0]! },
      { seat: SERVER_TEAM_B_SEATS[1]!, entry: teamBEntries[1]! },
    ]

    for (const plan of seatPlans) {
      const publicProfile = deps.getPublicProfile(plan.entry.profile_id)
      if (publicProfile === null) {
        throw new Error(`Tournament participant profile missing profile=${plan.entry.profile_id}`)
      }
      room = seatParticipantInRoom(
        room,
        plan.seat,
        createHumanParticipant({
          connectionId: null,
          identity: {
            profileId: plan.entry.profile_id,
            displayName: publicProfile.displayName,
            avatarUrl: publicProfile.avatarUrl,
            level: publicProfile.level,
            rankTitle: publicProfile.rankTitle,
            skillRating: publicProfile.skillRating ?? null,
            gender: publicProfile.gender ?? null,
          },
          publicProfile,
        }),
      )
    }

    return initializeRoomAuthoritativeGameState(room)
  }

  function createAssignments(match: MatchRow, room: ServerRoom): TournamentMatchAssignment[] {
    const assignments: TournamentMatchAssignment[] = []
    const plans: Array<{
      teamId: TournamentTeamId
      opponentTeamId: TournamentTeamId
      seats: Seat[]
    }> = [
      { teamId: match.team_a_id, opponentTeamId: match.team_b_id, seats: SERVER_TEAM_A_SEATS },
      { teamId: match.team_b_id, opponentTeamId: match.team_a_id, seats: SERVER_TEAM_B_SEATS },
    ]

    for (const plan of plans) {
      const [firstSeat, secondSeat] = plan.seats
      if (!firstSeat || !secondSeat) continue
      const firstProfileId = getParticipantProfileId(room, firstSeat)
      const secondProfileId = getParticipantProfileId(room, secondSeat)
      if (firstProfileId === null || secondProfileId === null) continue

      assignments.push({
        tournamentId: match.tournament_id,
        tournamentName: match.tournament_name,
        matchId: match.match_id,
        roomId: room.id,
        roundType: match.round_type as TournamentRoundType,
        seat: firstSeat,
        teamId: plan.teamId,
        partnerProfileId: secondProfileId,
        opponentTeamId: plan.opponentTeamId,
        reconnectToken: getReconnectToken(room, firstSeat),
      })
      assignments.push({
        tournamentId: match.tournament_id,
        tournamentName: match.tournament_name,
        matchId: match.match_id,
        roomId: room.id,
        roundType: match.round_type as TournamentRoundType,
        seat: secondSeat,
        teamId: plan.teamId,
        partnerProfileId: firstProfileId,
        opponentTeamId: plan.opponentTeamId,
        reconnectToken: getReconnectToken(room, secondSeat),
      })
    }

    return assignments
  }

  function notifyAssignments(match: MatchRow, room: ServerRoom): void {
    for (const assignment of createAssignments(match, room)) {
      const profileId = getParticipantProfileId(room, assignment.seat)
      if (profileId !== null) {
        deps.notifyAssignment(profileId, assignment)
      }
    }
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
        match.status = 'in_progress'
        createdByThisTick = true
      } else {
        const refreshed = selectFinalMatchStatement.get(match.tournament_id) as MatchRow | undefined
        const current = (refreshed?.match_id === match.match_id
          ? refreshed
          : (selectRunnableMatchesStatement.all(match.tournament_id) as MatchRow[])
              .find((row) => row.match_id === match.match_id)) ?? null
        if (current === null || current.room_id === null) {
          throw new Error(`Could not claim tournament match room match=${match.match_id}`)
        }
        roomId = current.room_id
        match.room_id = roomId
      }
    } else {
      markMatchInProgressStatement.run(match.match_id, roomId)
    }

    const existingRoom = deps.getRoom(roomId)
    if (existingRoom !== null) {
      const ensureResult = deps.ensureRoomRuntime(existingRoom)
      if (!ensureResult.ok) {
        throw new Error(`No runtime capacity for tournament room=${roomId}: ${ensureResult.reason}`)
      }
      notifyAssignments(match, existingRoom)
      return 'existing'
    }

    const room = buildRoom(match, roomId)
    if (room === null) {
      throw new Error(`Could not build tournament room match=${match.match_id}`)
    }
    const ensureResult = deps.ensureRoomRuntime(room)
    if (!ensureResult.ok) {
      throw new Error(`No runtime capacity for tournament room=${room.id}: ${ensureResult.reason}`)
    }
    deps.commitRoom(room)
    notifyAssignments(match, room)
    appendEvent(match.tournament_id, createdByThisTick ? 'tournament_match_room_created' : 'tournament_match_room_recovered', {
      matchId: match.match_id,
      roomId: room.id,
      roundType: match.round_type,
    })
    return createdByThisTick ? 'created' : 'recovered'
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

  function reconcileTournament(tournament: TournamentRow): void {
    const matches = selectRunnableMatchesStatement.all(tournament.tournament_id) as MatchRow[]
    for (const match of matches) {
      const result = ensureMatchRoom(match)
      if (result === 'created') createdRoomsLastTick += 1
      if (result === 'recovered') recoveredRoomsLastTick += 1
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
    lastTickAt = new Date().toISOString()
    processedLastTick = 0
    createdRoomsLastTick = 0
    recoveredRoomsLastTick = 0
    try {
      const tournaments = selectActiveTournamentsStatement.all(batchSize) as TournamentRow[]
      for (const tournament of tournaments) {
        reconcileTournament(tournament)
      }
      lastSuccessAt = new Date().toISOString()
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

    const updateResult = completeMatchStatement.run(winnerTeamId, match.match_id, winnerTeamId)
    if (dbChanges(updateResult) > 0) {
      appendEvent(match.tournament_id, 'tournament_match_completed', {
        matchId: match.match_id,
        roomId: room.id,
        roundType: match.round_type,
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

    if (match.round_type === 'semifinal') {
      const final = ensureFinalAfterSemifinals(match.tournament_id)
      if (final !== null) ensureMatchRoom(final)
      return
    }

    if (match.round_type === 'final') {
      const runnerUpTeamId = winnerTeamId === match.team_a_id ? match.team_b_id : match.team_a_id
      updateChampionTeamStatement.run(match.tournament_id, winnerTeamId)
      updateRunnerUpTeamStatement.run(match.tournament_id, runnerUpTeamId)
      updateChampionEntriesStatement.run(match.tournament_id, winnerTeamId)
      appendEvent(match.tournament_id, 'tournament_final_completed', {
        matchId: match.match_id,
        roomId: room.id,
        winnerTeamId,
        runnerUpTeamId,
      })
    }
  }

  function getAssignmentForProfile(profileId: ProfileId): TournamentMatchAssignment | null {
    for (const tournament of selectActiveTournamentsStatement.all(batchSize) as TournamentRow[]) {
      const matches = selectRunnableMatchesStatement.all(tournament.tournament_id) as MatchRow[]
      for (const match of matches) {
        if (match.room_id === null) continue
        const room = deps.getRoom(match.room_id)
        if (room === null) continue
        const assignment = createAssignments(match, room).find((item) => {
          return getParticipantProfileId(room, item.seat) === profileId
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
