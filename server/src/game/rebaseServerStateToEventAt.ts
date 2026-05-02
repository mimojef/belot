import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function rebaseServerStateToEventAt(
  state: ServerAuthoritativeGameState,
  eventAt: number,
): ServerAuthoritativeGameState {
  const durationMs = state.timer.durationMs
  const startedAt = state.timer.startedAt
  const hasTimerDuration =
    typeof durationMs === 'number' && Number.isFinite(durationMs)
  const rebasedTimerStartedAt =
    typeof startedAt === 'number' &&
    Number.isFinite(startedAt) &&
    startedAt > eventAt
      ? startedAt
      : eventAt

  return {
    ...state,
    phaseEnteredAt: eventAt,
    timer: hasTimerDuration
      ? {
          ...state.timer,
          startedAt: rebasedTimerStartedAt,
          expiresAt: rebasedTimerStartedAt + durationMs,
        }
      : state.timer,
  }
}
