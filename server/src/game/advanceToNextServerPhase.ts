import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { getNextServerPhase } from './serverPhaseFlow.js'

export function advanceToNextServerPhase(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  const nextPhase = getNextServerPhase(state.phase)

  if (!nextPhase) {
    return state
  }

  return {
    ...state,
    phase: nextPhase,
  }
}