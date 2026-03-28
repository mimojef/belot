import { createDeck } from '../rules/createDeck'
import { shuffleDeck } from '../rules/shuffleDeck'
import { createEmptyTimerState } from '../state/createRoundDefaults'
import type { GameState } from '../state/gameTypes'

export function startCuttingPhase(state: GameState): GameState {
  const freshDeck = shuffleDeck(createDeck())

  return {
    ...state,
    phase: 'cutting',
    round: {
      ...state.round,
      selectedCutIndex: null,
    },
    deck: freshDeck,
    timer: createEmptyTimerState(),
  }
}