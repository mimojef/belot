import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerWinningBid } from './serverGameTypes.js'
import { getNextSeat } from './serverPhaseHelpers.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'
import { getServerValidPlayCards } from './getServerValidPlayCards.js'

export type ServerSweepEligibilityHands = Record<Seat, ServerCard[]>

const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

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

const MAX_SEARCH_NODES = 200000 // safety guard against pathological branching

// Business invariant (final, explicit product decision — no draw-out
// exception, deliberately order-insensitive): "Долу картите" may be offered
// iff EVERY remaining card in sweepSeat's hand is ALREADY individually
// unbeatable, right now, against the CURRENT full hands of all three other
// seats (partner and both opponents, symmetrically). Whether the claimant
// could first play a different card to draw out a dangerous one, making a
// later card safe, does NOT matter — that card is not master right now, so
// it disqualifies the sweep. There is therefore no need to reason about
// hypothetical future tricks at all: for each remaining card, we simulate it
// being led as a fresh trick (the claimant's other remaining cards stay
// untouched in hand, irrelevant to this specific check) and exhaustively
// verify, for each of the three other seats, whether ANY legal combination
// of responses (reusing the exact production legal-move engine —
// getServerValidPlayCards/getServerTrickWinner, never reimplemented) could
// let that seat end up as the trick's winner.
export function computeServerSweepEligibility(params: {
  sweepSeat: Seat
  hands: ServerSweepEligibilityHands // CURRENT remaining hands of all 4 seats, post the just-completed trick
  winningBid: ServerWinningBid
}): boolean {
  const { sweepSeat, hands, winningBid } = params

  if (hands[sweepSeat].length < MIN_SWEEP_REMAINING_CARDS) {
    return false
  }

  const otherSeats = SEAT_ORDER.filter((seat) => seat !== sweepSeat)
  let nodes = 0

  // Does there exist a legal response combination (adversarial over the
  // other two responding seats too, since their choices can gate what
  // `targetSeat` is even allowed to legally play) in which `targetSeat` ends
  // up winning this specific (hypothetical, just-started) trick?
  function someResponseLetsSeatWin(
    plays: { seat: Seat; card: ServerCard }[],
    responderHands: ServerSweepEligibilityHands,
    targetSeat: Seat,
  ): boolean {
    const lastSeat = plays[plays.length - 1]!.seat
    if (lastSeat === targetSeat || plays.length === 4) {
      // A card played after the target seat can only take the trick away
      // from it, never hand it over — so it must be winning right now.
      if (getServerTrickWinner(plays, winningBid)?.seat !== targetSeat) return false
      if (plays.length === 4) return true
    }
    const nextSeat = getNextSeat(lastSeat)
    const legalCards = legalCardsFor(nextSeat, responderHands[nextSeat], plays, winningBid)
    for (const card of legalCards) {
      if (++nodes > MAX_SEARCH_NODES) return true // fail safe, not fail open
      const nextHands: ServerSweepEligibilityHands = {
        ...responderHands,
        [nextSeat]: responderHands[nextSeat].filter((c) => c.id !== card.id),
      }
      if (someResponseLetsSeatWin([...plays, { seat: nextSeat, card }], nextHands, targetSeat)) return true
    }
    return false
  }

  for (const leadCard of hands[sweepSeat]) {
    const afterLead: ServerSweepEligibilityHands = {
      ...hands,
      [sweepSeat]: hands[sweepSeat].filter((c) => c.id !== leadCard.id),
    }
    for (const targetSeat of otherSeats) {
      if (someResponseLetsSeatWin([{ seat: sweepSeat, card: leadCard }], afterLead, targetSeat)) {
        return false
      }
    }
  }

  return true
}
