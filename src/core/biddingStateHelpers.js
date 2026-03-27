import { SUIT_OPTIONS, CONTRACT_OPTIONS } from './biddingConfig.js'
import { canDoubleBid, canRedoubleBid } from './biddingCapabilities.js'
import { getAllowedSuitsForState, getAllowedContractsForState } from './biddingAllowed.js'

export function refreshAllowedBids(biddingState) {
  if (!biddingState) {
    return biddingState
  }

  biddingState.allowedSuits = getAllowedSuitsForState(biddingState)
  biddingState.allowedContracts = getAllowedContractsForState(biddingState)
  biddingState.canDouble = canDoubleBid(biddingState)
  biddingState.canRedouble = canRedoubleBid(biddingState)

  return biddingState
}

export function createBaseBiddingState(startPlayer = 'bottom') {
  return {
    starter: startPlayer,
    currentTurn: startPlayer,
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
}