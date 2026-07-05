/**
 * evaluateCardSelectionWithinSuit.ts
 *
 * Offline, read-only evaluator answering the diagnostic question raised by
 * evaluateSignalMemoryAdvisor.ts: "choosing the right suit ≠ choosing the
 * right card." Rule E (return_partner_signaled_suit) was rejected there
 * because its naive "always play the safest card" heuristic scored only
 * ~31% exact-card accuracy — well below baseline — even though the
 * underlying suit-return SIGNAL was independently validated
 * (analyzePartnerSignalMemory.ts: 56.1% overall / 70.5% no-conflict return
 * rate). This script isolates the SECOND question: given that a partner
 * suit-signal exists, A-D didn't already override, and the human DID return
 * the signaled suit — which of several candidate card-selection-within-suit
 * strategies best predicts the EXACT card the human chose?
 *
 * Reuses, does not duplicate:
 *  - server/scripts/analyzePartnerSignalMemory.ts's exported buildDealLedger()/
 *    detectPartnerSuitSignal()/getPartnerSeat()/isTrumpCard() for signal
 *    reconstruction (same archive-reading approach, same signal definitions).
 *  - server/src/ai/cardAdvisorPolicy.ts's decideAdvisorCard() for the A-D
 *    guard check (byte-identical engine, not a copy) — samples where A-D
 *    already overrides are excluded (no card-selection-within-suit question
 *    to ask there, advisor v0 already decided).
 *  - server/scripts/evaluateSignalMemoryAdvisor.ts's pattern for
 *    re-simulating the conventional bot's choice offline (read-only
 *    pickServerBotPlayCard import, minimal reconstructed
 *    ServerAuthoritativeGameState).
 *  - server/src/ai/cardModelInference.ts's rankLegalCardsWithCardModel()
 *    for the optional v3_ranked_within_suit strategy (skipped gracefully,
 *    with a clear report note, if training-output/models/card-model-v3/
 *    model.json is not present — no new dependency introduced).
 *
 * IMPORTANT (bug precedent, see analyzePartnerSignalMemory.ts's own header):
 * this script exports nothing intended for reuse by a future importer, but
 * follows the same entry-point guard convention regardless, since it itself
 * imports from analyzePartnerSignalMemory.ts (which now requires the guard
 * to avoid running its own main() as an import side effect).
 *
 * Does not touch gameplay, matchmaking, economy, client protocol, recorder
 * writer, pickServerBotPlayCard.ts, or localAiCardBeta.ts. Does not wire
 * anything into runtime — offline evaluation only.
 *
 * Usage:
 *   npm run evaluate:card-selection-within-suit   (от server/, след build:training-dataset)
 *
 * Exit codes:
 *   0 — успешно
 *   1 — invalid/missing input, privacy нарушение, schema грешка, safety violation
 *   2 — file system грешка
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readJsonlFilesFromTarGz } from './trainingDataset/tarGzJsonlReader.js'
import {
  parseJsonlStrict,
  validateCardRecordV2,
  scanAllForbiddenContent,
  type CardRecordV2,
} from './humanMoveMemoryV2Shared.js'
import {
  getPartnerSeat,
  isTrumpCard,
  buildDealLedger,
  detectPartnerSuitSignal,
  type SuitReturnSignal,
} from './analyzePartnerSignalMemory.js'
import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import { decideAdvisorCard, type AdvisorCandidateMemory, type AdvisorDecisionInput } from '../src/ai/cardAdvisorPolicy.js'
import { getServerCardPoints, type ServerScoringContract } from '../src/game/serverScoring.js'
import { getServerCardRankPower, getServerTrickWinner } from '../src/game/getServerTrickWinner.js'
import {
  CardModelLoadError,
  loadCardModelFromFile,
  rankLegalCardsWithCardModel,
  type CardModel,
} from '../src/ai/cardModelInference.js'
import type { CardDecisionState, CompactPlayedCard } from '../src/ai/cardModelFeatures.js'
import type {
  AnyTrainingRecord,
  TrainingDealRecord,
} from '../src/trainingRecorder/trainingRecorderTypes.js'
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
const DEFAULT_ARCHIVE_NAME = 'training-recorder-audit-20260704-144842.tar.gz'
const OUTPUT_DIR = join(REPO_ROOT, 'training-output')
const CARD_DECISIONS_PATH = join(OUTPUT_DIR, 'card-decisions.jsonl')
const MODEL_V3_JSON_PATH = join(OUTPUT_DIR, 'models', 'card-model-v3', 'model.json')
const REPORT_DIR = join(OUTPUT_DIR, 'signal-memory-advisor')
const REPORT_JSON_PATH = join(REPORT_DIR, 'card-selection-within-suit-report.json')
const REPORT_MD_PATH = join(REPORT_DIR, 'card-selection-within-suit-report.md')

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

// ─── Minimal ServerAuthoritativeGameState reconstruction (same proven pattern ─
// as evaluateCardAdvisor.ts / evaluateSignalMemoryAdvisor.ts's buildMinimalState) ─

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

function emptyScore() {
  return { teamA: 0, teamB: 0 }
}
function makePlayers(): Record<Seat, ServerPlayerState> {
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(
    SEAT_ORDER.map((s, i) => [s, { seat: s, team: teams[i]!, mode: 'bot' as const, controlledByBot: true }]),
  ) as Record<Seat, ServerPlayerState>
}
function emptyWon(): Record<Seat, ServerCard[][]> {
  return { bottom: [], right: [], top: [], left: [] }
}

function buildMinimalState(r: CardRecordV2): { state: ServerAuthoritativeGameState; seat: Seat } {
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

// ─── Small card helpers (contract/trump aware) ──────────────────────────────

function cardPointsOf(c: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): number {
  return getServerCardPoints(c.suit, c.rank, contract, trumpSuit)
}
function rankPowerOf(c: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): number {
  return getServerCardRankPower(c.rank, isTrumpCard(c.suit, contract, trumpSuit))
}
function wouldWinTrick(row: CardRecordV2, candidate: ServerCard): boolean {
  const winningBid: ServerWinningBid = {
    seat: row.contract.bidderSeat as Seat,
    contract: row.contract.contract,
    trumpSuit: row.contract.trumpSuit as ServerSuit | null,
    doubled: row.contract.doubled,
    redoubled: row.contract.redoubled,
  }
  const priorPlays: ServerTrickPlay[] = row.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard }))
  const candidatePlay: ServerTrickPlay = { seat: row.seat as Seat, card: candidate }
  const winner = getServerTrickWinner([...priorPlays, candidatePlay], winningBid)
  return winner?.seat === row.seat
}

// ─── Signal type classification (same priority as evaluateSignalMemoryAdvisor.ts) ─

type SignalType = 'last-led-suit' | 'repeated-suit' | 'high-card-lead' | 'key-card-drawn'
function classifySignalType(signal: SuitReturnSignal): SignalType {
  if (signal.keyCardCleared) return 'key-card-drawn'
  if (signal.isHigh) return 'high-card-lead'
  if (signal.repeatCount > 1) return 'repeated-suit'
  return 'last-led-suit'
}

// ─── Strategies ───────────────────────────────────────────────────────────────

type StrategyName =
  | 'conventional_card_if_same_suit'
  | 'lowest_in_suit'
  | 'highest_in_suit'
  | 'lowest_point_card_in_suit'
  | 'highest_point_card_in_suit'
  | 'lowest_winning_card_in_suit'
  | 'highest_winning_card_in_suit'
  | 'lowest_non_winning_card_in_suit'
  | 'preserve_clean_winner_in_suit'
  | 'clean_winner_in_suit'
  | 'v3_ranked_within_suit'

const STRATEGY_NAMES: StrategyName[] = [
  'conventional_card_if_same_suit',
  'lowest_in_suit',
  'highest_in_suit',
  'lowest_point_card_in_suit',
  'highest_point_card_in_suit',
  'lowest_winning_card_in_suit',
  'highest_winning_card_in_suit',
  'lowest_non_winning_card_in_suit',
  'preserve_clean_winner_in_suit',
  'clean_winner_in_suit',
  'v3_ranked_within_suit',
]

type StrategyPrediction = { card: ServerCard | null; note: string }

type StrategyContext = {
  row: CardRecordV2
  legalCardsInSuit: ServerCard[]
  conventionalCard: ServerCard
  contract: ServerScoringContract
  trumpSuit: ServerSuit | null
  v3Model: CardModel | null
}

function noPrediction(note: string): StrategyPrediction {
  return { card: null, note }
}

function pickMinBy(cards: ServerCard[], scoreOf: (c: ServerCard) => number): ServerCard {
  return cards.reduce((best, c) => (scoreOf(c) < scoreOf(best) ? c : best))
}
function pickMaxBy(cards: ServerCard[], scoreOf: (c: ServerCard) => number): ServerCard {
  return cards.reduce((best, c) => (scoreOf(c) > scoreOf(best) ? c : best))
}

function runStrategy(name: StrategyName, ctx: StrategyContext): StrategyPrediction {
  const { row, legalCardsInSuit, conventionalCard, contract, trumpSuit } = ctx
  const rankPower = (c: ServerCard) => rankPowerOf(c, contract, trumpSuit)
  const points = (c: ServerCard) => cardPointsOf(c, contract, trumpSuit)

  switch (name) {
    case 'conventional_card_if_same_suit': {
      if (conventionalCard.suit === legalCardsInSuit[0]!.suit) return { card: conventionalCard, note: 'conventional bot already chose a card in this suit' }
      return noPrediction('conventional bot chose a different suit — no prediction for this strategy')
    }

    case 'lowest_in_suit':
      return { card: pickMinBy(legalCardsInSuit, rankPower), note: 'lowest rank-power card in the signaled suit' }

    case 'highest_in_suit':
      return { card: pickMaxBy(legalCardsInSuit, rankPower), note: 'highest rank-power card in the signaled suit' }

    case 'lowest_point_card_in_suit':
      return { card: pickMinBy(legalCardsInSuit, (c) => points(c) * 100 + rankPower(c)), note: 'fewest points, tie-break lowest rank' }

    case 'highest_point_card_in_suit':
      return { card: pickMaxBy(legalCardsInSuit, (c) => points(c) * 100 + rankPower(c)), note: 'most points, tie-break highest rank' }

    case 'lowest_winning_card_in_suit': {
      const winners = legalCardsInSuit.filter((c) => wouldWinTrick(row, c))
      if (winners.length === 0) return noPrediction('no card in this suit would win the current trick')
      return { card: pickMinBy(winners, rankPower), note: 'lowest rank-power card in suit that would win the trick' }
    }

    case 'highest_winning_card_in_suit': {
      const winners = legalCardsInSuit.filter((c) => wouldWinTrick(row, c))
      if (winners.length === 0) return noPrediction('no card in this suit would win the current trick')
      return { card: pickMaxBy(winners, rankPower), note: 'highest rank-power card in suit that would win the trick' }
    }

    case 'lowest_non_winning_card_in_suit': {
      const nonWinners = legalCardsInSuit.filter((c) => !wouldWinTrick(row, c))
      if (nonWinners.length === 0) return noPrediction('every card in this suit would win the trick — no non-winning option to preserve a winner with')
      return { card: pickMinBy(nonWinners, rankPower), note: 'lowest rank-power card in suit that would NOT win the trick (avoids spending a winner)' }
    }

    case 'preserve_clean_winner_in_suit': {
      const memoryById = new Map(row.legalCardsMemoryFeatures.map((m) => [m.id, m]))
      const cleanWinners = legalCardsInSuit.filter((c) => memoryById.get(c.id)?.candidateIsCleanWinner)
      const nonCleanAlternatives = legalCardsInSuit.filter((c) => !memoryById.get(c.id)?.candidateIsCleanWinner)
      if (cleanWinners.length === 0) return noPrediction('no clean winner exists in this suit — strategy has nothing to preserve')
      if (nonCleanAlternatives.length === 0) return noPrediction('every legal card in this suit is a clean winner — no safe alternative to preserve with')
      const isUrgent = row.memory.opponentCurrentlyWinning && row.memory.pointsInTrick >= 10
      if (isUrgent) return noPrediction('trick is urgent (opponent winning with 10+ points) — preservation does not apply, defer to other strategies')
      return { card: pickMinBy(nonCleanAlternatives, (c) => points(c) * 100 + rankPower(c)), note: 'safest non-clean-winner alternative in suit, preserving the clean winner for later' }
    }

    case 'clean_winner_in_suit': {
      const memoryById = new Map(row.legalCardsMemoryFeatures.map((m) => [m.id, m]))
      const cleanWinners = legalCardsInSuit.filter((c) => memoryById.get(c.id)?.candidateIsCleanWinner)
      if (cleanWinners.length === 0) return noPrediction('no clean winner exists in this suit')
      return { card: pickMaxBy(cleanWinners, rankPower), note: 'the clean winner in the signaled suit (highest rank if more than one, defensive tie-break)' }
    }

    case 'v3_ranked_within_suit': {
      if (!ctx.v3Model) return noPrediction('card-model-v3/model.json not available locally — strategy skipped, see report note')
      const decisionState: CardDecisionState = {
        seat: row.seat,
        ownHand: row.ownHand,
        legalCards: legalCardsInSuit,
        contract: { contract: row.contract.contract, trumpSuit: row.contract.trumpSuit, bidderSeat: row.contract.bidderSeat },
        currentTrick: row.currentTrick as unknown as CompactPlayedCard[],
        currentWinningSeat: row.currentWinningSeat,
        memory: row.memory,
        legalCardsMemoryFeatures: row.legalCardsMemoryFeatures,
      }
      const prediction = rankLegalCardsWithCardModel(ctx.v3Model, decisionState)
      const card = legalCardsInSuit.find((c) => c.id === prediction.selectedCard) ?? null
      return card
        ? { card, note: 'card-model-v3 ranking restricted to legal cards in the signaled suit' }
        : noPrediction('card-model-v3 selected a card outside the signaled-suit subset (unexpected) — treated as no prediction, safety net')
    }
  }
}

// ─── Sample record (one per eligible decision) ──────────────────────────────

type PointsBucket = '0' | '1-9' | '10+'
function pointsBucketOf(points: number): PointsBucket {
  if (points <= 0) return '0'
  if (points <= 9) return '1-9'
  return '10+'
}

type RedFlags = {
  wouldFeedPointsToOpponent: boolean
  wouldOvertakePartnerUnnecessarily: boolean
  wouldDiscardClaimedCleanWinner: boolean
  invalidPrediction: boolean
  predictionNotInLegalCards: boolean
  predictionNotInOwnHand: boolean
}

type Sample = {
  gameMode: string
  signalType: SignalType
  isLead: boolean
  positionInTrick: number
  partnerCurrentlyWinning: boolean
  opponentCurrentlyWinning: boolean
  pointsInTrickBucket: PointsBucket
  cleanWinnerAvailable: boolean
  chosenShouldPreserve: boolean
  chosenCardId: string
  legalIds: Set<string>
  ownHandIds: Set<string>
  predictions: Partial<Record<StrategyName, StrategyPrediction>>
  redFlagsByStrategy: Partial<Record<StrategyName, RedFlags>>
}

function computeRedFlags(row: CardRecordV2, card: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null, legalIds: Set<string>, ownHandIds: Set<string>): RedFlags {
  const memoryById = new Map(row.legalCardsMemoryFeatures.map((m) => [m.id, m]))
  const cardMemory = memoryById.get(card.id)
  const wins = wouldWinTrick(row, card)
  return {
    wouldFeedPointsToOpponent: row.memory.opponentCurrentlyWinning && cardPointsOf(card, contract, trumpSuit) > 0,
    wouldOvertakePartnerUnnecessarily: row.memory.partnerCurrentlyWinning && wins && row.memory.pointsInTrick < 10,
    wouldDiscardClaimedCleanWinner: cardMemory?.shouldPreserveCleanWinner === true,
    invalidPrediction: false, // structurally always a member of legalCardsInSuit ⊆ legalCards; kept for schema symmetry
    predictionNotInLegalCards: !legalIds.has(card.id),
    predictionNotInOwnHand: !ownHandIds.has(card.id),
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Card-Selection-Within-Suit — offline evaluator (локален, read-only)')
  console.log('─────────────────────────────────────────')

  const args = process.argv.slice(2)
  const archiveArg = args.find((a) => !a.startsWith('-'))
  const archivePath = archiveArg ? resolve(process.cwd(), archiveArg) : join(REPO_ROOT, DEFAULT_ARCHIVE_NAME)

  console.log(`Архив: ${archivePath}`)
  console.log(`Card decisions: ${CARD_DECISIONS_PATH}`)

  let cardDecisionsContent: string
  try {
    cardDecisionsContent = await readFile(CARD_DECISIONS_PATH, 'utf8')
  } catch {
    console.error(`FATAL: липсва ${CARD_DECISIONS_PATH}`)
    console.error('Изпълни първо: npm run build:training-dataset')
    process.exit(2)
    return
  }

  console.log('Валидирам card-decisions.jsonl...')
  const parsedCardDecisions = parseJsonlStrict<Partial<CardRecordV2>>(cardDecisionsContent, 'card-decisions.jsonl')
  const schemaErrors: string[] = [...parsedCardDecisions.errors]
  for (const { record, lineNumber } of parsedCardDecisions.lines) {
    schemaErrors.push(...validateCardRecordV2(record, `card-decisions.jsonl:${lineNumber}`))
  }
  if (schemaErrors.length > 0) {
    console.error(`\n✗ Открити ${schemaErrors.length} schema грешки — анализ СПРЯН.\n`)
    for (const e of schemaErrors.slice(0, 200)) console.error(`  ${e}`)
    process.exit(1)
    return
  }

  console.log('Privacy/sanitization сканиране на card-decisions.jsonl...')
  const inputViolations = await scanAllForbiddenContent(CARD_DECISIONS_PATH)
  if (inputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в input-а — анализ СПРЯН:\n`)
    for (const v of inputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  const cardDecisionsByKey = new Map<string, CardRecordV2>()
  for (const { record } of parsedCardDecisions.lines) {
    const r = record as CardRecordV2
    cardDecisionsByKey.set(`${r.recordingId}|${r.dealIndex}|${r.sequence}`, r)
  }
  console.log(`Заредени ${cardDecisionsByKey.size} card decision records.`)

  let jsonlFiles: Awaited<ReturnType<typeof readJsonlFilesFromTarGz>>
  try {
    jsonlFiles = await readJsonlFilesFromTarGz(archivePath)
  } catch (e) {
    console.error(`FATAL: не мога да прочета архива: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
    return
  }
  console.log(`Намерени ${jsonlFiles.length} .jsonl файла в архива.`)

  let v3Model: CardModel | null = null
  let v3SkipReason: string | null = null
  try {
    v3Model = await loadCardModelFromFile(MODEL_V3_JSON_PATH)
    console.log(`card-model-v3 зареден: ${MODEL_V3_JSON_PATH}`)
  } catch (e) {
    v3SkipReason = e instanceof CardModelLoadError ? e.message : String(e)
    console.log(`card-model-v3 НЕ е наличен (${v3SkipReason}) — v3_ranked_within_suit ще бъде skipped за всички samples.`)
  }

  console.log('Реконструирам deal-level trick history, филтрирам eligible samples...')

  const samples: Sample[] = []
  let dealsProcessed = 0
  let missingJoinCount = 0
  let noConventionalCount = 0

  for (const file of jsonlFiles) {
    for (const rawLine of file.content.split('\n')) {
      const trimmed = rawLine.trim()
      if (!trimmed) continue

      let parsed: AnyTrainingRecord
      try {
        parsed = JSON.parse(trimmed) as AnyTrainingRecord
      } catch {
        continue
      }
      if (!parsed.completed || parsed.recordKind !== 'full') continue

      const deal = parsed as TrainingDealRecord
      if (!deal.finalContract || deal.tricks.length === 0) continue
      dealsProcessed++
      const ledger = buildDealLedger(deal)

      for (const action of deal.cardActions) {
        if (action.actorKind !== 'human_manual') continue

        const key = `${deal.recordingId}|${deal.dealIndex}|${action.sequence}`
        const row = cardDecisionsByKey.get(key)
        if (!row) {
          missingJoinCount++
          continue
        }
        if (row.legalCards.length <= 1) continue // forced — no real choice

        const seat = action.seat
        const partnerSeat = getPartnerSeat(seat)

        // 1) recognized partner suit signal
        const signal = detectPartnerSuitSignal(ledger, partnerSeat, seat, row.trickIndex)
        if (!signal) continue

        // legal card in signaled suit must exist
        const legalCardsInSuit = (row.legalCards as ServerCard[]).filter((c) => c.suit === signal.suit)
        if (legalCardsInSuit.length === 0) continue

        // 4) human actually returned the signaled suit (ground truth ready)
        if (row.chosenCard.suit !== signal.suit) continue

        // 2) A-D advisor guard must NOT override
        const { state, seat: reconstructedSeat } = buildMinimalState(row)
        const conventionalCardId = pickServerBotPlayCard(state, reconstructedSeat)?.id ?? null
        const conventionalCard = row.legalCards.find((c) => c.id === conventionalCardId) as ServerCard | undefined
        if (!conventionalCard) {
          noConventionalCount++
          continue
        }

        const candidateMemoryById = new Map<string, AdvisorCandidateMemory>()
        for (const c of row.legalCardsMemoryFeatures) {
          candidateMemoryById.set(c.id, { id: c.id, candidateIsCleanWinner: c.candidateIsCleanWinner, shouldPreserveCleanWinner: c.shouldPreserveCleanWinner })
        }
        const advisorInput: AdvisorDecisionInput = {
          seat,
          partnerSeat,
          positionInTrick: row.positionInTrick,
          contract: row.contract.contract as ServerScoringContract,
          trumpSuit: row.contract.trumpSuit as ServerSuit | null,
          currentTrickPlays: row.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard })),
          legalCards: row.legalCards as ServerCard[],
          conventionalCard,
          partnerCurrentlyWinning: row.memory.partnerCurrentlyWinning,
          opponentCurrentlyWinning: row.memory.opponentCurrentlyWinning,
          pointsInTrick: row.memory.pointsInTrick,
          candidateMemoryById,
        }
        const v0Result = decideAdvisorCard(advisorInput)
        if (v0Result.override) continue // A-D already decided — no card-selection-within-suit question here

        // ── Eligible sample — run all strategies ──────────────────────────
        const contract = row.contract.contract as ServerScoringContract
        const trumpSuit = row.contract.trumpSuit as ServerSuit | null
        const legalIds = new Set(row.legalCards.map((c) => c.id))
        const ownHandIds = new Set(row.ownHand.map((c) => c.id))

        const ctx: StrategyContext = { row, legalCardsInSuit, conventionalCard, contract, trumpSuit, v3Model }
        const predictions: Partial<Record<StrategyName, StrategyPrediction>> = {}
        const redFlagsByStrategy: Partial<Record<StrategyName, RedFlags>> = {}

        for (const name of STRATEGY_NAMES) {
          const prediction = runStrategy(name, ctx)
          predictions[name] = prediction
          if (prediction.card) {
            redFlagsByStrategy[name] = computeRedFlags(row, prediction.card, contract, trumpSuit, legalIds, ownHandIds)
          }
        }

        const memoryById = new Map(row.legalCardsMemoryFeatures.map((m) => [m.id, m]))
        const cleanWinnerAvailable = legalCardsInSuit.some((c) => memoryById.get(c.id)?.candidateIsCleanWinner)

        samples.push({
          gameMode: row.contract.contract,
          signalType: classifySignalType(signal),
          isLead: row.positionInTrick === 0,
          positionInTrick: row.positionInTrick,
          partnerCurrentlyWinning: row.memory.partnerCurrentlyWinning,
          opponentCurrentlyWinning: row.memory.opponentCurrentlyWinning,
          pointsInTrickBucket: pointsBucketOf(row.memory.pointsInTrick),
          cleanWinnerAvailable,
          chosenShouldPreserve: row.chosenCardMemoryFeatures.shouldPreserveCleanWinner,
          chosenCardId: row.chosenCard.id,
          legalIds,
          ownHandIds,
          predictions,
          redFlagsByStrategy,
        })
      }
    }
  }

  console.log(`Обработени ${dealsProcessed} deals, ${missingJoinCount} missing joins, ${noConventionalCount} без conventional pick.`)
  console.log(`Eligible samples (signal + A-D no-override + returned suit): ${samples.length}`)

  // ─── Safety validation (must be 0 across all strategies) ────────────────
  let totalInvalidPredictions = 0
  let totalNotInLegalCards = 0
  let totalNotInOwnHand = 0
  for (const s of samples) {
    for (const name of STRATEGY_NAMES) {
      const rf = s.redFlagsByStrategy[name]
      if (!rf) continue
      if (rf.invalidPrediction) totalInvalidPredictions++
      if (rf.predictionNotInLegalCards) totalNotInLegalCards++
      if (rf.predictionNotInOwnHand) totalNotInOwnHand++
    }
  }
  if (totalNotInLegalCards > 0 || totalNotInOwnHand > 0 || totalInvalidPredictions > 0) {
    console.error(`\n✗ SAFETY VIOLATION: invalid=${totalInvalidPredictions}, notInLegalCards=${totalNotInLegalCards}, notInOwnHand=${totalNotInOwnHand} — report СПРЯН.\n`)
    process.exit(1)
    return
  }

  // ─── Aggregation ──────────────────────────────────────────────────────────

  function computeStats(subset: Sample[], name: StrategyName) {
    const withPrediction = subset.filter((s) => s.predictions[name]?.card)
    const correct = withPrediction.filter((s) => s.predictions[name]!.card!.id === s.chosenCardId)
    const redFlagged = withPrediction.filter((s) => {
      const rf = s.redFlagsByStrategy[name]
      return rf && (rf.wouldFeedPointsToOpponent || rf.wouldOvertakePartnerUnnecessarily || rf.wouldDiscardClaimedCleanWinner)
    })
    return {
      eligible: subset.length,
      predicted: withPrediction.length,
      coverage: pct(withPrediction.length, subset.length),
      exactCardAccuracy: pct(correct.length, withPrediction.length),
      accuracyOfAllEligible: pct(correct.length, subset.length),
      redFlagRate: pct(redFlagged.length, withPrediction.length),
      redFlagCount: redFlagged.length,
    }
  }

  function breakdownBy<K extends string>(subsetKeyFn: (s: Sample) => K, keys: K[], name: StrategyName) {
    const result: Record<string, ReturnType<typeof computeStats>> = {}
    for (const k of keys) {
      result[k] = computeStats(samples.filter((s) => subsetKeyFn(s) === k), name)
    }
    return result
  }

  const strategyReports: Record<string, any> = {}
  for (const name of STRATEGY_NAMES) {
    strategyReports[name] = {
      overall: computeStats(samples, name),
      byGameMode: breakdownBy((s) => s.gameMode, ['suit', 'all-trumps', 'no-trumps'], name),
      bySignalType: breakdownBy((s) => s.signalType, ['last-led-suit', 'repeated-suit', 'high-card-lead', 'key-card-drawn'], name),
      byLeadFollow: breakdownBy((s) => (s.isLead ? 'lead' : 'follow'), ['lead', 'follow'], name),
      byPositionInTrick: breakdownBy((s) => String(s.positionInTrick) as any, ['0', '1', '2', '3'], name),
      byPartnerCurrentlyWinning: breakdownBy((s) => String(s.partnerCurrentlyWinning) as any, ['true', 'false'], name),
      byOpponentCurrentlyWinning: breakdownBy((s) => String(s.opponentCurrentlyWinning) as any, ['true', 'false'], name),
      byPointsInTrickBucket: breakdownBy((s) => s.pointsInTrickBucket, ['0', '1-9', '10+'], name),
      byCleanWinnerAvailable: breakdownBy((s) => String(s.cleanWinnerAvailable) as any, ['true', 'false'], name),
      byShouldPreserve: breakdownBy((s) => String(s.chosenShouldPreserve) as any, ['true', 'false'], name),
    }
  }

  // ─── Best strategy (by exact-card accuracy among predicted, requiring meaningful coverage) ─
  const MIN_COVERAGE_FOR_RANKING = 0.05 // at least 5% coverage to be considered a serious candidate
  const rankable = STRATEGY_NAMES
    .map((name) => ({ name, stats: strategyReports[name].overall as ReturnType<typeof computeStats> }))
    .filter((r) => r.stats.predicted / Math.max(1, r.stats.eligible) >= MIN_COVERAGE_FOR_RANKING)
    .sort((a, b) => Number.parseFloat(b.stats.exactCardAccuracy) - Number.parseFloat(a.stats.exactCardAccuracy))
  const bestStrategy = rankable[0] ?? null

  // ─── Representative examples for the best strategy ──────────────────────
  function representativeExamples(name: StrategyName) {
    const withPrediction = samples.filter((s) => s.predictions[name]?.card)
    const correctExamples = withPrediction.filter((s) => s.predictions[name]!.card!.id === s.chosenCardId).slice(0, 5)
    const wrongExamples = withPrediction.filter((s) => s.predictions[name]!.card!.id !== s.chosenCardId).slice(0, 5)
    const fmt = (s: Sample) => ({
      gameMode: s.gameMode,
      signalType: s.signalType,
      predicted: s.predictions[name]!.card!.id,
      humanChose: s.chosenCardId,
      note: s.predictions[name]!.note,
    })
    return { correct: correctExamples.map(fmt), wrong: wrongExamples.map(fmt) }
  }

  const reportJson = {
    generatedAt: new Date().toISOString(),
    inputFiles: { archivePath, cardDecisionsPath: CARD_DECISIONS_PATH, modelV3Path: v3Model ? MODEL_V3_JSON_PATH : null },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    safetyValidation: { invalidPredictions: totalInvalidPredictions, predictionsNotInLegalCards: totalNotInLegalCards, predictionsNotInOwnHand: totalNotInOwnHand },
    dealsProcessed,
    missingJoinCount,
    noConventionalCount,
    eligibleSamples: samples.length,
    v3SkipReason,
    strategies: strategyReports,
    bestStrategy: bestStrategy ? { name: bestStrategy.name, stats: bestStrategy.stats } : null,
    representativeExamples: bestStrategy ? representativeExamples(bestStrategy.name as StrategyName) : null,
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(REPORT_JSON_PATH, JSON.stringify(reportJson, null, 2) + '\n', 'utf8')
  await writeFile(REPORT_MD_PATH, renderMarkdown(reportJson), 'utf8')

  console.log('Privacy/sanitization сканиране на generated files...')
  const outputViolations = [
    ...(await scanAllForbiddenContent(REPORT_JSON_PATH)),
    ...(await scanAllForbiddenContent(REPORT_MD_PATH)),
  ]
  if (outputViolations.length > 0) {
    console.error(`\n✗ Privacy нарушения в generated files:\n`)
    for (const v of outputViolations) console.error(`  [${v.pattern}] ${v.file}:${v.line}: ${v.snippet}`)
    process.exit(1)
    return
  }

  console.log('\n─────────────────────────────────────────')
  console.log('  Резултат')
  console.log('─────────────────────────────────────────')
  console.log(`  Eligible samples: ${samples.length}`)
  console.log(`  Safety: invalid=${totalInvalidPredictions}, notInLegalCards=${totalNotInLegalCards}, notInOwnHand=${totalNotInOwnHand}`)
  for (const name of STRATEGY_NAMES) {
    const s = strategyReports[name].overall
    console.log(`  ${name}: coverage=${s.coverage}, exact-card accuracy=${s.exactCardAccuracy}, red-flag=${s.redFlagRate}`)
  }
  console.log(`\n  Best strategy (coverage>=${pct(MIN_COVERAGE_FOR_RANKING * 100, 100)}): ${bestStrategy ? `${bestStrategy.name} (${bestStrategy.stats.exactCardAccuracy})` : 'none qualify'}`)
  console.log(`\n✓ Отчет: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет: ${REPORT_JSON_PATH}`)
  console.log('✓ Card-selection-within-suit evaluation завършен успешно.\n')
  process.exit(0)
}

function renderMarkdown(report: any): string {
  const lines: string[] = []
  lines.push('# Card-Selection-Within-Suit — Offline Evaluation Report')
  lines.push('')
  lines.push(`Генериран на: ${report.generatedAt}`)
  lines.push('')

  lines.push('## Executive summary')
  lines.push('')
  lines.push(
    'Изолира втория въпрос след Signal Memory advisor evaluator-а: "избора на правилната боя ≠ избора на ' +
    'правилната карта в тази боя." За всеки sample, където partner suit signal съществува, A-D advisor guard ' +
    'НЕ е override-нал, и човекът РЕАЛНО е върнал сигнализираната боя — сравнява 11 стратегии за коя точна ' +
    'карта в тази боя да се играе.',
  )
  lines.push('')
  if (report.bestStrategy) {
    lines.push(
      `**Най-добра стратегия: \`${report.bestStrategy.name}\`** — exact-card accuracy ${report.bestStrategy.stats.exactCardAccuracy} ` +
      `(coverage ${report.bestStrategy.stats.coverage}, red-flag rate ${report.bestStrategy.stats.redFlagRate}, n=${report.bestStrategy.stats.predicted}).`,
    )
  } else {
    lines.push('**Нито една стратегия не постигна достатъчно coverage за смислена класация.**')
  }
  lines.push('')
  lines.push(`Deals processed: ${report.dealsProcessed}, missing joins: ${report.missingJoinCount}, no-conventional: ${report.noConventionalCount}`)
  lines.push(`Eligible samples: ${report.eligibleSamples}`)
  if (report.v3SkipReason) lines.push(`⚠ card-model-v3 skipped: ${report.v3SkipReason}`)
  lines.push('')

  lines.push('## Safety validation')
  lines.push(`- Invalid predictions: ${report.safetyValidation.invalidPredictions} (изисква се 0)`)
  lines.push(`- Predictions not in legalCards: ${report.safetyValidation.predictionsNotInLegalCards} (изисква се 0)`)
  lines.push(`- Predictions not in ownHand: ${report.safetyValidation.predictionsNotInOwnHand} (изисква се 0)`)
  lines.push('')

  lines.push('## Strategy comparison (overall)')
  lines.push('')
  lines.push('| Strategy | Coverage | Exact-card accuracy | Accuracy (all eligible) | Red-flag rate |')
  lines.push('|---|---|---|---|---|')
  for (const [name, data] of Object.entries(report.strategies) as Array<[string, any]>) {
    const o = data.overall
    lines.push(`| ${name} | ${o.coverage} | ${o.exactCardAccuracy} | ${o.accuracyOfAllEligible} | ${o.redFlagRate} |`)
  }
  lines.push('')

  lines.push('## Breakdown по стратегия')
  lines.push('')
  for (const [name, data] of Object.entries(report.strategies) as Array<[string, any]>) {
    lines.push(`### ${name}`)
    lines.push('')
    lines.push(`Overall: coverage=${data.overall.coverage}, exact-card accuracy=${data.overall.exactCardAccuracy}, red-flag rate=${data.overall.redFlagRate} (predicted n=${data.overall.predicted}/${data.overall.eligible})`)
    lines.push('')
    const dims: Array<[string, string]> = [
      ['byGameMode', 'gameMode'],
      ['bySignalType', 'signalType'],
      ['byLeadFollow', 'lead/follow'],
      ['byPositionInTrick', 'positionInTrick'],
      ['byPartnerCurrentlyWinning', 'partnerCurrentlyWinning'],
      ['byOpponentCurrentlyWinning', 'opponentCurrentlyWinning'],
      ['byPointsInTrickBucket', 'pointsInTrick bucket'],
      ['byCleanWinnerAvailable', 'cleanWinnerAvailable'],
      ['byShouldPreserve', 'chosenCard.shouldPreserveCleanWinner'],
    ]
    for (const [key, label] of dims) {
      lines.push(`**${label}:**`)
      for (const [bucket, stats] of Object.entries(data[key]) as Array<[string, any]>) {
        if (stats.eligible === 0) continue
        lines.push(`- ${bucket}: coverage=${stats.coverage}, accuracy=${stats.exactCardAccuracy}, red-flag=${stats.redFlagRate} (n=${stats.predicted}/${stats.eligible})`)
      }
      lines.push('')
    }
  }

  if (report.representativeExamples) {
    lines.push(`## Representative examples (best strategy: ${report.bestStrategy.name})`)
    lines.push('')
    lines.push('### Correct predictions')
    for (const ex of report.representativeExamples.correct) {
      lines.push(`- gameMode=${ex.gameMode}, signalType=${ex.signalType}: predicted=${ex.predicted} (${ex.note}) — human chose ${ex.humanChose} ✓`)
    }
    lines.push('')
    lines.push('### Wrong predictions')
    for (const ex of report.representativeExamples.wrong) {
      lines.push(`- gameMode=${ex.gameMode}, signalType=${ex.signalType}: predicted=${ex.predicted} (${ex.note}) — human actually chose ${ex.humanChose} ✗`)
    }
    lines.push('')
  }

  lines.push('## Заключение — има ли кандидат за бъдещо Rule E2?')
  lines.push('')
  if (report.bestStrategy && Number.parseFloat(report.bestStrategy.stats.exactCardAccuracy) >= 50) {
    lines.push(
      `**Да, условен кандидат:** \`${report.bestStrategy.name}\` постига ${report.bestStrategy.stats.exactCardAccuracy} exact-card ` +
      `accuracy при ${report.bestStrategy.stats.coverage} coverage — над случаен избор сред typically 2-4 legal карти в боята. ` +
      'Все пак, преди какъвто и да е runtime опит, нужен е пълен Rule E2 offline evaluator (аналогичен на evaluateSignalMemoryAdvisor.ts), ' +
      'сравняващ advisor v0 vs advisor v0+Rule-E2 accuracy/red-flag rate на ниво ЦЯЛОТО decision (не само within-suit подмножеството тук).',
    )
  } else {
    lines.push(
      '**Няма силно offline доказателство.** Нито една стратегия не постигна убедителна exact-card accuracy с достатъчно coverage — ' +
      'card-selection-within-suit остава открит проблем. Не се препоръчва директно изграждане на Rule E2 върху която и да е от ' +
      'тези стратегии без допълнителна работа (напр. комбинирани/учени сигнали, а не единична евристика).',
    )
  }
  lines.push('')

  return lines.join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error('FATAL:', e instanceof Error ? e.stack ?? e.message : String(e))
    process.exit(2)
  })
}
