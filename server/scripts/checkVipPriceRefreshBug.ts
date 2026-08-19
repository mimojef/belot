/**
 * checkVipPriceRefreshBug.ts
 *
 * Regression test за конкретния bug: admin сменя VIP цена от Настройки,
 * Save минава успешно, но Магазин -> VIP продължава да показва старата
 * цена. Root cause беше ЧИСТО client-side: createLobbyFlowController.ts
 * кешираше state.vipPackages завинаги след първо зареждане (guard
 * `vipPackages.length > 0` спираше всеки следващ fetch), и успешен admin
 * save изобщо не инвалидираше този кеш.
 *
 * Server-side end-to-end верига (§6 от брифа):
 * [0] initial VIP180 seed стойност (789/3989/6989 default)
 * [1] admin update VIP180 = 2269 → getSettings() веднага echo-ва 2269
 * [2] admin update VIP365 = 3849 → getSettings() веднага echo-ва 3849
 * [3] "GET /api/vip/packages" симулация (getVipPackagePriceCents-еквивалент
 *       четене): и трите пакета отразяват актуалните settings, НЕ
 *       migration seed defaults
 * [4] createPendingPurchase('vip_180', <актуална цена>) → snapshot = 2269
 * [5] createPendingPurchase('vip_365', <актуална цена>) → snapshot = 3849
 * [6] Втора admin промяна (VIP180 = 2399) СЛЕД като вече има pending
 *       purchase от старата цена (2269) → старият pending ред пази 2269
 *       (price-snapshot semantics, непроменена от bug fix-а), НО нов
 *       createPendingPurchase опит за друг профил веднага чете 2399
 *
 * Client-side source-level проверки (createLobbyFlowController.ts):
 * [7] loadVipPackages() вече НЯМА безусловен "reuse ако вече е заредено"
 *       guard (старият bug: `if (state.vipPackages.length > 0 ...) return`
 *       БЕЗ forceRefresh escape hatch)
 * [8] showShopPanel() вика loadVipPackages(true) в ДВАТА branch-а (early-
 *       return за кеширани coin пакети, и пълния fetch path) — VIP
 *       каталогът се refetch-ва при всяко влизане в Shop screen
 * [9] submitAdminSettings() инвалидира state.vipPackages след успешен save
 *       (defense-in-depth — дори ако Shop screen остане с stale state по
 *       друга причина, следващото влизане ще force-refetch-не)
 * [10] switchShopTab() остава чист локален state switch (без network round-
 *        trip при просто превключване между табове) — брифът explicit
 *        забранява "ненужен global rerender"
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { createVipPurchaseStore, VIP_PACKAGE_CATALOG, type VipPackageId } from '../src/db/vipPurchaseStore.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-vip-price-refresh-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function buildSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

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

// Симулира точно това, което handleVipPackagesRequest/getVipPackagePriceCents
// правят в index.ts — чете АКТУАЛНИТЕ admin settings за всеки пакет, БЕЗ
// никакъв in-memory кеш между извикванията.
function readVipPackagesLikeEndpoint(
  adminSettingsStore: Awaited<ReturnType<typeof createAdminSettingsStore>>,
): Record<VipPackageId, { days: number; priceCents: number }> {
  const settings = adminSettingsStore.getSettings()
  return {
    vip_30: { days: VIP_PACKAGE_CATALOG.vip_30.days, priceCents: settings.vipPrice30DaysCents },
    vip_180: { days: VIP_PACKAGE_CATALOG.vip_180.days, priceCents: settings.vipPrice180DaysCents },
    vip_365: { days: VIP_PACKAGE_CATALOG.vip_365.days, priceCents: settings.vipPrice365DaysCents },
  }
}

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'vip-price-refresh.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildSchema(db)
  seedProfile(db, 'profile-vip180-a')
  seedProfile(db, 'profile-vip180-b')
  seedProfile(db, 'profile-vip365-a')

  // Migration 20260818_006 seed simulation — default стойности, никога не
  // презаписвани при повторно приложение (ON CONFLICT DO NOTHING).
  db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES (?, ?)`).run('vip_price_30_days_cents', '789')
  db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES (?, ?)`).run('vip_price_180_days_cents', '3989')
  db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES (?, ?)`).run('vip_price_365_days_cents', '6989')

  const adminSettingsStore = await createAdminSettingsStore(dbPath)
  const vipPurchaseStore = await createVipPurchaseStore(dbPath)

  await check('[0] Initial seed: VIP180=3989, VIP365=6989 (migration defaults)', () => {
    const packages = readVipPackagesLikeEndpoint(adminSettingsStore)
    assertEqual(packages.vip_180.priceCents, 3_989, 'VIP180 трябва да е seed default 3989')
    assertEqual(packages.vip_365.priceCents, 6_989, 'VIP365 трябва да е seed default 6989')
  })

  await check('[1] Admin update VIP180=2269 → getSettings() веднага echo-ва 2269', () => {
    const result = adminSettingsStore.updateSettings({ vipPrice180DaysCents: 2_269 })
    assert(result.ok === true, `update трябва да успее: ${JSON.stringify(result)}`)
    assertEqual(adminSettingsStore.getSettings().vipPrice180DaysCents, 2_269, 'echo веднага след update')
  })

  await check('[2] Admin update VIP365=3849 → getSettings() веднага echo-ва 3849', () => {
    const result = adminSettingsStore.updateSettings({ vipPrice365DaysCents: 3_849 })
    assert(result.ok === true, `update трябва да успее: ${JSON.stringify(result)}`)
    assertEqual(adminSettingsStore.getSettings().vipPrice365DaysCents, 3_849, 'echo веднага след update')
  })

  await check('[3] "GET /api/vip/packages" симулация → и трите пакета отразяват АКТУАЛНИТЕ settings', () => {
    const packages = readVipPackagesLikeEndpoint(adminSettingsStore)
    assertEqual(packages.vip_30.priceCents, 789, 'VIP30 остава непроменен (789)')
    assertEqual(packages.vip_180.priceCents, 2_269, 'VIP180 трябва да е новата стойност 2269, НЕ stale 3989')
    assertEqual(packages.vip_365.priceCents, 3_849, 'VIP365 трябва да е новата стойност 3849, НЕ stale 6989')
    assertEqual(packages.vip_180.days, 180, 'дните остават server-side constant')
    assertEqual(packages.vip_365.days, 365, 'дните остават server-side constant')
  })

  await check('[4] createPendingPurchase(vip_180, актуална цена) → snapshot = 2269', () => {
    const currentPrice = readVipPackagesLikeEndpoint(adminSettingsStore).vip_180.priceCents
    const result = vipPurchaseStore.createPendingPurchase('profile-vip180-a', 'vip_180', currentPrice)
    assert(result.ok === true, 'pending purchase трябва да успее')
    if (result.ok) {
      assertEqual(result.purchase.priceCents, 2_269, 'checkout snapshot трябва да е новата цена 2269, НЕ stale 3989')
    }
  })

  await check('[5] createPendingPurchase(vip_365, актуална цена) → snapshot = 3849', () => {
    const currentPrice = readVipPackagesLikeEndpoint(adminSettingsStore).vip_365.priceCents
    const result = vipPurchaseStore.createPendingPurchase('profile-vip365-a', 'vip_365', currentPrice)
    assert(result.ok === true, 'pending purchase трябва да успее')
    if (result.ok) {
      assertEqual(result.purchase.priceCents, 3_849, 'checkout snapshot трябва да е новата цена 3849, НЕ stale 6989')
    }
  })

  await check('[6] Втора admin промяна (VIP180=2399) СЛЕД съществуващ pending ред: старият snapshot непроменен, нов checkout чете 2399', () => {
    const oldPendingPurchase = vipPurchaseStore.listProfilePurchases('profile-vip180-a')[0]
    assert(oldPendingPurchase !== undefined, 'трябва да има pending покупка от check [4]')
    assertEqual(oldPendingPurchase.priceCents, 2_269, 'старият pending ред трябва да пази snapshot-натата цена 2269')

    const updateResult = adminSettingsStore.updateSettings({ vipPrice180DaysCents: 2_399 })
    assert(updateResult.ok === true, 'втората admin промяна трябва да успее')

    // Старият ред остава недокоснат от price-snapshot семантиката.
    const oldPendingAfter = vipPurchaseStore.getPurchaseById(oldPendingPurchase.purchaseId)
    assertEqual(oldPendingAfter?.priceCents, 2_269, 'съществуващият pending ред НЕ трябва да се промени от нова admin цена')

    // Нов checkout за ДРУГ профил трябва да чете най-новата цена.
    const newCurrentPrice = readVipPackagesLikeEndpoint(adminSettingsStore).vip_180.priceCents
    assertEqual(newCurrentPrice, 2_399, 'GET packages трябва веднага да отрази 2399')

    const newPending = vipPurchaseStore.createPendingPurchase('profile-vip180-b', 'vip_180', newCurrentPrice)
    assert(newPending.ok === true, 'нов checkout трябва да успее')
    if (newPending.ok) {
      assertEqual(newPending.purchase.priceCents, 2_399, 'нов checkout трябва да snapshot-не новата цена 2399')
    }
  })

  vipPurchaseStore.close()
  adminSettingsStore.close()
  db.close()
})

// ─── Client-side source-level проверки (cache invalidation wiring) ─────────

const projectRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length)
    ?? join(process.cwd(), '..'),
)

const controllerSource = await readFile(
  join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'),
  'utf8',
)

await check('[7] loadVipPackages вече НЯМА безусловен reuse guard (forceRefresh escape hatch присъства)', () => {
  assert(
    controllerSource.includes('async function loadVipPackages(forceRefresh = false): Promise<void> {'),
    'loadVipPackages трябва да приема forceRefresh параметър',
  )
  assert(
    controllerSource.includes('if (!forceRefresh && state.vipPackages.length > 0 && state.vipPackagesErrorText === null) {'),
    'reuse guard трябва да е условен на !forceRefresh, не безусловен',
  )
})

await check('[8] showShopPanel() force-refresh-ва VIP каталога в ДВАТА branch-а', () => {
  const occurrences = controllerSource.split('loadVipPackages(true)').length - 1
  assert(occurrences >= 2, `очаквах поне 2 извиквания на loadVipPackages(true) (early-return branch + пълен fetch branch), намерих ${occurrences}`)
})

await check('[9] submitAdminSettings() инвалидира state.vipPackages след успешен save', () => {
  const submitFnMatch = controllerSource.match(/async function submitAdminSettings\([\s\S]*?\n  \}/)
  assert(submitFnMatch !== null, 'submitAdminSettings функцията трябва да съществува')
  const fnBody = submitFnMatch?.[0] ?? ''
  assert(fnBody.includes('state.vipPackages = []'), 'submitAdminSettings трябва да reset-ва state.vipPackages при успешен save')
})

await check('[10] switchShopTab() остава чист локален state switch (без принудителен network round-trip при просто превключване)', () => {
  const switchFnMatch = controllerSource.match(/function switchShopTab\(tab: 'coins' \| 'vip'\): void \{[\s\S]*?\n  \}/)
  assert(switchFnMatch !== null, 'switchShopTab функцията трябва да съществува')
  const fnBody = switchFnMatch?.[0] ?? ''
  assert(!fnBody.includes('loadVipPackages(true)'), 'switchShopTab НЕ трябва да форсира refresh при обикновено tab превключване (само showShopPanel entry прави force-refresh)')
  assert(fnBody.includes('state.shopActiveTab = tab'), 'tab switch трябва да остане локален state промяна')
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
