import { createInitialGameState } from './gameState.js'
import {
  applyPass,
  applySuitBid,
  applyAllTrumpsBid,
  applyNoTrumpsBid,
  applyDouble,
  applyRedouble,
} from './bidding.js'
import { getPlayableCardsForPlayer } from './playRules.js'
import { getGameEngineStatusText } from './gameEngineStatus.js'
import { syncBiddingToRootState, finishBiddingIfComplete } from './gameEngineBidding.js'
import {
  beginLastThreeDealStep,
  finishLastThreeDealStep,
  playCardInternal,
  runBotPlayingUntilHumanOrEnd,
} from './gameEnginePlaying.js'
import { runHumanBidAction } from './gameEngineActions.js'
import { selectCutIndex, performCutAndDeal, confirmCut } from './gameEngineCutting.js'
import { runBotBiddingUntilHumanOrEnd } from './gameEngineBots.js'
import {
  startNewGameRoundFlow,
  restartRoundAfterAllPassFlow,
  startNextRoundFlow,
} from './gameEngineRoundFlow.js'

export function createGameEngine() {
  const state = createInitialGameState()

  const api = {
    getState() {
      return state
    },

    syncBiddingToRootState() {
      return syncBiddingToRootState(state)
    },

    finishBiddingIfComplete() {
      return finishBiddingIfComplete(state, api)
    },

    startNewGame() {
      return startNewGameRoundFlow(state)
    },

    restartRoundAfterAllPass() {
      return restartRoundAfterAllPassFlow(state)
    },

    startNextRound() {
      return startNextRoundFlow(state, api)
    },

    selectCut(cutIndex) {
      return selectCutIndex(state, cutIndex)
    },

    cutDeckAndDeal(cutIndex = null) {
      if (state.phase !== 'cutting' || !state.awaitingCut) {
        return state
      }

      return performCutAndDeal(state, cutIndex, {
        runBotBiddingUntilHumanOrEnd: (apiInstance) => runBotBiddingUntilHumanOrEnd(state, apiInstance),
        runBotPlayingUntilHumanOrEnd,
        api,
      })
    },

    confirmCut(cutIndex = null) {
      return confirmCut(state, cutIndex, {
        selectCutIndexFn: selectCutIndex,
        performCutAndDealFn: (innerState, resolvedCutIndex) =>
          performCutAndDeal(innerState, resolvedCutIndex, {
            runBotBiddingUntilHumanOrEnd: (apiInstance) => runBotBiddingUntilHumanOrEnd(innerState, apiInstance),
            runBotPlayingUntilHumanOrEnd,
            api,
          }),
      })
    },

    passBid() {
      return runHumanBidAction({
        state,
        api,
        action: () => applyPass(state.bidding),
        runBotBiddingUntilHumanOrEnd: (apiInstance) => runBotBiddingUntilHumanOrEnd(state, apiInstance),
        runBotPlayingUntilHumanOrEnd,
      })
    },

    bidSuit(suit) {
      return runHumanBidAction({
        state,
        api,
        action: () => applySuitBid(state.bidding, suit),
        runBotBiddingUntilHumanOrEnd: (apiInstance) => runBotBiddingUntilHumanOrEnd(state, apiInstance),
        runBotPlayingUntilHumanOrEnd,
      })
    },

    bidAllTrumps() {
      return runHumanBidAction({
        state,
        api,
        action: () => applyAllTrumpsBid(state.bidding),
        runBotBiddingUntilHumanOrEnd: (apiInstance) => runBotBiddingUntilHumanOrEnd(state, apiInstance),
        runBotPlayingUntilHumanOrEnd,
      })
    },

    bidNoTrumps() {
      return runHumanBidAction({
        state,
        api,
        action: () => applyNoTrumpsBid(state.bidding),
        runBotBiddingUntilHumanOrEnd: (apiInstance) => runBotBiddingUntilHumanOrEnd(state, apiInstance),
        runBotPlayingUntilHumanOrEnd,
      })
    },

    doubleBid() {
      return runHumanBidAction({
        state,
        api,
        action: () => applyDouble(state.bidding),
        runBotBiddingUntilHumanOrEnd: (apiInstance) => runBotBiddingUntilHumanOrEnd(state, apiInstance),
        runBotPlayingUntilHumanOrEnd,
      })
    },

    redoubleBid() {
      return runHumanBidAction({
        state,
        api,
        action: () => applyRedouble(state.bidding),
        runBotBiddingUntilHumanOrEnd: (apiInstance) => runBotBiddingUntilHumanOrEnd(state, apiInstance),
        runBotPlayingUntilHumanOrEnd,
      })
    },

    dealRemainingCardsAfterBidding() {
      return beginLastThreeDealStep(state)
    },

    confirmLastThreeDeal() {
      if (state.dealStep !== 'last-3') {
        return state
      }

      finishLastThreeDealStep(state)

      if (state.phase === 'playing') {
        runBotPlayingUntilHumanOrEnd(state)
      }

      return state
    },

    getPlayableCards(playerId = 'bottom') {
      return getPlayableCardsForPlayer(state, playerId)
    },

    playCard(cardOrId) {
      if (state.phase !== 'playing' || state.currentTurn !== 'bottom') {
        return state
      }

      playCardInternal(state, 'bottom', cardOrId)
      runBotPlayingUntilHumanOrEnd(state)

      return state
    },

    getStatusText() {
      return getGameEngineStatusText(state)
    },
  }

  return api
}