import type {
  BotRoomParticipant,
  HumanRoomParticipant,
  PlayerId,
  PlayerPublicProfileSnapshot,
  ProfileId,
  RoomId,
  Seat,
} from '../core/serverTypes.js'

export type MatchStake = number

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

export const MATCHMAKING_WAIT_MS = 20000

// Populated at runtime from matchRoomsStore — do not rely on this at import time.
export let SUPPORTED_MATCH_STAKES: MatchStake[] = []

export function setSupportedMatchStakes(stakes: MatchStake[]): void {
  SUPPORTED_MATCH_STAKES = stakes
}
