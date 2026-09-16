// Рендерира дъската като 15x15 CSS grid от адресируеми DOM клетки
// (data-ludo-cell="track-31" и т.н.) — НЕ фонова картинка. Всяка клетка е
// свой елемент, за да могат по-късно highlight/pieces/animation слоеве да ги
// адресират директно.
//
// Визуален стил (visual redesign — виж task-а: по-ярка/наситена "game-like"
// палитра, вдъхновена от референтна снимка, но НЕ 1:1 копие): плътен, топъл
// оранжев фон, бели квадратни track клетки с ясна graphic-style граница,
// квадратни (не кръгли) цветни home зони в ъглите. Geometry/брой полета/
// движение НЕ са пипнати — само rendering/styling слоят.

import { LUDO_COLOR_HEX, LUDO_COLORS, ludoCellId, type LudoCell, type LudoColor } from '../ludoTypes'
import { ludoAdvanceTrackIndex, ludoAllCellIds, ludoFinishEntryTrackIndex, ludoGridPointForCellId, ludoSafeCellIds, ludoStartCellIds, ludoStartTrackIndex, parseLudoCellId, LUDO_HOME_SLOTS } from './ludoBoardGeometry'
import { rotateLudoGridPointForViewer, rotateLudoDirectionForViewer, mapLudoColorToViewerQuadrant } from './ludoPerspective'

const GRID_SIZE = 15
// Изнесени (export) само за да могат renderLudoGameScreen.ts да изчисли
// mobile card-alignment формулата спрямо РЕАЛНАТА geometry на home
// кръговете (виж task-а) — стойностите тук остават абсолютно непроменени,
// само вече са четими отвън вместо file-local.
export const LUDO_BOARD_GRID_SIZE = GRID_SIZE
// Visual redesign (виж task-а: "по-ярки и наситени цветове на дъската",
// "общият вид да е по-чист и по-атрактивен") — по-топъл, по-наситен
// game-board оранжев backdrop вместо предишния приглушен пастелен тон.
const BOARD_BACKDROP = '#f2a33f'
const TRACK_CELL_BG = '#ffffff'
const CELL_LINE = 'rgba(20,20,20,0.55)'
// Start/entry клетката вече носи цвета на играча (виж task-а т.4: "изходното
// поле да бъде в цвета на съответния играч"), не неутрално бяло/звезда —
// прилага се directно като background на клетката (trackCellStyle), с лек
// tint (не пълен наситен hex) за да остане track ivory grid-ът четим и
// консистентен, докато входното поле пак ясно се откроява от съседните
// бели клетки.
function startCellTintBackground(hex: string): string {
  return `linear-gradient(180deg, ${hex}f2 0%, ${hex}d9 100%)`
}
// Board frame padding — изнесена като named constant (преди беше inline
// низ на 2 места: frame padding и effects-overlay inset), за да може
// renderLudoGameScreen.ts да смята card-alignment формулата спрямо ТОЧНО
// същата стойност, без дублиране/разминаване. Стойността е непроменена.
export const LUDO_BOARD_FRAME_PADDING_CSS = 'min(2vw, 12px)'

function isFinishCell(cell: LudoCell): cell is Extract<LudoCell, { kind: 'finish' }> {
  return cell.kind === 'finish'
}

function trackCellStyle(cell: LudoCell, startColor: LudoColor | null): string {
  if (isFinishCell(cell)) {
    return `background:${LUDO_COLOR_HEX[cell.color]};`
  }
  if (startColor) {
    return `background:${startCellTintBackground(LUDO_COLOR_HEX[startColor])};`
  }
  return `background:${TRACK_CELL_BG};`
}

// Посоката на входната стрелка се ИЗВЕЖДА от реалната track геометрия
// (delta между стартовата клетка на цвета и следващата клетка по маршрута),
// не се хардкодва — гарантирано вярна спрямо часовниковата посока на
// движение дори track геометрията да се промени по-късно. rotationDeg е
// спрямо plain триъгълник, сочещ НАГОРЕ по подразбиране (0deg=up,
// 90deg=right, 180deg=down, 270deg=left).
function computeClockwiseArrowRotationDeg(startIndex: number): number {
  const currentPoint = ludoGridPointForCellId(ludoCellId({ kind: 'track', index: startIndex }))
  const nextIndex = ludoAdvanceTrackIndex(startIndex, 1)
  const nextPoint = ludoGridPointForCellId(ludoCellId({ kind: 'track', index: nextIndex }))
  const dCol = nextPoint.col - currentPoint.col
  const dRow = nextPoint.row - currentPoint.row
  if (dRow < 0) return 0
  if (dCol > 0) return 90
  if (dRow > 0) return 180
  return 270
}

// Посоката на finish-entry стрелката се извежда от РЕАЛНАТА geometry (delta
// между track клетката и ПЪРВАТА клетка от собствения finish коридор на
// цвета), не се хардкодва — за разлика от computeClockwiseArrowRotationDeg
// по-горе (delta между track клетка и СЛЕДВАЩАТА track клетка по маршрута),
// защото посоката "навътре към finish lane-а" геометрично НЕ съвпада с
// track advance посоката (виж task-а — черни X маркери: клетката непосредствено
// преди собствения finish завива ПЕРПЕНДИКУЛЯРНО навътре, не продължава
// направо по track-а).
function computeFinishEntryArrowRotationDeg(finishEntryTrackIndex: number, color: LudoColor): number {
  const currentPoint = ludoGridPointForCellId(ludoCellId({ kind: 'track', index: finishEntryTrackIndex }))
  const finishFirstPoint = ludoGridPointForCellId(ludoCellId({ kind: 'finish', color, slot: 0 }))
  const dCol = finishFirstPoint.col - currentPoint.col
  const dRow = finishFirstPoint.row - currentPoint.row
  if (dRow < 0) return 0
  if (dCol > 0) return 90
  if (dRow > 0) return 180
  return 270
}

// Класическа 5-връхна звезда, чиста SVG форма (не text glyph &#9733; — по-
// добър контрол върху размер/цвят/stroke на всякакъв cell размер, desktop и
// mobile). Бяла (fill), с по-тъмна/по-плътна окантовка за четимост върху
// белия track фон и лек drop-shadow за отделяне. Увеличена спрямо
// предишната итерация (виж task-а: "увеличи размера... направи контурите
// малко по-тъмни").
function safeCellStarMarker(): string {
  return `
    <svg viewBox="0 0 24 24" style="width:68%; height:68%; filter:drop-shadow(0 1px 1.5px rgba(0,0,0,0.4));">
      <path
        d="M12 1.5 L15.09 8.26 L22.5 9.27 L17.02 14.14 L18.6 21.5 L12 17.77 L5.4 21.5 L6.98 14.14 L1.5 9.27 L8.91 8.26 Z"
        fill="#ffffff"
        stroke="rgba(20,20,20,0.75)"
        stroke-width="1.3"
        stroke-linejoin="round"
      ></path>
    </svg>
  `
}

// Малка цветна стрелка НА САМАТА start клетка (виж task-а — референтна
// снимка: една стрелка, позиционирана directно в цветната start клетка,
// сочеща по посоката на движение — не на бялата клетка преди нея, и не
// голяма бяла block-arrow, каквато имаше преди тази поправка). Просто
// clip-path триъгълник, бял (за контраст върху цветния tint фон на
// клетката), добре видим.
function startCellArrowMarker(rotationDeg: number): string {
  return `
    <div style="
      width:50%; height:50%;
      clip-path:polygon(50% 6%, 88% 82%, 50% 62%, 12% 82%);
      background:#ffffff;
      transform:rotate(${rotationDeg}deg);
      filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45));
    "></div>
  `
}

// Цветна стрелка на бялата клетка НЕПОСРЕДСТВЕНО ПРЕДИ входа на СОБСТВЕНИЯ
// finish коридор (виж task-а — референтна снимка с черни X маркери, "стрелка
// която да сочи към цветните полета през които се прибира пионката след
// пълен оборот... всяка стрелка да е със съответния цвят на полето").
// Различна форма/позиция от startCellArrowMarker по-горе (тази е НА бяла
// клетка, не на цветна) — плътен clip-path триъгълник В ЦВЕТА на играча (не
// бял), за да се откроява добре върху белия track фон.
function finishEntryArrowMarker(color: LudoColor, rotationDeg: number): string {
  return `
    <div style="
      width:48%; height:48%;
      clip-path:polygon(50% 8%, 86% 80%, 50% 60%, 14% 80%);
      background:${LUDO_COLOR_HEX[color]};
      transform:rotate(${rotationDeg}deg);
      filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4));
    "></div>
  `
}

function trackCellMarker(
  isStartArrow: boolean,
  startArrowColor: LudoColor | null,
  startArrowRotationDeg: number,
  isSafeCell: boolean,
  finishEntryColor: LudoColor | null,
  finishEntryRotationDeg: number,
): string {
  if (isStartArrow && startArrowColor) return startCellArrowMarker(startArrowRotationDeg)
  if (finishEntryColor) return finishEntryArrowMarker(finishEntryColor, finishEntryRotationDeg)
  // Safe-cell звезда (виж task-а — референтна Ludo King дъска: бели звезди
  // на определени безопасни клетки по трасето, симетрично на всяко рамо).
  // Rendering marker за ENGINE rule (виж ludoGeometryConstants.ts
  // LUDO_SAFE_TRACK_INDICES doc коментара + engine/ludoEngineLegalMoves.ts
  // isCapture изчислението) — тези клетки вече реално предпазват opponent
  // пионка от capture, не само визуален indicator.
  if (isSafeCell) return safeCellStarMarker()
  return ''
}

// localColor определя viewer perspective (виж ludoPerspective.ts) — local
// player-ът винаги визуално долу вляво. Canonical geometry
// (ludoBoardGeometry.ts, ludoGeometryConstants.ts) остава НАПЪЛНО
// недокоснат; тук само remap-ваме РЕНДИРАНИТЕ grid координати/посоки/цвят-
// позиции. Engine state не се пипа никъде в тази функция.
export function renderLudoBoard(localColor: LudoColor): string {
  const startCells = ludoStartCellIds()
  const cellIds = ludoAllCellIds()
  const safeCellIds = new Set(ludoSafeCellIds())

  // Стрелка НА САМАТА start клетка (виж task-а — референтна снимка: една
  // стрелка, позиционирана directно в цветната start клетка, сочеща по
  // посока на движение), извлечена директно от ludoStartTrackIndex, не
  // хардкоднато — остава вярно automatически при промяна на track
  // дължината. Посоката се remap-ва за viewer-а
  // (rotateLudoDirectionForViewer) — стрелката винаги сочи визуално
  // правилно по посоката на движение, независимо от завъртането.
  const startArrowTrackIndex: Record<number, LudoColor> = Object.fromEntries(
    LUDO_COLORS.map((color) => [ludoStartTrackIndex(color), color]),
  )
  const startArrowRotationDeg: Partial<Record<LudoColor, number>> = Object.fromEntries(
    LUDO_COLORS.map((color) => [
      color,
      rotateLudoDirectionForViewer(computeClockwiseArrowRotationDeg(ludoStartTrackIndex(color)), localColor),
    ]),
  )

  // Цветна стрелка на бялата клетка НЕПОСРЕДСТВЕНО ПРЕДИ входа на собствения
  // finish коридор (виж task-а — черни X маркери в референтната снимка,
  // "след като направи един оборот на дъската"). ludoFinishEntryTrackIndex е
  // геометрично РАЗЛИЧНА клетка от start-a (виж doc коментара в
  // ludoBoardGeometry.ts) — потвърдена симетрично за и четирите цвята чрез
  // grid coordinate измерване спрямо действителните X позиции в снимката.
  const finishEntryTrackIndex: Record<number, LudoColor> = Object.fromEntries(
    LUDO_COLORS.map((color) => [ludoFinishEntryTrackIndex(color), color]),
  )
  const finishEntryRotationDeg: Partial<Record<LudoColor, number>> = Object.fromEntries(
    LUDO_COLORS.map((color) => [
      color,
      rotateLudoDirectionForViewer(computeFinishEntryArrowRotationDeg(ludoFinishEntryTrackIndex(color), color), localColor),
    ]),
  )

  const trackAndFinishCells = cellIds
    .filter((id) => !id.startsWith('home-'))
    .map((id) => {
      const cell = parseLudoCellId(id)
      const point = rotateLudoGridPointForViewer(ludoGridPointForCellId(id), localColor)
      const isStart = LUDO_COLORS.some((color) => startCells[color] === id)
      const startColor = isStart ? (LUDO_COLORS.find((color) => startCells[color] === id) ?? null) : null
      const isStartArrow = cell.kind === 'track' && cell.index in startArrowTrackIndex
      const startArrowColor = cell.kind === 'track' ? (startArrowTrackIndex[cell.index] ?? null) : null
      const isSafeCell = safeCellIds.has(id)
      const finishEntryColor = cell.kind === 'track' ? (finishEntryTrackIndex[cell.index] ?? null) : null

      // Пионките overflow-ват видимо над собствената си клетка (виж
      // teardrop дизайна — renderLudoPieces.ts) — без explicit z-index тук,
      // кой съсед печели стекинга зависи от document order в cellIds
      // (произволен спрямо визуалната row позиция), не от реалната
      // вертикална подредба. z-index-ът долу е спрямо РЕНДИРАНИЯ (viewer-
      // remapped) point.row — по-долен ред (по-голямо row число) получава
      // по-висок z-index, затова пионка от клетка ПОД покрива горния си
      // съсед, когато overflow-ват една върху друга (виж task-а: "долната
      // пионка да закрива част от горната"), не обратно. ВАЖНО: inline HTML
      // style атрибутите тук са в двойни кавички — CSS коментари вътре в
      // style="" НЕ трябва да съдържат буквални " символи (те прекратяват
      // атрибута преждевременно в HTML parser-а, truncating целия останал
      // style silently) — доказан реален бъг тук, затова обяснението живее
      // като JS коментар отвън template literal-а, не inline в CSS-а.
      return `
        <div
          data-ludo-cell="${id}"
          style="
            grid-column:${point.col + 1};
            grid-row:${point.row + 1};
            ${trackCellStyle(cell, startColor)}
            box-shadow:inset 0 0 0 1px ${CELL_LINE};
            position:relative;
            display:flex;
            align-items:center;
            justify-content:center;
            z-index:${point.row};
          "
        >
          ${trackCellMarker(
            isStartArrow,
            startArrowColor,
            startArrowColor ? (startArrowRotationDeg[startArrowColor] ?? 0) : 0,
            isSafeCell,
            finishEntryColor,
            finishEntryColor ? (finishEntryRotationDeg[finishEntryColor] ?? 0) : 0,
          )}
          <div data-ludo-cell-highlight="${id}" hidden style="position:absolute;inset:0;z-index:1;"></div>
          <div data-ludo-cell-pieces="${id}" style="position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;pointer-events:none;"></div>
        </div>
      `
    })
    .join('')

  const homeQuadrants = LUDO_COLORS.map((color) => renderLudoHomeQuadrant(color, localColor)).join('')
  // Централният 4-триъгълен square: всеки триъгълен edge (top/right/bottom/
  // left) сочи по посока на finish lane approach-а на своя цвят — тя винаги
  // "гледа" от -90° спрямо home quadrant-а на цвета (red е top-left, finish
  // lane-ът му приближава центъра ОТЛЯВО, значи left edge; аналогично
  // blue=top-right->top edge, yellow=bottom-right->right edge,
  // green=bottom-left->bottom edge — canonical съответствие, потвърдено от
  // непроменения clip-path ред по-долу). Square-ът Е symmetric спрямо
  // центъра (позицията му не се мести при rotation), затова remap-ваме
  // само КОЙ цвят е във всеки edge, спрямо viewer quadrant-а на цвета.
  const EDGE_QUADRANT_OFFSET: Record<'top' | 'right' | 'bottom' | 'left', 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left'> = {
    left: 'top-left',
    top: 'top-right',
    right: 'bottom-right',
    bottom: 'bottom-left',
  }
  const centerColorForEdge = (edge: 'top' | 'right' | 'bottom' | 'left'): LudoColor =>
    LUDO_COLORS.find((color) => mapLudoColorToViewerQuadrant(color, localColor) === EDGE_QUADRANT_OFFSET[edge])!

  return `
    <div data-ludo-board-frame="1" style="
      position:relative;
      width:100%;
      aspect-ratio:1 / 1;
      background:linear-gradient(160deg, #6b4a2c 0%, #4a3018 60%, #3a2412 100%);
      border-radius:16px;
      padding:${LUDO_BOARD_FRAME_PADDING_CSS};
      box-sizing:border-box;
      box-shadow:0 14px 30px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.06);
    ">
      <div data-ludo-board="1" style="
        position:relative;
        width:100%;
        height:100%;
        display:grid;
        grid-template-columns:repeat(${GRID_SIZE}, 1fr);
        grid-template-rows:repeat(${GRID_SIZE}, 1fr);
        background:${BOARD_BACKDROP};
        border-radius:6px;
        /* overflow:visible (не hidden) — виж task-а: пионките в горния ред
           overflow-ват видимо над клетката им (по дизайн, capковидния
           силует), а overflow:hidden тук ги режеше на границата на грида.
           border-radius:6px остава деклариран (визуално почти незабележим
           на тази скала спрямо frame-a's 16px radius, който е основният
           видим "заоблен ъгъл" ефект) — само overflow clipping-ът е
           премахнат, geometry/фон/border-shadow остават непроменени. */
        overflow:visible;
        box-shadow:inset 0 0 0 2px rgba(0,0,0,0.35);
      ">
        ${trackAndFinishCells}
        <div data-ludo-board-center="1" style="
          grid-column:7 / span 3;
          grid-row:7 / span 3;
          position:relative;
          overflow:hidden;
        ">
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 0 0, 100% 0);background:${LUDO_COLOR_HEX[centerColorForEdge('top')]};"></div>
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 100% 0, 100% 100%);background:${LUDO_COLOR_HEX[centerColorForEdge('right')]};"></div>
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 100% 100%, 0 100%);background:${LUDO_COLOR_HEX[centerColorForEdge('bottom')]};"></div>
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 0 100%, 0 0);background:${LUDO_COLOR_HEX[centerColorForEdge('left')]};"></div>
        </div>
        ${homeQuadrants}
      </div>
      <div data-ludo-effects-overlay="1" style="
        position:absolute;
        inset:${LUDO_BOARD_FRAME_PADDING_CSS};
        pointer-events:none;
        z-index:50;
      "></div>
    </div>
  `
}

// Origin (top-left ъгъл на 5x5 span-a) за всеки VIEWER quadrant — фиксирани
// grid позиции, независими от цвят. Кой цвят получава кой origin вече се
// решава от mapLudoColorToViewerQuadrant (виж renderLudoHomeQuadrant по-
// долу) — самите 4 позиции остават same 4 canonical числа, каквито бяха и
// преди viewer rotation-а (не rotate-ваме origin точката геометрично, защото
// 90°/270° завъртане на един ъгъл на 5x5 блок не дава коректно новия
// top-left ъгъл без допълнителна корекция — по-просто и по-ясно е кой
// цвят/quadrant получава кой ФИКСИРАН origin).
export const QUADRANT_ORIGIN: Record<'top-left' | 'top-right' | 'bottom-right' | 'bottom-left', { col: number; row: number }> = {
  'top-left': { col: 1, row: 1 },
  'top-right': { col: 11, row: 1 },
  'bottom-right': { col: 11, row: 11 },
  'bottom-left': { col: 1, row: 11 },
}

// Изнесени (export) заедно с HOME_QUADRANT_SHIFT/SPAN по-долу — единствената
// причина е mobile card-alignment формулата в renderLudoGameScreen.ts (виж
// task-а), която трябва да смята РЕАЛНИЯ center на всеки home кръг. ВНИМАНИЕ:
// това е CANONICAL (non-rotated) mapping — renderLudoHomeQuadrant по-долу
// remap-ва origin-а за viewer perspective чрез QUADRANT_ORIGIN +
// mapLudoColorToViewerQuadrant, НЕ директно през тази таблица.
export const HOME_QUADRANT_ORIGIN: Record<LudoColor, { col: number; row: number }> = {
  red: QUADRANT_ORIGIN['top-left'],
  blue: QUADRANT_ORIGIN['top-right'],
  yellow: QUADRANT_ORIGIN['bottom-right'],
  green: QUADRANT_ORIGIN['bottom-left'],
}

// Span (в grid клетки) на всеки home quadrant — преди беше hardcoded "5" на
// 2 места в темплейта долу (grid-column/grid-row span). Изнесено като named
// constant по същата причина като по-горе; темплейтът вече реферира тази
// константа вместо literal "5".
export const HOME_QUADRANT_SPAN = 5

// Измества ЦЯЛАТА home група (голям кръг + 4 малки слота + пионките вътре)
// навътре към центъра на дъската, като едно цяло — през transform:translate
// върху ВЪНШНИЯ quadrant контейнер, не чрез промяна на вътрешната геометрия
// (inset-ът на големия кръг и 72% на слот-grid-а остават непипнати).
// Стойностите са в % от СОБСТВЕНИЯ размер на quadrant контейнера (transform
// проценти се смятат спрямо own bounding box, не спрямо родителя), затова
// автоматично остава пропорционално на всеки viewport/board размер, без
// отделна mobile логика. 3% ≈ 6.4px на desktop board при 1440×900 (quadrant
// ~214px) — точно в поискания 4-6px диапазон.
const HOME_QUADRANT_SHIFT_PERCENT = 3
// Shift посоката зависи от VISUAL (rendered) quadrant позицията — "навътре
// към центъра", не от цвета directno. red, ако визуално е в bottom-left
// (viewer rotation), трябва shift +x -y (надясно и нагоре), same каквото
// green (canonical bottom-left) вече ползваше — виж renderLudoHomeQuadrant
// по-долу, което чете тази таблица по VIEWER quadrant, не по цвят.
export const QUADRANT_SHIFT: Record<'top-left' | 'top-right' | 'bottom-right' | 'bottom-left', { x: number; y: number }> = {
  'top-left': { x: HOME_QUADRANT_SHIFT_PERCENT, y: HOME_QUADRANT_SHIFT_PERCENT },
  'top-right': { x: -HOME_QUADRANT_SHIFT_PERCENT, y: HOME_QUADRANT_SHIFT_PERCENT },
  'bottom-right': { x: -HOME_QUADRANT_SHIFT_PERCENT, y: -HOME_QUADRANT_SHIFT_PERCENT },
  'bottom-left': { x: HOME_QUADRANT_SHIFT_PERCENT, y: -HOME_QUADRANT_SHIFT_PERCENT },
}

// CANONICAL (non-rotated) mapping — пазена за обратна съвместимост
// (renderLudoGameScreen.ts card-alignment формулата, виж коментара там).
export const HOME_QUADRANT_SHIFT: Record<LudoColor, { x: number; y: number }> = {
  red: QUADRANT_SHIFT['top-left'],
  blue: QUADRANT_SHIFT['top-right'],
  yellow: QUADRANT_SHIFT['bottom-right'],
  green: QUADRANT_SHIFT['bottom-left'],
}

// Локални позиции (1-3) на 4-те слота вътре в собствения 3x3 grid на всеки
// home quadrant — независими от абсолютните board координати в
// ludoBoardGeometry (тези тук са само за визуално групиране 2x2 в ъглите на
// квадранта, а НЕ логическият адрес на клетката). Симетрични спрямо
// квадранта, за да изглеждат еднакво във всичките 4 ъгъла.
const HOME_SLOT_LOCAL_POSITION: Array<{ col: number; row: number }> = [
  { col: 1, row: 1 },
  { col: 3, row: 1 },
  { col: 1, row: 3 },
  { col: 3, row: 3 },
]

// Home зоната е QUADRATНА (не кръгла медальон-форма — виж task-а т.2/т.6:
// "home полетата да НЕ са кръгли, а квадратни"), седяща ВЪРХУ оранжевия
// board backdrop с закръглени ъгли (rounded-square, не пълен кръг) —
// по-близко до референтната снимка. Слотовете вътре са квадратни бели
// клетки, подредени 2x2 в самия квадратен блок. origin/shift/GEOMETRY
// (QUADRANT_ORIGIN/QUADRANT_SHIFT/HOME_QUADRANT_SPAN) остават НАПЪЛНО
// непроменени — само формата (border-radius) на визуалния блок и на
// слотовете се сменя от кръг на квадрат, затова mobile card-alignment
// формулата в renderLudoGameScreen.ts (ludoHomeCircleCenterGridFraction,
// която разчита само на origin/shift/span, не на конкретната форма) остава
// вярна без промяна.
function renderLudoHomeQuadrant(color: LudoColor, localColor: LudoColor): string {
  const viewerQuadrant = mapLudoColorToViewerQuadrant(color, localColor)
  const origin = QUADRANT_ORIGIN[viewerQuadrant]
  const hex = LUDO_COLOR_HEX[color]
  const shift = QUADRANT_SHIFT[viewerQuadrant]

  const slots = Array.from({ length: LUDO_HOME_SLOTS }, (_, slot) => {
    const id = ludoCellId({ kind: 'home', color, slot })
    const localPos = HOME_SLOT_LOCAL_POSITION[slot]
    return `
      <div
        data-ludo-cell="${id}"
        style="
          grid-column:${localPos.col};
          grid-row:${localPos.row};
          background:rgba(255,255,255,0.95);
          border-radius:22%;
          position:relative;
          box-shadow:inset 0 0 0 1px ${CELL_LINE};
        "
      >
        <div data-ludo-cell-highlight="${id}" hidden style="position:absolute;inset:0;z-index:1;"></div>
        <div data-ludo-cell-pieces="${id}" style="position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;pointer-events:none;"></div>
      </div>
    `
  }).join('')

  return `
    <div style="
      grid-column:${origin.col} / span ${HOME_QUADRANT_SPAN};
      grid-row:${origin.row} / span ${HOME_QUADRANT_SPAN};
      position:relative;
      display:flex;
      align-items:center;
      justify-content:center;
      pointer-events:none;
      transform:translate(${shift.x}%, ${shift.y}%);
    ">
      <div style="
        position:absolute;
        inset:2%;
        border-radius:14%;
        background:${hex};
        box-shadow:0 3px 8px rgba(0,0,0,0.35), inset 0 0 0 3px rgba(255,255,255,0.25);
      "></div>
      <div style="
        position:relative;
        width:72%;
        height:72%;
        display:grid;
        grid-template-columns:repeat(3, 1fr);
        grid-template-rows:repeat(3, 1fr);
        pointer-events:auto;
      ">
        ${slots}
      </div>
    </div>
  `
}
