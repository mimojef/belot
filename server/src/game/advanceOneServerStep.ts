import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { advanceExpiredServerAutoPhaseState } from './advanceExpiredServerAutoPhaseState.js'
import { advanceExpiredServerBiddingState } from './advanceExpiredServerBiddingState.js'
import { advanceExpiredServerCuttingState } from './advanceExpiredServerCuttingState.js'
import { advanceExpiredServerPlayingState } from './advanceExpiredServerPlayingState.js'
import { getServerPhaseAutoAdvanceExpiry } from './getServerPhaseAutoAdvanceExpiry.js'
import { getServerTimerExpiry } from './getServerTimerExpiry.js'

export type AdvanceOneServerStepResult = {
  state: ServerAuthoritativeGameState
  advanced: boolean
  eventAt: number
}

export function advanceOneServerStep(
  state: ServerAuthoritativeGameState,
  now: number,
  fallbackEventAt: number,
): AdvanceOneServerStepResult {
  if (state.phase === 'cutting' && state.round.selectedCutIndex !== null) {
    return advanceExpiredServerCuttingState(state, now)
  }

  const phaseAutoAdvanceExpiry = getServerPhaseAutoAdvanceExpiry(state)

  if (phaseAutoAdvanceExpiry !== null && now >= phaseAutoAdvanceExpiry) {
    return advanceExpiredServerAutoPhaseState(state, phaseAutoAdvanceExpiry)
  }

  const expiresAt = getServerTimerExpiry(state)

  if (expiresAt === null || now < expiresAt) {
    return {
      state,
      advanced: false,
      eventAt: fallbackEventAt,
    }
  }

  if (state.phase === 'cutting') {
    return advanceExpiredServerCuttingState(state, expiresAt)
  }

  if (state.phase === 'bidding' && !state.bidding.hasEnded) {
    return advanceExpiredServerBiddingState(state, expiresAt)
  }

  if (
    state.phase === 'playing' &&
    state.playing?.hasStarted &&
    state.playing.currentTurnSeat !== null
  ) {
    return advanceExpiredServerPlayingState(state, expiresAt)
  }

  return {
    state,
    advanced: false,
    eventAt: fallbackEventAt,
  }
}
