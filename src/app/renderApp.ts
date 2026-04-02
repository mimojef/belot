import type { AppBootstrap } from './bootstrap'
import type { Seat } from '../data/constants/seatOrder'
import type { Suit } from '../core/state/gameTypes'
import { getBiddingViewState } from '../core/state/getBiddingViewState'
import { getBottomHandViewState } from '../core/state/getBottomHandViewState'
import { getScoringViewState } from '../core/state/getScoringViewState'
import { renderBiddingPanel } from '../ui/center/renderBiddingPanel'
import { renderBottomHandPanel } from '../ui/center/renderBottomHandPanel'
import { renderScoringPanel } from '../ui/center/renderScoringPanel'
import { renderCenterDeck } from '../ui/center/renderCenterDeck'
import { getRoundSetupFlowResult } from '../ui/center/renderRoundSetupFlow'
import { renderSeatPanel } from '../ui/layout/renderSeatPanel'
import { renderScoreHud } from '../ui/layout/renderScoreHud'

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
}

const GAME_STAGE_WIDTH = 1600
const GAME_STAGE_HEIGHT = 900
const STAGE_EDGE_GAP = 5
const SEAT_PANEL_HEIGHT = 176
const BOTTOM_HAND_GAP = 12
const BOTTOM_HAND_BOTTOM_OFFSET = STAGE_EDGE_GAP + SEAT_PANEL_HEIGHT + BOTTOM_HAND_GAP
const SCORE_HUD_INTERNAL_OFFSET = 18

let cutResolveTimeoutId: number | null = null
let roundSetupRerenderTimeoutId: number | null = null

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

function getStageScale(): number {
  if (typeof window === 'undefined') {
    return 1
  }

  const horizontalScale = window.innerWidth / GAME_STAGE_WIDTH
  const verticalScale = window.innerHeight / GAME_STAGE_HEIGHT

  return Math.min(horizontalScale, verticalScale, 1)
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
    'play-card': ['[data-action="play-card"]'],
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
  const cardId = element.dataset.cardId ?? element.getAttribute('data-card-id') ?? null
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
  const stageScale = getStageScale()

  const isBiddingPhase = state.phase === 'bidding'
  const isPlayingPhase = state.phase === 'playing'
  const isScoringPhase = state.phase === 'scoring'
  const isSummaryPhase = state.phase === 'summary'
  const shouldShowScoringPanel = isScoringPhase || isSummaryPhase

  if (state.phase !== 'cutting') {
    clearCutResolveTimeout()
  }

  const roundSetupFlow = getRoundSetupFlowResult({
    phase: state.phase,
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

  const biddingViewState = isBiddingPhase ? getBiddingViewState(state) : null
  const scoringViewState = shouldShowScoringPanel
    ? {
        ...getScoringViewState(state),
        isVisible: true,
      }
    : null
  const bottomHandViewState = getBottomHandViewState(state)

  const biddingOverlayContent =
    !roundSetupFlow.isRoundSetupPhase && biddingViewState
      ? renderCenterPanel(renderBiddingPanel(biddingViewState), 760)
      : ''

  const activeSeat: Seat | null = isBiddingPhase
    ? state.bidding.currentSeat
    : ((state.playing?.currentTurnSeat ?? null) as Seat | null)

  const centerMainContent = roundSetupFlow.isRoundSetupPhase
    ? roundSetupFlow.centerContent
    : scoringViewState
      ? renderCenterPanel(renderScoringPanel(scoringViewState), 980)
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

            ${
              !isScoringPhase &&
              !isSummaryPhase &&
              !roundSetupFlow.isRoundSetupPhase &&
              bottomHandViewState.shouldShow
                ? `
              <div
                style="
                  position:absolute;
                  left:50%;
                  bottom:${BOTTOM_HAND_BOTTOM_OFFSET}px;
                  transform:translateX(-50%);
                  width:1040px;
                  z-index:4;
                "
              >
                ${renderBottomHandPanel(bottomHandViewState)}
              </div>
            `
                : ''
            }
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
        ${renderScoreHud(state)}
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
        ${renderSeatPanel(
          'top',
          roundSetupFlow.seatHandCounts.top,
          state.round.dealerSeat,
          state.round.cutterSeat,
          activeSeat,
          state.phase
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
        ${renderSeatPanel(
          'left',
          roundSetupFlow.seatHandCounts.left,
          state.round.dealerSeat,
          state.round.cutterSeat,
          activeSeat,
          state.phase
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
        ${renderSeatPanel(
          'right',
          roundSetupFlow.seatHandCounts.right,
          state.round.dealerSeat,
          state.round.cutterSeat,
          activeSeat,
          state.phase
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
          transform:translateX(-50%) scale(${stageScale});
          transform-origin:bottom center;
        "
      >
        ${renderSeatPanel(
          'bottom',
          roundSetupFlow.seatHandCounts.bottom,
          state.round.dealerSeat,
          state.round.cutterSeat,
          activeSeat,
          state.phase
        )}
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
          Фаза: ${state.phase}
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

  if (isPlayingPhase) {
    bindPlayCardClicks(getActionElements(rootElement, 'play-card'), options.onPlayCard)
  }
}