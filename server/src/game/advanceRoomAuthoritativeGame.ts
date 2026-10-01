import type { ServerRoom } from '../core/serverTypes.js'
import { assertServerAntiBadLuckConfig, type ServerAntiBadLuckConfig } from './antiBadLuck/serverAntiBadLuckTypes.js'
import { advanceServerGameToNow } from './advanceServerGameToNow.js'
import { getRoomAuthoritativeGameState } from './getRoomAuthoritativeGameState.js'
import { syncRoomWithAuthoritativeState } from './syncRoomWithAuthoritativeState.js'

// Production runtime граница (game worker tick + in-process runtime):
// antiBadLuckConfig (admin setting) е ЗАДЪЛЖИТЕЛЕН и се валидира тук —
// невалиден/липсващ config хвърля, никакъв fallback към default прага.
export function advanceRoomAuthoritativeGame(
  room: ServerRoom,
  now: number,
  antiBadLuckConfig: ServerAntiBadLuckConfig,
): ServerRoom {
  assertServerAntiBadLuckConfig(antiBadLuckConfig, 'advanceRoomAuthoritativeGame')
  const authoritativeState = getRoomAuthoritativeGameState(room)

  if (authoritativeState === null) {
    return room
  }

  const nextAuthoritativeState = advanceServerGameToNow(authoritativeState, now, antiBadLuckConfig)

  if (nextAuthoritativeState === authoritativeState) {
    return room
  }

  return syncRoomWithAuthoritativeState(room, nextAuthoritativeState, now)
}
