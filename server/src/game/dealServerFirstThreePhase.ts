import { applyServerAntiBadLuckToDeck } from './antiBadLuck/applyServerAntiBadLuckToDeck.js'
import { assertServerAntiBadLuckConfig, type ServerAntiBadLuckConfig } from './antiBadLuck/serverAntiBadLuckTypes.js'
import { dealServerCardsInPackets } from './dealServerCardsInPackets.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

// antiBadLuckConfig е ЗАДЪЛЖИТЕЛЕН (admin setting, подаден от runtime
// границата) — без тих fallback към default прага.
export function dealServerFirstThreePhase(
  state: ServerAuthoritativeGameState,
  antiBadLuckConfig: ServerAntiBadLuckConfig,
  nextRandom: () => number = Math.random,
): ServerAuthoritativeGameState {
  assertServerAntiBadLuckConfig(antiBadLuckConfig, 'dealServerFirstThreePhase')
  const firstDealSeat = state.round.firstDealSeat

  if (!firstDealSeat) {
    return state
  }

  // Anti Bad Luck пренарежда deck-а (само при rescue) преди първото раздаване;
  // deal-next-2 / deal-last-3 продължават от същото тесте без промяна. При
  // праг 0 deck-ът се връща непокътнат.
  const antiBadLuckResult = applyServerAntiBadLuckToDeck(
    state.deck,
    firstDealSeat,
    state.antiBadLuck,
    nextRandom,
    antiBadLuckConfig,
  )

  const result = dealServerCardsInPackets(
    antiBadLuckResult.deck,
    state.hands,
    firstDealSeat,
    3,
    1,
  )

  return {
    ...state,
    phase: 'deal-first-3',
    hands: result.hands,
    deck: result.remainingDeck,
    antiBadLuck: antiBadLuckResult.antiBadLuck,
  }
}
