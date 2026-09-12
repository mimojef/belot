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

// Target клетка за normal move — трябва да се разпознава веднага, върху
// бял (track), червен/син/зелен/жълт (home/finish) фон еднакво добре.
// Комбинация от 3 layer-а вътре в общ pulsing wrapper (скалира/fade-ва
// заедно, за да остане "дишащ", не тресящ се ефект):
//   1. outer glow (box-shadow, изтича извън клетката — вижда се дори на
//      наситен цветен фон, не само на бял);
//   2. златист outline ring с бяла вътрешна кант-линия за контраст;
//   3. вътрешен светъл radial fill — сигнализира "стъпи тук" отблизо.
// Умишлено ЗЛАТИСТО (gold/amber), не червено — capture ring-ът
// (renderLudoCaptureImpactRing) остава единствения червен ефект, за да не
// се бъркат визуално normal move с capture.
export function renderLudoNormalHighlight(): string {
  return `
    <div style="
      position:absolute;
      inset:9%;
      border-radius:50%;
      pointer-events:none;
      animation:ludo-normal-highlight-pulse 1.8s ease-in-out infinite;
    ">
      <div style="
        position:absolute;
        inset:0;
        border-radius:50%;
        border:3px solid #ffd766;
        box-shadow:
          0 0 0 2px rgba(255,255,255,0.65),
          0 0 12px 3px rgba(255,196,44,0.9),
          0 0 24px 8px rgba(255,196,44,0.55);
      "></div>
      <div style="
        position:absolute;
        inset:22%;
        border-radius:50%;
        background:radial-gradient(circle, rgba(255,248,220,0.98) 0%, rgba(255,214,74,0.7) 62%, rgba(255,214,74,0) 100%);
      "></div>
    </div>
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
