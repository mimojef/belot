/**
 * checkChatDraftPreserved.ts
 *
 * Regression check за production бъг: в личния чат между потребители на
 * Pika.bg, докато потребителят пишеше съобщение, недовършеният текст
 * изчезваше при input arriving/фонови обновявания.
 *
 * Root cause: renderLobbyScreen() презарежда ЦЕЛИЯ lobby screen чрез
 * `root.innerHTML = ...` при всеки render() (виж createLobbyFlowController.ts,
 * стотици call sites). Полето за чат съобщение (`<input name="message">`)
 * нямаше `value` обвързан към state и не се пазеше фокус/каретата — така
 * всеки re-render (напр. chat_message_received за активния разговор, виж
 * refreshChatAfterNotification()) заменяше DOM възела с чисто нов, без
 * написания текст.
 *
 * Fix: `state.chatDraftByFriendshipId` (createLobbyFlowController.ts) пази
 * недовършения текст per-friendshipId; renderLobbyScreen.ts рендира
 * `value="${...}"` от него И пази focus/caret преди/след innerHTML replace
 * (същия established pattern като players search инпута, виж prevSearchEl/
 * wasSearchFocused). Черновата се изчиства САМО след потвърден успех от
 * сървъра (в sendChatMessage, след `result.ok`) — submit handler-ът вече не
 * чисти полето оптимистично, за да не изгуби текста при неуспешно изпращане.
 *
 * Реален браузър (Playwright) + реален production код (createLobbyFlowController
 * + renderLobbyScreen), зареден през Vite dev server (без build, без jsdom —
 * jsdom не е налична зависимост в проекта). Мрежовите callback-ове са stub-нати
 * (виж scripts/fixtures/chatDraftHarness.ts) — самият бъг е чисто client-side
 * rendering проблем и не зависи от реален backend/WebSocket.
 *
 * Покрива:
 *  [1]  Недовършена чернова оцелява при входящо съобщение в АКТИВНИЯ разговор
 *  [2]  Фокусът и каретата в полето се пазят след re-render-а
 *  [3]  Входящото съобщение реално се появява в transcript-а (не е "изгубено")
 *  [4]  Чернова в разговор А оцелява при входящо съобщение в РАЗЛИЧЕН разговор Б
 *       (unread badge update / несвързано фоново обновяване)
 *  [5]  Успешно изпращане изчиства полето (и само тогава)
 *  [5b] Неуспешно изпращане (сървърна грешка) НЕ изчиства полето — текстът
 *       остава за retry, черновата не се губи преди резултатът да е известен
 *  [6]  Смяна на разговор и връщане пази отделните чернови per-conversation
 *       (не изтича между разговори, не се смесва с чужд разговор)
 *  [7]  Изпратеното съобщение отива в правилния разговор (без cross-talk)
 *  [8]  Същото поведение на mobile viewport/touch layout
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
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
      if (address === null || typeof address === 'string') {
        reject(new Error('Не успях да намеря свободен порт.'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

const CHAT_INPUT_SELECTOR = '[data-lobby-chat-message-input="1"]'

async function getActiveElementSelectorMatches(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el !== null && document.activeElement === el
  }, selector)
}

async function openConversation(page: Page, friendshipId: string): Promise<void> {
  await page.evaluate((fid) => {
    ;(window as any).__chatDraftHarness.openConversation(fid)
  }, friendshipId)
  await page.waitForSelector(CHAT_INPUT_SELECTOR, { state: 'attached' })
}

async function deliverIncomingMessage(page: Page, friendshipId: string, body: string): Promise<void> {
  await page.evaluate(
    ({ fid, b }) => {
      ;(window as any).__chatDraftHarness.deliverIncomingMessage(fid, b)
    },
    { fid: friendshipId, b: body },
  )
}

async function triggerUnrelatedBackgroundRender(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__chatDraftHarness.triggerUnrelatedBackgroundRender()
  })
}

async function transcriptText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-chat-messages-scroll="1"]')
    return scroll?.textContent ?? ''
  })
}

async function runScenario(page: Page, label: string): Promise<void> {
  // ─── [1]-[3] Чернова в активния разговор + входящо съобщение в него ──────
  await openConversation(page, 'friendship-a')
  const input = page.locator(CHAT_INPUT_SELECTOR)
  await input.click()
  const draftText = 'Здравей, тъкмо ти пишех нещо дълго и не искам да го загубя'
  await input.type(draftText, { delay: 5 })
  await check(`${label} [1] Чернова оцелява при входящо съобщение в активния разговор`, async () => {
    await deliverIncomingMessage(page, 'friendship-a', 'Здрасти! Как си?')
    // handleServerMessage тригерира асинхронен refreshChatAfterNotification —
    // изчакваме реалния re-render (входящото съобщение да се появи в transcript-а).
    await page.waitForFunction(
      (needle) => (document.querySelector('[data-chat-messages-scroll="1"]')?.textContent ?? '').includes(needle),
      'Здрасти! Как си?',
      { timeout: 5000 },
    )
    const value = await input.inputValue()
    assert(value === draftText, `Черновата трябваше да остане "${draftText}", а е "${value}"`)
  })

  await check(`${label} [2] Фокус/каретата в полето се пазят след re-render`, async () => {
    const stillFocused = await getActiveElementSelectorMatches(page, CHAT_INPUT_SELECTOR)
    assert(stillFocused, 'Полето за писане трябваше да остане фокусирано след re-render-а')
  })

  await check(`${label} [3] Входящото съобщение реално се вижда в transcript-а`, async () => {
    const text = await transcriptText(page)
    assert(text.includes('Здрасти! Как си?'), 'Входящото съобщение трябваше да е видимо в разговора')
  })

  // ─── [4] Несвързано фоново обновяване (друг разговор + generic render) ───
  await check(`${label} [4] Чернова оцелява при съобщение в ДРУГ разговор + generic background render`, async () => {
    await deliverIncomingMessage(page, 'friendship-b', 'Съобщение в друг разговор')
    await triggerUnrelatedBackgroundRender(page)
    await page.waitForTimeout(50)
    const value = await input.inputValue()
    assert(value === draftText, `Черновата не трябваше да бъде засегната от друг разговор, а е "${value}"`)
  })

  // ─── [5] Успешно изпращане изчиства полето ────────────────────────────────
  await check(`${label} [5] Успешно изпращане изчиства полето`, async () => {
    await page.locator('[data-lobby-chat-form] button[type="submit"]').click()
    await page.waitForFunction(
      (needle) => (document.querySelector('[data-chat-messages-scroll="1"]')?.textContent ?? '').includes(needle),
      draftText,
      { timeout: 5000 },
    )
    const value = await input.inputValue()
    assert(value === '', `Полето трябваше да е празно след изпращане, а е "${value}"`)
  })

  // ─── [5b] Неуспешно изпращане НЕ изчиства полето (текстът остава за retry) ──
  await check(`${label} [5b] Неуспешно изпращане не изчиства полето`, async () => {
    const failingDraft = 'Този текст не трябва да се изгуби __FAIL_SEND__'
    await input.click()
    await input.type(failingDraft, { delay: 5 })
    await page.locator('[data-lobby-chat-form] button[type="submit"]').click()
    // Изчакваме sendChatMessage(ok:false) да приключи и да рендира грешката —
    // чак тогава е сигурно, че евентуално (грешно) изчистване вече би се случило.
    await page.waitForFunction(
      () => document.body.textContent?.includes('Симулирана грешка при изпращане.') ?? false,
      undefined,
      { timeout: 5000 },
    )
    const value = await page.locator(CHAT_INPUT_SELECTOR).inputValue()
    assert(value === failingDraft, `Полето трябваше да запази "${failingDraft}" при неуспех, а е "${value}"`)
  })
  await page.locator(CHAT_INPUT_SELECTOR).fill('')

  // ─── [6]-[7] Смяна на разговор пази отделни чернови, без cross-talk ──────
  const draftA2 = 'Втора чернова за Anna'
  const draftB = 'Чернова за Boris'
  await input.click()
  await input.type(draftA2, { delay: 5 })

  await openConversation(page, 'friendship-b')
  await check(`${label} [6a] Нов разговор не наследява чернова от предишния`, async () => {
    const value = await page.locator(CHAT_INPUT_SELECTOR).inputValue()
    assert(value === '', `Разговорът с Boris не трябваше да съдържа чернова на Anna, а съдържа "${value}"`)
  })

  await page.locator(CHAT_INPUT_SELECTOR).click()
  await page.locator(CHAT_INPUT_SELECTOR).type(draftB, { delay: 5 })

  await openConversation(page, 'friendship-a')
  await check(`${label} [6b] Връщане към предишния разговор връща неговата чернова`, async () => {
    const value = await page.locator(CHAT_INPUT_SELECTOR).inputValue()
    assert(value === draftA2, `Очаквах запазена чернова "${draftA2}", получих "${value}"`)
  })

  await openConversation(page, 'friendship-b')
  await check(`${label} [6c] Другата чернова също е запазена (не се е изгубила при превключването)`, async () => {
    const value = await page.locator(CHAT_INPUT_SELECTOR).inputValue()
    assert(value === draftB, `Очаквах запазена чернова "${draftB}", получих "${value}"`)
  })

  await check(`${label} [7] Изпратеното съобщение отива в правилния разговор (без cross-talk)`, async () => {
    await page.locator('[data-lobby-chat-form] button[type="submit"]').click()
    await page.waitForFunction(
      (needle) => (document.querySelector('[data-chat-messages-scroll="1"]')?.textContent ?? '').includes(needle),
      draftB,
      { timeout: 5000 },
    )
    const bText = await transcriptText(page)
    assert(bText.includes(draftB), 'Съобщението до Boris трябваше да е в неговия разговор')

    await openConversation(page, 'friendship-a')
    const aText = await transcriptText(page)
    assert(!aText.includes(draftB), 'Съобщението до Boris не трябваше да се появи в разговора с Anna')
    const value = await page.locator(CHAT_INPUT_SELECTOR).inputValue()
    assert(value === draftA2, `Черновата за Anna трябваше да остане "${draftA2}", получих "${value}"`)
  })
}

console.log('\ncheckChatDraftPreserved\n')

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

  // ─── Desktop ──────────────────────────────────────────────────────────────
  const desktopContext: BrowserContext = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const desktopPage = await desktopContext.newPage()
  const desktopErrors: string[] = []
  desktopPage.on('pageerror', (err) => desktopErrors.push(err.message))
  await desktopPage.goto(baseUrl)
  await desktopPage.waitForFunction(() => (window as any).__chatDraftHarness !== undefined, undefined, { timeout: 10_000 })
  await runScenario(desktopPage, '[desktop]')
  await check('[desktop] Няма JS грешки в конзолата по време на сценария', () => {
    assert(desktopErrors.length === 0, `Конзолни грешки: ${desktopErrors.join(' | ')}`)
  })
  await desktopContext.close()

  // ─── Mobile (touch viewport — isPhoneLayoutViewport() трябва да върне true) ──
  const mobileContext: BrowserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const mobilePage = await mobileContext.newPage()
  const mobileErrors: string[] = []
  mobilePage.on('pageerror', (err) => mobileErrors.push(err.message))
  await mobilePage.goto(baseUrl)
  await mobilePage.waitForFunction(() => (window as any).__chatDraftHarness !== undefined, undefined, { timeout: 10_000 })
  await runScenario(mobilePage, '[mobile]')
  await check('[mobile] Няма JS грешки в конзолата по време на сценария', () => {
    assert(mobileErrors.length === 0, `Конзолни грешки: ${mobileErrors.join(' | ')}`)
  })
  await mobileContext.close()
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
