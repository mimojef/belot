import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { buildLudoMoveRoute } from '../src/app/games/ludo/board/ludoMoveRoute'
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

function assertRoute(label: string, from: string, to: string, expected: string[]): void {
  const actual = buildLudoMoveRoute(from, to)
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: expected ${expected.join(' -> ')}, got ${actual.join(' -> ')}`)
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
  queueDiceValues: (values: number[]) => Promise<void>
  restoreDice: () => Promise<void>
  wait: (ms: number) => Promise<void>
  clickRoll: () => Promise<void>
  clickPiece: (pieceId: string) => Promise<void>
  getSelectablePieceIds: () => Promise<string[]>
  isPieceOrGroupInCell: (pieceId: string, cellId: string) => Promise<boolean>
  hasHorizontalOverflow: () => Promise<boolean>
  getConsoleErrors: () => Promise<string[]>
  countMovingPieces: (pieceId?: string) => Promise<number>
  countMoveTrails: (pieceId?: string) => Promise<number>
  countRenderedPieceInstances: (pieceId: string) => Promise<number>
  countStaticPieceInstances: (pieceId: string) => Promise<number>
}

async function harness(page: Page): Promise<H> {
  const w = '__ludoMovementRulesBrowserHarness'
  return {
    mountWithState: (overrides, activeColor) =>
      page.evaluate(([k, o, c]: any) => (window as any)[k].mountWithState(o, c), [w, overrides, activeColor ?? 'red'] as any),
    queueDiceValues: (values) => page.evaluate(([k, v]: any) => (window as any)[k].queueDiceValues(v), [w, values] as any),
    restoreDice: () => page.evaluate((k: any) => (window as any)[k].restoreDice(), w),
    wait: (ms) => page.evaluate(([k, m]: any) => (window as any)[k].wait(m), [w, ms] as any),
    clickRoll: () => page.evaluate((k: any) => (window as any)[k].clickRoll(), w),
    clickPiece: (pieceId) => page.evaluate(([k, p]: any) => (window as any)[k].clickPiece(p), [w, pieceId] as any),
    getSelectablePieceIds: () => page.evaluate((k: any) => (window as any)[k].getSelectablePieceIds(), w),
    isPieceOrGroupInCell: (pieceId, cellId) =>
      page.evaluate(([k, p, c]: any) => (window as any)[k].isPieceOrGroupInCell(p, c), [w, pieceId, cellId] as any),
    hasHorizontalOverflow: () => page.evaluate((k: any) => (window as any)[k].hasHorizontalOverflow(), w),
    getConsoleErrors: () => page.evaluate((k: any) => (window as any)[k].getConsoleErrors(), w),
    countMovingPieces: (pieceId) => page.evaluate(([k, p]: any) => (window as any)[k].countMovingPieces(p), [w, pieceId] as any),
    countMoveTrails: (pieceId) => page.evaluate(([k, p]: any) => (window as any)[k].countMoveTrails(p), [w, pieceId] as any),
    countRenderedPieceInstances: (pieceId) =>
      page.evaluate(([k, p]: any) => (window as any)[k].countRenderedPieceInstances(p), [w, pieceId] as any),
    countStaticPieceInstances: (pieceId) =>
      page.evaluate(([k, p]: any) => (window as any)[k].countStaticPieceInstances(p), [w, pieceId] as any),
  }
}

console.log('\n=== checkLudoMovementEffect ===\n')

await check('route builder returns exact visual step order', () => {
  assertRoute('1-step', 'track-4', 'track-5', ['track-5'])
  assertRoute('3-step', 'track-4', 'track-7', ['track-5', 'track-6', 'track-7'])
  assertRoute('6-step', 'track-4', 'track-10', ['track-5', 'track-6', 'track-7', 'track-8', 'track-9', 'track-10'])
  assertRoute('home-exit', 'home-red-0', 'track-0', ['track-0'])
  assertRoute('track-finish', 'track-54', 'finish-red-1', ['track-55', 'finish-red-0', 'finish-red-1'])
})

await check('source contract uses shared effects overlay, moving clone, trail, cleanup', () => {
  const controller = readFileSync('src/app/games/ludo/createLudoFlowController.ts', 'utf8')
  const overlay = readFileSync('src/app/games/ludo/pieces/playLudoMoveRouteOverlay.ts', 'utf8')
  assert(controller.includes('playLudoMoveRouteOverlay'), 'controller must call playLudoMoveRouteOverlay')
  assert(controller.includes('movingPieceSuppressedId'), 'controller must suppress canonical mover during overlay movement')
  assert(overlay.includes('[data-ludo-effects-overlay="1"]'), 'overlay must use the shared board effects overlay')
  assert(overlay.includes('data-ludo-moving-piece'), 'moving clone data marker missing')
  assert(overlay.includes('data-ludo-move-trail'), 'trail data marker missing')
  assert(overlay.includes('querySelectorAll(`[data-ludo-moving-piece="${pieceId}"], [data-ludo-move-trail="${pieceId}"]`)'), 'cancel cleanup selector missing')
  assert(overlay.includes('MID_TRAVEL_SCALE = 1.18'), 'mid-flight scale should stay near the measured reference')
  assert(overlay.includes("renderedPiece.style.width = '100%'"), 'moving pawn must not receive the renderer 80% width twice')
  assert(overlay.includes("transform: 'translate(-50%, -50%) scale(1)'"), 'each travel step must land at canonical scale')
})

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
  browser = await chromium.launch()

  async function runBrowserPass(width: number, height: number): Promise<void> {
    const context = await browser!.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width, height } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await page.goto('/scripts/fixtures/ludoMovementRulesBrowserHarness.html')
    const h = await harness(page)

    await h.mountWithState({ 'red-1': { kind: 'track', trackIndex: 4 } })
    await h.queueDiceValues([3])
    await h.clickRoll()
    await h.wait(1300)
    assert((await h.getSelectablePieceIds()).includes('red-1'), `${width}x${height}: red-1 must be selectable`)
    await h.clickPiece('red-1')
    await h.wait(120)
    assert((await h.countMovingPieces('red-1')) === 1, `${width}x${height}: expected one moving clone during route`)
    assert((await h.countStaticPieceInstances('red-1')) === 0, `${width}x${height}: canonical mover must be suppressed during route`)
    await h.wait(260)
    assert((await h.countMoveTrails('red-1')) > 0, `${width}x${height}: expected at least one trail during route`)
    await h.wait(900)
    assert((await h.countMovingPieces('red-1')) === 0, `${width}x${height}: moving clone leaked after route`)
    assert((await h.countMoveTrails('red-1')) === 0, `${width}x${height}: trail leaked after fade`)
    assert(await h.isPieceOrGroupInCell('red-1', 'track-7'), `${width}x${height}: final pawn missing at destination`)
    assert((await h.countRenderedPieceInstances('red-1')) === 1, `${width}x${height}: final state must have exactly one red-1 pawn`)
    assert(!(await h.hasHorizontalOverflow()), `${width}x${height}: horizontal overflow detected`)
    assert(pageErrors.length === 0, `${width}x${height}: page errors: ${pageErrors.join('; ')}`)
    assert((await h.getConsoleErrors()).length === 0, `${width}x${height}: harness console errors`)
    await h.restoreDice()
    await context.close()
  }

  async function runPixelGeometryPass(width: number, height: number): Promise<void> {
    const context = await browser!.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width, height } })
    const page = await context.newPage()
    await page.goto('/scripts/fixtures/ludoMovementEffectHarness.html')
    await page.locator('[data-slow="1"]').check()

    const staticRect = await page.locator('[data-ludo-piece="red-0"]').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    const movingRectAtTravelProgress = (progress: number) => page.locator('[data-ludo-moving-piece="red-0"]').evaluate((element, value) => {
      const animation = element.getAnimations()[0]
      if (!animation) throw new Error('travel animation missing')
      const timing = animation.effect?.getComputedTiming()
      if (!timing || typeof timing.duration !== 'number') throw new Error('travel animation duration missing')
      animation.pause()
      animation.currentTime = timing.duration * value
      const pawn = element.querySelector<HTMLElement>('[data-ludo-piece="red-0"]')
      if (!pawn) throw new Error('moving pawn missing')
      const rect = pawn.getBoundingClientRect()
      if (value === 1) animation.finish()
      return { width: rect.width, height: rect.height }
    }, progress)
    const assertAtBaseSize = (label: string, rect: { width: number; height: number }) => {
      assert(Math.abs(rect.width - staticRect.width) <= 1, `${width}x${height} ${label}: width ${rect.width} differs from static ${staticRect.width}`)
      assert(Math.abs(rect.height - staticRect.height) <= 1, `${width}x${height} ${label}: height ${rect.height} differs from static ${staticRect.height}`)
    }

    for (const scenario of ['one', 'three', 'six']) {
      await page.locator(`[data-scenario="${scenario}"]`).click()
      await page.locator('[data-ludo-moving-piece="red-0"]').waitFor()
      assertAtBaseSize(`${scenario} start`, await movingRectAtTravelProgress(0))

      const mid = await movingRectAtTravelProgress(0.5)
      const widthRatio = mid.width / staticRect.width
      const heightRatio = mid.height / staticRect.height
      assert(widthRatio >= 1.15 && widthRatio <= 1.2, `${width}x${height} ${scenario} mid width ratio was ${widthRatio}`)
      assert(heightRatio >= 1.15 && heightRatio <= 1.2, `${width}x${height} ${scenario} mid height ratio was ${heightRatio}`)

      assertAtBaseSize(`${scenario} landing`, await movingRectAtTravelProgress(1))
      await page.locator('[data-ludo-moving-piece="red-0"]').waitFor({ state: 'detached', timeout: 6000 })
    }
    await context.close()
  }

  await check('browser movement effect at 360x800', () => runBrowserPass(360, 800))
  await check('browser movement effect at 390x844', () => runBrowserPass(390, 844))
  await check('browser movement effect at 1280x850', () => runBrowserPass(1280, 850))
  await check('pixel geometry for 1/3/6 steps at 390x844', () => runPixelGeometryPass(390, 844))
  await check('pixel geometry for 1/3/6 steps at 1280x850', () => runPixelGeometryPass(1280, 850))
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log('\n' + '='.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
