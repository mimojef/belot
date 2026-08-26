/**
 * checkTournamentStateANavbarStability.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * a STATE A ("Изчаквате победителя от маса X") bug: while the sibling feeder
 * match plays, the navbar / mobile "Меню" appeared to constantly rebuild
 * itself — desktop nav clicks were sometimes lost, and the mobile dropdown
 * flickered closed/reopened roughly every render.
 *
 * ROOT CAUSE (proved via this harness's MutationObserver + DOM-identity
 * probes, not speculation):
 *
 *   renderLobbyScreen() always did an unconditional `root.innerHTML = ...`
 *   full-tree rebuild on every render() call — there is no diffing. The
 *   existing STATE A live-score patch (patchTournamentInterRoundSiblingProgress
 *   in createLobbyFlowController.ts) already correctly bypasses render()
 *   entirely for tournament_feeder_score_progress (proved below — 0 rebuilds
 *   across repeated score ticks), so that patch was NOT the bug.
 *
 *   The actual trigger is any OTHER server message whose handler calls the
 *   generic render() unconditionally, with no `state.currentScreen` guard —
 *   e.g. lobby_chat_message (createLobbyFlowController.ts) updates the
 *   global chat feed and calls render() regardless of what screen is on
 *   screen. Every such event tore down and recreated the ENTIRE #app root,
 *   including the <details data-lobby-mobile-menu> element. mobileMenuOpen
 *   (module state) stayed logically true, so the freshly recreated <details>
 *   still carried the `open` attribute — but it was a BRAND NEW DOM node,
 *   and its panel's `animation: mobile-menu-shade-in ... both` (baked
 *   directly into the static template, not conditionally applied) replayed
 *   its entrance transition from scratch on every rebuild — visually
 *   indistinguishable from "closes and reopens". On desktop, the nav button
 *   the user's pointer was interacting with could be detached and replaced
 *   mid pointerdown/pointerup, silently dropping the click.
 *
 * FIX: renderLobbyScreen.ts now computes the full HTML string first, and
 * skips the `root.innerHTML` write entirely (a real no-op, not a debounce or
 * CSS trick) when it is byte-identical to what's already rendered AND
 * root still holds our own last-rendered markup (data-lobby-screen-root
 * marker present) — see the "Skip-if-unchanged guard" comment there.
 *
 * This test proves, with a real DOM (Playwright) and the real controller
 * (not a mock):
 *  [A] STATE A renders; opening the mobile menu is a targeted DOM mutation
 *      (no root rebuild).
 *  [B] Repeated tournament_feeder_score_progress while on STATE A causes
 *      ZERO root rebuilds — the existing targeted patch still works.
 *  [C] An unrelated lobby_chat_message causes at most one "catch-up" rebuild
 *      (only if state had drifted since the last full render via a targeted
 *      patch), then ZERO further rebuilds for repeated unrelated messages —
 *      navbar/mobile-menu DOM node identity survives, menu stays open.
 *  [D] A REAL content change (round-transition assignment arriving, STATE A
 *      -> STATE B) still triggers a real rebuild — the guard does not
 *      over-suppress legitimate transitions.
 *  [E] If a different renderer overwrites #app root out from under the lobby
 *      controller (matchmaking-room / active-room share the same root), the
 *      guard detects the foreign markup and rebuilds instead of wrongly
 *      skipping.
 *
 * FOLLOW-UP FIX (same bug family, found after the above): opening/closing
 * the mobile menu (openMobileMenu/closeMobileMenuAnimated) is itself a
 * targeted DOM mutation — no render() call, by design, so it's instant. But
 * that left lastRenderedRootHtml (the skip-if-unchanged cache) pointing at a
 * string baked with the OLD mobileMenuOpen value. The very FIRST unrelated
 * blind render() after a native open/close would then see a real string
 * diff (this one attribute) and do exactly one unnecessary full rebuild — a
 * one-shot flicker on open/close, even though the DOM already showed the
 * correct state and nothing else had changed. Confirmed via DOM node
 * identity probes on `[data-lobby-mobile-menu]` itself: the node's identity
 * changed exactly once, on the first blind render after toggling, matching
 * the reported "one flicker, then stable" symptom exactly.
 *
 * FIX: openMobileMenu/closeMobileMenuAnimated now also patch
 * lastRenderedRootHtml in place (a targeted string replace mirroring the
 * ONE template spot mobileMenuOpen affects — the `<details
 * data-lobby-mobile-menu="1" ...>` tag), keeping the cache truthful without
 * ever forcing a rebuild. Fails safe: if the markers aren't found (e.g. on
 * desktop, where this markup doesn't exist, or if the template text ever
 * changes), the string is left untouched and the normal mismatch-detection
 * path just does one real rebuild instead — never a wrong skip.
 *
 *  [F] Opening the mobile menu, then an unrelated blind render(): ZERO
 *      rebuilds even on the very FIRST such event (not just "at most one" —
 *      this isolates the one-shot-flicker regression from the separately
 *      tolerated score-drift catch-up in [C]). `<details
 *      data-lobby-mobile-menu="1">` node identity survives.
 *  [G] Same, for closing the menu.
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
  enterStateAOnDetail: () => Promise<void>
  simulateFeederScoreProgress: (scoreA: number, scoreB: number) => Promise<void>
  simulateLobbyChatMessage: (seq: number) => Promise<void>
  simulateRoundTransitionAssignment: () => Promise<void>
  simulateForeignRootTakeover: () => Promise<void>
  getRootReplaceCount: () => Promise<number>
  resetRootReplaceCount: () => Promise<void>
  getScoreText: () => Promise<string | null>
  domHasStateAMarkup: () => Promise<boolean>
  domHasStateBMarkup: () => Promise<boolean>
  clickMobileMenuSummary: () => Promise<void>
  isMobileMenuOpen: () => Promise<boolean | null>
  tagMobileMenuPanelNode: () => Promise<string | null>
  checkMobileMenuPanelNodeTag: () => Promise<string | null>
  tagMobileMenuDetailsNode: () => Promise<string | null>
  checkMobileMenuDetailsNodeTag: () => Promise<string | null>
}

async function harness(page: Page): Promise<H> {
  const w = '__tournamentStateANavbarStabilityHarness'
  const call = (fn: string, ...args: any[]) =>
    page.evaluate(([k, f, a]: any) => (window as any)[k][f](...a), [w, fn, args] as any)
  return {
    enterStateAOnDetail: () => call('enterStateAOnDetail'),
    simulateFeederScoreProgress: (a, b) => call('simulateFeederScoreProgress', a, b),
    simulateLobbyChatMessage: (seq) => call('simulateLobbyChatMessage', seq),
    simulateRoundTransitionAssignment: () => call('simulateRoundTransitionAssignment'),
    simulateForeignRootTakeover: () => call('simulateForeignRootTakeover'),
    getRootReplaceCount: () => call('getRootReplaceCount'),
    resetRootReplaceCount: () => call('resetRootReplaceCount'),
    getScoreText: () => call('getScoreText'),
    domHasStateAMarkup: () => call('domHasStateAMarkup'),
    domHasStateBMarkup: () => call('domHasStateBMarkup'),
    clickMobileMenuSummary: () => call('clickMobileMenuSummary'),
    isMobileMenuOpen: () => call('isMobileMenuOpen'),
    tagMobileMenuPanelNode: () => call('tagMobileMenuPanelNode'),
    checkMobileMenuPanelNodeTag: () => call('checkMobileMenuPanelNodeTag'),
    tagMobileMenuDetailsNode: () => call('tagMobileMenuDetailsNode'),
    checkMobileMenuDetailsNodeTag: () => call('checkMobileMenuDetailsNodeTag'),
  }
}

console.log('\n═══ checkTournamentStateANavbarStability ═══\n')

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

  // Mobile viewport — the reported dropdown flicker is mobile-specific
  // (<details data-lobby-mobile-menu>), and this size also exercises the
  // desktop-nav-equivalent click-loss mechanism identically since both
  // layouts share the same full-rebuild renderLobbyScreen() code path.
  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/tournamentStateANavbarStabilityHarness.html')
  const h = await harness(page)

  await check('[A] STATE A renders; opening the mobile menu is a targeted DOM mutation (no root rebuild)', async () => {
    await h.enterStateAOnDetail()
    assert((await h.domHasStateAMarkup()) === true, 'STATE A markup did not render')
    await h.resetRootReplaceCount()
    await h.clickMobileMenuSummary()
    assert((await h.isMobileMenuOpen()) === true, 'mobile menu did not open on click')
    assert((await h.getRootReplaceCount()) === 0, 'opening the mobile menu should not touch root.innerHTML at all')
  })

  await check('[F] Opening the mobile menu, then an unrelated blind render(): ZERO rebuilds even on the very FIRST such event (the one-shot-flicker regression)', async () => {
    // Isolated from [C]'s score-drift scenario on purpose: nothing else has
    // changed since the last full render at this point, so the ONLY thing
    // that could make the cache stale is the native open itself — exactly
    // what the fix targets.
    const detailsTag = await h.tagMobileMenuDetailsNode()
    const panelTag = await h.tagMobileMenuPanelNode()
    await h.resetRootReplaceCount()
    await h.simulateLobbyChatMessage(101)
    assert((await h.getRootReplaceCount()) === 0, `expected 0 rebuilds on the first unrelated event right after a native menu open, got ${await h.getRootReplaceCount()}`)
    assert((await h.isMobileMenuOpen()) === true, 'mobile menu closed after the first unrelated event — this was the one-shot flicker')
    assert((await h.checkMobileMenuDetailsNodeTag()) === detailsTag, '<details data-lobby-mobile-menu="1"> node identity changed on the first unrelated event — this was the one-shot flicker')
    assert((await h.checkMobileMenuPanelNodeTag()) === panelTag, 'mobile menu panel node identity changed on the first unrelated event')

    // A few more, for good measure — must stay at 0.
    await h.resetRootReplaceCount()
    await h.simulateLobbyChatMessage(102)
    await h.simulateLobbyChatMessage(103)
    assert((await h.getRootReplaceCount()) === 0, 'expected 0 rebuilds for further unrelated events with nothing changed')
    assert((await h.checkMobileMenuDetailsNodeTag()) === detailsTag, 'details node identity changed on a later unrelated event')
  })

  await check('[G] Closing the mobile menu, then an unrelated blind render(): ZERO rebuilds on the first such event, symmetric with [F]', async () => {
    const detailsTag = await h.tagMobileMenuDetailsNode()
    await h.clickMobileMenuSummary() // menu is open (from [F]) -> this closes it
    await h.resetRootReplaceCount()
    await h.simulateLobbyChatMessage(104)
    assert((await h.getRootReplaceCount()) === 0, `expected 0 rebuilds on the first unrelated event right after a native menu close, got ${await h.getRootReplaceCount()}`)
    assert((await h.checkMobileMenuDetailsNodeTag()) === detailsTag, '<details data-lobby-mobile-menu="1"> node identity changed on the first unrelated event after closing')

    // Re-open for the tests below, which expect the menu to be open.
    await h.clickMobileMenuSummary()
    assert((await h.isMobileMenuOpen()) === true, 'sanity: mobile menu should be open again for subsequent checks')
  })

  await check('[B] Repeated tournament_feeder_score_progress while on STATE A causes ZERO root rebuilds', async () => {
    await h.resetRootReplaceCount()
    const tag = await h.tagMobileMenuPanelNode()
    for (let i = 0; i < 10; i++) {
      await h.simulateFeederScoreProgress(10 + i, 8)
    }
    assert((await h.getRootReplaceCount()) === 0, `expected 0 root rebuilds from score progress, got ${await h.getRootReplaceCount()}`)
    assert((await h.getScoreText()) === '19 : 8', `score DOM patch did not apply, got ${await h.getScoreText()}`)
    assert((await h.isMobileMenuOpen()) === true, 'mobile menu unexpectedly closed')
    assert((await h.checkMobileMenuPanelNodeTag()) === tag, 'mobile menu panel DOM node identity changed — it was rebuilt')
  })

  await check('[C] Unrelated lobby_chat_message: at most 1 catch-up rebuild, then 0 further rebuilds — navbar/menu identity survives', async () => {
    // The score-progress patches above updated JS state via a targeted DOM
    // patch that bypasses render() — so the cached "last full render" string
    // is stale (still score 10:8) relative to live state (19:8). The FIRST
    // subsequent real render() legitimately has to catch up once.
    await h.resetRootReplaceCount()
    await h.simulateLobbyChatMessage(1)
    const afterFirst = await h.getRootReplaceCount()
    assert(afterFirst <= 1, `expected at most 1 catch-up rebuild, got ${afterFirst}`)

    if ((await h.isMobileMenuOpen()) !== true) {
      await h.clickMobileMenuSummary()
    }
    assert((await h.isMobileMenuOpen()) === true, 'sanity: mobile menu should be open before the real test')
    const tag = await h.tagMobileMenuPanelNode()

    await h.resetRootReplaceCount()
    await h.simulateLobbyChatMessage(2)
    await h.simulateLobbyChatMessage(3)
    await h.simulateLobbyChatMessage(4)
    assert((await h.getRootReplaceCount()) === 0, `expected 0 further rebuilds for unrelated messages once caught up, got ${await h.getRootReplaceCount()}`)
    assert((await h.isMobileMenuOpen()) === true, 'mobile menu closed after unrelated lobby chat traffic — this was the reported flicker')
    assert((await h.checkMobileMenuPanelNodeTag()) === tag, 'mobile menu panel DOM node was rebuilt by an unrelated chat message — this was the reported flicker')
  })

  await check('[D] A REAL content change (round-transition assignment, STATE A -> STATE B) still triggers a rebuild', async () => {
    await h.resetRootReplaceCount()
    await h.simulateRoundTransitionAssignment()
    assert((await h.getRootReplaceCount()) >= 1, 'STATE A -> STATE B must still cause a real rebuild — the guard must not over-suppress legitimate transitions')
    assert((await h.domHasStateBMarkup()) === true, 'STATE B markup did not render after the round-transition assignment')
  })

  await check('[E] A foreign renderer overwriting #app root is detected — the guard does not wrongly skip the next real render', async () => {
    await h.enterStateAOnDetail()
    assert((await h.domHasStateAMarkup()) === true, 'sanity: STATE A markup should be visible again')
    await h.simulateForeignRootTakeover()
    await h.resetRootReplaceCount()
    // Same tournament detail, unchanged — normally this exact re-render
    // would produce the SAME string as before the foreign takeover and get
    // skipped; the marker check must force a real rebuild here instead,
    // since root currently holds someone else's markup.
    await h.simulateLobbyChatMessage(5)
    assert((await h.domHasStateAMarkup()) === true, 'STATE A markup was not restored after a foreign root takeover — the skip-if-unchanged guard wrongly left foreign markup in place')
  })

  await check('Няма JS грешки в конзолата през целия сценарий', () => {
    assert(errors.length === 0, `console errors: ${errors.join('; ')}`)
  })

  await context.close()

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
