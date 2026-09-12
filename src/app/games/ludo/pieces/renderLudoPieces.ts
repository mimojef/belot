// Рендерира пионките като interactive елементи, позиционирани в
// data-ludo-cell-pieces контейнера на тяхната текуща клетка (виж
// renderLudoBoard.ts). Няколко пионки от ЕДИН цвят на една клетка се
// показват като ЕДИН visual token + count badge (виж task-а — преди
// showваше отделен token за всяка пионка, наредени fan/wrap, което
// изглеждаше като "две отделни пионки" дори когато по state са на СЪЩАТА
// клетка). Пионки от различен цвят на същата клетка (възможно за 1 кадър
// по време на capture animation-а) остават отделни tokens — count badge-ът
// е само за СЪЩИЯ цвят.
//
// Визуален стил (обемна "пионка" форма с градиент/highlight, не плоска
// точка) следва desktop/mobile референтите на Pika.bg.

import { LUDO_COLOR_HEX } from '../ludoTypes'
import type { LudoCellId, LudoColor, LudoLegalMove, LudoPiece, LudoPieceId } from '../ludoTypes'

function piecesByCell(pieces: LudoPiece[]): Map<LudoCellId, LudoPiece[]> {
  const map = new Map<LudoCellId, LudoPiece[]>()
  for (const piece of pieces) {
    const list = map.get(piece.cell) ?? []
    list.push(piece)
    map.set(piece.cell, list)
  }
  return map
}

// Под-групиране ВЪТРЕ в една клетка, по цвят — реалният state пази
// отделните LudoPiece записи непроменени (виж renderLudoPiecesByCell по-
// долу); тук САМО решаваме колко visual tokens да покажем.
function piecesByColor(pieces: LudoPiece[]): Map<LudoColor, LudoPiece[]> {
  const map = new Map<LudoColor, LudoPiece[]>()
  for (const piece of pieces) {
    const list = map.get(piece.color) ?? []
    list.push(piece)
    map.set(piece.color, list)
  }
  return map
}

// count>1 → малък кръгъл badge НАД пионката (SVG, viewBox-базиран —
// скалира се чисто на всякакъв размер на самата пионка, desktop/mobile,
// без отделна px логика, същия trick като rotating dice arrows-а).
function renderStackCountBadge(count: number, hex: string): string {
  return `
    <svg
      viewBox="0 0 20 20"
      style="
        position:absolute;
        top:-34%; left:50%;
        transform:translateX(-50%);
        width:50%;
        aspect-ratio:1/1;
        overflow:visible;
        filter:drop-shadow(0 1px 2px rgba(0,0,0,0.55));
        z-index:4;
        pointer-events:none;
      "
    >
      <circle cx="10" cy="10" r="9" fill="#171717" stroke="${hex}" stroke-width="1.6"></circle>
      <text
        x="10" y="10.5"
        text-anchor="middle"
        dominant-baseline="central"
        font-size="12"
        font-weight="900"
        fill="#ffffff"
      >${count}</text>
    </svg>
  `
}

// count = колко реални LudoPiece записи представлява ТОЗИ visual token
// (виж piecesByColor по-горе) — по подразбиране 1 (без badge), за
// съвместимост с единствения предишен call-site (нямаше count изобщо).
// groupIds = ВСИЧКИ реални piece id-та от стека (когато count>1) — нужно е
// САМО за animateCapture в createLudoFlowController.ts: ако "жертвата" на
// capture-а не е точно representative id-то на token-а (виж
// renderLudoPieceCluster по-долу), querySelector по голия data-ludo-piece
// не би я намерил. data-ludo-piece-group прави тази ситуация все пак
// намираема, без да пипа кое piece РЕАЛНО се маха (game logic-ът е
// недокоснат) — чисто DOM lookup robustness.
export function renderLudoPieceHtml(
  piece: LudoPieceId,
  selectable: boolean,
  count = 1,
  groupIds: LudoPieceId[] = [piece],
): string {
  const color = piece.split('-')[0] as keyof typeof LUDO_COLOR_HEX
  const hex = LUDO_COLOR_HEX[color]

  return `
    <div
      data-ludo-piece="${piece}"
      ${count > 1 ? `data-ludo-piece-stack-count="${count}" data-ludo-piece-group="${groupIds.join(' ')}"` : ''}
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
      ${count > 1 ? renderStackCountBadge(count, hex) : ''}
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

// Групираните-по-цвят пионки на една клетка се подреждат в компактен flex
// wrap (обичайно само 1 token, освен ако клетката съдържа И 2 различни
// цвята едновременно — рядък 1-кадърен overlap по време на capture
// animation-а). ЕДИН visual token на цвят, с count badge при >1 реални
// пионки от този цвят (виж piecesByColor/renderLudoPieceHtml по-горе).
export function renderLudoPieceCluster(pieces: LudoPiece[], selectablePieceIds: Set<LudoPieceId>): string {
  if (pieces.length === 0) return ''

  const colorGroups = piecesByColor(pieces)
  const tokens = Array.from(colorGroups.values())
    .map((group) => {
      // Детерминистична подредба (по id) — гарантира стабилен избор на
      // representative независимо от реда в state.pieces масива.
      const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id))
      // Ако ПОНЕ една от пионките в групата има legal move, представящият
      // token трябва да носи ИМЕННО нейния id — за да click върху
      // единствения видим token реално задейства валидния ход (виж
      // task-а: "не изграждай нови правила", само пази click compatibility).
      const representative = sorted.find((p) => selectablePieceIds.has(p.id)) ?? sorted[0]
      const groupIds = sorted.map((p) => p.id)
      return renderLudoPieceHtml(representative.id, selectablePieceIds.has(representative.id), group.length, groupIds)
    })
    .join('')

  return `
    <div style="display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:center;gap:1px;width:100%;height:100%;">
      ${tokens}
    </div>
  `
}

export interface LudoPiecesRenderResult {
  cellId: LudoCellId
  html: string
}

// Връща per-cell HTML fragments, готови за инжектиране във вече
// съществуващите data-ludo-cell-pieces контейнери (patch, не full re-render
// на цялата дъска). Групирането тук е САМО presentation — state.pieces
// (подаден отвън) остава непроменен, всеки реален LudoPiece запис
// продължава да съществува с отделния си id; renderLudoPieceCluster просто
// решава колко DOM tokens да покаже за резултата.
export function renderLudoPiecesByCell(pieces: LudoPiece[], legalMoves: LudoLegalMove[]): LudoPiecesRenderResult[] {
  const grouped = piecesByCell(pieces)
  const selectablePieceIds = new Set(legalMoves.map((m) => m.pieceId))

  return Array.from(grouped.entries()).map(([cellId, cellPieces]) => ({
    cellId,
    html: renderLudoPieceCluster(cellPieces, selectablePieceIds),
  }))
}
