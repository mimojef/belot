import type { GameState } from '../state/gameTypes'
import type { PhaseType } from './phaseTypes'
import { dealFirstThreePhase } from './dealFirstThreePhase'
import { dealLastThreePhase } from './dealLastThreePhase'
import { dealNextTwoPhase } from './dealNextTwoPhase'
import { resolveCutPhase } from './resolveCutPhase'
import { startBiddingPhase } from './startBiddingPhase'
import { startPlayingPhase } from './startPlayingPhase'

function getPhaseEnteredAt(): number {
  return Date.now()
}

function withPhaseEnteredAt(state: GameState): GameState {
  return {
    ...state,
    phaseEnteredAt: getPhaseEnteredAt(),
  }
}

export function enterPhase(state: GameState, phase: PhaseType): GameState {
  if (phase === 'cut-resolve') {
    return withPhaseEnteredAt(resolveCutPhase(state))
  }

  if (phase === 'deal-first-3') {
    return withPhaseEnteredAt(dealFirstThreePhase(state))
  }

  if (phase === 'deal-next-2') {
    return withPhaseEnteredAt(dealNextTwoPhase(state))
  }

  if (phase === 'bidding') {
    return withPhaseEnteredAt(startBiddingPhase(state))
  }

  if (phase === 'deal-last-3') {
    return withPhaseEnteredAt(dealLastThreePhase(state))
  }

  if (phase === 'playing') {
    return withPhaseEnteredAt(startPlayingPhase(state))
  }

  return withPhaseEnteredAt({
    ...state,
    phase,
  })
}