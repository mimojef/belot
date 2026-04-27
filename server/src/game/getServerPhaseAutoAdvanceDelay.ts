import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

const CUT_RESOLVE_AUTO_ADVANCE_MS = 0
const DEAL_FIRST_THREE_AUTO_ADVANCE_MS = 2400
const DEAL_NEXT_TWO_AUTO_ADVANCE_MS = 1900
const DEAL_LAST_THREE_AUTO_ADVANCE_MS = 2000
const NEXT_ROUND_AUTO_ADVANCE_MS = 2500
const NEXT_ROUND_AFTER_ALL_PASS_AUTO_ADVANCE_MS = 800

export function getServerPhaseAutoAdvanceDelay(
  state: ServerAuthoritativeGameState,
): number | null {
  const phase = state.phase

  if (phase === 'cut-resolve') {
    return CUT_RESOLVE_AUTO_ADVANCE_MS
  }

  if (phase === 'deal-first-3') {
    return DEAL_FIRST_THREE_AUTO_ADVANCE_MS
  }

  if (phase === 'deal-next-2') {
    return DEAL_NEXT_TWO_AUTO_ADVANCE_MS
  }

  if (phase === 'deal-last-3') {
    return DEAL_LAST_THREE_AUTO_ADVANCE_MS
  }

  if (phase === 'next-round') {
    if (state.bidding.hasEnded && state.bidding.winningBid === null) {
      return NEXT_ROUND_AFTER_ALL_PASS_AUTO_ADVANCE_MS
    }

    return NEXT_ROUND_AUTO_ADVANCE_MS
  }

  return null
}
