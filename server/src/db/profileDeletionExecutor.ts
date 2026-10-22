// Самоизтриване на профили — Етап 4: окончателно изтриване в базата и
// постоянната файлова опашка (DB слой на worker-а, виж
// core/profileDeletionWorker.ts за оркестрацията).
//
// Фази на една заявка (profile_deletion_requests):
//   1. claim      — BEGIN IMMEDIATE; pending с изтекъл срок / blocked или failed
//                   с дошъл next_attempt_at / executing с изтекъл lease ->
//                   executing с lease (SQLite, не in-memory заключване).
//   2. DB фаза    — ЕДНА BEGIN IMMEDIATE транзакция: lease + идентичност
//                   (profile_id, account_id_snapshot, profile_created_at_snapshot)
//                   + защитни проверки; запис на файловете в опашката;
//                   snapshot на финансовата атрибуция; анонимизиране;
//                   DELETE FROM profiles (+ accounts, ако е последният профил);
//                   db_deleted_at. Всичко или нищо.
//   3. файлове    — след COMMIT, по един ред от опашката (собствен lease).
//   4. completed  — тригерът (20261026_001) го позволява само при
//                   db_deleted_at и всички файлове done/skipped_shared.
// Всяка фаза е идемпотентна и продължава след срив (изтекъл lease).
//
// Какво НЕ се трие (виж и коментарите при statement-ите):
//   * финансови регистри — само атрибуцията се snapshot-ва (Stripe/платежни
//     идентификатори, суми, статуси остават непроменени);
//   * историята на турнирите и мачовете — SET NULL + snapshot (UI-ят вече
//     показва "Играч" за липсващ профил);
//   * подаръците на други потребители — gift_item_transactions е SET NULL
//     (20261026_001), името на изпращача в известията се заменя;
//   * support разговорите, private_room_matches, profile_ip_links/
//     profile_visitor_links — непроменени (въпрос за решение, виж отчета).
// Чужди отговори в Теми под съобщение на профила блокират изтриването
// ('topic_foreign_replies'), вместо каскадата да ги унищожи.

import type { ProfileDeletionFileKind } from '../uploads/profileDeletionFileRemoval.js'
import { createProfileDeletionParticipationChecks } from './profileDeletionParticipationChecks.js'
import { computeProfileDeletionRetryDelayMs } from './profileDeletionSchedule.js'
import { createProfileVisitLinkReader } from './profileVisitLinks.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const PROFILE_DELETION_WORKER_LEASE_MS = 10 * 60 * 1000
export const PROFILE_DELETION_FILE_LEASE_MS = 2 * 60 * 1000
/** Неочаквани грешки (не защитни блокировки): след толкова опита — failed без автоматичен повторен опит. */
export const PROFILE_DELETION_MAX_FAILED_ATTEMPTS = 6
export const PROFILE_DELETION_MAX_FILE_ATTEMPTS = 6
/** Неутрален етикет на мястото на името на изтрития участник в чужди записи. */
export const PROFILE_DELETION_DELETED_LABEL = 'Изтрит профил'

export type ProfileDeletionBlockCode =
  | 'active_game'
  | 'active_game_local'
  | 'active_tournament'
  | 'pending_tournament_invite'
  | 'role_not_allowed'
  | 'campaign_gift_sender_protected'
  | 'topic_foreign_replies'

export type ProfileDeletionFailCode =
  | 'identity_mismatch'
  | 'identity_profile_missing'
  | 'db_phase_error'
  | 'ledger_write_failed'
  | 'files_pending'

export type ClaimedProfileDeletionRequest = {
  requestId: string
  profileId: string
  accountIdSnapshot: string
  profileCreatedAtSnapshot: string
  requestedAt: string
  scheduledFor: string
  attemptCount: number
  dbDeletedAt: string | null
  reclaimed: boolean
}

export type ProfileDeletionDbPhaseResult =
  | { kind: 'db_deleted'; enqueuedFileCount: number; accountDeleted: boolean; alreadyDeletedByAdmin: boolean }
  | { kind: 'already_db_deleted' }
  | { kind: 'blocked'; code: ProfileDeletionBlockCode }
  | { kind: 'failed'; code: ProfileDeletionFailCode; willRetry: boolean }
  | { kind: 'lease_lost' }

export type ProfileDeletionQueuedFile = {
  queueId: number
  requestId: string
  fileKind: ProfileDeletionFileKind
  storageRef: string
  attemptCount: number
}

export type ProfileDeletionFinishResult =
  | { kind: 'completed' }
  | { kind: 'files_pending'; willRetry: boolean }
  | { kind: 'lease_lost' }

export type ProfileDeletionReplayResult =
  | { kind: 'deleted'; files: Array<{ fileKind: ProfileDeletionFileKind; storageRef: string }>; accountDeleted: boolean }
  | { kind: 'absent' }
  | { kind: 'identity_mismatch' }
  | { kind: 'blocked'; code: ProfileDeletionBlockCode }

export type ProfileDeletionExecutor = {
  /** onlyRequestId — само тази заявка (процедурата след restore обработва само заявките от регистъра). */
  claimNextDueRequest: (workerId: string, onlyRequestId?: string) => ClaimedProfileDeletionRequest | null
  runDatabasePhase: (request: ClaimedProfileDeletionRequest, workerId: string) => ProfileDeletionDbPhaseResult
  /** Защитна блокировка, открита извън транзакцията (напр. игра в паметта на този процес). */
  blockRequest: (requestId: string, workerId: string, code: ProfileDeletionBlockCode) => boolean
  failRequest: (requestId: string, workerId: string, code: ProfileDeletionFailCode) => boolean
  extendLease: (requestId: string, workerId: string) => boolean
  listFilesToProcess: (requestId: string) => ProfileDeletionQueuedFile[]
  claimFile: (queueId: number, workerId: string) => boolean
  /** true, ако storage_ref още се реферира от жив ред в базата (споделен файл). */
  isStorageRefReferenced: (fileKind: ProfileDeletionFileKind, storageRef: string) => boolean
  markFileDone: (file: ProfileDeletionQueuedFile, workerId: string, profileId: string, outcome: 'deleted' | 'missing') => boolean
  markFileSkippedShared: (file: ProfileDeletionQueuedFile, workerId: string, profileId: string) => boolean
  markFileFailed: (file: ProfileDeletionQueuedFile, workerId: string, profileId: string, code: string, permanent: boolean) => boolean
  finishRequest: (requestId: string, workerId: string) => ProfileDeletionFinishResult
  /**
   * Само за процедурата след restore от backup (scripts/reconcileProfileDeletionLedger.ts):
   * същото изтриване в базата за профил, чиято заявка липсва във
   * възстановената база. Без опашка/събития — връща файловете.
   */
  replayDeletionForRestore: (identity: { profileId: string; accountIdSnapshot: string; profileCreatedAtSnapshot: string }) => ProfileDeletionReplayResult
  close: () => void
}

export type ProfileDeletionExecutorOptions = {
  /** Профили, които никога не се изтриват автоматично (официалният профил на Pika). */
  protectedProfileIds?: readonly string[]
  /** Само за тестове: извиква се вътре в DB транзакцията точно преди COMMIT. */
  testHooks?: { beforeDatabasePhaseCommit?: (requestId: string) => void }
}

type ProfileRow = {
  profile_id: string
  account_id: string | null
  created_at: string
  profile_kind: string
  is_temporary: number
  avatar_url: string | null
}

type RequestRow = {
  request_id: string
  profile_id: string
  account_id_snapshot: string
  profile_created_at_snapshot: string
  status: string
  requested_at: string
  scheduled_for: string
  attempt_count: number
  lease_owner: string | null
  lease_expires_at: string | null
  db_deleted_at: string | null
}

function isoPlus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

export async function createProfileDeletionExecutor(
  databaseFilePath: string,
  options: ProfileDeletionExecutorOptions = {},
): Promise<ProfileDeletionExecutor> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const protectedProfileIds = new Set((options.protectedProfileIds ?? []).filter((id) => id.length > 0))
  const participationChecks = createProfileDeletionParticipationChecks(database)
  const linkReader = createProfileVisitLinkReader(database)

  const selectNowStatement = database.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`)

  const REQUEST_COLUMNS = `request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, status,
    requested_at, scheduled_for, attempt_count, lease_owner, lease_expires_at, db_deleted_at`

  const selectClaimCandidateStatement = database.prepare(`
    SELECT ${REQUEST_COLUMNS}
    FROM profile_deletion_requests
    WHERE (?2 IS NULL OR request_id = ?2)
      AND (
        (status = 'pending' AND scheduled_for <= ?1)
        OR (status = 'blocked' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?1)
        OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?1)
        OR (status = 'executing' AND lease_expires_at <= ?1)
      )
    ORDER BY scheduled_for ASC, request_id ASC
    LIMIT 1;
  `)

  const claimStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET status = 'executing', lease_owner = ?1, lease_expires_at = ?2,
        attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = ?3
    WHERE request_id = ?4 AND status = ?5
      AND (
        (status = 'pending' AND scheduled_for <= ?3)
        OR (status IN ('blocked', 'failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?3)
        OR (status = 'executing' AND lease_expires_at <= ?3)
      );
  `)

  const selectRequestStatement = database.prepare(`
    SELECT ${REQUEST_COLUMNS} FROM profile_deletion_requests WHERE request_id = ? LIMIT 1;
  `)

  const extendLeaseStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET lease_expires_at = ?1, updated_at = ?2
    WHERE request_id = ?3 AND status = 'executing' AND lease_owner = ?4 AND lease_expires_at > ?2;
  `)

  const releaseStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET status = ?1, lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ?2,
        last_error_code = ?3, last_error_at = ?4, updated_at = ?4
    WHERE request_id = ?5 AND status = 'executing' AND lease_owner = ?6;
  `)

  const markDbDeletedStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET db_deleted_at = ?1, lease_expires_at = ?2, updated_at = ?1
    WHERE request_id = ?3 AND status = 'executing' AND lease_owner = ?4 AND db_deleted_at IS NULL;
  `)

  const completeStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET status = 'completed', completed_at = ?1, lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = NULL, updated_at = ?1
    WHERE request_id = ?2 AND status = 'executing' AND lease_owner = ?3 AND db_deleted_at IS NOT NULL;
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO profile_deletion_events (request_id, profile_id, event_type, actor_kind, worker_id, detail_json)
    VALUES (?, ?, ?, 'system', ?, ?);
  `)

  // ─── Идентичност и защитни проверки ──────────────────────────────────────
  const selectProfileStatement = database.prepare(`
    SELECT profile_id, account_id, created_at, profile_kind, is_temporary, avatar_url
    FROM profiles WHERE profile_id = ? LIMIT 1;
  `)

  const selectAccountRoleStatement = database.prepare(`SELECT role FROM accounts WHERE account_id = ? LIMIT 1;`)

  const selectAdminDeletionStatement = database.prepare(`
    SELECT 1 FROM admin_profile_deletions WHERE deleted_profile_id = ? LIMIT 1;
  `)

  const selectCampaignGiftSenderStatement = database.prepare(`
    SELECT 1 FROM gift_item_transactions WHERE sender_profile_id = ? AND context = 'campaign_reward' LIMIT 1;
  `)

  // Всички съобщения в Теми, които DELETE FROM profiles би изтрил каскадно:
  // собствените (sender_profile_id CASCADE) + всичките им наследници
  // (parent_message_id CASCADE).
  const TOPIC_CASCADE_CTE = `
    WITH RECURSIVE cascade_set(message_id) AS (
      SELECT message_id FROM topic_messages WHERE sender_profile_id = ?1
      UNION
      SELECT m.message_id FROM topic_messages m JOIN cascade_set c ON m.parent_message_id = c.message_id
    )`

  const selectForeignTopicDescendantStatement = database.prepare(`
    ${TOPIC_CASCADE_CTE}
    SELECT 1 FROM topic_messages t JOIN cascade_set c ON c.message_id = t.message_id
    WHERE t.sender_profile_id <> ?1
    LIMIT 1;
  `)

  // ─── Файлове ─────────────────────────────────────────────────────────────
  const selectGalleryStatement = database.prepare(`
    SELECT image_url, thumbnail_url FROM profile_gallery_images WHERE profile_id = ?;
  `)

  // Всички лични разговори на профила (всеки статус/вид) — изтриват се за
  // двете страни (profile_friendships -> friend_chat_messages ->
  // friend_chat_attachments е ON DELETE CASCADE).
  const selectChatAttachmentsStatement = database.prepare(`
    SELECT a.storage_filename
    FROM friend_chat_attachments a
    JOIN friend_chat_messages m ON m.message_id = a.message_id
    JOIN profile_friendships f ON f.friendship_id = m.friendship_id
    WHERE f.requester_profile_id = ?1 OR f.addressee_profile_id = ?1;
  `)

  const selectTopicAttachmentsStatement = database.prepare(`
    ${TOPIC_CASCADE_CTE}
    SELECT a.storage_filename FROM topic_message_attachments a JOIN cascade_set c ON c.message_id = a.message_id;
  `)

  // topic_mute_evidence.profile_id е ON DELETE CASCADE — evidence копието
  // (отделен файл) или препратката към оригиналния файл остават без ред.
  const selectEvidenceAttachmentsStatement = database.prepare(`
    SELECT source_attachment_storage_filename AS storage_filename, source_attachment_is_evidence_copy AS is_copy
    FROM topic_mute_evidence
    WHERE profile_id = ? AND source_attachment_storage_filename IS NOT NULL;
  `)

  const insertFileStatement = database.prepare(`
    INSERT OR IGNORE INTO profile_deletion_file_queue (request_id, file_kind, storage_ref) VALUES (?, ?, ?);
  `)

  // ?1 = profile_id, ?2 = неутралният етикет; всеки statement получава
  // точно толкова параметри, колкото реферира (node:sqlite отказва излишни).
  function prepareWithArity(sql: string): { run: (profileId: string) => void } {
    const statement = database.prepare(sql)
    const usesLabel = sql.includes('?2')
    return {
      run: (profileId: string) => {
        if (usesLabel) statement.run(profileId, PROFILE_DELETION_DELETED_LABEL)
        else statement.run(profileId)
      },
    }
  }

  // ─── Атрибуция (mirror на profileHardDeleteService.ts snapshot списъка) ─
  // Суми/салда/статуси/платежни идентификатори НЕ се променят — само кой
  // профил е бил (псевдонимен UUID), за финансово отчитане и доказване на
  // транзакции. Тестът проверява, че всяка *_snapshot колона е покрита.
  const attributionSnapshotStatements = [
    `UPDATE profile_bans SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE tournaments SET deleted_creator_profile_id_snapshot = ?1 WHERE creator_profile_id = ?1;`,
    `UPDATE tournament_entries SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE tournament_economy_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE yellow_coin_gift_ledger SET deleted_sender_profile_id_snapshot = ?1 WHERE sender_profile_id = ?1;`,
    `UPDATE yellow_coin_gift_ledger SET deleted_recipient_profile_id_snapshot = ?1 WHERE recipient_profile_id = ?1;`,
    `UPDATE match_economy_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE coin_purchase_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE profile_name_change_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE vip_grants SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE vip_purchase_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE bundle_purchase_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE table_exit_penalties SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE profile_match_results SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE belot_match_completion_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    // Подаръци (жълтици/VIP/пакет), платени от ДРУГ потребител за този
    // профил: псевдонимният UUID се snapshot-ва, а името му в чуждия запис
    // се заменя с неутрален етикет (не е платежен идентификатор).
    `UPDATE coin_purchase_ledger SET deleted_recipient_profile_id_snapshot = ?1,
       recipient_display_name_snapshot = CASE WHEN recipient_display_name_snapshot IS NULL THEN NULL ELSE ?2 END
     WHERE recipient_profile_id = ?1;`,
    `UPDATE vip_purchase_ledger SET deleted_recipient_profile_id_snapshot = ?1,
       recipient_display_name_snapshot = CASE WHEN recipient_display_name_snapshot IS NULL THEN NULL ELSE ?2 END
     WHERE recipient_profile_id = ?1;`,
    `UPDATE bundle_purchase_ledger SET deleted_recipient_profile_id_snapshot = ?1,
       recipient_display_name_snapshot = CASE WHEN recipient_display_name_snapshot IS NULL THEN NULL ELSE ?2 END
     WHERE recipient_profile_id = ?1;`,
  ].map(prepareWithArity)

  // ─── Анонимизиране на чужди записи ──────────────────────────────────────
  const anonymizeStatements = [
    // Получени от други подаръци: редът в gift_item_transactions остава
    // (FK SET NULL); името на изпращача в известието на получателя се заменя.
    `UPDATE gift_item_delivery_log SET from_display_name = ?2
     WHERE transaction_id IN (SELECT transaction_id FROM gift_item_transactions WHERE sender_profile_id = ?1);`,
    // Известията за платени подаръци, изпратени ОТ профила до други.
    `UPDATE paid_gift_notification_log
     SET body_text = replace(body_text, sender_display_name_snapshot, ?2), sender_display_name_snapshot = ?2
     WHERE (purchase_type = 'coin' AND purchase_id IN (SELECT purchase_id FROM coin_purchase_ledger WHERE profile_id = ?1))
        OR (purchase_type = 'vip' AND purchase_id IN (SELECT purchase_id FROM vip_purchase_ledger WHERE profile_id = ?1))
        OR (purchase_type = 'bundle' AND purchase_id IN (SELECT purchase_id FROM bundle_purchase_ledger WHERE profile_id = ?1));`,
    // Лайковете, дадени ОТ профила, се броят в чужди тотали
    // (SUM(total_given)) — пазят се, но с несвързан случаен идентификатор.
    `UPDATE profile_likes SET liker_profile_id = 'deleted-' || lower(hex(randomblob(16))) WHERE liker_profile_id = ?1;`,
  ].map(prepareWithArity)

  // ─── Лични данни без FK (cascade НЕ ги пипа) ─────────────────────────────
  const deleteWithoutFkStatements = [
    `DELETE FROM gift_item_delivery_log WHERE recipient_profile_id = ?1;`,
    `DELETE FROM paid_gift_notification_log WHERE recipient_profile_id = ?1;`,
    `DELETE FROM profile_likes WHERE liked_profile_id = ?1;`,
    `DELETE FROM player_blocks WHERE blocker_profile_id = ?1 OR blocked_profile_id = ?1;`,
    // Маркерите за прочитане на ДВЕТЕ страни за изтриваните разговори.
    `DELETE FROM chat_conversation_reads
     WHERE profile_id = ?1
        OR friendship_id IN (SELECT friendship_id FROM profile_friendships WHERE requester_profile_id = ?1 OR addressee_profile_id = ?1);`,
  ].map(prepareWithArity)

  const deleteProfileStatement = database.prepare(`DELETE FROM profiles WHERE profile_id = ?;`)
  const countAccountProfilesStatement = database.prepare(`SELECT COUNT(*) AS cnt FROM profiles WHERE account_id = ?;`)
  const deleteAccountStatement = database.prepare(`DELETE FROM accounts WHERE account_id = ?;`)

  // ─── Файлова опашка ──────────────────────────────────────────────────────
  const selectFilesToProcessStatement = database.prepare(`
    SELECT queue_id, request_id, file_kind, storage_ref, attempt_count
    FROM profile_deletion_file_queue
    WHERE request_id = ?1
      AND (
        (status IN ('pending', 'failed') AND attempt_count < ?2 AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
        OR (status = 'processing' AND lease_expires_at <= ?3)
      )
    ORDER BY queue_id ASC;
  `)

  const claimFileStatement = database.prepare(`
    UPDATE profile_deletion_file_queue
    SET status = 'processing', lease_owner = ?1, lease_expires_at = ?2, attempt_count = attempt_count + 1, updated_at = ?3
    WHERE queue_id = ?4
      AND (
        (status IN ('pending', 'failed') AND attempt_count < ?5 AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
        OR (status = 'processing' AND lease_expires_at <= ?3)
      );
  `)

  const finishFileStatement = database.prepare(`
    UPDATE profile_deletion_file_queue
    SET status = ?1, lease_owner = NULL, lease_expires_at = NULL, completed_at = ?2, updated_at = ?3,
        last_error_code = COALESCE(?4, last_error_code), next_attempt_at = ?5,
        attempt_count = CASE WHEN ?6 = 1 THEN max(attempt_count, ?7) ELSE attempt_count END
    WHERE queue_id = ?8 AND status = 'processing' AND lease_owner = ?9;
  `)

  const countUnfinishedFilesStatement = database.prepare(`
    SELECT
      SUM(CASE WHEN status NOT IN ('done', 'skipped_shared') THEN 1 ELSE 0 END) AS unfinished,
      SUM(CASE WHEN status = 'processing' OR (status IN ('pending', 'failed') AND attempt_count < ?2) THEN 1 ELSE 0 END) AS retryable
    FROM profile_deletion_file_queue WHERE request_id = ?1;
  `)

  const sharedReferenceStatements: Record<ProfileDeletionFileKind, ReturnType<SqliteDatabase['prepare']>> = {
    avatar: database.prepare(`SELECT 1 FROM profiles WHERE avatar_url = ?1 LIMIT 1;`),
    gallery_image: database.prepare(`
      SELECT 1 FROM profile_gallery_images WHERE image_url = ?1 OR thumbnail_url = ?1
      UNION ALL SELECT 1 FROM profiles WHERE avatar_url = ?1 LIMIT 1;`),
    gallery_thumbnail: database.prepare(`
      SELECT 1 FROM profile_gallery_images WHERE image_url = ?1 OR thumbnail_url = ?1
      UNION ALL SELECT 1 FROM profiles WHERE avatar_url = ?1 LIMIT 1;`),
    chat_attachment: database.prepare(`SELECT 1 FROM friend_chat_attachments WHERE storage_filename = ?1 LIMIT 1;`),
    // Оригиналният файл може да е реферира и от evidence ред (без копие).
    topic_attachment: database.prepare(`
      SELECT 1 FROM topic_message_attachments WHERE storage_filename = ?1
      UNION ALL SELECT 1 FROM topic_mute_evidence
        WHERE source_attachment_storage_filename = ?1 AND source_attachment_is_evidence_copy = 0
      LIMIT 1;`),
    topic_mute_evidence_attachment: database.prepare(`
      SELECT 1 FROM topic_mute_evidence
      WHERE source_attachment_storage_filename = ?1 AND source_attachment_is_evidence_copy = 1 LIMIT 1;`),
    support_attachment: database.prepare(`SELECT 1 FROM support_message_attachments WHERE storage_filename = ?1 LIMIT 1;`),
  }

  function dbNow(): string {
    return (selectNowStatement.get() as { now: string }).now
  }

  function rollbackQuietly(): void {
    try { database.exec('ROLLBACK;') } catch { /* няма отворена транзакция */ }
  }

  function insertEvent(requestId: string, profileId: string, eventType: string, workerId: string | null, detail: Record<string, unknown> | null): void {
    insertEventStatement.run(requestId, profileId, eventType, workerId, detail === null ? null : JSON.stringify(detail))
  }

  function toClaimed(row: RequestRow, reclaimed: boolean, attemptCount: number): ClaimedProfileDeletionRequest {
    return {
      requestId: row.request_id,
      profileId: row.profile_id,
      accountIdSnapshot: row.account_id_snapshot,
      profileCreatedAtSnapshot: row.profile_created_at_snapshot,
      requestedAt: row.requested_at,
      scheduledFor: row.scheduled_for,
      attemptCount,
      dbDeletedAt: row.db_deleted_at,
      reclaimed,
    }
  }

  function claimNextDueRequest(workerId: string, onlyRequestId?: string): ClaimedProfileDeletionRequest | null {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const now = dbNow()
      const row = selectClaimCandidateStatement.get(now, onlyRequestId ?? null) as RequestRow | undefined
      if (row === undefined) {
        database.exec('ROLLBACK;')
        return null
      }
      const result = claimStatement.run(workerId, isoPlus(now, PROFILE_DELETION_WORKER_LEASE_MS), now, row.request_id, row.status) as { changes: number }
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK;')
        return null
      }
      const reclaimed = row.status === 'executing'
      insertEvent(row.request_id, row.profile_id, reclaimed ? 'lease_reclaimed' : 'claimed', workerId, {
        previousStatus: row.status,
        attempt: row.attempt_count + 1,
        dbDeleted: row.db_deleted_at !== null,
      })
      database.exec('COMMIT;')
      return toClaimed(row, reclaimed, row.attempt_count + 1)
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  /** Вика се ВЪТРЕ в отворена транзакция. */
  function releaseInTransaction(
    row: RequestRow,
    workerId: string,
    status: 'blocked' | 'failed',
    code: string,
    retry: boolean,
    now: string,
  ): boolean {
    const nextAttemptAt = retry ? isoPlus(now, computeProfileDeletionRetryDelayMs(Math.max(1, row.attempt_count))) : null
    const result = releaseStatement.run(status, nextAttemptAt, code, now, row.request_id, workerId) as { changes: number }
    if (Number(result.changes) !== 1) return false
    insertEvent(row.request_id, row.profile_id, status, workerId, { code, nextAttemptAt })
    return true
  }

  function releaseRequest(requestId: string, workerId: string, status: 'blocked' | 'failed', code: string, retryOverride?: boolean): boolean {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const row = selectRequestStatement.get(requestId) as RequestRow | undefined
      if (row === undefined || row.status !== 'executing' || row.lease_owner !== workerId) {
        database.exec('ROLLBACK;')
        return false
      }
      const retry = retryOverride ?? (status === 'blocked' || row.attempt_count < PROFILE_DELETION_MAX_FAILED_ATTEMPTS)
      const released = releaseInTransaction(row, workerId, status, code, retry, dbNow())
      database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
      return released
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  type BlockerResult = { blocked: ProfileDeletionBlockCode } | null

  function findBlocker(profile: ProfileRow): BlockerResult {
    const role = profile.account_id === null
      ? null
      : (selectAccountRoleStatement.get(profile.account_id) as { role: string } | undefined)?.role ?? null
    if (protectedProfileIds.has(profile.profile_id) || role !== 'player') return { blocked: 'role_not_allowed' }
    if (participationChecks.hasActiveTournamentDependency(profile.profile_id)) return { blocked: 'active_tournament' }
    if (participationChecks.hasPendingTournamentInvite(profile.profile_id)) return { blocked: 'pending_tournament_invite' }
    if (participationChecks.hasPersistedActiveGame(profile.profile_id)) return { blocked: 'active_game' }
    if (selectCampaignGiftSenderStatement.get(profile.profile_id) !== undefined) return { blocked: 'campaign_gift_sender_protected' }
    if (selectForeignTopicDescendantStatement.get(profile.profile_id) !== undefined) return { blocked: 'topic_foreign_replies' }
    return null
  }

  function identityMatches(profile: ProfileRow, identity: { accountIdSnapshot: string; profileCreatedAtSnapshot: string }): boolean {
    return (
      profile.account_id !== null &&
      profile.account_id === identity.accountIdSnapshot &&
      profile.created_at === identity.profileCreatedAtSnapshot &&
      profile.profile_kind === 'human' &&
      profile.is_temporary === 0
    )
  }

  /**
   * Самото изтриване — вика се ВЪТРЕ в отворена BEGIN IMMEDIATE транзакция,
   * след проверка на идентичността и защитите. enqueue получава всеки файл,
   * който след COMMIT трябва да бъде изтрит физически.
   */
  function deleteProfileDataInTransaction(
    profile: ProfileRow,
    enqueue: (fileKind: ProfileDeletionFileKind, storageRef: string) => void,
  ): { accountDeleted: boolean } {
    const profileId = profile.profile_id

    if (profile.avatar_url !== null && profile.avatar_url.startsWith('/uploads/avatars/')) {
      enqueue('avatar', profile.avatar_url)
    }
    for (const row of selectGalleryStatement.all(profileId) as Array<{ image_url: string; thumbnail_url: string }>) {
      enqueue('gallery_image', row.image_url)
      if (row.thumbnail_url !== row.image_url) enqueue('gallery_thumbnail', row.thumbnail_url)
    }
    for (const row of selectChatAttachmentsStatement.all(profileId) as Array<{ storage_filename: string }>) {
      enqueue('chat_attachment', row.storage_filename)
    }
    for (const row of selectTopicAttachmentsStatement.all(profileId) as Array<{ storage_filename: string }>) {
      enqueue('topic_attachment', row.storage_filename)
    }
    for (const row of selectEvidenceAttachmentsStatement.all(profileId) as Array<{ storage_filename: string; is_copy: number }>) {
      enqueue(row.is_copy === 1 ? 'topic_mute_evidence_attachment' : 'topic_attachment', row.storage_filename)
    }

    for (const statement of attributionSnapshotStatements) statement.run(profileId)
    for (const statement of anonymizeStatements) statement.run(profileId)
    for (const statement of deleteWithoutFkStatements) statement.run(profileId)

    // Risk cache на свързаните профили (mirror на hard delete) — само маркер.
    const visitorIds = [...(linkReader.findVisitorIdsForProfiles([profileId]).get(profileId) ?? [])]
    if (visitorIds.length > 0) {
      const affected = new Set<string>()
      for (const ids of linkReader.findProfilesForVisitorIds(visitorIds).values()) {
        for (const id of ids) if (id !== profileId) affected.add(id)
      }
      if (affected.size > 0) {
        const list = [...affected]
        database.prepare(`UPDATE admin_profile_risk_checks SET check_complete = 0 WHERE profile_id IN (${list.map(() => '?').join(', ')});`).run(...list)
      }
    }

    deleteProfileStatement.run(profileId)

    let accountDeleted = false
    if (profile.account_id !== null) {
      const remaining = (countAccountProfilesStatement.get(profile.account_id) as { cnt: number }).cnt
      if (remaining === 0) {
        deleteAccountStatement.run(profile.account_id)
        accountDeleted = true
      }
    }
    return { accountDeleted }
  }

  function runDatabasePhase(request: ClaimedProfileDeletionRequest, workerId: string): ProfileDeletionDbPhaseResult {
    database.exec('BEGIN IMMEDIATE;')
    let row: RequestRow | undefined
    try {
      const now = dbNow()
      row = selectRequestStatement.get(request.requestId) as RequestRow | undefined
      if (
        row === undefined ||
        row.status !== 'executing' ||
        row.lease_owner !== workerId ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= now
      ) {
        database.exec('ROLLBACK;')
        return { kind: 'lease_lost' }
      }
      if (row.db_deleted_at !== null) {
        database.exec('ROLLBACK;')
        return { kind: 'already_db_deleted' }
      }
      if (row.scheduled_for > now) {
        // Невъзможно при тригера за pending -> executing; защита в дълбочина.
        database.exec('ROLLBACK;')
        return { kind: 'lease_lost' }
      }

      const profile = selectProfileStatement.get(row.profile_id) as ProfileRow | undefined
      if (profile === undefined) {
        if (selectAdminDeletionStatement.get(row.profile_id) !== undefined) {
          // Профилът вече е изтрит от администратор през 45-дневния период.
          markDbDeletedStatement.run(now, isoPlus(now, PROFILE_DELETION_WORKER_LEASE_MS), row.request_id, workerId)
          insertEvent(row.request_id, row.profile_id, 'db_deleted', workerId, { files: 0, accountDeleted: false, alreadyDeletedByAdmin: true })
          database.exec('COMMIT;')
          return { kind: 'db_deleted', enqueuedFileCount: 0, accountDeleted: false, alreadyDeletedByAdmin: true }
        }
        const released = releaseInTransaction(row, workerId, 'failed', 'identity_profile_missing', false, now)
        database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
        return released ? { kind: 'failed', code: 'identity_profile_missing', willRetry: false } : { kind: 'lease_lost' }
      }
      if (!identityMatches(profile, { accountIdSnapshot: row.account_id_snapshot, profileCreatedAtSnapshot: row.profile_created_at_snapshot })) {
        const released = releaseInTransaction(row, workerId, 'failed', 'identity_mismatch', false, now)
        database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
        return released ? { kind: 'failed', code: 'identity_mismatch', willRetry: false } : { kind: 'lease_lost' }
      }

      const blocker = findBlocker(profile)
      if (blocker !== null) {
        const released = releaseInTransaction(row, workerId, 'blocked', blocker.blocked, true, now)
        database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
        return released ? { kind: 'blocked', code: blocker.blocked } : { kind: 'lease_lost' }
      }

      let enqueuedFileCount = 0
      const requestId = row.request_id
      const { accountDeleted } = deleteProfileDataInTransaction(profile, (fileKind, storageRef) => {
        const result = insertFileStatement.run(requestId, fileKind, storageRef) as { changes: number }
        enqueuedFileCount += Number(result.changes)
      })

      const marked = markDbDeletedStatement.run(now, isoPlus(now, PROFILE_DELETION_WORKER_LEASE_MS), row.request_id, workerId) as { changes: number }
      if (Number(marked.changes) !== 1) throw new Error('profile_deletion_mark_db_deleted_failed')
      insertEvent(row.request_id, row.profile_id, 'db_deleted', workerId, { files: enqueuedFileCount, accountDeleted, alreadyDeletedByAdmin: false })
      if (enqueuedFileCount > 0) insertEvent(row.request_id, row.profile_id, 'file_enqueued', workerId, { count: enqueuedFileCount })

      options.testHooks?.beforeDatabasePhaseCommit?.(row.request_id)
      database.exec('COMMIT;')
      return { kind: 'db_deleted', enqueuedFileCount, accountDeleted, alreadyDeletedByAdmin: false }
    } catch (error) {
      rollbackQuietly()
      // Само за тестове: симулиран срив на процеса — заявката остава
      // executing с висящ lease (точно като при истински срив/рестарт).
      if ((error as { profileDeletionSimulatedCrash?: boolean } | null)?.profileDeletionSimulatedCrash === true) {
        throw error
      }
      // Защитата в базата (20261013_001) е последната линия за кампанийни подаръци.
      if (error instanceof Error && error.message.includes('campaign_gift_sender_protected')) {
        return releaseRequest(request.requestId, workerId, 'blocked', 'campaign_gift_sender_protected')
          ? { kind: 'blocked', code: 'campaign_gift_sender_protected' }
          : { kind: 'lease_lost' }
      }
      const willRetry = (row?.attempt_count ?? PROFILE_DELETION_MAX_FAILED_ATTEMPTS) < PROFILE_DELETION_MAX_FAILED_ATTEMPTS
      return releaseRequest(request.requestId, workerId, 'failed', 'db_phase_error', willRetry)
        ? { kind: 'failed', code: 'db_phase_error', willRetry }
        : { kind: 'lease_lost' }
    }
  }

  function extendLease(requestId: string, workerId: string): boolean {
    const now = dbNow()
    const result = extendLeaseStatement.run(isoPlus(now, PROFILE_DELETION_WORKER_LEASE_MS), now, requestId, workerId) as { changes: number }
    return Number(result.changes) === 1
  }

  function listFilesToProcess(requestId: string): ProfileDeletionQueuedFile[] {
    return (selectFilesToProcessStatement.all(requestId, PROFILE_DELETION_MAX_FILE_ATTEMPTS, dbNow()) as Array<{
      queue_id: number
      request_id: string
      file_kind: ProfileDeletionFileKind
      storage_ref: string
      attempt_count: number
    }>).map((row) => ({
      queueId: row.queue_id,
      requestId: row.request_id,
      fileKind: row.file_kind,
      storageRef: row.storage_ref,
      attemptCount: row.attempt_count,
    }))
  }

  function claimFile(queueId: number, workerId: string): boolean {
    const now = dbNow()
    const result = claimFileStatement.run(workerId, isoPlus(now, PROFILE_DELETION_FILE_LEASE_MS), now, queueId, PROFILE_DELETION_MAX_FILE_ATTEMPTS) as { changes: number }
    return Number(result.changes) === 1
  }

  function isStorageRefReferenced(fileKind: ProfileDeletionFileKind, storageRef: string): boolean {
    return sharedReferenceStatements[fileKind].get(storageRef) !== undefined
  }

  function finishFile(
    file: ProfileDeletionQueuedFile,
    workerId: string,
    profileId: string,
    status: 'done' | 'skipped_shared' | 'failed',
    eventType: 'file_deleted' | 'file_skipped_shared' | 'file_failed',
    detail: Record<string, unknown>,
    errorCode: string | null,
    permanent: boolean,
  ): boolean {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const now = dbNow()
      const attempt = file.attemptCount + 1
      const nextAttemptAt = status === 'failed' && !permanent ? isoPlus(now, computeProfileDeletionRetryDelayMs(attempt)) : null
      const result = finishFileStatement.run(
        status,
        status === 'failed' ? null : now,
        now,
        errorCode,
        nextAttemptAt,
        permanent ? 1 : 0,
        PROFILE_DELETION_MAX_FILE_ATTEMPTS,
        file.queueId,
        workerId,
      ) as { changes: number }
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK;')
        return false
      }
      insertEvent(file.requestId, profileId, eventType, workerId, { queueId: file.queueId, kind: file.fileKind, ...detail })
      database.exec('COMMIT;')
      return true
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function finishRequest(requestId: string, workerId: string): ProfileDeletionFinishResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const now = dbNow()
      const row = selectRequestStatement.get(requestId) as RequestRow | undefined
      if (row === undefined || row.status !== 'executing' || row.lease_owner !== workerId || row.db_deleted_at === null) {
        database.exec('ROLLBACK;')
        return { kind: 'lease_lost' }
      }
      const counts = countUnfinishedFilesStatement.get(requestId, PROFILE_DELETION_MAX_FILE_ATTEMPTS) as { unfinished: number | null; retryable: number | null }
      if ((counts.unfinished ?? 0) === 0) {
        const result = completeStatement.run(now, requestId, workerId) as { changes: number }
        if (Number(result.changes) !== 1) {
          database.exec('ROLLBACK;')
          return { kind: 'lease_lost' }
        }
        insertEvent(requestId, row.profile_id, 'completed', workerId, null)
        database.exec('COMMIT;')
        return { kind: 'completed' }
      }
      const willRetry = (counts.retryable ?? 0) > 0
      const released = releaseInTransaction(row, workerId, 'failed', 'files_pending', willRetry, now)
      database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
      return released ? { kind: 'files_pending', willRetry } : { kind: 'lease_lost' }
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function replayDeletionForRestore(identity: { profileId: string; accountIdSnapshot: string; profileCreatedAtSnapshot: string }): ProfileDeletionReplayResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const profile = selectProfileStatement.get(identity.profileId) as ProfileRow | undefined
      if (profile === undefined) {
        database.exec('ROLLBACK;')
        return { kind: 'absent' }
      }
      if (!identityMatches(profile, identity)) {
        database.exec('ROLLBACK;')
        return { kind: 'identity_mismatch' }
      }
      const blocker = findBlocker(profile)
      if (blocker !== null) {
        database.exec('ROLLBACK;')
        return { kind: 'blocked', code: blocker.blocked }
      }
      const files: Array<{ fileKind: ProfileDeletionFileKind; storageRef: string }> = []
      const seen = new Set<string>()
      const { accountDeleted } = deleteProfileDataInTransaction(profile, (fileKind, storageRef) => {
        const key = `${fileKind}\n${storageRef}`
        if (!seen.has(key)) {
          seen.add(key)
          files.push({ fileKind, storageRef })
        }
      })
      database.exec('COMMIT;')
      return { kind: 'deleted', files, accountDeleted }
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  return {
    claimNextDueRequest,
    runDatabasePhase,
    blockRequest: (requestId, workerId, code) => releaseRequest(requestId, workerId, 'blocked', code),
    failRequest: (requestId, workerId, code) => releaseRequest(requestId, workerId, 'failed', code),
    extendLease,
    listFilesToProcess,
    claimFile,
    isStorageRefReferenced,
    markFileDone: (file, workerId, profileId, outcome) =>
      finishFile(file, workerId, profileId, 'done', 'file_deleted', { outcome }, null, false),
    markFileSkippedShared: (file, workerId, profileId) =>
      finishFile(file, workerId, profileId, 'skipped_shared', 'file_skipped_shared', {}, null, false),
    markFileFailed: (file, workerId, profileId, code, permanent) =>
      finishFile(file, workerId, profileId, 'failed', 'file_failed', { code, permanent }, code.slice(0, 200), permanent),
    finishRequest,
    replayDeletionForRestore,
    close: () => database.close(),
  }
}
