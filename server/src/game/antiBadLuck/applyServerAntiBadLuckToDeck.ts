// Прилага Anti Bad Luck върху вече разбъркания и цепнат deck, точно преди
// deal-first-3. Гледа САМО първите 5 естествени карти на всеки seat — никакъв
// резултат, bidding, profile или човек/бот.
//
// Flow:
//  1. Естествените първи 5 на всеки seat се изчисляват от позициите в deck-а
//     (симулация със същия dealServerCardsInPackets: 3 + 2 от firstDealSeat).
//  0. Admin config (виж ServerAntiBadLuckConfig): threshold 0 → целият
//     Anti Bad Luck се пропуска (deck-ът остава естественият, state-ът е
//     празен); state от по-стара resetGeneration се изхвърля (започва начисто).
//  2. Rescue кандидат = pending seat (>= threshold поредни BAD ПРЕДИ това
//     раздаване, преизчислено по ТЕКУЩИЯ праг), чиито естествени първи
//     5 са отново BAD → rescue най-рано на (threshold + 1)-вото BAD.
//     Естествен GOOD → без rescue, counter = 0.
//  3. Максимум 1 rescue на цялото раздаване (без значение от отбора): по-стар
//     pending печели, равенство → seeded random. Неизбраните остават pending
//     със стария си момент (или се нулират при естествен GOOD).
//  4. При rescue НЯМА повторно разбъркване: rescue карта, която вече е в
//     първите 5 на seat-а, остава на мястото си; всяка липсваща се swap-ва на
//     мястото на НАЙ-СЛАБАТА естествена карта от първите 5 според избрания
//     тип (getServerAntiBadLuckKeepStrength), равенство → random. Позицията
//     (first-3 / next-2) не участва. Естествената карта отива на мястото на
//     rescue картата; всички други позиции остават непокътнати.
//  5. Minimum-change planner (pickMinimumSwapRescuePlan): ВМЕСТО да се избира
//     type на сляпо и после да се опитва да се построи, enumerate-ваме
//     ВСИЧКИ concrete realized plans (enumerateServerAntiBadLuckRealizedPlans
//     — explicit, RNG-free tie enumeration, виж файла) за SUIT/ALL_TRUMPS/
//     NO_TRUMPS, валидираме всеки един (GOOD-preservation на всички 4 seats +
//     natural run preservation >=3 [терца/50/100] + sequence guard + square
//     guard), tiered по swap count (1 → 2 → 3, спираме на първия tier с >=1
//     safe plan — виж isRealizedPlanSafe/SWAP_COUNT_TIERS), и теглим type-а
//     (претеглено, SERVER_ANTI_BAD_LUCK_RESCUE_TYPE_WEIGHTS) САМО измежду
//     типовете, достигащи този минимум. Конкретният realized plan вътре в
//     избрания type се избира uniform random (seeded) измежду ВСИЧКИ safe
//     planове на този тип в tier-а. RNG се ползва ЕДИНСТВЕНО за: rescue-seat
//     tie-break, sequenceAllowance (веднъж), weighted type draw, concrete
//     plan draw — candidate enumeration/validation (вкл. rejected candidates)
//     е 0% RNG. Ако няма никакъв safe plan → естествените карти, seat-ът
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
import { enumerateServerAntiBadLuckRealizedPlans } from './enumerateServerAntiBadLuckRealizedPlans.js'
import {
  SERVER_ANTI_BAD_LUCK_RESCUE_TYPES,
  SERVER_ANTI_BAD_LUCK_RESCUE_TYPE_WEIGHTS,
  getServerAntiBadLuckRescueCandidates,
  pickServerAntiBadLuckWeightedRescueType,
} from './pickServerAntiBadLuckRescue.js'
import {
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE,
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE,
  isServerAntiBadLuckNaturalRunPreserved,
  isServerAntiBadLuckSequencePlanSafe,
  type ServerAntiBadLuckSequenceAllowance,
} from './serverAntiBadLuckSequenceGuard.js'
import { isServerAntiBadLuckSquarePlanSafe } from './serverAntiBadLuckSquareGuard.js'
import {
  SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG,
  assertServerAntiBadLuckConfig,
  createEmptyServerAntiBadLuckState,
  getServerAntiBadLuckStateResetGeneration,
  type ServerAntiBadLuckConfig,
  type ServerAntiBadLuckAnchorConstraints,
  type ServerAntiBadLuckRescue,
  type ServerAntiBadLuckRescueKind,
  type ServerAntiBadLuckSeatState,
  type ServerAntiBadLuckState,
} from './serverAntiBadLuckTypes.js'

const FIRST_FIVE_CARD_COUNT = 5
const FULL_HAND_CARD_COUNT = 8
const NO_ANCHOR_CONSTRAINTS: ServerAntiBadLuckAnchorConstraints = { naturalAnchorSuits: [] }
const NO_SEQUENCE_ALLOWANCE: ServerAntiBadLuckSequenceAllowance = {
  allowArtificialQuart: false,
  allowArtificialQuintPlus: false,
}

type RescueMap = Partial<Record<Seat, ServerAntiBadLuckRescue>>
type RescueKindMap = Partial<Record<Seat, ServerAntiBadLuckRescueKind>>

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
  // Реализираният тип/вариант САМО за seats с приложен (успешен) rescue —
  // винаги в синхрон с `rescues` (same keys). Ако никъде няма safe candidate,
  // seat-ът липсва и от двете (само за server-side тестове).
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

// Pending момент по ТЕКУЩИЯ праг, изведен от непрекъснатата серия: серия от
// `consecutiveBadDeals` BAD, завършваща в раздаване `dealIndex`, е започнала в
// dealIndex − consecutiveBadDeals + 1 и е достигнала прага в
// dealIndex − consecutiveBadDeals + threshold. При непроменен праг това е
// ТОЧНО стойността, която старият код записваше в pendingSinceDealIndex.
// При промяна на прага eligibility-то се преизчислява: увеличаване отлага,
// намаляване може да направи seat-а eligible веднага (count-ът се пази).
function getPendingSinceDealIndex(
  consecutiveBadDeals: number,
  dealIndex: number,
  threshold: number,
): number | null {
  return consecutiveBadDeals >= threshold ? dealIndex - consecutiveBadDeals + threshold : null
}

// Опашка за единствения rescue на раздаването: pending seat-ове с естествено
// BAD първи 5; най-старият pending (по текущия праг) печели, при равенство —
// seeded random (не seat order).
function pickRescueSeat(
  previous: ServerAntiBadLuckState,
  isNaturalGood: Record<Seat, boolean>,
  nextRandom: () => number,
  threshold: number,
): Seat | null {
  const pendingSince = (seat: Seat) =>
    getPendingSinceDealIndex(previous.seats[seat].consecutiveBadDeals, previous.dealIndex, threshold)
  const candidates = SERVER_SEAT_ORDER.filter(
    (seat) => pendingSince(seat) !== null && !isNaturalGood[seat],
  )

  if (candidates.length === 0) {
    return null
  }

  const oldestPending = Math.min(
    ...candidates.map((seat) => pendingSince(seat) as number),
  )
  const oldestCandidates = candidates.filter(
    (seat) => pendingSince(seat) === oldestPending,
  )

  return oldestCandidates.length === 1
    ? oldestCandidates[0]
    : shuffleWithRandom(oldestCandidates, nextRandom)[0]
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

type MinimumSwapCandidate = {
  rescue: ServerAntiBadLuckRescue
  swapCount: number
  resultDeck: ServerCard[]
}

// Проверява дали `resultDeck` е безопасен краен resultDeck: deck invariant +
// GOOD-preservation на всичките 4 seats + natural run preservation
// (терца/50/100, >=3) + sequence guard (artificial QUART/QUINT_PLUS, >=4,
// 25%/10% allowance) + square guard. Изцяло RNG-free — resultDeck вече е
// конкретен, напълно детерминиран final deck (виж
// enumerateServerAntiBadLuckRealizedPlans), не candidate description.
function isRealizedPlanSafe(
  deck: readonly ServerCard[],
  resultDeck: readonly ServerCard[],
  seat: Seat,
  getFirstFiveOf: (sourceDeck: readonly ServerCard[], checkSeat: Seat) => ServerCard[],
  isNaturalGood: Record<Seat, boolean>,
  naturalFullHands: Record<Seat, ServerCard[]> | null,
  buildFullHands: (sourceDeck: readonly ServerCard[]) => Record<Seat, ServerCard[]>,
  sequenceAllowance: ServerAntiBadLuckSequenceAllowance,
): boolean {
  if (!hasSameCardSet(deck, resultDeck)) {
    return false
  }

  if (!isServerGoodFirstFive(getFirstFiveOf(resultDeck, seat))) {
    return false
  }

  const othersStillGood = SERVER_SEAT_ORDER.every(
    (otherSeat) =>
      otherSeat === seat || !isNaturalGood[otherSeat] || isServerGoodFirstFive(getFirstFiveOf(resultDeck, otherSeat)),
  )

  if (!othersStillGood) {
    return false
  }

  if (!naturalFullHands) {
    return true
  }

  const resultFullHands = buildFullHands(resultDeck)

  return (
    isServerAntiBadLuckNaturalRunPreserved(naturalFullHands, resultFullHands) &&
    isServerAntiBadLuckSequencePlanSafe(naturalFullHands, resultFullHands, sequenceAllowance) &&
    isServerAntiBadLuckSquarePlanSafe(naturalFullHands, resultFullHands)
  )
}

const SWAP_COUNT_TIERS = [1, 2, 3] as const

// Minimum-change planner — изцяло RNG-free enumeration/validation, tiered по
// swap count за performance:
//  1. За трите типа (SUIT/ALL_TRUMPS/NO_TRUMPS) enumerate-ваме ВСИЧКИ abstract
//     candidates (getServerAntiBadLuckRescueCandidates) и смятаме swapCount-а
//     им чисто (cardIds срещу natural first five) — 0 RNG.
//  2. Tier 1 (swapCount=1): enumerate-ваме ВСИЧКИ concrete realized plans
//     (enumerateServerAntiBadLuckRealizedPlans — explicit tie enumeration,
//     0 RNG) за candidates от трите типа, валидираме ги (isRealizedPlanSafe).
//     Ако поне един е safe → глобалният минимум е 1, Tier 2/3 изобщо не се
//     разглеждат (нито enumeration, нито validation).
//  3. Иначе Tier 2, после Tier 3 — само ако предходният tier няма safe plan.
//  4. Типът се тегли претеглено (SERVER_ANTI_BAD_LUCK_RESCUE_TYPE_WEIGHTS)
//     САМО измежду типовете с >=1 safe plan в намерения минимален tier;
//     candidate count никога не участва в това тегло. Конкретният realized
//     plan вътре в избрания тип — uniform random измежду ВСИЧКИ safe
//     realized plans на този тип в tier-а (не допълнителен TRIPLE/PAIR_PLUS
//     слой) — без RNG draw, ако pool-ът има точно 1 план.
// null, ако и трите tier-а нямат safe plan никъде (seat остава pending).
function pickMinimumSwapRescuePlan(
  seat: Seat,
  deck: readonly ServerCard[],
  firstFiveIndices: Record<Seat, number[]>,
  isNaturalGood: Record<Seat, boolean>,
  naturalFullHands: Record<Seat, ServerCard[]> | null,
  buildFullHands: (sourceDeck: readonly ServerCard[]) => Record<Seat, ServerCard[]>,
  sequenceAllowance: ServerAntiBadLuckSequenceAllowance,
  nextRandom: () => number,
): { rescue: ServerAntiBadLuckRescue; deck: ServerCard[] } | null {
  const getFirstFiveOf = (sourceDeck: readonly ServerCard[], checkSeat: Seat) =>
    firstFiveIndices[checkSeat].map((index) => sourceDeck[index])
  const naturalFirstFive = getFirstFiveOf(deck, seat)
  const naturalIds = new Set(naturalFirstFive.map((card) => card.id))

  // Стъпка 1: ЧИСТО (RNG-free) изчисляване на swapCount за всеки abstract
  // candidate на трите типа — групирани по тип, за да може Tier loop-ът
  // по-долу да ги филтрира по swapCount без да ги regenerate-ва.
  const candidatesByType: Record<ServerAntiBadLuckRescue['type'], Array<{ rescue: ServerAntiBadLuckRescue; swapCount: number }>> = {
    SUIT: [],
    ALL_TRUMPS: [],
    NO_TRUMPS: [],
  }

  for (const type of SERVER_ANTI_BAD_LUCK_RESCUE_TYPES) {
    const anchorConstraints = getAnchorConstraintsForType(type, naturalFirstFive)

    for (const rescue of getServerAntiBadLuckRescueCandidates(type, anchorConstraints)) {
      const swapCount = rescue.cardIds.filter((cardId) => !naturalIds.has(cardId)).length

      // Defensive invariant: seat-ът тук е ВИНАГИ natural BAD (pickRescueSeat
      // филтрира само !isNaturalGood seats). candidate.cardIds описва ТОЧНО
      // критерия, по който isServerGoodFirstFive определя GOOD за този тип
      // (същите SERVER_ANTI_BAD_LUCK_* константи). Ако всичките 3 карти вече
      // са в естествените първи 5 (swapCount 0), естественият first-5 би
      // трябвало вече да е GOOD по този тип — противоречие с BAD
      // предусловието. Fail-fast вместо тих грешен rescue.
      if (swapCount === 0) {
        throw new Error(
          `[anti-bad-luck] invariant violated: 0-swap rescue candidate (type=${type}) за natural BAD seat ${seat} — ` +
            'candidate-ът вече прави естествения first-5 GOOD, което противоречи на BAD предусловието',
        )
      }

      candidatesByType[type].push({ rescue, swapCount })
    }
  }

  const safeByType: Record<ServerAntiBadLuckRescue['type'], MinimumSwapCandidate[]> = {
    SUIT: [],
    ALL_TRUMPS: [],
    NO_TRUMPS: [],
  }
  const seenResultDeckKeysByType: Record<ServerAntiBadLuckRescue['type'], Set<string>> = {
    SUIT: new Set(),
    ALL_TRUMPS: new Set(),
    NO_TRUMPS: new Set(),
  }

  for (const tier of SWAP_COUNT_TIERS) {
    let foundSafePlanAtThisTier = false

    for (const type of SERVER_ANTI_BAD_LUCK_RESCUE_TYPES) {
      for (const { rescue, swapCount } of candidatesByType[type]) {
        if (swapCount !== tier) {
          continue
        }

        for (const realizedPlan of enumerateServerAntiBadLuckRealizedPlans(deck, seat, firstFiveIndices, rescue)) {
          if (!isRealizedPlanSafe(deck, realizedPlan.resultDeck, seat, getFirstFiveOf, isNaturalGood, naturalFullHands, buildFullHands, sequenceAllowance)) {
            continue
          }

          // Canonicalize/dedupe: различни target-set/assignment избори могат
          // да доведат до идентичен final deck (напр. всички "donor" позиции
          // в същия друг seat) — вече dedupe-нато вътре в enumerate-функцията
          // за ЕДИН candidate; тук пазим defensive dedupe и между РАЗЛИЧНИ
          // candidates на СЪЩИЯ тип (структурно не би трябвало да се случи,
          // защото различни cardIds сетове винаги дават различен final deck
          // first-five, но пазим инварианта explicit).
          const key = realizedPlan.resultDeck.map((card) => card.id).join(',')

          if (seenResultDeckKeysByType[type].has(key)) {
            continue
          }

          seenResultDeckKeysByType[type].add(key)
          safeByType[type].push({ rescue, swapCount, resultDeck: realizedPlan.resultDeck })
          foundSafePlanAtThisTier = true
        }
      }
    }

    if (foundSafePlanAtThisTier) {
      break
    }
  }

  const eligibleTypes = SERVER_ANTI_BAD_LUCK_RESCUE_TYPES.filter((type) => safeByType[type].length > 0)

  if (eligibleTypes.length === 0) {
    return null
  }

  const chosenType = pickServerAntiBadLuckWeightedRescueType(
    eligibleTypes,
    SERVER_ANTI_BAD_LUCK_RESCUE_TYPE_WEIGHTS,
    nextRandom,
  )
  const pool = safeByType[chosenType]
  // Uniform selection над ВСИЧКИ safe concrete realized plans на избрания
  // тип (не допълнителен TRIPLE/PAIR_PLUS 50/50 слой — виж header коментара).
  // Без RNG draw, ако има точно 1 план (документирана оптимизация, виж [16]
  // тестовете в checkAntiBadLuck.ts).
  const chosen = pool.length === 1 ? pool[0]! : pool[Math.floor(nextRandom() * pool.length)]!

  return { rescue: chosen.rescue, deck: chosen.resultDeck }
}

function getNextSeatState(
  previousSeatState: ServerAntiBadLuckSeatState,
  isGood: boolean,
  dealIndex: number,
  threshold: number,
): ServerAntiBadLuckSeatState {
  if (isGood) {
    return { consecutiveBadDeals: 0, pendingSinceDealIndex: null }
  }

  const consecutiveBadDeals = previousSeatState.consecutiveBadDeals + 1

  return {
    consecutiveBadDeals,
    pendingSinceDealIndex: getPendingSinceDealIndex(consecutiveBadDeals, dealIndex, threshold),
  }
}

function createEmptyStateForGeneration(resetGeneration: number): ServerAntiBadLuckState {
  return { ...createEmptyServerAntiBadLuckState(), resetGeneration }
}

// `config` default-ът (праг 5) е САМО за ниски тестови/диагностични
// извиквания — production пътят (dealServerFirstThreePhase) винаги подава
// explicit admin config, без fallback.
export function applyServerAntiBadLuckToDeck(
  deck: ServerCard[],
  firstDealSeat: Seat,
  previousState: ServerAntiBadLuckState | undefined,
  nextRandom: () => number = Math.random,
  config: ServerAntiBadLuckConfig = SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG,
): ServerAntiBadLuckDealResult {
  assertServerAntiBadLuckConfig(config, 'applyServerAntiBadLuckToDeck')

  // Праг 0: Anti Bad Luck е напълно изключен — естественият (разбъркан и
  // цепнат) deck се връща НЕПОКЪТНАТ (същата референция), без nextRandom
  // извикване, без rescue, и state-ът се изчиства (нищо не се натрупва,
  // нищо не остава „замразено“ за по-късно).
  if (config.threshold === 0) {
    return { deck, antiBadLuck: createEmptyStateForGeneration(config.resetGeneration), rescueKinds: {}, rescues: {} }
  }

  // State, изчислен преди последното admin превключване към 0 (по-стара
  // resetGeneration), се изхвърля — 0 → X и бързо X → 0 → X без раздаване
  // между тях започват начисто, без retroactive rescue.
  const previous =
    previousState !== undefined && getServerAntiBadLuckStateResetGeneration(previousState) === config.resetGeneration
      ? previousState
      : createEmptyStateForGeneration(config.resetGeneration)
  const threshold = config.threshold

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

  // Sequence и square guard-овете гледат пълните финални 8 карти (не само
  // първите 5) на всичките 4 seats — изместена карта може да създаде
  // кварта/квинта/каре при seat, който изобщо не е rescued.
  // canCheckFullHands е defensive за деградирали тестови/edge-case decks с
  // < 32 карти (реалната игра винаги подава пълните 32).
  const canCheckFullHands = deck.length >= FULL_HAND_CARD_COUNT * 4
  const fullHandIndices = canCheckFullHands ? getServerFullHandDeckIndicesBySeat(firstDealSeat) : null
  const getFullHand = (sourceDeck: readonly ServerCard[], seat: Seat) =>
    fullHandIndices![seat].map((deckIndex) => sourceDeck[deckIndex])
  const buildFullHands = (sourceDeck: readonly ServerCard[]): Record<Seat, ServerCard[]> => ({
    bottom: getFullHand(sourceDeck, 'bottom'),
    right: getFullHand(sourceDeck, 'right'),
    top: getFullHand(sourceDeck, 'top'),
    left: getFullHand(sourceDeck, 'left'),
  })
  const naturalFullHands = canCheckFullHands ? buildFullHands(deck) : null

  const isNaturalGood = evaluate(deck)
  const rescueSeat = pickRescueSeat(previous, isNaturalGood, nextRandom, threshold)
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

  // Minimum-change planner: enumerate → validate (GOOD + natural run +
  // sequence + square) → глобален минимален swap count → претеглен избор на
  // тип измежду eligible типовете → seeded избор на конкретен candidate.
  // rescueSeats има най-много 1 елемент (pickRescueSeat никога не връща
  // повече от 1 seat за раздаване), затова няма multi-seat conflict logic.
  const rescueKinds: RescueKindMap = {}
  let finalDeck = deck
  let appliedRescues: RescueMap = {}

  if (rescueSeat) {
    const plan = pickMinimumSwapRescuePlan(
      rescueSeat,
      deck,
      firstFiveIndices,
      isNaturalGood,
      naturalFullHands,
      buildFullHands,
      sequenceAllowance,
      nextRandom,
    )

    if (plan) {
      finalDeck = plan.deck
      appliedRescues = { [rescueSeat]: plan.rescue }
      rescueKinds[rescueSeat] = { type: plan.rescue.type, variant: plan.rescue.variant }
    }
  }

  const isFinalGood = finalDeck === deck ? isNaturalGood : evaluate(finalDeck)
  const nextSeatState = (seat: Seat) =>
    getNextSeatState(previous.seats[seat], appliedRescues[seat] ? true : isFinalGood[seat], dealIndex, threshold)

  return {
    deck: finalDeck,
    antiBadLuck: {
      resetGeneration: config.resetGeneration,
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
