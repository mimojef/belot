import { getServerTimerNow } from './serverTimerStateHelpers.js'

export function resolveServerNow(now?: number): number {
  if (typeof now === 'number' && Number.isFinite(now)) {
    return now
  }

  return getServerTimerNow()
}