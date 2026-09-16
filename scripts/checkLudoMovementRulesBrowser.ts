/**
 * checkLudoMovementRulesBrowser.ts
 *
 * Real browser (Playwright), real production code, real DOM — Phase 3B
 * "REAL MOVEMENT RULES" verification (task-а т.21 "REAL BROWSER
 * VERIFICATION" + т.22 "DESKTOP / MOBILE"). Drives the REAL
 * createLudoFlowController() through a fixture harness
 * (scripts/fixtures/ludoMovementRulesBrowserHarness.ts) that seeds specific
 * piece arrangements via the new LudoFlowControllerOptions.initialState seam
 * (test-only injection point — production call site never uses it, normal
 * game start is untouched) and controls dice results via a temporary
 * window.Math.random override (the only way to get deterministic rolls
 * without touching production code, since rollLudoMockDiceResult() has no
 * injection seam of its own).
 *
 * Covers CASE A-I from the task, plus a desktop/mobile viewport pass.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import type { LudoPiecePosition } from '../src/app/games/ludo/engine/ludoEngineTypes'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no free port'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

type H = {
  mountWithState: (overrides: Record<string, LudoPiecePosition>, activeColor?: string) => Promise<void>
  destroyController: () => Promise<void>
  queueDiceValues: (values: number[]) => Promise<void>
  restoreDice: () => Promise<void>
  wait: (ms: number) => Promise<void>
  clickRoll: () => Promise<void>
  isRollButtonPresent: () => Promise<boolean>
  getSelectablePieceIds: () => Promise<string[]>
  clickPiece: (pieceId: string) => Promise<void>
  isPieceOrGroupInCell: (pieceId: string, cellId: string) => Promise<boolean>
  hasHorizontalOverflow: () => Promise<boolean>
  getConsoleErrors: () => Promise<string[]>
}

async function harness(page: Page): Promise<H> {
  const w = '__ludoMovementRulesBrowserHarness'
  return {
    mountWithState: (overrides, activeColor) =>
      page.evaluate(([k, o, c]: any) => (window as any)[k].mountWithState(o, c), [w, overrides, activeColor ?? 'red'] as any),
    destroyController: () => page.evaluate((k: any) => (window as any)[k].destroyController(), w),
    queueDiceValues: (values) => page.evaluate(([k, v]: any) => (window as any)[k].queueDiceValues(v), [w, values] as any),
    restoreDice: () => page.evaluate((k: any) => (window as any)[k].restoreDice(), w),
    wait: (ms) => page.evaluate(([k, m]: any) => (window as any)[k].wait(m), [w, ms] as any),
    clickRoll: () => page.evaluate((k: any) => (window as any)[k].clickRoll(), w),
    isRollButtonPresent: () => page.evaluate((k: any) => (window as any)[k].isRollButtonPresent(), w),
    getSelectablePieceIds: () => page.evaluate((k: any) => (window as any)[k].getSelectablePieceIds(), w),
    clickPiece: (pieceId) => page.evaluate(([k, p]: any) => (window as any)[k].clickPiece(p), [w, pieceId] as any),
    isPieceOrGroupInCell: (pieceId, cellId) =>
      page.evaluate(([k, p, c]: any) => (window as any)[k].isPieceOrGroupInCell(p, c), [w, pieceId, cellId] as any),
    hasHorizontalOverflow: () => page.evaluate((k: any) => (window as any)[k].hasHorizontalOverflow(), w),
    getConsoleErrors: () => page.evaluate((k: any) => (window as any)[k].getConsoleErrors(), w),
  }
}

console.log('\n═══ checkLudoMovementRulesBrowser ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}`
  browser = await chromium.launch()

  async function runCasesAtViewport(width: number, height: number, label: string): Promise<void> {
    const context = await browser!.newContext({ baseURL: baseUrl, viewport: { width, height } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await page.goto('/scripts/fixtures/ludoMovementRulesBrowserHarness.html')
    const h = await harness(page)

    // --- CASE A: dice=6, home pawn -> start with animation ---
    await check(`[${label}] CASE A — dice=6 lets a home pawn exit to its own start, with animation`, async () => {
      await h.mountWithState({})
      await h.queueDiceValues([6])
      await h.clickRoll()
      await h.wait(1300)
      const selectable = await h.getSelectablePieceIds()
      assert(selectable.includes('red-0'), `expected red-0 (home) selectable on dice=6, got ${JSON.stringify(selectable)}`)
      await h.clickPiece('red-0')
      await h.wait(900)
      assert(await h.isPieceOrGroupInCell('red-0', 'track-0'), 'red-0 did not land on its own start cell (track-0)')
    })

    // --- CASE B: dice=1-5, home pawn not selectable ---
    await check(`[${label}] CASE B — dice=1..5 makes a home pawn not selectable (while a legal track move is)`, async () => {
      await h.mountWithState({ 'red-1': { kind: 'track', trackIndex: 4 } })
      await h.queueDiceValues([3])
      await h.clickRoll()
      await h.wait(1300)
      const selectable = await h.getSelectablePieceIds()
      assert(!selectable.includes('red-0'), `home pawn must NOT be selectable on dice=3, got ${JSON.stringify(selectable)}`)
      assert(selectable.includes('red-1'), `the legal track piece must be selectable, got ${JSON.stringify(selectable)}`)
    })

    // --- CASE C: piece near end of lap -> smooth track->finish route ---
    await check(`[${label}] CASE C — a piece near the end of the lap animates smoothly track->finish (no teleport)`, async () => {
      // red start=0 (виж LUDO_START_INDEX fix); trackIndex=53 -> stepsFromStart=53.
      await h.mountWithState({ 'red-1': { kind: 'track', trackIndex: 53 } })
      await h.queueDiceValues([4])
      await h.clickRoll()
      await h.wait(1300)
      const selectable = await h.getSelectablePieceIds()
      assert(selectable.includes('red-1'), `expected red-1 selectable, got ${JSON.stringify(selectable)}`)
      await h.clickPiece('red-1')
      await h.wait(260) // mid-flight — route has 3 real steps (track-55, finish-0, finish-1)
      const finishedAlready = await h.isPieceOrGroupInCell('red-1', 'finish-red-1')
      assert(!finishedAlready, 'route teleported straight to the final cell instead of animating step by step')
      await h.wait(2600)
      assert(await h.isPieceOrGroupInCell('red-1', 'finish-red-1'), 'red-1 did not end on finish-red-1 after the full route')
    })

    // --- CASE D: finish exact -> legal movement ---
    await check(`[${label}] CASE D — an exact finish (finish4 + 1 = finish5) is legal`, async () => {
      await h.mountWithState({ 'red-1': { kind: 'finish', finishIndex: 4 } })
      await h.queueDiceValues([1])
      await h.clickRoll()
      await h.wait(1300)
      const selectable = await h.getSelectablePieceIds()
      assert(selectable.includes('red-1'), `expected exact-finish move to be selectable, got ${JSON.stringify(selectable)}`)
      await h.clickPiece('red-1')
      await h.wait(900)
      assert(await h.isPieceOrGroupInCell('red-1', 'finish-red-5'), 'red-1 did not land on finish-red-5')
    })

    // --- CASE E: overshoot -> piece not selectable ---
    await check(`[${label}] CASE E — an overshoot (finish4 + 2) leaves the piece not selectable`, async () => {
      await h.mountWithState({ 'red-1': { kind: 'finish', finishIndex: 4 } })
      await h.queueDiceValues([2])
      await h.clickRoll()
      await h.wait(1300)
      const selectable = await h.getSelectablePieceIds()
      assert(!selectable.includes('red-1'), `overshooting piece must not be selectable, got ${JSON.stringify(selectable)}`)
    })

    // --- CASE F: capture -> shake -> explosion -> victim flight -> same actor gets extra roll ---
    await check(`[${label}] CASE F — capture plays shake/impact/flight and grants the SAME actor an extra roll`, async () => {
      await h.mountWithState({
        'red-1': { kind: 'track', trackIndex: 14 },
        'blue-0': { kind: 'track', trackIndex: 17 }, // 3 steps away
      })
      await h.queueDiceValues([3])
      await h.clickRoll()
      await h.wait(1300)
      const selectable = await h.getSelectablePieceIds()
      assert(selectable.includes('red-1'), `expected capture move selectable, got ${JSON.stringify(selectable)}`)
      await h.clickPiece('red-1')
      await h.wait(3200) // route + shake + impact burst + victim flight
      assert(await h.isPieceOrGroupInCell('red-1', 'track-17'), 'attacker did not land on the capture target')
      assert(await h.isPieceOrGroupInCell('blue-0', 'home-blue-0'), 'captured victim did not return to its own home slot')
      assert(await h.isRollButtonPresent(), 'capture (without six) must grant the SAME actor an extra roll')
    })

    // --- CASE G: six + capture -> exactly one extra roll ---
    await check(`[${label}] CASE G — six + capture grants exactly ONE extra roll, not two`, async () => {
      await h.mountWithState({
        'red-1': { kind: 'track', trackIndex: 14 },
        'blue-0': { kind: 'track', trackIndex: 20 }, // 6 steps away
      })
      await h.queueDiceValues([6])
      await h.clickRoll()
      await h.wait(1300)
      await h.clickPiece('red-1')
      await h.wait(3200)
      assert(await h.isRollButtonPresent(), 'six+capture must grant the first extra roll')
      // Consume the single extra roll with an ordinary (non-6, non-capture) roll — must advance AWAY from red.
      await h.queueDiceValues([2])
      await h.clickRoll()
      await h.wait(1300)
      assert(!(await h.isRollButtonPresent()), 'a second extra roll was granted — six+capture must only ever grant exactly one')
    })

    // --- CASE H: zero legal moves -> automatic resolve, no hang ---
    await check(`[${label}] CASE H — zero legal moves resolves automatically (non-6 -> next color, 6 -> same-color extra roll)`, async () => {
      const allFinished: Record<string, LudoPiecePosition> = {
        'red-0': { kind: 'finish', finishIndex: 5 },
        'red-1': { kind: 'finish', finishIndex: 5 },
        'red-2': { kind: 'finish', finishIndex: 5 },
        'red-3': { kind: 'finish', finishIndex: 5 },
      }
      await h.mountWithState(allFinished)
      await h.queueDiceValues([3])
      await h.clickRoll()
      await h.wait(1300)
      assert(!(await h.isRollButtonPresent()), 'non-6 zero-legal-moves roll must auto-advance away from red without any click, no hang')

      await h.mountWithState(allFinished)
      await h.queueDiceValues([6])
      await h.clickRoll()
      await h.wait(1300)
      assert(await h.isRollButtonPresent(), 'six with zero legal moves must still grant red a same-color extra roll, no hang')
    })

    // --- CASE I: bot traverses home/track without an illegal move ---
    await check(`[${label}] CASE I — bot autonomously exits home to its own start without any illegal move`, async () => {
      await h.mountWithState({}, 'blue')
      await h.queueDiceValues([6])
      await h.wait(2600) // bot think-delay (700ms) + dice flight (900ms) + route step + render margin
      assert(await h.isPieceOrGroupInCell('blue-0', 'track-14'), 'bot did not autonomously move blue-0 onto its own start cell (track-14)')
    })

    // --- CASE J: landing on an opponent parked on a safe/star cell must NOT capture it (SAFE10) ---
    await check(`[${label}] CASE J — opponent parked on a safe/star cell survives a landing (no capture, no explosion)`, async () => {
      // blue safe cell is track-22 (blue start=14, +8 offset). red-1 two
      // steps behind it, dice=2, lands exactly on it.
      await h.mountWithState({ 'red-1': { kind: 'track', trackIndex: 20 }, 'blue-0': { kind: 'track', trackIndex: 22 } })
      await h.queueDiceValues([2])
      await h.clickRoll()
      await h.wait(1300)
      const selectable = await h.getSelectablePieceIds()
      assert(selectable.includes('red-1'), `expected red-1 selectable, got ${JSON.stringify(selectable)}`)
      await h.clickPiece('red-1')
      await h.wait(1200) // full move + would-be capture presentation window
      assert(await h.isPieceOrGroupInCell('red-1', 'track-22'), 'red-1 did not land on the safe cell track-22')
      assert(
        await h.isPieceOrGroupInCell('blue-0', 'track-22'),
        'blue-0 was bounced off the safe cell — it must stay put, coexisting with the mover',
      )
    })

    await check(`[${label}] no console/page errors across the whole scenario`, () => {
      assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`)
    })

    await check(`[${label}] no horizontal overflow at ${width}x${height}`, async () => {
      assert(!(await h.hasHorizontalOverflow()), `horizontal overflow detected at ${width}x${height}`)
    })

    await h.restoreDice()
    await context.close()
  }

  await runCasesAtViewport(1280, 850, 'desktop')
  await runCasesAtViewport(390, 844, 'mobile')

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
