import type { AppBootstrap } from './bootstrap'
import type { Seat } from '../data/constants/seatOrder'
import type { BidAction, GameState, Suit } from '../core/state/gameTypes'
import { getBiddingViewState } from '../core/state/getBiddingViewState'
import { getBottomHandViewState } from '../core/state/getBottomHandViewState'
import { getPlayingViewState } from '../core/state/getPlayingViewState'
import { getScoringViewState } from '../core/state/getScoringViewState'
import { createAppAnimations } from './animations/createAppAnimations'
import { renderBiddingPanel } from '../ui/center/renderBiddingPanel'
import { renderBottomHandPanel } from '../ui/center/renderBottomHandPanel'
import { renderPlayingPanel } from '../ui/center/renderPlayingPanel'
import { renderScoringPanel } from '../ui/center/renderScoringPanel'
import { renderCenterDeck } from '../ui/center/renderCenterDeck'
import { getRoundSetupFlowResult } from '../ui/center/renderRoundSetupFlow'
import { renderSeatPanel } from '../ui/layout/renderSeatPanel'
import { renderScoreHud } from '../ui/layout/renderScoreHud'

type IncomingBidBubble = {
  entryKey: string
  seat: Seat
  label: string
}

type ActiveBidBubble = IncomingBidBubble & {
  shownAt: number
}

type RenderAppOptions = {
  onNextPhaseClick?: () => void
  onSelectCutIndex?: (cutIndex: number) => void
  onResolveCutClick?: () => void
  onBidPass?: () => void
  onBidSuit?: (suit: Suit) => void
  onBidNoTrumps?: () => void
  onBidAllTrumps?: () => void
  onBidDouble?: () => void
  onBidRedouble?: () => void
  onPlayCard?: (cardId: string) => void
  onRequestRender?: () => void
  playingCountdownRemainingMs?: number | null
  bottomBotTakeoverActive?: boolean
  bidBubbleOverride?: IncomingBidBubble | null
}

type PlayingStateWithTrickCollectionSnapshot = NonNullable<GameState['playing']> & {
  trickCollectionSnapshot?: null
}

const GAME_STAGE_WIDTH = 1600
const GAME_STAGE_HEIGHT = 900
const STAGE_EDGE_GAP = 5
const BOTTOM_SEAT_PANEL_HEIGHT = 98
const BOTTOM_HAND_GAP = -120
const BOTTOM_HAND_BOTTOM_OFFSET = STAGE_EDGE_GAP + BOTTOM_SEAT_PANEL_HEIGHT + BOTTOM_HAND_GAP
const SCORE_HUD_INTERNAL_OFFSET = 18
const CUTTING_COUNTDOWN_MS = 20000
const BIDDING_COUNTDOWN_MS = 20000
const BID_BUBBLE_VISIBLE_MS = 2000

let cutResolveTimeoutId: number | null = null
let roundSetupRerenderTimeoutId: number | null = null
let activeBiddingCountdownTurnKey: string | null = null
let activeBiddingCountdownStartedAt = 0
let bidBubbleHideTimeoutId: number | null = null
let activeBidBubble: ActiveBidBubble | null = null
let lastShownBidBubbleEntryKey: string | null = null

const appAnimations = createAppAnimations()

function clearCutResolveTimeout(): void {
  if (cutResolveTimeoutId !== null) {
    window.clearTimeout(cutResolveTimeoutId)
    cutResolveTimeoutId = null
  }
}

function clearRoundSetupRerenderTimeout(): void {
  if (roundSetupRerenderTimeoutId !== null) {
    window.clearTimeout(roundSetupRerenderTimeoutId)
    roundSetupRerenderTimeoutId = null
  }
}

function clearBidBubbleHideTimeout(): void {
  if (bidBubbleHideTimeoutId !== null) {
    window.clearTimeout(bidBubbleHideTimeoutId)
    bidBubbleHideTimeoutId = null
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function getStageScale(): number {
  if (typeof window === 'undefined') {
    return 1
  }

  const horizontalScale = window.innerWidth / GAME_STAGE_WIDTH
  const verticalScale = window.innerHeight / GAME_STAGE_HEIGHT

  return Math.min(horizontalScale, verticalScale, 1)
}

function getClockNowForPhaseTimestamp(timestamp: number | null | undefined): number {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now()
    }

    return Date.now()
  }

  if (timestamp > 1_000_000_000_000) {
    return Date.now()
  }

  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }

  return Date.now()
}

function getRenderClockNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }

  return Date.now()
}

function getCuttingCountdownRemainingMs(state: GameState): number {
  if (state.phase !== 'cutting') {
    return 0
  }

  if (!state.round.cutterSeat) {
    return 0
  }

  if (
    typeof state.round.selectedCutIndex === 'number' &&
    Number.isFinite(state.round.selectedCutIndex)
  ) {
    return 0
  }

  const phaseEnteredAt =
    typeof state.phaseEnteredAt === 'number' && Number.isFinite(state.phaseEnteredAt)
      ? state.phaseEnteredAt
      : null

  if (phaseEnteredAt === null) {
    return CUTTING_COUNTDOWN_MS
  }

  const now = getClockNowForPhaseTimestamp(phaseEnteredAt)
  const elapsedMs = Math.max(0, now - phaseEnteredAt)

  return Math.max(0, CUTTING_COUNTDOWN_MS - elapsedMs)
}

function getBiddingCountdownTurnKey(state: GameState): string | null {
  if (state.phase !== 'bidding') {
    return null
  }

  const currentSeat = state.bidding.currentSeat

  if (!currentSeat) {
    return null
  }

  return `${state.phase}:${state.bidding.entries.length}:${currentSeat}`
}

function syncBiddingCountdownState(state: GameState): void {
  const turnKey = getBiddingCountdownTurnKey(state)

  if (turnKey === null) {
    activeBiddingCountdownTurnKey = null
    activeBiddingCountdownStartedAt = 0
    return
  }

  if (activeBiddingCountdownTurnKey === turnKey) {
    return
  }

  activeBiddingCountdownTurnKey = turnKey
  activeBiddingCountdownStartedAt = getRenderClockNow()
}

function getBiddingCountdownRemainingMs(state: GameState): number {
  if (state.phase !== 'bidding') {
    return 0
  }

  const turnKey = getBiddingCountdownTurnKey(state)

  if (!turnKey) {
    return 0
  }

  if (
    activeBiddingCountdownTurnKey !== turnKey ||
    !Number.isFinite(activeBiddingCountdownStartedAt) ||
    activeBiddingCountdownStartedAt <= 0
  ) {
    return BIDDING_COUNTDOWN_MS
  }

  const now = getRenderClockNow()
  const elapsedMs = Math.max(0, now - activeBiddingCountdownStartedAt)

  return Math.max(0, BIDDING_COUNTDOWN_MS - elapsedMs)
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

function buildBidBubbleEntryKey(state: GameState): string | null {
  const lastEntry = state.bidding.entries.at(-1)

  if (!lastEntry) {
    return null
  }

  const phaseMarker =
    typeof state.phaseEnteredAt === 'number' && Number.isFinite(state.phaseEnteredAt)
      ? String(state.phaseEnteredAt)
      : 'no-phase-timestamp'

  const suitPart =
    lastEntry.action.type === 'suit'
      ? `:${lastEntry.action.suit}`
      : ''

  return `${phaseMarker}:${state.bidding.entries.length}:${lastEntry.seat}:${lastEntry.action.type}${suitPart}`
}

function showBidBubble(bubble: IncomingBidBubble): void {
  if (lastShownBidBubbleEntryKey === bubble.entryKey) {
    return
  }

  lastShownBidBubbleEntryKey = bubble.entryKey
  activeBidBubble = {
    ...bubble,
    shownAt: getRenderClockNow(),
  }

  clearBidBubbleHideTimeout()

  bidBubbleHideTimeoutId = window.setTimeout(() => {
    if (activeBidBubble?.entryKey !== bubble.entryKey) {
      return
    }

    activeBidBubble = null
    bidBubbleHideTimeoutId = null
  }, BID_BUBBLE_VISIBLE_MS)
}

function syncBidBubbleFromState(state: GameState): void {
  const lastEntry = state.bidding.entries.at(-1)
  const entryKey = buildBidBubbleEntryKey(state)

  if (!lastEntry || !entryKey) {
    return
  }

  showBidBubble({
    entryKey,
    seat: lastEntry.seat,
    label: formatBidBubbleLabel(lastEntry.action),
  })
}

function syncBidBubbleOverride(bubbleOverride: IncomingBidBubble): void {
  showBidBubble(bubbleOverride)
}

function renderBidBubble(seat: Seat, label: string, shownAt: number): string {
  const safeLabel = escapeHtml(label)
  const elapsedMs = Math.max(
    0,
    Math.min(BID_BUBBLE_VISIBLE_MS, getRenderClockNow() - shownAt)
  )

  const positionStyle =
    seat === 'top'
      ? `
        left:50%;
        top:190px;
        transform:translateX(-50%);
      `
      : seat === 'bottom'
        ? `
          left:50%;
          bottom:118px;
          transform:translateX(-50%);
        `
        : seat === 'left'
          ? `
            left:154px;
            top:50%;
            transform:translateY(-50%);
          `
          : `
            right:154px;
            top:50%;
            transform:translateY(-50%);
          `

  const pointerStyle =
    seat === 'top'
      ? `
        left:50%;
        top:-8px;
        transform:translateX(-50%) rotate(45deg);
      `
      : seat === 'bottom'
        ? `
          left:50%;
          bottom:-8px;
          transform:translateX(-50%) rotate(45deg);
        `
        : seat === 'left'
          ? `
            left:-8px;
            top:50%;
            transform:translateY(-50%) rotate(45deg);
          `
          : `
            right:-8px;
            top:50%;
            transform:translateY(-50%) rotate(45deg);
          `

  return `
    <style>
      @keyframes belot-bid-bubble-life {
        0% {
          opacity: 0;
          transform: translateY(8px) scale(0.96);
        }
        10% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        82% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        100% {
          opacity: 0;
          transform: translateY(-6px) scale(0.98);
        }
      }
    </style>

    <div
      style="
        position:absolute;
        ${positionStyle}
        z-index:12;
        pointer-events:none;
      "
    >
      <div
        style="
          position:relative;
          min-width:120px;
          max-width:240px;
          padding:14px 22px;
          border-radius:22px;
          background:rgba(255,255,255,0.98);
          color:#14181f;
          font-size:26px;
          line-height:1;
          font-weight:900;
          letter-spacing:0.01em;
          text-align:center;
          white-space:nowrap;
          box-shadow:
            0 16px 30px rgba(0,0,0,0.22),
            inset 0 1px 0 rgba(255,255,255,0.75);
          animation: belot-bid-bubble-life ${BID_BUBBLE_VISIBLE_MS}ms ease forwards;
          animation-delay: -${elapsedMs}ms;
        "
      >
        <div
          style="
            position:absolute;
            width:16px;
            height:16px;
            background:rgba(255,255,255,0.98);
            ${pointerStyle}
          "
        ></div>

        <div style="position:relative; z-index:2;">
          ${safeLabel}
        </div>
      </div>
    </div>
  `
}

function renderBidBubbleForSeat(seat: Seat): string {
  if (!activeBidBubble || activeBidBubble.seat !== seat) {
    return ''
  }

  return renderBidBubble(seat, activeBidBubble.label, activeBidBubble.shownAt)
}

function triggerCutResolveSequence(
  cutIndex: number,
  options: RenderAppOptions
): void {
  clearCutResolveTimeout()

  options.onSelectCutIndex?.(cutIndex)

  if (!options.onResolveCutClick) {
    return
  }

  cutResolveTimeoutId = window.setTimeout(() => {
    cutResolveTimeoutId = null
    options.onResolveCutClick?.()
  }, 920)
}

function getActionElements(rootElement: HTMLElement, actionName: string): HTMLElement[] {
  const selectorsByAction: Record<string, string[]> = {
    'bid-pass': [
      '#bid-pass',
      '[data-action="bid-pass"]',
      '[data-bid-action="pass"]',
      '[data-bid-pass]',
    ],
    'bid-suit': [
      '[data-action="bid-suit"]',
      '[data-bid-action="suit"]',
      '[data-bid-suit]',
    ],
    'bid-no-trumps': [
      '#bid-no-trumps',
      '[data-action="bid-no-trumps"]',
      '[data-bid-action="no-trumps"]',
      '[data-bid-no-trumps]',
    ],
    'bid-all-trumps': [
      '#bid-all-trumps',
      '[data-action="bid-all-trumps"]',
      '[data-bid-action="all-trumps"]',
      '[data-bid-all-trumps]',
    ],
    'bid-double': [
      '#bid-double',
      '[data-action="bid-double"]',
      '[data-bid-action="double"]',
      '[data-bid-double]',
    ],
    'bid-redouble': [
      '#bid-redouble',
      '[data-action="bid-redouble"]',
      '[data-bid-action="redouble"]',
      '[data-bid-redouble]',
    ],
    'play-card': [
      '[data-action="play-card"]',
      '[data-play-card]',
      '[data-card-action="play"]',
      '[data-card-id][data-playable="true"]',
      '[data-card-id][data-is-playable="true"]',
      '[data-card-id]',
    ],
  }

  const selectors = selectorsByAction[actionName] ?? []
  const uniqueElements = new Set<HTMLElement>()

  for (const selector of selectors) {
    rootElement.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      uniqueElements.add(element)
    })
  }

  return Array.from(uniqueElements)
}

function readSuitFromElement(element: HTMLElement): Suit | null {
  const datasetSuit =
    element.dataset.suit ??
    element.dataset.bidSuit ??
    element.getAttribute('data-suit') ??
    element.getAttribute('data-bid-suit')

  const valueSuit =
    'value' in element && typeof element.value === 'string' ? element.value : null

  const rawSuit = datasetSuit ?? valueSuit

  if (
    rawSuit === 'clubs' ||
    rawSuit === 'diamonds' ||
    rawSuit === 'hearts' ||
    rawSuit === 'spades'
  ) {
    return rawSuit
  }

  return null
}

function readCardIdFromElement(element: HTMLElement): string | null {
  const cardId =
    element.dataset.cardId ??
    element.getAttribute('data-card-id') ??
    null

  return cardId && cardId.length > 0 ? cardId : null
}

function bindClick(elements: HTMLElement[], handler?: () => void): void {
  if (!handler) {
    return
  }

  for (const element of elements) {
    element.addEventListener('click', (event) => {
      event.preventDefault()
      handler()
    })
  }
}

function bindSuitClicks(
  elements: HTMLElement[],
  handler?: (suit: Suit) => void
): void {
  if (!handler) {
    return
  }

  for (const element of elements) {
    element.addEventListener('click', (event) => {
      event.preventDefault()

      const suit = readSuitFromElement(element)
      if (!suit) {
        return
      }

      handler(suit)
    })
  }
}

function bindPlayCardClicks(
  elements: HTMLElement[],
  handler?: (cardId: string) => void
): void {
  if (!handler) {
    return
  }

  for (const element of elements) {
    element.addEventListener('click', (event) => {
      event.preventDefault()

      const cardId = readCardIdFromElement(element)
      if (!cardId) {
        return
      }

      handler(cardId)
    })
  }
}

function renderCenterPanel(content: string, width: number): string {
  return `
    <div
      style="
        width:${width}px;
        margin:0 auto;
      "
    >
      ${content}
    </div>
  `
}

export function renderApp(
  rootElement: HTMLElement,
  app: AppBootstrap,
  options: RenderAppOptions = {}
): void {
  const state = app.engine.getState()
  syncBiddingCountdownState(state)

  if (options.bidBubbleOverride) {
    syncBidBubbleOverride(options.bidBubbleOverride)
  } else {
    syncBidBubbleFromState(state)
  }

  const stageScale = getStageScale()
  const cuttingCountdownRemainingMs = getCuttingCountdownRemainingMs(state)
  const biddingCountdownRemainingMs = getBiddingCountdownRemainingMs(state)
  const bottomBotTakeoverActive = options.bottomBotTakeoverActive === true

  if (state.phase !== 'cutting') {
    clearCutResolveTimeout()
  }

  const trickCollectionState = appAnimations.getTrickCollectionState(state)
  const hasCompletedCurrentTrickCollection = appAnimations.hasCompletedTrick(
    trickCollectionState.trickKey
  )

  const hasPendingScoringTransition =
    state.phase === 'playing' && !!state.playing?.pendingScoringTransition

  if (hasPendingScoringTransition && hasCompletedCurrentTrickCollection) {
    app.engine.finalizePendingScoringTransition()

    if (options.onRequestRender) {
      options.onRequestRender()
    } else {
      renderApp(rootElement, app, options)
    }

    return
  }

  const shouldKeepAnimationController = state.phase === 'playing'

  if (!shouldKeepAnimationController) {
    appAnimations.reset()
  }

  const shouldHideCompletedTrickSnapshot =
    state.phase === 'playing' && hasCompletedCurrentTrickCollection

  let renderState = state

  if (shouldHideCompletedTrickSnapshot && renderState.playing) {
    const playingWithSnapshot =
      renderState.playing as PlayingStateWithTrickCollectionSnapshot

    renderState = {
      ...renderState,
      playing: {
        ...playingWithSnapshot,
        trickCollectionSnapshot: null,
      } as GameState['playing'],
    }
  }

  const isBiddingPhase = renderState.phase === 'bidding'
  const isPlayingPhase = renderState.phase === 'playing'
  const isScoringPhase = renderState.phase === 'scoring'
  const shouldShowScoringPanel = isScoringPhase

  const roundSetupFlow = getRoundSetupFlowResult({
    phase: renderState.phase,
    dealerSeat: state.round.dealerSeat,
    cutterSeat: state.round.cutterSeat,
    selectedCutIndex: state.round.selectedCutIndex,
    actualHandCounts: {
      bottom: state.hands.bottom.length,
      right: state.hands.right.length,
      top: state.hands.top.length,
      left: state.hands.left.length,
    },
    phaseEnteredAt: state.phaseEnteredAt,
  })

  clearRoundSetupRerenderTimeout()

  if (roundSetupFlow.nextRerenderInMs !== null) {
    roundSetupRerenderTimeoutId = window.setTimeout(() => {
      roundSetupRerenderTimeoutId = null
      renderApp(rootElement, app, options)
    }, roundSetupFlow.nextRerenderInMs)
  }

  const biddingViewState = isBiddingPhase ? getBiddingViewState(renderState) : null
  const playingViewState = isPlayingPhase ? getPlayingViewState(renderState) : null
  const scoringViewState = shouldShowScoringPanel
    ? {
        ...getScoringViewState(renderState),
        isVisible: true,
      }
    : null
  const bottomHandViewState = getBottomHandViewState(renderState)

  const shouldShowBottomBiddingPanel =
    !roundSetupFlow.isRoundSetupPhase &&
    biddingViewState !== null &&
    biddingViewState.currentSeat === 'bottom'

  const biddingOverlayContent = shouldShowBottomBiddingPanel
    ? renderCenterPanel(renderBiddingPanel(biddingViewState), 760)
    : ''

  const activeSeat: Seat | null = isBiddingPhase
    ? renderState.bidding.currentSeat
    : ((renderState.playing?.currentTurnSeat ?? null) as Seat | null)

  const shouldReuseCountdownForBidding =
    isBiddingPhase && activeSeat !== null

  const shouldReuseCountdownForPlaying =
    isPlayingPhase &&
    activeSeat !== null &&
    typeof options.playingCountdownRemainingMs === 'number' &&
    Number.isFinite(options.playingCountdownRemainingMs)

  const seatPanelPhase =
    shouldReuseCountdownForBidding || shouldReuseCountdownForPlaying
      ? 'cutting'
      : renderState.phase

  const seatPanelCountdownSeat =
    shouldReuseCountdownForBidding || shouldReuseCountdownForPlaying
      ? activeSeat
      : state.round.cutterSeat

  const seatPanelCountdownRemainingMs = shouldReuseCountdownForBidding
    ? biddingCountdownRemainingMs
    : shouldReuseCountdownForPlaying
      ? options.playingCountdownRemainingMs ?? 0
      : cuttingCountdownRemainingMs

  const centerMainContent = roundSetupFlow.isRoundSetupPhase
    ? roundSetupFlow.centerContent
    : scoringViewState
      ? renderCenterPanel(renderScoringPanel(scoringViewState), 980)
      : playingViewState
        ? renderCenterPanel(renderPlayingPanel(playingViewState), 980)
        : ''

  const shouldShowCenterDeck =
    roundSetupFlow.isRoundSetupPhase && !roundSetupFlow.shouldHideCenterDeck

  rootElement.innerHTML = `
    <div class="game-shell">
      <div
        class="game-stage"
        data-game-stage="1"
        data-stage-scale="${stageScale}"
        style="transform: translate(-50%, -50%) scale(${stageScale});"
      >
        <div
          style="
            position:relative;
            width:${GAME_STAGE_WIDTH}px;
            height:${GAME_STAGE_HEIGHT}px;
            overflow:visible;
            color:#ffffff;
          "
        >
          <div
            style="
              position:relative;
              width:100%;
              height:100%;
              padding:0;
              overflow:visible;
            "
          >
            <div
              style="
                position:absolute;
                left:50%;
                top:49%;
                transform:translate(-50%, -50%);
                width:1080px;
                z-index:2;
                display:flex;
                flex-direction:column;
                align-items:center;
                gap:26px;
              "
            >
              ${shouldShowCenterDeck ? renderCenterDeck(state.deck.length) : ''}
              ${centerMainContent}
            </div>
          </div>
        </div>
      </div>

      ${
        biddingOverlayContent
          ? `
        <div
          style="
            position:fixed;
            left:50%;
            top:35%;
            z-index:20;
            pointer-events:auto;
            transform:translate(-50%, -50%) scale(${stageScale});
            transform-origin:center center;
            width:1080px;
            display:flex;
            justify-content:center;
          "
        >
          ${biddingOverlayContent}
        </div>
      `
          : ''
      }

      <div
        style="
          position:fixed;
          top:${5 - SCORE_HUD_INTERNAL_OFFSET * stageScale}px;
          left:${5 - SCORE_HUD_INTERNAL_OFFSET * stageScale}px;
          width:0;
          height:0;
          z-index:8;
          pointer-events:none;
          transform:scale(${stageScale});
          transform-origin:top left;
        "
      >
        ${renderScoreHud(renderState)}
      </div>

      <div
        data-seat-anchor="top"
        style="
          position:fixed;
          left:50%;
          top:5px;
          z-index:7;
          pointer-events:none;
          transform:translateX(-50%) scale(${stageScale});
          transform-origin:top center;
        "
      >
        ${renderBidBubbleForSeat('top')}
        ${renderSeatPanel(
          'top',
          roundSetupFlow.seatHandCounts.top,
          state.round.dealerSeat,
          seatPanelCountdownSeat,
          activeSeat,
          seatPanelPhase,
          seatPanelCountdownRemainingMs
        )}
      </div>

      <div
        data-seat-anchor="left"
        style="
          position:fixed;
          left:5px;
          top:50%;
          z-index:7;
          pointer-events:none;
          transform:translateY(-50%) scale(${stageScale});
          transform-origin:left center;
        "
      >
        ${renderBidBubbleForSeat('left')}
        ${renderSeatPanel(
          'left',
          roundSetupFlow.seatHandCounts.left,
          state.round.dealerSeat,
          seatPanelCountdownSeat,
          activeSeat,
          seatPanelPhase,
          seatPanelCountdownRemainingMs
        )}
      </div>

      <div
        data-seat-anchor="right"
        style="
          position:fixed;
          right:5px;
          top:50%;
          z-index:7;
          pointer-events:none;
          transform:translateY(-50%) scale(${stageScale});
          transform-origin:right center;
        "
      >
        ${renderBidBubbleForSeat('right')}
        ${renderSeatPanel(
          'right',
          roundSetupFlow.seatHandCounts.right,
          state.round.dealerSeat,
          seatPanelCountdownSeat,
          activeSeat,
          seatPanelPhase,
          seatPanelCountdownRemainingMs
        )}
      </div>

      <div
        data-seat-anchor="bottom"
        style="
          position:fixed;
          left:50%;
          bottom:5px;
          z-index:7;
          pointer-events:none;
          overflow:visible;
          transform:translateX(-50%) scale(${stageScale});
          transform-origin:bottom center;
        "
      >
        ${renderBidBubbleForSeat('bottom')}

        ${
          !isScoringPhase &&
          bottomHandViewState.shouldShow
            ? `
          <div
            data-bottom-hand-root="1"
            style="
              position:absolute;
              left:50%;
              bottom:${BOTTOM_HAND_BOTTOM_OFFSET}px;
              transform:translateX(-50%);
              width:1040px;
              z-index:1;
              pointer-events:${bottomBotTakeoverActive ? 'none' : 'auto'};
            "
          >
            ${renderBottomHandPanel(bottomHandViewState)}
          </div>
        `
            : ''
        }

        <div
          style="
            position:relative;
            z-index:3;
            pointer-events:none;
          "
        >
          ${renderSeatPanel(
            'bottom',
            roundSetupFlow.seatHandCounts.bottom,
            state.round.dealerSeat,
            seatPanelCountdownSeat,
            activeSeat,
            seatPanelPhase,
            seatPanelCountdownRemainingMs
          )}
        </div>
      </div>

      <div
        style="
          position:fixed;
          right:18px;
          top:18px;
          z-index:30;
          pointer-events:auto;
          display:flex;
          flex-direction:column;
          align-items:flex-end;
          gap:10px;
        "
      >
        <div
          style="
            padding:8px 12px;
            border-radius:10px;
            background:rgba(6, 22, 40, 0.92);
            border:1px solid rgba(255,255,255,0.12);
            color:#f4f8ff;
            font-size:12px;
            font-weight:800;
            letter-spacing:0.06em;
            text-transform:uppercase;
            box-shadow:0 10px 24px rgba(0,0,0,0.18);
          "
        >
          Фаза: ${renderState.phase}
        </div>

        <button
          type="button"
          data-action="debug-next-phase"
          ${options.onNextPhaseClick ? '' : 'disabled'}
          style="
            min-width:160px;
            height:46px;
            padding:0 18px;
            border:none;
            border-radius:12px;
            background:${options.onNextPhaseClick ? 'rgba(245, 187, 55, 0.98)' : 'rgba(120,120,120,0.7)'};
            color:#13253d;
            font-size:14px;
            font-weight:900;
            letter-spacing:0.04em;
            cursor:${options.onNextPhaseClick ? 'pointer' : 'default'};
            box-shadow:0 12px 24px rgba(0,0,0,0.20);
          "
        >
          Следваща фаза
        </button>
      </div>
    </div>
  `

  const debugNextPhaseButton = rootElement.querySelector<HTMLButtonElement>(
    '[data-action="debug-next-phase"]'
  )

  if (debugNextPhaseButton && options.onNextPhaseClick) {
    debugNextPhaseButton.addEventListener('click', (event) => {
      event.preventDefault()
      options.onNextPhaseClick?.()
    })
  }

  const cutCardButtons = rootElement.querySelectorAll<HTMLButtonElement>(
    '[data-action="cut-card"]'
  )

  for (const button of cutCardButtons) {
    button.addEventListener('click', () => {
      const rawCutIndex = button.dataset.cutIndex
      const cutIndex = rawCutIndex ? Number(rawCutIndex) : NaN

      if (Number.isNaN(cutIndex)) {
        return
      }

      triggerCutResolveSequence(cutIndex, options)
    })
  }

  if (isBiddingPhase) {
    bindClick(getActionElements(rootElement, 'bid-pass'), options.onBidPass)
    bindSuitClicks(getActionElements(rootElement, 'bid-suit'), options.onBidSuit)
    bindClick(
      getActionElements(rootElement, 'bid-no-trumps'),
      options.onBidNoTrumps
    )
    bindClick(
      getActionElements(rootElement, 'bid-all-trumps'),
      options.onBidAllTrumps
    )
    bindClick(getActionElements(rootElement, 'bid-double'), options.onBidDouble)
    bindClick(
      getActionElements(rootElement, 'bid-redouble'),
      options.onBidRedouble
    )
  }

  if (state.phase === 'playing' && isPlayingPhase && !bottomBotTakeoverActive) {
    bindPlayCardClicks(getActionElements(rootElement, 'play-card'), options.onPlayCard)
  }

  if (shouldKeepAnimationController) {
    void appAnimations.sync(state).then(() => {
      const latestState = app.engine.getState()

      if (latestState.phase !== 'playing' || !latestState.playing?.pendingScoringTransition) {
        return
      }

      const latestTrickCollectionState = appAnimations.getTrickCollectionState(latestState)

      if (!appAnimations.hasCompletedTrick(latestTrickCollectionState.trickKey)) {
        return
      }

      app.engine.finalizePendingScoringTransition()

      if (options.onRequestRender) {
        options.onRequestRender()
      } else {
        renderApp(rootElement, app, options)
      }
    })
  }
}