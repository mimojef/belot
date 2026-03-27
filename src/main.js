import './style.css'
import { players } from './data/players.js'
import { renderTableLayout } from './ui/tableLayout.js'
import { createGameEngine } from './core/gameEngine.js'
import { createCuttingFlow } from './app/cuttingFlow.js'
import { createBiddingFlow } from './app/biddingFlow.js'
import { createGameActions } from './app/gameActions.js'
import { getAugmentedState } from './app/getAugmentedState.js'

const game = createGameEngine()

let cuttingFlow = null
let biddingFlow = null
let gameActions = null
let lastThreeDealTimer = null
let lastThreeDealStarted = false

function isUiAnimationLocked(rawState = {}) {
  const isCutAnimationRunning = Boolean(window.__belotCutAnimationRunning)
  const isLastThreeAnimationRunning = Boolean(window.__belotLastThreeAnimationRunning)

  const isCuttingPhase = rawState.phase === 'cutting'
  const isLastThreeDealPhase =
    rawState.phase === 'dealing' && rawState.dealStep === 'last-3' && !rawState.secondRoundDealt

  if (isCutAnimationRunning && isCuttingPhase) {
    return true
  }

  if (isLastThreeAnimationRunning && isLastThreeDealPhase) {
    return true
  }

  return false
}

function clearLastThreeDealTimer() {
  if (lastThreeDealTimer) {
    clearTimeout(lastThreeDealTimer)
    lastThreeDealTimer = null
  }
}

function maybeRunLastThreeDealFlow(rawState) {
  const isLastThreeDealPhase =
    rawState.phase === 'dealing' && rawState.dealStep === 'last-3' && !rawState.secondRoundDealt

  if (!isLastThreeDealPhase) {
    clearLastThreeDealTimer()
    lastThreeDealStarted = false
    return
  }

  if (lastThreeDealStarted || window.__belotLastThreeAnimationRunning) {
    return
  }

  lastThreeDealStarted = true

  lastThreeDealTimer = setTimeout(() => {
    lastThreeDealTimer = null

    if (window.__belotLastThreeAnimationRunning) {
      return
    }

    game.confirmLastThreeDeal()
    renderGame()
  }, 1400)
}

function renderGame() {
  const rawState = game.getState()

  if (isUiAnimationLocked(rawState)) {
    cuttingFlow.updateCuttingTimerDom()
    biddingFlow.updateBiddingTimerDom()
    return
  }

  if (rawState.phase === 'cutting' && rawState.awaitingCut) {
    cuttingFlow.maybeRunCuttingFlow(rawState)
  } else {
    cuttingFlow.clearCuttingTimers()
  }

  if (rawState.phase === 'bidding') {
    biddingFlow.maybeRunBiddingFlow(rawState)
  } else {
    biddingFlow.clearBiddingTimers()
  }

  maybeRunLastThreeDealFlow(rawState)

  const state = getAugmentedState({ game, cuttingFlow, biddingFlow })

  document.querySelector('#app').innerHTML = renderTableLayout(
    players,
    game.getStatusText(),
    state.hands,
    state
  )

  cuttingFlow.updateCuttingTimerDom()
  biddingFlow.updateBiddingTimerDom()
  cuttingFlow.maybeRunBotCutFlow()
}

cuttingFlow = createCuttingFlow({ game, renderGame })
biddingFlow = createBiddingFlow({ game, renderGame })
gameActions = createGameActions({ game, renderGame, cuttingFlow, biddingFlow })

game.startNewGame()
renderGame()

window.addEventListener('beforeunload', () => {
  clearLastThreeDealTimer()
  gameActions.cleanupBeforeUnload()
})

window.game = game
window.renderGame = renderGame
window.passBidAndRender = gameActions.passBidAndRender
window.bidSuitAndRender = gameActions.bidSuitAndRender
window.bidAllTrumpsAndRender = gameActions.bidAllTrumpsAndRender
window.bidNoTrumpsAndRender = gameActions.bidNoTrumpsAndRender
window.doubleBidAndRender = gameActions.doubleBidAndRender
window.redoubleBidAndRender = gameActions.redoubleBidAndRender
window.playCardAndRender = gameActions.playCardAndRender
window.cutDeckAndDealAndRender = gameActions.cutDeckAndDealAndRender
window.confirmCutAndRender = gameActions.confirmCutAndRender
window.startNextRoundAndRender = gameActions.startNextRoundAndRender
window.startNewGameAndRender = gameActions.startNewGameAndRender