/**
 * checkPrivateRoomCreatePopupKeep.ts — „Нова маса“: при обновяване на списъка с
 * частни маси (private_rooms_list) отвореният прозорец НЕ се пресъздава в DOM;
 * списъкът под него се обновява независимо. Desktop (тъмна форма) и mobile
 * (светла форма).
 *
 * Реален Chromium + реалният production код през Vite
 * (scripts/fixtures/privateRoomCreateDraftHarness.ts), реални кликове/клавиши.
 *
 *   [K1] същият DOM възел (не е откачан нито веднъж), фокусът остава; списъкът
 *        под прозореца е обновен;
 *   [K2] отворено падащо меню остава работещо по време на обновяванията
 *        (изборът с клавиатура след тях се прилага в същото меню);
 *   [K3] отметки по време на обновяванията остават в същия DOM;
 *   [K4] без дублирани слушатели: едно изпращане -> едно създаване с избраните стойности.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkPrivateRoomCreatePopupKeep.ts
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

const POPUP = '[data-private-rooms-create-backdrop="1"]'
const FORM = '[data-private-room-create-form="1"]'

// Скриптовете в браузъра са низове: tsx/esbuild добавя __name(...) към именуваните функции.
/** Маркира текущия възел на прозореца и брои всяко откачане/blur, докато тече проверката. */
const watchPopup = (page: Page) => page.evaluate(`(() => {
  const popup = document.querySelector('${POPUP}')
  popup.__keepProbe = true
  window.__keepStats = { detached: 0, blurs: 0 }
  new MutationObserver(() => { if (!popup.isConnected) window.__keepStats.detached += 1 })
    .observe(document.body, { childList: true, subtree: true })
  popup.querySelectorAll('select, input').forEach((el) => el.addEventListener('blur', () => { window.__keepStats.blurs += 1 }))
})()`)
const popupState = (page: Page) => page.evaluate(`(() => {
  const popup = document.querySelector('${POPUP}')
  const form = document.querySelector('${FORM}')
  return {
    sameNode: !!(popup && popup.__keepProbe === true),
    detached: window.__keepStats.detached,
    blurs: window.__keepStats.blurs,
    activeName: document.activeElement && document.activeElement.getAttribute('name'),
    waitMinutes: form ? form.elements.namedItem('waitMinutes').value : null,
    isLocked: form ? form.elements.namedItem('isLocked').checked : null,
    voiceEnabled: form ? form.elements.namedItem('voiceEnabled').checked : null,
  }
})()`) as Promise<{ sameNode: boolean; detached: number; blurs: number; activeName: string | null; waitMinutes: string | null; isLocked: boolean | null; voiceEnabled: boolean | null }>
const listRoomIds = (page: Page) => page.evaluate(`Array.from(new Set(Array.from(document.querySelectorAll('[data-private-room-list-slot-join]')).map((el) => el.getAttribute('data-private-room-list-slot-join').split(':')[0]))).sort()`) as Promise<string[]>
async function pushExternalUpdates(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    assert((await page.evaluate('window.__prcdHarness.pushRoomsList()')) === true, 'private_rooms_list не е обработен')
    await page.waitForTimeout(80)
  }
}

let vite: ViteDevServer | null = null
let browser: Browser | null = null
console.log('\ncheckPrivateRoomCreatePopupKeep\n')
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
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/privateRoomCreateDraftHarness.html`)
    await page.waitForFunction('window.__prcdHarness !== undefined', null, { timeout: 15_000 })
    await page.evaluate('window.__prcdHarness.openCreatePopup()')
    await page.locator(`${FORM} [data-private-room-voice-checkbox="1"]`).waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForFunction(`document.querySelectorAll('${FORM} select[name="stake"] option').length === 3`, null, { timeout: 10_000 })
    const isLight = await page.locator('[role="dialog"][aria-label="Нова маса"]').count() > 0
    await watchPopup(page)

    // [K1] Фокус върху падащо меню, после външни обновявания.
    const listBefore = await listRoomIds(page)
    await page.locator(`${FORM} select[name="waitMinutes"]`).focus()
    await pushExternalUpdates(page, 3)
    const listAfter = await listRoomIds(page)
    const k1 = await popupState(page)
    await check(`[${vp.label}] [K1] Прозорецът е същият DOM възел (0 откачания, фокусът остава), а списъкът под него е обновен`, async () => {
      assert(isLight === vp.mobile, `вариант: ${isLight ? 'светъл' : 'тъмен'}`)
      assert(k1.sameNode && k1.detached === 0 && k1.blurs === 0, JSON.stringify(k1))
      assert(k1.activeName === 'waitMinutes', `фокус: ${k1.activeName}`)
      assert(listAfter.length > 0 && JSON.stringify(listAfter) !== JSON.stringify(listBefore) && listAfter.every((id) => id.startsWith('ext-3-')), `списък: ${JSON.stringify(listBefore)} -> ${JSON.stringify(listAfter)}`)
    })

    // [K2] Отворено падащо меню (клик), обновявания, избор с клавиатура в същото меню.
    await page.locator(`${FORM} select[name="waitMinutes"]`).click()
    await pushExternalUpdates(page, 2)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    const k2 = await popupState(page)
    await check(`[${vp.label}] [K2] Отвореното падащо меню работи през обновяванията: изборът след тях (15 -> 10 мин.) се прилага`, async () => {
      assert(k2.sameNode && k2.detached === 0, JSON.stringify(k2))
      assert(k2.waitMinutes === '10', `waitMinutes: ${k2.waitMinutes}`)
    })

    // [K3] Отметки между обновяванията.
    await page.check(`${FORM} input[name="isLocked"]`)
    await pushExternalUpdates(page, 1)
    await page.check(`${FORM} input[name="voiceEnabled"]`)
    await pushExternalUpdates(page, 2)
    const k3 = await popupState(page)
    await check(`[${vp.label}] [K3] Отметки по време на обновяванията остават в същия DOM`, async () => {
      assert(k3.sameNode && k3.detached === 0 && k3.isLocked === true && k3.voiceEnabled === true && k3.waitMinutes === '10', JSON.stringify(k3))
    })

    // [K4] Без дублирани слушатели след много запазващи прерисувания.
    await page.locator(`${FORM} button[type="submit"]`).click()
    await page.waitForTimeout(150)
    const createCalls = await page.evaluate(`window.__prcdHarness.getCreateCallCount()`) as number
    const args = await page.evaluate('window.__prcdHarness.getLastCreateArgs()') as unknown[] | undefined
    await check(`[${vp.label}] [K4] Без дублирани слушатели: едно изпращане -> точно едно създаване с избраните стойности; без грешки`, async () => {
      assert(createCalls === 1, `създавания: ${createCalls}`)
      assert(Array.isArray(args) && args[0] === 5000 && args[1] === true && args[2] === 10 && args[6] === true, `args: ${JSON.stringify(args)}`)
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
