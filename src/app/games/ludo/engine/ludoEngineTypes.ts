// Canonical game state за Ludo rule engine — PURE TypeScript, никакъв DOM/
// browser/animation/random. По-късно ще се използва и от server-side код,
// затова тук НЕ живее нищо presentation-специфично (име, аватар, screen
// quadrant, анимационен timing).
//
// Ясно разделение (виж task-а):
//   GAME IDENTITY / RULE STATE  -> живее тук (LudoGameState)
//   PRESENTATION                -> живее в controller/render слоя, НЕ тук
//
// Цветът е canonical game property — engine-ът никога не знае "кой цвят е
// долу вляво на екрана". Player identity не е обвързан с screen quadrant.

export type LudoColor = 'red' | 'blue' | 'green' | 'yellow'

export const LUDO_COLORS: readonly LudoColor[] = ['red', 'blue', 'green', 'yellow']

// Discriminated union за позицията на пионка — вместо string parsing
// ("track-17", "home-red-2"). Engine-ът борави изцяло с тези структури;
// сериализация към/от string cell id остава в adapter слоя (виж
// ludoEngineAdapter.ts), само за текущия renderer, който още очаква
// string-и.
export type LudoPiecePosition =
  | { kind: 'home'; slot: number }
  | { kind: 'track'; trackIndex: number }
  | { kind: 'finish'; finishIndex: number }

// Постоянният home slot (0-3) на пионка е част от нейния identity — никога
// не се преизчислява от "count заети слотове" (виж audit-а в
// resolveLudoCapture.ts за защо count-моделът е грешен и колизионен).
export type LudoPieceSlot = 0 | 1 | 2 | 3

// Canonical piece identity — `${color}-${slot}`, идентична форма на UI
// LudoPieceId (ludoTypes.ts), но дефинирана независимо тук: engine-ът не
// import-ва от ludoTypes.ts (renderer-специфичен модул, виж adapter
// boundary-я в ludoEngineAdapter.ts).
export type LudoPieceId = `${LudoColor}-${LudoPieceSlot}`

export interface LudoGamePiece {
  color: LudoColor
  slot: LudoPieceSlot
  position: LudoPiecePosition
}

export function ludoGamePieceId(piece: Pick<LudoGamePiece, 'color' | 'slot'>): LudoPieceId {
  return `${piece.color}-${piece.slot}`
}

// Явен turn-phase модел — преходите се контролират ИЗЦЯЛО от reducer-а, не
// от DOM callback-и. Минималният набор за Phase 1 (виж task-а) — НЕ добавяй
// нови фази без причина.
export type LudoTurnPhase =
  | 'waiting_for_roll'
  | 'rolling'
  | 'awaiting_move_selection'
  | 'move_resolving'
  | 'turn_complete'

export type LudoGameStatus = 'in_progress'

export type LudoDiceValue = 1 | 2 | 3 | 4 | 5 | 6

export interface LudoLegalMove {
  color: LudoColor
  slot: LudoPieceSlot
  targetPosition: LudoPiecePosition
  isCapture: boolean
}

// GAME IDENTITY / RULE STATE. Забележи какво умишлено ОТСЪСТВА тук:
// displayName, avatarUrl, isBot, UI perspective/quadrant, animation state —
// всичко това е presentation и живее извън engine-а (виж task-а т.3).
export interface LudoGameState {
  // Turn order е фиксиран canonical ред на цветовете (не screen позиция).
  turnOrder: readonly LudoColor[]
  activeColor: LudoColor
  turnPhase: LudoTurnPhase
  diceValue: LudoDiceValue | null
  legalMoves: readonly LudoLegalMove[]
  pieces: readonly LudoGamePiece[]
  status: LudoGameStatus
  // Increment-ва се при всяка успешна мутация — защита срещу stale actions
  // (виж reduceLudoGame). Не е "turn number"; расте и в рамките на един ход.
  turnVersion: number
}
