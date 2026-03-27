import { canBidSuit, canBidContract, canDoubleBid, canRedoubleBid } from './biddingCapabilities.js'
import { refreshAllowedBids } from './biddingStateHelpers.js'
import { getNextBidPlayer } from './biddingTurn.js'

export function applyPass(biddingState) {
  if (!biddingState || biddingState.isComplete) {
    return biddingState
  }

  const currentPlayer = biddingState.currentTurn
  const nextPlayer = getNextBidPlayer(currentPlayer)

  biddingState.history.push({
    player: currentPlayer,
    action: 'пас',
  })

  biddingState.passesInRow += 1

  if (biddingState.contract && biddingState.passesInRow >= 3) {
    biddingState.isComplete = true
    biddingState.currentTurn = null
    return refreshAllowedBids(biddingState)
  }

  if (!biddingState.contract && biddingState.passesInRow >= 4) {
    biddingState.isComplete = true
    biddingState.currentTurn = null
    return refreshAllowedBids(biddingState)
  }

  biddingState.currentTurn = nextPlayer

  return refreshAllowedBids(biddingState)
}

export function applySuitBid(biddingState, suit, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return biddingState
  }

  if (!canBidSuit(biddingState, suit)) {
    return biddingState
  }

  const bidder = player ?? biddingState.currentTurn

  biddingState.history.push({
    player: bidder,
    action: `обява ${suit}`,
  })

  biddingState.contract = 'color'
  biddingState.trumpSuit = suit
  biddingState.winningBidder = bidder
  biddingState.passesInRow = 0
  biddingState.isDoubled = false
  biddingState.isRedoubled = false
  biddingState.currentTurn = getNextBidPlayer(bidder)

  return refreshAllowedBids(biddingState)
}

export function applyAllTrumpsBid(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return biddingState
  }

  if (!canBidContract(biddingState, 'all-trumps')) {
    return biddingState
  }

  const bidder = player ?? biddingState.currentTurn

  biddingState.history.push({
    player: bidder,
    action: 'обява всичко коз',
  })

  biddingState.contract = 'all-trumps'
  biddingState.trumpSuit = 'all-trumps'
  biddingState.winningBidder = bidder
  biddingState.passesInRow = 0
  biddingState.isDoubled = false
  biddingState.isRedoubled = false
  biddingState.currentTurn = getNextBidPlayer(bidder)

  return refreshAllowedBids(biddingState)
}

export function applyNoTrumpsBid(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return biddingState
  }

  if (!canBidContract(biddingState, 'no-trumps')) {
    return biddingState
  }

  const bidder = player ?? biddingState.currentTurn

  biddingState.history.push({
    player: bidder,
    action: 'обява без коз',
  })

  biddingState.contract = 'no-trumps'
  biddingState.trumpSuit = 'no-trumps'
  biddingState.winningBidder = bidder
  biddingState.passesInRow = 0
  biddingState.isDoubled = false
  biddingState.isRedoubled = false
  biddingState.currentTurn = getNextBidPlayer(bidder)

  return refreshAllowedBids(biddingState)
}

export function applyDouble(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return biddingState
  }

  if (!canDoubleBid(biddingState, player)) {
    return biddingState
  }

  const bidder = player ?? biddingState.currentTurn

  biddingState.history.push({
    player: bidder,
    action: 'контра',
  })

  biddingState.isDoubled = true
  biddingState.isRedoubled = false
  biddingState.passesInRow = 0
  biddingState.currentTurn = getNextBidPlayer(bidder)

  return refreshAllowedBids(biddingState)
}

export function applyRedouble(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return biddingState
  }

  if (!canRedoubleBid(biddingState, player)) {
    return biddingState
  }

  const bidder = player ?? biddingState.currentTurn

  biddingState.history.push({
    player: bidder,
    action: 'ре контра',
  })

  biddingState.isRedoubled = true
  biddingState.passesInRow = 0
  biddingState.currentTurn = getNextBidPlayer(bidder)

  return refreshAllowedBids(biddingState)
}