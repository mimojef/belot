import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { getServerPhaseAutoAdvanceDelay } from './getServerPhaseAutoAdvanceDelay.js'

function getServerPhaseEnteredAt(
  state: ServerAuthoritativeGameState,
): number | null {
  const phaseEnteredAt = state.phaseEnteredAt

  if (typeof phaseEnteredAt !== 'number' || !Number.isFinite(phaseEnteredAt)) {
    return null
  }

  return phaseEnteredAt
}

export function getServerPhaseAutoAdvanceExpiry(
  state: ServerAuthoritativeGameState,
): number | null {
  const phaseEnteredAt = getServerPhaseEnteredAt(state)
  const delayMs = getServerPhaseAutoAdvanceDelay(state)

  if (phaseEnteredAt === null || delayMs === null) {
    return null
  }

  return phaseEnteredAt + delayMs
}
