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
  // Explicit "Изход" forfeit (виж task-а "Explicit Изход от STARTED match") —
  // НЕ разширява LudoPlayerOriginatedAction: за разлика от всички други
  // actions, forfeit е валиден ЗА КОЙТО И ДА Е participant color, независимо
  // дали в момента е активен (state.activeColor) — не е "твой ред" action.
  // Няма expectedTurnVersion staleness guard по същата причина (не е turn-
  // gated); idempotency ("вече е forfeit-нал") се проверява в самия reducer
  // (state.leftColors.includes(color) -> rejected), огледално на runtime-
  // level идемпотентността в ludoEconomyStore.ts за stake debit/payout.
  | { type: 'PLAYER_FORFEITED'; color: LudoColor }
