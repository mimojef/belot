import type { Seat } from '../../data/constants/seatOrder'
import {
  createEmptyBiddingState,
  createEmptyDeclarations,
  createEmptyHands,
  createEmptyPlayingState,
  createEmptyScoreBreakdown,
  createEmptyTrickState,
  createEmptyWonTricks,
} from '../state/createRoundDefaults'
import type { GameState } from '../state/gameTypes'
import { getSeatAfterDealer, getSeatBeforeDealer } from './phaseHelpers'
import { startCuttingPhase } from './startCuttingPhase'

export function createRoundStartState(state: GameState, dealerSeat: Seat): GameState {
  const cutterSeat = getSeatBeforeDealer(dealerSeat)
  const firstBidderSeat = getSeatAfterDealer(dealerSeat)
  const firstDealSeat = getSeatAfterDealer(dealerSeat)

  const roundResetState: GameState = {
    ...state,
    phase: 'cutting',
    round: {
      dealerSeat,
      cutterSeat,
      firstBidderSeat,
      firstDealSeat,
      selectedCutIndex: null,
    },
    deck: [],
    hands: createEmptyHands(),
    bidding: createEmptyBiddingState(),
    declarations: createEmptyDeclarations(),
    currentTrick: createEmptyTrickState(),
    wonTricks: createEmptyWonTricks(),
    playing: createEmptyPlayingState(),
    score: {
      ...state.score,
      round: createEmptyScoreBreakdown(),
    },
  }

  return startCuttingPhase(roundResetState)
}