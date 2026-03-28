import { RANKS, SUITS } from '../../data/constants/cardConstants'
import type { Card } from '../state/gameTypes'

export function createDeck(): Card[] {
  const deck: Card[] = []

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: `${suit}-${rank}`,
        suit,
        rank,
      })
    }
  }

  return deck
}