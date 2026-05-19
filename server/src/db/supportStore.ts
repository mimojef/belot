import { randomUUID } from 'node:crypto'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type SupportMessageSnapshot = {
  messageId: string
  profileId: string
  body: string
  isFromAdmin: boolean
  createdAt: string
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
  sendUserMessage: (profileId: string, body: string) => SupportMessageSnapshot
  sendAdminReply: (profileId: string, body: string) => SupportMessageSnapshot | null
  markReadByUser: (profileId: string) => void
  markReadByAdmin: (profileId: string) => void
  getUnreadCountForUser: (profileId: string) => number
  getTotalUnreadForAdmin: () => number
  getAllConversations: (
    getProfile: (profileId: string) => { displayName: string; avatarUrl: string | null } | null
  ) => SupportConversationSnapshot[]
  deleteConversation: (profileId: string) => void
  archiveConversation: (profileId: string) => void
  cleanupInactiveConversations: () => number
  countRecentMessages: (profileId: string, windowMinutes: number) => number
  hasAdminReply: (profileId: string) => boolean
}

type SupportMessageRow = {
  message_id: string
  profile_id: string
  body: string
  is_from_admin: number
  created_at: string
  read_by_user: number
  read_by_admin: number
}

export async function createSupportStore(databaseFilePath: string): Promise<SupportStore> {
  const sqliteModule = await import('node:sqlite')
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  db.exec('PRAGMA journal_mode = WAL;')

  function rowToSnapshot(row: SupportMessageRow): SupportMessageSnapshot {
    return {
      messageId: row.message_id,
      profileId: row.profile_id,
      body: row.body,
      isFromAdmin: row.is_from_admin === 1,
      createdAt: row.created_at,
    }
  }

  function getMessages(profileId: string): SupportMessageSnapshot[] {
    const rows = db.prepare(
      `SELECT * FROM support_messages WHERE profile_id = ? ORDER BY created_at ASC`,
    ).all(profileId) as SupportMessageRow[]
    return rows.map(rowToSnapshot)
  }

  function sendUserMessage(profileId: string, body: string): SupportMessageSnapshot {
    const messageId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO support_messages (message_id, profile_id, body, is_from_admin, created_at, read_by_user, read_by_admin)
       VALUES (?, ?, ?, 0, ?, 1, 0)`,
    ).run(messageId, profileId, body, now)
    db.prepare(`DELETE FROM support_archived WHERE profile_id = ?`).run(profileId)
    return { messageId, profileId, body, isFromAdmin: false, createdAt: now }
  }

  function sendAdminReply(profileId: string, body: string): SupportMessageSnapshot | null {
    const exists = db.prepare(
      `SELECT 1 FROM support_messages WHERE profile_id = ? LIMIT 1`,
    ).get(profileId)
    if (!exists) return null

    const messageId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO support_messages (message_id, profile_id, body, is_from_admin, created_at, read_by_user, read_by_admin)
       VALUES (?, ?, ?, 1, ?, 0, 1)`,
    ).run(messageId, profileId, body, now)
    return { messageId, profileId, body, isFromAdmin: true, createdAt: now }
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
      const lastRow = db.prepare(
        `SELECT * FROM support_messages WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(row.profile_id) as SupportMessageRow | undefined
      if (!lastRow) continue

      const profile = getProfile(row.profile_id)
      result.push({
        profileId: row.profile_id,
        displayName: profile?.displayName ?? 'Неизвестен',
        avatarUrl: profile?.avatarUrl ?? null,
        lastMessageBody: lastRow.body,
        lastMessageIsFromAdmin: lastRow.is_from_admin === 1,
        unreadByAdmin: row.unread_by_admin,
        updatedAt: row.updated_at,
      })
    }

    return result
  }

  function deleteConversation(profileId: string): void {
    db.prepare(`DELETE FROM support_messages WHERE profile_id = ?`).run(profileId)
    db.prepare(`DELETE FROM support_archived WHERE profile_id = ?`).run(profileId)
  }

  function archiveConversation(profileId: string): void {
    db.prepare(`DELETE FROM support_messages WHERE profile_id = ?`).run(profileId)
    db.prepare(`INSERT OR IGNORE INTO support_archived (profile_id) VALUES (?)`).run(profileId)
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
    // Delete conversations where last message is from admin and older than 5 days
    const result = db.prepare(`
      DELETE FROM support_messages
      WHERE profile_id IN (
        SELECT m.profile_id
        FROM support_messages m
        INNER JOIN (
          SELECT profile_id, MAX(created_at) AS last_at
          FROM support_messages
          GROUP BY profile_id
        ) latest ON latest.profile_id = m.profile_id AND latest.last_at = m.created_at
        WHERE m.is_from_admin = 1
          AND m.created_at < datetime('now', '-5 days')
      )
    `).run()
    return result.changes as number
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
    deleteConversation,
    archiveConversation,
    cleanupInactiveConversations,
    hasAdminReply,
    countRecentMessages,
  }
}
