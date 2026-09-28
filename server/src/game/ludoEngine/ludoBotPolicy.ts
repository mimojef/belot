// Ludo bot move policy — PURE (без RNG/таймери/DOM). Избира САМО измежду
// state.legalMoves, изчислени от authoritative engine-а; никога не създава
// нов ход и не пипа правилата. Reducer-ът не знае за bot-а: runtime-ът
// просто изпраща избрания slot през същия MOVE_REQUESTED.
//
// Capture/safe/route правилата НЕ се дублират тук — рискът се мери с
// canonical helper-ите: computeLudoEngineLegalMoves (маршрут на
// противника, влизане във finish lane, overshoot, звезди, own-start
// защита) и findLudoEngineCaptureVictims (коя пионка реално би била ударена).

import { applyLudoEngineCaptureToHome, findLudoEngineCaptureVictims } from './ludoEngineCapture.js'
import { LUDO_ENGINE_TRACK_LENGTH, ludoEngineStepsFromStart } from './ludoEngineGeometry.js'
import { computeLudoEngineLegalMoves } from './ludoEngineLegalMoves.js'
import type {
  LudoColor,
  LudoDiceValue,
  LudoGamePiece,
  LudoGameState,
  LudoLegalMove,
} from './ludoEngineTypes.js'

// Legacy: минимален избор само по legal moves (първи capture, иначе първи
// ход). Остава за client/mock orchestrator-а (src/app/games/ludo/orchestrator
// re-export-ва този модул) — production server runtime-ът ползва
// pickLudoBotMoveForState() по-долу.
export function pickLudoBotMove(legalMoves: readonly LudoLegalMove[]): LudoLegalMove | null {
  if (legalMoves.length === 0) return null
  return legalMoves.find((move) => move.isCapture) ?? legalMoves[0]!
}

const LUDO_DICE_VALUES: readonly LudoDiceValue[] = [1, 2, 3, 4, 5, 6]

// Tier-ове (по-малко = по-добре): реален capture > изваждане от базата при
// 6 > нормален ход. Lexicographic, не сбор от точки.
const TIER_CAPTURE = 0
const TIER_BASE_EXIT_ON_SIX = 1
const TIER_NORMAL = 2

export interface LudoBotMoveEvaluation {
  move: LudoLegalMove
  tier: number
  // Брой противникови заплахи, които след хода могат да ударят преместената
  // пионка със зар 1..6: пионки на shared track-а + (ако тя стои на чужд
  // старт) базата на този противник като една заплаха при зар 6.
  threatCount: number
  // SUM(7 - distance) за тези заплахи — по-близък противник = по-опасен.
  // Само tie-break при еднакъв threatCount.
  threatWeight: number
  // Пионката вече е била във finish lane (защитена) — нисък приоритет.
  isFinishLanePiece: boolean
  // Canonical progress след хода: track 0..55 (steps от собствения старт),
  // finish 56..61.
  progressAfter: number
}

function applyCandidateMove(pieces: readonly LudoGamePiece[], move: LudoLegalMove): LudoGamePiece[] {
  // Mirror на handleMoveRequested (ludoEngineReducer.ts): местене, после
  // capture resolution само при isCapture на track target.
  const moved = pieces.map((piece) =>
    piece.color === move.color && piece.slot === move.slot ? { ...piece, position: move.targetPosition } : piece,
  )
  if (!move.isCapture || move.targetPosition.kind !== 'track') return moved
  const victims = findLudoEngineCaptureVictims(moved, move.targetPosition.trackIndex, move.color)
  return applyLudoEngineCaptureToHome(moved, victims)
}

function getActiveOpponentColors(state: LudoGameState): LudoColor[] {
  return state.turnOrder.filter((color) => color !== state.activeColor && !state.leftColors.includes(color))
}

function measurePostMoveThreats(
  piecesAfter: readonly LudoGamePiece[],
  move: LudoLegalMove,
  opponentColors: readonly LudoColor[],
): { threatCount: number; threatWeight: number } {
  // Finish lane е private — никаква capture опасност.
  if (move.targetPosition.kind !== 'track') return { threatCount: 0, threatWeight: 0 }
  const destination = move.targetPosition.trackIndex
  const threatDistanceByPiece = new Map<string, number>()

  for (const opponentColor of opponentColors) {
    for (const diceValue of LUDO_DICE_VALUES) {
      for (const opponentMove of computeLudoEngineLegalMoves(piecesAfter, opponentColor, diceValue)) {
        if (opponentMove.targetPosition.kind !== 'track' || opponentMove.targetPosition.trackIndex !== destination) continue
        if (!opponentMove.isCapture) continue
        const source = piecesAfter.find((piece) => piece.color === opponentColor && piece.slot === opponentMove.slot)
        // Противници на shared track-а + base exit при 6. Base exit е legal
        // само върху собствения старт на противника, затова това е заплаха
        // единствено когато преместената пионка стои на ЧУЖД старт (собственият
        // старт я пази — isCapture/victims го отчитат canonical).
        if (source?.position.kind !== 'track' && source?.position.kind !== 'home') continue
        const victims = findLudoEngineCaptureVictims(piecesAfter, destination, opponentColor)
        if (!victims.some((victim) => victim.color === move.color && victim.slot === move.slot)) continue
        // Всички base пионки на един цвят излизат на същата клетка със същия
        // зар — една заплаха на цвят, не по една на пионка.
        const key = source.position.kind === 'home' ? `${opponentColor}-base` : `${opponentColor}-${opponentMove.slot}`
        if (!threatDistanceByPiece.has(key)) threatDistanceByPiece.set(key, diceValue)
      }
    }
  }

  let threatWeight = 0
  for (const distance of threatDistanceByPiece.values()) threatWeight += 7 - distance
  return { threatCount: threatDistanceByPiece.size, threatWeight }
}

function computeProgressAfter(move: LudoLegalMove): number {
  const target = move.targetPosition
  if (target.kind === 'track') return ludoEngineStepsFromStart(move.color, target.trackIndex)
  if (target.kind === 'finish') return LUDO_ENGINE_TRACK_LENGTH + target.finishIndex
  return -1
}

export function evaluateLudoBotMoves(state: LudoGameState): LudoBotMoveEvaluation[] {
  const opponentColors = getActiveOpponentColors(state)
  return state.legalMoves.map((move) => {
    const source = state.pieces.find((piece) => piece.color === move.color && piece.slot === move.slot)
    const isBaseExit = source?.position.kind === 'home'
    const tier = move.isCapture
      ? TIER_CAPTURE
      : isBaseExit && state.diceValue === 6
        ? TIER_BASE_EXIT_ON_SIX
        : TIER_NORMAL
    const piecesAfter = applyCandidateMove(state.pieces, move)
    const { threatCount, threatWeight } = measurePostMoveThreats(piecesAfter, move, opponentColors)
    return {
      move,
      tier,
      threatCount,
      threatWeight,
      isFinishLanePiece: source?.position.kind === 'finish',
      progressAfter: computeProgressAfter(move),
    }
  })
}

// Lexicographic ред: tier -> threatCount -> threatWeight -> shared-track
// пионка пред вече защитена finish-lane пионка -> по-голям progress -> slot.
// threatCount преди всичко останало в рамките на tier-а означава, че ако
// съществува кандидат с 0 заплахи, рисков кандидат никога не се избира.
function compareEvaluations(a: LudoBotMoveEvaluation, b: LudoBotMoveEvaluation): number {
  return (
    a.tier - b.tier ||
    a.threatCount - b.threatCount ||
    a.threatWeight - b.threatWeight ||
    Number(a.isFinishLanePiece) - Number(b.isFinishLanePiece) ||
    b.progressAfter - a.progressAfter ||
    a.move.slot - b.move.slot
  )
}

export function pickLudoBotMoveForState(state: LudoGameState): LudoLegalMove | null {
  const evaluations = evaluateLudoBotMoves(state)
  if (evaluations.length === 0) return null
  return [...evaluations].sort(compareEvaluations)[0]!.move
}
