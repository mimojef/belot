import { createServerDeck } from './createServerDeck.js'
import { shuffleServerDeck } from './shuffleServerDeck.js'
import {
  clearServerTimerState,
  createServerCuttingTimerState,
} from './serverTimerStateHelpers.js'
import type { ServerAuthoritativeGameState, ServerCard } from './serverGameTypes.js'

// preparedDeck: тесте, подготвено от resolveServerNextRoundDeck (физическо
// размесване на камарата от предишното раздаване). Без него (първо раздаване
// на мача) → пълно случайно разбъркване на ново тесте. След цепенето
// (resolveServerCutPhase) НЕ се прави ново разбъркване.
export function startServerCuttingPhase(
  state: ServerAuthoritativeGameState,
  preparedDeck: ServerCard[] | null = null,
): ServerAuthoritativeGameState {
  const freshDeck = preparedDeck ?? shuffleServerDeck(createServerDeck())
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