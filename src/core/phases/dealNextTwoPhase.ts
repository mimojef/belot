import { dealCardsInPackets } from '../rules/dealCardsInPackets'
import type { GameState } from '../state/gameTypes'

export function dealNextTwoPhase(state: GameState): GameState {
  const firstDealSeat = state.round.firstDealSeat

  if (!firstDealSeat) {
    return state
  }

  const result = dealCardsInPackets(state.deck, state.hands, firstDealSeat, 2, 1)

  return {
    ...state,
    phase: 'deal-next-2',
    hands: result.hands,
    deck: result.remainingDeck,
  }
}