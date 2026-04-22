import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function selectServerCutIndex(
  state: ServerAuthoritativeGameState,
  cutIndex: number,
): ServerAuthoritativeGameState {
  if (state.phase !== 'cutting') {
    return state
  }

  if (!Number.isInteger(cutIndex)) {
    return state
  }

  if (cutIndex <= 0 || cutIndex >= state.deck.length) {
    return state
  }

  return {
    ...state,
    round: {
      ...state.round,
      selectedCutIndex: cutIndex,
    },
  }
}