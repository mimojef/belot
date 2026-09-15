// Track дължина/start indices за engine-а — import-нати от единствения
// source of truth (../ludoGeometryConstants.ts), споделен и с
// board/ludoBoardGeometry.ts (виж Phase 2 task-а т.3: преди тази промяна
// двете места дублираха '56'/'0,14,28,42' независимо едно от друго).
// ludoGeometryConstants.ts е нарочно PURE (нулева DOM/browser/ludoTypes.ts
// зависимост), затова import-ването му тук не нарушава engine изолацията.

import { LUDO_TRACK_LENGTH, LUDO_FINISH_LENGTH, LUDO_START_INDEX, ludoAdvanceTrackIndex } from '../ludoGeometryConstants'
import type { LudoColor } from './ludoEngineTypes'

export const LUDO_ENGINE_TRACK_LENGTH = LUDO_TRACK_LENGTH
export const LUDO_ENGINE_FINISH_LENGTH = LUDO_FINISH_LENGTH
export const LUDO_ENGINE_START_INDEX: Record<LudoColor, number> = LUDO_START_INDEX
export const ludoEngineAdvanceTrackIndex = ludoAdvanceTrackIndex

// Canonical progress model (Phase 3B, виж task-а т.2 "CANONICAL PROGRESS
// MODEL") — колко track-стъпки е изминала дадена пионка СПРЯМО СОБСТВЕНИЯ ѝ
// start, независимо от absolute track index/wrap. absolute track index сам
// по себе си НЕ стига да се различи "първа обиколка" от "точно преди finish"
// (напр. red на absolute track-0 може да е stepsFromStart=55, на прага на
// finish, докато blue на СЪЩИЯ absolute track-0 е stepsFromStart=41,
// насред пътя) — затова всяко legal-move/route изчисление минава ПЪРВО през
// тази функция, никога directно през суровия trackIndex delta.
export function ludoEngineStepsFromStart(color: LudoColor, trackIndex: number): number {
  const startIndex = LUDO_ENGINE_START_INDEX[color]
  return (trackIndex - startIndex + LUDO_TRACK_LENGTH) % LUDO_TRACK_LENGTH
}
