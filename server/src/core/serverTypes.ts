import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'
import type {
  TournamentId,
  TournamentMatchId,
  TournamentRoundType,
  TournamentTeamId,
} from '../tournament/tournamentTypes.js'

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

export type ServerGamePhase =
  | 'bootstrap'
  | 'cutting'
  | 'bidding'
  | 'playing'
  | 'scoring'
  | 'finished'

export type PlayerGender = 'male' | 'female'

export type PlayerIdentitySnapshot = {
  accountId: AccountId | null
  profileId: ProfileId | null
  username: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  skillRating: number | null
  gender: PlayerGender | null
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
  completedGamesCount: number | null
  wonGamesCount: number | null
  currentRankGames: number | null
  nextRankGames: number | null
  gamesUntilNextRank: number | null
  rankProgressRatio: number | null
  averageRating: number | null
  totalRatingsCount: number | null
  yellowCoinsBalance: number | null
  galleryImages: PlayerGalleryImageSnapshot[]
  gender: PlayerGender | null
  isOnline?: boolean
  isBot?: boolean
  likesCount: number | null
  hasLikedByMe: boolean | null
  isBlockedByMe: boolean | null
  isVip: boolean | null
  vipActiveUntil: string | null
}

export type HumanRoomParticipant = {
  kind: 'human'
  playerId: PlayerId
  connectionId: ConnectionId | null
  isConnected: boolean
  joinedAt: number
  lastSeenAt: number
  reconnectToken: string | null
  /**
   * Non-null само когато играчът окончателно и доброволно е напуснал масата
   * (потвърдил е санкцията при "Излез") — за разлика от временен disconnect
   * (reconnectToken се пази) или bot takeover при изтекъл timer
   * (controlledByBot в authoritative game state, participant.kind остава
   * 'human' до края на мача за history/attribution). Единствен писател:
   * leave_active_room handler-ът в index.ts. Четец: isProfileInActiveGame —
   * позволява на напусналия профил да ползва чат, докато ботът довършва
   * мача вместо него, без да пипа kind/mode/controlledByBot.
   */
  permanentlyLeftAt: number | null
  identity: PlayerIdentitySnapshot
  publicProfile?: PlayerPublicProfileSnapshot | null
  isGuestTrial?: boolean
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
  tournamentNoShowReplacement?: {
    tournamentId: TournamentId
    matchId: TournamentMatchId
    assignedProfileId: ProfileId
    assignedSeat: Seat
    replacementReason: 'no_show'
    insertedAt: string
    status: 'active' | 'takeover_pending' | 'completed'
  }
  identity: PlayerIdentitySnapshot
  publicProfile?: PlayerPublicProfileSnapshot | null
}

export type RoomParticipant = HumanRoomParticipant | BotRoomParticipant

export type TournamentAttendancePlayerSummary = {
  seat: Seat
  team: Team
  displayName: string
  avatarUrl: string | null
}

// Presence на точно този играч в момента на snapshot-а (§"КАКВО СЕ ВИЖДА НА
// 3-MINUTE SCREEN" в task spec-а) — project-wide online семантика (виж
// isProfileOnline dep в tournamentCoordinator.ts), не room-scoped
// attachment. isOnline е computed at snapshot-time, не persisted.
export type TournamentAttendanceRosterEntry = TournamentAttendancePlayerSummary & {
  isOnline: boolean
}

export type TournamentAttendanceSnapshot = {
  state: 'waiting' | 'resolved' | 'countdown' | 'started' | 'completed'
  serverNow: string
  deadlineAt: string | null
  secondsRemaining: number
  missingPlayers: TournamentAttendancePlayerSummary[]
  missingByTeam: Record<Team, TournamentAttendancePlayerSummary[]>
  // Пълен 4-играчен roster с per-seat presence — нужен на новия dedicated
  // 3-минутен waiting екран (§"КАКВО СЕ ВИЖДА НА 3-MINUTE SCREEN"), за
  // разлика от missingPlayers/missingByTeam (само липсващите). Подредена
  // по seat assignment, не по presence.
  roster: TournamentAttendanceRosterEntry[]
  resolutionKind: 'all_present' | 'walkover' | 'bots_inserted' | null
  gameStartAt: string | null
  startSecondsRemaining: number
  walkover: {
    winnerTeamId: TournamentTeamId
    loserTeamId: TournamentTeamId
    reason: string
    completedAt: string
  } | null
}

export type TournamentBotReplacementSnapshot = {
  seat: Seat
  replacedPlayer: TournamentAttendancePlayerSummary
  takeoverAvailableForMe: boolean
  takeoverPending: boolean
  takeoverCompleted: boolean
  replacementActive: boolean
}

export type TournamentRoomBannerSnapshot = {
  id: string
  kind: 'bots_inserted' | 'takeover_pending' | 'takeover_completed'
  message: string
  createdAt: string
  expiresAt: string
}

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
  stakeAmount?: number | null
  targetScore: number
  turnTimeMs: number
  reconnectGraceMs: number
  isGuestTrial?: boolean
  /**
   * True само за игри, стартирали от частна маса (нормален 4-human старт
   * или "Запълни с ботове"). За разлика от `isPrivate` (който важи и за
   * guest trial стаите), това поле управлява само end-game UI
   * ("Нова игра" бутонът се крие) — виж createRoomSnapshotMessage.ts.
   */
  isPrivateTableOrigin?: boolean
  isTournamentMatchOrigin?: boolean
  tournamentId?: TournamentId
  tournamentMatchId?: TournamentMatchId
  tournamentRoundType?: TournamentRoundType
  tournamentAttendance?: TournamentAttendanceSnapshot | null
  tournamentBotReplacements?: TournamentBotReplacementSnapshot[]
  tournamentBanners?: TournamentRoomBannerSnapshot[]
}

export type ServerBootstrapAuthoritativeState = {
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

export type ServerRoomAuthoritativeState =
  | ServerBootstrapAuthoritativeState
  | ServerAuthoritativeGameState
  | null

export type ServerRoomGameSnapshot = {
  phase: ServerGamePhase | null
  stateVersion: number
  startedAt: number | null
  updatedAt: number | null
  activeTimerId: TimerId | null
  timerDeadlineAt: number | null
  authoritativeState: ServerRoomAuthoritativeState
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
  replayVotes: Seat[]
  leaveVotes: Seat[]
  awardedPrizePerSeat?: Partial<Record<Seat, number>>
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
