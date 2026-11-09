import { randomUUID } from 'node:crypto'
import type {
  ConnectionId,
  PlayerId,
  PlayerPublicProfileSnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import {
  MATCHMAKING_WAIT_MS,
  type MatchStake,
  type MatchmakingQueueEntry,
} from './matchmakingTypes.js'
import type { SharedTableTimer } from './getSharedTableTimer.js'

type CreateMatchmakingQueueEntryOptions = {
  connectionId: ConnectionId
  playerId: PlayerId
  profileId?: ProfileId | null
  displayName: string
  publicProfile?: PlayerPublicProfileSnapshot | null
  stake: MatchStake
  waitMs?: number
  // Общият таймер на вече чакащата маса (виж getSharedTableTimer). Ако
  // крайният му момент е в бъдещето, новият запис наследява и него, и
  // продължителността му вместо собствени waitMs.
  tableTimer?: SharedTableTimer | null
}

function normalizeDisplayName(value: string): string {
  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return 'Гост'
  }

  return trimmed
}

export function createMatchmakingQueueEntry(
  options: CreateMatchmakingQueueEntryOptions,
): MatchmakingQueueEntry {
  const now = Date.now()
  const waitMs = options.waitMs ?? MATCHMAKING_WAIT_MS
  const tableTimer = options.tableTimer && options.tableTimer.expiresAt > now
    ? options.tableTimer
    : { expiresAt: now + waitMs, waitDurationMs: waitMs }

  return {
    entryId: randomUUID(),
    connectionId: options.connectionId,
    playerId: options.playerId,
    profileId: options.profileId ?? null,
    displayName: normalizeDisplayName(options.displayName),
    publicProfile: options.publicProfile ?? null,
    stake: options.stake,
    stakePaid: false,
    joinedAt: now,
    expiresAt: tableTimer.expiresAt,
    waitDurationMs: tableTimer.waitDurationMs,
    status: 'searching',
  }
}
