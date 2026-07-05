/**
 * analyzeHumanMoveMemoryV2.ts
 *
 * Оценява memory-aware human move memory index v2 (построен от
 * buildHumanMoveMemoryIndexV2.ts) върху validation/test split-овете, сравнява
 * го с: first-legal baseline, старата (v1) retrieval index (от вече
 * генерирания card-memory-report.json), card-model-v2 и card-model-v3.
 * Допълнително прави OFFLINE-ONLY hybrid feasibility анализ (без runtime
 * wiring) — при какви support threshold-ове retrieval v2 би бил полезен
 * conservative advisor, и дали е по-полезен единствено за high-confidence
 * clean-hand/preserve-clean-winner/partner-winning случаи.
 *
 * ТОВА НЕ Е runtime интеграция и НЕ имплементира hybrid override policy —
 * чисто offline анализ/report. Не пипа gameplay, matchmaking, economy,
 * client protocol, recorder writer, production bot behavior,
 * pickServerBotPlayCard.ts или localAiCardBeta.ts.
 *
 * Usage:
 *   npm run analyze:human-move-memory-v2   (от server/, след
 *   build:human-move-memory-index-v2 и train:card-model-v2/v3)
 *
 * Exit codes:
 *   0 — анализ завършен успешно
 *   1 — invalid/missing input, privacy нарушение, schema грешка
 *   2 — file system грешка (напр. липсващ index v2)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseJsonlStrict,
  validateCardRecordV2,
  scanAllForbiddenContent,
  buildRecordContextV2,
  buildBucketKey,
  findNeighborsV2,
  scoreCandidatesV2,
  legalCardsLengthBucket,
  trickNumberBucket,
  remainingTrumpCountBucket,
  ownCleanWinnersCountBucket,
  pct,
  emptyGroupStat,
  bumpGroup,
  type CardRecordV2,
  type TrainIndexEntryV2,
  type ContextVectorV2,
  type GroupStat,
} from './humanMoveMemoryV2Shared.js'
import {
  CardModelLoadError,
  loadCardModelFromFile,
  rankLegalCardsWithCardModel,
  type CardModel,
} from '../src/ai/cardModelInference.js'
import type { CardDecisionState } from '../src/ai/cardModelFeatures.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')
const MEMORY_V1_DIR = join(OUTPUT_DIR, 'human-move-memory')
const MEMORY_V2_DIR = join(OUTPUT_DIR, 'human-move-memory-v2')
const MODEL_V2_DIR = join(OUTPUT_DIR, 'models', 'card-model-v2')
const MODEL_V3_DIR = join(OUTPUT_DIR, 'models', 'card-model-v3')

const CARD_PATHS = {
  validation: join(BASELINE_DIR, 'card-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-test.jsonl'),
}
const INDEX_V2_JSON_PATH = join(MEMORY_V2_DIR, 'card-memory-index-v2.json')
const V1_REPORT_JSON_PATH = join(MEMORY_V1_DIR, 'card-memory-report.json')
const MODEL_V2_JSON_PATH = join(MODEL_V2_DIR, 'model.json')
const MODEL_V3_JSON_PATH = join(MODEL_V3_DIR, 'model.json')

const REPORT_JSON_PATH = join(MEMORY_V2_DIR, 'card-memory-v2-report.json')
const REPORT_MD_PATH = join(MEMORY_V2_DIR, 'card-memory-v2-report.md')

// ─── Constants ────────────────────────────────────────────────────────────────

const RETRIEVAL_K = 50
const PRIMARY_HYBRID_CONFIG = { supportThreshold: 0.6, minNeighbors: 15, minAvgSimilarity: 0.5 }
const SENSITIVITY_SUPPORT_THRESHOLDS = [0.5, 0.6, 0.7]
const SENSITIVITY_MIN_NEIGHBORS = [10, 15, 25]
const COVERAGE_MIN_AVG_SIMILARITY = 0.5

function toDecisionState(r: CardRecordV2): CardDecisionState {
  return {
    seat: r.seat,
    ownHand: r.ownHand,
    legalCards: r.legalCards,
    contract: { contract: r.contract.contract, trumpSuit: r.contract.trumpSuit, bidderSeat: r.contract.bidderSeat },
    currentTrick: r.currentTrick,
    currentWinningSeat: r.currentWinningSeat,
    memory: r.memory,
    legalCardsMemoryFeatures: r.legalCardsMemoryFeatures,
  }
}

// ─── Query outcome (retrieval v2) ────────────────────────────────────────────

type QueryOutcomeV2 = {
  isForced: boolean
  isLead: boolean
  gameMode: string
  legalCardsCount: number
  neighborCount: number
  avgSimilarity: number
  hasEnoughEvidence: boolean
  topCandidateId: string | null
  topSupport: number
  secondCandidateId: string | null
  firstLegalId: string
  humanChosenId: string
  retrievalMatchesHuman: boolean
  firstLegalMatchesTopNeighbor: boolean
  trickNumberBucket: string
  remainingTrumpCountBucket: string
  ownCleanWinnersCountBucket: string
  candidateIsCleanWinnerOfChosen: boolean
  shouldPreserveCleanWinnerOfChosen: boolean
  suitExhaustedInvolved: boolean
  partnerCurrentlyWinning: boolean
  opponentCurrentlyWinning: boolean
  record: CardRecordV2
}

function evaluateSplitV2(records: CardRecordV2[], buckets: Map<string, TrainIndexEntryV2[]>): QueryOutcomeV2[] {
  const outcomes: QueryOutcomeV2[] = []
  for (const r of records) {
    const isForced = r.legalCards.length <= 1
    const firstLegalId = r.legalCards[0]!.id
    const commonTags = {
      trickNumberBucket: trickNumberBucket(r.memory.trickNumber),
      remainingTrumpCountBucket: remainingTrumpCountBucket(r.memory.remainingTrumpCount),
      ownCleanWinnersCountBucket: ownCleanWinnersCountBucket(r.memory.ownCleanWinnersCount),
      candidateIsCleanWinnerOfChosen: r.chosenCardMemoryFeatures.candidateIsCleanWinner,
      shouldPreserveCleanWinnerOfChosen: r.chosenCardMemoryFeatures.shouldPreserveCleanWinner,
      suitExhaustedInvolved: r.legalCards.some((c) => r.memory.suitExhaustedExceptOwnCards[c.suit]),
      partnerCurrentlyWinning: r.memory.partnerCurrentlyWinning,
      opponentCurrentlyWinning: r.memory.opponentCurrentlyWinning,
    }

    if (isForced) {
      outcomes.push({
        isForced: true,
        isLead: r.positionInTrick === 0,
        gameMode: r.contract.contract,
        legalCardsCount: r.legalCards.length,
        neighborCount: 0,
        avgSimilarity: 0,
        hasEnoughEvidence: false,
        topCandidateId: firstLegalId,
        topSupport: 0,
        secondCandidateId: null,
        firstLegalId,
        humanChosenId: r.chosenCard.id,
        retrievalMatchesHuman: firstLegalId === r.chosenCard.id,
        firstLegalMatchesTopNeighbor: true,
        ...commonTags,
        record: r,
      })
      continue
    }

    const { gameMode, isLead, ledSuit, context } = buildRecordContextV2(r)
    const bucketKey = buildBucketKey(gameMode, isLead)
    const bucket = buckets.get(bucketKey) ?? []
    const neighbors = findNeighborsV2(context, r.roomKey, bucket, RETRIEVAL_K)
    const avgSimilarity = neighbors.length > 0 ? neighbors.reduce((s, n) => s + n.similarity, 0) / neighbors.length : 0
    const hasEnoughEvidence = neighbors.length >= PRIMARY_HYBRID_CONFIG.minNeighbors && avgSimilarity >= COVERAGE_MIN_AVG_SIMILARITY

    const scored = scoreCandidatesV2(r.legalCards, neighbors, r, gameMode, r.contract.trumpSuit, isLead, ledSuit)
    const top = scored[0] ?? null
    const second = scored[1] ?? null
    const topSupport = top && neighbors.length > 0 ? top.voteCount / neighbors.length : 0

    outcomes.push({
      isForced: false,
      isLead,
      gameMode,
      legalCardsCount: r.legalCards.length,
      neighborCount: neighbors.length,
      avgSimilarity,
      hasEnoughEvidence,
      topCandidateId: top?.card.id ?? null,
      topSupport,
      secondCandidateId: second?.card.id ?? null,
      firstLegalId,
      humanChosenId: r.chosenCard.id,
      retrievalMatchesHuman: top?.card.id === r.chosenCard.id,
      firstLegalMatchesTopNeighbor: top?.card.id === firstLegalId,
      ...commonTags,
      record: r,
    })
  }
  return outcomes
}

function summarizeOutcomesV2(outcomes: QueryOutcomeV2[]) {
  const overall = emptyGroupStat()
  const forced = emptyGroupStat()
  const nonForced = emptyGroupStat()
  const lead = emptyGroupStat()
  const follow = emptyGroupStat()
  const byGameMode: Record<string, GroupStat> = {}
  const byLegalCardsBucket: Record<string, GroupStat> = {}
  const byTrickNumberBucket: Record<string, GroupStat> = {}
  const byRemainingTrumpCountBucket: Record<string, GroupStat> = {}
  const byOwnCleanWinnersCountBucket: Record<string, GroupStat> = {}
  const candidateIsCleanWinnerCases = emptyGroupStat()
  const shouldPreserveCleanWinnerCases = emptyGroupStat()
  const suitExhaustedCases = emptyGroupStat()
  const partnerCurrentlyWinningCases = emptyGroupStat()
  const opponentCurrentlyWinningCases = emptyGroupStat()
  let enoughEvidenceCount = 0
  let notEnoughEvidenceCount = 0
  let neighborCountSum = 0
  let avgSimilaritySum = 0
  let nonForcedTotal = 0

  for (const o of outcomes) {
    bumpGroup(overall, o.retrievalMatchesHuman)
    if (o.isForced) {
      bumpGroup(forced, o.retrievalMatchesHuman)
    } else {
      nonForcedTotal++
      bumpGroup(nonForced, o.retrievalMatchesHuman)
      if (o.isLead) bumpGroup(lead, o.retrievalMatchesHuman)
      else bumpGroup(follow, o.retrievalMatchesHuman)
      if (o.hasEnoughEvidence) enoughEvidenceCount++
      else notEnoughEvidenceCount++
      neighborCountSum += o.neighborCount
      avgSimilaritySum += o.avgSimilarity

      byGameMode[o.gameMode] ??= emptyGroupStat()
      bumpGroup(byGameMode[o.gameMode]!, o.retrievalMatchesHuman)
      const bucket = legalCardsLengthBucket(o.legalCardsCount)
      byLegalCardsBucket[bucket] ??= emptyGroupStat()
      bumpGroup(byLegalCardsBucket[bucket]!, o.retrievalMatchesHuman)
      byTrickNumberBucket[o.trickNumberBucket] ??= emptyGroupStat()
      bumpGroup(byTrickNumberBucket[o.trickNumberBucket]!, o.retrievalMatchesHuman)
      byRemainingTrumpCountBucket[o.remainingTrumpCountBucket] ??= emptyGroupStat()
      bumpGroup(byRemainingTrumpCountBucket[o.remainingTrumpCountBucket]!, o.retrievalMatchesHuman)
      byOwnCleanWinnersCountBucket[o.ownCleanWinnersCountBucket] ??= emptyGroupStat()
      bumpGroup(byOwnCleanWinnersCountBucket[o.ownCleanWinnersCountBucket]!, o.retrievalMatchesHuman)

      if (o.candidateIsCleanWinnerOfChosen) bumpGroup(candidateIsCleanWinnerCases, o.retrievalMatchesHuman)
      if (o.shouldPreserveCleanWinnerOfChosen) bumpGroup(shouldPreserveCleanWinnerCases, o.retrievalMatchesHuman)
      if (o.suitExhaustedInvolved) bumpGroup(suitExhaustedCases, o.retrievalMatchesHuman)
      if (o.partnerCurrentlyWinning) bumpGroup(partnerCurrentlyWinningCases, o.retrievalMatchesHuman)
      if (o.opponentCurrentlyWinning) bumpGroup(opponentCurrentlyWinningCases, o.retrievalMatchesHuman)
    }
  }

  return {
    overall, forced, nonForced, lead, follow,
    byGameMode, byLegalCardsBucket, byTrickNumberBucket, byRemainingTrumpCountBucket, byOwnCleanWinnersCountBucket,
    candidateIsCleanWinnerCases, shouldPreserveCleanWinnerCases, suitExhaustedCases,
    partnerCurrentlyWinningCases, opponentCurrentlyWinningCases,
    coverage: {
      enoughEvidenceCount,
      notEnoughEvidenceCount,
      enoughEvidenceRate: nonForcedTotal > 0 ? enoughEvidenceCount / nonForcedTotal : 0,
    },
    avgNeighborCount: nonForcedTotal > 0 ? neighborCountSum / nonForcedTotal : 0,
    avgSimilarity: nonForcedTotal > 0 ? avgSimilaritySum / nonForcedTotal : 0,
  }
}

// ─── Hybrid override policy simulation (offline only) ───────────────────────

type HybridConfig = { supportThreshold: number; minNeighbors: number; minAvgSimilarity: number }
type HybridResult = {
  overrideRate: number
  accuracyWhenOverride: GroupStat
  accuracyWhenNoOverride: GroupStat
  overallAccuracy: GroupStat
}

function simulateHybrid(outcomes: QueryOutcomeV2[], cfg: HybridConfig): HybridResult {
  const overallAcc = emptyGroupStat()
  const overrideAcc = emptyGroupStat()
  const noOverrideAcc = emptyGroupStat()
  let overrideCount = 0
  let nonForcedTotal = 0

  for (const o of outcomes) {
    if (o.isForced) continue
    nonForcedTotal++
    const proxyIsInTop2 = o.firstLegalId === o.topCandidateId || o.firstLegalId === o.secondCandidateId
    const shouldOverride =
      o.topSupport >= cfg.supportThreshold &&
      o.neighborCount >= cfg.minNeighbors &&
      o.avgSimilarity >= cfg.minAvgSimilarity &&
      !proxyIsInTop2

    const predictedId = shouldOverride ? o.topCandidateId : o.firstLegalId
    const correct = predictedId === o.humanChosenId
    bumpGroup(overallAcc, correct)
    if (shouldOverride) {
      overrideCount++
      bumpGroup(overrideAcc, correct)
    } else {
      bumpGroup(noOverrideAcc, correct)
    }
  }

  return {
    overrideRate: nonForcedTotal > 0 ? overrideCount / nonForcedTotal : 0,
    accuracyWhenOverride: overrideAcc,
    accuracyWhenNoOverride: noOverrideAcc,
    overallAccuracy: overallAcc,
  }
}

function firstLegalBaselineNonForced(outcomes: QueryOutcomeV2[]): GroupStat {
  const g = emptyGroupStat()
  for (const o of outcomes) {
    if (o.isForced) continue
    bumpGroup(g, o.firstLegalId === o.humanChosenId)
  }
  return g
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Human Move Memory Index v2 — analysis (локален, read-only)')
  console.log('─────────────────────────────────────────')

  // ─── Зареди index v2 (произведен от build:human-move-memory-index-v2) ──────
  let indexRaw: string
  try {
    indexRaw = await readFile(INDEX_V2_JSON_PATH, 'utf8')
  } catch {
    console.error(`FATAL: липсва index v2: ${INDEX_V2_JSON_PATH}`)
    console.error('Изпълни първо: npm run build:human-move-memory-index-v2')
    process.exit(2)
    return
  }
  const indexJson = JSON.parse(indexRaw) as { entries: TrainIndexEntryV2[]; entryCount: number; bucketCounts: Record<string, number> }
  const buckets = new Map<string, TrainIndexEntryV2[]>()
  for (const entry of indexJson.entries) {
    if (!buckets.has(entry.bucketKey)) buckets.set(entry.bucketKey, [])
    buckets.get(entry.bucketKey)!.push(entry)
  }
  console.log(`Index v2 зареден: ${indexJson.entryCount} entries в ${buckets.size} bucket-а.`)

  // ─── Зареди validation/test split-овете ─────────────────────────────────────
  const splitContents: Record<'validation' | 'test', string> = { validation: '', test: '' }
  const missingSplits: string[] = []
  for (const split of ['validation', 'test'] as const) {
    try {
      splitContents[split] = await readFile(CARD_PATHS[split], 'utf8')
    } catch {
      missingSplits.push(CARD_PATHS[split])
    }
  }
  if (missingSplits.length > 0) {
    console.error('FATAL: липсват необходими card split файлове:')
    for (const f of missingSplits) console.error(`  - ${f}`)
    console.error('\nИзпълни първо: npm run prepare:training-baseline')
    process.exit(2)
    return
  }

  console.log('Валидирам validation/test split-овете...')
  const parsedValidation = parseJsonlStrict<Partial<CardRecordV2>>(splitContents.validation, 'card-validation.jsonl')
  const parsedTest = parseJsonlStrict<Partial<CardRecordV2>>(splitContents.test, 'card-test.jsonl')
  const schemaErrors: string[] = [...parsedValidation.errors, ...parsedTest.errors]
  for (const { record, lineNumber } of parsedValidation.lines) schemaErrors.push(...validateCardRecordV2(record, `card-validation.jsonl:${lineNumber}`))
  for (const { record, lineNumber } of parsedTest.lines) schemaErrors.push(...validateCardRecordV2(record, `card-test.jsonl:${lineNumber}`))
  if (schemaErrors.length > 0) {
    console.error(`\n✗ Открити ${schemaErrors.length} schema грешки — анализ СПРЯН.\n`)
    for (const e of schemaErrors.slice(0, 200)) console.error(`  ${e}`)
    process.exit(1)
    return
  }

  console.log('Privacy/sanitization сканиране на входа...')
  const inputViolations = [
    ...(await scanAllForbiddenContent(CARD_PATHS.validation)),
    ...(await scanAllForbiddenContent(CARD_PATHS.test)),
    ...(await scanAllForbiddenContent(INDEX_V2_JSON_PATH)),
  ]
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — анализ СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const validationRecords = parsedValidation.lines.map((l) => l.record as CardRecordV2)
  const testRecords = parsedTest.lines.map((l) => l.record as CardRecordV2)

  // ─── Retrieval v2 baseline ───────────────────────────────────────────────────
  console.log('Пускам memory-aware retrieval v2 baseline върху validation/test...')
  const validationOutcomes = evaluateSplitV2(validationRecords, buckets)
  const testOutcomes = evaluateSplitV2(testRecords, buckets)
  const validationSummary = summarizeOutcomesV2(validationOutcomes)
  const testSummary = summarizeOutcomesV2(testOutcomes)

  // ─── Hybrid policy simulation (offline) ──────────────────────────────────────
  console.log('Симулирам conservative hybrid override policy (offline, retrieval v2)...')
  const primaryHybridValidation = simulateHybrid(validationOutcomes, PRIMARY_HYBRID_CONFIG)
  const primaryHybridTest = simulateHybrid(testOutcomes, PRIMARY_HYBRID_CONFIG)
  const sensitivitySweep: Array<{ config: HybridConfig; validation: HybridResult; test: HybridResult }> = []
  for (const supportThreshold of SENSITIVITY_SUPPORT_THRESHOLDS) {
    for (const minNeighbors of SENSITIVITY_MIN_NEIGHBORS) {
      const cfg: HybridConfig = { supportThreshold, minNeighbors, minAvgSimilarity: COVERAGE_MIN_AVG_SIMILARITY }
      sensitivitySweep.push({ config: cfg, validation: simulateHybrid(validationOutcomes, cfg), test: simulateHybrid(testOutcomes, cfg) })
    }
  }

  const firstLegalValidation = firstLegalBaselineNonForced(validationOutcomes)
  const firstLegalTest = firstLegalBaselineNonForced(testOutcomes)

  // ─── Стар (v1) retrieval index — от вече генерирания report (не преизчисляваме
  // v1 логиката тук, за да не рискуваме drift спрямо v1 script-а, който остава
  // непроменен) ────────────────────────────────────────────────────────────────
  let oldRetrievalComparison: any = null
  try {
    const v1ReportRaw = await readFile(V1_REPORT_JSON_PATH, 'utf8')
    const v1Report = JSON.parse(v1ReportRaw)
    oldRetrievalComparison = {
      available: true,
      reportPath: V1_REPORT_JSON_PATH,
      validation: v1Report.retrievalBaseline?.validation ?? null,
      test: v1Report.retrievalBaseline?.test ?? null,
      hybridPolicyTest: v1Report.hybridPolicy?.test ?? null,
      note: 'Взето директно от вече генерирания training-output/human-move-memory/card-memory-report.json (v1 script непроменен) — не преизчислено тук.',
    }
  } catch {
    oldRetrievalComparison = {
      available: false,
      note: `Не намерен ${V1_REPORT_JSON_PATH} — изпълни npm run build:human-move-memory-index първо за старата retrieval сравнение.`,
    }
  }

  // ─── card-model-v2 / card-model-v3 сравнение (read-only inference) ─────────
  async function evalCardModel(modelPath: string, records: CardRecordV2[]) {
    const model: CardModel = await loadCardModelFromFile(modelPath)
    const g = emptyGroupStat()
    const leadG = emptyGroupStat()
    const followG = emptyGroupStat()
    let differsFromFirstLegal = 0
    let nonForcedTotal = 0
    for (const r of records) {
      if (r.legalCards.length <= 1) continue
      nonForcedTotal++
      const prediction = rankLegalCardsWithCardModel(model, toDecisionState(r))
      const correct = prediction.selectedCard === r.chosenCard.id
      bumpGroup(g, correct)
      if (r.positionInTrick === 0) bumpGroup(leadG, correct)
      else bumpGroup(followG, correct)
      if (prediction.selectedCard !== r.legalCards[0]!.id) differsFromFirstLegal++
    }
    return {
      modelVersion: model.modelVersion,
      accuracy: g,
      lead: leadG,
      follow: followG,
      differsFromFirstLegalRate: nonForcedTotal > 0 ? differsFromFirstLegal / nonForcedTotal : 0,
    }
  }

  async function loadModelComparison(modelPath: string, label: string) {
    try {
      return {
        available: true,
        validation: await evalCardModel(modelPath, validationRecords),
        test: await evalCardModel(modelPath, testRecords),
      }
    } catch (e) {
      return { available: false, note: e instanceof CardModelLoadError ? e.message : String(e), label }
    }
  }

  console.log('Оценявам card-model-v2/v3 (read-only inference, без retraining)...')
  const cardModelV2Comparison = await loadModelComparison(MODEL_V2_JSON_PATH, 'card-model-v2')
  const cardModelV3Comparison = await loadModelComparison(MODEL_V3_JSON_PATH, 'card-model-v3')

  // ─── Per-record card-model-v3 predictions (за hybrid feasibility сравнение) ──
  let v3ModelForFeasibility: CardModel | null = null
  try {
    v3ModelForFeasibility = await loadCardModelFromFile(MODEL_V3_JSON_PATH)
  } catch {
    v3ModelForFeasibility = null
  }

  function v3PredictionMatches(r: CardRecordV2): boolean | null {
    if (!v3ModelForFeasibility || r.legalCards.length <= 1) return null
    const prediction = rankLegalCardsWithCardModel(v3ModelForFeasibility, toDecisionState(r))
    return prediction.selectedCard === r.chosenCard.id
  }

  // ─── Hybrid feasibility анализ (offline-only, item 7) ───────────────────────
  console.log('Offline hybrid feasibility анализ (retrieval v2 vs card-model-v3, без runtime wiring)...')

  type FeasibilityBucket = {
    total: number
    v2Correct: number
    v3Correct: number
    bothCorrect: number
    onlyV2Correct: number
    onlyV3Correct: number
    bothWrong: number
  }
  function emptyFeasibilityBucket(): FeasibilityBucket {
    return { total: 0, v2Correct: 0, v3Correct: 0, bothCorrect: 0, onlyV2Correct: 0, onlyV3Correct: 0, bothWrong: 0 }
  }
  function bumpFeasibility(b: FeasibilityBucket, v2Correct: boolean, v3Correct: boolean | null): void {
    if (v3Correct === null) return
    b.total++
    if (v2Correct) b.v2Correct++
    if (v3Correct) b.v3Correct++
    if (v2Correct && v3Correct) b.bothCorrect++
    else if (v2Correct && !v3Correct) b.onlyV2Correct++
    else if (!v2Correct && v3Correct) b.onlyV3Correct++
    else b.bothWrong++
  }

  function computeFeasibility(outcomes: QueryOutcomeV2[], cfg: HybridConfig, conservativeOnly: boolean): FeasibilityBucket {
    const bucket = emptyFeasibilityBucket()
    for (const o of outcomes) {
      if (o.isForced) continue
      const meetsEvidence = o.topSupport >= cfg.supportThreshold && o.neighborCount >= cfg.minNeighbors && o.avgSimilarity >= cfg.minAvgSimilarity
      if (!meetsEvidence) continue
      if (conservativeOnly) {
        const isConservativeCase = o.candidateIsCleanWinnerOfChosen || o.shouldPreserveCleanWinnerOfChosen || o.partnerCurrentlyWinning
        if (!isConservativeCase) continue
      }
      const v3Correct = v3PredictionMatches(o.record)
      bumpFeasibility(bucket, o.retrievalMatchesHuman, v3Correct)
    }
    return bucket
  }

  const feasibilitySweep = SENSITIVITY_SUPPORT_THRESHOLDS.map((supportThreshold) => {
    const cfg: HybridConfig = { supportThreshold, minNeighbors: PRIMARY_HYBRID_CONFIG.minNeighbors, minAvgSimilarity: COVERAGE_MIN_AVG_SIMILARITY }
    return {
      supportThreshold,
      allHighConfidence: computeFeasibility(testOutcomes, cfg, false),
      conservativeOnly: computeFeasibility(testOutcomes, cfg, true),
    }
  })

  const primaryFeasibilityAllHighConfidence = computeFeasibility(testOutcomes, PRIMARY_HYBRID_CONFIG, false)
  const primaryFeasibilityConservativeOnly = computeFeasibility(testOutcomes, PRIMARY_HYBRID_CONFIG, true)

  // ─── Representative examples (privacy-safe) ─────────────────────────────────
  const representativeExamples: any[] = []
  for (const [idx, o] of testOutcomes.filter((x) => !x.isForced).slice(0, 60).entries()) {
    if (representativeExamples.length >= 12) break
    if (idx % 5 !== 0) continue
    representativeExamples.push({
      gameMode: o.gameMode,
      isLead: o.isLead,
      neighborCount: o.neighborCount,
      avgSimilarity: Number(o.avgSimilarity.toFixed(3)),
      topSupport: Number(o.topSupport.toFixed(3)),
      retrievalMatchesHuman: o.retrievalMatchesHuman,
      candidateIsCleanWinnerOfChosen: o.candidateIsCleanWinnerOfChosen,
      shouldPreserveCleanWinnerOfChosen: o.shouldPreserveCleanWinnerOfChosen,
      partnerCurrentlyWinning: o.partnerCurrentlyWinning,
      opponentCurrentlyWinning: o.opponentCurrentlyWinning,
      trickNumberBucket: o.trickNumberBucket,
      remainingTrumpCountBucket: o.remainingTrumpCountBucket,
    })
  }

  // ─── Recommendations ─────────────────────────────────────────────────────────
  const recommendations = [
    'Retrieval v2 е offline feasibility experiment — НЕ е готов за runtime wiring в тази задача. ' +
    'Виж hybridFeasibility секцията за преценка дали conservative subset (clean winner/preserve/partner-winning) ' +
    'оправдава бъдещ gated wrapper.',
    'Ако бъдещ hybrid се разработва, приоритизирай conservative subset-а (виж primaryFeasibilityConservativeOnly) ' +
    'пред broad override — по-малък override rate, но по-надежден spot-check срещу card-model-v3.',
    'CONTEXT_WEIGHTS_V2 (в humanMoveMemoryV2Shared.ts) са ръчно избрани, не learned/tuned — sensitivity анализ е ' +
    'направен само за hybrid override threshold-ите (support/minNeighbors), не за самите distance weights.',
    'memoryTag priority list (computeMemoryStrategyTag) е deterministic first-match избор измежду 17 категории — ' +
    'ако бъдещ анализ покаже, че определени категории доминират прекалено (напр. "other" fallback е твърде чест), ' +
    'приоритетният ред заслужава ревизия.',
  ]

  // ─── Assemble report ─────────────────────────────────────────────────────────
  const generatedAt = new Date().toISOString()
  const reportJson = {
    generatedAt,
    inputFiles: {
      indexV2: INDEX_V2_JSON_PATH,
      cardValidation: CARD_PATHS.validation,
      cardTest: CARD_PATHS.test,
      v1Report: oldRetrievalComparison.available ? V1_REPORT_JSON_PATH : null,
      cardModelV2: cardModelV2Comparison.available ? MODEL_V2_JSON_PATH : null,
      cardModelV3: cardModelV3Comparison.available ? MODEL_V3_JSON_PATH : null,
    },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    indexSummary: { entryCount: indexJson.entryCount, bucketCounts: indexJson.bucketCounts, retrievalK: RETRIEVAL_K },
    retrievalV2Baseline: { validation: validationSummary, test: testSummary },
    firstLegalBaseline: { validation: firstLegalValidation, test: firstLegalTest },
    oldRetrievalV1Comparison: oldRetrievalComparison,
    cardModelV2Comparison,
    cardModelV3Comparison,
    hybridPolicyV2: {
      primaryConfig: PRIMARY_HYBRID_CONFIG,
      validation: primaryHybridValidation,
      test: primaryHybridTest,
      sensitivitySweep,
    },
    hybridFeasibility: {
      note: 'OFFLINE-ONLY анализ — НЕ имплементира runtime override policy. Сравнява retrieval v2 top prediction ' +
        'срещу card-model-v3 prediction (само non-forced test decisions), при high-confidence evidence gate ' +
        '(support/neighbors/avgSimilarity threshold-ове) и допълнително restricted до conservative subset ' +
        '(candidateIsCleanWinner ИЛИ shouldPreserveCleanWinner ИЛИ partnerCurrentlyWinning за chosenCard-а).',
      primaryConfig: PRIMARY_HYBRID_CONFIG,
      allHighConfidence: primaryFeasibilityAllHighConfidence,
      conservativeOnly: primaryFeasibilityConservativeOnly,
      sensitivitySweep: feasibilitySweep,
    },
    representativeExamples,
    recommendations,
  }

  await mkdir(MEMORY_V2_DIR, { recursive: true })
  await writeFile(REPORT_JSON_PATH, JSON.stringify(reportJson, null, 2) + '\n', 'utf8')
  await writeFile(REPORT_MD_PATH, renderMarkdown(reportJson), 'utf8')

  console.log('Privacy/sanitization сканиране на generated files...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(REPORT_JSON_PATH)),
    ...(await scanAllForbiddenContent(REPORT_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated files — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Retrieval v2 non-forced — validation: ${pct(validationSummary.nonForced.correct, validationSummary.nonForced.total)}, test: ${pct(testSummary.nonForced.correct, testSummary.nonForced.total)}`)
  console.log(`  Retrieval v2 lead/follow (test): ${pct(testSummary.lead.correct, testSummary.lead.total)} / ${pct(testSummary.follow.correct, testSummary.follow.total)}`)
  console.log(`  Coverage (enough evidence, test): ${pct(testSummary.coverage.enoughEvidenceCount, testSummary.coverage.enoughEvidenceCount + testSummary.coverage.notEnoughEvidenceCount)}`)
  if (oldRetrievalComparison.available && oldRetrievalComparison.test) {
    console.log(`  Retrieval v1 non-forced (test, за сравнение): ${pct(oldRetrievalComparison.test.nonForced.correct, oldRetrievalComparison.test.nonForced.total)}`)
  }
  if (cardModelV3Comparison.available && cardModelV3Comparison.test) {
    console.log(`  card-model-v3 (test, non-forced): ${pct(cardModelV3Comparison.test.accuracy.correct, cardModelV3Comparison.test.accuracy.total)}`)
  }
  console.log(`  First-legal baseline (test, non-forced): ${pct(firstLegalTest.correct, firstLegalTest.total)}`)
  console.log(`  Hybrid feasibility (conservative-only, test): ${primaryFeasibilityConservativeOnly.total} decisions, v2 correct ${pct(primaryFeasibilityConservativeOnly.v2Correct, primaryFeasibilityConservativeOnly.total)}, v3 correct ${pct(primaryFeasibilityConservativeOnly.v3Correct, primaryFeasibilityConservativeOnly.total)}`)
  console.log(`\n✓ Отчет: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет: ${REPORT_JSON_PATH}`)
  console.log('✓ Human move memory v2 анализ завършен успешно.\n')
  process.exit(0)
}

// ─── Markdown rendering ────────────────────────────────────────────────────────

function renderGroupLine(label: string, g: GroupStat): string {
  return `- ${label}: ${g.correct}/${g.total} = ${pct(g.correct, g.total)}`
}

function renderFeasibilityLine(label: string, b: { total: number; v2Correct: number; v3Correct: number; bothCorrect: number; onlyV2Correct: number; onlyV3Correct: number; bothWrong: number }): string {
  return `- ${label}: total=${b.total}, v2=${pct(b.v2Correct, b.total)}, v3=${pct(b.v3Correct, b.total)}, ` +
    `both_correct=${pct(b.bothCorrect, b.total)}, only_v2=${pct(b.onlyV2Correct, b.total)}, only_v3=${pct(b.onlyV3Correct, b.total)}, both_wrong=${pct(b.bothWrong, b.total)}`
}

function renderMarkdown(report: any): string {
  const lines: string[] = []
  lines.push('# Human Move Memory Index v2 (Memory-Aware) — Feasibility Report')
  lines.push('')
  lines.push(`Генериран на: ${report.generatedAt}`)
  lines.push('')
  lines.push(
    '**Local-only, offline feasibility анализ.** Разширява v1 retrieval index-а с memory-aware features ' +
    '(played/remaining cards, clean winners, void suits, currently-winning context). Оценява дали memory-aware ' +
    'retrieval е достатъчно полезен като conservative advisor за бъдещ hybrid bot — НЕ имплементира runtime override ' +
    'policy в тази задача.',
  )
  lines.push('')

  lines.push('## Index summary')
  lines.push(`- Entries: ${report.indexSummary.entryCount}`)
  lines.push(`- Retrieval K: ${report.indexSummary.retrievalK}`)
  lines.push(`- Bucket-и: ${Object.keys(report.indexSummary.bucketCounts).length}`)
  lines.push('')

  lines.push('## Retrieval v2 baseline (memory-aware)')
  for (const split of ['validation', 'test'] as const) {
    const s = report.retrievalV2Baseline[split]
    lines.push(`### ${split}`)
    lines.push(renderGroupLine('Overall', s.overall))
    lines.push(renderGroupLine('Forced', s.forced))
    lines.push(renderGroupLine('Non-forced', s.nonForced))
    lines.push(renderGroupLine('Lead', s.lead))
    lines.push(renderGroupLine('Follow', s.follow))
    lines.push(`- Coverage (enough evidence): ${pct(s.coverage.enoughEvidenceCount, s.coverage.enoughEvidenceCount + s.coverage.notEnoughEvidenceCount)}`)
    lines.push(`- Avg neighbor count: ${s.avgNeighborCount.toFixed(1)}, avg similarity: ${s.avgSimilarity.toFixed(3)}`)
    lines.push('')
    lines.push('По gameMode:')
    for (const [k, v] of Object.entries(s.byGameMode)) lines.push(renderGroupLine(k, v as GroupStat))
    lines.push('')
    lines.push('По legalCards bucket:')
    for (const [k, v] of Object.entries(s.byLegalCardsBucket)) lines.push(renderGroupLine(k, v as GroupStat))
    lines.push('')
    lines.push('По trickNumber bucket:')
    for (const [k, v] of Object.entries(s.byTrickNumberBucket)) lines.push(renderGroupLine(k, v as GroupStat))
    lines.push('')
    lines.push('По remainingTrumpCount bucket:')
    for (const [k, v] of Object.entries(s.byRemainingTrumpCountBucket)) lines.push(renderGroupLine(k, v as GroupStat))
    lines.push('')
    lines.push('По ownCleanWinnersCount bucket:')
    for (const [k, v] of Object.entries(s.byOwnCleanWinnersCountBucket)) lines.push(renderGroupLine(k, v as GroupStat))
    lines.push('')
    lines.push(renderGroupLine('candidateIsCleanWinner(chosen) cases', s.candidateIsCleanWinnerCases))
    lines.push(renderGroupLine('shouldPreserveCleanWinner(chosen) cases', s.shouldPreserveCleanWinnerCases))
    lines.push(renderGroupLine('suitExhaustedExceptOwnCards involved cases', s.suitExhaustedCases))
    lines.push(renderGroupLine('partnerCurrentlyWinning cases', s.partnerCurrentlyWinningCases))
    lines.push(renderGroupLine('opponentCurrentlyWinning cases', s.opponentCurrentlyWinningCases))
    lines.push('')
  }

  lines.push('## Comparison: first-legal / retrieval v1 / retrieval v2 / card-model-v2 / card-model-v3')
  lines.push(`- First-legal baseline (test, non-forced): ${pct(report.firstLegalBaseline.test.correct, report.firstLegalBaseline.test.total)}`)
  if (report.oldRetrievalV1Comparison.available && report.oldRetrievalV1Comparison.test) {
    lines.push(`- Retrieval v1 (test, non-forced): ${pct(report.oldRetrievalV1Comparison.test.nonForced.correct, report.oldRetrievalV1Comparison.test.nonForced.total)}`)
  } else {
    lines.push(`- Retrieval v1: ${report.oldRetrievalV1Comparison.note}`)
  }
  lines.push(`- Retrieval v2 (test, non-forced): ${pct(report.retrievalV2Baseline.test.nonForced.correct, report.retrievalV2Baseline.test.nonForced.total)}`)
  if (report.cardModelV2Comparison.available) {
    lines.push(`- card-model-v2 (test, non-forced): ${pct(report.cardModelV2Comparison.test.accuracy.correct, report.cardModelV2Comparison.test.accuracy.total)}`)
  } else {
    lines.push(`- card-model-v2: ${report.cardModelV2Comparison.note}`)
  }
  if (report.cardModelV3Comparison.available) {
    lines.push(`- card-model-v3 (test, non-forced): ${pct(report.cardModelV3Comparison.test.accuracy.correct, report.cardModelV3Comparison.test.accuracy.total)}`)
  } else {
    lines.push(`- card-model-v3: ${report.cardModelV3Comparison.note}`)
  }
  lines.push('')
  lines.push(
    '**Забележка:** целта НЕ е retrieval v2 да бие card-model-v3 overall — целта е да прецени дали retrieval v2 ' +
    'е полезен conservative advisor за бъдещи hybrid решения (виж hybridFeasibility по-долу).',
  )
  lines.push('')

  lines.push('## Hybrid policy v2 (offline simulation, retrieval v2 самостоятелно)')
  lines.push(`Primary config: support>=${report.hybridPolicyV2.primaryConfig.supportThreshold}, minNeighbors>=${report.hybridPolicyV2.primaryConfig.minNeighbors}, minAvgSimilarity>=${report.hybridPolicyV2.primaryConfig.minAvgSimilarity}`)
  lines.push(`- Override rate (test): ${pct(report.hybridPolicyV2.test.overrideRate * 100, 100)}`)
  lines.push(renderGroupLine('Overall accuracy (test)', report.hybridPolicyV2.test.overallAccuracy))
  lines.push(renderGroupLine('Accuracy when override (test)', report.hybridPolicyV2.test.accuracyWhenOverride))
  lines.push(renderGroupLine('Accuracy when no override (test)', report.hybridPolicyV2.test.accuracyWhenNoOverride))
  lines.push('')

  lines.push('## Hybrid feasibility анализ (retrieval v2 vs card-model-v3, OFFLINE-ONLY)')
  lines.push(report.hybridFeasibility.note)
  lines.push('')
  lines.push(`### Primary config (support>=${report.hybridFeasibility.primaryConfig.supportThreshold})`)
  lines.push(renderFeasibilityLine('Всички high-confidence случаи (test)', report.hybridFeasibility.allHighConfidence))
  lines.push(renderFeasibilityLine('Conservative-only (clean winner/preserve/partner-winning, test)', report.hybridFeasibility.conservativeOnly))
  lines.push('')
  lines.push('### Sensitivity sweep по support threshold')
  for (const s of report.hybridFeasibility.sensitivitySweep) {
    lines.push(`#### support>=${s.supportThreshold}`)
    lines.push(renderFeasibilityLine('all high-confidence', s.allHighConfidence))
    lines.push(renderFeasibilityLine('conservative-only', s.conservativeOnly))
  }
  lines.push('')

  lines.push('## Representative examples (privacy-safe, без roomKey/playerKey/recordingId)')
  for (const ex of report.representativeExamples) {
    lines.push(`- gameMode=${ex.gameMode}, isLead=${ex.isLead}, neighbors=${ex.neighborCount}, avgSim=${ex.avgSimilarity}, topSupport=${ex.topSupport}, ` +
      `retrievalMatchesHuman=${ex.retrievalMatchesHuman}, cleanWinner=${ex.candidateIsCleanWinnerOfChosen}, preserve=${ex.shouldPreserveCleanWinnerOfChosen}, ` +
      `partnerWinning=${ex.partnerCurrentlyWinning}, opponentWinning=${ex.opponentCurrentlyWinning}, trick=${ex.trickNumberBucket}, remainingTrump=${ex.remainingTrumpCountBucket}`)
  }
  lines.push('')

  lines.push('## Препоръки')
  for (const r of report.recommendations) lines.push(`- ${r}`)
  lines.push('')

  return lines.join('\n')
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(2)
})
