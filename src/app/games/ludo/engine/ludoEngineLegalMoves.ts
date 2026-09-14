// Pure legal-move изчисление за engine-а — логически идентично на
// board/computeLudoLegalMoves.ts (target = (trackIndex + dice) % LUDO_TRACK_LENGTH,
// capture само при точно съвпадение на target-а), но работи с
// LudoGamePiece/LudoPiecePosition вместо string cell id-та. Умишлено
// МИНИМАЛНО за Phase 1 (виж task-а): само пионки вече на track-а. Изкарване
// от home, finish lane, exact-finish, extra ход при 6 — НЕ тук.

import { ludoEngineAdvanceTrackIndex } from './ludoEngineGeometry'
import type { LudoColor, LudoDiceValue, LudoGamePiece, LudoLegalMove } from './ludoEngineTypes'

export function computeLudoEngineLegalMoves(
  pieces: readonly LudoGamePiece[],
  activeColor: LudoColor,
  diceValue: LudoDiceValue,
): LudoLegalMove[] {
  const moves: LudoLegalMove[] = []

  for (const piece of pieces) {
    if (piece.color !== activeColor) continue
    if (piece.position.kind !== 'track') continue

    const targetIndex = ludoEngineAdvanceTrackIndex(piece.position.trackIndex, diceValue)

    // Capture само ако противникова пионка стои точно на изчисления target
    // (не някъде по маршрута преди него) — виж computeLudoLegalMoves.ts.
    const isCapture = pieces.some(
      (other) =>
        other.color !== activeColor &&
        other.position.kind === 'track' &&
        other.position.trackIndex === targetIndex,
    )

    moves.push({
      color: piece.color,
      slot: piece.slot,
      targetPosition: { kind: 'track', trackIndex: targetIndex },
      isCapture,
    })
  }

  return moves
}
