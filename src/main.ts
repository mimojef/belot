import './style.css'
import { bootstrapApp } from './app/bootstrap'
import { renderApp } from './app/renderApp'
import { pickBotCardToPlay } from './core/rules/pickBotCardToPlay'
import type { Seat } from './data/constants/seatOrder'
import type { Card, GameState, Suit } from './core/state/gameTypes'
import { createBelotePromptController } from './app/playPrompts/createBelotePromptController'

const rootElement = document.querySelector<HTMLDivElement>('#app')

if (!rootElement) {
  throw new Error('Root element #app was not found.')
}

const BOT_PLAY_DELAY_MS = 700
const FINAL_TRICK_CARD_FLIGHT_MS = 460
const FLOATING_CARD_WIDTH = 148
const FLOATING_CARD_HEIGHT = 215
const CUTTING_COUNTDOWN_MS = 20000
const BOT_CUTTING_AUTO_SELECT_MS = 1500
const CUTTING_SELECTION_RESOLVE_MS = 500
const CUT_RESOLVE_AUTO_ADVANCE_MS = 0
const DEAL_FIRST_THREE_AUTO_ADVANCE_MS = 2000
const DEAL_NEXT_TWO_AUTO_ADVANCE_MS = 1900
const DEAL_LAST_THREE_AUTO_ADVANCE_MS = 2000
const SCORING_AUTO_ADVANCE_MS = 5000
const SCORING_TIMER_FUDGE_MS = 24

const appRoot = rootElement
const app = bootstrapApp()

let resizeFrameId: number | null = null
let botPlayTimeoutId: number | null = null
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

function clearBotPlayTimeout(): void {
  if (botPlayTimeoutId !== null) {
    window.clearTimeout(botPlayTimeoutId)
    botPlayTimeoutId = null
  }
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

function resolveCardForSeat(cardId: string, seat: Seat): Card | null {
  const state = app.engine.getState()
  const hand = state.hands[seat] ?? []

  return hand.find((card) => card.id === cardId) ?? null
}

function getBottomSourceElement(cardId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-bottom-hand-root="1"] [data-card-id="${cardId}"]`
  )
}

function getSeatAnchor(seat: Seat): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-seat-anchor="${seat}"]`)
}

function getSeatPlayOffset(seat: Seat): { leftOffset: number; topOffset: number; rotate: number } {
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

function resolveFallbackStartRectForSeat(
  seat: Seat
): { left: number; top: number; rotate: number } {
  const centerX = window.innerWidth / 2
  const centerY = window.innerHeight / 2

  if (seat === 'top') {
    return {
      left: centerX - FLOATING_CARD_WIDTH / 2,
      top: 64,
      rotate: 0,
    }
  }

  if (seat === 'left') {
    return {
      left: 52,
      top: centerY - FLOATING_CARD_HEIGHT / 2,
      rotate: -8,
    }
  }

  if (seat === 'right') {
    return {
      left: window.innerWidth - FLOATING_CARD_WIDTH - 52,
      top: centerY - FLOATING_CARD_HEIGHT / 2,
      rotate: 8,
    }
  }

  return {
    left: centerX - FLOATING_CARD_WIDTH / 2,
    top: window.innerHeight - FLOATING_CARD_HEIGHT - 72,
    rotate: 0,
  }
}

function resolveStartRectForSeat(
  seat: Seat,
  cardId: string
): { left: number; top: number; rotate: number; sourceElement?: HTMLElement | null } | null {
  if (seat === 'bottom') {
    const sourceElement = getBottomSourceElement(cardId)

    if (sourceElement) {
      const rect = sourceElement.getBoundingClientRect()
      const rotate = parseRotationFromTransform(window.getComputedStyle(sourceElement).transform)

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
        left: rect.left + rect.width / 2 - FLOATING_CARD_WIDTH / 2,
        top: rect.top + rect.height - 36,
        rotate: 0,
      }
    }

    if (seat === 'left') {
      return {
        left: rect.left + rect.width - 34,
        top: rect.top + rect.height / 2 - FLOATING_CARD_HEIGHT / 2,
        rotate: -8,
      }
    }

    if (seat === 'right') {
      return {
        left: rect.left - FLOATING_CARD_WIDTH + 34,
        top: rect.top + rect.height / 2 - FLOATING_CARD_HEIGHT / 2,
        rotate: 8,
      }
    }

    return {
      left: rect.left + rect.width / 2 - FLOATING_CARD_WIDTH / 2,
      top: rect.top - FLOATING_CARD_HEIGHT + 34,
      rotate: 0,
    }
  }

  return resolveFallbackStartRectForSeat(seat)
}

function resolvePlayTargetRectForSeat(
  seat: Seat
): { left: number; top: number; rotate: number } {
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
  const suitSymbol = getSuitSymbol(card.suit)
  const cardColor = isRedSuit(card.suit) ? '#b3261e' : '#13253d'

  const wrapper = document.createElement('div')
  wrapper.style.position = 'fixed'
  wrapper.style.width = `${FLOATING_CARD_WIDTH}px`
  wrapper.style.height = `${FLOATING_CARD_HEIGHT}px`
  wrapper.style.pointerEvents = 'none'
  wrapper.style.zIndex = '9999'
  wrapper.style.transformOrigin = 'center center'
  wrapper.style.willChange = 'transform, opacity'
  wrapper.innerHTML = `
    <div
      style="
        position:absolute;
        inset:0;
        border-radius:14px;
        background:linear-gradient(180deg, rgba(255,255,255,0.99) 0%, rgba(241,245,250,0.99) 100%);
        box-shadow:
          0 16px 34px rgba(0,0,0,0.24),
          inset 0 1px 0 rgba(255,255,255,0.95),
          inset 0 -1px 0 rgba(0,0,0,0.05);
        border:1px solid rgba(21,48,82,0.10);
      "
    ></div>

    <div
      style="
        position:absolute;
        inset:4px;
        border-radius:10px;
        border:1px solid rgba(20,49,84,0.12);
        background:linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(248,250,253,0.94) 100%);
      "
    ></div>

    <div
      style="
        position:absolute;
        left:9px;
        top:10px;
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:1px;
        color:${cardColor};
        line-height:1;
      "
    >
      <span
        style="
          font-size:18px;
          font-weight:900;
          letter-spacing:0.02em;
        "
      >
        ${String(card.rank)}
      </span>
      <span
        style="
          font-size:16px;
          font-weight:900;
        "
      >
        ${suitSymbol}
      </span>
    </div>

    <div
      style="
        position:absolute;
        right:9px;
        bottom:8px;
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:1px;
        color:${cardColor};
        line-height:1;
        transform:rotate(180deg);
      "
    >
      <span
        style="
          font-size:18px;
          font-weight:900;
          letter-spacing:0.02em;
        "
      >
        ${String(card.rank)}
      </span>
      <span
        style="
          font-size:16px;
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
        font-size:42px;
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

function getCuttingRemainingMs(state: GameState): number | null {
  if (state.phase !== 'cutting') {
    return null
  }

  if (!state.round.cutterSeat) {
    return null
  }

  if (getSelectedCutIndexFromState(state) !== null) {
    return null
  }

  const autoSelectMs =
    state.round.cutterSeat === 'bottom'
      ? CUTTING_COUNTDOWN_MS
      : BOT_CUTTING_AUTO_SELECT_MS

  const phaseEnteredAt =
    typeof state.phaseEnteredAt === 'number' && Number.isFinite(state.phaseEnteredAt)
      ? state.phaseEnteredAt
      : null

  if (phaseEnteredAt === null) {
    return autoSelectMs
  }

  const now = getClockNowForPhaseTimestamp(phaseEnteredAt)
  const elapsedMs = Math.max(0, now - phaseEnteredAt)

  return Math.max(0, autoSelectMs - elapsedMs)
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

  return null
}

function scheduleCuttingAutoSelect(): void {
  clearCuttingAutoSelectTimeout()

  const state = app.engine.getState()
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

  if (
    dealPhaseAutoAdvanceTimeoutId !== null &&
    activeDealPhaseAutoAdvance === state.phase
  ) {
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
    remainingMs - Math.max(0, currentDisplayedSeconds - 1) * 1000 + SCORING_TIMER_FUDGE_MS
  const tickDelay = Math.max(
    SCORING_TIMER_FUDGE_MS,
    Math.min(delayToNextCountdownStep, remainingMs)
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
    }
  )

  activeFinalTrickAnimation = animation

  animation.onfinish = () => {
    if (activeFinalTrickAnimation !== animation) {
      return
    }

    activeFinalTrickAnimation = null

    if (activeFinalTrickFloatingCard?.parentNode) {
      activeFinalTrickFloatingCard.parentNode.removeChild(activeFinalTrickFloatingCard)
    }

    activeFinalTrickFloatingCard = null
    activeFinalTrickSourceElement = null
    isAnimatingFinalTrickCard = false

    app.engine.submitPlayCard(cardId)
    render()
  }

  animation.oncancel = () => {
    if (activeFinalTrickAnimation === animation) {
      activeFinalTrickAnimation = null
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

function scheduleNextBotPlay(): void {
  clearBotPlayTimeout()

  if (isAnimatingFinalTrickCard) {
    return
  }

  const state = app.engine.getState()

  if (state.phase !== 'playing') {
    return
  }

  const currentTurnSeat = state.playing?.currentTurnSeat ?? null

  if (!currentTurnSeat || currentTurnSeat === 'bottom') {
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

    const latestSeat = latestState.playing?.currentTurnSeat ?? null

    if (!latestSeat || latestSeat === 'bottom') {
      render()
      return
    }

    const botCard = pickBotCardToPlay(latestState, latestSeat)

    if (!botCard) {
      render()
      return
    }

    submitPlayCardWithFlow(botCard.id, latestSeat)
  }, BOT_PLAY_DELAY_MS)
}

function render(): void {
  renderApp(appRoot, app, {
    onNextPhaseClick: () => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.goToNextPhase()
      render()
    },
    onSelectCutIndex: (cutIndex: number) => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.selectCutIndex(cutIndex)
      render()
    },
    onResolveCutClick: () => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.resolveCutPhase()
      render()
    },
    onBidPass: () => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.submitBidAction({ type: 'pass' })
      render()
    },
    onBidSuit: (suit) => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.submitBidAction({ type: 'suit', suit })
      render()
    },
    onBidNoTrumps: () => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.submitBidAction({ type: 'no-trumps' })
      render()
    },
    onBidAllTrumps: () => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.submitBidAction({ type: 'all-trumps' })
      render()
    },
    onBidDouble: () => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.submitBidAction({ type: 'double' })
      render()
    },
    onBidRedouble: () => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()
      clearFinalTrickAnimationTimeout()
      app.engine.submitBidAction({ type: 'redouble' })
      render()
    },
    onPlayCard: (cardId) => {
      clearBotPlayTimeout()
      clearCuttingAutoSelectTimeout()
      clearCuttingResolveTimeout()
      clearDealPhaseAutoAdvanceTimeout()
      clearScoringTimeouts()

      const didOpenBelotePrompt = belotePromptController.handlePlayCard(cardId)

      if (didOpenBelotePrompt) {
        return
      }

      submitPlayCardWithFlow(cardId, 'bottom')
    },
  })

  belotePromptController.renderPendingPrompt()
  scheduleCuttingAutoSelect()
  scheduleCuttingResolve()
  scheduleDealPhaseAutoAdvance()
  scheduleNextBotPlay()
  scheduleScoringPhaseTimers()
}

const belotePromptController = createBelotePromptController({
  app,
  render,
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

render()