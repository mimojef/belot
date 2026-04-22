import type { Seat } from '../../data/constants/seatOrder'
import type { BidAction, WinningBid } from '../state/gameTypes'
import { isBidHigherThanWinningBid } from './compareBidStrength'

type ValidBidActions = {
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

function canDouble(currentSeat: Seat, winningBid: WinningBid): boolean {
  if (!winningBid) {
    return false
  }

  if (winningBid.doubled || winningBid.redoubled) {
    return false
  }

  return getTeamBySeat(currentSeat) !== getTeamBySeat(winningBid.seat)
}

function canRedouble(currentSeat: Seat, winningBid: WinningBid): boolean {
  if (!winningBid) {
    return false
  }

  if (!winningBid.doubled || winningBid.redoubled) {
    return false
  }

  return getTeamBySeat(currentSeat) === getTeamBySeat(winningBid.seat)
}

function isSuitAllowed(winningBid: WinningBid, suitAction: BidAction): boolean {
  return isBidHigherThanWinningBid(suitAction, winningBid)
}

export function getValidBidActions(currentSeat: Seat, winningBid: WinningBid): ValidBidActions {
  return {
    pass: true,
    suits: {
      clubs: isSuitAllowed(winningBid, { type: 'suit', suit: 'clubs' }),
      diamonds: isSuitAllowed(winningBid, { type: 'suit', suit: 'diamonds' }),
      hearts: isSuitAllowed(winningBid, { type: 'suit', suit: 'hearts' }),
      spades: isSuitAllowed(winningBid, { type: 'suit', suit: 'spades' }),
    },
    noTrumps: isBidHigherThanWinningBid({ type: 'no-trumps' }, winningBid),
    allTrumps: isBidHigherThanWinningBid({ type: 'all-trumps' }, winningBid),
    double: canDouble(currentSeat, winningBid),
    redouble: canRedouble(currentSeat, winningBid),
  }
}