import { SUIT_OPTIONS } from './biddingConfig.js'

export function getSuitRank(suit) {
  return SUIT_OPTIONS.indexOf(suit)
}

export function getBidRank(contract, trumpSuit) {
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