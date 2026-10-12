/**
 * checkCampaignOwnProfileSummary.ts
 *
 * Regression (real createLobbyFlowController in Chromium via Vite): the active
 * campaign card must appear in the viewer's OWN profile popup on the very
 * first open after a page load — with the viewer's own progress — without
 * having to open another profile first. See
 * scripts/fixtures/campaignOwnProfileSummaryHarness.ts for the root cause.
 *
 *  [1] Fresh page -> open own profile: a campaign-summary request is sent for
 *      the OWN profileId and the card shows "Събирай" with 0/2.
 *  [2] Close -> reopen: a fresh request is sent and updated progress (1/2)
 *      is shown.
 *  [3] Other profile (Players directory) shows ITS OWN progress (7/2).
 *  [4] Back to own profile: own progress again, never the other profile's.
 *
 * Usage: npx tsx scripts/checkCampaignOwnProfileSummary.ts
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
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
      if (address === null || typeof address === 'string') return reject(new Error('no free port'))
      srv.close(() => resolve(address.port))
    })
  })
}

function call<T>(page: Page, fn: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([f, a]) => (window as any).__campaignOwnProfileSummaryHarness[f as string](...(a as unknown[])), [fn, args] as const)
}

console.log('\n═══ checkCampaignOwnProfileSummary ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.goto('/scripts/fixtures/campaignOwnProfileSummaryHarness.html')
  await page.waitForFunction(() => (window as any).__campaignOwnProfileSummaryHarness !== undefined, undefined, { timeout: 15_000 })

  await check('[1] Първо отваряне на собствения профил след зареждане -> заявка за собствения profileId и каре "Събирай" 0/2', async () => {
    assert((await call<string[]>(page, 'summaryRequests')).length === 0, 'sanity: no summary request before opening')
    await call(page, 'openOwnProfile')
    assert(await call<boolean>(page, 'isPopupOpen'), 'own profile popup did not open')
    const requests = await call<string[]>(page, 'summaryRequests')
    assert(requests.length === 1 && requests[0] === 'me', `expected exactly one request for "me", got ${JSON.stringify(requests)}`)
    const text = await call<string | null>(page, 'cardText')
    assert(text !== null, 'campaign card missing in own profile popup')
    assert(text.startsWith('Събирай') && text.includes('0/2'), `unexpected card text: ${text}`)
  })

  await check('[2] Затваряне и повторно отваряне -> нова заявка и обновен прогрес 1/2', async () => {
    await call(page, 'closePopup')
    await call(page, 'setUnits', 'me', 1)
    await call(page, 'openOwnProfile')
    const requests = await call<string[]>(page, 'summaryRequests')
    assert(requests.length === 2 && requests[1] === 'me', `expected a fresh request for "me", got ${JSON.stringify(requests)}`)
    const text = await call<string | null>(page, 'cardText')
    assert(text !== null && text.includes('1/2'), `expected updated progress 1/2, got: ${text}`)
    await call(page, 'closePopup')
  })

  await check('[3] Чужд профил (от "Играчи") показва собствения си прогрес 7/2', async () => {
    assert(await call<boolean>(page, 'openOtherProfileFromPlayers'), 'other player card not found in Players directory')
    const requests = await call<string[]>(page, 'summaryRequests')
    assert(requests[requests.length - 1] === 'other-player', `expected a request for the other profile, got ${JSON.stringify(requests)}`)
    const text = await call<string | null>(page, 'cardText')
    assert(text !== null && text.includes('7/2'), `expected other profile progress 7/2, got: ${text}`)
    await call(page, 'closePopup')
  })

  await check('[4] Обратно към собствения профил -> собственият прогрес (1/2), никога чуждият', async () => {
    await call(page, 'goToLobby')
    await call(page, 'openOwnProfile')
    assert(await call<boolean>(page, 'isPopupOpen'), 'own profile popup did not open from the Lobby')
    const requests = await call<string[]>(page, 'summaryRequests')
    assert(requests[requests.length - 1] === 'me', `expected a request for "me", got ${JSON.stringify(requests)}`)
    const text = await call<string | null>(page, 'cardText')
    assert(text !== null && text.includes('1/2') && !text.includes('7/2'), `expected own progress 1/2, got: ${text}`)
  })

  await check('Няма JS грешки', () => {
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
  })

  await context.close()
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
