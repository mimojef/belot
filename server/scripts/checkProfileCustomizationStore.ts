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
}

let sessionCounter = 0
/** Поръчка -> сесия -> платен webhook. Връща purchaseId и sessionId. */
function buyAndPay(profileId: string, kind: string, itemId: string, days: number, now: Date): { purchaseId: string; sessionId: string; paymentIntentId: string } {
  const created = store.createPendingPurchase({ profileId, kind, itemId, days, now })
  if (!created.ok) throw new Error(`createPendingPurchase: ${created.message}`)
  sessionCounter += 1
  const sessionId = `cs_test_${sessionCounter}_${randomUUID()}`
  const paymentIntentId = `pi_test_${sessionCounter}`
  store.attachCheckoutSession(created.purchase.purchaseId, sessionId)
  const result = store.fulfillPaidPurchase({
    checkoutSessionId: sessionId,
    purchaseId: created.purchase.purchaseId,
    stripePaymentStatus: 'paid',
    stripeCurrency: 'eur',
    stripeAmountTotalCents: created.purchase.priceCents,
    stripePaymentIntentId: paymentIntentId,
    now,
  })
  if (!result.ok) throw new Error(`fulfillPaidPurchase: ${result.message}`)
  return { purchaseId: created.purchase.purchaseId, sessionId, paymentIntentId }
}

function activeRow(profileId: string, kind: string): { item_id: string; active_until: string; chain_started_at: string } | undefined {
  return db.prepare(`SELECT item_id, active_until, chain_started_at FROM profile_customization_active WHERE profile_id = ? AND kind = ?;`).get(profileId, kind) as
    | { item_id: string; active_until: string; chain_started_at: string }
    | undefined
}

try {
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n[M] Миграция и начален каталог')

  await check('[M1] Таблиците съществуват; 4 вида с цена 1.99 € и изключена продажба', () => {
    for (const table of ['profile_customization_kind_settings', 'profile_customization_colors', 'profile_customization_emojis', 'profile_customization_purchases', 'profile_customization_active']) {
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
    const disabled = store.createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 30, now: T0 })
    assert(!disabled.ok && disabled.code === 'sales_disabled', JSON.stringify(disabled))
    enableAllSales()
    const bot = seedProfile('Bot', { human: false })
    const guest = seedProfile('Guest', { withAccount: false })
    for (const profileId of [bot, guest]) {
      const result = store.createPendingPurchase({ profileId, kind: 'nickname_color', itemId: 'red-1', days: 30, now: T0 })
      assert(!result.ok && result.code === 'profile_not_eligible', JSON.stringify(result))
    }
    const wrongType = store.createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'emoji-0001', days: 30, now: T0 })
    assert(!wrongType.ok && wrongType.code === 'item_not_found', 'емоджи като цвят')
    const wrongDays = store.createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 31, now: T0 })
    assert(!wrongDays.ok && wrongDays.code === 'invalid_duration', 'срок 31')
  })

  await check('[B2] Pending поръчка: цена от админ настройката, snapshot, повторно използване, нова при смяна на цената', () => {
    const first = store.createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 90, now: T0 })
    assert(first.ok, 'create')
    if (!first.ok) return
    assertEqual(first.purchase.priceCents, 597, 'цена 90 дни')
    assertEqual(first.purchase.itemValue, '#E81729', 'snapshot')
    assertEqual(first.preview.effect, 'new', 'ефект')
    const again = store.createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 90, now: T0 })
    assert(again.ok && again.purchase.purchaseId === first.purchase.purchaseId, 'същата поръчка')
    store.updateKindSettings('nickname_color', { basePrice30DaysCents: 299 })
    const repriced = store.createPendingPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'red-1', days: 90, now: T0 })
    assert(repriced.ok && repriced.purchase.purchaseId !== first.purchase.purchaseId && repriced.purchase.priceCents === 897, 'нова поръчка с новата цена')
    const hiddenAt = (db.prepare('SELECT hidden_at FROM profile_customization_purchases WHERE purchase_id = ?;').get(first.purchase.purchaseId) as { hidden_at: string | null }).hidden_at
    assert(hiddenAt !== null, 'старата е скрита')
    store.updateKindSettings('nickname_color', { basePrice30DaysCents: 199 })
  })

  await check('[B3] Webhook проверки: липсваща сесия, грешен purchaseId, неплатено, валута, сума -> нищо не се активира', () => {
    const created = store.createPendingPurchase({ profileId: buyer, kind: 'message_color', itemId: 'blue-2', days: 60, now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    store.attachCheckoutSession(created.purchase.purchaseId, 'cs_checks')
    const base = { checkoutSessionId: 'cs_checks', purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 398, stripePaymentIntentId: 'pi_checks', now: T0 }
    const expectReason = (overrides: Partial<typeof base>, reason: string) => {
      const result = store.fulfillPaidPurchase({ ...base, ...overrides })
      assert(!result.ok && result.reason === reason, `${reason}: ${JSON.stringify(result)}`)
    }
    expectReason({ checkoutSessionId: 'cs_unknown' }, 'purchase_not_found')
    expectReason({ purchaseId: randomUUID() }, 'purchase_id_mismatch')
    expectReason({ stripePaymentStatus: 'unpaid' }, 'not_paid')
    expectReason({ stripeCurrency: 'usd' }, 'currency_mismatch')
    expectReason({ stripeAmountTotalCents: 397 }, 'amount_mismatch')
    assertEqual(activeRow(buyer, 'message_color'), undefined, 'няма активна екстра')
    store.markPurchaseCanceledByCheckoutSessionId('cs_checks')
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
      const replay = s.fulfillPaidPurchase({ checkoutSessionId: bought.sessionId, purchaseId: bought.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 199, stripePaymentIntentId: bought.paymentIntentId, now: at(1) })
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

  await check('[B6] Различен цвят: preview предупреждава за загубените дни; след плащане новият е активен веднага ("replace")', () => {
    const preview = store.previewPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'green-2', days: 30, now: at(20) })
    assert(preview.ok && preview.preview.effect === 'replace' && preview.preview.forfeitedDays === 100 && preview.preview.current?.value === '#E81729', JSON.stringify(preview))
    const bought = buyAndPay(buyer, 'nickname_color', 'green-2', 30, at(20))
    const row = activeRow(buyer, 'nickname_color')
    assert(row?.item_id === 'green-2' && row.active_until === iso(50) && row.chain_started_at === iso(20), JSON.stringify(row))
    const purchase = store.getPurchaseById(bought.purchaseId)
    assert(purchase?.grantEffect === 'replace' && purchase.replacedItemValue === '#E81729' && purchase.replacedActiveUntil === iso(120), JSON.stringify(purchase))
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
    const blocked = store.createPendingPurchase({ profileId: other, kind: 'nickname_color', itemId: 'green-2', days: 30, now: at(21) })
    assert(!blocked.ok && blocked.code === 'item_not_for_sale', JSON.stringify(blocked))
    const extend = store.previewPurchase({ profileId: buyer, kind: 'nickname_color', itemId: 'green-2', days: 30, now: at(21) })
    assert(extend.ok && extend.preview.effect === 'extend', JSON.stringify(extend))
    assertEqual(store.getAppearancesForProfiles([buyer], at(21)).get(buyer)?.nicknameColor, '#1B8648', 'остава активен')
    store.updateColor('green-2', { isActive: true })
  })

  await check('[B9] Изтичане: след срока няма персонализация (стандартен вид); нова покупка на същия артикул започва нова верига', () => {
    assertEqual(store.getAppearancesForProfiles([buyer], at(50)).get(buyer)?.nicknameColor ?? null, null, 'изтекъл в момента на active_until')
    assertEqual(store.getProfileActiveItems(buyer, at(51)).nickname_color, null, 'изтекъл')
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
    assert(result.ok && result.outcome === 'revoked' && result.activeAfter === null, JSON.stringify(result))
    assertEqual(activeRow(user, 'emoji_before'), undefined, 'редът е изтрит')
    assertEqual(store.getPurchaseById(bought.purchaseId)?.status, 'refunded', 'статус')
    const again = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r1b', now: at(2) })
    assert(again.ok && again.outcome === 'already_refunded', JSON.stringify(again))
    const replay = store.fulfillPaidPurchase({ checkoutSessionId: bought.sessionId, purchaseId: bought.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 199, stripePaymentIntentId: null, now: at(2) })
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

  await check('[R4] Refund на заменена покупка не засяга новата (валидна) екстра', () => {
    const user = seedProfile('R4')
    const old = buyAndPay(user, 'nickname_color', 'orange-2', 90, T0)
    buyAndPay(user, 'nickname_color', 'gold-2', 30, at(10))
    const result = store.applyRefund({ checkoutSessionId: old.sessionId, refundedAmountCents: 597, stripeEventId: 'evt_r4', now: at(11) })
    assert(result.ok && result.outcome === 'revoked', JSON.stringify(result))
    const row = activeRow(user, 'nickname_color')
    assert(row?.item_id === 'gold-2' && row.active_until === iso(40), JSON.stringify(row))
  })

  await check('[R5] Refund на заменящата покупка -> видът остава без екстра (старата НЕ се възстановява)', () => {
    const user = seedProfile('R5')
    buyAndPay(user, 'nickname_color', 'orange-2', 90, T0)
    const replacement = buyAndPay(user, 'nickname_color', 'gold-2', 30, at(10))
    const result = store.applyRefund({ checkoutSessionId: replacement.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r5', now: at(11) })
    assert(result.ok && result.outcome === 'revoked' && result.activeAfter === null, JSON.stringify(result))
    assertEqual(store.getAppearancesForProfiles([user], at(11)).get(user)?.nicknameColor ?? null, null, 'стандартен вид')
  })

  await check('[R6] Частичен refund -> задължително маркиран за преглед, правата остават; прегледан; после пълен -> премахнати', () => {
    const user = seedProfile('R6')
    const bought = buyAndPay(user, 'message_color', 'red-2', 60, T0)
    const partial = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 100, stripeEventId: 'evt_r6a', now: at(1) })
    assert(partial.ok && partial.outcome === 'partial_recorded' && partial.activeAfter?.activeUntil === iso(60), JSON.stringify(partial))
    const purchase = store.getPurchaseById(bought.purchaseId)
    assert(purchase?.status === 'paid' && purchase.refundedAmountCents === 100 && purchase.refundedAt !== null && purchase.refundReviewStatus === 'pending', JSON.stringify(purchase))
    assert(store.countPendingRefundReviews() === 1, 'брояч за преглед')
    const reviewList = store.listAdminPurchases({ limit: 10, offset: 0, status: 'review_pending' })
    assert(reviewList.total === 1 && reviewList.rows[0]?.purchaseId === bought.purchaseId, 'филтър "чака преглед"')
    const duplicatePartial = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 100, stripeEventId: 'evt_r6a_dup', now: at(1) })
    assert(duplicatePartial.ok && duplicatePartial.outcome === 'partial_recorded', 'повторен частичен')
    assert(store.markRefundReviewed(bought.purchaseId) && !store.markRefundReviewed(bought.purchaseId), 'прегледан веднъж')
    assert(store.countPendingRefundReviews() === 0, 'няма чакащи')
    const sameAgain = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 100, stripeEventId: 'evt_r6a_dup2', now: at(1) })
    assert(sameAgain.ok && store.getPurchaseById(bought.purchaseId)?.refundReviewStatus === 'reviewed', 'същата сума не връща за преглед')
    store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 150, stripeEventId: 'evt_r6a_more', now: at(1) })
    assert(store.getPurchaseById(bought.purchaseId)?.refundReviewStatus === 'pending', 'по-голяма частична сума -> пак за преглед')
    const full = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 398, stripeEventId: 'evt_r6b', now: at(2) })
    assert(full.ok && full.outcome === 'revoked' && activeRow(user, 'message_color') === undefined, JSON.stringify(full))
    const stale = store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 100, stripeEventId: 'evt_r6a', now: at(3) })
    assert(stale.ok && stale.outcome === 'already_refunded' && store.getPurchaseById(bought.purchaseId)?.refundedAmountCents === 398, 'закъсняло събитие не намалява сумата')
  })

  await check('[R7] Refund преди checkout.session.completed -> кредитирането не активира нищо', () => {
    const user = seedProfile('R7')
    const created = store.createPendingPurchase({ profileId: user, kind: 'emoji_after', itemId: 'emoji-0200', days: 30, now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    store.attachCheckoutSession(created.purchase.purchaseId, 'cs_r7')
    const early = store.applyRefund({ checkoutSessionId: 'cs_r7', refundedAmountCents: 199, stripeEventId: 'evt_r7', now: T0 })
    assert(early.ok && early.outcome === 'recorded_before_credit', JSON.stringify(early))
    const fulfill = store.fulfillPaidPurchase({ checkoutSessionId: 'cs_r7', purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 199, stripePaymentIntentId: 'pi_r7', now: at(0.01) })
    assert(fulfill.ok && fulfill.refundedBeforeCredit && !fulfill.alreadyCredited, JSON.stringify(fulfill))
    assertEqual(store.getPurchaseById(created.purchase.purchaseId)?.status, 'refunded', 'статус')
    assertEqual(activeRow(user, 'emoji_after'), undefined, 'нищо активно')
  })

  await check('[R7b] Частичен refund преди checkout.session.completed -> правата се активират, покупката чака преглед', () => {
    const user = seedProfile('R7b')
    const created = store.createPendingPurchase({ profileId: user, kind: 'emoji_after', itemId: 'emoji-0201', days: 60, now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    store.attachCheckoutSession(created.purchase.purchaseId, 'cs_r7b')
    store.applyRefund({ checkoutSessionId: 'cs_r7b', refundedAmountCents: 50, stripeEventId: 'evt_r7b', now: T0 })
    const fulfill = store.fulfillPaidPurchase({ checkoutSessionId: 'cs_r7b', purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 398, stripePaymentIntentId: 'pi_r7b', now: T0 })
    assert(fulfill.ok && !fulfill.refundedBeforeCredit && fulfill.purchase.status === 'paid' && fulfill.purchase.refundReviewStatus === 'pending', JSON.stringify(fulfill))
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
    db.prepare('DELETE FROM profiles WHERE profile_id = ?;').run(user)
    const row = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, status, price_cents_snapshot FROM profile_customization_purchases WHERE purchase_id = ?;').get(bought.purchaseId) as Record<string, unknown>
    assert(row.profile_id === null && row.deleted_profile_id_snapshot === user && row.status === 'paid' && row.price_cents_snapshot === 199, JSON.stringify(row))
    assertEqual(activeRow(user, 'nickname_color'), undefined, 'CASCADE')
    const replay = store.fulfillPaidPurchase({ checkoutSessionId: bought.sessionId, purchaseId: bought.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 199, stripePaymentIntentId: null })
    assert(replay.ok && replay.alreadyCredited && replay.active === null, 'повторен webhook след изтриване')
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
    const created = store.createPendingPurchase({ profileId: user, kind: 'message_color', itemId: 'gold-1', days: 150, now: T0 })
    assert(created.ok, 'create')
    if (!created.ok) return
    const params = buildProfileCustomizationCheckoutSessionParams(created.purchase, user, { successUrl: 'https://pika.bg/ok', cancelUrl: 'https://pika.bg/cancel' })
    const item = params.line_items?.[0]
    assertEqual(item?.price_data?.unit_amount, 995, 'сума')
    assertEqual(item?.price_data?.currency, 'eur', 'валута')
    assertEqual(item?.price_data?.product_data?.name, 'Pika.bg — Цвят на текста на съобщенията: Старо злато (#976F08) — 150 дни', 'име')
    assertEqual(params.metadata?.purchaseType, 'profile_customization', 'purchaseType')
    assertEqual(params.metadata?.purchaseId, created.purchase.purchaseId, 'purchaseId')
  })

  await check('[C3] Админ статистика: платени/възстановени/активни по вид', () => {
    const stats = store.getAdminKindStats(at(21))
    const nickname = stats.find((row) => row.kind === 'nickname_color')
    assert(nickname !== undefined && nickname.paidCount > 0 && nickname.refundedCount > 0 && nickname.activeNowCount > 0, JSON.stringify(nickname))
    const page = store.listAdminPurchases({ limit: 5, offset: 0, status: 'refunded' })
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
    assert(failed.ok && failed.outcome === 'marked_for_review' && failed.purchase.refundReviewStatus === 'pending' && failed.purchase.refundReviewReason === 'refund_failed', JSON.stringify(failed))
    assertEqual(activeRow(user, 'nickname_color'), undefined, 'няма автоматично възстановяване')
    assertEqual(store.getPurchaseById(bought.purchaseId)?.status, 'refunded', 'статусът не се пипа')
    const again = store.recordRefundFailure({ paymentIntentId: bought.paymentIntentId, stripeRefundId: 're_r11', stripeEventId: 'evt_r11_failed_dup' })
    assert(again.ok && again.outcome === 'already_recorded', 'повторна доставка')
    assert(store.markRefundReviewed(bought.purchaseId, { profileId: reviewer, displayName: 'Проверяващ' }), 'преглед')
    const reviewed = store.getPurchaseById(bought.purchaseId)
    assert(reviewed?.refundReviewStatus === 'reviewed' && reviewed.refundReviewedByDisplayName === 'Проверяващ' && reviewed.refundReviewedAt !== null, JSON.stringify(reviewed))
    const reviewerId = (db.prepare('SELECT refund_reviewed_by_profile_id AS id FROM profile_customization_purchases WHERE purchase_id = ?;').get(bought.purchaseId) as { id: string }).id
    assertEqual(reviewerId, reviewer, 'кой')
    const redelivered = store.recordRefundFailure({ paymentIntentId: bought.paymentIntentId, stripeRefundId: 're_r11', stripeEventId: 'evt_r11_failed_dup2' })
    assert(redelivered.ok && redelivered.outcome === 'already_recorded' && store.getPurchaseById(bought.purchaseId)?.refundReviewStatus === 'reviewed', 'прегледан случай не се отваря отново')
    const unknown = store.recordRefundFailure({ paymentIntentId: 'pi_unknown_r11', stripeRefundId: 're_x', stripeEventId: 'evt_x' })
    assert(!unknown.ok && unknown.reason === 'purchase_not_found', 'непозната')
  })

  await check('[R12] Неуспешен refund, пристигнал ПРЕДИ charge.refunded: случаят остава маркиран и след анулирането', () => {
    const user = seedProfile('R12')
    const bought = buyAndPay(user, 'emoji_after', 'emoji-0400', 30, T0)
    store.recordRefundFailure({ checkoutSessionId: bought.sessionId, stripeRefundId: 're_r12', stripeEventId: 'evt_r12_failed' })
    store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 199, stripeEventId: 'evt_r12_refund', now: at(1) })
    const purchase = store.getPurchaseById(bought.purchaseId)
    assert(purchase?.status === 'refunded' && purchase.refundReviewStatus === 'pending' && purchase.refundReviewReason === 'refund_failed', JSON.stringify(purchase))
  })

  await check('[R13] Частичният refund записва причина partial_refund', () => {
    const user = seedProfile('R13')
    const bought = buyAndPay(user, 'message_color', 'teal-2', 30, T0)
    store.applyRefund({ checkoutSessionId: bought.sessionId, refundedAmountCents: 50, stripeEventId: 'evt_r13', now: at(1) })
    const purchase = store.getPurchaseById(bought.purchaseId)
    assert(purchase?.refundReviewStatus === 'pending' && purchase.refundReviewReason === 'partial_refund', JSON.stringify(purchase))
  })

  await check('[B11] Тестов режим на admin (ignoreSalesToggle): покупка при изключена публична продажба; без него — отказ', () => {
    const user = seedProfile('B11')
    store.updateKindSettings('emoji_after', { salesEnabled: false })
    const blocked = store.previewPurchase({ profileId: user, kind: 'emoji_after', itemId: 'emoji-0500', days: 30 })
    assert(!blocked.ok && blocked.code === 'sales_disabled', 'обикновено -> отказ')
    const allowed = store.createPendingPurchase({ profileId: user, kind: 'emoji_after', itemId: 'emoji-0500', days: 30, ignoreSalesToggle: true })
    assert(allowed.ok && allowed.purchase.priceCents === 199, JSON.stringify(allowed))
    store.updateKindSettings('emoji_after', { salesEnabled: true })
  })
} finally {
  store.close()
  secondStore.close()
  db.close()
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
