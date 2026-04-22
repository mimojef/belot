import type { GameState } from '../state/gameTypes'

function normalizeCutIndex(cutIndex: number, deckLength: number): number {
  if (deckLength <= 1) {
    return 0
  }

  const safeCutIndex = Math.trunc(cutIndex)
  const minCutIndex = 1
  const maxCutIndex = deckLength - 1

  if (safeCutIndex < minCutIndex) {
    return minCutIndex
  }

  if (safeCutIndex > maxCutIndex) {
    return maxCutIndex
  }

  return safeCutIndex
}

export function selectCutIndex(state: GameState, cutIndex: number): GameState {
  if (state.phase !== 'cutting') {
    return state
  }

  return {
    ...state,
    round: {
      ...state.round,
      selectedCutIndex: normalizeCutIndex(cutIndex, state.deck.length),
    },
  }
}