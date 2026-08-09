/**
 * checkBidSubmitRecovery.ts
 *
 * Real browser (Playwright), real production code, real DOM, real click
 * path — behavioral regression за директния bid-submit freeze bug
 * (production report: "тя е под ръка, казва си обявата и таблото не се
 * скрива и забива"). Огледално на checkBiddingBoardOverlayInvariant.ts, но
 * фокусирано конкретно върху submitBidActionFromUi -> markBiddingPopupPending
 * -> bid-response watchdog -> requestBidResync -> forceReconnectForZombieConnection
 * веригата (createActiveRoomFlowController.ts), не общия popup-lifecycle
 * инвариант.
 *
 * Всички тестове минават през РЕАЛЕН DOM click (page.click), не директно
 * извикване на submitBidActionFromUi — точно пътят, по който продукционен
 * потребител действително подава обява.
 *
 * BID_RESPONSE_WATCHDOG_MS/BID_RESYNC_RESPONSE_TIMEOUT_MS = 5000ms всеки
 * (createActiveRoomFlowController.ts) — тестовете чакат реално време (не
 * mock-нат clock), за да избегнат странични ефекти върху несвързани
 * production timers (bid countdown, bubble expiry, bot takeover) при глобално
 * time-warping. Затова suite-ът отнема известно реално време — приемливо за
 * dedicated regression check, не за unit test на всеки commit.
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

type PopupState = {
  exists: boolean
  opacity: string | null
  pointerEvents: string | null
  buttonsDisabled: boolean | null
  errorText: string | null
}

type H = {
  enter: (roomId: string) => Promise<void>
  snapshot: (roomId: string, game: any) => Promise<void>
  serverError: (message: string) => Promise<void>
  biddingGame: (overrides?: any) => Promise<any>
  dealLastThreeGame: () => Promise<any>
  playingGame: () => Promise<any>
  biddingPopupHostCount: () => Promise<number>
  biddingPopupState: () => Promise<PopupState>
  clickBidAction: (action: string) => Promise<boolean>
  getBidCommands: () => Promise<number>
  getResyncRequestCount: () => Promise<number>
  getReconnectFallbackCount: () => Promise<number>
  reset: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  return {
    enter: (roomId) => page.evaluate((r) => (window as any).__biddingLifecycleHarness.enter(r), roomId),
    snapshot: (roomId, game) => page.evaluate(([r, g]: any) => (window as any).__biddingLifecycleHarness.snapshot(r, g), [roomId, game] as any),
    serverError: (message) => page.evaluate((m) => (window as any).__biddingLifecycleHarness.serverError(m), message),
    biddingGame: (overrides) => page.evaluate((o) => (window as any).__biddingLifecycleHarness.biddingGame(o ?? {}), overrides),
    dealLastThreeGame: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.dealLastThreeGame()),
    playingGame: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.playingGame()),
    biddingPopupHostCount: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.biddingPopupHostCount()),
    biddingPopupState: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.biddingPopupState()),
    clickBidAction: (action) => page.evaluate((a) => (window as any).__biddingLifecycleHarness.clickBidAction(a), action),
    getBidCommands: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.getBidCommands()),
    getResyncRequestCount: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.getResyncRequestCount()),
    getReconnectFallbackCount: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.getReconnectFallbackCount()),
    reset: () => page.evaluate(() => (window as any).__biddingLifecycleHarness.reset()),
  }
}

async function enterAtBidding(h: H, page: Page, roomId: string, overrides: any = {}): Promise<any> {
  await h.enter(roomId)
  const game = await h.biddingGame(overrides)
  await h.snapshot(roomId, game)
  await page.waitForFunction(
    () => (window as any).__biddingLifecycleHarness.biddingPopupHostCount() === 1,
    undefined,
    { timeout: 8_000 },
  )
  return game
}

async function waitForResyncRequested(h: H, page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__biddingLifecycleHarness.getResyncRequestCount() === 1,
    undefined,
    { timeout: 7_000 },
  )
}

async function waitForReconnectFallback(h: H, page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__biddingLifecycleHarness.getReconnectFallbackCount() === 1,
    undefined,
    { timeout: 7_000 },
  )
}

console.log('\n═══ checkBidSubmitRecovery ═══\n')

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

    // ─── [1] normal bid: tap -> pending -> room_snapshot -> cleared ────────
    await check(`[${vp.label}][1] normal bid: real click -> pending -> room_snapshot resolves it -> correct next state`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-1')
      const clicked = await h.clickBidAction('pass')
      assert(clicked, 'реалният click трябваше да уцели активен бутон')
      const pendingState = await h.biddingPopupState()
      assert(pendingState.buttonsDisabled === true, 'веднага след tap бутоните трябва да са disabled (pending)')
      // Сървърът отговаря нормално: pass записан, следващ bidder е bot.
      const next = await h.biddingGame()
      next.bidding.entries = [{ seat: 'bottom', action: { type: 'pass' } }]
      next.bidding.currentBidderSeat = 'left'
      next.bidding.canSubmitBid = false
      await h.snapshot('room-1', next)
      assert((await h.biddingPopupHostCount()) === 0, 'не е ред на локалния играч -> popup трябва да изчезне (не да остане блед)')
      assert((await h.getResyncRequestCount()) === 0, 'нормален round-trip не трябва да стига до watchdog/resync')
    })

    // ─── [2] final bid: tap -> playing snapshot -> host count = 0 ──────────
    await check(`[${vp.label}][2] final bid: tap -> playing snapshot -> bidding host count = 0`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-2')
      await h.clickBidAction('all-trumps')
      await h.snapshot('room-2', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'popup трябва да изчезне след преход в playing')
      assert((await h.getResyncRequestCount()) === 0, 'нормален round-trip не трябва да стига до watchdog/resync')
    })

    // ─── [3] no response: watchdog fires, resync requested ─────────────────
    await check(`[${vp.label}][3] no response: popup opacity 0.72 + disabled, watchdog fires, resync requested`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-3')
      await h.clickBidAction('pass')
      const state = await h.biddingPopupState()
      assert(state.exists, 'popup трябва все още да съществува веднага след tap')
      assert(state.opacity === '0.72', `очаквах opacity 0.72, получих ${state.opacity}`)
      assert(state.pointerEvents === 'none', 'pointer-events трябва да е none по време на pending')
      assert(state.buttonsDisabled === true, 'бутоните трябва да са disabled по време на pending')
      await waitForResyncRequested(h, page)
      assert((await h.getResyncRequestCount()) === 1, 'watchdog-ът трябваше да поиска точно един resync')
    })

    // ─── [4] resync: still bidding, still local turn -> unblocked ──────────
    await check(`[${vp.label}][4] resync says server still expects local bidder: pending cleared, exactly one active popup, controls enabled`, async () => {
      await h.reset()
      const original = await enterAtBidding(h, page, 'room-4')
      await h.clickBidAction('pass')
      await waitForResyncRequested(h, page)
      // Resync-ът връща СЪЩОТО bidding състояние -> bid-ът никога не е бил
      // приложен server-side (case C).
      await h.snapshot('room-4', original)
      assert((await h.biddingPopupHostCount()) === 1, 'очаквах точно един активен popup след resync case C')
      const state = await h.biddingPopupState()
      assert(state.buttonsDisabled === false, 'бутоните трябва да са отново активни след resync case C')
      assert(state.opacity !== '0.72', 'popup-ът не трябва да остане блед след resync case C')
      assert(
        state.errorText !== null && state.errorText.includes('не беше потвърдена'),
        `очаквах error toast за непотвърдена обява, получих ${state.errorText}`,
      )
    })

    // ─── [5] resync: server moved to playing -> popup removed ──────────────
    await check(`[${vp.label}][5] resync says server moved to playing: popup removed`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-5')
      await h.clickBidAction('pass')
      await waitForResyncRequested(h, page)
      await h.snapshot('room-5', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'popup трябва да изчезне след resync -> playing')
    })

    // ─── [6] bid actually accepted, response delayed: no duplicate submit ──
    await check(`[${vp.label}][6] original bid was actually accepted but response was delayed: watchdog/resync must NOT submit a duplicate bid`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-6')
      await h.clickBidAction('pass')
      assert((await h.getBidCommands()) === 1, 'очаквах точно едно submitBidAction извикване след tap-а')
      await waitForResyncRequested(h, page)
      // Резолюция: bid-ът РЕАЛНО е бил приложен, само отговорът закъсня.
      const resolved = await h.biddingGame()
      resolved.bidding.entries = [{ seat: 'bottom', action: { type: 'pass' } }]
      resolved.bidding.currentBidderSeat = 'left'
      resolved.bidding.canSubmitBid = false
      await h.snapshot('room-6', resolved)
      assert((await h.getBidCommands()) === 1, 'watchdog/resync не трябва да предизвиква втори submitBidAction')
      assert((await h.biddingPopupHostCount()) === 0, 'не е ред на локалния играч -> popup трябва да е премахнат')
    })

    // ─── [7] late original snapshot arrives after resync: idempotent ───────
    await check(`[${vp.label}][7] late original snapshot arrives after resync: idempotent UI, no duplicate popup`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-7')
      await h.clickBidAction('pass')
      await waitForResyncRequested(h, page)
      await h.snapshot('room-7', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'baseline след resync -> playing')
      // "Закъснелият" оригинален отговор пристига след resync-а — идемпотентно.
      await h.snapshot('room-7', await h.playingGame())
      assert((await h.biddingPopupHostCount()) === 0, 'повторна late snapshot не трябва да пресъздава popup')
    })

    // ─── [8] shutdown/explicit error: pending cleared immediately ──────────
    await check(`[${vp.label}][8] shutdown error: pending cleared immediately, no permanent faded board`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-8')
      await h.clickBidAction('pass')
      assert((await h.biddingPopupState()).buttonsDisabled === true, 'веднага след tap трябва да е pending/disabled')
      await h.serverError('Сървърът рестартира. Моля опитайте отново.')
      const state = await h.biddingPopupState()
      assert(state.exists, 'popup трябва да остане видим (все още bidding, все още ред на играча)')
      assert(state.buttonsDisabled === false, 'бутоните трябва да са активни веднага след error-а, без чакане на watchdog')
      assert((await h.getResyncRequestCount()) === 0, 'watchdog-ът трябваше да е cancel-нат от error handler-а, resync не биваше да стартира')
    })

    // ─── [9] resync gets no response: exactly one reconnect fallback ───────
    await check(`[${vp.label}][9] resync gets no response: exactly one existing reconnect fallback triggered`, async () => {
      await h.reset()
      await enterAtBidding(h, page, 'room-9')
      await h.clickBidAction('pass')
      await waitForResyncRequested(h, page)
      await waitForReconnectFallback(h, page)
      assert((await h.getReconnectFallbackCount()) === 1, 'очаквах точно един reconnect fallback')
      // Изчакваме допълнително, за да сме сигурни, че НЕ се задейства втори път.
      await page.waitForTimeout(1_500)
      assert((await h.getReconnectFallbackCount()) === 1, 'reconnect fallback не трябва да се задейства повторно (dedupe)')
    })

    // ─── [10] first bidder ("под ръка"): no prior bubble timers ────────────
    await check(`[${vp.label}][10] first bidder ("под ръка", entries=[]): recovery still works with no prior bubble timers`, async () => {
      await h.reset()
      const original = await enterAtBidding(h, page, 'room-10', {
        bidding: {
          winningBid: null,
          currentBidderSeat: 'bottom',
          entries: [],
          canSubmitBid: true,
          validActions: {
            pass: true, noTrumps: true, allTrumps: true, double: false, redouble: false,
            suits: { clubs: true, diamonds: true, hearts: true, spades: true },
          },
        },
      })
      await h.clickBidAction('pass')
      await waitForResyncRequested(h, page)
      await h.snapshot('room-10', original)
      const state = await h.biddingPopupState()
      assert((await h.biddingPopupHostCount()) === 1, 'first-bidder recovery: очаквах точно един popup')
      assert(state.buttonsDisabled === false, 'first-bidder recovery: бутоните трябва да са активни')
    })

    // ─── [11] previous bidder's bubble timer fires mid-pending ─────────────
    await check(`[${vp.label}][11] previous bidder's bubble timer fires while local bid is pending: must not corrupt recovery`, async () => {
      await h.reset()
      const withPriorEntry = await enterAtBidding(h, page, 'room-11', {
        bidding: {
          winningBid: null,
          currentBidderSeat: 'bottom',
          entries: [{ seat: 'left', action: { type: 'pass' } }],
          canSubmitBid: true,
          validActions: {
            pass: true, noTrumps: true, allTrumps: true, double: false, redouble: false,
            suits: { clubs: true, diamonds: true, hearts: true, spades: true },
          },
        },
      })
      await h.clickBidAction('pass')
      // Изчакваме bubble-expiry прозореца (1600ms, biddingUiState.ts) да мине
      // ПРЕДИ watchdog-а (5000ms) — точно застъпването, което по-рано
      // разследвахме като отделна (опровергана) хипотеза.
      await page.waitForTimeout(2_000)
      assert((await h.getResyncRequestCount()) === 0, 'bubble-expiry render не трябва сам да предизвиква resync')
      await waitForResyncRequested(h, page)
      await h.snapshot('room-11', withPriorEntry)
      const state = await h.biddingPopupState()
      assert((await h.biddingPopupHostCount()) === 1, 'recovery след bubble-timer interference: очаквах точно един popup')
      assert(state.buttonsDisabled === false, 'recovery след bubble-timer interference: бутоните трябва да са активни')
    })

    // ─── [12] PASS and contract actions both go through the same recovery ──
    await check(`[${vp.label}][12] PASS action: same watchdog/resync/case-C mechanism works`, async () => {
      await h.reset()
      const original = await enterAtBidding(h, page, 'room-12a')
      await h.clickBidAction('pass')
      await waitForResyncRequested(h, page)
      await h.snapshot('room-12a', original)
      assert((await h.biddingPopupState()).buttonsDisabled === false, 'PASS: recovery трябва да работи')
    })
    await check(`[${vp.label}][12] contract (all-trumps) action: same watchdog/resync/case-C mechanism works`, async () => {
      await h.reset()
      const original = await enterAtBidding(h, page, 'room-12b')
      await h.clickBidAction('all-trumps')
      await waitForResyncRequested(h, page)
      await h.snapshot('room-12b', original)
      assert((await h.biddingPopupState()).buttonsDisabled === false, 'contract action: recovery трябва да работи')
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
