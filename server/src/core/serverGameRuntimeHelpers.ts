import type {
  ConnectionId,
  HumanRoomParticipant,
  Seat,
  ServerBootstrapAuthoritativeState,
  ServerGamePhase,
  ServerRoom,
} from './serverTypes.js'
import { SERVER_SEAT_ORDER } from './serverTypes.js'

export type ServerGameRuntime = {
  roomId: string
  phase: ServerGamePhase
  createdAt: number
  updatedAt: number
  tickCount: number
}

function isBootstrapAuthoritativeState(
  value: ServerRoom['game']['authoritativeState'],
): value is ServerBootstrapAuthoritativeState {
  return value !== null && 'kind' in value && value.kind === 'bootstrap'
}

export function createServerGameRuntime(
  room: ServerRoom,
  now: number = Date.now(),
): ServerGameRuntime {
  return {
    roomId: room.id,
    phase: room.game.phase ?? 'bootstrap',
    createdAt: now,
    updatedAt: now,
    tickCount: 0,
  }
}

export function roomHasConnectedHumanParticipants(room: ServerRoom): boolean {
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (
      participant !== null &&
      participant.kind === 'human' &&
      participant.isConnected
    ) {
      return true
    }
  }

  return false
}

export function getRoomReconnectDeadline(room: ServerRoom): number | null {
  let latestHumanLastSeenAt: number | null = null

  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (participant === null || participant.kind !== 'human') {
      continue
    }

    latestHumanLastSeenAt =
      latestHumanLastSeenAt === null
        ? participant.lastSeenAt
        : Math.max(latestHumanLastSeenAt, participant.lastSeenAt)
  }

  if (latestHumanLastSeenAt === null) {
    return null
  }

  return latestHumanLastSeenAt + room.config.reconnectGraceMs
}

export function shouldKeepRoomAlive(
  room: ServerRoom,
  now: number = Date.now(),
): boolean {
  if (roomHasConnectedHumanParticipants(room)) {
    return true
  }

  const reconnectDeadline = getRoomReconnectDeadline(room)

  if (reconnectDeadline === null) {
    return false
  }

  return now < reconnectDeadline
}

export function createBootstrapAuthoritativeState(
  room: ServerRoom,
  updatedAt: number,
): NonNullable<ServerRoom['game']['authoritativeState']> {
  const currentState = room.game.authoritativeState

  if (isBootstrapAuthoritativeState(currentState)) {
    return {
      ...currentState,
      updatedAt,
    }
  }

  return {
    kind: 'bootstrap',
    roomId: room.id,
    createdAt: room.createdAt,
    updatedAt,
    maxPlayers: room.config.maxPlayers,
    allowBots: room.config.allowBots,
    isPrivate: room.config.isPrivate,
    targetScore: room.config.targetScore,
    turnTimeMs: room.config.turnTimeMs,
    reconnectGraceMs: room.config.reconnectGraceMs,
  }
}

export function syncRoomGameSnapshotFromRuntime(
  room: ServerRoom,
  runtime: ServerGameRuntime,
): ServerRoom {
  return {
    ...room,
    game: {
      ...room.game,
      phase: runtime.phase,
      startedAt: room.game.startedAt ?? runtime.createdAt,
      updatedAt: runtime.updatedAt,
      authoritativeState:
        runtime.phase === 'bootstrap'
          ? createBootstrapAuthoritativeState(room, runtime.updatedAt)
          : room.game.authoritativeState,
    },
  }
}

export function findHumanParticipantByReconnectToken(
  room: ServerRoom,
  reconnectToken: string,
): { seat: Seat; participant: HumanRoomParticipant } | null {
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (
      participant !== null &&
      participant.kind === 'human' &&
      participant.reconnectToken === reconnectToken
    ) {
      return {
        seat,
        participant,
      }
    }
  }

  return null
}

export function createReconnectedHumanParticipant(
  participant: HumanRoomParticipant,
  connectionId: ConnectionId,
): HumanRoomParticipant {
  return {
    ...participant,
    connectionId,
    isConnected: true,
    lastSeenAt: Date.now(),
  }
}