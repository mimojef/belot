// Deterministic проверка на pure Ludo rule engine-а (src/app/games/ludo/engine/)
// — НЕ browser check (чиста логика, без DOM/Playwright). Engine-ът е
// напълно изолиран от createLudoFlowController.ts/renderLudo*; проверява
// reduceLudoGame contract-а директно.
//
// Покрива (виж task-а т.11):
//   A. initial state: валиден active player, waiting_for_roll, diceResult
//      null, deterministic turnVersion.
//   B. грешен player опитва roll/move -> rejected, без мутация.
//   C. roll резултат извън 1..6 -> rejected.
//   D. valid roll -> phase awaiting_move_selection, legal moves deterministic.
//   E. track move с 1 piece -> canonical позицията се променя правилно.
//   F. move от stack -> мести се само ЕДНА real piece.
//   G. landing on own piece -> state съдържа stack от 2 real pieces.
//   H. landing on opponent stack -> всички opponent victims се връщат към
//      постоянните им home slots.
//   I. intermediate opponent cell -> няма capture; capture само на final target.
//   J. stale turnVersion -> action rejected.
//   K. reducer purity: еднакъв state + action -> еднакъв резултат; input
//      state не се mutate-ва.
//   L. capture event връща точните capturedPieceIds (single capture).
//   M. opponent stack -> всички victim IDs присъстват веднъж (capturedPieceIds).
//   N. TURN_ADVANCED: red -> blue -> yellow -> green -> red (canonical
//      GAMEPLAY turnOrder = LUDO_CANONICAL_TURN_ORDER, derived от ascending
//      START_INDEX/clockwise track — виж ludoGeometryConstants.ts).
//   N2. canonical turn order е съгласуван с ascending START_INDEX (равни
//       14-клетъчни интервали, точните литерали се четат от текущия
//       LUDO_START_INDEX, виж ludoGeometryConstants.ts).
//   O. TURN_ADVANCED reset: phase waiting_for_roll, dice null, legalMoves empty.
//   P. turnVersion increment е deterministic.
//   Q. adapter: home/track/finish conversion към renderer е deterministic.
//   R. canonical geometry (track length/start indices) има един source of truth.
//   S. reducer state остава immutable след integration-related action sequences.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { reduceLudoGame } from '../src/app/games/ludo/engine/ludoEngineReducer'
import { createLudoEngineInitialState } from '../src/app/games/ludo/engine/ludoEngineState'
import { LUDO_ENGINE_TRACK_LENGTH, LUDO_ENGINE_START_INDEX } from '../src/app/games/ludo/engine/ludoEngineGeometry'
import { ludoEnginePiecesToUiPieces, ludoEngineLegalMovesToUiMoves } from '../src/app/games/ludo/engine/ludoEngineAdapter'
import { LUDO_TRACK_LENGTH, LUDO_START_INDEX } from '../src/app/games/ludo/ludoGeometryConstants'
import type { LudoGamePiece, LudoGameState } from '../src/app/games/ludo/engine/ludoEngineTypes'

function fail(message: string): never {
  console.error(`[checkLudoEngine] FAIL: ${message}`)
  process.exit(1)
}

function piece(color: LudoGamePiece['color'], slot: LudoGamePiece['slot'], trackIndex: number): LudoGamePiece {
  return { color, slot, position: { kind: 'track', trackIndex } }
}

function stateWithPieces(overrides: Partial<LudoGameState>): LudoGameState {
  return { ...createLudoEngineInitialState(), ...overrides }
}

function main(): void {
  // --- A: initial state ---
  {
    const state = createLudoEngineInitialState()
    if (state.activeColor !== 'red') fail(`A: expected initial activeColor red, got ${state.activeColor}`)
    if (state.turnPhase !== 'waiting_for_roll') fail(`A: expected waiting_for_roll, got ${state.turnPhase}`)
    if (state.diceValue !== null) fail(`A: expected diceValue null, got ${state.diceValue}`)
    if (state.turnVersion !== 0) fail(`A: expected deterministic turnVersion 0, got ${state.turnVersion}`)
    const state2 = createLudoEngineInitialState()
    if (JSON.stringify(state) !== JSON.stringify(state2)) fail('A: initial state must be deterministic across calls')
    console.log('[checkLudoEngine] A OK — initial state valid and deterministic.')
  }

  // --- B: wrong player attempts roll/move -> rejected, no mutation ---
  {
    const state = createLudoEngineInitialState() // activeColor=red
    const result = reduceLudoGame(state, { type: 'ROLL_STARTED', color: 'blue', expectedTurnVersion: 0 })
    if (result.state !== state) fail('B: wrong-player ROLL_STARTED must return the SAME state reference (rejected)')
    if (result.events.length !== 0) fail('B: rejected action must produce no events')

    const rolling = { ...state, turnPhase: 'rolling' as const }
    const moveResult = reduceLudoGame(rolling, { type: 'MOVE_REQUESTED', color: 'blue', slot: 0, expectedTurnVersion: 0 })
    if (moveResult.state !== rolling) fail('B: wrong-player MOVE_REQUESTED must be rejected (same state reference)')
    console.log('[checkLudoEngine] B OK — wrong-player actions rejected without mutation.')
  }

  // --- C: dice value outside 1..6 -> rejected ---
  {
    const state = { ...createLudoEngineInitialState(), turnPhase: 'rolling' as const, turnVersion: 1 }
    // @ts-expect-error deliberately invalid dice value for the runtime check
    const result = reduceLudoGame(state, { type: 'ROLL_RESOLVED', color: 'red', value: 7, expectedTurnVersion: 1 })
    if (result.state !== state) fail('C: out-of-range dice value must be rejected (same state reference)')
    // @ts-expect-error deliberately invalid dice value for the runtime check
    const result0 = reduceLudoGame(state, { type: 'ROLL_RESOLVED', color: 'red', value: 0, expectedTurnVersion: 1 })
    if (result0.state !== state) fail('C: dice value 0 must be rejected')
    console.log('[checkLudoEngine] C OK — dice value outside 1..6 rejected.')
  }

  // --- D: valid roll -> awaiting_move_selection, deterministic legal moves ---
  {
    const state = stateWithPieces({
      turnPhase: 'rolling',
      turnVersion: 1,
      pieces: [piece('red', 1, 4), piece('red', 2, 22)],
    })
    const result = reduceLudoGame(state, { type: 'ROLL_RESOLVED', color: 'red', value: 6, expectedTurnVersion: 1 })
    if (result.state.turnPhase !== 'awaiting_move_selection') {
      fail(`D: expected awaiting_move_selection, got ${result.state.turnPhase}`)
    }
    if (result.state.diceValue !== 6) fail(`D: expected diceValue 6, got ${result.state.diceValue}`)
    if (result.state.legalMoves.length !== 2) fail(`D: expected 2 legal moves, got ${result.state.legalMoves.length}`)
    const move1 = result.state.legalMoves.find((m) => m.slot === 1)
    if (!move1 || move1.targetPosition.kind !== 'track' || move1.targetPosition.trackIndex !== 10) {
      fail(`D: expected slot1 target track-10, got ${JSON.stringify(move1)}`)
    }
    // Determinism: same input -> same output.
    const result2 = reduceLudoGame(state, { type: 'ROLL_RESOLVED', color: 'red', value: 6, expectedTurnVersion: 1 })
    if (JSON.stringify(result.state.legalMoves) !== JSON.stringify(result2.state.legalMoves)) {
      fail('D: legal move computation must be deterministic')
    }
    console.log('[checkLudoEngine] D OK — valid roll transitions to awaiting_move_selection with deterministic legal moves.')
  }

  // --- E: track move with 1 piece -> canonical position updates correctly ---
  {
    const legalState = stateWithPieces({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 2,
      diceValue: 6,
      pieces: [piece('red', 1, 4)],
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 10 }, isCapture: false }],
    })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 2 })
    const moved = result.state.pieces.find((p) => p.color === 'red' && p.slot === 1)
    if (!moved || moved.position.kind !== 'track' || moved.position.trackIndex !== 10) {
      fail(`E: expected red-1 at track-10, got ${JSON.stringify(moved)}`)
    }
    if (result.state.turnPhase !== 'turn_complete') fail(`E: expected turn_complete, got ${result.state.turnPhase}`)
    const movedEvent = result.events.find((e) => e.type === 'piece_moved')
    if (!movedEvent) fail('E: expected a piece_moved event')
    console.log('[checkLudoEngine] E OK — single-piece track move updates canonical position.')
  }

  // --- F: move from a stack -> only ONE real piece moves ---
  {
    const legalState = stateWithPieces({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 3,
      diceValue: 6,
      pieces: [piece('red', 1, 5), piece('red', 2, 5), piece('red', 3, 5)],
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 11 }, isCapture: false }],
    })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 3 })
    const moved = result.state.pieces.find((p) => p.slot === 1)!
    const stayed2 = result.state.pieces.find((p) => p.slot === 2)!
    const stayed3 = result.state.pieces.find((p) => p.slot === 3)!
    if (moved.position.kind !== 'track' || moved.position.trackIndex !== 11) fail('F: slot1 must move to track-11')
    if (stayed2.position.kind !== 'track' || stayed2.position.trackIndex !== 5) fail('F: slot2 must remain on track-5')
    if (stayed3.position.kind !== 'track' || stayed3.position.trackIndex !== 5) fail('F: slot3 must remain on track-5')
    console.log('[checkLudoEngine] F OK — moving from a stack moves only the selected piece.')
  }

  // --- G: landing on own piece -> state contains a stack of 2 real pieces ---
  {
    const legalState = stateWithPieces({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 4,
      diceValue: 6,
      pieces: [piece('red', 1, 4), piece('red', 2, 10)],
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 10 }, isCapture: false }],
    })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 4 })
    const onTarget = result.state.pieces.filter(
      (p) => p.color === 'red' && p.position.kind === 'track' && p.position.trackIndex === 10,
    )
    if (onTarget.length !== 2) fail(`G: expected 2 real red pieces stacked on track-10, got ${onTarget.length}`)
    console.log('[checkLudoEngine] G OK — landing on own piece forms a real 2-piece stack.')
  }

  // --- H: landing on opponent stack -> all victims return to their OWN home slots ---
  {
    const legalState = stateWithPieces({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 5,
      diceValue: 6,
      pieces: [piece('red', 1, 14), piece('blue', 0, 20), piece('blue', 2, 20)],
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 20 }, isCapture: true }],
    })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 5 })
    const blue0 = result.state.pieces.find((p) => p.color === 'blue' && p.slot === 0)!
    const blue2 = result.state.pieces.find((p) => p.color === 'blue' && p.slot === 2)!
    if (blue0.position.kind !== 'home' || blue0.position.slot !== 0) fail(`H: blue-0 expected home slot 0, got ${JSON.stringify(blue0.position)}`)
    if (blue2.position.kind !== 'home' || blue2.position.slot !== 2) fail(`H: blue-2 expected home slot 2, got ${JSON.stringify(blue2.position)}`)
    const mover = result.state.pieces.find((p) => p.color === 'red' && p.slot === 1)!
    if (mover.position.kind !== 'track' || mover.position.trackIndex !== 20) fail('H: mover must remain on target')
    const capturedEvent = result.events.find((e) => e.type === 'pieces_captured')
    if (!capturedEvent || capturedEvent.type !== 'pieces_captured') fail('H: expected a pieces_captured event')
    if (capturedEvent.capturedPieceIds.length !== 2) fail(`H: expected 2 captured piece ids, got ${capturedEvent.capturedPieceIds.length}`)
    console.log('[checkLudoEngine] H OK — capturing an opponent stack returns all victims to their own home slots.')
  }

  // --- I: intermediate opponent cell -> no capture; capture only on final target ---
  {
    const legalState = stateWithPieces({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 6,
      diceValue: 6,
      pieces: [piece('red', 1, 22), piece('blue', 3, 27)], // 5 steps away, NOT the target (28)
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 28 }, isCapture: false }],
    })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 6 })
    const blue3 = result.state.pieces.find((p) => p.color === 'blue' && p.slot === 3)!
    if (blue3.position.kind !== 'track' || blue3.position.trackIndex !== 27) {
      fail(`I: intermediate opponent must remain untouched on track-27, got ${JSON.stringify(blue3.position)}`)
    }
    const capturedEvent = result.events.find((e) => e.type === 'pieces_captured')
    if (capturedEvent) fail('I: no capture event expected when the only opponent is on an intermediate cell')
    console.log('[checkLudoEngine] I OK — opponent on an intermediate cell is never captured.')
  }

  // --- J: stale turnVersion -> action rejected ---
  {
    const state = { ...createLudoEngineInitialState(), turnVersion: 5 }
    const result = reduceLudoGame(state, { type: 'ROLL_STARTED', color: 'red', expectedTurnVersion: 3 })
    if (result.state !== state) fail('J: stale turnVersion action must be rejected (same state reference)')
    if (result.events.length !== 0) fail('J: rejected stale action must produce no events')
    console.log('[checkLudoEngine] J OK — stale turnVersion action rejected.')
  }

  // --- K: reducer purity ---
  {
    const state = stateWithPieces({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 7,
      diceValue: 6,
      pieces: [piece('red', 1, 4)],
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 10 }, isCapture: false }],
    })
    const snapshotBefore = JSON.parse(JSON.stringify(state))
    const action = { type: 'MOVE_REQUESTED' as const, color: 'red' as const, slot: 1 as const, expectedTurnVersion: 7 }

    const result1 = reduceLudoGame(state, action)
    if (JSON.stringify(state) !== JSON.stringify(snapshotBefore)) fail('K: input state must not be mutated by reduceLudoGame')

    const result2 = reduceLudoGame(state, action)
    if (JSON.stringify(result1.state) !== JSON.stringify(result2.state)) {
      fail('K: same state + action must produce the same result (determinism)')
    }
    console.log('[checkLudoEngine] K OK — reducer is pure: no input mutation, deterministic output.')
  }

  // --- L: capture event returns exact capturedPieceIds (single capture) ---
  {
    const legalState = stateWithPieces({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 8,
      diceValue: 6,
      pieces: [piece('red', 1, 14), piece('blue', 0, 20)],
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 20 }, isCapture: true }],
    })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 8 })
    const capturedEvent = result.events.find((e) => e.type === 'pieces_captured')
    if (!capturedEvent || capturedEvent.type !== 'pieces_captured') fail('L: expected a pieces_captured event')
    if (capturedEvent.capturedPieceIds.length !== 1 || capturedEvent.capturedPieceIds[0] !== 'blue-0') {
      fail(`L: expected capturedPieceIds ["blue-0"], got ${JSON.stringify(capturedEvent.capturedPieceIds)}`)
    }
    console.log('[checkLudoEngine] L OK — single capture event returns exact capturedPieceIds.')
  }

  // --- M: opponent stack -> all victim IDs present exactly once (capturedPieceIds) ---
  {
    const legalState = stateWithPieces({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 9,
      diceValue: 6,
      pieces: [piece('red', 1, 14), piece('blue', 0, 20), piece('blue', 1, 20), piece('blue', 2, 20)],
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 20 }, isCapture: true }],
    })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 9 })
    const capturedEvent = result.events.find((e) => e.type === 'pieces_captured')
    if (!capturedEvent || capturedEvent.type !== 'pieces_captured') fail('M: expected a pieces_captured event')
    const ids = [...capturedEvent.capturedPieceIds].sort()
    const expected = ['blue-0', 'blue-1', 'blue-2']
    if (JSON.stringify(ids) !== JSON.stringify(expected)) {
      fail(`M: expected capturedPieceIds ${JSON.stringify(expected)} exactly once each, got ${JSON.stringify(ids)}`)
    }
    if (new Set(capturedEvent.capturedPieceIds).size !== capturedEvent.capturedPieceIds.length) {
      fail('M: capturedPieceIds must not contain duplicates')
    }
    console.log('[checkLudoEngine] M OK — opponent stack capture returns all victim IDs exactly once.')
  }

  // --- N: TURN_ADVANCED cycles red -> blue -> yellow -> green -> red (canonical turnOrder) ---
  // Това е GAMEPLAY интенцията (не implementation detail): canonical turn
  // order следва clockwise track прогресията по START_INDEX (0->14->28->42),
  // потвърдена и НЕЗАВИСИМО от HOME_QUADRANT_ORIGIN в board/renderLudoBoard.ts
  // (red горе-ляво -> blue горе-дясно -> yellow долу-дясно -> green долу-ляво).
  // LUDO_COLORS (ludoEngineTypes.ts) е отделна концепция — просто enumeration
  // на допустимите цветове, БЕЗ gameplay значение на реда (виж audit-а в
  // ludoGeometryConstants.ts) — turnOrder идва от LUDO_CANONICAL_TURN_ORDER.
  {
    let state = createLudoEngineInitialState()
    const expectedOrder: Array<typeof state.activeColor> = ['blue', 'yellow', 'green', 'red']
    for (const expectedNext of expectedOrder) {
      const completeState = { ...state, turnPhase: 'turn_complete' as const }
      const result = reduceLudoGame(completeState, {
        type: 'TURN_ADVANCED',
        color: completeState.activeColor,
        expectedTurnVersion: completeState.turnVersion,
      })
      if (result.state.activeColor !== expectedNext) {
        fail(`N: expected next active color ${expectedNext}, got ${result.state.activeColor}`)
      }
      state = result.state
    }
    console.log('[checkLudoEngine] N OK — TURN_ADVANCED cycles red -> blue -> yellow -> green -> red.')
  }

  // --- N2: canonical turn order is consistent with ascending START_INDEX (clockwise track) ---
  {
    const state = createLudoEngineInitialState()
    const startIndices = state.turnOrder.map((color) => LUDO_START_INDEX[color])
    const isAscending = startIndices.every((value, i) => i === 0 || value > startIndices[i - 1]!)
    if (!isAscending) {
      fail(`N2: turnOrder must follow ascending START_INDEX (clockwise track), got ${JSON.stringify(state.turnOrder)} with indices ${JSON.stringify(startIndices)}`)
    }
    // Точните литерали (виж task-а — визуална поправка: "изходният" tint/
    // arrow маркер стои една клетка напред от ъгъла, не в самия ъгъл) вече
    // са [1,15,29,43] вместо старите [0,14,28,42] — самата ascending/14-
    // apart инвариант (проверена по-горе) е структурната гаранция, не
    // конкретните числа. Тук проверяваме, че разликата между съседни
    // start индекси остава точно 14 (равни интервали, 56/4 рамена).
    for (let i = 1; i < startIndices.length; i += 1) {
      const delta = startIndices[i]! - startIndices[i - 1]!
      if (delta !== 14) {
        fail(`N2: expected exactly 14 cells between consecutive start indices, got delta=${delta} between ${JSON.stringify(startIndices)}`)
      }
    }
    console.log(`[checkLudoEngine] N2 OK — canonical turn order is consistent with ascending START_INDEX (equal 14-cell intervals, clockwise track), current values ${JSON.stringify(startIndices)}.`)
  }

  // --- O: TURN_ADVANCED resets phase/dice/legalMoves ---
  {
    const state = stateWithPieces({
      turnPhase: 'turn_complete',
      turnVersion: 10,
      diceValue: 6,
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 10 }, isCapture: false }],
    })
    const result = reduceLudoGame(state, { type: 'TURN_ADVANCED', color: 'red', expectedTurnVersion: 10 })
    if (result.state.turnPhase !== 'waiting_for_roll') fail(`O: expected waiting_for_roll, got ${result.state.turnPhase}`)
    if (result.state.diceValue !== null) fail(`O: expected diceValue null, got ${result.state.diceValue}`)
    if (result.state.legalMoves.length !== 0) fail(`O: expected empty legalMoves, got ${result.state.legalMoves.length}`)
    console.log('[checkLudoEngine] O OK — TURN_ADVANCED resets phase/dice/legalMoves.')
  }

  // --- P: turnVersion increment is deterministic ---
  {
    const state = createLudoEngineInitialState()
    const action = { type: 'ROLL_STARTED' as const, color: 'red' as const, expectedTurnVersion: 0 }
    const result1 = reduceLudoGame(state, action)
    const result2 = reduceLudoGame(state, action)
    if (result1.state.turnVersion !== state.turnVersion + 1) {
      fail(`P: expected turnVersion to increment by exactly 1, got ${result1.state.turnVersion} from ${state.turnVersion}`)
    }
    if (result1.state.turnVersion !== result2.state.turnVersion) {
      fail('P: turnVersion increment must be deterministic across identical calls')
    }
    console.log('[checkLudoEngine] P OK — turnVersion increment is deterministic.')
  }

  // --- Q: adapter home/track/finish conversion to renderer is deterministic ---
  {
    const pieces: LudoGamePiece[] = [
      piece('red', 0, 4), // will be overridden below to test home/finish too
    ]
    const enginePieces: LudoGamePiece[] = [
      { color: 'red', slot: 0, position: { kind: 'home', slot: 0 } },
      { color: 'blue', slot: 1, position: { kind: 'track', trackIndex: 17 } },
      { color: 'green', slot: 2, position: { kind: 'finish', finishIndex: 3 } },
    ]
    const uiPieces1 = ludoEnginePiecesToUiPieces(enginePieces)
    const uiPieces2 = ludoEnginePiecesToUiPieces(enginePieces)
    if (JSON.stringify(uiPieces1) !== JSON.stringify(uiPieces2)) fail('Q: adapter conversion must be deterministic')
    const redUi = uiPieces1.find((p) => p.id === 'red-0')!
    if (redUi.cell !== 'home-red-0') fail(`Q: expected home-red-0, got ${redUi.cell}`)
    const blueUi = uiPieces1.find((p) => p.id === 'blue-1')!
    if (blueUi.cell !== 'track-17') fail(`Q: expected track-17, got ${blueUi.cell}`)
    const greenUi = uiPieces1.find((p) => p.id === 'green-2')!
    if (greenUi.cell !== 'finish-green-3') fail(`Q: expected finish-green-3, got ${greenUi.cell}`)

    const legalMoves = ludoEngineLegalMovesToUiMoves([
      { color: 'red', slot: 0, targetPosition: { kind: 'track', trackIndex: 10 }, isCapture: true },
    ])
    if (legalMoves[0]!.pieceId !== 'red-0' || legalMoves[0]!.targetCell !== 'track-10' || legalMoves[0]!.type !== 'capture') {
      fail(`Q: adapter legal-move conversion mismatch, got ${JSON.stringify(legalMoves[0])}`)
    }
    void pieces // avoid unused-var noise while keeping the destructive intent explicit
    console.log('[checkLudoEngine] Q OK — adapter home/track/finish conversion is deterministic.')
  }

  // --- R: canonical geometry has a single source of truth ---
  {
    if (LUDO_ENGINE_TRACK_LENGTH !== LUDO_TRACK_LENGTH) {
      fail(`R: engine track length (${LUDO_ENGINE_TRACK_LENGTH}) must equal shared constant (${LUDO_TRACK_LENGTH})`)
    }
    if (LUDO_ENGINE_TRACK_LENGTH !== 56) fail(`R: expected canonical track length 56, got ${LUDO_ENGINE_TRACK_LENGTH}`)
    // Виж task-а — визуална поправка: "изходният" tint/arrow маркер стои
    // една клетка напред от ъгъла (не в самия ъгъл), затова стойностите тук
    // отразяват текущия LUDO_START_INDEX (ludoGeometryConstants.ts), не
    // legacy [0,14,28,42]. Самата проверка (single source of truth между
    // engine/shared константите) остава непроменена.
    const expectedStarts = { red: 1, blue: 15, yellow: 29, green: 43 } as const
    for (const [color, expected] of Object.entries(expectedStarts)) {
      const engineValue = LUDO_ENGINE_START_INDEX[color as keyof typeof expectedStarts]
      const sharedValue = LUDO_START_INDEX[color as keyof typeof expectedStarts]
      if (engineValue !== expected) fail(`R: engine start index for ${color} expected ${expected}, got ${engineValue}`)
      if (sharedValue !== expected) fail(`R: shared start index for ${color} expected ${expected}, got ${sharedValue}`)
      if (engineValue !== sharedValue) fail(`R: engine/shared start index mismatch for ${color}: ${engineValue} vs ${sharedValue}`)
    }
    console.log('[checkLudoEngine] R OK — canonical geometry (track length 56, start indices) has a single source of truth.')
  }

  // --- S: reducer state remains immutable across an integration-like action sequence ---
  {
    const initial = createLudoEngineInitialState()
    const snapshot0 = JSON.parse(JSON.stringify(initial))

    const afterRollStart = reduceLudoGame(initial, { type: 'ROLL_STARTED', color: 'red', expectedTurnVersion: 0 })
    if (JSON.stringify(initial) !== JSON.stringify(snapshot0)) fail('S: initial state mutated after ROLL_STARTED')

    const snapshot1 = JSON.parse(JSON.stringify(afterRollStart.state))
    const afterRollResolved = reduceLudoGame(afterRollStart.state, {
      type: 'ROLL_RESOLVED',
      color: 'red',
      value: 6,
      expectedTurnVersion: afterRollStart.state.turnVersion,
    })
    if (JSON.stringify(afterRollStart.state) !== JSON.stringify(snapshot1)) {
      fail('S: rolling-phase state mutated after ROLL_RESOLVED')
    }

    if (afterRollResolved.state.turnPhase === 'awaiting_move_selection') {
      const snapshot2 = JSON.parse(JSON.stringify(afterRollResolved.state))
      const firstMove = afterRollResolved.state.legalMoves[0]!
      const afterMove = reduceLudoGame(afterRollResolved.state, {
        type: 'MOVE_REQUESTED',
        color: 'red',
        slot: firstMove.slot,
        expectedTurnVersion: afterRollResolved.state.turnVersion,
      })
      if (JSON.stringify(afterRollResolved.state) !== JSON.stringify(snapshot2)) {
        fail('S: awaiting_move_selection state mutated after MOVE_REQUESTED')
      }
      if (afterMove.state.pieces === afterRollResolved.state.pieces) {
        fail('S: MOVE_REQUESTED must produce a NEW pieces array reference, not reuse the old one')
      }
    }
    console.log('[checkLudoEngine] S OK — reducer state remains immutable across an integration-like action sequence.')
  }

  console.log('[checkLudoEngine] ALL OK')
  process.exit(0)
}

main()
