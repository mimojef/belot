// Браузърна тестова "сглобка" за checkLudoSharedCellStacking.ts — рендира
// РЕАЛНИЯ renderLudoGameScreen()/applyLudoBoardContent() (production
// rendering pipeline, не мокап) с ръчно построен LudoGameScreenState, за да
// може localColor (viewer perspective) да варира свободно за всичките 4
// цвята в един тест (createLudoFlowController.ts hardcode-ва 'red' като
// единствения local/non-bot играч в mock roster-а, затова не подхожда за
// viewer-switch тестване тук — виж checkLudoMultiPieceClusterLayout.ts-овия
// V1-V7 коментар за същото ограничение на cluster-only ниво).
//
// Доказва fix-а за "4-piece shared safe cell" visual bug (пионка частично
// скрита зад съседен квадрат): преди фикса data-ludo-cell-pieces живееше
// ВЪТРЕ в data-ludo-cell (position:relative + numeric z-index:point.row =
// нов stacking context ПО КЛЕТКА), затова overflow-ваща пионка от една
// клетка можеше да попадне "под" opaque background-а на съседна клетка с
// по-висок row-based z-index — виж renderLudoBoard.ts's doc коментара при
// trackAndFinishPieceLayer за пълния root cause/fix.
//
// ВТОРИ edge case (cross-cell CLUSTER overlap, виж mountTwoAdjacentClusters
// по-долу): data-ludo-cell-pieces контейнерите в новия piece-layer СЪЩО
// носят numeric z-index (z-index:point.row, като grid item — grid/flex item
// с z-index!=auto СЪЩО establish-ва stacking context по CSS spec), затова
// local pawn-ът з z-index:100 ВЪТРЕ в своя cluster е topmost само СПРЯМО
// siblings в СЪЩИЯ контейнер — съседен контейнер с по-висок row-based
// z-index теоретично би могъл да покрие целия local cluster, независимо от
// вътрешния z-index:100. Тестваме дали това реално се случва visually.
import { renderLudoGameScreen, applyLudoBoardContent, type LudoGameScreenState } from '/src/app/games/ludo/renderLudoGameScreen.ts'
import type { LudoColor, LudoPiece, LudoPlayer } from '/src/app/games/ludo/ludoTypes.ts'

const root = document.getElementById('ludo-shared-cell-root')!

const players: Record<LudoColor, LudoPlayer> = {
  red: { color: 'red', name: 'Иван', avatarUrl: null, isBot: false },
  blue: { color: 'blue', name: 'Мария', avatarUrl: null, isBot: true },
  yellow: { color: 'yellow', name: 'Петя', avatarUrl: null, isBot: true },
  green: { color: 'green', name: 'Георги', avatarUrl: null, isBot: true },
}

// track-8 = red's canonical safe/star cell (LUDO_SAFE_TRACK_INDICES —
// LUDO_START_INDEX.red(0) + LUDO_SAFE_CELL_OFFSET(8)), СЪЩАТА клетка вече
// ползвана като CELL constant в checkLudoMultiPieceClusterLayout.ts —
// реален, canonical "4 pieces coexist" сценарий (safe cell -> няма capture,
// виж checkLudoSafeCellCapture.ts), не произволен hand-picked index.
const SHARED_CELL_ID = 'track-8'
// track-9 = непосредствен track-8 съсед (следваща клетка по маршрута,
// геометрично adjacent — виж buildTrackGrid arm layout-а) — вече доказано
// (предишния fix verification pass) реално визуално се доближава/overlap-ва
// с track-8 на mobile viewport за някои viewer perspectives, точно
// сценарият, нужен тук за "две съседни клетки, всяка с cluster".
const ADJACENT_CELL_ID = 'track-9'

function buildSharedCellPieces(): LudoPiece[] {
  return (['red', 'blue', 'yellow', 'green'] as LudoColor[]).map((color) => ({
    id: `${color}-0` as LudoPiece['id'],
    color,
    cell: SHARED_CELL_ID as LudoPiece['cell'],
  }))
}

function mountState(pieces: LudoPiece[], localColor: LudoColor): void {
  const state: LudoGameScreenState = {
    players,
    localColor,
    pieces,
    legalMoves: [],
    activeColor: 'red',
    turnPhase: 'waiting_for_roll',
    turnStartedAt: Date.now(),
    turnCountdownMs: 10_000,
    isHumanCountdownActive: true,
    isDiceRolling: false,
    canRollDice: true,
    turnSecondsLeft: 10,
    useMobileLayout: window.innerWidth < 700,
  }
  root.innerHTML = renderLudoGameScreen(state)
  applyLudoBoardContent(root, state)
}

function mountSharedCell(localColor: LudoColor): void {
  mountState(buildSharedCellPieces(), localColor)
}

function mountCompactCluster(count: 3 | 4, localColor: LudoColor): void {
  mountState(buildSharedCellPieces().slice(0, count), localColor)
}

// Two ADJACENT cells (track-8 и track-9), ВСЯКА със собствен multi-piece
// cluster — точно edge case-а от заявката: "две съседни track клетки; и в
// двете има multi-piece cluster; body/силуетите им се доближават или
// overlap-ват". localColor-ът винаги притежава ЕДНА пионка в ВСЯКА клетка
// (по едно "viewer pawn" от двете страни), за да можем да проверим И двете
// посоки (local в клетка A gледан срещу foreign cluster в клетка B, и
// обратно) в един mount.
function mountTwoAdjacentClusters(localColor: LudoColor): void {
  const others = (['red', 'blue', 'yellow', 'green'] as LudoColor[]).filter((c) => c !== localColor)
  const pieces: LudoPiece[] = [
    { id: `${localColor}-0` as LudoPiece['id'], color: localColor, cell: SHARED_CELL_ID as LudoPiece['cell'] },
    { id: `${others[0]}-0` as LudoPiece['id'], color: others[0]!, cell: SHARED_CELL_ID as LudoPiece['cell'] },
    { id: `${others[1]}-0` as LudoPiece['id'], color: others[1]!, cell: ADJACENT_CELL_ID as LudoPiece['cell'] },
    { id: `${localColor}-1` as LudoPiece['id'], color: localColor, cell: ADJACENT_CELL_ID as LudoPiece['cell'] },
    { id: `${others[2]}-0` as LudoPiece['id'], color: others[2]!, cell: ADJACENT_CELL_ID as LudoPiece['cell'] },
  ]
  mountState(pieces, localColor)
}

// Force pointer-events:auto — но САМО върху [data-ludo-piece] (test-only
// override, инжектиран САМО в тази harness страница — production CSS/style
// атрибутите не се пипат никъде). pointer-events:none по подразбиране (non-
// selectable pieces) кара document.elementFromPoint да ги ПРЕСКАЧА при hit-
// testing, връщайки каквото е зад тях, дори ако визуално те са най-отгоре —
// форсирайки auto ТУК правим elementFromPoint да вижда пионките коректно.
//
// ВАЖНО (открито при review на този edge case): data-ludo-cell-pieces/
// data-ludo-piece-layer/data-ludo-cell-highlight ОСТАВАТ на production
// pointer-events:none — НЕ ги форсираме. Тези контейнери са ПРОЗРАЧНИ
// (нямат собствен background) — forced pointer-events:auto върху тях кара
// elementFromPoint да ги връща като "topmost hit" само защото геометрично
// покриват точката, дори когато визуално НЕ крият нищо (прозрачен div не
// може да скрие каквото е под него, само реално paint-нато съдържание може).
// Оставяйки ги на pointer-events:none, elementFromPoint естествено "гледа
// през" тях към реалното съдържание отдолу — точно каквото окото вижда.
const forcePointerEventsStyle = document.createElement('style')
forcePointerEventsStyle.textContent = `
  [data-ludo-piece] {
    pointer-events: auto !important;
  }
`
document.head.appendChild(forcePointerEventsStyle)

function getOwnCellIdForPiece(pieceId: string): string | null {
  const tokenEl = root.querySelector<HTMLElement>(`[data-ludo-piece="${pieceId}"]`)
  const container = tokenEl?.closest('[data-ludo-cell-pieces]') ?? null
  return container ? container.getAttribute('data-ludo-cell-pieces') : null
}

// Класифицира какво реално hit-testва в точка (cx,cy), СПРЯМО СОБСТВЕНАТА
// клетка на тествания piece (изведена dynamически от DOM-а, не hardcoded
// константа — работи еднакво за single-shared-cell И two-adjacent-clusters
// сценариите):
//   "own"           — самата пионка.
//   "piece"         — ДРУГА пионка, но от СЪЩИЯ cluster/клетка (overlap
//                      between tokens в един cluster е ПО ДИЗАЙН, z-order
//                      приоритетът там е отделно доказан в
//                      checkLudoMultiPieceClusterLayout.ts).
//   "foreign-piece" — пионка от ДРУГА клетка/cluster я покрива — ТОЧНО
//                      edge case-а от тази заявка (container-level
//                      stacking context capturing local z-index:100).
//   "own-cell"      — собствената клетка (фон/highlight/празен piece
//                      контейнер), показва се където никоя пионка не покрива.
//   "foreign-cell"  — data-ludo-cell ФОН на ДРУГА клетка — оригиналният бъг
//                      (вече фиксиран, regression guard тук).
//   "other"         — board backdrop/overlay, безобидно.
function classifyHit(pieceId: string, cx: number, cy: number): { kind: string; hitTag: string; hitAttrs: string; detail: string } {
  const tokenEl = root.querySelector<HTMLElement>(`[data-ludo-piece="${pieceId}"]`)
  const ownCellId = getOwnCellIdForPiece(pieceId)
  const hit = document.elementFromPoint(cx, cy)
  if (!hit) return { kind: 'other', hitTag: 'NULL', hitAttrs: '', detail: 'elementFromPoint returned null (outside viewport?)' }
  const attrs = Array.from(hit.attributes).map((a) => `${a.name}=${a.value}`).join(' ')

  if (tokenEl && (tokenEl === hit || tokenEl.contains(hit))) {
    return { kind: 'own', hitTag: hit.tagName, hitAttrs: attrs, detail: 'own token' }
  }
  const hitPieceAncestor = hit.closest('[data-ludo-piece]')
  if (hitPieceAncestor) {
    const hitPieceId = hitPieceAncestor.getAttribute('data-ludo-piece') ?? ''
    const hitPieceCellId = hitPieceAncestor.closest('[data-ludo-cell-pieces]')?.getAttribute('data-ludo-cell-pieces') ?? null
    if (hitPieceCellId === ownCellId) {
      return { kind: 'piece', hitTag: hit.tagName, hitAttrs: attrs, detail: `covered by another piece token from the SAME cluster (${hitPieceId})` }
    }
    // Same COLOR, different cell (e.g. the local player's OWN second pawn
    // in the adjacent cell) — legitimate depth ordering between two of the
    // SAME player's pieces, same spirit as the existing same-cell stack
    // convention (2+ same-color pieces on one cell already collapse into
    // ONE token). This is NOT the edge case under review (a FOREIGN piece
    // hiding the local pawn) — only a genuinely different color counts.
    const ownColor = pieceId.split('-')[0]
    const hitColor = hitPieceId.split('-')[0]
    if (hitColor === ownColor) {
      return { kind: 'piece', hitTag: hit.tagName, hitAttrs: attrs, detail: `covered by the SAME player's own other pawn in a different cell (${hitPieceId}, cell=${hitPieceCellId})` }
    }
    return {
      kind: 'foreign-piece',
      hitTag: hit.tagName,
      hitAttrs: attrs,
      detail: `covered by a piece token from a DIFFERENT cell's cluster (${hitPieceId}, cell=${hitPieceCellId})`,
    }
  }
  const hitCellAncestor = hit.closest('[data-ludo-cell]')
  if (hitCellAncestor) {
    const hitCellId = hitCellAncestor.getAttribute('data-ludo-cell')
    if (hitCellId === ownCellId) {
      return { kind: 'own-cell', hitTag: hit.tagName, hitAttrs: attrs, detail: 'own cell background/highlight' }
    }
    return { kind: 'foreign-cell', hitTag: hit.tagName, hitAttrs: attrs, detail: `occluded by a DIFFERENT cell's background (${hitCellId})` }
  }
  const hitCellPiecesAncestor = hit.closest('[data-ludo-cell-pieces]')
  if (hitCellPiecesAncestor) {
    const hitId = hitCellPiecesAncestor.getAttribute('data-ludo-cell-pieces')
    if (hitId === ownCellId) return { kind: 'own-cell', hitTag: hit.tagName, hitAttrs: attrs, detail: 'own (empty) piece container' }
    return { kind: 'foreign-cell', hitTag: hit.tagName, hitAttrs: attrs, detail: `occluded by a DIFFERENT cell's (empty) piece container (${hitId})` }
  }
  return { kind: 'other', hitTag: hit.tagName, hitAttrs: attrs, detail: 'neither a piece nor a cell ancestor' }
}

// Семпълва точки И по вертикалната, И по хоризонталната ос на token-а bbox-а
// (кръстовиден "plus" pattern), не само геометричния център — overflow-ът
// може да е ВЕРТИКАЛЕН (капковидният силует overflow-ва видимо над
// собствената клетка, виж "-4px overhang"/teardrop коментарите в
// pieces/renderLudoPieces.ts) И/ИЛИ ХОРИЗОНТАЛЕН (FOUR_SLOTS/TWO_SLOTS
// quadrant offset-ите местят token-а с dx=±7..8px наляво/надясно — ако
// съседната клетка на СЪЩИЯ ред има РАВЕН z-index (row-based схемата дава
// еднакъв z-index на same-row съседи), tie-break-ът пада на document order
// в ludoAllCellIds(), който НЕ гарантира "лявата клетка винаги първа" —
// track-ът обикаля дъската in absolute-index ред, не грид left-to-right,
// затова хоризонтален overflow към "по-късна" same-row клетка също би могъл
// да бъде закрит). Sample-ваме top/upper/center/lower/bottom-tip по
// вертикалната ос, ПЛЮС left/right ръбовете на bbox-а по хоризонталната ос.
// FAIL само на "foreign-cell" ИЛИ "foreign-piece" — "piece"/"own-cell"/
// "own" са всички legitimate (виж classifyHit doc коментара).
function isTokenFullyVisible(pieceId: string): { ok: boolean; failures: Array<{ point: string; hit: ReturnType<typeof classifyHit> }> } {
  const tokenEl = root.querySelector<HTMLElement>(`[data-ludo-piece="${pieceId}"]`)
  if (!tokenEl) return { ok: false, failures: [{ point: 'n/a', hit: { kind: 'missing', hitTag: 'MISSING', hitAttrs: '', detail: 'token not found' } }] }
  const rect = tokenEl.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cyMid = rect.top + rect.height / 2
  const samplePoints: Array<[string, number, number]> = [
    ['top-5%', cx, rect.top + rect.height * 0.05],
    ['top-15%', cx, rect.top + rect.height * 0.15],
    ['center', cx, cyMid],
    ['lower-80%', cx, rect.top + rect.height * 0.8],
    ['bottom-tip-95%', cx, rect.top + rect.height * 0.95],
    ['left-edge-10%', rect.left + rect.width * 0.1, cyMid],
    ['left-edge-25%', rect.left + rect.width * 0.25, cyMid],
    ['right-edge-75%', rect.left + rect.width * 0.75, cyMid],
    ['right-edge-90%', rect.left + rect.width * 0.9, cyMid],
  ]

  const failures: Array<{ point: string; hit: ReturnType<typeof classifyHit> }> = []
  for (const [label, px, py] of samplePoints) {
    const hit = classifyHit(pieceId, px, py)
    if (hit.kind === 'foreign-cell' || hit.kind === 'foreign-piece') failures.push({ point: label, hit })
  }
  return { ok: failures.length === 0, failures }
}

function getPieceRect(pieceId: string): { left: number; top: number; right: number; bottom: number } | null {
  const el = root.querySelector<HTMLElement>(`[data-ludo-piece="${pieceId}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

function getPiecePaintOrder(pieceId: string): { centerX: number; centerY: number; zIndex: number } | null {
  const el = root.querySelector<HTMLElement>(`[data-ludo-piece="${pieceId}"]`)
  if (!el) return null
  const rect = el.getBoundingClientRect()
  return {
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
    zIndex: Number.parseInt(getComputedStyle(el).zIndex, 10),
  }
}

function getCellRect(cellId: string): { left: number; top: number; right: number; bottom: number } | null {
  const el = root.querySelector<HTMLElement>(`[data-ludo-cell="${cellId}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
}

function hasHorizontalOverflow(): boolean {
  return document.documentElement.scrollWidth > window.innerWidth + 1
}

;(window as any).__ludoSharedCellStackingHarness = {
  mountSharedCell,
  mountCompactCluster,
  mountTwoAdjacentClusters,
  isTokenFullyVisible,
  getPieceRect,
  getPiecePaintOrder,
  getCellRect,
  hasHorizontalOverflow,
  sharedCellId: SHARED_CELL_ID,
  adjacentCellId: ADJACENT_CELL_ID,
}
