/**
 * checkSvaraMainLobbyEntry.ts — целеви проверки за „Свара“ в основното лоби
 * (телефон): банер + „Частни маси – Свара“ след „Не се сърди човече“.
 * Реален контролер + реален DOM (Vite + Playwright), без backend.
 *
 *  [1] Видимост: само при сървърния сигнал svaraTestAccess (вкл. обикновен
 *      профил при „Достъпна за всички“); без него — нищо и без абонамент.
 *  [2] Брояч: чакащите маси (фаза lobby) от svara_tables_list, обновяване.
 *  [3] Мобилно оформление: ред, ширини, рамки и отстояния като Ludo.
 *
 * Пускане (от корена): npx tsx scripts/checkSvaraMainLobbyEntry.ts
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${label}`) }
  catch (err) { failed++; console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`) }
}
function assert(condition: boolean, msg: string): void { if (!condition) throw new Error(msg) }
const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createNetServer(); srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => { const a = srv.address(); if (a === null || typeof a === 'string') return reject(new Error('port')); srv.close(() => resolve(a.port)) })
})

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const open = async (query: string): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser!.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 })
    await context.addInitScript({ content: 'window.__name = (f) => f' }) // esbuild keepNames в page.evaluate
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/scripts/fixtures/svaraMainLobbyHarness.html?${query}`)
    await page.waitForSelector('[data-lobby-guest-ludo-private="1"]')
    return { page, errors }
  }
  const calls = (page: Page) => page.evaluate(() => (window as any).__svaraMainLobby.calls as string[])
  const badge = (page: Page) => page.evaluate(() => {
    const row = document.querySelector('[data-lobby-svara-private-row="1"]')
    const pill = row ? [...row.querySelectorAll('span[aria-hidden="true"]')].find((s) => /^\d+\+?$/.test(s.textContent?.trim() ?? '')) : null
    return pill?.textContent?.trim() ?? null
  })
  const sendTables = async (page: Page, phases: string[]) => {
    await page.evaluate((p) => (window as any).__svaraMainLobby.sendTables(p), phases)
    await page.waitForTimeout(150)
  }

  console.log('\n[1] Видимост')
  for (const role of ['player', 'admin']) {
    const { page } = await open(`access=0&role=${role}`)
    await check(`без сървърен достъп (role=${role}) — няма банер, каре и абонамент`, async () => {
      assert(await page.locator('[data-lobby-svara-section="1"], [data-lobby-svara-private="1"]').count() === 0, 'елементите са видими')
      assert(!(await calls(page)).includes('onSvaraTablesOpen'), 'изпратен е request_svara_tables_list')
    })
    await page.context().close()
  }
  const { page, errors } = await open('access=1&role=player')
  await check('със сървърен достъп (обикновен профил, „Достъпна за всички“) — банер, „Създай игра“ и каре; абонамент веднъж', async () => {
    assert(await page.locator('[data-lobby-svara-section="1"] [data-lobby-svara-create="1"]').count() === 1, 'няма „Създай игра“')
    assert(await page.locator('[data-lobby-svara-section="1"] img[src="/assets/lobby-mobile/svara-banner.webp"]').count() === 1, 'няма банер')
    assert(await page.locator('[data-lobby-svara-private="1"] [data-svara-play-button="1"]').count() === 1, 'няма каре → /games/svara')
    assert((await page.locator('[data-lobby-svara-private="1"]').innerText()).includes('Частни маси – Свара'), 'заглавие')
    const n = (await calls(page)).filter((c) => c === 'onSvaraTablesOpen').length
    assert(n === 1, `абонамент ${n} пъти`)
  })

  console.log('\n[2] Брояч')
  await check('2 чакащи + 1 играеща → значка 2; старт → 1; освобождаване → без значка', async () => {
    assert(await badge(page) === null, 'начално без значка')
    await sendTables(page, ['lobby', 'lobby', 'in-progress']); const a = await badge(page)
    await sendTables(page, ['lobby', 'in-progress', 'in-progress']); const b = await badge(page)
    await sendTables(page, ['in-progress']); const c = await badge(page)
    assert(a === '2' && b === '1' && c === null, JSON.stringify({ a, b, c }))
  })
  await check('отново 3 чакащи → значка 3', async () => {
    await sendTables(page, ['lobby', 'lobby', 'lobby'])
    assert(await badge(page) === '3', String(await badge(page)))
  })

  console.log('\n[3] Мобилно оформление')
  await check('ред: Ludo банер → Ludo каре → Свара банер → Свара каре → „Ежедневни награди“', async () => {
    const order = await page.evaluate(() => ['[data-lobby-guest-ludo-section="1"]', '[data-lobby-guest-ludo-private="1"]', '[data-lobby-svara-section="1"]', '[data-lobby-svara-private="1"]', '[data-lobby-guest-rows="1"]']
      .map((s) => document.querySelector(s)!.getBoundingClientRect().top))
    assert(order.every((top, i) => i === 0 || top > order[i - 1]!), JSON.stringify(order))
  })
  await check('същите ширини и рамки като Ludo; отстоянията между секциите съвпадат', async () => {
    const m = await page.evaluate(() => {
      const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect()
      const art = (s: string) => document.querySelector(`${s} article`)!
      const ludoArt = art('[data-lobby-guest-ludo-section="1"]'), svaraArt = art('[data-lobby-svara-section="1"]')
      const ls = getComputedStyle(ludoArt), ss = getComputedStyle(svaraArt)
      const slot = (n: string) => document.querySelector(`[data-lobby-media-slot="${n}"]`)!.getBoundingClientRect()
      const row = (s: string) => document.querySelector(`${s} button`)!.getBoundingClientRect()
      return {
        artW: [ludoArt.getBoundingClientRect().width, svaraArt.getBoundingClientRect().width],
        frame: [ls.borderRadius, ls.border, ls.boxShadow, ls.padding].join('|') === [ss.borderRadius, ss.border, ss.boxShadow, ss.padding].join('|'),
        slotH: [slot('ludo-banner').height, slot('svara-banner').height],
        rowW: [row('[data-lobby-guest-ludo-private="1"]').width, row('[data-lobby-svara-private="1"]').width],
        // Реалната височина зависи от дължината на заглавието — сравнява се рамката на реда.
        rowH: ['[data-lobby-guest-ludo-private="1"]', '[data-lobby-svara-private="1"]'].map((s) => { const st = getComputedStyle(document.querySelector(`${s} button`)!); return Number.parseFloat(st.minHeight) + Number.parseFloat(st.borderRadius) + Number.parseFloat(st.paddingTop) }),
        gapIntoLudo: rect('[data-lobby-guest-ludo-section="1"] h2').top - rect('[data-lobby-guest-belot-private="1"]').bottom,
        gapIntoSvara: rect('[data-lobby-svara-section="1"] h2').top - rect('[data-lobby-guest-ludo-private="1"]').bottom,
        gapToRowsLudo: rect('[data-lobby-guest-ludo-private="1"]').top - rect('[data-lobby-guest-ludo-section="1"] article').bottom,
        gapToRowsSvara: rect('[data-lobby-svara-private="1"]').top - rect('[data-lobby-svara-section="1"] article').bottom,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }
    })
    const eq = (a: number, b: number) => Math.abs(a - b) < 0.6
    assert(eq(m.artW[0]!, m.artW[1]!) && m.frame && eq(m.rowW[0]!, m.rowW[1]!) && eq(m.rowH[0]!, m.rowH[1]!)
      && eq(m.gapIntoLudo, m.gapIntoSvara) && eq(m.gapToRowsLudo, m.gapToRowsSvara) && !m.overflow, JSON.stringify(m))
  })
  await check('няма JS грешки', async () => { assert(errors.length === 0, errors.join('; ')) })
  await page.context().close()

  console.log('\n[4] Отстояния: игра → „Частни маси“ 8px, между групите 18px, преди „Ежедневни награди“ 24px')
  for (const width of [360, 390]) {
    const context = await browser!.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 })
    await context.addInitScript({ content: 'window.__name = (f) => f' })
    const p = await context.newPage()
    await p.goto('/scripts/fixtures/svaraMainLobbyHarness.html?access=1&role=player')
    await p.waitForSelector('[data-lobby-stakes-scroll="1"] > *')
    await check(`${width}px: банерът на „Свара“ — без изрязване (контейнер = пропорцията на картинката), в рамките на екрана`, async () => {
      await p.waitForFunction(() => (document.querySelector('[data-lobby-media-slot="svara-banner"] img') as HTMLImageElement | null)?.complete === true)
      const b = await p.evaluate(() => {
        const slot = document.querySelector('[data-lobby-media-slot="svara-banner"]')!
        const img = slot.querySelector('img') as HTMLImageElement, r = slot.getBoundingClientRect(), s = getComputedStyle(slot)
        return { natural: [img.naturalWidth, img.naturalHeight], ratio: r.width / r.height, left: r.left, right: r.right, vw: window.innerWidth, radius: s.borderRadius, overflow: s.overflow }
      })
      assert(b.natural[0] === 1200 && b.natural[1] === 400 && Math.abs(b.ratio - 3) < 0.02 && b.left >= 0 && b.right <= b.vw
        && b.radius === '8px' && b.overflow === 'hidden', JSON.stringify(b))
    })
    await check(`${width}px: отстояния`, async () => {
      const g = await p.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect()
        const card = document.querySelector('[data-lobby-stakes-scroll="1"] > *')!.getBoundingClientRect()
        return {
          belotPair: r('[data-lobby-guest-belot-private="1"]').top - card.bottom,
          ludoPair: r('[data-lobby-guest-ludo-private="1"]').top - r('[data-lobby-guest-ludo-section="1"] article').bottom,
          svaraPair: r('[data-lobby-svara-private="1"]').top - r('[data-lobby-svara-section="1"] article').bottom,
          belotToLudo: r('[data-lobby-guest-ludo-section="1"]').top - r('[data-lobby-guest-belot-private="1"]').bottom,
          ludoToSvara: r('[data-lobby-svara-section="1"]').top - r('[data-lobby-guest-ludo-private="1"]').bottom,
          toRewards: r('[data-lobby-guest-rows="1"]').top - r('[data-lobby-svara-private="1"]').bottom,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        }
      })
      const eq = (a: number, b: number) => Math.abs(a - b) < 0.6
      assert(eq(g.belotPair, 8) && eq(g.ludoPair, 8) && eq(g.svaraPair, 8) && eq(g.belotToLudo, 18) && eq(g.ludoToSvara, 18) && eq(g.toRewards, 24) && !g.overflow, JSON.stringify(g))
    })
    if (process.env.SCREENSHOT_DIR) await p.waitForTimeout(3000) // началният екран за зареждане
    if (process.env.SCREENSHOT_DIR) {
      await p.locator('[data-lobby-svara-section="1"]').scrollIntoViewIfNeeded()
      await p.screenshot({ path: `${process.env.SCREENSHOT_DIR}/svara-lobby-${width}.png` })
    }
    await context.close()
  }
  console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
