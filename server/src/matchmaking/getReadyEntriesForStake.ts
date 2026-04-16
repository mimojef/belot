import { getSearchingEntriesByStake } from './getSearchingEntriesByStake.js'
import { isQueueEntryExpired } from './isQueueEntryExpired.js'
import type {
  MatchStake,
  MatchmakingQueueEntry,
} from './matchmakingTypes.js'

export type ReadyEntriesForStakeResult = {
  entries: MatchmakingQueueEntry[]
  shouldStartImmediately: boolean
}

export function getReadyEntriesForStake(
  allEntries: MatchmakingQueueEntry[],
  stake: MatchStake,
  now: number = Date.now(),
): ReadyEntriesForStakeResult {
  const searchingEntries = getSearchingEntriesByStake(allEntries, stake).sort(
    (a, b) => a.joinedAt - b.joinedAt,
  )

  if (searchingEntries.length === 0) {
    return {
      entries: [],
      shouldStartImmediately: false,
    }
  }

  if (searchingEntries.length >= 4) {
    return {
      entries: searchingEntries.slice(0, 4),
      shouldStartImmediately: true,
    }
  }

  const oldestEntry = searchingEntries[0]

  if (!oldestEntry || !isQueueEntryExpired(oldestEntry, now)) {
    return {
      entries: [],
      shouldStartImmediately: false,
    }
  }

  return {
    entries: searchingEntries,
    shouldStartImmediately: false,
  }
}