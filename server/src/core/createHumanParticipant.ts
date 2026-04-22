import { randomUUID } from 'node:crypto'
import type {
  ConnectionId,
  HumanRoomParticipant,
  PlayerId,
  PlayerIdentitySnapshot,
} from './serverTypes.js'

type CreateHumanParticipantOptions = {
  playerId?: PlayerId
  connectionId?: ConnectionId | null
  reconnectToken?: string | null
  identity?: Partial<PlayerIdentitySnapshot>
}

function createDefaultIdentity(): PlayerIdentitySnapshot {
  return {
    accountId: null,
    profileId: null,
    username: null,
    displayName: 'Гост',
    avatarUrl: null,
    level: null,
    rankTitle: null,
    skillRating: null,
  }
}

export function createHumanParticipant(
  options: CreateHumanParticipantOptions = {},
): HumanRoomParticipant {
  const now = Date.now()

  return {
    kind: 'human',
    playerId: options.playerId ?? randomUUID(),
    connectionId: options.connectionId ?? null,
    isConnected: options.connectionId != null,
    joinedAt: now,
    lastSeenAt: now,
    reconnectToken: options.reconnectToken ?? randomUUID(),
    identity: {
      ...createDefaultIdentity(),
      ...options.identity,
    },
  }
}