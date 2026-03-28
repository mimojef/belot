import { dealCardsInPackets } from '../rules/dealCardsInPackets'
import type { GameState } from '../state/gameTypes'

export function dealFirstThreePhase(state: GameState): GameState {
  const firstDealSeat = state.round.firstDealSeat

  if (!firstDealSeat) {
    return state
  }

  const result = dealCardsInPackets(state.deck, state.hands, firstDealSeat, 3, 1)

  return {
    ...state,
    phase: 'deal-first-3',
    hands: result.hands,
    deck: result.remainingDeck,
  }
}