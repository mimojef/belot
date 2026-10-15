// Свара — карти (чиста логика, без HTTP/WebSocket/DB/UI).
//
// Тесте от 32 карти: 7, 8, 9, 10, J (вале), Q (дама), K (поп), A (асо)
// във всяка от четирите бои. 7♣ е „чечак“ (жокер, виж svaraHandEvaluation.ts).
//
// Потвърдени стойности (решение на собственика, Етап 2Б.1):
//   A = 11; 10, J, Q, K = 10; 9 = 9; 8 = 8; 7 = 7; чечакът (7♣) = 11.

export const SVARA_SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const
export const SVARA_RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const

export type SvaraSuit = (typeof SVARA_SUITS)[number]
export type SvaraRank = (typeof SVARA_RANKS)[number]

export type SvaraCard = Readonly<{ suit: SvaraSuit; rank: SvaraRank }>

/** Компактен код: ранг + буква на боята, напр. "7C", "10H", "AS". */
export type SvaraCardCode = `${SvaraRank}${'C' | 'D' | 'H' | 'S'}`

export const SVARA_DECK_SIZE = 32
export const SVARA_CHECHAK_POINTS = 11

const SUIT_LETTER: Record<SvaraSuit, 'C' | 'D' | 'H' | 'S'> = { clubs: 'C', diamonds: 'D', hearts: 'H', spades: 'S' }
const LETTER_SUIT: Record<string, SvaraSuit> = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' }

const RANK_POINTS: Record<SvaraRank, number> = { '7': 7, '8': 8, '9': 9, '10': 10, J: 10, Q: 10, K: 10, A: 11 }

export class SvaraInvalidInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SvaraInvalidInputError'
  }
}

export function isSvaraSuit(value: unknown): value is SvaraSuit {
  return typeof value === 'string' && (SVARA_SUITS as readonly string[]).includes(value)
}

export function isSvaraRank(value: unknown): value is SvaraRank {
  return typeof value === 'string' && (SVARA_RANKS as readonly string[]).includes(value)
}

/** Структурна проверка (без допълнителни полета, без грешни бои/рангове). */
export function isSvaraCard(value: unknown): value is SvaraCard {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('suit') || !keys.includes('rank')) return false
  const card = value as { suit: unknown; rank: unknown }
  return isSvaraSuit(card.suit) && isSvaraRank(card.rank)
}

export function svaraCard(rank: SvaraRank, suit: SvaraSuit): SvaraCard {
  if (!isSvaraRank(rank) || !isSvaraSuit(suit)) throw new SvaraInvalidInputError(`Invalid card: ${String(rank)} of ${String(suit)}`)
  return Object.freeze({ suit, rank })
}

export function svaraCardCode(card: SvaraCard): SvaraCardCode {
  if (!isSvaraCard(card)) throw new SvaraInvalidInputError('Invalid card')
  return `${card.rank}${SUIT_LETTER[card.suit]}` as SvaraCardCode
}

export function parseSvaraCardCode(code: string): SvaraCard {
  if (typeof code !== 'string') throw new SvaraInvalidInputError('Card code must be a string')
  const match = /^(7|8|9|10|J|Q|K|A)([CDHS])$/.exec(code)
  if (!match) throw new SvaraInvalidInputError(`Invalid card code: ${code}`)
  return svaraCard(match[1] as SvaraRank, LETTER_SUIT[match[2]!]!)
}

export function isSvaraChechak(card: SvaraCard): boolean {
  return card.rank === '7' && card.suit === 'clubs'
}

/** Стойност на картата по общите правила (без специалната роля на чечака). */
export function svaraRankPoints(rank: SvaraRank): number {
  return RANK_POINTS[rank]
}

/** Всички 32 карти в каноничен ред (боя, после ранг). */
export const SVARA_ORDERED_DECK: readonly SvaraCard[] = Object.freeze(
  SVARA_SUITS.flatMap((suit) => SVARA_RANKS.map((rank) => svaraCard(rank, suit))),
)

/**
 * Проверява, че списъкът съдържа само валидни и уникални карти.
 * expectedSize: точен брой (напр. 32 за тесте, 3 за ръка).
 */
export function assertValidSvaraCards(cards: unknown, expectedSize: number | null, label: string): asserts cards is SvaraCard[] {
  if (!Array.isArray(cards)) throw new SvaraInvalidInputError(`${label}: expected an array of cards`)
  if (expectedSize !== null && cards.length !== expectedSize) {
    throw new SvaraInvalidInputError(`${label}: expected ${expectedSize} cards, got ${cards.length}`)
  }
  const seen = new Set<string>()
  for (const card of cards) {
    if (!isSvaraCard(card)) throw new SvaraInvalidInputError(`${label}: invalid card ${JSON.stringify(card)}`)
    const code = svaraCardCode(card)
    if (seen.has(code)) throw new SvaraInvalidInputError(`${label}: duplicate card ${code}`)
    seen.add(code)
  }
}
