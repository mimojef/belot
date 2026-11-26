/**
 * checkSvaraWalletRefresh.ts — балансът след платен мач на „Свара“ се
 * презарежда от сървъра: при старт (удържан вход), при край (изплащане) и
 * при напускане на масата (връщане в лобито). Реален createLobbyFlowController
 * + реален DOM (Vite + Playwright), без backend; сървърното опресняване
 * (/api/auth/me) е имитирано в fixture-а.
 *
 *  [1] Победител: 382 000 → 367 000 (вход) → 391 000 (изплащане).
 *  [2] Загубил: 64 000 → 49 000 (вход), без промяна при края.
 *  [3] Загубил, излязъл по време на мача: опресняване при напускането.
 *  Повторени съобщения със същата фаза не предизвикват ново опресняване.
 *
 * Пускане (от корена): npx tsx scripts/checkSvaraWalletRefresh.ts
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.error(`  FAIL  ${label}`, detail ?? '') }
}
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
  const open = async (profile: string, balance: number): Promise<Page> => {
    const context = await browser!.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 900 } })
    await context.addInitScript({ content: 'window.__name = (f) => f' }) // esbuild keepNames в page.evaluate
    const page = await context.newPage()
    page.on('pageerror', (err) => { failed++; console.error('  pageerror', err.message) })
    await page.goto(`/scripts/fixtures/svaraWalletRefreshHarness.html?profile=${profile}&balance=${balance}`)
    await page.waitForFunction(() => (window as any).__svaraWallet !== undefined)
    await page.waitForTimeout(300)
    return page
  }
  const api = <T>(page: Page, fn: string, ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window as any).__svaraWallet[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>
  const settle = (page: Page) => page.waitForTimeout(120)
  const refreshes = (page: Page) => api<number>(page, 'refreshCount')
  const pageShows = async (page: Page, amount: number) =>
    (await page.evaluate(() => document.body.innerText)).replace(/\s/g, '').includes(String(amount))

  console.log('\n[1] Победител (PIKABG): 382 000 → 391 000')
  {
    const page = await open('winner', 382000)
    const both = { winner: 'active', loser: 'active' }
    check('начален баланс в лобито', await pageShows(page, 382000))
    await api(page, 'tableUpdated', 'm1', 'lobby', both); await settle(page)
    check('чакаща маса — без опресняване', (await refreshes(page)) === 0)
    await api(page, 'setServerBalance', 367000)
    await api(page, 'tableUpdated', 'm1', 'in-progress', both); await settle(page)
    check('старт → 1 опресняване', (await refreshes(page)) === 1)
    check('показан е балансът след входа (367 000)', await pageShows(page, 367000))
    await api(page, 'tableUpdated', 'm1', 'in-progress', both); await settle(page)
    check('същата фаза отново → без ново опресняване', (await refreshes(page)) === 1)
    await api(page, 'setServerBalance', 391000)
    await api(page, 'tableUpdated', 'm1', 'finished', { winner: 'active', loser: 'eliminated' }); await settle(page)
    check('край → 2 опреснявания', (await refreshes(page)) === 2)
    check('показан е балансът след изплащането (391 000)', await pageShows(page, 391000))
    await api(page, 'tableUpdated', 'm1', 'finished', { winner: 'active', loser: 'eliminated' }); await settle(page)
    check('повторен „finished“ → без ново опресняване', (await refreshes(page)) === 2)
    await api(page, 'tableLeft', 'm1'); await settle(page)
    check('връщане в лобито → опресняване', (await refreshes(page)) === 3)
    check('лобито показва 391 000', await pageShows(page, 391000) && !(await pageShows(page, 382000)))
    await page.context().close()
  }

  console.log('\n[2] Загубил (Master PIKA): 64 000 → 49 000')
  {
    const page = await open('loser', 64000)
    await api(page, 'setServerBalance', 49000)
    await api(page, 'tableUpdated', 'm2', 'in-progress', { winner: 'active', loser: 'active' }); await settle(page)
    check('старт → 1 опресняване', (await refreshes(page)) === 1)
    check('показан е балансът след входа (49 000)', await pageShows(page, 49000) && !(await pageShows(page, 64000)))
    await api(page, 'tableUpdated', 'm2', 'finished', { winner: 'active', loser: 'eliminated' }); await settle(page)
    check('край → 2 опреснявания, балансът остава 49 000', (await refreshes(page)) === 2 && await pageShows(page, 49000))
    await api(page, 'tableLeft', 'm2'); await settle(page)
    check('връщане в лобито → 3 опреснявания, 49 000', (await refreshes(page)) === 3 && await pageShows(page, 49000))
    // Следващ мач на същия профил: нова маса → нов цикъл.
    await api(page, 'tableUpdated', 'm3', 'lobby', { loser: 'active' }); await settle(page)
    check('нова чакаща маса — без опресняване', (await refreshes(page)) === 3)
    await api(page, 'setServerBalance', 34000)
    await api(page, 'tableUpdated', 'm3', 'in-progress', { loser: 'active', other: 'active' }); await settle(page)
    check('старт на следващия мач → опресняване (34 000)', (await refreshes(page)) === 4 && await pageShows(page, 34000))
    await page.context().close()
  }

  console.log('\n[3] Загубил, излязъл по време на мача')
  {
    const page = await open('loser', 64000)
    await api(page, 'setServerBalance', 49000)
    await api(page, 'tableUpdated', 'm4', 'in-progress', { winner: 'active', loser: 'active' }); await settle(page)
    await api(page, 'tableLeft', 'm4'); await settle(page)
    check('старт + напускане → 2 опреснявания', (await refreshes(page)) === 2)
    check('лобито показва 49 000', await pageShows(page, 49000) && !(await pageShows(page, 64000)))
    await page.context().close()
  }
} finally {
  await browser?.close()
  await vite?.close()
}
console.log(`\n${passed} PASS, ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
