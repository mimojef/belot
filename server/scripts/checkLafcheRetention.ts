/**
 * checkLafcheRetention.ts
 *
 * Lafche 200-post HARD retention (production hotfix — root cause audit-и:
 * unbounded client-side scroll-triggered "load older" доведе до 900+/1170+
 * Lafche root nodes в DOM). Store-level (не HTTP/WS spawn), mirror на
 * checkTopicMuteEvidence.ts/checkTopicMessageSelfDelete.ts pattern-a —
 * директен topicMessageStore/topicModerationStore достъп, изолирана temp
 * SQLite база. Тества store primitives-ите (getLafcheRetentionVictims/
 * countLiveRootMessages/hardDeleteRetentionVictims/
 * getActiveEvidenceAttachmentReferences/repointMuteEvidenceAttachmentToEvidenceCopy/
 * isRegisteredEvidenceAttachmentCopy) в СЪЩАТА steady-state-only
 * последователност като index.ts enforceLafcheRetention orchestration —
 * index.ts самият не се import-ва тук (HTTP/WS entry point, не library),
 * затова enforceSteadyStateRetentionOnce() по-долу е точен mirror на
 * production логиката, не reuse на кода directno.
 *
 * === A. STEADY-STATE SINGLE EVICTION ===
 * [1] seed 200 live Lafche roots, countLiveRootMessages == 200, victims == []
 * [2] insert #201 → enforce → exactly 200 остават, най-старият е hard-deleted
 *
 * === B. REPLIES NE БРОЯТ КЪМ LIMIT ===
 * [10] 200 roots + 50 replies към произволни roots → countLiveRootMessages
 *      остава 200 (replies не влияят), enforce е no-op
 *
 * === C. EXACT NEWEST N RETAINED ===
 * [11] след steady-state eviction, retained IDs = insertedIds[1..200] (по
 *      insertion/seq ред), insertedIds[0] е физически изчезнал
 *
 * === D. NORMAL TOPIC ISOLATION ===
 * [80] getLafcheRetentionVictims е generic по topicId (доказва, че НЕ е
 *      "магически" Lafche-only) — production isolation идва от index.ts
 *      hardcode на LAFCHE_TOPIC_ID (static-proof в
 *      checkLafcheNoOlderPagination.ts), не от самата store функция.
 *
 * === E. LEGACY BACKLOG — NO MASS DELETE ===
 * [20] count = 205 (backlog >limit+1) → enforceSteadyStateRetentionOnce
 *      връща 'backlog-blocked', count остава непроменен (205), НИЩО не се
 *      трие от normal steady-state path
 *
 * === F. STEADY-STATE #201 РАБОТИ СЛЕД EXPLICIT НОРМАЛИЗАЦИЯ ===
 * [21] backlog (205) → explicit bulk normalize (симулира --mode=apply, ръчно
 *      извикване на getLafcheRetentionVictims+hardDeleteRetentionVictims
 *      директно, НЕ enforceSteadyStateRetentionOnce) → 200 → нов insert #201
 *      → enforceSteadyStateRetentionOnce вече работи нормално → 200
 *
 * === G. DEPENDENCIES (likes/replies/attachments cascade) ===
 * [30] victim с likes → CASCADE
 * [31] victim с reply → CASCADE
 * [32] victim без dependent rows → clean delete
 *
 * === H. NORMAL ATTACHMENT ===
 * [40] victim с attachment → metadata изчезва (CASCADE)
 * [41] filename enqueue-нат в topic_message_attachment_deletions (pending)
 * [42] retained non-victim attachment остава непокътнат
 *
 * === I. MUTE EVIDENCE — TEXT ===
 * [50] evidence source post остарява → hard-deleted → evidence row остава,
 *      source_message_id → NULL, snapshot непроменен
 *
 * === J. MUTE EVIDENCE — IMAGE ===
 * [60]-[65] getActiveEvidenceAttachmentReferences/repoint/isRegisteredEvidenceAttachmentCopy
 *      пълен lifecycle, mirror на предишната версия, само с limit=200
 *
 * === K. FAILED EVIDENCE COPY — SOURCE NE СЕ ИЗТРИВА ===
 * [70] симулира copy failure (copiedFilename === null) → orchestration
 *      guard-ът (mirror на index.ts) НЕ вика hardDeleteRetentionVictims —
 *      source постът остава жив, evidence остава unrepointed (is_evidence_copy=0)
 *
 * === L. LEGACY/EXISTING EVIDENCE BACKFILL ===
 * [80]-[81] mirror на предишната версия
 *
 * === M. DB CONSISTENCY БЕЗ FILE OPERATIONS ===
 * [90] hardDeleteRetentionVictims не хвърля грешка дори ако физическият
 *      файл никога не е бил записан
 *
 * === O. SEQUENTIAL RAPID INSERTS СЛЕД НОРМАЛИЗАЦИЯ ===
 * [100]-[101] 50 последователни inserts+enforce СЛЕД normalize до 200 →
 *      count никога не надвишава 200, retained = exact newest 200
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createTopicModerationStore, type TopicModerationStore } from '../src/db/topicModerationStore.js'
import { createTopicMessageStore, type TopicMessageStore } from '../src/db/topicMessageStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const topicsMigrationPath = resolve(serverRoot, 'database/migrations/20260810_002_create_topics_and_messages.sql')
const likesMigrationPath = resolve(serverRoot, 'database/migrations/20260811_001_create_topic_message_likes.sql')
const attachmentsMigrationPath = resolve(serverRoot, 'database/migrations/20260811_002_create_topic_message_attachments.sql')
const moderationMigrationPath = resolve(serverRoot, 'database/migrations/20260811_003_create_topic_moderation.sql')
const messageModerationMigrationPath = resolve(serverRoot, 'database/migrations/20260812_001_create_topic_message_moderation.sql')
const selfDeletionAuditMigrationPath = resolve(serverRoot, 'database/migrations/20260812_002_create_topic_message_self_deletion_audit.sql')
const editMigrationPath = resolve(serverRoot, 'database/migrations/20260812_003_add_topic_message_editing.sql')
const readStateMigrationPath = resolve(serverRoot, 'database/migrations/20260812_004_create_topic_read_state.sql')
const threadReadStateMigrationPath = resolve(serverRoot, 'database/migrations/20260813_001_create_topic_thread_read_state.sql')
const sectionMutesMigrationPath = resolve(serverRoot, 'database/migrations/20260814_001_create_topic_section_mutes.sql')
const lafcheSeedMigrationPath = resolve(serverRoot, 'database/migrations/20260817_002_seed_topic_lafche.sql')
const muteEvidenceMigrationPath = resolve(serverRoot, 'database/migrations/20260817_003_create_topic_mute_evidence.sql')
const evidenceAttachmentCopyMigrationPath = resolve(serverRoot, 'database/migrations/20260818_005_add_topic_mute_evidence_attachment_copy.sql')

const LAFCHE_TOPIC_ID = 'topic-lafche'
const LAFCHE_MESSAGE_HISTORY_LIMIT = 200

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-lafche-retention-check-'))
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
  await applyMigrationFile(db, editMigrationPath)
  await applyMigrationFile(db, readStateMigrationPath)
  await applyMigrationFile(db, threadReadStateMigrationPath)
  await applyMigrationFile(db, sectionMutesMigrationPath)
  await applyMigrationFile(db, lafcheSeedMigrationPath)
  await applyMigrationFile(db, muteEvidenceMigrationPath)
  await applyMigrationFile(db, evidenceAttachmentCopyMigrationPath)
  seedAccount(db, 'moderator-1')
  seedProfile(db, 'author-1')
  seedProfile(db, 'author-2')
  db.close()
  return dbPath
}

function makeAttachment(filename: string) {
  return { storageFilename: filename, width: 100, height: 100, byteSize: 500, contentType: 'image/webp' }
}

/**
 * Точен mirror на index.ts enforceLafcheRetention() SYNC-само поведението
 * (без evidence copy — тестван отделно в [70]) — steady-state single-
 * eviction guard: no-op ако <=limit, 'backlog-blocked' (нищо не се трие)
 * ако >limit+1, точен единичен evict само ако ==limit+1.
 */
function enforceSteadyStateRetentionOnce(msgStore: TopicMessageStore): 'no-op' | 'evicted' | 'backlog-blocked' {
  const liveCount = msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID)
  if (liveCount <= LAFCHE_MESSAGE_HISTORY_LIMIT) return 'no-op'
  if (liveCount > LAFCHE_MESSAGE_HISTORY_LIMIT + 1) return 'backlog-blocked'
  const victims = msgStore.getLafcheRetentionVictims(LAFCHE_TOPIC_ID, LAFCHE_MESSAGE_HISTORY_LIMIT)
  if (victims.length === 0) return 'no-op'
  msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [victims[0]!.messageId])
  return 'evicted'
}

console.log('\n=== Lafche 200-post hard retention (store-level, steady-state) ===\n')

// ─── [1]-[2] Steady-state single eviction ────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'steady-state.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  try {
    const insertedIds: string[] = []
    for (let i = 0; i < 200; i++) {
      const row = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: `post ${i}` })
      insertedIds.push(row.messageId)
    }

    await check('[1] seed 200 live roots → countLiveRootMessages == 200, victims == []', () => {
      assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 200, 'count трябва да е точно 200')
      assertEqual(msgStore.getLafcheRetentionVictims(LAFCHE_TOPIC_ID, LAFCHE_MESSAGE_HISTORY_LIMIT).length, 0, 'на точно 200 не трябва да има victims')
    })

    const post201 = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'post 201' })

    await check('[2] insert #201 → enforce → exactly 200 остават, най-старият е hard-deleted', () => {
      const outcome = enforceSteadyStateRetentionOnce(msgStore)
      assertEqual(outcome, 'evicted', 'очаква се точно 1 eviction')
      assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 200, 'count трябва да се върне на 200')
      assert(msgStore.getMessageById(insertedIds[0]!) === null, 'най-старият пост трябва да е физически изчезнал')
      assert(msgStore.getMessageById(post201.messageId) !== null, 'post201 трябва да остане')
    })

    await check('[11] retained IDs = insertedIds[1..199] + post201 (exact newest 200)', () => {
      for (let i = 1; i < 200; i++) {
        assert(msgStore.getMessageById(insertedIds[i]!) !== null, `insertedIds[${i}] трябва да остане жив`)
      }
      assert(msgStore.getMessageById(post201.messageId) !== null, 'post201 трябва да остане жив')
    })
  } finally {
    msgStore.close()
  }
})

// ─── [10] Replies не броят към limit ─────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'replies-dont-count.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  try {
    const rootIds: string[] = []
    for (let i = 0; i < 200; i++) {
      const row = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: `root ${i}` })
      rootIds.push(row.messageId)
    }
    for (let i = 0; i < 50; i++) {
      const parentId = rootIds[i % rootIds.length]!
      const result = msgStore.insertReply({ topicId: LAFCHE_TOPIC_ID, parentMessageId: parentId, senderProfileId: 'author-2', senderDisplayName: 'A2', senderRole: 'player', body: `reply ${i}` })
      assert(result.ok, 'reply insert трябва да успее в test setup')
    }

    await check('[10] 200 roots + 50 replies → countLiveRootMessages остава 200, enforce е no-op', () => {
      assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 200, 'replies не трябва да влияят на root count-а')
      const outcome = enforceSteadyStateRetentionOnce(msgStore)
      assertEqual(outcome, 'no-op', 'на точно 200 root-а (независимо от replies) enforce трябва да е no-op')
      assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 200, 'count трябва да остане 200 след no-op enforce')
    })
  } finally {
    msgStore.close()
  }
})

// ─── [80] Normal topic isolation (generic function) ──────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'normal-topic.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.prepare(`INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order) VALUES (?, ?, ?, 0, NULL, 'active', 50);`)
      .run('topic-general-test', 'general-test', 'Общ тест')
    for (let i = 0; i < 250; i++) {
      msgStore.insertMessage({ topicId: 'topic-general-test', senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: `normal post ${i}` })
    }

    await check('[80] Normal (non-Lafche) тема с 250 постове — store функцията е generic по topicId; production isolation е в index.ts wiring-а (static-proof в checkLafcheNoOlderPagination.ts), не тук', () => {
      assertEqual(msgStore.countLiveRootMessages('topic-general-test'), 250, 'normal темата не трябва да е засегната')
      const victims = msgStore.getLafcheRetentionVictims('topic-general-test', LAFCHE_MESSAGE_HISTORY_LIMIT)
      assertEqual(victims.length, 50, 'функцията е generic — АКО бъде извикана (не се извиква production) би върнала 50 victims')
      assertEqual(msgStore.countLiveRootMessages('topic-general-test'), 250, 'read-only lookup не трие нищо')
    })
  } finally {
    msgStore.close()
    db.close()
  }
})

// ─── [20] Legacy backlog — NO mass delete ────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'legacy-backlog.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  try {
    for (let i = 0; i < 205; i++) {
      msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: `legacy ${i}` })
    }

    await check('[20] count = 205 (backlog >limit+1) → enforceSteadyStateRetentionOnce връща backlog-blocked, count НЕПРОМЕНЕН', () => {
      assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 205, 'setup sanity')
      const outcome = enforceSteadyStateRetentionOnce(msgStore)
      assertEqual(outcome, 'backlog-blocked', 'backlog >limit+1 трябва да откаже automatic eviction')
      assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 205, 'count трябва да остане ТОЧНО 205 — НИЩО не е изтрито от normal path')
    })

    await check('[21] Explicit bulk normalize (симулира --mode=apply) → 200, после нов post #201 → enforceSteadyStateRetentionOnce вече работи нормално', () => {
      // Симулира explicit cleanup script bulk-normalize (директно
      // getLafcheRetentionVictims + hardDeleteRetentionVictims, НЕ
      // enforceSteadyStateRetentionOnce, точно както --mode=apply би направил).
      const bulkVictims = msgStore.getLafcheRetentionVictims(LAFCHE_TOPIC_ID, LAFCHE_MESSAGE_HISTORY_LIMIT)
      assertEqual(bulkVictims.length, 5, 'setup sanity: 205-200=5 victims за bulk normalize')
      msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, bulkVictims.map((v) => v.messageId))
      assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 200, 'след bulk normalize трябва да е точно 200')

      msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'post 201 след normalize' })
      const outcome = enforceSteadyStateRetentionOnce(msgStore)
      assertEqual(outcome, 'evicted', 'steady-state single-eviction трябва вече да работи нормално')
      assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 200, 'count трябва да е точно 200 отново')
    })
  } finally {
    msgStore.close()
  }
})

// ─── [30]-[32] Dependencies ───────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'deps.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  try {
    const victimWithLike = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'to be liked' })
    msgStore.toggleLike(victimWithLike.messageId, 'author-2')

    const victimWithReply = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'to be replied' })
    const replyResult = msgStore.insertReply({ topicId: LAFCHE_TOPIC_ID, parentMessageId: victimWithReply.messageId, senderProfileId: 'author-2', senderDisplayName: 'A2', senderRole: 'player', body: 'a reply' })
    assert(replyResult.ok, 'reply insert трябва да успее в test setup')
    const replyId = replyResult.ok ? replyResult.message.messageId : ''

    const victimPlain = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'no deps' })

    await check('[30] victim с likes → likes CASCADE-delete-нати', () => {
      msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [victimWithLike.messageId])
      const counts = msgStore.getLikeCountsByMessageIds([victimWithLike.messageId])
      assertEqual(counts.get(victimWithLike.messageId), 0, 'likeCount трябва да е 0')
    })

    await check('[31] victim с reply → replies CASCADE-delete-нати', () => {
      msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [victimWithReply.messageId])
      assert(msgStore.getMessageById(replyId) === null, 'reply-то трябва да изчезне заедно с root-а')
    })

    await check('[32] victim без dependent rows → clean delete, no errors', () => {
      msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [victimPlain.messageId])
      assert(msgStore.getMessageById(victimPlain.messageId) === null, 'постът трябва да изчезне чисто')
    })
  } finally {
    msgStore.close()
  }
})

// ─── [40]-[42] Normal attachment cleanup ─────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'attachments.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  try {
    const victimFilename = `${randomUUID()}.webp`
    const victim = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '', attachment: makeAttachment(victimFilename) })
    const retainedFilename = `${randomUUID()}.webp`
    const retained = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '', attachment: makeAttachment(retainedFilename) })

    const { deletedAttachmentFilenames } = msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [victim.messageId])

    await check('[40] victim с attachment → metadata изчезва (CASCADE)', () => {
      assertEqual(msgStore.getAttachmentsByMessageIds([victim.messageId]).size, 0, 'attachment metadata трябва да изчезне')
    })
    await check('[41] filename се enqueue-ва в topic_message_attachment_deletions (pending)', () => {
      assert(deletedAttachmentFilenames.includes(victimFilename), 'victim filename трябва да е върнат/enqueue-нат')
      const pending = msgStore.listPendingAttachmentDeletions(50)
      assert(pending.some((entry) => entry.storageFilename === victimFilename), 'filename-ът трябва да е в pending cleanup queue-то')
    })
    await check('[42] retained non-victim attachment остава непокътнат', () => {
      assertEqual(msgStore.getAttachmentsByMessageIds([retained.messageId]).size, 1, 'retained постът трябва да си пази attachment metadata-та')
    })
  } finally {
    msgStore.close()
  }
})

// ─── [50] Mute evidence — text ────────────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'evidence-text.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  const modStore = await createTopicModerationStore(dbPath)
  try {
    const evidencePost = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'обиден текст за evidence' })
    modStore.muteProfileInTopics({ topicId: LAFCHE_TOPIC_ID, profileId: 'author-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'обиди', durationMs: 60 * 60 * 1000, sourceMessageId: evidencePost.messageId, sourceKind: 'lafche_post' })

    await check('[50] evidence source post hard-deleted → evidence row остава, source_message_id → NULL, snapshot непроменен', () => {
      msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [evidencePost.messageId])
      const entries = modStore.listMuteEvidenceForProfile('author-1', 10)
      assertEqual(entries.length, 1, 'evidence редът трябва да оцелее')
      assertEqual(entries[0]!.sourceMessageId, null, 'source_message_id трябва да е NULL')
      assertEqual(entries[0]!.sourceBodySnapshot, 'обиден текст за evidence', 'snapshot текстът трябва да остане непроменен')
    })
  } finally {
    msgStore.close()
    modStore.close()
  }
})

// ─── [60]-[65] Mute evidence — image ──────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'evidence-image.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  const modStore = await createTopicModerationStore(dbPath)
  try {
    const evidenceFilename = `${randomUUID()}.webp`
    const evidencePost = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '', attachment: makeAttachment(evidenceFilename) })
    modStore.muteProfileInTopics({ topicId: LAFCHE_TOPIC_ID, profileId: 'author-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'неподходяща снимка', durationMs: 60 * 60 * 1000, sourceMessageId: evidencePost.messageId, sourceKind: 'lafche_post' })

    await check('[60]-[61] getActiveEvidenceAttachmentReferences намира victim filename-а (default is_evidence_copy=0)', () => {
      const references = modStore.getActiveEvidenceAttachmentReferences([evidenceFilename])
      assert(references.has(evidenceFilename), 'референцията трябва да се намери преди repoint')
    })

    const copiedFilename = `${randomUUID()}.webp`
    await check('[62]-[63] repointMuteEvidenceAttachmentToEvidenceCopy обновява filename + флага; isRegisteredEvidenceAttachmentCopy == true след repoint', () => {
      const changed = modStore.repointMuteEvidenceAttachmentToEvidenceCopy(evidenceFilename, copiedFilename)
      assertEqual(changed, 1, 'трябва да обнови точно 1 evidence ред')
      assert(modStore.isRegisteredEvidenceAttachmentCopy(copiedFilename), 'новото filename трябва да е registered evidence copy')
      assert(!modStore.isRegisteredEvidenceAttachmentCopy(evidenceFilename), 'старото filename никога не е било registered copy')
    })

    await check('[64] hardDeleteRetentionVictims сега безопасно трие source-а', () => {
      msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [evidencePost.messageId])
      assertEqual(msgStore.getAttachmentsByMessageIds([evidencePost.messageId]).size, 0, 'normal attachment metadata трябва да изчезне')
      assert(msgStore.getMessageById(evidencePost.messageId) === null, 'source постът трябва да е изчезнал')
    })

    await check('[65] evidence row вижда repoint-натия filename, is_evidence_copy=1, source_message_id=NULL', () => {
      const entries = modStore.listMuteEvidenceForProfile('author-1', 10)
      assertEqual(entries[0]!.sourceMessageId, null, 'source_message_id трябва да е NULL')
      assertEqual(entries[0]!.sourceAttachment?.storageFilename, copiedFilename, 'трябва да сочи към copy-натия filename')
      assertEqual(entries[0]!.sourceAttachment?.isEvidenceCopy, true, 'isEvidenceCopy трябва да е true')
    })
  } finally {
    msgStore.close()
    modStore.close()
  }
})

// ─── [70] Failed evidence copy — source НЕ се изтрива ────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'evidence-copy-failure.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  const modStore = await createTopicModerationStore(dbPath)
  try {
    const evidenceFilename = `${randomUUID()}.webp`
    const evidencePost = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '', attachment: makeAttachment(evidenceFilename) })
    modStore.muteProfileInTopics({ topicId: LAFCHE_TOPIC_ID, profileId: 'author-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'снимка', durationMs: 60 * 60 * 1000, sourceMessageId: evidencePost.messageId, sourceKind: 'lafche_post' })

    await check('[70] simulated copy failure (copiedFilename===null) → orchestration guard НЕ вика hardDeleteRetentionVictims — source остава жив, evidence остава unrepointed', () => {
      // Mirror на index.ts enforceLafcheRetention orchestration guard-а:
      // ако copy върне null, retention flow-ът МУСИ да return-не БЕЗ delete.
      const references = modStore.getActiveEvidenceAttachmentReferences([evidenceFilename])
      assert(references.has(evidenceFilename), 'setup sanity: filename трябва да е referenced')

      const simulatedCopiedFilename: string | null = null // симулира copyTopicAttachmentToEvidenceStorage() failure
      if (simulatedCopiedFilename === null) {
        // Orchestration guard: connect тук и излиза, БЕЗ да вика
        // hardDeleteRetentionVictims/repointMuteEvidenceAttachmentToEvidenceCopy.
      } else {
        modStore.repointMuteEvidenceAttachmentToEvidenceCopy(evidenceFilename, simulatedCopiedFilename)
        msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [evidencePost.messageId])
      }

      assert(msgStore.getMessageById(evidencePost.messageId) !== null, 'source постът ТРЯБВА да остане жив след неуспешен copy — evidence не бива да осиротее')
      assertEqual(msgStore.getAttachmentsByMessageIds([evidencePost.messageId]).size, 1, 'normal attachment metadata трябва да остане непокътната')
      const entries = modStore.listMuteEvidenceForProfile('author-1', 10)
      assertEqual(entries[0]!.sourceAttachment?.isEvidenceCopy, false, 'evidence трябва да остане unrepointed (is_evidence_copy=0) — retry следващия цикъл')
    })
  } finally {
    msgStore.close()
    modStore.close()
  }
})

// ─── [80]-[81] Legacy/existing evidence backfill ─────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'legacy-evidence.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  const modStore = await createTopicModerationStore(dbPath)
  try {
    const legacyFilename = `${randomUUID()}.webp`
    const legacyPost = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '', attachment: makeAttachment(legacyFilename) })
    modStore.muteProfileInTopics({ topicId: LAFCHE_TOPIC_ID, profileId: 'author-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'legacy simulation', durationMs: 60 * 60 * 1000, sourceMessageId: legacyPost.messageId, sourceKind: 'lafche_post' })

    await check('[80] legacy evidence (is_evidence_copy=0 default) → backfill candidate', () => {
      assert(modStore.getActiveEvidenceAttachmentReferences([legacyFilename]).has(legacyFilename), 'legacy evidence трябва да е backfill candidate')
    })
    await check('[81] след симулиран backfill repoint → вече НЕ е backfill candidate', () => {
      const newFilename = `${randomUUID()}.webp`
      modStore.repointMuteEvidenceAttachmentToEvidenceCopy(legacyFilename, newFilename)
      assert(!modStore.getActiveEvidenceAttachmentReferences([legacyFilename]).has(legacyFilename), 'след backfill старото filename вече не е "жива" референция')
    })
  } finally {
    msgStore.close()
    modStore.close()
  }
})

// ─── [90] DB consistency без filesystem dependency ───────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'no-file.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  try {
    const neverWrittenFilename = `${randomUUID()}.webp`
    const victim = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '', attachment: makeAttachment(neverWrittenFilename) })

    await check('[90] hardDeleteRetentionVictims не хвърля грешка дори физическият файл никога да не е бил записан', () => {
      const result = msgStore.hardDeleteRetentionVictims(LAFCHE_TOPIC_ID, [victim.messageId])
      assert(result.deletedAttachmentFilenames.includes(neverWrittenFilename), 'filename трябва да е enqueue-нат въпреки липсващия физически файл')
      assert(msgStore.getMessageById(victim.messageId) === null, 'DB delete трябва да успее')
    })
  } finally {
    msgStore.close()
  }
})

// ─── [100]-[101] Sequential rapid inserts след нормализация ──────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'sequential-after-normalize.sqlite')
  const msgStore = await createTopicMessageStore(dbPath)
  try {
    for (let i = 0; i < 200; i++) {
      msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: `seed ${i}` })
    }
    assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 200, 'setup sanity: normalized to 200')

    const newestIds: string[] = []
    await check('[100] 50 последователни inserts+enforce СЛЕД normalize до 200 → count никога не надвишава 200', () => {
      for (let i = 0; i < 50; i++) {
        const row = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: `extra ${i}` })
        newestIds.push(row.messageId)
        const outcome = enforceSteadyStateRetentionOnce(msgStore)
        assertEqual(outcome, 'evicted', `expected 'evicted' at insert #${i}`)
        const count = msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID)
        assert(count <= LAFCHE_MESSAGE_HISTORY_LIMIT, `count (${count}) не трябва да надвишава ${LAFCHE_MESSAGE_HISTORY_LIMIT} след insert #${i}`)
      }
    })

    await check('[101] финалният retained set = exact newest 200, всичките 50 нови постове живи', () => {
      assertEqual(msgStore.countLiveRootMessages(LAFCHE_TOPIC_ID), 200, 'финален count трябва да е точно 200')
      for (const id of newestIds) {
        assert(msgStore.getMessageById(id) !== null, `най-новите 50 постове трябва всичките да оцелеят: ${id}`)
      }
    })
  } finally {
    msgStore.close()
  }
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
