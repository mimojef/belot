// Deterministic проверка на Phase 3B route generation (board/ludoMoveRoute.ts)
// — НЕ browser check (чиста логика, без DOM/Playwright). Покрива R1-R7 от
// task-а:
//   R1 home->start (единичен скок, без междинни стъпки)
//   R2 track->track (нормално движение)
//   R3 absolute wrap route (55->0 seam, чисто track->track)
//   R4 track->finish (multi-step, включително самия wrap момент)
//   R5 finish->finish
//   R6 exact finish
//   R7 route identity е perspective-независима (pure function на cell id-та,
//      без import/dependency от ludoPerspective.ts)
//
// Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildLudoMoveRoute } from '../src/app/games/ludo/board/ludoMoveRoute'

function fail(message: string): never {
  console.error(`[checkLudoMoveRouteGeneration] FAIL: ${message}`)
  process.exit(1)
}

function ok(label: string): void {
  console.log(`[checkLudoMoveRouteGeneration] ${label} OK`)
}

function main(): void {
  // --- R1: home -> start (единичен скок) ---
  {
    const route = buildLudoMoveRoute('home-red-0', 'track-1')
    if (JSON.stringify(route) !== JSON.stringify(['track-1'])) {
      fail(`R1: expected single-hop ['track-1'], got ${JSON.stringify(route)}`)
    }
    ok('R1 — home->start is a single visual hop, no intermediate steps')
  }

  // --- R2: track -> track ---
  {
    const route = buildLudoMoveRoute('track-10', 'track-13')
    if (JSON.stringify(route) !== JSON.stringify(['track-11', 'track-12', 'track-13'])) {
      fail(`R2: expected 3-step track->track route, got ${JSON.stringify(route)}`)
    }
    ok('R2 — track->track walks every intermediate cell clockwise')
  }

  // --- R3: absolute wrap route (55->0 seam), pure ring geometry, independent of color ---
  {
    const route = buildLudoMoveRoute('track-54', 'track-2')
    const expected = ['track-55', 'track-0', 'track-1', 'track-2']
    if (JSON.stringify(route) !== JSON.stringify(expected)) {
      fail(`R3: expected wrap route ${JSON.stringify(expected)}, got ${JSON.stringify(route)}`)
    }
    ok('R3 — track->track route correctly crosses the absolute 55->0 seam')
  }

  // --- R4: track -> finish, multi-step, crossing the wrap into red's own finish lane ---
  {
    // red stepsFromStart=53 -> absolute track-54; dice=4 -> finish-1
    // (task-а's own worked example: progress54, progress55, finish0, finish1).
    const route = buildLudoMoveRoute('track-54', 'finish-red-1')
    const expected = ['track-55', 'track-0', 'finish-red-0', 'finish-red-1']
    if (JSON.stringify(route) !== JSON.stringify(expected)) {
      fail(`R4: expected track->finish route ${JSON.stringify(expected)}, got ${JSON.stringify(route)}`)
    }
    ok('R4 — track->finish route contains every real shared-track AND finish step, never teleports')
  }

  // --- R5: finish -> finish ---
  {
    const route = buildLudoMoveRoute('finish-red-1', 'finish-red-4')
    const expected = ['finish-red-2', 'finish-red-3', 'finish-red-4']
    if (JSON.stringify(route) !== JSON.stringify(expected)) {
      fail(`R5: expected finish->finish route ${JSON.stringify(expected)}, got ${JSON.stringify(route)}`)
    }
    ok('R5 — finish->finish walks every intermediate finish cell, only forward')
  }

  // --- R6: exact finish ---
  {
    const route = buildLudoMoveRoute('finish-red-4', 'finish-red-5')
    if (JSON.stringify(route) !== JSON.stringify(['finish-red-5'])) {
      fail(`R6: expected single-step exact finish, got ${JSON.stringify(route)}`)
    }
    ok('R6 — exact finish5 is reachable as the final real step')
  }

  // --- R7: route identity is perspective-independent ---
  {
    // (a) determinism — pure function, no hidden global/viewer state.
    const r1 = buildLudoMoveRoute('track-54', 'finish-red-1')
    const r2 = buildLudoMoveRoute('track-54', 'finish-red-1')
    if (JSON.stringify(r1) !== JSON.stringify(r2)) fail('R7: buildLudoMoveRoute must be deterministic (same input -> same output)')

    // (b) structural guarantee — the route module has ZERO dependency on
    // ludoPerspective.ts, so route identity cannot possibly vary with the
    // local viewer's rotation (mirrors the existing module-boundary check
    // style in checkLudoCapturePresentation.ts's I5).
    const currentFile = fileURLToPath(import.meta.url)
    const routeModulePath = join(dirname(currentFile), '..', 'src', 'app', 'games', 'ludo', 'board', 'ludoMoveRoute.ts')
    const source = readFileSync(routeModulePath, 'utf8')
    if (source.includes('ludoPerspective') || source.includes('Perspective')) {
      fail('R7: ludoMoveRoute.ts must have zero dependency on perspective/viewer-rotation logic')
    }
    ok('R7 — canonical route identity is deterministic and structurally perspective-independent')
  }

  console.log('[checkLudoMoveRouteGeneration] ALL OK')
  process.exit(0)
}

main()
