/**
 * checkProfilePopupAdminActions.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * admin-only profile popup actions (Направи субадмин / чат админ / TOP чат
 * админ / Pika team) being missing on the FIRST open of another profile's
 * popup, immediately after the async target-role fetch resolves. Only VIP
 * ("Дай VIP", which does not depend on the target's role) was visible right
 * away; the rest appeared only once some unrelated render happened later, or
 * once the admin clicked "Дай VIP" (which happened to call renderPopupOnly()
 * directly and incidentally synced the DOM to the already-updated state).
 *
 * ROOT CAUSE: ensureProfilePopupTargetRoleLoaded() (createLobbyFlowController.ts)
 * asynchronously loads the target's account role via onAdminGetTargetRole,
 * then called the generic render() once the result arrived. The profile
 * popup lives on document.body (outside root.innerHTML, via
 * syncProfilePopup/renderPopupOnly) — render() -> renderLobbyScreen() has a
 * skip-if-unchanged guard on root.innerHTML, and profilePopupTargetRole never
 * affects that string, so the guard's early return meant syncProfilePopup()
 * (itself only called from inside renderLobbyScreen(), after the guard) was
 * never reached with the freshly loaded role. renderSubadminRoleControls (and
 * the analogous chat-admin/top-chat-admin/pika-team helpers) explicitly
 * render nothing while targetAccountRole === null — so those buttons stayed
 * hidden until an unrelated render happened to produce different root HTML.
 *
 * FIX: the async role-load callback now calls renderPopupOnly() directly —
 * the same document.body-targeted sync path already used elsewhere for this
 * popup — bypassing the root.innerHTML guard entirely.
 *
 * This test proves, with a real DOM (Playwright) and the real controller:
 *  [1] Initial open (role fetch still in flight): only VIP is visible, no
 *      admin-role-gated actions yet (sanity — proves the fetch is genuinely
 *      async in this harness, not resolved synchronously).
 *  [2] Once the target-role fetch resolves, ALL applicable admin actions
 *      (subadmin/chat-admin/top-chat-admin/pika-team) become visible
 *      IMMEDIATELY — without any further interaction (no VIP click needed).
 *  [3] Clicking "Дай VIP" only toggles the VIP form state — it does not
 *      change which other admin actions are visible (proves VIP is no longer
 *      a de-facto "refresh admin controls" trigger).
 *  [4] Close popup -> reopen the SAME profile: controls are correct again on
 *      first open (a second in-session open is not treated as a special
 *      case).
 *  [5] Opening a DIFFERENT target profile does not inherit stale controls
 *      from the previous profile while its own role fetch is in flight, and
 *      shows the right ones once that fetch resolves.
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

const TARGET_PROFILE_ID = 'target-1'
const SECOND_TARGET_PROFILE_ID = 'target-2'

type H = {
  openPlayersDirectoryAndFlush: () => Promise<void>
  openTargetProfileAndFlush: (profileId?: string) => Promise<void>
  resolvePendingRoleFetch: (profileId: string, role: string | null) => Promise<void>
  hasPendingRoleFetch: (profileId: string) => Promise<boolean>
  getRoleFetchCallCount: (profileId: string) => Promise<number>
  isPopupOpen: () => Promise<boolean>
  hasVipAction: () => Promise<boolean>
  hasGrantSubadminAction: () => Promise<boolean>
  hasGrantChatAdminAction: () => Promise<boolean>
  hasGrantTopChatAdminAction: () => Promise<boolean>
  hasGrantPikaTeamAction: () => Promise<boolean>
  clickVipGrantOpenAndFlush: () => Promise<void>
  closePopupAndFlush: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__profilePopupAdminActionsHarness'
  const call = (fn: string, ...args: any[]) =>
    page.evaluate(([k, f, a]: any) => (window as any)[k][f](...a), [w, fn, args] as any)
  return {
    openPlayersDirectoryAndFlush: () => call('openPlayersDirectoryAndFlush'),
    openTargetProfileAndFlush: (profileId) => call('openTargetProfileAndFlush', profileId),
    resolvePendingRoleFetch: (profileId, role) => call('resolvePendingRoleFetch', profileId, role),
    hasPendingRoleFetch: (profileId) => call('hasPendingRoleFetch', profileId),
    getRoleFetchCallCount: (profileId) => call('getRoleFetchCallCount', profileId),
    isPopupOpen: () => call('isPopupOpen'),
    hasVipAction: () => call('hasVipAction'),
    hasGrantSubadminAction: () => call('hasGrantSubadminAction'),
    hasGrantChatAdminAction: () => call('hasGrantChatAdminAction'),
    hasGrantTopChatAdminAction: () => call('hasGrantTopChatAdminAction'),
    hasGrantPikaTeamAction: () => call('hasGrantPikaTeamAction'),
    clickVipGrantOpenAndFlush: () => call('clickVipGrantOpenAndFlush'),
    closePopupAndFlush: () => call('closePopupAndFlush'),
  }
}

console.log('\n═══ checkProfilePopupAdminActions ═══\n')

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

  await page.goto('/scripts/fixtures/profilePopupAdminActionsHarness.html')
  const h = await harness(page)

  await h.openPlayersDirectoryAndFlush()
  await h.openTargetProfileAndFlush(TARGET_PROFILE_ID)

  await check('[1] Initial open (role fetch in flight): popup is open, VIP visible, admin-role-gated actions not yet shown', async () => {
    assert((await h.isPopupOpen()) === true, 'popup did not open')
    assert((await h.hasPendingRoleFetch(TARGET_PROFILE_ID)) === true, 'sanity: role fetch should still be in flight in this harness')
    assert((await h.hasVipAction()) === true, 'VIP action should be visible even before target role resolves (it does not depend on target role)')
    assert((await h.hasGrantSubadminAction()) === false, 'sanity: subadmin action should not be visible before the role fetch resolves')
  })

  await check('[2] Target-role fetch resolves -> ALL applicable admin actions appear immediately, no further interaction needed', async () => {
    await h.resolvePendingRoleFetch(TARGET_PROFILE_ID, 'player')
    assert((await h.hasGrantSubadminAction()) === true, 'Направи субадмин did not appear immediately once the role fetch resolved')
    assert((await h.hasGrantChatAdminAction()) === true, 'Направи чат админ did not appear immediately once the role fetch resolved')
    assert((await h.hasGrantTopChatAdminAction()) === true, 'Направи TOP чат админ did not appear immediately once the role fetch resolved')
    assert((await h.hasGrantPikaTeamAction()) === true, 'Екип Pika.bg action did not appear immediately once the role fetch resolved')
    assert((await h.hasVipAction()) === true, 'VIP action should still be visible')
  })

  await check('[3] Clicking "Дай VIP" only toggles the VIP form — other admin actions stay exactly as they were', async () => {
    const beforeSubadmin = await h.hasGrantSubadminAction()
    const beforeChatAdmin = await h.hasGrantChatAdminAction()
    await h.clickVipGrantOpenAndFlush()
    assert((await h.hasGrantSubadminAction()) === beforeSubadmin, 'VIP click changed subadmin action visibility — VIP must not be a de-facto admin-controls refresh trigger')
    assert((await h.hasGrantChatAdminAction()) === beforeChatAdmin, 'VIP click changed chat-admin action visibility')
  })

  await check('[4] Close popup -> reopen the SAME profile: controls are correct again on first open', async () => {
    await h.closePopupAndFlush()
    assert((await h.isPopupOpen()) === false, 'popup did not close')
    await h.openTargetProfileAndFlush(TARGET_PROFILE_ID)
    // Same profileId -> memoization guard means no new role fetch; state is
    // already loaded, so renderPopupOnly() on reopen must show it right away.
    assert((await h.hasGrantSubadminAction()) === true, 'reopening the same profile should show admin actions immediately (state already loaded)')
  })

  await check('[5] Opening a DIFFERENT target profile does not inherit stale controls, and shows correct ones once its own role fetch resolves', async () => {
    await h.closePopupAndFlush()
    await h.openTargetProfileAndFlush(SECOND_TARGET_PROFILE_ID)
    assert((await h.hasPendingRoleFetch(SECOND_TARGET_PROFILE_ID)) === true, 'sanity: second profile should trigger its own fresh role fetch')
    assert((await h.hasGrantSubadminAction()) === false, 'second profile popup must not inherit the first profile\'s already-resolved admin actions while its own fetch is in flight')
    await h.resolvePendingRoleFetch(SECOND_TARGET_PROFILE_ID, 'chat_admin')
    assert((await h.hasGrantSubadminAction()) === true, 'subadmin action should appear for the second profile once ITS role fetch resolves (chat_admin -> can still be made subadmin)')
    assert((await h.hasGrantChatAdminAction()) === false, 'chat-admin action should be hidden — this profile IS already chat_admin (shows revoke, not grant)')
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
