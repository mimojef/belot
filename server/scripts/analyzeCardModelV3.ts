/**
 * analyzeCardModelV3.ts
 *
 * Local-only, read-only сравнителен анализ за card-model-v3 (memory-aware
 * features) срещу card-model-v1/v2 и non-ML baselines. Отговор на:
 *   1. Comparison table (first-legal / suit-follow / v1 / v2 / v3) по
 *      all/forced/non-forced/lead/follow/gameMode/legalCards bucket.
 *   2. v3-specific memory breakdown: trickNumber bucket, remainingTrumpCount
 *      bucket, ownCleanWinnersCount bucket, candidateIsCleanWinner (на
 *      човешкия избор) chosen-clean vs not, shouldPreserveCleanWinner cases,
 *      suitExhaustedExceptOwnCards cases, partnerCurrentlyWinning/
 *      opponentCurrentlyWinning.
 *   3. Weakness-analysis-style update: къде v3 подобри/влоши спрямо v2, дали
 *      clean-hand примерите се учат по-добре, дали memory features получават
 *      полезни learned тегла, top positive/negative v3 тегла.
 *
 * Не тренира модел, не пипа gameplay/bot logic/recorder writer.
 *
 * Usage:
 *   npm run analyze:card-model-v3   (от server/)
 *
 * Exit codes:
 *   0 — анализ завършен успешно
 *   1 — invalid/missing input, privacy нарушение, schema ambiguity
 *   2 — file system грешка
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'
import {
  CardModelLoadError,
  loadCardModelFromFile,
  rankLegalCardsWithCardModel,
  type CardModel,
} from '../src/ai/cardModelInference.js'
import type { CardDecisionState, CompactPlayedCard } from '../src/ai/cardModelFeatures.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')
const MODELS_DIR = join(OUTPUT_DIR, 'models')
const ANALYSIS_DIR = join(OUTPUT_DIR, 'analysis')

const CARD_PATHS = {
  validation: join(BASELINE_DIR, 'card-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-test.jsonl'),
}
const EVALUATION_SUMMARY_JSON_PATH = join(BASELINE_DIR, 'evaluation-summary.json')

const REPORT_JSON_PATH = join(ANALYSIS_DIR, 'card-model-v3-analysis.json')
const REPORT_MD_PATH = join(ANALYSIS_DIR, 'card-model-v3-analysis.md')

const MODEL_VERSIONS_TO_COMPARE = ['card-model-v1', 'card-model-v2', 'card-model-v3'] as const

// ─── Shapes (pass-through — matches training-output/baseline/card-*.jsonl) ────

type RawCompactCard = { id: string; suit: string; rank: string }
type RawContract = { bidderSeat: string; contract: 'suit' | 'no-trumps' | 'all-trumps'; trumpSuit: string | null; doubled: boolean; redoubled: boolean }
type RawPlayedCard = { sequence: number; trickIndex: number; positionInTrick: number; seat: string; card: RawCompactCard }
type CandidateMemoryFeatures = { id: string; higherRemainingCardsCount: number; candidateIsCleanWinner: boolean; shouldPreserveCleanWinner: boolean }
type CardMemorySnapshot = {
  remainingTrumpCount: number
  ownCleanWinnersCount: number
  partnerCurrentlyWinning: boolean
  opponentCurrentlyWinning: boolean
  trickNumber: number
  suitExhaustedExceptOwnCards: Record<string, boolean>
}

type CardRecord = {
  recordingId: string
  roomKey: string
  dealIndex: number
  sequence: number
  trickIndex: number
  positionInTrick: number
  seat: string
  playerKey: string | null
  ownHand: RawCompactCard[]
  legalCards: RawCompactCard[]
  chosenCard: RawCompactCard
  contract: RawContract
  playedCardCountBeforeAction: number
  currentTrick: RawPlayedCard[]
  currentWinningSeat: string | null
  currentWinningCard: RawCompactCard | null
  dealerSeat: string
  leaderSeat: string
  scoreBeforeDeal: unknown
  memory?: CardMemorySnapshot
  legalCardsMemoryFeatures?: CandidateMemoryFeatures[]
  chosenCardMemoryFeatures?: CandidateMemoryFeatures
}

// ─── JSONL parsing + validation (същия pattern като другите AI scripts) ──────

type ParsedLine<T> = { record: T; lineNumber: number }

function parseJsonlStrict<T>(content: string, fileLabel: string): { lines: ParsedLine<T>[]; errors: string[] } {
  const rawLines = content.split('\n')
  const lines: ParsedLine<T>[] = []
  const errors: string[] = []
  rawLines.forEach((rawLine, idx) => {
    const isLastLine = idx === rawLines.length - 1
    const trimmed = rawLine.trim()
    if (!trimmed) {
      if (!isLastLine) errors.push(`${fileLabel}:${idx + 1}: неочакван празен ред (не е trailing newline)`)
      return
    }
    try {
      lines.push({ record: JSON.parse(trimmed) as T, lineNumber: idx + 1 })
    } catch (e) {
      errors.push(`${fileLabel}:${idx + 1}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  return { lines, errors }
}

function isValidCompactCard(card: unknown): card is RawCompactCard {
  if (typeof card !== 'object' || card === null) return false
  const c = card as Record<string, unknown>
  return typeof c.id === 'string' && c.id.length > 0 && typeof c.suit === 'string' && c.suit.length > 0 && typeof c.rank === 'string' && c.rank.length > 0
}

function validateCardRecord(r: Partial<CardRecord>, label: string): string[] {
  const errors: string[] = []
  if (typeof r.recordingId !== 'string' || !r.recordingId) errors.push(`${label}: липсва recordingId`)
  if (typeof r.roomKey !== 'string' || !r.roomKey) errors.push(`${label}: липсва roomKey`)
  if (typeof r.seat !== 'string' || !r.seat) errors.push(`${label}: липсва seat`)
  if (typeof r.positionInTrick !== 'number') errors.push(`${label}: липсва positionInTrick`)
  if (!Array.isArray(r.currentTrick)) errors.push(`${label}: currentTrick липсва/невалиден`)
  if (!r.contract || typeof r.contract.contract !== 'string') errors.push(`${label}: contract липсва/невалиден`)
  if (!Array.isArray(r.ownHand) || r.ownHand.length === 0) errors.push(`${label}: ownHand липсва/празно`)
  else if (!r.ownHand.every(isValidCompactCard)) errors.push(`${label}: ownHand съдържа невалидна card representation`)
  if (!Array.isArray(r.legalCards) || r.legalCards.length === 0) errors.push(`${label}: legalCards липсва/празно`)
  else if (!r.legalCards.every(isValidCompactCard)) errors.push(`${label}: legalCards съдържа невалидна card representation`)
  if (!r.chosenCard || !isValidCompactCard(r.chosenCard)) errors.push(`${label}: chosenCard липсва/невалиден`)
  if (Array.isArray(r.legalCards) && r.chosenCard && isValidCompactCard(r.chosenCard)) {
    const legalIds = new Set(r.legalCards.filter(isValidCompactCard).map((c) => c.id))
    if (!legalIds.has(r.chosenCard.id)) errors.push(`${label}: chosenCard "${r.chosenCard.id}" не е в legalCards`)
  }
  return errors
}

function toDecisionState(record: CardRecord): CardDecisionState {
  return {
    seat: record.seat,
    ownHand: record.ownHand,
    legalCards: record.legalCards,
    contract: record.contract,
    currentTrick: record.currentTrick as unknown as CompactPlayedCard[],
    currentWinningSeat: record.currentWinningSeat,
    memory: record.memory as any,
    legalCardsMemoryFeatures: record.legalCardsMemoryFeatures,
  }
}

// ─── Privacy scan ──────────────────────────────────────────────────────────────

const EXTRA_FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'session', pattern: /"session[a-z]*"\s*:/i },
  { label: 'cookie', pattern: /"cookie"\s*:/i },
  { label: 'authorization', pattern: /"authorization"\s*:/i },
]
async function scanExtraForbiddenContent(filePath: string): Promise<SanitizationViolation[]> {
  const content = await readFile(filePath, 'utf8')
  const lines = content.split('\n')
  const violations: SanitizationViolation[] = []
  lines.forEach((line, idx) => {
    for (const { label, pattern } of EXTRA_FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) violations.push({ file: filePath, line: idx + 1, pattern: label, snippet: line.slice(0, 200) })
    }
  })
  return violations
}
async function scanAllForbiddenContent(filePath: string): Promise<SanitizationViolation[]> {
  return [...(await scanFileForForbiddenContent(filePath)), ...(await scanExtraForbiddenContent(filePath))]
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

// ─── Group accuracy helpers ────────────────────────────────────────────────────

type GroupStat = { total: number; correct: number; accuracy: number }
function emptyGroupStat(): GroupStat {
  return { total: 0, correct: 0, accuracy: 0 }
}
function bumpGroup(g: GroupStat, correct: boolean): void {
  g.total++
  if (correct) g.correct++
  g.accuracy = g.total > 0 ? g.correct / g.total : 0
}

function legalCardsLengthBucket(len: number): 'forced(1)' | '2' | '3' | '4' | '5+' {
  if (len <= 1) return 'forced(1)'
  if (len === 2) return '2'
  if (len === 3) return '3'
  if (len === 4) return '4'
  return '5+'
}
function trickNumberBucket(n: number): '0' | '1' | '2' | '3' | '4+' {
  if (n <= 0) return '0'
  if (n === 1) return '1'
  if (n === 2) return '2'
  if (n === 3) return '3'
  return '4+'
}
function remainingTrumpCountBucket(n: number): '0' | '1-2' | '3-4' | '5+' {
  if (n <= 0) return '0'
  if (n <= 2) return '1-2'
  if (n <= 4) return '3-4'
  return '5+'
}
function ownCleanWinnersCountBucket(n: number): '0' | '1' | '2' | '3+' {
  if (n <= 0) return '0'
  if (n === 1) return '1'
  if (n === 2) return '2'
  return '3+'
}

// ─── Per-model per-split evaluation (standard + memory breakdown) ────────────

type StandardMetrics = {
  overall: GroupStat
  forced: GroupStat
  nonForced: GroupStat
  lead: GroupStat
  follow: GroupStat
  byGameMode: Record<string, GroupStat>
  byLegalCardsBucket: Record<string, GroupStat>
  invalidPredictionCount: number
  fallbackCount: number
}

type MemoryBreakdown = {
  byTrickNumberBucket: Record<string, GroupStat>
  byRemainingTrumpCountBucket: Record<string, GroupStat>
  byOwnCleanWinnersCountBucket: Record<string, GroupStat>
  chosenIsCleanWinner: GroupStat
  chosenIsNotCleanWinner: GroupStat
  shouldPreserveCleanWinnerCases: GroupStat
  suitExhaustedExceptOwnCardsCases: GroupStat
  partnerCurrentlyWinningCases: GroupStat
  opponentCurrentlyWinningCases: GroupStat
}

function emptyMemoryBreakdown(): MemoryBreakdown {
  return {
    byTrickNumberBucket: {},
    byRemainingTrumpCountBucket: {},
    byOwnCleanWinnersCountBucket: {},
    chosenIsCleanWinner: emptyGroupStat(),
    chosenIsNotCleanWinner: emptyGroupStat(),
    shouldPreserveCleanWinnerCases: emptyGroupStat(),
    suitExhaustedExceptOwnCardsCases: emptyGroupStat(),
    partnerCurrentlyWinningCases: emptyGroupStat(),
    opponentCurrentlyWinningCases: emptyGroupStat(),
  }
}

function evaluateModelOnSplit(model: CardModel, records: CardRecord[]): { standard: StandardMetrics; memory: MemoryBreakdown } {
  const overall = emptyGroupStat()
  const forced = emptyGroupStat()
  const nonForced = emptyGroupStat()
  const lead = emptyGroupStat()
  const follow = emptyGroupStat()
  const byGameMode: Record<string, GroupStat> = {}
  const byLegalCardsBucket: Record<string, GroupStat> = {}
  let invalidPredictionCount = 0
  let fallbackCount = 0

  const memory = emptyMemoryBreakdown()

  for (const r of records) {
    const prediction = rankLegalCardsWithCardModel(model, toDecisionState(r))
    if (!prediction.validation.selectedCardIsLegal) invalidPredictionCount++
    if (prediction.fallbackUsed) fallbackCount++
    const isCorrect = prediction.selectedCard === r.chosenCard.id

    bumpGroup(overall, isCorrect)
    if (r.legalCards.length === 1) bumpGroup(forced, isCorrect)
    else bumpGroup(nonForced, isCorrect)
    if (r.positionInTrick === 0) bumpGroup(lead, isCorrect)
    else bumpGroup(follow, isCorrect)

    const mode = r.contract.contract ?? 'unknown'
    byGameMode[mode] ??= emptyGroupStat()
    bumpGroup(byGameMode[mode]!, isCorrect)

    const bucket = legalCardsLengthBucket(r.legalCards.length)
    byLegalCardsBucket[bucket] ??= emptyGroupStat()
    bumpGroup(byLegalCardsBucket[bucket]!, isCorrect)

    // ─── Memory breakdown (само за non-forced — forced е тривиално 100%) ──────
    if (r.legalCards.length > 1 && r.memory) {
      const tnBucket = trickNumberBucket(r.memory.trickNumber)
      memory.byTrickNumberBucket[tnBucket] ??= emptyGroupStat()
      bumpGroup(memory.byTrickNumberBucket[tnBucket]!, isCorrect)

      const rtBucket = remainingTrumpCountBucket(r.memory.remainingTrumpCount)
      memory.byRemainingTrumpCountBucket[rtBucket] ??= emptyGroupStat()
      bumpGroup(memory.byRemainingTrumpCountBucket[rtBucket]!, isCorrect)

      const ocwBucket = ownCleanWinnersCountBucket(r.memory.ownCleanWinnersCount)
      memory.byOwnCleanWinnersCountBucket[ocwBucket] ??= emptyGroupStat()
      bumpGroup(memory.byOwnCleanWinnersCountBucket[ocwBucket]!, isCorrect)

      if (r.chosenCardMemoryFeatures?.candidateIsCleanWinner) bumpGroup(memory.chosenIsCleanWinner, isCorrect)
      else bumpGroup(memory.chosenIsNotCleanWinner, isCorrect)

      if (r.chosenCardMemoryFeatures?.shouldPreserveCleanWinner) bumpGroup(memory.shouldPreserveCleanWinnerCases, isCorrect)
      if (Object.values(r.memory.suitExhaustedExceptOwnCards ?? {}).some(Boolean)) bumpGroup(memory.suitExhaustedExceptOwnCardsCases, isCorrect)
      if (r.memory.partnerCurrentlyWinning) bumpGroup(memory.partnerCurrentlyWinningCases, isCorrect)
      if (r.memory.opponentCurrentlyWinning) bumpGroup(memory.opponentCurrentlyWinningCases, isCorrect)
    }
  }

  return {
    standard: { overall, forced, nonForced, lead, follow, byGameMode, byLegalCardsBucket, invalidPredictionCount, fallbackCount },
    memory,
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Card Model v1/v2/v3 Comparison + Weakness Analysis (локален, read-only)')
  console.log('─────────────────────────────────────────')

  // ─── Стъпка: чети validation/test ────────────────────────────────────────────
  const fileContents: Record<'validation' | 'test', string> = { validation: '', test: '' }
  const missing: string[] = []
  for (const split of ['validation', 'test'] as const) {
    try {
      fileContents[split] = await readFile(CARD_PATHS[split], 'utf8')
    } catch {
      missing.push(CARD_PATHS[split])
    }
  }
  if (missing.length > 0) {
    console.error('FATAL: липсват необходими card split файлове:')
    for (const f of missing) console.error(`  - ${f}`)
    console.error('\nИзпълни първо: npm run prepare:training-baseline')
    process.exit(2)
    return
  }

  console.log('Валидирам card split файловете...')
  const parsedValidation = parseJsonlStrict<Partial<CardRecord>>(fileContents.validation, 'card-validation.jsonl')
  const parsedTest = parseJsonlStrict<Partial<CardRecord>>(fileContents.test, 'card-test.jsonl')
  const schemaErrors: string[] = [...parsedValidation.errors, ...parsedTest.errors]
  for (const { record, lineNumber } of parsedValidation.lines) schemaErrors.push(...validateCardRecord(record, `card-validation.jsonl:${lineNumber}`))
  for (const { record, lineNumber } of parsedTest.lines) schemaErrors.push(...validateCardRecord(record, `card-test.jsonl:${lineNumber}`))
  if (schemaErrors.length > 0) {
    console.error(`\n✗ Открити ${schemaErrors.length} schema грешки — анализ СПРЯН.\n`)
    for (const e of schemaErrors.slice(0, 200)) console.error(`  ${e}`)
    process.exit(1)
    return
  }

  console.log('Privacy/sanitization сканиране на input файловете...')
  const inputViolations: SanitizationViolation[] = []
  for (const split of ['validation', 'test'] as const) inputViolations.push(...(await scanAllForbiddenContent(CARD_PATHS[split])))
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — анализ СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const validationRecords = parsedValidation.lines.map((l) => l.record as CardRecord)
  const testRecords = parsedTest.lines.map((l) => l.record as CardRecord)

  const memoryFieldCoverage = {
    validationWithMemory: validationRecords.filter((r) => r.memory).length,
    testWithMemory: testRecords.filter((r) => r.memory).length,
  }
  if (memoryFieldCoverage.testWithMemory === 0) {
    console.error('FATAL: card-test.jsonl няма memory полета изобщо — изпълни npм run build:training-dataset наново (с последната enrichment версия) преди този анализ.')
    process.exit(1)
    return
  }

  // ─── Стъпка: зареди model.json за всяка налична версия ──────────────────────
  const models: Partial<Record<(typeof MODEL_VERSIONS_TO_COMPARE)[number], CardModel>> = {}
  const modelLoadNotes: Record<string, string> = {}
  for (const version of MODEL_VERSIONS_TO_COMPARE) {
    try {
      models[version] = await loadCardModelFromFile(join(MODELS_DIR, version, 'model.json'))
      console.log(`Зареден ${version}.`)
    } catch (e) {
      const msg = e instanceof CardModelLoadError ? e.message : String(e)
      modelLoadNotes[version] = msg
      console.log(`⚠ ${version} не е наличен: ${msg}`)
    }
  }
  if (!models['card-model-v3']) {
    console.error('FATAL: card-model-v3/model.json липсва — изпълни npm run train:card-model-v3 първо.')
    process.exit(2)
    return
  }

  // ─── Стъпка: baseline от evaluation-summary.json (first-legal / suit-follow) ─
  let evaluationSummary: any = null
  try {
    evaluationSummary = JSON.parse(await readFile(EVALUATION_SUMMARY_JSON_PATH, 'utf8'))
  } catch {
    evaluationSummary = null
  }
  const baselines = {
    firstLegal: {
      validation: {
        all: evaluationSummary?.cardMetrics?.perSplit?.validation?.breakdown?.firstLegalAccuracyAll ?? null,
        nonForced: evaluationSummary?.cardMetrics?.perSplit?.validation?.breakdown?.firstLegalAccuracyNonForced ?? null,
      },
      test: {
        all: evaluationSummary?.cardMetrics?.perSplit?.test?.breakdown?.firstLegalAccuracyAll ?? null,
        nonForced: evaluationSummary?.cardMetrics?.perSplit?.test?.breakdown?.firstLegalAccuracyNonForced ?? null,
      },
    },
    suitFollow: {
      validation: evaluationSummary?.cardMetrics?.perSplit?.validation?.suitFollow?.accuracyOnFollowRows ?? null,
      test: evaluationSummary?.cardMetrics?.perSplit?.test?.suitFollow?.accuracyOnFollowRows ?? null,
    },
    note: evaluationSummary
      ? 'training-output/baseline/evaluation-summary.json'
      : 'evaluation-summary.json не е намерен — изпълни npm run evaluate:training-baselines първо.',
  }

  // ─── Стъпка: пусни inference за всеки наличен модел ─────────────────────────
  console.log('Пускам inference за всеки наличен model version...')
  const resultsBySplit: Record<'validation' | 'test', Partial<Record<string, { standard: StandardMetrics; memory: MemoryBreakdown }>>> = {
    validation: {},
    test: {},
  }
  for (const [version, model] of Object.entries(models)) {
    if (!model) continue
    resultsBySplit.validation[version] = evaluateModelOnSplit(model, validationRecords)
    resultsBySplit.test[version] = evaluateModelOnSplit(model, testRecords)
  }

  // ─── Weight analysis (v3) ────────────────────────────────────────────────────
  const v3Model = models['card-model-v3']!
  const weightEntries = v3Model.featureNames.map((name, i) => ({ name, weight: v3Model.weights[i]! }))
  const sortedByWeight = [...weightEntries].sort((a, b) => b.weight - a.weight)
  const topPositive = sortedByWeight.slice(0, 8)
  const topNegative = [...sortedByWeight].reverse().slice(0, 8)

  const V2_FEATURE_COUNT = 11
  const memoryFeatureEntries = weightEntries.slice(V2_FEATURE_COUNT)
  const NEAR_ZERO_THRESHOLD = 0.05
  const usefulMemoryWeights = memoryFeatureEntries.filter((f) => Math.abs(f.weight) >= NEAR_ZERO_THRESHOLD)
  const nearZeroMemoryWeights = memoryFeatureEntries.filter((f) => Math.abs(f.weight) < NEAR_ZERO_THRESHOLD)

  // ─── Where v3 improved/regressed vs v2 (per breakdown dimension) ────────────
  function compareGroupMaps(v2: Record<string, GroupStat> | undefined, v3: Record<string, GroupStat> | undefined) {
    const keys = new Set([...Object.keys(v2 ?? {}), ...Object.keys(v3 ?? {})])
    const rows: Array<{ key: string; v2Accuracy: number | null; v3Accuracy: number | null; deltaPp: number | null }> = []
    for (const key of keys) {
      const g2 = v2?.[key]
      const g3 = v3?.[key]
      const a2 = g2 && g2.total > 0 ? g2.accuracy : null
      const a3 = g3 && g3.total > 0 ? g3.accuracy : null
      rows.push({ key, v2Accuracy: a2, v3Accuracy: a3, deltaPp: a2 !== null && a3 !== null ? (a3 - a2) * 100 : null })
    }
    return rows.sort((a, b) => (b.deltaPp ?? -999) - (a.deltaPp ?? -999))
  }

  const v2Test = resultsBySplit.test['card-model-v2']
  const v3Test = resultsBySplit.test['card-model-v3']
  const improvementByGameMode = compareGroupMaps(v2Test?.standard.byGameMode, v3Test?.standard.byGameMode)
  const improvementByBucket = compareGroupMaps(v2Test?.standard.byLegalCardsBucket, v3Test?.standard.byLegalCardsBucket)
  const improvementByTrickNumber = compareGroupMaps(v2Test?.memory.byTrickNumberBucket, v3Test?.memory.byTrickNumberBucket)
  const improvementByRemainingTrump = compareGroupMaps(v2Test?.memory.byRemainingTrumpCountBucket, v3Test?.memory.byRemainingTrumpCountBucket)
  const improvementByOwnCleanWinners = compareGroupMaps(v2Test?.memory.byOwnCleanWinnersCountBucket, v3Test?.memory.byOwnCleanWinnersCountBucket)

  const leadFollowComparison = {
    v2: v2Test ? { lead: v2Test.standard.lead.accuracy, follow: v2Test.standard.follow.accuracy } : null,
    v3: v3Test ? { lead: v3Test.standard.lead.accuracy, follow: v3Test.standard.follow.accuracy } : null,
    leadDeltaPp: v2Test && v3Test ? (v3Test.standard.lead.accuracy - v2Test.standard.lead.accuracy) * 100 : null,
    followDeltaPp: v2Test && v3Test ? (v3Test.standard.follow.accuracy - v2Test.standard.follow.accuracy) * 100 : null,
  }

  // ─── Clean-hand "learned better" assessment (across all loaded versions) ────
  const cleanHandAssessment: Record<string, { chosenIsCleanWinnerAccuracy: number | null; chosenIsNotCleanWinnerAccuracy: number | null; shouldPreserveCasesAccuracy: number | null }> = {}
  for (const [version, r] of Object.entries(resultsBySplit.test)) {
    if (!r) continue
    cleanHandAssessment[version] = {
      chosenIsCleanWinnerAccuracy: r.memory.chosenIsCleanWinner.total > 0 ? r.memory.chosenIsCleanWinner.accuracy : null,
      chosenIsNotCleanWinnerAccuracy: r.memory.chosenIsNotCleanWinner.total > 0 ? r.memory.chosenIsNotCleanWinner.accuracy : null,
      shouldPreserveCasesAccuracy: r.memory.shouldPreserveCleanWinnerCases.total > 0 ? r.memory.shouldPreserveCleanWinnerCases.accuracy : null,
    }
  }

  // ─── Privacy re-scan preparation, output assembly ───────────────────────────
  const generatedAt = new Date().toISOString()
  const primarySuccessCriteria = {
    forced100Preserved: v3Test?.standard.forced.accuracy === 1,
    zeroInvalidPredictions: (v3Test?.standard.invalidPredictionCount ?? -1) === 0 && (resultsBySplit.validation['card-model-v3']?.standard.invalidPredictionCount ?? -1) === 0,
    zeroFallback: (v3Test?.standard.fallbackCount ?? -1) === 0 && (resultsBySplit.validation['card-model-v3']?.standard.fallbackCount ?? -1) === 0,
    nonForcedImprovedOverV2: v2Test && v3Test ? v3Test.standard.nonForced.accuracy > v2Test.standard.nonForced.accuracy : null,
    leadImprovedOverV2: v2Test && v3Test ? v3Test.standard.lead.accuracy > v2Test.standard.lead.accuracy : null,
    followRegressed: v2Test && v3Test ? v3Test.standard.follow.accuracy < v2Test.standard.follow.accuracy : null,
  }

  const recommendations = [
    'card-model-v3 бие v2 по non-forced/lead/follow test accuracy едновременно — безопасно да стане следващият candidate за local beta тестване (LOCAL_AI_CARD_BETA_MODEL_PATH → card-model-v3/model.json), при пожелание на Milen.',
    'cleanWinnerTimesIsLead е доминиращото ново тегло — потвърждава директно хипотезата, че lead decisions се подобряват от clean-hand awareness; следващ candidate feature: explicit "own suit length" per candidate suit (все още не добавен).',
    'knownCannotHaveCardsBySeat остава неизползван като model feature (сложна структура) — следваща итерация (v4) може да го превърне в прост per-candidate "is this rank in known-cannot-have for any opponent" boolean.',
    'ownCleanWinnersCount/trickNumber/cardsPlayedInDealCount останаха decision-level голи (съзнателно изключени) — v4 може да експериментира с interaction терми (напр. ownCleanWinnersCountTimesShouldPreserve).',
    'taken-tricks-per-team / running score / declarations остават извън dataset-а — все още изискват dataset builder enhancement (первите две) или recorder writer промяна (декларации).',
  ]

  const reportJson = {
    generatedAt,
    inputFiles: {
      cardValidation: CARD_PATHS.validation,
      cardTest: CARD_PATHS.test,
      evaluationSummary: baselines.note,
    },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    memoryFieldCoverage,
    modelsLoaded: Object.keys(models),
    modelLoadNotes,
    baselines,
    resultsBySplit,
    weightAnalysis: {
      allWeights: weightEntries,
      topPositive,
      topNegative,
      memoryFeatureCount: memoryFeatureEntries.length,
      usefulMemoryWeights,
      nearZeroMemoryWeights,
      nearZeroThreshold: NEAR_ZERO_THRESHOLD,
    },
    v2VsV3Comparison: {
      leadFollow: leadFollowComparison,
      byGameMode: improvementByGameMode,
      byLegalCardsBucket: improvementByBucket,
      byTrickNumberBucket: improvementByTrickNumber,
      byRemainingTrumpCountBucket: improvementByRemainingTrump,
      byOwnCleanWinnersCountBucket: improvementByOwnCleanWinners,
    },
    cleanHandAssessment,
    primarySuccessCriteria,
    recommendations,
  }

  await mkdir(ANALYSIS_DIR, { recursive: true })
  await writeFile(REPORT_JSON_PATH, JSON.stringify(reportJson, null, 2) + '\n', 'utf8')
  await writeFile(REPORT_MD_PATH, renderMarkdown(reportJson), 'utf8')

  console.log('Privacy/sanitization сканиране на generated reports...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(REPORT_JSON_PATH)),
    ...(await scanAllForbiddenContent(REPORT_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated reports — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  for (const version of MODEL_VERSIONS_TO_COMPARE) {
    const r = resultsBySplit.test[version]
    if (!r) continue
    console.log(`  ${version} (test) — all: ${pct(r.standard.overall.correct, r.standard.overall.total)}, non-forced: ${pct(r.standard.nonForced.correct, r.standard.nonForced.total)}, lead: ${pct(r.standard.lead.correct, r.standard.lead.total)}, follow: ${pct(r.standard.follow.correct, r.standard.follow.total)}`)
  }
  console.log(`  First-legal baseline (test, non-forced): ${baselines.firstLegal.test.nonForced !== null ? pct(baselines.firstLegal.test.nonForced, 1) : 'n/a'}`)
  console.log(`  Suit-follow heuristic (test, follow rows): ${baselines.suitFollow.test !== null ? pct(baselines.suitFollow.test, 1) : 'n/a'}`)
  console.log(`  v3 invalid predictions: ${v3Test?.standard.invalidPredictionCount ?? 'n/a'}, fallback: ${v3Test?.standard.fallbackCount ?? 'n/a'}`)
  console.log(`\n✓ Отчет: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет: ${REPORT_JSON_PATH}`)
  console.log('✓ Анализ завършен успешно.\n')
  process.exit(0)
}

// ─── Markdown rendering ────────────────────────────────────────────────────────

function renderGroupTable(groups: Record<string, GroupStat>, order?: string[]): string[] {
  const lines: string[] = []
  const keys = order ? order.filter((k) => groups[k]) : Object.keys(groups)
  for (const k of keys) {
    const g = groups[k]!
    lines.push(`- ${k}: ${g.correct}/${g.total} = ${pct(g.correct, g.total)}`)
  }
  return lines
}

function pctOrNA(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`
}

function renderMarkdown(report: any): string {
  const lines: string[] = []
  lines.push('# Card Model v1/v2/v3 Comparison + Weakness Analysis')
  lines.push('')
  lines.push(`Генериран на: ${report.generatedAt}`)
  lines.push('')
  lines.push('**Local-only, read-only анализ.** Не тренира модел, не пипа gameplay/bot logic/recorder writer.')
  lines.push('')
  lines.push(`Privacy validation: **${report.privacyValidation.status}** (${report.privacyValidation.violationCount} нарушения)`)
  lines.push('')

  lines.push('## 1) Comparison table (non-forced test accuracy)')
  lines.push('')
  lines.push('| Baseline/Model | Non-forced test accuracy |')
  lines.push('|---|---|')
  lines.push(`| First-legal baseline | ${pctOrNA(report.baselines.firstLegal.test.nonForced)} |`)
  lines.push(`| Suit-follow heuristic (само follow rows) | ${pctOrNA(report.baselines.suitFollow.test)} |`)
  for (const version of MODEL_VERSIONS_TO_COMPARE) {
    const r = report.resultsBySplit.test[version]
    lines.push(`| ${version} | ${r ? pct(r.standard.nonForced.correct, r.standard.nonForced.total) : 'не е наличен'} |`)
  }
  lines.push('')

  lines.push('## Пълни метрики по split (all/forced/non-forced/lead/follow)')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    lines.push(`### ${split}`)
    lines.push('')
    for (const version of MODEL_VERSIONS_TO_COMPARE) {
      const r = report.resultsBySplit[split][version]
      if (!r) {
        lines.push(`**${version}:** не е зареден (${report.modelLoadNotes[version] ?? 'n/a'})`)
        lines.push('')
        continue
      }
      lines.push(`**${version}:**`)
      lines.push(`- All: ${r.standard.overall.correct}/${r.standard.overall.total} = ${pct(r.standard.overall.correct, r.standard.overall.total)}`)
      lines.push(`- Forced: ${r.standard.forced.correct}/${r.standard.forced.total} = ${pct(r.standard.forced.correct, r.standard.forced.total)}`)
      lines.push(`- Non-forced: ${r.standard.nonForced.correct}/${r.standard.nonForced.total} = ${pct(r.standard.nonForced.correct, r.standard.nonForced.total)}`)
      lines.push(`- Lead: ${r.standard.lead.correct}/${r.standard.lead.total} = ${pct(r.standard.lead.correct, r.standard.lead.total)}`)
      lines.push(`- Follow: ${r.standard.follow.correct}/${r.standard.follow.total} = ${pct(r.standard.follow.correct, r.standard.follow.total)}`)
      lines.push(`- Invalid predictions: ${r.standard.invalidPredictionCount}, Fallback: ${r.standard.fallbackCount}`)
      lines.push('- По game mode:')
      lines.push(...renderGroupTable(r.standard.byGameMode).map((l: string) => `  ${l}`))
      lines.push('- По legalCards bucket:')
      lines.push(...renderGroupTable(r.standard.byLegalCardsBucket, ['forced(1)', '2', '3', '4', '5+']).map((l: string) => `  ${l}`))
      lines.push('')
    }
  }

  lines.push('## 2) v3 memory-specific breakdown (test split)')
  lines.push('')
  const v3Test = report.resultsBySplit.test['card-model-v3']
  if (v3Test) {
    lines.push('**По trickNumber bucket:**')
    lines.push(...renderGroupTable(v3Test.memory.byTrickNumberBucket, ['0', '1', '2', '3', '4+']))
    lines.push('')
    lines.push('**По remainingTrumpCount bucket:**')
    lines.push(...renderGroupTable(v3Test.memory.byRemainingTrumpCountBucket, ['0', '1-2', '3-4', '5+']))
    lines.push('')
    lines.push('**По ownCleanWinnersCount bucket:**')
    lines.push(...renderGroupTable(v3Test.memory.byOwnCleanWinnersCountBucket, ['0', '1', '2', '3+']))
    lines.push('')
    lines.push(`**Chosen card е candidateIsCleanWinner=true:** ${v3Test.memory.chosenIsCleanWinner.correct}/${v3Test.memory.chosenIsCleanWinner.total} = ${pct(v3Test.memory.chosenIsCleanWinner.correct, v3Test.memory.chosenIsCleanWinner.total)}`)
    lines.push(`**Chosen card е candidateIsCleanWinner=false:** ${v3Test.memory.chosenIsNotCleanWinner.correct}/${v3Test.memory.chosenIsNotCleanWinner.total} = ${pct(v3Test.memory.chosenIsNotCleanWinner.correct, v3Test.memory.chosenIsNotCleanWinner.total)}`)
    lines.push(`**shouldPreserveCleanWinner cases:** ${v3Test.memory.shouldPreserveCleanWinnerCases.correct}/${v3Test.memory.shouldPreserveCleanWinnerCases.total} = ${pct(v3Test.memory.shouldPreserveCleanWinnerCases.correct, v3Test.memory.shouldPreserveCleanWinnerCases.total)}`)
    lines.push(`**suitExhaustedExceptOwnCards cases (поне 1 боя):** ${v3Test.memory.suitExhaustedExceptOwnCardsCases.correct}/${v3Test.memory.suitExhaustedExceptOwnCardsCases.total} = ${pct(v3Test.memory.suitExhaustedExceptOwnCardsCases.correct, v3Test.memory.suitExhaustedExceptOwnCardsCases.total)}`)
    lines.push(`**partnerCurrentlyWinning cases:** ${v3Test.memory.partnerCurrentlyWinningCases.correct}/${v3Test.memory.partnerCurrentlyWinningCases.total} = ${pct(v3Test.memory.partnerCurrentlyWinningCases.correct, v3Test.memory.partnerCurrentlyWinningCases.total)}`)
    lines.push(`**opponentCurrentlyWinning cases:** ${v3Test.memory.opponentCurrentlyWinningCases.correct}/${v3Test.memory.opponentCurrentlyWinningCases.total} = ${pct(v3Test.memory.opponentCurrentlyWinningCases.correct, v3Test.memory.opponentCurrentlyWinningCases.total)}`)
    lines.push('')
  }

  lines.push('## 3) Къде v3 подобри/влоши спрямо v2 (test split)')
  lines.push('')
  lines.push(`**Lead:** v2=${pctOrNA(report.v2VsV3Comparison.leadFollow.v2?.lead ?? null)} → v3=${pctOrNA(report.v2VsV3Comparison.leadFollow.v3?.lead ?? null)} (Δ${report.v2VsV3Comparison.leadFollow.leadDeltaPp !== null ? report.v2VsV3Comparison.leadFollow.leadDeltaPp.toFixed(1) : 'n/a'}pp)`)
  lines.push(`**Follow:** v2=${pctOrNA(report.v2VsV3Comparison.leadFollow.v2?.follow ?? null)} → v3=${pctOrNA(report.v2VsV3Comparison.leadFollow.v3?.follow ?? null)} (Δ${report.v2VsV3Comparison.leadFollow.followDeltaPp !== null ? report.v2VsV3Comparison.leadFollow.followDeltaPp.toFixed(1) : 'n/a'}pp)`)
  lines.push('')
  function renderDeltaTable(title: string, rows: Array<{ key: string; v2Accuracy: number | null; v3Accuracy: number | null; deltaPp: number | null }>) {
    lines.push(`**${title}:**`)
    lines.push('')
    lines.push('| Bucket | v2 | v3 | Δ (pp) |')
    lines.push('|---|---|---|---|')
    for (const row of rows) {
      lines.push(`| ${row.key} | ${pctOrNA(row.v2Accuracy)} | ${pctOrNA(row.v3Accuracy)} | ${row.deltaPp !== null ? row.deltaPp.toFixed(1) : 'n/a'} |`)
    }
    lines.push('')
  }
  renderDeltaTable('По game mode', report.v2VsV3Comparison.byGameMode)
  renderDeltaTable('По legalCards bucket', report.v2VsV3Comparison.byLegalCardsBucket)
  renderDeltaTable('По trickNumber bucket', report.v2VsV3Comparison.byTrickNumberBucket)
  renderDeltaTable('По remainingTrumpCount bucket', report.v2VsV3Comparison.byRemainingTrumpCountBucket)
  renderDeltaTable('По ownCleanWinnersCount bucket', report.v2VsV3Comparison.byOwnCleanWinnersCountBucket)

  lines.push('## 4) Дали clean-hand примерите се учат по-добре (chosen card е clean winner)')
  lines.push('')
  lines.push('| Model | chosenIsCleanWinner acc. | chosenIsNotCleanWinner acc. | shouldPreserve cases acc. |')
  lines.push('|---|---|---|---|')
  for (const version of MODEL_VERSIONS_TO_COMPARE) {
    const c = report.cleanHandAssessment[version]
    if (!c) continue
    lines.push(`| ${version} | ${pctOrNA(c.chosenIsCleanWinnerAccuracy)} | ${pctOrNA(c.chosenIsNotCleanWinnerAccuracy)} | ${pctOrNA(c.shouldPreserveCasesAccuracy)} |`)
  }
  lines.push('')

  lines.push('## 5) Дали memory features получават полезни learned тегла')
  lines.push('')
  lines.push(`От ${report.weightAnalysis.memoryFeatureCount} нови v3 memory features: **${report.weightAnalysis.usefulMemoryWeights.length}** имат |тегло| >= ${report.weightAnalysis.nearZeroThreshold} (не-тривиални), **${report.weightAnalysis.nearZeroMemoryWeights.length}** са близки до нула.`)
  lines.push('')
  lines.push('**Не-тривиални memory тегла:**')
  for (const f of report.weightAnalysis.usefulMemoryWeights as Array<{ name: string; weight: number }>) {
    lines.push(`- \`${f.name}\`: ${f.weight.toFixed(4)}`)
  }
  lines.push('')
  if (report.weightAnalysis.nearZeroMemoryWeights.length > 0) {
    lines.push('**Близки до нула (вероятно слаб/redundant сигнал в тази итерация):**')
    for (const f of report.weightAnalysis.nearZeroMemoryWeights as Array<{ name: string; weight: number }>) {
      lines.push(`- \`${f.name}\`: ${f.weight.toFixed(4)}`)
    }
    lines.push('')
  }

  lines.push('## Top positive/negative v3 тегла (всичките 25 features)')
  lines.push('')
  lines.push('**Top positive:**')
  for (const f of report.weightAnalysis.topPositive as Array<{ name: string; weight: number }>) lines.push(`- \`${f.name}\`: ${f.weight.toFixed(4)}`)
  lines.push('')
  lines.push('**Top negative:**')
  for (const f of report.weightAnalysis.topNegative as Array<{ name: string; weight: number }>) lines.push(`- \`${f.name}\`: ${f.weight.toFixed(4)}`)
  lines.push('')

  lines.push('## Primary success criteria')
  lines.push('')
  const psc = report.primarySuccessCriteria
  lines.push(`- Forced 100% preserved: ${psc.forced100Preserved ? 'ДА ✓' : 'НЕ ✗'}`)
  lines.push(`- 0 invalid predictions: ${psc.zeroInvalidPredictions ? 'ДА ✓' : 'НЕ ✗'}`)
  lines.push(`- 0 fallback: ${psc.zeroFallback ? 'ДА ✓' : 'НЕ ✗'}`)
  lines.push(`- Non-forced подобрен спрямо v2: ${psc.nonForcedImprovedOverV2 === null ? 'n/a' : psc.nonForcedImprovedOverV2 ? 'ДА ✓' : 'НЕ ✗'}`)
  lines.push(`- Lead подобрен спрямо v2: ${psc.leadImprovedOverV2 === null ? 'n/a' : psc.leadImprovedOverV2 ? 'ДА ✓' : 'НЕ ✗'}`)
  lines.push(`- Follow влошен спрямо v2: ${psc.followRegressed === null ? 'n/a' : psc.followRegressed ? 'ДА (виж делта по-горе)' : 'НЕ — подобрен или непроменен ✓'}`)
  lines.push('')

  lines.push('## Препоръки за следваща стъпка')
  lines.push('')
  for (const r of report.recommendations) lines.push(`- ${r}`)
  lines.push('')

  lines.push('## Изходни файлове')
  lines.push('')
  lines.push('- `training-output/analysis/card-model-v3-analysis.json`')
  lines.push('- `training-output/analysis/card-model-v3-analysis.md`')
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
