/**
 * checkSvaraSeatGrid.ts — местата на чакащите маси на „Свара“ в списъка.
 * Реален createSvaraLobbyController + реален DOM (Vite + Playwright), без backend.
 *
 *  - 2×2 (Място 1 | Място 2 / Място 3 | Място 4) на desktop и mobile; само наличните места (2/3/4);
 *  - заето: реална профилна снимка (или инициал) + ник; свободно: зелен „+“;
 *  - „+“ (единственият начин — без „Влез“) изпраща присъединяване точно към това място;
 *  - пълна / започнала маса и собствена маса → без активен „+“;
 *  - обновяване при влизане/напускане (нов svara_tables_list);
 *  - без хоризонтално превъртане (390 / 320 / 1280).
 *
 * Пускане (от корена): npx tsx scripts/checkSvaraSeatGrid.ts
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  PASS  ${label}`) }
  else { failed++; console.error(`  FAIL  ${label}`, detail === undefined ? '' : JSON.stringify(detail)) }
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createNetServer(); srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => { const a = srv.address(); if (a === null || typeof a === 'string') return reject(new Error('port')); srv.close(() => resolve(a.port)) })
})

const AVATAR = '/assets/lobby/icon-coin.png'
type Player = { playerId: string; seat: number; displayName: string; avatarUrl: string | null }
const player = (playerId: string, seat: number, avatar = true): Player => ({ playerId, seat, displayName: `Ник ${playerId}`, avatarUrl: avatar ? AVATAR : null })
const table = (matchId: string, capacity: 2 | 3 | 4, players: Player[], phase: 'lobby' | 'in-progress' = 'lobby') => ({
  matchId, phase, capacity, creatorId: players[0]?.playerId ?? 'x', startMode: 'auto', entryFee: 8000, entryPercent: 1, startingChips: 800, entryChips: 8,
  prizeAmount: 8000 * capacity * 0.8, paid: true, players: players.map((p) => ({ ...p, status: 'active' })),
})

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const open = async (mobile: boolean, width: number): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser!.newContext({ baseURL: `http://127.0.0.1:${port}`,
      ...(mobile ? { viewport: { width, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : { viewport: { width, height: 900 } }) })
    await context.addInitScript({ content: 'window.__name = (f) => f' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/scripts/fixtures/svaraSeatGridHarness.html?light=${mobile ? 1 : 0}`)
    await page.waitForFunction(() => (window as any).__svaraSeats !== undefined)
    return { page, errors }
  }
  const setTables = async (page: Page, tables: unknown[]) => { await page.evaluate((t) => (window as any).__svaraSeats.setTables(t), tables); await page.waitForTimeout(80) }
  const cells = (page: Page, matchId: string) => page.evaluate((id) => {
    const grid = document.querySelector(`[data-svara-list-seats="${id}"]`)
    if (!grid) return null
    return [...grid.children].map((el) => {
      const rect = el.getBoundingClientRect()
      const e = el as HTMLElement
      return { x: Math.round(rect.left), y: Math.round(rect.top), w: rect.width, kind: e.dataset.svaraSeatJoin !== undefined ? 'plus' : e.dataset.svaraSeatFree !== undefined ? 'free' : 'player',
        text: e.innerText.trim(), img: e.querySelector('img')?.getAttribute('src') ?? null, color: getComputedStyle(e).color, overflow: e.scrollWidth > e.clientWidth + 1 }
    })
  }, matchId)
  const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    && [...document.querySelectorAll('[data-svara-list-seats]')].every((grid) => grid.scrollWidth <= grid.clientWidth + 1))
  const isGreen = (rgb: string) => { const [r, g, b] = rgb.match(/\d+/g)!.map(Number); return g! > 120 && g! > r! + 40 && g! > b! + 20 }

  for (const [label, mobile, width] of [['desktop 1280', false, 1280], ['mobile 390', true, 390], ['mobile 320', true, 320]] as const) {
    console.log(`\n[${label}]`)
    const { page, errors } = await open(mobile, width)
    await setTables(page, [
      table('m4', 4, [player('host', 0), player('guest', 3, false)]),
      table('m3', 3, [player('a3', 0), player('b3', 1)]),
      table('m2', 2, [player('a2', 0)]),
      table('mfull', 2, [player('f1', 0), player('f2', 1)]),
      table('mplay', 4, [player('p1', 0), player('p2', 1), player('p3', 2), player('p4', 3)], 'in-progress'),
    ])
    const c4 = (await cells(page, 'm4'))!
    check('маса за 4: точно 4 места', c4.length === 4)
    check('2×2: Място 1 | Място 2 на един ред, Място 3 | Място 4 под тях', c4[0]!.y === c4[1]!.y && c4[2]!.y === c4[3]!.y && c4[2]!.y > c4[0]!.y && c4[0]!.x === c4[2]!.x && c4[1]!.x === c4[3]!.x && c4[1]!.x > c4[0]!.x, c4)
    check('място 1: реална снимка + ник', c4[0]!.kind === 'player' && c4[0]!.img === AVATAR && c4[0]!.text.includes('Ник host'))
    check('място 4: без снимка → инициал + ник', c4[3]!.kind === 'player' && c4[3]!.img === null && c4[3]!.text.includes('Ник guest'))
    check('места 2 и 3: зелен „+“', c4[1]!.kind === 'plus' && c4[2]!.kind === 'plus' && c4[1]!.text === '+' && isGreen(c4[1]!.color), c4[1])
    check('ниците не препълват клетките', c4.every((c) => !c.overflow))
    const c3 = (await cells(page, 'm3'))!
    check('маса за 3: 3 места (2 + 1 под тях), третото е „+“', c3.length === 3 && c3[0]!.y === c3[1]!.y && c3[2]!.y > c3[0]!.y && c3[2]!.kind === 'plus')
    const c2 = (await cells(page, 'm2'))!
    check('маса за 2: 2 места на един ред', c2.length === 2 && c2[0]!.y === c2[1]!.y && c2[1]!.kind === 'plus')
    const full = (await cells(page, 'mfull'))!
    check('пълна маса: без „+“', full.every((c) => c.kind === 'player'))
    check('пълна маса: „Пълна“ в реда с капацитета', await page.evaluate(() =>
      document.querySelector('[data-svara-list-seats="mfull"]')!.closest('article')!.querySelector('[data-svara-list-meta="1"]')!.textContent!.includes('Пълна')))
    check('няма бутон „Влез“ — присъединяване само през „+“', (await page.locator('[data-svara-table-join]').count()) === 0
      && !(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Влез'))))
    check('започнала маса не е сред чакащите (без места за присъединяване)', (await cells(page, 'mplay')) === null)
    check('запазени: вход, награда, капацитет и режим', await page.evaluate(() => {
      const card = document.querySelector('[data-svara-list-seats="m4"]')!.closest('article')!.innerText.replace(/\s+/g, ' ')
      return card.includes('2/4') && card.includes('При запълване') && card.includes('Вход:') && card.includes('8 000') && card.includes('Награда:') && card.includes('25 600')
    }))
    check('без хоризонтално превъртане', await noHorizontalScroll(page))

    // „+“ → присъединяване точно към избраното място.
    await page.locator('[data-svara-seat-join="m4:2"]').click()
    const joins = await page.evaluate(() => (window as any).__svaraSeats.joins)
    check('„+“ на място 3 → onJoin(m4, 2)', joins.length === 1 && joins[0].matchId === 'm4' && joins[0].seat === 2, joins)
    check('докато чака отговор — няма активни „+“ (без двойна заявка)', (await page.locator('[data-svara-seat-join]').count()) === 0)
    await page.evaluate(() => (window as any).__svaraSeats.showMessage('Мястото вече е заето. Избери друго свободно място.'))
    await page.waitForTimeout(60)
    check('отказ от сървъра → „+“ отново активни', (await page.locator('[data-svara-seat-join]').count()) > 0)

    // Обновяване: някой заема място 2, после напуска.
    await setTables(page, [table('m4', 4, [player('host', 0), player('new', 1), player('guest', 3, false)])])
    const updated = (await cells(page, 'm4'))!
    check('влизане → мястото показва снимка и ник', updated[1]!.kind === 'player' && updated[1]!.text.includes('Ник new') && updated[1]!.img === AVATAR)
    await setTables(page, [table('m4', 4, [player('host', 0), player('guest', 3, false)])])
    check('напускане → мястото отново е „+“', (await cells(page, 'm4'))![1]!.kind === 'plus')

    check('без грешки в страницата', errors.length === 0, errors)
    await page.context().close()
  }
} finally {
  await browser?.close()
  await vite?.close()
}
console.log(`\n${passed} PASS, ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
