/**
 * checkProfileCustomizationStore.ts
 *
 * "Персонализация на профила", Етап 1 — целеви проверки на миграцията
 * 20261107_001, profileCustomizationCatalog.ts, profileCustomizationStore.ts
 * и Stripe помощниците (име на продукта / параметри на сесията). Изолирана
 * temp SQLite база с всички реални миграции. Времето се подава явно (now),
 * така че удължаване/замяна/изтичане/refund се проверяват детерминистично.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkProfileCustomizationStore.ts --server-root=.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import {
  PROFILE_CUSTOMIZATION_COLOR_GROUPS,
  PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES,
  PROFILE_CUSTOMIZATION_RESERVED_STAFF_COLOR,
  buildProfileCustomizationPriceTable,
  computeColorDeltaE,
  computeProfileCustomizationColorContrast,
  computeProfileCustomizationPriceCents,
  isReservedOrNearReservedStaffColor,
  normalizeProfileCustomizationEmoji,
  normalizeProfileCustomizationHex,
  parseEuroAmountToCents,
} from '../src/profileCustomization/profileCustomizationCatalog.js'
import {
  createProfileCustomizationStore,
  type ProfileCustomizationStore,
} from '../src/profileCustomization/profileCustomizationStore.js'
import { buildProfileCustomizationCheckoutProductName } from '../src/shop/checkoutProductNames.js'
import { buildProfileCustomizationCheckoutSessionParams, buildProfileCustomizationReturnUrls } from '../src/shop/checkoutSessionParams.js'

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}

function assertThrows(fn: () => unknown, fragment: string, message: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (text.includes(fragment)) return
    throw new Error(`${message}: грешка без "${fragment}": ${text}`)
  }
  throw new Error(`${message}: не хвърли грешка`)
}

const DAY = 86_400_000
const T0 = new Date('2027-01-10T12:00:00.000Z')
const at = (days: number): Date => new Date(T0.getTime() + days * DAY)
const iso = (days: number): string => at(days).toISOString()

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')
const NEW_MIGRATION = '20261107_001_create_profile_customization.sql'

console.log('\ncheckProfileCustomizationStore')
console.log(`Server root: ${sourceServerRoot}`)

async function createTempServerRoot(filter: (name: string) => boolean = () => true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-customization-'))
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.sql' || !filter(entry.name)) continue
    await cp(join(sourceMigrationsDirectoryPath, entry.name), join(root, 'database', 'migrations', entry.name))
  }
  return root
}

const tempRoots: string[] = []

/** Довършва всички миграции от репото в изолиран root (store-ът изисква последната схема). */
async function applyRemainingMigrations(root: string): Promise<void> {
  for (const entry of await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') await cp(join(sourceMigrationsDirectoryPath, entry.name), join(root, 'database', 'migrations', entry.name))
  }
  await ensureServerDatabaseReady({ serverRootOverride: root })
}
const mainRoot = await createTempServerRoot()
tempRoots.push(mainRoot)
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: mainRoot })

const sqliteModule = await import('node:sqlite')
const db = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
db.exec('PRAGMA foreign_keys = ON;')

const store: ProfileCustomizationStore = await createProfileCustomizationStore(databaseFilePath)
// Втора връзка към същата база — за повторен webhook от "друг процес".
const secondStore: ProfileCustomizationStore = await createProfileCustomizationStore(databaseFilePath)

function seedProfile(name: string, options: { human?: boolean; withAccount?: boolean } = {}): string {
  const profileId = randomUUID()
  let accountId: string | null = null
  if (options.withAccount !== false) {
    accountId = randomUUID()
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'x');`).run(accountId, `${accountId}@example.test`)
  }
  db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind) VALUES (?, ?, ?, ?, ?);`).run(
    profileId, accountId, name, name.toLowerCase(), options.human === false ? 'bot' : 'human',
  )
  return profileId
}

function enableAllSales(): void {
  for (const kind of ['nickname_color', 'message_color', 'emoji_before', 'emoji_after']) {
    const result = store.updateKindSettings(kind, { salesEnabled: true, basePrice30DaysCents: 199 })
    assert(result.ok, `enable ${kind}`)
  }
  // Публично в продажба са само 5 цвята (20261108_002, проверено в [I0]);
  // за проверките по-долу админът връща целия каталог (запазена възможност).
  for (const color of store.listColors({ includeInactive: true })) {
    if (!color.isActive) store.updateColor(color.colorId, { isActive: true })
  }
}

// ─── Поръчка с ЕДИН ред (досегашните проверки за една екстра) ─────────────
// Тънки обвивки върху поръчковия API: purchase = единственият ред на
// поръчката; webhook параметрите приемат id на реда и го превеждат към
// id на поръчката (непознат id остава непознат -> purchase_id_mismatch).

type SingleInput = { profileId: string; kind: string; itemId: string; days: number; now?: Date; ignoreSalesToggle?: boolean }

function createPendingPurchase(input: SingleInput) {
  const created = store.createPendingOrder({ profileId: input.profileId, items: [{ kind: input.kind, itemId: input.itemId, days: input.days }], now: input.now, ignoreSalesToggle: input.ignoreSalesToggle })
  if (!created.ok) return created
  return { ok: true as const, order: created.order, purchase: created.order.lines[0]!, preview: created.preview.lines[0]! }
}

function orderIdOf(purchaseOrOrderId: string): string {
  return store.getPurchaseById(purchaseOrOrderId)?.orderId ?? purchaseOrOrderId
}

function orderOf(purchaseId: string) {
  return store.getOrderById(orderIdOf(purchaseId))
}

function attachCheckoutSession(purchaseId: string, sessionId: string): void {
  store.attachOrderCheckoutSession(orderIdOf(purchaseId), sessionId)
}

type SingleFulfillParams = { checkoutSessionId: string; purchaseId: string; stripePaymentStatus: string; stripeCurrency: string; stripeAmountTotalCents: number; stripePaymentIntentId: string | null; now?: Date }

function fulfillPaidPurchase(params: SingleFulfillParams, target: ProfileCustomizationStore = store) {
  const { purchaseId, ...rest } = params
  const result = target.fulfillPaidOrder({ ...rest, orderId: orderIdOf(purchaseId) })
  if (!result.ok) return result
  return { ...result, purchase: result.order.lines[0]! }
}

let sessionCounter = 0
/** Поръчка (1..4 реда) -> сесия -> платен webhook. */
function buyAndPayOrder(profileId: string, items: Array<[kind: string, itemId: string, days: number]>, now: Date): { orderId: string; sessionId: string; paymentIntentId: string; totalCents: number; lineIds: Record<string, string> } {
  const created = store.createPendingOrder({ profileId, items: items.map(([kind, itemId, days]) => ({ kind, itemId, days })), now })
  if (!created.ok) throw new Error(`createPendingOrder: ${created.message}`)
  sessionCounter += 1
  const sessionId = `cs_test_${sessionCounter}_${randomUUID()}`
  const paymentIntentId = `pi_test_${sessionCounter}`
  store.attachOrderCheckoutSession(created.order.orderId, sessionId)
  const result = store.fulfillPaidOrder({
    checkoutSessionId: sessionId,
    orderId: created.order.orderId,
    stripePaymentStatus: 'paid',
    stripeCurrency: 'eur',
    stripeAmountTotalCents: created.order.totalCents,
    stripePaymentIntentId: paymentIntentId,
    now,
  })
  if (!result.ok) throw new Error(`fulfillPaidOrder: ${result.message}`)
  return {
    orderId: created.order.orderId,
    sessionId,
    paymentIntentId,
    totalCents: created.order.totalCents,
    lineIds: Object.fromEntries(result.order.lines.map((line) => [line.kind, line.purchaseId])),
  }
}

/** Поръчка с един ред -> сесия -> платен webhook. */
function buyAndPay(profileId: string, kind: string, itemId: string, days: number, now: Date): { purchaseId: string; orderId: string; sessionId: string; paymentIntentId: string } {
  const bought = buyAndPayOrder(profileId, [[kind, itemId, days]], now)
  return { purchaseId: bought.lineIds[kind] as string, orderId: bought.orderId, sessionId: bought.sessionId, paymentIntentId: bought.paymentIntentId }
}

/** Използваният вариант на вида (инвентар, 20261108_002) — без филтър за изтичане. */
function activeRow(profileId: string, kind: string): { item_id: string; active_until: string; chain_started_at: string } | undefined {
  return db.prepare(`
    SELECT o.item_id, o.active_until, o.chain_started_at
    FROM profile_customization_equipped e
    JOIN profile_customization_owned_items o ON o.profile_id = e.profile_id AND o.kind = e.kind AND o.item_id = e.item_id
    WHERE e.profile_id = ? AND e.kind = ?;
  `).get(profileId, kind) as
    | { item_id: string; active_until: string; chain_started_at: string }
    | undefined
}

/** Притежаван вариант (независимо дали се използва). */
function ownedRow(profileId: string, kind: string, itemId: string): { active_until: string; chain_started_at: string; chain_id: string } | undefined {
  return db.prepare(`SELECT active_until, chain_started_at, chain_id FROM profile_customization_owned_items WHERE profile_id = ? AND kind = ? AND item_id = ?;`).get(profileId, kind, itemId) as
    | { active_until: string; chain_started_at: string; chain_id: string }
    | undefined
}

try {
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[M] Миграция и начален каталог')

  await check('[M1] Таблиците съществуват; 4 вида с цена 1.99 € и изключена продажба', () => {
    for (const table of ['profile_customization_kind_settings', 'profile_customization_colors', 'profile_customization_emojis', 'profile_customization_purchases', 'profile_customization_orders', 'profile_customization_active']) {
      assert(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?;`).get(table) !== undefined, table)
    }
    const kinds = store.listKindSettings()
    assertEqual(kinds.length, 4, 'брой видове')
    for (const kind of kinds) {
      assertEqual(kind.basePrice30DaysCents, 199, `${kind.kind} цена`)
      assertEqual(kind.salesEnabled, false, `${kind.kind} продажба`)
    }
    assertEqual((db.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
  })

  await check('[M2] Одобрените 21 цвята = 7 групи × 3; контраст >= 4.5:1 на черно и бяло; далеч от служебния #F72585', () => {
    const colors = store.listColors({ includeInactive: true })
    assertEqual(colors.length, 21, 'брой цветове')
    for (const group of PROFILE_CUSTOMIZATION_COLOR_GROUPS) {
      assertEqual(colors.filter((color) => color.groupKey === group).length, 3, `група ${group}`)
    }
    console.log('        цвят      hex      на черно  на бяло  ΔE до #F72585')
    for (const color of colors) {
      const deltaE = computeColorDeltaE(color.hex, PROFILE_CUSTOMIZATION_RESERVED_STAFF_COLOR)
      console.log(`        ${color.colorId.padEnd(9)} ${color.hex}  ${color.contrast.onBlack.toFixed(2).padStart(6)}   ${color.contrast.onWhite.toFixed(2).padStart(6)}   ${deltaE.toFixed(1).padStart(5)}  ${color.label}`)
      assert(color.contrast.meetsMinimum, `${color.hex} контраст ${color.contrast.onBlack}/${color.contrast.onWhite}`)
      assert(!isReservedOrNearReservedStaffColor(color.hex), `${color.hex} е близо до служебния`)
    }
    // Одобрената палитра — точно тези стойности, всички >= 4.5:1 и на двата фона.
    const approved = '#E81729 #CD473E #D83656 #C74F14 #AD6326 #C25236 #976F08 #86751B #986E26 #14891E #1B8648 #3F8528 #0D847A #268089 #21846C #2B74D9 #4A67F7 #237DAD #9B4BEA #B43DD8 #805DDF'.split(' ')
    assertEqual(colors.map((color) => color.hex).join(' '), approved.join(' '), 'одобрената палитра')
    const below = colors.filter((color) => color.contrast.onBlack < 4.5 || color.contrast.onWhite < 4.5)
    assertEqual(below.map((color) => color.hex).join(' '), '', 'под 4.5:1')
  })

  await check('[M3] Емоджита: 500–700, всички 15 категории, всяко е точно едно RGI емоджи, без дубликати', () => {
    const emojis = store.listEmojis({ includeInactive: true })
    assert(emojis.length >= 500 && emojis.length <= 700, `брой ${emojis.length}`)
    console.log(`        общо ${emojis.length}: ${PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES.map((key) => `${key} ${emojis.filter((emoji) => emoji.categoryKey === key).length}`).join(', ')}`)
    for (const key of PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES) {
      assert(emojis.some((emoji) => emoji.categoryKey === key), `празна категория ${key}`)
    }
    const invalid = emojis.filter((emoji) => normalizeProfileCustomizationEmoji(emoji.emoji) !== emoji.emoji)
    assertEqual(invalid.length, 0, `невалидни ${invalid.map((emoji) => emoji.emoji).join(' ')}`)
    assertEqual(new Set(emojis.map((emoji) => emoji.emoji)).size, emojis.length, 'дубликати')
    for (const key of ['hearts', 'animals', 'bugs', 'ghosts', 'flowers', 'fruits', 'stars', 'crowns', 'kisses', 'smileys', 'symbols', 'games']) {
      assert(emojis.some((emoji) => emoji.categoryKey === key), key)
    }
  })

  await check('[M4] Схемата отказва: служебния цвят, смяна на hex/емоджи, грешна цена, непозволен срок', () => {
    assertThrows(() => db.prepare(`INSERT INTO profile_customization_colors (color_id, hex, label, group_key) VALUES ('x', '#F72585', 'X', 'red');`).run(), 'CHECK', 'служебен цвят')
    assertThrows(() => db.prepare(`UPDATE profile_customization_colors SET hex = '#123456' WHERE color_id = 'red-1';`).run(), 'profile_customization_color_hex_immutable', 'hex')
    assertThrows(() => db.prepare(`UPDATE profile_customization_emojis SET emoji = '🦴' WHERE emoji_id = 'emoji-0001';`).run(), 'profile_customization_emoji_value_immutable', 'емоджи')
    const profileId = seedProfile('SchemaCheck')
    const insert = (days: number, base: number, price: number, value = '#E81729') => db.prepare(`
      INSERT INTO profile_customization_purchases (purchase_id, profile_id, kind, item_id, item_value_snapshot, days_snapshot, base_price_30_days_cents_snapshot, price_cents_snapshot)
      VALUES (?, ?, 'nickname_color', 'red-1', ?, ?, ?, ?);
    `).run(randomUUID(), profileId, value, days, base, price)
    assertThrows(() => insert(90, 199, 596), 'CHECK', 'цена ≠ база × 3')
    assertThrows(() => insert(45, 199, 298), 'CHECK', 'срок 45')
    assertThrows(() => insert(30, 49, 49), 'CHECK', 'база < 50')
    assertThrows(() => insert(30, 199, 199, '#f72585'), 'CHECK', 'служебен цвят в покупка')
    insert(90, 199, 597)
  })

  await check('[M5] Повторно стартиране не дублира seed-а', async () => {
    await ensureServerDatabaseReady({ serverRootOverride: mainRoot })
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM profile_customization_colors;').get() as { c: number }).c, 21, 'цветове')
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM profile_customization_kind_settings;').get() as { c: number }).c, 4, 'видове')
  })

  await check('[M6] Надграждане на база отпреди миграцията: данните остават, foreign_key_check е чист', async () => {
    const upgradeRoot = await createTempServerRoot((name) => name.localeCompare(NEW_MIGRATION, 'en') < 0)
    tempRoots.push(upgradeRoot)
    const { databaseFilePath: upgradePath } = await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const before = new sqliteModule.DatabaseSync(upgradePath, { open: true })
    const profileId = randomUUID()
    before.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, 'Old', 'old');`).run(profileId)
    const profilesBefore = (before.prepare('SELECT COUNT(*) AS c FROM profiles;').get() as { c: number }).c
    assert(before.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'profile_customization_purchases';`).get() === undefined, 'таблицата не трябва да съществува преди')
    before.close()
    await cp(join(sourceMigrationsDirectoryPath, NEW_MIGRATION), join(upgradeRoot, 'database', 'migrations', NEW_MIGRATION))
    await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const after = new sqliteModule.DatabaseSync(upgradePath, { open: true })
    assertEqual((after.prepare('SELECT COUNT(*) AS c FROM profiles;').get() as { c: number }).c, profilesBefore, 'профили')
    assertEqual((after.prepare('SELECT COUNT(*) AS c FROM profile_customization_colors;').get() as { c: number }).c, 21, 'цветове')
    assertEqual((after.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
    after.close()
  })

  await check('[M7] 20261107_002: payment_review_issues е преизградена без загуба на редове; приема profile_customization', async () => {
    const SECOND = '20261107_002_allow_profile_customization_payment_review_issues.sql'
    const upgradeRoot = await createTempServerRoot((name) => name.localeCompare(SECOND, 'en') < 0)
    tempRoots.push(upgradeRoot)
    const { databaseFilePath: upgradePath } = await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const before = new sqliteModule.DatabaseSync(upgradePath, { open: true })
    before.prepare(`INSERT INTO payment_review_issues (issue_id, checkout_session_id, purchase_type, issue_kind, detail, is_transient) VALUES ('old-1', 'cs_old', 'vip', 'amount_mismatch', 'стар запис', 1);`).run()
    const snapshot = JSON.stringify(before.prepare('SELECT * FROM payment_review_issues ORDER BY issue_id;').all())
    assertThrows(() => before.prepare(`INSERT INTO payment_review_issues (issue_id, checkout_session_id, purchase_type, issue_kind, detail) VALUES ('x', 'cs_x', 'profile_customization', 'credit_failed', 'x');`).run(), 'CHECK', 'преди миграцията')
    before.close()
    await cp(join(sourceMigrationsDirectoryPath, SECOND), join(upgradeRoot, 'database', 'migrations', SECOND))
    await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const after = new sqliteModule.DatabaseSync(upgradePath, { open: true })
    assertEqual(JSON.stringify(after.prepare('SELECT * FROM payment_review_issues ORDER BY issue_id;').all()), snapshot, 'редовете')
    after.prepare(`INSERT INTO payment_review_issues (issue_id, checkout_session_id, purchase_type, issue_kind, detail) VALUES ('new-1', 'cs_new', 'profile_customization', 'credit_failed', 'x');`).run()
    assertThrows(() => after.prepare(`INSERT INTO payment_review_issues (issue_id, checkout_session_id, purchase_type, issue_kind, detail) VALUES ('new-2', 'cs_new2', 'gift', 'credit_failed', 'x');`).run(), 'CHECK', 'непознат тип')
    assertThrows(() => after.prepare(`INSERT INTO payment_review_issues (issue_id, checkout_session_id, purchase_type, issue_kind, detail) VALUES ('dup', 'cs_new', 'vip', 'credit_failed', 'x');`).run(), 'UNIQUE', 'UNIQUE(session, kind) е запазен')
    assert(after.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_payment_review_issues_status';`).get() !== undefined, 'индекс')
    after.close()
  })

  await check('[M8] 20261108_001: старите единични покупки стават поръчки с един ред (плащане/refund/преглед се пренасят; неплатените се скриват)', async () => {
    const ORDERS = '20261108_001_create_profile_customization_orders.sql'
    const upgradeRoot = await createTempServerRoot((name) => name.localeCompare(ORDERS, 'en') < 0)
    tempRoots.push(upgradeRoot)
    const { databaseFilePath: upgradePath } = await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const before = new sqliteModule.DatabaseSync(upgradePath, { open: true, enableForeignKeyConstraints: true })
    const profileId = randomUUID()
    before.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, 'Legacy', 'legacy');`).run(profileId)
    before.prepare(`
      INSERT INTO profile_customization_purchases (purchase_id, profile_id, kind, item_id, item_value_snapshot, days_snapshot, base_price_30_days_cents_snapshot,
        price_cents_snapshot, provider_checkout_session_id, status, credited_at, grant_effect, chain_id, granted_until_snapshot, stripe_payment_intent_id,
        refunded_at, refunded_amount_cents, refund_review_status, refund_review_reason, card_last4)
      VALUES ('legacy-paid', ?, 'nickname_color', 'red-1', '#E81729', 60, 199, 398, 'cs_legacy_paid', 'paid', '2026-11-07T10:00:00.000Z', 'new', 'chain-legacy',
        '2027-01-06T10:00:00.000Z', 'pi_legacy', '2026-11-07T11:00:00.000Z', 100, 'pending', 'partial_refund', '4242');
    `).run(profileId)
    for (const [id, kind] of [['legacy-pending-1', 'message_color'], ['legacy-pending-2', 'emoji_before']] as const) {
      before.prepare(`
        INSERT INTO profile_customization_purchases (purchase_id, profile_id, kind, item_id, item_value_snapshot, days_snapshot, base_price_30_days_cents_snapshot, price_cents_snapshot, provider_checkout_session_id, status)
        VALUES (?, ?, ?, ?, ?, 30, 199, 199, ?, 'pending');
      `).run(id, profileId, kind, kind === 'message_color' ? 'blue-1' : 'emoji-0001', kind === 'message_color' ? '#2B74D9' : '😀', `cs_${id}`)
    }
    before.close()
    await cp(join(sourceMigrationsDirectoryPath, ORDERS), join(upgradeRoot, 'database', 'migrations', ORDERS))
    await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const after = new sqliteModule.DatabaseSync(upgradePath, { open: true })
    const orders = after.prepare('SELECT * FROM profile_customization_orders ORDER BY order_id;').all() as Array<Record<string, unknown>>
    assertEqual(orders.length, 3, 'поръчки')
    const paid = orders.find((row) => row.order_id === 'legacy-paid')
    assert(paid?.status === 'paid' && paid.paid_at === '2026-11-07T10:00:00.000Z' && paid.total_cents === 398 && paid.item_count === 1
      && paid.provider_checkout_session_id === 'cs_legacy_paid' && paid.stripe_payment_intent_id === 'pi_legacy' && paid.refunded_amount_cents === 100
      && paid.refund_review_status === 'pending' && paid.refund_review_reason === 'partial_refund' && paid.card_last4 === '4242' && paid.hidden_at === null, JSON.stringify(paid))
    assert(orders.filter((row) => row.status === 'pending').every((row) => row.hidden_at !== null), 'неплатените са скрити (сесията им пак се намира)')
    const lines = after.prepare('SELECT purchase_id, order_id, hidden_at, status FROM profile_customization_purchases ORDER BY purchase_id;').all() as Array<Record<string, unknown>>
    assert(lines.every((line) => line.order_id === line.purchase_id), JSON.stringify(lines))
    assert(lines.filter((line) => line.status === 'pending').every((line) => line.hidden_at !== null), 'скрити редове')
    assertEqual((after.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
    after.close()
    // Пренесената стара поръчка се кредитира идемпотентно и се намира по сесия/payment intent.
    // Store-ът изисква и следващите миграции — прилагаме ги и тук.
    await applyRemainingMigrations(upgradeRoot)
    const upgradedStore = await createProfileCustomizationStore(upgradePath)
    try {
      const found = upgradedStore.findOrderByCheckoutSessionId('cs_legacy-pending-1')
      assert(found?.orderId === 'legacy-pending-1' && found.lines.length === 1, JSON.stringify(found))
      const replay = upgradedStore.fulfillPaidOrder({ checkoutSessionId: 'cs_legacy_paid', orderId: 'legacy-paid', stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 398, stripePaymentIntentId: 'pi_legacy' })
      assert(replay.ok && replay.alreadyCredited, 'стара платена поръчка -> alreadyCredited')
    } finally {
      upgradedStore.close()
    }
  })

  await check('[M9] 20261108_002: старите активни екстри стават притежавани и използвани (срок/верига запазени); 5 цвята в продажба; foreign_key_check е чист', async () => {
    const INVENTORY = '20261108_002_create_profile_customization_inventory.sql'
    const upgradeRoot = await createTempServerRoot((name) => name.localeCompare(INVENTORY, 'en') < 0)
    tempRoots.push(upgradeRoot)
    const { databaseFilePath: upgradePath } = await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const before = new sqliteModule.DatabaseSync(upgradePath, { open: true, enableForeignKeyConstraints: true })
    const profileId = randomUUID()
    before.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, 'LegacyActive', 'legacyactive');`).run(profileId)
    before.prepare(`INSERT INTO profile_customization_active (profile_id, kind, item_id, item_value_snapshot, item_label_snapshot, chain_id, chain_started_at, active_until) VALUES (?, 'nickname_color', 'teal-1', '#0D847A', 'Тюркоаз', 'chain-a', '2026-11-01T00:00:00.000Z', '2027-01-30T00:00:00.000Z');`).run(profileId)
    before.prepare(`INSERT INTO profile_customization_active (profile_id, kind, item_id, item_value_snapshot, chain_id, chain_started_at, active_until) VALUES (?, 'emoji_after', 'emoji-0003', '😄', 'chain-b', '2026-11-02T00:00:00.000Z', '2026-12-02T00:00:00.000Z');`).run(profileId)
    before.close()
    await cp(join(sourceMigrationsDirectoryPath, INVENTORY), join(upgradeRoot, 'database', 'migrations', INVENTORY))
    await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const after = new sqliteModule.DatabaseSync(upgradePath, { open: true })
    const owned = after.prepare('SELECT kind, item_id, chain_id, chain_started_at, active_until FROM profile_customization_owned_items WHERE profile_id = ? ORDER BY kind;').all(profileId) as Array<Record<string, unknown>>
    assert(owned.length === 2 && owned[0]?.item_id === 'emoji-0003' && owned[0].chain_id === 'chain-b' && owned[1]?.item_id === 'teal-1' && owned[1].active_until === '2027-01-30T00:00:00.000Z', JSON.stringify(owned))
    const equipped = after.prepare('SELECT kind, item_id FROM profile_customization_equipped WHERE profile_id = ? ORDER BY kind;').all(profileId) as Array<Record<string, unknown>>
    assert(equipped.length === 2 && equipped[1]?.item_id === 'teal-1', JSON.stringify(equipped))
    const active = (after.prepare('SELECT hex FROM profile_customization_colors WHERE is_active = 1 ORDER BY hex;').all() as Array<{ hex: string }>).map((row) => row.hex).join(' ')
    assertEqual(active, '#14891E #2B74D9 #976F08 #9B4BEA #E81729', '5 цвята в продажба')
    assertEqual((after.prepare('SELECT COUNT(*) AS c FROM profile_customization_colors;').get() as { c: number }).c, 21, 'нито един цвят не е изтрит')
    assertEqual((after.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
    after.close()
    // Пренесеният скрит цвят остава видим за собственика (използва се).
    await applyRemainingMigrations(upgradeRoot)
    const upgradedStore = await createProfileCustomizationStore(upgradePath)
    try {
      const appearance = upgradedStore.getAppearancesForProfiles([profileId], new Date('2026-12-01T00:00:00.000Z')).get(profileId)
      assert(appearance?.nicknameColor === '#0D847A' && appearance.emojiAfter === '😄', JSON.stringify(appearance))
    } finally {
      upgradedStore.close()
    }
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[P] Цени')

  await check('[P1] 1.99 € × 30/60/90/120/150/180 дни = 1.99/3.98/5.97/7.96/9.95/11.94 € (цели центове)', () => {
    const table = buildProfileCustomizationPriceTable(199)
    assertEqual(table.map((row) => `${row.days}:${row.priceCents}`).join(','), '30:199,60:398,90:597,120:796,150:995,180:1194', 'таблица')
    assert(table.every((row) => Number.isSafeInteger(row.priceCents)), 'цели числа')
    assertEqual(computeProfileCustomizationPriceCents(333, 180), 1998, '3.33 × 6')
  })

  await check('[P2] Разбор на сума в евро до центове без floating point', () => {
    const cases: Array<[string, number | null]> = [['1.99', 199], ['1,99', 199], ['12', 1200], ['0.5', 50], ['0.05', 5], ['1000.00', 100000], ['1.999', null], ['-1', null], ['1e2', null], ['', null], ['0.1', 10]]
    for (const [input, expected] of cases) assertEqual(parseEuroAmountToCents(input), expected, `"${input}"`)
  })

  await check('[P3] Невалидна базова цена се отказва (под 0.50 €, над 1000 €, дробни центове)', () => {
    for (const value of [49, 100_001, 1.5, Number.NaN]) {
      const result = store.updateKindSettings('nickname_color', { basePrice30DaysCents: value })
      assert(!result.ok && result.code === 'invalid_price', `цена ${value}`)
    }
    assert(!store.updateKindSettings('vip', { salesEnabled: true }).ok, 'невалиден вид')
    assertThrows(() => computeProfileCustomizationPriceCents(199, 45 as 30), 'invalid_duration', 'срок 45')
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[A] Админ управление на каталога')

  const paletteBuyer = seedProfile('PaletteBuyer')

  await check('[I0] Само 5 цвята в продажба (Червен/Син/Зелен/Лилав/Златист), еднакви за ника и текста; останалите 16 са запазени, но скрити; служебният е отказан', () => {
    const publicColors = store.listColors()
    assertEqual(publicColors.map((color) => color.hex).sort().join(' '), ['#14891E', '#2B74D9', '#976F08', '#9B4BEA', '#E81729'].join(' '), 'публичните цветове')
    const labels = Object.fromEntries(publicColors.map((color) => [color.hex, color.label]))
    assert(labels['#E81729'] === 'Червен' && labels['#2B74D9'] === 'Син' && labels['#14891E'] === 'Зелен' && labels['#9B4BEA'] === 'Лилав' && labels['#976F08'] === 'Златист', JSON.stringify(labels))
    assertEqual(store.listColors({ includeInactive: true }).length, 21, 'каталогът пази всичките 21 (история/админ)')
    for (const kind of ['nickname_color', 'message_color']) store.updateKindSettings(kind, { salesEnabled: true })
    for (const kind of ['nickname_color', 'message_color']) {
      for (const itemId of ['red-1', 'blue-1', 'green-1', 'purple-1', 'gold-1']) {
        assert(store.previewPurchase({ profileId: paletteBuyer, kind, itemId, days: 30, now: T0 }).ok, `${kind} ${itemId}`)
      }
      const hidden = store.previewPurchase({ profileId: paletteBuyer, kind, itemId: 'teal-1', days: 30, now: T0 })
      assert(!hidden.ok && hidden.code === 'item_not_for_sale', `${kind}: скрит цвят -> ${JSON.stringify(hidden)}`)
    }
    assertThrows(() => db.prepare(`INSERT INTO profile_customization_colors (color_id, hex, label, group_key) VALUES ('pink', '#F72585', 'Розово', 'red');`).run(), 'CHECK', 'служебният цвят')
    for (const kind of ['nickname_color', 'message_color']) store.updateKindSettings(kind, { salesEnabled: false })
    assertEqual(store.listEmojis().length, 655, '655 емоджита — непроменени')
  })

  await check('[A1] Цена и продажба се записват; таблицата с цени се преизчислява', () => {
    const result = store.updateKindSettings('emoji_after', { basePrice30DaysCents: 250, salesEnabled: true })
    assert(result.ok, 'update')
    if (!result.ok) return
    assertEqual(result.settings.salesEnabled, true, 'продажба')
    assertEqual(result.settings.priceTable.map((row) => row.priceCents).join(','), '250,500,750,1000,1250,1500', 'цени')
    const off = store.updateKindSettings('emoji_after', { salesEnabled: false })
    assert(off.ok && off.settings.basePrice30DaysCents === 250 && !off.settings.salesEnabled, 'само продажбата се изключва')
  })

  await check('[A2] Добавяне на цвят: валиден; отказва служебния, близък нюанс (#FF1493), невалиден hex, дубликат, празно име', () => {
    const added = store.addColor({ hex: '#5b3', label: 'Тревисто', groupKey: 'green' })
    assert(added.ok && added.color.hex === '#55BB33' && added.color.isActive, JSON.stringify(added))
    for (const hex of ['#F72585', '#f72585', '#FF1493', '#F82686', '#E0207A']) {
      const result = store.addColor({ hex, label: 'Розово', groupKey: 'red' })
      assert(!result.ok && result.code === 'reserved_color', `${hex}: ${JSON.stringify(result)}`)
    }
    assert(!store.addColor({ hex: 'zzz', label: 'X', groupKey: 'red' }).ok, 'невалиден hex')
    const duplicate = store.addColor({ hex: '#e81729', label: 'Пак', groupKey: 'red' })
    assert(!duplicate.ok && duplicate.code === 'duplicate', 'дубликат')
    assert(!store.addColor({ hex: '#123456', label: '   ', groupKey: 'red' }).ok, 'празно име')
    assert(!store.addColor({ hex: '#123456', label: 'Розов', groupKey: 'pink' }).ok, 'невалидна група')
    assertEqual(normalizeProfileCustomizationHex('#abc'), '#AABBCC', 'кратък hex')
  })

  await check('[A3] Нисък контраст се приема, но е маркиран (meetsMinimum=false)', () => {
    const added = store.addColor({ hex: '#FFFF00', label: 'Ярко жълто', groupKey: 'gold' })
    assert(added.ok && !added.color.contrast.meetsMinimum, JSON.stringify(added))
    if (added.ok) store.updateColor(added.color.colorId, { isActive: false })
    const contrast = computeProfileCustomizationColorContrast('#FFFF00')
    assert(contrast.onWhite < 3 && contrast.onBlack > 15, `жълто ${contrast.onWhite}/${contrast.onBlack}`)
  })

  await check('[A4] Редакция на цвят: име/група/подредба/скриване; hex не се променя', () => {
    const result = store.updateColor('teal-3', { label: 'Морско', sortOrder: 5, isActive: false })
    assert(result.ok && result.color.label === 'Морско' && !result.color.isActive && result.color.hex === '#21846C', JSON.stringify(result))
    assert(!store.listColors().some((color) => color.colorId === 'teal-3'), 'скритият не е в публичния списък')
    assert(store.listColors({ includeInactive: true }).some((color) => color.colorId === 'teal-3'), 'скритият е в админ списъка')
    store.updateColor('teal-3', { label: 'Морско зелено', sortOrder: 30, isActive: true })
    assert(!store.updateColor('missing', { isActive: true }).ok, 'липсващ')
  })

  await check('[A5] Емоджита: добавяне на ново; отказ за текст, две емоджита, текстова форма без VS16, дубликат', () => {
    const added = store.addEmoji({ emoji: '🦴', categoryKey: 'animals' })
    assert(added.ok && added.emoji.categoryKey === 'animals', JSON.stringify(added))
    for (const value of ['ab', '😀😀', '❤', '', '😀 ']) {
      const result = store.addEmoji({ emoji: value, categoryKey: 'smileys' })
      // '😀 ' се подрязва -> съществуващо -> duplicate; останалите са невалидни.
      assert(!result.ok, `"${value}" трябва да се откаже`)
    }
    assertEqual(normalizeProfileCustomizationEmoji('❤️'), '❤️', 'VS16 сърце')
    assertEqual(normalizeProfileCustomizationEmoji('🐻‍❄️'), '🐻‍❄️', 'ZWJ последователност')
    assert(!store.addEmoji({ emoji: '🦴', categoryKey: 'animals' }).ok, 'дубликат')
    assert(!store.addEmoji({ emoji: '🦷', categoryKey: 'nope' }).ok, 'невалидна категория')
    const hidden = store.updateEmoji('emoji-0001', { isActive: false, categoryKey: 'other' })
    assert(hidden.ok && !hidden.emoji.isActive && hidden.emoji.categoryKey === 'other', 'скриване')
    store.updateEmoji('emoji-0001', { isActive: true, categoryKey: 'smileys' })
  })

  await check('[A6] Режим на достъп: "Само админ" без записи; смяна с одит кой/кога; същият режим не пише; изтрит admin -> име анонимизирано', () => {
    const initial = store.getAccessState()
    assert(initial.mode === 'admin_only' && initial.changedAt === null, JSON.stringify(initial))
    const adminProfile = seedProfile('Админ')
    const activated = store.setAccessMode('public', { profileId: adminProfile, displayName: 'Админ' })
    assert(activated.changed && activated.state.mode === 'public' && activated.state.changedByDisplayName === 'Админ' && activated.state.changedByProfileId === adminProfile, JSON.stringify(activated))
    assert(!store.setAccessMode('public', { profileId: adminProfile, displayName: 'Админ' }).changed, 'без промяна')
    const deactivated = store.setAccessMode('admin_only', { profileId: adminProfile, displayName: 'Админ' })
    assert(deactivated.changed && deactivated.state.mode === 'admin_only', 'деактивиране')
    const history = store.listModeChanges(10)
    assert(history.length === 2 && history[0]!.mode === 'admin_only' && history[0]!.previousMode === 'public' && history[1]!.mode === 'public', JSON.stringify(history))
    assertThrows(() => store.setAccessMode('everyone' as 'public', { profileId: null, displayName: null }), 'invalid_mode', 'невалиден режим')
    assertThrows(() => db.prepare(`INSERT INTO profile_customization_mode_changes (change_id, mode, previous_mode) VALUES ('x', 'all', 'admin_only');`).run(), 'CHECK', 'CHECK на режима')
    db.prepare('DELETE FROM profiles WHERE profile_id = ?;').run(adminProfile)
    assert(store.getAccessState().changedByProfileId === null, 'FK SET NULL')
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[B] Покупка, кредитиране, удължаване, замяна, изтичане')

  const buyer = seedProfile('Buyer')

  await check('[B1] Изключена продажба / бот / профил без акаунт -> отказ', () => {
    const disabled = createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 30, now: T0 })
    assert(!disabled.ok && disabled.code === 'sales_disabled', JSON.stringify(disabled))
    enableAllSales()
    const bot = seedProfile('Bot', { human: false })
    const guest = seedProfile('Guest', { withAccount: false })
    for (const profileId of [bot, guest]) {
      const result = createPendingPurchase({ profileId, kind: 'nickname_color', itemId: 'red-1', days: 30, now: T0 })
      assert(!result.ok && result.code === 'profile_not_eligible', JSON.stringify(result))
    }
    const wrongType = createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'emoji-0001', days: 30, now: T0 })
    assert(!wrongType.ok && wrongType.code === 'item_not_found', 'емоджи като цвят')
    const wrongDays = createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 31, now: T0 })
    assert(!wrongDays.ok && wrongDays.code === 'invalid_duration', 'срок 31')
  })

  await check('[B2] Pending поръчка: цена от админ настройката, snapshot, повторно използване, нова при смяна на цената', () => {
    const first = createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 90, now: T0 })
    assert(first.ok, 'create')
    if (!first.ok) return
    assertEqual(first.purchase.priceCents, 597, 'цена 90 дни')
    assertEqual(first.purchase.itemValue, '#E81729', 'snapshot')
    assertEqual(first.preview.effect, 'new', 'ефект')
    const again = createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 90, now: T0 })
    assert(again.ok && again.purchase.purchaseId === first.purchase.purchaseId, 'същата поръчка')
    store.updateKindSettings('nickname_color', { basePrice30DaysCents: 299 })
    const repriced = createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 90, now: T0 })
    assert(repriced.ok && repriced.purchase.purchaseId !== first.purchase.purchaseId && repriced.purchase.priceCents === 897, 'нова поръчка с новата цена')
    const hiddenAt = (db.prepare('SELECT hidden_at FROM profile_customization_purchases WHERE purchase_id = ?;').get(first.purchase.purchaseId) as { hidden_at: string | null }).hidden_at
    assert(hiddenAt !== null, 'старата е скрита')
    store.updateKindSettings('nickname_color', { basePrice30DaysCents: 199 })
  })

  await check('[B3] Webhook проверки: липсваща сесия, грешен purchaseId, неплатено, валута, сума -> нищо не се активира', () => {
    const created = createPendingPurchase({ profileId: buyer, kind: 'message_color', itemId: 'blue-2', days: 60, now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    attachCheckoutSession(created.purchase.purchaseId, 'cs_checks')
    const base = { checkoutSessionId: 'cs_checks', purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 398, stripePaymentIntentId: 'pi_checks', now: T0 }
    const expectReason = (overrides: Partial<typeof base>, reason: string) => {
      const result = fulfillPaidPurchase({ ...base, ...overrides })
      assert(!result.ok && result.reason === reason, `${reason}: ${JSON.stringify(result)}`)
    }
    expectReason({ checkoutSessionId: 'cs_unknown' }, 'purchase_not_found')
    expectReason({ purchaseId: randomUUID() }, 'purchase_id_mismatch')
    expectReason({ stripePaymentStatus: 'unpaid' }, 'not_paid')
    expectReason({ stripeCurrency: 'usd' }, 'currency_mismatch')
    expectReason({ stripeAmountTotalCents: 397 }, 'amount_mismatch')
    assertEqual(activeRow(buyer, 'message_color'), undefined, 'няма активна екстра')
    store.markOrderCanceledByCheckoutSessionId('cs_checks')
    assertEqual(store.getPurchaseById(created.purchase.purchaseId)?.status, 'canceled', 'canceled')
  })

  let firstNicknamePurchase = ''
  await check('[B4] Успешно плащане: ефект "new", срок 30 дни от плащането; повторен webhook (друга връзка) не удвоява', () => {
    const bought = buyAndPay(buyer, 'nickname_color', 'red-1', 30, T0)
    firstNicknamePurchase = bought.purchaseId
    const row = activeRow(buyer, 'nickname_color')
    assert(row !== undefined && row.item_id === 'red-1' && row.active_until === iso(30), JSON.stringify(row))
    const purchase = store.getPurchaseById(bought.purchaseId)
    assert(purchase?.status === 'paid' && purchase.grantEffect === 'new' && purchase.grantedUntil === iso(30), JSON.stringify(purchase))
    for (const s of [store, secondStore]) {
      const replay = fulfillPaidPurchase({ checkoutSessionId: bought.sessionId, purchaseId: bought.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 199, stripePaymentIntentId: bought.paymentIntentId, now: at(1) }, s)
      assert(replay.ok && replay.alreadyCredited, 'alreadyCredited')
    }
    assertEqual(activeRow(buyer, 'nickname_color')?.active_until, iso(30), 'срокът не е удвоен')
  })

  await check('[B5] Същият цвят при оставащи 20 дни + 90 дни = 110 дни ("extend", същата верига)', () => {
    const preview = store.previewPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 90, now: at(10) })
    assert(preview.ok && preview.preview.effect === 'extend' && preview.preview.current?.remainingDays === 20 && preview.preview.resultingActiveUntil === iso(120), JSON.stringify(preview))
    const bought = buyAndPay(buyer, 'nickname_color', 'red-1', 90, at(10))
    const active = store.getProfileActiveItems(buyer, at(10)).nickname_color
    assert(active !== null && active.remainingDays === 110 && active.activeUntil === iso(120), JSON.stringify(active))
    const purchase = store.getPurchaseById(bought.purchaseId)
    const first = store.getPurchaseById(firstNicknamePurchase)
    assert(purchase?.grantEffect === 'extend' && purchase.chainId === first?.chainId, 'същата верига')
  })

  await check('[B6] Различен цвят: добавя се в инвентара БЕЗ загуба на дни ("new"); новият се използва, старият остава "Наличен" с всичките си дни', () => {
    const preview = store.previewPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'green-2', days: 30, now: at(20) })
    assert(preview.ok && preview.preview.effect === 'new' && preview.preview.forfeitedDays === 0 && preview.preview.current === null, JSON.stringify(preview))
    const bought = buyAndPay(buyer, 'nickname_color', 'green-2', 30, at(20))
    const row = activeRow(buyer, 'nickname_color')
    assert(row?.item_id === 'green-2' && row.active_until === iso(50) && row.chain_started_at === iso(20), JSON.stringify(row))
    const purchase = store.getPurchaseById(bought.purchaseId)
    assert(purchase?.grantEffect === 'new' && purchase.replacedItemValue === null && purchase.replacedActiveUntil === null, JSON.stringify(purchase))
    assertEqual(ownedRow(buyer, 'nickname_color', 'red-1')?.active_until, iso(120), 'червеният пази всичките си дни')
    const owned = store.getProfileOwnedItems(buyer, at(20))
    const nick = owned.filter((item) => item.kind === 'nickname_color')
    assert(nick.length === 2 && nick.find((item) => item.itemId === 'green-2')?.equipped === true && nick.find((item) => item.itemId === 'red-1')?.equipped === false && nick.find((item) => item.itemId === 'red-1')?.remainingDays === 100, JSON.stringify(nick))
  })

  await check('[B7] Четирите вида са независими', () => {
    buyAndPay(buyer, 'emoji_before', 'emoji-0001', 60, at(20))
    buyAndPay(buyer, 'emoji_after', 'emoji-0002', 30, at(20))
    const items = store.getProfileActiveItems(buyer, at(21))
    assert(items.nickname_color?.itemId === 'green-2' && items.emoji_before?.value === '😀' && items.emoji_after?.value === '😃' && items.message_color === null, JSON.stringify(items))
    const appearance = store.getAppearancesForProfiles([buyer], at(21)).get(buyer)
    assert(appearance?.nicknameColor === '#1B8648' && appearance.emojiBefore === '😀' && appearance.emojiAfter === '😃' && appearance.messageColor === null, JSON.stringify(appearance))
    // Етап 3: всяка екстра носи срока си (клиентът спира да я показва точно тогава).
    assert(appearance.nicknameColorUntil === iso(50) && appearance.emojiBeforeUntil === iso(80) && appearance.emojiAfterUntil === iso(50) && appearance.messageColorUntil === null, JSON.stringify(appearance))
  })

  await check('[B8] Скрит артикул: нов купувач не може, собственикът на активния може да удължи; активната екстра остава', () => {
    store.updateColor('green-2', { isActive: false })
    const other = seedProfile('Other')
    const blocked = createPendingPurchase({ profileId: other, kind: 'nickname_color', itemId: 'green-2', days: 30, now: at(21) })
    assert(!blocked.ok && blocked.code === 'item_not_for_sale', JSON.stringify(blocked))
    const extend = store.previewPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'green-2', days: 30, now: at(21) })
    assert(extend.ok && extend.preview.effect === 'extend', JSON.stringify(extend))
    assertEqual(store.getAppearancesForProfiles([buyer], at(21)).get(buyer)?.nicknameColor, '#1B8648', 'остава активен')
    store.updateColor('green-2', { isActive: true })
  })

  await check('[B9] Изтичане на използвания: ефектът спира, друг валиден вариант НЕ се активира сам; изтеклият не е в инвентара и не може да се използва; нова покупка = нова верига', () => {
    assertEqual(store.getAppearancesForProfiles([buyer], at(50)).get(buyer)?.nicknameColor ?? null, null, 'изтекъл в момента на active_until')
    assertEqual(store.getProfileActiveItems(buyer, at(51)).nickname_color, null, 'изтекъл')
    const owned = store.getProfileOwnedItems(buyer, at(51)).filter((item) => item.kind === 'nickname_color')
    assert(owned.length === 1 && owned[0]?.itemId === 'red-1' && owned[0].equipped === false, `само червеният (валиден, неизползван): ${JSON.stringify(owned)}`)
    const expiredEquip = store.equipItem({ profileId: buyer, kind: 'nickname_color', itemId: 'green-2', now: at(51) })
    assert(!expiredEquip.ok && expiredEquip.code === 'expired', JSON.stringify(expiredEquip))
    const preview = store.previewPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'green-2', days: 30, now: at(51) })
    assert(preview.ok && preview.preview.effect === 'new' && preview.preview.current === null, JSON.stringify(preview))
    const bought = buyAndPay(buyer, 'nickname_color', 'green-2', 30, at(51))
    const purchase = store.getPurchaseById(bought.purchaseId)
    assert(purchase?.grantEffect === 'new' && activeRow(buyer, 'nickname_color')?.chain_started_at === iso(51), 'нова верига')
  })

  await check('[B10] Групово извличане: 1200 профила (над chunk-а от 500) -> точни резултати, без несъществуващите', () => {
    const ids: string[] = []
    const now = at(60)
    for (let i = 0; i < 3; i += 1) {
      const profileId = seedProfile(`Batch${i}`)
      buyAndPay(profileId, 'message_color', 'purple-2', 30, now)
      ids.push(profileId)
    }
    const all = [...Array.from({ length: 1197 }, () => randomUUID()), ...ids, ids[0] as string]
    const map = store.getAppearancesForProfiles(all, at(61))
    assertEqual(map.size, 3, 'брой')
    assert(ids.every((id) => map.get(id)?.messageColor === '#B43DD8'), 'стойности')
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[R] Възстановяване на плащане (refund)')

  await check('[R1] Пълен refund на единствената покупка -> екстрата е премахната; повторен refund е idempotent', () => {
    const user = seedProfile('R1')
    const bought = buyAndPay(user, 'emoji_before', 'emoji-0100', 30, T0)
    const result = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r1', now: at(1) })
    assert(result.ok && result.outcome === 'revoked' && result.activeAfter.emoji_before === null, JSON.stringify(result))
    assertEqual(activeRow(user, 'emoji_before'), undefined, 'редът е изтрит')
    assertEqual(store.getPurchaseById(bought.purchaseId)?.status, 'refunded', 'статус')
    const again = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r1b', now: at(2) })
    assert(again.ok && again.outcome === 'already_refunded', JSON.stringify(again))
    const replay = fulfillPaidPurchase({ checkoutSessionId: bought.sessionId, purchaseId: bought.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 199, stripePaymentIntentId: null, now: at(2) })
    assert(replay.ok && replay.alreadyCredited && activeRow(user, 'emoji_before') === undefined, 'повторен completed не връща екстрата')
  })

  await check('[R2] Верига P(30)+Q(90): refund на последното удължаване Q -> срокът се връща на P', () => {
    const user = seedProfile('R2')
    buyAndPay(user, 'nickname_color', 'blue-1', 30, T0)
    const q = buyAndPay(user, 'nickname_color', 'blue-1', 90, at(5))
    assertEqual(activeRow(user, 'nickname_color')?.active_until, iso(120), 'преди')
    const result = store.applyRefund({ paymentIntentId: q.paymentIntentId, refundedAmountCents: 597, stripeEventId: 'evt_r2', now: at(6) })
    assert(result.ok && result.outcome === 'revoked', JSON.stringify(result))
    assertEqual(activeRow(user, 'nickname_color')?.active_until, iso(30), 'след')
  })

  await check('[R3] Верига P(30)+Q(90): refund на първата P -> Q запазва всичките си 90 дни', () => {
    const user = seedProfile('R3')
    const p = buyAndPay(user, 'nickname_color', 'blue-1', 30, T0)
    buyAndPay(user, 'nickname_color', 'blue-1', 90, at(5))
    const result = store.applyRefund({ checkoutSessionId: p.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r3', now: at(6) })
    assert(result.ok && result.outcome === 'revoked', JSON.stringify(result))
    const row = activeRow(user, 'nickname_color')
    assert(row?.item_id === 'blue-1' && row.active_until === iso(90), JSON.stringify(row))
  })

  await check('[R4] Refund на НЕизползван вариант: само той изчезва от инвентара; използваният (друга покупка) не се засяга', () => {
    const user = seedProfile('R4')
    const old = buyAndPay(user, 'nickname_color', 'orange-2', 90, T0)
    buyAndPay(user, 'nickname_color', 'gold-2', 30, at(10))
    const result = store.applyRefund({ checkoutSessionId: old.sessionId, refundedAmountCents: 597, stripeEventId: 'evt_r4', now: at(11) })
    assert(result.ok && result.outcome === 'revoked', JSON.stringify(result))
    const row = activeRow(user, 'nickname_color')
    assert(row?.item_id === 'gold-2' && row.active_until === iso(40), JSON.stringify(row))
    assertEqual(ownedRow(user, 'nickname_color', 'orange-2'), undefined, 'възстановеният вариант е премахнат')
  })

  await check('[R5] Refund на използвания вариант -> ефектът спира, другият притежаван остава "Наличен" с всичките си дни (не се активира сам)', () => {
    const user = seedProfile('R5')
    buyAndPay(user, 'nickname_color', 'orange-2', 90, T0)
    const second = buyAndPay(user, 'nickname_color', 'gold-2', 30, at(10))
    const result = store.applyRefund({ checkoutSessionId: second.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r5', now: at(11) })
    assert(result.ok && result.outcome === 'revoked' && result.activeAfter.nickname_color === null, JSON.stringify(result))
    assertEqual(store.getAppearancesForProfiles([user], at(11)).get(user)?.nicknameColor ?? null, null, 'стандартен вид')
    assertEqual(ownedRow(user, 'nickname_color', 'orange-2')?.active_until, iso(90), 'другият вариант пази срока си')
    assertEqual(db.prepare('SELECT COUNT(*) AS c FROM profile_customization_equipped WHERE profile_id = ?;').get(user) && (db.prepare('SELECT COUNT(*) AS c FROM profile_customization_equipped WHERE profile_id = ?;').get(user) as { c: number }).c, 0, 'няма използван')
  })

  await check('[R6] Частичен refund -> задължително маркиран за преглед, правата остават; прегледан; после пълен -> премахнати', () => {
    const user = seedProfile('R6')
    const bought = buyAndPay(user, 'message_color', 'red-2', 60, T0)
    const partial = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 100, stripeEventId: 'evt_r6a', now: at(1) })
    assert(partial.ok && partial.outcome === 'partial_recorded' && partial.activeAfter.message_color?.activeUntil === iso(60), JSON.stringify(partial))
    const purchase = store.getPurchaseById(bought.purchaseId)
    const order = orderOf(bought.purchaseId)
    // Поръчка с един ред: частичната сума се отнася еднозначно към него.
    assert(purchase?.status === 'paid' && purchase.refundedAmountCents === 100 && purchase.refundedAt !== null, JSON.stringify(purchase))
    assert(order?.status === 'paid' && order.refundedAmountCents === 100 && order.refundReviewStatus === 'pending', JSON.stringify(order))
    assert(store.countPendingRefundReviews() === 1, 'брояч за преглед')
    const reviewList = store.listAdminOrders({ limit: 10, offset: 0, status: 'review_pending' })
    assert(reviewList.total === 1 && reviewList.rows[0]?.orderId === bought.orderId, 'филтър "чака преглед"')
    const duplicatePartial = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 100, stripeEventId: 'evt_r6a_dup', now: at(1) })
    assert(duplicatePartial.ok && duplicatePartial.outcome === 'partial_recorded', 'повторен частичен')
    assert(store.markRefundReviewed(bought.purchaseId) && !store.markRefundReviewed(bought.orderId), 'прегледан веднъж (по id на реда или на поръчката)')
    assert(store.countPendingRefundReviews() === 0, 'няма чакащи')
    const sameAgain = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 100, stripeEventId: 'evt_r6a_dup2', now: at(1) })
    assert(sameAgain.ok && orderOf(bought.purchaseId)?.refundReviewStatus === 'reviewed', 'същата сума не връща за преглед')
    store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 150, stripeEventId: 'evt_r6a_more', now: at(1) })
    assert(orderOf(bought.purchaseId)?.refundReviewStatus === 'pending', 'по-голяма частична сума -> пак за преглед')
    const full = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 398, stripeEventId: 'evt_r6b', now: at(2) })
    assert(full.ok && full.outcome === 'revoked' && activeRow(user, 'message_color') === undefined, JSON.stringify(full))
    const stale = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 100, stripeEventId: 'evt_r6a', now: at(3) })
    assert(stale.ok && stale.outcome === 'already_refunded' && orderOf(bought.purchaseId)?.refundedAmountCents === 398 && store.getPurchaseById(bought.purchaseId)?.refundedAmountCents === 398, 'закъсняло събитие не намалява сумата')
  })

  await check('[R7] Refund преди checkout.session.completed -> кредитирането не активира нищо', () => {
    const user = seedProfile('R7')
    const created = createPendingPurchase({ profileId: user, kind: 'emoji_after', itemId: 'emoji-0200', days: 30, now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    attachCheckoutSession(created.purchase.purchaseId, 'cs_r7')
    const early = store.applyRefund({ checkoutSessionId: 'cs_r7', refundedAmountCents: 199, stripeEventId: 'evt_r7', now: T0 })
    assert(early.ok && early.outcome === 'recorded_before_credit', JSON.stringify(early))
    const fulfill = fulfillPaidPurchase({ checkoutSessionId: 'cs_r7', purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 199, stripePaymentIntentId: 'pi_r7', now: at(0.01) })
    assert(fulfill.ok && fulfill.refundedBeforeCredit && !fulfill.alreadyCredited, JSON.stringify(fulfill))
    assertEqual(store.getPurchaseById(created.purchase.purchaseId)?.status, 'refunded', 'статус')
    assertEqual(activeRow(user, 'emoji_after'), undefined, 'нищо активно')
  })

  await check('[R7b] Частичен refund преди checkout.session.completed -> правата се активират, покупката чака преглед', () => {
    const user = seedProfile('R7b')
    const created = createPendingPurchase({ profileId: user, kind: 'emoji_after', itemId: 'emoji-0201', days: 60, now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    attachCheckoutSession(created.purchase.purchaseId, 'cs_r7b')
    store.applyRefund({ checkoutSessionId: 'cs_r7b', refundedAmountCents: 50, stripeEventId: 'evt_r7b', now: T0 })
    const fulfill = fulfillPaidPurchase({ checkoutSessionId: 'cs_r7b', purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 398, stripePaymentIntentId: 'pi_r7b', now: T0 })
    assert(fulfill.ok && !fulfill.refundedBeforeCredit && fulfill.purchase.status === 'paid' && fulfill.order.refundReviewStatus === 'pending' && fulfill.order.refundReviewReason === 'partial_refund', JSON.stringify(fulfill))
    assert(activeRow(user, 'emoji_after') !== undefined, 'активна')
  })

  await check('[R8] Удължаване СЛЕД refund в средата на веригата се натрупва правилно', () => {
    const user = seedProfile('R8')
    const p = buyAndPay(user, 'emoji_before', 'emoji-0300', 30, T0)
    buyAndPay(user, 'emoji_before', 'emoji-0300', 30, at(5))
    store.applyRefund({ checkoutSessionId: p.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r8', now: at(6) })
    assertEqual(activeRow(user, 'emoji_before')?.active_until, iso(30), 'след refund')
    buyAndPay(user, 'emoji_before', 'emoji-0300', 30, at(10))
    assertEqual(activeRow(user, 'emoji_before')?.active_until, iso(60), 'след новото удължаване')
  })

  await check('[R9] Refund, който съкращава веригата в миналото -> изтекла; следваща покупка започва нова верига', () => {
    const user = seedProfile('R9')
    buyAndPay(user, 'message_color', 'teal-1', 30, T0)
    const q = buyAndPay(user, 'message_color', 'teal-1', 90, at(20))
    store.applyRefund({ checkoutSessionId: q.sessionId, refundedAmountCents: 597, stripeEventId: 'evt_r9', now: at(40) })
    assertEqual(store.getProfileActiveItems(user, at(40)).message_color, null, 'изтекла')
    const preview = store.previewPurchase({ profileId: user, kind: 'message_color', itemId: 'teal-1', days: 30, now: at(40) })
    assert(preview.ok && preview.preview.effect === 'new', JSON.stringify(preview))
  })

  await check('[R10] Непозната покупка / без идентификатори -> отказ без промени', () => {
    const unknown = store.applyRefund({ paymentIntentId: 'pi_nope', refundedAmountCents: 100, stripeEventId: 'evt_x' })
    assert(!unknown.ok && unknown.reason === 'purchase_not_found', JSON.stringify(unknown))
    const empty = store.applyRefund({ refundedAmountCents: 100, stripeEventId: 'evt_y' })
    assert(!empty.ok && empty.reason === 'invalid_request', JSON.stringify(empty))
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[D] Изтриване на профил')

  await check('[D1] Изтрит профил: покупките остават (profile_id NULL), активните екстри се изтриват', () => {
    const user = seedProfile('Deleted')
    const bought = buyAndPay(user, 'nickname_color', 'purple-1', 30, T0)
    db.prepare('UPDATE profile_customization_purchases SET deleted_profile_id_snapshot = ? WHERE profile_id = ?;').run(user, user)
    db.prepare('UPDATE profile_customization_orders SET deleted_profile_id_snapshot = ? WHERE profile_id = ?;').run(user, user)
    db.prepare('DELETE FROM profiles WHERE profile_id = ?;').run(user)
    const row = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, status, price_cents_snapshot FROM profile_customization_purchases WHERE purchase_id = ?;').get(bought.purchaseId) as Record<string, unknown>
    assert(row.profile_id === null && row.deleted_profile_id_snapshot === user && row.status === 'paid' && row.price_cents_snapshot === 199, JSON.stringify(row))
    const orderRow = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, status, total_cents FROM profile_customization_orders WHERE order_id = ?;').get(bought.orderId) as Record<string, unknown>
    assert(orderRow.profile_id === null && orderRow.deleted_profile_id_snapshot === user && orderRow.status === 'paid' && orderRow.total_cents === 199, JSON.stringify(orderRow))
    assertEqual(activeRow(user, 'nickname_color'), undefined, 'CASCADE')
    const replay = fulfillPaidPurchase({ checkoutSessionId: bought.sessionId, purchaseId: bought.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 199, stripePaymentIntentId: null })
    assert(replay.ok && replay.alreadyCredited && Object.values(replay.active).every((item) => item === null), 'повторен webhook след изтриване')
  })

  await check('[D2] Executor-ът покрива всяка *_profile_id_snapshot колона (вкл. новата)', async () => {
    const source = (await readFile(join(sourceServerRoot, 'src', 'db', 'profileDeletionExecutor.ts'), 'utf8')).replace(/\s+/g, ' ')
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table';`).all() as Array<{ name: string }>).map((row) => row.name)
    const missing: string[] = []
    for (const table of tables) {
      for (const { name } of db.prepare('SELECT name FROM pragma_table_info(?);').all(table) as Array<{ name: string }>) {
        if (!/^deleted_.*profile_id_snapshot$/.test(name)) continue
        if (!new RegExp(`UPDATE ${table} SET [^;]*${name}`).test(source)) missing.push(`${table}.${name}`)
      }
    }
    assertEqual(missing.join(', '), '', 'непокрити')
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[C] Stripe Checkout (подготовка)')

  await check('[C1] Име на продукта: Pika.bg + вид + конкретния цвят/емоджи + срок', () => {
    const color = buildProfileCustomizationCheckoutProductName({ kindLabel: 'Цвят на никнейма', itemType: 'color', itemValue: '#E81729', itemLabel: 'Алено', days: 90 })
    assertEqual(color, 'Pika.bg — Цвят на никнейма: Алено (#E81729) — 90 дни', 'цвят')
    const emoji = buildProfileCustomizationCheckoutProductName({ kindLabel: 'Емоджи пред никнейма', itemType: 'emoji', itemValue: '🦋', itemLabel: null, days: 30 })
    assertEqual(emoji, 'Pika.bg — Емоджи пред никнейма: 🦋 — 30 дни', 'емоджи')
  })

  await check('[C2] Параметри на сесията: сумата/валутата/името са от snapshot-а; metadata.purchaseType', () => {
    const user = seedProfile('Checkout')
    const created = createPendingPurchase({ profileId: user, kind: 'message_color', itemId: 'gold-1', days: 150, now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    const params = buildProfileCustomizationCheckoutSessionParams(created.order, user, { successUrl: 'https://pika.bg/ok', cancelUrl: 'https://pika.bg/cancel' })
    const item = params.line_items?.[0]
    assertEqual(params.line_items?.length, 1, 'един ред')
    assertEqual(item?.price_data?.unit_amount, 995, 'сума')
    assertEqual(item?.price_data?.currency, 'eur', 'валута')
    assertEqual(item?.price_data?.product_data?.name, 'Pika.bg — Цвят на текста на съобщенията: Златист (#976F08) — 150 дни', 'име')
    assertEqual(params.metadata?.purchaseType, 'profile_customization', 'purchaseType')
    assertEqual(params.metadata?.orderId, created.order.orderId, 'orderId')
    assertEqual(params.metadata?.purchaseId, created.order.orderId, 'purchaseId = orderId')
  })

  await check('[C3] Админ статистика: платени/възстановени/активни по вид', () => {
    const stats = store.getAdminKindStats(at(21))
    const nickname = stats.find((row) => row.kind === 'nickname_color')
    assert(nickname !== undefined && nickname.paidCount > 0 && nickname.refundedCount > 0 && nickname.activeNowCount > 0, JSON.stringify(nickname))
    const page = store.listAdminOrders({ limit: 5, offset: 0, status: 'refunded' })
    assert(page.total > 0 && page.rows.every((row) => row.status === 'refunded') && page.rows.length <= 5, JSON.stringify(page.total))
  })

  await check('[C4] Return URL: session_id={CHECKOUT_SESSION_ID} (литерал за Stripe); произход CLIENT_ORIGIN -> STRIPE_SUCCESS_URL -> dev', () => {
    const fromClient = buildProfileCustomizationReturnUrls({ CLIENT_ORIGIN: 'https://www.pika.bg', STRIPE_SUCCESS_URL: 'https://other.example/x' })
    assertEqual(fromClient.successUrl, 'https://www.pika.bg/lobby?customization=success&session_id={CHECKOUT_SESSION_ID}', 'success')
    assertEqual(fromClient.cancelUrl, 'https://www.pika.bg/lobby?customization=cancel', 'cancel')
    const fromStripeEnv = buildProfileCustomizationReturnUrls({ STRIPE_SUCCESS_URL: 'https://www.pika.bg/?screen=shop&payment=success&session_id={CHECKOUT_SESSION_ID}' })
    assertEqual(fromStripeEnv.origin, 'https://www.pika.bg', 'произход от STRIPE_SUCCESS_URL')
    assertEqual(buildProfileCustomizationReturnUrls({ CLIENT_ORIGIN: '  ' }).origin, 'http://localhost:5173', 'dev')
    assertEqual(buildProfileCustomizationReturnUrls({ CLIENT_ORIGIN: 'javascript:alert(1)' }).origin, 'http://localhost:5173', 'невалиден протокол')
    // Клиентът чете точно session_id и customization (src/main.ts).
    const parsed = new URL(fromClient.successUrl.replace('{CHECKOUT_SESSION_ID}', 'cs_live_abc'))
    assert(parsed.searchParams.get('session_id') === 'cs_live_abc' && parsed.searchParams.get('customization') === 'success' && parsed.pathname === '/lobby', parsed.href)
  })

  await check('[R11] Неуспешен refund след анулиране: маркира за преглед (refund_failed), НЕ възстановява автоматично; idempotent; прегледът пази кой/кога', () => {
    const user = seedProfile('R11')
    const reviewer = seedProfile('Проверяващ')
    const bought = buyAndPay(user, 'nickname_color', 'red-2', 30, T0)
    store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r11_refund', now: at(1) })
    assertEqual(activeRow(user, 'nickname_color'), undefined, 'анулирано')
    const failed = store.recordRefundFailure({ paymentIntentId: bought.paymentIntentId, stripeRefundId: 're_r11', stripeEventId: 'evt_r11_failed' })
    assert(failed.ok && failed.outcome === 'marked_for_review' && failed.order.refundReviewStatus === 'pending' && failed.order.refundReviewReason === 'refund_failed', JSON.stringify(failed))
    assertEqual(activeRow(user, 'nickname_color'), undefined, 'няма автоматично възстановяване')
    assertEqual(store.getPurchaseById(bought.purchaseId)?.status, 'refunded', 'статусът не се пипа')
    const again = store.recordRefundFailure({ paymentIntentId: bought.paymentIntentId, stripeRefundId: 're_r11', stripeEventId: 'evt_r11_failed_dup' })
    assert(again.ok && again.outcome === 'already_recorded', 'повторна доставка')
    assert(store.markRefundReviewed(bought.purchaseId, { profileId: reviewer, displayName: 'Проверяващ' }), 'преглед')
    const reviewed = orderOf(bought.purchaseId)
    assert(reviewed?.refundReviewStatus === 'reviewed' && reviewed.refundReviewedByDisplayName === 'Проверяващ' && reviewed.refundReviewedAt !== null, JSON.stringify(reviewed))
    const reviewerId = (db.prepare('SELECT refund_reviewed_by_profile_id AS id FROM profile_customization_orders WHERE order_id = ?;').get(bought.orderId) as { id: string }).id
    assertEqual(reviewerId, reviewer, 'кой')
    const redelivered = store.recordRefundFailure({ paymentIntentId: bought.paymentIntentId, stripeRefundId: 're_r11', stripeEventId: 'evt_r11_failed_dup2' })
    assert(redelivered.ok && redelivered.outcome === 'already_recorded' && orderOf(bought.purchaseId)?.refundReviewStatus === 'reviewed', 'прегледан случай не се отваря отново')
    const unknown = store.recordRefundFailure({ paymentIntentId: 'pi_unknown_r11', stripeRefundId: 're_x', stripeEventId: 'evt_x' })
    assert(!unknown.ok && unknown.reason === 'purchase_not_found', 'непозната')
  })

  await check('[R12] Неуспешен refund, пристигнал ПРЕДИ charge.refunded: случаят остава маркиран и след анулирането', () => {
    const user = seedProfile('R12')
    const bought = buyAndPay(user, 'emoji_after', 'emoji-0400', 30, T0)
    store.recordRefundFailure({ checkoutSessionId: bought.sessionId, stripeRefundId: 're_r12', stripeEventId: 'evt_r12_failed' })
    store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r12_refund', now: at(1) })
    const order = orderOf(bought.purchaseId)
    assert(order?.status === 'refunded' && order.lines[0]?.status === 'refunded' && order.refundReviewStatus === 'pending' && order.refundReviewReason === 'refund_failed', JSON.stringify(order))
  })

  await check('[R13] Частичният refund записва причина partial_refund', () => {
    const user = seedProfile('R13')
    const bought = buyAndPay(user, 'message_color', 'teal-2', 30, T0)
    store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 50, stripeEventId: 'evt_r13', now: at(1) })
    const order = orderOf(bought.purchaseId)
    assert(order?.refundReviewStatus === 'pending' && order.refundReviewReason === 'partial_refund', JSON.stringify(order))
  })

  await check('[B11] Тестов режим на admin (ignoreSalesToggle): покупка при изключена публична продажба; без него — отказ', () => {
    const user = seedProfile('B11')
    store.updateKindSettings('emoji_after', { salesEnabled: false })
    const blocked = store.previewPurchase({ profileId: user, kind: 'emoji_after', itemId: 'emoji-0500', days: 30 })
    assert(!blocked.ok && blocked.code === 'sales_disabled', 'обикновено -> отказ')
    const allowed = createPendingPurchase({ profileId: user, kind: 'emoji_after', itemId: 'emoji-0500', days: 30, ignoreSalesToggle: true })
    assert(allowed.ok && allowed.purchase.priceCents === 199, JSON.stringify(allowed))
    store.updateKindSettings('emoji_after', { salesEnabled: true })
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[O] Обща поръчка — няколко екстри с ЕДНО плащане')

  await check('[O1] Една екстра: поръчка с един ред, сума = цената на реда, Stripe сесия с един ред', () => {
    const user = seedProfile('O1')
    const created = store.createPendingOrder({ profileId: user, items: [{ kind: 'emoji_after', itemId: 'emoji-0600', days: 90 }], now: T0 })
    assert(created.ok && created.order.itemCount === 1 && created.order.totalCents === 597 && created.order.lines.length === 1 && created.preview.totalCents === 597, JSON.stringify(created))
    if (!created.ok) return
    const params = buildProfileCustomizationCheckoutSessionParams(created.order, user, { successUrl: 'https://pika.bg/ok', cancelUrl: 'https://pika.bg/cancel' })
    assertEqual(params.line_items?.length, 1, 'редове в Checkout')
  })

  await check('[O2] Две екстри с различни срокове: сума 199×(60/30) + 199×(150/30) = 13.93 €; Checkout с два отделни реда; след плащане и двете са активни', () => {
    const user = seedProfile('O2')
    const created = store.createPendingOrder({ profileId: user, items: [{ kind: 'emoji_before', itemId: 'emoji-0610', days: 150 }, { kind: 'nickname_color', itemId: 'blue-2', days: 60 }], now: T0 })
    assert(created.ok, JSON.stringify(created))
    if (!created.ok) return
    assertEqual(created.order.totalCents, 398 + 995, 'обща сума')
    assertEqual(created.order.lines.map((line) => line.kind).join(','), 'nickname_color,emoji_before', 'редовете са подредени по вид')
    const params = buildProfileCustomizationCheckoutSessionParams(created.order, user, { successUrl: 'https://pika.bg/ok', cancelUrl: 'https://pika.bg/cancel' })
    assertEqual(params.line_items?.length, 2, 'два реда в Checkout')
    assertEqual(params.line_items?.reduce((sum, item) => sum + (item.price_data?.unit_amount ?? 0) * (item.quantity ?? 1), 0), 1393, 'сумата в Checkout')
    assertEqual(params.line_items?.[0]?.price_data?.product_data?.name, 'Pika.bg — Цвят на никнейма: Кралско синьо (#4A67F7) — 60 дни', 'име на реда')
    assertEqual(params.metadata?.itemCount, '2', 'metadata.itemCount')
    store.attachOrderCheckoutSession(created.order.orderId, 'cs_o2')
    const paid = store.fulfillPaidOrder({ checkoutSessionId: 'cs_o2', orderId: created.order.orderId, stripePaymentStatus: 'paid', stripeCurrency: 'eur', stripeAmountTotalCents: 1393, stripePaymentIntentId: 'pi_o2', now: T0 })
    assert(paid.ok && !paid.alreadyCredited && paid.order.status === 'paid' && paid.order.lines.every((line) => line.status === 'paid' && line.grantEffect === 'new'), JSON.stringify(paid))
    assertEqual(activeRow(user, 'nickname_color')?.active_until, iso(60), 'никнейм 60 дни')
    assertEqual(activeRow(user, 'emoji_before')?.active_until, iso(150), 'емоджи 150 дни')
    assertEqual(activeRow(user, 'message_color'), undefined, 'неизбраните не се активират')
  })

  await check('[O3] Четири екстри (30/90/120/180 дни) с едно плащане: точна сума 24.88 €, четири независими срока', () => {
    const user = seedProfile('O3')
    const bought = buyAndPayOrder(user, [['nickname_color', 'red-1', 30], ['message_color', 'teal-2', 90], ['emoji_before', 'emoji-0620', 120], ['emoji_after', 'emoji-0621', 180]], T0)
    assertEqual(bought.totalCents, 199 + 597 + 796 + 1194, 'обща сума')
    const items = store.getProfileActiveItems(user, at(1))
    assert(items.nickname_color?.activeUntil === iso(30) && items.message_color?.activeUntil === iso(90) && items.emoji_before?.activeUntil === iso(120) && items.emoji_after?.activeUntil === iso(180), JSON.stringify(items))
    const order = store.getOrderById(bought.orderId)
    assert(order?.itemCount === 4 && order.lines.length === 4 && new Set(order.lines.map((line) => line.chainId)).size === 4, 'четири отделни права/вериги')
  })

  await check('[O4] Комбинация в една поръчка: удължаване на притежаван + друг вариант (добавя се, без загуба) + нова екстра -> extend/new/new', () => {
    const user = seedProfile('O4')
    buyAndPayOrder(user, [['nickname_color', 'red-1', 30], ['message_color', 'blue-1', 60]], T0)
    const preview = store.previewOrder({ profileId: user, items: [{ kind: 'nickname_color', itemId: 'red-1', days: 90 }, { kind: 'message_color', itemId: 'green-1', days: 30 }, { kind: 'emoji_after', itemId: 'emoji-0630', days: 30 }], now: at(10) })
    assert(preview.ok, JSON.stringify(preview))
    if (!preview.ok) return
    const effects = Object.fromEntries(preview.preview.lines.map((line) => [line.kind, line.effect]))
    assert(effects.nickname_color === 'extend' && effects.message_color === 'new' && effects.emoji_after === 'new', JSON.stringify(effects))
    assertEqual(preview.preview.lines.find((line) => line.kind === 'message_color')?.forfeitedDays, 0, 'няма загубени дни')
    assertEqual(preview.preview.totalCents, 597 + 199 + 199, 'сума')
    const bought = buyAndPayOrder(user, [['nickname_color', 'red-1', 90], ['message_color', 'green-1', 30], ['emoji_after', 'emoji-0630', 30]], at(10))
    const order = store.getOrderById(bought.orderId)
    const byKind = new Map(order?.lines.map((line) => [line.kind, line]) ?? [])
    assert(byKind.get('nickname_color')?.grantEffect === 'extend' && byKind.get('nickname_color')?.grantedUntil === iso(120), 'удължено 30+90')
    assert(byKind.get('message_color')?.grantEffect === 'new' && byKind.get('message_color')?.replacedItemValue === null && byKind.get('message_color')?.grantedUntil === iso(40), 'добавен, използва се веднага')
    assert(byKind.get('emoji_after')?.grantEffect === 'new', 'ново')
    assert(activeRow(user, 'message_color')?.item_id === 'green-1' && activeRow(user, 'nickname_color')?.active_until === iso(120), 'използвани')
    assertEqual(ownedRow(user, 'message_color', 'blue-1')?.active_until, iso(60), 'синият текст пази всичките си дни')
  })

  await check('[O5] Валидация на поръчката: празна, над 4 реда, повторен вид, невалиден ред (с вида му), изключена продажба на един вид -> нищо не се създава', () => {
    const user = seedProfile('O5')
    const countOrders = () => (db.prepare('SELECT COUNT(*) AS c FROM profile_customization_orders WHERE profile_id = ?;').get(user) as { c: number }).c
    const empty = store.createPendingOrder({ profileId: user, items: [], now: T0 })
    assert(!empty.ok && empty.code === 'empty_order', JSON.stringify(empty))
    const five = store.createPendingOrder({ profileId: user, items: Array.from({ length: 5 }, () => ({ kind: 'nickname_color', itemId: 'red-1', days: 30 })), now: T0 })
    assert(!five.ok && five.code === 'too_many_items', JSON.stringify(five))
    const dup = store.createPendingOrder({ profileId: user, items: [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }, { kind: 'nickname_color', itemId: 'red-2', days: 30 }], now: T0 })
    assert(!dup.ok && dup.code === 'duplicate_kind' && dup.kind === 'nickname_color', JSON.stringify(dup))
    const badLine = store.createPendingOrder({ profileId: user, items: [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }, { kind: 'emoji_before', itemId: 'emoji-0001', days: 45 }], now: T0 })
    assert(!badLine.ok && badLine.code === 'invalid_duration' && badLine.kind === 'emoji_before' && badLine.message.startsWith('Емоджи пред никнейма'), JSON.stringify(badLine))
    const reserved = store.createPendingOrder({ profileId: user, items: [{ kind: 'message_color', itemId: 'no-such-color', days: 30 }], now: T0 })
    assert(!reserved.ok && reserved.code === 'item_not_found', JSON.stringify(reserved))
    store.updateKindSettings('emoji_after', { salesEnabled: false })
    const disabled = store.createPendingOrder({ profileId: user, items: [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }, { kind: 'emoji_after', itemId: 'emoji-0002', days: 30 }], now: T0 })
    assert(!disabled.ok && disabled.code === 'sales_disabled' && disabled.kind === 'emoji_after', JSON.stringify(disabled))
    store.updateKindSettings('emoji_after', { salesEnabled: true })
    assertEqual(countOrders(), 0, 'нищо не е записано')
  })

  await check('[O6] Повторно използване: същите редове -> същата поръчка; промяна на избора -> старата се скрива, новата е единствената видима', () => {
    const user = seedProfile('O6')
    const items = [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }, { kind: 'emoji_before', itemId: 'emoji-0640', days: 60 }]
    const first = store.createPendingOrder({ profileId: user, items, now: T0 })
    const again = store.createPendingOrder({ profileId: user, items: [...items].reverse(), now: T0 })
    assert(first.ok && again.ok && first.order.orderId === again.order.orderId, 'същата поръчка (редът на редовете няма значение)')
    if (!first.ok) return
    const changed = store.createPendingOrder({ profileId: user, items: [items[0]!, { kind: 'emoji_before', itemId: 'emoji-0640', days: 90 }], now: T0 })
    assert(changed.ok && changed.order.orderId !== first.order.orderId, 'нова поръчка при друг срок')
    const visible = db.prepare(`SELECT order_id FROM profile_customization_orders WHERE profile_id = ? AND status = 'pending' AND hidden_at IS NULL;`).all(user) as Array<{ order_id: string }>
    assert(visible.length === 1 && changed.ok && visible[0]?.order_id === changed.order.orderId, JSON.stringify(visible))
    const hiddenLines = (db.prepare('SELECT COUNT(*) AS c FROM profile_customization_purchases WHERE order_id = ? AND hidden_at IS NOT NULL;').get(first.order.orderId) as { c: number }).c
    assertEqual(hiddenLines, 2, 'редовете на старата поръчка също са скрити')
  })

  await check('[O7] Скрита (заменена) поръчка с вече отворена сесия: плащане по нея пак се кредитира веднъж', () => {
    const user = seedProfile('O7')
    const first = store.createPendingOrder({ profileId: user, items: [{ kind: 'message_color', itemId: 'gold-2', days: 30 }], now: T0 })
    assert(first.ok, 'create')
    if (!first.ok) return
    store.attachOrderCheckoutSession(first.order.orderId, 'cs_o7_old')
    const second = store.createPendingOrder({ profileId: user, items: [{ kind: 'message_color', itemId: 'gold-3', days: 30 }], now: T0 })
    assert(second.ok && second.order.orderId !== first.order.orderId, 'нова')
    const paid = store.fulfillPaidOrder({ checkoutSessionId: 'cs_o7_old', orderId: first.order.orderId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 199, stripePaymentIntentId: 'pi_o7', now: T0 })
    assert(paid.ok && !paid.alreadyCredited && activeRow(user, 'message_color')?.item_id === 'gold-2', JSON.stringify(paid))
  })

  await check('[O8] Webhook сума/валута/липсваща сесия за поръчка с няколко реда -> нищо не се активира; правилната сума -> всички', () => {
    const user = seedProfile('O8')
    const created = store.createPendingOrder({ profileId: user, items: [{ kind: 'nickname_color', itemId: 'purple-1', days: 30 }, { kind: 'message_color', itemId: 'purple-2', days: 30 }], now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    store.attachOrderCheckoutSession(created.order.orderId, 'cs_o8')
    const base = { checkoutSessionId: 'cs_o8', orderId: created.order.orderId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 398, stripePaymentIntentId: 'pi_o8', now: T0 }
    for (const [overrides, reason] of [[{ stripeAmountTotalCents: 199 }, 'amount_mismatch'], [{ stripeAmountTotalCents: 397 }, 'amount_mismatch'], [{ stripeCurrency: 'usd' }, 'currency_mismatch'], [{ orderId: randomUUID() }, 'purchase_id_mismatch'], [{ checkoutSessionId: 'cs_none' }, 'purchase_not_found'], [{ stripePaymentStatus: 'unpaid' }, 'not_paid']] as const) {
      const result = store.fulfillPaidOrder({ ...base, ...overrides })
      assert(!result.ok && result.reason === reason, `${reason}: ${JSON.stringify(result)}`)
    }
    assert(activeRow(user, 'nickname_color') === undefined && activeRow(user, 'message_color') === undefined, 'нищо активно')
    const ok = store.fulfillPaidOrder(base)
    assert(ok.ok && activeRow(user, 'nickname_color') !== undefined && activeRow(user, 'message_color') !== undefined, 'и двете активни')
  })

  await check('[O9] Повторен и конкурентен webhook (друга връзка) за поръчка с 3 реда: кредитира веднъж, сроковете не се удвояват', () => {
    const user = seedProfile('O9')
    const bought = buyAndPayOrder(user, [['nickname_color', 'teal-1', 30], ['emoji_before', 'emoji-0650', 60], ['emoji_after', 'emoji-0651', 90]], T0)
    for (const target of [store, secondStore, store]) {
      const replay = target.fulfillPaidOrder({ checkoutSessionId: bought.sessionId, orderId: bought.orderId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: bought.totalCents, stripePaymentIntentId: bought.paymentIntentId, now: at(2) })
      assert(replay.ok && replay.alreadyCredited, JSON.stringify(replay))
    }
    assert(activeRow(user, 'nickname_color')?.active_until === iso(30) && activeRow(user, 'emoji_before')?.active_until === iso(60) && activeRow(user, 'emoji_after')?.active_until === iso(90), 'без удвояване')
    const lines = db.prepare(`SELECT COUNT(*) AS c FROM profile_customization_purchases WHERE order_id = ? AND status = 'paid';`).get(bought.orderId) as { c: number }
    assertEqual(lines.c, 3, 'три платени реда')
  })

  await check('[O10] Транзакционност: ако един ред не може да бъде кредитиран, НИЩО от поръчката не се активира (и поръчката остава неплатена)', () => {
    const user = seedProfile('O10')
    const created = store.createPendingOrder({ profileId: user, items: [{ kind: 'nickname_color', itemId: 'orange-1', days: 30 }, { kind: 'emoji_after', itemId: 'emoji-0360', days: 30 }], now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    store.attachOrderCheckoutSession(created.order.orderId, 'cs_o10')
    const emojiLine = created.order.lines.find((line) => line.kind === 'emoji_after')!
    db.prepare(`UPDATE profile_customization_purchases SET status = 'canceled' WHERE purchase_id = ?;`).run(emojiLine.purchaseId)
    const result = store.fulfillPaidOrder({ checkoutSessionId: 'cs_o10', orderId: created.order.orderId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 398, stripePaymentIntentId: 'pi_o10', now: T0 })
    assert(!result.ok && result.reason === 'credit_failed' && result.transient !== true, JSON.stringify(result))
    assert(activeRow(user, 'nickname_color') === undefined && activeRow(user, 'emoji_after') === undefined, 'нищо не е активирано')
    assertEqual(store.getOrderById(created.order.orderId)?.status, 'pending', 'поръчката не е маркирана платена')
  })

  await check('[O11] Изтекла / неуспешна сесия -> поръчката и всичките ѝ редове са canceled / failed', () => {
    const user = seedProfile('O11')
    const created = store.createPendingOrder({ profileId: user, items: [{ kind: 'nickname_color', itemId: 'gold-1', days: 30 }, { kind: 'message_color', itemId: 'gold-2', days: 30 }], now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    store.attachOrderCheckoutSession(created.order.orderId, 'cs_o11')
    store.markOrderCanceledByCheckoutSessionId('cs_o11')
    const order = store.getOrderById(created.order.orderId)
    assert(order?.status === 'canceled' && order.lines.every((line) => line.status === 'canceled'), JSON.stringify(order))
    store.markOrderFailedByCheckoutSessionId('cs_o11')
    assertEqual(store.getOrderById(created.order.orderId)?.status, 'canceled', 'вече затворена поръчка не се променя')
  })

  await check('[O12] Пълен refund на поръчка с 3 реда: отменя само нейните права; по-новото удължаване от друга поръчка запазва дните си; друга екстра не се пипа', () => {
    const user = seedProfile('O12')
    buyAndPay(user, 'emoji_after', 'emoji-0370', 30, T0)
    const order = buyAndPayOrder(user, [['nickname_color', 'red-3', 30], ['message_color', 'blue-3', 60], ['emoji_before', 'emoji-0371', 30]], T0)
    // По-нова, отделна поръчка удължава цвета на никнейма с 90 дни.
    buyAndPay(user, 'nickname_color', 'red-3', 90, at(5))
    assertEqual(activeRow(user, 'nickname_color')?.active_until, iso(120), 'преди refund')
    const result = store.applyRefund({ paymentIntentId: order.paymentIntentId, refundedAmountCents: order.totalCents, stripeEventId: 'evt_o12', now: at(6) })
    assert(result.ok && result.outcome === 'revoked' && result.order.status === 'refunded' && result.order.lines.every((line) => line.status === 'refunded' && line.refundedAmountCents === line.priceCents), JSON.stringify(result))
    assertEqual(activeRow(user, 'nickname_color')?.active_until, iso(90), 'остават само дните от по-новото удължаване')
    assertEqual(activeRow(user, 'message_color'), undefined, 'отменено')
    assertEqual(activeRow(user, 'emoji_before'), undefined, 'отменено')
    assertEqual(activeRow(user, 'emoji_after')?.active_until, iso(30), 'екстра от друга поръчка не е засегната')
    const again = store.applyRefund({ checkoutSessionId: order.sessionId, refundedAmountCents: order.totalCents, stripeEventId: 'evt_o12_dup', now: at(7) })
    assert(again.ok && again.outcome === 'already_refunded', 'повторен refund')
  })

  await check('[O13] Частичен refund на поръчка с няколко реда: правата остават, поръчката чака преглед; сумата НЕ се приписва на конкретен ред', () => {
    const user = seedProfile('O13')
    const order = buyAndPayOrder(user, [['nickname_color', 'green-3', 30], ['emoji_before', 'emoji-0380', 30]], T0)
    const result = store.applyRefund({ checkoutSessionId: order.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_o13', now: at(1) })
    assert(result.ok && result.outcome === 'partial_recorded' && result.order.status === 'paid' && result.order.refundReviewStatus === 'pending' && result.order.refundReviewReason === 'partial_refund', JSON.stringify(result))
    assert(result.ok && result.order.lines.every((line) => line.status === 'paid' && line.refundedAmountCents === null), 'редовете без приписана сума')
    assert(activeRow(user, 'nickname_color') !== undefined && activeRow(user, 'emoji_before') !== undefined, 'правата остават')
    const reviewList = store.listAdminOrders({ limit: 50, offset: 0, status: 'review_pending' })
    const row = reviewList.rows.find((candidate) => candidate.orderId === order.orderId)
    assert(row !== undefined && row.lines.length === 2 && row.refundedAmountCents === 199, 'в списъка за преглед, с двата реда')
    assert(store.markRefundReviewed(order.lineIds.emoji_before as string), 'преглед по id на ред -> цялата поръчка')
    assertEqual(store.getOrderById(order.orderId)?.refundReviewStatus, 'reviewed', 'прегледана')
  })

  await check('[O14] Пълен refund ПРЕДИ checkout.session.completed за поръчка с няколко реда -> нищо не се активира, всички редове са refunded', () => {
    const user = seedProfile('O14')
    const created = store.createPendingOrder({ profileId: user, items: [{ kind: 'nickname_color', itemId: 'blue-1', days: 30 }, { kind: 'emoji_after', itemId: 'emoji-0390', days: 60 }], now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    store.attachOrderCheckoutSession(created.order.orderId, 'cs_o14')
    const early = store.applyRefund({ checkoutSessionId: 'cs_o14', refundedAmountCents: 597, stripeEventId: 'evt_o14', now: T0 })
    assert(early.ok && early.outcome === 'recorded_before_credit', JSON.stringify(early))
    const fulfill = store.fulfillPaidOrder({ checkoutSessionId: 'cs_o14', orderId: created.order.orderId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 597, stripePaymentIntentId: 'pi_o14', now: T0 })
    assert(fulfill.ok && fulfill.refundedBeforeCredit && fulfill.order.status === 'refunded' && fulfill.order.lines.every((line) => line.status === 'refunded'), JSON.stringify(fulfill))
    assert(activeRow(user, 'nickname_color') === undefined && activeRow(user, 'emoji_after') === undefined, 'нищо активно')
  })

  await check('[O15] Админ: поръчките се показват с редовете си (една заявка за страницата); статистиката по вид брои отделните права', () => {
    const page = store.listAdminOrders({ limit: 200, offset: 0, status: 'paid' })
    const multi = page.rows.find((row) => row.lines.length === 4)
    assert(multi !== undefined && multi.totalCents === multi.lines.reduce((sum, line) => sum + line.priceCents, 0), 'поръчка с 4 реда')
    assert(page.rows.every((row) => row.status === 'paid' && row.lines.length === row.itemCount), 'брой редове')
    const stats = store.getAdminKindStats(at(1))
    assert(stats.every((row) => row.paidCount > 0), JSON.stringify(stats))
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[I] Инвентар "Моите персонализации"')

  await check('[I1] Няколко цвята за ника И няколко за текста в един инвентар; по един използван на вид; всеки със собствен срок', () => {
    const user = seedProfile('I1')
    buyAndPayOrder(user, [['nickname_color', 'red-1', 30], ['message_color', 'blue-1', 90]], T0)
    buyAndPayOrder(user, [['nickname_color', 'blue-1', 60], ['message_color', 'gold-1', 120]], at(2))
    buyAndPay(user, 'nickname_color', 'purple-1', 180, at(3))
    const owned = store.getProfileOwnedItems(user, at(4))
    const nick = owned.filter((item) => item.kind === 'nickname_color')
    const text = owned.filter((item) => item.kind === 'message_color')
    assert(nick.length === 3 && text.length === 2, JSON.stringify(owned.map((item) => `${item.kind}:${item.itemId}`)))
    assert(nick.filter((item) => item.equipped).length === 1 && nick.find((item) => item.equipped)?.itemId === 'purple-1', 'един използван цвят на ника (последният нов)')
    assert(text.filter((item) => item.equipped).length === 1 && text.find((item) => item.equipped)?.itemId === 'gold-1', 'един използван цвят на текста')
    const until = Object.fromEntries(nick.map((item) => [item.itemId, item.activeUntil]))
    assert(until['red-1'] === iso(30) && until['blue-1'] === iso(62) && until['purple-1'] === iso(183), JSON.stringify(until))
    assertEqual(text.find((item) => item.itemId === 'blue-1')?.activeUntil, iso(90), 'синият текст не е загубил дни')
  })

  await check('[I2] Няколко емоджита пред и след ника; "Използвай" сменя безплатно — никой срок не се променя', () => {
    const user = seedProfile('I2')
    buyAndPayOrder(user, [['emoji_before', 'emoji-0100', 30], ['emoji_after', 'emoji-0200', 30]], T0)
    buyAndPayOrder(user, [['emoji_before', 'emoji-0101', 60], ['emoji_after', 'emoji-0201', 90]], at(1))
    buyAndPay(user, 'emoji_before', 'emoji-0102', 120, at(1))
    const before = JSON.stringify(db.prepare('SELECT kind, item_id, active_until, chain_id FROM profile_customization_owned_items WHERE profile_id = ? ORDER BY kind, item_id;').all(user))
    const paidLines = () => (db.prepare(`SELECT COUNT(*) AS c FROM profile_customization_purchases WHERE profile_id = ? AND status = 'paid';`).get(user) as { c: number }).c
    const linesBefore = paidLines()
    const equipped = store.equipItem({ profileId: user, kind: 'emoji_before', itemId: 'emoji-0100', now: at(2) })
    assert(equipped.ok && equipped.active.emoji_before?.itemId === 'emoji-0100', JSON.stringify(equipped))
    assert(equipped.ok && equipped.owned.filter((item) => item.kind === 'emoji_before').length === 3 && equipped.owned.find((item) => item.itemId === 'emoji-0102')?.equipped === false, 'предишният е "Наличен"')
    store.equipItem({ profileId: user, kind: 'emoji_after', itemId: 'emoji-0200', now: at(2) })
    const appearance = store.getAppearancesForProfiles([user], at(2)).get(user)
    assert(appearance?.emojiBefore === store.getProfileActiveItems(user, at(2)).emoji_before?.value && appearance.emojiAfterUntil === iso(30), JSON.stringify(appearance))
    const after = JSON.stringify(db.prepare('SELECT kind, item_id, active_until, chain_id FROM profile_customization_owned_items WHERE profile_id = ? ORDER BY kind, item_id;').all(user))
    assertEqual(after, before, 'сроковете/веригите не са пипнати')
    assertEqual(paidLines(), linesBefore, 'без нови покупки/плащания')
  })

  await check('[I3] "Премахни": ефектът спира, правото и срокът остават; може пак да се използва; повторно премахване -> без промяна', () => {
    const user = seedProfile('I3')
    buyAndPay(user, 'nickname_color', 'green-1', 60, T0)
    const removed = store.unequipItem({ profileId: user, kind: 'nickname_color', now: at(1) })
    assert(removed.ok && removed.removed && removed.active.nickname_color === null, JSON.stringify(removed))
    assertEqual(store.getAppearancesForProfiles([user], at(1)).get(user)?.nicknameColor ?? null, null, 'без ефект')
    assert(removed.ok && removed.owned.length === 1 && removed.owned[0]?.equipped === false && removed.owned[0].activeUntil === iso(60), 'остава притежаван със срока')
    const again = store.unequipItem({ profileId: user, kind: 'nickname_color', now: at(1) })
    assert(again.ok && !again.removed, 'повторно')
    const reused = store.equipItem({ profileId: user, kind: 'nickname_color', itemId: 'green-1', now: at(5) })
    assert(reused.ok && store.getAppearancesForProfiles([user], at(5)).get(user)?.nicknameColor === '#14891E', 'пак се използва')
    assertEqual(ownedRow(user, 'nickname_color', 'green-1')?.active_until, iso(60), 'срокът е текъл календарно, без пауза')
  })

  await check('[I4] "Използвай" е позволено само за собствен, неизтекъл вариант: чужд/непритежаван/невалиден вид -> отказ, нищо не се записва', () => {
    const owner = seedProfile('I4owner')
    const stranger = seedProfile('I4stranger')
    buyAndPay(owner, 'emoji_after', 'emoji-0300', 30, T0)
    const foreign = store.equipItem({ profileId: stranger, kind: 'emoji_after', itemId: 'emoji-0300', now: at(1) })
    assert(!foreign.ok && foreign.code === 'not_owned', JSON.stringify(foreign))
    const notOwned = store.equipItem({ profileId: owner, kind: 'emoji_after', itemId: 'emoji-0301', now: at(1) })
    assert(!notOwned.ok && notOwned.code === 'not_owned', 'непритежаван')
    const wrongKind = store.equipItem({ profileId: owner, kind: 'emoji_before', itemId: 'emoji-0300', now: at(1) })
    assert(!wrongKind.ok && wrongKind.code === 'not_owned', 'друг вид')
    const badKind = store.equipItem({ profileId: owner, kind: 'vip', itemId: 'emoji-0300', now: at(1) })
    assert(!badKind.ok && badKind.code === 'invalid_kind', 'невалиден вид')
    const expired = store.equipItem({ profileId: owner, kind: 'emoji_after', itemId: 'emoji-0300', now: at(31) })
    assert(!expired.ok && expired.code === 'expired', 'изтекъл')
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM profile_customization_equipped WHERE profile_id = ?;').get(stranger) as { c: number }).c, 0, 'чуждият няма използван')
  })

  await check('[I5] Повторна покупка на СЪЩИЯ вариант: без второ копие, 20 + 90 = 110 дни; двете плащания остават в историята; използваният не се сменя', () => {
    const user = seedProfile('I5')
    buyAndPay(user, 'nickname_color', 'red-1', 30, T0)
    buyAndPay(user, 'nickname_color', 'blue-1', 30, T0) // използва се синият
    const preview = store.previewPurchase({ profileId: user, kind: 'nickname_color', itemId: 'red-1', days: 90, now: at(10) })
    assert(preview.ok && preview.preview.effect === 'extend' && preview.preview.current?.remainingDays === 20 && preview.preview.resultingActiveUntil === iso(120), JSON.stringify(preview))
    buyAndPay(user, 'nickname_color', 'red-1', 90, at(10))
    const copies = (db.prepare(`SELECT COUNT(*) AS c FROM profile_customization_owned_items WHERE profile_id = ? AND item_id = 'red-1';`).get(user) as { c: number }).c
    assertEqual(copies, 1, 'едно копие')
    const red = store.getProfileOwnedItems(user, at(10)).find((item) => item.itemId === 'red-1')
    assert(red?.remainingDays === 110 && red.activeUntil === iso(120) && red.equipped === false, JSON.stringify(red))
    assertEqual(store.getProfileActiveItems(user, at(10)).nickname_color?.itemId, 'blue-1', 'удължаването не сменя използвания')
    const history = db.prepare(`SELECT grant_effect, days_snapshot FROM profile_customization_purchases WHERE profile_id = ? AND item_id = 'red-1' ORDER BY credited_at;`).all(user) as Array<{ grant_effect: string; days_snapshot: number }>
    assert(history.length === 2 && history[0]?.grant_effect === 'new' && history[1]?.grant_effect === 'extend' && history[1].days_snapshot === 90, JSON.stringify(history))
  })

  await check('[I6] Изтекъл вариант, купен отново: нова верига от плащането; старата транзакция остава в историята; изтеклите не са в инвентара', () => {
    const user = seedProfile('I6')
    const first = buyAndPay(user, 'message_color', 'purple-1', 30, T0)
    assertEqual(store.getProfileOwnedItems(user, at(31)).length, 0, 'изтеклият не е в активния инвентар')
    const preview = store.previewPurchase({ profileId: user, kind: 'message_color', itemId: 'purple-1', days: 60, now: at(40) })
    assert(preview.ok && preview.preview.effect === 'new' && preview.preview.resultingActiveUntil === iso(100), JSON.stringify(preview))
    const second = buyAndPay(user, 'message_color', 'purple-1', 60, at(40))
    const row = ownedRow(user, 'message_color', 'purple-1')
    assert(row?.chain_started_at === iso(40) && row.active_until === iso(100) && row.chain_id === store.getPurchaseById(second.purchaseId)?.chainId, JSON.stringify(row))
    assert(store.getPurchaseById(first.purchaseId)?.status === 'paid' && store.getPurchaseById(first.purchaseId)?.chainId !== row?.chain_id, 'старата транзакция е запазена')
    // Refund на старата (вече изтекла) покупка не засяга новата верига.
    store.applyRefund({ checkoutSessionId: first.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_i6', now: at(41) })
    assertEqual(ownedRow(user, 'message_color', 'purple-1')?.active_until, iso(100), 'новата верига е непокътната')
  })

  await check('[I7] Многократно удължаван вариант P(30)+Q(60)+R(90): refund само на Q -> остават 30 + 90 дни; другите варианти не се пипат', () => {
    const user = seedProfile('I7')
    buyAndPay(user, 'emoji_before', 'emoji-0400', 30, T0)
    const q = buyAndPay(user, 'emoji_before', 'emoji-0400', 60, at(1))
    buyAndPay(user, 'emoji_before', 'emoji-0400', 90, at(2))
    buyAndPay(user, 'emoji_before', 'emoji-0401', 30, at(2)) // друг вариант (използва се)
    assertEqual(ownedRow(user, 'emoji_before', 'emoji-0400')?.active_until, iso(180), 'преди')
    const result = store.applyRefund({ paymentIntentId: q.paymentIntentId, refundedAmountCents: 398, stripeEventId: 'evt_i7', now: at(3) })
    assert(result.ok && result.outcome === 'revoked', JSON.stringify(result))
    assertEqual(ownedRow(user, 'emoji_before', 'emoji-0400')?.active_until, iso(120), 'остават P + R')
    assertEqual(ownedRow(user, 'emoji_before', 'emoji-0401')?.active_until, iso(32), 'другият вариант')
    assertEqual(activeRow(user, 'emoji_before')?.item_id, 'emoji-0401', 'използваният е непроменен')
  })

  await check('[I8] Пълен refund на поръчка с няколко артикула отменя само нейните права; по-стари притежавани варианти от същите видове остават', () => {
    const user = seedProfile('I8')
    buyAndPayOrder(user, [['nickname_color', 'red-1', 90], ['emoji_after', 'emoji-0500', 90]], T0)
    const order = buyAndPayOrder(user, [['nickname_color', 'gold-1', 30], ['emoji_after', 'emoji-0501', 30]], at(5))
    assert(activeRow(user, 'nickname_color')?.item_id === 'gold-1' && activeRow(user, 'emoji_after')?.item_id === 'emoji-0501', 'новите се използват')
    const result = store.applyRefund({ checkoutSessionId: order.sessionId, refundedAmountCents: order.totalCents, stripeEventId: 'evt_i8', now: at(6) })
    assert(result.ok && result.outcome === 'revoked', JSON.stringify(result))
    assert(ownedRow(user, 'nickname_color', 'gold-1') === undefined && ownedRow(user, 'emoji_after', 'emoji-0501') === undefined, 'отменените са извън инвентара')
    assert(ownedRow(user, 'nickname_color', 'red-1')?.active_until === iso(90) && ownedRow(user, 'emoji_after', 'emoji-0500')?.active_until === iso(90), 'по-старите остават')
    assert(activeRow(user, 'nickname_color') === undefined && activeRow(user, 'emoji_after') === undefined, 'друг вариант не се активира сам')
  })

  await check('[I9] Частичен refund на поръчка -> правата и използването остават, поръчката чака преглед', () => {
    const user = seedProfile('I9')
    const order = buyAndPayOrder(user, [['nickname_color', 'blue-1', 30], ['message_color', 'green-1', 30]], T0)
    const result = store.applyRefund({ checkoutSessionId: order.sessionId, refundedAmountCents: 150, stripeEventId: 'evt_i9', now: at(1) })
    assert(result.ok && result.outcome === 'partial_recorded' && result.order.refundReviewStatus === 'pending', JSON.stringify(result))
    assert(activeRow(user, 'nickname_color')?.item_id === 'blue-1' && activeRow(user, 'message_color')?.item_id === 'green-1', 'използваните остават')
  })

  await check('[I10] Скрит (спрян) цвят, който потребителят притежава: остава в инвентара, може да се използва и удължава; нов купувач не може', () => {
    const user = seedProfile('I10')
    buyAndPay(user, 'nickname_color', 'teal-2', 30, T0)
    buyAndPay(user, 'nickname_color', 'red-1', 30, T0)
    store.updateColor('teal-2', { isActive: false })
    assert(store.equipItem({ profileId: user, kind: 'nickname_color', itemId: 'teal-2', now: at(1) }).ok, 'използване')
    const extend = store.previewPurchase({ profileId: user, kind: 'nickname_color', itemId: 'teal-2', days: 30, now: at(1) })
    assert(extend.ok && extend.preview.effect === 'extend', JSON.stringify(extend))
    const other = store.previewPurchase({ profileId: seedProfile('I10other'), kind: 'nickname_color', itemId: 'teal-2', days: 30, now: at(1) })
    assert(!other.ok && other.code === 'item_not_for_sale', 'нов купувач')
    store.updateColor('teal-2', { isActive: true })
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[G] Безплатно предоставяне от admin')

  const grantAdmin = seedProfile('GrantAdmin')
  const grant = (targetProfileId: string, items: Array<[kind: string, itemId: string, days: number]>, now: Date) =>
    store.grantItems({ adminProfileId: grantAdmin, adminDisplayName: 'GrantAdmin', targetProfileId, items: items.map(([kind, itemId, days]) => ({ kind, itemId, days })), now })
  const countRows = (table: string, profileId: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE profile_id = ?;`).get(profileId) as { c: number }).c

  await check('[G1] Една екстра на чужд профил: в инвентара и се използва веднага; одит (кой/на кого/кога/какво/дни/нов срок/нова); БЕЗ поръчка/плащане', () => {
    const target = seedProfile('G1')
    const result = grant(target, [['nickname_color', 'blue-1', 90]], T0)
    assert(result.ok && result.grants.length === 1, JSON.stringify(result))
    if (!result.ok) return
    const audit = result.grants[0]!
    assert(audit.profileId === target && audit.targetDisplayName === 'G1' && audit.grantedByProfileId === grantAdmin && audit.grantedByDisplayName === 'GrantAdmin', JSON.stringify(audit))
    assert(audit.kind === 'nickname_color' && audit.itemValue === '#2B74D9' && audit.days === 90 && audit.grantEffect === 'new' && audit.grantedUntil === iso(90) && audit.createdAt === iso(0), JSON.stringify(audit))
    assert(result.active.nickname_color?.itemId === 'blue-1' && result.owned.length === 1 && result.owned[0]?.remainingDays === 90, 'използва се, 90 дни')
    assert(countRows('profile_customization_orders', target) === 0 && countRows('profile_customization_purchases', target) === 0, 'без поръчка/фалшива Stripe покупка')
    assertEqual(store.getAppearancesForProfiles([target], at(1)).get(target)?.nicknameColor, '#2B74D9', 'видим ефект')
  })

  await check('[G2] Четири екстри с различни срокове -> всички приложени в една партида', () => {
    const target = seedProfile('G2')
    const result = grant(target, [['nickname_color', 'red-1', 30], ['message_color', 'gold-1', 60], ['emoji_before', 'emoji-0110', 150], ['emoji_after', 'emoji-0111', 180]], T0)
    assert(result.ok && result.grants.length === 4 && new Set(result.grants.map((row) => row.batchId)).size === 1, JSON.stringify(result))
    const until = Object.fromEntries(store.getProfileOwnedItems(target, at(1)).map((item) => [item.kind, item.activeUntil]))
    assert(until.nickname_color === iso(30) && until.message_color === iso(60) && until.emoji_before === iso(150) && until.emoji_after === iso(180), JSON.stringify(until))
    assertEqual(store.listGrants({ limit: 10, offset: 0, profileId: target }).total, 4, 'одит')
  })

  await check('[G3] Невалиден ред в партида -> НИЩО не се прилага (транзакционно); бот/скрит цвят -> отказ', () => {
    const target = seedProfile('G3')
    const bad = grant(target, [['nickname_color', 'red-1', 30], ['emoji_before', 'emoji-0001', 45]], T0)
    assert(!bad.ok && bad.code === 'invalid_duration' && bad.kind === 'emoji_before', JSON.stringify(bad))
    const dup = grant(target, [['nickname_color', 'red-1', 30], ['nickname_color', 'blue-1', 30]], T0)
    assert(!dup.ok && dup.code === 'duplicate_kind', 'повторен вид')
    assert(countRows('profile_customization_owned_items', target) === 0 && countRows('profile_customization_grants', target) === 0, 'нищо не е приложено')
    const bot = grant(seedProfile('G3bot', { human: false }), [['nickname_color', 'red-1', 30]], T0)
    assert(!bot.ok && bot.code === 'profile_not_eligible', 'бот')
    store.updateColor('teal-3', { isActive: false })
    const hidden = grant(target, [['nickname_color', 'teal-3', 30]], T0)
    assert(!hidden.ok && hidden.code === 'item_not_for_sale', 'скрит цвят за нов получател')
    store.updateColor('teal-3', { isActive: true })
    const reserved = db.prepare(`SELECT COUNT(*) AS c FROM profile_customization_colors WHERE upper(hex) = '#F72585';`).get() as { c: number }
    assertEqual(reserved.c, 0, 'служебният цвят не е в каталога')
  })

  await check('[G4] Остават 20 платени дни + 30 предоставени = 50 (същият вариант, без копие); различен вариант се добавя, без да отнема', () => {
    const target = seedProfile('G4')
    buyAndPay(target, 'nickname_color', 'green-1', 30, T0)
    const extended = grant(target, [['nickname_color', 'green-1', 30]], at(10))
    assert(extended.ok && extended.grants[0]?.grantEffect === 'extend' && extended.grants[0].grantedUntil === iso(60), JSON.stringify(extended))
    assertEqual(store.getProfileOwnedItems(target, at(10)).find((item) => item.itemId === 'green-1')?.remainingDays, 50, '20 + 30')
    const other = grant(target, [['nickname_color', 'purple-1', 30]], at(10))
    assert(other.ok && other.grants[0]?.grantEffect === 'new', 'нов вариант')
    assertEqual(ownedRow(target, 'nickname_color', 'green-1')?.active_until, iso(60), 'зеленият пази срока си')
    assertEqual(activeRow(target, 'nickname_color')?.item_id, 'purple-1', 'новият се използва веднага')
  })

  await check('[G5] 30 платени + 90 предоставени = 120; refund на платените -> остават точно 90 предоставени дни (не се губят)', () => {
    const target = seedProfile('G5')
    const paid = buyAndPay(target, 'message_color', 'red-1', 30, T0)
    grant(target, [['message_color', 'red-1', 90]], at(1))
    assertEqual(ownedRow(target, 'message_color', 'red-1')?.active_until, iso(120), '30 + 90')
    const refund = store.applyRefund({ checkoutSessionId: paid.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_g5', now: at(2) })
    assert(refund.ok && refund.outcome === 'revoked', JSON.stringify(refund))
    assertEqual(ownedRow(target, 'message_color', 'red-1')?.active_until, iso(90), 'остават 90 предоставени')
    assertEqual(activeRow(target, 'message_color')?.item_id, 'red-1', 'продължава да се използва')
    const again = store.applyRefund({ checkoutSessionId: paid.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_g5b', now: at(3) })
    assert(again.ok && again.outcome === 'already_refunded' && ownedRow(target, 'message_color', 'red-1')?.active_until === iso(90), 'повторен refund не пипа нищо')
  })

  await check('[G6] Обратен ред: 30 предоставени + 60 платени = 90; refund на платеното удължаване -> остават 30 предоставени', () => {
    const target = seedProfile('G6')
    grant(target, [['emoji_after', 'emoji-0120', 30]], T0)
    const paid = buyAndPay(target, 'emoji_after', 'emoji-0120', 60, at(5))
    assert(store.getPurchaseById(paid.purchaseId)?.grantEffect === 'extend', 'платено удължаване на подарен')
    assertEqual(ownedRow(target, 'emoji_after', 'emoji-0120')?.active_until, iso(90), '30 + 60')
    store.applyRefund({ paymentIntentId: paid.paymentIntentId, refundedAmountCents: 398, stripeEventId: 'evt_g6', now: at(6) })
    assertEqual(ownedRow(target, 'emoji_after', 'emoji-0120')?.active_until, iso(30), 'остават предоставените')
  })

  await check('[G7] Admin на собствения профил: безплатно предоставяне И нормално платена поръчка работят независимо', () => {
    const granted = grant(grantAdmin, [['nickname_color', 'gold-1', 30]], T0)
    assert(granted.ok && granted.grants[0]?.profileId === grantAdmin, 'собствен профил')
    const bought = buyAndPayOrder(grantAdmin, [['message_color', 'blue-1', 30], ['emoji_before', 'emoji-0130', 30]], T0)
    assertEqual(store.getOrderById(bought.orderId)?.status, 'paid', 'реално плащане')
    assertEqual(store.getProfileOwnedItems(grantAdmin, at(1)).length, 3, 'и трите в инвентара')
  })

  await check('[G8] Смяна между предоставен и платен вариант без загуба на дни; одитът остава непроменен', () => {
    const target = seedProfile('G8')
    grant(target, [['nickname_color', 'red-1', 60]], T0)
    buyAndPay(target, 'nickname_color', 'blue-1', 30, T0)
    const auditBefore = JSON.stringify(store.listGrants({ limit: 10, offset: 0, profileId: target }).rows)
    assert(store.equipItem({ profileId: target, kind: 'nickname_color', itemId: 'red-1', now: at(1) }).ok, 'използвай предоставения')
    assert(ownedRow(target, 'nickname_color', 'red-1')?.active_until === iso(60) && ownedRow(target, 'nickname_color', 'blue-1')?.active_until === iso(30), 'сроковете')
    assertEqual(JSON.stringify(store.listGrants({ limit: 10, offset: 0, profileId: target }).rows), auditBefore, 'одитът е непроменен')
  })

  await check('[G9] Изтриване на профил: одитът остава (profile_id NULL + snapshot), правата изчезват; executor-ът покрива новата колона', async () => {
    const target = seedProfile('G9')
    grant(target, [['nickname_color', 'red-1', 30]], T0)
    db.prepare('UPDATE profile_customization_grants SET deleted_profile_id_snapshot = ? WHERE profile_id = ?;').run(target, target)
    db.prepare('DELETE FROM profiles WHERE profile_id = ?;').run(target)
    const row = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, days FROM profile_customization_grants WHERE deleted_profile_id_snapshot = ?;').get(target) as Record<string, unknown>
    assert(row.profile_id === null && row.days === 30, JSON.stringify(row))
    assertEqual(countRows('profile_customization_owned_items', target), 0, 'правата са изтрити (CASCADE)')
    const source = (await readFile(join(sourceServerRoot, 'src', 'db', 'profileDeletionExecutor.ts'), 'utf8')).replace(/\s+/g, ' ')
    assert(/UPDATE profile_customization_grants SET deleted_profile_id_snapshot/.test(source) && /UPDATE profile_customization_grants SET granted_by_display_name_snapshot/.test(source), 'executor')
  })

  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[P] /admin/payments — Stripe поръчките за персонализация')

  await check('[P1] Една Stripe поръчка = ЕДИН ред ("Персонализация", без жълтици/VIP); 1 и 4 екстри; повторен webhook не дублира; предоставянията и неплатените НЕ са плащания', () => {
    const payer = seedProfile('Payer1')
    const one = buyAndPayOrder(payer, [['nickname_color', 'red-1', 30]], at(200))
    const four = buyAndPayOrder(payer, [['nickname_color', 'red-1', 60], ['message_color', 'gold-1', 90], ['emoji_before', 'emoji-0140', 30], ['emoji_after', 'emoji-0141', 180]], at(200))
    store.fulfillPaidOrder({ checkoutSessionId: four.sessionId, orderId: four.orderId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: four.totalCents, stripePaymentIntentId: four.paymentIntentId, now: at(200) })
    store.createPendingOrder({ profileId: payer, items: [{ kind: 'nickname_color', itemId: 'blue-1', days: 30 }], now: at(200) })
    grant(payer, [['message_color', 'blue-1', 30]], at(200))
    const rows = store.getAdminPaymentListByPeriod({ period: 'today', now: at(200) }).filter((row) => row.profileId === payer)
    assertEqual(rows.length, 2, 'два реда (по един на поръчка)')
    const fourRow = rows.find((row) => row.purchaseId === four.orderId)
    assert(fourRow?.packageTitle === 'Персонализация' && fourRow.yellowCoinsAmount === null && fourRow.vipDays === null && fourRow.priceCents === 398 + 597 + 199 + 1194 && fourRow.status === 'paid' && fourRow.source === 'profile_customization' && fourRow.providerCheckoutSessionId === four.sessionId, JSON.stringify(fourRow))
    assertEqual(rows.find((row) => row.purchaseId === one.orderId)?.priceCents, 199, 'една екстра')
  })

  await check('[P2] Филтри по дата (Sofia): днес/вчера/7 дни/месец/общо по датата на плащане', () => {
    const payer = seedProfile('Payer2')
    const now = new Date('2027-03-15T10:00:00.000Z')
    buyAndPayOrder(payer, [['nickname_color', 'red-1', 30]], new Date('2027-03-15T08:00:00.000Z')) // днес
    buyAndPayOrder(payer, [['nickname_color', 'red-1', 30]], new Date('2027-03-14T12:00:00.000Z')) // вчера
    buyAndPayOrder(payer, [['nickname_color', 'red-1', 30]], new Date('2027-03-10T12:00:00.000Z')) // 7 дни
    buyAndPayOrder(payer, [['nickname_color', 'red-1', 30]], new Date('2027-03-02T12:00:00.000Z')) // този месец
    buyAndPayOrder(payer, [['nickname_color', 'red-1', 30]], new Date('2027-01-20T12:00:00.000Z')) // само "общо"
    // 22:30 UTC на 14.03 = 00:30 на 15.03 в София -> "днес", не "вчера".
    buyAndPayOrder(payer, [['nickname_color', 'red-1', 30]], new Date('2027-03-14T22:30:00.000Z'))
    const count = (period: 'today' | 'yesterday' | 'last7days' | 'thisMonth' | 'allTime') => store.getAdminPaymentListByPeriod({ period, now }).filter((row) => row.profileId === payer).length
    assert(count('today') === 2 && count('yesterday') === 1 && count('last7days') === 4 && count('thisMonth') === 5 && count('allTime') === 6, JSON.stringify({ today: count('today'), yesterday: count('yesterday'), last7days: count('last7days'), thisMonth: count('thisMonth'), allTime: count('allTime') }))
  })

  await check('[P3] Refund: пълен -> статус "refunded", нетно 0; частичен -> "partially_refunded", нетно = платено − възстановено', () => {
    const payer = seedProfile('Payer3')
    const full = buyAndPayOrder(payer, [['nickname_color', 'red-1', 30], ['emoji_before', 'emoji-0150', 30]], at(300))
    const partial = buyAndPayOrder(payer, [['message_color', 'gold-1', 60]], at(300))
    store.applyRefund({ checkoutSessionId: full.sessionId, refundedAmountCents: 398, stripeEventId: 'evt_p3a', now: at(300) })
    store.applyRefund({ checkoutSessionId: partial.sessionId, refundedAmountCents: 100, stripeEventId: 'evt_p3b', now: at(300) })
    const rows = store.getAdminPaymentListByPeriod({ period: 'allTime', now: at(300) }).filter((row) => row.profileId === payer)
    const fullRow = rows.find((row) => row.purchaseId === full.orderId)
    const partialRow = rows.find((row) => row.purchaseId === partial.orderId)
    assert(fullRow?.status === 'refunded' && fullRow.netCents === 0 && fullRow.priceCents === 398, JSON.stringify(fullRow))
    assert(partialRow?.status === 'partially_refunded' && partialRow.netCents === 298 && partialRow.priceCents === 398, JSON.stringify(partialRow))
  })

  await check('[P4] "Детайли": всички екстри (HEX/емоджи, срок, цена на ред), обща сума, дата, Stripe Session, статус, refund', () => {
    const payer = seedProfile('Payer4')
    const order = buyAndPayOrder(payer, [['nickname_color', 'blue-1', 90], ['emoji_after', 'emoji-0160', 30]], at(400))
    store.applyRefund({ checkoutSessionId: order.sessionId, refundedAmountCents: 50, stripeEventId: 'evt_p4', now: at(401) })
    const detail = store.getAdminPaymentDetail(order.orderId)
    assert(detail !== null && detail.providerCheckoutSessionId === order.sessionId && detail.stripePaymentIntentId === order.paymentIntentId && detail.status === 'partially_refunded', JSON.stringify(detail))
    const items = detail?.customization?.items ?? []
    assert(items.length === 2 && items[0]?.itemValue === '#2B74D9' && items[0].days === 90 && items[0].priceCents === 597 && items[1]?.itemType === 'emoji' && items[1].priceCents === 199, JSON.stringify(items))
    assert(detail?.customization?.totalCents === 796 && detail.customization.paidAt === iso(400) && detail.customization.refundedAmountCents === 50 && detail.customization.refundReviewStatus === 'pending', JSON.stringify(detail?.customization))
    const pending = store.createPendingOrder({ profileId: seedProfile('Payer4b'), items: [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }], now: at(400) })
    assert(pending.ok && store.getAdminPaymentDetail(pending.order.orderId) === null, 'неплатена поръчка не е плащане')
  })
} finally {
  store.close()
  secondStore.close()
  db.close()
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
