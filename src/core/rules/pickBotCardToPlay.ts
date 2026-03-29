import type { Card, GameState } from '../state/gameTypes'
import type { Seat } from '../../data/constants/seatOrder'
import { getValidCardsForSeat } from './getValidCardsForSeat'

export function pickBotCardToPlay(state: GameState, seat: Seat): Card | null {
  const validCards = getValidCardsForSeat(state, seat)

  if (validCards.length === 0) {
    return null
  }

  return validCards[0] ?? null
}