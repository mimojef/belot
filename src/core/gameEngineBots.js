import { applyPass } from './bidding.js'
import { isBotPlayer } from './playerOrder.js'
import { syncBiddingToRootState, finishBiddingIfComplete } from './gameEngineBidding.js'

export function runBotCutIfNeeded(state) {
  return state
}

export function runBotBiddingUntilHumanOrEnd(state, apiInstance) {
  if (state.phase !== 'bidding') {
    return state
  }

  while (
    state.phase === 'bidding' &&
    state.bidding.currentTurn &&
    isBotPlayer(state.bidding.currentTurn)
  ) {
    applyPass(state.bidding)
    syncBiddingToRootState(state)

    if (finishBiddingIfComplete(state, apiInstance)) {
      break
    }
  }

  return state
}