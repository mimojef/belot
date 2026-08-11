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

export type TopicMessageAggregates = {
  likeCount: number
  replyCount: number
  viewerHasLiked: boolean
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
  /** Вмъква ново ROOT съобщение (parent_message_id винаги NULL). */
  insertMessage: (input: {
    topicId: string
    senderProfileId: string
    senderDisplayName: string
    senderRole: TopicMessageSenderRole
    body: string
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
  }): TopicMessageSnapshot {
    const messageId = randomUUID()
    insertReplyStatement.run(
      messageId,
      input.topicId,
      input.parentMessageId,
      input.senderProfileId,
      input.senderDisplayName,
      input.senderRole,
      input.body,
    )
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
    getMessageAggregatesByIds,
    toggleLike,
    getLikeCountsByMessageIds,
    getMaxSeq,
    pollNewMessages,
    close,
  }
}
