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
  TournamentAttendanceSnapshot,
  TournamentBotReplacementSnapshot,
  TournamentRoomBannerSnapshot,
} from '../network/createGameServerClient'
import type { GameAudioController } from '../audio/createGameAudioController'
import type { PendingDeclarationPrompt } from './declarations/declarationPromptTypes'

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
  leavePenaltyWarningOpen: boolean
  isGuestTrial: boolean
  isPrivateTableOrigin: boolean
  isTournamentMatchOrigin: boolean
  tournamentAttendance: TournamentAttendanceSnapshot | null
  tournamentBotReplacements: TournamentBotReplacementSnapshot[]
  tournamentBanners: TournamentRoomBannerSnapshot[]
}

export type CreateActiveRoomFlowControllerOptions = {
  root: HTMLDivElement
  gameAudio?: GameAudioController
  isConnected: () => boolean
  leaveActiveRoom: (roomId: string, acceptPenalty?: boolean) => void
  submitCutIndex: (roomId: string, cutIndex: number) => void
  submitBidAction: (roomId: string, action: ClientBidAction) => void
  submitPlayCard: (roomId: string, cardId: string, declarationKeys?: string[]) => void
  resumeHumanControl: (roomId: string) => void
  submitPartnerRating: (roomId: string, ratingValue: number) => void
  sendReplayVote: (roomId: string) => void
  sendLeaveMatchVote: (roomId: string) => void
  sendEmojiReaction: (roomId: string, emojiId: string) => void
  sendPhraseReaction: (roomId: string, phraseId: string) => void
  requestPlayerProfile: (roomId: string, seat: Seat) => void
  getFriendshipAction: (profileId: string) => import('../../ui/overlays/renderPlayerProfilePopup').PlayerProfileFriendshipAction | null
  onSendFriendRequest: (profileId: string) => Promise<{ ok: true; newLabel: string } | { ok: false; message: string }>
  onLikeProfile: (profileId: string) => Promise<{ ok: true; liked: boolean; likesCount: number } | { ok: false }>
  onBlockProfile: (profileId: string) => Promise<{ message: string }>
  showLobby: (errorText?: string | null) => void
  startNewGame: (stake: MatchStake, displayName?: string) => void
  onGuestTrialReplayRequested: () => void
}

export type ActiveRoomFlowController = {
  render: () => void
  enterActiveRoom: (message: MatchFoundMessage, stakeAlreadyShown?: boolean) => void
  enterActiveRoomFromResume: (roomId: string, seat: Seat, stake: MatchStake) => void
  handleServerMessage: (message: ServerMessage) => boolean
  getResumeInfo: () => { roomId: string; reconnectToken: string } | null
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
  pendingDeclarationPrompt: PendingDeclarationPrompt | null
  submittedDeclarationKeys: string[]
  flyingCardPlayKey: string | null
  lastSeatPanelKey: string | null
}

export type BiddingUiState = {
  lastKnownEntriesCount: number
  pendingBidSent: boolean
  wasMyTurn: boolean
  popupAnimatedTurnKey: string | null
  recentBubbles: Partial<Record<Seat, { label: string; startedAt: number }>>
  bubbleTimerIds: Partial<Record<Seat, number>>
  showBotTakeover: boolean
  botTakeoverTimerId: number | null
}

export type EmojiReactionUiState = {
  activeBubbles: Partial<Record<Seat, { emojiId: string; startedAt: number }>>
  timerIds: Partial<Record<Seat, number>>
}

export type PhraseReactionUiState = {
  activeBubbles: Partial<Record<Seat, { phraseId: string; startedAt: number }>>
  timerIds: Partial<Record<Seat, number>>
}
