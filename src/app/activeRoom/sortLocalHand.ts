import type { RoomCardSnapshot } from '../network/createGameServerClient'

const SUIT_ORDER: Record<RoomCardSnapshot['suit'], number> = {
  diamonds: 0,
  clubs: 1,
  hearts: 2,
  spades: 3,
}

const TRUMP_RANK_ORDER: Record<RoomCardSnapshot['rank'], number> = {
  '7': 0,
  '8': 1,
  Q: 2,
  K: 3,
  '10': 4,
  A: 5,
  '9': 6,
  J: 7,
}

const NO_TRUMPS_RANK_ORDER: Record<RoomCardSnapshot['rank'], number> = {
  '7': 0,
  '8': 1,
  '9': 2,
  J: 3,
  Q: 4,
  K: 5,
  '10': 6,
  A: 7,
}

export type SortDisplayOptions =
  | { contract: 'default' }
  | { contract: 'no-trumps' }
  | { contract: 'all-trumps' }
  | { contract: 'suit'; trumpSuit: 'clubs' | 'diamonds' | 'hearts' | 'spades' }

function getRankOrder(card: RoomCardSnapshot, options: SortDisplayOptions): number {
  if (options.contract === 'no-trumps') {
    return NO_TRUMPS_RANK_ORDER[card.rank]
  }
  if (options.contract === 'suit') {
    return card.suit === options.trumpSuit
      ? TRUMP_RANK_ORDER[card.rank]
      : NO_TRUMPS_RANK_ORDER[card.rank]
  }
  return TRUMP_RANK_ORDER[card.rank]
}

export function sortLocalHandForDisplay(
  cards: RoomCardSnapshot[],
  options: SortDisplayOptions = { contract: 'default' },
): RoomCardSnapshot[] {
  return [...cards].sort((a, b) => {
    const suitDiff = SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit]
    if (suitDiff !== 0) return suitDiff
    return getRankOrder(a, options) - getRankOrder(b, options)
  })
}

export function sortLocalHandForAllTrumps(cards: RoomCardSnapshot[]): RoomCardSnapshot[] {
  return sortLocalHandForDisplay(cards)
}
