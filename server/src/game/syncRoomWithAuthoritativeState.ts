import type { ServerRoom } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { mapAuthoritativePhaseToRuntimePhase } from './mapAuthoritativePhaseToRuntimePhase.js'

export function syncRoomWithAuthoritativeState(
  room: ServerRoom,
  authoritativeState: ServerAuthoritativeGameState,
  now: number = Date.now(),
): ServerRoom {
  return {
    ...room,
    updatedAt: now,
    game: {
      ...room.game,
      phase: mapAuthoritativePhaseToRuntimePhase(authoritativeState.phase),
      stateVersion: room.game.stateVersion + 1,
      startedAt: room.game.startedAt ?? now,
      updatedAt: now,
      activeTimerId: null,
      timerDeadlineAt: authoritativeState.timer.expiresAt,
      authoritativeState,
    },
  }
}