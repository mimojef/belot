import {
  renderMatchmakingRoomScreen,
  type MatchmakingRoomPlayer,
} from './renderMatchmakingRoomScreen'
import { showStakeDeductionEffect } from '../activeRoom/renderStakeDeductionEffect'
import {
  renderLobbyScreen,
  type AvatarCropSelection,
  type LobbyAuthModalMode,
  type LobbyScreenState,
} from './renderLobbyScreen'
import type {
  AdminSettingsSnapshot,
  ChatConversationSnapshot,
  ChatMessageSnapshot,
  CoinPackageInput,
  CoinPackageSnapshot,
  CoinPackageStatus,
  CoinPurchaseSnapshot,
  FriendRelationshipSnapshot,
  FriendshipsSnapshot,
  LeaderboardCategory,
  LeaderboardsSnapshot,
  MatchFoundMessage,
  MatchStake,
  PlayerPublicProfileSnapshot,
  RoomSeatSnapshot,
  ServerMessage,
} from '../network/createGameServerClient'

export type LobbyFlowScreen =
  | 'lobby'
  | 'players'
  | 'leaderboards'
  | 'shop'
  | 'admin'
  | 'matchmaking-room'
export type LobbySocialScreen = LobbyFlowScreen | 'friends' | 'chat'

export type LobbyAuthSession = {
  account: {
    role: string
  }
  profile: PlayerPublicProfileSnapshot
}

export type CreateLobbyFlowControllerOptions = {
  root: HTMLElement
  joinMatchmaking: (stake: MatchStake, displayName?: string) => void
  leaveMatchmaking: () => void
  onMatchFound: (message: MatchFoundMessage) => void
  tryUnlockDocumentAudio?: () => void
  getAuthSession?: () => LobbyAuthSession | null
  getSignupBonusYellowCoins?: () => number
  getProfileNameChangePrice?: () => number
  onLoginSubmit?: (email: string, password: string) => Promise<string | null>
  onRegisterSubmit?: (
    displayName: string,
    email: string,
    password: string,
  ) => Promise<string | null>
  onProfileEditSubmit?: (
    avatarFile: File | null,
    avatarCrop: AvatarCropSelection | null,
    galleryFiles: File[],
  ) => Promise<string | null>
  onProfileGalleryDelete?: (imageId: string) => Promise<string | null>
  onProfileNameChangeSubmit?: (displayName: string) => Promise<string | null>
  onPlayersLoad?: () => Promise<
    | { ok: true; players: PlayerPublicProfileSnapshot[] }
    | { ok: false; message: string }
  >
  onLeaderboardsLoad?: () => Promise<
    | { ok: true; leaderboards: LeaderboardsSnapshot }
    | { ok: false; message: string }
  >
  onShopPackagesLoad?: () => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onShopPurchasesLoad?: () => Promise<
    | { ok: true; purchases: CoinPurchaseSnapshot[] }
    | { ok: false; message: string }
  >
  onShopPurchaseStart?: (packageId: string) => Promise<
    | { ok: true; purchases: CoinPurchaseSnapshot[]; message: string }
    | { ok: false; message: string }
  >
  onAdminSettingsLoad?: () => Promise<
    | { ok: true; settings: AdminSettingsSnapshot }
    | { ok: false; message: string }
  >
  onAdminSettingsSubmit?: (
    settings: AdminSettingsSnapshot,
  ) => Promise<
    | { ok: true; settings: AdminSettingsSnapshot }
    | { ok: false; message: string }
  >
  onAdminCoinPackagesLoad?: () => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminCoinPackageSubmit?: (
    input: CoinPackageInput,
  ) => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminCoinPackageStatusChange?: (
    packageId: string,
    status: CoinPackageStatus,
  ) => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onFriendshipsLoad?: () => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendRequestSubmit?: (profileId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendAccept?: (friendshipId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendReject?: (friendshipId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendRemove?: (friendshipId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendBlock?: (profileId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onGiftCoinsSubmit?: (friendshipId: string, amount: number) => Promise<
    | {
        ok: true
        senderProfile: PlayerPublicProfileSnapshot
        recipientProfile: PlayerPublicProfileSnapshot
      }
    | { ok: false; message: string }
  >
  onChatConversationsLoad?: () => Promise<
    | { ok: true; conversations: ChatConversationSnapshot[] }
    | { ok: false; message: string }
  >
  onChatMessagesLoad?: (friendshipId: string) => Promise<
    | { ok: true; messages: ChatMessageSnapshot[] }
    | { ok: false; message: string }
  >
  onChatSend?: (friendshipId: string, body: string) => Promise<
    | {
        ok: true
        conversation: ChatConversationSnapshot
        messages: ChatMessageSnapshot[]
      }
    | { ok: false; message: string }
  >
}

export type LobbyFlowController = {
  render: () => void
  destroy: () => void
  getCurrentScreen: () => LobbySocialScreen
  setConnected: (value: boolean) => void
  setDisplayName: (value: string) => void
  setErrorText: (value: string | null) => void
  setLocalAvatarUrl: (value: string | null) => void
  setFriendships: (value: FriendshipsSnapshot | null) => void
  setChatConversations: (value: ChatConversationSnapshot[]) => void
  startMatchmaking: (stake: MatchStake, displayName?: string) => void
  resetToLobby: () => void
  handleServerMessage: (message: ServerMessage) => boolean
  navigateToShop: (noticeText: string | null) => void
}

type InternalLobbyFlowState = {
  currentScreen: LobbySocialScreen
  displayName: string
  localAvatarUrl: string | null
  selectedStake: MatchStake
  isConnected: boolean
  isSearching: boolean
  queuedPlayers: number
  requiredPlayers: number
  remainingMs: number | null
  countdownEndsAt: number | null
  errorText: string | null
  profilePopupOpen: boolean
  profilePopupProfile: PlayerPublicProfileSnapshot | null
  profilePopupCanEdit: boolean
  profileEditorOpen: boolean
  profileEditorErrorText: string | null
  authModalMode: LobbyAuthModalMode
  authErrorText: string | null
  serverRoomSeats: RoomSeatSnapshot[] | null
  serverYourSeat: RoomSeatSnapshot['seat'] | null
  serverPreviewBotDisplayNames: string[]
  players: PlayerPublicProfileSnapshot[]
  playersLoading: boolean
  playersErrorText: string | null
  leaderboards: LeaderboardsSnapshot | null
  leaderboardsLoading: boolean
  leaderboardsErrorText: string | null
  activeLeaderboardCategory: LeaderboardCategory
  shopPackages: CoinPackageSnapshot[]
  shopPackagesLoading: boolean
  shopPackagesErrorText: string | null
  shopPurchases: CoinPurchaseSnapshot[]
  shopPurchasesLoading: boolean
  shopPurchaseActionPackageId: string | null
  shopPurchaseMessageText: string | null
  adminSettings: AdminSettingsSnapshot | null
  adminSettingsLoading: boolean
  adminSettingsErrorText: string | null
  adminCoinPackages: CoinPackageSnapshot[]
  adminCoinPackagesLoading: boolean
  adminCoinPackagesErrorText: string | null
  friendships: FriendshipsSnapshot | null
  friendsLoading: boolean
  friendsErrorText: string | null
  friendActionLoadingProfileId: string | null
  friendActionMessageProfileId: string | null
  friendActionMessage: string | null
  giftModalFriendshipId: string | null
  giftModalFriendName: string
  giftModalErrorText: string | null
  chatConversations: ChatConversationSnapshot[]
  activeChatFriendshipId: string | null
  chatMessages: ChatMessageSnapshot[]
  chatLoading: boolean
  chatMessagesLoading: boolean
  chatErrorText: string | null
}

type StakeCardConfig = {
  stake: MatchStake
  prizeAmount: number
}

const DEFAULT_REQUIRED_PLAYERS = 4
const DEFAULT_COUNTDOWN_MS = 15000
const FINAL_FILL_START_REMAINING_MS = 3000
const FINAL_FILL_STAGGER_OFFSETS_MS = [0, 620, 860] as const
const FINAL_FILL_MATCH_START_DELAY_MS = 1000

const WAITING_CLOCK_AUDIO_SRC = '/audio/ui/waiting-clock.mp3'
const WAITING_CLOCK_AUDIO_VOLUME = 0.75

const SEAT_FILL_AUDIO_SRC = '/audio/ui/player-seat-fill.mp3'
const SEAT_FILL_AUDIO_VOLUME = 0.9
const SEAT_FILL_SOUND_STAGGER_MS = 120

const STAKE_CARD_CONFIG: Record<MatchStake, StakeCardConfig> = {
  5000: { stake: 5000, prizeAmount: 8000 },
  8000: { stake: 8000, prizeAmount: 12000 },
  10000: { stake: 10000, prizeAmount: 15000 },
  15000: { stake: 15000, prizeAmount: 22000 },
  20000: { stake: 20000, prizeAmount: 30000 },
}

function getStakePrizeAmount(stake: MatchStake): number {
  return STAKE_CARD_CONFIG[stake]?.prizeAmount ?? stake
}

function createInitialState(): InternalLobbyFlowState {
  return {
    currentScreen: 'lobby',
    displayName: '',
    localAvatarUrl: null,
    selectedStake: 5000,
    isConnected: false,
    isSearching: false,
    queuedPlayers: 0,
    requiredPlayers: DEFAULT_REQUIRED_PLAYERS,
    remainingMs: null,
    countdownEndsAt: null,
    errorText: null,
    profilePopupOpen: false,
    profilePopupProfile: null,
    profilePopupCanEdit: true,
    profileEditorOpen: false,
    profileEditorErrorText: null,
    authModalMode: 'closed',
    authErrorText: null,
    serverRoomSeats: null,
    serverYourSeat: null,
    serverPreviewBotDisplayNames: [],
    players: [],
    playersLoading: false,
    playersErrorText: null,
    leaderboards: null,
    leaderboardsLoading: false,
    leaderboardsErrorText: null,
    activeLeaderboardCategory: 'balance',
    shopPackages: [],
    shopPackagesLoading: false,
    shopPackagesErrorText: null,
    shopPurchases: [],
    shopPurchasesLoading: false,
    shopPurchaseActionPackageId: null,
    shopPurchaseMessageText: null,
    adminSettings: null,
    adminSettingsLoading: false,
    adminSettingsErrorText: null,
    adminCoinPackages: [],
    adminCoinPackagesLoading: false,
    adminCoinPackagesErrorText: null,
    friendships: null,
    friendsLoading: false,
    friendsErrorText: null,
    friendActionLoadingProfileId: null,
    friendActionMessageProfileId: null,
    friendActionMessage: null,
    giftModalFriendshipId: null,
    giftModalFriendName: '',
    giftModalErrorText: null,
    chatConversations: [],
    activeChatFriendshipId: null,
    chatMessages: [],
    chatLoading: false,
    chatMessagesLoading: false,
    chatErrorText: null,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getLobbyRemainingMs(state: InternalLobbyFlowState): number | null {
  if (!state.isSearching) {
    return null
  }

  if (state.countdownEndsAt !== null) {
    return Math.max(0, state.countdownEndsAt - Date.now())
  }

  return state.remainingMs
}

function getLobbyStatusText(state: InternalLobbyFlowState): string {
  if (!state.isConnected) {
    return 'Свързване със сървъра...'
  }

  if (state.isSearching) {
    return `Търсиш игра за ${state.selectedStake}.`
  }

  return 'Избери маса и започни търсене на игра.'
}

function getRoomStatusText(
  state: InternalLobbyFlowState,
  displayedQueuedPlayers: number,
): string {
  if (!state.isConnected) {
    return 'Изчакваме връзката със сървъра...'
  }

  const missingPlayers = Math.max(0, state.requiredPlayers - displayedQueuedPlayers)

  if (missingPlayers <= 0) {
    return 'Масата е готова. Играта стартира.'
  }

  if (missingPlayers === 1) {
    return 'Чакаме още 1 играч...'
  }

  return `Чакаме още ${missingPlayers} играчи...`
}

function countOccupiedSeats(seats: RoomSeatSnapshot[]): number {
  return seats.reduce((count, seat) => count + (seat.isOccupied ? 1 : 0), 0)
}

function getLocalSeatSnapshot(
  state: InternalLobbyFlowState,
): RoomSeatSnapshot | null {
  if (!state.serverRoomSeats || !state.serverYourSeat) {
    return null
  }

  return state.serverRoomSeats.find((seat) => seat.seat === state.serverYourSeat) ?? null
}

function getOtherOccupiedSeatSnapshots(
  state: InternalLobbyFlowState,
): RoomSeatSnapshot[] {
  if (!state.serverRoomSeats) {
    return []
  }

  return state.serverRoomSeats.filter(
    (seat) => seat.isOccupied && seat.seat !== state.serverYourSeat,
  )
}

const WAITING_PLAYER_DISPLAY_NAME = 'Чакаме...'
const LOCAL_PLAYER_FALLBACK_DISPLAY_NAME = 'Гост'

function createLocalProfilePreview(
  state: InternalLobbyFlowState,
  authSession: LobbyAuthSession | null,
): PlayerPublicProfileSnapshot {
  if (authSession !== null) {
    return authSession.profile
  }

  const localSeatSnapshot = getLocalSeatSnapshot(state)
  const displayName =
    localSeatSnapshot?.displayName.trim() ||
    state.displayName.trim() ||
    LOCAL_PLAYER_FALLBACK_DISPLAY_NAME
  const avatarUrl = localSeatSnapshot?.avatarUrl ?? state.localAvatarUrl

  return {
    profileId: null,
    displayName,
    avatarUrl,
    level: 1,
    rankTitle: 'Ранг 1',
    skillRating: null,
    completedGamesCount: 0,
    wonGamesCount: 0,
    currentRankGames: 0,
    nextRankGames: 5,
    gamesUntilNextRank: 5,
    rankProgressRatio: 0,
    averageRating: 0,
    totalRatingsCount: 0,
    yellowCoinsBalance: 25430,
    galleryImages: avatarUrl
      ? [
          {
            imageId: 'local-avatar',
            imageUrl: avatarUrl,
            sortOrder: 0,
          },
        ]
      : [],
  }
}

function createAutoFillPreviewPlayer(
  index: number,
  displayName: string | null = null,
): MatchmakingRoomPlayer {
  const normalizedDisplayName = displayName?.trim() || WAITING_PLAYER_DISPLAY_NAME

  return {
    id: `autofill-preview-${index + 1}`,
    name: normalizedDisplayName,
    avatarUrl: null,
    isBot: normalizedDisplayName !== WAITING_PLAYER_DISPLAY_NAME,
  }
}

function findRelationshipByProfileId(
  friendships: FriendshipsSnapshot | null,
  profileId: string,
): FriendRelationshipSnapshot | null {
  if (friendships === null) {
    return null
  }

  const relationships = [
    ...friendships.incomingPending,
    ...friendships.outgoingPending,
    ...friendships.friends,
    ...friendships.blocked,
  ]

  return relationships.find((relationship) => {
    return relationship.profile.profileId === profileId
  }) ?? null
}

export function createLobbyFlowController(
  options: CreateLobbyFlowControllerOptions,
): LobbyFlowController {
  const state = createInitialState()

  let countdownAnimationFrameId: number | null = null
  let countdownTextElement: HTMLElement | null = null
  let progressBarElement: HTMLElement | null = null
  let lastRenderedCountdownSecond: number | null = null

  let finalFillSequenceStartedAt: number | null = null
  let finalFillBaseQueuedPlayers: number | null = null
  let finalFillAnimatedQueuedPlayers: number | null = null
  let pendingMatchFoundMessage: MatchFoundMessage | null = null
  let pendingMatchFoundTimeoutId: number | null = null
  let stakeEffectStartedAt: number | null = null
  let pendingStakeEffect = false

  let autoFillPreviewPlayers: MatchmakingRoomPlayer[] = []
  let waitingClockAudio: HTMLAudioElement | null = null
  let lastSoundedDisplayedQueuedPlayers: number | null = null
  let seatFillSoundTimeoutIds: number[] = []

  function getWaitingClockAudio(): HTMLAudioElement {
    if (!waitingClockAudio) {
      waitingClockAudio = new Audio(WAITING_CLOCK_AUDIO_SRC)
      waitingClockAudio.preload = 'auto'
      waitingClockAudio.loop = true
      waitingClockAudio.volume = WAITING_CLOCK_AUDIO_VOLUME
    }

    return waitingClockAudio
  }

  function startWaitingClockAudio(): void {
    if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
      return
    }

    const audio = getWaitingClockAudio()
    audio.loop = true
    audio.volume = WAITING_CLOCK_AUDIO_VOLUME

    if (!audio.paused) {
      return
    }

    void audio.play().catch(() => {})
  }

  function stopWaitingClockAudio(resetTime = true): void {
    if (!waitingClockAudio) {
      return
    }

    waitingClockAudio.pause()

    if (resetTime) {
      waitingClockAudio.currentTime = 0
    }
  }

  function clearCountdownAnimationFrame(): void {
    if (countdownAnimationFrameId !== null) {
      window.cancelAnimationFrame(countdownAnimationFrameId)
      countdownAnimationFrameId = null
    }
  }

  function clearPendingMatchFoundTimeout(): void {
    if (pendingMatchFoundTimeoutId !== null) {
      window.clearTimeout(pendingMatchFoundTimeoutId)
      pendingMatchFoundTimeoutId = null
    }
  }

  function clearSeatFillSoundTimeouts(): void {
    for (const timeoutId of seatFillSoundTimeoutIds) {
      window.clearTimeout(timeoutId)
    }

    seatFillSoundTimeoutIds = []
  }

  function playSeatFillSound(): void {
    const audio = new Audio(SEAT_FILL_AUDIO_SRC)
    audio.preload = 'auto'
    audio.volume = SEAT_FILL_AUDIO_VOLUME
    void audio.play().catch(() => {})
  }

  function syncSeatFillSounds(displayedQueuedPlayers: number): void {
    if (lastSoundedDisplayedQueuedPlayers === null) {
      lastSoundedDisplayedQueuedPlayers = displayedQueuedPlayers
      return
    }

    if (displayedQueuedPlayers <= lastSoundedDisplayedQueuedPlayers) {
      lastSoundedDisplayedQueuedPlayers = displayedQueuedPlayers
      return
    }

    const addedPlayers = displayedQueuedPlayers - lastSoundedDisplayedQueuedPlayers
    lastSoundedDisplayedQueuedPlayers = displayedQueuedPlayers

    for (let index = 0; index < addedPlayers; index += 1) {
      const delay = index * SEAT_FILL_SOUND_STAGGER_MS

      const timeoutId = window.setTimeout(() => {
        playSeatFillSound()
      }, delay)

      seatFillSoundTimeoutIds.push(timeoutId)
    }
  }

  function resetLiveCountdownTargets(): void {
    countdownTextElement = null
    progressBarElement = null
    lastRenderedCountdownSecond = null
  }

  function resetAutoFillPreviewPlayers(): void {
    autoFillPreviewPlayers = []
  }

  function resetSeatFillSoundTracking(): void {
    lastSoundedDisplayedQueuedPlayers = null
    clearSeatFillSoundTimeouts()
  }

  function clearServerRoomSnapshot(): void {
    state.serverRoomSeats = null
    state.serverYourSeat = null
  }

  function ensureAutoFillPreviewPlayersCount(count: number): void {
    autoFillPreviewPlayers = Array.from({ length: count }, (_, index) => {
      return createAutoFillPreviewPlayer(
        index,
        state.serverPreviewBotDisplayNames[index] ?? null,
      )
    })
  }

  function clearFinalFillAnimationState(): void {
    finalFillSequenceStartedAt = null
    finalFillBaseQueuedPlayers = null
    finalFillAnimatedQueuedPlayers = null
    pendingStakeEffect = false
    resetAutoFillPreviewPlayers()
    resetSeatFillSoundTracking()
  }

  function resetFinalFillSequence(): void {
    clearFinalFillAnimationState()
    pendingMatchFoundMessage = null
    clearPendingMatchFoundTimeout()
    stakeEffectStartedAt = null
  }

  function syncLiveCountdownTargets(): void {
    countdownTextElement = options.root.querySelector<HTMLElement>(
      '[data-matchmaking-countdown-text="1"]',
    )
    progressBarElement = options.root.querySelector<HTMLElement>(
      '[data-matchmaking-progress-bar="1"]',
    )
    lastRenderedCountdownSecond = null
  }

  function getDisplayedQueuedPlayers(): number {
    if (state.serverRoomSeats) {
      return countOccupiedSeats(state.serverRoomSeats)
    }

    if (finalFillAnimatedQueuedPlayers !== null) {
      return Math.max(state.queuedPlayers, finalFillAnimatedQueuedPlayers)
    }

    return state.queuedPlayers
  }

  function createDisplayedJoinedPlayers(): MatchmakingRoomPlayer[] {
    if (state.serverRoomSeats) {
      return getOtherOccupiedSeatSnapshots(state).map((seat) => ({
        id: `room-seat-${seat.seat}`,
        name: seat.displayName,
        avatarUrl: seat.avatarUrl,
        isBot: seat.isBot,
      }))
    }

    const displayedQueuedPlayers = getDisplayedQueuedPlayers()
    const totalOtherSeats = Math.max(0, displayedQueuedPlayers - 1)
    const actualOtherPlayers = Math.max(0, state.queuedPlayers - 1)
    const autoFillCount = Math.max(0, totalOtherSeats - actualOtherPlayers)

    ensureAutoFillPreviewPlayersCount(autoFillCount)

    const actualPlayers = Array.from({ length: actualOtherPlayers }, (_, index) => ({
      id: `queued-preview-${index + 1}`,
      name: WAITING_PLAYER_DISPLAY_NAME,
      avatarUrl: null,
      isBot: false,
    }))

    return [...actualPlayers, ...autoFillPreviewPlayers.slice(0, autoFillCount)]
  }

  function createDisplayedLocalPlayer(): MatchmakingRoomPlayer {
    const localSeatSnapshot = getLocalSeatSnapshot(state)

    if (localSeatSnapshot?.isOccupied) {
      return {
        id: `room-seat-${localSeatSnapshot.seat}`,
        name: localSeatSnapshot.displayName,
        avatarUrl: localSeatSnapshot.avatarUrl ?? state.localAvatarUrl,
        isBot: localSeatSnapshot.isBot,
      }
    }

    return {
      id: 'local-player',
      name: state.displayName.trim() || LOCAL_PLAYER_FALLBACK_DISPLAY_NAME,
      avatarUrl: state.localAvatarUrl,
      isBot: false,
    }
  }

  function clearUiTickLoop(): void {
    clearCountdownAnimationFrame()
    resetLiveCountdownTargets()
  }

  function stopWaitingRoomActivity(): void {
    clearUiTickLoop()
    stopWaitingClockAudio()
    clearSeatFillSoundTimeouts()
  }

  function switchToLobby(): void {
    state.currentScreen = 'lobby'
    state.isSearching = false
    state.queuedPlayers = 0
    state.requiredPlayers = DEFAULT_REQUIRED_PLAYERS
    state.remainingMs = null
    state.countdownEndsAt = null
    state.serverPreviewBotDisplayNames = []
    clearServerRoomSnapshot()
    stopWaitingRoomActivity()
    resetFinalFillSequence()
  }

  function updateMatchmakingRoomLiveUi(): boolean {
    if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
      return false
    }

    if (!countdownTextElement || !progressBarElement) {
      syncLiveCountdownTargets()
    }

    if (!countdownTextElement || !progressBarElement) {
      return false
    }

    const remainingMs = clamp(
      getLobbyRemainingMs(state) ?? DEFAULT_COUNTDOWN_MS,
      0,
      DEFAULT_COUNTDOWN_MS,
    )
    const countdownSeconds = Math.ceil(remainingMs / 1000)
    const progressDegrees = (remainingMs / DEFAULT_COUNTDOWN_MS) * 360

    if (lastRenderedCountdownSecond !== countdownSeconds) {
      countdownTextElement.innerHTML = `
        <span class="mm-countdown-number">${countdownSeconds}</span>
        <span class="mm-countdown-unit">сек</span>
      `
      lastRenderedCountdownSecond = countdownSeconds
    }

    progressBarElement.style.transition = 'none'
    progressBarElement.style.setProperty('--matchmaking-progress', `${progressDegrees}deg`)

    return true
  }

  function maybeStartFinalFillSequence(): void {
    if (state.serverRoomSeats) {
      return
    }

    if (finalFillSequenceStartedAt !== null) {
      return
    }

    if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
      return
    }

    if (state.queuedPlayers >= state.requiredPlayers) {
      return
    }

    const remainingMs = getLobbyRemainingMs(state)

    if (remainingMs === null || remainingMs > FINAL_FILL_START_REMAINING_MS) {
      return
    }

    finalFillSequenceStartedAt = Date.now()
    finalFillBaseQueuedPlayers = state.queuedPlayers
    finalFillAnimatedQueuedPlayers = state.queuedPlayers

    if (pendingStakeEffect) {
      pendingStakeEffect = false
      stakeEffectStartedAt = Date.now()
      showStakeDeductionEffect(state.selectedStake)
    }
  }

  function isFinalFillSequenceComplete(): boolean {
    return getDisplayedQueuedPlayers() >= state.requiredPlayers
  }

  function flushPendingMatchFound(): boolean {
    const matchFoundMessage = pendingMatchFoundMessage

    if (!matchFoundMessage) {
      return false
    }

    pendingMatchFoundMessage = null
    clearPendingMatchFoundTimeout()

    state.isSearching = false
    state.queuedPlayers = 0
    state.requiredPlayers = DEFAULT_REQUIRED_PLAYERS
    state.remainingMs = null
    state.countdownEndsAt = null

    clearServerRoomSnapshot()
    stopWaitingRoomActivity()
    clearFinalFillAnimationState()

    const STAKE_EFFECT_VISIBLE_MS = 1600
    const elapsed = stakeEffectStartedAt !== null ? Date.now() - stakeEffectStartedAt : null
    const remainingDelay =
      elapsed !== null ? Math.max(0, STAKE_EFFECT_VISIBLE_MS - elapsed) : 0

    stakeEffectStartedAt = null

    if (remainingDelay > 0) {
      setTimeout(() => options.onMatchFound(matchFoundMessage), remainingDelay)
    } else {
      options.onMatchFound(matchFoundMessage)
    }
    return true
  }

  function maybeSchedulePendingMatchFound(): void {
    if (!pendingMatchFoundMessage) {
      return
    }

    if (finalFillSequenceStartedAt === null) {
      return
    }

    if (!isFinalFillSequenceComplete()) {
      return
    }

    if (pendingMatchFoundTimeoutId !== null) {
      return
    }

    pendingMatchFoundTimeoutId = window.setTimeout(() => {
      pendingMatchFoundTimeoutId = null
      flushPendingMatchFound()
    }, FINAL_FILL_MATCH_START_DELAY_MS)
  }

  function updateFinalFillSequenceProgress(): boolean {
    maybeStartFinalFillSequence()

    if (
      finalFillSequenceStartedAt === null ||
      finalFillBaseQueuedPlayers === null ||
      finalFillAnimatedQueuedPlayers === null
    ) {
      return false
    }

    const missingPlayersAtStart = Math.max(
      0,
      state.requiredPlayers - finalFillBaseQueuedPlayers,
    )

    if (missingPlayersAtStart === 0) {
      maybeSchedulePendingMatchFound()
      return false
    }

    const triggerOffsets = FINAL_FILL_STAGGER_OFFSETS_MS.slice(0, missingPlayersAtStart)
    const elapsedMs = Math.max(0, Date.now() - finalFillSequenceStartedAt)

    let fillsApplied = 0

    for (const offset of triggerOffsets) {
      if (elapsedMs >= offset) {
        fillsApplied += 1
      }
    }

    const nextAnimatedQueuedPlayers = clamp(
      finalFillBaseQueuedPlayers + fillsApplied,
      state.queuedPlayers,
      state.requiredPlayers,
    )

    if (nextAnimatedQueuedPlayers !== finalFillAnimatedQueuedPlayers) {
      finalFillAnimatedQueuedPlayers = nextAnimatedQueuedPlayers
      maybeSchedulePendingMatchFound()
      return true
    }

    maybeSchedulePendingMatchFound()
    return false
  }

  function createProfileFriendshipAction(
    authSession: LobbyAuthSession | null,
  ): LobbyScreenState['friendshipAction'] {
    const profile = state.profilePopupProfile
    const targetProfileId = profile?.profileId ?? null

    if (!state.profilePopupOpen || state.profilePopupCanEdit || targetProfileId === null) {
      return null
    }

    const message =
      state.friendActionMessageProfileId === targetProfileId
        ? state.friendActionMessage
        : null

    if (authSession === null) {
      return {
        profileId: targetProfileId,
        label: 'Влез, за да поканиш',
        disabled: false,
        message,
      }
    }

    if (authSession.profile.profileId === targetProfileId) {
      return null
    }

    if (state.friendActionLoadingProfileId === targetProfileId) {
      return {
        profileId: targetProfileId,
        label: 'Изпращане...',
        disabled: true,
        message,
      }
    }

    const relationship = findRelationshipByProfileId(
      state.friendships,
      targetProfileId,
    )

    if (relationship === null) {
      return {
        profileId: targetProfileId,
        label: 'Покани за приятел',
        disabled: false,
        message,
      }
    }

    if (relationship.status === 'accepted') {
      return {
        profileId: targetProfileId,
        label: 'Вече сте приятели',
        disabled: true,
        message,
      }
    }

    if (relationship.status === 'blocked') {
      return {
        profileId: targetProfileId,
        label: 'Недостъпно',
        disabled: true,
        message,
      }
    }

    return {
      profileId: targetProfileId,
      label:
        relationship.direction === 'incoming'
          ? 'Има входяща покана'
          : 'Поканата е изпратена',
      disabled: true,
      message,
    }
  }

  function renderLobby(): void {
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    clearServerRoomSnapshot()

    const authSession = options.getAuthSession?.() ?? null
    const friendshipAction = createProfileFriendshipAction(authSession)
    if (
      friendshipAction !== null &&
      authSession !== null &&
      !friendshipAction.disabled
    ) {
      friendshipAction.canBlock = true
    }
    if (
      friendshipAction !== null &&
      authSession !== null &&
      friendshipAction.disabled &&
      friendshipAction.label !== 'РќРµРґРѕСЃС‚СЉРїРЅРѕ'
    ) {
      friendshipAction.canBlock = true
    }
    const acceptedRelationship =
      state.profilePopupProfile?.profileId
        ? findRelationshipByProfileId(
            state.friendships,
            state.profilePopupProfile.profileId,
          )
        : null
    if (
      friendshipAction !== null &&
      acceptedRelationship?.status === 'accepted'
    ) {
      friendshipAction.giftFriendshipId = acceptedRelationship.friendshipId
    }
    const lobbyState: LobbyScreenState = {
      view:
        state.currentScreen === 'players'
          ? 'players'
          : state.currentScreen === 'leaderboards'
            ? 'leaderboards'
            : state.currentScreen === 'shop'
              ? 'shop'
            : state.currentScreen === 'admin'
              ? 'admin'
          : state.currentScreen === 'friends'
            ? 'friends'
            : state.currentScreen === 'chat'
              ? 'chat'
            : 'tables',
      displayName: state.displayName,
      selectedStake: state.selectedStake,
      isConnected: state.isConnected,
      isSearching: state.isSearching,
      queuedPlayers: state.queuedPlayers,
      requiredPlayers: state.requiredPlayers,
      remainingMs: getLobbyRemainingMs(state),
      statusText: getLobbyStatusText(state),
      errorText: state.errorText,
      profilePopupOpen: state.profilePopupOpen,
      profile: createLocalProfilePreview(state, authSession),
      profilePopupProfile: state.profilePopupProfile,
      profilePopupCanEdit: state.profilePopupCanEdit,
      players: state.players,
      playersLoading: state.playersLoading,
      playersErrorText: state.playersErrorText,
      leaderboards: state.leaderboards,
      leaderboardsLoading: state.leaderboardsLoading,
      leaderboardsErrorText: state.leaderboardsErrorText,
      activeLeaderboardCategory: state.activeLeaderboardCategory,
      shopPackages: state.shopPackages,
      shopPackagesLoading: state.shopPackagesLoading,
      shopPackagesErrorText: state.shopPackagesErrorText,
      shopPurchases: state.shopPurchases,
      shopPurchasesLoading: state.shopPurchasesLoading,
      shopPurchaseActionPackageId: state.shopPurchaseActionPackageId,
      shopPurchaseMessageText: state.shopPurchaseMessageText,
      isAdmin: authSession?.account.role === 'admin',
      adminSettings: state.adminSettings,
      adminSettingsLoading: state.adminSettingsLoading,
      adminSettingsErrorText: state.adminSettingsErrorText,
      adminCoinPackages: state.adminCoinPackages,
      adminCoinPackagesLoading: state.adminCoinPackagesLoading,
      adminCoinPackagesErrorText: state.adminCoinPackagesErrorText,
      friendships: state.friendships,
      friendsLoading: state.friendsLoading,
      friendsErrorText: state.friendsErrorText,
      friendshipAction,
      giftModalFriendshipId: state.giftModalFriendshipId,
      giftModalFriendName: state.giftModalFriendName,
      giftModalErrorText: state.giftModalErrorText,
      chatConversations: state.chatConversations,
      activeChatFriendshipId: state.activeChatFriendshipId,
      chatMessages: state.chatMessages,
      chatLoading: state.chatLoading,
      chatMessagesLoading: state.chatMessagesLoading,
      chatErrorText: state.chatErrorText,
      authModalMode: state.authModalMode,
      authErrorText: state.authErrorText,
      signupBonusYellowCoins: options.getSignupBonusYellowCoins?.() ?? 100000,
      profileNameChangePrice:
        state.adminSettings?.profileNameChangePrice ??
        options.getProfileNameChangePrice?.() ??
        50000,
      profileEditorOpen: state.profileEditorOpen,
      profileEditorErrorText: state.profileEditorErrorText,
    }

    renderLobbyScreen(options.root, {
      state: lobbyState,
      onDisplayNameChange: (value) => {
        state.displayName = value
      },
      onStakeChange: (stake) => {
        state.selectedStake = stake
        render()
      },
      onSearchClick: () => {
        options.tryUnlockDocumentAudio?.()
        startMatchmaking(state.selectedStake, state.displayName.trim() || undefined)
      },
      onCancelClick: () => {
        options.tryUnlockDocumentAudio?.()
        state.errorText = null
        switchToLobby()
        options.leaveMatchmaking()
        render()
      },
      onProfileClick: () => {
        state.profilePopupProfile = null
        state.profilePopupCanEdit = true
        state.profilePopupOpen = true
        render()
      },
      onProfileClose: () => {
        state.profilePopupOpen = false
        state.profilePopupProfile = null
        state.profilePopupCanEdit = true
        render()
      },
      onProfileEditClick: () => {
        state.profileEditorOpen = true
        state.profileEditorErrorText = null
        state.profilePopupOpen = false
        render()
      },
      onProfileEditClose: () => {
        state.profileEditorOpen = false
        state.profileEditorErrorText = null
        render()
      },
      onProfileEditSubmit: (avatarFile, avatarCrop, galleryFiles) => {
        void submitProfileEdit(avatarFile, avatarCrop, galleryFiles)
      },
      onProfileGalleryDelete: (imageId) => {
        void deleteProfileGalleryImage(imageId)
      },
      onProfileNameChangeSubmit: (displayName) => {
        void submitProfileNameChange(displayName)
      },
      onLobbyClick: () => {
        switchToLobby()
        render()
      },
      onPlayersClick: () => {
        void showPlayersDirectory()
      },
      onShopClick: () => {
        void showShopPanel()
      },
      onShopPurchaseClick: (packageId) => {
        void startShopPurchase(packageId)
      },
      onLeaderboardsClick: () => {
        void showLeaderboardsDirectory()
      },
      onLeaderboardCategoryClick: (category) => {
        state.activeLeaderboardCategory = category
        render()
      },
      onAdminClick: () => {
        void showAdminPanel()
      },
      onAdminSettingsSubmit: (settings) => {
        void submitAdminSettings(settings)
      },
      onAdminCoinPackageSubmit: (input) => {
        void submitAdminCoinPackage(input)
      },
      onAdminCoinPackageStatusChange: (packageId, status) => {
        void setAdminCoinPackageStatus(packageId, status)
      },
      onFriendsClick: () => {
        void showFriendsDirectory()
      },
      onChatClick: () => {
        void showChatPanel()
      },
      onChatConversationClick: (friendshipId) => {
        void openChatConversation(friendshipId)
      },
      onChatSubmit: (friendshipId, body) => {
        void sendChatMessage(friendshipId, body)
      },
      onPlayerCardClick: (profile) => {
        state.profilePopupProfile = profile
        state.profilePopupCanEdit = false
        state.profilePopupOpen = true
        render()
        void ensureFriendshipsLoaded()
      },
      onLeaderboardPlayerClick: (profile) => {
        state.profilePopupProfile = profile
        state.profilePopupCanEdit = false
        state.profilePopupOpen = true
        render()
        void ensureFriendshipsLoaded()
      },
      onFriendProfileClick: (profile) => {
        state.profilePopupProfile = profile
        state.profilePopupCanEdit = false
        state.profilePopupOpen = true
        render()
      },
      onFriendRequestClick: (profileId) => {
        void submitFriendRequest(profileId)
      },
      onFriendBlockClick: (profileId) => {
        void blockFriendProfile(profileId)
      },
      onFriendAcceptClick: (friendshipId) => {
        void acceptFriendRequest(friendshipId)
      },
      onFriendRejectClick: (friendshipId) => {
        void rejectFriendRequest(friendshipId)
      },
      onFriendRemoveClick: (friendshipId) => {
        void removeFriendRelationship(friendshipId)
      },
      onGiftCoinsClick: (friendshipId) => {
        openGiftModal(friendshipId)
      },
      onGiftCoinsClose: () => {
        closeGiftModal()
      },
      onGiftCoinsSubmit: (friendshipId, amount) => {
        void submitGiftCoins(friendshipId, amount)
      },
      onAuthModalClose: () => {
        state.authModalMode = 'closed'
        state.authErrorText = null
        render()
      },
      onAuthModeChange: (mode) => {
        state.authModalMode = mode
        state.authErrorText = null
        render()
      },
      onLoginSubmit: (email, password) => {
        void submitLogin(email, password)
      },
      onRegisterSubmit: (displayName, email, password) => {
        void submitRegister(displayName, email, password)
      },
    })
  }

  async function submitProfileEdit(
    avatarFile: File | null,
    avatarCrop: AvatarCropSelection | null,
    galleryFiles: File[],
  ): Promise<void> {
    const errorText = options.onProfileEditSubmit
      ? await options.onProfileEditSubmit(avatarFile, avatarCrop, galleryFiles)
      : 'Редакцията временно не е налична.'

    if (errorText !== null) {
      state.profileEditorErrorText = errorText
      render()
      return
    }

    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }

    state.profileEditorOpen = false
    state.profileEditorErrorText = null
    state.profilePopupOpen = true
    render()
  }

  async function submitProfileNameChange(displayName: string): Promise<void> {
    const errorText = options.onProfileNameChangeSubmit
      ? await options.onProfileNameChangeSubmit(displayName)
      : 'Смяната на име временно не е налична.'

    if (errorText !== null) {
      state.profileEditorErrorText = errorText
      render()
      return
    }

    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }

    state.profileEditorErrorText = null
    render()
  }

  async function deleteProfileGalleryImage(imageId: string): Promise<void> {
    const errorText = options.onProfileGalleryDelete
      ? await options.onProfileGalleryDelete(imageId)
      : 'Изтриването на снимки временно не е налично.'

    if (errorText !== null) {
      state.profileEditorErrorText = errorText
      render()
      return
    }

    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }

    state.profileEditorErrorText = null
    render()
  }

  async function showPlayersDirectory(): Promise<void> {
    state.currentScreen = 'players'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    if (!options.onPlayersLoad) {
      state.playersErrorText = 'Списъкът с играчи временно не е наличен.'
      render()
      return
    }

    state.playersLoading = true
    state.playersErrorText = null
    render()

    const result = await options.onPlayersLoad()

    if (state.currentScreen !== 'players') {
      return
    }

    state.playersLoading = false

    if (!result.ok) {
      state.playersErrorText = result.message
      render()
      return
    }

    state.players = result.players
    state.playersErrorText = null
    render()
  }

  async function showLeaderboardsDirectory(): Promise<void> {
    state.currentScreen = 'leaderboards'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    if (!options.onLeaderboardsLoad) {
      state.leaderboardsErrorText = 'Класациите временно не са налични.'
      render()
      return
    }

    state.leaderboardsLoading = true
    state.leaderboardsErrorText = null
    render()

    const result = await options.onLeaderboardsLoad()

    if (state.currentScreen !== 'leaderboards') {
      return
    }

    state.leaderboardsLoading = false

    if (!result.ok) {
      state.leaderboardsErrorText = result.message
      render()
      return
    }

    state.leaderboards = result.leaderboards
    state.leaderboardsErrorText = null
    render()
  }

  async function showShopPanel(): Promise<void> {
    state.currentScreen = 'shop'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    if (!options.onShopPackagesLoad) {
      state.shopPackagesErrorText = 'Магазинът временно не е наличен.'
      render()
      return
    }

    state.shopPackagesLoading = true
    state.shopPurchasesLoading =
      (options.getAuthSession?.() ?? null) !== null && Boolean(options.onShopPurchasesLoad)
    state.shopPackagesErrorText = null
    state.shopPurchaseMessageText = null
    render()

    const result = await options.onShopPackagesLoad()

    if (state.currentScreen !== 'shop') {
      return
    }

    state.shopPackagesLoading = false

    if (!result.ok) {
      state.shopPackagesErrorText = result.message
      state.shopPurchasesLoading = false
      render()
      return
    }

    state.shopPackages = result.packages
    state.shopPackagesErrorText = null
    render()

    await loadShopPurchases()
  }

  async function loadShopPurchases(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (state.currentScreen !== 'shop') {
      return
    }

    if (authSession === null) {
      state.shopPurchases = []
      state.shopPurchasesLoading = false
      render()
      return
    }

    if (!options.onShopPurchasesLoad) {
      state.shopPurchasesLoading = false
      render()
      return
    }

    state.shopPurchasesLoading = true
    render()

    const result = await options.onShopPurchasesLoad()

    if (state.currentScreen !== 'shop') {
      return
    }

    state.shopPurchasesLoading = false

    if (!result.ok) {
      state.shopPurchaseMessageText = result.message
      render()
      return
    }

    state.shopPurchases = result.purchases
    render()
  }

  async function startShopPurchase(packageId: string): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    if (!options.onShopPurchaseStart) {
      state.shopPurchaseMessageText = 'Покупките временно не са налични.'
      render()
      return
    }

    state.shopPurchaseActionPackageId = packageId
    state.shopPurchaseMessageText = null
    render()

    const result = await options.onShopPurchaseStart(packageId)

    state.shopPurchaseActionPackageId = null

    if (!result.ok) {
      state.shopPurchaseMessageText = result.message
      render()
      return
    }

    state.shopPurchases = result.purchases
    state.shopPurchaseMessageText = result.message
    render()
  }

  async function showAdminPanel(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession?.account.role !== 'admin') {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до админ панела.'
      render()
      return
    }

    state.currentScreen = 'admin'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    if (!options.onAdminSettingsLoad) {
      state.adminSettingsErrorText = 'Админ настройките временно не са налични.'
      render()
      return
    }

    state.adminSettingsLoading = true
    state.adminSettingsErrorText = null
    state.adminCoinPackagesLoading = Boolean(options.onAdminCoinPackagesLoad)
    state.adminCoinPackagesErrorText = null
    render()

    const result = await options.onAdminSettingsLoad()

    if (state.currentScreen !== 'admin') {
      return
    }

    state.adminSettingsLoading = false

    if (!result.ok) {
      state.adminSettingsErrorText = result.message
      state.adminCoinPackagesLoading = false
      render()
      return
    }

    state.adminSettings = result.settings
    state.adminSettingsErrorText = null
    render()

    await loadAdminCoinPackages()
  }

  async function submitAdminSettings(settings: AdminSettingsSnapshot): Promise<void> {
    if (!options.onAdminSettingsSubmit) {
      state.adminSettingsErrorText = 'Админ настройките временно не са налични.'
      render()
      return
    }

    state.adminSettingsErrorText = null
    render()

    const result = await options.onAdminSettingsSubmit(settings)

    if (!result.ok) {
      state.adminSettingsErrorText = result.message
      render()
      return
    }

    state.adminSettings = result.settings
    state.adminSettingsErrorText = null
    render()
  }

  async function loadAdminCoinPackages(): Promise<void> {
    if (state.currentScreen !== 'admin') {
      return
    }

    if (!options.onAdminCoinPackagesLoad) {
      state.adminCoinPackagesLoading = false
      state.adminCoinPackagesErrorText = 'Админ пакетите временно не са налични.'
      render()
      return
    }

    state.adminCoinPackagesLoading = true
    state.adminCoinPackagesErrorText = null
    render()

    const result = await options.onAdminCoinPackagesLoad()

    if (state.currentScreen !== 'admin') {
      return
    }

    state.adminCoinPackagesLoading = false

    if (!result.ok) {
      state.adminCoinPackagesErrorText = result.message
      render()
      return
    }

    state.adminCoinPackages = result.packages
    state.adminCoinPackagesErrorText = null
    render()
  }

  async function submitAdminCoinPackage(input: CoinPackageInput): Promise<void> {
    if (!options.onAdminCoinPackageSubmit) {
      state.adminCoinPackagesErrorText = 'Записът на пакети временно не е наличен.'
      render()
      return
    }

    state.adminCoinPackagesErrorText = null
    render()

    const result = await options.onAdminCoinPackageSubmit(input)

    if (!result.ok) {
      state.adminCoinPackagesErrorText = result.message
      render()
      return
    }

    state.adminCoinPackages = result.packages
    state.adminCoinPackagesErrorText = null
    render()
  }

  async function setAdminCoinPackageStatus(
    packageId: string,
    status: CoinPackageStatus,
  ): Promise<void> {
    if (!options.onAdminCoinPackageStatusChange) {
      state.adminCoinPackagesErrorText = 'Промяната на статус временно не е налична.'
      render()
      return
    }

    state.adminCoinPackagesErrorText = null
    render()

    const result = await options.onAdminCoinPackageStatusChange(packageId, status)

    if (!result.ok) {
      state.adminCoinPackagesErrorText = result.message
      render()
      return
    }

    state.adminCoinPackages = result.packages
    state.adminCoinPackagesErrorText = null
    render()
  }

  async function ensureFriendshipsLoaded(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null || !options.onFriendshipsLoad) {
      return
    }

    const result = await options.onFriendshipsLoad()

    if (!result.ok) {
      state.friendsErrorText = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    render()
  }

  async function showFriendsDirectory(): Promise<void> {
    state.currentScreen = 'friends'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.currentScreen = 'lobby'
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    if (!options.onFriendshipsLoad) {
      state.friendsErrorText = 'Панелът с приятели временно не е наличен.'
      render()
      return
    }

    state.friendsLoading = true
    state.friendsErrorText = null
    render()

    const result = await options.onFriendshipsLoad()

    if (state.currentScreen !== 'friends') {
      return
    }

    state.friendsLoading = false

    if (!result.ok) {
      state.friendsErrorText = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    render()
  }

  async function submitFriendRequest(profileId: string): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.authModalMode = 'cta'
      state.authErrorText = null
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = null
      render()
      return
    }

    if (!options.onFriendRequestSubmit) {
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = 'Поканите временно не са налични.'
      render()
      return
    }

    state.friendActionLoadingProfileId = profileId
    state.friendActionMessageProfileId = profileId
    state.friendActionMessage = null
    render()

    const result = await options.onFriendRequestSubmit(profileId)

    state.friendActionLoadingProfileId = null

    if (!result.ok) {
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendActionMessageProfileId = profileId
    state.friendActionMessage = 'Поканата е изпратена.'
    render()
  }

  async function acceptFriendRequest(friendshipId: string): Promise<void> {
    const result = options.onFriendAccept
      ? await options.onFriendAccept(friendshipId)
      : { ok: false as const, message: 'Поканите временно не са налични.' }

    if (!result.ok) {
      state.friendsErrorText = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    render()
  }

  async function rejectFriendRequest(friendshipId: string): Promise<void> {
    const result = options.onFriendReject
      ? await options.onFriendReject(friendshipId)
      : { ok: false as const, message: 'Поканите временно не са налични.' }

    if (!result.ok) {
      state.friendsErrorText = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    render()
  }

  async function removeFriendRelationship(friendshipId: string): Promise<void> {
    const result = options.onFriendRemove
      ? await options.onFriendRemove(friendshipId)
      : { ok: false as const, message: 'Премахването временно не е налично.' }

    if (!result.ok) {
      state.friendsErrorText = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    render()
  }

  async function blockFriendProfile(profileId: string): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    const result = options.onFriendBlock
      ? await options.onFriendBlock(profileId)
      : { ok: false as const, message: 'Блокирането временно не е налично.' }

    if (!result.ok) {
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendActionMessageProfileId = profileId
    state.friendActionMessage = 'Играчът е блокиран.'
    render()
  }

  function openGiftModal(friendshipId: string): void {
    const relationships = state.friendships
      ? [
          ...state.friendships.friends,
          ...state.friendships.incomingPending,
          ...state.friendships.outgoingPending,
        ]
      : []
    const relationship = relationships.find((item) => {
      return item.friendshipId === friendshipId
    })

    state.giftModalFriendshipId = friendshipId
    state.giftModalFriendName = relationship?.profile.displayName ?? 'приятел'
    state.giftModalErrorText = null
    render()
  }

  function closeGiftModal(): void {
    state.giftModalFriendshipId = null
    state.giftModalFriendName = ''
    state.giftModalErrorText = null
    render()
  }

  async function submitGiftCoins(
    friendshipId: string,
    amount: number,
  ): Promise<void> {
    if (!options.onGiftCoinsSubmit) {
      state.giftModalErrorText = 'Подаряването временно не е налично.'
      render()
      return
    }

    const result = await options.onGiftCoinsSubmit(friendshipId, amount)

    if (!result.ok) {
      state.giftModalErrorText = result.message
      render()
      return
    }

    state.giftModalFriendshipId = null
    state.giftModalFriendName = ''
    state.giftModalErrorText = null
    state.profilePopupProfile = result.recipientProfile
    state.friendActionMessageProfileId = result.recipientProfile.profileId
    state.friendActionMessage = `Подаръкът от ${amount} жълтици е изпратен.`
    render()
  }

  async function loadChatConversations(): Promise<boolean> {
    if (!options.onChatConversationsLoad) {
      state.chatErrorText = 'Чатът временно не е наличен.'
      return false
    }

    const result = await options.onChatConversationsLoad()

    if (!result.ok) {
      state.chatErrorText = result.message
      return false
    }

    state.chatConversations = result.conversations
    state.chatErrorText = null

    if (
      state.activeChatFriendshipId !== null &&
      !state.chatConversations.some((conversation) => {
        return conversation.friendshipId === state.activeChatFriendshipId
      })
    ) {
      state.activeChatFriendshipId = null
      state.chatMessages = []
    }

    return true
  }

  async function showChatPanel(): Promise<void> {
    state.currentScreen = 'chat'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.currentScreen = 'lobby'
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    state.chatLoading = true
    state.chatErrorText = null
    render()

    const loaded = await loadChatConversations()

    if (state.currentScreen !== 'chat') {
      return
    }

    state.chatLoading = false

    if (!loaded) {
      render()
      return
    }

    const firstConversation = state.chatConversations[0] ?? null

    if (firstConversation !== null && state.activeChatFriendshipId === null) {
      state.activeChatFriendshipId = firstConversation.friendshipId
      await openChatConversation(firstConversation.friendshipId, false)
      return
    }

    render()
  }

  async function openChatConversation(
    friendshipId: string,
    shouldRenderLoading = true,
  ): Promise<void> {
    if (!options.onChatMessagesLoad) {
      state.chatErrorText = 'Чатът временно не е наличен.'
      render()
      return
    }

    state.activeChatFriendshipId = friendshipId
    state.chatMessagesLoading = true
    state.chatErrorText = null

    if (shouldRenderLoading) {
      render()
    }

    const result = await options.onChatMessagesLoad(friendshipId)

    if (state.activeChatFriendshipId !== friendshipId) {
      return
    }

    state.chatMessagesLoading = false

    if (!result.ok) {
      state.chatErrorText = result.message
      render()
      return
    }

    state.chatMessages = result.messages
    state.chatErrorText = null
    render()
  }

  async function sendChatMessage(
    friendshipId: string,
    body: string,
  ): Promise<void> {
    if (!options.onChatSend) {
      state.chatErrorText = 'Чатът временно не е наличен.'
      render()
      return
    }

    const result = await options.onChatSend(friendshipId, body)

    if (!result.ok) {
      state.chatErrorText = result.message
      render()
      return
    }

    state.chatMessages = result.messages
    state.chatErrorText = null
    state.activeChatFriendshipId = friendshipId
    state.chatConversations = [
      result.conversation,
      ...state.chatConversations.filter((conversation) => {
        return conversation.friendshipId !== result.conversation.friendshipId
      }),
    ]
    render()
  }

  async function refreshChatAfterNotification(friendshipId: string): Promise<void> {
    await loadChatConversations()

    if (
      state.currentScreen === 'chat' &&
      state.activeChatFriendshipId === friendshipId &&
      options.onChatMessagesLoad
    ) {
      const result = await options.onChatMessagesLoad(friendshipId)

      if (result.ok) {
        state.chatMessages = result.messages
        state.chatErrorText = null
      } else {
        state.chatErrorText = result.message
      }
    }

    render()
  }

  async function submitLogin(email: string, password: string): Promise<void> {
    const errorText = options.onLoginSubmit
      ? await options.onLoginSubmit(email.trim(), password)
      : 'Входът временно не е наличен.'

    if (errorText !== null) {
      state.authErrorText = errorText
      render()
      return
    }

    state.authModalMode = 'closed'
    state.authErrorText = null
    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }
    render()
  }

  async function submitRegister(
    displayName: string,
    email: string,
    password: string,
  ): Promise<void> {
    const errorText = options.onRegisterSubmit
      ? await options.onRegisterSubmit(displayName.trim(), email.trim(), password)
      : 'Регистрацията временно не е налична.'

    if (errorText !== null) {
      state.authErrorText = errorText
      render()
      return
    }

    state.authModalMode = 'closed'
    state.authErrorText = null
    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }
    render()
  }

  function startMatchmaking(stake: MatchStake, displayName?: string): void {
    state.selectedStake = stake

    if (displayName !== undefined) {
      state.displayName = displayName
    }

    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.currentScreen = 'lobby'
      state.isSearching = false
      state.errorText = null
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    state.displayName = authSession.profile.displayName

    if (!state.isConnected) {
      state.currentScreen = 'lobby'
      state.isSearching = false
      state.errorText = 'Няма връзка със сървъра.'
      render()
      return
    }

    state.errorText = null
    state.isSearching = true
    state.currentScreen = 'matchmaking-room'
    state.queuedPlayers = 1
    state.requiredPlayers = DEFAULT_REQUIRED_PLAYERS
    state.remainingMs = DEFAULT_COUNTDOWN_MS
    state.countdownEndsAt = Date.now() + DEFAULT_COUNTDOWN_MS
    state.serverPreviewBotDisplayNames = []
    clearServerRoomSnapshot()
    resetFinalFillSequence()

    options.joinMatchmaking(stake, state.displayName.trim() || undefined)

    startWaitingClockAudio()
    render()
  }

  function paintMatchmakingRoom(): void {
    const remainingMs = clamp(
      getLobbyRemainingMs(state) ?? DEFAULT_COUNTDOWN_MS,
      0,
      DEFAULT_COUNTDOWN_MS,
    )
    const displayedQueuedPlayers = getDisplayedQueuedPlayers()

    options.root.innerHTML = renderMatchmakingRoomScreen({
      prizeAmount: getStakePrizeAmount(state.selectedStake),
      entryAmount: state.selectedStake,
      localPlayer: createDisplayedLocalPlayer(),
      joinedPlayers: createDisplayedJoinedPlayers(),
      countdownRemainingMs: remainingMs,
      countdownTotalMs: DEFAULT_COUNTDOWN_MS,
      statusText: getRoomStatusText(state, displayedQueuedPlayers),
      canLeave: state.queuedPlayers <= 1,
    })

    const cancelButtons = options.root.querySelectorAll<HTMLButtonElement>(
      '[data-matchmaking-room-cancel-button="1"]',
    )

    cancelButtons.forEach((cancelButton) => {
      cancelButton.addEventListener('click', () => {
        if (state.queuedPlayers > 1) return
        options.tryUnlockDocumentAudio?.()
        state.errorText = null
        switchToLobby()
        options.leaveMatchmaking()
        render()
      })
    })

    syncLiveCountdownTargets()
    updateMatchmakingRoomLiveUi()
    syncSeatFillSounds(displayedQueuedPlayers)
  }

  function startLiveCountdownLoop(): void {
    clearUiTickLoop()

    if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
      return
    }

    const frameStep = (): void => {
      countdownAnimationFrameId = null

      if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
        return
      }

      const fillSequenceChanged = updateFinalFillSequenceProgress()

      if (fillSequenceChanged) {
        paintMatchmakingRoom()
      } else {
        const shouldContinue = updateMatchmakingRoomLiveUi()

        if (!shouldContinue) {
          return
        }
      }

      countdownAnimationFrameId = window.requestAnimationFrame(frameStep)
    }

    countdownAnimationFrameId = window.requestAnimationFrame(frameStep)
  }

  function renderMatchmakingRoom(): void {
    paintMatchmakingRoom()
    startLiveCountdownLoop()
  }

  function render(): void {
    if (state.currentScreen === 'matchmaking-room') {
      renderMatchmakingRoom()
      return
    }

    renderLobby()
  }

  function resetToLobby(): void {
    switchToLobby()
    render()
  }

  function handleServerMessage(message: ServerMessage): boolean {
    if (message.type === 'connected') {
      state.errorText = null
      render()
      return true
    }

    if (message.type === 'error') {
      state.errorText = message.message
      render()
      return true
    }

    if (message.type === 'matchmaking_joined') {
      state.currentScreen = 'matchmaking-room'
      state.isSearching = true
      state.selectedStake = message.stake
      state.queuedPlayers = message.queuedPlayers
      state.requiredPlayers = message.requiredPlayers
      state.remainingMs = message.remainingMs
      state.countdownEndsAt = message.countdownEndsAt
      state.errorText = null
      state.serverPreviewBotDisplayNames = message.previewBotDisplayNames ?? []
      startWaitingClockAudio()
      render()
      return true
    }

    if (message.type === 'matchmaking_status') {
      state.currentScreen = 'matchmaking-room'
      state.isSearching = true
      state.selectedStake = message.stake
      state.queuedPlayers = message.queuedPlayers
      state.requiredPlayers = message.requiredPlayers
      state.remainingMs = message.remainingMs
      state.countdownEndsAt = message.countdownEndsAt
      state.errorText = null
      state.serverPreviewBotDisplayNames = message.previewBotDisplayNames ?? []
      startWaitingClockAudio()

      if (message.localStakeDeducted === true && stakeEffectStartedAt === null) {
        if (message.queuedPlayers >= 2) {
          stakeEffectStartedAt = Date.now()
          showStakeDeductionEffect(message.stake)
        } else if (finalFillSequenceStartedAt !== null) {
          stakeEffectStartedAt = Date.now()
          showStakeDeductionEffect(message.stake)
        } else {
          pendingStakeEffect = true
        }
      }

      render()
      return true
    }

    if (message.type === 'matchmaking_left') {
      state.errorText = null
      resetToLobby()
      return true
    }

    if (message.type === 'room_snapshot') {
      if (message.roomStatus !== 'waiting') {
        return false
      }

      const occupiedSeatsCount = countOccupiedSeats(message.seats)
      const requiredPlayers = message.seats.length || DEFAULT_REQUIRED_PLAYERS

      state.currentScreen = 'matchmaking-room'
      state.isSearching = true
      state.queuedPlayers = occupiedSeatsCount
      state.requiredPlayers = requiredPlayers
      state.errorText = null
      state.serverRoomSeats = message.seats
      state.serverYourSeat = message.yourSeat

      if (pendingMatchFoundMessage !== null && occupiedSeatsCount >= requiredPlayers) {
        flushPendingMatchFound()
        return true
      }

      clearFinalFillAnimationState()
      clearPendingMatchFoundTimeout()

      if (occupiedSeatsCount >= requiredPlayers) {
        stopWaitingClockAudio()
      } else {
        startWaitingClockAudio()
      }

      render()
      return true
    }

    if (message.type === 'match_found') {
      pendingMatchFoundMessage = message

      if (finalFillSequenceStartedAt !== null) {
        state.remainingMs = 0
        state.countdownEndsAt = Date.now()
        maybeSchedulePendingMatchFound()
        return true
      }

      flushPendingMatchFound()
      return true
    }

    if (message.type === 'chat_message_received') {
      void refreshChatAfterNotification(message.friendshipId)
      return true
    }

    return false
  }

  return {
    render,
    destroy: () => {
      stopWaitingRoomActivity()
      clearServerRoomSnapshot()
      resetFinalFillSequence()
    },
    getCurrentScreen: () => state.currentScreen,
    setConnected: (value) => {
      state.isConnected = value
      render()
    },
    setDisplayName: (value) => {
      state.displayName = value
      render()
    },
    setErrorText: (value) => {
      state.errorText = value
      render()
    },
    setLocalAvatarUrl: (value) => {
      state.localAvatarUrl = value
      render()
    },
    setFriendships: (value) => {
      state.friendships = value
      state.friendsErrorText = null
      render()
    },
    setChatConversations: (value) => {
      state.chatConversations = value
      state.chatErrorText = null
      if (
        state.activeChatFriendshipId !== null &&
        !value.some((conversation) => {
          return conversation.friendshipId === state.activeChatFriendshipId
        })
      ) {
        state.activeChatFriendshipId = null
        state.chatMessages = []
      }
      render()
    },
    startMatchmaking,
    resetToLobby,
    handleServerMessage,
    navigateToShop: (noticeText: string | null) => {
      void showShopPanel().then(() => {
        if (noticeText !== null && state.currentScreen === 'shop') {
          state.shopPurchaseMessageText = noticeText
          render()
        }
      })
    },
  }
}
