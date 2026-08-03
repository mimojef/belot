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
}

export type SupportStore = {
  getMessages: (profileId: string) => SupportMessageSnapshot[]
  sendUserMessage: (profileId: string, body: string, attachment?: NewSupportAttachmentInput | null) => SupportMessageSnapshot
  sendAdminReply: (profileId: string, body: string, attachment?: NewSupportAttachmentInput | null) => SupportMessageSnapshot | null
  markReadByUser: (profileId: string) => void
  markReadByAdmin: (profileId: string) => void
  getUnreadCountForUser: (profileId: string) => number
  getTotalUnreadForAdmin: () => number
  getAllConversations: (
    getProfile: (profileId: string) => { displayName: string; avatarUrl: string | null } | null
  ) => SupportConversationSnapshot[]
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

export async function createSupportStore(databaseFilePath: string): Promise<SupportStore> {
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

  function getTotalUnreadForAdmin(): number {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM support_messages
       WHERE is_from_admin = 0 AND read_by_admin = 0`,
    ).get() as { cnt: number }
    return row?.cnt ?? 0
  }

  function getAllConversations(
    getProfile: (profileId: string) => { displayName: string; avatarUrl: string | null } | null,
  ): SupportConversationSnapshot[] {
    const rows = db.prepare(
      `SELECT
         m.profile_id,
         MAX(m.created_at) as updated_at,
         SUM(CASE WHEN m.is_from_admin = 0 AND m.read_by_admin = 0 THEN 1 ELSE 0 END) as unread_by_admin
       FROM support_messages m
       LEFT JOIN support_archived a ON a.profile_id = m.profile_id
       WHERE a.profile_id IS NULL
       GROUP BY m.profile_id
       ORDER BY updated_at DESC`,
    ).all() as { profile_id: string; updated_at: string; unread_by_admin: number }[]

    const result: SupportConversationSnapshot[] = []

    for (const row of rows) {
      const lastRow = selectLatestMessageStatement.get(row.profile_id) as SupportMessageRow | undefined
      if (!lastRow) continue

      const profile = getProfile(row.profile_id)
      const lastMessageText = lastRow.body.trim()
      result.push({
        profileId: row.profile_id,
        displayName: profile?.displayName ?? 'Неизвестен',
        avatarUrl: profile?.avatarUrl ?? null,
        lastMessageBody: lastMessageText.length > 0 ? lastMessageText : '[Снимка]',
        lastMessageIsFromAdmin: lastRow.is_from_admin === 1,
        unreadByAdmin: row.unread_by_admin,
        updatedAt: dbDateToUtc(row.updated_at),
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
    runInTransaction(() => {
      enqueueAttachmentsForProfile(profileId)
      db.prepare(`DELETE FROM support_messages WHERE profile_id = ?`).run(profileId)
      db.prepare(`DELETE FROM support_archived WHERE profile_id = ?`).run(profileId)
    })
  }

  function archiveConversation(profileId: string): void {
    runInTransaction(() => {
      enqueueAttachmentsForProfile(profileId)
      db.prepare(`DELETE FROM support_messages WHERE profile_id = ?`).run(profileId)
      db.prepare(`INSERT OR IGNORE INTO support_archived (profile_id) VALUES (?)`).run(profileId)
    })
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
      const rows = db.prepare(`
        SELECT m.profile_id
        FROM support_messages m
        INNER JOIN (
          SELECT profile_id, MAX(created_at) AS last_at
          FROM support_messages
          GROUP BY profile_id
        ) latest ON latest.profile_id = m.profile_id AND latest.last_at = m.created_at
        WHERE m.is_from_admin = 1
          AND m.created_at < datetime('now', '-5 days')
      `).all() as { profile_id: string }[]

      const profileIds = [...new Set(rows.map((row) => row.profile_id))]

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
    getAttachmentForDownload,
    listPendingAttachmentDeletions,
    markAttachmentDeletionDone,
    markAttachmentDeletionFailed,
    attachmentExistsForFilename,
    purgeDoneAttachmentDeletions,
    deleteConversation,
    archiveConversation,
    cleanupInactiveConversations,
    hasAdminReply,
    countRecentMessages,
    close,
  }
}
