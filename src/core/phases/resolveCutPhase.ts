import { cutDeck } from '../rules/cutDeck'
import type { GameState } from '../state/gameTypes'

function resolveFallbackCutIndex(deckLength: number): number {
  if (deckLength <= 1) {
    return 0
  }

  const minCutIndex = 1
  const maxCutIndex = deckLength - 1

  return Math.floor((minCutIndex + maxCutIndex) / 2)
}

export function resolveCutPhase(state: GameState): GameState {
  const selectedCutIndex =
    state.round.selectedCutIndex ?? resolveFallbackCutIndex(state.deck.length)

  const cutDeckResult = cutDeck(state.deck, selectedCutIndex)

  return {
    ...state,
    phase: 'cut-resolve',
    round: {
      ...state.round,
      selectedCutIndex,
    },
    deck: cutDeckResult,
  }
}