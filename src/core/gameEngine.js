import { createInitialGameState } from './gameState.js'
import { createDeck, shuffleDeck, cutDeck as cutDeckCards } from './deck.js'
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
import { PLAYER_ORDER } from './constants.js'
import {
  isBotPlayer,
  normalizePlayerIndex,
  getRandomPlayerIndex,
  getPlayerIdByIndex,
  getPlayerIndexById,
  getNextPlayerId,
  getPreviousPlayerId,
  getNextPlayerIndex,
  getRoundWinnerTeam,
  formatPlayerLabel,
  getTeamByPlayerId,
} from './playerOrder.js'
import {
  getCardSuit,
  getCardId,
  isHandEmpty,
  cloneTrickEntries,
  findCardIndexInHand,
} from './cardUtils.js'
import { formatSuitLabel, formatContractLabel } from './contractUtils.js'
import { getWinningTrickEntry } from './trickLogic.js'
import { getPlayableCardsForPlayer } from './playRules.js'

export function createGameEngine() {
  const state = createInitialGameState()

  function setCurrentTurn(playerId) {
    state.currentTurn = playerId ?? null
    state.currentPlayerIndex = playerId ? getPlayerIndexById(playerId) : null
  }

  function resetRoundState() {
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

  function syncBiddingToRootState() {
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

  function startPlayingPhase() {
    const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
    const firstPlayer = getNextPlayerId(dealerPlayer)

    state.phase = 'playing'
    state.currentTrick = []
    state.trick = state.currentTrick
    state.trickLeaderIndex = getPlayerIndexById(firstPlayer)
    setCurrentTurn(firstPlayer)

    return state
  }

  function prepareRoundForCut({ advanceDealer = false, pickRandomDealer = false } = {}) {
    if (pickRandomDealer || state.dealerIndex === null || state.dealerIndex === undefined) {
      const randomDealerIndex = getRandomPlayerIndex()
      state.dealerIndex = randomDealerIndex
      state.initialDealerIndex = randomDealerIndex
      state.randomDealerChosen = true
    } else if (advanceDealer) {
      state.dealerIndex = normalizePlayerIndex(state.dealerIndex + 1)
    }

    resetRoundState()

    state.status = 'running'
    state.phase = 'cutting'

    const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
    const cuttingPlayer = getPreviousPlayerId(dealerPlayer)

    state.cuttingPlayer = cuttingPlayer
    setCurrentTurn(cuttingPlayer)

    const freshDeck = createDeck()
    const shuffledDeck = shuffleDeck(freshDeck)

    state.deck = shuffledDeck
    state.isDeckShuffled = true
    state.isDeckSpreadForCut = true
    state.isDeckCut = false
    state.awaitingCut = true

    return state
  }

  function performCutAndDeal(cutIndex = null) {
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
    syncBiddingToRootState()

    runBotBiddingUntilHumanOrEnd(api)

    if (state.phase === 'playing') {
      runBotPlayingUntilHumanOrEnd()
    }

    return state
  }

  function runBotCutIfNeeded() {
    if (
      state.phase === 'cutting' &&
      state.awaitingCut &&
      state.cuttingPlayer &&
      isBotPlayer(state.cuttingPlayer)
    ) {
      performCutAndDeal()
    }

    return state
  }

  function finishBiddingIfComplete(apiInstance) {
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

  function playCardInternal(playerId, cardOrId) {
    if (state.phase !== 'playing' || state.currentTurn !== playerId) {
      return state
    }

    const hand = state.hands[playerId] ?? []
    const cardIndex = findCardIndexInHand(hand, cardOrId)

    if (cardIndex === -1) {
      return state
    }

    const card = hand[cardIndex]
    const playableCards = getPlayableCardsForPlayer(state, playerId)
    const isCardPlayable = playableCards.some((playableCard) => getCardId(playableCard) === getCardId(card))

    if (!isCardPlayable) {
      return state
    }

    hand.splice(cardIndex, 1)

    const playerIndex = getPlayerIndexById(playerId)

    state.currentTrick.push({
      playerId,
      playerIndex,
      card,
    })

    state.trick = state.currentTrick
    state.cardsPlayedCount += 1

    if (state.currentTrick.length < 4) {
      const nextPlayerIndex = getNextPlayerIndex(playerIndex)
      const nextPlayerId = getPlayerIdByIndex(nextPlayerIndex)

      setCurrentTurn(nextPlayerId)
      return state
    }

    const winningEntry = getWinningTrickEntry(state, state.currentTrick)
    const winningTeam = getTeamByPlayerId(winningEntry.playerId)
    const leadSuit = state.currentTrick.length > 0 ? getCardSuit(state.currentTrick[0].card) : null

    state.completedTricks.push({
      cards: cloneTrickEntries(state.currentTrick),
      winnerId: winningEntry.playerId,
      winnerIndex: winningEntry.playerIndex,
      winningCard: winningEntry.card,
      leadPlayerIndex: state.trickLeaderIndex,
      leadSuit,
    })

    state.trickWins[winningTeam] += 1
    state.lastTrickWinnerIndex = winningEntry.playerIndex

    state.currentTrick = []
    state.trick = state.currentTrick

    const allHandsEmpty = PLAYER_ORDER.every((id) => isHandEmpty(state.hands[id]))

    if (allHandsEmpty) {
      state.phase = 'round-complete'
      state.status = 'finished'
      state.trickLeaderIndex = null
      state.currentTurn = null
      state.currentPlayerIndex = null
      state.roundWinnerTeam = getRoundWinnerTeam(state.trickWins)
      return state
    }

    state.trickLeaderIndex = winningEntry.playerIndex
    setCurrentTurn(winningEntry.playerId)

    return state
  }

  function runBotBiddingUntilHumanOrEnd(apiInstance) {
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

      if (finishBiddingIfComplete(apiInstance)) {
        break
      }
    }

    return state
  }

  function runBotPlayingUntilHumanOrEnd() {
    if (state.phase !== 'playing') {
      return state
    }

    while (state.phase === 'playing' && state.currentTurn && isBotPlayer(state.currentTurn)) {
      const playerId = state.currentTurn
      const playableCards = getPlayableCardsForPlayer(state, playerId)

      if (!playableCards.length) {
        break
      }

      playCardInternal(playerId, playableCards[0])
    }

    return state
  }

  const api = {
    getState() {
      return state
    },

    startNewGame() {
      state.scores = {
        teamA: 0,
        teamB: 0,
      }

      state.roundNumber = 1
      state.dealerIndex = null
      state.initialDealerIndex = null
      state.randomDealerChosen = false

      prepareRoundForCut({ pickRandomDealer: true })
      runBotCutIfNeeded()

      return state
    },

    restartRoundAfterAllPass() {
      state.roundNumber += 1

      prepareRoundForCut({ advanceDealer: true })
      runBotCutIfNeeded()

      return state
    },

    startNextRound() {
      if (!state.randomDealerChosen) {
        return api.startNewGame()
      }

      state.roundNumber += 1

      prepareRoundForCut({ advanceDealer: true })
      runBotCutIfNeeded()

      return state
    },

    cutDeckAndDeal(cutIndex = null) {
      if (state.phase !== 'cutting' || !state.awaitingCut || state.cuttingPlayer !== 'bottom') {
        return state
      }

      return performCutAndDeal(cutIndex)
    },

    confirmCut(cutIndex = null) {
      return api.cutDeckAndDeal(cutIndex)
    },

    passBid() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyPass(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        if (state.phase === 'playing') {
          runBotPlayingUntilHumanOrEnd()
        }

        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      if (state.phase === 'playing') {
        runBotPlayingUntilHumanOrEnd()
      }

      return state
    },

    bidSuit(suit) {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applySuitBid(state.bidding, suit)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        if (state.phase === 'playing') {
          runBotPlayingUntilHumanOrEnd()
        }

        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      if (state.phase === 'playing') {
        runBotPlayingUntilHumanOrEnd()
      }

      return state
    },

    bidAllTrumps() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyAllTrumpsBid(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        if (state.phase === 'playing') {
          runBotPlayingUntilHumanOrEnd()
        }

        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      if (state.phase === 'playing') {
        runBotPlayingUntilHumanOrEnd()
      }

      return state
    },

    bidNoTrumps() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyNoTrumpsBid(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        if (state.phase === 'playing') {
          runBotPlayingUntilHumanOrEnd()
        }

        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      if (state.phase === 'playing') {
        runBotPlayingUntilHumanOrEnd()
      }

      return state
    },

    doubleBid() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyDouble(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        if (state.phase === 'playing') {
          runBotPlayingUntilHumanOrEnd()
        }

        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      if (state.phase === 'playing') {
        runBotPlayingUntilHumanOrEnd()
      }

      return state
    },

    redoubleBid() {
      if (state.phase !== 'bidding' || state.currentTurn !== 'bottom') {
        return state
      }

      applyRedouble(state.bidding)
      syncBiddingToRootState()

      if (finishBiddingIfComplete(api)) {
        if (state.phase === 'playing') {
          runBotPlayingUntilHumanOrEnd()
        }

        return state
      }

      runBotBiddingUntilHumanOrEnd(api)

      if (state.phase === 'playing') {
        runBotPlayingUntilHumanOrEnd()
      }

      return state
    },

    dealRemainingCardsAfterBidding() {
      if (!state.firstRoundDealt || state.secondRoundDealt || !state.contract) {
        return state
      }

      const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
      const secondRoundResult = dealSecondRound(state.deck, state.hands, dealerPlayer)

      state.dealStep = 'last-3'
      state.deck = secondRoundResult.remainingDeck
      state.hands = secondRoundResult.hands
      state.secondRoundDealt = true
      state.dealStep = null

      startPlayingPhase()

      return state
    },

    getPlayableCards(playerId = 'bottom') {
      return getPlayableCardsForPlayer(state, playerId)
    },

    playCard(cardOrId) {
      if (state.phase !== 'playing' || state.currentTurn !== 'bottom') {
        return state
      }

      playCardInternal('bottom', cardOrId)
      runBotPlayingUntilHumanOrEnd()

      return state
    },

    getStatusText() {
      const dealerPlayer = state.dealerIndex !== null ? getPlayerIdByIndex(state.dealerIndex) : null
      const dealerLabel = formatPlayerLabel(dealerPlayer)
      const cutterLabel = formatPlayerLabel(state.cuttingPlayer)
      const currentLabel = formatPlayerLabel(state.currentTurn)

      const contractLabel = formatContractLabel(state.contract)
      const trumpLabel = state.trumpSuit ? formatSuitLabel(state.trumpSuit) : 'Няма'
      const leadSuit =
        state.currentTrick.length > 0 ? formatSuitLabel(getCardSuit(state.currentTrick[0].card)) : 'Няма'

      if (state.phase === 'cutting') {
        return `Нова раздача. Дилър е ${dealerLabel}. Цепи ${cutterLabel}. Картите са разбъркани и разгънати за цепене.`
      }

      if (state.phase === 'bidding') {
        return `Раздадени са първите 3+2 карти. Дилър е ${dealerLabel}, на ход за обява е ${currentLabel}.`
      }

      if (state.phase === 'playing') {
        if (state.currentTrick.length === 0) {
          return `Наддаването приключи и са раздадени последните 3 карти. Играе се на ${contractLabel}${state.trumpSuit ? ` (${trumpLabel})` : ''}. ${currentLabel} започва взятката.`
        }

        return `Играе се взятка ${state.completedTricks.length + 1}. На ход е ${currentLabel}. Водещ цвят: ${leadSuit}.`
      }

      if (state.phase === 'round-complete') {
        return `Рундът приключи. teamA има ${state.trickWins.teamA} взятки, а teamB има ${state.trickWins.teamB} взятки. Победител: ${state.roundWinnerTeam}.`
      }

      if (state.phase === 'dealing' && state.firstRoundDealt) {
        return 'Първите 3+2 карти са раздадени.'
      }

      return 'Играта е инициализирана.'
    },
  }

  return api
}