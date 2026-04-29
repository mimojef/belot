import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { pickServerBotBidAction } from './pickServerBotBidAction.js'
import { rebaseServerStateToEventAt } from './rebaseServerStateToEventAt.js'
import { isServerSeatControlledByBot } from './serverTimerStateHelpers.js'
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

  const stateWithBotControl = isServerSeatControlledByBot(state, currentSeat)
    ? state
    : {
        ...state,
        players: {
          ...state.players,
          [currentSeat]: {
            ...state.players[currentSeat],
            controlledByBot: true,
          },
        },
      }
  const action = pickServerBotBidAction(stateWithBotControl, currentSeat)

  return {
    state: rebaseServerStateToEventAt(submitServerBidAction(stateWithBotControl, action), eventAt),
    advanced: true,
    eventAt,
  }
}
