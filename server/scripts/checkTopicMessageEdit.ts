import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicMessageStore, type TopicMessageStore } from '../src/db/topicMessageStore.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-message-edit-check-'))
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
  const dbPath = join(dir, 'topics-edit.sqlite')
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
  for (const profileId of ['author-1', 'author-2', 'author-3']) {
    db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run(profileId, profileId)
  }
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order)
    VALUES ('topic-a', 'topic-a', 'Topic A', 0, NULL, 'active', 100);
  `).run()
  db.close()
  return dbPath
}

function insertReplyOk(store: TopicMessageStore, input: Parameters<TopicMessageStore['insertReply']>[0]) {
  const result = store.insertReply(input)
  if (!result.ok) throw new Error('unexpected parent_not_found')
  return result.message
}

function countRows(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    return (db.prepare(`SELECT COUNT(*) as cnt FROM ${table};`).get() as { cnt: number }).cnt
  } finally {
    db.close()
  }
}

console.log('\n=== Topic Message Edit (store-level) ===\n')

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir)
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a',
      senderProfileId: 'author-1',
      senderDisplayName: 'Author 1',
      senderRole: 'player',
      body: 'original root',
    })

    await check('[1] owner edits own root within 15 minutes', () => {
      const result = store.editOwnMessage({
        topicId: 'topic-a',
        messageId: root.messageId,
        ownerProfileId: 'author-1',
        body: 'edited root',
        now: new Date(Date.parse(root.createdAt) + 14 * 60 * 1000),
      })
      assert(result.ok, 'edit should succeed')
      if (result.ok) {
        assert(result.changed, 'edit should be marked changed')
        assertEqual(result.message.body, 'edited root', 'body')
        assert(result.message.editedAt !== null, 'editedAt should be set')
      }
    })

    await check('[2] no-op edit succeeds without a new event', () => {
      const before = countRows(dbPath, 'topic_message_edit_events')
      const current = store.getMessageById(root.messageId)
      assert(current !== null, 'root should exist')
      const result = store.editOwnMessage({
        topicId: 'topic-a',
        messageId: root.messageId,
        ownerProfileId: 'author-1',
        body: current!.body,
        now: new Date(Date.parse(root.createdAt) + 14 * 60 * 1000),
      })
      const after = countRows(dbPath, 'topic_message_edit_events')
      assert(result.ok, 'no-op should succeed')
      if (result.ok) assert(!result.changed, 'no-op should not be changed')
      assertEqual(after, before, 'edit event count')
    })

    await check('[3] non-owner edit is not_found at store level', () => {
      const result = store.editOwnMessage({
        topicId: 'topic-a',
        messageId: root.messageId,
        ownerProfileId: 'author-2',
        body: 'stolen',
        now: new Date(Date.parse(root.createdAt) + 14 * 60 * 1000),
      })
      assert(!result.ok, 'non-owner edit should fail')
      if (!result.ok) assertEqual(result.code, 'not_found', 'code')
    })

    const rootWithReply = store.insertMessage({
      topicId: 'topic-a',
      senderProfileId: 'author-1',
      senderDisplayName: 'Author 1',
      senderRole: 'player',
      body: 'root with reply',
    })
    insertReplyOk(store, {
      topicId: 'topic-a',
      parentMessageId: rootWithReply.messageId,
      senderProfileId: 'author-2',
      senderDisplayName: 'Author 2',
      senderRole: 'player',
      body: 'live reply',
    })

    await check('[4] own root with live replies is rejected', () => {
      const result = store.editOwnMessage({
        topicId: 'topic-a',
        messageId: rootWithReply.messageId,
        ownerProfileId: 'author-1',
        body: 'blocked',
        now: new Date(Date.parse(rootWithReply.createdAt) + 14 * 60 * 1000),
      })
      assert(!result.ok, 'root edit should fail')
      if (!result.ok) assertEqual(result.code, 'has_live_replies', 'code')
    })

    const reply = insertReplyOk(store, {
      topicId: 'topic-a',
      parentMessageId: root.messageId,
      senderProfileId: 'author-2',
      senderDisplayName: 'Author 2',
      senderRole: 'player',
      body: 'original reply',
    })

    await check('[5] owner edits own reply without child guard', () => {
      const result = store.editOwnMessage({
        topicId: 'topic-a',
        messageId: reply.messageId,
        ownerProfileId: 'author-2',
        body: 'edited reply',
        now: new Date(Date.parse(reply.createdAt) + 14 * 60 * 1000),
      })
      assert(result.ok, 'reply edit should succeed')
      if (result.ok) {
        assert(result.changed, 'reply edit should be changed')
        assertEqual(result.message.body, 'edited reply', 'reply body')
      }
    })

    await check('[6] edit expires exactly at 15 minutes', () => {
      const fresh = store.insertMessage({
        topicId: 'topic-a',
        senderProfileId: 'author-1',
        senderDisplayName: 'Author 1',
        senderRole: 'player',
        body: 'fresh',
      })
      const result = store.editOwnMessage({
        topicId: 'topic-a',
        messageId: fresh.messageId,
        ownerProfileId: 'author-1',
        body: 'too late',
        now: new Date(Date.parse(fresh.createdAt) + 15 * 60 * 1000),
      })
      assert(!result.ok, 'expired edit should fail')
      if (!result.ok) assertEqual(result.code, 'edit_window_expired', 'code')
    })

    await check('[7] empty text remains invalid without attachment', () => {
      const fresh = store.insertMessage({
        topicId: 'topic-a',
        senderProfileId: 'author-1',
        senderDisplayName: 'Author 1',
        senderRole: 'player',
        body: 'text',
      })
      const result = store.editOwnMessage({
        topicId: 'topic-a',
        messageId: fresh.messageId,
        ownerProfileId: 'author-1',
        body: '   ',
        now: new Date(Date.parse(fresh.createdAt) + 14 * 60 * 1000),
      })
      assert(!result.ok, 'empty edit should fail')
      if (!result.ok) assertEqual(result.code, 'empty_body', 'code')
    })

    await check('[8] image-only message can edit to empty caption', () => {
      const withImage = store.insertMessage({
        topicId: 'topic-a',
        senderProfileId: 'author-1',
        senderDisplayName: 'Author 1',
        senderRole: 'player',
        body: 'caption',
        attachment: {
          storageFilename: '11111111-1111-4111-8111-111111111111.webp',
          width: 100,
          height: 100,
          byteSize: 1000,
          contentType: 'image/webp',
        },
      })
      const result = store.editOwnMessage({
        topicId: 'topic-a',
        messageId: withImage.messageId,
        ownerProfileId: 'author-1',
        body: '   ',
        now: new Date(Date.parse(withImage.createdAt) + 14 * 60 * 1000),
      })
      assert(result.ok, 'caption removal should succeed')
      if (result.ok) assertEqual(result.message.body, '', 'caption')
    })

    await check('[9] edit events cascade away when hard-purged message is deleted', () => {
      const doomed = store.insertMessage({
        topicId: 'topic-a',
        senderProfileId: 'author-3',
        senderDisplayName: 'Author 3',
        senderRole: 'player',
        body: 'doomed',
      })
      const result = store.editOwnMessage({
        topicId: 'topic-a',
        messageId: doomed.messageId,
        ownerProfileId: 'author-3',
        body: 'doomed edited',
        now: new Date(Date.parse(doomed.createdAt) + 14 * 60 * 1000),
      })
      assert(result.ok, 'setup edit should succeed')
      const db = new DatabaseSync(dbPath, { open: true })
      try {
        db.prepare(`DELETE FROM topic_messages WHERE message_id = ?;`).run(doomed.messageId)
        const remaining = (db.prepare(`SELECT COUNT(*) as cnt FROM topic_message_edit_events WHERE message_id = ?;`).get(doomed.messageId) as { cnt: number }).cnt
        assertEqual(remaining, 0, 'remaining edit events')
      } finally {
        db.close()
      }
    })
  } finally {
    store.close()
  }
})

console.log(`\nTopic message edit store checks: ${passed} passed, ${failed} failed.`)
if (failed > 0) process.exitCode = 1
