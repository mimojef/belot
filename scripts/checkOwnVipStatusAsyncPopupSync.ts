/**
 * checkOwnVipStatusAsyncPopupSync.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression
 * for: own profile popup opens and correctly shows the "VIP · …" loading
 * placeholder (fixed in 9a162fb), but once /api/vip/status resolves
 * asynchronously, the popup DOM does NOT update immediately — it stays
 * stuck on "VIP · …" until some UNRELATED render happens elsewhere on the
 * site (e.g. a new private-room popup), at which point it suddenly shows
 * the correct days.
 *
 * ROOT CAUSE: ensureOwnVipStatusLoaded()'s async success callback wrote
 * state.ownVipActiveUntil/ownVipActiveUntilResolvedForProfileId correctly,
 * then called the GENERIC render(). The profile popup lives on
 * document.body (outside root.innerHTML, via syncProfilePopup/
 * renderPopupOnly) — render() -> renderLobbyScreen() has a skip-if-unchanged
 * guard on the root.innerHTML string, which does NOT include any VIP data,
 * so the guard's early return meant syncProfilePopup() (only called from
 * inside renderLobbyScreen(), after the guard) was never reached for this
 * particular render pass. Exactly the same class of bug as commit 899e1af
 * ("Fix Lobby own profile popup", profilePopupTargetRole) — this is its
 * sibling fetch (VIP status) hitting the identical guard.
 *
 * FIX: the success callback now calls renderPopupOnly({ skipAnimation: true })
 * instead of render() — targeted sync of the body-mounted popup, bypassing
 * the root-HTML skip-if-unchanged guard entirely, mirroring
 * ensureProfilePopupTargetRoleLoaded()'s already-working success path.
 *
 * This test is deliberately DOM/browser-based (not source-string matching)
 * because the bug is specifically about a render() call being SWALLOWED by
 * a guard elsewhere — a string search for "renderPopupOnly" existing
 * somewhere in the file proves nothing about which code path a given async
 * callback actually takes at runtime. It reproduces and FAILS on commit
 * 9a162fb (verified via git stash below is not part of this script, but was
 * confirmed manually — see the report).
 *
 * Covers [A]-[H] from the task brief:
 *  [A]  open own profile -> "VIP · …" (loading marker "1")
 *  [B]/[C]/[G] resolve mocked /api/vip/status with a future activeUntil ->
 *       the popup DOM shows "VIP · N дни" IMMEDIATELY after resolution,
 *       with ZERO other action/render performed in between (proves the fix,
 *       fails on 9a162fb where it would still read "VIP · …" here).
 *  [D]  resolved with activeUntil=null -> popup becomes "VIP · 0 дни"
 *       immediately (same zero-unrelated-render guarantee).
 *  [E]  popup closed BEFORE the promise resolves -> resolving afterwards
 *       does not reopen/re-render it (stays closed, no console error).
 *  [F]  account/profile switch (resetToLobby(), real logout->login lifecycle
 *       hook) BEFORE the stale fetch resolves -> the stale result is
 *       dropped (popup keeps showing "…" for the NEW profile, not the OLD
 *       profile's stale value); the NEW profile's own fetch, once resolved,
 *       shows correctly.
 *  [H]  own-profile markup (data-player-profile-own-summary) and foreign
 *       markup (data-player-profile-foreign-vip-days) never both/wrongly
 *       appear together in this real render pipeline — complements the
 *       pure-function foreign-profile regression coverage already in
 *       check:own-vip-status-loading-state (G1-G4 there), which this
 *       browser harness does not duplicate.
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
  isPopupOpen: () => Promise<boolean>
  getVipDaysText: () => Promise<string | null>
  getVipLoadingMarker: () => Promise<string | null>
  isOwnSummaryPresent: () => Promise<boolean>
  isForeignVipRowPresent: () => Promise<boolean>
  pendingVipStatusCount: () => Promise<number>
  openOwnProfileAndFlush: () => Promise<void>
  closePopupAndFlush: () => Promise<void>
  resolveOldestVipStatus: (activeUntil: string | null) => Promise<boolean>
  switchAccountAndReset: (newProfileId: string) => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__lobbyOwnVipStatusAsyncSyncHarness'
  const call = (fn: string, ...args: any[]) =>
    page.evaluate(([k, f, a]: any) => (window as any)[k][f](...a), [w, fn, args] as any)
  return {
    isPopupOpen: () => call('isPopupOpen'),
    getVipDaysText: () => call('getVipDaysText'),
    getVipLoadingMarker: () => call('getVipLoadingMarker'),
    isOwnSummaryPresent: () => call('isOwnSummaryPresent'),
    isForeignVipRowPresent: () => call('isForeignVipRowPresent'),
    pendingVipStatusCount: () => call('pendingVipStatusCount'),
    openOwnProfileAndFlush: () => call('openOwnProfileAndFlush'),
    closePopupAndFlush: () => call('closePopupAndFlush'),
    resolveOldestVipStatus: (activeUntil) => call('resolveOldestVipStatus', activeUntil),
    switchAccountAndReset: (newProfileId) => call('switchAccountAndReset', newProfileId),
  }
}

console.log('\n═══ checkOwnVipStatusAsyncPopupSync ═══\n')

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

  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/lobbyOwnVipStatusAsyncSyncHarness.html')
  const h = await harness(page)

  // ─── [A] Open own profile -> loading placeholder ──────────────────────
  await check('[A] opening the own profile popup shows the "VIP · …" loading placeholder', async () => {
    await h.openOwnProfileAndFlush()
    assert((await h.isPopupOpen()) === true, 'popup did not open')
    assert((await h.pendingVipStatusCount()) === 1, `expected exactly 1 in-flight VIP status fetch, got ${await h.pendingVipStatusCount()}`)
    assert((await h.getVipLoadingMarker()) === '1', 'loading marker should be "1" before the response resolves')
    assert((await h.getVipDaysText()) === '…', `expected "…" placeholder, got "${await h.getVipDaysText()}"`)
  })

  // ─── [B]/[C]/[G] Resolve active VIP -> popup updates IMMEDIATELY ───────
  await check('[B]/[C]/[G] resolving with a future activeUntil updates the popup DOM immediately, with ZERO unrelated render in between', async () => {
    const future = new Date(Date.now() + 379 * 24 * 60 * 60 * 1000).toISOString()
    const resolved = await h.resolveOldestVipStatus(future)
    assert(resolved === true, 'no pending VIP status fetch to resolve')
    // No other action performed here — this is the exact regression: on
    // commit 9a162fb, getVipDaysText() would still read "…" at this point,
    // because the success callback's generic render() was swallowed by
    // renderLobbyScreen()'s skip-if-unchanged guard.
    assert((await h.getVipLoadingMarker()) === '0', 'loading marker should flip to "0" immediately after resolution, without any unrelated render')
    const daysText = await h.getVipDaysText()
    assert(daysText !== null && /^\d+ (ден|дни)$/.test(daysText), `expected a real "N дни"/"1 ден" value immediately, got "${daysText}"`)
    assert(daysText !== '…', 'popup DOM is stuck on the loading placeholder after the response already resolved — the exact 9a162fb regression')
  })

  await check('[H-partial] own-profile markup is present, foreign VIP markup is absent, after a real successful resolution', async () => {
    assert((await h.isOwnSummaryPresent()) === true, 'own-profile summary markup should be present for the own popup')
    assert((await h.isForeignVipRowPresent()) === false, 'foreign VIP row markup must never appear on the own-profile popup')
  })

  // ─── [D] Resolve with activeUntil=null -> immediate "0 дни" ────────────
  await check('[D] closing and reopening, resolving with activeUntil=null shows "VIP · 0 дни" immediately (no unrelated render needed)', async () => {
    await h.closePopupAndFlush()
    assert((await h.isPopupOpen()) === false, 'popup did not close')
    await h.openOwnProfileAndFlush()
    assert((await h.getVipDaysText()) === '…', 'reopening should start a fresh loading state, not reuse a stale value')
    const resolved = await h.resolveOldestVipStatus(null)
    assert(resolved === true, 'no pending VIP status fetch to resolve')
    assert((await h.getVipLoadingMarker()) === '0', 'loading marker should be "0" for a resolved-inactive response')
    assert((await h.getVipDaysText()) === '0 дни', `expected "0 дни" immediately, got "${await h.getVipDaysText()}"`)
  })

  // ─── [E] Popup closed before resolution -> stale result is a no-op ─────
  await check('[E] closing the popup BEFORE the pending fetch resolves: resolving afterwards does not reopen/re-render it', async () => {
    await h.closePopupAndFlush()
    await h.openOwnProfileAndFlush()
    assert((await h.isPopupOpen()) === true, 'setup: popup should be open with a pending fetch')
    await h.closePopupAndFlush()
    assert((await h.isPopupOpen()) === false, 'popup should be closed now')
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
    const resolved = await h.resolveOldestVipStatus(future)
    assert(resolved === true, 'no pending VIP status fetch to resolve')
    assert((await h.isPopupOpen()) === false, 'a stale VIP status response must NOT reopen a closed popup')
  })

  // ─── [F] Account/profile switch before resolution -> stale result dropped
  await check('[F] switching profile (resetToLobby, real logout->login hook) before the old fetch resolves: the stale result is dropped', async () => {
    await h.openOwnProfileAndFlush()
    assert((await h.isPopupOpen()) === true, 'setup: popup open for profile "me"')
    assert((await h.pendingVipStatusCount()) === 1, 'setup: exactly one in-flight fetch for "me"')

    // Real logout->login lifecycle boundary — main.ts calls
    // lobby.resetToLobby() from BOTH paths (see resetToLobby()'s comment).
    // The popup was never explicitly closed, so it stays open but now
    // reflects profile "me2" (own-profile popups always re-derive their
    // identity live from getAuthSession(), never a frozen snapshot) — and
    // resetToLobby()'s own render() immediately starts a FRESH fetch for
    // "me2" via ensureOwnVipStatusLoaded(), so there are now two in-flight
    // fetches: the stale "me" one, and the fresh "me2" one.
    await h.switchAccountAndReset('me2')
    assert((await h.pendingVipStatusCount()) === 2, `expected the old "me" fetch AND a fresh "me2" fetch both in flight, got ${await h.pendingVipStatusCount()}`)
    assert((await h.getVipDaysText()) === '…', 'should show the loading placeholder for the new profile right after the switch')

    // Resolve the OLDEST (stale, "me") fetch first — it must be silently
    // dropped, not rendered as "me2"'s VIP status.
    const staleFuture = new Date(Date.now() + 999 * 24 * 60 * 60 * 1000).toISOString()
    const staleResolved = await h.resolveOldestVipStatus(staleFuture)
    assert(staleResolved === true, 'stale fetch should still be resolvable (just ignored on landing)')
    assert((await h.getVipDaysText()) === '…', 'a stale response from the PREVIOUS profile must not be rendered for the new profile')
    assert((await h.pendingVipStatusCount()) === 1, 'exactly the fresh "me2" fetch should remain pending')

    // Now resolve the fresh "me2" fetch -> this one SHOULD render, immediately.
    const freshFuture = new Date(Date.now() + 42 * 24 * 60 * 60 * 1000).toISOString()
    const freshResolved = await h.resolveOldestVipStatus(freshFuture)
    assert(freshResolved === true, 'fresh fetch should be resolvable')
    const daysText = await h.getVipDaysText()
    assert(daysText !== null && /^\d+ дни$/.test(daysText), `expected the fresh profile's real VIP days, got "${daysText}"`)
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
