// Campaign Archive Store — Фаза 11: окончателен архив на приключили/спрени
// кампании (замразена обобщена статистика + Топ 10), reconciliation-gated
// архивиране, и read-only изгледи за admin "Приключили кампании" екрана.
//
// Транзакционен модел: собствена DatabaseSync connection + busy_timeout
// (mirror на campaignsStore.ts/campaignCreditStore.ts/campaignAdminStore.ts).
// archiveCampaign() е ЕДНА `BEGIN IMMEDIATE` ... `COMMIT` транзакция —
// write lock-ът гарантира, че никакво конкурентно creditCampaignUnits()
// извикване не може да вмъкне нов campaign_unit_ledger/campaign_reward_claims
// ред за тая кампания между readiness recheck-а и самия INSERT в
// campaign_archive_summary/campaign_archive_top10 (задачата §5: "При
// промяна между проверката и самото архивиране трябва да има
// транзакционна защита срещу състезание с кредитиращите операции").
//
// "Reconciliation complete" тук е ЦЕЛЕНАСОЧЕНА, campaign-scoped проверка
// (виж checkCampaignArchivalReadiness) — НЕ извод от текущата позиция на
// глобалните durable cursor-и в campaign_credit_reconciliation_state
// (campaignGameHooks.ts). Причина: тия cursor-и напредват монотонно през
// ВСЕ РАСТЯЩИ таблици (нови мачове/покупки продължават да се случват и
// след края на тая кампания) — "cursor >= campaign.endsAt" НИТО е
// необходимо (cursor-ът може изобщо да не е напреднал, защото fast-path
// hook-ът вече е credit-нал всичко навреме, без backlog), НИТО достатъчно
// (cursor-ът може да е далеко напред, докато ТАЗИ кампания все пак има
// изолиран пропуск, напр. от insufficient-stake-info skip). Директна,
// per-campaign "има ли ОЩЕ ред в тоя времеви прозорец, който не е вече в
// campaign_unit_ledger" проверка е единствения безопасен начин да се
// гарантира §4's "безопасен механизъм за достигане до край на приложимите
// записи".
//
// §4 изрично: "Непрочетените поздравителни известия сами по себе си не
// трябва да блокират архивирането" — campaign_reward_notifications
// (pending/acknowledged) НЕ участва в readiness проверката по-долу,
// умишлено. "Непредоставените дължими награди... трябва да бъдат изрично
// отчетени и разрешени" — campaignCreditStore.listPendingGiftRewardGaps()
// (вече съществуващ, Фаза 2 корекция) Е включена, реюзната, не дублирана.

import { randomUUID } from 'node:crypto'
import type { CampaignActionActor, CampaignId } from './campaignsStore.js'
import type { CampaignCreditStore } from './campaignCreditStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type CampaignArchivalReadiness = {
  pendingBelotWin: number
  pendingBelotLegacy: number
  pendingLudoWin: number
  pendingPurchaseCoin: number
  pendingPurchaseBundle: number
  pendingPurchaseVip: number
  pendingGiftRewardGaps: number
}

function readinessIsClear(readiness: CampaignArchivalReadiness): boolean {
  return (
    readiness.pendingBelotWin === 0 &&
    readiness.pendingBelotLegacy === 0 &&
    readiness.pendingLudoWin === 0 &&
    readiness.pendingPurchaseCoin === 0 &&
    readiness.pendingPurchaseBundle === 0 &&
    readiness.pendingPurchaseVip === 0 &&
    readiness.pendingGiftRewardGaps === 0
  )
}

export type CampaignArchiveSummary = {
  campaignId: CampaignId
  endedReason: 'expired' | 'stopped'
  participantsCount: number
  totalUnits: number
  unitsFromBelot: number
  unitsFromLudo: number
  unitsFromPurchases: number
  unitsFromAdminAdjustments: number
  rewardsGrantedCount: number
  unitIconUrlAtArchive: string | null
  archivedAt: string
}

export type CampaignArchiveTop10Entry = {
  rank: number
  profileId: string | null
  displayNameAtArchive: string
  rankTitleAtArchive: string | null
  unitsTotal: number
}

export type CampaignArchiveDetail = {
  campaignId: CampaignId
  name: string
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  summary: CampaignArchiveSummary
  top10: CampaignArchiveTop10Entry[]
}

/** Admin "Приключили кампании" списък — покрива архивирани И finished/stopped-но-още-неархивирани (§7: "Покажи ясно ако кампанията... все още очаква reconciliation или архивиране"). */
export type AdminFinishedCampaignListRow = {
  campaignId: CampaignId
  name: string
  status: 'finished' | 'stopped'
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  archivedAt: string | null
  /** null докато не е архивирана — admin UI показва "очаква архивиране" вместо число. */
  totalUnits: number | null
  participantsCount: number | null
}

export type GetArchivalReadinessResult =
  | { ok: true; campaignStatus: 'finished' | 'stopped'; readiness: CampaignArchivalReadiness; ready: boolean }
  | { ok: false; reason: 'campaign_not_found' | 'already_archived' | 'not_finished' }

export type ArchiveCampaignResult =
  | { ok: true; alreadyArchived: boolean; detail: CampaignArchiveDetail }
  | { ok: false; reason: 'campaign_not_found' | 'not_finished' }
  | { ok: false; reason: 'reconciliation_incomplete'; readiness: CampaignArchivalReadiness }

export type CampaignArchiveStore = {
  getArchivalReadiness: (campaignId: CampaignId) => GetArchivalReadinessResult
  /**
   * unitIconUrlAtArchive — ПРЕ-изчислен от caller-а (index.ts, единственото
   * място с upload-path/filesystem достъп, виж doc коментара в
   * campaignThemeAssets.ts) чрез еднократно физическо копиране на текущия
   * campaigns.unit_icon_url ПРЕДИ тая извикване, ако кампанията има иконка.
   * Тоя store остава чист DB модул, без директна fs зависимост (mirror на
   * установения принцип в campaignCreditStore.ts/campaignAdminStore.ts).
   * Идемпотентно — повторно извикване върху вече архивирана кампания
   * връща `alreadyArchived:true` със СЪЩЕСТВУВАЩИЯ (непроменен) детайл,
   * игнорирайки подадения unitIconUrlAtArchive (вече архивираното копие
   * остава единствения валиден snapshot — "Повторното архивиране трябва
   * да бъде идемпотентно, а не да презаписва историческите резултати").
   */
  archiveCampaign: (
    campaignId: CampaignId,
    actor: CampaignActionActor,
    unitIconUrlAtArchive: string | null,
  ) => ArchiveCampaignResult
  getArchiveDetail: (campaignId: CampaignId) => CampaignArchiveDetail | null
  listFinishedCampaignsForAdmin: () => AdminFinishedCampaignListRow[]
  /** Кандидати за автоматично архивиране (scheduler job) — finished/stopped, не-изтрити, не-архивирани. */
  listArchivableCandidateIds: () => CampaignId[]
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
  archived_at: string | null
  deleted_at: string | null
}

export async function createCampaignArchiveStore(
  databaseFilePath: string,
  campaignCreditStore: CampaignCreditStore,
): Promise<CampaignArchiveStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectCampaignStatement = database.prepare(`
    SELECT campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural, archived_at, deleted_at
    FROM campaigns
    WHERE campaign_id = ?
    LIMIT 1;
  `)

  const selectStoppedEventStatement = database.prepare(`
    SELECT created_at FROM campaign_events
    WHERE campaign_id = ? AND event_type = 'campaign_stopped'
    ORDER BY created_at ASC
    LIMIT 1;
  `)

  // Mirror на campaignCreditStore.ts::getEffectiveWindowEndIso — виж doc
  // коментара там за пълния rationale ("ends_at продължава да сочи
  // оригинално планирания край дори след ръчно спиране"). Тук е
  // независимо дефинирана (не imported) само защото оригиналната е
  // closure-local върху ДРУГА DatabaseSync connection, не защото логиката
  // реално се различава — запазвай 1:1 синхронизирана с оригинала.
  function getEffectiveWindowEndIso(campaign: CampaignRow): string {
    if (campaign.status !== 'stopped') return campaign.ends_at
    const row = selectStoppedEventStatement.get(campaign.campaign_id) as { created_at: string } | undefined
    return row === undefined ? campaign.ends_at : row.created_at
  }

  function insertEvent(campaignId: CampaignId, eventType: string, actor: CampaignActionActor, payload: Record<string, unknown>): void {
    const actorProfileId = actor.type === 'admin' ? actor.profileId : null
    database.prepare(`
      INSERT INTO campaign_events (event_id, campaign_id, event_type, actor_profile_id, payload_json)
      VALUES (?, ?, ?, ?, ?);
    `).run(randomUUID(), campaignId, eventType, actorProfileId, JSON.stringify({ ...payload, actorType: actor.type }))
  }

  function rollback(): void {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // ignore — само след вече известена грешка по-горе
    }
  }

  // ─── Readiness (campaign-scoped "каквото ВСЕ ОЩЕ не е credit-нато в тоя прозорец") ───

  const countPendingBelotWinStatement = database.prepare(`
    SELECT COUNT(*) AS c FROM belot_match_completion_ledger bmcl
    WHERE bmcl.did_win = 1 AND bmcl.is_guest_trial = 0 AND bmcl.profile_id IS NOT NULL
      AND datetime(bmcl.ended_at) >= datetime(?) AND datetime(bmcl.ended_at) < datetime(?)
      AND NOT EXISTS (
        SELECT 1 FROM campaign_unit_ledger cul
        WHERE cul.source_type = 'belot_win' AND cul.profile_id = bmcl.profile_id AND cul.source_id = bmcl.match_scope
      );
  `)

  const countPendingBelotLegacyStatement = database.prepare(`
    SELECT COUNT(*) AS c FROM profile_match_results pmr
    WHERE pmr.did_win = 1 AND pmr.is_guest_trial = 0 AND pmr.profile_id IS NOT NULL
      AND datetime(pmr.completed_at) >= datetime(?) AND datetime(pmr.completed_at) < datetime(?)
      AND NOT EXISTS (
        SELECT 1 FROM campaign_unit_ledger cul
        WHERE cul.source_type = 'belot_win' AND cul.profile_id = pmr.profile_id
          AND (cul.source_id = pmr.room_id OR cul.source_id LIKE pmr.room_id || ':v%')
      )
      AND NOT EXISTS (
        SELECT 1 FROM belot_match_completion_ledger bmcl2
        WHERE bmcl2.room_id = pmr.room_id AND bmcl2.profile_id = pmr.profile_id
      );
  `)

  const countPendingLudoWinStatement = database.prepare(`
    SELECT COUNT(*) AS c FROM ludo_room_matches lrm
    WHERE lrm.status = 'finished' AND lrm.winner_profile_id IS NOT NULL
      AND datetime(lrm.finished_at) >= datetime(?) AND datetime(lrm.finished_at) < datetime(?)
      AND NOT EXISTS (
        SELECT 1 FROM campaign_unit_ledger cul
        WHERE cul.source_type = 'ludo_win' AND cul.source_id = lrm.match_id AND cul.profile_id = lrm.winner_profile_id
      );
  `)

  function makePendingPurchaseStatement(tableName: string): ReturnType<SqliteDatabase['prepare']> {
    return database.prepare(`
      SELECT COUNT(*) AS c FROM ${tableName} t
      WHERE t.status = 'paid' AND t.credited_at IS NOT NULL AND t.profile_id IS NOT NULL
        AND datetime(t.credited_at) >= datetime(?) AND datetime(t.credited_at) < datetime(?)
        AND NOT EXISTS (
          SELECT 1 FROM campaign_unit_ledger cul
          WHERE cul.source_type = 'package_purchase' AND cul.source_id = t.purchase_id AND cul.profile_id = t.profile_id
        );
    `)
  }
  const countPendingCoinStatement = makePendingPurchaseStatement('coin_purchase_ledger')
  const countPendingBundleStatement = makePendingPurchaseStatement('bundle_purchase_ledger')
  const countPendingVipStatement = makePendingPurchaseStatement('vip_purchase_ledger')

  function computeReadiness(campaign: CampaignRow): CampaignArchivalReadiness {
    const startsAt = campaign.starts_at
    const effectiveEndIso = getEffectiveWindowEndIso(campaign)
    const one = (stmt: ReturnType<SqliteDatabase['prepare']>) => (stmt.get(startsAt, effectiveEndIso) as { c: number }).c
    return {
      pendingBelotWin: one(countPendingBelotWinStatement),
      pendingBelotLegacy: one(countPendingBelotLegacyStatement),
      pendingLudoWin: one(countPendingLudoWinStatement),
      pendingPurchaseCoin: one(countPendingCoinStatement),
      pendingPurchaseBundle: one(countPendingBundleStatement),
      pendingPurchaseVip: one(countPendingVipStatement),
      pendingGiftRewardGaps: campaignCreditStore.listPendingGiftRewardGaps(campaign.campaign_id).length,
    }
  }

  function getArchivalReadiness(campaignId: CampaignId): GetArchivalReadinessResult {
    const campaign = selectCampaignStatement.get(campaignId) as CampaignRow | undefined
    if (campaign === undefined) return { ok: false, reason: 'campaign_not_found' }
    if (campaign.archived_at !== null) return { ok: false, reason: 'already_archived' }
    if (campaign.status !== 'finished' && campaign.status !== 'stopped') return { ok: false, reason: 'not_finished' }
    const readiness = computeReadiness(campaign)
    return { ok: true, campaignStatus: campaign.status, readiness, ready: readinessIsClear(readiness) }
  }

  // ─── Archive aggregation + freeze ───

  const selectUnitsBySourceTypeStatement = database.prepare(`
    SELECT source_type, COALESCE(SUM(units_amount), 0) AS total
    FROM campaign_unit_ledger
    WHERE campaign_id = ?
    GROUP BY source_type;
  `)

  const countParticipantsStatement = database.prepare(`
    SELECT COUNT(*) AS c FROM campaign_profile_totals WHERE campaign_id = ?;
  `)

  const countRewardsGrantedStatement = database.prepare(`
    SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE campaign_id = ?;
  `)

  // Tie-break: units_total DESC, profile_id ASC (стабилно, детерминистично,
  // не изисква нова колона — задачата §6 иска САМО "предварително
  // определен стабилен вторичен критерий", не конкретна формула).
  // profile_id IS NOT NULL — hard-deleted участник (виж doc коментара най-
  // отгоре, §6/§11) не може да получи display_name_at_archive snapshot,
  // затова не влиза в Топ 10 (но продължава да участва в total_units/
  // participants_count чрез campaign_profile_totals реда си, непипнат).
  // profile_kind/is_temporary филтъра е defense-in-depth, НЕ primary
  // gate — creditCampaignUnits() вече никога не пише ред за бот/temp
  // профил (виж isProfileEligibleForGameCredit), но проверката тук е
  // евтина (индексиран JOIN) и прави Топ 10 computation-а коректен дори
  // ако тая гаранция някога се промени независимо.
  const selectTop10CandidatesStatement = database.prepare(`
    SELECT cpt.profile_id AS profile_id, cpt.units_total AS units_total,
           p.display_name AS display_name, p.rank_title AS rank_title
    FROM campaign_profile_totals cpt
    JOIN profiles p ON p.profile_id = cpt.profile_id
    WHERE cpt.campaign_id = ? AND cpt.profile_id IS NOT NULL
      AND p.profile_kind = 'human' AND p.is_temporary = 0
    ORDER BY cpt.units_total DESC, cpt.profile_id ASC
    LIMIT 10;
  `)

  const insertTop10RowStatement = database.prepare(`
    INSERT INTO campaign_archive_top10 (campaign_id, rank, profile_id, display_name_at_archive, rank_title_at_archive, units_total)
    VALUES (?, ?, ?, ?, ?, ?);
  `)

  const insertSummaryStatement = database.prepare(`
    INSERT INTO campaign_archive_summary (
      campaign_id, ended_reason, participants_count, total_units,
      units_from_belot, units_from_ludo, units_from_purchases, units_from_admin_adjustments,
      rewards_granted_count, unit_icon_url_at_archive
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `)

  const markCampaignArchivedStatement = database.prepare(`
    UPDATE campaigns SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;
  `)

  function archiveCampaign(
    campaignId: CampaignId,
    actor: CampaignActionActor,
    unitIconUrlAtArchive: string | null,
  ): ArchiveCampaignResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const campaign = selectCampaignStatement.get(campaignId) as CampaignRow | undefined
      if (campaign === undefined) {
        rollback()
        return { ok: false, reason: 'campaign_not_found' }
      }
      if (campaign.archived_at !== null) {
        // Идемпотентно — виж doc коментара на CampaignArchiveStore.archiveCampaign.
        database.exec('COMMIT;')
        const detail = getArchiveDetailInternal(campaignId)!
        return { ok: true, alreadyArchived: true, detail }
      }
      if (campaign.status !== 'finished' && campaign.status !== 'stopped') {
        rollback()
        return { ok: false, reason: 'not_finished' }
      }

      // Re-check ВЪТРЕ в BEGIN IMMEDIATE lock-а — транзакционна защита срещу
      // състезание с конкурентен creditCampaignUnits() (§5).
      const readiness = computeReadiness(campaign)
      if (!readinessIsClear(readiness)) {
        rollback()
        return { ok: false, reason: 'reconciliation_incomplete', readiness }
      }

      const unitsBySource = selectUnitsBySourceTypeStatement.all(campaignId) as Array<{ source_type: string; total: number }>
      const unitsOf = (sourceType: string) => unitsBySource.find((row) => row.source_type === sourceType)?.total ?? 0
      const unitsFromBelot = unitsOf('belot_win')
      const unitsFromLudo = unitsOf('ludo_win')
      const unitsFromPurchases = unitsOf('package_purchase')
      const unitsFromAdminAdjustments = unitsOf('admin_adjustment')
      const totalUnits = unitsFromBelot + unitsFromLudo + unitsFromPurchases + unitsFromAdminAdjustments

      const participantsCount = (countParticipantsStatement.get(campaignId) as { c: number }).c
      const rewardsGrantedCount = (countRewardsGrantedStatement.get(campaignId) as { c: number }).c
      const endedReason: 'expired' | 'stopped' = campaign.status === 'stopped' ? 'stopped' : 'expired'

      insertSummaryStatement.run(
        campaignId, endedReason, participantsCount, totalUnits,
        unitsFromBelot, unitsFromLudo, unitsFromPurchases, unitsFromAdminAdjustments,
        rewardsGrantedCount, unitIconUrlAtArchive,
      )

      const top10Candidates = selectTop10CandidatesStatement.all(campaignId) as Array<{
        profile_id: string; units_total: number; display_name: string; rank_title: string | null
      }>
      top10Candidates.forEach((row, index) => {
        insertTop10RowStatement.run(campaignId, index + 1, row.profile_id, row.display_name, row.rank_title, row.units_total)
      })

      markCampaignArchivedStatement.run(campaignId)
      insertEvent(campaignId, 'campaign_archived', actor, {
        endedReason, participantsCount, totalUnits, rewardsGrantedCount, top10Count: top10Candidates.length,
      })

      database.exec('COMMIT;')
      const detail = getArchiveDetailInternal(campaignId)!
      return { ok: true, alreadyArchived: false, detail }
    } catch (error) {
      rollback()
      throw error
    }
  }

  // ─── Read-only detail/list views ───

  const selectArchiveSummaryStatement = database.prepare(`
    SELECT campaign_id, ended_reason, participants_count, total_units,
           units_from_belot, units_from_ludo, units_from_purchases, units_from_admin_adjustments,
           rewards_granted_count, unit_icon_url_at_archive, archived_at
    FROM campaign_archive_summary
    WHERE campaign_id = ?
    LIMIT 1;
  `)

  const selectArchiveTop10Statement = database.prepare(`
    SELECT rank, profile_id, display_name_at_archive, rank_title_at_archive, units_total
    FROM campaign_archive_top10
    WHERE campaign_id = ?
    ORDER BY rank ASC;
  `)

  function getArchiveDetailInternal(campaignId: CampaignId): CampaignArchiveDetail | null {
    const campaign = selectCampaignStatement.get(campaignId) as CampaignRow | undefined
    const summaryRow = selectArchiveSummaryStatement.get(campaignId) as
      | {
          campaign_id: string; ended_reason: string; participants_count: number; total_units: number
          units_from_belot: number; units_from_ludo: number; units_from_purchases: number; units_from_admin_adjustments: number
          rewards_granted_count: number; unit_icon_url_at_archive: string | null; archived_at: string
        }
      | undefined
    if (campaign === undefined || summaryRow === undefined) return null

    const top10Rows = selectArchiveTop10Statement.all(campaignId) as Array<{
      rank: number; profile_id: string | null; display_name_at_archive: string; rank_title_at_archive: string | null; units_total: number
    }>

    return {
      campaignId: campaign.campaign_id,
      name: campaign.name,
      startsAt: campaign.starts_at,
      endsAt: campaign.ends_at,
      unitNameSingular: campaign.unit_name_singular,
      unitNamePlural: campaign.unit_name_plural,
      summary: {
        campaignId: summaryRow.campaign_id,
        endedReason: summaryRow.ended_reason as 'expired' | 'stopped',
        participantsCount: summaryRow.participants_count,
        totalUnits: summaryRow.total_units,
        unitsFromBelot: summaryRow.units_from_belot,
        unitsFromLudo: summaryRow.units_from_ludo,
        unitsFromPurchases: summaryRow.units_from_purchases,
        unitsFromAdminAdjustments: summaryRow.units_from_admin_adjustments,
        rewardsGrantedCount: summaryRow.rewards_granted_count,
        unitIconUrlAtArchive: summaryRow.unit_icon_url_at_archive,
        archivedAt: summaryRow.archived_at,
      },
      top10: top10Rows.map((row) => ({
        rank: row.rank,
        profileId: row.profile_id,
        displayNameAtArchive: row.display_name_at_archive,
        rankTitleAtArchive: row.rank_title_at_archive,
        unitsTotal: row.units_total,
      })),
    }
  }

  // Draft/scheduled кампании, НИКОГА активирани, НЕ се показват като
  // "действително проведени" (§7: "Не показвай чернови или кампании, които
  // никога не са били активирани, като действително проведени") — mirror
  // на selectLastFinishedCampaignForProfileSummaryStatement филтъра
  // (EXISTS campaign_activated). Soft-delete НЕ се крие тук умишлено —
  // admin-ът управлява soft-deleted кампании през СЪЩИЯ existing filter
  // UI (renderAdminCampaignsPanel.ts's filter-и), не през тоя нов екран;
  // архивът/Топ10 на soft-deleted кампания остава видим при explicit избор.
  const selectFinishedCampaignsForAdminStatement = database.prepare(`
    SELECT c.campaign_id, c.name, c.status, c.starts_at, c.ends_at,
           c.unit_name_singular, c.unit_name_plural, c.archived_at,
           cas.total_units, cas.participants_count
    FROM campaigns c
    LEFT JOIN campaign_archive_summary cas ON cas.campaign_id = c.campaign_id
    WHERE c.status IN ('finished', 'stopped')
      AND EXISTS (SELECT 1 FROM campaign_events ce WHERE ce.campaign_id = c.campaign_id AND ce.event_type = 'campaign_activated')
    ORDER BY c.updated_at DESC, c.rowid DESC;
  `)

  function listFinishedCampaignsForAdmin(): AdminFinishedCampaignListRow[] {
    const rows = selectFinishedCampaignsForAdminStatement.all() as Array<{
      campaign_id: string; name: string; status: string; starts_at: string; ends_at: string
      unit_name_singular: string; unit_name_plural: string; archived_at: string | null
      total_units: number | null; participants_count: number | null
    }>
    return rows.map((row) => ({
      campaignId: row.campaign_id,
      name: row.name,
      status: row.status as 'finished' | 'stopped',
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      unitNameSingular: row.unit_name_singular,
      unitNamePlural: row.unit_name_plural,
      archivedAt: row.archived_at,
      totalUnits: row.total_units,
      participantsCount: row.participants_count,
    }))
  }

  const selectArchivableCandidateIdsStatement = database.prepare(`
    SELECT campaign_id FROM campaigns
    WHERE status IN ('finished', 'stopped') AND archived_at IS NULL AND deleted_at IS NULL
    ORDER BY updated_at ASC;
  `)

  function listArchivableCandidateIds(): CampaignId[] {
    return (selectArchivableCandidateIdsStatement.all() as Array<{ campaign_id: string }>).map((row) => row.campaign_id)
  }

  return {
    getArchivalReadiness,
    archiveCampaign,
    getArchiveDetail: getArchiveDetailInternal,
    listFinishedCampaignsForAdmin,
    listArchivableCandidateIds,
    close: () => database.close(),
  }
}
