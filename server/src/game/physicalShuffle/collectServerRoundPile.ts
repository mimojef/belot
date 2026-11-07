import { SERVER_SEAT_ORDER, type Seat } from '../../core/serverTypes.js'
import { createServerDeck } from '../createServerDeck.js'
import type { ServerAuthoritativeGameState, ServerCard } from '../serverGameTypes.js'

// Събира камарата на приключилото раздаване в ПОСЛЕДОВАТЕЛНОСТТА, в която
// картите са на масата. Индекс 0 = горна карта на новото тесте.
//
//   1. Изиграните взятки в хронологичен ред (playing.completedTricks), всяка
//      с картите в реда на игра. При „Долу картите“ сървърът вече е
//      синтезирал оставащите взятки (submitServerSweepDecision), така че и
//      там са 8 взятки / 32 карти.
//   2. Карти, останали в ръцете (всички пас → прераздаване): по ред на
//      раздаване, започвайки от firstDealSeat, всяка ръка в реда, в който
//      картите са получени.
//   3. Неразданите карти (всички пас: последните 12) — под тях, в реда им.
//
// Резултатът се валидира строго: точно 32 уникални карти = пълното тесте.
// Иначе → null (извикващият прави обичайното случайно разбъркване).

export type ServerRoundPileSource = 'tricks' | 'all-pass'

export type ServerRoundPile = {
  cards: ServerCard[]
  source: ServerRoundPileSource
}

const FULL_DECK_IDS: ReadonlySet<string> = new Set(createServerDeck().map((card) => card.id))

function getDealOrder(firstSeat: Seat | null): Seat[] {
  const startIndex = firstSeat === null ? 0 : Math.max(0, SERVER_SEAT_ORDER.indexOf(firstSeat))
  return [0, 1, 2, 3].map((offset) => SERVER_SEAT_ORDER[(startIndex + offset) % SERVER_SEAT_ORDER.length]!)
}

export function isServerFullDeckPermutation(cards: readonly ServerCard[]): boolean {
  if (cards.length !== FULL_DECK_IDS.size) {
    return false
  }
  const seen = new Set<string>()
  for (const card of cards) {
    if (!card || typeof card.id !== 'string' || !FULL_DECK_IDS.has(card.id) || seen.has(card.id)) {
      return false
    }
    seen.add(card.id)
  }
  return true
}

export function collectServerRoundPile(state: ServerAuthoritativeGameState): ServerRoundPile | null {
  const trickCards: ServerCard[] = []
  for (const trick of state.playing?.completedTricks ?? []) {
    for (const play of trick.plays) {
      trickCards.push(play.card)
    }
  }

  const handCards: ServerCard[] = []
  for (const seat of getDealOrder(state.round.firstDealSeat)) {
    handCards.push(...(state.hands[seat] ?? []))
  }

  const cards = [...trickCards, ...handCards, ...state.deck]

  if (!isServerFullDeckPermutation(cards)) {
    return null
  }

  return {
    cards,
    source: trickCards.length > 0 ? 'tricks' : 'all-pass',
  }
}
