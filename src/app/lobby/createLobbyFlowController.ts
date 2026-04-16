import {
  renderMatchmakingRoomScreen,
  type MatchmakingRoomPlayer,
} from './renderMatchmakingRoomScreen'
import {
  renderLobbyScreen,
  type LobbyScreenState,
} from './renderLobbyScreen'
import type {
  MatchFoundMessage,
  MatchStake,
  ServerMessage,
} from '../network/createGameServerClient'

export type LobbyFlowScreen = 'lobby' | 'matchmaking-room'

export type CreateLobbyFlowControllerOptions = {
  root: HTMLElement
  joinMatchmaking: (stake: MatchStake, displayName?: string) => void
  leaveMatchmaking: () => void
  onMatchFound: (message: MatchFoundMessage) => void
  tryUnlockDocumentAudio?: () => void
}

export type LobbyFlowController = {
  render: () => void
  destroy: () => void
  getCurrentScreen: () => LobbyFlowScreen
  setConnected: (value: boolean) => void
  setDisplayName: (value: string) => void
  setErrorText: (value: string | null) => void
  setLocalAvatarUrl: (value: string | null) => void
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

const AUTO_FILL_NAME_PREFIXES = [
  'Mody',
  'Moby',
  'Nexo',
  'Rexo',
  'Viper',
  'Rado',
  'Kiro',
  'Toni',
  'Miro',
  'Zed',
  'Lory',
  'Bora',
  'Niki',
  'A',
  'B',
  'X',
  'Q',
  'R',
] as const

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

function createRandomDigits(length: number): string {
  let result = ''

  for (let index = 0; index < length; index += 1) {
    result += String(Math.floor(Math.random() * 10))
  }

  return result
}

function createAutoFillPreviewPlayer(index: number): MatchmakingRoomPlayer {
  const prefix = AUTO_FILL_NAME_PREFIXES[index % AUTO_FILL_NAME_PREFIXES.length]
  const digitsLength = 8 + (index % 2)
  const digits = createRandomDigits(digitsLength)

  return {
    id: `autofill-preview-${Date.now()}-${index}-${digits}`,
    name: `${prefix}${digits}`,
    avatarUrl: null,
    isBot: false,
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

  function ensureAutoFillPreviewPlayersCount(count: number): void {
    while (autoFillPreviewPlayers.length < count) {
      autoFillPreviewPlayers.push(
        createAutoFillPreviewPlayer(autoFillPreviewPlayers.length),
      )
    }

    if (autoFillPreviewPlayers.length > count) {
      autoFillPreviewPlayers = autoFillPreviewPlayers.slice(0, count)
    }
  }

  function resetFinalFillSequence(): void {
    finalFillSequenceStartedAt = null
    finalFillBaseQueuedPlayers = null
    finalFillAnimatedQueuedPlayers = null
    pendingMatchFoundMessage = null
    clearPendingMatchFoundTimeout()
    resetAutoFillPreviewPlayers()
    resetSeatFillSoundTracking()
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
    if (finalFillAnimatedQueuedPlayers !== null) {
      return Math.max(state.queuedPlayers, finalFillAnimatedQueuedPlayers)
    }

    return state.queuedPlayers
  }

  function createDisplayedJoinedPlayers(): MatchmakingRoomPlayer[] {
    const displayedQueuedPlayers = getDisplayedQueuedPlayers()
    const totalOtherSeats = Math.max(0, displayedQueuedPlayers - 1)
    const actualOtherPlayers = Math.max(0, state.queuedPlayers - 1)
    const normalizedLocalName = state.displayName.trim() || 'Играч'
    const autoFillCount = Math.max(0, totalOtherSeats - actualOtherPlayers)

    ensureAutoFillPreviewPlayersCount(autoFillCount)

    const actualPlayers = Array.from({ length: actualOtherPlayers }, (_, index) => ({
      id: `queued-preview-${index + 1}`,
      name:
        index === 0 && normalizedLocalName === 'Играч'
          ? 'Играч'
          : `Играч ${index + 2}`,
      avatarUrl: null,
      isBot: false,
    }))

    return [...actualPlayers, ...autoFillPreviewPlayers.slice(0, autoFillCount)]
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
    const progressPercent = (remainingMs / DEFAULT_COUNTDOWN_MS) * 100

    if (lastRenderedCountdownSecond !== countdownSeconds) {
      countdownTextElement.textContent = `${countdownSeconds} сек.`
      lastRenderedCountdownSecond = countdownSeconds
    }

    progressBarElement.style.transition = 'none'
    progressBarElement.style.width = `${progressPercent}%`

    return true
  }

  function maybeStartFinalFillSequence(): void {
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
      const matchFoundMessage = pendingMatchFoundMessage

      pendingMatchFoundTimeoutId = null
      pendingMatchFoundMessage = null
      state.isSearching = false
      state.queuedPlayers = 0
      state.requiredPlayers = DEFAULT_REQUIRED_PLAYERS
      state.remainingMs = null
      state.countdownEndsAt = null
      stopWaitingRoomActivity()
      resetFinalFillSequence()

      if (matchFoundMessage) {
        options.onMatchFound(matchFoundMessage)
      }
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

    const lobbyState: LobbyScreenState = {
      displayName: state.displayName,
      selectedStake: state.selectedStake,
      isConnected: state.isConnected,
      isSearching: state.isSearching,
      queuedPlayers: state.queuedPlayers,
      requiredPlayers: state.requiredPlayers,
      remainingMs: getLobbyRemainingMs(state),
      statusText: getLobbyStatusText(state),
      errorText: state.errorText,
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

        if (!state.isConnected) {
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
        resetFinalFillSequence()

        options.joinMatchmaking(
          state.selectedStake,
          state.displayName.trim() || undefined,
        )

        startWaitingClockAudio()
        render()
      },
      onCancelClick: () => {
        options.tryUnlockDocumentAudio?.()
        state.errorText = null
        switchToLobby()
        options.leaveMatchmaking()
        render()
      },
    })
  }

  function paintMatchmakingRoom(): void {
    const remainingMs = clamp(
      getLobbyRemainingMs(state) ?? DEFAULT_COUNTDOWN_MS,
      0,
      DEFAULT_COUNTDOWN_MS,
    )
    const displayedQueuedPlayers = getDisplayedQueuedPlayers()

    options.root.innerHTML = `
      ${renderMatchmakingRoomScreen({
        prizeAmount: getStakePrizeAmount(state.selectedStake),
        entryAmount: state.selectedStake,
        localPlayer: {
          id: 'local-player',
          name: state.displayName.trim() || 'Играч',
          avatarUrl: state.localAvatarUrl,
        },
        joinedPlayers: createDisplayedJoinedPlayers(),
        countdownRemainingMs: remainingMs,
        countdownTotalMs: DEFAULT_COUNTDOWN_MS,
        statusText: getRoomStatusText(state, displayedQueuedPlayers),
      })}
      <button
        type="button"
        data-matchmaking-room-cancel-button="1"
        style="
          position:fixed;
          top:20px;
          right:20px;
          z-index:50;
          border:0;
          border-radius:16px;
          padding:14px 18px;
          background:linear-gradient(180deg, #8b5cf6 0%, #6d28d9 100%);
          color:#f5f3ff;
          font-size:15px;
          font-weight:900;
          cursor:pointer;
          box-shadow:0 14px 32px rgba(76,29,149,0.30);
        "
      >
        Откажи търсенето
      </button>
    `

    const cancelButton = options.root.querySelector<HTMLButtonElement>(
      '[data-matchmaking-room-cancel-button="1"]',
    )

    cancelButton?.addEventListener('click', () => {
      options.tryUnlockDocumentAudio?.()
      state.errorText = null
      switchToLobby()
      options.leaveMatchmaking()
      render()
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
      startWaitingClockAudio()
      render()
      return true
    }

    if (message.type === 'matchmaking_left') {
      state.errorText = null
      resetToLobby()
      return true
    }

    if (message.type === 'match_found') {
      if (finalFillSequenceStartedAt !== null) {
        pendingMatchFoundMessage = message
        state.remainingMs = 0
        state.countdownEndsAt = Date.now()
        maybeSchedulePendingMatchFound()
        return true
      }

      state.isSearching = false
      state.queuedPlayers = 0
      state.requiredPlayers = DEFAULT_REQUIRED_PLAYERS
      state.remainingMs = null
      state.countdownEndsAt = null
      stopWaitingRoomActivity()
      resetFinalFillSequence()
      options.onMatchFound(message)
      return true
    }

    return false
  }

  return {
    render,
    destroy: () => {
      stopWaitingRoomActivity()
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
    resetToLobby,
    handleServerMessage,
  }
}