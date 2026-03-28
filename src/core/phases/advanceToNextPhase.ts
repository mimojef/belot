import { getNextPhase } from './phaseFlow'
import type { GameState } from '../state/gameTypes'

export function advanceToNextPhase(state: GameState): GameState {
  const nextPhase = getNextPhase(state.phase)

  if (!nextPhase) {
    return state
  }

  return {
    ...state,
    phase: nextPhase,
  }
}