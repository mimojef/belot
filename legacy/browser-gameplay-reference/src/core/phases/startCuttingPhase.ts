import { createDeck } from '../rules/createDeck'
import { shuffleDeck } from '../rules/shuffleDeck'
import { createCuttingTimerState, clearTimerState } from '../timers/timerStateHelpers'
import type { GameState } from '../state/gameTypes'

export function startCuttingPhase(state: GameState): GameState {
  const freshDeck = shuffleDeck(createDeck())
  const cutterSeat = state.round.cutterSeat

  return {
    ...state,
    phase: 'cutting',
    round: {
      ...state.round,
      selectedCutIndex: null,
    },
    deck: freshDeck,
    timer: cutterSeat ? createCuttingTimerState(state, cutterSeat) : clearTimerState(),
  }
}