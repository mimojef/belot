import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import type { ServerAntiBadLuckConfig } from './antiBadLuck/serverAntiBadLuckTypes.js'
import { rebaseServerStateToEventAt } from './rebaseServerStateToEventAt.js'
import { runServerPhaseTransition } from './runServerPhaseTransition.js'

export type AdvanceExpiredServerAutoPhaseStateResult = {
  state: ServerAuthoritativeGameState
  advanced: boolean
  eventAt: number
}

export function advanceExpiredServerAutoPhaseState(
  state: ServerAuthoritativeGameState,
  eventAt: number,
  antiBadLuckConfig: ServerAntiBadLuckConfig,
): AdvanceExpiredServerAutoPhaseStateResult {
  return {
    state: rebaseServerStateToEventAt(runServerPhaseTransition(state, antiBadLuckConfig), eventAt),
    advanced: true,
    eventAt,
  }
}