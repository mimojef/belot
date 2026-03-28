import { BID_CONTRACT_ORDER, BID_SUIT_ORDER } from '../../data/constants/biddingConstants'
import type { BidAction, Suit, WinningBid } from '../state/gameTypes'

type ComparableContract = 'suit' | 'no-trumps' | 'all-trumps'

export type ComparableBid = {
  contract: ComparableContract
  trumpSuit: Suit | null
}

function getSuitStrength(suit: Suit): number {
  return BID_SUIT_ORDER.indexOf(suit)
}

function getContractStrength(contract: ComparableContract): number {
  return BID_CONTRACT_ORDER.indexOf(contract)
}

export function toComparableBidFromAction(action: BidAction): ComparableBid | null {
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

export function toComparableBidFromWinningBid(winningBid: WinningBid): ComparableBid | null {
  if (!winningBid) {
    return null
  }

  return {
    contract: winningBid.contract,
    trumpSuit: winningBid.trumpSuit,
  }
}

export function compareBidStrength(leftBid: ComparableBid, rightBid: ComparableBid): number {
  const leftContractStrength = getContractStrength(leftBid.contract)
  const rightContractStrength = getContractStrength(rightBid.contract)

  if (leftContractStrength !== rightContractStrength) {
    return leftContractStrength - rightContractStrength
  }

  if (leftBid.contract === 'suit' && rightBid.contract === 'suit') {
    const leftSuitStrength = leftBid.trumpSuit ? getSuitStrength(leftBid.trumpSuit) : -1
    const rightSuitStrength = rightBid.trumpSuit ? getSuitStrength(rightBid.trumpSuit) : -1

    return leftSuitStrength - rightSuitStrength
  }

  return 0
}

export function isBidHigherThanWinningBid(action: BidAction, winningBid: WinningBid): boolean {
  const nextBid = toComparableBidFromAction(action)

  if (!nextBid) {
    return false
  }

  const currentBid = toComparableBidFromWinningBid(winningBid)

  if (!currentBid) {
    return true
  }

  return compareBidStrength(nextBid, currentBid) > 0
}