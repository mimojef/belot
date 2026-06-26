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
