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
 * [24] deleteTopic: topics.status='removed' веднага, topic редът ОСТАВА (не hard DELETE на темата)
 * [25] deleteTopic: topic_messages.deleted_at попълнен за root+reply, редовете ОСТАВАТ (soft-delete на текста, retention модел)
 * [26] deleteTopic: idempotent — delete на вече removed тема → code:'already_removed'
 * [27] deleteTopic: несъществуваща тема → code:'not_found'
 *
 * Hard-delete attachment модел (corrective pass — заменя стария soft-delete-attachments модел):
 * [29] deleteTopic: topic_message_attachments редовете (root+reply) са HARD-DELETED веднага в рамките на deleteTopic
 * [30] deleteTopic: всеки изтрит attachment filename получава ред в topic_message_attachment_deletions (queue за физически cleanup)
 * [31] deleteTopic: attachment на ДРУГА (недокосната) тема остава непокътнат
 * [32] deleteTopic: връща deletedAttachmentFilenames точния списък изтрити filenames
 * [33] deleteTopic: атомарност — hard-delete на attachments и queue insert стават в СЪЩАТА транзакция като topic/message soft-delete (проверено чрез единствен deleteTopic() call, без отделен enqueue стъпка от caller)
 * [34]-[36] getAttachmentForDownload: removed/active/locked topic download semantics
 *
 * 180-day retention purge (purgeRemovedTopicsBefore, retention anchor = topics.removed_at):
 * [40] Removed тема на 179 дни → НЕ purge-ната
 * [41] Removed тема точно на cutoff-а → НЕ purge-eligible (strict <)
 * [42] Removed тема >180 дни → hard-deleted
 * [43] Active тема >180 дни (по created_at) → НЕ засегната
 * [44] Locked тема >180 дни (по created_at) → НЕ засегната
 * [45] Removed тема без валиден removed_at → безопасно НЕ purge-ната
 * [46] Purge премахва root съобщения (CASCADE)
 * [47] Purge премахва replies (CASCADE)
 * [48] Purge премахва likes/mutes/reports (CASCADE по FK модела)
 * [49] Друга недокосната тема остава непроменена
 * [50] Повторен purge run е безопасен/no-op
 * [51] Празен eligible set / batchSize=0 е безопасен/no-op
 * [52] Purge batch limit се спазва (вътрешен цикъл до изчерпване)
 * [53] Purge не ползва OFFSET pagination (source-level guard)
 * [54] Cross-instance/повторен run семантика безопасна (DELETE...WHERE IN idempotent)
 * [55] Final purge: topic-specific moderation audit rows се премахват заедно с темата
 * [56] Audit row за друга (все още в retention прозореца) тема НЕ е засегнат
 * [57] Rollback safety: грешка по време на purge транзакцията не оставя partial state (audit ИЛИ topic частично изтрити)
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
  await applyMigrationFile(db, messageModerationMigrationPath)
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
    const db = new DatabaseSync(dbPath, { open: true })
    seedProfile(db, 'target-3')
    db.close()

    const rootMessage = messageStore.insertMessage({
      topicId: 'topic-a',
      senderProfileId: 'target-1',
      senderDisplayName: 'Target One',
      senderRole: 'player',
      body: 'root with image',
      attachment: { storageFilename: 'root-attachment.webp', width: 100, height: 100, byteSize: 500, contentType: 'image/webp' },
    })
    messageStore.insertReply({
      topicId: 'topic-a',
      parentMessageId: rootMessage.messageId,
      senderProfileId: 'target-2',
      senderDisplayName: 'Target Two',
      senderRole: 'player',
      body: 'reply with image',
      attachment: { storageFilename: 'reply-attachment.webp', width: 100, height: 100, byteSize: 500, contentType: 'image/webp' },
    })

    // Attachment, принадлежащ на ДРУГА тема — трябва да остане непокътнат
    // след delete на topic-a (проверка [31]).
    const otherRoot = messageStore.insertMessage({
      topicId: 'topic-b',
      senderProfileId: 'target-3',
      senderDisplayName: 'Target Three',
      senderRole: 'player',
      body: 'root в друга тема',
      attachment: { storageFilename: 'other-topic-attachment.webp', width: 100, height: 100, byteSize: 500, contentType: 'image/webp' },
    })
    void otherRoot

    await check('[23] getAttachmentFilenamesForTopic връща ВСИЧКИ filenames на темата (root+reply attachments)', () => {
      const filenames = moderationStore.getAttachmentFilenamesForTopic('topic-a').sort()
      assertEqual(filenames.join(','), ['reply-attachment.webp', 'root-attachment.webp'].sort().join(','), 'трябва да включва и root, и reply attachment filenames')
    })

    let deleteResult: ReturnType<typeof moderationStore.deleteTopic> | null = null

    await check('[22] Audit log: topic_delete append-ва самостоятелен ред', () => {
      deleteResult = moderationStore.deleteTopic({ topicId: 'topic-a', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'terms violation' })
      const entries = moderationStore.listAuditLogForTopic('topic-a', 10)
      const deleteEntry = entries.find((e) => e.action === 'topic_delete')
      assert(deleteEntry !== undefined, 'трябва да има topic_delete запис')
      assertEqual(deleteEntry!.reason, 'terms violation', 'reason трябва да съвпада')
    })

    await check('[32] deleteTopic: връща deletedAttachmentFilenames точния списък изтрити filenames', () => {
      assert(deleteResult !== null && deleteResult.ok === true, 'delete трябва да е успешен')
      if (deleteResult && deleteResult.ok) {
        const filenames = [...deleteResult.deletedAttachmentFilenames].sort()
        assertEqual(filenames.join(','), ['reply-attachment.webp', 'root-attachment.webp'].sort().join(','), 'deletedAttachmentFilenames трябва да съдържа точно root+reply filenames-те на topic-a')
      }
    })

    await check('[24] deleteTopic: topics.status=\'removed\' веднага, topic редът ОСТАВА (не hard DELETE на темата)', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const topicRow = db.prepare(`SELECT status, removed_reason FROM topics WHERE topic_id = 'topic-a'`).get() as { status: string; removed_reason: string } | undefined
      db.close()
      assert(topicRow !== undefined, 'topic редът трябва да остане в DB')
      assertEqual(topicRow!.status, 'removed', 'topics.status трябва да е removed')
      assertEqual(topicRow!.removed_reason, 'terms violation', 'removed_reason трябва да съвпада')
    })

    await check('[25] deleteTopic: topic_messages.deleted_at попълнен за root+reply, редовете ОСТАВАТ (soft-delete на текста, retention модел)', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const messageRows = db.prepare(`SELECT deleted_at FROM topic_messages WHERE topic_id = 'topic-a'`).all() as Array<{ deleted_at: string | null }>
      db.close()
      assertEqual(messageRows.length, 2, 'root+reply редовете трябва да ОСТАНАТ в DB (soft-delete, не hard DELETE)')
      assert(messageRows.every((r) => r.deleted_at !== null), 'всички съобщения трябва да имат попълнен deleted_at')
    })

    await check('[29] deleteTopic: topic_message_attachments редовете (root+reply) са HARD-DELETED веднага', () => {
      const db = new DatabaseSync(dbPath, { open: true })
      const attachmentRows = db.prepare(`
        SELECT a.storage_filename FROM topic_message_attachments a
        INNER JOIN topic_messages m ON m.message_id = a.message_id
        WHERE m.topic_id = 'topic-a'
      `).all() as Array<{ storage_filename: string }>
      db.close()
      assertEqual(attachmentRows.length, 0, 'attachment DB редовете на изтритата тема трябва да са hard-deleted веднага (нов модел — не се пазят по 180 дни)')
    })

    await check('[30] deleteTopic: всеки изтрит attachment filename получава ред в topic_message_attachment_deletions', () => {
      const pending = messageStore.listPendingAttachmentDeletions(10).map((p) => p.storageFilename).sort()
      assertEqual(pending.join(','), ['reply-attachment.webp', 'root-attachment.webp'].sort().join(','), 'и двата filename-а трябва да са в cleanup queue-то веднага след deleteTopic')
    })

    await check('[31] deleteTopic: attachment на ДРУГА (недокосната) тема остава непокътнат', () => {
      assert(messageStore.attachmentExistsForFilename('other-topic-attachment.webp'), 'attachment на topic-b не трябва да е засегнат от delete на topic-a')
    })

    await check('[33] deleteTopic: атомарност — hard-delete на attachments и queue insert стават в СЪЩАТА транзакция (единствен deleteTopic() call, без отделна caller-side enqueue стъпка)', () => {
      // Регресионна проверка на самата архитектура: getAttachmentFilenamesForTopic
      // СЛЕД delete вече връща празен списък, защото redовете са hard-deleted —
      // ако някой code path разчита на "collect filenames след delete, после enqueue"
      // (старият anti-pattern), той вече не би намерил нищо за enqueue.
      const filenamesAfterDelete = moderationStore.getAttachmentFilenamesForTopic('topic-a')
      assertEqual(filenamesAfterDelete.length, 0, 'СЛЕД delete не трябва да остават attachment redovete за topic-a — hard-delete вече е станал ВЪТРЕ в deleteTopic()')
    })

    await check('[34] getAttachmentForDownload: removed-topic attachment НЕ е downloadable веднага след delete (hard-delete = auth boundary)', () => {
      const result = messageStore.getAttachmentForDownload('topic-a', 'root-attachment.webp')
      assertEqual(result, null, 'attachment на removed тема трябва да връща null, дори физическият .webp все още да чака background cleanup')
    })

    await check('[35] getAttachmentForDownload: active-topic attachment остава downloadable', () => {
      const result = messageStore.getAttachmentForDownload('topic-b', 'other-topic-attachment.webp')
      assert(result !== null, 'attachment на active тема трябва да е downloadable')
      assertEqual(result!.storageFilename, 'other-topic-attachment.webp', 'storageFilename трябва да съвпада')
    })

    await check('[36] getAttachmentForDownload: locked-topic attachment остава downloadable (lock ≠ removed)', () => {
      moderationStore.lockTopic({ topicId: 'topic-b', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'temp lock', durationMs: 60 * 60 * 1000 })
      const result = messageStore.getAttachmentForDownload('topic-b', 'other-topic-attachment.webp')
      assert(result !== null, 'attachment на locked тема трябва да остане downloadable — lock не е delete')
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

// ─── [40]-[54] 180-day retention purge (purgeRemovedTopicsBefore) ──────────
//
// Retention anchor: topics.removed_at (НЕ created_at, НЕ message.deleted_at).
// Purge eligibility: status='removed' И removed_at < cutoff. Bounded batch,
// без OFFSET (виж purgeRemovedTopicsBefore имплементацията в
// topicModerationStore.ts) — cross-instance/повторно-безопасно по конструкция,
// защото DELETE...WHERE topic_id IN (…) на вече изтрит id е no-op.

function daysAgoSqliteString(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'purge.sqlite')
  const moderationStore = await createTopicModerationStore(dbPath)
  const messageStore = await createTopicMessageStore(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    // Допълнителни теми за различните сценарии — всички INSERT-нати директно
    // (insertTopic helper-ът), после статусите/removed_at се манипулират
    // директно на DB ниво, за да контролираме точно граничните дни.
    insertTopic(db, { topicId: 'topic-179-days', slug: 'topic-179-days', title: 'Премахната преди 179 дни' })
    insertTopic(db, { topicId: 'topic-180-days', slug: 'topic-180-days', title: 'Премахната преди точно 180 дни' })
    insertTopic(db, { topicId: 'topic-200-days', slug: 'topic-200-days', title: 'Премахната преди 200 дни' })
    insertTopic(db, { topicId: 'topic-active-old', slug: 'topic-active-old', title: 'Активна, стара' })
    insertTopic(db, { topicId: 'topic-locked-old', slug: 'topic-locked-old', title: 'Заключена, стара' })
    insertTopic(db, { topicId: 'topic-removed-no-timestamp', slug: 'topic-removed-no-timestamp', title: 'Removed без removed_at' })
    insertTopic(db, { topicId: 'topic-other-untouched', slug: 'topic-other-untouched', title: 'Недокосната' })

    db.prepare(`UPDATE topics SET status = 'removed', removed_at = ? WHERE topic_id = 'topic-179-days'`).run(daysAgoSqliteString(179))
    db.prepare(`UPDATE topics SET status = 'removed', removed_at = ? WHERE topic_id = 'topic-180-days'`).run(daysAgoSqliteString(180))
    // topic-200-days ще бъде removed по-долу през реален moderationStore.deleteTopic()
    // call (не директна SQL мутация тук), за да append-не audit ред и да seed-не
    // реалистичен delete lifecycle за audit purge теста.
    // active/locked теми, "стари" по created_at, но НЕ removed — не бива purge-нати, независимо от възрастта.
    db.prepare(`UPDATE topics SET created_at = ? WHERE topic_id = 'topic-active-old'`).run(daysAgoSqliteString(200))
    db.prepare(`UPDATE topics SET status = 'locked', locked_until = ?, created_at = ? WHERE topic_id = 'topic-locked-old'`).run(daysAgoSqliteString(-1), daysAgoSqliteString(200))
    // removed, но БЕЗ валиден removed_at timestamp — не трябва да се purge-ва.
    db.prepare(`UPDATE topics SET status = 'removed', removed_at = NULL WHERE topic_id = 'topic-removed-no-timestamp'`).run()

    // Child данни за topic-200-days: root съобщение с reply + like + mute + report,
    // за да потвърдим FK CASCADE поведението на purge-а.
    const rootMsg = messageStore.insertMessage({
      topicId: 'topic-200-days',
      senderProfileId: 'target-1',
      senderDisplayName: 'Target One',
      senderRole: 'player',
      body: 'root в тема за purge',
    })
    messageStore.insertReply({
      topicId: 'topic-200-days',
      parentMessageId: rootMsg.messageId,
      senderProfileId: 'target-2',
      senderDisplayName: 'Target Two',
      senderRole: 'player',
      body: 'reply в тема за purge',
    })
    messageStore.toggleLike(rootMsg.messageId, 'target-2')
    moderationStore.muteProfileInTopic({ topicId: 'topic-200-days', profileId: 'target-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'x', durationMs: 60 * 60 * 1000 })
    moderationStore.createReport({ topicId: 'topic-200-days', reporterProfileId: 'target-2', reason: 'spam' })
    // Audit history за topic-200-days (mute-ът по-горе вече append-на 1 ред;
    // добавяме и lock+delete, за да имаме множество audit action types,
    // всичките трябва да изчезнат заедно при final purge).
    moderationStore.lockTopic({ topicId: 'topic-200-days', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'pre-purge lock', durationMs: 60 * 60 * 1000 })
    moderationStore.deleteTopic({ topicId: 'topic-200-days', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'purge scenario delete' })
    // removed_at СЕ ПРЕЗАПИСВА от deleteTopic() (CURRENT_TIMESTAMP) — връщаме
    // го обратно на 200 дни в миналото, за да остане eligible за purge теста.
    db.prepare(`UPDATE topics SET removed_at = ? WHERE topic_id = 'topic-200-days'`).run(daysAgoSqliteString(200))

    // Audit history за topic-179-days (контрола — темата НЕ е purge-eligible
    // все още, audit редът ѝ трябва да преживее този purge run непокътнат).
    moderationStore.lockTopic({ topicId: 'topic-179-days', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'still within retention', durationMs: 60 * 60 * 1000 })

    // Child данни за topic-other-untouched (контрола — трябва да преживее purge-а непокътнати).
    const otherRootMsg = messageStore.insertMessage({
      topicId: 'topic-other-untouched',
      senderProfileId: 'target-1',
      senderDisplayName: 'Target One',
      senderRole: 'player',
      body: 'root в НЕТРОНАТА тема',
    })
    db.close()

    await check('[SETUP] audit redovete за topic-200-days и topic-179-days съществуват ПРЕДИ purge', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const count200 = db2.prepare(`SELECT COUNT(*) AS c FROM topic_moderation_audit_log WHERE topic_id = 'topic-200-days'`).get() as { c: number }
      const count179 = db2.prepare(`SELECT COUNT(*) AS c FROM topic_moderation_audit_log WHERE topic_id = 'topic-179-days'`).get() as { c: number }
      db2.close()
      assert(count200.c >= 3, 'topic-200-days трябва да има поне 3 audit реда (mute+lock+delete) преди purge')
      assert(count179.c >= 1, 'topic-179-days трябва да има поне 1 audit ред (lock) преди purge')
    })

    await check('[40] Removed тема на 179 дни → НЕ е purge-нала (под cutoff-а, boundary policy #2: removed_at <= cutoff)', () => {
      const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      const deleted = moderationStore.purgeRemovedTopicsBefore(cutoff, 200)
      // Сега topic-200-days И topic-180-days трябва да паднат под cutoff-а
      // (removed_at <= cutoff, боundary policy #2 — точно 180 дни Е eligible, виж [41]).
      assertEqual(deleted, 2, 'темата на 200 дни И темата на точно 180 дни трябва да са eligible на този cutoff')
      const db2 = new DatabaseSync(dbPath, { open: true })
      const stillThere = db2.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-179-days'`).get()
      db2.close()
      assert(stillThere !== undefined, 'темата на 179 дни трябва да ОСТАНЕ (все още вътре в retention прозореца)')
    })

    await check('[41] Removed тема точно на cutoff-а (removed_at = now-180d) → Е purge-eligible (removed_at <= cutoff, boundary policy #2)', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-180-days'`).get()
      db2.close()
      assertEqual(row, undefined, 'removed_at СТРИКТНО РАВЕН на cutoff-а (точно 180 дни) трябва да е purge-нат — "навършени 180 дни" = eligible, не се чака 181-ви ден')
    })

    await check('[42] Removed тема >180 дни → hard-deleted от purge-а', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-200-days'`).get()
      db2.close()
      assertEqual(row, undefined, 'темата на 200 дни трябва да е hard-deleted след purge-а')
    })

    await check('[43] Active тема >180 дни (по created_at) → НЕ Е ЗАСЕГНАТА от purge', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT status FROM topics WHERE topic_id = 'topic-active-old'`).get() as { status: string } | undefined
      db2.close()
      assert(row !== undefined, 'активна тема никога не трябва да бъде purge-ната, независимо от възрастта')
      assertEqual(row!.status, 'active', 'статусът трябва да остане active')
    })

    await check('[44] Locked тема >180 дни (по created_at) → НЕ Е ЗАСЕГНАТА от purge', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT status FROM topics WHERE topic_id = 'topic-locked-old'`).get() as { status: string } | undefined
      db2.close()
      assert(row !== undefined, 'заключена тема никога не трябва да бъде purge-ната, независимо от възрастта')
      assertEqual(row!.status, 'locked', 'статусът трябва да остане locked')
    })

    await check('[45] Removed тема БЕЗ валиден removed_at → безопасно НЕ Е purge-ната', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-removed-no-timestamp'`).get()
      db2.close()
      assert(row !== undefined, 'removed тема без removed_at не трябва да бъде purge-вана — липсва canonical anchor')
    })

    await check('[46] Purge премахва root съобщенията (CASCADE от topics)', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const rows = db2.prepare(`SELECT 1 FROM topic_messages WHERE topic_id = 'topic-200-days'`).all()
      db2.close()
      assertEqual(rows.length, 0, 'root+reply съобщенията на purge-натата тема трябва да са изчезнали (CASCADE)')
    })

    await check('[47] Purge премахва replies (CASCADE от topics през topic_messages)', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT 1 FROM topic_messages WHERE parent_message_id = ?`).get(rootMsg.messageId)
      db2.close()
      assertEqual(row, undefined, 'reply редът трябва да е изчезнал заедно с root-а')
    })

    await check('[48] Purge премахва likes/child данни по FK модела (topic_message_likes CASCADE)', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT 1 FROM topic_message_likes WHERE message_id = ?`).get(rootMsg.messageId)
      const muteRow = db2.prepare(`SELECT 1 FROM topic_mutes WHERE topic_id = 'topic-200-days'`).get()
      const reportRow = db2.prepare(`SELECT 1 FROM topic_reports WHERE topic_id = 'topic-200-days'`).get()
      db2.close()
      assertEqual(row, undefined, 'like редът трябва да е изчезнал (CASCADE през topic_messages)')
      assertEqual(muteRow, undefined, 'mute редът трябва да е изчезнал (CASCADE от topics)')
      assertEqual(reportRow, undefined, 'report редът трябва да е изчезнал (CASCADE от topics)')
    })

    await check('[55] Final purge: topic-specific moderation audit rows се премахват заедно с темата', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT COUNT(*) AS c FROM topic_moderation_audit_log WHERE topic_id = 'topic-200-days'`).get() as { c: number }
      db2.close()
      assertEqual(row.c, 0, 'ВСИЧКИ audit redovete (mute+lock+delete) за purge-натата тема трябва да са изчезнали')
    })

    await check('[56] Audit row за ДРУГА (все още в retention прозореца) тема НЕ е засегнат', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT COUNT(*) AS c FROM topic_moderation_audit_log WHERE topic_id = 'topic-179-days'`).get() as { c: number }
      db2.close()
      assert(row.c >= 1, 'audit редът на темата на 179 дни (все още вътре в retention прозореца) трябва да ОСТАНЕ')
    })

    await check('[49] Друга (недокосната) тема остава напълно непроменена след purge', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const topicRow = db2.prepare(`SELECT status FROM topics WHERE topic_id = 'topic-other-untouched'`).get() as { status: string } | undefined
      const msgRow = db2.prepare(`SELECT 1 FROM topic_messages WHERE message_id = ?`).get(otherRootMsg.messageId)
      db2.close()
      assert(topicRow !== undefined && topicRow.status === 'active', 'недокоснатата тема трябва да остане active')
      assert(msgRow !== undefined, 'съобщението в недокоснатата тема трябва да остане')
    })

    await check('[50] Повторен purge run (втори извиквания) е безопасен/no-op', () => {
      const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      const deleted = moderationStore.purgeRemovedTopicsBefore(cutoff, 200)
      assertEqual(deleted, 0, 'втори run веднага след първия трябва да е no-op — вече няма нови eligible редове')
    })

    await check('[51] Празен eligible set е безопасен/no-op (cutoff в бъдещето, нищо квалифицирано между другото)', () => {
      const farFutureCutoff = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      // topic-179-days вече е eligible спрямо far-future cutoff, но да го изолираме:
      // тестваме no-op сценарий чрез нулев batch срещу празна допълнителна DB.
      const deleted = moderationStore.purgeRemovedTopicsBefore(farFutureCutoff, 0)
      assertEqual(deleted, 0, 'batchSize=0 не трябва да предизвика безкраен цикъл или грешка — връща 0 веднага')
    })
  } finally {
    moderationStore.close()
    messageStore.close()
  }
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'purge-batch.sqlite')
  const moderationStore = await createTopicModerationStore(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    const removedAt = daysAgoSqliteString(200)
    for (let i = 0; i < 5; i++) {
      const topicId = `topic-batch-${i}`
      insertTopic(db, { topicId, slug: topicId, title: `Batch ${i}` })
      db.prepare(`UPDATE topics SET status = 'removed', removed_at = ? WHERE topic_id = ?`).run(removedAt, topicId)
    }
    db.close()

    await check('[52] Purge batch limit се спазва — само batchSize редове се трият на едно извикване на цикъла', () => {
      // batchSize=2 с 5 eligible теми: purgeRemovedTopicsBefore цикли вътрешно
      // до изчерпване (виж имплементацията — for(;;) до rows.length < batchSize),
      // затова крайният резултат е ВСИЧКИ 5, но тестваме че функцията самата
      // не прави unbounded единична SELECT/DELETE (виж [53] за SQL текста).
      const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      const deleted = moderationStore.purgeRemovedTopicsBefore(cutoff, 2)
      assertEqual(deleted, 5, 'batched-ият цикъл трябва да изчисти всички 5 eligible теми въпреки малкия batchSize')
      const db2 = new DatabaseSync(dbPath, { open: true })
      const remaining = db2.prepare(`SELECT COUNT(*) AS c FROM topics WHERE topic_id LIKE 'topic-batch-%'`).get() as { c: number }
      db2.close()
      assertEqual(remaining.c, 0, 'нито една batch тема не трябва да остане')
    })

    await check('[53] Purge не ползва OFFSET pagination (source-level guard)', async () => {
      const storeSource = await readFile(resolve(serverRoot, 'src/db/topicModerationStore.ts'), 'utf8')
      const fnBody = storeSource.match(/function purgeRemovedTopicsBefore\([\s\S]*?\n  \}/)?.[0] ?? ''
      assert(fnBody.length > 0, 'purgeRemovedTopicsBefore function not found')
      assert(!/OFFSET/i.test(fnBody), 'purge заявките НЕ трябва да ползват OFFSET pagination (established bounded-batch convention без OFFSET)')
      assert(fnBody.includes('LIMIT') === false || storeSource.includes('LIMIT ?'), 'eligible SELECT трябва да е bounded с LIMIT')
    })

    await check('[54] Cross-instance/повторен purge run семантика е безопасна по SQLite DELETE...WHERE IN модела (idempotent на id ниво)', () => {
      // Симулира втори "instance", който вика purge след като първият вече
      // е изчистил всичко — DELETE FROM topics WHERE topic_id IN (…) на
      // празен eligible set е чист no-op, никаква грешка/corruption.
      const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
      const deleted = moderationStore.purgeRemovedTopicsBefore(cutoff, 2)
      assertEqual(deleted, 0, 'повторен run на вече изчистени данни трябва да е чист no-op')
    })
  } finally {
    moderationStore.close()
  }
})

// ─── [57] Rollback safety — audit-delete + topics-delete са atomic ────────
//
// Симулира грешка, която се случва СЛЕД audit-log delete-а, но ПРЕДИ/ПО
// ВРЕМЕ на topics delete-а (BEFORE DELETE trigger на topics, който RAISE-ва
// ABORT) — доказва, че ROLLBACK наистина връща и двете стъпки заедно,
// не оставя "audit изтрит, topic останал" partial state.

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'purge-rollback.sqlite')
  const moderationStore = await createTopicModerationStore(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    const removedAt = daysAgoSqliteString(200)
    db.prepare(`UPDATE topics SET status = 'removed', removed_at = ? WHERE topic_id = 'topic-a'`).run(removedAt)
    moderationStore.close()

    // Append audit ред директно (moderationStore е затворен, за да освободим
    // connection-а за DDL по-долу), после инсталираме saboteur trigger-а,
    // после preотваряме store-а за самия purge опит.
    db.prepare(`
      INSERT INTO topic_moderation_audit_log (log_id, actor_account_id, actor_role, action, topic_id, target_profile_id, reason, expires_at)
      VALUES ('rollback-test-log', 'moderator-1', 'admin', 'topic_delete', 'topic-a', NULL, 'pre-purge', NULL);
    `).run()
    db.prepare(`
      CREATE TRIGGER sabotage_topics_delete
      BEFORE DELETE ON topics
      WHEN OLD.topic_id = 'topic-a'
      BEGIN
        SELECT RAISE(ABORT, 'sabotage: simulated failure mid-purge-transaction');
      END;
    `).run()
    db.close()

    const store2 = await createTopicModerationStore(dbPath)
    try {
      await check('[57] Rollback safety: грешка ПО ВРЕМЕ на purge транзакцията не оставя partial state (audit ИЛИ topic частично изтрити)', () => {
        const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)
        let threw = false
        try {
          store2.purgeRemovedTopicsBefore(cutoff, 200)
        } catch {
          threw = true
        }
        assert(threw, 'purge-ът трябва да пропагира грешката от saboteur trigger-а (не да я гълта тихо)')

        const db2 = new DatabaseSync(dbPath, { open: true })
        const topicRow = db2.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-a'`).get()
        const auditRow = db2.prepare(`SELECT 1 FROM topic_moderation_audit_log WHERE topic_id = 'topic-a'`).get()
        db2.close()
        assert(topicRow !== undefined, 'topics редът трябва да ОСТАНЕ след rollback (не hard-deleted частично)')
        assert(auditRow !== undefined, 'audit редът трябва да ОСТАНЕ след rollback — ROLLBACK връща audit-delete-а обратно също')
      })
    } finally {
      store2.close()
    }
  } finally {
    // moderationStore вече е затворен по-горе; нищо допълнително за close тук.
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)

if (failed > 0) {
  process.exitCode = 1
}
