import { enterPhase } from './enterPhase'
import { applyBidAction } from './applyBidAction'
import { finalizeBiddingPhase } from './finalizeBiddingPhase'
import { startNextRound } from './startNextRound'
import type { BidAction, GameState } from '../state/gameTypes'

export function submitBidAction(state: GameState, action: BidAction): GameState {
  const appliedState = applyBidAction(state, action)

  if (!appliedState.bidding.hasEnded) {
    return appliedState
  }

  const finalizedState = finalizeBiddingPhase(appliedState)

  if (finalizedState.phase === 'deal-last-3') {
    return enterPhase(finalizedState, 'deal-last-3')
  }

  if (finalizedState.phase === 'next-round') {
    return startNextRound(finalizedState)
  }

  return finalizedState
}