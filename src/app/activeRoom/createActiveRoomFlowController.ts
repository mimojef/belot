import {
  type ClientBidAction,
  type MatchFoundMessage,
  type RoomBiddingSnapshot,
  type RoomCuttingSnapshot,
  type RoomGameSnapshot,
  type RoomSeatSnapshot,
  type RoomSnapshotMessage,
  type RoomWinningBidSnapshot,
  type Seat,
  type ServerMessage,
} from '../network/createGameServerClient'
import {
  createCuttingSeatPanelsHtml,
  type DealtHandsData,
} from './cutting/renderCuttingSeatPanels'
import {
  type ActiveRoomFlowController,
  type ActiveRoomState,
  type BiddingUiState,
  type CreateActiveRoomFlowControllerOptions,
  type CuttingAnimationCache,
  type DealingAnimationCache,
  type PlayingUiCache,
} from './activeRoomTypes'
import {
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
  ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
  ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
  SERVER_DEAL_ORDER,
  createBiddingUiState,
  createCuttingAnimationCache,
  createDealingAnimationCache,
  createPlayingUiCache,
  escapeHtml,
  getActiveRoomStageMetrics,
  getSeatAfterDealerForDealFallback,
  resetPlayingUiCache,
} from './activeRoomShared'
import {
  getCuttingCycleKey,
  getDealFirstThreePhaseKey,
  getDealLastThreePhaseKey,
  getDealNextTwoPhaseKey,
  shouldKeepFirstThreeHandsVisible,
  shouldKeepLastThreeHandsVisible,
  shouldKeepNextTwoHandsVisible,
} from './activeRoomPhaseHelpers'
import {
  addBidBubble as addBidBubbleToState,
  clearBiddingUiState as clearBiddingUiStateFromStore,
  clearPendingBidSubmission as clearPendingBidSubmissionFromStore,
  getBidBubblesForRender as getBidBubblesForRenderFromStore,
} from './biddingUiState'
import { createCuttingVisualCountdownTracker } from './cutting/cuttingVisualCountdown'
import {
  CUTTING_VISUAL_ANIMATION_TOTAL_MS,
  type RenderCuttingAnimationState,
  renderCuttingScreen,
} from './renderCuttingScreen'
import {
  DEAL_FIRST_THREE_VISUAL_TOTAL_MS,
  DEAL_LAST_THREE_VISUAL_TOTAL_MS,
  DEAL_NEXT_TWO_VISUAL_TOTAL_MS,
  DEAL_PACKET_DELAY_STEP_MS,
  DEAL_PACKET_START_DELAY_MS,
  type RenderDealingAnimationState,
  renderDealingScreen,
  syncDealingScreenTargets,
} from './renderDealingScreen'
import {
  BID_BOT_DELAY_MS,
  BID_HUMAN_TIMEOUT_MS,
  getBidActionLabel,
  renderBiddingStageHtml,
  createBiddingInteractionHtml,
} from './renderBiddingScreen'
import { sortLocalHandForAllTrumps, sortLocalHandForDisplay, type SortDisplayOptions } from './sortLocalHand'
import { renderPlayingScreen, type RenderPlayingScreenOptions } from './renderPlayingScreen'

const SEAT_LABELS: Record<Seat, string> = {
  bottom: 'Долу',
  right: 'Дясно',
  top: 'Горе',
  left: 'Ляво',
}

export function createActiveRoomFlowController(
  options: CreateActiveRoomFlowControllerOptions,
): ActiveRoomFlowController {
  const pendingRoomSnapshots = new Map<string, RoomSnapshotMessage>()
  let activeRoomState: ActiveRoomState | null = null
  const cuttingVisualCountdown = createCuttingVisualCountdownTracker()
  const cuttingAnimation: CuttingAnimationCache = createCuttingAnimationCache()
  const dealingAnimation: DealingAnimationCache = createDealingAnimationCache()
  const dealNextTwoAnimation: DealingAnimationCache = createDealingAnimationCache()
  const dealLastThreeAnimation: DealingAnimationCache = createDealingAnimationCache()
  const biddingUiState: BiddingUiState = createBiddingUiState()
  const playingCache: PlayingUiCache = createPlayingUiCache()
  let lastKnownWinningBid: NonNullable<RoomWinningBidSnapshot> | null = null

  function getLocalSeatSnapshot(): RoomSeatSnapshot | null {
    if (!activeRoomState) {
      return null
    }

    return activeRoomState.seats.find((seat) => seat.seat === activeRoomState!.seat) ?? null
  }

  function renderPersistentBotTakeoverPopup(): string {
    return `
      <div
        data-bot-takeover-overlay="1"
        style="
          position:fixed;
          inset:0;
          z-index:10000;
          display:flex;
          align-items:center;
          justify-content:center;
          background:rgba(2,6,23,0.62);
          font-family:Inter, system-ui, sans-serif;
        "
      >
        <div style="
          width:min(88vw, 480px);
          background:rgba(15,23,42,0.98);
          border:1px solid rgba(148,163,184,0.22);
          border-radius:24px;
          padding:32px 28px;
          box-shadow:0 32px 72px rgba(0,0,0,0.42);
          text-align:center;
        ">
          <div style="
            font-size:40px;
            margin-bottom:18px;
            line-height:1;
          ">🤖</div>
          <div style="
            color:#f8fafc;
            font-size:18px;
            font-weight:700;
            line-height:1.5;
            margin-bottom:28px;
          ">
            Поради изтичане на времето за реакция,<br>играта беше поета от робот.
          </div>
          <button
            type="button"
            data-bot-takeover-dismiss="1"
            style="
              border:0;
              border-radius:14px;
              padding:14px 32px;
              background:linear-gradient(180deg,#3b82f6 0%,#1d4ed8 100%);
              color:#fff;
              font-size:16px;
              font-weight:800;
              cursor:pointer;
              font-family:inherit;
              box-shadow:0 8px 20px rgba(29,78,216,0.32);
            "
          >
            Върни се
          </button>
        </div>
      </div>
    `
  }

  function removePersistentBotTakeoverPopup(): void {
    document.body.querySelector('[data-bot-takeover-overlay="1"]')?.remove()
  }

  function syncPersistentBotTakeoverPopup(): void {
    const localSeatSnapshot = getLocalSeatSnapshot()

    if (!activeRoomState || !localSeatSnapshot?.isControlledByBot) {
      removePersistentBotTakeoverPopup()
      return
    }

    if (document.body.querySelector('[data-bot-takeover-overlay="1"]')) {
      return
    }

    document.body.insertAdjacentHTML('beforeend', renderPersistentBotTakeoverPopup())

    const dismissBtn = document.body.querySelector<HTMLButtonElement>('[data-bot-takeover-dismiss="1"]')
    dismissBtn?.addEventListener('click', () => {
      if (!activeRoomState) {
        return
      }

      if (!options.isConnected()) {
        activeRoomState.errorText = 'Няма връзка със сървъра.'
        renderActiveRoomScreen()
        return
      }

      options.resumeHumanControl(activeRoomState.roomId)
    })
  }

  function getContractSortOptions(): SortDisplayOptions {
    if (!lastKnownWinningBid) return { contract: 'default' }
    if (lastKnownWinningBid.contract === 'no-trumps') return { contract: 'no-trumps' }
    if (lastKnownWinningBid.contract === 'all-trumps') return { contract: 'all-trumps' }
    return { contract: 'suit', trumpSuit: lastKnownWinningBid.trumpSuit! }
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

  function cancelDealLastThreeAnimationCompletionTimer(): void {
    if (dealLastThreeAnimation.completionTimerId === null) {
      return
    }
    window.clearTimeout(dealLastThreeAnimation.completionTimerId)
    dealLastThreeAnimation.completionTimerId = null
  }

  function clearDealLastThreeAnimationState(): void {
    cancelDealLastThreeAnimationCompletionTimer()
    dealLastThreeAnimation.activePhaseKey = null
    dealLastThreeAnimation.renderedPhaseKey = null
    dealLastThreeAnimation.renderedFirstDealSeat = null
    dealLastThreeAnimation.startedAt = 0
    dealLastThreeAnimation.isAnimating = false
    dealLastThreeAnimation.hasCompleted = false
  }

  function scheduleDealLastThreeAnimationCompletion(): void {
    if (!dealLastThreeAnimation.isAnimating || dealLastThreeAnimation.completionTimerId !== null) {
      return
    }

    const remainingMs = Math.max(
      0,
      DEAL_LAST_THREE_VISUAL_TOTAL_MS - (performance.now() - dealLastThreeAnimation.startedAt),
    )

    dealLastThreeAnimation.completionTimerId = window.setTimeout(() => {
      dealLastThreeAnimation.completionTimerId = null

      if (!activeRoomState || !dealLastThreeAnimation.isAnimating) {
        return
      }

      dealLastThreeAnimation.isAnimating = false
      dealLastThreeAnimation.hasCompleted = true
      const postAnimPhase = activeRoomState.game?.authoritativePhase ?? null
      if (postAnimPhase !== null && postAnimPhase !== 'deal-last-3') {
        renderActiveRoomScreen()
      }
    }, remainingMs)
  }

  function clearBiddingUiState(): void {
    clearBiddingUiStateFromStore(biddingUiState)
  }

  function clearPendingBidSubmission(): void {
    clearPendingBidSubmissionFromStore(biddingUiState)
  }

  function addBidBubble(seat: Seat, label: string): void {
    addBidBubbleToState(biddingUiState, seat, label, () => renderActiveRoomScreen())
  }

  function getBidBubblesForRender() {
    return getBidBubblesForRenderFromStore(biddingUiState)
  }

  function submitBidActionFromUi(action: ClientBidAction): void {
    if (!activeRoomState || biddingUiState.pendingBidSent) {
      return
    }

    if (!options.isConnected()) {
      clearPendingBidSubmission()
      activeRoomState.errorText = 'Няма връзка със сървъра.'
      renderActiveRoomScreen()
      return
    }

    biddingUiState.pendingBidSent = true
    activeRoomState.errorText = null
    renderActiveRoomScreen()
    options.submitBidAction(activeRoomState.roomId, action)
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

  function syncDealLastThreeAnimationState(roomId: string, game: RoomGameSnapshot | null): void {
    const phaseKey = getDealLastThreePhaseKey(roomId, game)

    if (phaseKey === null) {
      if (!dealLastThreeAnimation.isAnimating) {
        clearDealLastThreeAnimationState()
      }
      return
    }

    if (dealLastThreeAnimation.activePhaseKey === phaseKey) {
      return
    }

    cancelDealLastThreeAnimationCompletionTimer()
    dealLastThreeAnimation.activePhaseKey = phaseKey
    dealLastThreeAnimation.renderedPhaseKey = null
    dealLastThreeAnimation.renderedFirstDealSeat = null
    dealLastThreeAnimation.startedAt = performance.now()
    dealLastThreeAnimation.isAnimating = true
    dealLastThreeAnimation.hasCompleted = false
    scheduleDealLastThreeAnimationCompletion()
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

    const freshWinningBid = activeRoomState.game?.bidding?.winningBid ?? null
    if (freshWinningBid !== null) {
      lastKnownWinningBid = freshWinningBid
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
        if (dealNextTwoAnimation.hasCompleted || !dealNextTwoAnimation.isAnimating) {
          syncDealLastThreeAnimationState(activeRoomState.roomId, activeRoomState.game)
        }
      }
    }

    const shouldRenderDealFirstThreeAnimation =
      (authoritativePhase === 'deal-first-3' && !dealingAnimation.hasCompleted) ||
      dealingAnimation.isAnimating
    const shouldRenderCompletedDealFirstThreeHands =
      !shouldRenderDealFirstThreeAnimation &&
      shouldKeepFirstThreeHands &&
      authoritativePhase !== 'bidding' &&
      authoritativePhase !== 'deal-last-3' &&
      authoritativePhase !== 'playing' &&
      authoritativePhase !== 'scoring'
    const shouldRenderDealNextTwoAnimation =
      (authoritativePhase === 'deal-next-2' && !dealNextTwoAnimation.hasCompleted) ||
      dealNextTwoAnimation.isAnimating
    const shouldRenderCompletedDealNextTwoHands =
      !shouldRenderDealNextTwoAnimation &&
      shouldKeepNextTwoHandsVisible(activeRoomState.game) &&
      authoritativePhase !== 'bidding' &&
      authoritativePhase !== 'deal-last-3' &&
      authoritativePhase !== 'playing' &&
      authoritativePhase !== 'scoring'
    const shouldRenderDealLastThreeAnimation =
      (authoritativePhase === 'deal-last-3' && !dealLastThreeAnimation.hasCompleted) ||
      dealLastThreeAnimation.isAnimating
    const shouldRenderCompletedDealLastThreeHands =
      !shouldRenderDealLastThreeAnimation &&
      shouldKeepLastThreeHandsVisible(activeRoomState.game) &&
      authoritativePhase !== 'playing' &&
      authoritativePhase !== 'scoring'
    const isShowingAnyDealPhase =
      shouldRenderDealFirstThreeAnimation ||
      shouldRenderCompletedDealFirstThreeHands ||
      shouldRenderDealNextTwoAnimation ||
      shouldRenderCompletedDealNextTwoHands ||
      shouldRenderDealLastThreeAnimation ||
      shouldRenderCompletedDealLastThreeHands
    const isShowingNextRoundPause = authoritativePhase === 'next-round'
    const isShowingBiddingPhase =
      !isShowingAnyDealPhase && authoritativePhase === 'bidding'
    const isShowingPlayingPhase =
      !isShowingAnyDealPhase && authoritativePhase === 'playing'
    if (!isShowingPlayingPhase) {
      resetPlayingUiCache(playingCache)
    }
    const shouldSyncBiddingSnapshot =
      isShowingBiddingPhase || authoritativePhase === 'deal-last-3' || isShowingNextRoundPause

    if (shouldSyncBiddingSnapshot) {
      syncBiddingUiState(activeRoomState.game?.bidding ?? null, activeRoomState.seat)
    } else if (!isShowingNextRoundPause) {
      clearBiddingUiState()
    }

    const cuttingSnapshotForRender =
      shouldRenderCutAnimation
        ? cuttingAnimation.latchedCuttingSnapshot ?? cuttingSnapshot
        : isShowingAnyDealPhase || isShowingBiddingPhase
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
      shouldRenderDealLastThreeAnimation && dealLastThreeAnimation.activePhaseKey !== null
        ? {
            elapsedMs: dealLastThreeAnimation.isAnimating
              ? performance.now() - dealLastThreeAnimation.startedAt
              : DEAL_LAST_THREE_VISUAL_TOTAL_MS,
            totalDurationMs: DEAL_LAST_THREE_VISUAL_TOTAL_MS,
          }
        : shouldRenderDealNextTwoAnimation && dealNextTwoAnimation.activePhaseKey !== null
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
    const activeDealPhase: 'deal-first-3' | 'deal-next-2' | 'deal-last-3' =
      shouldRenderDealLastThreeAnimation || shouldRenderCompletedDealLastThreeHands
        ? 'deal-last-3'
        : shouldRenderDealNextTwoAnimation || shouldRenderCompletedDealNextTwoHands
          ? 'deal-next-2'
          : 'deal-first-3'
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
      const bidBubblesForRender = getBidBubblesForRender()
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
            bidBubbles: isShowingNextRoundPause ? bidBubblesForRender : null,
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
      const showPackets =
        shouldRenderDealFirstThreeAnimation ||
        shouldRenderDealNextTwoAnimation ||
        shouldRenderDealLastThreeAnimation
      const rawOwnHand = activeRoomState.game?.ownHand ?? []

      const dealMaxCards =
        shouldRenderDealLastThreeAnimation || shouldRenderCompletedDealLastThreeHands
          ? 8
          : shouldRenderDealNextTwoAnimation || shouldRenderCompletedDealNextTwoHands
            ? 5
            : 3
      const dealPrevCards = showPackets
        ? shouldRenderDealLastThreeAnimation
          ? 5
          : shouldRenderDealNextTwoAnimation
            ? 3
            : 0
        : dealMaxCards
      const isLastThreeDeal = shouldRenderDealLastThreeAnimation || shouldRenderCompletedDealLastThreeHands
      const displaySortOptions: SortDisplayOptions = isLastThreeDeal
        ? getContractSortOptions()
        : { contract: 'default' }
      const displayOwnHand = sortLocalHandForDisplay(rawOwnHand.slice(0, dealMaxCards), displaySortOptions)
      const previousDisplayOwnHand = showPackets
        ? sortLocalHandForDisplay(rawOwnHand.slice(0, dealPrevCards), { contract: 'default' })
        : null
      const ownHand = displayOwnHand

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
            ownHand: displayOwnHand,
            previousOwnHand: previousDisplayOwnHand,
            localSeat: activeRoomState.seat,
            maxCardsPerSeat: dealMaxCards,
            animStartIndex:
              shouldRenderDealLastThreeAnimation
                ? 5
                : shouldRenderDealNextTwoAnimation
                  ? 3
                  : 0,
            seatAnimDelays: showPackets ? computeSeatAnimDelays() : null,
          }
        : null

      const activeAnimCache =
        shouldRenderDealLastThreeAnimation
          ? dealLastThreeAnimation
          : shouldRenderDealNextTwoAnimation
            ? dealNextTwoAnimation
            : dealingAnimation

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
            bidBubbles: getBidBubblesForRender(),
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

      const biddingGame = activeRoomState.game!
      const biddingSnapshot = biddingGame.bidding!
      const handCounts = biddingGame.handCounts ?? { bottom: 0, right: 0, top: 0, left: 0 }
      const ownHand = sortLocalHandForAllTrumps(biddingGame.ownHand ?? [])

      const dealtHandsForBidding: DealtHandsData = {
        handCounts,
        ownHand,
        previousOwnHand: null,
        localSeat: activeRoomState.seat,
        maxCardsPerSeat: 5,
        animStartIndex: 0,
        seatAnimDelays: null,
      }

      const bidBubbles = getBidBubblesForRender()

      const biddingStageHtml = renderBiddingStageHtml(
        biddingSnapshot.winningBid,
        biddingSnapshot.currentBidderSeat,
        handCounts,
      )
      const biddingCurrentSeatSnapshot =
        biddingSnapshot.currentBidderSeat !== null
          ? activeRoomState.seats.find((seat) => seat.seat === biddingSnapshot.currentBidderSeat) ?? null
          : null
      const biddingCountdownTotalMs = BID_HUMAN_TIMEOUT_MS
      const rawBiddingCountdownRemainingMs =
        biddingSnapshot.currentBidderSeat !== null &&
        biddingGame.timerDeadlineAt !== null
          ? Math.max(0, biddingGame.timerDeadlineAt - Date.now())
          : null
      const biddingCountdownRemainingMs =
        rawBiddingCountdownRemainingMs === null
          ? null
          : biddingCurrentSeatSnapshot?.isBot
            ? Math.max(
                0,
                BID_HUMAN_TIMEOUT_MS -
                  (BID_BOT_DELAY_MS - Math.min(BID_BOT_DELAY_MS, rawBiddingCountdownRemainingMs)),
              )
            : rawBiddingCountdownRemainingMs

      const biddingInteractionHtml = createBiddingInteractionHtml({
        biddingSnapshot,
        isPendingSubmission: biddingUiState.pendingBidSent,
        showBotTakeover: false,
      })

      const biddingErrorHtml = activeRoomState.errorText
        ? `
          <div
            style="
              position:fixed;
              left:50%;
              top:24px;
              transform:translateX(-50%);
              z-index:18;
              width:min(92vw, 560px);
              border-radius:16px;
              padding:14px 16px;
              background:rgba(127,29,29,0.86);
              border:1px solid rgba(248,113,113,0.34);
              box-shadow:0 14px 32px rgba(69,10,10,0.24);
              color:#fee2e2;
              font-size:14px;
              font-weight:700;
              line-height:1.4;
              text-align:center;
              font-family:Inter, system-ui, sans-serif;
            "
          >
            ${escapeHtml(activeRoomState.errorText)}
          </div>
        `
        : ''

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
            countdownSeat: biddingSnapshot.currentBidderSeat,
            countdownRemainingMs: biddingCountdownRemainingMs,
            countdownTotalMs: biddingCountdownTotalMs,
            highlightSeat: biddingSnapshot.currentBidderSeat,
            highlightBadgeLabel: null,
            panelScale: stageScale,
            escapeHtml,
            dealtHands: dealtHandsForBidding,
            bidBubbles,
          })}
          ${biddingErrorHtml}
          ${biddingInteractionHtml}
        </div>
      `

      // Wire bid popup buttons
      options.root
        .querySelectorAll<HTMLButtonElement>('[data-bid-suit]')
        .forEach((btn) => {
          btn.addEventListener('click', () => {
            const suit = btn.dataset.bidSuit as 'clubs' | 'diamonds' | 'hearts' | 'spades'
            submitBidActionFromUi({ type: 'suit', suit })
          })
        })

      options.root
        .querySelectorAll<HTMLButtonElement>('[data-bid-action]')
        .forEach((btn) => {
          btn.addEventListener('click', () => {
            const action = btn.dataset.bidAction as ClientBidAction['type']
            if (action === 'pass' || action === 'no-trumps' || action === 'all-trumps' || action === 'double' || action === 'redouble') {
              submitBidActionFromUi({ type: action })
            }
          })
        })

      const dismissBtn = options.root.querySelector<HTMLButtonElement>('[data-bot-takeover-dismiss="1"]')
      dismissBtn?.addEventListener('click', () => {
        biddingUiState.showBotTakeover = false
        renderActiveRoomScreen()
      })
    } else if (isShowingPlayingPhase && activeRoomState.game) {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()
      renderPlayingScreen({
        root: options.root,
        game: activeRoomState.game,
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        roomId: activeRoomState.roomId,
        winningBid: lastKnownWinningBid,
        stageScale,
        scaledStageWidth,
        scaledStageHeight,
        submitPlayCard: options.submitPlayCard,
        cache: playingCache,
      } satisfies RenderPlayingScreenOptions)
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

    syncPersistentBotTakeoverPopup()

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
    renderActiveRoomScreen(
      cuttingAnimation.isAnimating ||
        dealingAnimation.isAnimating ||
        dealNextTwoAnimation.isAnimating ||
        dealLastThreeAnimation.isAnimating,
    )
    return true
  }

  function enterActiveRoom(message: MatchFoundMessage): void {
    resetCuttingAnimationState()
    clearDealingAnimationState()
    clearDealNextTwoAnimationState()
    clearDealLastThreeAnimationState()
    clearBiddingUiState()
    lastKnownWinningBid = null
    resetPlayingUiCache(playingCache)
    removePersistentBotTakeoverPopup()
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
      clearDealNextTwoAnimationState()
      clearDealLastThreeAnimationState()
      clearBiddingUiState()
      lastKnownWinningBid = null
      resetPlayingUiCache(playingCache)
      removePersistentBotTakeoverPopup()
      activeRoomState = null
      options.showLobby(null)
      return true
    }

    if (message.type === 'room_resume_failed' && message.roomId === activeRoomState.roomId) {
      resetCuttingAnimationState()
      clearDealingAnimationState()
      clearDealNextTwoAnimationState()
      clearDealLastThreeAnimationState()
      clearBiddingUiState()
      lastKnownWinningBid = null
      resetPlayingUiCache(playingCache)
      removePersistentBotTakeoverPopup()
      activeRoomState = null
      options.showLobby(message.message)
      return true
    }

    if (message.type === 'error') {
      clearPendingCutSubmission()
      clearPendingBidSubmission()
      playingCache.pendingPlayCardSent = false
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
      clearPendingBidSubmission()
      playingCache.pendingPlayCardSent = false
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
      clearPendingBidSubmission()
      playingCache.pendingPlayCardSent = false
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
      clearPendingBidSubmission()
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
    clearDealLastThreeAnimationState()
    clearBiddingUiState()
    lastKnownWinningBid = null
    resetPlayingUiCache(playingCache)
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
