/**
 * diagnoseAntiBadLuckDeclarations.ts — READ-ONLY диагностика/симулация.
 *
 * НЕ променя runtime Anti Bad Luck логиката, НЕ пипа production файлове.
 * Основните ("baseline") статистики идват директно от реалния
 * applyServerAntiBadLuckToDeck (production, непроменена, 25%/10%). Offline
 * what-if секцията пуска ВЯРНА реплика на retry/fallback orchestration-а
 * (`pickRescues`/`enumerateRescuePlans`/`tryPlan` в
 * applyServerAntiBadLuckToDeck.ts — private там, затова реплицирани тук 1:1)
 * САМО с параметризиран quart/quint allowance threshold вместо hardcoded
 * 25%/10%; вика реалните exported building blocks
 * (pickServerAntiBadLuckRescueType/Variant/Rescue, getServerAntiBadLuckRescueCandidates,
 * applyServerAntiBadLuckRescueSwaps, isServerGoodFirstFive,
 * findServerAntiBadLuckLongRuns) — нулева измислена логика.
 *
 * Валидност на репликата: за seed-натия RNG, репликата на 25%/10% threshold
 * трябва да произведе БИТ-ЗА-БИТ същия candidate/deck като реалната функция
 * (проверено в "Sanity" реда на отчета — очаквано 0 mismatch-а).
 *
 * Run: npx tsx server/scripts/diagnoseAntiBadLuckDeclarations.ts [sampleSize]
 *
 * ---------------------------------------------------------------------------
 * Declaration rules audit (server/src/game/declarations/detectServerDeclarationsInHand.ts):
 *   - RANK_ORDER = 7-8-9-10-J-Q-K-A (същият ред като Anti Bad Luck sequence
 *     guard-а — findServerAntiBadLuckLongRuns е 1:1 съвместим).
 *   - Sequence points: 3=Терца(20), 4=50, 5+=100.
 *   - Square (каре) points: J=200, 9=150, 10/A/K/Q=100. 7 и 8 НЕ дават каре
 *     (getSquarePoints връща null) — 4x7 / 4x8 не са анонс по правилата на
 *     Pika.bg и затова НЕ се броят тук като "artificial four-of-kind".
 *   - И sequence, и square изискват НЕ-"no-trumps" contract, за да се броят
 *     за точки (detectServerDeclarationsInHand връща [] при contract===null
 *     или 'no-trumps'). Anti Bad Luck работи ПРЕДИ bidding, затова тук
 *     форсираме contract='all-trumps' само за да отключим детекцията в
 *     реалния engine (структурна проверка "ръката съдържа X" — не твърдим
 *     какъв ще е реалният contract на конкретната ръка).
 * ---------------------------------------------------------------------------
 */

import { SERVER_SEAT_ORDER, type Seat } from '../src/core/serverTypes.js'
import { createSeededRandom, shuffleWithRandom } from '../src/core/seededRandom.js'
import {
  applyServerAntiBadLuckRescueSwaps,
  applyServerAntiBadLuckToDeck,
  getServerFirstFiveDeckIndicesBySeat,
  getServerFullHandDeckIndicesBySeat,
} from '../src/game/antiBadLuck/applyServerAntiBadLuckToDeck.js'
import {
  getServerAntiBadLuckNaturalAnchorSuits,
  isServerGoodFirstFive,
} from '../src/game/antiBadLuck/evaluateServerFirstFiveQuality.js'
import {
  getServerAntiBadLuckRescueCandidates,
  pickServerAntiBadLuckRescue,
  pickServerAntiBadLuckRescueType,
  pickServerAntiBadLuckRescueVariant,
} from '../src/game/antiBadLuck/pickServerAntiBadLuckRescue.js'
import {
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE,
  SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE,
  findServerAntiBadLuckLongRuns,
  type ServerAntiBadLuckLongRun,
} from '../src/game/antiBadLuck/serverAntiBadLuckSequenceGuard.js'
import {
  getServerAntiBadLuckSquareRanks,
  isServerAntiBadLuckSquarePlanSafe,
} from '../src/game/antiBadLuck/serverAntiBadLuckSquareGuard.js'
import type {
  ServerAntiBadLuckAnchorConstraints,
  ServerAntiBadLuckConfig,
  ServerAntiBadLuckRescue,
  ServerAntiBadLuckState,
} from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { createServerDeck } from '../src/game/createServerDeck.js'
import { SERVER_SUITS } from '../src/game/serverCardConstants.js'
import type {
  ServerAntiBadLuckRescueType,
  ServerCard,
  ServerRank,
} from '../src/game/serverGameTypes.js'

// Огледало на private константата в applyServerAntiBadLuckToDeck.ts.
const MAX_RESCUE_PLAN_ATTEMPTS = 16

const SAMPLE_SIZE = Number(process.argv[2] ?? 100_000)
const FIRST_DEAL_SEAT: Seat = 'right'
const FULL_DECK = createServerDeck()
const FIRST_FIVE_INDICES = getServerFirstFiveDeckIndicesBySeat(FIRST_DEAL_SEAT)
const FULL_HAND_INDICES = getServerFullHandDeckIndicesBySeat(FIRST_DEAL_SEAT)

function firstFive(deck: readonly ServerCard[], seat: Seat): ServerCard[] {
  return FIRST_FIVE_INDICES[seat].map((index) => deck[index])
}

function fullHand(deck: readonly ServerCard[], seat: Seat): ServerCard[] {
  return FULL_HAND_INDICES[seat].map((index) => deck[index])
}

function buildFullHands(deck: readonly ServerCard[]): Record<Seat, ServerCard[]> {
  return {
    bottom: fullHand(deck, 'bottom'),
    right: fullHand(deck, 'right'),
    top: fullHand(deck, 'top'),
    left: fullHand(deck, 'left'),
  }
}

function teamOf(seat: Seat): 'A' | 'B' {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function relationToRescued(seat: Seat): 'rescued' | 'partner' | 'opponent' {
  if (seat === 'bottom') return 'rescued'
  return teamOf(seat) === teamOf('bottom') ? 'partner' : 'opponent'
}

// Square детекцията идва директно от реалния export getServerAntiBadLuckSquareRanks
// (server/src/game/antiBadLuck/serverAntiBadLuckSquareGuard.ts) — не се дублира тук.
const getSquareRanks = getServerAntiBadLuckSquareRanks

// Огледало на classifyTransition() в serverAntiBadLuckSequenceGuard.ts —
// нарочно НЕ export-нато от production файла (диагностичен script не бива
// да го пипа), затова е реплицирано тук 1:1 (само diffing glue около
// findServerAntiBadLuckLongRuns, реалния exported detector).
type RunTransition = 'unchanged' | 'destroyed' | 'new-quart' | 'new-quint-plus'

function classifyRunTransition(
  naturalRun: ServerAntiBadLuckLongRun | undefined,
  postRun: ServerAntiBadLuckLongRun | undefined,
): RunTransition {
  if (!naturalRun) {
    if (!postRun) return 'unchanged'
    return postRun.kind === 'QUART' ? 'new-quart' : 'new-quint-plus'
  }

  const isPreserved = !!postRun && naturalRun.cardIds.every((id) => postRun.cardIds.includes(id))

  if (!isPreserved) return 'destroyed'
  if (postRun!.length === naturalRun.length) return 'unchanged'

  return naturalRun.kind === 'QUART' && postRun!.kind === 'QUINT_PLUS' ? 'new-quint-plus' : 'unchanged'
}

type TableTransitions = {
  destroyed: boolean
  newQuartSeats: Seat[]
  newQuintSeats: Seat[]
}

function classifyTableTransitions(
  naturalHandsBySeat: Record<Seat, ServerCard[]>,
  candidateHandsBySeat: Record<Seat, ServerCard[]>,
): TableTransitions {
  let destroyed = false
  const newQuartSeats: Seat[] = []
  const newQuintSeats: Seat[] = []

  for (const seat of SERVER_SEAT_ORDER) {
    const naturalRuns = findServerAntiBadLuckLongRuns(naturalHandsBySeat[seat])
    const postRuns = findServerAntiBadLuckLongRuns(candidateHandsBySeat[seat])

    for (const suit of SERVER_SUITS) {
      const transition = classifyRunTransition(naturalRuns[suit], postRuns[suit])

      if (transition === 'destroyed') destroyed = true
      if (transition === 'new-quart') newQuartSeats.push(seat)
      if (transition === 'new-quint-plus') newQuintSeats.push(seat)
    }
  }

  return { destroyed, newQuartSeats, newQuintSeats }
}

// Огледало на getAnchorConstraintsForType() в applyServerAntiBadLuckToDeck.ts
// (private там) — построено само върху EXPORTED getServerAntiBadLuckNaturalAnchorSuits.
function getAnchorConstraintsForType(
  type: ServerAntiBadLuckRescueType,
  naturalFirstFive: readonly ServerCard[],
): ServerAntiBadLuckAnchorConstraints {
  if (type === 'ALL_TRUMPS') {
    return { naturalAnchorSuits: getServerAntiBadLuckNaturalAnchorSuits(naturalFirstFive, 'J') }
  }
  if (type === 'NO_TRUMPS') {
    return { naturalAnchorSuits: getServerAntiBadLuckNaturalAnchorSuits(naturalFirstFive, 'A') }
  }
  return { naturalAnchorSuits: [] }
}

// Explicit config — диагностиката остава при текущия production праг 5
// (admin setting default); applyServerAntiBadLuckToDeck вече приема config.
const DIAGNOSTIC_ANTI_BAD_LUCK_CONFIG: ServerAntiBadLuckConfig = { threshold: 5, resetGeneration: 0 }

function stateWithBottomPending(): ServerAntiBadLuckState {
  return {
    dealIndex: 10,
    seats: {
      bottom: { consecutiveBadDeals: 5, pendingSinceDealIndex: 5 },
      right: { consecutiveBadDeals: 0, pendingSinceDealIndex: null },
      top: { consecutiveBadDeals: 0, pendingSinceDealIndex: null },
      left: { consecutiveBadDeals: 0, pendingSinceDealIndex: null },
    },
  }
}

// ---------------------------------------------------------------------------
// Вярна реплика на applyServerAntiBadLuckToDeck-ия retry/fallback за единствен
// pending seat ('bottom', без arbitration draws) — САМО с параметризиран
// quart/quint allowance threshold вместо hardcoded 0.25/0.10. Всичко друго
// (тип 1/3, anchor-aware variant, candidate generation, GOOD checks, sequence
// guard решението "destroyed/0/1/2+") е реалният production код, извикан
// директно през exported функции.
// ---------------------------------------------------------------------------
type SimOutcome = {
  applied: boolean
  rescue: ServerAntiBadLuckRescue | null
  deck: ServerCard[]
  type: ServerAntiBadLuckRescueType
  // Candidate-level guard telemetry: колко валидни-иначе candidates biha
  // създали нова quart/quint и guard-ът ги е допуснал/отхвърлил заради
  // allowance-а по време на ТОЗИ search (за "колко candidates rejected vs
  // allowed" отчета — не влияе на избора, чисто броене).
  quartCandidatesAllowed: number
  quartCandidatesRejected: number
  quintCandidatesAllowed: number
  quintCandidatesRejected: number
  squareCandidatesRejected: number
}

function simulateBottomRescue(
  natural: readonly ServerCard[],
  nextRandom: () => number,
  quartChance: number,
  quintChance: number,
): SimOutcome {
  const isNaturalGoodBySeat: Partial<Record<Seat, boolean>> = {}
  for (const seat of SERVER_SEAT_ORDER) {
    isNaturalGoodBySeat[seat] = isServerGoodFirstFive(firstFive(natural, seat))
  }
  const naturalFullHands = buildFullHands(natural)

  // Мирор на sequenceAllowance draw-а: ТОЧНО 2 извиквания, преди candidate
  // search-а (виж applyServerAntiBadLuckToDeck.ts) — само thresholds-ите са
  // параметризирани тук за offline what-if анализа.
  const allowArtificialQuart = nextRandom() < quartChance
  const allowArtificialQuintPlus = nextRandom() < quintChance

  const type = pickServerAntiBadLuckRescueType(nextRandom)
  const anchorConstraints = getAnchorConstraintsForType(type, firstFive(natural, 'bottom'))
  const variant = pickServerAntiBadLuckRescueVariant(type, nextRandom, anchorConstraints)

  const telemetry = {
    quartCandidatesAllowed: 0,
    quartCandidatesRejected: 0,
    quintCandidatesAllowed: 0,
    quintCandidatesRejected: 0,
    squareCandidatesRejected: 0,
  }

  const isValidPlan = (candidateDeck: ServerCard[]): boolean => {
    const rescuedGoodBottom = isServerGoodFirstFive(firstFive(candidateDeck, 'bottom'))
    const othersStillGood = SERVER_SEAT_ORDER.filter((seat) => seat !== 'bottom').every(
      (seat) => (isNaturalGoodBySeat[seat] ? isServerGoodFirstFive(firstFive(candidateDeck, seat)) : true),
    )
    if (!rescuedGoodBottom || !othersStillGood) return false

    const candidateFullHands = buildFullHands(candidateDeck)
    const { destroyed, newQuartSeats, newQuintSeats } = classifyTableTransitions(naturalFullHands, candidateFullHands)

    if (destroyed) return false
    const totalNew = newQuartSeats.length + newQuintSeats.length

    if (totalNew === 1) {
      if (newQuartSeats.length === 1) {
        if (allowArtificialQuart) telemetry.quartCandidatesAllowed += 1
        else telemetry.quartCandidatesRejected += 1
        if (!allowArtificialQuart) return false
      } else {
        if (allowArtificialQuintPlus) telemetry.quintCandidatesAllowed += 1
        else telemetry.quintCandidatesRejected += 1
        if (!allowArtificialQuintPlus) return false
      }
    } else if (totalNew >= 2) {
      return false
    }

    // Square guard — БЕЗ allowance, унищожено/ново каре reject-ва безусловно.
    if (!isServerAntiBadLuckSquarePlanSafe(naturalFullHands, candidateFullHands)) {
      telemetry.squareCandidatesRejected += 1
      return false
    }

    return true
  }

  // 1) Мирор на pickRescues(): до MAX_RESCUE_PLAN_ATTEMPTS random опита.
  for (let attempt = 0; attempt < MAX_RESCUE_PLAN_ATTEMPTS; attempt += 1) {
    shuffleWithRandom(['bottom'] as Seat[], nextRandom)
    const candidate = pickServerAntiBadLuckRescue(type, new Set<string>(), nextRandom, variant, anchorConstraints)
    if (!candidate) continue

    const candidateDeck = applyServerAntiBadLuckRescueSwaps(natural, FIRST_FIVE_INDICES, { bottom: candidate }, nextRandom)
    if (isValidPlan(candidateDeck)) {
      return { applied: true, rescue: candidate, deck: candidateDeck, type, ...telemetry }
    }
  }

  // 2) Мирор на enumerateRescuePlans(): изчерпателно, preferred variant първи.
  shuffleWithRandom(['bottom'] as Seat[], nextRandom)
  const allCandidates = getServerAntiBadLuckRescueCandidates(type, anchorConstraints)
  const orderedCandidates = [
    ...shuffleWithRandom(allCandidates.filter((candidate) => candidate.variant === variant), nextRandom),
    ...shuffleWithRandom(allCandidates.filter((candidate) => candidate.variant !== variant), nextRandom),
  ]

  for (const candidate of orderedCandidates) {
    const candidateDeck = applyServerAntiBadLuckRescueSwaps(natural, FIRST_FIVE_INDICES, { bottom: candidate }, nextRandom)
    if (isValidPlan(candidateDeck)) {
      return { applied: true, rescue: candidate, deck: candidateDeck, type, ...telemetry }
    }
  }

  return { applied: false, rescue: null, deck: natural as ServerCard[], type, ...telemetry }
}

// ---------------------------------------------------------------------------
// Статистики
// ---------------------------------------------------------------------------
let totalExecutions = 0
let appliedCount = 0
let replicaMismatches = 0
let destroyedSanityViolations = 0

const typeCounts: Record<ServerAntiBadLuckRescueType, number> = { SUIT: 0, ALL_TRUMPS: 0, NO_TRUMPS: 0 }

let naturalQuartTotal = 0
let naturalQuintTotal = 0
let artificialQuartTotal = 0
let artificialQuintTotal = 0
const artificialQuartByRelation: Record<'rescued' | 'partner' | 'opponent', number> = { rescued: 0, partner: 0, opponent: 0 }
const artificialQuintByRelation: Record<'rescued' | 'partner' | 'opponent', number> = { rescued: 0, partner: 0, opponent: 0 }

const naturalSquareByRank = new Map<ServerRank, number>()
const artificialSquareByRank = new Map<ServerRank, number>()
const artificialSquareRescuedByRank = new Map<ServerRank, number>()
const artificialSquareOtherByRank = new Map<ServerRank, number>()

let executionsNoNewDeclaration = 0
let executionsWithArtificialQuart = 0
let executionsWithArtificialQuintPlus = 0
let executionsWithArtificialSquare = 0
let executionsWithMultipleArtificial = 0

let baselineQuartCandidatesAllowed = 0
let baselineQuartCandidatesRejected = 0
let baselineQuintCandidatesAllowed = 0
let baselineQuintCandidatesRejected = 0
let baselineSquareCandidatesRejected = 0

type WhatIf = {
  label: string
  quartChance: number
  quintChance: number
  clean: number
  quart: number
  quint: number
  pending: number
}
const whatIfScenarios: WhatIf[] = [
  { label: 'baseline 25%/10% (текущо production, реплика)', quartChance: SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE, quintChance: SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE, clean: 0, quart: 0, quint: 0, pending: 0 },
  { label: 'QUART 15% / QUINT 5%', quartChance: 0.15, quintChance: 0.05, clean: 0, quart: 0, quint: 0, pending: 0 },
  { label: 'QUART 10% / QUINT 5%', quartChance: 0.10, quintChance: 0.05, clean: 0, quart: 0, quint: 0, pending: 0 },
  { label: 'QUART 10% / QUINT 2%', quartChance: 0.10, quintChance: 0.02, clean: 0, quart: 0, quint: 0, pending: 0 },
]

function classifySimOutcome(natural: readonly ServerCard[], sim: SimOutcome): 'clean' | 'quart' | 'quint' | 'pending' {
  if (!sim.applied) return 'pending'
  const { newQuartSeats, newQuintSeats } = classifyTableTransitions(buildFullHands(natural), buildFullHands(sim.deck))
  if (newQuartSeats.length > 0) return 'quart'
  if (newQuintSeats.length > 0) return 'quint'
  return 'clean'
}

// ---------------------------------------------------------------------------
// Основен цикъл
// ---------------------------------------------------------------------------
for (let seed = 0; seed < SAMPLE_SIZE; seed += 1) {
  const natural = shuffleWithRandom(FULL_DECK, createSeededRandom(`diag-natural-${seed}`))
  const dealSeed = `diag-deal-${seed}`

  // --- Baseline статистики: РЕАЛНАТА, непроменена production функция ---
  const result = applyServerAntiBadLuckToDeck(natural, FIRST_DEAL_SEAT, stateWithBottomPending(), createSeededRandom(dealSeed), DIAGNOSTIC_ANTI_BAD_LUCK_CONFIG)

  if (!result.rescueKinds.bottom) {
    continue // bottom естествено GOOD — rescue изобщо не се опитва
  }

  totalExecutions += 1
  const type = result.rescueKinds.bottom.type
  typeCounts[type] += 1

  const naturalFullHands = buildFullHands(natural)
  const naturalSquareRanksBySeat: Record<Seat, Set<ServerRank>> = {
    bottom: getSquareRanks(naturalFullHands.bottom),
    right: getSquareRanks(naturalFullHands.right),
    top: getSquareRanks(naturalFullHands.top),
    left: getSquareRanks(naturalFullHands.left),
  }
  for (const seat of SERVER_SEAT_ORDER) {
    for (const rank of naturalSquareRanksBySeat[seat]) {
      naturalSquareByRank.set(rank, (naturalSquareByRank.get(rank) ?? 0) + 1)
    }
  }

  for (const seat of SERVER_SEAT_ORDER) {
    const runs = findServerAntiBadLuckLongRuns(naturalFullHands[seat])
    if (SERVER_SUITS.some((suit) => runs[suit]?.kind === 'QUART')) naturalQuartTotal += 1
    if (SERVER_SUITS.some((suit) => runs[suit]?.kind === 'QUINT_PLUS')) naturalQuintTotal += 1
  }

  const applied = !!result.rescues.bottom
  if (applied) appliedCount += 1

  const finalFullHands = buildFullHands(result.deck)
  const { destroyed, newQuartSeats, newQuintSeats } = classifyTableTransitions(naturalFullHands, finalFullHands)
  if (destroyed) destroyedSanityViolations += 1 // не би трябвало НИКОГА да е true в реален applied резултат

  let artificialDeclarationsThisExecution = 0

  if (newQuartSeats.length > 0) {
    executionsWithArtificialQuart += 1
    artificialQuartTotal += newQuartSeats.length
    artificialDeclarationsThisExecution += newQuartSeats.length
    for (const seat of newQuartSeats) artificialQuartByRelation[relationToRescued(seat)] += 1
  }
  if (newQuintSeats.length > 0) {
    executionsWithArtificialQuintPlus += 1
    artificialQuintTotal += newQuintSeats.length
    artificialDeclarationsThisExecution += newQuintSeats.length
    for (const seat of newQuintSeats) artificialQuintByRelation[relationToRescued(seat)] += 1
  }

  let sawArtificialSquareThisExecution = false
  for (const seat of SERVER_SEAT_ORDER) {
    const finalSquareRanks = getSquareRanks(finalFullHands[seat])
    for (const rank of finalSquareRanks) {
      if (!naturalSquareRanksBySeat[seat].has(rank)) {
        artificialSquareByRank.set(rank, (artificialSquareByRank.get(rank) ?? 0) + 1)
        artificialDeclarationsThisExecution += 1
        sawArtificialSquareThisExecution = true
        if (seat === 'bottom') {
          artificialSquareRescuedByRank.set(rank, (artificialSquareRescuedByRank.get(rank) ?? 0) + 1)
        } else {
          artificialSquareOtherByRank.set(rank, (artificialSquareOtherByRank.get(rank) ?? 0) + 1)
        }
      }
    }
  }
  if (sawArtificialSquareThisExecution) executionsWithArtificialSquare += 1

  if (artificialDeclarationsThisExecution === 0) executionsNoNewDeclaration += 1
  if (artificialDeclarationsThisExecution > 1) executionsWithMultipleArtificial += 1

  // --- Offline what-if: вярна реплика, различни (quart, quint) thresholds ---
  // Всеки сценарий стартира от ПРЕСЕН createSeededRandom(dealSeed) — идентичен
  // seed на реалния execution; резултатите могат да се разминат от baseline
  // само след първия candidate reject/accept, различен спрямо реалния праг.
  for (const scenario of whatIfScenarios) {
    const sim = simulateBottomRescue(natural, createSeededRandom(dealSeed), scenario.quartChance, scenario.quintChance)
    const outcome = classifySimOutcome(natural, sim)
    scenario[outcome] += 1

    if (scenario.quartChance === SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE && scenario.quintChance === SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE) {
      // Валидност на репликата: baseline сценарият трябва да произведе СЪЩИЯ
      // resulting deck като реалната production функция за този seed.
      const sameDeck = sim.deck.length === result.deck.length && sim.deck.every((card, index) => card.id === result.deck[index]?.id)
      if (!sameDeck) replicaMismatches += 1

      baselineQuartCandidatesAllowed += sim.quartCandidatesAllowed
      baselineQuartCandidatesRejected += sim.quartCandidatesRejected
      baselineQuintCandidatesAllowed += sim.quintCandidatesAllowed
      baselineQuintCandidatesRejected += sim.quintCandidatesRejected
      baselineSquareCandidatesRejected += sim.squareCandidatesRejected
    }
  }
}

// ---------------------------------------------------------------------------
// Отчет
// ---------------------------------------------------------------------------
const pct = (count: number, total: number) => (total === 0 ? 'n/a' : `${((count / total) * 100).toFixed(2)}%`)

console.log(`\n=== Anti Bad Luck declaration diagnostic (n=${SAMPLE_SIZE} deals) ===\n`)
console.log(`Rescue executions attempted (bottom pending & natural BAD): ${totalExecutions}`)
console.log(`Rescue-и успешно приложени: ${appliedCount} (${pct(appliedCount, totalExecutions)})`)
console.log(`Sanity: replica(baseline 25%/10%) mismatch срещу реалния production deck: ${replicaMismatches} (очаквано 0)`)
console.log(`Sanity: natural sequence "destroyed" в реален applied резултат: ${destroyedSanityViolations} (очаквано 0)`)

console.log('\n--- По rescue type ---')
for (const type of Object.keys(typeCounts) as ServerAntiBadLuckRescueType[]) {
  console.log(`  ${type}: ${typeCounts[type]} (${pct(typeCounts[type], totalExecutions)})`)
}

console.log('\n--- Изпълнения без нов анонс / с точно 1 / с 2+ (реален production резултат) ---')
console.log(`  без нов анонс:               ${executionsNoNewDeclaration} (${pct(executionsNoNewDeclaration, totalExecutions)})`)
console.log(`  с artificial QUART:          ${executionsWithArtificialQuart} (${pct(executionsWithArtificialQuart, totalExecutions)})`)
console.log(`  с artificial QUINT_PLUS:     ${executionsWithArtificialQuintPlus} (${pct(executionsWithArtificialQuintPlus, totalExecutions)})`)
console.log(`  с artificial four-of-kind:   ${executionsWithArtificialSquare} (${pct(executionsWithArtificialSquare, totalExecutions)})`)
console.log(`  с 2+ artificial анонса общо: ${executionsWithMultipleArtificial} (${pct(executionsWithMultipleArtificial, totalExecutions)})`)

console.log('\n--- Sequences: natural vs artificial (брой seat-occurrences, реален резултат) ---')
console.log(`  natural QUART:      ${naturalQuartTotal}`)
console.log(`  artificial QUART:   ${artificialQuartTotal}  [rescued ${artificialQuartByRelation.rescued}, partner ${artificialQuartByRelation.partner}, opponent ${artificialQuartByRelation.opponent}]`)
console.log(`  natural QUINT_PLUS: ${naturalQuintTotal}`)
console.log(`  artificial QUINT_PLUS: ${artificialQuintTotal}  [rescued ${artificialQuintByRelation.rescued}, partner ${artificialQuintByRelation.partner}, opponent ${artificialQuintByRelation.opponent}]`)

console.log('\n--- Four-of-kind (каре) breakdown по rank (само рангове, реално разпознати от declaration engine-а; реален резултат) ---')
const allRanksSeen = new Set<ServerRank>([...naturalSquareByRank.keys(), ...artificialSquareByRank.keys()])
for (const rank of allRanksSeen) {
  const natural = naturalSquareByRank.get(rank) ?? 0
  const artificial = artificialSquareByRank.get(rank) ?? 0
  const rescued = artificialSquareRescuedByRank.get(rank) ?? 0
  const other = artificialSquareOtherByRank.get(rank) ?? 0
  console.log(`  4x${rank}: natural ${natural}, artificial ${artificial} [rescued seat ${rescued}, non-rescued seat ${other}]`)
}

console.log('\n--- Guard candidate telemetry (baseline 25%/10%, реплика): колко "candidate би създал 1 нова поредица" е отхвърлен/допуснат ---')
console.log(`  quart candidates: allowed ${baselineQuartCandidatesAllowed}, rejected ${baselineQuartCandidatesRejected} (${pct(baselineQuartCandidatesAllowed, baselineQuartCandidatesAllowed + baselineQuartCandidatesRejected)} allowed)`)
console.log(`  quint candidates: allowed ${baselineQuintCandidatesAllowed}, rejected ${baselineQuintCandidatesRejected} (${pct(baselineQuintCandidatesAllowed, baselineQuintCandidatesAllowed + baselineQuintCandidatesRejected)} allowed)`)
console.log(`  square candidates: rejected ${baselineSquareCandidatesRejected} (0% allowed — square guard-ът няма процентен allowance, ВСЯКО artificial каре се reject-ва безусловно)`)

console.log('\n--- Offline what-if (вярна reтrу/fallback реплика, параметризиран threshold; НЕ променя runtime константи) ---')
for (const scenario of whatIfScenarios) {
  const total = scenario.clean + scenario.quart + scenario.quint + scenario.pending
  console.log(`  ${scenario.label}:`)
  console.log(`    clean ${scenario.clean} (${pct(scenario.clean, total)}), quart ${scenario.quart} (${pct(scenario.quart, total)}), quint ${scenario.quint} (${pct(scenario.quint, total)}), pending ${scenario.pending} (${pct(scenario.pending, total)})`)
}

console.log('\n(Диагностика приключи — production логика и константи НЕ са променени.)')
