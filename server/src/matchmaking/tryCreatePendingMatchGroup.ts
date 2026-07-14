import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../core/serverTypes.js'
import { createMatchedRoomFromEntries } from './createMatchedRoomFromEntries.js'
import type { TempBotFactory } from './selectMatchmakingBotProfiles.js'
import { getReadyEntriesForStake } from './getReadyEntriesForStake.js'
import { markQueueEntriesMatched } from './markQueueEntriesMatched.js'
import type { MatchmakingState } from './matchmakingState.js'
import {
  SUPPORTED_MATCH_STAKES,
  type MatchStake,
  type PendingMatchGroup,
} from './matchmakingTypes.js'
import { removeMatchedEntriesFromQueue } from './removeMatchedEntriesFromQueue.js'
import { resolveMatchmakingSeats, type BlockCheck } from './resolveMatchmakingSeats.js'

export type TryCreatePendingMatchGroupResult = {
  matchmakingState: MatchmakingState
  room: ServerRoom | null
  group: PendingMatchGroup | null
}

function shuffleSeats(seats: Seat[]): Seat[] {
  const nextSeats = [...seats]

  for (let index = nextSeats.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const currentSeat = nextSeats[index]

    nextSeats[index] = nextSeats[swapIndex]
    nextSeats[swapIndex] = currentSeat
  }

  return nextSeats
}

// Throttles the "no valid seating" diagnostic to at most once per stake per
// 60s window, so a persistently unresolvable block combination cannot spam
// the logs on every matchmaking tick. No profileId/displayName is logged.
const BLOCKED_CONFLICT_WARNING_THROTTLE_MS = 60_000
const lastBlockedConflictWarningAtByStake = new Map<MatchStake, number>()

function warnBlockedConflictOnce(stake: MatchStake, now: number, entryCount: number): void {
  const lastWarnedAt = lastBlockedConflictWarningAtByStake.get(stake) ?? 0
  if (now - lastWarnedAt < BLOCKED_CONFLICT_WARNING_THROTTLE_MS) {
    return
  }
  lastBlockedConflictWarningAtByStake.set(stake, now)
  console.warn(
    `[matchmaking] no valid partnership seating found for stake=${stake} entries=${entryCount}`,
  )
}

export function tryCreatePendingMatchGroup(
  matchmakingState: MatchmakingState,
  blockCheck?: BlockCheck,
  createTempBot?: TempBotFactory,
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

    const initialSeatOrder = shuffleSeats(SERVER_SEAT_ORDER)
    const resolvedSeatOrder = blockCheck
      ? resolveMatchmakingSeats(readyResult.entries, initialSeatOrder, blockCheck)
      : initialSeatOrder

    if (resolvedSeatOrder === null) {
      warnBlockedConflictOnce(stake, now, readyResult.entries.length)
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
      resolvedSeatOrder,
      createTempBot,
      readyResult.maxBots,
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
