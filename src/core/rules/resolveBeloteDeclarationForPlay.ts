import type { Seat } from '../../data/constants/seatOrder'
import type { Card, Declaration, GameState, Suit } from '../state/gameTypes'
import { getValidCardsForSeat } from './getValidCardsForSeat'

function getCounterpartRank(rank: Card['rank']): Card['rank'] | null {
  if (rank === 'Q') {
    return 'K'
  }

  if (rank === 'K') {
    return 'Q'
  }

  return null
}

function getCurrentLeadSuit(state: GameState): Suit | null {
  const currentTrickPlays =
    state.playing?.currentTrick.plays ?? state.currentTrick.plays ?? []

  const firstPlay = currentTrickPlays[0]

  if (!firstPlay) {
    return null
  }

  return firstPlay.card.suit
}

function canDeclareBeloteForCard(state: GameState, selectedCard: Card): boolean {
  const winningBid = state.bidding.winningBid

  if (!winningBid) {
    return false
  }

  if (winningBid.contract === 'suit') {
    return winningBid.trumpSuit === selectedCard.suit
  }

  if (winningBid.contract === 'all-trumps') {
    const leadSuit = getCurrentLeadSuit(state)

    if (!leadSuit) {
      return true
    }

    return selectedCard.suit === leadSuit
  }

  return false
}

function hasBeloteAlreadyDeclared(
  state: GameState,
  seat: Seat,
  suit: Suit
): boolean {
  return state.declarations.some((declaration: Declaration) => {
    return (
      declaration.type === 'belote' &&
      declaration.seat === seat &&
      declaration.suit === suit &&
      declaration.valid
    )
  })
}

function createBeloteDeclaration(
  state: GameState,
  seat: Seat,
  selectedCard: Card,
  counterpartCard: Card
): Declaration {
  return {
    seat,
    team: state.players[seat].team,
    type: 'belote',
    points: 20,
    cards: [selectedCard, counterpartCard],
    suit: selectedCard.suit,
    highRank: null,
    announced: true,
    valid: true,
  }
}

export function resolveBeloteDeclarationForPlay(params: {
  state: GameState
  seat: Seat
  cardId: string
}): Declaration | null {
  const { state, seat, cardId } = params

  if (state.phase !== 'playing') {
    return null
  }

  const hand: Card[] = state.hands[seat] ?? []
  const selectedCard = hand.find((card: Card) => card.id === cardId)

  if (!selectedCard) {
    return null
  }

  const counterpartRank = getCounterpartRank(selectedCard.rank)

  if (!counterpartRank) {
    return null
  }

  if (!canDeclareBeloteForCard(state, selectedCard)) {
    return null
  }

  const validCards = getValidCardsForSeat(state, seat)

  if (!validCards.some((card: Card) => card.id === selectedCard.id)) {
    return null
  }

  const counterpartCard = hand.find((card: Card) => {
    return card.suit === selectedCard.suit && card.rank === counterpartRank
  })

  if (!counterpartCard) {
    return null
  }

  if (hasBeloteAlreadyDeclared(state, seat, selectedCard.suit)) {
    return null
  }

  return createBeloteDeclaration(state, seat, selectedCard, counterpartCard)
}