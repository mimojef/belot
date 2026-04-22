import type { ServerCard } from './serverGameTypes.js'

export function cutServerDeck(deck: ServerCard[], cutIndex: number): ServerCard[] {
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