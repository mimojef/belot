import { applyServerAntiBadLuckToDeck } from './antiBadLuck/applyServerAntiBadLuckToDeck.js'
import { dealServerCardsInPackets } from './dealServerCardsInPackets.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function dealServerFirstThreePhase(
  state: ServerAuthoritativeGameState,
  nextRandom: () => number = Math.random,
): ServerAuthoritativeGameState {
  const firstDealSeat = state.round.firstDealSeat

  if (!firstDealSeat) {
    return state
  }

  // Anti Bad Luck пренарежда deck-а (само при rescue) преди първото раздаване;
  // deal-next-2 / deal-last-3 продължават от същото тесте без промяна.
  const antiBadLuckResult = applyServerAntiBadLuckToDeck(
    state.deck,
    firstDealSeat,
    state.antiBadLuck,
    nextRandom,
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
