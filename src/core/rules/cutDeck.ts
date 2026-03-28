import type { Card } from '../state/gameTypes'

export function cutDeck(deck: Card[], cutIndex: number): Card[] {
  if (deck.length === 0) {
    return []
  }

  if (cutIndex <= 0 || cutIndex >= deck.length) {
    return [...deck]
  }

  const topPart = deck.slice(0, cutIndex)
  const bottomPart = deck.slice(cutIndex)

  return [...bottomPart, ...topPart]
}