/**
 * cardAdvisorMemory.ts
 *
 * Builds the runtime "memory" facts that server/src/ai/cardAdvisorPolicy.ts
 * needs (partnerCurrentlyWinning, opponentCurrentlyWinning, pointsInTrick,
 * and per-candidate clean-winner facts), sourced from the LIVE
 * ServerAuthoritativeGameState — never from the offline recorder dataset.
 *
 * This is a PORT (not an import) of the algorithm in
 * server/scripts/trainingDataset/cardMemoryFeatures.ts: that module cannot be
 * imported from server/src/ (server/tsconfig.json has rootDir="./src",
 * include=["src/**\/*.ts"] — runtime code physically cannot import from
 * scripts/, proven repeatedly in this project). The underlying information is
 * identical and already fully public: `state.playing.completedTricks` (every
 * finished trick this deal, each with its full plays) plus
 * `state.playing.currentTrick.plays` (cards already played in the current,
 * unfinished trick, before this decision) together are exactly the
 * `completedTricksSoFar` + `currentTrickPlaysSoFar` that the offline module
 * derives from a recorder archive — just read live instead of from disk.
 * Nothing here is a guess about hidden information: only already-played
 * cards (public) and the acting seat's own hand are used.
 *
 * Pure, no I/O, no env reads. Reuses the same canonical game-rule helpers
 * already used elsewhere in server/src/ai/ (getServerCardPoints,
 * getServerCardRankPower, getServerTrickWinner) instead of re-deriving rank
 * tables — single source of truth for game rules is never duplicated.
 */

import { getServerCardPoints, type ServerScoringContract } from '../game/serverScoring.js'
import { getServerCardRankPower, getServerTrickWinner } from '../game/getServerTrickWinner.js'
import { SERVER_SUITS } from '../game/serverCardConstants.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerSuit, ServerTrickPlay, ServerWinningBid } from '../game/serverGameTypes.js'
import type { Seat } from '../core/serverTypes.js'
import type { AdvisorCandidateMemory } from './cardAdvisorPolicy.js'

function isTrumpCard(card: ServerCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'no-trumps') return false
  return trumpSuit !== null && card.suit === trumpSuit
}

// Trump-order rank power (J-9-A-10-K-Q-8-7) is the relevant ordering for
// overtake/clean-winner comparisons, whether the context is a real trump suit
// or "everything is trump" (all-trumps) — same convention as
// cardMemoryFeatures.ts's trumpOrderPower, reused via getServerCardRankPower.
function trumpOrderPower(rank: ServerCard['rank']): number {
  return getServerCardRankPower(rank, true)
}
function naturalOrderPower(rank: ServerCard['rank']): number {
  return getServerCardRankPower(rank, false)
}

const RANKS: ServerCard['rank'][] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

export type AdvisorRuntimeMemory = {
  partnerCurrentlyWinning: boolean
  opponentCurrentlyWinning: boolean
  pointsInTrick: number
  candidateMemoryById: Map<string, AdvisorCandidateMemory>
}

/**
 * Builds the memory facts needed by decideAdvisorCard() for one card
 * decision. `currentTrickPlays` are the plays already made in the CURRENT,
 * unfinished trick (before this decision) — same source
 * (`state.playing.currentTrick.plays`) already used elsewhere in
 * localAiCardBeta.ts.
 */
export function buildAdvisorRuntimeMemory(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  partnerSeat: Seat,
  contract: ServerScoringContract,
  trumpSuit: ServerSuit | null,
  ownHand: ServerCard[],
  legalCards: ServerCard[],
  currentTrickPlays: ServerTrickPlay[],
): AdvisorRuntimeMemory {
  const completedTricks = state.playing?.completedTricks ?? []
  const playedCardsSoFar: ServerCard[] = [
    ...completedTricks.flatMap((t) => t.plays.map((p) => p.card)),
    ...currentTrickPlays.map((p) => p.card),
  ]

  const playedCardsBySuit: Record<ServerSuit, number> = { clubs: 0, diamonds: 0, hearts: 0, spades: 0 }
  for (const c of playedCardsSoFar) playedCardsBySuit[c.suit]++

  const ownHandBySuit: Record<ServerSuit, number> = { clubs: 0, diamonds: 0, hearts: 0, spades: 0 }
  for (const c of ownHand) ownHandBySuit[c.suit]++

  const remainingCardsBySuit: Record<ServerSuit, number> = { clubs: 0, diamonds: 0, hearts: 0, spades: 0 }
  for (const suit of SERVER_SUITS) remainingCardsBySuit[suit] = 8 - playedCardsBySuit[suit] - ownHandBySuit[suit]

  const remainingTrumpCount = contract === 'suit' && trumpSuit ? remainingCardsBySuit[trumpSuit] : 0

  // "Currently winning" — trick-so-far winner among ALREADY-played cards
  // (before this decision), a hard fact (never a guess about future plays).
  let currentTrickWinnerSeat: Seat | null = null
  if (currentTrickPlays.length > 0) {
    const winningBid: ServerWinningBid = { seat, contract, trumpSuit, doubled: false, redoubled: false }
    currentTrickWinnerSeat = getServerTrickWinner(currentTrickPlays, winningBid)?.seat ?? null
  }
  const partnerCurrentlyWinning = currentTrickWinnerSeat === partnerSeat
  const opponentCurrentlyWinning = currentTrickWinnerSeat !== null && currentTrickWinnerSeat !== seat && currentTrickWinnerSeat !== partnerSeat

  const pointsInTrick = currentTrickPlays.reduce((sum, p) => sum + getServerCardPoints(p.card.suit, p.card.rank, contract, trumpSuit), 0)

  function higherRemainingCardsCount(card: ServerCard, isTrump: boolean): number {
    const remainingInSuit = remainingCardsBySuit[card.suit] ?? 0
    if (remainingInSuit === 0) return 0
    const seenRanks = new Set<string>()
    for (const c of playedCardsSoFar) if (c.suit === card.suit) seenRanks.add(c.rank)
    for (const c of ownHand) if (c.suit === card.suit) seenRanks.add(c.rank)
    const candidatePower = isTrump ? trumpOrderPower(card.rank) : naturalOrderPower(card.rank)
    let count = 0
    for (const rank of RANKS) {
      if (seenRanks.has(rank)) continue
      const power = isTrump ? trumpOrderPower(rank) : naturalOrderPower(rank)
      if (power > candidatePower) count++
    }
    return count
  }

  const PRESERVE_POINTS_THRESHOLD = 10
  const candidateMemoryById = new Map<string, AdvisorCandidateMemory>()
  for (const card of legalCards) {
    const isTrump = isTrumpCard(card, contract, trumpSuit)
    const higherCount = higherRemainingCardsCount(card, isTrump)
    const candidateIsCleanWinner = isTrump ? higherCount === 0 : higherCount === 0 && remainingTrumpCount === 0

    const hasLowRiskAlternative = legalCards.some((c) => c.id !== card.id && !isTrumpCard(c, contract, trumpSuit) && getServerCardPoints(c.suit, c.rank, contract, trumpSuit) === 0)
    const trickNotUrgent = !(opponentCurrentlyWinning && pointsInTrick >= PRESERVE_POINTS_THRESHOLD)
    const shouldPreserveCleanWinner = candidateIsCleanWinner && trickNotUrgent && hasLowRiskAlternative

    candidateMemoryById.set(card.id, { id: card.id, candidateIsCleanWinner, shouldPreserveCleanWinner })
  }

  return { partnerCurrentlyWinning, opponentCurrentlyWinning, pointsInTrick, candidateMemoryById }
}
