import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import type { ServerAntiBadLuckConfig } from './antiBadLuck/serverAntiBadLuckTypes.js'
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

// antiBadLuckConfig е нужен САМО за 'deal-first-3' (Anti Bad Luck). Пътища,
// които структурно никога не влизат в deal-first-3 (bid submit → deal-last-3 /
// next-round), подават explicit null. null при 'deal-first-3' е bug →
// хвърля, НЕ fallback-ва към default прага.
export function enterServerPhase(
  state: ServerAuthoritativeGameState,
  phase: AuthoritativePhaseType,
  antiBadLuckConfig: ServerAntiBadLuckConfig | null,
): ServerAuthoritativeGameState {
  if (phase === 'cut-resolve') {
    return withPhaseEnteredAt(resolveServerCutPhase(state))
  }

  if (phase === 'deal-first-3') {
    if (antiBadLuckConfig === null) {
      throw new Error('[enterServerPhase] deal-first-3 requires antiBadLuckConfig (no default threshold fallback).')
    }
    return withPhaseEnteredAt(dealServerFirstThreePhase(state, antiBadLuckConfig))
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
