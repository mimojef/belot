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

type CreateMatchmakingQueueEntryOptions = {
  connectionId: ConnectionId
  playerId: PlayerId
  profileId?: ProfileId | null
  displayName: string
  publicProfile?: PlayerPublicProfileSnapshot | null
  stake: MatchStake
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

  return {
    entryId: randomUUID(),
    connectionId: options.connectionId,
    playerId: options.playerId,
    profileId: options.profileId ?? null,
    displayName: normalizeDisplayName(options.displayName),
    publicProfile: options.publicProfile ?? null,
    stake: options.stake,
    joinedAt: now,
    expiresAt: now + MATCHMAKING_WAIT_MS,
    status: 'searching',
  }
}
