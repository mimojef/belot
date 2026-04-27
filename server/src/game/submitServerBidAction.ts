import { enterServerPhase } from './enterServerPhase.js'
import { applyServerBidAction } from './applyServerBidAction.js'
import { finalizeServerBiddingPhase } from './finalizeServerBiddingPhase.js'
import {
  clearServerTimerState,
  createServerBiddingTimerState,
} from './serverTimerStateHelpers.js'
import type {
  ServerAuthoritativeGameState,
  ServerBidAction,
} from './serverGameTypes.js'

export function submitServerBidAction(
  state: ServerAuthoritativeGameState,
  action: ServerBidAction,
): ServerAuthoritativeGameState {
  const appliedState = applyServerBidAction(state, action)

  if (!appliedState.bidding.hasEnded) {
    const nextSeat = appliedState.bidding.currentSeat

    return {
      ...appliedState,
      timer: nextSeat
        ? createServerBiddingTimerState(appliedState, nextSeat)
        : clearServerTimerState(),
    }
  }

  const finalizedState = finalizeServerBiddingPhase({
    ...appliedState,
    timer: clearServerTimerState(),
  })

  if (finalizedState.phase === 'deal-last-3') {
    return enterServerPhase(finalizedState, 'deal-last-3')
  }

  if (finalizedState.phase === 'next-round') {
    return enterServerPhase(finalizedState, 'next-round')
  }

  return finalizedState
}