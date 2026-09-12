// Изчислява legal moves за mock prototype-а — заменя старите hardcoded
// примери в ludoMockState.ts (виж audit-а: legalMoves бяха фиксиран списък,
// напълно несвързан с показания зар, което водеше до capture highlight на
// разстояние 5 клетки, докато зарът показваше 6).
//
// Умишлено МИНИМАЛНО: покрива само пионки, които вече са на track-а.
// Изкарване от home, finish lane завой, exact-finish и extra ход при 6 НЕ
// са тук — реални Ludo правила, ще дойдат отделно с истинския engine. Тук
// целта е единствено mock UI-ят да е математически консистентен с dice
// стойността, не пълна валидация на ходове.

import { parseLudoCellId, ludoAdvanceTrackIndex } from './ludoBoardGeometry'
import { ludoCellId } from '../ludoTypes'
import type { LudoColor, LudoLegalMove, LudoPiece } from '../ludoTypes'
import type { LudoDiceFace } from '../dice/ludoDiceState'

// targetTrackIndex = (currentTrackIndex + diceValue) % LUDO_TRACK_LENGTH
// (ludoAdvanceTrackIndex прави точно тази модулна аритметика — вижда се и
// в buildLudoMoveRoute, единственото място, което вече я ползваше).
export function computeLudoLegalMoves(
  pieces: LudoPiece[],
  activeColor: LudoColor,
  diceValue: LudoDiceFace,
): LudoLegalMove[] {
  const moves: LudoLegalMove[] = []

  for (const piece of pieces) {
    if (piece.color !== activeColor) continue

    const cell = parseLudoCellId(piece.cell)
    if (cell.kind !== 'track') continue

    const targetIndex = ludoAdvanceTrackIndex(cell.index, diceValue)
    const targetCell = ludoCellId({ kind: 'track', index: targetIndex })

    // Capture само ако противникова пионка стои точно на изчисления target
    // (не някъде по маршрута преди него).
    const isOpponentOnTarget = pieces.some(
      (other) => other.color !== activeColor && other.cell === targetCell,
    )

    moves.push({
      pieceId: piece.id,
      targetCell,
      type: isOpponentOnTarget ? 'capture' : 'normal',
    })
  }

  return moves
}
