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

  function getGeneralThreadUnreadTotal(
    profileId: string,
    topicId: string,
    excludedSenderProfileIds: readonly string[] = [],
  ): number {
    const statement = database.prepare(`
      SELECT COALESCE(SUM(unread_count), 0) as unread_count
      FROM (
        ${buildThreadUnreadQuery('root.topic_id = ?', excludedSenderProfileIds).replace(/;\s*$/, '')}
      ) thread_counts;
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
    getLatestSeqForTopic,
    close,
  }
}
