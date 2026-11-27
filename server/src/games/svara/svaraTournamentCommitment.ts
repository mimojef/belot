/**
 * „Свара“ — турнирното участие, което блокира влизане в маса.
 *
 * Блокира само вече започнал турнир (starting / полуфинал / финал). Записване
 * в предстоящ турнир ('open') НЕ блокира: до старта профилът не играе нищо, а
 * ако турнирът започне по време на мач на „Свара“, важи съществуващата логика
 * за неявяване (мачът на „Свара“ не се прекъсва).
 *
 * getActiveTournamentIdForProfile връща първо вече започнал турнир и едва
 * след това 'open' регистрация (ORDER BY в tournamentCoordinator), така че
 * 'open' тук значи „няма започнал турнир“. Неизвестен статус → блокира
 * (fail closed, както при липсващ координатор).
 */
export function hasStartedTournamentCommitment(
  profileId: string,
  deps: {
    getActiveTournamentIdForProfile: (profileId: string) => string | null
    getTournamentStatus: (tournamentId: string) => string | null
  },
): boolean {
  const tournamentId = deps.getActiveTournamentIdForProfile(profileId)
  if (tournamentId === null) return false
  return deps.getTournamentStatus(tournamentId) !== 'open'
}
