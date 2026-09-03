import { randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type HardDeleteProfileResult =
  | { ok: true; deletedProfileId: ProfileId; deletedAccountId: string | null }
  | {
      ok: false
      code:
        | 'not_found'
        | 'self'
        | 'invalid_reason'
        | 'active_tournament_dependency'
        | 'invalid_support_request_message'
    }

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
   * атрибуция (умишлено, spec §9). Таблиците БЕЗ FK въобще —
   * player_blocks (blocker/blocked по profile_id) — се чистят ръчно тук, за
   * да няма orphan rows; private_room_matches пази profileId само вътре в
   * JSON snapshot колони (team_a_json/team_b_json), е документирана
   * permanent-history таблица без cleanup job (виж migration коментара) —
   * исторически завършени мачове НЕ се пипат тук. support_messages/
   * support_archived/support_message_attachments също нямат FK ("Връзка с
   * екипа" support chat) — умишлено НЕ се трият/пипат тук.
   *
   * Support deletion archive (EXPLICIT ATTRIBUTION ONLY, round 2 корекция):
   * support_deletion_archives ред се записва ПРЕДИ DELETE FROM profiles
   * ЕДИНСТВЕНО когато input.supportRequestMessageId е подаден И валидиран
   * вътре в тази транзакция (виж selectSupportRequestMessageForValidationStatement
   * по-долу — съобщението трябва да съществува, да принадлежи на target
   * profile_id, и да е is_from_admin=0). Provенансът е "admin изрично избра
   * ТОВА user съобщение като deletion request" (support chat UI-я "Изтрий
   * профила по тази заявка" бутон) — НЕ automatic "последно съобщение в
   * разговора". Ако supportRequestMessageId липсва (нормален profile-popup
   * delete flow) ИЛИ валидацията се провали, НЕ се създава archive ред —
   * при провалена валидация ЦЕЛИЯТ delete се отказва (ROLLBACK, код
   * 'invalid_support_request_message'), не просто се пропуска archive-а.
   *
   * Avatar/gallery physical file cleanup (production gap fix): DELETE FROM
   * profiles каскадно чисти profile_gallery_images DB редовете (ON DELETE
   * CASCADE), но НЕ пипа физическите файлове на диска — нито тях, нито
   * target-овия качен avatar. Виж collectUploadedFileUrlsForProfile/
   * deleteUploadedFilesBestEffort по-долу: canonical URL списъкът се събира
   * ПРЕДИ DELETE FROM profiles (докато DB attribution още е налична),
   * физическият unlink се await-ва СЛЕД успешен COMMIT (затова функцията е
   * async — виж call site-а: НАРОЧНО извън transaction try/catch-а, за да
   * не се опита ROLLBACK след вече успешен COMMIT и за да не превърне fs
   * грешка в подвеждащ "delete failed" за профил, вече физически изтрит от
   * DB), reuse-вайки СЪЩИЯ upload-path safety helper като normal
   * avatar-swap/gallery-delete flow-овете (index.ts's deleteUploadFileByUrl,
   * инжектиран през ProfileHardDeleteFileCleanupDeps) — default preset
   * avatars (`/assets/avatars/...`) и path traversal са защитени там, не
   * тук. Shared-avatar safety: avatar uploads живеят в ЕДНА flat директория
   * (за разлика от gallery, per-profile subdirectory) — ако друг CURRENT
   * profile реферира СЪЩИЯ avatar_url, физическият файл НЕ се unlink-ва
   * (виж isAvatarUrlSharedWithAnotherProfile).
   */
  hardDeleteProfile: (input: {
    targetProfileId: ProfileId
    actorProfileId: ProfileId
    actorAccountId: string
    reason: string
    /**
     * Optional — само когато admin е натиснал "Изтрий профила по тази
     * заявка" от вътре в конкретен support разговор (виж doc коментара
     * по-горе). Validate-ва се authoritative вътре в транзакцията, НЕ се
     * приема на доверие от клиента.
     */
    supportRequestMessageId?: string | null
  }) => Promise<HardDeleteProfileResult>
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

export type ProfileHardDeleteFileCleanupDeps = {
  /**
   * Reuse-ва СЪЩИЯ helper като avatar-swap/gallery-delete flow-овете в
   * index.ts (index.ts's deleteUploadFileByUrl) — единствен source на
   * upload-path safety тук: no-op за всичко извън UPLOADS_ROUTE_PREFIX
   * (защитава default `/assets/avatars/...` presets от случайно unlink),
   * resolve()+whitelist-check срещу PUBLIC_UPLOAD_SUBDIRECTORY_ROOTS (защита
   * от path traversal дори при повреден/подправен DB URL), ENOENT
   * third-party-safe (missing file = вече чисто). Инжектирана като функция
   * (не import на index.ts константи/helper-и) — profileHardDeleteService.ts
   * е db-слой модул, index.ts вече го import-ва обратно (createProfileHardDeleteService),
   * затова директен import в обратната посока би бил circular; DI по същия
   * начин като databaseFilePath избягва това изцяло.
   */
  deleteUploadFileByUrl: (uploadUrl: string) => Promise<void>
}

export async function createProfileHardDeleteService(
  databaseFilePath: string,
  fileCleanup: ProfileHardDeleteFileCleanupDeps,
): Promise<ProfileHardDeleteService> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectProfileForDeleteStatement = database.prepare(`
    SELECT profile_id, account_id, display_name, username, avatar_url
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

  // support_messages/support_archived нямат FK към profiles (виж
  // 20260903_003 migration коментара) — DELETE FROM profiles не ги пипа
  // изобщо, разговорът просто остава orphaned БЕЗ маркер, че профилът е
  // изтрит.
  //
  // EXPLICIT ATTRIBUTION ONLY (round 2 корекция) — support_deletion_archives
  // ред се създава ЕДИНСТВЕНО когато admin изрично е избрал конкретно
  // user-authored съобщение ("Изтрий профила по тази заявка" бутон в
  // support chat UI-я), НЕ automatic "последно съобщение в разговора"
  // (предишен design, отхвърлен — несвързан стар support разговор би могъл
  // подвеждащо да изглежда като доказателство за user-initiated delete,
  // дори когато admin-ът трие профила по съвсем друга причина). Клиентът
  // подава supportRequestMessageId като arbitrary string — hard-delete
  // service-ът е authoritative и ГО validate-ва тук, ВЪТРЕ в транзакцията,
  // срещу самата profiles/support_messages истина (не приема client claim
  // на доверие):
  //   1. съобщението съществува;
  //   2. message.profile_id === target profile_id (не чуждо съобщение);
  //   3. is_from_admin = 0 (user-authored, не admin reply);
  // Ако валидацията се провали, целият hard delete се отказва (ROLLBACK,
  // без partial archive, без profile deletion) — виж hardDeleteProfile.
  const selectSupportRequestMessageForValidationStatement = database.prepare(`
    SELECT message_id, profile_id, is_from_admin, created_at FROM support_messages
    WHERE message_id = ?
    LIMIT 1;
  `)

  const insertSupportDeletionArchiveStatement = database.prepare(`
    INSERT INTO support_deletion_archives (
      archive_id, profile_id, username_snapshot, display_name_snapshot,
      request_message_id, requested_at, deleted_by_profile_id, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
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

  // Avatar/gallery physical file cleanup (production gap fix) — profiles.
  // avatar_url вече е прочетен през selectProfileForDeleteStatement.
  // profile_gallery_images.image_url/thumbnail_url трябва да се прочетат
  // ТУК, ПРЕДИ DELETE FROM profiles по-долу — редовете са ON DELETE CASCADE
  // (виж 20260510_004 migration-а), затова физически изчезват от DB веднага
  // след delete-а (правилно за DB attribution), но ако не сме прочели
  // image_url стойностите преди това, губим единствения source за кои
  // физически файлове да unlink-нем.
  const selectGalleryImageUrlsForProfileStatement = database.prepare(`
    SELECT image_url, thumbnail_url
    FROM profile_gallery_images
    WHERE profile_id = ?;
  `)

  // Shared-avatar safety — avatar uploads живеят в ЕДНА flat директория
  // (AVATAR_UPLOADS_PATH), споделена между ВСИЧКИ профили (за разлика от
  // gallery, което е per-profile subdirectory и структурно не може да
  // колизира между профили). Няма UNIQUE constraint върху profiles.avatar_url
  // — ако друг CURRENT профил случайно/бъдещо реферира СЪЩИЯ URL, unlink на
  // target-овия avatar би счупил чужд, все още жив avatar. profile_id != ?
  // изключва target-а самия (по дизайн винаги "споделя" URL-а със себе си).
  // Няма индекс върху avatar_url — рядка admin операция, table scan е ОК.
  const selectOtherProfileUsingAvatarUrlStatement = database.prepare(`
    SELECT profile_id
    FROM profiles
    WHERE avatar_url = ?
      AND profile_id != ?
    LIMIT 1;
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

  /**
   * true, ако СЪЩИЯТ avatarUrl все още е реферира от друг (различен от
   * excludeProfileId) CURRENT профил — извиква се ПРЕДИ delete-а, докато
   * target-овият собствен ред все още съществува (изключен explicit по
   * profile_id, не разчита на реда вече да е трит).
   */
  function isAvatarUrlSharedWithAnotherProfile(avatarUrl: string, excludeProfileId: string): boolean {
    return selectOtherProfileUsingAvatarUrlStatement.get(avatarUrl, excludeProfileId) !== undefined
  }

  /**
   * Canonical list на target-овите upload-ed (НЕ default preset) файлове —
   * извикано ПРЕДИ deleteProfileStatement.run(), докато profile_gallery_images
   * редовете още не са cascade-delete-нати. avatar_url може да е default
   * preset (`/assets/avatars/...`, client-side static asset — НЕ живее под
   * server upload директориите) или реален upload (`/uploads/avatars/...`)
   * — не филтрираме тук explicit по префикс, защото fileCleanup.deleteUploadFileByUrl
   * вече прави точно тази проверка (no-op за всичко извън `/uploads/`).
   * Avatar-ът допълнително се пропуска, ако друг CURRENT профил го споделя
   * (виж isAvatarUrlSharedWithAnotherProfile) — gallery images НЯМАТ такава
   * проверка, защото живеят в per-profile subdirectory (структурно
   * unshareable между профили). Set дедупликира в случай
   * image_url===thumbnail_url (винаги е така в текущия upload flow, но
   * schema-та технически позволява различни стойности).
   */
  function collectUploadedFileUrlsForProfile(profileId: string, avatarUrl: string | null): string[] {
    const urls = new Set<string>()

    if (
      avatarUrl !== null &&
      avatarUrl.trim().length > 0 &&
      !isAvatarUrlSharedWithAnotherProfile(avatarUrl, profileId)
    ) {
      urls.add(avatarUrl)
    }

    const galleryRows = selectGalleryImageUrlsForProfileStatement.all(profileId) as Array<{
      image_url: string
      thumbnail_url: string
    }>
    for (const row of galleryRows) {
      urls.add(row.image_url)
      urls.add(row.thumbnail_url)
    }

    return [...urls]
  }

  /**
   * Физическият unlink се await-ва ТУК, best-effort, СЛЕД успешен COMMIT
   * (виж call site-а в hardDeleteProfile, НАРОЧНО извън transaction
   * try/catch-а) — SQLite транзакция не може да rollback-не filesystem
   * unlink, а commit-ът вече е необратим success в тази точка, затова целта
   * е "когато hardDeleteProfile() приключи, всички възможни filesystem
   * delete attempts вече да са изпълнени", НЕ fire-and-forget. Best-effort
   * остава best-effort на per-file ниво (не общо): missing file (ENOENT) и
   * реална fs грешка се обработват вътре в deleteUploadFileByUrl самия
   * (ENOENT тихо success, реална грешка логната веднъж, никога не се крие);
   * fileCleanup.deleteUploadFileByUrl по договор никога не reject-ва,
   * затова Promise.all тук не може да хвърли — call site-ът все пак пази
   * defensive try/catch (виж коментара там), за да не превърне евентуална
   * бъдеща промяна в contract-а в подвеждащ "delete failed" за профил, вече
   * физически изтрит от DB.
   */
  async function deleteUploadedFilesBestEffort(urls: string[]): Promise<void> {
    if (urls.length === 0) return
    await Promise.all(urls.map((url) => fileCleanup.deleteUploadFileByUrl(url)))
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

  async function hardDeleteProfile(input: {
    targetProfileId: ProfileId
    actorProfileId: ProfileId
    actorAccountId: string
    reason: string
    supportRequestMessageId?: string | null
  }): Promise<HardDeleteProfileResult> {
    if (input.targetProfileId === input.actorProfileId) {
      return { ok: false, code: 'self' }
    }

    const reason = input.reason.trim()
    if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
      return { ok: false, code: 'invalid_reason' }
    }

    // Попълва се само по success-пътя вътре в try-а по-долу, ПРЕДИ COMMIT —
    // всеки друг път (not_found/self/active_tournament_dependency) връща
    // директно ОТВЪТРЕ try-а, затова кодът СЛЕД try/catch-а долу се
    // изпълнява само когато committedResult реално е зададен.
    let committedResult: { deletedProfileId: string; deletedAccountId: string | null } | null = null
    let uploadedFileUrlsToDelete: string[] = []

    database.exec('BEGIN IMMEDIATE;')
    try {
      const profileRow = selectProfileForDeleteStatement.get(input.targetProfileId) as
        | { profile_id: string; account_id: string | null; display_name: string; username: string | null; avatar_url: string | null }
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

      // Support deletion archive — EXPLICIT ATTRIBUTION ONLY (виж primitive-ия
      // doc коментар по-горе). supportRequestMessageId идва от клиента като
      // arbitrary string — authoritative validation ТУК, вътре в транзакцията,
      // срещу самата support_messages истина, преди какъвто и да е destructive
      // ред по-долу. Провал на КОЯТО и да е проверка отказва ЦЕЛИЯ delete
      // (ROLLBACK, без partial archive, без profile deletion) — не деградира
      // тихо до "просто без archive".
      let validatedSupportRequestMessage: { message_id: string; created_at: string } | null = null
      if (input.supportRequestMessageId != null && input.supportRequestMessageId !== '') {
        const messageRow = selectSupportRequestMessageForValidationStatement.get(
          input.supportRequestMessageId,
        ) as
          | { message_id: string; profile_id: string; is_from_admin: number; created_at: string }
          | undefined

        const isValid =
          messageRow !== undefined &&
          messageRow.profile_id === profileRow.profile_id && // (2) принадлежи на target profile
          messageRow.is_from_admin === 0 // (3) user-authored, не admin reply

        if (!isValid) {
          database.exec('ROLLBACK;')
          return { ok: false, code: 'invalid_support_request_message' }
        }

        validatedSupportRequestMessage = { message_id: messageRow.message_id, created_at: messageRow.created_at }
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

      // Support chat evidence preservation (spec §A/§B) — archive редът се
      // пише ЕДИНСТВЕНО когато supportRequestMessageId е бил подаден И
      // валидиран по-горе (validatedSupportRequestMessage !== null).
      // support_messages няма FK към profiles (виж 20260903_003 migration
      // коментара), затова редовете физически преживяват DELETE FROM
      // profiles по-долу без никаква промяна — archive редът тук е
      // ЕДИНСТВЕНО marker+snapshot (кой профил е бил, кое КОНКРЕТНО user
      // съобщение е поискало изтриването, кога е изпълнено), НЕ copy на
      // самите съобщения (spec §E "минимален архив"). Нормален admin
      // hard-delete БЕЗ supportRequestMessageId НЕ създава archive ред тук
      // изобщо, дори ако профилът има support история — избягва подвеждащо
      // representation на несвързан разговор като "user request" evidence.
      if (validatedSupportRequestMessage !== null) {
        insertSupportDeletionArchiveStatement.run(
          randomUUID(),
          profileRow.profile_id,
          usernameSnapshot,
          profileRow.display_name,
          validatedSupportRequestMessage.message_id,
          validatedSupportRequestMessage.created_at,
          input.actorProfileId,
          reason,
        )
      }

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

      // Виж collectUploadedFileUrlsForProfile doc коментара — трябва да се
      // изпълни ПРЕДИ deleteProfileStatement.run() по-долу (profile_gallery_images
      // редовете още не са cascade-delete-нати в тази точка).
      uploadedFileUrlsToDelete = collectUploadedFileUrlsForProfile(
        profileRow.profile_id,
        profileRow.avatar_url,
      )

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

      committedResult = { deletedProfileId: profileRow.profile_id, deletedAccountId }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }
      throw error
    }

    // Физическият cleanup стои НАРОЧНО извън transaction try/catch-а по-горе
    // (виж deleteUploadedFilesBestEffort doc коментара) — DB commit-ът вече
    // е необратим success в тази точка (committedResult е зададен само по
    // success-пътя, всеки друг път вече е return-нал отвътре try-а по-горе).
    // Defensive try/catch тук (не разчитаме единствено на
    // deleteUploadFileByUrl's "никога не reject-ва" договор) — реална fs
    // грешка се логва, но НИКОГА не прави hardDeleteProfile да throw-не/
    // върне "not ok" за профил, вече физически изтрит от DB; НЕ опитваме
    // ROLLBACK тук — commit-ът вече е committed, rollback след COMMIT е
    // невалидна операция.
    try {
      await deleteUploadedFilesBestEffort(uploadedFileUrlsToDelete)
    } catch (error) {
      console.error(
        `[profile-hard-delete] Physical file cleanup неуспешен profileId=${committedResult.deletedProfileId}:`,
        error,
      )
    }

    return { ok: true, deletedProfileId: committedResult.deletedProfileId, deletedAccountId: committedResult.deletedAccountId }
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
