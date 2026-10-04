/**
 * checkProfilePopupGiftCoinsPrivilege.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * "Подари жълтици" showing up in the profile popup for a NON-privileged
 * viewer (role==='player') on an accepted-friend profile.
 *
 * ROOT CAUSE: the accepted-friendship giftFriendshipId overlay (the condition
 * that decides whether the "Подари жълтици" button is shown for an accepted
 * friend) existed in TWO independent places in createLobbyFlowController.ts:
 *  - buildLobbyScreenState() — correctly gated on the viewer being a
 *    privileged gift-coins sender (role==='pika_team' || role==='admin'),
 *    mirroring the backend authorization in server/src/index.ts
 *    (isPikaTeamGiftMaxAmountSession || isAdminGiftUnlimitedSession).
 *  - buildPopupFriendshipAction() — used by renderPopupOnly(), the ACTUAL
 *    path taken every time a foreign profile popup opens via
 *    openProtectedProfileById(). This copy had NO role gate at all: any
 *    logged-in viewer, including a plain 'player', saw "Подари жълтици" for
 *    any accepted friend.
 *
 * FIX: both call sites now delegate to one shared helper,
 * applyPrivilegedGiftCoinsFriendshipOverlay() (backed by the
 * isPrivilegedGiftCoinsSenderAuthSession() predicate), so they cannot
 * diverge again.
 *
 * This test proves, with a real DOM (Playwright) and the real controller:
 *  [1]/[2] player (not privileged) never sees ANY "Подари жълтици" variant,
 *      whether the target is an accepted friend or a stranger.
 *  [3] pika_team + accepted friend -> accepted-friend gift-coins action
 *      (data-player-profile-gift-coins) is visible.
 *  [4] pika_team + non-friend -> friendship-bypass gift-coins action
 *      (data-player-profile-gift-coins-bypass) is still visible (pre-existing
 *      behavior, untouched by this fix).
 *  [5] admin + accepted friend -> accepted-friend gift-coins action is
 *      visible.
 *  [6] admin + non-friend -> no gift-coins action at all (no new bypass
 *      introduced for admin — matches pre-existing behavior).
 *  [7] player, regardless of friendship -> "Подари авоари"
 *      (giftShopRecipientProfileId) stays available with the correct target
 *      profileId, for both a friend and a stranger.
 *  [8] Clicking "Подари авоари" opens the gift shop addressed to the exact
 *      target profile (not a stale/previous one).
 *  [9] Own profile never gets a gift-to-self action (neither variant).
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

const FRIEND_PROFILE_ID = 'friend-1'
const STRANGER_PROFILE_ID = 'stranger-1'

type ViewerRole = 'player' | 'pika_team' | 'admin'

type H = {
  setViewerRole: (role: ViewerRole) => Promise<void>
  openTargetProfileAndFlush: (profileId: string) => Promise<void>
  openOwnProfileAndFlush: () => Promise<void>
  closePopupAndFlush: () => Promise<void>
  isPopupOpen: () => Promise<boolean>
  hasAcceptedFriendGiftCoinsAction: () => Promise<boolean>
  hasBypassGiftCoinsAction: () => Promise<boolean>
  hasAnyGiftCoinsAction: () => Promise<boolean>
  hasGiftShopAction: () => Promise<boolean>
  getGiftShopRecipientProfileId: () => Promise<string | null>
  clickGiftShopActionAndFlush: () => Promise<void>
  containsText: (text: string) => Promise<boolean>
}

async function harness(page: Page): Promise<H> {
  const w = '__profilePopupGiftCoinsPrivilegeHarness'
  const call = (fn: string, ...args: any[]) =>
    page.evaluate(([k, f, a]: any) => (window as any)[k][f](...a), [w, fn, args] as any)
  return {
    setViewerRole: (role) => call('setViewerRole', role),
    openTargetProfileAndFlush: (profileId) => call('openTargetProfileAndFlush', profileId),
    openOwnProfileAndFlush: () => call('openOwnProfileAndFlush'),
    closePopupAndFlush: () => call('closePopupAndFlush'),
    isPopupOpen: () => call('isPopupOpen'),
    hasAcceptedFriendGiftCoinsAction: () => call('hasAcceptedFriendGiftCoinsAction'),
    hasBypassGiftCoinsAction: () => call('hasBypassGiftCoinsAction'),
    hasAnyGiftCoinsAction: () => call('hasAnyGiftCoinsAction'),
    hasGiftShopAction: () => call('hasGiftShopAction'),
    getGiftShopRecipientProfileId: () => call('getGiftShopRecipientProfileId'),
    clickGiftShopActionAndFlush: () => call('clickGiftShopActionAndFlush'),
    containsText: (text) =>
      page.evaluate((t: string) => document.body.textContent?.includes(t) ?? false, text),
  }
}

console.log('\n═══ checkProfilePopupGiftCoinsPrivilege ═══\n')

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

  await page.goto('/scripts/fixtures/profilePopupGiftCoinsPrivilegeHarness.html')
  const h = await harness(page)

  await h.setViewerRole('player')
  await h.openTargetProfileAndFlush(FRIEND_PROFILE_ID)
  await check('[1] player + accepted friend: "Подари жълтици" е скрит (регресия от бъга)', async () => {
    assert((await h.isPopupOpen()) === true, 'popup не се отвори')
    assert((await h.hasAcceptedFriendGiftCoinsAction()) === false, 'accepted-friend gift-coins бутонът не трябва да е видим за player')
    assert((await h.hasAnyGiftCoinsAction()) === false, 'нито един gift-coins variant не трябва да е видим за player')
  })

  await h.openTargetProfileAndFlush(STRANGER_PROFILE_ID)
  await check('[2] player + non-friend: "Подари жълтици" (bypass variant) е скрит', async () => {
    assert((await h.hasBypassGiftCoinsAction()) === false, 'bypass gift-coins бутонът не трябва да е видим за player')
    assert((await h.hasAnyGiftCoinsAction()) === false, 'нито един gift-coins variant не трябва да е видим за player')
  })

  await h.setViewerRole('pika_team')
  await h.openTargetProfileAndFlush(FRIEND_PROFILE_ID)
  await check('[3] pika_team + accepted friend: "Подари жълтици" (accepted variant) е видим', async () => {
    assert((await h.hasAcceptedFriendGiftCoinsAction()) === true, 'accepted-friend gift-coins бутонът трябва да е видим за pika_team')
  })

  await h.openTargetProfileAndFlush(STRANGER_PROFILE_ID)
  await check('[4] pika_team + non-friend: friendship-bypass "Подари жълтици" остава видим (съществуващо поведение, непроменено)', async () => {
    assert((await h.hasBypassGiftCoinsAction()) === true, 'bypass gift-coins бутонът трябва да е видим за pika_team дори без приятелство')
  })

  await h.setViewerRole('admin')
  await h.openTargetProfileAndFlush(FRIEND_PROFILE_ID)
  await check('[5] admin + accepted friend: "Подари жълтици" (accepted variant) е видим', async () => {
    assert((await h.hasAcceptedFriendGiftCoinsAction()) === true, 'accepted-friend gift-coins бутонът трябва да е видим за admin')
  })

  await h.openTargetProfileAndFlush(STRANGER_PROFILE_ID)
  await check('[6] admin + non-friend: няма gift-coins бутон (не добавяме нов bypass за admin)', async () => {
    assert((await h.hasAnyGiftCoinsAction()) === false, 'admin не трябва да получава bypass gift-coins за non-friend — това поведение не съществуваше преди и не трябва да се добавя сега')
  })

  await h.setViewerRole('player')
  await h.openTargetProfileAndFlush(FRIEND_PROFILE_ID)
  await check('[7a] player + accepted friend: "Подари авоари" е наличен с правилния recipientProfileId', async () => {
    assert((await h.hasGiftShopAction()) === true, '"Подари авоари" трябва да е видим независимо от липсата на gift-coins действие')
    assert((await h.getGiftShopRecipientProfileId()) === FRIEND_PROFILE_ID, 'recipientProfileId трябва да е точно target профила')
  })

  await h.openTargetProfileAndFlush(STRANGER_PROFILE_ID)
  await check('[7b] player + non-friend: "Подари авоари" е наличен с правилния recipientProfileId', async () => {
    assert((await h.hasGiftShopAction()) === true, '"Подари авоари" трябва да е видим и за non-friend')
    assert((await h.getGiftShopRecipientProfileId()) === STRANGER_PROFILE_ID, 'recipientProfileId трябва да е точно target профила')
  })

  await h.openTargetProfileAndFlush(FRIEND_PROFILE_ID)
  await h.clickGiftShopActionAndFlush()
  await check('[8a] Клик "Подари авоари" (Friend One) -> gift shop отваря с правилния recipient', async () => {
    assert((await h.containsText('Подари на Friend One')) === true, 'gift shop header-ът трябва да показва правилния recipient (Friend One)')
  })

  await h.closePopupAndFlush()
  await h.openTargetProfileAndFlush(STRANGER_PROFILE_ID)
  await h.clickGiftShopActionAndFlush()
  await check('[8b] Клик "Подари авоари" (Stranger One) -> gift shop отваря с правилния recipient (не stale от предишния target)', async () => {
    assert((await h.containsText('Подари на Stranger One')) === true, 'gift shop header-ът трябва да показва правилния recipient (Stranger One)')
  })

  await h.closePopupAndFlush()
  await h.openOwnProfileAndFlush()
  await check('[9] Собствен профил: нито "Подари жълтици", нито "Подари авоари"', async () => {
    assert((await h.hasAnyGiftCoinsAction()) === false, 'own profile не трябва да показва gift-coins action')
    assert((await h.hasGiftShopAction()) === false, 'own profile не трябва да показва gift-shop action')
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
