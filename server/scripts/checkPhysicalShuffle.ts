/**
 * checkPhysicalShuffle.ts — физическо размесване на камарата (Anti Bad Luck = 0).
 *
 * [1]  allowlist / runtime config validation (physicalShuffleMode)
 * [2]  размер на пакета: 6..16 включително, никога равен на предишния
 * [3]  RANDOM_INSERT: 3..6 прехвърляния, отгоре/отдолу, вътрешна позиция,
 *      запазен вътрешен ред на пакета, точно 32 карти, без загуба/дубликат
 * [4]  ALTERNATING_ENDS: строго редуване горе→долу / долу→горе, резултатът
 *      е циклично завъртане, точно 32 карти
 * [5]  общият брой прехвърлени карти НЕ е ограничен до 32
 * [6]  collectServerRoundPile: ред на взятките/картите, всички пас, невалидна камара
 * [7]  resolveServerNextRoundDeck: праг 0 → физическо; праг ≠ 0 / null → случайно;
 *      невалидна камара → fallback
 * [8]  реален server flow (ботове + хора с timeout/bot takeover): камарата от
 *      взятките → ново тесте; детерминистично равенство със seeded RNG
 * [9]  цепене: реален избор на човек + auto cut при timeout — сървърът
 *      ползва избраната позиция, без ново разбъркване; раздаването следва тестето
 * [10] всички пас → прераздаване от ръцете + неразданите карти
 * [11] Anti Bad Luck активен (праг 5) → старото поведение (пълно разбъркване)
 * [12] рестарт / recovery (activeRoomSnapshotStore): по време на scoring,
 *      next-round (всички пас) и cutting
 * [13] admin settings store: default, enum validation, atomic, persistence
 * [14] privacy: snapshot към клиента не съдържа нищо от размесването
 *
 * Пуска се с: npx tsx scripts/checkPhysicalShuffle.ts
 */

import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createSeededRandom, shuffleWithRandom } from '../src/core/seededRandom.js'
import {
  isServerAntiBadLuckConfig,
  type ServerAntiBadLuckConfig,
  type ServerAntiBadLuckThreshold,
} from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { createServerDeck } from '../src/game/createServerDeck.js'
import { createEmptyHands } from '../src/game/createServerRoundDefaults.js'
import { cutServerDeck } from '../src/game/cutServerDeck.js'
import { dealServerCardsInPackets } from '../src/game/dealServerCardsInPackets.js'
import { rebaseServerStateToEventAt } from '../src/game/rebaseServerStateToEventAt.js'
import { resumeHumanControlForRoom } from '../src/game/resumeHumanControlForRoom.js'
import { runServerPhaseTransition } from '../src/game/runServerPhaseTransition.js'
import { startNextServerRound } from '../src/game/startNextServerRound.js'
import { submitHumanCutIndexForRoom } from '../src/game/submitHumanCutIndexForRoom.js'
import { submitServerBidAction } from '../src/game/submitServerBidAction.js'
import {
  applyServerPhysicalShuffle,
  pickServerPhysicalShufflePacketSize,
} from '../src/game/physicalShuffle/applyServerPhysicalShuffle.js'
import { collectServerRoundPile, isServerFullDeckPermutation } from '../src/game/physicalShuffle/collectServerRoundPile.js'
import { resolveServerNextRoundDeck } from '../src/game/physicalShuffle/resolveServerNextRoundDeck.js'
import {
  SERVER_PHYSICAL_SHUFFLE_MODES,
  isServerPhysicalShuffleMode,
  type ServerPhysicalShuffleMode,
} from '../src/game/physicalShuffle/serverPhysicalShuffleTypes.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerCompletedTrick } from '../src/game/serverGameTypes.js'
import { createActiveRoomSnapshotStore } from '../src/db/activeRoomSnapshotStore.js'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { createRoomSnapshotMessage } from '../src/protocol/createRoomSnapshotMessage.js'
import {
  auth,
  buildRealisticRoom,
  driveUntil,
  isNewRoundCutting,
  isRotationOf,
  playRoundToEnd,
  preservedAdjacentPairs,
  startMatch,
  withState,
  type Driven,
} from './fixtures/belotRoundDriver.js'

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FULL_DECK = createServerDeck()
const ids = (cards: readonly ServerCard[]) => cards.map((card) => card.id).join(',')

function cfg(threshold: ServerAntiBadLuckThreshold, mode?: ServerPhysicalShuffleMode): ServerAntiBadLuckConfig {
  return mode === undefined ? { threshold, resetGeneration: 0 } : { threshold, resetGeneration: 0, physicalShuffleMode: mode }
}


// Независима реимплементация на прехвърлянията по лога — доказва, че
// резултатът е точно описаното преместване (вкл. запазен вътрешен ред).
function replayTransfers(deck: readonly ServerCard[], transfers: ReturnType<typeof applyServerPhysicalShuffle>['transfers']): ServerCard[] {
  let working = [...deck]
  for (const transfer of transfers) {
    const packet = transfer.takenFrom === 'top' ? working.slice(0, transfer.packetSize) : working.slice(working.length - transfer.packetSize)
    const rest = transfer.takenFrom === 'top' ? working.slice(transfer.packetSize) : working.slice(0, working.length - transfer.packetSize)
    if (transfer.placedAt === 'top') working = [...packet, ...rest]
    else if (transfer.placedAt === 'bottom') working = [...rest, ...packet]
    else working = [...rest.slice(0, transfer.insertIndex!), ...packet, ...rest.slice(transfer.insertIndex!)]
  }
  return working
}


// ─── [1] validation ──────────────────────────────────────────────────────────
console.log('\n[1] allowlist / runtime config validation')
{
  check('[1a] modes = RANDOM_INSERT, ALTERNATING_ENDS', JSON.stringify(SERVER_PHYSICAL_SHUFFLE_MODES) === JSON.stringify(['RANDOM_INSERT', 'ALTERNATING_ENDS']))
  check('[1b] isServerPhysicalShuffleMode отказва непознати', ['random_insert', 'RANDOM', '', null, 1, {}, undefined].every((value) => !isServerPhysicalShuffleMode(value)))
  check('[1c] runtime config с валиден/липсващ mode е валиден', isServerAntiBadLuckConfig(cfg(0, 'RANDOM_INSERT')) && isServerAntiBadLuckConfig(cfg(0, 'ALTERNATING_ENDS')) && isServerAntiBadLuckConfig(cfg(0)))
  check('[1d] runtime config с невалиден mode се отказва (worker/tick граници)', !isServerAntiBadLuckConfig({ threshold: 0, resetGeneration: 0, physicalShuffleMode: 'SHUFFLE' }) && !isServerAntiBadLuckConfig({ threshold: 0, resetGeneration: 0, physicalShuffleMode: null }))
}

// ─── [2] packet size ─────────────────────────────────────────────────────────
console.log('\n[2] размер на пакета 6..16, без поредно повторение')
{
  const rng = createSeededRandom('packet-size')
  const seen = new Set<number>()
  let inRange = true
  let repeated = false
  let previous: number | null = null
  for (let index = 0; index < 20_000; index += 1) {
    const size = pickServerPhysicalShufflePacketSize(previous, rng)
    if (!Number.isInteger(size) || size < 6 || size > 16) inRange = false
    if (size === previous) repeated = true
    seen.add(size)
    previous = size
  }
  check('[2a] 20 000 избора: винаги цяло число в 6..16', inRange)
  check('[2b] всички 11 стойности (вкл. границите 6 и 16) се срещат', seen.size === 11 && seen.has(6) && seen.has(16))
  check('[2c] никога два поредни еднакви размера', !repeated)
  const edges = [0, 0.999999999, 1, -0.1, Number.NaN]
  const edgeOk = edges.every((value) => [null, 6, 11, 16].every((prev) => {
    const size = pickServerPhysicalShufflePacketSize(prev, () => value)
    return size >= 6 && size <= 16 && size !== prev
  }))
  check('[2d] RNG граници (0, ~1, 1, <0, NaN) → пак 6..16 и ≠ предишния', edgeOk)
  check('[2e] previous=6 и RNG=0 → 7; previous=16 и RNG≈1 → 15', pickServerPhysicalShufflePacketSize(6, () => 0) === 7 && pickServerPhysicalShufflePacketSize(16, () => 0.9999999) === 15)
}

// ─── [3] RANDOM_INSERT ───────────────────────────────────────────────────────
console.log('\n[3] RANDOM_INSERT')
{
  const transferCounts = new Set<number>()
  const sizes = new Set<number>()
  const fromEnds = new Set<string>()
  let permutationOk = true
  let replayOk = true
  let insideOk = true
  let consecutiveOk = true
  let rangeOk = true
  let neverNoop = true
  let minPreserved = 31
  for (let seed = 0; seed < 5000; seed += 1) {
    const input = shuffleWithRandom(FULL_DECK, createSeededRandom(`ri-deck-${seed}`))
    const result = applyServerPhysicalShuffle(input, 'RANDOM_INSERT', createSeededRandom(`ri-${seed}`))
    transferCounts.add(result.transfers.length)
    if (result.transfers.length < 3 || result.transfers.length > 6) rangeOk = false
    if (!isServerFullDeckPermutation(result.deck) || result.deck.length !== 32 || new Set(result.deck.map((card) => card.id)).size !== 32) permutationOk = false
    if (ids(replayTransfers(input, result.transfers)) !== ids(result.deck)) replayOk = false
    let working = [...input]
    result.transfers.forEach((transfer, index) => {
      sizes.add(transfer.packetSize)
      fromEnds.add(transfer.takenFrom)
      if (transfer.packetSize < 6 || transfer.packetSize > 16) rangeOk = false
      if (index > 0 && transfer.packetSize === result.transfers[index - 1]!.packetSize) consecutiveOk = false
      const restLength = 32 - transfer.packetSize
      if (transfer.placedAt !== 'inside' || transfer.insertIndex === null || transfer.insertIndex < 1 || transfer.insertIndex > restLength - 1) insideOk = false
      const next = replayTransfers(working, [transfer])
      if (ids(next) === ids(working)) neverNoop = false
      working = next
    })
    minPreserved = Math.min(minPreserved, preservedAdjacentPairs(input, result.deck))
  }
  check('[3a] 5000 runs: 32 уникални карти = пълното тесте (без загуба/дубликат/замяна)', permutationOk)
  check(`[3b] брой прехвърляния 3..6, всички стойности срещнати (${[...transferCounts].sort().join(',')})`, rangeOk && transferCounts.size === 4)
  check(`[3c] размери 6..16, вкл. границите (${[...sizes].sort((a, b) => a - b).join(',')})`, sizes.size === 11 && sizes.has(6) && sizes.has(16))
  check('[3d] никога два поредни пакета с еднакъв размер', consecutiveOk)
  check('[3e] пакетът се взима и отгоре, и отдолу', fromEnds.has('top') && fromEnds.has('bottom'))
  check('[3f] вмъкване само на вътрешна позиция (1..остатък−1)', insideOk)
  check('[3g] независим replay по лога = резултата (запазен вътрешен ред на пакета, всяко прехвърляне върху цялото тесте)', replayOk)
  check('[3h] всяко прехвърляне реално променя реда', neverNoop)
  check(`[3i] ≥ 19 от 31 съседни двойки оцеляват (≤2 скъсвания на прехвърляне; min=${minPreserved}) — НЕ пълно разбъркване`, minPreserved >= 19)
  const a = applyServerPhysicalShuffle(FULL_DECK, 'RANDOM_INSERT', createSeededRandom('same'))
  const b = applyServerPhysicalShuffle(FULL_DECK, 'RANDOM_INSERT', createSeededRandom('same'))
  check('[3j] детерминистичен при същия seed; входът не се мутира', ids(a.deck) === ids(b.deck) && ids(FULL_DECK) === ids(createServerDeck()))
  let threw = false
  try { applyServerPhysicalShuffle(FULL_DECK.slice(0, 17), 'RANDOM_INSERT') } catch { threw = true }
  check('[3k] тесте < 18 карти → хвърля (няма вътрешна позиция за пакет 16)', threw)
}

// ─── [4] ALTERNATING_ENDS ────────────────────────────────────────────────────
console.log('\n[4] ALTERNATING_ENDS')
{
  let alternating = true
  let rotation = true
  let permutationOk = true
  let consecutiveOk = true
  let replayOk = true
  const transferCounts = new Set<number>()
  const sizes = new Set<number>()
  for (let seed = 0; seed < 5000; seed += 1) {
    const input = shuffleWithRandom(FULL_DECK, createSeededRandom(`ae-deck-${seed}`))
    const result = applyServerPhysicalShuffle(input, 'ALTERNATING_ENDS', createSeededRandom(`ae-${seed}`))
    transferCounts.add(result.transfers.length)
    result.transfers.forEach((transfer, index) => {
      sizes.add(transfer.packetSize)
      const expected = index % 2 === 0 ? ['top', 'bottom'] : ['bottom', 'top']
      if (transfer.takenFrom !== expected[0] || transfer.placedAt !== expected[1]) alternating = false
      if (index > 0 && transfer.packetSize === result.transfers[index - 1]!.packetSize) consecutiveOk = false
    })
    if (!isRotationOf(input, result.deck)) rotation = false
    if (!isServerFullDeckPermutation(result.deck)) permutationOk = false
    if (ids(replayTransfers(input, result.transfers)) !== ids(result.deck)) replayOk = false
  }
  check('[4a] първо отгоре→отдолу, после отдолу→отгоре, строго редуване', alternating)
  check(`[4b] 3..6 прехвърляния (${[...transferCounts].sort().join(',')}), размери 6..16 вкл. границите`, transferCounts.size === 4 && Math.min(...transferCounts) === 3 && Math.max(...transferCounts) === 6 && sizes.size === 11 && sizes.has(6) && sizes.has(16))
  check('[4c] никога два поредни пакета с еднакъв размер', consecutiveOk)
  check('[4d] резултатът е циклично завъртане на входа (документирано)', rotation)
  check('[4e] 32 уникални карти; replay по лога съвпада', permutationOk && replayOk)
}

// ─── [5] общият брой прехвърлени карти ───────────────────────────────────────
console.log('\n[5] общият брой прехвърлени карти не е ограничен до 32')
{
  let maxTotal = 0
  for (const mode of SERVER_PHYSICAL_SHUFFLE_MODES) {
    for (let seed = 0; seed < 2000; seed += 1) {
      const result = applyServerPhysicalShuffle(FULL_DECK, mode, createSeededRandom(`total-${mode}-${seed}`))
      maxTotal = Math.max(maxTotal, result.transfers.reduce((sum, transfer) => sum + transfer.packetSize, 0))
    }
  }
  check(`[5a] срещат се общо > 32 прехвърлени карти (max ${maxTotal}), тестето остава 32`, maxTotal > 32)
}

// ─── [6] collectServerRoundPile ──────────────────────────────────────────────
console.log('\n[6] събиране на камарата')
{
  const base = auth(buildRealisticRoom())
  const order = shuffleWithRandom(FULL_DECK, createSeededRandom('pile'))
  const seats = ['right', 'top', 'left', 'bottom'] as const
  const tricks: ServerCompletedTrick[] = Array.from({ length: 8 }, (_, trickIndex) => ({
    trickIndex,
    leaderSeat: 'right',
    winnerSeat: 'right',
    winningTeam: 'B',
    plays: seats.map((seat, offset) => ({ seat, card: order[trickIndex * 4 + offset]! })),
  }))
  const played: ServerAuthoritativeGameState = {
    ...base,
    phase: 'scoring',
    round: { ...base.round, firstDealSeat: 'right' },
    deck: [],
    hands: createEmptyHands(),
    playing: { ...base.playing!, completedTricks: tricks } as ServerAuthoritativeGameState['playing'],
  }
  const pile = collectServerRoundPile(played)
  check('[6a] 8 взятки → 32 карти в хронологичен ред и ред на игра във взятката', pile?.source === 'tricks' && ids(pile.cards) === ids(order))

  const dealtFive = dealServerCardsInPackets(order, createEmptyHands(), 'right', 3, 1)
  const dealtNext = dealServerCardsInPackets(dealtFive.remainingDeck, dealtFive.hands, 'right', 2, 1)
  const allPass: ServerAuthoritativeGameState = {
    ...base,
    phase: 'next-round',
    round: { ...base.round, firstDealSeat: 'right' },
    deck: dealtNext.remainingDeck,
    hands: dealtNext.hands,
  }
  const allPassPile = collectServerRoundPile(allPass)
  const expectedAllPass = [...dealtNext.hands.right, ...dealtNext.hands.top, ...dealtNext.hands.left, ...dealtNext.hands.bottom, ...dealtNext.remainingDeck]
  check('[6b] всички пас: ръцете по ред на раздаване (от firstDealSeat) + 12-те неразданите отдолу', allPassPile?.source === 'all-pass' && ids(allPassPile.cards) === ids(expectedAllPass))

  const duplicated = { ...played, playing: { ...played.playing!, completedTricks: tricks.map((trick, index) => index === 7 ? { ...trick, plays: trick.plays.map((play) => ({ ...play, card: order[0]! })) } : trick) } }
  const missing = { ...played, playing: { ...played.playing!, completedTricks: tricks.slice(0, 7) } }
  const replaced = { ...played, playing: { ...played.playing!, completedTricks: tricks.map((trick, index) => index === 0 ? { ...trick, plays: trick.plays.map((play, i) => i === 0 ? { ...play, card: { id: 'joker-X', suit: 'spades', rank: 'A' } as unknown as ServerCard } : play) } : trick) } }
  check('[6c] дубликат / липсваща / чужда карта → null (не се ползва)', collectServerRoundPile(duplicated as ServerAuthoritativeGameState) === null && collectServerRoundPile(missing as ServerAuthoritativeGameState) === null && collectServerRoundPile(replaced as ServerAuthoritativeGameState) === null)

  // [7] resolveServerNextRoundDeck върху същите fixtures
  console.log('\n[7] resolveServerNextRoundDeck')
  const physical = resolveServerNextRoundDeck(played, cfg(0, 'ALTERNATING_ENDS'), createSeededRandom('r7'))
  check('[7a] праг 0 + ALTERNATING_ENDS → physical-shuffle, завъртане на камарата', physical.origin === 'physical-shuffle' && physical.mode === 'ALTERNATING_ENDS' && isRotationOf(order, physical.deck))
  const expectedRandomInsert = applyServerPhysicalShuffle(order, 'RANDOM_INSERT', createSeededRandom('r7b'))
  const defaultMode = resolveServerNextRoundDeck(played, cfg(0), createSeededRandom('r7b'))
  check('[7b] праг 0 без mode → RANDOM_INSERT (default), точно = applyServerPhysicalShuffle(камарата)', defaultMode.mode === 'RANDOM_INSERT' && ids(defaultMode.deck) === ids(expectedRandomInsert.deck))
  let rngCalls = 0
  const active = resolveServerNextRoundDeck(played, cfg(5, 'ALTERNATING_ENDS'), () => { rngCalls += 1; return 0.5 })
  const legacy = resolveServerNextRoundDeck(played, null)
  check('[7c] праг 5 (Anti Bad Luck активен) → fresh-random, физическото RNG не се вика', active.origin === 'fresh-random' && rngCalls === 0 && isServerFullDeckPermutation(active.deck))
  check('[7d] без config (стари извиквания) → fresh-random', legacy.origin === 'fresh-random' && isServerFullDeckPermutation(legacy.deck))
  const originalWarn = console.warn
  console.warn = () => {}
  const fallback = resolveServerNextRoundDeck(duplicated as ServerAuthoritativeGameState, cfg(0, 'RANDOM_INSERT'))
  console.warn = originalWarn
  check('[7e] праг 0 + невалидна камара → безопасен fallback fresh-random (32 валидни карти)', fallback.origin === 'fresh-random' && isServerFullDeckPermutation(fallback.deck))
  const allPassDeck = resolveServerNextRoundDeck(allPass, cfg(0, 'ALTERNATING_ENDS'), createSeededRandom('r7f'))
  check('[7f] всички пас + праг 0 → физическо размесване на ръцете + остатъка', allPassDeck.origin === 'physical-shuffle' && isRotationOf(expectedAllPass, allPassDeck.deck))
}

// ─── [8] реален server flow ──────────────────────────────────────────────────
console.log('\n[8] реален server flow (ботове + хора → timeout/bot takeover)')
const scoringFixtures: Partial<Record<ServerPhysicalShuffleMode, Driven>> = {}
for (const mode of SERVER_PHYSICAL_SHUFFLE_MODES) {
  const config = cfg(0, mode)
  let driven = startMatch(config)
  const firstDeck = auth(driven.room).deck
  check(`[8a ${mode}] първото раздаване: 32 валидни карти от случайно разбъркване (няма предишни взятки)`, isServerFullDeckPermutation(firstDeck) && ids(firstDeck) !== ids(FULL_DECK))
  let transitions = 0
  let invariantOk = true
  let minPreserved = 31
  let sawTricks = false
  // Минимум 6 преминавания и поне едно раздаване с изиграни взятки (ботовете
  // често пасуват); при край на мача → нов мач.
  for (let round = 0; round < 60 && (transitions < 6 || !sawTricks); round += 1) {
    driven = playRoundToEnd(driven, config)
    const endState = auth(driven.room)
    if (endState.matchEnded !== null) { driven = startMatch(config); continue }
    if (endState.phase === 'scoring' && endState.playing && endState.playing.completedTricks.length > 0) sawTricks = true
    if (endState.phase === 'scoring' && !scoringFixtures[mode]) scoringFixtures[mode] = driven
    const pile = collectServerRoundPile(endState)
    if (pile === null) { invariantOk = false; break }
    driven = driveUntil(driven, config, isNewRoundCutting(endState.round.dealerSeat))
    const nextDeck = auth(driven.room).deck
    transitions += 1
    if (!isServerFullDeckPermutation(nextDeck)) invariantOk = false
    if (mode === 'ALTERNATING_ENDS' && !isRotationOf(pile.cards, nextDeck)) invariantOk = false
    minPreserved = Math.min(minPreserved, preservedAdjacentPairs(pile.cards, nextDeck))
  }
  check(`[8b ${mode}] ${transitions} раздавания: новото тесте идва от камарата (${mode === 'ALTERNATING_ENDS' ? 'завъртане' : `≥19 съседни двойки, min=${minPreserved}`})`, transitions >= 6 && sawTricks && invariantOk && minPreserved >= (mode === 'ALTERNATING_ENDS' ? 30 : 19))
  const scoring = scoringFixtures[mode]
  check(`[8c0 ${mode}] има scoring fixture (раздаване с взятки)`, scoring !== undefined)
  if (scoring) {
    const state = auth(scoring.room)
    const viaStartNext = startNextServerRound(state, config, createSeededRandom(`exact-${mode}`))
    const expected = applyServerPhysicalShuffle(collectServerRoundPile(state)!.cards, mode, createSeededRandom(`exact-${mode}`))
    check(`[8c ${mode}] startNextServerRound(scoring) == applyServerPhysicalShuffle(взятките) със същия seed; dealer се сменя`, ids(viaStartNext.deck) === ids(expected.deck) && viaStartNext.phase === 'cutting' && viaStartNext.round.dealerSeat !== state.round.dealerSeat)
    const viaTransition = runServerPhaseTransition(state, config)
    check(`[8d ${mode}] runServerPhaseTransition(scoring) → cutting с тесте от камарата`, viaTransition.phase === 'cutting' && isServerFullDeckPermutation(viaTransition.deck) && preservedAdjacentPairs(collectServerRoundPile(state)!.cards, viaTransition.deck) >= 19)
  }
}

// ─── [9] цепене ──────────────────────────────────────────────────────────────
console.log('\n[9] цепене (човек / auto timeout) върху физически размесеното тесте')
{
  const config = cfg(0, 'RANDOM_INSERT')
  let found = 0
  let humanCutOk = true
  let autoCutOk = true
  let dealOk = true
  let autoChecked = 0
  for (let attempt = 0; attempt < 16 && (found < 2 || autoChecked < 1); attempt += 1) {
    let driven = startMatch(config)
    driven = playRoundToEnd(driven, config)
    if (auth(driven.room).matchEnded !== null) continue
    driven = driveUntil(driven, config, isNewRoundCutting(auth(driven.room).round.dealerSeat))
    const cuttingState = auth(driven.room)
    const preCutDeck = cuttingState.deck
    const cutter = cuttingState.round.cutterSeat!
    // Четни опити: реален човешки избор; нечетни: никой не цепи → timeout →
    // сървърът избира позиция (auto cut / бот).
    if (cuttingState.players[cutter].mode === 'human' && attempt % 2 === 0) {
      // Човекът е изтекъл в предишното раздаване (bot takeover) → „Върни се“
      // и реален избор на позиция.
      const resumed = cuttingState.players[cutter].controlledByBot ? resumeHumanControlForRoom(driven.room, cutter) : { ok: true as const, room: driven.room }
      if (!resumed.ok) { humanCutOk = false; continue }
      const chosen = [9, 19, 27][found % 3]!
      const submitted = submitHumanCutIndexForRoom(resumed.room, cutter, chosen)
      if (!submitted.ok) { humanCutOk = false; continue }
      const resolved = driveUntil({ room: submitted.room, now: driven.now }, config, (state) => state.phase === 'deal-first-3')
      const state = auth(resolved.room)
      if (state.round.selectedCutIndex !== chosen) humanCutOk = false
      const expectedCut = cutServerDeck(preCutDeck, chosen)
      const first = dealServerCardsInPackets(expectedCut, createEmptyHands(), state.round.firstDealSeat!, 3, 1)
      if (ids(state.deck) !== ids(first.remainingDeck) || (['bottom', 'right', 'top', 'left'] as const).some((seat) => ids(state.hands[seat]) !== ids(first.hands[seat]))) dealOk = false
      found += 1
    } else {
      // Бот / bot-controlled cutter → auto cut при timeout.
      const resolved = driveUntil(driven, config, (state) => state.phase === 'deal-first-3')
      const state = auth(resolved.room)
      const index = state.round.selectedCutIndex!
      const expectedCut = cutServerDeck(preCutDeck, index)
      const first = dealServerCardsInPackets(expectedCut, createEmptyHands(), state.round.firstDealSeat!, 3, 1)
      if (!(index >= 1 && index <= 31) || ids(state.deck) !== ids(first.remainingDeck)) autoCutOk = false
      autoChecked += 1
    }
  }
  check(`[9a] човек избира позиция (${found} случая) → сървърът цепи точно там`, humanCutOk && found >= 2)
  check('[9b] след цепенето няма ново разбъркване: първите 3 карти/остатъкът = естественото раздаване на цепеното тесте', dealOk && found >= 2)
  check(`[9c] auto cut (бот / timeout, ${autoChecked} случая) използва избрания индекс върху същото тесте`, autoCutOk && autoChecked >= 1)

  // Пълно раздаване 3+2 → bidding: ръцете следват цепеното тесте.
  let driven = startMatch(config)
  driven = playRoundToEnd(driven, config)
  while (auth(driven.room).matchEnded !== null) driven = playRoundToEnd(startMatch(config), config)
  {
    driven = driveUntil(driven, config, isNewRoundCutting(auth(driven.room).round.dealerSeat))
    const preCut = auth(driven.room).deck
    driven = driveUntil(driven, config, (state) => state.phase === 'bidding')
    const state = auth(driven.room)
    const cut = cutServerDeck(preCut, state.round.selectedCutIndex!)
    const a = dealServerCardsInPackets(cut, createEmptyHands(), state.round.firstDealSeat!, 3, 1)
    const b = dealServerCardsInPackets(a.remainingDeck, a.hands, state.round.firstDealSeat!, 2, 1)
    check('[9d] bidding: 5-те карти на всяка ръка = раздаване 3+2 от цепеното тесте (Anti Bad Luck 0 не пипа тестето)', (['bottom', 'right', 'top', 'left'] as const).every((seat) => ids(state.hands[seat]) === ids(b.hands[seat])) && ids(state.deck) === ids(b.remainingDeck))
  }
}

// ─── [10] всички пас ─────────────────────────────────────────────────────────
console.log('\n[10] всички пас → прераздаване')
function forceAllPass(driven: Driven, config: ServerAntiBadLuckConfig): Driven {
  const atBidding = driveUntil(driven, config, (state) => state.phase === 'bidding' && state.bidding.currentSeat !== null)
  let state = auth(atBidding.room)
  for (let index = 0; index < 4 && state.phase === 'bidding'; index += 1) {
    state = submitServerBidAction(state, { type: 'pass' })
  }
  // submitServerBidAction stamp-ва phaseEnteredAt с Date.now(); ребазираме към
  // часовника на driver-а (както прави engine-ът при catch-up).
  return { room: withState(atBidding.room, rebaseServerStateToEventAt(state, atBidding.now)), now: atBidding.now }
}
{
  for (const mode of SERVER_PHYSICAL_SHUFFLE_MODES) {
    const config = cfg(0, mode)
    const passed4 = forceAllPass(startMatch(config), config)
    const passState = auth(passed4.room)
    const pile = collectServerRoundPile(passState)
    check(`[10a ${mode}] 4 паса → next-round; камарата = 20 карти от ръцете + 12 неразданите`, passState.phase === 'next-round' && pile?.source === 'all-pass' && pile.cards.length === 32)
    const next = driveUntil(passed4, config, isNewRoundCutting(passState.round.dealerSeat))
    const nextState = auth(next.room)
    check(`[10b ${mode}] прераздаването ползва тази камара (dealer се мести, ${mode === 'ALTERNATING_ENDS' ? 'завъртане' : '≥19 съседни двойки'})`, nextState.round.dealerSeat !== passState.round.dealerSeat && (mode === 'ALTERNATING_ENDS' ? isRotationOf(pile!.cards, nextState.deck) : preservedAdjacentPairs(pile!.cards, nextState.deck) >= 19))
    const exact = startNextServerRound(passState, config, createSeededRandom(`allpass-${mode}`))
    check(`[10c ${mode}] детерминистично: = applyServerPhysicalShuffle(камарата от всички пас)`, ids(exact.deck) === ids(applyServerPhysicalShuffle(pile!.cards, mode, createSeededRandom(`allpass-${mode}`)).deck))
  }
}

// ─── [11] Anti Bad Luck активен ──────────────────────────────────────────────
console.log('\n[11] Anti Bad Luck активен (праг 5) → старото поведение')
{
  const config = cfg(5, 'ALTERNATING_ENDS')
  let driven = startMatch(config)
  let total = 0
  let rounds = 0
  let rotations = 0
  for (let round = 0; round < 60 && rounds < 6; round += 1) {
    driven = playRoundToEnd(driven, config)
    const endState = auth(driven.room)
    if (endState.matchEnded !== null) { driven = startMatch(config); continue }
    const pile = collectServerRoundPile(endState)!
    driven = driveUntil(driven, config, isNewRoundCutting(endState.round.dealerSeat))
    const deck = auth(driven.room).deck
    total += preservedAdjacentPairs(pile.cards, deck)
    if (isRotationOf(pile.cards, deck)) rotations += 1
    rounds += 1
  }
  check(`[11a] ${rounds} раздавания: тестето НЕ идва от камарата (средно ${(total / Math.max(1, rounds)).toFixed(2)} съседни двойки, очаквано ≈1 при пълно разбъркване)`, rounds >= 6 && rotations === 0 && total / rounds < 6)
}

// ─── [12] restart / recovery ─────────────────────────────────────────────────
console.log('\n[12] рестарт / recovery (activeRoomSnapshotStore)')
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

{
  const dbPath = await createMigratedDatabase('belot-physical-shuffle-')
  const config = cfg(0, 'ALTERNATING_ENDS')
  const store = await createActiveRoomSnapshotStore(dbPath)

  // (a) рестарт по време на scoring
  const scoring = scoringFixtures.ALTERNATING_ENDS!
  const pileBefore = collectServerRoundPile(auth(scoring.room))!
  store.upsertRoom(scoring.room)
  store.close()
  const reopened = await createActiveRoomSnapshotStore(dbPath)
  const restoredScoring = reopened.loadActiveRooms().find((room) => room.id === scoring.room.id)!
  const pileAfter = collectServerRoundPile(auth(restoredScoring))
  check('[12a] scoring snapshot round trip пази взятките в същия ред', pileAfter !== null && ids(pileAfter.cards) === ids(pileBefore.cards))
  const resumed = driveUntil({ room: restoredScoring, now: scoring.now }, config, isNewRoundCutting(auth(restoredScoring).round.dealerSeat))
  check('[12b] след рестарт: следващото раздаване се размесва от възстановената камара', isRotationOf(pileBefore.cards, auth(resumed.room).deck))

  // (b) рестарт по време на cutting: тестето не се разбърква отново
  reopened.upsertRoom(resumed.room)
  const restoredCutting = reopened.loadActiveRooms().find((room) => room.id === resumed.room.id)!
  const cuttingDeck = auth(resumed.room).deck
  check('[12c] cutting snapshot round trip: тестето е bit-identical (без ново разбъркване)', ids(auth(restoredCutting).deck) === ids(cuttingDeck))
  const afterCut = driveUntil({ room: restoredCutting, now: resumed.now }, config, (state) => state.phase === 'deal-first-3')
  const cutIndex = auth(afterCut.room).round.selectedCutIndex!
  const expected = dealServerCardsInPackets(cutServerDeck(cuttingDeck, cutIndex), createEmptyHands(), auth(afterCut.room).round.firstDealSeat!, 3, 1)
  check('[12d] след рестарт цепенето ползва запазеното тесте', ids(auth(afterCut.room).deck) === ids(expected.remainingDeck))

  // (c) рестарт след всички пас (next-round)
  const passed4 = forceAllPass(startMatch(config), config)
  const allPassPile = collectServerRoundPile(auth(passed4.room))!
  reopened.upsertRoom(passed4.room)
  const restoredPass = reopened.loadActiveRooms().find((room) => room.id === passed4.room.id)!
  const resumedPass = driveUntil({ room: restoredPass, now: passed4.now }, config, isNewRoundCutting(auth(restoredPass).round.dealerSeat))
  check('[12e] рестарт в next-round (всички пас): прераздаването ползва възстановените ръце + остатък', isRotationOf(allPassPile.cards, auth(resumedPass.room).deck))

  // (d) JSON round trip на state-а (worker structuredClone/persist еквивалент)
  const cloned = JSON.parse(JSON.stringify(auth(scoring.room))) as ServerAuthoritativeGameState
  check('[12f] JSON clone на scoring state → същото детерминистично тесте', ids(startNextServerRound(cloned, config, createSeededRandom('clone')).deck) === ids(startNextServerRound(auth(scoring.room), config, createSeededRandom('clone')).deck))
  reopened.close()
}

// ─── [13] admin settings store ───────────────────────────────────────────────
console.log('\n[13] admin settings store')
{
  const dbPath = await createMigratedDatabase('belot-physical-shuffle-settings-')
  const store = await createAdminSettingsStore(dbPath)
  const raw = () => {
    const db = new DatabaseSync(dbPath)
    try { return (db.prepare("SELECT setting_value AS v FROM admin_settings WHERE setting_key = 'physical_shuffle_mode'").get() as { v: string } | undefined)?.v } finally { db.close() }
  }
  check('[13a] default (без ред в базата): RANDOM_INSERT в settings и runtime config', store.getSettings().physicalShuffleMode === 'RANDOM_INSERT' && store.getAntiBadLuckRuntimeConfig().physicalShuffleMode === 'RANDOM_INSERT' && raw() === undefined)
  const invalid = ['random_insert', 'RANDOM', '', 1, null, true, [], {}].map((value) => store.updateSettings({ physicalShuffleMode: value as never }))
  check('[13b] невалидни стойности → отказ, нищо не се записва', invalid.every((result) => !result.ok) && raw() === undefined)
  const updated = store.updateSettings({ physicalShuffleMode: 'ALTERNATING_ENDS' })
  check('[13c] ALTERNATING_ENDS → записан, settings + runtime config обновени веднага', updated.ok && updated.settings.physicalShuffleMode === 'ALTERNATING_ENDS' && raw() === 'ALTERNATING_ENDS' && store.getAntiBadLuckRuntimeConfig().physicalShuffleMode === 'ALTERNATING_ENDS')
  const mixed = store.updateSettings({ physicalShuffleMode: 'RANDOM_INSERT', antiBadLuckThreshold: 4 as never })
  check('[13d] валиден mode + невалиден праг → отказан изцяло (atomic)', !mixed.ok && raw() === 'ALTERNATING_ENDS')
  const other = store.updateSettings({ antiBadLuckThreshold: 0 })
  check('[13e] PATCH само на прага не пипа метода; runtime config носи и двете', other.ok && raw() === 'ALTERNATING_ENDS' && store.getAntiBadLuckRuntimeConfig().threshold === 0 && store.getAntiBadLuckRuntimeConfig().physicalShuffleMode === 'ALTERNATING_ENDS')
  check('[13f] runtime config е валиден за worker границата', isServerAntiBadLuckConfig(store.getAntiBadLuckRuntimeConfig()))
  store.close()
  const reopened = await createAdminSettingsStore(dbPath)
  check('[13g] persistence след reopen (restart)', reopened.getSettings().physicalShuffleMode === 'ALTERNATING_ENDS')
  const db = new DatabaseSync(dbPath)
  db.prepare("UPDATE admin_settings SET setting_value = 'garbage' WHERE setting_key = 'physical_shuffle_mode'").run()
  db.close()
  check('[13h] повредена запазена стойност → RANDOM_INSERT', reopened.getSettings().physicalShuffleMode === 'RANDOM_INSERT' && reopened.getAntiBadLuckRuntimeConfig().physicalShuffleMode === 'RANDOM_INSERT')
  reopened.close()
}

// ─── [14] privacy ────────────────────────────────────────────────────────────
console.log('\n[14] privacy')
{
  const room = scoringFixtures.RANDOM_INSERT?.room ?? buildRealisticRoom()
  const text = (['bottom', 'right', 'top', 'left'] as const).map((seat) => JSON.stringify(createRoomSnapshotMessage(room, seat))).join('\n')
  check('[14a] room snapshot към клиента не съдържа physicalShuffle/transfers', !/physicalShuffle|transfers|RANDOM_INSERT|ALTERNATING_ENDS/.test(text))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
