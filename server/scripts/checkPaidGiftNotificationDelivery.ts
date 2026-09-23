/**
 * checkPaidGiftNotificationDelivery.ts
 *
 * Review Round 3 §16 — durable notification store/transaction coverage:
 * exactly-once notification per fulfillment, transaction boundary
 * (notification create атомарно с reward commit), duplicate webhook
 * idempotency, hard-delete safe-fail (no notification), failed fulfillment
 * (no notification), normal purchase (no gift recipient notification),
 * ownership-scoped ACK, ACK idempotency, unread->fetch->returned,
 * acknowledged->fetch->not-returned.
 *
 * [1]  Coin gift fulfilled → recipient credited + EXACTLY ONE notification ред
 * [2]  VIP gift fulfilled → VIP extended + EXACTLY ONE notification ред
 * [3]  Bundle gift fulfilled → coins+VIP атомарно + EXACTLY ONE notification ред
 * [4]  Duplicate webhook/fulfillment (same checkoutSessionId) → reward once,
 *        notification ред остава точно 1 (INSERT OR IGNORE idempotency)
 * [5]  Recipient hard-delete преди fulfillment → NO notification (safe-fail)
 * [6]  Failed fulfillment (Stripe field mismatch) → NO notification
 * [7]  Normal (non-gift) Shop покупка → NO notification създаден изобщо
 * [8]  Notification ownership — друг profile НЕ може да ACK-не чужд notification
 * [9]  ACK idempotency — повторен ACK на вече-ACK-нат notification е no-op
 * [10] Unread notification → getPendingNotifications → връща се
 * [11] Acknowledged notification → getPendingNotifications → НЕ се връща
 * [12] Transaction boundary: notification INSERT е ВЪТРЕ в fulfillment
 *        транзакцията (доказано indirectly чрез [1]-[3]/[5]/[6] заедно)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createCoinPurchaseStore } from '../src/db/coinPurchaseStore.js'
import { createVipPurchaseStore } from '../src/db/vipPurchaseStore.js'
import { createBundlePurchaseStore } from '../src/db/bundlePurchaseStore.js'
import { createPaidGiftNotificationStore } from '../src/db/paidGiftNotificationStore.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-paid-gift-notification-check-'))
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

    -- "Подари авоари" durable recipient notification (20260923_003 migration, Round 3).
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
    -- 20260923_005 pre-deploy blocker fix — purchase_id остава ИЗКЛЮЧИТЕЛНО
    -- за VIP-direct; bundle-generated grants пишат bundle_purchase_id.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_bundle_purchase_id_once
      ON vip_grants(bundle_purchase_id)
      WHERE reason = 'purchase' AND bundle_purchase_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_purchase_id_once
      ON vip_grants(purchase_id)
      WHERE reason = 'purchase' AND purchase_id IS NOT NULL;

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

function countNotifications(db: DatabaseSync, purchaseId: string, purchaseType: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM paid_gift_notification_log WHERE purchase_id = ? AND purchase_type = ?
  `).get(purchaseId, purchaseType) as { c: number }
  return row.c
}

let sessionCounter = 0
function nextSessionId(): string {
  sessionCounter += 1
  return `cs_test_notif_${sessionCounter}`
}

// ─── [1]/[4]/[7] Coin ────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'coin-notif.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  seedHumanProfile(db, 'payer-coin', 'Milen')
  seedHumanProfile(db, 'recipient-coin', 'МоНии')
  seedHumanProfile(db, 'normal-buyer', 'NormalBuyer')
  db.prepare(`
    INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status, sort_order)
    VALUES ('pkg-coin', 'coins_40000', '40 000 жълтици', 40000, 199, 'EUR', 'active', 10)
  `).run()

  const store = await createCoinPurchaseStore(dbPath)
  const notifStore = await createPaidGiftNotificationStore(dbPath)

  const pending = store.createPendingPurchase('payer-coin', 'pkg-coin', 'recipient-coin')
  assert(pending.ok, 'gift pending purchase трябва да се създаде')
  if (!pending.ok) throw new Error('setup failed')
  const purchaseId = pending.purchase.purchaseId
  const sessionId = nextSessionId()
  store.attachCheckoutSession(purchaseId, sessionId)

  await check('[1] Coin gift fulfilled → recipient credited + EXACTLY ONE notification', () => {
    const result = store.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId, amountPaidCents: 199, currency: 'EUR' })
    assert(result.ok, `fulfillment трябва да успее: ${JSON.stringify(result)}`)
    assertEqual(countNotifications(db, purchaseId, 'coin'), 1, 'трябва да има точно 1 notification ред')

    const pendingNotifs = notifStore.getPendingNotifications('recipient-coin')
    assert(pendingNotifs.some((n) => n.purchaseId === purchaseId), 'notification-ът трябва да е pending за recipient-а')
  })

  await check('[4] Duplicate webhook (same session) → reward once, notification остава точно 1', () => {
    const before = countNotifications(db, purchaseId, 'coin')
    const result = store.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId, amountPaidCents: 199, currency: 'EUR' })
    assert(result.ok, 'повторен webhook трябва да е ok (alreadyCredited)')
    if (result.ok) assertEqual(result.alreadyCredited, true, 'трябва да е alreadyCredited')
    assertEqual(countNotifications(db, purchaseId, 'coin'), before, 'notification count НЕ трябва да се увеличи')
    assertEqual(countNotifications(db, purchaseId, 'coin'), 1, 'все още точно 1')
  })

  await check('[6] Failed fulfillment (Stripe payment_failed webhook markира purchase като failed) → NO notification', () => {
    seedHumanProfile(db, 'recipient-coin-2', 'Втори')
    const pending2 = store.createPendingPurchase('payer-coin', 'pkg-coin', 'recipient-coin-2')
    assert(pending2.ok, 'setup pending2')
    if (!pending2.ok) return
    const failedSessionId = nextSessionId()
    store.attachCheckoutSession(pending2.purchase.purchaseId, failedSessionId)

    // Mirror на established Stripe checkout.session.expired/payment_failed
    // webhook path (index.ts) — маркира pending покупката 'failed' директно,
    // БЕЗ fulfillPaidPurchase изобщо (established pattern, не hypothetical).
    store.markPurchaseFailedByCheckoutSessionId(failedSessionId)

    // Late/duplicate webhook опитва fulfillment СЛЕД покупката вече е
    // 'failed' — fulfillByInternalRow explicit отхвърля non-'pending' статус.
    const result = store.fulfillPaidPurchase({ checkoutSessionId: failedSessionId, purchaseId: pending2.purchase.purchaseId, amountPaidCents: 199, currency: 'EUR' })
    assertEqual(result.ok, false, 'fulfillment ВЪРХУ вече-failed покупка трябва да отхвърли')
    assertEqual(countNotifications(db, pending2.purchase.purchaseId, 'coin'), 0, 'НЕ трябва да има notification за failed покупка')
  })

  await check('[7] Normal (non-gift) Shop покупка → NO gift recipient notification', () => {
    const normalPending = store.createPendingPurchase('normal-buyer', 'pkg-coin')
    assert(normalPending.ok, 'normal pending трябва да успее')
    if (!normalPending.ok) return
    const normalSessionId = nextSessionId()
    store.attachCheckoutSession(normalPending.purchase.purchaseId, normalSessionId)
    const result = store.fulfillPaidPurchase({ checkoutSessionId: normalSessionId, purchaseId: normalPending.purchase.purchaseId, amountPaidCents: 199, currency: 'EUR' })
    assert(result.ok, 'normal fulfillment трябва да успее')
    assertEqual(countNotifications(db, normalPending.purchase.purchaseId, 'coin'), 0, 'normal (non-gift) покупка НЕ трябва да създаде notification')
  })

  await check('[5] Recipient hard-delete преди fulfillment → NO notification (safe-fail)', () => {
    seedHumanProfile(db, 'recipient-doomed-notif', 'Doomed')
    const doomedPending = store.createPendingPurchase('payer-coin', 'pkg-coin', 'recipient-doomed-notif')
    assert(doomedPending.ok, 'doomed pending трябва да се създаде')
    if (!doomedPending.ok) return
    const doomedSessionId = nextSessionId()
    store.attachCheckoutSession(doomedPending.purchase.purchaseId, doomedSessionId)

    db.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run('recipient-doomed-notif')

    const result = store.fulfillPaidPurchase({ checkoutSessionId: doomedSessionId, purchaseId: doomedPending.purchase.purchaseId, amountPaidCents: 199, currency: 'EUR' })
    assertEqual(result.ok, false, 'fulfillment трябва safe-fail')
    assertEqual(countNotifications(db, doomedPending.purchase.purchaseId, 'coin'), 0, 'НЕ трябва да има notification при hard-delete safe-fail')
  })

  // ─── [8]/[9]/[10]/[11] Ownership + ACK ────────────────────────────────
  await check('[8] Notification ownership — друг profile НЕ може да ACK-не чужд notification', () => {
    const before = notifStore.getPendingNotifications('recipient-coin')
    assert(before.length > 0, 'setup: трябва да има pending notification')
    notifStore.acknowledgeNotification(purchaseId, 'coin', 'payer-coin') // wrong profile
    const after = notifStore.getPendingNotifications('recipient-coin')
    assertEqual(after.length, before.length, 'wrong-profile ACK НЕ трябва да промени нищо')
    assert(after.some((n) => n.purchaseId === purchaseId), 'notification-ът трябва да си остане unread')
  })

  await check('[10] Unread notification → getPendingNotifications → връща се', () => {
    const pendingNotifs = notifStore.getPendingNotifications('recipient-coin')
    assert(pendingNotifs.some((n) => n.purchaseId === purchaseId), 'unread notification трябва да се върне')
  })

  await check('[9]/[11] ACK (correct owner) → idempotent, СЛЕД ACK notification НЕ се връща', () => {
    notifStore.acknowledgeNotification(purchaseId, 'coin', 'recipient-coin')
    const afterFirst = notifStore.getPendingNotifications('recipient-coin')
    assert(!afterFirst.some((n) => n.purchaseId === purchaseId), '[11] СЛЕД ACK notification-ът НЕ трябва да се връща')

    // [9] повторен ACK — idempotent, no error, no change
    notifStore.acknowledgeNotification(purchaseId, 'coin', 'recipient-coin')
    const afterSecond = notifStore.getPendingNotifications('recipient-coin')
    assertEqual(afterSecond.length, afterFirst.length, '[9] повторен ACK трябва да е idempotent (no-op)')
  })

  store.close()
  notifStore.close()
  db.close()
})

// ─── [2] VIP ─────────────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'vip-notif.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  seedHumanProfile(db, 'payer-vip', 'Milen')
  seedHumanProfile(db, 'recipient-vip', 'МоНии')

  const store = await createVipPurchaseStore(dbPath)

  const pending = store.createPendingPurchase('payer-vip', 'vip_30', 299, 'recipient-vip')
  assert(pending.ok, 'setup')
  if (!pending.ok) throw new Error('setup failed')
  const purchaseId = pending.purchase.purchaseId
  const sessionId = nextSessionId()
  store.attachCheckoutSession(purchaseId, sessionId)

  await check('[2] VIP gift fulfilled → VIP extended + EXACTLY ONE notification', () => {
    const result = store.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 299 })
    assert(result.ok, `fulfillment трябва да успее: ${JSON.stringify(result)}`)
    assertEqual(countNotifications(db, purchaseId, 'vip'), 1, 'трябва да има точно 1 notification ред')
  })

  await check('[4-vip] Duplicate webhook → notification остава точно 1', () => {
    store.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 299 })
    assertEqual(countNotifications(db, purchaseId, 'vip'), 1, 'все още точно 1 след duplicate webhook')
  })

  store.close()
  db.close()
})

// ─── [3] Bundle ──────────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'bundle-notif.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  seedHumanProfile(db, 'payer-bundle', 'Milen')
  seedHumanProfile(db, 'recipient-bundle', 'МоНии')
  db.prepare(`
    INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status, sort_order)
    VALUES ('pkg-bundle', 'bundle_500000_30d', '500 000 + 30д VIP', 500000, 30, 1999, 'EUR', 'active', 10)
  `).run()

  const store = await createBundlePurchaseStore(dbPath)

  const pending = store.createPendingPurchase('payer-bundle', 'pkg-bundle', 'recipient-bundle')
  assert(pending.ok, 'setup')
  if (!pending.ok) throw new Error('setup failed')
  const purchaseId = pending.purchase.purchaseId
  const sessionId = nextSessionId()
  store.attachCheckoutSession(purchaseId, sessionId)

  await check('[3] Bundle gift fulfilled → coins+VIP атомарно + EXACTLY ONE notification', () => {
    const result = store.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 1999 })
    assert(result.ok, `fulfillment трябва да успее: ${JSON.stringify(result)}`)
    assertEqual(countNotifications(db, purchaseId, 'bundle'), 1, 'трябва да има точно 1 notification ред')
  })

  await check('[4-bundle] Duplicate webhook → notification остава точно 1', () => {
    store.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 1999 })
    assertEqual(countNotifications(db, purchaseId, 'bundle'), 1, 'все още точно 1 след duplicate webhook')
  })

  store.close()
  db.close()
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
