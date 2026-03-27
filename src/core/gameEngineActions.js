export function runHumanBidAction({
  state,
  api,
  action,
  runBotBiddingUntilHumanOrEnd,
  runBotPlayingUntilHumanOrEnd,
  requiredPlayerId = 'bottom',
}) {
  if (state.phase !== 'bidding' || state.currentTurn !== requiredPlayerId) {
    return state
  }

  action()

  if (api.syncBiddingToRootState) {
    api.syncBiddingToRootState()
  }

  if (api.finishBiddingIfComplete && api.finishBiddingIfComplete()) {
    if (state.phase === 'playing') {
      runBotPlayingUntilHumanOrEnd(state)
    }

    return state
  }

  runBotBiddingUntilHumanOrEnd(api)

  if (state.phase === 'playing') {
    runBotPlayingUntilHumanOrEnd(state)
  }

  return state
}