import type { RoomCardSnapshot } from '../network/createGameServerClient'

const SUIT_ORDER: Record<RoomCardSnapshot['suit'], number> = {
  diamonds: 0,
  clubs: 1,
  hearts: 2,
  spades: 3,
}

const ALL_TRUMPS_RANK_ORDER: Record<RoomCardSnapshot['rank'], number> = {
  '7': 0,
  '8': 1,
  Q: 2,
  K: 3,
  '10': 4,
  A: 5,
  '9': 6,
  J: 7,
}

export function sortLocalHandForAllTrumps(cards: RoomCardSnapshot[]): RoomCardSnapshot[] {
  return [...cards].sort((left, right) => {
    const suitDiff = SUIT_ORDER[left.suit] - SUIT_ORDER[right.suit]

    if (suitDiff !== 0) {
      return suitDiff
    }

    return ALL_TRUMPS_RANK_ORDER[left.rank] - ALL_TRUMPS_RANK_ORDER[right.rank]
  })
}
