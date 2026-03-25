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

const PLAYER_ORDER = ['bottom', 'right', 'top', 'left']

const NORMAL_RANK_POWER = {
  '7': 0,
  '8': 1,
  '9': 2,
  J: 3,
  Q: 4,
  K: 5,
  '10': 6,
  A: 7,
}

const TRUMP_RANK_POWER = {
  '7': 0,
  '8': 1,
  Q: 2,
  K: 3,
  '10': 4,
  A: 5,
  '9': 6,
  J: 7,
}

function isBotPlayer(playerId) {
  return playerId !== 'bottom'
}

function normalizePlayerIndex(index) {
  return ((index % PLAYER_ORDER.length) + PLAYER_ORDER.length) % PLAYER_ORDER.length
}

function getRandomPlayerIndex() {
  return Math.floor(Math.random() * PLAYER_ORDER.length)
}

function getPlayerIdByIndex(index) {
  return PLAYER_ORDER[normalizePlayerIndex(index)]
}

function getPlayerIndexById(playerId) {
  return PLAYER_ORDER.indexOf(playerId)
}

function getNextPlayerId(playerId) {
  const currentIndex = PLAYER_ORDER.indexOf(playerId)

  if (currentIndex === -1) {
    return PLAYER_ORDER[0]
  }

  return PLAYER_ORDER[normalizePlayerIndex(currentIndex + 1)]
}

function getPreviousPlayerId(playerId) {
  const currentIndex = PLAYER_ORDER.indexOf(playerId)

  if (currentIndex === -1) {
    return PLAYER_ORDER[PLAYER_ORDER.length - 1]
  }

  return PLAYER_ORDER[normalizePlayerIndex(currentIndex - 1)]
}

function getNextPlayerIndex(index) {
  return normalizePlayerIndex(index + 1)
}

function getTeamByPlayerId(playerId) {
  return playerId === 'bottom' || playerId === 'top' ? 'teamA' : 'teamB'
}

function getRoundWinnerTeam(trickWins) {
  if (trickWins.teamA > trickWins.teamB) {
    return 'teamA'
  }

  if (trickWins.teamB > trickWins.teamA) {
    return 'teamB'
  }

  return 'draw'
}

function normalizeCardRank(rank) {
  if (rank === null || rank === undefined) {
    return null
  }

  const value = String(rank).trim().toUpperCase()

  if (value === 'JACK') return 'J'
  if (value === 'QUEEN') return 'Q'
  if (value === 'KING') return 'K'
  if (value === 'ACE') return 'A'

  return value
}

function getCardRank(card) {
  return normalizeCardRank(card?.rank ?? card?.value ?? card?.face ?? card?.name ?? null)
}

function getCardSuit(card) {
  return card?.suit ?? null
}

function getCardId(card) {
  return card?.id ?? `${getCardSuit(card)}-${getCardRank(card)}`
}

function formatSuitLabel(suit) {
  if (suit === 'clubs') return 'Спатия'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'hearts') return 'Купа'
  if (suit === 'spades') return 'Пика'
  return suit ?? 'Няма'
}

function formatContractLabel(contract) {
  if (contract === 'color') return 'Цвят'
  if (contract === 'all-trumps') return 'Всичко коз'
  if (contract === 'no-trumps') return 'Без коз'
  return contract ?? 'Няма'
}

function isAllTrumpsContract(state) {
  const contract = String(state.contract ?? '').toLowerCase()
  const trumpSuit = String(state.trumpSuit ?? '').toLowerCase()

  return (
    contract === 'all-trumps' ||
    contract === 'all_trumps' ||
    contract === 'all trumps' ||
    contract === 'vsichko-koz' ||
    contract === 'vsichko koz' ||
    trumpSuit === 'all-trumps' ||
    trumpSuit === 'all_trumps' ||
    trumpSuit === 'all trumps'
  )
}

function isNoTrumpsContract(state) {
  const contract = String(state.contract ?? '').toLowerCase()
  const trumpSuit = String(state.trumpSuit ?? '').toLowerCase()

  return (
    contract === 'no-trumps' ||
    contract === 'no_trumps' ||
    contract === 'no trumps' ||
    contract === 'bez-koz' ||
    contract === 'bez koz' ||
    trumpSuit === 'no-trumps' ||
    trumpSuit === 'no_trumps' ||
    trumpSuit === 'no trumps'
  )
}

function isSuitContract(state) {
  return !isAllTrumpsContract(state) && !isNoTrumpsContract(state) && !!state.trumpSuit
}

function getCardPower(state, card, { treatAsTrump = false } = {}) {
  const rank = getCardRank(card)

  if (!rank) {
    return -1
  }

  const powerMap = treatAsTrump ? TRUMP_RANK_POWER : NORMAL_RANK_POWER

  return powerMap[rank] ?? -1
}

function isHandEmpty(hand = []) {
  return !hand || hand.length === 0
}

function cloneTrickEntries(entries = []) {
  return entries.map((entry) => ({
    playerId: entry.playerId,
    playerIndex: entry.playerIndex,
    card: entry.card,
  }))
}

function getWinningTrickEntry(state, trickEntries = []) {
  if (!trickEntries.length) {
    return null
  }

  const leadSuit = getCardSuit(trickEntries[0].card)

  if (!leadSuit) {
    return trickEntries[0]
  }

  if (isSuitContract(state)) {
    const trumpEntries = trickEntries.filter((entry) => getCardSuit(entry.card) === state.trumpSuit)

    if (trumpEntries.length > 0) {
      return trumpEntries.reduce((best, current) => {
        const currentPower = getCardPower(state, current.card, { treatAsTrump: true })
        const bestPower = getCardPower(state, best.card, { treatAsTrump: true })

        return currentPower > bestPower ? current : best
      })
    }

    const leadSuitEntries = trickEntries.filter((entry) => getCardSuit(entry.card) === leadSuit)

    return leadSuitEntries.reduce((best, current) => {
      const currentPower = getCardPower(state, current.card, { treatAsTrump: false })
      const bestPower = getCardPower(state, best.card, { treatAsTrump: false })

      return currentPower > bestPower ? current : best
    })
  }

  if (isAllTrumpsContract(state)) {
    const leadSuitEntries = trickEntries.filter((entry) => getCardSuit(entry.card) === leadSuit)

    return leadSuitEntries.reduce((best, current) => {
      const currentPower = getCardPower(state, current.card, { treatAsTrump: true })
      const bestPower = getCardPower(state, best.card, { treatAsTrump: true })

      return currentPower > bestPower ? current : best
    })
  }

  const leadSuitEntries = trickEntries.filter((entry) => getCardSuit(entry.card) === leadSuit)

  return leadSuitEntries.reduce((best, current) => {
    const currentPower = getCardPower(state, current.card, { treatAsTrump: false })
    const bestPower = getCardPower(state, best.card, { treatAsTrump: false })

    return currentPower > bestPower ? current : best
  })
}

function canBeatCard(state, candidateCard, targetCard, contextSuit) {
  if (!candidateCard || !targetCard) {
    return false
  }

  if (getCardSuit(candidateCard) !== getCardSuit(targetCard)) {
    return false
  }

  const suit = getCardSuit(candidateCard)
  const treatAsTrump =
    isAllTrumpsContract(state) ||
    (isSuitContract(state) && suit === state.trumpSuit) ||
    (contextSuit && suit === contextSuit && contextSuit === state.trumpSuit)

  return (
    getCardPower(state, candidateCard, { treatAsTrump }) >
    getCardPower(state, targetCard, { treatAsTrump })
  )
}

function findCardIndexInHand(hand = [], cardOrId) {
  if (!hand.length) {
    return -1
  }

  if (typeof cardOrId === 'string') {
    return hand.findIndex((card) => getCardId(card) === cardOrId)
  }

  const targetId = getCardId(cardOrId)
  return hand.findIndex((card) => getCardId(card) === targetId)
}

export function createGameEngine() {
  const state = createInitialGameState()

  function setCurrentTurn(playerId) {
    state.currentTurn = playerId
    state.currentPlayerIndex = getPlayerIndexById(playerId)
  }

  function resetRoundState() {
    state.currentTurn = null
    state.currentPlayerIndex = 0
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
    state.currentTrick = []
    state.completedTricks = []
    state.trickLeaderIndex = null
    state.lastTrickWinnerIndex = null
    state.cardsPlayedCount = 0
    state.roundWinnerTeam = null
    state.trick = []
    state.trickWins = {
      teamA: 0,
      teamB: 0,
    }
    state.announcements = {
      belotDeclaredBy: [],
      declarations: [],
    }
    state.hands = {
      bottom: [],
      right: [],
      top: [],
      left: [],
    }
    state.bidding = createInitialBiddingState('bottom')
  }

  function syncBiddingToRootState() {
    state.bidStarter = state.bidding.starter
    state.currentTurn = state.bidding.currentTurn
    state.currentPlayerIndex = getPlayerIndexById(state.bidding.currentTurn)
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

  function startRound({ advanceDealer = false } = {}) {
    if (advanceDealer) {
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

    const cutResult = cutDeck(shuffledDeck)

    state.cutIndex = cutResult.cutIndex
    state.deck = cutResult.deck

    state.phase = 'dealing'

    const firstRoundResult = dealFirstRound(state.deck, dealerPlayer)

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

  function getPlayableCardsForPlayer(playerId) {
    if (state.phase !== 'playing' || state.currentTurn !== playerId) {
      return []
    }

    const hand = state.hands[playerId] ?? []

    if (!hand.length) {
      return []
    }

    if (!state.currentTrick.length) {
      return [...hand]
    }

    const leadCard = state.currentTrick[0].card
    const leadSuit = getCardSuit(leadCard)
    const sameSuitCards = hand.filter((card) => getCardSuit(card) === leadSuit)

    if (sameSuitCards.length > 0) {
      if (isSuitContract(state) && leadSuit === state.trumpSuit) {
        const currentWinningEntry = getWinningTrickEntry(state, state.currentTrick)
        const higherCards = sameSuitCards.filter((card) =>
          canBeatCard(state, card, currentWinningEntry.card, leadSuit)
        )

        return higherCards.length > 0 ? higherCards : sameSuitCards
      }

      return sameSuitCards
    }

    if (isNoTrumpsContract(state) || isAllTrumpsContract(state)) {
      return [...hand]
    }

    const trumpsInHand = hand.filter((card) => getCardSuit(card) === state.trumpSuit)

    if (!trumpsInHand.length) {
      return [...hand]
    }

    const currentWinningEntry = getWinningTrickEntry(state, state.currentTrick)
    const currentWinningTeam = getTeamByPlayerId(currentWinningEntry.playerId)
    const currentPlayerTeam = getTeamByPlayerId(playerId)

    if (currentWinningTeam === currentPlayerTeam) {
      return [...hand]
    }

    const winningCardIsTrump = getCardSuit(currentWinningEntry.card) === state.trumpSuit

    if (!winningCardIsTrump) {
      return trumpsInHand
    }

    const higherTrumps = trumpsInHand.filter((card) =>
      canBeatCard(state, card, currentWinningEntry.card, state.trumpSuit)
    )

    return higherTrumps.length > 0 ? higherTrumps : trumpsInHand
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
    const playableCards = getPlayableCardsForPlayer(playerId)
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
      state.currentPlayerIndex = -1
      state.roundWinnerTeam = getRoundWinnerTeam(state.trickWins)
      return state
    }

    state.trickLeaderIndex = winningEntry.playerIndex
    setCurrentTurn(winningEntry.playerId)

    return state
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

  function runBotPlayingUntilHumanOrEnd() {
    if (state.phase !== 'playing') {
      return state
    }

    while (state.phase === 'playing' && state.currentTurn && isBotPlayer(state.currentTurn)) {
      const playerId = state.currentTurn
      const playableCards = getPlayableCardsForPlayer(playerId)

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
      state.dealerIndex = getRandomPlayerIndex()
      const result = startRound({ advanceDealer: false })
      runBotBiddingUntilHumanOrEnd(api)
      return result
    },

    restartRoundAfterAllPass() {
      const result = startRound({ advanceDealer: true })
      runBotBiddingUntilHumanOrEnd(api)
      return result
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

      state.deck = secondRoundResult.remainingDeck
      state.hands = secondRoundResult.hands
      state.secondRoundDealt = true

      startPlayingPhase()

      return state
    },

    getPlayableCards(playerId = 'bottom') {
      return getPlayableCardsForPlayer(playerId)
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
      const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
      const contractLabel = formatContractLabel(state.contract)
      const trumpLabel = state.trumpSuit ? formatSuitLabel(state.trumpSuit) : 'Няма'
      const leadSuit =
        state.currentTrick.length > 0 ? formatSuitLabel(getCardSuit(state.currentTrick[0].card)) : 'Няма'

      if (state.phase === 'bidding') {
        return `Стъпка 4: започва наддаването след първите 5 карти. Дилър е ${dealerPlayer}, първи на ход е ${state.currentTurn}.`
      }

      if (state.phase === 'playing') {
        if (state.currentTrick.length === 0) {
          return `Стъпка 5: наддаването приключи, раздадени са последните 3 карти. Играе се на ${contractLabel}${state.trumpSuit ? ` (${trumpLabel})` : ''}. ${state.currentTurn} започва взятката.`
        }

        return `Играе се взятка ${state.completedTricks.length + 1}. На ход е ${state.currentTurn}. Водещ цвят: ${leadSuit}.`
      }

      if (state.phase === 'round-complete') {
        return `Рундът приключи. teamA има ${state.trickWins.teamA} взятки, а teamB има ${state.trickWins.teamB} взятки. Победител: ${state.roundWinnerTeam}.`
      }

      if (state.phase === 'dealing' && state.firstRoundDealt) {
        return `Стъпка 3: раздадени са първите 3+2 карти от дилър ${dealerPlayer}. Остават ${state.deck.length} карти в тестето.`
      }

      if (state.phase === 'cutting') {
        return `Стъпка 2: тестето е събрано, разбъркано и е дадено за цепене на ${state.cuttingPlayer}. Дилър е ${dealerPlayer}.`
      }

      return 'Стъпка 1: играта е инициализирана'
    },
  }

  return api
}