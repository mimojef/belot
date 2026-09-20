// PRESENTATION-ONLY capture sequencing helpers (виж task-а: "victim не
// трябва да изчезва предварително"). Engine-ът resolve-ва MOVE_REQUESTED
// МОМЕНТАЛНО — captured victims вече са в home-а си в canonical
// engineState.pieces, преди attacker-ът дори да е започнал route
// анимацията визуално. Тези pure helpers изчисляват presentation overrides,
// които "закачат" victim-ите обратно на target клетката, докато
// controller-ът (createLudoFlowController.ts) анимира attacker route-а +
// impact момента — недокосвайки canonical engine state по никакъв начин.
//
// Pure — не четат DOM/Date.now()/random, само трансформират маси/state.

import type { LudoCellId, LudoPiece, LudoPieceId } from '../ludoTypes'

// Presentation buffer: pieceId -> клетката, на която ТРЯБВА да изглежда, че
// стои, докато override-ът е активен (target клетката, преди victim-ът
// реално да е "отлетял" в home-а си canonical-но).
export type LudoCaptureVictimOverrides = ReadonlyMap<LudoPieceId, LudoCellId>

export function createLudoCaptureVictimOverrides(
  capturedPieceIds: readonly LudoPieceId[],
  targetCellId: LudoCellId,
  previous: LudoCaptureVictimOverrides = new Map(),
): LudoCaptureVictimOverrides {
  const next = new Map(previous)
  for (const victimId of capturedPieceIds) next.set(victimId, targetCellId)
  return next
}

export function clearLudoCaptureVictimOverrides(
  capturedPieceIds: readonly LudoPieceId[],
  previous: LudoCaptureVictimOverrides,
): LudoCaptureVictimOverrides {
  const next = new Map(previous)
  for (const victimId of capturedPieceIds) next.delete(victimId)
  return next
}

// Прилага И attacker route override-а (movingPieceOverride), И victim
// capture override-ите върху canonical adapted UI pieces — точно логиката,
// която createLudoFlowController.ts::currentUiPieces() ползва за render.
// Изнесена тук като pure, тестваема функция (виж checkLudoCapturePresentation.ts
// C1-C8), вместо да остане inline private closure логика.
export function applyLudoPresentationOverrides(
  uiPieces: readonly LudoPiece[],
  movingPieceOverride: { pieceId: LudoPieceId; cellId: LudoCellId } | null,
  captureVictimOverrides: LudoCaptureVictimOverrides,
): LudoPiece[] {
  if (!movingPieceOverride && captureVictimOverrides.size === 0) return [...uiPieces]
  return uiPieces.map((p) => {
    if (movingPieceOverride && p.id === movingPieceOverride.pieceId) {
      return { ...p, cell: movingPieceOverride.cellId }
    }
    const victimCellId = captureVictimOverrides.get(p.id)
    if (victimCellId) return { ...p, cell: victimCellId }
    return p
  })
}
