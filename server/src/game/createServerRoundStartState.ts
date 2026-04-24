import { SERVER_SEAT_ORDER, type Seat } from '../core/serverTypes.js'
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
  const humanSeats = SERVER_SEAT_ORDER.filter(
    (seat) => state.players[seat].mode === 'human',
  )
  const debugCutterSeat = humanSeats.length === 1 ? humanSeats[0] : null
  // TEMP: cutting UI debug. Revert before commit/production.
  const effectiveDealerSeat =
    debugCutterSeat === null
      ? dealerSeat
      : SERVER_SEAT_ORDER.find(
          (seat) => getSeatBeforeDealer(seat) === debugCutterSeat,
        ) ?? dealerSeat
  const cutterSeat = getSeatBeforeDealer(effectiveDealerSeat)
  const firstBidderSeat = getSeatAfterDealer(effectiveDealerSeat)
  const firstDealSeat = getSeatAfterDealer(effectiveDealerSeat)

  const roundResetState: ServerAuthoritativeGameState = {
    ...state,
    phase: 'cutting',
    round: {
      dealerSeat: effectiveDealerSeat,
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
