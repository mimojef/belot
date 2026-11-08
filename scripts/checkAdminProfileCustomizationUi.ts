/**
 * checkAdminProfileCustomizationUi.ts
 *
 * "Персонализация на профила", Етап 1 — реален браузър (Playwright) върху
 * реалния панел Admin → Персонализация. API-то /api/admin/profile-customization
 * се обслужва в теста от РЕАЛНИЯ profileCustomizationStore (временна база с
 * всички миграции), така че записите в панела се проверяват директно в базата.
 * Правата/feature flag-ът са в server/scripts/checkProfileCustomizationAdminHttp.ts.
 *
 * Покрива: цени и продажба (текст -> центове на сървъра, грешка без промяна),
 * цветове (контраст, служебен цвят, добавяне, скриване, escape), емоджита
 * (лента с категории, вътрешно превъртане, скриване, добавяне), покупки,
 * Escape, мобилен и настолен изглед без хоризонтално превъртане.
 *
 * Употреба (от корена):
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkAdminProfileCustomizationUi.ts [--screenshots=<dir>]
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
  PROFILE_CUSTOMIZATION_MIN_CONTRAST_RATIO,
  PROFILE_CUSTOMIZATION_RESERVED_STAFF_COLOR,
  parseEuroAmountToCents,
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

console.log('\ncheckAdminProfileCustomizationUi')

// ─── Реален store върху временна база ──────────────────────────────────────
const tempRoot = await mkdtemp(join(tmpdir(), 'belot-admin-customization-ui-'))
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

// Една платена поръчка с ДВЕ екстри (едно плащане) за таба "Покупки".
{
  const accountId = randomUUID()
  const profileId = randomUUID()
  db.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, 'buyer@example.test')
  db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES (?, ?, 'Купувач<script>', 'купувач');`).run(profileId, accountId)
  store.updateKindSettings('emoji_before', { salesEnabled: true })
  const created = store.createPendingOrder({ profileId, items: [{ kind: 'emoji_before', itemId: 'emoji-0130', days: 90 }, { kind: 'nickname_color', itemId: 'green-1', days: 30 }], ignoreSalesToggle: true })
  if (!created.ok) throw new Error(created.message)
  store.attachOrderCheckoutSession(created.order.orderId, 'cs_ui')
  const paid = store.fulfillPaidOrder({ checkoutSessionId: 'cs_ui', orderId: created.order.orderId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: created.order.totalCents, stripePaymentIntentId: 'pi_ui' })
  if (!paid.ok) throw new Error(paid.message)
  // Частичен refund -> чака администраторски преглед.
  store.applyRefund({ checkoutSessionId: 'cs_ui', refundedAmountCents: 100, stripeEventId: 'evt_ui_partial' })
  store.updateKindSettings('emoji_before', { salesEnabled: false })
  // Безплатно предоставяне за таба "Предоставени" (одит, не плащане).
  const granted = store.grantItems({ adminProfileId: null, adminDisplayName: 'Главен Админ', targetProfileId: profileId, items: [{ kind: 'message_color', itemId: 'purple-1', days: 60 }] })
  if (!granted.ok) throw new Error(granted.message)
}

function failureStatus(result: ProfileCustomizationFailure): number {
  return result.code === 'not_found' ? 404 : result.code === 'duplicate' ? 409 : 400
}

// Огледало на транспорта в index.ts (handleAdminProfileCustomizationRequest).
async function serveApi(route: Route): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const sub = url.pathname.replace('/api/admin/profile-customization', '')
  const body = request.postData() ? JSON.parse(request.postData() as string) as Record<string, any> : {}
  const json = (status: number, payload: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
  if (request.method() === 'POST' && sub === '/mode') {
    modeRequests.push(body)
    if (body.confirm !== true) return json(400, { ok: false, code: 'confirmation_required', message: 'Потвърди промяната на режима.' })
    const result = store.setAccessMode(body.mode, { profileId: null, displayName: 'Тест Админ' })
    return json(200, { ok: true, changed: result.changed, ...adminSnapshot() })
  }
  if (request.method() === 'GET' && sub === '') {
    return json(200, adminSnapshot())
  }
  return serveRest(request, url, sub, body, json)
}

function adminSnapshot(): Record<string, unknown> {
  {
    return {
      ok: true,
      kinds: store.listKindSettings(),
      colors: store.listColors({ includeInactive: true }),
      emojis: store.listEmojis({ includeInactive: true }),
      stats: store.getAdminKindStats(),
      durations: PROFILE_CUSTOMIZATION_DURATION_DAYS,
      colorGroups: PROFILE_CUSTOMIZATION_COLOR_GROUPS.map((key) => ({ key, label: PROFILE_CUSTOMIZATION_COLOR_GROUP_LABELS[key] })),
      emojiCategories: PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES.map((key) => ({ key, label: PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_LABELS[key], icon: PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_ICONS[key] })),
      reservedStaffColor: PROFILE_CUSTOMIZATION_RESERVED_STAFF_COLOR,
      minContrastRatio: PROFILE_CUSTOMIZATION_MIN_CONTRAST_RATIO,
      access: { ...store.getAccessState(), emergencyStop: false, history: store.listModeChanges(10) },
      stripeMode: 'live',
      pendingRefundReviews: store.countPendingRefundReviews(),
    }
  }
}

const modeRequests: Array<Record<string, unknown>> = []

async function serveRest(
  request: ReturnType<Route['request']>,
  url: URL,
  sub: string,
  body: Record<string, any>,
  json: (status: number, payload: unknown) => Promise<void>,
): Promise<void> {
  if (request.method() === 'GET' && sub === '/grants') {
    return json(200, { ok: true, ...store.listGrants({ limit: Number(url.searchParams.get('limit') ?? 50), offset: Number(url.searchParams.get('offset') ?? 0) }) })
  }
  if (request.method() === 'GET' && sub === '/purchases') {
    return json(200, { ok: true, ...store.listAdminOrders({ limit: Number(url.searchParams.get('limit') ?? 50), offset: Number(url.searchParams.get('offset') ?? 0), status: url.searchParams.get('status') }) })
  }
  const kind = /^\/kinds\/([^/]+)$/.exec(sub)
  if (request.method() === 'PATCH' && kind) {
    const cents = typeof body.basePrice30Days === 'string' ? parseEuroAmountToCents(body.basePrice30Days) : undefined
    if (cents === null) return json(400, { ok: false, code: 'invalid_request', message: 'Невалидна цена или стойност за продажбата.' })
    const result = store.updateKindSettings(kind[1] as string, { basePrice30DaysCents: cents, salesEnabled: body.salesEnabled })
    return result.ok ? json(200, { ok: true, settings: result.settings }) : json(failureStatus(result), result)
  }
  if (request.method() === 'POST' && sub === '/colors') {
    const result = store.addColor({ hex: body.hex ?? '', label: body.label ?? '', groupKey: body.groupKey ?? '' })
    return result.ok ? json(200, { ok: true, color: result.color }) : json(failureStatus(result), result)
  }
  if (request.method() === 'POST' && sub === '/emojis') {
    const result = store.addEmoji({ emoji: body.emoji ?? '', categoryKey: body.categoryKey ?? '' })
    return result.ok ? json(200, { ok: true, emoji: result.emoji }) : json(failureStatus(result), result)
  }
  const review = /^\/purchases\/([^/]+)\/refund-review$/.exec(sub)
  if (request.method() === 'POST' && review) {
    return store.markRefundReviewed(decodeURIComponent(review[1] as string))
      ? json(200, { ok: true, pendingRefundReviews: store.countPendingRefundReviews() })
      : json(404, { ok: false, message: 'Няма поръчка, която чака преглед.' })
  }
  const item = /^\/(colors|emojis)\/([^/]+)$/.exec(sub)
  if (request.method() === 'PATCH' && item) {
    const id = decodeURIComponent(item[2] as string)
    const result = item[1] === 'colors'
      ? store.updateColor(id, { label: body.label, groupKey: body.groupKey, isActive: body.isActive })
      : store.updateEmoji(id, { categoryKey: body.categoryKey, isActive: body.isActive })
    return result.ok ? json(200, { ok: true, ...('color' in result ? { color: result.color } : { emoji: result.emoji }) }) : json(failureStatus(result), result)
  }
  return json(404, { ok: false, message: 'Not found' })
}

let vite: ViteDevServer | null = null
let browser: Browser | null = null

const panel = (page: Page) => page.locator('#admin-profile-customization-panel')
const notice = (page: Page) => page.locator('[data-apc-notice="1"]')

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/adminProfileCustomizationUiHarness.html`
  browser = await chromium.launch()

  async function openPanel(viewport: { width: number; height: number }, mobile = false): Promise<{ page: Page; errors: string[] }> {
    const context = await browser!.newContext({ viewport, hasTouch: mobile, isMobile: mobile, locale: 'bg-BG', timezoneId: 'Europe/Sofia' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/api/admin/profile-customization**', serveApi)
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__adminCustomizationHarness !== undefined, undefined, { timeout: 15_000 })
    await page.evaluate(() => (window as any).__adminCustomizationHarness.open())
    await page.locator('[data-apc-kind="nickname_color"]').waitFor({ timeout: 10_000 })
    return { page, errors }
  }

  async function shot(page: Page, name: string): Promise<void> {
    if (screenshotDir === null) return
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true })
  }

  const kindRow = () => db.prepare(`SELECT base_price_30_days_cents AS p, sales_enabled AS s FROM profile_customization_kind_settings WHERE kind = 'nickname_color';`).get() as { p: number; s: number }

  const { page, errors } = await openPanel({ width: 1280, height: 900 })

  console.log('\n[P] Цени и продажба')

  await check('[P0] Режим "Само админ" по подразбиране, Stripe LIVE е ясно показан; банер за частичен refund за преглед', async () => {
    assert(await page.locator('[data-apc-mode-card="1"][data-apc-mode="admin_only"]').count() === 1, 'режим')
    assert((await page.locator('[data-apc-mode-label="1"]').innerText()) === 'Само админ', 'етикет')
    assert((await page.locator('[data-apc-mode-toggle="1"]').innerText()) === 'Активирай', 'бутон')
    assert(await page.locator('[data-apc-stripe-mode="live"]').count() === 1, 'LIVE')
    const review = await page.locator('[data-apc-review-banner="1"]').innerText()
    assert(review.includes('1'), review)
  })

  await check('[P0b] "Активирай" -> потвърждение -> публично; "Деактивирай" -> потвърждение (отказ не прави нищо) -> "Само админ"', async () => {
    await page.locator('[data-apc-mode-toggle="1"]').click()
    assert((await page.locator('[data-apc-mode-confirm="1"]').innerText()).includes('всички потребители'), 'текст за активиране')
    assert(modeRequests.length === 0, 'отварянето не праща заявка')
    await page.locator('[data-apc-mode-confirm-yes="1"]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-mode-card="1"]')?.getAttribute('data-apc-mode') === 'public')
    assert(store.getAccessState().mode === 'public' && modeRequests.at(-1)?.confirm === true, 'записано')
    assert((await page.locator('[data-apc-mode-toggle="1"]').innerText()) === 'Деактивирай', 'бутон след активиране')
    await page.locator('[data-apc-mode-toggle="1"]').click()
    assert((await page.locator('[data-apc-mode-confirm="1"]').innerText()).includes('НЕ се отнемат'), 'текст за деактивиране')
    await page.locator('[data-apc-mode-confirm-no="1"]').click()
    assert(store.getAccessState().mode === 'public' && await page.locator('[data-apc-mode-confirm="1"]').count() === 0, 'отказът не променя')
    await page.locator('[data-apc-mode-toggle="1"]').click()
    await page.locator('[data-apc-mode-confirm-yes="1"]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-mode-card="1"]')?.getAttribute('data-apc-mode') === 'admin_only')
    assert(store.getAccessState().mode === 'admin_only', 'деактивирано')
    assert((await page.locator('[data-apc-mode-card="1"]').innerText()).includes('Тест Админ'), 'кой го е сменил')
    await shot(page, 'desktop-mode')
  })

  await check('[P1] 4 вида с цена 1.99 и автоматична таблица до 180 дни', async () => {
    assert(await page.locator('[data-apc-kind]').count() === 4, 'видове')
    assert(await page.locator('[data-apc-price="nickname_color"]').inputValue() === '1.99', 'цена')
    const text = await page.locator('[data-apc-kind="nickname_color"]').innerText()
    assert(text.includes('180 дни') && /11,94\s€/.test(text), text)
    await shot(page, 'desktop-pricing')
  })

  await check('[P2] Нова цена 2.49 + включена продажба -> записано на сървъра в центове; таблицата се обновява', async () => {
    await page.locator('[data-apc-price="nickname_color"]').fill('2.49')
    await page.locator('[data-apc-sales="nickname_color"]').check()
    await page.locator('[data-apc-save-kind="nickname_color"]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-notice="1"]')?.textContent?.includes('запазени') === true)
    const row = kindRow()
    assert(row.p === 249 && row.s === 1, JSON.stringify(row))
    const text = await page.locator('[data-apc-kind="nickname_color"]').innerText()
    assert(/14,94\s€/.test(text) && text.includes('Продава се'), text)
  })

  await check('[P3] Невалидна цена -> съобщение за грешка, базата не се променя', async () => {
    await page.locator('[data-apc-price="nickname_color"]').fill('абв')
    await page.locator('[data-apc-save-kind="nickname_color"]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-notice="1"]')?.textContent?.includes('Невалидна') === true)
    assert(kindRow().p === 249, 'цената остава')
  })

  console.log('\n[C] Цветове')

  await check('[C1] 7 групи, 21 цвята, контраст на черно/бяло, преглед на тъмен и светъл фон', async () => {
    await page.locator('[data-apc-tab="colors"]').click()
    await page.locator('[data-apc-color="red-1"]').waitFor()
    assert(await page.locator('[data-apc-color]').count() === 21, 'брой')
    const text = await page.locator('[data-apc-color="gold-2"]').innerText()
    assert(text.includes('на черно 4.57:1') && text.includes('на бяло 4.59:1'), text)
    assert(!text.includes('нисък контраст'), 'без предупреждение')
    await shot(page, 'desktop-colors')
  })

  await check('[C2] Служебният цвят се отказва със съобщение; валиден се добавя; етикетът е escape-нат', async () => {
    await page.locator('[data-apc-new-color-hex="1"]').fill('#F72585')
    await page.locator('[data-apc-new-color-label="1"]').fill('Розово')
    await page.locator('[data-apc-add-color="1"]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-notice="1"]')?.textContent?.includes('запазен') === true)
    await page.locator('[data-apc-new-color-hex="1"]').fill('#2A6F97')
    await page.locator('[data-apc-new-color-label="1"]').fill('<b>Петрол</b>')
    await page.locator('[data-apc-add-color="1"]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-notice="1"]')?.textContent?.includes('добавен') === true)
    assert(await page.locator('[data-apc-color]').count() === 22, 'нов цвят')
    assert(await panel(page).locator('b:text("Петрол")').count() === 0, 'HTML не е изпълнен')
  })

  await check('[C3] Скриване от продажба -> записано; редът е избледнял', async () => {
    await page.locator('[data-apc-color-active="red-1"]').uncheck()
    await page.locator('[data-apc-save-color="red-1"]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-notice="1"]')?.textContent?.includes('запазен') === true)
    const row = db.prepare(`SELECT is_active AS a, hex FROM profile_customization_colors WHERE color_id = 'red-1';`).get() as { a: number; hex: string }
    assert(row.a === 0 && row.hex === '#E81729', JSON.stringify(row))
    const opacity = await page.locator('[data-apc-color="red-1"]').evaluate((el) => getComputedStyle(el).opacity)
    assert(Number(opacity) < 1, `opacity ${opacity}`)
  })

  console.log('\n[E] Емоджита')

  await check('[E1] Лента с 15 категории; "Сърца" показва 20; решетката има ограничена височина с вътрешно превъртане', async () => {
    await page.locator('[data-apc-tab="emojis"]').click()
    assert(await page.locator('[data-apc-emoji-category]').count() === 15, 'категории')
    await page.locator('[data-apc-emoji-category="hearts"]').click()
    assert(await page.locator('[data-apc-emoji]').count() === 20, 'сърца')
    await page.locator('[data-apc-emoji-category="animals"]').click()
    const grid = page.locator('[data-apc-emoji]').first().locator('xpath=..')
    const metrics = await grid.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }))
    assert(metrics.client <= 262 && metrics.scroll > metrics.client && metrics.overflow === 'auto', JSON.stringify(metrics))
    const perRow = await page.locator('[data-apc-emoji]').evaluateAll((els) => new Set(els.slice(0, 40).map((el) => Math.round(el.getBoundingClientRect().top))).size)
    assert(perRow >= 2, 'няколко реда')
    await shot(page, 'desktop-emojis')
  })

  await check('[E2] Скриване на емоджи -> записано; добавяне на ново', async () => {
    await page.locator('[data-apc-emoji-category="hearts"]').click()
    await page.locator('[data-apc-emoji]').first().click()
    await page.locator('[data-apc-emoji-edit-active="1"]').uncheck()
    await page.locator('[data-apc-emoji-editor="1"] [data-apc-save-emoji]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-notice="1"]')?.textContent?.includes('запазено') === true)
    const hidden = db.prepare(`SELECT COUNT(*) AS c FROM profile_customization_emojis WHERE category_key = 'hearts' AND is_active = 0;`).get() as { c: number }
    assert(hidden.c === 1, `скрити ${hidden.c}`)
    await page.locator('[data-apc-new-emoji="1"]').fill('🦴')
    await page.locator('[data-apc-add-emoji="1"]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-notice="1"]')?.textContent?.includes('добавено') === true)
    await page.locator('[data-apc-new-emoji="1"]').fill('ab')
    await page.locator('[data-apc-add-emoji="1"]').click()
    await page.waitForFunction(() => document.querySelector('[data-apc-notice="1"]')?.textContent?.includes('точно едно') === true)
  })

  console.log('\n[U] Покупки')

  await check('[U1] Поръчката с две екстри е ЕДНА карта: двата реда (вид, артикул, срок, цена, ефект) и общата сума; името е escape-нато', async () => {
    await page.locator('[data-apc-tab="purchases"]').click()
    await page.locator('[data-apc-purchase]').first().waitFor()
    assert(await page.locator('[data-apc-purchase]').count() === 1 && await page.locator('[data-apc-purchase]').first().getAttribute('data-apc-order-items') === '2', 'една поръчка с 2 реда')
    assert(await page.locator('[data-apc-order-line]').count() === 2, 'два реда')
    const text = await page.locator('[data-apc-purchase]').first().innerText()
    assert(text.includes('2 екстри') && /общо 7,96\s€/.test(text) && text.includes('Емоджи пред никнейма') && text.includes('90 дни') && text.includes('Цвят на никнейма') && text.includes('30 дни') && text.includes('Платена') && text.includes('Нова') && text.includes('Купувач<script>'), text)
    assert(text.includes('възстановени 1,00') && text.includes('частично'), 'частичният refund е на поръчката')
    await shot(page, 'desktop-purchases')
  })

  await check('[U1b] Филтър "Чака преглед" и "Маркирай като прегледан" -> записано, банерът изчезва', async () => {
    await page.locator('[data-apc-purchases-status="1"]').selectOption('review_pending')
    await page.locator('[data-apc-mark-reviewed]').first().waitFor()
    assert(await page.locator('[data-apc-review-pending="1"]').count() === 1, 'значка')
    assert((await page.locator('[data-apc-purchase]').first().innerText()).includes('не може да се определи коя е засегната'), 'обяснение за поръчка с няколко екстри')
    await page.locator('[data-apc-mark-reviewed]').first().click()
    await page.waitForFunction(() => document.querySelector('[data-apc-review-banner="1"]') === null && document.querySelector('[data-apc-mark-reviewed]') === null)
    assert(store.countPendingRefundReviews() === 0, 'в базата')
  })

  await check('[U1c] Таб "Предоставени": одитът показва получател, admin, артикул, +дни, ефект, нов срок; означено като безплатно (не плащане)', async () => {
    await page.locator('[data-apc-tab="grants"]').click()
    await page.locator('[data-apc-grant]').first().waitFor()
    const text = await page.locator('[data-apc-grant]').first().innerText()
    assert(text.includes('Купувач<script>') && text.includes('Главен Админ') && text.includes('Цвят на текста') && text.includes('+60 дни') && text.includes('Безплатно') && text.includes('валидно до'), text)
    assert((await page.locator('#admin-profile-customization-panel').innerText()).includes('не влизат в оборота'), 'пояснение')
    await shot(page, 'desktop-grants')
  })

  await check('[U2] Escape затваря панела; без грешки в страницата', async () => {
    await page.keyboard.press('Escape')
    assert(await panel(page).count() === 0, 'затворен')
    assert(errors.length === 0, errors.join(' | '))
  })

  console.log('\n[M] Мобилен изглед')

  await check('[M1] 390×844: без хоризонтално превъртане във всички табове; ~9–10 емоджита на ред', async () => {
    const mobile = await openPanel({ width: 390, height: 844 }, true)
    for (const tab of ['pricing', 'colors', 'emojis', 'purchases']) {
      await mobile.page.locator(`[data-apc-tab="${tab}"]`).click()
      await mobile.page.waitForTimeout(150)
      const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert(overflow <= 0, `${tab}: хоризонтално превъртане ${overflow}px`)
      await shot(mobile.page, `mobile-${tab}`)
    }
    await mobile.page.locator('[data-apc-tab="emojis"]').click()
    const firstRowCount = await mobile.page.locator('[data-apc-emoji]').evaluateAll((els) => {
      const top = Math.round(els[0]!.getBoundingClientRect().top)
      return els.filter((el) => Math.round(el.getBoundingClientRect().top) === top).length
    })
    assert(firstRowCount >= 8 && firstRowCount <= 10, `емоджита на ред: ${firstRowCount}`)
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
