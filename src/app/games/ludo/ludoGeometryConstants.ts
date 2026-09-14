// Единствен source of truth за canonical track геометрията — дължина на
// трасето и start index на всеки цвят. И `board/ludoBoardGeometry.ts`
// (presentation/grid-координати) И `engine/ludoEngineGeometry.ts` (pure
// rule logic) import-ват ОТТУК, вместо да дублират тези числа (виж Phase 2
// task-а т.3 — преди тази промяна двете места дефинираха '56'/'0,14,28,42'
// независимо едно от друго).
//
// Този модул е PURE — нулева зависимост от DOM/browser/render/ludoTypes.ts,
// за да може engine/ да го import-ва без да наруши собствената си DOM/
// browser изолация. Затова цветовете тук са generic literal union, а не
// import на LudoColor от ludoTypes.ts или ludoEngineTypes.ts — и двата
// модула си остават structurally съвместими с 'red'|'blue'|'green'|'yellow'.

type LudoGeometryColor = 'red' | 'blue' | 'green' | 'yellow'

export const LUDO_TRACK_LENGTH = 56
export const LUDO_FINISH_LENGTH = 6
export const LUDO_HOME_SLOTS = 4

// Всеки цвят влиза на трасето от собствен старт индекс (0-based track
// index), разположени на равни 14-клетки интервали по часовниковата
// стрелка (56/4): red -> blue -> yellow -> green. 14, не 13 — рамото
// включва и диагоналната ъглова клетка на завоя (виж buildTrackGrid в
// board/ludoBoardGeometry.ts) — track-ът е непрекъсната обиколка без
// "декоративни" клетки, които engine-ът би прескачал.
export const LUDO_START_INDEX: Record<LudoGeometryColor, number> = {
  red: 0,
  blue: 14,
  yellow: 28,
  green: 42,
}

export function ludoAdvanceTrackIndex(index: number, steps: number): number {
  return (index + steps) % LUDO_TRACK_LENGTH
}

// GAMEPLAY TURN ORDER — семантично РАЗЛИЧНО от LUDO_COLORS (ludoTypes.ts/
// ludoEngineTypes.ts), която е просто "допустимите цветове" enumeration без
// gameplay значение на реда (виж audit: ludoAllCellIds/ludoStartCellIds/
// entryArrowRotationDeg итерират над LUDO_COLORS само за да построят lookup
// structures — редът там никога не влияе на резултата).
//
// LUDO_CANONICAL_TURN_ORDER е DERIVED от LUDO_START_INDEX (ascending sort
// по start index) — не отделна hardcoded четворка, за да остане ЕДИН source
// of truth: кой играе след кого следва directно от clockwise track
// позицията му, а не от произволен литерал ред другаде. Съвпада с
// HOME_QUADRANT_ORIGIN в board/renderLudoBoard.ts (red горе-ляво -> blue
// горе-дясно -> yellow долу-дясно -> green долу-ляво) — двете НЕЗАВИСИМИ
// clockwise дефиниции (track start index и board quadrant placement)
// потвърждават един и същ ред.
export const LUDO_CANONICAL_TURN_ORDER: readonly LudoGeometryColor[] = (
  Object.keys(LUDO_START_INDEX) as LudoGeometryColor[]
).sort((a, b) => LUDO_START_INDEX[a] - LUDO_START_INDEX[b])
