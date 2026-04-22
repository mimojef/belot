import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { createServerRoundStartState } from './createServerRoundStartState.js'
import { getNextSeat } from './serverPhaseHelpers.js'

export function startNextServerRound(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  const currentDealerSeat = state.round.dealerSeat

  if (!currentDealerSeat) {
    return state
  }

  const nextDealerSeat = getNextSeat(currentDealerSeat)

  return createServerRoundStartState(state, nextDealerSeat)
}