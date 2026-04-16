import type { MatchmakingQueueEntry } from './matchmakingTypes.js'

export function markQueueEntriesMatched(
  allEntries: MatchmakingQueueEntry[],
  matchedEntryIds: string[],
): MatchmakingQueueEntry[] {
  if (matchedEntryIds.length === 0) {
    return allEntries
  }

  const matchedIdSet = new Set(matchedEntryIds)

  return allEntries.map((entry) => {
    if (!matchedIdSet.has(entry.entryId)) {
      return entry
    }

    return {
      ...entry,
      status: 'matched',
    }
  })
}