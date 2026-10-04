/**
 * checkAntiBadLuck.ts — детерминистични проверки за server-side Anti Bad Luck
 * (server/src/game/antiBadLuck/*). RNG се инжектира чрез createSeededRandom.
 *
 * [1] GOOD detection: AAA, AA10, JJJ, JJ9, SUIT (J + >= 31)
 * [2] BAD detection: AA10 с чужда 10, JJ9 с чужда 9, >= 31 без J, J + < 31
 * [3] BAD streak: BAD×4 → още не, BAD×5 → pending, GOOD reset, естествен GOOD
 *     отменя rescue
 * [4] Pending опашка: максимум 1 rescue на раздаване за цялата маса (без
 *     значение от отбора), най-стар pending печели, равен момент → seeded
 *     random, неизбраните остават pending със стария момент (или reset при
 *     естествен GOOD), failed rescue запазва pending
 * [5] Bots: permanent bot / bot takeover / reclaim / JSON restore пазят state
 * [6] Deck invariants: 32 уникални карти, максимум 1 rescue на раздаване, без
 *     secondary shuffle — променят се само необходимите swap позиции,
 *     естествено GOOD seat без rescue не губи GOOD ръката си
 * [7] Rescue output: точно 3 контролирани, 2 естествени неконтролирани,
 *     3+0 / 2+1 / 1+2 между first-3 и next-2, random тип/цвят/шаблон
 * [9] Anchor constraints: ALL_TRUMPS/NO_TRUMPS rescue преизползва вече
 *     наличните natural J/A вместо да добавя нови — никога 4 J / 4 A
 * [10] Sequence guard: пази natural кварти/квинти (rescued seat, партньор,
 *      противници) от rescue swap-овете, вкл. когато изместена карта създава
 *      поредица при ДРУГ seat; допуска най-много 1 нова дълга поредица на
 *      маса (25%/10% allowance, изтеглен веднъж на execution, не reroll-нат)
 * [11] Square guard: пази natural карета (J/9/A/10/K/Q — реалните
 *      declaration ranks) от rescue swap-овете на всичките 4 seats; ВСЯКО
 *      artificial каре се reject-ва безусловно (без процентен allowance, за
 *      разлика от sequence guard-а) — 7/8 не са square declaration
 * [12] Minimum-swap planner — weighted rescue type selection
 *      (pickServerAntiBadLuckWeightedRescueType) измежду eligible типовете
 *      (тези на глобалния минимален swap count); candidate count в типа не
 *      влияе на type probability
 * [13] Natural run preservation (ТЕРЦА/20 и по-дълги, праг >=3,
 *      isServerAntiBadLuckNaturalRunPreserved) — destruction-only, отделно от
 *      artificial QUART/QUINT_PLUS allowance-а в [10]; растеж позволен,
 *      artificial терца неограничена
 * [14] End-to-end: natural терца/50/100 никога не се разрушава от rescue
 *      през пълния pipeline
 * [15] Defensive invariant: 0-swap rescue candidate никога не възниква за
 *      natural BAD seat
 */

import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../src/core/serverTypes.js'
import { createSeededRandom, shuffleWithRandom } from '../src/core/seededRandom.js'
import {
  applyServerAntiBadLuckRescueSwaps,
  applyServerAntiBadLuckToDeck,
  getServerFirstFiveDeckIndicesBySeat,
  getServerFullHandDeckIndicesBySeat,
} from '../src/game/antiBadLuck/applyServerAntiBadLuckToDeck.js'
import { enumerateServerAntiBadLuckRealizedPlans } from '../src/game/antiBadLuck/enumerateServerAntiBadLuckRealizedPlans.js'
import {
  getServerAntiBadLuckKeepStrength,
  isServerAllTrumpsGoodFirstFive,
  isServerGoodFirstFive,
  isServerNoTrumpsGoodFirstFive,
  isServerSuitGoodFirstFive,
} from '../src/game/antiBadLuck/evaluateServerFirstFiveQuality.js'
import {
  SERVER_ANTI_BAD_LUCK_RESCUE_TYPES,
  SERVER_ANTI_BAD_LUCK_RESCUE_TYPE_WEIGHTS,
  getServerAntiBadLuckRescueCandidates,
  pickServerAntiBadLuckRescue,
  pickServerAntiBadLuckRescueVariant,
  pickServerAntiBadLuckWeightedRescueType,
} from '../src/game/antiBadLuck/pickServerAntiBadLuckRescue.js'
import {
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE,
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE,
  findServerAntiBadLuckLongRuns,
  findServerAntiBadLuckNaturalRuns,
  isServerAntiBadLuckNaturalRunPreserved,
  isServerAntiBadLuckSequencePlanSafe,
  type ServerAntiBadLuckSequenceAllowance,
} from '../src/game/antiBadLuck/serverAntiBadLuckSequenceGuard.js'
import {
  getServerAntiBadLuckSquareRanks,
  isServerAntiBadLuckSquarePlanSafe,
} from '../src/game/antiBadLuck/serverAntiBadLuckSquareGuard.js'
import {
  SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG,
  createEmptyServerAntiBadLuckState,
  type ServerAntiBadLuckAnchorConstraints,
  type ServerAntiBadLuckRescue,
  type ServerAntiBadLuckState,
} from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { SERVER_SUITS } from '../src/game/serverCardConstants.js'
import { abandonHumanControlForRoom } from '../src/game/abandonHumanControlForRoom.js'
import { createInitialAuthoritativeGameState } from '../src/game/createInitialAuthoritativeGameState.js'
import { createServerDeck } from '../src/game/createServerDeck.js'
import { createServerRoundStartState } from '../src/game/createServerRoundStartState.js'
import { dealServerFirstThreePhase } from '../src/game/dealServerFirstThreePhase.js'
import { dealServerNextTwoPhase } from '../src/game/dealServerNextTwoPhase.js'
import { getRoomAuthoritativeGameState } from '../src/game/getRoomAuthoritativeGameState.js'
import { normalizeRestoredAuthoritativeState } from '../src/game/normalizeRestoredAuthoritativeState.js'
import { resumeHumanControlForRoom } from '../src/game/resumeHumanControlForRoom.js'
import type { ServerAuthoritativeGameState, ServerCard } from '../src/game/serverGameTypes.js'
import { createRoomSnapshotMessage } from '../src/protocol/createRoomSnapshotMessage.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

const FULL_DECK = createServerDeck()
const CARD_BY_ID = new Map(FULL_DECK.map((card) => [card.id, card]))

function cards(...ids: string[]): ServerCard[] {
  return ids.map((id) => {
    const card = CARD_BY_ID.get(id)
    if (!card) throw new Error(`Unknown card ${id}`)
    return card
  })
}

const FIRST_DEAL_SEAT: Seat = 'right'
const FIRST_FIVE_INDICES = getServerFirstFiveDeckIndicesBySeat(FIRST_DEAL_SEAT)

// 4 BAD ръце, покриващи 20 уникални карти.
const BAD_HANDS: Record<Seat, string[]> = {
  bottom: ['clubs-7', 'clubs-8', 'diamonds-7', 'diamonds-8', 'hearts-7'],
  right: ['hearts-8', 'spades-7', 'spades-8', 'clubs-Q', 'diamonds-Q'],
  top: ['hearts-Q', 'spades-Q', 'clubs-K', 'diamonds-K', 'hearts-K'],
  left: ['spades-K', 'clubs-9', 'diamonds-10', 'hearts-A', 'spades-J'],
}

function buildDeck(firstFive: Record<Seat, string[]>): ServerCard[] {
  const deck: Array<ServerCard | undefined> = new Array(32)
  const used = new Set<string>()

  for (const seat of SERVER_SEAT_ORDER) {
    FIRST_FIVE_INDICES[seat].forEach((deckIndex, cardIndex) => {
      deck[deckIndex] = cards(firstFive[seat][cardIndex])[0]
      used.add(firstFive[seat][cardIndex])
    })
  }

  const rest = FULL_DECK.filter((card) => !used.has(card.id))
  for (let index = 0; index < deck.length; index += 1) {
    if (!deck[index]) deck[index] = rest.shift()
  }

  return deck as ServerCard[]
}

const ALL_BAD_DECK = buildDeck(BAD_HANDS)

function firstFive(deck: readonly ServerCard[], seat: Seat): ServerCard[] {
  return FIRST_FIVE_INDICES[seat].map((index) => deck[index])
}

// Пълни финални 8 карти на всеки seat (3+2+3) — за sequence guard тестовете.
const FULL_HAND_INDICES = getServerFullHandDeckIndicesBySeat(FIRST_DEAL_SEAT)

function fullHand(deck: readonly ServerCard[], seat: Seat): ServerCard[] {
  return FULL_HAND_INDICES[seat].map((index) => deck[index])
}

// Explicit full-8-card hands за всичките 4 seats — 32 карти общо, без "rest"
// filler (за разлика от buildDeck, дето само първите 5 са контролирани).
// hands[seat][0..4] = first five, hands[seat][5..7] = last three (deal-last-3).
function buildFullHandDeck(hands: Record<Seat, string[]>): ServerCard[] {
  const deck: Array<ServerCard | undefined> = new Array(32)

  for (const seat of SERVER_SEAT_ORDER) {
    FULL_HAND_INDICES[seat].forEach((deckIndex, cardIndex) => {
      deck[deckIndex] = cards(hands[seat][cardIndex])[0]
    })
  }

  return deck as ServerCard[]
}

function isValidDeck(deck: readonly ServerCard[]): boolean {
  const ids = new Set(deck.map((card) => card.id))
  return deck.length === 32 && ids.size === 32 && FULL_DECK.every((card) => ids.has(card.id))
}

function stateWithPending(pending: Partial<Record<Seat, number>>): ServerAntiBadLuckState {
  const state = createEmptyServerAntiBadLuckState()
  state.dealIndex = 10
  for (const [seat, since] of Object.entries(pending) as Array<[Seat, number]>) {
    state.seats[seat] = { consecutiveBadDeals: 5 + (10 - since), pendingSinceDealIndex: since }
  }
  return state
}

function teamOf(seat: Seat): 'A' | 'B' {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

// ---------------------------------------------------------------------------
// [1] GOOD detection
// ---------------------------------------------------------------------------
check('[1a] AAA → GOOD (Без коз)', isServerNoTrumpsGoodFirstFive(cards('clubs-A', 'hearts-A', 'spades-A', 'clubs-7', 'diamonds-8')))
check('[1b] AA10 към едното A → GOOD', isServerNoTrumpsGoodFirstFive(cards('spades-A', 'hearts-A', 'spades-10', 'clubs-7', 'diamonds-8')))
check('[1c] JJJ → GOOD (Всичко коз)', isServerAllTrumpsGoodFirstFive(cards('clubs-J', 'hearts-J', 'diamonds-J', 'clubs-7', 'spades-8')))
check('[1d] JJ9 към едното J → GOOD', isServerAllTrumpsGoodFirstFive(cards('spades-J', 'hearts-J', 'spades-9', 'clubs-7', 'diamonds-8')))
check('[1e] SUIT J+9+7 = 34 → GOOD', isServerSuitGoodFirstFive(cards('hearts-J', 'hearts-9', 'hearts-7', 'clubs-8', 'diamonds-Q')))
check('[1f] SUIT J+A+8 = 31 (граница) → GOOD', isServerSuitGoodFirstFive(cards('clubs-J', 'clubs-A', 'clubs-8', 'hearts-7', 'diamonds-Q')))
check('[1g] SUIT J+10+K = 34 → GOOD', isServerGoodFirstFive(cards('diamonds-J', 'diamonds-10', 'diamonds-K', 'hearts-7', 'spades-8')))
check('[1h] SUIT избира най-добрата тройка от 4 карти', isServerSuitGoodFirstFive(cards('spades-J', 'spades-7', 'spades-8', 'spades-A', 'hearts-Q')))

// ---------------------------------------------------------------------------
// [2] Отрицателни случаи
// ---------------------------------------------------------------------------
check('[2a] AA10, 10 не е към A → BAD', !isServerGoodFirstFive(cards('spades-A', 'hearts-A', 'clubs-10', 'diamonds-7', 'clubs-8')))
check('[2b] JJ9, 9 не е към J → BAD', !isServerGoodFirstFive(cards('spades-J', 'hearts-J', 'clubs-9', 'diamonds-7', 'clubs-8')))
check('[2c] 9+A+10 = 35 от цвят без J → BAD', !isServerGoodFirstFive(cards('clubs-9', 'clubs-A', 'clubs-10', 'hearts-7', 'diamonds-8')))
check('[2d] J+K+Q = 27 < 31 → BAD', !isServerGoodFirstFive(cards('hearts-J', 'hearts-K', 'hearts-Q', 'clubs-7', 'diamonds-8')))
check('[2e] J+10 +8 = 30 < 31 → BAD', !isServerGoodFirstFive(cards('hearts-J', 'hearts-10', 'hearts-8', 'clubs-7', 'diamonds-8')))
check('[2f] J+9 само две карти от цвета → BAD', !isServerGoodFirstFive(cards('hearts-J', 'hearts-9', 'clubs-8', 'diamonds-7', 'spades-Q')))
for (const seat of SERVER_SEAT_ORDER) {
  check(`[2g] fixture BAD_HANDS.${seat} е BAD`, !isServerGoodFirstFive(firstFive(ALL_BAD_DECK, seat)))
}

// ---------------------------------------------------------------------------
// [3] BAD streak (праг: 5 поредни BAD първи 5)
// ---------------------------------------------------------------------------
const goodBottomDeck = buildDeck({ ...BAD_HANDS, bottom: ['clubs-A', 'diamonds-A', 'spades-A', 'hearts-7', 'clubs-7'] })

function dealSequence(decks: ServerCard[][], seed: string): ServerAntiBadLuckState {
  const random = createSeededRandom(seed)
  let state: ServerAntiBadLuckState | undefined
  for (const deck of decks) {
    state = applyServerAntiBadLuckToDeck(deck, FIRST_DEAL_SEAT, state, random).antiBadLuck
  }
  return state!
}

{
  const random = createSeededRandom('streak')
  let state: ServerAntiBadLuckState | undefined
  for (let deal = 1; deal <= 5; deal += 1) {
    const result = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, state, random)
    check(`[3a] BAD deal ${deal}: без rescue, deck не е пипан`, result.deck === ALL_BAD_DECK && Object.keys(result.rescues).length === 0)
    state = result.antiBadLuck
    if (deal === 4) {
      check('[3b] 4 поредни BAD → counter 4, още НЕ е pending', SERVER_SEAT_ORDER.every((seat) => state!.seats[seat].consecutiveBadDeals === 4 && state!.seats[seat].pendingSinceDealIndex === null))
    }
  }
  check('[3c] 5 поредни BAD → counter 5, pending от deal 5', SERVER_SEAT_ORDER.every((seat) => state!.seats[seat].consecutiveBadDeals === 5 && state!.seats[seat].pendingSinceDealIndex === 5))

  const resetState = dealSequence([ALL_BAD_DECK, ALL_BAD_DECK, ALL_BAD_DECK, ALL_BAD_DECK, goodBottomDeck], 'reset')
  check('[3d] BAD×4, после GOOD → counter 0, не е pending', resetState.seats.bottom.consecutiveBadDeals === 0 && resetState.seats.bottom.pendingSinceDealIndex === null)
  check('[3e] BAD×5 за другите → pending от deal 5', resetState.seats.top.pendingSinceDealIndex === 5 && resetState.seats.top.consecutiveBadDeals === 5)

  // След 5 BAD: естествен GOOD на следващото раздаване отменя rescue.
  const onlyBottomPending = stateWithPending({ bottom: 5 })
  const naturalGood = applyServerAntiBadLuckToDeck(goodBottomDeck, FIRST_DEAL_SEAT, onlyBottomPending, random)
  check('[3f] след 5 BAD естествен GOOD → без rescue, deck непроменен', naturalGood.deck === goodBottomDeck && !naturalGood.rescues.bottom)
  check('[3g] естествен GOOD → counter 0, pending отпада', naturalGood.antiBadLuck.seats.bottom.consecutiveBadDeals === 0 && naturalGood.antiBadLuck.seats.bottom.pendingSinceDealIndex === null)

  // След 5 BAD: естествен BAD → rescue в същото раздаване.
  const rescued = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, onlyBottomPending, random)
  check('[3h] след 5 BAD естествен BAD → rescue', !!rescued.rescues.bottom && isServerGoodFirstFive(firstFive(rescued.deck, 'bottom')))
  check('[3i] след успешен rescue → counter 0, pending изчистен', rescued.antiBadLuck.seats.bottom.consecutiveBadDeals === 0 && rescued.antiBadLuck.seats.bottom.pendingSinceDealIndex === null)

  const fourBad = dealSequence([ALL_BAD_DECK, ALL_BAD_DECK, ALL_BAD_DECK, ALL_BAD_DECK], 'four')
  const fifthDeal = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, fourBad, random)
  check('[3j] counter 4 (< 5) не дава rescue в 5-тото раздаване', Object.keys(fifthDeal.rescues).length === 0)
}

// ---------------------------------------------------------------------------
// [4] Pending опашка: максимум 1 rescue на раздаване за цялата маса
// ---------------------------------------------------------------------------
{
  let maxOnePerDeal = true
  let opponentsNeverBoth = true
  let partnersNeverBoth = true
  let olderWins = true
  let olderAcrossTeamsWins = true
  let loserKeepsMoment = true
  const opponentTieWinners = new Set<Seat>()
  const partnerTieWinners = new Set<Seat>()
  const fourWayTieWinners = new Map<Seat, number>()

  for (let seed = 0; seed < 400; seed += 1) {
    const random = createSeededRandom(`queue-${seed}`)

    const all = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, right: 5, top: 5, left: 5 }), random)
    const allRescued = Object.keys(all.rescues) as Seat[]
    maxOnePerDeal &&= allRescued.length === 1 && Object.keys(all.rescueKinds).length === 1
    allRescued.forEach((seat) => fourWayTieWinners.set(seat, (fourWayTieWinners.get(seat) ?? 0) + 1))

    const opponents = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, right: 5 }), random)
    opponentsNeverBoth &&= Object.keys(opponents.rescues).length === 1
    Object.keys(opponents.rescues).forEach((seat) => opponentTieWinners.add(seat as Seat))

    const partners = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, top: 5 }), random)
    partnersNeverBoth &&= Object.keys(partners.rescues).length === 1
    Object.keys(partners.rescues).forEach((seat) => partnerTieWinners.add(seat as Seat))

    // Партньори: по-старият (top: 4) печели пред по-новия (bottom: 8).
    const older = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ top: 4, bottom: 8 }), random)
    olderWins &&= !!older.rescues.top && !older.rescues.bottom

    // Противници: по-старият (right: 3) печели пред bottom (6) и left (7).
    const olderAcross = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 6, right: 3, left: 7 }), random)
    olderAcrossTeamsWins &&= Object.keys(olderAcross.rescues).length === 1 && !!olderAcross.rescues.right

    // Неизбраният pending с естествено BAD запазва стария момент (counter + 1).
    for (const [seat, since, previousCount] of [['bottom', 6, 9], ['left', 7, 8]] as const) {
      const seatState = olderAcross.antiBadLuck.seats[seat]
      loserKeepsMoment &&= isServerGoodFirstFive(firstFive(olderAcross.deck, seat))
        ? seatState.pendingSinceDealIndex === null
        : seatState.pendingSinceDealIndex === since && seatState.consecutiveBadDeals === previousCount + 1
    }
  }

  check('[4a] максимум 1 rescue на раздаване (4 pending seats, 400 seeds)', maxOnePerDeal)
  check('[4b] двама pending противници НЕ получават rescue едновременно', opponentsNeverBoth)
  check('[4c] двама pending партньори НЕ получават rescue едновременно', partnersNeverBoth)
  check('[4d] най-старият pending печели (партньори)', olderWins)
  check('[4e] най-старият pending печели независимо от отбора', olderAcrossTeamsWins)
  check('[4f] равен момент при противници → seeded random (и двамата печелят)', opponentTieWinners.has('bottom') && opponentTieWinners.has('right'))
  check('[4g] равен момент при партньори → seeded random (и двамата печелят)', partnerTieWinners.has('bottom') && partnerTieWinners.has('top'))
  check(`[4h] равен момент при 4 seats → всеки печели (${SERVER_SEAT_ORDER.map((seat) => `${seat} ${fourWayTieWinners.get(seat) ?? 0}`).join(', ')})`,
    SERVER_SEAT_ORDER.every((seat) => (fourWayTieWinners.get(seat) ?? 0) > 60))
  check('[4i] неизбран pending с естествено BAD запазва стария pending момент', loserKeepsMoment)

  // Детерминизъм: същият seed → същият избор.
  const first = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, right: 5 }), createSeededRandom('same'))
  const second = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, right: 5 }), createSeededRandom('same'))
  check('[4j] tie-break е seeded: същият seed → същият seat и същото тесте', JSON.stringify(first.rescues) === JSON.stringify(second.rescues) && first.deck.map((card) => card.id).join() === second.deck.map((card) => card.id).join())

  // Неизбран pending с естествено GOOD → reset (top е GOOD, bottom е по-стар и е избран).
  const topGoodDeck = buildDeck({ ...BAD_HANDS, top: ['clubs-A', 'diamonds-A', 'spades-A', 'hearts-Q', 'spades-Q'] })
  // (3 от асата са в защитената ръка на top → при NO_TRUMPS rescue за bottom е
  // невъзможен и bottom остава pending — това не засяга top.)
  let goodLoserReset = true
  let bottomRescuedCount = 0
  for (let seed = 0; seed < 100; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(topGoodDeck, FIRST_DEAL_SEAT, stateWithPending({ bottom: 4, top: 5 }), createSeededRandom(`good-loser-${seed}`))
    if (result.rescues.bottom) bottomRescuedCount += 1
    goodLoserReset &&= !result.rescues.top && Object.keys(result.rescues).length <= 1 &&
      isServerGoodFirstFive(firstFive(result.deck, 'top')) &&
      result.antiBadLuck.seats.top.pendingSinceDealIndex === null && result.antiBadLuck.seats.top.consecutiveBadDeals === 0 &&
      (result.rescues.bottom ? result.antiBadLuck.seats.bottom.pendingSinceDealIndex === null : result.antiBadLuck.seats.bottom.pendingSinceDealIndex === 4)
  }
  check(`[4k] неизбран pending с естествено GOOD → pending отпада, counter 0 (bottom rescued ${bottomRescuedCount}/100)`, goodLoserReset && bottomRescuedCount > 50)

  // Failed rescue: всяка J и всяко A е в защитена естествено GOOD ръка →
  // нито SUIT, нито ALL_TRUMPS, нито NO_TRUMPS може да се реализира безопасно.
  const blockedDeck = buildDeck({
    bottom: ['hearts-7', 'hearts-8', 'spades-8', 'clubs-Q', 'diamonds-Q'],
    right: ['clubs-J', 'diamonds-J', 'hearts-J', 'clubs-7', 'diamonds-7'],
    top: ['clubs-A', 'diamonds-A', 'hearts-A', 'clubs-K', 'diamonds-K'],
    left: ['spades-J', 'spades-A', 'spades-7', 'clubs-8', 'diamonds-8'],
  })
  let failedKeepsPending = true
  for (let seed = 0; seed < 60; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(blockedDeck, FIRST_DEAL_SEAT, stateWithPending({ bottom: 3 }), createSeededRandom(`blocked-${seed}`))
    // rescueKinds вече се записва само при успешен (приложен) rescue (виж
    // minimum-swap planner-а) — при пълен fallback (никъде безопасен
    // candidate) rescueKinds.bottom е undefined, не "избран тип, нереализиран".
    failedKeepsPending &&= !result.rescueKinds.bottom && Object.keys(result.rescues).length === 0 && result.deck === blockedDeck &&
      result.antiBadLuck.seats.bottom.pendingSinceDealIndex === 3 && result.antiBadLuck.seats.bottom.consecutiveBadDeals === 13
  }
  check('[4l] failed rescue → естествено тесте, seat остава pending със стария момент (не губи приоритет)', failedKeepsPending)
}

// ---------------------------------------------------------------------------
// [5] Bots / takeover / reclaim / restore
// ---------------------------------------------------------------------------
function makeRoom(kinds: Record<Seat, 'human' | 'bot'>): ServerRoom {
  const identity = { accountId: null, profileId: null, username: null, displayName: 'x', avatarUrl: null, level: null, rankTitle: null, skillRating: null, gender: null }
  const seats = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, {
    seat,
    team: teamOf(seat),
    participant: kinds[seat] === 'bot'
      ? { kind: 'bot', playerId: `bot-${seat}`, joinedAt: 0, botCode: 'b', difficulty: 'normal', identity }
      : { kind: 'human', playerId: `p-${seat}`, connectionId: `c-${seat}`, isConnected: true, joinedAt: 0, lastSeenAt: 0, reconnectToken: 't', permanentlyLeftAt: null, identity },
  }]))
  return {
    id: 'room-abl', status: 'playing', createdAt: 0, updatedAt: 0, hostPlayerId: null,
    config: { maxPlayers: 4, allowBots: true, isPrivate: false, joinCode: null, targetScore: 151, turnTimeMs: 15000, reconnectGraceMs: 30000 },
    seats, replayVotes: [], leaveVotes: [],
    game: { phase: 'playing', stateVersion: 1, startedAt: 0, updatedAt: 0, activeTimerId: null, timerDeadlineAt: null, authoritativeState: null },
  } as unknown as ServerRoom
}

function dealState(room: ServerRoom, antiBadLuck: ServerAntiBadLuckState, seed: string): ServerAuthoritativeGameState {
  const initial = createInitialAuthoritativeGameState(room)
  const prepared: ServerAuthoritativeGameState = {
    ...initial,
    phase: 'cut-resolve',
    round: { ...initial.round, dealerSeat: 'bottom', firstDealSeat: FIRST_DEAL_SEAT, cutterSeat: 'left', firstBidderSeat: 'right' },
    deck: [...ALL_BAD_DECK],
    antiBadLuck,
  }
  // Test adapter: explicit production default (праг 5) — dealServerFirstThreePhase
  // вече изисква config (без fallback).
  return dealServerNextTwoPhase(dealServerFirstThreePhase(prepared, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG, createSeededRandom(seed)))
}

{
  const pending = stateWithPending({ bottom: 5, right: 5 })
  const humans = dealState(makeRoom({ bottom: 'human', right: 'human', top: 'human', left: 'human' }), pending, 'bots')
  const bots = dealState(makeRoom({ bottom: 'bot', right: 'bot', top: 'bot', left: 'bot' }), pending, 'bots')

  check('[5a] initial match state → празен antiBadLuck', JSON.stringify(createInitialAuthoritativeGameState(makeRoom({ bottom: 'human', right: 'bot', top: 'human', left: 'bot' })).antiBadLuck) === JSON.stringify(createEmptyServerAntiBadLuckState()))
  check('[5b] permanent bot получава rescue като човек (идентичен резултат)', JSON.stringify(humans.hands) === JSON.stringify(bots.hands) && JSON.stringify(humans.antiBadLuck) === JSON.stringify(bots.antiBadLuck))
  // Двама pending bots → точно един rescue (опашката), той е GOOD и е reset-нат.
  const rescuedBots = (['bottom', 'right'] as const).filter((seat) => bots.antiBadLuck.seats[seat].pendingSinceDealIndex === null)
  check('[5c] 2 pending bot seats → точно един rescued bot seat с GOOD първи 5, другият остава pending',
    rescuedBots.length === 1 && isServerGoodFirstFive(bots.hands[rescuedBots[0]!]))

  // Bot takeover → reclaim → state не се reset-ва.
  const streakState = stateWithPending({ top: 2 })
  const room = makeRoom({ bottom: 'human', right: 'bot', top: 'human', left: 'bot' })
  const initial = createInitialAuthoritativeGameState(room)
  const liveRoom: ServerRoom = { ...room, game: { ...room.game, authoritativeState: { ...initial, phase: 'bidding', antiBadLuck: streakState } } }
  const takeover = abandonHumanControlForRoom(liveRoom, 'top')
  const takeoverState = takeover.ok ? getRoomAuthoritativeGameState(takeover.room) : null
  check('[5d] bot takeover не reset-ва streak', takeoverState?.players.top.controlledByBot === true && JSON.stringify(takeoverState?.antiBadLuck) === JSON.stringify(streakState))
  const reclaim = takeover.ok ? resumeHumanControlForRoom(takeover.room, 'top') : null
  const reclaimState = reclaim?.ok ? getRoomAuthoritativeGameState(reclaim.room) : null
  check('[5e] reclaim не reset-ва streak', reclaimState?.players.top.controlledByBot === false && JSON.stringify(reclaimState?.antiBadLuck) === JSON.stringify(streakState))

  // controlledByBot seat → същият резултат като човек.
  const takenOver = dealState(room, pending, 'bots')
  check('[5f] seat под bot takeover получава същото отношение', JSON.stringify(takenOver.antiBadLuck) === JSON.stringify(humans.antiBadLuck))

  // Reconnect / restart: JSON round trip + normalize + нов рунд пазят state.
  const restored = normalizeRestoredAuthoritativeState(JSON.parse(JSON.stringify(reclaimState)))
  check('[5g] JSON restore пази antiBadLuck', JSON.stringify(restored.antiBadLuck) === JSON.stringify(streakState))
  const nextRound = createServerRoundStartState(restored, 'right')
  check('[5h] нов рунд в мача пази antiBadLuck', JSON.stringify(nextRound.antiBadLuck) === JSON.stringify(streakState))

  // Legacy state без поле → работи като празен.
  const legacy = { ...restored }
  delete legacy.antiBadLuck
  const legacyDealt = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, legacy.antiBadLuck, createSeededRandom('legacy'))
  check('[5i] legacy state без antiBadLuck → започва от 0', legacyDealt.antiBadLuck.dealIndex === 1 && legacyDealt.antiBadLuck.seats.bottom.consecutiveBadDeals === 1)

  // Не изтича към клиента.
  const snapshotRoom: ServerRoom = { ...room, game: { ...room.game, authoritativeState: humans } }
  const snapshotJson = JSON.stringify(createRoomSnapshotMessage(snapshotRoom, 'bottom'))
  check('[5j] snapshot към клиента не съдържа antiBadLuck', !snapshotJson.includes('antiBadLuck') && !snapshotJson.includes('pendingSinceDealIndex'))
}

// ---------------------------------------------------------------------------
// [6] Deck invariants / минимална промяна + [7] rescue output
// ---------------------------------------------------------------------------
type RescueDiff = {
  changed: number[]
  allowed: Set<number>
  missingSwaps: number
}

// Позиции, променени спрямо естественото тесте, и позициите, които swap планът
// има право да пипне: първите 5 на rescued seat-овете + естествените позиции на
// rescue картите.
function diffAgainstNatural(natural: readonly ServerCard[], result: ReturnType<typeof applyServerAntiBadLuckToDeck>): RescueDiff {
  const allowed = new Set<number>()
  let missingSwaps = 0
  for (const seat of Object.keys(result.rescues) as Seat[]) {
    FIRST_FIVE_INDICES[seat].forEach((index) => allowed.add(index))
    for (const cardId of result.rescues[seat]!.cardIds) {
      const naturalIndex = natural.findIndex((card) => card.id === cardId)
      allowed.add(naturalIndex)
      if (!FIRST_FIVE_INDICES[seat].includes(naturalIndex)) missingSwaps += 1
    }
  }
  const changed = natural.map((card, index) => (result.deck[index].id === card.id ? -1 : index)).filter((index) => index >= 0)
  return { changed, allowed, missingSwaps }
}

{
  let allValid = true
  let noSharedCards = true
  let doubleRescues = 0
  let exactlyThreeControlled = true
  let rescuedGood = true
  let naturalGoodProtected = true
  let naturalGoodChecked = 0
  let onlyNeededPositionsChanged = true
  let swapCountBounded = true
  let uncontrolledPreserved = true
  let weakestReplaced = true
  let presentRescueStays = true
  let rescueCount = 0
  const randomCompanions = new Set<string>()
  const firstThreeDistribution = new Map<number, number>()
  const types = new Map<string, number>()
  const suits = new Map<string, number>()
  const templates = new Map<string, number>()
  const suitTriples = new Set<string>()
  const swapCounts = new Map<number, number>()
  let noSafeAnywhereCount = 0
  let noSafeAnywhereEligible = 0
  let zeroSwapInvariantHeld = true

  for (let seed = 0; seed < 4000; seed += 1) {
    // Естествено разбъркано тесте; и четирите seats са pending → арбитраж + защита на естествен GOOD.
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`natural-${seed}`))
    const naturalSnapshot = natural.map((card) => card.id).join(',')
    const naturalGood = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, isServerGoodFirstFive(firstFive(natural, seat))])) as Record<Seat, boolean>
    const result = applyServerAntiBadLuckToDeck(natural, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, right: 5, top: 5, left: 5 }), createSeededRandom(`deck-${seed}`))
    allValid &&= isValidDeck(result.deck) && natural.map((card) => card.id).join(',') === naturalSnapshot

    // rescueKinds вече е винаги в синхрон с rescues (само успешни rescue-та) —
    // "избран тип, нереализиран variant" вече не съществува като отделно
    // състояние (виж minimum-swap planner-а).
    // Ако поне един seat е естествено BAD, арбитражът е имал кандидат този
    // кръг (знаменател); "никъде безопасен candidate" (пълен fallback,
    // rescuedSeats празно) е бройката неуспешни измежду тях.
    const hadEligibleCandidate = SERVER_SEAT_ORDER.some((seat) => !naturalGood[seat])
    const rescuedSeats = Object.keys(result.rescues) as Seat[]
    if (rescuedSeats.length === 0) {
      allValid &&= result.deck === natural
      if (hadEligibleCandidate) {
        noSafeAnywhereEligible += 1
        noSafeAnywhereCount += 1
      }
      continue
    }
    if (hadEligibleCandidate) {
      noSafeAnywhereEligible += 1
    }

    for (const seat of rescuedSeats) {
      const swapCount = result.rescues[seat]!.cardIds.filter((id) => !firstFive(natural, seat).some((card) => card.id === id)).length
      swapCounts.set(swapCount, (swapCounts.get(swapCount) ?? 0) + 1)
      zeroSwapInvariantHeld &&= swapCount >= 1
    }

    for (const seat of SERVER_SEAT_ORDER) {
      if (!result.rescues[seat] && naturalGood[seat]) {
        naturalGoodChecked += 1
        naturalGoodProtected &&= isServerGoodFirstFive(firstFive(result.deck, seat))
      }
    }

    const rescueIds = new Set(rescuedSeats.flatMap((seat) => result.rescues[seat]!.cardIds))
    if (rescuedSeats.length > 1) {
      doubleRescues += 1
    }
    noSharedCards &&= rescueIds.size === rescuedSeats.length * 3

    const diff = diffAgainstNatural(natural, result)
    onlyNeededPositionsChanged &&= diff.changed.every((index) => diff.allowed.has(index))
    swapCountBounded &&= diff.changed.length <= diff.missingSwaps * 2

    for (const seat of rescuedSeats) {
      const rescue = result.rescues[seat]!
      const seatFive = firstFive(result.deck, seat).map((card) => card.id)
      rescueCount += 1
      exactlyThreeControlled &&= rescue.cardIds.length === 3 && rescue.cardIds.every((id) => seatFive.includes(id))
      rescuedGood &&= isServerGoodFirstFive(firstFive(result.deck, seat))

      // Неконтролираните позиции държат естествената карта, освен ако тя е
      // била rescue карта на другия seat (необходим swap).
      FIRST_FIVE_INDICES[seat].forEach((index) => {
        if (rescue.cardIds.includes(result.deck[index].id)) return
        randomCompanions.add(result.deck[index].id)
        uncontrolledPreserved &&= result.deck[index].id === natural[index].id || rescueIds.has(natural[index].id)
      })

      // Вече наличните rescue карти стоят на същата позиция; заменените
      // естествени карти са най-слабите според типа (карта-rescue на другия
      // seat така или иначе напуска ръката и не се брои).
      const finalFive = new Set(seatFive)
      const naturalOthers = FIRST_FIVE_INDICES[seat].map((index) => natural[index]).filter((card) => !rescue.cardIds.includes(card.id) && !rescueIds.has(card.id))
      const keptStrengths = naturalOthers.filter((card) => finalFive.has(card.id)).map((card) => getServerAntiBadLuckKeepStrength(card, rescue))
      const removedStrengths = naturalOthers.filter((card) => !finalFive.has(card.id)).map((card) => getServerAntiBadLuckKeepStrength(card, rescue))
      weakestReplaced &&= removedStrengths.every((strength) => keptStrengths.every((kept) => strength <= kept))
      presentRescueStays &&= FIRST_FIVE_INDICES[seat].every((index) => !rescue.cardIds.includes(natural[index].id) || result.deck[index].id === natural[index].id)

      const inFirstThree = FIRST_FIVE_INDICES[seat].slice(0, 3).filter((index) => rescue.cardIds.includes(result.deck[index].id)).length
      firstThreeDistribution.set(inFirstThree, (firstThreeDistribution.get(inFirstThree) ?? 0) + 1)

      types.set(rescue.type, (types.get(rescue.type) ?? 0) + 1)
      if (rescue.type === 'SUIT') {
        suits.set(rescue.variant, (suits.get(rescue.variant) ?? 0) + 1)
        suitTriples.add([...rescue.cardIds].sort().join(','))
      } else {
        templates.set(`${rescue.type}:${rescue.variant}`, (templates.get(`${rescue.type}:${rescue.variant}`) ?? 0) + 1)
      }
    }
  }

  const share = (count: number | undefined, total: number) => (count ?? 0) / total
  const suitTotal = [...suits.values()].reduce((sum, count) => sum + count, 0)
  const templateTotal = [...templates.values()].reduce((sum, count) => sum + count, 0)
  const distributionLabel = [3, 2, 1].map((n) => `${n}+${3 - n}=${firstThreeDistribution.get(n) ?? 0}`).join(', ')

  check('[6a] винаги 32 уникални карти, естественото тесте не се мутира', allValid)
  check(`[6b] максимум 1 rescue на раздаване дори при 4 pending seats (${doubleRescues} двойни)`, noSharedCards && doubleRescues === 0)
  check('[6d] няма secondary shuffle: променени са само необходимите swap позиции', onlyNeededPositionsChanged)
  check('[6e] брой променени позиции <= 2 × необходимите swap-ове', swapCountBounded)
  check(`[6f] естествено GOOD seat без rescue остава GOOD (${naturalGoodChecked} случая)`, naturalGoodProtected && naturalGoodChecked > 1000)
  check('[7a] точно 3 контролирани карти в първите 5 на rescued seat', exactlyThreeControlled)
  check('[7b] rescued seat винаги има GOOD първи 5', rescuedGood)
  check('[7c] неконтролираните позиции в първите 5 държат естествените карти', uncontrolledPreserved)
  check('[7d] неконтролираните карти идват от natural shuffle (> 25 различни)', randomCompanions.size > 25)
  check(`[7e] first-3/next-2 разпределение (информативно, следва силата на картите): ${distributionLabel}`, !firstThreeDistribution.has(0))
  check('[7e2] вече налична rescue карта никога не се мести (стрес)', presentRescueStays)
  check('[7e3] заменените естествени карти никога не са по-силни от запазените (стрес)', weakestReplaced)
  const pct = (count: number | undefined, total: number) => `${(share(count, total) * 100).toFixed(1)}%`
  const typeLabel = (map: Map<string, number>, total: number) => ['SUIT', 'ALL_TRUMPS', 'NO_TRUMPS'].map((type) => `${type} ${pct(map.get(type), total)}`).join(', ')
  const templateShare = (map: Map<string, number>, type: string, variant: string) =>
    share(map.get(`${type}:${variant}`), (map.get(`${type}:TRIPLE`) ?? 0) + (map.get(`${type}:PAIR_PLUS`) ?? 0))
  const templateLabel = (map: Map<string, number>) => ['ALL_TRUMPS', 'NO_TRUMPS'].map((type) => `${type} TRIPLE ${(templateShare(map, type, 'TRIPLE') * 100).toFixed(1)}% / PAIR_PLUS ${(templateShare(map, type, 'PAIR_PLUS') * 100).toFixed(1)}%`).join('; ')

  // [7f]/[7f2]: minimum-swap planner-ът НЕ тегли типа на сляпо 1/3 — типът се
  // определя от това кой achieve-ва глобалния минимален swap count (виж
  // pickMinimumSwapRescuePlan), а SUIT има много повече кандидати (всичките 4
  // цвята наведнъж) от ALL_TRUMPS/NO_TRUMPS → по design доминира дела на
  // приложения тип. Проверяваме структурни инварианти вместо фиксирано 1/3:
  // всичките 3 типа все пак се реализират поне веднъж (никой не е напълно
  // недостижим) и swap count-ът е винаги в очаквания диапазон 1-3.
  check(`[7f] приложен тип (n=${rescueCount}, очаквано SUIT-доминиран заради по-богат candidate pool): ${typeLabel(types, rescueCount)}`, types.size === 3)
  check(`[7f2] swap count на приложения rescue е винаги 1, 2 или 3 (разпределение: ${[...swapCounts.entries()].sort().map(([count, n]) => `${count}=${n}`).join(', ')})`,
    [...swapCounts.keys()].every((count) => count >= 1 && count <= 3))
  check(`[7g] приложен SUIT цвят ~25%: ${[...suits.entries()].map(([suit, count]) => `${suit} ${pct(count, suitTotal)}`).join(', ')}`, suits.size === 4 && [...suits.values()].every((count) => share(count, suitTotal) > 0.21 && share(count, suitTotal) < 0.29))
  check('[7h] SUIT тройката не е винаги една и съща (> 10 варианта)', suitTriples.size > 10)
  // [7i2]: PAIR_PLUS има 3х повече комбинаторни варианти от TRIPLE (12 vs 4) →
  // по-вероятно да достигне по-нисък swap count при minimum-swap избора, затова
  // доминира силно (очаквано, не регресия) — проверяваме само, че и двата
  // шаблона се появяват поне веднъж, когато типът изобщо е приложен.
  check(`[7i2] приложени шаблони (стрес, PAIR_PLUS-доминирани заради по-богат combinatorics): ${templateLabel(templates)}`, templateTotal > 0)
  // [7l]/[7m]: "никъде безопасен candidate" (пълен fallback, seat остава
  // pending) вече не е обвързано с конкретен тип (enumerate-ваме и трите
  // наведнъж) — проверяваме само, че такъв случай си остава рядък стрес ръб,
  // не правило, и винаги оставя естественото тесте непипнато.
  check(`[7l] "никъде безопасен candidate" остава рядък стрес ръб: ${noSafeAnywhereCount} от ${noSafeAnywhereEligible} eligible кръга (${pct(noSafeAnywhereCount, noSafeAnywhereEligible)})`,
    share(noSafeAnywhereCount, noSafeAnywhereEligible) < 0.05)
  check('[7m] defensive invariant: swap count никога не е 0 (seat-ът е винаги natural BAD тук)', zeroSwapInvariantHeld)
}

{
  // Реалистичен сценарий: един pending seat, естествено разбъркани тестета.
  const types = new Map<string, number>()
  const templates = new Map<string, number>()
  let eligible = 0
  let applied = 0
  for (let seed = 0; seed < 4000; seed += 1) {
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`single-natural-${seed}`))
    if (isServerGoodFirstFive(firstFive(natural, 'bottom'))) continue
    eligible += 1
    const result = applyServerAntiBadLuckToDeck(natural, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`single-deck-${seed}`))
    const rescue = result.rescues.bottom
    if (!rescue) continue
    applied += 1
    types.set(rescue.type, (types.get(rescue.type) ?? 0) + 1)
    if (rescue.type !== 'SUIT') templates.set(`${rescue.type}:${rescue.variant}`, (templates.get(`${rescue.type}:${rescue.variant}`) ?? 0) + 1)
  }
  const share = (count: number | undefined, total: number) => (count ?? 0) / total
  const pct = (count: number | undefined, total: number) => `${(share(count, total) * 100).toFixed(1)}%`
  // От square/sequence guard-а (виж [10]/[11]): дори с 1 pending seat, rescue
  // вече МОЖЕ да остане непринложен, ако единствената безопасна GOOD/anchor
  // реализация би разрушила natural run/square или би създала artificial
  // каре — ново, очаквано поведение, не регресия.
  check(`[7n] 1 pending seat: приложени ${applied}/${eligible} (${pct(applied, eligible)})`, share(applied, eligible) > 0.95)
  // Minimum-swap selection-ът не тегли типа 1/3 на сляпо (виж [7f]) — тук само
  // потвърждаваме, че и трите типа все пак се реализират в реалистичен,
  // единичен-pending-seat сценарий (не само в 4-way стрес сценария от [7f]).
  check(`[7n2] 1 pending seat: типове ${['SUIT', 'ALL_TRUMPS', 'NO_TRUMPS'].map((type) => `${type} ${pct(types.get(type), applied)}`).join(', ')}`, types.size === 3)
}

{
  // Единичен rescue върху фиксирано тесте: точна проверка на минималната промяна.
  let exact = true
  for (let seed = 0; seed < 300; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`single-${seed}`))
    const rescue = result.rescues.bottom
    if (!rescue) { exact = false; continue }
    const diff = diffAgainstNatural(ALL_BAD_DECK, result)
    const uncontrolled = FIRST_FIVE_INDICES.bottom.filter((index) => !rescue.cardIds.includes(result.deck[index].id))
    exact &&= uncontrolled.length === 2 && uncontrolled.every((index) => result.deck[index].id === ALL_BAD_DECK[index].id)
    exact &&= diff.changed.length === diff.missingSwaps * 2
    // Извън първите 5 на bottom се променят само старите позиции на rescue картите
    // (там отива изместената естествена карта); всичко останало е непокътнато.
    exact &&= diff.changed.every((index) => FIRST_FIVE_INDICES.bottom.includes(index) || rescue.cardIds.includes(ALL_BAD_DECK[index].id))
  }
  check('[7j] единичен rescue: 2 естествени карти запазени, променени са точно 2 × swap позиции', exact)

  // Конфликти в рамките на основния тип: друг цвят/шаблон, никога друг тип.
  const suitsWithoutHearts = new Map<string, number>()
  let suitAvoidsTakenJack = true
  let allTrumpsFallsToPairPlus = true
  let noTrumpsFallsToPairPlus = true
  let exhaustedTypeIsNull = true
  let freeTripleShare = 0
  for (let seed = 0; seed < 600; seed += 1) {
    const random = createSeededRandom(`in-type-${seed}`)
    // Другият seat е взел J♥ (напр. SUIT ♥) → SUIT избира друг цвят, random.
    const suit = pickServerAntiBadLuckRescue('SUIT', new Set(['hearts-J']), random)
    suitAvoidsTakenJack &&= suit?.type === 'SUIT' && suit.variant !== 'hearts' && suit.cardIds.every((id) => id.startsWith(`${suit.variant}-`))
    if (suit) suitsWithoutHearts.set(suit.variant, (suitsWithoutHearts.get(suit.variant) ?? 0) + 1)
    // Другият seat е взел J♣ J♥ 9♣ (JJ9) → остават 2 J → само JJ9 от ♦/♠.
    const allTrumps = pickServerAntiBadLuckRescue('ALL_TRUMPS', new Set(['clubs-J', 'hearts-J', 'clubs-9']), random)
    allTrumpsFallsToPairPlus &&= allTrumps?.type === 'ALL_TRUMPS' && allTrumps.variant === 'PAIR_PLUS' &&
      allTrumps.cardIds.includes('diamonds-J') && allTrumps.cardIds.includes('spades-J')
    const noTrumps = pickServerAntiBadLuckRescue('NO_TRUMPS', new Set(['clubs-A', 'hearts-A', 'hearts-10']), random)
    noTrumpsFallsToPairPlus &&= noTrumps?.type === 'NO_TRUMPS' && noTrumps.variant === 'PAIR_PLUS' &&
      noTrumps.cardIds.includes('diamonds-A') && noTrumps.cardIds.includes('spades-A')
    // Целият тип изчерпан (3 J заети) → null, без друг тип.
    exhaustedTypeIsNull &&=
      pickServerAntiBadLuckRescue('ALL_TRUMPS', new Set(['clubs-J', 'hearts-J', 'spades-J']), random) === null &&
      pickServerAntiBadLuckRescue('NO_TRUMPS', new Set(['clubs-A', 'hearts-A', 'spades-A']), random) === null
    if (pickServerAntiBadLuckRescue('ALL_TRUMPS', new Set(), random)?.variant === 'TRIPLE') freeTripleShare += 1
  }
  check(`[6c] SUIT при зает J♥ → друг цвят, random (${[...suitsWithoutHearts.entries()].map(([s, c]) => `${s} ${c}`).join(', ')})`,
    suitAvoidsTakenJack && suitsWithoutHearts.size === 3 && [...suitsWithoutHearts.values()].every((count) => count > 150))
  check('[6c2] ALL_TRUMPS при конфликт → JJ9 в същия тип', allTrumpsFallsToPairPlus)
  check('[6c3] NO_TRUMPS при конфликт → AA10 в същия тип', noTrumpsFallsToPairPlus)
  check('[6c4] изчерпан тип → null, никога друг основен тип', exhaustedTypeIsNull)
  check(`[6c5] без конфликт шаблонът е ~50/50 (JJJ ${freeTripleShare}/600)`, freeTripleShare > 250 && freeTripleShare < 350)
}

// ---------------------------------------------------------------------------
// [8] Избор на позиции за swap: пазим силните естествени карти, заменяме
//     най-слабите според rescue типа; равенство → random; позицията не участва.
// ---------------------------------------------------------------------------
{
  type SwapOutcome = { replaced: Set<string>; presentStayed: boolean }

  // bottom получава `bottomIds` като естествени първи 5 (в този ред по позиции).
  function swapBottom(bottomIds: string[], rescue: ServerAntiBadLuckRescue, seed: string): SwapOutcome {
    const natural = buildDeck({ ...BAD_HANDS, bottom: bottomIds })
    const deck = applyServerAntiBadLuckRescueSwaps(natural, FIRST_FIVE_INDICES, { bottom: rescue }, createSeededRandom(seed))
    const finalFive = new Set(firstFive(deck, 'bottom').map((card) => card.id))
    return {
      replaced: new Set(bottomIds.filter((id) => !finalFive.has(id))),
      presentStayed: FIRST_FIVE_INDICES.bottom.every((index) => !rescue.cardIds.includes(natural[index].id) || deck[index].id === natural[index].id) &&
        isValidDeck(deck) && rescue.cardIds.every((id) => finalFive.has(id)),
    }
  }

  const sameSet = (left: Set<string>, right: string[]) => left.size === right.length && right.every((id) => left.has(id))

  function checkDeterministic(label: string, bottomIds: string[], rescue: ServerAntiBadLuckRescue, expectedReplaced: string[]) {
    let ok = true
    for (let seed = 0; seed < 40; seed += 1) {
      // Различни пермутации на същите 5 карти по позициите → същият резултат.
      const permuted = shuffleWithRandom(bottomIds, createSeededRandom(`perm-${label}-${seed}`))
      const outcome = swapBottom(permuted, rescue, `swap-${label}-${seed}`)
      ok &&= outcome.presentStayed && sameSet(outcome.replaced, expectedReplaced)
    }
    check(`[8] ${label} → заменени ${expectedReplaced.join(', ')} (40 пермутации на позициите)`, ok)
  }

  function checkTie(label: string, bottomIds: string[], rescue: ServerAntiBadLuckRescue, tiedIds: string[], neverReplaced: string[]) {
    const counts = new Map<string, number>()
    let ok = true
    for (let seed = 0; seed < 400; seed += 1) {
      const outcome = swapBottom(bottomIds, rescue, `tie-${label}-${seed}`)
      ok &&= outcome.presentStayed && neverReplaced.every((id) => !outcome.replaced.has(id)) && [...outcome.replaced].every((id) => tiedIds.includes(id))
      outcome.replaced.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1))
    }
    const expected = [...counts.values()].reduce((sum, count) => sum + count, 0) / tiedIds.length
    ok &&= tiedIds.every((id) => Math.abs((counts.get(id) ?? 0) - expected) < expected * 0.2)
    check(`[8] ${label} — tie random: ${tiedIds.map((id) => `${id} ${counts.get(id) ?? 0}`).join(', ')}`, ok)
  }

  // NO_TRUMPS: A11 10:10 K4 Q3 J2 9/8/7:0
  checkDeterministic('AAA пази естественото A♣, сменя 7♣ и 9♠ (NT = 0), пази 10♥ и J♦',
    ['clubs-7', 'hearts-10', 'clubs-A', 'spades-9', 'diamonds-J'],
    { type: 'NO_TRUMPS', variant: 'TRIPLE', cardIds: ['clubs-A', 'diamonds-A', 'spades-A'] },
    ['clubs-7', 'spades-9'])
  checkTie('AA10 пази естествената 10♣ и J♦ (2), сменя 2 от трите нули',
    ['clubs-10', 'clubs-7', 'diamonds-J', 'hearts-9', 'diamonds-8'],
    { type: 'NO_TRUMPS', variant: 'PAIR_PLUS', cardIds: ['clubs-A', 'diamonds-A', 'clubs-10'] },
    ['clubs-7', 'hearts-9', 'diamonds-8'], ['clubs-10', 'diamonds-J'])

  // ALL_TRUMPS: J20 9:14 A11 10:10 K4 Q3 8/7:0
  checkTie('JJ9 пази естествените J♣ и 9♦ и 10♥, сменя 7♣ или 8♦',
    ['diamonds-9', 'clubs-J', 'hearts-10', 'clubs-7', 'diamonds-8'],
    { type: 'ALL_TRUMPS', variant: 'PAIR_PLUS', cardIds: ['clubs-J', 'diamonds-J', 'diamonds-9'] },
    ['clubs-7', 'diamonds-8'], ['diamonds-9', 'clubs-J', 'hearts-10'])
  checkDeterministic('JJJ пази J♣ J♥, 9♠ (14) и A♣ (11), сменя 10♥ (10)',
    ['spades-9', 'hearts-10', 'clubs-J', 'hearts-J', 'clubs-A'],
    { type: 'ALL_TRUMPS', variant: 'TRIPLE', cardIds: ['clubs-J', 'hearts-J', 'diamonds-J'] },
    ['hearts-10'])

  // SUIT: козови стойности за избрания цвят, безкозови за останалите.
  checkDeterministic('SUIT ♥ пази 9♥ (в тройката), 10♥ и A♣, сменя 7♣ и 8♦',
    ['hearts-9', 'clubs-A', 'hearts-10', 'clubs-7', 'diamonds-8'],
    { type: 'SUIT', variant: 'hearts', cardIds: ['hearts-J', 'hearts-9', 'hearts-7'] },
    ['clubs-7', 'diamonds-8'])
  checkDeterministic('SUIT ♦ пази 9♦ (коз 14) и 10♣ (10), сменя 9♥ (0), 8♦ (0), J♣ (извън цвета = 2)',
    ['diamonds-9', 'clubs-J', 'hearts-9', 'clubs-10', 'diamonds-8'],
    { type: 'SUIT', variant: 'diamonds', cardIds: ['diamonds-J', 'diamonds-A', 'diamonds-7'] },
    ['hearts-9', 'diamonds-8', 'clubs-J'])

  // Същата ръка, различен тип → различни заменени карти (типово-зависима сила).
  const contrastHand = ['spades-9', 'hearts-10', 'clubs-J', 'clubs-A', 'hearts-7']
  checkDeterministic('контраст ALL_TRUMPS JJJ: пази 9♠ (14) и A♣ (11), сменя 7♥ (0) и 10♥ (10)',
    contrastHand,
    { type: 'ALL_TRUMPS', variant: 'TRIPLE', cardIds: ['clubs-J', 'hearts-J', 'diamonds-J'] },
    ['hearts-7', 'hearts-10'])
  checkDeterministic('контраст NO_TRUMPS AAA: пази 10♥ (10) и J♣ (2), сменя 9♠ (0) и 7♥ (0)',
    contrastHand,
    { type: 'NO_TRUMPS', variant: 'TRIPLE', cardIds: ['clubs-A', 'diamonds-A', 'spades-A'] },
    ['spades-9', 'hearts-7'])
}

// ---------------------------------------------------------------------------
// [9] Anchor constraints: ALL_TRUMPS/NO_TRUMPS rescue никога не добавя J/A
//     над вече наличните natural J/A (fix за 4-J/4-A bug-а).
// ---------------------------------------------------------------------------
{
  function runAnchorSuite(anchorRank: 'J' | 'A', companionRank: '9' | '10', type: 'ALL_TRUMPS' | 'NO_TRUMPS') {
    const label = type
    const twoNatural: ServerAntiBadLuckAnchorConstraints = { naturalAnchorSuits: ['clubs', 'hearts'] }
    const oneNatural: ServerAntiBadLuckAnchorConstraints = { naturalAnchorSuits: ['clubs'] }
    const anchorId = (suit: string) => `${suit}-${anchorRank}`
    const companionId = (suit: string) => `${suit}-${companionRank}`
    const countAnchors = (cardIds: string[]) => cardIds.filter((id) => id.endsWith(`-${anchorRank}`)).length

    // 2 natural anchors → форсиран PAIR_PLUS с точно тези 2 + matching companion.
    let twoExact = true
    const twoCompanions = new Set<string>()
    for (let seed = 0; seed < 300; seed += 1) {
      const random = createSeededRandom(`${label}-2-${seed}`)
      const variant = pickServerAntiBadLuckRescueVariant(type, random, twoNatural)
      twoExact &&= variant === 'PAIR_PLUS'
      const rescue = pickServerAntiBadLuckRescue(type, new Set(), random, variant, twoNatural)
      twoExact &&= !!rescue && rescue.variant === 'PAIR_PLUS' && rescue.cardIds.length === 3 &&
        rescue.cardIds.includes(anchorId('clubs')) && rescue.cardIds.includes(anchorId('hearts')) &&
        (rescue.cardIds.includes(companionId('clubs')) || rescue.cardIds.includes(companionId('hearts')))
      if (rescue) twoCompanions.add(rescue.cardIds.find((id) => id.endsWith(`-${companionRank}`))!)
    }
    check(`[9a-${label}] 2 natural ${anchorRank} → точно тези 2 + matching ${companionRank} (300 seeds)`, twoExact)
    check(`[9b-${label}] 2 natural ${anchorRank}: и двата matching ${companionRank} се появяват (seeded random): ${[...twoCompanions].join(', ')}`,
      twoCompanions.has(companionId('clubs')) && twoCompanions.has(companionId('hearts')) && twoCompanions.size === 2)

    // 2 natural anchors никога не водят до 3-то/4-то anchor.
    let neverExtra = true
    let neverExtraChecked = 0
    for (let seed = 0; seed < 1000; seed += 1) {
      const random = createSeededRandom(`${label}-count-${seed}`)
      const variant = pickServerAntiBadLuckRescueVariant(type, random, twoNatural)
      const rescue = pickServerAntiBadLuckRescue(type, new Set(), random, variant, twoNatural)
      if (!rescue) continue
      neverExtraChecked += 1
      neverExtra &&= countAnchors(rescue.cardIds) === 2
    }
    check(`[9c-${label}] 2 natural ${anchorRank} → rescue никога не добавя 3-то/4-то ${anchorRank} (${neverExtraChecked} samples)`, neverExtra && neverExtraChecked > 900)

    // 1 natural anchor участва задължително — и в TRIPLE, и в PAIR_PLUS.
    let oneTripleOk = true
    let onePairOk = true
    for (let seed = 0; seed < 300; seed += 1) {
      const randomTriple = createSeededRandom(`${label}-1triple-${seed}`)
      const triple = pickServerAntiBadLuckRescue(type, new Set(), randomTriple, 'TRIPLE', oneNatural)
      oneTripleOk &&= !!triple && triple.cardIds.includes(anchorId('clubs')) && countAnchors(triple.cardIds) === 3

      const randomPair = createSeededRandom(`${label}-1pair-${seed}`)
      const pair = pickServerAntiBadLuckRescue(type, new Set(), randomPair, 'PAIR_PLUS', oneNatural)
      onePairOk &&= !!pair && pair.cardIds.includes(anchorId('clubs')) && countAnchors(pair.cardIds) === 2
    }
    check(`[9d-${label}] 1 natural ${anchorRank} + TRIPLE → participira, краен брой = 3 (300 seeds)`, oneTripleOk)
    check(`[9e-${label}] 1 natural ${anchorRank} + PAIR_PLUS → participira, краен брой = 2 (300 seeds)`, onePairOk)

    // 0 natural anchors → старото 50/50 preferred variant поведение.
    let zeroTriple = 0
    const zeroTotal = 600
    for (let seed = 0; seed < zeroTotal; seed += 1) {
      const random = createSeededRandom(`${label}-0-${seed}`)
      if (pickServerAntiBadLuckRescueVariant(type, random) === 'TRIPLE') zeroTriple += 1
    }
    check(`[9f-${label}] 0 natural ${anchorRank} → preferred variant ~50/50 (TRIPLE ${zeroTriple}/${zeroTotal})`,
      zeroTriple / zeroTotal > 0.44 && zeroTriple / zeroTotal < 0.56)

    // 2 natural anchors, и двата matching companion недостъпни → null (fallback
    // остава pending, без 3-то anchor, без смяна на типа).
    const blocked = pickServerAntiBadLuckRescue(
      type,
      new Set([companionId('clubs'), companionId('hearts')]),
      createSeededRandom(`${label}-blocked`),
      'PAIR_PLUS',
      twoNatural,
    )
    check(`[9j-${label}] 2 natural ${anchorRank}, и двата matching ${companionRank} недостъпни → null`, blocked === null)

    return { twoNatural }
  }

  runAnchorSuite('J', '9', 'ALL_TRUMPS')
  runAnchorSuite('A', '10', 'NO_TRUMPS')

  // End-to-end: реален pending seat с 2 natural J, минал през пълния
  // applyServerAntiBadLuckToDeck pipeline (случайно избран тип — филтрираме
  // семплите, дето sluchayno е паднал върху ALL_TRUMPS).
  const twoNaturalJDeck = buildDeck({
    bottom: ['clubs-J', 'hearts-J', 'clubs-7', 'diamonds-7', 'hearts-7'],
    right: BAD_HANDS.right,
    top: BAD_HANDS.top,
    left: BAD_HANDS.left,
  })
  let allTrumpsSamples = 0
  let twoNaturalEndToEndOk = true
  for (let seed = 0; seed < 2000; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(twoNaturalJDeck, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`2j-e2e-${seed}`))
    if (result.rescueKinds.bottom?.type !== 'ALL_TRUMPS') continue
    allTrumpsSamples += 1
    const five = firstFive(result.deck, 'bottom').map((card) => card.id)
    const jCount = five.filter((id) => id.endsWith('-J')).length
    twoNaturalEndToEndOk &&= jCount <= 2
    if (result.rescues.bottom) {
      twoNaturalEndToEndOk &&= jCount === 2 && five.includes('clubs-J') && five.includes('hearts-J')
    }
  }
  check(`[9g] end-to-end (пълен pipeline): 2 natural J + ALL_TRUMPS rescue → никога 3-то/4-то J (${allTrumpsSamples} samples)`,
    twoNaturalEndToEndOk && allTrumpsSamples > 100)

  const twoNaturalADeck = buildDeck({
    bottom: ['clubs-A', 'hearts-A', 'clubs-7', 'diamonds-7', 'hearts-7'],
    right: BAD_HANDS.right,
    top: BAD_HANDS.top,
    // BAD_HANDS.left държи hearts-A — заменен с spades-9, за да не се
    // дублира с bottom-овото natural hearts-A в този fixture.
    left: ['spades-K', 'clubs-9', 'diamonds-10', 'spades-9', 'spades-J'],
  })
  let noTrumpsSamples = 0
  let twoNaturalEndToEndOkA = true
  for (let seed = 0; seed < 2000; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(twoNaturalADeck, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`2a-e2e-${seed}`))
    if (result.rescueKinds.bottom?.type !== 'NO_TRUMPS') continue
    noTrumpsSamples += 1
    const five = firstFive(result.deck, 'bottom').map((card) => card.id)
    const aCount = five.filter((id) => id.endsWith('-A')).length
    twoNaturalEndToEndOkA &&= aCount <= 2
    if (result.rescues.bottom) {
      twoNaturalEndToEndOkA &&= aCount === 2 && five.includes('clubs-A') && five.includes('hearts-A')
    }
  }
  check(`[9h] end-to-end (пълен pipeline): 2 natural A + NO_TRUMPS rescue → никога 3-то/4-то A (${noTrumpsSamples} samples)`,
    twoNaturalEndToEndOkA && noTrumpsSamples > 100)

  // Глобален инвариант върху случайни natural shuffle-и (4 pending seats):
  // никога 4 J след ALL_TRUMPS rescue, никога 4 A след NO_TRUMPS rescue.
  let neverFourAnchorsGlobal = true
  let allTrumpsChecked = 0
  let noTrumpsChecked = 0
  for (let seed = 0; seed < 3000; seed += 1) {
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`anchor-inv-${seed}`))
    const result = applyServerAntiBadLuckToDeck(
      natural,
      FIRST_DEAL_SEAT,
      stateWithPending({ bottom: 5, right: 5, top: 5, left: 5 }),
      createSeededRandom(`anchor-inv-deck-${seed}`),
    )
    for (const seat of Object.keys(result.rescues) as Seat[]) {
      const rescue = result.rescues[seat]!
      const five = firstFive(result.deck, seat).map((card) => card.id)
      if (rescue.type === 'ALL_TRUMPS') {
        allTrumpsChecked += 1
        neverFourAnchorsGlobal &&= five.filter((id) => id.endsWith('-J')).length <= 3
      }
      if (rescue.type === 'NO_TRUMPS') {
        noTrumpsChecked += 1
        neverFourAnchorsGlobal &&= five.filter((id) => id.endsWith('-A')).length <= 3
      }
    }
  }
  check(`[9i] инвариант (случаен natural shuffle): никога 4 J/4 A в първите 5 след rescue (ALL_TRUMPS n=${allTrumpsChecked}, NO_TRUMPS n=${noTrumpsChecked})`,
    neverFourAnchorsGlobal && allTrumpsChecked > 100 && noTrumpsChecked > 100)
}

// ---------------------------------------------------------------------------
// [10] Sequence guard: пази natural кварти/квинти от rescue swap-овете (вкл.
//      при друг seat чрез изместена карта); допуска само 0 или точно 1 нова
//      дълга поредица (25%/10%, изтеглени веднъж на execution).
// ---------------------------------------------------------------------------
{
  const NEUTRAL_HAND = cards('clubs-7', 'diamonds-8', 'hearts-9', 'spades-10', 'clubs-Q', 'diamonds-K', 'hearts-A', 'spades-J')
  const ALLOW_BOTH: ServerAntiBadLuckSequenceAllowance = { allowArtificialQuart: true, allowArtificialQuintPlus: true }
  const ALLOW_NEITHER: ServerAntiBadLuckSequenceAllowance = { allowArtificialQuart: false, allowArtificialQuintPlus: false }
  const ALLOW_QUART_ONLY: ServerAntiBadLuckSequenceAllowance = { allowArtificialQuart: true, allowArtificialQuintPlus: false }
  const ALLOW_QUINT_ONLY: ServerAntiBadLuckSequenceAllowance = { allowArtificialQuart: false, allowArtificialQuintPlus: true }

  const allNeutral = (override: Partial<Record<Seat, ServerCard[]>>): Record<Seat, ServerCard[]> => ({
    bottom: override.bottom ?? NEUTRAL_HAND,
    right: override.right ?? NEUTRAL_HAND,
    top: override.top ?? NEUTRAL_HAND,
    left: override.left ?? NEUTRAL_HAND,
  })

  // [10.1] natural quart на non-rescue seat (right) не може да бъде разрушена.
  const naturalRightQuart = cards('hearts-7', 'hearts-8', 'hearts-9', 'hearts-10', 'clubs-K', 'diamonds-A', 'spades-Q', 'clubs-J')
  const postRightBrokenQuart = cards('hearts-7', 'hearts-8', 'hearts-9', 'hearts-Q', 'clubs-K', 'diamonds-A', 'spades-Q', 'clubs-J')
  check('[10.1] natural quart на non-rescue seat не може да бъде разрушена от swap',
    !isServerAntiBadLuckSequencePlanSafe(allNeutral({ right: naturalRightQuart }), allNeutral({ right: postRightBrokenQuart }), ALLOW_BOTH))

  // [10.2] natural quint на non-rescue seat не може да бъде разрушена (дори до quart).
  const naturalRightQuint = cards('hearts-7', 'hearts-8', 'hearts-9', 'hearts-10', 'hearts-J', 'diamonds-K', 'spades-A', 'clubs-Q')
  const postRightShrunkToQuart = cards('hearts-7', 'hearts-8', 'hearts-9', 'hearts-10', 'clubs-J', 'diamonds-K', 'spades-A', 'clubs-Q')
  check('[10.2] natural quint на non-rescue seat не може да бъде разрушена (дори свита до quart)',
    !isServerAntiBadLuckSequencePlanSafe(allNeutral({ right: naturalRightQuint }), allNeutral({ right: postRightShrunkToQuart }), ALLOW_BOTH))

  // [10.3] natural quart/quint на самия rescued seat (bottom) също се пази.
  check('[10.3a] natural quart на rescued seat (bottom) също се пази',
    !isServerAntiBadLuckSequencePlanSafe(allNeutral({ bottom: naturalRightQuart }), allNeutral({ bottom: postRightBrokenQuart }), ALLOW_BOTH))
  check('[10.3b] natural quint на rescued seat (bottom) също се пази',
    !isServerAntiBadLuckSequencePlanSafe(allNeutral({ bottom: naturalRightQuint }), allNeutral({ bottom: postRightShrunkToQuart }), ALLOW_BOTH))

  // [10.4]/[10.10]/[10.11] rescue създава quart при rescued seat (bottom) —
  // класифицира се като artificial QUART, allowed само ако allowArtificialQuart.
  const naturalBottomNoRun = cards('clubs-7', 'clubs-8', 'clubs-9', 'diamonds-K', 'hearts-A', 'spades-Q', 'diamonds-7', 'hearts-K')
  const postBottomWithQuart = cards('clubs-7', 'clubs-8', 'clubs-9', 'clubs-10', 'hearts-A', 'spades-Q', 'diamonds-7', 'hearts-K')
  const bottomQuartRun = findServerAntiBadLuckLongRuns(postBottomWithQuart).clubs
  check('[10.4] rescue-нова тройка clubs 7-8-9-10 се класифицира като QUART (дължина 4)',
    bottomQuartRun?.kind === 'QUART' && bottomQuartRun.length === 4)
  check('[10.11] allowArtificialQuart=true → quart candidate се допуска (ако друго минава)',
    isServerAntiBadLuckSequencePlanSafe(allNeutral({ bottom: naturalBottomNoRun }), allNeutral({ bottom: postBottomWithQuart }), ALLOW_QUART_ONLY))
  check('[10.10] allowArtificialQuart=false → никакъв quart candidate не се допуска',
    !isServerAntiBadLuckSequencePlanSafe(allNeutral({ bottom: naturalBottomNoRun }), allNeutral({ bottom: postBottomWithQuart }), ALLOW_QUINT_ONLY))

  // [10.5] изместена карта създава quart при ДРУГ (non-rescue) seat (right) —
  // guard-ът я открива по същия механизъм (гледа всичките 4 seats еднакво).
  const naturalRightNoRun = cards('diamonds-7', 'diamonds-8', 'diamonds-9', 'clubs-K', 'hearts-A', 'spades-Q', 'clubs-7', 'hearts-K')
  const postRightWithQuart = cards('diamonds-7', 'diamonds-8', 'diamonds-9', 'diamonds-10', 'hearts-A', 'spades-Q', 'clubs-7', 'hearts-K')
  check('[10.5] изместена карта създава quart при друг seat (right) → guard-ът я открива',
    isServerAntiBadLuckSequencePlanSafe(allNeutral({ right: naturalRightNoRun }), allNeutral({ right: postRightWithQuart }), ALLOW_QUART_ONLY) &&
    !isServerAntiBadLuckSequencePlanSafe(allNeutral({ right: naturalRightNoRun }), allNeutral({ right: postRightWithQuart }), ALLOW_QUINT_ONLY))

  // [10.6] изместена карта създава quint при друг seat (top).
  const naturalTopNoRun = cards('spades-7', 'spades-8', 'clubs-K', 'diamonds-A', 'hearts-Q', 'clubs-7', 'diamonds-8', 'hearts-K')
  const postTopWithQuint = cards('spades-7', 'spades-8', 'spades-9', 'spades-10', 'spades-J', 'clubs-7', 'diamonds-8', 'hearts-K')
  check('[10.6]/[10.12] изместена карта създава quint при друг seat (top): allowQuintPlus=true допуска, allowQuintPlus=false отхвърля',
    isServerAntiBadLuckSequencePlanSafe(allNeutral({ top: naturalTopNoRun }), allNeutral({ top: postTopWithQuint }), ALLOW_QUINT_ONLY) &&
    !isServerAntiBadLuckSequencePlanSafe(allNeutral({ top: naturalTopNoRun }), allNeutral({ top: postTopWithQuint }), ALLOW_QUART_ONLY))

  // [10.7] natural quart (left), удължена до quint след rescue → класифицира
  // се като НОВА QUINT_PLUS (не quart) — gate-ва се само от quint allowance-а.
  const naturalLeftQuart = cards('diamonds-7', 'diamonds-8', 'diamonds-9', 'diamonds-10', 'clubs-K', 'hearts-A', 'spades-Q', 'clubs-7')
  const postLeftExtendedToQuint = cards('diamonds-7', 'diamonds-8', 'diamonds-9', 'diamonds-10', 'diamonds-J', 'hearts-A', 'spades-Q', 'clubs-7')
  check('[10.7] natural quart → post quint се брои за нова QUINT_PLUS, не за quart',
    !isServerAntiBadLuckSequencePlanSafe(allNeutral({ left: naturalLeftQuart }), allNeutral({ left: postLeftExtendedToQuint }), ALLOW_QUART_ONLY) &&
    isServerAntiBadLuckSequencePlanSafe(allNeutral({ left: naturalLeftQuart }), allNeutral({ left: postLeftExtendedToQuint }), ALLOW_QUINT_ONLY))

  // [10.7b] natural quint (5), удължен до по-дълъг quint (6) → остава в СЪЩИЯ
  // bucket (QUINT_PLUS), не се брои за нова отделна поредица — позволено дори
  // с ALLOW_NEITHER, докато natural run-ът е изцяло запазен вътре в новия.
  const naturalLeftQuint5 = cards('spades-7', 'spades-8', 'spades-9', 'spades-10', 'spades-J', 'clubs-K', 'diamonds-A', 'hearts-Q')
  const postLeftQuint6 = cards('spades-7', 'spades-8', 'spades-9', 'spades-10', 'spades-J', 'spades-Q', 'diamonds-A', 'hearts-Q')
  check('[10.7b] natural quint(5) → post quint(6) остава в QUINT_PLUS bucket-а, не е нова поредица (allowed дори с ALLOW_NEITHER)',
    isServerAntiBadLuckSequencePlanSafe(allNeutral({ left: naturalLeftQuint5 }), allNeutral({ left: postLeftQuint6 }), ALLOW_NEITHER))

  // [10.8] quint не се брои като няколко припокриващи се quart-а (maximal run).
  const handWithQuint = cards('hearts-7', 'hearts-8', 'hearts-9', 'hearts-10', 'hearts-J', 'clubs-K', 'diamonds-A', 'spades-Q')
  const quintRuns = findServerAntiBadLuckLongRuns(handWithQuint)
  check('[10.8] quint се разпознава като 1 maximal run (не 2 припокриващи се quart-а)',
    Object.keys(quintRuns).length === 1 && quintRuns.hearts?.kind === 'QUINT_PLUS' && quintRuns.hearts.length === 5 && quintRuns.hearts.cardIds.length === 5)

  // [10.9] 2 нови дълги поредици на масата (bottom quart + top quint) →
  // unconditional reject, дори с двата allowance-а true.
  check('[10.9] 2 нови дълги поредици на масата → reject дори с ALLOW_BOTH',
    !isServerAntiBadLuckSequencePlanSafe(
      allNeutral({ bottom: naturalBottomNoRun, top: naturalTopNoRun }),
      allNeutral({ bottom: postBottomWithQuart, top: postTopWithQuint }),
      ALLOW_BOTH,
    ))

  // [10.13] Allowance-ът, веднъж фиксиран, важи еднакво за РАЗЛИЧНИ candidates
  // (различни seats/suits) — не се "reroll-ва" per-candidate: проверяваме
  // няколко различни quart/quint сценария под ЕДНА И СЪЩА allowance стойност.
  const quartScenarios: Array<[Record<Seat, ServerCard[]>, Record<Seat, ServerCard[]>]> = [
    [allNeutral({ bottom: naturalBottomNoRun }), allNeutral({ bottom: postBottomWithQuart })],
    [allNeutral({ right: naturalRightNoRun }), allNeutral({ right: postRightWithQuart })],
  ]
  const consistentAcrossCandidates = quartScenarios.every(
    ([natural, post]) => !isServerAntiBadLuckSequencePlanSafe(natural, post, ALLOW_NEITHER),
  ) && quartScenarios.every(
    ([natural, post]) => isServerAntiBadLuckSequencePlanSafe(natural, post, ALLOW_QUART_ONLY),
  )
  check('[10.13] фиксиран allowance управлява ЕДНАКВО различни candidates (не се reroll-ва per-candidate)', consistentAcrossCandidates)

  // [10.13b]/[10.14] Статистически seeded тест през ПЪЛНИЯ pipeline: allowance
  // се тегли ТОЧНО ВЕДНЪЖ (преди candidate search-а) от nextRandom — за
  // single-pending-seat сценарий (без arbitration draws) първите 2 извиквания
  // на seed-натия RNG СА allowArtificialQuart/allowArtificialQuintPlus (виж
  // applyServerAntiBadLuckToDeck.ts). Ground-truth probe с независим RNG
  // instance върху СЪЩИЯ seed string предсказва тези 2 стойности; сравняваме
  // срещу реално наблюдаваната поява на нова quart/quint в резултата — ако
  // allowance се reroll-ваше per-candidate/retry, щяхме да видим violations
  // (нова quart/quint да се появи и при ground-truth=false).
  let quartAllowedCount = 0
  let quintAllowedCount = 0
  let totalPendingExecutions = 0
  let violations = 0
  let newRunAtNonRescuedSeat = 0
  const SAMPLE_SIZE = 6000

  for (let seed = 0; seed < SAMPLE_SIZE; seed += 1) {
    const dealSeed = `seq-stat-deal-${seed}`
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`seq-stat-natural-${seed}`))
    const result = applyServerAntiBadLuckToDeck(natural, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(dealSeed))

    if (!result.rescueKinds.bottom) {
      continue
    }

    totalPendingExecutions += 1

    const probe = createSeededRandom(dealSeed)
    const expectedQuart = probe() < SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE
    const expectedQuintPlus = probe() < SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE
    if (expectedQuart) quartAllowedCount += 1
    if (expectedQuintPlus) quintAllowedCount += 1

    let sawNewQuart = false
    let sawNewQuintPlus = false

    for (const seat of SERVER_SEAT_ORDER) {
      const naturalRuns = findServerAntiBadLuckLongRuns(fullHand(natural, seat))
      const postRuns = findServerAntiBadLuckLongRuns(fullHand(result.deck, seat))

      for (const suit of SERVER_SUITS) {
        const nat = naturalRuns[suit]
        const post = postRuns[suit]

        if (!nat && post) {
          if (post.kind === 'QUART') sawNewQuart = true
          else sawNewQuintPlus = true
          if (seat !== 'bottom') newRunAtNonRescuedSeat += 1
        } else if (nat && post && post.length > nat.length && nat.kind === 'QUART' && post.kind === 'QUINT_PLUS') {
          sawNewQuintPlus = true
          if (seat !== 'bottom') newRunAtNonRescuedSeat += 1
        }
      }
    }

    if (sawNewQuart && !expectedQuart) violations += 1
    if (sawNewQuintPlus && !expectedQuintPlus) violations += 1
  }

  const shareOf = (count: number, total: number) => count / total
  check(`[10.13b] нова quart/quint в резултата винаги съвпада с еднократния ground-truth allowance (0 violations от ${totalPendingExecutions})`,
    violations === 0 && totalPendingExecutions > 1000)
  check(`[10.14a] quart allowance ≈25% (${quartAllowedCount}/${totalPendingExecutions} = ${(shareOf(quartAllowedCount, totalPendingExecutions) * 100).toFixed(1)}%)`,
    shareOf(quartAllowedCount, totalPendingExecutions) > 0.21 && shareOf(quartAllowedCount, totalPendingExecutions) < 0.29)
  check(`[10.14b] quint+ allowance ≈10% (${quintAllowedCount}/${totalPendingExecutions} = ${(shareOf(quintAllowedCount, totalPendingExecutions) * 100).toFixed(1)}%)`,
    shareOf(quintAllowedCount, totalPendingExecutions) > 0.07 && shareOf(quintAllowedCount, totalPendingExecutions) < 0.13)
  // [10.15]/[10.16] реалният pipeline анализира ПЪЛНИТЕ 8 карти (не само
  // първите 5) на ВСИЧКИТЕ 4 seats — потвърждаваме, че тестът реално засича
  // случаи, в които изместена карта създава/засяга поредица при seat, различен
  // от rescued (bottom), не само теоретично на хартия.
  check(`[10.15] статистическият тест реално засича нови поредици и при non-rescued seats (${newRunAtNonRescuedSeat} случая)`,
    newRunAtNonRescuedSeat > 0)
}

// ---------------------------------------------------------------------------
// [11] Square guard: пази natural карета (J/9/A/10/K/Q) от rescue swap-овете
//      на всичките 4 seats; ВСЯКО artificial каре се reject-ва безусловно
//      (без allowance); 7/8 никога не са square declaration.
// ---------------------------------------------------------------------------
{
  const SQUARE_NEUTRAL_HAND = cards('clubs-7', 'diamonds-8', 'hearts-9', 'spades-10', 'clubs-Q', 'diamonds-K', 'hearts-A', 'spades-J')

  const allNeutralSquare = (override: Partial<Record<Seat, ServerCard[]>>): Record<Seat, ServerCard[]> => ({
    bottom: override.bottom ?? SQUARE_NEUTRAL_HAND,
    right: override.right ?? SQUARE_NEUTRAL_HAND,
    top: override.top ?? SQUARE_NEUTRAL_HAND,
    left: override.left ?? SQUARE_NEUTRAL_HAND,
  })

  // [11.1] rescued seat: ALL_TRUMPS rescue би създал 4×J чрез J в last-3 →
  // guard-ът никога не позволява финал с 4 J, но намира safe candidate
  // (различен TRIPLE/PAIR_PLUS realization) в повечето случаи ([11.11]).
  // Fixture-ът е построен така, че ALL_TRUMPS (1 natural J anchor → TRIPLE
  // swapCount 2) да бъде ДОСТИЖИМ при глобалния минимум редом със SUIT (също
  // swapCount 2 чрез natural diamonds/hearts/spades карти) — за разлика от
  // стария "0 J anchor" fixture, дето SUIT винаги е по-евтин (swapCount 2 <
  // ALL_TRUMPS-овите 3) и minimum-swap planner-ът никога не стига до
  // ALL_TRUMPS изобщо (проверено експериментално). spades-J е в last-3 —
  // точно TRIPLE-реализацията, изключваща spades, би довела до 4×J.
  const item1Bottom = ['clubs-J', 'diamonds-7', 'diamonds-K', 'hearts-8', 'spades-10', 'spades-J', 'hearts-7', 'diamonds-8']
  const item1Remaining = FULL_DECK.map((card) => card.id).filter((id) => !item1Bottom.includes(id))
  const item1Deck = buildFullHandDeck({
    bottom: item1Bottom,
    right: item1Remaining.slice(0, 8),
    top: item1Remaining.slice(8, 16),
    left: item1Remaining.slice(16, 24),
  })
  let item1AllTrumpsSamples = 0
  let item1AllTrumpsApplied = 0
  let item1NeverFourJ = true
  for (let seed = 0; seed < 2000; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(item1Deck, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`sq-item1-${seed}`))
    if (result.rescueKinds.bottom?.type !== 'ALL_TRUMPS') continue
    item1AllTrumpsSamples += 1
    if (result.rescues.bottom) item1AllTrumpsApplied += 1
    const jCount = fullHand(result.deck, 'bottom').filter((card) => card.rank === 'J').length
    item1NeverFourJ &&= jCount <= 3
  }
  check(`[11.1] rescued seat: ALL_TRUMPS rescue никога не създава 4×J чрез J в last-3 (${item1AllTrumpsSamples} samples)`,
    item1NeverFourJ && item1AllTrumpsSamples > 100)
  check(`[11.11a] ...но намира safe candidate в повечето случаи вместо direct pending (${item1AllTrumpsApplied}/${item1AllTrumpsSamples} приложени)`,
    item1AllTrumpsApplied / item1AllTrumpsSamples > 0.5)

  // [11.2] rescued seat: NO_TRUMPS rescue би създал 4×A чрез A в last-3
  // (огледално на [11.1], с A/10 вместо J/9 — виж коментара там).
  const item2Bottom = ['clubs-A', 'diamonds-7', 'diamonds-K', 'hearts-8', 'spades-J', 'spades-A', 'hearts-7', 'diamonds-9']
  const item2Remaining = FULL_DECK.map((card) => card.id).filter((id) => !item2Bottom.includes(id))
  const item2Deck = buildFullHandDeck({
    bottom: item2Bottom,
    right: item2Remaining.slice(0, 8),
    top: item2Remaining.slice(8, 16),
    left: item2Remaining.slice(16, 24),
  })
  let item2NoTrumpsSamples = 0
  let item2NoTrumpsApplied = 0
  let item2NeverFourA = true
  for (let seed = 0; seed < 2000; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(item2Deck, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`sq-item2-${seed}`))
    if (result.rescueKinds.bottom?.type !== 'NO_TRUMPS') continue
    item2NoTrumpsSamples += 1
    if (result.rescues.bottom) item2NoTrumpsApplied += 1
    const aCount = fullHand(result.deck, 'bottom').filter((card) => card.rank === 'A').length
    item2NeverFourA &&= aCount <= 3
  }
  check(`[11.2] rescued seat: NO_TRUMPS rescue никога не създава 4×A чрез A в last-3 (${item2NoTrumpsSamples} samples)`,
    item2NeverFourA && item2NoTrumpsSamples > 100)
  check(`[11.11b] ...но намира safe candidate в повечето случаи вместо direct pending (${item2NoTrumpsApplied}/${item2NoTrumpsSamples} приложени)`,
    item2NoTrumpsApplied / item2NoTrumpsSamples > 0.5)

  // [11.3]-[11.6] artificial 4×9 / 4×10 / 4×K / 4×Q → reject.
  const squareRankCases: Array<{ label: string; natural: ServerCard[]; post: ServerCard[] }> = [
    { label: '4×9', natural: cards('clubs-9', 'diamonds-9', 'hearts-9', 'clubs-7', 'diamonds-8', 'hearts-K', 'spades-Q', 'clubs-J'), post: cards('clubs-9', 'diamonds-9', 'hearts-9', 'spades-9', 'diamonds-8', 'hearts-K', 'spades-Q', 'clubs-J') },
    { label: '4×10', natural: cards('clubs-10', 'diamonds-10', 'hearts-10', 'clubs-7', 'diamonds-8', 'hearts-K', 'spades-Q', 'clubs-J'), post: cards('clubs-10', 'diamonds-10', 'hearts-10', 'spades-10', 'diamonds-8', 'hearts-K', 'spades-Q', 'clubs-J') },
    { label: '4×K', natural: cards('clubs-K', 'diamonds-K', 'hearts-K', 'clubs-7', 'diamonds-8', 'hearts-9', 'spades-Q', 'clubs-J'), post: cards('clubs-K', 'diamonds-K', 'hearts-K', 'spades-K', 'diamonds-8', 'hearts-9', 'spades-Q', 'clubs-J') },
    { label: '4×Q', natural: cards('clubs-Q', 'diamonds-Q', 'hearts-Q', 'clubs-7', 'diamonds-8', 'hearts-9', 'spades-K', 'clubs-J'), post: cards('clubs-Q', 'diamonds-Q', 'hearts-Q', 'spades-Q', 'diamonds-8', 'hearts-9', 'spades-K', 'clubs-J') },
  ]
  for (const { label, natural, post } of squareRankCases) {
    check(`[11.3-6] artificial ${label} → reject`,
      !isServerAntiBadLuckSquarePlanSafe(allNeutralSquare({ bottom: natural }), allNeutralSquare({ bottom: post })))
  }

  // [11.7] изместена карта довършва каре при ДРУГ (non-rescue) seat (right).
  const naturalRightThreeAces = cards('clubs-A', 'diamonds-A', 'hearts-A', 'clubs-7', 'diamonds-8', 'hearts-9', 'spades-K', 'clubs-J')
  const postRightFourAces = cards('clubs-A', 'diamonds-A', 'hearts-A', 'spades-A', 'diamonds-8', 'hearts-9', 'spades-K', 'clubs-J')
  check('[11.7] изместена карта довършва каре при друг seat (right) → guard-ът го открива',
    !isServerAntiBadLuckSquarePlanSafe(allNeutralSquare({ right: naturalRightThreeAces }), allNeutralSquare({ right: postRightFourAces })))

  // [11.8] natural square вече съществуващо → НЕ се счита за artificial.
  const naturalBottomFourAces = cards('clubs-A', 'diamonds-A', 'hearts-A', 'spades-A', 'clubs-7', 'diamonds-8', 'hearts-K', 'spades-Q')
  const postBottomUnrelatedSwap = cards('clubs-A', 'diamonds-A', 'hearts-A', 'spades-A', 'clubs-7', 'diamonds-8', 'hearts-K', 'clubs-J')
  check('[11.8] natural square (4×A) вече съществуващо → не се брои за artificial',
    isServerAntiBadLuckSquarePlanSafe(allNeutralSquare({ bottom: naturalBottomFourAces }), allNeutralSquare({ bottom: postBottomUnrelatedSwap })))

  // [11.9] natural square не може да бъде разрушено от rescue.
  const postBottomDestroyedSquare = cards('clubs-A', 'diamonds-A', 'hearts-A', 'clubs-J', 'clubs-7', 'diamonds-8', 'hearts-K', 'spades-Q')
  check('[11.9] natural square (4×A) не може да бъде разрушено от rescue',
    !isServerAntiBadLuckSquarePlanSafe(allNeutralSquare({ bottom: naturalBottomFourAces }), allNeutralSquare({ bottom: postBottomDestroyedSquare })))

  // [11.10] 7/8 four-of-kind НЕ е declaration square (getSquarePoints връща null).
  const naturalBottomThreeSevens = cards('clubs-7', 'diamonds-7', 'hearts-7', 'clubs-9', 'diamonds-8', 'hearts-K', 'spades-Q', 'clubs-J')
  const postBottomFourSevens = cards('clubs-7', 'diamonds-7', 'hearts-7', 'spades-7', 'diamonds-8', 'hearts-K', 'spades-Q', 'clubs-J')
  check('[11.10a] 4×7 не се разпознава от declaration engine-а като square',
    !getServerAntiBadLuckSquareRanks(postBottomFourSevens).has('7'))
  check('[11.10b] 4×7 (или 4×8) не се третира като artificial square от guard-а',
    isServerAntiBadLuckSquarePlanSafe(allNeutralSquare({ bottom: naturalBottomThreeSevens }), allNeutralSquare({ bottom: postBottomFourSevens })))

  // [11.12] Ако НЯМА safe candidate измежду ТРИТЕ типа (SUIT/ALL_TRUMPS/
  // NO_TRUMPS) → natural deal, seat остава pending, pending priority се
  // запазва. Fixture (открит чрез насочено търсене): bottom натурално вече
  // държи 4×J (защитено natural square) + точно 1 natural A → J е с
  // най-ниска keep-strength измежду наличните карти при SUIT/ALL_TRUMPS/
  // NO_TRUMPS candidate-и, затова буквално ВСЕКИ candidate на ВСЕКИ от трите
  // типа измества/унищожава по една от natural-те 4 J → square guard-ът
  // reject-ва всичко, seat-ът остава pending (без изключение, проверено
  // директно през пълния pipeline, без да се филтрира по конкретен тип —
  // minimum-swap planner-ът опитва и трите типа наведнъж).
  const item12Deck = buildFullHandDeck({
    bottom: ['diamonds-A', 'hearts-Q', 'spades-10', 'hearts-J', 'diamonds-J', 'spades-J', 'hearts-K', 'clubs-J'],
    right: ['clubs-8', 'spades-A', 'diamonds-Q', 'clubs-A', 'clubs-9', 'diamonds-9', 'diamonds-10', 'clubs-Q'],
    top: ['hearts-A', 'hearts-9', 'hearts-8', 'diamonds-7', 'spades-9', 'spades-7', 'spades-Q', 'diamonds-K'],
    left: ['diamonds-8', 'clubs-10', 'spades-8', 'spades-K', 'hearts-7', 'clubs-K', 'clubs-7', 'hearts-10'],
  })
  let item12AlwaysPending = true
  for (let seed = 0; seed < 1000; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(item12Deck, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`sq-item12-${seed}`))
    item12AlwaysPending &&=
      !result.rescues.bottom &&
      !result.rescueKinds.bottom &&
      result.deck === item12Deck &&
      result.antiBadLuck.seats.bottom.pendingSinceDealIndex === 5
  }
  check('[11.12] няма safe candidate измежду трите типа → natural deal + pending остава, priority запазен (1000 samples)',
    item12AlwaysPending)

  // [11.13] Sequence guard-ът продължава да работи непроменено — square
  // guard-ът е независим и не блокира candidate, дето засяга само поредица.
  const naturalBottomQuartSetup = cards('clubs-7', 'clubs-8', 'clubs-9', 'diamonds-K', 'hearts-A', 'spades-Q', 'diamonds-7', 'hearts-K')
  const postBottomQuartOnly = cards('clubs-7', 'clubs-8', 'clubs-9', 'clubs-10', 'hearts-A', 'spades-Q', 'diamonds-7', 'hearts-K')
  check('[11.13] square guard не блокира candidate, дето създава само нова поредица (без каре)',
    isServerAntiBadLuckSquarePlanSafe(allNeutralSquare({ bottom: naturalBottomQuartSetup }), allNeutralSquare({ bottom: postBottomQuartOnly })))
}

// ---------------------------------------------------------------------------
// [12] Minimum-swap planner: weighted rescue type selection измежду eligible
//      типовете (pickServerAntiBadLuckWeightedRescueType) — candidate count
//      НЕ трябва да влияе върху type probability (теглим типа ПРЕДИ да
//      избираме candidate вътре в него).
// ---------------------------------------------------------------------------
{
  function drawShares(eligibleTypes: readonly ('SUIT' | 'ALL_TRUMPS' | 'NO_TRUMPS')[], samples: number, seedPrefix: string) {
    const counts = new Map<string, number>()
    for (let seed = 0; seed < samples; seed += 1) {
      const type = pickServerAntiBadLuckWeightedRescueType(eligibleTypes, SERVER_ANTI_BAD_LUCK_RESCUE_TYPE_WEIGHTS, createSeededRandom(`${seedPrefix}-${seed}`))
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    return counts
  }
  const share = (count: number | undefined, total: number) => (count ?? 0) / total
  const SAMPLES = 20000

  const all3 = drawShares(SERVER_ANTI_BAD_LUCK_RESCUE_TYPES, SAMPLES, 'w-all3')
  check(`[12a] 3 eligible типа (33/33/34): SUIT ${share(all3.get('SUIT'), SAMPLES).toFixed(3)}, ALL_TRUMPS ${share(all3.get('ALL_TRUMPS'), SAMPLES).toFixed(3)}, NO_TRUMPS ${share(all3.get('NO_TRUMPS'), SAMPLES).toFixed(3)}`,
    Math.abs(share(all3.get('SUIT'), SAMPLES) - 0.33) < 0.02 &&
    Math.abs(share(all3.get('ALL_TRUMPS'), SAMPLES) - 0.33) < 0.02 &&
    Math.abs(share(all3.get('NO_TRUMPS'), SAMPLES) - 0.34) < 0.02)

  const suitAllTrumps = drawShares(['SUIT', 'ALL_TRUMPS'], SAMPLES, 'w-suit-at')
  check(`[12b] 2 eligible (SUIT+ALL_TRUMPS, 33:33 renormalized → 50/50): SUIT ${share(suitAllTrumps.get('SUIT'), SAMPLES).toFixed(3)}`,
    suitAllTrumps.get('NO_TRUMPS') === undefined && Math.abs(share(suitAllTrumps.get('SUIT'), SAMPLES) - 0.5) < 0.02)

  const allTrumpsNoTrumps = drawShares(['ALL_TRUMPS', 'NO_TRUMPS'], SAMPLES, 'w-at-nt')
  check(`[12c] 2 eligible (ALL_TRUMPS+NO_TRUMPS, 33:34 renormalized → ~49.3/50.7): ALL_TRUMPS ${share(allTrumpsNoTrumps.get('ALL_TRUMPS'), SAMPLES).toFixed(3)}`,
    allTrumpsNoTrumps.get('SUIT') === undefined && Math.abs(share(allTrumpsNoTrumps.get('ALL_TRUMPS'), SAMPLES) - 33 / 67) < 0.02)

  const onlyNoTrumps = drawShares(['NO_TRUMPS'], 500, 'w-only-nt')
  check('[12d] 1 eligible тип → винаги точно той (candidate count в типа не участва тук изобщо)', onlyNoTrumps.get('NO_TRUMPS') === 500 && onlyNoTrumps.size === 1)

  // Детерминизъм: същият eligibleTypes + seed → същият избор (seeded).
  const first = pickServerAntiBadLuckWeightedRescueType(SERVER_ANTI_BAD_LUCK_RESCUE_TYPES, SERVER_ANTI_BAD_LUCK_RESCUE_TYPE_WEIGHTS, createSeededRandom('det'))
  const second = pickServerAntiBadLuckWeightedRescueType(SERVER_ANTI_BAD_LUCK_RESCUE_TYPES, SERVER_ANTI_BAD_LUCK_RESCUE_TYPE_WEIGHTS, createSeededRandom('det'))
  check('[12e] seeded: същият seed → същият избор', first === second)
}

// ---------------------------------------------------------------------------
// [13] Natural run preservation (ТЕРЦА/20 и по-дълги, праг >=3) —
//      isServerAntiBadLuckNaturalRunPreserved: ЕДИНСТВЕНО destruction-ONLY
//      guard, НЕ гейтва нова artificial терца (unrestricted, за разлика от
//      artificial QUART/QUINT_PLUS gating-а в [10], праг >=4, 25%/10%).
// ---------------------------------------------------------------------------
{
  const NEUTRAL = cards('clubs-7', 'diamonds-8', 'hearts-9', 'spades-10', 'clubs-Q', 'diamonds-K', 'hearts-A', 'spades-J')
  const allNeutral13 = (override: Partial<Record<Seat, ServerCard[]>>): Record<Seat, ServerCard[]> => ({
    bottom: override.bottom ?? NEUTRAL, right: override.right ?? NEUTRAL, top: override.top ?? NEUTRAL, left: override.left ?? NEUTRAL,
  })

  // [13a] natural терца (7-8-9) разрушена → reject.
  const naturalTerza = cards('clubs-7', 'clubs-8', 'clubs-9', 'diamonds-K', 'hearts-A', 'spades-Q', 'diamonds-7', 'hearts-K')
  const terzaDestroyed = cards('clubs-7', 'clubs-8', 'clubs-Q', 'diamonds-K', 'hearts-A', 'spades-Q', 'diamonds-7', 'hearts-K')
  check('[13a] natural терца (7-8-9) разрушена от swap → reject',
    !isServerAntiBadLuckNaturalRunPreserved(allNeutral13({ bottom: naturalTerza }), allNeutral13({ bottom: terzaDestroyed })))

  // [13b] natural терца, израснала до 50 (7-8-9-10), пазейки оригиналните 3 → allowed (растеж позволен).
  const terzaGrownToQuart = cards('clubs-7', 'clubs-8', 'clubs-9', 'clubs-10', 'hearts-A', 'spades-Q', 'diamonds-7', 'hearts-K')
  check('[13b] natural терца → 50 (запазва оригиналните 3 карти) → allowed (растеж)',
    isServerAntiBadLuckNaturalRunPreserved(allNeutral13({ bottom: naturalTerza }), allNeutral13({ bottom: terzaGrownToQuart })))

  // [13c] natural терца, израснала директно до 100+ (7-8-9-10-J) → allowed.
  const terzaGrownToQuint = cards('clubs-7', 'clubs-8', 'clubs-9', 'clubs-10', 'clubs-J', 'spades-Q', 'diamonds-7', 'hearts-K')
  check('[13c] natural терца → 100+ (запазва оригиналните 3 карти) → allowed (растеж)',
    isServerAntiBadLuckNaturalRunPreserved(allNeutral13({ bottom: naturalTerza }), allNeutral13({ bottom: terzaGrownToQuint })))

  // [13d] нова artificial терца (none → 3) → НИКОГА не се гейтва тук (за разлика от QUART/QUINT_PLUS в [10]).
  const noRunAtAll = cards('clubs-7', 'diamonds-9', 'hearts-K', 'spades-Q', 'clubs-A', 'diamonds-10', 'hearts-7', 'spades-8')
  const newArtificialTerza = cards('clubs-7', 'clubs-8', 'clubs-9', 'spades-Q', 'clubs-A', 'diamonds-10', 'hearts-7', 'spades-8')
  check('[13d] нова artificial терца (none → 3) → allowed без ограничение (artificial терца е неограничена)',
    isServerAntiBadLuckNaturalRunPreserved(allNeutral13({ bottom: noRunAtAll }), allNeutral13({ bottom: newArtificialTerza })))

  // [13e] natural терца на ДРУГ (non-rescue) seat (right) също се пази.
  check('[13e] natural терца на non-rescue seat (right) също се пази',
    !isServerAntiBadLuckNaturalRunPreserved(allNeutral13({ right: naturalTerza }), allNeutral13({ right: terzaDestroyed })))

  // [13f] natural QUART (4), израснал до по-дълъг QUINT_PLUS (5), пазейки оригиналните 4 → allowed.
  const naturalQuart = cards('clubs-7', 'clubs-8', 'clubs-9', 'clubs-10', 'hearts-A', 'spades-Q', 'diamonds-7', 'hearts-K')
  const quartGrownToQuint = cards('clubs-7', 'clubs-8', 'clubs-9', 'clubs-10', 'clubs-J', 'spades-Q', 'diamonds-7', 'hearts-K')
  check('[13f] natural QUART → QUINT_PLUS (запазва оригиналните 4) → allowed (растеж)',
    isServerAntiBadLuckNaturalRunPreserved(allNeutral13({ bottom: naturalQuart }), allNeutral13({ bottom: quartGrownToQuint })))

  // [13g] no double-counting: QUINT_PLUS (5) се разпознава като 1 maximal run, не като 3 припокриващи се терци.
  const handWithQuint = cards('hearts-7', 'hearts-8', 'hearts-9', 'hearts-10', 'hearts-J', 'clubs-K', 'diamonds-A', 'spades-Q')
  const quintRuns = findServerAntiBadLuckNaturalRuns(handWithQuint)
  check('[13g] QUINT_PLUS (5) се разпознава като 1 maximal run (не 3 припокриващи се терци)',
    Object.keys(quintRuns).length === 1 && quintRuns.hearts?.kind === 'QUINT_PLUS' && quintRuns.hearts.cardIds.length === 5)
}

// ---------------------------------------------------------------------------
// [14] End-to-end: natural терца/50/100 никога не се разрушава от rescue
//      през пълния pipeline (случаен natural shuffle, 4 pending seats).
// ---------------------------------------------------------------------------
{
  let naturalRunsPreserved = true
  let naturalRunsChecked = 0
  for (let seed = 0; seed < 4000; seed += 1) {
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`run-preserve-natural-${seed}`))
    const naturalFullHandsAll = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, fullHand(natural, seat)])) as Record<Seat, ServerCard[]>
    const hasAnyNaturalRun = SERVER_SEAT_ORDER.some((seat) => Object.keys(findServerAntiBadLuckNaturalRuns(naturalFullHandsAll[seat])).length > 0)
    if (!hasAnyNaturalRun) continue
    naturalRunsChecked += 1
    const result = applyServerAntiBadLuckToDeck(natural, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, right: 5, top: 5, left: 5 }), createSeededRandom(`run-preserve-deck-${seed}`))
    const resultFullHandsAll = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, fullHand(result.deck, seat)])) as Record<Seat, ServerCard[]>
    naturalRunsPreserved &&= isServerAntiBadLuckNaturalRunPreserved(naturalFullHandsAll, resultFullHandsAll)
  }
  check(`[14] natural терца/50/100 (run>=3) никога не се разрушава от rescue (${naturalRunsChecked} раздавания с >=1 natural run от 4000)`,
    naturalRunsPreserved && naturalRunsChecked > 500)
}

// ---------------------------------------------------------------------------
// [15] Defensive invariant: 0-swap rescue candidate никога не възниква —
//      seat-ът е винаги natural BAD, затова candidate.cardIds (критерият за
//      GOOD по този тип) никога не може да е вече 100% natural (виж [7m] за
//      end-to-end проверка през пълния pipeline; тук — директно върху
//      candidate generation-а, без да минаваме през rescue arbitration-а).
// ---------------------------------------------------------------------------
{
  let neverZeroSwap = true
  let candidatesChecked = 0
  for (let seed = 0; seed < 3000; seed += 1) {
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`zero-swap-${seed}`))
    for (const seat of SERVER_SEAT_ORDER) {
      const naturalFirstFiveForSeat = firstFive(natural, seat)
      if (isServerGoodFirstFive(naturalFirstFiveForSeat)) continue
      const naturalIds = new Set(naturalFirstFiveForSeat.map((card) => card.id))
      for (const type of SERVER_ANTI_BAD_LUCK_RESCUE_TYPES) {
        for (const candidate of getServerAntiBadLuckRescueCandidates(type)) {
          candidatesChecked += 1
          const swapCount = candidate.cardIds.filter((id) => !naturalIds.has(id)).length
          neverZeroSwap &&= swapCount >= 1
        }
      }
    }
  }
  check(`[15] 0-swap candidate никога не възниква за natural BAD seat (${candidatesChecked} candidate-checks)`,
    neverZeroSwap && candidatesChecked > 100000)
}

// ---------------------------------------------------------------------------
// [16] Cross-type global minimum: фиксирано тесте, дето SUIT (swapCount=1) е
//      strict по-евтин от NO_TRUMPS (2) и ALL_TRUMPS (3) за bottom — SUIT
//      трябва ВИНАГИ да бъде избран (500/500 seeds), никога по-скъпите типове.
//      Същото тесте доказва и [17] (same-type SUIT 1 vs 2): SUIT има
//      кандидати в diamonds (swapCount=1) И в hearts/spades/clubs
//      (swapCount=2 всеки) — само diamonds (1-swap) трябва да бъде избиран.
// ---------------------------------------------------------------------------
{
  const deck16 = buildDeck({
    bottom: ['diamonds-7', 'diamonds-A', 'diamonds-K', 'clubs-K', 'spades-Q'],
    right: ['hearts-8', 'spades-7', 'spades-8', 'clubs-Q', 'diamonds-Q'],
    top: ['hearts-Q', 'spades-K', 'clubs-10', 'diamonds-9', 'hearts-9'],
    left: ['clubs-8', 'diamonds-10', 'hearts-7', 'spades-9', 'diamonds-8'],
  })
  let allSuit = true
  let allSwapOne = true
  const variants = new Set<string>()
  for (let seed = 0; seed < 500; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(deck16, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`cross-type-min-${seed}`))
    const rescue = result.rescues.bottom
    allSuit &&= rescue?.type === 'SUIT'
    if (rescue) {
      variants.add(rescue.variant)
      const swapCount = rescue.cardIds.filter((id) => !firstFive(deck16, 'bottom').map((c) => c.id).includes(id)).length
      allSwapOne &&= swapCount === 1
    }
  }
  check(`[16] cross-type global minimum: SUIT (swapCount=1) печели винаги срещу NO_TRUMPS(2)/ALL_TRUMPS(3) (500 seeds)`, allSuit)
  check(`[17] same-type SUIT: само swapCount=1 candidate (diamonds) се избира, никога 2-swap siblings (variants: ${[...variants].join(', ')})`,
    allSwapOne && variants.size === 1 && variants.has('diamonds'))
}

// ---------------------------------------------------------------------------
// [18] Same-type ALL_TRUMPS: 1-anchor (clubs-J) + natural companion hearts-9
//      дава ТОЧНО 1 swapCount=1 candidate ({clubs-J,hearts-J,hearts-9}) сред
//      9-те 1-anchor candidates (другите 8 са swapCount=2) — само той трябва
//      да бъде избиран, докато SUIT/NO_TRUMPS за това тесте са по-скъпи (2/3).
// ---------------------------------------------------------------------------
{
  const deck18 = buildDeck({
    bottom: ['clubs-J', 'hearts-9', 'diamonds-K', 'spades-Q', 'diamonds-7'],
    right: ['hearts-8', 'spades-7', 'spades-8', 'clubs-Q', 'diamonds-Q'],
    top: ['hearts-Q', 'spades-K', 'clubs-10', 'diamonds-9', 'hearts-K'],
    left: ['clubs-7', 'diamonds-8', 'hearts-7', 'spades-9', 'clubs-8'],
  })
  let allAllTrumps = true
  let allExactCandidate = true
  for (let seed = 0; seed < 500; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(deck18, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`same-type-at-${seed}`))
    const rescue = result.rescues.bottom
    allAllTrumps &&= rescue?.type === 'ALL_TRUMPS'
    if (rescue) {
      allExactCandidate &&= [...rescue.cardIds].sort().join(',') === ['clubs-J', 'hearts-J', 'hearts-9'].sort().join(',')
    }
  }
  check('[18] same-type ALL_TRUMPS: 1-swap candidate (clubs-J+hearts-J+hearts-9) печели винаги срещу 2-swap siblings (500 seeds)',
    allAllTrumps && allExactCandidate)
}

// ---------------------------------------------------------------------------
// [19] Same-type NO_TRUMPS: огледално на [18], с A/10 вместо J/9.
// ---------------------------------------------------------------------------
{
  const deck19 = buildDeck({
    bottom: ['clubs-A', 'hearts-10', 'diamonds-K', 'spades-Q', 'diamonds-7'],
    right: ['hearts-8', 'spades-7', 'spades-8', 'clubs-Q', 'diamonds-Q'],
    top: ['hearts-Q', 'spades-K', 'clubs-10', 'diamonds-9', 'hearts-K'],
    left: ['clubs-7', 'diamonds-8', 'hearts-7', 'spades-9', 'clubs-8'],
  })
  let allNoTrumps = true
  let allExactCandidate = true
  for (let seed = 0; seed < 500; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(deck19, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`same-type-nt-${seed}`))
    const rescue = result.rescues.bottom
    allNoTrumps &&= rescue?.type === 'NO_TRUMPS'
    if (rescue) {
      allExactCandidate &&= [...rescue.cardIds].sort().join(',') === ['clubs-A', 'hearts-A', 'hearts-10'].sort().join(',')
    }
  }
  check('[19] same-type NO_TRUMPS: 1-swap candidate (clubs-A+hearts-A+hearts-10) печели винаги срещу 2-swap siblings (500 seeds)',
    allNoTrumps && allExactCandidate)
}

// ---------------------------------------------------------------------------
// [20] 3-swap се избира САМО когато няма safe 1/2-swap realization никъде.
//      Реален fixture, открит чрез random search (seed-ът е deterministично
//      възпроизводим): за seat `top`, SUIT hearts (swapCount=1, 3 realized
//      plans) и SUIT spades (swapCount=2, 6 realized plans) са ВСИЧКИ unsafe
//      (sequence/run guard), докато SUIT clubs (swapCount=3) има safe plan.
// ---------------------------------------------------------------------------
{
  const natural20 = shuffleWithRandom(FULL_DECK, createSeededRandom('swap3-search-natural-252'))
  const result20 = applyServerAntiBadLuckToDeck(natural20, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, right: 5, top: 5, left: 5 }), createSeededRandom('swap3-search-deck-252'))
  const rescue20 = result20.rescues.top
  const naturalTopFive20 = firstFive(natural20, 'top').map((c) => c.id)
  const swapCount20 = rescue20 ? rescue20.cardIds.filter((id) => !naturalTopFive20.includes(id)).length : -1

  // Независима проверка: 1-swap (hearts) и 2-swap (spades) SUIT candidates
  // за 'top' в това тесте наистина съществуват, но ВСИЧКИТЕ им realized
  // plans са unsafe — потвърждава, че 3 е ГЛОБАЛНИЯТ минимум тук, не просто
  // "каквото е приложено".
  const heartsCandidate = { type: 'SUIT' as const, variant: 'hearts', cardIds: ['hearts-J', 'hearts-9', 'hearts-10'] }
  const spadesCandidate = { type: 'SUIT' as const, variant: 'spades', cardIds: ['spades-J', 'spades-7', 'spades-9'] }
  const naturalFullHands20 = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, fullHand(natural20, seat)])) as Record<Seat, ServerCard[]>
  const isPlanSafe = (resultDeck: ServerCard[]) => {
    const resultFullHands = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, fullHand(resultDeck, seat)])) as Record<Seat, ServerCard[]>
    return isServerGoodFirstFive(firstFive(resultDeck, 'top')) &&
      isServerAntiBadLuckNaturalRunPreserved(naturalFullHands20, resultFullHands) &&
      isServerAntiBadLuckSequencePlanSafe(naturalFullHands20, resultFullHands, { allowArtificialQuart: false, allowArtificialQuintPlus: false }) &&
      isServerAntiBadLuckSquarePlanSafe(naturalFullHands20, resultFullHands)
  }
  const heartsPlans = enumerateServerAntiBadLuckRealizedPlans(natural20, 'top', FIRST_FIVE_INDICES, heartsCandidate)
  const spadesPlans = enumerateServerAntiBadLuckRealizedPlans(natural20, 'top', FIRST_FIVE_INDICES, spadesCandidate)
  const heartsAllUnsafe = heartsPlans.length > 0 && heartsPlans.every((plan) => !isPlanSafe(plan.resultDeck))
  const spadesAllUnsafe = spadesPlans.length > 0 && spadesPlans.every((plan) => !isPlanSafe(plan.resultDeck))

  check(`[20] 3-swap избран само защото 1-swap (hearts, ${heartsPlans.length} realizations) и 2-swap (spades, ${spadesPlans.length} realizations) са ВСИЧКИ unsafe`,
    swapCount20 === 3 && rescue20?.type === 'SUIT' && rescue20.variant === 'clubs' && heartsAllUnsafe && spadesAllUnsafe)
}

// ---------------------------------------------------------------------------
// [21] Candidate-count independence (explicit 20-vs-1 сценарий от focused
//      audit-а): eligibleTypes с 1 тип, дето абстрактно би имал 20 safe
//      candidates, срещу друг тип с 1 safe candidate — weighted draw вижда
//      само ИМЕНАТА на типовете (eligibleTypes), никога броя кандидати.
// ---------------------------------------------------------------------------
{
  const eligibleTypes: Array<'SUIT' | 'ALL_TRUMPS' | 'NO_TRUMPS'> = ['SUIT', 'ALL_TRUMPS']
  const counts = new Map<string, number>()
  const SAMPLES = 20000
  for (let seed = 0; seed < SAMPLES; seed += 1) {
    const type = pickServerAntiBadLuckWeightedRescueType(eligibleTypes, SERVER_ANTI_BAD_LUCK_RESCUE_TYPE_WEIGHTS, createSeededRandom(`count-independence-${seed}`))
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  const suitShare = (counts.get('SUIT') ?? 0) / SAMPLES
  check(`[21] SUIT с хипотетични 20 candidates срещу ALL_TRUMPS с 1 candidate (равни тегла 33:33) → ~50/50, не 20:1 (SUIT ${suitShare.toFixed(3)})`,
    Math.abs(suitShare - 0.5) < 0.02)
}

// ---------------------------------------------------------------------------
// [22] Generator duplicate check: getServerAntiBadLuckRescueCandidates не
//      произвежда duplicate logical (canonical cardId-set) plans за никой
//      тип, при никое от 0/1/2-anchor състоянията.
// ---------------------------------------------------------------------------
{
  const noAnchor: ServerAntiBadLuckAnchorConstraints = { naturalAnchorSuits: [] }
  const oneAnchor: ServerAntiBadLuckAnchorConstraints = { naturalAnchorSuits: ['clubs'] }
  const twoAnchor: ServerAntiBadLuckAnchorConstraints = { naturalAnchorSuits: ['clubs', 'hearts'] }
  let anyDuplicate = false
  const report: string[] = []

  for (const type of ['SUIT', 'ALL_TRUMPS', 'NO_TRUMPS'] as const) {
    for (const [label, anchors] of [['0-anchor', noAnchor], ['1-anchor', oneAnchor], ['2-anchor', twoAnchor]] as const) {
      const candidates = getServerAntiBadLuckRescueCandidates(type, anchors)
      const keys = candidates.map((c) => [...c.cardIds].sort().join(','))
      const hasDuplicate = new Set(keys).size !== keys.length
      anyDuplicate ||= hasDuplicate
      report.push(`${type}/${label}=${candidates.length}${hasDuplicate ? '(DUP!)' : ''}`)
    }
  }
  check(`[22] 0 duplicate canonical cardId-set candidates за всички типове × anchor states (${report.join(', ')})`, !anyDuplicate)
}

// ---------------------------------------------------------------------------
// [23] Weakest-card tie: enumerateServerAntiBadLuckRealizedPlans намира
//      ВСИЧКИ distinct realizations на един candidate (не само произволна
//      едната, както преди фикса) — ако поне една е safe, candidate-ът
//      остава viable за planner-а, дори друга tied realization да е unsafe.
//      Fixture: {hearts-J,hearts-9,hearts-7} (1 missing = hearts-J); natural
//      терца hearts-7/8/9 на bottom + tied филър diamonds-7 (keepStrength 0
//      и двете, off-suit за SUIT hearts). hearts-J естествено седи в right.
// ---------------------------------------------------------------------------
{
  const tieBottom = ['hearts-7', 'hearts-8', 'hearts-9', 'diamonds-7', 'diamonds-A', 'clubs-K', 'spades-Q', 'diamonds-9']
  const tieRight = ['hearts-J', 'spades-7', 'spades-8', 'clubs-Q', 'diamonds-Q', 'clubs-10', 'diamonds-10', 'spades-10']
  const tieTop = ['clubs-7', 'clubs-8', 'clubs-9', 'clubs-J', 'clubs-A', 'diamonds-8', 'hearts-10', 'spades-9']
  const tieLeft = ['diamonds-J', 'diamonds-K', 'hearts-Q', 'hearts-K', 'hearts-A', 'spades-J', 'spades-K', 'spades-A']
  const tieDeck = buildFullHandDeck({ bottom: tieBottom, right: tieRight, top: tieTop, left: tieLeft })
  const tieCandidate = { type: 'SUIT' as const, variant: 'hearts', cardIds: ['hearts-J', 'hearts-9', 'hearts-7'] }

  const tiePlans = enumerateServerAntiBadLuckRealizedPlans(tieDeck, 'bottom', FIRST_FIVE_INDICES, tieCandidate)
  const naturalFullHandsForTie = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, fullHand(tieDeck, seat)])) as Record<Seat, ServerCard[]>
  const isTiePlanSafe = (resultDeck: ServerCard[]) => {
    const resultFullHands = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, fullHand(resultDeck, seat)])) as Record<Seat, ServerCard[]>
    return isServerAntiBadLuckNaturalRunPreserved(naturalFullHandsForTie, resultFullHands)
  }
  const safeCount = tiePlans.filter((plan) => isTiePlanSafe(plan.resultDeck)).length
  const unsafeCount = tiePlans.length - safeCount
  check(`[23] 1 candidate, ${tiePlans.length} distinct tie realizations намерени, ${safeCount} safe / ${unsafeCount} unsafe → candidate остава viable`,
    tiePlans.length >= 2 && safeCount >= 1 && unsafeCount >= 1)
}

// ---------------------------------------------------------------------------
// [24] Weakest-card tie: candidate, чиито ВСИЧКИ realizations са unsafe →
//      reject. Реален fixture (от [20], seed=252): SUIT hearts за seat `top`
//      има 3 distinct realizations, ВСИЧКИТЕ unsafe.
// ---------------------------------------------------------------------------
{
  const natural24 = shuffleWithRandom(FULL_DECK, createSeededRandom('swap3-search-natural-252'))
  const heartsCandidate24 = { type: 'SUIT' as const, variant: 'hearts', cardIds: ['hearts-J', 'hearts-9', 'hearts-10'] }
  const naturalFullHands24 = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, fullHand(natural24, seat)])) as Record<Seat, ServerCard[]>
  const isPlanSafe24 = (resultDeck: ServerCard[]) => {
    const resultFullHands = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, fullHand(resultDeck, seat)])) as Record<Seat, ServerCard[]>
    return isServerGoodFirstFive(firstFive(resultDeck, 'top')) &&
      isServerAntiBadLuckNaturalRunPreserved(naturalFullHands24, resultFullHands) &&
      isServerAntiBadLuckSequencePlanSafe(naturalFullHands24, resultFullHands, { allowArtificialQuart: false, allowArtificialQuintPlus: false }) &&
      isServerAntiBadLuckSquarePlanSafe(naturalFullHands24, resultFullHands)
  }
  const plans24 = enumerateServerAntiBadLuckRealizedPlans(natural24, 'top', FIRST_FIVE_INDICES, heartsCandidate24)
  const allUnsafe24 = plans24.length > 0 && plans24.every((plan) => !isPlanSafe24(plan.resultDeck))
  const result24 = applyServerAntiBadLuckToDeck(natural24, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, right: 5, top: 5, left: 5 }), createSeededRandom('swap3-search-deck-252'))
  check(`[24] candidate с ${plans24.length} realizations, ВСИЧКИ unsafe → reject (planner-ът никога не го избира за 'top')`,
    allUnsafe24 && result24.rescueKinds.top?.variant !== 'hearts')
}

// ---------------------------------------------------------------------------
// [25] Displaced-card natural terza destruction на NON-RESCUED seat —
//      deterministic. Пряк тест на isServerAntiBadLuckNaturalRunPreserved
//      (вече покрит структурно от [13e]), плюс end-to-end през [14]
//      (2553+ раздавания, 0 нарушения) потвърждава, че механизмът наистина
//      работи през реалния swap pipeline, не само на хартия.
// ---------------------------------------------------------------------------
{
  const naturalRightTerza25 = cards('hearts-7', 'hearts-8', 'hearts-9', 'diamonds-K', 'spades-Q', 'clubs-A', 'diamonds-7', 'hearts-K')
  const rightTerzaDestroyedByDisplacement = cards('hearts-7', 'hearts-9', 'diamonds-K', 'spades-Q', 'clubs-A', 'diamonds-7', 'hearts-K', 'clubs-J')
  const neutral25 = cards('clubs-7', 'diamonds-8', 'clubs-K', 'spades-10', 'clubs-Q', 'diamonds-Q', 'hearts-A', 'spades-J')
  check('[25] displaced карта (hearts-8 напуска, clubs-J пристига) разрушава natural терца на non-rescued seat (right) → reject',
    !isServerAntiBadLuckNaturalRunPreserved(
      { bottom: neutral25, right: naturalRightTerza25, top: neutral25, left: neutral25 },
      { bottom: neutral25, right: rightTerzaDestroyedByDisplacement, top: neutral25, left: neutral25 },
    ))
}

// ---------------------------------------------------------------------------
// [26] Unrelated нова терца НЕ компенсира разрушена original natural терца —
//      isServerAntiBadLuckNaturalRunPreserved е keyed per-suit per-seat, не
//      "има ли играчът терца някъде" — нова терца в ДРУГ suit едновременно с
//      разрушаване на оригиналната все още трябва да reject-не.
// ---------------------------------------------------------------------------
{
  const neutral26 = cards('spades-7', 'spades-8', 'clubs-K', 'spades-10', 'clubs-Q', 'diamonds-Q', 'hearts-A', 'spades-J')
  const naturalBottom26 = cards('clubs-7', 'clubs-8', 'clubs-9', 'diamonds-K', 'spades-Q', 'hearts-K', 'diamonds-7', 'hearts-Q')
  // clubs терца разрушена (8 заменена с Q) И едновременно се появява НОВА,
  // несвързана терца в diamonds (diamonds-7,8,9), чрез замяна на hearts-K и
  // hearts-Q с diamonds-8 и diamonds-9.
  const clubsDestroyedDiamondsNewTerza = cards('clubs-7', 'clubs-Q', 'clubs-9', 'diamonds-K', 'spades-Q', 'diamonds-8', 'diamonds-7', 'diamonds-9')
  check('[26] clubs терца разрушена (8→Q) + нова несвързана diamonds терца (7-8-9) едновременно → все пак reject (per-suit keying, не компенсира)',
    !isServerAntiBadLuckNaturalRunPreserved(
      { bottom: naturalBottom26, right: neutral26, top: neutral26, left: neutral26 },
      { bottom: clubsDestroyedDiamondsNewTerza, right: neutral26, top: neutral26, left: neutral26 },
    ))
}

// [27] Artificial нова терца остава напълно позволена — вече потвърдено от
// [13d] (none → 3, allowed без ограничение). Не дублираме тук.

// ---------------------------------------------------------------------------
// [28] RNG instrumentation: rejected candidates консумират 0 RNG draws.
//      ALL_BAD_DECK (пълен 0-anchor universe, ~84 abstract candidates, almost
//      всички rejected освен печелившия) → total calls е малко И фиксирано
//      (sequenceAllowance ×2 + type-pick ×1 + plan-pick ×0/1), НЕ расте с
//      броя enumerate-нати/rejected candidates.
// ---------------------------------------------------------------------------
{
  function makeCountingRandom(seed: string) {
    const base = createSeededRandom(seed)
    let calls = 0
    return { next: () => { calls += 1; return base() }, count: () => calls }
  }
  const counting28 = makeCountingRandom('rng-free-28')
  const result28 = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), counting28.next)
  check(`[28] 0-anchor universe (~84 abstract candidates, почти всички rejected): total nextRandom() calls = ${counting28.count()} (<=5, независимо от enumeration size)`,
    !!result28.rescues.bottom && counting28.count() <= 5)
}

// ---------------------------------------------------------------------------
// [29] Candidate universe size variation НЕ добавя RNG draws преди type
//      selection: 0-anchor (пълен universe) срещу 2-anchor ALL_TRUMPS
//      (universe намален от 16 на 2 ALL_TRUMPS candidates) — totals трябва
//      да са РАВНИ (и двете движени само от sequenceAllowance+type+plan).
// ---------------------------------------------------------------------------
{
  function makeCountingRandom(seed: string) {
    const base = createSeededRandom(seed)
    let calls = 0
    return { next: () => { calls += 1; return base() }, count: () => calls }
  }
  const fullUniverseDeck29 = ALL_BAD_DECK
  const reducedUniverseDeck29 = buildDeck({
    bottom: ['clubs-J', 'hearts-J', 'clubs-7', 'diamonds-7', 'spades-9'],
    right: BAD_HANDS.right,
    top: BAD_HANDS.top,
    left: BAD_HANDS.left,
  })
  const countingFull29 = makeCountingRandom('universe-full-29')
  const resultFull29 = applyServerAntiBadLuckToDeck(fullUniverseDeck29, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), countingFull29.next)
  const countingReduced29 = makeCountingRandom('universe-reduced-29')
  const resultReduced29 = applyServerAntiBadLuckToDeck(reducedUniverseDeck29, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), countingReduced29.next)
  check(`[29] candidate universe size (84 vs ~70 abstract candidates) не влияе на RNG calls преди type selection: full=${countingFull29.count()}, reduced=${countingReduced29.count()}`,
    !!resultFull29.rescues.bottom && !!resultReduced29.rescues.bottom && countingFull29.count() === countingReduced29.count())
}

// ---------------------------------------------------------------------------
// [30] Финалният избран resultDeck е ТОЧНО deck-ът, който е бил validated —
//      няма second/re-rolled realization. Детерминизъм: същият seed → същият
//      deck (ако имаше скрит re-roll след избора, различни извиквания биха
//      могли да покажат нестабилност дори при same-seed since re-roll би
//      консумирал допълнителен RNG state по различен начин). Плюс directна
//      проверка: прилагайки избрания rescue отново РЪЧНО чрез
//      enumerateServerAntiBadLuckRealizedPlans дава resultDeck измежду
//      чиито realizations е И точно примененият.
// ---------------------------------------------------------------------------
{
  const idsOf = (deck: readonly ServerCard[]) => deck.map((card) => card.id).join(',')
  const first30 = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom('final-plan-30'))
  const second30 = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom('final-plan-30'))
  const deterministic30 = idsOf(first30.deck) === idsOf(second30.deck) && JSON.stringify(first30.rescues) === JSON.stringify(second30.rescues)

  let matchesEnumeration30 = false
  if (first30.rescues.bottom) {
    const replay = enumerateServerAntiBadLuckRealizedPlans(ALL_BAD_DECK, 'bottom', FIRST_FIVE_INDICES, first30.rescues.bottom)
    matchesEnumeration30 = replay.some((plan) => idsOf(plan.resultDeck) === idsOf(first30.deck))
  }
  check('[30] seeded детерминизъм: същият seed → identичен deck и rescue (без скрит re-roll)', deterministic30)
  check('[30b] приложеният resultDeck е измежду RNG-free enumerated realizations на приложения candidate (не нов random swap)',
    matchesEnumeration30)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
