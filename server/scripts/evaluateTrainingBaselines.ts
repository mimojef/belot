/**
 * evaluateTrainingBaselines.ts
 *
 * Read-only локален baseline evaluator върху вече генерираните
 * training-output/baseline/*.jsonl split файлове. Не чете .tar.gz архива,
 * не пипа dataset builder-а / review script-а / prepareTrainingBaseline.ts,
 * не тренира реален модел — само изчислява честни, non-ML baseline метрики,
 * които бъдещ обучен модел трябва да бие.
 *
 * Usage:
 *   npm run evaluate:training-baselines   (от server/)
 *
 * Exit codes:
 *   0 — evaluation отчетите са генерирани успешно
 *   1 — invalid/missing input, count mismatch с baseline-summary.json,
 *       privacy нарушение, или leakage между splits
 *   2 — file system грешка или вътрешна логическа грешка
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')

const BIDDING_PATHS = {
  train: join(BASELINE_DIR, 'bidding-train.jsonl'),
  validation: join(BASELINE_DIR, 'bidding-validation.jsonl'),
  test: join(BASELINE_DIR, 'bidding-test.jsonl'),
}
const CARD_PATHS = {
  train: join(BASELINE_DIR, 'card-train.jsonl'),
  validation: join(BASELINE_DIR, 'card-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-test.jsonl'),
}
const CARD_NONFORCED_PATHS = {
  train: join(BASELINE_DIR, 'card-nonforced-train.jsonl'),
  validation: join(BASELINE_DIR, 'card-nonforced-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-nonforced-test.jsonl'),
}
const BASELINE_SUMMARY_JSON_PATH = join(BASELINE_DIR, 'baseline-summary.json')

const EVAL_SUMMARY_JSON_PATH = join(BASELINE_DIR, 'evaluation-summary.json')
const EVAL_SUMMARY_MD_PATH = join(BASELINE_DIR, 'evaluation-summary.md')

// ─── Constants ────────────────────────────────────────────────────────────────

type SplitName = 'train' | 'validation' | 'test'
const SPLIT_NAMES: SplitName[] = ['train', 'validation', 'test']

const BIDDING_IMBALANCE_THRESHOLD = 0.5
const FORCED_CARD_WARNING_THRESHOLD = 0.25

// ─── Shared shapes (pass-through — matches training-output/baseline/*.jsonl) ─

type CompactCard = { id: string; suit: string; rank: string }
type CompactBidAction = { type: string; suit?: string }
type CompactPlayedCard = { sequence: number; trickIndex: number; positionInTrick: number; seat: string; card: CompactCard }

type BiddingRecord = {
  recordingId: string
  roomKey: string
  dealIndex: number
  sequence: number
  seat: string
  playerKey: string | null
  ownHand: CompactCard[]
  dealerSeat: string
  scoreBeforeDeal: unknown
  previousBids: CompactBidAction[]
  legalActions: CompactBidAction[]
  chosenAction: CompactBidAction
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
  ownHand: CompactCard[]
  legalCards: CompactCard[]
  chosenCard: CompactCard
  contract: { bidderSeat?: string; contract?: string; trumpSuit?: string | null; doubled?: boolean; redoubled?: boolean }
  playedCardCountBeforeAction: number
  currentTrick: CompactPlayedCard[]
  currentWinningSeat: unknown
  currentWinningCard: unknown
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

function validateBiddingRecord(r: Partial<BiddingRecord>, label: string): string[] {
  const errors: string[] = []
  if (typeof r.recordingId !== 'string' || !r.recordingId) errors.push(`${label}: липсва recordingId`)
  if (typeof r.roomKey !== 'string' || !r.roomKey) errors.push(`${label}: липсва roomKey`)
  if (typeof r.sequence !== 'number') errors.push(`${label}: липсва sequence`)
  if (typeof r.seat !== 'string' || !r.seat) errors.push(`${label}: липсва seat`)
  if (!Array.isArray(r.ownHand) || r.ownHand.length === 0) {
    errors.push(`${label}: ownHand липсва/празно`)
  } else if (!r.ownHand.every(isValidCompactCard)) {
    errors.push(`${label}: ownHand съдържа невалидна card representation`)
  }
  if (!r.chosenAction || typeof r.chosenAction.type !== 'string') errors.push(`${label}: chosenAction липсва/невалиден`)
  return errors
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

function shortKeyLabel(key: string): string {
  return key.length > 10 ? `${key.slice(0, 10)}…` : key
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

// ─── Leakage checks (същия принцип като prepareTrainingBaseline.ts) ──────────

function buildRoomToSplitMap(entries: Array<{ roomKey: string; split: SplitName }>): Map<string, Set<SplitName>> {
  const map = new Map<string, Set<SplitName>>()
  for (const { roomKey, split } of entries) {
    const set = map.get(roomKey) ?? new Set<SplitName>()
    set.add(split)
    map.set(roomKey, set)
  }
  return map
}

function findWithinDatasetLeakage(map: Map<string, Set<SplitName>>): string[] {
  const problems: string[] = []
  for (const [roomKey, splits] of map) {
    if (splits.size > 1) problems.push(`roomKey ${shortKeyLabel(roomKey)} се появява в няколко split-а: ${[...splits].join(', ')}`)
  }
  return problems
}

function findCrossDatasetMismatch(a: Map<string, Set<SplitName>>, b: Map<string, Set<SplitName>>): string[] {
  const problems: string[] = []
  for (const [roomKey, splitsA] of a) {
    const splitsB = b.get(roomKey)
    if (!splitsB) continue
    const sa = [...splitsA][0]
    const sb = [...splitsB][0]
    if (sa !== sb) problems.push(`roomKey ${shortKeyLabel(roomKey)}: bidding split=${sa} card split=${sb}`)
  }
  return problems
}

// ─── Bidding baseline evaluation ──────────────────────────────────────────────

function actionTypeDistribution(records: BiddingRecord[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of records) counts[r.chosenAction.type] = (counts[r.chosenAction.type] ?? 0) + 1
  return counts
}

function majorityLabelFrom(counts: Record<string, number>): { label: string; count: number; total: number; share: number } {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  let bestLabel = ''
  let bestCount = -1
  for (const [label, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestLabel = label
      bestCount = count
    }
  }
  return { label: bestLabel, count: Math.max(bestCount, 0), total, share: total > 0 ? Math.max(bestCount, 0) / total : 0 }
}

type PerActionMetric = { support: number; predictedCount: number; precision: number; recall: number; f1: number }

type BiddingSplitEvaluation = {
  total: number
  overallAccuracy: number
  accuracyExcludingPass: number
  nonPassTotal: number
  perAction: Record<string, PerActionMetric>
  confusionMatrix: Record<string, Record<string, number>>
  predictionDistribution: Record<string, number>
}

function evaluateBiddingSplit(records: BiddingRecord[], majorityLabel: string, allLabels: string[]): BiddingSplitEvaluation {
  const total = records.length
  const actualCounts: Record<string, number> = {}
  const confusionMatrix: Record<string, Record<string, number>> = {}
  for (const label of allLabels) {
    actualCounts[label] = 0
    confusionMatrix[label] = Object.fromEntries(allLabels.map((l) => [l, 0]))
  }

  let correct = 0
  let nonPassTotal = 0
  let nonPassCorrect = 0

  for (const r of records) {
    const actual = r.chosenAction.type
    const predicted = majorityLabel
    actualCounts[actual] = (actualCounts[actual] ?? 0) + 1
    if (!confusionMatrix[actual]) confusionMatrix[actual] = Object.fromEntries(allLabels.map((l) => [l, 0]))
    confusionMatrix[actual]![predicted] = (confusionMatrix[actual]![predicted] ?? 0) + 1
    if (actual === predicted) correct++
    if (actual !== 'pass') {
      nonPassTotal++
      if (actual === predicted) nonPassCorrect++
    }
  }

  const perAction: Record<string, PerActionMetric> = {}
  for (const label of allLabels) {
    const support = actualCounts[label] ?? 0
    const predictedCount = label === majorityLabel ? total : 0
    const truePositive = label === majorityLabel ? support : 0
    const precision = predictedCount > 0 ? truePositive / predictedCount : 0
    const recall = support > 0 ? truePositive / support : 0
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    perAction[label] = { support, predictedCount, precision, recall, f1 }
  }

  return {
    total,
    overallAccuracy: total > 0 ? correct / total : 0,
    accuracyExcludingPass: nonPassTotal > 0 ? nonPassCorrect / nonPassTotal : 0,
    nonPassTotal,
    perAction,
    confusionMatrix,
    predictionDistribution: { [majorityLabel]: total },
  }
}

// ─── Card baseline evaluation ─────────────────────────────────────────────────

function randomLegalExpectedAccuracy(records: CardRecord[]): number {
  if (records.length === 0) return 0
  return records.reduce((acc, r) => acc + 1 / r.legalCards.length, 0) / records.length
}

function firstLegalAccuracy(records: CardRecord[]): number {
  if (records.length === 0) return 0
  let correct = 0
  for (const r of records) if (r.legalCards[0]!.id === r.chosenCard.id) correct++
  return correct / records.length
}

function forcedNonForced(records: CardRecord[]): { forced: CardRecord[]; nonForced: CardRecord[] } {
  const forced: CardRecord[] = []
  const nonForced: CardRecord[] = []
  for (const r of records) (r.legalCards.length === 1 ? forced : nonForced).push(r)
  return { forced, nonForced }
}

function majorityChosenCardFrom(records: CardRecord[]): { id: string; count: number; total: number } {
  const counts = new Map<string, number>()
  for (const r of records) counts.set(r.chosenCard.id, (counts.get(r.chosenCard.id) ?? 0) + 1)
  let bestId = ''
  let bestCount = -1
  for (const [id, count] of counts) {
    if (count > bestCount) {
      bestId = id
      bestCount = count
    }
  }
  return { id: bestId, count: Math.max(bestCount, 0), total: records.length }
}

function majorityCardBaselineEval(records: CardRecord[], majorityCardId: string): { accuracy: number; fallbackRate: number } {
  if (records.length === 0) return { accuracy: 0, fallbackRate: 0 }
  let correct = 0
  let fallbackUsed = 0
  for (const r of records) {
    const legalIds = new Set(r.legalCards.map((c) => c.id))
    let predictedId = majorityCardId
    if (!legalIds.has(majorityCardId)) {
      predictedId = r.legalCards[0]!.id
      fallbackUsed++
    }
    if (predictedId === r.chosenCard.id) correct++
  }
  return { accuracy: correct / records.length, fallbackRate: fallbackUsed / records.length }
}

function suitFollowHeuristicEval(records: CardRecord[]): {
  followRowCount: number
  leadRowCount: number
  skippedInsufficientDataCount: number
  accuracyOnFollowRows: number
  fallbackRateOnFollowRows: number
} {
  const followRows: CardRecord[] = []
  const leadRows: CardRecord[] = []
  let skipped = 0

  for (const r of records) {
    if (!Array.isArray(r.currentTrick)) {
      skipped++
      continue
    }
    if (r.currentTrick.length === 0) {
      leadRows.push(r)
    } else {
      const ledCard = r.currentTrick[0]?.card
      if (!ledCard || typeof ledCard.suit !== 'string') {
        skipped++
        continue
      }
      followRows.push(r)
    }
  }

  let correct = 0
  let fallbackUsed = 0
  for (const r of followRows) {
    const ledSuit = r.currentTrick[0]!.card.suit
    const matching = r.legalCards.find((c) => c.suit === ledSuit)
    const predictedId = matching ? matching.id : r.legalCards[0]!.id
    if (!matching) fallbackUsed++
    if (predictedId === r.chosenCard.id) correct++
  }

  return {
    followRowCount: followRows.length,
    leadRowCount: leadRows.length,
    skippedInsufficientDataCount: skipped,
    accuracyOnFollowRows: followRows.length > 0 ? correct / followRows.length : 0,
    fallbackRateOnFollowRows: followRows.length > 0 ? fallbackUsed / followRows.length : 0,
  }
}

type CardBreakdownMetrics = {
  total: number
  forcedCount: number
  nonForcedCount: number
  randomLegalExpectedAccuracyAll: number
  randomLegalExpectedAccuracyNonForced: number
  firstLegalAccuracyAll: number
  firstLegalAccuracyNonForced: number
}

function computeCardBreakdownMetrics(records: CardRecord[]): CardBreakdownMetrics {
  const { forced, nonForced } = forcedNonForced(records)
  return {
    total: records.length,
    forcedCount: forced.length,
    nonForcedCount: nonForced.length,
    randomLegalExpectedAccuracyAll: randomLegalExpectedAccuracy(records),
    randomLegalExpectedAccuracyNonForced: randomLegalExpectedAccuracy(nonForced),
    firstLegalAccuracyAll: firstLegalAccuracy(records),
    firstLegalAccuracyNonForced: firstLegalAccuracy(nonForced),
  }
}

function legalCardsLengthBucket(len: number): '1' | '2' | '3' | '4' | '5+' {
  if (len <= 1) return '1'
  if (len === 2) return '2'
  if (len === 3) return '3'
  if (len === 4) return '4'
  return '5+'
}

function groupBy<T>(records: T[], keyFn: (r: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {}
  for (const r of records) {
    const key = keyFn(r)
    ;(groups[key] ??= []).push(r)
  }
  return groups
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  AI Training Baseline Evaluator (локален, read-only)')
  console.log('─────────────────────────────────────────')

  // ─── Стъпка 1: чети required split файловете ───────────────────────────────
  const requiredPaths: Array<{ label: string; path: string }> = [
    { label: 'bidding-train.jsonl', path: BIDDING_PATHS.train },
    { label: 'bidding-validation.jsonl', path: BIDDING_PATHS.validation },
    { label: 'bidding-test.jsonl', path: BIDDING_PATHS.test },
    { label: 'card-train.jsonl', path: CARD_PATHS.train },
    { label: 'card-validation.jsonl', path: CARD_PATHS.validation },
    { label: 'card-test.jsonl', path: CARD_PATHS.test },
  ]

  const fileContents: Record<string, string> = {}
  const missingFiles: string[] = []
  for (const { label, path } of requiredPaths) {
    try {
      fileContents[label] = await readFile(path, 'utf8')
    } catch {
      missingFiles.push(`${label} (${path})`)
    }
  }
  if (missingFiles.length > 0) {
    console.error('FATAL: липсват необходими baseline split файлове:')
    for (const f of missingFiles) console.error(`  - ${f}`)
    console.error('\nИзпълни първо: npm run prepare:training-baseline')
    process.exit(2)
    return
  }

  // ─── Стъпка 2: parse + validate ─────────────────────────────────────────────
  console.log('Валидирам bidding split файловете...')
  const biddingParsed = {
    train: parseJsonlStrict<Partial<BiddingRecord>>(fileContents['bidding-train.jsonl']!, 'bidding-train.jsonl'),
    validation: parseJsonlStrict<Partial<BiddingRecord>>(fileContents['bidding-validation.jsonl']!, 'bidding-validation.jsonl'),
    test: parseJsonlStrict<Partial<BiddingRecord>>(fileContents['bidding-test.jsonl']!, 'bidding-test.jsonl'),
  }
  console.log('Валидирам card split файловете...')
  const cardParsed = {
    train: parseJsonlStrict<Partial<CardRecord>>(fileContents['card-train.jsonl']!, 'card-train.jsonl'),
    validation: parseJsonlStrict<Partial<CardRecord>>(fileContents['card-validation.jsonl']!, 'card-validation.jsonl'),
    test: parseJsonlStrict<Partial<CardRecord>>(fileContents['card-test.jsonl']!, 'card-test.jsonl'),
  }

  const validationErrors: string[] = []
  for (const split of SPLIT_NAMES) {
    validationErrors.push(...biddingParsed[split].errors)
    for (const { record, lineNumber } of biddingParsed[split].lines) {
      validationErrors.push(...validateBiddingRecord(record, `bidding-${split}.jsonl:${lineNumber}`))
    }
    validationErrors.push(...cardParsed[split].errors)
    for (const { record, lineNumber } of cardParsed[split].lines) {
      validationErrors.push(...validateCardRecord(record, `card-${split}.jsonl:${lineNumber}`))
    }
  }

  // Optional nonforced файлове — четем ако съществуват, само за consistency cross-check.
  const nonForcedConsistency: Record<SplitName, { present: boolean; expectedCount: number; actualCount: number; matches: boolean }> = {
    train: { present: false, expectedCount: 0, actualCount: 0, matches: true },
    validation: { present: false, expectedCount: 0, actualCount: 0, matches: true },
    test: { present: false, expectedCount: 0, actualCount: 0, matches: true },
  }
  for (const split of SPLIT_NAMES) {
    let content: string | null = null
    try {
      content = await readFile(CARD_NONFORCED_PATHS[split], 'utf8')
    } catch {
      content = null
    }
    if (content === null) continue
    const parsed = parseJsonlStrict<Partial<CardRecord>>(content, `card-nonforced-${split}.jsonl`)
    validationErrors.push(...parsed.errors)
    const expected = cardParsed[split].lines.filter((l) => Array.isArray(l.record.legalCards) && l.record.legalCards.length >= 2).length
    const actual = parsed.lines.length
    nonForcedConsistency[split] = { present: true, expectedCount: expected, actualCount: actual, matches: expected === actual }
    if (expected !== actual) {
      validationErrors.push(`card-nonforced-${split}.jsonl: съдържа ${actual} реда, но derived non-forced subset от card-${split}.jsonl има ${expected} — несъответствие`)
    }
  }

  if (validationErrors.length > 0) {
    console.error(`\n✗ Открити ${validationErrors.length} validation грешки в baseline input-а — evaluation СПРЯН.\n`)
    for (const err of validationErrors.slice(0, 200)) console.error(`  ${err}`)
    if (validationErrors.length > 200) console.error(`  ... и още ${validationErrors.length - 200}`)
    process.exit(1)
    return
  }

  const biddingRecords: Record<SplitName, BiddingRecord[]> = {
    train: biddingParsed.train.lines.map((l) => l.record as BiddingRecord),
    validation: biddingParsed.validation.lines.map((l) => l.record as BiddingRecord),
    test: biddingParsed.test.lines.map((l) => l.record as BiddingRecord),
  }
  const cardRecords: Record<SplitName, CardRecord[]> = {
    train: cardParsed.train.lines.map((l) => l.record as CardRecord),
    validation: cardParsed.validation.lines.map((l) => l.record as CardRecord),
    test: cardParsed.test.lines.map((l) => l.record as CardRecord),
  }

  // ─── Cross-check counts срещу baseline-summary.json (ако съществува) ───────
  let baselineSummary: Record<string, unknown> | null = null
  try {
    baselineSummary = JSON.parse(await readFile(BASELINE_SUMMARY_JSON_PATH, 'utf8')) as Record<string, unknown>
  } catch {
    baselineSummary = null
  }

  let countsMatchBaselineSummary: boolean | null = null
  if (baselineSummary && typeof baselineSummary['counts'] === 'object' && baselineSummary['counts'] !== null) {
    const counts = baselineSummary['counts'] as Record<string, Record<string, number>>
    const mismatches: string[] = []
    if (counts['bidding']) {
      for (const split of SPLIT_NAMES) {
        if (typeof counts['bidding'][split] === 'number' && counts['bidding'][split] !== biddingRecords[split].length) {
          mismatches.push(`bidding.${split}: baseline-summary.json=${counts['bidding'][split]}, действителен=${biddingRecords[split].length}`)
        }
      }
    }
    if (counts['card']) {
      for (const split of SPLIT_NAMES) {
        if (typeof counts['card'][split] === 'number' && counts['card'][split] !== cardRecords[split].length) {
          mismatches.push(`card.${split}: baseline-summary.json=${counts['card'][split]}, действителен=${cardRecords[split].length}`)
        }
      }
    }
    countsMatchBaselineSummary = mismatches.length === 0
    if (mismatches.length > 0) {
      console.error('\n✗ Count mismatch спрямо baseline-summary.json:\n')
      for (const m of mismatches) console.error(`  ${m}`)
      process.exit(1)
      return
    }
  }

  // ─── Стъпка 2 (privacy): сканирай input файловете ──────────────────────────
  console.log('Privacy/sanitization сканиране на input файловете...')
  const inputScanPaths = [
    BIDDING_PATHS.train, BIDDING_PATHS.validation, BIDDING_PATHS.test,
    CARD_PATHS.train, CARD_PATHS.validation, CARD_PATHS.test,
  ]
  const inputViolations: SanitizationViolation[] = []
  for (const p of inputScanPaths) inputViolations.push(...(await scanAllForbiddenContent(p)))
  for (const split of SPLIT_NAMES) {
    if (nonForcedConsistency[split].present) inputViolations.push(...(await scanAllForbiddenContent(CARD_NONFORCED_PATHS[split])))
  }
  if (baselineSummary) inputViolations.push(...(await scanAllForbiddenContent(BASELINE_SUMMARY_JSON_PATH)))

  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в baseline input-а — evaluation СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  // ─── Стъпка 3: leakage validation ───────────────────────────────────────────
  console.log('Leakage validation...')
  const biddingSplitEntries = SPLIT_NAMES.flatMap((split) => biddingRecords[split].map((r) => ({ roomKey: r.roomKey, split })))
  const cardSplitEntries = SPLIT_NAMES.flatMap((split) => cardRecords[split].map((r) => ({ roomKey: r.roomKey, split })))
  const biddingRoomMap = buildRoomToSplitMap(biddingSplitEntries)
  const cardRoomMap = buildRoomToSplitMap(cardSplitEntries)

  const biddingWithinProblems = findWithinDatasetLeakage(biddingRoomMap)
  const cardWithinProblems = findWithinDatasetLeakage(cardRoomMap)
  const crossDatasetProblems = findCrossDatasetMismatch(biddingRoomMap, cardRoomMap)
  const allLeakageProblems = [...biddingWithinProblems, ...cardWithinProblems, ...crossDatasetProblems]

  if (allLeakageProblems.length > 0) {
    console.error(`\n✗ LEAKAGE открит между splits — evaluation СПРЯН:\n`)
    for (const p of allLeakageProblems.slice(0, 50)) console.error(`  ${p}`)
    process.exit(1)
    return
  }

  // ─── Стъпка 4: bidding baseline evaluation ──────────────────────────────────
  console.log('Изчислявам bidding baseline метрики...')
  const biddingTrainDistribution = actionTypeDistribution(biddingRecords.train)
  const biddingMajority = majorityLabelFrom(biddingTrainDistribution)
  const allBiddingLabels = [...new Set([
    ...Object.keys(biddingTrainDistribution),
    ...Object.keys(actionTypeDistribution(biddingRecords.validation)),
    ...Object.keys(actionTypeDistribution(biddingRecords.test)),
  ])]
  const biddingImbalanced = biddingMajority.share > BIDDING_IMBALANCE_THRESHOLD
  const biddingImbalanceRatio = allBiddingLabels.length > 0 ? biddingMajority.share / (1 / allBiddingLabels.length) : 0

  const biddingEval: Record<SplitName, BiddingSplitEvaluation> = {
    train: evaluateBiddingSplit(biddingRecords.train, biddingMajority.label, allBiddingLabels),
    validation: evaluateBiddingSplit(biddingRecords.validation, biddingMajority.label, allBiddingLabels),
    test: evaluateBiddingSplit(biddingRecords.test, biddingMajority.label, allBiddingLabels),
  }

  // ─── Стъпка 5: card baseline evaluation ─────────────────────────────────────
  console.log('Изчислявам card baseline метрики...')
  const cardMajorityCard = majorityChosenCardFrom(cardRecords.train)

  const cardEval: Record<SplitName, {
    breakdown: CardBreakdownMetrics
    majorityCard: { accuracyAll: number; fallbackRateAll: number; accuracyNonForced: number; fallbackRateNonForced: number }
    suitFollow: ReturnType<typeof suitFollowHeuristicEval>
  }> = {} as any

  for (const split of SPLIT_NAMES) {
    const all = cardRecords[split]
    const { nonForced } = forcedNonForced(all)
    const majorityAll = majorityCardBaselineEval(all, cardMajorityCard.id)
    const majorityNonForced = majorityCardBaselineEval(nonForced, cardMajorityCard.id)
    cardEval[split] = {
      breakdown: computeCardBreakdownMetrics(all),
      majorityCard: {
        accuracyAll: majorityAll.accuracy,
        fallbackRateAll: majorityAll.fallbackRate,
        accuracyNonForced: majorityNonForced.accuracy,
        fallbackRateNonForced: majorityNonForced.fallbackRate,
      },
      suitFollow: suitFollowHeuristicEval(all),
    }
  }

  // ─── Breakdown по game mode / legalCards bucket / lead-follow (validation+test) ─
  const modeBreakdown: Record<SplitName, Record<string, CardBreakdownMetrics>> = {} as any
  const bucketBreakdown: Record<SplitName, Record<string, CardBreakdownMetrics>> = {} as any
  const leadFollowBreakdown: Record<SplitName, Record<'lead' | 'follow', CardBreakdownMetrics>> = {} as any

  for (const split of SPLIT_NAMES) {
    const records = cardRecords[split]

    const byMode = groupBy(records, (r) => r.contract.contract ?? 'unknown')
    modeBreakdown[split] = Object.fromEntries(Object.entries(byMode).map(([mode, recs]) => [mode, computeCardBreakdownMetrics(recs)]))

    const byBucket = groupBy(records, (r) => legalCardsLengthBucket(r.legalCards.length))
    bucketBreakdown[split] = Object.fromEntries(Object.entries(byBucket).map(([bucket, recs]) => [bucket, computeCardBreakdownMetrics(recs)]))

    const leadRecords = records.filter((r) => r.positionInTrick === 0)
    const followRecords = records.filter((r) => r.positionInTrick !== 0)
    leadFollowBreakdown[split] = {
      lead: computeCardBreakdownMetrics(leadRecords),
      follow: computeCardBreakdownMetrics(followRecords),
    }
  }

  // ─── Warnings (item 8) ──────────────────────────────────────────────────────
  const warnings: string[] = []
  if (biddingImbalanced) {
    warnings.push(`Bidding majority class ("${biddingMajority.label}") е ${pct(biddingMajority.share)} от train — над ${pct(BIDDING_IMBALANCE_THRESHOLD)} threshold.`)
  }
  for (const split of ['validation', 'test'] as const) {
    const nonPassRecalls = Object.entries(biddingEval[split].perAction).filter(([label]) => label !== biddingMajority.label)
    const allZeroRecall = nonPassRecalls.length > 0 && nonPassRecalls.every(([, m]) => m.recall === 0)
    if (allZeroRecall) {
      warnings.push(`Always-"${biddingMajority.label}" baseline има recall=0 за ВСИЧКИ non-"${biddingMajority.label}" класове на ${split} (${nonPassRecalls.map(([l]) => l).join(', ')}) — очаквано за constant predictor, но не бива да се прикрива.`)
    }
  }
  for (const split of SPLIT_NAMES) {
    const forcedPct = cardEval[split].breakdown.total > 0 ? cardEval[split].breakdown.forcedCount / cardEval[split].breakdown.total : 0
    if (forcedPct > FORCED_CARD_WARNING_THRESHOLD) {
      warnings.push(`Forced card decisions в ${split} са ${pct(forcedPct)} — над ${pct(FORCED_CARD_WARNING_THRESHOLD)} threshold. Оценявай основно на non-forced subset.`)
    }
  }
  if (allLeakageProblems.length > 0) warnings.push('Leakage risk открит между splits (виж leakageValidation).')
  if (inputViolations.length > 0) warnings.push('Privacy нарушение открито в input-а.')
  const missingCurrentTrickInfo = SPLIT_NAMES.some((s) => cardEval[s].suitFollow.skippedInsufficientDataCount > 0)
  if (missingCurrentTrickInfo) {
    for (const s of SPLIT_NAMES) {
      if (cardEval[s].suitFollow.skippedInsufficientDataCount > 0) {
        warnings.push(`${s}: ${cardEval[s].suitFollow.skippedInsufficientDataCount} card records нямат достатъчно currentTrick данни за suit-follow heuristic — пропуснати от тази метрика.`)
      }
    }
  }

  // ─── Стъпка 7: report обекти ────────────────────────────────────────────────
  const generatedAt = new Date().toISOString()

  const evaluationSummaryJson = {
    generatedAt,
    inputFiles: {
      biddingTrain: BIDDING_PATHS.train,
      biddingValidation: BIDDING_PATHS.validation,
      biddingTest: BIDDING_PATHS.test,
      cardTrain: CARD_PATHS.train,
      cardValidation: CARD_PATHS.validation,
      cardTest: CARD_PATHS.test,
      cardNonforcedTrain: nonForcedConsistency.train.present ? CARD_NONFORCED_PATHS.train : null,
      cardNonforcedValidation: nonForcedConsistency.validation.present ? CARD_NONFORCED_PATHS.validation : null,
      cardNonforcedTest: nonForcedConsistency.test.present ? CARD_NONFORCED_PATHS.test : null,
      baselineSummaryJson: baselineSummary ? BASELINE_SUMMARY_JSON_PATH : null,
    },
    inputCounts: {
      bidding: { train: biddingRecords.train.length, validation: biddingRecords.validation.length, test: biddingRecords.test.length },
      card: { train: cardRecords.train.length, validation: cardRecords.validation.length, test: cardRecords.test.length },
    },
    countsMatchBaselineSummary,
    nonForcedFileConsistency: nonForcedConsistency,
    leakageValidation: {
      status: allLeakageProblems.length === 0 ? 'PASS' : 'FAIL',
      biddingWithinDatasetProblems: biddingWithinProblems,
      cardWithinDatasetProblems: cardWithinProblems,
      crossDatasetProblems,
    },
    privacyValidation: {
      status: inputViolations.length === 0 ? 'PASS' : 'FAIL',
      violationCount: inputViolations.length,
      violations: inputViolations.slice(0, 100),
    },
    biddingMetrics: {
      trainActionDistribution: biddingTrainDistribution,
      majorityAction: biddingMajority,
      classImbalanceRatio: biddingImbalanceRatio,
      imbalanced: biddingImbalanced,
      imbalanceThreshold: BIDDING_IMBALANCE_THRESHOLD,
      validation: biddingEval.validation,
      test: biddingEval.test,
      train: biddingEval.train,
    },
    cardMetrics: {
      majorityChosenCardId: cardMajorityCard.id,
      majorityChosenCardNote: 'Диагностичен baseline — избраната карта зависи силно от контекста (ownHand/legalCards/trick); fallback към legalCards[0] когато majority картата не е легална.',
      perSplit: cardEval,
      byGameMode: modeBreakdown,
      byLegalCardsLengthBucket: bucketBreakdown,
      byLeadFollow: leadFollowBreakdown,
    },
    warnings,
  }

  await writeFile(EVAL_SUMMARY_JSON_PATH, JSON.stringify(evaluationSummaryJson, null, 2) + '\n', 'utf8')
  await writeFile(EVAL_SUMMARY_MD_PATH, renderMarkdown(evaluationSummaryJson), 'utf8')

  // ─── Privacy re-scan на generated reports (defense in depth) ───────────────
  console.log('Privacy/sanitization сканиране на generated evaluation reports...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(EVAL_SUMMARY_JSON_PATH)),
    ...(await scanAllForbiddenContent(EVAL_SUMMARY_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated evaluation reports — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  // ─── Финален конзолен отчет ─────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Leakage: PASS (0 problems)`)
  console.log(`  Privacy: PASS`)
  console.log(`  Bidding majority: "${biddingMajority.label}" (${pct(biddingMajority.share)} of train)`)
  console.log(`  Bidding overall accuracy — validation: ${pct(biddingEval.validation.overallAccuracy)}, test: ${pct(biddingEval.test.overallAccuracy)}`)
  console.log(`  Bidding accuracy excluding pass — validation: ${pct(biddingEval.validation.accuracyExcludingPass)}, test: ${pct(biddingEval.test.accuracyExcludingPass)}`)
  console.log(`  Card random-legal (all) — validation: ${pct(cardEval.validation.breakdown.randomLegalExpectedAccuracyAll)}, test: ${pct(cardEval.test.breakdown.randomLegalExpectedAccuracyAll)}`)
  console.log(`  Card random-legal (non-forced) — validation: ${pct(cardEval.validation.breakdown.randomLegalExpectedAccuracyNonForced)}, test: ${pct(cardEval.test.breakdown.randomLegalExpectedAccuracyNonForced)}`)
  console.log(`  Card first-legal (all) — validation: ${pct(cardEval.validation.breakdown.firstLegalAccuracyAll)}, test: ${pct(cardEval.test.breakdown.firstLegalAccuracyAll)}`)
  console.log(`  Warnings: ${warnings.length}`)
  console.log(`\n✓ Отчет записан: ${EVAL_SUMMARY_MD_PATH}`)
  console.log(`✓ Отчет записан: ${EVAL_SUMMARY_JSON_PATH}`)
  console.log('✓ Evaluation завършена успешно.\n')

  process.exit(0)
}

function renderMarkdown(s: any): string {
  const lines: string[] = []
  lines.push('# Training Baseline Evaluation — отчет')
  lines.push('')
  lines.push(`Генериран на: ${s.generatedAt}`)
  lines.push('')
  lines.push('Read-only evaluator върху `training-output/baseline/*.jsonl`. Не тренира реален модел, не пипа dataset builder-а/review/prepare script-овете.')
  lines.push('')

  lines.push('## Input counts')
  lines.push('')
  lines.push(`**Bidding:** train=${s.inputCounts.bidding.train}, validation=${s.inputCounts.bidding.validation}, test=${s.inputCounts.bidding.test}`)
  lines.push(`**Card:** train=${s.inputCounts.card.train}, validation=${s.inputCounts.card.validation}, test=${s.inputCounts.card.test}`)
  if (s.countsMatchBaselineSummary !== null) {
    lines.push(`Съвпада ли с \`baseline-summary.json\`: **${s.countsMatchBaselineSummary ? 'ДА' : 'НЕ'}**`)
  } else {
    lines.push('`baseline-summary.json` не е намерен/без counts — cross-check пропуснат.')
  }
  lines.push('')

  lines.push('## Leakage validation')
  lines.push('')
  lines.push(`Статус: **${s.leakageValidation.status}**`)
  lines.push('Всяка `roomKey` е проверена да е изцяло в един-единствен split — както поотделно за bidding и card, така и cross-dataset (еднакъв split за bidding и card решения от една и съща стая).')
  lines.push('')

  lines.push('## Privacy validation')
  lines.push('')
  lines.push(`Статус: **${s.privacyValidation.status}** (${s.privacyValidation.violationCount} нарушения)`)
  lines.push('Проверени маркери: roomId, profileId, accountId, playerId, connectionId, reconnectToken, sessionId/session*, deviceId, email, username, displayName, ip/ipAddress, password, token/accessToken/refreshToken/authToken, secret, cookie, authorization + email-like/ipv4-like patterns.')
  lines.push('')

  lines.push('## Bidding baseline — защо raw accuracy е подвеждаща')
  lines.push('')
  lines.push(`Majority class (от train): **"${s.biddingMetrics.majorityAction.label}"** — ${pct(s.biddingMetrics.majorityAction.share)} от train.`)
  lines.push(`Class imbalance ratio: ${s.biddingMetrics.classImbalanceRatio.toFixed(2)}x спрямо uniform очакване (1/брой класове).`)
  lines.push(`Imbalance статус: ${s.biddingMetrics.imbalanced ? `⚠ СИЛНО IMBALANCED (над ${pct(s.biddingMetrics.imbalanceThreshold)})` : 'в норма'}`)
  lines.push('')
  lines.push('**Train action distribution:**')
  for (const [label, count] of Object.entries(s.biddingMetrics.trainActionDistribution as Record<string, number>).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${label}: ${count}`)
  }
  lines.push('')
  for (const split of ['validation', 'test']) {
    const ev = s.biddingMetrics[split]
    lines.push(`### ${split}`)
    lines.push('')
    lines.push(`- Overall accuracy (always-"${s.biddingMetrics.majorityAction.label}"): **${pct(ev.overallAccuracy)}**`)
    lines.push(`- Accuracy excluding "${s.biddingMetrics.majorityAction.label}" (${ev.nonPassTotal} samples): **${pct(ev.accuracyExcludingPass)}**`)
    lines.push('- Per-action precision/recall/F1:')
    for (const [label, m] of Object.entries(ev.perAction as Record<string, PerActionMetric>).sort((a, b) => b[1].support - a[1].support)) {
      lines.push(`  - ${label}: support=${m.support}, precision=${pct(m.precision)}, recall=${pct(m.recall)}, F1=${pct(m.f1)}`)
    }
    lines.push('- Confusion matrix (actual → predicted counts):')
    for (const [actual, predictedCounts] of Object.entries(ev.confusionMatrix as Record<string, Record<string, number>>)) {
      const nonZero = Object.entries(predictedCounts).filter(([, c]) => c > 0)
      if (nonZero.length === 0) continue
      lines.push(`  - actual="${actual}": ${nonZero.map(([p, c]) => `predicted="${p}"→${c}`).join(', ')}`)
    }
    lines.push('')
  }
  lines.push(`⚠ Тъй като baseline predictor-ът винаги предсказва "${s.biddingMetrics.majorityAction.label}", recall за всички останали действия е **0%** по конструкция — това е коректно, не е грешка в изчислението. Честната летва за бъдещ модел е: (1) overall accuracy над majority baseline, И (2) ненулев recall за non-"${s.biddingMetrics.majorityAction.label}" класове.`)
  lines.push('')

  lines.push('## Card baseline — честна летва')
  lines.push('')
  for (const split of ['validation', 'test']) {
    const ev = s.cardMetrics.perSplit[split]
    lines.push(`### ${split}`)
    lines.push('')
    lines.push(`- Total: ${ev.breakdown.total} (forced=${ev.breakdown.forcedCount}, non-forced=${ev.breakdown.nonForcedCount})`)
    lines.push(`- **Random legal-card baseline** (1/legalCards.length) — all: ${pct(ev.breakdown.randomLegalExpectedAccuracyAll)}, non-forced only: ${pct(ev.breakdown.randomLegalExpectedAccuracyNonForced)}`)
    lines.push(`- **First-legal-card baseline** — all: ${pct(ev.breakdown.firstLegalAccuracyAll)}, non-forced only: ${pct(ev.breakdown.firstLegalAccuracyNonForced)}`)
    lines.push(`- Train-majority-card baseline (\`${s.cardMetrics.majorityChosenCardId}\`, диагностичен) — all: ${pct(ev.majorityCard.accuracyAll)} (fallback ${pct(ev.majorityCard.fallbackRateAll)}), non-forced only: ${pct(ev.majorityCard.accuracyNonForced)} (fallback ${pct(ev.majorityCard.fallbackRateNonForced)})`)
    lines.push(`- Suit-follow heuristic — follow rows: ${ev.suitFollow.followRowCount}, accuracy: ${pct(ev.suitFollow.accuracyOnFollowRows)} (fallback ${pct(ev.suitFollow.fallbackRateOnFollowRows)}); lead rows (heuristic N/A): ${ev.suitFollow.leadRowCount}`)
    lines.push('')
  }
  lines.push(`⚠ ${s.cardMetrics.majorityChosenCardNote}`)
  lines.push('')
  lines.push('**Основната бъдеща ML метрика трябва да е non-forced card accuracy** — forced decisions (само 1 legal card) са тривиални (100% by construction) и biased-ват общата метрика нагоре без реален сигнал.')
  lines.push('')

  lines.push('## Card breakdown по game mode (validation/test)')
  lines.push('')
  for (const split of ['validation', 'test']) {
    lines.push(`**${split}:**`)
    for (const [mode, m] of Object.entries(s.cardMetrics.byGameMode[split] as Record<string, CardBreakdownMetrics>)) {
      lines.push(`- ${mode}: total=${m.total}, random-legal(non-forced)=${pct(m.randomLegalExpectedAccuracyNonForced)}, first-legal(non-forced)=${pct(m.firstLegalAccuracyNonForced)}`)
    }
    lines.push('')
  }

  lines.push('## Card breakdown по legalCards.length bucket (validation/test)')
  lines.push('')
  for (const split of ['validation', 'test']) {
    lines.push(`**${split}:**`)
    for (const bucket of ['1', '2', '3', '4', '5+']) {
      const m = (s.cardMetrics.byLegalCardsLengthBucket[split] as Record<string, CardBreakdownMetrics>)[bucket]
      if (!m) continue
      lines.push(`- ${bucket} legal card(s): total=${m.total}, random-legal(all)=${pct(m.randomLegalExpectedAccuracyAll)}, first-legal(all)=${pct(m.firstLegalAccuracyAll)}`)
    }
    lines.push('')
  }

  lines.push('## Card breakdown по lead/follow context (validation/test)')
  lines.push('')
  for (const split of ['validation', 'test']) {
    const lf = s.cardMetrics.byLeadFollow[split] as Record<'lead' | 'follow', CardBreakdownMetrics>
    lines.push(`**${split}:** lead total=${lf.lead.total} (random-legal ${pct(lf.lead.randomLegalExpectedAccuracyNonForced)} non-forced), follow total=${lf.follow.total} (random-legal ${pct(lf.follow.randomLegalExpectedAccuracyNonForced)} non-forced)`)
  }
  lines.push('')

  lines.push('## Warnings')
  lines.push('')
  if (s.warnings.length === 0) {
    lines.push('Няма.')
  } else {
    for (const w of s.warnings as string[]) lines.push(`- ⚠ ${w}`)
  }
  lines.push('')

  lines.push('## Препоръка за първи ML модел')
  lines.push('')
  lines.push(`- **Bidding:** трябва да бие majority-class accuracy (validation ${pct(s.biddingMetrics.validation.overallAccuracy)}, test ${pct(s.biddingMetrics.test.overallAccuracy)}) И да покаже ненулев recall за non-"${s.biddingMetrics.majorityAction.label}" класове — само overall accuracy не е достатъчно доказателство за полезност.`)
  lines.push(`- **Card play:** честната летва е random-legal-card baseline на non-forced decisions (validation ${pct(s.cardMetrics.perSplit.validation.breakdown.randomLegalExpectedAccuracyNonForced)}, test ${pct(s.cardMetrics.perSplit.test.breakdown.randomLegalExpectedAccuracyNonForced)}), не majority-card и не first-legal.`)
  lines.push('- Оценявай отделно по game mode, legalCards.length bucket и lead/follow контекст — вероятно моделът ще се представя различно във всеки сегмент.')
  lines.push('- Използвай test split-а само за финална оценка, не за итеративен избор на хиперпараметри (за това е validation).')
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
