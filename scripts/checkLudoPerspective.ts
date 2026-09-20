// Deterministic проверка на pure viewer perspective mapping-а
// (board/ludoPerspective.ts) — НЕ browser check. Engine/canonical geometry
// НЕ се пипат от perspective-а; тук проверяваме единствено presentation
// remapping helpers-ите.
//
// Покрива (виж Phase 3A task-а т.24):
//   P1. local green -> green quadrant bottom-left.
//   P2. local yellow -> yellow quadrant bottom-left.
//   P3. local blue -> blue quadrant bottom-left.
//   P4. local red -> red quadrant bottom-left.
//   P5. canonical grid point -> правилен rendered point (конкретен пример).
//   P6. 4 последователни quarter rotations -> original point (identity).
//   P7. arrow direction remap правилен за всички 4 ориентации.
//   P8. presentation mapping не мутира входните аргументи / няма side effects.
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import {
  rotateLudoGridPointForViewer,
  rotateLudoDirectionForViewer,
  mapLudoColorToViewerQuadrant,
  ludoViewerRotationSteps,
} from '../src/app/games/ludo/board/ludoPerspective'
import type { LudoGridPoint } from '../src/app/games/ludo/board/ludoBoardGeometry'
import type { LudoColor } from '../src/app/games/ludo/ludoTypes'

function fail(message: string): never {
  console.error(`[checkLudoPerspective] FAIL: ${message}`)
  process.exit(1)
}

const LUDO_COLORS: readonly LudoColor[] = ['red', 'blue', 'green', 'yellow']

function main(): void {
  // --- P1-P4: local color's own quadrant maps to bottom-left ---
  for (const localColor of LUDO_COLORS) {
    const quadrant = mapLudoColorToViewerQuadrant(localColor, localColor)
    if (quadrant !== 'bottom-left') {
      fail(`P1-P4: local ${localColor} must map to its own quadrant bottom-left, got ${quadrant}`)
    }
  }
  console.log('[checkLudoPerspective] P1-P4 OK — each local color maps to its own quadrant bottom-left.')

  // --- P5: canonical grid point -> correct rendered point (concrete example) ---
  // red home origin (1,1), local=red (3 clockwise steps) -> (1,13) — виж
  // manual verification при implementation-a (bottom-left area на 15x15 grid).
  {
    const redOrigin: LudoGridPoint = { col: 1, row: 1 }
    const rotated = rotateLudoGridPointForViewer(redOrigin, 'red')
    if (rotated.col !== 1 || rotated.row !== 13) {
      fail(`P5: red origin (1,1) rotated for local=red expected (1,13), got (${rotated.col},${rotated.row})`)
    }
    // green origin (1,11), local=green (identity, 0 steps) -> unchanged.
    const greenOrigin: LudoGridPoint = { col: 1, row: 11 }
    const identity = rotateLudoGridPointForViewer(greenOrigin, 'green')
    if (identity.col !== 1 || identity.row !== 11) {
      fail(`P5: green origin (1,11) rotated for local=green (identity) must stay (1,11), got (${identity.col},${identity.row})`)
    }
    console.log('[checkLudoPerspective] P5 OK — canonical grid point rotates to the correct rendered point.')
  }

  // --- P6: 4 consecutive quarter rotations return to the original point ---
  {
    const point: LudoGridPoint = { col: 5, row: 2 }
    let current = point
    // Apply local=red (3 steps) then simulate one more step manually via
    // repeated single-color calls isn't directly exposed, so instead verify
    // the underlying invariant differently: rotating by all 4 possible
    // localColor values whose steps are 0,1,2,3 and checking the one with
    // steps=0 (green) reproduces identity, and applying red's rotation
    // (3 steps) three more times (i.e. 9 total steps = 4*2+1... ) — simplest
    // robust check: compose steps by calling rotateLudoGridPointForViewer
    // with each color once corresponds to 0..3 steps; composing "yellow"
    // (1 step) four times must return to start (4*90deg = 360deg).
    for (let i = 0; i < 4; i += 1) {
      current = rotateLudoGridPointForViewer(current, 'yellow') // 1 step each call
    }
    if (current.col !== point.col || current.row !== point.row) {
      fail(`P6: 4 consecutive quarter rotations must return to original point (${point.col},${point.row}), got (${current.col},${current.row})`)
    }
    console.log('[checkLudoPerspective] P6 OK — 4 consecutive quarter rotations return to the original point.')
  }

  // --- P7: arrow direction remap correct for all 4 orientations ---
  {
    // 0deg (up) rotated by each color's steps must equal steps*90 mod 360.
    for (const localColor of LUDO_COLORS) {
      const steps = ludoViewerRotationSteps(localColor)
      const rotated = rotateLudoDirectionForViewer(0, localColor)
      const expected = (steps * 90) % 360
      if (rotated !== expected) {
        fail(`P7: direction 0deg rotated for local=${localColor} (steps=${steps}) expected ${expected}, got ${rotated}`)
      }
    }
    // Also verify wrap-around: 270deg + 3*90deg (local=red, 3 steps) = 540 % 360 = 180.
    const wrapped = rotateLudoDirectionForViewer(270, 'red')
    if (wrapped !== 180) fail(`P7: 270deg rotated by local=red (3 steps) expected 180 (wrap), got ${wrapped}`)
    console.log('[checkLudoPerspective] P7 OK — arrow direction remap correct for all 4 orientations, including wrap-around.')
  }

  // --- P8: presentation mapping does not mutate inputs / no side effects ---
  {
    const point: LudoGridPoint = { col: 3, row: 9 }
    const snapshotBefore = JSON.stringify(point)
    rotateLudoGridPointForViewer(point, 'blue')
    if (JSON.stringify(point) !== snapshotBefore) fail('P8: rotateLudoGridPointForViewer must not mutate its input point')

    // Determinism: same input -> same output, every time.
    const r1 = rotateLudoGridPointForViewer(point, 'blue')
    const r2 = rotateLudoGridPointForViewer(point, 'blue')
    if (JSON.stringify(r1) !== JSON.stringify(r2)) fail('P8: rotateLudoGridPointForViewer must be deterministic')

    const q1 = mapLudoColorToViewerQuadrant('yellow', 'blue')
    const q2 = mapLudoColorToViewerQuadrant('yellow', 'blue')
    if (q1 !== q2) fail('P8: mapLudoColorToViewerQuadrant must be deterministic')

    console.log('[checkLudoPerspective] P8 OK — presentation mapping is pure: no input mutation, deterministic output.')
  }

  console.log('[checkLudoPerspective] ALL OK')
  process.exit(0)
}

main()
