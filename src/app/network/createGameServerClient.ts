export type Seat = 'bottom' | 'right' | 'top' | 'left'
export type RoomStatus = 'waiting' | 'playing' | 'finished'
export type MatchStake = 5000 | 8000 | 10000 | 15000 | 20000

export type ClientBidAction =
  | { type: 'pass' }
  | { type: 'suit'; suit: 'clubs' | 'diamonds' | 'hearts' | 'spades' }
  | { type: 'no-trumps' }
  | { type: 'all-trumps' }
  | { type: 'double' }
  | { type: 'redouble' }

export type PlayerGalleryImageSnapshot = {
  imageId: string
  imageUrl: string
  sortOrder: number
}

export type PlayerPublicProfileSnapshot = {
  profileId: string | null
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
      roomId: string
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
      roomId: string
      seat: Seat
    }
  | {
      type: 'resume_room'
      roomId: string
      reconnectToken: string
    }
  | {
      type: 'leave_active_room'
      roomId: string
    }
  | {
      type: 'submit_bid_action'
      roomId: string
      action: ClientBidAction
    }
  | {
      type: 'submit_cut_index'
      roomId: string
      cutIndex: number
    }
  | {
      type: 'submit_play_card'
      roomId: string
      cardId: string
    }
  | {
      type: 'resume_human_control'
      roomId: string
    }

export type RoomSeatSnapshot = {
  seat: Seat
  displayName: string
  isOccupied: boolean
  isBot: boolean
  isControlledByBot: boolean
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

export type RoomBidActionSnapshot =
  | { type: 'pass' }
  | { type: 'suit'; suit: 'clubs' | 'diamonds' | 'hearts' | 'spades' }
  | { type: 'no-trumps' }
  | { type: 'all-trumps' }
  | { type: 'double' }
  | { type: 'redouble' }

export type RoomBidEntrySnapshot = {
  seat: Seat
  action: RoomBidActionSnapshot
}

export type RoomWinningBidSnapshot = {
  seat: Seat
  contract: 'suit' | 'no-trumps' | 'all-trumps'
  trumpSuit: 'clubs' | 'diamonds' | 'hearts' | 'spades' | null
  doubled: boolean
  redoubled: boolean
} | null

export type RoomValidBidActionsSnapshot = {
  pass: boolean
  suits: { clubs: boolean; diamonds: boolean; hearts: boolean; spades: boolean }
  noTrumps: boolean
  allTrumps: boolean
  double: boolean
  redouble: boolean
}

export type RoomBiddingSnapshot = {
  currentBidderSeat: Seat | null
  canSubmitBid: boolean
  entries: RoomBidEntrySnapshot[]
  winningBid: RoomWinningBidSnapshot
  validActions: RoomValidBidActionsSnapshot | null
}

export type RoomCardSnapshot = {
  id: string
  suit: 'clubs' | 'diamonds' | 'hearts' | 'spades'
  rank: '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
}

export type RoomPlayCardSnapshot = {
  seat: Seat
  card: RoomCardSnapshot
}

export type RoomCompletedTrickSnapshot = {
  trickIndex: number
  leaderSeat: Seat
  plays: RoomPlayCardSnapshot[]
  winnerSeat: Seat
}

export type RoomPlayingSnapshot = {
  currentTurnSeat: Seat | null
  currentTrickPlays: RoomPlayCardSnapshot[]
  completedTricksCount: number
  latestCompletedTrick: RoomCompletedTrickSnapshot | null
  validCardIds: string[] | null
}

export type RoomScoreSnapshot = {
  match: {
    teamA: number
    teamB: number
  }
}

export type RoomGameSnapshot = {
  phase: RoomGamePhaseSnapshot | null
  authoritativePhase: RoomAuthoritativePhaseSnapshot | null
  timerDeadlineAt: number | null
  dealerSeat: Seat | null
  firstDealSeat: Seat | null
  cutting: RoomCuttingSnapshot | null
  bidding: RoomBiddingSnapshot | null
  playing: RoomPlayingSnapshot | null
  score: RoomScoreSnapshot
  handCounts: Record<Seat, number>
  ownHand: RoomCardSnapshot[]
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
  roomId: string
  seat: Seat
  hostDisplayName: string
}

export type RoomJoinedMessage = {
  type: 'room_joined'
  roomId: string
  seat: Seat
  displayName: string
}

export type RoomResumedMessage = {
  type: 'room_resumed'
  roomId: string
  seat: Seat
}

export type RoomResumeFailedMessage = {
  type: 'room_resume_failed'
  roomId: string
  message: string
}

export type ActiveRoomLeftMessage = {
  type: 'left_active_room'
  roomId: string
  removed: boolean
}

export type RoomSnapshotMessage = {
  type: 'room_snapshot'
  roomId: string
  roomStatus: RoomStatus
  yourSeat: Seat | null
  reconnectToken: string | null
  seats: RoomSeatSnapshot[]
  game?: RoomGameSnapshot | null
}

export type PlayerProfileMessage = {
  type: 'player_profile'
  roomId: string
  seat: Seat
  profile: PlayerPublicProfileSnapshot | null
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
  roomId: string
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
  | RoomResumedMessage
  | RoomResumeFailedMessage
  | ActiveRoomLeftMessage
  | RoomSnapshotMessage
  | PlayerProfileMessage
  | MatchmakingJoinedMessage
  | MatchmakingStatusMessage
  | MatchmakingLeftMessage
  | MatchFoundMessage

type CreateGameServerClientOptions = {
  url?: string
  onOpen?: () => void
  onClose?: () => void
  onError?: (event: Event) => void
  onMessage?: (message: ServerMessage) => void
}

export type GameServerClient = {
  connect: () => void
  disconnect: () => void
  isConnected: () => boolean
  ping: () => void
  createRoom: (displayName?: string) => void
  joinRoom: (roomId: string, displayName?: string) => void
  joinMatchmaking: (stake: MatchStake, displayName?: string) => void
  leaveMatchmaking: () => void
  requestPlayerProfile: (roomId: string, seat: Seat) => void
  resumeRoom: (roomId: string, reconnectToken: string) => void
  leaveActiveRoom: (roomId: string) => void
  submitBidAction: (roomId: string, action: ClientBidAction) => void
  submitCutIndex: (roomId: string, cutIndex: number) => void
  submitPlayCard: (roomId: string, cardId: string) => void
  resumeHumanControl: (roomId: string) => void
}

function getDefaultServerUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.hostname || 'localhost'

  return `${protocol}//${host}:3001/ws`
}

function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === 'object' && value !== null && 'type' in value
}

function safeParseServerMessage(rawText: string): ServerMessage | null {
  try {
    const parsed = JSON.parse(rawText) as unknown

    if (!isServerMessage(parsed)) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export function createGameServerClient(
  options: CreateGameServerClientOptions = {},
): GameServerClient {
  const url = options.url ?? getDefaultServerUrl()
  let socket: WebSocket | null = null

  function send(message: ClientMessage): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('[game-server] socket is not open')
      return
    }

    socket.send(JSON.stringify(message))
  }

  function connect(): void {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      options.onOpen?.()
    })

    socket.addEventListener('close', () => {
      socket = null
      options.onClose?.()
    })

    socket.addEventListener('error', (event) => {
      options.onError?.(event)
    })

    socket.addEventListener('message', (event) => {
      const message = safeParseServerMessage(String(event.data))

      if (!message) {
        console.warn('[game-server] invalid server message:', event.data)
        return
      }

      console.log('[game-server] message', message.type, message)
      options.onMessage?.(message)
    })
  }

  function disconnect(): void {
    if (!socket) {
      return
    }

    socket.close()
    socket = null
  }

  function isConnected(): boolean {
    return socket?.readyState === WebSocket.OPEN
  }

  function ping(): void {
    send({ type: 'ping' })
  }

  function createRoom(displayName?: string): void {
    send({
      type: 'create_room',
      displayName,
    })
  }

  function joinRoom(roomId: string, displayName?: string): void {
    send({
      type: 'join_room',
      roomId,
      displayName,
    })
  }

  function joinMatchmaking(stake: MatchStake, displayName?: string): void {
    send({
      type: 'join_matchmaking',
      stake,
      displayName,
    })
  }

  function leaveMatchmaking(): void {
    send({
      type: 'leave_matchmaking',
    })
  }

  function requestPlayerProfile(roomId: string, seat: Seat): void {
    send({
      type: 'request_player_profile',
      roomId,
      seat,
    })
  }

  function resumeRoom(roomId: string, reconnectToken: string): void {
    send({
      type: 'resume_room',
      roomId,
      reconnectToken,
    })
  }

  function leaveActiveRoom(roomId: string): void {
    send({
      type: 'leave_active_room',
      roomId,
    })
  }

  function submitBidAction(roomId: string, action: ClientBidAction): void {
    send({
      type: 'submit_bid_action',
      roomId,
      action,
    })
  }

  function submitCutIndex(roomId: string, cutIndex: number): void {
    send({
      type: 'submit_cut_index',
      roomId,
      cutIndex,
    })
  }

  function submitPlayCard(roomId: string, cardId: string): void {
    send({
      type: 'submit_play_card',
      roomId,
      cardId,
    })
  }

  function resumeHumanControl(roomId: string): void {
    send({
      type: 'resume_human_control',
      roomId,
    })
  }

  return {
    connect,
    disconnect,
    isConnected,
    ping,
    createRoom,
    joinRoom,
    joinMatchmaking,
    leaveMatchmaking,
    requestPlayerProfile,
    resumeRoom,
    leaveActiveRoom,
    submitBidAction,
    submitCutIndex,
    submitPlayCard,
    resumeHumanControl,
  }
}
