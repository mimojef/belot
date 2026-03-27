import { createBaseBiddingState, refreshAllowedBids } from './biddingStateHelpers.js'
import { getBidOrder } from './biddingTurn.js'

export function createInitialBiddingState(startPlayer = 'bottom') {
  const biddingState = createBaseBiddingState(startPlayer)

  biddingState.order = getBidOrder(startPlayer)

  return refreshAllowedBids(biddingState)
}