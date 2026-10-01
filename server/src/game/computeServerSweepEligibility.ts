import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerWinningBid } from './serverGameTypes.js'
import { getNextSeat } from './serverPhaseHelpers.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'
import { getServerValidPlayCards } from './getServerValidPlayCards.js'

export type ServerSweepEligibilityHands = Record<Seat, ServerCard[]>

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

function handsKey(hands: ServerSweepEligibilityHands): string {
  return SEAT_ORDER.map((seat) => hands[seat].map((c) => c.id).slice().sort().join(',')).join('|')
}

// Reuses the EXACT production legal-move engine via a minimal fake state —
// only `.hands[seat]`, `.playing.currentTrick.plays`, `.bidding.winningBid`
// are read by getServerValidPlayCards, so this cast is safe and guarantees
// zero rule drift from live gameplay. (Няма ESLint конфигурация в този
// repo, която да забранява такъв cast — проверено преди да се добави тук.)
function legalCardsFor(
  seat: Seat,
  hand: ServerCard[],
  plays: { seat: Seat; card: ServerCard }[],
  winningBid: ServerWinningBid,
): ServerCard[] {
  const fakeState = {
    hands: { bottom: [], right: [], top: [], left: [], [seat]: hand },
    playing: { currentTrick: { plays } },
    bidding: { winningBid },
  } as unknown as ServerAuthoritativeGameState
  return getServerValidPlayCards(fakeState, seat)
}

const MAX_SEARCH_NODES = 200000 // safety guard against pathological branching; see audit note on worst-case early-round combinatorics

// Double-dummy / perfect-information game-tree search: sweepSeat is
// guaranteed to win EVERY remaining trick iff there exists a lead-choice
// strategy for sweepSeat such that for EVERY legal response combination of
// the other 3 seats (fixed table rotation order via getNextSeat), sweepSeat
// wins that trick (per getServerTrickWinner — the exact same function used
// in live play, never reimplemented here), and the same holds recursively
// for all subsequent tricks with the reduced hands.
export function computeServerSweepEligibility(params: {
  sweepSeat: Seat
  hands: ServerSweepEligibilityHands // CURRENT remaining hands of all 4 seats, post the just-completed trick
  winningBid: ServerWinningBid
}): boolean {
  const { sweepSeat, winningBid } = params
  const memo = new Map<string, boolean>()
  let nodes = 0

  function canSweepFrom(hands: ServerSweepEligibilityHands): boolean {
    if (hands[sweepSeat].length === 0) return true
    const key = handsKey(hands)
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const result = tryLeadChoices(hands)
    memo.set(key, result)
    return result
  }

  function tryLeadChoices(hands: ServerSweepEligibilityHands): boolean {
    for (const leadCard of hands[sweepSeat]) {
      if (++nodes > MAX_SEARCH_NODES) return false // fail safe, not fail open
      const plays = [{ seat: sweepSeat, card: leadCard }]
      const afterLead: ServerSweepEligibilityHands = {
        ...hands,
        [sweepSeat]: hands[sweepSeat].filter((c) => c.id !== leadCard.id),
      }
      if (allResponsesLoseTrick(plays, afterLead)) return true
    }
    return false
  }

  function allResponsesLoseTrick(
    plays: { seat: Seat; card: ServerCard }[],
    hands: ServerSweepEligibilityHands,
  ): boolean {
    if (plays.length === 4) {
      const winner = getServerTrickWinner(plays, winningBid)
      if (!winner || winner.seat !== sweepSeat) return false
      return canSweepFrom(hands)
    }
    const nextSeat = getNextSeat(plays[plays.length - 1]!.seat)
    const legalCards = legalCardsFor(nextSeat, hands[nextSeat], plays, winningBid)
    for (const card of legalCards) {
      if (++nodes > MAX_SEARCH_NODES) return false
      const nextPlays = [...plays, { seat: nextSeat, card }]
      const nextHands: ServerSweepEligibilityHands = {
        ...hands,
        [nextSeat]: hands[nextSeat].filter((c) => c.id !== card.id),
      }
      if (!allResponsesLoseTrick(nextPlays, nextHands)) return false
    }
    return true
  }

  return canSweepFrom(params.hands)
}
