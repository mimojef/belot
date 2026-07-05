/**
 * cardAdvisorSignalRuleE2.ts
 *
 * Pure, side-effect-free OBSERVATIONAL helper for a proposed "Rule E2"
 * (`e2_no_point_feed` variant, `highest_in_suit` partner-signal-return
 * strategy) — proven offline in server/scripts/evaluateRuleE2SignalAdvisor.ts
 * to be the first Rule E variant with a genuinely net-positive effect
 * (advisor v0 52.0% → v0+e2_no_point_feed 53.1%, +205/18299 decisions), but
 * still carrying a non-trivial red-flag rate (30.9%) — NOT yet proven enough
 * for a real runtime override.
 *
 * This module NEVER selects the bot's actual card. It only computes "what
 * would Rule E2 have suggested, and why (not) — for local beta TRACING, so a
 * future decision about wiring it as a real override can be made from real
 * gameplay observation data, not just the offline dataset. See
 * server/src/ai/localAiCardBeta.ts for the (trace-only) call site.
 *
 * Ported (not imported) from server/scripts/analyzePartnerSignalMemory.ts's
 * buildDealLedger()/detectPartnerSuitSignal() and
 * server/scripts/evaluateRuleE2SignalAdvisor.ts's `e2_no_point_feed` variant
 * logic: the offline versions operate on `TrainingDealRecord.tricks`
 * (recorder archive shape); this one operates on live
 * `state.playing.completedTricks` (`ServerCompletedTrick[]`) — same
 * information (which cards were played, by whom, in which earlier trick —
 * already fully public), different source shape, and `server/scripts/`
 * cannot be imported from `server/src/` (rootDir boundary, see
 * cardAdvisorMemory.ts's own header for the same constraint). The signal
 * detection algorithm (confidence formula, decay, isHigh/isLow/repeatCount/
 * keyCardCleared weighting) is kept byte-for-byte identical to the offline
 * version so this trace can be directly compared against the offline report.
 *
 * Reuses (does not duplicate) server/src/ai/cardAdvisorMemory.ts's
 * buildAdvisorRuntimeMemory() and server/src/ai/cardAdvisorPolicy.ts's
 * decideAdvisorCard() for the "would advisor v0 (A-D) already have handled
 * this?" shadow check — computed independently of whatever the caller's
 * actual policyMode/aiEnabled state is, so this module works standalone even
 * when the live decision took the 'model' policy path or the AI flag is off
 * entirely (purely for observational completeness in the trace).
 */

import { getServerCardPoints, type ServerScoringContract } from '../game/serverScoring.js'
import { getServerCardRankPower } from '../game/getServerTrickWinner.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerSuit, ServerTrickPlay } from '../game/serverGameTypes.js'
import type { Seat } from '../core/serverTypes.js'
import { buildAdvisorRuntimeMemory } from './cardAdvisorMemory.js'
import { decideAdvisorCard, type AdvisorDecisionInput } from './cardAdvisorPolicy.js'

// ─── Public types ─────────────────────────────────────────────────────────────

export type RuleE2SignalType = 'last-led-suit' | 'repeated-suit' | 'high-card-lead' | 'key-card-drawn'

export type RuleE2SuppressionReason =
  | 'no_partner_signal'
  | 'tactical_guard_already_applied'
  | 'no_legal_card_in_signal_suit'
  | 'opponent_winning_10_plus_points'
  | 'would_feed_points_to_opponent'
  | 'invalid_suggestion'
  | 'not_applicable'

export type RuleE2ObservationResult = {
  wouldEvaluate: boolean
  wouldFire: boolean
  suggestedCard: string | null
  signalSuit: string | null
  signalType: RuleE2SignalType | null
  signalConfidence: number | null
  strategy: 'highest_in_suit'
  variant: 'e2_no_point_feed'
  suppressionReason: RuleE2SuppressionReason | null
  /** Shadow advisor v0 (A-D) result's finalCard id, computed internally regardless of the caller's actual policyMode — lets the caller diff its OWN finalCard against "what advisor v0 alone would have done" without recomputing it. */
  advisorV0CardId: string | null
  safety: { suggestionInLegalCards: boolean; suggestionInOwnHand: boolean }
}

export type RuleE2ObservationInput = {
  state: ServerAuthoritativeGameState
  seat: Seat
  partnerSeat: Seat
  legalCards: ServerCard[]
  ownHand: ServerCard[]
  contract: ServerScoringContract
  trumpSuit: ServerSuit | null
  currentTrickPlays: ServerTrickPlay[]
}

// ─── Not-applicable / fallback result builders ──────────────────────────────

function notApplicable(reason: RuleE2SuppressionReason, advisorV0CardId: string | null = null): RuleE2ObservationResult {
  return {
    wouldEvaluate: reason !== 'not_applicable',
    wouldFire: false,
    suggestedCard: null,
    signalSuit: null,
    signalType: null,
    signalConfidence: null,
    strategy: 'highest_in_suit',
    variant: 'e2_no_point_feed',
    suppressionReason: reason,
    advisorV0CardId,
    safety: { suggestionInLegalCards: true, suggestionInOwnHand: true },
  }
}

// ─── Runtime signal ledger (port of analyzePartnerSignalMemory.ts's buildDealLedger, ─
// suit-lead subset only — this variant never needs trump-lead/void tracking) ──

type RuntimeSuitLeadEvent = { trickIndex: number; suit: ServerSuit; rank: string; rankPower: number; isHigh: boolean; isLow: boolean }
type RuntimeSuitPlayEvent = { trickIndex: number; suit: ServerSuit }
type RuntimeSignalLedger = {
  suitLeadsBySeat: Record<Seat, RuntimeSuitLeadEvent[]>
  suitPlaysBySeat: Record<Seat, RuntimeSuitPlayEvent[]>
  keyCardClearedTrickBySuit: Partial<Record<ServerSuit, number>>
}

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']
function emptySeatRecord<T>(factory: () => T): Record<Seat, T> {
  return { bottom: factory(), right: factory(), top: factory(), left: factory() }
}

function isTrumpCardLocal(suit: ServerSuit, contract: ServerScoringContract, trumpSuit: ServerSuit | null): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'no-trumps') return false
  return trumpSuit !== null && suit === trumpSuit
}

const HIGH_RANK_POWER_THRESHOLD = 5
const LOW_RANK_POWER_THRESHOLD = 1

function buildRuntimeSignalLedger(
  state: ServerAuthoritativeGameState,
  contract: ServerScoringContract,
  trumpSuit: ServerSuit | null,
): RuntimeSignalLedger {
  const ledger: RuntimeSignalLedger = {
    suitLeadsBySeat: emptySeatRecord(() => []),
    suitPlaysBySeat: emptySeatRecord(() => []),
    keyCardClearedTrickBySuit: {},
  }

  const completedTricks = state.playing?.completedTricks ?? []
  const tricksSorted = [...completedTricks].sort((a, b) => a.trickIndex - b.trickIndex)
  const suitLedBefore = new Set<ServerSuit>()

  for (const trick of tricksSorted) {
    if (trick.plays.length === 0) continue
    const ledSuit = trick.plays[0]!.card.suit
    const leadCard = trick.plays[0]!.card
    const isTrumpLead = isTrumpCardLocal(ledSuit, contract, trumpSuit)
    const rankPower = getServerCardRankPower(leadCard.rank, isTrumpLead)

    ledger.suitLeadsBySeat[trick.leaderSeat]!.push({
      trickIndex: trick.trickIndex,
      suit: ledSuit,
      rank: leadCard.rank,
      rankPower,
      isHigh: rankPower >= HIGH_RANK_POWER_THRESHOLD,
      isLow: rankPower <= LOW_RANK_POWER_THRESHOLD,
    })

    const topRank = isTrumpCardLocal(ledSuit, contract, trumpSuit) ? 'J' : 'A'
    let keyCardPlayedThisTrick = false
    for (const play of trick.plays) {
      ledger.suitPlaysBySeat[play.seat]!.push({ trickIndex: trick.trickIndex, suit: play.card.suit })
      if (play.card.suit === ledSuit && play.card.rank === topRank) keyCardPlayedThisTrick = true
    }

    if (keyCardPlayedThisTrick && suitLedBefore.has(ledSuit) && ledger.keyCardClearedTrickBySuit[ledSuit] === undefined) {
      ledger.keyCardClearedTrickBySuit[ledSuit] = trick.trickIndex
    }
    suitLedBefore.add(ledSuit)
  }

  return ledger
}

type RuntimeSuitReturnSignal = {
  suit: ServerSuit
  signalTrickIndex: number
  isHigh: boolean
  isLow: boolean
  repeatCount: number
  keyCardCleared: boolean
  confidence: number
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function classifySignalType(signal: RuntimeSuitReturnSignal): RuleE2SignalType {
  if (signal.keyCardCleared) return 'key-card-drawn'
  if (signal.isHigh) return 'high-card-lead'
  if (signal.repeatCount > 1) return 'repeated-suit'
  return 'last-led-suit'
}

/**
 * Byte-for-byte port of analyzePartnerSignalMemory.ts's detectPartnerSuitSignal
 * confidence formula (base 0.5, +0.2 high / -0.1 low, +0.15 per repeat capped
 * at +0.3, +0.1 key-card-cleared, decayed 0.9^tricksSinceSignal) — kept
 * identical so this runtime trace is directly comparable to the offline report.
 */
function detectPartnerSuitSignalRuntime(
  ledger: RuntimeSignalLedger,
  partnerSeat: Seat,
  actingSeat: Seat,
  actionTrickIndex: number,
): RuntimeSuitReturnSignal | null {
  const leadsBeforeNow = ledger.suitLeadsBySeat[partnerSeat]!.filter((e) => e.trickIndex < actionTrickIndex)
  if (leadsBeforeNow.length === 0) return null

  for (let i = leadsBeforeNow.length - 1; i >= 0; i--) {
    const candidate = leadsBeforeNow[i]!
    const alreadyReturned = ledger.suitPlaysBySeat[actingSeat]!.some(
      (p) => p.suit === candidate.suit && p.trickIndex > candidate.trickIndex && p.trickIndex < actionTrickIndex,
    )
    if (alreadyReturned) continue

    const repeatCount = leadsBeforeNow.filter((e) => e.suit === candidate.suit).length
    const keyCardCleared = ledger.keyCardClearedTrickBySuit[candidate.suit] !== undefined
      && ledger.keyCardClearedTrickBySuit[candidate.suit]! < actionTrickIndex

    let confidence = 0.5
    if (candidate.isHigh) confidence += 0.2
    if (candidate.isLow) confidence -= 0.1
    confidence += Math.min(0.3, (repeatCount - 1) * 0.15)
    if (keyCardCleared) confidence += 0.1
    const decay = Math.pow(0.9, Math.max(0, actionTrickIndex - candidate.trickIndex - 1))
    confidence = clamp01(confidence * decay)

    return { suit: candidate.suit, signalTrickIndex: candidate.trickIndex, isHigh: candidate.isHigh, isLow: candidate.isLow, repeatCount, keyCardCleared, confidence }
  }
  return null
}

function pickMaxBy(cards: ServerCard[], scoreOf: (c: ServerCard) => number): ServerCard {
  return cards.reduce((best, c) => (scoreOf(c) > scoreOf(best) ? c : best))
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Observational-only Rule E2 (`e2_no_point_feed` variant) evaluation. Never
 * throws by design (defensive try/catch around the one call site in
 * localAiCardBeta.ts still applies as an extra safety net) — but every
 * internal step is a pure computation over already-validated inputs, so this
 * should not realistically throw.
 */
export function observeRuleE2NoPointFeed(input: RuleE2ObservationInput): RuleE2ObservationResult {
  const { state, seat, partnerSeat, legalCards, ownHand, contract, trumpSuit, currentTrickPlays } = input

  if (legalCards.length <= 1) {
    return notApplicable('not_applicable')
  }

  // Shadow advisor v0 (A-D) check — computed independently of the caller's
  // actual policyMode, purely so this module can report
  // 'tactical_guard_already_applied' and advisorV0CardId regardless of
  // whether the live decision is even using the advisor at all.
  const memory = buildAdvisorRuntimeMemory(state, seat, partnerSeat, contract, trumpSuit, ownHand, legalCards, currentTrickPlays)
  const conventionalCardForShadow = legalCards[0]! // shadow check only needs SOME legal card to seed decideAdvisorCard's conventionalCard slot fairly; A-D rules never depend on which one is passed as "conventional" beyond comparing it against alternatives already in legalCards
  const advisorInput: AdvisorDecisionInput = {
    seat,
    partnerSeat,
    positionInTrick: currentTrickPlays.length,
    contract,
    trumpSuit,
    currentTrickPlays,
    legalCards,
    conventionalCard: conventionalCardForShadow,
    partnerCurrentlyWinning: memory.partnerCurrentlyWinning,
    opponentCurrentlyWinning: memory.opponentCurrentlyWinning,
    pointsInTrick: memory.pointsInTrick,
    candidateMemoryById: memory.candidateMemoryById,
  }
  const shadowV0 = decideAdvisorCard(advisorInput)

  const trickIndex = state.playing?.currentTrick?.trickIndex ?? state.currentTrick.trickIndex

  const ledger = buildRuntimeSignalLedger(state, contract, trumpSuit)
  const signal = detectPartnerSuitSignalRuntime(ledger, partnerSeat, seat, trickIndex)
  if (!signal) {
    return notApplicable('no_partner_signal', shadowV0.finalCard.id)
  }

  if (shadowV0.override) {
    return {
      wouldEvaluate: true,
      wouldFire: false,
      suggestedCard: null,
      signalSuit: signal.suit,
      signalType: classifySignalType(signal),
      signalConfidence: signal.confidence,
      strategy: 'highest_in_suit',
      variant: 'e2_no_point_feed',
      suppressionReason: 'tactical_guard_already_applied',
      advisorV0CardId: shadowV0.finalCard.id,
      safety: { suggestionInLegalCards: true, suggestionInOwnHand: true },
    }
  }

  const legalCardsInSuit = legalCards.filter((c) => c.suit === signal.suit)
  const signalType = classifySignalType(signal)
  if (legalCardsInSuit.length === 0) {
    return {
      wouldEvaluate: true, wouldFire: false, suggestedCard: null,
      signalSuit: signal.suit, signalType, signalConfidence: signal.confidence,
      strategy: 'highest_in_suit', variant: 'e2_no_point_feed',
      suppressionReason: 'no_legal_card_in_signal_suit',
      advisorV0CardId: shadowV0.finalCard.id,
      safety: { suggestionInLegalCards: true, suggestionInOwnHand: true },
    }
  }

  const candidate = pickMaxBy(legalCardsInSuit, (c) => getServerCardRankPower(c.rank, isTrumpCardLocal(c.suit, contract, trumpSuit)))
  const candidatePoints = getServerCardPoints(candidate.suit, candidate.rank, contract, trumpSuit)

  if (memory.opponentCurrentlyWinning && memory.pointsInTrick >= 10) {
    return {
      wouldEvaluate: true, wouldFire: false, suggestedCard: null,
      signalSuit: signal.suit, signalType, signalConfidence: signal.confidence,
      strategy: 'highest_in_suit', variant: 'e2_no_point_feed',
      suppressionReason: 'opponent_winning_10_plus_points',
      advisorV0CardId: shadowV0.finalCard.id,
      safety: { suggestionInLegalCards: true, suggestionInOwnHand: true },
    }
  }
  if (memory.opponentCurrentlyWinning && candidatePoints > 0) {
    return {
      wouldEvaluate: true, wouldFire: false, suggestedCard: null,
      signalSuit: signal.suit, signalType, signalConfidence: signal.confidence,
      strategy: 'highest_in_suit', variant: 'e2_no_point_feed',
      suppressionReason: 'would_feed_points_to_opponent',
      advisorV0CardId: shadowV0.finalCard.id,
      safety: { suggestionInLegalCards: true, suggestionInOwnHand: true },
    }
  }

  const legalIds = new Set(legalCards.map((c) => c.id))
  const ownHandIds = new Set(ownHand.map((c) => c.id))
  const suggestionInLegalCards = legalIds.has(candidate.id)
  const suggestionInOwnHand = ownHandIds.has(candidate.id)

  if (!suggestionInLegalCards || !suggestionInOwnHand) {
    // Defensive — should be structurally impossible (candidate ∈ legalCardsInSuit ⊆ legalCards ⊆ ownHand),
    // but never trust an invalid suggestion even for a trace-only observation.
    return {
      wouldEvaluate: true, wouldFire: false, suggestedCard: null,
      signalSuit: signal.suit, signalType, signalConfidence: signal.confidence,
      strategy: 'highest_in_suit', variant: 'e2_no_point_feed',
      suppressionReason: 'invalid_suggestion',
      advisorV0CardId: shadowV0.finalCard.id,
      safety: { suggestionInLegalCards, suggestionInOwnHand },
    }
  }

  return {
    wouldEvaluate: true,
    wouldFire: true,
    suggestedCard: candidate.id,
    signalSuit: signal.suit,
    signalType,
    signalConfidence: signal.confidence,
    strategy: 'highest_in_suit',
    variant: 'e2_no_point_feed',
    suppressionReason: null,
    advisorV0CardId: shadowV0.finalCard.id,
    safety: { suggestionInLegalCards, suggestionInOwnHand },
  }
}
