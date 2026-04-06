import './style.css'
import { bootstrapApp } from './app/bootstrap'
import { renderApp } from './app/renderApp'
import { createBelotePromptController } from './app/playPrompts/createBelotePromptController'
import { pickBotCardToPlay } from './core/rules/pickBotCardToPlay'
import { getBiddingViewState } from './core/state/getBiddingViewState'
import type { Seat } from './data/constants/seatOrder'
import type { BidAction, Card, GameState, Suit } from './core/state/gameTypes'

const rootElement = document.querySelector<HTMLDivElement>('#app')

if (!rootElement) {
  throw new Error('Root element #app was not found.')
}

const BOT_PLAY_DELAY_MS = 1500
const BOT_BIDDING_DELAY_MS = 1500
const FINAL_TRICK_CARD_FLIGHT_MS = 420
const FINAL_TRICK_CARD_HOLD_MS = 340
const FLOATING_CARD_WIDTH = 148
const FLOATING_CARD_HEIGHT = 215
const CUTTING_COUNTDOWN_MS = 20000
const PLAYING_COUNTDOWN_MS = 20000
const BOT_CUTTING_AUTO_SELECT_MS = 1500
const CUTTING_SELECTION_RESOLVE_MS = 500
const CUT_RESOLVE_AUTO_ADVANCE_MS = 0
const DEAL_FIRST_THREE_AUTO_ADVANCE_MS = 2000
const DEAL_NEXT_TWO_AUTO_ADVANCE_MS = 1900
const DEAL_LAST_THREE_AUTO_ADVANCE_MS = 2000
const SCORING_AUTO_ADVANCE_MS = 5000
const SCORING_TIMER_FUDGE_MS = 24

const SUIT_OPTIONS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']

const SUIT_BID_RANK_VALUES: Record<string, number> = {
  J: 6.5,
  9: 5.5,
  A: 4,
  '10': 3.5,
  K: 2,
  Q: 1.5,
  8: 0,
  7: 0,
}

const NO_TRUMPS_RANK_VALUES: Record<string, number> = {
  A: 5,
  '10': 4,
  K: 2,
  Q: 1.2,
  J: 0.5,
  9: 0,
  8: 0,
  7: 0,
}

const ALL_TRUMPS_SIDE_VALUES: Record<string, number> = {
  J: 3,
  9: 2.5,
  A: 1.8,
  '10': 1.2,
  K: 1,
  Q: 0.6,
  8: 0,
  7: 0,
}

const appRoot = rootElement
const app = bootstrapApp()

let resizeFrameId: number | null = null
let botPlayTimeoutId: number | null = null
let botBidTimeoutId: number | null = null
let activeBotBidTurnKey: string | null = null
let activePlayingTurnKey: string | null = null
let activePlayingTurnStartedAt = 0
let activePlayingPausedRemainingMs: number | null = null
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

function resetPlayingTurnTracking(): void {
  activePlayingTurnKey = null
  activePlayingTurnStartedAt = 0
  activePlayingPausedRemainingMs = null
}

function removeBottomBotTakeoverPopup(): void {
  document.querySelector('[data-bottom-bot-takeover-popup-root]')?.remove()
}

function setBottomBotTakeoverActive(nextValue: boolean): void {
  if (bottomBotTakeoverActive === nextValue) {
    return
  }

  bottomBotTakeoverActive = nextValue
  resetPlayingTurnTracking()

  if (!nextValue) {
    removeBottomBotTakeoverPopup()
  }
}

function getRenderClockNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }

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
  cardId: string
): { left: number; top: number; rotate: number; sourceElement?: HTMLElement | null } | null {
  const { width, height } = getScaledFloatingCardSize()

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
          font-size:${18 * stageScale}px;
          font-weight:900;
          letter-spacing:0.02em;
        "
      >
        ${String(card.rank)}
      </span>
      <span
        style="
          font-size:${16 * stageScale}px;
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
          font-size:${18 * stageScale}px;
          font-weight:900;
          letter-spacing:0.02em;
        "
      >
        ${String(card.rank)}
      </span>
      <span
        style="
          font-size:${16 * stageScale}px;
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
        font-size:${42 * stageScale}px;
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

function getCardRankScore(card: Card, scoreMap: Record<string, number>): number {
  return scoreMap[String(card.rank)] ?? 0
}

function getSuitBidStrength(hand: Card[], suit: Suit): number {
  const suitCards = hand.filter((card) => card.suit === suit)
  const rankScore = suitCards.reduce(
    (sum, card) => sum + getCardRankScore(card, SUIT_BID_RANK_VALUES),
    0
  )
  const count = suitCards.length
  const lengthBonus = count * 1.4 + (count >= 4 ? 2 : 0) + (count >= 5 ? 3 : 0)

  return rankScore + lengthBonus
}

function getNoTrumpsBidStrength(hand: Card[]): number {
  const rankScore = hand.reduce(
    (sum, card) => sum + getCardRankScore(card, NO_TRUMPS_RANK_VALUES),
    0
  )
  const acesAndTens = hand.filter(
    (card) => String(card.rank) === 'A' || String(card.rank) === '10'
  ).length

  return rankScore + acesAndTens * 0.8
}

function getAllTrumpsBidStrength(hand: Card[]): number {
  const bestSuitStrength = Math.max(
    ...SUIT_OPTIONS.map((suit) => getSuitBidStrength(hand, suit))
  )

  const sideValue = hand.reduce(
    (sum, card) => sum + getCardRankScore(card, ALL_TRUMPS_SIDE_VALUES),
    0
  )

  return bestSuitStrength + sideValue * 0.25
}

type BotContractCandidate = {
  action: BidAction
  score: number
}

type BotBidValidActions = NonNullable<ReturnType<typeof getBiddingViewState>>['validActions']

function getBestBotContractCandidate(
  hand: Card[],
  validActions: BotBidValidActions
): BotContractCandidate | null {
  const candidates: BotContractCandidate[] = []

  for (const suit of SUIT_OPTIONS) {
    if (!validActions.suits[suit]) {
      continue
    }

    candidates.push({
      action: { type: 'suit', suit },
      score: getSuitBidStrength(hand, suit),
    })
  }

  if (validActions.noTrumps) {
    candidates.push({
      action: { type: 'no-trumps' },
      score: getNoTrumpsBidStrength(hand),
    })
  }

  if (validActions.allTrumps) {
    candidates.push({
      action: { type: 'all-trumps' },
      score: getAllTrumpsBidStrength(hand),
    })
  }

  if (candidates.length === 0) {
    return null
  }

  candidates.sort((left, right) => right.score - left.score)

  return candidates[0] ?? null
}

function getMinimumBotBidScore(action: BidAction): number {
  if (action.type === 'suit') {
    return 10.5
  }

  if (action.type === 'no-trumps') {
    return 15
  }

  if (action.type === 'all-trumps') {
    return 16
  }

  return Number.POSITIVE_INFINITY
}

function pickBotBidAction(state: GameState, seat: Seat): BidAction {
  const biddingViewState = getBiddingViewState(state)

  if (!biddingViewState || biddingViewState.currentSeat !== seat) {
    return { type: 'pass' }
  }

  const validActions = biddingViewState.validActions
  const hand = state.hands[seat] ?? []
  const bestContract = getBestBotContractCandidate(hand, validActions)
  const bestContractScore = bestContract?.score ?? 0

  if (validActions.redouble && bestContractScore >= 12.5) {
    return { type: 'redouble' }
  }

  if (validActions.double && bestContractScore >= 13.5) {
    return { type: 'double' }
  }

  if (
    bestContract &&
    bestContractScore >= getMinimumBotBidScore(bestContract.action)
  ) {
    return bestContract.action
  }

  return { type: 'pass' }
}

function getBotBidTurnKey(state: GameState): string | null {
  if (state.phase !== 'bidding' || state.bidding.hasEnded) {
    return null
  }

  const currentSeat = state.bidding.currentSeat

  if (!currentSeat || currentSeat === 'bottom') {
    return null
  }

  return `${state.phase}:${state.bidding.entries.length}:${currentSeat}`
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

  const controlMode =
    currentSeat === 'bottom' && !bottomBotTakeoverActive ? 'human' : 'bot'

  return `${completedTricksCount}:${currentTrickPlaysCount}:${currentSeat}:${controlMode}`
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

  activePlayingTurnKey = turnKey
  activePlayingTurnStartedAt = getRenderClockNow()
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
  const shouldShowPopup = bottomBotTakeoverActive && state.phase === 'playing'

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
    '[data-bottom-bot-takeover-return-button]'
  )

  returnButton?.addEventListener('click', () => {
    setBottomBotTakeoverActive(false)
    render()
  })
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
      setBottomBotTakeoverActive(true)
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

function scheduleNextBotBid(): void {
  const state = app.engine.getState()
  const turnKey = getBotBidTurnKey(state)

  if (turnKey === null) {
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
    const latestTurnKey = getBotBidTurnKey(latestState)

    if (latestTurnKey === null || latestTurnKey !== activeBotBidTurnKey) {
      activeBotBidTurnKey = null
      render()
      return
    }

    const latestSeat = latestState.bidding.currentSeat

    if (!latestSeat || latestSeat === 'bottom') {
      activeBotBidTurnKey = null
      render()
      return
    }

    const botAction = pickBotBidAction(latestState, latestSeat)

    clearBotPlayTimeout()
    clearCuttingAutoSelectTimeout()
    clearCuttingResolveTimeout()
    clearDealPhaseAutoAdvanceTimeout()
    clearScoringTimeouts()
    clearFinalTrickAnimationTimeout()
    activeBotBidTurnKey = null
    app.engine.submitBidAction(botAction)
    render()
  }, BOT_BIDDING_DELAY_MS)
}

function render(): void {
  const stateBeforeRender = app.engine.getState()

  if (stateBeforeRender.phase !== 'playing' && bottomBotTakeoverActive) {
    setBottomBotTakeoverActive(false)
  }

  syncPlayingTurnState(stateBeforeRender)
  syncPlayingPauseState(stateBeforeRender)

  const playingCountdownRemainingMs = getPlayingCountdownRemainingMs(stateBeforeRender)

  renderApp(appRoot, app, {
    onNextPhaseClick: () => {
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
    onSelectCutIndex: (cutIndex: number) => {
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
      clearBotPlayTimeout()
      clearBotBidTimeout()
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
      clearBotBidTimeout()
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
      clearBotBidTimeout()
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
      clearBotBidTimeout()
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
      clearBotBidTimeout()
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
      clearBotBidTimeout()
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
    playingCountdownRemainingMs,
    bottomBotTakeoverActive,
  })

  belotePromptController.renderPendingPrompt()
  renderBottomBotTakeoverPopup()
  scheduleCuttingAutoSelect()
  scheduleCuttingResolve()
  scheduleDealPhaseAutoAdvance()
  scheduleNextBotBid()
  schedulePlayingPhaseTimers()
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