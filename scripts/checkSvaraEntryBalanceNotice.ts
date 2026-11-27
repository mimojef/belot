/**
 * checkSvaraEntryBalanceNotice.ts — уведомлението „Нямаш достатъчно жълтици за
 * входа на тази маса.“ (сървърен код insufficient_entry_balance) в „Свара“.
 * Реален createLobbyFlowController + реален DOM (Vite + Playwright), без backend.
 *
 *  - desktop (1280) → тъмно-златният вид; mobile (390, светлата рамка) → светлият;
 *  - „Отказ“ / Escape затварят, без навигация;
 *  - „Зареди“ отваря магазина в секция „Жълтици“ (екран shop, таб coins);
 *  - уведомленията към другите (освободено място / закрита маса) остават
 *    обикновен ред със съобщение, без прозорец.
 *
 * Пускане (от корена): npx tsx scripts/checkSvaraEntryBalanceNotice.ts
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

const TEXT = 'Нямаш достатъчно жълтици за входа на тази маса.'
const NOTICE = '[data-svara-insufficient-balance-notice="1"]'

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const open = async (mobile: boolean): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser!.newContext({
      baseURL: `http://127.0.0.1:${port}`,
      ...(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : { viewport: { width: 1280, height: 900 } }),
    })
    await context.addInitScript({ content: 'window.__name = (f) => f' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/scripts/fixtures/svaraEntryBalanceNoticeHarness.html')
    await page.waitForFunction(() => (window as any).__svaraNotice !== undefined)
    await page.waitForTimeout(400)
    return { page, errors }
  }
  const send = async (page: Page, code: string, message: string) => {
    await page.evaluate(([c, m]) => (window as any).__svaraNotice.sendError(c, m), [code, message] as const)
    await page.waitForTimeout(120)
  }
  const screen = (page: Page) => page.evaluate(() => (window as any).__svaraNotice.screen() as string)
  const shopTab = (page: Page) => page.evaluate(() => (window as any).__svaraNotice.shopTab() as string)

  for (const [label, mobile, theme] of [['desktop', false, 'desktop'], ['mobile', true, 'mobile']] as const) {
    console.log(`\n[${label}]`)
    const { page, errors } = await open(mobile)
    const before = await screen(page)
    await send(page, 'insufficient_entry_balance', TEXT)
    const notice = page.locator(NOTICE)
    check('прозорецът се показва веднъж', (await notice.count()) === 1)
    check(`тема ${theme}`, (await notice.getAttribute('data-svara-insufficient-balance-theme')) === theme)
    check('текстът е точно сървърният', (await notice.locator('[data-svara-insufficient-balance-text="1"]').innerText()).trim() === TEXT)
    const topUp = notice.locator('[data-svara-insufficient-balance-topup="1"]')
    const cancel = notice.locator('[data-svara-insufficient-balance-cancel="1"]')
    check('бутони „Зареди“ и „Отказ“', (await topUp.innerText()).trim() === 'Зареди' && (await cancel.innerText()).trim() === 'Отказ')
    const card = await notice.locator('[data-svara-insufficient-balance-card="1"]').boundingBox()
    const viewport = page.viewportSize()!
    check('картата е изцяло във видимата част', card !== null && card.x >= 0 && card.y >= 0 && card.x + card.width <= viewport.width && card.y + card.height <= viewport.height, card)
    const topUpBox = await topUp.boundingBox()
    check('бутоните са достатъчно големи за докосване (≥ 44px)', topUpBox !== null && topUpBox.height >= 44)
    check('без ред със съобщение отдолу (само прозорецът)', (await page.locator('[data-svara-lobby-message="1"]').count()) === 0)

    await send(page, 'insufficient_entry_balance', TEXT)
    check('повторно известие замества предишното (едно копие)', (await page.locator(NOTICE).count()) === 1)

    await page.locator(`${NOTICE} [data-svara-insufficient-balance-cancel="1"]`).click()
    check('„Отказ“ затваря без навигация', (await page.locator(NOTICE).count()) === 0 && (await screen(page)) === before)

    await send(page, 'insufficient_entry_balance', TEXT)
    await page.keyboard.press('Escape')
    check('Escape затваря', (await page.locator(NOTICE).count()) === 0 && (await screen(page)) === before)

    await send(page, 'insufficient_entry_balance', TEXT)
    await page.locator(`${NOTICE} [data-svara-insufficient-balance-topup="1"]`).click()
    await page.waitForTimeout(300)
    check('„Зареди“ → магазинът, секция „Жълтици“', (await page.locator(NOTICE).count()) === 0 && (await screen(page)) === 'shop' && (await shopTab(page)) === 'coins')
    // Активният таб се различава по вид (на desktop няма aria-pressed): „Жълтици“ ≠ двата неактивни, които са еднакви.
    const tabStyles = await page.evaluate(() => ['coins', 'vip', 'bundle'].map((key) => document.querySelector(`[data-shop-tab="${key}"]`)?.getAttribute('style') ?? null))
    check('…в DOM активният таб е „Жълтици“', tabStyles.every((s) => s !== null) && tabStyles[0] !== tabStyles[1] && tabStyles[1] === tabStyles[2], tabStyles)

    for (const code of ['seat_released_insufficient_balance', 'table_closed_insufficient_balance']) {
      await send(page, code, 'друго')
      check(`${code} → без прозорец „Зареди“`, (await page.locator(NOTICE).count()) === 0)
    }
    check('без грешки в страницата', errors.length === 0, errors)
    await page.context().close()
  }
} finally {
  await browser?.close()
  await vite?.close()
}
console.log(`\n${passed} PASS, ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
