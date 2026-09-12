// Споделени типове за Ludo visual prototype. Изцяло frontend/mock — няма
// връзка с реален game engine или сървър.

export type LudoColor = 'red' | 'blue' | 'green' | 'yellow'

export const LUDO_COLORS: readonly LudoColor[] = ['red', 'blue', 'green', 'yellow']

// yellow: второ фино тониране (виж task-а) — #f7dd6b беше прекалено светло/
// пастелно; новото е по-тъмно, по-наситено златисто-жълто (hue ~44°, ясно
// разграничено от backdrop-а BOARD_BACKDROP #eea458, чийто hue е ~30°
// оранжево), без да се доближава до оранжев тон. red/blue/green и
// backdrop-ът са НЕДОКОСНАТИ.
export const LUDO_COLOR_HEX: Record<LudoColor, string> = {
  red: '#e0473e',
  blue: '#3b82f6',
  green: '#22a559',
  yellow: '#e6b91f',
}

export const LUDO_COLOR_LABEL: Record<LudoColor, string> = {
  red: 'Червен',
  blue: 'Син',
  green: 'Зелен',
  yellow: 'Жълт',
}

// Адресируема клетка от дъската — track (общото трасе, 0-55, по часовниковата
// стрелка — включва и 4-те диагонални ъглови клетки на завоите, реални
// полета за стъпване, не декоративни), home (база преди старт), или finish
// (финален коридор на цвета).
export type LudoTrackCell = { kind: 'track'; index: number }
export type LudoHomeCell = { kind: 'home'; color: LudoColor; slot: number }
export type LudoFinishCell = { kind: 'finish'; color: LudoColor; slot: number }
export type LudoCell = LudoTrackCell | LudoHomeCell | LudoFinishCell

export type LudoCellId = string // напр. "track-31", "home-red-0", "finish-red-3"

export function ludoCellId(cell: LudoCell): LudoCellId {
  if (cell.kind === 'track') return `track-${cell.index}`
  return `${cell.kind}-${cell.color}-${cell.slot}`
}

export type LudoPieceId = `${LudoColor}-${0 | 1 | 2 | 3}`

export interface LudoPiece {
  id: LudoPieceId
  color: LudoColor
  cell: LudoCellId
}

export type LudoMoveType = 'normal' | 'capture'

export interface LudoLegalMove {
  pieceId: LudoPieceId
  targetCell: LudoCellId
  type: LudoMoveType
}

export interface LudoPlayer {
  color: LudoColor
  name: string
  avatarUrl: string | null
  isBot: boolean
}
