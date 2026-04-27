import type {
  BiddingUiState,
  CuttingAnimationCache,
  DealingAnimationCache,
} from './activeRoomTypes'
import type { Seat } from '../network/createGameServerClient'
import { getViewportStageMetrics } from '../../ui/layout/viewportStage'

export const SEAT_LABELS: Record<Seat, string> = {
  bottom: 'Р”РѕР»Сѓ',
  right: 'Р”СЏСЃРЅРѕ',
  top: 'Р“РѕСЂРµ',
  left: 'Р›СЏРІРѕ',
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
