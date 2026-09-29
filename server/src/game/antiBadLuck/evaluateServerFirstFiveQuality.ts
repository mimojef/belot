import { SERVER_SUITS } from '../serverCardConstants.js'
import type { ServerCard, ServerRank, ServerSuit } from '../serverGameTypes.js'
import type { ServerAntiBadLuckRescueKind } from './serverAntiBadLuckTypes.js'

export const SERVER_ANTI_BAD_LUCK_TRUMP_VALUES: Record<ServerRank, number> = {
  J: 20,
  '9': 14,
  A: 11,
  '10': 10,
  K: 4,
  Q: 3,
  '8': 0,
  '7': 0,
}

export const SERVER_ANTI_BAD_LUCK_NO_TRUMP_VALUES: Record<ServerRank, number> = {
  A: 11,
  '10': 10,
  K: 4,
  Q: 3,
  J: 2,
  '9': 0,
  '8': 0,
  '7': 0,
}

export const SERVER_ANTI_BAD_LUCK_MIN_SUIT_VALUE = 31

// Сила на естествена карта спрямо избрания rescue — по-слабите се заменят
// първи. NO_TRUMPS → безкозови стойности; ALL_TRUMPS → козови за всички
// цветове; SUIT → козови за избрания цвят, безкозови за останалите.
export function getServerAntiBadLuckKeepStrength(
  card: ServerCard,
  rescue: ServerAntiBadLuckRescueKind,
): number {
  if (rescue.type === 'ALL_TRUMPS' || (rescue.type === 'SUIT' && card.suit === rescue.variant)) {
    return SERVER_ANTI_BAD_LUCK_TRUMP_VALUES[card.rank]
  }

  return SERVER_ANTI_BAD_LUCK_NO_TRUMP_VALUES[card.rank]
}

// XXX (три anchor-а) ИЛИ XX + companion от цвета на едното anchor.
function hasAnchorTripleOrPairWithCompanion(
  cards: readonly ServerCard[],
  anchorRank: ServerRank,
  companionRank: ServerRank,
): boolean {
  const anchors = cards.filter((card) => card.rank === anchorRank)

  if (anchors.length >= 3) {
    return true
  }

  if (anchors.length < 2) {
    return false
  }

  const anchorSuits = new Set(anchors.map((card) => card.suit))

  return cards.some((card) => card.rank === companionRank && anchorSuits.has(card.suit))
}

export function isServerNoTrumpsGoodFirstFive(cards: readonly ServerCard[]): boolean {
  return hasAnchorTripleOrPairWithCompanion(cards, 'A', '10')
}

export function isServerAllTrumpsGoodFirstFive(cards: readonly ServerCard[]): boolean {
  return hasAnchorTripleOrPairWithCompanion(cards, 'J', '9')
}

// Поне 3 карти от един цвят, сред които J, с най-добра тройка >= 31 козови точки.
export function isServerSuitGoodFirstFive(cards: readonly ServerCard[]): boolean {
  return SERVER_SUITS.some((suit) => {
    const suitCards = cards.filter((card) => card.suit === suit)

    if (suitCards.length < 3 || !suitCards.some((card) => card.rank === 'J')) {
      return false
    }

    const otherValues = suitCards
      .filter((card) => card.rank !== 'J')
      .map((card) => SERVER_ANTI_BAD_LUCK_TRUMP_VALUES[card.rank])
      .sort((left, right) => right - left)

    return (
      SERVER_ANTI_BAD_LUCK_TRUMP_VALUES.J + otherValues[0] + otherValues[1] >=
      SERVER_ANTI_BAD_LUCK_MIN_SUIT_VALUE
    )
  })
}

export function isServerGoodFirstFive(cards: readonly ServerCard[]): boolean {
  return (
    isServerNoTrumpsGoodFirstFive(cards) ||
    isServerAllTrumpsGoodFirstFive(cards) ||
    isServerSuitGoodFirstFive(cards)
  )
}

// Natural anchor (J за ALL_TRUMPS / A за NO_TRUMPS) цветове сред първите 5 —
// runtime constraint за rescue candidate generation (не се persist-ва).
export function getServerAntiBadLuckNaturalAnchorSuits(
  cards: readonly ServerCard[],
  anchorRank: ServerRank,
): ServerSuit[] {
  return cards.filter((card) => card.rank === anchorRank).map((card) => card.suit)
}
