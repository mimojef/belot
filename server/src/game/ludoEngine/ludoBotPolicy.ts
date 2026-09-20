import type { LudoLegalMove } from './ludoEngineTypes.js'

export function pickLudoBotMove(legalMoves: readonly LudoLegalMove[]): LudoLegalMove | null {
  if (legalMoves.length === 0) return null
  return legalMoves.find((move) => move.isCapture) ?? legalMoves[0]!
}
