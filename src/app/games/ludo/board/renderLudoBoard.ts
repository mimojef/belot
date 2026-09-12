// Рендерира дъската като 15x15 CSS grid от адресируеми DOM клетки
// (data-ludo-cell="track-31" и т.н.) — НЕ фонова картинка. Всяка клетка е
// свой елемент, за да могат по-късно highlight/pieces/animation слоеве да ги
// адресират директно.
//
// Визуален стил следва класическата хартиена "Не се сърди човече" дъска:
// плътен оранжев фон, бели квадратни track клетки с ясна черна graphic-style
// граница, кръгли цветни медальони в ъглите за home базите.

import { LUDO_COLOR_HEX, LUDO_COLORS, ludoCellId, type LudoCell, type LudoColor } from '../ludoTypes'
import { ludoAdvanceTrackIndex, ludoAllCellIds, ludoGridPointForCellId, ludoStartCellIds, ludoStartTrackIndex, parseLudoCellId, LUDO_HOME_SLOTS } from './ludoBoardGeometry'

const GRID_SIZE = 15
// Изнесени (export) само за да могат renderLudoGameScreen.ts да изчисли
// mobile card-alignment формулата спрямо РЕАЛНАТА geometry на home
// кръговете (виж task-а) — стойностите тук остават абсолютно непроменени,
// само вече са четими отвън вместо file-local.
export const LUDO_BOARD_GRID_SIZE = GRID_SIZE
// По-светъл, по-пастелен оранжев backdrop от преди (#e8832e) — виж task-а
// за жълтия контраст; вдигнатата luminance тук е и причината да не се
// налага red/blue/green да се пипат отделно (по-светъл фон автоматично
// увеличава gap-а спрямо всичките 3 по-тъмни цвята).
const BOARD_BACKDROP = '#eea458'
const TRACK_CELL_BG = '#ffffff'
const CELL_LINE = 'rgba(20,20,20,0.55)'
// Board frame padding — изнесена като named constant (преди беше inline
// низ на 2 места: frame padding и effects-overlay inset), за да може
// renderLudoGameScreen.ts да смята card-alignment формулата спрямо ТОЧНО
// същата стойност, без дублиране/разминаване. Стойността е непроменена.
export const LUDO_BOARD_FRAME_PADDING_CSS = 'min(2vw, 12px)'

function isFinishCell(cell: LudoCell): cell is Extract<LudoCell, { kind: 'finish' }> {
  return cell.kind === 'finish'
}

function trackCellStyle(cell: LudoCell): string {
  if (isFinishCell(cell)) {
    return `background:${LUDO_COLOR_HEX[cell.color]};`
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

function trackCellMarker(
  isStart: boolean,
  startColor: LudoColor | null,
  isEntryArrow: boolean,
  arrowColor: LudoColor | null,
  arrowRotationDeg: number,
): string {
  if (isEntryArrow && arrowColor) {
    // Плътна "block arrow" (връх + тяло), не гол триъгълник — една clip-path
    // фигура, сочеща НАГОРЕ по подразбиране, завъртяна спрямо реалната
    // посока на движение (arrowRotationDeg, изведена геометрично по-горе).
    // Без кръг, без outline — само плътен цвят на играча.
    return `
      <div style="
        width:60%; height:60%;
        clip-path:polygon(50% 0%, 92% 40%, 66% 40%, 66% 100%, 34% 100%, 34% 40%, 8% 40%);
        background:${LUDO_COLOR_HEX[arrowColor]};
        transform:rotate(${arrowRotationDeg}deg);
        filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45));
      "></div>
    `
  }
  if (isStart && startColor) {
    return `<span style="color:${LUDO_COLOR_HEX[startColor]};font-size:60%;line-height:1;">&#9733;</span>`
  }
  return ''
}

export function renderLudoBoard(): string {
  const startCells = ludoStartCellIds()
  const cellIds = ludoAllCellIds()

  // Входната клетка на всяко рамо (там откъдето пионките тръгват) — за
  // decorative плътна стрела, сочеща по посока на движение. Извлечено
  // директно от ludoStartTrackIndex, не хардкоднато — остава вярно
  // automatически при промяна на track дължината.
  const entryArrowTrackIndex: Record<number, LudoColor> = Object.fromEntries(
    LUDO_COLORS.map((color) => [ludoStartTrackIndex(color), color]),
  )
  const entryArrowRotationDeg: Partial<Record<LudoColor, number>> = Object.fromEntries(
    LUDO_COLORS.map((color) => [color, computeClockwiseArrowRotationDeg(ludoStartTrackIndex(color))]),
  )

  const trackAndFinishCells = cellIds
    .filter((id) => !id.startsWith('home-'))
    .map((id) => {
      const cell = parseLudoCellId(id)
      const point = ludoGridPointForCellId(id)
      const isStart = LUDO_COLORS.some((color) => startCells[color] === id)
      const startColor = isStart ? (LUDO_COLORS.find((color) => startCells[color] === id) ?? null) : null
      const isEntryArrow = cell.kind === 'track' && cell.index in entryArrowTrackIndex
      const arrowColor = cell.kind === 'track' ? (entryArrowTrackIndex[cell.index] ?? null) : null

      return `
        <div
          data-ludo-cell="${id}"
          style="
            grid-column:${point.col + 1};
            grid-row:${point.row + 1};
            ${trackCellStyle(cell)}
            box-shadow:inset 0 0 0 1px ${CELL_LINE};
            position:relative;
            display:flex;
            align-items:center;
            justify-content:center;
          "
        >
          ${trackCellMarker(isStart, startColor, isEntryArrow, arrowColor, arrowColor ? (entryArrowRotationDeg[arrowColor] ?? 0) : 0)}
          <div data-ludo-cell-highlight="${id}" hidden style="position:absolute;inset:0;z-index:1;"></div>
          <div data-ludo-cell-pieces="${id}" style="position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;pointer-events:none;"></div>
        </div>
      `
    })
    .join('')

  const homeQuadrants = LUDO_COLORS.map((color) => renderLudoHomeQuadrant(color)).join('')

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
        overflow:hidden;
        box-shadow:inset 0 0 0 2px rgba(0,0,0,0.35);
      ">
        ${trackAndFinishCells}
        <div data-ludo-board-center="1" style="
          grid-column:7 / span 3;
          grid-row:7 / span 3;
          position:relative;
          overflow:hidden;
        ">
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 0 0, 100% 0);background:${LUDO_COLOR_HEX.blue};"></div>
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 100% 0, 100% 100%);background:${LUDO_COLOR_HEX.yellow};"></div>
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 100% 100%, 0 100%);background:${LUDO_COLOR_HEX.green};"></div>
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 0 100%, 0 0);background:${LUDO_COLOR_HEX.red};"></div>
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

// Изнесени (export) заедно с HOME_QUADRANT_SHIFT/SPAN по-долу — единствената
// причина е mobile card-alignment формулата в renderLudoGameScreen.ts (виж
// task-а), която трябва да смята РЕАЛНИЯ center на всеки home кръг. Нито
// една от стойностите тук не е променена.
export const HOME_QUADRANT_ORIGIN: Record<LudoColor, { col: number; row: number }> = {
  red: { col: 1, row: 1 },
  blue: { col: 11, row: 1 },
  yellow: { col: 11, row: 11 },
  green: { col: 1, row: 11 },
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
export const HOME_QUADRANT_SHIFT: Record<LudoColor, { x: number; y: number }> = {
  red: { x: HOME_QUADRANT_SHIFT_PERCENT, y: HOME_QUADRANT_SHIFT_PERCENT }, // горе-ляво → надясно и надолу
  blue: { x: -HOME_QUADRANT_SHIFT_PERCENT, y: HOME_QUADRANT_SHIFT_PERCENT }, // горе-дясно → наляво и надолу
  green: { x: HOME_QUADRANT_SHIFT_PERCENT, y: -HOME_QUADRANT_SHIFT_PERCENT }, // долу-ляво → надясно и нагоре
  yellow: { x: -HOME_QUADRANT_SHIFT_PERCENT, y: -HOME_QUADRANT_SHIFT_PERCENT }, // долу-дясно → наляво и нагоре
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

// Home медальонът е кръгъл (не квадратна кутия) и седи ВЪРХУ оранжевия
// board backdrop, точно като хартиената референтна дъска — без собствен
// квадратен фон извън кръга. Слотовете вътре остават бели кръгове.
function renderLudoHomeQuadrant(color: LudoColor): string {
  const origin = HOME_QUADRANT_ORIGIN[color]
  const hex = LUDO_COLOR_HEX[color]
  const shift = HOME_QUADRANT_SHIFT[color]

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
          border-radius:50%;
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
        border-radius:50%;
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
