import type { Team } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { resolveServerScoring } from './serverScoring.js'
import {
  clearServerTimerState,
  createServerScoringTimerState,
  getServerTimerNow,
} from './serverTimerStateHelpers.js'

function getMatchWinnerTeam(
  matchTotals: ServerAuthoritativeGameState['score']['match'],
  targetScore: number,
): Team | null {
  const teamAReachedTarget = matchTotals.teamA >= targetScore
  const teamBReachedTarget = matchTotals.teamB >= targetScore

  if (!teamAReachedTarget && !teamBReachedTarget) {
    return null
  }

  if (matchTotals.teamA === matchTotals.teamB) {
    return null
  }

  return matchTotals.teamA > matchTotals.teamB ? 'A' : 'B'
}

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
      matchEnded: null,
      timer: createServerScoringTimerState(),
    }
  }

  const winnerTeam = scoringResolution.scoring.isNonCapotRound
    ? getMatchWinnerTeam(scoringResolution.matchTotals, state.targetScore)
    : null
  const matchEnded =
    winnerTeam === null
      ? null
      : {
          winnerTeam,
          targetScore: state.targetScore,
          finalScore: scoringResolution.matchTotals,
          endedAt: getServerTimerNow(),
        }

  return {
    ...state,
    phase: matchEnded === null ? 'scoring' : 'match-ended',
    scoring: scoringResolution.scoring,
    matchEnded,
    score: {
      round: scoringResolution.roundBreakdown,
      match: scoringResolution.matchTotals,
      carryOver: scoringResolution.carryOver,
    },
    timer: matchEnded === null
      ? createServerScoringTimerState()
      : clearServerTimerState(),
  }
}
