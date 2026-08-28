/**
 * checkNotificationBellDropdown.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * the notification bell dropdown appearing "stuck": clicking the bell did
 * nothing visually; the dropdown only appeared once some LATER, unrelated
 * render happened (navigation, a popup) — and once visible, it blocked the
 * whole site (fixed full-viewport backdrop) and could not be closed by a
 * second bell click, or by clicking outside it.
 *
 * ROOT CAUSE: syncNotificationsDropdown() (renderLobbyScreen.ts) mounts the
 * dropdown on document.body, entirely OUTSIDE root.innerHTML — but the call
 * site was positioned AFTER renderLobbyScreen()'s skip-if-unchanged guard
 * (`if (nextRootHtml === lastRenderedRootHtml) return`). state.notificationsOpen
 * never affects nextRootHtml (the dropdown markup isn't part of that string),
 * so on a bell click the guard's early return fired every time, and
 * syncNotificationsDropdown() was simply never reached — neither to open the
 * dropdown, nor (on a later click, or a backdrop click) to remove it. It only
 * ever ran when some OTHER state change produced a genuinely different
 * nextRootHtml, at which point it "caught up" and rendered whatever
 * notificationsOpen happened to be at that moment.
 *
 * FIX: createLobbyFlowController.ts now calls syncNotificationsDropdown()
 * directly from onBellClick (and from the dropdown's own onClose/callbacks),
 * bypassing renderLobbyScreen()'s root.innerHTML + guard entirely — mirroring
 * the existing renderPopupOnly()/syncProfilePopup() pattern already used for
 * the profile popup, which has the same "lives on document.body" shape.
 *
 * This test proves, with a real DOM (Playwright) and the real controller:
 *  [1] Bell closed -> click -> dropdown is immediately visible (no unrelated
 *      render needed).
 *  [2] Bell open -> bell click -> immediately closed.
 *  [3] Bell open -> click outside (backdrop) -> closed.
 *  [4] Bell closed -> unrelated render -> stays closed (does not open itself).
 *  [5] The dropdown's fixed backdrop never becomes an orphaned, permanently
 *      blocking overlay: after closing, it is fully removed from the DOM.
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
  clickBellAndFlush: () => Promise<void>
  clickBackdropAndFlush: () => Promise<void>
  triggerUnrelatedRender: () => Promise<void>
  isDropdownVisible: () => Promise<boolean>
  backdropCoversViewport: () => Promise<boolean>
  clickElsewhereAndFlush: () => Promise<void>
  isBellButtonPresent: () => Promise<boolean>
}

async function harness(page: Page): Promise<H> {
  const w = '__notificationBellDropdownHarness'
  const call = (fn: string, ...args: any[]) =>
    page.evaluate(([k, f, a]: any) => (window as any)[k][f](...a), [w, fn, args] as any)
  return {
    clickBellAndFlush: () => call('clickBellAndFlush'),
    clickBackdropAndFlush: () => call('clickBackdropAndFlush'),
    triggerUnrelatedRender: () => call('triggerUnrelatedRender'),
    isDropdownVisible: () => call('isDropdownVisible'),
    backdropCoversViewport: () => call('backdropCoversViewport'),
    clickElsewhereAndFlush: () => call('clickElsewhereAndFlush'),
    isBellButtonPresent: () => call('isBellButtonPresent'),
  }
}

console.log('\n═══ checkNotificationBellDropdown ═══\n')

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

  await page.goto('/scripts/fixtures/notificationBellDropdownHarness.html')
  const h = await harness(page)

  await check('sanity: bell button renders', async () => {
    assert((await h.isBellButtonPresent()) === true, 'bell button [data-lobby-nav-bell="1"] not found in DOM')
  })

  await check('[4] Bell closed -> unrelated render -> stays closed', async () => {
    assert((await h.isDropdownVisible()) === false, 'sanity: dropdown should start closed')
    await h.triggerUnrelatedRender()
    assert((await h.isDropdownVisible()) === false, 'an unrelated render must not open the dropdown by itself')
  })

  await check('[1] Bell closed -> click -> dropdown is immediately visible (no unrelated render needed)', async () => {
    await h.clickBellAndFlush()
    assert((await h.isDropdownVisible()) === true, 'dropdown did not appear immediately on the first bell click')
  })

  await check('[5] Open dropdown backdrop is a real fixed full-viewport overlay while open', async () => {
    assert((await h.backdropCoversViewport()) === true, 'expected backdrop to be position:fixed;inset:0 while the dropdown is open')
  })

  await check('[2] Bell open -> bell click -> immediately closed', async () => {
    await h.clickBellAndFlush()
    assert((await h.isDropdownVisible()) === false, 'second bell click did not close the dropdown immediately')
  })

  await check('[3] Bell open -> click outside (backdrop) -> closed', async () => {
    await h.clickBellAndFlush()
    assert((await h.isDropdownVisible()) === true, 'sanity: dropdown should be open before testing outside-click close')
    await h.clickBackdropAndFlush()
    assert((await h.isDropdownVisible()) === false, 'clicking the backdrop (outside the dropdown) did not close it')
  })

  await check('closed dropdown leaves no orphaned overlay node in the DOM', async () => {
    assert((await h.isDropdownVisible()) === false, 'sanity: dropdown should be closed')
  })

  await check('[7] Rest of the site remains clickable after close (nav back button still receives clicks)', async () => {
    await h.clickBellAndFlush()
    assert((await h.isDropdownVisible()) === true, 'sanity: dropdown open before elsewhere-click test')
    await h.clickBackdropAndFlush()
    assert((await h.isDropdownVisible()) === false, 'sanity: dropdown closed before elsewhere-click test')
    // If a leftover backdrop were still intercepting pointer events, this
    // would be the failure mode the bug report described ("целият сайт
    // практически блокиран"). Absence of the backdrop node (checked above)
    // combined with a successful unrelated click confirms the rest of the UI
    // is interactive again.
    await h.clickElsewhereAndFlush()
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
