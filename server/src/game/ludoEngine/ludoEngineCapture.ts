// Pure capture resolution за engine-а — логически идентично на
// board/resolveLudoCapture.ts (всяка victim се връща на СВОЯ ПОСТОЯНЕН home
// slot, кодиран в собствения ѝ slot номер — не "count на заети slots",
// виж audit-а там за пълния разбор на защо count-моделът колизира), но
// PURE: не мутира входния масив, връща нов.

import type { LudoColor, LudoGamePiece } from './ludoEngineTypes.js'
import { ludoIsOwnStartTrackIndex } from './ludoGeometryConstants.js'

// Всички пионки на target позицията, които НЕ са от цвета на пристигащата
// пионка — не само първата намерена (stack от 2-4 противникови пионки на
// target-а -> всички биват уловени). Собствените пионки на moving color
// НЕ се връщат тук — те остават на target-а и образуват/растат stack.
//
// OWNERSHIP-AWARE own-start protection (виж isCapture коментара в
// ludoEngineLegalMoves.ts) — victim, чийто target track index Е нейният
// собствен start (ludoIsOwnStartTrackIndex(victim.color, targetTrackIndex)),
// е protected и се изключва от victims списъка ТУК също, за консистентност
// с isCapture флага, изчислен upstream. Ако isCapture===true само заради
// друга, unprotected opponent пионка на same target (mixed stack), тази
// protected пионка пак трябва да остане на клетката — не бива да бъде
// иззета заедно с останалите просто защото handleMoveRequested вика тази
// функция unconditionally при isCapture===true.
export function findLudoEngineCaptureVictims(
  pieces: readonly LudoGamePiece[],
  targetTrackIndex: number,
  capturingColor: LudoColor,
): LudoGamePiece[] {
  return pieces.filter(
    (piece) =>
      piece.color !== capturingColor &&
      piece.position.kind === 'track' &&
      piece.position.trackIndex === targetTrackIndex &&
      !ludoIsOwnStartTrackIndex(piece.color, targetTrackIndex),
  )
}

// Връща НОВ pieces масив, в който victim-ите (идентифицирани по
// color+slot) са преместени на собствения си home slot. Входният масив
// НЕ се мутира — reducer purity (виж task-а т.11.K).
export function applyLudoEngineCaptureToHome(
  pieces: readonly LudoGamePiece[],
  victims: readonly LudoGamePiece[],
): LudoGamePiece[] {
  const victimKeys = new Set(victims.map((v) => `${v.color}-${v.slot}`))
  return pieces.map((piece) => {
    const key = `${piece.color}-${piece.slot}`
    if (!victimKeys.has(key)) return piece
    return { ...piece, position: { kind: 'home', slot: piece.slot } }
  })
}
