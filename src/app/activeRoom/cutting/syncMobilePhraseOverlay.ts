import type { RoomSeatSnapshot, Seat } from '../../network/createGameServerClient'
import { escapeHtml } from '../activeRoomShared'
import { isPhoneLayoutViewport } from '../../../ui/layout/viewportStage'
import { createMobilePhraseOverlayHtml, type SeatPhraseBubble } from './renderCuttingSeatPanels'

const OVERLAY_HOST_ATTR = 'data-mobile-phrase-overlay-host'
const EDGE_MARGIN = 5

// Единствената positioning логика за mobile preset phrase bubbles,
// споделена между createActiveRoomFlowController.ts (cutting/dealing/
// bidding) и renderPlayingScreen.ts (playing) — няма phase-specific
// offset-и. Позицията се изчислява ИЗЦЯЛО от реалния DOM rect на
// [data-seat-profile-card], измерен след DOM insert — не зависи от
// panelScale/anchor local coordinates. Overlay host-ът е direct child на
// document.body, position:fixed без transform — истински viewport-level
// containing block за деца си.
export function syncMobilePhraseOverlay(options: {
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  phraseBubbles: Partial<Record<Seat, SeatPhraseBubble>> | null | undefined
  panelScale: number
}): void {
  if (!isPhoneLayoutViewport()) {
    removeMobilePhraseOverlay()
    return
  }

  const { seats, localSeat, phraseBubbles, panelScale } = options
  const html = createMobilePhraseOverlayHtml(seats, localSeat, phraseBubbles, panelScale, escapeHtml)

  if (html === '') {
    removeMobilePhraseOverlay()
    return
  }

  const host = ensureOverlayHost()
  host.innerHTML = html
  positionMobilePhraseBubbles()
}

// z-index трябва да съвпада с mobile bubble layer-а (bid/declaration/
// emoji, виж MOBILE_BUBBLE_LAYER_Z_INDEX в renderPlayingScreen.ts —
// hand(1) < seatPanels(2) < trick(3) < bubbles(4)), за да е над hand
// cards/profile panels/trick cards, на same ниво като останалите bubbles.
// Explicit число тук (не import от renderPlayingScreen.ts), защото този
// host е споделен и с createActiveRoomFlowController.ts
// (cutting/dealing/bidding), не само playing.
const OVERLAY_Z_INDEX = 4

function ensureOverlayHost(): HTMLDivElement {
  let host = document.body.querySelector<HTMLDivElement>(`[${OVERLAY_HOST_ATTR}]`)
  if (!host) {
    host = document.createElement('div')
    host.setAttribute(OVERLAY_HOST_ATTR, '1')
    host.style.position = 'fixed'
    host.style.inset = '0'
    host.style.zIndex = String(OVERLAY_Z_INDEX)
    host.style.pointerEvents = 'none'
    document.body.appendChild(host)
  }
  return host
}

export function removeMobilePhraseOverlay(): void {
  document.body.querySelector(`[${OVERLAY_HOST_ATTR}]`)?.remove()
}

// Извиква се directно от addPhraseBubble's expiry timeout (виж
// createActiveRoomFlowController.ts) — единственият phrase lifecycle,
// без нов независим timeout. Маха само конкретния seat-ов bubble от DOM
// (immediate cleanup при expiry), без да чака следващ re-render.
export function removeMobilePhraseBubbleFromOverlay(seat: Seat): void {
  document.querySelector(`[data-mobile-phrase-bubble="${seat}"]`)?.remove()
}

function positionMobilePhraseBubbles(): void {
  const bubbles = Array.from(
    document.querySelectorAll<HTMLElement>('[data-mobile-phrase-bubble]'),
  )

  for (const bubbleEl of bubbles) {
    const seat = bubbleEl.getAttribute('data-mobile-phrase-bubble')
    const visualSeat = bubbleEl.getAttribute('data-mobile-phrase-seat-visual')
    if (!seat || !visualSeat) continue

    const profileEl = document.querySelector<HTMLElement>(`[data-seat-profile-card="${seat}"]`)
    if (!profileEl) continue

    const profileRect = profileEl.getBoundingClientRect()
    if (profileRect.width === 0 && profileRect.height === 0) continue

    positionBubbleAgainstProfile(bubbleEl, profileRect, visualSeat)
    bubbleEl.style.visibility = 'visible'
  }
}

function positionBubbleAgainstProfile(
  bubbleEl: HTMLElement,
  profileRect: DOMRect,
  visualSeat: string,
): void {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  if (visualSeat === 'bottom' || visualSeat === 'top') {
    // 5px вдясно от profile, vertically centered спрямо profile. Left
    // позицията е ВИНАГИ фиксирана на profile.right+5px (никога не се
    // мести назад към/под profile-а) — ако няма достатъчно място вдясно,
    // намаляваме max-width (text wrap), не преместваме bubble-а обратно.
    const left = profileRect.right + EDGE_MARGIN
    const availableWidth = Math.max(60, viewportWidth - EDGE_MARGIN - left)
    const bubbleRect = bubbleEl.getBoundingClientRect()
    if (availableWidth < bubbleRect.width) {
      bubbleEl.style.maxWidth = `${availableWidth}px`
    }

    const profileCenterY = profileRect.top + profileRect.height / 2
    const finalBubbleRect = bubbleEl.getBoundingClientRect()
    let top = profileCenterY - finalBubbleRect.height / 2
    top = Math.max(EDGE_MARGIN, Math.min(top, viewportHeight - EDGE_MARGIN - finalBubbleRect.height))

    bubbleEl.style.left = `${left}px`
    bubbleEl.style.top = `${top}px`
    return
  }

  // left/right: 5px над profile, horizontally centered спрямо profile.
  const profileCenterX = profileRect.left + profileRect.width / 2
  const bubbleRect = bubbleEl.getBoundingClientRect()
  let left = profileCenterX - bubbleRect.width / 2
  left = Math.max(EDGE_MARGIN, Math.min(left, viewportWidth - EDGE_MARGIN - bubbleRect.width))

  let top = profileRect.top - EDGE_MARGIN - bubbleRect.height
  top = Math.max(EDGE_MARGIN, top)

  bubbleEl.style.left = `${left}px`
  bubbleEl.style.top = `${top}px`
}
