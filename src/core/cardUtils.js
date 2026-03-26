export function normalizeCardRank(rank) {
  if (rank === null || rank === undefined) {
    return null
  }

  const value = String(rank).trim().toUpperCase()

  if (value === 'JACK') return 'J'
  if (value === 'QUEEN') return 'Q'
  if (value === 'KING') return 'K'
  if (value === 'ACE') return 'A'

  return value
}

export function getCardRank(card) {
  return normalizeCardRank(card?.rank ?? card?.value ?? card?.face ?? card?.name ?? null)
}

export function getCardSuit(card) {
  return card?.suit ?? null
}

export function getCardId(card) {
  return card?.id ?? `${getCardSuit(card)}-${getCardRank(card)}`
}

export function isHandEmpty(hand = []) {
  return !hand || hand.length === 0
}

export function cloneTrickEntries(entries = []) {
  return entries.map((entry) => ({
    playerId: entry.playerId,
    playerIndex: entry.playerIndex,
    card: entry.card,
  }))
}

export function findCardIndexInHand(hand = [], cardOrId) {
  if (!hand.length) {
    return -1
  }

  if (typeof cardOrId === 'string') {
    return hand.findIndex((card) => getCardId(card) === cardOrId)
  }

  const targetId = getCardId(cardOrId)
  return hand.findIndex((card) => getCardId(card) === targetId)
}