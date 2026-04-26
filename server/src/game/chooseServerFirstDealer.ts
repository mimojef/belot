import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { createServerRoundStartState } from './createServerRoundStartState.js'

export function chooseServerFirstDealer(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  // Temporary cutting UI debug: force the first dealer so the local player cuts.
  const dealerSeat: Seat = 'right'
  return createServerRoundStartState(state, dealerSeat)
}
