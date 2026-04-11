import type { Seat } from '../../data/constants/seatOrder'
import { createGameAudioController } from '../audio/createGameAudioController'

export type TrickCollectionCard = {
  element: HTMLElement
  seat?: Seat
}

export type AnimateTrickCollectionOptions = {
  cards: TrickCollectionCard[]
  winnerSeat: Seat
  targetElement?: HTMLElement | null
  resolveTargetElement?: (winnerSeat: Seat) => HTMLElement | null
  hideOriginalCards?: boolean
  gatherDurationMs?: number
  flyDurationMs?: number
  gatherSpreadPx?: number
  stackSpreadPx?: number
  overlayZIndex?: number
}

type Point = {
  x: number
  y: number
}

type MeasuredCard = {
  element: HTMLElement
  rect: DOMRect
}

type FloatingCard = {
  sourceElement: HTMLElement
  node: HTMLElement
}

const gameAudio = createGameAudioController()

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function finishAnimation(animation: Animation): Promise<void> {
  return new Promise((resolve) => {
    animation.onfinish = () => resolve()
    animation.oncancel = () => resolve()
  })
}

function getRectCenter(rect: DOMRect): Point {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  }
}

function getAverageCenter(rects: DOMRect[]): Point {
  if (rects.length === 0) {
    return { x: 0, y: 0 }
  }

  const total = rects.reduce(
    (accumulator, rect) => {
      const center = getRectCenter(rect)

      return {
        x: accumulator.x + center.x,
        y: accumulator.y + center.y,
      }
    },
    { x: 0, y: 0 },
  )

  return {
    x: total.x / rects.length,
    y: total.y / rects.length,
  }
}

function resolveOverlayHost(): HTMLElement {
  const appRoot = document.querySelector('#app')

  if (appRoot instanceof HTMLElement) {
    return appRoot
  }

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
  measuredCard: MeasuredCard,
  overlay: HTMLElement,
  zIndex: number,
): FloatingCard {
  const clone = measuredCard.element.cloneNode(true) as HTMLElement

  clone.style.position = 'fixed'
  clone.style.left = `${measuredCard.rect.left}px`
  clone.style.top = `${measuredCard.rect.top}px`
  clone.style.width = `${measuredCard.rect.width}px`
  clone.style.height = `${measuredCard.rect.height}px`
  clone.style.margin = '0'
  clone.style.pointerEvents = 'none'
  clone.style.transform = 'none'
  clone.style.transformOrigin = 'center center'
  clone.style.willChange = 'transform, opacity'
  clone.style.zIndex = String(zIndex)

  overlay.appendChild(clone)

  return {
    sourceElement: measuredCard.element,
    node: clone,
  }
}

function measureCards(cards: TrickCollectionCard[]): MeasuredCard[] {
  return cards
    .map((card) => {
      const rect = card.element.getBoundingClientRect()

      return {
        element: card.element,
        rect,
      }
    })
    .filter((card) => card.rect.width > 0 && card.rect.height > 0)
}

function getGatherOffset(index: number, total: number, spreadPx: number): Point {
  const centeredIndex = index - (total - 1) / 2

  return {
    x: centeredIndex * spreadPx,
    y: index * 2,
  }
}

function getWinnerAnchor(targetRect: DOMRect, winnerSeat: Seat): Point {
  const center = getRectCenter(targetRect)

  if (winnerSeat === 'bottom') {
    return {
      x: center.x,
      y: targetRect.top + targetRect.height * 0.12,
    }
  }

  if (winnerSeat === 'top') {
    return {
      x: center.x,
      y: targetRect.bottom - targetRect.height * 0.12,
    }
  }

  if (winnerSeat === 'left') {
    return {
      x: targetRect.right - targetRect.width * 0.12,
      y: center.y,
    }
  }

  return {
    x: targetRect.left + targetRect.width * 0.12,
    y: center.y,
  }
}

function getWinnerStackOffset(
  winnerSeat: Seat,
  index: number,
  total: number,
  spreadPx: number,
): Point {
  const centeredIndex = index - (total - 1) / 2

  if (winnerSeat === 'bottom' || winnerSeat === 'top') {
    return {
      x: centeredIndex * spreadPx,
      y: Math.abs(centeredIndex) * 2,
    }
  }

  return {
    x: Math.abs(centeredIndex) * 2,
    y: centeredIndex * spreadPx,
  }
}

async function animateToGatherPoint(
  floatingCard: FloatingCard,
  destinationLeft: number,
  destinationTop: number,
  durationMs: number,
): Promise<void> {
  const rect = floatingCard.node.getBoundingClientRect()
  const deltaX = destinationLeft - rect.left
  const deltaY = destinationTop - rect.top

  const animation = floatingCard.node.animate(
    [
      {
        transform: 'translate(0px, 0px) scale(1)',
        opacity: 1,
      },
      {
        transform: `translate(${deltaX}px, ${deltaY}px) scale(1)`,
        opacity: 1,
      },
    ],
    {
      duration: durationMs,
      easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
      fill: 'forwards',
    },
  )

  await finishAnimation(animation)

  floatingCard.node.style.left = `${destinationLeft}px`
  floatingCard.node.style.top = `${destinationTop}px`
  floatingCard.node.style.transform = 'none'
}

async function animateToWinner(
  floatingCard: FloatingCard,
  destinationLeft: number,
  destinationTop: number,
  durationMs: number,
): Promise<void> {
  const rect = floatingCard.node.getBoundingClientRect()
  const deltaX = destinationLeft - rect.left
  const deltaY = destinationTop - rect.top

  const animation = floatingCard.node.animate(
    [
      {
        transform: 'translate(0px, 0px) scale(1)',
        opacity: 1,
        offset: 0,
      },
      {
        transform: `translate(${deltaX}px, ${deltaY}px) scale(0.76)`,
        opacity: 1,
        offset: 0.82,
      },
      {
        transform: `translate(${deltaX}px, ${deltaY}px) scale(0.56)`,
        opacity: 0,
        offset: 1,
      },
    ],
    {
      duration: durationMs,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      fill: 'forwards',
    },
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
    overlayZIndex = 0,
  } = options

  const measuredCards = measureCards(options.cards)

  if (measuredCards.length === 0) {
    return
  }

  const targetElement =
    options.targetElement ??
    options.resolveTargetElement?.(winnerSeat) ??
    null

  if (!targetElement) {
    return
  }

  const targetRect = targetElement.getBoundingClientRect()

  if (targetRect.width === 0 || targetRect.height === 0) {
    return
  }

  const overlayHost = resolveOverlayHost()
  const overlay = createOverlay(overlayHost, overlayZIndex)

  const floatingCards = measuredCards.map((measuredCard, index) =>
    createFloatingCard(measuredCard, overlay, overlayZIndex + index + 1),
  )

  if (hideOriginalCards) {
    floatingCards.forEach((floatingCard) => {
      floatingCard.sourceElement.style.visibility = 'hidden'
    })
  }

  try {
    await waitForNextFrame()
    gameAudio.playCardMove()

    const trickCenter = getAverageCenter(measuredCards.map((card) => card.rect))

    await Promise.all(
      floatingCards.map((floatingCard, index) => {
        const rect = floatingCard.node.getBoundingClientRect()
        const offset = getGatherOffset(index, floatingCards.length, gatherSpreadPx)

        const destinationLeft = trickCenter.x + offset.x - rect.width / 2
        const destinationTop = trickCenter.y + offset.y - rect.height / 2

        return animateToGatherPoint(
          floatingCard,
          destinationLeft,
          destinationTop,
          gatherDurationMs,
        )
      }),
    )

    const winnerAnchor = getWinnerAnchor(targetRect, winnerSeat)

    await Promise.all(
      floatingCards.map(async (floatingCard, index) => {
        if (index > 0) {
          await wait(index * 35)
        }

        const rect = floatingCard.node.getBoundingClientRect()
        const offset = getWinnerStackOffset(
          winnerSeat,
          index,
          floatingCards.length,
          stackSpreadPx,
        )

        const destinationLeft = winnerAnchor.x + offset.x - rect.width / 2
        const destinationTop = winnerAnchor.y + offset.y - rect.height / 2

        await animateToWinner(
          floatingCard,
          destinationLeft,
          destinationTop,
          flyDurationMs,
        )
      }),
    )
  } finally {
    overlay.remove()
  }
}
