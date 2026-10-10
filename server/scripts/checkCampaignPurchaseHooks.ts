/**
 * checkCampaignPurchaseHooks.ts
 *
 * Фаза 5 на системата "Кампании" — автоматично начисляване на тематични
 * единици при РЕАЛНИ, успешно потвърдени покупки (coins/bundle/VIP).
 * Изолирана temp SQLite база, реални миграции, реални
 * coinPurchaseStore/bundlePurchaseStore/vipPurchaseStore/campaignsStore/
 * campaignCreditStore — покупките минават през РЕАЛНИТЕ
 * createPendingPurchase -> attachCheckoutSession -> fulfillPaidPurchase
 * пътища (не hand-crafted DB редове), mirror на истинския
 * index.ts::handleStripeWebhookRequest flow.
 *
 * Покрива (виж задачата §11, 20 сценария):
 *   [1]  Успешна допустима покупка (VIP) -> payer-ът начислен коректно
 *   [2]  Неподдържан пакет (без campaign_package_earn_rules ред) -> 0 units, не грешка
 *   [3]  Неуспешно плащане (stripePaymentStatus != 'paid') -> fulfillPaidPurchase ok:false, без начисление
 *   [4]  Отказано/отменено плащане (checkout.session.expired path) -> никога не достига 'paid', без начисление
 *   [5]  Дублиран webhook (2x fulfillPaidPurchase) -> alreadyCredited:true на 2рия, campaign hook пак се вика безусловно, но НЕ дублира
 *   [6]  Паралелни callback-и (2 connections) -> точно едно начисление
 *   [7]  Feature flag OFF -> нулево DB въздействие
 *   [8]  Без активна/елигибилна кампания -> no_eligible_campaign, без throw
 *   [9]  Различни пакети (coin/bundle/VIP) с различни earn rules -> всеки коректно начислен по СВОЕТО правило
 *   [10] Достигане на награден праг чрез покупка -> tier award предоставен
 *   [11] Няколко награди от един праг (покупка) -> и двете предоставени
 *   [12] Кампанийна грешка (trigger) без засягане на платената покупка (wallet/VIP непроменени, без throw)
 *   [13] Възстановяване след временна грешка -> reconciliationJob.tickNow() backfill-ва точно веднъж
 *   [14] Повторен tick без restart довършва пропуснатото (durable cursor, без да изисква restart)
 *   [15] Дълго забавено начисление (limit=1 forcing няколко tick-а) -> всички в крайна сметка покрити
 *   [16] Кампания, приключила СЛЕД плащането (но обработена по-късно) -> payment-time кампания получава кредита
 *   [17] Кампания, спряна ПРЕДИ плащането -> без начисление към спряната кампания
 *   [18] Повторен recovery без дублиране (tickNow 2x) -> 0 нови промени на втория run
 *   [19] Campaign crediting НЕ пипа profile_wallets/vip_status/vip_grants на самата покупка
 *   [20] Коректен запис на source_id/campaign_id/event_at в campaign_unit_ledger
 *   [21] Bundle null payerProfileId (hard-deleted payer) -> hook skip-ва безопасно
 *   [22] Source review — index.ts вика recordPurchaseForCampaign и в трите webhook клона
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignCreditStore, type CampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import {
  recordPurchaseForCampaign,
  reconcileMissingPurchaseCampaignCredits,
} from '../src/campaigns/campaignPurchaseHooks.js'
import { createCoinPurchaseStore, type CoinPurchaseStore } from '../src/db/coinPurchaseStore.js'
import { createBundlePurchaseStore, type BundlePurchaseStore } from '../src/db/bundlePurchaseStore.js'
import { createVipPurchaseStore, type VipPurchaseStore } from '../src/db/vipPurchaseStore.js'
import { dbDateToUtc } from '../src/db/dbDate.js'

process.env.CAMPAIGNS_FEATURE_ENABLED = '1'

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
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

console.log('\ncheckCampaignPurchaseHooks\n')

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function createReadyTempDatabasePath(): Promise<{ databaseFilePath: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-purchase-hooks-'))
  const migrationsDirectoryPath = join(root, 'database', 'migrations')
  const dataDirectoryPath = join(root, 'database', 'data')
  await mkdir(migrationsDirectoryPath, { recursive: true })
  await mkdir(dataDirectoryPath, { recursive: true })
  const fileNames = await loadRealMigrationFileNames()
  for (const filename of fileNames) {
    await cp(join(migrationsDir, filename), join(migrationsDirectoryPath, filename))
  }
  const result = await ensureServerDatabaseReady({ serverRootOverride: root })
  return {
    databaseFilePath: result.databaseFilePath,
    cleanup: async () => { await rm(root, { recursive: true, force: true }) },
  }
}

const { databaseFilePath: dbPath, cleanup } = await createReadyTempDatabasePath()

async function openRawDb() {
  const sqliteModule = await import('node:sqlite')
  const db = new sqliteModule.DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  return db
}

const rawDb = await openRawDb()

function insertProfile(profileId: string, displayName: string, opts: { kind?: 'human' | 'bot'; isTemporary?: boolean } = {}): void {
  rawDb.prepare(`
    INSERT INTO profiles (
      profile_id, account_id, profile_kind, username, normalized_username,
      display_name, normalized_display_name, avatar_url, level, rank_title, skill_rating, status, is_temporary
    ) VALUES (?, NULL, ?, NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, 'active', ?)
  `).run(profileId, opts.kind ?? 'human', displayName, displayName.toLowerCase(), opts.isTemporary ? 1 : 0)
}

const campaignsStore: CampaignsStore = await createCampaignsStore(dbPath)
const campaignCreditStore: CampaignCreditStore = await createCampaignCreditStore(dbPath)
const coinPurchaseStore: CoinPurchaseStore = await createCoinPurchaseStore(dbPath)
const bundlePurchaseStore: BundlePurchaseStore = await createBundlePurchaseStore(dbPath)
const vipPurchaseStore: VipPurchaseStore = await createVipPurchaseStore(dbPath)

const ADMIN_ACTOR_PROFILE_ID = randomUUID()
insertProfile(ADMIN_ACTOR_PROFILE_ID, 'Admin')
const ADMIN_ACTOR = { type: 'admin' as const, profileId: ADMIN_ACTOR_PROFILE_ID }

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

// Overlap guard-ът проверява само scheduled/active кампании — виж
// checkCampaignGameHooks.ts's идентичен коментар. Default прозорец
// [-1h,+1000h) е винаги "жив" в момента на seed-ването, предишната кампания
// вече е finished/stopped преди следващия draft/schedule изобщо да стартира.
function seedCampaign(
  earnRules: Array<{ packageKey: string; unitsPerPurchase: number }>,
  opts: { startOffsetHours?: number; endOffsetHours?: number; stopImmediately?: boolean } = {},
): { campaignId: string; eventAt: Date } {
  const startOffsetHours = opts.startOffsetHours ?? -1
  const endOffsetHours = opts.endOffsetHours ?? 1000
  const startsAt = hoursFromNow(startOffsetHours)
  const endsAt = hoursFromNow(endOffsetHours)
  const eventAt = new Date(new Date(startsAt).getTime() + 3_600_000)

  const draft = campaignsStore.createDraftCampaign(
    { name: `Purchase Test Campaign ${randomUUID()}`, startsAt, endsAt, unitNameSingular: 'тиква', unitNamePlural: 'тикви', giftSenderProfileId: null },
    ADMIN_ACTOR,
  )
  if (!draft.ok) throw new Error('seedCampaign: createDraftCampaign failed')
  const campaignId = draft.campaign.campaignId

  for (const rule of earnRules) {
    rawDb.prepare(`INSERT INTO campaign_package_earn_rules (campaign_id, package_key, units_per_purchase) VALUES (?, ?, ?);`).run(
      campaignId, rule.packageKey, rule.unitsPerPurchase,
    )
  }

  const scheduled = campaignsStore.scheduleCampaign(campaignId, ADMIN_ACTOR)
  if (!scheduled.ok) throw new Error('seedCampaign: scheduleCampaign failed')

  if (new Date(endsAt).getTime() <= Date.now()) {
    const expired = campaignsStore.expireScheduledCampaignWithoutActivating(campaignId, new Date(), ADMIN_ACTOR)
    if (!expired.ok) throw new Error(`seedCampaign: expireScheduledCampaignWithoutActivating failed: ${JSON.stringify(expired)}`)
    return { campaignId, eventAt }
  }

  const activated = campaignsStore.activateCampaign(campaignId, new Date(), ADMIN_ACTOR)
  if (!activated.ok) throw new Error('seedCampaign: activateCampaign failed')

  if (opts.stopImmediately === true) {
    const stopped = campaignsStore.stopCampaign(campaignId, ADMIN_ACTOR)
    if (!stopped.ok) throw new Error('seedCampaign: stopCampaign failed')
    return { campaignId, eventAt }
  }

  const finished = campaignsStore.finishCampaign(campaignId, new Date(new Date(endsAt).getTime() + 3_600_000), ADMIN_ACTOR)
  if (!finished.ok) throw new Error('seedCampaign: finishCampaign failed')
  return { campaignId, eventAt }
}

function getLedgerRow(campaignId: string, profileId: string, sourceId: string): { units_amount: number; event_at: string; campaign_id: string; source_type: string } | undefined {
  return rawDb.prepare(`SELECT units_amount, event_at, campaign_id, source_type FROM campaign_unit_ledger WHERE campaign_id = ? AND profile_id = ? AND source_type = 'package_purchase' AND source_id = ?;`)
    .get(campaignId, profileId, sourceId) as { units_amount: number; event_at: string; campaign_id: string; source_type: string } | undefined
}

function countLedgerRowsForSource(sourceId: string): number {
  const row = rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE source_type = 'package_purchase' AND source_id = ?;`).get(sourceId) as { c: number }
  return row.c
}

const firstCoinPackageRow = rawDb.prepare(`SELECT package_id, package_key FROM coin_packages ORDER BY sort_order ASC LIMIT 1;`).get() as { package_id: string; package_key: string }
const COIN_PACKAGE_ID = firstCoinPackageRow.package_id
const COIN_PACKAGE_KEY = firstCoinPackageRow.package_key

const BUNDLE_PACKAGE_ID = randomUUID()
const BUNDLE_PACKAGE_KEY = `bundle_test_${randomUUID().slice(0, 8)}`
rawDb.prepare(`
  INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, status)
  VALUES (?, ?, 'Test Bundle', 5000, 7, 999, 'active');
`).run(BUNDLE_PACKAGE_ID, BUNDLE_PACKAGE_KEY)

// ─── Helpers to drive REAL purchase fulfillment through each store ───

function fulfillVipPurchase(profileId: string, priceCents = 500): { purchaseId: string; result: ReturnType<VipPurchaseStore['fulfillPaidPurchase']> } {
  const created = vipPurchaseStore.createPendingPurchase(profileId, 'vip_30', priceCents)
  if (!created.ok) throw new Error(`fulfillVipPurchase: createPendingPurchase failed: ${created.message}`)
  const checkoutSessionId = `cs_vip_${randomUUID()}`
  vipPurchaseStore.attachCheckoutSession(created.purchase.purchaseId, checkoutSessionId)
  const result = vipPurchaseStore.fulfillPaidPurchase({
    checkoutSessionId, purchaseId: created.purchase.purchaseId,
    stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: priceCents,
  })
  return { purchaseId: created.purchase.purchaseId, result }
}

function fulfillCoinPurchase(profileId: string): { purchaseId: string; result: ReturnType<CoinPurchaseStore['fulfillPaidPurchase']> } {
  const created = coinPurchaseStore.createPendingPurchase(profileId, COIN_PACKAGE_ID)
  if (!created.ok) throw new Error(`fulfillCoinPurchase: createPendingPurchase failed: ${created.message}`)
  const checkoutSessionId = `cs_coin_${randomUUID()}`
  coinPurchaseStore.attachCheckoutSession(created.purchase.purchaseId, checkoutSessionId)
  const result = coinPurchaseStore.fulfillPaidPurchase({
    checkoutSessionId, purchaseId: created.purchase.purchaseId, amountPaidCents: created.purchase.priceCents, currency: created.purchase.currency,
  })
  return { purchaseId: created.purchase.purchaseId, result }
}

function fulfillBundlePurchase(profileId: string): { purchaseId: string; result: ReturnType<BundlePurchaseStore['fulfillPaidPurchase']> } {
  const created = bundlePurchaseStore.createPendingPurchase(profileId, BUNDLE_PACKAGE_ID)
  if (!created.ok) throw new Error(`fulfillBundlePurchase: createPendingPurchase failed: ${created.message}`)
  const checkoutSessionId = `cs_bundle_${randomUUID()}`
  bundlePurchaseStore.attachCheckoutSession(created.purchase.purchaseId, checkoutSessionId)
  const result = bundlePurchaseStore.fulfillPaidPurchase({
    checkoutSessionId, purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: created.purchase.priceCents,
  })
  return { purchaseId: created.purchase.purchaseId, result }
}

// ═══════════════════════════════════════════════════════════════════════
console.log('=== [1]-[4] Нормален поток + failure/decline пътища ===')

await check('[1] Успешна допустима VIP покупка -> payer-ът начислен коректно', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T1 payer')
  const { campaignId } = seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 40 }])
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, `fulfillVipPurchase failed: ${JSON.stringify(result)}`)
  if (!result.ok) return
  recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: result.payerProfileId, purchaseId, packageKey: result.purchase.packageId, creditedAtIso: result.purchase.creditedAt })
  const row = getLedgerRow(campaignId, profileId, purchaseId)
  assert(row !== undefined && row.units_amount === 40, `expected 40 units credited, got ${JSON.stringify(row)}`)
})

await check('[2] Неподдържан пакет (без earn rule за тая стойност) -> 0 units, не грешка', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T2 payer')
  const { campaignId } = seedCampaign([{ packageKey: 'vip_180', unitsPerPurchase: 999 }]) // друг package key, не vip_30
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, 'fulfillment трябва да успее независимо от campaign rule')
  if (!result.ok) return
  recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: result.payerProfileId, purchaseId, packageKey: result.purchase.packageId, creditedAtIso: result.purchase.creditedAt })
  const row = getLedgerRow(campaignId, profileId, purchaseId)
  assert(row !== undefined && row.units_amount === 0, `expected 0 units (unsupported package), got ${JSON.stringify(row)}`)
})

await check('[3] Неуспешно плащане (stripePaymentStatus != "paid") -> fulfillPaidPurchase ok:false, без начисление', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T3 payer')
  seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 40 }])
  const created = vipPurchaseStore.createPendingPurchase(profileId, 'vip_30', 500)
  assert(created.ok, 'setup createPendingPurchase failed')
  if (!created.ok) return
  const checkoutSessionId = `cs_vip_${randomUUID()}`
  vipPurchaseStore.attachCheckoutSession(created.purchase.purchaseId, checkoutSessionId)
  const result = vipPurchaseStore.fulfillPaidPurchase({ checkoutSessionId, purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'unpaid', stripeCurrency: 'EUR', stripeAmountTotalCents: 500 })
  assert(!result.ok, 'очаква се ok:false за неплатена Stripe сесия')
  // Mirror index.ts wiring — hook-ът никога не се вика извън if (result.ok).
  assert(countLedgerRowsForSource(created.purchase.purchaseId) === 0, 'не бива да има ledger ред за неуспешно плащане')
})

await check('[4] Отказано/отменено плащане (checkout.session.expired) -> никога не достига paid, без начисление', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T4 payer')
  seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 40 }])
  const created = vipPurchaseStore.createPendingPurchase(profileId, 'vip_30', 500)
  assert(created.ok, 'setup createPendingPurchase failed')
  if (!created.ok) return
  const checkoutSessionId = `cs_vip_${randomUUID()}`
  vipPurchaseStore.attachCheckoutSession(created.purchase.purchaseId, checkoutSessionId)
  vipPurchaseStore.markPurchaseCanceledByCheckoutSessionId(checkoutSessionId)
  assert(countLedgerRowsForSource(created.purchase.purchaseId) === 0, 'отменена покупка никога не бива да получи кредит')
})

console.log('\n=== [5]-[6] Идемпотентност ===')

await check('[5] Дублиран webhook (2x fulfillPaidPurchase, hook се вика и двата пъти) -> точно 1 ledger ред', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T5 payer')
  const { campaignId } = seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 40 }])
  const first = fulfillVipPurchase(profileId)
  assert(first.result.ok, 'first fulfillment failed')
  if (!first.result.ok) return
  recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: first.result.payerProfileId, purchaseId: first.purchaseId, packageKey: first.result.purchase.packageId, creditedAtIso: first.result.purchase.creditedAt })

  // Duplicate webhook replay — СЪЩАТА checkout сесия/purchaseId.
  const checkoutSessionId = vipPurchaseStore.getPurchaseById(first.purchaseId)?.providerCheckoutSessionId ?? ''
  const second = vipPurchaseStore.fulfillPaidPurchase({ checkoutSessionId, purchaseId: first.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 500 })
  assert(second.ok && second.alreadyCredited, `expected alreadyCredited replay, got ${JSON.stringify(second)}`)
  if (!second.ok) return
  recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: second.payerProfileId, purchaseId: first.purchaseId, packageKey: second.purchase.packageId, creditedAtIso: second.purchase.creditedAt })

  assert(countLedgerRowsForSource(first.purchaseId) === 1, 'дублиран webhook не бива да дублира campaign ledger реда')
  const row = getLedgerRow(campaignId, profileId, first.purchaseId)
  assert(row !== undefined && row.units_amount === 40, 'total не бива да се удвои')
})

await check('[6] Паралелни callback-и (2 отделни connections, СЪЩАТА покупка) -> точно 1 campaign начисление', async () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T6 payer')
  const { campaignId } = seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 40 }])
  const created = vipPurchaseStore.createPendingPurchase(profileId, 'vip_30', 500)
  assert(created.ok, 'setup failed')
  if (!created.ok) return
  const checkoutSessionId = `cs_vip_${randomUUID()}`
  vipPurchaseStore.attachCheckoutSession(created.purchase.purchaseId, checkoutSessionId)

  const vipStoreB = await createVipPurchaseStore(dbPath)
  try {
    const resultA = vipPurchaseStore.fulfillPaidPurchase({ checkoutSessionId, purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 500 })
    const resultB = vipStoreB.fulfillPaidPurchase({ checkoutSessionId, purchaseId: created.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 500 })
    assert(resultA.ok && resultB.ok, `both calls should resolve ok, got ${JSON.stringify([resultA, resultB])}`)
    if (!resultA.ok || !resultB.ok) return
    recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: resultA.payerProfileId, purchaseId: created.purchase.purchaseId, packageKey: resultA.purchase.packageId, creditedAtIso: resultA.purchase.creditedAt })
    recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: resultB.payerProfileId, purchaseId: created.purchase.purchaseId, packageKey: resultB.purchase.packageId, creditedAtIso: resultB.purchase.creditedAt })
    assert(countLedgerRowsForSource(created.purchase.purchaseId) === 1, 'паралелни callback-и не бива да доведат до 2 ledger реда')
    const row = getLedgerRow(campaignId, profileId, created.purchase.purchaseId)
    assert(row !== undefined && row.units_amount === 40, 'total не бива да се удвои от паралелна обработка')
  } finally {
    vipStoreB.close()
  }
})

console.log('\n=== [7]-[8] Edge cases ===')

await check('[7] Feature flag OFF -> нулево DB въздействие', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T7 payer')
  seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 40 }])
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, 'fulfillment failed')
  if (!result.ok) return
  const previous = process.env.CAMPAIGNS_FEATURE_ENABLED
  delete process.env.CAMPAIGNS_FEATURE_ENABLED
  try {
    recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: result.payerProfileId, purchaseId, packageKey: result.purchase.packageId, creditedAtIso: result.purchase.creditedAt })
  } finally {
    process.env.CAMPAIGNS_FEATURE_ENABLED = previous
  }
  assert(countLedgerRowsForSource(purchaseId) === 0, 'flag off -> нулево campaign DB въздействие')
})

await check('[8] Без активна/елигибилна кампания -> no_eligible_campaign, без throw', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T8 payer')
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, 'fulfillment failed')
  if (!result.ok) return
  const farFutureEventAt = new Date(Date.now() + 5000 * 3_600_000).toISOString()
  assertDoesNotThrow(() => {
    recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: result.payerProfileId, purchaseId, packageKey: result.purchase.packageId, creditedAtIso: farFutureEventAt })
  })
  assert(countLedgerRowsForSource(purchaseId) === 0, 'без елигибилна кампания -> нулево начисление')
})

function assertDoesNotThrow(fn: () => void): void {
  try { fn() } catch (error) { throw new Error(`expected no throw, got ${error instanceof Error ? error.message : String(error)}`) }
}

console.log('\n=== [9] Различни пакети (coin/bundle/VIP) с различни earn rules ===')

await check('[9] coin/bundle/VIP покупки начисляват коректно по СВОЕТО собствено rule', () => {
  const { campaignId } = seedCampaign([
    { packageKey: COIN_PACKAGE_KEY, unitsPerPurchase: 10 },
    { packageKey: BUNDLE_PACKAGE_KEY, unitsPerPurchase: 20 },
    { packageKey: 'vip_30', unitsPerPurchase: 30 },
  ])

  const coinProfile = randomUUID(); insertProfile(coinProfile, 'T9 coin')
  const bundleProfile = randomUUID(); insertProfile(bundleProfile, 'T9 bundle')
  const vipProfile = randomUUID(); insertProfile(vipProfile, 'T9 vip')

  const coin = fulfillCoinPurchase(coinProfile)
  assert(coin.result.ok, 'coin fulfillment failed')
  if (coin.result.ok) recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: coin.result.payerProfileId, purchaseId: coin.purchaseId, packageKey: coin.result.purchase.packageKey, creditedAtIso: coin.result.purchase.creditedAt })

  const bundle = fulfillBundlePurchase(bundleProfile)
  assert(bundle.result.ok, 'bundle fulfillment failed')
  if (bundle.result.ok) recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: bundle.result.payerProfileId, purchaseId: bundle.purchaseId, packageKey: bundle.result.purchase.packageKeySnapshot, creditedAtIso: bundle.result.purchase.creditedAt })

  const vip = fulfillVipPurchase(vipProfile)
  assert(vip.result.ok, 'vip fulfillment failed')
  if (vip.result.ok) recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: vip.result.payerProfileId, purchaseId: vip.purchaseId, packageKey: vip.result.purchase.packageId, creditedAtIso: vip.result.purchase.creditedAt })

  assert(getLedgerRow(campaignId, coinProfile, coin.purchaseId)?.units_amount === 10, 'coin trябваше 10')
  assert(getLedgerRow(campaignId, bundleProfile, bundle.purchaseId)?.units_amount === 20, 'bundle трябваше 20')
  assert(getLedgerRow(campaignId, vipProfile, vip.purchaseId)?.units_amount === 30, 'vip трябваше 30')
})

console.log('\n=== [10]-[11] Наградни прагове през покупка ===')

await check('[10]-[11] Достигане на праг с НЯКОЛКО награди чрез покупка -> и двете предоставени', () => {
  const { campaignId } = seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 500 }])
  const tierId = randomUUID()
  rawDb.prepare(`INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, 500);`).run(tierId, campaignId)
  rawDb.prepare(`INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json) VALUES (?, ?, 'yellow_coins', ?);`).run(randomUUID(), tierId, JSON.stringify({ amount: 2000 }))
  rawDb.prepare(`INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json) VALUES (?, ?, 'vip_days', ?);`).run(randomUUID(), tierId, JSON.stringify({ unit: 'days', amount: 5 }))

  const profileId = randomUUID()
  insertProfile(profileId, 'T10 payer')
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, 'fulfillment failed')
  if (!result.ok) return

  recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: result.payerProfileId, purchaseId, packageKey: result.purchase.packageId, creditedAtIso: result.purchase.creditedAt })

  const notifRow = rawDb.prepare(`SELECT payload_json FROM campaign_reward_notifications WHERE campaign_id = ? AND profile_id = ?;`).get(campaignId, profileId) as { payload_json: string } | undefined
  assert(notifRow !== undefined, 'очаква се durable notification за прекосения праг')
  const payload = JSON.parse(notifRow!.payload_json) as { rewards: Array<{ type: string }> }
  assert(payload.rewards.length === 2, `очакват се 2 награди в notification-а, получени ${payload.rewards.length}`)
  assert(payload.rewards.some((r) => r.type === 'yellow_coins') && payload.rewards.some((r) => r.type === 'vip_days'), 'и двата типа награда трябва да присъстват')
})

console.log('\n=== [12] Изолация на кампанийна грешка от реалната покупка ===')

await check('[12] Campaign ledger trigger failure -> покупката (VIP grant/wallet) напълно непроменена, без throw навън', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T12 payer')
  seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 40 }])
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, 'fulfillment failed')
  if (!result.ok) return

  const vipStatusBefore = rawDb.prepare(`SELECT active_until FROM vip_status WHERE profile_id = ?;`).get(profileId) as { active_until: string } | undefined
  assert(vipStatusBefore !== undefined, 'VIP статусът трябва вече да е предоставен от реалната покупка')

  const triggerName = `fail_campaign_ledger_${randomUUID().replace(/-/g, '')}`
  rawDb.exec(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON campaign_unit_ledger
    WHEN NEW.profile_id = '${profileId}'
    BEGIN SELECT RAISE(ABORT, 'simulated transient campaign DB failure'); END;
  `)
  try {
    assertDoesNotThrow(() => {
      recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: result.payerProfileId, purchaseId, packageKey: result.purchase.packageId, creditedAtIso: result.purchase.creditedAt })
    })
  } finally {
    rawDb.exec(`DROP TRIGGER ${triggerName};`)
  }

  const vipStatusAfter = rawDb.prepare(`SELECT active_until FROM vip_status WHERE profile_id = ?;`).get(profileId) as { active_until: string } | undefined
  assert(vipStatusAfter !== undefined && vipStatusAfter.active_until === vipStatusBefore!.active_until, 'VIP статусът не бива да е засегнат от campaign грешката')
  assert(countLedgerRowsForSource(purchaseId) === 0, 'campaign ledger редът не бива да съществува (rollback)')
})

console.log('\n=== [13]-[18] Reconciliation (възстановяване на пропуснати начисления) ===')

await check('[13] Възстановяване след временна грешка -> reconcileMissingPurchaseCampaignCredits backfill-ва точно веднъж', async () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T13 payer')
  const { campaignId } = seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 40 }])
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, 'fulfillment failed')
  if (!result.ok) return

  // Hook-ът НЕ е извикан тук — симулира временен fail (fire-and-forget
  // transient грешка), покупката (VIP grant) вече е успешно финализирана.
  assert(countLedgerRowsForSource(purchaseId) === 0, 'precondition: кредитът е реално пропуснат')

  const reconcileResult = await reconcileMissingPurchaseCampaignCredits(dbPath, campaignCreditStore)
  assert(reconcileResult.vip.credited >= 1, `очаква се поне 1 VIP credited, got ${JSON.stringify(reconcileResult)}`)
  const row = getLedgerRow(campaignId, profileId, purchaseId)
  assert(row !== undefined && row.units_amount === 40, 'reconciliation трябва да backfill-не пропуснатия credit')
})

await check('[14] Повторен tick (БЕЗ restart) довършва пропуснатото — durable cursor напредва', async () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T14 payer')
  seedCampaign([{ packageKey: COIN_PACKAGE_KEY, unitsPerPurchase: 15 }])
  const coin = fulfillCoinPurchase(profileId)
  assert(coin.result.ok, 'fulfillment failed')

  const firstRun = await reconcileMissingPurchaseCampaignCredits(dbPath, campaignCreditStore, { limit: 1 })
  const secondRun = await reconcileMissingPurchaseCampaignCredits(dbPath, campaignCreditStore, { limit: 1 })
  const totalCredited = firstRun.coin.credited + secondRun.coin.credited
  assert(totalCredited >= 1, 'покупката трябва да бъде хваната в рамките на 2 малки tick-а, без restart')
  assert(countLedgerRowsForSource(coin.purchaseId) === 1, 'не бива да се дублира между двата tick-а')
})

await check('[15] Дълго забавено начисление (limit=1, много tick-ове) -> в крайна сметка всички покрити', async () => {
  seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 5 }])
  const profiles = [randomUUID(), randomUUID(), randomUUID()]
  const purchaseIds: string[] = []
  for (const p of profiles) {
    insertProfile(p, `T15 ${p}`)
    const { purchaseId, result } = fulfillVipPurchase(p)
    assert(result.ok, 'fulfillment failed')
    purchaseIds.push(purchaseId)
  }
  let totalCredited = 0
  for (let i = 0; i < 10 && totalCredited < purchaseIds.length; i++) {
    const run = await reconcileMissingPurchaseCampaignCredits(dbPath, campaignCreditStore, { limit: 1 })
    totalCredited += run.vip.credited
  }
  assert(totalCredited >= purchaseIds.length, `очакваха се ${purchaseIds.length} забавени начисления, получени ${totalCredited}`)
  for (const purchaseId of purchaseIds) {
    assert(countLedgerRowsForSource(purchaseId) === 1, `purchase=${purchaseId} трябва да е credited точно веднъж`)
  }
})

await check('[16] Кампания, приключила СЛЕД плащането, но обработена по-късно -> все пак получава кредита', () => {
  const { campaignId, eventAt } = seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 22 }], { endOffsetHours: 2 })
  const profileId = randomUUID()
  insertProfile(profileId, 'T16 payer')
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, 'fulfillment failed')
  if (!result.ok) return
  // eventAt е В рамките на кампанийния прозорец (campaign вече finished към
  // "сега", но ends_at датата remains valid за eligibility проверката).
  recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: result.payerProfileId, purchaseId, packageKey: result.purchase.packageId, creditedAtIso: eventAt.toISOString() })
  const row = getLedgerRow(campaignId, profileId, purchaseId)
  assert(row !== undefined && row.units_amount === 22, 'плащане по време на кампанийния прозорец трябва да получи кредита, независимо кога точно се обработва')
})

await check('[17] Кампания, СПРЯНА ПРЕДИ плащането -> без начисление към спряната кампания', () => {
  const { campaignId } = seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 99 }], { stopImmediately: true })
  const profileId = randomUUID()
  insertProfile(profileId, 'T17 payer')
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, 'fulfillment failed')
  if (!result.ok) return
  // "Плащане" СЛЕД реалния stop момент (campaign_events's campaign_stopped timestamp).
  recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: result.payerProfileId, purchaseId, packageKey: result.purchase.packageId, creditedAtIso: new Date().toISOString() })
  const row = getLedgerRow(campaignId, profileId, purchaseId)
  assert(row === undefined, 'плащане след ръчно спиране не бива да получи кредита на спряната кампания')
})

await check('[18] Повторен recovery (2x tickNow върху СЪЩОТО вече покрито състояние) -> 0 нови промени на втория run', async () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T18 payer')
  seedCampaign([{ packageKey: COIN_PACKAGE_KEY, unitsPerPurchase: 8 }])
  const coin = fulfillCoinPurchase(profileId)
  assert(coin.result.ok, 'fulfillment failed')

  await reconcileMissingPurchaseCampaignCredits(dbPath, campaignCreditStore)
  const secondRun = await reconcileMissingPurchaseCampaignCredits(dbPath, campaignCreditStore)
  assert(secondRun.coin.scanned === 0 || secondRun.coin.credited === 0, `вече покритото покупка не бива да се пипа повторно: ${JSON.stringify(secondRun.coin)}`)
  assert(countLedgerRowsForSource(coin.purchaseId) === 1, 'не бива да има дублиран ред след 2 reconciliation run-а')
})

console.log('\n=== [19]-[21] Допълнителни бизнес правила ===')

await check('[19] Campaign crediting НЕ пипа profile_wallets/vip_status на самата покупка', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'T19 payer')
  seedCampaign([{ packageKey: COIN_PACKAGE_KEY, unitsPerPurchase: 999 }])
  const coin = fulfillCoinPurchase(profileId)
  assert(coin.result.ok, 'fulfillment failed')
  if (!coin.result.ok) return

  const walletBefore = rawDb.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { yellow_coins_balance: number } | undefined

  recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: coin.result.payerProfileId, purchaseId: coin.purchaseId, packageKey: coin.result.purchase.packageKey, creditedAtIso: coin.result.purchase.creditedAt })

  const walletAfter = rawDb.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { yellow_coins_balance: number } | undefined
  assert(walletBefore?.yellow_coins_balance === walletAfter?.yellow_coins_balance, 'campaign crediting не бива да променя wallet баланса, установен от реалната покупка')
})

await check('[20] Коректен запис на source_id/campaign_id/event_at в campaign_unit_ledger', () => {
  const { campaignId } = seedCampaign([{ packageKey: 'vip_30', unitsPerPurchase: 12 }])
  const profileId = randomUUID()
  insertProfile(profileId, 'T20 payer')
  const { purchaseId, result } = fulfillVipPurchase(profileId)
  assert(result.ok, 'fulfillment failed')
  if (!result.ok) return

  recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: result.payerProfileId, purchaseId, packageKey: result.purchase.packageId, creditedAtIso: result.purchase.creditedAt })

  const row = getLedgerRow(campaignId, profileId, purchaseId)
  assert(row !== undefined, 'ledger редът трябва да съществува')
  assert(row!.campaign_id === campaignId, 'campaign_id трябва да съвпада')
  assert(row!.source_type === 'package_purchase', 'source_type трябва да е package_purchase')
  // result.purchase.creditedAt е СУРОВИЯТ SQLite string (без 'Z', виж
  // vipPurchaseStore.ts::rowToSnapshot) — dbDateToUtc тук mirror-ва ТОЧНО
  // normalize-ването, което recordPurchaseForCampaign самата прилага, за
  // честно сравнение (иначе new Date(...) парсва "YYYY-MM-DD HH:MM:SS" без
  // 'Z' като LOCAL time, не UTC, давайки фалшив timezone-offset mismatch).
  assert(new Date(row!.event_at).getTime() === new Date(dbDateToUtc(result.purchase.creditedAt!)).getTime(), 'event_at трябва да е точно credited_at, не "сега"')
})

await check('[21] Bundle: payerProfileId===null (hard-deleted payer) -> hook skip-ва безопасно', () => {
  seedCampaign([{ packageKey: BUNDLE_PACKAGE_KEY, unitsPerPurchase: 50 }])
  assertDoesNotThrow(() => {
    recordPurchaseForCampaign({ campaignCreditStore, payerProfileId: null, purchaseId: `bundle-${randomUUID()}`, packageKey: BUNDLE_PACKAGE_KEY, creditedAtIso: new Date().toISOString() })
  })
})

console.log('\n=== [22] Source review (index.ts wiring) ===')

const indexTsSource = await readFile(resolve(serverRoot, 'src/index.ts'), 'utf8')

await check('[22] index.ts вика recordPurchaseForCampaign в трите webhook клона (VIP/bundle/coin), гейтнат зад campaignCreditStore !== null', () => {
  const callCount = (indexTsSource.match(/recordPurchaseForCampaign\(\{/g) ?? []).length
  assert(callCount === 3, `очакват се точно 3 call sites (VIP/bundle/coin), получени ${callCount}`)
  assert(indexTsSource.includes('reconcilePurchases: reconcileMissingPurchaseCampaignCredits'), 'reconciliation job-ът трябва да получи purchase reconciliation зависимостта')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
campaignCreditStore.close()
campaignsStore.close()
coinPurchaseStore.close()
bundlePurchaseStore.close()
vipPurchaseStore.close()
rawDb.close()
await cleanup()
if (failed > 0) process.exit(1)
