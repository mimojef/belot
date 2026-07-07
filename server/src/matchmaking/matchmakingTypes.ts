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

// Duration of the bot-fill window before oldest entry expires.
// With MATCHMAKING_WAIT_MS=20000 this opens the bot-fill window at t=17s.
export const MATCHMAKING_BOT_FILL_WINDOW_MS = 3000

// How many bots are allowed per elapsed second inside the bot-fill window.
// One bot is unlocked per second: t=17s→1 bot, t=18s→2 bots, t=19s→3 bots.
// A room is only created when humans + allowedBots === 4 (full table).
export const MATCHMAKING_BOT_FILL_RATE_MS = 1000

// Populated at runtime from matchRoomsStore — do not rely on this at import time.
export let SUPPORTED_MATCH_STAKES: MatchStake[] = []

export function setSupportedMatchStakes(stakes: MatchStake[]): void {
  SUPPORTED_MATCH_STAKES = stakes
}
