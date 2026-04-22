import type { Seat } from '../../data/constants/seatOrder'
import { animateTrickCollection } from './animateTrickCollection'

export type TrickCollectionSyncInput = {
  trickKey: string | null
  winnerSeat: Seat | null
  shouldAnimate: boolean
}

export type TrickCollectionController = {
  sync(input: TrickCollectionSyncInput): Promise<void>
  reset(): void
  isRunning(): boolean
  hasCompleted(trickKey: string | null): boolean
}

type CreateTrickCollectionControllerOptions = {
  resolvePlayedCardElements?: () => HTMLElement[]
  resolveWinnerTargetElement?: (winnerSeat: Seat) => HTMLElement | null
  minCardsToAnimate?: number
}

const DEFAULT_PLAYED_CARD_SELECTORS = [
  '[data-current-trick-card]',
  '[data-trick-card]',
  '[data-played-card]',
  '[data-current-trick] [data-card-id]',
  '[data-trick-area] [data-card-id]',
  '[data-trick-play] [data-card-id]',
  '[data-trick-slot] [data-card-id]',
  '.current-trick-card',
  '.trick-card',
  '.played-card',
]

const DEFAULT_WINNER_TARGET_SELECTORS: Record<Seat, string[]> = {
  bottom: [
    '[data-seat-panel="bottom"]',
    '[data-seat="bottom"]',
    '[data-player-seat="bottom"]',
    '[data-seat-anchor="bottom"]',
    '#seat-bottom',
  ],
  left: [
    '[data-seat-panel="left"]',
    '[data-seat="left"]',
    '[data-player-seat="left"]',
    '[data-seat-anchor="left"]',
    '#seat-left',
  ],
  top: [
    '[data-seat-panel="top"]',
    '[data-seat="top"]',
    '[data-player-seat="top"]',
    '[data-seat-anchor="top"]',
    '#seat-top',
  ],
  right: [
    '[data-seat-panel="right"]',
    '[data-seat="right"]',
    '[data-player-seat="right"]',
    '[data-seat-anchor="right"]',
    '#seat-right',
  ],
}

function findFirstElement(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const element = document.querySelector(selector)

    if (element instanceof HTMLElement) {
      return element
    }
  }

  return null
}

function isVisibleCardLikeElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()

  if (rect.width < 20 || rect.height < 30) {
    return false
  }

  if (rect.bottom < 0 || rect.right < 0) {
    return false
  }

  if (rect.top > window.innerHeight || rect.left > window.innerWidth) {
    return false
  }

  const style = window.getComputedStyle(element)

  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false
  }

  return true
}

function getDistanceToViewportCenter(element: HTMLElement): number {
  const rect = element.getBoundingClientRect()
  const elementCenterX = rect.left + rect.width / 2
  const elementCenterY = rect.top + rect.height / 2
  const viewportCenterX = window.innerWidth / 2
  const viewportCenterY = window.innerHeight / 2

  const deltaX = elementCenterX - viewportCenterX
  const deltaY = elementCenterY - viewportCenterY

  return Math.hypot(deltaX, deltaY)
}

function getCenterCardFallbackElements(): HTMLElement[] {
  const allCardCandidates = Array.from(
    document.querySelectorAll<HTMLElement>('[data-card-id]')
  ).filter(isVisibleCardLikeElement)

  if (allCardCandidates.length === 0) {
    return []
  }

  const sortedByCenterDistance = allCardCandidates
    .map((element) => ({
      element,
      distance: getDistanceToViewportCenter(element),
    }))
    .sort((left, right) => left.distance - right.distance)

  const centerCards = sortedByCenterDistance
    .filter((entry) => entry.distance <= 240)
    .slice(0, 4)
    .map((entry) => entry.element)

  return centerCards
}

function resolvePlayedCardsByDefault(): HTMLElement[] {
  for (const selector of DEFAULT_PLAYED_CARD_SELECTORS) {
    const elements = Array.from(document.querySelectorAll(selector)).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && isVisibleCardLikeElement(element),
    )

    if (elements.length > 0) {
      return elements
    }
  }

  return getCenterCardFallbackElements()
}

function resolveWinnerTargetByDefault(winnerSeat: Seat): HTMLElement | null {
  return findFirstElement(DEFAULT_WINNER_TARGET_SELECTORS[winnerSeat] ?? [])
}

export function createTrickCollectionController(
  options: CreateTrickCollectionControllerOptions = {},
): TrickCollectionController {
  const resolvePlayedCardElements =
    options.resolvePlayedCardElements ?? resolvePlayedCardsByDefault

  const resolveWinnerTargetElement =
    options.resolveWinnerTargetElement ?? resolveWinnerTargetByDefault

  const minCardsToAnimate = options.minCardsToAnimate ?? 2

  let activeAnimationKey: string | null = null
  let lastCompletedAnimationKey: string | null = null
  let running = false

  async function sync(input: TrickCollectionSyncInput): Promise<void> {
    const { trickKey, winnerSeat, shouldAnimate } = input

    if (!shouldAnimate || !trickKey || !winnerSeat) {
      return
    }

    if (running && activeAnimationKey === trickKey) {
      return
    }

    if (lastCompletedAnimationKey === trickKey) {
      return
    }

    const playedCardElements = resolvePlayedCardElements()

    if (playedCardElements.length < minCardsToAnimate) {
      return
    }

    const targetElement = resolveWinnerTargetElement(winnerSeat)

    if (!targetElement) {
      return
    }

    running = true
    activeAnimationKey = trickKey

    try {
      await animateTrickCollection({
        cards: playedCardElements.map((element) => ({ element })),
        winnerSeat,
        targetElement,
      })

      lastCompletedAnimationKey = trickKey
    } finally {
      running = false
      activeAnimationKey = null
    }
  }

  function reset(): void {
    activeAnimationKey = null
    lastCompletedAnimationKey = null
    running = false
  }

  function isRunning(): boolean {
    return running
  }

  function hasCompleted(trickKey: string | null): boolean {
    if (!trickKey) {
      return false
    }

    return lastCompletedAnimationKey === trickKey
  }

  return {
    sync,
    reset,
    isRunning,
    hasCompleted,
  }
}