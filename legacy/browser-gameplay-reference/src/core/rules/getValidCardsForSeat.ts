import type { Seat } from '../../data/constants/seatOrder'
import type { Card, GameState, Rank, Suit, TrickPlay, WinningBid } from '../state/gameTypes'
import { getWinningTrickPlay } from './getWinningTrickPlay'

const TRUMP_RANK_POWER: Record<Rank, number> = {
  '7': 0,
  '8': 1,
  Q: 2,
  K: 3,
  '10': 4,
  A: 5,
  '9': 6,
  J: 7,
}

function getLeadSuit(plays: TrickPlay[]): Suit | null {
  if (plays.length === 0) {
    return null
  }

  return plays[0]?.card.suit ?? null
}

function getCardsBySuit(cards: Card[], suit: Suit): Card[] {
  return cards.filter((card) => card.suit === suit)
}

function getTrumpSuit(winningBid: WinningBid): Suit | null {
  if (!winningBid || winningBid.contract !== 'suit') {
    return null
  }

  return winningBid.trumpSuit
}

function getHighestCardInSuitByTrumpOrder(plays: TrickPlay[], suit: Suit): Card | null {
  const suitedCards = plays
    .map((play) => play.card)
    .filter((card) => card.suit === suit)

  if (suitedCards.length === 0) {
    return null
  }

  let highestCard = suitedCards[0]

  for (let index = 1; index < suitedCards.length; index += 1) {
    const challenger = suitedCards[index]

    if (TRUMP_RANK_POWER[challenger.rank] > TRUMP_RANK_POWER[highestCard.rank]) {
      highestCard = challenger
    }
  }

  return highestCard
}

function getHigherCardsByTrumpOrder(cards: Card[], highestCard: Card | null): Card[] {
  if (!highestCard) {
    return cards
  }

  return cards.filter(
    (card) => TRUMP_RANK_POWER[card.rank] > TRUMP_RANK_POWER[highestCard.rank]
  )
}

function isPartnerWinning(state: GameState, seat: Seat, winningPlay: TrickPlay | null): boolean {
  if (!winningPlay) {
    return false
  }

  const currentPlayer = state.players[seat]
  const winningPlayer = state.players[winningPlay.seat]

  if (!currentPlayer || !winningPlayer) {
    return false
  }

  return currentPlayer.team === winningPlayer.team
}

function getValidCardsInSuitContract(
  state: GameState,
  seat: Seat,
  hand: Card[],
  plays: TrickPlay[],
  leadSuit: Suit,
  trumpSuit: Suit
): Card[] {
  const followSuitCards = getCardsBySuit(hand, leadSuit)
  const trumpCards = getCardsBySuit(hand, trumpSuit)
  const currentWinningPlay = getWinningTrickPlay(plays, state.bidding.winningBid)

  if (leadSuit === trumpSuit) {
    if (followSuitCards.length === 0) {
      return hand
    }

    const highestTrumpCard = getHighestCardInSuitByTrumpOrder(plays, trumpSuit)
    const higherTrumpCards = getHigherCardsByTrumpOrder(followSuitCards, highestTrumpCard)

    if (higherTrumpCards.length > 0) {
      return higherTrumpCards
    }

    return followSuitCards
  }

  if (followSuitCards.length > 0) {
    return followSuitCards
  }

  if (isPartnerWinning(state, seat, currentWinningPlay)) {
    return hand
  }

  if (trumpCards.length === 0) {
    return hand
  }

  const highestTrumpCard = getHighestCardInSuitByTrumpOrder(plays, trumpSuit)
  const higherTrumpCards = getHigherCardsByTrumpOrder(trumpCards, highestTrumpCard)

  if (higherTrumpCards.length > 0) {
    return higherTrumpCards
  }

  return hand
}

function getValidCardsInAllTrumpsContract(
  hand: Card[],
  plays: TrickPlay[],
  leadSuit: Suit
): Card[] {
  const followSuitCards = getCardsBySuit(hand, leadSuit)

  if (followSuitCards.length === 0) {
    return hand
  }

  const highestLeadSuitCard = getHighestCardInSuitByTrumpOrder(plays, leadSuit)
  const higherLeadSuitCards = getHigherCardsByTrumpOrder(
    followSuitCards,
    highestLeadSuitCard
  )

  if (higherLeadSuitCards.length > 0) {
    return higherLeadSuitCards
  }

  return followSuitCards
}

export function getValidCardsForSeat(state: GameState, seat: Seat): Card[] {
  const hand = state.hands[seat] ?? []
  const trickPlays = state.playing?.currentTrick.plays ?? state.currentTrick.plays
  const leadSuit = getLeadSuit(trickPlays)
  const winningBid = state.bidding.winningBid

  if (hand.length === 0) {
    return []
  }

  if (!leadSuit) {
    return hand
  }

  if (winningBid?.contract === 'all-trumps') {
    return getValidCardsInAllTrumpsContract(hand, trickPlays, leadSuit)
  }

  const trumpSuit = getTrumpSuit(winningBid)

  if (trumpSuit) {
    return getValidCardsInSuitContract(state, seat, hand, trickPlays, leadSuit, trumpSuit)
  }

  const followSuitCards = getCardsBySuit(hand, leadSuit)

  if (followSuitCards.length > 0) {
    return followSuitCards
  }

  return hand
}