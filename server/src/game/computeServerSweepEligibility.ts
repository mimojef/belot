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

// "Долу картите" има смисъл само при поне 2 оставащи карти — при 1 карта
// остава само последната взятка и offer/popup е излишен.
export const MIN_SWEEP_REMAINING_CARDS = 2

const MAX_SEARCH_NODES = 200000 // safety guard against pathological branching; see audit note on worst-case early-round combinatorics

// Double-dummy / perfect-information game-tree search: sweepSeat is
// guaranteed to win EVERY remaining trick iff there exists a lead-choice
// strategy for sweepSeat such that for EVERY legal response combination of
// the other 3 seats (fixed table rotation order via getNextSeat), sweepSeat
// wins that trick (per getServerTrickWinner — the exact same function used
// in live play, never reimplemented here), and the same holds recursively
// for all subsequent tricks with the reduced hands. Additionally the partner
// may never be able to win against any of the claimant's remaining cards (see
// partnerCanWinAgainstAnyLead) — the sweep is personal, not a team claim.
export function computeServerSweepEligibility(params: {
  sweepSeat: Seat
  hands: ServerSweepEligibilityHands // CURRENT remaining hands of all 4 seats, post the just-completed trick
  winningBid: ServerWinningBid
}): boolean {
  const { sweepSeat, winningBid } = params

  if (params.hands[sweepSeat].length < MIN_SWEEP_REMAINING_CARDS) {
    return false
  }

  const partnerSeat = getNextSeat(getNextSeat(sweepSeat))
  const memo = new Map<string, boolean>()
  let nodes = 0
  let partnerCheckNodes = 0

  function canSweepFrom(hands: ServerSweepEligibilityHands): boolean {
    if (hands[sweepSeat].length === 0) return true
    const key = handsKey(hands)
    const cached = memo.get(key)
    if (cached !== undefined) return cached
    const result = !partnerCanWinAgainstAnyLead(hands) && tryLeadChoices(hands)
    memo.set(key, result)
    return result
  }

  // The claimant must take the rest PERSONALLY — the partner is never a
  // resource. Without this, a line like "lead 10♥ so the partner is forced to
  // drop K♥, then 7♥ is master" would pass although the partner holds a card
  // that beats 7♥. So at every position on the line: for EVERY remaining
  // claimant card led, no legal response combination may let the partner win.
  // (Forcing OPPONENTS' higher cards out with an own higher card stays fine.)
  function partnerCanWinAgainstAnyLead(hands: ServerSweepEligibilityHands): boolean {
    for (const leadCard of hands[sweepSeat]) {
      if (++partnerCheckNodes > MAX_SEARCH_NODES) return true // fail safe, not fail open
      const afterLead: ServerSweepEligibilityHands = {
        ...hands,
        [sweepSeat]: hands[sweepSeat].filter((c) => c.id !== leadCard.id),
      }
      if (someResponseLetsPartnerWin([{ seat: sweepSeat, card: leadCard }], afterLead)) return true
    }
    return false
  }

  function someResponseLetsPartnerWin(
    plays: { seat: Seat; card: ServerCard }[],
    hands: ServerSweepEligibilityHands,
  ): boolean {
    const lastSeat = plays[plays.length - 1]!.seat
    if (lastSeat === partnerSeat || plays.length === 4) {
      // A card played after the partner can only take the trick away from
      // him, never hand it to him — so he must be winning right now.
      if (getServerTrickWinner(plays, winningBid)?.seat !== partnerSeat) return false
      if (plays.length === 4) return true
    }
    const nextSeat = getNextSeat(lastSeat)
    const legalCards = legalCardsFor(nextSeat, hands[nextSeat], plays, winningBid)
    for (const card of legalCards) {
      if (++partnerCheckNodes > MAX_SEARCH_NODES) return true
      const nextHands: ServerSweepEligibilityHands = {
        ...hands,
        [nextSeat]: hands[nextSeat].filter((c) => c.id !== card.id),
      }
      if (someResponseLetsPartnerWin([...plays, { seat: nextSeat, card }], nextHands)) return true
    }
    return false
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
