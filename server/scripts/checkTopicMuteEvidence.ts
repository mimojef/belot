/**
 * checkTopicMuteEvidence.ts
 *
 * Targeted store-level checks за mute-evidence/history layer (виж migration
 * 20260817_003_create_topic_mute_evidence.sql + topicModerationStore.ts
 * insertMuteEvidence/listMuteEvidenceForProfile). Store-level (не HTTP/WS
 * spawn) — mirror на checkTopicModeration.ts pattern-a, само критичните 8
 * проверки от mute-evidence брифа §12, не пълен regression suite.
 *
 * [1] muteProfileInTopics с sourceMessageId → history record се създава, snapshot body взет от DB
 * [2] Snapshot идва от DB, не от client-influenced input (insertMuteEvidence не приема body параметър изобщо)
 * [3] Delete на original message (soft-delete) СЛЕД mute → history snapshot (body) остава непроменен, originalMessageDeletedAt отразява delete-а at READ time
 * [4] Втори mute на същия profile → втори history record (append-only, не overwrite)
 * [5] Manual unmute → history record маркиран manually_unmuted + unmutedAt/unmutedByAccountId попълнени
 * [6] listMuteEvidenceForProfile за profile A не връща записи на profile B (permission isolation, source за user-facing endpoint-а)
 * [7] mute без sourceMessageId (sourceMessageId=null) → sourceKind='unspecified', snapshot полета празни, без грешка
 * [8] Атомарност: mute state + evidence record се създават в СЪЩАТА транзакция (проверено косвено — insertMuteEvidence се вика вътре в muteProfileInTopics, няма отделен call site в index.ts)
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
const selfDeletionAuditMigrationPath = resolve(serverRoot, 'database/migrations/20260812_002_create_topic_message_self_deletion_audit.sql')
const editMigrationPath = resolve(serverRoot, 'database/migrations/20260812_003_add_topic_message_editing.sql')
const sectionMutesMigrationPath = resolve(serverRoot, 'database/migrations/20260814_001_create_topic_section_mutes.sql')
const lafcheSeedMigrationPath = resolve(serverRoot, 'database/migrations/20260817_002_seed_topic_lafche.sql')
const muteEvidenceMigrationPath = resolve(serverRoot, 'database/migrations/20260817_003_create_topic_mute_evidence.sql')
const evidenceAttachmentCopyMigrationPath = resolve(serverRoot, 'database/migrations/20260818_005_add_topic_mute_evidence_attachment_copy.sql')

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-mute-evidence-check-'))
  try {
    await fn(dir)
  } finally {
    // Windows понякога държи handle към .sqlite-wal/.sqlite-shm за кратко
    // СЛЕД db.close() (delayed OS-level release) — cleanup failure тук е
    // ирелевантно за коректността на теста (вече е приключил), затова
    // retry + swallow (established pattern, виж retryRm в
    // checkTopicModerationAuthRealtime.ts) вместо необработено rejection,
    // което би съборило целия process.
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch { /* best-effort temp dir cleanup — не е test failure */ }
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
  await applyMigrationFile(db, sectionMutesMigrationPath)
  await applyMigrationFile(db, lafcheSeedMigrationPath)
  await applyMigrationFile(db, muteEvidenceMigrationPath)
  await applyMigrationFile(db, evidenceAttachmentCopyMigrationPath)
  seedAccount(db, 'moderator-1')
  seedProfile(db, 'target-1')
  seedProfile(db, 'target-2')
  db.close()
  return dbPath
}

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'evidence.sqlite')
  const modStore = await createTopicModerationStore(dbPath)
  const msgStore = await createTopicMessageStore(dbPath)
  try {
    const rootMessage = msgStore.insertMessage({
      topicId: 'topic-lafche',
      senderProfileId: 'target-1',
      senderDisplayName: 'Target One',
      senderRole: 'player',
      body: 'обиден коментар за snapshot теста',
    })

    await check('[1] muteProfileInTopics с sourceMessageId → history record се създава, snapshot body взет от DB', () => {
      modStore.muteProfileInTopics({
        topicId: 'topic-lafche',
        profileId: 'target-1',
        actorAccountId: 'moderator-1',
        actorRole: 'admin',
        reason: 'обиди',
        reasonCategory: 'insults',
        durationMs: 60 * 60 * 1000,
        sourceMessageId: rootMessage.messageId,
        sourceKind: 'lafche_post',
      })
      const entries = modStore.listMuteEvidenceForProfile('target-1', 10)
      assertEqual(entries.length, 1, 'трябва да има точно 1 history record')
      assertEqual(entries[0]!.sourceBodySnapshot, 'обиден коментар за snapshot теста', 'snapshot body трябва да съвпада с DB съдържанието')
      assertEqual(entries[0]!.sourceKind, 'lafche_post', 'sourceKind трябва да е lafche_post')
      assertEqual(entries[0]!.status, 'active', 'нов mute трябва да е active')
      assertEqual(entries[0]!.reasonCategory, 'insults', 'reasonCategory трябва да съвпада')
    })

    await check('[2] insertMuteEvidence не приема client-provided body — snapshot е ЕДИНСТВЕНО DB-derived (source-level guarantee)', () => {
      // muteProfileInTopics/insertMuteEvidence сигнатурата няма body/content
      // параметър изобщо (виж topicModerationStore.ts) — единственият начин
      // body да влезе в evidence реда е през SELECT от topic_messages по
      // sourceMessageId. Тук просто потвърждаваме, че реалната snapshot
      // стойност съвпада 1:1 с DB реда, не с нещо различно.
      const row = new DatabaseSync(dbPath, { open: true }).prepare(
        `SELECT body FROM topic_messages WHERE message_id = ?`,
      ).get(rootMessage.messageId) as { body: string }
      const entries = modStore.listMuteEvidenceForProfile('target-1', 10)
      assertEqual(entries[0]!.sourceBodySnapshot, row.body, 'evidence snapshot трябва да съвпада точно с DB body-то')
    })

    await check('[3] Delete на original message СЛЕД mute → snapshot остава, originalMessageDeletedAt отразява delete-а at READ time', () => {
      const beforeDelete = modStore.listMuteEvidenceForProfile('target-1', 10)
      assertEqual(beforeDelete[0]!.originalMessageDeletedAt, null, 'преди delete трябва да е null')

      msgStore.deleteMessage({
        topicId: 'topic-lafche',
        messageId: rootMessage.messageId,
        actorAccountId: 'moderator-1',
        actorRole: 'admin',
      })

      const afterDelete = modStore.listMuteEvidenceForProfile('target-1', 10)
      assertEqual(afterDelete[0]!.sourceBodySnapshot, 'обиден коментар за snapshot теста', 'snapshot текстът трябва да ОСТАНЕ непроменен след delete на оригинала')
      assert(afterDelete[0]!.originalMessageDeletedAt !== null, 'originalMessageDeletedAt трябва да се попълни СЛЕД delete-а (live read, не само snapshot-time)')
    })

    await check('[4] Втори mute на същия profile → втори history record (append-only, НЕ overwrite)', () => {
      const secondMessage = msgStore.insertMessage({
        topicId: 'topic-lafche',
        senderProfileId: 'target-1',
        senderDisplayName: 'Target One',
        senderRole: 'player',
        body: 'втори нарушаващ пост',
      })
      modStore.muteProfileInTopics({
        topicId: 'topic-lafche',
        profileId: 'target-1',
        actorAccountId: 'moderator-1',
        actorRole: 'admin',
        reason: 'повторно нарушение',
        durationMs: 30 * 60 * 1000,
        sourceMessageId: secondMessage.messageId,
        sourceKind: 'lafche_post',
      })
      const entries = modStore.listMuteEvidenceForProfile('target-1', 10)
      assertEqual(entries.length, 2, 'трябва да има 2 history records след втори mute')
      assertEqual(entries[0]!.sourceBodySnapshot, 'втори нарушаващ пост', 'най-новият запис (DESC order) трябва да е вторият mute')
    })

    await check('[5] Manual unmute → history record маркиран manually_unmuted + unmutedAt попълнен', () => {
      const { changed } = modStore.unmuteProfileInTopics({
        topicId: 'topic-lafche',
        profileId: 'target-1',
        actorAccountId: 'moderator-1',
        actorRole: 'admin',
      })
      assertEqual(changed, true, 'unmute на активен mute трябва да е changed=true')

      const entries = modStore.listMuteEvidenceForProfile('target-1', 10)
      const latest = entries[0]!
      assertEqual(latest.status, 'manually_unmuted', 'най-новият (последен active) record трябва да стане manually_unmuted')
      assert(latest.unmutedAt !== null, 'unmutedAt трябва да е попълнен')
      assertEqual(latest.unmutedByAccountId, 'moderator-1', 'unmutedByAccountId трябва да съвпада с actor-а')

      // По-старият (първи) mute record's muted_until е все още в бъдещето
      // (60мин duration, тестът тече за milliseconds) — unmuteProfileInTopics
      // маркира само НАЙ-СКОРОШНИЯ active record (виж
      // markLatestActiveMuteEvidenceUnmutedStatement коментара в
      // topicModerationStore.ts), затова по-старият остава 'active'
      // непроменен (не 'expired' — expired е computed at read time само
      // след реално изтичане на muted_until, не се засяга тук).
      const older = entries[1]!
      assertEqual(older.status, 'active', 'по-старият record НЕ трябва да е засегнат от unmute-а на по-новия (само НАЙ-СКОРОШНИЯТ active record се маркира)')
    })

    await check('[6] listMuteEvidenceForProfile за target-2 НЕ връща записи на target-1 (profile isolation)', () => {
      const entriesForOther = modStore.listMuteEvidenceForProfile('target-2', 10)
      assertEqual(entriesForOther.length, 0, 'target-2 не трябва да има никакви history records')
    })

    await check('[7] mute без sourceMessageId (null) → sourceKind=unspecified, snapshot полета празни, без грешка', () => {
      modStore.muteProfileInTopics({
        topicId: 'topic-lafche',
        profileId: 'target-2',
        actorAccountId: 'moderator-1',
        actorRole: 'admin',
        reason: 'без конкретен пост',
        durationMs: 60 * 60 * 1000,
        sourceMessageId: null,
        sourceKind: 'unspecified',
      })
      const entries = modStore.listMuteEvidenceForProfile('target-2', 10)
      assertEqual(entries.length, 1, 'трябва да има 1 record за target-2')
      assertEqual(entries[0]!.sourceKind, 'unspecified', 'sourceKind трябва да е unspecified')
      assertEqual(entries[0]!.sourceBodySnapshot, '', 'snapshot body трябва да е празен string')
      assertEqual(entries[0]!.sourceAttachment, null, 'sourceAttachment трябва да е null')
    })

    await check('[8] Атомарност: mute state (topic_section_mutes) и evidence record се появяват заедно', () => {
      // Косвена проверка — след muteProfileInTopics извикването в [7],
      // ОЧАКВАМЕ getSectionMuteSnapshot(target-2).isMuted === true И
      // listMuteEvidenceForProfile(target-2) да съдържа съответния запис.
      // insertMuteEvidence се извиква ВЪТРЕ в muteProfileInTopics (виж
      // topicModerationStore.ts), в СЪЩАТА BEGIN IMMEDIATE транзакция като
      // upsertSectionMuteStatement + appendAudit — няма отделен call site,
      // от който evidence insert-ът да липсва.
      const muteSnapshot = modStore.getSectionMuteSnapshot('target-2')
      assertEqual(muteSnapshot.isMuted, true, 'target-2 трябва да е активно мутнат')
      const entries = modStore.listMuteEvidenceForProfile('target-2', 10)
      assertEqual(entries.length, 1, 'evidence записът трябва да съществува заедно с mute state-а')
      assertEqual(entries[0]!.status, 'active', 'evidence записът трябва да е active, съвпадащ с mute state-а')
    })
  } finally {
    modStore.close()
    msgStore.close()
  }
})

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
