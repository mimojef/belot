// Фаза 5 на системата "Кампании": автоматично начисляване на тематични
// единици при РЕАЛНИ, успешно потвърдени покупки (coins/bundle/VIP).
// Mirror архитектурно на campaignGameHooks.ts (Белот/Ludo победи) — виж
// doc коментарите там за пълния design rationale, тук само специфичното за
// покупките:
//
// - Единственият authoritative "успешна покупка" момент е
//   coin_purchase_ledger/bundle_purchase_ledger/vip_purchase_ledger
//   `status='paid' AND credited_at IS NOT NULL` — записан ВЪТРЕ в
//   съответния store's ЕДНА atomic fulfillPaidPurchase() транзакция (виж
//   index.ts::handleStripeWebhookRequest). Тая транзакция вече е COMMIT-read
//   ПРЕДИ recordPurchaseForCampaign() въобще да се извика — campaign
//   начислението никога не участва в/не може да отмени/блокира реалния
//   paid-settlement (§5 от задачата: "кампанийна грешка никога не трябва да
//   отменя или поврежда реалната покупка").
// - "Кой получава тематичните единици" = ПЛАТЕЦА (payerProfileId от
//   fulfillPaidPurchase резултата), НЕ gift получателя — покупка-за-подарък
//   си остава payer-driven engagement с кампанията (payer-ят е похарчил
//   реалните пари), mirror на съществуващото "наградата отива на
//   recipient-а, но ledger/stats attribution-ът остава на payer-а" дизайн
//   principle, вече established в тия 3 store-а за ДРУГИ цели.
// - packageKey е РЕАЛНАТА, вече съществуваща стойност за всеки тип покупка
//   (coin_purchase_ledger.package_key_snapshot /
//   bundle_purchase_ledger.package_key_snapshot / VipPackageId constant
//   'vip_30'|'vip_180'|'vip_365') — НИКОГА измислена тук, виж
//   campaignAdminStore.ts's listPurchasePackages() (Фаза 5 добавка за VIP).
// - payerProfileId може да е `null` САМО за bundle покупки (20260923_004 —
//   payer hard-deleted след покупката, FK ON DELETE SET NULL) — hook-ът
//   просто skip-ва (никой за начисляване), consistent с recordBelotMatchForCampaign-ия
//   null-profileId handling.

import { dbDateToUtc } from '../db/dbDate.js'
import { isCampaignsFeatureEnabled } from './campaignsFeatureFlag.js'
import type { CampaignCreditStore } from './campaignCreditStore.js'
import {
  createReconciliationPageSelector,
  normalizeReconciliationLimit,
  openReconciliationDatabase,
  reconciliationEventWindowClause,
  resolveReconciliationPaging,
  runBoundedReconciliationScan,
  type ReconciliationEventWindow,
  type ReconciliationRowSource,
  type ReconciliationSliceController,
  type ReconciliationSourceType,
} from './campaignGameHooks.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

/**
 * Извиква се ОТ ВЪТРЕ в index.ts::handleStripeWebhookRequest, СЛЕД
 * coinPurchaseStore/bundlePurchaseStore/vipPurchaseStore.fulfillPaidPurchase
 * (т.е. СЛЕД като реалната покупка вече е commit-read успешно — виж doc
 * коментара отгоре). Вика се БЕЗУСЛОВНО и при alreadyCredited:true replay
 * (webhook retry) — campaignCreditStore.creditCampaignUnits е idempotent
 * по natural key (campaign_id, profile_id, source_type, source_id), затова
 * повторен опит за СЪЩАТА вече-начислена покупка е безопасен no-op, не
 * изисква caller-ът да прескача сам duplicate webhook-и.
 */
export function recordPurchaseForCampaign(deps: {
  campaignCreditStore: CampaignCreditStore
  payerProfileId: string | null
  purchaseId: string
  packageKey: string
  creditedAtIso: string | null
  /** Фаза 9 — виж doc коментара на recordBelotMatchForCampaign-ия еднакъв параметър в campaignGameHooks.ts. */
  onRewardNotification?: (profileId: string, notification: import('./campaignCreditStore.js').CampaignRewardNotificationForPush) => void
}): void {
  try {
    if (!isCampaignsFeatureEnabled()) return
    const { campaignCreditStore, payerProfileId, purchaseId, packageKey, creditedAtIso, onRewardNotification } = deps

    if (payerProfileId === null) return

    if (creditedAtIso === null) {
      console.error(
        `[campaign-purchase-hooks] purchase=${purchaseId} missing credited_at — skipping campaign credit (insufficient info, not defaulting to now)`,
      )
      return
    }

    const result = campaignCreditStore.creditCampaignUnits({
      profileId: payerProfileId,
      sourceType: 'package_purchase',
      sourceId: purchaseId,
      eventAt: new Date(dbDateToUtc(creditedAtIso)),
      packageKey,
    })

    if (!result.ok && result.reason !== 'no_eligible_campaign' && result.reason !== 'ineligible_profile') {
      console.error(
        `[campaign-purchase-hooks] purchase campaign credit failed purchaseId=${purchaseId} profile=${payerProfileId} reason=${result.reason}`,
      )
    }

    if (result.ok && result.notification !== null) {
      onRewardNotification?.(payerProfileId, result.notification)
    }
  } catch (error) {
    console.error('[campaign-purchase-hooks] unexpected error crediting purchase', error)
  }
}

// ─── Reconciliation (§7 "Възстановяване на пропуснати начисления") ───
//
// Разширява СЪЩИЯ durable-cursor механизъм като Белот/Ludo
// (campaignGameHooks.ts::reconcileMissingBelotCampaignCredits) — "Проучи
// дали вече съществуващият кампаниен reconciliation механизъм може
// безопасно да бъде използван или разширен. Не създавай втори независим и
// противоречив механизъм" (Фаза 5 §7). Трите purchase ledger таблици самите
// СА вече durable source of truth (за разлика от Белот, тук НЕ е нужна
// отделна "history" таблица — ledger редовете никога не се трият,
// status='paid' AND credited_at IS NOT NULL е authoritative факт),
// затова cursor-ът напредва директно по (credited_at, purchase_id,
// profile_id) ред, mirror на Белот/Ludo-ия (completed_at/finished_at,
// room_id/match_id, profile_id) ordering.
export type PurchaseLedgerReconciliationResult = {
  scanned: number
  credited: number
  failed: number
  cursorWrapped: boolean
}

export type PurchaseCampaignReconciliationResult = {
  coin: PurchaseLedgerReconciliationResult
  bundle: PurchaseLedgerReconciliationResult
  vip: PurchaseLedgerReconciliationResult
}

type PendingPurchaseRow = {
  purchase_id: string
  profile_id: string
  package_key: string
  credited_at: string
}

type PurchaseLedgerConfig = {
  tableName: 'coin_purchase_ledger' | 'bundle_purchase_ledger' | 'vip_purchase_ledger'
  packageKeyColumn: 'package_key_snapshot' | 'package_id'
  cursorSourceType: ReconciliationSourceType
  rowSource: ReconciliationRowSource
}

const PURCHASE_LEDGER_CONFIGS: readonly PurchaseLedgerConfig[] = [
  { tableName: 'coin_purchase_ledger', packageKeyColumn: 'package_key_snapshot', cursorSourceType: 'package_purchase_coin', rowSource: 'coin' },
  { tableName: 'bundle_purchase_ledger', packageKeyColumn: 'package_key_snapshot', cursorSourceType: 'package_purchase_bundle', rowSource: 'bundle' },
  { tableName: 'vip_purchase_ledger', packageKeyColumn: 'package_id', cursorSourceType: 'package_purchase_vip', rowSource: 'vip' },
]

/**
 * Етап 2 — същите разширения като ReconciliationBounds в campaignGameHooks.ts:
 * eventWindow (филтър по прозореца върху credited_at) и slicer (порции).
 * И двете са optional — без тях поведението е досегашното.
 */
export type PurchaseReconciliationBounds = {
  limit?: number
  eventWindow?: ReconciliationEventWindow
  slicer?: ReconciliationSliceController
  pageSize?: number
  maxExaminedRows?: number
}

// tableName/packageKeyColumn идват ИЗКЛЮЧИТЕЛНО от PURCHASE_LEDGER_CONFIGS
// по-горе (hardcoded literals, никога user/caller-supplied свободен текст)
// — безопасно за string interpolation в SQL identifier позиция, SQLite
// няма parameterized identifier binding.
//
// Етап 2: страница с ограничен брой прегледани редове (виж
// campaignGameHooks.ts::runBoundedReconciliationScan) — същият общ алгоритъм
// като Belot/Ludo. Cursor условието е row value (credited_at, purchase_id,
// profile_id) — семантично като предишната OR форма (трите колони са NOT
// NULL/филтрирани), seek по idx_*_purchase_ledger_campaign_reconciliation.
// "Вече начислено" е флаг needs_credit, не WHERE; (A) филтър по прозореца
// върху credited_at.
type PendingPurchasePageRow = PendingPurchaseRow & { needs_credit: number }

const PURCHASE_AFTER_CURSOR_SQL = `
        AND (t.credited_at, t.purchase_id, t.profile_id) > (?, ?, ?)`
const PURCHASE_THROUGH_CURSOR_SQL = `
        AND (t.credited_at, t.purchase_id, t.profile_id) <= (?, ?, ?)`

async function scanAndCreditPurchaseLedger(
  database: SqliteDatabase,
  campaignCreditStore: CampaignCreditStore,
  config: PurchaseLedgerConfig,
  limit: number,
  bounds: PurchaseReconciliationBounds,
): Promise<PurchaseLedgerReconciliationResult> {
  const result: PurchaseLedgerReconciliationResult = { scanned: 0, credited: 0, failed: 0, cursorWrapped: false }
  const { tableName, packageKeyColumn } = config
  const purchaseWindow = reconciliationEventWindowClause('t.credited_at', bounds.eventWindow)
  const selectPage = createReconciliationPageSelector<PendingPurchasePageRow>(database, (hasLower, hasUpper) => `
      SELECT t.purchase_id AS purchase_id, t.profile_id AS profile_id, t.${packageKeyColumn} AS package_key, t.credited_at AS credited_at,
             CASE WHEN NOT EXISTS (
               SELECT 1 FROM campaign_unit_ledger cul
               WHERE cul.source_type = 'package_purchase'
                 AND cul.source_id = t.purchase_id
                 AND cul.profile_id = t.profile_id
             ) THEN 1 ELSE 0 END AS needs_credit
      FROM ${tableName} t
      WHERE t.status = 'paid' AND t.credited_at IS NOT NULL AND t.profile_id IS NOT NULL${purchaseWindow.sql}${hasLower ? PURCHASE_AFTER_CURSOR_SQL : ''}${hasUpper ? PURCHASE_THROUGH_CURSOR_SQL : ''}
      ORDER BY t.credited_at ASC, t.purchase_id ASC, t.profile_id ASC
      LIMIT ?;
    `, purchaseWindow.params)

  const processRow = (row: PendingPurchaseRow): void => {
    result.scanned += 1

    try {
      const creditResult = campaignCreditStore.creditCampaignUnits({
        profileId: row.profile_id,
        sourceType: 'package_purchase',
        sourceId: row.purchase_id,
        eventAt: new Date(dbDateToUtc(row.credited_at)),
        packageKey: row.package_key,
      })

      if (creditResult.ok) {
        result.credited += 1
      } else if (creditResult.reason !== 'no_eligible_campaign' && creditResult.reason !== 'ineligible_profile') {
        console.error(
          `[campaign-purchase-hooks] reconciliation (${config.tableName}) credit failed purchaseId=${row.purchase_id} profile=${row.profile_id} reason=${creditResult.reason}`,
        )
      }
    } catch (error) {
      result.failed += 1
      console.error(
        `[campaign-purchase-hooks] reconciliation (${config.tableName}) unexpected failure purchaseId=${row.purchase_id} profile=${row.profile_id}`,
        error,
      )
    }
  }

  const scanResult = await runBoundedReconciliationScan<PendingPurchasePageRow>({
    database,
    slicer: bounds.slicer,
    rowSource: config.rowSource,
    cursorSourceType: config.cursorSourceType,
    limit,
    ...resolveReconciliationPaging(bounds),
    selectPage,
    keyOf: (row) => ({ eventAt: row.credited_at, sourceId: row.purchase_id, profileId: row.profile_id }),
    needsCredit: (row) => row.needs_credit === 1,
    processRow,
  })
  result.cursorWrapped = scanResult.cursorWrapped

  return result
}

export async function reconcileMissingPurchaseCampaignCredits(
  databaseFilePath: string,
  campaignCreditStore: CampaignCreditStore,
  bounds: PurchaseReconciliationBounds = {},
): Promise<PurchaseCampaignReconciliationResult> {
  const empty: PurchaseLedgerReconciliationResult = { scanned: 0, credited: 0, failed: 0, cursorWrapped: false }
  if (!isCampaignsFeatureEnabled()) return { coin: { ...empty }, bundle: { ...empty }, vip: { ...empty } }

  const limit = normalizeReconciliationLimit(bounds.limit ?? 500)
  const { slicer } = bounds

  const database = await openReconciliationDatabase(databaseFilePath, slicer)

  try {
    const [coinConfig, bundleConfig, vipConfig] = PURCHASE_LEDGER_CONFIGS
    // stop()/shutdown по време на пауза -> следващите ledger-и не започват
    // (cursor-ите на вече обработените са записани).
    const coin = await scanAndCreditPurchaseLedger(database, campaignCreditStore, coinConfig!, limit, bounds)
    if (slicer?.isAborted() === true) return { coin, bundle: { ...empty }, vip: { ...empty } }
    await slicer?.checkpoint()
    const bundle = await scanAndCreditPurchaseLedger(database, campaignCreditStore, bundleConfig!, limit, bounds)
    if (slicer?.isAborted() === true) return { coin, bundle, vip: { ...empty } }
    await slicer?.checkpoint()
    const vip = await scanAndCreditPurchaseLedger(database, campaignCreditStore, vipConfig!, limit, bounds)
    return { coin, bundle, vip }
  } finally {
    database.close()
  }
}
