import type {
  ClientBidAction,
  MatchFoundMessage,
  MatchStake,
  RoomCompletedTrickSnapshot,
  RoomCuttingSnapshot,
  RoomGameSnapshot,
  RoomSeatSnapshot,
  RoomStatus,
  Seat,
  ServerMessage,
} from '../network/createGameServerClient'

export type ActiveRoomState = {
  roomId: string
  seat: Seat
  stake: MatchStake
  humanPlayers: number
  botPlayers: number
  shouldStartImmediately: boolean
  roomStatus: RoomStatus | null
  reconnectToken: string | null
  seats: RoomSeatSnapshot[]
  game: RoomGameSnapshot | null
  isConnected: boolean
  errorText: string | null
}

export type CreateActiveRoomFlowControllerOptions = {
  root: HTMLDivElement
  isConnected: () => boolean
  leaveActiveRoom: (roomId: string) => void
  submitCutIndex: (roomId: string, cutIndex: number) => void
  submitBidAction: (roomId: string, action: ClientBidAction) => void
  submitPlayCard: (roomId: string, cardId: string) => void
  resumeHumanControl: (roomId: string) => void
  showLobby: (errorText?: string | null) => void
}

export type ActiveRoomFlowController = {
  render: () => void
  enterActiveRoom: (message: MatchFoundMessage) => void
  handleServerMessage: (message: ServerMessage) => boolean
  setConnected: (value: boolean) => void
  setConnectionError: (message: string | null) => void
  setConnectionState: (isConnected: boolean, message: string | null) => void
  leaveActiveRoom: () => void
  hasActiveRoom: () => boolean
}

export type CuttingAnimationCache = {
  armedCycleKey: string | null
  pendingCycleKey: string | null
  activeCycleKey: string | null
  activeSelectionKey: string | null
  renderedSelectionKey: string | null
  startedAt: number
  completionTimerId: number | null
  latchedCuttingSnapshot: RoomCuttingSnapshot | null
  latchedCutterDisplayName: string
  latchedDealerSeat: Seat | null
  isAnimating: boolean
  hasCompleted: boolean
}

export type DealingAnimationCache = {
  activePhaseKey: string | null
  renderedPhaseKey: string | null
  renderedFirstDealSeat: Seat | null
  startedAt: number
  completionTimerId: number | null
  isAnimating: boolean
  hasCompleted: boolean
}

export type PlayingUiCache = {
  lastTrickKey: string | null
  lastCompletedTricksCount: number
  isTrickCollectionAnimating: boolean
  pendingCompletedTrickKey: string | null
  latestCompletedTrickKey: string | null
  bufferedCompletedTrick: RoomCompletedTrickSnapshot | null
  completedTrickEntryKey: string | null
  completedTrickEntryStartedAt: number
  hasRenderedSnapshot: boolean
  animationToken: number
  pendingPlayCardSent: boolean
  wasMyTurn: boolean
  observedPlayKeys: string[]
  showBotTakeover: boolean
  hasShownBotTakeover: boolean
  lastPlayedCardRect: DOMRect | null
  hoveredHandCardId: string | null
}

export type BiddingUiState = {
  lastKnownEntriesCount: number
  pendingBidSent: boolean
  wasMyTurn: boolean
  recentBubbles: Partial<Record<Seat, { label: string; startedAt: number }>>
  bubbleTimerIds: Partial<Record<Seat, number>>
  showBotTakeover: boolean
  botTakeoverTimerId: number | null
}
