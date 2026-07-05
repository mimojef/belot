/**
 * evaluateSignalMemoryAdvisor.ts
 *
 * Offline, read-only evaluator for a PROPOSED "Rule E" (return_partner_signaled_suit)
 * on top of the existing advisor v0 guard rules (server/src/ai/cardAdvisorPolicy.ts,
 * rules A-D). This is NOT a runtime feature — it proves (or disproves) offline
 * whether Rule E would add value before any runtime wiring is even considered.
 *
 * Reuses, does not duplicate:
 *  - server/src/ai/cardAdvisorPolicy.ts's decideAdvisorCard() for the existing
 *    A-D guard rules (byte-identical to advisor v0 — same engine, not a copy).
 *  - server/scripts/analyzePartnerSignalMemory.ts's exported buildDealLedger()/
 *    detectPartnerSuitSignal()/detectPartnerTrumpDrawSignal() for cross-trick
 *    partner-signal reconstruction (same archive-reading approach, same signal
 *    definitions — no drift between the descriptive analysis and this evaluator).
 *  - server/scripts/evaluateCardAdvisor.ts's pattern for re-simulating the
 *    conventional bot's choice offline (read-only pickServerBotPlayCard import,
 *    minimal reconstructed ServerAuthoritativeGameState).
 *
 * Rule E logic (evaluated ONLY when A-D did not already override):
 *   1. Detect a partner suit-return signal (or, for lead decisions in a suit
 *      contract, a partner trump-draw-continuation signal) via the ledger.
 *   2. Require confidence >= threshold, and a legal card in the signaled suit.
 *   3. Suppress entirely (never fire, not even with reduced weight) if:
 *      - opponentCurrentlyWinning && pointsInTrick >= 10 (offline finding:
 *        return rate collapses to 24.6% in this state);
 *      - opponentCurrentlyWinning and every legal card of the signaled suit
 *        carries points (would feed the opponent points with no safe option);
 *      - partnerCurrentlyWinning and the best candidate would overtake partner;
 *      - the best candidate is itself a clean winner that should be preserved
 *        (mirrors advisor v0 Rule C's own semantics);
 *      - confidence is below threshold.
 *   4. If none of the above applies, fire with the SAFEST legal card of the
 *      signaled suit (lowest points, then lowest rank power) — never the
 *      highest-value card, since Rule E's job is a safe, conservative return,
 *      not a tactical strike.
 *
 * Does not touch gameplay, matchmaking, economy, client protocol, recorder
 * writer, pickServerBotPlayCard.ts, or localAiCardBeta.ts. Does not wire
 * anything into runtime — offline evaluation only.
 *
 * Usage:
 *   npm run evaluate:signal-memory-advisor   (от server/, след build:training-dataset)
 *
 * Exit codes:
 *   0 — успешно
 *   1 — invalid/missing input, privacy нарушение, schema грешка
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
  detectPartnerTrumpDrawSignal,
  type DealLedger,
  type SuitReturnSignal,
  type TrumpDrawSignal,
} from './analyzePartnerSignalMemory.js'
import { pickServerBotPlayCard } from '../src/game/pickServerBotPlayCard.js'
import { decideAdvisorCard, type AdvisorCandidateMemory, type AdvisorDecisionInput } from '../src/ai/cardAdvisorPolicy.js'
import { getServerCardPoints, type ServerScoringContract } from '../src/game/serverScoring.js'
import { getServerCardRankPower } from '../src/game/getServerTrickWinner.js'
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
const REPORT_JSON_PATH = join(REPORT_DIR, 'signal-memory-advisor-report.json')
const REPORT_MD_PATH = join(REPORT_DIR, 'signal-memory-advisor-report.md')

const CONFIDENCE_THRESHOLD_PRIMARY = 0.5
const CONFIDENCE_THRESHOLDS_SWEEP = [0.4, 0.5, 0.6]

function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

// ─── Minimal ServerAuthoritativeGameState reconstruction (same proven pattern ─
// as evaluateCardAdvisor.ts's buildMinimalState — re-simulates the conventional
// bot's choice offline, read-only import of pickServerBotPlayCard) ────────────

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

// ─── Rule E evaluation ────────────────────────────────────────────────────────

type RuleESignalType = 'last-led-suit' | 'repeated-suit' | 'high-card-lead' | 'key-card-drawn' | 'trump-draw'

type RuleEOutcome = {
  applicable: boolean
  fired: boolean
  suppressedReason: string | null
  signalType: RuleESignalType | null
  confidence: number | null
  finalCard: ServerCard | null
}

function notApplicable(): RuleEOutcome {
  return { applicable: false, fired: false, suppressedReason: null, signalType: null, confidence: null, finalCard: null }
}
function suppressed(reason: string, signalType: RuleESignalType, confidence: number): RuleEOutcome {
  return { applicable: true, fired: false, suppressedReason: reason, signalType, confidence, finalCard: null }
}
function fired(card: ServerCard, signalType: RuleESignalType, confidence: number): RuleEOutcome {
  return { applicable: true, fired: true, suppressedReason: null, signalType, confidence, finalCard: card }
}

function classifySuitSignalType(signal: SuitReturnSignal): RuleESignalType {
  if (signal.keyCardCleared) return 'key-card-drawn'
  if (signal.isHigh) return 'high-card-lead'
  if (signal.repeatCount > 1) return 'repeated-suit'
  return 'last-led-suit'
}

function cardPointsOf(c: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): number {
  return getServerCardPoints(c.suit, c.rank, contract, trumpSuit)
}
function rankPowerOf(c: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): number {
  return getServerCardRankPower(c.rank, isTrumpCard(c.suit, contract, trumpSuit))
}
function pickSafestCandidate(cards: ServerCard[], contract: ServerScoringContract, trumpSuit: ServerSuit | null): ServerCard {
  return cards.reduce((best, c) => {
    const cScore = cardPointsOf(c, contract, trumpSuit) * 10 + rankPowerOf(c, contract, trumpSuit)
    const bestScore = cardPointsOf(best, contract, trumpSuit) * 10 + rankPowerOf(best, contract, trumpSuit)
    return cScore < bestScore ? c : best
  })
}

function evaluateSuitReturnRuleE(
  row: CardRecordV2,
  signal: SuitReturnSignal,
  conventionalCard: ServerCard,
  confidenceThreshold: number,
): RuleEOutcome {
  const signalType = classifySuitSignalType(signal)
  if (conventionalCard.suit === signal.suit) return notApplicable() // nothing to change — advisor already matches
  const legalInSuit = (row.legalCards as ServerCard[]).filter((c) => c.suit === signal.suit)
  if (legalInSuit.length === 0) return notApplicable()
  if (signal.confidence < confidenceThreshold) return suppressed('low_confidence', signalType, signal.confidence)

  const contract = row.contract.contract as ServerScoringContract
  const trumpSuit = row.contract.trumpSuit as ServerSuit | null
  const memory = row.memory

  if (memory.opponentCurrentlyWinning && memory.pointsInTrick >= 10) {
    return suppressed('opponent_winning_high_points', signalType, signal.confidence)
  }

  const bestCandidate = pickSafestCandidate(legalInSuit, contract, trumpSuit)
  const zeroPointAlternativeExists = legalInSuit.some((c) => cardPointsOf(c, contract, trumpSuit) === 0)
  if (memory.opponentCurrentlyWinning && cardPointsOf(bestCandidate, contract, trumpSuit) > 0 && !zeroPointAlternativeExists) {
    return suppressed('would_feed_points_to_opponent', signalType, signal.confidence)
  }

  if (memory.partnerCurrentlyWinning && row.currentWinningCard) {
    const currentWinner = row.currentWinningCard as ServerCard
    const currentWinnerIsTrump = isTrumpCard(currentWinner.suit, contract, trumpSuit)
    const bestIsTrump = isTrumpCard(bestCandidate.suit, contract, trumpSuit)
    let wouldOvertake = false
    if (bestIsTrump && !currentWinnerIsTrump) wouldOvertake = true
    else if (bestIsTrump === currentWinnerIsTrump) {
      wouldOvertake = rankPowerOf(bestCandidate, contract, trumpSuit) > getServerCardRankPower(currentWinner.rank, currentWinnerIsTrump)
    }
    if (wouldOvertake) return suppressed('would_overtake_partner', signalType, signal.confidence)
  }

  const bestMemory = row.legalCardsMemoryFeatures.find((c) => c.id === bestCandidate.id)
  if (bestMemory?.candidateIsCleanWinner && bestMemory.shouldPreserveCleanWinner) {
    return suppressed('would_discard_clean_winner_unnecessarily', signalType, signal.confidence)
  }

  return fired(bestCandidate, signalType, signal.confidence)
}

function evaluateTrumpDrawRuleE(
  row: CardRecordV2,
  signal: TrumpDrawSignal,
  conventionalCard: ServerCard,
  confidenceThreshold: number,
): RuleEOutcome {
  if (signal.confidence < confidenceThreshold) return suppressed('low_confidence', 'trump-draw', signal.confidence)
  const trumpSuit = row.contract.trumpSuit as ServerSuit | null
  if (!trumpSuit) return notApplicable()
  if (conventionalCard.suit === trumpSuit) return notApplicable()
  const legalTrump = (row.legalCards as ServerCard[]).filter((c) => c.suit === trumpSuit)
  if (legalTrump.length === 0) return notApplicable()

  const contract = row.contract.contract as ServerScoringContract
  const bestCandidate = legalTrump.reduce((best, c) =>
    rankPowerOf(c, contract, trumpSuit) < rankPowerOf(best, contract, trumpSuit) ? c : best,
  )
  const bestMemory = row.legalCardsMemoryFeatures.find((c) => c.id === bestCandidate.id)
  if (bestMemory?.candidateIsCleanWinner && bestMemory.shouldPreserveCleanWinner) {
    return suppressed('would_discard_clean_winner_unnecessarily', 'trump-draw', signal.confidence)
  }

  return fired(bestCandidate, 'trump-draw', signal.confidence)
}

function evaluateRuleE(
  row: CardRecordV2,
  ledger: DealLedger,
  seat: Seat,
  partnerSeat: Seat,
  conventionalCard: ServerCard,
  confidenceThreshold: number,
): RuleEOutcome {
  const suitSignal = detectPartnerSuitSignal(ledger, partnerSeat, seat, row.trickIndex)
  if (suitSignal) return evaluateSuitReturnRuleE(row, suitSignal, conventionalCard, confidenceThreshold)

  if (row.contract.contract === 'suit' && row.positionInTrick === 0) {
    const trumpSignal = detectPartnerTrumpDrawSignal(ledger, partnerSeat, row.trickIndex)
    if (trumpSignal) return evaluateTrumpDrawRuleE(row, trumpSignal, conventionalCard, confidenceThreshold)
  }

  return notApplicable()
}

// ─── Decision-level outcome (conventional / v0 / v1 comparison) ─────────────

type DecisionOutcome = {
  gameMode: string
  conventionalCorrect: boolean
  v0Correct: boolean
  v1Correct: boolean
  v0Overrode: boolean
  ruleE: RuleEOutcome
  redFlag: boolean
  positiveSignal: boolean
  example: {
    gameMode: string
    signalType: RuleESignalType
    confidence: number
    conventionalCard: string
    v0Card: string
    v1Card: string
    humanChosenCard: string
    fired: boolean
    suppressedReason: string | null
  } | null
}

async function main(): Promise<void> {
  console.log('─────────────────────────────────────────')
  console.log('  Signal Memory Advisor v1 — offline evaluator (локален, read-only)')
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
  console.log('Реконструирам deal-level trick history, пускам advisor v0 (A-D) + Rule E...')

  const outcomes: DecisionOutcome[] = []
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

        const { state, seat } = buildMinimalState(row)
        const conventionalCardId = pickServerBotPlayCard(state, seat)?.id ?? null
        const conventionalCard = row.legalCards.find((c) => c.id === conventionalCardId) as ServerCard | undefined
        if (!conventionalCard) {
          noConventionalCount++
          continue
        }

        const candidateMemoryById = new Map<string, AdvisorCandidateMemory>()
        for (const c of row.legalCardsMemoryFeatures) {
          candidateMemoryById.set(c.id, { id: c.id, candidateIsCleanWinner: c.candidateIsCleanWinner, shouldPreserveCleanWinner: c.shouldPreserveCleanWinner })
        }

        const partnerSeat = getPartnerSeat(seat)
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

        let ruleE: RuleEOutcome = notApplicable()
        let v1Card = v0Result.finalCard

        // Rule E is only ever consulted when A-D did NOT already override.
        if (!v0Result.override) {
          ruleE = evaluateRuleE(row, ledger, seat, partnerSeat, conventionalCard, CONFIDENCE_THRESHOLD_PRIMARY)
          if (ruleE.fired && ruleE.finalCard) {
            v1Card = ruleE.finalCard
          }
        }

        const conventionalCorrect = conventionalCard.id === row.chosenCard.id
        const v0Correct = v0Result.finalCard.id === row.chosenCard.id
        const v1Correct = v1Card.id === row.chosenCard.id
        const redFlag = ruleE.fired && v0Correct
        const positiveSignal = ruleE.fired && !v0Correct && v1Correct

        outcomes.push({
          gameMode: row.contract.contract,
          conventionalCorrect,
          v0Correct,
          v1Correct,
          v0Overrode: v0Result.override,
          ruleE,
          redFlag,
          positiveSignal,
          example: ruleE.applicable && ruleE.signalType
            ? {
                gameMode: row.contract.contract,
                signalType: ruleE.signalType,
                confidence: Number((ruleE.confidence ?? 0).toFixed(2)),
                conventionalCard: conventionalCard.id,
                v0Card: v0Result.finalCard.id,
                v1Card: v1Card.id,
                humanChosenCard: row.chosenCard.id,
                fired: ruleE.fired,
                suppressedReason: ruleE.suppressedReason,
              }
            : null,
        })
      }
    }
  }

  console.log(`Обработени ${dealsProcessed} deals, ${missingJoinCount} missing joins, ${noConventionalCount} без conventional pick (пропуснати).`)
  console.log(`Non-forced decisions evaluated: ${outcomes.length}`)

  // ─── Sensitivity sweep (re-evaluate Rule E only, at different confidence thresholds) ─
  // Re-run is cheap relative to the full archive scan above only if we keep the raw
  // ledgers; for simplicity and to keep this script single-pass, the sweep below only
  // recomputes Rule E firing counts using the SAME per-decision `ruleE.confidence`
  // already captured at the primary threshold's applicability (ruleE.applicable=true
  // whenever a signal existed and a legal card was available, regardless of threshold).
  const applicableOutcomes = outcomes.filter((o) => o.ruleE.applicable)
  function sweepAt(threshold: number) {
    const fired = applicableOutcomes.filter((o) => (o.ruleE.confidence ?? 0) >= threshold && o.ruleE.suppressedReason !== 'would_feed_points_to_opponent' && o.ruleE.suppressedReason !== 'would_overtake_partner' && o.ruleE.suppressedReason !== 'would_discard_clean_winner_unnecessarily' && o.ruleE.suppressedReason !== 'opponent_winning_high_points')
    return { total: applicableOutcomes.length, firedAtThreshold: fired.length, rate: pct(fired.length, applicableOutcomes.length) }
  }
  const sensitivitySweep = CONFIDENCE_THRESHOLDS_SWEEP.map((t) => ({ threshold: t, ...sweepAt(t) }))

  // ─── Aggregate metrics ────────────────────────────────────────────────────
  const total = outcomes.length
  const ruleEEligible = outcomes.filter((o) => o.ruleE.applicable)
  const ruleEFired = outcomes.filter((o) => o.ruleE.fired)
  const ruleESuppressed = ruleEEligible.filter((o) => !o.ruleE.fired)

  function accuracy(field: 'conventionalCorrect' | 'v0Correct' | 'v1Correct') {
    const correct = outcomes.filter((o) => o[field]).length
    return { correct, total, rate: pct(correct, total) }
  }
  const conventionalAcc = accuracy('conventionalCorrect')
  const v0Acc = accuracy('v0Correct')
  const v1Acc = accuracy('v1Correct')

  const ruleEFiredCorrect = ruleEFired.filter((o) => o.v1Correct).length
  const ruleEAccuracyWhenFired = { total: ruleEFired.length, correct: ruleEFiredCorrect, rate: pct(ruleEFiredCorrect, ruleEFired.length) }

  const redFlagCount = outcomes.filter((o) => o.redFlag).length
  const positiveSignalCount = outcomes.filter((o) => o.positiveSignal).length
  const redFlagRate = pct(redFlagCount, ruleEFired.length)
  const positiveSignalRate = pct(positiveSignalCount, ruleEFired.length)

  function byGameMode() {
    const modes = ['suit', 'all-trumps', 'no-trumps']
    const result: Record<string, any> = {}
    for (const mode of modes) {
      const subset = outcomes.filter((o) => o.gameMode === mode)
      const fired = subset.filter((o) => o.ruleE.fired)
      const firedCorrect = fired.filter((o) => o.v1Correct).length
      result[mode] = {
        total: subset.length,
        v0Accuracy: pct(subset.filter((o) => o.v0Correct).length, subset.length),
        v1Accuracy: pct(subset.filter((o) => o.v1Correct).length, subset.length),
        ruleEFired: fired.length,
        ruleEAccuracyWhenFired: pct(firedCorrect, fired.length),
      }
    }
    return result
  }

  function bySignalType() {
    const types: RuleESignalType[] = ['last-led-suit', 'repeated-suit', 'high-card-lead', 'key-card-drawn', 'trump-draw']
    const result: Record<string, any> = {}
    for (const t of types) {
      const eligible = ruleEEligible.filter((o) => o.ruleE.signalType === t)
      const fired = eligible.filter((o) => o.ruleE.fired)
      const firedCorrect = fired.filter((o) => o.v1Correct).length
      const redFlags = fired.filter((o) => o.redFlag).length
      result[t] = {
        eligible: eligible.length,
        fired: fired.length,
        fireRate: pct(fired.length, eligible.length),
        accuracyWhenFired: pct(firedCorrect, fired.length),
        redFlagRate: pct(redFlags, fired.length),
      }
    }
    return result
  }

  function byConflict() {
    const conflictSuppressed = ruleEEligible.filter((o) =>
      o.ruleE.suppressedReason === 'opponent_winning_high_points'
      || o.ruleE.suppressedReason === 'would_feed_points_to_opponent'
      || o.ruleE.suppressedReason === 'would_overtake_partner'
      || o.ruleE.suppressedReason === 'would_discard_clean_winner_unnecessarily',
    )
    const noConflict = ruleEEligible.filter((o) => !conflictSuppressed.includes(o))
    return {
      conflictSuppressed: { total: conflictSuppressed.length },
      noConflict: {
        total: noConflict.length,
        fired: noConflict.filter((o) => o.ruleE.fired).length,
      },
    }
  }

  // ─── Success criteria (item 7) ────────────────────────────────────────────
  const netGain = v1Acc.correct - v0Acc.correct
  const overrideRate = pct(ruleEFired.length, total)
  const successCriteria = {
    v1AccuracyGteV0: v1Acc.correct >= v0Acc.correct,
    lowRedFlagRate: redFlagCount === 0 || (redFlagCount / Math.max(1, ruleEFired.length)) <= 0.3,
    sufficientSamples: ruleEFired.length >= 30,
    notSingleGameModeNoisy: (() => {
      const gm = byGameMode()
      const modesWithFires = Object.entries(gm).filter(([, v]: [string, any]) => v.ruleEFired > 0)
      if (modesWithFires.length <= 1) return false
      return modesWithFires.every(([, v]: [string, any]) => {
        const rate = Number.parseFloat(v.ruleEAccuracyWhenFired)
        return rate >= 40 // at least 40% accuracy when fired, in every mode it fires in
      })
    })(),
  }
  const allCriteriaMet = Object.values(successCriteria).every(Boolean)

  // ─── Representative examples ──────────────────────────────────────────────
  const goodExamples = outcomes.filter((o) => o.positiveSignal && o.example).slice(0, 6).map((o) => o.example)
  const badExamples = outcomes.filter((o) => o.redFlag && o.example).slice(0, 6).map((o) => o.example)
  const suppressedExamples = ruleESuppressed.filter((o) => o.example).slice(0, 6).map((o) => o.example)

  const reportJson = {
    generatedAt: new Date().toISOString(),
    inputFiles: { archivePath, cardDecisionsPath: CARD_DECISIONS_PATH },
    privacyValidation: { status: 'PASS', violationCount: 0 },
    dealsProcessed,
    missingJoinCount,
    noConventionalCount,
    confidenceThresholdPrimary: CONFIDENCE_THRESHOLD_PRIMARY,
    totals: {
      totalEvaluated: total,
      nonForcedEvaluated: total,
      ruleEEligibleCases: ruleEEligible.length,
      ruleEFiredCases: ruleEFired.length,
      ruleEOverrideRate: overrideRate,
    },
    accuracy: {
      conventionalAlone: conventionalAcc,
      advisorV0: v0Acc,
      advisorV1: v1Acc,
      netGain,
      ruleEAccuracyWhenFired,
    },
    redFlagRate: { count: redFlagCount, ofFired: ruleEFired.length, rate: redFlagRate },
    positiveSignalRate: { count: positiveSignalCount, ofFired: ruleEFired.length, rate: positiveSignalRate },
    byGameMode: byGameMode(),
    bySignalType: bySignalType(),
    byConflict: byConflict(),
    sensitivitySweep,
    successCriteria,
    allCriteriaMet,
    representativeExamples: { good: goodExamples, bad: badExamples, suppressed: suppressedExamples },
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
  console.log(`  Non-forced evaluated: ${total}`)
  console.log(`  Rule E eligible: ${ruleEEligible.length}, fired: ${ruleEFired.length} (${overrideRate})`)
  console.log(`  Conventional-alone accuracy: ${conventionalAcc.rate}`)
  console.log(`  Advisor v0 (A-D only) accuracy: ${v0Acc.rate}`)
  console.log(`  Advisor v1 (A-D + Rule E) accuracy: ${v1Acc.rate} (net ${netGain >= 0 ? '+' : ''}${netGain})`)
  console.log(`  Rule E accuracy when fired: ${ruleEAccuracyWhenFired.rate}`)
  console.log(`  Red-flag rate: ${redFlagRate}, positive-signal rate: ${positiveSignalRate}`)
  console.log(`  Success criteria met: ${allCriteriaMet ? 'YES' : 'NO'} (${JSON.stringify(successCriteria)})`)
  console.log(`\n✓ Отчет: ${REPORT_MD_PATH}`)
  console.log(`✓ Отчет: ${REPORT_JSON_PATH}`)
  console.log('✓ Signal Memory advisor v1 evaluation завършен успешно.\n')
  process.exit(0)
}

function renderMarkdown(report: any): string {
  const lines: string[] = []
  lines.push('# Signal Memory Advisor v1 — Offline Evaluation Report')
  lines.push('')
  lines.push(`Генериран на: ${report.generatedAt}`)
  lines.push('')
  lines.push(
    '**Local-only, offline, zero runtime risk.** Оценява предложено Rule E (`return_partner_signaled_suit`) ' +
    'на върха на advisor v0 (A-D), преди какъвто и да е runtime wiring. Rule E се консултира САМО когато A-D ' +
    'не са override-нали вече.',
  )
  lines.push('')
  lines.push(`Deals processed: ${report.dealsProcessed}, missing joins: ${report.missingJoinCount}, no-conventional: ${report.noConventionalCount}`)
  lines.push(`Confidence threshold (primary): ${report.confidenceThresholdPrimary}`)
  lines.push('')

  lines.push('## Totals')
  lines.push(`- Total evaluated (non-forced): ${report.totals.totalEvaluated}`)
  lines.push(`- Rule E eligible cases (signal detected + legal card available): ${report.totals.ruleEEligibleCases}`)
  lines.push(`- Rule E fired cases: ${report.totals.ruleEFiredCases}`)
  lines.push(`- Rule E override rate (спрямо total evaluated): ${report.totals.ruleEOverrideRate}`)
  lines.push('')

  lines.push('## Accuracy comparison')
  lines.push(`- Conventional-alone: ${report.accuracy.conventionalAlone.rate} (${report.accuracy.conventionalAlone.correct}/${report.accuracy.conventionalAlone.total})`)
  lines.push(`- Advisor v0 (A-D only): ${report.accuracy.advisorV0.rate} (${report.accuracy.advisorV0.correct}/${report.accuracy.advisorV0.total})`)
  lines.push(`- Advisor v1 (A-D + Rule E): ${report.accuracy.advisorV1.rate} (${report.accuracy.advisorV1.correct}/${report.accuracy.advisorV1.total})`)
  lines.push(`- Net gain/loss (v1 - v0, брой decisions): ${report.accuracy.netGain >= 0 ? '+' : ''}${report.accuracy.netGain}`)
  lines.push(`- Rule E accuracy when fired: ${report.accuracy.ruleEAccuracyWhenFired.rate} (${report.accuracy.ruleEAccuracyWhenFired.correct}/${report.accuracy.ruleEAccuracyWhenFired.total})`)
  lines.push('')

  lines.push('## Red-flag / positive-signal rate')
  lines.push(`- Red-flag rate (Rule E fired, human всъщност е избрал conventional/v0): ${report.redFlagRate.rate} (${report.redFlagRate.count}/${report.redFlagRate.ofFired})`)
  lines.push(`- Positive-signal rate (Rule E fired И съвпада с human choice, докато v0 не съвпадаше): ${report.positiveSignalRate.rate} (${report.positiveSignalRate.count}/${report.positiveSignalRate.ofFired})`)
  lines.push('')

  lines.push('## По gameMode')
  for (const [mode, v] of Object.entries(report.byGameMode) as Array<[string, any]>) {
    lines.push(`- ${mode}: total=${v.total}, v0 accuracy=${v.v0Accuracy}, v1 accuracy=${v.v1Accuracy}, Rule E fired=${v.ruleEFired}, accuracy when fired=${v.ruleEAccuracyWhenFired}`)
  }
  lines.push('')

  lines.push('## По signal type')
  for (const [type, v] of Object.entries(report.bySignalType) as Array<[string, any]>) {
    lines.push(`- ${type}: eligible=${v.eligible}, fired=${v.fired} (fire rate ${v.fireRate}), accuracy when fired=${v.accuracyWhenFired}, red-flag rate=${v.redFlagRate}`)
  }
  lines.push('')

  lines.push('## По conflict/no-conflict')
  lines.push(`- Conflict-suppressed (Rule E никога не fire-ва тук): ${report.byConflict.conflictSuppressed.total}`)
  lines.push(`- No-conflict eligible: ${report.byConflict.noConflict.total}, от които fired: ${report.byConflict.noConflict.fired}`)
  lines.push('')

  lines.push('## Sensitivity sweep (confidence threshold)')
  for (const s of report.sensitivitySweep) {
    lines.push(`- threshold>=${s.threshold}: ${s.firedAtThreshold}/${s.total} биха fire-нали (${s.rate})`)
  }
  lines.push('')

  lines.push('## Success criteria (item 7)')
  lines.push(`- Advisor v1 accuracy >= v0: ${report.successCriteria.v1AccuracyGteV0 ? '✓' : '✗'}`)
  lines.push(`- Red-flag rate достатъчно нисък (<=30% от fired, или 0 fired): ${report.successCriteria.lowRedFlagRate ? '✓' : '✗'}`)
  lines.push(`- Достатъчно samples (Rule E fired >= 30): ${report.successCriteria.sufficientSamples ? '✓' : '✗'}`)
  lines.push(`- НЕ работи само в 1 gameMode / не е шумна в другите: ${report.successCriteria.notSingleGameModeNoisy ? '✓' : '✗'}`)
  lines.push(`- **ВСИЧКИ критерии изпълнени: ${report.allCriteriaMet ? 'ДА' : 'НЕ'}**`)
  lines.push('')

  lines.push('## Representative examples (privacy-safe, без roomKey/playerKey/recordingId)')
  lines.push('')
  lines.push('### Добри Rule E override-и (positive signal)')
  for (const ex of report.representativeExamples.good) {
    lines.push(`- gameMode=${ex.gameMode}, signalType=${ex.signalType}, confidence=${ex.confidence}: conventional=${ex.conventionalCard} → v1=${ex.v1Card} (human избра ${ex.humanChosenCard}) ✓`)
  }
  lines.push('')
  lines.push('### Лоши Rule E override-и (red flag)')
  for (const ex of report.representativeExamples.bad) {
    lines.push(`- gameMode=${ex.gameMode}, signalType=${ex.signalType}, confidence=${ex.confidence}: conventional=${ex.conventionalCard} → v1=${ex.v1Card} (human всъщност избра ${ex.humanChosenCard} = conventional) ✗`)
  }
  lines.push('')
  lines.push('### Suppressed заради tactical conflict')
  for (const ex of report.representativeExamples.suppressed) {
    lines.push(`- gameMode=${ex.gameMode}, signalType=${ex.signalType}, confidence=${ex.confidence}, reason=${ex.suppressedReason}: conventional/v0 остана ${ex.v0Card} (human избра ${ex.humanChosenCard})`)
  }
  lines.push('')

  lines.push('## Препоръка')
  if (report.allCriteriaMet) {
    lines.push('Rule E покрива всички success criteria — кандидат за бъдещ runtime local beta test (изисква отделно одобрение преди wiring).')
  } else {
    lines.push('Rule E НЕ покрива всички success criteria в текущия си вид — не се препоръчва за runtime засега (виж кой критерий е неизпълнен по-горе).')
  }
  lines.push('')

  return lines.join('\n')
}

// Guard за бъдещ reuse (виж analyzePartnerSignalMemory.ts за същия bug клас, който
// причини — importing script модул изпълняваше неговия main() като side effect).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error('FATAL:', e instanceof Error ? e.stack ?? e.message : String(e))
    process.exit(2)
  })
}
