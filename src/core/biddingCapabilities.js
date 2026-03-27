import { getPlayerTeam } from './biddingTeams.js'
import { getAllowedSuitsForState, getAllowedContractsForState } from './biddingAllowed.js'

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