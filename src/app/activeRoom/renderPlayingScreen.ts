import type {
  RoomCardSnapshot,
  RoomCompletedTrickSnapshot,
  RoomDeclarationSnapshot,
  RoomGameSnapshot,
  RoomPlayCardSnapshot,
  RoomSeatSnapshot,
  RoomWinningBidSnapshot,
  Seat,
  TournamentBotReplacementSnapshot,
} from '../network/createGameServerClient'
import { getCardFaceImagePath } from './cardImageAssets'
import {
  ACTIVE_ROOM_MAX_STAGE_SCALE,
  ACTIVE_ROOM_MIN_STAGE_SCALE,
  ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT,
  ACTIVE_ROOM_MOBILE_TABLE_BACKGROUND,
  ACTIVE_ROOM_TABLE_STAGE_BACKGROUND,
  ACTIVE_ROOM_TABLE_BACKGROUND,
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
  ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
  ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
  BOTTOM_HAND_MOBILE_CARD_WIDTH,
  BOTTOM_HAND_MOBILE_CARD_HEIGHT,
  BOTTOM_HAND_MOBILE_SPACING,
  BOTTOM_HAND_MOBILE_CENTER_Y_OFFSET,
  getBottomHandMobileFanScale,
  escapeHtml,
} from './activeRoomShared'
import {
  createCuttingSeatPanelsHtml,
  createSeatBubbleLayerHtml,
  type DealtHandsData,
  type SeatDeclarationBubble,
  type SeatEmojiBubble,
  type SeatPhraseBubble,
} from './cutting/renderCuttingSeatPanels'
import { syncMobilePhraseOverlay } from './cutting/syncMobilePhraseOverlay'
import {
  getCuttingSeatPanelAnchorStyle,
  getVisualSeatForLocalPerspective,
} from './cutting/cuttingSeatLayout'
import { sortLocalHandForDisplay, type SortDisplayOptions } from './sortLocalHand'
import { animateTrickCollection } from './animateTrickCollection'
import type { PlayingUiCache } from './activeRoomTypes'
import { renderScoreHud } from './renderScoreHud'
import {
  createPendingDeclarationPrompt,
  normalizeSelectedDeclarationKeys,
  resolveClientDeclarationCandidatesForPlay,
} from './declarations/declarationPromptState'
import {
  removeDeclarationPrompt,
  renderDeclarationPrompt,
} from './declarations/renderDeclarationPrompt'
import { getViewportStageMetrics, isPhoneLayoutViewport } from '../../ui/layout/viewportStage'

const PLAY_CARD_ENTRY_ANIMATION_MS = 400
const COMPLETED_TRICK_PREVIEW_MS = 220
const TRICK_COLLECTION_GATHER_MS = 180
const TRICK_COLLECTION_FLY_MS = 420
const TRICK_COLLECTION_CARD_STAGGER_MS = 35
const PLAYING_COLLECT_OVERLAY_Z_INDEX = 9000
const PLAY_HUMAN_TIMEOUT_MS = 20_000
const PLAY_BOT_DELAY_MS = 800
const DECLARATION_BUBBLE_VISIBLE_MS = 1_500

const TRICK_W = 170
const TRICK_H = 247
const HAND_W = 195
const HAND_H = 284
const BOTTOM_PANEL_WIDTH = 360
const BOTTOM_PANEL_HEIGHT = 138
const BOTTOM_HAND_CENTER_X = 180
const BOTTOM_HAND_CENTER_Y = 50

// Mobile playing stacking (положителни нива, без z-index:-1):
//   bottom-hand-overlay (местна ръка карти, fixed дете на #app)  — z-index:1
//   seat-panels-host (opponent hand fan-ове + всички profile карета,
//     вкл. долното) — z-index:2
//   mobile-trick-layer-host (static trick cards)  — z-index:3
//   mobile-bubble-layer-host (announcement bubbles) — z-index:4
// #app самия няма явен z-index, затова position:fixed деца с explicit
// z-index (bottom-hand-overlay) участват directno в document-level
// сравнение с останалите host-ове — числата по-долу са избрани сравними
// на това ниво, независимо от DOM ред.
const MOBILE_BOTTOM_HAND_Z_INDEX = 1
const MOBILE_SEAT_PANELS_Z_INDEX = 2
const MOBILE_TRICK_LAYER_Z_INDEX = 3
const MOBILE_BUBBLE_LAYER_Z_INDEX = 4
const ACTIVE_HAND_CARD_LIFT = ' translateY(-5px)'
const ACTIVE_HAND_CARD_FILTER = 'brightness(1.03) drop-shadow(0 8px 12px rgba(0,0,0,0.18))'

const SEAT_TRICK_OFFSET: Record<Seat, { left: number; top: number; rotate: number }> = {
  top: { left: 0, top: -54, rotate: 0 },
  left: { left: -78, top: 0, rotate: -8 },
  right: { left: 78, top: 0, rotate: 8 },
  bottom: { left: 0, top: 54, rotate: 0 },
}

const ENTRY_OFFSET: Record<Seat, { x: number; y: number }> = {
  top: { x: 0, y: -200 },
  left: { x: -220, y: 0 },
  right: { x: 220, y: 0 },
  bottom: { x: 0, y: 220 },
}

const SUIT_SYMBOL: Record<string, string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
}

const DECLARATION_LABEL_ORDER: readonly string[] = [
  'Каре',
  'Терца',
  '50',
  '100',
  'Белот',
]

type PlayedCardFlySource = {
  rect: DOMRect
  physicalWidth: number
  physicalHeight: number
}

type ActiveDeclarationBubble = SeatDeclarationBubble & {
  entryKey: string
  needsTimerStart: boolean
}

type QueuedDeclarationBubble = {
  entryKey: string
  lines: string[]
  signatures: string[]
}

type DeclarationBubbleTrigger = {
  seat: Seat
  trickIndex: number
  cardId: string
}

type DeclarationBubbleUiState = {
  shownSignatures: string[]
  activeBubbles: Partial<Record<Seat, ActiveDeclarationBubble>>
  queuedBubbles: Partial<Record<Seat, QueuedDeclarationBubble[]>>
  timerIds: Partial<Record<Seat, number>>
}

const latestRenderOptionsByCache = new WeakMap<PlayingUiCache, RenderPlayingScreenOptions>()
const playedCardFlySourceByCache = new WeakMap<PlayingUiCache, PlayedCardFlySource>()
const declarationBubbleStateByCache = new WeakMap<PlayingUiCache, DeclarationBubbleUiState>()
const mobileOptimisticDeclarationAudioByCache = new WeakMap<PlayingUiCache, Set<string>>()

function getScaledPhysicalElementSize(
  element: HTMLElement,
  stageScale: number,
): {
  width: number
  height: number
} {
  const computedStyle = window.getComputedStyle(element)
  const computedWidth = Number.parseFloat(computedStyle.width)
  const computedHeight = Number.parseFloat(computedStyle.height)
  const baseWidth = Number.isFinite(computedWidth) && computedWidth > 0
    ? computedWidth
    : element.offsetWidth
  const baseHeight = Number.isFinite(computedHeight) && computedHeight > 0
    ? computedHeight
    : element.offsetHeight

  return {
    width: baseWidth * stageScale,
    height: baseHeight * stageScale,
  }
}

function getRotateDegreesFromTransform(transform: string): number {
  const rotateMatch = transform.match(/rotate\((-?\d+(?:\.\d+)?)deg\)/)
  if (!rotateMatch) {
    return 0
  }

  const rotateDegrees = Number.parseFloat(rotateMatch[1] ?? '')
  return Number.isFinite(rotateDegrees) ? rotateDegrees : 0
}

function createSourceRectFromPoint(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
): DOMRect {
  return new DOMRect(centerX - width / 2, centerY - height / 2, width, height)
}

function getSeatPanelFlySourcePoint(rect: DOMRect, visualSeat: Seat): {
  x: number
  y: number
} {
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2

  if (visualSeat === 'bottom') {
    return { x: centerX, y: rect.top + rect.height * 0.18 }
  }

  if (visualSeat === 'top') {
    return { x: centerX, y: rect.bottom - rect.height * 0.18 }
  }

  if (visualSeat === 'left') {
    return { x: rect.right - rect.width * 0.14, y: centerY }
  }

  return { x: rect.left + rect.width * 0.14, y: centerY }
}

function resolvePlayedCardFlySourceFromSeat(options: {
  root: HTMLElement
  seat: Seat
  localSeat: Seat
  fallbackWidth: number
  fallbackHeight: number
}): PlayedCardFlySource | null {
  const { seat, localSeat, fallbackWidth, fallbackHeight } = options
  const fanElement = document.querySelector<HTMLElement>(
    `[data-active-room-seat-card-fan="${seat}"]`,
  )
  const fanCards = fanElement
    ? Array.from(fanElement.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      )
    : []
  const sourceCard = fanCards
    .reverse()
    .find((element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })

  if (sourceCard) {
    const sourceRect = sourceCard.getBoundingClientRect()
    const rect = createSourceRectFromPoint(
      sourceRect.left + sourceRect.width / 2,
      sourceRect.top + sourceRect.height / 2,
      fallbackWidth,
      fallbackHeight,
    )
    return {
      rect,
      physicalWidth: fallbackWidth,
      physicalHeight: fallbackHeight,
    }
  }

  const seatAnchor = document.querySelector<HTMLElement>(
    `[data-active-room-seat-anchor="${seat}"]`,
  )

  if (!seatAnchor) {
    return null
  }

  const seatRect = seatAnchor.getBoundingClientRect()
  if (seatRect.width <= 0 || seatRect.height <= 0) {
    return null
  }

  const visualSeat = getVisualSeatForLocalPerspective(seat, localSeat)
  const sourcePoint = getSeatPanelFlySourcePoint(seatRect, visualSeat)
  const rect = createSourceRectFromPoint(
    sourcePoint.x,
    sourcePoint.y,
    fallbackWidth,
    fallbackHeight,
  )

  return {
    rect,
    physicalWidth: fallbackWidth,
    physicalHeight: fallbackHeight,
  }
}

async function animatePlayedCardFromHand(options: {
  sourceRect: DOMRect
  sourcePhysicalWidth: number
  sourcePhysicalHeight: number
  targetRect: DOMRect
  targetPhysicalWidth: number
  targetPhysicalHeight: number
  cardElement: HTMLElement
  onLanded?: () => void
}): Promise<void> {
  const {
    sourceRect,
    sourcePhysicalWidth,
    sourcePhysicalHeight,
    targetRect,
    targetPhysicalWidth,
    targetPhysicalHeight,
    cardElement,
    onLanded,
  } = options
  const sourceCenterX = sourceRect.left + sourceRect.width / 2
  const sourceCenterY = sourceRect.top + sourceRect.height / 2
  const targetRotateDeg = getRotateDegreesFromTransform(cardElement.style.transform)
  const computedStyle = window.getComputedStyle(cardElement)
  const baseWidth = Number.parseFloat(computedStyle.width)
  const baseHeight = Number.parseFloat(computedStyle.height)
  const cloneBaseWidth = Number.isFinite(baseWidth) && baseWidth > 0
    ? baseWidth
    : TRICK_W
  const cloneBaseHeight = Number.isFinite(baseHeight) && baseHeight > 0
    ? baseHeight
    : TRICK_H
  const visualScale = sourcePhysicalWidth > 0 && cloneBaseWidth > 0
    ? sourcePhysicalWidth / cloneBaseWidth
    : 1

  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9000;overflow:visible'
  document.body.appendChild(overlay)

  const clone = cardElement.cloneNode(true) as HTMLElement
  clone.style.position = 'fixed'
  clone.style.left = `${sourceCenterX - cloneBaseWidth / 2}px`
  clone.style.top = `${sourceCenterY - cloneBaseHeight / 2}px`
  clone.style.width = `${cloneBaseWidth}px`
  clone.style.height = `${cloneBaseHeight}px`
  clone.style.aspectRatio = `${cloneBaseWidth} / ${cloneBaseHeight}`
  clone.style.margin = '0'
  clone.style.transform = 'none'
  clone.style.transformOrigin = 'center center'
  clone.style.pointerEvents = 'none'
  clone.style.zIndex = '9001'
  clone.style.visibility = 'visible'
  overlay.appendChild(clone)

  cardElement.style.visibility = 'hidden'

  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const targetCenterX = targetRect.left + targetRect.width / 2
    const targetCenterY = targetRect.top + targetRect.height / 2
    const dx = targetCenterX - sourceCenterX
    const dy = targetCenterY - sourceCenterY
    void sourcePhysicalHeight
    void targetPhysicalWidth
    void targetPhysicalHeight

    const durationMs = 350

    let didCallOnLanded = false
    function callOnLandedOnce(): void {
      if (didCallOnLanded) {
        return
      }
      didCallOnLanded = true
      onLanded?.()
    }

    // Safety net, set up before clone.animate() so it still fires even if
    // that call throws. onfinish below should always win this race under
    // normal conditions (fires within a frame of durationMs) — this timer
    // only matters if WAAPI never reports finish/cancel at all, so the
    // landing sound isn't silently lost the way a single-signal dependency
    // could drop it. callOnLandedOnce() is idempotent, so this can never
    // fire the sound twice alongside onfinish.
    const safetyTimeoutId = window.setTimeout(callOnLandedOnce, durationMs + 60)

    const anim = clone.animate(
      [
        { transform: `translate(0,0) rotate(0deg) scale(${visualScale})`, opacity: 1 },
        {
          transform: `translate(${dx}px,${dy}px) rotate(${targetRotateDeg}deg) scale(${visualScale})`,
          opacity: 1,
        },
      ],
      { duration: durationMs, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'forwards' },
    )

    const didFinish = await new Promise<boolean>((resolve) => {
      anim.onfinish = () => resolve(true)
      anim.oncancel = () => resolve(false)
    })

    window.clearTimeout(safetyTimeoutId)

    // onLanded fires at animation completion (not a look-ahead offset) —
    // the SFX pool in createGameAudioController.ts is preloaded/reused, so
    // it no longer needs a head start to hide Audio-element startup
    // latency. Don't reintroduce an early-fire offset here.
    if (didFinish) {
      callOnLandedOnce()
    }
  } finally {
    overlay.remove()
    cardElement.style.visibility = ''
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isRedSuit(suit: string): boolean {
  return suit === 'hearts' || suit === 'diamonds'
}

function getTrickKey(plays: RoomPlayCardSnapshot[]): string {
  return plays.map((play) => `${play.seat}:${play.card.id}`).join('|')
}

function getPlayKey(play: RoomPlayCardSnapshot): string {
  return `${play.seat}:${play.card.id}`
}

function getCompletedTrickKey(trick: RoomCompletedTrickSnapshot): string {
  return `${trick.trickIndex}:${trick.winnerSeat}:${getTrickKey(trick.plays)}`
}

function getSortOptions(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): SortDisplayOptions {
  if (!winningBid) {
    return { contract: 'default' }
  }

  if (winningBid.contract === 'no-trumps') {
    return { contract: 'no-trumps' }
  }

  if (winningBid.contract === 'all-trumps') {
    return { contract: 'all-trumps' }
  }

  if (!winningBid.trumpSuit) {
    return { contract: 'default' }
  }

  return { contract: 'suit', trumpSuit: winningBid.trumpSuit }
}

function getDeclarationBubbleLabel(declaration: RoomDeclarationSnapshot): string | null {
  if (declaration.type === 'square') {
    return 'Каре'
  }

  if (declaration.type === 'belote') {
    return 'Белот'
  }

  if (
    declaration.publicLabel === 'Терца' ||
    declaration.publicLabel === '50' ||
    declaration.publicLabel === '100'
  ) {
    return declaration.publicLabel
  }

  return null
}

function getDeclarationSignature(
  declaration: RoomDeclarationSnapshot,
  index: number,
): string {
  return [
    declaration.seat,
    declaration.type,
    declaration.publicLabel,
    String(declaration.points),
    String(declaration.declaredAtTrickIndex),
    String(index),
  ].join(':')
}

function formatDeclarationBubbleLabel(label: string, count: number): string {
  if (count <= 1) {
    return label
  }

  if (label === 'Терца') {
    return `${count} терци`
  }

  return label
}

function getDeclarationLinesKey(lines: string[]): string {
  return lines.join('\u001f')
}

function buildDeclarationBubbleLinesFromLabels(labels: string[]): string[] {
  const counts = new Map<string, number>()

  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return DECLARATION_LABEL_ORDER.flatMap((label) => {
    const count = counts.get(label) ?? 0

    if (count === 0) {
      return []
    }

    return [formatDeclarationBubbleLabel(label, count)]
  })
}

function buildDeclarationBubbleLines(
  declarations: RoomDeclarationSnapshot[],
): string[] {
  const labels: string[] = []

  for (const declaration of declarations) {
    const label = getDeclarationBubbleLabel(declaration)

    if (label === null) {
      continue
    }

    labels.push(label)
  }

  return buildDeclarationBubbleLinesFromLabels(labels)
}

function markMobileOptimisticDeclarationAudio(cache: PlayingUiCache, lines: string[]): void {
  if (lines.length === 0) {
    return
  }

  const key = getDeclarationLinesKey(lines)
  let keys = mobileOptimisticDeclarationAudioByCache.get(cache)

  if (!keys) {
    keys = new Set<string>()
    mobileOptimisticDeclarationAudioByCache.set(cache, keys)
  }

  keys.add(key)
  window.setTimeout(() => {
    const latestKeys = mobileOptimisticDeclarationAudioByCache.get(cache)

    if (!latestKeys) {
      return
    }

    latestKeys.delete(key)

    if (latestKeys.size === 0) {
      mobileOptimisticDeclarationAudioByCache.delete(cache)
    }
  }, DECLARATION_BUBBLE_VISIBLE_MS + 900)
}

function notifyDeclarationBubbleShown(
  cache: PlayingUiCache,
  seat: Seat,
  lines: string[],
  onBubbleShown?: (seat: Seat, lines: string[]) => void,
): void {
  if (!onBubbleShown) {
    return
  }

  if (isPhoneLayoutViewport()) {
    const key = getDeclarationLinesKey(lines)
    const optimisticKeys = mobileOptimisticDeclarationAudioByCache.get(cache)

    if (optimisticKeys?.has(key)) {
      optimisticKeys.delete(key)

      if (optimisticKeys.size === 0) {
        mobileOptimisticDeclarationAudioByCache.delete(cache)
      }

      return
    }
  }

  onBubbleShown(seat, lines)
}

function getDeclarationBubbleUiState(cache: PlayingUiCache): DeclarationBubbleUiState {
  let state = declarationBubbleStateByCache.get(cache)

  if (!state) {
    state = {
      shownSignatures: [],
      activeBubbles: {},
      queuedBubbles: {},
      timerIds: {},
    }
    declarationBubbleStateByCache.set(cache, state)
  }

  return state
}

function clearDeclarationBubbleUiState(cache: PlayingUiCache): void {
  const state = declarationBubbleStateByCache.get(cache)

  if (!state) {
    return
  }

  for (const timerId of Object.values(state.timerIds)) {
    if (timerId !== undefined) {
      window.clearTimeout(timerId)
    }
  }

  declarationBubbleStateByCache.delete(cache)
}

function getActiveDeclarationBubblesForRender(
  state: DeclarationBubbleUiState,
): Partial<Record<Seat, SeatDeclarationBubble>> | null {
  const bubbles: Partial<Record<Seat, SeatDeclarationBubble>> = {}

  for (const [seat, bubble] of Object.entries(state.activeBubbles) as [
    Seat,
    ActiveDeclarationBubble | undefined,
  ][]) {
    if (bubble) {
      bubbles[seat] = { lines: bubble.lines }
    }
  }

  return Object.keys(bubbles).length > 0 ? bubbles : null
}

function buildPendingDeclarationBubbleForTrigger(options: {
  declarations: RoomDeclarationSnapshot[]
  trigger: DeclarationBubbleTrigger
  shownSignatures: Set<string>
}): {
  entryKey: string
  signatures: string[]
  lines: string[]
} | null {
  const { declarations, trigger, shownSignatures } = options
  const pending: RoomDeclarationSnapshot[] = []
  const signatures: string[] = []

  declarations.forEach((declaration, index) => {
    if (declaration.seat !== trigger.seat) {
      return
    }

    if (!declaration.announced) {
      return
    }

    if (declaration.declaredAtTrickIndex !== trigger.trickIndex) {
      return
    }

    if (
      declaration.type === 'belote' &&
      !declaration.cardIds.includes(trigger.cardId)
    ) {
      return
    }

    const signature = getDeclarationSignature(declaration, index)

    if (shownSignatures.has(signature)) {
      return
    }

    pending.push(declaration)
    signatures.push(signature)
  })

  const lines = buildDeclarationBubbleLines(pending)

  if (lines.length === 0 || signatures.length === 0) {
    return null
  }

  return {
    entryKey: `${trigger.seat}:${signatures.join('|')}`,
    signatures,
    lines,
  }
}

function scheduleDeclarationBubbleHide(options: {
  cache: PlayingUiCache
  state: DeclarationBubbleUiState
  seat: Seat
  entryKey: string
  onBubbleShown?: (seat: Seat, lines: string[]) => void
}): void {
  const { cache, state, seat, entryKey, onBubbleShown } = options

  const existingTimerId = state.timerIds[seat]
  if (existingTimerId !== undefined) {
    window.clearTimeout(existingTimerId)
  }

  state.timerIds[seat] = window.setTimeout(() => {
    const activeBubble = state.activeBubbles[seat]

    if (!activeBubble || activeBubble.entryKey !== entryKey) {
      return
    }

    delete state.activeBubbles[seat]
    delete state.timerIds[seat]

    const queueForSeat = state.queuedBubbles[seat] ?? []
    const nextBubble = queueForSeat[0]

    if (nextBubble) {
      const remaining = queueForSeat.slice(1)
      if (remaining.length === 0) {
        delete state.queuedBubbles[seat]
      } else {
        state.queuedBubbles[seat] = remaining
      }
      state.shownSignatures = [...new Set([...state.shownSignatures, ...nextBubble.signatures])]
      state.activeBubbles[seat] = {
        entryKey: nextBubble.entryKey,
        lines: nextBubble.lines,
        needsTimerStart: true,
      }
      notifyDeclarationBubbleShown(cache, seat, nextBubble.lines, onBubbleShown)
    }

    const latestOptions = latestRenderOptionsByCache.get(cache)
    if (latestOptions) {
      renderPlayingScreen(latestOptions)
    }
  }, DECLARATION_BUBBLE_VISIBLE_MS)
}

function showOrQueueDeclarationBubble(options: {
  cache: PlayingUiCache
  state: DeclarationBubbleUiState
  trigger: DeclarationBubbleTrigger
  bubble: {
    entryKey: string
    signatures: string[]
    lines: string[]
  }
  onBubbleShown?: (seat: Seat, lines: string[]) => void
}): void {
  const { cache, state, trigger, bubble, onBubbleShown } = options
  const activeBubble = state.activeBubbles[trigger.seat]

  if (activeBubble) {
    const existing = state.queuedBubbles[trigger.seat] ?? []
    state.queuedBubbles[trigger.seat] = [
      ...existing,
      { entryKey: bubble.entryKey, lines: bubble.lines, signatures: bubble.signatures },
    ]
    return
  }

  state.shownSignatures = [
    ...new Set([...state.shownSignatures, ...bubble.signatures]),
  ]
  state.activeBubbles[trigger.seat] = {
    entryKey: bubble.entryKey,
    lines: bubble.lines,
    needsTimerStart: false,
  }
  notifyDeclarationBubbleShown(cache, trigger.seat, bubble.lines, onBubbleShown)

  scheduleDeclarationBubbleHide({
    cache,
    state,
    seat: trigger.seat,
    entryKey: bubble.entryKey,
    onBubbleShown,
  })
}

function syncTransientDeclarationBubbles(options: {
  cache: PlayingUiCache
  game: RoomGameSnapshot
  triggers: DeclarationBubbleTrigger[]
  onBubbleShown?: (seat: Seat, lines: string[]) => void
}): Partial<Record<Seat, SeatDeclarationBubble>> | null {
  const { cache, game, triggers, onBubbleShown } = options
  const state = getDeclarationBubbleUiState(cache)

  for (const trigger of triggers) {
    const queueForSeat = state.queuedBubbles[trigger.seat] ?? []
    const shownSignatures = new Set([
      ...state.shownSignatures,
      ...queueForSeat.flatMap((q) => q.signatures),
    ])
    const pendingBubble = buildPendingDeclarationBubbleForTrigger({
      declarations: game.declarations,
      trigger,
      shownSignatures,
    })

    if (pendingBubble !== null) {
      showOrQueueDeclarationBubble({
        cache,
        state,
        trigger,
        bubble: pendingBubble,
        onBubbleShown,
      })
    }
  }

  return getActiveDeclarationBubblesForRender(state)
}

function getPlayOrderSpread(index: number): {
  left: number
  top: number
  rotate: number
} {
  const centeredIndex = index - 1.5
  return {
    left: centeredIndex * 8,
    top: Math.abs(centeredIndex) * 3,
    rotate: centeredIndex * 2,
  }
}

function getBottomHandOffset(index: number, count: number, stageScale: number): {
  x: number
  y: number
  rotate: number
} {
  const isMobileLayout = isPhoneLayoutViewport()
  const fanScale = isMobileLayout ? getBottomHandMobileFanScale(stageScale) : 1
  const spreadStep = (isMobileLayout ? BOTTOM_HAND_MOBILE_SPACING : 62) * fanScale
  const centeredIndex = index - (count - 1) / 2
  const maxCentered = Math.max(1, (count - 1) / 2)
  const edgeProgress = Math.abs(centeredIndex) / maxCentered
  const countProgress = Math.min(1, Math.max(0, (count - 1) / 7))
  const edgeDrop = edgeProgress * edgeProgress * 34 * countProgress * fanScale
  return {
    x: centeredIndex * spreadStep,
    y: edgeDrop,
    rotate: centeredIndex * 5,
  }
}

function getPlayingCountdownState(
  game: RoomGameSnapshot,
  seats: RoomSeatSnapshot[],
  isTrickCollectionPending: boolean,
): {
  countdownSeat: Seat | null
  countdownRemainingMs: number | null
  countdownTotalMs: number
} {
  const countdownSeat = game.playing?.currentTurnSeat ?? null

  if (
    countdownSeat === null ||
    game.timerDeadlineAt === null ||
    isTrickCollectionPending
  ) {
    return {
      countdownSeat,
      countdownRemainingMs: null,
      countdownTotalMs: PLAY_HUMAN_TIMEOUT_MS,
    }
  }

  const rawCountdownRemainingMs = Math.max(0, game.timerDeadlineAt - Date.now())
  const currentTurnSeatSnapshot =
    seats.find((seat) => seat.seat === countdownSeat) ?? null

  const countdownRemainingMs = currentTurnSeatSnapshot?.isBot
    || currentTurnSeatSnapshot?.isControlledByBot
    ? Math.max(
        0,
        PLAY_HUMAN_TIMEOUT_MS -
          (PLAY_BOT_DELAY_MS - Math.min(PLAY_BOT_DELAY_MS, rawCountdownRemainingMs)),
      )
    : rawCountdownRemainingMs

  return {
    countdownSeat,
    countdownRemainingMs,
    countdownTotalMs: PLAY_HUMAN_TIMEOUT_MS,
  }
}

function renderTrickCard(
  play: RoomPlayCardSnapshot,
  index: number,
  count: number,
  localSeat: Seat,
  animateNewest: boolean,
  entryElapsedMs: number,
  flyingCardPlayKey: string | null,
): string {
  const visualSeat = getVisualSeatForLocalPerspective(play.seat, localSeat)
  const seatOffset = SEAT_TRICK_OFFSET[visualSeat]
  const spreadOffset = getPlayOrderSpread(index)
  const finalLeft = seatOffset.left + spreadOffset.left
  const finalTop = seatOffset.top + spreadOffset.top
  const finalRotate = seatOffset.rotate + spreadOffset.rotate
  const isNewest = index === count - 1
  const isHiddenForOverlay = flyingCardPlayKey !== null && getPlayKey(play) === flyingCardPlayKey

  let animationStyle = ''
  if (isNewest && animateNewest) {
    const entryOffset = ENTRY_OFFSET[visualSeat]
    animationStyle = `
      --belot-entry-x:${entryOffset.x}px;
      --belot-entry-y:${entryOffset.y}px;
      --belot-final-rotate:${finalRotate}deg;
      animation:belot-play-card-entry ${PLAY_CARD_ENTRY_ANIMATION_MS}ms cubic-bezier(0.22,1,0.36,1) forwards;
      animation-delay:-${Math.min(entryElapsedMs, PLAY_CARD_ENTRY_ANIMATION_MS)}ms;
    `
  }

  const cardColor = isRedSuit(play.card.suit) ? '#b3261e' : '#13253d'
  const symbol = SUIT_SYMBOL[play.card.suit] ?? ''
  const cardImagePath = getCardFaceImagePath(play.card)

  return `
    <div
      data-current-trick-card="1"
      data-trick-seat="${escapeHtml(play.seat)}"
      data-card-id="${escapeHtml(play.card.id)}"
      style="
        position:absolute;
        left:50%;
        top:50%;
        width:${TRICK_W}px;
        height:${TRICK_H}px;
        margin-left:${-TRICK_W / 2 + finalLeft}px;
        margin-top:${-TRICK_H / 2 + 23 + finalTop}px;
        transform:translate(0,0) rotate(${finalRotate}deg) scale(1);
        transform-origin:center center;
        backface-visibility:hidden;
        will-change:transform;
        z-index:${10 + index};
        pointer-events:none;
        ${isHiddenForOverlay ? 'visibility:hidden;' : ''}
        ${animationStyle}
      "
    >
      <div
        style="
          position:absolute;
          inset:0;
          border-radius:14px;
          box-shadow:0 16px 34px rgba(0,0,0,0.24),inset 0 1px 0 rgba(255,255,255,0.95);
          border:1px solid rgba(21,48,82,0.10);
          overflow:hidden;
        "
      >
        <div
          style="
            position:absolute;
            inset:0;
            border-radius:14px;
            background:linear-gradient(180deg,rgba(255,255,255,0.99) 0%,rgba(241,245,250,0.99) 100%);
            z-index:1;
          "
        >
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
            <span style="font-size:30px;font-weight:900;letter-spacing:0.02em;">${escapeHtml(play.card.rank)}</span>
            <span style="font-size:45px;font-weight:900;">${symbol}</span>
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
            <span style="font-size:30px;font-weight:900;letter-spacing:0.02em;">${escapeHtml(play.card.rank)}</span>
            <span style="font-size:45px;font-weight:900;">${symbol}</span>
          </div>
          <div
            style="
              position:absolute;
              left:50%;
              top:54%;
              transform:translate(-50%,-50%);
              color:${cardColor};
              font-size:54px;
              line-height:1;
              font-weight:900;
            "
          >${symbol}</div>
        </div>
        <img
          src="${escapeHtml(cardImagePath)}"
          alt="${escapeHtml(play.card.rank)} ${escapeHtml(play.card.suit)}"
          onerror="this.style.display='none'"
          style="
            position:absolute;
            inset:0;
            width:100%;
            height:100%;
            display:block;
            object-fit:fill;
            border-radius:14px;
            pointer-events:none;
            user-select:none;
            -webkit-user-drag:none;
            z-index:2;
          "
        />
      </div>
      <div
        style="
          position:absolute;
          inset:4px;
          border-radius:10px;
          border:1px solid rgba(20,49,84,0.12);
          z-index:3;
        "
      ></div>
    </div>
  `
}

function renderTrickArea(
  plays: RoomPlayCardSnapshot[],
  localSeat: Seat,
  animateNewest: boolean,
  newestEntryElapsedMs: number,
  flyingCardPlayKey: string | null,
): string {
  return `
    <style>
      @keyframes belot-play-card-entry {
        0% {
          opacity:1;
          transform:translate(var(--belot-entry-x),var(--belot-entry-y)) rotate(var(--belot-final-rotate)) scale(1.42);
        }
        100% {
          opacity:1;
          transform:translate(0px,0px) rotate(var(--belot-final-rotate)) scale(1);
        }
      }
    </style>
    <div
      data-current-trick="1"
      style="
        position:relative;
        width:420px;
        height:260px;
        margin:0 auto;
        pointer-events:none;
      "
    >
      ${plays.map((play, index) =>
        renderTrickCard(play, index, plays.length, localSeat, animateNewest, newestEntryElapsedMs, flyingCardPlayKey),
      ).join('')}
    </div>
  `
}

function renderBottomHandOverlay(options: {
  cards: RoomCardSnapshot[]
  validCardIds: string[] | null
  isMyTurn: boolean
  stageScale: number
  hoveredHandCardId: string | null
}): string {
  const { cards, validCardIds, isMyTurn, stageScale, hoveredHandCardId } = options
  const isMobileLayout = isPhoneLayoutViewport()
  const bottomHandFanScale = isMobileLayout ? getBottomHandMobileFanScale(stageScale) : 1
  const bottomInset = isMobileLayout ? ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT : 0
  const handCardWidth = isMobileLayout
    ? BOTTOM_HAND_MOBILE_CARD_WIDTH * bottomHandFanScale
    : HAND_W
  const handCardHeight = isMobileLayout
    ? BOTTOM_HAND_MOBILE_CARD_HEIGHT * bottomHandFanScale
    : HAND_H

  if (cards.length === 0) {
    return ''
  }

  const cardButtons = cards.map((card, index) => {
    const offset = getBottomHandOffset(index, cards.length, stageScale)
    const baseTransform = `translate(-50%,-50%) translate(${offset.x}px,${offset.y}px) rotate(${offset.rotate}deg)`
    const isValid = !isMyTurn || validCardIds === null || validCardIds.includes(card.id)
    const canClick = isMyTurn && isValid
    const isHovered = canClick && card.id === hoveredHandCardId
    const cardTransform = isHovered ? `${baseTransform}${ACTIVE_HAND_CARD_LIFT}` : baseTransform

    return `
      <button
        class="play-hand-card${canClick ? ' play-hand-card--active' : ''}"
        data-card-id="${escapeHtml(card.id)}"
        data-base-transform="${escapeHtml(baseTransform)}"
        data-z="${60 + index}"
        ${!canClick ? 'disabled' : ''}
        style="
          position:absolute;
          left:50%;
          top:50%;
          width:${handCardWidth}px;
          height:${handCardHeight}px;
          padding:0;
          border:1px solid rgba(255,255,255,0.24);
          border-radius:16px;
          background:none;
          overflow:hidden;
          box-shadow:0 8px 18px rgba(0,0,0,0.22);
          transform:${cardTransform};
          cursor:${canClick ? 'pointer' : 'default'};
          pointer-events:${canClick ? 'auto' : 'none'};
          opacity:1;
          filter:${isHovered ? ACTIVE_HAND_CARD_FILTER : 'none'};
          transition:transform 0.12s ease,filter 0.12s ease;
          z-index:${60 + index};
        "
      >
        <img
          src="${escapeHtml(getCardFaceImagePath(card))}"
          alt="${escapeHtml(card.rank)} ${escapeHtml(card.suit)}"
          style="
            width:100%;
            height:100%;
            display:block;
            object-fit:fill;
            pointer-events:none;
            user-select:none;
            -webkit-user-drag:none;
          "
        />
        <span
          aria-hidden="true"
          style="
            position:absolute;
            inset:4px;
            border-radius:10px;
            border:1px solid rgba(20,49,84,0.12);
            pointer-events:none;
          "
        ></span>
      </button>
    `
  }).join('')

  const myTurnBadge = isMyTurn ? '' : String()
    ? `
      <div
        style="
          position:absolute;
          left:50%;
          top:-132px;
          transform:translateX(-50%);
          z-index:120;
          background:rgba(251,191,36,0.12);
          border:1px solid rgba(251,191,36,0.4);
          border-radius:8px;
          padding:4px 16px;
          color:#fde68a;
          font-size:13px;
          font-weight:700;
          letter-spacing:0.04em;
          pointer-events:none;
        "
      >ВАШ РЕД</div>
    `
    : ''

  const bottomHandOverlayZIndex = isMobileLayout ? MOBILE_BOTTOM_HAND_Z_INDEX : 2

  return `
    <div
      data-playing-bottom-hand-overlay="1"
      style="
        position:fixed;
        left:0;
        right:0;
        top:0;
        bottom:${bottomInset}px;
        z-index:${bottomHandOverlayZIndex};
        pointer-events:none;
      "
    >
      <div
        style="
          position:absolute;
          ${getCuttingSeatPanelAnchorStyle('bottom', stageScale)}
          width:${BOTTOM_PANEL_WIDTH}px;
          height:${BOTTOM_PANEL_HEIGHT}px;
          pointer-events:none;
        "
      >
        ${myTurnBadge}
        <div
          data-playing-bottom-hand="1"
          style="
            position:absolute;
            left:${BOTTOM_HAND_CENTER_X}px;
            top:${isMobileLayout ? BOTTOM_HAND_CENTER_Y + BOTTOM_HAND_MOBILE_CENTER_Y_OFFSET : BOTTOM_HAND_CENTER_Y}px;
            width:1px;
            height:1px;
            pointer-events:none;
          "
        >
          ${cardButtons}
        </div>
      </div>
    </div>
  `
}

function renderPlayingStage(options: {
  plays: RoomPlayCardSnapshot[]
  localSeat: Seat
  animateNewest: boolean
  newestEntryElapsedMs: number
  flyingCardPlayKey: string | null
  skipTrickArea?: boolean
}): string {
  const {
    plays,
    localSeat,
    animateNewest,
    newestEntryElapsedMs,
    flyingCardPlayKey,
    skipTrickArea = false,
  } = options

  return `
    <section
      style="
        position:relative;
        width:100%;
        height:100%;
        background:${ACTIVE_ROOM_TABLE_STAGE_BACKGROUND};
        overflow:visible;
      "
    >
      <div
        style="
          position:absolute;
          left:50%;
          top:50%;
          transform:translate(-50%,-50%);
          z-index:2;
        "
      >
        ${skipTrickArea ? '' : renderTrickArea(plays, localSeat, animateNewest, newestEntryElapsedMs, flyingCardPlayKey)}
      </div>
    </section>
  `
}

// Mobile playing: static trick cards се рендират в собствен, самостоятелен
// position:fixed host, вмъкнат в document.body веднага след #app (root).
// Причина: seat panels/bubbles host-овете (appendChild-нати СЛЕД #app от
// контролера) трябва да останат над хвърлените карти, а самите карти
// трябва да останат над hand fan-а и profile карето (вътре в #app) —
// невъзможно с общ z-index, докато и трите дела общ DOM branch. Извеждаме
// само trick area (проста, self-contained, вече изцяло пренаписвана при
// всеки render — без incremental diffing за счупване) в нов layer между
// #app и seat-panels-host. Геометрията (outer flex wrapper + stage scale
// wrapper) е copy на съществуващите root.innerHTML стойности — same
// stageScale/scaledStageWidth/Height/screenHeightStyle, без нова формула.
function renderMobileTrickLayerHtml(options: {
  screenHeightStyle: string
  scaledStageWidth: number
  scaledStageHeight: number
  stageScale: number
  plays: RoomPlayCardSnapshot[]
  localSeat: Seat
  animateNewest: boolean
  newestEntryElapsedMs: number
  flyingCardPlayKey: string | null
}): string {
  const {
    screenHeightStyle,
    scaledStageWidth,
    scaledStageHeight,
    stageScale,
    plays,
    localSeat,
    animateNewest,
    newestEntryElapsedMs,
    flyingCardPlayKey,
  } = options

  if (plays.length === 0) {
    return ''
  }

  return `
    <div
      style="
        position:fixed;
        inset:0;
        ${screenHeightStyle}
        width:100%;
        box-sizing:border-box;
        display:flex;
        align-items:center;
        justify-content:center;
        overflow:hidden;
        pointer-events:none;
      "
    >
      <div
        style="
          position:relative;
          width:${scaledStageWidth}px;
          height:${scaledStageHeight}px;
          flex:0 0 auto;
        "
      >
        <div
          style="
            position:absolute;
            left:50%;
            top:50%;
            width:${ACTIVE_ROOM_STAGE_WIDTH}px;
            height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
            transform:translate(-50%, -50%) scale(${stageScale});
            transform-origin:center center;
          "
        >
          <div
            style="
              position:absolute;
              left:50%;
              top:50%;
              transform:translate(-50%,-50%);
            "
          >
            ${renderTrickArea(plays, localSeat, animateNewest, newestEntryElapsedMs, flyingCardPlayKey)}
          </div>
        </div>
      </div>
    </div>
  `
}

function resetCacheForFreshSnapshot(
  cache: PlayingUiCache,
  currentTrickKey: string,
  completedTricksCount: number,
  latestCompletedTrickKey: string | null,
): void {
  cache.lastTrickKey = currentTrickKey
  cache.lastCompletedTricksCount = completedTricksCount
  cache.isTrickCollectionAnimating = false
  cache.pendingCompletedTrickKey = null
  cache.latestCompletedTrickKey = latestCompletedTrickKey
  cache.bufferedCompletedTrick = null
  cache.completedTrickEntryKey = null
  cache.completedTrickEntryStartedAt = 0
  cache.hasRenderedSnapshot = true
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
  playedCardFlySourceByCache.delete(cache)
  clearDeclarationBubbleUiState(cache)
}

function scheduleCompletedTrickCollection(
  options: RenderPlayingScreenOptions,
  completedTrick: RoomCompletedTrickSnapshot,
  delayBeforeCollectMs: number,
): void {
  const { cache, root, localSeat } = options
  const expectedToken = cache.animationToken + 1
  cache.animationToken = expectedToken
  cache.isTrickCollectionAnimating = true

  void (async () => {
    await wait(delayBeforeCollectMs)

    if (cache.animationToken !== expectedToken) {
      return
    }

    const cardElements = queryCurrentTrickCards(root)
    const visualWinner = getVisualSeatForLocalPerspective(
      completedTrick.winnerSeat,
      localSeat,
    )
    const targetElement = document.querySelector<HTMLElement>(
      `[data-active-room-seat-anchor="${completedTrick.winnerSeat}"]`,
    )
    const overlayHost = root.querySelector<HTMLElement>(
      '[data-playing-collect-layer-host="1"]',
    )

    const animationPromise = animateTrickCollection({
      cards: cardElements.map((element) => ({ element })),
      winnerSeat: visualWinner,
      overlayHost,
      targetElement,
      gatherDurationMs: TRICK_COLLECTION_GATHER_MS,
      flyDurationMs: TRICK_COLLECTION_FLY_MS,
      staggerDelayMs: TRICK_COLLECTION_CARD_STAGGER_MS,
      overlayZIndex: PLAYING_COLLECT_OVERLAY_Z_INDEX,
    })

    await animationPromise
  })()
    .catch(() => {})
    .finally(() => {
      if (cache.animationToken !== expectedToken) {
        return
      }

      cache.isTrickCollectionAnimating = false
      cache.pendingCompletedTrickKey = null
      cache.bufferedCompletedTrick = null
      cache.completedTrickEntryKey = null
      cache.completedTrickEntryStartedAt = 0
      const latestOptions = latestRenderOptionsByCache.get(cache)
      if (latestOptions) {
        renderPlayingScreen(latestOptions)
      }
    })
}

function syncPlayingBotTakeoverState(options: {
  cache: PlayingUiCache
  localSeat: Seat
  isMyTurn: boolean
  snapshotPlays: RoomPlayCardSnapshot[]
  latestCompletedTrick: RoomCompletedTrickSnapshot | null
}): void {
  const {
    cache,
    localSeat,
    isMyTurn,
    snapshotPlays,
    latestCompletedTrick,
  } = options
  const observedKeys = new Set(cache.observedPlayKeys)
  const visiblePlays = latestCompletedTrick === null
    ? snapshotPlays
    : [...snapshotPlays, ...latestCompletedTrick.plays]

  for (const play of visiblePlays) {
    const playKey = getPlayKey(play)
    if (observedKeys.has(playKey)) {
      continue
    }

    if (
      play.seat === localSeat &&
      cache.wasMyTurn &&
      !cache.pendingPlayCardSent &&
      !cache.hasShownBotTakeover
    ) {
      cache.showBotTakeover = true
      cache.hasShownBotTakeover = true
    }

    if (play.seat === localSeat) {
      cache.pendingPlayCardSent = false
    }

    observedKeys.add(playKey)
  }

  cache.observedPlayKeys = [...observedKeys]
  cache.wasMyTurn = isMyTurn
}

const MOBILE_TRICK_LAYER_HOST_ATTR = 'data-mobile-trick-layer-host'
const MOBILE_BUBBLE_LAYER_HOST_ATTR = 'data-mobile-bubble-layer-host'
const BOTTOM_HAND_HOST_ATTR = 'data-playing-bottom-hand-host'

// Bottom-hand card buttons живеят в собствен host, синхронизиран с
// incremental DOM diffing (по data-card-id), вместо да минават през
// root.innerHTML rewrite-а на всеки render. Причина: card play разчита
// изцяло на нативния 'click' event (виж коментара при event listener
// attach-а по-долу) — ако re-render (server snapshot и т.н.) унищожи и
// пресъздаде button node-а между pointerdown и pointerup на потребителя,
// браузърът изобщо не синтезира 'click' на detached node-а, tap-ът се
// губи безшумно. Reuse-вайки node-а за same card-id между render-и,
// избягваме тази race без да сменяме event модела.
function syncBottomHandOverlay(html: string): HTMLElement | null {
  if (html === '') {
    removeBottomHandOverlay()
    return null
  }

  let host = document.body.querySelector<HTMLDivElement>(`[${BOTTOM_HAND_HOST_ATTR}]`)
  if (!host) {
    host = document.createElement('div')
    host.setAttribute(BOTTOM_HAND_HOST_ATTR, '1')
    document.body.appendChild(host)
    host.innerHTML = html
    return host
  }

  const temp = document.createElement('div')
  temp.innerHTML = html

  const newButtons = Array.from(temp.querySelectorAll<HTMLButtonElement>('[data-card-id]'))
  const existingButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-card-id]'))
  const newIds = new Set(newButtons.map((b) => b.dataset.cardId))
  const existingIds = new Set(existingButtons.map((b) => b.dataset.cardId))
  const sameCardSet = newIds.size === existingIds.size && [...newIds].every((id) => existingIds.has(id))

  if (!sameCardSet) {
    // Ръката структурно се е променила (нова раздача, карта изиграна) —
    // пълен rebuild е безопасен тук, старите node-ове за премахнати карти
    // и без друго вече не могат да бъдат цел на активен gesture.
    host.innerHTML = html
    return host
  }

  // Same set от карти — patch-ваме само атрибутите, които варират между
  // render-и (playable/disabled state, hover transform, z-index), без да
  // пипаме самите button/img DOM node-ове.
  for (const newButton of newButtons) {
    const cardId = newButton.dataset.cardId
    const existingButton = existingButtons.find((b) => b.dataset.cardId === cardId)
    if (!existingButton) continue

    if (existingButton.className !== newButton.className) {
      existingButton.className = newButton.className
    }
    const newStyle = newButton.getAttribute('style') ?? ''
    if (existingButton.getAttribute('style') !== newStyle) {
      existingButton.setAttribute('style', newStyle)
    }
    if (existingButton.disabled !== newButton.disabled) {
      existingButton.disabled = newButton.disabled
    }
    if (existingButton.dataset.baseTransform !== newButton.dataset.baseTransform) {
      existingButton.dataset.baseTransform = newButton.dataset.baseTransform ?? ''
    }
    if (existingButton.dataset.z !== newButton.dataset.z) {
      existingButton.dataset.z = newButton.dataset.z ?? ''
    }
  }

  return host
}

function removeBottomHandOverlay(): void {
  document.body.querySelector(`[${BOTTOM_HAND_HOST_ATTR}]`)?.remove()
}

function syncFixedBodyHost(attr: string, zIndex: number, html: string): void {
  let host = document.body.querySelector<HTMLDivElement>(`[${attr}]`)

  if (!host) {
    host = document.createElement('div')
    host.setAttribute(attr, '1')
    document.body.appendChild(host)
  }

  host.style.position = 'relative'
  host.style.zIndex = String(zIndex)
  host.innerHTML = html
}

function syncMobileTrickLayer(html: string): void {
  syncFixedBodyHost(MOBILE_TRICK_LAYER_HOST_ATTR, MOBILE_TRICK_LAYER_Z_INDEX, html)
}

function removeMobileTrickLayer(): void {
  document.body.querySelector(`[${MOBILE_TRICK_LAYER_HOST_ATTR}]`)?.remove()
}

function syncMobileBubbleLayer(html: string): void {
  if (html === '') {
    removeMobileBubbleLayer()
    return
  }

  syncFixedBodyHost(MOBILE_BUBBLE_LAYER_HOST_ATTR, MOBILE_BUBBLE_LAYER_Z_INDEX, html)
}

function removeMobileBubbleLayer(): void {
  document.body.querySelector(`[${MOBILE_BUBBLE_LAYER_HOST_ATTR}]`)?.remove()
}

// seat-panels-host (hand fan + profile каре) е управляван изцяло от
// createActiveRoomFlowController.ts (syncSeatPanels) — не пипаме неговата
// структура/съдържание. Тук само задаваме/чистим стиловите му position и
// z-index свойства отвън, за да участва коректно в mobile stacking-а
// спрямо новите trick/bubble host-ове. Извън mobile playing z-index-ът се
// маха (връща се към auto — старото поведение).
function applyMobileSeatPanelsZIndex(enabled: boolean): void {
  const host = document.body.querySelector<HTMLElement>('[data-seat-panels-host="1"]')
  if (!host) return
  host.style.position = enabled ? 'relative' : ''
  host.style.zIndex = enabled ? String(MOBILE_SEAT_PANELS_Z_INDEX) : ''
}

function queryCurrentTrickCards(root: HTMLDivElement): HTMLElement[] {
  const mobileHost = document.body.querySelector<HTMLElement>(`[${MOBILE_TRICK_LAYER_HOST_ATTR}]`)
  const scope = mobileHost ?? root
  return Array.from(scope.querySelectorAll<HTMLElement>('[data-current-trick-card]'))
}

export type RenderPlayingScreenOptions = {
  root: HTMLDivElement
  game: RoomGameSnapshot
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  roomId: string
  winningBid: NonNullable<RoomWinningBidSnapshot> | null
  stageScale: number
  scaledStageWidth: number
  scaledStageHeight: number
  submitPlayCard: (roomId: string, cardId: string, declarationKeys?: string[]) => void
  onDeclarationBubbleShown?: (seat: Seat, lines: string[]) => void
  onPlayedCardLanded?: () => void
  syncSeatPanels?: (html: string) => void
  emojiBubbles?: Partial<Record<Seat, SeatEmojiBubble>> | null
  phraseBubbles?: Partial<Record<Seat, SeatPhraseBubble>> | null
  tournamentBotReplacements?: TournamentBotReplacementSnapshot[] | null
  cache: PlayingUiCache
}

export function renderPlayingScreen(options: RenderPlayingScreenOptions): void {
  const {
    root,
    game,
    seats,
    localSeat,
    roomId,
    winningBid,
    stageScale: sourceStageScale,
    scaledStageWidth: sourceScaledStageWidth,
    scaledStageHeight: sourceScaledStageHeight,
    submitPlayCard,
    onDeclarationBubbleShown,
    onPlayedCardLanded,
    syncSeatPanels,
    emojiBubbles,
    phraseBubbles,
    tournamentBotReplacements,
    cache,
  } = options

  latestRenderOptionsByCache.set(cache, options)
  const isCollectingTrickOnEntry = cache.isTrickCollectionAnimating

  const playing = game.playing
  const snapshotPlays = playing?.currentTrickPlays ?? []
  const completedCount = playing?.completedTricksCount ?? 0
  const validCardIds = playing?.validCardIds ?? null
  const latestCompletedTrick = playing?.latestCompletedTrick ?? null
  const snapshotTrickKey = getTrickKey(snapshotPlays)
  const latestCompletedTrickKey =
    latestCompletedTrick !== null ? getCompletedTrickKey(latestCompletedTrick) : null

  if (!cache.hasRenderedSnapshot) {
    clearDeclarationBubbleUiState(cache)
    cache.hasRenderedSnapshot = true
    cache.lastCompletedTricksCount = completedCount
    cache.lastTrickKey = snapshotTrickKey
    cache.latestCompletedTrickKey = latestCompletedTrickKey
  } else if (completedCount < cache.lastCompletedTricksCount) {
    resetCacheForFreshSnapshot(cache, snapshotTrickKey, completedCount, latestCompletedTrickKey)
  }

  if (isCollectingTrickOnEntry) {
    return
  }

  const hasNewCompletedTrick = completedCount > cache.lastCompletedTricksCount
  let shouldStartCollection = false

  if (
    hasNewCompletedTrick &&
    !cache.isTrickCollectionAnimating &&
    cache.pendingCompletedTrickKey === null
  ) {
    const canAnimateCompletedTrick =
      latestCompletedTrick !== null &&
      latestCompletedTrick.plays.length === 4 &&
      latestCompletedTrickKey !== null &&
      latestCompletedTrickKey !== cache.latestCompletedTrickKey

    cache.lastCompletedTricksCount = completedCount

    if (canAnimateCompletedTrick) {
      cache.pendingCompletedTrickKey = latestCompletedTrickKey
      cache.latestCompletedTrickKey = latestCompletedTrickKey
      cache.bufferedCompletedTrick = latestCompletedTrick
      cache.completedTrickEntryKey = latestCompletedTrickKey
      cache.completedTrickEntryStartedAt = performance.now()
      shouldStartCollection = true
    } else if (latestCompletedTrickKey !== null) {
      cache.latestCompletedTrickKey = latestCompletedTrickKey
    }
  }

  const isShowingBufferedCompletedTrick =
    cache.pendingCompletedTrickKey !== null &&
    cache.bufferedCompletedTrick !== null &&
    cache.pendingCompletedTrickKey === getCompletedTrickKey(cache.bufferedCompletedTrick)

  const displayedPlays = isShowingBufferedCompletedTrick
    ? cache.bufferedCompletedTrick!.plays
    : snapshotPlays
  const completedTrickEntryElapsedMs =
    isShowingBufferedCompletedTrick &&
    cache.pendingCompletedTrickKey !== null &&
    cache.completedTrickEntryKey === cache.pendingCompletedTrickKey
      ? Math.max(0, performance.now() - cache.completedTrickEntryStartedAt)
      : 0
  const shouldAnimateCompletedTrickNewest =
    isShowingBufferedCompletedTrick &&
    completedTrickEntryElapsedMs < PLAY_CARD_ENTRY_ANIMATION_MS &&
    cache.completedTrickEntryKey === cache.pendingCompletedTrickKey
  const animateNewest =
    shouldAnimateCompletedTrickNewest ||
    !isShowingBufferedCompletedTrick &&
    !cache.isTrickCollectionAnimating &&
    snapshotPlays.length > 0 &&
    snapshotPlays.length < 4 &&
    snapshotTrickKey !== cache.lastTrickKey

  const newestDisplayedPlay = animateNewest
    ? displayedPlays[displayedPlays.length - 1] ?? null
    : null
  let pendingPlayedCardSource: PlayedCardFlySource | null = null
  const shouldAnimateNewestViaOverlay = animateNewest && newestDisplayedPlay !== null
  if (animateNewest && newestDisplayedPlay?.seat === localSeat) {
    pendingPlayedCardSource = playedCardFlySourceByCache.get(cache) ?? (
      cache.lastPlayedCardRect === null
        ? null
        : {
            rect: cache.lastPlayedCardRect,
            physicalWidth: cache.lastPlayedCardRect.width,
            physicalHeight: cache.lastPlayedCardRect.height,
          }
    )
    cache.lastPlayedCardRect = null
    playedCardFlySourceByCache.delete(cache)
  } else if (!animateNewest) {
    cache.lastPlayedCardRect = null
    playedCardFlySourceByCache.delete(cache)
  }

  cache.lastTrickKey = snapshotTrickKey

  if (shouldAnimateNewestViaOverlay && newestDisplayedPlay !== null) {
    cache.flyingCardPlayKey = getPlayKey(newestDisplayedPlay)
  }

  const sortedHand = sortLocalHandForDisplay(game.ownHand, getSortOptions(winningBid))
  const isMyTurn = playing?.currentTurnSeat === localSeat
  const displayedTrickIndex = isShowingBufferedCompletedTrick
    ? cache.bufferedCompletedTrick?.trickIndex ?? null
    : completedCount
  const declarationBubbleTriggers: DeclarationBubbleTrigger[] =
    displayedTrickIndex === null
      ? []
      : displayedPlays.map((play) => ({
          seat: play.seat,
          trickIndex: displayedTrickIndex,
          cardId: play.card.id,
        }))
  const declarationBubbles = syncTransientDeclarationBubbles({
    cache,
    game,
    triggers: declarationBubbleTriggers,
    onBubbleShown: onDeclarationBubbleShown,
  })

  const declarationBubbleState = getDeclarationBubbleUiState(cache)
  for (const seatKey of Object.keys(declarationBubbleState.activeBubbles) as Seat[]) {
    const pendingActive = declarationBubbleState.activeBubbles[seatKey]
    if (pendingActive?.needsTimerStart) {
      pendingActive.needsTimerStart = false
      scheduleDeclarationBubbleHide({
        cache,
        state: declarationBubbleState,
        seat: seatKey,
        entryKey: pendingActive.entryKey,
        onBubbleShown: onDeclarationBubbleShown,
      })
    }
  }

  function canSubmitHandCard(cardId: string): boolean {
    if (!isMyTurn) {
      return false
    }

    if (validCardIds !== null && !validCardIds.includes(cardId)) {
      return false
    }

    return sortedHand.some((card) => card.id === cardId)
  }

  function resolveDeclarationCandidatesForCard(cardId: string) {
    return resolveClientDeclarationCandidatesForPlay({
      hand: sortedHand,
      contract: winningBid,
      cardId,
      completedTricksCount: completedCount,
      currentTrickPlays: snapshotPlays,
      submittedDeclarationKeys: cache.submittedDeclarationKeys,
    })
  }

  if (cache.pendingDeclarationPrompt !== null) {
    const pendingDeclarationCandidates = resolveDeclarationCandidatesForCard(
      cache.pendingDeclarationPrompt.cardId,
    )

    if (
      cache.pendingPlayCardSent ||
      !canSubmitHandCard(cache.pendingDeclarationPrompt.cardId) ||
      pendingDeclarationCandidates.length === 0
    ) {
      cache.pendingDeclarationPrompt = null
      removeDeclarationPrompt(root)
    } else {
      cache.pendingDeclarationPrompt = {
        ...cache.pendingDeclarationPrompt,
        options: [...pendingDeclarationCandidates].sort((left, right) =>
          left.key.localeCompare(right.key),
        ),
        selectedKeys: normalizeSelectedDeclarationKeys(
          pendingDeclarationCandidates,
          cache.pendingDeclarationPrompt.selectedKeys,
        ),
      }
    }
  }

  syncPlayingBotTakeoverState({
    cache,
    localSeat,
    isMyTurn,
    snapshotPlays,
    latestCompletedTrick,
  })
  cache.showBotTakeover = false
  if (cache.hoveredHandCardId !== null) {
    const hoveredHandCardStillClickable = sortedHand.some((card) => {
      const isValid = !isMyTurn || validCardIds === null || validCardIds.includes(card.id)
      return card.id === cache.hoveredHandCardId && isMyTurn && isValid
    })

    if (!hoveredHandCardStillClickable) {
      cache.hoveredHandCardId = null
    }
  }

  const panelHandCounts = {
    ...game.handCounts,
    [localSeat]: 0,
  }
  const dealtHandsForPanels: DealtHandsData = {
    handCounts: panelHandCounts,
    ownHand: sortedHand,
    previousOwnHand: null,
    localSeat,
    maxCardsPerSeat: 8,
    animStartIndex: 0,
    seatAnimDelays: null,
  }
  const {
    countdownSeat: playingCountdownSeat,
    countdownRemainingMs: playingCountdownRemainingMs,
    countdownTotalMs: playingCountdownTotalMs,
  } = getPlayingCountdownState(
    game,
    seats,
    isShowingBufferedCompletedTrick || shouldStartCollection,
  )
  const isPhoneLayout = isPhoneLayoutViewport()
  const mobileLayoutAttribute = isPhoneLayout ? 'data-mobile-layout="1"' : ''
  const tableBackground = isPhoneLayout
    ? ACTIVE_ROOM_MOBILE_TABLE_BACKGROUND
    : ACTIVE_ROOM_TABLE_BACKGROUND
  const mobileStageMetrics = isPhoneLayout
    ? getViewportStageMetrics({
        baseWidth: ACTIVE_ROOM_STAGE_WIDTH,
        baseHeight: ACTIVE_ROOM_STAGE_HEIGHT,
        minScale: ACTIVE_ROOM_MIN_STAGE_SCALE,
        maxScale: ACTIVE_ROOM_MAX_STAGE_SCALE,
        viewportHorizontalPadding: ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
        viewportVerticalPadding: ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
        reservedTopSpace: ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT,
      })
    : null
  const stageScale = mobileStageMetrics?.stageScale ?? sourceStageScale
  const scaledStageWidth = mobileStageMetrics?.scaledStageWidth ?? sourceScaledStageWidth
  const scaledStageHeight = mobileStageMetrics?.scaledStageHeight ?? sourceScaledStageHeight
  const screenHeightStyle = isPhoneLayout
    ? `height:calc(100dvh - ${ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT}px);min-height:calc(100dvh - ${ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT}px);`
    : 'min-height:100vh;'
  const fixedLayerInsetStyle = isPhoneLayout
    ? `left:0;right:0;top:0;bottom:${ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT}px;`
    : 'inset:0;'

  root.innerHTML = `
    <div
      ${mobileLayoutAttribute}
      style="
        position:relative;
        ${screenHeightStyle}
        width:100%;
        box-sizing:border-box;
        display:flex;
        align-items:center;
        justify-content:center;
        overflow:hidden;
        background:${tableBackground};
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div
        style="
          position:relative;
          width:${scaledStageWidth}px;
          height:${scaledStageHeight}px;
          flex:0 0 auto;
        "
      >
        <div
          style="
            position:absolute;
            left:50%;
            top:50%;
            width:${ACTIVE_ROOM_STAGE_WIDTH}px;
            height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
            transform:translate(-50%, -50%) scale(${stageScale});
            transform-origin:center center;
          "
        >
          <div
            data-active-room-playing-visual="1"
            style="
              position:relative;
              width:100%;
              height:100%;
              overflow:visible;
            "
          >
            ${renderPlayingStage({
              plays: displayedPlays,
              localSeat,
              animateNewest: shouldAnimateNewestViaOverlay ? false : animateNewest,
              newestEntryElapsedMs: shouldAnimateCompletedTrickNewest
                ? completedTrickEntryElapsedMs
                : 0,
              flyingCardPlayKey: cache.flyingCardPlayKey,
              skipTrickArea: isPhoneLayout,
            })}
          </div>
        </div>
      </div>
      <div
        data-playing-collect-layer-host="1"
        style="
          position:fixed;
          ${fixedLayerInsetStyle}
          z-index:2;
          pointer-events:none;
          overflow:visible;
        "
      ></div>
      ${renderScoreHud({
        game,
        seats,
        localSeat,
        winningBid,
        stageScale,
      })}
    </div>
  `

  const bottomHandHost = syncBottomHandOverlay(renderBottomHandOverlay({
    cards: sortedHand,
    validCardIds,
    isMyTurn,
    stageScale,
    hoveredHandCardId: cache.hoveredHandCardId,
  }))

  if (isPhoneLayout) {
    syncMobileTrickLayer(renderMobileTrickLayerHtml({
      screenHeightStyle,
      scaledStageWidth,
      scaledStageHeight,
      stageScale,
      plays: displayedPlays,
      localSeat,
      animateNewest: shouldAnimateNewestViaOverlay ? false : animateNewest,
      newestEntryElapsedMs: shouldAnimateCompletedTrickNewest
        ? completedTrickEntryElapsedMs
        : 0,
      flyingCardPlayKey: cache.flyingCardPlayKey,
    }))
  } else {
    removeMobileTrickLayer()
  }

  applyMobileSeatPanelsZIndex(isPhoneLayout)

  if (syncSeatPanels) {
    const seatPanelKey = [
      game.dealerSeat ?? 'null',
      playingCountdownSeat ?? 'null',
      playingCountdownSeat !== null ? (playingCountdownRemainingMs !== null ? '1' : '0') : '0',
      JSON.stringify(game.handCounts),
      JSON.stringify(declarationBubbles),
    ].join('|')

    const emojiKey = emojiBubbles ? JSON.stringify(Object.keys(emojiBubbles).sort()) : 'null'
    const phraseKey = phraseBubbles ? JSON.stringify(Object.keys(phraseBubbles).sort()) : 'null'
    const fullSeatPanelKey =
      seatPanelKey +
      `|scale:${stageScale.toFixed(3)}` +
      '|emoji:' + emojiKey +
      '|phrase:' + phraseKey +
      '|bubbleLayer:' + (isPhoneLayout ? '1' : '0')

    if (fullSeatPanelKey !== cache.lastSeatPanelKey) {
      cache.lastSeatPanelKey = fullSeatPanelKey
      syncSeatPanels(createCuttingSeatPanelsHtml({
        seats,
        localSeat,
        dealerSeat: game.dealerSeat ?? null,
        cutterSeat: null,
        cuttingCountdownRemainingMs: null,
        countdownSeat: playingCountdownSeat,
        countdownRemainingMs: playingCountdownRemainingMs,
        countdownTotalMs: playingCountdownTotalMs,
        countdownKey: playingCountdownSeat !== null && playingCountdownRemainingMs !== null && game.timerDeadlineAt !== null
          ? `p:${playingCountdownSeat}:${game.timerDeadlineAt}`
          : null,
        highlightSeat: playingCountdownSeat,
        highlightBadgeLabel: null,
        panelScale: stageScale,
        escapeHtml,
        dealtHands: dealtHandsForPanels,
        bidBubbles: null,
        declarationBubbles,
        emojiBubbles: emojiBubbles ?? null,
        phraseBubbles: phraseBubbles ?? null,
        tournamentBotReplacements: tournamentBotReplacements ?? null,
        separateBubbleLayer: isPhoneLayout,
      }))

      if (isPhoneLayout) {
        syncMobileBubbleLayer(createSeatBubbleLayerHtml({
          seats,
          localSeat,
          panelScale: stageScale,
          bidBubbles: null,
          declarationBubbles: declarationBubbles ?? null,
          emojiBubbles: emojiBubbles ?? null,
          phraseBubbles: phraseBubbles ?? null,
          escapeHtml,
        }))
      } else {
        syncMobileBubbleLayer('')
      }

      syncMobilePhraseOverlay({
        seats,
        localSeat,
        phraseBubbles: phraseBubbles ?? null,
        panelScale: stageScale,
      })
    }
  }

  function submitHandCardFromButton(
    button: HTMLButtonElement,
    cardId: string,
    declarationKeys: string[] = [],
  ): void {
    if (cache.pendingPlayCardSent || !canSubmitHandCard(cardId)) {
      return
    }

    cache.pendingDeclarationPrompt = null
    removeDeclarationPrompt(root)
    cache.hoveredHandCardId = null
    cache.lastPlayedCardRect = button.getBoundingClientRect()
    const sourceSize = getScaledPhysicalElementSize(button, stageScale)
    playedCardFlySourceByCache.set(cache, {
      rect: cache.lastPlayedCardRect,
      physicalWidth: sourceSize.width,
      physicalHeight: sourceSize.height,
    })
    cache.pendingPlayCardSent = true
    if (declarationKeys.length > 0) {
      cache.submittedDeclarationKeys = [
        ...new Set([...cache.submittedDeclarationKeys, ...declarationKeys]),
      ]
    }
    submitPlayCard(roomId, cardId, declarationKeys)
  }

  function renderPendingDeclarationPrompt(): void {
    const prompt = cache.pendingDeclarationPrompt

    if (prompt === null) {
      removeDeclarationPrompt(root)
      return
    }

    renderDeclarationPrompt({
      root,
      prompt,
      onSelectionChange: (selectedKeys) => {
        if (cache.pendingDeclarationPrompt === null) {
          return
        }

        cache.pendingDeclarationPrompt = {
          ...cache.pendingDeclarationPrompt,
          selectedKeys: normalizeSelectedDeclarationKeys(
            cache.pendingDeclarationPrompt.options,
            selectedKeys,
          ),
        }
        renderPendingDeclarationPrompt()
      },
      onContinue: (selectedKeys) => {
        const currentPrompt = cache.pendingDeclarationPrompt

        if (currentPrompt === null || cache.pendingPlayCardSent) {
          return
        }

        const cardId = currentPrompt.cardId

        if (!canSubmitHandCard(cardId)) {
          cache.pendingDeclarationPrompt = null
          removeDeclarationPrompt(root)
          return
        }

        const button = Array.from(
          document.body.querySelectorAll<HTMLButtonElement>(
            `[${BOTTOM_HAND_HOST_ATTR}] .play-hand-card--active`,
          ),
        ).find((candidateButton) => candidateButton.dataset.cardId === cardId)

        if (!button) {
          cache.pendingDeclarationPrompt = null
          removeDeclarationPrompt(root)
          return
        }

        const finalSelectedKeys = normalizeSelectedDeclarationKeys(
          currentPrompt.options,
          selectedKeys,
        )

        if (isPhoneLayoutViewport() && finalSelectedKeys.length > 0) {
          const selectedKeySet = new Set(finalSelectedKeys)
          const optimisticLines = buildDeclarationBubbleLinesFromLabels(
            currentPrompt.options
              .filter((option) => selectedKeySet.has(option.key))
              .map((option) => option.publicLabel),
          )

          if (optimisticLines.length > 0) {
            onDeclarationBubbleShown?.(localSeat, optimisticLines)
            markMobileOptimisticDeclarationAudio(cache, optimisticLines)
          }
        }

        submitHandCardFromButton(button, cardId, finalSelectedKeys)
      },
    })
  }

  function handleHandCardChoice(button: HTMLButtonElement, cardId: string): void {
    if (
      cache.pendingPlayCardSent ||
      cache.pendingDeclarationPrompt !== null ||
      !canSubmitHandCard(cardId)
    ) {
      return
    }

    const declarationCandidates = resolveDeclarationCandidatesForCard(cardId)

    if (declarationCandidates.length === 0) {
      submitHandCardFromButton(button, cardId)
      return
    }

    cache.hoveredHandCardId = null
    cache.pendingDeclarationPrompt = createPendingDeclarationPrompt({
      cardId,
      candidates: declarationCandidates,
    })
    renderPendingDeclarationPrompt()
  }

  // Card submission is driven ONLY by the native 'click' event, bound per
  // button with its cardId captured at render time (closure, not re-read
  // from the DOM). A card play used to also be triggered by a delegated
  // 'pointerup' listener on the hand container that resolved the target via
  // `event.target.closest(...)` — a LIVE DOM lookup at release time. This
  // screen fully rebuilds the hand DOM (`root.innerHTML = ...`) on every
  // re-render, and re-renders happen for reasons unrelated to the user's own
  // gesture (any server snapshot, viewport resize/orientationchange, trick
  // collection/fly animation completion). If one of those re-renders landed
  // between pointerdown and pointerup, the delegated listener would resolve
  // whatever card now occupies that screen position — not the card the user
  // actually pressed. 'click' does not have this failure mode: per the UI
  // Events model, a browser only synthesizes 'click' when the element that
  // received the initiating press is still attached at release; if a
  // re-render swaps it out mid-gesture, no click fires at all (the tap is
  // safely dropped instead of being misattributed to a different card).
  // bottomHandHost persists card button DOM node-и between re-renders
  // (виж syncBottomHandOverlay) — listener attach-ът затова е guard-нат с
  // data-listeners-bound, за да не се закачат дублирани listeners на
  // reused node-ове. Нови/newly-active node-ове (marker липсва) винаги
  // получават listener-и.
  bottomHandHost?.querySelectorAll<HTMLButtonElement>('.play-hand-card--active').forEach((button) => {
    const cardId = button.dataset.cardId
    if (!cardId || button.dataset.listenersBound === '1') {
      return
    }
    button.dataset.listenersBound = '1'

    button.addEventListener('click', () => {
      handleHandCardChoice(button, cardId)
    })

    button.addEventListener('pointerenter', () => {
      const baseTransform = button.dataset.baseTransform ?? ''
      const baseZIndex = Number.parseInt(button.dataset.z ?? '50', 10)
      cache.hoveredHandCardId = button.dataset.cardId ?? null
      button.style.transform = `${baseTransform}${ACTIVE_HAND_CARD_LIFT}`
      button.style.filter = ACTIVE_HAND_CARD_FILTER
      button.style.zIndex = String(baseZIndex)
    })

    button.addEventListener('pointerleave', () => {
      const baseTransform = button.dataset.baseTransform ?? ''
      const baseZIndex = Number.parseInt(button.dataset.z ?? '50', 10)
      if (cache.hoveredHandCardId === button.dataset.cardId) {
        cache.hoveredHandCardId = null
      }
      button.style.transform = baseTransform
      button.style.filter = 'none'
      button.style.zIndex = String(baseZIndex)
    })
  })

  renderPendingDeclarationPrompt()

  if (
    shouldAnimateNewestViaOverlay &&
    newestDisplayedPlay !== null
  ) {
    const trickCardEl = queryCurrentTrickCards(root)
      .filter((element) => element.dataset.trickSeat === newestDisplayedPlay.seat)
      .find((element) => element.dataset.cardId === newestDisplayedPlay.card.id)
    if (trickCardEl) {
      const targetRect = trickCardEl.getBoundingClientRect()
      const targetSize = getScaledPhysicalElementSize(trickCardEl, stageScale)
      const playedCardSource =
        pendingPlayedCardSource ??
        resolvePlayedCardFlySourceFromSeat({
          root,
          seat: newestDisplayedPlay.seat,
          localSeat,
          fallbackWidth: targetSize.width,
          fallbackHeight: targetSize.height,
        })

      if (playedCardSource !== null) {
        const sourceCenterX =
          playedCardSource.rect.left + playedCardSource.rect.width / 2
        const sourceCenterY =
          playedCardSource.rect.top + playedCardSource.rect.height / 2
        const normalizedSourceRect = createSourceRectFromPoint(
          sourceCenterX,
          sourceCenterY,
          targetSize.width,
          targetSize.height,
        )

        const flyAnimToken = cache.animationToken
        void animatePlayedCardFromHand({
          sourceRect: normalizedSourceRect,
          sourcePhysicalWidth: targetSize.width,
          sourcePhysicalHeight: targetSize.height,
          targetRect,
          targetPhysicalWidth: targetSize.width,
          targetPhysicalHeight: targetSize.height,
          cardElement: trickCardEl,
          onLanded: onPlayedCardLanded,
        }).finally(() => {
          if (cache.animationToken !== flyAnimToken) {
            return
          }
          cache.flyingCardPlayKey = null
          const latestOptions = latestRenderOptionsByCache.get(cache)
          if (latestOptions) {
            renderPlayingScreen(latestOptions)
          }
        })
      }
    }
  }

  if (shouldStartCollection && cache.bufferedCompletedTrick !== null) {
    scheduleCompletedTrickCollection(
      options,
      cache.bufferedCompletedTrick,
      PLAY_CARD_ENTRY_ANIMATION_MS + COMPLETED_TRICK_PREVIEW_MS,
    )
  }
}
