// Desktop shell width consistency — Lobby е каноничният desktop размер.
//
// Реалният createLobbyFlowController + renderLobbyScreen (през Vite, в истински
// Chromium) чрез scripts/fixtures/chatDraftHarness. За всеки desktop изглед,
// достъпен през реалните nav бутони, мери getBoundingClientRect() (visual
// координати) на navbar-а и на outer content shell-а и ги сравнява с Lobby
// при една и съща резолюция. Вътрешният layout на изгледите може да е
// различен — outer shell-ът и navbar-ът НЕ.
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('no port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

type Box = { left: number; right: number; width: number }
type ShellMetrics = {
  view: string
  activeView: string | null
  nav: Box | null
  content: Box | null
  navItems: Box[]
}

// nav бутон -> изглед (реалните data-lobby-nav-* атрибути в renderNav).
const VIEWS = ['lobby', 'chat', 'topics', 'players', 'tournaments', 'leaderboards', 'shop', 'friends', 'games']
const TOLERANCE_PX = 1

async function measure(page: Page, view: string): Promise<ShellMetrics> {
  return page.evaluate((viewName) => {
    const stage = document.querySelector('[data-lobby-scale-stage="1"]')
    const nav = stage?.querySelector('nav') ?? null
    // Outer content shell: Topics има dedicated маркер (nav-ът му е в отделен
    // nav shell); за останалите изгледи това е директният sibling на nav-а.
    const content = document.querySelector('[data-topics-desktop-shell="1"]') ?? nav?.nextElementSibling ?? null
    const active = nav?.querySelector('[data-active]')
    const activeAttr = active ? Array.from(active.attributes).map((a) => a.name).find((n) => n.startsWith('data-lobby-nav-')) ?? null : null
    return {
      view: viewName,
      activeView: activeAttr,
      nav: nav ? (({ left, right, width }) => ({ left, right, width }))(nav.getBoundingClientRect()) : null,
      content: content ? (({ left, right, width }) => ({ left, right, width }))(content.getBoundingClientRect()) : null,
      navItems: nav
        ? Array.from(nav.querySelectorAll('[data-lobby-nav-lobby="1"], [data-lobby-nav-topics="1"], [data-lobby-nav-chat="1"], [data-lobby-nav-players="1"]'))
          .map((el) => (({ left, right, width }) => ({ left, right, width }))(el.getBoundingClientRect()))
        : [],
    }
  }, view)
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE_PX
}

function sameBox(a: Box | null, b: Box | null): boolean {
  return a !== null && b !== null && near(a.left, b.left) && near(a.right, b.right) && near(a.width, b.width)
}

function fmt(box: Box | null): string {
  return box ? `${box.left.toFixed(1)}→${box.right.toFixed(1)} (${box.width.toFixed(1)})` : 'null'
}

console.log('\ncheckDesktopShellWidthConsistency\n')

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
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/chatDraftHarness.html`
  browser = await chromium.launch()

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1920, height: 1200 }]) {
    const label = `[${viewport.width}×${viewport.height}]`
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined, undefined, { timeout: 10_000 })
    await page.evaluate(() => (window as any).__chatDraftHarness.openLobbyChat())
    await page.waitForTimeout(300)

    const results: ShellMetrics[] = []
    for (const view of VIEWS) {
      await page.evaluate((v) => document.querySelector<HTMLElement>(`[data-lobby-nav-${v}="1"]`)?.click(), view)
      await page.waitForTimeout(250)
      const metrics = await measure(page, view)
      results.push(metrics)
      console.log(`  ${label} ${view.padEnd(12)} nav=${fmt(metrics.nav)} content=${fmt(metrics.content)}`)
    }

    const lobby = results[0]!
    await check(`${label} lobby (canonical) has a navbar and a content shell`, () =>
      assert(lobby.nav !== null && lobby.content !== null && lobby.nav.width > 600, 'lobby shell not found'))
    await check(`${label} lobby navbar and content shell share the same horizontal bounds`, () =>
      assert(sameBox(lobby.nav, lobby.content), `nav ${fmt(lobby.nav)} vs content ${fmt(lobby.content)}`))

    for (const metrics of results.slice(1)) {
      await check(`${label} ${metrics.view}: view actually switched (active nav item)`, () =>
        assert(metrics.activeView === `data-lobby-nav-${metrics.view}`, `active nav item is ${metrics.activeView}`))
      await check(`${label} ${metrics.view}: navbar left/right/width == lobby`, () =>
        assert(sameBox(metrics.nav, lobby.nav), `${fmt(metrics.nav)} vs lobby ${fmt(lobby.nav)}`))
      await check(`${label} ${metrics.view}: outer content shell left/right/width == lobby`, () =>
        assert(sameBox(metrics.content, lobby.content), `${fmt(metrics.content)} vs lobby ${fmt(lobby.content)}`))
      await check(`${label} ${metrics.view}: navbar items keep the lobby position and size`, () => {
        assert(metrics.navItems.length === lobby.navItems.length && metrics.navItems.length > 0, 'nav items missing')
        metrics.navItems.forEach((item, index) =>
          assert(sameBox(item, lobby.navItems[index]!), `nav item #${index}: ${fmt(item)} vs lobby ${fmt(lobby.navItems[index]!)}`))
      })
    }
    await check(`${label} no JS errors`, () => assert(errors.length === 0, errors.join(' | ')))
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
