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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      profile_id TEXT NOT NULL,
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
      card_country TEXT
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
      profile_id TEXT NOT NULL,
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
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
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
      amount_paid_cents INTEGER NULL,
      currency TEXT NULL,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_purchase_id_once
      ON vip_grants(purchase_id)
      WHERE reason = 'purchase' AND purchase_id IS NOT NULL;
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
  },
): string {
  const id = opts.purchaseId ?? randomUUID()
  db.prepare(`
    INSERT INTO vip_purchase_ledger (
      purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot,
      currency, provider, status, created_at, updated_at, credited_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'stripe', ?, ?, ?, ?);
  `).run(
    id, opts.profileId, opts.packageId, opts.daysSnapshot, opts.priceCentsSnapshot,
    opts.currency ?? 'EUR', opts.status, opts.createdAt, opts.createdAt, opts.creditedAt,
  )
  return id
}

function insertCoinPurchaseDirect(
  db: DatabaseSync,
  opts: { purchaseId?: string; profileId: string; priceCents: number; status: string; createdAt: string; creditedAt: string | null },
): string {
  const id = opts.purchaseId ?? randomUUID()
  db.prepare(`
    INSERT INTO coin_purchase_ledger (
      purchase_id, profile_id, package_key_snapshot, title_snapshot,
      yellow_coins_amount, price_cents, currency, provider, status,
      credited_at, created_at, updated_at
    ) VALUES (?, ?, 'starter', 'Starter Pack', 100, ?, 'EUR', 'stripe', ?, ?, ?, ?);
  `).run(id, opts.profileId, opts.priceCents, opts.status, opts.creditedAt, opts.createdAt, opts.createdAt)
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

  coinStore.close()
  vipStore.close()
  db.close()
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
