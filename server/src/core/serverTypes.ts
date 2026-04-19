export type ConnectionId = string
export type RoomId = string
export type PlayerId = string
export type ProfileId = string
export type AccountId = string
export type TimerId = string

export type Seat = 'bottom' | 'right' | 'top' | 'left'
export type Team = 'A' | 'B'

export const SERVER_SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']
export const SERVER_TEAM_A_SEATS: Seat[] = ['bottom', 'top']
export const SERVER_TEAM_B_SEATS: Seat[] = ['right', 'left']

export type ServerSeatMap<T> = Record<Seat, T>

export type ConnectionStatus = 'connected' | 'disconnected'
export type PlayerKind = 'human' | 'bot'
export type RoomStatus = 'waiting' | 'playing' | 'finished'
export type BotDifficulty = 'easy' | 'normal' | 'hard'

export type BotBehaviorPreset =
  | 'balanced'
  | 'aggressive'
  | 'conservative'
  | 'supportive'

export type BotLogicSource = 'existing-core-v1'

export type PlayerIdentitySnapshot = {
  accountId: AccountId | null
  profileId: ProfileId | null
  username: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  skillRating: number | null
}

export type PlayerGalleryImageSnapshot = {
  imageId: string
  imageUrl: string
  sortOrder: number
}

export type PlayerPublicProfileSnapshot = {
  profileId: ProfileId | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  skillRating: number | null
  averageRating: number | null
  totalRatingsCount: number | null
  yellowCoinsBalance: number | null
  galleryImages: PlayerGalleryImageSnapshot[]
}

export type HumanRoomParticipant = {
  kind: 'human'
  playerId: PlayerId
  connectionId: ConnectionId | null
  isConnected: boolean
  joinedAt: number
  lastSeenAt: number
  reconnectToken: string | null
  identity: PlayerIdentitySnapshot
  publicProfile?: PlayerPublicProfileSnapshot | null
}

export type BotRoomParticipant = {
  kind: 'bot'
  playerId: PlayerId
  joinedAt: number
  botCode: string
  difficulty: BotDifficulty
  botProfileId?: ProfileId
  behaviorPreset?: BotBehaviorPreset
  logicSource?: BotLogicSource
  identity: PlayerIdentitySnapshot
  publicProfile?: PlayerPublicProfileSnapshot | null
}

export type RoomParticipant = HumanRoomParticipant | BotRoomParticipant

export type RoomSeatSlot = {
  seat: Seat
  team: Team
  participant: RoomParticipant | null
}

export type ServerRoomConfig = {
  maxPlayers: 4
  allowBots: boolean
  isPrivate: boolean
  joinCode: string | null
  targetScore: number
  turnTimeMs: number
  reconnectGraceMs: number
}

export type ServerRoomGameSnapshot = {
  phase: string | null
  stateVersion: number
  startedAt: number | null
  updatedAt: number | null
  activeTimerId: TimerId | null
  timerDeadlineAt: number | null
  authoritativeState: unknown | null
}

export type ServerRoom = {
  id: RoomId
  status: RoomStatus
  createdAt: number
  updatedAt: number
  hostPlayerId: PlayerId | null
  config: ServerRoomConfig
  seats: ServerSeatMap<RoomSeatSlot>
  game: ServerRoomGameSnapshot
}

export type ServerConnection = {
  id: ConnectionId
  status: ConnectionStatus
  connectedAt: number
  lastSeenAt: number
  remoteAddress: string | null
  userAgent: string | null
  currentRoomId: RoomId | null
  currentSeat: Seat | null
  playerId: PlayerId | null
  profileId: ProfileId | null
}

export type ServerState = {
  startedAt: number
  connections: Record<ConnectionId, ServerConnection>
  rooms: Record<RoomId, ServerRoom>
}