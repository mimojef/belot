import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { resolveServerScoring } from './serverScoring.js'
import { createServerScoringTimerState } from './serverTimerStateHelpers.js'

export function startServerScoringPhase(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  if (state.scoring !== null) {
    return state
  }

  const scoringResolution = resolveServerScoring(state)

  if (scoringResolution === null) {
    return {
      ...state,
      phase: 'scoring',
      timer: createServerScoringTimerState(),
    }
  }

  return {
    ...state,
    phase: 'scoring',
    scoring: scoringResolution.scoring,
    score: {
      round: scoringResolution.roundBreakdown,
      match: scoringResolution.matchTotals,
      carryOver: scoringResolution.carryOver,
    },
    timer: createServerScoringTimerState(),
  }
}
