/**
 * checkTopicMessageSelfDelete.ts
 *
 * Author self-delete на СОБСТВЕНО root съобщение/reply в Topics (различно от
 * moderator delete, viж checkTopicMessageModeration.ts). Store-level:
 * директен topicMessageStore.deleteOwnMessage() достъп, изолирана temp
 * SQLite база, без spawn-нат сървър. Auth/HTTP/realtime покрити от
 * checkTopicMessageSelfDeleteAuthRealtime.ts (отделен файл, spawn-нат сървър).
 *
 * === OWNERSHIP (store-level) ===
 * [1]  owner deletes own root with 0 replies → success
 * [2]  owner deletes own reply → success
 * [3]  non-owner delete опит → not_found (store-level ownership re-check)
 *
 * === ROOT WITH REPLIES ===
 * [10] ordinary owner root + 1 live reply → has_live_replies
 * [11] root remains live след denied опит
 * [12] reply remains live след denied опит
 * [13] no attachment mutation след denied опит
 * [14] no deletion event след denied опит
 * [15] no self-delete audit след denied опит
 * [16] no cleanup job след denied опит
 *
 * === REPLY ===
 * [20] own reply delete affects only reply
 * [21] root remains
 * [22] sibling remains
 * [23] replyCount decreases
 *
 * === ATTACHMENTS ===
 * [24] own root attachment reference removed immediately
 * [25] own reply attachment reference removed immediately
 * [26] physical cleanup job inserted
 * [27] download denied after commit
 * [28] other attachments untouched
 * [29] rollback atomicity (race-sabotage trigger)
 *
 * === SELF-DELETE AUDIT ===
 * [30] self-delete audit row inserted (topic_message_self_deletion_audit_log)
 * [31] audit НЕ е в moderator таблицата (topic_message_deletion_audit_log)
 * [32] audit съдържа коректен parent_message_id snapshot (root=null, reply=rootId)
 *
 * === RETENTION ===
 * [40] self-deleted body remains in DB before 180 days
 * [41] invisible to normal read paths (getRecentMessages)
 * [42] 179 days → not purged
 * [43] exactly 180 days → purged
 * [44] > 180 days → purged
 * [45] self-delete audit survives until purge
 * [46] self-delete audit CASCADE-disappears at purge
 * [47] removed-topic exclusion remains (reuse на established guard)
 *
 * === LIKES ===
 * [50] likes hidden immediately after delete
 * [51] likes CASCADE away at hard purge
 *
 * === RACES ===
 * [60] reply insert vs own-root delete cannot produce deleted root with live newly-created reply
 * [61] duplicate own-delete is idempotent (no duplicate audit/event)
 * [62] own delete vs moderator delete race — established already_deleted semantics preserved
 * [63] moderator delete vs own delete race — exactly one audit/event/attachment cleanup
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicMessageStore, type TopicMessageStore } from '../src/db/topicMessageStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const topicsMigrationPath = resolve(serverRoot, 'database/migrations/20260810_002_create_topics_and_messages.sql')
const likesMigrationPath = resolve(serverRoot, 'database/migrations/20260811_001_create_topic_message_likes.sql')
const attachmentsMigrationPath = resolve(serverRoot, 'database/migrations/20260811_002_create_topic_message_attachments.sql')
const moderationMigrationPath = resolve(serverRoot, 'database/migrations/20260811_003_create_topic_moderation.sql')
const messageModerationMigrationPath = resolve(serverRoot, 'database/migrations/20260812_001_create_topic_message_moderation.sql')
const selfDeletionAuditMigrationPath = resolve(serverRoot, 'database/migrations/20260812_002_create_topic_message_self_deletion_audit.sql')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-message-self-delete-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function buildBaseSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY
    );
  `)
}

async function applyMigrationFile(db: DatabaseSync, migrationPath: string): Promise<void> {
  const sql = await readFile(migrationPath, 'utf8')
  db.exec('BEGIN;')
  try {
    db.exec(sql)
    db.exec('COMMIT;')
  } catch (err) {
    db.exec('ROLLBACK;')
    throw err
  }
}

function seedProfile(db: DatabaseSync, profileId: string): void {
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run(profileId, profileId)
}

function insertTopic(db: DatabaseSync, input: { topicId: string; slug: string; title: string }): void {
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order)
    VALUES (?, ?, ?, 0, NULL, 'active', 100);
  `).run(input.topicId, input.slug, input.title)
}

function makeAttachment(filename: string) {
  return { storageFilename: filename, width: 100, height: 100, byteSize: 500, contentType: 'image/webp' }
}

function daysAgoSqliteString(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

async function setupDb(dir: string, filename: string): Promise<string> {
  const dbPath = join(dir, filename)
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)
  await applyMigrationFile(db, moderationMigrationPath)
  await applyMigrationFile(db, messageModerationMigrationPath)
  await applyMigrationFile(db, selfDeletionAuditMigrationPath)
  seedProfile(db, 'author-1')
  seedProfile(db, 'author-2')
  seedProfile(db, 'author-3')
  seedAccount(db, 'mod-1')
  insertTopic(db, { topicId: 'topic-a', slug: 'topic-a', title: 'Тема A' })
  insertTopic(db, { topicId: 'topic-b', slug: 'topic-b', title: 'Тема Б' })
  db.close()
  return dbPath
}

function seedAccount(db: DatabaseSync, accountId: string): void {
  db.prepare(`INSERT INTO accounts (account_id) VALUES (?)`).run(accountId)
}

function insertReplyOk(store: TopicMessageStore, input: Parameters<TopicMessageStore['insertReply']>[0]) {
  const result = store.insertReply(input)
  if (!result.ok) throw new Error('unexpected parent_not_found in test setup')
  return result.message
}

console.log('\n=== Topic Message Self-Delete (store-level) ===\n')

// ─── [1]-[3] Ownership ───────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'ownership.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'own root, no replies',
    })

    await check('[1] Owner deletes own root with 0 replies → success', () => {
      const result = store.deleteOwnMessage({ topicId: 'topic-a', messageId: root.messageId, ownerProfileId: 'author-1' })
      assert(result.ok === true, 'delete трябва да успее')
      if (result.ok) {
        assertEqual(result.deletedMessageIds.length, 1, 'само root-ът е засегнат')
        assertEqual(result.parentMessageId, null, 'root target -> parentMessageId null')
      }
    })

    const root2 = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-2', senderDisplayName: 'A2', senderRole: 'player', body: 'root2',
    })
    const reply2 = insertReplyOk(store, {
      topicId: 'topic-a', parentMessageId: root2.messageId, senderProfileId: 'author-3', senderDisplayName: 'A3', senderRole: 'player', body: 'reply to root2',
    })

    await check('[2] Owner deletes own reply → success', () => {
      const result = store.deleteOwnMessage({ topicId: 'topic-a', messageId: reply2.messageId, ownerProfileId: 'author-3' })
      assert(result.ok === true, 'delete трябва да успее')
      if (result.ok) {
        assertEqual(result.deletedMessageIds.length, 1, 'само reply-то е засегнато')
        assertEqual(result.parentMessageId, root2.messageId, 'reply target -> parentMessageId сочи към root-а')
      }
    })

    await check('[3] Non-owner delete опит → not_found (store-level ownership re-check)', () => {
      const result = store.deleteOwnMessage({ topicId: 'topic-a', messageId: root2.messageId, ownerProfileId: 'author-3' })
      assert(result.ok === false, 'delete от НЕ-автор трябва да fail-не')
      if (!result.ok) assertEqual(result.code, 'not_found', 'code трябва да е not_found (no ownership info leakage)')
    })
  } finally {
    store.close()
  }
})

// ─── [10]-[16] Root with replies — denied, no side effects ─────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'root-with-replies.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const rootImg = makeAttachment('11111111-1111-4111-8111-111111111111.webp')
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root with image', attachment: rootImg,
    })
    const reply = insertReplyOk(store, {
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'author-2', senderDisplayName: 'A2', senderRole: 'player', body: 'live reply',
    })

    await check('[10] Ordinary owner root + 1 live reply → has_live_replies', () => {
      const result = store.deleteOwnMessage({ topicId: 'topic-a', messageId: root.messageId, ownerProfileId: 'author-1' })
      assert(result.ok === false, 'delete трябва да е отхвърлен')
      if (!result.ok) assertEqual(result.code, 'has_live_replies', 'code трябва да е has_live_replies')
    })

    await check('[11] Root remains live след denied опит', () => {
      const rootRow = store.getMessageById(root.messageId)
      assert(rootRow !== null && rootRow.deletedAt === null, 'root трябва да остане live')
    })

    await check('[12] Reply remains live след denied опит', () => {
      const replyRow = store.getMessageById(reply.messageId)
      assert(replyRow !== null && replyRow.deletedAt === null, 'reply трябва да остане live')
    })

    await check('[13] No attachment mutation след denied опит', () => {
      assertEqual(store.attachmentExistsForFilename(rootImg.storageFilename), true, 'root attachment DB row трябва да остане непокътнат')
    })

    await check('[14] No deletion event след denied опит', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const count = db.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_events WHERE topic_id = 'topic-a'`).get() as { c: number }
      db.close()
      assertEqual(count.c, 0, 'не трябва да има deletion event за отхвърления опит')
    })

    await check('[15] No self-delete audit след denied опит', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const count = db.prepare(`SELECT COUNT(*) AS c FROM topic_message_self_deletion_audit_log WHERE topic_id = 'topic-a'`).get() as { c: number }
      db.close()
      assertEqual(count.c, 0, 'не трябва да има self-delete audit ред за отхвърления опит')
    })

    await check('[16] No cleanup job след denied опит', () => {
      const pending = store.listPendingAttachmentDeletions(10)
      assertEqual(pending.length, 0, 'не трябва да има queue-нат cleanup job')
    })
  } finally {
    store.close()
  }
})

// ─── [20]-[23] Standalone reply delete ──────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'reply-delete.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root',
    })
    const targetReply = insertReplyOk(store, {
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'author-2', senderDisplayName: 'A2', senderRole: 'player', body: 'target reply',
    })
    const siblingReply = insertReplyOk(store, {
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'author-3', senderDisplayName: 'A3', senderRole: 'player', body: 'sibling reply',
    })

    await check('[20] Own reply delete affects only reply', () => {
      const result = store.deleteOwnMessage({ topicId: 'topic-a', messageId: targetReply.messageId, ownerProfileId: 'author-2' })
      assert(result.ok === true, 'delete трябва да успее')
      if (result.ok) assertEqual(result.deletedMessageIds.length, 1, 'само targeted reply е засегнат')
    })

    await check('[21] Root remains', () => {
      const rootRow = store.getMessageById(root.messageId)
      assert(rootRow !== null && rootRow.deletedAt === null, 'root трябва да остане live')
    })

    await check('[22] Sibling remains', () => {
      const siblingRow = store.getMessageById(siblingReply.messageId)
      assert(siblingRow !== null && siblingRow.deletedAt === null, 'sibling reply трябва да остане live')
    })

    await check('[23] replyCount decreases', () => {
      const aggregates = store.getMessageAggregatesByIds([root.messageId], null)
      assertEqual(aggregates.get(root.messageId)?.replyCount, 1, 'replyCount трябва да е 1 (само sibling-ът остава)')
    })
  } finally {
    store.close()
  }
})

// ─── [24]-[29] Attachments ───────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'attachments.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const rootImg = makeAttachment('22222222-2222-4222-8222-222222222222.webp')
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'own root with image', attachment: rootImg,
    })
    const otherImg = makeAttachment('44444444-4444-4444-8444-444444444444.webp')
    store.insertMessage({
      topicId: 'topic-b', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'unrelated', attachment: otherImg,
    })

    await check('[24] Own root attachment reference removed immediately', () => {
      const result = store.deleteOwnMessage({ topicId: 'topic-a', messageId: root.messageId, ownerProfileId: 'author-1' })
      assert(result.ok === true, 'delete трябва да успее')
      if (result.ok) assertEqual(result.deletedAttachmentFilenames.join(','), rootImg.storageFilename, 'filename трябва да е в резултата')
      assertEqual(store.attachmentExistsForFilename(rootImg.storageFilename), false, 'root attachment DB row трябва да е hard-deleted')
    })

    await check('[26] Physical cleanup job inserted', () => {
      const pending = store.listPendingAttachmentDeletions(10).map((p) => p.storageFilename)
      assert(pending.includes(rootImg.storageFilename), 'root attachment filename трябва да е в cleanup queue-то')
    })

    await check('[27] Download denied after commit', () => {
      assertEqual(store.getAttachmentForDownload('topic-a', rootImg.storageFilename), null, 'attachment не трябва да е downloadable')
    })

    await check('[28] Other attachments untouched', () => {
      assertEqual(store.attachmentExistsForFilename(otherImg.storageFilename), true, 'unrelated attachment трябва да остане')
    })
  } finally {
    store.close()
  }
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'reply-attachment.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root',
    })
    const replyImg = makeAttachment('55555555-5555-4555-8555-555555555555.webp')
    const reply = insertReplyOk(store, {
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'author-2', senderDisplayName: 'A2', senderRole: 'player', body: 'reply with image', attachment: replyImg,
    })

    await check('[25] Own reply attachment reference removed immediately', () => {
      const result = store.deleteOwnMessage({ topicId: 'topic-a', messageId: reply.messageId, ownerProfileId: 'author-2' })
      assert(result.ok === true, 'delete трябва да успее')
      assertEqual(store.attachmentExistsForFilename(replyImg.storageFilename), false, 'reply attachment DB row трябва да е hard-deleted')
    })
  } finally {
    store.close()
  }
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'rollback-safety.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const img = makeAttachment('66666666-6666-4666-8666-666666666666.webp')
    const msg = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root with image', attachment: img,
    })

    const db = new DatabaseSync(dbPath, { open: true })
    db.exec(`
      CREATE TRIGGER sabotage_self_delete
      BEFORE UPDATE ON topic_messages
      WHEN NEW.deleted_at IS NOT NULL AND OLD.message_id = '${msg.messageId}'
      BEGIN
        SELECT RAISE(ABORT, 'sabotage: simulated failure mid-self-delete-transaction');
      END;
    `)
    db.close()

    await check('[29] Rollback atomicity (race-sabotage trigger)', () => {
      let threw = false
      try {
        store.deleteOwnMessage({ topicId: 'topic-a', messageId: msg.messageId, ownerProfileId: 'author-1' })
      } catch {
        threw = true
      }
      assert(threw, 'deleteOwnMessage трябва да пропагира грешката от saboteur trigger-а')
      assertEqual(store.attachmentExistsForFilename(img.storageFilename), true, 'attachment DB row трябва да ОСТАНЕ след rollback')
      const pending = store.listPendingAttachmentDeletions(10)
      assertEqual(pending.length, 0, 'НИКАКЪВ cleanup queue job не трябва да остане след rollback')
      const row = store.getMessageById(msg.messageId)
      assert(row !== null && row.deletedAt === null, 'съобщението трябва да остане live след rollback')
    })
  } finally {
    store.close()
  }
})

// ─── [30]-[32] Self-delete audit ────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'audit.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root',
    })
    store.deleteOwnMessage({ topicId: 'topic-a', messageId: root.messageId, ownerProfileId: 'author-1' })

    await check('[30] Self-delete audit row inserted', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const row = db.prepare(`SELECT sender_profile_id, parent_message_id FROM topic_message_self_deletion_audit_log WHERE message_id = ?`).get(root.messageId) as { sender_profile_id: string; parent_message_id: string | null } | undefined
      db.close()
      assert(row !== undefined, 'audit ред трябва да съществува')
      assertEqual(row!.sender_profile_id, 'author-1', 'sender_profile_id трябва да е author-1')
    })

    await check('[31] Audit НЕ е в moderator таблицата (topic_message_deletion_audit_log)', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const count = db.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_audit_log WHERE message_id = ?`).get(root.messageId) as { c: number }
      db.close()
      assertEqual(count.c, 0, 'self-delete НЕ трябва да insert-ва в moderator audit таблицата')
    })

    await check('[32a] Audit parent_message_id snapshot = null за root target', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const row = db.prepare(`SELECT parent_message_id FROM topic_message_self_deletion_audit_log WHERE message_id = ?`).get(root.messageId) as { parent_message_id: string | null }
      db.close()
      assertEqual(row.parent_message_id, null, 'root target -> parent_message_id null')
    })

    const root2 = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-2', senderDisplayName: 'A2', senderRole: 'player', body: 'root2',
    })
    const reply2 = insertReplyOk(store, {
      topicId: 'topic-a', parentMessageId: root2.messageId, senderProfileId: 'author-3', senderDisplayName: 'A3', senderRole: 'player', body: 'reply2',
    })
    store.deleteOwnMessage({ topicId: 'topic-a', messageId: reply2.messageId, ownerProfileId: 'author-3' })

    await check('[32b] Audit parent_message_id snapshot = rootId за reply target', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const row = db.prepare(`SELECT parent_message_id FROM topic_message_self_deletion_audit_log WHERE message_id = ?`).get(reply2.messageId) as { parent_message_id: string | null }
      db.close()
      assertEqual(row.parent_message_id, root2.messageId, 'reply target -> parent_message_id сочи към root-а')
    })
  } finally {
    store.close()
  }
})

// ─── [40]-[47] Retention ────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'retention.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const db0 = new DatabaseSync(dbPath, { open: true })
    db0.prepare(`UPDATE topics SET status = 'removed', removed_at = ? WHERE topic_id = 'topic-b'`).run(daysAgoSqliteString(200))
    db0.close()

    const msgBefore = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'recently self-deleted',
    })
    store.deleteOwnMessage({ topicId: 'topic-a', messageId: msgBefore.messageId, ownerProfileId: 'author-1' })

    await check('[40] Self-deleted body remains in DB before 180 days', () => {
      const row = store.getMessageById(msgBefore.messageId)
      assert(row !== null && row.deletedAt !== null && row.body.length > 0, 'редът трябва да остане в DB със запазено body')
    })

    await check('[41] Invisible to normal read paths (getRecentMessages)', () => {
      const page = store.getRecentMessages('topic-a', 50, [])
      assert(!page.messages.some((m) => m.messageId === msgBefore.messageId), 'self-deleted съобщението не трябва да е в normal read резултата')
    })

    const msg179 = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '179 days' })
    store.deleteOwnMessage({ topicId: 'topic-a', messageId: msg179.messageId, ownerProfileId: 'author-1' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(179), msg179.messageId)
      db2.close()
    }

    const msg180 = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '180 days' })
    store.deleteOwnMessage({ topicId: 'topic-a', messageId: msg180.messageId, ownerProfileId: 'author-1' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(180), msg180.messageId)
      db2.close()
    }

    const msg200 = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '200 days' })
    store.deleteOwnMessage({ topicId: 'topic-a', messageId: msg200.messageId, ownerProfileId: 'author-1' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(200), msg200.messageId)
      db2.close()
    }

    const msgRemovedTopic = store.insertMessage({ topicId: 'topic-b', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'in removed topic' })
    store.deleteOwnMessage({ topicId: 'topic-b', messageId: msgRemovedTopic.messageId, ownerProfileId: 'author-1' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(200), msgRemovedTopic.messageId)
      db2.close()
    }

    await check('[42] 179 days → not purged', () => {
      const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      const purged = store.purgeDeletedTopicMessagesBefore(cutoff, 100)
      assert(purged >= 2, '180/200-дневните redовете трябва да са purge-нати')
      assert(store.getMessageById(msg179.messageId) !== null, '179-дневният ред трябва да ОСТАНЕ')
    })

    await check('[43] Exactly 180 days → purged', () => {
      assertEqual(store.getMessageById(msg180.messageId), null, 'редът на точно 180 дни трябва да е purge-нат')
    })

    await check('[44] > 180 days → purged', () => {
      assertEqual(store.getMessageById(msg200.messageId), null, 'редът на 200 дни трябва да е purge-нат')
    })

    await check('[45] Self-delete audit survives until purge', () => {
      // msgBefore е recently self-deleted (не е stale), audit-ът му трябва
      // все още да съществува (все още в 180-дневния прозорец).
      const db2 = new DatabaseSync(dbPath, { open: true })
      const count = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_self_deletion_audit_log WHERE message_id = ?`).get(msgBefore.messageId) as { c: number }
      db2.close()
      assertEqual(count.c, 1, 'audit редът трябва да оцелее до purge-а')
    })

    await check('[46] Self-delete audit CASCADE-disappears at purge', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const count = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_self_deletion_audit_log WHERE message_id = ?`).get(msg200.messageId) as { c: number }
      db2.close()
      assertEqual(count.c, 0, 'audit редът трябва да е CASCADE-изчезнал заедно с purge-натото съобщение')
    })

    await check('[47] Removed-topic exclusion remains', () => {
      assert(store.getMessageById(msgRemovedTopic.messageId) !== null, 'съобщение в removed тема не трябва да е засегнато от individual purge-а')
    })
  } finally {
    store.close()
  }
})

// ─── [50]-[51] Likes ─────────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'likes.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root',
    })
    store.toggleLike(root.messageId, 'author-2')

    await check('[50] Likes hidden immediately after delete', () => {
      store.deleteOwnMessage({ topicId: 'topic-a', messageId: root.messageId, ownerProfileId: 'author-1' })
      const page = store.getRecentMessages('topic-a', 50, [])
      assert(!page.messages.some((m) => m.messageId === root.messageId), 'deleted съобщение не трябва да се появи, независимо от likes')
    })

    await check('[51] Likes CASCADE away at hard purge', () => {
      const cutoff = new Date(Date.now() + 1000)
      store.purgeDeletedTopicMessagesBefore(cutoff, 100)
      const db2 = new DatabaseSync(dbPath, { open: true })
      const count = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_likes WHERE message_id = ?`).get(root.messageId) as { c: number }
      db2.close()
      assertEqual(count.c, 0, 'likes redовете трябва да са CASCADE-изтрити след hard purge')
    })
  } finally {
    store.close()
  }
})

// ─── [60]-[62] Races ─────────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'races.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root for race test',
    })

    await check('[60] Reply insert vs own-root delete cannot produce deleted root with live newly-created reply', () => {
      // Симулира race-а: own-root delete печели транзакцията първи (0 replies
      // към момента), после опит за reply insert КЪМ ВЕЧЕ DELETED root-а.
      const deleteResult = store.deleteOwnMessage({ topicId: 'topic-a', messageId: root.messageId, ownerProfileId: 'author-1' })
      assert(deleteResult.ok === true, 'delete трябва да успее (0 replies по това време)')

      const replyAttempt = store.insertReply({
        topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'author-2', senderDisplayName: 'A2', senderRole: 'player', body: 'too-late reply',
      })
      assert(replyAttempt.ok === false, 'reply insert към вече-deleted root трябва да fail-не')
      if (!replyAttempt.ok) assertEqual(replyAttempt.code, 'parent_not_found', 'code трябва да е parent_not_found')

      const aggregates = store.getMessageAggregatesByIds([root.messageId], null)
      assertEqual(aggregates.get(root.messageId)?.replyCount, 0, 'root не трябва да получи orphan live reply')
    })

    const root2 = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root for duplicate delete test',
    })

    await check('[61] Duplicate own-delete is idempotent (no duplicate audit/event)', () => {
      const first = store.deleteOwnMessage({ topicId: 'topic-a', messageId: root2.messageId, ownerProfileId: 'author-1' })
      assert(first.ok === true, 'първи delete трябва да успее')
      const second = store.deleteOwnMessage({ topicId: 'topic-a', messageId: root2.messageId, ownerProfileId: 'author-1' })
      assert(second.ok === false, 'втори delete трябва да fail-не')
      if (!second.ok) assertEqual(second.code, 'already_deleted', 'code трябва да е already_deleted')

      const db2 = new DatabaseSync(dbPath, { open: true })
      const auditCount = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_self_deletion_audit_log WHERE message_id = ?`).get(root2.messageId) as { c: number }
      const eventCount = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_events WHERE message_id = ?`).get(root2.messageId) as { c: number }
      db2.close()
      assertEqual(auditCount.c, 1, 'audit редовете трябва да останат точно 1')
      assertEqual(eventCount.c, 1, 'event редовете трябва да останат точно 1')
    })

    const root3 = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root for own-vs-moderator race',
    })

    await check('[62] Own delete vs moderator delete race — established already_deleted semantics preserved', () => {
      // Own-delete печели първи.
      const ownResult = store.deleteOwnMessage({ topicId: 'topic-a', messageId: root3.messageId, ownerProfileId: 'author-1' })
      assert(ownResult.ok === true, 'own-delete трябва да успее')

      // Moderator delete опит СЛЕД own-delete-а вече е committed.
      const modResult = store.deleteMessage({ topicId: 'topic-a', messageId: root3.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      assert(modResult.ok === false, 'moderator delete трябва да fail-не')
      if (!modResult.ok) assertEqual(modResult.code, 'already_deleted', 'code трябва да е already_deleted (established idempotent semantics)')

      const db2 = new DatabaseSync(dbPath, { open: true })
      const modAuditCount = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_audit_log WHERE message_id = ?`).get(root3.messageId) as { c: number }
      db2.close()
      assertEqual(modAuditCount.c, 0, 'moderator audit НЕ трябва да се insert-не за race-loser опита')
    })

    const raceImg = makeAttachment('77777777-7777-4777-8777-777777777777.webp')
    const root4 = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'root for moderator-vs-own race', attachment: raceImg,
    })

    await check('[63] Moderator delete vs own delete race → exactly one audit/event/attachment cleanup', () => {
      const modResult = store.deleteMessage({ topicId: 'topic-a', messageId: root4.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      assert(modResult.ok === true, 'moderator delete трябва да успее първи')

      const ownResult = store.deleteOwnMessage({ topicId: 'topic-a', messageId: root4.messageId, ownerProfileId: 'author-1' })
      assert(ownResult.ok === false, 'own-delete race-loser трябва да fail-не')
      if (!ownResult.ok) assertEqual(ownResult.code, 'already_deleted', 'own race-loser code трябва да е already_deleted')

      const db2 = new DatabaseSync(dbPath, { open: true })
      const selfAuditCount = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_self_deletion_audit_log WHERE message_id = ?`).get(root4.messageId) as { c: number }
      const modAuditCount = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_audit_log WHERE message_id = ?`).get(root4.messageId) as { c: number }
      const eventCount = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_events WHERE message_id = ?`).get(root4.messageId) as { c: number }
      const cleanupCount = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_attachment_deletions WHERE storage_filename = ?`).get(raceImg.storageFilename) as { c: number }
      db2.close()
      assertEqual(selfAuditCount.c, 0, 'self-delete audit НЕ трябва да се insert-не за race-loser опита')
      assertEqual(modAuditCount.c, 1, 'moderator audit трябва да остане точно 1')
      assertEqual(eventCount.c, 1, 'deletion event трябва да остане точно 1')
      assertEqual(cleanupCount.c, 1, 'attachment cleanup job трябва да остане точно 1')
    })
  } finally {
    store.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)

if (failed > 0) {
  process.exitCode = 1
}
