import type { GameState } from '../state/gameTypes'

export function finalizeBiddingPhase(state: GameState): GameState {
  if (state.phase !== 'bidding') {
    return state
  }

  if (!state.bidding.hasEnded) {
    return state
  }

  if (!state.bidding.winningBid) {
    return {
      ...state,
      phase: 'next-round',
    }
  }

  return {
    ...state,
    phase: 'deal-last-3',
  }
}