/**
 * checkTournamentScheduledStartEditClient.ts
 *
 * Real browser (Playwright), real production code, real DOM — client-behavior
 * regression for "EDIT SCHEDULED START" (§11-§15, §17 in the task spec):
 * button visibility (creator-only), the canonical detail refetch after save,
 * the "Старт" card reflecting the new time, a 320px mobile layout that never
 * overflows, and realtime propagation to a SECOND already-open client via the
 * tournament_schedule_updated push — mirroring the pattern already proven for
 * solo auto-pair (checkTournamentSoloAutoPairDetailRefresh.ts).
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

const W = '__tournamentScheduledStartEditHarness'

async function h(page: Page, path: string, ...args: unknown[]): Promise<any> {
  return page.evaluate(
    ([w, p, a]: any) => {
      const parts = p.split('.')
      let target: any = (window as any)[w]
      for (const part of parts) target = target[part]
      return typeof target === 'function' ? target(...a) : target
    },
    [W, path, args] as any,
  )
}

console.log('\n═══ checkTournamentScheduledStartEditClient ═══\n')

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

  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 480, height: 900 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/tournamentScheduledStartEditHarness.html')
  await h(page, 'flush')

  // ── §11/§12: button visibility ──
  await check('[11] creator sees the "Редактирай старт" button', async () => {
    assert((await h(page, 'creator.hasEditButton')) === true, 'expected the edit button for the creator')
  })
  await check('[12] non-creator does NOT see the "Редактирай старт" button', async () => {
    assert((await h(page, 'nonCreator.hasEditButton')) === false, 'non-creator must never see the edit button')
    const text = await h(page, 'nonCreator.getRootText')
    assert(!String(text).includes('Редактирай старт'), 'button text must not appear anywhere for a non-creator')
  })

  // ── initial state sanity ──
  await check('[setup] creator screen initially shows the ORIGINAL scheduled time', async () => {
    assert((await h(page, 'creator.getDetailLoadCallCount')) === 1, 'expected exactly 1 initial detail load')
  })

  // ── §13/§14: open popup, prefilled with current value, edit, save -> canonical refetch + updated Старт ──
  await check('[popup] opening pre-fills date/time from the current scheduledStartAt (22:00 local split)', async () => {
    await h(page, 'creator.clickEditOpen')
    await h(page, 'flush')
    const dateValue = await h(page, 'creator.getDateInputValue')
    const timeValue = await h(page, 'creator.getTimeInputValue')
    assert(typeof dateValue === 'string' && dateValue.length > 0, 'date input should be pre-filled')
    assert(typeof timeValue === 'string' && timeValue.length > 0, 'time input should be pre-filled')
  })

  await check('[13] saving a new time calls the narrow schedule-update mutation exactly once', async () => {
    await h(page, 'creator.setDateInput', '2026-08-30')
    await h(page, 'creator.setTimeInput', '21:00')
    await h(page, 'creator.clickSubmit')
    await h(page, 'flush')
    assert((await h(page, 'creator.getScheduleUpdateCallCount')) === 1, 'expected exactly 1 schedule-update call')
  })

  await check('[13b] BLOCKER: save triggers the canonical fetchTournamentDetail refetch (not just a local merge)', async () => {
    assert((await h(page, 'creator.getDetailLoadCallCount')) === 2, `expected exactly one additional detail refetch after save, got ${await h(page, 'creator.getDetailLoadCallCount')} total loads`)
  })

  await check('[14] the "Старт" card and confirmation text reflect the new time, popup is closed, no navigation', async () => {
    const text = String(await h(page, 'creator.getRootText'))
    assert(text.includes('Началният час на турнира е променен.'), 'expected the success confirmation text')
    assert((await h(page, 'creator.getCurrentScreen')) === 'tournament-detail', 'must still be on the tournament-detail screen (no navigation)')
  })

  // ── UI lifecycle bug regression: transient success notice must survive the
  // canonical refetch (already proven above) but must NOT survive navigation
  // away from the tournament detail screen. ──
  await check('[lifecycle-1] success notice is still visible right after the canonical post-save refetch', async () => {
    assert((await h(page, 'creator.hasSuccessNotice')) === true, 'expected the success notice to still be visible immediately after Save + refetch')
  })

  await check('[lifecycle-2] navigating away to the tournaments list, then back into the SAME tournament, clears the stale notice', async () => {
    await h(page, 'creator.clickBackToTournamentsList')
    await h(page, 'flush')
    assert((await h(page, 'creator.getCurrentScreen')) === 'tournaments', 'expected the back button to actually leave the detail screen')

    await h(page, 'creator.reNavigateToDetail')
    await h(page, 'flush')
    assert((await h(page, 'creator.getCurrentScreen')) === 'tournament-detail', 'expected to be back on the tournament detail screen')
    assert((await h(page, 'creator.hasSuccessNotice')) === false, 'BLOCKER: the stale success notice from the PREVIOUS visit must not reappear on re-entry')
  })

  await check('[lifecycle-3] a NEW successful edit after re-entry can show the notice again (not permanently suppressed)', async () => {
    await h(page, 'creator.clickEditOpen')
    await h(page, 'flush')
    await h(page, 'creator.setDateInput', '2026-08-30')
    await h(page, 'creator.setTimeInput', '20:00')
    await h(page, 'creator.clickSubmit')
    await h(page, 'flush')
    assert((await h(page, 'creator.getScheduleUpdateCallCount')) === 2, 'expected a second schedule-update call to have gone through')
    assert((await h(page, 'creator.hasSuccessNotice')) === true, 'a fresh successful edit must show the notice again — the fix must be a per-visit clear, not a permanent suppression')
  })

  // ── §17: a SECOND already-open client (never clicked anything) sees the
  // update live via the tournament_schedule_updated push ──
  await check('[setup] other open viewer starts on the ORIGINAL time, has not refetched yet', async () => {
    assert((await h(page, 'otherViewer.getDetailLoadCallCount')) === 1, 'expected exactly 1 initial detail load for the other viewer')
  })
  await check('[17] REALTIME: a push for a DIFFERENT tournament is a no-op (no false refetch)', async () => {
    await h(page, 'otherViewer.simulateScheduleUpdatedPush', 'some-other-tournament-id', '2026-08-30T21:00:00.000Z')
    await h(page, 'flush')
    assert((await h(page, 'otherViewer.getDetailLoadCallCount')) === 1, 'a push for a different tournamentId must not trigger a refetch')
  })
  await check('[17b] REALTIME: the real tournament_schedule_updated push makes the other open client refetch and show the new time — no click, no reload', async () => {
    await h(page, 'otherViewer.simulateScheduleUpdatedPush', 'tour-schedule-edit-1', '2026-08-30T21:00:00.000Z')
    await h(page, 'flush')
    assert((await h(page, 'otherViewer.getDetailLoadCallCount')) === 2, `expected exactly one additional detail refetch triggered by the push, got ${await h(page, 'otherViewer.getDetailLoadCallCount')} total loads`)
    assert((await h(page, 'otherViewer.getCurrentScreen')) === 'tournament-detail', 'must still be on the tournament-detail screen (no navigation)')
  })

  await check('[no page errors]', () => {
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
  })

  // ── §15: 320px mobile viewport never overflows horizontally ──
  const mobileContext = await browser.newContext({ baseURL: baseUrl, viewport: { width: 320, height: 720 } })
  const mobilePage = await mobileContext.newPage()
  const mobileErrors: string[] = []
  mobilePage.on('pageerror', (err) => mobileErrors.push(err.message))
  await mobilePage.goto('/scripts/fixtures/tournamentScheduledStartEditHarness.html')
  await mobilePage.evaluate((k: any) => (window as any)[k].flush(), W)

  await check('[15] 320px viewport: creator row (with the edit button) never causes horizontal page overflow', async () => {
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert(overflow <= 1, `page overflows horizontally by ${overflow}px at 320px width`)
  })
  await check('[15b] 320px viewport: opening the edit popup itself never causes horizontal overflow', async () => {
    await mobilePage.evaluate((k: any) => (window as any)[k].creator.clickEditOpen(), W)
    await mobilePage.evaluate((k: any) => (window as any)[k].flush(), W)
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert(overflow <= 1, `popup overflows horizontally by ${overflow}px at 320px width`)
  })
  await check('[15c] no page errors on the 320px viewport pass', () => {
    assert(mobileErrors.length === 0, `page errors: ${mobileErrors.join('; ')}`)
  })
  await mobileContext.close()
} finally {
  try { await browser?.close() } catch {}
  try { await vite?.close() } catch {}
}

console.log(`\ncheckTournamentScheduledStartEditClient: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
