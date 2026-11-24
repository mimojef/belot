// Свара — профилните карета на играчите: СЪЩИЯТ компонент като в Белот.
//
// Карето се рисува директно от createCuttingSeatPanelHtml()
// (activeRoom/cutting/renderCuttingSeatPanels.ts) — рамки, цветове, аватар,
// поле с името, шрифтове, таймер в полето с името (CSS анимацията
// belot-active-room-cutting-countdown) и златната рамка на активния играч
// (highlightSeat, както при обявяването в Белот). Тук само:
//   • се подават данните на мястото в Свара (без подаръци, ниво и гласов чат);
//   • котвата на Белот (fixed позиция до ръба на екрана) се замества с
//     центриране в мястото на сцената; мащабът е същият като в Белот —
//     stageScale на сцена 1600×900, сметнат за сукното на Свара.
// Дизайнът на Белот не се променя.

import type { RoomSeatSnapshot, Seat } from '../../../network/createGameServerClient'
import { createCuttingSeatPanelHtml } from '../../../activeRoom/cutting/renderCuttingSeatPanels'
import {
  ACTIVE_ROOM_MAX_STAGE_SCALE,
  ACTIVE_ROOM_MIN_STAGE_SCALE,
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
} from '../../../activeRoom/activeRoomShared'

/** Каретата в createCuttingSeatPanelHtml: вертикално (горе/ляво/дясно) и хоризонтално (долу) + вътрешният им scale. */
const BELOT_SIDE_CARD = { w: 186, h: 234, innerScale: 0.9 }
const BELOT_BOTTOM_CARD = { w: 360, h: 138, innerScale: 0.8 }
/**
 * Значката за дилър: стилът на renderCuttingDealerBadge (Белот: 28px, шрифт 14px),
 * в Свара по-голяма, за да се разпознава лесно; излиза малко извън карето.
 */
const DEALER_BADGE_SIZE = 42
const DEALER_BADGE_FONT = 22
const DEALER_BADGE_OVERHANG = 14
/** Отстъп на каретата от ръба (getCuttingSeatPanelAnchorStyle: 5px). */
export const SVARA_BELOT_CARD_EDGE_MARGIN_PX = 5

/**
 * Мащабът на каретата — формулата на Белот за stageScale (сцена 1600×900,
 * clamp 0.46..1.06), сметната за видимия размер на сукното в Свара. Връща
 * мащаба в CSS пиксели на сцената (zoom = мащабът на страницата).
 */
export function svaraBelotCardScale(feltWidth: number, feltHeight: number, zoom: number): number {
  const z = zoom > 0 ? zoom : 1
  const visual = Math.min(feltWidth * z / ACTIVE_ROOM_STAGE_WIDTH, feltHeight * z / ACTIVE_ROOM_STAGE_HEIGHT, ACTIVE_ROOM_MAX_STAGE_SCALE)
  return Math.min(ACTIVE_ROOM_MAX_STAGE_SCALE, Math.max(ACTIVE_ROOM_MIN_STAGE_SCALE, visual)) / z
}

/** Видимият размер на карето (CSS px на сцената). */
export function svaraBelotCardSize(slot: Seat, scale: number): { w: number; h: number } {
  const card = slot === 'bottom' ? BELOT_BOTTOM_CARD : BELOT_SIDE_CARD
  return { w: card.w * card.innerScale * scale, h: card.h * card.innerScale * scale }
}

const esc = (value: string) => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)

/** Същите keyframes като в createCuttingSeatPanelsHtml (там са в общия <style> на Белот). */
const COUNTDOWN_KEYFRAMES = '<style data-svara-belot-card-style="1">@keyframes belot-active-room-cutting-countdown { 0% { transform:scaleX(1); } 100% { transform:scaleX(0); } }</style>'

export type SvaraBelotSeatCardInput = {
  slot: Seat
  name: string
  avatarSrc: string
  isBot: boolean
  isLocal: boolean
  isDealer: boolean
  /** Таймерът за хода (само при активния играч); key — сменя се с всеки нов ход. */
  turn: { remainingMs: number; totalMs: number; key: string } | null
  /** Мащаб в CSS px на сцената (svaraBelotCardScale). */
  scale: number
}

export function renderSvaraBelotSeatCardHtml(input: SvaraBelotSeatCardInput): string {
  const seat: RoomSeatSnapshot = {
    seat: input.slot,
    // Без profileId: каретата в Свара нямат подаръци и гласов индикатор.
    profileId: null,
    displayName: input.name,
    isOccupied: true,
    isBot: input.isBot,
    isControlledByBot: false,
    isConnected: true,
    avatarUrl: input.avatarSrc || null,
    level: null,
    rankTitle: null,
    skillRating: null,
    gender: null,
  }
  const html = createCuttingSeatPanelHtml(
    seat,
    input.slot,
    input.isDealer ? input.slot : null,
    input.turn ? input.slot : null,
    input.turn ? input.turn.remainingMs : null,
    input.turn?.totalMs ?? 1,
    // Активният играч: златната рамка и сиянието на Белот (highlightSeat).
    input.turn ? input.slot : null,
    null,
    input.scale,
    esc,
    null,
    null,
    null,
    input.turn ? `svara-turn:${input.turn.key}` : 'svara-idle',
    null,
    null,
    null,
    true,
    // Собственото (долно) място: етикетът „ТИ“ над името, както в Белот.
    input.isLocal ? input.slot : undefined,
  )
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  const anchor = template.content.querySelector<HTMLElement>('[data-active-room-seat-anchor]')
  if (!anchor) return ''
  // Котвата на Белот е до ръба на екрана — тук е в мястото на сцената. Карето
  // пази вътрешния scale и transform-origin от Белот (значката за дилър стои
  // спрямо него точно както в Белот); котвата се отмества така, че видимото
  // каре да е центрирано в мястото.
  const size = input.slot === 'bottom' ? BELOT_BOTTOM_CARD : BELOT_SIDE_CARD
  const shrinkX = (size.w * (1 - size.innerScale)) / 2
  const shrinkY = (size.h * (1 - size.innerScale)) / 2
  const offset = input.slot === 'bottom' ? { x: 0, y: shrinkY } : input.slot === 'top' ? { x: 0, y: -shrinkY } : input.slot === 'left' ? { x: -shrinkX, y: 0 } : { x: shrinkX, y: 0 }
  const left = `calc(50% - ${(offset.x * input.scale).toFixed(2)}px)`
  const top = `calc(50% - ${(offset.y * input.scale).toFixed(2)}px)`
  anchor.style.cssText = `position:absolute;left:${left};top:${top};transform:translate(-50%,-50%) scale(${input.scale});transform-origin:center center;z-index:4;pointer-events:none;`
  // Индикаторът за дилър (renderCuttingDealerBadge — „D“ на Белот). Долу е на
  // мястото си от Белот; горе/отстрани под карето са картите на мястото в
  // Свара, затова там е на горния външен ъгъл на карето.
  if (input.isDealer) {
    for (const child of anchor.children) {
      if (!(child instanceof HTMLElement) || child.textContent?.trim() !== 'D') continue
      child.dataset.svaraDealerBadge = '1'
      child.title = 'Дилър'
      Object.assign(child.style, { width: `${DEALER_BADGE_SIZE}px`, height: `${DEALER_BADGE_SIZE}px`, fontSize: `${DEALER_BADGE_FONT}px`, border: '2px solid #13253d', boxSizing: 'border-box' })
      if (input.slot === 'bottom') { child.style.right = `${-DEALER_BADGE_OVERHANG}px`; continue }
      const k = size.innerScale
      const card = input.slot === 'top'
        ? { l: (size.w * (1 - k)) / 2, r: (size.w * (1 + k)) / 2, t: 0 }
        : input.slot === 'left'
          ? { l: 0, r: size.w * k, t: (size.h * (1 - k)) / 2 }
          : { l: size.w * (1 - k), r: size.w, t: (size.h * (1 - k)) / 2 }
      // Отстрани: горният ВЪНШЕН ъгъл (навътре е ветрилото), изравнен с ръба на карето;
      // горе: горният ляв ъгъл (купчинката е вдясно, ветрилото — отдолу).
      const badgeLeft = input.slot === 'left' ? card.l : input.slot === 'right' ? card.r - DEALER_BADGE_SIZE : card.l - DEALER_BADGE_OVERHANG
      const badgeTop = input.slot === 'top' ? card.t : card.t - DEALER_BADGE_OVERHANG
      Object.assign(child.style, { left: `${badgeLeft}px`, top: `${badgeTop}px`, right: 'auto', bottom: 'auto' })
    }
  }
  // Ботовете нямат профил — без показалец „ръка“ над аватара.
  const avatarButton = anchor.querySelector<HTMLElement>('[data-profile-seat-btn]')
  if (avatarButton && input.isBot) avatarButton.style.cursor = 'default'
  // Атрибутите, по които търси логиката на Белот (профил, подаръци, таймер),
  // се преименуват — карето в Свара не бива да задейства нищо от Белот.
  // Стиловете са inline, така че изгледът не се променя.
  for (const el of [anchor, ...anchor.querySelectorAll<HTMLElement>('*')]) {
    for (const attr of [...el.attributes]) {
      if (!attr.name.startsWith('data-') || attr.name.startsWith('data-svara-')) continue
      el.removeAttribute(attr.name)
      el.setAttribute(attr.name.replace('data-', 'data-svara-belot-'), attr.value)
    }
  }
  return `${COUNTDOWN_KEYFRAMES}${anchor.outerHTML}`
}
