/**
 * prepareTrainingBaseline.ts
 *
 * Read-only локален baseline data prep върху вече export-натия training
 * dataset (training-output/bidding-decisions.jsonl, card-decisions.jsonl).
 * Не чете .tar.gz архива, не пипа dataset builder-а/review script-а, не
 * тренира реален модел — само подготвя честен train/validation/test split
 * и наивни (non-ML) baseline метрики, за да имаме отправна точка преди
 * реално model training.
 *
 * Usage:
 *   npm run prepare:training-baseline   (от server/)
 *
 * Split стратегия:
 *   Deterministic, seed-ван hash на `roomKey` (не individual rows), за да
 *   не изтичат данни от една и съща стая едновременно в train и
 *   validation/test. Ако уникалните roomKey са твърде малко за смислен
 *   room-based split, се използва row-level fallback (hash на
 *   recordingId+sequence) — това се докладва изрично в отчета.
 *
 * Exit codes:
 *   0 — baseline файловете и отчетите са генерирани успешно
 *   1 — invalid input JSONL, schema/validation грешка, privacy нарушение
 *   2 — file system грешка или вътрешна логическа грешка (напр. leakage bug)
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')

const BIDDING_INPUT_PATH = join(OUTPUT_DIR, 'bidding-decisions.jsonl')
const CARD_INPUT_PATH = join(OUTPUT_DIR, 'card-decisions.jsonl')

const BASELINE_SUMMARY_JSON_PATH = join(BASELINE_DIR, 'baseline-summary.json')
const BASELINE_SUMMARY_MD_PATH = join(BASELINE_DIR, 'baseline-summary.md')

// ─── Constants ────────────────────────────────────────────────────────────────

const SPLIT_SEED = 'belot-v2-training-baseline-v1'
const SPLIT_RATIOS = { train: 0.8, validation: 0.1, test: 0.1 } as const
const MIN_UNIQUE_ROOMS_FOR_ROOM_SPLIT = 10
const IMBALANCE_WARNING_THRESHOLD = 0.5 // majority class share над това се маркира silно imbalanced

type SplitName = 'train' | 'validation' | 'test'
const SPLIT_NAMES: SplitName[] = ['train', 'validation', 'test']

// ─── Shared shapes (pass-through — не променяме оригиналната schema) ─────────

type CompactCard = { id: string; suit: string; rank: string }
type CompactBidAction = { type: string; suit?: string }

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
  contract: unknown
  playedCardCountBeforeAction: number
  currentTrick: unknown
  currentWinningSeat: unknown
  currentWinningCard: unknown
  dealerSeat: string
  leaderSeat: string
  scoreBeforeDeal: unknown
}

type ParsedLine<T> = { record: T; raw: string; lineNumber: number }

// ─── Strict JSONL parsing (само trailing newline позволен като "празен ред") ─

function parseJsonlStrict<T>(content: string, fileLabel: string): { lines: ParsedLine<T>[]; errors: string[] } {
  const rawLines = content.split('\n')
  const lines: ParsedLine<T>[] = []
  const errors: string[] = []

  rawLines.forEach((rawLine, idx) => {
    const isLastLine = idx === rawLines.length - 1
    const trimmed = rawLine.trim()
    if (!trimmed) {
      if (!isLastLine) {
        errors.push(`${fileLabel}:${idx + 1}: неочакван празен ред (не е trailing newline)`)
      }
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

// ─── Card shape validation (същата проверка като в buildTrainingDataset.ts) ──

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
  if (!Array.isArray(r.legalActions) || r.legalActions.length === 0) errors.push(`${label}: legalActions липсва/празно`)
  if (!r.chosenAction || typeof r.chosenAction.type !== 'string') errors.push(`${label}: chosenAction липсва/невалиден`)
  return errors
}

function validateCardRecord(r: Partial<CardRecord>, label: string): string[] {
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

// ─── Deterministic seeded split ───────────────────────────────────────────────

function hashToUnitInterval(input: string): number {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 8)
  return parseInt(hex, 16) / 0x100000000 // 2^32 → строго в [0,1)
}

function assignSplit(key: string): SplitName {
  const u = hashToUnitInterval(`${SPLIT_SEED}:${key}`)
  if (u < SPLIT_RATIOS.train) return 'train'
  if (u < SPLIT_RATIOS.train + SPLIT_RATIOS.validation) return 'validation'
  return 'test'
}

function emptySplitBucket<T>(): Record<SplitName, T[]> {
  return { train: [], validation: [], test: [] }
}

function uniqueCount<T>(items: T[], keyFn: (t: T) => string | null): number {
  const set = new Set<string>()
  for (const item of items) {
    const k = keyFn(item)
    if (k !== null) set.add(k)
  }
  return set.size
}

// Проверка, че split назначението никога не разбива една стая между splits —
// теоретично гарантирано от чисто-функционалния assignSplit(roomKey), но се
// верифицира реално тук, за да хванем евентуален bug, не да го приемем на вяра.
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

function shortKeyLabel(key: string): string {
  return key.length > 10 ? `${key.slice(0, 10)}…` : key
}

// ─── Bidding baseline metrics ─────────────────────────────────────────────────

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

function accuracyAgainstLabel(records: BiddingRecord[], label: string): number {
  if (records.length === 0) return 0
  let correct = 0
  for (const r of records) if (r.chosenAction.type === label) correct++
  return correct / records.length
}

// ─── Card baseline metrics ────────────────────────────────────────────────────

function splitForcedNonForced(records: CardRecord[]): { forced: CardRecord[]; nonForced: CardRecord[] } {
  const forced: CardRecord[] = []
  const nonForced: CardRecord[] = []
  for (const r of records) (r.legalCards.length === 1 ? forced : nonForced).push(r)
  return { forced, nonForced }
}

function randomLegalExpectedAccuracy(records: CardRecord[]): number {
  if (records.length === 0) return 0
  const sum = records.reduce((acc, r) => acc + 1 / r.legalCards.length, 0)
  return sum / records.length
}

function forcedBaselineAccuracy(records: CardRecord[]): number {
  // Forced decisions имат точно 1 legal card → chosenCard винаги съвпада с
  // единствения legal вариант (валидирано по-горе) → тривиално 100%.
  if (records.length === 0) return 0
  let correct = 0
  for (const r of records) if (r.legalCards.length === 1 && r.chosenCard.id === r.legalCards[0]!.id) correct++
  return correct / records.length
}

function majorityCardIdFrom(records: CardRecord[]): { id: string; count: number; total: number } {
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

function majorityCardAccuracy(records: CardRecord[], cardId: string): number {
  if (records.length === 0) return 0
  let correct = 0
  for (const r of records) if (r.chosenCard.id === cardId) correct++
  return correct / records.length
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

type CardSplitMetrics = {
  total: number
  forcedCount: number
  nonForcedCount: number
  forcedPct: number
  nonForcedPct: number
  forcedBaselineAccuracy: number
  randomLegalExpectedAccuracyAll: number
  randomLegalExpectedAccuracyNonForced: number
  majorityCardAccuracyAll: number
  majorityCardAccuracyNonForced: number
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  AI Training Baseline Prep (локален, read-only spрямо dataset builder-а)')
  console.log('─────────────────────────────────────────')

  let biddingContent: string
  let cardContent: string
  try {
    biddingContent = await readFile(BIDDING_INPUT_PATH, 'utf8')
    cardContent = await readFile(CARD_INPUT_PATH, 'utf8')
  } catch (e) {
    console.error(`FATAL: не мога да прочета dataset файловете от ${OUTPUT_DIR}`)
    console.error('Изпълни първо: npm run build:training-dataset')
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
    return
  }

  // ─── Стъпка 1-2: parse + validate ──────────────────────────────────────────
  console.log('Валидирам bidding-decisions.jsonl...')
  const biddingParsed = parseJsonlStrict<Partial<BiddingRecord>>(biddingContent, 'bidding-decisions.jsonl')
  console.log('Валидирам card-decisions.jsonl...')
  const cardParsed = parseJsonlStrict<Partial<CardRecord>>(cardContent, 'card-decisions.jsonl')

  const validationErrors: string[] = [...biddingParsed.errors, ...cardParsed.errors]
  for (const { record, lineNumber } of biddingParsed.lines) {
    validationErrors.push(...validateBiddingRecord(record, `bidding-decisions.jsonl:${lineNumber}`))
  }
  for (const { record, lineNumber } of cardParsed.lines) {
    validationErrors.push(...validateCardRecord(record, `card-decisions.jsonl:${lineNumber}`))
  }

  if (validationErrors.length > 0) {
    console.error(`\n✗ Открити ${validationErrors.length} validation грешки в input dataset-а — baseline prep СПРЯН.\n`)
    for (const err of validationErrors.slice(0, 200)) console.error(`  ${err}`)
    if (validationErrors.length > 200) console.error(`  ... и още ${validationErrors.length - 200}`)
    process.exit(1)
    return
  }

  // ─── Privacy сканиране на INPUT файловете преди да продължим ──────────────
  console.log('Privacy/sanitization сканиране на input файловете...')
  const inputViolations = [
    ...(await scanAllForbiddenContent(BIDDING_INPUT_PATH)),
    ...(await scanAllForbiddenContent(CARD_INPUT_PATH)),
  ]
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input dataset-а — baseline prep СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const biddingRecords = biddingParsed.lines.map((l) => ({ record: l.record as BiddingRecord, raw: l.raw }))
  const cardRecords = cardParsed.lines.map((l) => ({ record: l.record as CardRecord, raw: l.raw }))

  // ─── Стъпка 3: split strategy ───────────────────────────────────────────────
  const allRoomKeys = new Set<string>()
  for (const r of biddingRecords) allRoomKeys.add(r.record.roomKey)
  for (const r of cardRecords) allRoomKeys.add(r.record.roomKey)

  const useRoomKeySplit = allRoomKeys.size >= MIN_UNIQUE_ROOMS_FOR_ROOM_SPLIT
  const splitStrategy: 'roomKey' | 'row-fallback' = useRoomKeySplit ? 'roomKey' : 'row-fallback'
  const splitStrategyReason = useRoomKeySplit
    ? `roomKey-based split: ${allRoomKeys.size} уникални roomKey (>= ${MIN_UNIQUE_ROOMS_FOR_ROOM_SPLIT} минимум за смислен room-based split).`
    : `Row-level fallback: само ${allRoomKeys.size} уникални roomKey (< ${MIN_UNIQUE_ROOMS_FOR_ROOM_SPLIT} минимум) — room-based split би бил твърде грубозърнест/нестабилен, затова split-ът е по individual row (recordingId+sequence).`

  console.log(`Split стратегия: ${splitStrategy} (${allRoomKeys.size} уникални roomKey)`)

  function splitKeyFor(roomKey: string, recordingId: string, sequence: number): string {
    return useRoomKeySplit ? roomKey : `${recordingId}:${sequence}`
  }

  const biddingBuckets = emptySplitBucket<BiddingRecord>()
  const biddingRawBuckets = emptySplitBucket<string>()
  const biddingSplitEntries: Array<{ roomKey: string; split: SplitName }> = []
  for (const { record, raw } of biddingRecords) {
    const split = assignSplit(splitKeyFor(record.roomKey, record.recordingId, record.sequence))
    biddingBuckets[split].push(record)
    biddingRawBuckets[split].push(raw)
    biddingSplitEntries.push({ roomKey: record.roomKey, split })
  }

  const cardBuckets = emptySplitBucket<CardRecord>()
  const cardRawBuckets = emptySplitBucket<string>()
  const cardSplitEntries: Array<{ roomKey: string; split: SplitName }> = []
  for (const { record, raw } of cardRecords) {
    const split = assignSplit(splitKeyFor(record.roomKey, record.recordingId, record.sequence))
    cardBuckets[split].push(record)
    cardRawBuckets[split].push(raw)
    cardSplitEntries.push({ roomKey: record.roomKey, split })
  }

  // ─── Leakage self-check (би трябвало винаги да е чисто — верифицираме, не приемаме на вяра) ─
  const biddingRoomSplitMap = buildRoomToSplitMap(biddingSplitEntries)
  const cardRoomSplitMap = buildRoomToSplitMap(cardSplitEntries)
  const leakageProblems = [
    ...findWithinDatasetLeakage(biddingRoomSplitMap),
    ...findWithinDatasetLeakage(cardRoomSplitMap),
    ...(useRoomKeySplit ? findCrossDatasetMismatch(biddingRoomSplitMap, cardRoomSplitMap) : []),
  ]
  if (leakageProblems.length > 0) {
    console.error('\n✗ ВЪТРЕШНА ГРЕШКА: открит leakage в split логиката (не би трябвало да е възможно):\n')
    for (const p of leakageProblems.slice(0, 50)) console.error(`  ${p}`)
    process.exit(2)
    return
  }

  // ─── Стъпка 4: подготви training-output/baseline/ ──────────────────────────
  await rm(BASELINE_DIR, { recursive: true, force: true })
  await mkdir(BASELINE_DIR, { recursive: true })

  for (const split of SPLIT_NAMES) {
    await writeFile(
      join(BASELINE_DIR, `bidding-${split}.jsonl`),
      biddingRawBuckets[split].length > 0 ? biddingRawBuckets[split].join('\n') + '\n' : '',
      'utf8',
    )
    await writeFile(
      join(BASELINE_DIR, `card-${split}.jsonl`),
      cardRawBuckets[split].length > 0 ? cardRawBuckets[split].join('\n') + '\n' : '',
      'utf8',
    )
  }

  // ─── Стъпка 5: forced/non-forced split + non-forced-only файлове ──────────
  const cardForcedNonForced: Record<SplitName, { forced: CardRecord[]; nonForced: CardRecord[] }> = {
    train: splitForcedNonForced(cardBuckets.train),
    validation: splitForcedNonForced(cardBuckets.validation),
    test: splitForcedNonForced(cardBuckets.test),
  }

  for (const split of SPLIT_NAMES) {
    const nonForcedRaw = cardRawBuckets[split].filter((raw) => {
      const parsed = JSON.parse(raw) as CardRecord
      return parsed.legalCards.length >= 2
    })
    await writeFile(
      join(BASELINE_DIR, `card-nonforced-${split}.jsonl`),
      nonForcedRaw.length > 0 ? nonForcedRaw.join('\n') + '\n' : '',
      'utf8',
    )
  }

  // ─── Стъпка 6: baseline metrics ─────────────────────────────────────────────

  const biddingActionDistribution: Record<SplitName, Record<string, number>> = {
    train: actionTypeDistribution(biddingBuckets.train),
    validation: actionTypeDistribution(biddingBuckets.validation),
    test: actionTypeDistribution(biddingBuckets.test),
  }
  const biddingMajority = majorityLabelFrom(biddingActionDistribution.train)
  const biddingMajorityAccuracy: Record<SplitName, number> = {
    train: accuracyAgainstLabel(biddingBuckets.train, biddingMajority.label),
    validation: accuracyAgainstLabel(biddingBuckets.validation, biddingMajority.label),
    test: accuracyAgainstLabel(biddingBuckets.test, biddingMajority.label),
  }
  const biddingImbalanced = biddingMajority.share > IMBALANCE_WARNING_THRESHOLD

  const cardMajorityCard = majorityCardIdFrom(cardBuckets.train)
  const cardBaselineMetrics = {} as Record<SplitName, CardSplitMetrics>

  for (const split of SPLIT_NAMES) {
    const all = cardBuckets[split]
    const { forced, nonForced } = cardForcedNonForced[split]
    cardBaselineMetrics[split] = {
      total: all.length,
      forcedCount: forced.length,
      nonForcedCount: nonForced.length,
      forcedPct: all.length > 0 ? forced.length / all.length : 0,
      nonForcedPct: all.length > 0 ? nonForced.length / all.length : 0,
      forcedBaselineAccuracy: forcedBaselineAccuracy(forced),
      randomLegalExpectedAccuracyAll: randomLegalExpectedAccuracy(all),
      randomLegalExpectedAccuracyNonForced: randomLegalExpectedAccuracy(nonForced),
      majorityCardAccuracyAll: majorityCardAccuracy(all, cardMajorityCard.id),
      majorityCardAccuracyNonForced: majorityCardAccuracy(nonForced, cardMajorityCard.id),
    }
  }

  // ─── roomKey / playerKey counts per split ──────────────────────────────────

  const biddingRoomKeyCounts: Record<SplitName, number> = {
    train: uniqueCount(biddingBuckets.train, (r) => r.roomKey),
    validation: uniqueCount(biddingBuckets.validation, (r) => r.roomKey),
    test: uniqueCount(biddingBuckets.test, (r) => r.roomKey),
  }
  const biddingPlayerKeyCounts: Record<SplitName, number> = {
    train: uniqueCount(biddingBuckets.train, (r) => r.playerKey),
    validation: uniqueCount(biddingBuckets.validation, (r) => r.playerKey),
    test: uniqueCount(biddingBuckets.test, (r) => r.playerKey),
  }
  const cardRoomKeyCounts: Record<SplitName, number> = {
    train: uniqueCount(cardBuckets.train, (r) => r.roomKey),
    validation: uniqueCount(cardBuckets.validation, (r) => r.roomKey),
    test: uniqueCount(cardBuckets.test, (r) => r.roomKey),
  }
  const cardPlayerKeyCounts: Record<SplitName, number> = {
    train: uniqueCount(cardBuckets.train, (r) => r.playerKey),
    validation: uniqueCount(cardBuckets.validation, (r) => r.playerKey),
    test: uniqueCount(cardBuckets.test, (r) => r.playerKey),
  }

  // ─── Стъпка 7: report обекти ────────────────────────────────────────────────

  const generatedAt = new Date().toISOString()

  const baselineSummaryJson = {
    generatedAt,
    inputCounts: {
      bidding: biddingRecords.length,
      card: cardRecords.length,
    },
    splitStrategy,
    splitStrategyReason,
    seed: SPLIT_SEED,
    splitRatios: SPLIT_RATIOS,
    counts: {
      bidding: { train: biddingBuckets.train.length, validation: biddingBuckets.validation.length, test: biddingBuckets.test.length },
      card: { train: cardBuckets.train.length, validation: cardBuckets.validation.length, test: cardBuckets.test.length },
    },
    roomKeyCountsPerSplit: { bidding: biddingRoomKeyCounts, card: cardRoomKeyCounts },
    playerKeyCountsPerSplit: { bidding: biddingPlayerKeyCounts, card: cardPlayerKeyCounts },
    biddingActionDistributionPerSplit: biddingActionDistribution,
    cardForcedNonForcedPerSplit: {
      train: { forced: cardBaselineMetrics.train.forcedCount, nonForced: cardBaselineMetrics.train.nonForcedCount, forcedPct: cardBaselineMetrics.train.forcedPct, nonForcedPct: cardBaselineMetrics.train.nonForcedPct },
      validation: { forced: cardBaselineMetrics.validation.forcedCount, nonForced: cardBaselineMetrics.validation.nonForcedCount, forcedPct: cardBaselineMetrics.validation.forcedPct, nonForcedPct: cardBaselineMetrics.validation.nonForcedPct },
      test: { forced: cardBaselineMetrics.test.forcedCount, nonForced: cardBaselineMetrics.test.nonForcedCount, forcedPct: cardBaselineMetrics.test.forcedPct, nonForcedPct: cardBaselineMetrics.test.nonForcedPct },
    },
    baselineMetrics: {
      bidding: {
        majorityClass: { label: biddingMajority.label, trainShare: biddingMajority.share, imbalanced: biddingImbalanced, imbalanceThreshold: IMBALANCE_WARNING_THRESHOLD },
        accuracy: biddingMajorityAccuracy,
      },
      card: {
        majorityCardId: cardMajorityCard.id,
        majorityCardNote: 'Диагностичен baseline — НЕ е препоръчителна оценка: избраната карта зависи силно от контекста (ownHand/legalCards/trick), затова един фиксиран "най-чест" card id рядко е дори легален извън train контекста.',
        perSplit: cardBaselineMetrics,
      },
    },
    validation: {
      status: 'ok',
      inputValidationErrorCount: 0,
      privacyViolationCount: 0,
      leakageProblemsFound: 0,
    },
  }

  await writeFile(BASELINE_SUMMARY_JSON_PATH, JSON.stringify(baselineSummaryJson, null, 2) + '\n', 'utf8')
  await writeFile(BASELINE_SUMMARY_MD_PATH, renderMarkdown(baselineSummaryJson), 'utf8')

  // ─── Стъпка 9: privacy re-scan на generated baseline output ────────────────
  console.log('Privacy/sanitization сканиране на generated baseline output...')
  const outputPaths = [
    ...SPLIT_NAMES.map((s) => join(BASELINE_DIR, `bidding-${s}.jsonl`)),
    ...SPLIT_NAMES.map((s) => join(BASELINE_DIR, `card-${s}.jsonl`)),
    ...SPLIT_NAMES.map((s) => join(BASELINE_DIR, `card-nonforced-${s}.jsonl`)),
    BASELINE_SUMMARY_JSON_PATH,
    BASELINE_SUMMARY_MD_PATH,
  ]
  const outputViolations: SanitizationViolation[] = []
  for (const p of outputPaths) outputViolations.push(...(await scanAllForbiddenContent(p)))

  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated baseline output — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  // ─── Финален конзолен отчет ─────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Split стратегия: ${splitStrategy}`)
  console.log(`  Bidding: train=${biddingBuckets.train.length} validation=${biddingBuckets.validation.length} test=${biddingBuckets.test.length}`)
  console.log(`  Card:    train=${cardBuckets.train.length} validation=${cardBuckets.validation.length} test=${cardBuckets.test.length}`)
  console.log(`  Bidding majority class (train): "${biddingMajority.label}" (${pct(biddingMajority.share)} of train)${biddingImbalanced ? '  ⚠ силно imbalanced' : ''}`)
  console.log(`  Bidding majority accuracy — validation: ${pct(biddingMajorityAccuracy.validation)}, test: ${pct(biddingMajorityAccuracy.test)}`)
  console.log(`  Card random-legal expected accuracy (all) — validation: ${pct(cardBaselineMetrics.validation.randomLegalExpectedAccuracyAll)}, test: ${pct(cardBaselineMetrics.test.randomLegalExpectedAccuracyAll)}`)
  console.log(`  Card random-legal expected accuracy (non-forced) — validation: ${pct(cardBaselineMetrics.validation.randomLegalExpectedAccuracyNonForced)}, test: ${pct(cardBaselineMetrics.test.randomLegalExpectedAccuracyNonForced)}`)
  console.log(`  Leakage check: PASS (0 problems)`)
  console.log(`  Privacy review: PASS`)
  console.log(`\n✓ Отчет записан: ${BASELINE_SUMMARY_MD_PATH}`)
  console.log(`✓ Отчет записан: ${BASELINE_SUMMARY_JSON_PATH}`)
  console.log('✓ Baseline prep завършен успешно.\n')

  process.exit(0)
}

function renderMarkdown(s: {
  generatedAt: string
  inputCounts: { bidding: number; card: number }
  splitStrategy: string
  splitStrategyReason: string
  seed: string
  splitRatios: { train: number; validation: number; test: number }
  counts: { bidding: Record<SplitName, number>; card: Record<SplitName, number> }
  roomKeyCountsPerSplit: { bidding: Record<SplitName, number>; card: Record<SplitName, number> }
  playerKeyCountsPerSplit: { bidding: Record<SplitName, number>; card: Record<SplitName, number> }
  biddingActionDistributionPerSplit: Record<SplitName, Record<string, number>>
  cardForcedNonForcedPerSplit: Record<SplitName, { forced: number; nonForced: number; forcedPct: number; nonForcedPct: number }>
  baselineMetrics: {
    bidding: { majorityClass: { label: string; trainShare: number; imbalanced: boolean; imbalanceThreshold: number }; accuracy: Record<SplitName, number> }
    card: { majorityCardId: string; majorityCardNote: string; perSplit: Record<SplitName, CardSplitMetrics> }
  }
}): string {
  const lines: string[] = []
  lines.push('# Training Baseline Prep — отчет')
  lines.push('')
  lines.push(`Генериран на: ${s.generatedAt}`)
  lines.push('')
  lines.push('Read-only baseline data prep върху `training-output/*decisions.jsonl`. Не тренира реален модел, не пипа dataset builder-а/review script-а, не променя оригиналните dataset файлове.')
  lines.push('')

  lines.push('## Split стратегия')
  lines.push('')
  lines.push(`- **Тип:** ${s.splitStrategy === 'roomKey' ? 'roomKey-based (препоръчителен, без leakage между train/validation/test)' : 'row-level fallback'}`)
  lines.push(`- ${s.splitStrategyReason}`)
  lines.push(`- Seed: \`${s.seed}\` (deterministic — същия seed + същия input → същия split при повторно пускане)`)
  lines.push(`- Ratios: train=${pct(s.splitRatios.train)}, validation=${pct(s.splitRatios.validation)}, test=${pct(s.splitRatios.test)}`)
  lines.push(`- **Leakage risk:** ${s.splitStrategy === 'roomKey' ? 'НЕ — верифицирано програмно, всяка стая (roomKey) е изцяло в един-единствен split, включително еднакво между bidding и card dataset-ите.' : 'Нисък, но row-level split не гарантира изолация на цели стаи — bidding и card решения от една и съща стая биха могли да попаднат в различни splits.'}`)
  lines.push('')

  lines.push('## Counts')
  lines.push('')
  lines.push('**Bidding:**')
  lines.push(`- Input общо: ${s.inputCounts.bidding}`)
  lines.push(`- train: ${s.counts.bidding.train}, validation: ${s.counts.bidding.validation}, test: ${s.counts.bidding.test}`)
  lines.push(`- Уникални roomKey по split: train=${s.roomKeyCountsPerSplit.bidding.train}, validation=${s.roomKeyCountsPerSplit.bidding.validation}, test=${s.roomKeyCountsPerSplit.bidding.test}`)
  lines.push(`- Уникални playerKey по split: train=${s.playerKeyCountsPerSplit.bidding.train}, validation=${s.playerKeyCountsPerSplit.bidding.validation}, test=${s.playerKeyCountsPerSplit.bidding.test}`)
  lines.push('')
  lines.push('**Card:**')
  lines.push(`- Input общо: ${s.inputCounts.card}`)
  lines.push(`- train: ${s.counts.card.train}, validation: ${s.counts.card.validation}, test: ${s.counts.card.test}`)
  lines.push(`- Уникални roomKey по split: train=${s.roomKeyCountsPerSplit.card.train}, validation=${s.roomKeyCountsPerSplit.card.validation}, test=${s.roomKeyCountsPerSplit.card.test}`)
  lines.push(`- Уникални playerKey по split: train=${s.playerKeyCountsPerSplit.card.train}, validation=${s.playerKeyCountsPerSplit.card.validation}, test=${s.playerKeyCountsPerSplit.card.test}`)
  lines.push('')

  lines.push('## Bidding action distribution по split')
  lines.push('')
  for (const split of SPLIT_NAMES) {
    lines.push(`**${split}:**`)
    for (const [label, count] of Object.entries(s.biddingActionDistributionPerSplit[split]).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${label}: ${count}`)
    }
    lines.push('')
  }

  lines.push('## Bidding majority-class baseline')
  lines.push('')
  lines.push(`- Majority class (от train): **"${s.baselineMetrics.bidding.majorityClass.label}"** (${pct(s.baselineMetrics.bidding.majorityClass.trainShare)} от train)`)
  lines.push(`- Imbalance статус: ${s.baselineMetrics.bidding.majorityClass.imbalanced ? `⚠ СИЛНО IMBALANCED (над ${pct(s.baselineMetrics.bidding.majorityClass.imbalanceThreshold)} threshold)` : 'в норма'}`)
  lines.push(`- Accuracy: train=${pct(s.baselineMetrics.bidding.accuracy.train)}, validation=${pct(s.baselineMetrics.bidding.accuracy.validation)}, test=${pct(s.baselineMetrics.bidding.accuracy.test)}`)
  if (s.baselineMetrics.bidding.majorityClass.imbalanced) {
    lines.push('')
    lines.push('⚠ Bidding dataset-ът е силно доминиран от една category (най-вероятно "pass"). Accuracy сам по себе си е подвеждаща метрика тук — реален модел трябва да се оценява и с per-class recall/F1 или balanced accuracy, не само с raw accuracy.')
  }
  lines.push('')

  lines.push('## Card forced vs non-forced (по split)')
  lines.push('')
  for (const split of SPLIT_NAMES) {
    const c = s.cardForcedNonForcedPerSplit[split]
    lines.push(`- **${split}:** forced=${c.forced} (${pct(c.forcedPct)}), non-forced=${c.nonForced} (${pct(c.nonForcedPct)})`)
  }
  lines.push('')

  lines.push('## Card baseline metrics')
  lines.push('')
  for (const split of SPLIT_NAMES) {
    const m = s.baselineMetrics.card.perSplit[split]
    lines.push(`**${split}** (${m.total} decisions, forced=${m.forcedCount}, non-forced=${m.nonForcedCount}):`)
    lines.push(`- Forced-decision baseline accuracy: ${pct(m.forcedBaselineAccuracy)} (тривиално 100% — само 1 legal card по дефиниция)`)
    lines.push(`- Random legal-card baseline expected accuracy — all: ${pct(m.randomLegalExpectedAccuracyAll)}, non-forced only: ${pct(m.randomLegalExpectedAccuracyNonForced)}`)
    lines.push(`- Majority-card baseline (диагностичен, виж бележка по-долу) — all: ${pct(m.majorityCardAccuracyAll)}, non-forced only: ${pct(m.majorityCardAccuracyNonForced)}`)
    lines.push('')
  }
  lines.push(`**Majority card id (от train):** \`${s.baselineMetrics.card.majorityCardId}\``)
  lines.push('')
  lines.push(`⚠ ${s.baselineMetrics.card.majorityCardNote}`)
  lines.push('')

  lines.push('## Препоръка за оценка на бъдещ модел')
  lines.push('')
  lines.push('- **Bidding:** сравнявай бъдещия модел срещу majority-class baseline (accuracy) по-горе, но следи и per-class метрики заради силния imbalance към "pass" — модел, който винаги казва "pass", ще изглежда добре по raw accuracy, без да е полезен.')
  lines.push('- **Card play:** основната честна отправна точка е **random legal-card baseline** (`1/legalCards.length` очаквана точност), не majority-card. Оценявай отделно на non-forced decisions — forced decisions винаги излизат 100% и biased-ват общата метрика нагоре без реален сигнал.')
  lines.push('- Използвай `card-nonforced-{train,validation,test}.jsonl`, ако искаш метрика, изчистена от тривиални forced избори.')
  lines.push('- Split-ът е roomKey-based и seed-ван — повторно пускане на този script върху същия input дава идентичен split, което прави резултатите възпроизводими.')
  lines.push('')

  lines.push('## Изходни файлове (training-output/baseline/, generated — не в git)')
  lines.push('')
  lines.push('- `bidding-train.jsonl`, `bidding-validation.jsonl`, `bidding-test.jsonl`')
  lines.push('- `card-train.jsonl`, `card-validation.jsonl`, `card-test.jsonl`')
  lines.push('- `card-nonforced-train.jsonl`, `card-nonforced-validation.jsonl`, `card-nonforced-test.jsonl`')
  lines.push('- `baseline-summary.json`, `baseline-summary.md`')
  lines.push('')
  lines.push('Всички split файлове съдържат оригиналните редове verbatim (byte-identical копие от input-а, само разпределени по split) — никаква схема не е променена или добавена.')
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
