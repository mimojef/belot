// Pure reducer за Ludo canonical game state — единствената функция, която
// мутира правилата на играта. НЕ import-ва document/window/DOM types/render
// functions/CSS/animation helpers/setTimeout/requestAnimationFrame/
// Math.random/browser storage/network. Dice резултатът е INPUT
// (ROLL_RESOLVED.value: 1..6), reducer-ът никога не хвърля зара сам.
//
// Contract: reduceLudoGame(state, action) -> { state, events }
//   - еднакъв state + action -> еднакъв резултат (reducer purity, т.11.K);
//   - входният state НИКОГА не се мутира — винаги нов обект/масив при промяна;
//   - action от грешен player (action.color !== state.activeColor) -> rejected;
//   - stale action.expectedTurnVersion !== state.turnVersion -> rejected;
//   - "rejected" = връща СЪЩИЯ state reference, events: [] — не хвърля грешка,
//     затова UI слоят може безопасно да dispatch-ва без try/catch навсякъде.

import { computeLudoEngineLegalMoves } from './ludoEngineLegalMoves'
import { applyLudoEngineCaptureToHome, findLudoEngineCaptureVictims } from './ludoEngineCapture'
import type { LudoEngineAction } from './ludoEngineActions'
import type { LudoEngineEvent } from './ludoEngineEvents'
import { ludoGamePieceId } from './ludoEngineTypes'
import type { LudoGamePiece, LudoGameState } from './ludoEngineTypes'

export interface LudoReduceResult {
  state: LudoGameState
  events: readonly LudoEngineEvent[]
}

function rejected(state: LudoGameState): LudoReduceResult {
  return { state, events: [] }
}

function isActionAuthorized(state: LudoGameState, action: { color: string; expectedTurnVersion: number }): boolean {
  if (action.color !== state.activeColor) return false
  if (action.expectedTurnVersion !== state.turnVersion) return false
  return true
}

export function reduceLudoGame(state: LudoGameState, action: LudoEngineAction): LudoReduceResult {
  switch (action.type) {
    case 'ROLL_STARTED':
      return handleRollStarted(state, action)
    case 'ROLL_RESOLVED':
      return handleRollResolved(state, action)
    case 'MOVE_REQUESTED':
      return handleMoveRequested(state, action)
    case 'TURN_ADVANCED':
      return handleTurnAdvanced(state, action)
  }
}

function handleRollStarted(
  state: LudoGameState,
  action: Extract<LudoEngineAction, { type: 'ROLL_STARTED' }>,
): LudoReduceResult {
  if (!isActionAuthorized(state, action)) return rejected(state)
  if (state.turnPhase !== 'waiting_for_roll') return rejected(state)

  const nextState: LudoGameState = {
    ...state,
    turnPhase: 'rolling',
    turnVersion: state.turnVersion + 1,
  }
  return { state: nextState, events: [] }
}

function handleRollResolved(
  state: LudoGameState,
  action: Extract<LudoEngineAction, { type: 'ROLL_RESOLVED' }>,
): LudoReduceResult {
  if (!isActionAuthorized(state, action)) return rejected(state)
  if (state.turnPhase !== 'rolling') return rejected(state)
  // Dice value validation — reducer-ът е последната защитна линия дори
  // самият LudoDiceValue тип вече ограничава 1..6 на compile-time.
  if (action.value < 1 || action.value > 6) return rejected(state)

  const legalMoves = computeLudoEngineLegalMoves(state.pieces, state.activeColor, action.value)
  const nextPhase = legalMoves.length > 0 ? 'awaiting_move_selection' : 'turn_complete'

  const nextState: LudoGameState = {
    ...state,
    turnPhase: nextPhase,
    diceValue: action.value,
    legalMoves,
    turnVersion: state.turnVersion + 1,
  }

  const events: LudoEngineEvent[] = [{ type: 'dice_accepted', color: action.color, value: action.value }]
  if (legalMoves.length > 0) {
    events.push({ type: 'legal_moves_available', color: action.color, moves: legalMoves })
  }

  return { state: nextState, events }
}

function handleMoveRequested(
  state: LudoGameState,
  action: Extract<LudoEngineAction, { type: 'MOVE_REQUESTED' }>,
): LudoReduceResult {
  if (!isActionAuthorized(state, action)) return rejected(state)
  if (state.turnPhase !== 'awaiting_move_selection') return rejected(state)

  const move = state.legalMoves.find((m) => m.color === action.color && m.slot === action.slot)
  if (!move) return rejected(state)
  if (move.targetPosition.kind !== 'track') return rejected(state)

  const movingPiece = state.pieces.find((p) => p.color === action.color && p.slot === action.slot)
  if (!movingPiece || movingPiece.position.kind !== 'track') return rejected(state)

  const fromTrackIndex = movingPiece.position.trackIndex
  const toTrackIndex = move.targetPosition.trackIndex

  const events: LudoEngineEvent[] = [
    {
      type: 'piece_moved',
      color: action.color,
      slot: action.slot,
      fromTrackIndex,
      toTrackIndex,
    },
  ]

  // Мести само тази конкретна пионка — ако е част от stack, останалите
  // stack-mate пионки на СЪЩИЯ цвят/старата клетка не се пипат (виж
  // checkLudoStackCapture.ts test A/B: "move one piece from a stack").
  let nextPieces: LudoGamePiece[] = state.pieces.map((piece) => {
    if (piece.color === action.color && piece.slot === action.slot) {
      return { ...piece, position: move.targetPosition }
    }
    return piece
  })

  if (move.isCapture) {
    const victims = findLudoEngineCaptureVictims(nextPieces, toTrackIndex, action.color)
    if (victims.length > 0) {
      nextPieces = applyLudoEngineCaptureToHome(nextPieces, victims)
      // Директно canonical id-та на ВСИЧКИ victims, независимо от колко
      // различни opponent цвята евентуално стоят на target-а едновременно
      // — UI/controller не extract-ва identity от color+slots heuristics
      // (виж Phase 2 task-а т.2).
      const capturedPieceIds = victims.map((v) => ludoGamePieceId(v))
      events.push({ type: 'pieces_captured', capturedPieceIds })
    }
  }

  const nextState: LudoGameState = {
    ...state,
    pieces: nextPieces,
    turnPhase: 'turn_complete',
    legalMoves: [],
    turnVersion: state.turnVersion + 1,
  }

  return { state: nextState, events }
}

function handleTurnAdvanced(
  state: LudoGameState,
  action: Extract<LudoEngineAction, { type: 'TURN_ADVANCED' }>,
): LudoReduceResult {
  if (!isActionAuthorized(state, action)) return rejected(state)
  if (state.turnPhase !== 'turn_complete') return rejected(state)

  const currentIndex = state.turnOrder.indexOf(state.activeColor)
  const nextColor = state.turnOrder[(currentIndex + 1) % state.turnOrder.length]!

  const nextState: LudoGameState = {
    ...state,
    activeColor: nextColor,
    turnPhase: 'waiting_for_roll',
    diceValue: null,
    legalMoves: [],
    turnVersion: state.turnVersion + 1,
  }

  return {
    state: nextState,
    events: [{ type: 'turn_advanced', previousColor: state.activeColor, nextColor }],
  }
}
