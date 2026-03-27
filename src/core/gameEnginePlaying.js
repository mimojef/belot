import { dealSecondRound } from './dealSecondRound.js'
import { PLAYER_ORDER } from './constants.js'
import {
  getPlayerIdByIndex,
  getPlayerIndexById,
  getNextPlayerId,
  getNextPlayerIndex,
  getRoundWinnerTeam,
  getTeamByPlayerId,
  isBotPlayer,
} from './playerOrder.js'
import {
  getCardSuit,
  getCardId,
  isHandEmpty,
  cloneTrickEntries,
  findCardIndexInHand,
} from './cardUtils.js'
import { getWinningTrickEntry } from './trickLogic.js'
import { getPlayableCardsForPlayer } from './playRules.js'
import { setCurrentTurn } from './gameEngineRoundSetup.js'

export function startPlayingPhase(state) {
  const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
  const firstPlayer = getNextPlayerId(dealerPlayer)

  state.phase = 'playing'
  state.currentTrick = []
  state.trick = state.currentTrick
  state.trickLeaderIndex = getPlayerIndexById(firstPlayer)
  setCurrentTurn(state, firstPlayer)

  state.dealStep = null
  state.dealingPacketSize = 0
  state.dealingTargetPlayer = null
  state.dealingAnimationQueue = []
  state.lastDealBatchComplete = false

  return state
}

export function beginLastThreeDealStep(state) {
  if (!state.firstRoundDealt || state.secondRoundDealt || !state.contract) {
    return state
  }

  const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
  const firstTargetPlayer = getNextPlayerId(dealerPlayer)

  state.phase = 'dealing'
  state.dealStep = 'last-3'
  state.dealingPacketSize = 3
  state.dealingTargetPlayer = firstTargetPlayer
  state.dealingAnimationQueue = []
  state.lastDealBatchComplete = false
  state.currentTurn = null
  state.currentPlayerIndex = null

  return state
}

export function finishLastThreeDealStep(state) {
  if (state.dealStep !== 'last-3' || state.secondRoundDealt || !state.contract) {
    return state
  }

  const dealerPlayer = getPlayerIdByIndex(state.dealerIndex)
  const secondRoundResult = dealSecondRound(state.deck, state.hands, dealerPlayer)

  state.deck = secondRoundResult.remainingDeck
  state.hands = secondRoundResult.hands
  state.secondRoundDealt = true
  state.lastDealBatchComplete = true

  startPlayingPhase(state)

  return state
}

export function playCardInternal(state, playerId, cardOrId) {
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

    setCurrentTurn(state, nextPlayerId)
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
  setCurrentTurn(state, winningEntry.playerId)

  return state
}

export function runBotPlayingUntilHumanOrEnd(state) {
  if (state.phase !== 'playing') {
    return state
  }

  while (state.phase === 'playing' && state.currentTurn && isBotPlayer(state.currentTurn)) {
    const playerId = state.currentTurn
    const playableCards = getPlayableCardsForPlayer(state, playerId)

    if (!playableCards.length) {
      break
    }

    playCardInternal(state, playerId, playableCards[0])
  }

  return state
}