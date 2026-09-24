/**
 * checkBundlePackageVisualKeyStore.ts
 *
 * Shop -> "Пакети" Premium Visual System — store-level regression за
 * shopBundlePackageStore.ts visual_key contract-а (audit §14). HTTP-level
 * coverage (create/edit/reject/public+admin response shape) вече е в
 * checkShopBundleCheckoutHttpFlow.ts ([3b]-[3d]) — тук фокусът е върху
 * неща, които се тестват по-директно/изолирано на store ниво:
 *   - legacy ред (visual_key=NULL от директен SQL insert, mirror на "преди
 *     тази фича" редове), не преминал изобщо през upsertPackage()
 *   - package ordering остава unaffected от visual_key (sort_order semantics)
 *   - bundle purchase/fulfillment business fields остават unaffected от
 *     visual_key (presentation-only field, нулев допир до purchase flow)
 *
 * [1]  Legacy ред (visual_key=NULL, директен SQL insert) -> store го чете
 *        обратно като visualKey:null, без грешка
 * [2]  known visualKey create (upsertPackage) -> snapshot.visualKey точен
 * [3]  known visualKey edit -> персистира, override-ва предишна стойност
 * [4]  unknown visualKey reject -> ok:false, ясно съобщение, redът НЕ се
 *        записва/променя
 * [5]  listPublicPackages() носи visualKey
 * [6]  listAdminPackages() носи visualKey
 * [11] Bundle purchase/fulfillment (wallet credit + VIP grant) остава
 *        напълно непроменен независимо дали пакетът има visualKey или не
 * [12] Package ordering (sort_order ASC, yellow_coins_amount ASC) остава
 *        unaffected от visual_key стойностите
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createShopBundlePackageStore } from '../src/db/shopBundlePackageStore.js'
import { createBundlePurchaseStore } from '../src/db/bundlePurchaseStore.js'

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

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-bundle-visual-key-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

function buildSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT NULL,
      profile_kind TEXT NOT NULL DEFAULT 'human' CHECK (profile_kind IN ('human', 'bot')),
      username TEXT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      is_temporary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS profile_bans (
      ban_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      banned_until TEXT NOT NULL,
      reason TEXT NOT NULL,
      lifted_at TEXT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS profile_wallets (
      profile_id TEXT PRIMARY KEY,
      yellow_coins_balance INTEGER NOT NULL DEFAULT 0 CHECK (yellow_coins_balance >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS vip_status (
      profile_id TEXT PRIMARY KEY,
      active_until TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS vip_grants (
      grant_id TEXT PRIMARY KEY,
      profile_id TEXT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('launch_gift', 'purchase', 'admin_grant')),
      interval_unit TEXT NOT NULL CHECK (interval_unit IN ('days', 'months', 'years')),
      interval_amount INTEGER NOT NULL CHECK (interval_amount > 0),
      granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      granted_by_profile_id TEXT NULL REFERENCES profiles(profile_id) ON DELETE SET NULL,
      resulting_active_until TEXT NULL,
      purchase_id TEXT NULL,
      amount_paid_cents INTEGER NULL,
      currency TEXT NULL,
      bundle_purchase_id TEXT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_purchase_id_once
      ON vip_grants(purchase_id)
      WHERE reason = 'purchase' AND purchase_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_bundle_purchase_id_once
      ON vip_grants(bundle_purchase_id)
      WHERE reason = 'purchase' AND bundle_purchase_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS shop_bundle_packages (
      package_id TEXT PRIMARY KEY,
      package_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      yellow_coins_amount INTEGER NOT NULL CHECK (yellow_coins_amount > 0),
      vip_days INTEGER NOT NULL CHECK (vip_days > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      visual_key TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS bundle_purchase_ledger (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NULL,
      deleted_profile_id_snapshot TEXT NULL,
      package_id TEXT,
      package_key_snapshot TEXT NOT NULL,
      title_snapshot TEXT NOT NULL,
      yellow_coins_amount INTEGER NOT NULL CHECK (yellow_coins_amount > 0),
      vip_days_snapshot INTEGER NOT NULL CHECK (vip_days_snapshot > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'stripe',
      provider_checkout_session_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled', 'failed')),
      credited_at TEXT,
      vip_grant_id TEXT,
      stripe_payment_intent_id TEXT,
      stripe_charge_id TEXT,
      payment_method_type TEXT,
      wallet_type TEXT,
      card_brand TEXT,
      card_last4 TEXT,
      card_country TEXT,
      hidden_at TEXT,
      recipient_profile_id TEXT NULL REFERENCES profiles(profile_id) ON DELETE SET NULL,
      recipient_display_name_snapshot TEXT NULL,
      deleted_recipient_profile_id_snapshot TEXT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
      FOREIGN KEY (package_id) REFERENCES shop_bundle_packages(package_id) ON DELETE SET NULL,
      FOREIGN KEY (vip_grant_id) REFERENCES vip_grants(grant_id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_purchase_ledger_pending_package
      ON bundle_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS paid_gift_notification_log (
      purchase_id TEXT NOT NULL,
      purchase_type TEXT NOT NULL CHECK (purchase_type IN ('coin', 'vip', 'bundle')),
      recipient_profile_id TEXT NOT NULL,
      sender_display_name_snapshot TEXT NOT NULL,
      body_text TEXT NOT NULL,
      read_at TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (purchase_id, purchase_type)
    );
  `)
}

console.log('\ncheckBundlePackageVisualKeyStore\n')

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'belot-v2.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  buildSchema(db)
  db.close()

  const store = await createShopBundlePackageStore(dbPath)

  // ─── [1] Legacy ред (visual_key=NULL, директен SQL insert) ────────────────

  await check('[1] Legacy ред (visual_key=NULL, директен SQL insert) -> store чете visualKey:null, без грешка', () => {
    const raw = new DatabaseSync(dbPath, { open: true })
    raw.prepare(`
      INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status, sort_order)
      VALUES ('legacy-pkg-1', 'legacy_key_1', 'Legacy Package', 100000, 10, 299, 'EUR', 'active', 5)
    `).run()
    raw.close()

    const pkg = store.getPackageById('legacy-pkg-1')
    assert(pkg !== null, 'legacy пакетът трябва да се прочете')
    assertEqual(pkg!.visualKey, null, 'legacy ред без visual_key трябва да се чете като visualKey:null')
  })

  // ─── [2]-[3] known visualKey create/edit ──────────────────────────────────

  let createdPackageId = ''
  await check('[2] known visualKey create (upsertPackage) -> snapshot.visualKey точен', () => {
    const result = store.upsertPackage({
      packageKey: '',
      title: 'Мини+',
      description: '',
      yellowCoinsAmount: 200000,
      vipDays: 20,
      priceCents: 699,
      currency: 'EUR',
      status: 'active',
      sortOrder: 8,
      visualKey: 'gold-bag',
    })
    assert(result.ok, `create трябва да успее: ${!result.ok ? result.message : ''}`)
    if (!result.ok) return
    createdPackageId = result.package.packageId
    assertEqual(result.package.visualKey, 'gold-bag', 'visualKey')
  })

  await check('[3] known visualKey edit -> персистира, override-ва предишна стойност', () => {
    const result = store.upsertPackage({
      packageId: createdPackageId,
      packageKey: '',
      title: 'Мини+',
      description: '',
      yellowCoinsAmount: 200000,
      vipDays: 20,
      priceCents: 699,
      currency: 'EUR',
      status: 'active',
      sortOrder: 8,
      visualKey: 'black-diamond',
    })
    assert(result.ok, `edit трябва да успее: ${!result.ok ? result.message : ''}`)
    if (!result.ok) return
    assertEqual(result.package.visualKey, 'black-diamond', 'visualKey трябва да е override-нат')

    const reread = store.getPackageById(createdPackageId)
    assertEqual(reread?.visualKey, 'black-diamond', 'повторно четене трябва да види новата стойност')
  })

  // ─── [4] unknown visualKey reject ──────────────────────────────────────────

  await check('[4] unknown visualKey reject -> ok:false, редът НЕ се променя', () => {
    const before = store.getPackageById(createdPackageId)

    const result = store.upsertPackage({
      packageId: createdPackageId,
      packageKey: '',
      title: 'Мини+',
      description: '',
      yellowCoinsAmount: 200000,
      vipDays: 20,
      priceCents: 699,
      currency: 'EUR',
      status: 'active',
      sortOrder: 8,
      visualKey: 'not-a-real-visual-key',
    })
    assertEqual(result.ok, false, 'непознат visualKey трябва да е reject-нат')

    const after = store.getPackageById(createdPackageId)
    assertEqual(after?.visualKey, before?.visualKey, 'редът НЕ трябва да се промени при reject-нат upsert')
  })

  // ─── [5]-[6] Public/admin response носят visualKey ────────────────────────

  await check('[5] listPublicPackages() носи visualKey', () => {
    const list = store.listPublicPackages()
    const row = list.find((p) => p.packageId === createdPackageId)
    assert(row !== undefined, 'пакетът трябва да е в public listing-а (status=active)')
    assertEqual(row?.visualKey, 'black-diamond', 'public response трябва да носи visualKey')
  })

  await check('[6] listAdminPackages() носи visualKey', () => {
    const list = store.listAdminPackages()
    const row = list.find((p) => p.packageId === createdPackageId)
    assert(row !== undefined, 'пакетът трябва да е в admin listing-а')
    assertEqual(row?.visualKey, 'black-diamond', 'admin response трябва да носи visualKey')
  })

  // ─── [12] Package ordering остава unaffected от visual_key ────────────────

  await check('[12] Package ordering (sort_order ASC, yellow_coins_amount ASC) остава unaffected от visual_key', () => {
    // Package-и с visual_key в РАЗЛИЧЕН ред от sort_order-а им — ordering-ът
    // трябва да следва ИЗКЛЮЧИТЕЛНО established sort_order/coins semantics.
    store.upsertPackage({
      packageKey: '', title: 'Order A', description: '', yellowCoinsAmount: 300000, vipDays: 5,
      priceCents: 199, currency: 'EUR', status: 'active', sortOrder: 100, visualKey: 'crown',
    })
    store.upsertPackage({
      packageKey: '', title: 'Order B', description: '', yellowCoinsAmount: 150000, vipDays: 5,
      priceCents: 199, currency: 'EUR', status: 'active', sortOrder: 1, visualKey: 'coins-small',
    })
    store.upsertPackage({
      packageKey: '', title: 'Order C', description: '', yellowCoinsAmount: 50000, vipDays: 5,
      priceCents: 199, currency: 'EUR', status: 'active', sortOrder: 1, visualKey: null,
    })

    const list = store.listPublicPackages()
    const orderTitles = list.filter((p) => p.title.startsWith('Order ')).map((p) => p.title)
    // sort_order ASC first (B, C и двете sortOrder=1, A sortOrder=100) -> В и С
    // ПРЕДИ A; между B/C (равен sort_order) tie-break е yellow_coins_amount ASC.
    assertEqual(orderTitles, ['Order C', 'Order B', 'Order A'], 'ordering следва established sort_order/coins semantics, независимо от visual_key')
  })

  store.close()
})

// ─── [11] Bundle purchase/fulfillment остава unaffected от visual_key ──────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'belot-v2.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  buildSchema(db)

  db.prepare(`INSERT INTO accounts (account_id, email) VALUES ('acc-payer', 'payer@example.test')`).run()
  db.prepare(`
    INSERT INTO profiles (profile_id, account_id, profile_kind, display_name, status, is_temporary)
    VALUES ('payer-visual', 'acc-payer', 'human', 'Payer Visual', 'active', 0)
  `).run()
  db.close()

  const packageStore = await createShopBundlePackageStore(dbPath)
  const createResult = packageStore.upsertPackage({
    packageKey: '', title: 'Visual Bundle', description: '', yellowCoinsAmount: 400000, vipDays: 25,
    priceCents: 899, currency: 'EUR', status: 'active', sortOrder: 1, visualKey: 'vip-emblem',
  })
  if (!createResult.ok) throw new Error('setup failed')
  const packageId = createResult.package.packageId
  packageStore.close()

  const bundleStore = await createBundlePurchaseStore(dbPath)

  await check('[11] Bundle purchase/fulfillment (wallet credit + VIP grant) остава напълно непроменен независимо от package visualKey', () => {
    const pending = bundleStore.createPendingPurchase('payer-visual', packageId)
    assert(pending.ok, 'pending purchase трябва да се създаде')
    if (!pending.ok) return

    bundleStore.attachCheckoutSession(pending.purchase.purchaseId, 'cs_visual_test_1')
    const result = bundleStore.fulfillPaidPurchase({
      checkoutSessionId: 'cs_visual_test_1',
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 899,
    })
    assert(result.ok, `fulfillment трябва да успее: ${!result.ok ? result.message : ''}`)
    if (!result.ok) return

    assertEqual(result.purchase.yellowCoinsAmount, 400000, 'yellowCoinsAmount snapshot непроменен от visualKey')
    assertEqual(result.purchase.vipDays, 25, 'vipDays snapshot непроменен от visualKey')
    assertEqual(result.purchase.priceCents, 899, 'priceCents snapshot непроменен от visualKey')
    assertEqual(result.alreadyCredited, false, 'първи fulfillment не е "already credited"')

    const readDb = new DatabaseSync(dbPath, { open: true, readOnly: true })
    const wallet = readDb.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = 'payer-visual'`).get() as { yellow_coins_balance: number } | undefined
    const vipStatus = readDb.prepare(`SELECT active_until FROM vip_status WHERE profile_id = 'payer-visual'`).get() as { active_until: string } | undefined
    readDb.close()

    assertEqual(wallet?.yellow_coins_balance, 400000, 'wallet трябва да е credit-нат точно с package amount-а')
    assert(vipStatus !== undefined, 'VIP статус трябва да е зададен')
  })

  bundleStore.close()
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
