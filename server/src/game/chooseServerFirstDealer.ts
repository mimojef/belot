import type { Seat, ServerRoom } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { createServerRoundStartState } from './createServerRoundStartState.js'
import { getDevForcedHumanCutterSeatFromRoom } from './devForceHumanCutter.js'
import { getNextSeat } from './serverPhaseHelpers.js'

export function chooseServerFirstDealer(
  state: ServerAuthoritativeGameState,
  room: ServerRoom,
): ServerAuthoritativeGameState {
  const forcedCutterSeat = getDevForcedHumanCutterSeatFromRoom(room)

  if (forcedCutterSeat !== null) {
    return createServerRoundStartState(state, getNextSeat(forcedCutterSeat))
  }

  const dealerSeat: Seat = 'right'
  return createServerRoundStartState(state, dealerSeat)
}
