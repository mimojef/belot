// Campaign Credit Store — Фаза 2 на системата "Кампании": начисляване на
// тематични единици от игри/покупки/административни корекции, проверка на
// наградни прагове и СЛУЖЕБНО (платформата финансира, никой друг профил не
// се дебитира) предоставяне на награди (жълтици/VIP дни/подарък от избрания
// marketing профил на кампанията) + durable popup известие.
//
// Транзакционен модел: собствена DatabaseSync connection + busy_timeout
// (mirror на campaignsStore.ts/vipStore.ts/giftItemStore.ts). ЦЯЛОТО
// начисляване + threshold check + reward granting + claim + notification е
// ЕДНА `BEGIN IMMEDIATE` ... `COMMIT` транзакция (viж runInTransaction).
// Критично: НЕ викаме vipStore.grantVip()/giftItemStore.sendGiftItem()/
// missionStore.claimMissionReward() тук — всяка от тях отваря СОБСТВЕНА
// BEGIN/COMMIT върху СОБСТВЕНА connection (доказано при проектирането на
// плана), затова reward-предоставянето по-долу е REIMPLEMENTED inline върху
// ТАЗИ connection, mirror на establishния bundlePurchaseStore.ts паттерн
// ("reimplement локалната логика, не викай друг store отвътре на транзакция").
// VIP calendar math се преизползва чрез чисто импортираната addCalendarInterval
// (pure функция, без DB достъп) от vipStore.ts — не се дублира ръчно.
//
// Служебно финансиране (одобрено бизнес решение, Фаза 2 §1): жълтиците и VIP
// дните идват директно от платформата (просто INSERT/UPDATE, без debit на
// друг профил). Подаръкът се "подарява" от името на кампанийния marketing
// профил (sender_profile_id в gift_item_transactions), но БЕЗ да го дебитира,
// без block-check, без да пипа дневния лимит на yellowCoinGiftStore.ts (тя е
// отделен, несвързан механизъм за coin-gifting, не gift-item catalog
// изпращане) и без да изисква приятелство.
//
// Изчисляване на единиците (§3): caller-ите подават СУРОВИ факти за
// събитието (stakeAmount / packageKey), НЕ готово units количество —
// campaign_earn_rules/campaign_package_earn_rules се четат ТУК, вътре в
// същата транзакция, след резолюция на кампанията (earn rules са per-
// campaign, затова lookup-ът логично следва campaign resolution, не я
// предхожда). Липсваща конфигурация за даден залог/пакет -> 0 единици
// (валидно, преднамерено "admin не е задал ставка", не грешка) — ledger
// редът ВСЕ ПАК се пише (с units_amount=0), за да е retry-идемпотентен.

import { randomUUID } from 'node:crypto'
import { addCalendarInterval, type VipInterval } from '../db/vipStore.js'
import { dbDateToUtc } from '../db/dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type CampaignEventSourceType = 'belot_win' | 'ludo_win' | 'package_purchase' | 'admin_adjustment'

export type CreditGameOrPurchaseEventInput =
  | { profileId: string; sourceType: 'belot_win' | 'ludo_win'; sourceId: string; eventAt: Date; stakeAmount: number }
  | { profileId: string; sourceType: 'package_purchase'; sourceId: string; eventAt: Date; packageKey: string }

export type ManualAdjustmentInput = {
  campaignId: string
  profileId: string
  unitsDelta: number
  reason: string
  adminProfileId: string
}

export type GrantedRewardSummary =
  | { type: 'yellow_coins'; amount: number }
  | { type: 'vip_days'; interval: VipInterval; activeUntil: string }
  | { type: 'gift_item'; giftItemId: string; name: string; imageUrl: string; senderDisplayName: string }

export type SkippedRewardSummary = {
  tierRewardId: string
  rewardType: 'gift_item'
  reason: 'invalid_sender' | 'sender_equals_recipient' | 'gift_item_unavailable'
}

export type CreditCampaignUnitsResult =
  | {
      ok: true
      campaignId: string
      alreadyCredited: boolean
      unitsCredited: number
      unitsTotal: number
      grantedRewards: GrantedRewardSummary[]
      skippedRewards: SkippedRewardSummary[]
    }
  | { ok: false; reason: 'no_eligible_campaign' | 'campaign_already_archived' | 'negative_total_rejected' }

export type CampaignRewardNotificationSnapshot = {
  notificationId: string
  campaignId: string
  status: 'pending' | 'acknowledged'
  payload: unknown
  createdAt: string
  acknowledgedAt: string | null
}

export type AcknowledgeNotificationResult =
  | { ok: true }
  | { ok: false; reason: 'notification_not_found' | 'not_owner' }

export type CampaignCreditStore = {
  creditCampaignUnits: (input: CreditGameOrPurchaseEventInput) => CreditCampaignUnitsResult
  applyManualAdjustment: (input: ManualAdjustmentInput) => CreditCampaignUnitsResult
  getProfileCampaignTotal: (campaignId: string, profileId: string) => number
  listPendingNotifications: (profileId: string) => CampaignRewardNotificationSnapshot[]
  acknowledgeNotification: (notificationId: string, profileId: string) => AcknowledgeNotificationResult
  close: () => void
}

type CampaignRow = {
  campaign_id: string
  name: string
  status: string
  starts_at: string
  ends_at: string
  unit_name_singular: string
  unit_name_plural: string
  gift_sender_profile_id: string | null
  archived_at: string | null
}

type TierRewardDueRow = {
  tier_reward_id: string
  threshold_units: number
  reward_type: string
  reward_payload_json: string
}

function toSqliteDateTimeString(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

class NegativeTotalRejectedError extends Error {
  constructor() {
    super('negative_total_rejected')
  }
}

export async function createCampaignCreditStore(databaseFilePath: string): Promise<CampaignCreditStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  // ─── Campaign resolution (time-window, за game/purchase събития) ───

  const selectCampaignByIdStatement = database.prepare(`
    SELECT campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural,
           gift_sender_profile_id, archived_at
    FROM campaigns
    WHERE campaign_id = ?
    LIMIT 1;
  `)

  const selectCandidateCampaignsStatement = database.prepare(`
    SELECT campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural,
           gift_sender_profile_id, archived_at
    FROM campaigns
    WHERE archived_at IS NULL
      AND status IN ('active', 'finished', 'stopped')
      AND datetime(starts_at) <= datetime(?)
    ORDER BY starts_at DESC;
  `)

  const selectStoppedEventStatement = database.prepare(`
    SELECT created_at FROM campaign_events
    WHERE campaign_id = ? AND event_type = 'campaign_stopped'
    ORDER BY created_at ASC
    LIMIT 1;
  `)

  // "Авторитетен момент на изключването" за ръчно спряна кампания — ends_at
  // продължава да сочи ОРИГИНАЛНО планирания край (Фаза 1 stopCampaign не
  // го пипа), затова не е надеждна граница за елигибилност след ръчно
  // спиране. Самата campaign_stopped audit редица (Фаза 1) вече пази точния
  // момент на спиране надеждно — reuse, вместо нова колона/несигурно
  // предположение (§10 от задачата).
  function getEffectiveWindowEndIso(campaign: CampaignRow): string {
    if (campaign.status !== 'stopped') return campaign.ends_at
    const row = selectStoppedEventStatement.get(campaign.campaign_id) as { created_at: string } | undefined
    return row?.created_at ?? campaign.ends_at
  }

  function resolveCampaignForEvent(
    eventAt: Date,
  ): { ok: true; campaign: CampaignRow } | { ok: false; reason: 'no_eligible_campaign' } {
    const eventAtIso = eventAt.toISOString()
    const candidates = selectCandidateCampaignsStatement.all(eventAtIso) as CampaignRow[]
    for (const candidate of candidates) {
      const effectiveEndIso = getEffectiveWindowEndIso(candidate)
      if (eventAtIso < effectiveEndIso) {
        return { ok: true, campaign: candidate }
      }
    }
    return { ok: false, reason: 'no_eligible_campaign' }
  }

  // ─── Earn-rule lookup (§3 "Изчисляване на тематичните единици") ───

  const selectGameEarnRuleStatement = database.prepare(`
    SELECT units_per_win FROM campaign_earn_rules WHERE campaign_id = ? AND game_kind = ? AND stake_amount = ? LIMIT 1;
  `)

  const selectPackageEarnRuleStatement = database.prepare(`
    SELECT units_per_purchase FROM campaign_package_earn_rules WHERE campaign_id = ? AND package_key = ? LIMIT 1;
  `)

  function resolveUnitsAmountForEvent(campaignId: string, input: CreditGameOrPurchaseEventInput): number {
    if (input.sourceType === 'package_purchase') {
      const row = selectPackageEarnRuleStatement.get(campaignId, input.packageKey) as
        | { units_per_purchase: number }
        | undefined
      return row?.units_per_purchase ?? 0
    }
    const gameKind = input.sourceType === 'belot_win' ? 'belot' : 'ludo'
    const row = selectGameEarnRuleStatement.get(campaignId, gameKind, input.stakeAmount) as
      | { units_per_win: number }
      | undefined
    return row?.units_per_win ?? 0
  }

  // ─── Ledger / totals ───

  const insertLedgerStatement = database.prepare(`
    INSERT OR IGNORE INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at)
    VALUES (?, ?, ?, ?, ?, ?);
  `)

  const selectTotalsStatement = database.prepare(`
    SELECT units_total FROM campaign_profile_totals WHERE campaign_id = ? AND profile_id = ? LIMIT 1;
  `)

  const ensureTotalsRowStatement = database.prepare(`
    INSERT INTO campaign_profile_totals (campaign_id, profile_id, units_total)
    VALUES (?, ?, 0)
    ON CONFLICT(campaign_id, profile_id) DO NOTHING;
  `)

  const updateTotalsStatement = database.prepare(`
    UPDATE campaign_profile_totals
    SET units_total = units_total + ?, updated_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ? AND profile_id = ?;
  `)

  function getProfileCampaignTotalInternal(campaignId: string, profileId: string): number {
    const row = selectTotalsStatement.get(campaignId, profileId) as { units_total: number } | undefined
    return row?.units_total ?? 0
  }

  // ─── Reward granting (reimplemented inline — виж коментара най-отгоре) ───

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 0)
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const creditWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET yellow_coins_balance = yellow_coins_balance + ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  const selectVipStatusStatement = database.prepare(`
    SELECT active_until FROM vip_status WHERE profile_id = ? LIMIT 1;
  `)

  const insertVipGrantStatement = database.prepare(`
    INSERT INTO vip_grants (
      grant_id, profile_id, reason, interval_unit, interval_amount, granted_by_profile_id, resulting_active_until
    ) VALUES (?, ?, 'campaign_reward', ?, ?, NULL, ?);
  `)

  const upsertVipStatusStatement = database.prepare(`
    INSERT INTO vip_status (profile_id, active_until, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until, updated_at = CURRENT_TIMESTAMP;
  `)

  function grantYellowCoinsInline(profileId: string, amount: number): GrantedRewardSummary {
    ensureWalletStatement.run(profileId)
    creditWalletStatement.run(amount, profileId)
    return { type: 'yellow_coins', amount }
  }

  function grantVipDaysInline(profileId: string, interval: VipInterval): GrantedRewardSummary {
    // Mirror на vipStore.ts::applyGrant — текущ active_until (ако е в
    // бъдещето) е базата за удължаване, иначе тръгва от сега. Никаква
    // загуба на вече платено/предоставено VIP време (§6 от задачата).
    const currentRow = selectVipStatusStatement.get(profileId) as { active_until: string } | undefined
    const now = new Date()
    const currentActiveUntil = currentRow ? new Date(dbDateToUtc(currentRow.active_until)) : null
    const extensionBase = currentActiveUntil && currentActiveUntil.getTime() > now.getTime() ? currentActiveUntil : now

    const newActiveUntil = addCalendarInterval(extensionBase, interval)
    const newActiveUntilSqlite = toSqliteDateTimeString(newActiveUntil)

    insertVipGrantStatement.run(randomUUID(), profileId, interval.unit, interval.amount, newActiveUntilSqlite)
    upsertVipStatusStatement.run(profileId, newActiveUntilSqlite)

    return { type: 'vip_days', interval, activeUntil: dbDateToUtc(newActiveUntilSqlite.replace(' ', 'T')) }
  }

  const selectSenderRoleStatement = database.prepare(`
    SELECT a.role AS role FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE p.profile_id = ? LIMIT 1;
  `)

  const selectProfileDisplayNameStatement = database.prepare(`
    SELECT display_name FROM profiles WHERE profile_id = ? LIMIT 1;
  `)

  const selectGiftItemStatement = database.prepare(`
    SELECT gift_item_id, name, image_url, price, is_active, deleted_at FROM gift_items WHERE gift_item_id = ? LIMIT 1;
  `)

  const insertGiftTransactionStatement = database.prepare(`
    INSERT INTO gift_item_transactions (
      transaction_id, gift_item_id, sender_profile_id, recipient_profile_id, charged_price, context, room_id, request_id
    ) VALUES (?, ?, ?, ?, ?, 'campaign_reward', NULL, ?);
  `)

  /**
   * Служебна, безплатна gift-item доставка от marketing подателя на
   * кампанията — reimplement на giftItemStore.sendGiftItem СТРУКТУРАТА, но
   * БЕЗ debit/block-check/приятелство (§7). Никога не заобикаля
   * `CHECK (sender_profile_id <> recipient_profile_id)` — explicit проверка
   * ПРЕДИ INSERT, graceful reason при конфликт, не throw (виж §7:
   * "не маркирай наградата като успешно предоставена, ако доставката е
   * невъзможна", "не го заобикаляй без разрешение").
   */
  function grantCampaignGiftItemInline(
    campaign: CampaignRow,
    recipientProfileId: string,
    giftItemId: string,
  ):
    | { ok: true; summary: GrantedRewardSummary }
    | { ok: false; reason: 'invalid_sender' | 'sender_equals_recipient' | 'gift_item_unavailable' } {
    const giftSenderProfileId = campaign.gift_sender_profile_id
    if (giftSenderProfileId === null) {
      return { ok: false, reason: 'invalid_sender' }
    }

    const senderRoleRow = selectSenderRoleStatement.get(giftSenderProfileId) as { role: string } | undefined
    if (senderRoleRow === undefined || senderRoleRow.role !== 'marketing') {
      return { ok: false, reason: 'invalid_sender' }
    }

    // SQL CHECK (sender_profile_id <> recipient_profile_id) — спазен чрез
    // explicit предварителна проверка, НЕ заобиколен. Ако marketing
    // подателят на кампанията съвпада с получателя на наградата, подаръкът
    // остава незаявен (campaign_reward_claims ред не се пише) — следващо
    // начисление за същия играч ще опита пак (self-healing, ако admin смени
    // подателя), наградата никога не се маркира фалшиво успешна.
    if (giftSenderProfileId === recipientProfileId) {
      return { ok: false, reason: 'sender_equals_recipient' }
    }

    const giftItem = selectGiftItemStatement.get(giftItemId) as
      | { gift_item_id: string; name: string; image_url: string; price: number; is_active: number; deleted_at: string | null }
      | undefined
    if (giftItem === undefined || giftItem.is_active !== 1 || giftItem.deleted_at !== null) {
      return { ok: false, reason: 'gift_item_unavailable' }
    }

    const senderDisplayNameRow = selectProfileDisplayNameStatement.get(giftSenderProfileId) as
      | { display_name: string }
      | undefined
    const senderDisplayName = senderDisplayNameRow?.display_name ?? 'Pika.bg'

    const transactionId = randomUUID()
    // Детерминистичен request_id (campaign+profile+gift) — стабилен при
    // retry; UNIQUE constraint-ът на request_id е допълнителен DB-level
    // backstop (primary idempotency е claim-guard-ът на ниво
    // campaign_reward_claims — threshold loop-ът никога не вика тази
    // функция повторно за вече claim-нат tier_reward).
    const requestId = `campaign:${campaign.campaign_id}:${recipientProfileId}:${giftItemId}`
    insertGiftTransactionStatement.run(
      transactionId,
      giftItem.gift_item_id,
      giftSenderProfileId,
      recipientProfileId,
      giftItem.price,
      requestId,
    )

    return {
      ok: true,
      summary: {
        type: 'gift_item',
        giftItemId: giftItem.gift_item_id,
        name: giftItem.name,
        imageUrl: giftItem.image_url,
        senderDisplayName,
      },
    }
  }

  // ─── Reward tiers due / claims ───

  const selectDueUnclaimedTierRewardsStatement = database.prepare(`
    SELECT ctr.tier_reward_id, crt.threshold_units, ctr.reward_type, ctr.reward_payload_json
    FROM campaign_reward_tiers crt
    JOIN campaign_tier_rewards ctr ON ctr.tier_id = crt.tier_id
    LEFT JOIN campaign_reward_claims crc
      ON crc.campaign_id = crt.campaign_id AND crc.profile_id = ? AND crc.tier_reward_id = ctr.tier_reward_id
    WHERE crt.campaign_id = ? AND crt.threshold_units <= ? AND crc.tier_reward_id IS NULL
    ORDER BY crt.threshold_units ASC;
  `)

  const insertClaimStatement = database.prepare(`
    INSERT INTO campaign_reward_claims (campaign_id, profile_id, tier_reward_id, granted_reward_ref)
    VALUES (?, ?, ?, ?);
  `)

  const insertCampaignEventStatement = database.prepare(`
    INSERT INTO campaign_events (event_id, campaign_id, event_type, actor_profile_id, payload_json)
    VALUES (?, ?, ?, NULL, ?);
  `)

  const insertNotificationStatement = database.prepare(`
    INSERT INTO campaign_reward_notifications (notification_id, campaign_id, profile_id, payload_json)
    VALUES (?, ?, ?, ?);
  `)

  /**
   * Извлича всички due-и-незаявени tier rewards при нов unitsTotal и ги
   * предоставя надеждно в тази (вече отворена) транзакция. Връща списък на
   * реално предоставените + пропуснатите (с причина) — викащата функция
   * решава дали да създаде notification. Никога не хвърля за "очаквани"
   * gift-item проблеми (invalid_sender/sender_equals_recipient/
   * gift_item_unavailable) — те се логват в campaign_events и се пропускат,
   * без да провалят останалите награди от същия threshold batch (§4/§8).
   */
  function grantDueRewardsInCurrentTransaction(
    campaign: CampaignRow,
    profileId: string,
    unitsTotal: number,
  ): { granted: GrantedRewardSummary[]; skipped: SkippedRewardSummary[] } {
    const dueRows = selectDueUnclaimedTierRewardsStatement.all(profileId, campaign.campaign_id, unitsTotal) as TierRewardDueRow[]
    const granted: GrantedRewardSummary[] = []
    const skipped: SkippedRewardSummary[] = []

    for (const row of dueRows) {
      const payload = JSON.parse(row.reward_payload_json) as Record<string, unknown>

      if (row.reward_type === 'yellow_coins') {
        const amount = Number(payload.amount)
        const summary = grantYellowCoinsInline(profileId, amount)
        insertClaimStatement.run(campaign.campaign_id, profileId, row.tier_reward_id, null)
        granted.push(summary)
        continue
      }

      if (row.reward_type === 'vip_days') {
        const interval: VipInterval = { unit: payload.unit as VipInterval['unit'], amount: Number(payload.amount) }
        const summary = grantVipDaysInline(profileId, interval)
        insertClaimStatement.run(campaign.campaign_id, profileId, row.tier_reward_id, null)
        granted.push(summary)
        continue
      }

      // reward_type === 'gift_item'
      const giftItemId = String(payload.giftItemId)
      const result = grantCampaignGiftItemInline(campaign, profileId, giftItemId)
      if (result.ok) {
        insertClaimStatement.run(campaign.campaign_id, profileId, row.tier_reward_id, giftItemId)
        granted.push(result.summary)
      } else {
        skipped.push({ tierRewardId: row.tier_reward_id, rewardType: 'gift_item', reason: result.reason })
        insertCampaignEventStatement.run(
          randomUUID(),
          campaign.campaign_id,
          'campaign_gift_reward_skipped',
          JSON.stringify({ profileId, tierRewardId: row.tier_reward_id, giftItemId, reason: result.reason, actorType: 'system' }),
        )
      }
    }

    return { granted, skipped }
  }

  // ─── Core credit flow (shared by game/purchase events and manual adjustments) ───

  function creditCore(
    campaign: CampaignRow,
    profileId: string,
    sourceType: CampaignEventSourceType,
    sourceId: string,
    unitsAmount: number,
    eventAtIso: string,
  ): CreditCampaignUnitsResult {
    const insertResult = insertLedgerStatement.run(
      campaign.campaign_id,
      profileId,
      sourceType,
      sourceId,
      unitsAmount,
      eventAtIso,
    ) as { changes?: number }

    if ((insertResult.changes ?? 0) === 0) {
      // Вече начислено (natural-key idempotency) — ПЪЛНАТА предходна
      // транзакция (ledger+totals+rewards+notification) вече е commit-ната
      // атомарно при оригиналния опит; replay връща текущия total без
      // повторно изпълнение на наградите (§4: "При повторно извикване върни
      // запазения резултат, без повторно изпълнение на наградите").
      return {
        ok: true,
        campaignId: campaign.campaign_id,
        alreadyCredited: true,
        unitsCredited: 0,
        unitsTotal: getProfileCampaignTotalInternal(campaign.campaign_id, profileId),
        grantedRewards: [],
        skippedRewards: [],
      }
    }

    ensureTotalsRowStatement.run(campaign.campaign_id, profileId)
    updateTotalsStatement.run(unitsAmount, campaign.campaign_id, profileId)
    const unitsTotal = getProfileCampaignTotalInternal(campaign.campaign_id, profileId)

    if (unitsTotal < 0) {
      // Само administrative adjustments могат логически да доведат до
      // отрицателен тотал (игрови/покупкови начисления са винаги >= 0 по
      // earn-rule дизайн) — §11: "Не допускай отрицателен краен общ резултат."
      throw new NegativeTotalRejectedError()
    }

    const { granted, skipped } = grantDueRewardsInCurrentTransaction(campaign, profileId, unitsTotal)

    if (granted.length > 0) {
      insertNotificationStatement.run(
        randomUUID(),
        campaign.campaign_id,
        profileId,
        JSON.stringify({
          campaignName: campaign.name,
          unitNameSingular: campaign.unit_name_singular,
          unitNamePlural: campaign.unit_name_plural,
          unitsTotal,
          rewards: granted,
        }),
      )
    }

    return {
      ok: true,
      campaignId: campaign.campaign_id,
      alreadyCredited: false,
      unitsCredited: unitsAmount,
      unitsTotal,
      grantedRewards: granted,
      skippedRewards: skipped,
    }
  }

  function runInTransaction(fn: () => CreditCampaignUnitsResult): CreditCampaignUnitsResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const result = fn()
      database.exec('COMMIT;')
      return result
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface original error
      }
      if (error instanceof NegativeTotalRejectedError) {
        return { ok: false, reason: 'negative_total_rejected' }
      }
      throw error
    }
  }

  function creditCampaignUnits(input: CreditGameOrPurchaseEventInput): CreditCampaignUnitsResult {
    return runInTransaction(() => {
      const resolved = resolveCampaignForEvent(input.eventAt)
      if (!resolved.ok) return { ok: false, reason: resolved.reason }
      const unitsAmount = resolveUnitsAmountForEvent(resolved.campaign.campaign_id, input)
      return creditCore(resolved.campaign, input.profileId, input.sourceType, input.sourceId, unitsAmount, input.eventAt.toISOString())
    })
  }

  const insertManualAdjustmentStatement = database.prepare(`
    INSERT INTO campaign_manual_adjustments (adjustment_id, campaign_id, profile_id, units_delta, reason, admin_profile_id)
    VALUES (?, ?, ?, ?, ?, ?);
  `)

  function applyManualAdjustment(input: ManualAdjustmentInput): CreditCampaignUnitsResult {
    const adjustmentId = randomUUID()
    return runInTransaction(() => {
      const campaign = selectCampaignByIdStatement.get(input.campaignId) as CampaignRow | undefined
      if (campaign === undefined) return { ok: false, reason: 'no_eligible_campaign' }
      if (campaign.archived_at !== null) return { ok: false, reason: 'campaign_already_archived' }

      insertManualAdjustmentStatement.run(
        adjustmentId,
        input.campaignId,
        input.profileId,
        input.unitsDelta,
        input.reason,
        input.adminProfileId,
      )
      return creditCore(campaign, input.profileId, 'admin_adjustment', adjustmentId, input.unitsDelta, new Date().toISOString())
    })
  }

  // ─── Notifications ───

  const selectPendingNotificationsStatement = database.prepare(`
    SELECT notification_id, campaign_id, status, payload_json, created_at, acknowledged_at
    FROM campaign_reward_notifications
    WHERE profile_id = ? AND status = 'pending'
    ORDER BY created_at ASC;
  `)

  const selectNotificationOwnerStatement = database.prepare(`
    SELECT profile_id, status FROM campaign_reward_notifications WHERE notification_id = ? LIMIT 1;
  `)

  const acknowledgeNotificationStatement = database.prepare(`
    UPDATE campaign_reward_notifications
    SET status = 'acknowledged', acknowledged_at = CURRENT_TIMESTAMP
    WHERE notification_id = ? AND profile_id = ?;
  `)

  function listPendingNotifications(profileId: string): CampaignRewardNotificationSnapshot[] {
    const rows = selectPendingNotificationsStatement.all(profileId) as Array<{
      notification_id: string
      campaign_id: string
      status: string
      payload_json: string
      created_at: string
      acknowledged_at: string | null
    }>
    return rows.map((row) => ({
      notificationId: row.notification_id,
      campaignId: row.campaign_id,
      status: row.status as 'pending' | 'acknowledged',
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
    }))
  }

  function acknowledgeNotification(notificationId: string, profileId: string): AcknowledgeNotificationResult {
    const owner = selectNotificationOwnerStatement.get(notificationId) as { profile_id: string | null; status: string } | undefined
    if (owner === undefined) return { ok: false, reason: 'notification_not_found' }
    if (owner.profile_id !== profileId) return { ok: false, reason: 'not_owner' }
    acknowledgeNotificationStatement.run(notificationId, profileId)
    return { ok: true }
  }

  return {
    creditCampaignUnits,
    applyManualAdjustment,
    getProfileCampaignTotal: getProfileCampaignTotalInternal,
    listPendingNotifications,
    acknowledgeNotification,
    close: () => database.close(),
  }
}
