import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
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
): AdvanceExpiredServerAutoPhaseStateResult {
  return {
    state: rebaseServerStateToEventAt(runServerPhaseTransition(state), eventAt),
    advanced: true,
    eventAt,
  }
}