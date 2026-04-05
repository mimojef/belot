import type { GameState } from '../state/gameTypes'

function getPhaseEnteredAt(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }

  return Date.now()
}

export function finalizePendingScoringTransition(state: GameState): GameState {
  if (state.phase !== 'playing' || !state.playing?.pendingScoringTransition) {
    return state
  }

  const pending = state.playing.pendingScoringTransition

  return {
    ...state,
    phase: 'scoring',
    phaseEnteredAt: getPhaseEnteredAt(),
    declarations: pending.declarations,
    scoring: pending.scoring,
    score: {
      ...state.score,
      round: pending.roundScore,
      match: pending.matchScore,
      carryOver: pending.carryOver,
    },
    playing: {
      ...state.playing,
      trickCollectionSnapshot: null,
      pendingScoringTransition: null,
    },
  }
}