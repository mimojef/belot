import type { Seat } from '../core/serverTypes.js'
import {
  createEmptyBiddingState,
  createEmptyDeclarations,
  createEmptyHands,
  createEmptyPlayingState,
  createEmptyScoreBreakdown,
  createEmptyTrickState,
  createEmptyWonTricks,
} from './createServerRoundDefaults.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { getSeatAfterDealer, getSeatBeforeDealer } from './serverPhaseHelpers.js'
import { startServerCuttingPhase } from './startServerCuttingPhase.js'

export function createServerRoundStartState(
  state: ServerAuthoritativeGameState,
  dealerSeat: Seat,
): ServerAuthoritativeGameState {
  const cutterSeat = getSeatBeforeDealer(dealerSeat)
  const firstBidderSeat = getSeatAfterDealer(dealerSeat)
  const firstDealSeat = getSeatAfterDealer(dealerSeat)

  const roundResetState: ServerAuthoritativeGameState = {
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

  return startServerCuttingPhase(roundResetState)
}
