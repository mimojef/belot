// Harness за scripts/checkLudoPieceSettledLayout.ts — рендира РЕАЛНИЯ
// renderLudoPieceCluster (settled/static пионки) в клетка с фиксиран размер и
// мери резултата в истински browser layout. Movement overlay-ят е пресъздаден
// по същия placement contract като playLudoMoveRouteOverlay.ts
// (cellCenter + createPieceNode: position:fixed, left/top = център на
// клетката, translate(-50%,-50%), вложен renderLudoPieceHtml с width:100%).

import { renderLudoPieceCluster, renderLudoPieceHtml } from '../../src/app/games/ludo/pieces/renderLudoPieces'
import type { LudoColor, LudoPiece, LudoPieceId } from '../../src/app/games/ludo/ludoTypes'

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number; cx: number; cy: number }

function toRect(element: Element): Rect {
  const rect = element.getBoundingClientRect()
  return {
    left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
    width: rect.width, height: rect.height,
    cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2,
  }
}

export interface LudoPieceLayoutMeasurement {
  cell: Rect
  tokens: Array<{ pieceId: string; rect: Rect; styleAttribute: string; position: string }>
  overlayFinal: Rect | null
}

function measureCluster(
  pieces: LudoPiece[],
  localColor: LudoColor | null,
  cellSizePx: number,
  overlayPieceId: LudoPieceId | null,
): LudoPieceLayoutMeasurement {
  const root = document.getElementById('ludo-piece-layout-root')!
  root.innerHTML = ''
  document.querySelectorAll('[data-ludo-moving-piece]').forEach((node) => node.remove())

  const cellId = pieces[0]!.cell
  const cell = document.createElement('div')
  cell.setAttribute('data-ludo-cell-pieces', cellId)
  cell.style.cssText = `position:absolute;left:100px;top:100px;width:${cellSizePx}px;height:${cellSizePx}px;`
  cell.innerHTML = renderLudoPieceCluster(pieces, new Set(), localColor)
  root.appendChild(cell)

  const tokens = Array.from(cell.querySelectorAll<HTMLElement>('[data-ludo-piece]')).map((token) => ({
    pieceId: token.getAttribute('data-ludo-piece') ?? '',
    rect: toRect(token),
    styleAttribute: token.getAttribute('style') ?? '',
    position: getComputedStyle(token).position,
  }))

  let overlayFinal: Rect | null = null
  if (overlayPieceId !== null && tokens.length > 0) {
    const cellRect = cell.getBoundingClientRect()
    const node = document.createElement('div')
    node.setAttribute('data-ludo-moving-piece', overlayPieceId)
    node.style.cssText = `
      position:fixed;
      width:${tokens[0]!.rect.width}px;
      left:${cellRect.left + cellRect.width / 2}px;
      top:${cellRect.top + cellRect.height / 2}px;
      transform:translate(-50%, -50%);
      transform-origin:center center;
      pointer-events:none;
    `
    node.innerHTML = renderLudoPieceHtml(overlayPieceId, false, 1, [overlayPieceId])
    const inner = node.querySelector<HTMLElement>('[data-ludo-piece]')!
    inner.style.width = '100%'
    inner.style.maxWidth = 'none'
    document.body.appendChild(node)
    overlayFinal = toRect(inner)
  }

  return { cell: toRect(cell), tokens, overlayFinal }
}

;(window as unknown as { __ludoPieceLayout: unknown }).__ludoPieceLayout = { measureCluster }
