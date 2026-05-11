import {
  renderMatchmakingRoomScreen,
  type MatchmakingRoomPlayer,
} from './renderMatchmakingRoomScreen'
import {
  renderLobbyScreen,
  type AvatarCropSelection,
  type LobbyAuthModalMode,
  type LobbyScreenState,
} from './renderLobbyScreen'
import type {
  MatchFoundMessage,
  MatchStake,
  PlayerPublicProfileSnapshot,
  RoomSeatSnapshot,
  ServerMessage,
} from '../network/createGameServerClient'

export type LobbyFlowScreen = 'lobby' | 'players' | 'matchmaking-room'

export type LobbyAuthSession = {
  profile: PlayerPublicProfileSnapshot
}

export type CreateLobbyFlowControllerOptions = {
  root: HTMLElement
  joinMatchmaking: (stake: MatchStake, displayName?: string) => void
  leaveMatchmaking: () => void
  onMatchFound: (message: MatchFoundMessage) => void
  tryUnlockDocumentAudio?: () => void
  getAuthSession?: () => LobbyAuthSession | null
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
  onPlayersLoad?: () => Promise<
    | { ok: true; players: PlayerPublicProfileSnapshot[] }
    | { ok: false; message: string }
  >
}

export type LobbyFlowController = {
  render: () => void
  destroy: () => void
  getCurrentScreen: () => LobbyFlowScreen
  setConnected: (value: boolean) => void
  setDisplayName: (value: string) => void
  setErrorText: (value: string | null) => void
  setLocalAvatarUrl: (value: string | null) => void
  startMatchmaking: (stake: MatchStake, displayName?: string) => void
  resetToLobby: () => void
  handleServerMessage: (message: ServerMessage) => boolean
}

type InternalLobbyFlowState = {
  currentScreen: LobbyFlowScreen
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
    resetAutoFillPreviewPlayers()
    resetSeatFillSoundTracking()
  }

  function resetFinalFillSequence(): void {
    clearFinalFillAnimationState()
    pendingMatchFoundMessage = null
    clearPendingMatchFoundTimeout()
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

    options.onMatchFound(matchFoundMessage)
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

  function renderLobby(): void {
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    clearServerRoomSnapshot()

    const authSession = options.getAuthSession?.() ?? null
    const lobbyState: LobbyScreenState = {
      view: state.currentScreen === 'players' ? 'players' : 'tables',
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
      authModalMode: state.authModalMode,
      authErrorText: state.authErrorText,
      signupBonusYellowCoins: 100000,
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
      onLobbyClick: () => {
        switchToLobby()
        render()
      },
      onPlayersClick: () => {
        void showPlayersDirectory()
      },
      onPlayerCardClick: (profile) => {
        state.profilePopupProfile = profile
        state.profilePopupCanEdit = false
        state.profilePopupOpen = true
        render()
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
    })

    const cancelButtons = options.root.querySelectorAll<HTMLButtonElement>(
      '[data-matchmaking-room-cancel-button="1"]',
    )

    cancelButtons.forEach((cancelButton) => {
      cancelButton.addEventListener('click', () => {
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
    startMatchmaking,
    resetToLobby,
    handleServerMessage,
  }
}
