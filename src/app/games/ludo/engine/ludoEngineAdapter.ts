// Adapter boundary между pure engine state (LudoGamePiece/LudoPiecePosition)
// и текущия string-based renderer contract (LudoPiece.cell: "track-17",
// "home-red-2", LudoLegalMove.targetCell). Renderer-ът НЕ е пренаписан за
// discriminated union — малък adapter вместо massive rewrite (виж task-а
// т.4/т.12). Живее извън engine/ директорията, тъй като внасят зависимост
// от string cell id формата (ludoTypes.ts), която engine-ът съзнателно
// няма.

import { ludoCellId } from '../ludoTypes'
import type { LudoColor as UiLudoColor, LudoLegalMove as UiLegalMove, LudoPiece as UiPiece, LudoPieceId } from '../ludoTypes'
import type { LudoGamePiece, LudoLegalMove as EngineLegalMove, LudoPiecePosition, LudoPieceSlot } from './ludoEngineTypes'
import { ludoGamePieceId } from './ludoEngineTypes'

export function ludoEnginePositionToCellId(position: LudoPiecePosition, color: UiLudoColor): string {
  if (position.kind === 'track') return ludoCellId({ kind: 'track', index: position.trackIndex })
  if (position.kind === 'home') return ludoCellId({ kind: 'home', color, slot: position.slot })
  return ludoCellId({ kind: 'finish', color, slot: position.finishIndex })
}

export function ludoEnginePieceToUiPiece(piece: LudoGamePiece): UiPiece {
  return {
    id: ludoGamePieceId(piece) as LudoPieceId,
    color: piece.color,
    cell: ludoEnginePositionToCellId(piece.position, piece.color),
  }
}

export function ludoEnginePiecesToUiPieces(pieces: readonly LudoGamePiece[]): UiPiece[] {
  return pieces.map(ludoEnginePieceToUiPiece)
}

export function ludoEngineLegalMoveToUiMove(move: EngineLegalMove): UiLegalMove {
  return {
    pieceId: ludoGamePieceId(move) as LudoPieceId,
    targetCell: ludoEnginePositionToCellId(move.targetPosition, move.color),
    type: move.isCapture ? 'capture' : 'normal',
  }
}

export function ludoEngineLegalMovesToUiMoves(moves: readonly EngineLegalMove[]): UiLegalMove[] {
  return moves.map(ludoEngineLegalMoveToUiMove)
}

// Обратна посока (UI piece id "red-2" -> engine slot) — нужна на
// controller-а, за да dispatch-не MOVE_REQUESTED с правилния slot номер от
// click handler-а, който получава LudoPieceId от DOM атрибута.
export function ludoUiPieceIdToSlot(pieceId: LudoPieceId): LudoPieceSlot {
  const lastDash = pieceId.lastIndexOf('-')
  return Number(pieceId.slice(lastDash + 1)) as LudoPieceSlot
}
