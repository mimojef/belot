import type { MatchmakingQueueEntry } from './matchmakingTypes.js'

export function isQueueEntryExpired(entry: MatchmakingQueueEntry, now: number = Date.now()): boolean {
  return now >= entry.expiresAt
}