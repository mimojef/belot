import type { Seat } from '../core/serverTypes.js'
import type { ServerBidAction, ServerWinningBid } from './serverGameTypes.js'
import { isServerBidHigherThanWinningBid } from './compareServerBidStrength.js'

export type ValidServerBidActions = {
  pass: boolean
  suits: {
    clubs: boolean
    diamonds: boolean
    hearts: boolean
    spades: boolean
  }
  noTrumps: boolean
  allTrumps: boolean
  double: boolean
  redouble: boolean
}

function getTeamBySeat(seat: Seat): 'A' | 'B' {
  if (seat === 'bottom' || seat === 'top') {
    return 'A'
  }

  return 'B'
}

function canDouble(currentSeat: Seat, winningBid: ServerWinningBid): boolean {
  if (!winningBid) {
    return false
  }

  if (winningBid.doubled || winningBid.redoubled) {
    return false
  }

  return getTeamBySeat(currentSeat) !== getTeamBySeat(winningBid.seat)
}

function canRedouble(currentSeat: Seat, winningBid: ServerWinningBid): boolean {
  if (!winningBid) {
    return false
  }

  if (!winningBid.doubled || winningBid.redoubled) {
    return false
  }

  return getTeamBySeat(currentSeat) === getTeamBySeat(winningBid.seat)
}

function isSuitAllowed(
  winningBid: ServerWinningBid,
  suitAction: ServerBidAction,
): boolean {
  return isServerBidHigherThanWinningBid(suitAction, winningBid)
}

export function getValidServerBidActions(
  currentSeat: Seat,
  winningBid: ServerWinningBid,
): ValidServerBidActions {
  return {
    pass: true,
    suits: {
      clubs: isSuitAllowed(winningBid, { type: 'suit', suit: 'clubs' }),
      diamonds: isSuitAllowed(winningBid, { type: 'suit', suit: 'diamonds' }),
      hearts: isSuitAllowed(winningBid, { type: 'suit', suit: 'hearts' }),
      spades: isSuitAllowed(winningBid, { type: 'suit', suit: 'spades' }),
    },
    noTrumps: isServerBidHigherThanWinningBid({ type: 'no-trumps' }, winningBid),
    allTrumps: isServerBidHigherThanWinningBid({ type: 'all-trumps' }, winningBid),
    double: canDouble(currentSeat, winningBid),
    redouble: canRedouble(currentSeat, winningBid),
  }
}