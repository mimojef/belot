import type {
  ServerAuthoritativeGameState,
  ServerBidAction,
  ServerBidEntry,
  ServerWinningBid,
} from './serverGameTypes.js'
import { getNextSeat } from './serverPhaseHelpers.js'

function toServerWinningBid(
  currentWinningBid: ServerWinningBid,
  seat: ServerBidEntry['seat'],
  action: ServerBidAction,
): ServerWinningBid {
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

function getNextServerConsecutivePassesCount(
  action: ServerBidAction,
  currentWinningBid: ServerWinningBid,
  currentConsecutivePasses: number,
): number {
  if (action.type !== 'pass') {
    return 0
  }

  if (!currentWinningBid) {
    return currentConsecutivePasses + 1
  }

  return currentConsecutivePasses + 1
}

function shouldEndServerBidding(
  action: ServerBidAction,
  winningBid: ServerWinningBid,
  consecutivePasses: number,
): boolean {
  if (!winningBid) {
    return action.type === 'pass' && consecutivePasses >= 4
  }

  return action.type === 'pass' && consecutivePasses >= 3
}

export function applyServerBidAction(
  state: ServerAuthoritativeGameState,
  action: ServerBidAction,
): ServerAuthoritativeGameState {
  if (state.phase !== 'bidding') {
    return state
  }

  const currentSeat = state.bidding.currentSeat

  if (!currentSeat) {
    return state
  }

  const entry: ServerBidEntry = {
    seat: currentSeat,
    action,
  }

  const nextWinningBid = toServerWinningBid(
    state.bidding.winningBid,
    currentSeat,
    action,
  )

  const nextConsecutivePasses = getNextServerConsecutivePassesCount(
    action,
    state.bidding.winningBid,
    state.bidding.consecutivePasses,
  )

  const hasEnded = shouldEndServerBidding(
    action,
    nextWinningBid,
    nextConsecutivePasses,
  )

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