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
 */

import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../src/core/serverTypes.js'
import { createSeededRandom, shuffleWithRandom } from '../src/core/seededRandom.js'
import {
  applyServerAntiBadLuckRescueSwaps,
  applyServerAntiBadLuckToDeck,
  getServerFirstFiveDeckIndicesBySeat,
} from '../src/game/antiBadLuck/applyServerAntiBadLuckToDeck.js'
import {
  getServerAntiBadLuckKeepStrength,
  isServerAllTrumpsGoodFirstFive,
  isServerGoodFirstFive,
  isServerNoTrumpsGoodFirstFive,
  isServerSuitGoodFirstFive,
} from '../src/game/antiBadLuck/evaluateServerFirstFiveQuality.js'
import { pickServerAntiBadLuckRescue } from '../src/game/antiBadLuck/pickServerAntiBadLuckRescue.js'
import {
  createEmptyServerAntiBadLuckState,
  type ServerAntiBadLuckRescue,
  type ServerAntiBadLuckState,
} from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
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
  check(`[7i] предпочитан шаблон ~50/50: ${templateLabel(chosenTemplates)}`, ['ALL_TRUMPS', 'NO_TRUMPS'].every((type) => templateShare(chosenTemplates, type, 'TRIPLE') > 0.46 && templateShare(chosenTemplates, type, 'TRIPLE') < 0.54))
  // Стрес сценарий: JJJ/AAA изисква 3 от 4-те J/A и често е невъзможен без да
  // развали защитена GOOD ръка → реализира се JJ9/AA10 в същия тип.
  check(`[7i2] приложени шаблони (стрес): ${templateLabel(templates)}`, ['ALL_TRUMPS', 'NO_TRUMPS'].every((type) => templateShare(templates, type, 'TRIPLE') > 0.2) && templateTotal > 0)
  check('[7k] compatibility retry никога не сменя основния тип', typeNeverSwitched)
  check(`[7k2] предпочитаният цвят/шаблон е запазен в ${pct(preferredVariantKept, rescueCount)} от приложените (стрес)`, share(preferredVariantKept, rescueCount) > 0.8)
  // 5% е само safety bound на стрес теста, НЕ продуктово правило: rescue се
  // прилага винаги, когато има безопасен swap план; иначе natural deal + pending.
  check(`[7l] неприложени rescue-и: ${fallbackCount} от ${chosenCount} (${pct(fallbackCount, chosenCount)}) — всички остават pending`, fallbackStaysPending && share(fallbackCount, chosenCount) < 0.05)
  check(`[7m] без защитени естествени GOOD ръце rescue винаги се прилага (${fallbackWithoutProtection} неприложени)`, fallbackWithoutProtection === 0)
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
