import { getPlayerIndexById } from './playerOrder.js'

export function syncBiddingToRootState(state) {
  state.bidStarter = state.bidding.starter
  state.currentTurn = state.bidding.currentTurn
  state.currentPlayerIndex = state.bidding.currentTurn
    ? getPlayerIndexById(state.bidding.currentTurn)
    : null
  state.bidHistory = state.bidding.history
  state.contract = state.bidding.contract
  state.trumpSuit = state.bidding.trumpSuit
  state.isDoubled = state.bidding.isDoubled
  state.isRedoubled = state.bidding.isRedoubled
  state.winningBidder = state.bidding.winningBidder
}

export function finishBiddingIfComplete(state, apiInstance) {
  if (!state.bidding.isComplete) {
    return false
  }

  if (!state.bidding.contract) {
    apiInstance.restartRoundAfterAllPass()
    return true
  }

  apiInstance.dealRemainingCardsAfterBidding()
  return true
}