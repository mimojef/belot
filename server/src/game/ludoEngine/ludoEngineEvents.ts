// Events, които reducer-ът връща заедно с новия state — UI слоят реагира на
// тях (анимации, звук), но engine-ът НИКОГА не чака завършването на
// анимация. Минимален event foundation, достатъчен за prototype integration,
// не пълен gameplay event set.

import type { LudoColor, LudoLegalMove, LudoPieceId, LudoPiecePosition, LudoPieceSlot } from './ludoEngineTypes.js'

export type LudoEngineEvent =
  | { type: 'dice_accepted'; color: LudoColor; value: number }
  | { type: 'legal_moves_available'; color: LudoColor; moves: readonly LudoLegalMove[] }
  | {
      // Phase 3B (виж task-а т.2/т.12): fromPosition/toPosition вместо
      // fromTrackIndex/toTrackIndex numbers — движение вече покрива home->
      // track/track->finish/finish->finish преходи, не само track->track,
      // затова event-ът носи пълната discriminated union позиция, не просто
      // absolute track числа (които нямат смисъл за home/finish).
      type: 'piece_moved'
      color: LudoColor
      slot: LudoPieceSlot
      fromPosition: LudoPiecePosition
      toPosition: LudoPiecePosition
    }
  // capturedPieceIds носи directно canonical id-та на ВСИЧКИ captured
  // pieces (напр. "blue-1", "blue-2") — UI/controller НЕ трябва да извежда
  // victim identity от capturedSlots + отделен цвят, DOM queries, или
  // positional heuristics (виж Phase 2 task-а т.2: engine state вече знае
  // точно кои real pieces са captured, event-ът просто го казва директно).
  // Victims могат да бъдат от повече от един opponent цвят едновременно
  // (напр. capture на клетка, споделена временно от двама различни
  // противника) — capturedPieceIds покрива и този случай коректно, за
  // разлика от старото capturedColor+capturedSlots, което приемаше един-
  // единствен victim цвят.
  | { type: 'pieces_captured'; capturedPieceIds: readonly LudoPieceId[] }
  | { type: 'turn_advanced'; previousColor: LudoColor; nextColor: LudoColor }
  | { type: 'bot_takeover_started'; color: LudoColor }
  | { type: 'human_control_resumed'; color: LudoColor }
