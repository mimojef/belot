/**
 * trainCardModel.ts
 *
 * Първи локален card-play model candidate — учи от вече подготвените
 * training-output/baseline/card-{train,validation,test}.jsonl split
 * файлове. Няма runtime ефект: не пипа gameplay, bot strategy, matchmaking,
 * economy, client protocol или recorder writer. Артефактите се пишат само
 * в training-output/models/ (gitignored).
 *
 * Model approach: linear-softmax ranker ("contextual multinomial logistic
 * regression за ranking"). За всяка legal карта в даден контекст се смятат
 * няколко прости, безопасни, реално-налични feature-а; тегловен вектор се
 * учи чрез пълен-batch gradient descent върху softmax cross-entropy loss
 * над кандидатите (chosen card = положителен клас сред legalCards). Няма
 * произволност (тегла старт от нула) → детерминистичен резултат при
 * еднакъв вход. Никакви native/тежки ML dependency-та — чист TypeScript.
 *
 * Usage:
 *   npm run train:card-model        (от server/) — тренира card-model-v1 (default, непроменено поведение)
 *   npm run train:card-model-v2     (от server/) — тренира card-model-v2 (richer features, виж cardModelFeatures.ts)
 *   tsx scripts/trainCardModel.ts card-model-v2   — директен CLI извикване с explicit версия
 *
 * Exit codes:
 *   0 — модел трениран + оценен успешно (дори ако не бие baseline-а —
 *       това само се отбелязва в metrics.md, не е фатално)
 *   1 — invalid/missing input, privacy нарушение, неизвестна model version
 *   2 — file system грешка
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'
import {
  CARD_MODEL_VERSIONS,
  computeCardModelFeaturesForVersion,
  dot,
  getCardModelFeatureNames,
  isSupportedCardModelVersion,
  type CardDecisionState,
  type CardModelVersion,
  type CompactCard,
} from '../src/ai/cardModelFeatures.js'

// ─── Version selection (CLI arg, default card-model-v1 — непроменено поведение) ─

const versionArg = process.argv.slice(2).find((a) => !a.startsWith('-'))
if (versionArg && !isSupportedCardModelVersion(versionArg)) {
  console.error(`FATAL: неизвестна model version "${versionArg}" — поддържани: ${CARD_MODEL_VERSIONS.join(', ')}`)
  process.exit(1)
}
const MODEL_VERSION: CardModelVersion = versionArg && isSupportedCardModelVersion(versionArg) ? versionArg : 'card-model-v1'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')
const MODEL_DIR = join(OUTPUT_DIR, 'models', MODEL_VERSION)

const CARD_PATHS = {
  train: join(BASELINE_DIR, 'card-train.jsonl'),
  validation: join(BASELINE_DIR, 'card-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-test.jsonl'),
}
const BASELINE_SUMMARY_JSON_PATH = join(BASELINE_DIR, 'baseline-summary.json')
const EVALUATION_SUMMARY_JSON_PATH = join(BASELINE_DIR, 'evaluation-summary.json')

const MODEL_JSON_PATH = join(MODEL_DIR, 'model.json')
const METRICS_JSON_PATH = join(MODEL_DIR, 'metrics.json')
const METRICS_MD_PATH = join(MODEL_DIR, 'metrics.md')

// ─── Constants ────────────────────────────────────────────────────────────────

type SplitName = 'train' | 'validation' | 'test'
const SPLIT_NAMES: SplitName[] = ['train', 'validation', 'test']

const EPOCHS = 60
const LEARNING_RATE = 0.5
const L2_REGULARIZATION = 0.001
const FIRST_LEGAL_NONFORCED_TEST_TARGET = 0.34 // от task brief / evaluation-summary.json

// Feature set-ът (имена + computation) е споделен с inference wrapper-а чрез
// src/ai/cardModelFeatures.ts — гарантира, че trainer и inference
// никога не могат да се разминат (виж модула за обяснение защо feature set-ът
// съдържа само per-candidate-varying стойности). Кой feature set се ползва
// (v1 или v2) се определя от MODEL_VERSION по-горе.
const FEATURE_NAMES = getCardModelFeatureNames(MODEL_VERSION)
const FEATURE_COUNT = FEATURE_NAMES.length

// ─── Shared shapes (pass-through — matches training-output/baseline/card-*.jsonl) ─

type CardRecord = CardDecisionState & {
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

function validateCardRecord(r: Partial<CardRecord>, label: string): string[] {
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
    errors.push(`${label}: legalCards липсва/празно`)
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

// ─── Training: full-batch gradient descent на softmax cross-entropy над legalCards ─
// (feature computation е в src/ai/cardModelFeatures.ts — споделено с inference wrapper-а)

function trainWeights(records: CardRecord[]): { weights: number[]; finalLoss: number; epochLosses: number[] } {
  const weights = new Array(FEATURE_COUNT).fill(0)
  const epochLosses: number[] = []

  // Пред-изчисляваме feature векторите веднъж (не се променят между epochs).
  const samples = records.map((r) => {
    const featureVectors = r.legalCards.map((c) => computeCardModelFeaturesForVersion(MODEL_VERSION, r, c))
    const trueIndex = r.legalCards.findIndex((c) => c.id === r.chosenCard.id)
    return { featureVectors, trueIndex }
  })

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const grad = new Array(FEATURE_COUNT).fill(0)
    let totalLoss = 0

    for (const { featureVectors, trueIndex } of samples) {
      if (trueIndex < 0 || featureVectors.length === 0) continue // не би трябвало (валидирано по-горе)

      const scores = featureVectors.map((x) => dot(weights, x))
      const maxScore = Math.max(...scores)
      const expScores = scores.map((s) => Math.exp(s - maxScore))
      const sumExp = expScores.reduce((a, b) => a + b, 0)
      const probs = expScores.map((e) => e / sumExp)

      totalLoss += -Math.log(Math.max(probs[trueIndex]!, 1e-12))

      for (let i = 0; i < featureVectors.length; i++) {
        const coeff = probs[i]! - (i === trueIndex ? 1 : 0)
        const x = featureVectors[i]!
        for (let f = 0; f < FEATURE_COUNT; f++) grad[f] += coeff * x[f]!
      }
    }

    const n = samples.length || 1
    for (let f = 0; f < FEATURE_COUNT; f++) {
      const g = grad[f]! / n + L2_REGULARIZATION * weights[f]!
      weights[f] -= LEARNING_RATE * g
    }
    epochLosses.push(totalLoss / n)
  }

  return { weights, finalLoss: epochLosses[epochLosses.length - 1] ?? 0, epochLosses }
}

// ─── Prediction (гарантирано валидна карта, с fallback tracking) ─────────────

type PredictionResult = { predictedId: string; usedFallback: boolean; ranking: Array<{ id: string; score: number }> }

function predictCard(weights: number[], record: CardRecord): PredictionResult {
  const legalCards = record.legalCards
  if (legalCards.length === 0) {
    // Не би трябвало да се случи (валидирано по-горе) — но никога не позволяваме crash.
    return { predictedId: '', usedFallback: true, ranking: [] }
  }

  const scored = legalCards.map((c) => {
    const x = computeCardModelFeaturesForVersion(MODEL_VERSION, record, c)
    const score = dot(weights, x)
    return { id: c.id, score }
  })

  const hasInvalidScore = scored.some((s) => !Number.isFinite(s.score))
  if (hasInvalidScore) {
    return { predictedId: legalCards[0]!.id, usedFallback: true, ranking: scored }
  }

  const ranking = [...scored].sort((a, b) => b.score - a.score)
  const legalIds = new Set(legalCards.map((c) => c.id))
  const topValid = ranking.find((r) => legalIds.has(r.id))

  if (!topValid) {
    return { predictedId: legalCards[0]!.id, usedFallback: true, ranking }
  }

  return { predictedId: topValid.id, usedFallback: false, ranking }
}

// ─── Evaluation metrics (същата форма като evaluateTrainingBaselines.ts за сравнимост) ─

type SplitEvalMetrics = {
  total: number
  correct: number
  accuracy: number
  forcedTotal: number
  forcedCorrect: number
  forcedAccuracy: number
  nonForcedTotal: number
  nonForcedCorrect: number
  nonForcedAccuracy: number
  fallbackCount: number
  fallbackRate: number
  invalidPredictionCount: number
}

function evaluateSplit(weights: number[], records: CardRecord[]): SplitEvalMetrics {
  let correct = 0
  let forcedTotal = 0
  let forcedCorrect = 0
  let nonForcedTotal = 0
  let nonForcedCorrect = 0
  let fallbackCount = 0
  let invalidPredictionCount = 0

  for (const r of records) {
    const { predictedId, usedFallback } = predictCard(weights, r)
    const legalIds = new Set(r.legalCards.map((c) => c.id))
    if (!legalIds.has(predictedId)) invalidPredictionCount++
    if (usedFallback) fallbackCount++

    const isCorrect = predictedId === r.chosenCard.id
    if (isCorrect) correct++

    if (r.legalCards.length === 1) {
      forcedTotal++
      if (isCorrect) forcedCorrect++
    } else {
      nonForcedTotal++
      if (isCorrect) nonForcedCorrect++
    }
  }

  const total = records.length
  return {
    total,
    correct,
    accuracy: total > 0 ? correct / total : 0,
    forcedTotal,
    forcedCorrect,
    forcedAccuracy: forcedTotal > 0 ? forcedCorrect / forcedTotal : 0,
    nonForcedTotal,
    nonForcedCorrect,
    nonForcedAccuracy: nonForcedTotal > 0 ? nonForcedCorrect / nonForcedTotal : 0,
    fallbackCount,
    fallbackRate: total > 0 ? fallbackCount / total : 0,
    invalidPredictionCount,
  }
}

function evaluateGroup(weights: number[], records: CardRecord[]): { total: number; correct: number; accuracy: number } {
  let correct = 0
  for (const r of records) {
    const { predictedId } = predictCard(weights, r)
    if (predictedId === r.chosenCard.id) correct++
  }
  return { total: records.length, correct, accuracy: records.length > 0 ? correct / records.length : 0 }
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log(`  Card Model Trainer — ${MODEL_VERSION} (локален, dependency-light)`)
  console.log('─────────────────────────────────────────')

  // ─── Стъпка: чети input файловете ───────────────────────────────────────────
  const fileContents: Record<string, string> = {}
  const missing: string[] = []
  for (const split of SPLIT_NAMES) {
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

  // ─── Validate JSONL + schema ────────────────────────────────────────────────
  console.log('Валидирам card split файловете...')
  const parsed = {
    train: parseJsonlStrict<Partial<CardRecord>>(fileContents.train!, 'card-train.jsonl'),
    validation: parseJsonlStrict<Partial<CardRecord>>(fileContents.validation!, 'card-validation.jsonl'),
    test: parseJsonlStrict<Partial<CardRecord>>(fileContents.test!, 'card-test.jsonl'),
  }

  const validationErrors: string[] = []
  for (const split of SPLIT_NAMES) {
    validationErrors.push(...parsed[split].errors)
    for (const { record, lineNumber } of parsed[split].lines) {
      validationErrors.push(...validateCardRecord(record, `card-${split}.jsonl:${lineNumber}`))
    }
  }

  if (validationErrors.length > 0) {
    console.error(`\n✗ Открити ${validationErrors.length} validation грешки — training СПРЯН.\n`)
    for (const err of validationErrors.slice(0, 200)) console.error(`  ${err}`)
    if (validationErrors.length > 200) console.error(`  ... и още ${validationErrors.length - 200}`)
    process.exit(1)
    return
  }

  // ─── Privacy scan на input ──────────────────────────────────────────────────
  console.log('Privacy/sanitization сканиране на input файловете...')
  const inputViolations: SanitizationViolation[] = []
  for (const split of SPLIT_NAMES) inputViolations.push(...(await scanAllForbiddenContent(CARD_PATHS[split])))
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — training СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const records: Record<SplitName, CardRecord[]> = {
    train: parsed.train.lines.map((l) => l.record as CardRecord),
    validation: parsed.validation.lines.map((l) => l.record as CardRecord),
    test: parsed.test.lines.map((l) => l.record as CardRecord),
  }

  // ─── Optional context inputs (baseline-summary.json / evaluation-summary.json) ─
  let baselineSummary: Record<string, unknown> | null = null
  let evaluationSummary: any = null
  try {
    baselineSummary = JSON.parse(await readFile(BASELINE_SUMMARY_JSON_PATH, 'utf8'))
  } catch {
    baselineSummary = null
  }
  try {
    evaluationSummary = JSON.parse(await readFile(EVALUATION_SUMMARY_JSON_PATH, 'utf8'))
  } catch {
    evaluationSummary = null
  }

  // ─── Train ───────────────────────────────────────────────────────────────────
  const trainAll = records.train
  const trainNonForced = trainAll.filter((r) => r.legalCards.length >= 2)
  const trainForced = trainAll.filter((r) => r.legalCards.length === 1)

  console.log(`Трениране върху ${trainNonForced.length} non-forced train sample-а (от ${trainAll.length} общо, ${trainForced.length} forced изключени от gradient-а)...`)
  const { weights, finalLoss, epochLosses } = trainWeights(trainNonForced)
  console.log(`Финален train loss (cross-entropy): ${finalLoss.toFixed(4)}`)

  // ─── Evaluate ────────────────────────────────────────────────────────────────
  console.log('Оценявам validation/test...')
  const evalBySplit: Record<SplitName, SplitEvalMetrics> = {
    train: evaluateSplit(weights, trainAll),
    validation: evaluateSplit(weights, records.validation),
    test: evaluateSplit(weights, records.test),
  }

  const byGameMode: Record<'validation' | 'test', Record<string, { total: number; correct: number; accuracy: number }>> = {
    validation: {},
    test: {},
  }
  const byBucket: Record<'validation' | 'test', Record<string, { total: number; correct: number; accuracy: number }>> = {
    validation: {},
    test: {},
  }
  const byLeadFollow: Record<'validation' | 'test', { lead: { total: number; correct: number; accuracy: number }; follow: { total: number; correct: number; accuracy: number } }> = {
    validation: { lead: { total: 0, correct: 0, accuracy: 0 }, follow: { total: 0, correct: 0, accuracy: 0 } },
    test: { lead: { total: 0, correct: 0, accuracy: 0 }, follow: { total: 0, correct: 0, accuracy: 0 } },
  }

  for (const split of ['validation', 'test'] as const) {
    const recs = records[split]
    const byMode = groupBy(recs, (r) => r.contract.contract ?? 'unknown')
    for (const [mode, group] of Object.entries(byMode)) byGameMode[split][mode] = evaluateGroup(weights, group)

    const byLen = groupBy(recs, (r) => legalCardsLengthBucket(r.legalCards.length))
    for (const [bucket, group] of Object.entries(byLen)) byBucket[split][bucket] = evaluateGroup(weights, group)

    const leadRecs = recs.filter((r) => r.positionInTrick === 0)
    const followRecs = recs.filter((r) => r.positionInTrick !== 0)
    byLeadFollow[split].lead = evaluateGroup(weights, leadRecs)
    byLeadFollow[split].follow = evaluateGroup(weights, followRecs)
  }

  // ─── Baseline comparison (от evaluation-summary.json, ако е наличен) ───────
  const baselineComparison = evaluationSummary
    ? {
        source: 'training-output/baseline/evaluation-summary.json',
        validation: {
          randomLegalAll: evaluationSummary.cardMetrics?.perSplit?.validation?.breakdown?.randomLegalExpectedAccuracyAll ?? null,
          randomLegalNonForced: evaluationSummary.cardMetrics?.perSplit?.validation?.breakdown?.randomLegalExpectedAccuracyNonForced ?? null,
          firstLegalAll: evaluationSummary.cardMetrics?.perSplit?.validation?.breakdown?.firstLegalAccuracyAll ?? null,
          firstLegalNonForced: evaluationSummary.cardMetrics?.perSplit?.validation?.breakdown?.firstLegalAccuracyNonForced ?? null,
          majorityCardNonForced: evaluationSummary.cardMetrics?.perSplit?.validation?.majorityCard?.accuracyNonForced ?? null,
          suitFollowOnFollowRows: evaluationSummary.cardMetrics?.perSplit?.validation?.suitFollow?.accuracyOnFollowRows ?? null,
        },
        test: {
          randomLegalAll: evaluationSummary.cardMetrics?.perSplit?.test?.breakdown?.randomLegalExpectedAccuracyAll ?? null,
          randomLegalNonForced: evaluationSummary.cardMetrics?.perSplit?.test?.breakdown?.randomLegalExpectedAccuracyNonForced ?? null,
          firstLegalAll: evaluationSummary.cardMetrics?.perSplit?.test?.breakdown?.firstLegalAccuracyAll ?? null,
          firstLegalNonForced: evaluationSummary.cardMetrics?.perSplit?.test?.breakdown?.firstLegalAccuracyNonForced ?? null,
          majorityCardNonForced: evaluationSummary.cardMetrics?.perSplit?.test?.majorityCard?.accuracyNonForced ?? null,
          suitFollowOnFollowRows: evaluationSummary.cardMetrics?.perSplit?.test?.suitFollow?.accuracyOnFollowRows ?? null,
        },
      }
    : { source: null, note: 'evaluation-summary.json не е намерен — сравнението с baseline-ите е пропуснато. Изпълни npm run evaluate:training-baselines първо.' }

  const testFirstLegalNonForced = baselineComparison.test && 'firstLegalNonForced' in baselineComparison.test
    ? (baselineComparison as any).test.firstLegalNonForced
    : null
  const targetBaseline = typeof testFirstLegalNonForced === 'number' ? testFirstLegalNonForced : FIRST_LEGAL_NONFORCED_TEST_TARGET
  const beatsTargetBaseline = evalBySplit.test.nonForcedAccuracy > targetBaseline

  // ─── model.json artifact ────────────────────────────────────────────────────
  const trainDataHash = createHash('sha256').update(fileContents.train!).digest('hex')

  const DESCRIPTION_V1 =
    'Contextual multinomial logistic regression за card ranking: за всяка карта в legalCards се смята линеен score = w·features; ' +
    'ranking = сортиране по score. Теглата са учени чрез пълен-batch gradient descent върху softmax cross-entropy loss ' +
    '(chosen card = положителен клас сред legalCards кандидатите), само върху non-forced train sample-и (forced sample-ите ' +
    'имат само 1 legal card и не носят gradient сигнал). Нулева инициализация на теглата → напълно детерминистичен резултат ' +
    'при еднакъв вход (без random seed). Feature set-ът съдържа само per-candidate-varying стойности (+ interaction терми с ' +
    'context сигнали) — в softmax-over-candidates ranking loss всеки feature, константен за всички кандидати в едно решение, ' +
    'математически носи нулев градиент (доказано и потвърдено емпирично при по-ранна итерация с bias/isLeading/matchesLedSuit/ ' +
    'legalCardsCount — виж excludedFeaturesNote).'

  const DESCRIPTION_V2 =
    DESCRIPTION_V1 +
    ' card-model-v2 добавя 6 нови features към същия linear-softmax-ranker подход (не сменя архитектурата) — адресира ' +
    'находката от weakness-analysis.md, че lead decisions (≈35-37% accuracy) са драстично по-слаби от follow (≈76%), защото ' +
    'leadershipTimesTrump/Points са нула на lead. Новите features: canWinTrick (per-candidate, reuse на getServerTrickWinner), ' +
    'winningPointsInteraction (canWinTrick × pointsInTrickNormalized), leadCandidateStrengthWhenLeading (isLead-gated per-candidate ' +
    'rank power, reuse на getServerCardRankPower), ownTrumpCountTimesIsTrump и isOurTeamContractorTimesTrump/Points (decision-level ' +
    'контекст, използван САМО като interaction с per-candidate feature — виж cardModelFeatures.ts за методологичната бележка).'

  const EXCLUDED_FEATURES_NOTE_V1 =
    'Не се използва пълна изиграна история извън текущия trick (не е налична в схема-та — само currentTrick), ' +
    'нито информация за картите на другите играчи извън own hand (не е налична и не бива да е). Отделно: bias, isLeading, ' +
    'matchesLedSuit, суров trickLeadershipSignal и legalCardsCountNormalized бяха ИЗРИЧНО премахнати след проверка — всеки от ' +
    'тях е константен за всички кандидати в дадено решение (напр. matchesLedSuit е 100% константен в реалните train данни: ' +
    '0 от 14926 non-forced решения имат mixed led-suit match сред legalCards, защото follow-suit правилото вече е приложено ' +
    'преди legalCards да достигне модела), което математически гарантира нулев градиент в softmax-over-candidates loss — ' +
    'потвърдено в по-ранна итерация (тегла ≈1e-18 след 60 epochs). trickLeadershipSignal е запазен само като interaction term ' +
    '(leadershipTimesTrump, leadershipTimesPoints), където реално модулира per-candidate features.'

  const EXCLUDED_FEATURES_NOTE_V2 =
    EXCLUDED_FEATURES_NOTE_V1 +
    ' За v2: isLead и pointsInTrickNormalized СЪЗНАТЕЛНО НЕ са добавени като голи features (двете са decision-level константи — ' +
    'същия капан като по-горе) — влизат само през leadCandidateStrengthWhenLeading/winningPointsInteraction interaction термите. ' +
    'played cards извън текущия trick / tricks taken so far / declarations остават извън v2 — те изискват dataset builder ' +
    'enhancement (join върху recorder-ския TrainingDealRecord.tricks) или recorder writer промяна, извън обхвата на тази задача ' +
    '(виж weakness-analysis.md Priority 3/4).'

  // ─── "Clean hand" / played-cards / remaining-cards feature audit ───────────
  // Отговор на допълнително user уточнение: AI-ят трябва в бъдеще да помни
  // цялото раздаване (кои карти са излезли, кои остават, кои собствени карти
  // са "clean winners"/guaranteed да вземат взятка). Проверено едно по едно
  // срещу РЕАЛНАТА card decision sample schema (card-{train,validation,test}.jsonl) —
  // само currentTrick (текущия, недовършен trick) е наличен; playedCardCountBeforeAction
  // е САМО брояч, не card identities; completed tricks от по-рано в раздаването
  // изобщо не са част от per-action schema-та (макар да съществуват на deal-ниво
  // в recorder архива, TrainingDealRecord.tricks — недостъпни тук без dataset
  // builder join). Затова "clean winner" features (изискват да знаеш кои карти
  // от дадена боя вече са изиграни навсякъде по масата) НЕ могат да се изчислят
  // safely сега — не са измислени/апроксимирани, а изрично отбелязани blocking.
  const FUTURE_CLEAN_HAND_FEATURE_AUDIT = [
    {
      feature: 'playedCardsSoFar',
      status: 'blocked_needs_dataset_join',
      note: 'Изисква пълна история на изиграни карти извън текущия trick. Per-action schema-та има само currentTrick ' +
        '(текущия trick) + playedCardCountBeforeAction (брояч, не identities). Derivable БЕЗ recorder writer промяна чрез ' +
        'dataset builder join върху TrainingDealRecord.tricks (recorder-ът вече го записва на deal-ниво) — Priority 1 за ' +
        'следваща задача.',
    },
    {
      feature: 'remainingCardsBySuit',
      status: 'blocked_needs_dataset_join',
      note: 'Зависи от playedCardsSoFar (32 карти − ownHand − played = remaining). Blocking по същата причина.',
    },
    {
      feature: 'higherRemainingCardsCount',
      status: 'blocked_needs_dataset_join',
      note: 'Зависи от remainingCardsBySuit (колко от все още невидените карти в тази боя бият candidate картата). Blocking.',
    },
    {
      feature: 'isCleanWinner',
      status: 'blocked_needs_dataset_join',
      note: '"Гарантирано ще вземе взятка, ако се изиграе" — изисква higherRemainingCardsCount===0 за съответната боя. Blocking.',
    },
    {
      feature: 'ownCleanWinnersCount',
      status: 'blocked_needs_dataset_join',
      note: 'Брой clean-winner карти в own hand — зависи от isCleanWinner per card. Blocking.',
    },
    {
      feature: 'shouldPreserveCleanWinner',
      status: 'blocked_needs_dataset_join',
      note: 'Heuristic/interaction "не хаби clean winner без причина" — зависи от isCleanWinner + trick context. Blocking.',
    },
    {
      feature: 'suitExhaustedExceptOwnCards',
      status: 'blocked_needs_dataset_join',
      note: 'Дали дадена боя е напълно изчерпана навсякъде другаде освен в own hand — изисква пълна played-card история. Blocking.',
    },
    {
      feature: 'remainingTrumpCount',
      status: 'blocked_needs_dataset_join',
      note: 'Колко козове не са излезли — 8 (общо козове) − played trumps − own trump count. Изисква played-card история. Blocking.',
    },
    {
      feature: 'ownTrumpCount',
      status: 'implemented_in_v2',
      note: 'Derivable само от ownHand (без played history) — вече имплементирано като ownTrumpCountTimesIsTrump interaction term.',
    },
    {
      feature: 'currentTrickWinningTeam',
      status: 'already_equivalent',
      note: 'Информацията вече се улавя чрез trickLeadershipSignal (deriveTeam(currentWinningSeat) спрямо own team) — ' +
        'наследено от card-model-v1, не е ново.',
    },
    {
      feature: 'partnerCurrentlyWinning',
      status: 'already_equivalent',
      note: 'Математически идентично на trickLeadershipSignal===+1 — actor-ът никога не е играл в текущия trick преди ' +
        'собственото си решение, значи currentWinningSeat никога не е самия него; "own team печели" ⇔ "партньорът печели".',
    },
    {
      feature: 'opponentCurrentlyWinning',
      status: 'already_equivalent',
      note: 'Математически идентично на trickLeadershipSignal===-1, по същата логика.',
    },
    {
      feature: 'pointsInTrick',
      status: 'implemented_in_v2',
      note: 'Изчислено (pointsInTrickNormalized) и използвано вътре в winningPointsInteraction — не е гол feature (decision-level ' +
        'константа, същото anti-zero-gradient правило).',
    },
  ] as const

  const modelJson = {
    modelVersion: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    approach: 'linear-softmax-ranker',
    description: MODEL_VERSION === 'card-model-v2' ? DESCRIPTION_V2 : DESCRIPTION_V1,
    featureNames: FEATURE_NAMES,
    weights,
    hyperparameters: {
      epochs: EPOCHS,
      learningRate: LEARNING_RATE,
      l2Regularization: L2_REGULARIZATION,
    },
    trainingCounts: {
      trainTotal: trainAll.length,
      trainForced: trainForced.length,
      trainNonForced: trainNonForced.length,
    },
    fallbackStrategy: 'Ако ranking-ът не даде валидна карта (NaN/Infinite score или празен legalCards) → legalCards[0] (first-legal baseline).',
    trainingDataHash: `sha256:${trainDataHash}`,
    trainingDataFile: 'training-output/baseline/card-train.jsonl',
    excludedFeaturesNote: MODEL_VERSION === 'card-model-v2' ? EXCLUDED_FEATURES_NOTE_V2 : EXCLUDED_FEATURES_NOTE_V1,
    finalTrainLoss: finalLoss,
    ...(MODEL_VERSION === 'card-model-v2' ? { futureCleanHandFeatureAudit: FUTURE_CLEAN_HAND_FEATURE_AUDIT } : {}),
  }

  await rm(MODEL_DIR, { recursive: true, force: true })
  await mkdir(MODEL_DIR, { recursive: true })
  await writeFile(MODEL_JSON_PATH, JSON.stringify(modelJson, null, 2) + '\n', 'utf8')

  // ─── metrics.json / metrics.md ──────────────────────────────────────────────
  const generatedAt = new Date().toISOString()
  const metricsJson = {
    generatedAt,
    modelVersion: MODEL_VERSION,
    inputFiles: {
      cardTrain: CARD_PATHS.train,
      cardValidation: CARD_PATHS.validation,
      cardTest: CARD_PATHS.test,
      baselineSummaryJson: baselineSummary ? BASELINE_SUMMARY_JSON_PATH : null,
      evaluationSummaryJson: evaluationSummary ? EVALUATION_SUMMARY_JSON_PATH : null,
    },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    trainingCounts: modelJson.trainingCounts,
    epochLossCurve: epochLosses,
    metrics: evalBySplit,
    byGameMode,
    byLegalCardsLengthBucket: byBucket,
    byLeadFollow,
    baselineComparison,
    beatsFirstLegalNonForcedTestBaseline: beatsTargetBaseline,
    firstLegalNonForcedTestBaselineUsed: targetBaseline,
    ...(MODEL_VERSION === 'card-model-v2' ? { futureCleanHandFeatureAudit: FUTURE_CLEAN_HAND_FEATURE_AUDIT } : {}),
  }

  await writeFile(METRICS_JSON_PATH, JSON.stringify(metricsJson, null, 2) + '\n', 'utf8')
  await writeFile(METRICS_MD_PATH, renderMarkdown(metricsJson), 'utf8')

  // ─── Privacy re-scan на generated artifacts (defense in depth) ─────────────
  console.log('Privacy/sanitization сканиране на generated model artifacts...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(MODEL_JSON_PATH)),
    ...(await scanAllForbiddenContent(METRICS_JSON_PATH)),
    ...(await scanAllForbiddenContent(METRICS_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated model artifacts — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  // ─── Финален конзолен отчет ─────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Validation — all: ${pct(evalBySplit.validation.accuracy)}, forced: ${pct(evalBySplit.validation.forcedAccuracy)}, non-forced: ${pct(evalBySplit.validation.nonForcedAccuracy)}`)
  console.log(`  Test       — all: ${pct(evalBySplit.test.accuracy)}, forced: ${pct(evalBySplit.test.forcedAccuracy)}, non-forced: ${pct(evalBySplit.test.nonForcedAccuracy)}`)
  console.log(`  Fallback rate — validation: ${pct(evalBySplit.validation.fallbackRate)}, test: ${pct(evalBySplit.test.fallbackRate)}`)
  console.log(`  Invalid predictions — validation: ${evalBySplit.validation.invalidPredictionCount}, test: ${evalBySplit.test.invalidPredictionCount}`)
  console.log(`  Non-forced test vs first-legal baseline (${pct(targetBaseline)}): ${beatsTargetBaseline ? 'БИЕ ✓' : 'НЕ бие ✗'}`)
  console.log(`\n✓ Model artifact: ${MODEL_JSON_PATH}`)
  console.log(`✓ Отчет: ${METRICS_MD_PATH}`)
  console.log(`✓ Отчет: ${METRICS_JSON_PATH}`)
  console.log('✓ Training завършен успешно.\n')

  process.exit(0)
}

function renderMarkdown(m: any): string {
  const lines: string[] = []
  lines.push(`# ${m.modelVersion} — Training Metrics`)
  lines.push('')
  lines.push(`Генериран на: ${m.generatedAt}`)
  lines.push(`Модел: \`${m.modelVersion}\` — linear-softmax ranker (contextual multinomial logistic regression), чист TypeScript, без ML dependency-та.`)
  lines.push('')
  lines.push('Този модел е локален candidate за card-play политика. Не е свързан с runtime gameplay/bot логиката — само offline experiment върху вече подготвения dataset.')
  lines.push('')

  lines.push('## Privacy validation')
  lines.push('')
  lines.push(`Статус: **${m.privacyValidation.status}** (${m.privacyValidation.violationCount} нарушения)`)
  lines.push('')

  lines.push('## Training counts')
  lines.push('')
  lines.push(`- Train общо: ${m.trainingCounts.trainTotal} (forced=${m.trainingCounts.trainForced}, non-forced=${m.trainingCounts.trainNonForced})`)
  lines.push(`- Gradient-ът е учен само върху non-forced train sample-и — forced sample-ите (1 legal card) нямат informative сигнал.`)
  lines.push('')

  lines.push('## Features (използвани)')
  lines.push('')
  lines.push('| Feature | Описание |')
  lines.push('|---|---|')
  lines.push('| `isTrump` | картата е коз ли е (all-trumps → винаги 1, no-trumps → винаги 0, suit → suit===trumpSuit) |')
  lines.push('| `cardPointsNormalized` | точкова стойност на картата (getServerCardPoints), нормализирана /20 |')
  lines.push('| `suitVoidRisk` | дял карти от същия suit в own hand спрямо цялата ръка |')
  lines.push('| `leadershipTimesTrump` | (+1 партньор печели / -1 противник / 0 никой) × isTrump — контекстът модулира предпочитанието към коз |')
  lines.push('| `leadershipTimesPoints` | (+1 партньор печели / -1 противник / 0 никой) × cardPointsNormalized — контекстът модулира предпочитанието към високи карти |')
  if (m.modelVersion === 'card-model-v2') {
    lines.push('| `canWinTrick` | дали candidate картата би спечелила trick-а точно сега (reuse на getServerTrickWinner) — per-candidate, варира |')
    lines.push('| `winningPointsInteraction` | canWinTrick × pointsInTrickNormalized (точки вече заложени в trick-а) |')
    lines.push('| `leadCandidateStrengthWhenLeading` | isLead × (rank power / 7, reuse на getServerCardRankPower) — само ненулево при lead |')
    lines.push('| `ownTrumpCountTimesIsTrump` | (own trump count / hand size) × isTrump — "имам ли много/малко козове" |')
    lines.push('| `isOurTeamContractorTimesTrump` | isOurTeamContractor × isTrump — собственият отбор на обявилия срещу защитниците |')
    lines.push('| `isOurTeamContractorTimesPoints` | isOurTeamContractor × cardPointsNormalized |')
  }
  lines.push('')
  lines.push('⚠ **Методологична бележка:** по-ранна итерация включваше и `bias`, `isLeading`, `matchesLedSuit` (суров), `trickLeadershipSignal` (суров) и `legalCardsCountNormalized` — всичките ≈0 тегло след 60 epochs. Причината не е бъг: в softmax-over-candidates ranking loss всеки feature, константен за всички candidate карти в рамките на едно решение, математически носи ТОЧНО нулев градиент (защото sum на (prob−target) по кандидатите е винаги 0). Проверка върху реалните train данни потвърди, че `matchesLedSuit` е 100% константен във всяко решение (0 от 14926 non-forced решения имат mixed match) — follow-suit правилото вече е приложено в `legalCards`, преди моделът изобщо да види картите. `trickLeadershipSignal` е запазен само като interaction term по-горе, където реално варира per-candidate.')
  if (m.modelVersion === 'card-model-v2') {
    lines.push('')
    lines.push('Същото правило важи за v2 добавките: `isLead` и `pointsInTrickNormalized` СЪЗНАТЕЛНО НЕ фигурират като голи features (decision-level константи) — влизат само през `leadCandidateStrengthWhenLeading`/`winningPointsInteraction`, където per-candidate вариращата половина на произведението гарантира ненулев градиент.')
  }
  lines.push('')
  lines.push('## Features (СЪЗНАТЕЛНО НЕ използвани — недостатъчно/небезопасно налична информация)')
  lines.push('')
  if (m.modelVersion === 'card-model-v2') {
    lines.push('- Пълна изиграна история извън текущия trick / tricks взети до момента по отбор (само `currentTrick` е наличен per-action; derivable БЕЗ recorder writer промяна чрез join върху `TrainingDealRecord.tricks`, но това е dataset builder enhancement извън обхвата на тази задача — виж weakness-analysis.md Priority 3).')
    lines.push('- Declarations context (терца/50/100/каре/белот) — липсва напълно от recorder schema-та (Priority 4, изисква recorder writer промяна).')
  } else {
    lines.push('- Пълна изиграна история извън текущия trick (само `currentTrick` е наличен в schema-та; `playedCardCountBeforeAction` е само брояч, не история на самите карти).')
  }
  lines.push('- Карти в ръцете на другите играчи / void tracking извън own hand — не е налично и не бива да е (would leak information the real player never had at decision time either, беше си коректно скрито от recorder-а).')
  lines.push('- Bidding контекст/история — bidding decisions са отделен dataset, не е join-нат тук.')
  lines.push('')

  if (m.modelVersion === 'card-model-v2' && Array.isArray(m.futureCleanHandFeatureAudit)) {
    lines.push('## "Clean hand" / played-cards / remaining-cards feature audit (за бъдещ card-model-v3)')
    lines.push('')
    lines.push(
      'AI-ят трябва в бъдеще да помни цялото раздаване (кои карти са излезли, кои остават, кои собствени карти са ' +
      '"clean winners"/guaranteed да вземат взятка). Проверено едно по едно срещу РЕАЛНАТА card decision sample schema — ' +
      'следната таблица е точният статус на всяко исканo поле.',
    )
    lines.push('')
    lines.push('| Feature | Статус | Бележка |')
    lines.push('|---|---|---|')
    for (const f of m.futureCleanHandFeatureAudit as Array<{ feature: string; status: string; note: string }>) {
      lines.push(`| \`${f.feature}\` | **${f.status}** | ${f.note} |`)
    }
    lines.push('')
    lines.push(
      '`blocked_needs_dataset_join` означава: данните СЪЩЕСТВУВАТ в recorder архива (TrainingDealRecord.tricks, записан ' +
      'на deal-ниво), но НЕ са част от per-action card decision schema-та (card-{train,validation,test}.jsonl) — изисква ' +
      'dataset builder enhancement (join по trickIndex), НЕ recorder writer промяна. Отбелязано като blocking Priority 1 ' +
      'за следваща задача, не имплементирано тук (извън обхвата: "не прави голяма dataset builder rewrite в тази задача").',
    )
    lines.push('')
  }

  lines.push('## Model artifact')
  lines.push('')
  lines.push(`- \`training-output/models/${m.modelVersion}/model.json\` (тегла + hyperparameters + training data hash — детерминистичен при еднакъв вход)`)
  lines.push('')

  lines.push('## Metrics по split')
  lines.push('')
  for (const split of ['train', 'validation', 'test'] as const) {
    const em = m.metrics[split]
    lines.push(`**${split}:**`)
    lines.push(`- All: ${em.correct}/${em.total} = ${pct(em.accuracy)}`)
    lines.push(`- Forced: ${em.forcedCorrect}/${em.forcedTotal} = ${pct(em.forcedAccuracy)}`)
    lines.push(`- Non-forced: ${em.nonForcedCorrect}/${em.nonForcedTotal} = ${pct(em.nonForcedAccuracy)}`)
    lines.push(`- Fallback rate: ${pct(em.fallbackRate)} (${em.fallbackCount} sample-а)`)
    lines.push(`- Invalid predictions: ${em.invalidPredictionCount} (трябва да е 0)`)
    lines.push('')
  }

  lines.push('## Breakdown по game mode (validation/test)')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    lines.push(`**${split}:**`)
    for (const [mode, g] of Object.entries(m.byGameMode[split] as Record<string, { total: number; correct: number; accuracy: number }>)) {
      lines.push(`- ${mode}: ${g.correct}/${g.total} = ${pct(g.accuracy)}`)
    }
    lines.push('')
  }

  lines.push('## Breakdown по legalCards.length bucket (validation/test)')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    lines.push(`**${split}:**`)
    for (const bucket of ['1', '2', '3', '4', '5+']) {
      const g = (m.byLegalCardsLengthBucket[split] as Record<string, { total: number; correct: number; accuracy: number }>)[bucket]
      if (!g) continue
      lines.push(`- ${bucket} legal card(s): ${g.correct}/${g.total} = ${pct(g.accuracy)}`)
    }
    lines.push('')
  }

  lines.push('## Breakdown по lead/follow context (validation/test)')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    const lf = m.byLeadFollow[split]
    lines.push(`**${split}:** lead ${lf.lead.correct}/${lf.lead.total} = ${pct(lf.lead.accuracy)}; follow ${lf.follow.correct}/${lf.follow.total} = ${pct(lf.follow.accuracy)}`)
  }
  lines.push('')

  lines.push('## Сравнение с baseline evaluator-а')
  lines.push('')
  if (m.baselineComparison.source) {
    lines.push(`Източник: \`${m.baselineComparison.source}\``)
    lines.push('')
    for (const split of ['validation', 'test'] as const) {
      const b = m.baselineComparison[split]
      const em = m.metrics[split]
      lines.push(`**${split}:**`)
      lines.push(`- Model non-forced accuracy: **${pct(em.nonForcedAccuracy)}**`)
      if (typeof b.randomLegalNonForced === 'number') lines.push(`- Random-legal baseline (non-forced): ${pct(b.randomLegalNonForced)}`)
      if (typeof b.firstLegalNonForced === 'number') lines.push(`- First-legal baseline (non-forced): ${pct(b.firstLegalNonForced)}`)
      if (typeof b.majorityCardNonForced === 'number') lines.push(`- Majority-card diagnostic baseline (non-forced): ${pct(b.majorityCardNonForced)}`)
      if (typeof b.suitFollowOnFollowRows === 'number') lines.push(`- Suit-follow heuristic (само на follow rows, различен denominator): ${pct(b.suitFollowOnFollowRows)}`)
      lines.push('')
    }
  } else {
    lines.push(`⚠ ${m.baselineComparison.note}`)
    lines.push('')
  }

  lines.push('## Основен критерий')
  lines.push('')
  lines.push(`Non-forced test accuracy (**${pct(m.metrics.test.nonForcedAccuracy)}**) спрямо first-legal non-forced test baseline (**${pct(m.firstLegalNonForcedTestBaselineUsed)}**): **${m.beatsFirstLegalNonForcedTestBaseline ? 'БИЕ baseline-а ✓' : 'НЕ бие baseline-а ✗'}**`)
  lines.push('')
  if (m.beatsFirstLegalNonForcedTestBaseline) {
    lines.push('✅ Моделът показва сигнал над тривиалния first-legal baseline. Това е обещаващ, но все още много прост linear модел — подходящ като candidate за следваща стъпка (offline inference wrapper), не за directly beta/production bot логика.')
  } else {
    lines.push('⚠️ Моделът НЕ бие first-legal baseline-а на non-forced test decisions. Не е готов за следваща стъпка (offline inference wrapper) в текущия си вид — нужни са повече/по-добри features, повече данни, или различен модел, преди да се продължи.')
  }
  lines.push('')

  lines.push('## Препоръка')
  lines.push('')
  lines.push(m.beatsFirstLegalNonForcedTestBaseline
    ? '- Продължи към offline inference wrapper САМО след независим review на тези метрики — 1 линеен модел върху ~15k sample-а е крехък сигнал, не окончателно доказателство за качество.'
    : '- Не продължавай към offline inference wrapper все още. Обмисли повече features (пример: партньорски declared suits, ако станат налични), повече training данни, или non-linear модел, преди следващ опит.')
  lines.push('- Винаги re-евaluирай на test split-а само веднъж, след като validation-ът покаже стабилно подобрение — не итерирай хиперпараметри срещу test.')
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
