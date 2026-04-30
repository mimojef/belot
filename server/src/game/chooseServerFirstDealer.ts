import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { createServerRoundStartState } from './createServerRoundStartState.js'

export function chooseServerFirstDealer(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  const dealerSeat: Seat = 'right'
  return createServerRoundStartState(state, dealerSeat)
}
