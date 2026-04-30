import type {
  BiddingUiState,
  CuttingAnimationCache,
  DealingAnimationCache,
  PlayingUiCache,
} from './activeRoomTypes'
import type { Seat } from '../network/createGameServerClient'
import { getViewportStageMetrics } from '../../ui/layout/viewportStage'

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
}

export function createBiddingUiState(): BiddingUiState {
  return {
    lastKnownEntriesCount: 0,
    pendingBidSent: false,
    wasMyTurn: false,
    recentBubbles: {},
    bubbleTimerIds: {},
    showBotTakeover: false,
    botTakeoverTimerId: null,
  }
}
