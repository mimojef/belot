import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TopicMessageSenderRole = 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'

export type TopicMessageSnapshot = {
  seq: number
  messageId: string
  topicId: string
  parentMessageId: string | null
  senderProfileId: string
  senderDisplayName: string
  /**
   * Derived, НЕ пазено в topic_messages — resolve-нато от canonical profile
   * data (playerProgressStore.getPublicProfile) при enrichment в index.ts,
   * не тук в store слоя (store-ът няма достъп до playerProgressStore и не
   * би трябвало да го има — единствена отговорност: read/write на редове).
   * Показва ТЕКУЩИЯ avatar на подателя, не snapshot от момента на писане —
   * ако потребителят смени снимката си, старите съобщения показват новата.
   * null = профилът няма avatar (или вече не съществува) → client fallback letter.
   */
  senderAvatarUrl: string | null
  senderRole: TopicMessageSenderRole
  body: string
  createdAt: string
  deletedAt: string | null
}

export type TopicMessageHistoryPage = {
  messages: TopicMessageSnapshot[]
  hasMore: boolean
  oldestSeq: number | null
}

export type TopicMessageStore = {
  /** Последните `limit` root съобщения в темата, подредени старо→ново (viewport към дъното). */
  getRecentMessages: (
    topicId: string,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ) => TopicMessageHistoryPage
  /** По-стари root съобщения от `beforeSeq` (изключително), подредени старо→ново — за prepend при scroll нагоре. */
  getMessagesBefore: (
    topicId: string,
    beforeSeq: number,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ) => TopicMessageHistoryPage
  /**
   * Root съобщения СЛЕД `afterSeq` (изключително) в ЕДНА тема, старо→ново —
   * per-connection gap-closing catch-up при (re)subscribe (Етап 2 realtime),
   * НЕ пълна история. `hasMore` тук се чете като "truncated" от повикващия
   * (index.ts) — ако е true, клиентът пада обратно на REST recent refresh
   * вместо да разчита на частичен catch-up batch.
   */
  getMessagesAfter: (
    topicId: string,
    afterSeq: number,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ) => TopicMessageHistoryPage
  /** Вмъква ново ROOT съобщение (parent_message_id винаги NULL — Етап 2 е root-only). */
  insertMessage: (input: {
    topicId: string
    senderProfileId: string
    senderDisplayName: string
    senderRole: TopicMessageSenderRole
    body: string
  }) => TopicMessageSnapshot
  /** Глобален (кросс-тема) максимален seq — baseline за cross-instance poll cursor при startup. */
  getMaxSeq: () => number
  /**
   * Глобален (кросс-тема) poll за нови редове СЛЕД `afterSeq` — единствената
   * функция, чийто резултат трябва да движи cross-instance poll cursor-а
   * (виж invariant коментара в index.ts). НЕ се ползва за per-connection
   * catch-up (виж getMessagesAfter по-горе).
   */
  pollNewMessages: (afterSeq: number, limit: number) => TopicMessageSnapshot[]
  close: () => void
}

type TopicMessageRow = {
  seq: number
  message_id: string
  topic_id: string
  parent_message_id: string | null
  sender_profile_id: string
  sender_display_name: string
  sender_role: TopicMessageSenderRole
  body: string
  created_at: string
  deleted_at: string | null
}

function toSnapshot(row: TopicMessageRow): TopicMessageSnapshot {
  return {
    seq: row.seq,
    messageId: row.message_id,
    topicId: row.topic_id,
    parentMessageId: row.parent_message_id,
    senderProfileId: row.sender_profile_id,
    senderDisplayName: row.sender_display_name,
    senderAvatarUrl: null, // попълва се в index.ts enrichment слоя, виж коментара в типа
    senderRole: row.sender_role,
    body: row.body,
    createdAt: dbDateToUtc(row.created_at),
    deletedAt: row.deleted_at ? dbDateToUtc(row.deleted_at) : null,
  }
}

export async function createTopicMessageStore(databaseFilePath: string): Promise<TopicMessageStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  // Root-only (parent_message_id IS NULL) — replies остават извън Етап 1
  // stream-а. deleted_at IS NULL — изтрити съобщения никога не се връщат
  // като нормално съдържание (виж т.12 от брифа), дори когато Етап 4
  // добави moderation delete.
  //
  // Заявяваме `limit + 1` ред и после проверяваме дали действително сме
  // получили повече от `limit`, за да изчислим hasMore БЕЗ отделна COUNT(*)
  // заявка — известен evтин "peek ahead" pattern за cursor pagination.
  function buildStatement(excludedCount: number, beforeClause: string) {
    const exclusionClause = excludedCount > 0
      ? `AND sender_profile_id NOT IN (${Array(excludedCount).fill('?').join(',')})`
      : ''
    return database.prepare(`
      SELECT seq, message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body, created_at, deleted_at
      FROM topic_messages
      WHERE topic_id = ?
        AND parent_message_id IS NULL
        AND deleted_at IS NULL
        ${beforeClause}
        ${exclusionClause}
      ORDER BY seq DESC
      LIMIT ?;
    `)
  }

  function runPage(
    topicId: string,
    limit: number,
    excludedSenderProfileIds: readonly string[],
    beforeSeq: number | null,
  ): TopicMessageHistoryPage {
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 30
    const beforeClause = beforeSeq !== null ? 'AND seq < ?' : ''
    const statement = buildStatement(excludedSenderProfileIds.length, beforeClause)

    const args: Array<string | number> = [topicId]
    if (beforeSeq !== null) args.push(beforeSeq)
    args.push(...excludedSenderProfileIds)
    // +1 "peek ahead" — виж коментара над buildStatement.
    args.push(normalizedLimit + 1)

    const rows = statement.all(...args) as TopicMessageRow[]
    const hasMore = rows.length > normalizedLimit
    const pageRows = hasMore ? rows.slice(0, normalizedLimit) : rows

    // pageRows е seq DESC (най-новото първо) — reverse към старо→ново за
    // директен viewport render (виж т.4 от брифа: "подреждат се визуално
    // от по-стари към по-нови").
    const messages = pageRows.map(toSnapshot).reverse()
    const oldestSeq = messages.length > 0 ? messages[0]!.seq : null

    return { messages, hasMore, oldestSeq }
  }

  function getRecentMessages(
    topicId: string,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ): TopicMessageHistoryPage {
    return runPage(topicId, limit, excludedSenderProfileIds, null)
  }

  function getMessagesBefore(
    topicId: string,
    beforeSeq: number,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ): TopicMessageHistoryPage {
    return runPage(topicId, limit, excludedSenderProfileIds, beforeSeq)
  }

  // Forward (ASC) вариант на buildStatement за gap-closing catch-up — отделна
  // заявка от buildStatement (DESC, за viewport pagination), защото посоката
  // на ORDER BY и семантиката на "hasMore" (тук: "truncated", виж типа по-горе)
  // са различни: catch-up никога не прескача редове, само маркира дали е имало
  // повече, отколкото cap-ът позволява.
  function buildAfterStatement(excludedCount: number) {
    const exclusionClause = excludedCount > 0
      ? `AND sender_profile_id NOT IN (${Array(excludedCount).fill('?').join(',')})`
      : ''
    return database.prepare(`
      SELECT seq, message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body, created_at, deleted_at
      FROM topic_messages
      WHERE topic_id = ?
        AND parent_message_id IS NULL
        AND deleted_at IS NULL
        AND seq > ?
        ${exclusionClause}
      ORDER BY seq ASC
      LIMIT ?;
    `)
  }

  function getMessagesAfter(
    topicId: string,
    afterSeq: number,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ): TopicMessageHistoryPage {
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 30
    const statement = buildAfterStatement(excludedSenderProfileIds.length)

    const args: Array<string | number> = [topicId, afterSeq, ...excludedSenderProfileIds, normalizedLimit + 1]
    const rows = statement.all(...args) as TopicMessageRow[]

    const hasMore = rows.length > normalizedLimit
    const pageRows = hasMore ? rows.slice(0, normalizedLimit) : rows
    const messages = pageRows.map(toSnapshot)
    const oldestSeq = messages.length > 0 ? messages[0]!.seq : null

    return { messages, hasMore, oldestSeq }
  }

  const insertMessageStatement = database.prepare(`
    INSERT INTO topic_messages (
      message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body
    ) VALUES (?, ?, NULL, ?, ?, ?, ?);
  `)

  const selectByMessageIdStatement = database.prepare(`
    SELECT seq, message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body, created_at, deleted_at
    FROM topic_messages
    WHERE message_id = ?
    LIMIT 1;
  `)

  function insertMessage(input: {
    topicId: string
    senderProfileId: string
    senderDisplayName: string
    senderRole: TopicMessageSenderRole
    body: string
  }): TopicMessageSnapshot {
    const messageId = randomUUID()
    insertMessageStatement.run(
      messageId,
      input.topicId,
      input.senderProfileId,
      input.senderDisplayName,
      input.senderRole,
      input.body,
    )
    const row = selectByMessageIdStatement.get(messageId) as TopicMessageRow
    return toSnapshot(row)
  }

  const selectMaxSeqStatement = database.prepare(`
    SELECT COALESCE(MAX(seq), 0) as maxSeq FROM topic_messages;
  `)

  function getMaxSeq(): number {
    const row = selectMaxSeqStatement.get() as { maxSeq: number }
    return row.maxSeq
  }

  // Кросс-тема (без topic_id filter) — единствен консуматор е cross-instance
  // poll tick-ът в index.ts, който после group-ва редовете по техния собствен
  // topic_id при broadcast. root-only/not-deleted филтрите се пазят и тук за
  // симетрия с останалите read пътища, макар Етап 2 да пише само root съобщения.
  const pollNewMessagesStatement = database.prepare(`
    SELECT seq, message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body, created_at, deleted_at
    FROM topic_messages
    WHERE seq > ?
      AND parent_message_id IS NULL
      AND deleted_at IS NULL
    ORDER BY seq ASC
    LIMIT ?;
  `)

  function pollNewMessages(afterSeq: number, limit: number): TopicMessageSnapshot[] {
    const rows = pollNewMessagesStatement.all(afterSeq, limit) as TopicMessageRow[]
    return rows.map(toSnapshot)
  }

  function close(): void {
    database.close()
  }

  return {
    getRecentMessages,
    getMessagesBefore,
    getMessagesAfter,
    insertMessage,
    getMaxSeq,
    pollNewMessages,
    close,
  }
}
