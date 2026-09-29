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
 */

import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../src/core/serverTypes.js'
import { createSeededRandom, shuffleWithRandom } from '../src/core/seededRandom.js'
import {
  applyServerAntiBadLuckRescueSwaps,
  applyServerAntiBadLuckToDeck,
  getServerFirstFiveDeckIndicesBySeat,
  getServerFullHandDeckIndicesBySeat,
} from '../src/game/antiBadLuck/applyServerAntiBadLuckToDeck.js'
import {
  getServerAntiBadLuckKeepStrength,
  isServerAllTrumpsGoodFirstFive,
  isServerGoodFirstFive,
  isServerNoTrumpsGoodFirstFive,
  isServerSuitGoodFirstFive,
} from '../src/game/antiBadLuck/evaluateServerFirstFiveQuality.js'
import {
  pickServerAntiBadLuckRescue,
  pickServerAntiBadLuckRescueVariant,
} from '../src/game/antiBadLuck/pickServerAntiBadLuckRescue.js'
import {
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE,
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE,
  findServerAntiBadLuckLongRuns,
  isServerAntiBadLuckSequencePlanSafe,
  type ServerAntiBadLuckSequenceAllowance,
} from '../src/game/antiBadLuck/serverAntiBadLuckSequenceGuard.js'
import {
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
    failedKeepsPending &&= !!result.rescueKinds.bottom && Object.keys(result.rescues).length === 0 && result.deck === blockedDeck &&
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
  return dealServerNextTwoPhase(dealServerFirstThreePhase(prepared, createSeededRandom(seed)))
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
  const chosenTypes = new Map<string, number>()
  let chosenCount = 0
  let typeNeverSwitched = true
  let fallbackCount = 0
  let fallbackWithoutProtection = 0
  let preferredVariantKept = 0
  const chosenTemplates = new Map<string, number>()
  let fallbackStaysPending = true

  for (let seed = 0; seed < 4000; seed += 1) {
    // Естествено разбъркано тесте; и четирите seats са pending → арбитраж + защита на естествен GOOD.
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`natural-${seed}`))
    const naturalSnapshot = natural.map((card) => card.id).join(',')
    const naturalGood = Object.fromEntries(SERVER_SEAT_ORDER.map((seat) => [seat, isServerGoodFirstFive(firstFive(natural, seat))])) as Record<Seat, boolean>
    const result = applyServerAntiBadLuckToDeck(natural, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5, right: 5, top: 5, left: 5 }), createSeededRandom(`deck-${seed}`))
    allValid &&= isValidDeck(result.deck) && natural.map((card) => card.id).join(',') === naturalSnapshot

    // Изтегленият основен тип е фиксиран: приложеният rescue е от него, иначе няма rescue.
    const hasProtectedGood = SERVER_SEAT_ORDER.some((seat) => naturalGood[seat] && !result.rescueKinds[seat])
    for (const seat of Object.keys(result.rescueKinds) as Seat[]) {
      const { type, variant: preferredVariant } = result.rescueKinds[seat]!
      const rescue = result.rescues[seat]
      chosenCount += 1
      chosenTypes.set(type, (chosenTypes.get(type) ?? 0) + 1)
      if (type !== 'SUIT') chosenTemplates.set(`${type}:${preferredVariant}`, (chosenTemplates.get(`${type}:${preferredVariant}`) ?? 0) + 1)
      if (rescue) {
        typeNeverSwitched &&= rescue.type === type
        if (rescue.variant === preferredVariant) preferredVariantKept += 1
      } else {
        fallbackCount += 1
        // Без защитени естествени GOOD ръце всяка комбинация от типове е реализуема.
        if (!hasProtectedGood) fallbackWithoutProtection += 1
        fallbackStaysPending &&= !isServerGoodFirstFive(firstFive(result.deck, seat)) ? result.antiBadLuck.seats[seat].pendingSinceDealIndex === 5 : true
      }
    }
    typeNeverSwitched &&= (Object.keys(result.rescues) as Seat[]).every((seat) => !!result.rescueKinds[seat])

    const rescuedSeats = Object.keys(result.rescues) as Seat[]
    if (rescuedSeats.length === 0) {
      allValid &&= result.deck === natural
      continue
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

  check(`[7f] избран основен тип ~1/3 (n=${chosenCount}): ${typeLabel(chosenTypes, chosenCount)}`, chosenTypes.size === 3 && [...chosenTypes.values()].every((count) => share(count, chosenCount) > 0.31 && share(count, chosenCount) < 0.357))
  check(`[7f2] приложен тип (n=${rescueCount}): ${typeLabel(types, rescueCount)}`, types.size === 3 && [...types.values()].every((count) => share(count, rescueCount) > 0.31 && share(count, rescueCount) < 0.357))
  check(`[7g] приложен SUIT цвят ~25%: ${[...suits.entries()].map(([suit, count]) => `${suit} ${pct(count, suitTotal)}`).join(', ')}`, suits.size === 4 && [...suits.values()].every((count) => share(count, suitTotal) > 0.21 && share(count, suitTotal) < 0.29))
  check('[7h] SUIT тройката не е винаги една и съща (> 10 варианта)', suitTriples.size > 10)
  // От anchor constraints фикса (виж [9]): при 2 natural J/A вариантът се
  // форсира PAIR_PLUS (никога TRIPLE) вместо random 50/50 — реалният natural
  // shuffle съдържа такива seats с забележима честота, затова TRIPLE делът
  // тук вече е under 50% by design (виж [9f-*] за чистото 50/50 при 0 natural).
  check(`[7i] предпочитан шаблон (изместен от anchor forcing при 2 natural, виж [9f]): ${templateLabel(chosenTemplates)}`, ['ALL_TRUMPS', 'NO_TRUMPS'].every((type) => templateShare(chosenTemplates, type, 'TRIPLE') > 0.38 && templateShare(chosenTemplates, type, 'TRIPLE') < 0.54))
  // Стрес сценарий: JJJ/AAA изисква 3 от 4-те J/A и често е невъзможен без да
  // развали защитена GOOD ръка → реализира се JJ9/AA10 в същия тип.
  check(`[7i2] приложени шаблони (стрес): ${templateLabel(templates)}`, ['ALL_TRUMPS', 'NO_TRUMPS'].every((type) => templateShare(templates, type, 'TRIPLE') > 0.2) && templateTotal > 0)
  check('[7k] compatibility retry никога не сменя основния тип', typeNeverSwitched)
  check(`[7k2] предпочитаният цвят/шаблон е запазен в ${pct(preferredVariantKept, rescueCount)} от приложените (стрес)`, share(preferredVariantKept, rescueCount) > 0.8)
  // 5% е само safety bound на стрес теста, НЕ продуктово правило: rescue се
  // прилага винаги, когато има безопасен swap план; иначе natural deal + pending.
  check(`[7l] неприложени rescue-и: ${fallbackCount} от ${chosenCount} (${pct(fallbackCount, chosenCount)}) — всички остават pending`, fallbackStaysPending && share(fallbackCount, chosenCount) < 0.05)
  // От sequence guard-а (виж [10]): дори без защитен natural GOOD hand, rescue
  // вече МОЖЕ да остане непринложен — единствената безопасна GOOD/anchor
  // реализация може да разрушава natural quart/quint, или да създава 2+
  // нови дълги поредици, или точно 1 нова, дето еднократният allowance не
  // позволява. Това е ново, очаквано поведение от sequence guard-а, не
  // регресия — bound-ът само пази от драстичен скок (стрес safety, не правило).
  check(`[7m] без защитени естествени GOOD ръце: ${fallbackWithoutProtection} неприложени от sequence guard-а (очаквано > 0, виж [10])`, share(fallbackWithoutProtection, chosenCount) < 0.02)
}

{
  // Реалистичен сценарий: един pending seat, естествено разбъркани тестета.
  const types = new Map<string, number>()
  const templates = new Map<string, number>()
  let chosen = 0
  let applied = 0
  let keptPreferred = 0
  for (let seed = 0; seed < 4000; seed += 1) {
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`single-natural-${seed}`))
    const result = applyServerAntiBadLuckToDeck(natural, FIRST_DEAL_SEAT, stateWithPending({ bottom: 5 }), createSeededRandom(`single-deck-${seed}`))
    const kind = result.rescueKinds.bottom
    const rescue = result.rescues.bottom
    if (!kind) continue
    chosen += 1
    if (!rescue) continue
    applied += 1
    if (rescue.variant === kind.variant) keptPreferred += 1
    types.set(rescue.type, (types.get(rescue.type) ?? 0) + 1)
    if (rescue.type !== 'SUIT') templates.set(`${rescue.type}:${rescue.variant}`, (templates.get(`${rescue.type}:${rescue.variant}`) ?? 0) + 1)
  }
  const share = (count: number | undefined, total: number) => (count ?? 0) / total
  const pct = (count: number | undefined, total: number) => `${(share(count, total) * 100).toFixed(1)}%`
  const tripleShare = (type: string) => share(templates.get(`${type}:TRIPLE`), (templates.get(`${type}:TRIPLE`) ?? 0) + (templates.get(`${type}:PAIR_PLUS`) ?? 0))
  check(`[7n] 1 pending seat: приложени ${applied}/${chosen} (${pct(applied, chosen)}), запазен цвят/шаблон ${pct(keptPreferred, applied)}`, share(applied, chosen) > 0.98 && share(keptPreferred, applied) > 0.9)
  check(`[7n2] 1 pending seat: типове ${['SUIT', 'ALL_TRUMPS', 'NO_TRUMPS'].map((type) => `${type} ${pct(types.get(type), applied)}`).join(', ')}`, [...types.values()].every((count) => share(count, applied) > 0.31 && share(count, applied) < 0.357))
  check(`[7n3] 1 pending seat: JJJ ${(tripleShare('ALL_TRUMPS') * 100).toFixed(1)}%, AAA ${(tripleShare('NO_TRUMPS') * 100).toFixed(1)}% от типа`, tripleShare('ALL_TRUMPS') > 0.35 && tripleShare('NO_TRUMPS') > 0.35)
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
