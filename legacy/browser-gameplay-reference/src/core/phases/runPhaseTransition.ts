import type { GameState } from '../state/gameTypes'
import { enterPhase } from './enterPhase'
import { advanceToNextPhase } from './advanceToNextPhase'
import { startNextRound } from './startNextRound'

export function runPhaseTransition(state: GameState): GameState {
  if (state.phase === 'next-round') {
    return startNextRound(state)
  }

  const advancedState = advanceToNextPhase(state)

  if (advancedState.phase === state.phase) {
    return state
  }

  return enterPhase(advancedState, advancedState.phase)
}