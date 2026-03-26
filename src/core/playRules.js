import { getCardSuit } from './cardUtils.js'
import { canBeatCard, isNoTrumpsContract, isAllTrumpsContract, isSuitContract } from './contractUtils.js'
import { getTeamByPlayerId } from './playerOrder.js'
import { getWinningTrickEntry } from './trickLogic.js'

export function getPlayableCardsForPlayer(state, playerId) {
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