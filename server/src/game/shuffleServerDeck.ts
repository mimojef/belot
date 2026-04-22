import type { ServerCard } from './serverGameTypes.js'

export function shuffleServerDeck(deck: ServerCard[]): ServerCard[] {
  const shuffledDeck = [...deck]

  for (let index = shuffledDeck.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    const currentCard = shuffledDeck[index]

    shuffledDeck[index] = shuffledDeck[randomIndex]
    shuffledDeck[randomIndex] = currentCard
  }

  return shuffledDeck
}