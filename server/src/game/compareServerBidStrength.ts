import type {
  ServerBidAction,
  ServerSuit,
  ServerWinningBid,
} from './serverGameTypes.js'

const SERVER_BID_SUIT_ORDER: ServerSuit[] = [
  'clubs',
  'diamonds',
  'hearts',
  'spades',
]

const SERVER_BID_CONTRACT_ORDER = [
  'suit',
  'no-trumps',
  'all-trumps',
] as const

type ComparableServerContract = (typeof SERVER_BID_CONTRACT_ORDER)[number]

export type ComparableServerBid = {
  contract: ComparableServerContract
  trumpSuit: ServerSuit | null
}

function getSuitStrength(suit: ServerSuit): number {
  return SERVER_BID_SUIT_ORDER.indexOf(suit)
}

function getContractStrength(contract: ComparableServerContract): number {
  return SERVER_BID_CONTRACT_ORDER.indexOf(contract)
}

export function toComparableServerBidFromAction(
  action: ServerBidAction,
): ComparableServerBid | null {
  if (action.type === 'suit') {
    return {
      contract: 'suit',
      trumpSuit: action.suit,
    }
  }

  if (action.type === 'no-trumps') {
    return {
      contract: 'no-trumps',
      trumpSuit: null,
    }
  }

  if (action.type === 'all-trumps') {
    return {
      contract: 'all-trumps',
      trumpSuit: null,
    }
  }

  return null
}

export function toComparableServerBidFromWinningBid(
  winningBid: ServerWinningBid,
): ComparableServerBid | null {
  if (!winningBid) {
    return null
  }

  return {
    contract: winningBid.contract,
    trumpSuit: winningBid.trumpSuit,
  }
}

export function compareServerBidStrength(
  leftBid: ComparableServerBid,
  rightBid: ComparableServerBid,
): number {
  const leftContractStrength = getContractStrength(leftBid.contract)
  const rightContractStrength = getContractStrength(rightBid.contract)

  if (leftContractStrength !== rightContractStrength) {
    return leftContractStrength - rightContractStrength
  }

  if (leftBid.contract === 'suit' && rightBid.contract === 'suit') {
    const leftSuitStrength = leftBid.trumpSuit ? getSuitStrength(leftBid.trumpSuit) : -1
    const rightSuitStrength = rightBid.trumpSuit
      ? getSuitStrength(rightBid.trumpSuit)
      : -1

    return leftSuitStrength - rightSuitStrength
  }

  return 0
}

export function isServerBidHigherThanWinningBid(
  action: ServerBidAction,
  winningBid: ServerWinningBid,
): boolean {
  const nextBid = toComparableServerBidFromAction(action)

  if (!nextBid) {
    return false
  }

  const currentBid = toComparableServerBidFromWinningBid(winningBid)

  if (!currentBid) {
    return true
  }

  return compareServerBidStrength(nextBid, currentBid) > 0
}