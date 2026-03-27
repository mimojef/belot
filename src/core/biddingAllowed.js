import { SUIT_OPTIONS } from './biddingConfig.js'
import { getBidRank, getSuitRank } from './biddingRanks.js'

export function getAllowedSuitsForState(biddingState) {
  const currentRank = getBidRank(biddingState.contract, biddingState.trumpSuit)

  if (currentRank < 0) {
    return [...SUIT_OPTIONS]
  }

  if (biddingState.contract !== 'color') {
    return []
  }

  return SUIT_OPTIONS.filter((suit) => getSuitRank(suit) > currentRank)
}

export function getAllowedContractsForState(biddingState) {
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