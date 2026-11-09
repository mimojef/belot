import { getSearchingEntriesByStake } from './getSearchingEntriesByStake.js'
import type { MatchStake, MatchmakingQueueEntry } from './matchmakingTypes.js'

export type SharedTableTimer = {
  expiresAt: number
  waitDurationMs: number
}

// Общият таймер на случайната маса за даден залог = expiresAt/waitDurationMs
// на най-стария чакащ. Новите играчи го наследяват (createMatchmakingQueueEntry),
// затова всички чакащи имат един и същ краен момент и продължителност —
// напускането на когото и да е или промяна на админ настройката не го местят.
// Празна опашка → null (следващият започва нов таймер по текущата настройка).
export function getSharedTableTimer(
  entries: MatchmakingQueueEntry[],
  stake: MatchStake,
): SharedTableTimer | null {
  let oldest: MatchmakingQueueEntry | null = null

  for (const entry of getSearchingEntriesByStake(entries, stake)) {
    if (oldest === null || entry.joinedAt < oldest.joinedAt) {
      oldest = entry
    }
  }

  return oldest === null
    ? null
    : { expiresAt: oldest.expiresAt, waitDurationMs: oldest.waitDurationMs }
}
