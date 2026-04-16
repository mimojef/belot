import type { MatchmakingQueueEntry } from './matchmakingTypes.js'

export function addQueueEntry(
  entries: MatchmakingQueueEntry[],
  nextEntry: MatchmakingQueueEntry,
): MatchmakingQueueEntry[] {
  const filteredEntries = entries.filter(
    (entry) => entry.connectionId !== nextEntry.connectionId,
  )

  return [...filteredEntries, nextEntry].sort((a, b) => a.joinedAt - b.joinedAt)
}
