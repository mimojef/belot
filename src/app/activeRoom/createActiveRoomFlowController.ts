import {
  type ClientBidAction,
  type MatchFoundMessage,
  type MatchStake,
  type RoomBiddingSnapshot,
  type RoomCuttingSnapshot,
  type RoomGameSnapshot,
  type RoomSeatSnapshot,
  type RoomSnapshotMessage,
  type RoomStatus,
  type Seat,
  type ServerMessage,
} from '../network/createGameServerClient'
import {
  createCuttingSeatPanelsHtml,
  type DealtHandsData,
  type SeatBidBubble,
} from './cutting/renderCuttingSeatPanels'
import { createCuttingVisualCountdownTracker } from './cutting/cuttingVisualCountdown'
import {
  CUTTING_VISUAL_ANIMATION_TOTAL_MS,
  type RenderCuttingAnimationState,
  renderCuttingScreen,
} from './renderCuttingScreen'
import {
  DEAL_FIRST_THREE_VISUAL_TOTAL_MS,
  DEAL_NEXT_TWO_VISUAL_TOTAL_MS,
  DEAL_PACKET_DELAY_STEP_MS,
  DEAL_PACKET_START_DELAY_MS,
  type RenderDealingAnimationState,
  renderDealingScreen,
  syncDealingScreenTargets,
} from './renderDealingScreen'
import {
  getBidActionLabel,
  renderBiddingStageHtml,
  createBiddingInteractionHtml,
} from './renderBiddingScreen'
import { getViewportStageMetrics } from '../../ui/layout/viewportStage'

type ActiveRoomState = {
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

type CreateActiveRoomFlowControllerOptions = {
  root: HTMLDivElement
  isConnected: () => boolean
  leaveActiveRoom: (roomId: string) => void
  submitCutIndex: (roomId: string, cutIndex: number) => void
  submitBidAction: (roomId: string, action: ClientBidAction) => void
  showLobby: (errorText?: string | null) => void
}

type ActiveRoomFlowController = {
  render: () => void
  enterActiveRoom: (message: MatchFoundMessage) => void
  handleServerMessage: (message: ServerMessage) => boolean
  setConnected: (value: boolean) => void
  setConnectionError: (message: string | null) => void
  setConnectionState: (isConnected: boolean, message: string | null) => void
  leaveActiveRoom: () => void
  hasActiveRoom: () => boolean
}

type CuttingAnimationCache = {
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

type DealingAnimationCache = {
  activePhaseKey: string | null
  renderedPhaseKey: string | null
  renderedFirstDealSeat: Seat | null
  startedAt: number
  completionTimerId: number | null
  isAnimating: boolean
  hasCompleted: boolean
}

type BiddingUiState = {
  lastKnownEntriesCount: number
  pendingBidSent: boolean
  wasMyTurn: boolean
  recentBubbles: Partial<Record<Seat, { label: string; startedAt: number }>>
  bubbleTimerIds: Partial<Record<Seat, number>>
  showBotTakeover: boolean
  botTakeoverTimerId: number | null
}

const SEAT_LABELS: Record<Seat, string> = {
  bottom: 'Долу',
  right: 'Дясно',
  top: 'Горе',
  left: 'Ляво',
}

const SERVER_DEAL_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

function getSeatAfterDealerForDealFallback(dealerSeat: Seat | null): Seat | null {
  if (dealerSeat === null) {
    return null
  }

  const dealerIndex = SERVER_DEAL_ORDER.indexOf(dealerSeat)

  if (dealerIndex === -1) {
    return null
  }

  return SERVER_DEAL_ORDER[(dealerIndex + 1) % SERVER_DEAL_ORDER.length]
}

const ACTIVE_ROOM_STAGE_WIDTH = 1600
const ACTIVE_ROOM_STAGE_HEIGHT = 900
const ACTIVE_ROOM_MAX_STAGE_SCALE = 1.06
const ACTIVE_ROOM_MIN_STAGE_SCALE = 0.46
const ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING = 20
const ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING = 20

function getCuttingCycleKey(roomId: string, game: RoomGameSnapshot | null): string | null {
  const cuttingSnapshot = game?.cutting ?? null
  const cutterSeat = cuttingSnapshot?.cutterSeat ?? null
  const dealerSeat = game?.dealerSeat ?? null
  const timerDeadlineAt = game?.timerDeadlineAt ?? 'no-timer'

  if (!cuttingSnapshot || !cutterSeat) {
    return null
  }

  return `${roomId}:${dealerSeat ?? 'no-dealer'}:${cutterSeat}:${timerDeadlineAt}`
}

function getDealFirstThreePhaseKey(roomId: string, game: RoomGameSnapshot | null): string | null {
  if (!game) {
    return null
  }

  const isLiveFirstDealPhase = game.authoritativePhase === 'deal-first-3'
  const isAlreadyPastFirstDeal =
    game.authoritativePhase === 'deal-next-2' ||
    game.authoritativePhase === 'bidding' ||
    game.authoritativePhase === 'deal-last-3' ||
    game.authoritativePhase === 'playing' ||
    game.authoritativePhase === 'scoring'

  if (!isLiveFirstDealPhase && !(isAlreadyPastFirstDeal && hasVisibleFirstThreeHands(game))) {
    return null
  }

  const dealerSeat = game.dealerSeat ?? null
  const firstDealSeat = game.firstDealSeat ?? getSeatAfterDealerForDealFallback(dealerSeat)

  return `${roomId}:deal-first-3:${dealerSeat ?? 'no-dealer'}:${firstDealSeat ?? 'no-first-deal'}`
}

function hasVisibleFirstThreeHands(game: RoomGameSnapshot | null): boolean {
  if (!game) {
    return false
  }

  return (
    game.handCounts.bottom >= 3 &&
    game.handCounts.right >= 3 &&
    game.handCounts.top >= 3 &&
    game.handCounts.left >= 3
  )
}

function shouldKeepFirstThreeHandsVisible(game: RoomGameSnapshot | null): boolean {
  return hasVisibleFirstThreeHands(game)
}

function getDealNextTwoPhaseKey(roomId: string, game: RoomGameSnapshot | null): string | null {
  if (!game) {
    return null
  }

  const isLiveNextTwoPhase = game.authoritativePhase === 'deal-next-2'
  const isAlreadyPastNextTwo =
    game.authoritativePhase === 'bidding' ||
    game.authoritativePhase === 'deal-last-3' ||
    game.authoritativePhase === 'playing' ||
    game.authoritativePhase === 'scoring'

  if (!isLiveNextTwoPhase && !(isAlreadyPastNextTwo && hasVisibleNextTwoHands(game))) {
    return null
  }

  const dealerSeat = game.dealerSeat ?? null
  const firstDealSeat = game.firstDealSeat ?? getSeatAfterDealerForDealFallback(dealerSeat)

  return `${roomId}:deal-next-2:${dealerSeat ?? 'no-dealer'}:${firstDealSeat ?? 'no-first-deal'}`
}

function hasVisibleNextTwoHands(game: RoomGameSnapshot | null): boolean {
  if (!game) {
    return false
  }

  return (
    game.handCounts.bottom >= 5 &&
    game.handCounts.right >= 5 &&
    game.handCounts.top >= 5 &&
    game.handCounts.left >= 5
  )
}

function shouldKeepNextTwoHandsVisible(game: RoomGameSnapshot | null): boolean {
  return hasVisibleNextTwoHands(game)
}

export function createActiveRoomFlowController(
  options: CreateActiveRoomFlowControllerOptions,
): ActiveRoomFlowController {
  const pendingRoomSnapshots = new Map<string, RoomSnapshotMessage>()
  let activeRoomState: ActiveRoomState | null = null
  const cuttingVisualCountdown = createCuttingVisualCountdownTracker()
  const cuttingAnimation: CuttingAnimationCache = {
    armedCycleKey: null,
    pendingCycleKey: null,
    activeCycleKey: null,
    activeSelectionKey: null,
    renderedSelectionKey: null,
    startedAt: 0,
    completionTimerId: null,
    latchedCuttingSnapshot: null,
    latchedCutterDisplayName: '',
    latchedDealerSeat: null,
    isAnimating: false,
    hasCompleted: false,
  }
  const dealingAnimation: DealingAnimationCache = {
    activePhaseKey: null,
    renderedPhaseKey: null,
    renderedFirstDealSeat: null,
    startedAt: 0,
    completionTimerId: null,
    isAnimating: false,
    hasCompleted: false,
  }
  const dealNextTwoAnimation: DealingAnimationCache = {
    activePhaseKey: null,
    renderedPhaseKey: null,
    renderedFirstDealSeat: null,
    startedAt: 0,
    completionTimerId: null,
    isAnimating: false,
    hasCompleted: false,
  }
  const biddingUiState: BiddingUiState = {
    lastKnownEntriesCount: 0,
    pendingBidSent: false,
    wasMyTurn: false,
    recentBubbles: {},
    bubbleTimerIds: {},
    showBotTakeover: false,
    botTakeoverTimerId: null,
  }

  function escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function createSeatCardHtml(seat: RoomSeatSnapshot): string {
    const displayName = seat.isOccupied ? seat.displayName : 'Свободно място'
    const occupancyText = seat.isOccupied
      ? seat.isBot
        ? 'Бот'
        : 'Играч'
      : 'Празно'
    const connectionText = seat.isOccupied
      ? seat.isConnected
        ? 'Свързан'
        : 'Изключен'
      : '—'

    return `
      <div
        style="
          border:1px solid rgba(148,163,184,0.22);
          border-radius:18px;
          padding:16px;
          background:rgba(15,23,42,0.58);
          box-shadow:0 14px 36px rgba(2,6,23,0.28);
        "
      >
        <div
          style="
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:12px;
            margin-bottom:12px;
          "
        >
          <div
            style="
              font-size:12px;
              font-weight:800;
              letter-spacing:0.08em;
              text-transform:uppercase;
              color:#93c5fd;
            "
          >
            ${SEAT_LABELS[seat.seat]}
          </div>

          <div
            style="
              font-size:11px;
              font-weight:800;
              color:${seat.isOccupied ? '#c4b5fd' : '#94a3b8'};
              text-transform:uppercase;
              letter-spacing:0.06em;
            "
          >
            ${occupancyText}
          </div>
        </div>

        <div
          style="
            display:flex;
            align-items:center;
            gap:12px;
          "
        >
          <div
            style="
              width:56px;
              height:56px;
              border-radius:16px;
              background:linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
              border:1px solid rgba(148,163,184,0.24);
              overflow:hidden;
              flex:0 0 56px;
            "
          >
            ${
              seat.avatarUrl
                ? `<img
                    src="${escapeHtml(seat.avatarUrl)}"
                    alt="${escapeHtml(displayName)}"
                    style="width:100%;height:100%;object-fit:cover;display:block;"
                  />`
                : `<div
                    style="
                      width:100%;
                      height:100%;
                      display:flex;
                      align-items:center;
                      justify-content:center;
                      color:#94a3b8;
                      font-size:11px;
                      font-weight:800;
                      letter-spacing:0.06em;
                      text-transform:uppercase;
                    "
                  >
                    Аватар
                  </div>`
            }
          </div>

          <div style="min-width:0;flex:1 1 auto;">
            <div
              style="
                font-size:16px;
                font-weight:800;
                color:#f8fafc;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
              "
            >
              ${escapeHtml(displayName)}
            </div>

            <div
              style="
                margin-top:4px;
                font-size:12px;
                color:#cbd5e1;
              "
            >
              ${connectionText}
            </div>
          </div>
        </div>
      </div>
    `
  }

  function getActiveRoomStageMetrics(): {
    stageScale: number
    scaledStageWidth: number
    scaledStageHeight: number
  } {
    return getViewportStageMetrics({
      baseWidth: ACTIVE_ROOM_STAGE_WIDTH,
      baseHeight: ACTIVE_ROOM_STAGE_HEIGHT,
      minScale: ACTIVE_ROOM_MIN_STAGE_SCALE,
      maxScale: ACTIVE_ROOM_MAX_STAGE_SCALE,
      viewportHorizontalPadding: ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
      viewportVerticalPadding: ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
    })
  }

  function cancelCuttingAnimationCompletionTimer(): void {
    if (cuttingAnimation.completionTimerId === null) {
      return
    }

    window.clearTimeout(cuttingAnimation.completionTimerId)
    cuttingAnimation.completionTimerId = null
  }

  function clearCuttingAnimationLatch(): void {
    cuttingAnimation.activeCycleKey = null
    cuttingAnimation.activeSelectionKey = null
    cuttingAnimation.renderedSelectionKey = null
    cuttingAnimation.startedAt = 0
    cuttingAnimation.latchedCuttingSnapshot = null
    cuttingAnimation.latchedCutterDisplayName = ''
    cuttingAnimation.latchedDealerSeat = null
    cuttingAnimation.isAnimating = false
    cuttingAnimation.hasCompleted = false
  }

  function clearPendingCutSubmission(): void {
    cuttingAnimation.pendingCycleKey = null
  }

  function resetCuttingAnimationState(): void {
    cancelCuttingAnimationCompletionTimer()
    cuttingAnimation.armedCycleKey = null
    clearPendingCutSubmission()
    clearCuttingAnimationLatch()
  }

  function cancelDealingAnimationCompletionTimer(): void {
    if (dealingAnimation.completionTimerId === null) {
      return
    }

    window.clearTimeout(dealingAnimation.completionTimerId)
    dealingAnimation.completionTimerId = null
  }

  function clearDealingAnimationState(): void {
    cancelDealingAnimationCompletionTimer()
    dealingAnimation.activePhaseKey = null
    dealingAnimation.renderedPhaseKey = null
    dealingAnimation.renderedFirstDealSeat = null
    dealingAnimation.startedAt = 0
    dealingAnimation.isAnimating = false
    dealingAnimation.hasCompleted = false
  }

  function scheduleDealingAnimationCompletion(): void {
    if (!dealingAnimation.isAnimating || dealingAnimation.completionTimerId !== null) {
      return
    }

    const remainingMs = Math.max(
      0,
      DEAL_FIRST_THREE_VISUAL_TOTAL_MS - (performance.now() - dealingAnimation.startedAt),
    )

    dealingAnimation.completionTimerId = window.setTimeout(() => {
      dealingAnimation.completionTimerId = null

      if (!activeRoomState || !dealingAnimation.isAnimating) {
        return
      }

      dealingAnimation.isAnimating = false
      dealingAnimation.hasCompleted = true
      renderActiveRoomScreen()
    }, remainingMs)
  }

  function cancelDealNextTwoAnimationCompletionTimer(): void {
    if (dealNextTwoAnimation.completionTimerId === null) {
      return
    }
    window.clearTimeout(dealNextTwoAnimation.completionTimerId)
    dealNextTwoAnimation.completionTimerId = null
  }

  function clearDealNextTwoAnimationState(): void {
    cancelDealNextTwoAnimationCompletionTimer()
    dealNextTwoAnimation.activePhaseKey = null
    dealNextTwoAnimation.renderedPhaseKey = null
    dealNextTwoAnimation.renderedFirstDealSeat = null
    dealNextTwoAnimation.startedAt = 0
    dealNextTwoAnimation.isAnimating = false
    dealNextTwoAnimation.hasCompleted = false
  }

  function scheduleDealNextTwoAnimationCompletion(): void {
    if (!dealNextTwoAnimation.isAnimating || dealNextTwoAnimation.completionTimerId !== null) {
      return
    }

    const remainingMs = Math.max(
      0,
      DEAL_NEXT_TWO_VISUAL_TOTAL_MS - (performance.now() - dealNextTwoAnimation.startedAt),
    )

    dealNextTwoAnimation.completionTimerId = window.setTimeout(() => {
      dealNextTwoAnimation.completionTimerId = null

      if (!activeRoomState || !dealNextTwoAnimation.isAnimating) {
        return
      }

      dealNextTwoAnimation.isAnimating = false
      dealNextTwoAnimation.hasCompleted = true
      // If the server has already moved past deal-next-2, trigger a re-render now.
      const postAnimPhase = activeRoomState.game?.authoritativePhase ?? null
      if (postAnimPhase !== null && postAnimPhase !== 'deal-next-2') {
        renderActiveRoomScreen()
      }
    }, remainingMs)
  }

  function clearBiddingUiState(): void {
    if (biddingUiState.botTakeoverTimerId !== null) {
      window.clearTimeout(biddingUiState.botTakeoverTimerId)
    }
    for (const timerId of Object.values(biddingUiState.bubbleTimerIds)) {
      if (timerId !== undefined) window.clearTimeout(timerId)
    }
    biddingUiState.lastKnownEntriesCount = 0
    biddingUiState.pendingBidSent = false
    biddingUiState.wasMyTurn = false
    biddingUiState.recentBubbles = {}
    biddingUiState.bubbleTimerIds = {}
    biddingUiState.showBotTakeover = false
    biddingUiState.botTakeoverTimerId = null
  }

  function addBidBubble(seat: Seat, label: string): void {
    const existing = biddingUiState.bubbleTimerIds[seat]
    if (existing !== undefined) window.clearTimeout(existing)

    biddingUiState.recentBubbles[seat] = { label, startedAt: performance.now() }
    biddingUiState.bubbleTimerIds[seat] = window.setTimeout(() => {
      delete biddingUiState.recentBubbles[seat]
      delete biddingUiState.bubbleTimerIds[seat]
      renderActiveRoomScreen()
    }, 3300)
  }

  function syncBiddingUiState(
    biddingSnapshot: RoomBiddingSnapshot | null,
    localSeat: Seat,
  ): void {
    if (!biddingSnapshot) {
      clearBiddingUiState()
      return
    }

    const currentCount = biddingSnapshot.entries.length

    // Detect new entries since last render
    if (currentCount > biddingUiState.lastKnownEntriesCount) {
      for (let i = biddingUiState.lastKnownEntriesCount; i < currentCount; i++) {
        const entry = biddingSnapshot.entries[i]
        if (entry) {
          addBidBubble(entry.seat, getBidActionLabel(entry.action))
          // If this entry is for the local seat and we didn't send it → bot takeover
          if (entry.seat === localSeat && !biddingUiState.pendingBidSent && biddingUiState.wasMyTurn) {
            biddingUiState.showBotTakeover = true
          }
          if (entry.seat === localSeat) {
            biddingUiState.pendingBidSent = false
          }
        }
      }
      biddingUiState.lastKnownEntriesCount = currentCount
    }

    biddingUiState.wasMyTurn = biddingSnapshot.canSubmitBid
  }

  function syncDealNextTwoAnimationState(roomId: string, game: RoomGameSnapshot | null): void {
    const phaseKey = getDealNextTwoPhaseKey(roomId, game)

    if (phaseKey === null) {
      if (!dealNextTwoAnimation.isAnimating) {
        clearDealNextTwoAnimationState()
      }
      return
    }

    if (dealNextTwoAnimation.activePhaseKey === phaseKey) {
      return
    }

    cancelDealNextTwoAnimationCompletionTimer()
    dealNextTwoAnimation.activePhaseKey = phaseKey
    dealNextTwoAnimation.renderedPhaseKey = null
    dealNextTwoAnimation.renderedFirstDealSeat = null
    dealNextTwoAnimation.startedAt = performance.now()
    dealNextTwoAnimation.isAnimating = true
    dealNextTwoAnimation.hasCompleted = false
    scheduleDealNextTwoAnimationCompletion()
  }

  function syncDealingAnimationState(roomId: string, game: RoomGameSnapshot | null): void {
    const phaseKey = getDealFirstThreePhaseKey(roomId, game)

    if (phaseKey === null) {
      if (!dealingAnimation.isAnimating) {
        clearDealingAnimationState()
      }

      return
    }

    if (dealingAnimation.activePhaseKey === phaseKey) {
      return
    }

    cancelDealingAnimationCompletionTimer()
    dealingAnimation.activePhaseKey = phaseKey
    dealingAnimation.renderedPhaseKey = null
    dealingAnimation.renderedFirstDealSeat = null
    dealingAnimation.startedAt = performance.now()
    dealingAnimation.isAnimating = true
    dealingAnimation.hasCompleted = false
    scheduleDealingAnimationCompletion()
  }

  function scheduleCuttingAnimationCompletion(): void {
    if (!cuttingAnimation.isAnimating || cuttingAnimation.completionTimerId !== null) {
      return
    }

    const remainingMs = Math.max(
      0,
      CUTTING_VISUAL_ANIMATION_TOTAL_MS - (performance.now() - cuttingAnimation.startedAt),
    )

    cuttingAnimation.completionTimerId = window.setTimeout(() => {
      cuttingAnimation.completionTimerId = null

      if (!activeRoomState || !cuttingAnimation.isAnimating) {
        return
      }

      cuttingAnimation.isAnimating = false
      cuttingAnimation.hasCompleted = true
      renderActiveRoomScreen()
    }, remainingMs)
  }

  function startCuttingAnimation(
    cuttingSnapshot: RoomCuttingSnapshot,
    cutterDisplayName: string,
    dealerSeat: Seat | null,
    cycleKey: string,
    selectionKey: string,
  ): void {
    cancelCuttingAnimationCompletionTimer()
    cuttingAnimation.activeCycleKey = cycleKey
    cuttingAnimation.activeSelectionKey = selectionKey
    cuttingAnimation.renderedSelectionKey = null
    cuttingAnimation.startedAt = performance.now()
    cuttingAnimation.latchedCuttingSnapshot = { ...cuttingSnapshot }
    cuttingAnimation.latchedCutterDisplayName = cutterDisplayName
    cuttingAnimation.latchedDealerSeat = dealerSeat
    cuttingAnimation.isAnimating = true
    cuttingAnimation.hasCompleted = false
    scheduleCuttingAnimationCompletion()
  }

  function syncCuttingAnimationState(
    roomId: string,
    game: RoomGameSnapshot | null,
    cuttingSnapshot: RoomCuttingSnapshot | null,
    cutterDisplayName: string,
    dealerSeat: Seat | null,
  ): void {
    const cycleKey = getCuttingCycleKey(roomId, game)
    const isAwaitingHumanCutSelection = game?.authoritativePhase === 'cutting'

    if (
      cuttingSnapshot &&
      cuttingSnapshot.selectedCutIndex === null &&
      cycleKey !== null &&
      isAwaitingHumanCutSelection
    ) {
      const shouldResetForNewPendingCycle =
        cuttingAnimation.activeCycleKey !== null &&
        (cuttingAnimation.activeCycleKey !== cycleKey ||
          (cuttingAnimation.activeCycleKey === cycleKey && cuttingAnimation.hasCompleted))

      if (shouldResetForNewPendingCycle) {
        cancelCuttingAnimationCompletionTimer()
        clearCuttingAnimationLatch()
      }

      if (cuttingAnimation.pendingCycleKey !== null && cuttingAnimation.pendingCycleKey !== cycleKey) {
        clearPendingCutSubmission()
      }

      cuttingAnimation.armedCycleKey = cycleKey
      return
    }

    if (cuttingSnapshot && cuttingSnapshot.selectedCutIndex !== null) {
      const selectionCycleKey =
        cuttingAnimation.activeCycleKey ?? cuttingAnimation.armedCycleKey ?? cycleKey
      const selectionKey =
        selectionCycleKey !== null ? `${selectionCycleKey}:${cuttingSnapshot.selectedCutIndex}` : null

      if (selectionCycleKey === null || selectionKey === null) {
        return
      }

      clearPendingCutSubmission()

      if (cuttingAnimation.activeCycleKey === selectionCycleKey) {
        if (cuttingAnimation.activeSelectionKey === selectionKey) {
          cuttingAnimation.latchedCuttingSnapshot = { ...cuttingSnapshot }
          cuttingAnimation.latchedCutterDisplayName = cutterDisplayName
          cuttingAnimation.latchedDealerSeat = dealerSeat
        }

        return
      }

      if (!cuttingAnimation.isAnimating) {
        startCuttingAnimation(
          cuttingSnapshot,
          cutterDisplayName,
          dealerSeat,
          selectionCycleKey,
          selectionKey,
        )
        return
      }

      return
    }

    if (!cuttingSnapshot && !cuttingAnimation.isAnimating) {
      resetCuttingAnimationState()
    }
  }

  function renderActiveRoomScreen(preferAnimationPatch = false): void {
    if (!activeRoomState) {
      return
    }

    const cuttingSnapshot = activeRoomState.game?.cutting ?? null
    const dealerSeat = activeRoomState.game?.dealerSeat ?? null
    const firstDealSeat = activeRoomState.game?.firstDealSeat ?? null
    const cutterSeat = cuttingSnapshot?.cutterSeat ?? null
    const cutterSeatSnapshot =
      cutterSeat !== null
        ? activeRoomState.seats.find((seat) => seat.seat === cutterSeat) ?? null
        : null
    const cutterDisplayName =
      cutterSeatSnapshot?.displayName.trim()
        ? cutterSeatSnapshot.displayName.trim()
        : cutterSeat !== null
          ? SEAT_LABELS[cutterSeat]
          : 'играч'
    syncCuttingAnimationState(
      activeRoomState.roomId,
      activeRoomState.game,
      cuttingSnapshot,
      cutterDisplayName,
      dealerSeat,
    )

    const authoritativePhase = activeRoomState.game?.authoritativePhase ?? null
    const shouldKeepFirstThreeHands = shouldKeepFirstThreeHandsVisible(activeRoomState.game)
    const currentCutCycleKey = getCuttingCycleKey(activeRoomState.roomId, activeRoomState.game)
    const isCutSubmissionPending =
      currentCutCycleKey !== null &&
      cuttingAnimation.pendingCycleKey === currentCutCycleKey &&
      cuttingSnapshot?.selectedCutIndex === null
    const shouldRenderCompletedCutAnimation =
      cuttingAnimation.hasCompleted &&
      cuttingSnapshot !== null &&
      !shouldKeepFirstThreeHands &&
      authoritativePhase !== 'deal-first-3'
    const shouldRenderCutAnimation =
      cuttingAnimation.isAnimating || shouldRenderCompletedCutAnimation
    if (!shouldRenderCutAnimation) {
      syncDealingAnimationState(activeRoomState.roomId, activeRoomState.game)
      if (dealingAnimation.hasCompleted || !dealingAnimation.isAnimating) {
        syncDealNextTwoAnimationState(activeRoomState.roomId, activeRoomState.game)
      }
    }

    const shouldRenderDealFirstThreeAnimation =
      (authoritativePhase === 'deal-first-3' && !dealingAnimation.hasCompleted) ||
      dealingAnimation.isAnimating
    const shouldRenderCompletedDealFirstThreeHands =
      !shouldRenderDealFirstThreeAnimation &&
      shouldKeepFirstThreeHands
    const shouldRenderDealNextTwoAnimation =
      (authoritativePhase === 'deal-next-2' && !dealNextTwoAnimation.hasCompleted) ||
      dealNextTwoAnimation.isAnimating
    const shouldRenderCompletedDealNextTwoHands =
      !shouldRenderDealNextTwoAnimation &&
      shouldKeepNextTwoHandsVisible(activeRoomState.game) &&
      authoritativePhase !== 'bidding'
    const isShowingAnyDealPhase =
      shouldRenderDealFirstThreeAnimation ||
      shouldRenderCompletedDealFirstThreeHands ||
      shouldRenderDealNextTwoAnimation ||
      shouldRenderCompletedDealNextTwoHands
    const isShowingBiddingPhase =
      !isShowingAnyDealPhase && authoritativePhase === 'bidding'

    if (isShowingBiddingPhase) {
      syncBiddingUiState(activeRoomState.game?.bidding ?? null, activeRoomState.seat)
    } else {
      clearBiddingUiState()
    }

    const cuttingSnapshotForRender =
      shouldRenderCutAnimation
        ? cuttingAnimation.latchedCuttingSnapshot ?? cuttingSnapshot
        : isShowingAnyDealPhase
          ? null
          : cuttingSnapshot
    const dealerSeatForRender =
      shouldRenderCutAnimation
        ? cuttingAnimation.latchedDealerSeat ?? dealerSeat
        : dealerSeat
    const dealFirstSeatForRender = firstDealSeat ?? getSeatAfterDealerForDealFallback(dealerSeat)
    const cutterSeatForRender = cuttingSnapshotForRender?.cutterSeat ?? null
    const cutterDisplayNameForRender =
      shouldRenderCutAnimation && cuttingAnimation.latchedCutterDisplayName.trim()
        ? cuttingAnimation.latchedCutterDisplayName
        : cutterDisplayName
    const isLocalPlayerCutter =
      cutterSeatForRender !== null && activeRoomState.seat === cutterSeatForRender
    const cutAnimationForRender: RenderCuttingAnimationState | null =
      shouldRenderCutAnimation && cuttingAnimation.latchedCuttingSnapshot?.selectedCutIndex !== null
        ? {
            elapsedMs: cuttingAnimation.isAnimating
              ? performance.now() - cuttingAnimation.startedAt
              : CUTTING_VISUAL_ANIMATION_TOTAL_MS,
            totalDurationMs: CUTTING_VISUAL_ANIMATION_TOTAL_MS,
          }
        : null
    const dealAnimationForRender: RenderDealingAnimationState | null =
      shouldRenderDealNextTwoAnimation && dealNextTwoAnimation.activePhaseKey !== null
        ? {
            elapsedMs: dealNextTwoAnimation.isAnimating
              ? performance.now() - dealNextTwoAnimation.startedAt
              : DEAL_NEXT_TWO_VISUAL_TOTAL_MS,
            totalDurationMs: DEAL_NEXT_TWO_VISUAL_TOTAL_MS,
          }
        : shouldRenderDealFirstThreeAnimation && dealingAnimation.activePhaseKey !== null
          ? {
              elapsedMs: dealingAnimation.isAnimating
                ? performance.now() - dealingAnimation.startedAt
                : DEAL_FIRST_THREE_VISUAL_TOTAL_MS,
              totalDurationMs: DEAL_FIRST_THREE_VISUAL_TOTAL_MS,
            }
          : null
    const activeDealPhase: 'deal-first-3' | 'deal-next-2' =
      shouldRenderDealNextTwoAnimation ? 'deal-next-2' : 'deal-first-3'
    const { stageScale, scaledStageWidth, scaledStageHeight } = getActiveRoomStageMetrics()

    if (cuttingSnapshotForRender) {
      const cuttingVisualCountdownContext = {
        roomId: activeRoomState.roomId,
        game: activeRoomState.game,
      }

      cuttingVisualCountdown.syncCuttingVisualCountdownState(cuttingVisualCountdownContext)
      const cuttingCountdownRemainingMs =
        cuttingVisualCountdown.getCuttingVisualCountdownRemainingMs(
          cuttingVisualCountdownContext,
        )
      const cuttingCountdownRemainingMsForRender =
        shouldRenderCutAnimation || isCutSubmissionPending
          ? null
          : cuttingCountdownRemainingMs
      const cuttingScreenHtml = renderCuttingScreen({
        cuttingSnapshot: cuttingSnapshotForRender,
        cutterDisplayName: cutterDisplayNameForRender,
        isInteractive:
          cutAnimationForRender === null &&
          !isCutSubmissionPending &&
          cuttingSnapshotForRender.canSubmitCut &&
          isLocalPlayerCutter,
        cutAnimation: cutAnimationForRender,
      })

      if (preferAnimationPatch && cutAnimationForRender !== null) {
        const cuttingVisualRoot = options.root.querySelector<HTMLDivElement>(
          '[data-active-room-cutting-visual="1"]',
        )

        if (cuttingVisualRoot) {
          if (
            cuttingAnimation.isAnimating &&
            cuttingAnimation.activeSelectionKey !== null &&
            cuttingAnimation.renderedSelectionKey === cuttingAnimation.activeSelectionKey
          ) {
            return
          }

          cuttingVisualRoot.innerHTML = cuttingScreenHtml
          cuttingAnimation.renderedSelectionKey = cuttingAnimation.activeSelectionKey
          return
        }
      }

      options.root.innerHTML = `
        <div
          style="
            position:relative;
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:
              radial-gradient(circle at center, rgba(74,222,128,0.18) 0%, rgba(34,197,94,0.10) 34%, rgba(21,128,61,0.00) 58%),
              linear-gradient(180deg, rgba(22,101,52,0.98) 0%, rgba(17,94,39,0.99) 100%);
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              position:relative;
              width:${scaledStageWidth}px;
              height:${scaledStageHeight}px;
              flex:0 0 auto;
            "
          >
            <div
              style="
                position:absolute;
                left:50%;
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                data-active-room-cutting-visual="1"
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:hidden;
                "
              >
                ${cuttingScreenHtml}
              </div>
            </div>
          </div>
          ${createCuttingSeatPanelsHtml({
            seats: activeRoomState.seats,
            localSeat: activeRoomState.seat,
            dealerSeat: dealerSeatForRender,
            cutterSeat: cutterSeatForRender,
            cuttingCountdownRemainingMs: cuttingCountdownRemainingMsForRender,
            panelScale: stageScale,
            escapeHtml,
            dealtHands: null,
            bidBubbles: null,
          })}
        </div>
      `

      if (cutAnimationForRender !== null) {
        cuttingAnimation.renderedSelectionKey = cuttingAnimation.activeSelectionKey
      }
    } else if (isShowingAnyDealPhase) {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()

      const handCounts = activeRoomState.game?.handCounts ?? {
        bottom: 0,
        right: 0,
        top: 0,
        left: 0,
      }
      const ownHand = activeRoomState.game?.ownHand ?? []

      const showPackets = shouldRenderDealFirstThreeAnimation || shouldRenderDealNextTwoAnimation

      const dealingScreenHtml = renderDealingScreen({
        firstDealSeat: dealFirstSeatForRender,
        selectedCutIndex:
          cuttingAnimation.latchedCuttingSnapshot?.selectedCutIndex ??
          cuttingSnapshot?.selectedCutIndex ??
          null,
        localSeat: activeRoomState.seat,
        handCounts,
        ownHand,
        stageScale,
        dealAnimation: dealAnimationForRender,
        showPackets,
        dealPhase: activeDealPhase,
      })

      const computeSeatAnimDelays = (): Partial<Record<Seat, number>> => {
        const firstIdx = SERVER_DEAL_ORDER.indexOf(dealFirstSeatForRender ?? 'bottom')
        const order = [0, 1, 2, 3].map(
          (offset) => SERVER_DEAL_ORDER[(firstIdx + offset) % 4],
        ) as Seat[]
        const delays: Partial<Record<Seat, number>> = {}
        order.forEach((seat, i) => {
          delays[seat] = DEAL_PACKET_START_DELAY_MS + i * DEAL_PACKET_DELAY_STEP_MS + 460
        })
        return delays
      }

      const dealtHandsForPanels: DealtHandsData | null = isShowingAnyDealPhase
        ? {
            handCounts,
            ownHand,
            localSeat: activeRoomState.seat,
            maxCardsPerSeat: shouldRenderDealNextTwoAnimation || shouldRenderCompletedDealNextTwoHands ? 5 : 3,
            animStartIndex: shouldRenderDealNextTwoAnimation ? 3 : 0,
            seatAnimDelays: showPackets ? computeSeatAnimDelays() : null,
          }
        : null

      const activeAnimCache = shouldRenderDealNextTwoAnimation ? dealNextTwoAnimation : dealingAnimation

      if (dealAnimationForRender !== null && showPackets) {
        const dealingVisualRoot = options.root.querySelector<HTMLDivElement>(
          '[data-active-room-dealing-visual="1"]',
        )

        if (
          dealingVisualRoot !== null &&
          activeAnimCache.isAnimating &&
          activeAnimCache.activePhaseKey !== null &&
          activeAnimCache.renderedPhaseKey === activeAnimCache.activePhaseKey &&
          activeAnimCache.renderedFirstDealSeat === dealFirstSeatForRender
        ) {
          return
        }
      }

      options.root.innerHTML = `
        <div
          style="
            position:relative;
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:
              radial-gradient(circle at center, rgba(74,222,128,0.18) 0%, rgba(34,197,94,0.10) 34%, rgba(21,128,61,0.00) 58%),
              linear-gradient(180deg, rgba(22,101,52,0.98) 0%, rgba(17,94,39,0.99) 100%);
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              position:relative;
              width:${scaledStageWidth}px;
              height:${scaledStageHeight}px;
              flex:0 0 auto;
            "
          >
            <div
              style="
                position:absolute;
                left:50%;
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                data-active-room-dealing-visual="1"
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:visible;
                "
              >
                ${dealingScreenHtml}
              </div>
            </div>
          </div>
          ${createCuttingSeatPanelsHtml({
            seats: activeRoomState.seats,
            localSeat: activeRoomState.seat,
            dealerSeat,
            cutterSeat: null,
            cuttingCountdownRemainingMs: null,
            panelScale: stageScale,
            escapeHtml,
            dealtHands: dealtHandsForPanels,
            bidBubbles: null,
          })}
        </div>
      `

      if (dealAnimationForRender !== null) {
        activeAnimCache.renderedPhaseKey = activeAnimCache.activePhaseKey
        activeAnimCache.renderedFirstDealSeat = dealFirstSeatForRender
      }

      syncDealingScreenTargets(options.root, stageScale)
    } else if (isShowingBiddingPhase) {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()

      const biddingSnapshot = activeRoomState.game!.bidding!
      const handCounts = activeRoomState.game?.handCounts ?? { bottom: 0, right: 0, top: 0, left: 0 }
      const ownHand = activeRoomState.game?.ownHand ?? []

      const dealtHandsForBidding: DealtHandsData = {
        handCounts,
        ownHand,
        localSeat: activeRoomState.seat,
        maxCardsPerSeat: 5,
        animStartIndex: 0,
        seatAnimDelays: null,
      }

      const bidBubbles: Partial<Record<Seat, SeatBidBubble>> = {}
      for (const [seat, bubble] of Object.entries(biddingUiState.recentBubbles) as [Seat, { label: string; startedAt: number }][]) {
        bidBubbles[seat] = {
          label: bubble.label,
          elapsedMs: Math.round(performance.now() - bubble.startedAt),
        }
      }

      const biddingStageHtml = renderBiddingStageHtml(
        biddingSnapshot.winningBid,
        biddingSnapshot.currentBidderSeat,
      )

      const biddingInteractionHtml = createBiddingInteractionHtml({
        biddingSnapshot,
        timerDeadlineAt: activeRoomState.game?.timerDeadlineAt ?? null,
        isPendingSubmission: biddingUiState.pendingBidSent,
        showBotTakeover: biddingUiState.showBotTakeover,
      })

      options.root.innerHTML = `
        <div
          style="
            position:relative;
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:
              radial-gradient(circle at center, rgba(74,222,128,0.18) 0%, rgba(34,197,94,0.10) 34%, rgba(21,128,61,0.00) 58%),
              linear-gradient(180deg, rgba(22,101,52,0.98) 0%, rgba(17,94,39,0.99) 100%);
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              position:relative;
              width:${scaledStageWidth}px;
              height:${scaledStageHeight}px;
              flex:0 0 auto;
            "
          >
            <div
              style="
                position:absolute;
                left:50%;
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:visible;
                "
              >
                ${biddingStageHtml}
              </div>
            </div>
          </div>
          ${createCuttingSeatPanelsHtml({
            seats: activeRoomState.seats,
            localSeat: activeRoomState.seat,
            dealerSeat,
            cutterSeat: null,
            cuttingCountdownRemainingMs: null,
            panelScale: stageScale,
            escapeHtml,
            dealtHands: dealtHandsForBidding,
            bidBubbles,
          })}
          ${biddingInteractionHtml}
        </div>
      `

      // Wire bid popup buttons
      options.root
        .querySelectorAll<HTMLButtonElement>('[data-bid-suit]')
        .forEach((btn) => {
          btn.addEventListener('click', () => {
            if (!activeRoomState || biddingUiState.pendingBidSent) return
            const suit = btn.dataset.bidSuit as 'clubs' | 'diamonds' | 'hearts' | 'spades'
            biddingUiState.pendingBidSent = true
            renderActiveRoomScreen()
            options.submitBidAction(activeRoomState.roomId, { type: 'suit', suit })
          })
        })

      options.root
        .querySelectorAll<HTMLButtonElement>('[data-bid-action]')
        .forEach((btn) => {
          btn.addEventListener('click', () => {
            if (!activeRoomState || biddingUiState.pendingBidSent) return
            const action = btn.dataset.bidAction as ClientBidAction['type']
            if (action === 'pass' || action === 'no-trumps' || action === 'all-trumps' || action === 'double' || action === 'redouble') {
              biddingUiState.pendingBidSent = true
              renderActiveRoomScreen()
              options.submitBidAction(activeRoomState.roomId, { type: action } as ClientBidAction)
            }
          })
        })

      const dismissBtn = options.root.querySelector<HTMLButtonElement>('[data-bot-takeover-dismiss="1"]')
      dismissBtn?.addEventListener('click', () => {
        biddingUiState.showBotTakeover = false
        renderActiveRoomScreen()
      })
    } else {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()
      const seatsHtml =
        activeRoomState.seats.length > 0
          ? activeRoomState.seats.map(createSeatCardHtml).join('')
          : `
            <div
              style="
                border:1px dashed rgba(148,163,184,0.28);
                border-radius:18px;
                padding:24px;
                color:#cbd5e1;
                text-align:center;
                background:rgba(15,23,42,0.42);
              "
            >
              Чакаме първия room snapshot от сървъра...
            </div>
          `

      options.root.innerHTML = `
        <div
          style="
            min-height:100vh;
            box-sizing:border-box;
            padding:${ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING / 2}px ${ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING / 2}px;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:
              radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 34%),
              linear-gradient(180deg, #081120 0%, #0f172a 100%);
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              position:relative;
              width:${scaledStageWidth}px;
              height:${scaledStageHeight}px;
              flex:0 0 auto;
            "
          >
            <div
              style="
                position:absolute;
                left:50%;
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:hidden;
                  background:
                    radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 34%),
                    linear-gradient(180deg, #081120 0%, #0f172a 100%);
                  color:#e2e8f0;
                "
              >
                <div
                  style="
                    width:1180px;
                    margin:0 auto;
                    padding:34px 0 40px;
                    display:grid;
                    gap:20px;
                  "
                >
                  <div
                    style="
                      border:1px solid rgba(148,163,184,0.18);
                      border-radius:24px;
                      padding:24px;
                      background:rgba(15,23,42,0.72);
                      box-shadow:0 24px 60px rgba(2,6,23,0.34);
                    "
                  >
                    <div
                      style="
                        display:flex;
                        flex-wrap:wrap;
                        align-items:center;
                        justify-content:space-between;
                        gap:16px;
                      "
                    >
                      <div>
                        <div
                          style="
                            font-size:12px;
                            font-weight:900;
                            letter-spacing:0.08em;
                            text-transform:uppercase;
                            color:#93c5fd;
                            margin-bottom:8px;
                          "
                        >
                          Активна стая
                        </div>

                        <h1
                          style="
                            margin:0;
                            font-size:30px;
                            line-height:1.1;
                            font-weight:900;
                            color:#f8fafc;
                          "
                        >
                          Намерена е игра
                        </h1>

                        <div
                          style="
                            margin-top:10px;
                            font-size:15px;
                            color:#cbd5e1;
                          "
                        >
                          Това е временен екран за стаята. Следващата стъпка е върху него
                          да вържем чистото server-authoritative gameplay ядро.
                        </div>
                      </div>

                      <button
                        type="button"
                        data-active-room-leave-button="1"
                        style="
                          border:0;
                          border-radius:16px;
                          padding:14px 18px;
                          background:linear-gradient(180deg, #8b5cf6 0%, #6d28d9 100%);
                          color:#f5f3ff;
                          font-size:14px;
                          font-weight:900;
                          cursor:pointer;
                          box-shadow:0 14px 32px rgba(76,29,149,0.28);
                        "
                      >
                        Напусни активната стая
                      </button>
                    </div>
                  </div>

                  <div
                    style="
                      display:grid;
                      grid-template-columns:repeat(4, minmax(0, 1fr));
                      gap:16px;
                    "
                  >
                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Стая
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${escapeHtml(activeRoomState.roomId)}
                      </div>
                    </div>

                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Твоето място
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${SEAT_LABELS[activeRoomState.seat]}
                      </div>
                    </div>

                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Залог
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${activeRoomState.stake}
                      </div>
                    </div>

                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Статус
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${
                          activeRoomState.isConnected
                            ? 'Свързан със сървъра'
                            : 'Връзката е прекъсната'
                        }
                      </div>
                    </div>
                  </div>

                  <div
                    style="
                      border:1px solid rgba(148,163,184,0.18);
                      border-radius:24px;
                      padding:24px;
                      background:rgba(15,23,42,0.72);
                    "
                  >
                    <div
                      style="
                        display:flex;
                        flex-wrap:wrap;
                        gap:10px 18px;
                        font-size:14px;
                        color:#cbd5e1;
                      "
                    >
                      <div><strong style="color:#f8fafc;">Хора:</strong> ${activeRoomState.humanPlayers}</div>
                      <div><strong style="color:#f8fafc;">Ботове:</strong> ${activeRoomState.botPlayers}</div>
                      <div><strong style="color:#f8fafc;">Статус на стаята:</strong> ${activeRoomState.roomStatus ?? 'няма още'}</div>
                      <div><strong style="color:#f8fafc;">Старт:</strong> ${
                        activeRoomState.shouldStartImmediately ? 'веднага' : 'нормален'
                      }</div>
                    </div>

                    ${
                      activeRoomState.errorText
                        ? `
                          <div
                            style="
                              margin-top:16px;
                              border-radius:16px;
                              padding:14px 16px;
                              background:rgba(127,29,29,0.34);
                              border:1px solid rgba(248,113,113,0.24);
                              color:#fecaca;
                              font-size:14px;
                              font-weight:700;
                            "
                          >
                            ${escapeHtml(activeRoomState.errorText)}
                          </div>
                        `
                        : ''
                    }
                  </div>

                  <div
                    style="
                      display:grid;
                      grid-template-columns:repeat(4, minmax(0, 1fr));
                      gap:16px;
                    "
                  >
                    ${seatsHtml}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `
    }

    const leaveButton = options.root.querySelector<HTMLButtonElement>(
      '[data-active-room-leave-button="1"]',
    )

    leaveButton?.addEventListener('click', () => {
      if (!activeRoomState) {
        return
      }

      if (!options.isConnected()) {
        activeRoomState.errorText = 'Няма връзка със сървъра.'
        renderActiveRoomScreen()
        return
      }

      options.leaveActiveRoom(activeRoomState.roomId)
    })

    options.root
      .querySelectorAll<HTMLButtonElement>('[data-active-room-cut-index]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          if (!activeRoomState) {
            return
          }

          const cutIndex = Number(button.dataset.activeRoomCutIndex)

          if (!Number.isInteger(cutIndex)) {
            return
          }

          if (!options.isConnected()) {
            activeRoomState.errorText = 'Няма връзка със сървъра.'
            renderActiveRoomScreen()
            return
          }

          const currentCycleKey = getCuttingCycleKey(activeRoomState.roomId, activeRoomState.game)

          if (
            currentCycleKey === null ||
            cuttingAnimation.pendingCycleKey === currentCycleKey ||
            cuttingAnimation.isAnimating
          ) {
            return
          }

          cuttingAnimation.pendingCycleKey = currentCycleKey
          renderActiveRoomScreen()
          options.submitCutIndex(activeRoomState.roomId, cutIndex)
        })
      })
  }

  function applyRoomSnapshotToActiveRoom(message: RoomSnapshotMessage): boolean {
    if (!activeRoomState) {
      return false
    }

    if (message.roomId !== activeRoomState.roomId) {
      return false
    }

    activeRoomState.roomStatus = message.roomStatus
    activeRoomState.reconnectToken = message.reconnectToken
    activeRoomState.seats = message.seats
    activeRoomState.game = message.game ?? null
    activeRoomState.errorText = null
    renderActiveRoomScreen(cuttingAnimation.isAnimating || dealingAnimation.isAnimating)
    return true
  }

  function enterActiveRoom(message: MatchFoundMessage): void {
    resetCuttingAnimationState()
    clearDealingAnimationState()
    clearDealNextTwoAnimationState()
    clearBiddingUiState()
    activeRoomState = {
      roomId: message.roomId,
      seat: message.seat,
      stake: message.stake,
      humanPlayers: message.humanPlayers,
      botPlayers: message.botPlayers,
      shouldStartImmediately: message.shouldStartImmediately,
      roomStatus: null,
      reconnectToken: null,
      seats: [],
      game: null,
      isConnected: options.isConnected(),
      errorText: null,
    }

    const pendingRoomSnapshot = pendingRoomSnapshots.get(message.roomId)

    if (pendingRoomSnapshot) {
      applyRoomSnapshotToActiveRoom(pendingRoomSnapshot)
      return
    }

    renderActiveRoomScreen()
  }

  function handleServerMessage(message: ServerMessage): boolean {
    if (message.type === 'room_snapshot') {
      pendingRoomSnapshots.set(message.roomId, message)

      if (applyRoomSnapshotToActiveRoom(message)) {
        return true
      }

      return false
    }

    if (!activeRoomState) {
      return false
    }

    if (message.type === 'left_active_room' && message.roomId === activeRoomState.roomId) {
      resetCuttingAnimationState()
      clearDealingAnimationState()
      activeRoomState = null
      options.showLobby(null)
      return true
    }

    if (message.type === 'room_resume_failed' && message.roomId === activeRoomState.roomId) {
      resetCuttingAnimationState()
      clearDealingAnimationState()
      activeRoomState = null
      options.showLobby(message.message)
      return true
    }

    if (message.type === 'error') {
      clearPendingCutSubmission()
      activeRoomState.errorText = message.message
      renderActiveRoomScreen()
      return true
    }

    return false
  }

  function setConnected(value: boolean): void {
    if (!activeRoomState) {
      return
    }

    if (!value) {
      clearPendingCutSubmission()
    }

    activeRoomState.isConnected = value
    renderActiveRoomScreen()
  }

  function setConnectionError(message: string | null): void {
    if (!activeRoomState) {
      return
    }

    if (message) {
      clearPendingCutSubmission()
    }

    activeRoomState.errorText = message
    renderActiveRoomScreen()
  }

  function setConnectionState(isConnected: boolean, message: string | null): void {
    if (!activeRoomState) {
      return
    }

    if (!isConnected || message) {
      clearPendingCutSubmission()
    }

    activeRoomState.isConnected = isConnected
    activeRoomState.errorText = message
    renderActiveRoomScreen()
  }

  function leaveActiveRoom(): void {
    if (!activeRoomState) {
      return
    }

    resetCuttingAnimationState()
    clearDealingAnimationState()
    clearDealNextTwoAnimationState()
    clearBiddingUiState()
    options.leaveActiveRoom(activeRoomState.roomId)
  }

  function hasActiveRoom(): boolean {
    return activeRoomState !== null
  }

  return {
    render: renderActiveRoomScreen,
    enterActiveRoom,
    handleServerMessage,
    setConnected,
    setConnectionError,
    setConnectionState,
    leaveActiveRoom,
    hasActiveRoom,
  }
}
