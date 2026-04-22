import type { ServerRoom } from '../core/serverTypes.js'
import { advanceServerGameToNow } from './advanceServerGameToNow.js'
import { getRoomAuthoritativeGameState } from './getRoomAuthoritativeGameState.js'
import { syncRoomWithAuthoritativeState } from './syncRoomWithAuthoritativeState.js'

export function advanceRoomAuthoritativeGame(
  room: ServerRoom,
  now: number = Date.now(),
): ServerRoom {
  const authoritativeState = getRoomAuthoritativeGameState(room)

  if (authoritativeState === null) {
    return room
  }

  const nextAuthoritativeState = advanceServerGameToNow(authoritativeState, now)

  return syncRoomWithAuthoritativeState(room, nextAuthoritativeState, now)
}