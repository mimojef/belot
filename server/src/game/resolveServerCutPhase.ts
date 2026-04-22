import { cutServerDeck } from './cutServerDeck.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

function resolveFallbackCutIndex(deckLength: number): number {
  if (deckLength <= 1) {
    return 0
  }

  const minCutIndex = 1
  const maxCutIndex = deckLength - 1

  return Math.floor((minCutIndex + maxCutIndex) / 2)
}

export function resolveServerCutPhase(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  const selectedCutIndex =
    state.round.selectedCutIndex ?? resolveFallbackCutIndex(state.deck.length)

  const cutDeckResult = cutServerDeck(state.deck, selectedCutIndex)

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