// Action contract за reduceLudoGame — минимален набор за Phase 1 (виж
// task-а т.6). Всеки player-originated action носи playerId (тук: color,
// тъй като цветът вече е canonical player identity в тази игра) и
// expectedTurnVersion — защита срещу stale actions (виж reduceLudoGame).
// Dice резултатът е INPUT към engine-а (ROLL_RESOLVED.value), НЕ engine-ът
// сам хвърля зара — по-късно сървърът ще е authoritative за RNG.

import type { LudoColor, LudoDiceValue, LudoPieceSlot } from './ludoEngineTypes.js'

interface LudoPlayerOriginatedAction {
  color: LudoColor
  expectedTurnVersion: number
}

export type LudoEngineAction =
  | ({ type: 'ROLL_STARTED' } & LudoPlayerOriginatedAction)
  | ({ type: 'ROLL_RESOLVED'; value: LudoDiceValue } & LudoPlayerOriginatedAction)
  | ({ type: 'MOVE_REQUESTED'; slot: LudoPieceSlot } & LudoPlayerOriginatedAction)
  | ({ type: 'TURN_ADVANCED' } & LudoPlayerOriginatedAction)
