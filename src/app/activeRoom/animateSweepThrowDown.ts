import type { Seat } from '../network/createGameServerClient'
import { getCardFaceImagePath } from './cardImageAssets'

export type SweepThrowDownCardLike = {
  id: string
  suit: 'clubs' | 'diamonds' | 'hearts' | 'spades'
  rank: '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
}

export type AnimateSweepThrowDownOptions = {
  // winner seat first, then the rest, from RoomSweepResolutionSnapshot
  throwOrder: Seat[]
  handsAtResolution: Record<Seat, SweepThrowDownCardLike[]>
  getSeatHandAnchorElement: (seat: Seat) => HTMLElement | null
  getTableCenterElement: () => HTMLElement | null
  onCaptionShow: () => void
  onCaptionHide: () => void
  onSeatThrown: (seat: Seat) => void
  onComplete: () => void
}

// Timing budget intentionally mirrors
// SERVER_TIMING_CONFIG.sweepResolutionAutoAdvanceMs (server/src/game/
// serverTimingConfig.ts) so the server doesn't auto-advance to scoring while
// this animation is still visibly running, and so the client doesn't finish
// noticeably before/after the server transition. The feature's whole point
// is to SPEED UP the end of a deal, so these stay snappy on purpose.
const CARD_WIDTH_PX = 64
const CARD_HEIGHT_PX = 90
const SEAT_FLY_DURATION_MS = 320
const SEAT_READ_PAUSE_MS = 230 // per-seat visible beat after landing, before the next seat throws
const CAPTION_VISIBLE_MS = 700
const FINAL_PAUSE_MS = 500
const CARD_INNER_STAGGER_MS = 35
const FAN_SPREAD_PX = 26
const OVERLAY_Z_INDEX = 9500

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function finishAnimation(animation: Animation): Promise<void> {
  return new Promise((resolve) => {
    animation.onfinish = () => resolve()
    animation.oncancel = () => resolve()
  })
}

type Point = { x: number; y: number }

function getRectCenter(rect: DOMRect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function createOverlay(): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.setAttribute('data-sweep-throw-down-overlay', '1')
  overlay.style.position = 'fixed'
  overlay.style.inset = '0'
  overlay.style.pointerEvents = 'none'
  overlay.style.zIndex = String(OVERLAY_Z_INDEX)
  overlay.style.overflow = 'visible'
  document.body.appendChild(overlay)
  return overlay
}

function createFaceUpCardElement(card: SweepThrowDownCardLike, sourceCenter: Point): HTMLElement {
  const el = document.createElement('img')
  el.src = getCardFaceImagePath(card)
  el.alt = ''
  el.style.position = 'fixed'
  el.style.left = `${sourceCenter.x - CARD_WIDTH_PX / 2}px`
  el.style.top = `${sourceCenter.y - CARD_HEIGHT_PX / 2}px`
  el.style.width = `${CARD_WIDTH_PX}px`
  el.style.height = `${CARD_HEIGHT_PX}px`
  el.style.objectFit = 'cover'
  el.style.borderRadius = '6px'
  el.style.boxShadow = '0 6px 16px rgba(0,0,0,0.45)'
  el.style.margin = '0'
  el.style.pointerEvents = 'none'
  el.style.willChange = 'transform, opacity'
  el.style.opacity = '0'
  return el
}

function getFanOffset(index: number, total: number): Point {
  const centeredIndex = index - (total - 1) / 2
  return { x: centeredIndex * FAN_SPREAD_PX, y: Math.abs(centeredIndex) * 4 }
}

async function throwSeatCards(options: {
  overlay: HTMLElement
  seat: Seat
  cards: SweepThrowDownCardLike[]
  sourceCenter: Point
  destCenter: Point
}): Promise<void> {
  const { overlay, cards, sourceCenter, destCenter } = options

  if (cards.length === 0) {
    return
  }

  const elements = cards.map((card) => {
    const el = createFaceUpCardElement(card, sourceCenter)
    overlay.appendChild(el)
    return el
  })

  await waitForNextFrame()

  await Promise.all(
    elements.map(async (el, index) => {
      if (index > 0) {
        await wait(index * CARD_INNER_STAGGER_MS)
      }

      const offset = getFanOffset(index, elements.length)
      const destLeft = destCenter.x + offset.x - CARD_WIDTH_PX / 2
      const destTop = destCenter.y + offset.y - CARD_HEIGHT_PX / 2
      const dx = destLeft - (sourceCenter.x - CARD_WIDTH_PX / 2)
      const dy = destTop - (sourceCenter.y - CARD_HEIGHT_PX / 2)

      const animation = el.animate(
        [
          { transform: 'translate(0px,0px) scale(0.7)', opacity: 0, offset: 0 },
          { transform: `translate(${dx * 0.15}px,${dy * 0.15}px) scale(0.85)`, opacity: 1, offset: 0.12 },
          { transform: `translate(${dx}px,${dy}px) scale(1)`, opacity: 1, offset: 1 },
        ],
        { duration: SEAT_FLY_DURATION_MS, easing: 'cubic-bezier(0.22,0.61,0.36,1)', fill: 'forwards' },
      )
      await finishAnimation(animation)
      el.style.left = `${destLeft}px`
      el.style.top = `${destTop}px`
      el.style.transform = 'none'
      el.style.opacity = '1'
    }),
  )
}

// "Долу картите" throw-down reveal: each seat's remaining hand (claimant
// first, per throwOrder) flies face-up from that seat's own table position
// to the center, lands splayed/legible, with a short per-seat visible pause
// before the next seat throws — the inverse-of-the-inverse of
// animateTrickCollection.ts (which gathers already-played table cards
// toward a winner's seat); here whole remaining HANDS fly outward from each
// seat toward the center instead.
export async function animateSweepThrowDown(options: AnimateSweepThrowDownOptions): Promise<void> {
  const {
    throwOrder,
    handsAtResolution,
    getSeatHandAnchorElement,
    getTableCenterElement,
    onCaptionShow,
    onCaptionHide,
    onSeatThrown,
    onComplete,
  } = options

  const tableCenterElement = getTableCenterElement()
  const destCenter = tableCenterElement
    ? getRectCenter(tableCenterElement.getBoundingClientRect())
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 }

  const overlay = createOverlay()

  try {
    for (let i = 0; i < throwOrder.length; i += 1) {
      const seat = throwOrder[i]!
      const cards = handsAtResolution[seat] ?? []
      const anchorElement = getSeatHandAnchorElement(seat)
      const sourceCenter = anchorElement
        ? getRectCenter(anchorElement.getBoundingClientRect())
        : destCenter

      await throwSeatCards({ overlay, seat, cards, sourceCenter, destCenter })

      if (i === 0) {
        // Claimant's cards just landed — short "Долу картите" caption +
        // sound, per spec ("кратък надпис", "да се скрие бързо").
        onCaptionShow()
        window.setTimeout(() => onCaptionHide(), CAPTION_VISIBLE_MS)
      }

      onSeatThrown(seat)

      if (i < throwOrder.length - 1) {
        await wait(SEAT_READ_PAUSE_MS)
      }
    }

    await wait(FINAL_PAUSE_MS)
  } finally {
    overlay.remove()
    onComplete()
  }
}
