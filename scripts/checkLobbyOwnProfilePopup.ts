/**
 * checkLobbyOwnProfilePopup.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * the Lobby own-profile entry points (avatar click, "ПРОФИЛ" link click —
 * both render [data-lobby-profile-button="1"]) appearing to do nothing,
 * while the exact same canonical own-profile popup opened correctly from
 * the Players directory card click.
 *
 * ROOT CAUSE: onProfileClick (createLobbyFlowController.ts) set
 * state.profilePopupOpen/profilePopupProfile/profilePopupCanEdit and called
 * the generic render(). The profile popup lives on document.body (outside
 * root.innerHTML, via syncProfilePopup/renderPopupOnly) — render() ->
 * renderLobbyScreen() has a skip-if-unchanged guard on root.innerHTML
 * (introduced in commit 1915e7d, "Fix lobby render churn during tournament
 * wait", part of the tournament integration series — predates this
 * session's three fixes), and none of the popup-open state fields affect
 * that string, so the guard's early return meant syncProfilePopup() (itself
 * only called from inside renderLobbyScreen(), after the guard) was never
 * reached — the click appeared to silently do nothing. The
 * onProfileClick handler itself dates back to the original base commit
 * (e618067) — the bug was latent until the guard was introduced, which is
 * what actually made it observable.
 *
 * The working Players-card path (openProtectedProfileById's isOwn branch)
 * already called renderPopupOnly() directly for exactly this reason — it
 * was never affected.
 *
 * FIX: onProfileClick now calls renderPopupOnly() directly, mirroring the
 * already-working Players-card own-profile path — no second popup
 * implementation, no synthetic navigation, reusing the existing canonical
 * open-profile flow.
 *
 * This test proves, with a real DOM (Playwright) and the real controller:
 *  [1] Lobby renders exactly two own-profile entry points (avatar + ПРОФИЛ
 *      link), both sharing [data-lobby-profile-button="1"] — sanity, proves
 *      the fix covers both without a separate implementation.
 *  [2] Clicking the avatar opens the canonical own-profile popup
 *      immediately.
 *  [3] Close -> clicking the "ПРОФИЛ" link opens the same popup immediately.
 *  [4] Close -> reopening via either entry point still works (no stale
 *      state after a close/reopen cycle).
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
  clickAvatarAndFlush: () => Promise<void>
  clickProfileLinkAndFlush: () => Promise<void>
  closePopupAndFlush: () => Promise<void>
  getProfileButtonCount: () => Promise<number>
}

async function harness(page: Page): Promise<H> {
  const w = '__lobbyOwnProfilePopupHarness'
  const call = (fn: string, ...args: any[]) =>
    page.evaluate(([k, f, a]: any) => (window as any)[k][f](...a), [w, fn, args] as any)
  return {
    isPopupOpen: () => call('isPopupOpen'),
    clickAvatarAndFlush: () => call('clickAvatarAndFlush'),
    clickProfileLinkAndFlush: () => call('clickProfileLinkAndFlush'),
    closePopupAndFlush: () => call('closePopupAndFlush'),
    getProfileButtonCount: () => call('getProfileButtonCount'),
  }
}

console.log('\n═══ checkLobbyOwnProfilePopup ═══\n')

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

  await page.goto('/scripts/fixtures/lobbyOwnProfilePopupHarness.html')
  const h = await harness(page)

  await check('[1] Lobby renders both own-profile entry points (avatar + ПРОФИЛ) sharing the same action marker', async () => {
    assert((await h.isPopupOpen()) === false, 'sanity: popup should start closed')
    assert((await h.getProfileButtonCount()) >= 2, `expected at least 2 [data-lobby-profile-button="1"] elements (avatar + ПРОФИЛ), got ${await h.getProfileButtonCount()}`)
  })

  await check('[2] Clicking the Lobby avatar opens the canonical own-profile popup immediately', async () => {
    await h.clickAvatarAndFlush()
    assert((await h.isPopupOpen()) === true, 'avatar click did not open the profile popup')
  })

  await check('[3] Close -> clicking "ПРОФИЛ" opens the same popup immediately', async () => {
    await h.closePopupAndFlush()
    assert((await h.isPopupOpen()) === false, 'popup did not close')
    await h.clickProfileLinkAndFlush()
    assert((await h.isPopupOpen()) === true, 'ПРОФИЛ click did not open the profile popup')
  })

  await check('[4] Close -> reopen via avatar again: no stale state after a close/reopen cycle', async () => {
    await h.closePopupAndFlush()
    assert((await h.isPopupOpen()) === false, 'popup did not close')
    await h.clickAvatarAndFlush()
    assert((await h.isPopupOpen()) === true, 'reopening via the avatar after a close/reopen cycle did not work')
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
