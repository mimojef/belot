// Рендерира 16-те пионки като отделни interactive елементи, позиционирани в
// data-ludo-cell-pieces контейнера на тяхната текуща клетка (виж
// renderLudoBoard.ts). Няколко пионки на една клетка се подреждат в мини
// grid, за да не се застъпват изцяло.
//
// Визуален стил (обемна "пионка" форма с градиент/highlight, не плоска
// точка) следва desktop/mobile референтите на Pika.bg.

import { LUDO_COLOR_HEX } from '../ludoTypes'
import type { LudoCellId, LudoLegalMove, LudoPiece, LudoPieceId } from '../ludoTypes'

function piecesByCell(pieces: LudoPiece[]): Map<LudoCellId, LudoPiece[]> {
  const map = new Map<LudoCellId, LudoPiece[]>()
  for (const piece of pieces) {
    const list = map.get(piece.cell) ?? []
    list.push(piece)
    map.set(piece.cell, list)
  }
  return map
}

export function renderLudoPieceHtml(piece: LudoPieceId, selectable: boolean): string {
  const color = piece.split('-')[0] as keyof typeof LUDO_COLOR_HEX
  const hex = LUDO_COLOR_HEX[color]

  return `
    <div
      data-ludo-piece="${piece}"
      ${selectable ? 'data-ludo-piece-selectable="1"' : ''}
      style="
        position:relative;
        width:70%;
        max-width:30px;
        aspect-ratio:0.82/1;
        margin-bottom:2px;
        /* +2px въздух до долния ръб на клетката — renderLudoPieceCluster
           подрежда пионките с align-items:flex-end, а без този margin
           пионката опира точно в долния ръб. Единственото място, което
           рендерира piece token, значи важи навсякъде (track/home/finish,
           desktop/mobile) без отделна логика. */
        pointer-events:${selectable ? 'auto' : 'none'};
        cursor:${selectable ? 'pointer' : 'default'};
        transition:transform 120ms ease, filter 160ms ease;
        ${selectable ? 'animation:ludo-piece-selectable-pulse 1.8s ease-in-out infinite;' : ''}
      "
    >
      <div style="
        position:absolute; left:50%; bottom:0; transform:translateX(-50%);
        width:100%; height:34%;
        background:radial-gradient(ellipse at center, ${hex} 0%, ${shade(hex, -28)} 75%, ${shade(hex, -40)} 100%);
        border-radius:50%;
        box-shadow:0 2px 3px rgba(0,0,0,0.45);
      "></div>
      <div style="
        position:absolute; left:50%; bottom:22%; transform:translateX(-50%);
        width:70%; height:55%;
        background:linear-gradient(180deg, ${shade(hex, 22)} 0%, ${hex} 45%, ${shade(hex, -18)} 100%);
        border-radius:45% 45% 50% 50%;
        box-shadow:inset -2px -2px 3px rgba(0,0,0,0.25), inset 2px 2px 2px rgba(255,255,255,0.35);
      "></div>
      <div style="
        position:absolute; left:50%; top:0; transform:translateX(-50%);
        width:46%; height:46%;
        background:radial-gradient(circle at 35% 30%, ${shade(hex, 18)} 0%, ${hex} 60%, ${shade(hex, -15)} 100%);
        border-radius:50%;
        box-shadow:inset -1px -1px 2px rgba(0,0,0,0.3), inset 1px 1px 1px rgba(255,255,255,0.3)${selectable ? `, 0 0 0 3px ${hex}55` : ''};
      "></div>
    </div>
  `
}

// Опростено осветяване/затъмняване на hex цвят с процент (+ по-светло,
// - по-тъмно), за да получим обемен градиент без отделна image asset.
function shade(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = clamp255(((num >> 16) & 0xff) + Math.round(255 * (percent / 100)))
  const g = clamp255(((num >> 8) & 0xff) + Math.round(255 * (percent / 100)))
  const b = clamp255((num & 0xff) + Math.round(255 * (percent / 100)))
  return `rgb(${r}, ${g}, ${b})`
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, value))
}

// Групирани пионки на една клетка се подреждат в компактен 2xN wrap вместо
// пълно застъпване, за да остане всяка видима и кликаема.
export function renderLudoPieceCluster(pieces: LudoPiece[], selectablePieceIds: Set<LudoPieceId>): string {
  if (pieces.length === 0) return ''
  return `
    <div style="display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:center;gap:1px;width:100%;height:100%;">
      ${pieces.map((p) => renderLudoPieceHtml(p.id, selectablePieceIds.has(p.id))).join('')}
    </div>
  `
}

export interface LudoPiecesRenderResult {
  cellId: LudoCellId
  html: string
}

// Връща per-cell HTML fragments, готови за инжектиране във вече
// съществуващите data-ludo-cell-pieces контейнери (patch, не full re-render
// на цялата дъска).
export function renderLudoPiecesByCell(pieces: LudoPiece[], legalMoves: LudoLegalMove[]): LudoPiecesRenderResult[] {
  const grouped = piecesByCell(pieces)
  const selectablePieceIds = new Set(legalMoves.map((m) => m.pieceId))

  return Array.from(grouped.entries()).map(([cellId, cellPieces]) => ({
    cellId,
    html: renderLudoPieceCluster(cellPieces, selectablePieceIds),
  }))
}
