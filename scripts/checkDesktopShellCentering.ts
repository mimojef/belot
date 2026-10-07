// Desktop shell centering — един и същ хоризонтален център за всички изгледи.
//
// Реалният createLobbyFlowController + renderLobbyScreen (през Vite) чрез
// scripts/fixtures/chatDraftHarness, в Chromium БЕЗ default-ния headless флаг
// --hide-scrollbars — т.е. с реални (класически) scrollbar-и, каквито има
// desktop Windows Chrome. Без това scrollbar-ът е 0px и проблемът (shift с
// половината scrollbar при изгледи с/без vertical overflow) не се вижда.
//
// Invariant: navbar.centerX и outer content shell centerX са ТОЧНО центърът на
// viewport-а (|centerX - innerWidth/2| <= 0.75px) във всички desktop изгледи,
// независимо дали текущият изглед има vertical overflow на общия scroll owner
// ([data-lobby-screen-root], scrollbar-gutter: stable both-edges). Еднакъв, но
// изместен спрямо viewport-а център е FAIL. Без horizontal overflow, вкл.
// около desktop scale breakpoint-ите.
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

type Box = { left: number; right: number; width: number; centerX: number }
type Metrics = {
  nav: Box | null
  content: Box | null
  viewportCenter: number
  rootScrollbarWidth: number
  rootHasOverflow: boolean
  rootOverflowY: string
  rootScrollbarGutter: string
  horizontalOverflow: number
  scale: string
}

const VIEWS = ['lobby', 'chat', 'topics', 'players', 'tournaments', 'leaderboards', 'shop', 'friends', 'games']
const CENTER_TOLERANCE_PX = 0.75
const WIDTH_TOLERANCE_PX = 1

async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!
    const stage = document.querySelector('[data-lobby-scale-stage="1"]')
    const nav = stage?.querySelector('nav') ?? null
    const content = document.querySelector('[data-topics-desktop-shell="1"]') ?? nav?.nextElementSibling ?? null
    const navRect = nav?.getBoundingClientRect() ?? null
    const contentRect = content?.getBoundingClientRect() ?? null
    const styles = getComputedStyle(root)
    return {
      nav: navRect ? { left: navRect.left, right: navRect.right, width: navRect.width, centerX: (navRect.left + navRect.right) / 2 } : null,
      content: contentRect ? { left: contentRect.left, right: contentRect.right, width: contentRect.width, centerX: (contentRect.left + contentRect.right) / 2 } : null,
      viewportCenter: window.innerWidth / 2,
      rootScrollbarWidth: root.offsetWidth - root.clientWidth,
      rootHasOverflow: root.scrollHeight > root.clientHeight,
      rootOverflowY: styles.overflowY,
      rootScrollbarGutter: styles.scrollbarGutter,
      horizontalOverflow: root.scrollWidth - root.clientWidth,
      scale: styles.getPropertyValue('--lobby-scale').trim(),
    }
  })
}

async function openView(page: Page, view: string): Promise<void> {
  await page.evaluate((v) => document.querySelector<HTMLElement>(`[data-lobby-nav-${v}="1"]`)?.click(), view)
  await page.waitForTimeout(250)
}

async function openHarness(browser: Browser, baseUrl: string, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(baseUrl)
  await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined, undefined, { timeout: 10_000 })
  await page.evaluate(() => (window as any).__chatDraftHarness.openLobbyChat())
  await page.waitForTimeout(300)
  return { context, page, errors }
}

function fmt(box: Box | null): string {
  return box ? `${box.left.toFixed(1)}→${box.right.toFixed(1)} w=${box.width.toFixed(1)} cx=${box.centerX.toFixed(2)}` : 'null'
}

console.log('\ncheckDesktopShellCentering\n')

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
  browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })

  // ─── 1) Всички изгледи при нормалните desktop размери + ниски размери,
  //        при които част от изгледите имат vertical overflow, а Topics не.
  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 1920, height: 1200 },
    { width: 1366, height: 420 },
    { width: 1920, height: 600 },
  ]) {
    const label = `[${viewport.width}×${viewport.height}]`
    const { context, page, errors } = await openHarness(browser, baseUrl, viewport)
    const results: Array<{ view: string; metrics: Metrics }> = []
    for (const view of VIEWS) {
      await openView(page, view)
      const metrics = await measure(page)
      results.push({ view, metrics })
      console.log(`  ${label} ${view.padEnd(12)} overflow=${metrics.rootHasOverflow ? 'yes' : 'no '} gutter=${metrics.rootScrollbarWidth}px nav ${fmt(metrics.nav)} | content ${fmt(metrics.content)} | viewportCenter=${metrics.viewportCenter} delta=${(metrics.nav!.centerX - metrics.viewportCenter).toFixed(2)}`)
    }
    const lobby = results[0]!.metrics

    await check(`${label} real scrollbars are enabled (gutter > 0) so the check is meaningful`, () =>
      assert(results.every((r) => r.metrics.rootScrollbarWidth > 0), `gutters: ${results.map((r) => r.metrics.rootScrollbarWidth).join(',')}`))
    await check(`${label} shared desktop scroll owner reserves a stable scrollbar gutter in every view`, () =>
      assert(results.every((r) => r.metrics.rootScrollbarGutter === 'stable both-edges'), results.map((r) => `${r.view}:${r.metrics.rootScrollbarGutter}`).join(', ')))
    await check(`${label} no horizontal overflow in any view`, () =>
      assert(results.every((r) => r.metrics.horizontalOverflow <= 0), results.map((r) => `${r.view}:${r.metrics.horizontalOverflow}`).join(', ')))
    for (const { view, metrics } of results) {
      await check(`${label} ${view}: navbar AND content centerX == viewport center (${metrics.viewportCenter}) ±${CENTER_TOLERANCE_PX}px`, () => {
        const navDelta = metrics.nav!.centerX - metrics.viewportCenter
        const contentDelta = metrics.content!.centerX - metrics.viewportCenter
        assert(Math.abs(navDelta) <= CENTER_TOLERANCE_PX, `nav centerX ${metrics.nav!.centerX.toFixed(2)} delta ${navDelta.toFixed(2)}`)
        assert(Math.abs(contentDelta) <= CENTER_TOLERANCE_PX, `content centerX ${metrics.content!.centerX.toFixed(2)} delta ${contentDelta.toFixed(2)}`)
      })
    }
    for (const { view, metrics } of results.slice(1)) {
      await check(`${label} ${view}: navbar centerX == lobby (${lobby.nav!.centerX.toFixed(2)})`, () =>
        assert(Math.abs(metrics.nav!.centerX - lobby.nav!.centerX) <= CENTER_TOLERANCE_PX, `${metrics.nav!.centerX} vs ${lobby.nav!.centerX}`))
      await check(`${label} ${view}: content shell centerX == lobby (${lobby.content!.centerX.toFixed(2)})`, () =>
        assert(Math.abs(metrics.content!.centerX - lobby.content!.centerX) <= CENTER_TOLERANCE_PX, `${metrics.content!.centerX} vs ${lobby.content!.centerX}`))
      await check(`${label} ${view}: navbar/content widths still == lobby`, () => {
        assert(Math.abs(metrics.nav!.width - lobby.nav!.width) <= WIDTH_TOLERANCE_PX, `nav ${metrics.nav!.width} vs ${lobby.nav!.width}`)
        assert(Math.abs(metrics.content!.width - lobby.content!.width) <= WIDTH_TOLERANCE_PX, `content ${metrics.content!.width} vs ${lobby.content!.width}`)
      })
    }
    const withOverflow = results.filter((r) => r.metrics.rootHasOverflow).map((r) => r.view)
    const withoutOverflow = results.filter((r) => !r.metrics.rootHasOverflow).map((r) => r.view)
    console.log(`  ${label} views with root overflow: [${withOverflow.join(', ')}]; without: [${withoutOverflow.join(', ')}]`)
    await check(`${label} no JS errors`, () => assert(errors.length === 0, errors.join(' | ')))
    await context.close()
  }

  // ─── 2) Навигация Lobby → Topics → Chat → Players → Lobby без хоризонтален shift.
  //        1920×600: Lobby/Chat/Players имат overflow, Topics (overflow:hidden) — не.
  {
    const { context, page } = await openHarness(browser, baseUrl, { width: 1920, height: 600 })
    const sequence = ['lobby', 'topics', 'chat', 'players', 'lobby']
    const centers: Array<{ view: string; nav: number; content: number; overflow: boolean }> = []
    for (const view of sequence) {
      await openView(page, view)
      const metrics = await measure(page)
      centers.push({ view, nav: metrics.nav!.centerX, content: metrics.content!.centerX, overflow: metrics.rootHasOverflow })
    }
    console.log(`  [1920×600 navigation] ${centers.map((c) => `${c.view}(overflow=${c.overflow ? 'yes' : 'no'}) cx=${c.nav.toFixed(2)}`).join(' → ')}`)
    await check('[1920×600] Lobby → Topics → Chat → Players → Lobby: no horizontal shift (mixed overflow / no overflow)', () => {
      assert(centers.some((c) => c.overflow) && centers.some((c) => !c.overflow), 'sequence must mix views with and without root overflow')
      const first = centers[0]!
      for (const c of centers) {
        assert(Math.abs(c.nav - first.nav) <= CENTER_TOLERANCE_PX, `${c.view} nav cx ${c.nav} vs ${first.nav}`)
        assert(Math.abs(c.content - first.content) <= CENTER_TOLERANCE_PX, `${c.view} content cx ${c.content} vs ${first.content}`)
      }
    })
    await context.close()
  }

  // ─── 3) Същият изглед със и без vertical overflow (Lobby при 1920×1080 няма
  //        overflow в harness-а; добавяме висок spacer, за да се появи scrollbar).
  {
    const { context, page } = await openHarness(browser, baseUrl, { width: 1920, height: 1080 })
    await openView(page, 'lobby')
    const before = await measure(page)
    await page.evaluate(() => {
      const stage = document.querySelector('[data-lobby-scale-stage="1"]')
      const content = stage?.querySelector('nav')?.nextElementSibling
      const spacer = document.createElement('div')
      spacer.setAttribute('data-test-overflow-spacer', '1')
      spacer.style.height = '3000px'
      content?.appendChild(spacer)
    })
    await page.waitForTimeout(100)
    const after = await measure(page)
    console.log(`  [1920×1080 lobby] overflow ${before.rootHasOverflow ? 'yes' : 'no'} cx=${before.nav!.centerX.toFixed(2)} → overflow ${after.rootHasOverflow ? 'yes' : 'no'} cx=${after.nav!.centerX.toFixed(2)}`)
    await check('[1920×1080] same view with and without vertical overflow keeps the same centerX', () => {
      assert(!before.rootHasOverflow && after.rootHasOverflow, `overflow before=${before.rootHasOverflow} after=${after.rootHasOverflow}`)
      assert(Math.abs(before.nav!.centerX - after.nav!.centerX) <= CENTER_TOLERANCE_PX, `nav ${before.nav!.centerX} → ${after.nav!.centerX}`)
      assert(Math.abs(before.content!.centerX - after.content!.centerX) <= CENTER_TOLERANCE_PX, `content ${before.content!.centerX} → ${after.content!.centerX}`)
    })
    await context.close()
  }

  // ─── 4) Desktop scale breakpoint sweep: около всеки праг stage-ът трябва да
  //        се побира (без horizontal overflow) и да е точно в центъра.
  {
    const widths = [
      768, 769, 935, 936, 960, 961, 1083, 1084, 1120, 1121, 1231, 1232, 1280, 1281, 1342, 1345, 1346, 1366,
      1400, 1401, 1440, 1444, 1445, 1490, 1500, 1501, 1507, 1515, 1522, 1523, 1526, 1527,
      1600, 1601, 1604, 1608, 1609, 1700, 1701, 1919, 1920, 2199, 2200,
    ]
    const failures: string[] = []
    let measured = 0
    for (const width of widths) {
      const { context, page } = await openHarness(browser, baseUrl, { width, height: 900 })
      for (const view of ['lobby', 'topics', 'chat']) {
        await openView(page, view)
        const m = await measure(page)
        measured++
        const navDelta = m.nav!.centerX - m.viewportCenter
        const contentDelta = m.content!.centerX - m.viewportCenter
        const gutterEach = m.rootScrollbarWidth / 2
        const fits = m.nav!.left >= gutterEach - 0.5 && m.nav!.right <= width - gutterEach + 0.5
        if (m.horizontalOverflow > 0 || !fits || Math.abs(navDelta) > CENTER_TOLERANCE_PX || Math.abs(contentDelta) > CENTER_TOLERANCE_PX) {
          failures.push(`w=${width} ${view} scale=${m.scale} hOverflow=${m.horizontalOverflow} nav ${m.nav!.left.toFixed(1)}→${m.nav!.right.toFixed(1)} navDelta=${navDelta.toFixed(2)} contentDelta=${contentDelta.toFixed(2)}`)
        }
      }
      await context.close()
    }
    console.log(`  [breakpoint sweep] ${measured} measurements (${widths.length} widths × lobby/topics/chat)`)
    await check('[breakpoint sweep] stage fits, no horizontal overflow, centered on the viewport around every desktop scale breakpoint', () =>
      assert(failures.length === 0, failures.join(' | ')))
  }

  // ─── 5) Phone layout — не е засегнат (собствен root, без desktop gutter).
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }) // без isMobile: harness HTML-ът няма viewport meta
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined, undefined, { timeout: 10_000 })
    await page.evaluate(() => (window as any).__chatDraftHarness.openLobbyChat())
    await page.waitForTimeout(300)
    const phone = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')
      return {
        mobileLayout: root?.getAttribute('data-mobile-layout') === '1',
        hasScaleStage: document.querySelector('[data-lobby-scale-stage="1"]') !== null,
        gutter: root ? getComputedStyle(root).scrollbarGutter : null,
      }
    })
    await check('[phone 390×844] phone layout keeps its own root without the desktop scrollbar gutter', () => {
      assert(phone.mobileLayout && !phone.hasScaleStage, `not phone layout: ${JSON.stringify(phone)}`)
      assert(phone.gutter === 'auto', `phone root gutter changed: ${phone.gutter}`)
    })
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
