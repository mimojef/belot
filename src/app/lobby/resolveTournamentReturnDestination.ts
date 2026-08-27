import type { TournamentDetailSnapshot, TournamentMatchAssignmentSnapshot } from '../network/createGameServerClient.js'

// КЛЮЧОВО РАЗГРАНИЧЕНИЕ (§"КРИТИЧНО РАЗГРАНИЧЕНИЕ" в допълнението):
// "къде е участникът в турнира" (myActiveMatch/myInterRoundWaiting) и "дали
// изобщо е бил bot-replaced" са ДВЕ РАЗЛИЧНИ неща. Нормален participant,
// който лично е играл semifinal-а си, също се вижда в STATE A/STATE B —
// active tournament participation САМА ПО СЕБЕ СИ никога не е доказателство
// за force-return. Затова тези са отделни функции, не един combined check:
//
//   forceReturnRequired = detail.viewerHasUnresolvedBotReplacement
//     (authoritative, computed server-side от tournament_match_no_show_replacements
//      — виж hasUnresolvedBotReplacement в tournamentCoordinator.ts; TRUE само
//      ако СЪЩЕСТВУВА replacement ред за viewer-а в турнира със status
//      'active'/'takeover_pending' — създава се ЕДИНСТВЕНО при реален
//      no-show bot-fill, никога преждевременно; overwrite-ва се на
//      'completed' ЕДИНСТВЕНО при успешен tryTakeoverNoShowBot reclaim, така
//      че survive-ва bot-win -> STATE A -> STATE B -> следващ match
//      непроменено, докато не се reclaim-не или team-ът не отпадне)
//
//   destination = resolveTournamentReturnDestination(detail)
//     (КЪДЕ да route-не бутонът — независимо изчисление, вика се само АКО
//      forceReturnRequired е TRUE)
export type TournamentReturnDestination =
  | { kind: 'attendance' | 'countdown' | 'gameplay'; assignment: TournamentMatchAssignmentSnapshot }
  | { kind: 'state-a' | 'state-b'; tournamentId: string }
  | null

export function isTournamentForceReturnRequired(detail: TournamentDetailSnapshot): boolean {
  return detail.viewerHasUnresolvedBotReplacement === true
}

export function resolveTournamentReturnDestination(detail: TournamentDetailSnapshot): TournamentReturnDestination {
  const assignment = detail.myActiveMatch
  if (assignment !== null) {
    if (assignment.matchStatus === 'awaiting_players') return { kind: 'attendance', assignment }
    if (assignment.matchStatus === 'countdown') return { kind: 'countdown', assignment }
    return { kind: 'gameplay', assignment }
  }
  const waiting = detail.myInterRoundWaiting
  if (waiting !== null) {
    // nextMatchId === null: sibling feeder match still in progress (STATE A —
    // "Изчаква се другият финалист"/sibling table). Once the sibling
    // completes and the next round room is created, nextMatchId becomes
    // non-null (STATE B — opponent known, round-transition attendance).
    return waiting.nextMatchId === null
      ? { kind: 'state-a', tournamentId: detail.tournamentId }
      : { kind: 'state-b', tournamentId: detail.tournamentId }
  }
  return null
}
