const SUITS = ['clubs', 'diamonds', 'hearts', 'spades']
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

export function createDeck() {
  const deck = []

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: `${rank}-${suit}`,
        suit,
        rank,
      })
    }
  }

  return deck
}

export function shuffleDeck(deck) {
  const shuffledDeck = [...deck]

  for (let i = shuffledDeck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffledDeck[i], shuffledDeck[j]] = [shuffledDeck[j], shuffledDeck[i]]
  }

  return shuffledDeck
}

export function cutDeck(deck, cutIndex = null) {
  if (!Array.isArray(deck) || deck.length === 0) {
    return {
      cutIndex: 0,
      deck: [],
    }
  }

  const minCut = 3
  const maxCut = deck.length - 3

  const safeCutIndex =
    cutIndex !== null
      ? Math.max(minCut, Math.min(maxCut, cutIndex))
      : Math.floor(Math.random() * (maxCut - minCut + 1)) + minCut

  const topPart = deck.slice(0, safeCutIndex)
  const bottomPart = deck.slice(safeCutIndex)

  return {
    cutIndex: safeCutIndex,
    deck: [...bottomPart, ...topPart],
  }
}