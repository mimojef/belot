import type { Card } from '../state/gameTypes'

export function shuffleDeck(deck: Card[]): Card[] {
  const shuffledDeck = [...deck]

  for (let index = shuffledDeck.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    const currentCard = shuffledDeck[index]

    shuffledDeck[index] = shuffledDeck[randomIndex]
    shuffledDeck[randomIndex] = currentCard
  }

  return shuffledDeck
}