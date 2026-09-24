/**
 * checkBundlePurchaseStore.ts
 *
 * Store-level checks за shopBundlePackageStore.ts (admin CRUD за Shop ->
 * "Пакети" продукти) и bundlePurchaseStore.ts (платен checkout ledger,
 * atomic settlement: coins credit + VIP calendar-interval extend В ЕДНА
 * транзакция, idempotency при повторен webhook, price-snapshot-at-checkout
 * семантика). Mirror на checkVipPurchaseStore.ts pattern-а, plus
 * coin-wallet assertions (bundle-специфичен: единия settlement дава И
 * двете награди атомарно).
 *
 * A. shopBundlePackageStore
 * [A0]  upsertPackage(нов) → active пакет с точните стойности
 * [A1]  upsertPackage с coins<=0 → ok:false
 * [A2]  upsertPackage с vipDays<=0 → ok:false
 * [A3]  upsertPackage с priceCents<=0 → ok:false
 * [A4]  listPublicPackages връща само active, listAdminPackages връща всички
 * [A5]  setPackageStatus('inactive') премахва от listPublicPackages
 * [A6]  deletePackage премахва от listAdminPackages
 * [A7]  create с кирилско заглавие "Супер пакет" → ok:true, title точно
 *         кирилица, packageKey server-generated (валиден ASCII slug,
 *         НЕЗАВИСИМ от title съдържанието — регресия срещу ASCII-derive-
 *         from-title bug-а)
 * [A8]  package получава валиден stable internal packageId (UUID формат)
 * [A9]  edit на СЪЩИЯ пакет (title -> "Празничен пакет") → ok:true,
 *         packageId И packageKey остават ТОЧНО същите (stable identifier
 *         не се променя при редакция на display name)
 * [A10] Shop API (listPublicPackages) връща кирилското заглавие точно,
 *         без transliteration/mangling
 *
 * B. bundlePurchaseStore — pending purchase creation
 * [B0]  createPendingPurchase за активен пакет → pending ред, coins/vipDays/
 *         price snapshot-нати ТОЧНО от активния DB ред (не recompute-нати)
 * [B1]  createPendingPurchase за inactive/несъществуващ packageId → ok:false
 * [B2]  Повторен createPendingPurchase за същия профил/пакет докато pending
 *         → reuse на СЪЩИЯ ред, не дубликат
 *
 * C. Atomic settlement — coins + VIP в ЕДНА транзакция
 * [C0]  fulfillPaidPurchase за inactive VIP профил + нов wallet → И двете
 *         награди се дават: wallet balance += coins, active_until ≈ now+days
 * [C1]  Settlement математика: активен VIP статус 27 дни в бъдещето +
 *         покупка на 30 дни VIP → 57 дни общо (extend, НЕ overwrite)
 * [C2]  fulfillPaidPurchase маркира ledger реда 'paid' и попълва vip_grant_id
 * [C3]  vip_grants ред от bundle покупка попълва purchase_id/
 *         amount_paid_cents/currency (споделя reason='purchase' с директните
 *         VIP покупки — НЕ нов reason enum член)
 *
 * D. Idempotency
 * [D0]  Повторен webhook (същия checkoutSessionId) след кредитирана покупка
 *         → alreadyCredited=true, wallet balance НЕ се увеличава повторно
 * [D1]  Повторен webhook → active_until СЪЩИЯТ (57, НЕ 87) — VIP не се
 *         удължава повторно
 * [D2]  vip_grants съдържа точно ЕДИН grant ред за тази покупка (не два)
 *
 * E. Stripe field validation (forged/несъответстваща сесия)
 * [E0]  Stripe payment_status != 'paid' → ok:false, wallet/VIP непроменени
 * [E1]  Stripe currency != snapshot currency → ok:false
 * [E2]  Stripe amount_total != price_cents snapshot → ok:false
 * [E3]  Липсващ checkoutSessionId → ok:false
 *
 * F. DB-level defense in depth
 * [F0]  DB UNIQUE index idx_vip_grants_bundle_purchase_id_once (20260923_005)
 *         хваща директен опит за втори INSERT в vip_grants със същия
 *         bundle_purchase_id/reason='purchase' (последна защита зад CAS-а;
 *         ОТДЕЛЕН index от idx_vip_grants_purchase_id_once — purchase_id
 *         остава изключително за VIP-direct)
 *
 * G. Две отделни легитимни bundle покупки
 * [G0]  Две ОТДЕЛНИ покупки (различни checkout сесии) → и двете extend-ват
 *         VIP кумулативно, И двете кредитират coins кумулативно, 2 отделни
 *         grant реда
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
  if (actual !== expected) {
    throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`)
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-bundle-purchase-store-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Огледало на реалните migrations (20260810_001, 20260818_009,
// 20260923_001) — минималната schema, нужна за store-овете, ВКЛЮЧИТЕЛНО
// idx_vip_grants_purchase_id_once DB guard-а и profile_wallets.
function buildSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT NULL,
      profile_kind TEXT NOT NULL DEFAULT 'human' CHECK (profile_kind IN ('human', 'bot')),
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      is_temporary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- "Подари авоари" (20260923_002 migration) recipient eligibility check
    -- (bundlePurchaseStore.selectGiftRecipientEligibilityStatement) реферира
    -- тази таблица директно — нужна тук само за да не chупи store-a prepared
    -- statements, dedicated gift тестове са в checkPaidGiftShopStores.ts.
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
      -- "Подари авоари" (20260923_002 migration) — payer/recipient split.
      -- Виж checkPaidGiftShopStores.ts за dedicated gift purchase тестове;
      -- тук са нужни само за да не chупи store-a prepared statements.
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

function getWalletBalance(db: DatabaseSync, profileId: string): number {
  const row = db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
    | { yellow_coins_balance: number }
    | undefined
  return row?.yellow_coins_balance ?? 0
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
  return `cs_test_bundle_${sessionCounter}`
}

// ─── A. shopBundlePackageStore ──────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'bundle-package.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)
  const store = await createShopBundlePackageStore(dbPath)

  await check('[A0] upsertPackage(нов) → active пакет с точните стойности', () => {
    const result = store.upsertPackage({
      packageKey: '',
      title: 'Супер',
      description: 'Тестов пакет',
      yellowCoinsAmount: 500_000,
      vipDays: 30,
      priceCents: 999,
      currency: 'EUR',
      status: 'active',
      sortOrder: 10,
    })
    assert(result.ok, `упсерт трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.package.yellowCoinsAmount, 500_000, 'coins')
      assertEqual(result.package.vipDays, 30, 'vipDays')
      assertEqual(result.package.priceCents, 999, 'priceCents')
      assertEqual(result.package.status, 'active', 'status')
    }
  })

  await check('[A1] upsertPackage с coins<=0 → ok:false', () => {
    const result = store.upsertPackage({
      packageKey: '', title: 'Bad', description: '',
      yellowCoinsAmount: 0, vipDays: 30, priceCents: 999, currency: 'EUR', status: 'active', sortOrder: 0,
    })
    assertEqual(result.ok, false, 'coins=0 трябва да е невалидно')
  })

  await check('[A2] upsertPackage с vipDays<=0 → ok:false', () => {
    const result = store.upsertPackage({
      packageKey: '', title: 'Bad', description: '',
      yellowCoinsAmount: 100_000, vipDays: 0, priceCents: 999, currency: 'EUR', status: 'active', sortOrder: 0,
    })
    assertEqual(result.ok, false, 'vipDays=0 трябва да е невалидно')
  })

  await check('[A3] upsertPackage с priceCents<=0 → ok:false', () => {
    const result = store.upsertPackage({
      packageKey: '', title: 'Bad', description: '',
      yellowCoinsAmount: 100_000, vipDays: 30, priceCents: 0, currency: 'EUR', status: 'active', sortOrder: 0,
    })
    assertEqual(result.ok, false, 'priceCents=0 трябва да е невалидно')
  })

  await check('[A4] listPublicPackages само active, listAdminPackages всички', () => {
    store.upsertPackage({
      packageKey: '', title: 'Скрит', description: '',
      yellowCoinsAmount: 50_000, vipDays: 7, priceCents: 199, currency: 'EUR', status: 'inactive', sortOrder: 20,
    })
    const publicList = store.listPublicPackages()
    const adminList = store.listAdminPackages()
    assert(publicList.some((p) => p.title === 'Супер'), 'public трябва да съдържа активния')
    assert(!publicList.some((p) => p.title === 'Скрит'), 'public НЕ трябва да съдържа inactive')
    assert(adminList.some((p) => p.title === 'Скрит'), 'admin трябва да вижда и inactive')
  })

  await check('[A5] setPackageStatus(inactive) премахва от listPublicPackages', () => {
    const superPkg = store.listAdminPackages().find((p) => p.title === 'Супер')
    assert(superPkg !== undefined, 'super package трябва да съществува')
    if (!superPkg) return
    store.setPackageStatus(superPkg.packageId, 'inactive')
    const publicList = store.listPublicPackages()
    assert(!publicList.some((p) => p.title === 'Супер'), 'деактивиран пакет не трябва да е публичен')
    store.setPackageStatus(superPkg.packageId, 'active')
  })

  await check('[A6] deletePackage премахва от listAdminPackages', () => {
    const hiddenPkg = store.listAdminPackages().find((p) => p.title === 'Скрит')
    assert(hiddenPkg !== undefined, 'hidden package трябва да съществува')
    if (!hiddenPkg) return
    const result = store.deletePackage(hiddenPkg.packageId)
    assert(result.ok, 'изтриването трябва да успее')
    if (result.ok) {
      assert(!result.packages.some((p) => p.title === 'Скрит'), 'изтритият пакет не трябва да е в списъка')
    }
  })

  // ─── Кирилица title / server-generated packageKey регресия ────────────────
  // Production bug repro: admin въвежда "Супер пакет" (кирилица) като
  // display name -> старата frontend derive-from-title логика
  // (title.toLowerCase().replace(/[^a-z0-9_-]+/g,'-')) strip-ваше цялата
  // кирилица до празен string -> server-side ASCII regex validation
  // отхвърляше празния packageKey. Тестовете тук доказват, че packageKey
  // вече НИКОГА не се derive-ва от title — генерира се server-side,
  // независимо от съдържанието на заглавието.

  let cyrillicPackageId = ''
  let cyrillicPackageKey = ''

  await check('[A7] create с кирилско заглавие "Супер пакет" → ok:true, title точно кирилица, packageKey server-generated (независим от title)', () => {
    // Frontend вече не подава derived packageKey (винаги '' — виж
    // renderLobbyScreen.ts submit handler-а) — тестваме точно тоя контракт.
    const result = store.upsertPackage({
      packageKey: '',
      title: 'Супер пакет',
      description: '',
      yellowCoinsAmount: 500_000,
      vipDays: 30,
      priceCents: 999,
      currency: 'EUR',
      status: 'active',
      sortOrder: 5,
    })
    assert(result.ok, `create с кирилица трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.package.title, 'Супер пакет', 'title трябва да е точно кирилица, без transliteration')
      assert(result.package.packageKey.length > 0, 'packageKey трябва да е server-generated, не празен')
      assert(/^[a-z0-9][a-z0-9_-]*$/.test(result.package.packageKey), `server-generated packageKey трябва да е валиден ASCII slug, получих "${result.package.packageKey}"`)
      cyrillicPackageId = result.package.packageId
      cyrillicPackageKey = result.package.packageKey
    }
  })

  await check('[A8] package получава валиден stable internal packageId (UUID формат)', () => {
    assert(cyrillicPackageId.length > 0, 'packageId трябва да е попълнен')
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cyrillicPackageId),
      `packageId трябва да е валиден UUID, получих "${cyrillicPackageId}"`,
    )
  })

  await check('[A9] edit на СЪЩИЯ пакет (title -> "Празничен пакет") → packageId И packageKey остават ТОЧНО същите', () => {
    const result = store.upsertPackage({
      packageId: cyrillicPackageId,
      packageKey: '', // frontend винаги подава '' — сървърът трябва да игнорира и да запази оригиналния key
      title: 'Празничен пакет',
      description: 'Редактирано описание',
      yellowCoinsAmount: 500_000,
      vipDays: 30,
      priceCents: 999,
      currency: 'EUR',
      status: 'active',
      sortOrder: 5,
    })
    assert(result.ok, `edit трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.package.title, 'Празничен пакет', 'title трябва да е обновен')
      assertEqual(result.package.packageId, cyrillicPackageId, 'packageId НЕ трябва да се промени при редакция на името')
      assertEqual(result.package.packageKey, cyrillicPackageKey, 'packageKey НЕ трябва да се промени при редакция на името')
    }

    // Потвърждение, че няма създаден ДУБЛИКАТ ред (upsert по package_key,
    // не нов ред с нов случаен key).
    const adminList = store.listAdminPackages()
    const matchingRows = adminList.filter((p) => p.packageId === cyrillicPackageId)
    assertEqual(matchingRows.length, 1, 'трябва да има точно 1 ред с тоя packageId, не дубликат')
  })

  await check('[A10] Shop API (listPublicPackages) връща кирилското заглавие точно, без transliteration/mangling', () => {
    const publicList = store.listPublicPackages()
    const found = publicList.find((p) => p.packageId === cyrillicPackageId)
    assert(found !== undefined, 'редактираният пакет трябва да е видим в public listing-а (active)')
    if (found) {
      assertEqual(found.title, 'Празничен пакет', 'Shop API трябва да връща точното кирилско заглавие')
      assertEqual(found.packageKey, cyrillicPackageKey, 'Shop API трябва да връща same stable packageKey')
    }
  })

  store.close()
  db.close()
})

// ─── B-G. bundlePurchaseStore ────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'bundle-purchase.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)

  for (const profileId of [
    'profile-b0', 'profile-b2', 'profile-c0', 'profile-c1', 'profile-c1b',
    'profile-d0', 'profile-e0', 'profile-e1', 'profile-e2', 'profile-e3',
    'profile-f0', 'profile-g0', 'profile-h0',
  ]) {
    seedProfile(db, profileId)
  }

  const packageStore = await createShopBundlePackageStore(dbPath)
  const purchaseStore = await createBundlePurchaseStore(dbPath)

  const superPkg = packageStore.upsertPackage({
    packageKey: 'super', title: 'Супер', description: 'Тестов пакет',
    yellowCoinsAmount: 500_000, vipDays: 30, priceCents: 999, currency: 'EUR', status: 'active', sortOrder: 10,
  })
  assert(superPkg.ok, 'setup: super package трябва да се създаде')
  const superPackageId = superPkg.ok ? superPkg.package.packageId : ''

  const inactivePkg = packageStore.upsertPackage({
    packageKey: 'inactive-one', title: 'Неактивен', description: '',
    yellowCoinsAmount: 10_000, vipDays: 1, priceCents: 99, currency: 'EUR', status: 'inactive', sortOrder: 20,
  })
  assert(inactivePkg.ok, 'setup: inactive package трябва да се създаде')
  const inactivePackageId = inactivePkg.ok ? inactivePkg.package.packageId : ''

  // ─── B ──────────────────────────────────────────────────────────────────

  await check('[B0] createPendingPurchase → snapshot точно от активния DB ред', () => {
    const result = purchaseStore.createPendingPurchase('profile-b0', superPackageId)
    assert(result.ok, `pending покупка трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.purchase.status, 'pending', 'status')
      assertEqual(result.purchase.yellowCoinsAmount, 500_000, 'coins snapshot')
      assertEqual(result.purchase.vipDays, 30, 'vipDays snapshot')
      assertEqual(result.purchase.priceCents, 999, 'price snapshot')
    }
  })

  await check('[B1] createPendingPurchase за inactive/несъществуващ packageId → ok:false', () => {
    const r1 = purchaseStore.createPendingPurchase('profile-b0', inactivePackageId)
    assertEqual(r1.ok, false, 'inactive package трябва да откаже')
    const r2 = purchaseStore.createPendingPurchase('profile-b0', 'not-a-real-id')
    assertEqual(r2.ok, false, 'несъществуващ package трябва да откаже')
  })

  await check('[B2] Повторен createPendingPurchase докато pending → reuse на СЪЩИЯ ред', () => {
    const first = purchaseStore.createPendingPurchase('profile-b2', superPackageId)
    const second = purchaseStore.createPendingPurchase('profile-b2', superPackageId)
    assert(first.ok && second.ok, 'и двата опита трябва да успеят')
    if (first.ok && second.ok) {
      assertEqual(second.purchase.purchaseId, first.purchase.purchaseId, 'трябва да е СЪЩИЯТ purchaseId')
    }
    const pendingCount = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM bundle_purchase_ledger WHERE profile_id = ? AND status = 'pending'`)
        .get('profile-b2') as { cnt: number }
    ).cnt
    assertEqual(pendingCount, 1, 'трябва да има точно 1 pending ред')
  })

  // ─── C ──────────────────────────────────────────────────────────────────

  await check('[C0] fulfillPaidPurchase дава И coins И VIP атомарно', () => {
    const pending = purchaseStore.createPendingPurchase('profile-c0', superPackageId)
    assert(pending.ok, 'pending трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    purchaseStore.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    assertEqual(getWalletBalance(db, 'profile-c0'), 0, 'wallet трябва да е 0 преди settlement')

    const result = purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    })
    assert(result.ok === true, `settlement трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      assertEqual(result.alreadyCredited, false, 'първо settlement не е alreadyCredited')
      assertEqual(getWalletBalance(db, 'profile-c0'), 500_000, 'wallet трябва да получи 500000 coins')
      const daysUntilExpiry = (new Date(result.newActiveUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      assert(daysUntilExpiry > 29.9 && daysUntilExpiry < 30.1, `Очаквах ~30 дни VIP, получих ${daysUntilExpiry}`)
    }
  })

  await check('[C1] Settlement математика: 27 дни активен VIP + 30 дни покупка => 57 дни', () => {
    const future = new Date(Date.now() + 27 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    setActiveUntilDirectly(db, 'profile-c1', future)

    const pending = purchaseStore.createPendingPurchase('profile-c1', superPackageId)
    assert(pending.ok, 'pending трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    purchaseStore.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const result = purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    })
    assert(result.ok === true, `settlement трябва да успее: ${JSON.stringify(result)}`)
    if (result.ok) {
      const daysUntilExpiry = (new Date(result.newActiveUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      assert(daysUntilExpiry > 56.5 && daysUntilExpiry < 57.5, `Очаквах ~57 дни (27+30), получих ${daysUntilExpiry}`)
    }
  })

  await check('[C2] fulfillPaidPurchase маркира ledger реда paid и попълва vip_grant_id', () => {
    const pending = purchaseStore.createPendingPurchase('profile-c1b', superPackageId)
    assert(pending.ok, 'pending трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    purchaseStore.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    })

    const row = db.prepare(`SELECT status, vip_grant_id FROM bundle_purchase_ledger WHERE purchase_id = ?`)
      .get(pending.purchase.purchaseId) as { status: string; vip_grant_id: string | null }
    assertEqual(row.status, 'paid', 'ledger status трябва да е paid')
    assert(row.vip_grant_id !== null, 'vip_grant_id трябва да е попълнен')
  })

  await check('[C3] vip_grants ред от bundle покупка попълва bundle_purchase_id/amount_paid_cents/currency (purchase_id остава NULL)', () => {
    // 20260923_005 pre-deploy blocker fix: vip_grants.purchase_id е FK
    // СТРИКТНО към vip_purchase_ledger(purchase_id) — bundle-generated
    // grants пишат bundle_purchase_id вместо purchase_id (виж
    // bundlePurchaseStore.ts insertVipGrantStatement коментара). По-старата
    // версия на тоя тест assert-ваше purchase_id !== null тук — точно
    // обратното на коректното поведение, и би минала само срещу hand-rolled
    // test schema БЕЗ реалния FK constraint (виж
    // checkBundleVipGrantLinkage.ts за FK-enforced coverage).
    const grantRow = db.prepare(`
      SELECT purchase_id, bundle_purchase_id, amount_paid_cents, currency, reason FROM vip_grants
      WHERE profile_id = ?
      ORDER BY granted_at DESC LIMIT 1
    `).get('profile-c1b') as { purchase_id: string | null; bundle_purchase_id: string | null; amount_paid_cents: number | null; currency: string | null; reason: string }
    assertEqual(grantRow.reason, 'purchase', 'reason трябва да е purchase (споделен с директни VIP покупки)')
    assertEqual(grantRow.purchase_id, null, 'purchase_id ТРЯБВА да е NULL за bundle-generated grant (запазено изключително за VIP-direct)')
    assert(grantRow.bundle_purchase_id !== null, 'bundle_purchase_id трябва да е попълнен')
    assertEqual(grantRow.amount_paid_cents, 999, 'amount_paid_cents трябва да е 999')
    assertEqual(grantRow.currency, 'EUR', 'currency трябва да е EUR')
  })

  // ─── D. Idempotency ───────────────────────────────────────────────────────

  await check('[D0]+[D1]+[D2] Повторен webhook → alreadyCredited=true, wallet/VIP/grants НЕ се дублират (explicit before/after balances)', () => {
    const pending = purchaseStore.createPendingPurchase('profile-d0', superPackageId)
    assert(pending.ok, 'pending трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    purchaseStore.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const params = {
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    }

    const balanceBefore = getWalletBalance(db, 'profile-d0')
    assertEqual(balanceBefore, 0, 'начален wallet balance трябва да е 0')

    // ─── Първо fulfillment: coins + VIP СЕ дават ──────────────────────────
    const first = purchaseStore.fulfillPaidPurchase(params)
    assert(first.ok === true, `първо settlement трябва да успее: ${JSON.stringify(first)}`)
    const balanceAfterFirst = getWalletBalance(db, 'profile-d0')
    const activeUntilAfterFirst = getActiveUntil(db, 'profile-d0')
    console.log(`    [D-trace] balance: ${balanceBefore} -> ${balanceAfterFirst} (first fulfillment)`)
    console.log(`    [D-trace] active_until after first fulfillment: ${activeUntilAfterFirst}`)
    assertEqual(balanceAfterFirst, 500_000, 'първото fulfillment трябва да кредитира точно 500000 coins')
    assert(activeUntilAfterFirst !== null, 'active_until трябва да е зададен след първо fulfillment')
    const ledgerStatusAfterFirst = (
      db.prepare(`SELECT status FROM bundle_purchase_ledger WHERE purchase_id = ?`).get(pending.purchase.purchaseId) as { status: string }
    ).status
    assertEqual(ledgerStatusAfterFirst, 'paid', 'ledger трябва да е paid след първо fulfillment')

    // ─── Второ fulfillment на СЪЩАТА purchase (Stripe webhook retry) ──────
    const second = purchaseStore.fulfillPaidPurchase(params)
    assert(second.ok === true, `второ (duplicate) settlement трябва да "успее" idempotently: ${JSON.stringify(second)}`)
    if (second.ok) {
      assertEqual(second.alreadyCredited, true, 'вторият опит трябва да е alreadyCredited')
    }

    const balanceAfterSecond = getWalletBalance(db, 'profile-d0')
    const activeUntilAfterSecond = getActiveUntil(db, 'profile-d0')
    console.log(`    [D-trace] balance: ${balanceAfterFirst} -> ${balanceAfterSecond} (duplicate fulfillment, expect unchanged)`)
    console.log(`    [D-trace] active_until after duplicate fulfillment: ${activeUntilAfterSecond} (expect unchanged)`)

    // coins НЕ се променят
    assertEqual(balanceAfterSecond, balanceAfterFirst, 'wallet НЕ трябва да се увеличи повторно')
    assertEqual(balanceAfterSecond, 500_000, 'wallet трябва да остане точно 500000, не 1000000')
    // VIP НЕ се променя
    assertEqual(activeUntilAfterSecond, activeUntilAfterFirst, 'active_until НЕ трябва да се промени повторно')
    // ledger остава paid
    const ledgerStatusAfterSecond = (
      db.prepare(`SELECT status FROM bundle_purchase_ledger WHERE purchase_id = ?`).get(pending.purchase.purchaseId) as { status: string }
    ).status
    assertEqual(ledgerStatusAfterSecond, 'paid', 'ledger трябва да остане paid след duplicate fulfillment')
    assertEqual(countGrants(db, 'profile-d0', 'purchase'), 1, 'трябва да има точно 1 grant, не 2')
  })

  // ─── E. Stripe field validation ─────────────────────────────────────────────

  await check('[E0] Stripe payment_status != paid → ok:false, wallet/VIP непроменени', () => {
    const pending = purchaseStore.createPendingPurchase('profile-e0', superPackageId)
    assert(pending.ok, 'pending трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    purchaseStore.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const result = purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'unpaid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    })
    assertEqual(result.ok, false, 'unpaid status трябва да откаже settlement')
    assertEqual(getWalletBalance(db, 'profile-e0'), 0, 'wallet трябва да остане 0')
  })

  await check('[E1] Stripe currency != snapshot currency → ok:false', () => {
    const pending = purchaseStore.createPendingPurchase('profile-e1', superPackageId)
    assert(pending.ok, 'pending трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    purchaseStore.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const result = purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'USD',
      stripeAmountTotalCents: 999,
    })
    assertEqual(result.ok, false, 'валутно несъответствие трябва да откаже settlement')
  })

  await check('[E2] Stripe amount_total != price snapshot → ok:false (защита срещу подправена сума)', () => {
    const pending = purchaseStore.createPendingPurchase('profile-e2', superPackageId)
    assert(pending.ok, 'pending трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    purchaseStore.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    const result = purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 1, // forged: платено е само 1 цент
    })
    assertEqual(result.ok, false, 'сумово несъответствие трябва да откаже settlement')
    assertEqual(getWalletBalance(db, 'profile-e2'), 0, 'wallet трябва да остане недокоснат')
  })

  await check('[E3] Липсващ checkoutSessionId → ok:false', () => {
    const result = purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: '',
      purchaseId: 'whatever',
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    })
    assertEqual(result.ok, false, 'липсваща сесия трябва да откаже settlement')
  })

  // ─── F. DB-level defense in depth ───────────────────────────────────────────

  await check('[F0] DB UNIQUE index хваща директен опит за втори vip_grants INSERT със същия bundle_purchase_id', () => {
    // 20260923_005 pre-deploy blocker fix: bundle-generated grants пишат
    // bundle_purchase_id, НЕ purchase_id (тази остава изключително за
    // VIP-direct) — guard-ът тук трябва да тества idx_vip_grants_bundle_purchase_id_once,
    // не idx_vip_grants_purchase_id_once.
    const pending = purchaseStore.createPendingPurchase('profile-f0', superPackageId)
    assert(pending.ok, 'pending трябва да успее')
    if (!pending.ok) return
    const sessionId = nextSessionId()
    purchaseStore.attachCheckoutSession(pending.purchase.purchaseId, sessionId)
    purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    })

    let threw = false
    try {
      db.prepare(`
        INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount, resulting_active_until, bundle_purchase_id, amount_paid_cents, currency)
        VALUES ('duplicate-grant', ?, 'purchase', 'days', 30, '2099-01-01 00:00:00', ?, 999, 'EUR')
      `).run('profile-f0', pending.purchase.purchaseId)
    } catch {
      threw = true
    }
    assert(threw, 'директен втори INSERT със същия bundle_purchase_id трябва да удари UNIQUE constraint')
  })

  // ─── G. Две отделни легитимни покупки ───────────────────────────────────────

  await check('[G0] Две ОТДЕЛНИ bundle покупки → coins+VIP extend-ват кумулативно, 2 отделни grant реда', () => {
    const first = purchaseStore.createPendingPurchase('profile-g0', superPackageId)
    assert(first.ok, 'първа покупка pending трябва да успее')
    if (!first.ok) return
    const sessionId1 = nextSessionId()
    purchaseStore.attachCheckoutSession(first.purchase.purchaseId, sessionId1)
    const r1 = purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId1,
      purchaseId: first.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    })
    assert(r1.ok, `първо settlement трябва да успее: ${JSON.stringify(r1)}`)

    // Втора, ОТДЕЛНА легитимна покупка (различна checkout сесия/purchaseId).
    const second = purchaseStore.createPendingPurchase('profile-g0', superPackageId)
    assert(second.ok, 'втора покупка pending трябва да успее')
    if (!second.ok) return
    assert(second.purchase.purchaseId !== first.purchase.purchaseId, 'втората покупка трябва да е нов ред (първата вече е paid)')
    const sessionId2 = nextSessionId()
    purchaseStore.attachCheckoutSession(second.purchase.purchaseId, sessionId2)
    const r2 = purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId2,
      purchaseId: second.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999,
    })
    assert(r2.ok, `второ settlement трябва да успее: ${JSON.stringify(r2)}`)

    assertEqual(getWalletBalance(db, 'profile-g0'), 1_000_000, 'wallet трябва да е 500000*2 = 1000000')
    if (r2.ok) {
      const daysUntilExpiry = (new Date(r2.newActiveUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      assert(daysUntilExpiry > 59.5 && daysUntilExpiry < 60.5, `Очаквах ~60 дни (30+30 кумулативно), получих ${daysUntilExpiry}`)
    }
    assertEqual(countGrants(db, 'profile-g0', 'purchase'), 2, 'трябва да има точно 2 отделни grant реда')
  })

  // ─── H. Immutable snapshot — admin редакция след checkout не влияе на fulfillment ─

  await check('[H0] Admin редактира title/coins/vipDays/price СЛЕД checkout, ПРЕДИ fulfillment → fulfillment дава EXACT старите snapshot стойности, не новите package config', () => {
    // Checkout създаден при СТАРАТА конфигурация на пакета (500000 coins, 30 VIP дни, 999 цена).
    const pending = purchaseStore.createPendingPurchase('profile-h0', superPackageId)
    assert(pending.ok, 'pending трябва да успее')
    if (!pending.ok) return
    assertEqual(pending.purchase.yellowCoinsAmount, 500_000, 'sanity: snapshot преди редакция = 500000')
    assertEqual(pending.purchase.vipDays, 30, 'sanity: snapshot преди редакция = 30')
    assertEqual(pending.purchase.priceCents, 999, 'sanity: snapshot преди редакция = 999')

    const sessionId = nextSessionId()
    purchaseStore.attachCheckoutSession(pending.purchase.purchaseId, sessionId)

    // Admin РЕДАКТИРА пакета СЛЕД checkout-а — нови title/coins/vipDays/price.
    const editResult = packageStore.upsertPackage({
      packageId: superPackageId,
      packageKey: '',
      title: 'Супер ПРОМЕНЕН',
      description: 'Нова цена след checkout',
      yellowCoinsAmount: 999_999, // напълно различна стойност
      vipDays: 365,               // напълно различна стойност
      priceCents: 4999,           // напълно различна стойност
      currency: 'EUR',
      status: 'active',
      sortOrder: 10,
    })
    assert(editResult.ok, `admin редакция трябва да успее: ${JSON.stringify(editResult)}`)
    if (editResult.ok) {
      assertEqual(editResult.package.yellowCoinsAmount, 999_999, 'sanity: пакетът реално е редактиран в DB-то')
    }

    const balanceBefore = getWalletBalance(db, 'profile-h0')
    assertEqual(balanceBefore, 0, 'wallet трябва да е 0 преди fulfillment')

    // Stripe плаща СЪЩАТА (стара) цена (999), защото checkout сесията вече
    // е създадена със старата цена — Stripe amount cross-check по-долу
    // трябва да мине по СТАРИЯ snapshot, не по новата 4999 цена.
    const result = purchaseStore.fulfillPaidPurchase({
      checkoutSessionId: sessionId,
      purchaseId: pending.purchase.purchaseId,
      stripePaymentStatus: 'paid',
      stripeCurrency: 'EUR',
      stripeAmountTotalCents: 999, // старата цена, платена реално през Stripe
    })
    assert(result.ok === true, `fulfillment трябва да успее със СТАРИЯ snapshot: ${JSON.stringify(result)}`)

    const balanceAfter = getWalletBalance(db, 'profile-h0')
    console.log(`    [H-trace] wallet: ${balanceBefore} -> ${balanceAfter} (expect +500000, NOT +999999 от новата конфигурация)`)
    assertEqual(balanceAfter, 500_000, 'fulfillment трябва да кредитира СТАРИТЕ 500000 coins, не новите 999999')

    if (result.ok) {
      const daysUntilExpiry = (new Date(result.newActiveUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      console.log(`    [H-trace] VIP days granted: ~${daysUntilExpiry.toFixed(1)} (expect ~30, NOT 365 от новата конфигурация)`)
      assert(daysUntilExpiry > 29.9 && daysUntilExpiry < 30.1, `fulfillment трябва да даде СТАРИТЕ 30 VIP дни, не новите 365, получих ${daysUntilExpiry}`)
    }

    // Ledger реда пази стария snapshot завинаги (purchase history immutability).
    const ledgerRow = db.prepare(`SELECT title_snapshot, yellow_coins_amount, vip_days_snapshot, price_cents FROM bundle_purchase_ledger WHERE purchase_id = ?`)
      .get(pending.purchase.purchaseId) as { title_snapshot: string; yellow_coins_amount: number; vip_days_snapshot: number; price_cents: number }
    assertEqual(ledgerRow.title_snapshot, 'Супер', 'ledger трябва да пази СТАРОТО име, не "Супер ПРОМЕНЕН"')
    assertEqual(ledgerRow.yellow_coins_amount, 500_000, 'ledger snapshot трябва да е старите 500000 coins')
    assertEqual(ledgerRow.vip_days_snapshot, 30, 'ledger snapshot трябва да е старите 30 VIP дни')
    assertEqual(ledgerRow.price_cents, 999, 'ledger snapshot трябва да е старата цена 999')

    // Възстановяваме пакета за останалите checks в тоя suite (defensive, ако редът на checks-овете се промени).
    packageStore.upsertPackage({
      packageId: superPackageId,
      packageKey: '',
      title: 'Супер',
      description: 'Тестов пакет',
      yellowCoinsAmount: 500_000,
      vipDays: 30,
      priceCents: 999,
      currency: 'EUR',
      status: 'active',
      sortOrder: 10,
    })
  })

  packageStore.close()
  purchaseStore.close()
  db.close()
})

console.log('')
console.log(`Passed: ${passed}, Failed: ${failed}`)
process.exit(failed > 0 ? 1 : 0)
