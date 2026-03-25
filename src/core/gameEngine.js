import { createInitialGameState } from './gameState.js'
import { createDeck, shuffleDeck, cutDeck } from './deck.js'
import { dealFirstRound } from './deal.js'
import { dealSecondRound } from './dealSecondRound.js'
import {
  createInitialBiddingState,
  applyPass,
  applySuitBid,
  applyAllTrumpsBid,
  applyNoTrumpsBid,
  applyDouble,
  applyRedouble,
} from './bidding.js'

const PLAYER_ORDER = ['bottom', 'left', 'top', 'right']

function isBotPlayer(playerId) {
  return playerId !== 'bottom'
}

function normalizePlayerIndex(index) {
  return ((index % PLAYER_ORDER.length) + PLAYER_ORDER.length) % PLAYER_ORDER.length
}

function getPlayerIdByIndex(index) {
  return PLAYER_ORDER[normalizePlayerIndex(index)]
}

function getNextPlayerId(playerId) {
  const currentIndex = PLAYER_ORDER.indexOf(playerId)

  if (currentIndex === -1) {
    return PLAYER_ORDER[0]
  }

  return PLAYER_ORDER[(currentIndex + 1) % PLAYER_ORDER.length]
}

export function createGameEngine() {
  const state = createInitialGameState()

  function resetRoundState() {
    state.currentTurn = null
    state.bidStarter = null
    state.cuttingPlayer = null
    state.trumpSuit = null
    state.contract = null
    state.winningBidder = null
    state.isDoubled = false
    state.isRedoubled = false
    state.bidHistory = []
    state.passedPlayers = []
    state.firstRoundDealt = false
    state.secondRoundDealt = false
    state.trick = []
    state.hands = {
      bottom: [],
      left: [],
      top: [],
      right: [],
    }
    state.bidding = createInitialBiddingState('bottom')
  }

  function syncBiddingToRootState() {
    state.bidStarter = state.bidding.starter
    state.currentTurn = state.bidding.currentTurn
    state.bidHistory = state.bidding.history
    state.contract = state.bidding.contract
    state.trumpSuit = state.bidding.trumpSuit
    state.isDoubled = state.bidding.isDoubled
    state.isRedoubled = state.bidding.isRedoubled
    state.winningBidder = state.bidding.winningBidder
  }

  function startRound({ advanceDealer = false } = {}) {
    if (advanceDealer) {
      state.dealerIndex = normalizePlayerIndex(state.dealerIndex + 1)
    }

    resetRoundState()

    state.status = 'running'
    state.phase = 'cutting'

    const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
    const cuttingPlayer = getNextPlayerId(dealerPlayer)

    state.cuttingPlayer = cuttingPlayer
    state.currentTurn = cuttingPlayer

    const freshDeck = createDeck()
    const shuffledDeck = shuffleDeck(freshDeck)

    state.deck = shuffledDeck

    const cutResult = cutDeck(shuffledDeck)

    state.cutIndex = cutResult.cutIndex
    state.deck = cutResult.deck

    state.phase = 'dealing'

    const firstRoundResult = dealFirstRound(state.deck)

    state.deck = firstRoundResult.remainingDeck
    state.hands = firstRoundResult.hands
    state.firstRoundDealt = true
    state.secondRoundDealt = false

    state.phase = 'bidding'

    const bidStarter = getNextPlayerId(dealerPlayer)
    const biddingState = createInitialBiddingState(bidStarter)

    state.bidding = biddingState

    syncBiddingToRootState()

    return state
  }

  function finishBiddingIfComplete(api) {
    if (!state.bidding.isComplete) {
      return false
    }

    if (!state.bidding.contract) {
      api.restartRoundAfterAllPass()
      return true
    }

    api.dealRemainingCardsAfterBidding()
    return true
  }

  function runBotBiddingUntilHumanOrEnd(api) {
    if (state.phase !== 'bidding') {
      return state
    }

    while (
      state.phase === 'bidding' &&
      state.bidding.currentTurn &&
      isBotPlayer(state.bidding.currentTurn)
    ) {
      applyPass(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        break
      }
    }

    return state
  }

  const api = {
    getState() {
      return state
    },

    startNewGame() {
      state.dealerIndex = normalizePlayerIndex(state.dealerIndex ?? 0)
      return startRound({ advanceDealer: false })
    },

    restartRoundAfterAllPass() {
      return startRound({ advanceDealer: true })
    },

    passBid() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyPass(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      return state
    },

    bidSuit(suit) {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applySuitBid(state.bidding, suit)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      return state
    },

    bidAllTrumps() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyAllTrumpsBid(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      return state
    },

    bidNoTrumps() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyNoTrumpsBid(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      return state
    },

    doubleBid() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyDouble(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      return state
    },

    redoubleBid() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyRedouble(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      return state
    },

    dealRemainingCardsAfterBidding() {
      if (!state.firstRoundDealt || state.secondRoundDealt || !state.contract) {
        return state
      }

      const secondRoundResult = dealSecondRound(state.deck, state.hands)

      state.deck = secondRoundResult.remainingDeck
      state.hands = secondRoundResult.hands
      state.secondRoundDealt = true
      state.phase = 'playing'
      state.currentTurn = state.winningBidder

      return state
    },

    getStatusText() {
      if (state.phase === 'bidding') {
        return `Стъпка 4: започва наддаването след първите 5 карти. Първи на ход е ${state.currentTurn}.`
      }

      if (state.phase === 'playing' && state.secondRoundDealt) {
        return `Стъпка 5: наддаването приключи, раздадени са последните 3 карти и първи на ход е ${state.currentTurn}.`
      }

      if (state.phase === 'dealing' && state.firstRoundDealt) {
        return `Стъпка 3: раздадени са първите 3+2 карти. Остават ${state.deck.length} карти в тестето.`
      }

      if (state.phase === 'cutting') {
        return `Стъпка 2: тестето е събрано, разбъркано и е дадено за цепене на ${state.cuttingPlayer}.`
      }

      return 'Стъпка 1: играта е инициализирана'
    },
  }

  return api
}