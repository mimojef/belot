/**
 * checkAdminPaymentsVipAggregation.ts
 *
 * Focused regression test за production bug: Admin -> Статистика ->
 * Плащания показваше "0 плащания / 0.00 EUR" за реална, успешно платена VIP
 * покупка. Root cause: coinPurchaseStore.getAdminPaymentStats()/
 * getAdminPaymentListByPeriod()/getAdminPaymentDetail() четяха ИЗКЛЮЧИТЕЛНО
 * coin_purchase_ledger — vip_purchase_ledger никога не участваше в
 * aggregation-а. Fix: vipPurchaseStore.ts получи паралелни admin-payment
 * функции (reuse-ващи СЪЩИЯ buildPeriodWhereClause от sofiaDayBounds.ts),
 * server/src/index.ts ги комбинира с coin резултатите.
 *
 * Store-level checks (in-process, реални createCoinPurchaseStore/
 * createVipPurchaseStore factory функции върху temp SQLite файлове — не
 * hand-rolled симулация):
 *
 * [1] coin + VIP getAdminPaymentStats() резултати се сумират коректно
 *       (count и totalCents поотделно за today/yesterday/last7days/
 *       thisMonth/allTime)
 * [2] Реалният production сценарий: VIP покупка 100 цента (1.00 EUR),
 *       package_id=vip_365, status=paid -> точно +1 payment / +100 cents
 *       в today (при credited_at = "сега")
 * [3] pending/canceled/failed VIP покупки НЕ допринасят към никой период
 *       (count=0, totalCents=0 за тях)
 * [4] credited_at (не created_at) е settlement timestamp-ът, използван за
 *       period filtering — VIP покупка, създадена "вчера" но credited_at
 *       "днес", пада в today, НЕ в yesterday
 * [5] Europe/Sofia period boundaries идентични на established coin
 *       поведение (reuse на СЪЩИЯ buildPeriodWhereClause, не нова
 *       timezone логика) — потвърдено чрез directна сравнение на
 *       getSofiaDayBoundsUtc резултата, приложен към двата store-а
 * [6] getAdminPaymentListByPeriod (VIP): нормализиран AdminPaymentListRow с
 *       source='vip', packageTitle="VIP 365 дни" (explicit VIP label, НЕ
 *       coin package), yellowCoinsAmount=null, packageKey=null
 * [7] getAdminPaymentDetail (VIP): source='vip', явно различим от coin
 *       (yellowCoinsAmount=null, stripePaymentIntentId=null - VIP няма тия
 *       полета), currentYellowCoinsBalance=null
 * [8] Detail lookup fallback стратегия: coin store връща null за VIP
 *       purchase_id, VIP store го намира (проверено directно, не разчита
 *       на prefix convention)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createCoinPurchaseStore } from '../src/db/coinPurchaseStore.js'
import { createVipPurchaseStore } from '../src/db/vipPurchaseStore.js'
import { createBundlePurchaseStore } from '../src/db/bundlePurchaseStore.js'
import { getSofiaDayBoundsUtc } from '../src/db/sofiaDayBounds.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

async function retryRmDir(path: string): Promise<void> {
  // Windows WAL-mode SQLite handles can hold auxiliary -wal/-shm files
  // briefly after close() — retry-with-delay avoids a spurious EBUSY on
  // cleanup (established pattern, виж checkAdminPayments.ts retryRmDir).
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>((r) => setTimeout(r, 200))
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-admin-payments-vip-agg-'))
  try {
    await fn(dir)
  } finally {
    await retryRmDir(dir)
  }
}

// Минималната schema, нужна и за двата store-а (mirror на
// checkVipPurchaseStore.ts/checkAdminPayments.ts established pattern).
function buildSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT NULL,
      profile_kind TEXT NOT NULL DEFAULT 'human',
      username TEXT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      is_temporary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS profile_bans (
      ban_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      banned_until TEXT NOT NULL,
      lifted_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

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
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT 'x',
      role TEXT NOT NULL DEFAULT 'player',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS coin_packages (
      package_id TEXT PRIMARY KEY,
      package_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      yellow_coins_amount INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS coin_purchase_ledger (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NULL,
      deleted_profile_id_snapshot TEXT NULL,
      package_id TEXT,
      package_key_snapshot TEXT NOT NULL,
      title_snapshot TEXT NOT NULL,
      yellow_coins_amount INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'stripe',
      provider_checkout_session_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      credited_at TEXT,
      hidden_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      stripe_payment_intent_id TEXT,
      stripe_charge_id TEXT,
      payment_method_type TEXT,
      wallet_type TEXT,
      card_brand TEXT,
      card_last4 TEXT,
      card_country TEXT,
      recipient_profile_id TEXT NULL,
      recipient_display_name_snapshot TEXT NULL,
      deleted_recipient_profile_id_snapshot TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_wallets (
      profile_id TEXT PRIMARY KEY,
      yellow_coins_balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vip_status (
      profile_id TEXT PRIMARY KEY,
      active_until TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vip_purchase_ledger (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NULL,
      deleted_profile_id_snapshot TEXT NULL,
      package_id TEXT NOT NULL CHECK (package_id IN ('vip_30', 'vip_180', 'vip_365')),
      days_snapshot INTEGER NOT NULL CHECK (days_snapshot > 0),
      price_cents_snapshot INTEGER NOT NULL CHECK (price_cents_snapshot >= 0),
      currency TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'stripe',
      provider_checkout_session_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled', 'failed')),
      credited_at TEXT,
      vip_grant_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      stripe_payment_intent_id TEXT,
      stripe_charge_id TEXT,
      payment_method_type TEXT,
      wallet_type TEXT,
      card_brand TEXT,
      card_last4 TEXT,
      card_country TEXT,
      recipient_profile_id TEXT NULL,
      recipient_display_name_snapshot TEXT NULL,
      deleted_recipient_profile_id_snapshot TEXT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_purchase_ledger_pending_package
      ON vip_purchase_ledger(profile_id, package_id, status)
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS vip_grants (
      grant_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('launch_gift', 'purchase', 'admin_grant')),
      interval_unit TEXT NOT NULL CHECK (interval_unit IN ('days', 'months', 'years')),
      interval_amount INTEGER NOT NULL CHECK (interval_amount > 0),
      granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      granted_by_profile_id TEXT NULL REFERENCES profiles(profile_id) ON DELETE SET NULL,
      resulting_active_until TEXT NULL,
      purchase_id TEXT NULL REFERENCES vip_purchase_ledger(purchase_id) ON DELETE SET NULL,
      bundle_purchase_id TEXT NULL,
      amount_paid_cents INTEGER NULL,
      currency TEXT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
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
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      recipient_profile_id TEXT NULL,
      recipient_display_name_snapshot TEXT NULL,
      deleted_recipient_profile_id_snapshot TEXT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
      FOREIGN KEY (package_id) REFERENCES shop_bundle_packages(package_id) ON DELETE SET NULL,
      FOREIGN KEY (vip_grant_id) REFERENCES vip_grants(grant_id) ON DELETE SET NULL,
      FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_purchase_ledger_pending_package
      ON bundle_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
      WHERE status = 'pending' AND hidden_at IS NULL;
  `)
}

function insertVipPurchaseDirect(
  db: DatabaseSync,
  opts: {
    purchaseId?: string
    profileId: string
    packageId: 'vip_30' | 'vip_180' | 'vip_365'
    priceCentsSnapshot: number
    daysSnapshot: number
    status: 'pending' | 'paid' | 'canceled' | 'failed'
    createdAt: string
    creditedAt: string | null
    currency?: string
    recipientProfileId?: string | null
    recipientDisplayNameSnapshot?: string | null
  },
): string {
  const id = opts.purchaseId ?? randomUUID()
  db.prepare(`
    INSERT INTO vip_purchase_ledger (
      purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot,
      currency, provider, status, created_at, updated_at, credited_at,
      recipient_profile_id, recipient_display_name_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?, 'stripe', ?, ?, ?, ?, ?, ?);
  `).run(
    id, opts.profileId, opts.packageId, opts.daysSnapshot, opts.priceCentsSnapshot,
    opts.currency ?? 'EUR', opts.status, opts.createdAt, opts.createdAt, opts.creditedAt,
    opts.recipientProfileId ?? null, opts.recipientDisplayNameSnapshot ?? null,
  )
  return id
}

function insertCoinPurchaseDirect(
  db: DatabaseSync,
  opts: {
    purchaseId?: string
    profileId: string
    priceCents: number
    status: string
    createdAt: string
    creditedAt: string | null
    recipientProfileId?: string | null
    recipientDisplayNameSnapshot?: string | null
  },
): string {
  const id = opts.purchaseId ?? randomUUID()
  db.prepare(`
    INSERT INTO coin_purchase_ledger (
      purchase_id, profile_id, package_key_snapshot, title_snapshot,
      yellow_coins_amount, price_cents, currency, provider, status,
      credited_at, created_at, updated_at, recipient_profile_id, recipient_display_name_snapshot
    ) VALUES (?, ?, 'starter', 'Starter Pack', 100, ?, 'EUR', 'stripe', ?, ?, ?, ?, ?, ?);
  `).run(
    id, opts.profileId, opts.priceCents, opts.status, opts.creditedAt, opts.createdAt, opts.createdAt,
    opts.recipientProfileId ?? null, opts.recipientDisplayNameSnapshot ?? null,
  )
  return id
}

function insertBundlePurchaseDirect(
  db: DatabaseSync,
  opts: {
    purchaseId?: string
    profileId: string | null
    packageKeySnapshot: string
    titleSnapshot: string
    yellowCoinsAmount: number
    vipDaysSnapshot: number
    priceCents: number
    status: string
    createdAt: string
    creditedAt: string | null
    currency?: string
    recipientProfileId?: string | null
    recipientDisplayNameSnapshot?: string | null
  },
): string {
  const id = opts.purchaseId ?? randomUUID()
  db.prepare(`
    INSERT INTO bundle_purchase_ledger (
      purchase_id, profile_id, package_key_snapshot, title_snapshot,
      yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider, status,
      credited_at, created_at, updated_at, recipient_profile_id, recipient_display_name_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stripe', ?, ?, ?, ?, ?, ?);
  `).run(
    id, opts.profileId, opts.packageKeySnapshot, opts.titleSnapshot,
    opts.yellowCoinsAmount, opts.vipDaysSnapshot, opts.priceCents, opts.currency ?? 'EUR',
    opts.status, opts.creditedAt, opts.createdAt, opts.createdAt,
    opts.recipientProfileId ?? null, opts.recipientDisplayNameSnapshot ?? null,
  )
  return id
}

function nowSqliteUtc(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'admin-payments-vip-agg.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run('profile-1', 'Player One')

  const coinStore = await createCoinPurchaseStore(dbPath)
  const vipStore = await createVipPurchaseStore(dbPath)

  const now = new Date()
  const nowSqlite = nowSqliteUtc()

  await check('[2] Production сценарий: VIP покупка 100 цента (1.00 EUR), vip_365, status=paid -> +1 payment / +100 cents в today', () => {
    insertVipPurchaseDirect(db, {
      purchaseId: 'purchase-prod-1eur',
      profileId: 'profile-1',
      packageId: 'vip_365',
      priceCentsSnapshot: 100,
      daysSnapshot: 365,
      status: 'paid',
      createdAt: nowSqlite,
      creditedAt: nowSqlite,
    })

    const vipStats = vipStore.getAdminPaymentStats(now)
    assertEqual(vipStats.today.count, 1, 'VIP today count трябва да е 1')
    assertEqual(vipStats.today.totalCents, 100, 'VIP today totalCents трябва да е 100 (1.00 EUR)')
  })

  await check('[1] Combined coin+VIP getAdminPaymentStats() сумира count/totalCents поотделно за всеки период', () => {
    insertCoinPurchaseDirect(db, {
      purchaseId: 'purchase-coin-today',
      profileId: 'profile-1',
      priceCents: 499,
      status: 'paid',
      createdAt: nowSqlite,
      creditedAt: nowSqlite,
    })

    const coinStats = coinStore.getAdminPaymentStats(now)
    const vipStats = vipStore.getAdminPaymentStats(now)

    // Mirror на combineAdminPaymentStats() в server/src/index.ts.
    const combinedToday = {
      count: coinStats.today.count + vipStats.today.count,
      totalCents: coinStats.today.totalCents + vipStats.today.totalCents,
    }

    assertEqual(coinStats.today.count, 1, 'sanity: coin today count=1')
    assertEqual(vipStats.today.count, 1, 'sanity: VIP today count=1 (от [2])')
    assertEqual(combinedToday.count, 2, 'combined today count трябва да е 2 (1 coin + 1 VIP)')
    assertEqual(combinedToday.totalCents, 599, 'combined today totalCents трябва да е 599 (499 coin + 100 VIP)')
  })

  await check('[3] pending/canceled/failed VIP покупки НЕ допринасят към никой период', () => {
    insertVipPurchaseDirect(db, {
      purchaseId: 'purchase-vip-pending',
      profileId: 'profile-1',
      packageId: 'vip_30',
      priceCentsSnapshot: 789,
      daysSnapshot: 30,
      status: 'pending',
      createdAt: nowSqlite,
      creditedAt: null,
    })
    insertVipPurchaseDirect(db, {
      purchaseId: 'purchase-vip-canceled',
      profileId: 'profile-1',
      packageId: 'vip_30',
      priceCentsSnapshot: 789,
      daysSnapshot: 30,
      status: 'canceled',
      createdAt: nowSqlite,
      creditedAt: null,
    })
    insertVipPurchaseDirect(db, {
      purchaseId: 'purchase-vip-failed',
      profileId: 'profile-1',
      packageId: 'vip_30',
      priceCentsSnapshot: 789,
      daysSnapshot: 30,
      status: 'failed',
      createdAt: nowSqlite,
      creditedAt: null,
    })

    const vipStatsBefore = vipStore.getAdminPaymentStats(now)
    // Все още само paid реда от [2] допринася — трите нови (pending/canceled/failed) не.
    assertEqual(vipStatsBefore.today.count, 1, 'pending/canceled/failed не трябва да увеличат count-а')
    assertEqual(vipStatsBefore.allTime.count, 1, 'pending/canceled/failed не трябва да участват в allTime')

    const listRows = vipStore.getAdminPaymentListByPeriod({ period: 'allTime', now })
    assert(listRows.every(r => r.status === 'paid'), 'списъкът трябва да съдържа САМО paid редове')
    assertEqual(listRows.length, 1, 'само 1 paid VIP ред трябва да присъства в списъка')
  })

  await check('[4] credited_at (не created_at) е settlement timestamp за period filtering — VIP покупка "създадена вчера, платена днес" пада в today', () => {
    const yesterday = new Date(now.getTime() - 26 * 60 * 60 * 1000)
    const yesterdaySqlite = yesterday.toISOString().replace('T', ' ').slice(0, 19)

    insertVipPurchaseDirect(db, {
      purchaseId: 'purchase-vip-created-yesterday-paid-today',
      profileId: 'profile-1',
      packageId: 'vip_180',
      priceCentsSnapshot: 3_989,
      daysSnapshot: 180,
      status: 'paid',
      createdAt: yesterdaySqlite,
      creditedAt: nowSqlite,
    })

    const vipStats = vipStore.getAdminPaymentStats(now)
    // Преди тоя check имахме 1 paid VIP ред (100 цента) в today — сега трябва да станат 2.
    assertEqual(vipStats.today.count, 2, 'редът трябва да е в today (по credited_at), не в yesterday')
    assertEqual(vipStats.today.totalCents, 100 + 3_989, 'today total трябва да включва и двата paid VIP реда')
  })

  await check('[5] Europe/Sofia period boundaries идентични на established coin поведение (reuse на СЪЩИЯ buildPeriodWhereClause)', () => {
    const bounds = getSofiaDayBoundsUtc(now)
    // Директна проверка: VIP ред с credited_at ТОЧНО на todayStart границата
    // (inclusive) трябва да участва в today; ред точно ПРЕДИ tomorrowStart
    // границата (exclusive) НЕ трябва.
    insertVipPurchaseDirect(db, {
      purchaseId: 'purchase-vip-exact-today-start',
      profileId: 'profile-1',
      packageId: 'vip_30',
      priceCentsSnapshot: 50,
      daysSnapshot: 30,
      status: 'paid',
      createdAt: bounds.todayStart,
      creditedAt: bounds.todayStart,
    })
    insertVipPurchaseDirect(db, {
      purchaseId: 'purchase-vip-exact-yesterday-start',
      profileId: 'profile-1',
      packageId: 'vip_30',
      priceCentsSnapshot: 60,
      daysSnapshot: 30,
      status: 'paid',
      createdAt: bounds.yesterdayStart,
      creditedAt: bounds.yesterdayStart,
    })

    const todayRows = vipStore.getAdminPaymentListByPeriod({ period: 'today', now })
    const yesterdayRows = vipStore.getAdminPaymentListByPeriod({ period: 'yesterday', now })

    assert(todayRows.some(r => r.purchaseId === 'purchase-vip-exact-today-start'), 'ред с credited_at=todayStart трябва да е в today (inclusive lower bound)')
    assert(!todayRows.some(r => r.purchaseId === 'purchase-vip-exact-yesterday-start'), 'ред с credited_at=yesterdayStart НЕ трябва да е в today')
    assert(yesterdayRows.some(r => r.purchaseId === 'purchase-vip-exact-yesterday-start'), 'ред с credited_at=yesterdayStart трябва да е в yesterday')
  })

  await check('[6] getAdminPaymentListByPeriod (VIP): source="vip", packageTitle="VIP 365 дни" (explicit label), yellowCoinsAmount=null, packageKey=null', () => {
    const rows = vipStore.getAdminPaymentListByPeriod({ period: 'today', now })
    const row = rows.find(r => r.purchaseId === 'purchase-prod-1eur')
    assert(row !== undefined, 'production ред (1.00 EUR VIP 365) трябва да присъства')
    assertEqual(row?.source, 'vip', 'source трябва да е "vip"')
    assertEqual(row?.packageTitle, 'VIP 365 дни', 'packageTitle трябва да е explicit VIP label, не coin package name')
    assertEqual(row?.yellowCoinsAmount, null, 'VIP ред НЕ трябва да измисля yellowCoinsAmount')
    assertEqual(row?.packageKey, null, 'VIP ред няма coin packageKey концепция')
    assertEqual(row?.priceCents, 100, 'priceCents трябва да идва от price_cents_snapshot')
    assertEqual(row?.currency, 'EUR', 'currency трябва да е EUR')
  })

  await check('[7] getAdminPaymentDetail (VIP): source="vip", ясно различим от coin (yellowCoinsAmount/stripePaymentIntentId/currentYellowCoinsBalance = null)', () => {
    const detail = vipStore.getAdminPaymentDetail('purchase-prod-1eur')
    assert(detail !== null, 'detail трябва да се намери')
    assertEqual(detail?.source, 'vip', 'source трябва да е "vip"')
    assertEqual(detail?.packageTitle, 'VIP 365 дни', 'packageTitle explicit VIP label')
    assertEqual(detail?.yellowCoinsAmount, null, 'VIP detail няма yellowCoinsAmount')
    assertEqual(detail?.stripePaymentIntentId, null, 'VIP detail няма payment-method snapshot полета (различна domain схема)')
    assertEqual(detail?.currentYellowCoinsBalance, null, 'VIP detail няма wallet balance концепция')
    assertEqual(detail?.priceCents, 100, 'priceCents = price_cents_snapshot = 100 (1.00 EUR production сценарий)')
  })

  await check('[8] Detail lookup fallback: coin store връща null за VIP purchase_id, VIP store го намира directно (не prefix convention)', () => {
    const coinLookup = coinStore.getAdminPaymentDetail('purchase-prod-1eur')
    assertEqual(coinLookup, null, 'coin store не трябва да намери VIP purchase_id-то (различна таблица)')

    const vipLookup = vipStore.getAdminPaymentDetail('purchase-prod-1eur')
    assert(vipLookup !== null, 'VIP store трябва директно да намери реда по purchase_id')

    // Mirror на fallback стратегията в server/src/index.ts:
    // coinPurchaseStore.getAdminPaymentDetail(id) ?? vipPurchaseStore.getAdminPaymentDetail(id)
    const combined = coinStore.getAdminPaymentDetail('purchase-prod-1eur') ?? vipStore.getAdminPaymentDetail('purchase-prod-1eur')
    assert(combined !== null && combined.source === 'vip', 'fallback стратегията трябва да резолвне VIP реда')
  })

  await check('[9] needsPaymentMethodSnapshot=true преди enrichment, updatePaymentMethodSnapshot записва реалните полета', () => {
    assert(vipStore.needsPaymentMethodSnapshot('purchase-prod-1eur'), 'преди enrichment трябва да е needed (stripe_payment_intent_id/payment_method_type все още NULL)')

    vipStore.updatePaymentMethodSnapshot('purchase-prod-1eur', {
      stripePaymentIntentId: 'pi_test_vip_1eur',
      stripeChargeId: 'ch_test_vip_1eur',
      paymentMethodType: 'card',
      walletType: null,
      cardBrand: 'mastercard',
      cardLast4: '7575',
      cardCountry: 'BG',
    })

    const detail = vipStore.getAdminPaymentDetail('purchase-prod-1eur')
    assert(detail !== null, 'detail трябва да съществува')
    assertEqual(detail?.paymentMethodType, 'card', 'paymentMethodType трябва да е "card"')
    assertEqual(detail?.cardBrand, 'mastercard', 'cardBrand трябва да е "mastercard"')
    assertEqual(detail?.cardLast4, '7575', 'cardLast4 трябва да е "7575"')
    assertEqual(detail?.cardCountry, 'BG', 'cardCountry трябва да е "BG"')
    assertEqual(detail?.stripePaymentIntentId, 'pi_test_vip_1eur', 'stripePaymentIntentId трябва да е записан')
    assertEqual(detail?.stripeChargeId, 'ch_test_vip_1eur', 'stripeChargeId трябва да е записан')

    assert(!vipStore.needsPaymentMethodSnapshot('purchase-prod-1eur'), 'след enrichment вече не трябва да е needed')
  })

  await check('[10] updatePaymentMethodSnapshot е idempotent/non-destructive (COALESCE) — повторно извикване с различни стойности НЕ презаписва вече наличните', () => {
    // Симулира duplicate webhook delivery — Stripe може да достави
    // checkout.session.completed повече от веднъж. Второто извикване с
    // РАЗЛИЧНИ (грешни/различни) стойности НЕ трябва да презапише вече
    // записания snapshot от check [9].
    vipStore.updatePaymentMethodSnapshot('purchase-prod-1eur', {
      stripePaymentIntentId: 'pi_DIFFERENT_SHOULD_NOT_OVERWRITE',
      stripeChargeId: 'ch_DIFFERENT_SHOULD_NOT_OVERWRITE',
      paymentMethodType: 'wallet',
      walletType: 'google_pay',
      cardBrand: 'visa',
      cardLast4: '0000',
      cardCountry: 'US',
    })

    const detail = vipStore.getAdminPaymentDetail('purchase-prod-1eur')
    assertEqual(detail?.cardBrand, 'mastercard', 'cardBrand трябва да остане "mastercard" от check [9] (COALESCE non-destructive)')
    assertEqual(detail?.cardLast4, '7575', 'cardLast4 трябва да остане "7575"')
    assertEqual(detail?.stripePaymentIntentId, 'pi_test_vip_1eur', 'stripePaymentIntentId трябва да остане непроменен')
    assertEqual(detail?.paymentMethodType, 'card', 'paymentMethodType трябва да остане "card"')
  })

  await check('[11] getAdminPaymentListByPeriod (VIP) surfaces enriched snapshot полетата (не hardcoded null вече)', () => {
    const rows = vipStore.getAdminPaymentListByPeriod({ period: 'today', now })
    const row = rows.find(r => r.purchaseId === 'purchase-prod-1eur')
    assert(row !== undefined, 'production ред трябва да присъства')
    assertEqual(row?.paymentMethodType, 'card', 'list row трябва да отразява enriched paymentMethodType')
    assertEqual(row?.cardBrand, 'mastercard', 'list row трябва да отразява enriched cardBrand')
    assertEqual(row?.cardLast4, '7575', 'list row трябва да отразява enriched cardLast4')
  })

  await check('[12] Различна покупка (никога enriched) остава с null snapshot полета — enrichment на един ред не изтича към друг', () => {
    const otherPending = insertVipPurchaseDirect(db, {
      purchaseId: 'purchase-never-enriched',
      profileId: 'profile-1',
      packageId: 'vip_30',
      priceCentsSnapshot: 789,
      daysSnapshot: 30,
      status: 'paid',
      createdAt: nowSqlite,
      creditedAt: nowSqlite,
    })
    assert(vipStore.needsPaymentMethodSnapshot(otherPending), 'нов ред трябва да е needed=true (никога enriched)')
    const detail = vipStore.getAdminPaymentDetail(otherPending)
    assertEqual(detail?.cardBrand, null, 'неенriched ред трябва да остане с null card полета')
    assertEqual(detail?.paymentMethodType, null, 'неенriched ред трябва да остане с null paymentMethodType')
  })

  coinStore.close()
  vipStore.close()
  db.close()
})

// ─── [13] Production gap fix: coin + VIP + bundle заедно, combined pagination ──
//
// Production симптом: акаунт закупи bundle пакет "Мини" (4,99 €, coins+VIP)
// — покупката е успешна, но НЕ се появява в Админ -> Информация -> Плащания.
// Root cause: handleAdminPaymentsListRequest() четеше само
// coinPurchaseStore.getAdminPaymentListByPeriod()/
// vipPurchaseStore.getAdminPaymentListByPeriod() — bundlePurchaseStore
// изобщо не участваше. Fix: bundlePurchaseStore получи паралелни
// getAdminPaymentListByPeriod/getAdminPaymentDetail функции (mirror на VIP
// store-а), server/src/index.ts ги merge-ва с coin+VIP резултатите.
//
// Този regression потвърждава: coin purchase + VIP purchase + bundle "Мини"
// purchase, всички paid в един и същи ден -> list count=3, bundle е точно
// ЕДИН row (не дублиран като отделна coin+VIP), сумата включва 4,99 €,
// bundle row-ът има source='bundle' с правилни coins+VIP дни,
// chronological ordering коректен, historical bundle с hard-deleted payer
// (profileId=null) render-ва безопасно.
console.log('\n[13] Production gap fix: coin + VIP + bundle комбинирано (regression за липсващи bundle покупки в Admin Payments)')

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'admin-payments-combined-3-source.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run('payer-combined-1', 'Mimojef')
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run('payer-combined-2', 'Second Payer')

  const coinStore = await createCoinPurchaseStore(dbPath)
  const vipStore = await createVipPurchaseStore(dbPath)
  const bundleStore = await createBundlePurchaseStore(dbPath)

  const nowSqlite = nowSqliteUtc()
  const now = new Date()

  // Трите покупки от production сценария — всички paid днес.
  const coinId = insertCoinPurchaseDirect(db, {
    purchaseId: 'purchase-combined-coin',
    profileId: 'payer-combined-1',
    priceCents: 199,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
  })
  const vipId = insertVipPurchaseDirect(db, {
    purchaseId: 'purchase-combined-vip',
    profileId: 'payer-combined-1',
    packageId: 'vip_30',
    priceCentsSnapshot: 299,
    daysSnapshot: 30,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
  })
  // "Мини" — 4,99 €, точно production сценария (профил Mimojef).
  const bundleId = insertBundlePurchaseDirect(db, {
    purchaseId: 'purchase-combined-bundle-mini',
    profileId: 'payer-combined-1',
    packageKeySnapshot: 'mini',
    titleSnapshot: 'Мини',
    yellowCoinsAmount: 500,
    vipDaysSnapshot: 7,
    priceCents: 499,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
  })

  const coinResult = coinStore.getAdminPaymentListByPeriod({ period: 'today', limit: 50, offset: 0, now })
  const vipRows = vipStore.getAdminPaymentListByPeriod({ period: 'today', now })
  const bundleRows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })

  await check('[13.1] list count = 3 (coin + VIP + bundle, всички отделни redове)', () => {
    const total = coinResult.total + vipRows.length + bundleRows.length
    assertEqual(total, 3, `очаквано 3, получено ${total}`)
  })

  await check('[13.2] bundle е точно ЕДИН row (не дублиран като coin+VIP)', () => {
    assertEqual(bundleRows.length, 1, `bundle rows: получено ${bundleRows.length}`)
    assertEqual(bundleRows[0]?.purchaseId, bundleId, 'bundle row purchaseId не съвпада')
  })

  await check('[13.3] сумата включва 4,99 € (bundle price_cents=499)', () => {
    assertEqual(bundleRows[0]?.priceCents, 499, 'bundle priceCents трябва да е 499')
    assertEqual(bundleRows[0]?.currency, 'EUR', 'bundle currency трябва да е EUR')
  })

  await check('[13.4] bundle row има source="bundle"', () => {
    assertEqual(bundleRows[0]?.source, 'bundle', 'bundle row source трябва да е "bundle"')
  })

  await check('[13.5] bundle row: coins И VIP дни едновременно правилни (500 🟡 + 7 дни VIP)', () => {
    assertEqual(bundleRows[0]?.yellowCoinsAmount, 500, 'bundle yellowCoinsAmount трябва да е 500')
    assertEqual(bundleRows[0]?.vipDays, 7, 'bundle vipDays трябва да е 7')
  })

  await check('[13.6] bundle НЕ измисля coin-specific packageKey — точен snapshot "mini"', () => {
    assertEqual(bundleRows[0]?.packageKey, 'mini', 'bundle packageKey трябва да е snapshot стойността')
    assertEqual(bundleRows[0]?.packageTitle, 'Мини', 'bundle packageTitle трябва да е "Мини"')
  })

  await check('[13.7] coin row остава source="coin" с vipDays=null (не примесен с bundle)', () => {
    const coinRow = coinResult.rows.find((r) => r.purchaseId === coinId)
    assert(coinRow !== undefined, 'coin row трябва да съществува')
    assertEqual(coinRow?.source, 'coin', 'coin row source трябва да е "coin"')
    assertEqual(coinRow?.vipDays, null, 'coin row vipDays трябва да е null (coin няма VIP компонент)')
  })

  await check('[13.8] VIP row остава source="vip" с yellowCoinsAmount=null (не примесен с bundle)', () => {
    const vipRow = vipRows.find((r) => r.purchaseId === vipId)
    assert(vipRow !== undefined, 'VIP row трябва да съществува')
    assertEqual(vipRow?.source, 'vip', 'VIP row source трябва да е "vip"')
    assertEqual(vipRow?.yellowCoinsAmount, null, 'VIP row yellowCoinsAmount трябва да е null (VIP няма coins)')
  })

  await check('[13.9] combined chronological sort (creditedAt DESC) работи коректно през трите sources', () => {
    const combined = [...coinResult.rows, ...vipRows, ...bundleRows].sort((a, b) => {
      const aTime = a.creditedAt ? Date.parse(a.creditedAt) : 0
      const bTime = b.creditedAt ? Date.parse(b.creditedAt) : 0
      if (bTime !== aTime) return bTime - aTime
      return b.purchaseId.localeCompare(a.purchaseId)
    })
    assertEqual(combined.length, 3, 'combined трябва да съдържа 3 redа')
    // Всички имат идентичен creditedAt (nowSqlite) — tie-break по purchaseId DESC.
    const expectedOrder = [coinId, vipId, bundleId].sort().reverse()
    const actualOrder = combined.map((r) => r.purchaseId)
    assert(
      JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
      `combined ordering не съвпада с очакваното tie-break: got ${JSON.stringify(actualOrder)}, expected ${JSON.stringify(expectedOrder)}`,
    )
  })

  await check('[13.10] mixed pagination: limit=2 offset=0, после offset=2 покрива всички 3 redа без дублиране/пропуск', () => {
    const combined = [...coinResult.rows, ...vipRows, ...bundleRows].sort((a, b) => {
      const aTime = a.creditedAt ? Date.parse(a.creditedAt) : 0
      const bTime = b.creditedAt ? Date.parse(b.creditedAt) : 0
      if (bTime !== aTime) return bTime - aTime
      return b.purchaseId.localeCompare(a.purchaseId)
    })
    const page1 = combined.slice(0, 2)
    const page2 = combined.slice(2, 4)
    assertEqual(page1.length, 2, 'page1 трябва да съдържа 2 redа')
    assertEqual(page2.length, 1, 'page2 трябва да съдържа 1 ред')
    const allIds = [...page1, ...page2].map((r) => r.purchaseId).sort()
    const expectedIds = [coinId, vipId, bundleId].sort()
    assert(
      JSON.stringify(allIds) === JSON.stringify(expectedIds),
      `pagination трябва да покрие точно трите redа, без дублиране/пропуск: got ${JSON.stringify(allIds)}, expected ${JSON.stringify(expectedIds)}`,
    )
  })

  await check('[13.11] bundle detail lookup работи (fallback chain: coin -> vip -> bundle)', () => {
    const coinDetail = coinStore.getAdminPaymentDetail(bundleId)
    assertEqual(coinDetail, null, 'coin store не трябва да намери bundle purchase')
    const vipDetail = vipStore.getAdminPaymentDetail(bundleId)
    assertEqual(vipDetail, null, 'VIP store не трябва да намери bundle purchase')
    const bundleDetail = bundleStore.getAdminPaymentDetail(bundleId)
    assert(bundleDetail !== null, 'bundle store трябва да намери bundle purchase')
    assertEqual(bundleDetail?.source, 'bundle', 'bundle detail source трябва да е "bundle"')
    assertEqual(bundleDetail?.yellowCoinsAmount, 500, 'bundle detail yellowCoinsAmount трябва да е 500')
    assertEqual(bundleDetail?.vipDays, 7, 'bundle detail vipDays трябва да е 7')
  })

  coinStore.close()
  vipStore.close()
  bundleStore.close()
  db.close()
})

// ─── [14] Historical bundle с hard-deleted payer (profileId=null) ───────────
console.log('\n[14] Historical bundle с hard-deleted payer render-ва безопасно (profileId=null)')

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'admin-payments-bundle-deleted-payer.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  const bundleStore = await createBundlePurchaseStore(dbPath)
  const nowSqlite = nowSqliteUtc()
  const now = new Date()

  // profile_id=NULL директно в ledger-а — симулира hard-deleted payer
  // (ON DELETE SET NULL, установена семантика от 20260923_004 migration-а).
  // Няма profiles ред за payer-а изобщо — LEFT JOIN просто не match-ва.
  const historicalBundleId = insertBundlePurchaseDirect(db, {
    purchaseId: 'purchase-bundle-deleted-payer',
    profileId: null,
    packageKeySnapshot: 'mini',
    titleSnapshot: 'Мини',
    yellowCoinsAmount: 500,
    vipDaysSnapshot: 7,
    priceCents: 499,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
  })

  await check('[14.1] getAdminPaymentListByPeriod не хвърля за historical bundle с profileId=null', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    assertEqual(rows.length, 1, 'трябва да намери 1 historical bundle row')
    assertEqual(rows[0]?.profileId, null, 'profileId трябва да е null (hard-deleted payer)')
  })

  await check('[14.2] getAdminPaymentDetail не хвърля за historical bundle с profileId=null', () => {
    const detail = bundleStore.getAdminPaymentDetail(historicalBundleId)
    assert(detail !== null, 'detail трябва да се намери')
    assertEqual(detail?.profileId, null, 'detail profileId трябва да е null')
    assertEqual(detail?.displayName, null, 'displayName трябва да е null (няма profiles ред)')
  })

  bundleStore.close()
  db.close()
})

// ─── [15] Gifted bundle render-ва безопасно — payer/recipient semantics не се смесват ──
// Gift bundle покупка (recipient_profile_id non-NULL) остава payer-центрична
// в admin payments (profileId/displayName/email продължават да сочат PAYER-a,
// НЕ recipient-а) — recipientProfileId/recipientDisplayName са ДОПЪЛНИТЕЛНИ
// полета (Admin Payments recipient visibility feature), не заместват payer
// identity полетата.
console.log('\n[15] Gifted bundle render-ва безопасно (payer/recipient semantics не се смесват)')

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'admin-payments-bundle-gift.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run('gift-payer-1', 'Payer')
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run('gift-recipient-1', 'Recipient')

  const bundleStore = await createBundlePurchaseStore(dbPath)
  const nowSqlite = nowSqliteUtc()
  const now = new Date()

  const giftBundleId = insertBundlePurchaseDirect(db, {
    purchaseId: 'purchase-bundle-gift',
    profileId: 'gift-payer-1',
    packageKeySnapshot: 'mini',
    titleSnapshot: 'Мини',
    yellowCoinsAmount: 500,
    vipDaysSnapshot: 7,
    priceCents: 499,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
    recipientProfileId: 'gift-recipient-1',
    recipientDisplayNameSnapshot: 'Recipient',
  })

  await check('[15.1] gift bundle row в getAdminPaymentListByPeriod не хвърля', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    assertEqual(rows.length, 1, 'трябва да намери 1 gift bundle row')
  })

  await check('[15.2] gift bundle row остава payer-центричен: profileId=PAYER, не recipient', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    assertEqual(rows[0]?.profileId, 'gift-payer-1', 'profileId трябва да е PAYER-а, не recipient-а')
    assertEqual(rows[0]?.displayName, 'Payer', 'displayName трябва да е PAYER display name')
  })

  await check('[15.3] gift bundle row: source остава "bundle", coins+VIP непроменени от gift статуса', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    assertEqual(rows[0]?.source, 'bundle', 'source трябва да остане "bundle"')
    assertEqual(rows[0]?.yellowCoinsAmount, 500, 'yellowCoinsAmount непроменен от gift статуса')
    assertEqual(rows[0]?.vipDays, 7, 'vipDays непроменен от gift статуса')
  })

  await check('[15.4] gift bundle detail lookup не хвърля, остава payer-центричен', () => {
    const detail = bundleStore.getAdminPaymentDetail(giftBundleId)
    assert(detail !== null, 'detail трябва да се намери')
    assertEqual(detail?.profileId, 'gift-payer-1', 'detail profileId трябва да е PAYER-а')
    assertEqual(detail?.source, 'bundle', 'detail source трябва да е "bundle"')
  })

  await check('[15.5] gift bundle row: recipientProfileId/recipientDisplayName попълнени в list', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    assertEqual(rows[0]?.recipientProfileId, 'gift-recipient-1', 'recipientProfileId трябва да сочи recipient-a')
    assertEqual(rows[0]?.recipientDisplayName, 'Recipient', 'recipientDisplayName трябва да е snapshot името')
  })

  await check('[15.6] gift bundle detail: recipientProfileId/recipientDisplayName попълнени', () => {
    const detail = bundleStore.getAdminPaymentDetail(giftBundleId)
    assertEqual(detail?.recipientProfileId, 'gift-recipient-1', 'detail recipientProfileId трябва да сочи recipient-a')
    assertEqual(detail?.recipientDisplayName, 'Recipient', 'detail recipientDisplayName трябва да е snapshot името')
  })

  bundleStore.close()
  db.close()
})

// ─── [16] Admin Payments recipient visibility — coin/vip/bundle × normal/gift/hard-delete ──
// Regression за новата Admin Payments функционалност: gift покупки (payer/
// recipient semantics от Paid Gift Shop) трябва да показват "Подарък за X"
// в списъка/детайла, докато normal покупки нямат никакъв recipient marker.
// recipientDisplayName (immutable snapshot, НЕ FK) е единственият canonical
// "е ли gift" discriminator — оцелява recipient hard-delete непроменен.
console.log('\n[16] Admin Payments recipient visibility — coin/VIP/bundle × normal/gift/hard-delete')

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'admin-payments-recipient-visibility.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run('rv-payer-1', 'RV Payer')
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run('rv-recipient-1', 'METEOPA')

  const coinStore = await createCoinPurchaseStore(dbPath)
  const vipStore = await createVipPurchaseStore(dbPath)
  const bundleStore = await createBundlePurchaseStore(dbPath)
  const nowSqlite = nowSqliteUtc()
  const now = new Date()

  // [1]/[2] normal coin -> няма recipient marker; gifted coin -> "Подарък за X"
  const normalCoinId = insertCoinPurchaseDirect(db, {
    purchaseId: 'purchase-rv-coin-normal',
    profileId: 'rv-payer-1',
    priceCents: 499,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
  })
  const giftCoinId = insertCoinPurchaseDirect(db, {
    purchaseId: 'purchase-rv-coin-gift',
    profileId: 'rv-payer-1',
    priceCents: 499,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
    recipientProfileId: 'rv-recipient-1',
    recipientDisplayNameSnapshot: 'METEOPA',
  })

  await check('[16.1] normal coin: recipientProfileId/recipientDisplayName = null (list)', () => {
    const rows = coinStore.getAdminPaymentListByPeriod({ period: 'today', limit: 50, offset: 0, now }).rows
    const row = rows.find((r) => r.purchaseId === normalCoinId)
    assert(row !== undefined, 'normal coin row трябва да съществува')
    assertEqual(row?.recipientProfileId, null, 'normal coin recipientProfileId трябва да е null')
    assertEqual(row?.recipientDisplayName, null, 'normal coin recipientDisplayName трябва да е null')
  })

  await check('[16.2] gifted coin: recipientDisplayName="METEOPA" (list)', () => {
    const rows = coinStore.getAdminPaymentListByPeriod({ period: 'today', limit: 50, offset: 0, now }).rows
    const row = rows.find((r) => r.purchaseId === giftCoinId)
    assert(row !== undefined, 'gift coin row трябва да съществува')
    assertEqual(row?.recipientProfileId, 'rv-recipient-1', 'gift coin recipientProfileId трябва да сочи recipient-a')
    assertEqual(row?.recipientDisplayName, 'METEOPA', 'gift coin recipientDisplayName трябва да е "METEOPA"')
  })

  await check('[16.2b] gifted coin detail: recipientDisplayName="METEOPA"', () => {
    const detail = coinStore.getAdminPaymentDetail(giftCoinId)
    assert(detail !== null, 'gift coin detail трябва да се намери')
    assertEqual(detail?.recipientProfileId, 'rv-recipient-1', 'detail recipientProfileId трябва да сочи recipient-a')
    assertEqual(detail?.recipientDisplayName, 'METEOPA', 'detail recipientDisplayName трябва да е "METEOPA"')
  })

  // [3]/[4] normal VIP -> няма recipient marker; gifted VIP -> "Подарък за X"
  const normalVipId = insertVipPurchaseDirect(db, {
    purchaseId: 'purchase-rv-vip-normal',
    profileId: 'rv-payer-1',
    packageId: 'vip_30',
    priceCentsSnapshot: 799,
    daysSnapshot: 30,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
  })
  const giftVipId = insertVipPurchaseDirect(db, {
    purchaseId: 'purchase-rv-vip-gift',
    profileId: 'rv-payer-1',
    packageId: 'vip_30',
    priceCentsSnapshot: 799,
    daysSnapshot: 30,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
    recipientProfileId: 'rv-recipient-1',
    recipientDisplayNameSnapshot: 'METEOPA',
  })

  await check('[16.3] normal VIP: recipientProfileId/recipientDisplayName = null (list)', () => {
    const rows = vipStore.getAdminPaymentListByPeriod({ period: 'today', now })
    const row = rows.find((r) => r.purchaseId === normalVipId)
    assert(row !== undefined, 'normal VIP row трябва да съществува')
    assertEqual(row?.recipientProfileId, null, 'normal VIP recipientProfileId трябва да е null')
    assertEqual(row?.recipientDisplayName, null, 'normal VIP recipientDisplayName трябва да е null')
  })

  await check('[16.4] gifted VIP: recipientDisplayName="METEOPA" (list)', () => {
    const rows = vipStore.getAdminPaymentListByPeriod({ period: 'today', now })
    const row = rows.find((r) => r.purchaseId === giftVipId)
    assert(row !== undefined, 'gift VIP row трябва да съществува')
    assertEqual(row?.recipientProfileId, 'rv-recipient-1', 'gift VIP recipientProfileId трябва да сочи recipient-a')
    assertEqual(row?.recipientDisplayName, 'METEOPA', 'gift VIP recipientDisplayName трябва да е "METEOPA"')
  })

  await check('[16.4b] gifted VIP detail: recipientDisplayName="METEOPA"', () => {
    const detail = vipStore.getAdminPaymentDetail(giftVipId)
    assert(detail !== null, 'gift VIP detail трябва да се намери')
    assertEqual(detail?.recipientProfileId, 'rv-recipient-1', 'detail recipientProfileId трябва да сочи recipient-a')
    assertEqual(detail?.recipientDisplayName, 'METEOPA', 'detail recipientDisplayName трябва да е "METEOPA"')
  })

  // [5]/[6] normal bundle -> няма recipient marker; gifted bundle -> "Подарък за X"
  const normalBundleId = insertBundlePurchaseDirect(db, {
    purchaseId: 'purchase-rv-bundle-normal',
    profileId: 'rv-payer-1',
    packageKeySnapshot: 'mini',
    titleSnapshot: 'Мини',
    yellowCoinsAmount: 200000,
    vipDaysSnapshot: 30,
    priceCents: 499,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
  })
  const giftBundleRvId = insertBundlePurchaseDirect(db, {
    purchaseId: 'purchase-rv-bundle-gift',
    profileId: 'rv-payer-1',
    packageKeySnapshot: 'mini',
    titleSnapshot: 'Мини',
    yellowCoinsAmount: 200000,
    vipDaysSnapshot: 30,
    priceCents: 499,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
    recipientProfileId: 'rv-recipient-1',
    recipientDisplayNameSnapshot: 'METEOPA',
  })

  await check('[16.5] normal bundle: recipientProfileId/recipientDisplayName = null (list)', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    const row = rows.find((r) => r.purchaseId === normalBundleId)
    assert(row !== undefined, 'normal bundle row трябва да съществува')
    assertEqual(row?.recipientProfileId, null, 'normal bundle recipientProfileId трябва да е null')
    assertEqual(row?.recipientDisplayName, null, 'normal bundle recipientDisplayName трябва да е null')
  })

  await check('[16.6] gifted bundle "Мини" 200000 coins + 30 VIP дни: recipientDisplayName="METEOPA" (list)', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    const row = rows.find((r) => r.purchaseId === giftBundleRvId)
    assert(row !== undefined, 'gift bundle row трябва да съществува')
    assertEqual(row?.recipientProfileId, 'rv-recipient-1', 'gift bundle recipientProfileId трябва да сочи recipient-a')
    assertEqual(row?.recipientDisplayName, 'METEOPA', 'gift bundle recipientDisplayName трябва да е "METEOPA"')
    assertEqual(row?.yellowCoinsAmount, 200000, 'coins остават 200000, непроменени от gift статуса')
    assertEqual(row?.vipDays, 30, 'VIP дни остават 30, непроменени от gift статуса')
  })

  await check('[16.6b] gifted bundle detail: recipientDisplayName="METEOPA"', () => {
    const detail = bundleStore.getAdminPaymentDetail(giftBundleRvId)
    assert(detail !== null, 'gift bundle detail трябва да се намери')
    assertEqual(detail?.recipientProfileId, 'rv-recipient-1', 'detail recipientProfileId трябва да сочи recipient-a')
    assertEqual(detail?.recipientDisplayName, 'METEOPA', 'detail recipientDisplayName трябва да е "METEOPA"')
  })

  // [7] deleted recipient -> safe fallback, без crash. Реален FK hard-delete
  // (не симулация) — recipient_profile_id -> NULL, recipient_display_name_snapshot
  // (immutable snapshot, не FK) ОЦЕЛЯВА непроменен.
  db.exec('PRAGMA foreign_keys = ON;')
  db.prepare(`DELETE FROM profiles WHERE profile_id = 'rv-recipient-1'`).run()

  await check('[16.7] deleted recipient: coin/VIP/bundle list не хвърлят след hard-delete', () => {
    assert(
      coinStore.getAdminPaymentListByPeriod({ period: 'today', limit: 50, offset: 0, now }).rows.length >= 0,
      'coin list не трябва да хвърля',
    )
    assert(vipStore.getAdminPaymentListByPeriod({ period: 'today', now }).length >= 0, 'VIP list не трябва да хвърля')
    assert(bundleStore.getAdminPaymentListByPeriod({ period: 'today', now }).length >= 0, 'bundle list не трябва да хвърля')
  })

  // ВАЖНО (established schema asymmetry, потвърдено чрез source audit):
  // coin_purchase_ledger/vip_purchase_ledger.recipient_profile_id НЯМАТ FK
  // constraint изобщо (само 20260923_002 ALTER TABLE ADD COLUMN, никога
  // table-rebuild-нати с FK) — за разлика от bundle_purchase_ledger, която
  // ИМА real FK ON DELETE SET NULL (20260923_004 table rebuild). Значи
  // recipient_profile_id за coin/VIP НЕ се нулира от SQLite при recipient
  // hard-delete (orphaned reference, остава непроменена стойност) — само
  // recipient_display_name_snapshot (snapshot, никога FK, за трите
  // таблици еднакво) е надежден "е ли gift" UI discriminator. Admin
  // Payments UI никога не JOIN-ва към profiles през recipientProfileId за
  // display на името — винаги ползва snapshot-a, значи тази asymmetry не
  // чупи recipient visibility функционалността, само "Recipient Profile
  // ID" copy полето в detail панела би показало stale ID за coin/VIP (не
  // null) при hard-deleted recipient — приемливо forensic behavior, не bug.
  await check('[16.8] deleted recipient (coin, БЕЗ FK constraint): recipient_profile_id остава orphaned, recipient_display_name_snapshot ОЦЕЛЯВА', () => {
    const rows = coinStore.getAdminPaymentListByPeriod({ period: 'today', limit: 50, offset: 0, now }).rows
    const row = rows.find((r) => r.purchaseId === giftCoinId)
    assert(row !== undefined, 'gift coin row трябва да продължи да съществува след recipient hard-delete')
    assertEqual(row?.recipientProfileId, 'rv-recipient-1', 'recipientProfileId остава orphaned (без FK, SQLite не я пипа)')
    assertEqual(row?.recipientDisplayName, 'METEOPA', 'recipientDisplayName (snapshot) трябва да ОЦЕЛЕЕ непроменен')
  })

  await check('[16.9] deleted recipient (VIP, БЕЗ FK constraint): historical gift остава разпознаваем като gift', () => {
    const rows = vipStore.getAdminPaymentListByPeriod({ period: 'today', now })
    const row = rows.find((r) => r.purchaseId === giftVipId)
    assert(row !== undefined, 'gift VIP row трябва да продължи да съществува')
    assertEqual(row?.recipientProfileId, 'rv-recipient-1', 'recipientProfileId остава orphaned (без FK, SQLite не я пипа)')
    assertEqual(row?.recipientDisplayName, 'METEOPA', 'recipientDisplayName (snapshot) трябва да ОЦЕЛЕЕ непроменен')
  })

  await check('[16.10] deleted recipient: historical gift остава разпознаваем като gift (bundle) + detail не хвърля', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    const row = rows.find((r) => r.purchaseId === giftBundleRvId)
    assert(row !== undefined, 'gift bundle row трябва да продължи да съществува')
    assertEqual(row?.recipientProfileId, null, 'recipientProfileId трябва да е NULL след recipient hard-delete')
    assertEqual(row?.recipientDisplayName, 'METEOPA', 'recipientDisplayName (snapshot) трябва да ОЦЕЛЕЕ непроменен')

    const detail = bundleStore.getAdminPaymentDetail(giftBundleRvId)
    assert(detail !== null, 'detail не трябва да хвърля след recipient hard-delete')
    assertEqual(detail?.recipientProfileId, null, 'detail recipientProfileId трябва да е NULL')
    assertEqual(detail?.recipientDisplayName, 'METEOPA', 'detail recipientDisplayName трябва да ОЦЕЛЕЕ')
  })

  // [10] pagination/count/total не се променят от recipient visibility fix-а
  await check('[16.11] pagination/count/total непроменени: coin list total включва И normal, И gift redовете', () => {
    const result = coinStore.getAdminPaymentListByPeriod({ period: 'today', limit: 50, offset: 0, now })
    assertEqual(result.total, 2, 'coin total трябва да е 2 (normal + gift), recipient visibility не филтрира/дублира')
  })

  coinStore.close()
  vipStore.close()
  bundleStore.close()
  db.close()
})

// ─── [17] deleted payer + gift recipient -> safe render (§5 hard-delete safety) ──
// Payer hard-deleted МЕЖДУ checkout и admin view — payer-центричните полета
// (profileId/displayName) стават NULL (established, виж profileId=null
// regression fix-а от предишна сесия), но recipient полетата (gift marker)
// продължават да работят независимо — двете hard-delete пътеки са ортогонални.
console.log('\n[17] Deleted payer + gift recipient — safe render (двете hard-delete пътеки независими)')

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'admin-payments-deleted-payer-gift.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  const bundleStore = await createBundlePurchaseStore(dbPath)
  const nowSqlite = nowSqliteUtc()
  const now = new Date()

  // profile_id=NULL директно (симулира payer вече hard-deleted преди тоя
  // read) + recipient_display_name_snapshot непразен (gift marker), без
  // profiles ред за payer-а изобщо — LEFT JOIN просто не match-ва.
  const giftDeletedPayerId = insertBundlePurchaseDirect(db, {
    purchaseId: 'purchase-deleted-payer-gift',
    profileId: null,
    packageKeySnapshot: 'mini',
    titleSnapshot: 'Мини',
    yellowCoinsAmount: 200000,
    vipDaysSnapshot: 30,
    priceCents: 499,
    status: 'paid',
    createdAt: nowSqlite,
    creditedAt: nowSqlite,
    recipientProfileId: null, // recipient също вече hard-deleted
    recipientDisplayNameSnapshot: 'METEOPA',
  })

  await check('[17.1] deleted payer + gift: list не хвърля', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    assertEqual(rows.length, 1, 'трябва да намери 1 row')
  })

  await check('[17.2] deleted payer + gift: profileId=null (payer), recipientDisplayName оцелява (gift marker)', () => {
    const rows = bundleStore.getAdminPaymentListByPeriod({ period: 'today', now })
    assertEqual(rows[0]?.profileId, null, 'profileId трябва да е null (payer hard-deleted)')
    assertEqual(rows[0]?.recipientProfileId, null, 'recipientProfileId трябва да е null (recipient hard-deleted)')
    assertEqual(rows[0]?.recipientDisplayName, 'METEOPA', 'recipientDisplayName snapshot трябва да оцелее независимо от payer статуса')
  })

  await check('[17.3] deleted payer + gift: detail не хвърля, безопасен render', () => {
    const detail = bundleStore.getAdminPaymentDetail(giftDeletedPayerId)
    assert(detail !== null, 'detail трябва да се намери')
    assertEqual(detail?.profileId, null, 'detail profileId трябва да е null')
    assertEqual(detail?.recipientDisplayName, 'METEOPA', 'detail recipientDisplayName трябва да оцелее')
  })

  bundleStore.close()
  db.close()
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
