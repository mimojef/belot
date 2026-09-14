// Bot move selection policy — НЕ AI, само детерминистичен избор измежду
// вече изчислените от engine-а legal moves (виж task-а т.17: "bot НЕ трябва
// да дублира game rules", MOVE_REQUESTED от bot минава през СЪЩАТА engine
// валидация). Pure функция: legal moves -> избран move, без side effects.

import type { LudoLegalMove } from '../engine/ludoEngineTypes'

// Deterministic ред: capture moves първи (леко по-смислен приоритет от
// "просто първия в масива" — предпочита ход, който удря противник, когато
// има такъв избор), после първия normal move по slot ред. Пионките вече
// идват от computeLudoEngineLegalMoves в stable по-piece ред, затова "first
// capture, else first move" е напълно детерминистично без допълнителен sort.
export function pickLudoBotMove(legalMoves: readonly LudoLegalMove[]): LudoLegalMove | null {
  if (legalMoves.length === 0) return null
  const captureMove = legalMoves.find((move) => move.isCapture)
  return captureMove ?? legalMoves[0]!
}
