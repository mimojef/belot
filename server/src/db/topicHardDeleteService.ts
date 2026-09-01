import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const LAFCHE_TOPIC_ID = 'topic-lafche'

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

  // ─── Inactivity candidate discovery ────────────────────────────────────
  //
  // topic_root_latest_seq има точно 1 ред за обикновена "Тема" (единствен
  // root — виж forensic report §A). latest_seq е topic_messages.seq на
  // последния ЖИВ ред (root или reply) в thread-а — insertMessage/insertReply/
  // deleteMessage/deleteOwnMessage поддържат го incrementally (topicMessageStore.ts),
  // затова joint-ът тук е "1 ред на тема" + "1 PK lookup за created_at",
  // НЕ table scan на topic_messages (spec §7 изискване). Изключваме:
  //   - is_general=1 (Общ чат) и LAFCHE_TOPIC_ID literal (Лафче) — scope §1;
  //   - status != 'active' И != 'locked' (removed теми вече са извън normal
  //     lifecycle, покрити от съществуващия 180-дневен purge) — locked теми
  //     СА eligible (lock блокира само писане, не е lifecycle state).
  const selectInactivityCandidatesStatement = database.prepare(`
    SELECT t.topic_id as topicId, m.created_at as lastActivityAt
    FROM topics t
    INNER JOIN topic_root_latest_seq trl ON trl.topic_id = t.topic_id
    INNER JOIN topic_messages m ON m.seq = trl.latest_seq
    WHERE t.is_general = 0
      AND t.topic_id != ?
      AND t.status IN ('active', 'locked')
      AND m.created_at <= ?
    ORDER BY t.topic_id ASC
    LIMIT ?;
  `)

  function findInactivityCandidates(cutoff: Date, limit: number): InactivityCandidate[] {
    const cutoffStr = toSqliteDateTimeString(cutoff)
    const rows = selectInactivityCandidatesStatement.all(LAFCHE_TOPIC_ID, cutoffStr, limit) as Array<{
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
  const selectLatestActivityForTopicStatement = database.prepare(`
    SELECT m.created_at as lastActivityAt
    FROM topic_root_latest_seq trl
    INNER JOIN topic_messages m ON m.seq = trl.latest_seq
    WHERE trl.topic_id = ?
    LIMIT 1;
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
          | { lastActivityAt: string }
          | undefined
        const cutoffStr = toSqliteDateTimeString(input.inactivityCutoff)
        // Ред липсва в topic_root_latest_seq само ако темата няма никакъв жив
        // root (не би трябвало да се случи за нормална тема, извън scope-а на
        // тази cleanup — третираме defensively като "не пипай", не като
        // "eligible по подразбиране").
        if (latestActivityRow === undefined || latestActivityRow.lastActivityAt > cutoffStr) {
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

  function close(): void {
    database.close()
  }

  return {
    hardDeleteTopic,
    findInactivityCandidates,
    close,
  }
}
