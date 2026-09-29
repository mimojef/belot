// Прилага Anti Bad Luck върху вече разбъркания и цепнат deck, точно преди
// deal-first-3. Гледа САМО първите 5 естествени карти на всеки seat — никакъв
// резултат, bidding, profile или човек/бот.
//
// Flow:
//  1. Естествените първи 5 на всеки seat се изчисляват от позициите в deck-а
//     (симулация със същия dealServerCardsInPackets: 3 + 2 от firstDealSeat).
//  2. Rescue кандидат = pending seat (>= 3 поредни BAD), чиито естествени първи
//     5 са отново BAD. Естествен GOOD → без rescue, counter = 0.
//  3. Максимум 1 rescue на отбор: по-стар pending печели, равенство → random.
//  4. При rescue НЯМА повторно разбъркване: rescue карта, която вече е в
//     първите 5 на seat-а, остава на мястото си; всяка липсваща се swap-ва на
//     мястото на НАЙ-СЛАБАТА естествена карта от първите 5 според избрания
//     тип (getServerAntiBadLuckKeepStrength), равенство → random. Позицията
//     (first-3 / next-2) не участва. Естествената карта отива на мястото на
//     rescue картата; всички други позиции остават непокътнати.
//  5. Основният тип (строго 1/3) се тегли веднъж на seat и НЕ се сменя.
//     Цветът/шаблонът се тегли random като предпочитан и се сменя (в същия
//     тип) само ако за него няма безопасна реализация. Планът
//     се отхвърля, ако наруши deck invariant или отнеме естествено GOOD първи 5
//     на друг seat → random retry, после изчерпателно търсене в същите типове.
//     Само ако няма никаква безопасна реализация → естествените карти, seat-ът
//     остава pending.
//  6. Streak-овете се обновяват по реално раздадените първи 5.

import {
  SERVER_TEAM_A_SEATS,
  SERVER_TEAM_B_SEATS,
  SERVER_SEAT_ORDER,
  type Seat,
} from '../../core/serverTypes.js'
import { shuffleWithRandom } from '../../core/seededRandom.js'
import { createEmptyHands } from '../createServerRoundDefaults.js'
import { dealServerCardsInPackets } from '../dealServerCardsInPackets.js'
import type { ServerCard } from '../serverGameTypes.js'
import {
  getServerAntiBadLuckKeepStrength,
  isServerGoodFirstFive,
} from './evaluateServerFirstFiveQuality.js'
import {
  getServerAntiBadLuckRescueCandidates,
  pickServerAntiBadLuckRescue,
  pickServerAntiBadLuckRescueType,
  pickServerAntiBadLuckRescueVariant,
} from './pickServerAntiBadLuckRescue.js'
import {
  SERVER_ANTI_BAD_LUCK_STREAK_THRESHOLD,
  createEmptyServerAntiBadLuckState,
  type ServerAntiBadLuckRescue,
  type ServerAntiBadLuckRescueKind,
  type ServerAntiBadLuckSeatState,
  type ServerAntiBadLuckState,
} from './serverAntiBadLuckTypes.js'

const FIRST_FIVE_CARD_COUNT = 5
const MAX_RESCUE_PLAN_ATTEMPTS = 16

type RescueMap = Partial<Record<Seat, ServerAntiBadLuckRescue>>
type RescueKindMap = Partial<Record<Seat, ServerAntiBadLuckRescueKind>>

export type ServerAntiBadLuckDealResult = {
  deck: ServerCard[]
  antiBadLuck: ServerAntiBadLuckState
  // За избраните seats (вкл. тези без безопасен план): изтегленият основен тип
  // (фиксиран) и предпочитаният цвят/шаблон — само за server-side тестове.
  rescueKinds: RescueKindMap
  rescues: RescueMap
}

// Deck индексите, от които всеки seat получава първите си 5 карти.
export function getServerFirstFiveDeckIndicesBySeat(
  firstDealSeat: Seat,
): Record<Seat, number[]> {
  const indexDeck: ServerCard[] = Array.from({ length: FIRST_FIVE_CARD_COUNT * 4 }, (_, index) => ({
    id: String(index),
    suit: 'clubs',
    rank: '7',
  }))
  const afterFirstThree = dealServerCardsInPackets(indexDeck, createEmptyHands(), firstDealSeat, 3, 1)
  const afterNextTwo = dealServerCardsInPackets(
    afterFirstThree.remainingDeck,
    afterFirstThree.hands,
    firstDealSeat,
    2,
    1,
  )
  const toIndices = (seat: Seat) => afterNextTwo.hands[seat].map((card) => Number(card.id))

  return {
    bottom: toIndices('bottom'),
    right: toIndices('right'),
    top: toIndices('top'),
    left: toIndices('left'),
  }
}

function isPending(seatState: ServerAntiBadLuckSeatState): boolean {
  return seatState.pendingSinceDealIndex !== null
}

function pickTeamRescueSeat(
  teamSeats: readonly Seat[],
  previous: ServerAntiBadLuckState,
  isNaturalGood: Record<Seat, boolean>,
  nextRandom: () => number,
): Seat | null {
  const candidates = teamSeats.filter(
    (seat) => isPending(previous.seats[seat]) && !isNaturalGood[seat],
  )

  if (candidates.length === 0) {
    return null
  }

  const oldestPending = Math.min(
    ...candidates.map((seat) => previous.seats[seat].pendingSinceDealIndex as number),
  )
  const oldestCandidates = candidates.filter(
    (seat) => previous.seats[seat].pendingSinceDealIndex === oldestPending,
  )

  return oldestCandidates.length === 1
    ? oldestCandidates[0]
    : shuffleWithRandom(oldestCandidates, nextRandom)[0]
}

// Random тройки в предпочитания цвят/шаблон на всеки seat.
function pickRescues(
  rescueSeats: readonly Seat[],
  rescueKinds: RescueKindMap,
  nextRandom: () => number,
): RescueMap {
  const rescues: RescueMap = {}
  const usedCardIds = new Set<string>()

  // Random ред, за да няма отбор с постоянно предимство при избора на тройка.
  for (const seat of shuffleWithRandom(rescueSeats, nextRandom)) {
    const kind = rescueKinds[seat] as ServerAntiBadLuckRescueKind
    const rescue = pickServerAntiBadLuckRescue(kind.type, usedCardIds, nextRandom, kind.variant)

    if (rescue) {
      rescues[seat] = rescue
      rescue.cardIds.forEach((cardId) => usedCardIds.add(cardId))
    }
  }

  return rescues
}

// Изчерпателно обхождане на всички реализации на вече избраните основни
// типове: първо планове за всички rescue seats, после — ако няма нито един —
// единични. Кандидатите в предпочитания цвят/шаблон са първи (в random ред),
// така че друг цвят/шаблон се взима само ако предпочитаният е невъзможен.
// Използва се само когато random опитите не са намерили план за всички seats.
function* enumerateRescuePlans(
  rescueSeats: readonly Seat[],
  rescueKinds: RescueKindMap,
  nextRandom: () => number,
): Generator<RescueMap> {
  const seats = shuffleWithRandom(rescueSeats, nextRandom)
  const candidatesBySeat = new Map(
    seats.map((seat) => {
      const kind = rescueKinds[seat] as ServerAntiBadLuckRescueKind
      const candidates = getServerAntiBadLuckRescueCandidates(kind.type)

      return [
        seat,
        [
          ...shuffleWithRandom(candidates.filter((rescue) => rescue.variant === kind.variant), nextRandom),
          ...shuffleWithRandom(candidates.filter((rescue) => rescue.variant !== kind.variant), nextRandom),
        ],
      ]
    }),
  )

  if (seats.length === 2) {
    const [firstSeat, secondSeat] = seats

    for (const first of candidatesBySeat.get(firstSeat) ?? []) {
      for (const second of candidatesBySeat.get(secondSeat) ?? []) {
        if (second.cardIds.every((cardId) => !first.cardIds.includes(cardId))) {
          yield { [firstSeat]: first, [secondSeat]: second }
        }
      }
    }
  }

  for (const seat of seats) {
    for (const rescue of candidatesBySeat.get(seat) ?? []) {
      yield { [seat]: rescue }
    }
  }
}

// Една обща permutation от swap-ове върху естественото тесте. Rescue карта,
// която вече е в първите 5 на seat-а, остава на мястото си. Всяка липсваща
// заема позицията на най-слабата естествена карта от първите 5 според
// избрания тип; равна сила → random (seeded). Карта, която е rescue карта на
// ДРУГИЯ seat, така или иначе напуска ръката → заменя се с приоритет, за да
// не губим излишно естествена карта. Тройките на двата seat-а са disjoint,
// затова swap-овете на втория не местят поставените карти на първия.
export function applyServerAntiBadLuckRescueSwaps(
  deck: readonly ServerCard[],
  firstFiveIndices: Record<Seat, number[]>,
  rescues: Partial<Record<Seat, ServerAntiBadLuckRescue>>,
  nextRandom: () => number = Math.random,
): ServerCard[] {
  const allRescueCardIds = new Set(
    Object.values(rescues).flatMap((rescue) => rescue?.cardIds ?? []),
  )
  const nextDeck = [...deck]
  const positionById = new Map(nextDeck.map((card, index) => [card.id, index]))
  const swap = (left: number, right: number) => {
    const leftCard = nextDeck[left]
    nextDeck[left] = nextDeck[right]
    nextDeck[right] = leftCard
    positionById.set(nextDeck[left].id, left)
    positionById.set(nextDeck[right].id, right)
  }

  for (const seat of SERVER_SEAT_ORDER) {
    const rescue = rescues[seat]

    if (!rescue) {
      continue
    }

    const seatPositions = firstFiveIndices[seat]
    const rescueCardIds = new Set(rescue.cardIds)
    const missingCardIds = rescue.cardIds.filter(
      (cardId) => !seatPositions.includes(positionById.get(cardId) as number),
    )
    const strengthAt = (position: number) =>
      allRescueCardIds.has(nextDeck[position].id)
        ? -1
        : getServerAntiBadLuckKeepStrength(nextDeck[position], rescue)
    // Shuffle преди стабилното сортиране = random tie-break при равна сила.
    const targetPositions = shuffleWithRandom(
      seatPositions.filter((position) => !rescueCardIds.has(nextDeck[position].id)),
      nextRandom,
    ).sort((left, right) => strengthAt(left) - strengthAt(right))

    missingCardIds.forEach((cardId, index) => {
      swap(targetPositions[index], positionById.get(cardId) as number)
    })
  }

  return nextDeck
}

function hasSameCardSet(left: readonly ServerCard[], right: readonly ServerCard[]): boolean {
  if (left.length !== right.length || right.some((card) => !card)) {
    return false
  }

  const leftIds = new Set(left.map((card) => card.id))
  const rightIds = new Set(right.map((card) => card.id))

  return rightIds.size === right.length && [...rightIds].every((cardId) => leftIds.has(cardId))
}

function getNextSeatState(
  previousSeatState: ServerAntiBadLuckSeatState,
  isGood: boolean,
  dealIndex: number,
): ServerAntiBadLuckSeatState {
  if (isGood) {
    return { consecutiveBadDeals: 0, pendingSinceDealIndex: null }
  }

  const consecutiveBadDeals = previousSeatState.consecutiveBadDeals + 1

  return {
    consecutiveBadDeals,
    pendingSinceDealIndex:
      previousSeatState.pendingSinceDealIndex ??
      (consecutiveBadDeals >= SERVER_ANTI_BAD_LUCK_STREAK_THRESHOLD ? dealIndex : null),
  }
}

export function applyServerAntiBadLuckToDeck(
  deck: ServerCard[],
  firstDealSeat: Seat,
  previousState: ServerAntiBadLuckState | undefined,
  nextRandom: () => number = Math.random,
): ServerAntiBadLuckDealResult {
  const previous = previousState ?? createEmptyServerAntiBadLuckState()

  if (deck.length < FIRST_FIVE_CARD_COUNT * 4) {
    return { deck, antiBadLuck: previous, rescueKinds: {}, rescues: {} }
  }

  const dealIndex = previous.dealIndex + 1
  const firstFiveIndices = getServerFirstFiveDeckIndicesBySeat(firstDealSeat)
  const getFirstFive = (sourceDeck: readonly ServerCard[], seat: Seat) =>
    firstFiveIndices[seat].map((deckIndex) => sourceDeck[deckIndex])
  const evaluate = (sourceDeck: readonly ServerCard[]): Record<Seat, boolean> => ({
    bottom: isServerGoodFirstFive(getFirstFive(sourceDeck, 'bottom')),
    right: isServerGoodFirstFive(getFirstFive(sourceDeck, 'right')),
    top: isServerGoodFirstFive(getFirstFive(sourceDeck, 'top')),
    left: isServerGoodFirstFive(getFirstFive(sourceDeck, 'left')),
  })

  const isNaturalGood = evaluate(deck)
  const rescueSeats = [
    pickTeamRescueSeat(SERVER_TEAM_A_SEATS, previous, isNaturalGood, nextRandom),
    pickTeamRescueSeat(SERVER_TEAM_B_SEATS, previous, isNaturalGood, nextRandom),
  ].filter((seat): seat is Seat => seat !== null)

  // Основният тип се тегли веднъж на seat (строго 1/3) и е фиксиран за всички
  // retry-и по-долу. Цветът (1/4) / шаблонът (1/2) е предпочитан — сменя се в
  // рамките на типа само ако за него няма безопасна реализация.
  const rescueKinds: RescueKindMap = {}
  rescueSeats.forEach((seat) => {
    const type = pickServerAntiBadLuckRescueType(nextRandom)
    rescueKinds[seat] = { type, variant: pickServerAntiBadLuckRescueVariant(type, nextRandom) }
  })

  let finalDeck = deck
  let appliedRescues: RescueMap = {}

  // Безопасен план: същите 32 карти, rescued seats са GOOD и никой естествено
  // GOOD seat не губи GOOD първите си 5. Никога full reshuffle.
  const tryPlan = (rescues: RescueMap): boolean => {
    const rescueCount = Object.keys(rescues).length

    if (rescueCount <= Object.keys(appliedRescues).length) {
      return false
    }

    const rescuedDeck = applyServerAntiBadLuckRescueSwaps(deck, firstFiveIndices, rescues, nextRandom)
    const isRescuedGood = evaluate(rescuedDeck)
    const isPlanValid =
      hasSameCardSet(deck, rescuedDeck) &&
      SERVER_SEAT_ORDER.every((seat) =>
        rescues[seat] || isNaturalGood[seat] ? isRescuedGood[seat] : true,
      )

    if (isPlanValid) {
      finalDeck = rescuedDeck
      appliedRescues = rescues
    }

    return isPlanValid
  }
  const isComplete = () => Object.keys(appliedRescues).length === rescueSeats.length

  // 1) Random опити: random тройка в предпочитания цвят/шаблон (позициите — по
  //    сила на естествените карти, равенство → random).
  for (let attempt = 0; rescueSeats.length > 0 && attempt < MAX_RESCUE_PLAN_ATTEMPTS && !isComplete(); attempt += 1) {
    tryPlan(pickRescues(rescueSeats, rescueKinds, nextRandom))
  }

  // 2) Гаранция: ако съществува безопасна реализация в същите основни типове
  //    (предпочитаният цвят/шаблон първи), намери я.
  if (!isComplete()) {
    for (const rescues of enumerateRescuePlans(rescueSeats, rescueKinds, nextRandom)) {
      if (tryPlan(rescues)) {
        break
      }
    }
  }

  const isFinalGood = finalDeck === deck ? isNaturalGood : evaluate(finalDeck)
  const nextSeatState = (seat: Seat) =>
    getNextSeatState(previous.seats[seat], appliedRescues[seat] ? true : isFinalGood[seat], dealIndex)

  return {
    deck: finalDeck,
    antiBadLuck: {
      dealIndex,
      seats: {
        bottom: nextSeatState('bottom'),
        right: nextSeatState('right'),
        top: nextSeatState('top'),
        left: nextSeatState('left'),
      },
    },
    rescueKinds,
    rescues: appliedRescues,
  }
}
