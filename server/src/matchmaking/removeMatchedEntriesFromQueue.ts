import type { MatchmakingQueueEntry } from './matchmakingTypes.js'

export function removeMatchedEntriesFromQueue(
  entries: MatchmakingQueueEntry[],
  matchedEntryIds: string[],
): MatchmakingQueueEntry[] {
  if (matchedEntryIds.length === 0) {
    return entries
  }

  const matchedEntryIdSet = new Set(matchedEntryIds)

  return entries.filter((entry) => !matchedEntryIdSet.has(entry.entryId))
}
