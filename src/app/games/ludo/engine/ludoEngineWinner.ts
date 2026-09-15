// Winner FOUNDATION (Phase 3B, виж task-а т.16) — чист detection helper,
// НЕ game-over UI, НЕ ranking, НЕ multiplayer finish handling. Само
// deterministic отговор на "дали дадения цвят е прибрал всичките си 4
// пионки". Изрично extracted в собствен файл (не inline в reducer-а), за да
// остане ясно "foundation, не wired в turn flow-а още" — никой reducer
// handler не го извиква тук.

import type { LudoColor, LudoGamePiece } from './ludoEngineTypes'
import { LUDO_ENGINE_FINISH_LENGTH } from './ludoEngineGeometry'

const LUDO_FINISHED_PIECE_COUNT = 4

export function isLudoColorFinished(pieces: readonly LudoGamePiece[], color: LudoColor): boolean {
  const ownPieces = pieces.filter((piece) => piece.color === color)
  if (ownPieces.length !== LUDO_FINISHED_PIECE_COUNT) return false
  return ownPieces.every(
    (piece) => piece.position.kind === 'finish' && piece.position.finishIndex === LUDO_ENGINE_FINISH_LENGTH - 1,
  )
}
