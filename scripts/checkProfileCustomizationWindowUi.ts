/**
 * checkProfileCustomizationWindowUi.ts
 *
 * "Персонализация на профила", Етап 2 — реален браузър (Playwright) върху
 * прозореца "Персонализация" (тъмен десктоп и светъл мобилен вариант).
 * /api/profile-customization се обслужва в теста от РЕАЛНИЯ
 * profileCustomizationStore (временна база с всички миграции) — същата
 * логика като route-а в index.ts (preview, задължително потвърждение при
 * замяна, обща поръчка с няколко реда). Stripe не се вика: checkoutUrl е
 * фиктивен, а "webhook-ът" е store.fulfillPaidOrder. HTTP/webhook/флагът са покрити
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
  return result.code === 'not_found' || result.code === 'not_owned' ? 404 : result.code === 'duplicate' || result.code === 'expired' ? 409 : 400
}

// Огледало на handleProfileCustomizationRequest (без Stripe): обща поръчка с
// 1..4 реда, сравнение на показаната обща сума, инвентар и "Използвай"/"Премахни".
async function serveApi(route: Route): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const json = (status: number, payload: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
  if (request.method() === 'GET' && url.pathname === '/api/profile-customization') {
    const sessionId = url.searchParams.get('sessionId')
    const returnOrder = sessionId ? store.findProfileOrderByCheckoutSessionId(profileId, sessionId) : null
    return json(200, {
      ok: true,
      kinds: store.listKindSettings(),
      colors: store.listColors(),
      emojis: store.listEmojis(),
      colorGroups: PROFILE_CUSTOMIZATION_COLOR_GROUPS.map((key) => ({ key, label: PROFILE_CUSTOMIZATION_COLOR_GROUP_LABELS[key] })),
      emojiCategories: PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES.map((key) => ({ key, label: PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_LABELS[key], icon: PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_ICONS[key] })),
      durations: PROFILE_CUSTOMIZATION_DURATION_DAYS,
      active: store.getProfileActiveItems(profileId),
      owned: store.getProfileOwnedItems(profileId),
      serverNow: new Date().toISOString(),
      returnOrder: returnOrder === null ? null : {
        orderId: returnOrder.orderId,
        status: returnOrder.status,
        totalCents: returnOrder.totalCents,
        items: returnOrder.lines.map((line) => ({ kind: line.kind, kindLabel: line.kind, itemValue: line.itemValue, days: line.days, status: line.status, grantEffect: line.grantEffect, grantedUntil: line.grantedUntil })),
      },
    })
  }
  if (request.method() === 'POST' && (url.pathname === '/api/profile-customization/equip' || url.pathname === '/api/profile-customization/unequip')) {
    const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>
    equipRequests.push({ path: url.pathname, ...body })
    const result = url.pathname.endsWith('/equip')
      ? store.equipItem({ profileId, kind: String(body.kind), itemId: String(body.itemId) })
      : store.unequipItem({ profileId, kind: String(body.kind) })
    if (!result.ok) return json(failureStatus(result), result)
    return json(200, { ok: true, active: result.active, owned: result.owned })
  }
  if (request.method() === 'POST' && url.pathname === '/api/profile-customization/checkout') {
    const body = JSON.parse(request.postData() ?? '{}') as { items?: Array<Record<string, unknown>>; expectedTotalCents?: unknown }
    checkoutRequests.push(body as Record<string, unknown>)
    const items = Array.isArray(body.items) ? body.items : []
    const input = { profileId, items: items.map((item) => ({ kind: String(item.kind), itemId: String(item.itemId), days: typeof item.days === 'number' ? item.days : Number.NaN })) }
    const preview = store.previewOrder(input)
    if (!preview.ok) return json(failureStatus(preview), preview)
    if (body.expectedTotalCents !== preview.preview.totalCents) return json(409, { ok: false, code: 'price_changed', message: 'Цената се промени.', preview: preview.preview })
    const pending = store.createPendingOrder(input)
    if (!pending.ok) return json(failureStatus(pending), pending)
    sessionCounter += 1
    const sessionId = `cs_window_${sessionCounter}`
    store.attachOrderCheckoutSession(pending.order.orderId, sessionId)
    return json(200, { ok: true, checkoutUrl: `https://checkout.stripe.test/${sessionId}`, checkoutSessionId: sessionId, orderId: pending.order.orderId, totalCents: pending.order.totalCents })
  }
  return json(404, { ok: false, message: 'Not found' })
}

const equipRequests: Array<Record<string, unknown>> = []
const grantRequests: Array<Record<string, unknown>> = []

// Получател за административния режим: служебна роля (pika_team) -> #F72585 има приоритет в прегледа.
const targetProfileId = randomUUID()
{
  const accountId = randomUUID()
  db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES (?, ?, 'x', 'pika_team');`).run(accountId, 'target@example.test')
  db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES (?, ?, 'Получател', 'получател');`).run(targetProfileId, accountId)
}

// Огледало на /api/admin/profile-customization (targets + grants) върху реалния store.
async function serveAdminApi(route: Route): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const json = (status: number, payload: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
  const targetMatch = /^\/api\/admin\/profile-customization\/targets\/([^/]+)$/.exec(url.pathname)
  if (request.method() === 'GET' && targetMatch) {
    const target = store.getGrantTarget(decodeURIComponent(targetMatch[1] as string))
    if (target === null) return json(404, { ok: false, message: 'Профилът не беше намерен.' })
    return json(200, {
      ok: true,
      kinds: store.listKindSettings().map((kind) => ({ ...kind, purchasable: true })),
      colors: store.listColors(),
      emojis: store.listEmojis(),
      colorGroups: PROFILE_CUSTOMIZATION_COLOR_GROUPS.map((key) => ({ key, label: PROFILE_CUSTOMIZATION_COLOR_GROUP_LABELS[key] })),
      emojiCategories: PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES.map((key) => ({ key, label: PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_LABELS[key], icon: PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_ICONS[key] })),
      durations: PROFILE_CUSTOMIZATION_DURATION_DAYS,
      active: store.getProfileActiveItems(target.profileId),
      owned: store.getProfileOwnedItems(target.profileId),
      serverNow: new Date().toISOString(),
      adminTestMode: false,
      returnOrder: null,
      target: { ...target, isSelf: target.profileId === profileId },
    })
  }
  if (request.method() === 'POST' && url.pathname === '/api/admin/profile-customization/grants') {
    const body = JSON.parse(request.postData() ?? '{}') as { targetProfileId?: string; confirm?: boolean; items?: Array<Record<string, unknown>> }
    grantRequests.push(body as Record<string, unknown>)
    if (body.confirm !== true) return json(400, { ok: false, code: 'confirmation_required', message: 'Потвърди.' })
    const result = store.grantItems({ adminProfileId: profileId, adminDisplayName: 'Мишо', targetProfileId: String(body.targetProfileId), items: (body.items ?? []).map((item) => ({ kind: String(item.kind), itemId: String(item.itemId), days: Number(item.days) })) })
    if (!result.ok) return json(failureStatus(result), result)
    return json(200, { ok: true, batchId: result.batchId, grants: result.grants, active: result.active, owned: result.owned })
  }
  return json(404, { ok: false, message: 'Not found' })
}

/** "Webhook": потвърждава поръчката по session id (всички редове заедно). */
function payWebhook(sessionId: string): void {
  const order = store.findOrderByCheckoutSessionId(sessionId)
  if (order === null) throw new Error(`няма поръчка за ${sessionId}`)
  const result = store.fulfillPaidOrder({ checkoutSessionId: sessionId, orderId: order.orderId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: order.totalCents, stripePaymentIntentId: `pi_${sessionId}` })
  if (!result.ok) throw new Error(result.message)
}

let vite: ViteDevServer | null = null
let browser: Browser | null = null
const windowEl = (page: Page) => page.locator('#profile-customization-window')

const RGB = { white: 'rgb(255, 255, 255)', blue: 'rgb(43, 116, 217)', red: 'rgb(232, 23, 41)', green: 'rgb(20, 137, 30)', pink: 'rgb(220, 64, 142)', orange: 'rgb(198, 90, 0)' }

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/profileCustomizationWindowHarness.html`
  browser = await chromium.launch()

  async function openWindow(viewport: { width: number; height: number }, theme: 'dark' | 'light', stripeReturn: unknown = null, adminGrant: unknown = null): Promise<{ page: Page; errors: string[] }> {
    const context = await browser!.newContext({ viewport, hasTouch: theme === 'light', isMobile: theme === 'light', locale: 'bg-BG', timezoneId: 'Europe/Sofia' })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/api/profile-customization**', serveApi)
    await page.route('**/api/admin/profile-customization/**', serveAdminApi)
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__customizationHarness !== undefined, undefined, { timeout: 15_000 })
    await page.evaluate(({ t, r, g }) => (window as any).__customizationHarness.open(t, r, g), { t: theme, r: stripeReturn, g: adminGrant })
    await page.locator('[data-pc-inventory="1"]').waitFor({ timeout: 10_000 })
    return { page, errors }
  }

  async function shot(page: Page, name: string): Promise<void> {
    if (screenshotDir === null) return
    await mkdir(screenshotDir, { recursive: true })
    await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true })
  }

  const previewNameColor = (page: Page) => page.locator('[data-pc-unified-preview="1"] [data-pc-preview-name="1"]').evaluate((el) => getComputedStyle(el).color)
  const navigations = (page: Page) => page.evaluate(() => (window as any).__customizationHarness.navigations() as string[])
  const cartCount = async (page: Page) => Number(await page.locator('[data-pc-cart-count]').getAttribute('data-pc-cart-count'))
  const cartTotal = (page: Page) => page.locator('[data-pc-cart-total]').innerText()
  const payButton = (page: Page) => page.locator('[data-pc-pay="1"]')
  const openSection = async (page: Page, kind: string) => {
    if (await page.locator(`[data-pc-panel="${kind}"]`).count() === 0) await page.locator(`[data-pc-toggle="${kind}"]`).click()
  }
  const card = (page: Page, kind: string, itemId: string) => page.locator(`[data-pc-owned-card="${kind}|${itemId}"]`)

  const { page, errors } = await openWindow({ width: 1280, height: 900 }, 'dark')

  console.log('\n[D] Десктоп (тъмна тема) — каталог и обща поръчка')

  await check('[D1] Празен инвентар; 7 цвята с имена (Червен/Оранжев/Златист/Зелен/Син/Лилав/Розов), без маркери; празна поръчка с един неактивен "Плати"', async () => {
    assert(await page.locator('[data-pc-section]').count() === 4, 'секции')
    assert(await page.locator('[data-pc-inventory-empty="1"]').count() === 1, 'празен инвентар')
    const names = await page.locator('[data-pc-color-option]').allInnerTexts()
    assert(names.map((name) => name.trim()).join(',') === ['Червен', 'Оранжев', 'Златист', 'Зелен', 'Син', 'Лилав', 'Розов'].join(','), names.join(','))
    assert(await page.locator('[data-pc-swatch]').count() === 7 && await page.locator('[data-pc-owned]').count() === 0, '7 квадратчета без маркери')
    assert(await previewNameColor(page) === RGB.white, 'стандартен ник')
    assert(await cartCount(page) === 0 && await payButton(page).isDisabled(), 'празна поръчка')
    await shot(page, 'desktop-initial')
  })

  await check('[D2] Три екстри с различни срокове -> обща цена 5,97 + 1,99 + 11,94 = 19,90 €; прегледът комбинира временно избраните', async () => {
    await page.locator('[data-pc-swatch="blue-1"]').click()
    await page.locator('[data-pc-days="nickname_color"]').selectOption('90')
    await openSection(page, 'emoji_before')
    await page.locator('[data-pc-category="animals"]').click()
    await page.locator('[data-pc-emoji]').nth(3).click()
    await openSection(page, 'message_color')
    await page.locator('[data-pc-swatch="green-1"]').click()
    await page.locator('[data-pc-days="message_color"]').selectOption('180')
    assert(await cartCount(page) === 3 && /19,90\s€/.test(await cartTotal(page)) && /Плати 19,90\s€/.test(await payButton(page).innerText()), `сума ${await cartTotal(page)}`)
    assert(await previewNameColor(page) === RGB.blue, 'син ник в прегледа')
    assert(await page.locator('[data-pc-panel] [data-pc-pay]').count() === 0, 'без бутони в секциите')
    assert(await page.locator('[data-pc-replace-warning]').count() === 0, 'без предупреждения за загуба')
  })

  await check('[D3] Махане: "×" и повторен клик; ЕДНО "Плати" -> ЕДНА заявка (вид/артикул/срок + сума); нищо не е активирано преди плащането', async () => {
    await page.locator('[data-pc-cart-remove="message_color"]').click()
    assert(await cartCount(page) === 2 && /7,96\s€/.test(await cartTotal(page)), `след × ${await cartTotal(page)}`)
    await page.locator('[data-pc-swatch="green-1"]').click()
    await page.locator('[data-pc-swatch="green-1"]').click()
    assert(await cartCount(page) === 2, 'повторен клик маха')
    await payButton(page).click()
    await page.waitForFunction(() => (window as any).__customizationHarness.navigations().length === 1)
    const last = checkoutRequests.at(-1)! as { items: Array<Record<string, unknown>>; expectedTotalCents: number }
    assert(last.expectedTotalCents === 796 && last.items.length === 2, JSON.stringify(last))
    assert(last.items.every((item) => JSON.stringify(Object.keys(item).sort()) === JSON.stringify(['days', 'itemId', 'kind'])), JSON.stringify(last.items))
    assert(Object.values(store.getProfileActiveItems(profileId)).every((item) => item === null) && store.getProfileOwnedItems(profileId).length === 0, 'нищо не е активирано')
    assert(errors.length === 0, errors.join(' | '))
  })

  console.log('\n[I] Инвентар, маркери, смяна')

  await check('[I1] След плащането: 2 карти в "Моите персонализации" (Използва се), маркер "използва се" в каталога; нищо не е избрано за ново таксуване', async () => {
    payWebhook('cs_window_1')
    const view = await openWindow({ width: 1280, height: 900 }, 'dark', { status: 'success', checkoutSessionId: 'cs_window_1' })
    await view.page.waitForFunction(() => document.querySelector('[data-pc-notice="1"]')?.textContent?.includes('2 персонализации') === true, undefined, { timeout: 10_000 })
    assert(await view.page.locator('[data-pc-owned-card]').count() === 2, 'две карти')
    const blue = card(view.page, 'nickname_color', 'blue-1')
    assert(await blue.getAttribute('data-pc-owned-state') === 'equipped' && (await blue.innerText()).includes('Използва се') && (await blue.innerText()).includes('90 дни'), await blue.innerText())
    assert(await blue.locator('[data-pc-unequip]').count() === 1 && await blue.locator('[data-pc-extend-item]').count() === 1, 'Премахни + Удължи')
    assert(await view.page.locator('[data-pc-swatch="blue-1"]').getAttribute('data-pc-owned') === 'equipped', 'маркер в каталога')
    assert(await cartCount(view.page) === 0, 'не е избрано наново')
    await view.page.close()
  })

  await check('[I2] Купуване на ДРУГ цвят (червен): без предупреждение; след плащане червеният се използва, синият е "Наличен" с всичките си 90 дни', async () => {
    const buy = await openWindow({ width: 1280, height: 900 }, 'dark')
    await buy.page.locator('[data-pc-swatch="red-1"]').click()
    const effect = await buy.page.locator('[data-pc-effect="new"]').innerText()
    assert(effect.includes('остава в "Моите персонализации"'), effect)
    assert(await buy.page.locator('[data-pc-replace-warning], [data-pc-ack]').count() === 0 && !(await payButton(buy.page).isDisabled()), 'без потвърждение за загуба')
    await payButton(buy.page).click()
    await buy.page.waitForFunction(() => (window as any).__customizationHarness.navigations().length === 1)
    await buy.page.close()
    payWebhook(`cs_window_${sessionCounter}`)
    const view = await openWindow({ width: 1280, height: 900 }, 'dark')
    assert(await card(view.page, 'nickname_color', 'red-1').getAttribute('data-pc-owned-state') === 'equipped', 'червеният се използва')
    const blue = card(view.page, 'nickname_color', 'blue-1')
    assert(await blue.getAttribute('data-pc-owned-state') === 'available' && (await blue.innerText()).includes('Наличен') && (await blue.innerText()).includes('90 дни'), await blue.innerText())
    assert(await view.page.locator('[data-pc-swatch="blue-1"]').getAttribute('data-pc-owned') === 'available' && await view.page.locator('[data-pc-swatch="red-1"]').getAttribute('data-pc-owned') === 'equipped', 'маркери')
    assert(await previewNameColor(view.page) === RGB.red, 'прегледът е червен')
    await shot(view.page, 'desktop-inventory')
    await view.page.close()
  })

  await check('[I3] "Използвай" от инвентара: прегледът се сменя веднага, сървърът записва, сроковете не се променят; "Премахни" спира ефекта, правото остава', async () => {
    const view = await openWindow({ width: 1280, height: 900 }, 'dark')
    const untilBefore = JSON.stringify(store.getProfileOwnedItems(profileId).map((item) => [item.itemId, item.activeUntil]))
    await card(view.page, 'nickname_color', 'blue-1').locator('[data-pc-equip]').click()
    assert(await previewNameColor(view.page) === RGB.blue, 'прегледът веднага')
    await view.page.waitForFunction(() => document.querySelector('[data-pc-owned-card="nickname_color|blue-1"]')?.getAttribute('data-pc-owned-state') === 'equipped')
    assert(store.getProfileActiveItems(profileId).nickname_color?.itemId === 'blue-1', 'записано')
    assert(await card(view.page, 'nickname_color', 'red-1').getAttribute('data-pc-owned-state') === 'available', 'червеният е наличен')
    assert(equipRequests.at(-1)?.path === '/api/profile-customization/equip', 'без Stripe')
    await card(view.page, 'nickname_color', 'blue-1').locator('[data-pc-unequip]').click()
    await view.page.waitForFunction(() => document.querySelector('[data-pc-owned-card="nickname_color|blue-1"]')?.getAttribute('data-pc-owned-state') === 'available')
    assert(await previewNameColor(view.page) === RGB.white, 'стандартен ник')
    assert(store.getProfileActiveItems(profileId).nickname_color === null && store.getProfileOwnedItems(profileId).filter((item) => item.kind === 'nickname_color').length === 2, 'правото остава')
    assert(JSON.stringify(store.getProfileOwnedItems(profileId).map((item) => [item.itemId, item.activeUntil])) === untilBefore, 'сроковете са непроменени')
    assert(checkoutRequests.length === 2 && (await navigations(view.page)).length === 0, 'без плащане')
    assert(view.errors.length === 0, view.errors.join(' | '))
    await view.page.close()
  })

  await check('[I4] Каталог: клик върху закупен цвят -> детайли (Закупен, срок, Използвай, Удължи), НЕ се добавя за покупка; "Удължи" -> удължаване в поръчката', async () => {
    const view = await openWindow({ width: 1280, height: 900 }, 'dark')
    await view.page.locator('[data-pc-swatch="red-1"]').click()
    const detail = view.page.locator('[data-pc-item-detail="nickname_color"]')
    assert(await detail.getAttribute('data-pc-item-detail-state') === 'available' && (await detail.innerText()).includes('Закупен') && (await detail.innerText()).includes('остават'), await detail.innerText())
    assert(await cartCount(view.page) === 0, 'не е добавен за покупка')
    await detail.locator('[data-pc-equip]').click()
    await view.page.waitForFunction(() => document.querySelector('[data-pc-item-detail="nickname_color"]')?.getAttribute('data-pc-item-detail-state') === 'equipped')
    assert((await view.page.locator('[data-pc-item-detail="nickname_color"]').innerText()).includes('Използва се') && await view.page.locator('[data-pc-item-detail="nickname_color"] [data-pc-unequip]').count() === 1, 'използва се + Премахни')
    await view.page.locator('[data-pc-item-detail="nickname_color"] [data-pc-extend-item]').click()
    assert(await cartCount(view.page) === 1 && await view.page.locator('[data-pc-cart-line="nickname_color"]').getAttribute('data-pc-cart-effect') === 'extend', 'удължаване в поръчката')
    const effect = await view.page.locator('[data-pc-effect="extend"]').innerText()
    assert(effect.includes('Удължаване с 30 дни'), effect)
    await shot(view.page, 'desktop-detail')
    await view.page.close()
  })

  await check('[I5] Емоджи каталог: закупеното емоджи е с компактен маркер (без надписи в клетките); легенда; детайлите показват срока', async () => {
    const view = await openWindow({ width: 1280, height: 900 }, 'dark')
    await openSection(view.page, 'emoji_before')
    const marked = view.page.locator('[data-pc-emoji][data-pc-owned]')
    assert(await marked.count() === 1 && await marked.first().getAttribute('data-pc-owned') === 'equipped', 'един маркиран')
    assert((await marked.first().innerText()).trim().length <= 2, 'без надпис в клетката')
    assert(await view.page.locator('[data-pc-legend="1"]').count() === 1, 'легенда')
    await marked.first().click()
    assert((await view.page.locator('[data-pc-item-detail="emoji_before"]').innerText()).includes('Използва се'), 'детайли')
    assert(await cartCount(view.page) === 0, 'не е добавено за покупка')
    await view.page.locator('[data-pc-emoji]:not([data-pc-owned])').first().click()
    assert(await cartCount(view.page) === 1, 'незакупеното се добавя')
    await shot(view.page, 'desktop-emoji-markers')
    await view.page.close()
  })

  await check('[R1] Цената се променя в админа -> price_changed, новата сума; връщане "cancel" + Escape', async () => {
    const priced = await openWindow({ width: 1280, height: 900 }, 'dark')
    await openSection(priced.page, 'message_color')
    await priced.page.locator('[data-pc-swatch="gold-1"]').click()
    store.updateKindSettings('message_color', { basePrice30DaysCents: 249 })
    await payButton(priced.page).click()
    await priced.page.waitForFunction(() => document.querySelector('[data-pc-notice="1"]')?.textContent?.includes('Цената се промени') === true, undefined, { timeout: 10_000 })
    assert(/2,49\s€/.test(await cartTotal(priced.page)), `нова цена ${await cartTotal(priced.page)}`)
    store.updateKindSettings('message_color', { basePrice30DaysCents: 199 })
    await priced.page.close()
    const cancel = await openWindow({ width: 1280, height: 900 }, 'dark', { status: 'cancel' })
    assert((await cancel.page.locator('[data-pc-notice="1"]').innerText()).includes('отказано'), 'отказано')
    await cancel.page.keyboard.press('Escape')
    assert(await windowEl(cancel.page).count() === 0, 'затворен')
    await cancel.page.close()
  })

  console.log('\n[A] Административен режим (пълен admin)')

  await check('[A1] Собствен профил на admin: И "Плати XX,XX €", И "Приложи безплатно (Админ)"; безплатното минава след потвърждение, без Stripe', async () => {
    const own = await openWindow({ width: 1280, height: 900 }, 'dark', null, { targetProfileId: profileId, isSelf: true })
    await openSection(own.page, 'message_color')
    await own.page.locator('[data-pc-swatch="purple-1"]').click()
    await own.page.locator('[data-pc-days="message_color"]').selectOption('120')
    assert(/Плати 7,96\s€/.test(await payButton(own.page).innerText()) && !(await payButton(own.page).isDisabled()), 'реалното плащане е налично')
    const grantButton = own.page.locator('[data-pc-grant="1"]')
    assert((await grantButton.innerText()) === 'Приложи безплатно (Админ)' && !(await grantButton.isDisabled()), 'безплатният бутон')
    const checkoutsBefore = checkoutRequests.length
    await grantButton.click()
    const confirm = own.page.locator('[data-pc-grant-confirm="1"]')
    assert((await confirm.innerText()).includes('твоя профил') && (await confirm.innerText()).includes('120 дни'), await confirm.innerText())
    await own.page.locator('[data-pc-grant-confirm-yes="1"]').click()
    await own.page.waitForFunction(() => document.querySelector('[data-pc-notice="1"]')?.textContent?.includes('Предоставено безплатно') === true, undefined, { timeout: 10_000 })
    assert(grantRequests.at(-1)?.targetProfileId === profileId && checkoutRequests.length === checkoutsBefore && (await navigations(own.page)).length === 0, 'без Stripe')
    assert(await card(own.page, 'message_color', 'purple-1').count() === 1 && store.getProfileOwnedItems(profileId).some((item) => item.itemId === 'purple-1' && item.kind === 'message_color' && item.remainingDays === 120), 'в инвентара')
    assert(await cartCount(own.page) === 0, 'изборът е изчистен')
    await own.page.close()
  })

  await check('[A2] Чужд профил: ясен получател, истинският му ник (служебният #F72585 има приоритет); само "Приложи безплатно" без цена; инвентарът е само за преглед', async () => {
    const foreign = await openWindow({ width: 1280, height: 900 }, 'dark', null, { targetProfileId, isSelf: false })
    assert((await foreign.page.locator('[data-pc-recipient]').innerText()).includes('Получател'), 'получател')
    assert((await foreign.page.locator('[data-pc-preview-name="1"]').innerText()) === 'Получател', 'никът на получателя')
    assert(await previewNameColor(foreign.page) === 'rgb(247, 37, 133)', `служебен цвят ${await previewNameColor(foreign.page)}`)
    assert(await payButton(foreign.page).count() === 0 && (await foreign.page.locator('[data-pc-grant="1"]').innerText()) === 'Приложи безплатно', 'само безплатно')
    await foreign.page.locator('[data-pc-swatch="green-1"]').click()
    await openSection(foreign.page, 'emoji_after')
    await foreign.page.locator('[data-pc-emoji]').nth(4).click()
    await foreign.page.locator('[data-pc-days="emoji_after"]').selectOption('60')
    assert((await foreign.page.locator('[data-pc-cart-total]').innerText()) === 'Безплатно' && await cartCount(foreign.page) === 2, 'без цена')
    await foreign.page.locator('[data-pc-grant="1"]').click()
    assert((await foreign.page.locator('[data-pc-grant-confirm="1"]').innerText()).includes('Получател'), 'потвърждението назовава получателя')
    await foreign.page.locator('[data-pc-grant-confirm-yes="1"]').click()
    await foreign.page.waitForFunction(() => document.querySelector('[data-pc-notice="1"]')?.textContent?.includes('Предоставено безплатно на Получател') === true, undefined, { timeout: 10_000 })
    assert(grantRequests.at(-1)?.targetProfileId === targetProfileId, 'към получателя')
    const owned = store.getProfileOwnedItems(targetProfileId)
    assert(owned.length === 2 && owned.some((item) => item.kind === 'emoji_after' && item.remainingDays === 60), JSON.stringify(owned))
    assert(!store.getProfileOwnedItems(profileId).some((item) => item.kind === 'emoji_after'), 'на admin не е предоставено нищо')
    assert(await foreign.page.locator('[data-pc-owned-card]').count() === 2 && await foreign.page.locator('[data-pc-inventory="1"] [data-pc-equip], [data-pc-inventory="1"] [data-pc-unequip]').count() === 0, 'инвентарът е само за преглед')
    await shot(foreign.page, 'desktop-admin-foreign')
    assert(foreign.errors.length === 0, foreign.errors.join(' | '))
    await foreign.page.close()
  })

  await check('[A3] Мобилен административен режим за чужд профил: светла тема, без хоризонтално превъртане', async () => {
    const foreign = await openWindow({ width: 390, height: 844 }, 'light', null, { targetProfileId, isSelf: false })
    assert(await foreign.page.locator('[data-pc-unified-preview="1"][data-pc-preview-theme="light"]').count() === 1, 'светъл')
    await foreign.page.locator('[data-pc-swatch="red-1"]').click()
    const overflow = await foreign.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert(overflow <= 0 && await foreign.page.locator('[data-pc-grant="1"]').isVisible(), `превъртане ${overflow}`)
    await shot(foreign.page, 'mobile-admin-foreign')
    await foreign.page.close()
  })

  console.log('\n[M] Мобилен (светла тема)')

  await check('[M1] 390×844: светла тема; инвентарът е в 1 колона, без хоризонтално превъртане; маркери и смяна работят; 9 емоджита на ред', async () => {
    const mobile = await openWindow({ width: 390, height: 844 }, 'light')
    assert(await mobile.page.locator('[data-pc-dialog="1"]').evaluate((el) => getComputedStyle(el).backgroundColor) === 'rgb(255, 255, 255)', 'светъл')
    assert(await mobile.page.locator('[data-pc-unified-preview="1"][data-pc-preview-theme="light"]').count() === 1, 'светъл преглед')
    const columns = await mobile.page.locator('[data-pc-inventory-kind="nickname_color"] [data-pc-inventory-grid="1"]').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    assert(columns === 1, `колони ${columns}`)
    await card(mobile.page, 'nickname_color', 'blue-1').locator('[data-pc-equip], [data-pc-unequip]').first().click()
    await mobile.page.waitForTimeout(300)
    for (const kind of ['nickname_color', 'emoji_before', 'message_color']) {
      await openSection(mobile.page, kind)
      const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert(overflow <= 0, `${kind}: ${overflow}px`)
    }
    await openSection(mobile.page, 'emoji_before')
    const perRow = await mobile.page.locator('[data-pc-emoji]').evaluateAll((els) => {
      const top = Math.round(els[0]!.getBoundingClientRect().top)
      return els.filter((el) => Math.round(el.getBoundingClientRect().top) === top).length
    })
    assert(perRow >= 9 && perRow <= 10, `на ред ${perRow}`)
    await mobile.page.evaluate(() => window.scrollTo(0, 0))
    await shot(mobile.page, 'mobile-inventory')
    assert(mobile.errors.length === 0, mobile.errors.join(' | '))
  })

  await check('[M2] Картите в инвентара на 320/360/390/430 px: по една на ред на цялата ширина; статусът е на един ред; двата бутона са на един ред с еднаква ширина; нищо не излиза извън картата; без пренасяне на думи; ниски карти', async () => {
    for (const width of [320, 360, 390, 430]) {
      const view = await openWindow({ width, height: 844 }, 'light')
      const metrics = await view.page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-pc-owned-card]'))
        return cards.map((cardEl) => {
          const grid = cardEl.parentElement!.getBoundingClientRect()
          const box = cardEl.getBoundingClientRect()
          const badge = Array.from(cardEl.querySelectorAll<HTMLElement>('[data-pc-status-badge]')).find((el) => el.offsetParent !== null)!
          const buttons = Array.from(cardEl.querySelectorAll<HTMLElement>('.pc-owned-actions button'))
          const overflowing = Array.from(cardEl.querySelectorAll<HTMLElement>('*')).filter((el) => {
            const rect = el.getBoundingClientRect()
            return el.offsetParent !== null && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5)
          }).length
          const clipped = Array.from(cardEl.querySelectorAll<HTMLElement>('button, [data-pc-status-badge], .pc-owned-meta > span')).filter((el) => el.offsetParent !== null && el.scrollWidth > el.clientWidth + 1).length
          return {
            fullWidth: Math.abs(box.width - grid.width) < 1,
            height: Math.round(box.height),
            badgeLines: Math.round(badge.getBoundingClientRect().height),
            buttonTops: buttons.map((el) => Math.round(el.getBoundingClientRect().top)),
            buttonWidths: buttons.map((el) => Math.round(el.getBoundingClientRect().width)),
            overflowing,
            clipped,
          }
        })
      })
      const pageOverflow = await view.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert(metrics.length >= 3 && pageOverflow <= 0, `${width}px: карти ${metrics.length}, превъртане ${pageOverflow}`)
      for (const m of metrics) {
        assert(m.fullWidth, `${width}px: картата не е на цялата ширина`)
        assert(m.badgeLines <= 22, `${width}px: статусът се пренася (${m.badgeLines}px)`)
        assert(m.buttonTops.length === 2 && m.buttonTops[0] === m.buttonTops[1] && Math.abs(m.buttonWidths[0]! - m.buttonWidths[1]!) <= 1, `${width}px: бутони ${JSON.stringify(m)}`)
        assert(m.overflowing === 0 && m.clipped === 0, `${width}px: излиза/отрязано ${JSON.stringify(m)}`)
        assert(m.height <= 110, `${width}px: висока карта ${m.height}px`)
      }
      await view.page.locator('[data-pc-inventory="1"]').screenshot({ path: screenshotDir !== null ? join(screenshotDir, `mobile-inventory-${width}.png`) : join(tmpdir(), `pc-inv-${width}.png`) })
      await view.page.close()
    }
  })

  await check('[M3] Десктоп запазва досегашното оформление: няколко карти на ред, статусът под срока, бутоните с естествена ширина', async () => {
    const desktop = await openWindow({ width: 1280, height: 900 }, 'dark')
    const layout = await desktop.page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('[data-pc-inventory-kind="nickname_color"] [data-pc-inventory-grid="1"]')!
      const below = document.querySelector<HTMLElement>('[data-pc-owned-card] .pc-owned-badge-below')!
      const side = document.querySelector<HTMLElement>('[data-pc-owned-card] .pc-owned-badge-side')!
      return { columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, below: getComputedStyle(below).display, side: getComputedStyle(side).display, actions: getComputedStyle(document.querySelector<HTMLElement>('.pc-owned-actions')!).display }
    })
    assert(layout.columns > 1 && layout.below !== 'none' && layout.side === 'none' && layout.actions === 'flex', JSON.stringify(layout))
    await desktop.page.close()
  })

  console.log('\n[K] Шести цвят: Розов #DC408E')

  for (const [label, viewport, theme] of [
    ['десктоп', { width: 1280, height: 900 }, 'dark'],
    ['390 px', { width: 390, height: 844 }, 'light'],
    ['320 px', { width: 320, height: 700 }, 'light'],
  ] as const) {
    await check(`[K1] ${label}: 7 цвята; Розов е последен, Оранжев е втори — и за ника, и за текста; прегледът показва и двата; цената е 1,99 € / 30 дни; без хоризонтално превъртане`, async () => {
      const view = await openWindow(viewport, theme)
      const page = view.page
      for (const kind of ['nickname_color', 'message_color']) {
        await openSection(page, kind)
        const panel = page.locator(`[data-pc-panel="${kind}"]`)
        assert(await panel.locator('[data-pc-swatch]').count() === 7, `${kind}: 7 цвята`)
        assert(await panel.locator('[data-pc-swatch]').nth(1).getAttribute('data-pc-swatch') === 'orange-4', `${kind}: Оранжев е втори`)
        const orangeSwatch = panel.locator('[data-pc-swatch="orange-4"]')
        assert(await orangeSwatch.getAttribute('aria-label') === 'Оранжев' && await orangeSwatch.evaluate((el) => getComputedStyle(el).backgroundColor) === RGB.orange && await orangeSwatch.isVisible(), `${kind}: оранжево квадратче`)
        await orangeSwatch.click()
        const orangePreview = kind === 'nickname_color'
          ? await previewNameColor(page)
          : await page.locator('[data-pc-unified-preview="1"] [data-pc-preview-message="1"]').evaluate((el) => getComputedStyle(el).color)
        assert(orangePreview === RGB.orange, `${kind}: оранжев преглед ${orangePreview}`)
        await shot(page, `orange-${kind}-${label.replace(/\s/g, '')}`)
        const last = await panel.locator('[data-pc-swatch]').last().getAttribute('data-pc-swatch')
        assert(last === 'pink-1', `${kind}: последен ${last}`)
        const swatch = panel.locator('[data-pc-swatch="pink-1"]')
        assert(await swatch.getAttribute('aria-label') === 'Розов' && await swatch.evaluate((el) => getComputedStyle(el).backgroundColor) === RGB.pink, `${kind}: квадратче`)
        assert(await swatch.isVisible(), `${kind}: видимо`)
        await swatch.click()
      }
      assert(await previewNameColor(page) === RGB.pink, 'розов ник в прегледа')
      const messageColor = await page.locator('[data-pc-unified-preview="1"] [data-pc-preview-message="1"]').evaluate((el) => getComputedStyle(el).color)
      assert(messageColor === RGB.pink, `розов текст в прегледа ${messageColor}`)
      assert(await cartCount(page) === 2 && /3,98\s€/.test(await cartTotal(page)), `поръчка ${await cartTotal(page)}`)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert(overflow <= 0, `хоризонтално превъртане ${overflow}px`)
      await shot(page, `pink-${label.replace(/\s/g, '')}`)
      assert(view.errors.length === 0, view.errors.join(' | '))
      await page.close()
    })
  }
} finally {
  await browser?.close()
  await vite?.close()
  store.close()
  db.close()
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
