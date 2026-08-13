import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicReadStateStore, type TopicReadStateStore } from '../src/db/topicReadStateStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationPaths = [
  '20260810_002_create_topics_and_messages.sql',
  '20260811_001_create_topic_message_likes.sql',
  '20260811_002_create_topic_message_attachments.sql',
  '20260811_003_create_topic_moderation.sql',
  '20260812_001_create_topic_message_moderation.sql',
  '20260812_002_create_topic_message_self_deletion_audit.sql',
  '20260812_003_add_topic_message_editing.sql',
  '20260812_004_create_topic_read_state.sql',
  '20260813_001_create_topic_thread_read_state.sql',
].map((name) => resolve(serverRoot, 'database/migrations', name))

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-unread-seen-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function applyMigrationFile(db: DatabaseSync, migrationPath: string): Promise<void> {
  const sql = await readFile(migrationPath, 'utf8')
  db.exec('BEGIN;')
  try {
    db.exec(sql)
    db.exec('COMMIT;')
  } catch (error) {
    db.exec('ROLLBACK;')
    throw error
  }
}

async function setupDb(dir: string): Promise<string> {
  const dbPath = join(dir, 'topics-unread-seen.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      is_temporary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY);`)
  for (const migrationPath of migrationPaths) {
    await applyMigrationFile(db, migrationPath)
  }
  for (const profileId of ['viewer-1', 'alice-1', 'bob-1']) {
    db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run(profileId, profileId)
  }
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order)
    VALUES
      ('topic-a', 'topic-a', 'Topic A', 0, NULL, 'active', 10),
      ('topic-thread', 'topic-thread', 'Topic Thread', 1, NULL, 'active', 15),
      ('topic-locked', 'topic-locked', 'Topic Locked', 0, NULL, 'locked', 20),
      ('topic-removed', 'topic-removed', 'Topic Removed', 0, NULL, 'removed', 30);
  `).run()
  db.close()
  return dbPath
}

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function insertMessage(dbPath: string, input: {
  topicId: string
  senderProfileId: string
  body: string
  parentMessageId?: string | null
  deleted?: boolean
}): { messageId: string; seq: number } {
  return withDb(dbPath, (db) => {
    const messageId = `${input.topicId}-${input.senderProfileId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    db.prepare(`
      INSERT INTO topic_messages (
        message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role,
        body, created_at, deleted_at
      )
      VALUES (?, ?, ?, ?, ?, 'player', ?, datetime('now'), ?);
    `).run(
      messageId,
      input.topicId,
      input.parentMessageId ?? null,
      input.senderProfileId,
      input.senderProfileId,
      input.body,
      input.deleted ? new Date().toISOString() : null,
    )
    const row = db.prepare(`SELECT seq FROM topic_messages WHERE message_id = ?`).get(messageId) as { seq: number }
    return { messageId, seq: row.seq }
  })
}

function unreadCount(store: TopicReadStateStore, profileId: string, topicId: string, blocked: string[] = []): number {
  return store.getUnreadCountsByTopicIds(profileId, [topicId], blocked).get(topicId) ?? 0
}

function threadUnreadCount(store: TopicReadStateStore, profileId: string, rootMessageId: string, blocked: string[] = []): number {
  return store.getUnreadCountsByRootMessageIds(profileId, [rootMessageId], blocked).get(rootMessageId) ?? 0
}

function generalThreadUnreadTotal(store: TopicReadStateStore, profileId: string, topicId: string, blocked: string[] = []): number {
  return store.getGeneralThreadUnreadTotal(profileId, topicId, blocked)
}

function softDeleteMessage(dbPath: string, messageId: string): void {
  withDb(dbPath, (db) => {
    db.prepare(`UPDATE topic_messages SET deleted_at = CURRENT_TIMESTAMP WHERE message_id = ?`).run(messageId)
  })
}

console.log('\n=== Topic Unread / Seen (store-level) ===\n')

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir)
  const store = await createTopicReadStateStore(dbPath)
  try {
    insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'alice-1', body: 'old root' })
    insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'bob-1', body: 'old reply' })

    await check('[1] first directory visit initializes read state to current boundary', () => {
      store.ensureReadStateForTopics('viewer-1', ['topic-a'])
      assertEqual(unreadCount(store, 'viewer-1', 'topic-a'), 0, 'unread after initialization')
      const state = store.getReadState('viewer-1', 'topic-a')
      assert(state !== null && state.lastSeenSeq >= 2, 'read state should be initialized to latest seq')
    })

    await check('[2] new roots and replies after initialization count as unread', () => {
      insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'alice-1', body: 'new root' })
      const root = insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'bob-1', body: 'parent' })
      insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'alice-1', parentMessageId: root.messageId, body: 'new reply' })
      assertEqual(unreadCount(store, 'viewer-1', 'topic-a'), 3, 'unread count')
    })

    await check('[3] own and deleted messages are excluded from unread', () => {
      insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'viewer-1', body: 'own message' })
      insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'alice-1', body: 'deleted message', deleted: true })
      assertEqual(unreadCount(store, 'viewer-1', 'topic-a'), 3, 'unread count')
    })

    await check('[4] mark topic seen advances to latest seq and clears unread', () => {
      const result = store.markTopicSeenToLatestSeq('viewer-1', 'topic-a')
      assert(result.ok, 'mark seen should succeed')
      assertEqual(unreadCount(store, 'viewer-1', 'topic-a'), 0, 'unread after mark seen')
    })

    await check('[5] locked topics are readable but removed topics are not initialized', () => {
      insertMessage(dbPath, { topicId: 'topic-locked', senderProfileId: 'alice-1', body: 'locked old' })
      store.ensureReadStateForTopics('viewer-1', ['topic-locked', 'topic-removed'])
      assert(store.getReadState('viewer-1', 'topic-locked') !== null, 'locked topic should get read state')
      assertEqual(store.getReadState('viewer-1', 'topic-removed'), null, 'removed topic read state')
    })

    await check('[6] blocked sender exclusion is temporary and sender boundary protects unblock', () => {
      store.markTopicSeenToLatestSeq('viewer-1', 'topic-a')
      insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'alice-1', body: 'alice unread' })
      insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'bob-1', body: 'bob blocked unread' })
      assertEqual(unreadCount(store, 'viewer-1', 'topic-a', ['bob-1']), 1, 'unread while bob is blocked')
      store.markSenderSeenThroughCurrent('viewer-1', 'bob-1')
      assertEqual(unreadCount(store, 'viewer-1', 'topic-a'), 1, 'unread after bob unblock boundary')
      insertMessage(dbPath, { topicId: 'topic-a', senderProfileId: 'bob-1', body: 'bob after unblock' })
      assertEqual(unreadCount(store, 'viewer-1', 'topic-a'), 2, 'unread after new bob message')
    })

    await check('[7] thread unread is per root and opening one thread does not clear siblings', () => {
      const rootA = insertMessage(dbPath, { topicId: 'topic-thread', senderProfileId: 'alice-1', body: 'thread A' })
      const rootB = insertMessage(dbPath, { topicId: 'topic-thread', senderProfileId: 'alice-1', body: 'thread B' })
      insertMessage(dbPath, { topicId: 'topic-thread', senderProfileId: 'alice-1', parentMessageId: rootA.messageId, body: 'A historical reply' })
      insertMessage(dbPath, { topicId: 'topic-thread', senderProfileId: 'bob-1', parentMessageId: rootB.messageId, body: 'B historical reply' })
      store.ensureReadStateForTopics('viewer-1', ['topic-thread'])

      assertEqual(threadUnreadCount(store, 'viewer-1', rootA.messageId), 0, 'historical Thread A unread uses topic baseline')
      assertEqual(threadUnreadCount(store, 'viewer-1', rootB.messageId), 0, 'historical Thread B unread uses topic baseline')
      assertEqual(generalThreadUnreadTotal(store, 'viewer-1', 'topic-thread'), 0, 'historical General aggregate uses topic baseline')

      insertMessage(dbPath, { topicId: 'topic-thread', senderProfileId: 'alice-1', parentMessageId: rootA.messageId, body: 'A first post-rollout reply' })
      assertEqual(threadUnreadCount(store, 'viewer-1', rootA.messageId), 1, 'Thread A increments after post-rollout reply')
      assertEqual(generalThreadUnreadTotal(store, 'viewer-1', 'topic-thread'), 1, 'General increments after post-rollout reply')

      const initialSeenA = store.markThreadSeenToLatestSeq('viewer-1', rootA.messageId)
      assert(initialSeenA.ok, 'mark initial Thread A seen')
      assertEqual(threadUnreadCount(store, 'viewer-1', rootA.messageId), 0, 'Thread A clears after exact open')
      assertEqual(generalThreadUnreadTotal(store, 'viewer-1', 'topic-thread'), 0, 'General clears after exact Thread A open')

      for (let i = 0; i < 36; i++) {
        insertMessage(dbPath, { topicId: 'topic-thread', senderProfileId: 'alice-1', parentMessageId: rootA.messageId, body: `A reply ${i}` })
      }
      for (let i = 0; i < 4; i++) {
        insertMessage(dbPath, { topicId: 'topic-thread', senderProfileId: 'bob-1', parentMessageId: rootB.messageId, body: `B reply ${i}` })
      }

      assertEqual(threadUnreadCount(store, 'viewer-1', rootA.messageId), 36, 'Thread A unread')
      assertEqual(threadUnreadCount(store, 'viewer-1', rootB.messageId), 4, 'Thread B unread')
      assertEqual(generalThreadUnreadTotal(store, 'viewer-1', 'topic-thread'), 40, 'General aggregate before open')

      store.ensureReadStateForTopics('viewer-1', ['topic-thread'])
      assertEqual(generalThreadUnreadTotal(store, 'viewer-1', 'topic-thread'), 40, 'Open General does not clear thread unread')

      const seenA = store.markThreadSeenToLatestSeq('viewer-1', rootA.messageId)
      assert(seenA.ok, 'mark thread A seen')
      assertEqual(threadUnreadCount(store, 'viewer-1', rootA.messageId), 0, 'Thread A after open')
      assertEqual(threadUnreadCount(store, 'viewer-1', rootB.messageId), 4, 'Thread B after opening A')
      assertEqual(generalThreadUnreadTotal(store, 'viewer-1', 'topic-thread'), 4, 'General aggregate after opening A')

      const unreadB = insertMessage(dbPath, { topicId: 'topic-thread', senderProfileId: 'bob-1', parentMessageId: rootB.messageId, body: 'B new reply' })
      assertEqual(threadUnreadCount(store, 'viewer-1', rootB.messageId), 5, 'Thread B increments after new reply')
      assertEqual(generalThreadUnreadTotal(store, 'viewer-1', 'topic-thread'), 5, 'General increments after B reply')

      insertMessage(dbPath, { topicId: 'topic-thread', senderProfileId: 'viewer-1', parentMessageId: rootB.messageId, body: 'own reply' })
      assertEqual(threadUnreadCount(store, 'viewer-1', rootB.messageId), 5, 'own reply excluded')
      assertEqual(threadUnreadCount(store, 'viewer-1', rootB.messageId, ['bob-1']), 0, 'blocked sender replies excluded')

      softDeleteMessage(dbPath, unreadB.messageId)
      assertEqual(threadUnreadCount(store, 'viewer-1', rootB.messageId), 4, 'deleted unread reply removed')

      softDeleteMessage(dbPath, rootB.messageId)
      assertEqual(threadUnreadCount(store, 'viewer-1', rootB.messageId), 0, 'deleted root removes thread contribution')
      assertEqual(generalThreadUnreadTotal(store, 'viewer-1', 'topic-thread'), 0, 'General removes deleted root contribution')
    })
  } finally {
    store.close()
  }
})

if (failed > 0) {
  console.error(`\nTopic unread/seen store checks failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`\nTopic unread/seen store checks passed: ${passed} checks.\n`)
