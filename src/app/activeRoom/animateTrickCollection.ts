import type { Seat } from '../network/createGameServerClient'

export type TrickCollectionCard = {
  element: HTMLElement
  seat?: Seat
}

export type AnimateTrickCollectionOptions = {
  cards: TrickCollectionCard[]
  winnerSeat: Seat
  targetElement?: HTMLElement | null
  hideOriginalCards?: boolean
  gatherDurationMs?: number
  flyDurationMs?: number
  gatherSpreadPx?: number
  stackSpreadPx?: number
  overlayZIndex?: number
}

type Point = { x: number; y: number }
type MeasuredCard = { element: HTMLElement; rect: DOMRect }
type FloatingCard = { sourceElement: HTMLElement; node: HTMLElement }

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function finishAnimation(animation: Animation): Promise<void> {
  return new Promise((resolve) => {
    animation.onfinish = () => resolve()
    animation.oncancel = () => resolve()
  })
}

function getRectCenter(rect: DOMRect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function getAverageCenter(rects: DOMRect[]): Point {
  if (rects.length === 0) return { x: 0, y: 0 }
  const total = rects.reduce(
    (acc, rect) => {
      const c = getRectCenter(rect)
      return { x: acc.x + c.x, y: acc.y + c.y }
    },
    { x: 0, y: 0 },
  )
  return { x: total.x / rects.length, y: total.y / rects.length }
}

function resolveOverlayHost(): HTMLElement {
  return document.body
}

function createOverlay(host: HTMLElement, zIndex: number): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.style.position = 'fixed'
  overlay.style.inset = '0'
  overlay.style.pointerEvents = 'none'
  overlay.style.zIndex = String(zIndex)
  overlay.style.overflow = 'visible'
  host.appendChild(overlay)
  return overlay
}

function createFloatingCard(
  measured: MeasuredCard,
  overlay: HTMLElement,
  zIndex: number,
): FloatingCard {
  const clone = measured.element.cloneNode(true) as HTMLElement
  clone.style.position = 'fixed'
  clone.style.left = `${measured.rect.left}px`
  clone.style.top = `${measured.rect.top}px`
  clone.style.width = `${measured.rect.width}px`
  clone.style.height = `${measured.rect.height}px`
  clone.style.margin = '0'
  clone.style.pointerEvents = 'none'
  clone.style.transform = 'none'
  clone.style.transformOrigin = 'center center'
  clone.style.willChange = 'transform, opacity'
  clone.style.zIndex = String(zIndex)
  overlay.appendChild(clone)
  return { sourceElement: measured.element, node: clone }
}

function measureCards(cards: TrickCollectionCard[]): MeasuredCard[] {
  return cards
    .map((card) => ({ element: card.element, rect: card.element.getBoundingClientRect() }))
    .filter((c) => c.rect.width > 0 && c.rect.height > 0)
}

function getGatherOffset(index: number, total: number, spreadPx: number): Point {
  const centeredIndex = index - (total - 1) / 2
  return { x: centeredIndex * spreadPx, y: index * 2 }
}

function getWinnerAnchor(targetRect: DOMRect, winnerSeat: Seat): Point {
  const center = getRectCenter(targetRect)
  if (winnerSeat === 'bottom') return { x: center.x, y: targetRect.top + targetRect.height * 0.12 }
  if (winnerSeat === 'top') return { x: center.x, y: targetRect.bottom - targetRect.height * 0.12 }
  if (winnerSeat === 'left') return { x: targetRect.right - targetRect.width * 0.12, y: center.y }
  return { x: targetRect.left + targetRect.width * 0.12, y: center.y }
}

function getWinnerStackOffset(winnerSeat: Seat, index: number, total: number, spreadPx: number): Point {
  const ci = index - (total - 1) / 2
  if (winnerSeat === 'bottom' || winnerSeat === 'top') return { x: ci * spreadPx, y: Math.abs(ci) * 2 }
  return { x: Math.abs(ci) * 2, y: ci * spreadPx }
}

async function animateToGatherPoint(
  floatingCard: FloatingCard,
  destLeft: number,
  destTop: number,
  durationMs: number,
): Promise<void> {
  const rect = floatingCard.node.getBoundingClientRect()
  const animation = floatingCard.node.animate(
    [
      { transform: 'translate(0px,0px) scale(1)', opacity: 1 },
      { transform: `translate(${destLeft - rect.left}px,${destTop - rect.top}px) scale(1)`, opacity: 1 },
    ],
    { duration: durationMs, easing: 'cubic-bezier(0.22,0.61,0.36,1)', fill: 'forwards' },
  )
  await finishAnimation(animation)
  floatingCard.node.style.left = `${destLeft}px`
  floatingCard.node.style.top = `${destTop}px`
  floatingCard.node.style.transform = 'none'
}

async function animateToWinner(
  floatingCard: FloatingCard,
  destLeft: number,
  destTop: number,
  durationMs: number,
): Promise<void> {
  const rect = floatingCard.node.getBoundingClientRect()
  const dx = destLeft - rect.left
  const dy = destTop - rect.top
  const animation = floatingCard.node.animate(
    [
      { transform: 'translate(0px,0px) scale(1)', opacity: 1, offset: 0 },
      { transform: `translate(${dx}px,${dy}px) scale(0.76)`, opacity: 1, offset: 0.82 },
      { transform: `translate(${dx}px,${dy}px) scale(0.56)`, opacity: 0, offset: 1 },
    ],
    { duration: durationMs, easing: 'cubic-bezier(0.2,0.8,0.2,1)', fill: 'forwards' },
  )
  await finishAnimation(animation)
}

export async function animateTrickCollection(
  options: AnimateTrickCollectionOptions,
): Promise<void> {
  const {
    winnerSeat,
    hideOriginalCards = true,
    gatherDurationMs = 180,
    flyDurationMs = 420,
    gatherSpreadPx = 6,
    stackSpreadPx = 12,
    overlayZIndex = 9000,
  } = options

  const measuredCards = measureCards(options.cards)
  if (measuredCards.length === 0) return

  const targetElement = options.targetElement ?? null
  if (!targetElement) return

  const targetRect = targetElement.getBoundingClientRect()
  if (targetRect.width === 0 && targetRect.height === 0) return

  const overlayHost = resolveOverlayHost()
  const overlay = createOverlay(overlayHost, overlayZIndex)
  const floatingCards = measuredCards.map((mc, i) => createFloatingCard(mc, overlay, overlayZIndex + i + 1))

  if (hideOriginalCards) {
    floatingCards.forEach((fc) => { fc.sourceElement.style.visibility = 'hidden' })
  }

  try {
    await waitForNextFrame()

    const trickCenter = getAverageCenter(measuredCards.map((c) => c.rect))
    await Promise.all(
      floatingCards.map((fc, i) => {
        const rect = fc.node.getBoundingClientRect()
        const offset = getGatherOffset(i, floatingCards.length, gatherSpreadPx)
        return animateToGatherPoint(fc, trickCenter.x + offset.x - rect.width / 2, trickCenter.y + offset.y - rect.height / 2, gatherDurationMs)
      }),
    )

    const winnerAnchor = getWinnerAnchor(targetRect, winnerSeat)
    await Promise.all(
      floatingCards.map(async (fc, i) => {
        if (i > 0) await wait(i * 35)
        const rect = fc.node.getBoundingClientRect()
        const offset = getWinnerStackOffset(winnerSeat, i, floatingCards.length, stackSpreadPx)
        await animateToWinner(fc, winnerAnchor.x + offset.x - rect.width / 2, winnerAnchor.y + offset.y - rect.height / 2, flyDurationMs)
      }),
    )
  } finally {
    overlay.remove()
  }
}
