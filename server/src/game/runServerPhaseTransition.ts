import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { enterServerPhase } from './enterServerPhase.js'
import { advanceToNextServerPhase } from './advanceToNextServerPhase.js'
import { startNextServerRound } from './startNextServerRound.js'

export function runServerPhaseTransition(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  if (state.phase === 'next-round') {
    return startNextServerRound(state)
  }

  const advancedState = advanceToNextServerPhase(state)

  if (advancedState.phase === state.phase) {
    return state
  }

  return enterServerPhase(advancedState, advancedState.phase)
}