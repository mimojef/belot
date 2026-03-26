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

function normalizeCutIndex(deckLength, cutIndex) {
  if (!Number.isInteger(deckLength) || deckLength <= 0) {
    return 0
  }

  const minCut = 1
  const maxCut = deckLength - 1

  if (maxCut < minCut) {
    return 0
  }

  if (cutIndex === null || cutIndex === undefined || Number.isNaN(Number(cutIndex))) {
    return Math.floor(Math.random() * (maxCut - minCut + 1)) + minCut
  }

  const numericCutIndex = Number(cutIndex)

  return Math.max(minCut, Math.min(maxCut, numericCutIndex))
}

export function cutDeck(deck, cutIndex = null) {
  if (!Array.isArray(deck) || deck.length === 0) {
    return {
      cutIndex: 0,
      deck: [],
      topPart: [],
      bottomPart: [],
    }
  }

  const safeCutIndex = normalizeCutIndex(deck.length, cutIndex)

  const topPart = deck.slice(0, safeCutIndex)
  const bottomPart = deck.slice(safeCutIndex)

  return {
    cutIndex: safeCutIndex,
    deck: [...bottomPart, ...topPart],
    topPart,
    bottomPart,
  }
}