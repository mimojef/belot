/**
 * simulateAiCardCandidate.ts
 *
 * Локален safety harness за card-model-v1 — доказва, че inference
 * wrapper-ът (rankLegalCardsWithCardModel) може безопасно да се използва
 * като bot-card decision candidate в game-like offline симулация, ПРЕДИ
 * каквато и да е реална beta/runtime интеграция.
 *
 * Няма runtime ефект: не пипа gameplay, matchmaking, economy, client
 * protocol, recorder writer или production bot behavior. Не включва AI
 * bot-а в никакъв реален game loop — само offline replay на вече записани
 * decision samples.
 *
 * За разлика от testCardModelInference.ts (доказва, че saved model +
 * wrapper възпроизвеждат trainer evaluation-a точно), този script е
 * фокусиран върху SAFETY: невалидни карти, fallback поведение, exceptions,
 * ranking integrity, и determinism под повторение — нещата, които трябва
 * да са верни преди какъвто и да е бъдещ beta wrapper.
 *
 * Usage:
 *   npm run simulate:ai-card-candidate   (от server/)
 *
 * Exit codes:
 *   0 — симулацията е safe (0 invalid final cards, 0 privacy нарушения,
 *       0 nondeterministic decisions под stress repeats)
 *   1 — invalid/missing input, privacy нарушение, invalid final selected
 *       card, nondeterministic behavior под repeats
 *   2 — file system грешка (липсващ model/split файл)
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'
import type { CardDecisionState, CompactCard, CompactPlayedCard } from './trainingInference/cardModelFeatures.js'
import {
  CardModelLoadError,
  loadCardModelFromFile,
  rankLegalCardsWithCardModel,
  type CardModel,
  type RankedCardPrediction,
} from './trainingInference/cardModelInference.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')
const MODEL_DIR = join(OUTPUT_DIR, 'models', 'card-model-v1')

const MODEL_JSON_PATH = join(MODEL_DIR, 'model.json')
const EVALUATION_SUMMARY_JSON_PATH = join(BASELINE_DIR, 'evaluation-summary.json')

const CARD_PATHS = {
  train: join(BASELINE_DIR, 'card-train.jsonl'),
  validation: join(BASELINE_DIR, 'card-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-test.jsonl'),
}

const SIMULATION_SUMMARY_JSON_PATH = join(MODEL_DIR, 'simulation-summary.json')
const SIMULATION_SUMMARY_MD_PATH = join(MODEL_DIR, 'simulation-summary.md')

// ─── Constants ────────────────────────────────────────────────────────────────

type EvalSplitName = 'validation' | 'test'
const EVAL_SPLIT_NAMES: EvalSplitName[] = ['validation', 'test']
const STRESS_REPEATS = 10

// ─── Shared shapes (pass-through — matches training-output/baseline/card-*.jsonl) ─

type FullCardRecord = CardDecisionState & {
  recordingId: string
  roomKey: string
  dealIndex: number
  sequence: number
  trickIndex: number
  positionInTrick: number
  playerKey: string | null
  chosenCard: CompactCard
  playedCardCountBeforeAction: number
  currentWinningCard: CompactCard | null
  dealerSeat: string
  leaderSeat: string
  scoreBeforeDeal: unknown
}

// ─── Strict JSONL parsing (само trailing newline позволен като "празен ред") ─

type ParsedLine<T> = { record: T; raw: string; lineNumber: number }

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
      const parsed = JSON.parse(trimmed) as T
      lines.push({ record: parsed, raw: trimmed, lineNumber: idx + 1 })
    } catch (e) {
      errors.push(`${fileLabel}:${idx + 1}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  return { lines, errors }
}

function isValidCompactCard(card: unknown): card is CompactCard {
  if (typeof card !== 'object' || card === null) return false
  const c = card as Record<string, unknown>
  return (
    typeof c.id === 'string' && c.id.length > 0 &&
    typeof c.suit === 'string' && c.suit.length > 0 &&
    typeof c.rank === 'string' && c.rank.length > 0
  )
}

function validateCardRecord(r: Partial<FullCardRecord>, label: string): string[] {
  const errors: string[] = []
  if (typeof r.recordingId !== 'string' || !r.recordingId) errors.push(`${label}: липсва recordingId`)
  if (typeof r.roomKey !== 'string' || !r.roomKey) errors.push(`${label}: липсва roomKey`)
  if (typeof r.sequence !== 'number') errors.push(`${label}: липсва sequence`)
  if (typeof r.seat !== 'string' || !r.seat) errors.push(`${label}: липсва seat`)
  if (typeof r.positionInTrick !== 'number') errors.push(`${label}: липсва positionInTrick`)
  if (!Array.isArray(r.currentTrick)) errors.push(`${label}: currentTrick липсва/невалиден`)
  if (!r.contract || typeof r.contract.contract !== 'string') errors.push(`${label}: contract липсва/невалиден`)

  if (!Array.isArray(r.ownHand) || r.ownHand.length === 0) {
    errors.push(`${label}: ownHand липсва/празно`)
  } else if (!r.ownHand.every(isValidCompactCard)) {
    errors.push(`${label}: ownHand съдържа невалидна card representation`)
  }
  if (!Array.isArray(r.legalCards) || r.legalCards.length === 0) {
    errors.push(`${label}: legalCards липсва/празно — критична input грешка`)
  } else if (!r.legalCards.every(isValidCompactCard)) {
    errors.push(`${label}: legalCards съдържа невалидна card representation`)
  }
  if (!r.chosenCard || !isValidCompactCard(r.chosenCard)) {
    errors.push(`${label}: chosenCard липсва/невалиден`)
  }
  if (Array.isArray(r.legalCards) && r.chosenCard && isValidCompactCard(r.chosenCard)) {
    const legalIds = new Set(r.legalCards.filter(isValidCompactCard).map((c) => c.id))
    if (!legalIds.has(r.chosenCard.id)) errors.push(`${label}: chosenCard "${r.chosenCard.id}" не е в legalCards`)
  }
  if (Array.isArray(r.ownHand) && r.chosenCard && isValidCompactCard(r.chosenCard)) {
    const handIds = new Set(r.ownHand.filter(isValidCompactCard).map((c) => c.id))
    if (!handIds.has(r.chosenCard.id)) errors.push(`${label}: chosenCard "${r.chosenCard.id}" не е в ownHand`)
  }

  return errors
}

function toDecisionState(record: FullCardRecord): CardDecisionState {
  return {
    seat: record.seat,
    ownHand: record.ownHand,
    legalCards: record.legalCards,
    contract: record.contract,
    currentTrick: record.currentTrick as CompactPlayedCard[],
    currentWinningSeat: record.currentWinningSeat,
  }
}

// ─── Extra privacy markers (session/cookie/authorization — не са в builder-ския scanner) ─

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

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function groupBy<T>(records: T[], keyFn: (r: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {}
  for (const r of records) {
    const key = keyFn(r)
    ;(groups[key] ??= []).push(r)
  }
  return groups
}

function legalCardsLengthBucket(len: number): '1' | '2' | '3' | '4' | '5+' {
  if (len <= 1) return '1'
  if (len === 2) return '2'
  if (len === 3) return '3'
  if (len === 4) return '4'
  return '5+'
}

// ─── Single decision-flow step (game-like: legalCards → rank → select → validate) ─

type DecisionOutcome = {
  selectedCard: string
  correct: boolean
  aiTopPickInvalid: boolean
  finalSelectedInvalid: boolean
  finalSelectedNotInOwnHand: boolean
  fallbackUsed: boolean
  fallbackReason: string | null
  rankingLength: number
  hasDuplicateRankingIds: boolean
  hasMissingScoreOrProbability: boolean
  threwException: boolean
  exceptionMessage: string | null
}

function simulateOneDecision(model: CardModel, record: FullCardRecord): DecisionOutcome {
  const legalIds = new Set(record.legalCards.map((c) => c.id))
  const handIds = new Set(record.ownHand.map((c) => c.id))

  if (record.legalCards.length === 0) {
    // Критична input грешка — не би трябвало да мине покрай validateCardRecord,
    // но harness-ът никога не трябва да crash-не мълчаливо върху нея.
    throw new Error(`simulateOneDecision: legalCards е празен за recordingId=${record.recordingId} sequence=${record.sequence}`)
  }

  let prediction: RankedCardPrediction | null = null
  let threwException = false
  let exceptionMessage: string | null = null

  try {
    prediction = rankLegalCardsWithCardModel(model, toDecisionState(record))
  } catch (e) {
    threwException = true
    exceptionMessage = e instanceof Error ? e.message : String(e)
  }

  // Ако wrapper-ът хвърли (не би трябвало за non-empty legalCards) — harness-ът
  // прилага собствен safe fallback, вместо да пропагира грешката нагоре.
  const safeFallbackCard = record.legalCards[0]!.id
  const finalSelectedCard = prediction ? prediction.selectedCard : safeFallbackCard
  const fallbackUsed = threwException || (prediction?.fallbackUsed ?? true)
  const fallbackReason = threwException
    ? `harness-level exception: ${exceptionMessage}`
    : (prediction?.fallbackReason ?? (prediction ? null : 'wrapper не върна prediction'))

  const aiTopPickId = prediction?.ranking[0]?.id ?? null
  const aiTopPickInvalid = aiTopPickId !== null && !legalIds.has(aiTopPickId)
  const finalSelectedInvalid = !legalIds.has(finalSelectedCard)
  const finalSelectedNotInOwnHand = !handIds.has(finalSelectedCard)

  const ranking = prediction?.ranking ?? []
  const rankingIds = ranking.map((r) => r.id)
  const hasDuplicateRankingIds = new Set(rankingIds).size !== rankingIds.length
  const hasMissingScoreOrProbability = ranking.some((r) => !Number.isFinite(r.score) || !Number.isFinite(r.probability))

  return {
    selectedCard: finalSelectedCard,
    correct: finalSelectedCard === record.chosenCard.id,
    aiTopPickInvalid,
    finalSelectedInvalid,
    finalSelectedNotInOwnHand,
    fallbackUsed,
    fallbackReason,
    rankingLength: ranking.length,
    hasDuplicateRankingIds,
    hasMissingScoreOrProbability,
    threwException,
    exceptionMessage,
  }
}

// ─── Aggregate metrics ────────────────────────────────────────────────────────

type GroupAccuracy = { total: number; correct: number; accuracy: number }

type SplitSafetyMetrics = {
  totalDecisions: number
  forcedCount: number
  nonForcedCount: number
  invalidAiTopPickCount: number
  invalidFinalSelectedCount: number
  finalSelectedNotInOwnHandCount: number
  fallbackCount: number
  fallbackRate: number
  fallbackReasonCounts: Record<string, number>
  exceptionCount: number
  rankingLengthMin: number
  rankingLengthMax: number
  rankingLengthAvg: number
  duplicateRankingIdCount: number
  missingScoreOrProbabilityCount: number
}

type SplitQualityMetrics = {
  overall: GroupAccuracy
  forced: GroupAccuracy
  nonForced: GroupAccuracy
  byGameMode: Record<string, GroupAccuracy>
  byLegalCardsLengthBucket: Record<string, GroupAccuracy>
  byLeadFollow: { lead: GroupAccuracy; follow: GroupAccuracy }
  selectedSuitCounts: Record<string, number>
  selectedRankCounts: Record<string, number>
}

function emptyGroupAccuracy(): GroupAccuracy {
  return { total: 0, correct: 0, accuracy: 0 }
}
function bumpGroup(g: GroupAccuracy, correct: boolean): void {
  g.total++
  if (correct) g.correct++
  g.accuracy = g.total > 0 ? g.correct / g.total : 0
}

function simulateSplit(model: CardModel, records: FullCardRecord[]): { safety: SplitSafetyMetrics; quality: SplitQualityMetrics; outcomes: DecisionOutcome[] } {
  const outcomes: DecisionOutcome[] = []

  let forcedCount = 0
  let nonForcedCount = 0
  let invalidAiTopPickCount = 0
  let invalidFinalSelectedCount = 0
  let finalSelectedNotInOwnHandCount = 0
  let fallbackCount = 0
  const fallbackReasonCounts: Record<string, number> = {}
  let exceptionCount = 0
  let duplicateRankingIdCount = 0
  let missingScoreOrProbabilityCount = 0
  const rankingLengths: number[] = []

  const overall = emptyGroupAccuracy()
  const forced = emptyGroupAccuracy()
  const nonForced = emptyGroupAccuracy()
  const byGameMode: Record<string, GroupAccuracy> = {}
  const byBucket: Record<string, GroupAccuracy> = {}
  const lead = emptyGroupAccuracy()
  const follow = emptyGroupAccuracy()
  const selectedSuitCounts: Record<string, number> = {}
  const selectedRankCounts: Record<string, number> = {}

  for (const record of records) {
    const outcome = simulateOneDecision(model, record)
    outcomes.push(outcome)

    if (record.legalCards.length === 1) forcedCount++
    else nonForcedCount++
    if (outcome.aiTopPickInvalid) invalidAiTopPickCount++
    if (outcome.finalSelectedInvalid) invalidFinalSelectedCount++
    if (outcome.finalSelectedNotInOwnHand) finalSelectedNotInOwnHandCount++
    if (outcome.fallbackUsed) fallbackCount++
    if (outcome.fallbackReason) fallbackReasonCounts[outcome.fallbackReason] = (fallbackReasonCounts[outcome.fallbackReason] ?? 0) + 1
    if (outcome.threwException) exceptionCount++
    if (outcome.hasDuplicateRankingIds) duplicateRankingIdCount++
    if (outcome.hasMissingScoreOrProbability) missingScoreOrProbabilityCount++
    rankingLengths.push(outcome.rankingLength)

    bumpGroup(overall, outcome.correct)
    if (record.legalCards.length === 1) bumpGroup(forced, outcome.correct)
    else bumpGroup(nonForced, outcome.correct)

    const mode = record.contract.contract ?? 'unknown'
    byGameMode[mode] ??= emptyGroupAccuracy()
    bumpGroup(byGameMode[mode]!, outcome.correct)

    const bucket = legalCardsLengthBucket(record.legalCards.length)
    byBucket[bucket] ??= emptyGroupAccuracy()
    bumpGroup(byBucket[bucket]!, outcome.correct)

    if (record.positionInTrick === 0) bumpGroup(lead, outcome.correct)
    else bumpGroup(follow, outcome.correct)

    const selectedCardObj = record.legalCards.find((c) => c.id === outcome.selectedCard)
    if (selectedCardObj) {
      selectedSuitCounts[selectedCardObj.suit] = (selectedSuitCounts[selectedCardObj.suit] ?? 0) + 1
      selectedRankCounts[selectedCardObj.rank] = (selectedRankCounts[selectedCardObj.rank] ?? 0) + 1
    }
  }

  const total = records.length
  const safety: SplitSafetyMetrics = {
    totalDecisions: total,
    forcedCount,
    nonForcedCount,
    invalidAiTopPickCount,
    invalidFinalSelectedCount,
    finalSelectedNotInOwnHandCount,
    fallbackCount,
    fallbackRate: total > 0 ? fallbackCount / total : 0,
    fallbackReasonCounts,
    exceptionCount,
    rankingLengthMin: rankingLengths.length > 0 ? Math.min(...rankingLengths) : 0,
    rankingLengthMax: rankingLengths.length > 0 ? Math.max(...rankingLengths) : 0,
    rankingLengthAvg: rankingLengths.length > 0 ? rankingLengths.reduce((a, b) => a + b, 0) / rankingLengths.length : 0,
    duplicateRankingIdCount,
    missingScoreOrProbabilityCount,
  }

  const quality: SplitQualityMetrics = {
    overall,
    forced,
    nonForced,
    byGameMode,
    byLegalCardsLengthBucket: byBucket,
    byLeadFollow: { lead, follow },
    selectedSuitCounts,
    selectedRankCounts,
  }

  return { safety, quality, outcomes }
}

// ─── Stress mode: повтори inference N пъти и провери determinism ────────────

function runStressRepeats(model: CardModel, records: FullCardRecord[], repeats: number): {
  nondeterministicCount: number
  nondeterministicSamples: Array<{ recordingId: string; sequence: number; selections: string[] }>
} {
  const nondeterministicSamples: Array<{ recordingId: string; sequence: number; selections: string[] }> = []
  let nondeterministicCount = 0

  for (const record of records) {
    const selections: string[] = []
    for (let i = 0; i < repeats; i++) {
      const prediction = rankLegalCardsWithCardModel(model, toDecisionState(record))
      selections.push(prediction.selectedCard)
    }
    const allSame = selections.every((s) => s === selections[0])
    if (!allSame) {
      nondeterministicCount++
      if (nondeterministicSamples.length < 20) {
        nondeterministicSamples.push({ recordingId: record.recordingId, sequence: record.sequence, selections })
      }
    }
  }

  return { nondeterministicCount, nondeterministicSamples }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  AI Card Candidate Simulation Harness (локален, safety-focused)')
  console.log('─────────────────────────────────────────')

  // ─── Зареди model.json (fail-closed) ────────────────────────────────────────
  let model: CardModel
  try {
    model = await loadCardModelFromFile(MODEL_JSON_PATH)
  } catch (e) {
    if (e instanceof CardModelLoadError) {
      console.error(`FATAL: невалиден/липсващ model artifact: ${e.message}`)
      console.error('\nИзпълни първо: npm run train:card-model')
      process.exit(e.message.includes('Не мога да прочета') ? 2 : 1)
      return
    }
    throw e
  }
  console.log(`Зареден model: ${model.modelVersion}, features: [${model.featureNames.join(', ')}]`)

  // ─── Чети validation/test (+ по желание train само за статистика) ─────────
  const fileContents: Record<string, string> = {}
  const missing: string[] = []
  for (const split of [...EVAL_SPLIT_NAMES, 'train'] as const) {
    try {
      fileContents[split] = await readFile(CARD_PATHS[split], 'utf8')
    } catch {
      if (split !== 'train') missing.push(CARD_PATHS[split]) // train е опционален extra
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
  const parsed: Record<string, ReturnType<typeof parseJsonlStrict<Partial<FullCardRecord>>>> = {}
  for (const split of Object.keys(fileContents)) {
    parsed[split] = parseJsonlStrict<Partial<FullCardRecord>>(fileContents[split]!, `card-${split}.jsonl`)
  }

  const validationErrors: string[] = []
  for (const split of Object.keys(parsed)) {
    validationErrors.push(...parsed[split]!.errors)
    for (const { record, lineNumber } of parsed[split]!.lines) {
      validationErrors.push(...validateCardRecord(record, `card-${split}.jsonl:${lineNumber}`))
    }
  }
  if (validationErrors.length > 0) {
    console.error(`\n✗ Открити ${validationErrors.length} validation грешки — simulation СПРЯН.\n`)
    for (const err of validationErrors.slice(0, 200)) console.error(`  ${err}`)
    process.exit(1)
    return
  }

  // ─── Privacy scan на input ──────────────────────────────────────────────────
  console.log('Privacy/sanitization сканиране на input файловете...')
  const inputViolations: SanitizationViolation[] = []
  for (const split of Object.keys(fileContents)) inputViolations.push(...(await scanAllForbiddenContent(CARD_PATHS[split as keyof typeof CARD_PATHS])))
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — simulation СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const recordsBySplit: Record<string, FullCardRecord[]> = {}
  for (const split of Object.keys(parsed)) {
    recordsBySplit[split] = parsed[split]!.lines.map((l) => l.record as FullCardRecord)
  }

  // ─── Симулирай validation/test (evaluation splits) ─────────────────────────
  console.log('Изпълнявам game-like decision simulation върху validation/test...')
  const safetyBySplit: Record<EvalSplitName, SplitSafetyMetrics> = {} as any
  const qualityBySplit: Record<EvalSplitName, SplitQualityMetrics> = {} as any
  for (const split of EVAL_SPLIT_NAMES) {
    const { safety, quality } = simulateSplit(model, recordsBySplit[split]!)
    safetyBySplit[split] = safety
    qualityBySplit[split] = quality
  }

  // Train — само допълнителна статистика (НЕ се използва за evaluation/quality сравнение).
  let trainExtraStats: { totalDecisions: number; forcedCount: number; nonForcedCount: number } | null = null
  if (recordsBySplit.train) {
    const trainRecords = recordsBySplit.train
    trainExtraStats = {
      totalDecisions: trainRecords.length,
      forcedCount: trainRecords.filter((r) => r.legalCards.length === 1).length,
      nonForcedCount: trainRecords.filter((r) => r.legalCards.length >= 2).length,
    }
  }

  // ─── Stress mode: N повторения за determinism ──────────────────────────────
  console.log(`Stress mode: ${STRESS_REPEATS} повторения върху validation+test за determinism проверка...`)
  const stressRecords = [...recordsBySplit.validation!, ...recordsBySplit.test!]
  const stressResult = runStressRepeats(model, stressRecords, STRESS_REPEATS)

  // ─── Baseline comparison (evaluation-summary.json, ако е наличен) ──────────
  let evaluationSummary: any = null
  try {
    evaluationSummary = JSON.parse(await readFile(EVALUATION_SUMMARY_JSON_PATH, 'utf8'))
  } catch {
    evaluationSummary = null
  }
  const baselineComparison = evaluationSummary
    ? {
        source: 'training-output/baseline/evaluation-summary.json',
        validation: {
          randomLegalNonForced: evaluationSummary.cardMetrics?.perSplit?.validation?.breakdown?.randomLegalExpectedAccuracyNonForced ?? null,
          firstLegalNonForced: evaluationSummary.cardMetrics?.perSplit?.validation?.breakdown?.firstLegalAccuracyNonForced ?? null,
        },
        test: {
          randomLegalNonForced: evaluationSummary.cardMetrics?.perSplit?.test?.breakdown?.randomLegalExpectedAccuracyNonForced ?? null,
          firstLegalNonForced: evaluationSummary.cardMetrics?.perSplit?.test?.breakdown?.firstLegalAccuracyNonForced ?? null,
        },
      }
    : { source: null, note: 'evaluation-summary.json не е намерен — сравнението с baseline-ите е пропуснато.' }

  // ─── Cross-run determinism: сравни с предишен simulation-summary.json (ако съществува) ─
  let crossRunDeterminism: { previousRunFound: boolean; metricsMatch: boolean | null; differences: string[] } = {
    previousRunFound: false,
    metricsMatch: null,
    differences: [],
  }
  try {
    const previous = JSON.parse(await readFile(SIMULATION_SUMMARY_JSON_PATH, 'utf8'))
    const differences: string[] = []
    for (const split of EVAL_SPLIT_NAMES) {
      const prevSafety = previous.safetyMetrics?.[split]
      const prevQuality = previous.qualityMetrics?.[split]
      if (!prevSafety || !prevQuality) {
        differences.push(`предишен run няма metrics за ${split}`)
        continue
      }
      if (prevSafety.totalDecisions !== safetyBySplit[split].totalDecisions) differences.push(`${split}.totalDecisions: ${prevSafety.totalDecisions} → ${safetyBySplit[split].totalDecisions}`)
      if (prevSafety.invalidFinalSelectedCount !== safetyBySplit[split].invalidFinalSelectedCount) differences.push(`${split}.invalidFinalSelectedCount: ${prevSafety.invalidFinalSelectedCount} → ${safetyBySplit[split].invalidFinalSelectedCount}`)
      if (prevSafety.fallbackCount !== safetyBySplit[split].fallbackCount) differences.push(`${split}.fallbackCount: ${prevSafety.fallbackCount} → ${safetyBySplit[split].fallbackCount}`)
      if (Math.abs((prevQuality.overall?.accuracy ?? -1) - qualityBySplit[split].overall.accuracy) > 1e-9) {
        differences.push(`${split}.overall.accuracy: ${prevQuality.overall?.accuracy} → ${qualityBySplit[split].overall.accuracy}`)
      }
      if (Math.abs((prevQuality.nonForced?.accuracy ?? -1) - qualityBySplit[split].nonForced.accuracy) > 1e-9) {
        differences.push(`${split}.nonForced.accuracy: ${prevQuality.nonForced?.accuracy} → ${qualityBySplit[split].nonForced.accuracy}`)
      }
    }
    crossRunDeterminism = { previousRunFound: true, metricsMatch: differences.length === 0, differences }
  } catch {
    crossRunDeterminism = { previousRunFound: false, metricsMatch: null, differences: [] }
  }

  // ─── Safety verdict ─────────────────────────────────────────────────────────
  const totalInvalidFinal = safetyBySplit.validation.invalidFinalSelectedCount + safetyBySplit.test.invalidFinalSelectedCount
  const totalInvalidAiTopPick = safetyBySplit.validation.invalidAiTopPickCount + safetyBySplit.test.invalidAiTopPickCount
  const totalNotInOwnHand = safetyBySplit.validation.finalSelectedNotInOwnHandCount + safetyBySplit.test.finalSelectedNotInOwnHandCount
  const totalExceptions = safetyBySplit.validation.exceptionCount + safetyBySplit.test.exceptionCount
  const isDeterministic = stressResult.nondeterministicCount === 0
  const isSafe = totalInvalidFinal === 0 && totalNotInOwnHand === 0 && isDeterministic && (crossRunDeterminism.metricsMatch !== false)

  // ─── Report обекти ──────────────────────────────────────────────────────────
  const generatedAt = new Date().toISOString()
  const nonForcedTestAccuracy = qualityBySplit.test.nonForced.accuracy
  const firstLegalTestBaseline = baselineComparison.test && 'firstLegalNonForced' in baselineComparison.test
    ? (baselineComparison as any).test.firstLegalNonForced
    : null
  const beatsFirstLegalBaseline = typeof firstLegalTestBaseline === 'number' ? nonForcedTestAccuracy > firstLegalTestBaseline : null

  const summaryJson = {
    generatedAt,
    modelVersion: model.modelVersion,
    inputFiles: {
      model: MODEL_JSON_PATH,
      cardValidation: CARD_PATHS.validation,
      cardTest: CARD_PATHS.test,
      cardTrain: recordsBySplit.train ? CARD_PATHS.train : null,
      evaluationSummaryJson: evaluationSummary ? EVALUATION_SUMMARY_JSON_PATH : null,
    },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    stressMode: {
      repeats: STRESS_REPEATS,
      totalSamplesTested: stressRecords.length,
      nondeterministicCount: stressResult.nondeterministicCount,
      nondeterministicSamples: stressResult.nondeterministicSamples,
      isDeterministic,
    },
    crossRunDeterminism,
    trainExtraStats,
    safetyMetrics: safetyBySplit,
    qualityMetrics: qualityBySplit,
    baselineComparison,
    beatsFirstLegalNonForcedTestBaseline: beatsFirstLegalBaseline,
    safetyVerdict: {
      isSafe,
      totalInvalidAiTopPick,
      totalInvalidFinalSelectedCards: totalInvalidFinal,
      totalFinalSelectedNotInOwnHand: totalNotInOwnHand,
      totalExceptions,
      isDeterministic,
    },
  }

  await writeFile(SIMULATION_SUMMARY_JSON_PATH, JSON.stringify(summaryJson, null, 2) + '\n', 'utf8')
  await writeFile(SIMULATION_SUMMARY_MD_PATH, renderMarkdown(summaryJson), 'utf8')

  // ─── Privacy re-scan на generated reports ──────────────────────────────────
  console.log('Privacy/sanitization сканиране на generated reports...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(SIMULATION_SUMMARY_JSON_PATH)),
    ...(await scanAllForbiddenContent(SIMULATION_SUMMARY_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated reports — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  // ─── Финален конзолен отчет ─────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Total decisions — validation: ${safetyBySplit.validation.totalDecisions}, test: ${safetyBySplit.test.totalDecisions}`)
  console.log(`  Validation — all: ${pct(qualityBySplit.validation.overall.accuracy)}, forced: ${pct(qualityBySplit.validation.forced.accuracy)}, non-forced: ${pct(qualityBySplit.validation.nonForced.accuracy)}`)
  console.log(`  Test       — all: ${pct(qualityBySplit.test.overall.accuracy)}, forced: ${pct(qualityBySplit.test.forced.accuracy)}, non-forced: ${pct(qualityBySplit.test.nonForced.accuracy)}`)
  console.log(`  Invalid AI top-pick — validation: ${safetyBySplit.validation.invalidAiTopPickCount}, test: ${safetyBySplit.test.invalidAiTopPickCount}`)
  console.log(`  Invalid FINAL selected — validation: ${safetyBySplit.validation.invalidFinalSelectedCount}, test: ${safetyBySplit.test.invalidFinalSelectedCount}`)
  console.log(`  Fallback rate — validation: ${pct(safetyBySplit.validation.fallbackRate)}, test: ${pct(safetyBySplit.test.fallbackRate)}`)
  console.log(`  Duplicate ranking ids — validation: ${safetyBySplit.validation.duplicateRankingIdCount}, test: ${safetyBySplit.test.duplicateRankingIdCount}`)
  console.log(`  Stress determinism (${STRESS_REPEATS}x, ${stressRecords.length} samples): ${isDeterministic ? 'PASS ✓' : `FAIL ✗ (${stressResult.nondeterministicCount} nondeterministic)`}`)
  console.log(`  Cross-run determinism: ${crossRunDeterminism.previousRunFound ? (crossRunDeterminism.metricsMatch ? 'СЪВПАДА ✓' : 'НЕ СЪВПАДА ✗') : 'няма предишен run за сравнение'}`)
  console.log(`  Privacy: PASS`)
  console.log(`  Safety verdict: ${isSafe ? 'SAFE ✓' : 'NOT SAFE ✗'}`)
  console.log(`\n✓ Отчет: ${SIMULATION_SUMMARY_MD_PATH}`)
  console.log(`✓ Отчет: ${SIMULATION_SUMMARY_JSON_PATH}`)

  if (!isSafe) {
    console.error('\n✗ Safety harness провал — виж отчета за детайли.')
    process.exit(1)
    return
  }

  console.log('✓ Simulation harness завършен успешно — AI card candidate е safe за следваща офлайн стъпка.\n')
  process.exit(0)
}

function renderMarkdown(s: any): string {
  const lines: string[] = []
  lines.push('# Card Model v1 — Simulation Harness')
  lines.push('')
  lines.push(`Генериран на: ${s.generatedAt}`)
  lines.push(`Модел: \`${s.modelVersion}\``)
  lines.push('')
  lines.push('Локален safety harness — доказва, че AI card inference wrapper-ът може безопасно да служи като bot-card decision candidate в game-like offline replay. НЕ е beta/runtime интеграция — моделът не е включен в никакъв реален game loop.')
  lines.push('')

  lines.push('## Safety verdict')
  lines.push('')
  lines.push(`**${s.safetyVerdict.isSafe ? '✅ SAFE за следваща офлайн стъпка' : '❌ NOT SAFE — не продължавай'}**`)
  lines.push('')
  lines.push(`- Invalid AI top-pick (преди fallback): ${s.safetyVerdict.totalInvalidAiTopPick}`)
  lines.push(`- Invalid FINAL selected cards (след fallback, трябва да е 0): **${s.safetyVerdict.totalInvalidFinalSelectedCards}**`)
  lines.push(`- Final selected извън ownHand: ${s.safetyVerdict.totalFinalSelectedNotInOwnHand}`)
  lines.push(`- Exceptions при inference: ${s.safetyVerdict.totalExceptions}`)
  lines.push(`- Deterministic под ${s.stressMode.repeats}x stress repeats: ${s.safetyVerdict.isDeterministic ? 'ДА ✓' : 'НЕ ✗'}`)
  lines.push('')

  lines.push('## Privacy validation')
  lines.push('')
  lines.push(`Статус: **${s.privacyValidation.status}** (${s.privacyValidation.violationCount} нарушения)`)
  lines.push('')

  lines.push('## Total decisions simulated')
  lines.push('')
  lines.push(`- Validation: ${s.safetyMetrics.validation.totalDecisions} (forced=${s.safetyMetrics.validation.forcedCount}, non-forced=${s.safetyMetrics.validation.nonForcedCount})`)
  lines.push(`- Test: ${s.safetyMetrics.test.totalDecisions} (forced=${s.safetyMetrics.test.forcedCount}, non-forced=${s.safetyMetrics.test.nonForcedCount})`)
  if (s.trainExtraStats) {
    lines.push(`- Train (само статистика, НЕ evaluation): ${s.trainExtraStats.totalDecisions} (forced=${s.trainExtraStats.forcedCount}, non-forced=${s.trainExtraStats.nonForcedCount})`)
  }
  lines.push('')

  lines.push('## Safety metrics по split')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    const sm = s.safetyMetrics[split]
    lines.push(`**${split}:**`)
    lines.push(`- Invalid AI top-pick: ${sm.invalidAiTopPickCount}`)
    lines.push(`- Invalid final selected: ${sm.invalidFinalSelectedCount}`)
    lines.push(`- Final selected извън ownHand: ${sm.finalSelectedNotInOwnHandCount}`)
    lines.push(`- Fallback: ${sm.fallbackCount} (${pct(sm.fallbackRate)})`)
    if (Object.keys(sm.fallbackReasonCounts).length > 0) {
      lines.push('  Fallback reasons:')
      for (const [reason, count] of Object.entries(sm.fallbackReasonCounts as Record<string, number>)) {
        lines.push(`    - ${reason}: ${count}`)
      }
    }
    lines.push(`- Exceptions: ${sm.exceptionCount}`)
    lines.push(`- Ranking length — min: ${sm.rankingLengthMin}, max: ${sm.rankingLengthMax}, avg: ${sm.rankingLengthAvg.toFixed(2)}`)
    lines.push(`- Duplicate ranking ids: ${sm.duplicateRankingIdCount}`)
    lines.push(`- Missing score/probability: ${sm.missingScoreOrProbabilityCount}`)
    lines.push('')
  }

  lines.push('## Quality metrics по split')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    const q = s.qualityMetrics[split]
    lines.push(`**${split}:**`)
    lines.push(`- All: ${q.overall.correct}/${q.overall.total} = ${pct(q.overall.accuracy)}`)
    lines.push(`- Forced: ${q.forced.correct}/${q.forced.total} = ${pct(q.forced.accuracy)}`)
    lines.push(`- Non-forced: ${q.nonForced.correct}/${q.nonForced.total} = ${pct(q.nonForced.accuracy)}`)
    lines.push('- По game mode:')
    for (const [mode, g] of Object.entries(q.byGameMode as Record<string, GroupAccuracy>)) {
      lines.push(`  - ${mode}: ${g.correct}/${g.total} = ${pct(g.accuracy)}`)
    }
    lines.push('- По legalCards.length bucket:')
    for (const bucket of ['1', '2', '3', '4', '5+']) {
      const g = (q.byLegalCardsLengthBucket as Record<string, GroupAccuracy>)[bucket]
      if (!g) continue
      lines.push(`  - ${bucket}: ${g.correct}/${g.total} = ${pct(g.accuracy)}`)
    }
    lines.push(`- Lead/follow: lead ${q.byLeadFollow.lead.correct}/${q.byLeadFollow.lead.total} = ${pct(q.byLeadFollow.lead.accuracy)}; follow ${q.byLeadFollow.follow.correct}/${q.byLeadFollow.follow.total} = ${pct(q.byLeadFollow.follow.accuracy)}`)
    lines.push('- Избрани suits: ' + Object.entries(q.selectedSuitCounts as Record<string, number>).map(([k, v]) => `${k}=${v}`).join(', '))
    lines.push('- Избрани ranks: ' + Object.entries(q.selectedRankCounts as Record<string, number>).map(([k, v]) => `${k}=${v}`).join(', '))
    lines.push('')
  }

  lines.push('## Baseline comparison')
  lines.push('')
  if (s.baselineComparison.source) {
    lines.push(`Източник: \`${s.baselineComparison.source}\``)
    for (const split of ['validation', 'test'] as const) {
      const b = s.baselineComparison[split]
      lines.push(`- **${split}** non-forced: model=${pct(s.qualityMetrics[split].nonForced.accuracy)}, random-legal=${typeof b.randomLegalNonForced === 'number' ? pct(b.randomLegalNonForced) : 'n/a'}, first-legal=${typeof b.firstLegalNonForced === 'number' ? pct(b.firstLegalNonForced) : 'n/a'}`)
    }
  } else {
    lines.push(`⚠ ${s.baselineComparison.note}`)
  }
  lines.push('')
  if (s.beatsFirstLegalNonForcedTestBaseline !== null) {
    lines.push(`Non-forced test accuracy спрямо first-legal baseline: **${s.beatsFirstLegalNonForcedTestBaseline ? 'БИЕ ✓' : 'НЕ бие ✗'}**`)
    lines.push('')
  }

  lines.push('## Stress mode (determinism под повторение)')
  lines.push('')
  lines.push(`- Повторения: ${s.stressMode.repeats}x върху ${s.stressMode.totalSamplesTested} sample-а (validation+test)`)
  lines.push(`- Nondeterministic decisions: ${s.stressMode.nondeterministicCount}`)
  lines.push(`- Статус: ${s.stressMode.isDeterministic ? 'DETERMINISTIC ✓ — нула nondeterministic решения при 10x повторение' : 'NONDETERMINISTIC ✗ — намерени решения с различен избор между повторенията'}`)
  if (s.stressMode.nondeterministicSamples.length > 0) {
    lines.push('')
    lines.push('Примери:')
    for (const ex of s.stressMode.nondeterministicSamples as Array<{ recordingId: string; sequence: number; selections: string[] }>) {
      lines.push(`- recordingId=${ex.recordingId} sequence=${ex.sequence}: ${ex.selections.join(', ')}`)
    }
  }
  lines.push('')

  lines.push('## Cross-run determinism')
  lines.push('')
  if (!s.crossRunDeterminism.previousRunFound) {
    lines.push('Няма предишен `simulation-summary.json` за сравнение (първи run).')
  } else {
    lines.push(`Статус: **${s.crossRunDeterminism.metricsMatch ? 'СЪВПАДА ✓' : 'НЕ СЪВПАДА ✗'}** спрямо предишния run (timestamp-и се игнорират, само metrics).`)
    if (s.crossRunDeterminism.differences.length > 0) {
      lines.push('')
      lines.push('Разлики:')
      for (const d of s.crossRunDeterminism.differences as string[]) lines.push(`- ${d}`)
    }
  }
  lines.push('')

  lines.push('## Препоръка')
  lines.push('')
  if (s.safetyVerdict.isSafe) {
    lines.push('- AI card candidate-ът демонстрира safe, deterministic поведение офлайн — 0 invalid final карти, 0 карти извън ownHand, стабилен между repeated runs.')
    lines.push('- Следваща логична стъпка (все още НЕ направена): local beta wrapper само за experimental/opt-in контекст, с ясен review на risk и rollback план — НЕ директна runtime bot интеграция.')
    lines.push('- Продължавай да оценяваш основно на non-forced accuracy, не на overall — forced decisions остават тривиални.')
  } else {
    lines.push('- НЕ продължавай към local beta wrapper — safety verdict е NOT SAFE. Виж safety metrics по-горе за конкретната причина (invalid final cards / nondeterminism / cross-run mismatch) и отстрани, преди следващ опит.')
  }
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
