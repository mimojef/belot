// A-P покрива максималния поддържан bracket размер (16 отбора). За 4/8
// отбора се ползват само първите 4/8 букви — mapping-ът е positional
// (index в t.teams), затова разширяването тук не променя нищо за
// съществуващите 4-отборни турнири.
//
// Споделено между tournament detail екрана (buildTournamentTeamLabelMap в
// renderTournamentsScreen.ts — виж подробния коментар за server-side реда
// там) и изгледа "Турнирни срещи" (renderTournamentMatchesView.ts), за да
// носи един и същ отбор една и съща буква навсякъде.
export const TOURNAMENT_TEAM_SLOT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'] as const

export function getTournamentTeamSlotLetter(index: number): string {
  return TOURNAMENT_TEAM_SLOT_LETTERS[index] ?? String(index + 1)
}
