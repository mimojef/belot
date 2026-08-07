import type {
  BiddingUiState,
  CuttingAnimationCache,
  DealingAnimationCache,
  EmojiReactionUiState,
  PhraseReactionUiState,
  PlayingUiCache,
} from './activeRoomTypes'
import type { Seat } from '../network/createGameServerClient'
import { getViewportStageMetrics } from '../../ui/layout/viewportStage'
export { computeNextLastKnownWinningBid, selectWinningBidFromGame } from './winningBidHelpers'

export const SEAT_LABELS: Record<Seat, string> = {
  bottom: 'Долу',
  right: 'Дясно',
  top: 'Горе',
  left: 'Ляво',
}

export const SERVER_DEAL_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

export const ACTIVE_ROOM_STAGE_WIDTH = 1600
export const ACTIVE_ROOM_STAGE_HEIGHT = 900
export const ACTIVE_ROOM_MAX_STAGE_SCALE = 1.06
export const ACTIVE_ROOM_MIN_STAGE_SCALE = 0.46
export const ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING = 20
export const ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING = 20
export const ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT = 50

// Единна mobile геометрия за долната (местния играч) ръка карти — споделена
// между dealing/bidding fan renderer-а (renderCuttingSeatPanels.ts) и
// playing overlay renderer-а (renderPlayingScreen.ts), за да няма визуален
// размерен скок при прехода last-3 -> playing. Desktop геометрията остава
// в отделните module-level константи на всеки файл (195×284, spacing 62,
// center Y 50) — тук се пипа само phone-layout override-ът.
export const BOTTOM_HAND_MOBILE_CARD_WIDTH = 211
export const BOTTOM_HAND_MOBILE_CARD_HEIGHT = 307
export const BOTTOM_HAND_MOBILE_SPACING = 70
export const BOTTOM_HAND_MOBILE_CENTER_Y_OFFSET = -26

// Под тази viewport ширина долното (местен играч) ветрило карти вече не се
// смалява допълнително от stageScale (той е clamped на minScale заради
// height constraint-а), затова при 8 карти краищата изтичат извън екрана.
// Компенсираме с отделен uniform мащаб, приложен САМО върху bottom hand
// fan-а (card size + spacing/edgeDrop) — не върху stage/panels/останалите
// seat ветрила. Използва се еднакво от playing overlay-я
// (renderPlayingScreen.ts) и от deal/bidding/cutting panel fan-а
// (renderCuttingSeatPanels.ts), за да няма скок в размера между фазите.
//
// Важно: bottom hand fan-ът живее вътре в panel wrapper, който самият вече
// е scale-нат от getCuttingSeatPanelAnchorStyle(..., stageScale). Затова
// връщаният тук мащаб е КОМПЕНСИРАН спрямо stageScale — крайният видим
// (viewport-space) мащаб е stageScale * getBottomHandMobileFanScale(stageScale),
// който се изчислява да достигне точно целевия half-span.
const BOTTOM_HAND_FAN_BREAKPOINT = 380
const BOTTOM_HAND_FAN_EDGE_MARGIN = 5
// Полу-размах (от центъра на ръката до видимия ръб на крайна карта) за
// референтния случай 8 карти при естествен (немащабиран) размер:
// spreadStep=70, card 211x307, rotate ±17.5deg.
const BOTTOM_HAND_FAN_REFERENCE_HALF_SPAN = 391.78

export function getBottomHandMobileFanScale(stageScale: number): number {
  if (typeof window === 'undefined') {
    return 1
  }

  const viewportWidth = window.innerWidth

  if (viewportWidth > BOTTOM_HAND_FAN_BREAKPOINT) {
    return 1
  }

  const availableHalfSpan = viewportWidth / 2 - BOTTOM_HAND_FAN_EDGE_MARGIN
  const targetVisualScale = availableHalfSpan / BOTTOM_HAND_FAN_REFERENCE_HALF_SPAN
  const compensatedScale = targetVisualScale / stageScale

  return Math.min(1, Math.max(0.1, compensatedScale))
}
export const ACTIVE_ROOM_TABLE_BACKGROUND = `
  radial-gradient(circle at center, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0.015) 34%, rgba(0,0,0,0.00) 58%),
  url('/assets/lobby/table-diamond-bg.webp') center / 100% 100% no-repeat,
  #000000
`
export const ACTIVE_ROOM_MOBILE_TABLE_BACKGROUND = `
  radial-gradient(circle at 50% 42%, rgba(34,139,64,0.24) 0%, rgba(17,89,42,0.18) 34%, rgba(0,0,0,0) 68%),
  linear-gradient(180deg, #07130a 0%, #020503 100%)
`
export const ACTIVE_ROOM_TABLE_STAGE_BACKGROUND = 'transparent'


export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function getSeatAfterDealerForDealFallback(dealerSeat: Seat | null): Seat | null {
  if (dealerSeat === null) {
    return null
  }

  const dealerIndex = SERVER_DEAL_ORDER.indexOf(dealerSeat)

  if (dealerIndex === -1) {
    return null
  }

  return SERVER_DEAL_ORDER[(dealerIndex + 1) % SERVER_DEAL_ORDER.length]
}

export function getActiveRoomStageMetrics(): {
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

export function createCuttingAnimationCache(): CuttingAnimationCache {
  return {
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
}

export function createDealingAnimationCache(): DealingAnimationCache {
  return {
    activePhaseKey: null,
    renderedPhaseKey: null,
    renderedFirstDealSeat: null,
    startedAt: 0,
    completionTimerId: null,
    isAnimating: false,
    hasCompleted: false,
  }
}

export function createPlayingUiCache(): PlayingUiCache {
  return {
    lastTrickKey: null,
    lastCompletedTricksCount: 0,
    isTrickCollectionAnimating: false,
    pendingCompletedTrickKey: null,
    latestCompletedTrickKey: null,
    bufferedCompletedTrick: null,
    completedTrickEntryKey: null,
    completedTrickEntryStartedAt: 0,
    hasRenderedSnapshot: false,
    animationToken: 0,
    pendingPlayCardSent: false,
    wasMyTurn: false,
    observedPlayKeys: [],
    showBotTakeover: false,
    hasShownBotTakeover: false,
    lastPlayedCardRect: null,
    hoveredHandCardId: null,
    pendingDeclarationPrompt: null,
    submittedDeclarationKeys: [],
    flyingCardPlayKey: null,
    lastSeatPanelKey: null,
  }
}

export function resetPlayingUiCache(cache: PlayingUiCache): void {
  // Mobile playing: static trick cards и announcement bubbles живеят в
  // собствени host-ове (виж renderPlayingScreen.ts), вмъкнати директно в
  // document.body — не се махат автоматично при innerHTML rebuild-и
  // другаде, затова се чистят тук, на всеки exit-from-playing път
  // (единственото място, извиквано последователно от всички съответни
  // exit points в контролера). seat-panels-host остава (управляван от
  // createActiveRoomFlowController.ts) — само неговият inline
  // position/z-index стил, зададен за mobile playing stacking, се връща
  // към auto/static, за да не изтече в следващата фаза (deal/bidding).
  if (typeof document !== 'undefined') {
    document.body.querySelector('[data-mobile-trick-layer-host]')?.remove()
    document.body.querySelector('[data-mobile-bubble-layer-host]')?.remove()
    const seatPanelsHost = document.body.querySelector<HTMLElement>('[data-seat-panels-host="1"]')
    if (seatPanelsHost) {
      seatPanelsHost.style.position = ''
      seatPanelsHost.style.zIndex = ''
    }
  }

  cache.lastTrickKey = null
  cache.lastCompletedTricksCount = 0
  cache.isTrickCollectionAnimating = false
  cache.pendingCompletedTrickKey = null
  cache.latestCompletedTrickKey = null
  cache.bufferedCompletedTrick = null
  cache.completedTrickEntryKey = null
  cache.completedTrickEntryStartedAt = 0
  cache.hasRenderedSnapshot = false
  cache.animationToken += 1
  cache.pendingPlayCardSent = false
  cache.wasMyTurn = false
  cache.observedPlayKeys = []
  cache.showBotTakeover = false
  cache.hasShownBotTakeover = false
  cache.lastPlayedCardRect = null
  cache.hoveredHandCardId = null
  cache.pendingDeclarationPrompt = null
  cache.submittedDeclarationKeys = []
  cache.flyingCardPlayKey = null
  cache.lastSeatPanelKey = null
}

export function createBiddingUiState(): BiddingUiState {
  return {
    lastKnownEntriesCount: 0,
    pendingBidSent: false,
    wasMyTurn: false,
    popupAnimatedTurnKey: null,
    recentBubbles: {},
    bubbleTimerIds: {},
    showBotTakeover: false,
    botTakeoverTimerId: null,
  }
}

export function createEmojiReactionUiState(): EmojiReactionUiState {
  return {
    activeBubbles: {},
    timerIds: {},
  }
}

export function createPhraseReactionUiState(): PhraseReactionUiState {
  return {
    activeBubbles: {},
    timerIds: {},
  }
}
