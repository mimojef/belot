// Deterministic проверка на safe/star-cell capture immunity — НЕ browser
// check (чиста логика, без DOM/Playwright), огледално на
// checkLudoMovementRules.ts. Fix за production bug: opponent piece стояща на
// safe/star клетка (LUDO_SAFE_TRACK_INDICES, ludoGeometryConstants.ts) беше
// грешно capture-вана при landing на локалната пионка.
//
// ROOT CAUSE (виж git history на fix-а): safe клетките бяха дефинирани
// САМО в board/ludoBoardGeometry.ts::ludoSafeCellIds() с explicit doc
// коментар "Чисто presentation marker — НЕ engine rule" — capture logic-ата
// в engine/ludoEngineLegalMoves.ts никога не е проверявала safe zone.
//
// FIX: LUDO_SAFE_TRACK_INDICES е нов canonical export в
// ludoGeometryConstants.ts (единствен source of truth), re-export-нат И от
// engine/ludoEngineGeometry.ts (ludoEngineIsSafeTrackIndex) И consumed от
// board/ludoBoardGeometry.ts::ludoSafeCellIds() (rendering, вече derive-нато
// вместо дублирано изчисление). computeLudoEngineLegalMoves()-ovoto
// isCapture вече е false, ако target track index е safe — движението
// остава LEGAL (пионките coexist-ват на клетката, engine-ът вече поддържа
// мулти-цветен track occupancy навсякъде другаде), просто не се тригва
// capture resolution (нито victim->home, нито pieces_captured event, нито
// extra roll от capture).
//
// Покрива SAFE1-SAFE9 от task-а (SAFE10 — desktop/mobile rendering — се
// проверява отделно чрез checkLudoMovementRulesBrowser.ts overflow checks,
// safe star marker-ът вече беше рендиран преди този fix, непроменен тук):
//   SAFE1  opponent on star -> landing/collision does not capture it
//   SAFE2  victim remains on the same safe cell (coexistence, not bounced)
//   SAFE3  no capture extra roll for a safe-cell landing
//   SAFE4  no pieces_captured event (=> no capture presentation/explosion)
//   SAFE5  normal non-star exact landing on opponent -> capture still works
//   SAFE6  normal capture -> victim returns home
//   SAFE7  normal capture -> extra roll still granted
//   SAFE8  bot uses the same safe rule (computeLudoEngineLegalMoves is the
//          single source bots also consume, via pickLudoBotMove)
//   SAFE9  all 4 safe indices on the 56-cell track are correctly recognized
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { reduceLudoGame } from '../src/app/games/ludo/engine/ludoEngineReducer'
import { createLudoEngineInitialState } from '../src/app/games/ludo/engine/ludoEngineState'
import { computeLudoEngineLegalMoves } from '../src/app/games/ludo/engine/ludoEngineLegalMoves'
import { pickLudoBotMove } from '../src/app/games/ludo/orchestrator/ludoBotPolicy'
import {
  LUDO_ENGINE_SAFE_TRACK_INDICES,
  ludoEngineIsSafeTrackIndex,
} from '../src/app/games/ludo/engine/ludoEngineGeometry'
import { ludoSafeCellIds } from '../src/app/games/ludo/board/ludoBoardGeometry'
import { ludoCellId } from '../src/app/games/ludo/ludoTypes'
import type { LudoGamePiece, LudoGameState, LudoColor, LudoPieceSlot } from '../src/app/games/ludo/engine/ludoEngineTypes'

function fail(message: string): never {
  console.error(`[checkLudoSafeCellCapture] FAIL: ${message}`)
  process.exit(1)
}

function ok(label: string): void {
  console.log(`[checkLudoSafeCellCapture] ${label} OK`)
}

function trackPiece(color: LudoColor, slot: LudoPieceSlot, trackIndex: number): LudoGamePiece {
  return { color, slot, position: { kind: 'track', trackIndex } }
}

function stateWith(overrides: Partial<LudoGameState>): LudoGameState {
  return { ...createLudoEngineInitialState(), ...overrides }
}

function main(): void {
  const SAFE_RED = LUDO_ENGINE_SAFE_TRACK_INDICES[0]! // red safe cell (start+8)

  // --- SAFE1: opponent on star -> landing/collision does not capture it ---
  {
    // red-1 на track-(SAFE_RED-2), dice=2 -> lands точно на blue-0's safe cell.
    const pieces = [trackPiece('red', 1, (SAFE_RED - 2 + 56) % 56), trackPiece('blue', 0, SAFE_RED)]
    const moves = computeLudoEngineLegalMoves(pieces, 'red', 2)
    const move = moves.find((m) => m.slot === 1)
    if (!move) fail('SAFE1: setup error, expected a legal move for red-1')
    if (move!.targetPosition.kind !== 'track' || move!.targetPosition.trackIndex !== SAFE_RED) {
      fail(`SAFE1: setup error, expected landing on safe track-${SAFE_RED}, got ${JSON.stringify(move!.targetPosition)}`)
    }
    if (move!.isCapture) fail('SAFE1: landing on an opponent piece parked on a safe/star cell must NOT be a capture')
    ok('SAFE1 — opponent parked on a safe/star cell is never marked as a capture target')
  }

  // --- SAFE2: victim remains on the same safe cell after the move resolves ---
  {
    const pieces = [trackPiece('red', 1, (SAFE_RED - 2 + 56) % 56), trackPiece('blue', 0, SAFE_RED)]
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 2, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const blueAfter = moveResult.state.pieces.find((p) => p.color === 'blue' && p.slot === 0)!
    if (blueAfter.position.kind !== 'track' || blueAfter.position.trackIndex !== SAFE_RED) {
      fail(`SAFE2: victim on a safe cell must stay put, got ${JSON.stringify(blueAfter.position)}`)
    }
    const redAfter = moveResult.state.pieces.find((p) => p.color === 'red' && p.slot === 1)!
    if (redAfter.position.kind !== 'track' || redAfter.position.trackIndex !== SAFE_RED) {
      fail(`SAFE2: mover must land on the safe cell too (coexistence), got ${JSON.stringify(redAfter.position)}`)
    }
    ok('SAFE2 — victim remains on the same safe cell; both pieces coexist there')
  }

  // --- SAFE3: no capture extra roll for a safe-cell landing ---
  {
    const pieces = [trackPiece('red', 1, (SAFE_RED - 2 + 56) % 56), trackPiece('blue', 0, SAFE_RED)]
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 2, expectedTurnVersion: 1 })
    if (rolled.state.pendingExtraRoll) fail('SAFE3: setup error, dice=2 alone must not set pendingExtraRoll')
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    if (moveResult.state.pendingExtraRoll) fail('SAFE3: a safe-cell landing must NOT grant an extra roll')
    const advanced = reduceLudoGame(moveResult.state, {
      type: 'TURN_ADVANCED',
      color: 'red',
      expectedTurnVersion: moveResult.state.turnVersion,
    })
    if (advanced.state.activeColor !== 'blue') fail(`SAFE3: expected turn to pass to blue, got ${advanced.state.activeColor}`)
    ok('SAFE3 — no capture extra roll for a safe-cell landing')
  }

  // --- SAFE4: no pieces_captured event (=> no capture presentation/explosion) ---
  {
    const pieces = [trackPiece('red', 1, (SAFE_RED - 2 + 56) % 56), trackPiece('blue', 0, SAFE_RED)]
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 2, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const capturedEvent = moveResult.events.find((e) => e.type === 'pieces_captured')
    if (capturedEvent) fail(`SAFE4: expected NO pieces_captured event, got ${JSON.stringify(capturedEvent)}`)
    ok('SAFE4 — no pieces_captured event emitted (controller never triggers capture animation)')
  }

  // --- SAFE5: normal non-star exact landing on opponent -> capture still works ---
  {
    // red safe cell is at SAFE_RED; pick a definitely non-safe target a few
    // cells away from it (not any of the 4 safe indices).
    const targetIndex = (SAFE_RED + 3) % 56
    if (ludoEngineIsSafeTrackIndex(targetIndex)) fail('SAFE5: setup error, chosen target must NOT be a safe cell')
    const pieces = [trackPiece('red', 1, (targetIndex - 2 + 56) % 56), trackPiece('blue', 0, targetIndex)]
    const moves = computeLudoEngineLegalMoves(pieces, 'red', 2)
    const move = moves.find((m) => m.slot === 1)
    if (!move) fail('SAFE5: setup error, expected a legal move for red-1')
    if (move!.targetPosition.kind !== 'track' || move!.targetPosition.trackIndex !== targetIndex) {
      fail(`SAFE5: setup error, expected landing on track-${targetIndex}, got ${JSON.stringify(move!.targetPosition)}`)
    }
    if (!move!.isCapture) fail('SAFE5: exact landing on an opponent on a NON-safe cell must still be a capture')
    ok('SAFE5 — normal non-star exact landing on an opponent is still a capture')
  }

  // --- SAFE6: normal capture -> victim returns home ---
  {
    const targetIndex = (SAFE_RED + 3) % 56
    const pieces = [trackPiece('red', 1, (targetIndex - 2 + 56) % 56), trackPiece('blue', 0, targetIndex)]
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 2, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const blueAfter = moveResult.state.pieces.find((p) => p.color === 'blue' && p.slot === 0)!
    if (blueAfter.position.kind !== 'home') fail(`SAFE6: expected victim back home, got ${JSON.stringify(blueAfter.position)}`)
    const capturedEvent = moveResult.events.find((e) => e.type === 'pieces_captured')
    if (!capturedEvent) fail('SAFE6: expected a pieces_captured event for a normal (non-safe) capture')
    ok('SAFE6 — normal capture still returns the victim home (regression guard)')
  }

  // --- SAFE7: normal capture -> extra roll still granted ---
  {
    const targetIndex = (SAFE_RED + 3) % 56
    const pieces = [trackPiece('red', 1, (targetIndex - 2 + 56) % 56), trackPiece('blue', 0, targetIndex)]
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 2, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    if (!moveResult.state.pendingExtraRoll) fail('SAFE7: expected pendingExtraRoll after a normal (non-safe) capture')
    ok('SAFE7 — normal capture still grants exactly one extra roll (regression guard)')
  }

  // --- SAFE8: bot uses the same safe rule (via the shared legalMoves array) ---
  {
    const pieces = [trackPiece('blue', 1, (SAFE_RED - 2 + 56) % 56), trackPiece('red', 0, SAFE_RED)]
    const legalMoves = computeLudoEngineLegalMoves(pieces, 'blue', 2)
    const botMove = pickLudoBotMove(legalMoves)
    if (!botMove) fail('SAFE8: setup error, expected a legal bot move')
    if (botMove!.isCapture) {
      fail('SAFE8: bot move onto an opponent parked on a safe cell must not be marked as a capture (bot reads the same legalMoves array as the human path)')
    }
    ok('SAFE8 — bot consumes the same engine legalMoves, so the safe rule applies identically')
  }

  // --- SAFE9: all 4 safe indices on the 56-cell track are correctly recognized ---
  {
    if (LUDO_ENGINE_SAFE_TRACK_INDICES.length !== 4) {
      fail(`SAFE9: expected exactly 4 safe track indices, got ${LUDO_ENGINE_SAFE_TRACK_INDICES.length}`)
    }
    for (const index of LUDO_ENGINE_SAFE_TRACK_INDICES) {
      if (index < 0 || index >= 56) fail(`SAFE9: safe index ${index} out of range [0,56)`)
      if (!ludoEngineIsSafeTrackIndex(index)) fail(`SAFE9: ludoEngineIsSafeTrackIndex(${index}) must be true`)
    }
    // Симетрично разположени, 14 клетки едно от друго (равни на interval-a
    // между start индексите) — потвърждава offset-ът е приложен спрямо
    // ВСЕКИ start еднакво, не само спрямо red.
    const sorted = [...LUDO_ENGINE_SAFE_TRACK_INDICES].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i += 1) {
      const delta = sorted[i]! - sorted[i - 1]!
      if (delta !== 14) fail(`SAFE9: expected 14-cell spacing between safe indices, got ${delta} (between ${sorted[i - 1]} and ${sorted[i]})`)
    }
    // rendering слоят (ludoSafeCellIds, board/ludoBoardGeometry.ts) трябва
    // да произведе ТОЧНО същите track индекси, обвити в cell id-та — един
    // source of truth, не дублирано изчисление.
    const renderedIds = new Set(ludoSafeCellIds())
    for (const index of LUDO_ENGINE_SAFE_TRACK_INDICES) {
      const expectedId = ludoCellId({ kind: 'track', index })
      if (!renderedIds.has(expectedId)) {
        fail(`SAFE9: rendering layer (ludoSafeCellIds) missing safe cell id ${expectedId} present in the engine's canonical list`)
      }
    }
    if (renderedIds.size !== 4) fail(`SAFE9: rendering layer must expose exactly 4 safe cell ids, got ${renderedIds.size}`)
    ok('SAFE9 — all 4 safe track indices recognized consistently by engine AND rendering layer')
  }

  console.log('[checkLudoSafeCellCapture] ALL OK')
  process.exit(0)
}

main()
