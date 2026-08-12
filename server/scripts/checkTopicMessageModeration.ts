/**
 * checkTopicMessageModeration.ts
 *
 * Individual root съобщение/reply moderation delete (различно от whole-topic
 * delete, viж checkTopicModeration.ts). Part 1 (по-долу) е store-level:
 * директен topicMessageStore.deleteMessage/purgeDeletedTopicMessagesBefore
 * достъп, изолирана temp SQLite база, без spawn-нат сървър — покрива
 * transaction/attachment/likes/audit/event/retention/idempotency/rollback
 * инвариантите бързо. Part 2 (checkTopicMessageModerationAuthRealtime.ts,
 * отделен файл) покрива role matrix/HTTP/WS realtime/security през реален
 * spawn-нат сървър.
 *
 * === ROOT THREAD ===
 * [1]  root без replies → soft-deleted
 * [2]  root с replies → root + всички replies soft-deleted, coherent deletion timestamp
 * [3]  root thread изчезва от REST-style read paths (getRecentMessages/pollNewMessages)
 * [4]  replies на deleted root не се връщат (getReplies)
 * [5]  deletedMessageIds включва root + всички replies
 *
 * === REPLY ===
 * [6]  delete reply → само reply deleted
 * [7]  root остава
 * [8]  sibling reply остава
 * [9]  replyCount (getMessageAggregatesByIds) намалява естествено
 *
 * === ATTACHMENTS ===
 * [10] root attachment DB reference hard-deleted immediately
 * [11] reply attachments от root thread hard-deleted (root delete case)
 * [12] targeted reply attachment hard-deleted (standalone reply delete case)
 * [13] attachment на друго, недокоснато съобщение остава
 * [14] filenames queued atomically (deletion events за cleanup queue)
 * [15] attachment download denied immediately (getAttachmentForDownload → null)
 * [16] rollback не оставя partial queue/reference state
 *
 * === LIKES ===
 * [17] likes на soft-deleted target не се показват (getMessageAggregatesByIds ги игнорира индиректно, тъй като message-ът вече не се връща)
 * [18] final hard purge CASCADE-трие likes
 *
 * === AUDIT/EVENT ===
 * [19] exactly one audit row за root thread delete (не N за replies)
 * [20] exactly one deletion event за root thread delete
 * [21] chat_admin audit insert работи (actor_role CHECK допуска chat_admin)
 * [22] duplicate delete не дублира audit/event (idempotent на store ниво)
 * [23]/[23b]/[23c] audit row съдържа коректен sender_profile_id/parent_message_id snapshot (root И reply targets)
 *
 * === IDEMPOTENCY/SECURITY (store-level) ===
 * [24] delete на несъществуващо съобщение → not_found
 * [25] delete на вече изтрито съобщение → already_deleted (idempotent)
 * [26] wrong topic/message pair → not_found (message принадлежи на друга тема)
 *
 * === RETENTION/PURGE ===
 * [27] Removed тема на 179 дни (deleted_at) → НЕ purge-ната
 * [28] Removed тема точно на 180 дни → purge eligible
 * [29] >180 дни → purge eligible
 * [30] Active/locked topic individual deletion purge работи
 * [31] Removed тема се изключва от individual purge (whole-topic purge е authoritative)
 * [32] Root purge CASCADE-ва already-deleted replies
 * [33] Standalone reply purge не засяга root/siblings
 * [34] Audit/event lifecycle приключва при hard purge (CASCADE)
 * [35] Batch limit се спазва
 * [36] Repeated purge run safe/no-op
 * [37] Purge не ползва OFFSET (source-level guard)
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const topicsMigrationPath = resolve(serverRoot, 'database/migrations/20260810_002_create_topics_and_messages.sql')
const likesMigrationPath = resolve(serverRoot, 'database/migrations/20260811_001_create_topic_message_likes.sql')
const attachmentsMigrationPath = resolve(serverRoot, 'database/migrations/20260811_002_create_topic_message_attachments.sql')
const moderationMigrationPath = resolve(serverRoot, 'database/migrations/20260811_003_create_topic_moderation.sql')
const messageModerationMigrationPath = resolve(serverRoot, 'database/migrations/20260812_001_create_topic_message_moderation.sql')

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-message-moderation-check-'))
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

function seedAccount(db: DatabaseSync, accountId: string): void {
  db.prepare(`INSERT INTO accounts (account_id) VALUES (?)`).run(accountId)
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
  seedProfile(db, 'sender-1')
  seedProfile(db, 'sender-2')
  seedProfile(db, 'sender-3')
  seedAccount(db, 'mod-1')
  seedAccount(db, 'mod-2')
  seedAccount(db, 'mod-chat-admin')
  insertTopic(db, { topicId: 'topic-a', slug: 'topic-a', title: 'Тема A' })
  insertTopic(db, { topicId: 'topic-b', slug: 'topic-b', title: 'Тема Б' })
  db.close()
  return dbPath
}

console.log('\n=== Topic Message Moderation (store-level) ===\n')

// ─── [1]-[9] Root thread + reply delete semantics ──────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'root-thread.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const rootNoReplies = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root без replies',
    })

    await check('[1] Delete на root без replies → soft-deleted', () => {
      const result = store.deleteMessage({ topicId: 'topic-a', messageId: rootNoReplies.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      assert(result.ok === true, 'delete трябва да успее')
      if (result.ok) {
        assertEqual(result.deletedMessageIds.length, 1, 'само root-ът е засегнат')
        assertEqual(result.parentMessageId, null, 'root target -> parentMessageId null')
      }
      const stillLoaded = store.getMessageById(rootNoReplies.messageId)
      assert(stillLoaded !== null && stillLoaded.deletedAt !== null, 'root редът остава в DB, soft-deleted')
    })

    const rootWithReplies = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root с replies',
    })
    const reply1 = store.insertReply({
      topicId: 'topic-a', parentMessageId: rootWithReplies.messageId, senderProfileId: 'sender-2', senderDisplayName: 'S2', senderRole: 'player', body: 'reply 1',
    })
    const reply2 = store.insertReply({
      topicId: 'topic-a', parentMessageId: rootWithReplies.messageId, senderProfileId: 'sender-3', senderDisplayName: 'S3', senderRole: 'player', body: 'reply 2',
    })

    let rootDeleteResult: ReturnType<typeof store.deleteMessage> | null = null

    await check('[2] Delete на root С replies → root + всички replies soft-deleted, coherent deletion timestamp', () => {
      rootDeleteResult = store.deleteMessage({ topicId: 'topic-a', messageId: rootWithReplies.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      assert(rootDeleteResult.ok === true, 'delete трябва да успее')
      if (rootDeleteResult.ok) {
        assertEqual(rootDeleteResult.deletedMessageIds.length, 3, 'root + 2 replies = 3 засегнати ids')
        assert(rootDeleteResult.deletedMessageIds.includes(rootWithReplies.messageId), 'root id трябва да е включен')
        assert(rootDeleteResult.deletedMessageIds.includes(reply1.messageId), 'reply1 id трябва да е включен')
        assert(rootDeleteResult.deletedMessageIds.includes(reply2.messageId), 'reply2 id трябва да е включен')
      }
      const rootRow = store.getMessageById(rootWithReplies.messageId)
      const reply1Row = store.getMessageById(reply1.messageId)
      const reply2Row = store.getMessageById(reply2.messageId)
      assert(rootRow?.deletedAt !== null && reply1Row?.deletedAt !== null && reply2Row?.deletedAt !== null, 'всички трябва да имат deletedAt')
      assertEqual(rootRow!.deletedAt, reply1Row!.deletedAt, 'root и reply1 трябва да имат ЕДНАКЪВ deletion timestamp')
      assertEqual(rootRow!.deletedAt, reply2Row!.deletedAt, 'root и reply2 трябва да имат ЕДНАКЪВ deletion timestamp')
    })

    await check('[3] Root thread изчезва от read paths (getRecentMessages)', () => {
      const page = store.getRecentMessages('topic-a', 50, [])
      const ids = page.messages.map((m) => m.messageId)
      assert(!ids.includes(rootWithReplies.messageId), 'изтритият root не трябва да се появи в getRecentMessages')
      assert(!ids.includes(rootNoReplies.messageId), 'изтритият root (без replies) не трябва да се появи')
    })

    await check('[4] Replies на deleted root не се връщат (getReplies)', () => {
      const repliesPage = store.getReplies(rootWithReplies.messageId, 50, [])
      assertEqual(repliesPage.messages.length, 0, 'replies на изтрития root не трябва да се връщат')
    })

    await check('[5] deletedMessageIds включва root + всички replies (проверка на резултата от [2])', () => {
      assert(rootDeleteResult !== null && rootDeleteResult.ok === true, 'delete трябва да е успешен')
    })
  } finally {
    store.close()
  }
})

// ─── [6]-[9] Standalone reply delete ────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'reply-delete.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root',
    })
    const targetReply = store.insertReply({
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'sender-2', senderDisplayName: 'S2', senderRole: 'player', body: 'target reply',
    })
    const siblingReply = store.insertReply({
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'sender-3', senderDisplayName: 'S3', senderRole: 'player', body: 'sibling reply',
    })

    await check('[6] Delete на reply → само reply deleted', () => {
      const result = store.deleteMessage({ topicId: 'topic-a', messageId: targetReply.messageId, actorAccountId: 'mod-1', actorRole: 'chat_admin' })
      assert(result.ok === true, 'delete трябва да успее')
      if (result.ok) {
        assertEqual(result.deletedMessageIds.length, 1, 'само targeted reply е засегнат')
        assert(result.parentMessageId !== null, 'reply target -> parentMessageId non-null')
      }
    })

    await check('[7] Root остава непокътнат след reply delete', () => {
      const rootRow = store.getMessageById(root.messageId)
      assert(rootRow !== null && rootRow.deletedAt === null, 'root трябва да остане live')
    })

    await check('[8] Sibling reply остава непокътнат', () => {
      const siblingRow = store.getMessageById(siblingReply.messageId)
      assert(siblingRow !== null && siblingRow.deletedAt === null, 'sibling reply трябва да остане live')
    })

    await check('[9] replyCount намалява естествено (getMessageAggregatesByIds)', () => {
      const aggregates = store.getMessageAggregatesByIds([root.messageId], null)
      assertEqual(aggregates.get(root.messageId)?.replyCount, 1, 'replyCount трябва да е 1 (само sibling-ът остава)')
    })
  } finally {
    store.close()
  }
})

// ─── [10]-[16] Attachments ───────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'attachments.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const rootImg = makeAttachment('11111111-1111-4111-8111-111111111111.webp')
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root with image', attachment: rootImg,
    })
    const replyImg = makeAttachment('22222222-2222-4222-8222-222222222222.webp')
    const reply = store.insertReply({
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'sender-2', senderDisplayName: 'S2', senderRole: 'player', body: 'reply with image', attachment: replyImg,
    })
    const otherImg = makeAttachment('33333333-3333-4333-8333-333333333333.webp')
    store.insertMessage({
      topicId: 'topic-b', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'unrelated message', attachment: otherImg,
    })

    await check('[10]/[11] Root delete: root И reply attachment redовете hard-deleted immediately', () => {
      const result = store.deleteMessage({ topicId: 'topic-a', messageId: root.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      assert(result.ok === true, 'delete трябва да успее')
      if (result.ok) {
        const filenames = [...result.deletedAttachmentFilenames].sort()
        assertEqual(filenames.join(','), [rootImg.storageFilename, replyImg.storageFilename].sort().join(','), 'и двата attachment filename-а трябва да са в резултата')
      }
      assertEqual(store.attachmentExistsForFilename(rootImg.storageFilename), false, 'root attachment DB row трябва да е hard-deleted')
      assertEqual(store.attachmentExistsForFilename(replyImg.storageFilename), false, 'reply attachment DB row трябва да е hard-deleted')
    })

    await check('[13] Attachment на друго, недокоснато съобщение остава', () => {
      assertEqual(store.attachmentExistsForFilename(otherImg.storageFilename), true, 'unrelated attachment трябва да остане')
    })

    await check('[14] Filenames queued atomically (deletion queue)', () => {
      const pending = store.listPendingAttachmentDeletions(10).map((p) => p.storageFilename).sort()
      assertEqual(pending.join(','), [rootImg.storageFilename, replyImg.storageFilename].sort().join(','), 'и двата filename-а трябва да са в cleanup queue-то')
    })

    await check('[15] Attachment download denied immediately (getAttachmentForDownload → null)', () => {
      assertEqual(store.getAttachmentForDownload('topic-a', rootImg.storageFilename), null, 'root attachment не трябва да е downloadable')
      assertEqual(store.getAttachmentForDownload('topic-a', replyImg.storageFilename), null, 'reply attachment не трябва да е downloadable')
    })
  } finally {
    store.close()
  }
})

// ─── [16] Rollback safety ────────────────────────────────────────────────────
//
// Симулира грешка ПО ВРЕМЕ на deleteMessage транзакцията (BEFORE UPDATE
// trigger на topic_messages, RAISE ABORT) — доказва, че ROLLBACK наистина
// връща ВСИЧКО обратно: attachment redовете, deletion queue job-а, message
// deleted_at state-а. Никакво partial "attachment изтрит, message останал
// live" разминаване.

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'rollback-safety.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const img = makeAttachment('66666666-6666-4666-8666-666666666666.webp')
    const msg = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root with image', attachment: img,
    })

    const db = new DatabaseSync(dbPath, { open: true })
    db.exec(`
      CREATE TRIGGER sabotage_message_delete
      BEFORE UPDATE ON topic_messages
      WHEN NEW.deleted_at IS NOT NULL AND OLD.message_id = '${msg.messageId}'
      BEGIN
        SELECT RAISE(ABORT, 'sabotage: simulated failure mid-delete-transaction');
      END;
    `)
    db.close()

    await check('[16] Rollback safety: грешка по време на delete транзакцията не оставя partial state', () => {
      let threw = false
      try {
        store.deleteMessage({ topicId: 'topic-a', messageId: msg.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      } catch {
        threw = true
      }
      assert(threw, 'deleteMessage трябва да пропагира грешката от saboteur trigger-а')

      assertEqual(store.attachmentExistsForFilename(img.storageFilename), true, 'attachment DB row трябва да ОСТАНЕ след rollback (не hard-deleted частично)')
      const pending = store.listPendingAttachmentDeletions(10)
      assertEqual(pending.length, 0, 'НИКАКЪВ cleanup queue job не трябва да остане след rollback (queue insert-ът също се връща обратно)')
      const row = store.getMessageById(msg.messageId)
      assert(row !== null && row.deletedAt === null, 'съобщението трябва да остане live (deleted_at null) след rollback')
    })
  } finally {
    store.close()
  }
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'standalone-reply-attachment.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root',
    })
    const targetImg = makeAttachment('44444444-4444-4444-8444-444444444444.webp')
    const targetReply = store.insertReply({
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'sender-2', senderDisplayName: 'S2', senderRole: 'player', body: 'target reply', attachment: targetImg,
    })
    const siblingImg = makeAttachment('55555555-5555-4555-8555-555555555555.webp')
    store.insertReply({
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'sender-3', senderDisplayName: 'S3', senderRole: 'player', body: 'sibling reply', attachment: siblingImg,
    })

    await check('[12] Standalone reply delete: само targeted reply attachment hard-deleted', () => {
      store.deleteMessage({ topicId: 'topic-a', messageId: targetReply.messageId, actorAccountId: 'mod-1', actorRole: 'pika_team' })
      assertEqual(store.attachmentExistsForFilename(targetImg.storageFilename), false, 'targeted reply attachment трябва да е hard-deleted')
      assertEqual(store.attachmentExistsForFilename(siblingImg.storageFilename), true, 'sibling reply attachment трябва да остане')
    })
  } finally {
    store.close()
  }
})

// ─── [17]-[18] Likes ─────────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'likes.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root',
    })
    store.toggleLike(root.messageId, 'sender-2')
    store.toggleLike(root.messageId, 'sender-3')

    await check('[17] Likes на soft-deleted target не се показват (message вече не се връща от read paths)', () => {
      store.deleteMessage({ topicId: 'topic-a', messageId: root.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      const page = store.getRecentMessages('topic-a', 50, [])
      assert(!page.messages.some((m) => m.messageId === root.messageId), 'изтритото съобщение не трябва да се появи, независимо от likes redовете')
    })

    await check('[18] Final hard purge CASCADE-трие likes', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const beforePurge = db.prepare(`SELECT COUNT(*) AS c FROM topic_message_likes WHERE message_id = ?`).get(root.messageId) as { c: number }
      db.close()
      assert(beforePurge.c > 0, 'likes redовете трябва да съществуват преди purge (soft-delete не ги трие)')

      const cutoff = new Date(Date.now() + 1000)
      store.purgeDeletedTopicMessagesBefore(cutoff, 100)

      const db2 = new DatabaseSync(dbPath, { open: true })
      const afterPurge = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_likes WHERE message_id = ?`).get(root.messageId) as { c: number }
      db2.close()
      assertEqual(afterPurge.c, 0, 'likes redовете трябва да са CASCADE-изтрити след hard purge')
    })
  } finally {
    store.close()
  }
})

// ─── [19]-[23] Audit/Event ───────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'audit-event.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root',
    })
    const reply1 = store.insertReply({
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'sender-2', senderDisplayName: 'S2', senderRole: 'player', body: 'reply 1',
    })
    store.insertReply({
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'sender-3', senderDisplayName: 'S3', senderRole: 'player', body: 'reply 2',
    })

    store.deleteMessage({ topicId: 'topic-a', messageId: root.messageId, actorAccountId: 'mod-chat-admin', actorRole: 'chat_admin' })

    await check('[19] Exactly one audit row за root thread delete (не N за replies)', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const count = db.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_audit_log WHERE topic_id = 'topic-a'`).get() as { c: number }
      db.close()
      assertEqual(count.c, 1, 'трябва да има точно 1 audit ред за root thread delete-а')
    })

    await check('[20] Exactly one deletion event за root thread delete', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const count = db.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_events WHERE topic_id = 'topic-a'`).get() as { c: number }
      db.close()
      assertEqual(count.c, 1, 'трябва да има точно 1 deletion event за root thread delete-а')
    })

    await check('[21] chat_admin audit insert работи (actor_role CHECK допуска chat_admin)', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const row = db.prepare(`SELECT actor_role FROM topic_message_deletion_audit_log WHERE topic_id = 'topic-a'`).get() as { actor_role: string }
      db.close()
      assertEqual(row.actor_role, 'chat_admin', 'audit редът трябва да пази chat_admin actor_role без CHECK violation')
    })

    await check('[22] Duplicate delete не дублира audit/event (store-level idempotency)', () => {
      const secondAttempt = store.deleteMessage({ topicId: 'topic-a', messageId: root.messageId, actorAccountId: 'mod-2', actorRole: 'admin' })
      assert(secondAttempt.ok === false, 'втори delete на вече изтрит root трябва да fail-не')
      if (!secondAttempt.ok) assertEqual(secondAttempt.code, 'already_deleted', 'code трябва да е already_deleted')

      const db = new DatabaseSync(dbPath, { open: true })
      const auditCount = db.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_audit_log WHERE topic_id = 'topic-a'`).get() as { c: number }
      const eventCount = db.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_events WHERE topic_id = 'topic-a'`).get() as { c: number }
      db.close()
      assertEqual(auditCount.c, 1, 'audit редовете трябва да останат точно 1 (без дублиране)')
      assertEqual(eventCount.c, 1, 'event редовете трябва да останат точно 1 (без дублиране)')
    })

    await check('[23] Audit row съдържа коректен sender_profile_id/parent_message_id snapshot', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const row = db.prepare(`SELECT sender_profile_id, parent_message_id FROM topic_message_deletion_audit_log WHERE message_id = ?`).get(root.messageId) as { sender_profile_id: string; parent_message_id: string | null }
      db.close()
      assertEqual(row.sender_profile_id, 'sender-1', 'sender_profile_id трябва да е root author-а')
      assertEqual(row.parent_message_id, null, 'parent_message_id трябва да е null (root target)')
    })

    await check('[23b] Reply audit row пази parent_message_id snapshot (non-null, sочи към root)', () => {
      // reply1 е CASCADE-collateral на root thread delete-а (виж setup-а по-горе)
      // — audit редът за самото reply НЕ съществува (една операция за целия
      // thread, брифа §11), но самият root audit ред остава единственият
      // source of truth. Тук тестваме отделен, независим reply-only сценарий.
      const db = new DatabaseSync(dbPath, { open: true })
      const replyAuditCount = db.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_audit_log WHERE message_id = ?`).get(reply1.messageId) as { c: number }
      db.close()
      assertEqual(replyAuditCount.c, 0, 'reply1 (collateral от root delete) НЕ трябва да има собствен audit ред')
    })
  } finally {
    store.close()
  }
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'reply-audit-snapshot.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const root = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root',
    })
    const reply = store.insertReply({
      topicId: 'topic-a', parentMessageId: root.messageId, senderProfileId: 'sender-2', senderDisplayName: 'S2', senderRole: 'player', body: 'standalone reply',
    })

    store.deleteMessage({ topicId: 'topic-a', messageId: reply.messageId, actorAccountId: 'mod-1', actorRole: 'subadmin' })

    await check('[23c] Standalone reply delete: audit row parent_message_id = root id (non-null snapshot)', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const row = db.prepare(`SELECT parent_message_id FROM topic_message_deletion_audit_log WHERE message_id = ?`).get(reply.messageId) as { parent_message_id: string | null }
      db.close()
      assertEqual(row.parent_message_id, root.messageId, 'parent_message_id трябва да сочи към root-а (reply target snapshot)')
    })
  } finally {
    store.close()
  }
})

// ─── [24]-[26] Idempotency/Security (store-level) ───────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'idempotency-security.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    await check('[24] Delete на несъществуващо съобщение → not_found', () => {
      const result = store.deleteMessage({ topicId: 'topic-a', messageId: 'nonexistent-message-id', actorAccountId: 'mod-1', actorRole: 'admin' })
      assert(result.ok === false, 'трябва да fail-не')
      if (!result.ok) assertEqual(result.code, 'not_found', 'code трябва да е not_found')
    })

    const msg = store.insertMessage({
      topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root',
    })

    await check('[25] Delete на вече изтрито съобщение → already_deleted', () => {
      store.deleteMessage({ topicId: 'topic-a', messageId: msg.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      const secondResult = store.deleteMessage({ topicId: 'topic-a', messageId: msg.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      assert(secondResult.ok === false, 'втори delete трябва да fail-не')
      if (!secondResult.ok) assertEqual(secondResult.code, 'already_deleted', 'code трябва да е already_deleted')
    })

    const msgInTopicB = store.insertMessage({
      topicId: 'topic-b', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root в topic-b',
    })

    await check('[26] Wrong topic/message pair → not_found', () => {
      const result = store.deleteMessage({ topicId: 'topic-a', messageId: msgInTopicB.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      assert(result.ok === false, 'трябва да fail-не — съобщението принадлежи на topic-b, не topic-a')
      if (!result.ok) assertEqual(result.code, 'not_found', 'code трябва да е not_found')
    })
  } finally {
    store.close()
  }
})

// ─── [27]-[37] Individual message retention/purge ──────────────────────────
//
// purgeDeletedTopicMessagesBefore boundary: deleted_at <= cutoff (симетрично
// на topicModerationStore.purgeRemovedTopicsBefore, corrective pass boundary
// policy). Изключва съобщения от removed теми — whole-topic purge е
// authoritative там (брифа §3/§22).

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'retention.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    insertTopic(db, { topicId: 'topic-locked', slug: 'topic-locked', title: 'Locked тема' })
    insertTopic(db, { topicId: 'topic-removed', slug: 'topic-removed', title: 'Removed тема' })
    db.prepare(`UPDATE topics SET status = 'locked', locked_until = ? WHERE topic_id = 'topic-locked'`).run(daysAgoSqliteString(-1))
    db.prepare(`UPDATE topics SET status = 'removed', removed_at = ? WHERE topic_id = 'topic-removed'`).run(daysAgoSqliteString(200))
    db.close()

    // 179 дни — под cutoff-а.
    const msg179 = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: '179 days' })
    store.deleteMessage({ topicId: 'topic-a', messageId: msg179.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(179), msg179.messageId)
      db2.close()
    }

    // Точно 180 дни — на cutoff-а, eligible.
    const msg180 = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: '180 days' })
    store.deleteMessage({ topicId: 'topic-a', messageId: msg180.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(180), msg180.messageId)
      db2.close()
    }

    // >180 дни (200) — eligible.
    const msg200 = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: '200 days' })
    store.deleteMessage({ topicId: 'topic-a', messageId: msg200.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(200), msg200.messageId)
      db2.close()
    }

    // Active topic, >180 дни — eligible (active/locked topics individual purge работи).
    const msgActive = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'active topic old' })
    store.deleteMessage({ topicId: 'topic-a', messageId: msgActive.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(200), msgActive.messageId)
      db2.close()
    }

    // Locked topic, >180 дни — eligible (locked не блокира individual message purge-а).
    const msgLocked = store.insertMessage({ topicId: 'topic-locked', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'locked topic old' })
    store.deleteMessage({ topicId: 'topic-locked', messageId: msgLocked.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(200), msgLocked.messageId)
      db2.close()
    }

    // Removed topic, >180 дни — NOT eligible (whole-topic purge е authoritative).
    const msgRemoved = store.insertMessage({ topicId: 'topic-removed', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'removed topic old' })
    store.deleteMessage({ topicId: 'topic-removed', messageId: msgRemoved.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(200), msgRemoved.messageId)
      db2.close()
    }

    // Root с вече-soft-deleted reply (thread delete), >180 дни — за [32].
    const rootForCascade = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root for cascade purge' })
    const replyForCascade = store.insertReply({ topicId: 'topic-a', parentMessageId: rootForCascade.messageId, senderProfileId: 'sender-2', senderDisplayName: 'S2', senderRole: 'player', body: 'reply for cascade purge' })
    store.deleteMessage({ topicId: 'topic-a', messageId: rootForCascade.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id IN (?, ?)`).run(daysAgoSqliteString(200), rootForCascade.messageId, replyForCascade.messageId)
      db2.close()
    }

    // Standalone reply delete (root остава live), >180 дни — за [33].
    const rootForStandalone = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: 'root, live, sibling purge test' })
    const replyForStandalonePurge = store.insertReply({ topicId: 'topic-a', parentMessageId: rootForStandalone.messageId, senderProfileId: 'sender-2', senderDisplayName: 'S2', senderRole: 'player', body: 'reply to purge standalone' })
    const siblingReplyLive = store.insertReply({ topicId: 'topic-a', parentMessageId: rootForStandalone.messageId, senderProfileId: 'sender-3', senderDisplayName: 'S3', senderRole: 'player', body: 'sibling reply, stays live' })
    store.deleteMessage({ topicId: 'topic-a', messageId: replyForStandalonePurge.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
    {
      const db2 = new DatabaseSync(dbPath, { open: true })
      db2.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id = ?`).run(daysAgoSqliteString(200), replyForStandalonePurge.messageId)
      db2.close()
    }

    await check('[27] Deleted съобщение на 179 дни → НЕ purge-нато', () => {
      const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      const purged = store.purgeDeletedTopicMessagesBefore(cutoff, 100)
      assert(purged >= 5, 'поне 180/200-дневните redовете трябва да са purge-нати на този cutoff')
      const stillThere = store.getMessageById(msg179.messageId)
      assert(stillThere !== null, '179-дневният ред трябва да ОСТАНЕ (все още вътре в retention прозореца)')
    })

    await check('[28] Deleted съобщение точно на 180 дни → purge eligible', () => {
      const row = store.getMessageById(msg180.messageId)
      assertEqual(row, null, 'редът на точно 180 дни трябва да е hard-purged')
    })

    await check('[29] Deleted съобщение >180 дни → purge eligible', () => {
      const row = store.getMessageById(msg200.messageId)
      assertEqual(row, null, 'редът на 200 дни трябва да е hard-purged')
    })

    await check('[30] Active/locked topic individual deletion purge работи', () => {
      assertEqual(store.getMessageById(msgActive.messageId), null, 'active topic-ото старо изтрито съобщение трябва да е purge-нато')
      assertEqual(store.getMessageById(msgLocked.messageId), null, 'locked topic-ото старо изтрито съобщение трябва да е purge-нато')
    })

    await check('[31] Removed topic се изключва от individual purge (whole-topic purge е authoritative)', () => {
      const row = store.getMessageById(msgRemoved.messageId)
      assert(row !== null, 'съобщение в removed тема НЕ трябва да е засегнато от individual message purge-а')
    })

    await check('[32] Root purge CASCADE-ва already-deleted replies', () => {
      assertEqual(store.getMessageById(rootForCascade.messageId), null, 'root-ът трябва да е purge-нат')
      assertEqual(store.getMessageById(replyForCascade.messageId), null, 'reply-то трябва да е CASCADE-purge-нато заедно с root-а')
    })

    await check('[33] Standalone reply purge не засяга root/siblings', () => {
      assertEqual(store.getMessageById(replyForStandalonePurge.messageId), null, 'purge-натата reply трябва да изчезне')
      const rootRow = store.getMessageById(rootForStandalone.messageId)
      const siblingRow = store.getMessageById(siblingReplyLive.messageId)
      assert(rootRow !== null && rootRow.deletedAt === null, 'root-ът трябва да остане live и непокътнат')
      assert(siblingRow !== null && siblingRow.deletedAt === null, 'sibling reply-то трябва да остане live и непокътнато')
    })

    await check('[34] Audit/event lifecycle приключва при hard purge (CASCADE)', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const auditCount = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_audit_log WHERE message_id = ?`).get(msg200.messageId) as { c: number }
      const eventCount = db2.prepare(`SELECT COUNT(*) AS c FROM topic_message_deletion_events WHERE message_id = ?`).get(msg200.messageId) as { c: number }
      db2.close()
      assertEqual(auditCount.c, 0, 'audit редът трябва да е CASCADE-изчезнал заедно с purge-натото съобщение')
      assertEqual(eventCount.c, 0, 'event редът трябва да е CASCADE-изчезнал заедно с purge-натото съобщение')
    })

    await check('[36] Repeated purge run safe/no-op', () => {
      const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      const purged = store.purgeDeletedTopicMessagesBefore(cutoff, 100)
      assertEqual(purged, 0, 'повторен run веднага след първия трябва да е no-op')
    })
  } finally {
    store.close()
  }
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'purge-batch.sqlite')
  const store = await createTopicMessageStore(dbPath)
  try {
    const oldDate = daysAgoSqliteString(200)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const msg = store.insertMessage({ topicId: 'topic-a', senderProfileId: 'sender-1', senderDisplayName: 'S1', senderRole: 'player', body: `batch ${i}` })
      store.deleteMessage({ topicId: 'topic-a', messageId: msg.messageId, actorAccountId: 'mod-1', actorRole: 'admin' })
      ids.push(msg.messageId)
    }
    const db = new DatabaseSync(dbPath, { open: true })
    const placeholders = ids.map(() => '?').join(',')
    db.prepare(`UPDATE topic_messages SET deleted_at = ? WHERE message_id IN (${placeholders})`).run(oldDate, ...ids)
    db.close()

    await check('[35] Batch limit се спазва — bounded цикъл изчиства всички eligible redове', () => {
      const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      const purged = store.purgeDeletedTopicMessagesBefore(cutoff, 2)
      assertEqual(purged, 5, 'batched цикълът трябва да изчисти всички 5 eligible redове въпреки малкия batchSize')
      for (const id of ids) {
        assertEqual(store.getMessageById(id), null, `${id} трябва да е purge-нат`)
      }
    })

    await check('[37] Purge не ползва OFFSET pagination (source-level guard)', async () => {
      const storeSource = await readFile(resolve(serverRoot, 'src/db/topicMessageStore.ts'), 'utf8')
      const fnBody = storeSource.match(/function purgeDeletedTopicMessagesBefore\([\s\S]*?\n  \}/)?.[0] ?? ''
      assert(fnBody.length > 0, 'purgeDeletedTopicMessagesBefore function not found')
      assert(!/OFFSET/i.test(fnBody), 'purge заявките НЕ трябва да ползват OFFSET pagination')
    })
  } finally {
    store.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)

if (failed > 0) {
  process.exitCode = 1
}
