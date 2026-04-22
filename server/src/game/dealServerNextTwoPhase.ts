import { dealServerCardsInPackets } from './dealServerCardsInPackets.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function dealServerNextTwoPhase(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  const firstDealSeat = state.round.firstDealSeat

  if (!firstDealSeat) {
    return state
  }

  const result = dealServerCardsInPackets(
    state.deck,
    state.hands,
    firstDealSeat,
    2,
    1,
  )

  return {
    ...state,
    phase: 'deal-next-2',
    hands: result.hands,
    deck: result.remainingDeck,
  }
}