/**
 * checkVipPurchaseStore.ts
 *
 * Checks за vipPurchaseStore: платен VIP checkout ledger, atomic settlement
 * (CAS pending->paid + calendar-interval extend на vip_status), idempotency
 * при повторен webhook, price-snapshot-at-checkout семантика, и Stripe
 * settlement field validation (payment_status/currency/amount срещу local
 * snapshot).
 *
 * [0]  createPendingPurchase за валиден пакет → pending ред, days_snapshot и
 *        price_cents_snapshot точно от подадената цена (НЕ recompute-нати)
 * [1]  createPendingPurchase за невалиден packageId → ok:false
 * [2]  createPendingPurchase повторно за същия профил/пакет докато има
 *        pending ред → връща СЪЩИЯ ред (reuse), не създава дубликат
 * [3]  fulfillPaidPurchase за inactive профил (без vip_status ред) + 30 дни
 *        → active_until ≈ now+30 дни
 * [4]  Settlement математика: активен статус 27 дни в бъдещето + покупка на
 *        30 дни → 57 дни общо (extend, НЕ overwrite active_until=now+30)
 * [5]  fulfillPaidPurchase маркира ledger реда 'paid' и попълва vip_grant_id
 * [6]  Idempotency: ПОВТОРЕН webhook (същия checkoutSessionId) след вече
 *        кредитирана покупка → alreadyCredited=true, active_until СЪЩИЯТ
 *        (57, НЕ 87)
 * [7]  Idempotency: vip_grants съдържа точно ЕДИН grant ред reason='purchase'
 *        за тази покупка (не два от duplicate webhook)
 * [8]  vip_grants ред от платена покупка попълва purchase_id/amount_paid_cents/
 *        currency (audit trail за платена покупка)
 * [9]  Price-snapshot семантика: checkout създаден с цена X (snapshot в
 *        ledger реда) → settlement използва X, дори ledger price_cents_snapshot
 *        да НЕ съвпада с "текущата" цена (симулирана admin промяна)
 * [10] fulfillPaidPurchase за несъществуваща checkout сесия → ok:false
 * [11] fulfillPaidPurchase за canceled purchase → ok:false (не settle-ва)
 * [12] findByCheckoutSessionId/attachCheckoutSession свързват ledger реда с
 *        provider_checkout_session_id коректно
 * [13] markPurchaseCanceledByCheckoutSessionId сменя статус САМО ако е pending
 *        (paid ред остава непокътнат)
 * [14] VIP_PACKAGE_CATALOG дни mapping: vip_30=30, vip_180=180, vip_365=365
 *        (НЕ 90-дневен пакет никъде в каталога)
 * [15] Липсващ checkoutSessionId → ok:false (lookup изисква сесия, не само
 *        purchaseId — предпазва от matching по спуфнат purchaseId)
 * [16] checkoutSessionId сочи към РЕАЛЕН ред, но подаден purchaseId НЕ
 *        съвпада с реда → ok:false (metadata cross-check неуспешен)
 * [17] Stripe payment_status != 'paid' → ok:false, ledger редът остава pending
 * [18] Stripe currency != snapshot currency → ok:false, не се начислява VIP
 * [19] Stripe amount_total != price_cents_snapshot → ok:false, не се
 *        начислява VIP (защита срещу подправена/грешна сума)
 * [20] DB UNIQUE index idx_vip_grants_purchase_id_once — директен опит за
 *        втори INSERT в vip_grants със същия purchase_id/reason='purchase'
 *        хвърля SQLite constraint грешка (defense-in-depth зад CAS-а)
 * [21] Concurrency: два едновременни webhook опита (worker threads) за
 *        СЪЩИЯ checkoutSessionId → точно 1 grant, active_until коректен
 *        (не двойно начислен)
 * [22] Две ОТДЕЛНИ легитимни покупки (различни checkout сесии/purchaseId) →
 *        и двете extend-ват кумулативно (30+180=210), 2 отделни grant реда
 *        (не се третират като duplicate на едно и също събитие)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import {
  createVipPurchaseStore,
  VIP_PACKAGE_CATALOG,
  isVipPackageId,
} from '../src/db/vipPurchaseStore.js'

const __filename = fileURLToPath(import.meta.url)

// ─── Worker thread за concurrency тест ─────────────────────────────────────

type WorkerResult = { ok: boolean; alreadyCredited?: boolean; message?: string; error?: string }

if (!isMainThread) {
  const { dbPath, checkoutSessionId, purchaseId, priceCentsSnapshot } = workerData as {
    dbPath: string
    checkoutSessionId: string
    purchaseId: string
    priceCentsSnapshot: number
  }

  let store: Awaited<ReturnType<typeof createVipPurchaseStore>> | null = null
  try {
    store = await createVipPurchaseStore(dbPath)
    const result = store.fulfillPaidPurchase({
      checkoutSessionId,
      purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: priceCentsSnapshot,
    })
    const msg: WorkerResult = result.ok
      ? { ok: true, alreadyCredited: result.alreadyCredited }
      : { ok: false, message: result.message }
    parentPort?.postMessage(msg)
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: String(err) } satisfies WorkerResult)
  } finally {
    try { store?.close() } catch { /* ignore */ }
  }

  process.exit(0)
}

// ─── Брояч ───────────────────────────────────────────────────────────────

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
    throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`)
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-vip-purchase-store-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Огледало на реалните migrations (20260810_001, 20260815_001,
// 20260818_007, 20260818_008, 20260818_009) — минималната schema, нужна за
// store-а, ВКЛЮЧИТЕЛНО idx_vip_grants_purchase_id_once DB guard-а.
function buildSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_launch_gift_once
      ON vip_grants(profile_id)
      WHERE reason = 'launch_gift';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vip_grants_purchase_id_once
      ON vip_grants(purchase_id)
      WHERE reason = 'purchase' AND purchase_id IS NOT NULL;
  `)
}

function seedProfile(db: DatabaseSync, profileId: string): void {
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run(profileId, profileId)
}

function setActiveUntilDirectly(db: DatabaseSync, profileId: string, isoDate: string): void {
  db.prepare(`
    INSERT INTO vip_status (profile_id, active_until)
    VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;
  `).run(profileId, isoDate)
}

function getActiveUntil(db: DatabaseSync, profileId: string): string | null {
  const row = db.prepare(`SELECT active_until FROM vip_status WHERE profile_id = ?`).get(profileId) as
    | { active_until: string }
    | undefined
  return row?.active_until ?? null
}

function countGrants(db: DatabaseSync, profileId: string, reason: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt FROM vip_grants WHERE profile_id = ? AND reason = ?`,
  ).get(profileId, reason) as { cnt: number }
  return row.cnt
}

let sessionCounter = 0
function nextSessionId(): string {
  sessionCounter += 1
  return `cs_test_${sessionCounter}`
}

await check('[14] VIP_PACKAGE_CATALOG дни mapping: 30/180/365, без 90-дневен пакет', () => {
  assertEqual(VIP_PACKAGE_CATALOG.vip_30.days, 30, 'vip_30 трябва да е 30 дни')
  assertEqual(VIP_PACKAGE_CATALOG.vip_180.days, 180, 'vip_180 трябва да е 180 дни')
  assertEqual(VIP_PACKAGE_CATALOG.vip_365.days, 365, 'vip_365 трябва да е 365 дни')
  assert(!isVipPackageId('vip_90'), 'vip_90 НЕ трябва да е валиден package id')
  assertEqual(Object.keys(VIP_PACKAGE_CATALOG).length, 3, 'каталогът трябва да съдържа точно 3 пакета')
})

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'vip-purchase.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  for (const profileId of [
    'profile-0', 'profile-2', 'profile-3', 'profile-4-5', 'profile-6-7',
    'profile-9', 'profile-10-11', 'profile-12-13', 'profile-15-19', 'profile-20', 'profile-21-race',
  ]) {
    seedProfile(db, profileId)
  }

  const store = await createVipPurchaseStore(dbPath)

  await check('[0] createPendingPurchase → pending ред, snapshot точно от подадената цена', () => {
    const result = store.createPendingPurchase('profile-0', 'vip_30', 789)
    assert(result.ok === true, `Очаквах ok=true: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.purchase.status, 'pending', 'нов ред трябва да е pending')
      assertEqual(result.purchase.days, 30, 'days_snapshot трябва да е 30')
      assertEqual(result.purchase.priceCents, 789, 'price_cents_snapshot трябва да е 789')
      assertEqual(result.purchase.currency, 'EUR', 'валутата трябва да е EUR')
    }
  })

  await check('[1] createPendingPurchase за невалиден packageId → ok:false', () => {
    const result = store.createPendingPurchase('profile-0', 'vip_90' as never, 100)
    assertEqual(result.ok, false, 'невалиден package трябва да върне ok:false')
  })

  await check('[2] Повторен createPendingPurchase за същия профил/пакет докато pending → reuse на СЪЩИЯ ред', () => {
    const first = store.createPendingPurchase('profile-2', 'vip_180', 3_989)
    const second = store.createPendingPurchase('profile-2', 'vip_180', 3_989)
    assert(first.ok && second.ok, 'и двата опита трябва да успеят')
    if (first.ok && second.ok) {
      assertEqual(second.purchase.purchaseId, first.purchase.purchaseId, 'вторият опит трябва да върне СЪЩИЯ purchaseId')
    }
    const pendingCount = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM vip_purchase_ledger WHERE profile_id = ? AND status = 'pending'`)
        .get('profile-2') as { cnt: number }
    ).cnt
    assertEqual(pendingCount, 1, 'трябва да има точно 1 pending ред, не дубликат')
  })

  await check('[3] fulfillPaidPurchase за inactive профил + 30 дни → active_until ≈ now+30', () => {
    const pending = store.createPendingPurchase('profile-3', 'vip_30', 789)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assert(result.ok === true, `settlement трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.alreadyCredited, false, 'първо settlement не трябва да е alreadyCredited')
      const daysUntilExpiry = (new Date(result.newActiveUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      assert(daysUntilExpiry > 29.9 && daysUntilExpiry < 30.1, `Очаквах ~30 дни, получих ${daysUntilExpiry}`)
    }
  })

  await check('[4]+[5] Settlement математика: 27 дни активен + 30 дни покупка => 57 дни (extend, не overwrite)', () => {
    const future = new Date(Date.now() + 27 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    setActiveUntilDirectly(db, 'profile-4-5', future)

    const pending = store.createPendingPurchase('profile-4-5', 'vip_30', 789)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assert(result.ok === true, `settlement трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      const daysUntilExpiry = (new Date(result.newActiveUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      assert(
        daysUntilExpiry > 56.5 && daysUntilExpiry < 57.5,
        `Очаквах ~57 дни (27 оставащи + 30 нови), получих ${daysUntilExpiry}`,
      )

      const purchaseRow = store.getPurchaseById(pending.purchase.purchaseId)
      assert(purchaseRow !== null, 'покупката трябва да съществува след settlement')
      assertEqual(purchaseRow?.status, 'paid', 'ledger редът трябва да е "paid"')
      assert(purchaseRow?.vipGrantId !== null, 'vip_grant_id трябва да е попълнен')
    }
  })

  await check('[6]+[7] Idempotency: повторен webhook (същия checkoutSessionId) → alreadyCredited=true, active_until СЪЩИЯТ', () => {
    const pending = store.createPendingPurchase('profile-6-7', 'vip_30', 789)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const first = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assert(first.ok === true, 'първо settlement трябва да успее')
    if (!first.ok) return

    const activeUntilAfterFirst = getActiveUntil(db, 'profile-6-7')

    // Duplicate Stripe webhook delivery — същия checkoutSessionId, извикан отново.
    const second = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assert(second.ok === true, `второто settlement трябва да е ok (already credited): ${JSON.stringify(second)}`)
    if (second.ok) {
      assertEqual(second.alreadyCredited, true, 'второто извикване трябва да е alreadyCredited=true')
    }

    const activeUntilAfterSecond = getActiveUntil(db, 'profile-6-7')
    assertEqual(
      activeUntilAfterSecond,
      activeUntilAfterFirst,
      'active_until НЕ трябва да се промени при duplicate webhook (57, НЕ 87)',
    )

    const purchaseGrantCount = countGrants(db, 'profile-6-7', 'purchase')
    assertEqual(purchaseGrantCount, 1, 'трябва да има точно 1 vip_grants ред reason=purchase, не 2')
  })

  await check('[8] vip_grants ред от платена покупка попълва purchase_id/amount_paid_cents/currency', () => {
    const row = db.prepare(`
      SELECT purchase_id, amount_paid_cents, currency
      FROM vip_grants
      WHERE profile_id = ? AND reason = 'purchase'
      LIMIT 1;
    `).get('profile-6-7') as { purchase_id: string | null; amount_paid_cents: number | null; currency: string | null }

    assert(row.purchase_id !== null, 'purchase_id не трябва да е NULL за платена покупка')
    assertEqual(row.amount_paid_cents, 789, 'amount_paid_cents трябва да е 789')
    assertEqual(row.currency, 'EUR', 'currency трябва да е EUR')
  })

  await check('[9] Price-snapshot семантика: settlement използва СНАПШОТ цената, не "текущата"', () => {
    // Checkout е бил направен при цена 789 (snapshot в ledger реда). Симулираме
    // admin промяна на "текущата" цена — това НЕ трябва да засегне вече
    // създадения ledger ред (той пази собствен price_cents_snapshot).
    const pending = store.createPendingPurchase('profile-9', 'vip_30', 789)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return

    // "Admin промяна на цената" – нов caller подава различна текуща цена, но
    // тъй като вече има pending ред за profile-9/vip_30, createPendingPurchase
    // трябва да reuse-не СЪЩИЯ ред (със старата snapshot цена), не да презапише.
    const reused = store.createPendingPurchase('profile-9', 'vip_30', 849)
    assert(reused.ok, 'reuse опитът трябва да успее')
    if (reused.ok) {
      assertEqual(reused.purchase.priceCents, 789, 'reuse-натият ред трябва да пази ОРИГИНАЛНАТА snapshot цена (789), не новата (849)')
    }
  })

  await check('[10] fulfillPaidPurchase за несъществуваща checkout сесия → ok:false', () => {
    const result = store.fulfillPaidPurchase({
      checkoutSessionId: 'cs_nonexistent',
      purchaseId: 'nonexistent-purchase-id',
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assertEqual(result.ok, false, 'несъществуваща checkout сесия трябва да върне ok:false')
  })

  await check('[11] fulfillPaidPurchase за canceled purchase → ok:false', () => {
    const pending = store.createPendingPurchase('profile-10-11', 'vip_30', 789)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return

    const sessionId = nextSessionId()
    const attached = store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)
    assert(attached !== null, 'checkout session трябва да се закачи успешно')

    store.markPurchaseCanceledByCheckoutSessionId(sessionId)

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assertEqual(result.ok, false, 'canceled покупка не трябва да settle-ва')
  })

  await check('[12] findByCheckoutSessionId/attachCheckoutSession свързват реда коректно', () => {
    const pending = store.createPendingPurchase('profile-12-13', 'vip_365', 6_989)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return

    const sessionId = nextSessionId()
    const attached = store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)
    assert(attached !== null, 'attachCheckoutSession трябва да успее')
    assertEqual(attached?.providerCheckoutSessionId, sessionId, 'checkout session id трябва да е записан')

    const found = store.findByCheckoutSessionId(sessionId)
    assert(found !== null, 'findByCheckoutSessionId трябва да намери реда')
    assertEqual(found?.purchaseId, pending.purchase.purchaseId, 'намереният ред трябва да е СЪЩИЯТ purchaseId')
  })

  await check('[13] markPurchaseCanceledByCheckoutSessionId не пипа вече paid ред', () => {
    const pending = store.createPendingPurchase('profile-12-13', 'vip_30', 789)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return

    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)
    const settled = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assert(settled.ok === true, 'settlement трябва да успее преди cancel опита')

    // "Expired" webhook пристига СЛЕД като checkout вече е бил fulfilled — WHERE
    // status='pending' guard-ът трябва да предпази paid реда от презапис.
    store.markPurchaseCanceledByCheckoutSessionId(sessionId)

    const purchaseAfter = store.getPurchaseById(pending.purchase.purchaseId)
    assertEqual(purchaseAfter?.status, 'paid', 'paid редът трябва да остане paid, не canceled')
  })

  await check('[15] Липсващ checkoutSessionId → ok:false', () => {
    const result = store.fulfillPaidPurchase({
      checkoutSessionId: '',
      purchaseId: 'some-purchase-id',
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assertEqual(result.ok, false, 'липсващ checkoutSessionId трябва да се откаже')
  })

  await check('[16] checkoutSessionId сочи към реален ред, но purchaseId НЕ съвпада → ok:false', () => {
    const pendingA = store.createPendingPurchase('profile-15-19', 'vip_30', 789)
    assert(pendingA.ok, 'pending покупка А трябва да успее')
    if (!pendingA.ok) return
    const sessionId = nextSessionId()
    store.attachCheckoutSession(pendingA.purchase.purchaseId, sessionId)

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: 'spoofed-different-purchase-id',
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assertEqual(result.ok, false, 'несъответстващ purchaseId cross-check трябва да отхвърли settlement-а')

    const purchaseAfter = store.getPurchaseById(pendingA.purchase.purchaseId)
    assertEqual(purchaseAfter?.status, 'pending', 'редът трябва да остане pending след отхвърлен cross-check')
  })

  await check('[17] Stripe payment_status != "paid" → ok:false, ledger остава pending', () => {
    const pending = store.createPendingPurchase('profile-15-19', 'vip_180', 3_989)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'unpaid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 3_989,
    })
    assertEqual(result.ok, false, 'payment_status="unpaid" не трябва да settle-ва')

    const purchaseAfter = store.getPurchaseById(pending.purchase.purchaseId)
    assertEqual(purchaseAfter?.status, 'pending', 'редът трябва да остане pending')
  })

  await check('[18] Stripe currency != snapshot currency → ok:false, не начислява VIP', () => {
    const pending = store.createPendingPurchase('profile-15-19', 'vip_365', 6_989)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'USD',
      stripeAmountTotalCents: 6_989,
    })
    assertEqual(result.ok, false, 'валута USD срещу очаквано EUR трябва да се отхвърли')

    const purchaseAfter = store.getPurchaseById(pending.purchase.purchaseId)
    assertEqual(purchaseAfter?.status, 'pending', 'редът трябва да остане pending')
  })

  await check('[19] Stripe amount_total != price_cents_snapshot → ok:false, не начислява VIP', () => {
    const pending = store.createPendingPurchase('profile-20', 'vip_30', 789)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    // Атакуващ сценарий: Stripe сесията плаща само 1 цент, но ledger snapshot-ът
    // очаква 789 — settlement трябва да откаже, не да начисли 30 дни за 0,01€.
    const result = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1,
    })
    assertEqual(result.ok, false, 'несъответстваща платена сума трябва да се отхвърли')

    const purchaseAfter = store.getPurchaseById(pending.purchase.purchaseId)
    assertEqual(purchaseAfter?.status, 'pending', 'редът трябва да остане pending, VIP не се начислява')

    const activeUntil = getActiveUntil(db, 'profile-20')
    assertEqual(activeUntil, null, 'profile-20 не трябва да получи VIP статус от неуспешно settlement')
  })

  await check('[20] DB UNIQUE index idx_vip_grants_purchase_id_once отхвърля втори grant за същия purchase_id', () => {
    const pending = store.createPendingPurchase('profile-20', 'vip_30', 789)
    assert(pending.ok, 'pending покупка трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const settled = store.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assert(settled.ok === true, 'settlement трябва да успее')

    // Директен опит да се заобиколи application-level CAS-а и да се вкара
    // втори grant ръчно за СЪЩИЯ purchase_id — DB constraint-ът трябва да
    // блокира дори ако application логиката някога бъде байпасната.
    let threw = false
    try {
      db.prepare(`
        INSERT INTO vip_grants (
          grant_id, profile_id, reason, interval_unit, interval_amount,
          purchase_id, amount_paid_cents, currency
        ) VALUES (?, ?, 'purchase', 'days', 30, ?, 789, 'EUR');
      `).run('manual-duplicate-grant-id', 'profile-20', pending.purchase.purchaseId)
    } catch {
      threw = true
    }
    assert(threw, 'директен duplicate INSERT в vip_grants за същия purchase_id трябва да хвърли UNIQUE constraint грешка')
  })

  await check('[22] Две отделни легитимни покупки (различни checkout сесии) → и двете extend-ват точно веднъж, кумулативно', () => {
    seedProfile(db, 'profile-22-two-purchases')

    const firstPending = store.createPendingPurchase('profile-22-two-purchases', 'vip_30', 789)
    assert(firstPending.ok, 'първата pending покупка трябва да успее')
    if (!firstPending.ok) return
    const firstSessionId = nextSessionId()
    store.attachCheckoutSession(firstPending.purchase.purchaseId, firstSessionId)

    const firstResult = store.fulfillPaidPurchase({
      checkoutSessionId: firstSessionId,
      purchaseId: firstPending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 789,
    })
    assert(firstResult.ok === true, `първо settlement трябва да успее: ${JSON.stringify(firstResult)}`)
    if (!firstResult.ok) return
    const daysAfterFirst = (new Date(firstResult.newActiveUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    assert(daysAfterFirst > 29.9 && daysAfterFirst < 30.1, `след първа покупка (30 дни) очаквах ~30, получих ${daysAfterFirst}`)

    // Втора, НЕЗАВИСИМА легитимна покупка (различен purchaseId, различна Stripe
    // сесия) — трябва да extend-не ОТ резултата на първата, не да я презапише
    // и не да бъде третирана като duplicate на първата (различен checkoutSessionId).
    const secondPending = store.createPendingPurchase('profile-22-two-purchases', 'vip_180', 3_989)
    assert(secondPending.ok, 'втората pending покупка трябва да успее')
    if (!secondPending.ok) return
    assert(
      secondPending.purchase.purchaseId !== firstPending.purchase.purchaseId,
      'втората покупка трябва да е отделен ledger ред (различен purchaseId)',
    )
    const secondSessionId = nextSessionId()
    store.attachCheckoutSession(secondPending.purchase.purchaseId, secondSessionId)

    const secondResult = store.fulfillPaidPurchase({
      checkoutSessionId: secondSessionId,
      purchaseId: secondPending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 3_989,
    })
    assert(secondResult.ok === true, `второ settlement трябва да успее: ${JSON.stringify(secondResult)}`)
    if (secondResult.ok) {
      assertEqual(secondResult.alreadyCredited, false, 'втората покупка е НОВО кредитиране, не alreadyCredited')
      const daysAfterSecond = (new Date(secondResult.newActiveUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      assert(
        daysAfterSecond > 209.5 && daysAfterSecond < 210.5,
        `30 (първа) + 180 (втора) = 210 дни общо очаквах, получих ${daysAfterSecond}`,
      )
    }

    const purchaseGrantCount = countGrants(db, 'profile-22-two-purchases', 'purchase')
    assertEqual(purchaseGrantCount, 2, 'трябва да има точно 2 отделни purchase grant реда (по един на всяка легитимна покупка)')
  })

  store.close()
  db.close()
})

// ─── [21] Concurrency: два едновременни webhook опита за СЪЩИЯ checkout session ──

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'vip-purchase-race.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)
  seedProfile(db, 'profile-race-21')

  const store = await createVipPurchaseStore(dbPath)
  const pending = store.createPendingPurchase('profile-race-21', 'vip_30', 789)
  if (!pending.ok) {
    fail('[21] setup', 'createPendingPurchase failed')
  } else {
    const sessionId = 'cs_race_21'
    store.attachCheckoutSession(pending.purchase.purchaseId, sessionId)
    store.close()

    await check('[21] Concurrency: 2 едновременни webhook опита за същия checkout session → точно 1 grant', async () => {
      const runInWorker = (): Promise<WorkerResult> =>
        new Promise((resolvePromise, reject) => {
          const w = new Worker(__filename, {
            workerData: {
              dbPath,
              checkoutSessionId: sessionId,
              purchaseId: pending.purchase.purchaseId,
              priceCentsSnapshot: 789,
            },
          })
          let msg: WorkerResult | null = null
          w.on('message', (m: WorkerResult) => { msg = m })
          w.on('error', reject)
          w.on('exit', () => resolvePromise(msg ?? { ok: false, error: 'Worker exited without message' }))
        })

      const results = await Promise.all([runInWorker(), runInWorker()])

      for (const r of results) {
        assert(!r.error, `Worker crashна: ${String(r.error)}`)
      }

      const freshlyCreditedCount = results.filter((r) => r.ok === true && r.alreadyCredited === false).length
      const alreadyCreditedCount = results.filter((r) => r.ok === true && r.alreadyCredited === true).length

      assertEqual(freshlyCreditedCount, 1, `Точно 1 от 2 concurrent webhook опита трябва да кредитира, получих: ${JSON.stringify(results)}`)
      assertEqual(alreadyCreditedCount, 1, 'Другият трябва да получи alreadyCredited=true')

      const verifyDb = new DatabaseSync(dbPath, { open: true })
      const grantCount = (
        verifyDb.prepare(`SELECT COUNT(*) AS cnt FROM vip_grants WHERE profile_id = ? AND reason = 'purchase'`)
          .get('profile-race-21') as { cnt: number }
      ).cnt
      assertEqual(grantCount, 1, 'В базата трябва да има точно 1 purchase grant ред, не 2')

      const daysUntilExpiry = (new Date(dbDateToUtcLocal(getActiveUntil(verifyDb, 'profile-race-21')!)).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      assert(daysUntilExpiry > 29.9 && daysUntilExpiry < 30.1, `active_until трябва да отразява само ЕДНО кредитиране (~30 дни), получих ${daysUntilExpiry}`)

      verifyDb.close()
    })
  }

  db.close()
})

function dbDateToUtcLocal(value: string): string {
  return value.endsWith('Z') ? value : `${value}Z`
}

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
