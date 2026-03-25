const BID_ORDER = ['bottom', 'left', 'top', 'right']
const SUIT_OPTIONS = ['clubs', 'diamonds', 'hearts', 'spades']
const CONTRACT_OPTIONS = ['color', 'all-trumps', 'no-trumps']

function getPlayerTeam(playerId) {
  if (playerId === 'bottom' || playerId === 'top') {
    return 'A'
  }

  if (playerId === 'left' || playerId === 'right') {
    return 'B'
  }

  return null
}

export function getBidOrder(startPlayer = 'bottom') {
  const startIndex = BID_ORDER.indexOf(startPlayer)

  if (startIndex === -1) {
    return [...BID_ORDER]
  }

  return [
    ...BID_ORDER.slice(startIndex),
    ...BID_ORDER.slice(0, startIndex),
  ]
}

export function createInitialBiddingState(startPlayer = 'bottom') {
  return {
    starter: startPlayer,
    currentTurn: startPlayer,
    order: getBidOrder(startPlayer),
    history: [],
    passesInRow: 0,
    contract: null,
    trumpSuit: null,
    winningBidder: null,
    isComplete: false,
    allowedSuits: [...SUIT_OPTIONS],
    allowedContracts: [...CONTRACT_OPTIONS],
    isDoubled: false,
    isRedoubled: false,
  }
}

export function getNextBidPlayer(currentPlayer) {
  const currentIndex = BID_ORDER.indexOf(currentPlayer)

  if (currentIndex === -1) {
    return BID_ORDER[0]
  }

  return BID_ORDER[(currentIndex + 1) % BID_ORDER.length]
}

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
    return biddingState
  }

  if (!biddingState.contract && biddingState.passesInRow >= 4) {
    biddingState.isComplete = true
    biddingState.currentTurn = null
    return biddingState
  }

  biddingState.currentTurn = nextPlayer

  return biddingState
}

export function applySuitBid(biddingState, suit, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return biddingState
  }

  if (!SUIT_OPTIONS.includes(suit)) {
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

  return biddingState
}

export function applyAllTrumpsBid(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
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

  return biddingState
}

export function applyNoTrumpsBid(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
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

  return biddingState
}

export function applyDouble(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return biddingState
  }

  if (!biddingState.contract || !biddingState.winningBidder) {
    return biddingState
  }

  if (biddingState.isDoubled) {
    return biddingState
  }

  const bidder = player ?? biddingState.currentTurn
  const bidderTeam = getPlayerTeam(bidder)
  const winningTeam = getPlayerTeam(biddingState.winningBidder)

  if (!bidderTeam || !winningTeam || bidderTeam === winningTeam) {
    return biddingState
  }

  biddingState.history.push({
    player: bidder,
    action: 'контра',
  })

  biddingState.isDoubled = true
  biddingState.isRedoubled = false
  biddingState.passesInRow = 0
  biddingState.currentTurn = getNextBidPlayer(bidder)

  return biddingState
}

export function applyRedouble(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return biddingState
  }

  if (!biddingState.contract || !biddingState.winningBidder) {
    return biddingState
  }

  if (!biddingState.isDoubled || biddingState.isRedoubled) {
    return biddingState
  }

  const bidder = player ?? biddingState.currentTurn
  const bidderTeam = getPlayerTeam(bidder)
  const winningTeam = getPlayerTeam(biddingState.winningBidder)

  if (!bidderTeam || !winningTeam || bidderTeam !== winningTeam) {
    return biddingState
  }

  biddingState.history.push({
    player: bidder,
    action: 'ре контра',
  })

  biddingState.isRedoubled = true
  biddingState.passesInRow = 0
  biddingState.currentTurn = getNextBidPlayer(bidder)

  return biddingState
}