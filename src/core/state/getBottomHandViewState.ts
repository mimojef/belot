import type { Card, GameState } from './gameTypes'

export type BottomHandViewState = {
  shouldShow: boolean
  cards: Card[]
}

function shouldShowBottomHandForPhase(phase: GameState['phase']): boolean {
  return (
    phase === 'deal-first-3' ||
    phase === 'deal-next-2' ||
    phase === 'bidding' ||
    phase === 'deal-last-3' ||
    phase === 'playing'
  )
}

export function getBottomHandViewState(state: GameState): BottomHandViewState {
  const shouldShow = shouldShowBottomHandForPhase(state.phase)

  return {
    shouldShow,
    cards: shouldShow ? state.hands.bottom : [],
  }
}