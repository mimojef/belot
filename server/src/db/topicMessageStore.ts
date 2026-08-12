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

/**
 * Fanout събитие за cross-instance individual message/reply moderation
 * delete broadcast — mirror на LobbyChatDeletionEvent. `parentMessageId`
 * е snapshot на target-а към момента на изтриване: null = target е бил
 * root (client маха целия thread), non-null = target е бил reply (client
 * маха само него).
 */
export type TopicMessageDeletionEvent = {
  eventSeq: number
  topicId: string
  messageId: string
  parentMessageId: string | null
}

export type TopicMessageAggregates = {
  likeCount: number
  replyCount: number
  viewerHasLiked: boolean
}

// Attachment metadata — reuse на СЪЩИЯ shape/модел като
// ChatAttachmentSnapshot/support attachment (виж chatStore.ts): отделна
// таблица (не колона в topic_messages), 1:1 с message_id, derived-at-read
// viewUrl/downloadUrl (построени в index.ts, не тук — store-ът не знае
// нищо за HTTP routing, само filename/dimensions/size).
export type TopicMessageAttachmentRecord = {
  storageFilename: string
  width: number
  height: number
  byteSize: number
  contentType: string
}

export type NewTopicMessageAttachmentInput = {
  storageFilename: string
  width: number
  height: number
  byteSize: number
  contentType: string
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
  /**
   * Вмъква ново ROOT съобщение (parent_message_id винаги NULL). `attachment`
   * опционален — insert на съобщение + attachment ред е в ЕДНА BEGIN
   * IMMEDIATE транзакция (виж имплементацията), симетрично на
   * chatStore.sendMessage/supportStore — файлът вече е записан на диск
   * ПРЕДИ това извикване (index.ts координира file-write → DB-transaction →
   * delete-on-failure).
   */
  insertMessage: (input: {
    topicId: string
    senderProfileId: string
    senderDisplayName: string
    senderRole: TopicMessageSenderRole
    body: string
    attachment?: NewTopicMessageAttachmentInput | null
  }) => TopicMessageSnapshot
  /**
   * Вмъква нов REPLY (parent_message_id = parentMessageId, задължителен и
   * винаги сочещ директно към ROOT съобщение — едно ниво, виж Етап 3 брифа:
   * "reply-to-reply" enforcement е caller-ова отговорност в index.ts преди
   * извикване тук, store-ът не проверява дали parent самият е root).
   */
  insertReply: (input: {
    topicId: string
    parentMessageId: string
    senderProfileId: string
    senderDisplayName: string
    senderRole: TopicMessageSenderRole
    body: string
    attachment?: NewTopicMessageAttachmentInput | null
  }) => TopicMessageSnapshot
  /** Първите `limit` replies на `parentMessageId`, старо→ново (хронологично четене отгоре-надолу, за разлика от root viewport-към-дъното). */
  getReplies: (
    parentMessageId: string,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ) => TopicMessageHistoryPage
  /** Replies СЛЕД `afterSeq` — forward "Покажи още" pagination (cursor напредва напред, не назад). */
  getRepliesAfter: (
    parentMessageId: string,
    afterSeq: number,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ) => TopicMessageHistoryPage
  /** По message_id за единичен lookup (parent-is-root проверка при reply insert, message-exists проверка при like toggle). */
  getMessageById: (messageId: string) => TopicMessageSnapshot | null
  /**
   * Moderator delete на ОТДЕЛНО root съобщение или reply (individual-message
   * moderation, различно от topicModerationStore.deleteTopic whole-topic
   * delete). Виж имплементацията за пълния transaction rationale.
   */
  deleteMessage: (input: {
    topicId: string
    messageId: string
    actorAccountId: string | null
    actorRole: 'admin' | 'subadmin' | 'top_chat_admin' | 'pika_team' | 'chat_admin'
  }) => (
    | { ok: true; deletedMessageIds: string[]; deletedAttachmentFilenames: string[]; parentMessageId: string | null; deletedAt: string }
    | { ok: false; code: 'not_found' | 'already_deleted' }
  )
  /** Baseline за cross-instance individual-message-deletion poll cursor при startup. */
  getMaxDeletionEventSeq: () => number
  /** Poll за нови individual-message deletion fanout събития СЛЕД `afterEventSeq` — mirror на pollNewMessages, но за deletion events. */
  pollMessageDeletionEvents: (afterEventSeq: number, limit: number) => TopicMessageDeletionEvent[]
  /**
   * Bounded batch hard-purge на individual-message-moderation soft-deleted
   * съобщения с `deleted_at <= cutoff`, ЧИЯТО тема НЕ Е `removed` (whole-topic
   * 180-day purge е authoritative за removed теми, виж имплементацията).
   */
  purgeDeletedTopicMessagesBefore: (cutoff: Date, batchSize: number) => number
  /**
   * Batch likeCount/replyCount/viewerHasLiked за набор от messageId-та —
   * до 4 агрегатни заявки ОБЩО за целия набор (не per-message), захранва REST
   * страница от 30-50 root messages или reply списък без N+1.
   * `viewerProfileId=null` → viewerHasLiked винаги false за всички (guest/
   * unauthenticated context, макар Topics вече да е registered-only).
   * `excludedSenderProfileIds` филтрира replyCount (viewer-aware — blocked
   * sender-и не трябва да се броят, за да не показва replyCount число,
   * по-голямо от реално видимите replies при expand). likeCount ОСТАВА
   * global aggregate, НЕ филтрирано (block не променя likeCount — likes
   * нямат видима liker identity, виж Етап 3 брифа).
   */
  getMessageAggregatesByIds: (
    messageIds: readonly string[],
    viewerProfileId: string | null,
    excludedSenderProfileIds?: readonly string[],
  ) => Map<string, TopicMessageAggregates>
  /**
   * Batch attachment lookup за набор от messageId-та — ЕДНА заявка за целия
   * batch (root list page / reply page / poll batch), не N+1. Съобщения без
   * attachment просто липсват от Map-а (не null-стойност) — caller-ът прави
   * `.get(id) ?? null`, симетрично на getMessageAggregatesByIds default-map
   * pattern-а по-горе.
   */
  getAttachmentsByMessageIds: (messageIds: readonly string[]) => Map<string, TopicMessageAttachmentRecord>
  /**
   * Guard за защитения view/download endpoint (index.ts
   * handleTopicAttachmentDownloadRequest) — attachment записът трябва
   * действително да принадлежи на съобщение от ЗАДЪЛЖИТЕЛНО подадения
   * topicId (предотвратява enumeration на снимки от друга тема чрез познат
   * UUID.webp filename). Registered-read-access проверката (auth сесия,
   * не-guest) е отговорност на caller-а (index.ts), точно като
   * handleTopicMessagesRequest — тук само DB-level isolation.
   */
  getAttachmentForDownload: (
    topicId: string,
    storageFilename: string,
  ) => { storageFilename: string; contentType: string } | null
  attachmentExistsForFilename: (storageFilename: string) => boolean
  /** Deletion-intent запис — extra safety net за orphan file (виж index.ts: не се очаква нормално да е нужен, тъй като insertMessage/insertReply вече изтриват файла синхронно при DB грешка; за бъдещ message-delete flow. */
  enqueueAttachmentDeletion: (storageFilename: string) => void
  listPendingAttachmentDeletions: (limit: number) => { eventSeq: number; storageFilename: string }[]
  markAttachmentDeletionDone: (eventSeq: number) => void
  markAttachmentDeletionFailed: (eventSeq: number) => void
  purgeDoneAttachmentDeletions: (olderThanDays: number, batchSize: number) => number
  /** Toggle like: INSERT ако липсва, DELETE ако съществува — единична BEGIN IMMEDIATE транзакция, връща новия likeCount + viewerHasLiked. */
  toggleLike: (
    messageId: string,
    likerProfileId: string,
  ) => { likeCount: number; viewerHasLiked: boolean }
  /** Текущия likeCount за набор от messageId-та — за lightweight cross-instance drift-detection polling (Етап 3, виж index.ts). */
  getLikeCountsByMessageIds: (messageIds: readonly string[]) => Map<string, number>
  /** Глобален (кросс-тема) максимален seq — baseline за cross-instance poll cursor при startup. */
  getMaxSeq: () => number
  /**
   * Глобален (кросс-тема) poll за нови редове СЛЕД `afterSeq` — вижда И root,
   * И reply редове (Етап 3 разширение — премахнат parent_message_id IS NULL
   * филтъра, за да не пропуска replies, insert-нати от друг instance). Това е
   * единствената функция, чийто резултат трябва да движи cross-instance poll
   * cursor-а (виж invariant коментара в index.ts). НЕ се ползва за
   * per-connection catch-up (виж getMessagesAfter/getRepliesAfter по-горе).
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

  const insertAttachmentStatement = database.prepare(`
    INSERT INTO topic_message_attachments (
      message_id, storage_filename, width, height, byte_size, content_type
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)

  function insertMessage(input: {
    topicId: string
    senderProfileId: string
    senderDisplayName: string
    senderRole: TopicMessageSenderRole
    body: string
    attachment?: NewTopicMessageAttachmentInput | null
  }): TopicMessageSnapshot {
    const messageId = randomUUID()
    database.exec('BEGIN IMMEDIATE;')
    try {
      insertMessageStatement.run(
        messageId,
        input.topicId,
        input.senderProfileId,
        input.senderDisplayName,
        input.senderRole,
        input.body,
      )
      if (input.attachment) {
        insertAttachmentStatement.run(
          messageId,
          input.attachment.storageFilename,
          input.attachment.width,
          input.attachment.height,
          input.attachment.byteSize,
          input.attachment.contentType,
        )
      }
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
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
  // topic_id при broadcast. Етап 3: НЕ филтрира по parent_message_id вече —
  // вижда И root, И reply редове, за да не пропуска replies, insert-нати от
  // друг instance (виж computeTopicMessagePollAdvance/index.ts, който
  // разклонява broadcast-а по row.parentMessageId след прочитане оттук).
  // deleted_at филтърът остава — изтрити редове никога не се broadcast-ват.
  const pollNewMessagesStatement = database.prepare(`
    SELECT seq, message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body, created_at, deleted_at
    FROM topic_messages
    WHERE seq > ?
      AND deleted_at IS NULL
    ORDER BY seq ASC
    LIMIT ?;
  `)

  function pollNewMessages(afterSeq: number, limit: number): TopicMessageSnapshot[] {
    const rows = pollNewMessagesStatement.all(afterSeq, limit) as TopicMessageRow[]
    return rows.map(toSnapshot)
  }

  // ─── Replies (Етап 3) ────────────────────────────────────────────────────

  const insertReplyStatement = database.prepare(`
    INSERT INTO topic_messages (
      message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body
    ) VALUES (?, ?, ?, ?, ?, ?, ?);
  `)

  function insertReply(input: {
    topicId: string
    parentMessageId: string
    senderProfileId: string
    senderDisplayName: string
    senderRole: TopicMessageSenderRole
    body: string
    attachment?: NewTopicMessageAttachmentInput | null
  }): TopicMessageSnapshot {
    const messageId = randomUUID()
    database.exec('BEGIN IMMEDIATE;')
    try {
      insertReplyStatement.run(
        messageId,
        input.topicId,
        input.parentMessageId,
        input.senderProfileId,
        input.senderDisplayName,
        input.senderRole,
        input.body,
      )
      if (input.attachment) {
        insertAttachmentStatement.run(
          messageId,
          input.attachment.storageFilename,
          input.attachment.width,
          input.attachment.height,
          input.attachment.byteSize,
          input.attachment.contentType,
        )
      }
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
    const row = selectByMessageIdStatement.get(messageId) as TopicMessageRow
    return toSnapshot(row)
  }

  // Forward (ASC) — replies се четат хронологично отгоре-надолу (за разлика
  // от root viewport-към-дъното), затова getReplies е директно ASC, без
  // reverse (за разлика от getRecentMessages, който е DESC+reverse).
  function buildRepliesStatement(excludedCount: number, afterClause: string) {
    const exclusionClause = excludedCount > 0
      ? `AND sender_profile_id NOT IN (${Array(excludedCount).fill('?').join(',')})`
      : ''
    return database.prepare(`
      SELECT seq, message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body, created_at, deleted_at
      FROM topic_messages
      WHERE parent_message_id = ?
        AND deleted_at IS NULL
        ${afterClause}
        ${exclusionClause}
      ORDER BY seq ASC
      LIMIT ?;
    `)
  }

  function runRepliesPage(
    parentMessageId: string,
    limit: number,
    excludedSenderProfileIds: readonly string[],
    afterSeq: number | null,
  ): TopicMessageHistoryPage {
    const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : 20
    const afterClause = afterSeq !== null ? 'AND seq > ?' : ''
    const statement = buildRepliesStatement(excludedSenderProfileIds.length, afterClause)

    const args: Array<string | number> = [parentMessageId]
    if (afterSeq !== null) args.push(afterSeq)
    args.push(...excludedSenderProfileIds)
    args.push(normalizedLimit + 1)

    const rows = statement.all(...args) as TopicMessageRow[]
    const hasMore = rows.length > normalizedLimit
    const pageRows = hasMore ? rows.slice(0, normalizedLimit) : rows

    const messages = pageRows.map(toSnapshot)
    const oldestSeq = messages.length > 0 ? messages[0]!.seq : null

    return { messages, hasMore, oldestSeq }
  }

  function getReplies(
    parentMessageId: string,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ): TopicMessageHistoryPage {
    return runRepliesPage(parentMessageId, limit, excludedSenderProfileIds, null)
  }

  function getRepliesAfter(
    parentMessageId: string,
    afterSeq: number,
    limit: number,
    excludedSenderProfileIds: readonly string[],
  ): TopicMessageHistoryPage {
    return runRepliesPage(parentMessageId, limit, excludedSenderProfileIds, afterSeq)
  }

  function getMessageById(messageId: string): TopicMessageSnapshot | null {
    const row = selectByMessageIdStatement.get(messageId) as TopicMessageRow | undefined
    return row ? toSnapshot(row) : null
  }

  // ─── Individual message/reply moderation delete ─────────────────────────
  //
  // Root delete CASCADE-обхваща своите replies В САМАТА транзакция (не разчита
  // на DB FK CASCADE — soft-delete е UPDATE, не DELETE, FK CASCADE никога не
  // тригерва тук). Reply delete засяга само себе си. Mirror на established
  // lobbyChatStore.deleteMessage атомарност (BEGIN IMMEDIATE, load-then-branch,
  // idempotent already_deleted).

  const selectReplyIdsForRootStatement = database.prepare(`
    SELECT message_id FROM topic_messages
    WHERE parent_message_id = ? AND deleted_at IS NULL;
  `)

  const selectAttachmentFilenamesForMessagesStatementCache = new Map<number, ReturnType<typeof database.prepare>>()
  function getSelectAttachmentFilenamesForMessagesStatement(count: number): ReturnType<typeof database.prepare> {
    const cached = selectAttachmentFilenamesForMessagesStatementCache.get(count)
    if (cached) return cached
    const placeholders = Array.from({ length: count }, () => '?').join(',')
    const statement = database.prepare(`
      SELECT storage_filename FROM topic_message_attachments WHERE message_id IN (${placeholders});
    `)
    selectAttachmentFilenamesForMessagesStatementCache.set(count, statement)
    return statement
  }

  const deleteAttachmentsForMessagesStatementCache = new Map<number, ReturnType<typeof database.prepare>>()
  function getDeleteAttachmentsForMessagesStatement(count: number): ReturnType<typeof database.prepare> {
    const cached = deleteAttachmentsForMessagesStatementCache.get(count)
    if (cached) return cached
    const placeholders = Array.from({ length: count }, () => '?').join(',')
    const statement = database.prepare(`
      DELETE FROM topic_message_attachments WHERE message_id IN (${placeholders});
    `)
    deleteAttachmentsForMessagesStatementCache.set(count, statement)
    return statement
  }

  const softDeleteMessagesStatementCache = new Map<number, ReturnType<typeof database.prepare>>()
  function getSoftDeleteMessagesStatement(count: number): ReturnType<typeof database.prepare> {
    const cached = softDeleteMessagesStatementCache.get(count)
    if (cached) return cached
    const placeholders = Array.from({ length: count }, () => '?').join(',')
    const statement = database.prepare(`
      UPDATE topic_messages SET deleted_at = CURRENT_TIMESTAMP WHERE message_id IN (${placeholders}) AND deleted_at IS NULL;
    `)
    softDeleteMessagesStatementCache.set(count, statement)
    return statement
  }

  const insertMessageDeletionEventStatement = database.prepare(`
    INSERT INTO topic_message_deletion_events (topic_id, message_id, parent_message_id) VALUES (?, ?, ?);
  `)

  const insertMessageDeletionAuditStatement = database.prepare(`
    INSERT INTO topic_message_deletion_audit_log (
      log_id, topic_id, message_id, parent_message_id, sender_profile_id, actor_account_id, actor_role
    ) VALUES (?, ?, ?, ?, ?, ?, ?);
  `)

  /**
   * Moderator delete на ЕДНО target съобщение (root ИЛИ reply):
   *  - Ако target е ROOT (parent_message_id IS NULL): soft-delete-ва root-а
   *    И всичките му (все още live) replies В ЕДНА транзакция — цял thread,
   *    коректен deletion timestamp (CURRENT_TIMESTAMP на самия UPDATE),
   *    ЕДИН deletion event + ЕДИН audit ред за root action (не N reда за
   *    collateral replies, брифа §11).
   *  - Ако target е REPLY: soft-delete само него, root и sibling replies
   *    остават напълно непокътнати.
   * Attachment DB redовете (max 1/съобщение) на ВСИЧКИ засегнати message ids
   * се hard-delete-ват веднага и filenames се enqueue-ват за физически
   * cleanup — reuse на established whole-topic invariant (topicModerationStore.deleteTopic).
   * Idempotent: вече-deleted target → already_deleted, без нов audit/event ред.
   */
  function deleteMessage(input: {
    topicId: string
    messageId: string
    actorAccountId: string | null
    actorRole: 'admin' | 'subadmin' | 'top_chat_admin' | 'pika_team' | 'chat_admin'
  }):
    | { ok: true; deletedMessageIds: string[]; deletedAttachmentFilenames: string[]; parentMessageId: string | null; deletedAt: string }
    | { ok: false; code: 'not_found' | 'already_deleted' } {
    const target = selectByMessageIdStatement.get(input.messageId) as TopicMessageRow | undefined

    if (target === undefined || target.topic_id !== input.topicId) {
      return { ok: false, code: 'not_found' }
    }

    if (target.deleted_at !== null) {
      return { ok: false, code: 'already_deleted' }
    }

    const isRoot = target.parent_message_id === null
    const affectedMessageIds: string[] = [target.message_id]

    if (isRoot) {
      const replyRows = selectReplyIdsForRootStatement.all(target.message_id) as Array<{ message_id: string }>
      for (const row of replyRows) {
        affectedMessageIds.push(row.message_id)
      }
    }

    let deletedAttachmentFilenames: string[] = []

    database.exec('BEGIN IMMEDIATE;')
    try {
      const attachmentRows = getSelectAttachmentFilenamesForMessagesStatement(affectedMessageIds.length)
        .all(...affectedMessageIds) as Array<{ storage_filename: string }>
      deletedAttachmentFilenames = attachmentRows.map((row) => row.storage_filename)

      for (const filename of deletedAttachmentFilenames) {
        insertAttachmentDeletionStatement.run(filename)
      }

      getDeleteAttachmentsForMessagesStatement(affectedMessageIds.length).run(...affectedMessageIds)

      const changes = getSoftDeleteMessagesStatement(affectedMessageIds.length).run(...affectedMessageIds)
      if ((changes.changes as number) === 0) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'already_deleted' }
      }

      insertMessageDeletionEventStatement.run(input.topicId, target.message_id, target.parent_message_id)
      insertMessageDeletionAuditStatement.run(
        randomUUID(),
        input.topicId,
        target.message_id,
        target.parent_message_id,
        target.sender_profile_id,
        input.actorAccountId,
        input.actorRole,
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

    const updatedTargetRow = selectByMessageIdStatement.get(target.message_id) as TopicMessageRow
    return {
      ok: true,
      deletedMessageIds: affectedMessageIds,
      deletedAttachmentFilenames,
      parentMessageId: target.parent_message_id,
      deletedAt: dbDateToUtc(updatedTargetRow.deleted_at as string),
    }
  }

  const selectMaxDeletionEventSeqStatement = database.prepare(`
    SELECT COALESCE(MAX(event_seq), 0) as maxSeq FROM topic_message_deletion_events;
  `)

  function getMaxDeletionEventSeq(): number {
    const row = selectMaxDeletionEventSeqStatement.get() as { maxSeq: number }
    return row.maxSeq
  }

  const selectDeletionEventsStatement = database.prepare(`
    SELECT event_seq, topic_id, message_id, parent_message_id
    FROM topic_message_deletion_events
    WHERE event_seq > ?
    ORDER BY event_seq ASC
    LIMIT ?;
  `)

  function pollMessageDeletionEvents(afterEventSeq: number, limit: number): TopicMessageDeletionEvent[] {
    const rows = selectDeletionEventsStatement.all(afterEventSeq, limit) as Array<{
      event_seq: number
      topic_id: string
      message_id: string
      parent_message_id: string | null
    }>
    return rows.map((row) => ({
      eventSeq: row.event_seq,
      topicId: row.topic_id,
      messageId: row.message_id,
      parentMessageId: row.parent_message_id,
    }))
  }

  /**
   * Bounded batch hard-purge на individual-message-moderation soft-deleted
   * съобщения, чийто `deleted_at` е >= 180 дни в миналото (removed_at <=
   * cutoff boundary policy, симетрично на topicModerationStore.purgeRemovedTopicsBefore).
   * Изключва съобщения от `removed` теми изрично — whole-topic 180-day purge
   * (purgeRemovedTopicsBefore, anchored от topics.removed_at) е authoritative
   * там, за да няма два competing purge lifecycle-а за една и съща removed
   * тема (individual-message-moderation брифа §3/§22).
   * Hard DELETE FROM topic_messages CASCADE-трие автоматично: replies (self-FK,
   * само за root targets — вече soft-deleted заедно с root-а в deleteMessage),
   * topic_message_likes, topic_message_deletion_events, topic_message_deletion_audit_log
   * (виж migration коментара). topic_message_attachments вече е празно за тези
   * redове (hard-deleted immediate при самия deleteMessage() delete-call).
   * Bounded batch без OFFSET (established convention).
   */
  function purgeDeletedTopicMessagesBefore(cutoff: Date, batchSize: number): number {
    const cutoffStr = cutoff.toISOString().slice(0, 19).replace('T', ' ')
    let totalDeleted = 0
    for (;;) {
      const rows = database.prepare(`
        SELECT m.message_id FROM topic_messages m
        INNER JOIN topics t ON t.topic_id = m.topic_id
        WHERE m.deleted_at IS NOT NULL AND m.deleted_at <= ? AND t.status != 'removed'
        ORDER BY m.message_id ASC
        LIMIT ?;
      `).all(cutoffStr, batchSize) as Array<{ message_id: string }>
      if (rows.length === 0) break
      const ids = rows.map((row) => row.message_id)
      const placeholders = ids.map(() => '?').join(',')
      database.prepare(`DELETE FROM topic_messages WHERE message_id IN (${placeholders});`).run(...ids)
      totalDeleted += ids.length
      if (rows.length < batchSize) break
    }
    return totalDeleted
  }

  // ─── Likes (Етап 3) ──────────────────────────────────────────────────────

  function getMessageAggregatesByIds(
    messageIds: readonly string[],
    viewerProfileId: string | null,
    excludedSenderProfileIds: readonly string[] = [],
  ): Map<string, TopicMessageAggregates> {
    const result = new Map<string, TopicMessageAggregates>(
      messageIds.map((id) => [id, { likeCount: 0, replyCount: 0, viewerHasLiked: false }]),
    )
    if (messageIds.length === 0) return result

    const placeholders = messageIds.map(() => '?').join(',')

    // likeCount е global aggregate — НЕ филтрирано по excludedSenderProfileIds
    // (block не променя likeCount, liker identities никога не се показват).
    const likeCountRows = database
      .prepare(`SELECT message_id, COUNT(*) as cnt FROM topic_message_likes WHERE message_id IN (${placeholders}) GROUP BY message_id;`)
      .all(...messageIds) as Array<{ message_id: string; cnt: number }>
    for (const row of likeCountRows) {
      const entry = result.get(row.message_id)
      if (entry) entry.likeCount = row.cnt
    }

    // replyCount Е viewer-aware — reply от блокиран sender не се вижда от
    // viewer-а (REST reply history/realtime push вече го филтрират), затова
    // replyCount трябва да брои само реално видимите за ТОЗИ viewer replies.
    // Без това: UI показва "💬 5", но expand разкрива само 3 (blocked-ите 2
    // липсват) — несъответствие, което потребителят изрично не иска.
    const replyExclusionClause = excludedSenderProfileIds.length > 0
      ? `AND sender_profile_id NOT IN (${excludedSenderProfileIds.map(() => '?').join(',')})`
      : ''
    const replyCountRows = database
      .prepare(`SELECT parent_message_id, COUNT(*) as cnt FROM topic_messages WHERE parent_message_id IN (${placeholders}) AND deleted_at IS NULL ${replyExclusionClause} GROUP BY parent_message_id;`)
      .all(...messageIds, ...excludedSenderProfileIds) as Array<{ parent_message_id: string; cnt: number }>
    for (const row of replyCountRows) {
      const entry = result.get(row.parent_message_id)
      if (entry) entry.replyCount = row.cnt
    }

    if (viewerProfileId !== null) {
      const likedRows = database
        .prepare(`SELECT message_id FROM topic_message_likes WHERE liker_profile_id = ? AND message_id IN (${placeholders});`)
        .all(viewerProfileId, ...messageIds) as Array<{ message_id: string }>
      for (const row of likedRows) {
        const entry = result.get(row.message_id)
        if (entry) entry.viewerHasLiked = true
      }
    }

    return result
  }

  const selectLikeExistsStatement = database.prepare(`
    SELECT 1 FROM topic_message_likes WHERE message_id = ? AND liker_profile_id = ? LIMIT 1;
  `)
  const insertLikeStatement = database.prepare(`
    INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?)
    ON CONFLICT(message_id, liker_profile_id) DO NOTHING;
  `)
  const deleteLikeStatement = database.prepare(`
    DELETE FROM topic_message_likes WHERE message_id = ? AND liker_profile_id = ?;
  `)
  const selectLikeCountStatement = database.prepare(`
    SELECT COUNT(*) as cnt FROM topic_message_likes WHERE message_id = ?;
  `)

  // Единична BEGIN IMMEDIATE транзакция — SELECT-then-branch (insert/delete)
  // е atomic спрямо конкурентни connections от same/different profile на
  // same message_id (виж Етап 3 брифа т.7: "double click / multiple tabs").
  // PRIMARY KEY(message_id, liker_profile_id) остава ultimate correctness
  // arbiter независимо от тази транзакция — тя е за да върнем коректен
  // likeCount/viewerHasLiked В СЪЩИЯ round-trip, не самата correctness.
  function toggleLike(messageId: string, likerProfileId: string): { likeCount: number; viewerHasLiked: boolean } {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const exists = selectLikeExistsStatement.get(messageId, likerProfileId) !== undefined
      if (exists) {
        deleteLikeStatement.run(messageId, likerProfileId)
      } else {
        insertLikeStatement.run(messageId, likerProfileId)
      }
      const { cnt } = selectLikeCountStatement.get(messageId) as { cnt: number }
      database.exec('COMMIT;')
      return { likeCount: cnt, viewerHasLiked: !exists }
    } catch (err) {
      database.exec('ROLLBACK;')
      throw err
    }
  }

  function getLikeCountsByMessageIds(messageIds: readonly string[]): Map<string, number> {
    const result = new Map<string, number>(messageIds.map((id) => [id, 0]))
    if (messageIds.length === 0) return result
    const placeholders = messageIds.map(() => '?').join(',')
    const rows = database
      .prepare(`SELECT message_id, COUNT(*) as cnt FROM topic_message_likes WHERE message_id IN (${placeholders}) GROUP BY message_id;`)
      .all(...messageIds) as Array<{ message_id: string; cnt: number }>
    for (const row of rows) {
      result.set(row.message_id, row.cnt)
    }
    return result
  }

  // ─── Attachments (image, Топикс attachment feature) ───────────────────────

  function getAttachmentsByMessageIds(messageIds: readonly string[]): Map<string, TopicMessageAttachmentRecord> {
    const result = new Map<string, TopicMessageAttachmentRecord>()
    if (messageIds.length === 0) return result
    const placeholders = messageIds.map(() => '?').join(',')
    const rows = database
      .prepare(`SELECT message_id, storage_filename, width, height, byte_size, content_type FROM topic_message_attachments WHERE message_id IN (${placeholders});`)
      .all(...messageIds) as Array<{ message_id: string; storage_filename: string; width: number; height: number; byte_size: number; content_type: string }>
    for (const row of rows) {
      result.set(row.message_id, {
        storageFilename: row.storage_filename,
        width: row.width,
        height: row.height,
        byteSize: row.byte_size,
        contentType: row.content_type,
      })
    }
    return result
  }

  const selectAttachmentForDownloadStatement = database.prepare(`
    SELECT a.storage_filename, a.content_type
    FROM topic_message_attachments a
    INNER JOIN topic_messages m ON m.message_id = a.message_id
    WHERE a.storage_filename = ? AND m.topic_id = ?
    LIMIT 1;
  `)

  function getAttachmentForDownload(
    topicId: string,
    storageFilename: string,
  ): { storageFilename: string; contentType: string } | null {
    const row = selectAttachmentForDownloadStatement.get(storageFilename, topicId) as
      | { storage_filename: string; content_type: string }
      | undefined
    if (row === undefined) return null
    return { storageFilename: row.storage_filename, contentType: row.content_type }
  }

  const selectAttachmentExistsStatement = database.prepare(`
    SELECT 1 FROM topic_message_attachments WHERE storage_filename = ? LIMIT 1;
  `)

  function attachmentExistsForFilename(storageFilename: string): boolean {
    return selectAttachmentExistsStatement.get(storageFilename) !== undefined
  }

  const insertAttachmentDeletionStatement = database.prepare(`
    INSERT INTO topic_message_attachment_deletions (storage_filename) VALUES (?);
  `)

  function enqueueAttachmentDeletion(storageFilename: string): void {
    insertAttachmentDeletionStatement.run(storageFilename)
  }

  const selectPendingAttachmentDeletionsStatement = database.prepare(`
    SELECT event_seq, storage_filename
    FROM topic_message_attachment_deletions
    WHERE cleanup_status IN ('pending', 'failed')
    ORDER BY event_seq ASC
    LIMIT ?;
  `)

  function listPendingAttachmentDeletions(limit: number): { eventSeq: number; storageFilename: string }[] {
    const rows = selectPendingAttachmentDeletionsStatement.all(limit) as Array<{ event_seq: number; storage_filename: string }>
    return rows.map((row) => ({ eventSeq: row.event_seq, storageFilename: row.storage_filename }))
  }

  const markAttachmentDeletionStatusStatement = database.prepare(`
    UPDATE topic_message_attachment_deletions SET cleanup_status = ? WHERE event_seq = ?;
  `)

  function markAttachmentDeletionDone(eventSeq: number): void {
    markAttachmentDeletionStatusStatement.run('done', eventSeq)
  }

  function markAttachmentDeletionFailed(eventSeq: number): void {
    markAttachmentDeletionStatusStatement.run('failed', eventSeq)
  }

  function purgeDoneAttachmentDeletions(olderThanDays: number, batchSize: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    let totalDeleted = 0
    while (totalDeleted < batchSize) {
      const remaining = batchSize - totalDeleted
      const result = database.prepare(`
        DELETE FROM topic_message_attachment_deletions
        WHERE event_seq IN (
          SELECT event_seq FROM topic_message_attachment_deletions
          WHERE cleanup_status = 'done' AND created_at < ?
          ORDER BY event_seq ASC
          LIMIT ?
        );
      `).run(cutoff, remaining)
      const deleted = result.changes as number
      totalDeleted += deleted
      if (deleted === 0) break
    }
    return totalDeleted
  }

  function close(): void {
    database.close()
  }

  return {
    getRecentMessages,
    getMessagesBefore,
    getMessagesAfter,
    insertMessage,
    insertReply,
    getReplies,
    getRepliesAfter,
    getMessageById,
    deleteMessage,
    getMaxDeletionEventSeq,
    pollMessageDeletionEvents,
    purgeDeletedTopicMessagesBefore,
    getMessageAggregatesByIds,
    getAttachmentsByMessageIds,
    getAttachmentForDownload,
    attachmentExistsForFilename,
    enqueueAttachmentDeletion,
    listPendingAttachmentDeletions,
    markAttachmentDeletionDone,
    markAttachmentDeletionFailed,
    purgeDoneAttachmentDeletions,
    toggleLike,
    getLikeCountsByMessageIds,
    getMaxSeq,
    pollNewMessages,
    close,
  }
}
