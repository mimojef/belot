import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import type { AuthoritativePhaseType } from './serverPhaseTypes.js'
import { dealServerFirstThreePhase } from './dealServerFirstThreePhase.js'
import { dealServerLastThreePhase } from './dealServerLastThreePhase.js'
import { dealServerNextTwoPhase } from './dealServerNextTwoPhase.js'
import { resolveServerCutPhase } from './resolveServerCutPhase.js'
import { startServerBiddingPhase } from './startServerBiddingPhase.js'
import { startServerPlayingPhase } from './startServerPlayingPhase.js'
import { startServerScoringPhase } from './startServerScoringPhase.js'

function getPhaseEnteredAt(): number {
  return Date.now()
}

function withPhaseEnteredAt(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  return {
    ...state,
    phaseEnteredAt: getPhaseEnteredAt(),
  }
}

export function enterServerPhase(
  state: ServerAuthoritativeGameState,
  phase: AuthoritativePhaseType,
): ServerAuthoritativeGameState {
  if (phase === 'cut-resolve') {
    return withPhaseEnteredAt(resolveServerCutPhase(state))
  }

  if (phase === 'deal-first-3') {
    return withPhaseEnteredAt(dealServerFirstThreePhase(state))
  }

  if (phase === 'deal-next-2') {
    return withPhaseEnteredAt(dealServerNextTwoPhase(state))
  }

  if (phase === 'bidding') {
    return withPhaseEnteredAt(startServerBiddingPhase(state))
  }

  if (phase === 'deal-last-3') {
    return withPhaseEnteredAt(dealServerLastThreePhase(state))
  }

  if (phase === 'playing') {
    return withPhaseEnteredAt(startServerPlayingPhase(state))
  }

  if (phase === 'scoring') {
    return withPhaseEnteredAt(startServerScoringPhase(state))
  }

  return withPhaseEnteredAt({
    ...state,
    phase,
  })
}
