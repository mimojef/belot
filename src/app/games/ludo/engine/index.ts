// Публичен API на pure Ludo rule engine слоя — единствената входна точка,
// която controller/adapter кодът трябва да import-ва. Pure TypeScript,
// никакъв DOM/browser/animation/random код (виж отделните модули за детайли).

export * from './ludoEngineTypes'
export * from './ludoEngineActions'
export * from './ludoEngineEvents'
export { reduceLudoGame, type LudoReduceResult } from './ludoEngineReducer'
export { createLudoEngineInitialState, createLudoEngineInitialPieces } from './ludoEngineState'
export { computeLudoEngineLegalMoves } from './ludoEngineLegalMoves'
export { findLudoEngineCaptureVictims, applyLudoEngineCaptureToHome } from './ludoEngineCapture'
export { LUDO_ENGINE_TRACK_LENGTH, LUDO_ENGINE_START_INDEX, ludoEngineAdvanceTrackIndex } from './ludoEngineGeometry'
