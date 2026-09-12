// Deterministic проверка на stacked-piece move/capture логиката — НЕ
// browser check (чиста логика, без DOM/Playwright). Написан след task-а
// "довърши логиката за stacked Ludo pieces": едно click мести само ЕДНА
// пионка от stack, badge-ът се извежда автоматично от LudoPiece[] (не
// отделен count state), и capture на target клетка удря ВСИЧКИ
// противникови пионки там, не само първата намерена.
//
// Проверява:
//   A. Move one piece from a stack of 4 -> old cell has 3, badge 4->3
//   B. Stack of 2 -> move one -> old cell has 1 piece, badge absent
//   C. Land on own stack (2 red) -> 3 red on same cell, badge = 3
//   D. Capture opponent stack of 2 -> both victims -> home, mover stays
//   E. Capture opponent stack of 4 -> all 4 victims -> home
//   F. Opponent on an intermediate route cell (not the target) is NOT captured
//   G. Sparse home occupancy (real mock start state: red-0=home-0,
//      red-3=home-3, slots 1/2 free) -> sequential captures must NOT
//      collide on an already-occupied slot (regression test за audit-a,
//      виж resolveLudoCapture.ts за пълния разбор).
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { renderLudoPiecesByCell } from '../src/app/games/ludo/pieces/renderLudoPieces'
import { findLudoCaptureVictims, applyLudoCaptureToHome } from '../src/app/games/ludo/board/resolveLudoCapture'
import { createLudoMockPieces } from '../src/app/games/ludo/mock/ludoMockState'
import { ludoCellId } from '../src/app/games/ludo/ludoTypes'
import type { LudoPiece } from '../src/app/games/ludo/ludoTypes'

function fail(message: string): never {
  console.error(`[checkLudoStackCapture] FAIL: ${message}`)
  process.exit(1)
}

function trackCell(index: number) {
  return ludoCellId({ kind: 'track', index })
}

function mkPiece(id: string, color: LudoPiece['color'], cell: string): LudoPiece {
  return { id: id as LudoPiece['id'], color, cell: cell as LudoPiece['cell'] }
}

// Извлича DOM token-ите + badge текста за дадена клетка от
// renderLudoPiecesByCell резултата — helper за четимост на assertions-ите.
function inspectCell(pieces: LudoPiece[], cellId: string) {
  const fragments = renderLudoPiecesByCell(pieces, [])
  const frag = fragments.find((f) => f.cellId === cellId)
  const div = { innerHTML: frag ? frag.html : '' }
  const tokenMatches = [...div.innerHTML.matchAll(/data-ludo-piece="([^"]+)"/g)].map((m) => m[1])
  const badgeMatch = div.innerHTML.match(/<text[^>]*>(\d+)<\/text>/)
  return {
    domTokenCount: tokenMatches.length,
    tokenIds: tokenMatches,
    badgeText: badgeMatch ? badgeMatch[1] : null,
  }
}

function main(): void {
  // --- A: move one from a stack of 4 ---
  {
    const pieces: LudoPiece[] = [
      mkPiece('red-1', 'red', trackCell(5)),
      mkPiece('red-2', 'red', trackCell(5)),
      mkPiece('red-3', 'red', trackCell(5)),
      mkPiece('red-4', 'red', trackCell(5)),
    ]
    const before = inspectCell(pieces, trackCell(5))
    if (before.domTokenCount !== 1) fail(`A: expected 1 DOM token before move, got ${before.domTokenCount}`)
    if (before.badgeText !== '4') fail(`A: expected badge "4" before move, got ${before.badgeText}`)

    // Same mutation pattern as handlePieceSelected: find by id, set .cell.
    const moving = pieces.find((p) => p.id === 'red-1')
    if (!moving) fail('A: red-1 not found')
    moving!.cell = trackCell(11)

    const afterOld = inspectCell(pieces, trackCell(5))
    if (afterOld.domTokenCount !== 1) fail(`A: expected 1 DOM token in old cell after move, got ${afterOld.domTokenCount}`)
    if (afterOld.badgeText !== '3') fail(`A: expected badge "3" in old cell after move, got ${afterOld.badgeText}`)
    if (afterOld.tokenIds.includes('red-1')) fail('A: red-1 must not remain represented in the old cell')

    const afterNew = inspectCell(pieces, trackCell(11))
    if (afterNew.domTokenCount !== 1) fail(`A: expected 1 DOM token in new cell, got ${afterNew.domTokenCount}`)
    if (afterNew.badgeText !== null) fail(`A: expected no badge for a single piece in new cell, got ${afterNew.badgeText}`)
    if (afterNew.tokenIds[0] !== 'red-1') fail(`A: expected red-1 in new cell, got ${afterNew.tokenIds[0]}`)

    // Underlying state must still hold all 4 distinct ids.
    const ids = new Set(pieces.map((p) => p.id))
    if (ids.size !== 4) fail(`A: expected 4 distinct piece ids preserved in state, got ${ids.size}`)

    console.log('[checkLudoStackCapture] A OK — move one of 4, old badge 4->3, moved piece alone in new cell, 4 ids preserved.')
  }

  // --- B: stack of 2 -> move one -> old cell has 1 piece, no badge ---
  {
    const pieces: LudoPiece[] = [mkPiece('red-1', 'red', trackCell(20)), mkPiece('red-2', 'red', trackCell(20))]
    const before = inspectCell(pieces, trackCell(20))
    if (before.badgeText !== '2') fail(`B: expected badge "2" before move, got ${before.badgeText}`)

    const moving = pieces.find((p) => p.id === 'red-2')
    if (!moving) fail('B: red-2 not found')
    moving!.cell = trackCell(25)

    const afterOld = inspectCell(pieces, trackCell(20))
    if (afterOld.domTokenCount !== 1) fail(`B: expected 1 DOM token in old cell, got ${afterOld.domTokenCount}`)
    if (afterOld.badgeText !== null) fail(`B: expected NO badge (stack reduced to 1), got "${afterOld.badgeText}"`)
    if (afterOld.tokenIds[0] !== 'red-1') fail(`B: expected red-1 remaining alone, got ${afterOld.tokenIds[0]}`)

    console.log('[checkLudoStackCapture] B OK — stack of 2 -> move one -> old cell has 1 piece, badge absent.')
  }

  // --- C: land on own stack -> merges into a bigger stack, badge reflects it ---
  {
    const pieces: LudoPiece[] = [
      mkPiece('red-2', 'red', trackCell(30)),
      mkPiece('red-3', 'red', trackCell(30)),
      mkPiece('red-1', 'red', trackCell(24)),
    ]
    const moving = pieces.find((p) => p.id === 'red-1')
    if (!moving) fail('C: red-1 not found')
    moving!.cell = trackCell(30) // lands exactly on the existing own-color stack

    const after = inspectCell(pieces, trackCell(30))
    if (after.domTokenCount !== 1) fail(`C: expected 1 DOM token (own-color merge), got ${after.domTokenCount}`)
    if (after.badgeText !== '3') fail(`C: expected badge "3" after landing on own 2-stack, got ${after.badgeText}`)

    console.log('[checkLudoStackCapture] C OK — landing on own 2-stack merges to 3, badge = 3, no special-case code needed.')
  }

  // --- D: capture opponent stack of 2 -> both victims go home, mover stays ---
  {
    const pieces: LudoPiece[] = [
      mkPiece('blue-1', 'blue', trackCell(20)),
      mkPiece('blue-2', 'blue', trackCell(20)),
      mkPiece('red-1', 'red', trackCell(20)), // mover already landed on target for this check
    ]
    const victims = findLudoCaptureVictims(pieces, trackCell(20), 'red')
    if (victims.length !== 2) fail(`D: expected 2 victims, got ${victims.length}`)
    if (!victims.some((v) => v.id === 'blue-1') || !victims.some((v) => v.id === 'blue-2')) {
      fail(`D: expected blue-1 and blue-2 as victims, got ${victims.map((v) => v.id).join(',')}`)
    }

    applyLudoCaptureToHome(victims)

    const blue1 = pieces.find((p) => p.id === 'blue-1')!
    const blue2 = pieces.find((p) => p.id === 'blue-2')!
    const red1 = pieces.find((p) => p.id === 'red-1')!
    // Всяка victim се връща на ТОЧНО своя собствен slot (id suffix), не
    // просто "някой свободен" — виж audit-а в resolveLudoCapture.ts.
    if (blue1.cell !== 'home-blue-1') fail(`D: blue-1 expected home-blue-1 (own id-derived slot), got ${blue1.cell}`)
    if (blue2.cell !== 'home-blue-2') fail(`D: blue-2 expected home-blue-2 (own id-derived slot), got ${blue2.cell}`)
    if (blue1.cell === blue2.cell) fail(`D: blue-1 and blue-2 must NOT share the same home slot, both got ${blue1.cell}`)
    if (red1.cell !== trackCell(20)) fail(`D: red-1 (mover) expected to remain on target, got ${red1.cell}`)

    const targetAfter = inspectCell(pieces, trackCell(20))
    if (targetAfter.domTokenCount !== 1 || targetAfter.tokenIds[0] !== 'red-1') {
      fail(`D: expected only red-1 left on target cell after capture, got ${JSON.stringify(targetAfter)}`)
    }

    console.log(`[checkLudoStackCapture] D OK — capture stack of 2, both victims home (${blue1.cell}, ${blue2.cell}), mover stays.`)
  }

  // --- E: capture opponent stack of 4 -> all 4 victims go home, each to a distinct slot ---
  {
    const pieces: LudoPiece[] = [
      mkPiece('yellow-0', 'yellow', trackCell(40)),
      mkPiece('yellow-1', 'yellow', trackCell(40)),
      mkPiece('yellow-2', 'yellow', trackCell(40)),
      mkPiece('yellow-3', 'yellow', trackCell(40)),
      mkPiece('green-1', 'green', trackCell(40)),
    ]
    const victims = findLudoCaptureVictims(pieces, trackCell(40), 'green')
    if (victims.length !== 4) fail(`E: expected 4 victims, got ${victims.length}`)

    applyLudoCaptureToHome(victims)

    // Всяка victim -> ТОЧНО своя id-derived slot: yellow-N -> home-yellow-N.
    for (let i = 0; i < 4; i += 1) {
      const piece = pieces.find((p) => p.id === `yellow-${i}`)!
      const expected = `home-yellow-${i}`
      if (piece.cell !== expected) fail(`E: yellow-${i} expected ${expected}, got ${piece.cell}`)
    }
    const yellowHomeCells = pieces.filter((p) => p.color === 'yellow').map((p) => p.cell)
    if (new Set(yellowHomeCells).size !== 4) {
      fail(`E: expected 4 DISTINCT home slots, got ${yellowHomeCells.join(', ')}`)
    }
    const green1 = pieces.find((p) => p.id === 'green-1')!
    if (green1.cell !== trackCell(40)) fail(`E: green-1 (mover) expected to remain on target, got ${green1.cell}`)

    console.log(`[checkLudoStackCapture] E OK — capture stack of 4, all distinct home slots: ${yellowHomeCells.join(', ')}.`)
  }

  // --- F: opponent on an intermediate route cell (not the target) must NOT be captured ---
  {
    const pieces: LudoPiece[] = [
      mkPiece('blue-1', 'blue', trackCell(23)), // 3 steps from track-20, NOT the target (track-26 for dice=6)
      mkPiece('red-1', 'red', trackCell(26)), // mover already on target, target itself has no opponent
    ]
    const victims = findLudoCaptureVictims(pieces, trackCell(26), 'red')
    if (victims.length !== 0) fail(`F: expected 0 victims (opponent is on an intermediate cell, not target), got ${victims.length}`)
    const blue1 = pieces.find((p) => p.id === 'blue-1')!
    if (blue1.cell !== trackCell(23)) fail(`F: blue-1 must remain untouched on track-23, got ${blue1.cell}`)

    console.log('[checkLudoStackCapture] F OK — opponent on an intermediate cell (not target) is never captured.')
  }

  // --- G: sparse home occupancy regression (виж audit-а в resolveLudoCapture.ts) ---
  // Реалният начален mock state вече е sparse за червено: red-0=home-red-0,
  // red-3=home-red-3, slot 1 и slot 2 свободни (red-1/red-2 са на track).
  // Последователно captured red-1, после red-2 — count-based моделът
  // изпращаше и двете на грешни/сблъскващи се slots (доказано с реалния
  // код преди фикса: red-2 завършваше на home-red-3, вече зает от red-3).
  {
    const pieces = createLudoMockPieces()
    const redBefore = pieces.filter((p) => p.color === 'red').map((p) => p.cell)
    if (redBefore.filter((c) => c.startsWith('home-')).length !== 2) {
      fail(`G: expected the real mock start state to have exactly 2 red pieces already home, got ${redBefore.join(', ')}`)
    }

    const red1 = pieces.find((p) => p.id === 'red-1')!
    applyLudoCaptureToHome([red1])
    if (red1.cell !== 'home-red-1') fail(`G: red-1 expected home-red-1 (own id-derived slot), got ${red1.cell}`)

    const red2 = pieces.find((p) => p.id === 'red-2')!
    applyLudoCaptureToHome([red2])
    if (red2.cell !== 'home-red-2') fail(`G: red-2 expected home-red-2 (own id-derived slot), got ${red2.cell}`)

    const redCells = pieces.filter((p) => p.color === 'red').map((p) => p.cell)
    if (new Set(redCells).size !== 4) {
      fail(`G: expected 4 DISTINCT red home cells after sequential captures, got ${redCells.join(', ')} (COLLISION)`)
    }
    if (!redCells.includes('home-red-0') || !redCells.includes('home-red-1') || !redCells.includes('home-red-2') || !redCells.includes('home-red-3')) {
      fail(`G: expected all 4 canonical red home slots occupied exactly once, got ${redCells.join(', ')}`)
    }

    console.log(`[checkLudoStackCapture] G OK — sparse home occupancy (real mock start state), sequential captures land on ${redCells.join(', ')}, no collision.`)
  }

  console.log('[checkLudoStackCapture] ALL OK')
  process.exit(0)
}

main()
