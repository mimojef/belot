import type {
  ConnectionId,
  HumanRoomParticipant,
  Seat,
  ServerBootstrapAuthoritativeState,
  ServerGamePhase,
  ServerRoom,
} from './serverTypes.js'
import { SERVER_SEAT_ORDER } from './serverTypes.js'
import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'

// Server-side TTL for finished rooms. Prevents rooms staying alive indefinitely
// if a player leaves the endgame tab open with an idle WebSocket connection.
const MATCH_ENDED_ROOM_TTL_MS = 180_000

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

function isFullAuthoritativeGameState(
  value: ServerRoom['game']['authoritativeState'],
): value is ServerAuthoritativeGameState {
  return value !== null && !('kind' in value)
}

function getMatchEndedAt(room: ServerRoom): number | null {
  const state = room.game.authoritativeState
  if (!isFullAuthoritativeGameState(state)) return null
  if (state.phase !== 'match-ended') return null
  // matchEnded.endedAt is set once in startServerScoringPhase — the authoritative
  // timestamp of match completion, not affected by subsequent ticks.
  if (state.matchEnded !== null) return state.matchEnded.endedAt
  // phaseEnteredAt is set by enterServerPhase('match-ended') — reliable fallback.
  return state.phaseEnteredAt
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
  if (
    room.game.phase !== null &&
    room.game.phase !== 'bootstrap' &&
    room.game.phase !== 'finished'
  ) {
    return true
  }

  // Finished rooms: enforce a hard server-side TTL regardless of connected sockets.
  // This prevents rooms from staying alive indefinitely when a player leaves the
  // endgame screen open with an idle WebSocket (the 120s UI timer is frontend-only).
  if (room.status === 'finished' || room.game.phase === 'finished') {
    const matchEndedAt = getMatchEndedAt(room)
    if (matchEndedAt !== null && now - matchEndedAt >= MATCH_ENDED_ROOM_TTL_MS) {
      return false
    }
  }

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
