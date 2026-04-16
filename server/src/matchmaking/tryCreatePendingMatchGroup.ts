import type { ServerRoom } from '../core/serverTypes.js'
import { createMatchedRoomFromEntries } from './createMatchedRoomFromEntries.js'
import { getReadyEntriesForStake } from './getReadyEntriesForStake.js'
import { markQueueEntriesMatched } from './markQueueEntriesMatched.js'
import type { MatchmakingState } from './matchmakingState.js'
import {
  SUPPORTED_MATCH_STAKES,
  type PendingMatchGroup,
} from './matchmakingTypes.js'
import { removeMatchedEntriesFromQueue } from './removeMatchedEntriesFromQueue.js'

export type TryCreatePendingMatchGroupResult = {
  matchmakingState: MatchmakingState
  room: ServerRoom | null
  group: PendingMatchGroup | null
}

export function tryCreatePendingMatchGroup(
  matchmakingState: MatchmakingState,
  now: number = Date.now(),
): TryCreatePendingMatchGroupResult {
  for (const stake of SUPPORTED_MATCH_STAKES) {
    const readyResult = getReadyEntriesForStake(
      matchmakingState.queueEntries,
      stake,
      now,
    )

    if (readyResult.entries.length === 0) {
      continue
    }

    const matchedEntryIds = readyResult.entries.map((entry) => entry.entryId)
    const matchedEntries = markQueueEntriesMatched(
      matchmakingState.queueEntries,
      matchedEntryIds,
    )

    const queueEntries = removeMatchedEntriesFromQueue(
      matchedEntries,
      matchedEntryIds,
    )

    const { room, group } = createMatchedRoomFromEntries(
      readyResult.entries,
      readyResult.shouldStartImmediately,
    )

    return {
      matchmakingState: {
        ...matchmakingState,
        queueEntries,
        pendingGroups: [...matchmakingState.pendingGroups, group],
        lastProcessedAt: now,
      },
      room,
      group,
    }
  }

  return {
    matchmakingState: {
      ...matchmakingState,
      lastProcessedAt: now,
    },
    room: null,
    group: null,
  }
}
