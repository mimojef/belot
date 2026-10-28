// Балончета с готови фрази в „Не се сърди човече“ — визуално 1:1 с Белот:
//  - desktop: renderPhraseBubble (renderCuttingSeatPanels.ts) — бял card с
//    2px черна рамка, 18px/900, max 230 / min 138 ширина, със същата
//    4500ms fade-in/hold/fade-out анимация; размерите следват stage scale-а
//    на Белот за същия viewport (там bubble-ът живее в anchor, скалиран с
//    panelScale = stageScale);
//  - phone: createMobilePhraseOverlayHtml/syncMobilePhraseOverlay — същият
//    card с 20px шрифт × panelScale, без анимация, позициониран по реалния
//    DOM rect на профила с 5px отстъп.
// Overlay-ят е отделен document.body child (mirror на Белот-ския mobile
// phrase overlay), защото Ludo render() подменя целия екран с innerHTML —
// така балончетата не се пресъздават (и анимацията не рестартира) при всеки
// render, а само се препозиционират спрямо новия DOM на картите.

import type { LudoColor } from './ludoTypes'
import { LUDO_PHRASE_REACTION_Z_INDEX } from './ludoLayerHierarchy'
import {
  ACTIVE_ROOM_MAX_STAGE_SCALE,
  ACTIVE_ROOM_MIN_STAGE_SCALE,
  ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT,
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
  ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
  ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
  escapeHtml,
  getActiveRoomStageMetrics,
} from '../../activeRoom/activeRoomShared'
import { getViewportStageMetrics, isPhoneLayoutViewport } from '../../../ui/layout/viewportStage'

// = PHRASE_BUBBLE_DURATION_MS / PHRASE_BUBBLE_TOTAL_MS в Белот.
export const LUDO_PHRASE_BUBBLE_TOTAL_MS = 4500

const OVERLAY_HOST_ATTR = 'data-ludo-phrase-overlay-host'
const BUBBLE_ATTR = 'data-ludo-phrase-bubble'
const EDGE_MARGIN = 5

// Fade кривата на Белот (180ms in / 420ms out от 4500ms).
const FADE_IN_END_PCT = Math.round((180 / LUDO_PHRASE_BUBBLE_TOTAL_MS) * 100)
const FADE_OUT_START_PCT = Math.round(((LUDO_PHRASE_BUBBLE_TOTAL_MS - 420) / LUDO_PHRASE_BUBBLE_TOTAL_MS) * 100)
const KEYFRAMES = `@keyframes ludo-phrase-bubble-fade{0%{opacity:0;transform:translateY(4px) scale(0.98)}${FADE_IN_END_PCT}%{opacity:1;transform:translateY(0) scale(1)}${FADE_OUT_START_PCT}%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-3px) scale(0.98)}}`

export type LudoPhraseBubble = {
  color: LudoColor
  text: string
  startedAt: number
}

type BubbleDirection = 'up' | 'down' | 'left' | 'right'

// Същият scale, с който Белот рисува балончето на този viewport: phone —
// stage metrics на playing екрана (с резервирана долна навигация), desktop —
// stage scale-ът на активната маса.
function getBelotPhraseBubbleScale(isPhoneLayout: boolean): number {
  if (!isPhoneLayout) return getActiveRoomStageMetrics().stageScale
  return getViewportStageMetrics({
    baseWidth: ACTIVE_ROOM_STAGE_WIDTH,
    baseHeight: ACTIVE_ROOM_STAGE_HEIGHT,
    minScale: ACTIVE_ROOM_MIN_STAGE_SCALE,
    maxScale: ACTIVE_ROOM_MAX_STAGE_SCALE,
    viewportHorizontalPadding: ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
    viewportVerticalPadding: ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
    reservedTopSpace: ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT,
  }).stageScale
}

function createBubbleHtml(bubble: LudoPhraseBubble, key: string, isPhoneLayout: boolean, scale: number): string {
  const minWidth = Math.round(138 * scale)
  const maxWidth = Math.round(230 * scale)
  const paddingV = Math.round(12 * scale)
  const paddingH = Math.round(16 * scale)
  const fontSize = Math.round((isPhoneLayout ? 20 : 18) * scale)
  const borderRadius = Math.round(14 * scale)
  const borderWidth = Math.max(1, Math.round(2 * scale))
  const elapsed = Math.min(Math.max(0, Date.now() - bubble.startedAt), LUDO_PHRASE_BUBBLE_TOTAL_MS)
  const animation = isPhoneLayout
    ? ''
    : `animation:ludo-phrase-bubble-fade ${LUDO_PHRASE_BUBBLE_TOTAL_MS}ms linear both;animation-delay:${-elapsed / 1000}s;`

  return `
    <div
      ${BUBBLE_ATTR}="${bubble.color}"
      data-ludo-phrase-bubble-key="${escapeHtml(key)}"
      data-ludo-phrase-bubble-max-width="${maxWidth}"
      style="
        position:fixed;
        left:0;
        top:0;
        max-width:${maxWidth}px;
        min-width:${minWidth}px;
        box-sizing:border-box;
        padding:${paddingV}px ${paddingH}px;
        border-radius:${borderRadius}px;
        border:${borderWidth}px solid #111111;
        background:#ffffff;
        box-shadow:0 8px 20px rgba(0,0,0,0.24);
        color:#111111;
        font-size:${fontSize}px;
        line-height:1.18;
        font-weight:900;
        text-align:center;
        visibility:hidden;
        pointer-events:none;
        ${animation}
      "
    >${escapeHtml(bubble.text)}</div>
  `
}

function ensureOverlayHost(): HTMLDivElement {
  let host = document.body.querySelector<HTMLDivElement>(`[${OVERLAY_HOST_ATTR}]`)
  if (!host) {
    host = document.createElement('div')
    host.setAttribute(OVERLAY_HOST_ATTR, '1')
    host.style.position = 'fixed'
    host.style.inset = '0'
    host.style.zIndex = String(LUDO_PHRASE_REACTION_Z_INDEX)
    host.style.pointerEvents = 'none'
    host.innerHTML = `<style>${KEYFRAMES}</style>`
    document.body.appendChild(host)
  }
  return host
}

export function removeLudoPhraseBubbleOverlay(): void {
  document.body.querySelector(`[${OVERLAY_HOST_ATTR}]`)?.remove()
}

export function syncLudoPhraseBubbleOverlay(bubbles: readonly LudoPhraseBubble[]): void {
  if (bubbles.length === 0) {
    removeLudoPhraseBubbleOverlay()
    return
  }

  const isPhoneLayout = isPhoneLayoutViewport()
  const scale = getBelotPhraseBubbleScale(isPhoneLayout)
  const layoutKey = `${isPhoneLayout ? 'phone' : 'desktop'}:${scale.toFixed(3)}`
  const host = ensureOverlayHost()
  const activeColors = new Set<string>()

  for (const bubble of bubbles) {
    activeColors.add(bubble.color)
    const key = `${bubble.color}:${bubble.startedAt}:${layoutKey}`
    const existing = host.querySelector<HTMLElement>(`[${BUBBLE_ATTR}="${bubble.color}"]`)
    if (existing?.getAttribute('data-ludo-phrase-bubble-key') === key) continue
    existing?.remove()
    host.insertAdjacentHTML('beforeend', createBubbleHtml(bubble, key, isPhoneLayout, scale))
  }

  for (const element of Array.from(host.querySelectorAll<HTMLElement>(`[${BUBBLE_ATTR}]`))) {
    if (!activeColors.has(element.getAttribute(BUBBLE_ATTR) ?? '')) element.remove()
  }

  positionBubbles(host, isPhoneLayout)
}

function positionBubbles(host: HTMLElement, isPhoneLayout: boolean): void {
  const boardRect = document.querySelector<HTMLElement>('[data-ludo-board="1"]')?.getBoundingClientRect() ?? null

  for (const bubbleEl of Array.from(host.querySelectorAll<HTMLElement>(`[${BUBBLE_ATTR}]`))) {
    const color = bubbleEl.getAttribute(BUBBLE_ATTR)
    const panelEl = color ? document.querySelector<HTMLElement>(`[data-ludo-player-panel="${color}"]`) : null
    const panelRect = panelEl?.getBoundingClientRect() ?? null
    if (!panelEl || !panelRect || (panelRect.width === 0 && panelRect.height === 0)) {
      bubbleEl.style.visibility = 'hidden'
      continue
    }

    const direction = getBubbleDirection(panelRect, boardRect, isPhoneLayout)
    // Ако в момента има и emoji балонче за същия играч, фразата се нарежда
    // след него в същата посока (както Белот подрежда phrase след emoji).
    const emojiRect = panelEl.parentElement?.querySelector<HTMLElement>('[data-ludo-emoji-reaction]')?.getBoundingClientRect() ?? null
    positionBubbleAgainstAnchor(bubbleEl, panelRect, emojiRect, direction)
    bubbleEl.style.visibility = 'visible'
  }
}

// Винаги навътре към дъската — desktop картите са в колони отляво/отдясно на
// дъската, phone картите са в редове над/под нея.
function getBubbleDirection(panelRect: DOMRect, boardRect: DOMRect | null, isPhoneLayout: boolean): BubbleDirection {
  const panelCenterX = panelRect.left + panelRect.width / 2
  const panelCenterY = panelRect.top + panelRect.height / 2
  const centerX = boardRect ? boardRect.left + boardRect.width / 2 : window.innerWidth / 2
  const centerY = boardRect ? boardRect.top + boardRect.height / 2 : window.innerHeight / 2
  if (isPhoneLayout) return panelCenterY < centerY ? 'down' : 'up'
  return panelCenterX < centerX ? 'right' : 'left'
}

// Същите правила като Белот-ския positionBubbleAgainstProfile: 5px отстъп,
// центриране спрямо картата, clamp в viewport-а; при недостатъчно място
// встрани се намалява max-width (text wrap), балончето не се връща върху
// картата.
function positionBubbleAgainstAnchor(
  bubbleEl: HTMLElement,
  panelRect: DOMRect,
  emojiRect: DOMRect | null,
  direction: BubbleDirection,
): void {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  bubbleEl.style.maxWidth = `${bubbleEl.getAttribute('data-ludo-phrase-bubble-max-width') ?? '230'}px`

  if (direction === 'right' || direction === 'left') {
    const left = direction === 'right'
      ? Math.max(panelRect.right, emojiRect?.right ?? panelRect.right) + EDGE_MARGIN
      : 0
    const anchorLeft = Math.min(panelRect.left, emojiRect?.left ?? panelRect.left) - EDGE_MARGIN
    const availableWidth = direction === 'right'
      ? Math.max(60, viewportWidth - EDGE_MARGIN - left)
      : Math.max(60, anchorLeft - EDGE_MARGIN)
    if (availableWidth < bubbleEl.offsetWidth) {
      bubbleEl.style.maxWidth = `${availableWidth}px`
    }

    const width = bubbleEl.offsetWidth
    const height = bubbleEl.offsetHeight
    const panelCenterY = panelRect.top + panelRect.height / 2
    const top = Math.max(EDGE_MARGIN, Math.min(panelCenterY - height / 2, viewportHeight - EDGE_MARGIN - height))
    bubbleEl.style.left = `${direction === 'right' ? left : Math.max(EDGE_MARGIN, anchorLeft - width)}px`
    bubbleEl.style.top = `${top}px`
    return
  }

  const width = bubbleEl.offsetWidth
  const height = bubbleEl.offsetHeight
  const panelCenterX = panelRect.left + panelRect.width / 2
  const left = Math.max(EDGE_MARGIN, Math.min(panelCenterX - width / 2, viewportWidth - EDGE_MARGIN - width))
  const top = direction === 'up'
    ? Math.max(EDGE_MARGIN, Math.min(panelRect.top, emojiRect?.top ?? panelRect.top) - EDGE_MARGIN - height)
    : Math.min(
        viewportHeight - EDGE_MARGIN - height,
        Math.max(panelRect.bottom, emojiRect?.bottom ?? panelRect.bottom) + EDGE_MARGIN,
      )

  bubbleEl.style.left = `${left}px`
  bubbleEl.style.top = `${top}px`
}
