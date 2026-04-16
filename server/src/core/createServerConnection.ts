import { randomUUID } from 'node:crypto'
import type {
  ConnectionId,
  PlayerId,
  ProfileId,
  Seat,
  ServerConnection,
} from './serverTypes.js'

type CreateServerConnectionOptions = {
  connectionId?: ConnectionId
  remoteAddress?: string | null
  userAgent?: string | null
  currentRoomId?: string | null
  currentSeat?: Seat | null
  playerId?: PlayerId | null
  profileId?: ProfileId | null
}

export function createServerConnection(
  options: CreateServerConnectionOptions = {},
): ServerConnection {
  const now = Date.now()

  return {
    id: options.connectionId ?? randomUUID(),
    status: 'connected',
    connectedAt: now,
    lastSeenAt: now,
    remoteAddress: options.remoteAddress ?? null,
    userAgent: options.userAgent ?? null,
    currentRoomId: options.currentRoomId ?? null,
    currentSeat: options.currentSeat ?? null,
    playerId: options.playerId ?? null,
    profileId: options.profileId ?? null,
  }
}