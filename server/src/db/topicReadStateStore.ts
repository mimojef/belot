type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TopicReadStateSnapshot = {
  profileId: string
  topicId: string
  lastSeenSeq: number
  updatedAt: string
}

type TopicReadStateRow = {
  profile_id: string
  topic_id: string
  last_seen_seq: number
  updated_at: string
}

export type TopicReadStateStore = {
  ensureReadStateForTopics: (profileId: string, topicIds: readonly string[]) => void
  markTopicSeenToLatestSeq: (profileId: string, topicId: string) => { ok: true; state: TopicReadStateSnapshot } | { ok: false; code: 'not_found' }
  markTopicSeenThroughSeq: (profileId: string, topicId: string, seenSeq: number) => { ok: true; state: TopicReadStateSnapshot } | { ok: false; code: 'not_found' }
  markSenderSeenThroughCurrent: (profileId: string, senderProfileId: string) => void
  getReadState: (profileId: string, topicId: string) => TopicReadStateSnapshot | null
  getUnreadCountsByTopicIds: (
    profileId: string,
    topicIds: readonly string[],
    excludedSenderProfileIds?: readonly string[],
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

  function close(): void {
    database.close()
  }

  return {
    ensureReadStateForTopics,
    markTopicSeenToLatestSeq,
    markTopicSeenThroughSeq,
    markSenderSeenThroughCurrent,
    getReadState,
    getUnreadCountsByTopicIds,
    getLatestSeqForTopic,
    close,
  }
}
