/**
 * checkTopicsComposerVipGate.ts
 *
 * Етап 2 — client-side composer/VIP gate/realtime merge поведение за "Теми".
 * Реален браузър (Playwright) + реален production код (createLobbyFlowController
 * + renderLobbyScreen + renderTopicsScreen + renderVipRequiredPopup), зареден
 * през Vite dev server (без build, без jsdom). Мрежовите/WS callback-ове са
 * stub-нати (виж scripts/fixtures/topicsComposerVipGateHarness.ts) — тестът
 * контролира ръчно VIP gate статус, claim резултат, и симулира WS съобщения
 * директно през controller.handleServerMessage(), точно както main.ts би го
 * извикал при реален WS push.
 *
 * [1]  Non-VIP: composer textarea е readonly + form маркиран vip-locked
 * [2]  Non-VIP tap върху composer-а НЕ focus-ва textarea-та (интерцепция
 *      преди focus/mobile keyboard), отваря VIP popup вместо това
 * [3]  VIP (isActive=true): composer НЕ е readonly/vip-locked, нормално поле
 * [4]  Non-VIP, никога не е claim-вал: popup показва "Вземи 30 дни безплатно"
 * [5]  Успешен launch gift claim → popup затваря, composer веднага usable
 *      (без reload/навигация — чист state update)
 * [6]  Non-VIP, вече claim-нал (VIP изтекъл): popup показва "Виж VIP плановете"
 * [7]  "Виж VIP плановете" клик → inert "ще бъдат налични скоро" съобщение,
 *      БЕЗ навигация/checkout
 * [8]  Успешен send (echo с matching requestId) чисти draft-а
 * [9]  Неуспешен send (error с matching requestId) ЗАПАЗВА draft-а + показва грешка
 * [10] Draft НЕ се чисти по body match — само по requestId (Етап 2 корекция т.4):
 *      съобщение със СЪЩИЯ текст но РАЗЛИЧЕН requestId не чисти draft-а
 * [11] Draft preservation per topic — A→B→A с недовършен текст в A се пази
 * [12] Gap-closing subscribe: subscribe_topic_messages се извиква СЛЕД REST
 *      load с afterSeq = seq-а на последното заредено съобщение (Етап 2 корекция т.1)
 * [13] Topic switch: unsubscribe от старата тема се извиква ПРЕДИ subscribe към новата
 * [14] vip_required грешка от сървъра при send → отваря VIP flow-а веднага,
 *      БЕЗ page reload (Етап 2 корекция т.5)
 * [15] No auto-resend след disconnect: setConnected(false) освобождава pending
 *      state-а на composer-а, draft-ът остава непокътнат, БЕЗ нов send call
 * [16] requestId е уникален при всеки submit (никога не се преизползва)
 * [17] Live-append near-bottom auto-scroll: потребител близо до дъното + ново
 *      съобщение → scroll до дъното
 * [18] Live-append: потребител scroll-нал нагоре + ново съобщение → НЕ се
 *      дърпа насила надолу (append без forced scroll)
 * [19] Merge dedupe по messageId: catch-up съобщение със същия messageId като
 *      вече показано не създава дубликат в stream-а
 * [20] Няма JS грешки в конзолата по време на сценария
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
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Не успях да намеря свободен порт.'))
        return
      }
      const { port } = address
      srv.close(() => resolvePort(port))
    })
  })
}

// ─── Harness action helpers (page.evaluate wrappers) ───────────────────────

async function openTopicsScreen(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.openTopicsScreen())
}
async function clickTopicChip(page: Page, topicId: string): Promise<void> {
  await page.evaluate((id) => (window as any).__topicsComposerVipGateHarness.clickTopicChip(id), topicId)
}
async function setVipGate(page: Page, isActive: boolean, hasClaimedLaunchGift: boolean): Promise<void> {
  await page.evaluate(
    ([a, b]) => (window as any).__topicsComposerVipGateHarness.setVipGate(a, b),
    [isActive, hasClaimedLaunchGift],
  )
}
async function setClaimResult(page: Page, result: { ok: true; isActive: boolean } | { ok: false; alreadyClaimed: boolean }): Promise<void> {
  await page.evaluate((r) => (window as any).__topicsComposerVipGateHarness.setClaimResult(r), result)
}
async function setNextMessagesResult(page: Page, messages: unknown[], hasMore = false): Promise<void> {
  await page.evaluate(
    ([m, h]) => (window as any).__topicsComposerVipGateHarness.setNextMessagesResult(m, h),
    [messages, hasMore] as [unknown[], boolean],
  )
}
async function makeMessage(page: Page, topicId: string, seq: number, body: string, senderProfileId = 'someone', senderDisplayName = 'Someone'): Promise<any> {
  return page.evaluate(
    ([t, s, b, p, d]) => (window as any).__topicsComposerVipGateHarness.makeMessage(t, s, b, p, d),
    [topicId, seq, body, senderProfileId, senderDisplayName] as [string, number, string, string, string],
  )
}
async function getSubscribeLog(page: Page): Promise<Array<{ topicId: string; afterSeq: number }>> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getSubscribeLog())
}
async function getUnsubscribeLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getUnsubscribeLog())
}
async function getSendLog(page: Page): Promise<Array<{ topicId: string; body: string; requestId: string }>> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getSendLog())
}
async function simulateServerMessage(page: Page, message: Record<string, unknown>): Promise<void> {
  await page.evaluate((m) => (window as any).__topicsComposerVipGateHarness.simulateServerMessage(m), message)
}
async function getComposerValue(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getComposerValue())
}
async function isComposerReadonly(page: Page): Promise<boolean | null> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.isComposerReadonly())
}
async function isComposerVipLocked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.isComposerVipLocked())
}
async function setComposerValue(page: Page, value: string): Promise<void> {
  await page.evaluate((v) => (window as any).__topicsComposerVipGateHarness.setComposerValue(v), value)
}
async function submitComposerForm(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.submitComposerForm())
}
async function clickComposerTextarea(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.clickComposerTextarea())
}
async function isComposerTextareaFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.isComposerTextareaFocused())
}
async function isVipPopupOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.isVipPopupOpen())
}
async function getVipPopupText(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getVipPopupText())
}
async function clickVipPopupClaim(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.clickVipPopupClaim())
}
async function clickVipPopupSeePlans(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.clickVipPopupSeePlans())
}
async function clickVipPopupClose(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.clickVipPopupClose())
}
async function getVisibleMessageBodies(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getVisibleMessageBodies())
}
async function getComposerErrorText(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getComposerErrorText())
}
async function getMessagesScrollTop(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getMessagesScrollTop())
}
async function getMessagesScrollHeight(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getMessagesScrollHeight())
}
async function setMessagesScrollTop(page: Page, value: number): Promise<void> {
  await page.evaluate((v) => (window as any).__topicsComposerVipGateHarness.setMessagesScrollTop(v), value)
}
async function setConnected(page: Page, value: boolean): Promise<void> {
  await page.evaluate((v) => (window as any).__topicsComposerVipGateHarness.controller.setConnected(v), value)
}

async function openTopicsAndWaitComposer(page: Page, vipActive: boolean, hasClaimedLaunchGift: boolean, messages: unknown[] = []): Promise<void> {
  await setVipGate(page, vipActive, hasClaimedLaunchGift)
  await setNextMessagesResult(page, messages)
  await openTopicsScreen(page)
  await page.waitForSelector('[data-topics-composer-form="1"]', { state: 'attached' })
  await page.waitForTimeout(60) // ensureTopicsVipGateLoaded + REST load резолват async
}

console.log('\ncheckTopicsComposerVipGate\n')

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
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicsComposerVipGateHarness.html`

  browser = await chromium.launch()
  const context: BrowserContext = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const page = await context.newPage()
  const consoleErrors: string[] = []
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  await page.goto(baseUrl)
  await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined, undefined, { timeout: 10_000 })

  await check('[1] Non-VIP: composer textarea readonly + form vip-locked', async () => {
    await openTopicsAndWaitComposer(page, false, false)
    assertEqual(await isComposerReadonly(page), true, 'textarea readonly')
    assertEqual(await isComposerVipLocked(page), true, 'form vip-locked')
  })

  await check('[2] Non-VIP tap НЕ focus-ва textarea, отваря VIP popup', async () => {
    await openTopicsAndWaitComposer(page, false, false)
    await clickComposerTextarea(page)
    await page.waitForTimeout(30)
    assertEqual(await isComposerTextareaFocused(page), false, 'textarea НЕ трябва да получи focus')
    assertEqual(await isVipPopupOpen(page), true, 'VIP popup трябва да се отвори')
    await clickVipPopupClose(page)
  })

  await check('[3] VIP: composer НЕ е readonly/vip-locked', async () => {
    await openTopicsAndWaitComposer(page, true, true)
    assertEqual(await isComposerReadonly(page), false, 'textarea НЕ трябва да е readonly')
    assertEqual(await isComposerVipLocked(page), false, 'form НЕ трябва да е vip-locked')
  })

  await check('[4] Non-VIP, никога не claim-вал: popup показва "Вземи 30 дни безплатно"', async () => {
    await openTopicsAndWaitComposer(page, false, false)
    await clickComposerTextarea(page)
    await page.waitForTimeout(30)
    const text = await getVipPopupText(page)
    assert(text !== null && text.includes('Вземи 30 дни безплатно'), `popup текст: ${text}`)
    assert(text !== null && text.includes('Pika.bg ви подарява 30 дни безплатен VIP'), `popup текст: ${text}`)
    await clickVipPopupClose(page)
  })

  await check('[5] Успешен launch gift claim → popup затваря, composer веднага usable', async () => {
    await openTopicsAndWaitComposer(page, false, false)
    await setClaimResult(page, { ok: true, isActive: true })
    await clickComposerTextarea(page)
    await page.waitForTimeout(30)
    await clickVipPopupClaim(page)
    await page.waitForTimeout(50)
    assertEqual(await isVipPopupOpen(page), false, 'popup трябва да се затвори')
    assertEqual(await isComposerReadonly(page), false, 'composer трябва да е веднага usable')
  })

  await check('[6] Non-VIP, вече claim-нал (изтекъл VIP): popup показва "Виж VIP плановете"', async () => {
    await openTopicsAndWaitComposer(page, false, true)
    await clickComposerTextarea(page)
    await page.waitForTimeout(30)
    const text = await getVipPopupText(page)
    assert(text !== null && text.includes('Виж VIP плановете'), `popup текст: ${text}`)
    assert(text !== null && !text.includes('Вземи 30 дни безплатно'), 'НЕ трябва повторно да предлага launch gift')
    await clickVipPopupClose(page)
  })

  await check('[7] "Виж VIP плановете" → inert "ще бъдат налични скоро", БЕЗ навигация', async () => {
    await openTopicsAndWaitComposer(page, false, true)
    const urlBefore = page.url()
    await clickComposerTextarea(page)
    await page.waitForTimeout(30)
    await clickVipPopupSeePlans(page)
    await page.waitForTimeout(30)
    const text = await getVipPopupText(page)
    assert(text !== null && text.includes('VIP плановете ще бъдат налични скоро'), `popup текст: ${text}`)
    assertEqual(page.url(), urlBefore, 'URL не трябва да се промени')
    await clickVipPopupClose(page)
  })

  let capturedRequestId = ''

  await check('[8] Успешен send (echo с matching requestId) чисти draft-а', async () => {
    await openTopicsAndWaitComposer(page, true, true)
    await setComposerValue(page, 'Здравей от VIP')
    await submitComposerForm(page)
    await page.waitForTimeout(30)
    const sendLog = await getSendLog(page)
    assert(sendLog.length === 1 && sendLog[0]!.body === 'Здравей от VIP', 'send-ът трябва да е регистриран веднъж')
    capturedRequestId = sendLog[0]!.requestId
    assert(capturedRequestId.length > 0, 'requestId трябва да е непразен')

    const echo = await makeMessage(page, 'topic-general', 1, 'Здравей от VIP', 'me', 'Me')
    await simulateServerMessage(page, { ...echo, type: 'topic_message', requestId: capturedRequestId })
    await page.waitForTimeout(30)
    assertEqual(await getComposerValue(page), '', 'draft трябва да се изчисти след успешен echo')
  })

  await check('[9] Неуспешен send (error с matching requestId) ЗАПАЗВА draft-а + показва грешка', async () => {
    await openTopicsAndWaitComposer(page, true, true)
    await setComposerValue(page, 'Опит за грешка')
    await submitComposerForm(page)
    await page.waitForTimeout(30)
    const sendLog = await getSendLog(page)
    const requestId = sendLog[sendLog.length - 1]!.requestId

    await simulateServerMessage(page, { type: 'topic_message_error', code: 'rate_limited', message: 'Твърде много съобщения.', requestId })
    await page.waitForTimeout(30)
    assertEqual(await getComposerValue(page), 'Опит за грешка', 'draft НЕ трябва да се изчисти при грешка')
    const errorText = await getComposerErrorText(page)
    assert(errorText !== null && errorText.includes('Твърде много съобщения'), `error текст: ${errorText}`)
  })

  await check('[10] Draft НЕ се чисти по body match — само по requestId', async () => {
    await openTopicsAndWaitComposer(page, true, true)
    await setComposerValue(page, 'Уникален текст 12345')
    await submitComposerForm(page)
    await page.waitForTimeout(30)

    // Симулираме ЧУЖДО live съобщение със СЪЩИЯ текст, но НЕ-matching requestId
    // (напр. друг потребител случайно е написал същото) — draft-ът НЕ трябва
    // да се третира като "моят pending send успя" само защото текстовете съвпадат.
    const foreignEcho = await makeMessage(page, 'topic-general', 2, 'Уникален текст 12345', 'somebody-else', 'Somebody Else')
    await simulateServerMessage(page, { ...foreignEcho, type: 'topic_message', requestId: 'completely-different-request-id' })
    await page.waitForTimeout(30)
    assertEqual(await getComposerValue(page), 'Уникален текст 12345', 'draft НЕ трябва да се чисти по body match')
  })

  await check('[11] Draft preservation per topic — A→B→A пази недовършения текст', async () => {
    await openTopicsAndWaitComposer(page, true, true)
    await setComposerValue(page, 'чернова в Общ чат')
    await setNextMessagesResult(page, [])
    await clickTopicChip(page, 'topic-b')
    await page.waitForTimeout(40)
    assertEqual(await getComposerValue(page), '', 'нова тема трябва да стартира с празен draft')
    await setComposerValue(page, 'чернова в Тема Б')
    await setNextMessagesResult(page, [])
    await clickTopicChip(page, 'topic-general')
    await page.waitForTimeout(40)
    assertEqual(await getComposerValue(page), 'чернова в Общ чат', 'draft-ът от Общ чат трябва да е запазен')
  })

  await check('[12] Gap-closing subscribe: afterSeq = seq на последното REST-заредено съобщение', async () => {
    const msg = await makeMessage(page, 'topic-general', 42, 'последно съобщение')
    await openTopicsAndWaitComposer(page, true, true, [msg])
    const log = await getSubscribeLog(page)
    const last = log[log.length - 1]
    assert(last !== undefined && last.topicId === 'topic-general' && last.afterSeq === 42, `последен subscribe: ${JSON.stringify(last)}`)
  })

  await check('[13] Topic switch: unsubscribe от старата тема се извиква преди subscribe към новата', async () => {
    await openTopicsAndWaitComposer(page, true, true, [])
    await setNextMessagesResult(page, [])
    await clickTopicChip(page, 'topic-b')
    await page.waitForTimeout(40)
    const unsub = await getUnsubscribeLog(page)
    assert(unsub.includes('topic-general'), `unsubscribe log: ${JSON.stringify(unsub)}`)
    const sub = await getSubscribeLog(page)
    assert(sub.some((s) => s.topicId === 'topic-b'), `subscribe log: ${JSON.stringify(sub)}`)
  })

  await check('[14] vip_required от сървъра при send → отваря VIP flow веднага, без reload', async () => {
    await openTopicsAndWaitComposer(page, true, true)
    const urlBefore = page.url()
    await setComposerValue(page, 'опит след изтекъл VIP')
    await submitComposerForm(page)
    await page.waitForTimeout(30)
    const sendLog = await getSendLog(page)
    const requestId = sendLog[sendLog.length - 1]!.requestId

    await setVipGate(page, false, true) // re-fetch-ът, който контролерът тригерва, ще върне това
    await simulateServerMessage(page, { type: 'topic_message_error', code: 'vip_required', message: 'VIP изтекъл.', requestId })
    await page.waitForTimeout(50)
    assertEqual(await isVipPopupOpen(page), true, 'VIP popup трябва да се отвори автоматично')
    assertEqual(page.url(), urlBefore, 'без page reload/навигация')
  })

  await check('[15] No auto-resend след disconnect: pending state освободен, draft запазен, без нов send', async () => {
    await clickVipPopupClose(page)
    await openTopicsAndWaitComposer(page, true, true)
    await setComposerValue(page, 'изгубен ack текст')
    await submitComposerForm(page)
    await page.waitForTimeout(20)
    const sendCountBefore = (await getSendLog(page)).length

    await setConnected(page, false)
    await page.waitForTimeout(20)
    await setConnected(page, true)
    await page.waitForTimeout(50)

    const sendCountAfter = (await getSendLog(page)).length
    assertEqual(sendCountAfter, sendCountBefore, 'НЕ трябва да има автоматичен повторен send call')
    assertEqual(await getComposerValue(page), 'изгубен ack текст', 'draft-ът трябва да остане непокътнат')
  })

  await check('[16] requestId е уникален при всеки submit', async () => {
    await openTopicsAndWaitComposer(page, true, true)
    await setComposerValue(page, 'първо')
    await submitComposerForm(page)
    await page.waitForTimeout(20)
    await setComposerValue(page, 'второ')
    await submitComposerForm(page)
    await page.waitForTimeout(20)
    const log = await getSendLog(page)
    const ids = new Set(log.map((e) => e.requestId))
    assertEqual(ids.size, log.length, 'всеки send трябва да носи уникален requestId')
  })

  await check('[17] Live-append near-bottom auto-scroll: близо до дъното → ново съобщение скролва до дъното', async () => {
    const initial = await makeMessage(page, 'topic-general', 1, 'първо съобщение')
    await openTopicsAndWaitComposer(page, true, true, [initial])
    const scrollHeightBefore = await getMessagesScrollHeight(page)
    assert(scrollHeightBefore !== null, 'message stream трябва да има измерима височина')

    const live = await makeMessage(page, 'topic-general', 2, 'ново live съобщение')
    await simulateServerMessage(page, { ...live, type: 'topic_message' })
    await page.waitForTimeout(30)

    const scrollTop = await getMessagesScrollTop(page)
    const scrollHeight = await getMessagesScrollHeight(page)
    const clientHeight = await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getMessagesClientHeight())
    assert(scrollTop !== null && scrollHeight !== null, 'scroll позицията трябва да е измерима')
    assert(
      (scrollHeight! - scrollTop! - (clientHeight ?? 0)) < 4,
      `трябва да е близо до дъното след live append: scrollTop=${scrollTop}, scrollHeight=${scrollHeight}`,
    )
  })

  await check('[18] Live-append: scroll-нал нагоре → ново съобщение НЕ дърпа насила надолу', async () => {
    const messages = Array.from({ length: 20 }, (_v, i) => null)
    const built: any[] = []
    for (let i = 0; i < 20; i++) built.push(await makeMessage(page, 'topic-general', i + 1, `съобщение ${i + 1}`))
    void messages
    await openTopicsAndWaitComposer(page, true, true, built)

    await setMessagesScrollTop(page, 0) // качваме се в самия връх
    await page.waitForTimeout(20)
    const scrollTopBefore = await getMessagesScrollTop(page)

    const live = await makeMessage(page, 'topic-general', 21, 'ново съобщение докато чета стари')
    await simulateServerMessage(page, { ...live, type: 'topic_message' })
    await page.waitForTimeout(30)

    const scrollTopAfter = await getMessagesScrollTop(page)
    assertEqual(scrollTopAfter, scrollTopBefore, 'НЕ трябва да бъде издърпан надолу, докато чете стари съобщения')
    const bodies = await getVisibleMessageBodies(page)
    assert(bodies.some((b) => b.includes('ново съобщение докато чета стари')), 'новото съобщение трябва да е append-нато в DOM-а (макар и извън изгледа)')
  })

  await check('[19] Merge dedupe по messageId: catch-up с вече показан messageId не дублира', async () => {
    const existing = await makeMessage(page, 'topic-general', 5, 'вече видяно съобщение')
    await openTopicsAndWaitComposer(page, true, true, [existing])
    const countBefore = (await getVisibleMessageBodies(page)).length

    await simulateServerMessage(page, { type: 'topic_message_catchup', topicId: 'topic-general', messages: [existing], truncated: false })
    await page.waitForTimeout(30)

    const countAfter = (await getVisibleMessageBodies(page)).length
    assertEqual(countAfter, countBefore, 'catch-up с познат messageId не трябва да добавя дубликат')
  })

  await check('[20] Няма JS грешки в конзолата по време на сценария', () => {
    assert(consoleErrors.length === 0, `Конзолни грешки: ${consoleErrors.join(' | ')}`)
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
