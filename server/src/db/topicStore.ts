import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TopicStatus = 'active' | 'locked' | 'removed'

export type TopicSnapshot = {
  topicId: string
  slug: string
  title: string
  description: string | null
  isGeneral: boolean
  createdByProfileId: string | null
  status: TopicStatus
  sortOrder: number
  createdAt: string
}

export type TopicStore = {
  listActiveTopics: () => TopicSnapshot[]
  getTopicById: (topicId: string) => TopicSnapshot | null
  getGeneralTopic: () => TopicSnapshot | null
  close: () => void
}

type TopicRow = {
  topic_id: string
  slug: string
  title: string
  description: string | null
  is_general: number
  created_by_profile_id: string | null
  status: TopicStatus
  sort_order: number
  created_at: string
}

function toSnapshot(row: TopicRow): TopicSnapshot {
  return {
    topicId: row.topic_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    isGeneral: row.is_general === 1,
    createdByProfileId: row.created_by_profile_id,
    status: row.status,
    sortOrder: row.sort_order,
    createdAt: dbDateToUtc(row.created_at),
  }
}

export async function createTopicStore(databaseFilePath: string): Promise<TopicStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectActiveTopicsStatement = database.prepare(`
    SELECT topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order, created_at
    FROM topics
    WHERE status = 'active'
    ORDER BY sort_order ASC, created_at ASC;
  `)

  const selectByIdStatement = database.prepare(`
    SELECT topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order, created_at
    FROM topics
    WHERE topic_id = ?
    LIMIT 1;
  `)

  const selectGeneralStatement = database.prepare(`
    SELECT topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order, created_at
    FROM topics
    WHERE is_general = 1
    LIMIT 1;
  `)

  function listActiveTopics(): TopicSnapshot[] {
    const rows = selectActiveTopicsStatement.all() as TopicRow[]
    return rows.map(toSnapshot)
  }

  function getTopicById(topicId: string): TopicSnapshot | null {
    const row = selectByIdStatement.get(topicId) as TopicRow | undefined
    return row ? toSnapshot(row) : null
  }

  function getGeneralTopic(): TopicSnapshot | null {
    const row = selectGeneralStatement.get() as TopicRow | undefined
    return row ? toSnapshot(row) : null
  }

  function close(): void {
    database.close()
  }

  return {
    listActiveTopics,
    getTopicById,
    getGeneralTopic,
    close,
  }
}
