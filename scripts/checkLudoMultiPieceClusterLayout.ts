// Deterministic проверка на multi-piece-cell overlap layout/z-order — НЕ
// browser check (чиста логика, без DOM/Playwright), огледално на
// checkLudoStackCapture.ts. Fix за visual bug: две+ пионки от различни
// цветове на една клетка (напр. safe/star coexistence след
// checkLudoSafeCellCapture.ts fix-а) стояха твърде една върху друга — не се
// виждаше ясно кой цвят е чий, и "own pawn on top" не съществуваше.
//
// ROOT CAUSE (fix #1): renderLudoPieceCluster подреждаше color tokens в
// display:flex;flex-wrap:wrap контейнер с document-order идентичен на
// piecesByColor Map iteration order (недетерминиран спрямо кой цвят е
// "local"/viewer) — нямаше нито controlled overlap (flex wrap просто
// нареждаше редовете), нито z-order приоритет за локалния играч.
//
// ROOT CAUSE (fix #2 — "разпилян диагонал"): първата overlap версия
// ползваше bottom-anchored (left:50%;bottom:0) позициониране с КУМУЛАТИВЕН
// diagonal offset (dx = index * 10px, dy = index * 8px, index е позицията
// на token-а в reда) — при 3-4 едновременни цвята този нарастващ offset
// буквално избутваше острите долни върхове на по-късните token-ове извън
// самата клетка (измерено с Playwright: token-4 tip падаше извън cellRect
// на desktop/mobile). "Скалирането по index" беше самата грешка.
//
// FIX (текущ, "collected in the square"): center-anchored (left:50%;
// top:50%) позициониране + ФИКСИРАНИ (НЕ index-зависими) quadrant offset-и,
// избрани по ОБЩИЯ брой tokens в клетката (SINGLE_SLOT/TWO_SLOTS/
// FOUR_SLOTS в renderLudoPieces.ts), плюс per-cluster-size scale надолу
// (0.82x за 2, 0.56x за 3-4) — token-ите стават по-малки И се групират
// плътно около cell center-а, вместо да "бягат" все по-надалеч с всеки
// следващ цвят. z-order логиката (local винаги topmost) остава напълно
// непроменена от fix #1.
//
// Покрива:
//   L1  single piece на клетка -> layout непроменен (regression guard,
//       identity slot: без offset, пълен размер)
//   L2  2 различни цвята -> и двата token-а присъстват в HTML изхода
//   L3  local color token е ПОСЛЕДЕН в document order (= topmost stacking)
//   L4  local color token носи z-index:100, по-висок от всички останали
//   L5  non-local tokens следват стабилен alphabetical ред помежду си
//   L6  deterministic: същия input -> байт-идентичен HTML изход при
//       повторно извикване
//   L7  localColor=null (напр. preview/no-viewer context) -> ред остава
//       чисто alphabetical, без грешка
//   L8  3+ различни цвята на клетка -> всички token-ове присъстват,
//       local остава последен независимо от броя опоненти
//   L9  всеки non-local token получава РАЗЛИЧЕН positive z-index (никакви
//       два tokens на един и същ stacking ниво, освен local винаги topmost)
//   L10 single piece -> identity slot (dx=0, dy=0, scale=1)
//   L11 2-piece cluster -> compact center-anchored side-by-side, малък
//       ФИКСИРАН хоризонтален offset (regression guard срещу кумулативния
//       diagonal bug)
//   L12 3-piece cluster -> 2x2 quadrant slots, bounded offset, единен
//       (не per-index различен) compact scale
//   L13 4-piece cluster -> пълна 2x2 quadrant решетка, 4 различни позиции,
//       bounded offset, единен compact scale
//
// ВТОРИ FIX (viewer identity audit): renderLudoGameScreen.ts-овият
// resolveLocalPlayerColor() ("find first non-bot player") независимо
// дублираше СЪЩАТА "кой съм АЗ" логика като createLudoFlowController.ts
// localColor const-а — работеше само защото Ludo mock roster-ът засега има
// точно 1 non-bot (red/"Иван"). LudoGameScreenState вече носи explicit
// localColor поле, подадено ЕДИНСТВЕНО от контролера — renderLudoGameScreen/
// applyLudoBoardContent го четат directно, никога не го преизчисляват.
// V1-V7 доказват, че топ pawn-ът следва explicit подадения viewer color, не
// bot-status heuristic, за произволен от 4-те цвята:
//   V1  4 human players, shared safe cell, viewer=red -> red topmost
//   V2  същия state, viewer=blue -> blue topmost
//   V3  viewer=yellow -> yellow topmost
//   V4  viewer=green -> green topmost
//   V5  explicit viewer identity (не "find first non-bot") определя топ pawn
//   V6  localColor=null (preview/harness без local viewer) -> deterministic
//       alphabetical fallback, без crash
//   V7  смяна САМО на viewer identity (същия game state) -> само z-order-ът
//       се променя, същия комплект пионки остава видим
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { renderLudoPieceCluster, renderLudoPiecesByCell } from '../src/app/games/ludo/pieces/renderLudoPieces'
import type { LudoColor, LudoPiece, LudoPieceId } from '../src/app/games/ludo/ludoTypes'

function fail(message: string): never {
  console.error(`[checkLudoMultiPieceClusterLayout] FAIL: ${message}`)
  process.exit(1)
}

function ok(label: string): void {
  console.log(`[checkLudoMultiPieceClusterLayout] ${label} OK`)
}

function mkPiece(id: string, color: LudoPiece['color'], cell: string): LudoPiece {
  return { id: id as LudoPieceId, color, cell: cell as LudoPiece['cell'] }
}

// Извлича DOM token-ите (id + z-index) в РЕДА, в който се появяват в HTML
// string-а (= document order = стек ред при overlap), помагащ за четими
// assertions без реален DOM/jsdom.
function extractTokensInOrder(html: string): Array<{ id: string; zIndex: number | null }> {
  const results: Array<{ id: string; zIndex: number | null }> = []
  const pieceRegex = /data-ludo-piece="([^"]+)"[^>]*style="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = pieceRegex.exec(html)) !== null) {
    const id = match[1]!
    const style = match[2]!
    const zMatch = style.match(/z-index:(\d+)/)
    results.push({ id, zIndex: zMatch ? Number(zMatch[1]) : null })
  }
  return results
}

// Извлича layout-релевантните CSS стойности (position anchor, translate
// dx/dy, scale) за всеки token — за "collected in the square" regression
// проверката по-долу (виж L10-L13). Regex-базиран, не реален DOM/getBBox —
// достатъчно за да провери, че layout-ът НЕ използва кумулативен
// (index-зависим) diagonal offset повече (виж fix-а — предишният "разпилян
// диагонал" бъг: dx/dy растяха линейно с index-а, избутвайки token-ите все
// по-надалеч от центъра, докато новият layout ползва ФИКСИРАНИ quadrant
// offset-и, независещи от токова позиция извън самия slot).
function extractLayoutInfo(html: string): Array<{ id: string; dx: number; dy: number; scale: number; anchor: 'center' | 'bottom' | 'unknown' }> {
  const results: Array<{ id: string; dx: number; dy: number; scale: number; anchor: 'center' | 'bottom' | 'unknown' }> = []
  const pieceRegex = /data-ludo-piece="([^"]+)"[^>]*style="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = pieceRegex.exec(html)) !== null) {
    const id = match[1]!
    const style = match[2]!
    const anchor: 'center' | 'bottom' | 'unknown' = style.includes('top:50%')
      ? 'center'
      : style.includes('bottom:0')
        ? 'bottom'
        : 'unknown'
    const translateMatch = style.match(/translate\(calc\(-50% \+ (-?\d+(?:\.\d+)?)px\), calc\(-50% \+ (-?\d+(?:\.\d+)?)px - 4px\)\)/)
    const scaleMatch = style.match(/scale\((\d+(?:\.\d+)?)\)/)
    results.push({
      id,
      dx: translateMatch ? Number(translateMatch[1]) : 0,
      dy: translateMatch ? Number(translateMatch[2]) : 0,
      scale: scaleMatch ? Number(scaleMatch[1]) : 1,
      anchor,
    })
  }
  return results
}

function main(): void {
  const CELL = 'track-8'

  // --- L1: single piece -> layout regression guard ---
  {
    const pieces = [mkPiece('red-1', 'red', CELL)]
    const html = renderLudoPieceCluster(pieces, new Set(), 'red')
    if (!html.includes('data-ludo-piece="red-1"')) fail('L1: expected red-1 token present in single-piece cluster')
    if (!html.includes('position:relative;width:100%;height:100%;')) {
      fail('L1: expected the outer cluster container to remain position:relative full-size (regression guard)')
    }
    ok('L1 — single piece on a cell renders with the unchanged base container')
  }

  // --- L2: 2 different colors -> both tokens present ---
  {
    const pieces = [mkPiece('red-1', 'red', CELL), mkPiece('blue-0', 'blue', CELL)]
    const html = renderLudoPieceCluster(pieces, new Set(), 'red')
    if (!html.includes('data-ludo-piece="red-1"')) fail('L2: expected red-1 token present')
    if (!html.includes('data-ludo-piece="blue-0"')) fail('L2: expected blue-0 token present')
    ok('L2 — 2 different colors on one cell both render as visible tokens')
  }

  // --- L3: local color token is LAST in document order (topmost stacking) ---
  {
    const pieces = [mkPiece('red-1', 'red', CELL), mkPiece('blue-0', 'blue', CELL)]
    const html = renderLudoPieceCluster(pieces, new Set(), 'red')
    const order = extractTokensInOrder(html)
    if (order.length !== 2) fail(`L3: expected 2 tokens, got ${order.length}`)
    if (order[order.length - 1]!.id !== 'red-1') {
      fail(`L3: expected local color (red) token LAST in document order, got order=${JSON.stringify(order.map((o) => o.id))}`)
    }
    ok('L3 — local color token is last in document order (topmost when overlapping)')
  }

  // --- L4: local color token has the highest z-index ---
  {
    const pieces = [mkPiece('red-1', 'red', CELL), mkPiece('blue-0', 'blue', CELL), mkPiece('yellow-0', 'yellow', CELL)]
    const html = renderLudoPieceCluster(pieces, new Set(), 'red')
    const order = extractTokensInOrder(html)
    const localToken = order.find((o) => o.id === 'red-1')
    if (!localToken || localToken.zIndex === null) fail('L4: expected local (red) token to carry an explicit z-index')
    const others = order.filter((o) => o.id !== 'red-1')
    for (const other of others) {
      if (other.zIndex === null) fail(`L4: expected ${other.id} to carry an explicit z-index`)
      if (other.zIndex! >= localToken!.zIndex!) {
        fail(`L4: expected local z-index (${localToken!.zIndex}) to be strictly higher than ${other.id}'s (${other.zIndex})`)
      }
    }
    ok('L4 — local color token has the strictly highest z-index among all tokens on the cell')
  }

  // --- L5: non-local tokens follow a stable alphabetical order ---
  {
    // Deliberately seeded in non-alphabetical piece array order (green then blue)
    // to prove the render order comes from the sort, not array input order.
    const pieces = [mkPiece('green-0', 'green', CELL), mkPiece('blue-0', 'blue', CELL), mkPiece('red-1', 'red', CELL)]
    const html = renderLudoPieceCluster(pieces, new Set(), 'red')
    const order = extractTokensInOrder(html)
    const nonLocalIds = order.filter((o) => o.id !== 'red-1').map((o) => o.id)
    if (JSON.stringify(nonLocalIds) !== JSON.stringify(['blue-0', 'green-0'])) {
      fail(`L5: expected non-local tokens in alphabetical (blue, green) order, got ${JSON.stringify(nonLocalIds)}`)
    }
    ok('L5 — non-local tokens follow a stable alphabetical order regardless of input array order')
  }

  // --- L6: deterministic — same input -> byte-identical output ---
  {
    const pieces = [mkPiece('red-1', 'red', CELL), mkPiece('blue-0', 'blue', CELL)]
    const html1 = renderLudoPieceCluster(pieces, new Set(), 'red')
    const html2 = renderLudoPieceCluster(pieces, new Set(), 'red')
    if (html1 !== html2) fail('L6: expected byte-identical output for identical input (renderLudoPieceCluster must be pure)')
    ok('L6 — renderLudoPieceCluster is deterministic (pure function, identical output for identical input)')
  }

  // --- L7: localColor=null -> pure alphabetical order, no crash ---
  {
    const pieces = [mkPiece('yellow-0', 'yellow', CELL), mkPiece('blue-0', 'blue', CELL)]
    const html = renderLudoPieceCluster(pieces, new Set(), null)
    const order = extractTokensInOrder(html).map((o) => o.id)
    if (JSON.stringify(order) !== JSON.stringify(['blue-0', 'yellow-0'])) {
      fail(`L7: expected pure alphabetical order with localColor=null, got ${JSON.stringify(order)}`)
    }
    ok('L7 — localColor=null falls back to pure alphabetical order without error')
  }

  // --- L8: 3+ different colors -> all tokens present, local still last ---
  {
    const pieces = [
      mkPiece('red-0', 'red', CELL),
      mkPiece('blue-0', 'blue', CELL),
      mkPiece('yellow-0', 'yellow', CELL),
      mkPiece('green-0', 'green', CELL),
    ]
    const html = renderLudoPieceCluster(pieces, new Set(), 'yellow')
    const order = extractTokensInOrder(html)
    if (order.length !== 4) fail(`L8: expected 4 tokens for 4 colors on one cell, got ${order.length}`)
    if (order[order.length - 1]!.id !== 'yellow-0') {
      fail(`L8: expected local (yellow) token last with 4 colors present, got ${JSON.stringify(order.map((o) => o.id))}`)
    }
    for (const piece of pieces) {
      if (!html.includes(`data-ludo-piece="${piece.id}"`)) fail(`L8: expected ${piece.id} token present in 4-color cluster`)
    }
    ok('L8 — 3+ different colors on one cell all render, local color remains topmost')
  }

  // --- L9: each non-local token gets a DISTINCT positive z-index ---
  {
    const pieces = [
      mkPiece('red-0', 'red', CELL),
      mkPiece('blue-0', 'blue', CELL),
      mkPiece('yellow-0', 'yellow', CELL),
      mkPiece('green-0', 'green', CELL),
    ]
    const html = renderLudoPieceCluster(pieces, new Set(), 'yellow')
    const order = extractTokensInOrder(html)
    const nonLocalZIndices = order.filter((o) => o.id !== 'yellow-0').map((o) => o.zIndex)
    if (nonLocalZIndices.some((z) => z === null || z <= 0)) {
      fail(`L9: expected every non-local token to have a positive z-index, got ${JSON.stringify(nonLocalZIndices)}`)
    }
    const uniqueCount = new Set(nonLocalZIndices).size
    if (uniqueCount !== nonLocalZIndices.length) {
      fail(`L9: expected all non-local z-indices to be distinct, got ${JSON.stringify(nonLocalZIndices)}`)
    }
    ok('L9 — every non-local token gets a distinct positive z-index (stable stacking order)')
  }

  // --- L10-L13: "collected in the square" compact layout (виж fix report —
  // предишният diagonal-cascade offset изкарваше острите върхове на
  // token-ите извън клетката при 3-4 цвята едновременно). Regex-based
  // проверка на CSS layout-а (без реален browser/getBBox — визуалната tip-
  // in-bounds проверка е потвърдена отделно чрез Playwright measurement в
  // task report-а), доказваща структурните инварианти, които правят
  // "разпилян диагонал" невъзможен: center-anchored positioning (не
  // bottom:0) и ФИКСИРАНИ (не кумулативни/index-зависими) quadrant offset-и.

  // --- L10: single piece -> center anchor unchanged from cluster fix, base identity slot ---
  {
    const pieces = [mkPiece('red-1', 'red', CELL)]
    const html = renderLudoPieceCluster(pieces, new Set(), 'red')
    const [layout] = extractLayoutInfo(html)
    if (!layout) fail('L10: expected exactly 1 layout entry for a single piece')
    if (layout!.dx !== 0 || layout!.dy !== 0 || layout!.scale !== 1) {
      fail(`L10: expected single piece at identity offset (dx=0,dy=0,scale=1), got ${JSON.stringify(layout)}`)
    }
    ok('L10 — single piece uses the identity slot (no offset, full scale)')
  }

  // --- L11: 2-piece cluster -> compact side-by-side, NOT cumulative diagonal escalation ---
  {
    const pieces = [mkPiece('red-1', 'red', CELL), mkPiece('blue-0', 'blue', CELL)]
    const html = renderLudoPieceCluster(pieces, new Set(), 'red')
    const layouts = extractLayoutInfo(html)
    if (layouts.length !== 2) fail(`L11: expected 2 layout entries, got ${layouts.length}`)
    for (const l of layouts) {
      if (l.anchor !== 'center') fail(`L11: expected center-anchored (top:50%) positioning for ${l.id}, got anchor=${l.anchor}`)
      // Долна граница (>0.85): regression guard срещу връщане към старите
      // прекалено малки 0.82x tokens (виж task-а — "по-големи, доколкото е
      // възможно"). Горна граница (<1): все още леко под single-piece
      // full size, потвърдено safe на desktop и mobile.
      if (l.scale <= 0.85 || l.scale >= 1) {
        fail(`L11: expected a near-full scale (0.85 < scale < 1) for a 2-piece cluster (${l.id}), got ${l.scale}`)
      }
      if (l.dy !== 0) fail(`L11: expected 2-piece layout to be purely horizontal (dy=0) for ${l.id}, got dy=${l.dy}`)
      if (Math.abs(l.dx) > 15) fail(`L11: expected a SMALL fixed horizontal offset (<=15px) for ${l.id}, got dx=${l.dx} (regression guard against the old cumulative-diagonal bug)`)
    }
    const dxValues = layouts.map((l) => l.dx)
    if (dxValues[0] === dxValues[1]) fail('L11: expected the 2 tokens to have DIFFERENT dx (side-by-side, not stacked)')
    ok('L11 — 2-piece cluster is compact and center-anchored, small fixed horizontal offsets only')
  }

  // --- L12: 3-piece cluster -> 2x2 quadrant slots, fixed offsets, NOT index-scaled ---
  {
    const pieces = [mkPiece('red-0', 'red', CELL), mkPiece('blue-0', 'blue', CELL), mkPiece('yellow-0', 'yellow', CELL)]
    const html = renderLudoPieceCluster(pieces, new Set(), 'red')
    const layouts = extractLayoutInfo(html)
    if (layouts.length !== 3) fail(`L12: expected 3 layout entries, got ${layouts.length}`)
    for (const l of layouts) {
      if (l.anchor !== 'center') fail(`L12: expected center-anchored positioning for ${l.id}, got anchor=${l.anchor}`)
      // Долна граница (>0.7): regression guard срещу връщане към старите
      // миниатюрни 0.56x tokens ("прекалено малки" — виж task-а). Горна
      // граница (<0.9): все още под single-piece full size, компактен
      // достатъчно да НЕ извежда върховете извън клетката (потвърдено
      // геометрично на desktop 1280x850 и mobile 390x844).
      if (l.scale <= 0.7 || l.scale >= 0.9) {
        fail(`L12: expected a compact-but-not-tiny scale (0.7 < scale < 0.9) for a 3-piece cluster (${l.id}), got ${l.scale}`)
      }
      if (Math.abs(l.dx) > 12 || Math.abs(l.dy) > 12) {
        fail(`L12: expected SMALL fixed quadrant offsets (<=12px each axis) for ${l.id}, got dx=${l.dx} dy=${l.dy} (regression guard: old bug scaled offset by index, escalating without bound)`)
      }
    }
    // Всичките 3 scale стойности трябва да са ЕДНАКВИ (един fixed layout за
    // целия cluster, не per-token различна стойност, зависеща от index-а).
    const uniqueScales = new Set(layouts.map((l) => l.scale))
    if (uniqueScales.size !== 1) fail(`L12: expected the SAME scale for every token in a 3-piece cluster, got ${JSON.stringify(layouts.map((l) => l.scale))}`)
    ok('L12 — 3-piece cluster uses fixed, bounded quadrant offsets with a uniform compact scale')
  }

  // --- L13: 4-piece cluster -> full 2x2 quadrant, all distinct positions, bounded offsets ---
  {
    const pieces = [
      mkPiece('red-0', 'red', CELL),
      mkPiece('blue-0', 'blue', CELL),
      mkPiece('yellow-0', 'yellow', CELL),
      mkPiece('green-0', 'green', CELL),
    ]
    const html = renderLudoPieceCluster(pieces, new Set(), 'red')
    const layouts = extractLayoutInfo(html)
    if (layouts.length !== 4) fail(`L13: expected 4 layout entries, got ${layouts.length}`)
    for (const l of layouts) {
      if (l.anchor !== 'center') fail(`L13: expected center-anchored positioning for ${l.id}, got anchor=${l.anchor}`)
      // Долна граница (>0.7): regression guard срещу връщане към старите
      // миниатюрни 0.56x tokens. Горна граница (<0.9): компактен достатъчно
      // да НЕ извежда върховете извън клетката (потвърдено геометрично на
      // desktop 1280x850 и mobile 390x844 — mobile е по-ограничаващият
      // viewport, safe до ~0.85).
      if (l.scale <= 0.7 || l.scale >= 0.9) {
        fail(`L13: expected a compact-but-not-tiny scale (0.7 < scale < 0.9) for a 4-piece cluster (${l.id}), got ${l.scale}`)
      }
      if (Math.abs(l.dx) > 12 || Math.abs(l.dy) > 12) {
        fail(`L13: expected SMALL fixed quadrant offsets (<=12px each axis) for ${l.id}, got dx=${l.dx} dy=${l.dy}`)
      }
    }
    // 4 различни (dx,dy) двойки -> реален 2x2 quadrant spread, не 4 tokens
    // на едно и също място.
    const positions = new Set(layouts.map((l) => `${l.dx},${l.dy}`))
    if (positions.size !== 4) fail(`L13: expected 4 DISTINCT quadrant positions, got ${JSON.stringify([...positions])}`)
    const uniqueScales = new Set(layouts.map((l) => l.scale))
    if (uniqueScales.size !== 1) fail(`L13: expected the SAME scale for every token in a 4-piece cluster, got ${JSON.stringify(layouts.map((l) => l.scale))}`)
    ok('L13 — 4-piece cluster fills a real 2x2 quadrant grid with bounded, uniform-scale offsets')
  }

  // --- V1-V7: explicit local-viewer-identity propagation (виж task-а
  // "audit local viewer identity" — resolveLocalPlayerColor() премахнат от
  // renderLudoGameScreen.ts, localColor вече е EXPLICIT input поле на
  // LudoGameScreenState, подадено от createLudoFlowController.ts, НЕ
  // преизчислено в render layer-a чрез "find first non-bot"). Тестовете тук
  // минават през renderLudoPiecesByCell — СЪЩАТА функция, която
  // applyLudoBoardContent извиква с state.localColor — за да докажат, че
  // "кой е топ pawn" реално следва explicit подадения viewer color, не
  // hardcoded bot-status heuristic.
  const SHARED_CELL = 'track-8'

  function fourHumanPiecesOnSharedCell(): LudoPiece[] {
    return [
      mkPiece('red-0', 'red', SHARED_CELL),
      mkPiece('blue-0', 'blue', SHARED_CELL),
      mkPiece('yellow-0', 'yellow', SHARED_CELL),
      mkPiece('green-0', 'green', SHARED_CELL),
    ]
  }

  function topmostColorFor(pieces: LudoPiece[], localColor: LudoColor | null): string {
    const fragments = renderLudoPiecesByCell(pieces, [], localColor)
    const frag = fragments.find((f) => f.cellId === SHARED_CELL)
    if (!frag) fail('V-helper: expected a fragment for the shared cell')
    const order = extractTokensInOrder(frag!.html)
    if (order.length === 0) fail('V-helper: expected at least 1 token in the shared cell')
    return order[order.length - 1]!.id.split('-')[0]!
  }

  // --- V1: 4 human players, shared safe cell, viewer=red -> red highest z-index ---
  {
    const top = topmostColorFor(fourHumanPiecesOnSharedCell(), 'red')
    if (top !== 'red') fail(`V1: expected red topmost when viewer=red, got ${top}`)
    ok('V1 — viewer=red -> red pawn is topmost on the shared cell')
  }

  // --- V2: same state, viewer=blue -> blue highest z-index ---
  {
    const top = topmostColorFor(fourHumanPiecesOnSharedCell(), 'blue')
    if (top !== 'blue') fail(`V2: expected blue topmost when viewer=blue, got ${top}`)
    ok('V2 — viewer=blue -> blue pawn is topmost on the shared cell (same game state as V1)')
  }

  // --- V3: viewer=yellow -> yellow highest z-index ---
  {
    const top = topmostColorFor(fourHumanPiecesOnSharedCell(), 'yellow')
    if (top !== 'yellow') fail(`V3: expected yellow topmost when viewer=yellow, got ${top}`)
    ok('V3 — viewer=yellow -> yellow pawn is topmost on the shared cell')
  }

  // --- V4: viewer=green -> green highest z-index ---
  {
    const top = topmostColorFor(fourHumanPiecesOnSharedCell(), 'green')
    if (top !== 'green') fail(`V4: expected green topmost when viewer=green, got ${top}`)
    ok('V4 — viewer=green -> green pawn is topmost on the shared cell')
  }

  // --- V5: 2 humans + bots -> local human identity determines the top pawn, NOT "who isn't a bot" ---
  {
    // Симулира точно сценария от task-а: ДВАМА "human" играчи (red и blue —
    // в LudoPiece/renderLudoPieceCluster нивото няма isBot флаг изобщо, само
    // localColor подаден отвън), плюс yellow/green като "ботове" (нямат
    // отношение към renderLudoPieceCluster логиката — тя не поглежда
    // isBot никъде, само сравнява token.color === localColor). Explicit
    // localColor='blue' (НЕ първият цвят по азбучен ред, НЕ 'red') доказва,
    // че топ pawn-ът следва подадения viewer identity, не някаква
    // "find first"/bot-status евристика.
    const pieces = fourHumanPiecesOnSharedCell()
    const top = topmostColorFor(pieces, 'blue')
    if (top !== 'blue') {
      fail(`V5: expected explicit localColor='blue' to determine the top pawn (not a bot-status/first-found heuristic), got ${top}`)
    }
    ok("V5 — explicit local viewer identity determines the top pawn, independent of any bot-status heuristic")
  }

  // --- V6: preview/no local viewer -> deterministic fallback, no crash ---
  {
    const pieces = fourHumanPiecesOnSharedCell()
    let html: string
    try {
      const fragments = renderLudoPiecesByCell(pieces, [], null)
      const frag = fragments.find((f) => f.cellId === SHARED_CELL)
      html = frag ? frag.html : ''
    } catch (err) {
      fail(`V6: expected localColor=null (no local viewer) to render without throwing, got error: ${err}`)
    }
    const order = extractTokensInOrder(html)
    if (order.length !== 4) fail(`V6: expected all 4 tokens present with no local viewer, got ${order.length}`)
    const ids = order.map((o) => o.id.split('-')[0])
    if (JSON.stringify(ids) !== JSON.stringify(['blue', 'green', 'red', 'yellow'])) {
      fail(`V6: expected pure alphabetical fallback order with no local viewer, got ${JSON.stringify(ids)}`)
    }
    ok('V6 — no local viewer (preview/harness context) falls back to a deterministic order without crashing')
  }

  // --- V7: changing ONLY the viewer identity (same game state) changes ONLY the visual z-order ---
  {
    const pieces = fourHumanPiecesOnSharedCell()
    const asRed = renderLudoPiecesByCell(pieces, [], 'red').find((f) => f.cellId === SHARED_CELL)!.html
    const asBlue = renderLudoPiecesByCell(pieces, [], 'blue').find((f) => f.cellId === SHARED_CELL)!.html

    // Пионките от самия piece масив (color/id/cell) са напълно идентични в
    // двата render-а — само localColor варира. Доказваме "само visual
    // z-order се променя": и двата HTML изхода съдържат ТОЧНО същите 4
    // piece id-та (никой piece не изчезва/се появява), но реда/z-index-а
    // се различава.
    const idsInRed = extractTokensInOrder(asRed).map((o) => o.id).sort()
    const idsInBlue = extractTokensInOrder(asBlue).map((o) => o.id).sort()
    if (JSON.stringify(idsInRed) !== JSON.stringify(idsInBlue)) {
      fail(`V7: expected the SAME set of piece ids regardless of viewer (game state unchanged), got red=${JSON.stringify(idsInRed)} blue=${JSON.stringify(idsInBlue)}`)
    }
    if (asRed === asBlue) {
      fail('V7: expected the rendered HTML to DIFFER between viewers (different top pawn/z-order), got byte-identical output')
    }
    const topRed = extractTokensInOrder(asRed).pop()!.id
    const topBlue = extractTokensInOrder(asBlue).pop()!.id
    if (topRed === topBlue) fail(`V7: expected a different topmost pawn per viewer, got the same (${topRed}) for both`)
    ok('V7 — switching ONLY the viewer identity changes ONLY the visual z-order, not which pieces are present')
  }

  console.log('[checkLudoMultiPieceClusterLayout] ALL OK')
  process.exit(0)
}

main()
