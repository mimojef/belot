// Deterministic проверка на ownership-aware own-start-cell protection — НЕ
// browser check (чиста логика, без DOM/Playwright), огледално на
// checkLudoSafeCellCapture.ts. Ново правило (виж task-а): цветовото own
// exit/start поле е safe САМО за пионки ОТ ТОЗИ цвят, не глобално за всички
// (за разлика от съществуващия star safe cell, LUDO_SAFE_TRACK_INDICES,
// който е safe за всеки). Red на track-0 (red's own start) е protected;
// Blue landing на track-0 не capture-ва Red. Blue на track-0 НЕ е protected
// (не е неин own start) — capture-ва се нормално от когото и да е,
// включително от Red, когато Red излезе от base точно там.
//
// FIX локация: ludoIsOwnStartTrackIndex (нов helper, ludoGeometryConstants.ts,
// до съществуващия ludoIsSafeTrackIndex), consumed от ДВЕ места, консистентно:
//   - computeLudoEngineLegalMoves (isCapture computation, ludoEngineLegalMoves.ts)
//   - findLudoEngineCaptureVictims (victim filtering, ludoEngineCapture.ts) —
//     нужно отделно, защото isCapture е "съществува ли поне 1 unprotected
//     victim", докато victims listing-ът трябва да изключи КОНКРЕТНО
//     protected пионки от mixed stack, не всички пионки на клетката.
//
// Покрива сценариите от task-а:
//   OS1  own pawn на own start + enemy lands there -> no capture, coexist
//   OS2  pawn на чужд start + owner/enemy lands there -> normal capture
//   OS3  own pawn излиза от base на own start, където стои enemy -> enemy
//        може да бъде capture-ната (asymmetric collision случая)
//   OS4  multiple colors coexist на start square само когато protected own
//        pawn не може да бъде capture-ната (mixed stack: unprotected victim
//        се capture-ва, protected victim остава)
//   OS5  legal move highlighting не забранява движение само защото на
//        own-safe start има protected opponent (движението остава legal)
//   OS6  bot използва същото правило (computeLudoEngineLegalMoves е
//        единственият source, консумиран и от pickLudoBotMove)
//   OS7  star safe cell (LUDO_SAFE_TRACK_INDICES) остава непроменено —
//        глобална защита, не се бърка с own-start правилото
//   OS8  reconnect/snapshot state derive-ва от position+color+canonical
//        start index — няма нов persisted формат (структурна проверка:
//        LudoGamePiece няма ново поле)
//   OS9  explicit 3-color follow-up (RED protected + BLUE unprotected на
//        RED_START, GREEN arrives -> captures само BLUE, финална клетка
//        = RED+GREEN) + OS9-SYMMETRIC (различна цветова тройка/start
//        square — потвърждава правилото не е hardcoded по конкретни цветове)
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { reduceLudoGame } from '../src/app/games/ludo/engine/ludoEngineReducer'
import { createLudoEngineInitialState } from '../src/app/games/ludo/engine/ludoEngineState'
import { computeLudoEngineLegalMoves } from '../src/app/games/ludo/engine/ludoEngineLegalMoves'
import { findLudoEngineCaptureVictims } from '../src/app/games/ludo/engine/ludoEngineCapture'
import { pickLudoBotMove } from '../src/app/games/ludo/orchestrator/ludoBotPolicy'
import {
  LUDO_ENGINE_START_INDEX,
  ludoEngineIsOwnStartTrackIndex,
} from '../src/app/games/ludo/engine/ludoEngineGeometry'
import type { LudoGamePiece, LudoGameState, LudoColor, LudoPieceSlot } from '../src/app/games/ludo/engine/ludoEngineTypes'

function fail(message: string): never {
  console.error(`[checkLudoOwnStartSafeCapture] FAIL: ${message}`)
  process.exit(1)
}

function ok(label: string): void {
  console.log(`[checkLudoOwnStartSafeCapture] ${label} OK`)
}

function trackPiece(color: LudoColor, slot: LudoPieceSlot, trackIndex: number): LudoGamePiece {
  return { color, slot, position: { kind: 'track', trackIndex } }
}

function homePiece(color: LudoColor, slot: LudoPieceSlot): LudoGamePiece {
  return { color, slot, position: { kind: 'home', slot } }
}

function stateWith(overrides: Partial<LudoGameState>): LudoGameState {
  return { ...createLudoEngineInitialState(), ...overrides }
}

function main(): void {
  const RED_START = LUDO_ENGINE_START_INDEX.red

  // --- OS1: own pawn on own start + enemy lands there -> no capture, coexist ---
  {
    // red-0 already parked on red's own start; blue-1 moves 2 steps and
    // lands exactly on RED_START.
    const pieces = [trackPiece('red', 0, RED_START), trackPiece('blue', 1, (RED_START - 2 + 56) % 56)]
    const moves = computeLudoEngineLegalMoves(pieces, 'blue', 2)
    const move = moves.find((m) => m.slot === 1)
    if (!move) fail('OS1: setup error, expected a legal move for blue-1')
    if (move!.targetPosition.kind !== 'track' || move!.targetPosition.trackIndex !== RED_START) {
      fail(`OS1: setup error, expected landing on red's own start track-${RED_START}, got ${JSON.stringify(move!.targetPosition)}`)
    }
    if (move!.isCapture) fail("OS1: enemy landing on red's own start must NOT capture the protected red pawn there")
    ok('OS1 — own pawn on own start is protected; enemy landing there does not capture, both coexist')
  }

  // --- OS1 (state resolution): both pieces remain on the cell after the move ---
  {
    const pieces = [trackPiece('red', 0, RED_START), trackPiece('blue', 1, (RED_START - 2 + 56) % 56)]
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces, activeColor: 'blue' })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'blue', value: 2, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'blue',
      slot: 1,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const redAfter = moveResult.state.pieces.find((p) => p.color === 'red' && p.slot === 0)!
    if (redAfter.position.kind !== 'track' || redAfter.position.trackIndex !== RED_START) {
      fail(`OS1: protected red pawn must stay on its own start, got ${JSON.stringify(redAfter.position)}`)
    }
    const blueAfter = moveResult.state.pieces.find((p) => p.color === 'blue' && p.slot === 1)!
    if (blueAfter.position.kind !== 'track' || blueAfter.position.trackIndex !== RED_START) {
      fail(`OS1: mover must land on red's own start too (coexistence), got ${JSON.stringify(blueAfter.position)}`)
    }
    const capturedEvent = moveResult.events.find((e) => e.type === 'pieces_captured')
    if (capturedEvent) fail(`OS1: expected NO pieces_captured event, got ${JSON.stringify(capturedEvent)}`)
    if (moveResult.state.pendingExtraRoll) fail('OS1: coexistence landing must NOT grant a capture extra roll')
    ok('OS1 — post-move state: both pieces coexist on red start, no capture event, no extra roll')
  }

  // --- OS2: pawn на чужд start + enemy lands there via normal track movement -> normal capture ---
  {
    // blue-0 parked on RED's own start (NOT blue's own start) — unprotected.
    // green-2 approaches via ordinary track movement (green's own start is
    // 42, far from red's 0 — a normal in-lap landing, not a full-lap-back-
    // to-own-start case like red would need) and lands exactly there.
    // NOTE: red itself can only ever reach its OWN start (stepsFromStart=0)
    // via home-exit (see OS3) — a full lap back to steps=0 is structurally
    // a finish-lane entry, not a track landing — so "the owner lands there
    // via normal movement" is not a reachable engine state; the meaningful
    // "normal capture on a foreign start square" case is any OTHER color
    // (owner or not) landing there via ordinary movement, covered here.
    const pieces = [trackPiece('blue', 0, RED_START), trackPiece('green', 2, (RED_START - 3 + 56) % 56)]
    const moves = computeLudoEngineLegalMoves(pieces, 'green', 3)
    const move = moves.find((m) => m.slot === 2)
    if (!move) fail('OS2: setup error, expected a legal move for green-2')
    if (move!.targetPosition.kind !== 'track' || move!.targetPosition.trackIndex !== RED_START) {
      fail(`OS2: setup error, expected landing on red's start track-${RED_START}, got ${JSON.stringify(move!.targetPosition)}`)
    }
    if (!move!.isCapture) fail("OS2: blue parked on red's (not blue's own) start must be capturable by ANY other color via normal movement")
    ok("OS2 — enemy pawn parked on a start square that is NOT its own is a normal capture target for any other color landing there via ordinary movement")
  }

  // --- OS3: own pawn leaves base onto own start, where an enemy sits -> enemy captured (asymmetric collision) ---
  {
    // blue-0 sits on RED_START (unprotected there — not blue's own start).
    // red-2 is in home and rolls a 6 -> exits directly onto RED_START.
    const pieces = [trackPiece('blue', 0, RED_START), homePiece('red', 2)]
    const moves = computeLudoEngineLegalMoves(pieces, 'red', 6)
    const move = moves.find((m) => m.slot === 2)
    if (!move) fail('OS3: setup error, expected a legal home-exit move for red-2')
    if (move!.targetPosition.kind !== 'track' || move!.targetPosition.trackIndex !== RED_START) {
      fail(`OS3: setup error, expected home-exit landing on red's own start track-${RED_START}, got ${JSON.stringify(move!.targetPosition)}`)
    }
    if (!move!.isCapture) fail('OS3: red exiting base onto its own start, where an unprotected enemy (blue) sits, must capture it')
    ok('OS3 — own pawn exiting base onto its own start captures an unprotected enemy already parked there (asymmetric collision)')
  }

  // --- OS3 (state resolution + reverse of OS1): full move application ---
  {
    const pieces = [trackPiece('blue', 0, RED_START), homePiece('red', 2)]
    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces, activeColor: 'red' })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'red', value: 6, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'red',
      slot: 2,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const blueAfter = moveResult.state.pieces.find((p) => p.color === 'blue' && p.slot === 0)!
    if (blueAfter.position.kind !== 'home') fail(`OS3: expected blue captured back home, got ${JSON.stringify(blueAfter.position)}`)
    const redAfter = moveResult.state.pieces.find((p) => p.color === 'red' && p.slot === 2)!
    if (redAfter.position.kind !== 'track' || redAfter.position.trackIndex !== RED_START) {
      fail(`OS3: expected red on its own start after exiting, got ${JSON.stringify(redAfter.position)}`)
    }
    const capturedEvent = moveResult.events.find((e) => e.type === 'pieces_captured')
    if (!capturedEvent) fail('OS3: expected a pieces_captured event for the capture')
    if (!moveResult.state.pendingExtraRoll) fail('OS3: capture must still grant an extra roll (normal capture rule applies)')
    ok('OS3 — full asymmetry confirmed: same square (red start), Blue earlier protected Red there, but Red later captures Blue there')
  }

  // --- OS4: mixed stack -> unprotected victim captured, protected own-start pawn stays ---
  {
    // red-0 parked on ITS OWN start (protected). blue-1 ALSO on the same
    // index (unprotected, since it's not blue's own start). green-3
    // approaches via ordinary track movement (green's own start is 42, a
    // normal in-lap landing on red's start — see OS2's note on why red
    // itself can never reach RED_START except via home-exit) — must
    // capture blue but NOT red.
    const pieces = [trackPiece('red', 0, RED_START), trackPiece('blue', 1, RED_START), trackPiece('green', 3, (RED_START - 3 + 56) % 56)]
    const moves = computeLudoEngineLegalMoves(pieces, 'green', 3)
    const move = moves.find((m) => m.slot === 3)
    if (!move) fail('OS4: setup error, expected a legal move for green-3')
    if (move!.targetPosition.kind !== 'track' || move!.targetPosition.trackIndex !== RED_START) {
      fail(`OS4: setup error, expected landing on red's own start track-${RED_START}, got ${JSON.stringify(move!.targetPosition)}`)
    }
    if (!move!.isCapture) fail('OS4: landing on a mixed stack with at least one unprotected victim (blue) must be a capture')
    const victims = findLudoEngineCaptureVictims(pieces, RED_START, 'green')
    if (victims.some((v) => v.color === 'red')) fail("OS4: protected red pawn (on its own start) must NOT be among the victims")
    if (!victims.some((v) => v.color === 'blue')) fail('OS4: unprotected blue pawn must be among the victims')
    if (victims.length !== 1) fail(`OS4: expected exactly 1 victim (blue only), got ${victims.length}: ${JSON.stringify(victims.map((v) => v.color))}`)
    ok('OS4a — mixed stack on own-start square: unprotected victim identified correctly, protected own pawn excluded')

    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces, activeColor: 'green' })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'green', value: 3, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'green',
      slot: 3,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const redAfter = moveResult.state.pieces.find((p) => p.color === 'red' && p.slot === 0)!
    if (redAfter.position.kind !== 'track' || redAfter.position.trackIndex !== RED_START) {
      fail(`OS4: protected red pawn must remain on the shared cell after the move, got ${JSON.stringify(redAfter.position)}`)
    }
    const blueAfter = moveResult.state.pieces.find((p) => p.color === 'blue' && p.slot === 1)!
    if (blueAfter.position.kind !== 'home') fail(`OS4: unprotected blue pawn must be captured back home, got ${JSON.stringify(blueAfter.position)}`)
    const greenAfter = moveResult.state.pieces.find((p) => p.color === 'green' && p.slot === 3)!
    if (greenAfter.position.kind !== 'track' || greenAfter.position.trackIndex !== RED_START) {
      fail(`OS4: green mover must land on the shared cell, got ${JSON.stringify(greenAfter.position)}`)
    }
    const capturedEvent = moveResult.events.find((e) => e.type === 'pieces_captured')
    if (!capturedEvent || capturedEvent.type !== 'pieces_captured') fail('OS4: expected a pieces_captured event')
    if (capturedEvent.capturedPieceIds.length !== 1 || !capturedEvent.capturedPieceIds[0]!.startsWith('blue-')) {
      fail(`OS4: expected exactly 1 captured id (blue only), got ${JSON.stringify(capturedEvent.capturedPieceIds)}`)
    }
    ok('OS4b — mixed stack move application: red stays protected, blue captured home, green lands and coexists with red')
  }

  // --- OS9: explicit 3-color scenario (task follow-up) — RED protected on
  // its own start, BLUE unprotected there, GREEN arrives and captures ONLY
  // blue. Same rule as OS4, but stated explicitly per the task's exact
  // wording/assertions (RED+BLUE already on RED_START -> GREEN lands ->
  // RED stays, BLUE goes home, GREEN coexists with RED). ---
  {
    const pieces = [trackPiece('red', 0, RED_START), trackPiece('blue', 1, RED_START), trackPiece('green', 2, (RED_START - 4 + 56) % 56)]
    const moves = computeLudoEngineLegalMoves(pieces, 'green', 4)
    const move = moves.find((m) => m.slot === 2)
    if (!move) fail('OS9: setup error, expected a legal move for green-2')
    if (move!.targetPosition.kind !== 'track' || move!.targetPosition.trackIndex !== RED_START) {
      fail(`OS9: setup error, expected landing on red's own start track-${RED_START}, got ${JSON.stringify(move!.targetPosition)}`)
    }
    if (!move!.isCapture) fail('OS9: green landing on RED_START (occupied by protected red + unprotected blue) must be a capture (blue is capturable)')
    const victims = findLudoEngineCaptureVictims(pieces, RED_START, 'green')
    if (victims.some((v) => v.color === 'red')) fail("OS9: RED must NOT be reported as a victim — its own-start protection must not be bypassed by BLUE's presence")
    if (!victims.some((v) => v.color === 'blue')) fail('OS9: BLUE must be reported as a victim (unprotected on a foreign start square)')
    if (victims.length !== 1) fail(`OS9: expected exactly 1 victim (blue only), got ${victims.length}: ${JSON.stringify(victims.map((v) => v.color))}`)

    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces, activeColor: 'green' })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'green', value: 4, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'green',
      slot: 2,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const redAfter = moveResult.state.pieces.find((p) => p.color === 'red' && p.slot === 0)!
    if (redAfter.position.kind !== 'track' || redAfter.position.trackIndex !== RED_START) {
      fail(`OS9: RED pawn must remain on RED_START — не се capture-ва, got ${JSON.stringify(redAfter.position)}`)
    }
    const blueAfter = moveResult.state.pieces.find((p) => p.color === 'blue' && p.slot === 1)!
    if (blueAfter.position.kind !== 'home') fail(`OS9: BLUE pawn must be captured and returned to base, got ${JSON.stringify(blueAfter.position)}`)
    const greenAfter = moveResult.state.pieces.find((p) => p.color === 'green' && p.slot === 2)!
    if (greenAfter.position.kind !== 'track' || greenAfter.position.trackIndex !== RED_START) {
      fail(`OS9: GREEN pawn must remain on RED_START (coexisting with RED), got ${JSON.stringify(greenAfter.position)}`)
    }
    const finalOccupants = moveResult.state.pieces.filter((p) => p.position.kind === 'track' && p.position.trackIndex === RED_START).map((p) => p.color).sort()
    if (JSON.stringify(finalOccupants) !== JSON.stringify(['green', 'red'])) {
      fail(`OS9: expected RED_START to contain exactly [green, red] after the move, got ${JSON.stringify(finalOccupants)}`)
    }
    const capturedEvent = moveResult.events.find((e) => e.type === 'pieces_captured')
    if (!capturedEvent || capturedEvent.type !== 'pieces_captured') fail('OS9: expected a pieces_captured event (blue must register as a captured victim)')
    if (capturedEvent.capturedPieceIds.length !== 1 || !capturedEvent.capturedPieceIds[0]!.startsWith('blue-')) {
      fail(`OS9: expected exactly 1 captured id (blue only), got ${JSON.stringify(capturedEvent.capturedPieceIds)}`)
    }
    ok('OS9 — explicit 3-color scenario: RED (own-start-protected) stays, BLUE (unprotected) captured to base, GREEN coexists with RED; final cell = RED+GREEN')
  }

  // --- OS9-SYMMETRIC: same rule shape, different color triple + different
  // start square — confirms the rule is NOT hardcoded to red/blue/green or
  // to RED_START specifically. Owner=YELLOW, protected=YELLOW pawn on its
  // own start, unprotected=RED pawn parked there, BLUE arrives and captures
  // only red. ---
  {
    const YELLOW_START = LUDO_ENGINE_START_INDEX.yellow
    const pieces = [trackPiece('yellow', 0, YELLOW_START), trackPiece('red', 1, YELLOW_START), trackPiece('blue', 2, (YELLOW_START - 5 + 56) % 56)]
    const moves = computeLudoEngineLegalMoves(pieces, 'blue', 5)
    const move = moves.find((m) => m.slot === 2)
    if (!move) fail('OS9-SYMMETRIC: setup error, expected a legal move for blue-2')
    if (move!.targetPosition.kind !== 'track' || move!.targetPosition.trackIndex !== YELLOW_START) {
      fail(`OS9-SYMMETRIC: setup error, expected landing on yellow's own start track-${YELLOW_START}, got ${JSON.stringify(move!.targetPosition)}`)
    }
    if (!move!.isCapture) fail('OS9-SYMMETRIC: blue landing on YELLOW_START (occupied by protected yellow + unprotected red) must be a capture')
    const victims = findLudoEngineCaptureVictims(pieces, YELLOW_START, 'blue')
    if (victims.some((v) => v.color === 'yellow')) fail('OS9-SYMMETRIC: YELLOW must NOT be a victim — protection on its own start must hold regardless of which colors are involved')
    if (!victims.some((v) => v.color === 'red')) fail('OS9-SYMMETRIC: RED must be a victim (unprotected on a foreign start square)')
    if (victims.length !== 1) fail(`OS9-SYMMETRIC: expected exactly 1 victim (red only), got ${victims.length}: ${JSON.stringify(victims.map((v) => v.color))}`)

    const rolling = stateWith({ turnPhase: 'rolling', turnVersion: 1, pieces, activeColor: 'blue' })
    const rolled = reduceLudoGame(rolling, { type: 'ROLL_RESOLVED', color: 'blue', value: 5, expectedTurnVersion: 1 })
    const moveResult = reduceLudoGame(rolled.state, {
      type: 'MOVE_REQUESTED',
      color: 'blue',
      slot: 2,
      expectedTurnVersion: rolled.state.turnVersion,
    })
    const yellowAfter = moveResult.state.pieces.find((p) => p.color === 'yellow' && p.slot === 0)!
    if (yellowAfter.position.kind !== 'track' || yellowAfter.position.trackIndex !== YELLOW_START) {
      fail(`OS9-SYMMETRIC: YELLOW pawn must remain on YELLOW_START, got ${JSON.stringify(yellowAfter.position)}`)
    }
    const redAfter = moveResult.state.pieces.find((p) => p.color === 'red' && p.slot === 1)!
    if (redAfter.position.kind !== 'home') fail(`OS9-SYMMETRIC: RED pawn must be captured and returned to base, got ${JSON.stringify(redAfter.position)}`)
    const blueAfter = moveResult.state.pieces.find((p) => p.color === 'blue' && p.slot === 2)!
    if (blueAfter.position.kind !== 'track' || blueAfter.position.trackIndex !== YELLOW_START) {
      fail(`OS9-SYMMETRIC: BLUE pawn must remain on YELLOW_START (coexisting with YELLOW), got ${JSON.stringify(blueAfter.position)}`)
    }
    const finalOccupants = moveResult.state.pieces.filter((p) => p.position.kind === 'track' && p.position.trackIndex === YELLOW_START).map((p) => p.color).sort()
    if (JSON.stringify(finalOccupants) !== JSON.stringify(['blue', 'yellow'])) {
      fail(`OS9-SYMMETRIC: expected YELLOW_START to contain exactly [blue, yellow] after the move, got ${JSON.stringify(finalOccupants)}`)
    }
    ok('OS9-SYMMETRIC — rule confirmed color-agnostic: different triple (yellow/red/blue) and different start square (YELLOW_START) produce the identical protection pattern')
  }

  // --- OS5: legal move highlighting still allows the move (never marked illegal) ---
  {
    // Re-confirm OS1's move IS present in legalMoves (not filtered out) —
    // the protection only ever affects isCapture, never move availability.
    const pieces = [trackPiece('red', 0, RED_START), trackPiece('blue', 1, (RED_START - 2 + 56) % 56)]
    const moves = computeLudoEngineLegalMoves(pieces, 'blue', 2)
    if (moves.length !== 1) fail(`OS5: expected exactly 1 legal move for blue, got ${moves.length}`)
    const move = moves[0]!
    if (move.slot !== 1 || move.targetPosition.kind !== 'track' || move.targetPosition.trackIndex !== RED_START) {
      fail(`OS5: expected the only legal move to land on red's own start, got ${JSON.stringify(move)}`)
    }
    ok("OS5 — legal move highlighting never suppresses a move just because a protected own-start pawn occupies the target")
  }

  // --- OS6: bot uses the same rule (via the shared legalMoves array) ---
  {
    const pieces = [trackPiece('red', 0, RED_START), trackPiece('blue', 1, (RED_START - 2 + 56) % 56)]
    const legalMoves = computeLudoEngineLegalMoves(pieces, 'blue', 2)
    const botMove = pickLudoBotMove(legalMoves)
    if (!botMove) fail('OS6: setup error, expected a legal bot move')
    if (botMove!.isCapture) {
      fail("OS6: bot move onto a protected own-start opponent must not be marked as a capture (bot reads the same legalMoves array as the human path)")
    }
    ok('OS6 — bot consumes the same engine legalMoves, so the own-start protection applies identically')
  }

  // --- OS7: existing star safe cell (globally safe) remains unaffected ---
  {
    if (!ludoEngineIsOwnStartTrackIndex('red', RED_START)) fail('OS7: setup error, red should own its own start index')
    if (ludoEngineIsOwnStartTrackIndex('blue', RED_START)) fail("OS7: setup error, blue must NOT own red's start index")
    // Every color's own-start index must be distinct from the OTHER colors'
    // own-start indices (no accidental overlap in the canonical mapping).
    const colors: LudoColor[] = ['red', 'blue', 'yellow', 'green']
    for (const color of colors) {
      const idx = LUDO_ENGINE_START_INDEX[color]
      for (const other of colors) {
        if (other === color) continue
        if (ludoEngineIsOwnStartTrackIndex(other, idx)) {
          fail(`OS7: ${other}'s protection must not incorrectly claim ${color}'s own start index ${idx}`)
        }
      }
    }
    ok("OS7 — own-start ownership mapping is exclusive per color, no cross-color leakage; global star-safe rule untouched (see checkLudoSafeCellCapture.ts)")
  }

  // --- OS8: no new persisted field — protection is fully derived from position+color+canonical start index ---
  {
    const piece: LudoGamePiece = trackPiece('red', 0, RED_START)
    const keys = Object.keys(piece).sort()
    if (JSON.stringify(keys) !== JSON.stringify(['color', 'position', 'slot'])) {
      fail(`OS8: LudoGamePiece must only have color/position/slot fields (no new persisted safe-flag), got ${JSON.stringify(keys)}`)
    }
    ok('OS8 — no new persisted state shape: protection is derived purely from position.trackIndex + piece.color + canonical LUDO_ENGINE_START_INDEX')
  }
}

main()
console.log('[checkLudoOwnStartSafeCapture] ALL OK')
