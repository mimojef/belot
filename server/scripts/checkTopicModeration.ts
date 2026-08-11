/**
 * checkTopicModeration.ts
 *
 * Store-level checks за Topics moderation (Етап 4): temporary lock/unlock,
 * topic-specific mute/unmute, attachment cleanup при delete, reports,
 * audit log. HTTP/WS role authorization и realtime notify са покрити от
 * checkTopicModerationAuthRealtime.ts (изисква spawn-нат сървър).
 *
 * [0]  lockTopic вмъква locked_until в бъдещето, isLocked=true веднага
 * [1]  getTopicLockSnapshot: expired lock (locked_until в миналото) → isLocked=false, без explicit unlock
 * [2]  unlockTopic: ръчен unlock преди expiry → isLocked=false незабавно, changed=true
 * [3]  unlockTopic: idempotent — unlock на вече unlocked тема → changed=false, без грешка
 * [4]  unlockTopic: idempotent — unlock на ВЕЧЕ ИЗТЕКЪЛ lock (естествен expiry) → changed=false
 * [5]  muteProfileInTopic: mute в Тема A → isProfileMutedInTopic(A)=true
 * [6]  Mute в Тема A НЕ блокира писането в Тема B — isProfileMutedInTopic(B)=false за същия profile
 * [7]  getMuteSnapshot: expired mute (muted_until в миналото) → isMuted=false
 * [8]  unmuteProfileInTopic: ръчен unmute преди expiry → isMuted=false незабавно, changed=true, редът е изтрит от DB
 * [9]  unmuteProfileInTopic: idempotent — unmute на вече unmuted профил → changed=false
 * [10] Повторен muteProfileInTopic (нов mute) презаписва стар (UPSERT) — само 1 ред за (topic, profile)
 * [11] Audit log: topic_lock append-ва ред с actor/action/topicId/reason/expiresAt
 * [12] Audit log: ръчен topic_unlock е САМОСТОЯТЕЛЕН ред (не редактира lock реда) — 2 реда общо
 * [13] Audit log: topic_mute append-ва ред с target_profile_id
 * [14] Audit log: ръчен topic_unmute е САМОСТОЯТЕЛЕН ред (target_profile_id + null reason/expiresAt)
 * [15] Audit log: listAuditLogForTopic връща DESC по created_at (най-новото първо)
 * [16] createReport: успешен insert, status='pending' по подразбиране
 * [17] createReport: duplicate (същия reporter+topic в прозореца) → ok:false, code:'duplicate'
 * [18] listReports: филтър по status връща само съответните записи
 * [19] countPendingReports отразява точния брой pending
 * [20] reviewReport: 'reviewed' сменя status + reviewed_by_account_id + reviewed_at
 * [21] reviewReport: несъществуващ reportId → code:'not_found'
 * [22] Audit log: topic_delete append-ва самостоятелен ред
 * [23] getAttachmentFilenamesForTopic връща ВСИЧКИ filenames на темата (root+reply attachments)
 * [24] deleteTopic: soft-delete — topics.status='removed', topic_messages.deleted_at попълнен, DB редовете ОСТАВАТ (не hard DELETE)
 * [25] deleteTopic: topic_message_attachments редовете ОСТАВАТ непокътнати след soft-delete (attachment cleanup queue-ване е caller responsibility, виж index.ts)
 * [26] deleteTopic: idempotent — delete на вече removed тема → code:'already_removed'
 * [27] deleteTopic: несъществуваща тема → code:'not_found'
 * [28] Attachment cleanup regression: filenames, събрани ПРЕДИ delete, остават валидни за enqueueAttachmentDeletion СЛЕД soft-delete (index.ts pattern)
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicModerationStore } from '../src/db/topicModerationStore.js'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const topicsMigrationPath = resolve(serverRoot, 'database/migrations/20260810_002_create_topics_and_messages.sql')
const likesMigrationPath = resolve(serverRoot, 'database/migrations/20260811_001_create_topic_message_likes.sql')
const attachmentsMigrationPath = resolve(serverRoot, 'database/migrations/20260811_002_create_topic_message_attachments.sql')
const moderationMigrationPath = resolve(serverRoot, 'database/migrations/20260811_003_create_topic_moderation.sql')

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-moderation-check-'))
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

function pastIso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ')
}

async function setupDb(dir: string, filename: string): Promise<string> {
  const dbPath = join(dir, filename)
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, likesMigrationPath)
  await applyMigrationFile(db, attachmentsMigrationPath)
  await applyMigrationFile(db, moderationMigrationPath)
  seedAccount(db, 'moderator-1')
  seedAccount(db, 'moderator-2')
  seedProfile(db, 'target-1')
  seedProfile(db, 'target-2')
  insertTopic(db, { topicId: 'topic-a', slug: 'topic-a', title: 'Тема A' })
  insertTopic(db, { topicId: 'topic-b', slug: 'topic-b', title: 'Тема Б' })
  db.close()
  return dbPath
}

// ─── [0]-[4] Lock/Unlock ────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'lock.sqlite')
  const store = await createTopicModerationStore(dbPath)
  try {
    await check('[0] lockTopic вмъква locked_until в бъдещето, isLocked=true веднага', () => {
      const snapshot = store.lockTopic({ topicId: 'topic-a', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'spam', durationMs: 60 * 60 * 1000 })
      assert(snapshot.isLocked === true, 'трябва да е locked веднага след lockTopic')
      assert(snapshot.lockedUntil !== null, 'lockedUntil трябва да е попълнен')
      assertEqual(snapshot.lockedReason, 'spam', 'lockedReason трябва да съвпада')
    })

    await check('[1] getTopicLockSnapshot: expired lock (locked_until в миналото) → isLocked=false, без explicit unlock', () => {
      store.lockTopic({ topicId: 'topic-b', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'test', durationMs: 1000 })
      // Директно UPDATE-ваме locked_until в миналото — симулира естествен expiry.
      const db = new DatabaseSync(dbPath, { open: true })
      db.prepare(`UPDATE topics SET locked_until = ? WHERE topic_id = 'topic-b'`).run(pastIso(60_000))
      db.close()
      const snapshot = store.getTopicLockSnapshot('topic-b')
      assert(snapshot !== null, 'snapshot трябва да съществува')
      assertEqual(snapshot!.isLocked, false, 'expired lock трябва да computed-не isLocked=false')
    })

    await check('[2] unlockTopic: ръчен unlock преди expiry → isLocked=false незабавно, changed=true', () => {
      store.lockTopic({ topicId: 'topic-a', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'x', durationMs: 60 * 60 * 1000 })
      const { changed, snapshot } = store.unlockTopic({ topicId: 'topic-a', actorAccountId: 'moderator-2', actorRole: 'subadmin' })
      assertEqual(changed, true, 'unlock на active lock трябва да е changed=true')
      assertEqual(snapshot.isLocked, false, 'снапшотът трябва да показва отключено')
    })

    await check('[3] unlockTopic: idempotent — unlock на вече unlocked тема → changed=false, без грешка', () => {
      const { changed } = store.unlockTopic({ topicId: 'topic-a', actorAccountId: 'moderator-1', actorRole: 'admin' })
      assertEqual(changed, false, 'втори unlock трябва да е no-op')
    })

    await check('[4] unlockTopic: idempotent — unlock на ВЕЧЕ ИЗТЕКЪЛ lock (естествен expiry) → changed=false', () => {
      const { changed } = store.unlockTopic({ topicId: 'topic-b', actorAccountId: 'moderator-1', actorRole: 'admin' })
      assertEqual(changed, false, 'unlock на естествено изтекъл lock трябва да е no-op (вече не е активен)')
    })
  } finally {
    store.close()
  }
})

// ─── [5]-[10] Mute/Unmute ───────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'mute.sqlite')
  const store = await createTopicModerationStore(dbPath)
  try {
    await check('[5] muteProfileInTopic: mute в Тема A → isProfileMutedInTopic(A)=true', () => {
      store.muteProfileInTopic({ topicId: 'topic-a', profileId: 'target-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'spam', durationMs: 30 * 60 * 1000 })
      assert(store.isProfileMutedInTopic('topic-a', 'target-1') === true, 'target-1 трябва да е muted в topic-a')
    })

    await check('[6] Mute в Тема A НЕ блокира писането в Тема B', () => {
      assert(store.isProfileMutedInTopic('topic-b', 'target-1') === false, 'mute-ът в topic-a не трябва да важи за topic-b')
    })

    await check('[7] getMuteSnapshot: expired mute (muted_until в миналото) → isMuted=false', () => {
      store.muteProfileInTopic({ topicId: 'topic-a', profileId: 'target-2', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'x', durationMs: 1000 })
      const db = new DatabaseSync(dbPath, { open: true })
      db.prepare(`UPDATE topic_mutes SET muted_until = ? WHERE topic_id = 'topic-a' AND profile_id = 'target-2'`).run(pastIso(60_000))
      db.close()
      assertEqual(store.isProfileMutedInTopic('topic-a', 'target-2'), false, 'expired mute трябва да computed-не isMuted=false')
    })

    await check('[8] unmuteProfileInTopic: ръчен unmute преди expiry → isMuted=false незабавно, changed=true, редът е изтрит от DB', () => {
      const { changed } = store.unmuteProfileInTopic({ topicId: 'topic-a', profileId: 'target-1', actorAccountId: 'moderator-1', actorRole: 'admin' })
      assertEqual(changed, true, 'unmute на active mute трябва да е changed=true')
      assertEqual(store.isProfileMutedInTopic('topic-a', 'target-1'), false, 'target-1 вече не трябва да е muted')
      const db = new DatabaseSync(dbPath, { open: true })
      const row = db.prepare(`SELECT 1 FROM topic_mutes WHERE topic_id = 'topic-a' AND profile_id = 'target-1'`).get()
      db.close()
      assert(row === undefined, 'редът трябва да е реално изтрит от DB (не overwrite с минала дата)')
    })

    await check('[9] unmuteProfileInTopic: idempotent — unmute на вече unmuted профил → changed=false', () => {
      const { changed } = store.unmuteProfileInTopic({ topicId: 'topic-a', profileId: 'target-1', actorAccountId: 'moderator-1', actorRole: 'admin' })
      assertEqual(changed, false, 'unmute на вече unmuted профил трябва да е no-op')
    })

    await check('[10] Повторен muteProfileInTopic (нов mute) презаписва стар (UPSERT) — само 1 ред за (topic, profile)', () => {
      store.muteProfileInTopic({ topicId: 'topic-b', profileId: 'target-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'first', durationMs: 30 * 60 * 1000 })
      store.muteProfileInTopic({ topicId: 'topic-b', profileId: 'target-1', actorAccountId: 'moderator-2', actorRole: 'subadmin', reason: 'second', durationMs: 60 * 60 * 1000 })
      const db = new DatabaseSync(dbPath, { open: true })
      const rows = db.prepare(`SELECT reason FROM topic_mutes WHERE topic_id = 'topic-b' AND profile_id = 'target-1'`).all() as Array<{ reason: string }>
      db.close()
      assertEqual(rows.length, 1, 'трябва да има точно 1 ред (UPSERT, не INSERT дубликат)')
      assertEqual(rows[0]!.reason, 'second', 'reason трябва да е от последния mute')
    })
  } finally {
    store.close()
  }
})

// ─── [11]-[15] Audit log ─────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'audit.sqlite')
  const store = await createTopicModerationStore(dbPath)
  try {
    await check('[11] Audit log: topic_lock append-ва ред с actor/action/topicId/reason/expiresAt', () => {
      store.lockTopic({ topicId: 'topic-a', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'spam', durationMs: 60 * 60 * 1000 })
      const entries = store.listAuditLogForTopic('topic-a', 10)
      const lockEntry = entries.find((e) => e.action === 'topic_lock')
      assert(lockEntry !== undefined, 'trябва да има topic_lock запис')
      assertEqual(lockEntry!.actorAccountId, 'moderator-1', 'actor трябва да съвпада')
      assertEqual(lockEntry!.reason, 'spam', 'reason трябва да съвпада')
      assert(lockEntry!.expiresAt !== null, 'expiresAt трябва да е попълнен за temporary action')
    })

    await check('[12] Audit log: ръчен topic_unlock е САМОСТОЯТЕЛЕН ред (не редактира lock реда) — 2 реда общо', () => {
      store.unlockTopic({ topicId: 'topic-a', actorAccountId: 'moderator-2', actorRole: 'subadmin' })
      const entries = store.listAuditLogForTopic('topic-a', 10)
      const lockEntries = entries.filter((e) => e.action === 'topic_lock')
      const unlockEntries = entries.filter((e) => e.action === 'topic_unlock')
      assertEqual(lockEntries.length, 1, 'старият lock запис трябва да остане непокътнат')
      assertEqual(unlockEntries.length, 1, 'unlock трябва да е нов самостоятелен запис')
      assertEqual(unlockEntries[0]!.actorAccountId, 'moderator-2', 'unlock actor трябва да е различният модератор')
    })

    await check('[13] Audit log: topic_mute append-ва ред с target_profile_id', () => {
      store.muteProfileInTopic({ topicId: 'topic-a', profileId: 'target-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'test', durationMs: 30 * 60 * 1000 })
      const entries = store.listAuditLogForTopic('topic-a', 10)
      const muteEntry = entries.find((e) => e.action === 'topic_mute')
      assert(muteEntry !== undefined, 'трябва да има topic_mute запис')
      assertEqual(muteEntry!.targetProfileId, 'target-1', 'targetProfileId трябва да съвпада')
    })

    await check('[14] Audit log: ръчен topic_unmute е САМОСТОЯТЕЛЕН ред (target_profile_id + null reason/expiresAt)', () => {
      store.unmuteProfileInTopic({ topicId: 'topic-a', profileId: 'target-1', actorAccountId: 'moderator-1', actorRole: 'admin' })
      const entries = store.listAuditLogForTopic('topic-a', 10)
      const unmuteEntry = entries.find((e) => e.action === 'topic_unmute')
      assert(unmuteEntry !== undefined, 'трябва да има topic_unmute запис')
      assertEqual(unmuteEntry!.targetProfileId, 'target-1', 'targetProfileId трябва да съвпада')
      assertEqual(unmuteEntry!.reason, null, 'unmute audit не носи reason')
      assertEqual(unmuteEntry!.expiresAt, null, 'unmute audit не носи expiresAt')
    })

    await check('[15] Audit log: listAuditLogForTopic връща DESC по created_at (най-новото първо)', () => {
      const entries = store.listAuditLogForTopic('topic-a', 10)
      assert(entries.length >= 2, 'трябва да има поне 2 записа')
      for (let i = 1; i < entries.length; i++) {
        assert(entries[i - 1]!.createdAt >= entries[i]!.createdAt, 'редовете трябва да са в низходящ ред по created_at')
      }
    })
  } finally {
    store.close()
  }
})

// ─── [16]-[21] Reports ────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'reports.sqlite')
  const store = await createTopicModerationStore(dbPath)
  try {
    await check('[16] createReport: успешен insert, status=\'pending\' по подразбиране', () => {
      const result = store.createReport({ topicId: 'topic-a', reporterProfileId: 'target-1', reason: 'spam content' })
      assert(result.ok === true, 'първи report трябва да успее')
      if (result.ok) {
        assertEqual(result.report.status, 'pending', 'нов report трябва да е pending')
        assertEqual(result.report.reason, 'spam content', 'reason трябва да съвпада')
      }
    })

    await check('[17] createReport: duplicate (същия reporter+topic в прозореца) → ok:false, code:\'duplicate\'', () => {
      const result = store.createReport({ topicId: 'topic-a', reporterProfileId: 'target-1', reason: 'again' })
      assert(result.ok === false, 'втори report от същия reporter/topic в прозореца трябва да е duplicate')
      if (!result.ok) assertEqual(result.code, 'duplicate', 'code трябва да е duplicate')
    })

    await check('[18] listReports: филтър по status връща само съответните записи', () => {
      store.createReport({ topicId: 'topic-b', reporterProfileId: 'target-2', reason: 'other topic report' })
      const pendingReports = store.listReports('pending', 10)
      assert(pendingReports.length >= 2, 'трябва да има поне 2 pending report-а')
      assert(pendingReports.every((r) => r.status === 'pending'), 'всички трябва да са pending')
    })

    await check('[19] countPendingReports отразява точния брой pending', () => {
      const count = store.countPendingReports()
      assertEqual(count, 2, 'трябва да има точно 2 pending report-а')
    })

    let reviewedReportId = ''
    await check('[20] reviewReport: \'reviewed\' сменя status + reviewed_by_account_id + reviewed_at', () => {
      const pending = store.listReports('pending', 10)
      reviewedReportId = pending[0]!.reportId
      const result = store.reviewReport({ reportId: reviewedReportId, status: 'reviewed', actorAccountId: 'moderator-1' })
      assert(result.ok === true, 'review трябва да успее')
      if (result.ok) {
        assertEqual(result.report.status, 'reviewed', 'status трябва да е reviewed')
        assertEqual(result.report.reviewedByAccountId, 'moderator-1', 'reviewedByAccountId трябва да съвпада')
        assert(result.report.reviewedAt !== null, 'reviewedAt трябва да е попълнен')
      }
    })

    await check('[21] reviewReport: несъществуващ reportId → code:\'not_found\'', () => {
      const result = store.reviewReport({ reportId: 'nonexistent-report-id', status: 'dismissed', actorAccountId: 'moderator-1' })
      assert(result.ok === false, 'несъществуващ report трябва да fail-не')
      if (!result.ok) assertEqual(result.code, 'not_found', 'code трябва да е not_found')
    })
  } finally {
    store.close()
  }
})

// ─── [22]-[28] Delete + attachment cleanup ──────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'delete.sqlite')
  const moderationStore = await createTopicModerationStore(dbPath)
  const messageStore = await createTopicMessageStore(dbPath)
  try {
    const rootMessage = messageStore.insertMessage({
      topicId: 'topic-a',
      senderProfileId: 'target-1',
      senderDisplayName: 'Target One',
      senderRole: 'player',
      body: 'root with image',
      attachment: { storageFilename: 'root-attachment.webp', width: 100, height: 100, byteSize: 500, contentType: 'image/webp' },
    })
    const reply = messageStore.insertReply({
      topicId: 'topic-a',
      parentMessageId: rootMessage.messageId,
      senderProfileId: 'target-2',
      senderDisplayName: 'Target Two',
      senderRole: 'player',
      body: 'reply with image',
      attachment: { storageFilename: 'reply-attachment.webp', width: 100, height: 100, byteSize: 500, contentType: 'image/webp' },
    })

    await check('[23] getAttachmentFilenamesForTopic връща ВСИЧКИ filenames на темата (root+reply attachments)', () => {
      const filenames = moderationStore.getAttachmentFilenamesForTopic('topic-a').sort()
      assertEqual(filenames.join(','), ['reply-attachment.webp', 'root-attachment.webp'].sort().join(','), 'трябва да включва и root, и reply attachment filenames')
    })

    await check('[22] Audit log: topic_delete append-ва самостоятелен ред', () => {
      moderationStore.deleteTopic({ topicId: 'topic-a', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'terms violation' })
      const entries = moderationStore.listAuditLogForTopic('topic-a', 10)
      const deleteEntry = entries.find((e) => e.action === 'topic_delete')
      assert(deleteEntry !== undefined, 'трябва да има topic_delete запис')
      assertEqual(deleteEntry!.reason, 'terms violation', 'reason трябва да съвпада')
    })

    await check('[24] deleteTopic: soft-delete — topics.status=\'removed\', topic_messages.deleted_at попълнен, DB редовете ОСТАВАТ (не hard DELETE)', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const topicRow = db.prepare(`SELECT status, removed_reason FROM topics WHERE topic_id = 'topic-a'`).get() as { status: string; removed_reason: string }
      assertEqual(topicRow.status, 'removed', 'topics.status трябва да е removed')
      assertEqual(topicRow.removed_reason, 'terms violation', 'removed_reason трябва да съвпада')
      const messageRows = db.prepare(`SELECT deleted_at FROM topic_messages WHERE topic_id = 'topic-a'`).all() as Array<{ deleted_at: string | null }>
      db.close()
      assertEqual(messageRows.length, 2, 'root+reply редовете трябва да ОСТАНАТ в DB (soft-delete, не hard DELETE)')
      assert(messageRows.every((r) => r.deleted_at !== null), 'всички съобщения трябва да имат попълнен deleted_at')
    })

    await check('[25] deleteTopic: topic_message_attachments редовете ОСТАВАТ непокътнати след soft-delete', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const attachmentRows = db.prepare(`
        SELECT a.storage_filename FROM topic_message_attachments a
        INNER JOIN topic_messages m ON m.message_id = a.message_id
        WHERE m.topic_id = 'topic-a'
      `).all() as Array<{ storage_filename: string }>
      db.close()
      assertEqual(attachmentRows.length, 2, 'attachment DB редовете трябва да останат (cleanup queue-ването е caller responsibility, не CASCADE тук)')
    })

    await check('[28] Attachment cleanup regression: filenames, събрани ПРЕДИ delete, остават валидни за enqueueAttachmentDeletion СЛЕД soft-delete', () => {
      // Точният index.ts pattern: getAttachmentFilenamesForTopic() СЛЕД delete
      // (soft-delete не CASCADE-трие attachment редовете) все още връща
      // същите filenames — enqueue-ването остава коректно дори извикано
      // СЛЕД самия deleteTopic() (не само преди).
      const filenamesAfterDelete = moderationStore.getAttachmentFilenamesForTopic('topic-a').sort()
      assertEqual(filenamesAfterDelete.join(','), ['reply-attachment.webp', 'root-attachment.webp'].sort().join(','), 'filenames трябва да останат достъпни за enqueue дори СЛЕД soft-delete')
      for (const filename of filenamesAfterDelete) {
        messageStore.enqueueAttachmentDeletion(filename)
      }
      const pending = messageStore.listPendingAttachmentDeletions(10).map((p) => p.storageFilename).sort()
      assertEqual(pending.join(','), ['reply-attachment.webp', 'root-attachment.webp'].sort().join(','), 'и двата filename-а трябва да са в pending deletion queue-то')
    })

    await check('[26] deleteTopic: idempotent — delete на вече removed тема → code:\'already_removed\'', () => {
      const result = moderationStore.deleteTopic({ topicId: 'topic-a', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'again' })
      assert(result.ok === false, 'delete на вече removed тема трябва да fail-не')
      if (!result.ok) assertEqual(result.code, 'already_removed', 'code трябва да е already_removed')
    })

    await check('[27] deleteTopic: несъществуваща тема → code:\'not_found\'', () => {
      const result = moderationStore.deleteTopic({ topicId: 'nonexistent-topic', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'x' })
      assert(result.ok === false, 'несъществуваща тема трябва да fail-не')
      if (!result.ok) assertEqual(result.code, 'not_found', 'code трябва да е not_found')
    })
  } finally {
    moderationStore.close()
    messageStore.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)

if (failed > 0) {
  process.exitCode = 1
}
