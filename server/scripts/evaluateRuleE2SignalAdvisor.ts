/**
 * evaluateRuleE2SignalAdvisor.ts
 *
 * Offline, read-only evaluator for a PROPOSED "Rule E2" (highest_in_suit
 * partner-signal return) on the FULL non-forced human card decision set —
 * not just the "human already returned the suit" subset that
 * evaluateCardSelectionWithinSuit.ts used to compare card-selection-within-suit
 * strategies. That evaluator found `highest_in_suit` to be the strongest
 * practical strategy (100% coverage, 71.4% exact-card accuracy) once a suit
 * return is already known to have happened — this evaluator asks the harder,
 * more honest question: if Rule E2 is wired as an actual advisor override
 * (deciding WHETHER to return the suit, not just which card to play once a
 * return is assumed), does it help or hurt overall decision accuracy, across
 * 8 conflict-suppression policy variants?
 *
 * Reuses, does not duplicate:
 *  - server/src/ai/cardAdvisorPolicy.ts's decideAdvisorCard() for the
 *    existing A-D guard rules (byte-identical engine, not a copy). Rule E2
 *    is only ever considered when A-D did NOT already override.
 *  - server/scripts/analyzePartnerSignalMemory.ts's exported buildDealLedger()/
 *    detectPartnerSuitSignal()/getPartnerSeat()/isTrumpCard() for cross-trick
 *    partner-signal reconstruction (same archive-reading approach, same
 *    signal definitions as the prior two evaluators — no drift).
 *  - server/scripts/evaluateSignalMemoryAdvisor.ts's pattern for
 *    re-simulating the conventional bot's choice offline (read-only
 *    pickServerBotPlayCard import, minimal reconstructed
 *    ServerAuthoritativeGameState) and for the red-flag/positive-signal
 *    accounting conventions established there.
 *
 * IMPORTANT (bug precedent — see analyzePartnerSignalMemory.ts's own header
 * comment): this script imports exported functions from
 * analyzePartnerSignalMemory.ts, which required an entry-point guard fix
 * earlier this session (importing it used to also execute its own main()/
 * process.exit() as an import side effect, racing with the importer). This
 * script follows the same guard convention for its own main(), in case a
 * future script ever imports from it.
 *
 * Does not touch gameplay, matchmaking, economy, client protocol, recorder
 * writer, pickServerBotPlayCard.ts, or localAiCardBeta.ts. Does not wire
 * anything into runtime — offline evaluation only.
 *
 * Usage:
 *   npm run evaluate:rule-e2-signal-advisor   (от server/, след build:training-dataset)
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
const REPORT_DIR = join(OUTPUT_DIR, 'signal-memory-advisor')
const REPORT_JSON_PATH = join(REPORT_DIR, 'rule-e2-signal-advisor-report.json')
const REPORT_MD_PATH = join(REPORT_DIR, 'rule-e2-signal-advisor-report.md')

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

// ─── Minimal ServerAuthoritativeGameState reconstruction (same proven pattern) ─

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

// ─── Small card helpers ────────────────────────────────────────────────────

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
function pickMaxBy(cards: ServerCard[], scoreOf: (c: ServerCard) => number): ServerCard {
  return cards.reduce((best, c) => (scoreOf(c) > scoreOf(best) ? c : best))
}

type SignalType = 'last-led-suit' | 'repeated-suit' | 'high-card-lead' | 'key-card-drawn'
function classifySignalType(signal: SuitReturnSignal): SignalType {
  if (signal.keyCardCleared) return 'key-card-drawn'
  if (signal.isHigh) return 'high-card-lead'
  if (signal.repeatCount > 1) return 'repeated-suit'
  return 'last-led-suit'
}

type ConfidenceBucket = '<0.5' | '0.5-0.69' | '0.7-0.84' | '>=0.85'
function confidenceBucketOf(confidence: number): ConfidenceBucket {
  if (confidence < 0.5) return '<0.5'
  if (confidence < 0.7) return '0.5-0.69'
  if (confidence < 0.85) return '0.7-0.84'
  return '>=0.85'
}

type PointsBucket = '0' | '1-9' | '10+'
function pointsBucketOf(points: number): PointsBucket {
  if (points <= 0) return '0'
  if (points <= 9) return '1-9'
  return '10+'
}

// ─── Rule E2 variants ─────────────────────────────────────────────────────────

type VariantName =
  | 'e2_raw_highest_in_suit'
  | 'e2_no_point_feed'
  | 'e2_no_overtake_partner'
  | 'e2_preserve_clean_winner'
  | 'e2_safe_combined'
  | 'e2_safe_combined_no_suit_contract'
  | 'e2_safe_combined_confidence_0_7'
  | 'e2_safe_combined_confidence_0_7_no_suit_contract'

const VARIANT_NAMES: VariantName[] = [
  'e2_raw_highest_in_suit',
  'e2_no_point_feed',
  'e2_no_overtake_partner',
  'e2_preserve_clean_winner',
  'e2_safe_combined',
  'e2_safe_combined_no_suit_contract',
  'e2_safe_combined_confidence_0_7',
  'e2_safe_combined_confidence_0_7_no_suit_contract',
]

type SuppressionFlags = {
  pointFeed: boolean
  overtakePartner: boolean
  spendPreservedCleanWinner: boolean
  lowConfidence: boolean
  suitContract: boolean
}

type VariantOutcome = { fired: boolean; suppressedReason: string | null }

function fired(): VariantOutcome {
  return { fired: true, suppressedReason: null }
}
function suppressedBy(reason: string): VariantOutcome {
  return { fired: false, suppressedReason: reason }
}

function evaluateVariant(name: VariantName, flags: SuppressionFlags): VariantOutcome {
  switch (name) {
    case 'e2_raw_highest_in_suit':
      return fired()

    case 'e2_no_point_feed':
      return flags.pointFeed ? suppressedBy('would_feed_points_to_opponent') : fired()

    case 'e2_no_overtake_partner':
      return flags.overtakePartner ? suppressedBy('would_overtake_partner') : fired()

    case 'e2_preserve_clean_winner':
      return flags.spendPreservedCleanWinner ? suppressedBy('would_spend_preserved_clean_winner') : fired()

    case 'e2_safe_combined':
      if (flags.pointFeed) return suppressedBy('would_feed_points_to_opponent')
      if (flags.overtakePartner) return suppressedBy('would_overtake_partner')
      if (flags.spendPreservedCleanWinner) return suppressedBy('would_spend_preserved_clean_winner')
      return fired()

    case 'e2_safe_combined_no_suit_contract':
      if (flags.pointFeed) return suppressedBy('would_feed_points_to_opponent')
      if (flags.overtakePartner) return suppressedBy('would_overtake_partner')
      if (flags.spendPreservedCleanWinner) return suppressedBy('would_spend_preserved_clean_winner')
      if (flags.suitContract) return suppressedBy('suit_contract_excluded')
      return fired()

    case 'e2_safe_combined_confidence_0_7':
      if (flags.pointFeed) return suppressedBy('would_feed_points_to_opponent')
      if (flags.overtakePartner) return suppressedBy('would_overtake_partner')
      if (flags.spendPreservedCleanWinner) return suppressedBy('would_spend_preserved_clean_winner')
      if (flags.lowConfidence) return suppressedBy('low_confidence')
      return fired()

    case 'e2_safe_combined_confidence_0_7_no_suit_contract':
      if (flags.pointFeed) return suppressedBy('would_feed_points_to_opponent')
      if (flags.overtakePartner) return suppressedBy('would_overtake_partner')
      if (flags.spendPreservedCleanWinner) return suppressedBy('would_spend_preserved_clean_winner')
      if (flags.lowConfidence) return suppressedBy('low_confidence')
      if (flags.suitContract) return suppressedBy('suit_contract_excluded')
      return fired()
  }
}

// ─── Sample record ─────────────────────────────────────────────────────────

type Sample = {
  gameMode: string
  signalType: SignalType | null
  confidenceBucket: ConfidenceBucket | null
  isLead: boolean
  positionInTrick: number
  partnerCurrentlyWinning: boolean
  opponentCurrentlyWinning: boolean
  pointsInTrickBucket: PointsBucket
  cleanWinnerAvailableInSuit: boolean
  candidateShouldPreserve: boolean | null
  conventionalCorrect: boolean
  v0Correct: boolean
  v0Overrode: boolean
  baseEligible: boolean // signal exists + legal card in suit + A-D did not override
  candidateCard: ServerCard | null
  chosenCardId: string
  conventionalCardId: string
  v0CardId: string
  legalIds: Set<string>
  ownHandIds: Set<string>
  suppressionFlags: SuppressionFlags | null
}

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Rule E2 Signal Advisor — offline evaluator (локален, read-only)')
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
  console.log('Реконструирам deal-level trick history, пускам advisor v0 (A-D) + Rule E2 candidate...')

  const samples: Sample[] = []
  let dealsProcessed = 0
  let missingJoinCount = 0
  let noConventionalCount = 0

  // Global safety counters (must be 0)
  let totalInvalidPredictions = 0
  let totalNotInLegalCards = 0
  let totalNotInOwnHand = 0

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
        if (row.legalCards.length <= 1) continue // forced — excluded, no real choice

        const seat = action.seat
        const partnerSeat = getPartnerSeat(seat)
        const contract = row.contract.contract as ServerScoringContract
        const trumpSuit = row.contract.trumpSuit as ServerSuit | null
        const legalIds = new Set(row.legalCards.map((c) => c.id))
        const ownHandIds = new Set(row.ownHand.map((c) => c.id))

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
          contract,
          trumpSuit,
          currentTrickPlays: row.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard })),
          legalCards: row.legalCards as ServerCard[],
          conventionalCard,
          partnerCurrentlyWinning: row.memory.partnerCurrentlyWinning,
          opponentCurrentlyWinning: row.memory.opponentCurrentlyWinning,
          pointsInTrick: row.memory.pointsInTrick,
          candidateMemoryById,
        }
        const v0Result = decideAdvisorCard(advisorInput)

        const conventionalCorrect = conventionalCard.id === row.chosenCard.id
        const v0Correct = v0Result.finalCard.id === row.chosenCard.id

        if (v0Result.override) {
          // A-D already decided — Rule E2 is suppressed_by_tactical_guard uniformly, no candidate to evaluate.
          samples.push({
            gameMode: contract,
            signalType: null,
            confidenceBucket: null,
            isLead: row.positionInTrick === 0,
            positionInTrick: row.positionInTrick,
            partnerCurrentlyWinning: row.memory.partnerCurrentlyWinning,
            opponentCurrentlyWinning: row.memory.opponentCurrentlyWinning,
            pointsInTrickBucket: pointsBucketOf(row.memory.pointsInTrick),
            cleanWinnerAvailableInSuit: false,
            candidateShouldPreserve: null,
            conventionalCorrect,
            v0Correct,
            v0Overrode: true,
            baseEligible: false,
            candidateCard: null,
            chosenCardId: row.chosenCard.id,
            conventionalCardId: conventionalCard.id,
            v0CardId: v0Result.finalCard.id,
            legalIds,
            ownHandIds,
            suppressionFlags: null,
          })
          continue
        }

        // A-D did not override — check for a partner suit signal.
        const signal = detectPartnerSuitSignal(ledger, partnerSeat, seat, row.trickIndex)
        if (!signal) {
          samples.push({
            gameMode: contract, signalType: null, confidenceBucket: null,
            isLead: row.positionInTrick === 0, positionInTrick: row.positionInTrick,
            partnerCurrentlyWinning: row.memory.partnerCurrentlyWinning, opponentCurrentlyWinning: row.memory.opponentCurrentlyWinning,
            pointsInTrickBucket: pointsBucketOf(row.memory.pointsInTrick), cleanWinnerAvailableInSuit: false, candidateShouldPreserve: null,
            conventionalCorrect, v0Correct, v0Overrode: false, baseEligible: false, candidateCard: null,
            chosenCardId: row.chosenCard.id, conventionalCardId: conventionalCard.id, v0CardId: v0Result.finalCard.id,
            legalIds, ownHandIds, suppressionFlags: null,
          })
          continue
        }

        const legalCardsInSuit = (row.legalCards as ServerCard[]).filter((c) => c.suit === signal.suit)
        if (legalCardsInSuit.length === 0) {
          samples.push({
            gameMode: contract, signalType: classifySignalType(signal), confidenceBucket: confidenceBucketOf(signal.confidence),
            isLead: row.positionInTrick === 0, positionInTrick: row.positionInTrick,
            partnerCurrentlyWinning: row.memory.partnerCurrentlyWinning, opponentCurrentlyWinning: row.memory.opponentCurrentlyWinning,
            pointsInTrickBucket: pointsBucketOf(row.memory.pointsInTrick), cleanWinnerAvailableInSuit: false, candidateShouldPreserve: null,
            conventionalCorrect, v0Correct, v0Overrode: false, baseEligible: false, candidateCard: null,
            chosenCardId: row.chosenCard.id, conventionalCardId: conventionalCard.id, v0CardId: v0Result.finalCard.id,
            legalIds, ownHandIds, suppressionFlags: null,
          })
          continue
        }

        // ── Base-eligible: compute Rule E2 candidate (highest_in_suit) ─────
        const candidate = pickMaxBy(legalCardsInSuit, (c) => rankPowerOf(c, contract, trumpSuit))

        // Safety validation (must always hold structurally; verify explicitly per spec)
        const inLegal = legalIds.has(candidate.id)
        const inOwnHand = ownHandIds.has(candidate.id)
        if (!inLegal) totalNotInLegalCards++
        if (!inOwnHand) totalNotInOwnHand++

        const memoryById = new Map(row.legalCardsMemoryFeatures.map((m) => [m.id, m]))
        const candidateMemory = memoryById.get(candidate.id)
        const cleanWinnerAvailableInSuit = legalCardsInSuit.some((c) => memoryById.get(c.id)?.candidateIsCleanWinner)
        const nonPreservedAlternativeExists = legalCardsInSuit.some((c) => c.id !== candidate.id && !memoryById.get(c.id)?.shouldPreserveCleanWinner)

        const suppressionFlags: SuppressionFlags = {
          pointFeed: row.memory.opponentCurrentlyWinning && (row.memory.pointsInTrick >= 10 || cardPointsOf(candidate, contract, trumpSuit) > 0),
          overtakePartner: row.memory.partnerCurrentlyWinning && wouldWinTrick(row, candidate) && row.memory.pointsInTrick < 10,
          spendPreservedCleanWinner: (candidateMemory?.shouldPreserveCleanWinner === true) && nonPreservedAlternativeExists,
          lowConfidence: signal.confidence < 0.7,
          suitContract: contract === 'suit',
        }

        samples.push({
          gameMode: contract,
          signalType: classifySignalType(signal),
          confidenceBucket: confidenceBucketOf(signal.confidence),
          isLead: row.positionInTrick === 0,
          positionInTrick: row.positionInTrick,
          partnerCurrentlyWinning: row.memory.partnerCurrentlyWinning,
          opponentCurrentlyWinning: row.memory.opponentCurrentlyWinning,
          pointsInTrickBucket: pointsBucketOf(row.memory.pointsInTrick),
          cleanWinnerAvailableInSuit,
          candidateShouldPreserve: candidateMemory?.shouldPreserveCleanWinner ?? false,
          conventionalCorrect,
          v0Correct,
          v0Overrode: false,
          baseEligible: true,
          candidateCard: candidate,
          chosenCardId: row.chosenCard.id,
          conventionalCardId: conventionalCard.id,
          v0CardId: v0Result.finalCard.id,
          legalIds,
          ownHandIds,
          suppressionFlags,
        })
      }
    }
  }

  console.log(`Обработени ${dealsProcessed} deals, ${missingJoinCount} missing joins, ${noConventionalCount} без conventional pick.`)
  console.log(`Total non-forced samples: ${samples.length}`)

  if (totalNotInLegalCards > 0 || totalNotInOwnHand > 0 || totalInvalidPredictions > 0) {
    console.error(`\n✗ SAFETY VIOLATION: invalid=${totalInvalidPredictions}, notInLegalCards=${totalNotInLegalCards}, notInOwnHand=${totalNotInOwnHand} — report СПРЯН.\n`)
    process.exit(1)
    return
  }

  const total = samples.length
  const baseEligible = samples.filter((s) => s.baseEligible)
  const adOverrideCount = samples.filter((s) => s.v0Overrode).length

  const conventionalAccuracyCount = samples.filter((s) => s.conventionalCorrect).length
  const v0AccuracyCount = samples.filter((s) => s.v0Correct).length
  const conventionalAccuracy = { correct: conventionalAccuracyCount, total, rate: pct(conventionalAccuracyCount, total) }
  const v0Accuracy = { correct: v0AccuracyCount, total, rate: pct(v0AccuracyCount, total) }

  // ─── Per-variant evaluation ──────────────────────────────────────────────
  function evaluateVariantOverSamples(name: VariantName) {
    let firedCount = 0
    let suppressedCount = 0
    let v1CorrectCount = 0
    let firedCorrectCount = 0
    let redFlagCount = 0
    let positiveSignalCount = 0
    let changedConventionalCount = 0

    const byGameMode: Record<string, any> = {}
    const bySignalType: Record<string, any> = {}
    const byConfidenceBucket: Record<string, any> = {}
    const byLeadFollow: Record<string, any> = {}
    const byPositionInTrick: Record<string, any> = {}
    const byPartnerWinning: Record<string, any> = {}
    const byOpponentWinning: Record<string, any> = {}
    const byPointsBucket: Record<string, any> = {}
    const byCleanWinnerAvailable: Record<string, any> = {}
    const byShouldPreserve: Record<string, any> = {}

    function bump(dim: Record<string, any>, key: string, fired: boolean, correct: boolean, redFlag: boolean) {
      dim[key] ??= { fired: 0, correct: 0, redFlag: 0 }
      if (fired) {
        dim[key].fired++
        if (correct) dim[key].correct++
        if (redFlag) dim[key].redFlag++
      }
    }

    for (const s of samples) {
      let v1Correct = s.v0Correct
      let thisFired = false
      let thisRedFlag = false

      if (s.baseEligible && s.candidateCard && s.suppressionFlags) {
        const outcome = evaluateVariant(name, s.suppressionFlags)
        if (outcome.fired) {
          firedCount++
          thisFired = true
          const candidateCorrect = s.candidateCard.id === s.chosenCardId
          v1Correct = candidateCorrect
          if (candidateCorrect) firedCorrectCount++
          if (s.candidateCard.id !== s.conventionalCardId) changedConventionalCount++
          if (s.conventionalCorrect) { redFlagCount++; thisRedFlag = true }
          if (!s.conventionalCorrect && candidateCorrect) positiveSignalCount++
        } else {
          suppressedCount++
        }
      }
      if (v1Correct) v1CorrectCount++

      bump(byGameMode, s.gameMode, thisFired, v1Correct, thisRedFlag)
      if (s.signalType) bump(bySignalType, s.signalType, thisFired, v1Correct, thisRedFlag)
      if (s.confidenceBucket) bump(byConfidenceBucket, s.confidenceBucket, thisFired, v1Correct, thisRedFlag)
      bump(byLeadFollow, s.isLead ? 'lead' : 'follow', thisFired, v1Correct, thisRedFlag)
      bump(byPositionInTrick, String(s.positionInTrick), thisFired, v1Correct, thisRedFlag)
      bump(byPartnerWinning, String(s.partnerCurrentlyWinning), thisFired, v1Correct, thisRedFlag)
      bump(byOpponentWinning, String(s.opponentCurrentlyWinning), thisFired, v1Correct, thisRedFlag)
      bump(byPointsBucket, s.pointsInTrickBucket, thisFired, v1Correct, thisRedFlag)
      if (s.baseEligible) bump(byCleanWinnerAvailable, String(s.cleanWinnerAvailableInSuit), thisFired, v1Correct, thisRedFlag)
      if (s.candidateShouldPreserve !== null) bump(byShouldPreserve, String(s.candidateShouldPreserve), thisFired, v1Correct, thisRedFlag)
    }

    const v0PlusVariantAccuracy = { correct: v1CorrectCount, total, rate: pct(v1CorrectCount, total) }
    const netDelta = v1CorrectCount - v0AccuracyCount

    function formatDim(dim: Record<string, any>) {
      const result: Record<string, any> = {}
      for (const [k, v] of Object.entries(dim)) {
        result[k] = { fired: v.fired, accuracyWhenFired: pct(v.correct, v.fired), redFlagRate: pct(v.redFlag, v.fired) }
      }
      return result
    }

    return {
      totalNonForcedSamples: total,
      ruleE2EligibleCount: baseEligible.length,
      ruleE2FiredCount: firedCount,
      ruleE2SuppressedCount: suppressedCount,
      overrideRate: pct(firedCount, total),
      conventionalAloneAccuracy: conventionalAccuracy,
      advisorV0Accuracy: v0Accuracy,
      advisorV0PlusVariantAccuracy: v0PlusVariantAccuracy,
      netDeltaVsV0: netDelta,
      accuracyWhenFired: pct(firedCorrectCount, firedCount),
      changedConventionalChoiceCount: changedConventionalCount,
      positiveSignalRate: pct(positiveSignalCount, firedCount),
      positiveSignalCount,
      redFlagRate: pct(redFlagCount, firedCount),
      redFlagCount,
      byGameMode: formatDim(byGameMode),
      bySignalType: formatDim(bySignalType),
      byConfidenceBucket: formatDim(byConfidenceBucket),
      byLeadFollow: formatDim(byLeadFollow),
      byPositionInTrick: formatDim(byPositionInTrick),
      byPartnerCurrentlyWinning: formatDim(byPartnerWinning),
      byOpponentCurrentlyWinning: formatDim(byOpponentWinning),
      byPointsInTrickBucket: formatDim(byPointsBucket),
      byCleanWinnerAvailable: formatDim(byCleanWinnerAvailable),
      byShouldPreserve: formatDim(byShouldPreserve),
    }
  }

  const variantReports: Record<string, any> = {}
  for (const name of VARIANT_NAMES) variantReports[name] = evaluateVariantOverSamples(name)

  const bestVariant = VARIANT_NAMES
    .map((name) => ({ name, netDelta: variantReports[name].netDeltaVsV0, redFlagRate: Number.parseFloat(variantReports[name].redFlagRate) }))
    .sort((a, b) => b.netDelta - a.netDelta || a.redFlagRate - b.redFlagRate)[0]!

  const reportJson = {
    generatedAt: new Date().toISOString(),
    inputFiles: { archivePath, cardDecisionsPath: CARD_DECISIONS_PATH },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    safetyValidation: { invalidPredictions: totalInvalidPredictions, predictionsNotInLegalCards: totalNotInLegalCards, predictionsNotInOwnHand: totalNotInOwnHand },
    dealsProcessed,
    missingJoinCount,
    noConventionalCount,
    totalNonForcedSamples: total,
    adOverrideCount,
    baseEligibleCount: baseEligible.length,
    variants: variantReports,
    bestVariant,
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
  console.log(`  Total non-forced: ${total}, base eligible: ${baseEligible.length}, A-D override: ${adOverrideCount}`)
  console.log(`  Conventional-alone accuracy: ${conventionalAccuracy.rate}`)
  console.log(`  Advisor v0 accuracy: ${v0Accuracy.rate}`)
  for (const name of VARIANT_NAMES) {
    const v = variantReports[name]
    console.log(`  ${name}: fired=${v.ruleE2FiredCount} (${v.overrideRate}), v0+variant=${v.advisorV0PlusVariantAccuracy.rate}, netΔ=${v.netDeltaVsV0 >= 0 ? '+' : ''}${v.netDeltaVsV0}, accWhenFired=${v.accuracyWhenFired}, redFlag=${v.redFlagRate}`)
  }
  console.log(`\n  Best variant (net delta, tie-break lower red-flag): ${bestVariant.name} (netΔ=${bestVariant.netDelta >= 0 ? '+' : ''}${bestVariant.netDelta})`)
  console.log(`\n✓ Отчет: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет: ${REPORT_JSON_PATH}`)
  console.log('✓ Rule E2 signal advisor evaluation завършен успешно.\n')
  process.exit(0)
}

function renderMarkdown(report: any): string {
  const lines: string[] = []
  lines.push('# Rule E2 Signal Advisor — Offline Evaluation Report')
  lines.push('')
  lines.push(`Генериран на: ${report.generatedAt}`)
  lines.push('')

  lines.push('## Executive summary')
  lines.push('')
  lines.push(
    'Сравнява advisor v0 (A-D) срещу advisor v0 + Rule E2 (`highest_in_suit` partner-signal return) на ниво ' +
    'ЦЯЛОТО non-forced decision set (не само подмножеството, където човекът вече е върнал боята) — 8 conflict-' +
    'suppression policy варианта.',
  )
  lines.push('')
  const bv = report.variants[report.bestVariant.name]
  lines.push(
    `**Най-добър variant: \`${report.bestVariant.name}\`** — net delta ${report.bestVariant.netDelta >= 0 ? '+' : ''}${report.bestVariant.netDelta} ` +
    `decisions, advisor v0+variant accuracy ${bv.advisorV0PlusVariantAccuracy.rate} (v0 baseline: ${bv.advisorV0Accuracy.rate}), ` +
    `red-flag rate ${bv.redFlagRate}, fired ${bv.ruleE2FiredCount} times (${bv.overrideRate} override rate).`,
  )
  lines.push('')
  lines.push('**Отговори на изричните въпроси:**')
  const anyPositive = Object.values(report.variants).some((v: any) => v.netDeltaVsV0 > 0)
  lines.push(`1. Има ли variant, който подобрява advisor v0 върху целия set? ${anyPositive ? '**Да**' : '**Не**'} (виж таблицата по-долу за точни delta стойности).`)
  lines.push(`2. Net delta на най-добрия variant: **${report.bestVariant.netDelta >= 0 ? '+' : ''}${report.bestVariant.netDelta}** decisions от ${report.totalNonForcedSamples}.`)
  lines.push(`3. Red-flag rate на най-добрия variant: **${bv.redFlagRate}**.`)
  const noSuitVariant = report.variants['e2_safe_combined_no_suit_contract']
  const safeCombined = report.variants['e2_safe_combined']
  lines.push(
    `4-5. Работи ли по-добре само в all-trumps/no-trumps? Сравни \`e2_safe_combined\` (netΔ=${safeCombined.netDeltaVsV0}) ` +
    `срещу \`e2_safe_combined_no_suit_contract\` (netΔ=${noSuitVariant.netDeltaVsV0}) — виж by-gameMode breakdown-а за variant-ите по-долу.`,
  )
  const conf07 = report.variants['e2_safe_combined_confidence_0_7']
  lines.push(`6. Помага ли confidence>=0.7 праг? Сравни \`e2_safe_combined\` (netΔ=${safeCombined.netDeltaVsV0}) срещу \`e2_safe_combined_confidence_0_7\` (netΔ=${conf07.netDeltaVsV0}).`)
  lines.push('7-8. Виж "By signal type" breakdown-а за най-добрия variant по-долу за кои signal types помагат/вредят, и заключителната секция за runtime препоръка.')
  lines.push('')

  lines.push(`Deals processed: ${report.dealsProcessed}, missing joins: ${report.missingJoinCount}, no-conventional: ${report.noConventionalCount}`)
  lines.push(`Total non-forced samples: ${report.totalNonForcedSamples}, A-D override count: ${report.adOverrideCount}, base Rule E2 eligible: ${report.baseEligibleCount}`)
  lines.push('')

  lines.push('## Safety validation')
  lines.push(`- Invalid predictions: ${report.safetyValidation.invalidPredictions} (изисква се 0)`)
  lines.push(`- Predictions not in legalCards: ${report.safetyValidation.predictionsNotInLegalCards} (изисква се 0)`)
  lines.push(`- Predictions not in ownHand: ${report.safetyValidation.predictionsNotInOwnHand} (изисква се 0)`)
  lines.push('')

  lines.push('## Variant comparison (overall)')
  lines.push('')
  lines.push('| Variant | Fired | Override rate | v0+variant accuracy | Net Δ vs v0 | Acc. when fired | Positive-signal | Red-flag |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const name of Object.keys(report.variants)) {
    const v = report.variants[name]
    lines.push(`| ${name} | ${v.ruleE2FiredCount} | ${v.overrideRate} | ${v.advisorV0PlusVariantAccuracy.rate} | ${v.netDeltaVsV0 >= 0 ? '+' : ''}${v.netDeltaVsV0} | ${v.accuracyWhenFired} | ${v.positiveSignalRate} | ${v.redFlagRate} |`)
  }
  lines.push('')
  lines.push(`Baseline: conventional-alone ${report.variants[Object.keys(report.variants)[0]!].conventionalAloneAccuracy.rate}, advisor v0 ${report.variants[Object.keys(report.variants)[0]!].advisorV0Accuracy.rate}`)
  lines.push('')

  lines.push('## Breakdown по variant')
  lines.push('')
  for (const name of Object.keys(report.variants)) {
    const v = report.variants[name]
    lines.push(`### ${name}`)
    lines.push('')
    lines.push(`Eligible=${report.baseEligibleCount}, fired=${v.ruleE2FiredCount}, suppressed=${v.ruleE2SuppressedCount}, changed conventional choice=${v.changedConventionalChoiceCount}`)
    lines.push('')
    const dims: Array<[string, string]> = [
      ['byGameMode', 'gameMode'],
      ['bySignalType', 'signalType'],
      ['byConfidenceBucket', 'confidence bucket'],
      ['byLeadFollow', 'lead/follow'],
      ['byPositionInTrick', 'positionInTrick'],
      ['byPartnerCurrentlyWinning', 'partnerCurrentlyWinning'],
      ['byOpponentCurrentlyWinning', 'opponentCurrentlyWinning'],
      ['byPointsInTrickBucket', 'pointsInTrick bucket'],
      ['byCleanWinnerAvailable', 'cleanWinnerAvailableInSuit'],
      ['byShouldPreserve', 'candidate.shouldPreserveCleanWinner'],
    ]
    for (const [key, label] of dims) {
      const bucket = v[key]
      const nonZero = Object.entries(bucket).filter(([, s]: [string, any]) => s.fired > 0)
      if (nonZero.length === 0) continue
      lines.push(`**${label}** (само fired>0 buckets):`)
      for (const [bk, s] of nonZero as Array<[string, any]>) {
        lines.push(`- ${bk}: fired=${s.fired}, accuracy=${s.accuracyWhenFired}, red-flag=${s.redFlagRate}`)
      }
      lines.push('')
    }
  }

  lines.push('## Заключение — има ли реален кандидат за runtime Rule E2?')
  lines.push('')
  if (report.bestVariant.netDelta > 0 && Number.parseFloat(bv.redFlagRate) <= 30) {
    lines.push(
      `**Условно да.** \`${report.bestVariant.name}\` показва net-положителен ефект (+${report.bestVariant.netDelta} decisions) ` +
      `с приемлив red-flag rate (${bv.redFlagRate}). Все пак override rate-ът (${bv.overrideRate}) и абсолютният net delta трябва ` +
      'да се преценят спрямо практическата значимост (колко решения реално се засягат) преди какъвто и да е runtime опит — ' +
      'препоръчва се local beta trace тест (аналогичен на предишните local beta сесии) преди wiring.',
    )
  } else {
    lines.push(
      '**Не, няма достатъчно силно offline доказателство.** Нито един variant не показа едновременно net-положителен ефект ' +
      'И приемлив red-flag rate върху целия non-forced set. Rule E2 остава неготова за runtime — виж таблицата по-горе за ' +
      'точните числа зад това заключение.',
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
