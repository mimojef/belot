import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { pickServerBotBidAction } from './pickServerBotBidAction.js'
import { rebaseServerStateToEventAt } from './rebaseServerStateToEventAt.js'
import { submitServerBidAction } from './submitServerBidAction.js'

export type AdvanceExpiredServerBiddingStateResult = {
  state: ServerAuthoritativeGameState
  advanced: boolean
  eventAt: number
}

export function advanceExpiredServerBiddingState(
  state: ServerAuthoritativeGameState,
  eventAt: number,
): AdvanceExpiredServerBiddingStateResult {
  const currentSeat = state.bidding.currentSeat

  if (!currentSeat) {
    return {
      state,
      advanced: false,
      eventAt,
    }
  }

  const action = pickServerBotBidAction(state, currentSeat)

  return {
    state: rebaseServerStateToEventAt(submitServerBidAction(state, action), eventAt),
    advanced: true,
    eventAt,
  }
}