import { createServerDeck } from './createServerDeck.js'
import { shuffleServerDeck } from './shuffleServerDeck.js'
import {
  clearServerTimerState,
  createServerCuttingTimerState,
} from './serverTimerStateHelpers.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function startServerCuttingPhase(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  const freshDeck = shuffleServerDeck(createServerDeck())
  const cutterSeat = state.round.cutterSeat

  return {
    ...state,
    phase: 'cutting',
    round: {
      ...state.round,
      selectedCutIndex: null,
    },
    deck: freshDeck,
    timer: cutterSeat
      ? createServerCuttingTimerState(state, cutterSeat)
      : clearServerTimerState(),
  }
}