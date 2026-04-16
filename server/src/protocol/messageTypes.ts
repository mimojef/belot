import type {
  PlayerIdentitySnapshot,
  RoomId,
  RoomStatus,
  Seat,
} from '../core/serverTypes.js'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'

export type ClientMessage =
  | {
      type: 'ping'
    }
  | {
      type: 'create_room'
      displayName?: string
    }
  | {
      type: 'join_room'
      roomId: RoomId
      displayName?: string
    }
  | {
      type: 'join_matchmaking'
      displayName?: string
      stake: MatchStake
    }
  | {
      type: 'leave_matchmaking'
    }

export type RoomSeatSnapshot = {
  seat: Seat
  displayName: string
  isOccupied: boolean
  isBot: boolean
  isConnected: boolean
}

export type RoomSnapshotMessage = {
  type: 'room_snapshot'
  roomId: RoomId
  roomStatus: RoomStatus
  yourSeat: Seat | null
  seats: RoomSeatSnapshot[]
}

export type ConnectedMessage = {
  type: 'connected'
  clientId: string
  message: string
}

export type PongMessage = {
  type: 'pong'
  timestamp: number
}

export type ErrorMessage = {
  type: 'error'
  message: string
}

export type RoomCreatedMessage = {
  type: 'room_created'
  roomId: RoomId
  seat: Seat
  hostDisplayName: string
}

export type RoomJoinedMessage = {
  type: 'room_joined'
  roomId: RoomId
  seat: Seat
  displayName: string
}

export type MatchmakingJoinedMessage = {
  type: 'matchmaking_joined'
  stake: MatchStake
  queuedPlayers: number
  requiredPlayers: number
  countdownEndsAt: number
  remainingMs: number
}

export type MatchmakingStatusMessage = {
  type: 'matchmaking_status'
  stake: MatchStake
  queuedPlayers: number
  requiredPlayers: number
  countdownEndsAt: number
  remainingMs: number
}

export type MatchmakingLeftMessage = {
  type: 'matchmaking_left'
  removed: boolean
}

export type MatchFoundMessage = {
  type: 'match_found'
  roomId: RoomId
  seat: Seat
  stake: MatchStake
  humanPlayers: number
  botPlayers: number
  shouldStartImmediately: boolean
}

export type ServerMessage =
  | ConnectedMessage
  | PongMessage
  | ErrorMessage
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomSnapshotMessage
  | MatchmakingJoinedMessage
  | MatchmakingStatusMessage
  | MatchmakingLeftMessage
  | MatchFoundMessage

export function getDisplayNameFromIdentity(
  identity: PlayerIdentitySnapshot | null | undefined,
): string {
  if (!identity) {
    return 'Играч'
  }

  return identity.displayName?.trim() || 'Играч'
}