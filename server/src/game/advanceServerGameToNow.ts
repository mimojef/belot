import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { advanceOneServerStep } from './advanceOneServerStep.js'
import { getServerPhaseAutoAdvanceExpiry } from './getServerPhaseAutoAdvanceExpiry.js'
import { getServerTimerExpiry } from './getServerTimerExpiry.js'
import { resolveServerNow } from './resolveServerNow.js'

const MAX_SERVER_CATCH_UP_STEPS = 256
const DEAL_VISUAL_PHASES = new Set<ServerAuthoritativeGameState['phase']>([
  'deal-first-3',
  'deal-next-2',
  'deal-last-3',
])

function isDealVisualPhase(phase: ServerAuthoritativeGameState['phase']): boolean {
  return DEAL_VISUAL_PHASES.has(phase)
}

export function advanceServerGameToNow(
  state: ServerAuthoritativeGameState,
  now?: number,
): ServerAuthoritativeGameState {
  const resolvedNow = resolveServerNow(now)
  let currentState = state
  let lastEventAt =
    getServerTimerExpiry(state) ??
    getServerPhaseAutoAdvanceExpiry(state) ??
    resolvedNow

  for (let step = 0; step < MAX_SERVER_CATCH_UP_STEPS; step += 1) {
    const previousPhase = currentState.phase
    const result = advanceOneServerStep(currentState, resolvedNow, lastEventAt)

    if (!result.advanced) {
      return currentState
    }

    currentState = result.state
    lastEventAt = result.eventAt

    if (
      result.stopCatchUpAfterStep === true ||
      isDealVisualPhase(previousPhase) ||
      isDealVisualPhase(currentState.phase)
    ) {
      return currentState
    }
  }

  return currentState
}
