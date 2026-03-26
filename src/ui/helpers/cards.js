export function getCardRank(card) {
  const rawRank = card?.rank ?? card?.value ?? card?.face ?? card?.name ?? ''

  return String(rawRank)
    .replace('JACK', 'J')
    .replace('QUEEN', 'Q')
    .replace('KING', 'K')
    .replace('ACE', 'A')
    .trim()
    .toUpperCase()
}

export function getCardSuit(card) {
  return card?.suit ?? ''
}

export function getCardId(card) {
  return card?.id ?? `${getCardSuit(card)}-${getCardRank(card)}`
}

export function getSuitSymbol(suit) {
  if (suit === 'clubs') return '♣'
  if (suit === 'diamonds') return '♦'
  if (suit === 'hearts') return '♥'
  if (suit === 'spades') return '♠'
  return ''
}

export function getSuitColor(suit) {
  if (suit === 'diamonds' || suit === 'hearts') {
    return '#dc2626'
  }

  return '#111827'
}

export function isAllTrumpsContract(contract, trumpSuit) {
  const normalizedContract = String(contract ?? '').toLowerCase()
  const normalizedTrumpSuit = String(trumpSuit ?? '').toLowerCase()

  return (
    normalizedContract === 'all-trumps' ||
    normalizedContract === 'all_trumps' ||
    normalizedContract === 'all trumps' ||
    normalizedTrumpSuit === 'all-trumps' ||
    normalizedTrumpSuit === 'all_trumps' ||
    normalizedTrumpSuit === 'all trumps'
  )
}

export function isNoTrumpsContract(contract, trumpSuit) {
  const normalizedContract = String(contract ?? '').toLowerCase()
  const normalizedTrumpSuit = String(trumpSuit ?? '').toLowerCase()

  return (
    normalizedContract === 'no-trumps' ||
    normalizedContract === 'no_trumps' ||
    normalizedContract === 'no trumps' ||
    normalizedTrumpSuit === 'no-trumps' ||
    normalizedTrumpSuit === 'no_trumps' ||
    normalizedTrumpSuit === 'no trumps'
  )
}

export function getSuitOrderIndex(suit) {
  const suitOrder = ['spades', 'hearts', 'diamonds', 'clubs']
  const index = suitOrder.indexOf(suit)

  return index === -1 ? 999 : index
}

export function getNormalRankStrength(rank) {
  const power = {
    '7': 0,
    '8': 1,
    '9': 2,
    J: 3,
    Q: 4,
    K: 5,
    '10': 6,
    A: 7,
  }

  return power[rank] ?? -1
}

export function getTrumpRankStrength(rank) {
  const power = {
    '7': 0,
    '8': 1,
    Q: 2,
    K: 3,
    '10': 4,
    A: 5,
    '9': 6,
    J: 7,
  }

  return power[rank] ?? -1
}

export function getCardStrengthForCurrentAnnouncement(card, contract, trumpSuit) {
  const suit = getCardSuit(card)
  const rank = getCardRank(card)

  if (isAllTrumpsContract(contract, trumpSuit)) {
    return getTrumpRankStrength(rank)
  }

  if (isNoTrumpsContract(contract, trumpSuit)) {
    return getNormalRankStrength(rank)
  }

  if (contract === 'color' && suit === trumpSuit) {
    return getTrumpRankStrength(rank)
  }

  return getNormalRankStrength(rank)
}

export function sortBottomHand(hand = [], contract, trumpSuit) {
  return [...hand].sort((cardA, cardB) => {
    const suitA = getCardSuit(cardA)
    const suitB = getCardSuit(cardB)

    const suitDiff = getSuitOrderIndex(suitA) - getSuitOrderIndex(suitB)

    if (suitDiff !== 0) {
      return suitDiff
    }

    const strengthA = getCardStrengthForCurrentAnnouncement(cardA, contract, trumpSuit)
    const strengthB = getCardStrengthForCurrentAnnouncement(cardB, contract, trumpSuit)

    if (strengthA !== strengthB) {
      return strengthA - strengthB
    }

    return getCardId(cardA).localeCompare(getCardId(cardB))
  })
}
