import type { AppBootstrap } from './bootstrap'
import type { Seat } from '../data/constants/seatOrder'
import type { Suit } from '../core/state/gameTypes'
import { getBiddingViewState } from '../core/state/getBiddingViewState'
import { getPlayingViewState } from '../core/state/getPlayingViewState'
import { getBottomHandViewState } from '../core/state/getBottomHandViewState'
import { getScoringViewState } from '../core/state/getScoringViewState'
import { renderBiddingPanel } from '../ui/center/renderBiddingPanel'
import { renderPlayingPanel } from '../ui/center/renderPlayingPanel'
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

let autoPhaseTimeoutId: number | null = null
let autoCutTimeoutId: number | null = null
let autoPhaseKey = ''
let autoCutKey = ''
let cutResolveTimeoutId: number | null = null
let roundSetupRerenderTimeoutId: number | null = null

function clearAutoPhaseTimeout(): void {
  if (autoPhaseTimeoutId !== null) {
    window.clearTimeout(autoPhaseTimeoutId)
    autoPhaseTimeoutId = null
  }

  autoPhaseKey = ''
}

function clearAutoCutTimeout(): void {
  if (autoCutTimeoutId !== null) {
    window.clearTimeout(autoCutTimeoutId)
    autoCutTimeoutId = null
  }

  autoCutKey = ''
}

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
  clearAutoCutTimeout()
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

function scheduleAutoPhaseAdvance(
  phase: string,
  onNextPhaseClick?: () => void
): void {
  if (!onNextPhaseClick) {
    clearAutoPhaseTimeout()
    return
  }

  const phaseDelayMap: Record<string, number> = {
    'new-game': 140,
    'choose-first-dealer': 220,
    'cut-resolve': 20,
    'deal-first-3': 2850,
    'deal-next-2': 2250,
    'deal-last-3': 2850,
  }

  const delay = phaseDelayMap[phase]

  if (!delay) {
    clearAutoPhaseTimeout()
    return
  }

  const nextKey = `${phase}:${delay}`

  if (autoPhaseKey === nextKey) {
    return
  }

  clearAutoPhaseTimeout()
  autoPhaseKey = nextKey

  autoPhaseTimeoutId = window.setTimeout(() => {
    autoPhaseTimeoutId = null
    autoPhaseKey = ''
    onNextPhaseClick()
  }, delay)
}

function scheduleAutoCut(
  phase: string,
  cutterSeat: Seat | null,
  selectedCutIndex: number | null | undefined,
  options: RenderAppOptions
): void {
  if (phase !== 'cutting') {
    clearAutoCutTimeout()
    return
  }

  const isHumanCutting = cutterSeat === 'bottom'
  const cutIndex = selectedCutIndex ?? 16
  const delay = isHumanCutting ? 20000 : 1500
  const nextKey = `${phase}:${cutterSeat ?? 'none'}:${cutIndex}:${delay}`

  if (autoCutKey === nextKey) {
    return
  }

  clearAutoCutTimeout()
  autoCutKey = nextKey

  autoCutTimeoutId = window.setTimeout(() => {
    autoCutTimeoutId = null
    autoCutKey = ''

    triggerCutResolveSequence(cutIndex, options)
  }, delay)
}

function scheduleRoundSetupRerender(
  delayMs: number | null,
  rootElement: HTMLElement,
  app: AppBootstrap,
  options: RenderAppOptions
): void {
  if (delayMs === null) {
    clearRoundSetupRerenderTimeout()
    return
  }

  clearRoundSetupRerenderTimeout()

  roundSetupRerenderTimeoutId = window.setTimeout(() => {
    roundSetupRerenderTimeoutId = null
    renderApp(rootElement, app, options)
  }, delayMs)
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
  })

  const biddingViewState = isBiddingPhase ? getBiddingViewState(state) : null
  const playingViewState = isPlayingPhase ? getPlayingViewState(state) : null
  const scoringViewState = shouldShowScoringPanel
    ? {
        ...getScoringViewState(state),
        isVisible: true,
      }
    : null
  const bottomHandViewState = getBottomHandViewState(state)

  const activeSeat: Seat | null = isBiddingPhase
    ? state.bidding.currentSeat
    : ((state.playing?.currentTurnSeat ?? null) as Seat | null)

  const centerMainContent = roundSetupFlow.isRoundSetupPhase
    ? roundSetupFlow.centerContent
    : biddingViewState
      ? renderCenterPanel(renderBiddingPanel(biddingViewState), 760)
      : playingViewState
        ? renderCenterPanel(renderPlayingPanel(playingViewState), 980)
        : scoringViewState
          ? renderCenterPanel(renderScoringPanel(scoringViewState), 980)
          : ''

  rootElement.innerHTML = `
    <div class="game-shell">
      <div
        class="game-stage"
        style="transform: translate(-50%, -50%) scale(${stageScale});"
      >
        <div
          style="
            position:relative;
            width:${GAME_STAGE_WIDTH}px;
            height:${GAME_STAGE_HEIGHT}px;
            overflow:hidden;
            color:#ffffff;
          "
        >
          <div
            style="
              position:relative;
              width:100%;
              height:100%;
              padding:0;
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
              ${roundSetupFlow.shouldHideCenterDeck ? '' : renderCenterDeck(state.deck.length)}
              ${centerMainContent}
            </div>

            ${
              !isPlayingPhase &&
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
          activeSeat
        )}
      </div>

      <div
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
          activeSeat
        )}
      </div>

      <div
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
          activeSeat
        )}
      </div>

      <div
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
          activeSeat
        )}
      </div>
    </div>
  `

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

  scheduleAutoPhaseAdvance(state.phase, options.onNextPhaseClick)
  scheduleAutoCut(
    state.phase,
    state.round.cutterSeat,
    state.round.selectedCutIndex,
    options
  )
  scheduleRoundSetupRerender(
    roundSetupFlow.nextRerenderInMs,
    rootElement,
    app,
    options
  )
}