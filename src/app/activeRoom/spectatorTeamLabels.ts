// Етикети на двата отбора за Belot ЗРИТЕЛ (controlledSeat === null).
//
// Обикновена маса: фиксирано "ОТБОР А" (seats bottom/top = authoritative
// teamA) / "ОТБОР Б" (right/left = teamB) — непроменено поведение.
//
// Турнирна маса, гледана от "Турнирни срещи": реалните букви от турнирната
// схема ("ОТБОР A" / "ОТБОР H"). Съответствието е authoritative: coordinator-ът
// сяда tournament_matches.team_a_id на teamA седалките (bottom/top) и
// team_b_id на teamB (виж getSeatAssignments в tournamentCoordinator.ts), а
// score.match.teamA/teamB и победителят следват същия mapping.
//
// Lobby-то запомня буквите за конкретна стая при "Гледай"; activeRoom
// контролерът ги активира само докато е spectator на СЪЩАТА турнирна стая.

export type SpectatorTeamLabels = { teamA: string; teamB: string }

export const DEFAULT_SPECTATOR_TEAM_LABELS: SpectatorTeamLabels = { teamA: 'ОТБОР А', teamB: 'ОТБОР Б' }

let rememberedTournamentLabels: { roomId: string; labels: SpectatorTeamLabels } | null = null
let activeLabels: SpectatorTeamLabels = DEFAULT_SPECTATOR_TEAM_LABELS

export function rememberTournamentSpectatorTeamLabels(roomId: string, teamALetter: string, teamBLetter: string): void {
  rememberedTournamentLabels = { roomId, labels: { teamA: `ОТБОР ${teamALetter}`, teamB: `ОТБОР ${teamBLetter}` } }
}

export function forgetTournamentSpectatorTeamLabels(): void {
  rememberedTournamentLabels = null
}

/** Вика се от activeRoom контролера при всеки spectator snapshot/вход/изход. */
export function syncActiveSpectatorTeamLabels(input: { roomId: string; isTournamentMatchOrigin: boolean } | null): void {
  activeLabels =
    input !== null &&
    input.isTournamentMatchOrigin &&
    rememberedTournamentLabels !== null &&
    rememberedTournamentLabels.roomId === input.roomId
      ? rememberedTournamentLabels.labels
      : DEFAULT_SPECTATOR_TEAM_LABELS
}

export function getActiveSpectatorTeamLabels(): SpectatorTeamLabels {
  return activeLabels
}
