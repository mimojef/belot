import type { GameState } from '../state/gameTypes'
import { createBiddingTimerState, clearTimerState } from '../timers/timerStateHelpers'

export function startBiddingPhase(state: GameState): GameState {
  const firstBidderSeat = state.round.firstBidderSeat

  if (!firstBidderSeat) {
    return {
      ...state,
      timer: clearTimerState(),
    }
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
    timer: createBiddingTimerState(state, firstBidderSeat),
  }
}