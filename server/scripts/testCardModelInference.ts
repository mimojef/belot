/**
 * testCardModelInference.ts
 *
 * Offline CLI test за cardModelInference.ts — доказва, че saved model.json +
 * inference wrapper възпроизвеждат ТОЧНО trainer-ските evaluation метрики
 * (server/scripts/trainCardModel.ts), а не само "изглежда добре". Чете
 * training-output/baseline/card-{validation,test}.jsonl, пуска
 * rankLegalCardsWithCardModel върху всеки sample, изчислява същите
 * breakdown метрики и ги сравнява с training-output/models/card-model-v1/
 * metrics.json в рамките на малка tolerance.
 *
 * Няма runtime ефект — read-only offline проверка. Не пипа gameplay,
 * bot strategy, matchmaking, economy, client protocol или recorder writer.
 *
 * Usage:
 *   npm run test:card-model-inference   (от server/)
 *
 * Exit codes:
 *   0 — inference metrics съвпадат с trainer metrics (в tolerance),
 *       privacy PASS, invalid predictions = 0
 *   1 — invalid/missing input, privacy нарушение, trainer/inference mismatch,
 *       invalid predictions > 0
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
} from './trainingInference/cardModelInference.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')
const MODEL_DIR = join(OUTPUT_DIR, 'models', 'card-model-v1')

const MODEL_JSON_PATH = join(MODEL_DIR, 'model.json')
const TRAINER_METRICS_JSON_PATH = join(MODEL_DIR, 'metrics.json')

const CARD_PATHS = {
  validation: join(BASELINE_DIR, 'card-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-test.jsonl'),
}

const INFERENCE_SUMMARY_JSON_PATH = join(MODEL_DIR, 'inference-test-summary.json')
const INFERENCE_SUMMARY_MD_PATH = join(MODEL_DIR, 'inference-test-summary.md')

// ─── Constants ────────────────────────────────────────────────────────────────

type SplitName = 'validation' | 'test'
const SPLIT_NAMES: SplitName[] = ['validation', 'test']
const ACCURACY_TOLERANCE = 1e-9 // трениран и inference използват еднакъв детерминистичен код → очаква се точно съвпадение

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

// ─── Evaluation metrics (същата форма като trainCardModel.ts/evaluateTrainingBaselines.ts) ─

type GroupMetrics = { total: number; correct: number; accuracy: number }

type SplitInferenceMetrics = GroupMetrics & {
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

function evaluateSplit(model: CardModel, records: FullCardRecord[]): SplitInferenceMetrics {
  let correct = 0
  let forcedTotal = 0
  let forcedCorrect = 0
  let nonForcedTotal = 0
  let nonForcedCorrect = 0
  let fallbackCount = 0
  let invalidPredictionCount = 0

  for (const r of records) {
    const prediction = rankLegalCardsWithCardModel(model, toDecisionState(r))
    if (!prediction.validation.selectedCardIsLegal) invalidPredictionCount++
    if (prediction.fallbackUsed) fallbackCount++

    const isCorrect = prediction.selectedCard === r.chosenCard.id
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

function evaluateGroup(model: CardModel, records: FullCardRecord[]): GroupMetrics {
  let correct = 0
  for (const r of records) {
    const prediction = rankLegalCardsWithCardModel(model, toDecisionState(r))
    if (prediction.selectedCard === r.chosenCard.id) correct++
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

function approxEqual(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Card Model Inference Test (локален, read-only)')
  console.log('─────────────────────────────────────────')

  // ─── Стъпка: зареди model.json (fail-closed) ───────────────────────────────
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

  // ─── Стъпка: чети validation/test split файловете ──────────────────────────
  const fileContents: Record<SplitName, string> = { validation: '', test: '' }
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

  console.log('Валидирам card split файловете...')
  const parsed = {
    validation: parseJsonlStrict<Partial<FullCardRecord>>(fileContents.validation, 'card-validation.jsonl'),
    test: parseJsonlStrict<Partial<FullCardRecord>>(fileContents.test, 'card-test.jsonl'),
  }

  const validationErrors: string[] = []
  for (const split of SPLIT_NAMES) {
    validationErrors.push(...parsed[split].errors)
    for (const { record, lineNumber } of parsed[split].lines) {
      validationErrors.push(...validateCardRecord(record, `card-${split}.jsonl:${lineNumber}`))
    }
  }
  if (validationErrors.length > 0) {
    console.error(`\n✗ Открити ${validationErrors.length} validation грешки — inference test СПРЯН.\n`)
    for (const err of validationErrors.slice(0, 200)) console.error(`  ${err}`)
    process.exit(1)
    return
  }

  // ─── Privacy scan на input ──────────────────────────────────────────────────
  console.log('Privacy/sanitization сканиране на input файловете...')
  const inputViolations: SanitizationViolation[] = []
  for (const split of SPLIT_NAMES) inputViolations.push(...(await scanAllForbiddenContent(CARD_PATHS[split])))
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — inference test СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const records: Record<SplitName, FullCardRecord[]> = {
    validation: parsed.validation.lines.map((l) => l.record as FullCardRecord),
    test: parsed.test.lines.map((l) => l.record as FullCardRecord),
  }

  // ─── Стъпка: пусни inference върху validation/test ─────────────────────────
  console.log('Пускам inference върху validation/test...')
  const inferenceMetrics: Record<SplitName, SplitInferenceMetrics> = {
    validation: evaluateSplit(model, records.validation),
    test: evaluateSplit(model, records.test),
  }

  const byGameMode: Record<SplitName, Record<string, GroupMetrics>> = { validation: {}, test: {} }
  const byBucket: Record<SplitName, Record<string, GroupMetrics>> = { validation: {}, test: {} }
  const byLeadFollow: Record<SplitName, { lead: GroupMetrics; follow: GroupMetrics }> = {
    validation: { lead: { total: 0, correct: 0, accuracy: 0 }, follow: { total: 0, correct: 0, accuracy: 0 } },
    test: { lead: { total: 0, correct: 0, accuracy: 0 }, follow: { total: 0, correct: 0, accuracy: 0 } },
  }

  for (const split of SPLIT_NAMES) {
    const recs = records[split]
    const byMode = groupBy(recs, (r) => r.contract.contract ?? 'unknown')
    for (const [mode, group] of Object.entries(byMode)) byGameMode[split][mode] = evaluateGroup(model, group)

    const byLen = groupBy(recs, (r) => legalCardsLengthBucket(r.legalCards.length))
    for (const [bucket, group] of Object.entries(byLen)) byBucket[split][bucket] = evaluateGroup(model, group)

    const leadRecs = recs.filter((r) => r.positionInTrick === 0)
    const followRecs = recs.filter((r) => r.positionInTrick !== 0)
    byLeadFollow[split].lead = evaluateGroup(model, leadRecs)
    byLeadFollow[split].follow = evaluateGroup(model, followRecs)
  }

  // ─── Стъпка: сравни с trainer metrics.json ──────────────────────────────────
  let trainerMetrics: any = null
  try {
    trainerMetrics = JSON.parse(await readFile(TRAINER_METRICS_JSON_PATH, 'utf8'))
  } catch (e) {
    console.error(`FATAL: не мога да прочета trainer metrics.json (${TRAINER_METRICS_JSON_PATH}): ${e instanceof Error ? e.message : String(e)}`)
    console.error('Изпълни първо: npm run train:card-model')
    process.exit(2)
    return
  }

  const mismatches: string[] = []
  for (const split of SPLIT_NAMES) {
    const trainerSplit = trainerMetrics.metrics?.[split]
    if (!trainerSplit) {
      mismatches.push(`metrics.json няма metrics.${split}`)
      continue
    }
    const inf = inferenceMetrics[split]

    const checks: Array<[string, number, number]> = [
      ['total', inf.total, trainerSplit.total],
      ['correct', inf.correct, trainerSplit.correct],
      ['accuracy', inf.accuracy, trainerSplit.accuracy],
      ['forcedTotal', inf.forcedTotal, trainerSplit.forcedTotal],
      ['forcedCorrect', inf.forcedCorrect, trainerSplit.forcedCorrect],
      ['forcedAccuracy', inf.forcedAccuracy, trainerSplit.forcedAccuracy],
      ['nonForcedTotal', inf.nonForcedTotal, trainerSplit.nonForcedTotal],
      ['nonForcedCorrect', inf.nonForcedCorrect, trainerSplit.nonForcedCorrect],
      ['nonForcedAccuracy', inf.nonForcedAccuracy, trainerSplit.nonForcedAccuracy],
    ]
    for (const [field, infVal, trainerVal] of checks) {
      if (typeof trainerVal !== 'number' || !approxEqual(infVal, trainerVal, ACCURACY_TOLERANCE)) {
        mismatches.push(`${split}.${field}: inference=${infVal}, trainer=${trainerVal} (tolerance=${ACCURACY_TOLERANCE})`)
      }
    }
  }

  const invalidPredictionTotal = inferenceMetrics.validation.invalidPredictionCount + inferenceMetrics.test.invalidPredictionCount
  if (invalidPredictionTotal > 0) {
    mismatches.push(`invalid predictions намерени: validation=${inferenceMetrics.validation.invalidPredictionCount}, test=${inferenceMetrics.test.invalidPredictionCount} (трябва да е 0)`)
  }

  const matchesTrainer = mismatches.length === 0

  // ─── Report обекти ──────────────────────────────────────────────────────────
  const generatedAt = new Date().toISOString()
  const summaryJson = {
    generatedAt,
    modelVersion: model.modelVersion,
    inputFiles: {
      model: MODEL_JSON_PATH,
      trainerMetrics: TRAINER_METRICS_JSON_PATH,
      cardValidation: CARD_PATHS.validation,
      cardTest: CARD_PATHS.test,
    },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    inferenceMetrics,
    byGameMode,
    byLegalCardsLengthBucket: byBucket,
    byLeadFollow,
    trainerVsInference: {
      matchesTrainer,
      tolerance: ACCURACY_TOLERANCE,
      mismatches,
    },
  }

  await writeFile(INFERENCE_SUMMARY_JSON_PATH, JSON.stringify(summaryJson, null, 2) + '\n', 'utf8')
  await writeFile(INFERENCE_SUMMARY_MD_PATH, renderMarkdown(summaryJson), 'utf8')

  // ─── Privacy re-scan на generated reports ──────────────────────────────────
  console.log('Privacy/sanitization сканиране на generated reports...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(INFERENCE_SUMMARY_JSON_PATH)),
    ...(await scanAllForbiddenContent(INFERENCE_SUMMARY_MD_PATH)),
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
  console.log(`  Validation — all: ${pct(inferenceMetrics.validation.accuracy)}, forced: ${pct(inferenceMetrics.validation.forcedAccuracy)}, non-forced: ${pct(inferenceMetrics.validation.nonForcedAccuracy)}`)
  console.log(`  Test       — all: ${pct(inferenceMetrics.test.accuracy)}, forced: ${pct(inferenceMetrics.test.forcedAccuracy)}, non-forced: ${pct(inferenceMetrics.test.nonForcedAccuracy)}`)
  console.log(`  Fallback rate — validation: ${pct(inferenceMetrics.validation.fallbackRate)}, test: ${pct(inferenceMetrics.test.fallbackRate)}`)
  console.log(`  Invalid predictions — validation: ${inferenceMetrics.validation.invalidPredictionCount}, test: ${inferenceMetrics.test.invalidPredictionCount}`)
  console.log(`  Trainer/inference match: ${matchesTrainer ? 'ДА ✓' : 'НЕ ✗'}`)
  console.log(`\n✓ Отчет: ${INFERENCE_SUMMARY_MD_PATH}`)
  console.log(`✓ Отчет: ${INFERENCE_SUMMARY_JSON_PATH}`)

  if (!matchesTrainer) {
    console.error('\n✗ Inference metrics НЕ съвпадат с trainer metrics:\n')
    for (const m of mismatches) console.error(`  ${m}`)
    process.exit(1)
    return
  }

  console.log('✓ Inference test завършен успешно — saved model + wrapper възпроизвеждат trainer evaluation.\n')
  process.exit(0)
}

function renderMarkdown(s: any): string {
  const lines: string[] = []
  lines.push('# Card Model v1 — Inference Test')
  lines.push('')
  lines.push(`Генериран на: ${s.generatedAt}`)
  lines.push(`Модел: \`${s.modelVersion}\``)
  lines.push('')
  lines.push('Read-only offline проверка: saved `model.json` + `cardModelInference.ts` wrapper се тестват върху validation/test split-овете и се сравняват с trainer-ските evaluation метрики от `metrics.json`. Целта е да докаже, че артефактът се зарежда и предсказва идентично на trainer-a, не просто "изглежда добре".')
  lines.push('')

  lines.push('## Privacy validation')
  lines.push('')
  lines.push(`Статус: **${s.privacyValidation.status}** (${s.privacyValidation.violationCount} нарушения)`)
  lines.push('')

  lines.push('## Metrics по split (inference wrapper)')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    const em = s.inferenceMetrics[split]
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
    for (const [mode, g] of Object.entries(s.byGameMode[split] as Record<string, GroupMetrics>)) {
      lines.push(`- ${mode}: ${g.correct}/${g.total} = ${pct(g.accuracy)}`)
    }
    lines.push('')
  }

  lines.push('## Breakdown по legalCards.length bucket (validation/test)')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    lines.push(`**${split}:**`)
    for (const bucket of ['1', '2', '3', '4', '5+']) {
      const g = (s.byLegalCardsLengthBucket[split] as Record<string, GroupMetrics>)[bucket]
      if (!g) continue
      lines.push(`- ${bucket} legal card(s): ${g.correct}/${g.total} = ${pct(g.accuracy)}`)
    }
    lines.push('')
  }

  lines.push('## Breakdown по lead/follow context (validation/test)')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    const lf = s.byLeadFollow[split]
    lines.push(`**${split}:** lead ${lf.lead.correct}/${lf.lead.total} = ${pct(lf.lead.accuracy)}; follow ${lf.follow.correct}/${lf.follow.total} = ${pct(lf.follow.accuracy)}`)
  }
  lines.push('')

  lines.push('## Trainer vs. inference съвпадение')
  lines.push('')
  lines.push(`Статус: **${s.trainerVsInference.matchesTrainer ? 'СЪВПАДА ✓' : 'НЕ СЪВПАДА ✗'}** (tolerance: ${s.trainerVsInference.tolerance})`)
  if (s.trainerVsInference.mismatches.length > 0) {
    lines.push('')
    lines.push('Несъответствия:')
    for (const m of s.trainerVsInference.mismatches as string[]) lines.push(`- ${m}`)
  } else {
    lines.push('')
    lines.push('Всички all/forced/non-forced accuracy стойности за validation и test съвпадат точно с trainer-ските `metrics.json` — saved model artifact + inference wrapper възпроизвеждат trainer evaluation-a 1:1. Това потвърждава, че feature extraction, weight loading и ranking логиката са консистентни между training и inference (споделен код чрез `cardModelFeatures.ts`, не копие).')
  }
  lines.push('')

  lines.push('## Заключение')
  lines.push('')
  lines.push(s.trainerVsInference.matchesTrainer
    ? '✅ Inference wrapper-ът е готов за следваща offline употреба (напр. ad-hoc single-decision inference извън batch evaluation). Все още НЕ е свързан към runtime gameplay/bot логиката — това е отделна бъдеща стъпка, изискваща собствен review.'
    : '⚠️ Inference wrapper-ът НЕ възпроизвежда trainer метриките точно — вероятна причина е разминаване във feature extraction или model loading логиката. Не продължавай към каквато и да е следваща интеграция, докато несъответствието не бъде намерено и коригирано.')
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
