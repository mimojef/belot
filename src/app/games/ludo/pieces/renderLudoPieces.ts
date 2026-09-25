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
import { ludoGridPointForCellId, parseLudoCellId } from '../board/ludoBoardGeometry'
import { rotateLudoGridPointForViewer } from '../board/ludoPerspective'
import { LUDO_FINISH_LENGTH } from '../ludoGeometryConstants'

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

// count = колко реални LudoPiece записи представлява ТОЗИ visual token
// (виж piecesByColor по-горе) — по подразбиране 1 (без цифра), за
// съвместимост с единствения предишен call-site (нямаше count изобщо).
// groupIds = ВСИЧКИ реални piece id-та от стека (когато count>1) — нужно е
// САМО за animateCapture в createLudoFlowController.ts: ако "жертвата" на
// capture-а не е точно representative id-то на token-а (виж
// renderLudoPieceCluster по-долу), querySelector по голия data-ludo-piece
// не би я намерил. data-ludo-piece-group прави тази ситуация все пак
// намираема, без да пипа кое piece РЕАЛНО се маха (game logic-ът е
// недокоснат) — чисто DOM lookup robustness.
//
// Visual redesign (виж task-а — "КАПКООБРАЗНА / СЪЛЗОВИДНА", НЕ bowling-pin,
// НЕ horseshoe/U-shape): единичен SVG teardrop silhouette (ludo-piece-svg-
// path константата по-долу) — голяма закръглена горна част, плавно
// стеснение надолу, малка мека закръглена основа. Един path definition,
// reuse-нат навсякъде (home/track/finish/capture flight overlay — виж
// playLudoCaptureFlightOverlay.ts, който вика точно тази функция), затова
// "единен модел на пионката" изискването е архитектурно гарантирано — няма
// отделен markup за различните контексти. СЪЩИЯТ DOM contract (data-ludo-
// piece/-stack-count/-group/-selectable) — движение/
// selection/click логиката в createLudoFlowController.ts не е пипната.
export function renderLudoPieceHtml(
  piece: LudoPieceId,
  selectable: boolean,
  count = 1,
  groupIds: LudoPieceId[] = [piece],
  // Multi-piece-cell overlap positioning (виж renderLudoPieceCluster по-долу
  // за пълния rationale) — допълнителен inline CSS, вмъкнат СЛЕД базовия
  // transform/pointer-events блок, за да override-ва selectively САМО
  // transform/z-index, без да дублира целия style string. Default '' пази
  // playLudoCaptureFlightOverlay.ts-овия call site (единичен piece, летящ
  // извън всякаква клетка-cluster логика) напълно непроменен.
  extraStyle = '',
  // Presentation-only tip rotation (виж CENTER_TRIANGLE_TIP_ROTATION_DEG doc
  // коментара по-долу) — приложена НА ОТДЕЛЕН вложен слой (renderLudoPieceSvg
  // wrapper-а), НЕ на root div-а тук. Root div-ът носи positioning/scale
  // transform-а (translateY(-4px) + extraStyle cluster offset) — CSS
  // transform е single property, presentation rotate() тук би overwrite-нал
  // (не composed) с тях ако беше на СЪЩИЯ елемент. 0 (default) значи "без
  // rotation" за всички съществуващи call sites (track/home/normal finish/
  // capture flight/move route) — напълно непроменено поведение.
  rotationDeg = 0,
): string {
  const color = piece.split('-')[0] as keyof typeof LUDO_COLOR_HEX
  const hex = LUDO_COLOR_HEX[color]
  // Уникален gradient/filter id per piece instance — SVG <defs> id-та са
  // глобални в document-а, затова 2+ едновременно рендирани пионки (различни
  // клетки, различни цветове) не могат да споделят литерален id без да се
  // "крадат" градиентите визуално. piece id-то вече е уникално per DOM node.
  const uid = piece.replace(/[^a-zA-Z0-9-]/g, '')

  return `
    <div
      data-ludo-piece="${piece}"
      ${count > 1 ? `data-ludo-piece-stack-count="${count}" data-ludo-piece-group="${groupIds.join(' ')}"` : ''}
      ${selectable ? 'data-ludo-piece-selectable="1"' : ''}
      style="
        position:relative;
        width:80%;
        max-width:30px;
        aspect-ratio:0.72/1;
        /* +4px нагоре (виж task-а) — фиксна px стойност, НЕ %-based transform
           (% translateY върху aspect-ratio-derived auto height предизвика
           runaway layout bug тук по-рано, виж align-content:flex-end
           коментара в renderLudoPieceCluster по-долу за пълния root cause
           на foot-alignment fix-а). px стойността е безопасна и предвидима
           за всички viewport-и/размери. */
        transform:translateY(-4px);
        pointer-events:${selectable ? 'auto' : 'none'};
        cursor:${selectable ? 'pointer' : 'default'};
        transition:filter 160ms ease;
        ${extraStyle}
      "
    >
      ${renderLudoPieceSvg(hex, uid, selectable, rotationDeg, count > 1 ? count : null)}
    </div>
  `
}

// Классическа Ludo-pawn капка (виж task-а — референтна Ludo King снимка:
// БЯЛО тяло, ЧЕРЕН outline, цветен КРЪГ вътре в горната закръглена част, не
// цветно тяло/градиент). ЕДИН path, споделен от body fill + outline stroke;
// цветният медальон е отделен <circle>, центриран в главата на капката.
// Профилът е по-тесен/по-остър от предишната итерация (по-близо до
// референтния силует): широка закръглена горна част (~0-40% viewBox
// височина), плавно монотонно стеснение до по-къса остра долна точка
// (~88% височина) — острият край е точно това, което "стъпва" в клетката,
// докато закръглената горна част overflow-ва нагоре (виж margin-top в
// wrapper-а по-горе). viewBox 0 0 60 84.
const LUDO_PIECE_SILHOUETTE_PATH =
  'M30 2 ' +
  'C44 2 55 13 55 26 ' +
  'C55 34 51 41 45 48 ' +
  'C39 54 33 60 30 74 ' +
  'C27 60 21 54 15 48 ' +
  'C9 41 5 34 5 26 ' +
  'C5 13 16 2 30 2 Z'

// Цветният медальон вътре в главата — виж task-а "света да е вътре като
// кръг": НЕ цялото тяло на пионката е в цвета на играча, само този вътрешен
// кръг. Позициониран в горната закръглена зона на силует path-а по-горе.
const LUDO_PIECE_MEDALLION_CENTER = { cx: 30, cy: 26 }
const LUDO_PIECE_MEDALLION_RADIUS = 19

function renderLudoPieceSvg(
  hex: string,
  uid: string,
  selectable: boolean,
  rotationDeg = 0,
  medallionCount: number | null = null,
): string {
  const medallionFillId = `ludo-piece-medallion-fill-${uid}`
  const bodyShadeId = `ludo-piece-body-shade-${uid}`
  const bodyHighlightId = `ludo-piece-body-highlight-${uid}`
  // rotationDeg се прилага ТУК, на самото SVG (independent absolute layer,
  // виж doc коментара при rotationDeg параметъра в renderLudoPieceHtml по-
  // горе) — не носи никакъв друг transform в момента, затова composition-ът
  // е тривиален (нищо за overwrite-ване). transform-origin:center center е
  // default поведение за SVG, но explicit тук за яснота — ротацията е
  // винаги около геометричния център на силует path-а, не около произволна
  // точка.
  const rotationStyle = rotationDeg !== 0 ? `transform:rotate(${rotationDeg}deg);transform-origin:center center;` : ''

  return `
    <svg
      viewBox="0 0 60 84"
      style="
        position:absolute;
        inset:0;
        width:100%;
        height:100%;
        overflow:visible;
        filter:drop-shadow(0 2px 3px rgba(0,0,0,0.4));
        ${rotationStyle}
      "
    >
      <defs>
        <radialGradient id="${medallionFillId}" cx="38%" cy="32%" r="70%">
          <stop offset="0%" stop-color="${shade(hex, 20)}"></stop>
          <stop offset="55%" stop-color="${hex}"></stop>
          <stop offset="100%" stop-color="${shade(hex, -18)}"></stop>
        </radialGradient>
        <linearGradient id="${bodyShadeId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ffffff"></stop>
          <stop offset="60%" stop-color="#f4f4f4"></stop>
          <stop offset="100%" stop-color="#e2e2e2"></stop>
        </linearGradient>
        <radialGradient id="${bodyHighlightId}" cx="32%" cy="14%" r="26%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.95)"></stop>
          <stop offset="100%" stop-color="rgba(255,255,255,0)"></stop>
        </radialGradient>
      </defs>
      <!-- Тяло: бяло/leko градиентно, с плътен черен outline (виж task-а
           "бели с черен кант") — самата капка форма, БЕЗ цвета на играча. -->
      <path d="${LUDO_PIECE_SILHOUETTE_PATH}" fill="url(#${bodyShadeId})" stroke="#161616" stroke-width="2.4" stroke-linejoin="round"></path>
      <!-- Цветен медальон (играчовия цвят) — кръг вътре в горната част. -->
      <circle
        cx="${LUDO_PIECE_MEDALLION_CENTER.cx}" cy="${LUDO_PIECE_MEDALLION_CENTER.cy}" r="${LUDO_PIECE_MEDALLION_RADIUS}"
        fill="url(#${medallionFillId})"
        stroke="#161616"
        stroke-width="1.6"
      ></circle>
      <!-- Мек highlight върху бялото тяло, за лек 3D обем без да размива
           четимостта на черния outline/цветния медальон. -->
      <path d="${LUDO_PIECE_SILHOUETTE_PATH}" fill="url(#${bodyHighlightId})"></path>
      ${selectable ? `<path d="${LUDO_PIECE_SILHOUETTE_PATH}" fill="none" stroke="#ffd766" stroke-width="1.8" opacity="0.9"></path>` : ''}
      ${medallionCount === null ? '' : `
        <text
          x="${LUDO_PIECE_MEDALLION_CENTER.cx + 1}"
          y="${LUDO_PIECE_MEDALLION_CENTER.cy + 3.7}"
          text-anchor="middle"
          dominant-baseline="middle"
          font-family="system-ui, sans-serif"
          font-size="26"
          font-weight="400"
          fill="#111111"
          transform="rotate(${-rotationDeg} ${LUDO_PIECE_MEDALLION_CENTER.cx} ${LUDO_PIECE_MEDALLION_CENTER.cy})"
        >${medallionCount}</text>
      `}
    </svg>
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

// КОМПАКТЕН "collected in the square" layout (виж task-а — предишният
// diagonal-cascade offset избутваше всеки следващ token кумулативно
// надясно/нагоре, което при 3-4 tokens буквално изкарваше острите им
// върхове извън клетката — "разпилян диагонал"). Вместо bottom-anchored
// diagonal escalation, всеки token тук:
//   1. се SCALE-ва надолу (по-малък token = повече tokens се събират без
//      да излизат от клетката) — степента зависи от ОБЩИЯ брой tokens в
//      клетката (виж clusterLayoutForCount по-долу), не от index-а.
//   2. се позиционира спрямо ЦЕНТЪРА на клетката (left:50%;top:50%), НЕ
//      спрямо долния ръб — quadrant offset-ите по-долу са ФИКСИРАНИ
//      (не index * step кумулативно), затова никой token не може да
//      "избяга" все по-надалеч с всеки следващ цвят.
// Резултат: 2 tokens -> компактен overlap един до друг; 3-4 tokens -> 2x2
// quadrant подредба, стегнато събрана в квадратчето на клетката.
type LudoClusterSlot = { dx: number; dy: number; scale: number }

// Track and normal finish pawns are slightly larger than home pawns. This
// shared multiplier is also used by the movement overlay when leaving home.
export const LUDO_BOARD_PAWN_SCALE = 1.12

// Единичен token (count===1 логически "1 цвят в клетката", но виж
// clusterLayoutForCount extra-token overlap case) — непроменено спрямо
// преди overlap fix-а изобщо: пълен размер, center-anchored (leko над
// bottom-center, виж -4px overhang коментара в renderLudoPieceHtml).
const SINGLE_SLOT: LudoClusterSlot = { dx: 0, dy: 0, scale: 1 }

// 2 tokens: 0.92x (виж task-а — "по-големи, доколкото е възможно, без
// върховете да излизат"; измерено с реален Playwright getBoundingClientRect
// spike на desktop 1280x850 И mobile 390x844 — dy=0 означава binding
// constraint-ът е ХОРИЗОНТАЛЕН token spread, не tip-Y, значи tokens могат
// да останат близо до пълен размер; 0.92 остава с безопасен margin над
// 1.0-safe границата, потвърдена и на двата viewport-а), плътно един до
// друг хоризонтално — двата върха остават близо до cell-center по Y,
// разделени само по X, с overlap в средата (заявката explicit позволява
// "по-силно застъпване").
const TWO_SLOTS: readonly LudoClusterSlot[] = [
  { dx: -7, dy: 0, scale: 0.92 },
  { dx: 7, dy: 0, scale: 0.92 },
]

// 3-4 tokens: 2x2 quadrant, 0.80x scale (виж task-а — "прекалено малки",
// увеличено от предишния 0.56x). Измерено геометрично (tip позиция =
// cellCenter + (dx, dy-4) + tokenH*(82/84-0.5)*scale спрямо dy/scale offset-
// а) на desktop 1280x850 И mobile 390x844 (по-малката, по-ограничаваща
// клетка — ~24.5px): mobile bottom-row tip margin остава положителен до
// scale≈0.85, затова 0.80 пази безопасен буфер И на двата viewport-а, докато
// е значително по-голям от предишния 0.56x (43% ръст в linear размер).
// Offset-ите остават ФИКСИРАНИ (не index-зависими) — именно това елиминира
// "разпилян диагонал" ефекта, dy=-7/+5 (не симетрично около 0) компенсира
// -4px overhang базата, за да се получи визуално центриран 2x2 grid.
const FOUR_SLOTS: readonly LudoClusterSlot[] = [
  { dx: -8, dy: -7, scale: 0.8 },
  { dx: 8, dy: -7, scale: 0.8 },
  { dx: -8, dy: 5, scale: 0.8 },
  { dx: 8, dy: 5, scale: 0.8 },
]

function clusterLayoutForCount(totalTokens: number): readonly LudoClusterSlot[] {
  if (totalTokens <= 1) return [SINGLE_SLOT]
  if (totalTokens === 2) return TWO_SLOTS
  return FOUR_SLOTS
}

// The large 0deg pawn is taller than one grid cell, so a small radial offset
// keeps it visually centered in its own colored area without crowding the
// common apex. The direction comes from the viewer-rotated finish[5] cell.
const TRIANGLE_REPRESENTATIVE_SCALE = 1.42
const TRIANGLE_REPRESENTATIVE_OUTWARD_OFFSET_PERCENT = 35
const TOP_TRIANGLE_REPRESENTATIVE_INWARD_OFFSET_PERCENT = 55
const BOARD_CENTER_GRID_INDEX = 7

function triangleRepresentativeOffsetStyle(cellId: LudoCellId, localColor: LudoColor | null): string {
  const canonicalPoint = ludoGridPointForCellId(cellId)
  const point = localColor === null ? canonicalPoint : rotateLudoGridPointForViewer(canonicalPoint, localColor)
  const offsetX = Math.sign(point.col - BOARD_CENTER_GRID_INDEX) * TRIANGLE_REPRESENTATIVE_OUTWARD_OFFSET_PERCENT
  const offsetY = point.row < BOARD_CENTER_GRID_INDEX
    ? TOP_TRIANGLE_REPRESENTATIVE_INWARD_OFFSET_PERCENT
    : Math.sign(point.row - BOARD_CENTER_GRID_INDEX) * TRIANGLE_REPRESENTATIVE_OUTWARD_OFFSET_PERCENT
  const verticalPawnLiftPx = point.row < BOARD_CENTER_GRID_INDEX
    ? 5
    : point.row > BOARD_CENTER_GRID_INDEX
      ? 9
      : 0
  const sidePawnShiftTowardCenterPx = point.col < BOARD_CENTER_GRID_INDEX
    ? 5
    : point.col > BOARD_CENTER_GRID_INDEX
      ? -5
      : 0
  const sidePawnShiftDownPx = point.col !== BOARD_CENTER_GRID_INDEX ? 10 : 0
  const verticalShiftPx = sidePawnShiftDownPx - 4 - verticalPawnLiftPx
  return `position:absolute;left:50%;top:50%;transform:translate(calc(-50% + ${offsetX}% + ${sidePawnShiftTowardCenterPx}px), calc(-50% + ${offsetY}% + ${verticalShiftPx}px)) scale(${TRIANGLE_REPRESENTATIVE_SCALE});`
}

// True only for the logical finish slot hidden under the center triangle.
// finish-<color>-<LUDO_FINISH_LENGTH-1> клетки — единствените, визуално
// слети с централния триъгълник (renderLudoBoard.ts). Всички други клетки
// (track/home/междинни finish) следват стандартния quadrant layout,
// непроменено.
function isCenterTriangleFinishCell(cellId: LudoCellId): boolean {
  const cell = parseLudoCellId(cellId)
  return cell.kind === 'finish' && cell.slot === LUDO_FINISH_LENGTH - 1
}

function clusterOffsetStyle(index: number, totalTokens: number, scaleMultiplier: number): string {
  const slots = clusterLayoutForCount(totalTokens)
  const slot = slots[Math.min(index, slots.length - 1)]!
  // left:50%;top:50% center-anchor (вместо bottom:0) + fixed dx/dy quadrant
  // shift + -4px overhang (established, виж renderLudoPieceHtml doc
  // коментара) + per-cluster scale. Centered anchor гарантира, че token-ът
  // никога не "полепва" към долния ръб на клетката преди offset-а — самият
  // offset е малък и фиксиран, затова острият връх (bottom-center на SVG
  // силуета) остава близо до клетъчния център, вътре в границите ѝ.
  return `position:absolute;left:50%;top:50%;transform:translate(calc(-50% + ${slot.dx}px), calc(-50% + ${slot.dy}px - 4px)) scale(${slot.scale * scaleMultiplier});`
}

function clusterDepthPriority(
  index: number,
  totalTokens: number,
  isLocal: boolean,
  slots: readonly LudoClusterSlot[] = clusterLayoutForCount(totalTokens),
): number {
  const slot = slots[Math.min(index, slots.length - 1)]!
  const yLevels = Array.from(new Set(slots.map((candidate) => candidate.dy))).sort((a, b) => a - b)
  const yRank = yLevels.indexOf(slot.dy)
  // Screen Y is the primary depth key. At equal Y, local identity wins;
  // otherwise the stable slot index is the deterministic paint tiebreaker.
  return yRank * 100 + (isLocal ? 50 : index + 1)
}

// Групираните-по-цвят пионки на една клетка се подреждат с controlled
// diagonal overlap (виж task-а — "две пионки стоят твърде една върху
// друга"): вместо flex-wrap (edge-case преди този fix — само рядък
// 1-кадърен overlap по време на capture animation-а, вече постоянен
// легитимен coexistence state след safe-cell fix-а), всеки color token се
// позиционира absolute с нарастващ диагонален offset (clusterOffsetStyle
// по-горе) — предвидимо, стабилно, никога "случайно" наредено. ЕДИН
// visual token на цвят, с count badge при >1 реални пионки от този цвят
// (виж piecesByColor/renderLudoPieceHtml по-горе).
//
// CROSS-CELL z-index base (fix за втори edge case — виж review-а на
// renderLudoBoard.ts's piece-layer fix-а): data-ludo-cell-pieces
// контейнерите в piece-layer overlay-я СА grid items с numeric
// z-index:point.row — по CSS spec, grid/flex item с z-index!=auto САМ
// establish-ва НОВ stacking context. Затова local pawn-ът з z-index:100
// ВЪТРЕ в собствения си cluster е topmost само спрямо siblings в СЪЩИЯ
// контейнер — съседна клетка с по-висок row-based z-index можеше пак да
// покрие целия local cluster, независимо от вътрешния z-index:100 (доказано
// с реален browser hit-testing: local pawn hidden от съседен cluster, когато
// силуетите overlap-ват). Fix: encode-ваме СЪЩАТА row информация директно в
// САМИЯ token-ов z-index (row * ROW_Z_INDEX_MULTIPLIER + within-cluster
// priority), не само в контейнера — така сравнението остава коректно ДОРИ
// ако token-и от различни клетки/контейнери реално се overlap-нат visually
// (два token-а от различни stacking contexts никога не се сравняват едно
// към едно по CSS правила, но техните РОДИТЕЛСКИ контейнери в
// piece-layer-а СЕ сравняват — щом containerA.z-index > containerB.z-index,
// ЦЕЛИЯТ containerA винаги ляга над ЦЕЛИЯ containerB, независимо от
// вътрешните им z-index стойности; encode-вайки СЪЩАТА row стойност В
// token-а, containerA.z-index и containerB.z-index стават derived от
// същата база като largest child z-index вътре, запазвайки консистентност).
// localColor=null (preview/harness context, виж V6/V7 тестовете) -> row
// остава canonical (без viewer rotation), НЕ хвърля грешка.
//
// A full screen row owns a range of 1000 z-index values. Same-cell slot and
// local tie-break priorities stay inside that range, so a pawn in a lower
// screen row always paints above a pawn in an upper row.
const ROW_Z_INDEX_MULTIPLIER = 1000

function computeRowZIndexBase(cellId: LudoCellId, localColor: LudoColor | null): number {
  const cell = parseLudoCellId(cellId)
  if (cell.kind === 'home') return 0 // home slots никога нямат multi-piece cluster/съседна container конфликт
  const canonicalPoint = ludoGridPointForCellId(cellId)
  const point = localColor === null ? canonicalPoint : rotateLudoGridPointForViewer(canonicalPoint, localColor)
  return point.row * ROW_Z_INDEX_MULTIPLIER
}

// Z-ORDER (виж task-а "own pawn on top"): localColor винаги последен в
// document order (по-късен sibling в СЪЩИЯ stacking context визуално
// покрива по-ранните при overlap) И носи explicit z-index (defense-in-depth
// — не разчита само на document order, ако бъдещ рефакторинг добави
// positioned ancestor между token-ите), сега с row-base (виж
// computeRowZIndexBase по-горе) за коректност и в cross-cell overlap
// случаите, не само вътре в собствения cluster.
export function renderLudoPieceCluster(
  pieces: LudoPiece[],
  selectablePieceIds: Set<LudoPieceId>,
  localColor: LudoColor | null = null,
): string {
  if (pieces.length === 0) return ''

  // Всички пионки тук са гарантирано на СЪЩАТА клетка (piecesByCell
  // групирането в renderLudoPiecesByCell по-долу вече го гарантира преди
  // да достигне тук) — четем cellId от първата, за row-based z-index base.
  const rowZIndexBase = computeRowZIndexBase(pieces[0]!.cell, localColor)
  const clusterCell = parseLudoCellId(pieces[0]!.cell)

  // finish[5] stays logically unchanged, but its large center triangle shows
  // one representative pawn. The real piece ids remain attached to that token.
  if (isCenterTriangleFinishCell(pieces[0]!.cell)) {
    const sorted = [...pieces].sort((a, b) => a.id.localeCompare(b.id))
    const representative = sorted.find((piece) => selectablePieceIds.has(piece.id)) ?? sorted[0]!
    const zIndex = rowZIndexBase + 1
    const extraStyle = `${triangleRepresentativeOffsetStyle(representative.cell, localColor)}z-index:${zIndex};`
    const token = renderLudoPieceHtml(
      representative.id,
      selectablePieceIds.has(representative.id),
      sorted.length,
      sorted.map((piece) => piece.id),
      extraStyle,
      0,
    )

    return `
      <div style="position:relative;width:100%;height:100%;">
        ${token}
      </div>
    `
  }

  const colorGroups = piecesByColor(pieces)
  const scaleMultiplier = clusterCell.kind === 'home' ? 1 : LUDO_BOARD_PAWN_SCALE
  // Viewer-independent color order keeps every color in the same compact
  // slot across perspective switches. Depth, not DOM order, controls paint.
  // Детерминистичен базов ред: по цвят име (стабилен независимо от реда в
  // state.pieces масива), после local цвят (ако присъства в клетката)
  // изтеглен в самия край — последен DOM node = най-висок stacking order.
  const orderedColors = Array.from(colorGroups.keys()).sort((a, b) => a.localeCompare(b))
  const clusterZIndexBase = rowZIndexBase

  const tokens = orderedColors
    .map((color, index) => {
      const group = colorGroups.get(color)!
      // Детерминистична подредба (по id) — гарантира стабилен избор на
      // representative независимо от реда в state.pieces масива.
      const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id))
      // Ако ПОНЕ една от пионките в групата има legal move, представящият
      // token трябва да носи ИМЕННО нейния id — за да click върху
      // единствения видим token реално задейства валидния ход (виж
      // task-а: "не изграждай нови правила", само пази click compatibility).
      const representative = sorted.find((p) => selectablePieceIds.has(p.id)) ?? sorted[0]
      const groupIds = sorted.map((p) => p.id)
      const isLocal = color === localColor
      // Screen row is the primary cross-cell depth. Inside one cell, slot Y
      // wins and local identity only breaks equal-Y ties; all such priorities
      // stay below ROW_Z_INDEX_MULTIPLIER so they cannot overtake a lower row.
      const zIndex = clusterZIndexBase + clusterDepthPriority(index, orderedColors.length, isLocal)
      const extraStyle = `${clusterOffsetStyle(index, orderedColors.length, scaleMultiplier)}z-index:${zIndex};`
      return renderLudoPieceHtml(representative.id, selectablePieceIds.has(representative.id), group.length, groupIds, extraStyle)
    })
    .join('')

  // position:relative контейнер, точно колкото клетката (замества
  // предишния flex-wrap) — всеки token се самопозиционира absolute спрямо
  // него чрез clusterOffsetStyle, вместо да е flex-child subject на wrap/
  // cross-axis логика.
  return `
    <div style="position:relative;width:100%;height:100%;">
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
export function renderLudoPiecesByCell(
  pieces: LudoPiece[],
  legalMoves: LudoLegalMove[],
  localColor: LudoColor | null = null,
): LudoPiecesRenderResult[] {
  const grouped = piecesByCell(pieces)
  const selectablePieceIds = new Set(legalMoves.map((m) => m.pieceId))

  return Array.from(grouped.entries()).map(([cellId, cellPieces]) => ({
    cellId,
    html: renderLudoPieceCluster(cellPieces, selectablePieceIds, localColor),
  }))
}
