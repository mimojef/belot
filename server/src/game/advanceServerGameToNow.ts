import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { advanceOneServerStep } from './advanceOneServerStep.js'
import { getServerPhaseAutoAdvanceExpiry } from './getServerPhaseAutoAdvanceExpiry.js'
import { getServerTimerExpiry } from './getServerTimerExpiry.js'
import { resolveServerNow } from './resolveServerNow.js'

const MAX_SERVER_CATCH_UP_STEPS = 256

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
    const result = advanceOneServerStep(currentState, resolvedNow, lastEventAt)

    if (!result.advanced) {
      return currentState
    }

    currentState = result.state
    lastEventAt = result.eventAt
  }

  return currentState
}