// Маркиране на допустими ходове върху вече рендираната дъска — само target
// клетките получават мек пулсиращ highlight (normal) или impact ring
// (capture, когато има противникова пионка на target клетката). Клетките
// МЕЖДУ старт и край не се маркират постоянно.
//
// Normal highlight остава inline вътре в клетката (не излиза извън нейните
// граници, затова е безопасен там). Capture impact ring НЕ се рендира вътре
// в клетката — той нарочно преодолява границите на target клетката, а CSS
// Grid item-ите се рисуват в document order, така че съседна клетка,
// идваща след target-а в реда, би скрила изтичащата част (виж visual
// review). Затова ring-ът се рендира в отделен board-level overlay слой
// (data-ludo-effects-overlay), позициониран absolute спрямо цялата дъска,
// над всички клетки — виж buildLudoCaptureRingPosition/applyLudoBoardContent.

import type { LudoGridPoint } from '../board/ludoBoardGeometry'
import type { LudoLegalMove } from '../ludoTypes'

const GRID_SIZE = 15

export function renderLudoNormalHighlight(): string {
  return `
    <div style="
      position:absolute;
      inset:12%;
      border-radius:50%;
      background:rgba(212,165,32,0.35);
      animation:ludo-normal-highlight-pulse 1.6s ease-in-out infinite;
      pointer-events:none;
    "></div>
  `
}

// Позиция и размер на impact ring-а в проценти спрямо board-level overlay-а
// (същият 15x15 grid space), изчислени от grid координатите на target
// клетката — overlay-ят няма собствен grid, затова позиционираме directno
// чрез left/top/width/height проценти вместо grid-column/row.
export function renderLudoCaptureImpactRing(point: LudoGridPoint): string {
  const cellSize = 100 / GRID_SIZE
  const left = point.col * cellSize
  const top = point.row * cellSize
  // -15% spread спрямо клетката (същия ефект като преди), изразен в
  // overlay-проценти: половин клетка разширение във всяка посока.
  const spread = cellSize * 0.15

  return `
    <div data-ludo-impact-ring="1" style="
      position:absolute;
      left:${(left - spread).toFixed(4)}%;
      top:${(top - spread).toFixed(4)}%;
      width:${(cellSize + spread * 2).toFixed(4)}%;
      height:${(cellSize + spread * 2).toFixed(4)}%;
      border-radius:50%;
      border:2px solid rgba(224,71,62,0.85);
      box-shadow:0 0 10px 2px rgba(224,71,62,0.55);
      animation:ludo-capture-ring-pulse 1.1s ease-in-out infinite;
      pointer-events:none;
    "></div>
  `
}

export interface LudoHighlightPlan {
  normalCellIds: string[]
  captureCellIds: string[]
}

export function planLudoHighlights(legalMoves: LudoLegalMove[]): LudoHighlightPlan {
  const normalCellIds: string[] = []
  const captureCellIds: string[] = []
  for (const move of legalMoves) {
    if (move.type === 'capture') captureCellIds.push(move.targetCell)
    else normalCellIds.push(move.targetCell)
  }
  return { normalCellIds, captureCellIds }
}
