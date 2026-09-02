import { randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type HardDeleteProfileResult =
  | { ok: true; deletedProfileId: ProfileId; deletedAccountId: string | null }
  | { ok: false; code: 'not_found' | 'self' | 'invalid_reason' | 'active_tournament_dependency' }

/**
 * Non-terminal турнирни статуси (mirror на selectActiveEntryForAccountStatement
 * в tournamentEconomyStore.ts — единственият established "какво значи active
 * турнир" списък в кодовата база, reuse-нат тук вместо дублиран). Турнир в
 * този lifecycle все още може да получи нови действия (join/start/settle) —
 * hard delete на creator/participant тук би оставил живия турнир (или
 * останалите участници) в неконсистентно състояние.
 */
const ACTIVE_TOURNAMENT_STATUSES = ['open', 'starting', 'semifinal_in_progress', 'final_in_progress'] as const

/** Non-terminal entry статуси (профилът все още реално участва). */
const ACTIVE_ENTRY_STATUSES = ['confirmed', 'finalist'] as const

export type ProfileHardDeleteService = {
  /**
   * Единствен canonical hard-delete primitive за пълно, необратимо
   * премахване на човешки профил (admin moderation, spec §7-9) — mirror на
   * topicHardDeleteService.hardDeleteTopic-ия pattern (BEGIN IMMEDIATE, defense-
   * in-depth re-check вътре в транзакцията, audit ред ПРЕДИ destructive delete,
   * COMMIT; ROLLBACK+rethrow при грешка).
   *
   * Account cardinality (spec §8): profiles.account_id няма UNIQUE
   * constraint — един акаунт МОЖЕ да има повече от един профил (виж
   * authStore.login()'s "ORDER BY created_at ASC LIMIT 1" избор). Затова
   * акаунтът/email-ът се трие само ако това е ЕДИНСТВЕНИЯТ профил на този
   * акаунт (преброено вътре в СЪЩАТА транзакция) — иначе email-ът НЕ се
   * освобождава, а само self профилът изчезва (останалите профили на
   * акаунта, ако има такива, не се пипат).
   *
   * Active tournament guard (blocker fix round 2, §2): ако target е creator
   * на турнир с non-terminal status ИЛИ има active entry (status IN
   * confirmed/finalist) в такъв турнир, delete-ът се ОТКАЗВА с
   * 'active_tournament_dependency' — DELETE FROM profiles никога не бива да
   * каскадно изтрие/повреди ЖИВ (все още играещ се) турнир само защото
   * target е негов creator/participant, нито да остави останалите
   * участници в неконсистентно състояние. Admin трябва първо да BAN-не
   * профила (spec: "Admin може първо да BAN-не профила") — hard delete
   * остава възможен само след като турнирът стигне terminal lifecycle
   * (finished/cancelled/admin_cancelled/auto_cancelled/failed).
   *
   * Immutable deleted-profile identity (blocker fix round 2, §1/§2):
   * "historical row survives" != "historical identity survives" — преди
   * destructive DELETE FROM profiles снапваме target profileId в
   * *_snapshot колони БЕЗ FK (deleted_profile_id_snapshot / deleted_sender_
   * profile_id_snapshot / deleted_recipient_profile_id_snapshot / deleted_
   * creator_profile_id_snapshot, виж 20260902_002/20260902_003 migration-ите)
   * върху profile_bans, tournaments, tournament_entries,
   * tournament_economy_ledger, yellow_coin_gift_ledger (ОТДЕЛНО за sender И
   * recipient страна), match_economy_ledger, coin_purchase_ledger,
   * profile_name_change_ledger, vip_grants, vip_purchase_ledger,
   * table_exit_penalties, profile_match_results — за да остане
   * forensic-reconstructable "този ban/турнир/entry/ledger ред е бил на
   * deleted profile UUID X" дори след като живата FK колона се нулира от
   * cascade-а. Amount/balance/economy/резултат/timestamp/reason стойностите
   * НИКОГА не се променят — само атрибуцията се snapshot-ва.
   *
   * Плюс АГРЕГИРАН site_visit forensic snapshot (виж
   * captureVisitorForensicSnapshot по-долу) — директен източник е
   * site_visit_events.profile_id (round 2 корекция; site_visitors.first/
   * last_profile_id би пропуснал "A -> TARGET -> B" middle-profile сценарий,
   * виж коментара при captureVisitorForensicSnapshot). site_visit_events/
   * site_visitors НЕ се rebuild-ват (голяма/непрекъснато растяща analytics
   * таблица), вместо това at-delete-time snapshot агрегира по
   * (anonymous_visitor_id, ip_address) -> first/last seen + event_count в
   * нова dedicated таблица — reuse-ва съществуващия
   * idx_site_visit_events_profile_time индекс, никакъв нов индекс върху
   * high-write таблицата.
   *
   * FK cascade (server/database/migrations, verified inventory): DELETE FROM
   * profiles каскадно премахва ЖИВО/operational profile-owned state —
   * wallet/gallery/progress/friendships/лични и лоби чат съобщения/topic
   * съдържание/mission+reward progress и т.н. (ON DELETE CASCADE, категория
   * A). Financial/historical/forensic state (категория B) е ON DELETE SET
   * NULL, виж 20260902_002/20260902_003: profile_bans, yellow_coin_gift_ledger,
   * match_economy_ledger, coin_purchase_ledger, profile_name_change_ledger,
   * vip_grants, vip_purchase_ledger, table_exit_penalties,
   * profile_match_results, tournaments.creator_profile_id,
   * tournament_entries.profile_id. Плюс site_visit_events/ad_campaign audit
   * полета/topics.created_by_profile_id/tournament_economy_ledger/
   * tournament_events, които вече бяха SET NULL от самото начало. Всички
   * тези redове ПРЕЖИВЯВАТ delete-а непокътнати, СЪС запазена snapshot
   * атрибуция (умишлено, spec §9). Двете таблици БЕЗ FK въобще —
   * player_blocks (blocker/blocked по profile_id) — се чистят ръчно тук, за
   * да няма orphan rows; private_room_matches пази profileId само вътре в
   * JSON snapshot колони (team_a_json/team_b_json), е документирана
   * permanent-history таблица без cleanup job (виж migration коментара) —
   * исторически завършени мачове НЕ се пипат тук.
   */
  hardDeleteProfile: (input: {
    targetProfileId: ProfileId
    actorProfileId: ProfileId
    actorAccountId: string
    reason: string
  }) => HardDeleteProfileResult
  /**
   * Reuse-ва СЪЩИТЕ prepared statements/SQL като active tournament dependency
   * guard-а вътре в hardDeleteProfile (виж коментара там) — extracted като
   * публичен read-only pre-check (round 4 blocker fix), за да може
   * handleAdminProfileHardDeleteRequest да провери active tournament
   * dependency ПРЕДИ да реши дали да запише pending DELETE (при
   * isProfileInActiveGame===true target), вместо да рискува pending DELETE
   * да чака игра, чийто completion hook после да получи
   * 'active_tournament_dependency' от самия hardDeleteProfile и pending
   * реда да остане завинаги неизпълним. Няма собствена транзакция (чист
   * SELECT) — hardDeleteProfile пак re-check-ва authoritative вътре в своя
   * BEGIN IMMEDIATE при реалното изпълнение, за race-safety.
   */
  hasActiveTournamentDependency: (profileId: ProfileId) => boolean
  close: () => void
}

const MAX_REASON_LENGTH = 2000

export async function createProfileHardDeleteService(databaseFilePath: string): Promise<ProfileHardDeleteService> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectProfileForDeleteStatement = database.prepare(`
    SELECT profile_id, account_id, display_name, username
    FROM profiles
    WHERE profile_id = ?
    LIMIT 1;
  `)

  const countProfilesForAccountStatement = database.prepare(`
    SELECT COUNT(*) as cnt FROM profiles WHERE account_id = ?;
  `)

  const ACTIVE_STATUS_PLACEHOLDERS = ACTIVE_TOURNAMENT_STATUSES.map(() => '?').join(', ')
  const ACTIVE_ENTRY_STATUS_PLACEHOLDERS = ACTIVE_ENTRY_STATUSES.map(() => '?').join(', ')

  const selectActiveTournamentDependencyStatement = database.prepare(`
    SELECT tournament_id FROM tournaments
    WHERE creator_profile_id = ?
      AND status IN (${ACTIVE_STATUS_PLACEHOLDERS})
    LIMIT 1;
  `)

  const selectActiveEntryDependencyStatement = database.prepare(`
    SELECT te.entry_id
    FROM tournament_entries te
    JOIN tournaments t ON t.tournament_id = te.tournament_id
    WHERE te.profile_id = ?
      AND te.status IN (${ACTIVE_ENTRY_STATUS_PLACEHOLDERS})
      AND t.status IN (${ACTIVE_STATUS_PLACEHOLDERS})
    LIMIT 1;
  `)

  const deletePlayerBlocksStatement = database.prepare(`
    DELETE FROM player_blocks WHERE blocker_profile_id = ? OR blocked_profile_id = ?;
  `)

  const insertDeletionAuditStatement = database.prepare(`
    INSERT INTO admin_profile_deletions (
      log_id, deleted_profile_id, deleted_account_id, username_snapshot,
      deleted_by_profile_id, reason
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)

  // Immutable identity snapshot — попълва се ПРЕДИ DELETE FROM profiles, за
  // да остане "този ban/турнир/entry е бил на deleted profile UUID X"
  // reconstructable дори след като cascade-ът нулира живата FK колона.
  const snapshotProfileBansStatement = database.prepare(`
    UPDATE profile_bans
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  const snapshotTournamentsCreatorStatement = database.prepare(`
    UPDATE tournaments
    SET deleted_creator_profile_id_snapshot = ?
    WHERE creator_profile_id = ?;
  `)

  const snapshotTournamentEntriesStatement = database.prepare(`
    UPDATE tournament_entries
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  // tournament_economy_ledger.profile_id беше SET NULL от 20260730_002, но
  // табличният CHECK constraint реално НИКОГА не е позволявал NULL за
  // не-system_fee редове (latent bug, виж 20260902_003 migration коментара)
  // — снапваме ПРЕДИ delete-а, за да satisfy-нем поправения CHECK
  // (profile_id IS NULL е валиден само когато deleted_profile_id_snapshot
  // IS NOT NULL).
  const snapshotTournamentEconomyLedgerStatement = database.prepare(`
    UPDATE tournament_economy_ledger
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  // Financial/game-history immutable attribution (round 2 §2) — mirror на
  // profile_bans/tournaments pattern-а по-горе, за всяка от 8-те таблици,
  // конвертирани към SET NULL в 20260902_002. yellow_coin_gift_ledger има
  // ДВЕ независими snapshot колони (sender/recipient) — target профилът
  // може да е замесен като изпращач, получател, или и двете (различни
  // gift транзакции), затова двата UPDATE-а изпълняват независимо.
  const snapshotGiftLedgerSenderStatement = database.prepare(`
    UPDATE yellow_coin_gift_ledger
    SET deleted_sender_profile_id_snapshot = ?
    WHERE sender_profile_id = ?;
  `)

  const snapshotGiftLedgerRecipientStatement = database.prepare(`
    UPDATE yellow_coin_gift_ledger
    SET deleted_recipient_profile_id_snapshot = ?
    WHERE recipient_profile_id = ?;
  `)

  const snapshotMatchEconomyLedgerStatement = database.prepare(`
    UPDATE match_economy_ledger
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  const snapshotCoinPurchaseLedgerStatement = database.prepare(`
    UPDATE coin_purchase_ledger
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  const snapshotProfileNameChangeLedgerStatement = database.prepare(`
    UPDATE profile_name_change_ledger
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  const snapshotVipGrantsStatement = database.prepare(`
    UPDATE vip_grants
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  const snapshotVipPurchaseLedgerStatement = database.prepare(`
    UPDATE vip_purchase_ledger
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  const snapshotTableExitPenaltiesStatement = database.prepare(`
    UPDATE table_exit_penalties
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  const snapshotProfileMatchResultsStatement = database.prepare(`
    UPDATE profile_match_results
    SET deleted_profile_id_snapshot = ?
    WHERE profile_id = ?;
  `)

  // Forensic visitor snapshot (blocker round 2 корекция, spec: "deleted_profile_id
  // -> anonymous_visitor_id -> IP history / first_seen / last_seen / event_count").
  // Директен източник е site_visit_events.profile_id, НЕ site_visitors.first/
  // last_profile_id — site_visitors пази само first/last owner за ЦЕЛИЯ
  // visitor живот, затова "A -> TARGET -> B" сценарий (TARGET нито е first,
  // нито last owner на visitor V) би пропуснал TARGET изцяло, въпреки реални
  // TARGET events в site_visit_events. Query план (verified с EXPLAIN QUERY
  // PLAN): SEARCH site_visit_events USING INDEX idx_site_visit_events_profile_time
  // (profile_id=?) — вече съществуващ индекс, НЕ добавяме нов върху тази
  // high-write таблица (rare admin operation, bounded по единичния
  // profile_id, никакъв постоянен gameplay write overhead). GROUP BY минава
  // през temp B-tree, но обемът е bounded до events-ите САМО на този profile,
  // не целия table scan.
  //
  // COALESCE(ip_address, '') в GROUP BY — SQL NULL никога не се счита равен
  // на друг NULL, затова без coalesce множество събития без captured IP
  // биха създали дублирани редове вместо да се агрегират в един.
  const selectVisitorAggregatesForProfileStatement = database.prepare(`
    SELECT
      anonymous_visitor_id,
      ip_address,
      MIN(occurred_at) as first_seen_at,
      MAX(occurred_at) as last_seen_at,
      COUNT(*) as event_count
    FROM site_visit_events
    WHERE profile_id = ?
    GROUP BY anonymous_visitor_id, COALESCE(ip_address, '');
  `)

  const insertVisitorSnapshotStatement = database.prepare(`
    INSERT INTO admin_profile_deletion_visitor_snapshots (
      snapshot_id, deleted_profile_id, anonymous_visitor_id,
      ip_address, first_seen_at, last_seen_at, event_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (deleted_profile_id, anonymous_visitor_id, ip_address) DO UPDATE SET
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at,
      event_count = excluded.event_count;
  `)

  // Targeted risk-cache invalidation (production bug fix — hard delete
  // променя topology-то на linked group-ата, но cache редовете на
  // останалите linked profiles не бяха invalidated). Стъпка 1: target-ovите
  // distinct non-empty visitor ids, ПРЕДИ да ги изгубим (site_visit_events.
  // profile_id е ON DELETE SET NULL cascade — виж primitive doc коментара).
  // Reuse-ва idx_site_visit_events_profile_time, никакъв нов индекс.
  const selectDistinctVisitorIdsForProfileStatement = database.prepare(`
    SELECT DISTINCT anonymous_visitor_id
    FROM site_visit_events
    WHERE profile_id = ?
      AND anonymous_visitor_id IS NOT NULL
      AND anonymous_visitor_id != '';
  `)

  const deleteProfileStatement = database.prepare(`
    DELETE FROM profiles WHERE profile_id = ?;
  `)

  const deleteAccountStatement = database.prepare(`
    DELETE FROM accounts WHERE account_id = ?;
  `)

  function captureVisitorForensicSnapshot(profileId: string): void {
    const rows = selectVisitorAggregatesForProfileStatement.all(profileId) as Array<{
      anonymous_visitor_id: string
      ip_address: string | null
      first_seen_at: string
      last_seen_at: string
      event_count: number
    }>

    for (const row of rows) {
      insertVisitorSnapshotStatement.run(
        randomUUID(),
        profileId,
        row.anonymous_visitor_id,
        row.ip_address,
        row.first_seen_at,
        row.last_seen_at,
        row.event_count,
      )
    }
  }

  /**
   * Targeted invalidation (spec: НЕ global scan) на risk cache редове за
   * останалите CURRENT profiles, споделящи поне един от target-овите
   * visitor ids — извиква се ПРЕДИ deleteProfileStatement.run() по-долу,
   * докато target-овата site_visit_events attribution все още е налична
   * (виж selectDistinctVisitorIdsForProfileStatement коментара). Стъпка 2
   * reuse-ва idx_site_visit_events_visitor_time (същия index/pattern като
   * adminProfileRiskStore.findProfilesForVisitorIds) — bounded само към
   * target-овите visitor ids, не whole-table scan. JOIN към profiles
   * гарантира "CURRENT profiles" (hard-deleted профили вече нямат ред там).
   *
   * Само маркира check_complete=0 — НЕ пипа linked_profiles_count тук.
   * Existing lazy list flow (computeAndCacheRiskForProfiles) прави пълен
   * recompute самò когато affected профилът реално попадне в admin list
   * (Днес/Вчера/Всички), точно както при обикновен "нов linked partner"
   * discovery. Профил без съществуващ cache ред просто не се засяга от
   * UPDATE-а — няма какво да се invalidate-ва.
   */
  function invalidateAffectedRiskCache(targetProfileId: string): void {
    const visitorIdRows = selectDistinctVisitorIdsForProfileStatement.all(targetProfileId) as Array<{
      anonymous_visitor_id: string
    }>
    if (visitorIdRows.length === 0) return

    const visitorIds = visitorIdRows.map((row) => row.anonymous_visitor_id)
    const visitorPlaceholders = visitorIds.map(() => '?').join(', ')

    const affectedProfileRows = database.prepare(`
      SELECT DISTINCT sve.profile_id AS profileId
      FROM site_visit_events sve
      JOIN profiles p ON p.profile_id = sve.profile_id
      WHERE sve.anonymous_visitor_id IN (${visitorPlaceholders})
        AND sve.profile_id IS NOT NULL
        AND sve.profile_id != ?
    `).all(...visitorIds, targetProfileId) as Array<{ profileId: string }>

    if (affectedProfileRows.length === 0) return

    const affectedProfileIds = affectedProfileRows.map((row) => row.profileId)
    const affectedPlaceholders = affectedProfileIds.map(() => '?').join(', ')

    database.prepare(`
      UPDATE admin_profile_risk_checks
      SET check_complete = 0
      WHERE profile_id IN (${affectedPlaceholders});
    `).run(...affectedProfileIds)
  }

  function hasActiveTournamentDependency(profileId: ProfileId): boolean {
    const tournamentDependency = selectActiveTournamentDependencyStatement.get(
      profileId,
      ...ACTIVE_TOURNAMENT_STATUSES,
    )
    if (tournamentDependency !== undefined) {
      return true
    }

    const entryDependency = selectActiveEntryDependencyStatement.get(
      profileId,
      ...ACTIVE_ENTRY_STATUSES,
      ...ACTIVE_TOURNAMENT_STATUSES,
    )
    return entryDependency !== undefined
  }

  function hardDeleteProfile(input: {
    targetProfileId: ProfileId
    actorProfileId: ProfileId
    actorAccountId: string
    reason: string
  }): HardDeleteProfileResult {
    if (input.targetProfileId === input.actorProfileId) {
      return { ok: false, code: 'self' }
    }

    const reason = input.reason.trim()
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      return { ok: false, code: 'invalid_reason' }
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      const profileRow = selectProfileForDeleteStatement.get(input.targetProfileId) as
        | { profile_id: string; account_id: string | null; display_name: string; username: string | null }
        | undefined

      if (profileRow === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'not_found' }
      }

      // Defense-in-depth self-check вътре в транзакцията — mirror на
      // topicHardDeleteService-ия "guard-вай authoritative вътре в самия
      // primitive, не само upstream" convention.
      if (profileRow.profile_id === input.actorProfileId) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'self' }
      }

      // Active tournament dependency guard (spec §2A) — re-checked вътре в
      // транзакцията (BEGIN IMMEDIATE вече е взел writer lock-а), race-safe
      // спрямо конкурентен join/start/settle. Отказваме delete-а изцяло,
      // вместо да импровизираме auto-cancel/refund логика тук. Reuse-ва
      // СЪЩАТА hasActiveTournamentDependency функция като публичния
      // pre-check по-горе — единствен source на тази SQL логика.
      if (hasActiveTournamentDependency(profileRow.profile_id)) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'active_tournament_dependency' }
      }

      const usernameSnapshot = profileRow.username?.trim() || profileRow.display_name

      // Audit редът се пише ПРЕДИ destructive delete-а, в СЪЩАТА транзакция
      // (spec §9) — deleted_profile_id/deleted_account_id нямат FK (виж
      // migration коментара), затова физически преживяват DELETE-ите по-долу
      // непокътнати, дори ако delete-ът се провали и rollback-не, audit
      // insert-ът се rollback-ва заедно с него (atomic "или всичко, или нищо").
      insertDeletionAuditStatement.run(
        randomUUID(),
        profileRow.profile_id,
        profileRow.account_id,
        usernameSnapshot,
        input.actorProfileId,
        reason,
      )

      // Immutable identity snapshot — ПРЕДИ DELETE FROM profiles (виж
      // primitive-ия doc коментар по-горе).
      snapshotProfileBansStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotTournamentsCreatorStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotTournamentEntriesStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotTournamentEconomyLedgerStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotGiftLedgerSenderStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotGiftLedgerRecipientStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotMatchEconomyLedgerStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotCoinPurchaseLedgerStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotProfileNameChangeLedgerStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotVipGrantsStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotVipPurchaseLedgerStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotTableExitPenaltiesStatement.run(profileRow.profile_id, profileRow.profile_id)
      snapshotProfileMatchResultsStatement.run(profileRow.profile_id, profileRow.profile_id)
      captureVisitorForensicSnapshot(profileRow.profile_id)

      // Виж invalidateAffectedRiskCache doc коментара — трябва да се
      // изпълни ПРЕДИ deleteProfileStatement.run() по-долу (target-овата
      // site_visit_events attribution още е налична в тази точка).
      invalidateAffectedRiskCache(profileRow.profile_id)

      // Таблици без FK към profiles — cascade НЯМА да ги пипне, чистим ръчно
      // за да няма orphan rows (spec §8/§11).
      deletePlayerBlocksStatement.run(input.targetProfileId, input.targetProfileId)

      deleteProfileStatement.run(input.targetProfileId)

      let deletedAccountId: string | null = null
      if (profileRow.account_id !== null) {
        const remainingProfilesForAccount = (
          countProfilesForAccountStatement.get(profileRow.account_id) as { cnt: number }
        ).cnt
        // profiles.account_id няма UNIQUE constraint (spec §7: 1 акаунт : N
        // профила) — акаунтът/email-ът се трие САМО ако профилът, който
        // тъкмо изтрихме по-горе, е бил ЕДИНСТВЕНИЯТ, свързан с този акаунт.
        // account_sessions каскадно изчезва с accounts (виж migration-а),
        // затова не е нужен отделен DELETE тук.
        if (remainingProfilesForAccount === 0) {
          deleteAccountStatement.run(profileRow.account_id)
          deletedAccountId = profileRow.account_id
        }
      }

      database.exec('COMMIT;')

      return { ok: true, deletedProfileId: profileRow.profile_id, deletedAccountId }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }
      throw error
    }
  }

  function close(): void {
    database.close()
  }

  return {
    hardDeleteProfile,
    hasActiveTournamentDependency,
    close,
  }
}
