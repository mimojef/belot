import { randomUUID } from 'node:crypto'
import { createEmptyRoomSeatMap } from './createEmptyRoomSeatMap.js'
import type { RoomId, ServerRoom, ServerRoomConfig } from './serverTypes.js'

type CreateServerRoomOptions = {
  roomId?: RoomId
  hostPlayerId?: string | null
  config?: Partial<ServerRoomConfig>
}

function createDefaultRoomConfig(): ServerRoomConfig {
  return {
    maxPlayers: 4,
    allowBots: true,
    isPrivate: false,
    joinCode: null,
    targetScore: 151,
    turnTimeMs: 20000,
    reconnectGraceMs: 30000,
  }
}

export function createServerRoom(options: CreateServerRoomOptions = {}): ServerRoom {
  const now = Date.now()
  const defaultConfig = createDefaultRoomConfig()

  return {
    id: options.roomId ?? randomUUID(),
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
    hostPlayerId: options.hostPlayerId ?? null,
    config: {
      ...defaultConfig,
      ...options.config,
    },
    seats: createEmptyRoomSeatMap(),
    game: {
      phase: null,
      stateVersion: 0,
      startedAt: null,
      updatedAt: null,
      activeTimerId: null,
      timerDeadlineAt: null,
      authoritativeState: null,
    },
  }
}