/**
 * analyzeAiCardModelWeaknesses.ts
 *
 * Local-only, read-only диагностичен инструмент — обяснява ЗАЩО текущият
 * local AI card candidate (card-model-v1) играе слабо в local beta (Milen
 * feedback, 2026-07-04), БЕЗ да тренира нов модел и БЕЗ да пипа gameplay,
 * bot strategy, matchmaking, economy, client protocol или recorder writer.
 *
 * Part 1 — анализ на реалния local beta trace
 *   (training-output/local-ai-beta/card-decisions.jsonl + summary.json):
 *   AI vs conventional разлики, safety проверки. Trace-ът НЯМА човешки label
 *   за "добър"/"лош" ход — само показва къде AI се различава от conventional
 *   bot-а, не дали разликата е подобрение (виж disclaimer в отчета).
 *
 * Part 2 — offline error анализ върху validation/test split-овете (тези
 *   ИМАТ човешкия chosenCard label) — пуска съществуващия inference wrapper
 *   (rankLegalCardsWithCardModel) и сравнява с човешкия избор: breakdown по
 *   lead/follow, game mode, legalCards bucket, trump/point поведение, top 20
 *   representative error примера, feature gap audit, приоритизирани
 *   препоръки за card-model-v2 (НЕ имплементирани в тази задача).
 *
 * Usage:
 *   npm run analyze:ai-card-weaknesses   (от server/)
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
  parseJsonlStrict as parseTraceJsonl,
  type TraceRecord,
  type DecisionSource,
} from './summarizeLocalAiCardBetaTrace.js'
import {
  CardModelLoadError,
  loadCardModelFromFile,
  rankLegalCardsWithCardModel,
  type CardModel,
} from '../src/ai/cardModelInference.js'
import type { CardDecisionState, CompactPlayedCard } from '../src/ai/cardModelFeatures.js'
import { getServerCardPoints, type ServerScoringContract } from '../src/game/serverScoring.js'
import { getServerTrickWinner } from '../src/game/getServerTrickWinner.js'
import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerPlayerState,
  ServerSuit,
  ServerTrickPlay,
  ServerWinningBid,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const BASELINE_DIR = join(OUTPUT_DIR, 'baseline')
const MODEL_DIR = join(OUTPUT_DIR, 'models', 'card-model-v1')
const BETA_DIR = join(OUTPUT_DIR, 'local-ai-beta')

const MODEL_JSON_PATH = join(MODEL_DIR, 'model.json')
const CARD_PATHS = {
  validation: join(BASELINE_DIR, 'card-validation.jsonl'),
  test: join(BASELINE_DIR, 'card-test.jsonl'),
}
const TRACE_PATH = join(BETA_DIR, 'card-decisions.jsonl')
const TRACE_SUMMARY_JSON_PATH = join(BETA_DIR, 'summary.json')

const WEAKNESS_JSON_PATH = join(MODEL_DIR, 'weakness-analysis.json')
const WEAKNESS_MD_PATH = join(MODEL_DIR, 'weakness-analysis.md')

// ─── Constants ────────────────────────────────────────────────────────────────

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
// Естествен ranking по face-value (СЪЩАТА подредба като NO_TRUMPS_RANK_POWER в
// getServerTrickWinner.ts) — използва се САМО като общ "high/low" proxy за
// диагностика на lead решения, НЕ представлява реалната trump power подредба
// (където J и 9 са най-силни) — изрично документирано в отчета.
const NATURAL_RANK_POWER: Record<string, number> = { '7': 0, '8': 1, '9': 2, J: 3, Q: 4, K: 5, '10': 6, A: 7 }
const HIGH_POINT_THRESHOLD = 10 // >=10 точки (10/A нетрумф, 10/A/9/J коз) се смята за "high-point" карта в диагностиката

const CURRENT_FEATURES = ['isTrump', 'cardPointsNormalized', 'suitVoidRisk', 'leadershipTimesTrump', 'leadershipTimesPoints']

// ─── Малки helper-и ───────────────────────────────────────────────────────────

function isTrumpCard(suit: string, contract: string, trumpSuit: string | null): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'no-trumps') return false
  return trumpSuit !== null && suit === trumpSuit
}

function cardPointsOf(suit: string, rank: string, contract: string, trumpSuit: string | null): number {
  return getServerCardPoints(suit as ServerSuit, rank, contract as ServerScoringContract, trumpSuit as ServerSuit | null)
}

function legalCardsLengthBucket(len: number): 'forced(1)' | '2' | '3' | '4' | '5+' {
  if (len <= 1) return 'forced(1)'
  if (len === 2) return '2'
  if (len === 3) return '3'
  if (len === 4) return '4'
  return '5+'
}

function parseCardIdParts(id: string): { suit: string; rank: string } {
  const idx = id.indexOf('-')
  if (idx < 0) return { suit: id, rank: '' }
  return { suit: id.slice(0, idx), rank: id.slice(idx + 1) }
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
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

// ─── Card record shape (pass-through — matches training-output/baseline/card-*.jsonl) ─

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
  if (typeof r.trickIndex !== 'number') errors.push(`${label}: липсва trickIndex`)
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

function toDecisionState(r: CardRecord): CardDecisionState {
  return {
    seat: r.seat,
    ownHand: r.ownHand,
    legalCards: r.legalCards,
    contract: { contract: r.contract.contract, trumpSuit: r.contract.trumpSuit },
    currentTrick: r.currentTrick as unknown as CompactPlayedCard[],
    currentWinningSeat: r.currentWinningSeat,
  }
}

// ─── Минимален ServerAuthoritativeGameState (за re-simulation на conventional
// bot-а върху offline records — същият доказан pattern като real-data smoke
// теста в checkLocalAiCardBeta.ts) ─────────────────────────────────────────────

function emptyScore() {
  return { teamA: 0, teamB: 0 }
}

function makePlayers(): Record<Seat, ServerPlayerState> {
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    SEATS.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }]),
  ) as Record<Seat, ServerPlayerState>
}

function emptyWon(): Record<Seat, ServerCard[][]> {
  return { bottom: [], right: [], top: [], left: [] }
}

function buildMinimalState(r: CardRecord): { state: ServerAuthoritativeGameState; seat: Seat } {
  const seat = r.seat as Seat
  const hands: Record<Seat, ServerCard[]> = { bottom: [], right: [], top: [], left: [] }
  hands[seat] = r.ownHand as ServerCard[]
  const winningBid: ServerWinningBid = {
    seat: r.contract.bidderSeat as Seat,
    contract: r.contract.contract,
    trumpSuit: r.contract.trumpSuit as ServerSuit | null,
    doubled: r.contract.doubled,
    redoubled: r.contract.redoubled,
  }
  const plays: ServerTrickPlay[] = r.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard }))
  const es = emptyScore()

  const state: ServerAuthoritativeGameState = {
    phase: 'playing',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: { dealerSeat: r.dealerSeat as Seat, cutterSeat: null, firstBidderSeat: null, firstDealSeat: null, selectedCutIndex: null },
    deck: [],
    hands,
    bidding: { entries: [], currentSeat: null, winningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: es, announce_50: es, announce_100: es, announce_kare: es, announce_belot: es,
    },
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: { leaderSeat: r.leaderSeat as Seat, currentSeat: seat, plays: [], winnerSeat: null, trickIndex: r.trickIndex },
    wonTricks: { A: [], B: [] },
    playing: {
      hasStarted: true,
      currentTurnSeat: seat,
      currentTrick: { leaderSeat: plays[0]?.seat ?? (r.leaderSeat as Seat), currentSeat: seat, plays, winnerSeat: null, trickIndex: r.trickIndex },
      completedTricks: [],
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: emptyWon(),
      wonTricksByTeam: { A: [], B: [] },
    },
    scoring: null,
    matchEnded: null,
    score: { round: { tricks: es, declarations: es, belote: es, lastTen: es, capot: es, total: es }, match: { teamA: 0, teamB: 0 }, carryOver: es },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }

  return { state, seat }
}

function wouldCardWinTrick(r: CardRecord, candidate: RawCompactCard): boolean {
  const winningBid: ServerWinningBid = {
    seat: r.contract.bidderSeat as Seat,
    contract: r.contract.contract,
    trumpSuit: r.contract.trumpSuit as ServerSuit | null,
    doubled: r.contract.doubled,
    redoubled: r.contract.redoubled,
  }
  const priorPlays: ServerTrickPlay[] = r.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard }))
  if (priorPlays.length === 0) return true // lead позиция — все още няма кой да "победи"
  const candidatePlay: ServerTrickPlay = { seat: r.seat as Seat, card: candidate as ServerCard }
  const winner = getServerTrickWinner([...priorPlays, candidatePlay], winningBid)
  return winner?.seat === r.seat
}

// ─── Part 2: offline error анализ (validation/test срещу човешки chosenCard) ─

type GroupStat = { total: number; correct: number; errors: number; accuracy: number }
function emptyGroupStat(): GroupStat {
  return { total: 0, correct: 0, errors: 0, accuracy: 0 }
}
function bumpGroup(g: GroupStat, correct: boolean): void {
  g.total++
  if (correct) g.correct++
  else g.errors++
  g.accuracy = g.total > 0 ? g.correct / g.total : 0
}

type ErrorExample = {
  gameMode: string
  trumpSuit: string | null
  isLead: boolean
  legalCards: RawCompactCard[]
  ownHand: RawCompactCard[]
  humanChosenCard: RawCompactCard
  aiSelectedCard: string
  firstLegalCard: string
  conventionalCard: string | null
  topAiPredictions: Array<{ id: string; score: number; probability: number }>
  diagnostics: string[]
}

type SplitOverall = {
  total: number
  correct: number
  accuracy: number
  forcedTotal: number
  forcedCorrect: number
  forcedAccuracy: number
  nonForcedTotal: number
  nonForcedCorrect: number
  nonForcedAccuracy: number
  totalErrors: number
  nonForcedErrors: number
}

type ErrorPatterns = {
  trumpPredicted: { trump: number; nonTrump: number }
  pointsPredicted: { high: number; low: number }
  aiVsHumanPoints: { aiHigher: number; aiLower: number; aiEqual: number }
  aiTrumpHumanNot: number
  aiAvoidedTrumpHumanUsedTrump: number
  leadHighLowMismatch: { aiHigher: number; aiLower: number; aiEqual: number; applicableCount: number }
  throwPointsWhenHumanLow: { count: number; applicableCount: number }
}

type SplitAnalysis = {
  overall: SplitOverall
  byLeadFollow: { lead: GroupStat; follow: GroupStat }
  byGameMode: Record<string, GroupStat>
  byLegalCardsBucket: Record<string, GroupStat>
  errorPatterns: ErrorPatterns
  errorsForExamples: ErrorExample[]
}

function analyzeSplit(model: CardModel, records: CardRecord[]): SplitAnalysis {
  let total = 0
  let correct = 0
  let forcedTotal = 0
  let forcedCorrect = 0
  let nonForcedTotal = 0
  let nonForcedCorrect = 0

  const byLeadFollow = { lead: emptyGroupStat(), follow: emptyGroupStat() }
  const byGameMode: Record<string, GroupStat> = {}
  const byLegalCardsBucket: Record<string, GroupStat> = {}

  let trumpPredictedTrump = 0
  let trumpPredictedNonTrump = 0
  let pointsPredictedHigh = 0
  let pointsPredictedLow = 0
  let aiHigher = 0
  let aiLower = 0
  let aiEqual = 0
  let aiTrumpHumanNot = 0
  let aiAvoidedTrumpHumanUsed = 0
  let leadHigher = 0
  let leadLower = 0
  let leadEqual = 0
  let leadApplicable = 0
  let throwPointsCount = 0
  let throwPointsApplicable = 0

  const errorsForExamples: ErrorExample[] = []

  for (const r of records) {
    const isLead = r.positionInTrick === 0
    const prediction = rankLegalCardsWithCardModel(model, toDecisionState(r))
    const isCorrect = prediction.selectedCard === r.chosenCard.id

    total++
    if (isCorrect) correct++
    if (r.legalCards.length === 1) {
      forcedTotal++
      if (isCorrect) forcedCorrect++
    } else {
      nonForcedTotal++
      if (isCorrect) nonForcedCorrect++
    }

    const modeKey = r.contract.contract
    ;(byGameMode[modeKey] ??= emptyGroupStat())
    bumpGroup(byGameMode[modeKey]!, isCorrect)

    const bucketKey = legalCardsLengthBucket(r.legalCards.length)
    ;(byLegalCardsBucket[bucketKey] ??= emptyGroupStat())
    bumpGroup(byLegalCardsBucket[bucketKey]!, isCorrect)

    bumpGroup(isLead ? byLeadFollow.lead : byLeadFollow.follow, isCorrect)

    if (r.legalCards.length > 1 && !isCorrect) {
      const aiCardId = prediction.selectedCard
      const aiCard = r.legalCards.find((c) => c.id === aiCardId)!
      const humanCard = r.chosenCard

      const aiIsTrump = isTrumpCard(aiCard.suit, r.contract.contract, r.contract.trumpSuit)
      const humanIsTrump = isTrumpCard(humanCard.suit, r.contract.contract, r.contract.trumpSuit)
      const aiPoints = cardPointsOf(aiCard.suit, aiCard.rank, r.contract.contract, r.contract.trumpSuit)
      const humanPoints = cardPointsOf(humanCard.suit, humanCard.rank, r.contract.contract, r.contract.trumpSuit)

      if (aiIsTrump) trumpPredictedTrump++
      else trumpPredictedNonTrump++
      if (aiPoints >= HIGH_POINT_THRESHOLD) pointsPredictedHigh++
      else pointsPredictedLow++
      if (aiPoints > humanPoints) aiHigher++
      else if (aiPoints < humanPoints) aiLower++
      else aiEqual++
      if (aiIsTrump && !humanIsTrump) aiTrumpHumanNot++
      if (!aiIsTrump && humanIsTrump) aiAvoidedTrumpHumanUsed++

      const diagnostics: string[] = []
      if (aiIsTrump && !humanIsTrump) diagnostics.push('AI used trump while human avoided trump')
      if (!aiIsTrump && humanIsTrump) diagnostics.push('AI avoided trump while human used trump')
      if (aiPoints > humanPoints) diagnostics.push('AI chose a higher-point card than human')
      else if (aiPoints < humanPoints) diagnostics.push('AI chose a lower-point card than human')

      if (isLead) {
        leadApplicable++
        const aiRankPower = NATURAL_RANK_POWER[aiCard.rank] ?? -1
        const humanRankPower = NATURAL_RANK_POWER[humanCard.rank] ?? -1
        if (aiRankPower > humanRankPower) {
          leadHigher++
          diagnostics.push('AI led a higher natural-rank card than human (lead mismatch)')
        } else if (aiRankPower < humanRankPower) {
          leadLower++
          diagnostics.push('AI led a lower natural-rank card than human (lead mismatch)')
        } else {
          leadEqual++
        }
      } else {
        throwPointsApplicable++
        if (humanPoints === 0 && aiPoints > 0) {
          throwPointsCount++
          diagnostics.push('AI threw points into the trick where human discarded a zero-point card')
        }
      }

      const aiCanWin = wouldCardWinTrick(r, aiCard)
      const humanCanWin = wouldCardWinTrick(r, humanCard)
      if (humanCanWin && !aiCanWin) diagnostics.push('Human card could win the trick, AI card could not')
      if (!humanCanWin && aiCanWin) diagnostics.push('AI card could win the trick, human card could not (more aggressive than human)')
      if (diagnostics.length === 0) {
        diagnostics.push('No single dominant factor matched (points/trump/lead-rank/win-potential all similar) — see raw feature values')
      }

      let conventionalCardId: string | null = null
      try {
        const { state, seat } = buildMinimalState(r)
        conventionalCardId = pickServerBotPlayCard(state, seat)?.id ?? null
      } catch {
        conventionalCardId = null
      }

      errorsForExamples.push({
        gameMode: r.contract.contract,
        trumpSuit: r.contract.trumpSuit,
        isLead,
        legalCards: r.legalCards,
        ownHand: r.ownHand,
        humanChosenCard: humanCard,
        aiSelectedCard: aiCardId,
        firstLegalCard: r.legalCards[0]!.id,
        conventionalCard: conventionalCardId,
        topAiPredictions: prediction.ranking.slice(0, 3).map((x) => ({ id: x.id, score: x.score, probability: x.probability })),
        diagnostics,
      })
    }
  }

  return {
    overall: {
      total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      forcedTotal,
      forcedCorrect,
      forcedAccuracy: forcedTotal > 0 ? forcedCorrect / forcedTotal : 0,
      nonForcedTotal,
      nonForcedCorrect,
      nonForcedAccuracy: nonForcedTotal > 0 ? nonForcedCorrect / nonForcedTotal : 0,
      totalErrors: total - correct,
      nonForcedErrors: nonForcedTotal - nonForcedCorrect,
    },
    byLeadFollow,
    byGameMode,
    byLegalCardsBucket,
    errorPatterns: {
      trumpPredicted: { trump: trumpPredictedTrump, nonTrump: trumpPredictedNonTrump },
      pointsPredicted: { high: pointsPredictedHigh, low: pointsPredictedLow },
      aiVsHumanPoints: { aiHigher, aiLower, aiEqual },
      aiTrumpHumanNot,
      aiAvoidedTrumpHumanUsedTrump: aiAvoidedTrumpHumanUsed,
      leadHighLowMismatch: { aiHigher: leadHigher, aiLower: leadLower, aiEqual: leadEqual, applicableCount: leadApplicable },
      throwPointsWhenHumanLow: { count: throwPointsCount, applicableCount: throwPointsApplicable },
    },
    errorsForExamples,
  }
}

function selectRepresentativeExamples(errors: ErrorExample[], count: number): ErrorExample[] {
  const buckets = new Map<string, ErrorExample[]>()
  for (const e of errors) {
    const key = `${e.gameMode}|${e.isLead ? 'lead' : 'follow'}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(e)
  }
  const bucketKeys = [...buckets.keys()]
  const selected: ErrorExample[] = []
  let round = 0
  while (selected.length < count && selected.length < errors.length) {
    let addedInRound = false
    for (const key of bucketKeys) {
      const bucket = buckets.get(key)!
      if (round < bucket.length) {
        selected.push(bucket[round]!)
        addedInRound = true
        if (selected.length >= count) break
      }
    }
    if (!addedInRound) break
    round++
  }
  return selected.slice(0, count)
}

// ─── Part 1: beta trace анализ ────────────────────────────────────────────────

type TraceAnalysis = {
  sourceCounts: Record<DecisionSource, number> & { total: number }
  safety: {
    invalidAiPredictions: number
    invalidFinalCards: number
    fallbackCount: number
    finalCardValidAlwaysTrue: boolean
    aiCardValidConsistent: boolean
    duplicateRankingIdsCount: number
    missingScoreOrProbabilityCount: number
  }
  aiVsConventional: {
    differsCount: number
    sameCount: number
    byLegalCardsCountBucket: Record<string, { differs: number; same: number }>
    byGameMode: Record<string, { differs: number; same: number }>
    leadFollowAvailable: false
    leadFollowNote: string
  }
  cardPreference: {
    pointDelta: { aiHigher: number; aiLower: number; aiEqual: number }
    trumpDelta: { aiTrumpConventionalNot: number; aiNonTrumpConventionalTrump: number; bothTrump: number; neitherTrump: number }
    rankPreferenceCounts: { ai: Record<string, number>; conventional: Record<string, number> }
    topTransitionPairs: Array<{ from: string; to: string; count: number }>
  }
  disclaimer: string
}

function analyzeTrace(records: TraceRecord[]): TraceAnalysis {
  const sourceCounts: Record<DecisionSource, number> = {
    ai_disabled: 0, ai_accepted: 0, ai_same_as_conventional: 0, conventional_fallback: 0, forced_card: 0,
    advisor_override: 0, advisor_no_override: 0, advisor_fallback: 0,
  }
  let invalidAiPredictions = 0
  let invalidFinalCards = 0
  let fallbackCount = 0
  let finalCardValidAlwaysTrue = true
  let aiCardValidConsistent = true
  let duplicateRankingIdsCount = 0
  let missingScoreOrProbabilityCount = 0

  const byLegalCardsCountBucket: Record<string, { differs: number; same: number }> = {}
  const byGameMode: Record<string, { differs: number; same: number }> = {}

  let pointAiHigher = 0
  let pointAiLower = 0
  let pointAiEqual = 0
  let bothTrump = 0
  let neitherTrump = 0
  let aiTrumpConvNot = 0
  let aiNonTrumpConvTrump = 0
  const rankPreferenceAi: Record<string, number> = {}
  const rankPreferenceConventional: Record<string, number> = {}
  const transitionCounts: Record<string, number> = {}

  for (const r of records) {
    sourceCounts[r.decisionSource]++
    if (r.aiCardValid === false) invalidAiPredictions++
    if (!r.finalCardValid) {
      invalidFinalCards++
      finalCardValidAlwaysTrue = false
    }
    if (r.fallbackUsed) fallbackCount++

    if ((r.decisionSource === 'ai_accepted' || r.decisionSource === 'ai_same_as_conventional') && r.aiCardValid !== true) {
      aiCardValidConsistent = false
    }

    const seenIds = new Set<string>()
    for (const p of r.topPredictions) {
      if (seenIds.has(p.id)) duplicateRankingIdsCount++
      seenIds.add(p.id)
      if (!Number.isFinite(p.score) || !Number.isFinite(p.probability)) missingScoreOrProbabilityCount++
    }

    if (r.decisionSource === 'ai_accepted' || r.decisionSource === 'ai_same_as_conventional') {
      const bucket = legalCardsLengthBucket(r.legalCardsCount)
      if (!byLegalCardsCountBucket[bucket]) byLegalCardsCountBucket[bucket] = { differs: 0, same: 0 }
      const modeKey = r.gameMode ?? 'unknown'
      if (!byGameMode[modeKey]) byGameMode[modeKey] = { differs: 0, same: 0 }

      if (r.decisionSource === 'ai_accepted') {
        byLegalCardsCountBucket[bucket]!.differs++
        byGameMode[modeKey]!.differs++
      } else {
        byLegalCardsCountBucket[bucket]!.same++
        byGameMode[modeKey]!.same++
      }

      const aiSelectedCard = r.aiSelectedCard
      const conventionalCard = r.conventionalCard
      const gameMode = r.gameMode
      if (r.decisionSource === 'ai_accepted' && aiSelectedCard && conventionalCard && gameMode) {
        const ai = parseCardIdParts(aiSelectedCard)
        const conv = parseCardIdParts(conventionalCard)
        const aiPoints = cardPointsOf(ai.suit, ai.rank, gameMode, r.trumpSuit)
        const convPoints = cardPointsOf(conv.suit, conv.rank, gameMode, r.trumpSuit)
        if (aiPoints > convPoints) pointAiHigher++
        else if (aiPoints < convPoints) pointAiLower++
        else pointAiEqual++

        const aiIsTrump = isTrumpCard(ai.suit, gameMode, r.trumpSuit)
        const convIsTrump = isTrumpCard(conv.suit, gameMode, r.trumpSuit)
        if (aiIsTrump && convIsTrump) bothTrump++
        else if (!aiIsTrump && !convIsTrump) neitherTrump++
        else if (aiIsTrump && !convIsTrump) aiTrumpConvNot++
        else aiNonTrumpConvTrump++

        rankPreferenceAi[ai.rank] = (rankPreferenceAi[ai.rank] ?? 0) + 1
        rankPreferenceConventional[conv.rank] = (rankPreferenceConventional[conv.rank] ?? 0) + 1

        const transitionKey = `${conv.rank}${convIsTrump ? '(коз)' : ''} → ${ai.rank}${aiIsTrump ? '(коз)' : ''}`
        transitionCounts[transitionKey] = (transitionCounts[transitionKey] ?? 0) + 1
      }
    }
  }

  const topTransitionPairs = Object.entries(transitionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => {
      const [from, to] = key.split(' → ')
      return { from: from ?? key, to: to ?? '', count }
    })

  return {
    sourceCounts: { ...sourceCounts, total: records.length },
    safety: {
      invalidAiPredictions,
      invalidFinalCards,
      fallbackCount,
      finalCardValidAlwaysTrue,
      aiCardValidConsistent,
      duplicateRankingIdsCount,
      missingScoreOrProbabilityCount,
    },
    aiVsConventional: {
      differsCount: sourceCounts.ai_accepted,
      sameCount: sourceCounts.ai_same_as_conventional,
      byLegalCardsCountBucket,
      byGameMode,
      leadFollowAvailable: false,
      leadFollowNote:
        'Trace schema-та (LocalAiCardBetaTraceRecord в server/src/ai/localAiCardBeta.ts) НЕ записва ' +
        'positionInTrick/isLead — само isForced (legalCardsCount<=1). Затова lead/follow breakdown НЕ ' +
        'може да се направи безопасно/коректно от trace-а самостоятелно. Препоръка: добави isLead:boolean ' +
        'към trace record-а в бъдеща итерация (виж Priority 1 в recommendations по-долу).',
    },
    cardPreference: {
      pointDelta: { aiHigher: pointAiHigher, aiLower: pointAiLower, aiEqual: pointAiEqual },
      trumpDelta: { aiTrumpConventionalNot: aiTrumpConvNot, aiNonTrumpConventionalTrump: aiNonTrumpConvTrump, bothTrump, neitherTrump },
      rankPreferenceCounts: { ai: rankPreferenceAi, conventional: rankPreferenceConventional },
      topTransitionPairs,
    },
    disclaimer:
      'Trace-ът записва само какво AI е избрал СПРЯМО какво conventional bot-ът би избрал в реални local ' +
      'beta игри срещу ботове. Той НЯМА човешки label за "добър"/"лош" ход в тези конкретни ситуации — ' +
      'conventional bot-ът сам по себе си не е perfect play, а просто съществуващата heuristic. Затова ' +
      'trace-ът може да покаже КЪДЕ AI се различава от conventional bot-а (честота, категории карти, game ' +
      'modes), но НЕ доказва сам по себе си дали разликата е стратегическо подобрение или влошаване. За ' +
      'реална оценка на качество виж Part 2 (offline error анализ срещу човешки chosenCard label от ' +
      'validation/test split-овете) — там ИМА човешки ground truth.',
  }
}

// ─── Feature gap audit (статична таблица, базирана на реална schema инспекция) ─

type FeatureGapEntry = { field: string; status: 'available' | 'missing' | 'derivable' | 'unsafe_unclear'; note: string }

const FEATURE_GAP_AUDIT: FeatureGapEntry[] = [
  { field: 'gameMode / contract type (suit/all-trumps/no-trumps)', status: 'available', note: 'record.contract.contract — вече използвано (isTrump feature).' },
  { field: 'trumpSuit', status: 'available', note: 'record.contract.trumpSuit — вече използвано (isTrump feature).' },
  { field: 'contract/bid mode (doubled/redoubled)', status: 'available', note: 'record.contract.doubled/redoubled — присъстват в суровия dataset, НЕ се използват в текущия feature set.' },
  { field: 'bidder seat', status: 'available', note: 'record.contract.bidderSeat — присъства в суровия dataset, НЕ се използва в текущия feature set.' },
  { field: 'bidder team / whether own team won the bid', status: 'derivable', note: 'deriveTeam(seat) === deriveTeam(contract.bidderSeat) — едно сравнение върху вече налични полета.' },
  { field: 'seatIndex', status: 'derivable', note: 'Позиция на seat в [bottom,right,top,left] — тривиален lookup.' },
  { field: 'teamIndex', status: 'derivable', note: 'deriveTeam(seat) вече съществува в cardModelFeatures.ts, само не се извежда като отделен numeric feature.' },
  { field: 'partner seat', status: 'derivable', note: 'Фиксирано съответствие bottom↔top, right↔left.' },
  { field: 'trick index / trick number', status: 'available', note: 'record.trickIndex.' },
  { field: 'position in trick', status: 'available', note: 'record.positionInTrick.' },
  { field: 'isLead', status: 'derivable', note: 'positionInTrick === 0.' },
  { field: 'current trick cards', status: 'available', note: 'record.currentTrick (пълни card обекти + seat).' },
  { field: 'current winning card', status: 'available', note: 'record.currentWinningCard — присъства, НЕ се използва директно като feature (само currentWinningSeat влияе, индиректно, през leadership interaction терми).' },
  { field: 'current winning team', status: 'derivable', note: 'deriveTeam(currentWinningSeat), когато currentWinningSeat не е null.' },
  { field: 'led suit', status: 'derivable', note: 'currentTrick[0].card.suit, когато currentTrick е непразен (при lead позиция все още няма led suit).' },
  { field: 'played cards so far (пълна история извън текущия trick)', status: 'available', note: 'ОБНОВЕНО (2026-07-05, "Add Belot card memory dataset features"): вече наличен като memory.playedCardsSoFar/playedCardsBySuit в card-decisions.jsonl — join-нат от dataset builder-а върху deal.tricks по trickIndex, БЕЗ recorder writer промяна (виж server/scripts/trainingDataset/cardMemoryFeatures.ts).' },
  { field: 'remainingCardsBySuit / remainingTrumpCount / ownTrumpCount (validated)', status: 'available', note: 'ОБНОВЕНО: memory.remainingCardsBySuit/remainingTrumpCount/ownTrumpCount вече в card-decisions.jsonl. remainingTrumpCount=0 по конвенция за no-trumps/all-trumps (документирано).' },
  { field: 'voidSuitsBySeat / partnerVoidSuits / opponentVoidSuits (hard fact)', status: 'available', note: 'ОБНОВЕНО: hard-fact void deduction (не следва led suit → void), разширена и върху текущия недовършен trick, вече в memory.voidSuitsBySeat.' },
  { field: 'knownCannotHaveCardsBySeat (overtrump-failure deduction)', status: 'available', note: 'ОБНОВЕНО: hard-fact deduction "длъжен да надцака коз, но не го е направил → изключва по-силните козове", директно изведена от getServerValidPlayCards.ts правилата. Вече в memory.knownCannotHaveCardsBySeat.' },
  { field: 'candidateIsCleanWinner / higherRemainingCardsCount / ownCleanWinnersCount / shouldPreserveCleanWinner', status: 'available', note: 'ОБНОВЕНО: clean-hand detection (guaranteed trick winner, отчитайки remainingTrumpCount за non-trump карти) вече в chosenCardMemoryFeatures/legalCardsMemoryFeatures/memory.ownCleanWinnersCount. shouldPreserveCleanWinner е conservative v1 heuristic, не hard fact (документирано в cardMemoryFeatures.ts).' },
  { field: 'suitExhaustedExceptOwnCards', status: 'available', note: 'ОБНОВЕНО: точно примера на Milen (8 карти в боя, 6 излезли, 2 в own hand → тези 2 са "clean") вече в memory.suitExhaustedExceptOwnCards, validated arithmetically при export.' },
  { field: 'taken tricks so far (брой/точки по отбор, кумулативно за цялата ръка)', status: 'derivable', note: 'trickNumber (брой завършени trick-ове) вече наличен, но per-trick winner/team aggregate (кой отбор колко е взел) НЕ е explicit export-нато поле все още — derivable от същия deal.tricks join с малко допълнителна работа (следваща стъпка, не в тази задача).' },
  { field: 'score context (running точки в текущата ръка, кумулативно)', status: 'derivable', note: 'pointsInTrick вече наличен, но е САМО за ТЕКУЩИЯ trick — кумулативни точки за цялата ръка досега НЕ са explicit export-нато поле (derivable от същия join, следваща стъпка).' },
  { field: 'declarations context (обявени терца/50/100/каре/белот)', status: 'missing', note: 'TrainingDealRecord НЯМА declarations поле изобщо — нито на deal, нито на action ниво. Изисква recorder writer промяна, за да се захване (Priority 4) — единствената истинска Priority 4 находка, непроменена от предишния анализ.' },
  { field: 'capot risk/context', status: 'derivable', note: 'Изисква "taken tricks so far по отбор" по-горе (все още не export-нато) — "0 трика за отбор X след N изиграни трика" би бил тривиално производно от него.' },
  { field: 'own suit lengths', status: 'available', note: 'Вече изчислено за candidate суитата чрез suitVoidRisk (= count(ownHand, suit)/hand.length) — за ДРУГИ суитове е derivable със същата формула, само не се извежда per-suit.' },
  { field: 'own trump count', status: 'available', note: 'ОБНОВЕНО: memory.ownTrumpCount вече explicit export-нато поле (в допълнение на вече derivable статуса от преди).' },
  { field: 'whether candidate card can currently win the trick', status: 'available', note: 'ОБНОВЕНО: chosenCardMemoryFeatures/legalCardsMemoryFeatures вече дават candidateIsCleanWinner (по-силно твърдение от голо canWinTrick — гарантирано печели ВСЯКА бъдеща конфигурация, не само текущия trick). Reuse на getServerTrickWinner-style логика, не дублирана ръчно.' },
  { field: 'whether trick is already partner-winning', status: 'available', note: 'ОБНОВЕНО: memory.partnerCurrentlyWinning вече explicit boolean поле.' },
  { field: 'whether trick is already opponent-winning', status: 'available', note: 'ОБНОВЕНО: memory.opponentCurrentlyWinning вече explicit boolean поле.' },
  { field: 'points currently in trick', status: 'available', note: 'ОБНОВЕНО: memory.pointsInTrick вече explicit export-нато поле (в допълнение на вече derivable статуса от преди).' },
  { field: 'last trick context (кой спечели предходния trick, с какви карти)', status: 'derivable', note: 'completedTricksSoFar се използва ВЪТРЕШНО от dataset builder-а (join върху deal.tricks), но "last trick winner/cards" не е explicit export-нато като отделно поле все още — тривиално derivable от същия join, следваща стъпка.' },
  { field: 'played cards / void tracking на другите играчи (inferred от история)', status: 'available', note: 'ОБНОВЕНО: адресирано directно от voidSuitsBySeat/knownCannotHaveCardsBySeat по-горе — само hard facts (не inference извън наблюдаваната игра), design риска от предишния анализ разрешен чрез стриктно ограничение до "не следва led suit"/"не надцакал при задължение" правила.' },
]

const FEATURE_SUFFICIENCY_ASSESSMENT = {
  leadPlay:
    'При lead (currentWinningSeat===null → trickLeadershipSignal=0), leadershipTimesTrump и leadershipTimesPoints ' +
    'са И ДВЕТЕ нула за всеки candidate (интеракцията изчезва) — остават само голите isTrump (тегло ≈+0.013, ' +
    'почти неутрално) и cardPointsNormalized (тегло ≈-0.037, слабо предпочитание към ниски карти), плюс ' +
    'suitVoidRisk (тегло ≈-0.232, най-силният реален сигнал при lead). Моделът няма own suit strength/length ' +
    'per-suit ranking, own trump count, нито played-card история — не различава "изведи силна боя" от "скрий ' +
    'точки". Това е ИЗМЕРЕНО най-слабото място: lead non-forced accuracy ≈35-37% срещу follow ≈76% (виж evidence).',
  followPlay:
    'При follow, leadershipTimesTrump/leadershipTimesPoints носят реалния сигнал ("хвърли точки на печелившия ' +
    'партньор / скрий точки от печелившия противник") — измеримо работи (follow accuracy ≈76%). Но моделът ' +
    'няма explicit "може ли тази карта да спечели трика точно сега" feature — разчита само на грубия +1/-1/0 ' +
    'leadership сигнал, не на реалната сравнителна сила на конкретната карта спрямо currentWinningCard.',
  trumpContracts:
    'isTrump е коректно дефиниран за suit contract (само trumpSuit съвпада), но липсва own trump count — ' +
    'моделът не знае дали играчът държи 1 или 4 коза, критично за "пести коз за по-късно" срещу "изчерпай ' +
    'противника от козове сега".',
  allTrumps:
    'В all-trumps, isTrump=1 за ВСИЧКИ candidate карти в едно решение (константа) → математически носи ТОЧНО ' +
    'нулев градиент в softmax-over-candidates loss (същата причина, поради която bias/matchesLedSuit бяха ' +
    'премахнати по-рано) — feature-ът е буквално неинформативен тук, освен през leadershipTimesTrump ' +
    'interaction (което пак е константа × trickLeadershipSignal — вариацията идва само от leadership-а, не ' +
    'от самата карта).',
  noTrumps:
    'В no-trumps, isTrump=0 за всички candidates (пак константа) — моделът разчита изцяло на ' +
    'cardPointsNormalized + leadership interactions; няма "най-силна останала карта в тази боя" feature, ' +
    'основният стратегически въпрос в no-trumps follow ситуации.',
  partnerSupportPlay:
    '"Хвърли точки на партньор, ако печели" се моделира ЕДИНСТВЕНО през leadershipTimesPoints (тегло ≈+1.007, ' +
    'доминиращо) — реалният "работещ" сигнал в модела. Но липсва points-currently-in-trick (колко вече е ' +
    'заложено — заслужава ли да се "наддава" с по-висока карта) и own trump count (може ли изобщо да помогне ' +
    'с коз) — моделът поддържа партньора само в посока "играй високи точки", не и по-фини тактики.',
}

// ─── Препоръки за card-model-v2 (НЕ имплементирани в тази задача) ────────────

type Recommendations = {
  methodologicalWarning: string
  priority1: string[]
  priority2: string[]
  priority3: string[]
  priority4: string[]
}

const RECOMMENDATIONS: Recommendations = {
  methodologicalWarning:
    'КРИТИЧНО за card-model-v2 дизайна: в текущата softmax-over-candidates ranking loss архитектура, ВСЕКИ ' +
    'feature, чиято стойност е КОНСТАНТНА за всички legalCards candidates в рамките на ЕДНО решение, ' +
    'математически носи ТОЧНО нулев градиент (доказано и вече наблюдавано емпирично: bias, isLeading, ' +
    'matchesLedSuit, суров trickLeadershipSignal и legalCardsCountNormalized се научиха на ≈1e-18 тегло и ' +
    'бяха премахнати — виж model.json excludedFeaturesNote). Decision-level context (own trump count, bidder ' +
    'team, points-in-trick-so-far, tricks-taken-so-far, declarations и т.н.) НЕ варира между candidate ' +
    'картите в едно решение — ако се добави като гол standalone feature, ще се научи на ≈0 тегло ПАК, ' +
    'повтаряйки същата грешка. Единственият начин decision-level context да влияе е като INTERACTION term, ' +
    'умножен по per-candidate-varying feature (точно както leadershipTimesTrump/leadershipTimesPoints вече ' +
    'правят с trickLeadershipSignal). Всяка препоръка по-долу, отбелязана "(interaction)", трябва да се ' +
    'имплементира по този начин, не като гол additive term.',
  priority1: [
    'canWinTrick (per-candidate, варира!): дали ИМЕННО тази candidate карта би спечелила трика точно сега, ' +
    'изчислено чрез reuse на съществуващия getServerTrickWinner() върху currentTrick+candidate. Данните ' +
    '(currentTrick, contract, trumpSuit) вече са в dataset-а — само нужен нов feature в trainer/inference. ' +
    'Демонстрирано вече в тази диагностика (wouldCardWinTrick).',
    'cardNaturalRankPower (per-candidate, варира): explicit "сила на ранга" feature, независим от точковата ' +
    'стойност (напр. Q има само 3 точки нетрумф, но е 4-ти по сила от 8) — може да помогне при lead решения ' +
    '("изведи най-силната карта в тази боя"), които в момента са най-слабото място на модела.',
    'bidderSeat/doubled/redoubled context (interaction): вече присъстват в суровия dataset, но не се четат ' +
    'изобщо от cardModelFeatures.ts. Като interaction terms (напр. isBidderTeamTimesTrump) могат да добавят ' +
    'нов сигнал без dataset промяна.',
  ],
  priority2: [
    'ownTrumpCount × isTrump (interaction): "имам много/малко козове" модулира решението "спести коз" vs ' +
    '"похарчи коз сега" — derivable от вече наличния ownHand, но е decision-level константа, затова ЗАДЪЛЖИТЕЛНО ' +
    'като interaction term (виж methodologicalWarning).',
    'pointsInTrickSoFar × leadershipTimesPoints (по-богата 3-факторна interaction): колко точки вече са ' +
    'заложени в трика би трябвало да модулира колко агресивно партньорът "хвърля точки" — derivable от ' +
    'currentTrick+contract, но е decision-level константа (виж warning).',
    'bidderTeamWonBid × isTrump (interaction): собственият отбор на обявилия обикновено играе коз по-агресивно ' +
    'от защитниците — derivable от contract.bidderSeat + seat, decision-level константа (виж warning).',
    'Разделяне на модела по gameMode (3 отделни тегловни вектора за suit/all-trumps/no-trumps, или пълна ' +
    'one-hot interaction на gameMode × всеки feature): isTrump в момента е буквално неинформативен за ' +
    'all-trumps/no-trumps (константа 1 или 0) — mode-specific тегла биха освободили capacity за другите ' +
    'features да се държат различно по mode. По-голяма trainer промяна, но без нужда от нови данни.',
  ],
  priority3: [
    'playedCardsSoFar / takenTricksSoFar по отбор: dataset builder-ът може да join-не deal.tricks[] ' +
    '(TrainingDealRecord.tricks, вече записан от recorder-а на deal-ниво) по trickIndex < текущия trickIndex, ' +
    'БЕЗ никаква промяна в recorder writer-а. Разкрива capot risk, running точки, "колко козове вече са ' +
    'излезли от играта" — всичко ключово за follow/lead decisions в по-късните трикове.',
    'lastTrickContext (кой спечели предходния trick, с какви карти/точки): същия Priority 3 join, ' +
    'deal.tricks[trickIndex-1].',
    '(Стреч, unsafe/unclear до design review) opponent void tracking, inferred от played-card история — ' +
    'технически derivable от Priority 3 join-а, но изисква внимателна имплементация да не изтече информация ' +
    'от бъдещи actions в СЪЩИЯ незавършен trick.',
  ],
  priority4: [
    'declarations context (терца/50/100/каре/белот — обявени преди/по време на играта на карти): ' +
    'TrainingDealRecord схема-та НЯМА declarations поле изобщо, нито на deal, нито на action ниво. Изисква ' +
    'recorder writer промяна, за да се захване — само отбелязано тук, НЕ имплементирано.',
    'isLead / positionInTrick в local beta trace record-а (LocalAiCardBetaTraceRecord): нужно, за да може ' +
    'бъдещ trace-based анализ (Part 1 в тази диагностика) да прави lead/follow breakdown директно от trace-а ' +
    'без да разчита само на offline validation/test split-овете. Изисква промяна в server/src/ai/localAiCardBeta.ts ' +
    '(runtime код, извън обхвата на тази чисто diagnostic задача) — само отбелязано тук, НЕ имплементирано.',
  ],
}

// ─── Markdown rendering ────────────────────────────────────────────────────────

function renderGroupTable(groups: Record<string, GroupStat>, order?: string[]): string[] {
  const lines: string[] = []
  const keys = order ? order.filter((k) => groups[k]) : Object.keys(groups)
  for (const k of keys) {
    const g = groups[k]!
    lines.push(`- ${k}: ${g.correct}/${g.total} = ${pct(g.correct, g.total)} (${g.errors} грешки)`)
  }
  return lines
}

function renderMarkdown(report: any): string {
  const lines: string[] = []
  lines.push('# AI Card Model — Weakness / Feature Gap Analysis')
  lines.push('')
  lines.push(`Генериран на: ${report.generatedAt}`)
  lines.push(`Модел: \`${report.modelVersion}\``)
  lines.push('')
  lines.push(
    '**Local-only, read-only диагностика.** Целта е да обясни защо Milen наблюдава слаба игра на ботовете ' +
    'в local beta — БЕЗ да тренира нов модел и БЕЗ да пипа gameplay/bot strategy/matchmaking/economy/client ' +
    'protocol/recorder writer.',
  )
  lines.push('')

  lines.push('## Privacy validation')
  lines.push('')
  lines.push(`Статус: **${report.privacyValidation.status}** (${report.privacyValidation.violationCount} нарушения)`)
  lines.push('')

  // ─── Part 1 ──────────────────────────────────────────────────────────────
  lines.push('## Част 1 — Beta trace анализ (реални local beta игри)')
  lines.push('')
  const p1 = report.part1BetaTraceAnalysis
  if (p1.note) {
    lines.push(`⚠ ${p1.note}`)
    lines.push('')
  } else {
    lines.push(`> ${p1.disclaimer}`)
    lines.push('')
    lines.push('### Trace source counts')
    lines.push('')
    lines.push(`- Total decisions: **${p1.sourceCounts.total}**`)
    lines.push(`- forced_card: ${p1.sourceCounts.forced_card}`)
    lines.push(`- ai_accepted: ${p1.sourceCounts.ai_accepted}`)
    lines.push(`- ai_same_as_conventional: ${p1.sourceCounts.ai_same_as_conventional}`)
    lines.push(`- conventional_fallback: ${p1.sourceCounts.conventional_fallback}`)
    lines.push(`- ai_disabled: ${p1.sourceCounts.ai_disabled}`)
    lines.push('')

    lines.push('### AI vs conventional')
    lines.push('')
    lines.push(`- Различава се (ai_accepted): **${p1.aiVsConventional.differsCount}**`)
    lines.push(`- Съвпада (ai_same_as_conventional): **${p1.aiVsConventional.sameCount}**`)
    lines.push('')
    lines.push('**По legalCardsCount bucket (differs/same):**')
    for (const [bucket, v] of Object.entries(p1.aiVsConventional.byLegalCardsCountBucket) as Array<[string, any]>) {
      lines.push(`- ${bucket}: ${v.differs} differs / ${v.same} same`)
    }
    lines.push('')
    lines.push('**По gameMode (differs/same):**')
    for (const [mode, v] of Object.entries(p1.aiVsConventional.byGameMode) as Array<[string, any]>) {
      lines.push(`- ${mode}: ${v.differs} differs / ${v.same} same`)
    }
    lines.push('')
    lines.push(`⚠ **Lead/follow breakdown: НЕ е налично.** ${p1.aiVsConventional.leadFollowNote}`)
    lines.push('')

    lines.push('### Card preference patterns (само ai_accepted редове)')
    lines.push('')
    const pd = p1.cardPreference.pointDelta
    lines.push(`- AI избира по-висока точкова карта от conventional: ${pd.aiHigher}`)
    lines.push(`- AI избира по-ниска точкова карта от conventional: ${pd.aiLower}`)
    lines.push(`- Еднаква точкова стойност: ${pd.aiEqual}`)
    lines.push('')
    const td = p1.cardPreference.trumpDelta
    lines.push(`- И двете коз: ${td.bothTrump}`)
    lines.push(`- Нито едно коз: ${td.neitherTrump}`)
    lines.push(`- AI коз, conventional не: ${td.aiTrumpConventionalNot}`)
    lines.push(`- AI не-коз, conventional коз: ${td.aiNonTrumpConventionalTrump}`)
    lines.push('')
    lines.push('**Ранг предпочитания (брой пъти избран ранг):**')
    lines.push(`- AI: ${JSON.stringify(p1.cardPreference.rankPreferenceCounts.ai)}`)
    lines.push(`- Conventional: ${JSON.stringify(p1.cardPreference.rankPreferenceCounts.conventional)}`)
    lines.push('')
    lines.push('**Top преходи (conventional → AI):**')
    for (const t of p1.cardPreference.topTransitionPairs) {
      lines.push(`- ${t.from} → ${t.to}: ${t.count}`)
    }
    lines.push('')

    lines.push('### Safety')
    lines.push('')
    const s = p1.safety
    lines.push(`- Invalid AI predictions: **${s.invalidAiPredictions}**`)
    lines.push(`- Invalid final cards: **${s.invalidFinalCards}** (трябва да е 0)`)
    lines.push(`- Fallback count: ${s.fallbackCount}`)
    lines.push(`- finalCardValid винаги true: ${s.finalCardValidAlwaysTrue ? 'ДА ✓' : 'НЕ ✗'}`)
    lines.push(`- aiCardValid консистентен (true за ai_accepted/ai_same_as_conventional): ${s.aiCardValidConsistent ? 'ДА ✓' : 'НЕ ✗'}`)
    lines.push(`- Duplicate ranking ids: ${s.duplicateRankingIdsCount}`)
    lines.push(`- Missing/non-finite score или probability: ${s.missingScoreOrProbabilityCount}`)
    lines.push('')
  }

  // ─── Part 2 ──────────────────────────────────────────────────────────────
  lines.push('## Част 2 — Offline error анализ (срещу човешки chosenCard label)')
  lines.push('')
  const p2 = report.part2OfflineErrorAnalysis
  for (const split of ['validation', 'test'] as const) {
    const sa = p2[split]
    lines.push(`### ${split}`)
    lines.push('')
    lines.push(`- All: ${sa.overall.correct}/${sa.overall.total} = ${pct(sa.overall.correct, sa.overall.total)}`)
    lines.push(`- Forced: ${sa.overall.forcedCorrect}/${sa.overall.forcedTotal} = ${pct(sa.overall.forcedCorrect, sa.overall.forcedTotal)}`)
    lines.push(`- Non-forced: ${sa.overall.nonForcedCorrect}/${sa.overall.nonForcedTotal} = ${pct(sa.overall.nonForcedCorrect, sa.overall.nonForcedTotal)}`)
    lines.push(`- Total errors: ${sa.overall.totalErrors}, non-forced errors: ${sa.overall.nonForcedErrors}`)
    lines.push('')
    lines.push('**Lead vs follow:**')
    lines.push(`- Lead: ${sa.byLeadFollow.lead.correct}/${sa.byLeadFollow.lead.total} = ${pct(sa.byLeadFollow.lead.correct, sa.byLeadFollow.lead.total)}`)
    lines.push(`- Follow: ${sa.byLeadFollow.follow.correct}/${sa.byLeadFollow.follow.total} = ${pct(sa.byLeadFollow.follow.correct, sa.byLeadFollow.follow.total)}`)
    lines.push('')
    lines.push('**По gameMode:**')
    lines.push(...renderGroupTable(sa.byGameMode))
    lines.push('')
    lines.push('**По legalCards.length bucket:**')
    lines.push(...renderGroupTable(sa.byLegalCardsBucket, ['forced(1)', '2', '3', '4', '5+']))
    lines.push('')
    lines.push('**Error patterns (само non-forced грешки):**')
    const ep = sa.errorPatterns
    lines.push(`- Trump predicted card: ${ep.trumpPredicted.trump} коз / ${ep.trumpPredicted.nonTrump} не-коз`)
    lines.push(`- High vs low point predicted card (праг ${HIGH_POINT_THRESHOLD}pt): ${ep.pointsPredicted.high} high / ${ep.pointsPredicted.low} low`)
    lines.push(`- AI vs human точки: ${ep.aiVsHumanPoints.aiHigher} по-висока / ${ep.aiVsHumanPoints.aiLower} по-ниска / ${ep.aiVsHumanPoints.aiEqual} еднаква`)
    lines.push(`- AI избра коз, човек не: ${ep.aiTrumpHumanNot}`)
    lines.push(`- AI избягва коз, човек използва коз: ${ep.aiAvoidedTrumpHumanUsedTrump}`)
    lines.push(
      `- Lead high/low mismatch (natural rank power, само lead грешки, n=${ep.leadHighLowMismatch.applicableCount}): ` +
      `${ep.leadHighLowMismatch.aiHigher} AI по-високо / ${ep.leadHighLowMismatch.aiLower} AI по-ниско / ${ep.leadHighLowMismatch.aiEqual} еднакво`,
    )
    lines.push(
      `- AI хвърли точки, докато човек е дискарднал 0-точкова карта (follow грешки, n=${ep.throwPointsWhenHumanLow.applicableCount}): ` +
      `${ep.throwPointsWhenHumanLow.count}`,
    )
    lines.push('')
  }

  lines.push('### Top 20 representative error примера (от test split)')
  lines.push('')
  let exampleIndex = 1
  for (const ex of p2.topErrorExamplesFromTest) {
    lines.push(`**Пример ${exampleIndex}** — ${ex.gameMode}${ex.trumpSuit ? ` (коз: ${ex.trumpSuit})` : ''}, ${ex.isLead ? 'LEAD' : 'FOLLOW'}`)
    lines.push('')
    lines.push(`- Legal cards: ${ex.legalCards.map((c: RawCompactCard) => c.id).join(', ')}`)
    lines.push(`- Own hand: ${ex.ownHand.map((c: RawCompactCard) => c.id).join(', ')}`)
    lines.push(`- Human chosenCard: **${ex.humanChosenCard.id}**`)
    lines.push(`- AI selectedCard: **${ex.aiSelectedCard}**`)
    lines.push(`- First-legal baseline: ${ex.firstLegalCard}`)
    lines.push(`- Conventional bot (re-simulated): ${ex.conventionalCard ?? 'n/a'}`)
    lines.push(`- Top-3 AI predictions: ${ex.topAiPredictions.map((p: any) => `${p.id} (score=${p.score.toFixed(3)}, p=${(p.probability * 100).toFixed(1)}%)`).join(', ')}`)
    lines.push(`- Диагностика: ${ex.diagnostics.join('; ')}`)
    lines.push('')
    exampleIndex++
  }

  // ─── Feature gap audit ───────────────────────────────────────────────────
  lines.push('## Feature gap audit')
  lines.push('')
  lines.push('| Поле | Статус | Бележка |')
  lines.push('|---|---|---|')
  for (const f of report.featureGapAudit) {
    lines.push(`| ${f.field} | **${f.status}** | ${f.note} |`)
  }
  lines.push('')

  // ─── Current feature limitation ─────────────────────────────────────────
  lines.push('## Текущо ограничение на feature set-а (card-model-v1)')
  lines.push('')
  lines.push(`Текущите features: ${report.currentFeatureLimitation.features.map((f: string) => `\`${f}\``).join(', ')}`)
  lines.push('')
  const fa = report.currentFeatureLimitation.assessment
  lines.push(`**Lead play:** ${fa.leadPlay}`)
  lines.push('')
  lines.push(`**Follow play:** ${fa.followPlay}`)
  lines.push('')
  lines.push(`**Trump contracts (suit):** ${fa.trumpContracts}`)
  lines.push('')
  lines.push(`**All-trumps:** ${fa.allTrumps}`)
  lines.push('')
  lines.push(`**No-trumps:** ${fa.noTrumps}`)
  lines.push('')
  lines.push(`**Partner-support play:** ${fa.partnerSupportPlay}`)
  lines.push('')
  const ev = report.currentFeatureLimitation.evidence
  lines.push('**Измерено доказателство (non-forced accuracy, от Part 2 по-горе):**')
  lines.push(`- Validation — lead: ${(ev.leadAccuracyValidation * 100).toFixed(1)}%, follow: ${(ev.followAccuracyValidation * 100).toFixed(1)}%`)
  lines.push(`- Test — lead: ${(ev.leadAccuracyTest * 100).toFixed(1)}%, follow: ${(ev.followAccuracyTest * 100).toFixed(1)}%`)
  lines.push('')

  // ─── Recommendations ─────────────────────────────────────────────────────
  lines.push('## Препоръки за card-model-v2 (НЕ имплементирани в тази задача)')
  lines.push('')
  lines.push(`⚠ **Методологична бележка (прочети първо):** ${report.recommendations.methodologicalWarning}`)
  lines.push('')
  lines.push('### Priority 1 — вече налични в dataset-а, само trainer/inference промяна')
  lines.push('')
  for (const r of report.recommendations.priority1) lines.push(`- ${r}`)
  lines.push('')
  lines.push('### Priority 2 — derivable от налични полета (trainer/inference промяна)')
  lines.push('')
  for (const r of report.recommendations.priority2) lines.push(`- ${r}`)
  lines.push('')
  lines.push('### Priority 3 — изисква dataset builder enhancement (recorder архивът вече ги има)')
  lines.push('')
  for (const r of report.recommendations.priority3) lines.push(`- ${r}`)
  lines.push('')
  lines.push('### Priority 4 — изисква recorder writer промяна (само отбелязано, НЕ направено)')
  lines.push('')
  for (const r of report.recommendations.priority4) lines.push(`- ${r}`)
  lines.push('')

  lines.push('## Изходни файлове')
  lines.push('')
  lines.push('- `training-output/models/card-model-v1/weakness-analysis.json`')
  lines.push('- `training-output/models/card-model-v1/weakness-analysis.md`')
  lines.push('')

  return lines.join('\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  AI Card Model Weakness Diagnostic (локален, read-only)')
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
  console.log(`Зареден model: ${model.modelVersion}`)

  // ─── Стъпка: чети validation/test split-овете ──────────────────────────────
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

  console.log('Валидирам card split файловете...')
  const parsedValidation = parseJsonlStrict<Partial<CardRecord>>(splitContents.validation, 'card-validation.jsonl')
  const parsedTest = parseJsonlStrict<Partial<CardRecord>>(splitContents.test, 'card-test.jsonl')

  const schemaErrors: string[] = [...parsedValidation.errors, ...parsedTest.errors]
  for (const { record, lineNumber } of parsedValidation.lines) schemaErrors.push(...validateCardRecord(record, `card-validation.jsonl:${lineNumber}`))
  for (const { record, lineNumber } of parsedTest.lines) schemaErrors.push(...validateCardRecord(record, `card-test.jsonl:${lineNumber}`))

  if (schemaErrors.length > 0) {
    console.error(`\n✗ Открити ${schemaErrors.length} schema грешки — анализ СПРЯН (schema ambiguity).\n`)
    for (const e of schemaErrors.slice(0, 200)) console.error(`  ${e}`)
    process.exit(1)
    return
  }

  // ─── Privacy scan на input-а (dataset splits + model + trace, ако е наличен) ─
  console.log('Privacy/sanitization сканиране на input файловете...')
  const inputViolations: SanitizationViolation[] = []
  for (const split of ['validation', 'test'] as const) inputViolations.push(...(await scanAllForbiddenContent(CARD_PATHS[split])))
  inputViolations.push(...(await scanAllForbiddenContent(MODEL_JSON_PATH)))

  let traceContent: string | null = null
  try {
    traceContent = await readFile(TRACE_PATH, 'utf8')
    inputViolations.push(...(await scanAllForbiddenContent(TRACE_PATH)))
  } catch {
    traceContent = null
  }
  let traceSummaryExists = false
  try {
    await readFile(TRACE_SUMMARY_JSON_PATH, 'utf8')
    inputViolations.push(...(await scanAllForbiddenContent(TRACE_SUMMARY_JSON_PATH)))
    traceSummaryExists = true
  } catch {
    traceSummaryExists = false
  }

  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — анализ СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const validationRecords = parsedValidation.lines.map((l) => l.record as CardRecord)
  const testRecords = parsedTest.lines.map((l) => l.record as CardRecord)

  // ─── Part 1: beta trace анализ (ако е наличен) ──────────────────────────────
  let part1: TraceAnalysis | null = null
  let part1Note = ''
  if (traceContent !== null) {
    const { records: traceLines, errors: traceErrors } = parseTraceJsonl(traceContent, 'card-decisions.jsonl')
    if (traceErrors.length > 0) {
      console.error(`\n✗ Открити ${traceErrors.length} validation грешки в trace-а — Part 1 СПРЯН (schema ambiguity).\n`)
      for (const e of traceErrors.slice(0, 200)) console.error(`  ${e}`)
      process.exit(1)
      return
    }
    part1 = analyzeTrace(traceLines.map((l) => l.record))
    console.log(`Part 1: анализирани ${traceLines.length} trace decisions.`)
  } else {
    part1Note = `Trace файл не е намерен: ${TRACE_PATH}. Part 1 (beta trace анализ) е пропуснат — ако искаш този анализ, пусни local beta сесия с LOCAL_AI_CARD_BETA_TRACE_ENABLED=true първо.`
    console.log(part1Note)
  }

  // ─── Part 2: offline error анализ (validation + test) ───────────────────────
  console.log('Part 2: пускам inference върху validation/test и сравнявам с човешкия chosenCard...')
  const validationAnalysis = analyzeSplit(model, validationRecords)
  const testAnalysis = analyzeSplit(model, testRecords)
  const topErrorExamples = selectRepresentativeExamples(testAnalysis.errorsForExamples, 20)

  // ─── Assemble report ─────────────────────────────────────────────────────────
  const generatedAt = new Date().toISOString()

  const reportJson = {
    generatedAt,
    modelVersion: model.modelVersion,
    inputFiles: {
      model: MODEL_JSON_PATH,
      cardValidation: CARD_PATHS.validation,
      cardTest: CARD_PATHS.test,
      trace: traceContent !== null ? TRACE_PATH : null,
      traceSummary: traceSummaryExists ? TRACE_SUMMARY_JSON_PATH : null,
    },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    part1BetaTraceAnalysis: part1 ?? { note: part1Note },
    part2OfflineErrorAnalysis: {
      validation: {
        overall: validationAnalysis.overall,
        byLeadFollow: validationAnalysis.byLeadFollow,
        byGameMode: validationAnalysis.byGameMode,
        byLegalCardsBucket: validationAnalysis.byLegalCardsBucket,
        errorPatterns: validationAnalysis.errorPatterns,
      },
      test: {
        overall: testAnalysis.overall,
        byLeadFollow: testAnalysis.byLeadFollow,
        byGameMode: testAnalysis.byGameMode,
        byLegalCardsBucket: testAnalysis.byLegalCardsBucket,
        errorPatterns: testAnalysis.errorPatterns,
      },
      topErrorExamplesFromTest: topErrorExamples,
    },
    featureGapAudit: FEATURE_GAP_AUDIT,
    currentFeatureLimitation: {
      features: CURRENT_FEATURES,
      assessment: FEATURE_SUFFICIENCY_ASSESSMENT,
      evidence: {
        leadAccuracyValidation: validationAnalysis.byLeadFollow.lead.accuracy,
        followAccuracyValidation: validationAnalysis.byLeadFollow.follow.accuracy,
        leadAccuracyTest: testAnalysis.byLeadFollow.lead.accuracy,
        followAccuracyTest: testAnalysis.byLeadFollow.follow.accuracy,
      },
    },
    recommendations: RECOMMENDATIONS,
  }

  await mkdir(MODEL_DIR, { recursive: true })
  await writeFile(WEAKNESS_JSON_PATH, JSON.stringify(reportJson, null, 2) + '\n', 'utf8')
  await writeFile(WEAKNESS_MD_PATH, renderMarkdown(reportJson), 'utf8')

  // ─── Privacy re-scan на generated reports (defense in depth) ────────────────
  console.log('Privacy/sanitization сканиране на generated reports...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(WEAKNESS_JSON_PATH)),
    ...(await scanAllForbiddenContent(WEAKNESS_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated reports — намерени ${outputViolations.length}:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  // ─── Финален конзолен отчет ──────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Validation — lead: ${pct(validationAnalysis.byLeadFollow.lead.correct, validationAnalysis.byLeadFollow.lead.total)}, follow: ${pct(validationAnalysis.byLeadFollow.follow.correct, validationAnalysis.byLeadFollow.follow.total)}`)
  console.log(`  Test       — lead: ${pct(testAnalysis.byLeadFollow.lead.correct, testAnalysis.byLeadFollow.lead.total)}, follow: ${pct(testAnalysis.byLeadFollow.follow.correct, testAnalysis.byLeadFollow.follow.total)}`)
  if (part1) {
    console.log(`  Beta trace — ai_accepted: ${part1.sourceCounts.ai_accepted}, ai_same_as_conventional: ${part1.sourceCounts.ai_same_as_conventional}, invalid final cards: ${part1.safety.invalidFinalCards}`)
  } else {
    console.log('  Beta trace — не е наличен (Part 1 пропуснат).')
  }
  console.log(`\n✓ Отчет: ${WEAKNESS_MD_PATH}`)
  console.log(`✓ Отчет: ${WEAKNESS_JSON_PATH}`)
  console.log('✓ Diagnostic анализ завършен успешно.\n')
  process.exit(0)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
