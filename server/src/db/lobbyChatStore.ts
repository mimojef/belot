import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type LobbyChatMessageSnapshot = {
  seq: number
  messageId: string
  senderProfileId: string
  senderDisplayName: string
  body: string
  createdAt: string
  deletedAt: string | null
}

export type LobbyChatDeletionEvent = {
  eventSeq: number
  messageId: string
}

export type LobbyChatStore = {
  insertMessage: (input: {
    senderProfileId: string
    senderDisplayName: string
    body: string
  }) => LobbyChatMessageSnapshot
  listRecentMessages: (
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ) => LobbyChatMessageSnapshot[]
  deleteMessage: (input: {
    messageId: string
    actorAccountId: string | null
  }) =>
    | { ok: true; senderProfileId: string }
    | { ok: false; code: 'not_found' | 'already_deleted' }
  getMaxSeq: () => number
  getMaxDeletionEventSeq: () => number
  pollNewMessages: (afterSeq: number, limit: number) => LobbyChatMessageSnapshot[]
  pollDeletionEvents: (afterEventSeq: number, limit: number) => LobbyChatDeletionEvent[]
  purgeOlderThanDays: (
    days: number,
    batchSize: number,
  ) => { deletedMessages: number; deletedDeletionEvents: number }
  close: () => void
}

type LobbyChatMessageRow = {
  seq: number
  message_id: string
  sender_profile_id: string
  sender_display_name: string
  body: string
  created_at: string
  deleted_at: string | null
}

function toSnapshot(row: LobbyChatMessageRow): LobbyChatMessageSnapshot {
  return {
    seq: row.seq,
    messageId: row.message_id,
    senderProfileId: row.sender_profile_id,
    senderDisplayName: row.sender_display_name,
    body: row.body,
    createdAt: dbDateToUtc(row.created_at),
    deletedAt: row.deleted_at ? dbDateToUtc(row.deleted_at) : null,
  }
}

function getChanges(result: { changes: number | bigint }): number {
  return Number(result.changes)
}

export async function createLobbyChatStore(
  databaseFilePath: string,
): Promise<LobbyChatStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const insertMessageStatement = database.prepare(`
    INSERT INTO lobby_chat_messages (
      message_id, sender_profile_id, sender_display_name, body
    ) VALUES (?, ?, ?, ?);
  `)

  const selectByMessageIdStatement = database.prepare(`
    SELECT seq, message_id, sender_profile_id, sender_display_name, body, created_at, deleted_at
    FROM lobby_chat_messages
    WHERE message_id = ?
    LIMIT 1;
  `)

  const deleteMessageStatement = database.prepare(`
    UPDATE lobby_chat_messages
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now'), deleted_by_profile_id = ?
    WHERE message_id = ? AND deleted_at IS NULL;
  `)

  const insertDeletionEventStatement = database.prepare(`
    INSERT INTO lobby_chat_deletion_events (message_id) VALUES (?);
  `)

  const insertDeletionAuditStatement = database.prepare(`
    INSERT INTO lobby_chat_deletion_audit_log (
      log_id, actor_account_id, message_id, sender_profile_id
    ) VALUES (?, ?, ?, ?);
  `)

  const selectMaxSeqStatement = database.prepare(`
    SELECT COALESCE(MAX(seq), 0) as maxSeq FROM lobby_chat_messages;
  `)

  const selectMaxDeletionEventSeqStatement = database.prepare(`
    SELECT COALESCE(MAX(event_seq), 0) as maxSeq FROM lobby_chat_deletion_events;
  `)

  const selectNewMessagesStatement = database.prepare(`
    SELECT seq, message_id, sender_profile_id, sender_display_name, body, created_at, deleted_at
    FROM lobby_chat_messages
    WHERE seq > ?
    ORDER BY seq ASC
    LIMIT ?;
  `)

  const selectDeletionEventsStatement = database.prepare(`
    SELECT event_seq, message_id
    FROM lobby_chat_deletion_events
    WHERE event_seq > ?
    ORDER BY event_seq ASC
    LIMIT ?;
  `)

  function buildRecentMessagesStatement(excludedCount: number) {
    const exclusionClause = excludedCount > 0
      ? `AND sender_profile_id NOT IN (${Array(excludedCount).fill('?').join(',')})`
      : ''
    return database.prepare(`
      SELECT seq, message_id, sender_profile_id, sender_display_name, body, created_at, deleted_at
      FROM lobby_chat_messages
      WHERE deleted_at IS NULL
      ${exclusionClause}
      ORDER BY seq DESC
      LIMIT ?;
    `)
  }

  const purgeMessagesBatchStatement = database.prepare(`
    DELETE FROM lobby_chat_messages
    WHERE seq IN (
      SELECT seq FROM lobby_chat_messages
      WHERE created_at < ?
      ORDER BY seq ASC
      LIMIT ?
    );
  `)

  const purgeDeletionEventsBatchStatement = database.prepare(`
    DELETE FROM lobby_chat_deletion_events
    WHERE event_seq IN (
      SELECT event_seq FROM lobby_chat_deletion_events
      WHERE created_at < ?
      ORDER BY event_seq ASC
      LIMIT ?
    );
  `)

  function insertMessage(input: {
    senderProfileId: string
    senderDisplayName: string
    body: string
  }): LobbyChatMessageSnapshot {
    const messageId = randomUUID()
    insertMessageStatement.run(
      messageId,
      input.senderProfileId,
      input.senderDisplayName,
      input.body,
    )
    const row = selectByMessageIdStatement.get(messageId) as LobbyChatMessageRow
    return toSnapshot(row)
  }

  function listRecentMessages(
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ): LobbyChatMessageSnapshot[] {
    const statement = buildRecentMessagesStatement(excludedSenderProfileIds.length)
    const rows = (
      excludedSenderProfileIds.length > 0
        ? statement.all(...excludedSenderProfileIds, limit)
        : statement.all(limit)
    ) as LobbyChatMessageRow[]

    return rows.map(toSnapshot).reverse()
  }

  function deleteMessage(input: {
    messageId: string
    actorAccountId: string | null
  }):
    | { ok: true; senderProfileId: string }
    | { ok: false; code: 'not_found' | 'already_deleted' } {
    const existing = selectByMessageIdStatement.get(input.messageId) as
      | LobbyChatMessageRow
      | undefined

    if (existing === undefined) {
      return { ok: false, code: 'not_found' }
    }

    if (existing.deleted_at !== null) {
      return { ok: false, code: 'already_deleted' }
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      const changes = getChanges(
        deleteMessageStatement.run(existing.sender_profile_id, input.messageId),
      )

      if (changes === 0) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'already_deleted' }
      }

      insertDeletionEventStatement.run(input.messageId)
      insertDeletionAuditStatement.run(
        randomUUID(),
        input.actorAccountId,
        input.messageId,
        existing.sender_profile_id,
      )
      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // ignore rollback failure, surface the original error below
      }
      throw error
    }

    return { ok: true, senderProfileId: existing.sender_profile_id }
  }

  function getMaxSeq(): number {
    const row = selectMaxSeqStatement.get() as { maxSeq: number }
    return row.maxSeq
  }

  function getMaxDeletionEventSeq(): number {
    const row = selectMaxDeletionEventSeqStatement.get() as { maxSeq: number }
    return row.maxSeq
  }

  function pollNewMessages(afterSeq: number, limit: number): LobbyChatMessageSnapshot[] {
    const rows = selectNewMessagesStatement.all(afterSeq, limit) as LobbyChatMessageRow[]
    return rows.map(toSnapshot)
  }

  function pollDeletionEvents(afterEventSeq: number, limit: number): LobbyChatDeletionEvent[] {
    const rows = selectDeletionEventsStatement.all(afterEventSeq, limit) as Array<{
      event_seq: number
      message_id: string
    }>
    return rows.map((row) => ({ eventSeq: row.event_seq, messageId: row.message_id }))
  }

  function purgeOlderThanDays(
    days: number,
    batchSize: number,
  ): { deletedMessages: number; deletedDeletionEvents: number } {
    const normalizedDays = Number.isInteger(days) && days > 0 ? days : 30
    const normalizedBatchSize = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 500
    const cutoff = new Date(Date.now() - normalizedDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('Z', '')

    let deletedMessages = 0
    for (;;) {
      const changes = getChanges(
        purgeMessagesBatchStatement.run(cutoff, normalizedBatchSize),
      )
      deletedMessages += changes
      if (changes < normalizedBatchSize) break
    }

    let deletedDeletionEvents = 0
    for (;;) {
      const changes = getChanges(
        purgeDeletionEventsBatchStatement.run(cutoff, normalizedBatchSize),
      )
      deletedDeletionEvents += changes
      if (changes < normalizedBatchSize) break
    }

    return { deletedMessages, deletedDeletionEvents }
  }

  function close(): void {
    database.close()
  }

  return {
    insertMessage,
    listRecentMessages,
    deleteMessage,
    getMaxSeq,
    getMaxDeletionEventSeq,
    pollNewMessages,
    pollDeletionEvents,
    purgeOlderThanDays,
    close,
  }
}
