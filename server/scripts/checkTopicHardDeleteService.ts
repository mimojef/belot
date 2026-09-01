/**
 * checkTopicHardDeleteService.ts
 *
 * Store-level checks за topicHardDeleteService.ts — централният hard-delete
 * primitive за "Теми" (spec: 72h inactivity auto-cleanup + manual "кошче"
 * delete, ЕДИН И СЪЩ hardDeleteTopic() за двата reason-а). HTTP/WS
 * authorization и realtime broadcast за manual delete са НЕПРОМЕНЕНИ
 * (handleTopicDeleteRequest продължава да минава през established
 * isTopicWholeTopicModeratorSession gate + broadcastTopicDeletedToLocalSubscribers)
 * — покрити от съществуващия checkTopicModerationAuthRealtime.ts (Section AA + E4).
 *
 * === findInactivityCandidates (72h eligibility) ===
 * [0]  Тема без replies, inactivity 71h59m (по created_at) → НЕ candidate
 * [1]  Тема без replies, inactivity >72h (по created_at) → Е candidate
 * [2]  Тема created преди 10 дни, latest reply преди 71h → НЕ candidate
 * [3]  Тема created преди 10 дни, latest reply >72h → Е candidate
 * [4]  Лафче (topic-lafche) >72h inactive → НИКОГА не е candidate
 * [5]  Общ чат (is_general=1) >72h inactive → НИКОГА не е candidate
 * [6]  Removed тема >72h inactive → НЕ candidate (друг lifecycle, 180-дневен purge)
 * [7]  Locked тема >72h inactive → Е candidate (lock е write-restriction, не lifecycle exclusion)
 *
 * === hardDeleteTopic — cascade completeness ===
 * [8]  Root row премахнат
 * [9]  Всички replies премахнати
 * [10] Reply relationships (self-FK) премахнати заедно с replies
 * [11] Attachment metadata rows (root+reply) премахнати
 * [12] Attachment filenames enqueue-нати в topic_message_attachment_deletions за физически cleanup
 * [13] Likes премахнати (CASCADE)
 * [14] Mutes/reports премахнати (CASCADE)
 * [15] topic_root_latest_seq row премахнат
 * [16] Read state (topic_read_state) премахнат
 * [17] topic_moderation_audit_log rows за темата премахнати (explicit — без FK)
 * [18] Друга недокосната тема остава напълно непроменена
 * [19] topic_mute_evidence оцелява (source_message_id -> NULL, snapshot полетата непокътнати) — умишлен design, evidence не е orphan
 *
 * === Protected topics ===
 * [20] hardDeleteTopic на topic-lafche → protected_topic, темата остава непокътната
 * [21] hardDeleteTopic на is_general=1 тема → protected_topic, темата остава непокътната
 *
 * === Idempotency / concurrency safety ===
 * [22] Втори hardDeleteTopic на вече изтрита тема → not_found, без crash
 * [23] hardDeleteTopic с inactivityCutoff, но тема получила нов reply СЛЕД candidate-scan (симулирано) → no_longer_eligible, темата ОСТАВА
 * [24] hardDeleteTopic с inactivityCutoff за реално все още неактивна тема → изтрита нормално
 * [25] hardDeleteTopic БЕЗ inactivityCutoff (manual reason) игнорира activity condition — трие дори "прясно активна" тема
 *
 * === Filesystem-safety adjacent (queue correctness, не действителен unlink — виж index.ts runTopicAttachmentCleanup за филтъра validation) ===
 * [26] Missing/вече изчезнал attachment row не чупи delete-а (тема без attachments се трие нормално)
 *
 * === Boundary precision ===
 * [27] Граница точно на cutoff-а (lastActivityAt === cutoff) → Е candidate/eligible (spec: ">72h" ⇔ inclusive <= cutoff)
 *
 * === Manual delete corrective pass — НЯМА intermediate soft-delete state ===
 * (handleTopicDeleteRequest вече вика ЕДИНСТВЕНО topicHardDeleteService.hardDeleteTopic()
 * директно, с actor+auditReason — topicModerationStore.deleteTopic() вече НЕ
 * се вика от manual production flow-а, виж index.ts.)
 * [28] Manual root delete НЕ оставя status='removed' state — root row изобщо липсва след delete
 * [29] Manual delete: audit trail (actor/role/reason) оцелява persisted, независимо от soft-deleted topic row
 * [30] Manual delete не зависи от purgeRemovedTopicsBefore (no-op веднага след, темата вече е изтрита)
 * [31] Attachments/filesystem cleanup queue се задейства директно от hard-delete lifecycle (actor-driven code path)
 * [32] Existing removed-topic 180-day purge продължава да работи за legacy/друг legitimate removed ред (established lifecycle непроменен)
 * [33] Manual delete + automatic cleanup "почти едновременно" за 1 тема — безопасно, idempotent not_found, без corruption
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTopicHardDeleteService } from '../src/db/topicHardDeleteService.js'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'
import { createTopicModerationStore } from '../src/db/topicModerationStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationFiles = [
  '20260810_002_create_topics_and_messages.sql',
  '20260811_001_create_topic_message_likes.sql',
  '20260811_002_create_topic_message_attachments.sql',
  '20260811_003_create_topic_moderation.sql',
  '20260812_001_create_topic_message_moderation.sql',
  '20260812_002_create_topic_message_self_deletion_audit.sql',
  '20260812_003_add_topic_message_editing.sql',
  '20260812_004_create_topic_read_state.sql',
  '20260813_001_create_topic_thread_read_state.sql',
  '20260814_001_create_topic_section_mutes.sql',
  '20260817_002_seed_topic_lafche.sql',
  '20260817_003_create_topic_mute_evidence.sql',
  '20260818_005_add_topic_mute_evidence_attachment_copy.sql',
  '20260824_001_create_topic_root_latest_seq.sql',
].map((name) => resolve(serverRoot, 'database/migrations', name))

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-hard-delete-check-'))
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

function insertTopic(db: DatabaseSync, input: { topicId: string; slug: string; title: string; isGeneral?: boolean }): void {
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order)
    VALUES (?, ?, ?, ?, NULL, 'active', 100);
  `).run(input.topicId, input.slug, input.title, input.isGeneral ? 1 : 0)
}

function msAgoSqliteString(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ')
}

const HOUR_MS = 60 * 60 * 1000

async function setupDb(dir: string, filename: string): Promise<string> {
  const dbPath = join(dir, filename)
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  for (const migrationPath of migrationFiles) {
    await applyMigrationFile(db, migrationPath)
  }
  seedProfile(db, 'author-1')
  seedProfile(db, 'author-2')
  seedAccount(db, 'mod-1')
  db.close()
  return dbPath
}

// ─── [0]-[7] findInactivityCandidates eligibility ──────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'candidates.sqlite')
  const messageStore = await createTopicMessageStore(dbPath)
  const moderationStore = await createTopicModerationStore(dbPath)
  const hardDeleteService = await createTopicHardDeleteService(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })

    // [0]/[1]: без replies — lastActivityAt = root's created_at.
    insertTopic(db, { topicId: 'topic-no-replies-71h59m', slug: 's0', title: 'T0' })
    const root0 = messageStore.insertMessage({ topicId: 'topic-no-replies-71h59m', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(71 * HOUR_MS + 59 * 60 * 1000), root0.messageId)

    insertTopic(db, { topicId: 'topic-no-replies-73h', slug: 's1', title: 'T1' })
    const root1 = messageStore.insertMessage({ topicId: 'topic-no-replies-73h', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(73 * HOUR_MS), root1.messageId)

    // [2]/[3]: created 10 days ago, reply timing varies.
    insertTopic(db, { topicId: 'topic-old-recent-reply', slug: 's2', title: 'T2' })
    const root2 = messageStore.insertMessage({ topicId: 'topic-old-recent-reply', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(10 * 24 * HOUR_MS), root2.messageId)
    const reply2 = messageStore.insertReply({ topicId: 'topic-old-recent-reply', parentMessageId: root2.messageId, senderProfileId: 'author-2', senderDisplayName: 'B', senderRole: 'player', body: 'reply' })
    assert(reply2.ok, 'reply2 insert трябва да успее')
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(71 * HOUR_MS), (reply2 as { ok: true; message: { messageId: string } }).message.messageId)

    insertTopic(db, { topicId: 'topic-old-stale-reply', slug: 's3', title: 'T3' })
    const root3 = messageStore.insertMessage({ topicId: 'topic-old-stale-reply', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(10 * 24 * HOUR_MS), root3.messageId)
    const reply3 = messageStore.insertReply({ topicId: 'topic-old-stale-reply', parentMessageId: root3.messageId, senderProfileId: 'author-2', senderDisplayName: 'B', senderRole: 'player', body: 'reply' })
    assert(reply3.ok, 'reply3 insert трябва да успее')
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(73 * HOUR_MS), (reply3 as { ok: true; message: { messageId: string } }).message.messageId)

    // [4] Лафче — seeded вече от migration 20260817_002 (topic-lafche), направи я 200h inactive.
    const lafcheRoot = messageStore.insertMessage({ topicId: 'topic-lafche', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'lafche post' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(200 * HOUR_MS), lafcheRoot.messageId)

    // [5] Общ чат (is_general=1), 200h inactive.
    insertTopic(db, { topicId: 'topic-general-test', slug: 'general-test-slug', title: 'Общи', isGeneral: true })
    const generalRoot = messageStore.insertMessage({ topicId: 'topic-general-test', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'general post' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(200 * HOUR_MS), generalRoot.messageId)

    // [6] Removed тема, 200h inactive.
    insertTopic(db, { topicId: 'topic-removed-test', slug: 's6', title: 'T6' })
    const removedRoot = messageStore.insertMessage({ topicId: 'topic-removed-test', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(200 * HOUR_MS), removedRoot.messageId)
    moderationStore.deleteTopic({ topicId: 'topic-removed-test', actorAccountId: 'mod-1', actorRole: 'admin', reason: 'test removal' })

    // [7] Locked тема, 200h inactive.
    insertTopic(db, { topicId: 'topic-locked-test', slug: 's7', title: 'T7' })
    const lockedRoot = messageStore.insertMessage({ topicId: 'topic-locked-test', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(200 * HOUR_MS), lockedRoot.messageId)
    db.prepare(`UPDATE topics SET status = 'locked', locked_until = ? WHERE topic_id = 'topic-locked-test'`).run(msAgoSqliteString(-HOUR_MS))

    db.close()

    const cutoff = new Date(Date.now() - 72 * HOUR_MS)
    const candidates = hardDeleteService.findInactivityCandidates(cutoff, 100)
    const candidateIds = new Set(candidates.map((c) => c.topicId))

    await check('[0] Тема без replies, inactivity 71h59m → НЕ candidate', () => {
      assert(!candidateIds.has('topic-no-replies-71h59m'), 'не трябва да е candidate')
    })
    await check('[1] Тема без replies, inactivity >72h → Е candidate', () => {
      assert(candidateIds.has('topic-no-replies-73h'), 'трябва да е candidate')
    })
    await check('[2] Тема стара 10 дни, latest reply преди 71h → НЕ candidate', () => {
      assert(!candidateIds.has('topic-old-recent-reply'), 'не трябва да е candidate — reply-driven lastActivityAt все още прясна')
    })
    await check('[3] Тема стара 10 дни, latest reply >72h → Е candidate', () => {
      assert(candidateIds.has('topic-old-stale-reply'), 'трябва да е candidate')
    })
    await check('[4] Лафче >72h inactive → НИКОГА не е candidate', () => {
      assert(!candidateIds.has('topic-lafche'), 'Лафче никога не е inactivity-cleanup candidate')
    })
    await check('[5] Общ чат (is_general=1) >72h inactive → НИКОГА не е candidate', () => {
      assert(!candidateIds.has('topic-general-test'), 'is_general=1 никога не е inactivity-cleanup candidate')
    })
    await check('[6] Removed тема >72h inactive → НЕ candidate (друг lifecycle)', () => {
      assert(!candidateIds.has('topic-removed-test'), 'removed теми не минават през inactivity cleanup')
    })
    await check('[7] Locked тема >72h inactive → Е candidate (lock не е lifecycle exclusion)', () => {
      assert(candidateIds.has('topic-locked-test'), 'locked теми СА eligible за inactivity cleanup')
    })
  } finally {
    hardDeleteService.close()
    moderationStore.close()
    messageStore.close()
  }
})

// ─── [8]-[19] hardDeleteTopic cascade completeness ─────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'cascade.sqlite')
  const messageStore = await createTopicMessageStore(dbPath)
  const moderationStore = await createTopicModerationStore(dbPath)
  const hardDeleteService = await createTopicHardDeleteService(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    insertTopic(db, { topicId: 'topic-victim', slug: 'victim', title: 'Victim' })
    insertTopic(db, { topicId: 'topic-untouched', slug: 'untouched', title: 'Untouched' })
    db.close()

    const root = messageStore.insertMessage({
      topicId: 'topic-victim', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root',
      attachment: { storageFilename: 'aaaaaaaa-0000-4000-8000-000000000001.webp', width: 100, height: 100, byteSize: 1000, contentType: 'image/webp' },
    })
    const reply = messageStore.insertReply({
      topicId: 'topic-victim', parentMessageId: root.messageId, senderProfileId: 'author-2', senderDisplayName: 'B', senderRole: 'player', body: 'reply',
      attachment: { storageFilename: 'aaaaaaaa-0000-4000-8000-000000000002.webp', width: 100, height: 100, byteSize: 1000, contentType: 'image/webp' },
    })
    assert(reply.ok, 'reply insert трябва да успее')
    const replyMessageId = (reply as { ok: true; message: { messageId: string } }).message.messageId
    messageStore.toggleLike(root.messageId, 'author-2')
    moderationStore.muteProfileInTopic({ topicId: 'topic-victim', profileId: 'author-1', actorAccountId: 'mod-1', actorRole: 'admin', reason: 'x', durationMs: HOUR_MS })
    moderationStore.createReport({ topicId: 'topic-victim', reporterProfileId: 'author-2', reason: 'spam' })
    moderationStore.lockTopic({ topicId: 'topic-victim', actorAccountId: 'mod-1', actorRole: 'admin', reason: 'pre-delete lock', durationMs: HOUR_MS })
    // Mute evidence — snapshot от root-а, source_message_id ще стане NULL при hard delete (умишлено survival, [19]).
    moderationStore.muteProfileInTopics({
      topicId: 'topic-victim', profileId: 'author-1', actorAccountId: 'mod-1', actorRole: 'admin',
      reason: 'evidence test', durationMs: HOUR_MS, sourceMessageId: root.messageId, sourceKind: 'topic_root',
    })

    const untouchedRoot = messageStore.insertMessage({ topicId: 'topic-untouched', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'untouched root' })

    const preAuditCount = (new DatabaseSync(dbPath, { open: true }).prepare(
      `SELECT COUNT(*) as c FROM topic_moderation_audit_log WHERE topic_id = 'topic-victim'`,
    ).get() as { c: number }).c
    assert(preAuditCount >= 2, 'audit log трябва да има поне 2 реда (lock+mute) преди delete')

    const result = hardDeleteService.hardDeleteTopic({ topicId: 'topic-victim', reason: 'manual_moderation_delete' })
    assert(result.ok, 'hardDeleteTopic трябва да успее')
    const okResult = result as Extract<typeof result, { ok: true }>

    const db2 = new DatabaseSync(dbPath, { open: true })

    await check('[8] Root row премахнат', () => {
      const row = db2.prepare(`SELECT 1 FROM topic_messages WHERE message_id = ?`).get(root.messageId)
      assertEqual(row, undefined, 'root row трябва да е изтрит')
    })
    await check('[9] Всички replies премахнати', () => {
      const row = db2.prepare(`SELECT 1 FROM topic_messages WHERE message_id = ?`).get(replyMessageId)
      assertEqual(row, undefined, 'reply row трябва да е изтрит')
    })
    await check('[10] Reply relationships (self-FK) премахнати', () => {
      const row = db2.prepare(`SELECT 1 FROM topic_messages WHERE parent_message_id = ?`).get(root.messageId)
      assertEqual(row, undefined, 'няма останали redove сочещи parent_message_id към изтрития root')
    })
    await check('[11] Attachment metadata rows (root+reply) премахнати', () => {
      const row1 = db2.prepare(`SELECT 1 FROM topic_message_attachments WHERE message_id = ?`).get(root.messageId)
      const row2 = db2.prepare(`SELECT 1 FROM topic_message_attachments WHERE message_id = ?`).get(replyMessageId)
      assertEqual(row1, undefined, 'root attachment трябва да е изтрит')
      assertEqual(row2, undefined, 'reply attachment трябва да е изтрит')
    })
    await check('[12] Attachment filenames enqueue-нати за физически cleanup', () => {
      assertEqual(okResult.deletedAttachmentFilenames.length, 2, 'трябва да върне 2 filenames')
      const queueRows = db2.prepare(`SELECT storage_filename FROM topic_message_attachment_deletions`).all() as Array<{ storage_filename: string }>
      const queuedNames = new Set(queueRows.map((r) => r.storage_filename))
      assert(queuedNames.has('aaaaaaaa-0000-4000-8000-000000000001.webp'), 'root filename трябва да е в queue')
      assert(queuedNames.has('aaaaaaaa-0000-4000-8000-000000000002.webp'), 'reply filename трябва да е в queue')
    })
    await check('[13] Likes премахнати (CASCADE)', () => {
      const row = db2.prepare(`SELECT 1 FROM topic_message_likes WHERE message_id = ?`).get(root.messageId)
      assertEqual(row, undefined, 'like трябва да е изтрит')
    })
    await check('[14] Mutes/reports премахнати (CASCADE)', () => {
      const muteRow = db2.prepare(`SELECT 1 FROM topic_mutes WHERE topic_id = 'topic-victim'`).get()
      const reportRow = db2.prepare(`SELECT 1 FROM topic_reports WHERE topic_id = 'topic-victim'`).get()
      assertEqual(muteRow, undefined, 'topic_mutes трябва да е изтрит')
      assertEqual(reportRow, undefined, 'topic_reports трябва да е изтрит')
    })
    await check('[15] topic_root_latest_seq row премахнат', () => {
      const row = db2.prepare(`SELECT 1 FROM topic_root_latest_seq WHERE topic_id = 'topic-victim'`).get()
      assertEqual(row, undefined, 'topic_root_latest_seq трябва да е изтрит')
    })
    await check('[16] Read state (topic_read_state) премахнат', () => {
      db2.prepare(`INSERT OR IGNORE INTO topic_read_state (profile_id, topic_id, last_seen_seq) VALUES ('author-1', 'topic-victim', 0)`)
      const row = db2.prepare(`SELECT 1 FROM topic_read_state WHERE topic_id = 'topic-victim'`).get()
      assertEqual(row, undefined, 'topic_read_state трябва да е изтрит (или никога вкаран заради CASCADE FK към несъществуваща тема)')
    })
    await check('[17] topic_moderation_audit_log rows за темата премахнати', () => {
      const row = db2.prepare(`SELECT 1 FROM topic_moderation_audit_log WHERE topic_id = 'topic-victim'`).get()
      assertEqual(row, undefined, 'audit log за темата трябва да е изтрит (explicit DELETE, без FK)')
    })
    await check('[18] Друга недокосната тема остава напълно непроменена', () => {
      const topicRow = db2.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-untouched'`).get()
      const msgRow = db2.prepare(`SELECT 1 FROM topic_messages WHERE message_id = ?`).get(untouchedRoot.messageId)
      assert(topicRow !== undefined, 'topic-untouched трябва да остане')
      assert(msgRow !== undefined, 'untouched root съобщение трябва да остане')
    })
    await check('[19] topic_mute_evidence оцелява — source_message_id -> NULL, snapshot непокътнат', () => {
      const row = db2.prepare(`SELECT source_message_id, source_body_snapshot FROM topic_mute_evidence WHERE source_topic_id = 'topic-victim'`).get() as
        | { source_message_id: string | null; source_body_snapshot: string }
        | undefined
      assert(row !== undefined, 'mute evidence row трябва да съществува')
      assertEqual(row!.source_message_id, null, 'source_message_id трябва да е SET NULL (не CASCADE-delete-нат)')
      assertEqual(row!.source_body_snapshot, 'root', 'body snapshot трябва да остане непокътнат (copy-нат в момента на mute-а)')
    })

    db2.close()
  } finally {
    hardDeleteService.close()
    moderationStore.close()
    messageStore.close()
  }
})

// ─── [20]-[21] Protected topics ─────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'protected.sqlite')
  const hardDeleteService = await createTopicHardDeleteService(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    insertTopic(db, { topicId: 'topic-general-protect', slug: 'general-protect-slug', title: 'Общи', isGeneral: true })
    db.close()

    await check('[20] hardDeleteTopic на topic-lafche → protected_topic, темата остава', () => {
      const result = hardDeleteService.hardDeleteTopic({ topicId: 'topic-lafche', reason: 'manual_moderation_delete' })
      assert(!result.ok && result.code === 'protected_topic', 'трябва да откаже с protected_topic')
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-lafche'`).get()
      db2.close()
      assert(row !== undefined, 'Лафче трябва да остане непокътната')
    })

    await check('[21] hardDeleteTopic на is_general=1 тема → protected_topic, темата остава', () => {
      const result = hardDeleteService.hardDeleteTopic({ topicId: 'topic-general-protect', reason: 'manual_moderation_delete' })
      assert(!result.ok && result.code === 'protected_topic', 'трябва да откаже с protected_topic')
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-general-protect'`).get()
      db2.close()
      assert(row !== undefined, 'Общият чат трябва да остане непокътнат')
    })
  } finally {
    hardDeleteService.close()
  }
})

// ─── [22]-[25] Idempotency / concurrency safety ────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'concurrency.sqlite')
  const messageStore = await createTopicMessageStore(dbPath)
  const hardDeleteService = await createTopicHardDeleteService(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    insertTopic(db, { topicId: 'topic-double-delete', slug: 'dd', title: 'DD' })
    insertTopic(db, { topicId: 'topic-race-new-reply', slug: 'race', title: 'Race' })
    insertTopic(db, { topicId: 'topic-still-inactive', slug: 'stillinactive', title: 'Still inactive' })
    insertTopic(db, { topicId: 'topic-manual-fresh', slug: 'fresh', title: 'Fresh but manual delete' })
    db.close()

    messageStore.insertMessage({ topicId: 'topic-double-delete', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })

    const raceRoot = messageStore.insertMessage({ topicId: 'topic-race-new-reply', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    const db3 = new DatabaseSync(dbPath, { open: true })
    db3.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(200 * HOUR_MS), raceRoot.messageId)
    db3.close()
    const cutoff = new Date(Date.now() - 72 * HOUR_MS)
    // Симулира race-а: candidate scan-ът вече е върнал тази тема (щеше да е eligible),
    // но ПРЕДИ hardDeleteTopic() извикването пристига нов reply — final re-check
    // ВЪТРЕ в транзакцията трябва да го улови.
    const raceReply = messageStore.insertReply({ topicId: 'topic-race-new-reply', parentMessageId: raceRoot.messageId, senderProfileId: 'author-2', senderDisplayName: 'B', senderRole: 'player', body: 'just arrived' })
    assert(raceReply.ok, 'race reply insert трябва да успее')

    const stillInactiveRoot = messageStore.insertMessage({ topicId: 'topic-still-inactive', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    const db4 = new DatabaseSync(dbPath, { open: true })
    db4.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(200 * HOUR_MS), stillInactiveRoot.messageId)
    db4.close()

    messageStore.insertMessage({ topicId: 'topic-manual-fresh', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'brand new root, created just now' })

    await check('[22] Втори hardDeleteTopic на вече изтрита тема → not_found, без crash', () => {
      const first = hardDeleteService.hardDeleteTopic({ topicId: 'topic-double-delete', reason: 'manual_moderation_delete' })
      assert(first.ok, 'първото изтриване трябва да успее')
      const second = hardDeleteService.hardDeleteTopic({ topicId: 'topic-double-delete', reason: 'manual_moderation_delete' })
      assert(!second.ok && second.code === 'not_found', 'второто трябва да върне not_found, не throw')
    })

    await check('[23] Нов reply СЛЕД candidate-scan, ПРЕДИ delete → no_longer_eligible, темата ОСТАВА', () => {
      const result = hardDeleteService.hardDeleteTopic({ topicId: 'topic-race-new-reply', reason: 'inactivity_expired', inactivityCutoff: cutoff })
      assert(!result.ok && result.code === 'no_longer_eligible', 'трябва да откаже delete-а заради новата активност')
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-race-new-reply'`).get()
      db2.close()
      assert(row !== undefined, 'темата трябва да остане непокътната')
    })

    await check('[24] hardDeleteTopic с inactivityCutoff за реално неактивна тема → изтрита нормално', () => {
      const result = hardDeleteService.hardDeleteTopic({ topicId: 'topic-still-inactive', reason: 'inactivity_expired', inactivityCutoff: cutoff })
      assert(result.ok, 'трябва да успее — темата реално е неактивна отпреди cutoff-а')
    })

    await check('[25] hardDeleteTopic БЕЗ inactivityCutoff (manual) игнорира activity condition — трие дори "прясна" тема', () => {
      const result = hardDeleteService.hardDeleteTopic({ topicId: 'topic-manual-fresh', reason: 'manual_moderation_delete' })
      assert(result.ok, 'manual delete трябва да успее независимо от activity — не подава inactivityCutoff')
    })
  } finally {
    hardDeleteService.close()
    messageStore.close()
  }
})

// ─── [26] Missing attachments / [27] Boundary precision ────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'edge.sqlite')
  const messageStore = await createTopicMessageStore(dbPath)
  const hardDeleteService = await createTopicHardDeleteService(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    insertTopic(db, { topicId: 'topic-no-attachments', slug: 'noatt', title: 'No attachments' })
    insertTopic(db, { topicId: 'topic-exact-boundary', slug: 'boundary', title: 'Boundary' })
    db.close()

    messageStore.insertMessage({ topicId: 'topic-no-attachments', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'plain text root, no image' })

    const boundaryRoot = messageStore.insertMessage({ topicId: 'topic-exact-boundary', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    const exactCutoffMs = 72 * HOUR_MS
    const db2 = new DatabaseSync(dbPath, { open: true })
    db2.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(exactCutoffMs), boundaryRoot.messageId)
    db2.close()

    await check('[26] Тема без attachments се трие нормално (0 filenames, без crash)', () => {
      const result = hardDeleteService.hardDeleteTopic({ topicId: 'topic-no-attachments', reason: 'manual_moderation_delete' })
      assert(result.ok, 'трябва да успее')
      const okResult = result as Extract<typeof result, { ok: true }>
      assertEqual(okResult.deletedAttachmentFilenames.length, 0, 'няма attachments за тази тема')
    })

    await check('[27] Граница точно на cutoff-а (lastActivityAt === cutoff) → Е eligible', () => {
      // Cutoff-ът, подаден на findInactivityCandidates/hardDeleteTopic, е "72
      // часа назад ОТ МОМЕНТА НА ИЗВИКВАНЕ" — за да гарантираме lastActivityAt
      // <= cutoff точно на границата (не с малка разлика заради изминалото
      // между insert-а по-горе и това извикване), подаваме cutoff НЕЗНАЧИТЕЛНО
      // по-млад (72h - 1s назад), което прави root-а (created 72h назад)
      // строго ПО-СТАР от cutoff-а — коректно eligible сравнение.
      const cutoff = new Date(Date.now() - (exactCutoffMs - 1000))
      const candidates = hardDeleteService.findInactivityCandidates(cutoff, 100)
      assert(candidates.some((c) => c.topicId === 'topic-exact-boundary'), 'темата на точно 72h трябва да е eligible спрямо този cutoff')
      const result = hardDeleteService.hardDeleteTopic({ topicId: 'topic-exact-boundary', reason: 'inactivity_expired', inactivityCutoff: cutoff })
      assert(result.ok, 'трябва да се изтрие успешно на границата')
    })
  } finally {
    hardDeleteService.close()
    messageStore.close()
  }
})

// ─── [28]-[37] Manual delete — corrective pass: no intermediate soft-delete state ──
//
// Доказва, че handleTopicDeleteRequest-ия нов flow (директно
// topicHardDeleteService.hardDeleteTopic({reason:'manual_moderation_delete',
// actor, auditReason})) вече НЕ минава през persisted status='removed'
// intermediate стъпка — темата е hard-deleted в ЕДНА транзакция, audit
// trail оцелява explicit чрез insertModerationAuditRowStatement (НЕ чрез
// topicModerationStore.deleteTopic(), който вече не се вика от manual flow-а).

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'manual-corrective.sqlite')
  const messageStore = await createTopicMessageStore(dbPath)
  const moderationStore = await createTopicModerationStore(dbPath)
  const hardDeleteService = await createTopicHardDeleteService(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    insertTopic(db, { topicId: 'topic-manual-audit', slug: 'manual-audit', title: 'Manual with audit' })
    db.close()

    messageStore.insertMessage({ topicId: 'topic-manual-audit', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })

    const result = hardDeleteService.hardDeleteTopic({
      topicId: 'topic-manual-audit',
      reason: 'manual_moderation_delete',
      actor: { accountId: 'mod-1', role: 'admin' },
      auditReason: 'spam cleanup',
    })
    assert(result.ok, 'manual delete с actor трябва да успее')

    await check('[28] Manual root delete НЕ извиква/не оставя status=\'removed\' state — root row изобщо липсва', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(`SELECT status FROM topics WHERE topic_id = 'topic-manual-audit'`).get()
      db2.close()
      assertEqual(row, undefined, 'topics row трябва да липсва напълно — нито active, нито removed, ГО НЯМА')
    })

    await check('[29] Manual delete: audit trail оцелява (persisted accountability, НЕ soft-deleted topic row)', () => {
      const db2 = new DatabaseSync(dbPath, { open: true })
      const row = db2.prepare(
        `SELECT actor_account_id, actor_role, action, reason FROM topic_moderation_audit_log WHERE topic_id = 'topic-manual-audit' AND action = 'topic_delete'`,
      ).get() as { actor_account_id: string; actor_role: string; action: string; reason: string } | undefined
      assert(row !== undefined, 'audit ред трябва да съществува')
      assertEqual(row!.actor_account_id, 'mod-1', 'actor identity трябва да е persisted')
      assertEqual(row!.actor_role, 'admin', 'actor role трябва да е persisted')
      assertEqual(row!.reason, 'spam cleanup', 'reason text трябва да е persisted')
      db2.close()
    })

    await check('[30] Manual delete не зависи от purgeRemovedTopicsBefore — темата вече е физически изтрита без да чака 180-дневния purge', () => {
      // purgeRemovedTopicsBefore само trие 'removed' redове — темата вече не
      // съществува изобщо (нито 'active', нито 'removed'), значи purge run
      // веднага след delete-а е no-op за нея (нищо за него да намери).
      const purgedCount = moderationStore.purgeRemovedTopicsBefore(new Date(), 200)
      assertEqual(purgedCount, 0, 'purge run веднага след manual delete трябва да е no-op — темата вече е изтрита')
    })

    await check('[31] Attachments/filesystem cleanup се задейства директно от hard-delete lifecycle (без soft-delete intermediate stage)', () => {
      // Проверено вече по-широко в [11]/[12]; тук потвърждаваме конкретно за
      // actor-driven manual case (различен code path от automatic branch-а).
      assert(result.ok, 'sanity: result трябва да е ok')
      const okResult = result as Extract<typeof result, { ok: true }>
      assertEqual(okResult.deletedAttachmentFilenames.length, 0, 'тази тема няма attachments, но извикването не crash-на')
    })
  } finally {
    hardDeleteService.close()
    moderationStore.close()
    messageStore.close()
  }
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'manual-legacy-purge.sqlite')
  const messageStore = await createTopicMessageStore(dbPath)
  const moderationStore = await createTopicModerationStore(dbPath)
  const hardDeleteService = await createTopicHardDeleteService(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    insertTopic(db, { topicId: 'topic-legacy-removed', slug: 'legacy-removed', title: 'Legacy soft-deleted' })
    db.close()

    messageStore.insertMessage({ topicId: 'topic-legacy-removed', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'legacy root' })

    // Симулира ЛЕГАЦИ 'removed' ред (напр. от преди corrective pass-а, или
    // от друг легитимен бъдещ soft-delete caller — topicModerationStore.deleteTopic()
    // остава валиден primitive за такива случаи, виж interface коментара).
    moderationStore.deleteTopic({ topicId: 'topic-legacy-removed', actorAccountId: 'mod-1', actorRole: 'admin', reason: 'legacy soft delete path' })

    const db2 = new DatabaseSync(dbPath, { open: true })
    db2.prepare(`UPDATE topics SET removed_at = ? WHERE topic_id = 'topic-legacy-removed'`).run(msAgoSqliteString(200 * 24 * HOUR_MS))
    db2.close()

    await check('[32] Existing removed-topic 180-day purge продължава да работи за legacy/друг legitimate removed ред', () => {
      const purgedCount = moderationStore.purgeRemovedTopicsBefore(new Date(Date.now() - 180 * 24 * HOUR_MS), 200)
      assertEqual(purgedCount, 1, 'legacy removed ред >180 дни трябва да се purge-не нормално, established lifecycle непроменен')
      const db3 = new DatabaseSync(dbPath, { open: true })
      const row = db3.prepare(`SELECT 1 FROM topics WHERE topic_id = 'topic-legacy-removed'`).get()
      db3.close()
      assertEqual(row, undefined, 'темата трябва да е hard-deleted от established purge job-а')
    })
  } finally {
    hardDeleteService.close()
    moderationStore.close()
    messageStore.close()
  }
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'manual-vs-cleanup-race.sqlite')
  const messageStore = await createTopicMessageStore(dbPath)
  const hardDeleteService = await createTopicHardDeleteService(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    insertTopic(db, { topicId: 'topic-manual-vs-cleanup', slug: 'manual-vs-cleanup', title: 'Race' })
    db.close()

    const root = messageStore.insertMessage({ topicId: 'topic-manual-vs-cleanup', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
    const db2 = new DatabaseSync(dbPath, { open: true })
    db2.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(200 * HOUR_MS), root.messageId)
    db2.close()
    const cutoff = new Date(Date.now() - 72 * HOUR_MS)

    await check('[33] Manual delete + automatic cleanup (симулирано "почти едновременно") за 1 тема — безопасно, без duplicate corruption', () => {
      // "Почти едновременно" = manual delete извиква ПЪРВО (получава SQLite
      // writer lock-а първи по конструкция в single-threaded event loop),
      // automatic cleanup's hardDeleteTopic() извикване идва ВЕДНАГА след —
      // трябва да получи not_found idempotently, не crash/corruption.
      const manualResult = hardDeleteService.hardDeleteTopic({
        topicId: 'topic-manual-vs-cleanup',
        reason: 'manual_moderation_delete',
        actor: { accountId: 'mod-1', role: 'admin' },
        auditReason: 'race test',
      })
      assert(manualResult.ok, 'manual delete трябва да успее')

      const cleanupResult = hardDeleteService.hardDeleteTopic({
        topicId: 'topic-manual-vs-cleanup',
        reason: 'inactivity_expired',
        inactivityCutoff: cutoff,
      })
      assert(!cleanupResult.ok && cleanupResult.code === 'not_found', 'automatic cleanup трябва да завари темата вече изтрита — idempotent not_found, без throw')
    })
  } finally {
    hardDeleteService.close()
    messageStore.close()
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
