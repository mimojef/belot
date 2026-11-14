/**
 * checkPrivateRoomCreateDraft.ts — „Нова маса“: външните обновявания на
 * списъка с частни маси (private_rooms_list) не нулират избраните настройки,
 * докато прозорецът е отворен. Desktop (тъмна форма) и mobile (светла форма).
 *
 * Реален Chromium + реалният production код през Vite
 * (scripts/fixtures/privateRoomCreateDraftHarness.ts), реални кликове.
 *
 *   [D1] всички настройки (залог, 4 отметки вкл. „Гласов чат“, изчакване,
 *        реакция) оцеляват след няколко външни обновявания — формата наистина
 *        е пресъздадена;
 *   [D2] промяна СЛЕД прерисуване също се пази (премахната отметка остава премахната);
 *   [D3] затваряне и ново отваряне -> стойностите по подразбиране;
 *   [D4] изпращането подава точно избраните стойности;
 *   [D5] без грешки в конзолата.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkPrivateRoomCreateDraft.ts
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') return reject(new Error('no port'))
    server.close(() => resolve(address.port))
  })
})

const FORM = '[data-private-room-create-form="1"]'
type FormState = {
  marker: string | null
  stake: string | null
  isLocked: boolean | null
  manualStart: boolean | null
  invitePartner: boolean | null
  voiceEnabled: boolean | null
  waitMinutes: string | null
  humanTurnTimeoutMs: string | null
}

// Скриптовете в браузъра са низове: tsx/esbuild добавя __name(...) към именуваните функции.
const readForm = (page: Page) => page.evaluate(`(() => {
  const f = document.querySelector('${FORM}')
  if (!f) return null
  const v = (n) => { const el = f.elements.namedItem(n); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null }
  return { marker: f.dataset.marker || null, stake: v('stake'), isLocked: v('isLocked'), manualStart: v('manualStart'), invitePartner: v('invitePartner'), voiceEnabled: v('voiceEnabled'), waitMinutes: v('waitMinutes'), humanTurnTimeoutMs: v('humanTurnTimeoutMs') }
})()`) as Promise<FormState | null>
const markForm = (page: Page) => page.evaluate(`(() => { document.querySelector('${FORM}').dataset.marker = 'before-update' })()`)
async function pushExternalUpdates(page: Page, count: number): Promise<boolean> {
  let handled = true
  for (let i = 0; i < count; i += 1) {
    handled = (await page.evaluate('window.__prcdHarness.pushRoomsList()')) === true && handled
    await page.waitForTimeout(60)
  }
  return handled
}
const same = (a: FormState | null, b: Partial<FormState>, label: string) => {
  assert(a !== null, `${label}: формата липсва`)
  for (const [key, value] of Object.entries(b)) {
    assert((a as Record<string, unknown>)[key] === value, `${label}: ${key}=${JSON.stringify((a as Record<string, unknown>)[key])}, очаквано ${JSON.stringify(value)}`)
  }
}

let vite: ViteDevServer | null = null
let browser: Browser | null = null
console.log('\ncheckPrivateRoomCreateDraft\n')
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()

  for (const vp of [
    { label: 'desktop 1280x850', width: 1280, height: 850, mobile: false },
    { label: 'mobile 390x844', width: 390, height: 844, mobile: true },
  ]) {
    const context = await browser.newContext(vp.mobile
      ? { viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: vp.width, height: vp.height } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })

    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/privateRoomCreateDraftHarness.html`)
    await page.waitForFunction('window.__prcdHarness !== undefined', null, { timeout: 15_000 })
    const openPopup = async () => {
      await page.evaluate('window.__prcdHarness.openCreatePopup()')
      await page.locator(`${FORM} [data-private-room-voice-checkbox="1"]`).waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForFunction(`document.querySelectorAll('${FORM} select[name="stake"] option').length === 3`, null, { timeout: 10_000 })
    }
    await openPopup()

    const defaults = await readForm(page)
    const variantIsLight = await page.locator('[role="dialog"][aria-label="Нова маса"]').count() > 0
    const reactionValues = await page.$$eval(`${FORM} select[name="humanTurnTimeoutMs"] option`, (options) => options.map((o) => (o as HTMLOptionElement).value))
    const reaction = reactionValues.find((value) => value !== defaults?.humanTurnTimeoutMs) ?? null

    // Реални действия на потребителя.
    await page.selectOption(`${FORM} select[name="stake"]`, '8000')
    for (const name of ['isLocked', 'manualStart', 'invitePartner', 'voiceEnabled']) await page.check(`${FORM} input[name="${name}"]`)
    await page.selectOption(`${FORM} select[name="waitMinutes"]`, '30')
    if (reaction !== null) await page.selectOption(`${FORM} select[name="humanTurnTimeoutMs"]`, reaction)
    await markForm(page)
    const handled = await pushExternalUpdates(page, 3)
    const afterUpdates = await readForm(page)

    await check(`[${vp.label}] [D1] След 3 външни обновявания на списъка (формата е пресъздадена) всички настройки са запазени`, async () => {
      assert(variantIsLight === vp.mobile, `вариант: ${variantIsLight ? 'светъл' : 'тъмен'}`)
      same(defaults, { stake: '5000', isLocked: false, manualStart: false, invitePartner: false, voiceEnabled: false, waitMinutes: '15' }, 'по подразбиране')
      assert(reaction !== null, 'има алтернативно време за реакция')
      assert(handled, 'private_rooms_list е обработен от контролера')
      same(afterUpdates, { marker: null, stake: '8000', isLocked: true, manualStart: true, invitePartner: true, voiceEnabled: true, waitMinutes: '30', humanTurnTimeoutMs: reaction }, 'след обновяване')
    })

    await page.uncheck(`${FORM} input[name="manualStart"]`)
    await markForm(page)
    await pushExternalUpdates(page, 2)
    await check(`[${vp.label}] [D2] Промяна след прерисуване (премахната отметка) също се пази`, async () => {
      same(await readForm(page), { marker: null, stake: '8000', isLocked: true, manualStart: false, invitePartner: true, voiceEnabled: true, waitMinutes: '30', humanTurnTimeoutMs: reaction }, 'след второ обновяване')
    })

    await page.locator('[data-private-rooms-create-close="1"]').first().click()
    await page.locator(FORM).waitFor({ state: 'detached', timeout: 5_000 })
    await openPopup()
    await check(`[${vp.label}] [D3] Затваряне и ново отваряне -> стойностите по подразбиране`, async () => {
      same(await readForm(page), { stake: '5000', isLocked: false, manualStart: false, invitePartner: false, voiceEnabled: false, waitMinutes: '15', humanTurnTimeoutMs: defaults?.humanTurnTimeoutMs ?? null }, 'ново отваряне')
    })

    await page.selectOption(`${FORM} select[name="stake"]`, '10000')
    await page.check(`${FORM} input[name="invitePartner"]`)
    await page.check(`${FORM} input[name="voiceEnabled"]`)
    await page.selectOption(`${FORM} select[name="waitMinutes"]`, '5')
    await pushExternalUpdates(page, 2)
    await page.locator(`${FORM} button[type="submit"]`).click()
    const args = await page.evaluate('window.__prcdHarness.getLastCreateArgs()') as unknown[] | undefined
    await check(`[${vp.label}] [D4] Изпращането след външни обновявания подава точно избраните стойности`, async () => {
      // (stake, isLocked, waitMinutes, manualStart, humanTurnTimeoutMs, invitePartner, voiceEnabled)
      assert(JSON.stringify(args) === JSON.stringify([10000, false, 5, false, Number(defaults?.humanTurnTimeoutMs), true, true]), `args: ${JSON.stringify(args)}`)
    })

    await check(`[${vp.label}] [D5] Без грешки в конзолата`, async () => {
      assert(errors.length === 0, errors.join(' | '))
    })
    await context.close()
  }
} finally {
  await browser?.close()
  await vite?.close()
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
