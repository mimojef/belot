// Геометричен модел на дъската — превръща логическите клетки (track/home/
// finish) в координати върху 15x15 grid (стандартен "Не се сърди човече"
// layout), плюс индексиране за движение по часовниковата стрелка.
//
// Engine-ът по-късно ще каже само "piece red-2 -> track-31" — този модул е
// единственото място, което знае как track-31 се превръща в grid позиция.

import { LUDO_COLORS, ludoCellId, type LudoCell, type LudoCellId, type LudoColor } from '../ludoTypes'
import {
  LUDO_TRACK_LENGTH,
  LUDO_FINISH_LENGTH,
  LUDO_HOME_SLOTS,
  LUDO_START_INDEX,
  LUDO_SAFE_TRACK_INDICES,
  ludoAdvanceTrackIndex,
} from '../ludoGeometryConstants'

export { LUDO_TRACK_LENGTH, LUDO_FINISH_LENGTH, LUDO_HOME_SLOTS, ludoAdvanceTrackIndex }

// Клетката непосредствено преди собствения старт (т.е. входа към finish
// коридора) — последната track клетка, преди пионката да завие навътре.
const ENTRY_INDEX: Record<LudoColor, number> = {
  red: (LUDO_START_INDEX.red + LUDO_TRACK_LENGTH - 1) % LUDO_TRACK_LENGTH,
  blue: (LUDO_START_INDEX.blue + LUDO_TRACK_LENGTH - 1) % LUDO_TRACK_LENGTH,
  yellow: (LUDO_START_INDEX.yellow + LUDO_TRACK_LENGTH - 1) % LUDO_TRACK_LENGTH,
  green: (LUDO_START_INDEX.green + LUDO_TRACK_LENGTH - 1) % LUDO_TRACK_LENGTH,
}

export function ludoStartTrackIndex(color: LudoColor): number {
  return LUDO_START_INDEX[color]
}

export function ludoEntryTrackIndex(color: LudoColor): number {
  return ENTRY_INDEX[color]
}

// Клетката НЕПОСРЕДСТВЕНО ПРЕДИ входа на СОБСТВЕНИЯ finish коридор (виж
// task-а — референтна снимка с черни X маркери): последната track клетка,
// от която пионката на дадения цвят завива навътре към собствения си
// finish lane, СЛЕД пълен оборот на дъската (56 клетки) — геометрично
// РАЗЛИЧНА клетка от ENTRY_INDEX по-горе (която е просто "start - 1",
// съседна на СЛЕДВАЩИЯ цвят по ред, не на собствения finish — но е
// неизползвана извън дефиницията си, виж ludoEntryTrackIndex). Формулата
// (START_INDEX - 1 + LENGTH) % LENGTH е изведена и потвърдена директно
// спрямо TRACK_GRID/FINISH_GRID координатите тук: за всеки цвят тази клетка
// е grid-съседна на FINISH_GRID[color][0] (първата finish клетка),
// потвърдено симетрично за и четирите рамена (red: track-55=(0,7) до
// finish[0]=(1,7); blue: track-13=(7,0) до finish[0]=(7,1); yellow:
// track-27=(14,7) до finish[0]=(13,7); green: track-41=(7,14) до
// finish[0]=(7,13)). Офсетът е "-1", не "-2" — калибриран спрямо start
// клетката, съвпадаща с геометричния ъгъл на рамото (виж LUDO_START_INDEX
// doc коментара в ludoGeometryConstants.ts); при по-стар "start = ъгъл + 1"
// вариант офсетът беше "-2" спрямо СЪЩАТА физическа клетка.
const FINISH_ENTRY_INDEX: Record<LudoColor, number> = {
  red: (LUDO_START_INDEX.red + LUDO_TRACK_LENGTH - 1) % LUDO_TRACK_LENGTH,
  blue: (LUDO_START_INDEX.blue + LUDO_TRACK_LENGTH - 1) % LUDO_TRACK_LENGTH,
  yellow: (LUDO_START_INDEX.yellow + LUDO_TRACK_LENGTH - 1) % LUDO_TRACK_LENGTH,
  green: (LUDO_START_INDEX.green + LUDO_TRACK_LENGTH - 1) % LUDO_TRACK_LENGTH,
}

export function ludoFinishEntryTrackIndex(color: LudoColor): number {
  return FINISH_ENTRY_INDEX[color]
}

export interface LudoGridPoint {
  col: number
  row: number
}

// 15x15 grid, 0-indexed. Изградено ръчно като класическия кръстовиден
// "Не се сърди човече" layout: хоризонтално и вертикално рамо, всяко 3
// клетки широко, плюс диагонални finish коридори към центъра.
const TRACK_GRID: LudoGridPoint[] = buildTrackGrid()

function buildTrackGrid(): LudoGridPoint[] {
  const points: LudoGridPoint[] = []

  // Track тръгва от red старт (col 0, row 6) и обикаля по часовниковата
  // стрелка около кръста, връщайки се обратно към red-а. Изграждаме го като
  // четири еднакви 14-клетъчни рамена (red -> blue -> yellow -> green),
  // всяко завъртяно на 90° спрямо предишното. Рамото е симетрично спрямо
  // центъра (row 6 горен ръб / row 8 долен ръб на 3x3 центъра при 0-indexed
  // cols/rows 6-8).
  //
  // Клетка (5,5) е диагоналният завой между хоризонталния сегмент (край на
  // row 6) и вертикалния сегмент (начало на col 6) — реално поле за
  // стъпване, част от непрекъснатата обиколка, НЕ декоративна клетка отвън
  // маршрута (виж корекция: първоначално тези 4 ъглови клетки бяха отделен
  // "corner" тип, прескачан от движението — обединени тук в самия track,
  // защото не съществува production engine зависимост, която да го забранява).
  const arm: LudoGridPoint[] = [
    { col: 0, row: 6 }, { col: 1, row: 6 }, { col: 2, row: 6 }, { col: 3, row: 6 }, { col: 4, row: 6 }, { col: 5, row: 6 },
    { col: 5, row: 5 },
    { col: 6, row: 5 }, { col: 6, row: 4 }, { col: 6, row: 3 }, { col: 6, row: 2 }, { col: 6, row: 1 }, { col: 6, row: 0 },
    { col: 7, row: 0 },
  ]

  // Ротация на цялото рамо на 90° по часовниковата стрелка около центъра
  // (col 7, row 7) на 15x15 grid, за да получим следващото рамо.
  function rotate90(p: LudoGridPoint): LudoGridPoint {
    const cx = 7
    const cy = 7
    const dx = p.col - cx
    const dy = p.row - cy
    return { col: cx - dy, row: cy + dx }
  }

  let current = arm
  for (let armIndex = 0; armIndex < 4; armIndex += 1) {
    points.push(...current)
    current = current.map(rotate90)
  }

  return points
}

const FINISH_GRID: Record<LudoColor, LudoGridPoint[]> = buildFinishGrids()

function buildFinishGrids(): Record<LudoColor, LudoGridPoint[]> {
  const redFinish: LudoGridPoint[] = [
    { col: 1, row: 7 }, { col: 2, row: 7 }, { col: 3, row: 7 }, { col: 4, row: 7 }, { col: 5, row: 7 }, { col: 6, row: 7 },
  ]

  function rotate90(p: LudoGridPoint): LudoGridPoint {
    const cx = 7
    const cy = 7
    const dx = p.col - cx
    const dy = p.row - cy
    return { col: cx - dy, row: cy + dx }
  }

  const result = {} as Record<LudoColor, LudoGridPoint[]>
  let current = redFinish
  const order: LudoColor[] = ['red', 'blue', 'yellow', 'green']
  for (const color of order) {
    result[color] = current
    current = current.map(rotate90)
  }
  return result
}

const HOME_GRID: Record<LudoColor, LudoGridPoint[]> = {
  red: [{ col: 1, row: 1 }, { col: 3, row: 1 }, { col: 1, row: 3 }, { col: 3, row: 3 }],
  blue: [{ col: 11, row: 1 }, { col: 13, row: 1 }, { col: 11, row: 3 }, { col: 13, row: 3 }],
  yellow: [{ col: 11, row: 11 }, { col: 13, row: 11 }, { col: 11, row: 13 }, { col: 13, row: 13 }],
  green: [{ col: 1, row: 11 }, { col: 3, row: 11 }, { col: 1, row: 13 }, { col: 3, row: 13 }],
}

export function ludoGridPointForCell(cell: LudoCell): LudoGridPoint {
  if (cell.kind === 'track') {
    const point = TRACK_GRID[cell.index]
    if (!point) throw new Error(`Invalid track index: ${cell.index}`)
    return point
  }
  if (cell.kind === 'home') {
    const point = HOME_GRID[cell.color][cell.slot]
    if (!point) throw new Error(`Invalid home slot: ${cell.color}-${cell.slot}`)
    return point
  }
  const point = FINISH_GRID[cell.color][cell.slot]
  if (!point) throw new Error(`Invalid finish slot: ${cell.color}-${cell.slot}`)
  return point
}

export function ludoGridPointForCellId(cellId: LudoCellId): LudoGridPoint {
  return ludoGridPointForCell(parseLudoCellId(cellId))
}

export function parseLudoCellId(cellId: LudoCellId): LudoCell {
  if (cellId.startsWith('track-')) {
    return { kind: 'track', index: Number(cellId.slice('track-'.length)) }
  }
  if (cellId.startsWith('home-')) {
    const rest = cellId.slice('home-'.length)
    const [color, slot] = rest.split('-')
    return { kind: 'home', color: color as LudoColor, slot: Number(slot) }
  }
  if (cellId.startsWith('finish-')) {
    const rest = cellId.slice('finish-'.length)
    const [color, slot] = rest.split('-')
    return { kind: 'finish', color: color as LudoColor, slot: Number(slot) }
  }
  throw new Error(`Unknown cell id: ${cellId}`)
}

// Всички адресируеми клетки от дъската — за render на празния board layout.
export function ludoAllCellIds(): LudoCellId[] {
  const ids: LudoCellId[] = []
  for (let i = 0; i < LUDO_TRACK_LENGTH; i += 1) {
    ids.push(ludoCellId({ kind: 'track', index: i }))
  }
  for (const color of LUDO_COLORS) {
    for (let slot = 0; slot < LUDO_HOME_SLOTS; slot += 1) {
      ids.push(ludoCellId({ kind: 'home', color, slot }))
    }
    for (let slot = 0; slot < LUDO_FINISH_LENGTH; slot += 1) {
      ids.push(ludoCellId({ kind: 'finish', color, slot }))
    }
  }
  return ids
}

// Клетките, отбелязващи собствения старт на всеки цвят (за visual star
// маркер на дъската), извлечени директно от LUDO_START_INDEX за консистентност.
export function ludoStartCellIds(): Partial<Record<LudoColor, LudoCellId>> {
  const result: Partial<Record<LudoColor, LudoCellId>> = {}
  for (const color of LUDO_COLORS) {
    result[color] = ludoCellId({ kind: 'track', index: LUDO_START_INDEX[color] })
  }
  return result
}

// Presentation wrapper над canonical LUDO_SAFE_TRACK_INDICES
// (../ludoGeometryConstants.ts — ЕДИНСТВЕНИЯТ source of truth, споделен и с
// engine/ludoEngineLegalMoves.ts за capture eligibility, виж fix — bug
// report: opponent piece on a star cell was incorrectly captured). Тук само
// превръщаме track индексите в cell id-та за рендиране — никакво отделно
// изчисление/дублиране на offset-а.
export function ludoSafeCellIds(): LudoCellId[] {
  return LUDO_SAFE_TRACK_INDICES.map((index) => ludoCellId({ kind: 'track', index }))
}
