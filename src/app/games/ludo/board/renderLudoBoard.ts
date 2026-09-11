// Рендерира дъската като 15x15 CSS grid от адресируеми DOM клетки
// (data-ludo-cell="track-31" и т.н.) — НЕ фонова картинка. Всяка клетка е
// свой елемент, за да могат по-късно highlight/pieces/animation слоеве да ги
// адресират директно.
//
// Визуален стил следва класическата хартиена "Не се сърди човече" дъска:
// плътен оранжев фон, бели квадратни track клетки с ясна черна graphic-style
// граница, кръгли цветни медальони в ъглите за home базите.

import { LUDO_COLOR_HEX, LUDO_COLORS, ludoCellId, type LudoCell, type LudoColor } from '../ludoTypes'
import { ludoAllCellIds, ludoGridPointForCellId, ludoStartCellIds, ludoStartTrackIndex, parseLudoCellId, LUDO_HOME_SLOTS } from './ludoBoardGeometry'

const GRID_SIZE = 15
const BOARD_BACKDROP = '#e8832e'
const TRACK_CELL_BG = '#ffffff'
const CELL_LINE = 'rgba(20,20,20,0.55)'

function isFinishCell(cell: LudoCell): cell is Extract<LudoCell, { kind: 'finish' }> {
  return cell.kind === 'finish'
}

function trackCellStyle(cell: LudoCell): string {
  if (isFinishCell(cell)) {
    return `background:${LUDO_COLOR_HEX[cell.color]};`
  }
  return `background:${TRACK_CELL_BG};`
}

// Стрелка (посока движение, по часовниковата стрелка) на входа на всяко
// рамо — визуално ехо на референта, чисто декоративно, не логика.
const ENTRY_ARROW_DIRECTION: Record<LudoColor, string> = {
  red: '&#8595;',
  blue: '&#8594;',
  yellow: '&#8593;',
  green: '&#8592;',
}

function trackCellMarker(isStart: boolean, startColor: LudoColor | null, isEntryArrow: boolean, arrowColor: LudoColor | null): string {
  if (isEntryArrow && arrowColor) {
    return `
      <div style="
        width:76%; height:76%; border-radius:50%;
        background:#ffffff; border:2px solid ${LUDO_COLOR_HEX[arrowColor]};
        display:flex; align-items:center; justify-content:center;
        color:${LUDO_COLOR_HEX[arrowColor]}; font-size:65%; font-weight:900; line-height:1;
      ">${ENTRY_ARROW_DIRECTION[arrowColor]}</div>
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
  // decorative кръгла стрелка, огледално на референта (виж горния десен и
  // долния ляв ъгъл в mockup-а). Извлечено директно от ludoStartTrackIndex,
  // не хардкоднато — остава вярно automatически при промяна на track дължината.
  const entryArrowTrackIndex: Record<number, LudoColor> = Object.fromEntries(
    LUDO_COLORS.map((color) => [ludoStartTrackIndex(color), color]),
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
          ${trackCellMarker(isStart, startColor, isEntryArrow, arrowColor)}
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
      padding:min(2vw, 12px);
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
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 0 0, 100% 0);background:${LUDO_COLOR_HEX.red};"></div>
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 100% 0, 100% 100%);background:${LUDO_COLOR_HEX.blue};"></div>
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 100% 100%, 0 100%);background:${LUDO_COLOR_HEX.yellow};"></div>
          <div style="position:absolute; inset:0; clip-path:polygon(50% 50%, 0 100%, 0 0);background:${LUDO_COLOR_HEX.green};"></div>
        </div>
        ${homeQuadrants}
      </div>
      <div data-ludo-effects-overlay="1" style="
        position:absolute;
        inset:min(2vw, 12px);
        pointer-events:none;
        z-index:50;
      "></div>
    </div>
  `
}

const HOME_QUADRANT_ORIGIN: Record<LudoColor, { col: number; row: number }> = {
  red: { col: 1, row: 1 },
  blue: { col: 11, row: 1 },
  yellow: { col: 11, row: 11 },
  green: { col: 1, row: 11 },
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
      grid-column:${origin.col} / span 5;
      grid-row:${origin.row} / span 5;
      position:relative;
      display:flex;
      align-items:center;
      justify-content:center;
      pointer-events:none;
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
