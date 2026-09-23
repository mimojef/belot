/**
 * checkPaidGiftShopStores.ts
 *
 * "Подари авоари" (Paid Gift Shop) — store-level checks за payer/recipient
 * split логиката в coinPurchaseStore.ts / vipPurchaseStore.ts /
 * bundlePurchaseStore.ts. Mirror на established checkBundlePurchaseStore.ts/
 * checkVipPurchaseStore.ts pattern-а (temp DB, buildSchema mirror на
 * реалните migrations). Покрива тестовете от брифа §39-47, доколкото са
 * store-level (HTTP-layer/UI тестове са в отделни check скриптове).
 *
 * B. Coin gift purchases (§18 пример: 40 000 жълтици за МоНии)
 * [B0] createPendingPurchase с recipientProfileId != payer → pending ред,
 *        recipientProfileId snapshot-нат точно, recipientDisplayNameSnapshot
 *        resolve-нат от текущия profiles.display_name (не от client)
 * [B1] fulfillPaidPurchase на gift покупка → RECIPIENT wallet +yellowCoins,
 *        PAYER wallet НЕ променен (дори payer да няма wallet ред изобщо)
 * [B2] Purchase snapshot (getPurchaseById) все още показва profile_id=payer
 *        (payer семантика непроменена) + recipientProfileId=recipient
 * [B3] listProfilePurchases(payerId) съдържа gift покупката (history на PAYER-а)
 * [B4] listProfilePurchases(recipientId) НЕ съдържа gift покупката (тя принадлежи
 *        на payer-а история-wise, recipient просто получава наградата)
 *
 * C. Self-gift защита (§14)
 * [C0] createPendingPurchase(profileId, packageId, profileId) → ok:false,
 *        никакъв pending ред не се създава
 *
 * D. Recipient eligibility (§13)
 * [D0] recipientProfileId сочещ към bot профил → ok:false
 * [D1] recipientProfileId сочещ към is_temporary=1 профил → ok:false
 * [D2] recipientProfileId сочещ към guest (account_id IS NULL) профил → ok:false
 * [D3] recipientProfileId сочещ към disabled (status!='active') профил → ok:false
 * [D4] recipientProfileId сочещ към active-banned профил → ok:false
 * [D5] recipientProfileId сочещ към несъществуващ профил → ok:false
 * [D6] recipientProfileId сочещ към eligible human профил → ok:true
 * [D7] recipientProfileId сочещ към expired-ban (banned_until в миналото) → ok:true (банът вече не е активен)
 *
 * E. Normal purchase backward compatibility (§21)
 * [E0] createPendingPurchase БЕЗ recipientProfileId → recipientProfileId:null
 *        в snapshot-а (normal purchase непроменена семантика)
 * [E1] fulfillPaidPurchase на normal покупка → PAYER wallet credited (COALESCE
 *        fallback работи правилно)
 * [E2] Pending reuse: same payer + package + (без recipient) → reuse на СЪЩИЯ ред
 * [E3] Pending НЕ се reuse-ва между normal и gift за СЪЩИЯ package (различен
 *        recipient контекст, §14/UNIQUE index fix)
 * [E4] Pending НЕ се reuse-ва между gift-за-X и gift-за-Y за СЪЩИЯ package
 *
 * F. VIP gift purchases (§19 пример: VIP 30 дни за МоНии)
 * [F0] fulfillPaidPurchase на VIP gift → RECIPIENT vip_status extend-нат,
 *        PAYER vip_status НЕ променен
 * [F1] vip_grants редът сочи RECIPIENT-а (profile_id колона = recipient), не payer
 *
 * G. Bundle gift purchases (§20 пример: 500 000 жълтици + 30 дни VIP за МоНии)
 * [G0] fulfillPaidPurchase на bundle gift → RECIPIENT получава И coins И VIP,
 *        PAYER wallet/VIP НЕ променени
 *
 * H. §30 edge case — recipient hard-deleted между checkout и webhook (safe-fail)
 * [H0] Coin: recipient изтрит преди fulfillPaidPurchase → FK violation,
 *        ROLLBACK, ledger редът остава 'pending' (НЕ 'paid', НЕ 'failed'),
 *        PAYER wallet НЕ credited като fallback
 * [H1] VIP: recipient изтрит преди fulfillPaidPurchase → идентично safe-fail
 * [H2] Bundle: recipient изтрит преди fulfillPaidPurchase → идентично safe-fail
 *
 * I. Idempotency за gift покупки (§22-23)
 * [I0] Повторен fulfillPaidPurchase (same checkoutSessionId) на успешна gift
 *        покупка → alreadyCredited:true, RECIPIENT wallet НЕ credited повторно
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
  const dir = await mkdtemp(join(tmpdir(), 'belot-paid-gift-shop-check-'))
  try {
    await fn(dir)
  } finally {
    // Windows понякога държи WAL/SHM side-файловете locked за кратко след
    // db.close() (established issue, mirror на подобни retry-и другаде в
    // проекта) — maxRetries+retryDelay избягва спорадичен EBUSY при cleanup,
    // без да маскира реален тестов fail (тестовите assertions вече са
    // приключили преди този finally блок).
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

// Mirror на реалната текуща схема (след 20260923_002 migration) — включва
// profile_kind/status/account_id/is_temporary (recipient eligibility) и
// profile_bans (active-ban изключване), plus recipient_profile_id колоните
// и разширените "pending package" UNIQUE index-и.
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
      banned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_launch_gift_once
      ON vip_grants(profile_id)
      WHERE reason = 'launch_gift';
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

function seedHumanProfile(
  db: DatabaseSync,
  profileId: string,
  opts: { displayName?: string; profileKind?: 'human' | 'bot'; status?: 'active' | 'disabled'; isTemporary?: boolean; hasAccount?: boolean } = {},
): void {
  const accountId = opts.hasAccount === false ? null : `acc_${profileId}`
  if (accountId !== null) {
    db.prepare(`INSERT OR IGNORE INTO accounts (account_id) VALUES (?)`).run(accountId)
  }
  db.prepare(`
    INSERT INTO profiles (profile_id, account_id, profile_kind, display_name, status, is_temporary)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    profileId,
    accountId,
    opts.profileKind ?? 'human',
    opts.displayName ?? profileId,
    opts.status ?? 'active',
    opts.isTemporary ? 1 : 0,
  )
}

function banProfile(db: DatabaseSync, profileId: string, bannedUntilOffset: 'future' | 'past'): void {
  const bannedUntil = bannedUntilOffset === 'future' ? "datetime('now', '+30 days')" : "datetime('now', '-1 days')"
  db.prepare(`
    INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason)
    VALUES (?, ?, ${bannedUntil}, 'test ban')
  `).run(`ban_${profileId}_${Math.random()}`, profileId)
}

function getWalletBalance(db: DatabaseSync, profileId: string): number {
  const row = db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
    | { yellow_coins_balance: number }
    | undefined
  return row?.yellow_coins_balance ?? 0
}

function getActiveUntil(db: DatabaseSync, profileId: string): string | null {
  const row = db.prepare(`SELECT active_until FROM vip_status WHERE profile_id = ?`).get(profileId) as
    | { active_until: string }
    | undefined
  return row?.active_until ?? null
}

function getPurchaseStatus(db: DatabaseSync, table: string, purchaseId: string): string {
  const row = db.prepare(`SELECT status FROM ${table} WHERE purchase_id = ?`).get(purchaseId) as { status: string }
  return row.status
}

let sessionCounter = 0
function nextSessionId(): string {
  sessionCounter += 1
  return `cs_test_gift_${sessionCounter}`
}

// ─── B/C/D/E — Coin gift purchases ─────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'coin-gift.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  seedHumanProfile(db, 'payer-1', { displayName: 'Milen' })
  seedHumanProfile(db, 'recipient-1', { displayName: 'МоНии' })
  seedHumanProfile(db, 'bot-1', { profileKind: 'bot' })
  seedHumanProfile(db, 'temp-1', { isTemporary: true })
  seedHumanProfile(db, 'guest-1', { hasAccount: false })
  seedHumanProfile(db, 'disabled-1', { status: 'disabled' })
  seedHumanProfile(db, 'banned-1', {})
  banProfile(db, 'banned-1', 'future')
  seedHumanProfile(db, 'expired-ban-1', {})
  banProfile(db, 'expired-ban-1', 'past')

  db.prepare(`
    INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status, sort_order)
    VALUES ('pkg-40k', 'coins_40000', '40 000 жълтици', 40000, 199, 'EUR', 'active', 10)
  `).run()

  const store = await createCoinPurchaseStore(dbPath)

  await check('[C0] Self-gift защита — createPendingPurchase(payer, pkg, payer) → ok:false', () => {
    const result = store.createPendingPurchase('payer-1', 'pkg-40k', 'payer-1')
    assertEqual(result.ok, false, 'self-gift трябва да е отказан')
  })

  await check('[D0] recipientProfileId → bot профил → ok:false', () => {
    const result = store.createPendingPurchase('payer-1', 'pkg-40k', 'bot-1')
    assertEqual(result.ok, false, 'bot не може да получи gift')
  })

  await check('[D1] recipientProfileId → is_temporary профил → ok:false', () => {
    const result = store.createPendingPurchase('payer-1', 'pkg-40k', 'temp-1')
    assertEqual(result.ok, false, 'temporary профил не може да получи gift')
  })

  await check('[D2] recipientProfileId → guest (без account) → ok:false', () => {
    const result = store.createPendingPurchase('payer-1', 'pkg-40k', 'guest-1')
    assertEqual(result.ok, false, 'guest не може да получи gift')
  })

  await check('[D3] recipientProfileId → disabled профил → ok:false', () => {
    const result = store.createPendingPurchase('payer-1', 'pkg-40k', 'disabled-1')
    assertEqual(result.ok, false, 'disabled профил не може да получи gift')
  })

  await check('[D4] recipientProfileId → active-banned профил → ok:false', () => {
    const result = store.createPendingPurchase('payer-1', 'pkg-40k', 'banned-1')
    assertEqual(result.ok, false, 'active-banned профил не може да получи gift')
  })

  await check('[D5] recipientProfileId → несъществуващ профил → ok:false', () => {
    const result = store.createPendingPurchase('payer-1', 'pkg-40k', 'no-such-profile')
    assertEqual(result.ok, false, 'несъществуващ профил не може да получи gift')
  })

  await check('[D7] recipientProfileId → expired-ban профил → ok:true (банът вече не е активен)', () => {
    const result = store.createPendingPurchase('payer-1', 'pkg-40k', 'expired-ban-1')
    assert(result.ok, `expired-ban профил трябва да може да получи gift: ${JSON.stringify(result)}`)
  })

  let giftPurchaseId = ''
  let giftSessionId = ''

  await check('[B0]/[D6] createPendingPurchase(payer, pkg, eligible recipient) → ok:true, snapshot точен', () => {
    const result = store.createPendingPurchase('payer-1', 'pkg-40k', 'recipient-1')
    assert(result.ok, `трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      giftPurchaseId = result.purchase.purchaseId
      assertEqual(result.purchase.recipientProfileId, 'recipient-1', 'recipientProfileId')
      assertEqual(result.purchase.recipientDisplayNameSnapshot, 'МоНии', 'recipientDisplayNameSnapshot')
      assertEqual(result.purchase.yellowCoinsAmount, 40000, 'yellowCoinsAmount snapshot')
    }
  })

  await check('[E3] Normal pending (без recipient) за СЪЩИЯ пакет НЕ reuse-ва gift pending реда', () => {
    const normalResult = store.createPendingPurchase('payer-1', 'pkg-40k')
    assert(normalResult.ok, `normal purchase трябва да успее: ${JSON.stringify(normalResult)}`)
    if (normalResult.ok) {
      assert(normalResult.purchase.purchaseId !== giftPurchaseId, 'normal purchase трябва да е ОТДЕЛЕН ред от gift-а')
      assertEqual(normalResult.purchase.recipientProfileId, null, 'normal purchase recipientProfileId трябва да е null')
      // cleanup: скриваме normal pending реда, за да не пречи на следващите проверки
      store.markPurchaseFailedByCheckoutSessionId('non-existent-session-to-noop')
    }
  })

  await check('[E4] Gift pending за друг recipient (Y) за СЪЩИЯ пакет НЕ reuse-ва gift-за-X реда', () => {
    seedHumanProfile(db, 'recipient-2', { displayName: 'Second' })
    const otherGiftResult = store.createPendingPurchase('payer-1', 'pkg-40k', 'recipient-2')
    assert(otherGiftResult.ok, `gift-за-Y трябва да успее: ${JSON.stringify(otherGiftResult)}`)
    if (otherGiftResult.ok) {
      assert(otherGiftResult.purchase.purchaseId !== giftPurchaseId, 'gift-за-Y трябва да е ОТДЕЛЕН ред от gift-за-X')
    }
  })

  await check('[attach] attachCheckoutSession на gift реда', () => {
    giftSessionId = nextSessionId()
    const attached = store.attachCheckoutSession(giftPurchaseId, giftSessionId)
    assert(attached !== null, 'attach трябва да успее')
  })

  await check('[B1]/[B2] fulfillPaidPurchase на gift → RECIPIENT credited, PAYER wallet непроменен, profile_id остава payer', () => {
    const before = getWalletBalance(db, 'recipient-1')
    assertEqual(getWalletBalance(db, 'payer-1'), 0, 'payer wallet трябва да е 0 преди fulfillment')

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: giftSessionId,
      purchaseId: giftPurchaseId,
      amountPaidCents: 199,
      currency: 'EUR',
    })

    assert(result.ok, `fulfillment трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.purchase.recipientProfileId, 'recipient-1', 'purchase.recipientProfileId')
    }
    assertEqual(getWalletBalance(db, 'recipient-1'), before + 40000, 'recipient трябва да получи 40000 жълтици')
    assertEqual(getWalletBalance(db, 'payer-1'), 0, 'payer wallet НЕ трябва да се промени')
  })

  await check('[B3] listProfilePurchases(payer) съдържа gift покупката', () => {
    const purchases = store.listProfilePurchases('payer-1')
    assert(purchases.some((p) => p.purchaseId === giftPurchaseId), 'payer history трябва да съдържа gift покупката')
  })

  await check('[B4] listProfilePurchases(recipient) НЕ съдържа gift покупката', () => {
    const purchases = store.listProfilePurchases('recipient-1')
    assert(!purchases.some((p) => p.purchaseId === giftPurchaseId), 'recipient history НЕ трябва да съдържа payer-owned reда')
  })

  await check('[I0] Повторен fulfillPaidPurchase (same session) → alreadyCredited:true, без double-credit', () => {
    const before = getWalletBalance(db, 'recipient-1')
    const result = store.fulfillPaidPurchase({
      checkoutSessionId: giftSessionId,
      purchaseId: giftPurchaseId,
      amountPaidCents: 199,
      currency: 'EUR',
    })
    assert(result.ok, 'повторен webhook трябва да е ok')
    if (result.ok) assertEqual(result.alreadyCredited, true, 'трябва да е alreadyCredited')
    assertEqual(getWalletBalance(db, 'recipient-1'), before, 'НЕ трябва да credit-не повторно')
  })

  await check('[E0]/[E1] Normal (non-gift) покупка — createPendingPurchase БЕЗ recipient, fulfillment credit-ва PAYER-a', () => {
    seedHumanProfile(db, 'payer-2', { displayName: 'NormalBuyer' })
    const pending = store.createPendingPurchase('payer-2', 'pkg-40k')
    assert(pending.ok, `normal pending трябва да успее: ${JSON.stringify(pending)}`)
    if (!pending.ok) return
    assertEqual(pending.purchase.recipientProfileId, null, 'normal purchase recipientProfileId трябва да е null')

    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const before = getWalletBalance(db, 'payer-2')
    const fulfillResult = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      amountPaidCents: 199,
      currency: 'EUR',
    })
    assert(fulfillResult.ok, `normal fulfillment трябва да успее: ${JSON.stringify(fulfillResult)}`)
    assertEqual(getWalletBalance(db, 'payer-2'), before + 40000, 'PAYER (не recipient) трябва да получи наградата за normal покупка')
  })

  await check('[E2] Pending reuse: same payer+package (без recipient) → reuse на СЪЩИЯ ред', () => {
    seedHumanProfile(db, 'payer-3', { displayName: 'ReuseTest' })
    const first = store.createPendingPurchase('payer-3', 'pkg-40k')
    const second = store.createPendingPurchase('payer-3', 'pkg-40k')
    assert(first.ok && second.ok, 'двете заявки трябва да успеят')
    if (first.ok && second.ok) {
      assertEqual(second.purchase.purchaseId, first.purchase.purchaseId, 'втората заявка трябва да reuse-не СЪЩИЯ pending ред')
    }
  })

  await check('[H0] §30 edge case — recipient физически изтрит преди fulfillment → safe-fail, ledger остава pending', () => {
    seedHumanProfile(db, 'payer-doomed', { displayName: 'Doomed Payer' })
    seedHumanProfile(db, 'recipient-doomed', { displayName: 'Doomed Recipient' })

    const pending = store.createPendingPurchase('payer-doomed', 'pkg-40k', 'recipient-doomed')
    assert(pending.ok, 'pending gift purchase трябва да се създаде')
    if (!pending.ok) return

    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    // Реален FK-enforced hard delete (§30 в брифа + review finding §1) —
    // БЕЗ PRAGMA foreign_keys=OFF заобикаляне. FK ON DELETE SET NULL върху
    // recipient_profile_id се изпълнява ВЕДНАГА при тази DELETE (синхронен
    // cascade, не lazily) — ledger row-ът вижда recipient_profile_id=NULL
    // при СЛЕДВАЩИЯ read, ПРЕДИ fulfillPaidPurchase изобщо да се извика.
    // Dedicated по-задълбочен regression за точно този сценарий:
    // checkGiftRecipientHardDeleteFallback.ts (пряка инспекция на ledger row
    // преди/след DELETE + трите store-а).
    db.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run('recipient-doomed')

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      amountPaidCents: 199,
      currency: 'EUR',
    })

    assertEqual(result.ok, false, 'fulfillment ТРЯБВА да fail-не safe-fail (не crash, не fallback към payer)')
    assertEqual(getPurchaseStatus(db, 'coin_purchase_ledger', pending.purchase.purchaseId), 'pending', 'ledger редът трябва да остане pending (НЕ paid, НЕ failed)')
    assertEqual(getWalletBalance(db, 'payer-doomed'), 0, 'PAYER НИКОГА не трябва да получи наградата като fallback')
  })

  store.close()
  db.close()
})

// ─── F — VIP gift purchases ─────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'vip-gift.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  seedHumanProfile(db, 'payer-vip', { displayName: 'Milen' })
  seedHumanProfile(db, 'recipient-vip', { displayName: 'МоНии' })
  seedHumanProfile(db, 'recipient-vip-doomed', { displayName: 'Doomed VIP Recipient' })

  const store = await createVipPurchaseStore(dbPath)

  let purchaseId = ''
  let sessionId = ''

  await check('[VIP gift pending] createPendingPurchase(payer, vip_30, recipient) → ok:true', () => {
    const result = store.createPendingPurchase('payer-vip', 'vip_30', 299, 'recipient-vip')
    assert(result.ok, `трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      purchaseId = result.purchase.purchaseId
      assertEqual(result.purchase.recipientProfileId, 'recipient-vip', 'recipientProfileId')
      assertEqual(result.purchase.recipientDisplayNameSnapshot, 'МоНии', 'recipientDisplayNameSnapshot')
    }
  })

  await check('[VIP self-gift] createPendingPurchase(payer, vip_30, payer) → ok:false', () => {
    const result = store.createPendingPurchase('payer-vip', 'vip_30', 299, 'payer-vip')
    assertEqual(result.ok, false, 'self-gift трябва да е отказан')
  })

  await check('[F0]/[F1] fulfillPaidPurchase на VIP gift → RECIPIENT vip_status extend-нат, PAYER непроменен, grant сочи recipient', () => {
    sessionId = nextSessionId()
    store.attachCheckoutSession(purchaseId, sessionId)

    assertEqual(getActiveUntil(db, 'payer-vip'), null, 'payer НЕ трябва да има VIP статус преди/след gift')

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 299,
    })

    assert(result.ok, `fulfillment трябва да успее: ${JSON.stringify(result)}`)
    assert(getActiveUntil(db, 'recipient-vip') !== null, 'recipient трябва да получи VIP статус')
    assertEqual(getActiveUntil(db, 'payer-vip'), null, 'payer VIP статус НЕ трябва да се промени')

    const grantRow = db.prepare(`SELECT profile_id FROM vip_grants WHERE purchase_id = ?`).get(purchaseId) as { profile_id: string } | undefined
    assert(grantRow !== undefined, 'vip_grants ред трябва да съществува')
    if (grantRow) assertEqual(grantRow.profile_id, 'recipient-vip', 'vip_grants.profile_id трябва да сочи RECIPIENT, не payer')
  })

  await check('[H1] §30 edge case (VIP) — recipient физически изтрит преди fulfillment → safe-fail', () => {
    const pending = store.createPendingPurchase('payer-vip', 'vip_180', 999, 'recipient-vip-doomed')
    assert(pending.ok, 'pending gift purchase трябва да се създаде')
    if (!pending.ok) return

    const doomedSessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, doomedSessionId)

    // Реален FK-enforced delete (виж коментара в [H0] по-горе).
    db.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run('recipient-vip-doomed')

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: doomedSessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    })

    assertEqual(result.ok, false, 'fulfillment ТРЯБВА да fail-не safe-fail')
    assertEqual(getPurchaseStatus(db, 'vip_purchase_ledger', pending.purchase.purchaseId), 'pending', 'ledger редът трябва да остане pending')
    assertEqual(getActiveUntil(db, 'payer-vip'), null, 'PAYER НИКОГА не трябва да получи VIP като fallback')
  })

  store.close()
  db.close()
})

// ─── G — Bundle gift purchases ──────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'bundle-gift.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  seedHumanProfile(db, 'payer-bundle', { displayName: 'Milen' })
  seedHumanProfile(db, 'recipient-bundle', { displayName: 'МоНии' })
  seedHumanProfile(db, 'recipient-bundle-doomed', { displayName: 'Doomed Bundle Recipient' })

  db.prepare(`
    INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status, sort_order)
    VALUES ('pkg-bundle-1', 'bundle_500000_30d', '500 000 + 30д VIP', 500000, 30, 1999, 'EUR', 'active', 10)
  `).run()

  const store = await createBundlePurchaseStore(dbPath)

  let purchaseId = ''
  let sessionId = ''

  await check('[Bundle gift pending] createPendingPurchase(payer, pkg, recipient) → ok:true', () => {
    const result = store.createPendingPurchase('payer-bundle', 'pkg-bundle-1', 'recipient-bundle')
    assert(result.ok, `трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      purchaseId = result.purchase.purchaseId
      assertEqual(result.purchase.recipientProfileId, 'recipient-bundle', 'recipientProfileId')
    }
  })

  await check('[G0] fulfillPaidPurchase на bundle gift → RECIPIENT получава coins+VIP атомарно, PAYER непроменен', () => {
    sessionId = nextSessionId()
    store.attachCheckoutSession(purchaseId, sessionId)

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1999,
    })

    assert(result.ok, `fulfillment трябва да успее: ${JSON.stringify(result)}`)
    assertEqual(getWalletBalance(db, 'recipient-bundle'), 500000, 'recipient трябва да получи 500000 жълтици')
    assert(getActiveUntil(db, 'recipient-bundle') !== null, 'recipient трябва да получи VIP')
    assertEqual(getWalletBalance(db, 'payer-bundle'), 0, 'payer wallet НЕ трябва да се промени')
    assertEqual(getActiveUntil(db, 'payer-bundle'), null, 'payer VIP статус НЕ трябва да се промени')
  })

  await check('[H2] §30 edge case (Bundle) — recipient физически изтрит преди fulfillment → safe-fail, atomic rollback (нито coins, нито VIP)', () => {
    const pending = store.createPendingPurchase('payer-bundle', 'pkg-bundle-1', 'recipient-bundle-doomed')
    assert(pending.ok, 'pending gift purchase трябва да се създаде')
    if (!pending.ok) return

    const doomedSessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, doomedSessionId)

    // Реален FK-enforced delete (виж коментара в [H0] по-горе).
    db.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run('recipient-bundle-doomed')

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: doomedSessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1999,
    })

    assertEqual(result.ok, false, 'fulfillment ТРЯБВА да fail-не safe-fail')
    assertEqual(getPurchaseStatus(db, 'bundle_purchase_ledger', pending.purchase.purchaseId), 'pending', 'ledger редът трябва да остане pending')
    assertEqual(getWalletBalance(db, 'payer-bundle'), 0, 'PAYER НИКОГА не трябва да получи coins като fallback')
    assertEqual(getActiveUntil(db, 'payer-bundle'), null, 'PAYER НИКОГА не трябва да получи VIP като fallback')
  })

  store.close()
  db.close()
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
