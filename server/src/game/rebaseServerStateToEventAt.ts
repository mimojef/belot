import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function rebaseServerStateToEventAt(
  state: ServerAuthoritativeGameState,
  eventAt: number,
): ServerAuthoritativeGameState {
  const durationMs = state.timer.durationMs
  const hasTimerDuration =
    typeof durationMs === 'number' && Number.isFinite(durationMs)

  return {
    ...state,
    phaseEnteredAt: eventAt,
    timer: hasTimerDuration
      ? {
          ...state.timer,
          startedAt: eventAt,
          expiresAt: eventAt + durationMs,
        }
      : state.timer,
  }
}