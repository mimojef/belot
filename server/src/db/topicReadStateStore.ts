type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TopicReadStateSnapshot = {
  profileId: string
  topicId: string
  lastSeenSeq: number
  updatedAt: string
}

export type TopicThreadReadStateSnapshot = {
  profileId: string
  rootMessageId: string
  lastSeenSeq: number
  updatedAt: string
}

type TopicReadStateRow = {
  profile_id: string
  topic_id: string
  last_seen_seq: number
  updated_at: string
}

type TopicThreadReadStateRow = {
  profile_id: string
  root_message_id: string
  last_seen_seq: number
  updated_at: string
}

export type TopicReadStateStore = {
  ensureReadStateForTopics: (profileId: string, topicIds: readonly string[]) => void
  markTopicSeenToLatestSeq: (profileId: string, topicId: string) => { ok: true; state: TopicReadStateSnapshot } | { ok: false; code: 'not_found' }
  markTopicSeenThroughSeq: (profileId: string, topicId: string, seenSeq: number) => { ok: true; state: TopicReadStateSnapshot } | { ok: false; code: 'not_found' }
  markThreadSeenToLatestSeq: (
    profileId: string,
    rootMessageId: string,
  ) => { ok: true; state: TopicThreadReadStateSnapshot; topicId: string } | { ok: false; code: 'not_found' }
  markSenderSeenThroughCurrent: (profileId: string, senderProfileId: string) => void
  getReadState: (profileId: string, topicId: string) => TopicReadStateSnapshot | null
  getThreadReadState: (profileId: string, rootMessageId: string) => TopicThreadReadStateSnapshot | null
  getUnreadCountsByTopicIds: (
    profileId: string,
    topicIds: readonly string[],
    excludedSenderProfileIds?: readonly string[],
  ) => Map<string, number>
  getUnreadCountsByRootMessageIds: (
    profileId: string,
    rootMessageIds: readonly string[],
    excludedSenderProfileIds?: readonly string[],
  ) => Map<string, number>
  getGeneralThreadUnreadTotal: (
    profileId: string,
    topicId: string,
    excludedSenderProfileIds?: readonly string[],
  ) => number
  /**
   * Batch вариант на getGeneralThreadUnreadTotal — за N профила наведнъж,
   * с фиксиран малък брой SQL statements (не loop, викащ single-profile
   * заявката N пъти). Виж имплементацията за структурния подход
   * (fetch-веднъж + in-memory per-viewer aggregation).
   */
  getGeneralThreadUnreadTotalsForProfiles: (
    topicId: string,
    profileIds: readonly string[],
    excludedSenderProfileIdsByViewer: ReadonlyMap<string, ReadonlySet<string>>,
  ) => Map<string, number>
  /**
   * Batch вариант на getTopicThreadUnreadCountForProfile (index.ts) — unread
   * за ЕДИН rootMessageId, за N профила наведнъж.
   */
  getThreadUnreadCountsForProfiles: (
    rootMessageId: string,
    profileIds: readonly string[],
    excludedSenderProfileIdsByViewer: ReadonlyMap<string, ReadonlySet<string>>,
  ) => Map<string, number>
  /**
   * Batch вариант на getUnreadCountsByTopicIds — за ЕДНА тема (non-general),
   * за N профила наведнъж.
   */
  getUnreadCountForTopicForProfiles: (
    topicId: string,
    profileIds: readonly string[],
    excludedSenderProfileIdsByViewer: ReadonlyMap<string, ReadonlySet<string>>,
  ) => Map<string, number>
  getLatestSeqForTopic: (topicId: string) => number
  close: () => void
}

function toSnapshot(row: TopicReadStateRow): TopicReadStateSnapshot {
  return {
    profileId: row.profile_id,
    topicId: row.topic_id,
    lastSeenSeq: row.last_seen_seq,
    updatedAt: row.updated_at,
  }
}

function toThreadSnapshot(row: TopicThreadReadStateRow): TopicThreadReadStateSnapshot {
  return {
    profileId: row.profile_id,
    rootMessageId: row.root_message_id,
    lastSeenSeq: row.last_seen_seq,
    updatedAt: row.updated_at,
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',')
}

export async function createTopicReadStateStore(databaseFilePath: string): Promise<TopicReadStateStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectReadStateStatement = database.prepare(`
    SELECT profile_id, topic_id, last_seen_seq, updated_at
    FROM topic_read_state
    WHERE profile_id = ? AND topic_id = ?
    LIMIT 1;
  `)

  const selectThreadReadStateStatement = database.prepare(`
    SELECT profile_id, root_message_id, last_seen_seq, updated_at
    FROM topic_thread_read_state
    WHERE profile_id = ? AND root_message_id = ?
    LIMIT 1;
  `)

  const selectLatestTopicSeqStatement = database.prepare(`
    SELECT COALESCE(MAX(seq), 0) as latestSeq
    FROM topic_messages
    WHERE topic_id = ?;
  `)

  const selectLiveTopicStatement = database.prepare(`
    SELECT 1 as found
    FROM topics
    WHERE topic_id = ? AND status IN ('active', 'locked')
    LIMIT 1;
  `)

  const selectLiveRootMessageStatement = database.prepare(`
    SELECT m.topic_id, COALESCE(MAX(thread_msg.seq), m.seq) as latestSeq
    FROM topic_messages m
    JOIN topics t ON t.topic_id = m.topic_id AND t.status IN ('active', 'locked')
    JOIN topic_messages thread_msg
      ON thread_msg.topic_id = m.topic_id
      AND (thread_msg.message_id = m.message_id OR thread_msg.parent_message_id = m.message_id)
    WHERE m.message_id = ?
      AND m.parent_message_id IS NULL
      AND m.deleted_at IS NULL
    GROUP BY m.topic_id, m.seq
    LIMIT 1;
  `)

  const upsertReadStateStatement = database.prepare(`
    INSERT INTO topic_read_state (profile_id, topic_id, last_seen_seq, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    ON CONFLICT(profile_id, topic_id) DO UPDATE SET
      last_seen_seq = MAX(topic_read_state.last_seen_seq, excluded.last_seen_seq),
      updated_at = CASE
        WHEN excluded.last_seen_seq > topic_read_state.last_seen_seq THEN excluded.updated_at
        ELSE topic_read_state.updated_at
      END;
  `)

  const upsertThreadReadStateStatement = database.prepare(`
    INSERT INTO topic_thread_read_state (profile_id, root_message_id, last_seen_seq, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    ON CONFLICT(profile_id, root_message_id) DO UPDATE SET
      last_seen_seq = MAX(topic_thread_read_state.last_seen_seq, excluded.last_seen_seq),
      updated_at = CASE
        WHEN excluded.last_seen_seq > topic_thread_read_state.last_seen_seq THEN excluded.updated_at
        ELSE topic_thread_read_state.updated_at
      END;
  `)

  const markSenderSeenThroughCurrentStatement = database.prepare(`
    INSERT INTO topic_sender_seen_state (profile_id, topic_id, sender_profile_id, seen_through_seq, updated_at)
    SELECT
      ?,
      topic_id,
      sender_profile_id,
      MAX(seq),
      strftime('%Y-%m-%dT%H:%M:%f', 'now')
    FROM topic_messages
    WHERE sender_profile_id = ?
    GROUP BY topic_id, sender_profile_id
    ON CONFLICT(profile_id, topic_id, sender_profile_id) DO UPDATE SET
      seen_through_seq = MAX(topic_sender_seen_state.seen_through_seq, excluded.seen_through_seq),
      updated_at = CASE
        WHEN excluded.seen_through_seq > topic_sender_seen_state.seen_through_seq THEN excluded.updated_at
        ELSE topic_sender_seen_state.updated_at
      END;
  `)

  function getLatestSeqForTopic(topicId: string): number {
    const row = selectLatestTopicSeqStatement.get(topicId) as { latestSeq: number } | undefined
    return row?.latestSeq ?? 0
  }

  function getReadState(profileId: string, topicId: string): TopicReadStateSnapshot | null {
    const row = selectReadStateStatement.get(profileId, topicId) as TopicReadStateRow | undefined
    return row ? toSnapshot(row) : null
  }

  function getThreadReadState(profileId: string, rootMessageId: string): TopicThreadReadStateSnapshot | null {
    const row = selectThreadReadStateStatement.get(profileId, rootMessageId) as TopicThreadReadStateRow | undefined
    return row ? toThreadSnapshot(row) : null
  }

  function ensureReadStateForTopics(profileId: string, topicIds: readonly string[]): void {
    const uniqueTopicIds = [...new Set(topicIds.filter((id) => id.trim().length > 0))]
    if (uniqueTopicIds.length === 0) return

    const inClause = placeholders(uniqueTopicIds.length)
    const statement = database.prepare(`
      INSERT INTO topic_read_state (profile_id, topic_id, last_seen_seq, updated_at)
      SELECT
        ?,
        t.topic_id,
        COALESCE((SELECT MAX(m.seq) FROM topic_messages m WHERE m.topic_id = t.topic_id), 0),
        strftime('%Y-%m-%dT%H:%M:%f', 'now')
      FROM topics t
      WHERE t.topic_id IN (${inClause})
        AND t.status IN ('active', 'locked')
        AND NOT EXISTS (
          SELECT 1
          FROM topic_read_state rs
          WHERE rs.profile_id = ? AND rs.topic_id = t.topic_id
        );
    `)

    database.exec('BEGIN IMMEDIATE;')
    try {
      statement.run(profileId, ...uniqueTopicIds, profileId)
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
  }

  function markTopicSeenThroughSeq(
    profileId: string,
    topicId: string,
    seenSeq: number,
  ): { ok: true; state: TopicReadStateSnapshot } | { ok: false; code: 'not_found' } {
    const liveTopic = selectLiveTopicStatement.get(topicId) as { found: number } | undefined
    if (liveTopic === undefined) return { ok: false, code: 'not_found' }
    const normalizedSeq = Number.isInteger(seenSeq) && seenSeq > 0 ? seenSeq : 0
    upsertReadStateStatement.run(profileId, topicId, normalizedSeq)
    const state = getReadState(profileId, topicId)
    if (state === null) return { ok: false, code: 'not_found' }
    return { ok: true, state }
  }

  function markTopicSeenToLatestSeq(
    profileId: string,
    topicId: string,
  ): { ok: true; state: TopicReadStateSnapshot } | { ok: false; code: 'not_found' } {
    const liveTopic = selectLiveTopicStatement.get(topicId) as { found: number } | undefined
    if (liveTopic === undefined) return { ok: false, code: 'not_found' }

    database.exec('BEGIN IMMEDIATE;')
    try {
      const latestSeq = getLatestSeqForTopic(topicId)
      upsertReadStateStatement.run(profileId, topicId, latestSeq)
      const state = getReadState(profileId, topicId)
      database.exec('COMMIT;')
      if (state === null) return { ok: false, code: 'not_found' }
      return { ok: true, state }
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
  }

  function markThreadSeenToLatestSeq(
    profileId: string,
    rootMessageId: string,
  ): { ok: true; state: TopicThreadReadStateSnapshot; topicId: string } | { ok: false; code: 'not_found' } {
    const liveRoot = selectLiveRootMessageStatement.get(rootMessageId) as { topic_id: string; latestSeq: number } | undefined
    if (liveRoot === undefined) return { ok: false, code: 'not_found' }

    database.exec('BEGIN IMMEDIATE;')
    try {
      upsertThreadReadStateStatement.run(profileId, rootMessageId, liveRoot.latestSeq)
      const state = getThreadReadState(profileId, rootMessageId)
      database.exec('COMMIT;')
      if (state === null) return { ok: false, code: 'not_found' }
      return { ok: true, state, topicId: liveRoot.topic_id }
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
  }

  function markSenderSeenThroughCurrent(profileId: string, senderProfileId: string): void {
    markSenderSeenThroughCurrentStatement.run(profileId, senderProfileId)
  }

  function getUnreadCountsByTopicIds(
    profileId: string,
    topicIds: readonly string[],
    excludedSenderProfileIds: readonly string[] = [],
  ): Map<string, number> {
    const uniqueTopicIds = [...new Set(topicIds.filter((id) => id.trim().length > 0))]
    const counts = new Map<string, number>()
    for (const topicId of uniqueTopicIds) counts.set(topicId, 0)
    if (uniqueTopicIds.length === 0) return counts

    const topicClause = placeholders(uniqueTopicIds.length)
    const exclusionClause = excludedSenderProfileIds.length > 0
      ? `AND m.sender_profile_id NOT IN (${placeholders(excludedSenderProfileIds.length)})`
      : ''

    const statement = database.prepare(`
      SELECT m.topic_id, COUNT(*) as unread_count
      FROM topic_messages m
      JOIN topics t ON t.topic_id = m.topic_id AND t.status IN ('active', 'locked')
      LEFT JOIN topic_read_state rs
        ON rs.profile_id = ? AND rs.topic_id = m.topic_id
      LEFT JOIN topic_sender_seen_state ss
        ON ss.profile_id = ?
        AND ss.topic_id = m.topic_id
        AND ss.sender_profile_id = m.sender_profile_id
      WHERE m.topic_id IN (${topicClause})
        AND m.deleted_at IS NULL
        AND m.sender_profile_id != ?
        AND m.seq > COALESCE(rs.last_seen_seq, 0)
        AND m.seq > COALESCE(ss.seen_through_seq, 0)
        ${exclusionClause}
      GROUP BY m.topic_id;
    `)

    const rows = statement.all(
      profileId,
      profileId,
      ...uniqueTopicIds,
      profileId,
      ...excludedSenderProfileIds,
    ) as Array<{ topic_id: string; unread_count: number }>

    for (const row of rows) {
      counts.set(row.topic_id, row.unread_count)
    }
    return counts
  }

  function buildThreadUnreadQuery(rootFilterSql: string, excludedSenderProfileIds: readonly string[]): string {
    const exclusionClause = excludedSenderProfileIds.length > 0
      ? `AND m.sender_profile_id NOT IN (${placeholders(excludedSenderProfileIds.length)})`
      : ''

    return `
      SELECT root.message_id as root_message_id, COUNT(m.message_id) as unread_count
      FROM topic_messages root
      JOIN topics t ON t.topic_id = root.topic_id AND t.status IN ('active', 'locked')
      JOIN topic_messages m
        ON m.topic_id = root.topic_id
        AND (m.message_id = root.message_id OR m.parent_message_id = root.message_id)
      LEFT JOIN topic_thread_read_state trs
        ON trs.profile_id = ? AND trs.root_message_id = root.message_id
      LEFT JOIN topic_read_state rs
        ON rs.profile_id = ? AND rs.topic_id = root.topic_id
      LEFT JOIN topic_sender_seen_state ss
        ON ss.profile_id = ?
        AND ss.topic_id = m.topic_id
        AND ss.sender_profile_id = m.sender_profile_id
      WHERE ${rootFilterSql}
        AND root.parent_message_id IS NULL
        AND root.deleted_at IS NULL
        AND m.deleted_at IS NULL
        AND m.sender_profile_id != ?
        AND m.seq > COALESCE(trs.last_seen_seq, rs.last_seen_seq, 0)
        AND m.seq > COALESCE(ss.seen_through_seq, 0)
        ${exclusionClause}
      GROUP BY root.message_id;
    `
  }

  function getUnreadCountsByRootMessageIds(
    profileId: string,
    rootMessageIds: readonly string[],
    excludedSenderProfileIds: readonly string[] = [],
  ): Map<string, number> {
    const uniqueRootMessageIds = [...new Set(rootMessageIds.filter((id) => id.trim().length > 0))]
    const counts = new Map<string, number>()
    for (const rootMessageId of uniqueRootMessageIds) counts.set(rootMessageId, 0)
    if (uniqueRootMessageIds.length === 0) return counts

    const statement = database.prepare(buildThreadUnreadQuery(
      `root.message_id IN (${placeholders(uniqueRootMessageIds.length)})`,
      excludedSenderProfileIds,
    ))

    const rows = statement.all(
      profileId,
      profileId,
      profileId,
      ...uniqueRootMessageIds,
      profileId,
      ...excludedSenderProfileIds,
    ) as Array<{ root_message_id: string; unread_count: number }>

    for (const row of rows) counts.set(row.root_message_id, row.unread_count)
    return counts
  }

  // Perf audit fix: старата форма join-ваше root (root_messages) СРЕЩУ m
  // (root+replies) чрез `m.message_id = root.message_id OR m.parent_message_id
  // = root.message_id`, после GROUP BY root.message_id + outer SUM — SQLite
  // избира `m` (не `root`) като driving table по idx_topic_messages_topic_seq
  // (виж EXPLAIN QUERY PLAN коментара по-долу), но всеки `m` ред пак прави
  // допълнителен `root` PK lookup, и целият resultset минава през temp
  // B-tree заради GROUP BY, макар caller-ът да иска само SUM, не per-thread
  // breakdown. Тъй като всеки topic_messages ред (root ИЛИ reply) си има
  // точно ЕДНА "ефективна root" стойност — себе си за root-ове,
  // parent_message_id за replies — threshold lookup-ът в
  // topic_thread_read_state може да join-не directno по
  // COALESCE(m.parent_message_id, m.message_id), без изобщо да минава през
  // отделен GROUP-BY-ван `root` alias. Резултатът е COUNT(*) directno (без
  // GROUP BY/temp B-tree). root_check е ЛЕК допълнителен PK LEFT JOIN (не
  // добавя допълнителен table scan), нужен САМО за да mirror-не старата
  // `root.deleted_at IS NULL` семантика — production deleteMessage() cascade-
  // делита replies при root delete, но заявката не трябва тихо да разчита на
  // тази production invariant-a: ако някога съществуват "orphaned" живи
  // replies под soft-deleted root (defensive edge case, верифицирано с
  // dedicated regression тест — checkTopicUnreadSeen.ts [7]), те трябва да
  // продължат да НЕ се броят за unread, точно както преди. Верифицирано
  // byte-identical на старата заявка срещу локалната DB за 51 реални
  // (profile, read-state) комбинации, вкл. thread-level/topic-level/
  // sender-seen read state, block exclusion, и deleted-root-with-live-replies
  // edge case-а (виж performance audit-а).
  function getGeneralThreadUnreadTotal(
    profileId: string,
    topicId: string,
    excludedSenderProfileIds: readonly string[] = [],
  ): number {
    const exclusionClause = excludedSenderProfileIds.length > 0
      ? `AND m.sender_profile_id NOT IN (${placeholders(excludedSenderProfileIds.length)})`
      : ''

    const statement = database.prepare(`
      SELECT COUNT(*) as unread_count
      FROM topic_messages m
      JOIN topics t ON t.topic_id = m.topic_id AND t.status IN ('active', 'locked')
      LEFT JOIN topic_messages root_check ON root_check.message_id = m.parent_message_id
      LEFT JOIN topic_thread_read_state trs
        ON trs.profile_id = ?
        AND trs.root_message_id = COALESCE(m.parent_message_id, m.message_id)
      LEFT JOIN topic_read_state rs ON rs.profile_id = ? AND rs.topic_id = m.topic_id
      LEFT JOIN topic_sender_seen_state ss
        ON ss.profile_id = ?
        AND ss.topic_id = m.topic_id
        AND ss.sender_profile_id = m.sender_profile_id
      WHERE m.topic_id = ?
        AND m.deleted_at IS NULL
        AND (m.parent_message_id IS NULL OR root_check.deleted_at IS NULL)
        AND m.sender_profile_id != ?
        AND m.seq > COALESCE(trs.last_seen_seq, rs.last_seen_seq, 0)
        AND m.seq > COALESCE(ss.seen_through_seq, 0)
        ${exclusionClause};
    `)

    const row = statement.get(
      profileId,
      profileId,
      profileId,
      topicId,
      profileId,
      ...excludedSenderProfileIds,
    ) as { unread_count: number } | undefined
    return row?.unread_count ?? 0
  }

  // ─── Batch (multi-profile) unread — perf audit follow-up ──────────────────
  //
  // Проблем, който тези три функции решават: broadcast/reconcile hot path-ът
  // вече dedupe-ва connections по уникален profileId (виж index.ts), но все
  // още викаше единичните getGeneralThreadUnreadTotal/getTopicThreadUnreadCountForProfile/
  // getUnreadCountsByTopicIds В LOOP, по един път на всеки уникален profileId
  // — O(uniqueProfiles) SQL statements per broadcast event. При 60-100
  // едновременни различни subscribers, това пак е десетки/стотици
  // последователни sync SQLite execution-а на всяко събитие.
  //
  // Структурен fix: и трите batch функции по-долу правят ФИКСИРАН малък брой
  // SQL statements (независим от P = броя профили), не един statement per
  // profile:
  //   (1) fetch-ват relevant read-state redовете (topic_read_state/
  //       topic_thread_read_state/topic_sender_seen_state) за ЦЕЛИЯ profile
  //       batch наведнъж (по 1 заявка всяка, WHERE profile_id IN (...) —
  //       малки, индексирани lookup-и в read-state таблиците, не зависят от
  //       общия message history размер);
  //   (2) fetch-ват relevant topic_messages redовете (thread или цяла тема)
  //       ЕДИН ПЪТ, независимо от profile count (index-backed — MULTI-INDEX
  //       OR за единичен thread, range SEARCH по topic_id за цяла тема);
  //   (3) compute-ват unread резултата per profile IN-MEMORY (JS Map lookups,
  //       O(1) всеки) — нула допълнителни SQL statements тук.
  //
  // Exact семантика (read-state priority, sender-seen exclusion, block
  // exclusion, deleted-root-with-live-replies edge case) mirror-ва точно
  // единичните функции по-горе — верифицирано byte-identical резултат срещу
  // тях за произволен profile subset (виж regression теста).

  type ThreadRow = { message_id: string; parent_message_id: string | null; sender_profile_id: string; seq: number }

  function isUnreadForViewer(
    row: ThreadRow,
    viewerProfileId: string,
    threadThreshold: number | undefined,
    topicThreshold: number,
    senderSeenThreshold: number,
    excludedSenders: ReadonlySet<string> | undefined,
  ): boolean {
    if (row.sender_profile_id === viewerProfileId) return false
    if (excludedSenders?.has(row.sender_profile_id)) return false
    const threshold = threadThreshold ?? topicThreshold
    if (row.seq <= threshold) return false
    if (row.seq <= senderSeenThreshold) return false
    return true
  }

  function getGeneralThreadUnreadTotalsForProfiles(
    topicId: string,
    profileIds: readonly string[],
    excludedSenderProfileIdsByViewer: ReadonlyMap<string, ReadonlySet<string>>,
  ): Map<string, number> {
    const uniqueProfileIds = [...new Set(profileIds)]
    const counts = new Map<string, number>(uniqueProfileIds.map((id) => [id, 0]))
    if (uniqueProfileIds.length === 0) return counts

    const liveTopic = selectLiveTopicStatement.get(topicId) as { found: number } | undefined
    if (liveTopic === undefined) return counts

    const profilePlaceholders = placeholders(uniqueProfileIds.length)

    // (1) topic_read_state за целия profile batch — ЕДНА заявка. Малка,
    // индексирана по (profile_id, topic_id) — bounded от profile count, не
    // от history size.
    const topicReadRows = database.prepare(`
      SELECT profile_id, last_seen_seq FROM topic_read_state
      WHERE topic_id = ? AND profile_id IN (${profilePlaceholders});
    `).all(topicId, ...uniqueProfileIds) as Array<{ profile_id: string; last_seen_seq: number }>
    const topicThresholdByProfile = new Map(topicReadRows.map((r) => [r.profile_id, r.last_seen_seq]))

    const minTopicThreshold = uniqueProfileIds.reduce(
      (min, id) => Math.min(min, topicThresholdByProfile.get(id) ?? 0),
      Number.POSITIVE_INFINITY,
    )
    const boundedMinTopicThreshold = Number.isFinite(minTopicThreshold) ? minTopicThreshold : 0

    // (2) topic_thread_read_state за ЦЕЛИЯ profile batch — ЕДНА заявка,
    // bounded от "колко различни roots profile-ите в batch-а някога са
    // отваряли" (индексирано по profile_id в PK), НЕ от topic history size.
    // Забележка: това НЕ е "read всички overrides навсякъде в темата" —
    // profile_id IN (...) прави го bounded от profile activity, не от
    // total message count. Използваме го само за да намерим КОИ roots имат
    // override от batch-а (стъпка 3), не за global min() (виж defect
    // коментара по-долу за защо global min е грешен).
    const overrideRows = database.prepare(`
      SELECT profile_id, root_message_id, last_seen_seq FROM topic_thread_read_state
      WHERE profile_id IN (${profilePlaceholders});
    `).all(...uniqueProfileIds) as Array<{ profile_id: string; root_message_id: string; last_seen_seq: number }>
    const threadThresholdByProfileAndRoot = new Map<string, number>()
    const minOverrideByRoot = new Map<string, number>()
    for (const r of overrideRows) {
      threadThresholdByProfileAndRoot.set(`${r.profile_id}:${r.root_message_id}`, r.last_seen_seq)
      const currentMin = minOverrideByRoot.get(r.root_message_id)
      if (currentMin === undefined || r.last_seen_seq < currentMin) minOverrideByRoot.set(r.root_message_id, r.last_seen_seq)
    }

    // (3) Structural fix (topic_root_latest_seq materialized index): вместо
    // сканиране на ВСИЧКИ topic_messages в темата, или compute-ване на ЕДИН
    // GLOBAL min() над ВСИЧКИ thread-overrides на batch-а (предишният подход
    // — грешен/уязвим: stale override на root A би свалял cutoff-а и за
    // напълно несвързан root B), намираме candidate roots на ДВЕ вълни:
    //   (a) roots БЕЗ нито един override от batch-а — валиден праг е
    //       boundedMinTopicThreshold (isUnreadForViewer използва
    //       topicThreshold, когато threadThreshold е undefined за viewer-а);
    //   (b) roots С поне 1 override от batch-а — валиден праг е
    //       min(boundedMinTopicThreshold, minOverrideByRoot[root]), защото
    //       viewer-и БЕЗ override на този root пак ползват topicThreshold,
    //       а viewer-и С override могат да имат по-нисък ефективен праг.
    // И двете вълни са per-root коректни (не global) — stale override само
    // сваля прага на СВОЯ root, никога на други roots.
    const overriddenRootIds = [...minOverrideByRoot.keys()]
    let candidateRoots: Array<{ root_message_id: string }>
    if (overriddenRootIds.length === 0) {
      candidateRoots = database.prepare(`
        SELECT root_message_id FROM topic_root_latest_seq
        WHERE topic_id = ? AND latest_seq > ?;
      `).all(topicId, boundedMinTopicThreshold) as Array<{ root_message_id: string }>
    } else {
      const overriddenPlaceholders = placeholders(overriddenRootIds.length)
      // Wave (a): non-overridden roots above the plain topic-level floor.
      const plainCandidates = database.prepare(`
        SELECT root_message_id, latest_seq FROM topic_root_latest_seq
        WHERE topic_id = ? AND latest_seq > ? AND root_message_id NOT IN (${overriddenPlaceholders});
      `).all(topicId, boundedMinTopicThreshold, ...overriddenRootIds) as Array<{ root_message_id: string; latest_seq: number }>
      // Wave (b): overridden roots — fetched by PK (bounded by override
      // count, not topic size), each checked against ITS OWN floor.
      const overriddenCandidatesRaw = database.prepare(`
        SELECT root_message_id, latest_seq FROM topic_root_latest_seq
        WHERE root_message_id IN (${overriddenPlaceholders});
      `).all(...overriddenRootIds) as Array<{ root_message_id: string; latest_seq: number }>
      const overriddenCandidates = overriddenCandidatesRaw.filter(
        (r) => r.latest_seq > Math.min(boundedMinTopicThreshold, minOverrideByRoot.get(r.root_message_id)!),
      )
      candidateRoots = [...plainCandidates, ...overriddenCandidates]
    }
    if (candidateRoots.length === 0) return counts

    const candidateRootIds = candidateRoots.map((r) => r.root_message_id)
    const rootPlaceholders = placeholders(candidateRootIds.length)

    // (4) topic_sender_seen_state за целия profile batch — ЕДНА заявка.
    const senderSeenRows = database.prepare(`
      SELECT profile_id, sender_profile_id, seen_through_seq FROM topic_sender_seen_state
      WHERE topic_id = ? AND profile_id IN (${profilePlaceholders});
    `).all(topicId, ...uniqueProfileIds) as Array<{ profile_id: string; sender_profile_id: string; seen_through_seq: number }>
    const senderSeenThresholdByProfileAndSender = new Map<string, number>()
    for (const r of senderSeenRows) senderSeenThresholdByProfileAndSender.set(`${r.profile_id}:${r.sender_profile_id}`, r.seen_through_seq)

    // (5) Live (root+reply) редове — САМО за candidate roots, PK/parent-index
    // lookup (MULTI-INDEX OR bounded от candidate roots × техния reply
    // count), НЕ пълен topic scan. root_check LEFT JOIN mirror-ва
    // deleted-root exclusion семантиката от единичната getGeneralThreadUnreadTotal
    // (defensive — production cascade-delete прави това невъзможно, но пазим
    // инварианта explicit).
    const rows = database.prepare(`
      SELECT m.message_id, m.parent_message_id, m.sender_profile_id, m.seq
      FROM topic_messages m
      LEFT JOIN topic_messages root_check ON root_check.message_id = m.parent_message_id
      WHERE (m.message_id IN (${rootPlaceholders}) OR m.parent_message_id IN (${rootPlaceholders}))
        AND m.deleted_at IS NULL
        AND (m.parent_message_id IS NULL OR root_check.deleted_at IS NULL);
    `).all(...candidateRootIds, ...candidateRootIds) as ThreadRow[]
    if (rows.length === 0) return counts

    // (6) In-memory aggregation — нула допълнителни SQL statements.
    for (const profileId of uniqueProfileIds) {
      const topicThreshold = topicThresholdByProfile.get(profileId) ?? 0
      const excludedSenders = excludedSenderProfileIdsByViewer.get(profileId)
      let unreadCount = 0
      for (const row of rows) {
        const effectiveRootId = row.parent_message_id ?? row.message_id
        const threadThreshold = threadThresholdByProfileAndRoot.get(`${profileId}:${effectiveRootId}`)
        const senderSeenThreshold = senderSeenThresholdByProfileAndSender.get(`${profileId}:${row.sender_profile_id}`) ?? 0
        if (isUnreadForViewer(row, profileId, threadThreshold, topicThreshold, senderSeenThreshold, excludedSenders)) {
          unreadCount++
        }
      }
      counts.set(profileId, unreadCount)
    }

    return counts
  }

  function getThreadUnreadCountsForProfiles(
    rootMessageId: string,
    profileIds: readonly string[],
    excludedSenderProfileIdsByViewer: ReadonlyMap<string, ReadonlySet<string>>,
  ): Map<string, number> {
    const uniqueProfileIds = [...new Set(profileIds)]
    const counts = new Map<string, number>(uniqueProfileIds.map((id) => [id, 0]))
    if (uniqueProfileIds.length === 0) return counts

    // (1) Целия thread (root + replies) — ЕДНА заявка, MULTI-INDEX OR
    // (message_id PK lookup за root-а + idx_topic_messages_parent за
    // replies), bounded от thread size, не topic size.
    const rows = database.prepare(`
      SELECT message_id, parent_message_id, sender_profile_id, seq, topic_id
      FROM topic_messages
      WHERE (message_id = ? OR parent_message_id = ?) AND deleted_at IS NULL;
    `).all(rootMessageId, rootMessageId) as Array<ThreadRow & { topic_id: string }>
    if (rows.length === 0) return counts

    const topicId = rows.find((r) => r.message_id === rootMessageId)?.topic_id
    if (topicId === undefined) return counts
    const liveTopic = selectLiveTopicStatement.get(topicId) as { found: number } | undefined
    if (liveTopic === undefined) return counts

    const profilePlaceholders = placeholders(uniqueProfileIds.length)

    // (2) topic_thread_read_state за ТОЗИ root, за целия profile batch.
    const threadReadRows = database.prepare(`
      SELECT profile_id, last_seen_seq FROM topic_thread_read_state
      WHERE root_message_id = ? AND profile_id IN (${profilePlaceholders});
    `).all(rootMessageId, ...uniqueProfileIds) as Array<{ profile_id: string; last_seen_seq: number }>
    const threadThresholdByProfile = new Map(threadReadRows.map((r) => [r.profile_id, r.last_seen_seq]))

    // (3) topic_read_state (topic-level fallback) за целия profile batch.
    const topicReadRows = database.prepare(`
      SELECT profile_id, last_seen_seq FROM topic_read_state
      WHERE topic_id = ? AND profile_id IN (${profilePlaceholders});
    `).all(topicId, ...uniqueProfileIds) as Array<{ profile_id: string; last_seen_seq: number }>
    const topicThresholdByProfile = new Map(topicReadRows.map((r) => [r.profile_id, r.last_seen_seq]))

    // (4) topic_sender_seen_state за целия profile batch.
    const senderSeenRows = database.prepare(`
      SELECT profile_id, sender_profile_id, seen_through_seq FROM topic_sender_seen_state
      WHERE topic_id = ? AND profile_id IN (${profilePlaceholders});
    `).all(topicId, ...uniqueProfileIds) as Array<{ profile_id: string; sender_profile_id: string; seen_through_seq: number }>
    const senderSeenThresholdByProfileAndSender = new Map<string, number>()
    for (const r of senderSeenRows) senderSeenThresholdByProfileAndSender.set(`${r.profile_id}:${r.sender_profile_id}`, r.seen_through_seq)

    // (5) In-memory aggregation.
    for (const profileId of uniqueProfileIds) {
      const threadThreshold = threadThresholdByProfile.get(profileId)
      const topicThreshold = topicThresholdByProfile.get(profileId) ?? 0
      const excludedSenders = excludedSenderProfileIdsByViewer.get(profileId)
      let unreadCount = 0
      for (const row of rows) {
        const senderSeenThreshold = senderSeenThresholdByProfileAndSender.get(`${profileId}:${row.sender_profile_id}`) ?? 0
        if (isUnreadForViewer(row, profileId, threadThreshold, topicThreshold, senderSeenThreshold, excludedSenders)) {
          unreadCount++
        }
      }
      counts.set(profileId, unreadCount)
    }

    return counts
  }

  function getUnreadCountForTopicForProfiles(
    topicId: string,
    profileIds: readonly string[],
    excludedSenderProfileIdsByViewer: ReadonlyMap<string, ReadonlySet<string>>,
  ): Map<string, number> {
    const uniqueProfileIds = [...new Set(profileIds)]
    const counts = new Map<string, number>(uniqueProfileIds.map((id) => [id, 0]))
    if (uniqueProfileIds.length === 0) return counts

    const liveTopic = selectLiveTopicStatement.get(topicId) as { found: number } | undefined
    if (liveTopic === undefined) return counts

    // (1) Всички live съобщения в темата — ЕДНА заявка, index range SEARCH
    // по topic_id (mirror на getUnreadCountsByTopicIds-овия single-topic
    // filter, но за само 1 topicId вместо IN-clause по няколко теми — тук
    // batch измерението е по profile, не по topic).
    const rows = database.prepare(`
      SELECT message_id, parent_message_id, sender_profile_id, seq
      FROM topic_messages
      WHERE topic_id = ? AND deleted_at IS NULL;
    `).all(topicId) as ThreadRow[]
    if (rows.length === 0) return counts

    const profilePlaceholders = placeholders(uniqueProfileIds.length)

    // (2) topic_read_state за целия profile batch — non-general topics нямат
    // thread-level read state (само "Общи" ползва topic_thread_read_state
    // per-thread granularity), затова единственият threshold тук е topic-level.
    const topicReadRows = database.prepare(`
      SELECT profile_id, last_seen_seq FROM topic_read_state
      WHERE topic_id = ? AND profile_id IN (${profilePlaceholders});
    `).all(topicId, ...uniqueProfileIds) as Array<{ profile_id: string; last_seen_seq: number }>
    const topicThresholdByProfile = new Map(topicReadRows.map((r) => [r.profile_id, r.last_seen_seq]))

    // (3) topic_sender_seen_state за целия profile batch.
    const senderSeenRows = database.prepare(`
      SELECT profile_id, sender_profile_id, seen_through_seq FROM topic_sender_seen_state
      WHERE topic_id = ? AND profile_id IN (${profilePlaceholders});
    `).all(topicId, ...uniqueProfileIds) as Array<{ profile_id: string; sender_profile_id: string; seen_through_seq: number }>
    const senderSeenThresholdByProfileAndSender = new Map<string, number>()
    for (const r of senderSeenRows) senderSeenThresholdByProfileAndSender.set(`${r.profile_id}:${r.sender_profile_id}`, r.seen_through_seq)

    // (4) In-memory aggregation (без thread-level threshold — non-general
    // topics нямат го, mirror на getUnreadCountsByTopicIds семантиката).
    for (const profileId of uniqueProfileIds) {
      const topicThreshold = topicThresholdByProfile.get(profileId) ?? 0
      const excludedSenders = excludedSenderProfileIdsByViewer.get(profileId)
      let unreadCount = 0
      for (const row of rows) {
        const senderSeenThreshold = senderSeenThresholdByProfileAndSender.get(`${profileId}:${row.sender_profile_id}`) ?? 0
        if (isUnreadForViewer(row, profileId, undefined, topicThreshold, senderSeenThreshold, excludedSenders)) {
          unreadCount++
        }
      }
      counts.set(profileId, unreadCount)
    }

    return counts
  }

  function close(): void {
    database.close()
  }

  return {
    ensureReadStateForTopics,
    markTopicSeenToLatestSeq,
    markTopicSeenThroughSeq,
    markThreadSeenToLatestSeq,
    markSenderSeenThroughCurrent,
    getReadState,
    getThreadReadState,
    getUnreadCountsByTopicIds,
    getUnreadCountsByRootMessageIds,
    getGeneralThreadUnreadTotal,
    getGeneralThreadUnreadTotalsForProfiles,
    getThreadUnreadCountsForProfiles,
    getUnreadCountForTopicForProfiles,
    getLatestSeqForTopic,
    close,
  }
}
