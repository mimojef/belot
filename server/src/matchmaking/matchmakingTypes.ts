import type {
  BotRoomParticipant,
  HumanRoomParticipant,
  PlayerId,
  PlayerPublicProfileSnapshot,
  ProfileId,
  RoomId,
  Seat,
} from '../core/serverTypes.js'

export type MatchStake = 5000 | 8000 | 10000 | 15000 | 20000

export type MatchmakingStatus =
  | 'searching'
  | 'matched'
  | 'expired'
  | 'cancelled'
  | 'completed'

export type MatchSeatAssignment = {
  seat: Seat
  playerId: PlayerId
  isBot: boolean
}

export type MatchmakingQueueEntry = {
  entryId: string
  connectionId: string
  playerId: PlayerId
  profileId: ProfileId | null
  displayName: string
  publicProfile: PlayerPublicProfileSnapshot | null
  stake: MatchStake
  stakePaid: boolean
  joinedAt: number
  expiresAt: number
  status: MatchmakingStatus
}

export type PendingMatchedHuman = {
  kind: 'human'
  participant: HumanRoomParticipant
}

export type PendingMatchedBot = {
  kind: 'bot'
  participant: BotRoomParticipant
}

export type PendingMatchedParticipant = PendingMatchedHuman | PendingMatchedBot

export type PendingMatchGroup = {
  groupId: string
  roomId: RoomId | null
  stake: MatchStake
  createdAt: number
  shouldStartImmediately: boolean
  matchedHumans: MatchmakingQueueEntry[]
  addedBots: BotRoomParticipant[]
  seatAssignments: MatchSeatAssignment[]
}

export const MATCHMAKING_WAIT_MS = 15000

export const SUPPORTED_MATCH_STAKES: MatchStake[] = [
  5000,
  8000,
  10000,
  15000,
  20000,
]
