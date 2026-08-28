/**
 * checkInitialNavUrlSync.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * the SPA URL never following normal in-app navigation after loading a page
 * directly (e.g. http://host/chat), because a stuck internal flag disabled
 * URL sync for the rest of the session. Symptom: navigate Chat -> Лоби, the
 * UI switches correctly, but window.location.pathname stays "/chat" forever
 * — a refresh then re-opens Chat because the app reads the stale URL.
 *
 * ROOT CAUSE: createLobbyFlowController's navigateInitialPath() sets
 * _pendingInitialNav = true when it runs before state.isConnected is true
 * (the normal WS-handshake race on a fresh load) — deferring the initial
 * route resolution until the 'connected' server message arrives. Only
 * handleServerMessage('connected') resets _pendingInitialNav back to false
 * and resolves the deferred navigateFromPath(_loadPath). But src/main.ts's
 * WS onMessage dispatcher intercepted 'connected' entirely for its own PWA
 * bootstrap bookkeeping (added in commit d6cb87b, "Auto-apply PWA updates
 * when safe", 2026-07-14 — unrelated to the tournament integration) and
 * never forwarded the message to lobby.handleServerMessage. syncUrlPath()
 * (called at the end of every render()) early-returns while
 * _pendingInitialNav is true — so it stayed permanently disabled for the
 * rest of the page's life. render() itself was never affected, which is why
 * the DOM always updated correctly while the URL silently stopped following it.
 *
 * FIX: src/main.ts now forwards the 'connected' message to
 * lobby.handleServerMessage(message) before running its own PWA bootstrap
 * logic, restoring the reset of _pendingInitialNav (extracted into an
 * exported handleConnectedServerMessage() function at true module
 * top-level, for clarity — not imported here, since main.ts executes a
 * full app bootstrap — real WS connect, DOM mutation — as a module
 * side-effect on import, which is unsuitable for a fast unit-style check).
 *
 * This test proves, with a real DOM (Playwright) and the real controller
 * (createLobbyFlowController — the same URL-sync/navigation code main.ts
 * drives in production), reproducing main.ts's exact bootstrap order
 * (navigateInitialPath() called before the WS handshake resolves, then the
 * 'connected' message arriving):
 *  [1] Loading /chat directly and resolving the deferred initial nav opens
 *      Chat (sanity — proves the race is genuinely reproduced).
 *  [2] /chat -> click Лоби: URL updates to /lobby immediately (the bug: it
 *      used to stay stuck at /chat forever after this point).
 *  [3] Лоби -> click Играчи (Players): URL updates to /players — proves the
 *      fix isn't a one-shot unstick, sync keeps working for every subsequent
 *      navigation for the rest of the session.
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
  runInitialNavBeforeConnected: () => Promise<void>
  simulateSetConnectedTrue: () => Promise<void>
  simulateConnectedServerMessage: () => Promise<void>
  getCurrentScreen: () => Promise<string>
  getPathname: () => Promise<string>
  clickLobbyNavButton: () => Promise<void>
  clickPlayersNavButton: () => Promise<void>
  clickChatNavButton: () => Promise<void>
  clickTopicsNavButton: () => Promise<void>
  clickShopNavButton: () => Promise<void>
  clickTournamentsNavButton: () => Promise<void>
  goBack: () => Promise<void>
  goForward: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__initialNavUrlSyncHarness'
  const call = (fn: string, ...args: any[]) =>
    page.evaluate(([k, f, a]: any) => (window as any)[k][f](...a), [w, fn, args] as any)
  return {
    runInitialNavBeforeConnected: () => call('runInitialNavBeforeConnected'),
    simulateSetConnectedTrue: () => call('simulateSetConnectedTrue'),
    simulateConnectedServerMessage: () => call('simulateConnectedServerMessage'),
    getCurrentScreen: () => call('getCurrentScreen'),
    getPathname: () => call('getPathname'),
    clickLobbyNavButton: () => call('clickLobbyNavButton'),
    clickPlayersNavButton: () => call('clickPlayersNavButton'),
    clickChatNavButton: () => call('clickChatNavButton'),
    clickTopicsNavButton: () => call('clickTopicsNavButton'),
    clickShopNavButton: () => call('clickShopNavButton'),
    clickTournamentsNavButton: () => call('clickTournamentsNavButton'),
    goBack: () => call('goBack'),
    goForward: () => call('goForward'),
  }
}

console.log('\n═══ checkInitialNavUrlSync ═══\n')

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

  await page.goto('/scripts/fixtures/initialNavUrlSyncHarness.html')
  const h = await harness(page)

  // Reproduce main.ts's exact bootstrap race: navigateInitialPath() runs
  // BEFORE the WS handshake resolves (state.isConnected still false), then
  // setConnected(true) fires (real onOpen path), then the server's
  // 'connected' message arrives separately (real onMessage path) — this is
  // the sequence that used to leave _pendingInitialNav stuck at true.
  await h.runInitialNavBeforeConnected()
  await h.simulateSetConnectedTrue()
  await h.simulateConnectedServerMessage()

  await check('[1] Deferred initial nav for /chat resolves to the Chat screen once "connected" arrives', async () => {
    assert((await h.getCurrentScreen()) === 'chat', `expected initial screen 'chat', got ${await h.getCurrentScreen()}`)
  })

  await check('[2] /chat -> click Лоби: URL updates to /lobby immediately (previously stayed stuck at /chat forever)', async () => {
    await h.clickLobbyNavButton()
    assert((await h.getCurrentScreen()) === 'lobby', `expected screen 'lobby' after clicking Лоби, got ${await h.getCurrentScreen()}`)
    assert((await h.getPathname()) === '/lobby', `expected URL to update to /lobby, got ${await h.getPathname()}`)
  })

  await check('[3] Лоби -> click Играчи: URL keeps following navigation for the rest of the session', async () => {
    await h.clickPlayersNavButton()
    assert((await h.getCurrentScreen()) === 'players', `expected screen 'players' after clicking Играчи, got ${await h.getCurrentScreen()}`)
    assert((await h.getPathname()) === '/players', `expected URL to update to /players, got ${await h.getPathname()}`)
  })

  // Full acceptance chain requested for this bug — not /chat-specific, the
  // fix must make EVERY subsequent navigation update the URL, regardless of
  // which route the page originally loaded on.
  await check('[4] Играчи -> Лоби -> Chat -> URL follows to /chat', async () => {
    await h.clickLobbyNavButton()
    assert((await h.getPathname()) === '/lobby', `expected /lobby, got ${await h.getPathname()}`)
    await h.clickChatNavButton()
    assert((await h.getCurrentScreen()) === 'chat', `expected screen 'chat', got ${await h.getCurrentScreen()}`)
    assert((await h.getPathname()) === '/chat', `expected URL to update to /chat, got ${await h.getPathname()}`)
  })

  await check('[5] Chat -> Topics: URL follows to /topics', async () => {
    await h.clickTopicsNavButton()
    assert((await h.getCurrentScreen()) === 'topics', `expected screen 'topics', got ${await h.getCurrentScreen()}`)
    assert((await h.getPathname()) === '/topics', `expected URL to update to /topics, got ${await h.getPathname()}`)
  })

  await check('[6] Topics -> Shop: URL follows to /shop', async () => {
    await h.clickShopNavButton()
    assert((await h.getCurrentScreen()) === 'shop', `expected screen 'shop', got ${await h.getCurrentScreen()}`)
    assert((await h.getPathname()) === '/shop', `expected URL to update to /shop, got ${await h.getPathname()}`)
  })

  await check('[7] Shop -> Players: URL follows to /players', async () => {
    await h.clickPlayersNavButton()
    assert((await h.getCurrentScreen()) === 'players', `expected screen 'players', got ${await h.getCurrentScreen()}`)
    assert((await h.getPathname()) === '/players', `expected URL to update to /players, got ${await h.getPathname()}`)
  })

  await check('[8] Players -> Лоби: URL follows back to /lobby', async () => {
    await h.clickLobbyNavButton()
    assert((await h.getCurrentScreen()) === 'lobby', `expected screen 'lobby', got ${await h.getCurrentScreen()}`)
    assert((await h.getPathname()) === '/lobby', `expected URL to update to /lobby, got ${await h.getPathname()}`)
  })

  await check('[9] Лоби -> Tournaments: URL follows to /tournaments', async () => {
    await h.clickTournamentsNavButton()
    assert((await h.getCurrentScreen()) === 'tournaments', `expected screen 'tournaments', got ${await h.getCurrentScreen()}`)
    assert((await h.getPathname()) === '/tournaments', `expected URL to update to /tournaments, got ${await h.getPathname()}`)
  })

  await check('[10] Browser Back/Forward: back returns to the previous URL (/lobby), forward returns to /tournaments', async () => {
    // The immediately preceding real history entry (step [9] pushed /lobby
    // -> /tournaments) is /lobby, not /players — every intermediate
    // navigation in [4]-[9] is its own history entry.
    await h.goBack()
    assert((await h.getPathname()) === '/lobby', `expected back() to land on /lobby, got ${await h.getPathname()}`)
    assert((await h.getCurrentScreen()) === 'lobby', `expected screen 'lobby' after back(), got ${await h.getCurrentScreen()}`)
    await h.goForward()
    assert((await h.getPathname()) === '/tournaments', `expected forward() to return to /tournaments, got ${await h.getPathname()}`)
    assert((await h.getCurrentScreen()) === 'tournaments', `expected screen 'tournaments' after forward(), got ${await h.getCurrentScreen()}`)
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
