import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const LAFCHE_TOPIC_ID = 'topic-lafche'

/**
 * Фиксиран literal ID на системния "Общи" контейнер (is_general=1, slug='general'),
 * seed-нат idempotently в 20260810_002_create_topics_and_messages.sql —
 * mirror на LAFCHE_TOPIC_ID константата по-горе. Използва се от
 * findInactiveRootCandidates/hardDeleteRoot caller-а в index.ts, за да не
 * се разпилява magic string литерал.
 */
export const GENERAL_TOPIC_ID = 'topic-general'

/**
 * Единственият authoritative списък с роли, чиито теми НИКОГА не влизат в
 * 72h inactivity victim set-а (само ръчен "кошче" hard delete може да ги
 * премахне) — реферира се и от SQL exclusion-а в findInactivityCandidates,
 * и от isTopicAutoDeleteExemptByAuthorRole по-долу, за да няма дублиран
 * role list на две места. Стойността се сравнява срещу
 * `topics.created_by_role` — immutable snapshot, captured ЕДИНСТВЕНО в
 * момента на създаване (topicStore.createTopic), никога derived от текущата
 * роля на автора при cleanup run-а.
 */
export const TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES = [
  'admin',
  'subadmin',
  'chat_admin',
  'top_chat_admin',
  'pika_team',
] as const

/**
 * Race/promotion-immune по конструкция — вход е persisted snapshot
 * стойността (`topics.created_by_role` за whole-topic cleanup, ИЛИ
 * `topic_messages.sender_role` на самия ROOT за root-level cleanup вътре в
 * topic-general — виж findInactiveRootCandidates по-долу), НЕ live lookup
 * към текущата роля на профила. `null` (legacy теми/roots, създадени преди
 * съответната колона да съществува, или системни topic-general/topic-lafche
 * редове) се третира като "не е доказано privileged" ⇒ НЕ exempt —
 * най-консервативният избор, виж migration коментара в
 * 20260901_001_add_created_by_role_to_topics.sql. ВАЖНО: за root-level
 * exemption входът е ролята на АВТОРА НА САМИЯ ROOT, никога ролята на
 * последния reply автор — reply от privileged роля в чужд root НЕ протектва
 * root-а (production incident: root създаден от 'player', последен reply от
 * 'pika_team' — root-ът остава напълно eligible за 72h cleanup).
 */
export function isTopicAutoDeleteExemptByAuthorRole(createdByRole: string | null): boolean {
  return createdByRole !== null && (TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES as readonly string[]).includes(createdByRole)
}

export type HardDeleteTopicReason = 'inactivity_expired' | 'manual_moderation_delete'

export type HardDeleteTopicActorRole = 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin'

export type HardDeleteTopicActor = {
  accountId: string
  role: HardDeleteTopicActorRole
}

export type HardDeleteTopicResult =
  | {
      ok: true
      topicId: string
      deletedRootCount: number
      deletedReplyCount: number
      deletedAttachmentFilenames: string[]
    }
  | { ok: false; code: 'not_found' | 'protected_topic' | 'no_longer_eligible' }

export type InactivityCandidate = {
  topicId: string
  lastActivityAt: string
}

export type InactiveRootCandidate = {
  topicId: string
  rootMessageId: string
  lastActivityAt: string
}

export type HardDeleteRootResult =
  | {
      ok: true
      topicId: string
      rootMessageId: string
      deletedReplyCount: number
      deletedAttachmentFilenames: string[]
    }
  | { ok: false; code: 'not_found' | 'protected_topic' | 'no_longer_eligible' }

export type TopicHardDeleteService = {
  /**
   * Единствен canonical hard-delete primitive за whole-topic removal —
   * извикван и от manual "кошче" flow (reason='manual_moderation_delete'),
   * и от hourly inactivity cleanup (reason='inactivity_expired'). Изтрива
   * ФИЗИЧЕСКИ topics/topic_messages redovete (не soft-delete) в ЕДНА
   * BEGIN IMMEDIATE транзакция — виж имплементацията за пълния FK
   * cascade rationale. `topic_message_attachments` redovete се hard-delete-ват
   * и enqueue-ват за физически file cleanup ВЪТРЕ в СЪЩАТА транзакция —
   * caller-ът НЕ трябва да enqueue-ва повторно.
   *
   * Guard-ва вградено `topic-general`/`topic-lafche` — извикването никога
   * не хард-трие тези две резервирани теми, независимо от reason/actor,
   * връща `{ ok:false, code:'protected_topic' }` вместо да throw-не, за да
   * не се налага duplicate guard логика на всеки caller (defense-in-depth,
   * mirror на handleTopicDeleteRequest-ия explicit LAFCHE_TOPIC_ID check,
   * но authoritative тук, в самия primitive).
   *
   * Idempotent: вече-несъществуваща тема → `{ ok:false, code:'not_found' }`,
   * safe за повторно/конкурентно извикване (manual delete + cleanup race,
   * виж findInactivityCandidates коментара).
   */
  hardDeleteTopic: (input: {
    topicId: string
    reason: HardDeleteTopicReason
    /**
     * ЗАДЪЛЖИТЕЛЕН за reason='inactivity_expired' (automatic cleanup) —
     * final race-safe re-validation: темата се трие ТОЛКОВА, ако все още
     * няма жива активност СЛЕД този cutoff, проверено ВЪТРЕ в СЪЩАТА
     * BEGIN IMMEDIATE транзакция като самия DELETE (spec §8). Ако нов
     * reply/root е пристигнал между candidate scan-а и това извикване,
     * връща `{ ok:false, code:'no_longer_eligible' }` вместо да трие.
     * Игнориран за reason='manual_moderation_delete' (moderator delete е
     * винаги immediate, без activity condition — spec §5).
     */
    inactivityCutoff?: Date
    /**
     * Moderator identity + reason text — ЗАДЪЛЖИТЕЛЕН за
     * reason='manual_moderation_delete' (persisted accountability trail,
     * виж insertModerationAuditRowStatement коментара по-долу). Игнориран за
     * reason='inactivity_expired' — automatic cleanup няма реален actor,
     * не пише persisted audit ред (само console.log diagnostics в index.ts,
     * established convention за purge-type jobs).
     */
    actor?: HardDeleteTopicActor
    auditReason?: string
  }) => HardDeleteTopicResult

  /**
   * Bulk candidate discovery за 72-часовия inactivity cleanup — използва
   * СЪЩЕСТВУВАЩИЯ `topic_root_latest_seq` материализиран индекс (root
   * PK lookup към topic_messages.seq, О(1) per candidate join), НЕ пълен
   * table scan на topic_messages. Изключва General/Лафче/removed автоматично
   * (виж имплементацията; locked темите СА included — lock е write-restriction,
   * не lifecycle state). Boundary policy: `lastActivityAt <= cutoff` (spec
   * §2 — "71h59m остава, >72h трие" ⇔ cutoff = now-72h, inclusive `<=` на
   * cutoff-а самия улавя точно "72h и повече"). Final re-validation
   * непосредствено преди destructive delete е caller-ова отговорност
   * (виж hardDeleteTopic race бележката) — тази функция е read-only scan,
   * НИКОГА не трие нищо.
   */
  findInactivityCandidates: (cutoff: Date, limit: number) => InactivityCandidate[]

  /**
   * Root-level bulk candidate discovery — за container-теми, чиито
   * `topics` row НИКОГА не hard-delete-ва се цялостно (в момента само
   * `is_general=1`, т.е. topic-general/"Общи"; Лафче е самостоятелна
   * LAFCHE_TOPIC_ID тема, извън тази container категория). За такива теми
   * user-visible "темите" на екрана СА отделните root threads вътре в
   * контейнера (виж production forensic report — topic-general съдържа
   * десетки независими root_message_id редове в topic_root_latest_seq, ПО
   * ЕДИН на всеки видим "пост"), затова 72h expiry трябва да работи на ROOT
   * ниво, не на topics-row ниво (за разлика от findInactivityCandidates
   * по-горе, който explicit изключва is_general=1 изцяло от whole-topic
   * victim set-а). Exemption проверката тук е върху `topic_messages.sender_role`
   * НА САМИЯ ROOT (snapshot в момента на писане, mirror на
   * isTopicAutoDeleteExemptByAuthorRole) — НЕ ролята на последния reply
   * автор: reply от privileged роля в чужд root не protect-ва root-а (виж
   * production incident: root от 'player', последен reply от 'pika_team' —
   * root-ът остава eligible). Boundary policy identична на
   * findInactivityCandidates: `lastActivityAt <= cutoff`. Query план: range
   * scan на idx_topic_root_latest_seq_topic_seq (topic_id, latest_seq) +
   * O(1) PK lookup topic_messages.seq — без нов index, без table scan.
   */
  findInactiveRootCandidates: (containerTopicId: string, cutoff: Date, limit: number) => InactiveRootCandidate[]

  /**
   * Root-level hard-delete primitive — премахва ФИЗИЧЕСКИ само един root
   * thread (root съобщение + всичките му replies + техните attachments +
   * topic_root_latest_seq реда му) ВЪТРЕ в container-тема, която самата
   * ОСТАВА напълно непокътната (`topics` row-ът никога не се пипа). Reuse-ва
   * self-referencing FK cascade-а на topic_messages (parent_message_id →
   * topic_messages.message_id ON DELETE CASCADE) — DELETE FROM topic_messages
   * WHERE message_id = rootMessageId автоматично маха и живите, и вече
   * soft-deleted replies, и topic_root_latest_seq реда (FK ON DELETE
   * CASCADE), и topic_message_attachments редовете за root+replies (FK ON
   * DELETE CASCADE) — mirror на hardDeleteTopic-ия "DELETE FROM topics
   * cascades to topic_messages" pattern, само с root_message_id вместо
   * topic_id като anchor. Attachment файловете се enqueue-ват за физически
   * cleanup ПРЕДИ cascade delete-а, в СЪЩАТА транзакция (mirror на
   * hardDeleteTopic).
   *
   * Race-safe final re-validation ВЪТРЕ в BEGIN IMMEDIATE (mirror на
   * hardDeleteTopic spec §8): re-чете latest_seq→created_at за ТОЗИ root
   * непосредствено преди delete-а; ако нов reply е пристигнал между
   * candidate scan-а и това извикване, връща `no_longer_eligible`.
   *
   * Idempotent: вече-несъществуващ root → `{ ok:false, code:'not_found' }`.
   */
  hardDeleteRoot: (input: {
    topicId: string
    rootMessageId: string
    inactivityCutoff: Date
  }) => HardDeleteRootResult

  close: () => void
}

function toSqliteDateTimeString(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

export async function createTopicHardDeleteService(databaseFilePath: string): Promise<TopicHardDeleteService> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  // ─── Inactivity candidate discovery (whole-topic) ──────────────────────
  //
  // ВАЖНО (post-incident корекция): за обикновена "Тема" `topic_root_latest_seq`
  // МОЖЕ да съдържа повече от 1 ред — schema-та е PK=root_message_id,
  // topic_id НЕ е unique в тази таблица; всяка тема е feed от независими
  // root threads (`topic_message` vs `topic_reply` protocol типовете,
  // renderTopicsScreen.ts "root posts" множествено число). Production
  // forensic доказа topic-general (is_general=1, вече изключен по-долу) с
  // 48 отделни root_message_id реда за 1 topic_id — същият multi-root модел
  // важи principally за ВСЯКА тема, дори да е рядкост извън General извън
  // текущия UI flow. Затова whole-topic eligibility е АГРЕГАТ по всички
  // roots на темата — `MAX(m.created_at) <= cutoff` ("темата е eligible само
  // ако ВСИЧКИ ѝ roots са >72h неактивни"), НЕ per-root row филтриране (старата
  // имплементация грешно третираше всеки root row независимо, което може да
  // включи тема в victim set-а заради само ЕДИН стар root, докато друг неин
  // root е напълно жив). GROUP BY + HAVING прави точно тази агрегация в 1
  // заявка, все още само range scan на idx_topic_root_latest_seq_topic_seq +
  // O(1) PK lookup за created_at, без table scan на topic_messages.
  // Изключваме:
  //   - is_general=1 (Общ чат/"Общи" контейнер) и LAFCHE_TOPIC_ID literal
  //     (Лафче) — тези container-теми НИКОГА не hard-delete-ват се цялостно;
  //     за is_general=1 root-level cleanup-ът е findInactiveRootCandidates
  //     по-долу, за Лафче няма auto-cleanup изобщо (spec §1);
  //   - status != 'active' И != 'locked' (removed теми вече са извън normal
  //     lifecycle, покрити от съществуващия 180-дневен purge) — locked теми
  //     СА eligible (lock блокира само писане, не е lifecycle state);
  //   - created_by_role IN TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES — теми,
  //     създадени от privileged автор (snapshot В МОМЕНТА НА СЪЗДАВАНЕ, виж
  //     isTopicAutoDeleteExemptByAuthorRole по-горе) — изключени ДИРЕКТНО в
  //     candidate query-то (не select-then-skip извън транзакцията), за да
  //     никога не влизат в victim set-а изобщо. NULL (legacy/системни редове)
  //     НЕ се третира като exempt — само explicit-persisted privileged роля
  //     protect-ва.
  const TOPIC_AUTO_DELETE_EXEMPT_ROLE_PLACEHOLDERS = TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES.map(() => '?').join(', ')

  const selectInactivityCandidatesStatement = database.prepare(`
    SELECT t.topic_id as topicId, MAX(m.created_at) as lastActivityAt
    FROM topics t
    INNER JOIN topic_root_latest_seq trl ON trl.topic_id = t.topic_id
    INNER JOIN topic_messages m ON m.seq = trl.latest_seq
    WHERE t.is_general = 0
      AND t.topic_id != ?
      AND t.status IN ('active', 'locked')
      AND (t.created_by_role IS NULL OR t.created_by_role NOT IN (${TOPIC_AUTO_DELETE_EXEMPT_ROLE_PLACEHOLDERS}))
    GROUP BY t.topic_id
    HAVING MAX(m.created_at) <= ?
    ORDER BY t.topic_id ASC
    LIMIT ?;
  `)

  function findInactivityCandidates(cutoff: Date, limit: number): InactivityCandidate[] {
    const cutoffStr = toSqliteDateTimeString(cutoff)
    const rows = selectInactivityCandidatesStatement.all(
      LAFCHE_TOPIC_ID,
      ...TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES,
      cutoffStr,
      limit,
    ) as Array<{
      topicId: string
      lastActivityAt: string
    }>
    return rows.map((row) => ({ topicId: row.topicId, lastActivityAt: dbDateToUtc(row.lastActivityAt) }))
  }

  // ─── Hard delete primitive ─────────────────────────────────────────────

  const selectTopicForDeleteStatement = database.prepare(`
    SELECT topic_id FROM topics WHERE topic_id = ? LIMIT 1;
  `)

  // Final eligibility re-check — извиква се ВЪТРЕ в BEGIN IMMEDIATE, точно
  // преди destructive delete (spec §8: "Направи final eligibility validation
  // непосредствено преди destructive delete"). SQLite BEGIN IMMEDIATE взима
  // writer lock-а СИНХРОННО, преди тази SELECT — конкурентен insertReply()/
  // insertMessage() BEGIN IMMEDIATE от друг caller или чака този lock, или
  // вече е commit-нал и е видим ТУК. Няма race прозорец между re-check-а и
  // delete-а по-долу, защото и двете са в СЪЩАТА транзакция.
  //
  // ВАЖНО (post-incident корекция): MAX(m.created_at) агрегат по ВСИЧКИ
  // roots на темата, НЕ `LIMIT 1` без ORDER BY (старата версия) — за тема с
  // повече от 1 ред в topic_root_latest_seq, `LIMIT 1` без ORDER BY връща
  // недетерминиран ред (зависи от SQLite-овия вътрешен B-tree storage ред),
  // което може or да пропусне still-eligible тема с 1 стар root (ако SQLite
  // случайно избере друг, активен root), or обратно — да позволи delete на
  // тема, докато друг неин root е напълно жив. Production forensic
  // потвърди точно първия случай: topic-general (48 roots) винаги връщаше
  // стойност от активен root, маскирайки конкретния >72h неактивен root от
  // финалната re-validation. MAX е коректната whole-topic семантика тук —
  // "темата е eligible само ако ВСИЧКИ ѝ roots са >72h неактивни".
  const selectLatestActivityForTopicStatement = database.prepare(`
    SELECT MAX(m.created_at) as lastActivityAt
    FROM topic_root_latest_seq trl
    INNER JOIN topic_messages m ON m.seq = trl.latest_seq
    WHERE trl.topic_id = ?;
  `)

  const selectAttachmentFilenamesForTopicStatement = database.prepare(`
    SELECT storage_filename FROM topic_message_attachments
    WHERE message_id IN (SELECT message_id FROM topic_messages WHERE topic_id = ?);
  `)

  const insertAttachmentDeletionStatement = database.prepare(`
    INSERT INTO topic_message_attachment_deletions (storage_filename) VALUES (?);
  `)

  const deleteAttachmentsForTopicStatement = database.prepare(`
    DELETE FROM topic_message_attachments
    WHERE message_id IN (SELECT message_id FROM topic_messages WHERE topic_id = ?);
  `)

  const countRootMessagesStatement = database.prepare(`
    SELECT COUNT(*) as cnt FROM topic_messages WHERE topic_id = ? AND parent_message_id IS NULL;
  `)

  const countReplyMessagesStatement = database.prepare(`
    SELECT COUNT(*) as cnt FROM topic_messages WHERE topic_id = ? AND parent_message_id IS NOT NULL;
  `)

  // topic_moderation_audit_log.topic_id няма FK (умишлено — виж migration
  // коментара, audit трябва да преживее soft-delete стъпката). За
  // reason='inactivity_expired' explicit DELETE ТУК, ПРЕДИ topics delete-а,
  // mirror на topicModerationStore.purgeRemovedTopicsBefore-ия established
  // pattern — automatic cleanup няма реален actor, не пази persisted audit
  // trail (само console.log diagnostics в index.ts). За
  // reason='manual_moderation_delete' (actor подаден) НЕ трием — вместо
  // това insert-ваме нов 'topic_delete' audit ред (insertModerationAuditRowStatement
  // по-долу), който трябва да ПРЕЖИВЕЕ hard delete-а на самата тема
  // (moderation accountability: "кой/кога/защо изтри тази тема" — единствен
  // persisted trail за manual delete, откакто вече няма persisted
  // status='removed' intermediate state).
  const deleteAuditLogForTopicStatement = database.prepare(`
    DELETE FROM topic_moderation_audit_log WHERE topic_id = ?;
  `)

  const insertModerationAuditRowStatement = database.prepare(`
    INSERT INTO topic_moderation_audit_log (
      log_id, actor_account_id, actor_role, action, topic_id, target_profile_id, reason, expires_at
    ) VALUES (?, ?, ?, 'topic_delete', ?, NULL, ?, NULL);
  `)

  const deleteTopicStatement = database.prepare(`
    DELETE FROM topics WHERE topic_id = ?;
  `)

  /**
   * Всичко останало (topic_messages + self-FK replies, topic_message_likes,
   * topic_mutes, topic_reports, topic_read_state, topic_sender_seen_state,
   * topic_thread_read_state, topic_root_latest_seq) е ON DELETE CASCADE от
   * topics/topic_messages — виж forensic report §E за пълния FK inventory,
   * verified срещу миграциите. topic_mute_evidence.source_message_id е
   * ON DELETE SET NULL (умишлено — evidence snapshot вече е copy-нат в
   * момента на mute-а, source_body_snapshot/source_attachment_* колоните
   * НЕ зависят от живия message row, виж topicModerationStore.insertMuteEvidence),
   * затова НЕ се засяга от този hard delete по дизайн — evidence оцелява.
   * topic_message_attachment_deletions (cleanup queue) няма FK — операционна
   * инфраструктура, никога не се трие от topic delete.
   */
  function hardDeleteTopic(input: {
    topicId: string
    reason: HardDeleteTopicReason
    inactivityCutoff?: Date
    actor?: HardDeleteTopicActor
    auditReason?: string
  }): HardDeleteTopicResult {
    if (input.topicId === LAFCHE_TOPIC_ID) {
      return { ok: false, code: 'protected_topic' }
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = selectTopicForDeleteStatement.get(input.topicId) as { topic_id: string } | undefined
      if (existing === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'not_found' }
      }

      // Defense-in-depth — is_general=1 (Общ чат) никога не трябва да мине
      // дори до тук (нито manual handler, нито inactivity scan го подават),
      // но guard-ваме authoritative вътре в primitive-а, не само upstream.
      const generalCheck = database.prepare(`SELECT is_general FROM topics WHERE topic_id = ? LIMIT 1;`)
        .get(input.topicId) as { is_general: number } | undefined
      if (generalCheck !== undefined && generalCheck.is_general === 1) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'protected_topic' }
      }

      // Race-safe final re-validation (spec §8) — САМО за automatic
      // inactivity cleanup. BEGIN IMMEDIATE вече е взел SQLite writer lock-а
      // СИНХРОННО, преди тази SELECT — конкурентен insertReply()/insertMessage()
      // BEGIN IMMEDIATE от друг process/connection на СЪЩИЯ .sqlite файл или
      // чака този lock (и вижда темата вече изтрита при своя fresh re-check),
      // или вече е commit-нал ПРЕДИ това (WAL-visible) и redовете, четени тук,
      // отразяват тази нова активност. И в двата случая няма прозорец, в
      // който "изглеждаше inactive" и "реално изтрито" да разминат снапшота.
      if (input.inactivityCutoff !== undefined) {
        const latestActivityRow = selectLatestActivityForTopicStatement.get(input.topicId) as
          | { lastActivityAt: string | null }
          | undefined
        const cutoffStr = toSqliteDateTimeString(input.inactivityCutoff)
        // MAX() без GROUP BY винаги връща точно 1 ред, дори при 0 matching
        // roots — в този случай lastActivityAt е NULL (не отсъствие на ред).
        // NULL/undefined означава темата няма никакъв жив root (не би
        // трябвало да се случи за нормална тема, извън scope-а на тази
        // cleanup) — третираме defensively като "не пипай", не като
        // "eligible по подразбиране".
        if (
          latestActivityRow === undefined ||
          latestActivityRow.lastActivityAt === null ||
          latestActivityRow.lastActivityAt > cutoffStr
        ) {
          database.exec('ROLLBACK;')
          return { ok: false, code: 'no_longer_eligible' }
        }
      }

      const rootCount = (countRootMessagesStatement.get(input.topicId) as { cnt: number }).cnt
      const replyCount = (countReplyMessagesStatement.get(input.topicId) as { cnt: number }).cnt

      const deletedAttachmentFilenames = (
        selectAttachmentFilenamesForTopicStatement.all(input.topicId) as Array<{ storage_filename: string }>
      ).map((row) => row.storage_filename)

      for (const filename of deletedAttachmentFilenames) {
        insertAttachmentDeletionStatement.run(filename)
      }
      deleteAttachmentsForTopicStatement.run(input.topicId)

      if (input.reason === 'manual_moderation_delete' && input.actor !== undefined) {
        // Persisted accountability trail — insert-ва СЕГА, ПРЕДИ topics
        // delete-а, за да остане в СЪЩАТА транзакция (никога "тема изтрита,
        // но audit insert fail-нал separately"). Редът е с topic_id БЕЗ FK,
        // затова физически преживява DELETE FROM topics по-долу непокътнат.
        insertModerationAuditRowStatement.run(
          randomUUID(),
          input.actor.accountId,
          input.actor.role,
          input.topicId,
          input.auditReason ?? null,
        )
      } else {
        // reason='inactivity_expired' (или manual без actor, defensive) —
        // established purge-style cleanup: никакъв нов persisted audit ред,
        // и чистим каквито и да е stale/несъществуващи redове за темата
        // (mirror на purgeRemovedTopicsBefore).
        deleteAuditLogForTopicStatement.run(input.topicId)
      }

      deleteTopicStatement.run(input.topicId)

      database.exec('COMMIT;')

      return {
        ok: true,
        topicId: input.topicId,
        deletedRootCount: rootCount,
        deletedReplyCount: replyCount,
        deletedAttachmentFilenames,
      }
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
  }

  // ─── Root-level inactivity cleanup (container-теми, напр. topic-general) ──
  //
  // За container-теми (в момента само is_general=1) `topics` row-ът НИКОГА
  // не hard-delete-ва се (findInactivityCandidates/hardDeleteTopic по-горе
  // explicit изключват is_general=1) — но user-visible "темите" на екрана
  // СА отделните root threads вътре в контейнера. Затова 72h expiry за тях
  // работи на ROOT ниво: всеки root, чиято собствена latest_seq активност е
  // >72h стара, е independently eligible, независимо от активността на
  // другите roots в СЪЩИЯ контейнер (за разлика от whole-topic MAX
  // семантиката по-горе — тук всеки root се оценява САМОСТОЯТЕЛНО, точно
  // защото всеки root Е "темата" от user perspective).
  //
  // Exemption е върху topic_messages.sender_role НА САМИЯ ROOT (snapshot в
  // момента на писане на root съобщението) — НЕ ролята на topics.created_by_role
  // (контейнерът е системен, created_by_role е NULL/несвързан с индивидуалния
  // автор), и НЕ ролята на последния reply автор в root-а (production
  // incident: root от 'player', последен reply от 'pika_team' — root-ът
  // остава напълно eligible, reply авторът никога не protect-ва чужд root).
  const selectInactiveRootCandidatesStatement = database.prepare(`
    SELECT trl.topic_id as topicId, trl.root_message_id as rootMessageId, m.created_at as lastActivityAt
    FROM topic_root_latest_seq trl
    INNER JOIN topic_messages m ON m.seq = trl.latest_seq
    INNER JOIN topic_messages root ON root.message_id = trl.root_message_id
    WHERE trl.topic_id = ?
      AND m.created_at <= ?
      AND (root.sender_role IS NULL OR root.sender_role NOT IN (${TOPIC_AUTO_DELETE_EXEMPT_ROLE_PLACEHOLDERS}))
    ORDER BY trl.root_message_id ASC
    LIMIT ?;
  `)

  function findInactiveRootCandidates(containerTopicId: string, cutoff: Date, limit: number): InactiveRootCandidate[] {
    const cutoffStr = toSqliteDateTimeString(cutoff)
    const rows = selectInactiveRootCandidatesStatement.all(
      containerTopicId,
      cutoffStr,
      ...TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES,
      limit,
    ) as Array<{
      topicId: string
      rootMessageId: string
      lastActivityAt: string
    }>
    return rows.map((row) => ({
      topicId: row.topicId,
      rootMessageId: row.rootMessageId,
      lastActivityAt: dbDateToUtc(row.lastActivityAt),
    }))
  }

  const selectRootForDeleteStatement = database.prepare(`
    SELECT message_id FROM topic_messages WHERE message_id = ? AND topic_id = ? AND parent_message_id IS NULL LIMIT 1;
  `)

  // Final eligibility re-check за ЕДИН root, mirror на
  // selectLatestActivityForTopicStatement по-горе, но scoped към точно този
  // root_message_id (не MAX по цялата тема — root-level cleanup оценява
  // всеки root независимо, виж коментара над findInactiveRootCandidates).
  const selectLatestActivityForRootStatement = database.prepare(`
    SELECT m.created_at as lastActivityAt
    FROM topic_root_latest_seq trl
    INNER JOIN topic_messages m ON m.seq = trl.latest_seq
    WHERE trl.root_message_id = ?;
  `)

  const selectAttachmentFilenamesForRootStatement = database.prepare(`
    SELECT storage_filename FROM topic_message_attachments
    WHERE message_id IN (
      SELECT message_id FROM topic_messages WHERE message_id = ? OR parent_message_id = ?
    );
  `)

  const deleteAttachmentsForRootStatement = database.prepare(`
    DELETE FROM topic_message_attachments
    WHERE message_id IN (
      SELECT message_id FROM topic_messages WHERE message_id = ? OR parent_message_id = ?
    );
  `)

  const countReplyMessagesForRootStatement = database.prepare(`
    SELECT COUNT(*) as cnt FROM topic_messages WHERE parent_message_id = ?;
  `)

  const deleteRootMessageStatement = database.prepare(`
    DELETE FROM topic_messages WHERE message_id = ?;
  `)

  /**
   * Root-level hard-delete — премахва физически САМО root_message_id (+
   * cascaded replies/topic_root_latest_seq/attachments чрез self-referencing
   * FK, виж interface коментара). `topics` row-ът на контейнера (topic-general)
   * НЕ се пипа — това е основната разлика от hardDeleteTopic по-горе.
   *
   * DELETE FROM topic_messages WHERE message_id = rootMessageId cascade-ва
   * (ON DELETE CASCADE):
   *   - topic_messages redovete с parent_message_id = rootMessageId (replies)
   *   - topic_root_latest_seq реда (root_message_id FK)
   *   - topic_message_attachments redovete за root+replies (message_id FK)
   *   - topic_message_likes, topic_message_moderation flags, thread read
   *     state и т.н. — пълния FK inventory, mirror на hardDeleteTopic-ия
   *   Explicit enqueue на attachment filenames става ПРЕДИ delete-а (в
   *   СЪЩАТА транзакция), защото cascade-ът трие DB redовете directно —
   *   без explicit SELECT+enqueue стъпка физическите файлове биха останали
   *   orphaned на диска.
   */
  function hardDeleteRoot(input: {
    topicId: string
    rootMessageId: string
    inactivityCutoff: Date
  }): HardDeleteRootResult {
    if (input.topicId === LAFCHE_TOPIC_ID) {
      return { ok: false, code: 'protected_topic' }
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = selectRootForDeleteStatement.get(input.rootMessageId, input.topicId) as
        | { message_id: string }
        | undefined
      if (existing === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'not_found' }
      }

      // Race-safe final re-validation (mirror на hardDeleteTopic spec §8),
      // scoped към ТОЗИ root — ако нов reply е пристигнал между candidate
      // scan-а и това извикване, latest_seq вече сочи след cutoff-а.
      const latestActivityRow = selectLatestActivityForRootStatement.get(input.rootMessageId) as
        | { lastActivityAt: string | null }
        | undefined
      const cutoffStr = toSqliteDateTimeString(input.inactivityCutoff)
      if (
        latestActivityRow === undefined ||
        latestActivityRow.lastActivityAt === null ||
        latestActivityRow.lastActivityAt > cutoffStr
      ) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'no_longer_eligible' }
      }

      const replyCount = (countReplyMessagesForRootStatement.get(input.rootMessageId) as { cnt: number }).cnt

      const deletedAttachmentFilenames = (
        selectAttachmentFilenamesForRootStatement.all(input.rootMessageId, input.rootMessageId) as Array<{
          storage_filename: string
        }>
      ).map((row) => row.storage_filename)

      for (const filename of deletedAttachmentFilenames) {
        insertAttachmentDeletionStatement.run(filename)
      }
      deleteAttachmentsForRootStatement.run(input.rootMessageId, input.rootMessageId)

      // inactivity_expired root cleanup — established purge-style convention
      // (mirror на hardDeleteTopic/purgeRemovedTopicsBefore): без реален
      // actor, никакъв нов persisted moderation audit ред. Съществуващ
      // topic_message_deletion_audit_log/self_deletion_audit_log за този
      // root (ако има такъв от по-ранен soft-delete опит) няма FK, затова
      // физически преживява DELETE-а по-долу непокътнат, без нужда от
      // explicit cleanup тук.
      deleteRootMessageStatement.run(input.rootMessageId)

      database.exec('COMMIT;')

      return {
        ok: true,
        topicId: input.topicId,
        rootMessageId: input.rootMessageId,
        deletedReplyCount: replyCount,
        deletedAttachmentFilenames,
      }
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
  }

  function close(): void {
    database.close()
  }

  return {
    hardDeleteTopic,
    findInactivityCandidates,
    findInactiveRootCandidates,
    hardDeleteRoot,
    close,
  }
}
