/**
 * checkPrivateRoomWaitingLayout.ts — layout на чакалнята на частна маса в
 * production обвивката (src/style.css: body/#app с фиксирана височина и
 * overflow:hidden; root = #app). Реален Chromium + реалният production код
 * през Vite (scripts/fixtures/privateRoomWaitingLayoutHarness.ts).
 *
 * Матрица: desktop/mobile × няколко височини × с/без гласов чат × с/без
 * известие „приета покана“; маса 3/4, 40 съобщения в чата.
 *
 *   [L1] полето за писане и „Изпрати“ са достижими с потребителски скрол
 *        (колелце) и напълно видими/кликаеми в екрана;
 *   [L2] съобщенията имат собствен скрол (панелът не расте със съобщенията);
 *   [L3] при недостатъчна височина чакалнята скролва вертикално; екранът не
 *        е по-висок от viewport-а; без хоризонтален overflow;
 *   [L4] писането в полето работи; без грешки;
 *   [L5] ново съобщение (пълно прерисуване) не връща скрола на чакалнята най-горе.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkPrivateRoomWaitingLayout.ts
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

type Box = { top: number; bottom: number; hit: boolean }
type Metrics = {
  vh: number; vw: number
  docScrollW: number
  screenScrollH: number; screenClientH: number; screenScrollTop: number
  chatScrollH: number; chatClientH: number; chatOverflowY: string
  input: Box; send: Box
  stripH: number; noticeH: number
}
// Скриптовете в браузъра са низове: tsx/esbuild добавя __name(...) към именуваните функции.
const readMetrics = (page: Page) => page.evaluate(`(() => {
  const screen = document.querySelector('[data-private-room-waiting-screen="1"]')
  const chat = document.querySelector('[data-private-waiting-chat-scroll="1"]')
  const box = (el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), hit: top === el || el.contains(top) }
  }
  const strip = document.querySelector('[data-voice-waiting-strip="1"]')
  const notice = document.querySelector('[data-private-room-partner-notice]')
  return {
    vh: window.innerHeight, vw: window.innerWidth,
    docScrollW: document.documentElement.scrollWidth,
    screenScrollH: screen.scrollHeight, screenClientH: screen.clientHeight, screenScrollTop: screen.scrollTop,
    chatScrollH: chat.scrollHeight, chatClientH: chat.clientHeight, chatOverflowY: getComputedStyle(chat).overflowY,
    input: box(document.querySelector('[data-private-waiting-chat-input="1"]')),
    send: box(document.querySelector('.prw-chat-send')),
    stripH: strip ? Math.round(strip.getBoundingClientRect().height) : 0,
    noticeH: notice ? Math.round(notice.getBoundingClientRect().height) : 0,
  }
})()`) as Promise<Metrics>

/** Потребителски скрол с колелцето над заглавието (не над чата). */
async function wheelToBottom(page: Page): Promise<void> {
  const title = await page.locator('.prw-title').boundingBox()
  await page.mouse.move(title ? title.x + 5 : 20, title ? title.y + 5 : 20)
  for (let i = 0; i < 12; i += 1) {
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(40)
  }
  await page.waitForTimeout(150)
}

let vite: ViteDevServer | null = null
let browser: Browser | null = null
console.log('\ncheckPrivateRoomWaitingLayout\n')
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()

  const viewports = [
    { label: 'desktop 1920x1080', width: 1920, height: 1080, mobile: false },
    { label: 'desktop 1366x657', width: 1366, height: 657, mobile: false },
    { label: 'desktop 1280x560', width: 1280, height: 560, mobile: false },
    { label: 'mobile 390x844', width: 390, height: 844, mobile: true },
    { label: 'mobile 375x560', width: 375, height: 560, mobile: true },
  ]
  for (const vp of viewports) {
    for (const voice of [false, true]) {
      for (const notice of [false, true]) {
        const label = `[${vp.label} | ${voice ? 'глас' : 'без глас'} | ${notice ? 'известие' : 'без известие'}]`
        const context = await browser.newContext(vp.mobile
          ? { viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
          : { viewport: { width: vp.width, height: vp.height } })
        const page = await context.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/privateRoomWaitingLayoutHarness.html`)
        await page.waitForFunction('window.__prwlHarness !== undefined', null, { timeout: 15_000 })
        await page.evaluate(`window.__prwlHarness.show(${JSON.stringify({ voice, notice, messages: 40 })})`)
        await page.locator('[data-private-waiting-chat-input="1"]').waitFor({ state: 'attached', timeout: 10_000 })
        if (voice) await page.locator('[data-voice-waiting-strip="1"] .pvs').waitFor({ state: 'visible', timeout: 5_000 })
        if (notice) await page.locator('[data-private-room-partner-notice="accepted"]').waitFor({ state: 'visible', timeout: 5_000 })
        await page.waitForTimeout(150)
        const before = await readMetrics(page)
        await wheelToBottom(page)
        const after = await readMetrics(page)

        await check(`${label} [L1] Полето и „Изпрати“ са достижими с колелцето и напълно видими`, async () => {
          for (const [name, b] of [['поле', after.input], ['Изпрати', after.send]] as const) {
            assert(b.top >= -1 && b.bottom <= after.vh + 1 && b.hit, `${name}: ${JSON.stringify(b)} vh=${after.vh} (strip=${after.stripH}, notice=${after.noticeH}, screen ${after.screenScrollH}/${after.screenClientH})`)
          }
        })
        await check(`${label} [L2] Съобщенията имат собствен скрол`, async () => {
          assert(after.chatOverflowY === 'auto' && after.chatScrollH > after.chatClientH + 20 && after.chatClientH >= 60, `chat ${after.chatScrollH}/${after.chatClientH} ${after.chatOverflowY}`)
        })
        await check(`${label} [L3] Вертикален скрол при нужда; без хоризонтален overflow`, async () => {
          const needs = before.screenScrollH > before.screenClientH + 1
          if (needs) assert(after.screenScrollTop > 0, `не скролва: ${JSON.stringify({ sh: before.screenScrollH, ch: before.screenClientH, top: after.screenScrollTop })}`)
          assert(before.screenClientH <= vp.height + 1, `екранът е по-висок от viewport-а: ${before.screenClientH} > ${vp.height}`)
          assert(after.docScrollW <= after.vw + 1, `хоризонтален overflow: ${after.docScrollW} > ${after.vw}`)
        })
        // [L5] Ново съобщение (прерисуване) не връща скролнатата чакалня най-горе.
        await page.evaluate('window.__prwlHarness.pushMessage(1000)')
        await page.waitForTimeout(100)
        const afterMessage = await readMetrics(page)
        const newMessageShown = await page.evaluate(`document.querySelector('[data-private-waiting-chat-scroll="1"]').textContent.includes('Ново 1000')`)
        await check(`${label} [L5] Ново съобщение не връща скрола на чакалнята най-горе; полето остава видимо`, async () => {
          assert(newMessageShown === true, 'новото съобщение липсва')
          assert(Math.abs(afterMessage.screenScrollTop - after.screenScrollTop) <= 1, `scrollTop ${after.screenScrollTop} -> ${afterMessage.screenScrollTop}`)
          assert(afterMessage.input.bottom <= afterMessage.vh + 1 && afterMessage.input.hit, `поле: ${JSON.stringify(afterMessage.input)}`)
        })
        await page.locator('[data-private-waiting-chat-input="1"]').click({ timeout: 3_000 }).catch(() => {})
        await page.keyboard.type('Здравей')
        const typed = await page.evaluate(`document.querySelector('[data-private-waiting-chat-input="1"]').value`)
        await check(`${label} [L4] Писането в полето работи; без грешки`, async () => {
          assert(typed === 'Здравей', `стойност: ${JSON.stringify(typed)}`)
          assert(errors.length === 0, errors.join(' | '))
        })
        await context.close()
      }
    }
  }
} finally {
  await browser?.close()
  await vite?.close()
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
