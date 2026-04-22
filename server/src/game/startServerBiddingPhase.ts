import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import {
  clearServerTimerState,
  createServerBiddingTimerState,
} from './serverTimerStateHelpers.js'

export function startServerBiddingPhase(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  const firstBidderSeat = state.round.firstBidderSeat

  if (!firstBidderSeat) {
    return {
      ...state,
      timer: clearServerTimerState(),
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
    timer: createServerBiddingTimerState(state, firstBidderSeat),
  }
}