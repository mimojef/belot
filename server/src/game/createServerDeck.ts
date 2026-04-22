import { SERVER_RANKS, SERVER_SUITS } from './serverCardConstants.js'
import type { ServerCard } from './serverGameTypes.js'

export function createServerDeck(): ServerCard[] {
  const deck: ServerCard[] = []

  for (const suit of SERVER_SUITS) {
    for (const rank of SERVER_RANKS) {
      deck.push({
        id: `${suit}-${rank}`,
        suit,
        rank,
      })
    }
  }

  return deck
}