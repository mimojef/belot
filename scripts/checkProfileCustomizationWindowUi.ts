/**
 * checkProfileCustomizationWindowUi.ts
 *
 * "Персонализация на профила", Етап 2 — реален браузър (Playwright) върху
 * прозореца "Персонализация" (тъмен десктоп и светъл мобилен вариант).
 * /api/profile-customization се обслужва в теста от РЕАЛНИЯ
 * profileCustomizationStore (временна база с всички миграции) — същата
 * логика като route-а в index.ts (preview, задължително потвърждение при
 * замяна, pending поръчка). Stripe не се вика: checkoutUrl е фиктивен, а
 * "webhook-ът" е store.fulfillPaidPurchase. HTTP/webhook/флагът са покрити
 * от server/scripts/checkProfileCustomizationCheckoutWebhookHttp.ts.
 *
 * Употреба (от корена):
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkProfileCustomizationWindowUi.ts [--screenshots=<dir>]
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureServerDatabaseReady } from '../server/src/db/ensureServerDatabaseReady.js'
import { createProfileCustomizationStore, type ProfileCustomizationFailure } from '../server/src/profileCustomization/profileCustomizationStore.js'
import {
  PROFILE_CUSTOMIZATION_COLOR_GROUPS,
  PROFILE_CUSTOMIZATION_COLOR_GROUP_LABELS,
  PROFILE_CUSTOMIZATION_DURATION_DAYS,
  PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES,
  PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_ICONS,
  PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_LABELS,
} from '../server/src/profileCustomization/profileCustomizationCatalog.js'

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

console.log('\ncheckProfileCustomizationWindowUi')

// ─── Реален store върху временна база ──────────────────────────────────────
const tempRoot = await mkdtemp(join(tmpdir(), 'belot-customization-window-ui-'))
await mkdir(join(tempRoot, 'database', 'migrations'), { recursive: true })
await mkdir(join(tempRoot, 'database', 'data'), { recursive: true })
const migrationsSource = resolve('server', 'database', 'migrations')
for (const name of await readdir(migrationsSource)) {
  if (name.endsWith('.sql')) await cp(join(migrationsSource, name), join(tempRoot, 'database', 'migrations', name))
}
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: tempRoot })
const store = await createProfileCustomizationStore(databaseFilePath)
const sqliteModule = await import('node:sqlite')
const db = new sqliteModule.DatabaseSync(databaseFilePath, { open: true })

const profileId = randomUUID()
{
  const accountId = randomUUID()
  db.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, 'window@example.test')
  db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES (?, ?, 'Мишо', 'мишо');`).run(profileId, accountId)
  for (const kind of ['nickname_color', 'message_color', 'emoji_before']) store.updateKindSettings(kind, { salesEnabled: true })
}

const checkoutRequests: Array<Record<string, unknown>> = []
let sessionCounter = 0

function failureStatus(result: ProfileCustomizationFailure): number {
  return result.code === 'not_found' ? 404 : result.code === 'duplicate' ? 409 : 400
}

// Огледало на handleProfileCustomizationRequest (без Stripe).
async function serveApi(route: Route): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const json = (status: number, payload: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
  if (request.method() === 'GET' && url.pathname === '/api/profile-customization') {
    const sessionId = url.searchParams.get('sessionId')
    const returnPurchase = sessionId ? store.findProfilePurchaseByCheckoutSessionId(profileId, sessionId) : null
    return json(200, {
      ok: true,
      kinds: store.listKindSettings(),
      colors: store.listColors(),
      emojis: store.listEmojis(),
      colorGroups: PROFILE_CUSTOMIZATION_COLOR_GROUPS.map((key) => ({ key, label: PROFILE_CUSTOMIZATION_COLOR_GROUP_LABELS[key] })),
      emojiCategories: PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES.map((key) => ({ key, label: PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_LABELS[key], icon: PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_ICONS[key] })),
      durations: PROFILE_CUSTOMIZATION_DURATION_DAYS,
      active: store.getProfileActiveItems(profileId),
      serverNow: new Date().toISOString(),
      returnPurchase: returnPurchase === null ? null : { purchaseId: returnPurchase.purchaseId, kind: returnPurchase.kind, itemValue: returnPurchase.itemValue, days: returnPurchase.days, status: returnPurchase.status, grantEffect: returnPurchase.grantEffect, grantedUntil: returnPurchase.grantedUntil },
    })
  }
  if (request.method() === 'POST' && url.pathname === '/api/profile-customization/checkout') {
    const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>
    checkoutRequests.push(body)
    const input = { profileId, kind: String(body.kind), itemId: String(body.itemId), days: typeof body.days === 'number' ? body.days : Number.NaN }
    const preview = store.previewPurchase(input)
    if (!preview.ok) return json(failureStatus(preview), preview)
    if (preview.preview.effect === 'replace' && body.acknowledgeReplace !== true) {
      return json(409, { ok: false, code: 'replace_confirmation_required', message: 'Потвърди замяната.', preview: preview.preview })
    }
    const pending = store.createPendingPurchase(input)
    if (!pending.ok) return json(failureStatus(pending), pending)
    sessionCounter += 1
    const sessionId = `cs_window_${sessionCounter}`
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)
    return json(200, { ok: true, checkoutUrl: `https://checkout.stripe.test/${sessionId}`, checkoutSessionId: sessionId, purchaseId: pending.purchase.purchaseId, priceCents: pending.purchase.priceCents })
  }
  return json(404, { ok: false, message: 'Not found' })
}

/** "Webhook": потвърждава последната поръчка по session id. */
function payWebhook(sessionId: string): void {
  const purchase = store.findByCheckoutSessionId(sessionId)
  if (purchase === null) throw new Error(`няма поръчка за ${sessionId}`)
  const result = store.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId: purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: purchase.priceCents, stripePaymentIntentId: `pi_${sessionId}` })
  if (!result.ok) throw new Error(result.message)
}

let vite: ViteDevServer | null = null
let browser: Browser | null = null
const windowEl = (page: Page) => page.locator('#profile-customization-window')

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/profileCustomizationWindowHarness.html`
  browser = await chromium.launch()

  async function openWindow(viewport: { width: number; height: number }, theme: 'dark' | 'light', stripeReturn: unknown = null): Promise<{ page: Page; errors: string[] }> {
    const context = await browser!.newContext({ viewport, hasTouch: theme === 'light', isMobile: theme === 'light', locale: 'bg-BG', timezoneId: 'Europe/Sofia' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/api/profile-customization**', serveApi)
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__customizationHarness !== undefined, undefined, { timeout: 15_000 })
    await page.evaluate(({ t, r }) => (window as any).__customizationHarness.open(t, r), { t: theme, r: stripeReturn })
    await page.locator('[data-pc-section="nickname_color"]').waitFor({ timeout: 10_000 })
    return { page, errors }
  }

  async function shot(page: Page, name: string): Promise<void> {
    if (screenshotDir === null) return
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true })
  }

  // ЕДИН общ преглед (Етап 3) — параметърът е само за четимост на старите проверки.
  const previewNameColor = (page: Page, _sample: 'dark' | 'light') => page.locator('[data-pc-unified-preview="1"] [data-pc-preview-name="1"]').evaluate((el) => getComputedStyle(el).color)
  const navigations = (page: Page) => page.evaluate(() => (window as any).__customizationHarness.navigations() as string[])

  const { page, errors } = await openWindow({ width: 1280, height: 900 }, 'dark')

  console.log('\n[D] Десктоп (тъмна тема)')

  await check('[D1] 4 секции, отворена е само първата; стандартен преглед: бяло на тъмен фон, черно на светъл; името е escape-нато', async () => {
    assert(await page.locator('[data-pc-section]').count() === 4, 'секции')
    assert(await page.locator('[data-pc-panel]').count() === 1 && await page.locator('[data-pc-panel="nickname_color"]').count() === 1, 'отворена е само първата')
    assert(await previewNameColor(page, 'dark') === 'rgb(255, 255, 255)', 'бяло')
    assert(await page.locator('[data-pc-unified-preview="1"]').count() === 1, 'точно един общ преглед')
    assert((await page.locator('[data-pc-preview-label="1"]').innerText()).toLowerCase() === 'цвят на текст за писане', 'надпис')
    assert((await page.locator('[data-pc-preview-message="1"]').innerText()) === 'Здравейте на всички! 😊', 'примерно съобщение')
    assert((await page.locator('[data-pc-preview-name="1"]').first().innerText()) === 'Мишо<b>', 'escape')
    assert(await page.locator('[data-pc-swatch]').count() === 21, 'квадратчета')
    await shot(page, 'desktop-initial')
  })

  await check('[D2] Избор на цвят -> преглед на живо; срок 90 дни -> крайна цена 5,97 €', async () => {
    await page.locator('[data-pc-swatch="blue-2"]').click()
    assert(await page.locator('[data-pc-swatch="blue-2"]').getAttribute('aria-pressed') === 'true', 'избран')
    assert(await previewNameColor(page, 'dark') === 'rgb(74, 103, 247)' && await previewNameColor(page, 'light') === 'rgb(74, 103, 247)', 'цвят в прегледа')
    assert(/1,99\s€/.test(await page.locator('[data-pc-price="nickname_color"]').innerText()), 'цена 30')
    await page.locator('[data-pc-days="nickname_color"]').selectOption('90')
    assert(/5,97\s€/.test(await page.locator('[data-pc-price="nickname_color"]').innerText()), 'цена 90')
    assert(/5,97\s€/.test(await page.locator('[data-pc-pay="nickname_color"]').innerText()), 'бутон')
    const options = await page.locator('[data-pc-days="nickname_color"] option').allInnerTexts()
    assert(options.length === 6 && options[5]!.includes('180 дни') && /11,94\s€/.test(options[5]!), options.join(' | '))
  })

  await check('[D3] Само една отворена секция; емоджи каталог: лента с 15 категории, 13 на ред, вътрешно превъртане; преглед на живо', async () => {
    await page.locator('[data-pc-toggle="emoji_before"]').click()
    assert(await page.locator('[data-pc-panel]').count() === 1 && await page.locator('[data-pc-panel="emoji_before"]').count() === 1, 'една секция')
    assert(await page.locator('[data-pc-category]').count() === 15, 'категории')
    await page.locator('[data-pc-category="animals"]').click()
    const perRow = await page.locator('[data-pc-emoji]').evaluateAll((els) => {
      const top = Math.round(els[0]!.getBoundingClientRect().top)
      return els.filter((el) => Math.round(el.getBoundingClientRect().top) === top).length
    })
    assert(perRow >= 12 && perRow <= 14, `на ред ${perRow}`)
    const grid = await page.locator('[data-pc-emoji-grid="1"]').evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }))
    assert(grid.client <= 224 && grid.scroll > grid.client, JSON.stringify(grid))
    await page.locator('[data-pc-emoji]').nth(3).click()
    const chosen = await page.locator('[data-pc-emoji]').nth(3).innerText()
    assert((await page.locator('[data-pc-preview-before="1"]').first().innerText()) === chosen, 'емоджи пред ника в прегледа')
    // Изборът в другата секция остава (прегледът показва и двете).
    assert(await previewNameColor(page, 'dark') === 'rgb(74, 103, 247)', 'цветът остава')
    await shot(page, 'desktop-emoji')
  })

  await check('[D4] "Плати" -> checkout заявка само с вид/артикул/срок; пренасочване към Stripe; pending поръчка с цена от сървъра', async () => {
    await page.locator('[data-pc-toggle="nickname_color"]').click()
    await page.locator('[data-pc-pay="nickname_color"]').click()
    await page.waitForFunction(() => (window as any).__customizationHarness.navigations().length === 1)
    const last = checkoutRequests.at(-1)!
    assert(JSON.stringify(Object.keys(last).sort()) === JSON.stringify(['acknowledgeReplace', 'days', 'itemId', 'kind']), JSON.stringify(last))
    assert(last.kind === 'nickname_color' && last.itemId === 'blue-2' && last.days === 90, JSON.stringify(last))
    assert((await navigations(page))[0] === 'https://checkout.stripe.test/cs_window_1', 'url')
    assert(store.findByCheckoutSessionId('cs_window_1')?.priceCents === 597, 'цена')
  })

  await check('[D5] Секция, която не се продава -> съобщение, без "Плати"', async () => {
    await page.locator('[data-pc-toggle="emoji_after"]').click()
    assert(await page.locator('[data-pc-sales-disabled="emoji_after"]').count() === 1 && await page.locator('[data-pc-pay="emoji_after"]').count() === 0, 'не се продава')
    assert(errors.length === 0, errors.join(' | '))
  })

  console.log('\n[R] Връщане от Stripe и активна покупка')

  await check('[R1] Връщане "success": "потвърждава се", после (webhook) -> "активирана до"; секцията показва текуща, изтичане, оставащи дни и "Удължи"', async () => {
    const back = await openWindow({ width: 1280, height: 900 }, 'dark', { status: 'success', checkoutSessionId: 'cs_window_1' })
    await back.page.waitForFunction(() => document.querySelector('[data-pc-notice="1"]')?.textContent?.includes('потвърждава') === true)
    payWebhook('cs_window_1')
    await back.page.waitForFunction(() => document.querySelector('[data-pc-notice="1"]')?.textContent?.includes('активирана до') === true, undefined, { timeout: 10_000 })
    const active = await back.page.locator('[data-pc-active="nickname_color"]').innerText()
    assert(active.includes('Кралско синьо') && active.includes('Изтича на') && (await back.page.locator('[data-pc-remaining="nickname_color"]').innerText()) === '90 дни', active)
    assert(await back.page.locator('[data-pc-extend="nickname_color"]').count() === 1, 'Удължи')
    assert(await previewNameColor(back.page, 'light') === 'rgb(74, 103, 247)', 'прегледът показва активната')
    await shot(back.page, 'desktop-active')
    await back.page.close()
  })

  await check('[R2] "Удължи" -> същият цвят, текст за удължаване, плащане без потвърждение', async () => {
    const extend = await openWindow({ width: 1280, height: 900 }, 'dark')
    await extend.page.locator('[data-pc-swatch="red-1"]').click()
    await extend.page.locator('[data-pc-extend="nickname_color"]').click()
    assert(await extend.page.locator('[data-pc-swatch="blue-2"]').getAttribute('aria-pressed') === 'true', 'избран е активният')
    const effect = await extend.page.locator('[data-pc-effect="extend"]').innerText()
    assert(effect.includes('Удължаване с 30 дни') && effect.includes('90 + 30'), effect)
    assert(await extend.page.locator('[data-pc-replace-warning="1"]').count() === 0, 'без предупреждение')
    await extend.page.locator('[data-pc-pay="nickname_color"]').click()
    await extend.page.waitForFunction(() => (window as any).__customizationHarness.navigations().length === 1)
    assert(checkoutRequests.at(-1)!.acknowledgeReplace === false, 'без потвърждение')
    await extend.page.close()
  })

  await check('[R3] Различен цвят -> ясно предупреждение за загубените дни; "Плати" е заключен до потвърждението', async () => {
    const replace = await openWindow({ width: 1280, height: 900 }, 'dark')
    await replace.page.locator('[data-pc-swatch="red-1"]').click()
    const warning = await replace.page.locator('[data-pc-replace-warning="1"]').innerText()
    assert(warning.includes('ще бъде заменена') && warning.includes('90 дни') && warning.includes('загубени'), warning)
    assert(await replace.page.locator('[data-pc-pay="nickname_color"]').isDisabled(), 'заключен')
    await replace.page.locator('[data-pc-ack="nickname_color"]').check()
    assert(!(await replace.page.locator('[data-pc-pay="nickname_color"]').isDisabled()), 'отключен')
    await shot(replace.page, 'desktop-replace-warning')
    await replace.page.locator('[data-pc-pay="nickname_color"]').click()
    await replace.page.waitForFunction(() => (window as any).__customizationHarness.navigations().length === 1)
    const last = checkoutRequests.at(-1)!
    assert(last.itemId === 'red-1' && last.acknowledgeReplace === true, JSON.stringify(last))
    await replace.page.close()
  })

  await check('[R4] Връщане "cancel" -> съобщение, нищо не е променено; Escape затваря', async () => {
    const cancel = await openWindow({ width: 1280, height: 900 }, 'dark', { status: 'cancel' })
    assert((await cancel.page.locator('[data-pc-notice="1"]').innerText()).includes('отказано'), 'съобщение')
    await cancel.page.keyboard.press('Escape')
    assert(await windowEl(cancel.page).count() === 0, 'затворен')
    assert(cancel.errors.length === 0, cancel.errors.join(' | '))
    await cancel.page.close()
  })

  console.log('\n[M] Мобилен (светла тема)')

  await check('[M1] 390×844: светла тема на цял екран, без хоризонтално превъртане, 9 емоджита на ред', async () => {
    const mobile = await openWindow({ width: 390, height: 844 }, 'light')
    const bg = await mobile.page.locator('[data-pc-dialog="1"]').evaluate((el) => getComputedStyle(el).backgroundColor)
    assert(bg === 'rgb(255, 255, 255)', bg)
    // Светъл интерфейс: прегледът е светъл; активният закупен цвят остава,
    // а за видовете без покупка — стандартният тъмен текст.
    assert(await mobile.page.locator('[data-pc-unified-preview="1"][data-pc-preview-theme="light"]').count() === 1, 'светъл преглед')
    const messageColor = await mobile.page.locator('[data-pc-preview-message="1"]').evaluate((el) => getComputedStyle(el).color)
    assert(messageColor === 'rgb(17, 24, 39)', `стандартен текст на светъл фон ${messageColor}`)
    for (const kind of ['nickname_color', 'emoji_before', 'message_color']) {
      if (await mobile.page.locator(`[data-pc-panel="${kind}"]`).count() === 0) await mobile.page.locator(`[data-pc-toggle="${kind}"]`).click()
      const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert(overflow <= 0, `${kind}: ${overflow}px`)
      await shot(mobile.page, `mobile-${kind}`)
    }
    await mobile.page.locator('[data-pc-toggle="emoji_before"]').click()
    const perRow = await mobile.page.locator('[data-pc-emoji]').evaluateAll((els) => {
      const top = Math.round(els[0]!.getBoundingClientRect().top)
      return els.filter((el) => Math.round(el.getBoundingClientRect().top) === top).length
    })
    assert(perRow >= 9 && perRow <= 10, `на ред ${perRow}`)
    assert(mobile.errors.length === 0, mobile.errors.join(' | '))
  })
} finally {
  await browser?.close()
  await vite?.close()
  store.close()
  db.close()
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
