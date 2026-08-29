/**
 * checkDailyMissionsPopup.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * the production bug: "Дневни мисии" opens with a delay, then the modal is
 * visually correct (missions + progress bars) but completely unresponsive —
 * X does not close it, clicking the backdrop does not close it, only a full
 * page refresh escapes it.
 *
 * ROOT CAUSE (identical bug class already fixed once for the Lobby
 * own-profile popup — see lobbyOwnProfilePopupHarness.ts/checkLobbyOwnProfilePopup.ts):
 * the missions modal lives on document.body (outside root.innerHTML, synced
 * via syncMissionsPopup()), but openMissionsPopup()/claimMission()/
 * onMissionsPopupClose all called the generic render(). render() ->
 * renderLobbyScreen() has a skip-if-unchanged guard on the computed root
 * HTML string (introduced in commit 1915e7d, "Fix lobby render churn during
 * tournament wait") — none of missionsPopupOpen/dailyMissions/
 * dailyMissionsLoading/etc. affect that root string. In the common real case
 * (idle lobby, unclaimed mission count unchanged before/after a click), the
 * root string comes out byte-identical between renders, the guard's early
 * return fires, and syncMissionsPopup() (only reachable from inside
 * renderLobbyScreen(), strictly AFTER the guard) never runs:
 *  - opening: the first ("loading") render is silently skipped, so nothing
 *    visibly happens until the eventual post-fetch render — perceived as a
 *    delay with no loading indicator.
 *  - closing: state flips to closed correctly, but the guard skips the
 *    render that would actually remove the popup DOM/backdrop — the
 *    full-viewport (position:fixed;inset:0;z-index:14000) backdrop stays
 *    forever, blocking all further interaction with the page underneath
 *    (looks exactly like the whole UI "froze").
 *
 * FIX: openMissionsPopup()/claimMission()/the onMissionsPopupClose callback
 * now go through a dedicated renderMissionsPopupOnly(), calling
 * syncMissionsPopup() directly — mirroring the already-working
 * renderPopupOnly() pattern used for the profile popup.
 *
 * This test proves, with a real DOM (Playwright) and the real controller, on
 * both a desktop and a mobile viewport:
 *  [A] Clicking "Дневни мисии" opens the modal.
 *  [B] X closes it immediately, AND the page underneath is responsive again
 *      (a click at the missions-card's own screen position reaches the card,
 *      not a leftover backdrop).
 *  [C] Reopening works again without a refresh.
 *  [D] Clicking the backdrop closes it.
 *  [E] Multiple open/close/open/close cycles never leave a duplicated popup
 *      DOM node and never trigger runaway/duplicated data fetches (no
 *      accumulated listeners).
 *  [F] Mission data/progress (titles, exactly one claimable mission per the
 *      fixture's fixed data) stays correct across every open.
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
  getPopupRootCount: () => Promise<number>
  getDailyMissionsLoadCallCount: () => Promise<number>
  getPopupText: () => Promise<string>
  getClaimButtonCount: () => Promise<number>
  getHeroBalanceText: () => Promise<string>
  getRawBalance: () => Promise<number>
  getClaimCallCount: () => Promise<number>
  getClaimRequestedMissionIds: () => Promise<string[]>
  setForceNextClaimToFail: (value: boolean) => Promise<void>
  clickMissionsCardAndFlush: () => Promise<void>
  closeViaXAndFlush: () => Promise<void>
  closeViaBackdropAndFlush: () => Promise<void>
  clickClaimButtonAndFlush: (missionId: string) => Promise<void>
  clickBehindElementIsReachable: () => Promise<boolean>
}

async function harness(page: Page): Promise<H> {
  const w = '__dailyMissionsPopupHarness'
  const call = (fn: string, ...args: any[]) =>
    page.evaluate(([k, f, a]: any) => (window as any)[k][f](...a), [w, fn, args] as any)
  return {
    isPopupOpen: () => call('isPopupOpen'),
    getPopupRootCount: () => call('getPopupRootCount'),
    getDailyMissionsLoadCallCount: () => call('getDailyMissionsLoadCallCount'),
    getPopupText: () => call('getPopupText'),
    getClaimButtonCount: () => call('getClaimButtonCount'),
    getHeroBalanceText: () => call('getHeroBalanceText'),
    getRawBalance: () => call('getRawBalance'),
    getClaimCallCount: () => call('getClaimCallCount'),
    getClaimRequestedMissionIds: () => call('getClaimRequestedMissionIds'),
    setForceNextClaimToFail: (value) => call('setForceNextClaimToFail', value),
    clickMissionsCardAndFlush: () => call('clickMissionsCardAndFlush'),
    closeViaXAndFlush: () => call('closeViaXAndFlush'),
    closeViaBackdropAndFlush: () => call('closeViaBackdropAndFlush'),
    clickClaimButtonAndFlush: (missionId) => call('clickClaimButtonAndFlush', missionId),
    clickBehindElementIsReachable: () => call('clickBehindElementIsReachable'),
  }
}

async function runScenario(page: Page, label: string): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/dailyMissionsPopupHarness.html')
  const h = await harness(page)

  await check(`${label} [sanity] popup starts closed`, async () => {
    assert((await h.isPopupOpen()) === false, 'popup should start closed')
    assert((await h.getPopupRootCount()) === 0, 'no popup DOM should exist before any click')
  })

  await check(`${label} [A] clicking "Дневни мисии" opens the modal`, async () => {
    await h.clickMissionsCardAndFlush()
    assert((await h.isPopupOpen()) === true, 'clicking the missions card did not open the modal')
    assert((await h.getPopupRootCount()) === 1, 'expected exactly one popup root element')
  })

  await check(`${label} [F] mission data/progress is correct on open`, async () => {
    const text = await h.getPopupText()
    assert(text.includes('Изиграй 5 игри'), 'expected first mission title present')
    assert(text.includes('Спечели 3 игри'), 'expected second mission title present')
    assert(text.includes('Обяви 2 терци'), 'expected third mission title present')
    assert(text.includes('5 / 5'), 'expected completed mission progress "5 / 5"')
    assert(text.includes('1 / 3'), 'expected in-progress mission progress "1 / 3"')
    assert((await h.getClaimButtonCount()) === 1, 'expected exactly one claimable (completed, unclaimed) mission button')
  })

  await check(`${label} [B] X closes the modal immediately, THE EXACT REGRESSION`, async () => {
    await h.closeViaXAndFlush()
    assert((await h.isPopupOpen()) === false, 'X did not close the modal — this is the reported production bug')
    assert((await h.getPopupRootCount()) === 0, 'popup DOM must be fully removed after close')
  })

  await check(`${label} [B] the page underneath is responsive again after closing via X`, async () => {
    assert((await h.clickBehindElementIsReachable()) === true, 'a click at the missions-card position is still being intercepted — page looks "frozen"')
  })

  await check(`${label} [C] reopening after a close works without a refresh`, async () => {
    await h.clickMissionsCardAndFlush()
    assert((await h.isPopupOpen()) === true, 'reopening the modal after a close did not work')
  })

  await check(`${label} [D] clicking the backdrop closes the modal`, async () => {
    await h.closeViaBackdropAndFlush()
    assert((await h.isPopupOpen()) === false, 'clicking the backdrop did not close the modal')
    assert((await h.getPopupRootCount()) === 0, 'popup DOM must be fully removed after backdrop close')
  })

  await check(`${label} [E] repeated open/close/open/close cycles never duplicate the popup DOM or leak fetch calls`, async () => {
    const callsBefore = await h.getDailyMissionsLoadCallCount()
    for (let i = 0; i < 4; i++) {
      await h.clickMissionsCardAndFlush()
      assert((await h.isPopupOpen()) === true, `cycle ${i}: open failed`)
      assert((await h.getPopupRootCount()) === 1, `cycle ${i}: expected exactly one popup root, no duplicates`)
      await h.closeViaXAndFlush()
      assert((await h.isPopupOpen()) === false, `cycle ${i}: close failed`)
      assert((await h.getPopupRootCount()) === 0, `cycle ${i}: popup DOM not fully removed`)
    }
    const callsAfter = await h.getDailyMissionsLoadCallCount()
    assert(callsAfter - callsBefore === 4, `expected exactly 4 additional data loads (one per open, no accumulated-listener duplicate fetches), got ${callsAfter - callsBefore}`)
  })

  await check(`${label} [F] mission data is still correct after multiple open/close cycles`, async () => {
    await h.clickMissionsCardAndFlush()
    const text = await h.getPopupText()
    assert(text.includes('Изиграй 5 игри') && text.includes('Спечели 3 игри') && text.includes('Обяви 2 терци'), 'mission titles must still be correct after repeated cycles')
    assert((await h.getClaimButtonCount()) === 1, 'claimable count must still be correct after repeated cycles')
    await h.closeViaXAndFlush()
  })

  await check(`${label} no console/page errors during the whole scenario`, () => {
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
  })
}

/**
 * Follow-up regression check specifically for successful mission claim (see
 * dailyMissionsPopupHarness.ts's "FOLLOW-UP CHECK (b)" comment): does
 * replacing render() with renderMissionsPopupOnly() inside claimMission()
 * leave the root-visible yellow-coins balance / quick-action badge stale?
 * Also covers the error branch (§5 of the task): a failed claim must not
 * corrupt anything, must show an error inside the popup, and the popup must
 * stay fully responsive (close/reopen still work).
 */
async function runClaimScenario(page: Page, label: string): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/dailyMissionsPopupHarness.html')
  const h = await harness(page)

  await check(`${label} [claim-sanity] popup opens, m1 is the sole claimable mission, starting balance is correct`, async () => {
    await h.clickMissionsCardAndFlush()
    assert((await h.isPopupOpen()) === true, 'modal did not open')
    assert((await h.getClaimButtonCount()) === 1, 'expected exactly one claimable mission (m1)')
    assert((await h.getHeroBalanceText()) === '20000', `expected starting hero balance 20000, got ${await h.getHeroBalanceText()}`)
  })

  await check(`${label} [claim-error] a failed claim shows an error, does NOT change balance/mission state, and the popup stays responsive`, async () => {
    await h.setForceNextClaimToFail(true)
    await h.clickClaimButtonAndFlush('m1')
    const text = await h.getPopupText()
    assert(text.includes('тестова грешка'), 'expected the claim error message to be shown inside the popup')
    assert((await h.getClaimButtonCount()) === 1, 'the mission must remain claimable after a failed claim attempt')
    assert((await h.getHeroBalanceText()) === '20000', 'balance must NOT change after a failed claim')
    assert((await h.getClaimCallCount()) === 1, 'expected exactly one claim request to have been sent')
    // Popup must stay fully interactive after an error — close and reopen.
    await h.closeViaXAndFlush()
    assert((await h.isPopupOpen()) === false, 'X must still close the modal after a claim error')
    assert((await h.clickBehindElementIsReachable()) === true, 'page must be responsive again after closing following a claim error')
    await h.clickMissionsCardAndFlush()
    assert((await h.isPopupOpen()) === true, 'modal must reopen normally after a previous claim error')
  })

  await check(`${label} [claim-success] clicking claim sends exactly one request and the reward is reflected in mission state`, async () => {
    const callsBefore = await h.getClaimCallCount()
    await h.clickClaimButtonAndFlush('m1')
    assert((await h.getClaimCallCount()) - callsBefore === 1, 'expected exactly one additional claim request for this click')
    const ids = await h.getClaimRequestedMissionIds()
    assert(ids[ids.length - 1] === 'm1', 'expected the claim request to be for mission m1')
    assert((await h.getClaimButtonCount()) === 0, 'm1 must no longer be claimable (now claimed) — mission UI must reflect the new state')
    const text = await h.getPopupText()
    assert(text.includes('Взето'), 'expected the claimed mission to show its claimed indicator')
  })

  await check(`${label} [claim-success] THE REGRESSION CHECK: the visible lobby balance updates immediately, without any extra manual refresh`, async () => {
    const expectedBalance = String(20000 + 5000)
    assert((await h.getRawBalance()) === 25000, 'sanity: the mocked auth session balance itself must have been credited')
    assert((await h.getHeroBalanceText()) === expectedBalance, `expected the ROOT lobby hero balance to show ${expectedBalance} immediately after claim, got ${await h.getHeroBalanceText()} (stale root = the regression renderMissionsPopupOnly()-only would have caused)`)
  })

  await check(`${label} [claim-success] popup remains responsive after a successful claim: X closes it`, async () => {
    await h.closeViaXAndFlush()
    assert((await h.isPopupOpen()) === false, 'X must close the modal after a successful claim')
    assert((await h.getPopupRootCount()) === 0, 'popup DOM must be fully removed after close following a successful claim')
    assert((await h.clickBehindElementIsReachable()) === true, 'page must be responsive again after closing following a successful claim')
  })

  await check(`${label} [claim-success] reopening after a successful claim works and the balance stays correct`, async () => {
    await h.clickMissionsCardAndFlush()
    assert((await h.isPopupOpen()) === true, 'modal must reopen after a successful claim + close')
    assert((await h.getHeroBalanceText()) === '25000', 'hero balance must remain correct after reopening')
    assert((await h.getClaimButtonCount()) === 0, 'previously-claimed mission must not reappear as claimable')
  })

  await check(`${label} [claim] no duplicated listeners: exactly one claim request was ever sent for m1`, async () => {
    const ids = await h.getClaimRequestedMissionIds()
    const m1Requests = ids.filter((id) => id === 'm1')
    assert(m1Requests.length === 2, `expected exactly 2 total m1 claim requests across the whole scenario (1 forced failure + 1 success), got ${m1Requests.length} — more would indicate duplicated/accumulated click listeners`)
  })

  await check(`${label} no console/page errors during the claim scenario`, () => {
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
  })
}

console.log('\n═══ checkDailyMissionsPopup ═══\n')

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

  const desktopContext = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 800 } })
  const desktopPage = await desktopContext.newPage()
  await runScenario(desktopPage, '[desktop 1280x800]')
  await runClaimScenario(desktopPage, '[desktop 1280x800]')
  await desktopContext.close()

  const mobileContext = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  })
  const mobilePage = await mobileContext.newPage()
  await runScenario(mobilePage, '[mobile 390x844]')
  await runClaimScenario(mobilePage, '[mobile 390x844]')
  await mobileContext.close()
} finally {
  try { await browser?.close() } catch {}
  try { await vite?.close() } catch {}
}

console.log(`\ncheckDailyMissionsPopup: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
