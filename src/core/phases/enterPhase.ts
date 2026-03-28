import type { GameState } from '../state/gameTypes'
import type { PhaseType } from './phaseTypes'
import { dealFirstThreePhase } from './dealFirstThreePhase'
import { dealLastThreePhase } from './dealLastThreePhase'
import { dealNextTwoPhase } from './dealNextTwoPhase'
import { resolveCutPhase } from './resolveCutPhase'
import { startBiddingPhase } from './startBiddingPhase'

export function enterPhase(state: GameState, phase: PhaseType): GameState {
  if (phase === 'cut-resolve') {
    return resolveCutPhase(state)
  }

  if (phase === 'deal-first-3') {
    return dealFirstThreePhase(state)
  }

  if (phase === 'deal-next-2') {
    return dealNextTwoPhase(state)
  }

  if (phase === 'bidding') {
    return startBiddingPhase(state)
  }

  if (phase === 'deal-last-3') {
    return dealLastThreePhase(state)
  }

  return {
    ...state,
    phase,
  }
}