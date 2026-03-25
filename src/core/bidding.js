const BID_ORDER = ['bottom', 'left', 'top', 'right']
const SUIT_OPTIONS = ['clubs', 'diamonds', 'hearts', 'spades']
const CONTRACT_OPTIONS = ['color', 'no-trumps', 'all-trumps']

function getPlayerTeam(playerId) {
  if (playerId === 'bottom' || playerId === 'top') {
    return 'A'
  }

  if (playerId === 'left' || playerId === 'right') {
    return 'B'
  }

  return null
}

function getSuitRank(suit) {
  return SUIT_OPTIONS.indexOf(suit)
}

function getBidRank(contract, trumpSuit) {
  if (!contract) {
    return -1
  }

  if (contract === 'color') {
    return getSuitRank(trumpSuit)
  }

  if (contract === 'no-trumps') {
    return 4
  }

  if (contract === 'all-trumps') {
    return 5
  }

  return -1
}

function getAllowedSuitsForState(biddingState) {
  const currentRank = getBidRank(biddingState.contract, biddingState.trumpSuit)

  if (currentRank < 0) {
    return [...SUIT_OPTIONS]
  }

  if (biddingState.contract !== 'color') {
    return []
  }

  return SUIT_OPTIONS.filter((suit) => getSuitRank(suit) > currentRank)
}

function getAllowedContractsForState(biddingState) {
  const currentRank = getBidRank(biddingState.contract, biddingState.trumpSuit)
  const allowed = []

  if (getAllowedSuitsForState(biddingState).length > 0) {
    allowed.push('color')
  }

  if (currentRank < 4) {
    allowed.push('no-trumps')
  }

  if (currentRank < 5) {
    allowed.push('all-trumps')
  }

  return allowed
}

export function canDoubleBid(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return false
  }

  if (!biddingState.contract || !biddingState.winningBidder) {
    return false
  }

  if (biddingState.isDoubled) {
    return false
  }

  const bidder = player ?? biddingState.currentTurn
  const bidderTeam = getPlayerTeam(bidder)
  const winningTeam = getPlayerTeam(biddingState.winningBidder)

  if (!bidderTeam || !winningTeam) {
    return false
  }

  return bidderTeam !== winningTeam
}

export function canRedoubleBid(biddingState, player = null) {
  if (!biddingState || biddingState.isComplete) {
    return false
  }

  if (!biddingState.contract || !biddingState.winningBidder) {
    return false
  }

  if (!biddingState.isDoubled || biddingState.isRedoubled) {
    return false
  }

  const bidder = player ?? biddingState.currentTurn
  const bidderTeam = getPlayerTeam(bidder)
  const winningTeam = getPlayerTeam(biddingState.winningBidder)

  if (!bidderTeam || !winningTeam) {
    return false
  }

  return bidderTeam === winningTeam
}

export function canBidSuit(biddingState, suit) {
  if (!biddingState || biddingState.isComplete) {
    return false
  }

  return getAllowedSuitsForState(biddingState).includes(suit)
}

export function canBidContract(biddingState, contract) {
  if (!biddingState || biddingState.isComplete) {
    return false
  }

  return getAllowedContractsForState(biddingState).includes(contract)
}

function refreshAllowedBids(biddingState) {
  if (!biddingState) {
    return biddingState
  }

  biddingState.allowedSuits = getAllowedSuitsForState(biddingState)
  biddingState.allowedContracts = getAllowedContractsForState(biddingState)
  biddingState.canDouble = canDoubleBid(biddingState)
  biddingState.canRedouble = canRedoubleBid(biddingState)

  return biddingState
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
  const biddingState = {
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
    canDouble: false,
    canRedouble: false,
  }

  return refreshAllowedBids(biddingState)
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