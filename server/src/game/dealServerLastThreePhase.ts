import { dealServerCardsInPackets } from './dealServerCardsInPackets.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function dealServerLastThreePhase(
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
    3,
    1,
  )

  return {
    ...state,
    phase: 'deal-last-3',
    hands: result.hands,
    deck: result.remainingDeck,
  }
}