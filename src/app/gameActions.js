export function createGameActions({ game, renderGame, cuttingFlow, biddingFlow }) {
  function clearRoundFlowState() {
    cuttingFlow.clearBotCutTimeout()
    cuttingFlow.clearCuttingTimers()
    biddingFlow.clearBiddingTimers()
  }

  function passBidAndRender() {
    game.passBid()
    renderGame()
  }

  function bidSuitAndRender(suit) {
    game.bidSuit(suit)
    renderGame()
  }

  function bidAllTrumpsAndRender() {
    game.bidAllTrumps()
    renderGame()
  }

  function bidNoTrumpsAndRender() {
    game.bidNoTrumps()
    renderGame()
  }

  function doubleBidAndRender() {
    game.doubleBid()
    renderGame()
  }

  function redoubleBidAndRender() {
    game.redoubleBid()
    renderGame()
  }

  function playCardAndRender(cardId) {
    game.playCard(cardId)
    renderGame()
  }

  function cutDeckAndDealAndRender(cutIndex = null) {
    game.cutDeckAndDeal(cutIndex)
    renderGame()
  }

  function confirmCutAndRender(cutIndex = null) {
    cuttingFlow.clearBotCutTimeout()
    game.confirmCut(cutIndex)
    renderGame()
  }

  function startNextRoundAndRender() {
    clearRoundFlowState()
    game.startNextRound()
    renderGame()
  }

  function startNewGameAndRender() {
    clearRoundFlowState()
    game.startNewGame()
    renderGame()
  }

  function cleanupBeforeUnload() {
    clearRoundFlowState()
  }

  return {
    passBidAndRender,
    bidSuitAndRender,
    bidAllTrumpsAndRender,
    bidNoTrumpsAndRender,
    doubleBidAndRender,
    redoubleBidAndRender,
    playCardAndRender,
    cutDeckAndDealAndRender,
    confirmCutAndRender,
    startNextRoundAndRender,
    startNewGameAndRender,
    cleanupBeforeUnload,
  }
}