import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TopicModeratorRole = 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin'
export type TopicModerationAction = 'topic_lock' | 'topic_unlock' | 'topic_mute' | 'topic_unmute' | 'topic_delete'

/**
 * "Current lock state" snapshot — derived at READ time от topics.locked_*
 * колоните, огледално на vipStore.toStatusSnapshot (isActive computed от
 * expiry comparison, никога persisted boolean). null lockedUntil/reason
 * значи темата никога не е била заключвана (или lock-ът е бил ръчно
 * премахнат — виж unlockTopic, който explicit NULL-ва колоните).
 */
export type TopicLockSnapshot = {
  isLocked: boolean
  lockedUntil: string | null
  lockedByAccountId: string | null
  lockedReason: string | null
}

export type TopicMuteSnapshot = {
  isMuted: boolean
  mutedUntil: string | null
  mutedByAccountId: string | null
  reason: string | null
}

/**
 * Global Topics-section mute snapshot — виж topic_section_mutes migration
 * коментара за пълния rationale. Shape-ово идентичен на TopicMuteSnapshot
 * (per-topic legacy) нарочно, за да reuse-ва максимално client-side
 * форматиращата логика (formatModerationExpiry и т.н.) без промяна.
 */
export type TopicSectionMuteSnapshot = {
  isMuted: boolean
  mutedUntil: string | null
  mutedByAccountId: string | null
  reason: string | null
}

export type TopicModerationAuditEntry = {
  logId: string
  actorAccountId: string | null
  actorRole: TopicModeratorRole
  action: TopicModerationAction
  topicId: string
  targetProfileId: string | null
  reason: string | null
  expiresAt: string | null
  createdAt: string
}

export type TopicMuteEvidenceSourceKind = 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified'
export type TopicMuteEvidenceStatus = 'active' | 'expired' | 'manually_unmuted'
export type TopicMuteEvidenceReasonCategory =
  | 'insults'
  | 'provocation'
  | 'spam'
  | 'inappropriate_content'
  | 'other'

/**
 * Пълен snapshot — internal/moderator изглед (носи moderator identity, виж
 * §6/§8 в брифа: "На потребителя НЕ показвай кой конкретен moderator го е
 * наложил"). User-facing изгледът маха muted_by_account_id/unmuted_by_account_id
 * на API response ниво (виж handleTopicMuteEvidenceForSelfRequest в index.ts),
 * НЕ отделен store shape — една authoritative заявка, два response mapping-а.
 */
export type TopicMuteEvidenceEntry = {
  muteHistoryId: string
  muteAuditLogId: string
  profileId: string
  sourceTopicId: string
  sourceMessageId: string | null
  sourceKind: TopicMuteEvidenceSourceKind
  sourceBodySnapshot: string
  sourceAttachment: { storageFilename: string; width: number; height: number } | null
  sourceCreatedAt: string | null
  originalMessageDeletedAt: string | null
  mutedByAccountId: string | null
  mutedByRole: TopicModeratorRole
  reasonText: string | null
  reasonCategory: TopicMuteEvidenceReasonCategory | null
  durationMs: number
  mutedUntil: string
  status: TopicMuteEvidenceStatus
  unmutedAt: string | null
  unmutedByAccountId: string | null
  createdAt: string
}

export type TopicReportStatus = 'pending' | 'reviewed' | 'dismissed'

export type TopicReportSnapshot = {
  reportId: string
  topicId: string
  reporterProfileId: string
  reason: string
  status: TopicReportStatus
  reviewedByAccountId: string | null
  reviewedAt: string | null
  createdAt: string
}

export type CreateTopicReportResult =
  | { ok: true; report: TopicReportSnapshot }
  | { ok: false; code: 'duplicate' }

export type TopicModerationStore = {
  // ─── Lock/Unlock (temporary topic write restriction) ───────────────────
  lockTopic: (input: {
    topicId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
    reason: string
    durationMs: number
  }) => TopicLockSnapshot
  /** No-op idempotent ако темата вече не е заключена (виж брифа т.12) — все пак append-ва audit ред само ако РЕАЛНО е имало активен lock. */
  unlockTopic: (input: {
    topicId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
  }) => { changed: boolean; snapshot: TopicLockSnapshot }
  getTopicLockSnapshot: (topicId: string) => TopicLockSnapshot | null

  // ─── Mute/Unmute (topic-specific, profile_id + topic_id) ────────────────
  muteProfileInTopic: (input: {
    topicId: string
    profileId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
    reason: string
    durationMs: number
  }) => TopicMuteSnapshot
  unmuteProfileInTopic: (input: {
    topicId: string
    profileId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
  }) => { changed: boolean }
  getMuteSnapshot: (topicId: string, profileId: string) => TopicMuteSnapshot
  /** Server-authoritative enforcement lookup за send_topic_message/send_topic_reply — expiry checked at read time. */
  isProfileMutedInTopic: (topicId: string, profileId: string) => boolean

  // ─── Global Topics-section mute (enforcement source of truth след GLOBAL
  // TOPICS MUTE брифа) — topicId остава само audit/source context, НЕ
  // enforcement scope. Виж topic_section_mutes migration коментара. ────────
  /**
   * `topicId` е ЕДИНСТВЕНО за audit context ("moderator-ът е задействал
   * действието от тази конкретна тема") — enforcement-ът важи навсякъде в
   * Теми, независимо от коя тема е бил натиснат бутонът.
   */
  /**
   * `sourceMessageId`/`sourceKind` — server-side snapshot evidence (Лафче
   * mute-evidence брифа §1/§3): ЗАДЪЛЖИТЕЛНО извиквано ATOMIC заедно с
   * mute state update-а (обвито в СЪЩАТА BEGIN IMMEDIATE транзакция) — не е
   * позволено mute да се приложи без evidence запис. sourceMessageId е
   * null-able (мутиране без конкретен triggering post, напр. от profile
   * popup) → sourceKind='unspecified', snapshot полетата остават празни.
   */
  muteProfileInTopics: (input: {
    topicId: string
    profileId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
    reason: string
    reasonCategory?: TopicMuteEvidenceReasonCategory | null
    durationMs: number
    sourceMessageId?: string | null
    sourceKind?: TopicMuteEvidenceSourceKind
  }) => TopicSectionMuteSnapshot
  unmuteProfileInTopics: (input: {
    topicId: string
    profileId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
  }) => { changed: boolean }
  getSectionMuteSnapshot: (profileId: string) => TopicSectionMuteSnapshot
  /** Server-authoritative enforcement lookup за ВСИЧКИ 5 Topics write paths — expiry checked at read time, никога persisted boolean. */
  isProfileMutedInTopicsSection: (profileId: string) => boolean

  // ─── Mute evidence/history (Лафче mute-evidence брифа) ──────────────────
  /** Internal/moderator изглед — пълен (носи moderator identity). User-facing mapping-ът маха identity полетата на HTTP response ниво (виж index.ts). */
  listMuteEvidenceForProfile: (profileId: string, limit: number) => TopicMuteEvidenceEntry[]

  // ─── Delete (attachments hard-delete + queue insertion, topic/messages
  // soft-delete — всичко в ЕДНА транзакция вътре в deleteTopic) ────────────
  /** Връща storage filenames-ите на ВСИЧКИ attachments в темата — reusable helper (тестове/diagnostics), НЕ нужен за normal delete flow (deleteTopic вече го извиква вътрешно). */
  getAttachmentFilenamesForTopic: (topicId: string) => string[]
  /**
   * Atomic whole-topic delete — В ЕДНА BEGIN IMMEDIATE транзакция: hard-delete
   * на всички topic_message_attachments redovete + insert на съответните
   * cleanup queue jobs (topic_message_attachment_deletions), после topic/
   * messages soft-delete + audit ред. `deletedAttachmentFilenames` връща
   * точно кои filenames са били hard-deleted (за caller-ово logging/broadcast,
   * queue insertion-ът вече е станал вътре в транзакцията, caller-ът НЕ
   * трябва да enqueue-ва повторно).
   */
  deleteTopic: (input: {
    topicId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
    reason: string
  }) => { ok: true; deletedAttachmentFilenames: string[] } | { ok: false; code: 'not_found' | 'already_removed' }

  // ─── Reports ─────────────────────────────────────────────────────────────
  createReport: (input: {
    topicId: string
    reporterProfileId: string
    reason: string
  }) => CreateTopicReportResult
  listReports: (status: TopicReportStatus | null, limit: number) => TopicReportSnapshot[]
  countPendingReports: () => number
  reviewReport: (input: {
    reportId: string
    status: 'reviewed' | 'dismissed'
    actorAccountId: string
  }) => { ok: true; report: TopicReportSnapshot } | { ok: false; code: 'not_found' }

  // ─── Audit log ───────────────────────────────────────────────────────────
  listAuditLogForTopic: (topicId: string, limit: number) => TopicModerationAuditEntry[]

  /**
   * 180-дневен final purge — hard-DELETE на removed topics, чийто
   * `removed_at` <= cutoff. Bounded batch (без OFFSET), idempotent/safe за
   * повторни и cross-instance извиквания. Връща брой реално purge-нати
   * теми. Виж имплементацията за пълен FK cascade rationale.
   */
  purgeRemovedTopicsBefore: (cutoff: Date, batchSize: number) => number

  close: () => void
}

type TopicLockRow = {
  status: string
  locked_until: string | null
  locked_by_account_id: string | null
  locked_reason: string | null
}

function toLockSnapshot(row: TopicLockRow, now: number): TopicLockSnapshot {
  if (row.locked_until === null) {
    return { isLocked: false, lockedUntil: null, lockedByAccountId: null, lockedReason: null }
  }
  const lockedUntilIso = dbDateToUtc(row.locked_until)
  const isLocked = new Date(lockedUntilIso).getTime() > now
  return {
    isLocked,
    lockedUntil: lockedUntilIso,
    lockedByAccountId: row.locked_by_account_id,
    lockedReason: row.locked_reason,
  }
}

type TopicMuteRow = {
  muted_until: string
  muted_by_account_id: string | null
  reason: string | null
}

function toMuteSnapshot(row: TopicMuteRow | undefined, now: number): TopicMuteSnapshot {
  if (!row) {
    return { isMuted: false, mutedUntil: null, mutedByAccountId: null, reason: null }
  }
  const mutedUntilIso = dbDateToUtc(row.muted_until)
  return {
    isMuted: new Date(mutedUntilIso).getTime() > now,
    mutedUntil: mutedUntilIso,
    mutedByAccountId: row.muted_by_account_id,
    reason: row.reason,
  }
}

type TopicSectionMuteRow = {
  muted_until: string
  muted_by_account_id: string | null
  reason: string | null
}

function toSectionMuteSnapshot(row: TopicSectionMuteRow | undefined, now: number): TopicSectionMuteSnapshot {
  if (!row) {
    return { isMuted: false, mutedUntil: null, mutedByAccountId: null, reason: null }
  }
  const mutedUntilIso = dbDateToUtc(row.muted_until)
  return {
    isMuted: new Date(mutedUntilIso).getTime() > now,
    mutedUntil: mutedUntilIso,
    mutedByAccountId: row.muted_by_account_id,
    reason: row.reason,
  }
}

function toSqliteDateTimeString(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

type TopicReportRow = {
  report_id: string
  topic_id: string
  reporter_profile_id: string
  reason: string
  status: TopicReportStatus
  reviewed_by_account_id: string | null
  reviewed_at: string | null
  created_at: string
}

function toReportSnapshot(row: TopicReportRow): TopicReportSnapshot {
  return {
    reportId: row.report_id,
    topicId: row.topic_id,
    reporterProfileId: row.reporter_profile_id,
    reason: row.reason,
    status: row.status,
    reviewedByAccountId: row.reviewed_by_account_id,
    reviewedAt: row.reviewed_at ? dbDateToUtc(row.reviewed_at) : null,
    createdAt: dbDateToUtc(row.created_at),
  }
}

type AuditRow = {
  log_id: string
  actor_account_id: string | null
  actor_role: TopicModeratorRole
  action: TopicModerationAction
  topic_id: string
  target_profile_id: string | null
  reason: string | null
  expires_at: string | null
  created_at: string
}

function toAuditEntry(row: AuditRow): TopicModerationAuditEntry {
  return {
    logId: row.log_id,
    actorAccountId: row.actor_account_id,
    actorRole: row.actor_role,
    action: row.action,
    topicId: row.topic_id,
    targetProfileId: row.target_profile_id,
    reason: row.reason,
    expiresAt: row.expires_at ? dbDateToUtc(row.expires_at) : null,
    createdAt: dbDateToUtc(row.created_at),
  }
}

// Duplicate/spam guard прозорец за report-и — един и същ (reporter, topic)
// не може да докладва повторно в рамките на този прозорец. Persisted DB
// query (не in-memory Map), restart-safe, следва established
// duplicate-guard семантика (виж isDuplicateTopicMessage в index.ts), но
// тук е по-дълъг прозорец (report-ите са рядко, преднамерено действие, не
// chat спам) — минути, не секунди.
const TOPIC_REPORT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000

export async function createTopicModerationStore(databaseFilePath: string): Promise<TopicModerationStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  // ─── Lock/Unlock ──────────────────────────────────────────────────────────

  const selectTopicLockStatement = database.prepare(`
    SELECT status, locked_until, locked_by_account_id, locked_reason FROM topics WHERE topic_id = ? LIMIT 1;
  `)

  const updateTopicLockStatement = database.prepare(`
    UPDATE topics SET status = 'locked', locked_until = ?, locked_by_account_id = ?, locked_reason = ?
    WHERE topic_id = ?;
  `)

  const insertAuditStatement = database.prepare(`
    INSERT INTO topic_moderation_audit_log (
      log_id, actor_account_id, actor_role, action, topic_id, target_profile_id, reason, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
  `)

  // Връща генерирания log_id (нужно за topic_mute_evidence cross-reference,
  // виж insertMuteEvidence по-долу) — съществуващите 8 call sites просто
  // игнорират връщаната стойност (backward-compatible additive промяна).
  function appendAudit(input: {
    actorAccountId: string
    actorRole: TopicModeratorRole
    action: TopicModerationAction
    topicId: string
    targetProfileId: string | null
    reason: string | null
    expiresAt: string | null
  }): string {
    const logId = randomUUID()
    insertAuditStatement.run(
      logId,
      input.actorAccountId,
      input.actorRole,
      input.action,
      input.topicId,
      input.targetProfileId,
      input.reason,
      input.expiresAt,
    )
    return logId
  }

  function lockTopic(input: {
    topicId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
    reason: string
    durationMs: number
  }): TopicLockSnapshot {
    const now = Date.now()
    const lockedUntil = toSqliteDateTimeString(new Date(now + input.durationMs))

    database.exec('BEGIN IMMEDIATE;')
    try {
      updateTopicLockStatement.run(lockedUntil, input.actorAccountId, input.reason, input.topicId)
      appendAudit({
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        action: 'topic_lock',
        topicId: input.topicId,
        targetProfileId: null,
        reason: input.reason,
        expiresAt: lockedUntil,
      })
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }

    const row = selectTopicLockStatement.get(input.topicId) as TopicLockRow
    return toLockSnapshot(row, now)
  }

  // Ръчен unlock връща status обратно на 'active' (НЕ 'removed' — темата не
  // е била премахната) и NULL-ва locked_* колоните directno (не overwrite с
  // минала дата) — виж migration коментара за rationale (семпъл lookup, без
  // допълнителен is_active флаг). Idempotent: ако темата вече не е заключена
  // (locked_until е NULL ИЛИ вече е изтекла естествено), връща changed=false
  // и НЕ append-ва излишен audit ред за "unlock на нищо" (брифа т.12: "не
  // връщай generic server error при harmless repeated action" — тук просто
  // no-op, без грешка).
  const clearTopicLockStatement = database.prepare(`
    UPDATE topics SET status = 'active', locked_until = NULL, locked_by_account_id = NULL, locked_reason = NULL
    WHERE topic_id = ?;
  `)

  function unlockTopic(input: {
    topicId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
  }): { changed: boolean; snapshot: TopicLockSnapshot } {
    const now = Date.now()
    const row = selectTopicLockStatement.get(input.topicId) as TopicLockRow | undefined
    if (row === undefined) {
      return { changed: false, snapshot: { isLocked: false, lockedUntil: null, lockedByAccountId: null, lockedReason: null } }
    }
    const currentSnapshot = toLockSnapshot(row, now)
    if (!currentSnapshot.isLocked) {
      return { changed: false, snapshot: currentSnapshot }
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      clearTopicLockStatement.run(input.topicId)
      appendAudit({
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        action: 'topic_unlock',
        topicId: input.topicId,
        targetProfileId: null,
        reason: null,
        expiresAt: null,
      })
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }

    return { changed: true, snapshot: { isLocked: false, lockedUntil: null, lockedByAccountId: null, lockedReason: null } }
  }

  function getTopicLockSnapshot(topicId: string): TopicLockSnapshot | null {
    const row = selectTopicLockStatement.get(topicId) as TopicLockRow | undefined
    if (row === undefined) return null
    return toLockSnapshot(row, Date.now())
  }

  // ─── Mute/Unmute ──────────────────────────────────────────────────────────

  const upsertMuteStatement = database.prepare(`
    INSERT INTO topic_mutes (topic_id, profile_id, muted_until, muted_by_account_id, reason)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(topic_id, profile_id) DO UPDATE SET
      muted_until = excluded.muted_until,
      muted_by_account_id = excluded.muted_by_account_id,
      reason = excluded.reason,
      created_at = CURRENT_TIMESTAMP;
  `)

  const selectMuteStatement = database.prepare(`
    SELECT muted_until, muted_by_account_id, reason FROM topic_mutes WHERE topic_id = ? AND profile_id = ? LIMIT 1;
  `)

  function muteProfileInTopic(input: {
    topicId: string
    profileId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
    reason: string
    durationMs: number
  }): TopicMuteSnapshot {
    const now = Date.now()
    const mutedUntil = toSqliteDateTimeString(new Date(now + input.durationMs))

    database.exec('BEGIN IMMEDIATE;')
    try {
      upsertMuteStatement.run(input.topicId, input.profileId, mutedUntil, input.actorAccountId, input.reason)
      appendAudit({
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        action: 'topic_mute',
        topicId: input.topicId,
        targetProfileId: input.profileId,
        reason: input.reason,
        expiresAt: mutedUntil,
      })
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }

    const row = selectMuteStatement.get(input.topicId, input.profileId) as TopicMuteRow
    return toMuteSnapshot(row, now)
  }

  // Ръчен unmute ТРИЕ реда (не overwrite с минала дата) — семпъл lookup
  // (PRIMARY KEY presence = active mute) без нужда от expiry comparison за
  // "изтрит ли е записа логически". Idempotent: DELETE на несъществуващ ред
  // просто changes=0, без грешка (брифа т.12).
  const deleteMuteStatement = database.prepare(`
    DELETE FROM topic_mutes WHERE topic_id = ? AND profile_id = ?;
  `)

  function unmuteProfileInTopic(input: {
    topicId: string
    profileId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
  }): { changed: boolean } {
    const row = selectMuteStatement.get(input.topicId, input.profileId) as TopicMuteRow | undefined
    const wasActive = row !== undefined && toMuteSnapshot(row, Date.now()).isMuted
    if (!wasActive) {
      return { changed: false }
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      deleteMuteStatement.run(input.topicId, input.profileId)
      appendAudit({
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        action: 'topic_unmute',
        topicId: input.topicId,
        targetProfileId: input.profileId,
        reason: null,
        expiresAt: null,
      })
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }

    return { changed: true }
  }

  function getMuteSnapshot(topicId: string, profileId: string): TopicMuteSnapshot {
    const row = selectMuteStatement.get(topicId, profileId) as TopicMuteRow | undefined
    return toMuteSnapshot(row, Date.now())
  }

  function isProfileMutedInTopic(topicId: string, profileId: string): boolean {
    return getMuteSnapshot(topicId, profileId).isMuted
  }

  // ─── Global Topics-section mute (enforcement source of truth) ──────────
  //
  // Reuse-ва идентичен UPSERT/DELETE/BEGIN IMMEDIATE pattern като горния
  // per-topic mute/unmute — единствената разлика е PRIMARY KEY(profile_id)
  // вместо (topic_id, profile_id). `topicId`, подаден на входа, се пази
  // САМО в audit log-а (appendAudit по-долу) като source context — никога
  // не участва в самата topic_section_mutes заявка.

  const upsertSectionMuteStatement = database.prepare(`
    INSERT INTO topic_section_mutes (profile_id, muted_until, muted_by_account_id, reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      muted_until = excluded.muted_until,
      muted_by_account_id = excluded.muted_by_account_id,
      reason = excluded.reason,
      created_at = CURRENT_TIMESTAMP;
  `)

  const selectSectionMuteStatement = database.prepare(`
    SELECT muted_until, muted_by_account_id, reason FROM topic_section_mutes WHERE profile_id = ? LIMIT 1;
  `)

  // ─── Mute evidence/history (Лафче mute-evidence брифа) ────────────────────
  //
  // ЗАЩО query-ваме topic_messages/topic_message_attachments ДИРЕКТНО тук
  // (не през topicMessageStore): established прецедент в тоя файл —
  // selectAttachmentFilenamesForTopicStatement/deleteAttachmentsForTopicStatement
  // по-долу вече правят точно това (deleteTopic flow-а). Всеки store има
  // собствена DatabaseSync connection към СЪЩИЯ физически .sqlite файл —
  // cross-table четене в рамките на ЕДНА транзакция изисква ЕДНА connection
  // (BEGIN IMMEDIATE тук трябва да покрие и snapshot SELECT-а, и evidence
  // INSERT-а atomically), затова не може да делегираме snapshot fetch-а на
  // отделен topicMessageStore instance с друга connection.
  const selectSourceMessageForEvidenceStatement = database.prepare(`
    SELECT body, created_at, deleted_at, topic_id FROM topic_messages WHERE message_id = ? LIMIT 1;
  `)
  const selectSourceAttachmentForEvidenceStatement = database.prepare(`
    SELECT storage_filename, width, height FROM topic_message_attachments WHERE message_id = ? LIMIT 1;
  `)
  const insertMuteEvidenceStatement = database.prepare(`
    INSERT INTO topic_mute_evidence (
      mute_history_id, mute_audit_log_id, profile_id, source_topic_id, source_message_id, source_kind,
      source_body_snapshot, source_attachment_storage_filename, source_attachment_width, source_attachment_height,
      source_created_at, original_message_deleted_at, muted_by_account_id, muted_by_role,
      reason_text, reason_category, duration_ms, muted_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `)

  /**
   * Server-side snapshot (Лафче mute-evidence брифа §1/§3: "Snapshot-ът
   * трябва да се създава server-side от DB данните", "Не вярвай на content,
   * изпратен от клиента") — зарежда source_body_snapshot/attachment
   * ИЗКЛЮЧИТЕЛНО от topic_messages/topic_message_attachments в момента на
   * mute-а, никога от client payload. sourceMessageId===null означава mute
   * без конкретен triggering post → snapshot полетата остават празни,
   * sourceKind принудително 'unspecified'.
   */
  function insertMuteEvidence(input: {
    muteAuditLogId: string
    profileId: string
    topicId: string
    sourceMessageId: string | null
    sourceKind: TopicMuteEvidenceSourceKind
    mutedByAccountId: string
    mutedByRole: TopicModeratorRole
    reasonText: string
    reasonCategory: TopicMuteEvidenceReasonCategory | null
    durationMs: number
    mutedUntil: string
  }): void {
    const sourceRow = input.sourceMessageId !== null
      ? (selectSourceMessageForEvidenceStatement.get(input.sourceMessageId) as
          { body: string; created_at: string; deleted_at: string | null; topic_id: string } | undefined)
      : undefined
    const attachmentRow = input.sourceMessageId !== null
      ? (selectSourceAttachmentForEvidenceStatement.get(input.sourceMessageId) as
          { storage_filename: string; width: number; height: number } | undefined)
      : undefined

    insertMuteEvidenceStatement.run(
      randomUUID(),
      input.muteAuditLogId,
      input.profileId,
      input.topicId,
      input.sourceMessageId,
      sourceRow ? input.sourceKind : 'unspecified',
      sourceRow?.body ?? '',
      attachmentRow?.storage_filename ?? null,
      attachmentRow?.width ?? null,
      attachmentRow?.height ?? null,
      sourceRow?.created_at ?? null,
      sourceRow?.deleted_at ?? null,
      input.mutedByAccountId,
      input.mutedByRole,
      input.reasonText,
      input.reasonCategory,
      input.durationMs,
      input.mutedUntil,
    )
  }

  function muteProfileInTopics(input: {
    topicId: string
    profileId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
    reason: string
    reasonCategory?: TopicMuteEvidenceReasonCategory | null
    durationMs: number
    sourceMessageId?: string | null
    sourceKind?: TopicMuteEvidenceSourceKind
  }): TopicSectionMuteSnapshot {
    const now = Date.now()
    const mutedUntil = toSqliteDateTimeString(new Date(now + input.durationMs))

    database.exec('BEGIN IMMEDIATE;')
    try {
      upsertSectionMuteStatement.run(input.profileId, mutedUntil, input.actorAccountId, input.reason)
      const auditLogId = appendAudit({
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        action: 'topic_mute',
        topicId: input.topicId,
        targetProfileId: input.profileId,
        reason: input.reason,
        expiresAt: mutedUntil,
      })
      // ЗАДЪЛЖИТЕЛНО в СЪЩАТА транзакция — mute state update без evidence
      // insert е недопустимо (Лафче mute-evidence брифа §3: "Не допускай
      // ситуация: mute е наложен; но evidence/history record липсва").
      insertMuteEvidence({
        muteAuditLogId: auditLogId,
        profileId: input.profileId,
        topicId: input.topicId,
        sourceMessageId: input.sourceMessageId ?? null,
        sourceKind: input.sourceKind ?? 'unspecified',
        mutedByAccountId: input.actorAccountId,
        mutedByRole: input.actorRole,
        reasonText: input.reason,
        reasonCategory: input.reasonCategory ?? null,
        durationMs: input.durationMs,
        mutedUntil,
      })
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }

    const row = selectSectionMuteStatement.get(input.profileId) as TopicSectionMuteRow
    return toSectionMuteSnapshot(row, now)
  }

  // Ръчен unmute ТРИЕ реда (не overwrite с минала дата) — same rationale
  // като deleteMuteStatement по-горе. Idempotent: DELETE на несъществуващ
  // ред просто changes=0, без грешка.
  const deleteSectionMuteStatement = database.prepare(`
    DELETE FROM topic_section_mutes WHERE profile_id = ?;
  `)

  // Маркира НАЙ-СКОРОШНИЯ 'active' evidence ред на профила като
  // manually_unmuted (Лафче mute-evidence брифа §2: "дата/час на предсрочно
  // unmute", "кой е направил unmute"). "Най-скорошен active" вместо "всички
  // active" — по дизайн максимум 1 евентуален active evidence ред на
  // профил в даден момент (mute-ът е section-wide UPSERT, нов mute
  // презаписва предишния state ред, значи предишният evidence ред би
  // трябвало вече да е expired/manually_unmuted от предходно действие; LIMIT
  // 1 е defensive, не разчита на тази инвариантност строго).
  const markLatestActiveMuteEvidenceUnmutedStatement = database.prepare(`
    UPDATE topic_mute_evidence
    SET status = 'manually_unmuted', unmuted_at = CURRENT_TIMESTAMP, unmuted_by_account_id = ?
    WHERE mute_history_id = (
      SELECT mute_history_id FROM topic_mute_evidence
      WHERE profile_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    );
  `)

  function unmuteProfileInTopics(input: {
    topicId: string
    profileId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
  }): { changed: boolean } {
    const row = selectSectionMuteStatement.get(input.profileId) as TopicSectionMuteRow | undefined
    const wasActive = row !== undefined && toSectionMuteSnapshot(row, Date.now()).isMuted
    if (!wasActive) {
      return { changed: false }
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      deleteSectionMuteStatement.run(input.profileId)
      appendAudit({
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        action: 'topic_unmute',
        topicId: input.topicId,
        targetProfileId: input.profileId,
        reason: null,
        expiresAt: null,
      })
      markLatestActiveMuteEvidenceUnmutedStatement.run(input.actorAccountId, input.profileId)
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }

    return { changed: true }
  }

  function getSectionMuteSnapshot(profileId: string): TopicSectionMuteSnapshot {
    const row = selectSectionMuteStatement.get(profileId) as TopicSectionMuteRow | undefined
    return toSectionMuteSnapshot(row, Date.now())
  }

  function isProfileMutedInTopicsSection(profileId: string): boolean {
    return getSectionMuteSnapshot(profileId).isMuted
  }

  // LEFT JOIN topic_messages за LIVE deleted_at (не само snapshot-натия
  // original_message_deleted_at, взет В МОМЕНТА на mute-а) — ако постът
  // бъде изтрит СЛЕД като evidence реда вече съществува, COALESCE-ът тук
  // хваща тази по-късна промяна at READ time (established pattern в целия
  // файл — isMuted/isLocked никога не са persisted transitions). m.deleted_at
  // е NULL и след hard-purge (редът вече не съществува), в който случай
  // COALESCE пада обратно към snapshot-натата стойност от момента на mute-а.
  const selectMuteEvidenceForProfileStatement = database.prepare(`
    SELECT
      e.mute_history_id, e.mute_audit_log_id, e.profile_id, e.source_topic_id, e.source_message_id, e.source_kind,
      e.source_body_snapshot, e.source_attachment_storage_filename, e.source_attachment_width, e.source_attachment_height,
      e.source_created_at, COALESCE(m.deleted_at, e.original_message_deleted_at) AS original_message_deleted_at,
      e.muted_by_account_id, e.muted_by_role,
      e.reason_text, e.reason_category, e.duration_ms, e.muted_until, e.status, e.unmuted_at, e.unmuted_by_account_id, e.created_at
    FROM topic_mute_evidence e
    LEFT JOIN topic_messages m ON m.message_id = e.source_message_id
    WHERE e.profile_id = ?
    ORDER BY e.created_at DESC
    LIMIT ?;
  `)

  type TopicMuteEvidenceRow = {
    mute_history_id: string
    mute_audit_log_id: string
    profile_id: string
    source_topic_id: string
    source_message_id: string | null
    source_kind: TopicMuteEvidenceSourceKind
    source_body_snapshot: string
    source_attachment_storage_filename: string | null
    source_attachment_width: number | null
    source_attachment_height: number | null
    source_created_at: string | null
    original_message_deleted_at: string | null
    muted_by_account_id: string | null
    muted_by_role: TopicModeratorRole
    reason_text: string | null
    reason_category: TopicMuteEvidenceReasonCategory | null
    duration_ms: number
    muted_until: string
    status: TopicMuteEvidenceStatus
    unmuted_at: string | null
    unmuted_by_account_id: string | null
    created_at: string
  }

  // status='active' в DB е computed at WRITE time (кога mute-ът е наложен),
  // НЕ auto-transition-ва към 'expired' при естествено изтичане (няма
  // background job) — presentation layer тук computed-ва ефективния status
  // at READ time (mirror на established isMuted/isLocked pattern в целия
  // файл: expiry сравнение при четене, никога persisted transition).
  // 'manually_unmuted' статус в DB е authoritative, НЕ се пренаписва.
  function toMuteEvidenceEntry(row: TopicMuteEvidenceRow, now: number): TopicMuteEvidenceEntry {
    const effectiveStatus: TopicMuteEvidenceStatus = row.status === 'active' && new Date(dbDateToUtc(row.muted_until)).getTime() <= now
      ? 'expired'
      : row.status
    return {
      muteHistoryId: row.mute_history_id,
      muteAuditLogId: row.mute_audit_log_id,
      profileId: row.profile_id,
      sourceTopicId: row.source_topic_id,
      sourceMessageId: row.source_message_id,
      sourceKind: row.source_kind,
      sourceBodySnapshot: row.source_body_snapshot,
      sourceAttachment: row.source_attachment_storage_filename !== null && row.source_attachment_width !== null && row.source_attachment_height !== null
        ? { storageFilename: row.source_attachment_storage_filename, width: row.source_attachment_width, height: row.source_attachment_height }
        : null,
      sourceCreatedAt: row.source_created_at !== null ? dbDateToUtc(row.source_created_at) : null,
      originalMessageDeletedAt: row.original_message_deleted_at !== null ? dbDateToUtc(row.original_message_deleted_at) : null,
      mutedByAccountId: row.muted_by_account_id,
      mutedByRole: row.muted_by_role,
      reasonText: row.reason_text,
      reasonCategory: row.reason_category,
      durationMs: row.duration_ms,
      mutedUntil: dbDateToUtc(row.muted_until),
      status: effectiveStatus,
      unmutedAt: row.unmuted_at !== null ? dbDateToUtc(row.unmuted_at) : null,
      unmutedByAccountId: row.unmuted_by_account_id,
      createdAt: dbDateToUtc(row.created_at),
    }
  }

  function listMuteEvidenceForProfile(profileId: string, limit: number): TopicMuteEvidenceEntry[] {
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
    const rows = selectMuteEvidenceForProfileStatement.all(profileId, normalizedLimit) as TopicMuteEvidenceRow[]
    const now = Date.now()
    return rows.map((row) => toMuteEvidenceEntry(row, now))
  }

  // ─── Delete (soft-delete + eager attachment cleanup) ────────────────────

  const selectAttachmentFilenamesForTopicStatement = database.prepare(`
    SELECT a.storage_filename
    FROM topic_message_attachments a
    INNER JOIN topic_messages m ON m.message_id = a.message_id
    WHERE m.topic_id = ?;
  `)

  function getAttachmentFilenamesForTopic(topicId: string): string[] {
    const rows = selectAttachmentFilenamesForTopicStatement.all(topicId) as Array<{ storage_filename: string }>
    return rows.map((row) => row.storage_filename)
  }

  const selectTopicStatusStatement = database.prepare(`
    SELECT status FROM topics WHERE topic_id = ? LIMIT 1;
  `)

  const updateTopicRemovedStatement = database.prepare(`
    UPDATE topics SET status = 'removed', removed_by_account_id = ?, removed_reason = ?, removed_at = CURRENT_TIMESTAMP
    WHERE topic_id = ?;
  `)

  const softDeleteTopicMessagesStatement = database.prepare(`
    UPDATE topic_messages SET deleted_at = CURRENT_TIMESTAMP WHERE topic_id = ? AND deleted_at IS NULL;
  `)

  // Attachment hard-delete при whole-topic delete (продуктово решение:
  // attachments НЕ се пазят 180 дни, за разлика от text съдържанието) —
  // filenames вече се събират чрез getAttachmentFilenamesForTopic по-горе,
  // ПРЕДИ да ги трием, за да можем да ги enqueue-нем за физически cleanup в
  // СЪЩАТА транзакция (виж deleteTopic по-долу).
  const deleteAttachmentsForTopicStatement = database.prepare(`
    DELETE FROM topic_message_attachments
    WHERE message_id IN (SELECT message_id FROM topic_messages WHERE topic_id = ?);
  `)

  // Mirror на topicMessageStore.enqueueAttachmentDeletion insert statement-а
  // (СЪЩАТА таблица, СЪЩАТА SQLite база — topic_message_attachment_deletions
  // няма FK към нищо, чисто operational queue) — вмъкнат тук directno, за да
  // може insertion-ът да е ЧАСТ от deleteTopic транзакцията по-долу
  // (canonical transaction owner, виж коментара там), не отделно извикване
  // от caller-a след COMMIT.
  const insertAttachmentDeletionStatement = database.prepare(`
    INSERT INTO topic_message_attachment_deletions (storage_filename) VALUES (?);
  `)

  // Soft-delete за topic/messages (текстовото съдържание се пази за 180-дневен
  // retention прозорец, виж purgeRemovedTopicsBefore) — темата остава четима
  // за audit/history цели, но всички read пътища (listActiveTopics/
  // handleTopicsRequest) вече третират status='removed' идентично на "не
  // съществува" (Етап 1-3 established convention).
  //
  // Attachments са ДРУГ lifecycle от text съдържанието (продуктово решение —
  // не се пазят 180 дни): topic_message_attachments редовете се HARD-DELETE-
  // ват веднага (не soft-delete), физическото cleanup queue insertion е
  // ЧАСТ от СЪЩАТА BEGIN IMMEDIATE транзакция като topics/topic_messages
  // update-ите — единствен canonical transaction owner тук в store-а, за да
  // няма прозорец между "DB reference изтрит" и "queue job insert-нат",
  // където process crash би оставил physical файл без cleanup job (виж
  // corrective pass брифа §4).
  function deleteTopic(input: {
    topicId: string
    actorAccountId: string
    actorRole: TopicModeratorRole
    reason: string
  }): { ok: true; deletedAttachmentFilenames: string[] } | { ok: false; code: 'not_found' | 'already_removed' } {
    const statusRow = selectTopicStatusStatement.get(input.topicId) as { status: string } | undefined
    if (statusRow === undefined) {
      return { ok: false, code: 'not_found' }
    }
    if (statusRow.status === 'removed') {
      return { ok: false, code: 'already_removed' }
    }

    let deletedAttachmentFilenames: string[] = []

    database.exec('BEGIN IMMEDIATE;')
    try {
      deletedAttachmentFilenames = getAttachmentFilenamesForTopic(input.topicId)
      for (const filename of deletedAttachmentFilenames) {
        insertAttachmentDeletionStatement.run(filename)
      }
      deleteAttachmentsForTopicStatement.run(input.topicId)
      updateTopicRemovedStatement.run(input.actorAccountId, input.reason, input.topicId)
      softDeleteTopicMessagesStatement.run(input.topicId)
      appendAudit({
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        action: 'topic_delete',
        topicId: input.topicId,
        targetProfileId: null,
        reason: input.reason,
        expiresAt: null,
      })
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }

    return { ok: true, deletedAttachmentFilenames }
  }

  // ─── Reports ─────────────────────────────────────────────────────────────

  const selectRecentReportStatement = database.prepare(`
    SELECT 1 FROM topic_reports
    WHERE reporter_profile_id = ? AND topic_id = ? AND created_at > ?
    LIMIT 1;
  `)

  const insertReportStatement = database.prepare(`
    INSERT INTO topic_reports (report_id, topic_id, reporter_profile_id, reason)
    VALUES (?, ?, ?, ?);
  `)

  const selectReportByIdStatement = database.prepare(`
    SELECT report_id, topic_id, reporter_profile_id, reason, status, reviewed_by_account_id, reviewed_at, created_at
    FROM topic_reports WHERE report_id = ? LIMIT 1;
  `)

  function createReport(input: {
    topicId: string
    reporterProfileId: string
    reason: string
  }): CreateTopicReportResult {
    const cutoff = toSqliteDateTimeString(new Date(Date.now() - TOPIC_REPORT_DUPLICATE_WINDOW_MS))
    const existing = selectRecentReportStatement.get(input.reporterProfileId, input.topicId, cutoff)
    if (existing !== undefined) {
      return { ok: false, code: 'duplicate' }
    }

    const reportId = randomUUID()
    insertReportStatement.run(reportId, input.topicId, input.reporterProfileId, input.reason)
    const row = selectReportByIdStatement.get(reportId) as TopicReportRow
    return { ok: true, report: toReportSnapshot(row) }
  }

  const selectReportsByStatusStatement = database.prepare(`
    SELECT report_id, topic_id, reporter_profile_id, reason, status, reviewed_by_account_id, reviewed_at, created_at
    FROM topic_reports WHERE status = ? ORDER BY created_at DESC LIMIT ?;
  `)

  const selectAllReportsStatement = database.prepare(`
    SELECT report_id, topic_id, reporter_profile_id, reason, status, reviewed_by_account_id, reviewed_at, created_at
    FROM topic_reports ORDER BY created_at DESC LIMIT ?;
  `)

  function listReports(status: TopicReportStatus | null, limit: number): TopicReportSnapshot[] {
    const rows = (status === null
      ? selectAllReportsStatement.all(limit)
      : selectReportsByStatusStatement.all(status, limit)) as TopicReportRow[]
    return rows.map(toReportSnapshot)
  }

  const countPendingReportsStatement = database.prepare(`
    SELECT COUNT(*) as cnt FROM topic_reports WHERE status = 'pending';
  `)

  function countPendingReports(): number {
    const row = countPendingReportsStatement.get() as { cnt: number }
    return row.cnt
  }

  const updateReportStatusStatement = database.prepare(`
    UPDATE topic_reports SET status = ?, reviewed_by_account_id = ?, reviewed_at = CURRENT_TIMESTAMP WHERE report_id = ?;
  `)

  function reviewReport(input: {
    reportId: string
    status: 'reviewed' | 'dismissed'
    actorAccountId: string
  }): { ok: true; report: TopicReportSnapshot } | { ok: false; code: 'not_found' } {
    const existing = selectReportByIdStatement.get(input.reportId) as TopicReportRow | undefined
    if (existing === undefined) {
      return { ok: false, code: 'not_found' }
    }
    updateReportStatusStatement.run(input.status, input.actorAccountId, input.reportId)
    const row = selectReportByIdStatement.get(input.reportId) as TopicReportRow
    return { ok: true, report: toReportSnapshot(row) }
  }

  // ─── Audit log ───────────────────────────────────────────────────────────

  const selectAuditForTopicStatement = database.prepare(`
    SELECT log_id, actor_account_id, actor_role, action, topic_id, target_profile_id, reason, expires_at, created_at
    FROM topic_moderation_audit_log
    WHERE topic_id = ?
    ORDER BY created_at DESC
    LIMIT ?;
  `)

  function listAuditLogForTopic(topicId: string, limit: number): TopicModerationAuditEntry[] {
    const rows = selectAuditForTopicStatement.all(topicId, limit) as AuditRow[]
    return rows.map(toAuditEntry)
  }

  // ─── 180-day retention final purge ──────────────────────────────────────
  //
  // Bounded batch DELETE, mirror на lobbyChatStore.purgeOlderThanDays/
  // topicMessageStore.purgeDoneAttachmentDeletions established convention —
  // SELECT topic_id ... ORDER BY topic_id ASC LIMIT ? (без OFFSET), после
  // DELETE FROM topics WHERE topic_id IN (...). `topics.removed_at` е
  // authoritative retention anchor (НЕ created_at, НЕ message deleted_at —
  // виж корективния брифа §8/§10).
  //
  // Boundary policy (продуктово решение, corrective pass #2): "след като са
  // навършени 180 дни от removed_at, темата е eligible" → removed_at <=
  // cutoff (НЕ строго <). 179 дни: НЕ eligible. Точно 180 дни: eligible.
  // 181 дни: eligible.
  //
  // FK cascade inventory (проверено срещу миграциите, виж финалния отчет):
  //   topic_messages          → ON DELETE CASCADE от topics (изтрива root+replies)
  //   topic_message_likes     → ON DELETE CASCADE от topic_messages (двойна каскада)
  //   topic_mutes             → ON DELETE CASCADE от topics
  //   topic_reports           → ON DELETE CASCADE от topics
  //   topic_moderation_audit_log.topic_id → БЕЗ FK (умишлено, виж migration
  //     коментара: "audit логът трябва да преживее topic_delete действието
  //     самото" — това important за immediate delete, за да оцелее lock/
  //     mute/delete audit history до финалния purge). Тъй като FK липсва,
  //     redовете НЕ се трият автоматично при DELETE FROM topics — explicit
  //     DELETE FROM topic_moderation_audit_log WHERE topic_id = ? се прави
  //     ТУК, в СЪЩАТА транзакция, ПРЕДИ topics delete-а (продуктово решение
  //     #2: audit history също е с 180-дневен retention, не безсрочен).
  //   topic_message_attachments/topic_message_attachment_deletions — вече
  //     hard-deleted/enqueue-нати при самия immediate delete (deleteTopic),
  //     нищо не остава за тях тук; cleanup queue-то е operational
  //     инфраструктура и НЕ се трие от topic purge-а.
  const selectPurgeEligibleTopicIdsStatement = database.prepare(`
    SELECT topic_id FROM topics
    WHERE status = 'removed' AND removed_at IS NOT NULL AND removed_at <= ?
    ORDER BY topic_id ASC
    LIMIT ?;
  `)

  const deleteTopicsByIdStatementCache = new Map<number, ReturnType<typeof database.prepare>>()
  function getDeleteTopicsByIdsStatement(count: number): ReturnType<typeof database.prepare> {
    const cached = deleteTopicsByIdStatementCache.get(count)
    if (cached) return cached
    const placeholders = Array.from({ length: count }, () => '?').join(',')
    const statement = database.prepare(`DELETE FROM topics WHERE topic_id IN (${placeholders});`)
    deleteTopicsByIdStatementCache.set(count, statement)
    return statement
  }

  const deleteAuditLogByIdStatementCache = new Map<number, ReturnType<typeof database.prepare>>()
  function getDeleteAuditLogByTopicIdsStatement(count: number): ReturnType<typeof database.prepare> {
    const cached = deleteAuditLogByIdStatementCache.get(count)
    if (cached) return cached
    const placeholders = Array.from({ length: count }, () => '?').join(',')
    const statement = database.prepare(`DELETE FROM topic_moderation_audit_log WHERE topic_id IN (${placeholders});`)
    deleteAuditLogByIdStatementCache.set(count, statement)
    return statement
  }

  /**
   * Purge-ва removed topics, чийто `removed_at` е >= 180 дни в миналото
   * (cutoff се подава от caller-а — index.ts computed-ва точния UTC cutoff;
   * removed_at <= cutoff, виж boundary policy по-горе), заедно с topic-
   * specific moderation audit history-то им. Всеки batch (SELECT eligible
   * ids → DELETE audit log редове за тези ids → DELETE topics редове) е
   * ЕДНА BEGIN IMMEDIATE/COMMIT транзакция — atomic по batch, никога
   * "topics изтрити, audit останал" или обратното при crash/грешка
   * (ROLLBACK при exception, нищо от batch-а не се прилага частично).
   * Bounded batch (без OFFSET) — safe за повторни/cross-instance извиквания:
   * ако няма eligible редове, no-op; ако два instance-а покрият частично
   * застъпващ се batch, SQLite row-level DELETE semantics не corrupt-ва
   * нищо (втория instance просто ще завари вече изтрити topic_id-та,
   * DELETE...WHERE IN на несъществуващ id е no-op).
   */
  function purgeRemovedTopicsBefore(cutoff: Date, batchSize: number): number {
    const cutoffStr = toSqliteDateTimeString(cutoff)
    let totalDeleted = 0
    for (;;) {
      const rows = selectPurgeEligibleTopicIdsStatement.all(cutoffStr, batchSize) as Array<{ topic_id: string }>
      if (rows.length === 0) break
      const ids = rows.map((row) => row.topic_id)
      database.exec('BEGIN IMMEDIATE;')
      try {
        getDeleteAuditLogByTopicIdsStatement(ids.length).run(...ids)
        getDeleteTopicsByIdsStatement(ids.length).run(...ids)
        database.exec('COMMIT;')
      } catch (error) {
        database.exec('ROLLBACK;')
        throw error
      }
      totalDeleted += ids.length
      if (rows.length < batchSize) break
    }
    return totalDeleted
  }

  function close(): void {
    database.close()
  }

  return {
    lockTopic,
    unlockTopic,
    getTopicLockSnapshot,
    muteProfileInTopic,
    unmuteProfileInTopic,
    getMuteSnapshot,
    isProfileMutedInTopic,
    muteProfileInTopics,
    unmuteProfileInTopics,
    getSectionMuteSnapshot,
    isProfileMutedInTopicsSection,
    listMuteEvidenceForProfile,
    getAttachmentFilenamesForTopic,
    deleteTopic,
    createReport,
    listReports,
    countPendingReports,
    reviewReport,
    listAuditLogForTopic,
    purgeRemovedTopicsBefore,
    close,
  }
}
