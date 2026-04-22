import { enterPhase } from './enterPhase'
import { applyBidAction } from './applyBidAction'
import { finalizeBiddingPhase } from './finalizeBiddingPhase'
import { startNextRound } from './startNextRound'
import {
  createBiddingTimerState,
  clearTimerState,
} from '../timers/timerStateHelpers'
import type { BidAction, GameState } from '../state/gameTypes'

export function submitBidAction(state: GameState, action: BidAction): GameState {
  const appliedState = applyBidAction(state, action)

  if (!appliedState.bidding.hasEnded) {
    const nextSeat = appliedState.bidding.currentSeat

    return {
      ...appliedState,
      timer: nextSeat
        ? createBiddingTimerState(appliedState, nextSeat)
        : clearTimerState(),
    }
  }

  const finalizedState = finalizeBiddingPhase({
    ...appliedState,
    timer: clearTimerState(),
  })

  if (finalizedState.phase === 'deal-last-3') {
    return enterPhase(finalizedState, 'deal-last-3')
  }

  if (finalizedState.phase === 'next-round') {
    return startNextRound(finalizedState)
  }

  return finalizedState
}