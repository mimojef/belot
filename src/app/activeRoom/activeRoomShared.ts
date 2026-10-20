import type {
  BiddingUiState,
  CuttingAnimationCache,
  DealingAnimationCache,
  EmojiReactionUiState,
  PhraseReactionUiState,
  PlayingUiCache,
} from './activeRoomTypes'
import type { Seat, CampaignThemeAssets as ActiveCampaignThemeAssets } from '../network/createGameServerClient'
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

// ═══════════════ Фаза 10 — тематична визия на кампанията ═══════════════
// Module-level mutable state (НЕ threaded параметър през десетки render
// функции/файлове) — установен паттерн за "ambient" cross-cutting
// стойности в тая директория (виж getBottomHandMobileFanScale по-горе,
// window.innerWidth-driven, не параметър). Задава се ИЗКЛЮЧИТЕЛНО от
// createActiveRoomFlowController.ts::handleServerMessage при
// 'active_campaign_theme' push (bootstrap on connect + realtime след
// всяка admin/scheduler промяна, виж server/src/index.ts) — никога от
// самите render функции. Live по дизайн: продължава да се обновява дори
// докато активна стая е отворена (§7/§8 "промяна без reload", "reconnect
// възстановява правилната тема").
let currentActiveCampaignTheme: ActiveCampaignThemeAssets | null = null

export function setActiveCampaignTheme(theme: ActiveCampaignThemeAssets | null): void {
  currentActiveCampaignTheme = theme
}

export function getActiveCampaignTheme(): ActiveCampaignThemeAssets | null {
  return currentActiveCampaignTheme
}

/**
 * Замества `isPhoneLayout ? ACTIVE_ROOM_MOBILE_TABLE_BACKGROUND :
 * ACTIVE_ROOM_TABLE_BACKGROUND`-ия ternary на всичките call sites (§5/§6/§7).
 * Темата се слага като ДОПЪЛНИТЕЛЕН, най-горен background layer ВЪРХУ
 * ПЪЛНИЯ стандартен background string (не го замества) — ако темизираното
 * изображение не успее да се зареди (счупен/изтрит файл), браузърът просто
 * не рисува тоя layer и стандартният фон отдолу остава напълно видим, без
 * JS/onerror нужда (§7 "безопасен fallback"). Мобилният стандартен фон е
 * чисто gradient (без изображение) — тематичният layer е единствената
 * реална снимка на mobile, когато е зададена.
 */
export function getActiveRoomTableBackground(isPhoneLayout: boolean): string {
  const theme = currentActiveCampaignTheme
  const themedUrl = isPhoneLayout ? theme?.tableBgMobileUrl ?? null : theme?.tableBgDesktopUrl ?? null
  const defaultBackground = isPhoneLayout ? ACTIVE_ROOM_MOBILE_TABLE_BACKGROUND : ACTIVE_ROOM_TABLE_BACKGROUND

  if (!themedUrl) {
    return defaultBackground
  }

  // Mobile: фазите ползват контейнери с РАЗЛИЧНА височина (100vh при
  // cutting/dealing/bidding/scoring, calc(100dvh - bottom nav) при playing,
  // 100dvh при match-ended) — "100% 100%" би преоразмерявал/местил снимката
  // при всяка смяна на фаза. Оразмеряването спрямо viewport-а (100vw x 100vh,
  // закотвено горе) я прави идентична във всички фази; 100vh не се променя и
  // при показване/скриване на адресната лента. Desktop остава непроменен.
  const themedSizing = isPhoneLayout ? 'center top / 100vw 100vh' : 'center / 100% 100%'
  return `url('${themedUrl}') ${themedSizing} no-repeat, ${defaultBackground}`
}


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
    pendingPlayCardId: null,
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
    lastPlayingShellKey: null,
    lastTrickStableKey: null,
    lastScoreHudRenderedHtml: null,
    sweepOfferDismissedKey: null,
    sweepAcceptSent: false,
    lastSweepResolutionKey: null,
    isSweepAnimating: false,
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
    document.body.querySelector('[data-mobile-phrase-overlay-host]')?.remove()
    document.body.querySelector('[data-playing-bottom-hand-host]')?.remove()
    document.body.querySelector('[data-sweep-offer-prompt-root]')?.remove()
    document.body.querySelector('[data-sweep-throw-down-overlay]')?.remove()
    document.body.querySelector('[data-playing-input-notice]')?.remove()
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
  cache.pendingPlayCardId = null
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
  // Nulling тук (не само в resetCacheForFreshSnapshot) е задължително: това е
  // extract-from-playing пътят — root.innerHTML ще бъде презаписан от други
  // фазови renderer-и (scoring/cutting/bidding/dealing) преди евентуално
  // връщане в playing. Ако lastPlayingShellKey оцелее stale през това,
  // следващият renderPlayingScreen() би заключил "same shell" и би опитал
  // targeted patch върху [data-trick-patch-host]/[data-active-room-score-hud]
  // nodes, които вече не съществуват в DOM-а.
  cache.lastPlayingShellKey = null
  cache.lastTrickStableKey = null
  cache.lastScoreHudRenderedHtml = null
  cache.sweepOfferDismissedKey = null
  cache.sweepAcceptSent = false
  cache.lastSweepResolutionKey = null
  cache.isSweepAnimating = false
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
