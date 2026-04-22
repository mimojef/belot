import type { ServerRoom } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

function isAuthoritativeGameState(
  value: ServerRoom['game']['authoritativeState'],
): value is ServerAuthoritativeGameState {
  return value !== null && !('kind' in value)
}

export function getRoomAuthoritativeGameState(
  room: ServerRoom,
): ServerAuthoritativeGameState | null {
  const currentState = room.game.authoritativeState

  if (!isAuthoritativeGameState(currentState)) {
    return null
  }

  return currentState
}