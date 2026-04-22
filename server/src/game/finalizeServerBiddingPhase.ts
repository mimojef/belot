import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function finalizeServerBiddingPhase(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
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