import { cutDeck as cutDeckCards } from './deck.js'
import { dealFirstRound } from './deal.js'
import { createInitialBiddingState } from './bidding.js'
import { getPlayerIdByIndex, getNextPlayerId } from './playerOrder.js'
import { syncBiddingToRootState } from './gameEngineBidding.js'

export function selectCutIndex(state, cutIndex) {
  if (state.phase !== 'cutting' || !state.awaitingCut) {
    return state
  }

  state.selectedCutIndex = cutIndex
  state.isCutSelectionLocked = true

  return state
}

export function performCutAndDeal(state, cutIndex = null, { runBotBiddingUntilHumanOrEnd, runBotPlayingUntilHumanOrEnd, api }) {
  if (state.phase !== 'cutting' || !state.awaitingCut) {
    return state
  }

  const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
  const resolvedCutIndex = cutIndex ?? state.selectedCutIndex ?? null
  const cutResult = cutDeckCards(state.deck, resolvedCutIndex)

  state.selectedCutIndex = cutResult.cutIndex
  state.cutIndex = cutResult.cutIndex
  state.deck = cutResult.deck
  state.isCutSelectionLocked = true
  state.isDeckCut = true
  state.isDeckSpreadForCut = false
  state.awaitingCut = false

  state.phase = 'dealing'
  state.isDeckCollecting = false
  state.isDeckCollected = true
  state.dealStep = 'first-5'

  const firstRoundResult = dealFirstRound(state.deck, dealerPlayer)

  state.deck = firstRoundResult.remainingDeck
  state.hands = firstRoundResult.hands
  state.firstRoundDealt = true
  state.secondRoundDealt = false
  state.dealStep = null
  state.phase = 'bidding'

  const bidStarter = getNextPlayerId(dealerPlayer)
  const biddingState = createInitialBiddingState(bidStarter)

  state.bidding = biddingState
  syncBiddingToRootState(state)

  runBotBiddingUntilHumanOrEnd(api)

  if (state.phase === 'playing') {
    runBotPlayingUntilHumanOrEnd(state)
  }

  return state
}

export function confirmCut(state, cutIndex = null, { selectCutIndexFn, performCutAndDealFn }) {
  if (state.phase !== 'cutting' || !state.awaitingCut) {
    return state
  }

  if (cutIndex !== null && cutIndex !== undefined) {
    selectCutIndexFn(state, cutIndex)
  }

  return performCutAndDealFn(state, cutIndex ?? state.selectedCutIndex ?? null)
}