import type { ServerRoom } from '../core/serverTypes.js'
import { createInitialRoundSetupAuthoritativeState } from './createInitialRoundSetupAuthoritativeState.js'
import { mapAuthoritativePhaseToRuntimePhase } from './mapAuthoritativePhaseToRuntimePhase.js'

function hasRealAuthoritativeState(room: ServerRoom): boolean {
  const currentState = room.game.authoritativeState

  return currentState !== null && !('kind' in currentState)
}

export function initializeRoomAuthoritativeGameState(
  room: ServerRoom,
): ServerRoom {
  if (hasRealAuthoritativeState(room)) {
    return room
  }

  const authoritativeState = createInitialRoundSetupAuthoritativeState(room)
  const now = Date.now()

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