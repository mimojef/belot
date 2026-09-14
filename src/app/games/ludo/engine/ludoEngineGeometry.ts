// Track дължина/start indices за engine-а — import-нати от единствения
// source of truth (../ludoGeometryConstants.ts), споделен и с
// board/ludoBoardGeometry.ts (виж Phase 2 task-а т.3: преди тази промяна
// двете места дублираха '56'/'0,14,28,42' независимо едно от друго).
// ludoGeometryConstants.ts е нарочно PURE (нулева DOM/browser/ludoTypes.ts
// зависимост), затова import-ването му тук не нарушава engine изолацията.

import { LUDO_TRACK_LENGTH, LUDO_START_INDEX, ludoAdvanceTrackIndex } from '../ludoGeometryConstants'
import type { LudoColor } from './ludoEngineTypes'

export const LUDO_ENGINE_TRACK_LENGTH = LUDO_TRACK_LENGTH
export const LUDO_ENGINE_START_INDEX: Record<LudoColor, number> = LUDO_START_INDEX
export const ludoEngineAdvanceTrackIndex = ludoAdvanceTrackIndex
