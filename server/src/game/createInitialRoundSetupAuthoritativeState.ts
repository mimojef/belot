import type { ServerRoom } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { chooseServerFirstDealer } from './chooseServerFirstDealer.js'
import { createInitialAuthoritativeGameState } from './createInitialAuthoritativeGameState.js'

export function createInitialRoundSetupAuthoritativeState(
  room: ServerRoom,
): ServerAuthoritativeGameState {
  const initialState = createInitialAuthoritativeGameState(room)
  return chooseServerFirstDealer(initialState)
}