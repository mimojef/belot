import type { ServerRoom } from '../core/serverTypes.js'
import type {
  TournamentEntryRecord,
  TournamentMatchRecord,
  TournamentRecord,
  TournamentStatus,
} from './tournamentTypes.js'

export type TournamentMatchSpectatorFacts = {
  matchInProgress: boolean
  profileAssignedToMatch: boolean
  profileHasActiveTournamentParticipation: boolean
}

const TOURNAMENT_RUNNING_STATUSES: ReadonlySet<TournamentStatus> = new Set<TournamentStatus>([
  'starting',
  'semifinal_in_progress',
  'final_in_progress',
])

export function isTournamentRunningStatus(status: TournamentStatus): boolean {
  return TOURNAMENT_RUNNING_STATUSES.has(status)
}

/**
 * "Турнирни срещи" — pure resolve на persisted фактите, нужни на
 * evaluateBelotSpectatorWatchEligibility за турнирна стая. Връзката среща <->
 * маса е ЕДИНСТВЕНО tournament_matches.room_id (+ room.config.tournamentMatchId
 * като cross-check) — маса, която не е точно текущата 'in_progress' маса на
 * срещата, никога не е гледаема. null = фактите не могат да бъдат установени
 * (fail-closed при caller-а).
 */
export function resolveTournamentMatchSpectatorFacts(input: {
  room: ServerRoom
  profileId: string
  tournament: TournamentRecord | null
  matches: readonly TournamentMatchRecord[]
  entries: readonly TournamentEntryRecord[]
  // Статус на друг турнир, в който профилът е активен участник (ако има).
  otherActiveTournamentStatus: TournamentStatus | null
}): TournamentMatchSpectatorFacts | null {
  const { room, profileId, tournament } = input
  const tournamentId = room.config.tournamentId ?? null
  const matchId = room.config.tournamentMatchId ?? null
  if (tournamentId === null || matchId === null || tournament === null || tournament.tournamentId !== tournamentId) {
    return null
  }
  const match = input.matches.find((item) => item.matchId === matchId && item.tournamentId === tournamentId) ?? null
  if (match === null) return null

  const profileEntries = input.entries.filter((entry) => entry.tournamentId === tournamentId && entry.profileId === profileId)
  const profileAssignedToMatch = profileEntries.some((entry) => (
    entry.teamId !== null && (entry.teamId === match.teamAId || entry.teamId === match.teamBId)
  ))
  const activeInThisTournament =
    isTournamentRunningStatus(tournament.status) &&
    profileEntries.some((entry) => entry.status === 'confirmed' || entry.status === 'finalist')
  const activeInOtherTournament =
    input.otherActiveTournamentStatus !== null && isTournamentRunningStatus(input.otherActiveTournamentStatus)

  return {
    matchInProgress: match.status === 'in_progress' && match.roomId === room.id,
    profileAssignedToMatch,
    profileHasActiveTournamentParticipation: activeInThisTournament || activeInOtherTournament,
  }
}
