import { createDeck, shuffleDeck } from './deck.js'
import { createInitialBiddingState } from './bidding.js'
import {
  normalizePlayerIndex,
  getRandomPlayerIndex,
  getPlayerIdByIndex,
  getPreviousPlayerId,
  getPlayerIndexById,
} from './playerOrder.js'

export function setCurrentTurn(state, playerId) {
  state.currentTurn = playerId ?? null
  state.currentPlayerIndex = playerId ? getPlayerIndexById(playerId) : null
}

export function resetRoundState(state) {
  state.status = 'idle'
  state.phase = 'setup'

  state.currentPlayerIndex = null
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

  state.deck = []
  state.cutIndex = null
  state.selectedCutIndex = null
  state.isCutSelectionLocked = false
  state.isDeckShuffled = false
  state.isDeckSpreadForCut = false
  state.isDeckCut = false
  state.awaitingCut = true
  state.isDeckCollecting = false
  state.isDeckCollected = false
  state.dealStep = null
  state.dealingPacketSize = 0
  state.dealingTargetPlayer = null
  state.dealingAnimationQueue = []
  state.lastDealBatchComplete = false

  state.hands = {
    bottom: [],
    right: [],
    top: [],
    left: [],
  }

  state.firstRoundDealt = false
  state.secondRoundDealt = false

  state.currentTrick = []
  state.completedTricks = []
  state.trickLeaderIndex = null
  state.lastTrickWinnerIndex = null
  state.cardsPlayedCount = 0
  state.roundWinnerTeam = null

  state.announcements = {
    belotDeclaredBy: [],
    declarations: [],
  }

  state.trick = []

  state.trickWins = {
    teamA: 0,
    teamB: 0,
  }

  state.bidding = createInitialBiddingState('bottom')
}

export function prepareRoundForCut(state, { advanceDealer = false, pickRandomDealer = false } = {}) {
  if (pickRandomDealer || state.dealerIndex === null || state.dealerIndex === undefined) {
    const randomDealerIndex = getRandomPlayerIndex()
    state.dealerIndex = randomDealerIndex
    state.initialDealerIndex = randomDealerIndex
    state.randomDealerChosen = true
  } else if (advanceDealer) {
    state.dealerIndex = normalizePlayerIndex(state.dealerIndex + 1)
  }

  resetRoundState(state)

  state.status = 'running'
  state.phase = 'cutting'

  const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
  const cuttingPlayer = getPreviousPlayerId(dealerPlayer)

  state.cuttingPlayer = cuttingPlayer
  setCurrentTurn(state, cuttingPlayer)

  const freshDeck = createDeck()
  const shuffledDeck = shuffleDeck(freshDeck)

  state.deck = shuffledDeck
  state.isDeckShuffled = true
  state.isDeckSpreadForCut = true
  state.isDeckCut = false
  state.awaitingCut = true

  return state
}