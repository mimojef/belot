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
  getReconciliationCursor,
  saveReconciliationCursor,
  resetReconciliationCursor,
  normalizeReconciliationLimit,
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
}): void {
  try {
    if (!isCampaignsFeatureEnabled()) return
    const { campaignCreditStore, payerProfileId, purchaseId, packageKey, creditedAtIso } = deps

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
}

const PURCHASE_LEDGER_CONFIGS: readonly PurchaseLedgerConfig[] = [
  { tableName: 'coin_purchase_ledger', packageKeyColumn: 'package_key_snapshot', cursorSourceType: 'package_purchase_coin' },
  { tableName: 'bundle_purchase_ledger', packageKeyColumn: 'package_key_snapshot', cursorSourceType: 'package_purchase_bundle' },
  { tableName: 'vip_purchase_ledger', packageKeyColumn: 'package_id', cursorSourceType: 'package_purchase_vip' },
]

// tableName/packageKeyColumn идват ИЗКЛЮЧИТЕЛНО от PURCHASE_LEDGER_CONFIGS
// по-горе (hardcoded literals, никога user/caller-supplied свободен текст)
// — безопасно за string interpolation в SQL identifier позиция, SQLite
// няма parameterized identifier binding.
function scanPurchaseLedgerWithCursor(
  database: SqliteDatabase,
  config: PurchaseLedgerConfig,
  limit: number,
): { rows: PendingPurchaseRow[]; cursorWrapped: boolean } {
  const { tableName, packageKeyColumn, cursorSourceType } = config
  const notAlreadyCreditedClause = `
    AND NOT EXISTS (
      SELECT 1 FROM campaign_unit_ledger cul
      WHERE cul.source_type = 'package_purchase'
        AND cul.source_id = t.purchase_id
        AND cul.profile_id = t.profile_id
    )
  `

  const cursor = getReconciliationCursor(database, cursorSourceType)
  let cursorWrapped = false
  let rows: PendingPurchaseRow[]

  if (cursor.eventAt === '') {
    rows = database.prepare(`
      SELECT t.purchase_id AS purchase_id, t.profile_id AS profile_id, t.${packageKeyColumn} AS package_key, t.credited_at AS credited_at
      FROM ${tableName} t
      WHERE t.status = 'paid' AND t.credited_at IS NOT NULL AND t.profile_id IS NOT NULL
      ${notAlreadyCreditedClause}
      ORDER BY t.credited_at ASC, t.purchase_id ASC, t.profile_id ASC
      LIMIT ?;
    `).all(limit) as PendingPurchaseRow[]
  } else {
    rows = database.prepare(`
      SELECT t.purchase_id AS purchase_id, t.profile_id AS profile_id, t.${packageKeyColumn} AS package_key, t.credited_at AS credited_at
      FROM ${tableName} t
      WHERE t.status = 'paid' AND t.credited_at IS NOT NULL AND t.profile_id IS NOT NULL
        AND (
          t.credited_at > ?
          OR (t.credited_at = ? AND t.purchase_id > ?)
          OR (t.credited_at = ? AND t.purchase_id = ? AND t.profile_id > ?)
        )
      ${notAlreadyCreditedClause}
      ORDER BY t.credited_at ASC, t.purchase_id ASC, t.profile_id ASC
      LIMIT ?;
    `).all(cursor.eventAt, cursor.eventAt, cursor.sourceId, cursor.eventAt, cursor.sourceId, cursor.profileId, limit) as PendingPurchaseRow[]

    if (rows.length < limit) {
      const wrappedRows = database.prepare(`
        SELECT t.purchase_id AS purchase_id, t.profile_id AS profile_id, t.${packageKeyColumn} AS package_key, t.credited_at AS credited_at
        FROM ${tableName} t
        WHERE t.status = 'paid' AND t.credited_at IS NOT NULL AND t.profile_id IS NOT NULL
          AND (
            t.credited_at < ?
            OR (t.credited_at = ? AND t.purchase_id < ?)
            OR (t.credited_at = ? AND t.purchase_id = ? AND t.profile_id <= ?)
          )
        ${notAlreadyCreditedClause}
        ORDER BY t.credited_at ASC, t.purchase_id ASC, t.profile_id ASC
        LIMIT ?;
      `).all(cursor.eventAt, cursor.eventAt, cursor.sourceId, cursor.eventAt, cursor.sourceId, cursor.profileId, limit - rows.length) as PendingPurchaseRow[]

      if (wrappedRows.length > 0) {
        cursorWrapped = true
        rows = rows.concat(wrappedRows)
      } else if (rows.length === 0) {
        resetReconciliationCursor(database, cursorSourceType)
      }
    }
  }

  return { rows, cursorWrapped }
}

function scanAndCreditPurchaseLedger(
  database: SqliteDatabase,
  campaignCreditStore: CampaignCreditStore,
  config: PurchaseLedgerConfig,
  limit: number,
): PurchaseLedgerReconciliationResult {
  const result: PurchaseLedgerReconciliationResult = { scanned: 0, credited: 0, failed: 0, cursorWrapped: false }
  const { rows, cursorWrapped } = scanPurchaseLedgerWithCursor(database, config, limit)
  result.cursorWrapped = cursorWrapped

  for (const row of rows) {
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
    } finally {
      saveReconciliationCursor(database, config.cursorSourceType, {
        eventAt: row.credited_at,
        sourceId: row.purchase_id,
        profileId: row.profile_id,
      })
    }
  }

  return result
}

export async function reconcileMissingPurchaseCampaignCredits(
  databaseFilePath: string,
  campaignCreditStore: CampaignCreditStore,
  bounds: { limit?: number } = {},
): Promise<PurchaseCampaignReconciliationResult> {
  const empty: PurchaseLedgerReconciliationResult = { scanned: 0, credited: 0, failed: 0, cursorWrapped: false }
  if (!isCampaignsFeatureEnabled()) return { coin: { ...empty }, bundle: { ...empty }, vip: { ...empty } }

  const limit = normalizeReconciliationLimit(bounds.limit ?? 500)

  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA busy_timeout = 5000;')

  try {
    const [coinConfig, bundleConfig, vipConfig] = PURCHASE_LEDGER_CONFIGS
    const coin = scanAndCreditPurchaseLedger(database, campaignCreditStore, coinConfig!, limit)
    const bundle = scanAndCreditPurchaseLedger(database, campaignCreditStore, bundleConfig!, limit)
    const vip = scanAndCreditPurchaseLedger(database, campaignCreditStore, vipConfig!, limit)
    return { coin, bundle, vip }
  } finally {
    database.close()
  }
}
