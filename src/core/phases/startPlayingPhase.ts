import {
  createEmptyPlayingState,
  createEmptyTrickState,
} from '../state/createRoundDefaults'
import type { GameState } from '../state/gameTypes'

export function startPlayingPhase(state: GameState): GameState {
  const firstTurnSeat = state.round.firstDealSeat

  const initialTrick = {
    ...createEmptyTrickState(),
    leaderSeat: firstTurnSeat,
    currentSeat: firstTurnSeat,
    trickIndex: 0,
  }

  return {
    ...state,
    phase: 'playing',
    currentTrick: initialTrick,
    playing: {
      ...createEmptyPlayingState(),
      hasStarted: true,
      currentTurnSeat: firstTurnSeat,
      currentTrick: initialTrick,
    },
  }
}