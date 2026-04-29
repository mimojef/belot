import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import {
  clearServerTimerState,
  createServerPlayingTimerState,
} from './serverTimerStateHelpers.js'
import {
  createEmptyPlayingState,
  createEmptyTrickState,
} from './createServerRoundDefaults.js'

export function startServerPlayingPhase(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  if (state.playing?.hasStarted) {
    return state
  }

  const firstPlayerSeat = state.round.firstDealSeat

  if (!firstPlayerSeat) {
    return {
      ...state,
      phase: 'playing',
      playing: createEmptyPlayingState(),
      timer: clearServerTimerState(),
    }
  }

  const firstTrick = {
    ...createEmptyTrickState(),
    leaderSeat: firstPlayerSeat,
    currentSeat: firstPlayerSeat,
    trickIndex: 0,
  }

  return {
    ...state,
    phase: 'playing',
    playing: {
      ...createEmptyPlayingState(),
      hasStarted: true,
      currentTurnSeat: firstPlayerSeat,
      currentTrick: firstTrick,
    },
    timer: createServerPlayingTimerState(state, firstPlayerSeat),
  }
}
