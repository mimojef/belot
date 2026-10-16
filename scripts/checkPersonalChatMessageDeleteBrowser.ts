/**
 * checkPersonalChatMessageDeleteBrowser.ts — изтриване на собствено лично
 * съобщение в /chat: кошче, потвърждение, обновяване на екрана.
 *
 * Реален браузър (Playwright) + реалния createLobbyFlowController и
 * renderLobbyScreen през Vite dev server; мрежовите callback-ове са stub-нати
 * (scripts/fixtures/chatMessageDeleteHarness.ts). Сървърната сигурност е в
 * server/scripts/checkPersonalChatOwnMessageDelete.ts.
 *
 *  [1]  Кошче само до собствените съобщения, с име/tooltip „Изтрий съобщението“
 *  [2]  Кошчето не променя ширината/подредбата на съобщението
 *  [3]  Десктоп: скрито без hover, видимо при посочване и при клавиатурен фокус;
 *       мобилен (без hover): видимо винаги
 *  [4]  Потвърждение с точния текст и бутони „Отказ“/„Изтрий“
 *  [5]  „Отказ“ — нищо не се случва
 *  [6]  Неуспех — грешка в попъпа, съобщението остава
 *  [7]  Успех — съобщението изчезва напълно, без заместител; preview-то се обновява
 *  [8]  Изтриване от друг таб (WS chat_message_deleted) — изчезва
 *  [9]  Пропуснато WS събитие + следващ refresh — изтритото не се връща
 *  [10] Клавиатура: Enter върху кошчето отваря потвърждението
 *  [11] Без JS грешки
 *
 * Пускане: npm run check:personal-chat-message-delete-browser
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
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
      if (address === null || typeof address === 'string') return reject(new Error('no port'))
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

const POPUP_TEXT = 'Искаш ли да изтриеш това съобщение? То ще бъде премахнато и за двамата участници.'
const transcript = (page: Page) => page.evaluate(() => document.querySelector('[data-chat-messages-scroll="1"]')?.textContent ?? '')
const popupVisible = (page: Page) => page.evaluate(() => document.querySelector('[data-chat-message-delete-confirm="1"]') !== null)
const deleteCalls = (page: Page) => page.evaluate(() => (window as any).__chatDeleteHarness.getDeleteCalls() as Array<{ messageId: string }>)
const trash = (page: Page, messageId: string) => page.locator(`[data-chat-message-delete="${messageId}"]`)
const opacityOf = (page: Page, messageId: string) =>
  page.evaluate((id) => Number(getComputedStyle(document.querySelector(`[data-chat-message-delete="${id}"]`)!).opacity), messageId)

async function waitForTranscript(page: Page, predicate: string, present: boolean): Promise<void> {
  await page.waitForFunction(
    ({ needle, want }) => (document.querySelector('[data-chat-messages-scroll="1"]')?.textContent ?? '').includes(needle) === want,
    { needle: predicate, want: present },
    { timeout: 5000 },
  )
}

async function runScenario(page: Page, label: string, isMobile: boolean): Promise<void> {
  await page.evaluate(() => (window as any).__chatDeleteHarness.openConversation())
  await waitForTranscript(page, 'Последното ми съобщение', true)

  await check(`${label} [0] изобразен е ${isMobile ? 'мобилният' : 'десктоп'} чат панел`, async () => {
    const height = await page.evaluate(() => document.querySelector<HTMLElement>('[data-chat-messages-scroll="1"]')?.style.height ?? '')
    assert(isMobile ? height === '360px' : height !== '360px', `scroll height style: ${height}`)
  })

  await check(`${label} [1] кошче само до собствените съобщения, с име и tooltip`, async () => {
    const info = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-chat-message-delete]')).map((b) => ({
      id: b.dataset.chatMessageDelete, aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), type: b.type,
    })))
    const ids = info.map((x) => x.id).sort().join()
    assert(ids === 'own-fail,own-last,own-old,own-silent,own-tab', `buttons: ${ids}`)
    assert(info.every((x) => x.aria === 'Изтрий съобщението' && x.title === 'Изтрий съобщението' && x.type === 'button'), JSON.stringify(info))
  })

  await check(`${label} [2] кошчето не променя ширината и подредбата`, async () => {
    const result = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-chat-message-delete="own-last"]')!
      const wrapper = button.parentElement!
      const before = wrapper.getBoundingClientRect()
      const position = getComputedStyle(button).position
      const placeholder = document.createComment('x')
      button.replaceWith(placeholder)
      const after = wrapper.getBoundingClientRect()
      placeholder.replaceWith(button)
      return { position, dw: Math.abs(before.width - after.width), dh: Math.abs(before.height - after.height), dx: Math.abs(before.left - after.left) }
    })
    assert(result.position === 'absolute' && result.dw < 0.5 && result.dh < 0.5 && result.dx < 0.5, JSON.stringify(result))
  })

  await check(`${label} [3] видимост: ${isMobile ? 'без hover — видимо винаги' : 'скрито → hover/фокус видимо'}`, async () => {
    await page.mouse.move(1, 1)
    const idle = await opacityOf(page, 'own-old')
    if (isMobile) {
      const noHover = await page.evaluate(() => matchMedia('(hover: none)').matches)
      assert(noHover && idle > 0.5, `mobile opacity ${idle}, hover:none=${noHover}`)
    } else {
      assert(idle === 0, `idle opacity ${idle}`)
      await page.locator('[data-chat-message="own-old"]').hover()
      await page.waitForTimeout(250)
      const hovered = await opacityOf(page, 'own-old')
      assert(hovered === 1, `hover opacity ${hovered}`)
      await page.mouse.move(1, 1)
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-chat-message-delete="own-tab"]')!.focus())
      await page.waitForTimeout(250)
      const focused = await opacityOf(page, 'own-tab')
      assert(focused === 1, `focus opacity ${focused}`)
    }
  })

  await check(`${label} [4] потвърждение с точния текст и бутони`, async () => {
    await trash(page, 'own-old').click()
    await page.waitForSelector('[data-chat-message-delete-confirm="1"]')
    const text = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? '')
    assert(text.includes(POPUP_TEXT), `popup: ${text}`)
    const cancel = await page.locator('[data-chat-message-delete-cancel="1"]').innerText()
    const confirm = await page.locator('[data-chat-message-delete-confirm="1"]').innerText()
    assert(cancel.trim() === 'Отказ' && confirm.trim() === 'Изтрий', `${cancel}/${confirm}`)
  })

  await check(`${label} [5] „Отказ“ — нищо не се случва`, async () => {
    await page.locator('[data-chat-message-delete-cancel="1"]').click()
    assert(!(await popupVisible(page)), 'popup closed')
    assert((await deleteCalls(page)).length === 0, 'no delete call')
    assert((await transcript(page)).includes('Моето старо съобщение'), 'message kept')
  })

  await check(`${label} [6] неуспех — грешка, съобщението остава`, async () => {
    await trash(page, 'own-fail').click()
    await page.locator('[data-chat-message-delete-confirm="1"]').click()
    await page.waitForFunction(() => (document.querySelector('[role="alert"]')?.textContent ?? '').includes('Симулирана грешка'), undefined, { timeout: 5000 })
    assert(await popupVisible(page), 'popup stays open with the error')
    assert((await transcript(page)).includes('Това изтриване ще се провали'), 'message kept after failure')
    await page.locator('[data-chat-message-delete-cancel="1"]').click()
    assert((await transcript(page)).includes('Това изтриване ще се провали'), 'still kept after closing')
  })

  await check(`${label} [7] успех — изчезва напълно, без заместител; preview обновено`, async () => {
    await trash(page, 'own-last').click()
    await page.locator('[data-chat-message-delete-confirm="1"]').click()
    await waitForTranscript(page, 'Последното ми съобщение', false)
    assert(!(await popupVisible(page)), 'popup closed')
    const text = await transcript(page)
    assert(!/Изтрито съобщение|изтрито съобщение/.test(text), 'no placeholder')
    const calls = await deleteCalls(page)
    assert(calls.some((c) => c.messageId === 'own-last'), JSON.stringify(calls))
    assert(await page.locator('[data-chat-message="own-last"]').count() === 0 || isMobile, 'node removed')
    if (!isMobile) {
      const preview = await page.evaluate(() => document.querySelector('[data-lobby-chat-conversation="friendship-a"]')?.textContent ?? '')
      assert(preview.includes('Изтрито, докато нямаше връзка') && !preview.includes('Последното ми съобщение'), `preview: ${preview}`)
    }
  })

  await check(`${label} [8] изтриване от друг таб (WS) — изчезва`, async () => {
    await page.evaluate(() => (window as any).__chatDeleteHarness.deleteFromOtherTab('own-tab'))
    await waitForTranscript(page, 'Изтрито от друг таб', false)
  })

  await check(`${label} [9] пропуснато WS събитие + refresh — изтритото не се връща`, async () => {
    await page.evaluate(() => (window as any).__chatDeleteHarness.deleteSilentlyThenIncoming('own-silent'))
    await waitForTranscript(page, 'Ново от Anna', true)
    const text = await transcript(page)
    assert(!text.includes('Изтрито, докато нямаше връзка'), 'reconciled')
    assert(text.includes('Моето старо съобщение') && text.includes('Съобщение от Anna'), 'other messages kept')
  })

  await check(`${label} [10] клавиатура: Enter върху кошчето отваря потвърждението`, async () => {
    await trash(page, 'own-old').focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-chat-message-delete-confirm="1"]', { timeout: 3000 })
    await page.locator('[data-chat-message-delete-confirm="1"]').click()
    await waitForTranscript(page, 'Моето старо съобщение', false)
  })

  await check(`${label} [12] закъсняла история не възстановява изтрито съобщение`, async () => {
    await page.evaluate(() => (window as any).__chatDeleteHarness.holdHistoryRefresh())
    await page.waitForFunction(() => (window as any).__chatDeleteHarness.hasHeldHistory())
    await page.evaluate(() => (window as any).__chatDeleteHarness.deleteFromOtherTab('own-fail'))
    await waitForTranscript(page, 'Това изтриване ще се провали', false)
    await page.evaluate(() => (window as any).__chatDeleteHarness.releaseHistory())
    // Allow the held response and its render to finish before inspecting the DOM.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert(!(await transcript(page)).includes('Това изтриване ще се провали'), 'stale history restored the deletion')
  })

  await check(`${label} [13] закъснял списък не възстановява изтрито preview`, async () => {
    await page.evaluate(() => (window as any).__chatDeleteHarness.holdConversationRefresh())
    await page.waitForFunction(() => (window as any).__chatDeleteHarness.hasHeldConversations())
    await page.evaluate(() => {
      const harness = (window as any).__chatDeleteHarness
      harness.deleteFromOtherTab(harness.getServerMessageIds().at(-1))
    })
    await waitForTranscript(page, 'Ново от Anna', false)
    await page.evaluate(() => (window as any).__chatDeleteHarness.releaseConversations())
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const text = await page.locator('body').innerText()
    assert(!text.includes('Ново от Anna'), 'stale list restored the deleted preview')
  })
}

console.log('\ncheckPersonalChatMessageDeleteBrowser\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/chatMessageDeleteHarness.html`
  browser = await chromium.launch()

  for (const [label, contextOptions, isMobile] of [
    ['[desktop]', { viewport: { width: 1400, height: 900 } }, false],
    ['[mobile]', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, true],
  ] as const) {
    const context = await browser.newContext(contextOptions)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__chatDeleteHarness !== undefined, undefined, { timeout: 10_000 })
    await runScenario(page, label, isMobile)
    await check(`${label} [11] без JS грешки`, () => assert(errors.length === 0, errors.join(' | ')))
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
