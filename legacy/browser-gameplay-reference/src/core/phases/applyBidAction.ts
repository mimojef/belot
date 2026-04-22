import type { BidAction, BidEntry, GameState, WinningBid } from '../state/gameTypes'
import { getNextSeat } from './phaseHelpers'

function toWinningBid(
  currentWinningBid: WinningBid,
  seat: BidEntry['seat'],
  action: BidAction
): WinningBid {
  if (action.type === 'suit') {
    return {
      seat,
      contract: 'suit',
      trumpSuit: action.suit,
      doubled: false,
      redoubled: false,
    }
  }

  if (action.type === 'no-trumps') {
    return {
      seat,
      contract: 'no-trumps',
      trumpSuit: null,
      doubled: false,
      redoubled: false,
    }
  }

  if (action.type === 'all-trumps') {
    return {
      seat,
      contract: 'all-trumps',
      trumpSuit: null,
      doubled: false,
      redoubled: false,
    }
  }

  if (action.type === 'double' && currentWinningBid) {
    return {
      ...currentWinningBid,
      doubled: true,
      redoubled: false,
    }
  }

  if (action.type === 'redouble' && currentWinningBid) {
    return {
      ...currentWinningBid,
      redoubled: true,
    }
  }

  return currentWinningBid
}

function getNextConsecutivePassesCount(
  action: BidAction,
  currentWinningBid: WinningBid,
  currentConsecutivePasses: number
): number {
  if (action.type !== 'pass') {
    return 0
  }

  if (!currentWinningBid) {
    return currentConsecutivePasses + 1
  }

  return currentConsecutivePasses + 1
}

function shouldEndBidding(action: BidAction, winningBid: WinningBid, consecutivePasses: number): boolean {
  if (!winningBid) {
    return action.type === 'pass' && consecutivePasses >= 4
  }

  return action.type === 'pass' && consecutivePasses >= 3
}

export function applyBidAction(state: GameState, action: BidAction): GameState {
  if (state.phase !== 'bidding') {
    return state
  }

  const currentSeat = state.bidding.currentSeat

  if (!currentSeat) {
    return state
  }

  const entry: BidEntry = {
    seat: currentSeat,
    action,
  }

  const nextWinningBid = toWinningBid(state.bidding.winningBid, currentSeat, action)
  const nextConsecutivePasses = getNextConsecutivePassesCount(
    action,
    state.bidding.winningBid,
    state.bidding.consecutivePasses
  )
  const hasEnded = shouldEndBidding(action, nextWinningBid, nextConsecutivePasses)

  return {
    ...state,
    bidding: {
      ...state.bidding,
      entries: [...state.bidding.entries, entry],
      currentSeat: hasEnded ? null : getNextSeat(currentSeat),
      winningBid: nextWinningBid,
      hasStarted: true,
      hasEnded,
      consecutivePasses: nextConsecutivePasses,
    },
  }
}