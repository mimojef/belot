import type { GameState } from '../state/gameTypes'
import {
  clearTimerState,
  createScoringTimerState,
  getTimerNow,
} from '../timers/timerStateHelpers'

const MATCH_TARGET_SCORE = 151

function hasReachedMatchTarget(matchScore: GameState['score']['match']): boolean {
  return matchScore.teamA >= MATCH_TARGET_SCORE || matchScore.teamB >= MATCH_TARGET_SCORE
}

function isCapotRound(
  baseRoundScore:
    | {
        teamA: { tricksWon: number }
        teamB: { tricksWon: number }
      }
    | null
    | undefined
): boolean {
  if (!baseRoundScore) {
    return false
  }

  return baseRoundScore.teamA.tricksWon === 0 || baseRoundScore.teamB.tricksWon === 0
}

function shouldEndMatch(
  matchScore: GameState['score']['match'],
  baseRoundScore:
    | {
        teamA: { tricksWon: number }
        teamB: { tricksWon: number }
      }
    | null
    | undefined
): boolean {
  if (!hasReachedMatchTarget(matchScore)) {
    return false
  }

  if (isCapotRound(baseRoundScore)) {
    return false
  }

  if (matchScore.teamA === matchScore.teamB) {
    return false
  }

  return true
}

export function finalizePendingScoringTransition(state: GameState): GameState {
  if (state.phase !== 'playing' || !state.playing?.pendingScoringTransition) {
    return state
  }

  const pending = state.playing.pendingScoringTransition
  const nextPhase = shouldEndMatch(
    pending.matchScore,
    pending.scoring.baseRoundScore
  )
    ? 'match-ended'
    : 'scoring'

  const now = getTimerNow()

  return {
    ...state,
    phase: nextPhase,
    phaseEnteredAt: now,
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
    timer: nextPhase === 'scoring'
      ? createScoringTimerState(now)
      : clearTimerState(),
  }
}