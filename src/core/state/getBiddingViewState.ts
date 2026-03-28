import { getValidBidActions } from '../rules/getValidBidActions'
import type { GameState } from './gameTypes'

export type BiddingViewState =
  | null
  | {
      currentSeat: GameState['bidding']['currentSeat']
      winningBid: GameState['bidding']['winningBid']
      validActions: ReturnType<typeof getValidBidActions>
      entries: GameState['bidding']['entries']
      hasEnded: boolean
    }

export function getBiddingViewState(state: GameState): BiddingViewState {
  if (state.phase !== 'bidding') {
    return null
  }

  const currentSeat = state.bidding.currentSeat

  if (!currentSeat) {
    return {
      currentSeat: null,
      winningBid: state.bidding.winningBid,
      validActions: {
        pass: false,
        suits: {
          clubs: false,
          diamonds: false,
          hearts: false,
          spades: false,
        },
        noTrumps: false,
        allTrumps: false,
        double: false,
        redouble: false,
      },
      entries: state.bidding.entries,
      hasEnded: state.bidding.hasEnded,
    }
  }

  return {
    currentSeat,
    winningBid: state.bidding.winningBid,
    validActions: getValidBidActions(currentSeat, state.bidding.winningBid),
    entries: state.bidding.entries,
    hasEnded: state.bidding.hasEnded,
  }
}