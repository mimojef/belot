import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { enterServerPhase } from './enterServerPhase.js'
import { advanceToNextServerPhase } from './advanceToNextServerPhase.js'
import { startNextServerRound } from './startNextServerRound.js'
import {
  clearServerTimerState,
  getServerTimerNow,
} from './serverTimerStateHelpers.js'

export function runServerPhaseTransition(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  if (state.phase === 'match-ended') {
    return state
  }

  if (state.phase === 'scoring') {
    if (state.matchEnded !== null) {
      return enterServerPhase(
        {
          ...state,
          matchEnded: {
            ...state.matchEnded,
            endedAt: getServerTimerNow(),
          },
          timer: clearServerTimerState(),
        },
        'match-ended',
      )
    }

    return startNextServerRound(state)
  }

  if (state.phase === 'next-round') {
    return startNextServerRound(state)
  }

  const advancedState = advanceToNextServerPhase(state)

  if (advancedState.phase === state.phase) {
    return state
  }

  return enterServerPhase(advancedState, advancedState.phase)
}
