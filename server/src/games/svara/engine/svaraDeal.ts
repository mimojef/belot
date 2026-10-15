// Свара — тесте и раздаване (чиста сървърна логика).
//
// Тестето е масив, в който deck[0] е най-горната карта. Раздаването е по
// една карта, по реда на подадените играчи, отгоре на тестето, докато всеки
// получи 3 карти. Кой играч започва се решава от масата (Етап 2Б.2) чрез
// реда на playerIds. Нито една карта не може да бъде раздадена два пъти:
// тестето се валидира (32 уникални карти) и резултатът се проверява отново.

import { assertValidSvaraCards, SVARA_DECK_SIZE, SVARA_ORDERED_DECK, SvaraInvalidInputError, svaraCardCode, type SvaraCard } from './svaraCards.js'
import { createCryptoSvaraRandomSource, shuffleWithSvaraRandom, type SvaraRandomSource } from './svaraRandom.js'

export const SVARA_CARDS_PER_PLAYER = 3
export const SVARA_MIN_PLAYERS = 2
export const SVARA_MAX_PLAYERS = 4

export type SvaraPlayerId = string

export type SvaraDealResult = {
  /** Ръцете по играч, в реда на раздаване (по 3 карти). */
  hands: ReadonlyMap<SvaraPlayerId, readonly SvaraCard[]>
  /** Редът на играчите при раздаването. */
  playerOrder: readonly SvaraPlayerId[]
  /** Неразданите карти (горната е [0]). */
  remainingDeck: readonly SvaraCard[]
}

/** Ново разбъркано тесте; по подразбиране с криптографски източник. */
export function createShuffledSvaraDeck(random: SvaraRandomSource = createCryptoSvaraRandomSource()): SvaraCard[] {
  return shuffleWithSvaraRandom(SVARA_ORDERED_DECK, random)
}

/** Контролирано тесте (тестове/повторяемост): точно 32 уникални валидни карти. */
export function createSvaraDeckFromCards(cards: readonly SvaraCard[]): SvaraCard[] {
  assertValidSvaraCards(cards, SVARA_DECK_SIZE, 'deck')
  return [...cards]
}

export function assertValidSvaraPlayerIds(playerIds: unknown): asserts playerIds is SvaraPlayerId[] {
  if (!Array.isArray(playerIds)) throw new SvaraInvalidInputError('playerIds: expected an array')
  if (playerIds.length < SVARA_MIN_PLAYERS || playerIds.length > SVARA_MAX_PLAYERS) {
    throw new SvaraInvalidInputError(`playerIds: Svara supports ${SVARA_MIN_PLAYERS}–${SVARA_MAX_PLAYERS} players, got ${playerIds.length}`)
  }
  const seen = new Set<string>()
  for (const id of playerIds) {
    if (typeof id !== 'string' || id.trim() === '') throw new SvaraInvalidInputError('playerIds: every id must be a non-empty string')
    if (seen.has(id)) throw new SvaraInvalidInputError(`playerIds: duplicate player ${id}`)
    seen.add(id)
  }
}

export function dealSvaraHands(playerIds: readonly SvaraPlayerId[], deck: readonly SvaraCard[]): SvaraDealResult {
  assertValidSvaraPlayerIds(playerIds)
  assertValidSvaraCards(deck, SVARA_DECK_SIZE, 'deck')

  const hands = new Map<SvaraPlayerId, SvaraCard[]>(playerIds.map((id) => [id, []]))
  let next = 0
  for (let round = 0; round < SVARA_CARDS_PER_PLAYER; round += 1) {
    for (const id of playerIds) {
      hands.get(id)!.push(deck[next]!)
      next += 1
    }
  }

  // Допълнителна защита: всяка раздадена карта е уникална и липсва от остатъка.
  const remainingDeck = deck.slice(next)
  const dealtCodes = new Set<string>()
  for (const cards of hands.values()) {
    for (const card of cards) {
      const code = svaraCardCode(card)
      if (dealtCodes.has(code)) throw new Error(`Invariant violated: card ${code} dealt twice`)
      dealtCodes.add(code)
    }
  }
  for (const card of remainingDeck) {
    if (dealtCodes.has(svaraCardCode(card))) throw new Error('Invariant violated: dealt card still in deck')
  }
  if (dealtCodes.size + remainingDeck.length !== SVARA_DECK_SIZE) throw new Error('Invariant violated: card count mismatch')

  return {
    hands: new Map([...hands].map(([id, cards]) => [id, Object.freeze([...cards])])),
    playerOrder: Object.freeze([...playerIds]),
    remainingDeck: Object.freeze(remainingDeck),
  }
}
