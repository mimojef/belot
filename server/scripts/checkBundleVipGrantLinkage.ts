/**
 * checkBundleVipGrantLinkage.ts
 *
 * PRE-DEPLOY BLOCKER regression за 20260923_005_fix_bundle_vip_grant_linkage.sql
 * — vip_grants.purchase_id е FK СТРИКТНО към vip_purchase_ledger(purchase_id)
 * (20260818_008, отпреди bundle feature-a); bundlePurchaseStore.ts преди fix-а
 * пишеше bundle_purchase_ledger.purchase_id В ТАЗИ СЪЩА колона за bundle-
 * generated grants (reason='purchase' reuse), което с реално активен PRAGMA
 * foreign_keys=ON би fail-нало с "FOREIGN KEY constraint failed" при ВСЯКА
 * платена bundle покупка. Production verification (read-only, 185.203.117.14,
 * 2026-09-23): production HEAD е ПРЕДИ bundle feature-a (няма
 * bundle_purchase_ledger изобщо) — нулев текущ impact, стриктен pre-deploy
 * blocker. Fix: отделна nullable bundle_purchase_id колона (mirror на
 * established purchase_id pattern), purchase_id остава ИЗКЛЮЧИТЕЛНО за
 * VIP-direct.
 *
 * За разлика от checkBundlePurchaseStore.ts/checkPaidGiftShopStores.ts (hand-
 * rolled test schema БЕЗ FK ограничения — точно защото маскираха тази находка),
 * тук схемата идва ИЗЦЯЛО от реалния migration runner
 * (ensureServerDatabaseReady), с реално активен PRAGMA foreign_keys=ON —
 * единственият начин действително да се докаже, че fix-ът работи срещу
 * production-еквивалентна схема.
 *
 * [1]  Normal bundle purchase (без recipient) с VIP -> success, payer credited
 * [2]  Bundle gift с VIP -> RECIPIENT credited, payer непроменен
 * [3]  vip_grants linkage валиден след INSERT: bundle_purchase_id = bundle
 *        purchase id, purchase_id IS NULL (за bundle-generated grants)
 * [4]  PRAGMA foreign_key_check чист след всички операции по-горе
 * [5]  Duplicate webhook (същия checkoutSessionId) -> exactly ONE vip_grants
 *        ред, без повторен credit
 * [6]  Standalone VIP purchase (vipPurchaseStore, НЕПРОМЕНЕН flow) остава
 *        регресия-safe върху СЪЩАТА реална схема: purchase_id се попълва,
 *        bundle_purchase_id остава NULL, idx_vip_grants_purchase_id_once
 *        продължава да пази duplicate-webhook idempotency
 * [7]  Payer hard-deleted ПРЕДИ webhook (нормална bundle покупка) -> late
 *        webhook safe-fail (без crash, без arbitrary credit, ledger остава
 *        pending); GIFT вариант (payer hard-deleted, recipient жив) ->
 *        recipient ВСЕ ПАК получава наградата коректно
 * [8]  Migration chain апликва чисто от РЕАЛНО production-еквивалентно
 *        pre-bundle състояние (без 001-005 изобщо, mirror на потвърдения
 *        production HEAD) — всичките 6 файла заедно, на бъдещ deploy
 * [9]  Realistic DB (с pre-existing несвързани данни — profiles/coin
 *        purchases отпреди bundle feature-a) апликва чисто, без interference
 * [10] PRAGMA integrity_check = 'ok' след пълната верига
 */

import { mkdtemp, rm, mkdir, cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { normalizeProfileDisplayName } from '../src/db/normalizeProfileIdentityText.js'
import { createBundlePurchaseStore } from '../src/db/bundlePurchaseStore.js'
import { createVipPurchaseStore } from '../src/db/vipPurchaseStore.js'

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

const REAL_MIGRATIONS_DIR = join(process.cwd(), 'database', 'migrations')
const BUNDLE_FEATURE_MIGRATION_FILENAMES = [
  '20260923_001_create_shop_bundle_packages.sql',
  '20260923_002_add_gift_recipient_to_purchase_ledgers.sql',
  '20260923_003_create_paid_gift_notification_log.sql',
  '20260923_004_preserve_bundle_purchase_history_on_profile_delete.sql',
  '20260923_005_fix_bundle_vip_grant_linkage.sql',
  // Shop -> "Пакети" Premium Visual System — visual_key колоната зависи от
  // shop_bundle_packages (20260923_001), затова принадлежи към СЪЩАТА
  // "production все още няма bundle feature-а" pre-condition group.
  '20260924_001_add_visual_key_to_shop_bundle_packages.sql',
]

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-bundle-vip-linkage-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function seedFakeServerRootWithRealMigrations(
  fakeServerRoot: string,
  excludeFilenames: string[] = [],
): Promise<void> {
  const destMigrationsDir = join(fakeServerRoot, 'database', 'migrations')
  await mkdir(destMigrationsDir, { recursive: true })
  const entries = await readdir(REAL_MIGRATIONS_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (excludeFilenames.includes(entry.name)) continue
    await cp(join(REAL_MIGRATIONS_DIR, entry.name), join(destMigrationsDir, entry.name))
  }
}

function seedProfile(db: DatabaseSync, profileId: string, displayName: string): void {
  const accountId = `acc_${profileId}`
  db.prepare(`INSERT OR IGNORE INTO accounts (account_id, email) VALUES (?, ?)`).run(accountId, `${profileId}@example.test`)
  db.prepare(`
    INSERT INTO profiles (profile_id, account_id, profile_kind, display_name, normalized_display_name, status, is_temporary)
    VALUES (?, ?, 'human', ?, ?, 'active', 0)
  `).run(profileId, accountId, displayName, normalizeProfileDisplayName(displayName))
}

function getWalletBalance(db: DatabaseSync, profileId: string): number {
  const row = db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
    | { yellow_coins_balance: number } | undefined
  return row?.yellow_coins_balance ?? 0
}

function getActiveUntil(db: DatabaseSync, profileId: string): string | null {
  const row = db.prepare(`SELECT active_until FROM vip_status WHERE profile_id = ?`).get(profileId) as
    | { active_until: string } | undefined
  return row?.active_until ?? null
}

let sessionCounter = 0
function nextSessionId(): string {
  sessionCounter += 1
  return `cs_test_linkage_${sessionCounter}`
}

console.log('\ncheckBundleVipGrantLinkage\n')

// ─── [1]-[6] Основен fulfillment matrix (една реално мигрирана DB) ─────────

await withTempDir(async (dir) => {
  const fakeServerRoot = join(dir, 'main')
  await seedFakeServerRootWithRealMigrations(fakeServerRoot)
  const dbPath = join(fakeServerRoot, 'database', 'data', 'belot-v2.sqlite')
  await ensureServerDatabaseReady({ serverRootOverride: fakeServerRoot, databaseFilePathOverride: dbPath })

  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')

  seedProfile(db, 'link-payer-1', 'Payer One')
  seedProfile(db, 'link-payer-2', 'Payer Two')
  seedProfile(db, 'link-recipient-1', 'Recipient One')
  seedProfile(db, 'link-vip-payer', 'VIP Payer')

  db.prepare(`
    INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status, sort_order)
    VALUES ('link-pkg-1', 'link_bundle_1', 'Linkage Test Bundle', 500000, 30, 1999, 'EUR', 'active', 10)
  `).run()
  db.close()

  const bundleStore = await createBundlePurchaseStore(dbPath)
  const vipStore = await createVipPurchaseStore(dbPath)

  // ── [1] Normal bundle purchase -> success ─────────────────────────────
  let normalPurchaseId = ''
  let normalSessionId = ''
  await check('[1] Normal bundle purchase (без recipient) с VIP -> success, payer credited', () => {
    const pending = bundleStore.createPendingPurchase('link-payer-1', 'link-pkg-1')
    assert(pending.ok, 'pending purchase трябва да се създаде')
    if (!pending.ok) throw new Error('setup failed')
    normalPurchaseId = pending.purchase.purchaseId
    normalSessionId = nextSessionId()
    bundleStore.attachCheckoutSession(normalPurchaseId, normalSessionId)

    const result = bundleStore.fulfillPaidPurchase({
      checkoutSessionId: normalSessionId,
      purchaseId: normalPurchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1999,
    })

    assert(result.ok, `fulfillment трябва да успее: ${!result.ok ? result.message : ''}`)
    if (!result.ok) throw new Error('unreachable')
    assertEqual(result.alreadyCredited, false, 'първи fulfillment не е "already credited"')
  })

  const dbRead1 = new DatabaseSync(dbPath, { open: true, readOnly: true })
  await check('[1b] Payer wallet/VIP реално credited', () => {
    assertEqual(getWalletBalance(dbRead1, 'link-payer-1'), 500000, 'payer трябва да получи coins')
    assert(getActiveUntil(dbRead1, 'link-payer-1') !== null, 'payer трябва да получи VIP')
  })
  dbRead1.close()

  // ── [2] Bundle gift -> RECIPIENT credited, payer непроменен ───────────
  let giftPurchaseId = ''
  let giftSessionId = ''
  await check('[2] Bundle gift с VIP -> RECIPIENT credited, payer непроменен', () => {
    const pending = bundleStore.createPendingPurchase('link-payer-2', 'link-pkg-1', 'link-recipient-1')
    assert(pending.ok, 'gift pending purchase трябва да се създаде')
    if (!pending.ok) throw new Error('setup failed')
    giftPurchaseId = pending.purchase.purchaseId
    giftSessionId = nextSessionId()
    bundleStore.attachCheckoutSession(giftPurchaseId, giftSessionId)

    const result = bundleStore.fulfillPaidPurchase({
      checkoutSessionId: giftSessionId,
      purchaseId: giftPurchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1999,
    })
    assert(result.ok, `gift fulfillment трябва да успее: ${!result.ok ? result.message : ''}`)
  })

  const dbRead2 = new DatabaseSync(dbPath, { open: true, readOnly: true })
  await check('[2b] Recipient credited, payer-2 НЕ credited', () => {
    assertEqual(getWalletBalance(dbRead2, 'link-recipient-1'), 500000, 'recipient трябва да получи coins')
    assert(getActiveUntil(dbRead2, 'link-recipient-1') !== null, 'recipient трябва да получи VIP')
    assertEqual(getWalletBalance(dbRead2, 'link-payer-2'), 0, 'payer-2 (gift sender) НЕ трябва да получи coins')
    assertEqual(getActiveUntil(dbRead2, 'link-payer-2'), null, 'payer-2 (gift sender) НЕ трябва да получи VIP')
  })
  dbRead2.close()

  // ── [3] vip_grants linkage валиден ─────────────────────────────────────
  const dbRead3 = new DatabaseSync(dbPath, { open: true, readOnly: true })
  await check('[3] vip_grants linkage: bundle_purchase_id = bundle purchase id, purchase_id IS NULL', () => {
    type GrantRow = { grant_id: string; purchase_id: string | null; bundle_purchase_id: string | null; profile_id: string }
    const normalGrant = dbRead3.prepare(`SELECT grant_id, purchase_id, bundle_purchase_id, profile_id FROM vip_grants WHERE bundle_purchase_id = ?`).get(normalPurchaseId) as GrantRow | undefined
    assert(normalGrant !== undefined, 'grant за normal bundle покупка трябва да съществува')
    assertEqual(normalGrant!.purchase_id, null, 'purchase_id ТРЯБВА да е NULL за bundle-generated grant')
    assertEqual(normalGrant!.bundle_purchase_id, normalPurchaseId, 'bundle_purchase_id трябва да сочи towards bundle покупката')
    assertEqual(normalGrant!.profile_id, 'link-payer-1', 'grant profile_id е payer-а (normal purchase)')

    const giftGrant = dbRead3.prepare(`SELECT grant_id, purchase_id, bundle_purchase_id, profile_id FROM vip_grants WHERE bundle_purchase_id = ?`).get(giftPurchaseId) as GrantRow | undefined
    assert(giftGrant !== undefined, 'grant за gift bundle покупка трябва да съществува')
    assertEqual(giftGrant!.purchase_id, null, 'purchase_id ТРЯБВА да е NULL за gift bundle grant')
    assertEqual(giftGrant!.profile_id, 'link-recipient-1', 'grant profile_id е RECIPIENT-а (gift), не payer-а')
  })
  dbRead3.close()

  // ── [4] PRAGMA foreign_key_check чист ──────────────────────────────────
  const dbRead4 = new DatabaseSync(dbPath, { open: true, readOnly: true })
  await check('[4] PRAGMA foreign_key_check чист след [1]-[3]', () => {
    const violations = dbRead4.prepare(`PRAGMA foreign_key_check;`).all()
    assertEqual(violations.length, 0, `трябва да е празен, намерени: ${JSON.stringify(violations)}`)
  })
  dbRead4.close()

  // ── [5] Duplicate webhook -> exactly ONE grant ─────────────────────────
  await check('[5] Duplicate webhook (същия checkoutSessionId) -> exactly ONE vip_grants ред, без повторен credit', () => {
    const walletBefore = (() => {
      const d = new DatabaseSync(dbPath, { open: true, readOnly: true })
      const v = getWalletBalance(d, 'link-payer-1')
      d.close()
      return v
    })()

    const result = bundleStore.fulfillPaidPurchase({
      checkoutSessionId: normalSessionId,
      purchaseId: normalPurchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1999,
    })
    assert(result.ok, 'duplicate webhook НЕ трябва да хвърли грешка')
    if (result.ok) assertEqual(result.alreadyCredited, true, 'втори опит трябва да е alreadyCredited=true')

    const d = new DatabaseSync(dbPath, { open: true, readOnly: true })
    const walletAfter = getWalletBalance(d, 'link-payer-1')
    const grantCount = (d.prepare(`SELECT COUNT(*) AS c FROM vip_grants WHERE bundle_purchase_id = ?`).get(normalPurchaseId) as { c: number }).c
    d.close()

    assertEqual(walletAfter, walletBefore, 'duplicate webhook НЕ трябва да credit-не отново')
    assertEqual(grantCount, 1, 'ТОЧНО 1 vip_grants ред за тази bundle покупка, дори след duplicate webhook')
  })

  // ── [6] Standalone VIP purchase regression (СЪЩАТА реална схема) ──────
  let vipPurchaseId = ''
  let vipSessionId = ''
  await check('[6] Standalone VIP purchase (vipPurchaseStore) остава регресия-safe', () => {
    const pending = vipStore.createPendingPurchase('link-vip-payer', 'vip_30', 299)
    assert(pending.ok, 'VIP pending purchase трябва да се създаде')
    if (!pending.ok) throw new Error('setup failed')
    vipPurchaseId = pending.purchase.purchaseId
    vipSessionId = nextSessionId()
    vipStore.attachCheckoutSession(vipPurchaseId, vipSessionId)

    const result = vipStore.fulfillPaidPurchase({
      checkoutSessionId: vipSessionId,
      purchaseId: vipPurchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 299,
    })
    assert(result.ok, `VIP fulfillment трябва да успее: ${!result.ok ? result.message : ''}`)
  })

  const dbRead6 = new DatabaseSync(dbPath, { open: true, readOnly: true })
  await check('[6b] Standalone VIP grant: purchase_id попълнен, bundle_purchase_id NULL', () => {
    type GrantRow = { purchase_id: string | null; bundle_purchase_id: string | null }
    const grant = dbRead6.prepare(`SELECT purchase_id, bundle_purchase_id FROM vip_grants WHERE purchase_id = ?`).get(vipPurchaseId) as GrantRow | undefined
    assert(grant !== undefined, 'VIP-direct grant трябва да съществува с purchase_id')
    assertEqual(grant!.purchase_id, vipPurchaseId, 'purchase_id трябва да сочи towards VIP покупката')
    assertEqual(grant!.bundle_purchase_id, null, 'bundle_purchase_id трябва да остане NULL за VIP-direct grant')
  })
  dbRead6.close()

  await check('[6c] Standalone VIP duplicate webhook продължава да е idempotent (idx_vip_grants_purchase_id_once)', () => {
    const result = vipStore.fulfillPaidPurchase({
      checkoutSessionId: vipSessionId,
      purchaseId: vipPurchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 299,
    })
    assert(result.ok, 'duplicate VIP webhook НЕ трябва да хвърли грешка')
    if (result.ok) assertEqual(result.alreadyCredited, true, 'duplicate VIP webhook трябва да е alreadyCredited=true')

    const d = new DatabaseSync(dbPath, { open: true, readOnly: true })
    const grantCount = (d.prepare(`SELECT COUNT(*) AS c FROM vip_grants WHERE purchase_id = ?`).get(vipPurchaseId) as { c: number }).c
    d.close()
    assertEqual(grantCount, 1, 'ТОЧНО 1 vip_grants ред за VIP-direct покупката, дори след duplicate webhook')
  })

  bundleStore.close()
  vipStore.close()
})

// ─── [7] Payer hard-deleted ПРЕДИ webhook (нормална + gift вариант) ────────

await withTempDir(async (dir) => {
  const fakeServerRoot = join(dir, 'harddelete')
  await seedFakeServerRootWithRealMigrations(fakeServerRoot)
  const dbPath = join(fakeServerRoot, 'database', 'data', 'belot-v2.sqlite')
  await ensureServerDatabaseReady({ serverRootOverride: fakeServerRoot, databaseFilePathOverride: dbPath })

  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')

  seedProfile(db, 'hd-payer-normal', 'Payer Normal')
  seedProfile(db, 'hd-payer-gift', 'Payer Gift')
  seedProfile(db, 'hd-recipient', 'Recipient')

  db.prepare(`
    INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status, sort_order)
    VALUES ('hd-pkg-1', 'hd_bundle_1', 'Hard Delete Test Bundle', 500000, 30, 1999, 'EUR', 'active', 10)
  `).run()
  db.close()

  const bundleStore = await createBundlePurchaseStore(dbPath)

  // ── Нормална (non-gift) покупка, payer hard-deleted ПРЕДИ webhook ──────
  const normalPending = bundleStore.createPendingPurchase('hd-payer-normal', 'hd-pkg-1')
  assert(normalPending.ok, 'setup: normal pending purchase')
  if (!normalPending.ok) throw new Error('setup failed')
  const normalPurchaseId = normalPending.purchase.purchaseId
  const normalSessionId = nextSessionId()
  bundleStore.attachCheckoutSession(normalPurchaseId, normalSessionId)

  const dbDelete1 = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  dbDelete1.exec('PRAGMA foreign_keys = ON;')
  dbDelete1.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run('hd-payer-normal')
  dbDelete1.close()

  await check('[7a] Normal bundle покупка: payer hard-delete ПРЕДИ webhook -> profile_id NULL, редът оцелява', () => {
    const d = new DatabaseSync(dbPath, { open: true, readOnly: true })
    const row = d.prepare(`SELECT profile_id, status FROM bundle_purchase_ledger WHERE purchase_id = ?`).get(normalPurchaseId) as { profile_id: string | null; status: string } | undefined
    d.close()
    assert(row !== undefined, 'ledger редът трябва да оцелее (SET NULL, не CASCADE delete)')
    assertEqual(row!.profile_id, null, 'profile_id трябва да е NULL след hard delete')
    assertEqual(row!.status, 'pending', 'редът остава pending до webhook-а')
  })

  await check('[7b] CRITICAL: late webhook за normal покупка с NULL payer -> safe-fail, БЕЗ crash, БЕЗ ghost credit', () => {
    const result = bundleStore.fulfillPaidPurchase({
      checkoutSessionId: normalSessionId,
      purchaseId: normalPurchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1999,
    })
    assertEqual(result.ok, false, 'safe-fail: fulfillment трябва да върне ok:false (не crash, не arbitrary credit)')
    if (!result.ok) {
      assert(result.message.includes('Купувачът вече не съществува'), `очаквано safe-fail съобщение, получено: ${result.message}`)
    }

    const d = new DatabaseSync(dbPath, { open: true, readOnly: true })
    const row = d.prepare(`SELECT status FROM bundle_purchase_ledger WHERE purchase_id = ?`).get(normalPurchaseId) as { status: string }
    const ghostWalletCount = (d.prepare(`SELECT COUNT(*) AS c FROM profile_wallets WHERE profile_id IS NULL`).get() as { c: number }).c
    const ghostVipStatusCount = (d.prepare(`SELECT COUNT(*) AS c FROM vip_status WHERE profile_id IS NULL`).get() as { c: number }).c
    const ghostGrantCount = (d.prepare(`SELECT COUNT(*) AS c FROM vip_grants WHERE bundle_purchase_id = ?`).get(normalPurchaseId) as { c: number }).c
    const fkViolations = d.prepare(`PRAGMA foreign_key_check;`).all()
    d.close()

    assertEqual(row.status, 'pending', 'редът остава pending за ръчен преглед (не се губи, не се маркира failed)')
    assertEqual(ghostWalletCount, 0, 'НЕ трябва да съществува ghost profile_wallets ред с profile_id=NULL')
    assertEqual(ghostVipStatusCount, 0, 'НЕ трябва да съществува ghost vip_status ред с profile_id=NULL')
    assertEqual(ghostGrantCount, 0, 'НЕ трябва да е създаден vip_grants ред за тази покупка')
    assertEqual(fkViolations.length, 0, 'foreign_key_check остава чист')
  })

  // ── Gift покупка, PAYER hard-deleted (recipient жив) — критичен сценарий D ──
  const giftPending = bundleStore.createPendingPurchase('hd-payer-gift', 'hd-pkg-1', 'hd-recipient')
  assert(giftPending.ok, 'setup: gift pending purchase')
  if (!giftPending.ok) throw new Error('setup failed')
  const giftPurchaseId = giftPending.purchase.purchaseId
  const giftSessionId = nextSessionId()
  bundleStore.attachCheckoutSession(giftPurchaseId, giftSessionId)

  const dbDelete2 = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  dbDelete2.exec('PRAGMA foreign_keys = ON;')
  dbDelete2.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run('hd-payer-gift')
  dbDelete2.close()

  await check('[7c] CRITICAL scenario D: gift bundle, PAYER hard-deleted (recipient жив) -> recipient ВСЕ ПАК получава наградата', () => {
    const result = bundleStore.fulfillPaidPurchase({
      checkoutSessionId: giftSessionId,
      purchaseId: giftPurchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1999,
    })
    assert(result.ok, `gift fulfillment трябва да успее въпреки изтрития payer: ${!result.ok ? result.message : ''}`)

    const d = new DatabaseSync(dbPath, { open: true, readOnly: true })
    const recipientBalance = getWalletBalance(d, 'hd-recipient')
    const recipientVip = getActiveUntil(d, 'hd-recipient')
    const grant = d.prepare(`SELECT profile_id, bundle_purchase_id, purchase_id FROM vip_grants WHERE bundle_purchase_id = ?`).get(giftPurchaseId) as
      | { profile_id: string; bundle_purchase_id: string; purchase_id: string | null } | undefined
    const fkViolations = d.prepare(`PRAGMA foreign_key_check;`).all()
    d.close()

    assertEqual(recipientBalance, 500000, 'recipient трябва да получи coins, независимо от изтрития payer')
    assert(recipientVip !== null, 'recipient трябва да получи VIP, независимо от изтрития payer')
    assert(grant !== undefined, 'grant трябва да е създаден')
    assertEqual(grant!.profile_id, 'hd-recipient', 'grant-ът е за recipient-а, никога fallback към payer-а')
    assertEqual(grant!.purchase_id, null, 'purchase_id остава NULL (bundle-generated grant)')
    assertEqual(fkViolations.length, 0, 'foreign_key_check остава чист')
  })

  bundleStore.close()
})

// ─── [8]-[10] Migration chain от РЕАЛНО production-еквивалентно състояние ──

await withTempDir(async (dir) => {
  const fakeServerRoot = join(dir, 'prod-equivalent')
  // Точно текущото production състояние (потвърдено read-only на
  // 185.203.117.14): всичките 6 bundle/paid-gift migration файла ОТСЪСТВАТ.
  await seedFakeServerRootWithRealMigrations(fakeServerRoot, BUNDLE_FEATURE_MIGRATION_FILENAMES)
  const dbPath = join(fakeServerRoot, 'database', 'data', 'belot-v2.sqlite')

  await check('[8 setup] Production-еквивалентна pre-bundle DB апликва чисто', async () => {
    const result = await ensureServerDatabaseReady({ serverRootOverride: fakeServerRoot, databaseFilePathOverride: dbPath })
    assert(result.appliedCount > 0, 'трябва да приложи established миграциите (без bundle-related)')
    for (const bundleFile of BUNDLE_FEATURE_MIGRATION_FILENAMES) {
      assert(!result.appliedMigrations.some((m) => m.filename === bundleFile), `${bundleFile} НЕ трябва да е приложена в pre-bundle фазата`)
    }
  })

  // Realistic pre-existing (несвързани с bundle) данни — доказва, че
  // миграциите не interferирват с established coin/profile данни.
  const dbPre = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  dbPre.exec('PRAGMA foreign_keys = ON;')
  seedProfile(dbPre, 'legacy-profile-1', 'Legacy Profile')
  dbPre.prepare(`
    INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status, sort_order)
    VALUES ('legacy-coin-pkg', 'legacy_coins', 'Legacy Coins', 100000, 499, 'EUR', 'active', 10)
  `).run()
  dbPre.prepare(`
    INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot, yellow_coins_amount, price_cents, currency, provider, status)
    VALUES ('legacy-purchase-1', 'legacy-profile-1', 'legacy-coin-pkg', 'legacy_coins', 'Legacy Coins', 100000, 499, 'EUR', 'stripe', 'paid')
  `).run()
  dbPre.close()

  // Реалният бъдещ deploy — всичките 6 файла пристигат ЗАЕДНО.
  await seedFakeServerRootWithRealMigrations(fakeServerRoot, [])

  await check('[8] Migration chain (всичките 6 bundle/paid-gift файла заедно) апликва чисто от production-еквивалентно състояние', async () => {
    const result = await ensureServerDatabaseReady({ serverRootOverride: fakeServerRoot, databaseFilePathOverride: dbPath })
    assertEqual(result.appliedCount, BUNDLE_FEATURE_MIGRATION_FILENAMES.length, `трябва да приложи точно ${BUNDLE_FEATURE_MIGRATION_FILENAMES.length} нови миграции`)
    const appliedNames = result.appliedMigrations.map((m) => m.filename)
    for (const expected of BUNDLE_FEATURE_MIGRATION_FILENAMES) {
      assert(appliedNames.includes(expected), `${expected} трябва да е сред приложените`)
    }
  })

  const dbAfter = new DatabaseSync(dbPath, { open: true, readOnly: true })

  await check('[9] Pre-existing (несвързани с bundle) данни оцеляват непокътнати', () => {
    const row = dbAfter.prepare(`SELECT profile_id, status, yellow_coins_amount FROM coin_purchase_ledger WHERE purchase_id = 'legacy-purchase-1'`).get() as
      | { profile_id: string; status: string; yellow_coins_amount: number } | undefined
    assert(row !== undefined, 'legacy coin purchase редът трябва да оцелее')
    assertEqual(row!.profile_id, 'legacy-profile-1', 'profile_id непроменен')
    assertEqual(row!.status, 'paid', 'status непроменен')
    assertEqual(row!.yellow_coins_amount, 100000, 'yellow_coins_amount непроменен')
  })

  await check('[9b] Новите таблици/колони съществуват след пълния bundle chain', () => {
    const bundleCols = (dbAfter.prepare(`PRAGMA table_info(bundle_purchase_ledger)`).all() as Array<{ name: string; notnull: number }>)
    const profileIdCol = bundleCols.find((c) => c.name === 'profile_id')
    assert(profileIdCol !== undefined && profileIdCol.notnull === 0, 'bundle_purchase_ledger.profile_id трябва да е nullable')

    const vipGrantsCols = (dbAfter.prepare(`PRAGMA table_info(vip_grants)`).all() as Array<{ name: string }>).map((c) => c.name)
    assert(vipGrantsCols.includes('bundle_purchase_id'), 'vip_grants.bundle_purchase_id трябва да съществува')

    const bundleFk = (dbAfter.prepare(`PRAGMA foreign_key_list(vip_grants)`).all() as Array<{ from: string; table: string; on_delete: string }>)
      .find((fk) => fk.from === 'bundle_purchase_id')
    assert(bundleFk !== undefined && bundleFk.table === 'bundle_purchase_ledger' && bundleFk.on_delete === 'SET NULL', 'bundle_purchase_id FK трябва да сочи towards bundle_purchase_ledger ON DELETE SET NULL')

    const vipPurchaseFk = (dbAfter.prepare(`PRAGMA foreign_key_list(vip_grants)`).all() as Array<{ from: string; table: string }>)
      .find((fk) => fk.from === 'purchase_id')
    assert(vipPurchaseFk !== undefined && vipPurchaseFk.table === 'vip_purchase_ledger', 'purchase_id FK трябва да остане ИЗКЛЮЧИТЕЛНО към vip_purchase_ledger')

    const indexNames = (dbAfter.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vip_grants'`).all() as Array<{ name: string }>).map((r) => r.name)
    assert(indexNames.includes('idx_vip_grants_bundle_purchase_id_once'), 'idx_vip_grants_bundle_purchase_id_once трябва да съществува')
    assert(indexNames.includes('idx_vip_grants_purchase_id_once'), 'established idx_vip_grants_purchase_id_once трябва да остане')
  })

  await check('[10] PRAGMA integrity_check = "ok" след пълната верига', () => {
    const rows = dbAfter.prepare(`PRAGMA integrity_check;`).all() as Array<{ integrity_check: string }>
    assertEqual(rows, [{ integrity_check: 'ok' }], 'integrity_check трябва да върне "ok"')
    const fkViolations = dbAfter.prepare(`PRAGMA foreign_key_check;`).all()
    assertEqual(fkViolations.length, 0, 'foreign_key_check трябва да е празен')
  })

  dbAfter.close()

  await check('[8b] Idempotent повторно прилагане на пълната верига', async () => {
    const result = await ensureServerDatabaseReady({ serverRootOverride: fakeServerRoot, databaseFilePathOverride: dbPath })
    assertEqual(result.appliedCount, 0, 'втория run не трябва да приложи нищо ново')
    assert(result.skippedCount > 0, 'трябва да skip-не всички вече приложени миграции')
  })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
