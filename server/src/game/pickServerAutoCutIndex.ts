import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function pickServerAutoCutIndex(
  state: ServerAuthoritativeGameState,
): number {
  const totalCards = state.deck.length

  if (totalCards <= 2) {
    return 1
  }

  const minIndex = Math.min(6, totalCards - 1)
  const maxIndex = Math.max(minIndex, totalCards - 6)

  if (maxIndex <= minIndex) {
    return Math.max(1, Math.floor(totalCards / 2))
  }

  return minIndex + Math.floor(Math.random() * (maxIndex - minIndex + 1))
}