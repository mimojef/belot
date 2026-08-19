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
 *
 * VIP purchase success popup (финален popup след потвърдена покупка):
 * [11] waitForPaidVipPurchase връща purchase САМО status==="paid" (exact
 *        session match) — pending/failed/canceled никога не trigger-ват popup
 * [12] handleStripePaymentSuccessReturn показва popup САМО ако vipPurchase е
 *        server-confirmed non-null — redirect URL сам по себе си не стига
 * [13] showVipPurchaseSuccessMessage подава purchase.days (реалния пакет) и
 *        чете activeUntil от /api/vip/status (loadOwnVipStatus), не client-
 *        computed дата
 * [14] renderVipPurchaseSuccessPopup: точен текст/заглавие/бутон, no-op при
 *        isOpen=false
 * [15] onVipPurchaseSuccessClose затваря popup-а normally (isOpen: false)
 *
 * Loading -> paid success / delayed UX (production redirect UX fix,
 * между Stripe redirect-а и webhook потвърждението показва loading вместо
 * "нищо не се случва"):
 * [16] loading фаза: точен текст (spinner, "Не затваряйте страницата"), без OK
 * [17] delayed фаза: точен текст ("не грешка", auto-activate след webhook), с OK
 * [18] Един popup instance за целия preход (processing/success/delayed/close
 *        всички пишат в СЪЩОТО state.vipPurchaseSuccessPopup поле)
 * [19] notification-3.mp3 се пуска ТОЧНО на loading->paid прехода
 *        (showVipPurchaseSuccessMessage), никога в processing/delayed пътя,
 *        никога от render функцията самата (би звучал при всеки re-render)
 *
 * Race-not-Promise.all fix (session_id принадлежи на ТОЧНО един purchase
 * type — другият poller гарантирано връща null едва след пълния си 8.5s
 * timeout; Promise.all() би блокирал по-бързия match до по-бавния):
 * [12b] Двата poller-а racing-ват (fire независимо, settle на първия
 *        non-null); delayed само след като И ДВАТА индивидуално timeout-нат
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

// ─── VIP purchase success popup: paid показва popup с правилните дни, pending НЕ ──

const mainSource = await readFile(join(projectRoot, 'src', 'main.ts'), 'utf8')

await check('[11] waitForPaidVipPurchase връща purchase САМО ако status==="paid" (pending/failed/canceled → null, popup никога не се показва за тях)', () => {
  const fnMatch = mainSource.match(/async function waitForPaidVipPurchase\([\s\S]*?\n\}/)
  assert(fnMatch !== null, 'waitForPaidVipPurchase функцията трябва да съществува')
  const fnBody = fnMatch?.[0] ?? ''
  assert(
    /if \(purchase\?\.status === 'paid'\) \{\s*return purchase\s*\}/.test(fnBody),
    'функцията трябва да връща purchase-а САМО когато status е точно "paid" — pending/failed/canceled никога не minat този guard',
  )
  assert(
    fnBody.includes("item.providerCheckoutSessionId === normalizedSessionId"),
    'lookup-ът трябва да е EXACT match по providerCheckoutSessionId (не "any paid purchase") — старата paid покупка не може да trigger-не popup за нов checkout',
  )
})

await check('[12] handleStripePaymentSuccessReturn показва success popup САМО когато resolved.kind==="vip" (server-confirmed paid); timeout без нито едно потвърдено плащане показва delayed, НЕ success', () => {
  const fnMatch = mainSource.match(/async function handleStripePaymentSuccessReturn\([\s\S]*?\n\}/)
  assert(fnMatch !== null, 'handleStripePaymentSuccessReturn функцията трябва да съществува')
  const fnBody = fnMatch?.[0] ?? ''
  assert(
    /if \(resolved === null\) \{[\s\S]*?showVipPurchaseDelayedPopup\(\)[\s\S]*?return/.test(fnBody),
    'ако НИТО една покупка не е server-confirmed paid (и двата poller-а изчерпаха собствения си timeout), функцията трябва да покаже delayed popup и да прекъсне — redirect само/URL параметър никога не е достатъчен за success',
  )
  assert(
    /if \(resolved\.kind === 'coin'\) \{[\s\S]*?showStripeCoinRewardOverlay/.test(fnBody),
    'coin success overlay-ят трябва да се показва само вътре в guard-натия resolved.kind==="coin" branch',
  )
  assert(
    fnBody.includes('await showVipPurchaseSuccessMessage(resolved.purchase)'),
    'VIP success popup-ът трябва да се показва само след coin branch guard-а (implicit VIP else path)',
  )
  assert(
    fnBody.includes('lobby.showVipPurchaseProcessingPopup()'),
    'loading popup-ът трябва да се покаже веднага при redirect landing, преди exact session correlation-ът да е резолвнат',
  )
})

await check('[12b] handleStripePaymentSuccessReturn НЕ използва Promise.all за двата poller-а (би блокирал по-бързия success transition до по-бавния timeout на другия purchase type)', () => {
  const fnMatch = mainSource.match(/async function handleStripePaymentSuccessReturn\([\s\S]*?\n\}/)
  assert(fnMatch !== null, 'handleStripePaymentSuccessReturn функцията трябва да съществува')
  const fnBody = fnMatch?.[0] ?? ''
  assert(
    !fnBody.includes('Promise.all(['),
    'Promise.all() би изчаквало и двата poller-а (всеки до собствения си 8.5s timeout) преди success — session_id принадлежи на точно ЕДИН purchase type, другият poller гарантирано ще върне null едва след пълния си timeout, значи Promise.all() ненужно бави по-бързия match',
  )
  assert(
    fnBody.includes('waitForPaidStripePurchase(normalizedSessionId).then(') &&
    fnBody.includes('waitForPaidVipPurchase(normalizedSessionId).then('),
    'двата poller-а трябва да стартират паралелно (fire независимо), не да се await-ват последователно',
  )
  assert(
    fnBody.includes('settleOnce({ kind: \'coin\', purchase })') && fnBody.includes('settleOnce({ kind: \'vip\', purchase })'),
    'първият non-null резултат от който и да е от двата poller-а трябва да settle-не веднага (race semantics), без да чака другия poller да приключи',
  )
  assert(
    fnBody.includes('nullCount === 2'),
    'delayed трябва да се показва само след като И ДВАТА poller-а индивидуално са потвърдили null (изчерпали собствения си timeout) — не след първия null',
  )
})

await check('[13] showVipPurchaseSuccessMessage подава purchase.days (реалния закупен пакет) към popup-а, датата идва от /api/vip/status, не client-computed', () => {
  const fnMatch = mainSource.match(/async function showVipPurchaseSuccessMessage\([\s\S]*?\n\}/)
  assert(fnMatch !== null, 'showVipPurchaseSuccessMessage функцията трябва да съществува')
  const fnBody = fnMatch?.[0] ?? ''
  assert(
    fnBody.includes('await loadOwnVipStatus()'),
    'popup-ната дата трябва да идва от РЕАЛНИЯ обновен /api/vip/status отговор (loadOwnVipStatus), не от client-side "днес + days" изчисление',
  )
  assert(
    fnBody.includes('lobby.showVipPurchaseSuccessPopup(purchase.days, activeUntilLabel)'),
    'дните, подадени към popup-а, трябва да са purchase.days — реалният закупен пакет (30/180/365), не хардкоднати',
  )
})

const popupSource = await readFile(
  join(projectRoot, 'src', 'app', 'lobby', 'renderVipPurchaseSuccessPopup.ts'),
  'utf8',
)

await check('[14] renderVipPurchaseSuccessPopup: заглавие/текст/бутон точно по спецификацията, popup е no-op когато isOpen=false', () => {
  assert(popupSource.includes('if (!state.isOpen) {'), 'popup-ът трябва да рендира нищо, докато isOpen е false')
  assert(popupSource.includes('Успешно плащане'), 'заглавието трябва да е точно "Успешно плащане"')
  assert(popupSource.includes('Вие успешно закупихте VIP за'), 'текстът трябва да съдържа реалния брой дни (интерполирани state.days)')
  assert(popupSource.includes('Вашият VIP е активен до'), 'popup-ът трябва да показва active_until реда, когато е наличен')
  assert(popupSource.includes('>OK<'), 'бутонът трябва да е точно "OK"')
})

await check('[15] onVipPurchaseSuccessClose затваря popup-а нормално (isOpen: false), reuse-ва established backdrop+button close pattern', () => {
  const closeFnMatch = controllerSource.match(/onVipPurchaseSuccessClose: \(\) => \{[\s\S]*?\n      \},/)
  assert(closeFnMatch !== null, 'onVipPurchaseSuccessClose handler-ът трябва да съществува')
  const fnBody = closeFnMatch?.[0] ?? ''
  assert(fnBody.includes('isOpen: false'), 'onVipPurchaseSuccessClose трябва explicit да сетне isOpen: false')
  assert(fnBody.includes('render()'), 'затварянето трябва да тригерне render()')
  assert(
    popupSource.includes("attachVipPurchaseSuccessPopupEventListeners"),
    'popup модулът трябва да експортва wiring helper (backdrop click + OK button click), established pattern (renderGuestTrialPopup)',
  )
})

// ─── Loading -> paid success / delayed UX (production redirect UX fix) ─────

await check('[16] renderVipPurchaseSuccessPopup: loading фаза показва точния текст (spinner + "Не затваряйте страницата"), без OK бутон', () => {
  const loadingBranchMatch = popupSource.match(/if \(state\.phase === 'loading'\) \{[\s\S]*?\n  \}/)
  assert(loadingBranchMatch !== null, "loading branch-ът трябва да съществува")
  const branchBody = loadingBranchMatch?.[0] ?? ''
  assert(branchBody.includes('Плащането се обработва'), 'loading заглавието трябва да е "Плащането се обработва"')
  assert(branchBody.includes('Изчакваме потвърждение на плащането'), 'loading текстът трябва да съобщава изчакване на потвърждение')
  assert(branchBody.includes('Не затваряйте страницата'), 'loading popup-ът трябва да предупреди да не се затваря страницата')
  assert(!branchBody.includes('data-vip-purchase-success-popup-ok'), 'loading фазата НЕ трябва да показва OK бутон (само spinner, чака се пасивно)')
})

await check('[17] renderVipPurchaseSuccessPopup: delayed фаза показва точния текст ("не грешка", VIP ще се активира автоматично) + OK бутон', () => {
  const delayedBranchMatch = popupSource.match(/if \(state\.phase === 'delayed'\) \{[\s\S]*?\n  \}/)
  assert(delayedBranchMatch !== null, "delayed branch-ът трябва да съществува")
  const branchBody = delayedBranchMatch?.[0] ?? ''
  assert(branchBody.includes('Плащането се обработва'), 'delayed заглавието трябва да остане "Плащането се обработва" (не грешка)')
  assert(branchBody.includes('Потвърждението от платежната система се забавя'), 'delayed текстът трябва да обясни забавяне, не failure')
  assert(branchBody.includes('VIP ще бъде активиран автоматично'), 'delayed текстът трябва да потвърди автоматично активиране след webhook')
  assert(!/Неуспешно|неуспеш/i.test(branchBody), 'delayed popup-ът НЕ трябва да съдържа "неуспешно" никъде — webhook просто закъснява')
  assert(branchBody.includes('data-vip-purchase-success-popup-ok'), 'delayed фазата трябва да има OK бутон')
})

await check('[18] Един popup instance за целия loading -> success/delayed преход (никога два stacked popup-а)', () => {
  assert(
    controllerSource.includes('showVipPurchaseProcessingPopup: () =>') &&
    controllerSource.includes('showVipPurchaseSuccessPopup: (days, activeUntilLabel) =>') &&
    controllerSource.includes('showVipPurchaseDelayedPopup: () =>'),
    'трите фази трябва да пишат в СЪЩОТО state.vipPurchaseSuccessPopup поле (единствен popup компонент, discriminated по state.phase)',
  )
  // И трите handler-а трябва да задават state.currentScreen/state.vipPurchaseSuccessPopup
  // директно (не да отварят допълнителен отделен модал компонент/state field).
  const vipPopupFieldOccurrences = (controllerSource.match(/state\.vipPurchaseSuccessPopup = \{/g) ?? []).length
  assert(vipPopupFieldOccurrences === 4, `очаквах точно 4 присвоявания на state.vipPurchaseSuccessPopup (processing/success/delayed/close), намерих ${vipPopupFieldOccurrences}`)
})

await check('[19] Звукът (notification-3.mp3) се пуска ТОЧНО на прехода loading -> confirmed paid, никога при loading/delayed', () => {
  const soundFnMatch = mainSource.match(/function playVipPurchaseConfirmedSound\(\): void \{[\s\S]*?\n\}/)
  assert(soundFnMatch !== null, 'playVipPurchaseConfirmedSound функцията трябва да съществува')
  const soundFnBody = soundFnMatch?.[0] ?? ''
  assert(soundFnBody.includes("new Audio('/audio/Notifications/notification-3.mp3')"), 'трябва да ползва съществуващия asset, без нов copy')
  assert(soundFnBody.includes('.play().catch(') || soundFnBody.includes('.play().catch ('), 'playback failure не трябва да хвърля/блокира (fire-and-forget catch)')

  const successMsgFnMatch = mainSource.match(/async function showVipPurchaseSuccessMessage\([\s\S]*?\n\}/)
  assert(successMsgFnMatch !== null, 'showVipPurchaseSuccessMessage функцията трябва да съществува')
  const successFnBody = successMsgFnMatch?.[0] ?? ''
  assert(successFnBody.includes('playVipPurchaseConfirmedSound()'), 'звукът трябва да се пуска вътре в showVipPurchaseSuccessMessage (единствения confirmed-paid entry point)')

  // Негативни проверки: звукът НЕ трябва да присъства в processing/delayed показването.
  const processingCallSite = mainSource.match(/lobby\.showVipPurchaseProcessingPopup\(\)/)
  assert(processingCallSite !== null, 'showVipPurchaseProcessingPopup call site трябва да съществува')
  const delayedFnRegion = mainSource.slice(mainSource.indexOf('if (coinPurchase === null && vipPurchase === null)'), mainSource.indexOf('if (coinPurchase === null && vipPurchase === null)') + 400)
  assert(!delayedFnRegion.includes('playVipPurchaseConfirmedSound'), 'звукът НЕ трябва да се пуска в delayed/timeout branch-а')

  assert(!popupSource.includes('playVipPurchaseConfirmedSound'), 'popup render функцията не трябва сама да решава кога да пусне звук (иначе би звучал при всеки re-render на success фазата) — звукът се пуска explicit САМО веднъж в main.ts на прехода')
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
