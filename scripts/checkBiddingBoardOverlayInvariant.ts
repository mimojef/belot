/**
 * checkBiddingBoardOverlayInvariant.ts
 *
 * Real browser (Playwright), real production code, real DOM — behavioral
 * regression за stuck mobile bidding overlay bug-а (production report:
 * "bidding board остава видим върху масата, картите вече раздадени, UI
 * изглежда увиснал, нужен е refresh"). Огледало на установения pattern в
 * checkPrivateRoomMobileResponsive.ts: Vite dev server сервира
 * scripts/fixtures/biddingBoardLifecycleHarness.ts, който boot-ва РЕАЛНИЯ
 * createActiveRoomFlowController() и го движи с реални
 * handleServerMessage()/render() извиквания.
 *
 * За разлика от checkBiddingBoardLifecycle.ts (статичен source-text regex
 * check върху вчерашния fix a7c8ee0 "Fix external game overlay cleanup") —
 * този тест реално РЕНДИРА фазовите преходи и асертва върху истинския DOM.
 * Статичният check остава ценен (пази точната текстова форма/причина за
 * a7c8ee0), но не може да хване runtime race-ове (resize по средата на
 * transition, reconnect, background/foreground resume, stale overlay от
 * произволна причина) — точно затова вчерашният fix премина собствения си
 * тест, а production bug-ът остана.
 *
 * Инвариант, тестван във всеки сценарий:
 *   authoritativePhase !== 'bidding' => 0 [data-bidding-popup-host] DOM nodes.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

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
  enter: (roomId: string) => void
  enterFromResume: (roomId: string) => void
  snapshot: (roomId: string, game: any) => void
  resumed: (roomId: string) => void
  biddingGame: (overrides?: any) => any
  dealLastThreeGame: () => any
  nextRoundGame: () => any
  playingGame: () => any
  biddingPopupHostCount: () => number
  biddingPopupVisibleNodeCount: () => number
  render: () => void
  dispatchResize: () => void
  injectStaleBiddingPopupHost: () => void
  getBidCommands: () => number
  reset: () => void
}

async function harness(page: Page): Promise<H> {
  return {
    enter: (roomId) => page.evaluate((r) => (window as any).__biddingLifecycleHarness.enter(r), roomId),
    enterFromResume: (roomId) => page.evaluate((r) => (window as any).__biddingLifecycleHarness.enterFromResume(r), roomId),
    snapshot: (roomId, game) => page.evaluate(([r, g]: any) => (window as any).__biddingLifecycleHarness.snapshot(r, g), [roomId, game] as any),
    resumed: (roomId) => page.evaluate((r) => (window as any).__biddingLifecycleHarness.resumed(r), roomId),
    biddingGame: (overrides) => page.evaluate((o) => (window as any).__biddingLifecycleHarness.biddingGame(o ?? {}), overrides),
    dealLastThreeGame: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.dealLastThreeGame()),
    nextRoundGame: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.nextRoundGame()),
    playingGame: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.playingGame()),
    biddingPopupHostCount: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.biddingPopupHostCount()),
    biddingPopupVisibleNodeCount: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.biddingPopupVisibleNodeCount()),
    render: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.render()),
    dispatchResize: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.dispatchResize()),
    injectStaleBiddingPopupHost: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.injectStaleBiddingPopupHost()),
    getBidCommands: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.getBidCommands()),
    reset: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.reset()),
  }
}

// Влизане в СЪВСЕМ нова стая директно с раздадени 5 карти (нужни за bidding
// UI-а) активира catch-up deal-first-3 -> deal-next-2 replay анимациите
// (getDealFirstThreePhaseKey/getDealNextTwoPhaseKey третират "вече виждам N
// карти на масата, но activePhaseKey е null" като "трябва да анимирам от
// начало") — точно каквото реален клиент, който join-ва вече active игра,
// също би видял. Изчакваме реално DOM-а да покаже bidding popup-а (не
// произволен sleep) — това е точно поведението, което производствения
// клиент показва, само по-бавно в headless Chromium под общо натоварване.
async function enterAtBidding(h: H, page: Page, roomId: string): Promise<any> {
  await h.enter(roomId)
  const game = await h.biddingGame()
  await h.snapshot(roomId, game)
  await page.waitForFunction(
    () => (window as any).__biddingLifecycleHarness.biddingPopupHostCount() === 1,
    undefined,
    { timeout: 8_000 },
  )
  return game
}

console.log('\n═══ checkBiddingBoardOverlayInvariant ═══\n')

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
  const baseUrl = `http://127.0.0.1:${port}`

  // Две viewport passes: мобилен (touch, тесен) и desktop — bug report-ът е
  // мобилен, но инвариантът трябва да важи навсякъде.
  const VIEWPORTS = [
    { width: 390, height: 844, label: 'mobile 390x844', mobile: true },
    { width: 1280, height: 800, label: 'desktop 1280x800', mobile: false },
  ]

  for (const vp of VIEWPORTS) {
    console.log(`\n--- ${vp.label} ---`)
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.mobile,
      isMobile: vp.mobile,
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/scripts/fixtures/biddingBoardLifecycleHarness.html')
    const h = await harness(page)

    // ─── [1] bidding -> playing: overlay се премахва ───────────────────────
    await check(`[${vp.label}][1] bidding -> playing: overlay removed`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-1')
      assert((await h.biddingPopupHostCount()) === 1, 'popup host трябваше да се появи по време на bidding')
      await h.snapshot('room-1', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'popup host трябваше да изчезне след преход към playing')
    })

    // ─── [2] bidding -> deal-last-3 -> playing: overlay се премахва веднага ─
    await check(`[${vp.label}][2] bidding -> deal-last-3 -> playing: overlay removed immediately after leaving bidding`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-2')
      assert((await h.biddingPopupHostCount()) === 1, 'popup host трябваше да се появи')
      // Симулира атомарния server jump bidding -> deal-last-3 (finalizeServerBiddingPhase),
      // точно сценарият, който a7c8ee0 адресира.
      await h.snapshot('room-2', await h.dealLastThreeGame())
      assert((await h.biddingPopupHostCount()) === 0, 'popup host трябваше да изчезне веднага след deal-last-3, не да чака playing')
      await h.snapshot('room-2', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'popup host трябва да остане премахнат в playing')
    })

    // ─── [3] final PASS (последно действие приключва bidding) ─────────────
    await check(`[${vp.label}][3] final PASS ends bidding: overlay removed`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-3')
      assert((await h.biddingPopupHostCount()) === 1, 'popup host трябваше да се появи')
      // Локалният играч подава финален PASS -> сървърът резолвира bidding-а
      // атомарно в следващата snapshot (next-round пауза, ако всички минат).
      await h.snapshot('room-3', await h.nextRoundGame())
      assert((await h.biddingPopupHostCount()) === 0, 'popup host трябваше да изчезне след финален PASS resolution')
    })

    // ─── [4] contract selected: overlay се премахва ────────────────────────
    await check(`[${vp.label}][4] contract selected ends bidding: overlay removed`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-4')
      assert((await h.biddingPopupHostCount()) === 1, 'popup host трябваше да се появи')
      await h.snapshot('room-4', await h.dealLastThreeGame())
      assert((await h.biddingPopupHostCount()) === 0, 'popup host трябваше да изчезне след избран контракт (bidding -> deal-last-3)')
    })

    // ─── [5] reconnect директно в playing докато stale overlay съществува ──
    await check(`[${vp.label}][5] reconnect directly into playing while stale overlay exists: overlay removed`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-5')
      assert((await h.biddingPopupHostCount()) === 1, 'popup host трябваше да се появи')
      // enterActiveRoomFromResume() чисти seat panels (вкл. bidding popup)
      // безусловно, ПРЕДИ да приложи фреш snapshot — тества точно това.
      await h.enterFromResume('room-5')
      await h.snapshot('room-5', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'popup host трябваше да остане премахнат след reconnect направо в playing')
    })

    // ─── [6] resume_room в playing докато stale overlay съществува ─────────
    await check(`[${vp.label}][6] resume_room into playing while stale overlay exists: overlay removed`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-6')
      assert((await h.biddingPopupHostCount()) === 1, 'popup host трябваше да се появи')
      // room_resumed пристига първо (сървърът винаги праща room_snapshot веднага
      // след него — виж server/src/index.ts resume_room handler), но тестваме
      // самия room_resumed render explicitly, после фреш playing snapshot-а.
      await h.resumed('room-6')
      await h.snapshot('room-6', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'popup host трябваше да изчезне след room_resumed + фреш playing snapshot')
    })

    // ─── [7] render fast-path / повторни render() без state промяна ───────
    await check(`[${vp.label}][7] repeated render() calls with unchanged non-bidding state: cleanup still holds`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-7')
      await h.snapshot('room-7', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'baseline: popup host трябва да е премахнат')
      // Симулира resize-driven или друг допълнителен render() extra call
      // (main.ts wire-ва точно това за resize/orientationchange) без нова
      // WS snapshot — инвариантът трябва да остане верен, не да "resurrect-не".
      await h.render()
      await h.render()
      assert((await h.biddingPopupHostCount()) === 0, 'повторни render() извиквания не трябва да пресъздават popup host-а')
    })

    // ─── [8] duplicate/повторна bidding snapshot СЛЕД playing ──────────────
    await check(`[${vp.label}][8] duplicate identical bidding snapshot re-applied is idempotent (no duplicate hosts)`, async () => {
      await h.reset()
      const bidding = await enterAtBidding(h, page, 'room-8')
      await h.snapshot('room-8', bidding)
      assert((await h.biddingPopupHostCount()) === 1, 'повторно приложена ИДЕНТИЧНА bidding snapshot не трябва да създава втори host')
      await h.snapshot('room-8', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'overlay трябва да изчезне след playing')
    })

    // ─── [9] stale injected overlay: следващ render() го маха ──────────────
    // NOTE: по-ранен foreground (visibilitychange/pageshow) render-only
    // experiment беше премахнат от main.ts — той не адресираше директния
    // bid-submit freeze root cause (виж bid watchdog fix-а в
    // checkBidSubmitRecovery.ts). Тестът тук проверява по-общия,
    // независим от trigger-а инвариант: unconditional cleanup gate-ът в
    // renderActiveRoomScreen() маха всеки stale host на следващия render(),
    // независимо какво го е причинило.
    await check(`[${vp.label}][9] stale injected overlay is removed by the next explicit render()`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-9')
      await h.snapshot('room-9', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'baseline: overlay трябва да е премахнат след playing')
      await h.injectStaleBiddingPopupHost()
      assert((await h.biddingPopupHostCount()) === 1, 'setup: stale host трябваше да е инжектиран')
      await h.render()
      assert((await h.biddingPopupHostCount()) === 0, 'render() трябваше да премахне stale overlay-я (unconditional cleanup gate)')
    })

    // ─── [10] повторни phase/render updates: няма duplicate hosts ──────────
    await check(`[${vp.label}][10] repeated phase/render updates never produce duplicate bidding hosts`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-10')
      for (let i = 0; i < 4; i++) {
        await h.snapshot('room-10', await h.biddingGame())
        await h.dispatchResize()
      }
      assert((await h.biddingPopupHostCount()) === 1, `очаквах точно 1 popup host след повторни bidding snapshots, получих ${await h.biddingPopupHostCount()}`)
      await h.snapshot('room-10', await h.playingGame())
      for (let i = 0; i < 5; i++) {
        await h.render()
        await h.dispatchResize()
      }
      assert((await h.biddingPopupHostCount()) === 0, 'няма host-ове след playing, независимо от повторни render/resize')
    })

    // ─── [11] asserted invariant: non-bidding phase => 0 overlay nodes ─────
    await check(`[${vp.label}][11] invariant holds across the full phase matrix`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-11')
      assert((await h.biddingPopupHostCount()) === 1, 'baseline: bidding overlay трябва да съществува по време на bidding')
      const phases: Array<[string, any]> = [
        ['deal-last-3', await h.dealLastThreeGame()],
        ['next-round', await h.nextRoundGame()],
        ['playing', await h.playingGame()],
      ]
      for (const [label, game] of phases) {
        await h.snapshot('room-11', game)
        const hostCount = await h.biddingPopupHostCount()
        assert(hostCount === 0, `[${label}]: очаквах 0 bidding overlay nodes, получих ${hostCount}`)
      }
      // bidding отново (нов рунд) -> overlay легитимно се появява. next-round
      // паузата (0 карти) изчиства dealingAnimation cache-а (виж
      // syncDealingAnimationState/clearDealingAnimationState), затова новото
      // bidding snapshot (пак с видими карти) отново тригерира catch-up
      // deal-анимацията, преди bidding popup-ът реално да се появи — точно
      // както при нов истински рунд. Изчакваме реалния DOM резултат.
      await h.snapshot('room-11', await h.biddingGame())
      await page.waitForFunction(
        () => (window as any).__biddingLifecycleHarness.biddingPopupHostCount() === 1,
        undefined,
        { timeout: 8_000 },
      )
      assert((await h.biddingPopupHostCount()) === 1, 'нов bidding рунд трябва легитимно да покаже overlay-я')
    })

    await check(`[${vp.label}] Няма JS грешки в конзолата през целия сценарий`, () => {
      assert(errors.length === 0, `Конзолни грешки: ${errors.join(' | ')}`)
    })

    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
