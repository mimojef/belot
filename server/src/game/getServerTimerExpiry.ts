import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

export function getServerTimerExpiry(
  state: ServerAuthoritativeGameState,
): number | null {
  const expiresAt = state.timer.expiresAt

  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return null
  }

  return expiresAt
}