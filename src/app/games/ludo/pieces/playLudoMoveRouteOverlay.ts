import { renderLudoPieceHtml } from './renderLudoPieces'
import type { LudoCellId, LudoPieceId } from '../ludoTypes'

const MOVE_TRAVEL_MS = 165
const STEP_TOTAL_MS = 260
const TRAIL_FADE_MS = 320
const EARLY_TRAVEL_SCALE = 1.06
const MID_TRAVEL_SCALE = 1.18

export interface LudoMoveRouteOverlayOptions {
  root: ParentNode
  pieceId: LudoPieceId
  fromCellId: LudoCellId
  route: readonly LudoCellId[]
  pieceSizePx: number
  initiallyHidden: boolean
  debugSpeedScale?: number
}

export interface LudoMoveRouteOverlayResult {
  finished: Promise<void>
  cancel: () => void
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function centerRelativeToOverlay(cell: Element, overlay: HTMLElement): { x: number; y: number } {
  const cellRect = cell.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  return {
    x: cellRect.left - overlayRect.left + cellRect.width / 2,
    y: cellRect.top - overlayRect.top + cellRect.height / 2,
  }
}

function cellCenter(root: ParentNode, overlay: HTMLElement, cellId: LudoCellId): { x: number; y: number } | null {
  const cell = root.querySelector(`[data-ludo-cell-pieces="${cellId}"]`)
  if (!cell) return null
  return centerRelativeToOverlay(cell, overlay)
}

function createPieceNode(pieceId: LudoPieceId, pieceSizePx: number, kind: 'moving' | 'trail'): HTMLElement {
  const node = document.createElement('div')
  node.setAttribute(kind === 'moving' ? 'data-ludo-moving-piece' : 'data-ludo-move-trail', pieceId)
  node.style.cssText = `
    position:absolute;
    width:${pieceSizePx}px;
    left:0;
    top:0;
    transform:translate(-50%, -50%);
    transform-origin:center center;
    pointer-events:none;
    will-change:left, top, opacity, transform;
    z-index:${kind === 'moving' ? 80 : 60};
  `
  node.innerHTML = renderLudoPieceHtml(pieceId, false, 1, [pieceId])
  if (kind === 'moving') {
    const renderedPiece = node.querySelector<HTMLElement>(`[data-ludo-piece="${pieceId}"]`)
    if (renderedPiece) {
      // pieceSizePx is already the canonical pawn's rendered width. The shared
      // renderer normally sizes itself to 80% of a cell, so remove that second
      // 80% when it is nested inside this already-sized moving wrapper.
      renderedPiece.style.width = '100%'
      renderedPiece.style.maxWidth = 'none'
    }
  }
  if (kind === 'trail') {
    node.style.opacity = '0.34'
    node.style.filter = 'drop-shadow(0 0 5px currentColor) saturate(1.1)'
  }
  return node
}

function place(node: HTMLElement, point: { x: number; y: number }): void {
  node.style.left = `${point.x}px`
  node.style.top = `${point.y}px`
}

function playTrail(overlay: HTMLElement, pieceId: LudoPieceId, pieceSizePx: number, point: { x: number; y: number }, speedScale: number): Animation | null {
  const trail = createPieceNode(pieceId, pieceSizePx, 'trail')
  place(trail, point)
  overlay.appendChild(trail)
  const animation = trail.animate(
    [
      { opacity: 0.34, transform: 'translate(-50%, -50%) scale(0.96)' },
      { opacity: 0.18, transform: 'translate(-50%, -50%) scale(1.04)', offset: 0.42 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.12)' },
    ],
    { duration: TRAIL_FADE_MS * speedScale, easing: 'cubic-bezier(0.2, 0.6, 0.25, 1)', fill: 'forwards' },
  )
  animation.finished.finally(() => trail.remove()).catch(() => trail.remove())
  return animation
}

export function playLudoMoveRouteOverlay(options: LudoMoveRouteOverlayOptions): LudoMoveRouteOverlayResult {
  const { root, pieceId, fromCellId, route, pieceSizePx, initiallyHidden } = options
  const speedScale = Math.max(0.1, options.debugSpeedScale ?? 1)
  const overlay = root.querySelector<HTMLElement>('[data-ludo-effects-overlay="1"]')
  if (!overlay || route.length === 0) return { finished: Promise.resolve(), cancel: () => {} }

  const start = cellCenter(root, overlay, fromCellId)
  if (!start) return { finished: Promise.resolve(), cancel: () => {} }

  const moving = createPieceNode(pieceId, pieceSizePx, 'moving')
  moving.style.visibility = initiallyHidden ? 'hidden' : 'visible'
  place(moving, start)
  overlay.appendChild(moving)

  const trailAnimations: Animation[] = []
  let cancelled = false
  let activeAnimation: Animation | null = null

  const cleanup = () => {
    cancelled = true
    activeAnimation?.cancel()
    for (const animation of trailAnimations) animation.cancel()
    overlay.querySelectorAll(`[data-ludo-moving-piece="${pieceId}"], [data-ludo-move-trail="${pieceId}"]`).forEach((node) => node.remove())
  }

  const finished = (async () => {
    let current = start
    try {
      for (const cellId of route) {
        if (cancelled) return
        const next = cellCenter(root, overlay, cellId)
        if (!next) return

        const trail = playTrail(overlay, pieceId, pieceSizePx, current, speedScale)
        if (trail) trailAnimations.push(trail)

        activeAnimation = moving.animate(
          [
            { left: `${current.x}px`, top: `${current.y}px`, transform: 'translate(-50%, -50%) scale(1)' },
            {
              left: `${current.x + (next.x - current.x) * 0.2}px`,
              top: `${current.y + (next.y - current.y) * 0.2}px`,
              transform: `translate(-50%, -50%) scale(${EARLY_TRAVEL_SCALE})`,
              offset: 0.2,
            },
            {
              left: `${current.x + (next.x - current.x) * 0.5}px`,
              top: `${current.y + (next.y - current.y) * 0.5}px`,
              transform: `translate(-50%, -50%) scale(${MID_TRAVEL_SCALE})`,
              offset: 0.5,
            },
            {
              left: `${current.x + (next.x - current.x) * 0.8}px`,
              top: `${current.y + (next.y - current.y) * 0.8}px`,
              transform: `translate(-50%, -50%) scale(${EARLY_TRAVEL_SCALE})`,
              offset: 0.8,
            },
            { left: `${next.x}px`, top: `${next.y}px`, transform: 'translate(-50%, -50%) scale(1)' },
          ],
          { duration: MOVE_TRAVEL_MS * speedScale, easing: 'linear', fill: 'forwards' },
        )
        try {
          await activeAnimation.finished
        } catch {
          return
        }
        if (cancelled) return
        place(moving, next)
        moving.style.transform = 'translate(-50%, -50%) scale(1)'
        current = next
        await wait(Math.max(0, STEP_TOTAL_MS - MOVE_TRAVEL_MS) * speedScale)
      }
    } finally {
      moving.remove()
    }
  })()

  return { finished, cancel: cleanup }
}
