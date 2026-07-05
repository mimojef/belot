/**
 * cardAdvisorPolicy.ts
 *
 * Pure "conventional-first tactical advisor" decision engine — replaces the
 * (rejected) "pure model replacement" local AI beta direction. The
 * conventional bot's card is ALWAYS the starting point; this module only
 * ever proposes a DIFFERENT legal card when a deterministic, explainable
 * guard rule fires on a strong signal. It does not rank/score every legal
 * card the way card-model-v1/v2/v3 do — there is no learned model here at
 * all, only hand-written tactical checks.
 *
 * Pure function, no I/O, no env reads, no dependency on
 * ServerAuthoritativeGameState — this is what lets the exact same engine be
 * used both by the runtime wrapper (server/src/ai/localAiCardBeta.ts, via
 * server/src/ai/cardAdvisorMemory.ts) AND by the offline evaluator
 * (server/scripts/evaluateCardAdvisor.ts, fed from already-computed dataset
 * memory fields) — the engine itself cannot drift between the two contexts.
 *
 * ─── Guard rules (priority order: A → D → B → C, one override max) ─────────
 *
 * Predicting the EVENTUAL trick winner with certainty is only possible when
 * this seat is the last to act in the trick (positionInTrick === 3) — earlier
 * than that, a still-to-play opponent could beat any candidate. Rules A and D
 * depend on the eventual winner, so they are gated to positionInTrick===3
 * only. Rules B and C depend only on ALREADY-played cards / already-proven
 * clean-winner facts (hard facts, never a guess about future plays), so they
 * are safe at any position.
 *
 *   A) avoid_giving_trick_to_opponent — positionInTrick===3 only. If the
 *      conventional card currently loses the trick to an opponent AND a
 *      legal alternative would flip the trick to our team, take the
 *      cheapest such alternative (win with the least strength spent).
 *   D) avoid_feeding_points — positionInTrick===3 only, only considered when
 *      A found the trick unavoidably lost (no flipping alternative exists).
 *      If the conventional card carries points and a lower-point legal
 *      alternative exists, take the lowest.
 *   B) avoid_overtaking_partner — any position except 0 (leading; there is
 *      no "partner currently winning" state before anyone has led). If the
 *      partner is already winning the trick (hard fact) and the conventional
 *      card would unnecessarily overtake them (pointsInTrick < 10 — nothing
 *      important at stake) while a legal alternative leaves the partner
 *      winning, prefer the safest (non-trump, 0-point, lowest rank) such
 *      alternative.
 *   C) preserve_clean_winner — any position EXCEPT 0 (leading). Leading with
 *      a guaranteed winner is normal, often-optimal strategy (take the trick,
 *      keep initiative) — "preserving" only makes sense when NOT leading. If
 *      the conventional card is a proven clean winner (no higher unseen card
 *      of its suit/trump remains — see cardAdvisorMemory.ts) and the trick
 *      isn't urgent (NOT(opponentCurrentlyWinning && pointsInTrick>=10)),
 *      prefer a safe (non-trump, 0-point) legal alternative if one exists.
 *
 * If no rule fires, the conventional card is returned unchanged — this must
 * be the overwhelming majority case (see server/scripts/evaluateCardAdvisor.ts
 * for the offline override-rate validation, target 5-20% of non-forced
 * decisions).
 *
 * Deliberately NOT implemented (deferred — would require guessing hidden
 * opponent hands/future plays): rules A/D at positionInTrick 0/1/2; any
 * probabilistic "opponent is probably void" inference beyond hard,
 * already-proven deductions; multi-rule blending/weighted scoring instead of
 * strict single-override priority.
 */

import { getServerCardPoints, type ServerScoringContract } from '../game/serverScoring.js'
import { getServerCardRankPower, getServerTrickWinner } from '../game/getServerTrickWinner.js'
import type { ServerCard, ServerSuit, ServerTrickPlay, ServerWinningBid } from '../game/serverGameTypes.js'
import type { Seat } from '../core/serverTypes.js'

export type AdvisorReason =
  | 'avoid_giving_trick_to_opponent'
  | 'avoid_feeding_points'
  | 'avoid_overtaking_partner'
  | 'preserve_clean_winner'

/** Per-candidate memory facts (already-computed, see cardAdvisorMemory.ts / offline cardMemoryFeatures.ts). */
export type AdvisorCandidateMemory = {
  id: string
  candidateIsCleanWinner: boolean
  shouldPreserveCleanWinner: boolean
}

export type AdvisorDecisionInput = {
  seat: Seat
  partnerSeat: Seat
  /** 0 = leading (no cards played yet this trick), up to 3 (last to act). Equals currentTrickPlays.length. */
  positionInTrick: number
  contract: ServerScoringContract
  trumpSuit: ServerSuit | null
  /** Cards already played in the CURRENT, unfinished trick, before this decision. */
  currentTrickPlays: ServerTrickPlay[]
  legalCards: ServerCard[]
  conventionalCard: ServerCard
  /** Hard fact: is the partner currently winning the trick, based on already-played cards (before this decision)? */
  partnerCurrentlyWinning: boolean
  /** Hard fact: is an opponent currently winning the trick, based on already-played cards? */
  opponentCurrentlyWinning: boolean
  pointsInTrick: number
  candidateMemoryById: Map<string, AdvisorCandidateMemory>
}

export type AdvisorDecisionResult = {
  finalCard: ServerCard
  override: boolean
  reason: AdvisorReason | null
  /**
   * Trick winner if this seat played the given card right now, simulated via
   * getServerTrickWinner over (currentTrickPlays + candidate). This is the
   * ACTUAL final winner only when positionInTrick===3 (last to act) — at
   * earlier positions it is an interim "if the trick ended right now"
   * simulation that a later opponent play could still invalidate. Never
   * treat these as a guaranteed outcome outside positionInTrick===3.
   */
  predictedWinnerSeatIfConventional: Seat | null
  predictedWinnerSeatIfFinal: Seat | null
}

// ─── Small pure helpers (no I/O, reuse canonical game-rule functions) ───────

function isTrumpCard(card: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'no-trumps') return false
  return trumpSuit !== null && card.suit === trumpSuit
}

function cardPoints(card: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): number {
  return getServerCardPoints(card.suit, card.rank, contract, trumpSuit)
}

function rankPower(card: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): number {
  return getServerCardRankPower(card.rank, isTrumpCard(card, contract, trumpSuit))
}

/** "How much strength does playing this card spend" — minimized when a rule wants "win/discard as cheaply as possible". */
function strengthCost(card: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): number {
  return (isTrumpCard(card, contract, trumpSuit) ? 1000 : 0) + cardPoints(card, contract, trumpSuit) * 10 + rankPower(card, contract, trumpSuit)
}

function simulateWinnerSeat(card: ServerCard, input: AdvisorDecisionInput): Seat | null {
  const winningBid: ServerWinningBid = {
    seat: input.seat,
    contract: input.contract,
    trumpSuit: input.trumpSuit,
    doubled: false,
    redoubled: false,
  }
  const plays: ServerTrickPlay[] = [...input.currentTrickPlays, { seat: input.seat, card }]
  return getServerTrickWinner(plays, winningBid)?.seat ?? null
}

function isOurs(winnerSeat: Seat | null, input: AdvisorDecisionInput): boolean {
  return winnerSeat === input.seat || winnerSeat === input.partnerSeat
}

function pickCheapestBy(cards: ServerCard[], input: AdvisorDecisionInput): ServerCard {
  return cards.reduce((best, c) =>
    strengthCost(c, input.contract, input.trumpSuit) < strengthCost(best, input.contract, input.trumpSuit) ? c : best,
  )
}

/** Prefer non-trump, 0-point, lowest-rank — the "safest possible discard" among a candidate set. */
function pickSafestDiscard(cards: ServerCard[], input: AdvisorDecisionInput): ServerCard {
  return cards.reduce((best, c) => {
    const cScore = (isTrumpCard(c, input.contract, input.trumpSuit) ? 2 : 0) + (cardPoints(c, input.contract, input.trumpSuit) > 0 ? 1 : 0)
    const bestScore = (isTrumpCard(best, input.contract, input.trumpSuit) ? 2 : 0) + (cardPoints(best, input.contract, input.trumpSuit) > 0 ? 1 : 0)
    if (cScore !== bestScore) return cScore < bestScore ? c : best
    return rankPower(c, input.contract, input.trumpSuit) < rankPower(best, input.contract, input.trumpSuit) ? c : best
  })
}

// ─── Guard rules ─────────────────────────────────────────────────────────────

type RuleOutcome = { card: ServerCard; reason: AdvisorReason }

function tryRulesAandD(input: AdvisorDecisionInput): RuleOutcome | null {
  if (input.positionInTrick !== 3) return null

  const winnerIfConventional = simulateWinnerSeat(input.conventionalCard, input)
  if (isOurs(winnerIfConventional, input)) return null // conventional already wins for us — nothing to fix here

  // Rule A: is there a legal alternative that flips the trick to our team?
  const flipping = input.legalCards.filter(
    (c) => c.id !== input.conventionalCard.id && isOurs(simulateWinnerSeat(c, input), input),
  )
  if (flipping.length > 0) {
    return { card: pickCheapestBy(flipping, input), reason: 'avoid_giving_trick_to_opponent' }
  }

  // Rule D: trick is unavoidably lost this round — minimize points fed to the opponent.
  const conventionalPoints = cardPoints(input.conventionalCard, input.contract, input.trumpSuit)
  if (conventionalPoints > 0) {
    const lowerPointAlternatives = input.legalCards.filter(
      (c) => c.id !== input.conventionalCard.id && cardPoints(c, input.contract, input.trumpSuit) < conventionalPoints,
    )
    if (lowerPointAlternatives.length > 0) {
      return { card: pickSafestDiscard(lowerPointAlternatives, input), reason: 'avoid_feeding_points' }
    }
  }

  return null
}

function tryRuleB(input: AdvisorDecisionInput): RuleOutcome | null {
  if (input.positionInTrick === 0) return null // leading — no "partner currently winning" state exists yet
  if (!input.partnerCurrentlyWinning) return null
  if (input.pointsInTrick >= 10) return null // enough at stake that overtaking is not "unnecessary"

  const winnerIfConventional = simulateWinnerSeat(input.conventionalCard, input)
  if (winnerIfConventional !== input.seat) return null // conventional doesn't overtake partner — rule doesn't apply

  const staysWithPartner = input.legalCards.filter(
    (c) => c.id !== input.conventionalCard.id && simulateWinnerSeat(c, input) === input.partnerSeat,
  )
  if (staysWithPartner.length === 0) return null

  return { card: pickSafestDiscard(staysWithPartner, input), reason: 'avoid_overtaking_partner' }
}

function tryRuleC(input: AdvisorDecisionInput): RuleOutcome | null {
  // Leading with a guaranteed winner is normal, often-optimal Belot strategy
  // (take the trick, keep initiative) — "preserving" only makes sense when
  // NOT leading, i.e. when the trick's outcome doesn't hinge on this card
  // being played right now. Confirmed empirically by evaluateCardAdvisor.ts:
  // without this gate, this rule fired on plain "lead with your ace" human
  // decisions, which is exactly the opposite of a tactical mistake.
  if (input.positionInTrick === 0) return null
  const conventionalMemory = input.candidateMemoryById.get(input.conventionalCard.id)
  if (!conventionalMemory?.candidateIsCleanWinner) return null
  const isUrgent = input.opponentCurrentlyWinning && input.pointsInTrick >= 10
  if (isUrgent) return null

  const safeAlternatives = input.legalCards.filter(
    (c) =>
      c.id !== input.conventionalCard.id &&
      !isTrumpCard(c, input.contract, input.trumpSuit) &&
      cardPoints(c, input.contract, input.trumpSuit) === 0,
  )
  if (safeAlternatives.length === 0) return null

  return { card: pickSafestDiscard(safeAlternatives, input), reason: 'preserve_clean_winner' }
}

// ─── Main entry point ────────────────────────────────────────────────────────

export function decideAdvisorCard(input: AdvisorDecisionInput): AdvisorDecisionResult {
  const predictedWinnerSeatIfConventional = simulateWinnerSeat(input.conventionalCard, input)

  if (input.legalCards.length <= 1) {
    return {
      finalCard: input.conventionalCard,
      override: false,
      reason: null,
      predictedWinnerSeatIfConventional,
      predictedWinnerSeatIfFinal: predictedWinnerSeatIfConventional,
    }
  }

  const outcome = tryRulesAandD(input) ?? tryRuleB(input) ?? tryRuleC(input)

  if (!outcome) {
    return {
      finalCard: input.conventionalCard,
      override: false,
      reason: null,
      predictedWinnerSeatIfConventional,
      predictedWinnerSeatIfFinal: predictedWinnerSeatIfConventional,
    }
  }

  return {
    finalCard: outcome.card,
    override: true,
    reason: outcome.reason,
    predictedWinnerSeatIfConventional,
    predictedWinnerSeatIfFinal: simulateWinnerSeat(outcome.card, input),
  }
}
