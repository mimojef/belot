/**
 * checkGiftRecipientHardDeleteFallback.ts
 *
 * КРИТИЧЕН dedicated regression за findings точка 1 от review-a: одит на
 * COALESCE(recipient_profile_id, profile_id) fallback логиката, комбинирана
 * с FK ON DELETE SET NULL на recipient_profile_id. Реален FK enforcement
 * (PRAGMA foreign_keys=ON, БЕЗ заобикаляне) — за разлика от по-ранния [H0]
 * тест в checkPaidGiftShopStores.ts, който симулираше DELETE-а с
 * `PRAGMA foreign_keys=OFF`, избягвайки точно cascade ефекта на SET NULL.
 *
 * Сценарий:
 *  1. Реален payer profile + реален recipient profile.
 *  2. createPendingPurchase(payer, pkg, recipient) → реален GIFT pending ledger ред.
 *  3. attachCheckoutSession (реален checkout session id).
 *  4. Физически: DELETE FROM profiles WHERE profile_id = recipient
 *     (FK ON DELETE SET NULL enforcement ВКЛЮЧЕН — не заобиколен).
 *  5. Инспекция на ledger row СЛЕД DELETE: recipient_profile_id (очаквано
 *     NULL — FK SET NULL се изпълнява веднага при DELETE-а на родителя),
 *     recipient_display_name_snapshot (очаквано ОСТАВА, snapshot колона,
 *     не е FK, не се засяга от SET NULL), profile_id (payer, непроменен).
 *  6. Извикване на РЕАЛНИЯ fulfillPaidPurchase() path (coin/VIP/bundle) СЛЕД
 *     DELETE-а.
 *
 * ЗАДЪЛЖИТЕЛЕН invariant: fulfillment НИКОГА не credit-ва payer-а като
 * fallback, когато ledger row-ът представлява GIFT (доказано чрез
 * recipient_display_name_snapshot != null durable marker), дори ако
 * recipient_profile_id вече е физически NULL заради FK cascade.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createCoinPurchaseStore } from '../src/db/coinPurchaseStore.js'
import { createVipPurchaseStore } from '../src/db/vipPurchaseStore.js'
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
  if (actual !== expected) {
    throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`)
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-gift-hard-delete-check-'))
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

    CREATE TABLE IF NOT EXISTS profile_bans (
      ban_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      banned_until TEXT NOT NULL,
      reason TEXT NOT NULL,
      lifted_at TEXT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    -- "Подари авоари" durable recipient notification (20260923_003
    -- migration, Round 3) — reuse-вана в трите purchase store connections.
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

    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS profile_wallets (
      profile_id TEXT PRIMARY KEY,
      yellow_coins_balance INTEGER NOT NULL DEFAULT 0 CHECK (yellow_coins_balance >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vip_status (
      profile_id TEXT PRIMARY KEY,
      active_until TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vip_grants (
      grant_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
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
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_launch_gift_once
      ON vip_grants(profile_id)
      WHERE reason = 'launch_gift';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_purchase_id_once
      ON vip_grants(purchase_id)
      WHERE reason = 'purchase' AND purchase_id IS NOT NULL;
    -- 20260923_005 pre-deploy blocker fix — purchase_id остава ИЗКЛЮЧИТЕЛНО
    -- за VIP-direct; bundle-generated grants пишат bundle_purchase_id.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_bundle_purchase_id_once
      ON vip_grants(bundle_purchase_id)
      WHERE reason = 'purchase' AND bundle_purchase_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS coin_packages (
      package_id TEXT PRIMARY KEY,
      package_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      yellow_coins_amount INTEGER NOT NULL CHECK (yellow_coins_amount > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS coin_purchase_ledger (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      package_id TEXT,
      package_key_snapshot TEXT NOT NULL,
      title_snapshot TEXT NOT NULL,
      yellow_coins_amount INTEGER NOT NULL CHECK (yellow_coins_amount > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'stripe',
      provider_checkout_session_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled', 'failed')),
      credited_at TEXT,
      hidden_at TEXT,
      stripe_payment_intent_id TEXT,
      stripe_charge_id TEXT,
      payment_method_type TEXT,
      wallet_type TEXT,
      card_brand TEXT,
      card_last4 TEXT,
      card_country TEXT,
      recipient_profile_id TEXT NULL REFERENCES profiles(profile_id) ON DELETE SET NULL,
      recipient_display_name_snapshot TEXT NULL,
      deleted_recipient_profile_id_snapshot TEXT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
      FOREIGN KEY (package_id) REFERENCES coin_packages(package_id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_coin_purchase_ledger_pending_package
      ON coin_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
      WHERE status = 'pending' AND package_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS vip_purchase_ledger (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      days_snapshot INTEGER NOT NULL CHECK (days_snapshot > 0),
      price_cents_snapshot INTEGER NOT NULL CHECK (price_cents_snapshot >= 0),
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
      recipient_profile_id TEXT NULL REFERENCES profiles(profile_id) ON DELETE SET NULL,
      recipient_display_name_snapshot TEXT NULL,
      deleted_recipient_profile_id_snapshot TEXT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_purchase_ledger_pending_package
      ON vip_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
      WHERE status = 'pending';

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
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bundle_purchase_ledger (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
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
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
      FOREIGN KEY (package_id) REFERENCES shop_bundle_packages(package_id) ON DELETE SET NULL,
      FOREIGN KEY (vip_grant_id) REFERENCES vip_grants(grant_id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_purchase_ledger_pending_package
      ON bundle_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
      WHERE status = 'pending';
  `)
}

function seedHumanProfile(db: DatabaseSync, profileId: string, displayName: string): void {
  const accountId = `acc_${profileId}`
  db.prepare(`INSERT OR IGNORE INTO accounts (account_id) VALUES (?)`).run(accountId)
  db.prepare(`
    INSERT INTO profiles (profile_id, account_id, profile_kind, display_name, status, is_temporary)
    VALUES (?, ?, 'human', ?, 'active', 0)
  `).run(profileId, accountId, displayName)
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
  return `cs_test_harddelete_${sessionCounter}`
}

// ─── COIN ────────────────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'coin-harddelete.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  buildSchema(db)

  seedHumanProfile(db, 'payer-coin', 'Milen')
  seedHumanProfile(db, 'recipient-coin', 'МоНии')
  db.prepare(`
    INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status, sort_order)
    VALUES ('pkg-coin', 'coins_40000', '40 000 жълтици', 40000, 199, 'EUR', 'active', 10)
  `).run()

  const store = await createCoinPurchaseStore(dbPath)

  const pending = store.createPendingPurchase('payer-coin', 'pkg-coin', 'recipient-coin')
  assert(pending.ok, 'gift pending purchase трябва да се създаде')
  if (!pending.ok) throw new Error('setup failed')

  const purchaseId = pending.purchase.purchaseId
  const sessionId = nextSessionId()
  store.attachCheckoutSession(purchaseId, sessionId)

  await check('[COIN setup] recipient_profile_id/display_name snapshot записани точно ПРЕДИ DELETE', () => {
    const row = db.prepare(`
      SELECT recipient_profile_id, recipient_display_name_snapshot, deleted_recipient_profile_id_snapshot, profile_id
      FROM coin_purchase_ledger WHERE purchase_id = ?
    `).get(purchaseId) as {
      recipient_profile_id: string | null
      recipient_display_name_snapshot: string | null
      deleted_recipient_profile_id_snapshot: string | null
      profile_id: string
    }
    assertEqual(row.recipient_profile_id, 'recipient-coin', 'recipient_profile_id преди delete')
    assertEqual(row.recipient_display_name_snapshot, 'МоНии', 'recipient_display_name_snapshot преди delete')
    assertEqual(row.deleted_recipient_profile_id_snapshot, null, 'deleted_recipient_profile_id_snapshot преди delete')
    assertEqual(row.profile_id, 'payer-coin', 'profile_id (payer) преди delete')
  })

  // Реален FK-enforced hard delete — БЕЗ PRAGMA foreign_keys=OFF заобикаляне.
  // FK ON DELETE SET NULL на coin_purchase_ledger.recipient_profile_id се
  // изпълнява ВЕДНАГА при тази DELETE, не lazily при следващ read.
  db.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run('recipient-coin')

  let rowAfterDelete!: {
    recipient_profile_id: string | null
    recipient_display_name_snapshot: string | null
    deleted_recipient_profile_id_snapshot: string | null
    profile_id: string
  }

  await check('[COIN] СЛЕД реален DELETE (FK ON DELETE SET NULL enforced): recipient_profile_id е NULL, display_name_snapshot ОСТАВА', () => {
    rowAfterDelete = db.prepare(`
      SELECT recipient_profile_id, recipient_display_name_snapshot, deleted_recipient_profile_id_snapshot, profile_id
      FROM coin_purchase_ledger WHERE purchase_id = ?
    `).get(purchaseId) as typeof rowAfterDelete
    assertEqual(rowAfterDelete.recipient_profile_id, null, 'recipient_profile_id ТРЯБВА да е NULL след FK cascade SET NULL')
    assertEqual(rowAfterDelete.recipient_display_name_snapshot, 'МоНии', 'display_name_snapshot ТРЯБВА да оцелее (не е FK, чист snapshot текст)')
    assertEqual(rowAfterDelete.profile_id, 'payer-coin', 'profile_id (payer) непроменен от recipient delete-а')
  })

  const payerBalanceBeforeFulfillment = getWalletBalance(db, 'payer-coin')

  await check('[COIN CRITICAL] fulfillPaidPurchase СЛЕД hard-delete на recipient → payer НЕ credited като fallback', () => {
    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId,
      amountPaidCents: 199,
      currency: 'EUR',
    })

    const payerBalanceAfter = getWalletBalance(db, 'payer-coin')

    if (result.ok) {
      // Ако имплементацията върне ok:true, ЕДИНСТВЕНИЯТ приемлив резултат е
      // payer балансът да остане НАПЪЛНО непроменен (т.е. redirect към
      // permanently-pending или explicit reject state, не credit).
      assertEqual(payerBalanceAfter, payerBalanceBeforeFulfillment, 'CRITICAL: fulfillment резултат ok:true, НО payer баланс се промени — INVARIANT НАРУШЕН, payer получи gift награда като fallback')
    } else {
      assertEqual(payerBalanceAfter, payerBalanceBeforeFulfillment, 'payer баланс трябва да остане непроменен при safe-fail')
    }
  })

  store.close()
  db.close()
})

// ─── VIP ─────────────────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'vip-harddelete.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  buildSchema(db)

  seedHumanProfile(db, 'payer-vip', 'Milen')
  seedHumanProfile(db, 'recipient-vip', 'МоНии')

  const store = await createVipPurchaseStore(dbPath)

  const pending = store.createPendingPurchase('payer-vip', 'vip_30', 299, 'recipient-vip')
  assert(pending.ok, 'gift pending VIP purchase трябва да се създаде')
  if (!pending.ok) throw new Error('setup failed')

  const purchaseId = pending.purchase.purchaseId
  const sessionId = nextSessionId()
  store.attachCheckoutSession(purchaseId, sessionId)

  db.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run('recipient-vip')

  await check('[VIP] СЛЕД реален DELETE: recipient_profile_id NULL, display_name_snapshot оцелява', () => {
    const row = db.prepare(`
      SELECT recipient_profile_id, recipient_display_name_snapshot FROM vip_purchase_ledger WHERE purchase_id = ?
    `).get(purchaseId) as { recipient_profile_id: string | null; recipient_display_name_snapshot: string | null }
    assertEqual(row.recipient_profile_id, null, 'recipient_profile_id NULL след FK cascade')
    assertEqual(row.recipient_display_name_snapshot, 'МоНии', 'display_name_snapshot оцелява')
  })

  const payerActiveUntilBefore = getActiveUntil(db, 'payer-vip')
  assertEqual(payerActiveUntilBefore, null, 'setup: payer няма VIP преди fulfillment')

  await check('[VIP CRITICAL] fulfillPaidPurchase СЛЕД hard-delete на recipient → payer НЕ получава VIP като fallback', () => {
    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 299,
    })

    const payerActiveUntilAfter = getActiveUntil(db, 'payer-vip')

    assertEqual(payerActiveUntilAfter, null, `CRITICAL: payer VIP статус трябва да остане null (resultOk=${result.ok}) — ако не е null, payer получи gift-a като fallback`)
  })

  store.close()
  db.close()
})

// ─── BUNDLE ──────────────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'bundle-harddelete.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  buildSchema(db)

  seedHumanProfile(db, 'payer-bundle', 'Milen')
  seedHumanProfile(db, 'recipient-bundle', 'МоНии')
  db.prepare(`
    INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status, sort_order)
    VALUES ('pkg-bundle', 'bundle_500000_30d', '500 000 + 30д VIP', 500000, 30, 1999, 'EUR', 'active', 10)
  `).run()

  const store = await createBundlePurchaseStore(dbPath)

  const pending = store.createPendingPurchase('payer-bundle', 'pkg-bundle', 'recipient-bundle')
  assert(pending.ok, 'gift pending bundle purchase трябва да се създаде')
  if (!pending.ok) throw new Error('setup failed')

  const purchaseId = pending.purchase.purchaseId
  const sessionId = nextSessionId()
  store.attachCheckoutSession(purchaseId, sessionId)

  db.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run('recipient-bundle')

  await check('[BUNDLE] СЛЕД реален DELETE: recipient_profile_id NULL, display_name_snapshot оцелява', () => {
    const row = db.prepare(`
      SELECT recipient_profile_id, recipient_display_name_snapshot FROM bundle_purchase_ledger WHERE purchase_id = ?
    `).get(purchaseId) as { recipient_profile_id: string | null; recipient_display_name_snapshot: string | null }
    assertEqual(row.recipient_profile_id, null, 'recipient_profile_id NULL след FK cascade')
    assertEqual(row.recipient_display_name_snapshot, 'МоНии', 'display_name_snapshot оцелява')
  })

  const payerBalanceBefore = getWalletBalance(db, 'payer-bundle')
  const payerActiveUntilBefore = getActiveUntil(db, 'payer-bundle')

  await check('[BUNDLE CRITICAL] fulfillPaidPurchase СЛЕД hard-delete на recipient → payer НЕ получава coins/VIP като fallback', () => {
    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1999,
    })

    const payerBalanceAfter = getWalletBalance(db, 'payer-bundle')
    const payerActiveUntilAfter = getActiveUntil(db, 'payer-bundle')

    assertEqual(payerBalanceAfter, payerBalanceBefore, `CRITICAL: payer wallet balance трябва да остане непроменен (resultOk=${result.ok})`)
    assertEqual(payerActiveUntilAfter, payerActiveUntilBefore, `CRITICAL: payer VIP статус трябва да остане непроменен (resultOk=${result.ok})`)
  })

  store.close()
  db.close()
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
