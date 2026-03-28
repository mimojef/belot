import { createEmptyTimerState } from '../state/createRoundDefaults'
import type { GameState } from '../state/gameTypes'

export function startBiddingPhase(state: GameState): GameState {
  const firstBidderSeat = state.round.firstBidderSeat

  if (!firstBidderSeat) {
    return state
  }

  return {
    ...state,
    phase: 'bidding',
    bidding: {
      ...state.bidding,
      currentSeat: firstBidderSeat,
      hasStarted: true,
      hasEnded: false,
      consecutivePasses: 0,
    },
    timer: createEmptyTimerState(),
  }
}