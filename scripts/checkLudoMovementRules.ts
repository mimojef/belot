// Deterministic проверка на Phase 3B "REAL MOVEMENT RULES" — НЕ browser
// check (чиста логика, без DOM/Playwright), огледално на checkLudoEngine.ts.
// Покрива M1-M30 от task-а:
//   M1-M2   home exit само при dice===6
//   M3-M6   start index mapping за четирите цвята
//   M7-M10  track движение, canonical progress (stepsFromStart), absolute
//           55->0 wrap, пълна обиколка -> собствен finish
//   M11-M14 finish lane движение, exact finish, overshoot, "final piece"
//   M15-M18 capture semantics (единично/stack/intermediate/finish-private)
//   M19-M20 own-stack landing/move-one-piece (regression срещу Phase 1/2)
//   M21-M26 extra-roll architecture (dice===6/capture/6+capture/zero moves)
//   M27     stale action rejected след extra roll (нов turnVersion)
//   M28     legalMoves покрива home/track/finish target kinds
//   M29     bot selection остава вътре в legalMoves
//   M30     engine determinism/purity за новите пътища
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { reduceLudoGame } from '../src/app/games/ludo/engine/ludoEngineReducer'
import { createLudoEngineInitialState } from '../src/app/games/ludo/engine/ludoEngineState'
import { computeLudoEngineLegalMoves } from '../src/app/games/ludo/engine/ludoEngineLegalMoves'
import { pickLudoBotMove } from '../src/app/games/ludo/orchestrator/ludoBotPolicy'
import { LUDO_ENGINE_START_INDEX } from '../src/app/games/ludo/engine/ludoEngineGeometry'
import type { LudoGamePiece, LudoGameState, LudoColor, LudoPieceSlot } from '../src/app/games/ludo/engine/ludoEngineTypes'

function fail(message: string): never {
  console.error(`[checkLudoMovementRules] FAIL: ${message}`)
  process.exit(1)
}

function ok(label: string): void {
  console.log(`[checkLudoMovementRules] ${label} OK`)
}

function homePiece(color: LudoColor, slot: LudoPieceSlot): LudoGamePiece {
  return { color, slot, position: { kind: 'home', slot } }
}
function trackPiece(color: LudoColor, slot: LudoPieceSlot, trackIndex: number): LudoGamePiece {
  return { color, slot, position: { kind: 'track', trackIndex } }
}
function finishPiece(color: LudoColor, slot: LudoPieceSlot, finishIndex: number): LudoGamePiece {
  return { color, slot, position: { kind: 'finish', finishIndex } }
}

function stateWith(overrides: Partial<LudoGameState>): LudoGameState {
  return { ...createLudoEngineInitialState(), ...overrides }
}

function main(): void {
  // --- M1: home + 1-5 -> illegal ---
  {
    const pieces = [homePiece('red', 0)]
    for (const dice of [1, 2, 3, 4, 5] as const) {
      const moves = computeLudoEngineLegalMoves(pieces, 'red', dice)
      if (moves.length !== 0) fail(`M1: home piece with dice=${dice} must be illegal, got ${JSON.stringify(moves)}`)
    }
    ok('M1 — home + 1-5 illegal')
  }

  // --- M2: home + 6 -> legal start ---
  {
    const pieces = [homePiece('red', 0)]
    const moves = computeLudoEngineLegalMoves(pieces, 'red', 6)
    if (moves.length !== 1) fail(`M2: expected exactly 1 legal move, got ${moves.length}`)
    const move = moves[0]!
    if (move.targetPosition.kind !== 'track' || move.targetPosition.trackIndex !== LUDO_ENGINE_START_INDEX.red) {
      fail(`M2: expected home exit to red start (track-${LUDO_ENGINE_START_INDEX.red}), got ${JSON.stringify(move.targetPosition)}`)
    }
    ok('M2 — home + 6 legal start')
  }

  // --- M3-M6: start index mapping for the four colors ---
  {
    const expected: Record<LudoColor, number> = { red: 1, blue: 15, yellow: 29, green: 43 }
    for (const color of ['red', 'blue', 'yellow', 'green'] as const) {
      const moves = computeLudoEngineLegalMoves([homePiece(color, 0)], color, 6)
      const move = moves[0]
      if (!move || move.targetPosition.kind !== 'track' || move.targetPosition.trackIndex !== expected[color]) {
        fail(`M3-M6: ${color} home exit expected track-${expected[color]}, got ${JSON.stringify(move?.targetPosition)}`)
      }
    }
    ok('M3-M6 — red/blue/yellow/green start mapping')
  }

  // --- M7: normal track move ---
  {
    const moves = computeLudoEngineLegalMoves([trackPiece('red', 1, 4)], 'red', 4)
    const move = moves[0]
    if (!move || move.targetPosition.kind !== 'track' || move.targetPosition.trackIndex !== 8) {
      fail(`M7: expected track-8, got ${JSON.stringify(move?.targetPosition)}`)
    }
    ok('M7 — normal track move')
  }

  // --- M8: absolute 55->0 wrap preserves relative progress (blue, far from ITS OWN finish) ---
  {
    // blue start=15; absolute trackIndex=55 -> stepsFromStart=(55-15+56)%56=40
    // (mid-track, NOT near blue's own finish entry at stepsFromStart=55/
    // absolute-14) — this specifically proves the engine does not confuse
    // "absolute index wrapped through 55->0" with "entering finish lane".
    const moves = computeLudoEngineLegalMoves([trackPiece('blue', 2, 55)], 'blue', 1)
    const move = moves[0]
    if (!move || move.targetPosition.kind !== 'track' || move.targetPosition.trackIndex !== 0) {
      fail(`M8: expected wrap to track-0, got ${JSON.stringify(move?.targetPosition)}`)
    }
    ok('M8 — absolute 55->0 wrap keeps correct relative progress (not confused with finish entry)')
  }

  // --- M9: full lap -> own finish (red, stepsFromStart=55 -> absolute track-0) ---
  {
    const moves = computeLudoEngineLegalMoves([trackPiece('red', 1, 0)], 'red', 1)
    const move = moves[0]
    if (!move || move.targetPosition.kind !== 'finish' || move.targetPosition.finishIndex !== 0) {
      fail(`M9: expected finish-0 after a full lap, got ${JSON.stringify(move?.targetPosition)}`)
    }
    ok('M9 — full lap transitions into own finish lane')
  }

  // --- M10: track->finish multi-step (task-а's own example: stepsFromStart=53, dice=4 -> finishIndex=1) ---
  {
    // red stepsFromStart=53 -> absolute=(1+53)%56=54
    const moves = computeLudoEngineLegalMoves([trackPiece('red', 1, 54)], 'red', 4)
    const move = moves[0]
    if (!move || move.targetPosition.kind !== 'finish' || move.targetPosition.finishIndex !== 1) {
      fail(`M10: expected finish-1, got ${JSON.stringify(move?.targetPosition)}`)
    }
    ok('M10 — track->finish multi-step lands exactly on finish-1')
  }

  // --- M11: finish->finish ---
  {
    const moves = computeLudoEngineLegalMoves([finishPiece('red', 1, 2)], 'red', 2)
    const move = moves[0]
    if (!move || move.targetPosition.kind !== 'finish' || move.targetPosition.finishIndex !== 4) {
      fail(`M11: expected finish-4, got ${JSON.stringify(move?.targetPosition)}`)
    }
    ok('M11 — finish->finish forward movement')
  }

  // --- M12: exact finish5 ---
  {
    const moves = computeLudoEngineLegalMoves([finishPiece('red', 1, 4)], 'red', 1)
    const move = moves[0]
    if (!move || move.targetPosition.kind !== 'finish' || move.targetPosition.finishIndex !== 5) {
      fail(`M12: expected exact finish-5, got ${JSON.stringify(move?.targetPosition)}`)
    }
    ok('M12 — exact finish5 is legal')
  }

  // --- M13: overshoot illegal ---
  {
    const moves = computeLudoEngineLegalMoves([finishPiece('red', 1, 4)], 'red', 2)
    if (moves.length !== 0) fail(`M13: overshoot (finish4+2) must be illegal, got ${JSON.stringify(moves)}`)
    ok('M13 — overshoot is illegal (no clamping)')
  }

  // --- M14: final piece (finish5) cannot move with any dice ---
  {
    for (const dice of [1, 2, 3, 4, 5, 6] as const) {
      const moves = computeLudoEngineLegalMoves([finishPiece('red', 1, 5)], 'red', dice)
      if (moves.length !== 0) fail(`M14: finish-5 piece must have no legal move with dice=${dice}, got ${JSON.stringify(moves)}`)
    }
    ok('M14 — a piece already at finish5 can never move again')
  }

  // --- M15: single capture ---
  {
    const pieces = [trackPiece('red', 1, 14), trackPiece('blue', 0, 20)]
    const moves = computeLudoEngineLegalMoves(pieces, 'red', 6)
    const move = moves.find((m) => m.slot === 1)
    if (!move || !move.isCapture) fail(`M15: expected a capture move, got ${JSON.stringify(move)}`)
    const legalState = stateWith({ turnPhase: 'awaiting_move_selection', turnVersion: 1, diceValue: 6, pieces, legalMoves: moves })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 1 })
    const captured = result.events.find((e) => e.type === 'pieces_captured')
    if (!captured || captured.type !== 'pieces_captured' || captured.capturedPieceIds[0] !== 'blue-0') {
      fail(`M15: expected capturedPieceIds ["blue-0"], got ${JSON.stringify(captured)}`)
    }
    ok('M15 — single capture on exact landing')
  }

  // --- M16: stack capture ---
  {
    const pieces = [trackPiece('red', 1, 14), trackPiece('blue', 0, 20), trackPiece('blue', 2, 20)]
    const moves = computeLudoEngineLegalMoves(pieces, 'red', 6)
    const move = moves.find((m) => m.slot === 1)!
    const legalState = stateWith({ turnPhase: 'awaiting_move_selection', turnVersion: 1, diceValue: 6, pieces, legalMoves: [move] })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 1 })
    const captured = result.events.find((e) => e.type === 'pieces_captured')
    if (!captured || captured.type !== 'pieces_captured' || captured.capturedPieceIds.length !== 2) {
      fail(`M16: expected 2 captured pieces, got ${JSON.stringify(captured)}`)
    }
    ok('M16 — landing on an opponent stack captures all of them')
  }

  // --- M17: intermediate crossing no capture ---
  {
    const pieces = [trackPiece('red', 1, 22), trackPiece('blue', 3, 27)] // 5 steps away, not the target (28)
    const moves = computeLudoEngineLegalMoves(pieces, 'red', 6)
    const move = moves.find((m) => m.slot === 1)
    if (!move || move.isCapture) fail(`M17: intermediate opponent must not trigger capture, got ${JSON.stringify(move)}`)
    ok('M17 — opponent on an intermediate cell never captured')
  }

  // --- M18: finish lane has no capture (isCapture always false for finish targets) ---
  {
    // red stepsFromStart=55 -> absolute=0; dice=1 -> finish-0.
    const moves = computeLudoEngineLegalMoves([trackPiece('red', 1, 0)], 'red', 1)
    const move = moves[0]
    if (!move || move.targetPosition.kind !== 'finish') fail('M18: setup error, expected a finish-kind move')
    if (move.isCapture) fail('M18: finish lane landings must never be marked as capture')
    ok('M18 — finish lane is private, never a capture')
  }

  // --- M19: own landing grows stack ---
  {
    const pieces = [trackPiece('red', 1, 4), trackPiece('red', 2, 10)]
    const legalState = stateWith({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 1,
      diceValue: 6,
      pieces,
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 10 }, isCapture: false }],
    })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 1 })
    const onTarget = result.state.pieces.filter((p) => p.color === 'red' && p.position.kind === 'track' && p.position.trackIndex === 10)
    if (onTarget.length !== 2) fail(`M19: expected 2-piece stack on track-10, got ${onTarget.length}`)
    ok('M19 — landing on own piece grows a real stack')
  }

  // --- M20: move from stack moves one real piece ---
  {
    const pieces = [trackPiece('red', 1, 5), trackPiece('red', 2, 5), trackPiece('red', 3, 5)]
    const legalState = stateWith({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 1,
      diceValue: 6,
      pieces,
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 11 }, isCapture: false }],
    })
    const result = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 1 })
    const moved = result.state.pieces.find((p) => p.slot === 1)!
    const stayed2 = result.state.pieces.find((p) => p.slot === 2)!
    const stayed3 = result.state.pieces.find((p) => p.slot === 3)!
    if (moved.position.kind !== 'track' || moved.position.trackIndex !== 11) fail('M20: slot1 must move to track-11')
    if (stayed2.position.kind !== 'track' || stayed2.position.trackIndex !== 5) fail('M20: slot2 must remain on track-5')
    if (stayed3.position.kind !== 'track' || stayed3.position.trackIndex !== 5) fail('M20: slot3 must remain on track-5')
    ok('M20 — moving from a stack moves exactly one real piece')
  }

  // --- M21: six + ordinary move -> one extra roll ---
  {
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces: [trackPiece('red', 1, 4)] })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 6, expectedTurnVersion: 1 })
    if (!rolled.state.pendingExtraRoll) fail('M21: dice=6 must set pendingExtraRoll')
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    if (!moveResult.state.pendingExtraRoll) fail('M21: pendingExtraRoll must survive a non-capture move')
    const advanced = reduceLudoGame(moveResult.state, {
      type: 'TURN_ADVANCED',
      color: 'red',
      expectedTurnVersion: moveResult.state.turnVersion,
    })
    if (advanced.state.activeColor !== 'red') fail(`M21: expected red to keep the turn, got ${advanced.state.activeColor}`)
    if (advanced.state.turnPhase !== 'waiting_for_roll') fail('M21: expected fresh waiting_for_roll for the extra roll')
    ok('M21 — six + ordinary move grants exactly one extra roll')
  }

  // --- M22: capture without six -> one extra roll ---
  {
    const pieces = [trackPiece('red', 1, 14), trackPiece('blue', 0, 17)] // 3 steps away
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 3, expectedTurnVersion: 1 })
    if (rolled.state.pendingExtraRoll) fail('M22: dice=3 alone must not set pendingExtraRoll yet')
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    if (!moveResult.state.pendingExtraRoll) fail('M22: a successful capture (without six) must grant an extra roll')
    const advanced = reduceLudoGame(moveResult.state, {
      type: 'TURN_ADVANCED',
      color: 'red',
      expectedTurnVersion: moveResult.state.turnVersion,
    })
    if (advanced.state.activeColor !== 'red') fail(`M22: expected red to keep the turn, got ${advanced.state.activeColor}`)
    ok('M22 — capture without six grants exactly one extra roll')
  }

  // --- M23: six + capture -> exactly one extra roll (not two) ---
  {
    const pieces = [trackPiece('red', 1, 14), trackPiece('blue', 0, 20)] // 6 steps away
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 6, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const captured = moveResult.events.find((e) => e.type === 'pieces_captured')
    if (!captured) fail('M23: setup error, expected a capture')
    if (!moveResult.state.pendingExtraRoll) fail('M23: six+capture must grant pendingExtraRoll')

    // Consume the ONE extra roll -> still red.
    const firstAdvance = reduceLudoGame(moveResult.state, {
      type: 'TURN_ADVANCED',
      color: 'red',
      expectedTurnVersion: moveResult.state.turnVersion,
    })
    if (firstAdvance.state.activeColor !== 'red') fail('M23: expected red to keep the turn for the single extra roll')
    if (firstAdvance.state.pendingExtraRoll) fail('M23: pendingExtraRoll must be consumed (reset to false) after TURN_ADVANCED')

    // Now a completely ordinary (non-6, non-capture) turn for red must advance to the NEXT color, proving no leftover second extra roll.
    const rolling2 = { ...firstAdvance.state, turnPhase: 'rolling' as const }
    const rolled2 = reduceLudoGame(rolling2, {
      type: 'ROLL_RESOLVED',
      color: 'red',
      value: 2,
      expectedTurnVersion: rolling2.turnVersion,
    })
    const zeroMoveState = { ...rolled2.state, turnPhase: 'turn_complete' as const, legalMoves: [] }
    const secondAdvance = reduceLudoGame(zeroMoveState, {
      type: 'TURN_ADVANCED',
      color: 'red',
      expectedTurnVersion: zeroMoveState.turnVersion,
    })
    if (secondAdvance.state.activeColor !== 'blue') {
      fail(`M23: expected exactly one extra roll consumed, next TURN_ADVANCED should move to blue, got ${secondAdvance.state.activeColor}`)
    }
    ok('M23 — six + capture grants exactly one extra roll, never two')
  }

  // --- M24: ordinary move -> next color ---
  {
    const legalState = stateWith({
      turnPhase: 'awaiting_move_selection',
      turnVersion: 1,
      diceValue: 3,
      pieces: [trackPiece('red', 1, 4)],
      legalMoves: [{ color: 'red', slot: 1, targetPosition: { kind: 'track', trackIndex: 7 }, isCapture: false }],
    })
    const moveResult = reduceLudoGame(legalState, { type: 'MOVE_REQUESTED', color: 'red', slot: 1, expectedTurnVersion: 1 })
    if (moveResult.state.pendingExtraRoll) fail('M24: an ordinary move must not set pendingExtraRoll')
    const advanced = reduceLudoGame(moveResult.state, {
      type: 'TURN_ADVANCED',
      color: 'red',
      expectedTurnVersion: moveResult.state.turnVersion,
    })
    if (advanced.state.activeColor !== 'blue') fail(`M24: expected next color blue, got ${advanced.state.activeColor}`)
    ok('M24 — an ordinary move advances to the next color')
  }

  // --- M25: zero moves + non-6 -> next color ---
  {
    // Single red piece already at finish-5 (cannot move with any dice) -> zero legal moves.
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces: [finishPiece('red', 1, 5)] })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 3, expectedTurnVersion: 1 })
    if (rolled.state.turnPhase !== 'turn_complete') fail(`M25: expected turn_complete (zero legal moves), got ${rolled.state.turnPhase}`)
    if (rolled.state.pendingExtraRoll) fail('M25: non-6 zero-legal-moves roll must not set pendingExtraRoll')
    const advanced = reduceLudoGame(rolled.state, {
      type: 'TURN_ADVANCED',
      color: 'red',
      expectedTurnVersion: rolled.state.turnVersion,
    })
    if (advanced.state.activeColor !== 'blue') fail(`M25: expected next color blue, got ${advanced.state.activeColor}`)
    ok('M25 — zero legal moves + non-6 advances to the next color, no hang')
  }

  // --- M26: zero moves + 6 -> same color extra roll ---
  {
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces: [finishPiece('red', 1, 5)] })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 6, expectedTurnVersion: 1 })
    if (rolled.state.turnPhase !== 'turn_complete') fail(`M26: expected turn_complete (zero legal moves even with six), got ${rolled.state.turnPhase}`)
    if (rolled.state.legalMoves.length !== 0) fail('M26: setup error, expected zero legal moves')
    if (!rolled.state.pendingExtraRoll) fail('M26: six must still set pendingExtraRoll even with zero legal moves')
    const advanced = reduceLudoGame(rolled.state, {
      type: 'TURN_ADVANCED',
      color: 'red',
      expectedTurnVersion: rolled.state.turnVersion,
    })
    if (advanced.state.activeColor !== 'red') fail(`M26: expected red to keep the turn (six extra roll), got ${advanced.state.activeColor}`)
    if (advanced.state.turnPhase !== 'waiting_for_roll') fail('M26: expected a fresh waiting_for_roll, no hang and no 15s move timer')
    ok('M26 — zero legal moves + six grants the same player one extra roll, without a hang')
  }

  // --- M27: stale action rejected after extra roll ---
  {
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces: [trackPiece('red', 1, 4)] })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 6, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const advanced = reduceLudoGame(moveResult.state, {
      type: 'TURN_ADVANCED',
      color: 'red',
      expectedTurnVersion: moveResult.state.turnVersion,
    })
    // A stale action using the OLD (pre-extra-roll) turnVersion must be rejected against the NEW boundary.
    const staleAttempt = reduceLudoGame(advanced.state, {
      type: 'ROLL_STARTED',
      color: 'red',
      expectedTurnVersion: moveResult.state.turnVersion,
    })
    if (staleAttempt.state !== advanced.state) fail('M27: stale action (old turnVersion) after an extra-roll boundary must be rejected')
    if (staleAttempt.events.length !== 0) fail('M27: rejected stale action must produce no events')
    ok('M27 — a stale action from before the extra-roll boundary is rejected')
  }

  // --- M28: legalMoves correctly include home/track/finish target kinds ---
  {
    const homeMoves = computeLudoEngineLegalMoves([homePiece('red', 0)], 'red', 6)
    if (homeMoves[0]?.targetPosition.kind !== 'track') fail(`M28: home-exit move must target 'track', got ${JSON.stringify(homeMoves[0])}`)

    const trackMoves = computeLudoEngineLegalMoves([trackPiece('red', 1, 4)], 'red', 3)
    if (trackMoves[0]?.targetPosition.kind !== 'track') fail(`M28: ordinary move must target 'track', got ${JSON.stringify(trackMoves[0])}`)

    const finishMoves = computeLudoEngineLegalMoves([finishPiece('red', 2, 1)], 'red', 2)
    if (finishMoves[0]?.targetPosition.kind !== 'finish' || finishMoves[0]?.targetPosition.finishIndex !== 3) {
      fail(`M28: finish move must target 'finish', got ${JSON.stringify(finishMoves[0])}`)
    }
    ok('M28 — legalMoves cover home/track/finish target kinds correctly')
  }

  // --- M29: bot selection stays inside legalMoves ---
  {
    const legalMoves = computeLudoEngineLegalMoves(
      [homePiece('red', 0), trackPiece('red', 1, 14), trackPiece('blue', 2, 20)],
      'red',
      6,
    )
    if (legalMoves.length < 2) fail('M29: setup error, expected at least 2 legal moves')
    const picked = pickLudoBotMove(legalMoves)
    if (!picked) fail('M29: bot must pick a move when legalMoves is non-empty')
    if (!legalMoves.includes(picked)) fail('M29: bot picked a move object outside legalMoves')
    if (!picked.isCapture) fail('M29: bot must prefer the capture move when one is available')

    const noMoves = pickLudoBotMove([])
    if (noMoves !== null) fail('M29: bot must return null (never fake a move) when legalMoves is empty')
    ok('M29 — bot selection always stays inside authoritative legalMoves')
  }

  // --- M30: engine deterministic/pure for the new Phase 3B paths ---
  {
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces: [trackPiece('red', 1, 54)] })
    const snapshot = JSON.parse(JSON.stringify(rolling))
    const rolled1 = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 4, expectedTurnVersion: 1 })
    if (JSON.stringify(rolling) !== JSON.stringify(snapshot)) fail('M30: input state must not be mutated')
    const rolled2 = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 4, expectedTurnVersion: 1 })
    if (JSON.stringify(rolled1.state) !== JSON.stringify(rolled2.state)) fail('M30: identical input must produce identical output')

    const moveResult1 = reduceLudoGame(rolled1.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled1.state.turnVersion,
    })
    const finalPiece = moveResult1.state.pieces.find((p) => p.slot === 1)!
    if (finalPiece.position.kind !== 'finish' || finalPiece.position.finishIndex !== 1) {
      fail(`M30: expected the piece to land on finish-1 (track->finish move), got ${JSON.stringify(finalPiece.position)}`)
    }
    if (moveResult1.state.pieces === rolled1.state.pieces) fail('M30: MOVE_REQUESTED must produce a NEW pieces array reference')
    ok('M30 — engine remains deterministic and pure across the new home/track/finish paths')
  }

  console.log('[checkLudoMovementRules] ALL OK')
  process.exit(0)
}

main()
