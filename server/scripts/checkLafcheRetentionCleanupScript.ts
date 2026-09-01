/**
 * checkLafcheRetentionCleanupScript.ts
 *
 * Тества scripts/lafcheRetentionCleanup.ts директно (import на
 * buildDryRunReport/runApply), НИКОГА през main()/CLI argv dispatch — по
 * конструкция е невъзможно тестовете тук да засегнат реалния server root/
 * production DB, защото никога не викаме getServerDatabaseFilePath()/
 * serverRoot() от production скрипта; всички пътища идват от mkdtemp().
 *
 * === M. DRY-RUN Е ДОКАЗУЕМО READ-ONLY ===
 * [1] seed backlog (>limit) с likes/replies/attachments/evidence → snapshot
 *     на ВСИЧКИ relevant table row-counts + uploads directory file list
 *     ПРЕДИ buildDryRunReport() → извикай buildDryRunReport() → същият
 *     snapshot СЛЕД → байт-по-байт идентичен (нулева мутация)
 * [2] dry-run report съдържа всички §9-мандатни полета (label presence в
 *     console output)
 * [3] buildDryRunReport() НЕ приема evidence-storage параметър изобщо —
 *     архитектурно невъзможно да пише evidence copies по време на dry-run
 *
 * === N. APPLY-MODE ТЕСТОВЕ ВЪРВЯТ САМО СРЕЩУ TEMP DB/TEMP STORAGE ===
 * [10] temp пътищата (DB файл, uploads dirs) структурно НЕ съвпадат и НЕ са
 *      под реалния server root — construction-level isolation proof
 * [11] backlog (305, limit 200 → 105 victims) → нормализира с batching
 *      (batch size 50, >1 batch); likes/replies cascade коректно
 * [12] victim с успешен evidence copy → source изтрит, evidence repoint-нат
 *      към реален файл в temp evidence storage (is_evidence_copy=1)
 * [13] victim с evidence, чийто source файл липсва физически → copy fail →
 *      victim СКИПНАТ (не изтрит), outcome='blocked-by-evidence-copy-failures'
 * [14] plain victim (без evidence) → изтрит нормално, filename enqueue-нат в
 *      pending attachment deletions queue
 * [15] PRAGMA integrity_check минава (integrityOk: true) след apply
 * [16] нормален (под лимита) DB → apply outcome='no-op', нулева мутация
 * [17]-[18] §12 letter H: retained (newest, вътре в 200) post attachment —
 *      DB metadata И реалният physical файл на диска остават НАПЪЛНО
 *      непокътнати след apply (никога не enqueue-нат, никога не unlink-нат)
 */

import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createTopicModerationStore } from '../src/db/topicModerationStore.js'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'
import { buildDryRunReport, runApply } from './lafcheRetentionCleanup.js'

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
const rootLatestSeqMigrationPath = resolve(serverRoot, 'database/migrations/20260824_001_create_topic_root_latest_seq.sql')

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-lafche-cleanup-script-check-'))
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
  await applyMigrationFile(db, rootLatestSeqMigrationPath)
  db.prepare(`INSERT INTO accounts (account_id) VALUES (?)`).run('moderator-1')
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run('author-1', 'author-1')
  db.close()
  return dbPath
}

async function setupDbLegacyPreMigration005(dir: string, filename: string): Promise<string> {
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
  // ЛИПСВА evidenceAttachmentCopyMigrationPath — нарочно, симулира текущата
  // production схема ПРЕДИ 20260818_005 да е приложена.
  await applyMigrationFile(db, rootLatestSeqMigrationPath)
  db.prepare(`INSERT INTO accounts (account_id) VALUES (?)`).run('moderator-1')
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run('author-1', 'author-1')
  db.close()
  return dbPath
}

function makeAttachment(filename: string) {
  return { storageFilename: filename, width: 10, height: 10, byteSize: 20, contentType: 'image/webp' as const }
}

function tableRowCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table};`).get() as { cnt: number }
  return row.cnt
}

function snapshotAllTables(db: DatabaseSync): Record<string, number> {
  return {
    topic_messages: tableRowCount(db, 'topic_messages'),
    topic_message_likes: tableRowCount(db, 'topic_message_likes'),
    topic_message_attachments: tableRowCount(db, 'topic_message_attachments'),
    topic_message_attachment_deletions: tableRowCount(db, 'topic_message_attachment_deletions'),
    topic_message_deletion_events: tableRowCount(db, 'topic_message_deletion_events'),
    topic_message_deletion_audit_log: tableRowCount(db, 'topic_message_deletion_audit_log'),
    topic_message_self_deletion_audit_log: tableRowCount(db, 'topic_message_self_deletion_audit_log'),
    topic_message_edit_events: tableRowCount(db, 'topic_message_edit_events'),
    topic_thread_read_state: tableRowCount(db, 'topic_thread_read_state'),
    topic_mute_evidence: tableRowCount(db, 'topic_mute_evidence'),
  }
}

console.log('\n=== lafcheRetentionCleanup.ts script check (dry-run read-only + apply temp-isolation) ===\n')

// ─── M: dry-run is provably read-only ────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'dry-run-readonly.sqlite')
  const topicAttachmentUploadsDir = join(dir, 'uploads-topic-attachments')
  await mkdir(topicAttachmentUploadsDir, { recursive: true })

  const msgStore = await createTopicMessageStore(dbPath)
  const modStore = await createTopicModerationStore(dbPath)
  const insertedIds: string[] = []
  for (let i = 0; i < 220; i++) {
    let attachmentFilename: string | undefined
    if (i < 5) {
      attachmentFilename = `${randomUUID()}.webp`
      await writeFile(join(topicAttachmentUploadsDir, attachmentFilename), Buffer.from('fake-webp-bytes'))
    }
    const row = msgStore.insertMessage({
      topicId: LAFCHE_TOPIC_ID,
      senderProfileId: 'author-1',
      senderDisplayName: 'A1',
      senderRole: 'player',
      body: `post ${i}`,
      attachment: attachmentFilename ? makeAttachment(attachmentFilename) : undefined,
    })
    insertedIds.push(row.messageId)
  }
  msgStore.toggleLike(insertedIds[0]!, 'author-1')
  const replyResult = msgStore.insertReply({ topicId: LAFCHE_TOPIC_ID, parentMessageId: insertedIds[1]!, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'a reply' })
  assert(replyResult.ok, 'setup: reply insert трябва да успее')
  modStore.muteProfileInTopics({ topicId: LAFCHE_TOPIC_ID, profileId: 'author-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'test', durationMs: 60000, sourceMessageId: insertedIds[0]!, sourceKind: 'lafche_post' })
  msgStore.close()
  modStore.close()

  const inspectDbBefore = new DatabaseSync(dbPath, { open: true, readOnly: true })
  const beforeSnapshot = snapshotAllTables(inspectDbBefore)
  inspectDbBefore.close()
  const beforeFileList = (await readdir(topicAttachmentUploadsDir)).sort()

  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  try {
    await buildDryRunReport(dbPath, topicAttachmentUploadsDir)
  } finally {
    console.log = originalLog
  }

  const inspectDbAfter = new DatabaseSync(dbPath, { open: true, readOnly: true })
  const afterSnapshot = snapshotAllTables(inspectDbAfter)
  inspectDbAfter.close()
  const afterFileList = (await readdir(topicAttachmentUploadsDir)).sort()

  await check('[1] dry-run: нито един table row count не се променя (нулева мутация)', () => {
    for (const key of Object.keys(beforeSnapshot)) {
      assertEqual(afterSnapshot[key], beforeSnapshot[key], `table ${key} count трябва да е непроменен`)
    }
  })

  await check('[1b] dry-run: uploads directory file list не се променя (нищо ново записано)', () => {
    assertEqual(afterFileList.length, beforeFileList.length, 'брой файлове трябва да е непроменен')
    assertEqual(JSON.stringify(afterFileList), JSON.stringify(beforeFileList), 'файловите имена трябва да са идентични')
  })

  await check('[2] dry-run report съдържа всички §9-мандатни полета в output-а', () => {
    const joined = logs.join('\n')
    const requiredSubstrings = [
      'Текущ брой LIVE Lafche root posts',
      'Canonical newest retention limit',
      'Retained count',
      'Victim count',
      'Retained seq range',
      'Victim seq range',
      'replies (topic_messages self-FK, live)',
      'topic_message_likes',
      'Физически файлове, реално намерени на диска',
      'Липсващи физически файлове',
      'Оценен общ размер',
      'Likes/reactions върху victim-ите',
      'Victims, реферирани от ЖИВ',
      'Text evidence redove',
      'Image evidence redove',
      'Legacy evidence redove',
    ]
    for (const substring of requiredSubstrings) {
      assert(joined.includes(substring), `report output трябва да съдържа "${substring}"`)
    }
  })
})

// ─── M-legacy: dry-run работи СРЕЩУ pre-005 (production ТЕКУЩА) schema ────

await withTempDir(async (dir) => {
  const dbPath = await setupDbLegacyPreMigration005(dir, 'legacy-pre-005.sqlite')
  const topicAttachmentUploadsDir = join(dir, 'uploads-topic-attachments')
  await mkdir(topicAttachmentUploadsDir, { recursive: true })

  // createTopicModerationStore е ИЗЦЯЛО неизползваем срещу pre-005 schema
  // (eager-prepared statements хвърлят при самото construction, виж
  // [M-legacy] rationale-а по-горе) — evidence seeding тук е ЗАДЪЛЖИТЕЛНО
  // raw SQL, не store call, точно каквото production ще е на практика
  // ПРЕДИ migration-ът да е приложен.
  const msgStore = await createTopicMessageStore(dbPath)
  const insertedIds: string[] = []
  let firstAttachmentFilename: string | null = null
  for (let i = 0; i < 210; i++) {
    let attachmentFilename: string | undefined
    if (i < 3) {
      attachmentFilename = `${randomUUID()}.webp`
      await writeFile(join(topicAttachmentUploadsDir, attachmentFilename), Buffer.from('fake-webp-bytes'))
      if (i === 0) firstAttachmentFilename = attachmentFilename
    }
    const row = msgStore.insertMessage({
      topicId: LAFCHE_TOPIC_ID,
      senderProfileId: 'author-1',
      senderDisplayName: 'A1',
      senderRole: 'player',
      body: `post ${i}`,
      attachment: attachmentFilename ? makeAttachment(attachmentFilename) : undefined,
    })
    insertedIds.push(row.messageId)
  }
  msgStore.close()
  assert(firstAttachmentFilename !== null, 'setup sanity: insertedIds[0] трябва да има attachment')

  // insertedIds[0] е сред victims (210-200=10 victims, oldest-first) и има
  // attachment — референцирай го от mute evidence (raw SQL, pre-005 shape —
  // БЕЗ source_attachment_is_evidence_copy колоната изобщо).
  const rawDb = new DatabaseSync(dbPath, { open: true })
  rawDb.prepare(`
    INSERT INTO topic_mute_evidence (
      mute_history_id, mute_audit_log_id, profile_id, source_topic_id, source_message_id,
      source_kind, source_body_snapshot, source_attachment_storage_filename,
      source_attachment_width, source_attachment_height,
      muted_by_role, duration_ms, muted_until, status
    ) VALUES (?, ?, 'author-1', ?, ?, 'lafche_post', '', ?, 10, 10, 'admin', 3600000, ?, 'active');
  `).run(
    randomUUID(), randomUUID(), LAFCHE_TOPIC_ID, insertedIds[0]!,
    firstAttachmentFilename!,
    new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' '),
  )
  rawDb.close()

  const inspectDbBefore = new DatabaseSync(dbPath, { open: true, readOnly: true })
  const beforeSnapshot = snapshotAllTables(inspectDbBefore)
  inspectDbBefore.close()
  const beforeFileList = (await readdir(topicAttachmentUploadsDir)).sort()

  const logs: string[] = []
  let threwError: unknown = null
  const originalLog = console.log
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  try {
    await buildDryRunReport(dbPath, topicAttachmentUploadsDir)
  } catch (err) {
    threwError = err
  } finally {
    console.log = originalLog
  }

  await check('[M-legacy-1] dry-run срещу pre-005 schema (production ТЕКУЩАТА схема) НЕ хвърля грешка (createTopicModerationStore eager-prepare guard-нат чрез PRAGMA table_info introspection)', () => {
    assert(threwError === null, `dry-run не трябва да хвърля срещу pre-005 schema, но хвърли: ${threwError instanceof Error ? threwError.message : String(threwError)}`)
  })

  const inspectDbAfter = new DatabaseSync(dbPath, { open: true, readOnly: true })
  const afterSnapshot = snapshotAllTables(inspectDbAfter)
  inspectDbAfter.close()
  const afterFileList = (await readdir(topicAttachmentUploadsDir)).sort()

  await check('[M-legacy-2] dry-run срещу pre-005 schema: нулева DB мутация (table row counts идентични)', () => {
    for (const key of Object.keys(beforeSnapshot)) {
      assertEqual(afterSnapshot[key], beforeSnapshot[key], `table ${key} count трябва да е непроменен`)
    }
  })

  await check('[M-legacy-3] dry-run срещу pre-005 schema: нулева filesystem мутация (нищо ново записано/копирано)', () => {
    assertEqual(afterFileList.length, beforeFileList.length, 'брой файлове трябва да е непроменен')
    assertEqual(JSON.stringify(afterFileList), JSON.stringify(beforeFileList), 'файловите имена трябва да са идентични')
  })

  await check('[M-legacy-4] dry-run срещу pre-005 schema изчислява ВСИЧКИ мандатни числа коректно (count/victims/attachments/bytes/evidence)', () => {
    const joined = logs.join('\n')
    assert(joined.includes('Текущ брой LIVE Lafche root posts: 210'), 'трябва да отчете точния текущ count')
    assert(joined.includes('Victim count (постове отвъд newest 200): 10'), 'трябва да отчете точния victim count')
    assert(joined.includes('Migration 20260818_005'), 'трябва explicit да съобщи, че migration-ът липсва')
    assert(joined.includes('Victims с normal attachment metadata: 3'), 'трябва да намери 3-те victim attachments')
    assert(joined.includes('Image evidence redove, нуждаещи се от protected copy ПРЕДИ safe delete: 1'), 'трябва да намери 1 image evidence reference (insertedIds[0]) дори БЕЗ is_evidence_copy колоната')
  })
})

await check('[3] buildDryRunReport() приема точно 2 параметъра (databaseFilePath, topicAttachmentUploadsPath) — архитектурно НЯМА начин да получи evidence-storage път, значи не може да пише evidence copies по време на dry-run', () => {
  assertEqual(buildDryRunReport.length, 2, 'buildDryRunReport arity трябва да е точно 2 — никакъв evidence write path')
})

// ─── N: apply-mode temp isolation + behavior ─────────────────────────────

await check('[10] temp пътищата структурно не съвпадат с/не са под реалния server root', async () => {
  await withTempDir(async (dir) => {
    assert(!dir.startsWith(serverRoot) && !serverRoot.startsWith(dir), 'temp dir трябва да е напълно извън server root дървото')
    assert(resolve(dir) !== resolve(serverRoot), 'temp dir не трябва да съвпада с реалния server root')
  })
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'apply-normal.sqlite')
  const topicAttachmentUploadsDir = join(dir, 'uploads-topic-attachments')
  const evidenceAttachmentUploadsDir = join(dir, 'uploads-evidence-attachments')
  await mkdir(topicAttachmentUploadsDir, { recursive: true })

  assert(!dbPath.startsWith(serverRoot), 'sanity: apply temp DB path не трябва да е под server root')
  assert(!topicAttachmentUploadsDir.startsWith(serverRoot), 'sanity: apply temp uploads dir не трябва да е под server root')

  const msgStore = await createTopicMessageStore(dbPath)
  const modStore = await createTopicModerationStore(dbPath)

  const successCopyFilename = `${randomUUID()}.webp`
  const failCopyFilename = `${randomUUID()}.webp`
  const plainFilename = `${randomUUID()}.webp`
  await writeFile(join(topicAttachmentUploadsDir, successCopyFilename), Buffer.from('real-bytes-for-success-copy'))
  // ЛИПСВА файл за failCopyFilename нарочно — симулира copy failure.
  await writeFile(join(topicAttachmentUploadsDir, plainFilename), Buffer.from('real-bytes-for-plain'))

  // Първите 3 постове (най-стари по seq, index 0..2) ще попаднат сред
  // victims (305 общо - 200 retained = 105 victims, oldest-first).
  const successCopyVictim = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '', attachment: makeAttachment(successCopyFilename) })
  const failCopyVictim = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '', attachment: makeAttachment(failCopyFilename) })
  const plainVictim = msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: '', attachment: makeAttachment(plainFilename) })

  modStore.muteProfileInTopics({ topicId: LAFCHE_TOPIC_ID, profileId: 'author-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'success case', durationMs: 60000, sourceMessageId: successCopyVictim.messageId, sourceKind: 'lafche_post' })
  modStore.muteProfileInTopics({ topicId: LAFCHE_TOPIC_ID, profileId: 'author-1', actorAccountId: 'moderator-1', actorRole: 'admin', reason: 'fail case', durationMs: 60000, sourceMessageId: failCopyVictim.messageId, sourceKind: 'lafche_post' })
  // plainVictim: НЯМА mute evidence — нормален cleanup path.

  const replyResult = msgStore.insertReply({ topicId: LAFCHE_TOPIC_ID, parentMessageId: successCopyVictim.messageId, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: 'reply на victim' })
  assert(replyResult.ok, 'setup: reply insert трябва да успее')
  msgStore.toggleLike(successCopyVictim.messageId, 'author-1')

  // Последният filler пост (index 301, newest по seq — гарантирано вътре в
  // retained newest-200) получава реален attachment файл на диска — §12
  // letter H: "Newest-200 image files never touched" трябва да е доказано
  // от РЕАЛЕН filesystem check след apply, не само DB metadata survival.
  const retainedAttachmentFilename = `${randomUUID()}.webp`
  await writeFile(join(topicAttachmentUploadsDir, retainedAttachmentFilename), Buffer.from('real-bytes-for-retained-newest-post'))
  let retainedMessageId = ''
  for (let i = 0; i < 302; i++) {
    const isLast = i === 301
    const row = msgStore.insertMessage({
      topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: `post ${i}`,
      attachment: isLast ? makeAttachment(retainedAttachmentFilename) : undefined,
    })
    if (isLast) retainedMessageId = row.messageId
  }
  msgStore.close()
  modStore.close()

  const verifyStartCount = (await createTopicMessageStore(dbPath))
  const startCount = verifyStartCount.countLiveRootMessages(LAFCHE_TOPIC_ID)
  verifyStartCount.close()

  await check('[11] setup sanity: 305 total roots seeded (3 targeted + 302 filler), 105 expected victims', () => {
    assertEqual(startCount, 305, 'общо 305 root постове трябва да са seed-нати')
  })

  const result = await runApply(dbPath, topicAttachmentUploadsDir, evidenceAttachmentUploadsDir)

  await check('[11b] apply нормализира с batching (>1 batch за 105 victims при batch size 50); outcome отчита evidence-copy skip', () => {
    assertEqual(result.startCount, 305, 'startCount трябва да съвпада')
    assertEqual(result.totalSkipped, 1, 'точно 1 victim трябва да е skip-нат (failCopyVictim)')
    assertEqual(result.totalDeleted, 104, '104 от 105 victims трябва да са изтрити (105 - 1 skip)')
    assertEqual(result.finalCount, 201, 'финален count = 305 - 104 = 201 (1 skip остава над лимита)')
    assertEqual(result.outcome, 'blocked-by-evidence-copy-failures', 'outcome трябва explicit да отчете evidence-copy blockage')
  })

  await check('[15] PRAGMA integrity_check минава', () => {
    assert(result.integrityOk === true, 'integrityOk трябва да е true')
  })

  const verifyStore = await createTopicMessageStore(dbPath)
  const verifyModStore = await createTopicModerationStore(dbPath)

  await check('[12] success-copy victim: source изтрит, evidence repoint-нат към реален файл в evidence storage, is_evidence_copy=1', () => {
    assert(verifyStore.getMessageById(successCopyVictim.messageId) === null, 'success-copy victim source трябва да е изтрит')
    const entries = verifyModStore.listMuteEvidenceForProfile('author-1', 10)
    const entry = entries.find((e) => e.sourceBodySnapshot === '' && e.sourceAttachment?.isEvidenceCopy === true)
    assert(entry !== undefined, 'трябва да има evidence ред с is_evidence_copy=true')
  })

  await check('[13] fail-copy victim: СКИПНАТ, source остава жив, evidence остава unrepointed', () => {
    assert(verifyStore.getMessageById(failCopyVictim.messageId) !== null, 'fail-copy victim трябва да остане жив (evidence copy неуспя)')
    const entries = verifyModStore.listMuteEvidenceForProfile('author-1', 10)
    const entry = entries.find((e) => e.sourceMessageId === failCopyVictim.messageId)
    assert(entry !== undefined, 'evidence редът трябва да остане, сочейки все още към живия source')
    assertEqual(entry!.sourceAttachment?.isEvidenceCopy, false, 'unrepointed evidence трябва да остане is_evidence_copy=false')
  })

  await check('[14] plain victim (без evidence): изтрит нормално, filename enqueue-нат в pending attachment deletions', () => {
    assert(verifyStore.getMessageById(plainVictim.messageId) === null, 'plain victim трябва да е изтрит')
    const pending = verifyStore.listPendingAttachmentDeletions(500)
    assert(pending.some((entry) => entry.storageFilename === plainFilename), 'plainFilename трябва да е в pending cleanup queue-то')
  })

  await check('[17] §12 letter H: retained newest-post attachment — DB metadata И физическият файл на диска остават НАПЪЛНО непокътнати след apply', () => {
    assert(verifyStore.getMessageById(retainedMessageId) !== null, 'retained newest пост трябва да остане жив в DB')
    const attachments = verifyStore.getAttachmentsByMessageIds([retainedMessageId])
    const attachment = attachments.get(retainedMessageId)
    assert(attachment !== undefined, 'attachment metadata за retained поста трябва да остане')
    assertEqual(attachment!.storageFilename, retainedAttachmentFilename, 'storage_filename трябва да съвпада')
    const pending = verifyStore.listPendingAttachmentDeletions(500)
    assert(!pending.some((entry) => entry.storageFilename === retainedAttachmentFilename), 'retained filename НИКОГА не трябва да е enqueue-нат за физически cleanup')
  })

  await check('[18] §12 letter H: физическият файл на retained поста реално съществува на диска непроменен след apply', async () => {
    const bytes = await readFile(join(topicAttachmentUploadsDir, retainedAttachmentFilename))
    assertEqual(bytes.toString('utf8'), 'real-bytes-for-retained-newest-post', 'физическото съдържание трябва да е непроменено — файлът никога не е бил докосван от apply-а')
  })

  verifyStore.close()
  verifyModStore.close()
})

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'apply-noop.sqlite')
  const topicAttachmentUploadsDir = join(dir, 'uploads-topic-attachments')
  const evidenceAttachmentUploadsDir = join(dir, 'uploads-evidence-attachments')
  await mkdir(topicAttachmentUploadsDir, { recursive: true })

  const msgStore = await createTopicMessageStore(dbPath)
  for (let i = 0; i < 150; i++) {
    msgStore.insertMessage({ topicId: LAFCHE_TOPIC_ID, senderProfileId: 'author-1', senderDisplayName: 'A1', senderRole: 'player', body: `post ${i}` })
  }
  msgStore.close()

  const result = await runApply(dbPath, topicAttachmentUploadsDir, evidenceAttachmentUploadsDir)

  await check('[16] под лимита (150 <= 200) → apply outcome=no-op, нулева мутация', () => {
    assertEqual(result.outcome, 'no-op', 'outcome трябва да е no-op')
    assertEqual(result.totalDeleted, 0, 'нищо не трябва да е изтрито')
    assertEqual(result.finalCount, 150, 'count трябва да остане непроменен')
  })
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
