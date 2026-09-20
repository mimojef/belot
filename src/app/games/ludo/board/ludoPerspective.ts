// PRESENTATION-ONLY viewer perspective mapping — canonical board geometry
// (ludoBoardGeometry.ts) остава напълно недокоснат и engine-ът никога не
// знае "кой цвят е долу вляво". Тук само превръщаме canonical grid точки/
// посоки в rendered (viewer-relative) точки/посоки, за да може local player
// винаги да вижда собствения си quadrant долу вляво — без да въртим DOM-а
// (transform:rotate на цялата дъска би завъртяло и пионки/badge-ове/текст).
//
// Canonical quadrants (ludoBoardGeometry.ts, НЕДОКОСНАТИ):
//   red    = top-left     (start index 0)
//   blue   = top-right    (start index 14)
//   yellow = bottom-right (start index 28)
//   green  = bottom-left  (start index 42)
//
// Viewer rotation (колко 90°-стъпки по часовниковата стрелка местим ВСЯКА
// canonical точка, за да "довъртим" local player-а до bottom-left):
//   local green  -> 0 стъпки  (вече е bottom-left)
//   local yellow -> 1 стъпка  (bottom-right -> bottom-left)
//   local blue   -> 2 стъпки  (top-right -> bottom-left)
//   local red    -> 3 стъпки  (top-left -> bottom-left, "270° / 90°
//                  counter-clockwise" — виж task-а: точно този превод на
//                  "90° counter-clockwise" в термините на нашата clockwise-
//                  стъпкова ротация е 3 clockwise стъпки = 270°)

import type { LudoGridPoint } from './ludoBoardGeometry'
import type { LudoColor } from '../ludoTypes'

const GRID_SIZE = 15
const GRID_CENTER = (GRID_SIZE - 1) / 2 // 7 — центърът на 15x15 0-indexed grid-a

// Брой 90°-clockwise стъпки, нужни да "докараме" local player-а до
// bottom-left, за всеки възможен local цвят.
const VIEWER_ROTATION_STEPS: Record<LudoColor, number> = {
  green: 0,
  yellow: 1,
  blue: 2,
  red: 3,
}

export function ludoViewerRotationSteps(localColor: LudoColor): number {
  return VIEWER_ROTATION_STEPS[localColor]
}

// Едно 90°-clockwise завъртане около центъра на 15x15 grid-а — same формула
// като rotate90 в ludoBoardGeometry.ts (buildTrackGrid/buildFinishGrids),
// но тук е explicit public helper, приложим multiple пъти за да покрие
// всичките 4 възможни ориентации.
function rotateGridPoint90(point: LudoGridPoint): LudoGridPoint {
  const dx = point.col - GRID_CENTER
  const dy = point.row - GRID_CENTER
  return { col: GRID_CENTER - dy, row: GRID_CENTER + dx }
}

// canonicalGridPoint -> rotateLudoGridPointForViewer(...) -> renderedGridPoint.
// Прилага N последователни 90° завъртания (N = ludoViewerRotationSteps),
// determined изцяло от local player-а. Pure — не мутира входа, не чете
// global state.
export function rotateLudoGridPointForViewer(point: LudoGridPoint, localColor: LudoColor): LudoGridPoint {
  let result = point
  const steps = ludoViewerRotationSteps(localColor)
  for (let i = 0; i < steps; i += 1) {
    result = rotateGridPoint90(result)
  }
  return result
}

// Посоки (в градуси, 0=up/90=right/180=down/270=left — same конвенция като
// computeClockwiseArrowRotationDeg в renderLudoBoard.ts) също трябва да се
// remap-нат при viewer rotation — стрелка, сочеща "надясно" в canonical
// координати, продължава да сочи "по посоката на движение", но визуално
// това може да е друга посока на екрана след завъртане на дъската.
export function rotateLudoDirectionForViewer(directionDeg: number, localColor: LudoColor): number {
  const steps = ludoViewerRotationSteps(localColor)
  return (directionDeg + steps * 90) % 360
}

// За presentation слоеве, които трябва да знаят КЪДЕ (кой viewer-relative
// quadrant: 'top-left'|'top-right'|'bottom-right'|'bottom-left') да
// поставят даден canonical цвят — напр. player panel placement (виж
// renderLudoGameScreen.ts). Изведено directно от viewer rotation steps, не
// отделна hardcoded таблица.
export type LudoViewerQuadrant = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left'

const CANONICAL_QUADRANT: Record<LudoColor, LudoViewerQuadrant> = {
  red: 'top-left',
  blue: 'top-right',
  yellow: 'bottom-right',
  green: 'bottom-left',
}

const QUADRANT_CLOCKWISE_ORDER: readonly LudoViewerQuadrant[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left']

export function mapLudoColorToViewerQuadrant(color: LudoColor, localColor: LudoColor): LudoViewerQuadrant {
  const canonicalIndex = QUADRANT_CLOCKWISE_ORDER.indexOf(CANONICAL_QUADRANT[color])
  const steps = ludoViewerRotationSteps(localColor)
  const rotatedIndex = (canonicalIndex + steps) % QUADRANT_CLOCKWISE_ORDER.length
  return QUADRANT_CLOCKWISE_ORDER[rotatedIndex]!
}
