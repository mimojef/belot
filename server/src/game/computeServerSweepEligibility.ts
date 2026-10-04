import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerWinningBid } from './serverGameTypes.js'
import { getNextSeat } from './serverPhaseHelpers.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'
import { getServerValidPlayCards } from './getServerValidPlayCards.js'

export type ServerSweepEligibilityHands = Record<Seat, ServerCard[]>

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

// Keyed by (suit,rank) multiset, NOT card.id — legality (getServerValidPlayCards)
// and trick-winner (getServerTrickWinner) determination only ever consult
// suit/rank, never id, so two states holding the same (suit,rank) multiset
// per seat are truly interchangeable for this search. In a real 32-card deck
// id and (suit,rank) are bijective anyway, so this loses zero precision for
// production play — it only buys back cache hits that an id-keyed map would
// have missed for no reason.
function handsKey(hands: ServerSweepEligibilityHands): string {
  return SEAT_ORDER.map((seat) =>
    hands[seat]
      .map((c) => `${c.suit}${c.rank}`)
      .slice()
      .sort()
      .join(','),
  ).join('|')
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

// Safety guard against pathological branching (see "Performance" note below).
// Hit ONLY in pathological/fabricated test fixtures with many duplicate
// cards — a real 32-card deck never reproduces this. Guard exhaustion is
// fail-SAFE (not eligible), never fail-open, per explicit product decision.
const MAX_SEARCH_NODES = 200000

// ============================================================================
// Business invariant (final — supersedes the single-level "flat" check that
// shipped in 0366126 and was found to under-count a real production bug: a
// responder holding exactly ONE card of a suit the claimant leads TWICE
// across two independent hypothetical single-trick checks was treated as a
// "blocker" for BOTH checks, even though in sequential reality that one card
// can only ever be played once — see room 229cf8fc-a259-4bf7-9771-6e6c2e5843b6
// round 1 for the confirmed incident).
//
// Sweep = true iff the claimant is GUARANTEED to win every remaining trick
// under genuinely sequential, shrinking hands — i.e. a true double-dummy
// search, but with a UNIVERSAL (not existential) quantifier over the
// claimant's own lead choice at every single position, not just the first:
//
//   isGuaranteedSweep(hands):
//     if claimant has no cards left -> true
//     for EVERY remaining claimant card (not just "some" winning one):
//       for EVERY legal response combination of the other 3 seats, in real
//       turn order (their legality at each step uses the production
//       getServerValidPlayCards against the plays actually made so far in
//       THIS branch — never a reimplementation):
//         the claimant must win that trick in EVERY such branch, AND
//         isGuaranteedSweep(the hands actually remaining after that branch)
//         must ALSO hold (recursively, same condition)
//       if any lead or any response branch fails this -> isGuaranteedSweep = false
//
// This is deliberately NOT "there exists a safe lead order" (that is the
// old, already-rejected draw-out-permissive invariant) — it must hold no
// matter which of the claimant's own remaining cards gets led, at every
// step, because the offer promises a GUARANTEE, not a best-play recipe the
// claimant must additionally know to execute.
// ============================================================================
export function computeServerSweepEligibility(params: {
  sweepSeat: Seat
  hands: ServerSweepEligibilityHands // CURRENT remaining hands of all 4 seats, post the just-completed trick
  winningBid: ServerWinningBid
}): boolean {
  const { sweepSeat, hands, winningBid } = params

  if (hands[sweepSeat].length < MIN_SWEEP_REMAINING_CARDS) {
    return false
  }

  const memo = new Map<string, boolean>()
  let nodes = 0

  // Pure function of "whose cards remain in which hands" — valid memoization
  // key regardless of the path taken to reach this state, since it is always
  // sweepSeat's turn to lead whenever this is invoked (every call site is
  // either the initial state or a freshly-completed trick that sweepSeat, by
  // the very condition being checked, just won).
  function isGuaranteedSweep(currentHands: ServerSweepEligibilityHands): boolean {
    if (currentHands[sweepSeat].length === 0) return true

    const key = handsKey(currentHands)
    const cached = memo.get(key)
    if (cached !== undefined) return cached

    if (++nodes > MAX_SEARCH_NODES) {
      // Fail-safe, never fail-open: guard exhaustion means "not proven safe".
      memo.set(key, false)
      return false
    }

    let result = true
    for (const leadCard of currentHands[sweepSeat]) {
      const afterLead: ServerSweepEligibilityHands = {
        ...currentHands,
        [sweepSeat]: currentHands[sweepSeat].filter((c) => c.id !== leadCard.id),
      }
      if (!allResponsesWinTrickThenRecurse([{ seat: sweepSeat, card: leadCard }], afterLead)) {
        result = false
        break
      }
    }

    memo.set(key, result)
    return result
  }

  // Universal over the other 3 seats' legal responses, in real turn order
  // (their legality at each step is computed against the ACTUAL plays made
  // so far in this branch, so follow-suit/overtrump/isPartnerWinning are all
  // evaluated correctly and cannot be "double spent" across branches — each
  // branch independently removes the cards it actually uses). On a completed
  // 4-card trick, the claimant must be the winner, and the resulting
  // (smaller) hands must themselves satisfy isGuaranteedSweep.
  function allResponsesWinTrickThenRecurse(
    plays: { seat: Seat; card: ServerCard }[],
    responderHands: ServerSweepEligibilityHands,
  ): boolean {
    if (plays.length === 4) {
      const winner = getServerTrickWinner(plays, winningBid)
      if (!winner || winner.seat !== sweepSeat) return false
      return isGuaranteedSweep(responderHands)
    }

    const nextSeat = getNextSeat(plays[plays.length - 1]!.seat)
    const legalCards = legalCardsFor(nextSeat, responderHands[nextSeat], plays, winningBid)

    for (const card of legalCards) {
      if (++nodes > MAX_SEARCH_NODES) return false // fail safe, not fail open
      const nextHands: ServerSweepEligibilityHands = {
        ...responderHands,
        [nextSeat]: responderHands[nextSeat].filter((c) => c.id !== card.id),
      }
      if (!allResponsesWinTrickThenRecurse([...plays, { seat: nextSeat, card }], nextHands)) {
        return false
      }
    }

    return true
  }

  return isGuaranteedSweep(hands)
}
