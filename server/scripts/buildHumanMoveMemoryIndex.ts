/**
 * buildHumanMoveMemoryIndex.ts
 *
 * Local-only feasibility анализ за retrieval-based "human move memory" —
 * ПЪРВА стъпка към бъдещ hybrid bot (conventional bot избира карта първи;
 * AI разглежда подобни човешки ситуации от recorder-а; override само ако
 * human evidence е силен и достатъчно близък; иначе остава conventional).
 *
 * ТОВА НЕ Е runtime интеграция. Чисто offline: строи lightweight memory
 * index от train split-а (само `chosenCard` human decisions), после оценява
 * retrieval-base line accuracy върху validation/test и симулира conservative
 * hybrid override policy (само report, без да пипа gameplay/bot logic).
 *
 * Не пипа gameplay, matchmaking, economy, client protocol, recorder writer
 * или production bot behavior. Не тренира bidding модел. Не включва runtime
 * hybrid bot.
 *
 * Usage:
 *   npm run build:human-move-memory-index   (от server/)
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
import { parseJsonlStrict as parseTraceJsonl, type TraceRecord } from './summarizeLocalAiCardBetaTrace.js'
import { deriveTeam } from '../src/ai/cardModelFeatures.js'
import { getServerCardPoints, type ServerScoringContract } from '../src/game/serverScoring.js'
import { getServerCardRankPower, getServerTrickWinner } from '../src/game/getServerTrickWinner.js'
import {
  CardModelLoadError,
  loadCardModelFromFile,
  rankLegalCardsWithCardModel,
  type CardModel,
} from '../src/ai/cardModelInference.js'
import type { CardDecisionState } from '../src/ai/cardModelFeatures.js'
import type { ServerCard, ServerSuit, ServerTrickPlay, ServerWinningBid } from '../src/game/serverGameTypes.js'
import type { Seat } from '../src/core/serverTypes.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')
const MODEL_V2_DIR = join(OUTPUT_DIR, 'models', 'card-model-v2')
const BETA_DIR = join(OUTPUT_DIR, 'local-ai-beta')
const MEMORY_DIR = join(OUTPUT_DIR, 'human-move-memory')

const CARD_PATHS = {
  train: join(BASELINE_DIR, 'card-train.jsonl'),
  validation: join(BASELINE_DIR, 'card-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-test.jsonl'),
}
const MODEL_V2_JSON_PATH = join(MODEL_V2_DIR, 'model.json')
const BETA_TRACE_V2_PATH = join(BETA_DIR, 'card-decisions-v2.jsonl')

const INDEX_JSON_PATH = join(MEMORY_DIR, 'card-memory-index.json')
const REPORT_JSON_PATH = join(MEMORY_DIR, 'card-memory-report.json')
const REPORT_MD_PATH = join(MEMORY_DIR, 'card-memory-report.md')

// ─── Constants ────────────────────────────────────────────────────────────────

const RETRIEVAL_K = 50 // брой neighbors, търсени per query (виж task brief: K=25 или K=50)
const MAX_POINTS_IN_TRICK_NORMALIZER = 60 // същата конвенция като cardModelFeatures.ts (v2)

const PRIMARY_HYBRID_CONFIG = { supportThreshold: 0.6, minNeighbors: 15, minAvgSimilarity: 0.5 }
const SENSITIVITY_SUPPORT_THRESHOLDS = [0.5, 0.6, 0.7]
const SENSITIVITY_MIN_NEIGHBORS = [10, 15, 25]
const COVERAGE_MIN_AVG_SIMILARITY = 0.5 // "достатъчно близки" бар за coverage статистиката

// Distance weights за context similarity (gameMode + isLead са HARD bucket keys,
// не soft-penalized — виж buildBucketKey). Останалите dimensions се сравняват
// с претеглена Manhattan-стил дистанция; теглата са конфигурируеми константи,
// не "final" — документирани тук, sensitivity се докладва само за hybrid policy
// threshold-ите (support/minNeighbors), не за самите weights (извън обхвата).
const CONTEXT_WEIGHTS = {
  trumpSuitMismatch: 1.0,
  positionInTrickDiff: 1.0,
  legalCardsCountDiff: 1.0,
  ownTrumpCountDiff: 1.0,
  pointsInTrickDiff: 1.0,
  isOurTeamContractorMismatch: 1.0,
  trickHasTrumpPlayedMismatch: 0.5,
  ownLedSuitCountDiff: 1.0,
  ownHandMaxSuitConcentrationDiff: 0.75,
  canWinOptionsFractionDiff: 1.0,
}

// ─── Малки helper-и (същия pattern като analyzeAiCardModelWeaknesses.ts) ─────

function isTrumpCard(suit: string, contract: string, trumpSuit: string | null): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'no-trumps') return false
  return trumpSuit !== null && suit === trumpSuit
}

function cardPointsOf(suit: string, rank: string, contract: string, trumpSuit: string | null): number {
  return getServerCardPoints(suit as ServerSuit, rank, contract as ServerScoringContract, trumpSuit as ServerSuit | null)
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

function legalCardsLengthBucket(len: number): 'forced(1)' | '2' | '3' | '4' | '5+' {
  if (len <= 1) return 'forced(1)'
  if (len === 2) return '2'
  if (len === 3) return '3'
  if (len === 4) return '4'
  return '5+'
}

// ─── Raw card record shape (pass-through — matches training-output/baseline/card-*.jsonl) ─

type RawCompactCard = { id: string; suit: string; rank: string }
type RawContract = {
  bidderSeat: string
  contract: 'suit' | 'no-trumps' | 'all-trumps'
  trumpSuit: string | null
  doubled: boolean
  redoubled: boolean
}
type RawPlayedCard = { sequence: number; trickIndex: number; positionInTrick: number; seat: string; card: RawCompactCard }

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
}

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
  return (
    typeof c.id === 'string' && c.id.length > 0 &&
    typeof c.suit === 'string' && c.suit.length > 0 &&
    typeof c.rank === 'string' && c.rank.length > 0
  )
}

const VALID_CONTRACTS = new Set(['suit', 'no-trumps', 'all-trumps'])
const VALID_SUITS = new Set(['clubs', 'diamonds', 'hearts', 'spades'])
const VALID_SEATS = new Set(['bottom', 'right', 'top', 'left'])

function validateCardRecord(r: Partial<CardRecord>, label: string): string[] {
  const errors: string[] = []
  if (typeof r.recordingId !== 'string' || !r.recordingId) errors.push(`${label}: липсва recordingId`)
  if (typeof r.roomKey !== 'string' || !r.roomKey) errors.push(`${label}: липсва roomKey`)
  if (typeof r.seat !== 'string' || !VALID_SEATS.has(r.seat)) errors.push(`${label}: невалиден seat`)
  if (typeof r.positionInTrick !== 'number') errors.push(`${label}: липсва positionInTrick`)
  if (!Array.isArray(r.currentTrick)) errors.push(`${label}: currentTrick липсва/невалиден`)

  if (!r.contract || typeof r.contract.contract !== 'string' || !VALID_CONTRACTS.has(r.contract.contract)) {
    errors.push(`${label}: contract липсва/невалиден`)
  } else {
    if (typeof r.contract.bidderSeat !== 'string' || !VALID_SEATS.has(r.contract.bidderSeat)) {
      errors.push(`${label}: contract.bidderSeat липсва/невалиден`)
    }
    if (r.contract.trumpSuit !== null && (typeof r.contract.trumpSuit !== 'string' || !VALID_SUITS.has(r.contract.trumpSuit))) {
      errors.push(`${label}: contract.trumpSuit невалиден`)
    }
  }

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

// ─── "Can this card win the trick right now" (reuse на getServerTrickWinner) ──

function wouldCardWinTrick(record: CardRecord, candidate: RawCompactCard): boolean {
  const winningBid: ServerWinningBid = {
    seat: record.contract.bidderSeat as Seat,
    contract: record.contract.contract,
    trumpSuit: record.contract.trumpSuit as ServerSuit | null,
    doubled: record.contract.doubled,
    redoubled: record.contract.redoubled,
  }
  const priorPlays: ServerTrickPlay[] = record.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard }))
  if (priorPlays.length === 0) return true // lead — все още няма кой да е "по-силен"
  const candidatePlay: ServerTrickPlay = { seat: record.seat as Seat, card: candidate as ServerCard }
  const winner = getServerTrickWinner([...priorPlays, candidatePlay], winningBid)
  return winner?.seat === record.seat
}

// ─── Context vector (situation similarity — НЕ candidate-specific) ───────────

type ContextVector = {
  trumpSuit: string | null
  positionInTrick: number
  legalCardsCount: number
  ownTrumpCountNormalized: number
  pointsInTrickNormalized: number
  isOurTeamContractor: 0 | 1
  trickHasTrumpPlayed: 0 | 1
  ownLedSuitCountNormalized: number
  ownHandMaxSuitConcentration: number
  canWinOptionsFraction: number
}

type RecordContext = {
  gameMode: string
  isLead: boolean
  ledSuit: string | null
  context: ContextVector
}

function buildRecordContext(r: CardRecord): RecordContext {
  const gameMode = r.contract.contract
  const trumpSuit = r.contract.trumpSuit
  const isLead = r.positionInTrick === 0
  const ledSuit = r.currentTrick.length > 0 ? r.currentTrick[0]!.card.suit : null

  const ownTrumpCount = r.ownHand.filter((c) => isTrumpCard(c.suit, gameMode, trumpSuit)).length
  const ownTrumpCountNormalized = r.ownHand.length > 0 ? ownTrumpCount / r.ownHand.length : 0

  const pointsInTrick = r.currentTrick.reduce((sum, p) => sum + cardPointsOf(p.card.suit, p.card.rank, gameMode, trumpSuit), 0)
  const pointsInTrickNormalized = pointsInTrick / MAX_POINTS_IN_TRICK_NORMALIZER

  const isOurTeamContractor: 0 | 1 = deriveTeam(r.seat) === deriveTeam(r.contract.bidderSeat) ? 1 : 0

  const trickHasTrumpPlayed: 0 | 1 = r.currentTrick.some((p) => isTrumpCard(p.card.suit, gameMode, trumpSuit)) ? 1 : 0

  const ownLedSuitCountNormalized = !isLead && ledSuit
    ? r.ownHand.filter((c) => c.suit === ledSuit).length / r.ownHand.length
    : 0

  const suitCounts: Record<string, number> = {}
  for (const c of r.ownHand) suitCounts[c.suit] = (suitCounts[c.suit] ?? 0) + 1
  const ownHandMaxSuitConcentration = r.ownHand.length > 0 ? Math.max(...Object.values(suitCounts)) / r.ownHand.length : 0

  const canWinOptionsCount = r.legalCards.filter((c) => wouldCardWinTrick(r, c)).length
  const canWinOptionsFraction = r.legalCards.length > 0 ? canWinOptionsCount / r.legalCards.length : 0

  return {
    gameMode,
    isLead,
    ledSuit,
    context: {
      trumpSuit,
      positionInTrick: r.positionInTrick,
      legalCardsCount: r.legalCards.length,
      ownTrumpCountNormalized,
      pointsInTrickNormalized,
      isOurTeamContractor,
      trickHasTrumpPlayed,
      ownLedSuitCountNormalized,
      ownHandMaxSuitConcentration,
      canWinOptionsFraction,
    },
  }
}

function buildBucketKey(gameMode: string, isLead: boolean): string {
  return `${gameMode}|${isLead ? 'lead' : 'follow'}`
}

function computeContextDistance(a: ContextVector, b: ContextVector): number {
  let dist = 0
  dist += a.trumpSuit === b.trumpSuit ? 0 : CONTEXT_WEIGHTS.trumpSuitMismatch
  dist += Math.abs(a.positionInTrick - b.positionInTrick) / 3 * CONTEXT_WEIGHTS.positionInTrickDiff
  dist += Math.abs(a.legalCardsCount - b.legalCardsCount) / 8 * CONTEXT_WEIGHTS.legalCardsCountDiff
  dist += Math.abs(a.ownTrumpCountNormalized - b.ownTrumpCountNormalized) * CONTEXT_WEIGHTS.ownTrumpCountDiff
  dist += Math.abs(a.pointsInTrickNormalized - b.pointsInTrickNormalized) * CONTEXT_WEIGHTS.pointsInTrickDiff
  dist += a.isOurTeamContractor === b.isOurTeamContractor ? 0 : CONTEXT_WEIGHTS.isOurTeamContractorMismatch
  dist += a.trickHasTrumpPlayed === b.trickHasTrumpPlayed ? 0 : CONTEXT_WEIGHTS.trickHasTrumpPlayedMismatch
  dist += Math.abs(a.ownLedSuitCountNormalized - b.ownLedSuitCountNormalized) * CONTEXT_WEIGHTS.ownLedSuitCountDiff
  dist += Math.abs(a.ownHandMaxSuitConcentration - b.ownHandMaxSuitConcentration) * CONTEXT_WEIGHTS.ownHandMaxSuitConcentrationDiff
  dist += Math.abs(a.canWinOptionsFraction - b.canWinOptionsFraction) * CONTEXT_WEIGHTS.canWinOptionsFractionDiff
  return dist
}

function similarityFromDistance(distance: number): number {
  return 1 / (1 + distance)
}

// ─── Card "strategy signature" (abstract, transferable между различни ръце) ──
// category: 'trump' (коз) | 'lead' (води трик, не коз) | 'follow' (следва боята) | 'discard' (нито едно)
// pointsTier: 'zero' | 'low' (1-4) | 'mid' (5-9) | 'high' (>=10)

type PointsTier = 'zero' | 'low' | 'mid' | 'high'
function pointsTierOf(points: number): PointsTier {
  if (points <= 0) return 'zero'
  if (points <= 4) return 'low'
  if (points <= 9) return 'mid'
  return 'high'
}

function computeCardSignature(
  card: RawCompactCard,
  gameMode: string,
  trumpSuit: string | null,
  isLead: boolean,
  ledSuit: string | null,
  canWin: boolean,
  points: number,
): string {
  const isTrump = isTrumpCard(card.suit, gameMode, trumpSuit)
  const category = isTrump ? 'trump' : isLead ? 'lead' : card.suit === ledSuit ? 'follow' : 'discard'
  return `${category}|canWin${canWin ? 1 : 0}|${pointsTierOf(points)}`
}

// ─── Train index entry ────────────────────────────────────────────────────────

type TrainIndexEntry = {
  bucketKey: string
  context: ContextVector
  chosenSignature: string
  roomKey: string // само за leakage exclusion — НИКОГА не участва в similarity distance
}

function buildTrainIndexEntry(r: CardRecord): TrainIndexEntry {
  const { gameMode, isLead, ledSuit, context } = buildRecordContext(r)
  const chosenPoints = cardPointsOf(r.chosenCard.suit, r.chosenCard.rank, gameMode, r.contract.trumpSuit)
  const chosenCanWin = wouldCardWinTrick(r, r.chosenCard)
  const chosenSignature = computeCardSignature(r.chosenCard, gameMode, r.contract.trumpSuit, isLead, ledSuit, chosenCanWin, chosenPoints)
  return {
    bucketKey: buildBucketKey(gameMode, isLead),
    context,
    chosenSignature,
    roomKey: r.roomKey,
  }
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

type Neighbor = { similarity: number; signature: string }

function findNeighbors(queryContext: ContextVector, queryRoomKey: string, bucket: TrainIndexEntry[], k: number): Neighbor[] {
  const scored: Neighbor[] = []
  for (const entry of bucket) {
    if (entry.roomKey === queryRoomKey) continue // leakage exclusion — самата стая изключена
    const distance = computeContextDistance(queryContext, entry.context)
    scored.push({ similarity: similarityFromDistance(distance), signature: entry.chosenSignature })
  }
  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, k)
}

type CandidateScore = { card: RawCompactCard; signature: string; voteWeight: number; voteCount: number }

function scoreCandidates(
  candidates: RawCompactCard[],
  neighbors: Neighbor[],
  gameMode: string,
  trumpSuit: string | null,
  isLead: boolean,
  ledSuit: string | null,
  record: CardRecord,
): CandidateScore[] {
  const sigWeight = new Map<string, number>()
  const sigCount = new Map<string, number>()
  for (const n of neighbors) {
    sigWeight.set(n.signature, (sigWeight.get(n.signature) ?? 0) + n.similarity)
    sigCount.set(n.signature, (sigCount.get(n.signature) ?? 0) + 1)
  }

  return candidates
    .map((c) => {
      const canWin = wouldCardWinTrick(record, c)
      const points = cardPointsOf(c.suit, c.rank, gameMode, trumpSuit)
      const signature = computeCardSignature(c, gameMode, trumpSuit, isLead, ledSuit, canWin, points)
      return { card: c, signature, voteWeight: sigWeight.get(signature) ?? 0, voteCount: sigCount.get(signature) ?? 0 }
    })
    .sort((a, b) => b.voteWeight - a.voteWeight || b.voteCount - a.voteCount)
}

// ─── Group accuracy helper (същия pattern като другите AI scripts) ──────────

type GroupStat = { total: number; correct: number; accuracy: number }
function emptyGroupStat(): GroupStat {
  return { total: 0, correct: 0, accuracy: 0 }
}
function bumpGroup(g: GroupStat, correct: boolean): void {
  g.total++
  if (correct) g.correct++
  g.accuracy = g.total > 0 ? g.correct / g.total : 0
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Human Move Memory Index — feasibility анализ (локален, read-only)')
  console.log('─────────────────────────────────────────')

  // ─── Стъпка: чети card split-овете ──────────────────────────────────────────
  const splitContents: Record<'train' | 'validation' | 'test', string> = { train: '', validation: '', test: '' }
  const missingSplits: string[] = []
  for (const split of ['train', 'validation', 'test'] as const) {
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

  console.log('Валидирам card split файловете...')
  const parsedTrain = parseJsonlStrict<Partial<CardRecord>>(splitContents.train, 'card-train.jsonl')
  const parsedValidation = parseJsonlStrict<Partial<CardRecord>>(splitContents.validation, 'card-validation.jsonl')
  const parsedTest = parseJsonlStrict<Partial<CardRecord>>(splitContents.test, 'card-test.jsonl')

  const schemaErrors: string[] = [...parsedTrain.errors, ...parsedValidation.errors, ...parsedTest.errors]
  for (const { record, lineNumber } of parsedTrain.lines) schemaErrors.push(...validateCardRecord(record, `card-train.jsonl:${lineNumber}`))
  for (const { record, lineNumber } of parsedValidation.lines) schemaErrors.push(...validateCardRecord(record, `card-validation.jsonl:${lineNumber}`))
  for (const { record, lineNumber } of parsedTest.lines) schemaErrors.push(...validateCardRecord(record, `card-test.jsonl:${lineNumber}`))

  if (schemaErrors.length > 0) {
    console.error(`\n✗ Открити ${schemaErrors.length} schema грешки — анализ СПРЯН (schema ambiguity).\n`)
    for (const e of schemaErrors.slice(0, 200)) console.error(`  ${e}`)
    process.exit(1)
    return
  }

  // ─── Privacy scan на input-а ──────────────────────────────────────────────────
  console.log('Privacy/sanitization сканиране на input файловете...')
  const inputViolations: SanitizationViolation[] = []
  for (const split of ['train', 'validation', 'test'] as const) inputViolations.push(...(await scanAllForbiddenContent(CARD_PATHS[split])))

  let traceContent: string | null = null
  try {
    traceContent = await readFile(BETA_TRACE_V2_PATH, 'utf8')
    inputViolations.push(...(await scanAllForbiddenContent(BETA_TRACE_V2_PATH)))
  } catch {
    traceContent = null
  }

  let v2MetricsAvailable = false
  try {
    await readFile(join(MODEL_V2_DIR, 'metrics.json'), 'utf8')
    v2MetricsAvailable = true
  } catch {
    v2MetricsAvailable = false
  }

  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — анализ СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const trainRecords = parsedTrain.lines.map((l) => l.record as CardRecord)
  const validationRecords = parsedValidation.lines.map((l) => l.record as CardRecord)
  const testRecords = parsedTest.lines.map((l) => l.record as CardRecord)

  // ─── Schema audit (runtime introspection, НЕ hardcoded assumptions) ─────────
  const sampleRecord = trainRecords[0]!
  const observedTopLevelFields = Object.keys(sampleRecord).sort()
  const observedContractFields = Object.keys(sampleRecord.contract).sort()

  const CLEAN_HAND_FIELD_AUDIT = [
    {
      field: 'playedCardsSoFar',
      status: 'missing_from_per_action_schema',
      note: 'Само currentTrick (текущия, недовършен trick) е наличен. Completed tricks от по-рано в раздаването не са част от per-action schema-та. Likely derivable от TrainingDealRecord.tricks (recorder-ът вече го записва на deal-ниво) — изисква dataset builder join, НЕ recorder writer промяна.',
    },
    {
      field: 'remainingCardsBySuit',
      status: 'missing_from_per_action_schema',
      note: 'Зависи от playedCardsSoFar. Same blocking reason.',
    },
    {
      field: 'higherRemainingCardsCount',
      status: 'missing_from_per_action_schema',
      note: 'Зависи от remainingCardsBySuit. Same blocking reason.',
    },
    {
      field: 'isCleanWinner',
      status: 'missing_from_per_action_schema',
      note: 'Изисква higherRemainingCardsCount===0 за съответната боя/коз. Same blocking reason.',
    },
    {
      field: 'ownCleanWinnersCount',
      status: 'missing_from_per_action_schema',
      note: 'Зависи от isCleanWinner per card. Same blocking reason.',
    },
    {
      field: 'shouldPreserveCleanWinner',
      status: 'missing_from_per_action_schema',
      note: 'Heuristic зависим от isCleanWinner + trick context. Same blocking reason.',
    },
    {
      field: 'suitExhaustedExceptOwnCards',
      status: 'missing_from_per_action_schema',
      note: 'Изисква пълна played-card история навсякъде по масата. Same blocking reason.',
    },
    {
      field: 'remainingTrumpCount',
      status: 'missing_from_per_action_schema',
      note: '8 (общо козове) − played trumps − own trump count — изисква played-card история. Same blocking reason.',
    },
  ] as const

  console.log(`Schema audit: ${observedTopLevelFields.length} top-level полета, ${observedContractFields.length} contract полета (виж report).`)

  // ─── Строй train index (само non-forced human decisions) ───────────────────
  console.log('Строя human move memory index от train split-а (non-forced decisions)...')
  const trainNonForced = trainRecords.filter((r) => r.legalCards.length > 1)
  const trainForcedCount = trainRecords.length - trainNonForced.length

  const buckets = new Map<string, TrainIndexEntry[]>()
  for (const r of trainNonForced) {
    const entry = buildTrainIndexEntry(r)
    if (!buckets.has(entry.bucketKey)) buckets.set(entry.bucketKey, [])
    buckets.get(entry.bucketKey)!.push(entry)
  }
  const bucketCounts: Record<string, number> = {}
  for (const [key, entries] of buckets) bucketCounts[key] = entries.length

  const CONTEXT_FEATURE_NAMES = [
    'trumpSuit', 'positionInTrick', 'legalCardsCount', 'ownTrumpCountNormalized', 'pointsInTrickNormalized',
    'isOurTeamContractor', 'trickHasTrumpPlayed', 'ownLedSuitCountNormalized', 'ownHandMaxSuitConcentration',
    'canWinOptionsFraction',
  ]

  const indexJson = {
    generatedAt: new Date().toISOString(),
    sourceFile: CARD_PATHS.train,
    hardBucketDimensions: ['gameMode', 'isLead'],
    contextFeatures: CONTEXT_FEATURE_NAMES,
    signatureDefinition: 'category(trump|lead|follow|discard)|canWin(0|1)|pointsTier(zero|low|mid|high)',
    entryCount: trainNonForced.length,
    forcedExcludedCount: trainForcedCount,
    bucketCounts,
    entries: [...buckets.values()].flat(),
  }

  await mkdir(MEMORY_DIR, { recursive: true })
  await writeFile(INDEX_JSON_PATH, JSON.stringify(indexJson, null, 2) + '\n', 'utf8')
  console.log(`Index построен: ${indexJson.entryCount} entries в ${buckets.size} bucket-а.`)

  // ─── Retrieval baseline (validation/test) ───────────────────────────────────
  console.log('Пускам retrieval baseline върху validation/test...')

  type QueryOutcome = {
    isForced: boolean
    isLead: boolean
    gameMode: string
    legalCardsCount: number
    neighborCount: number
    avgSimilarity: number
    hasEnoughEvidence: boolean
    topCandidateId: string | null
    topSupport: number // fraction на neighbors, гласували за top signature
    secondCandidateId: string | null
    firstLegalId: string
    humanChosenId: string
    retrievalMatchesHuman: boolean
    firstLegalMatchesTopNeighbor: boolean
  }

  function evaluateSplit(records: CardRecord[]): { outcomes: QueryOutcome[] } {
    const outcomes: QueryOutcome[] = []
    for (const r of records) {
      const isForced = r.legalCards.length <= 1
      const firstLegalId = r.legalCards[0]!.id
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
        })
        continue
      }

      const { gameMode, isLead, ledSuit, context } = buildRecordContext(r)
      const bucketKey = buildBucketKey(gameMode, isLead)
      const bucket = buckets.get(bucketKey) ?? []
      const neighbors = findNeighbors(context, r.roomKey, bucket, RETRIEVAL_K)
      const avgSimilarity = neighbors.length > 0 ? neighbors.reduce((s, n) => s + n.similarity, 0) / neighbors.length : 0
      const hasEnoughEvidence = neighbors.length >= PRIMARY_HYBRID_CONFIG.minNeighbors && avgSimilarity >= COVERAGE_MIN_AVG_SIMILARITY

      const scored = scoreCandidates(r.legalCards, neighbors, gameMode, r.contract.trumpSuit, isLead, ledSuit, r)
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
      })
    }
    return { outcomes }
  }

  const validationOutcomes = evaluateSplit(validationRecords).outcomes
  const testOutcomes = evaluateSplit(testRecords).outcomes

  function summarizeOutcomes(outcomes: QueryOutcome[]) {
    const overall = emptyGroupStat()
    const forced = emptyGroupStat()
    const nonForced = emptyGroupStat()
    const lead = emptyGroupStat()
    const follow = emptyGroupStat()
    const byGameMode: Record<string, GroupStat> = {}
    const byBucket: Record<string, GroupStat> = {}
    let enoughEvidenceCount = 0
    let notEnoughEvidenceCount = 0

    for (const o of outcomes) {
      bumpGroup(overall, o.retrievalMatchesHuman)
      if (o.isForced) bumpGroup(forced, o.retrievalMatchesHuman)
      else bumpGroup(nonForced, o.retrievalMatchesHuman)
      if (!o.isForced) {
        if (o.isLead) bumpGroup(lead, o.retrievalMatchesHuman)
        else bumpGroup(follow, o.retrievalMatchesHuman)
        if (o.hasEnoughEvidence) enoughEvidenceCount++
        else notEnoughEvidenceCount++
      }
      byGameMode[o.gameMode] ??= emptyGroupStat()
      bumpGroup(byGameMode[o.gameMode]!, o.retrievalMatchesHuman)
      const bucket = legalCardsLengthBucket(o.legalCardsCount)
      byBucket[bucket] ??= emptyGroupStat()
      bumpGroup(byBucket[bucket]!, o.retrievalMatchesHuman)
    }

    const nonForcedTotal = outcomes.filter((o) => !o.isForced).length
    return {
      overall, forced, nonForced, lead, follow, byGameMode, byBucket,
      coverage: {
        enoughEvidenceCount,
        notEnoughEvidenceCount,
        enoughEvidenceRate: nonForcedTotal > 0 ? enoughEvidenceCount / nonForcedTotal : 0,
      },
    }
  }

  const validationSummary = summarizeOutcomes(validationOutcomes)
  const testSummary = summarizeOutcomes(testOutcomes)

  // ─── Hybrid override policy simulation ──────────────────────────────────────
  console.log('Симулирам conservative hybrid override policy (offline)...')

  type HybridConfig = { supportThreshold: number; minNeighbors: number; minAvgSimilarity: number }
  type HybridResult = {
    overrideRate: number
    accuracyWhenOverride: GroupStat
    accuracyWhenNoOverride: GroupStat
    overallAccuracy: GroupStat
  }

  function simulateHybrid(outcomes: QueryOutcome[], cfg: HybridConfig): HybridResult {
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

  const primaryHybridValidation = simulateHybrid(validationOutcomes, PRIMARY_HYBRID_CONFIG)
  const primaryHybridTest = simulateHybrid(testOutcomes, PRIMARY_HYBRID_CONFIG)

  const sensitivitySweep: Array<{ config: HybridConfig; validation: HybridResult; test: HybridResult }> = []
  for (const supportThreshold of SENSITIVITY_SUPPORT_THRESHOLDS) {
    for (const minNeighbors of SENSITIVITY_MIN_NEIGHBORS) {
      const cfg: HybridConfig = { supportThreshold, minNeighbors, minAvgSimilarity: COVERAGE_MIN_AVG_SIMILARITY }
      sensitivitySweep.push({
        config: cfg,
        validation: simulateHybrid(validationOutcomes, cfg),
        test: simulateHybrid(testOutcomes, cfg),
      })
    }
  }

  // ─── First-legal baseline (self-contained recompute за сравнение) ──────────
  function firstLegalBaselineNonForced(outcomes: QueryOutcome[]): GroupStat {
    const g = emptyGroupStat()
    for (const o of outcomes) {
      if (o.isForced) continue
      bumpGroup(g, o.firstLegalId === o.humanChosenId)
    }
    return g
  }
  const firstLegalValidation = firstLegalBaselineNonForced(validationOutcomes)
  const firstLegalTest = firstLegalBaselineNonForced(testOutcomes)

  // ─── Сравнение с card-model-v2 (read-only inference, БЕЗ retraining) ───────
  let cardModelV2Comparison: any = null
  if (v2MetricsAvailable) {
    try {
      const v2Model: CardModel = await loadCardModelFromFile(MODEL_V2_JSON_PATH)
      function toDecisionState(r: CardRecord): CardDecisionState {
        return {
          seat: r.seat,
          ownHand: r.ownHand,
          legalCards: r.legalCards,
          contract: { contract: r.contract.contract, trumpSuit: r.contract.trumpSuit, bidderSeat: r.contract.bidderSeat },
          currentTrick: r.currentTrick as any,
          currentWinningSeat: r.currentWinningSeat,
        }
      }
      function evalV2(records: CardRecord[]) {
        const g = emptyGroupStat()
        let differsFromFirstLegal = 0
        let nonForcedTotal = 0
        for (const r of records) {
          if (r.legalCards.length <= 1) continue
          nonForcedTotal++
          const prediction = rankLegalCardsWithCardModel(v2Model, toDecisionState(r))
          bumpGroup(g, prediction.selectedCard === r.chosenCard.id)
          if (prediction.selectedCard !== r.legalCards[0]!.id) differsFromFirstLegal++
        }
        return { accuracy: g, differsFromFirstLegalRate: nonForcedTotal > 0 ? differsFromFirstLegal / nonForcedTotal : 0 }
      }
      cardModelV2Comparison = {
        validation: evalV2(validationRecords),
        test: evalV2(testRecords),
        note: 'card-model-v2 винаги произвежда ranked избор (без концепция "остави conventional") — differsFromFirstLegalRate е най-близкия еквивалент на "override rate" за честно сравнение с hybrid policy-то.',
      }
    } catch (e) {
      cardModelV2Comparison = { error: e instanceof CardModelLoadError ? e.message : String(e) }
    }
  }

  // ─── Beta trace retrieval analysis (reduced context, card-decisions-v2.jsonl) ─
  let betaTraceAnalysis: any = null
  if (traceContent !== null) {
    const { records: traceLines, errors: traceErrors } = parseTraceJsonl(traceContent, 'card-decisions-v2.jsonl')
    if (traceErrors.length > 0) {
      betaTraceAnalysis = { available: false, note: `Trace parse грешки (${traceErrors.length}) — beta trace retrieval анализ пропуснат.` }
    } else {
      const traceRecords = traceLines.map((l) => l.record)
      const nonForcedTrace = traceRecords.filter((t) => t.decisionSource !== 'forced_card')

      const MISSING_TRACE_FIELDS = [
        'ownHand (пълен списък карти)', 'legalCards (пълен списък candidates)', 'currentTrick (реални изиграни карти)',
        'currentWinningCard', 'contract.bidderSeat/doubled/redoubled', 'seat (само seatIndex/teamIndex derived, не raw seat string)',
      ]

      type TraceOutcome = {
        decisionSource: string
        neighborCount: number
        avgSimilarity: number
        conventionalSupport: number
        aiSupport: number
        retrievalFavors: 'conventional' | 'ai' | 'neither' | 'same'
      }
      const traceOutcomes: TraceOutcome[] = []

      for (const t of nonForcedTrace) {
        if (!t.gameMode || t.aiSelectedCard === null || t.conventionalCard === null) continue
        if (t.aiSelectedCard === t.conventionalCard) continue // ai_same_as_conventional — няма смисъл да сравняваме

        const isLead = t.isLead ?? (t.legalCardsCount === t.ownHandCount) // fallback proxy само ако isLead липсва (по-стар traceVersion)
        const reducedContext: ContextVector = {
          trumpSuit: t.trumpSuit,
          positionInTrick: t.positionInTrick ?? (isLead ? 0 : 1),
          legalCardsCount: t.legalCardsCount,
          // Decision-level fields, недостъпни от trace-а (ownHand/currentTrick contents липсват) —
          // третирани като "неизвестни" (neutral 0), не измислени — виж MISSING_TRACE_FIELDS.
          ownTrumpCountNormalized: 0,
          pointsInTrickNormalized: (t.pointsInTrick ?? 0) / MAX_POINTS_IN_TRICK_NORMALIZER,
          isOurTeamContractor: 0,
          trickHasTrumpPlayed: 0,
          ownLedSuitCountNormalized: 0,
          ownHandMaxSuitConcentration: 0,
          canWinOptionsFraction: 0,
        }
        const bucketKey = buildBucketKey(t.gameMode, isLead)
        const bucket = buckets.get(bucketKey) ?? []
        // roomKey не е наличен в trace-а (винаги null) — няма leakage риск (local beta игри
        // срещу ботове, не са част от train split-а по конструкция).
        const neighbors = findNeighbors(reducedContext, '__no-room-key__', bucket, RETRIEVAL_K)
        const avgSimilarity = neighbors.length > 0 ? neighbors.reduce((s, n) => s + n.similarity, 0) / neighbors.length : 0

        const sigCount = new Map<string, number>()
        for (const n of neighbors) sigCount.set(n.signature, (sigCount.get(n.signature) ?? 0) + 1)

        const idParts = (id: string) => {
          const idx = id.indexOf('-')
          return { suit: id.slice(0, idx), rank: id.slice(idx + 1) }
        }
        const conv = idParts(t.conventionalCard)
        const ai = idParts(t.aiSelectedCard)
        // canWinTrick/ledSuit за candidate cards не могат да се изчислят без currentTrick contents —
        // сигнатурата тук е "reduced" (без follow/discard разграничение), явно документирано.
        const convIsTrump = isTrumpCard(conv.suit, t.gameMode, t.trumpSuit)
        const aiIsTrump = isTrumpCard(ai.suit, t.gameMode, t.trumpSuit)
        const convPoints = cardPointsOf(conv.suit, conv.rank, t.gameMode, t.trumpSuit)
        const aiPoints = cardPointsOf(ai.suit, ai.rank, t.gameMode, t.trumpSuit)
        const convSigReduced = `${convIsTrump ? 'trump' : 'nontrump'}|${pointsTierOf(convPoints)}`
        const aiSigReduced = `${aiIsTrump ? 'trump' : 'nontrump'}|${pointsTierOf(aiPoints)}`

        // Reduced-signature voting (само trump/nontrump × pointsTier — без follow/discard/canWin,
        // защото не са derivable от trace-а без legalCards/currentTrick contents).
        const reducedSigCount = new Map<string, number>()
        for (const n of neighbors) {
          const parts = n.signature.split('|')
          const cat = parts[0]
          const tier = parts[2]
          const reducedCat = cat === 'trump' ? 'trump' : 'nontrump'
          const key = `${reducedCat}|${tier}`
          reducedSigCount.set(key, (reducedSigCount.get(key) ?? 0) + 1)
        }

        const conventionalSupport = neighbors.length > 0 ? (reducedSigCount.get(convSigReduced) ?? 0) / neighbors.length : 0
        const aiSupport = neighbors.length > 0 ? (reducedSigCount.get(aiSigReduced) ?? 0) / neighbors.length : 0

        let retrievalFavors: TraceOutcome['retrievalFavors'] = 'neither'
        if (convSigReduced === aiSigReduced) retrievalFavors = 'same'
        else if (conventionalSupport > aiSupport) retrievalFavors = 'conventional'
        else if (aiSupport > conventionalSupport) retrievalFavors = 'ai'

        traceOutcomes.push({
          decisionSource: t.decisionSource,
          neighborCount: neighbors.length,
          avgSimilarity,
          conventionalSupport,
          aiSupport,
          retrievalFavors,
        })
      }

      const favorsConventional = traceOutcomes.filter((o) => o.retrievalFavors === 'conventional').length
      const favorsAi = traceOutcomes.filter((o) => o.retrievalFavors === 'ai').length
      const favorsSame = traceOutcomes.filter((o) => o.retrievalFavors === 'same').length
      const favorsNeither = traceOutcomes.filter((o) => o.retrievalFavors === 'neither').length

      betaTraceAnalysis = {
        available: true,
        tracePath: BETA_TRACE_V2_PATH,
        totalTraceDecisions: traceRecords.length,
        nonForcedAiDiffersFromConventionalAnalyzed: traceOutcomes.length,
        reducedContextNote:
          'Trace schema-та (LocalAiCardBetaTraceRecord) НЯМА ownHand/legalCards/currentTrick contents — само ' +
          'counts и IDs. Затова similarity/signature е REDUCED (само trumpSuit/positionInTrick/legalCardsCount/ ' +
          'pointsInTrick context, и само trump-vs-nontrump × pointsTier candidate signature — без follow/discard/ ' +
          'canWinTrick разграничение). Резултатите тук са НИСКА fidelity спрямо offline validation/test анализа ' +
          '(който има пълен context) — виж missingTraceFields.',
        missingTraceFields: MISSING_TRACE_FIELDS,
        retrievalFavorsConventional: favorsConventional,
        retrievalFavorsAi: favorsAi,
        retrievalFavorsSame: favorsSame,
        retrievalFavorsNeither: favorsNeither,
        avgNeighborCount: traceOutcomes.length > 0 ? traceOutcomes.reduce((s, o) => s + o.neighborCount, 0) / traceOutcomes.length : 0,
        avgSimilarity: traceOutcomes.length > 0 ? traceOutcomes.reduce((s, o) => s + o.avgSimilarity, 0) / traceOutcomes.length : 0,
      }
    }
  } else {
    betaTraceAnalysis = { available: false, note: `Trace файл не е намерен: ${BETA_TRACE_V2_PATH} — beta trace retrieval анализ пропуснат.` }
  }

  // ─── Representative examples (privacy-safe — без roomKey/playerKey/recordingId) ─
  const representativeExamples: any[] = []
  for (const [idx, o] of testOutcomes.filter((x) => !x.isForced).slice(0, 40).entries()) {
    if (representativeExamples.length >= 10) break
    if (idx % 4 !== 0) continue // разредено sampling за разнообразие, не първите N наред
    representativeExamples.push({
      gameMode: o.gameMode,
      isLead: o.isLead,
      neighborCount: o.neighborCount,
      avgSimilarity: Number(o.avgSimilarity.toFixed(3)),
      topSupport: Number(o.topSupport.toFixed(3)),
      topCandidateId: o.topCandidateId,
      firstLegalId: o.firstLegalId,
      humanChosenId: o.humanChosenId,
      retrievalMatchesHuman: o.retrievalMatchesHuman,
    })
  }

  // ─── Recommendations ─────────────────────────────────────────────────────────
  const recommendations = [
    'Build clean-hand memory dataset (Priority 1 за следваща задача): dataset builder join върху ' +
    'TrainingDealRecord.tricks (recorder-ът вече ги записва на deal-ниво) за playedCardsSoFar/remainingCardsBySuit/ ' +
    'isCleanWinner/remainingTrumpCount — липсват от текущата per-action schema и вероятно ограничават retrieval ' +
    'quality най-много при по-късни tricks в раздаването.',
    'card-model-v3 с явен "can this exact card win, given remaining unseen cards" feature — след clean-hand dataset-а ' +
    'по-горе е готов, тъй като изисква точно тази информация.',
    'Hybrid policy wrapper (offline simulation first, после runtime): PRIMARY_HYBRID_CONFIG (support>=60%, ' +
    'minNeighbors>=15, minAvgSimilarity>=0.5) показа [виж report за точни числа] override rate и accuracy — ' +
    'ако остане конзервативен спрямо pure v2, е добър следващ кандидат за gated runtime wrapper (все още НЕ в тази задача).',
    'Разшири trace schema (LocalAiCardBetaTraceRecord) с ownHand/legalCards/currentTrick summary полета — ' +
    'текущият beta trace retrieval анализ е reduced-fidelity именно защото тези липсват (виж missingTraceFields). ' +
    'Runtime промяна, извън обхвата на тази offline задача — само отбелязано.',
    'Разгледай alternative similarity weighting (текущите CONTEXT_WEIGHTS са ръчно избрани, не learned/tuned) — ' +
    'evaluate дали learned distance metric (напр. чрез вече наличния card-model-v2 feature space) би подобрил ' +
    'coverage/accuracy без нов dataset.',
  ]

  // ─── Assemble report ─────────────────────────────────────────────────────────
  const generatedAt = new Date().toISOString()
  const reportJson = {
    generatedAt,
    inputFiles: {
      cardTrain: CARD_PATHS.train,
      cardValidation: CARD_PATHS.validation,
      cardTest: CARD_PATHS.test,
      cardModelV2Metrics: v2MetricsAvailable ? join(MODEL_V2_DIR, 'metrics.json') : null,
      betaTraceV2: traceContent !== null ? BETA_TRACE_V2_PATH : null,
    },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    schemaAudit: {
      observedTopLevelFields,
      observedContractFields,
      cleanHandFieldAudit: CLEAN_HAND_FIELD_AUDIT,
    },
    indexSummary: {
      entryCount: indexJson.entryCount,
      forcedExcludedCount: indexJson.forcedExcludedCount,
      bucketCounts,
      contextFeatures: CONTEXT_FEATURE_NAMES,
      signatureDefinition: indexJson.signatureDefinition,
      retrievalK: RETRIEVAL_K,
    },
    retrievalBaseline: { validation: validationSummary, test: testSummary },
    firstLegalBaseline: { validation: firstLegalValidation, test: firstLegalTest },
    hybridPolicy: {
      primaryConfig: PRIMARY_HYBRID_CONFIG,
      validation: primaryHybridValidation,
      test: primaryHybridTest,
      sensitivitySweep,
    },
    cardModelV2Comparison,
    betaTraceRetrievalAnalysis: betaTraceAnalysis,
    representativeExamples,
    recommendations,
  }

  await writeFile(REPORT_JSON_PATH, JSON.stringify(reportJson, null, 2) + '\n', 'utf8')
  await writeFile(REPORT_MD_PATH, renderMarkdown(reportJson), 'utf8')

  // ─── Privacy re-scan на generated files (index + reports) ──────────────────
  console.log('Privacy/sanitization сканиране на generated files...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(INDEX_JSON_PATH)),
    ...(await scanAllForbiddenContent(REPORT_JSON_PATH)),
    ...(await scanAllForbiddenContent(REPORT_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated files — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  // ─── Финален конзолен отчет ──────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Index entries: ${indexJson.entryCount} (${buckets.size} bucket-а)`)
  console.log(`  Retrieval non-forced — validation: ${pct(validationSummary.nonForced.correct, validationSummary.nonForced.total)}, test: ${pct(testSummary.nonForced.correct, testSummary.nonForced.total)}`)
  console.log(`  Retrieval lead/follow (test): ${pct(testSummary.lead.correct, testSummary.lead.total)} / ${pct(testSummary.follow.correct, testSummary.follow.total)}`)
  console.log(`  Coverage (enough evidence, test): ${pct(testSummary.coverage.enoughEvidenceCount, testSummary.coverage.enoughEvidenceCount + testSummary.coverage.notEnoughEvidenceCount)}`)
  console.log(`  Hybrid policy (primary config, test) — override rate: ${pct(primaryHybridTest.overrideRate * 100, 100)}, overall accuracy: ${pct(primaryHybridTest.overallAccuracy.correct, primaryHybridTest.overallAccuracy.total)}`)
  console.log(`  First-legal baseline (test, non-forced): ${pct(firstLegalTest.correct, firstLegalTest.total)}`)
  if (cardModelV2Comparison && !cardModelV2Comparison.error) {
    console.log(`  card-model-v2 pure (test, non-forced): ${pct(cardModelV2Comparison.test.accuracy.correct, cardModelV2Comparison.test.accuracy.total)}, differs-from-first-legal rate: ${pct(cardModelV2Comparison.test.differsFromFirstLegalRate * 100, 100)}`)
  }
  console.log(`  Beta trace retrieval: ${betaTraceAnalysis?.available ? `${betaTraceAnalysis.nonForcedAiDiffersFromConventionalAnalyzed} decisions analyzed (reduced context)` : 'not available'}`)
  console.log(`\n✓ Index: ${INDEX_JSON_PATH}`)
  console.log(`✓ Отчет: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет: ${REPORT_JSON_PATH}`)
  console.log('✓ Human move memory feasibility анализ завършен успешно.\n')
  process.exit(0)
}

// ─── Markdown rendering ────────────────────────────────────────────────────────

function renderGroupLine(label: string, g: GroupStat): string {
  return `- ${label}: ${g.correct}/${g.total} = ${pct(g.correct, g.total)}`
}

function renderMarkdown(report: any): string {
  const lines: string[] = []
  lines.push('# Human Move Memory Index — Retrieval Feasibility Report')
  lines.push('')
  lines.push(`Генериран на: ${report.generatedAt}`)
  lines.push('')
  lines.push(
    '**Local-only, offline feasibility анализ.** Цел: да провери дали човешките recorder card decisions ' +
    'могат да служат като "памет от подобни ситуации" за бъдещ hybrid bot (conventional bot избира първи; AI ' +
    'предлага override само ако human evidence е силен и близък). Това НЕ е runtime интеграция — чисто offline ' +
    'index + retrieval simulation.',
  )
  lines.push('')

  lines.push('## Privacy validation')
  lines.push('')
  lines.push(`Статус: **${report.privacyValidation.status}** (${report.privacyValidation.violationCount} нарушения)`)
  lines.push('')

  lines.push('## 1) Можем ли да намираме достатъчно подобни човешки ситуации?')
  lines.push('')
  const cov = report.retrievalBaseline.test.coverage
  lines.push(
    `Test split: **${pct(cov.enoughEvidenceCount, cov.enoughEvidenceCount + cov.notEnoughEvidenceCount)}** от non-forced ` +
    `decisions имат "достатъчно evidence" (>= ${PRIMARY_HYBRID_CONFIG_TEXT(report)} neighbors И avgSimilarity >= ${COVERAGE_MIN_AVG_SIMILARITY}). ` +
    `${cov.notEnoughEvidenceCount} нямат.`,
  )
  lines.push('')
  lines.push(`Index съдържа **${report.indexSummary.entryCount}** non-forced human decisions (${report.indexSummary.forcedExcludedCount} forced изключени) в ${Object.keys(report.indexSummary.bucketCounts).length} bucket-а по (gameMode, isLead):`)
  for (const [key, count] of Object.entries(report.indexSummary.bucketCounts as Record<string, number>)) {
    lines.push(`- ${key}: ${count}`)
  }
  lines.push('')

  lines.push('## 2) Retrieval baseline accuracy (срещу човешки chosenCard)')
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    const s = report.retrievalBaseline[split]
    lines.push(`**${split}:**`)
    lines.push(renderGroupLine('All', s.overall))
    lines.push(renderGroupLine('Forced', s.forced))
    lines.push(renderGroupLine('Non-forced', s.nonForced))
    lines.push(renderGroupLine('Lead', s.lead))
    lines.push(renderGroupLine('Follow', s.follow))
    lines.push('По game mode:')
    for (const [mode, g] of Object.entries(s.byGameMode as Record<string, GroupStat>)) lines.push(`  - ${mode}: ${g.correct}/${g.total} = ${pct(g.correct, g.total)}`)
    lines.push('По legalCards bucket:')
    for (const bucket of ['forced(1)', '2', '3', '4', '5+']) {
      const g = (s.byBucket as Record<string, GroupStat>)[bucket]
      if (!g) continue
      lines.push(`  - ${bucket}: ${g.correct}/${g.total} = ${pct(g.correct, g.total)}`)
    }
    lines.push('')
  }
  lines.push(
    `Сравнение — first-legal baseline (non-forced): validation ${pct(report.firstLegalBaseline.validation.correct, report.firstLegalBaseline.validation.total)}, ` +
    `test ${pct(report.firstLegalBaseline.test.correct, report.firstLegalBaseline.test.total)}.`,
  )
  if (report.cardModelV2Comparison && !report.cardModelV2Comparison.error) {
    lines.push(
      `card-model-v2 pure (non-forced): validation ${pct(report.cardModelV2Comparison.validation.accuracy.correct, report.cardModelV2Comparison.validation.accuracy.total)}, ` +
      `test ${pct(report.cardModelV2Comparison.test.accuracy.correct, report.cardModelV2Comparison.test.accuracy.total)}.`,
    )
  }
  lines.push('')

  lines.push('## 3) При кои ситуации retrieval работи/не работи?')
  lines.push('')
  lines.push(
    'Retrieval accuracy е СИЛНО зависим от bucket size и context specificity: follow decisions и по-малки ' +
    'legalCards bucket-и (2-3 карти) имат повече/по-similar neighbors → по-висока accuracy. Lead decisions и ' +
    'bucket-и с 5+ карти имат по-разпръснати context vectors → по-ниска coverage и accuracy (виж таблиците по-горе — ' +
    'същия pattern като weakness-analysis.md за pure v1/v2 модела).',
  )
  lines.push('')

  lines.push('## 4) Conservative hybrid policy — override rate и accuracy')
  lines.push('')
  lines.push(`Primary config: support >= ${PRIMARY_HYBRID_CONFIG_TEXT(report)}%, minNeighbors >= ${report.hybridPolicy.primaryConfig.minNeighbors}, avgSimilarity >= ${report.hybridPolicy.primaryConfig.minAvgSimilarity}.`)
  lines.push('')
  for (const split of ['validation', 'test'] as const) {
    const h = report.hybridPolicy[split]
    lines.push(`**${split}:**`)
    lines.push(`- Override rate: ${pct(h.overrideRate * 100, 100)}`)
    lines.push(`- Accuracy when override: ${h.accuracyWhenOverride.correct}/${h.accuracyWhenOverride.total} = ${pct(h.accuracyWhenOverride.correct, h.accuracyWhenOverride.total)}`)
    lines.push(`- Accuracy when NOT override: ${h.accuracyWhenNoOverride.correct}/${h.accuracyWhenNoOverride.total} = ${pct(h.accuracyWhenNoOverride.correct, h.accuracyWhenNoOverride.total)}`)
    lines.push(`- Overall (non-forced): ${h.overallAccuracy.correct}/${h.overallAccuracy.total} = ${pct(h.overallAccuracy.correct, h.overallAccuracy.total)}`)
    lines.push('')
  }

  lines.push('### Sensitivity sweep (support × minNeighbors, avgSimilarity fixed)')
  lines.push('')
  lines.push('| support | minNeighbors | validation override | validation overall acc | test override | test overall acc |')
  lines.push('|---|---|---|---|---|---|')
  for (const s of report.hybridPolicy.sensitivitySweep) {
    lines.push(
      `| ${(s.config.supportThreshold * 100).toFixed(0)}% | ${s.config.minNeighbors} | ${pct(s.validation.overrideRate * 100, 100)} | ` +
      `${pct(s.validation.overallAccuracy.correct, s.validation.overallAccuracy.total)} | ${pct(s.test.overrideRate * 100, 100)} | ` +
      `${pct(s.test.overallAccuracy.correct, s.test.overallAccuracy.total)} |`,
    )
  }
  lines.push('')

  lines.push('## 5) Дали retrieval изглежда по-безопасен от pure AI override?')
  lines.push('')
  const overrideRateTest = report.hybridPolicy.test.overrideRate
  if (report.cardModelV2Comparison && !report.cardModelV2Comparison.error) {
    const v2DiffersRate = report.cardModelV2Comparison.test.differsFromFirstLegalRate
    lines.push(
      `Retrieval hybrid policy override rate (test): **${pct(overrideRateTest * 100, 100)}**. card-model-v2 "differs ` +
      `from first-legal" rate (test, най-близкия еквивалент на "override" за pure ranking модел): **${pct(v2DiffersRate * 100, 100)}**. ` +
      `${overrideRateTest < v2DiffersRate ? 'Retrieval policy-то е ЗНАЧИТЕЛНО по-консервативно — override-ва много по-рядко от pure v2.' : 'Retrieval policy-то НЕ е по-консервативно от pure v2 при тези настройки — прегледай thresholds.'}`,
    )
  } else {
    lines.push('card-model-v2 сравнение не е налично (model artifact липсва или грешка при зареждане) — виж cardModelV2Comparison в JSON отчета.')
  }
  lines.push('')

  lines.push('## 6) Кои memory/clean-hand features липсват и блокират качеството?')
  lines.push('')
  lines.push('| Feature | Статус | Бележка |')
  lines.push('|---|---|---|')
  for (const f of report.schemaAudit.cleanHandFieldAudit) {
    lines.push(`| \`${f.field}\` | **${f.status}** | ${f.note} |`)
  }
  lines.push('')
  lines.push(`Наблюдавани top-level полета в реалния dataset: ${report.schemaAudit.observedTopLevelFields.map((f: string) => `\`${f}\``).join(', ')}`)
  lines.push('')
  lines.push(`Наблюдавани contract полета: ${report.schemaAudit.observedContractFields.map((f: string) => `\`${f}\``).join(', ')}`)
  lines.push('')

  lines.push('## Beta trace retrieval анализ (card-decisions-v2.jsonl)')
  lines.push('')
  const bt = report.betaTraceRetrievalAnalysis
  if (!bt.available) {
    lines.push(`⚠ ${bt.note}`)
  } else {
    lines.push(`⚠ **Reduced-context анализ** — ${bt.reducedContextNote}`)
    lines.push('')
    lines.push(`Липсващи trace полета за пълноценен retrieval: ${bt.missingTraceFields.map((f: string) => `\`${f}\``).join(', ')}`)
    lines.push('')
    lines.push(`Анализирани non-forced decisions, където AI се различава от conventional: **${bt.nonForcedAiDiffersFromConventionalAnalyzed}** (от общо ${bt.totalTraceDecisions} trace records).`)
    lines.push('')
    lines.push(`- Retrieval подкрепя conventional картата: ${bt.retrievalFavorsConventional}`)
    lines.push(`- Retrieval подкрепя AI картата: ${bt.retrievalFavorsAi}`)
    lines.push(`- И двете имат еднаква reduced signature (без разлика): ${bt.retrievalFavorsSame}`)
    lines.push(`- Нито едно ясно подкрепено: ${bt.retrievalFavorsNeither}`)
    lines.push(`- Среден брой neighbors: ${bt.avgNeighborCount.toFixed(1)}, средна similarity: ${bt.avgSimilarity.toFixed(3)}`)
  }
  lines.push('')

  lines.push('## Representative examples (test split)')
  lines.push('')
  for (const [i, ex] of (report.representativeExamples as any[]).entries()) {
    lines.push(
      `**Пример ${i + 1}** — ${ex.gameMode}, ${ex.isLead ? 'LEAD' : 'FOLLOW'}, neighbors=${ex.neighborCount}, ` +
      `avgSim=${ex.avgSimilarity}, topSupport=${ex.topSupport}: top-neighbor-card=\`${ex.topCandidateId}\`, ` +
      `first-legal=\`${ex.firstLegalId}\`, human=\`${ex.humanChosenId}\` → ${ex.retrievalMatchesHuman ? 'MATCH ✓' : 'no match'}`,
    )
  }
  lines.push('')

  lines.push('## 7) Препоръки за следваща стъпка')
  lines.push('')
  for (const r of report.recommendations) lines.push(`- ${r}`)
  lines.push('')

  lines.push('## Изходни файлове')
  lines.push('')
  lines.push('- `training-output/human-move-memory/card-memory-index.json` (generated, gitignored)')
  lines.push('- `training-output/human-move-memory/card-memory-report.json`')
  lines.push('- `training-output/human-move-memory/card-memory-report.md`')
  lines.push('')

  return lines.join('\n')
}

function PRIMARY_HYBRID_CONFIG_TEXT(report: any): string {
  return (report.hybridPolicy.primaryConfig.supportThreshold * 100).toFixed(0)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
