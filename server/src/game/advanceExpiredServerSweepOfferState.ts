import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { rebaseServerStateToEventAt } from './rebaseServerStateToEventAt.js'
import { submitServerSweepDecision } from './submitServerSweepDecision.js'

export type AdvanceExpiredServerSweepOfferStateResult = {
  state: ServerAuthoritativeGameState
  advanced: boolean
  eventAt: number
  stopCatchUpAfterStep?: boolean
}

// Timeout policy: auto-DECLINE (not auto-accept) — a disconnected/afk
// claimant never stalls the match, and play simply continues normally for
// everyone else. See SERVER_TIMING_CONFIG.sweepOfferHumanTimeoutMs.
export function advanceExpiredServerSweepOfferState(
  state: ServerAuthoritativeGameState,
  eventAt: number,
): AdvanceExpiredServerSweepOfferStateResult {
  const sweepOffer = state.playing?.sweepOffer ?? null

  if (sweepOffer === null) {
    return { state, advanced: false, eventAt }
  }

  const nextState = rebaseServerStateToEventAt(
    submitServerSweepDecision(state, sweepOffer.seat, 'decline'),
    eventAt,
  )

  return {
    state: nextState,
    advanced: true,
    eventAt,
    stopCatchUpAfterStep: true,
  }
}
