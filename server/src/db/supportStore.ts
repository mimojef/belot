import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type SupportAttachmentSnapshot = {
  attachmentId: string
  width: number
  height: number
  byteSize: number
  viewUrl: string
  downloadUrl: string
}

export type NewSupportAttachmentInput = {
  storageFilename: string
  width: number
  height: number
  byteSize: number
  contentType: string
}

export type SupportMessageSnapshot = {
  messageId: string
  profileId: string
  body: string
  isFromAdmin: boolean
  createdAt: string
  attachment: SupportAttachmentSnapshot | null
}

export type SupportConversationSnapshot = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  lastMessageBody: string
  lastMessageIsFromAdmin: boolean
  unreadByAdmin: number
  updatedAt: string
  /** Ненулево само за архивирани разговори на hard-deleted профили — виж SupportDeletionArchiveSnapshot. */
  deletionArchive: SupportDeletionArchiveSnapshot | null
}

/**
 * Immutable marker+snapshot ред за support разговор на hard-deleted профил
 * (виж 20260903_003_create_support_deletion_archive.sql и
 * profileHardDeleteService.ts's insertSupportDeletionArchiveStatement).
 * Самото съществуване на такъв ред за даден profileId сигнализира на
 * admin/Pika Team UI-я, че разговорът е read-only архив, НЕ жива conversation
 * — profiles редът за този profileId вече не съществува.
 * EXPLICIT ATTRIBUTION ONLY — редът се пише единствено когато
 * profileHardDeleteService е validate-нал конкретно user-authored support
 * съобщение вътре в hard-delete транзакцията, затова request_message_id/
 * requested_at са NOT NULL в schema-та.
 */
export type SupportDeletionArchiveSnapshot = {
  profileId: string
  usernameSnapshot: string
  displayNameSnapshot: string
  requestMessageId: string
  requestedAt: string
  deletedAt: string
  deletedByProfileId: string | null
  reason: string
}

export type SupportStore = {
  getMessages: (profileId: string) => SupportMessageSnapshot[]
  sendUserMessage: (profileId: string, body: string, attachment?: NewSupportAttachmentInput | null) => SupportMessageSnapshot
  /**
   * Връща null и при "профилът няма support съобщения" (стар поведение), И
   * при "разговорът е архивиран заради hard-deleted профил" (spec §C — "не
   * позволявай изпращане на нови съобщения") — извикващата страна (index.ts)
   * не различава двата случая по връщаната стойност, вика getDeletionArchive
   * отделно, ако иска specific "профилът е изтрит" съобщение вместо generic 404.
   */
  sendAdminReply: (profileId: string, body: string, attachment?: NewSupportAttachmentInput | null) => SupportMessageSnapshot | null
  markReadByUser: (profileId: string) => void
  markReadByAdmin: (profileId: string) => void
  getUnreadCountForUser: (profileId: string) => number
  getTotalUnreadForAdmin: () => number
  getAllConversations: (
    getProfile: (profileId: string) => { displayName: string; avatarUrl: string | null } | null,
    filter?: 'active' | 'archived',
  ) => SupportConversationSnapshot[]
  /** Виж SupportDeletionArchiveSnapshot doc коментара — null = не е архивиран (нормален жив/непознат разговор). */
  getDeletionArchive: (profileId: string) => SupportDeletionArchiveSnapshot | null
  /**
   * Pre-check за "Изтрий профила по тази заявка" ПРИ SCHEDULING (round 3
   * корекция — deferred hard-delete на target в active game): валидира, че
   * messageId съществува, принадлежи на profileId, и е is_from_admin=0 —
   * СЪЩИТЕ три условия като profileHardDeleteService.hardDeleteProfile's
   * вътрешна transaction validation (mirror-нати тук нарочно, не reuse-вани
   * директно — разделени DB connections/модули, виж index.ts's handler).
   * Това е defense-in-depth pre-check при scheduling (по-добър UX — веднага
   * controlled 400, не 200 "pending", който по-късно тихо губи archive-а);
   * НЕ замества authoritative re-validation вътре в hardDeleteProfile при
   * terminal completion — съобщението теоретично може да стане невалидно
   * между scheduling и terminal completion (напр. race с друг admin action).
   */
  isValidUserRequestMessage: (profileId: string, messageId: string) => boolean
  getAttachmentForDownload: (
    viewerProfileId: string,
    isFullAdmin: boolean,
    storageFilename: string,
  ) => { storageFilename: string; contentType: string } | null
  listPendingAttachmentDeletions: (limit: number) => { eventSeq: number; storageFilename: string }[]
  markAttachmentDeletionDone: (eventSeq: number) => void
  markAttachmentDeletionFailed: (eventSeq: number) => void
  attachmentExistsForFilename: (storageFilename: string) => boolean
  purgeDoneAttachmentDeletions: (olderThanDays: number, batchSize: number) => number
  deleteConversation: (profileId: string) => void
  archiveConversation: (profileId: string) => void
  unarchiveConversation: (profileId: string) => void
  cleanupInactiveConversations: () => number
  countRecentMessages: (profileId: string, windowMinutes: number) => number
  hasAdminReply: (profileId: string) => boolean
  close: () => void
}

type SupportMessageRow = {
  message_id: string
  profile_id: string
  body: string
  is_from_admin: number
  created_at: string
  read_by_user: number
  read_by_admin: number
  attachment_filename: string | null
  attachment_width: number | null
  attachment_height: number | null
  attachment_byte_size: number | null
  attachment_content_type: string | null
}

function buildAttachmentUrls(storageFilename: string): { viewUrl: string; downloadUrl: string } {
  const base = `/api/support/attachments/${encodeURIComponent(storageFilename)}`
  return { viewUrl: base, downloadUrl: `${base}?download=1` }
}

function normalizeBody(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim()

  if (normalized.length > 2000) {
    return null
  }

  return normalized
}

export type SupportStoreDeps = {
  /**
   * Round 3 корекция — "запазване на evidence до terminal state": докато
   * target профилът има pending deferred hard delete (active game) С
   * explicit support-request атрибуция (pending_profile_moderation.
   * support_request_message_id НЕ е null), разговорът/съобщенията НЕ трябва
   * да могат да бъдат премахнати от cleanupInactiveConversations/
   * archiveConversation/deleteConversation — иначе evidence-ът може да
   * изчезне между scheduling момента и terminal completion, ПРЕДИ
   * canonical hardDeleteProfile да го е validate-нал и archive-нал.
   * Инжектирана функция (не direct import на pendingProfileModerationStore)
   * — DI mirror на ProfileHardDeleteFileCleanupDeps pattern-а, избягва
   * cross-store coupling между два отделни DatabaseSync connections.
   * НЕ блокира sendAdminReply — target профилът все още съществува/играе
   * по време на pending прозореца, нормален admin reply трябва да работи.
   */
  hasPendingSupportRequestDelete: (profileId: string) => boolean
}

export async function createSupportStore(databaseFilePath: string, deps: SupportStoreDeps): Promise<SupportStore> {
  const sqliteModule = await import('node:sqlite')
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  db.exec('PRAGMA journal_mode = WAL;')

  const selectMessagesStatement = db.prepare(`
    SELECT
      m.*,
      a.storage_filename AS attachment_filename,
      a.width AS attachment_width,
      a.height AS attachment_height,
      a.byte_size AS attachment_byte_size,
      a.content_type AS attachment_content_type
    FROM support_messages m
    LEFT JOIN support_message_attachments a ON a.message_id = m.message_id
    WHERE m.profile_id = ?
    ORDER BY m.created_at ASC
  `)

  const selectLatestMessageStatement = db.prepare(`
    SELECT
      m.*,
      a.storage_filename AS attachment_filename,
      a.width AS attachment_width,
      a.height AS attachment_height,
      a.byte_size AS attachment_byte_size,
      a.content_type AS attachment_content_type
    FROM support_messages m
    LEFT JOIN support_message_attachments a ON a.message_id = m.message_id
    WHERE m.profile_id = ?
    ORDER BY m.created_at DESC
    LIMIT 1
  `)

  const insertMessageStatement = db.prepare(`
    INSERT INTO support_messages (
      message_id,
      profile_id,
      body,
      is_from_admin,
      created_at,
      read_by_user,
      read_by_admin
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const insertAttachmentStatement = db.prepare(`
    INSERT INTO support_message_attachments (
      message_id,
      storage_filename,
      width,
      height,
      byte_size,
      content_type,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const insertAttachmentDeletionStatement = db.prepare(`
    INSERT INTO support_message_attachment_deletions (storage_filename)
    VALUES (?)
  `)

  const selectDeletionArchiveStatement = db.prepare(`
    SELECT
      profile_id, username_snapshot, display_name_snapshot,
      request_message_id, requested_at, deleted_at, deleted_by_profile_id, reason
    FROM support_deletion_archives
    WHERE profile_id = ?
    LIMIT 1
  `)

  const selectMessageForRequestValidationStatement = db.prepare(`
    SELECT profile_id, is_from_admin FROM support_messages
    WHERE message_id = ?
    LIMIT 1
  `)

  const selectAttachmentForDownloadStatement = db.prepare(`
    SELECT a.storage_filename, a.content_type
    FROM support_message_attachments a
    INNER JOIN support_messages m ON m.message_id = a.message_id
    WHERE a.storage_filename = ?
      AND (? = 1 OR m.profile_id = ?)
    LIMIT 1
  `)

  const selectPendingAttachmentDeletionsStatement = db.prepare(`
    SELECT event_seq, storage_filename
    FROM support_message_attachment_deletions
    WHERE cleanup_status IN ('pending', 'failed')
    ORDER BY event_seq ASC
    LIMIT ?
  `)

  const markAttachmentDeletionStatusStatement = db.prepare(`
    UPDATE support_message_attachment_deletions
    SET cleanup_status = ?
    WHERE event_seq = ?
  `)

  const selectAttachmentExistsStatement = db.prepare(`
    SELECT 1
    FROM support_message_attachments
    WHERE storage_filename = ?
    LIMIT 1
  `)

  function runInTransaction<T>(callback: () => T): T {
    db.exec('BEGIN IMMEDIATE;')
    try {
      const result = callback()
      db.exec('COMMIT;')
      return result
    } catch (error) {
      db.exec('ROLLBACK;')
      throw error
    }
  }

  type SupportDeletionArchiveRow = {
    profile_id: string
    username_snapshot: string
    display_name_snapshot: string
    request_message_id: string
    requested_at: string
    deleted_at: string
    deleted_by_profile_id: string | null
    reason: string
  }

  function getDeletionArchive(profileId: string): SupportDeletionArchiveSnapshot | null {
    const row = selectDeletionArchiveStatement.get(profileId) as SupportDeletionArchiveRow | undefined
    if (!row) return null

    return {
      profileId: row.profile_id,
      usernameSnapshot: row.username_snapshot,
      displayNameSnapshot: row.display_name_snapshot,
      requestMessageId: row.request_message_id,
      requestedAt: dbDateToUtc(row.requested_at),
      deletedAt: dbDateToUtc(row.deleted_at),
      deletedByProfileId: row.deleted_by_profile_id,
      reason: row.reason,
    }
  }

  function isValidUserRequestMessage(profileId: string, messageId: string): boolean {
    const row = selectMessageForRequestValidationStatement.get(messageId) as
      | { profile_id: string; is_from_admin: number }
      | undefined
    return row !== undefined && row.profile_id === profileId && row.is_from_admin === 0
  }

  function rowToSnapshot(row: SupportMessageRow): SupportMessageSnapshot {
    const attachment = row.attachment_filename !== null
      && row.attachment_width !== null
      && row.attachment_height !== null
      && row.attachment_byte_size !== null
      ? {
          attachmentId: row.attachment_filename,
          width: row.attachment_width,
          height: row.attachment_height,
          byteSize: row.attachment_byte_size,
          ...buildAttachmentUrls(row.attachment_filename),
        }
      : null

    return {
      messageId: row.message_id,
      profileId: row.profile_id,
      body: row.body,
      isFromAdmin: row.is_from_admin === 1,
      createdAt: dbDateToUtc(row.created_at),
      attachment,
    }
  }

  function insertMessage(
    profileId: string,
    body: string,
    isFromAdmin: boolean,
    attachment: NewSupportAttachmentInput | null,
  ): SupportMessageSnapshot {
    const messageId = randomUUID()
    const now = new Date().toISOString()

    insertMessageStatement.run(
      messageId,
      profileId,
      body,
      isFromAdmin ? 1 : 0,
      now,
      isFromAdmin ? 0 : 1,
      isFromAdmin ? 1 : 0,
    )

    if (attachment !== null) {
      insertAttachmentStatement.run(
        messageId,
        attachment.storageFilename,
        attachment.width,
        attachment.height,
        attachment.byteSize,
        attachment.contentType,
        now,
      )
    }

    return {
      messageId,
      profileId,
      body,
      isFromAdmin,
      createdAt: now,
      attachment: attachment === null
        ? null
        : {
            attachmentId: attachment.storageFilename,
            width: attachment.width,
            height: attachment.height,
            byteSize: attachment.byteSize,
            ...buildAttachmentUrls(attachment.storageFilename),
          },
    }
  }

  function enqueueAttachmentsForProfile(profileId: string): void {
    const rows = db.prepare(`
      SELECT a.storage_filename
      FROM support_message_attachments a
      INNER JOIN support_messages m ON m.message_id = a.message_id
      WHERE m.profile_id = ?
    `).all(profileId) as { storage_filename: string }[]

    for (const row of rows) {
      insertAttachmentDeletionStatement.run(row.storage_filename)
    }
  }

  function getMessages(profileId: string): SupportMessageSnapshot[] {
    const rows = selectMessagesStatement.all(profileId) as SupportMessageRow[]
    return rows.map(rowToSnapshot)
  }

  function sendUserMessage(
    profileId: string,
    body: string,
    attachment: NewSupportAttachmentInput | null = null,
  ): SupportMessageSnapshot {
    const normalized = normalizeBody(body)

    if (normalized === null || (normalized.length === 0 && attachment === null)) {
      throw new Error('Invalid support message')
    }

    return runInTransaction(() => {
      const message = insertMessage(profileId, normalized, false, attachment)
      db.prepare(`DELETE FROM support_archived WHERE profile_id = ?`).run(profileId)
      return message
    })
  }

  function sendAdminReply(
    profileId: string,
    body: string,
    attachment: NewSupportAttachmentInput | null = null,
  ): SupportMessageSnapshot | null {
    const normalized = normalizeBody(body)

    if (normalized === null || (normalized.length === 0 && attachment === null)) {
      throw new Error('Invalid support message')
    }

    const exists = db.prepare(
      `SELECT 1 FROM support_messages WHERE profile_id = ? LIMIT 1`,
    ).get(profileId)
    if (!exists) return null

    // spec §C: архивиран разговор (hard-deleted профил) е read-only — не
    // позволявай нови admin съобщения в мъртъв разговор.
    if (getDeletionArchive(profileId) !== null) return null

    return runInTransaction(() => insertMessage(profileId, normalized, true, attachment))
  }

  function markReadByUser(profileId: string): void {
    db.prepare(
      `UPDATE support_messages SET read_by_user = 1
       WHERE profile_id = ? AND is_from_admin = 1 AND read_by_user = 0`,
    ).run(profileId)
  }

  function markReadByAdmin(profileId: string): void {
    db.prepare(
      `UPDATE support_messages SET read_by_admin = 1
       WHERE profile_id = ? AND is_from_admin = 0 AND read_by_admin = 0`,
    ).run(profileId)
  }

  function getUnreadCountForUser(profileId: string): number {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM support_messages
       WHERE profile_id = ? AND is_from_admin = 1 AND read_by_user = 0`,
    ).get(profileId) as { cnt: number }
    return row?.cnt ?? 0
  }

  // Global badge (support/mail icon) — трябва да брои ЕДИНСТВЕНО actionable
  // ACTIVE разговори, mirror на getAllConversations(filter:'active')-ата
  // three-way класификация по-долу (round 6 "Неизвестен" fix-а), НЕ просто
  // сурово COUNT(*) от support_messages. Преди този fix (production ghost
  // badge bug): заявката не проверяваше profiles съществуване нито
  // support_archived/support_deletion_archives markers — standard hard
  // delete (БЕЗ supportRequestMessageId) никога не пипа support_messages
  // (виж profileHardDeleteService.ts doc коментара), затова unread ред на
  // изтрит профил оставаше orphaned И продължаваше да се брои завинаги,
  // въпреки че getAllConversations вече правилно го skip-ва изцяло (нито
  // Active, нито Archived) — conversation-ът изчезва от UI-я, badge-ът не.
  //
  // Три категории се ИЗКЛЮЧВАТ тук, идентично с filter='active' bucket-а:
  //  - normal archived (support_archived marker) — потребителят/admin-ът
  //    съзнателно го е скрил от inbox-а, не е actionable.
  //  - deletion evidence (support_deletion_archives marker) — read-only
  //    история на вече изтрит профил, живее ЕДИНСТВЕНО в Archived tab-а,
  //    никога не е "текущ активен разговор" (spec §B.4).
  //  - orphaned (нито profiles ред, нито deletion evidence) — hard-deleted
  //    през standard flow, невидим навсякъде в UI, следователно не може да
  //    бъде "actionable" по дефиниция (spec §B.3).
  // INNER JOIN profiles p елиминира последната категория директно (LEFT JOIN
  // + IS NULL филтър би работил еднакво добре, INNER е по-директен тук
  // защото не ни трябва нито едно поле от p — само existence check).
  function getTotalUnreadForAdmin(): number {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt
       FROM support_messages m
       INNER JOIN profiles p ON p.profile_id = m.profile_id
       LEFT JOIN support_archived a ON a.profile_id = m.profile_id
       LEFT JOIN support_deletion_archives sda ON sda.profile_id = m.profile_id
       WHERE m.is_from_admin = 0
         AND m.read_by_admin = 0
         AND a.profile_id IS NULL
         AND sda.profile_id IS NULL`,
    ).get() as { cnt: number }
    return row?.cnt ?? 0
  }

  /**
   * filter='active' (default) — нормалният inbox: РЕАЛНИ, текущи, non-archived
   * И non-deletion-evidence разговори. filter='archived' — "Архивирани" tab:
   * ИЛИ normal support_archived marker, ИЛИ deletion evidence
   * (support_deletion_archives) — второто ВИНАГИ, независимо дали leftover
   * support_archived marker технически съществува от преди hard delete-а
   * (напр. "Маркирай като заявка за изтриване", изпълнено от вътре в вече
   * normal-archived разговор — hardDeleteProfile не чисти support_archived,
   * различен marker; и обратно — target е бил Active в момента на delete-а,
   * никога не е имал support_archived ред). UX семантика (round 5
   * корекция): deletion evidence на вече изтрит профил НЕ Е "текущ активен
   * разговор" — трябва да е reachable ЕДИНСТВЕНО през Archived, визуално
   * разграничен от normal archive чрез deletionArchive полето/UI banner-а
   * (spec §2 "не смесвай... без ясно визуално разграничение").
   *
   * ВТОРО ниво на филтриране (round 6 корекция — "Неизвестен" bug):
   * archivedCondition-ът горе решава САМО active/archived bucket-а по
   * marker присъствие. Отделно, ВЪТРЕ в цикъла по-долу, всеки ред се
   * проверява дали profiles реда му все още съществува ИЛИ има
   * deletion-evidence — orphaned редове (нито едното) се skip-ват изцяло,
   * независимо в кой bucket биха попаднали по markers. Виж коментара
   * непосредствено преди push-а в цикъла за пълната three-way логика.
   */
  function getAllConversations(
    getProfile: (profileId: string) => { displayName: string; avatarUrl: string | null } | null,
    filter: 'active' | 'archived' = 'active',
  ): SupportConversationSnapshot[] {
    const archivedCondition = filter === 'archived'
      ? 'a.profile_id IS NOT NULL OR sda.profile_id IS NOT NULL'
      : 'a.profile_id IS NULL AND sda.profile_id IS NULL'
    const rows = db.prepare(
      `SELECT
         m.profile_id,
         MAX(m.created_at) as updated_at,
         SUM(CASE WHEN m.is_from_admin = 0 AND m.read_by_admin = 0 THEN 1 ELSE 0 END) as unread_by_admin
       FROM support_messages m
       LEFT JOIN support_archived a ON a.profile_id = m.profile_id
       LEFT JOIN support_deletion_archives sda ON sda.profile_id = m.profile_id
       WHERE ${archivedCondition}
       GROUP BY m.profile_id
       ORDER BY updated_at DESC`,
    ).all() as { profile_id: string; updated_at: string; unread_by_admin: number }[]

    const result: SupportConversationSnapshot[] = []

    for (const row of rows) {
      const lastRow = selectLatestMessageStatement.get(row.profile_id) as SupportMessageRow | undefined
      if (!lastRow) continue

      const deletionArchive = getDeletionArchive(row.profile_id)
      const profile = getProfile(row.profile_id)

      // Round 6 корекция (production bug — "Неизвестен" разговори в
      // Archived): преди тази проверка support_messages/support_archived
      // orphan редове (profiles вече не съществува, hard-deleted през
      // normal flow БЕЗ supportRequestMessageId — hardDeleteProfile никога
      // не е пипал тези таблици, виж doc коментара там) изтичаха в UI-я с
      // displayName='Неизвестен', защото getAllConversations никога не
      // проверяваше дали profiles редът реално съществува. Точна семантика:
      //   - deletionArchive !== null → легитимен evidence случай, ПОКАЖИ
      //     винаги (target профилът е ОЧАКВАНО изтрит — това Е точката),
      //     display name от snapshot-а, не от live profile lookup.
      //   - profile !== null → живо/normal-archived, но профилът все още
      //     съществува — ПОКАЖИ с живото име.
      //   - profile === null И deletionArchive === null → orphaned стар
      //     разговор от профил, изтрит ПРЕДИ evidence feature-а (или през
      //     normal hard-delete flow без user-request атрибуция) — SKIP
      //     изцяло, нито Active, нито Archived. Не се трие нищо тук
      //     (spec §3 "не destructive cleanup в този round").
      if (deletionArchive === null && profile === null) continue

      const lastMessageText = lastRow.body.trim()
      result.push({
        profileId: row.profile_id,
        // spec §C/§F: за архивиран разговор (hard-deleted профил) profiles
        // редът вече не съществува — показваме snapshot-натото име вместо
        // generic "Неизвестен" (mirror на renderAdCampaignManagementPanel.ts's
        // "(изтрит профил)" convention). "Неизвестен" вече не бива да се
        // достига тук изобщо (guard-ът по-горе skip-ва точно този случай),
        // остава само като defensive fallback.
        displayName: deletionArchive?.displayNameSnapshot ?? profile?.displayName ?? 'Неизвестен',
        avatarUrl: profile?.avatarUrl ?? null,
        lastMessageBody: lastMessageText.length > 0 ? lastMessageText : '[Снимка]',
        lastMessageIsFromAdmin: lastRow.is_from_admin === 1,
        unreadByAdmin: row.unread_by_admin,
        updatedAt: dbDateToUtc(row.updated_at),
        deletionArchive,
      })
    }

    return result
  }

  function getAttachmentForDownload(
    viewerProfileId: string,
    isFullAdmin: boolean,
    storageFilename: string,
  ): { storageFilename: string; contentType: string } | null {
    const row = selectAttachmentForDownloadStatement.get(
      storageFilename,
      isFullAdmin ? 1 : 0,
      viewerProfileId,
    ) as { storage_filename: string; content_type: string } | undefined

    return row === undefined
      ? null
      : { storageFilename: row.storage_filename, contentType: row.content_type }
  }

  function listPendingAttachmentDeletions(limit: number): { eventSeq: number; storageFilename: string }[] {
    const rows = selectPendingAttachmentDeletionsStatement.all(limit) as {
      event_seq: number
      storage_filename: string
    }[]

    return rows.map((row) => ({ eventSeq: row.event_seq, storageFilename: row.storage_filename }))
  }

  function markAttachmentDeletionDone(eventSeq: number): void {
    markAttachmentDeletionStatusStatement.run('done', eventSeq)
  }

  function markAttachmentDeletionFailed(eventSeq: number): void {
    markAttachmentDeletionStatusStatement.run('failed', eventSeq)
  }

  function attachmentExistsForFilename(storageFilename: string): boolean {
    return selectAttachmentExistsStatement.get(storageFilename) !== undefined
  }

  function purgeDoneAttachmentDeletions(olderThanDays: number, batchSize: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    let totalDeleted = 0

    while (totalDeleted < batchSize) {
      const remaining = batchSize - totalDeleted
      const result = db.prepare(`
        DELETE FROM support_message_attachment_deletions
        WHERE event_seq IN (
          SELECT event_seq FROM support_message_attachment_deletions
          WHERE cleanup_status = 'done' AND created_at < ?
          ORDER BY event_seq ASC
          LIMIT ?
        )
      `).run(cutoff, remaining)

      const deleted = result.changes as number
      totalDeleted += deleted

      if (deleted === 0) {
        break
      }
    }

    return totalDeleted
  }

  function deleteConversation(profileId: string): void {
    // spec §C: архивиран разговор (hard-deleted профил) е immutable evidence
    // — нито обикновеният "user/admin трие разговора си" path бива да го
    // изтрие тук (no-op, вместо тихо да провали архивирането).
    if (getDeletionArchive(profileId) !== null) return
    // Round 3 корекция — pending support-request delete (target в active
    // game, delete отложен до terminal completion): evidence-ът трябва да
    // преживее и ТОЗИ прозорец, не само след като archive редът вече
    // съществува (виж SupportStoreDeps.hasPendingSupportRequestDelete doc
    // коментара).
    if (deps.hasPendingSupportRequestDelete(profileId)) return

    runInTransaction(() => {
      enqueueAttachmentsForProfile(profileId)
      db.prepare(`DELETE FROM support_messages WHERE profile_id = ?`).run(profileId)
      db.prepare(`DELETE FROM support_archived WHERE profile_id = ?`).run(profileId)
    })
  }

  /**
   * "Архивирай" — NON-DESTRUCTIVE от round 4 корекцията насам (root cause
   * fix: разговорът беше физически изтрит тук — DELETE FROM support_messages
   * — веднага щом admin натиснеше "Архивирай", което правеше "виж
   * архивирани разговори" невъзможно на практика). Вече само маркира
   * profile_id в support_archived — support_messages/attachments остават
   * непокътнати, четими през getMessages()/getAllConversations(filter:
   * 'archived'). sendUserMessage() автоматично маха marker-а при ново user
   * съобщение (виж doc коментара там) — "Архивирай" е "скрий от Active,
   * докато потребителят пак не пише", НЕ "изтрий".
   *
   * Deletion evidence archive (support_deletion_archives) е РАЗЛИЧЕН marker
   * — "Архивирай" не бива да го замества/пипа (guard-ът остава).
   */
  function archiveConversation(profileId: string): void {
    if (getDeletionArchive(profileId) !== null) return
    // Round 3 корекция — виж deleteConversation-ия same коментар по-горе.
    if (deps.hasPendingSupportRequestDelete(profileId)) return

    db.prepare(`INSERT OR IGNORE INTO support_archived (profile_id) VALUES (?)`).run(profileId)
  }

  /**
   * "Върни в активни" — маха ЕДИНСТВЕНО normal archive marker-а
   * (support_archived), не пипа съобщения. НИКОГА не работи върху deletion
   * evidence archive (target профилът вече не съществува физически — "върни
   * в активни" няма смисъл и не бива да е достъпно за такъв разговор; guard-ът
   * тук е defense-in-depth — UI вече не показва копчето за такива разговори).
   */
  function unarchiveConversation(profileId: string): void {
    if (getDeletionArchive(profileId) !== null) return
    db.prepare(`DELETE FROM support_archived WHERE profile_id = ?`).run(profileId)
  }

  function hasAdminReply(profileId: string): boolean {
    const row = db.prepare(
      `SELECT 1 FROM support_messages WHERE profile_id = ? AND is_from_admin = 1 LIMIT 1`,
    ).get(profileId)
    return row !== undefined
  }

  function countRecentMessages(profileId: string, windowMinutes: number): number {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM support_messages
       WHERE profile_id = ? AND is_from_admin = 0
         AND created_at > datetime('now', ? || ' minutes')`,
    ).get(profileId, `-${windowMinutes}`) as { cnt: number }
    return row?.cnt ?? 0
  }

  function cleanupInactiveConversations(): number {
    return runInTransaction(() => {
      // spec §A/§C: архивиран разговор (hard-deleted профил, виж
      // support_deletion_archives) НЕ трябва да бъде изчистван от този
      // background job — evidence-ът за заявеното/изпълненото изтриване
      // трябва да остане четим за admin/Pika Team за постоянно, не само до
      // следващия 5-дневен inactivity cleanup цикъл.
      //
      // Root cause corollary (round 4 корекция): "Архивирай" вече НЕ трие
      // съобщенията веднага (виж archiveConversation-ия doc коментар) —
      // ако този background job не изключеше support_archived разговори
      // тук, същите съобщения пак биха се изтрили автоматично до 5 дни
      // по-късно (последното съобщение в архивиран разговор е почти винаги
      // от admin), тихо анулирайки non-destructive archive гаранцията.
      const rows = db.prepare(`
        SELECT m.profile_id
        FROM support_messages m
        INNER JOIN (
          SELECT profile_id, MAX(created_at) AS last_at
          FROM support_messages
          GROUP BY profile_id
        ) latest ON latest.profile_id = m.profile_id AND latest.last_at = m.created_at
        LEFT JOIN support_deletion_archives sda ON sda.profile_id = m.profile_id
        LEFT JOIN support_archived sa ON sa.profile_id = m.profile_id
        WHERE m.is_from_admin = 1
          AND m.created_at < datetime('now', '-5 days')
          AND sda.profile_id IS NULL
          AND sa.profile_id IS NULL
      `).all() as { profile_id: string }[]

      // Round 3 корекция — виж SupportStoreDeps.hasPendingSupportRequestDelete
      // doc коментара: target профил с pending deferred hard delete (active
      // game) И explicit support-request атрибуция не бива да загуби
      // evidence-а тук, преди terminal completion да го archive-не.
      const profileIds = [...new Set(rows.map((row) => row.profile_id))]
        .filter((profileId) => !deps.hasPendingSupportRequestDelete(profileId))

      if (profileIds.length === 0) {
        return 0
      }

      for (const profileId of profileIds) {
        enqueueAttachmentsForProfile(profileId)
      }

      const placeholders = profileIds.map(() => '?').join(', ')
      const result = db.prepare(`
        DELETE FROM support_messages
        WHERE profile_id IN (${placeholders})
      `).run(...profileIds)

      return result.changes as number
    })
  }

  function close(): void {
    db.close()
  }

  return {
    getMessages,
    sendUserMessage,
    sendAdminReply,
    markReadByUser,
    markReadByAdmin,
    getUnreadCountForUser,
    getTotalUnreadForAdmin,
    getAllConversations,
    getDeletionArchive,
    isValidUserRequestMessage,
    getAttachmentForDownload,
    listPendingAttachmentDeletions,
    markAttachmentDeletionDone,
    markAttachmentDeletionFailed,
    attachmentExistsForFilename,
    purgeDoneAttachmentDeletions,
    deleteConversation,
    archiveConversation,
    unarchiveConversation,
    cleanupInactiveConversations,
    hasAdminReply,
    countRecentMessages,
    close,
  }
}
