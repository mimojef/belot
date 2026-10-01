/**
 * checkAntiBadLuckThresholdConfig.ts — admin-конфигурируем Anti Bad Luck праг
 * (admin_settings.anti_bad_luck_threshold: 0|5|6|7|8|9|10, default 5) +
 * resetGeneration семантика + задължителният config по production runtime
 * границите (без fallback към 5).
 *
 * [1]  allowlist / config validation
 * [2]  default 5 и bit-identical поведение спрямо СТАРИЯ алгоритъм
 *      (fixtures/legacyApplyServerAntiBadLuckToDeck.ts) върху случайни серии
 * [3]  прагове 5..10: pending след T BAD, rescue най-рано на (T+1)-вото
 * [4]  увеличаване на прага пази count, отлага eligibility
 * [5]  намаляване пази count, може да направи seat eligible веднага
 * [6]  X → 0: deck непокътнат (същата референция), state изчистен, нищо не се натрупва
 * [7]  0 → X започва начисто; бързо X → 0 → X без раздаване също започва начисто
 * [8]  праг 0 оставя natural deck bit-identical (200 случайни тестета, без nextRandom)
 * [9]  single-rescue queue (най-дълга серия печели) при праг ≠ 5
 * [10] square / sequence guard инварианти при праг ≠ 5
 * [11] bot takeover / reclaim / reconnect при праг 6
 * [12] restart persistence: activeRoomSnapshotStore round trip (+ legacy snapshot)
 * [13] fail-fast по production границите (без fallback)
 * [14] реален game worker (compiled dist): config propagation + allowlist reject
 * [15] admin settings store: default, allowlist, generation transitions, atomic, persistence
 * [16] privacy: room snapshot към клиента не съдържа нищо от anti bad luck
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../src/core/serverTypes.js'
import { createSeededRandom, shuffleWithRandom } from '../src/core/seededRandom.js'
import { addBotToRoom } from '../src/core/addBotToRoom.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import {
  applyServerAntiBadLuckToDeck,
  getServerFirstFiveDeckIndicesBySeat,
  getServerFullHandDeckIndicesBySeat,
} from '../src/game/antiBadLuck/applyServerAntiBadLuckToDeck.js'
import { isServerGoodFirstFive } from '../src/game/antiBadLuck/evaluateServerFirstFiveQuality.js'
import { isServerAntiBadLuckSequencePlanSafe } from '../src/game/antiBadLuck/serverAntiBadLuckSequenceGuard.js'
import { isServerAntiBadLuckSquarePlanSafe } from '../src/game/antiBadLuck/serverAntiBadLuckSquareGuard.js'
import {
  SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG,
  SERVER_ANTI_BAD_LUCK_THRESHOLD_VALUES,
  assertServerAntiBadLuckConfig,
  createEmptyServerAntiBadLuckState,
  isServerAntiBadLuckConfig,
  isServerAntiBadLuckThreshold,
  type ServerAntiBadLuckConfig,
  type ServerAntiBadLuckState,
  type ServerAntiBadLuckThreshold,
} from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { abandonHumanControlForRoom } from '../src/game/abandonHumanControlForRoom.js'
import { advanceRoomAuthoritativeGame } from '../src/game/advanceRoomAuthoritativeGame.js'
import { createInProcessActiveRoomRuntime } from '../src/game/createInProcessActiveRoomRuntime.js'
import { createGameWorkerTickClient } from '../src/game/createGameWorkerTickClient.js'
import { createGameWorkerTickOrchestrator } from '../src/game/createGameWorkerTickOrchestrator.js'
import { createRoomRevisionRegistry } from '../src/game/createRoomRevisionRegistry.js'
import { createEmptyHands } from '../src/game/createServerRoundDefaults.js'
import { createServerDeck } from '../src/game/createServerDeck.js'
import { dealServerCardsInPackets } from '../src/game/dealServerCardsInPackets.js'
import { dealServerFirstThreePhase } from '../src/game/dealServerFirstThreePhase.js'
import { enterServerPhase } from '../src/game/enterServerPhase.js'
import { getRoomAuthoritativeGameState } from '../src/game/getRoomAuthoritativeGameState.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { resolveGameWorkerEntryUrl } from '../src/game/resolveGameWorkerEntryUrl.js'
import { resumeHumanControlForRoom } from '../src/game/resumeHumanControlForRoom.js'
import { GAME_WORKER_PROTOCOL_VERSION } from '../src/game/workerProtocol.js'
import type { ServerAuthoritativeGameState, ServerCard } from '../src/game/serverGameTypes.js'
import { createActiveRoomSnapshotStore } from '../src/db/activeRoomSnapshotStore.js'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { createRoomSnapshotMessage } from '../src/protocol/createRoomSnapshotMessage.js'
import { legacyApplyServerAntiBadLuckToDeck } from './fixtures/legacyApplyServerAntiBadLuckToDeck.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, details = ''): void {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${label}${details ? `: ${details}` : ''}`)
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// ─── Fixtures (mirror на checkAntiBadLuck.ts) ────────────────────────────────

const FULL_DECK = createServerDeck()
const CARD_BY_ID = new Map(FULL_DECK.map((card) => [card.id, card]))
const FIRST_DEAL_SEAT: Seat = 'right'
const FIRST_FIVE_INDICES = getServerFirstFiveDeckIndicesBySeat(FIRST_DEAL_SEAT)
const FULL_HAND_INDICES = getServerFullHandDeckIndicesBySeat(FIRST_DEAL_SEAT)

const BAD_HANDS: Record<Seat, string[]> = {
  bottom: ['clubs-7', 'clubs-8', 'diamonds-7', 'diamonds-8', 'hearts-7'],
  right: ['hearts-8', 'spades-7', 'spades-8', 'clubs-Q', 'diamonds-Q'],
  top: ['hearts-Q', 'spades-Q', 'clubs-K', 'diamonds-K', 'hearts-K'],
  left: ['spades-K', 'clubs-9', 'diamonds-10', 'hearts-A', 'spades-J'],
}

function buildDeck(firstFive: Record<Seat, string[]>, fillerSeed?: string): ServerCard[] {
  const deck: Array<ServerCard | undefined> = new Array(32)
  const used = new Set<string>()
  for (const seat of SERVER_SEAT_ORDER) {
    FIRST_FIVE_INDICES[seat].forEach((deckIndex, cardIndex) => {
      deck[deckIndex] = CARD_BY_ID.get(firstFive[seat][cardIndex]!)!
      used.add(firstFive[seat][cardIndex]!)
    })
  }
  let rest = FULL_DECK.filter((card) => !used.has(card.id))
  if (fillerSeed !== undefined) rest = shuffleWithRandom(rest, createSeededRandom(fillerSeed))
  for (let index = 0; index < deck.length; index += 1) {
    if (!deck[index]) deck[index] = rest.shift()
  }
  return deck as ServerCard[]
}

const ALL_BAD_DECK = buildDeck(BAD_HANDS)
const firstFive = (deck: readonly ServerCard[], seat: Seat) => FIRST_FIVE_INDICES[seat].map((index) => deck[index]!)
const fullHands = (deck: readonly ServerCard[]): Record<Seat, ServerCard[]> => ({
  bottom: FULL_HAND_INDICES.bottom.map((index) => deck[index]!),
  right: FULL_HAND_INDICES.right.map((index) => deck[index]!),
  top: FULL_HAND_INDICES.top.map((index) => deck[index]!),
  left: FULL_HAND_INDICES.left.map((index) => deck[index]!),
})
const ids = (cards: readonly ServerCard[]) => cards.map((card) => card.id).join(',')
const config = (threshold: ServerAntiBadLuckThreshold, resetGeneration = 0): ServerAntiBadLuckConfig => ({ threshold, resetGeneration })

// State с дадени поредни BAD броеве (непрекъсната серия до dealIndex).
function stateWithCounts(counts: Partial<Record<Seat, number>>, dealIndex = 10, resetGeneration = 0, threshold = 5): ServerAntiBadLuckState {
  const state = { ...createEmptyServerAntiBadLuckState(), dealIndex, resetGeneration }
  for (const [seat, count] of Object.entries(counts) as Array<[Seat, number]>) {
    state.seats = { ...state.seats, [seat]: { consecutiveBadDeals: count, pendingSinceDealIndex: count >= threshold ? dealIndex - count + threshold : null } }
  }
  return state
}

const stripGeneration = (state: ServerAntiBadLuckState) => JSON.stringify({ dealIndex: state.dealIndex, seats: state.seats })

// ─── [1] allowlist / config validation ──────────────────────────────────────
console.log('\n[1] allowlist / config validation')
check('[1a] allowlist е точно 0,5,6,7,8,9,10', JSON.stringify(SERVER_ANTI_BAD_LUCK_THRESHOLD_VALUES) === JSON.stringify([0, 5, 6, 7, 8, 9, 10]))
check('[1b] позволените стойности минават', [0, 5, 6, 7, 8, 9, 10].every((value) => isServerAntiBadLuckThreshold(value)))
check('[1c] невалидни прагове се отказват (1–4, 11, -1, 5.5, NaN, "5", null, undefined, true)',
  [1, 2, 3, 4, 11, -1, 5.5, Number.NaN, '5', null, undefined, true].every((value) => !isServerAntiBadLuckThreshold(value)))
check('[1d] config: валиден generation (0, 7) минава; отрицателен/дробен/липсващ/string — не',
  isServerAntiBadLuckConfig({ threshold: 5, resetGeneration: 0 }) && isServerAntiBadLuckConfig({ threshold: 0, resetGeneration: 7 }) &&
  [{ threshold: 5, resetGeneration: -1 }, { threshold: 5, resetGeneration: 1.5 }, { threshold: 5 }, { threshold: 5, resetGeneration: '0' }, { threshold: 4, resetGeneration: 0 }, null, undefined]
    .every((value) => !isServerAntiBadLuckConfig(value)))
check('[1e] assertServerAntiBadLuckConfig хвърля при невалиден config', throws(() => assertServerAntiBadLuckConfig({ threshold: 3, resetGeneration: 0 }, 'test')))

// ─── [2] default 5 + bit-identical спрямо стария алгоритъм ──────────────────
console.log('\n[2] default 5 и backward compatibility (legacy vs new)')
check('[2a] default config = { threshold: 5, resetGeneration: 0 }', JSON.stringify(SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG) === JSON.stringify({ threshold: 5, resetGeneration: 0 }))
{
  let identical = true
  let deals = 0
  let rescues = 0
  let multiPendingDeals = 0
  let firstMismatch = ''
  for (let seed = 0; seed < 400 && identical; seed += 1) {
    const deckRandom = createSeededRandom(`legacy-decks-${seed}`)
    const legacyRandom = createSeededRandom(`legacy-rng-${seed}`)
    const newRandom = createSeededRandom(`legacy-rng-${seed}`)
    let legacyState: ServerAntiBadLuckState | undefined
    let newState: ServerAntiBadLuckState | undefined
    for (let deal = 0; deal < 18; deal += 1) {
      // ~75% тестета с BAD първи 5 за всички (дълги серии), иначе random shuffle.
      const deck = deckRandom() < 0.75
        ? buildDeck(BAD_HANDS, `filler-${seed}-${deal}`)
        : shuffleWithRandom(FULL_DECK, deckRandom)
      const legacy = legacyApplyServerAntiBadLuckToDeck(deck, FIRST_DEAL_SEAT, legacyState, legacyRandom)
      const current = applyServerAntiBadLuckToDeck(deck, FIRST_DEAL_SEAT, newState, newRandom, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
      deals += 1
      if (Object.values(legacyState?.seats ?? {}).filter((seat) => seat.pendingSinceDealIndex !== null).length >= 2) multiPendingDeals += 1
      if (ids(legacy.deck) !== ids(current.deck) || JSON.stringify(legacy.rescues) !== JSON.stringify(current.rescues) ||
        JSON.stringify(legacy.rescueKinds) !== JSON.stringify(current.rescueKinds) || stripGeneration(legacy.antiBadLuck) !== stripGeneration(current.antiBadLuck)) {
        identical = false
        firstMismatch = `seed=${seed} deal=${deal}`
        break
      }
      rescues += Object.keys(current.rescues).length
      legacyState = legacy.antiBadLuck
      newState = current.antiBadLuck
    }
  }
  check(`[2b] праг 5: deck, rescues, rescue kinds и state са BIT-IDENTICAL със стария алгоритъм (${deals} раздавания, ${rescues} rescues, ${multiPendingDeals} с ≥2 pending)`,
    identical && rescues > 100 && multiPendingDeals > 100, firstMismatch)
  const withoutConfig = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithCounts({ bottom: 5 }), createSeededRandom('default'))
  const withDefault = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithCounts({ bottom: 5 }), createSeededRandom('default'), SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
  check('[2c] нисък helper без config = explicit default (праг 5)', ids(withoutConfig.deck) === ids(withDefault.deck) && JSON.stringify(withoutConfig.antiBadLuck) === JSON.stringify(withDefault.antiBadLuck))
  const legacyPersisted = stateWithCounts({ bottom: 5 })
  delete legacyPersisted.resetGeneration
  const legacyContinued = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, legacyPersisted, createSeededRandom('legacy-persisted'), config(5, 0))
  check('[2d] persisted state без resetGeneration (преди deploy) продължава при generation 0 — без reset', !!legacyContinued.rescues.bottom)
}

// ─── [3] прагове 5..10 ──────────────────────────────────────────────────────
console.log('\n[3] прагове 5..10: rescue най-рано на (T+1)-вото BAD')
for (const threshold of [5, 6, 7, 8, 9, 10] as const) {
  const random = createSeededRandom(`threshold-${threshold}`)
  let state: ServerAntiBadLuckState | undefined
  let firstRescueDeal: number | null = null
  let pendingAfterT = false
  let pendingBeforeT = false
  for (let deal = 1; deal <= threshold + 1; deal += 1) {
    const result = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, state, random, config(threshold))
    if (firstRescueDeal === null && Object.keys(result.rescues).length > 0) firstRescueDeal = deal
    state = result.antiBadLuck
    if (deal === threshold - 1) pendingBeforeT = SERVER_SEAT_ORDER.some((seat) => state!.seats[seat].pendingSinceDealIndex !== null)
    if (deal === threshold) pendingAfterT = SERVER_SEAT_ORDER.every((seat) => state!.seats[seat].pendingSinceDealIndex === threshold && state!.seats[seat].consecutiveBadDeals === threshold)
  }
  check(`[3] праг ${threshold}: не е pending след ${threshold - 1} BAD, pending след ${threshold}, първи rescue на ${threshold + 1}-вото BAD`,
    !pendingBeforeT && pendingAfterT && firstRescueDeal === threshold + 1, `firstRescue=${firstRescueDeal}`)
}

// ─── [4] увеличаване ─────────────────────────────────────────────────────────
console.log('\n[4] увеличаване на прага (5 → 8)')
{
  // 6 поредни BAD (pending при праг 5), после праг 8.
  let state: ServerAntiBadLuckState = stateWithCounts({ bottom: 6, right: 6, top: 6, left: 6 }, 6)
  const random = createSeededRandom('increase')
  const rescuesByDeal: number[] = []
  for (let deal = 7; deal <= 9; deal += 1) {
    const result = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, state, random, config(8))
    rescuesByDeal.push(Object.keys(result.rescues).length)
    if (deal === 7) {
      check('[4a] count се пази (6 → 7), pending по стария праг НЕ дава rescue', result.antiBadLuck.seats.bottom.consecutiveBadDeals === 7 && Object.keys(result.rescues).length === 0)
      check('[4b] при 7 BAD и праг 8 seat-ът не е pending', SERVER_SEAT_ORDER.every((seat) => result.antiBadLuck.seats[seat].pendingSinceDealIndex === null))
    }
    state = result.antiBadLuck
  }
  check('[4c] rescue чак на 9-тото BAD (праг 8 + 1), не на 7-мото/8-мото', JSON.stringify(rescuesByDeal) === JSON.stringify([0, 0, 1]), JSON.stringify(rescuesByDeal))
}

// ─── [5] намаляване ──────────────────────────────────────────────────────────
console.log('\n[5] намаляване на прага (8 → 5)')
{
  const notPendingAt8 = stateWithCounts({ bottom: 6 }, 6, 0, 8)
  check('[5a] 6 BAD при праг 8 → не е pending', notPendingAt8.seats.bottom.pendingSinceDealIndex === null)
  const lowered = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, notPendingAt8, createSeededRandom('decrease'), config(5))
  check('[5b] след 8 → 5 seat-ът с 6 BAD е eligible на СЛЕДВАЩОТО BAD (rescue веднага)', !!lowered.rescues.bottom && isServerGoodFirstFive(firstFive(lowered.deck, 'bottom')))
  const four = stateWithCounts({ bottom: 4 }, 4, 0, 8)
  const step1 = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, four, createSeededRandom('decrease-2'), config(5))
  const step2 = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, step1.antiBadLuck, createSeededRandom('decrease-3'), config(5))
  check('[5c] 4 BAD → 8 → 5: без rescue на 5-тото, count 5 (pending), rescue на 6-тото', !step1.rescues.bottom && step1.antiBadLuck.seats.bottom.consecutiveBadDeals === 5 &&
    step1.antiBadLuck.seats.bottom.pendingSinceDealIndex === 5 && !!step2.rescues.bottom)
}

// ─── [6] X → 0 ───────────────────────────────────────────────────────────────
console.log('\n[6] X → 0: bypass + clear, без натрупване')
{
  const pending = stateWithCounts({ bottom: 9, right: 7, top: 5, left: 6 })
  let calls = 0
  const countingRandom = () => { calls += 1; return 0.5 }
  const off = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, pending, countingRandom, config(0, 1))
  check('[6a] праг 0: deck е СЪЩАТА референция, без rescues, без nextRandom', off.deck === ALL_BAD_DECK && Object.keys(off.rescues).length === 0 && Object.keys(off.rescueKinds).length === 0 && calls === 0)
  check('[6b] праг 0: state е изчистен (counts 0, без pending) и носи текущата generation',
    SERVER_SEAT_ORDER.every((seat) => off.antiBadLuck.seats[seat].consecutiveBadDeals === 0 && off.antiBadLuck.seats[seat].pendingSinceDealIndex === null) && off.antiBadLuck.resetGeneration === 1)
  let state = off.antiBadLuck
  let accumulated = false
  for (let deal = 0; deal < 20; deal += 1) {
    const result = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, state, countingRandom, config(0, 1))
    if (result.deck !== ALL_BAD_DECK || SERVER_SEAT_ORDER.some((seat) => result.antiBadLuck.seats[seat].consecutiveBadDeals !== 0)) accumulated = true
    state = result.antiBadLuck
  }
  check('[6c] 20 поредни BAD при праг 0: нищо не се натрупва, deck винаги непокътнат', !accumulated && calls === 0)
}

// ─── [7] 0 → X / бързо X → 0 → X ─────────────────────────────────────────────
console.log('\n[7] 0 → X и бързо X → 0 → X без раздаване')
{
  // Generation 1 = след превключване към 0. Старият state (generation 0, 9 BAD).
  const old = stateWithCounts({ bottom: 9, right: 9, top: 9, left: 9 }, 9, 0)
  const random = createSeededRandom('fast-toggle')
  let state: ServerAntiBadLuckState = old
  const rescuesByDeal: number[] = []
  for (let deal = 1; deal <= 6; deal += 1) {
    const result = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, state, random, config(5, 1))
    rescuesByDeal.push(Object.keys(result.rescues).length)
    if (deal === 1) {
      check('[7a] бързо 5 → 0 → 5 (generation 0 → 1, НИТО едно раздаване при 0): state започва начисто — count 1, без rescue',
        result.antiBadLuck.seats.bottom.consecutiveBadDeals === 1 && Object.keys(result.rescues).length === 0 && result.antiBadLuck.resetGeneration === 1)
    }
    state = result.antiBadLuck
  }
  check('[7b] без retroactive rescue: първият rescue е на 6-тото BAD след превключването', JSON.stringify(rescuesByDeal) === JSON.stringify([0, 0, 0, 0, 0, 1]), JSON.stringify(rescuesByDeal))
  const sameGeneration = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, old, createSeededRandom('no-toggle'), config(7, 0))
  check('[7c] X → Y (ненулев, generation непроменен) НЕ reset-ва: 9 BAD при праг 7 → rescue веднага', !!Object.keys(sameGeneration.rescues).length)
  const afterOff = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, old, createSeededRandom('off'), config(0, 1))
  const back = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, afterOff.antiBadLuck, createSeededRandom('back'), config(5, 1))
  check('[7d] 0 → 5 след раздаване при 0: count започва от 1', back.antiBadLuck.seats.bottom.consecutiveBadDeals === 1 && !Object.keys(back.rescues).length)
}

// ─── [8] праг 0 = natural deck bit-identical ─────────────────────────────────
console.log('\n[8] праг 0 оставя natural (shuffle + cut) deck непокътнат')
{
  let identical = true
  let randomCalls = 0
  for (let seed = 0; seed < 200; seed += 1) {
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`natural-${seed}`))
    const snapshot = ids(natural)
    const initial = createInitialAuthoritativeState()
    const prepared: ServerAuthoritativeGameState = {
      ...initial,
      phase: 'cut-resolve',
      round: { ...initial.round, firstDealSeat: FIRST_DEAL_SEAT },
      deck: natural,
      antiBadLuck: stateWithCounts({ bottom: 9, right: 9, top: 9, left: 9 }),
    }
    const dealt = dealServerFirstThreePhase(prepared, config(0, 3), () => { randomCalls += 1; return 0.5 })
    const expected = dealServerCardsInPackets(natural, createEmptyHands(), FIRST_DEAL_SEAT, 3, 1)
    if (ids(natural) !== snapshot ||
      SERVER_SEAT_ORDER.some((seat) => ids(dealt.hands[seat]) !== ids(expected.hands[seat])) ||
      ids(dealt.deck) !== ids(expected.remainingDeck)) identical = false
  }
  check('[8a] 200 случайни тестета: ръцете и остатъкът са ТОЧНО естественото раздаване (без swaps/permutations), nextRandom никога не е извикан', identical && randomCalls === 0)
}

function createInitialAuthoritativeState(): ServerAuthoritativeGameState {
  return getRoomAuthoritativeGameState(buildRealisticRoom('abl-initial'))!
}

// ─── [9] single-rescue queue при праг ≠ 5 ───────────────────────────────────
console.log('\n[9] single-rescue queue')
{
  let onlyOne = true
  let longestWins = true
  for (let seed = 0; seed < 60; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithCounts({ bottom: 8, right: 11, top: 9, left: 8 }, 12, 0, 7), createSeededRandom(`queue-${seed}`), config(7))
    if (Object.keys(result.rescues).length !== 1) onlyOne = false
    if (!result.rescues.right) longestWins = false
  }
  check('[9a] праг 7, 4 eligible seats → точно 1 rescue на раздаване', onlyOne)
  check('[9b] най-дългата серия (най-стар pending) печели (right: 11)', longestWins)
  const tie = new Set<string>()
  for (let seed = 0; seed < 60; seed += 1) {
    const result = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, stateWithCounts({ bottom: 9, top: 9 }, 12, 0, 7), createSeededRandom(`tie-${seed}`), config(7))
    tie.add(Object.keys(result.rescues).join(','))
  }
  check('[9c] равенство → seeded random между двата seat-а (не seat order)', tie.has('bottom') && tie.has('top') && tie.size === 2)
}

// ─── [10] square / sequence guards при праг ≠ 5 ──────────────────────────────
console.log('\n[10] square / sequence guards и deck invariants')
{
  let invariantsHold = true
  let applied = 0
  for (let seed = 0; seed < 300; seed += 1) {
    const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`guard-${seed}`))
    const result = applyServerAntiBadLuckToDeck(natural, FIRST_DEAL_SEAT, stateWithCounts({ bottom: 9, right: 9, top: 9, left: 9 }, 12, 0, 9), createSeededRandom(`guard-rng-${seed}`), config(9))
    const sameCards = new Set(result.deck.map((card) => card.id)).size === 32 && result.deck.length === 32
    if (Object.keys(result.rescues).length > 0) applied += 1
    if (!sameCards ||
      !isServerAntiBadLuckSquarePlanSafe(fullHands(natural), fullHands(result.deck)) ||
      !isServerAntiBadLuckSequencePlanSafe(fullHands(natural), fullHands(result.deck), { allowArtificialQuart: true, allowArtificialQuintPlus: true }) ||
      Object.keys(result.rescues).length > 1) invariantsHold = false
  }
  check(`[10a] праг 9: 32 уникални карти, ≤1 rescue, square guard и sequence guard инварианти (${applied} rescues от 300)`, invariantsHold && applied > 50)
}

// ─── [11] bot takeover / reclaim / reconnect при праг 6 ─────────────────────
console.log('\n[11] bot takeover / reclaim / reconnect')
{
  const room = buildRealisticRoom('abl-takeover')
  const state = getRoomAuthoritativeGameState(room)!
  const streak = stateWithCounts({ bottom: 6 }, 6, 2, 6)
  const liveRoom: ServerRoom = { ...room, game: { ...room.game, authoritativeState: { ...state, phase: 'bidding', antiBadLuck: streak } } }
  const takeover = abandonHumanControlForRoom(liveRoom, 'bottom')
  const takeoverState = takeover.ok ? getRoomAuthoritativeGameState(takeover.room) : null
  const reclaim = takeover.ok ? resumeHumanControlForRoom(takeover.room, 'bottom') : null
  const reclaimState = reclaim?.ok ? getRoomAuthoritativeGameState(reclaim.room) : null
  check('[11a] takeover и reclaim пазят state-а (вкл. resetGeneration)', JSON.stringify(takeoverState?.antiBadLuck) === JSON.stringify(streak) && JSON.stringify(reclaimState?.antiBadLuck) === JSON.stringify(streak))
  const reconnected = JSON.parse(JSON.stringify(reclaimState)) as ServerAuthoritativeGameState
  const human = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, reconnected.antiBadLuck, createSeededRandom('takeover'), config(6, 2))
  const bot = applyServerAntiBadLuckToDeck(ALL_BAD_DECK, FIRST_DEAL_SEAT, takeoverState!.antiBadLuck, createSeededRandom('takeover'), config(6, 2))
  check('[11b] праг 6: rescue на 7-мото BAD еднакво за човек / bot takeover / reconnect', !!human.rescues.bottom && ids(human.deck) === ids(bot.deck))
}

// ─── [12] restart persistence ────────────────────────────────────────────────
const serverRootPath = join(dirname(fileURLToPath(import.meta.url)), '..')

async function createMigratedDatabase(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const dbPath = join(dir, 'server.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
  db.exec('CREATE TABLE IF NOT EXISTS server_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);')
  const migrationsDir = join(serverRootPath, 'database', 'migrations')
  const files = (await readdir(migrationsDir)).filter((name) => extname(name) === '.sql').sort((a, b) => a.localeCompare(b, 'en'))
  for (const filename of files) {
    const sql = (await readFile(join(migrationsDir, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith('-- MANUAL_TRANSACTION_MIGRATION')) {
      db.exec(sql)
    } else {
      db.exec('BEGIN;')
      db.exec(sql)
      db.exec('COMMIT;')
    }
    db.prepare('INSERT OR IGNORE INTO server_migrations (filename) VALUES (?);').run(filename)
  }
  db.close()
  return dbPath
}

function buildRealisticRoom(id: string): ServerRoom {
  const { room: r1 } = createRoomWithHumanHost({ roomId: id, connectionId: `conn-${id}-1`, identity: { displayName: 'Player 1' } })
  const { room: r2 } = addHumanToRoom(r1, { connectionId: `conn-${id}-2`, identity: { displayName: 'Player 2' } })
  const { room: r3 } = addBotToRoom(r2, { difficulty: 'normal', behaviorPreset: 'balanced', identity: { displayName: 'Bot 3' } })
  const { room: r4 } = addBotToRoom(r3, { difficulty: 'normal', behaviorPreset: 'balanced', identity: { displayName: 'Bot 4' } })
  return initializeRoomAuthoritativeGameState(r4)
}

// Стая в cut-resolve с изтекъл auto-advance → следващият tick влиза в deal-first-3.
function roomReadyToDeal(id: string, deck: ServerCard[], antiBadLuck: ServerAntiBadLuckState | undefined, now: number): ServerRoom {
  const room = buildRealisticRoom(id)
  const state = getRoomAuthoritativeGameState(room)!
  const prepared: ServerAuthoritativeGameState = {
    ...state,
    phase: 'cut-resolve',
    phaseEnteredAt: now - 60_000,
    round: { ...state.round, dealerSeat: 'bottom', firstDealSeat: FIRST_DEAL_SEAT, cutterSeat: 'left', firstBidderSeat: 'right' },
    deck: [...deck],
    antiBadLuck,
  }
  if (antiBadLuck === undefined) delete prepared.antiBadLuck
  return { ...room, game: { ...room.game, authoritativeState: prepared } }
}

console.log('\n[12] restart persistence (activeRoomSnapshotStore)')
{
  const dbPath = await createMigratedDatabase('belot-abl-restart-')
  const now = Date.now()
  const streak = stateWithCounts({ bottom: 6 }, 6, 2)
  const store = await createActiveRoomSnapshotStore(dbPath)
  store.upsertRoom(roomReadyToDeal('abl-restart', ALL_BAD_DECK, streak, now))
  store.close()
  const reopened = await createActiveRoomSnapshotStore(dbPath)
  const restoredRoom = reopened.loadActiveRooms().find((room) => room.id === 'abl-restart')!
  const restoredState = getRoomAuthoritativeGameState(restoredRoom)!
  check('[12a] restart: antiBadLuck (вкл. resetGeneration) оцелява round trip-а', JSON.stringify(restoredState.antiBadLuck) === JSON.stringify(streak))
  const continued = getRoomAuthoritativeGameState(advanceRoomAuthoritativeGame(restoredRoom, now, config(5, 2)))!
  check('[12b] след restart със същата generation: серията продължава → rescue на bottom (count 0), другите seats с 1 BAD', continued.phase === 'deal-first-3' && continued.antiBadLuck!.seats.bottom.consecutiveBadDeals === 0 && continued.antiBadLuck!.seats.top.consecutiveBadDeals === 1)
  const resetAfterRestart = getRoomAuthoritativeGameState(advanceRoomAuthoritativeGame(restoredRoom, now, config(5, 3)))!
  check('[12c] generation, увеличена докато сървърът е бил спрян (switch към 0) → state започва начисто', resetAfterRestart.antiBadLuck!.seats.bottom.consecutiveBadDeals === 1 && resetAfterRestart.antiBadLuck!.resetGeneration === 3)
  const legacyStreak = stateWithCounts({ bottom: 6 }, 6)
  delete legacyStreak.resetGeneration
  reopened.upsertRoom(roomReadyToDeal('abl-legacy', ALL_BAD_DECK, legacyStreak, now))
  const legacyRoom = reopened.loadActiveRooms().find((room) => room.id === 'abl-legacy')!
  const legacyContinued = getRoomAuthoritativeGameState(advanceRoomAuthoritativeGame(legacyRoom, now, config(5, 0)))!
  check('[12d] legacy snapshot без resetGeneration + generation 0 → продължава (без reset при deploy)', legacyContinued.antiBadLuck!.seats.bottom.consecutiveBadDeals === 0 && legacyContinued.antiBadLuck!.resetGeneration === 0)
  reopened.close()
}

// ─── [13] fail-fast по production границите ──────────────────────────────────
console.log('\n[13] production границите изискват config (без fallback)')
{
  const now = Date.now()
  const room = roomReadyToDeal('abl-boundary', ALL_BAD_DECK, undefined, now)
  const state = getRoomAuthoritativeGameState(room)!
  const invalidConfigs: unknown[] = [undefined, null, { threshold: 4, resetGeneration: 0 }, { threshold: 5 }, { threshold: 5, resetGeneration: -1 }, { threshold: '5', resetGeneration: 0 }]
  check('[13a] advanceRoomAuthoritativeGame хвърля при липсващ/невалиден config',
    invalidConfigs.every((value) => throws(() => advanceRoomAuthoritativeGame(room, now, value as ServerAntiBadLuckConfig))))
  check('[13b] dealServerFirstThreePhase хвърля без config', throws(() => (dealServerFirstThreePhase as unknown as (s: ServerAuthoritativeGameState) => unknown)(state)))
  check('[13c] enterServerPhase(deal-first-3, null) хвърля', throws(() => enterServerPhase(state, 'deal-first-3', null)))
  const runtime = createInProcessActiveRoomRuntime(new Map())
  check('[13d] in-process runtime tickRooms хвърля без config', throws(() => runtime.tickRooms({ now, rooms: [room] } as unknown as Parameters<typeof runtime.tickRooms>[0])))
  const viaRuntime = runtime.tickRooms({ now, rooms: [room], antiBadLuckConfig: config(0, 0) })
  const advanced = viaRuntime.results[0]
  const advancedState = advanced?.kind === 'advanced' ? getRoomAuthoritativeGameState(advanced.room) : null
  const expected = dealServerCardsInPackets(ALL_BAD_DECK, createEmptyHands(), FIRST_DEAL_SEAT, 3, 1)
  check('[13e] in-process runtime с праг 0 → естественото раздаване', advancedState !== null && SERVER_SEAT_ORDER.every((seat) => ids(advancedState.hands[seat]) === ids(expected.hands[seat])))

  const registry = createRoomRevisionRegistry()
  registry.ensure(room.id)
  const orchestrator = createGameWorkerTickOrchestrator({ mode: 'in-process', revisionRegistry: registry, syncTickTarget: runtime })
  const badBatch = await orchestrator.computeCandidates({ now, rooms: [room], antiBadLuckConfig: { threshold: 3, resetGeneration: 0 } as unknown as ServerAntiBadLuckConfig })
  check('[13f] orchestrator: невалиден config → status failed (не fallback)', badBatch.status === 'failed' && /antiBadLuckConfig/.test(badBatch.status === 'failed' ? badBatch.message : ''))
  const okBatch = await orchestrator.computeCandidates({ now, rooms: [room], antiBadLuckConfig: config(5, 0) })
  check('[13g] orchestrator: валиден config → completed', okBatch.status === 'completed')

  const sent: unknown[] = []
  const listeners = new Set<(message: unknown) => void>()
  const endpoint = {
    postMessage(message: unknown) {
      sent.push(message)
      const msg = message as { requestId: string; rooms: Array<{ roomId: string; baseRevision: number }> }
      queueMicrotask(() => listeners.forEach((listener) => listener({
        protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
        type: 'compute_tick_rooms_response',
        requestId: msg.requestId,
        results: msg.rooms.map((input) => ({ roomId: input.roomId, baseRevision: input.baseRevision, result: 'unchanged' })),
      })))
    },
    on(_event: 'message', listener: (message: unknown) => void) { listeners.add(listener) },
    off(_event: 'message', listener: (message: unknown) => void) { listeners.delete(listener) },
  }
  const tickClient = createGameWorkerTickClient({ endpoint })
  let rejected = false
  try {
    await tickClient.computeTickRooms([{ roomId: room.id, baseRevision: 0, room }], now, { threshold: 11, resetGeneration: 0 } as unknown as ServerAntiBadLuckConfig)
  } catch {
    rejected = true
  }
  check('[13h] tick client: невалиден config → reject, нищо не е изпратено към worker-а', rejected && sent.length === 0)
  await tickClient.computeTickRooms([{ roomId: room.id, baseRevision: 0, room }], now, config(8, 4))
  const message = sent[0] as Record<string, unknown>
  check('[13i] tick client: съобщението е protocol v4 и носи config-а', message['protocolVersion'] === 4 && GAME_WORKER_PROTOCOL_VERSION === 4 &&
    JSON.stringify(message['antiBadLuckConfig']) === JSON.stringify({ threshold: 8, resetGeneration: 4 }))
  await tickClient.shutdown()
}

// ─── [14] реален game worker (compiled dist) ────────────────────────────────
console.log('\n[14] реален game worker: propagation + allowlist validation')
{
  const worker = new Worker(await resolveGameWorkerEntryUrl(), { workerData: { workerId: 'abl-worker' } })
  const inbox: Array<Record<string, unknown>> = []
  const waiters: Array<() => void> = []
  worker.on('message', (message: Record<string, unknown>) => { inbox.push(message); waiters.splice(0).forEach((wake) => wake()) })
  const waitFor = async (predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = inbox.find(predicate)
      if (found) return found
      if (Date.now() > deadline) throw new Error('worker timeout')
      await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, 100) })
    }
  }
  try {
    await waitFor((message) => message['type'] === 'ready')
    const now = Date.now()
    const tick = async (room: ServerRoom, antiBadLuckConfig: unknown, protocolVersion: number = GAME_WORKER_PROTOCOL_VERSION) => {
      const assignId = randomUUID()
      worker.postMessage({ type: 'assign_room', requestId: assignId, roomId: room.id })
      await waitFor((message) => message['requestId'] === assignId)
      const requestId = randomUUID()
      worker.postMessage({ protocolVersion, type: 'compute_tick_rooms', requestId, now, antiBadLuckConfig, rooms: [{ roomId: room.id, baseRevision: 0, room }] })
      return waitFor((message) => message['requestId'] === requestId)
    }
    const expected = dealServerCardsInPackets(ALL_BAD_DECK, createEmptyHands(), FIRST_DEAL_SEAT, 3, 1)

    const offResponse = await tick(roomReadyToDeal('abl-w-off', ALL_BAD_DECK, stateWithCounts({ bottom: 9, right: 9, top: 9, left: 9 }), now), config(0, 1))
    const offRoom = (offResponse['results'] as Array<{ result: string; room: ServerRoom }>)[0]!
    const offState = offRoom.result === 'advanced' ? getRoomAuthoritativeGameState(offRoom.room) : null
    check('[14a] worker, праг 0: естествено раздаване, state изчистен с generation 1', offState !== null &&
      SERVER_SEAT_ORDER.every((seat) => ids(offState.hands[seat]) === ids(expected.hands[seat])) &&
      offState.antiBadLuck!.seats.bottom.consecutiveBadDeals === 0 && offState.antiBadLuck!.resetGeneration === 1)

    const onResponse = await tick(roomReadyToDeal('abl-w-on', ALL_BAD_DECK, stateWithCounts({ bottom: 9 }, 10, 1, 7), now), config(7, 1))
    const onRoom = (onResponse['results'] as Array<{ result: string; room: ServerRoom }>)[0]!
    const onState = onRoom.result === 'advanced' ? getRoomAuthoritativeGameState(onRoom.room) : null
    check('[14b] worker, праг 7 (9 BAD): rescue е приложен (config-ът реално стига до раздаването)', onState !== null &&
      SERVER_SEAT_ORDER.some((seat) => ids(onState.hands[seat]) !== ids(expected.hands[seat])) && onState.antiBadLuck!.seats.bottom.consecutiveBadDeals === 0)

    const invalids: Array<[string, unknown, number?]> = [
      ['праг 4', { threshold: 4, resetGeneration: 0 }],
      ['липсващ config', undefined],
      ['string праг', { threshold: '5', resetGeneration: 0 }],
      ['отрицателна generation', { threshold: 5, resetGeneration: -1 }],
      ['protocol v3', config(5, 0), 3],
    ]
    for (const [label, invalidConfig, version] of invalids) {
      const response = await tick(roomReadyToDeal(`abl-w-bad-${label}`, ALL_BAD_DECK, undefined, now), invalidConfig, version)
      check(`[14c] worker отказва съобщение (${label}) → worker_error, без compute`, response['type'] === 'worker_error')
    }
  } finally {
    await worker.terminate()
  }
}

// ─── [15] admin settings store ───────────────────────────────────────────────
console.log('\n[15] admin settings store')
{
  const dbPath = await createMigratedDatabase('belot-abl-settings-')
  const raw = (db: DatabaseSync, key: string) => (db.prepare('SELECT setting_value AS v FROM admin_settings WHERE setting_key = ?').get(key) as { v: string } | undefined)?.v
  const probe = new DatabaseSync(dbPath)
  check('[15a] migration seed: anti_bad_luck_threshold=5, anti_bad_luck_reset_generation=0', raw(probe, 'anti_bad_luck_threshold') === '5' && raw(probe, 'anti_bad_luck_reset_generation') === '0')
  let store = await createAdminSettingsStore(dbPath)
  check('[15b] default: settings 5, runtime { 5, 0 }', store.getSettings().antiBadLuckThreshold === 5 && JSON.stringify(store.getAntiBadLuckRuntimeConfig()) === JSON.stringify({ threshold: 5, resetGeneration: 0 }))
  check('[15c] runtime config не изтича в AdminSettingsSnapshot (без resetGeneration)', !('resetGeneration' in store.getSettings()) && !('antiBadLuckResetGeneration' in store.getSettings()))

  let allValid = true
  for (const value of [0, 5, 6, 7, 8, 9, 10, 5] as const) {
    const result = store.updateSettings({ antiBadLuckThreshold: value })
    if (!result.ok || result.settings.antiBadLuckThreshold !== value) allValid = false
  }
  check('[15d] всички allowlist стойности се записват', allValid)
  const generationAfterValid = store.getAntiBadLuckRuntimeConfig().resetGeneration
  let allRejected = true
  for (const value of [1, 4, 11, -1, 5.5, Number.NaN, '5', null, true] as unknown[]) {
    const result = store.updateSettings({ antiBadLuckThreshold: value as ServerAntiBadLuckThreshold })
    if (result.ok) allRejected = false
  }
  check('[15e] невалидни стойности се отказват, нищо не се записва', allRejected && raw(probe, 'anti_bad_luck_threshold') === '5' && store.getAntiBadLuckRuntimeConfig().resetGeneration === generationAfterValid)
  const mixed = store.updateSettings({ antiBadLuckThreshold: 0, freeTopicsVipDays: -5 })
  check('[15f] PATCH с валиден праг + невалидно друго поле → отказан изцяло (atomic, праг непроменен)', !mixed.ok && raw(probe, 'anti_bad_luck_threshold') === '5' && store.getAntiBadLuckRuntimeConfig().resetGeneration === generationAfterValid)

  const generation = () => store.getAntiBadLuckRuntimeConfig().resetGeneration
  const g0 = generation()
  store.updateSettings({ antiBadLuckThreshold: 0 })
  const g1 = generation()
  store.updateSettings({ antiBadLuckThreshold: 0 })
  const g2 = generation()
  store.updateSettings({ antiBadLuckThreshold: 7 })
  const g3 = generation()
  store.updateSettings({ antiBadLuckThreshold: 9 })
  const g4 = generation()
  store.updateSettings({ antiBadLuckThreshold: 0 })
  const g5 = generation()
  check(`[15g] generation: X→0 +1, 0→0 без промяна, 0→7 без промяна, 7→9 без промяна, 9→0 +1 (${[g0, g1, g2, g3, g4, g5].join('→')})`,
    g1 === g0 + 1 && g2 === g1 && g3 === g1 && g4 === g1 && g5 === g1 + 1)

  // threshold + generation са записани в една BEGIN IMMEDIATE транзакция.
  probe.exec('BEGIN IMMEDIATE;')
  const beforeLocked = { t: raw(probe, 'anti_bad_luck_threshold'), g: raw(probe, 'anti_bad_luck_reset_generation') }
  probe.exec('COMMIT;')
  check('[15h] след 9→0 в базата: threshold=0 и generation=' + String(g5) + ' (записани заедно)', beforeLocked.t === '0' && beforeLocked.g === String(g5))

  store.updateSettings({ antiBadLuckThreshold: 8 })
  store.close()
  store = await createAdminSettingsStore(dbPath)
  check('[15i] persistence през „process restart“ (нов store): праг 8, generation запазена', store.getSettings().antiBadLuckThreshold === 8 && generation() === g5)

  probe.prepare(`UPDATE admin_settings SET setting_value = 'abc' WHERE setting_key = 'anti_bad_luck_threshold'`).run()
  probe.prepare(`UPDATE admin_settings SET setting_value = '-3' WHERE setting_key = 'anti_bad_luck_reset_generation'`).run()
  check('[15j] повредени стойности в базата → праг 5 (НЕ 0), generation 0', store.getSettings().antiBadLuckThreshold === 5 && JSON.stringify(store.getAntiBadLuckRuntimeConfig()) === JSON.stringify({ threshold: 5, resetGeneration: 0 }))
  probe.prepare(`DELETE FROM admin_settings WHERE setting_key IN ('anti_bad_luck_threshold', 'anti_bad_luck_reset_generation')`).run()
  check('[15k] липсващи редове → default { 5, 0 }', JSON.stringify(store.getAntiBadLuckRuntimeConfig()) === JSON.stringify({ threshold: 5, resetGeneration: 0 }))
  store.close()
  probe.close()
}

// ─── [16] privacy ────────────────────────────────────────────────────────────
console.log('\n[16] privacy')
{
  const now = Date.now()
  const room = roomReadyToDeal('abl-privacy', ALL_BAD_DECK, stateWithCounts({ bottom: 9 }, 10, 5), now)
  const dealt = advanceRoomAuthoritativeGame(room, now, config(7, 5))
  const json = SERVER_SEAT_ORDER.map((seat) => JSON.stringify(createRoomSnapshotMessage(dealt, seat))).join('\n')
  check('[16a] room snapshot към клиента (всички seats) не съдържа antiBadLuck / resetGeneration / pendingSinceDealIndex / threshold',
    !/antiBadLuck|resetGeneration|pendingSinceDealIndex|consecutiveBadDeals|Threshold/i.test(json))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
