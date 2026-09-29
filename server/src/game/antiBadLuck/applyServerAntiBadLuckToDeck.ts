// Прилага Anti Bad Luck върху вече разбъркания и цепнат deck, точно преди
// deal-first-3. Гледа САМО първите 5 естествени карти на всеки seat — никакъв
// резултат, bidding, profile или човек/бот.
//
// Flow:
//  1. Естествените първи 5 на всеки seat се изчисляват от позициите в deck-а
//     (симулация със същия dealServerCardsInPackets: 3 + 2 от firstDealSeat).
//  2. Rescue кандидат = pending seat (>= 5 поредни BAD), чиито естествени първи
//     5 са отново BAD. Естествен GOOD → без rescue, counter = 0.
//  3. Максимум 1 rescue на цялото раздаване (без значение от отбора): по-стар
//     pending печели, равенство → seeded random. Неизбраните остават pending
//     със стария си момент (или се нулират при естествен GOOD).
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

import { SERVER_SEAT_ORDER, type Seat } from '../../core/serverTypes.js'
import { shuffleWithRandom } from '../../core/seededRandom.js'
import { createEmptyHands } from '../createServerRoundDefaults.js'
import { dealServerCardsInPackets } from '../dealServerCardsInPackets.js'
import type { ServerCard } from '../serverGameTypes.js'
import {
  getServerAntiBadLuckKeepStrength,
  getServerAntiBadLuckNaturalAnchorSuits,
  isServerGoodFirstFive,
} from './evaluateServerFirstFiveQuality.js'
import {
  getServerAntiBadLuckRescueCandidates,
  pickServerAntiBadLuckRescue,
  pickServerAntiBadLuckRescueType,
  pickServerAntiBadLuckRescueVariant,
} from './pickServerAntiBadLuckRescue.js'
import {
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE,
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE,
  isServerAntiBadLuckSequencePlanSafe,
  type ServerAntiBadLuckSequenceAllowance,
} from './serverAntiBadLuckSequenceGuard.js'
import {
  SERVER_ANTI_BAD_LUCK_STREAK_THRESHOLD,
  createEmptyServerAntiBadLuckState,
  type ServerAntiBadLuckAnchorConstraints,
  type ServerAntiBadLuckRescue,
  type ServerAntiBadLuckRescueKind,
  type ServerAntiBadLuckSeatState,
  type ServerAntiBadLuckState,
} from './serverAntiBadLuckTypes.js'

const FIRST_FIVE_CARD_COUNT = 5
const FULL_HAND_CARD_COUNT = 8
const MAX_RESCUE_PLAN_ATTEMPTS = 16
const NO_ANCHOR_CONSTRAINTS: ServerAntiBadLuckAnchorConstraints = { naturalAnchorSuits: [] }
const NO_SEQUENCE_ALLOWANCE: ServerAntiBadLuckSequenceAllowance = {
  allowArtificialQuart: false,
  allowArtificialQuintPlus: false,
}

type RescueMap = Partial<Record<Seat, ServerAntiBadLuckRescue>>
type RescueKindMap = Partial<Record<Seat, ServerAntiBadLuckRescueKind>>
type AnchorConstraintsMap = Partial<Record<Seat, ServerAntiBadLuckAnchorConstraints>>

// Natural J (ALL_TRUMPS) / A (NO_TRUMPS) цветове от seat-овите natural първи
// 5 — runtime constraint за candidate generation, НЕ част от rescueKind.
function getAnchorConstraintsForType(
  type: ServerAntiBadLuckRescueKind['type'],
  naturalFirstFive: readonly ServerCard[],
): ServerAntiBadLuckAnchorConstraints {
  if (type === 'ALL_TRUMPS') {
    return { naturalAnchorSuits: getServerAntiBadLuckNaturalAnchorSuits(naturalFirstFive, 'J') }
  }

  if (type === 'NO_TRUMPS') {
    return { naturalAnchorSuits: getServerAntiBadLuckNaturalAnchorSuits(naturalFirstFive, 'A') }
  }

  return NO_ANCHOR_CONSTRAINTS
}

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

// Deck индексите за пълните финални 8 карти на всеки seat (3+2+3, същият
// dealServerCardsInPackets ред като deal-first-3 → deal-next-2 →
// deal-last-3). Ползва се само от sequence guard-а — не влияе на реалното
// раздаване, чисто структурна симулация върху dummy index deck.
export function getServerFullHandDeckIndicesBySeat(
  firstDealSeat: Seat,
): Record<Seat, number[]> {
  const indexDeck: ServerCard[] = Array.from({ length: FULL_HAND_CARD_COUNT * 4 }, (_, index) => ({
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
  const afterLastThree = dealServerCardsInPackets(
    afterNextTwo.remainingDeck,
    afterNextTwo.hands,
    firstDealSeat,
    3,
    1,
  )
  const toIndices = (seat: Seat) => afterLastThree.hands[seat].map((card) => Number(card.id))

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

// Опашка за единствения rescue на раздаването: pending seat-ове с естествено
// BAD първи 5; най-старият pendingSinceDealIndex печели, при равенство —
// seeded random (не seat order).
function pickRescueSeat(
  previous: ServerAntiBadLuckState,
  isNaturalGood: Record<Seat, boolean>,
  nextRandom: () => number,
): Seat | null {
  const candidates = SERVER_SEAT_ORDER.filter(
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
  anchorConstraintsBySeat: AnchorConstraintsMap,
  nextRandom: () => number,
): RescueMap {
  const rescues: RescueMap = {}
  const usedCardIds = new Set<string>()

  // Random ред, за да няма отбор с постоянно предимство при избора на тройка.
  for (const seat of shuffleWithRandom(rescueSeats, nextRandom)) {
    const kind = rescueKinds[seat] as ServerAntiBadLuckRescueKind
    const rescue = pickServerAntiBadLuckRescue(
      kind.type,
      usedCardIds,
      nextRandom,
      kind.variant,
      anchorConstraintsBySeat[seat] ?? NO_ANCHOR_CONSTRAINTS,
    )

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
  anchorConstraintsBySeat: AnchorConstraintsMap,
  nextRandom: () => number,
): Generator<RescueMap> {
  const seats = shuffleWithRandom(rescueSeats, nextRandom)
  const candidatesBySeat = new Map(
    seats.map((seat) => {
      const kind = rescueKinds[seat] as ServerAntiBadLuckRescueKind
      const candidates = getServerAntiBadLuckRescueCandidates(
        kind.type,
        anchorConstraintsBySeat[seat] ?? NO_ANCHOR_CONSTRAINTS,
      )

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

  // Sequence guard гледа пълните финални 8 карти (не само първите 5) на
  // всичките 4 seats — изместена карта може да създаде кварта/квинта при
  // seat, който изобщо не е rescued. canCheckSequences е defensive за
  // деградирали тестови/edge-case decks с < 32 карти (реалната игра винаги
  // подава пълните 32).
  const canCheckSequences = deck.length >= FULL_HAND_CARD_COUNT * 4
  const fullHandIndices = canCheckSequences ? getServerFullHandDeckIndicesBySeat(firstDealSeat) : null
  const getFullHand = (sourceDeck: readonly ServerCard[], seat: Seat) =>
    fullHandIndices![seat].map((deckIndex) => sourceDeck[deckIndex])
  const buildFullHands = (sourceDeck: readonly ServerCard[]): Record<Seat, ServerCard[]> => ({
    bottom: getFullHand(sourceDeck, 'bottom'),
    right: getFullHand(sourceDeck, 'right'),
    top: getFullHand(sourceDeck, 'top'),
    left: getFullHand(sourceDeck, 'left'),
  })
  const naturalFullHands = canCheckSequences ? buildFullHands(deck) : null

  const isNaturalGood = evaluate(deck)
  const rescueSeat = pickRescueSeat(previous, isNaturalGood, nextRandom)
  const rescueSeats: Seat[] = rescueSeat ? [rescueSeat] : []

  // Artificial-sequence allowance-ите се теглят ТОЧНО ВЕДНЪЖ на rescue
  // execution, преди candidate search-а — не се reroll-ват между candidates,
  // retry-и, suit-ове или exhaustive fallback (иначе 25%/10% биха станали
  // "25%/10% на опит", а не реална продуктова вероятност).
  const sequenceAllowance: ServerAntiBadLuckSequenceAllowance =
    rescueSeats.length > 0
      ? {
          allowArtificialQuart: nextRandom() < SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE,
          allowArtificialQuintPlus: nextRandom() < SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE,
        }
      : NO_SEQUENCE_ALLOWANCE

  // Основният тип се тегли веднъж на seat (строго 1/3) и е фиксиран за всички
  // retry-и по-долу. Цветът (1/4) / шаблонът (1/2) е предпочитан — сменя се в
  // рамките на типа само ако за него няма безопасна реализация. Anchor
  // constraints (natural J/A цветове) са runtime factи от natural deal-а —
  // изчисляват се тук и се подават на candidate generation-а по-долу, но НЕ
  // влизат в rescueKind (type/variant си остават чист random избор).
  const rescueKinds: RescueKindMap = {}
  const anchorConstraintsBySeat: AnchorConstraintsMap = {}
  rescueSeats.forEach((seat) => {
    const type = pickServerAntiBadLuckRescueType(nextRandom)
    const anchorConstraints = getAnchorConstraintsForType(type, getFirstFive(deck, seat))

    anchorConstraintsBySeat[seat] = anchorConstraints
    rescueKinds[seat] = {
      type,
      variant: pickServerAntiBadLuckRescueVariant(type, nextRandom, anchorConstraints),
    }
  })

  let finalDeck = deck
  let appliedRescues: RescueMap = {}

  // Безопасен план: същите 32 карти, rescued seats са GOOD, никой естествено
  // GOOD seat не губи GOOD първите си 5, и sequence guard-ът минава (никоя
  // естествена кварта/квинта на никой seat не е разрушена; най-много 1 нова
  // дълга поредица общо на масата, и то само ако еднократно изтегленият
  // allowance го позволява). Никога full reshuffle.
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
      ) &&
      (!canCheckSequences ||
        isServerAntiBadLuckSequencePlanSafe(naturalFullHands!, buildFullHands(rescuedDeck), sequenceAllowance))

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
    tryPlan(pickRescues(rescueSeats, rescueKinds, anchorConstraintsBySeat, nextRandom))
  }

  // 2) Гаранция: ако съществува безопасна реализация в същите основни типове
  //    (предпочитаният цвят/шаблон първи), намери я.
  if (!isComplete()) {
    for (const rescues of enumerateRescuePlans(rescueSeats, rescueKinds, anchorConstraintsBySeat, nextRandom)) {
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
