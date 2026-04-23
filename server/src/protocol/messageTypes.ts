import type {
  PlayerIdentitySnapshot,
  PlayerPublicProfileSnapshot,
  RoomId,
  RoomStatus,
  Seat,
} from '../core/serverTypes.js'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'

export type ClientBidAction =
  | {
      type: 'pass'
    }
  | {
      type: 'suit'
      suit: 'clubs' | 'diamonds' | 'hearts' | 'spades'
    }
  | {
      type: 'no-trumps'
    }
  | {
      type: 'all-trumps'
    }
  | {
      type: 'double'
    }
  | {
      type: 'redouble'
    }

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
  | {
      type: 'request_player_profile'
      roomId: RoomId
      seat: Seat
    }
  | {
      type: 'resume_room'
      roomId: RoomId
      reconnectToken: string
    }
  | {
      type: 'leave_active_room'
      roomId: RoomId
    }
  | {
      type: 'submit_bid_action'
      roomId: RoomId
      action: ClientBidAction
    }
  | {
      type: 'submit_cut_index'
      roomId: RoomId
      cutIndex: number
    }

export type RoomSeatSnapshot = {
  seat: Seat
  displayName: string
  isOccupied: boolean
  isBot: boolean
  isConnected: boolean
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  skillRating: number | null
}

export type RoomGamePhaseSnapshot =
  | 'bootstrap'
  | 'cutting'
  | 'bidding'
  | 'playing'
  | 'scoring'
  | 'finished'

export type RoomAuthoritativePhaseSnapshot =
  | 'new-game'
  | 'choose-first-dealer'
  | 'cutting'
  | 'cut-resolve'
  | 'deal-first-3'
  | 'deal-next-2'
  | 'bidding'
  | 'deal-last-3'
  | 'playing'
  | 'scoring'
  | 'next-round'
  | 'match-ended'

export type RoomCuttingSnapshot = {
  cutterSeat: Seat | null
  selectedCutIndex: number | null
  deckCount: number
  canSubmitCut: boolean
}

export type RoomGameSnapshot = {
  phase: RoomGamePhaseSnapshot | null
  authoritativePhase: RoomAuthoritativePhaseSnapshot | null
  timerDeadlineAt: number | null
  dealerSeat: Seat | null
  cutting: RoomCuttingSnapshot | null
}

export type RoomSnapshotMessage = {
  type: 'room_snapshot'
  roomId: RoomId
  roomStatus: RoomStatus
  yourSeat: Seat | null
  reconnectToken: string | null
  seats: RoomSeatSnapshot[]
  game?: RoomGameSnapshot | null
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

export type PlayerProfileMessage = {
  type: 'player_profile'
  roomId: RoomId
  seat: Seat
  profile: PlayerPublicProfileSnapshot | null
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

export type RoomResumedMessage = {
  type: 'room_resumed'
  roomId: RoomId
  seat: Seat
}

export type RoomResumeFailedMessage = {
  type: 'room_resume_failed'
  roomId: RoomId
  message: string
}

export type ActiveRoomLeftMessage = {
  type: 'left_active_room'
  roomId: RoomId
  removed: boolean
}

export type MatchmakingJoinedMessage = {
  type: 'matchmaking_joined'
  stake: MatchStake
  queuedPlayers: number
  requiredPlayers: number
  countdownEndsAt: number
  remainingMs: number
  previewBotDisplayNames?: string[]
}

export type MatchmakingStatusMessage = {
  type: 'matchmaking_status'
  stake: MatchStake
  queuedPlayers: number
  requiredPlayers: number
  countdownEndsAt: number
  remainingMs: number
  previewBotDisplayNames?: string[]
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
  | PlayerProfileMessage
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomResumedMessage
  | RoomResumeFailedMessage
  | ActiveRoomLeftMessage
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
