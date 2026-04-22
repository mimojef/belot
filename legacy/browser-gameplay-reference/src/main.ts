import './style.css'
import { bootstrapApp } from './app/bootstrap'
import { renderApp } from './app/renderApp'
import { createLobbyFlowController } from './app/lobby/createLobbyFlowController'
import { createBelotePromptController } from './app/playPrompts/createBelotePromptController'
import { pickBotBidAction } from './core/rules/pickBotBidAction'
import { pickBotCardToPlay } from './core/rules/pickBotCardToPlay'
import type { Seat } from './data/constants/seatOrder'
import type { BidAction, Card, GameState, Suit } from './core/state/gameTypes'
import { createGameAudioController } from './app/audio/createGameAudioController'
import { createPlayingTimerState } from './core/timers/timerStateHelpers'
import {
  createGameServerClient,
  type MatchStake,
  type PlayerPublicProfileSnapshot,
  type ServerMessage,
} from './app/network/createGameServerClient'
import { renderPlayerProfilePopup } from './ui/overlays/renderPlayerProfilePopup'

const rootElement = document.querySelector<HTMLDivElement>('#app')

if (!rootElement) {
  throw new Error('Root element #app was not found.')
}

const SILENT_AUDIO_UNLOCK_SRC =
  'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA'

type BidBubbleOverride = {
  entryKey: string
  seat: Seat
  label: string
}

type MatchEndedPlayerStatus = 'waiting' | 'reload' | 'find-new-game' | 'leave'

type CachedRoomSeatInfo = {
  displayName: string
  avatarUrl: string | null
  isOccupied: boolean
  isBot: boolean
}

type SeatPanelInfoForRender = {
  displayName: string | null
  avatarUrl: string | null
  isOccupied: boolean
  isInteractive: boolean
}

declare global {
  interface Window {
    belotServer?: {
      connect: () => void
      disconnect: () => void
      ping: () => void
      createRoom: (displayName?: string) => void
      joinRoom: (roomId: string, displayName?: string) => void
      joinMatchmaking: (stake: MatchStake, displayName?: string) => void
      leaveMatchmaking: () => void
      requestPlayerProfile: (roomId: string, seat: Seat) => void
      getLatestRoomId: () => string | null
      getLatestPlayerProfile: (seat: Seat) => PlayerPublicProfileSnapshot | null
    }
  }
}

const BOT_PLAY_DELAY_MS = 1000
const BOT_BIDDING_DELAY_MS = 1000
const FINAL_TRICK_CARD_FLIGHT_MS = 420
const FINAL_TRICK_CARD_HOLD_MS = 340
const TRICK_COLLECTION_GATHER_MS = 180
const TRICK_COLLECTION_FLY_MS = 420
const TRICK_COLLECTION_STAGGER_MS = 35
const TRICK_COLLECTION_MAX_STAGGER_STEPS = 3
const TRICK_COLLECTION_START_DELAY_MS =
  TRICK_COLLECTION_GATHER_MS +
  TRICK_COLLECTION_FLY_MS +
  TRICK_COLLECTION_STAGGER_MS * TRICK_COLLECTION_MAX_STAGGER_STEPS
const FLOATING_CARD_WIDTH = 148
const FLOATING_CARD_HEIGHT = 215
const CUTTING_COUNTDOWN_MS = 15000
const BIDDING_COUNTDOWN_MS = 15000
const PLAYING_COUNTDOWN_MS = 15000
const BOT_CUTTING_AUTO_SELECT_MS = 1000
const CUTTING_SELECTION_RESOLVE_MS = 500
const CUT_RESOLVE_AUTO_ADVANCE_MS = 0
const DEAL_FIRST_THREE_AUTO_ADVANCE_MS = 2000
const DEAL_NEXT_TWO_AUTO_ADVANCE_MS = 1900
const DEAL_LAST_THREE_AUTO_ADVANCE_MS = 2000
const NEXT_ROUND_AUTO_ADVANCE_MS = 1000
const SCORING_AUTO_ADVANCE_MS = 5000
const SCORING_TIMER_FUDGE_MS = 24
const MATCH_ENDED_BOT_RELOAD_STEP_MS = 500
const MATCH_ENDED_RESTART_AFTER_BOTS_MS = 250

const appRoot = rootElement
const app = bootstrapApp()
const gameAudio = createGameAudioController()

let latestServerRoomId: string | null = null
let latestServerRoomSeats: Partial<Record<Seat, CachedRoomSeatInfo>> = {}
let latestServerPlayerProfiles: Partial<Record<Seat, PlayerPublicProfileSnapshot | null>> = {}
let currentAppScreen: 'lobby' | 'game' = 'lobby'

let activePlayerProfileSeat: Seat | null = null
let isPlayerProfilePopupOpen = false
let isPlayerProfilePopupLoading = false
let playerProfileOverlayRoot: HTMLDivElement | null = null
let lastPlayerProfilePopupRenderSignature: string | null = null

let resizeFrameId: number | null = null
let botPlayTimeoutId: number | null = null
let botBidTimeoutId: number | null = null
let activeBotBidTurnKey: string | null = null
let activePlayingTurnKey: string | null = null
let activePlayingTurnStartedAt = 0
let activePlayingPausedRemainingMs: number | null = null
let activeCuttingTurnKey: string | null = null
let activeCuttingTurnStartedAt = 0
let cuttingAutoSelectTimeoutId: number | null = null
let cuttingResolveTimeoutId: number | null = null
let dealPhaseAutoAdvanceTimeoutId: number | null = null
let activeDealPhaseAutoAdvance: string | null = null
let scoringTickTimeoutId: number | null = null
let scoringAutoAdvanceTimeoutId: number | null = null
let isAnimatingFinalTrickCard = false
let activeFinalTrickAnimation: Animation | null = null
let activeFinalTrickFloatingCard: HTMLElement | null = null
let activeFinalTrickSourceElement: HTMLElement | null = null
let finalTrickHoldTimeoutId: number | null = null
let bottomBotTakeoverActive = false
let bidBubbleOverride: BidBubbleOverride | null = null
let matchEndedCoordinationTimeoutIds: number[] = []
let matchEndedPlayerStatuses: Partial<Record<Seat, MatchEndedPlayerStatus>> = {}
let audioUnlockListenersAttached = false
let audioUnlockedForDocument = false

function detachInitialAudioUnlockListeners(): void {
  if (!audioUnlockListenersAttached) {
    return
  }

  window.removeEventListener('pointerdown', handleInitialAudioUnlock, true)
  window.removeEventListener('mousedown', handleInitialAudioUnlock, true)
  window.removeEventListener('touchstart', handleInitialAudioUnlock, true)
  window.removeEventListener('keydown', handleInitialAudioUnlock, true)

  audioUnlockListenersAttached = false
}

function tryUnlockDocumentAudio(): void {
  if (audioUnlockedForDocument) {
    return
  }

  const audio = new Audio(SILENT_AUDIO_UNLOCK_SRC)
  audio.preload = 'auto'
  audio.muted = true
  audio.volume = 0

  void audio
    .play()
    .then(() => {
      audio.pause()
      audio.currentTime = 0
      audioUnlockedForDocument = true
      detachInitialAudioUnlockListeners()
    })
    .catch(() => {})
}

function handleInitialAudioUnlock(): void {
  tryUnlockDocumentAudio()
}

function attachInitialAudioUnlockListeners(): void {
  if (audioUnlockListenersAttached) {
    return
  }

  window.addEventListener('pointerdown', handleInitialAudioUnlock, true)
  window.addEventListener('mousedown', handleInitialAudioUnlock, true)
  window.addEventListener('touchstart', handleInitialAudioUnlock, true)
  window.addEventListener('keydown', handleInitialAudioUnlock, true)

  audioUnlockListenersAttached = true
}

function resetPlayerProfilePopupState(): void {
  activePlayerProfileSeat = null
  isPlayerProfilePopupOpen = false
  isPlayerProfilePopupLoading = false
}

function closePlayerProfilePopup(): void {
  resetPlayerProfilePopupState()
}

function getActivePlayerProfile(): PlayerPublicProfileSnapshot | null {
  if (!activePlayerProfileSeat) {
    return null
  }

  return latestServerPlayerProfiles[activePlayerProfileSeat] ?? null
}

function openPlayerProfilePopupForSeat(seat: Seat): void {
  activePlayerProfileSeat = seat
  isPlayerProfilePopupOpen = true
  isPlayerProfilePopupLoading = !(seat in latestServerPlayerProfiles)
}

function getPlayerProfileOverlayRoot(): HTMLDivElement {
  if (playerProfileOverlayRoot && playerProfileOverlayRoot.isConnected) {
    return playerProfileOverlayRoot
  }

  const overlayRoot = document.createElement('div')
  overlayRoot.setAttribute('data-player-profile-overlay-root', '1')
  overlayRoot.style.position = 'fixed'
  overlayRoot.style.inset = '0'
  overlayRoot.style.zIndex = '12000'
  overlayRoot.style.pointerEvents = 'none'

  document.body.appendChild(overlayRoot)
  playerProfileOverlayRoot = overlayRoot

  return overlayRoot
}

function getPlayerProfilePopupRenderSignature(): string {
  if (currentAppScreen !== 'game' || !isPlayerProfilePopupOpen) {
    return 'closed'
  }

  return JSON.stringify({
    isOpen: true,
    seat: activePlayerProfileSeat,
    isLoading: isPlayerProfilePopupLoading,
    profile: getActivePlayerProfile(),
  })
}

function bindPlayerProfilePopupEvents(): void {
  if (!playerProfileOverlayRoot) {
    return
  }

  const closeButton = playerProfileOverlayRoot.querySelector<HTMLElement>(
    '[data-player-profile-popup-close="1"]'
  )
  const backdrop = playerProfileOverlayRoot.querySelector<HTMLElement>(
    '[data-player-profile-popup-backdrop="1"]'
  )

  closeButton?.addEventListener('click', (event) => {
    event.preventDefault()
    closePlayerProfilePopup()
    renderPlayerProfilePopupOverlay()
  })

  backdrop?.addEventListener('click', (event) => {
    event.preventDefault()
    closePlayerProfilePopup()
    renderPlayerProfilePopupOverlay()
  })
}

function renderPlayerProfilePopupOverlay(force = false): void {
  const nextSignature = getPlayerProfilePopupRenderSignature()

  if (!force && lastPlayerProfilePopupRenderSignature === nextSignature) {
    return
  }

  const overlayRoot = getPlayerProfileOverlayRoot()
  lastPlayerProfilePopupRenderSignature = nextSignature

  if (nextSignature === 'closed') {
    overlayRoot.innerHTML = ''
    overlayRoot.style.pointerEvents = 'none'
    return
  }

  overlayRoot.innerHTML = renderPlayerProfilePopup({
    isOpen: true,
    seat: activePlayerProfileSeat,
    profile: getActivePlayerProfile(),
    isLoading: isPlayerProfilePopupLoading,
  })
  overlayRoot.style.pointerEvents = 'auto'

  bindPlayerProfilePopupEvents()
}

function resetLatestServerRoomCaches(): void {
  latestServerRoomSeats = {}
  latestServerPlayerProfiles = {}
  resetPlayerProfilePopupState()
  renderPlayerProfilePopupOverlay(true)
}

function createCachedRoomSeatMap(
  seats: Array<{
    seat: Seat
    displayName: string
    isOccupied: boolean
    isBot: boolean
    avatarUrl: string | null
  }>
): Partial<Record<Seat, CachedRoomSeatInfo>> {
  const nextMap: Partial<Record<Seat, CachedRoomSeatInfo>> = {}

  for (const seatInfo of seats) {
    nextMap[seatInfo.seat] = {
      displayName: seatInfo.displayName,
      avatarUrl: seatInfo.avatarUrl,
      isOccupied: seatInfo.isOccupied,
      isBot: seatInfo.isBot,
    }
  }

  return nextMap
}

function getSeatPanelInfosForRender(): Partial<Record<Seat, SeatPanelInfoForRender>> {
  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const nextInfos: Partial<Record<Seat, SeatPanelInfoForRender>> = {}

  for (const seat of seats) {
    const cachedSeat = latestServerRoomSeats[seat]
    const cachedProfile = latestServerPlayerProfiles[seat] ?? null
    const fallbackDisplayName = seat === 'bottom'
      ? 'ТИ'
      : seat === 'right'
        ? 'ДЯСНО'
        : seat === 'top'
          ? 'ГОРЕ'
          : 'ЛЯВО'

    nextInfos[seat] = {
      displayName:
        cachedProfile?.displayName ??
        cachedSeat?.displayName ??
        fallbackDisplayName,
      avatarUrl:
        cachedProfile?.avatarUrl ??
        cachedSeat?.avatarUrl ??
        null,
      isOccupied: cachedSeat?.isOccupied ?? true,
      isInteractive: (cachedSeat?.isOccupied ?? true) && currentAppScreen === 'game',
    }
  }

  return nextInfos
}

function handleGameServerMessage(message: ServerMessage): void {
  console.log('[game-server] message:', message)

  if (
    message.type === 'connected' ||
    message.type === 'error' ||
    message.type === 'matchmaking_joined' ||
    message.type === 'matchmaking_status' ||
    message.type === 'matchmaking_left' ||
    message.type === 'match_found' ||
    message.type === 'room_snapshot'
  ) {
    const wasHandledByLobbyFlow = lobbyFlowController.handleServerMessage(message)

    if (wasHandledByLobbyFlow) {
      return
    }
  }

  if (message.type === 'player_profile') {
    latestServerPlayerProfiles = {
      ...latestServerPlayerProfiles,
      [message.seat]: message.profile,
    }

    if (activePlayerProfileSeat === message.seat) {
      isPlayerProfilePopupOpen = true
      isPlayerProfilePopupLoading = false
      renderPlayerProfilePopupOverlay()
    }

    console.log('[game-server] player profile:', message.seat, message.profile)
    return
  }

  if (message.type === 'room_created') {
    latestServerRoomId = message.roomId
    resetLatestServerRoomCaches()
    currentAppScreen = 'game'
    console.log(
      `[game-server] room created: roomId=${message.roomId}, seat=${message.seat}, host=${message.hostDisplayName}`,
    )
    renderServerDebugPanel()
    return
  }

  if (message.type === 'room_joined') {
    latestServerRoomId = message.roomId
    resetLatestServerRoomCaches()
    currentAppScreen = 'game'
    console.log(
      `[game-server] room joined: roomId=${message.roomId}, seat=${message.seat}, displayName=${message.displayName}`,
    )
    renderServerDebugPanel()
    return
  }

  if (message.type === 'room_snapshot') {
    latestServerRoomId = message.roomId
    latestServerRoomSeats = createCachedRoomSeatMap(message.seats)
    console.log('[game-server] room snapshot seats:', message.seats)
    renderServerDebugPanel()
    return
  }

  if (message.type === 'error') {
    console.error('[game-server] error:', message.message)

    if (currentAppScreen === 'lobby') {
      lobbyFlowController.setErrorText(message.message)
      lobbyFlowController.render()
    }

    return
  }

  if (message.type === 'pong') {
    console.log('[game-server] pong at', new Date(message.timestamp).toISOString())
    renderServerDebugPanel()
  }
}

const gameServerClient = createGameServerClient({
  onOpen: () => {
    lobbyFlowController.setConnected(true)
    lobbyFlowController.setErrorText(null)
    renderServerDebugPanel()
  },
  onClose: () => {
    latestServerRoomId = null
    resetLatestServerRoomCaches()
    currentAppScreen = 'lobby'
    lobbyFlowController.setConnected(false)
    lobbyFlowController.resetToLobby()
    renderServerDebugPanel()
  },
  onError: (event) => {
    console.error('[game-server] socket error:', event)

    if (currentAppScreen === 'lobby') {
      lobbyFlowController.setErrorText('Socket error. Провери server терминала.')
    }
  },
  onMessage: (message) => {
    handleGameServerMessage(message)
  },
})

const lobbyFlowController = createLobbyFlowController({
  root: appRoot,
  joinMatchmaking: (stake, displayName) => {
    latestServerRoomId = null
    resetLatestServerRoomCaches()
    gameServerClient.joinMatchmaking(stake, displayName)
  },
  leaveMatchmaking: () => {
    gameServerClient.leaveMatchmaking()
  },
  onMatchFound: (message) => {
    latestServerRoomId = message.roomId
    resetLatestServerRoomCaches()
    currentAppScreen = 'game'
    render()
  },
  tryUnlockDocumentAudio,
})

function renderServerDebugPanel(): void {
  render()
}

function exposeGameServerDebugApi(): void {
  window.belotServer = {
    connect: () => {
      gameServerClient.connect()
    },
    disconnect: () => {
      gameServerClient.disconnect()
    },
    ping: () => {
      gameServerClient.ping()
    },
    createRoom: (displayName?: string) => {
      gameServerClient.createRoom(displayName)
    },
    joinRoom: (roomId: string, displayName?: string) => {
      gameServerClient.joinRoom(roomId, displayName)
    },
    joinMatchmaking: (stake: MatchStake, displayName?: string) => {
      gameServerClient.joinMatchmaking(stake, displayName)
    },
    leaveMatchmaking: () => {
      gameServerClient.leaveMatchmaking()
    },
    requestPlayerProfile: (roomId: string, seat: Seat) => {
      gameServerClient.requestPlayerProfile(roomId, seat)
    },
    getLatestRoomId: () => latestServerRoomId,
    getLatestPlayerProfile: (seat: Seat) => latestServerPlayerProfiles[seat] ?? null,
  }
}

function clearBotPlayTimeout(): void {
  if (botPlayTimeoutId !== null) {
    window.clearTimeout(botPlayTimeoutId)
    botPlayTimeoutId = null
  }
}

function clearBotBidTimeout(): void {
  if (botBidTimeoutId !== null) {
    window.clearTimeout(botBidTimeoutId)
    botBidTimeoutId = null
  }

  activeBotBidTurnKey = null
}

function clearCuttingAutoSelectTimeout(): void {
  if (cuttingAutoSelectTimeoutId !== null) {
    window.clearTimeout(cuttingAutoSelectTimeoutId)
    cuttingAutoSelectTimeoutId = null
  }
}

function clearCuttingResolveTimeout(): void {
  if (cuttingResolveTimeoutId !== null) {
    window.clearTimeout(cuttingResolveTimeoutId)
    cuttingResolveTimeoutId = null
  }
}

function clearDealPhaseAutoAdvanceTimeout(): void {
  if (dealPhaseAutoAdvanceTimeoutId !== null) {
    window.clearTimeout(dealPhaseAutoAdvanceTimeoutId)
    dealPhaseAutoAdvanceTimeoutId = null
  }

  activeDealPhaseAutoAdvance = null
}

function clearScoringTimeouts(): void {
  if (scoringTickTimeoutId !== null) {
    window.clearTimeout(scoringTickTimeoutId)
    scoringTickTimeoutId = null
  }

  if (scoringAutoAdvanceTimeoutId !== null) {
    window.clearTimeout(scoringAutoAdvanceTimeoutId)
    scoringAutoAdvanceTimeoutId = null
  }
}

function clearFinalTrickAnimationTimeout(): void {
  if (activeFinalTrickAnimation) {
    const animationToCancel = activeFinalTrickAnimation
    activeFinalTrickAnimation = null
    animationToCancel.cancel()
  }

  if (finalTrickHoldTimeoutId !== null) {
    window.clearTimeout(finalTrickHoldTimeoutId)
    finalTrickHoldTimeoutId = null
  }

  if (activeFinalTrickFloatingCard?.parentNode) {
    activeFinalTrickFloatingCard.parentNode.removeChild(activeFinalTrickFloatingCard)
  }

  activeFinalTrickFloatingCard = null

  if (activeFinalTrickSourceElement) {
    activeFinalTrickSourceElement.style.opacity = ''
  }

  activeFinalTrickSourceElement = null
  isAnimatingFinalTrickCard = false
}

function clearMatchEndedCoordinationTimeouts(): void {
  for (const timeoutId of matchEndedCoordinationTimeoutIds) {
    window.clearTimeout(timeoutId)
  }

  matchEndedCoordinationTimeoutIds = []
}

function resetPlayingTurnTracking(): void {
  activePlayingTurnKey = null
  activePlayingTurnStartedAt = 0
  activePlayingPausedRemainingMs = null
}

function resetCuttingTurnTracking(): void {
  activeCuttingTurnKey = null
  activeCuttingTurnStartedAt = 0
}

function removeBottomBotTakeoverPopup(): void {
  document.querySelector('[data-bottom-bot-takeover-popup-root]')?.remove()
}

function isBottomControlledByBot(state: GameState): boolean {
  return Boolean(state.players.bottom?.controlledByBot)
}

function setBottomPlayerControlledByBot(nextValue: boolean): void {
  app.engine.updateState((currentState) => {
    const bottomPlayer = currentState.players.bottom

    if (!bottomPlayer || bottomPlayer.controlledByBot === nextValue) {
      return currentState
    }

    let nextState: GameState = {
      ...currentState,
      players: {
        ...currentState.players,
        bottom: {
          ...bottomPlayer,
          controlledByBot: nextValue,
        },
      },
    }

    const currentTurnSeat =
      nextState.playing?.currentTurnSeat ?? nextState.currentTrick.currentSeat

    if (nextState.phase === 'playing' && currentTurnSeat === 'bottom') {
      nextState = {
        ...nextState,
        timer: createPlayingTimerState(nextState, 'bottom'),
      }
    }

    return nextState
  })

  setBottomBotTakeoverActive(nextValue)
}

function syncBottomBotTakeoverFromState(): void {
  const latestState = app.engine.getState()
  const nextValue = isBottomControlledByBot(latestState)

  if (bottomBotTakeoverActive !== nextValue) {
    setBottomBotTakeoverActive(nextValue)
  }
}

function canResumeSyncFromBackground(state: GameState): boolean {
  if (state.phase === 'playing' && isAnimatingFinalTrickCard) {
    return false
  }

  if (state.phase === 'playing') {
    const currentSeat = state.playing?.currentTurnSeat ?? state.currentTrick.currentSeat

    if (
      currentSeat === 'bottom' &&
      !isBottomControlledByBot(state) &&
      belotePromptController.hasPendingPrompt()
    ) {
      return false
    }
  }

  return true
}

function resumeFromBackground(): void {
  const stateBeforeResume = app.engine.getState()

  if (!canResumeSyncFromBackground(stateBeforeResume)) {
    render()
    return
  }

  clearBotPlayTimeout()
  clearBotBidTimeout()
  clearCuttingAutoSelectTimeout()
  clearCuttingResolveTimeout()
  clearDealPhaseAutoAdvanceTimeout()
  clearScoringTimeouts()
  clearFinalTrickAnimationTimeout()

  resetPlayingTurnTracking()
  resetCuttingTurnTracking()

  app.engine.syncToNow()
  syncBottomBotTakeoverFromState()
  render()
}

function setBottomBotTakeoverActive(nextValue: boolean): void {
  if (bottomBotTakeoverActive === nextValue) {
    return
  }

  bottomBotTakeoverActive = nextValue
  clearBotPlayTimeout()
  clearBotBidTimeout()
  clearCuttingAutoSelectTimeout()
  resetPlayingTurnTracking()
  resetCuttingTurnTracking()

  if (!nextValue) {
    removeBottomBotTakeoverPopup()
  }
}

function clearAllAsyncUiState(): void {
  clearBotPlayTimeout()
  clearBotBidTimeout()
  clearCuttingAutoSelectTimeout()
  clearCuttingResolveTimeout()
  clearDealPhaseAutoAdvanceTimeout()
  clearScoringTimeouts()
  clearFinalTrickAnimationTimeout()
  clearMatchEndedCoordinationTimeouts()
}

function resetMatchEndedUiState(): void {
  clearMatchEndedCoordinationTimeouts()
  matchEndedPlayerStatuses = {}
}

function restartLocalMatch(): void {
  clearAllAsyncUiState()
  resetMatchEndedUiState()
  resetPlayingTurnTracking()
  resetCuttingTurnTracking()
  setBottomBotTakeoverActive(false)
  setBidBubbleOverride(null)
  app.engine.startNewGame()
  app.engine.chooseFirstDealer()
}

function showTemporaryMatchEndedPlaceholder(message: string): void {
  window.alert(message)
}

function setMatchEndedPlayerStatus(seat: Seat, status: MatchEndedPlayerStatus): void {
  matchEndedPlayerStatuses = {
    ...matchEndedPlayerStatuses,
    [seat]: status,
  }
}

function getMatchEndedBotSeats(state: GameState): Seat[] {
  return (['right', 'top', 'left'] as const).filter(
    (seat) => state.players[seat]?.mode === 'bot',
  )
}

function getMatchEndedHumanSeats(state: GameState): Seat[] {
  return (['right', 'top', 'left'] as const).filter(
    (seat) => state.players[seat]?.mode === 'human',
  )
}

function shouldContinueMatchEndedReloadFlow(): boolean {
  const latestState = app.engine.getState()

  return latestState.phase === 'match-ended' && matchEndedPlayerStatuses.bottom === 'reload'
}

function scheduleMatchEndedBotReloadFlow(state: GameState): void {
  const botSeats = getMatchEndedBotSeats(state)
  const humanSeats = getMatchEndedHumanSeats(state)

  botSeats.forEach((seat, index) => {
    const timeoutId = window.setTimeout(() => {
      if (!shouldContinueMatchEndedReloadFlow()) {
        return
      }

      setMatchEndedPlayerStatus(seat, 'reload')
      render()
    }, MATCH_ENDED_BOT_RELOAD_STEP_MS * (index + 1))

    matchEndedCoordinationTimeoutIds.push(timeoutId)
  })

  if (humanSeats.length > 0) {
    return
  }

  const restartDelayMs =
    botSeats.length * MATCH_ENDED_BOT_RELOAD_STEP_MS + MATCH_ENDED_RESTART_AFTER_BOTS_MS

  const restartTimeoutId = window.setTimeout(() => {
    if (!shouldContinueMatchEndedReloadFlow()) {
      return
    }

    restartLocalMatch()
    render()
  }, restartDelayMs)

  matchEndedCoordinationTimeoutIds.push(restartTimeoutId)
}

function startMatchEndedReloadFlow(): void {
  const state = app.engine.getState()

  if (state.phase !== 'match-ended') {
    return
  }

  if (matchEndedPlayerStatuses.bottom === 'reload') {
    return
  }

  clearMatchEndedCoordinationTimeouts()
  setMatchEndedPlayerStatus('bottom', 'reload')
  render()
  scheduleMatchEndedBotReloadFlow(state)
}

function getRenderClockNow(): number {
  return Date.now()
}

function parseRotationFromTransform(transformValue: string | null): number {
  if (!transformValue || transformValue === 'none') {
    return 0
  }

  const matrixMatch = transformValue.match(/matrix\(([^)]+)\)/)

  if (!matrixMatch || !matrixMatch[1]) {
    return 0
  }

  const values = matrixMatch[1].split(',').map((value) => Number(value.trim()))

  if (values.length < 2 || Number.isNaN(values[0]) || Number.isNaN(values[1])) {
    return 0
  }

  return Math.round(Math.atan2(values[1], values[0]) * (180 / Math.PI))
}

function getSuitSymbol(suit: Suit): string {
  if (suit === 'clubs') return '♣'
  if (suit === 'diamonds') return '♦'
  if (suit === 'hearts') return '♥'
  return '♠'
}

function isRedSuit(suit: Suit): boolean {
  return suit === 'hearts' || suit === 'diamonds'
}

function getCurrentStageScale(): number {
  const stageElement = document.querySelector<HTMLElement>('[data-game-stage="1"]')
  const rawScale = Number(stageElement?.dataset.stageScale ?? '1')

  if (!Number.isFinite(rawScale) || rawScale <= 0) {
    return 1
  }

  return rawScale
}

function getScaledFloatingCardSize(): { width: number; height: number } {
  const stageScale = getCurrentStageScale()

  return {
    width: FLOATING_CARD_WIDTH * stageScale,
    height: FLOATING_CARD_HEIGHT * stageScale,
  }
}

function resolveCardForSeat(cardId: string, seat: Seat): Card | null {
  const state = app.engine.getState()
  const hand = state.hands[seat] ?? []

  return hand.find((card) => card.id === cardId) ?? null
}

function getBottomSourceElement(cardId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-bottom-hand-root="1"] [data-card-id="${cardId}"]`,
  )
}

function getSeatAnchor(seat: Seat): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-seat-anchor="${seat}"]`)
}

function getSeatPlayOffset(seat: Seat): {
  leftOffset: number
  topOffset: number
  rotate: number
} {
  if (seat === 'top') {
    return { leftOffset: 0, topOffset: -54, rotate: 0 }
  }

  if (seat === 'left') {
    return { leftOffset: -78, topOffset: 0, rotate: -8 }
  }

  if (seat === 'right') {
    return { leftOffset: 78, topOffset: 0, rotate: 8 }
  }

  return { leftOffset: 0, topOffset: 54, rotate: 0 }
}

function resolveFallbackStartRectForSeat(seat: Seat): {
  left: number
  top: number
  rotate: number
} {
  const { width, height } = getScaledFloatingCardSize()
  const centerX = window.innerWidth / 2
  const centerY = window.innerHeight / 2

  if (seat === 'top') {
    return {
      left: centerX - width / 2,
      top: 64,
      rotate: 0,
    }
  }

  if (seat === 'left') {
    return {
      left: 52,
      top: centerY - height / 2,
      rotate: -8,
    }
  }

  if (seat === 'right') {
    return {
      left: window.innerWidth - width - 52,
      top: centerY - height / 2,
      rotate: 8,
    }
  }

  return {
    left: centerX - width / 2,
    top: window.innerHeight - height - 72,
    rotate: 0,
  }
}

function resolveStartRectForSeat(
  seat: Seat,
  cardId: string,
): { left: number; top: number; rotate: number; sourceElement?: HTMLElement | null } | null {
  const { width, height } = getScaledFloatingCardSize()

  if (seat === 'bottom') {
    const sourceElement = getBottomSourceElement(cardId)

    if (sourceElement) {
      const rect = sourceElement.getBoundingClientRect()
      const rotate = parseRotationFromTransform(
        window.getComputedStyle(sourceElement).transform,
      )

      return {
        left: rect.left,
        top: rect.top,
        rotate,
        sourceElement,
      }
    }
  }

  const anchor = getSeatAnchor(seat)

  if (anchor) {
    const rect = anchor.getBoundingClientRect()

    if (seat === 'top') {
      return {
        left: rect.left + rect.width / 2 - width / 2,
        top: rect.top + rect.height - 36,
        rotate: 0,
      }
    }

    if (seat === 'left') {
      return {
        left: rect.left + rect.width - 34,
        top: rect.top + rect.height / 2 - height / 2,
        rotate: -8,
      }
    }

    if (seat === 'right') {
      return {
        left: rect.left - width + 34,
        top: rect.top + rect.height / 2 - height / 2,
        rotate: 8,
      }
    }

    return {
      left: rect.left + rect.width / 2 - width / 2,
      top: rect.top - height + 34,
      rotate: 0,
    }
  }

  return resolveFallbackStartRectForSeat(seat)
}

function resolvePlayTargetRectForSeat(seat: Seat): {
  left: number
  top: number
  rotate: number
} {
  const target = document.querySelector<HTMLElement>(`[data-play-target-seat="${seat}"]`)

  if (target) {
    const targetRect = target.getBoundingClientRect()
    const targetRotate = parseRotationFromTransform(window.getComputedStyle(target).transform)

    return {
      left: targetRect.left,
      top: targetRect.top,
      rotate: targetRotate,
    }
  }

  const centerX = window.innerWidth / 2
  const centerY = window.innerHeight / 2
  const seatOffset = getSeatPlayOffset(seat)

  return {
    left: centerX - 56 + seatOffset.leftOffset,
    top: centerY - 81 + seatOffset.topOffset,
    rotate: seatOffset.rotate,
  }
}

function createFloatingCardElement(card: Card): HTMLDivElement {
  const { width, height } = getScaledFloatingCardSize()
  const suitSymbol = getSuitSymbol(card.suit)
  const cardColor = isRedSuit(card.suit) ? '#b3261e' : '#13253d'
  const stageScale = getCurrentStageScale()

  const wrapper = document.createElement('div')
  wrapper.style.position = 'fixed'
  wrapper.style.width = `${width}px`
  wrapper.style.height = `${height}px`
  wrapper.style.pointerEvents = 'none'
  wrapper.style.zIndex = '9999'
  wrapper.style.transformOrigin = 'center center'
  wrapper.style.willChange = 'transform, opacity'
  wrapper.innerHTML = `
    <div
      style="
        position:absolute;
        inset:0;
        border-radius:${14 * stageScale}px;
        background:linear-gradient(180deg, rgba(255,255,255,0.99) 0%, rgba(241,245,250,0.99) 100%);
        box-shadow:
          0 ${16 * stageScale}px ${34 * stageScale}px rgba(0,0,0,0.24),
          inset 0 1px 0 rgba(255,255,255,0.95),
          inset 0 -1px 0 rgba(0,0,0,0.05);
        border:1px solid rgba(21,48,82,0.10);
      "
    ></div>

    <div
      style="
        position:absolute;
        inset:${4 * stageScale}px;
        border-radius:${10 * stageScale}px;
        border:1px solid rgba(20,49,84,0.12);
        background:linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(248,250,253,0.94) 100%);
      "
    ></div>

    <div
      style="
        position:absolute;
        left:${9 * stageScale}px;
        top:${10 * stageScale}px;
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:${1 * stageScale}px;
        color:${cardColor};
        line-height:1;
      "
    >
      <span
        style="
          font-size:${30 * stageScale}px;
          font-weight:900;
          letter-spacing:0.02em;
        "
      >
        ${String(card.rank)}
      </span>
      <span
        style="
          font-size:${45 * stageScale}px;
          font-weight:900;
        "
      >
        ${suitSymbol}
      </span>
    </div>

    <div
      style="
        position:absolute;
        right:${9 * stageScale}px;
        bottom:${8 * stageScale}px;
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:${1 * stageScale}px;
        color:${cardColor};
        line-height:1;
        transform:rotate(180deg);
      "
    >
      <span
        style="
          font-size:${30 * stageScale}px;
          font-weight:900;
          letter-spacing:0.02em;
        "
      >
        ${String(card.rank)}
      </span>
      <span
        style="
          font-size:${45 * stageScale}px;
          font-weight:900;
        "
      >
        ${suitSymbol}
      </span>
    </div>

    <div
      style="
        position:absolute;
        left:50%;
        top:54%;
        transform:translate(-50%, -50%);
        color:${cardColor};
        font-size:${54 * stageScale}px;
        line-height:1;
        font-weight:900;
        text-shadow:0 2px 6px rgba(0,0,0,0.08);
      "
    >
      ${suitSymbol}
    </div>
  `

  return wrapper
}

function getClockNowForPhaseTimestamp(timestamp: number | null | undefined): number {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return Date.now()
  }

  return Date.now()
}

function getScoringRemainingMs(state: GameState): number | null {
  if (state.phase !== 'scoring') {
    return null
  }

  const phaseEnteredAt =
    typeof state.phaseEnteredAt === 'number' && Number.isFinite(state.phaseEnteredAt)
      ? state.phaseEnteredAt
      : null

  if (phaseEnteredAt === null) {
    return SCORING_AUTO_ADVANCE_MS
  }

  const now = getClockNowForPhaseTimestamp(phaseEnteredAt)
  const elapsedMs = Math.max(0, now - phaseEnteredAt)

  return Math.max(0, SCORING_AUTO_ADVANCE_MS - elapsedMs)
}

function getSelectedCutIndexFromState(state: GameState): number | null {
  const extendedState = state as GameState & {
    selectedCutIndex?: number | null
    round?: {
      selectedCutIndex?: number | null
    }
    roundSetup?: {
      selectedCutIndex?: number | null
    }
  }

  const roundCutIndex = extendedState.round?.selectedCutIndex

  if (typeof roundCutIndex === 'number' && Number.isFinite(roundCutIndex)) {
    return roundCutIndex
  }

  const roundSetupCutIndex = extendedState.roundSetup?.selectedCutIndex

  if (typeof roundSetupCutIndex === 'number' && Number.isFinite(roundSetupCutIndex)) {
    return roundSetupCutIndex
  }

  const rootCutIndex = extendedState.selectedCutIndex

  if (typeof rootCutIndex === 'number' && Number.isFinite(rootCutIndex)) {
    return rootCutIndex
  }

  return null
}

function getStateTimerStartedAt(state: GameState, activeSeat: Seat | null): number | null {
  if (!activeSeat) {
    return null
  }

  if (state.timer.activeSeat !== activeSeat) {
    return null
  }

  const startedAt = state.timer.startedAt

  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return null
  }

  return startedAt
}

function getStateTimerExpiresAt(state: GameState, activeSeat: Seat | null): number | null {
  if (!activeSeat) {
    return null
  }

  if (state.timer.activeSeat !== activeSeat) {
    return null
  }

  const expiresAt = state.timer.expiresAt

  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return null
  }

  return expiresAt
}

function getCuttingTurnKey(state: GameState): string | null {
  if (state.phase !== 'cutting') {
    return null
  }

  const cutterSeat = state.round.cutterSeat

  if (!cutterSeat) {
    return null
  }

  if (getSelectedCutIndexFromState(state) !== null) {
    return null
  }

  const controlMode = cutterSeat === 'bottom' && !bottomBotTakeoverActive ? 'human' : 'bot'

  const phaseMarker =
    typeof state.phaseEnteredAt === 'number' && Number.isFinite(state.phaseEnteredAt)
      ? String(state.phaseEnteredAt)
      : 'no-phase-timestamp'

  return `${phaseMarker}:${cutterSeat}:${controlMode}`
}

function syncCuttingTurnState(state: GameState): void {
  const turnKey = getCuttingTurnKey(state)

  if (turnKey === null) {
    resetCuttingTurnTracking()
    return
  }

  if (activeCuttingTurnKey === turnKey) {
    return
  }

  activeCuttingTurnKey = turnKey
  activeCuttingTurnStartedAt =
    getStateTimerStartedAt(state, state.round.cutterSeat) ?? getRenderClockNow()
}

function getCuttingRemainingMs(state: GameState): number | null {
  if (state.phase !== 'cutting') {
    return null
  }

  const cutterSeat = state.round.cutterSeat

  if (!cutterSeat) {
    return null
  }

  if (getSelectedCutIndexFromState(state) !== null) {
    return null
  }

  const autoSelectMs =
    cutterSeat === 'bottom' && !bottomBotTakeoverActive
      ? CUTTING_COUNTDOWN_MS
      : BOT_CUTTING_AUTO_SELECT_MS

  const turnKey = getCuttingTurnKey(state)

  if (
    turnKey === null ||
    activeCuttingTurnKey !== turnKey ||
    !Number.isFinite(activeCuttingTurnStartedAt) ||
    activeCuttingTurnStartedAt <= 0
  ) {
    return autoSelectMs
  }

  const now = getRenderClockNow()
  const elapsedMs = Math.max(0, now - activeCuttingTurnStartedAt)

  return Math.max(0, autoSelectMs - elapsedMs)
}

function pickAutoCutIndex(state: GameState): number {
  const totalCards = state.deck.length

  if (totalCards <= 2) {
    return 1
  }

  const minIndex = Math.min(6, totalCards - 1)
  const maxIndex = Math.max(minIndex, totalCards - 6)

  if (maxIndex <= minIndex) {
    return Math.max(1, Math.floor(totalCards / 2))
  }

  return minIndex + Math.floor(Math.random() * (maxIndex - minIndex + 1))
}

function getDealPhaseAutoAdvanceDelay(phase: string): number | null {
  if (phase === 'cut-resolve') {
    return CUT_RESOLVE_AUTO_ADVANCE_MS
  }

  if (phase === 'deal-first-3') {
    return DEAL_FIRST_THREE_AUTO_ADVANCE_MS
  }

  if (phase === 'deal-next-2') {
    return DEAL_NEXT_TWO_AUTO_ADVANCE_MS
  }

  if (phase === 'deal-last-3') {
    return DEAL_LAST_THREE_AUTO_ADVANCE_MS
  }

  if (phase === 'next-round') {
    return NEXT_ROUND_AUTO_ADVANCE_MS
  }

  return null
}

function getBidTurnKey(state: GameState): string | null {
  if (state.phase !== 'bidding' || state.bidding.hasEnded) {
    return null
  }

  const currentSeat = state.bidding.currentSeat

  if (!currentSeat) {
    return null
  }

  const controlMode = currentSeat === 'bottom' && !bottomBotTakeoverActive ? 'human' : 'bot'

  return `${state.phase}:${state.bidding.entries.length}:${currentSeat}:${controlMode}`
}

function getBidActionRemainingMs(state: GameState): number | null {
  if (state.phase !== 'bidding' || state.bidding.hasEnded) {
    return null
  }

  const currentSeat = state.bidding.currentSeat

  if (!currentSeat) {
    return null
  }

  const timerExpiresAt = getStateTimerExpiresAt(state, currentSeat)

  if (timerExpiresAt !== null) {
    return Math.max(0, timerExpiresAt - getRenderClockNow())
  }

  return currentSeat === 'bottom' && !bottomBotTakeoverActive
    ? BIDDING_COUNTDOWN_MS
    : BOT_BIDDING_DELAY_MS
}

function getPlayingTurnKey(state: GameState): string | null {
  if (state.phase !== 'playing') {
    return null
  }

  const currentSeat = state.playing?.currentTurnSeat ?? null

  if (!currentSeat) {
    return null
  }

  const completedTricksCount = state.playing?.completedTricks.length ?? 0
  const currentTrickPlaysCount =
    state.playing?.currentTrick.plays.length ?? state.currentTrick.plays.length ?? 0

  const controlMode = currentSeat === 'bottom' && !bottomBotTakeoverActive ? 'human' : 'bot'

  return `${completedTricksCount}:${currentTrickPlaysCount}:${currentSeat}:${controlMode}`
}

function shouldDelayPlayingTurnStart(state: GameState): boolean {
  if (state.phase !== 'playing') {
    return false
  }

  const completedTricksCount = state.playing?.completedTricks.length ?? 0
  const currentTrickPlaysCount =
    state.playing?.currentTrick.plays.length ?? state.currentTrick.plays.length ?? 0

  return completedTricksCount > 0 && currentTrickPlaysCount === 0
}

function getPlayingTurnStartDelayMs(state: GameState): number {
  if (!shouldDelayPlayingTurnStart(state)) {
    return 0
  }

  return TRICK_COLLECTION_START_DELAY_MS
}

function syncPlayingTurnState(state: GameState): void {
  const turnKey = getPlayingTurnKey(state)

  if (turnKey === null) {
    resetPlayingTurnTracking()
    return
  }

  if (activePlayingTurnKey === turnKey) {
    return
  }

  const currentSeat = state.playing?.currentTurnSeat ?? null

  activePlayingTurnKey = turnKey
  activePlayingTurnStartedAt =
    getStateTimerStartedAt(state, currentSeat) ??
    getRenderClockNow() + getPlayingTurnStartDelayMs(state)
  activePlayingPausedRemainingMs = null
}

function isPlayingCountdownPaused(state: GameState): boolean {
  if (state.phase !== 'playing') {
    return false
  }

  const currentSeat = state.playing?.currentTurnSeat ?? null

  return (
    currentSeat === 'bottom' &&
    !bottomBotTakeoverActive &&
    belotePromptController.hasPendingPrompt()
  )
}

function getRawPlayingCountdownRemainingMs(state: GameState): number | null {
  if (state.phase !== 'playing') {
    return null
  }

  const turnKey = getPlayingTurnKey(state)

  if (!turnKey) {
    return null
  }

  if (
    activePlayingTurnKey !== turnKey ||
    !Number.isFinite(activePlayingTurnStartedAt) ||
    activePlayingTurnStartedAt <= 0
  ) {
    return PLAYING_COUNTDOWN_MS
  }

  const now = getRenderClockNow()
  const elapsedMs = Math.max(0, now - activePlayingTurnStartedAt)

  return Math.max(0, PLAYING_COUNTDOWN_MS - elapsedMs)
}

function getPlayingCountdownRemainingMs(state: GameState): number | null {
  if (state.phase !== 'playing') {
    return null
  }

  if (activePlayingPausedRemainingMs !== null) {
    return Math.max(0, Math.min(PLAYING_COUNTDOWN_MS, activePlayingPausedRemainingMs))
  }

  return getRawPlayingCountdownRemainingMs(state)
}

function getPlayingActionDelayMs(state: GameState): number | null {
  if (state.phase !== 'playing') {
    return null
  }

  const currentSeat = state.playing?.currentTurnSeat ?? null

  if (!currentSeat) {
    return null
  }

  if (currentSeat === 'bottom' && !bottomBotTakeoverActive) {
    return PLAYING_COUNTDOWN_MS
  }

  return BOT_PLAY_DELAY_MS
}

function getPlayingActionRemainingMs(state: GameState): number | null {
  const totalDelayMs = getPlayingActionDelayMs(state)

  if (totalDelayMs === null) {
    return null
  }

  if (
    state.phase === 'playing' &&
    state.playing?.currentTurnSeat === 'bottom' &&
    !bottomBotTakeoverActive &&
    activePlayingPausedRemainingMs !== null
  ) {
    return Math.max(0, Math.min(totalDelayMs, activePlayingPausedRemainingMs))
  }

  const turnKey = getPlayingTurnKey(state)

  if (
    !turnKey ||
    activePlayingTurnKey !== turnKey ||
    !Number.isFinite(activePlayingTurnStartedAt) ||
    activePlayingTurnStartedAt <= 0
  ) {
    return totalDelayMs
  }

  const now = getRenderClockNow()
  const elapsedMs = Math.max(0, now - activePlayingTurnStartedAt)

  return Math.max(0, totalDelayMs - elapsedMs)
}

function syncPlayingPauseState(state: GameState): void {
  if (state.phase !== 'playing') {
    activePlayingPausedRemainingMs = null
    return
  }

  const shouldPause = isPlayingCountdownPaused(state)

  if (shouldPause) {
    if (activePlayingPausedRemainingMs === null) {
      activePlayingPausedRemainingMs = getRawPlayingCountdownRemainingMs(state)
    }

    return
  }

  if (activePlayingPausedRemainingMs !== null) {
    activePlayingTurnStartedAt =
      getRenderClockNow() - (PLAYING_COUNTDOWN_MS - activePlayingPausedRemainingMs)
    activePlayingPausedRemainingMs = null
  }
}

function renderBottomBotTakeoverPopup(): void {
  const state = app.engine.getState()
  const shouldShowPopup = bottomBotTakeoverActive && state.phase !== 'match-ended'

  if (!shouldShowPopup) {
    removeBottomBotTakeoverPopup()
    return
  }

  const existingRoot = document.querySelector('[data-bottom-bot-takeover-popup-root]')

  if (existingRoot) {
    return
  }

  const overlay = document.createElement('div')
  overlay.setAttribute('data-bottom-bot-takeover-popup-root', 'true')
  overlay.innerHTML = `
    <div
      style="
        position:fixed;
        inset:0;
        background:rgba(2, 6, 23, 0.52);
        display:flex;
        align-items:center;
        justify-content:center;
        padding:24px;
        z-index:9998;
        pointer-events:auto;
      "
    >
      <div
        style="
          width:min(92vw, 560px);
          background:rgba(15, 23, 42, 0.98);
          border:1px solid rgba(148, 163, 184, 0.22);
          border-radius:18px;
          padding:22px;
          box-shadow:0 24px 60px rgba(0,0,0,0.35);
          color:#f8fafc;
          font-family:Arial, Helvetica, sans-serif;
          text-align:center;
        "
      >
        <div
          style="
            font-size:22px;
            font-weight:800;
            line-height:1.4;
            margin-bottom:18px;
          "
        >
          Поради изтичане на времето за реакция играта беше поета от робот
        </div>

        <button
          type="button"
          data-bottom-bot-takeover-return-button
          style="
            min-width:180px;
            border:0;
            border-radius:12px;
            padding:13px 18px;
            background:#22c55e;
            color:#052e16;
            font-size:15px;
            font-weight:800;
            cursor:pointer;
          "
        >
          Върни се
        </button>
      </div>
    </div>
  `

  document.body.appendChild(overlay)

  const returnButton = overlay.querySelector<HTMLButtonElement>(
    '[data-bottom-bot-takeover-return-button]',
  )

  returnButton?.addEventListener('click', () => {
    tryUnlockDocumentAudio()
    setBottomPlayerControlledByBot(false)
    render()
  })
}

function formatBidBubbleLabel(action: BidAction): string {
  if (action.type === 'pass') {
    return 'Пас'
  }

  if (action.type === 'no-trumps') {
    return 'Без коз'
  }

  if (action.type === 'all-trumps') {
    return 'Всичко коз'
  }

  if (action.type === 'double') {
    return 'Контра'
  }

  if (action.type === 'redouble') {
    return 'Ре контра'
  }

  if (action.suit === 'clubs') {
    return 'Спатия'
  }

  if (action.suit === 'diamonds') {
    return 'Каро'
  }

  if (action.suit === 'hearts') {
    return 'Купа'
  }

  return 'Пика'
}

function buildBidBubbleEntryKeyFromState(state: GameState): string | null {
  const lastEntry = state.bidding.entries.at(-1)

  if (!lastEntry) {
    return null
  }

  const phaseMarker =
    typeof state.phaseEnteredAt === 'number' && Number.isFinite(state.phaseEnteredAt)
      ? String(state.phaseEnteredAt)
      : 'no-phase-timestamp'

  const suitPart = lastEntry.action.type === 'suit' ? `:${lastEntry.action.suit}` : ''

  return `${phaseMarker}:${state.bidding.entries.length}:${lastEntry.seat}:${lastEntry.action.type}${suitPart}`
}

function buildFallbackBidBubbleEntryKey(
  stateBeforeSubmit: GameState,
  seat: Seat,
  action: BidAction,
): string {
  const phaseMarker =
    typeof stateBeforeSubmit.phaseEnteredAt === 'number' &&
    Number.isFinite(stateBeforeSubmit.phaseEnteredAt)
      ? String(stateBeforeSubmit.phaseEnteredAt)
      : 'no-phase-timestamp'

  const nextEntryCount = stateBeforeSubmit.bidding.entries.length + 1
  const suitPart = action.type === 'suit' ? `:${action.suit}` : ''

  return `${phaseMarker}:${nextEntryCount}:${seat}:${action.type}${suitPart}`
}

function setBidBubbleOverride(nextBubble: BidBubbleOverride | null): void {
  bidBubbleOverride = nextBubble
}

function submitBidActionWithBubble(action: BidAction): void {
  const stateBeforeSubmit = app.engine.getState()
  const seat = stateBeforeSubmit.bidding.currentSeat

  clearBotPlayTimeout()
  clearBotBidTimeout()
  clearCuttingAutoSelectTimeout()
  clearCuttingResolveTimeout()
  clearDealPhaseAutoAdvanceTimeout()
  clearScoringTimeouts()
  clearFinalTrickAnimationTimeout()

  app.engine.submitBidAction(action)

  if (seat) {
    const stateAfterSubmit = app.engine.getState()
    const stateBasedEntryKey = buildBidBubbleEntryKeyFromState(stateAfterSubmit)

    setBidBubbleOverride({
      entryKey:
        stateBasedEntryKey ?? buildFallbackBidBubbleEntryKey(stateBeforeSubmit, seat, action),
      seat,
      label: formatBidBubbleLabel(action),
    })
  }

  render()
}

function scheduleCuttingAutoSelect(): void {
  clearCuttingAutoSelectTimeout()

  const state = app.engine.getState()
  syncCuttingTurnState(state)

  const remainingMs = getCuttingRemainingMs(state)

  if (remainingMs === null) {
    return
  }

  cuttingAutoSelectTimeoutId = window.setTimeout(() => {
    cuttingAutoSelectTimeoutId = null

    const latestState = app.engine.getState()

    if (latestState.phase !== 'cutting') {
      render()
      return
    }

    if (!latestState.round.cutterSeat) {
      render()
      return
    }

    if (getSelectedCutIndexFromState(latestState) !== null) {
      render()
      return
    }

    const autoCutIndex = pickAutoCutIndex(latestState)

    clearBotPlayTimeout()
    clearBotBidTimeout()
    clearCuttingResolveTimeout()
    clearDealPhaseAutoAdvanceTimeout()
    clearScoringTimeouts()
    clearFinalTrickAnimationTimeout()

    app.engine.selectCutIndex(autoCutIndex)
    render()
  }, Math.max(0, remainingMs))
}

function scheduleCuttingResolve(): void {
  const state = app.engine.getState()
  const selectedCutIndex = getSelectedCutIndexFromState(state)

  if (state.phase !== 'cutting' || selectedCutIndex === null) {
    clearCuttingResolveTimeout()
    return
  }

  if (cuttingResolveTimeoutId !== null) {
    return
  }

  cuttingResolveTimeoutId = window.setTimeout(() => {
    cuttingResolveTimeoutId = null

    const latestState = app.engine.getState()
    const latestSelectedCutIndex = getSelectedCutIndexFromState(latestState)

    if (latestState.phase !== 'cutting' || latestSelectedCutIndex === null) {
      render()
      return
    }

    clearBotPlayTimeout()
    clearBotBidTimeout()
    clearDealPhaseAutoAdvanceTimeout()
    clearScoringTimeouts()
    clearFinalTrickAnimationTimeout()
    app.engine.resolveCutPhase()
    render()
  }, CUTTING_SELECTION_RESOLVE_MS)
}

function scheduleDealPhaseAutoAdvance(): void {
  const state = app.engine.getState()
  const delay = getDealPhaseAutoAdvanceDelay(state.phase)

  if (delay === null) {
    clearDealPhaseAutoAdvanceTimeout()
    return
  }

  if (dealPhaseAutoAdvanceTimeoutId !== null && activeDealPhaseAutoAdvance === state.phase) {
    return
  }

  clearDealPhaseAutoAdvanceTimeout()
  activeDealPhaseAutoAdvance = state.phase

  dealPhaseAutoAdvanceTimeoutId = window.setTimeout(() => {
    dealPhaseAutoAdvanceTimeoutId = null

    const latestState = app.engine.getState()

    if (latestState.phase !== state.phase) {
      activeDealPhaseAutoAdvance = null
      render()
      return
    }

    activeDealPhaseAutoAdvance = null
    clearBotPlayTimeout()
    clearBotBidTimeout()
    clearCuttingAutoSelectTimeout()
    clearCuttingResolveTimeout()
    clearScoringTimeouts()
    clearFinalTrickAnimationTimeout()
    app.engine.goToNextPhase()
    render()
  }, delay)
}

function scheduleScoringPhaseTimers(): void {
  clearScoringTimeouts()

  const state = app.engine.getState()
  const remainingMs = getScoringRemainingMs(state)

  if (remainingMs === null) {
    return
  }

  if (remainingMs <= 0) {
    scoringAutoAdvanceTimeoutId = window.setTimeout(() => {
      scoringAutoAdvanceTimeoutId = null

      const latestState = app.engine.getState()

      if (latestState.phase !== 'scoring') {
        render()
        return
      }

      clearBotPlayTimeout()
      clearBotBidTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearFinalTrickAnimationTimeout()
      clearScoringTimeouts()
      app.engine.goToNextPhase()
      render()
    }, 0)

    return
  }

  const currentDisplayedSeconds = Math.ceil(remainingMs / 1000)
  const delayToNextCountdownStep =
    remainingMs -
    Math.max(0, currentDisplayedSeconds - 1) * 1000 +
    SCORING_TIMER_FUDGE_MS
  const tickDelay = Math.max(
    SCORING_TIMER_FUDGE_MS,
    Math.min(delayToNextCountdownStep, remainingMs),
  )

  scoringTickTimeoutId = window.setTimeout(() => {
    scoringTickTimeoutId = null

    const latestState = app.engine.getState()

    if (latestState.phase !== 'scoring') {
      render()
      return
    }

    render()
  }, tickDelay)

  scoringAutoAdvanceTimeoutId = window.setTimeout(() => {
    scoringAutoAdvanceTimeoutId = null

    const latestState = app.engine.getState()

    if (latestState.phase !== 'scoring') {
      render()
      return
    }

    clearBotPlayTimeout()
    clearBotBidTimeout()
    clearCuttingAutoSelectTimeout()
    clearCuttingResolveTimeout()
    clearDealPhaseAutoAdvanceTimeout()
    clearFinalTrickAnimationTimeout()
    clearScoringTimeouts()
    app.engine.goToNextPhase()
    render()
  }, remainingMs + SCORING_TIMER_FUDGE_MS)
}

function animateFinalTrickCardThenSubmit(cardId: string, seat: Seat): boolean {
  if (isAnimatingFinalTrickCard) {
    return true
  }

  const card = resolveCardForSeat(cardId, seat)
  const start = resolveStartRectForSeat(seat, cardId)

  if (!card || !start) {
    return false
  }

  const target = resolvePlayTargetRectForSeat(seat)

  clearFinalTrickAnimationTimeout()

  const floatingCard = createFloatingCardElement(card)
  floatingCard.style.left = `${start.left}px`
  floatingCard.style.top = `${start.top}px`
  floatingCard.style.opacity = '1'

  const host = document.querySelector<HTMLElement>('#app') ?? document.body
  host.appendChild(floatingCard)

  if (start.sourceElement) {
    start.sourceElement.style.opacity = '0'
    activeFinalTrickSourceElement = start.sourceElement
  } else {
    activeFinalTrickSourceElement = null
  }

  activeFinalTrickFloatingCard = floatingCard
  isAnimatingFinalTrickCard = true
  gameAudio.playCardMove()

  const deltaX = target.left - start.left
  const deltaY = target.top - start.top

  const animation = floatingCard.animate(
    [
      {
        transform: `translate(0px, 0px) rotate(${start.rotate}deg)`,
        opacity: 1,
      },
      {
        transform: `translate(${deltaX}px, ${deltaY}px) rotate(${target.rotate}deg)`,
        opacity: 1,
      },
    ],
    {
      duration: FINAL_TRICK_CARD_FLIGHT_MS,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'forwards',
    },
  )

  activeFinalTrickAnimation = animation

  animation.onfinish = () => {
    if (activeFinalTrickAnimation !== animation) {
      return
    }

    activeFinalTrickAnimation = null

    finalTrickHoldTimeoutId = window.setTimeout(() => {
      finalTrickHoldTimeoutId = null

      if (activeFinalTrickFloatingCard?.parentNode) {
        activeFinalTrickFloatingCard.parentNode.removeChild(activeFinalTrickFloatingCard)
      }

      activeFinalTrickFloatingCard = null

      if (activeFinalTrickSourceElement) {
        activeFinalTrickSourceElement.style.opacity = ''
      }

      activeFinalTrickSourceElement = null
      isAnimatingFinalTrickCard = false

      app.engine.submitPlayCard(cardId)
      render()
    }, FINAL_TRICK_CARD_HOLD_MS)
  }

  animation.oncancel = () => {
    if (activeFinalTrickAnimation === animation) {
      activeFinalTrickAnimation = null
    }

    if (finalTrickHoldTimeoutId !== null) {
      window.clearTimeout(finalTrickHoldTimeoutId)
      finalTrickHoldTimeoutId = null
    }

    if (activeFinalTrickFloatingCard?.parentNode) {
      activeFinalTrickFloatingCard.parentNode.removeChild(activeFinalTrickFloatingCard)
    }

    activeFinalTrickFloatingCard = null

    if (activeFinalTrickSourceElement) {
      activeFinalTrickSourceElement.style.opacity = ''
    }

    activeFinalTrickSourceElement = null
    isAnimatingFinalTrickCard = false
  }

  return true
}

function submitPlayCardWithFlow(cardId: string, seat: Seat): void {
  const state = app.engine.getState()

  if (state.phase !== 'playing') {
    app.engine.submitPlayCard(cardId)
    render()
    return
  }

  const liveCurrentTrickPlays =
    state.playing?.currentTrick.plays ?? state.currentTrick.plays ?? []

  const isFinalCardOfTrick = liveCurrentTrickPlays.length === 3

  if (isFinalCardOfTrick) {
    const didStartAnimation = animateFinalTrickCardThenSubmit(cardId, seat)

    if (didStartAnimation) {
      return
    }
  }

  app.engine.submitPlayCard(cardId)
  render()
}

function schedulePlayingPhaseTimers(): void {
  clearBotPlayTimeout()

  if (isAnimatingFinalTrickCard) {
    return
  }

  const state = app.engine.getState()

  if (state.phase !== 'playing') {
    return
  }

  const currentTurnSeat = state.playing?.currentTurnSeat ?? null

  if (!currentTurnSeat) {
    return
  }

  syncPlayingTurnState(state)
  syncPlayingPauseState(state)

  if (isPlayingCountdownPaused(state)) {
    return
  }

  const actionRemainingMs = getPlayingActionRemainingMs(state)

  if (actionRemainingMs === null) {
    return
  }

  botPlayTimeoutId = window.setTimeout(() => {
    botPlayTimeoutId = null

    if (isAnimatingFinalTrickCard) {
      return
    }

    const latestState = app.engine.getState()

    if (latestState.phase !== 'playing') {
      render()
      return
    }

    if (isPlayingCountdownPaused(latestState)) {
      render()
      return
    }

    const latestTurnKey = getPlayingTurnKey(latestState)

    if (latestTurnKey === null || latestTurnKey !== activePlayingTurnKey) {
      render()
      return
    }

    const latestSeat = latestState.playing?.currentTurnSeat ?? null

    if (!latestSeat) {
      render()
      return
    }

    if (latestSeat === 'bottom' && !bottomBotTakeoverActive) {
      setBottomPlayerControlledByBot(true)
      render()
      return
    }

    const botCard = pickBotCardToPlay(latestState, latestSeat)

    if (!botCard) {
      render()
      return
    }

    if (latestSeat === 'bottom' && bottomBotTakeoverActive) {
      belotePromptController.registerAutoDeclarationsForPlay(botCard.id)
    }

    submitPlayCardWithFlow(botCard.id, latestSeat)
  }, Math.max(0, actionRemainingMs))
}

function scheduleNextBidAction(): void {
  const state = app.engine.getState()
  const turnKey = getBidTurnKey(state)
  const remainingMs = getBidActionRemainingMs(state)

  if (turnKey === null || remainingMs === null) {
    clearBotBidTimeout()
    return
  }

  if (botBidTimeoutId !== null && activeBotBidTurnKey === turnKey) {
    return
  }

  if (botBidTimeoutId !== null) {
    window.clearTimeout(botBidTimeoutId)
    botBidTimeoutId = null
  }

  activeBotBidTurnKey = turnKey

  botBidTimeoutId = window.setTimeout(() => {
    botBidTimeoutId = null

    const latestState = app.engine.getState()
    const latestTurnKey = getBidTurnKey(latestState)

    if (latestTurnKey === null || latestTurnKey !== activeBotBidTurnKey) {
      activeBotBidTurnKey = null
      render()
      return
    }

    const latestSeat = latestState.bidding.currentSeat

    if (!latestSeat) {
      activeBotBidTurnKey = null
      render()
      return
    }

    const autoAction = pickBotBidAction(latestState, latestSeat)

    activeBotBidTurnKey = null
    submitBidActionWithBubble(autoAction)
  }, Math.max(0, remainingMs))
}

function render(): void {
  const stateBeforeRender = app.engine.getState()

  if (currentAppScreen === 'lobby') {
    renderPlayerProfilePopupOverlay()
    lobbyFlowController.render()
    return
  }

  if (stateBeforeRender.phase !== 'match-ended') {
    resetMatchEndedUiState()
  }

  syncCuttingTurnState(stateBeforeRender)
  syncPlayingTurnState(stateBeforeRender)
  syncPlayingPauseState(stateBeforeRender)

  const playingCountdownRemainingMs = getPlayingCountdownRemainingMs(stateBeforeRender)

  renderApp(appRoot, app, {
    onNextPhaseClick: () => {
      tryUnlockDocumentAudio()
      clearBotPlayTimeout()
      clearBotBidTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.goToNextPhase()
      render()
    },
    onSelectCutIndex: (cutIndex) => {
      tryUnlockDocumentAudio()
      clearBotPlayTimeout()
      clearBotBidTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.selectCutIndex(cutIndex)
      render()
    },
    onResolveCutClick: () => {
      tryUnlockDocumentAudio()
      clearBotPlayTimeout()
      clearBotBidTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.resolveCutPhase()
      render()
    },
    onBidPass: () => {
      tryUnlockDocumentAudio()
      submitBidActionWithBubble({ type: 'pass' })
    },
    onBidSuit: (suit) => {
      tryUnlockDocumentAudio()
      submitBidActionWithBubble({ type: 'suit', suit })
    },
    onBidNoTrumps: () => {
      tryUnlockDocumentAudio()
      submitBidActionWithBubble({ type: 'no-trumps' })
    },
    onBidAllTrumps: () => {
      tryUnlockDocumentAudio()
      submitBidActionWithBubble({ type: 'all-trumps' })
    },
    onBidDouble: () => {
      tryUnlockDocumentAudio()
      submitBidActionWithBubble({ type: 'double' })
    },
    onBidRedouble: () => {
      tryUnlockDocumentAudio()
      submitBidActionWithBubble({ type: 'redouble' })
    },
    onPlayCard: (cardId) => {
      tryUnlockDocumentAudio()
      clearBotPlayTimeout()
      clearBotBidTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()

      const didOpenBelotePrompt = belotePromptController.handlePlayCard(cardId)

      if (didOpenBelotePrompt) {
        activePlayingPausedRemainingMs = getRawPlayingCountdownRemainingMs(app.engine.getState())
        belotePromptController.renderPendingPrompt()
        return
      }

      submitPlayCardWithFlow(cardId, 'bottom')
    },
    onRequestRender: () => {
      render()
    },
    onMatchEndedReloadGame: () => {
      tryUnlockDocumentAudio()
      startMatchEndedReloadFlow()
    },
    onMatchEndedFindNewGame: () => {
      tryUnlockDocumentAudio()
      clearMatchEndedCoordinationTimeouts()
      setMatchEndedPlayerStatus('bottom', 'find-new-game')
      render()
      showTemporaryMatchEndedPlaceholder(
        'Търсенето на нова игра още не е вързано. Следващата стъпка е search popup + matchmaking логика.',
      )
    },
    onMatchEndedLeave: () => {
      tryUnlockDocumentAudio()
      clearMatchEndedCoordinationTimeouts()
      setMatchEndedPlayerStatus('bottom', 'leave')
      render()
      showTemporaryMatchEndedPlaceholder(
        'Изходната страница още не е създадена. Следващата стъпка е отделна exit страница и пренасочване към нея.',
      )
    },
    matchEndedPlayerStatuses,
    playingCountdownRemainingMs,
    bottomBotTakeoverActive,
    bidBubbleOverride,
    seatPlayerInfos: getSeatPanelInfosForRender(),
    onSeatPanelClick: (seat) => {
      if (!latestServerRoomId) {
        return
      }

      const seatInfo = latestServerRoomSeats[seat]

      if (seatInfo && !seatInfo.isOccupied) {
        return
      }

      tryUnlockDocumentAudio()
      openPlayerProfilePopupForSeat(seat)
      renderPlayerProfilePopupOverlay()
      gameServerClient.requestPlayerProfile(latestServerRoomId, seat)
    },
  })

  renderPlayerProfilePopupOverlay()

  belotePromptController.renderPendingPrompt()
  renderBottomBotTakeoverPopup()
  scheduleCuttingAutoSelect()
  scheduleCuttingResolve()
  scheduleDealPhaseAutoAdvance()
  scheduleNextBidAction()
  schedulePlayingPhaseTimers()
  scheduleScoringPhaseTimers()
}

const belotePromptController = createBelotePromptController({
  app,
  render,
})

attachInitialAudioUnlockListeners()

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    return
  }

  resumeFromBackground()
})

window.addEventListener('focus', () => {
  resumeFromBackground()
})

window.addEventListener('pageshow', () => {
  resumeFromBackground()
})

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !isPlayerProfilePopupOpen) {
    return
  }

  closePlayerProfilePopup()
  renderPlayerProfilePopupOverlay()
})

window.addEventListener('resize', () => {
  if (resizeFrameId !== null) {
    window.cancelAnimationFrame(resizeFrameId)
  }

  resizeFrameId = window.requestAnimationFrame(() => {
    resizeFrameId = null
    render()
  })
})

exposeGameServerDebugApi()
gameServerClient.connect()

render()