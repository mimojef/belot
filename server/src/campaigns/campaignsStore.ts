// Store за лайфсайкъла на "Кампании" (campaigns таблицата + campaign_events
// audit log от Фаза 0, server/database/migrations/20261010_001_create_campaign_system_tables.sql).
//
// Фаза 1 обхват: само лайфсайкъл на самата кампания (create/edit/schedule/
// activate/finish/stop/clone/soft-delete/list/detail/active-check) + audit.
// НЕ пипа campaign_earn_rules/campaign_package_earn_rules/campaign_reward_tiers/
// campaign_tier_rewards/campaign_unit_ledger/... — тези идват с бъдещи фази
// (admin UI config + crediting hooks), извън текущия обхват.
//
// Транзакционен модел: собствена DatabaseSync connection (mirror на
// tournamentEconomyStore.ts/vipStore.ts паттерна — всеки store управлява
// собствен lifecycle, не споделя connection с друг store). Всяка мутация е
// `BEGIN IMMEDIATE` -> re-select на реда СЛЕД взетия write lock -> explicit
// `ROLLBACK` + типизиран `{ok:false, reason}` при всяко "очаквано" невалидно
// състояние (никога throw за тях, mirror на
// tournamentEconomyStore.startTournamentAtomicallyLocal) -> `COMMIT` само
// при успех. Единствената активна кампания се гарантира на ДВА нива: (1)
// partial UNIQUE INDEX idx_campaigns_single_active от Фаза 0 (DB-level,
// race-proof); (2) explicit SELECT COUNT(*) WHERE status='active' ВЪТРЕ в
// същата BEGIN IMMEDIATE транзакция, преди UPDATE-а — щом BEGIN IMMEDIATE е
// взела write lock-а, никой друг writer не може да се намеси между този
// SELECT и последващия UPDATE, затова проверката е напълно race-proof без
// да се разчита на catch-ване на constraint violation като primary path.
//
// System vs admin действия в audit log-а: campaign_events (Фаза 0) има само
// nullable actor_profile_id, без отделна actor_type/actor_role колона (за
// разлика от tournament_events.actor_role) — не добавяме нова миграция за
// това, защото payload_json вече съществува и е достатъчен: всеки insertEvent
// извикан тук explicit слага `actorType: 'admin' | 'system'` В payload_json,
// което прави разликата еднозначна и queryable (`json_extract(payload_json,
// '$.actorType')`) без schema промяна.

import { randomUUID } from 'node:crypto'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type CampaignId = string
export type CampaignStatus = 'draft' | 'scheduled' | 'active' | 'finished' | 'stopped'

export type CampaignRecord = {
  campaignId: CampaignId
  name: string
  status: CampaignStatus
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  unitIconUrl: string | null
  tableBgDesktopUrl: string | null
  tableBgMobileUrl: string | null
  cardBackUrl: string | null
  giftSenderProfileId: string | null
  archivedAt: string | null
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CampaignActionActor = { type: 'admin'; profileId: string } | { type: 'system' }

export type CreateDraftCampaignInput = {
  name: string
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  giftSenderProfileId?: string | null
}

export type UpdateCampaignPatch = Partial<{
  name: string
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  giftSenderProfileId: string | null
}>

type InvalidPeriodReason = 'invalid_period'
type OverlapReason = 'overlaps_existing_campaign'

export type CreateDraftCampaignResult =
  | { ok: true; campaign: CampaignRecord }
  | { ok: false; reason: InvalidPeriodReason }

export type UpdateCampaignResult =
  | { ok: true; campaign: CampaignRecord }
  | {
      ok: false
      reason: 'campaign_not_found' | 'not_editable' | InvalidPeriodReason | OverlapReason
    }

export type ScheduleCampaignResult =
  | { ok: true; campaign: CampaignRecord }
  | {
      ok: false
      reason: 'campaign_not_found' | 'invalid_status' | InvalidPeriodReason | OverlapReason
    }

export type ActivateCampaignResult =
  | { ok: true; campaign: CampaignRecord; alreadyActive: boolean }
  | {
      ok: false
      reason: 'campaign_not_found' | 'invalid_status' | 'already_expired' | 'another_campaign_active'
    }

export type ExpireScheduledWithoutActivatingResult =
  | { ok: true; campaign: CampaignRecord }
  | { ok: false; reason: 'campaign_not_found' | 'invalid_status' | 'not_yet_expired' }

export type FinishCampaignResult =
  | { ok: true; campaign: CampaignRecord; alreadyFinished: boolean }
  | { ok: false; reason: 'campaign_not_found' | 'invalid_status' }

export type StopCampaignResult =
  | { ok: true; campaign: CampaignRecord }
  | { ok: false; reason: 'campaign_not_found' | 'invalid_status' }

export type CloneCampaignResult =
  | { ok: true; campaign: CampaignRecord }
  | { ok: false; reason: 'campaign_not_found' }

export type SoftDeleteCampaignResult =
  | { ok: true; campaign: CampaignRecord }
  | { ok: false; reason: 'campaign_not_found' | 'cannot_delete_active_campaign' | 'already_deleted' }

export type ListCampaignsFilter = {
  status?: CampaignStatus
  includeDeleted?: boolean
}

export type CampaignsStore = {
  createDraftCampaign: (input: CreateDraftCampaignInput, actor: CampaignActionActor) => CreateDraftCampaignResult
  updateCampaign: (
    campaignId: CampaignId,
    patch: UpdateCampaignPatch,
    actor: CampaignActionActor,
  ) => UpdateCampaignResult
  scheduleCampaign: (campaignId: CampaignId, actor: CampaignActionActor) => ScheduleCampaignResult
  activateCampaign: (campaignId: CampaignId, now: Date, actor: CampaignActionActor) => ActivateCampaignResult
  expireScheduledCampaignWithoutActivating: (
    campaignId: CampaignId,
    now: Date,
    actor: CampaignActionActor,
  ) => ExpireScheduledWithoutActivatingResult
  finishCampaign: (campaignId: CampaignId, now: Date, actor: CampaignActionActor) => FinishCampaignResult
  stopCampaign: (campaignId: CampaignId, actor: CampaignActionActor) => StopCampaignResult
  cloneCampaign: (sourceCampaignId: CampaignId, actor: CampaignActionActor) => CloneCampaignResult
  softDeleteCampaign: (campaignId: CampaignId, actor: CampaignActionActor) => SoftDeleteCampaignResult
  getCampaignById: (campaignId: CampaignId) => CampaignRecord | null
  getActiveCampaign: () => CampaignRecord | null
  listCampaigns: (filter?: ListCampaignsFilter) => CampaignRecord[]
  listDueScheduledCampaignIds: (now: Date, limit: number) => CampaignId[]
  listDueActiveCampaignIds: (now: Date, limit: number) => CampaignId[]
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
  unit_icon_url: string | null
  table_bg_desktop_url: string | null
  table_bg_mobile_url: string | null
  card_back_url: string | null
  gift_sender_profile_id: string | null
  archived_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

function rowToCampaignRecord(row: CampaignRow): CampaignRecord {
  return {
    campaignId: row.campaign_id,
    name: row.name,
    status: row.status as CampaignStatus,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    unitNameSingular: row.unit_name_singular,
    unitNamePlural: row.unit_name_plural,
    unitIconUrl: row.unit_icon_url,
    tableBgDesktopUrl: row.table_bg_desktop_url,
    tableBgMobileUrl: row.table_bg_mobile_url,
    cardBackUrl: row.card_back_url,
    giftSenderProfileId: row.gift_sender_profile_id,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function isValidPeriod(startsAtIso: string, endsAtIso: string): boolean {
  const startsAtMs = Date.parse(startsAtIso)
  const endsAtMs = Date.parse(endsAtIso)
  return Number.isFinite(startsAtMs) && Number.isFinite(endsAtMs) && endsAtMs > startsAtMs
}

export async function createCampaignsStore(databaseFilePath: string): Promise<CampaignsStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  // Explicit busy_timeout (за разлика от coinPurchaseStore.ts/missionStore.ts,
  // които го нямат) — новия campaign scheduler ще отваря собствена connection
  // към същия файл и ще тиква периодично; без това конкурентен writer би
  // получил незабавен SQLITE_BUSY вместо кратко изчакване на write lock-а.
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectCampaignByIdStatement = database.prepare(`
    SELECT campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural,
           unit_icon_url, table_bg_desktop_url, table_bg_mobile_url, card_back_url,
           gift_sender_profile_id, archived_at, deleted_at, created_at, updated_at
    FROM campaigns
    WHERE campaign_id = ?
    LIMIT 1;
  `)

  const selectActiveCampaignStatement = database.prepare(`
    SELECT campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural,
           unit_icon_url, table_bg_desktop_url, table_bg_mobile_url, card_back_url,
           gift_sender_profile_id, archived_at, deleted_at, created_at, updated_at
    FROM campaigns
    WHERE status = 'active' AND deleted_at IS NULL
    LIMIT 1;
  `)

  const countActiveCampaignsStatement = database.prepare(`
    SELECT COUNT(*) AS c FROM campaigns WHERE status = 'active' AND deleted_at IS NULL;
  `)

  const selectOverlappingCampaignStatement = database.prepare(`
    SELECT campaign_id FROM campaigns
    WHERE deleted_at IS NULL
      AND status IN ('scheduled', 'active')
      AND campaign_id != ?
      AND starts_at < ?
      AND ends_at > ?
    LIMIT 1;
  `)

  const insertCampaignStatement = database.prepare(`
    INSERT INTO campaigns (
      campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural, gift_sender_profile_id
    ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?);
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO campaign_events (event_id, campaign_id, event_type, actor_profile_id, payload_json)
    VALUES (?, ?, ?, ?, ?);
  `)

  const selectDueScheduledIdsStatement = database.prepare(`
    SELECT campaign_id FROM campaigns
    WHERE status = 'scheduled' AND deleted_at IS NULL
      AND datetime(starts_at) <= datetime(?)
    ORDER BY starts_at ASC
    LIMIT ?;
  `)

  const selectDueActiveIdsStatement = database.prepare(`
    SELECT campaign_id FROM campaigns
    WHERE status = 'active' AND deleted_at IS NULL
      AND datetime(ends_at) <= datetime(?)
    ORDER BY ends_at ASC
    LIMIT ?;
  `)

  function insertEvent(
    campaignId: CampaignId,
    eventType: string,
    actor: CampaignActionActor,
    payload: Record<string, unknown>,
  ): void {
    const actorProfileId = actor.type === 'admin' ? actor.profileId : null
    insertEventStatement.run(
      randomUUID(),
      campaignId,
      eventType,
      actorProfileId,
      JSON.stringify({ ...payload, actorType: actor.type }),
    )
  }

  function getCampaignByIdInternal(campaignId: CampaignId): CampaignRecord | null {
    const row = selectCampaignByIdStatement.get(campaignId) as CampaignRow | undefined
    return row === undefined ? null : rowToCampaignRecord(row)
  }

  function hasOverlap(campaignId: CampaignId, startsAt: string, endsAt: string): boolean {
    return selectOverlappingCampaignStatement.get(campaignId, endsAt, startsAt) !== undefined
  }

  function rollback(): void {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // ignore rollback failure — само след вече известена грешка по-горе
    }
  }

  function createDraftCampaign(
    input: CreateDraftCampaignInput,
    actor: CampaignActionActor,
  ): CreateDraftCampaignResult {
    if (!isValidPeriod(input.startsAt, input.endsAt)) {
      return { ok: false, reason: 'invalid_period' }
    }
    const campaignId = randomUUID()
    database.exec('BEGIN IMMEDIATE;')
    try {
      insertCampaignStatement.run(
        campaignId,
        input.name,
        input.startsAt,
        input.endsAt,
        input.unitNameSingular,
        input.unitNamePlural,
        input.giftSenderProfileId ?? null,
      )
      insertEvent(campaignId, 'campaign_created', actor, { name: input.name })
      database.exec('COMMIT;')
    } catch (error) {
      rollback()
      throw error
    }
    return { ok: true, campaign: getCampaignByIdInternal(campaignId)! }
  }

  function updateCampaign(
    campaignId: CampaignId,
    patch: UpdateCampaignPatch,
    actor: CampaignActionActor,
  ): UpdateCampaignResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = getCampaignByIdInternal(campaignId)
      if (existing === null) {
        rollback()
        return { ok: false, reason: 'campaign_not_found' }
      }
      // Заключени за редакция след активиране/приключване/спиране —
      // консистентно с принципа "earn rules/reward tiers се заключват след
      // активиране" от одобрения план (приложено тук и към самите основни
      // полета на кампанията, за да не се обезсмисли вече течащ период).
      if (existing.status !== 'draft' && existing.status !== 'scheduled') {
        rollback()
        return { ok: false, reason: 'not_editable' }
      }

      const nextStartsAt = patch.startsAt ?? existing.startsAt
      const nextEndsAt = patch.endsAt ?? existing.endsAt
      if (!isValidPeriod(nextStartsAt, nextEndsAt)) {
        rollback()
        return { ok: false, reason: 'invalid_period' }
      }
      // Overlap проверка само когато кампанията вече държи резервиран
      // календарен слот (status='scheduled') — draft не го прави.
      if (existing.status === 'scheduled' && hasOverlap(campaignId, nextStartsAt, nextEndsAt)) {
        rollback()
        return { ok: false, reason: 'overlaps_existing_campaign' }
      }

      database.prepare(`
        UPDATE campaigns SET
          name = ?, starts_at = ?, ends_at = ?, unit_name_singular = ?, unit_name_plural = ?,
          gift_sender_profile_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE campaign_id = ?;
      `).run(
        patch.name ?? existing.name,
        nextStartsAt,
        nextEndsAt,
        patch.unitNameSingular ?? existing.unitNameSingular,
        patch.unitNamePlural ?? existing.unitNamePlural,
        patch.giftSenderProfileId === undefined ? existing.giftSenderProfileId : patch.giftSenderProfileId,
        campaignId,
      )
      insertEvent(campaignId, 'campaign_updated', actor, { patch })
      database.exec('COMMIT;')
    } catch (error) {
      rollback()
      throw error
    }
    return { ok: true, campaign: getCampaignByIdInternal(campaignId)! }
  }

  function scheduleCampaign(campaignId: CampaignId, actor: CampaignActionActor): ScheduleCampaignResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = getCampaignByIdInternal(campaignId)
      if (existing === null) {
        rollback()
        return { ok: false, reason: 'campaign_not_found' }
      }
      if (existing.status !== 'draft') {
        rollback()
        return { ok: false, reason: 'invalid_status' }
      }
      if (!isValidPeriod(existing.startsAt, existing.endsAt)) {
        rollback()
        return { ok: false, reason: 'invalid_period' }
      }
      if (hasOverlap(campaignId, existing.startsAt, existing.endsAt)) {
        rollback()
        return { ok: false, reason: 'overlaps_existing_campaign' }
      }
      database
        .prepare(`UPDATE campaigns SET status = 'scheduled', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`)
        .run(campaignId)
      insertEvent(campaignId, 'campaign_scheduled', actor, { startsAt: existing.startsAt, endsAt: existing.endsAt })
      database.exec('COMMIT;')
    } catch (error) {
      rollback()
      throw error
    }
    return { ok: true, campaign: getCampaignByIdInternal(campaignId)! }
  }

  function activateCampaign(
    campaignId: CampaignId,
    now: Date,
    actor: CampaignActionActor,
  ): ActivateCampaignResult {
    const nowIso = now.toISOString()
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = getCampaignByIdInternal(campaignId)
      if (existing === null) {
        rollback()
        return { ok: false, reason: 'campaign_not_found' }
      }
      if (existing.status === 'active') {
        database.exec('COMMIT;')
        return { ok: true, campaign: existing, alreadyActive: true }
      }
      if (existing.status !== 'draft' && existing.status !== 'scheduled') {
        rollback()
        return { ok: false, reason: 'invalid_status' }
      }
      // "Не я активирай за кратко само за да я приключиш" — ако краят на
      // периода вече е отминал към момента на опита за активиране, отказваме
      // тук; извикващият (scheduler-ът) трябва вместо това да извика
      // expireScheduledCampaignWithoutActivating за този случай.
      if (Date.parse(existing.endsAt) <= now.getTime()) {
        rollback()
        return { ok: false, reason: 'already_expired' }
      }
      // Re-check СЛЕД взетия BEGIN IMMEDIATE write lock — race-proof, виж
      // коментара най-отгоре. Партиалният UNIQUE INDEX е допълнителен
      // DB-level backstop, не primary механизъм.
      const activeCountRow = countActiveCampaignsStatement.get() as { c: number }
      if (activeCountRow.c > 0) {
        rollback()
        return { ok: false, reason: 'another_campaign_active' }
      }
      database
        .prepare(`UPDATE campaigns SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`)
        .run(campaignId)
      insertEvent(campaignId, 'campaign_activated', actor, { previousStatus: existing.status, activatedAt: nowIso })
      database.exec('COMMIT;')
    } catch (error) {
      rollback()
      throw error
    }
    return { ok: true, campaign: getCampaignByIdInternal(campaignId)!, alreadyActive: false }
  }

  function expireScheduledCampaignWithoutActivating(
    campaignId: CampaignId,
    now: Date,
    actor: CampaignActionActor,
  ): ExpireScheduledWithoutActivatingResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = getCampaignByIdInternal(campaignId)
      if (existing === null) {
        rollback()
        return { ok: false, reason: 'campaign_not_found' }
      }
      if (existing.status !== 'scheduled') {
        rollback()
        return { ok: false, reason: 'invalid_status' }
      }
      if (Date.parse(existing.endsAt) > now.getTime()) {
        rollback()
        return { ok: false, reason: 'not_yet_expired' }
      }
      // Директно scheduled -> finished, НИКОГА през 'active' — цялият период
      // е изтекъл преди кампанията да е била активирана изобщо (напр. сървър
      // е бил спрян по време на целия и-живот). archived_at остава NULL —
      // реалното архивиране (бъдеща фаза) ще реши какво да прави с 0
      // участника; тук само маркираме лайфсайкъл статуса коректно.
      database
        .prepare(`UPDATE campaigns SET status = 'finished', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`)
        .run(campaignId)
      insertEvent(campaignId, 'campaign_expired_before_activation', actor, {
        startsAt: existing.startsAt,
        endsAt: existing.endsAt,
      })
      database.exec('COMMIT;')
    } catch (error) {
      rollback()
      throw error
    }
    return { ok: true, campaign: getCampaignByIdInternal(campaignId)! }
  }

  function finishCampaign(campaignId: CampaignId, now: Date, actor: CampaignActionActor): FinishCampaignResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = getCampaignByIdInternal(campaignId)
      if (existing === null) {
        rollback()
        return { ok: false, reason: 'campaign_not_found' }
      }
      if (existing.status === 'finished') {
        database.exec('COMMIT;')
        return { ok: true, campaign: existing, alreadyFinished: true }
      }
      if (existing.status !== 'active') {
        rollback()
        return { ok: false, reason: 'invalid_status' }
      }
      database
        .prepare(`UPDATE campaigns SET status = 'finished', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`)
        .run(campaignId)
      insertEvent(campaignId, 'campaign_finished', actor, { endedAt: now.toISOString() })
      database.exec('COMMIT;')
    } catch (error) {
      rollback()
      throw error
    }
    return { ok: true, campaign: getCampaignByIdInternal(campaignId)!, alreadyFinished: false }
  }

  function stopCampaign(campaignId: CampaignId, actor: CampaignActionActor): StopCampaignResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = getCampaignByIdInternal(campaignId)
      if (existing === null) {
        rollback()
        return { ok: false, reason: 'campaign_not_found' }
      }
      if (existing.status !== 'active') {
        rollback()
        return { ok: false, reason: 'invalid_status' }
      }
      database
        .prepare(`UPDATE campaigns SET status = 'stopped', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`)
        .run(campaignId)
      insertEvent(campaignId, 'campaign_stopped', actor, {})
      database.exec('COMMIT;')
    } catch (error) {
      rollback()
      throw error
    }
    return { ok: true, campaign: getCampaignByIdInternal(campaignId)! }
  }

  function cloneCampaign(sourceCampaignId: CampaignId, actor: CampaignActionActor): CloneCampaignResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const source = getCampaignByIdInternal(sourceCampaignId)
      if (source === null) {
        rollback()
        return { ok: false, reason: 'campaign_not_found' }
      }
      const newCampaignId = randomUUID()
      insertCampaignStatement.run(
        newCampaignId,
        source.name,
        source.startsAt,
        source.endsAt,
        source.unitNameSingular,
        source.unitNamePlural,
        source.giftSenderProfileId,
      )
      insertEvent(newCampaignId, 'campaign_cloned', actor, { sourceCampaignId })
      database.exec('COMMIT;')
      return { ok: true, campaign: getCampaignByIdInternal(newCampaignId)! }
    } catch (error) {
      rollback()
      throw error
    }
  }

  function softDeleteCampaign(campaignId: CampaignId, actor: CampaignActionActor): SoftDeleteCampaignResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = getCampaignByIdInternal(campaignId)
      if (existing === null) {
        rollback()
        return { ok: false, reason: 'campaign_not_found' }
      }
      if (existing.deletedAt !== null) {
        rollback()
        return { ok: false, reason: 'already_deleted' }
      }
      if (existing.status === 'active') {
        rollback()
        return { ok: false, reason: 'cannot_delete_active_campaign' }
      }
      database
        .prepare(`UPDATE campaigns SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`)
        .run(campaignId)
      insertEvent(campaignId, 'campaign_soft_deleted', actor, { previousStatus: existing.status })
      database.exec('COMMIT;')
    } catch (error) {
      rollback()
      throw error
    }
    return { ok: true, campaign: getCampaignByIdInternal(campaignId)! }
  }

  function getActiveCampaign(): CampaignRecord | null {
    const row = selectActiveCampaignStatement.get() as CampaignRow | undefined
    return row === undefined ? null : rowToCampaignRecord(row)
  }

  function listCampaigns(filter: ListCampaignsFilter = {}): CampaignRecord[] {
    const conditions: string[] = []
    const params: string[] = []
    if (filter.includeDeleted !== true) {
      conditions.push('deleted_at IS NULL')
    }
    if (filter.status !== undefined) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = database
      .prepare(`
        SELECT campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural,
               unit_icon_url, table_bg_desktop_url, table_bg_mobile_url, card_back_url,
               gift_sender_profile_id, archived_at, deleted_at, created_at, updated_at
        FROM campaigns
        ${whereClause}
        ORDER BY created_at DESC;
      `)
      .all(...params) as CampaignRow[]
    return rows.map(rowToCampaignRecord)
  }

  function listDueScheduledCampaignIds(now: Date, limit: number): CampaignId[] {
    const rows = selectDueScheduledIdsStatement.all(now.toISOString(), limit) as { campaign_id: string }[]
    return rows.map((row) => row.campaign_id)
  }

  function listDueActiveCampaignIds(now: Date, limit: number): CampaignId[] {
    const rows = selectDueActiveIdsStatement.all(now.toISOString(), limit) as { campaign_id: string }[]
    return rows.map((row) => row.campaign_id)
  }

  return {
    createDraftCampaign,
    updateCampaign,
    scheduleCampaign,
    activateCampaign,
    expireScheduledCampaignWithoutActivating,
    finishCampaign,
    stopCampaign,
    cloneCampaign,
    softDeleteCampaign,
    getCampaignById: getCampaignByIdInternal,
    getActiveCampaign,
    listCampaigns,
    listDueScheduledCampaignIds,
    listDueActiveCampaignIds,
    close: () => database.close(),
  }
}
