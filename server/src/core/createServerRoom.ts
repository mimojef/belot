import { randomUUID } from 'node:crypto'
import { createEmptyRoomSeatMap } from './createEmptyRoomSeatMap.js'
import type { RoomId, ServerRoom, ServerRoomConfig } from './serverTypes.js'

type CreateServerRoomOptions = {
  roomId?: RoomId
  hostPlayerId?: string | null
  config?: Partial<ServerRoomConfig>
}

type InitialAuthoritativeRoomState = {
  kind: 'bootstrap'
  roomId: RoomId
  createdAt: number
  updatedAt: number
  maxPlayers: number
  allowBots: boolean
  isPrivate: boolean
  targetScore: number
  turnTimeMs: number
  reconnectGraceMs: number
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

function createInitialAuthoritativeRoomState(
  roomId: RoomId,
  now: number,
  config: ServerRoomConfig,
): InitialAuthoritativeRoomState {
  return {
    kind: 'bootstrap',
    roomId,
    createdAt: now,
    updatedAt: now,
    maxPlayers: config.maxPlayers,
    allowBots: config.allowBots,
    isPrivate: config.isPrivate,
    targetScore: config.targetScore,
    turnTimeMs: config.turnTimeMs,
    reconnectGraceMs: config.reconnectGraceMs,
  }
}

export function createServerRoom(options: CreateServerRoomOptions = {}): ServerRoom {
  const now = Date.now()
  const roomId = options.roomId ?? randomUUID()
  const config: ServerRoomConfig = {
    ...createDefaultRoomConfig(),
    ...options.config,
  }

  return {
    id: roomId,
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
    hostPlayerId: options.hostPlayerId ?? null,
    config,
    seats: createEmptyRoomSeatMap(),
    game: {
      phase: 'bootstrap',
      stateVersion: 1,
      startedAt: null,
      updatedAt: now,
      activeTimerId: null,
      timerDeadlineAt: null,
      authoritativeState: createInitialAuthoritativeRoomState(roomId, now, config),
    },
  }
}