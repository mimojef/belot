/**
 * checkTournamentSoloLeaveRealtimeClient.ts
 *
 * Real browser (Playwright), real production code, real DOM — client
 * realtime regression for "PART 4 — REALTIME" of the solo lifecycle
 * closure: after a solo team member leave (with or without a waiting
 * replacement), EVERY affected already-open client must see the new team
 * composition immediately via the reused tournament_team_updated push — no
 * refresh, no navigation, no polling.
 *
 * The underlying client mechanism (push -> canonical fetchTournamentDetail)
 * is already proven correct in isolation by checkTournamentSoloAutoPairDetailRefresh.ts.
 * This test proves the NEW semantics specific to solo leave: TWO simultaneous
 * recipients (the remaining member AND the promoted waiting solo) both
 * reconcile from the SAME push, and a lone remaining member correctly cycles
 * complete -> forming -> complete across two separate pushes.
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

const W = '__tournamentSoloLeaveRealtimeHarness'

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

console.log('\n═══ checkTournamentSoloLeaveRealtimeClient ═══\n')

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

  await page.goto('/scripts/fixtures/tournamentSoloLeaveRealtimeHarness.html')
  await h(page, 'flush')

  // ── Case A: A+B complete, C waiting, B leaves -> A+C complete. Both A's
  // and C's own already-open screens must reconcile from their own push. ──
  await check('[25] setup: A\'s screen initially shows A+B complete', async () => {
    const text = String(await h(page, 'aClient.getRootText'))
    assert(text.includes('A') && text.includes('B'), 'expected A and B visible')
    assert((await h(page, 'aClient.getDetailLoadCallCount')) === 1, 'expected exactly 1 initial load')
  })
  await check('[26] setup: C\'s screen initially shows C alone, waiting', async () => {
    const text = String(await h(page, 'cClient.getRootText'))
    assert(text.includes('Изчаква партньор'), 'expected C to see the waiting label')
    assert((await h(page, 'cClient.getDetailLoadCallCount')) === 1, 'expected exactly 1 initial load')
  })

  await check('[25] REALTIME: remaining A sees the A+C replacement immediately after B leaves — no reload, no navigation', async () => {
    await h(page, 'aClient.simulatePush', 'tour-solo-leave-1')
    await h(page, 'flush')
    assert((await h(page, 'aClient.getDetailLoadCallCount')) === 2, 'expected exactly one additional refetch triggered by the push')
    const text = String(await h(page, 'aClient.getRootText'))
    assert(text.includes('C'), 'A must now see C as the new teammate')
    assert(text.includes('Готов отбор'), 'A must see the team as ready/complete')
    assert((await h(page, 'aClient.getCurrentScreen')) === 'tournament-detail', 'must still be on the detail screen (no navigation)')
  })

  await check('[26] REALTIME: waiting C sees that it is already in the A+C complete team immediately', async () => {
    await h(page, 'cClient.simulatePush', 'tour-solo-leave-1')
    await h(page, 'flush')
    assert((await h(page, 'cClient.getDetailLoadCallCount')) === 2, 'expected exactly one additional refetch triggered by the push')
    const text = String(await h(page, 'cClient.getRootText'))
    assert(text.includes('A'), 'C must now see A as the teammate')
    assert(!text.includes('Изчаква партньор'), 'the waiting label must be gone for C')
    assert((await h(page, 'cClient.getCurrentScreen')) === 'tournament-detail', 'must still be on the detail screen (no navigation)')
  })

  // ── Case B: A+B complete, B leaves, no C -> A becomes waiting solo, then
  // future D join pushes forming -> complete again. ──
  await check('[27] REALTIME: lone remaining A sees itself demoted to waiting solo immediately (complete -> forming)', async () => {
    assert((await h(page, 'aOnlyClient.getDetailLoadCallCount')) === 1, 'sanity: exactly 1 initial load')
    await h(page, 'aOnlyClient.simulatePush', 'tour-solo-leave-1')
    await h(page, 'flush')
    assert((await h(page, 'aOnlyClient.getDetailLoadCallCount')) === 2, 'expected exactly one additional refetch')
    const text = String(await h(page, 'aOnlyClient.getRootText'))
    assert(text.includes('Изчаква партньор'), 'A must now see itself as the canonical waiting solo')
  })

  await check('[28] REALTIME: a future D join push updates A from forming back to complete', async () => {
    await h(page, 'aOnlyClient.simulatePush', 'tour-solo-leave-1')
    await h(page, 'flush')
    assert((await h(page, 'aOnlyClient.getDetailLoadCallCount')) === 3, 'expected exactly one more additional refetch')
    const text = String(await h(page, 'aOnlyClient.getRootText'))
    assert(text.includes('D'), 'A must now see D as the new teammate')
    assert(text.includes('Готов отбор'), 'A must see the team as ready/complete again')
    assert(!text.includes('Изчаква партньор'), 'the waiting label must be gone')
  })

  await check('[29]/[30] no reload/navigation was ever used across the whole sequence', async () => {
    assert((await h(page, 'aClient.getCurrentScreen')) === 'tournament-detail', 'aClient must still be on detail screen')
    assert((await h(page, 'cClient.getCurrentScreen')) === 'tournament-detail', 'cClient must still be on detail screen')
    assert((await h(page, 'aOnlyClient.getCurrentScreen')) === 'tournament-detail', 'aOnlyClient must still be on detail screen')
  })

  await check('[no page errors]', () => {
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
  })
} finally {
  try { await browser?.close() } catch {}
  try { await vite?.close() } catch {}
}

console.log(`\ncheckTournamentSoloLeaveRealtimeClient: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
