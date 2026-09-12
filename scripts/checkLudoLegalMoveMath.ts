// Deterministic проверка на Ludo legal-move математиката (computeLudoLegalMoves)
// — НЕ browser check (чиста логика, без DOM/Playwright). Написан след audit,
// който откри, че старите hardcoded legalMoves в ludoMockState.ts показваха
// capture на разстояние 5 клетки, докато зарът показваше 6. Проверява:
//   1. track-4 + 6 = track-10 (ludoAdvanceTrackIndex)
//   2. track-22 + 6 = track-28
//   3. route за dice=6 съдържа точно 6 стъпки
//   4. противник на step 5 (не target-а) НЕ води до capture
//   5. противник точно на step 6 (target-а) води до capture
//   6. wrap track-55 + 1 = track-0
//   7. wrap track-53 + 6 = track-3
//   8. реалният mock сценарий (red-2 на track-22, dice=6, blue-3 на
//      track-27 — точно случаят от bug report-а) вече НЕ дава capture.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { ludoAdvanceTrackIndex } from '../src/app/games/ludo/board/ludoBoardGeometry'
import { buildLudoMoveRoute } from '../src/app/games/ludo/board/ludoMoveRoute'
import { computeLudoLegalMoves } from '../src/app/games/ludo/board/computeLudoLegalMoves'
import { createLudoMockPieces } from '../src/app/games/ludo/mock/ludoMockState'
import { ludoCellId } from '../src/app/games/ludo/ludoTypes'
import type { LudoPiece } from '../src/app/games/ludo/ludoTypes'

function fail(message: string): never {
  console.error(`[checkLudoLegalMoveMath] FAIL: ${message}`)
  process.exit(1)
}

function trackCell(index: number) {
  return ludoCellId({ kind: 'track', index })
}

function main(): void {
  // 1: track-4 + 6 = track-10
  const t1 = ludoAdvanceTrackIndex(4, 6)
  if (t1 !== 10) fail(`ludoAdvanceTrackIndex(4, 6) expected 10, got ${t1}`)

  // 2: track-22 + 6 = track-28
  const t2 = ludoAdvanceTrackIndex(22, 6)
  if (t2 !== 28) fail(`ludoAdvanceTrackIndex(22, 6) expected 28, got ${t2}`)

  // 3: route за dice=6 съдържа точно 6 стъпки
  const route = buildLudoMoveRoute(trackCell(4), trackCell(t1))
  if (route.length !== 6) fail(`route from track-4 to track-${t1} expected 6 steps, got ${route.length} (${route.join(', ')})`)

  // 4 + 5: capture само на step 6, не на step 5.
  const piecesStep5Opponent: LudoPiece[] = [
    { id: 'red-1', color: 'red', cell: trackCell(22) },
    { id: 'blue-1', color: 'blue', cell: trackCell(27) }, // step 5 от 22, НЕ target (28)
  ]
  const movesStep5 = computeLudoLegalMoves(piecesStep5Opponent, 'red', 6)
  const moveStep5 = movesStep5.find((m) => m.pieceId === 'red-1')
  if (!moveStep5) fail('expected a legal move for red-1 in step5-opponent scenario')
  if (moveStep5!.targetCell !== trackCell(28)) {
    fail(`expected target track-28, got ${moveStep5!.targetCell}`)
  }
  if (moveStep5!.type === 'capture') {
    fail('opponent on step 5 (track-27) must NOT trigger capture when target is track-28')
  }

  const piecesStep6Opponent: LudoPiece[] = [
    { id: 'red-1', color: 'red', cell: trackCell(22) },
    { id: 'blue-1', color: 'blue', cell: trackCell(28) }, // step 6 = target
  ]
  const movesStep6 = computeLudoLegalMoves(piecesStep6Opponent, 'red', 6)
  const moveStep6 = movesStep6.find((m) => m.pieceId === 'red-1')
  if (!moveStep6) fail('expected a legal move for red-1 in step6-opponent scenario')
  if (moveStep6!.type !== 'capture') {
    fail('opponent exactly on target (track-28, step 6) must trigger capture')
  }

  // 6: wrap track-55 + 1 = track-0
  const wrap1 = ludoAdvanceTrackIndex(55, 1)
  if (wrap1 !== 0) fail(`ludoAdvanceTrackIndex(55, 1) expected 0, got ${wrap1}`)

  // 7: wrap track-53 + 6 = track-3
  const wrap2 = ludoAdvanceTrackIndex(53, 6)
  if (wrap2 !== 3) fail(`ludoAdvanceTrackIndex(53, 6) expected 3, got ${wrap2}`)

  // 8: реалният bug-report сценарий (createLudoMockPieces, red на ход,
  // dice=6) — red-2 (track-22) вече НЕ трябва да сочи capture към blue-3
  // (track-27, само 5 стъпки), а към track-28 (нормален ход, без противник).
  const mockPieces = createLudoMockPieces()
  const mockMoves = computeLudoLegalMoves(mockPieces, 'red', 6)

  const red1Move = mockMoves.find((m) => m.pieceId === 'red-1')
  if (!red1Move) fail('expected legal move for red-1 in real mock scenario')
  if (red1Move!.targetCell !== trackCell(10)) fail(`red-1 expected target track-10, got ${red1Move!.targetCell}`)
  if (red1Move!.type !== 'normal') fail(`red-1 expected type=normal, got ${red1Move!.type}`)

  const red2Move = mockMoves.find((m) => m.pieceId === 'red-2')
  if (!red2Move) fail('expected legal move for red-2 in real mock scenario')
  if (red2Move!.targetCell !== trackCell(28)) fail(`red-2 expected target track-28, got ${red2Move!.targetCell}`)
  if (red2Move!.type !== 'normal') {
    fail(`red-2 expected type=normal (blue-3 is on track-27, 5 steps away, not on target track-28), got ${red2Move!.type}`)
  }

  // home пионки (red-0, red-3) не трябва да имат legal move — изкарване от
  // home е извън обхвата на тази минимална корекция.
  const homeMoves = mockMoves.filter((m) => m.pieceId === 'red-0' || m.pieceId === 'red-3')
  if (homeMoves.length !== 0) {
    fail(`expected no legal moves for home pieces (red-0/red-3), got ${JSON.stringify(homeMoves)}`)
  }

  console.log(
    '[checkLudoLegalMoveMath] OK — track-4+6=track-10, track-22+6=track-28, ' +
      '6-step route, capture only on exact target, wrap track-55->track-0 and track-53+6=track-3, ' +
      'real mock scenario (red-2 vs blue-3 on track-27) no longer reports a false capture.',
  )
  process.exit(0)
}

main()
