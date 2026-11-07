/**
 * checkProfileCustomizationDisplayUi.ts
 *
 * "Персонализация на профила", Етап 3 — реален браузър (Playwright) върху
 * РЕАЛНИТЕ функции за рендериране:
 *   * Лафче, публикации и отговори в Теми — десктоп (тъмен) и новия мобилен
 *     (светъл) интерфейс: стандартни цветове (стар/нов), закупен цвят,
 *     емоджи пред/след/двете, комбинация от четирите, служебна роля,
 *     изтекла екстра, ограничен изглед, escape/безопасност, клик -> профил,
 *     изтичане по време на сесията (пренарисуване без polling);
 *   * личния (VIP) чат на десктоп и светлия мобилен чат;
 *   * попъпа след Stripe: проверка, забавен webhook, "Провери отново",
 *     успех / удължаване / замяна, детайли (цена, срок, дата), един общ
 *     преглед, отказ/refund, еднократност, светла тема.
 *
 * Употреба (от корена):
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkProfileCustomizationDisplayUi.ts [--screenshots=<dir>]
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
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

function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      srv.close(() => resolveFree(address.port))
    })
  })
}

const screenshotDir = process.argv.slice(2).find((arg) => arg.startsWith('--screenshots='))?.slice('--screenshots='.length) ?? null

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString()
const PAST = new Date(Date.now() - 86_400_000).toISOString()
const NOW = new Date().toISOString()

type Display = Record<string, string | boolean | null>
function disp(values: { nicknameColor?: string; messageColor?: string; emojiBefore?: string; emojiAfter?: string }, until = FUTURE, standardDefaults = true): Display {
  return {
    nicknameColor: values.nicknameColor ?? null,
    nicknameColorUntil: values.nicknameColor ? until : null,
    messageColor: values.messageColor ?? null,
    messageColorUntil: values.messageColor ? until : null,
    emojiBefore: values.emojiBefore ?? null,
    emojiBeforeUntil: values.emojiBefore ? until : null,
    emojiAfter: values.emojiAfter ?? null,
    emojiAfterUntil: values.emojiAfter ? until : null,
    standardDefaults,
  }
}

let seq = 0
function msg(caseKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1
  return {
    case: caseKey,
    seq,
    messageId: `m-${caseKey}`,
    topicId: 'topic-x',
    parentMessageId: null,
    senderProfileId: `author-${caseKey}`,
    senderDisplayName: 'Автор<b>',
    senderAvatarUrl: null,
    senderRole: 'player',
    senderNameHighlightRole: null,
    body: 'Текст с връзка https://pika.bg/topics',
    createdAt: NOW,
    lastActivityAt: NOW,
    unreadCount: 0,
    replyCount: 0,
    likeCount: 0,
    viewerHasLiked: false,
    editedAt: null,
    attachment: null,
    isTopicsSectionMuted: false,
    ...extra,
  }
}

const CASES = [
  msg('off'),
  msg('empty', { senderCustomization: disp({}) }),
  msg('nick', { senderCustomization: disp({ nicknameColor: '#4A67F7' }) }),
  msg('before', { senderCustomization: disp({ emojiBefore: '🦋' }) }),
  msg('after', { senderCustomization: disp({ emojiAfter: '🦋' }) }),
  msg('both', { senderCustomization: disp({ emojiBefore: '🦋', emojiAfter: '🦋' }) }),
  msg('all', { senderCustomization: disp({ nicknameColor: '#4A67F7', messageColor: '#1B8648', emojiBefore: '🦋', emojiAfter: '🌸' }) }),
  msg('staff', { senderNameHighlightRole: 'marketing', senderCustomization: disp({ nicknameColor: '#4A67F7', emojiAfter: '👑' }) }),
  msg('expired', { senderCustomization: disp({ nicknameColor: '#4A67F7', emojiBefore: '🦋' }, PAST) }),
  msg('restricted', { senderCustomization: disp({ emojiBefore: '🦋' }, FUTURE, false) }),
  msg('unsafe', { senderCustomization: { ...disp({ nicknameColor: 'red;background:url(x)' }), emojiBefore: '<img src=x onerror="window.__xss=1">', emojiBeforeUntil: FUTURE } }),
]

const RGB = {
  white: 'rgb(255, 255, 255)',
  black: 'rgb(0, 0, 0)',
  legacyGold: 'rgb(201, 168, 76)',
  legacyLight: 'rgb(23, 35, 60)',
  blue: 'rgb(74, 103, 247)',
  green: 'rgb(27, 134, 72)',
  pink: 'rgb(247, 37, 133)',
  bodyDark: 'rgb(226, 232, 240)',
  bodyLight: 'rgb(17, 24, 39)',
  purple: 'rgb(155, 75, 234)',
}

console.log('\ncheckProfileCustomizationDisplayUi')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/profileCustomizationDisplayHarness.html`
  browser = await chromium.launch()

  async function openPage(mobile: boolean): Promise<{ page: Page; errors: string[] }> {
    const context = await browser!.newContext(mobile
      ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'bg-BG', timezoneId: 'Europe/Sofia' }
      : { viewport: { width: 1280, height: 900 }, locale: 'bg-BG', timezoneId: 'Europe/Sofia' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__displayHarness !== undefined, undefined, { timeout: 20_000 })
    return { page, errors }
  }

  async function shot(page: Page, name: string): Promise<void> {
    if (screenshotDir === null) return
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true })
  }

  const nameButton = (page: Page, caseKey: string, kind: string) => page.locator(`[data-case="${caseKey}"] [data-kind="${kind}"] .topic-message-author-meta button[data-topic-message-author]`).first()
  const colorOf = (locator: ReturnType<Page['locator']>) => locator.evaluate((el) => getComputedStyle(el).color)
  const bodyColor = (page: Page, caseKey: string, kind: string) => page.locator(`[data-case="${caseKey}"] [data-kind="${kind}"] a[href*="pika.bg/topics"]`).first().evaluate((el) => getComputedStyle(el.parentElement as HTMLElement).color)

  for (const mobile of [false, true]) {
    const label = mobile ? 'мобилен (светъл)' : 'десктоп (тъмен)'
    const { page, errors } = await openPage(mobile)
    await page.evaluate((cases) => (window as any).__displayHarness.renderTopics(cases), CASES)
    console.log(`\n[T] Лафче / публикации / отговори — ${label}`)
    const defaultName = mobile ? RGB.black : RGB.white
    const legacyName = mobile ? RGB.legacyLight : RGB.legacyGold
    const defaultBody = mobile ? RGB.bodyLight : RGB.bodyDark

    await check(`[T1 ${label}] Изключена функция (без поле): досегашните цветове на ника и текста`, async () => {
      for (const kind of ['lafche', 'root', 'reply']) {
        assert(await colorOf(nameButton(page, 'off', kind)) === legacyName, `${kind} ник`)
        assert(await bodyColor(page, 'off', kind) === defaultBody, `${kind} текст`)
      }
    })

    await check(`[T2 ${label}] Включена, без покупка: стандартен ${mobile ? 'черен' : 'бял'} ник; текстът — стандартният`, async () => {
      for (const kind of ['lafche', 'root', 'reply']) {
        assert(await colorOf(nameButton(page, 'empty', kind)) === defaultName, `${kind}`)
        assert(await bodyColor(page, 'empty', kind) === defaultBody, `${kind} текст`)
      }
    })

    await check(`[T3 ${label}] Закупен цвят на ника — точно HEX стойността`, async () => {
      for (const kind of ['lafche', 'root', 'reply']) assert(await colorOf(nameButton(page, 'nick', kind)) === RGB.blue, kind)
    })

    await check(`[T4 ${label}] Емоджи пред / след / двете; името (атрибутите за профила) не се променя`, async () => {
      for (const kind of ['lafche', 'root', 'reply']) {
        assert((await nameButton(page, 'before', kind).innerText()).trim() === '🦋 Автор<b>', `${kind} пред`)
        assert((await nameButton(page, 'after', kind).innerText()).trim() === 'Автор<b> 🦋', `${kind} след`)
        assert((await nameButton(page, 'both', kind).innerText()).trim() === '🦋 Автор<b> 🦋', `${kind} двете`)
        assert(await nameButton(page, 'both', kind).getAttribute('data-topic-message-author-name') === 'Автор<b>', `${kind} атрибут`)
        assert(await nameButton(page, 'both', kind).getAttribute('data-topic-message-author') === 'author-both', `${kind} профил`)
      }
    })

    await check(`[T5 ${label}] Четирите екстри заедно: цвят на ника + цвят на текста + двете емоджита; връзката остава връзка`, async () => {
      for (const kind of ['lafche', 'root', 'reply']) {
        assert(await colorOf(nameButton(page, 'all', kind)) === RGB.blue, `${kind} ник`)
        assert((await nameButton(page, 'all', kind).innerText()).trim() === '🦋 Автор<b> 🌸', `${kind} емоджи`)
        assert(await bodyColor(page, 'all', kind) === RGB.green, `${kind} текст`)
        assert(await page.locator(`[data-case="all"] [data-kind="${kind}"] a[href*="pika.bg/topics"]`).count() === 1, `${kind} връзка`)
      }
    })

    await check(`[T6 ${label}] Служебна роля (marketing): #F72585 има приоритет пред закупения цвят; емоджито се показва`, async () => {
      for (const kind of ['lafche', 'root', 'reply']) {
        assert(await colorOf(nameButton(page, 'staff', kind)) === RGB.pink, kind)
        assert((await nameButton(page, 'staff', kind).innerText()).includes('👑'), `${kind} емоджи`)
      }
    })

    await check(`[T7 ${label}] Изтекла екстра -> стандартният вид; ограничен изглед -> досегашен цвят + платеното емоджи`, async () => {
      for (const kind of ['lafche', 'root', 'reply']) {
        assert(await colorOf(nameButton(page, 'expired', kind)) === defaultName && (await nameButton(page, 'expired', kind).innerText()).trim() === 'Автор<b>', `${kind} изтекла`)
        assert(await colorOf(nameButton(page, 'restricted', kind)) === legacyName && (await nameButton(page, 'restricted', kind).innerText()).trim() === '🦋 Автор<b>', `${kind} ограничен`)
      }
    })

    await check(`[T8 ${label}] Небезопасни стойности се отхвърлят (няма HTML/CSS инжекция); името е escape-нато`, async () => {
      assert(await page.locator('[data-case="unsafe"] img').count() === 0, 'img')
      assert(await page.evaluate(() => (window as any).__xss) === undefined, 'xss')
      assert(await colorOf(nameButton(page, 'unsafe', 'lafche')) === defaultName, 'невалиден цвят -> стандартен')
      assert(await page.locator('[data-case="off"] b').count() === 0, 'името не е HTML')
    })

    await shot(page, mobile ? 'mobile-topics' : 'desktop-topics')
    assert(errors.length === 0, errors.join(' | '))
  }

  console.log('\n[S] Изтичане по време на сесията')

  await check('[S1] Екстра изтича докато страницата е отворена -> едно пренарисуване в момента на изтичане, без polling', async () => {
    const { page } = await openPage(false)
    const soon = new Date(Date.now() + 1500).toISOString()
    await page.evaluate((cases) => (window as any).__displayHarness.renderTopics(cases), [msg('soon', { senderCustomization: disp({ nicknameColor: '#4A67F7', emojiAfter: '🦋' }, soon) })])
    assert(await colorOf(nameButton(page, 'soon', 'lafche')) === RGB.blue, 'преди')
    const before = await page.evaluate(() => (window as any).__displayHarness.renderCount())
    await page.waitForTimeout(2600)
    const after = await page.evaluate(() => (window as any).__displayHarness.renderCount())
    assert(after - before === 1, `пренарисувания ${after - before}`)
    assert(await colorOf(nameButton(page, 'soon', 'lafche')) === RGB.white && (await nameButton(page, 'soon', 'lafche').innerText()).trim() === 'Автор<b>', 'след')
    await page.waitForTimeout(1200)
    assert(await page.evaluate(() => (window as any).__displayHarness.renderCount()) === after, 'без повторни таймери')
  })

  console.log('\n[C] Лични чатове')

  const conversation = (customized: boolean) => ({
    friendshipId: 'f-1',
    friend: { profileId: 'friend-1', displayName: 'Приятел', avatarUrl: null, isOnline: true },
    friendIsPikaTeam: false,
    friendNameHighlightRole: null,
    ...(customized ? {
      friendCustomization: disp({ nicknameColor: '#4A67F7', messageColor: '#1B8648', emojiBefore: '🦋', emojiAfter: '🦋' }),
      viewerCustomization: disp({ messageColor: '#9B4BEA' }),
    } : {}),
    lastMessage: null,
    updatedAt: NOW,
    unreadCount: 0,
    kind: 'vip_dm',
    isArchived: false,
    clearedByDisplayName: null,
  })
  const chatMessages = [
    { messageId: 'c-1', friendshipId: 'f-1', senderProfileId: 'friend-1', isOwnMessage: false, body: 'от приятел', createdAt: NOW, attachment: null },
    { messageId: 'c-2', friendshipId: 'f-1', senderProfileId: 'viewer', isOwnMessage: true, body: 'мое съобщение', createdAt: NOW, attachment: null },
  ]
  const textColor = (page: Page, scope: string, text: string) => page.locator(`[data-kind="${scope}"]`).getByText(text, { exact: true }).first().evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement
    return getComputedStyle(node).color
  })
  const headerName = (page: Page, scope: string, decorated = true) => page.locator(`[data-kind="${scope}"]`).getByText(decorated ? '🦋 Приятел 🦋' : 'Приятел', { exact: true }).first()

  await check('[C1] Десктоп VIP чат: ник на събеседника (цвят + емоджита) в заглавието; текстът му в закупения цвят; собствените златисти балончета — без промяна', async () => {
    const { page, errors } = await openPage(false)
    await page.evaluate(({ c, m }) => (window as any).__displayHarness.renderPersonalChat(c, m), { c: conversation(true), m: chatMessages })
    const header = headerName(page, 'desktop-chat')
    assert((await header.innerText()).trim() === '🦋 Приятел 🦋' && await colorOf(header) === RGB.blue, `${await header.innerText()} ${await colorOf(header)}`)
    assert(await textColor(page, 'desktop-chat', 'от приятел') === RGB.green, 'текст на събеседника')
    assert(await textColor(page, 'desktop-chat', 'мое съобщение') === 'rgb(8, 8, 8)', 'собствено (златист фон)')
    await shot(page, 'desktop-chat')
    assert(errors.length === 0, errors.join(' | '))
  })

  await check('[C2] Мобилен (светъл) чат: заглавие с цвят и емоджита; текстът на събеседника и собственият — в закупените цветове', async () => {
    const { page, errors } = await openPage(true)
    await page.evaluate(({ c, m }) => (window as any).__displayHarness.renderPersonalChat(c, m), { c: conversation(true), m: chatMessages })
    const header = headerName(page, 'mobile-chat')
    assert((await header.innerText()).trim() === '🦋 Приятел 🦋' && await colorOf(header) === RGB.blue, `${await header.innerText()} ${await colorOf(header)}`)
    assert(await textColor(page, 'mobile-chat', 'от приятел') === RGB.green, 'събеседник')
    assert(await textColor(page, 'mobile-chat', 'мое съобщение') === RGB.purple, 'собствено')
    await shot(page, 'mobile-chat')
    assert(errors.length === 0, errors.join(' | '))
  })

  await check('[C3] Изключена функция: личните чатове изглеждат постарому', async () => {
    const { page } = await openPage(false)
    await page.evaluate(({ c, m }) => (window as any).__displayHarness.renderPersonalChat(c, m), { c: conversation(false), m: chatMessages })
    const header = headerName(page, 'desktop-chat', false)
    assert((await header.innerText()).trim() === 'Приятел' && await colorOf(header) === 'rgb(248, 250, 252)', 'заглавие')
    assert(await textColor(page, 'desktop-chat', 'от приятел') === 'rgb(248, 250, 252)', 'текст')
  })

  console.log('\n[P] Попъп след Stripe')

  type PopupScenario = { status: number; body: Record<string, unknown> }
  const activeNew = {
    nickname_color: { itemId: 'blue-1', value: '#2B74D9', label: 'Синьо', activeUntil: FUTURE, remainingDays: 90 },
    message_color: null,
    emoji_before: { itemId: 'e1', value: '🦋', label: null, activeUntil: FUTURE, remainingDays: 30 },
    emoji_after: { itemId: 'e2', value: '🦋', label: null, activeUntil: FUTURE, remainingDays: 30 },
  }
  const purchase = (status: string, grantEffect: string | null, extra: Record<string, unknown> = {}) => ({
    purchaseId: 'p-1', kind: 'nickname_color', kindLabel: 'Цвят на никнейма', itemType: 'color', itemValue: '#2B74D9', itemLabel: 'Синьо',
    days: 90, priceCents: 597, currency: 'EUR', status, grantEffect, grantedUntil: '2027-02-05T12:00:00.000Z', creditedAt: NOW, ...extra,
  })
  const ok = (returnPurchase: unknown, active: unknown = activeNew): PopupScenario => ({ status: 200, body: { ok: true, active, returnPurchase } })

  async function openPopup(mobile: boolean, sessionId: string | null, responses: PopupScenario[], role: string | null = null): Promise<{ page: Page; calls: () => number; setResponses: (r: PopupScenario[]) => void }> {
    const { page } = await openPage(mobile)
    let queue = [...responses]
    let calls = 0
    await page.route('**/api/profile-customization**', async (route: Route) => {
      calls += 1
      const next = queue.length > 1 ? queue.shift()! : queue[0]!
      await route.fulfill({ status: next.status, contentType: 'application/json', body: JSON.stringify(next.body) })
    })
    await page.evaluate(({ id, theme, r }) => (window as any).__displayHarness.showPopup(id, theme, r), { id: sessionId, theme: mobile ? 'light' : 'dark', r: role })
    return { page, calls: () => calls, setResponses: (r) => { queue = [...r] } }
  }
  const popupState = (page: Page) => page.locator('#pcp-title').getAttribute('data-pcp-state')
  const row = (page: Page, key: string) => page.locator(`[data-pcp-row="${key}"]`).innerText()

  await check('[P1] Забавен webhook: "Проверяваме плащането..." -> после "Успешна покупка!" с точните данни и един общ преглед; само бутон "ОК"', async () => {
    const { page } = await openPopup(false, 'cs_p1', [ok(purchase('pending', null)), ok(purchase('pending', null)), ok(purchase('paid', 'new'))])
    assert((await page.locator('#pcp-title').innerText()) === 'Проверяваме плащането...', 'проверка')
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'success', undefined, { timeout: 15_000 })
    assert((await page.locator('#pcp-title').innerText()) === 'Успешна покупка!', 'заглавие')
    assert((await page.locator('[data-pcp-dialog="1"]').innerText()).includes('Персонализацията ти е активирана.'), 'подзаглавие')
    assert((await row(page, 'kind')).includes('Цвят на никнейма'), 'покупка')
    assert((await row(page, 'item')).includes('Синьо (#2B74D9)'), 'цвят')
    assert((await row(page, 'days')).includes('90 дни'), 'период')
    assert(/5,97\s€/.test(await row(page, 'price')), 'цена')
    assert((await row(page, 'until')).includes('05.02.2027'), 'дата')
    assert((await row(page, 'effect')).includes('Нова покупка'), 'вид')
    assert(await page.locator('[data-pc-unified-preview="1"]').count() === 1, 'един общ преглед')
    assert((await page.locator('[data-pc-unified-preview="1"] [data-pc-preview-name="1"]').evaluate((el) => (el.parentElement as HTMLElement).innerText)).trim() === '🦋 Мишо 🦋', 'ник с двете емоджита')
    assert(await colorOf(page.locator('[data-pc-preview-name="1"]')) === 'rgb(43, 116, 217)', 'цвят в прегледа')
    assert((await page.locator('[data-pc-preview-label="1"]').innerText()).toLowerCase() === 'цвят на текст за писане', 'надпис')
    assert((await page.locator('[data-pc-preview-message="1"]').innerText()) === 'Здравейте на всички! 😊', 'съобщение')
    assert(await page.locator('#profile-customization-purchase-popup button').count() === 1, 'само "ОК"')
    assert(await page.evaluate(() => (window as any).__displayHarness.wasShown('cs_p1')), 'отбелязано като показано')
    await shot(page, 'popup-success-desktop')
    await page.locator('[data-pcp-ok="1"]').click()
    assert(await page.locator('#profile-customization-purchase-popup').count() === 0, 'затворен')
  })

  await check('[P2] Удължаване: "Персонализацията ти е удължена!" + новата крайна дата', async () => {
    const { page } = await openPopup(false, 'cs_p2', [ok(purchase('paid', 'extend', { grantedUntil: '2027-05-06T12:00:00.000Z' }))])
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'success')
    assert((await page.locator('#pcp-title').innerText()) === 'Персонализацията ти е удължена!', 'заглавие')
    assert((await row(page, 'effect')).includes('Удължаване') && (await row(page, 'until')).includes('06.05.2027'), 'вид/дата')
  })

  await check('[P3] Замяна: показва новата активна персонализация, не старата', async () => {
    const { page } = await openPopup(false, 'cs_p3', [ok(purchase('paid', 'replace'))])
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'success')
    assert((await row(page, 'effect')).includes('Замяна'), 'вид')
    assert(await colorOf(page.locator('[data-pc-preview-name="1"]')) === 'rgb(43, 116, 217)', 'новият цвят')
  })

  await check('[P4] Служебна роля: #F72585 има приоритет и в прегледа', async () => {
    const { page } = await openPopup(false, 'cs_p4', [ok(purchase('paid', 'new'))], 'pika_team')
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'success')
    assert(await colorOf(page.locator('[data-pc-preview-name="1"]')) === RGB.pink, 'розово')
  })

  await check('[P5] Webhook не идва: след автоматичните опити — "Провери отново" (без фалшив успех/отказ); ръчната проверка показва успеха', async () => {
    const { page } = await openPage(false)
    await page.clock.install()
    let paid = false
    await page.route('**/api/profile-customization**', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ok(purchase(paid ? 'paid' : 'pending', paid ? 'new' : null)).body) })
    })
    await page.evaluate(() => (window as any).__displayHarness.showPopup('cs_p5', 'dark', null))
    for (let i = 0; i < 20; i++) await page.clock.runFor(2_100)
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'waiting')
    assert(await page.locator('[data-pcp-retry="1"]').count() === 1 && await page.locator('[data-pc-unified-preview="1"]').count() === 0, 'без преглед/успех')
    assert(!(await page.evaluate(() => (window as any).__displayHarness.wasShown('cs_p5'))), 'не е отбелязано (информацията не се губи)')
    paid = true
    await page.locator('[data-pcp-retry="1"]').click()
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'success')
  })

  await check('[P6] Отказано плащане и възстановено плащане: съобщение без визуализация', async () => {
    const canceled = await openPopup(false, null, [ok(null)])
    assert(await popupState(canceled.page) === 'canceled' && await canceled.page.locator('[data-pc-unified-preview="1"]').count() === 0 && canceled.calls() === 0, 'отказано, без заявка')
    const refunded = await openPopup(false, 'cs_p6', [ok(purchase('refunded', null))])
    await refunded.page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'refunded')
    assert(await refunded.page.locator('[data-pc-unified-preview="1"]').count() === 0, 'без преглед')
    const notPaid = await openPopup(false, 'cs_p6b', [ok(purchase('canceled', null))])
    await notPaid.page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'not_paid')
  })

  await check('[P7] Сървърна грешка -> "Няма връзка" + "Провери отново" (поръчката остава запомнена)', async () => {
    const { page, setResponses } = await openPopup(false, 'cs_p7', [{ status: 500, body: { ok: false } }])
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'error')
    setResponses([ok(purchase('paid', 'new'))])
    await page.locator('[data-pcp-retry="1"]').click()
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'success')
  })

  await check('[P8] Еднократност: чакащата поръчка се помни до показване на резултата; после не се показва отново', async () => {
    const { page } = await openPage(false)
    await page.evaluate(() => (window as any).__displayHarness.rememberPending('cs_p8'))
    assert(await page.evaluate(() => (window as any).__displayHarness.getPending()) === 'cs_p8', 'запомнена')
    await page.route('**/api/profile-customization**', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ok(purchase('paid', 'new')).body) }))
    await page.evaluate(() => (window as any).__displayHarness.showPopup('cs_p8', 'dark', null))
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'success')
    assert(await page.evaluate(() => (window as any).__displayHarness.getPending()) === null, 'изчистена след показване')
    await page.evaluate(() => (window as any).__displayHarness.rememberPending('cs_p8'))
    assert(await page.evaluate(() => (window as any).__displayHarness.getPending()) === null, 'не се показва повторно при презареждане')
  })

  await check('[P9] Мобилен (светъл) попъп: светъл фон и преглед; стандартен черен ник без закупен цвят', async () => {
    const onlyEmoji = { nickname_color: null, message_color: null, emoji_before: { itemId: 'e1', value: '🦋', label: null, activeUntil: FUTURE, remainingDays: 30 }, emoji_after: null }
    const { page } = await openPopup(true, 'cs_p9', [ok(purchase('paid', 'new', { kind: 'emoji_before', kindLabel: 'Емоджи пред никнейма', itemType: 'emoji', itemValue: '🦋', itemLabel: null }), onlyEmoji)])
    await page.waitForFunction(() => document.querySelector('#pcp-title')?.getAttribute('data-pcp-state') === 'success')
    assert(await page.locator('[data-pcp-dialog="1"]').evaluate((el) => getComputedStyle(el).backgroundColor) === 'rgb(255, 255, 255)', 'светъл фон')
    assert(await colorOf(page.locator('[data-pc-preview-name="1"]')) === RGB.black, 'черен ник')
    assert((await row(page, 'item')).includes('🦋'), 'емоджи')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert(overflow <= 0, `хоризонтално превъртане ${overflow}`)
    await shot(page, 'popup-success-mobile')
  })
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
