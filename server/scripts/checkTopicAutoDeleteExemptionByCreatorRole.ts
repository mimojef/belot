/**
 * checkTopicAutoDeleteExemptionByCreatorRole.ts
 *
 * Store-level checks за новото business правило: нормална "Тема", създадена
 * от privileged автор (admin/subadmin/chat_admin/top_chat_admin/pika_team) В
 * МОМЕНТА НА СЪЗДАВАНЕ, никога не влиза в 72h inactivity victim set-а
 * (findInactivityCandidates в topicHardDeleteService.ts). Exemption-ът е
 * базиран на persisted immutable snapshot (topics.created_by_role,
 * migration 20260901_001), НЕ на текущата роля на автора при cleanup run-а.
 *
 * Manual "кошче" hard delete (hardDeleteTopic) НЕ е засегнат — покрито от
 * checkTopicHardDeleteService.ts (непроменен primitive) и от
 * checkTopicAutoDeleteExemptionManualDeleteRealtime.ts (E2E proof чрез
 * реалния production endpoint).
 *
 * === Section A: 72h auto-cleanup eligibility по created_by_role ===
 * [1]  player-created тема, >72h inactive → Е candidate
 * [2]  admin-created тема, >72h inactive → НЕ Е candidate
 * [3]  subadmin-created тема, >72h inactive → НЕ Е candidate
 * [4]  chat_admin-created тема, >72h inactive → НЕ Е candidate
 * [5]  top_chat_admin-created тема, >72h inactive → НЕ Е candidate
 * [6]  pika_team-created тема, >72h inactive → НЕ Е candidate
 * [9]  admin-created тема, ИЗКЛЮЧИТЕЛНО стара активност (1000h) → пак НЕ Е candidate
 * [10a] topic-general (is_general=1) остава изключена дори с created_by_role='admin' (layering unaffected)
 * [10b] topic-lafche остава изключена дори с created_by_role='admin' (layering unaffected)
 * [11] Legacy ред (created_by_role = NULL, симулира тема отпреди миграцията) → третиран като НЕ exempt (най-консервативната backfill политика)
 *
 * === Section C: Predicate purity / immutability (isTopicAutoDeleteExemptByAuthorRole) ===
 * [C1] Всяка от 5-те privileged роли → true
 * [C2] 'player' → false
 * [C3] null (unknown/legacy snapshot) → false
 * [C4] Произволен непознат string (defensive) → false
 * [C5] TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES съдържа ТОЧНО 5-те изисквани роли, нищо повече/по-малко
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  createTopicHardDeleteService,
  isTopicAutoDeleteExemptByAuthorRole,
  TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES,
} from '../src/db/topicHardDeleteService.js'
import { createTopicStore } from '../src/db/topicStore.js'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'

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
  '20260901_001_add_created_by_role_to_topics.sql',
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

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-topic-auto-delete-exemption-check-'))
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
  db.close()
  return dbPath
}

// ─── Section A: eligibility по created_by_role ─────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupDb(dir, 'exemption.sqlite')
  const topicStore = await createTopicStore(dbPath)
  const messageStore = await createTopicMessageStore(dbPath)
  const hardDeleteService = await createTopicHardDeleteService(dbPath)
  try {
    const db = new DatabaseSync(dbPath, { open: true })

    function createBackdatedTopic(topicId: string, title: string, createdByRole: Parameters<typeof topicStore.createTopic>[0]['createdByRole'], hoursAgo: number): void {
      const result = topicStore.createTopic({ title, createdByProfileId: 'author-1', createdByRole })
      assert(result.ok, `createTopic(${title}) трябва да успее`)
      // topicStore.createTopic генерира случаен topic_id (UUID) — пренасочваме
      // го към детерминиран literal, за да можем да го адресираме по-долу.
      db.prepare(`UPDATE topics SET topic_id = ? WHERE topic_id = ?`).run(topicId, result.ok ? result.topic.topicId : '')
      const root = messageStore.insertMessage({ topicId, senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'root' })
      db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(hoursAgo * HOUR_MS), root.messageId)
    }

    createBackdatedTopic('topic-by-player', 'By Player', 'player', 73)
    createBackdatedTopic('topic-by-admin', 'By Admin', 'admin', 73)
    createBackdatedTopic('topic-by-subadmin', 'By Subadmin', 'subadmin', 73)
    createBackdatedTopic('topic-by-chat-admin', 'By Chat Admin', 'chat_admin', 73)
    createBackdatedTopic('topic-by-top-chat-admin', 'By Top Chat Admin', 'top_chat_admin', 73)
    createBackdatedTopic('topic-by-pika-team', 'By Pika Team', 'pika_team', 73)
    createBackdatedTopic('topic-by-admin-ancient', 'By Admin Ancient', 'admin', 1000)

    // [10a]/[10b]: layering — is_general/LAFCHE_TOPIC_ID exclusion остава
    // authoritative дори ако created_by_role случайно е 'admin' (defensive,
    // тези две системни теми никога реално не минават през нормалния
    // create-topic path, но проверяваме, че guard-ите не разчитат само на
    // created_by_role IS NULL).
    db.prepare(`
      INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order, created_by_role)
      VALUES ('topic-general-exemption-test', 'general-exemption-slug', 'Общи', 1, NULL, 'active', 0, 'admin');
    `).run()
    const generalRoot = messageStore.insertMessage({ topicId: 'topic-general-exemption-test', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'general' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(200 * HOUR_MS), generalRoot.messageId)

    db.prepare(`UPDATE topics SET created_by_role = 'admin' WHERE topic_id = 'topic-lafche'`).run()
    const lafcheRoot = messageStore.insertMessage({ topicId: 'topic-lafche', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'lafche' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(200 * HOUR_MS), lafcheRoot.messageId)

    // [11]: legacy ред — created_by_role остава NULL (както при ADD COLUMN
    // без backfill), симулира тема създадена ПРЕДИ 20260901_001.
    db.prepare(`
      INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order, created_by_role)
      VALUES ('topic-legacy-null-role', 'legacy-null-role-slug', 'Legacy', 0, 'author-1', 'active', 0, NULL);
    `).run()
    const legacyRoot = messageStore.insertMessage({ topicId: 'topic-legacy-null-role', senderProfileId: 'author-1', senderDisplayName: 'A', senderRole: 'player', body: 'legacy root' })
    db.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(msAgoSqliteString(73 * HOUR_MS), legacyRoot.messageId)

    db.close()

    const cutoff = new Date(Date.now() - 72 * HOUR_MS)
    const candidates = hardDeleteService.findInactivityCandidates(cutoff, 200)
    const candidateIds = new Set(candidates.map((c) => c.topicId))

    await check('[1] player-created тема, >72h inactive → Е candidate', () => {
      assert(candidateIds.has('topic-by-player'), 'player-created трябва да е auto-delete candidate')
    })
    await check('[2] admin-created тема, >72h inactive → НЕ Е candidate', () => {
      assert(!candidateIds.has('topic-by-admin'), 'admin-created темата никога не влиза в victim set-а')
    })
    await check('[3] subadmin-created тема, >72h inactive → НЕ Е candidate', () => {
      assert(!candidateIds.has('topic-by-subadmin'), 'subadmin-created темата никога не влиза в victim set-а')
    })
    await check('[4] chat_admin-created тема, >72h inactive → НЕ Е candidate', () => {
      assert(!candidateIds.has('topic-by-chat-admin'), 'chat_admin-created темата никога не влиза в victim set-а')
    })
    await check('[5] top_chat_admin-created тема, >72h inactive → НЕ Е candidate', () => {
      assert(!candidateIds.has('topic-by-top-chat-admin'), 'top_chat_admin-created темата никога не влиза в victim set-а')
    })
    await check('[6] pika_team-created тема, >72h inactive → НЕ Е candidate', () => {
      assert(!candidateIds.has('topic-by-pika-team'), 'pika_team-created темата никога не влиза в victim set-а')
    })
    await check('[9] admin-created тема, изключително стара активност (1000h) → пак НЕ Е candidate', () => {
      assert(!candidateIds.has('topic-by-admin-ancient'), 'exemption-ът не зависи от ГРАДУСА на inactivity — важи неограничено')
    })
    await check('[10a] topic-general остава изключена дори с created_by_role=\'admin\'', () => {
      assert(!candidateIds.has('topic-general-exemption-test'), 'is_general=1 guard-ът е независим слой от created_by_role')
    })
    await check('[10b] topic-lafche остава изключена дори с created_by_role=\'admin\'', () => {
      assert(!candidateIds.has('topic-lafche'), 'LAFCHE_TOPIC_ID guard-ът е независим слой от created_by_role')
    })
    await check('[11] Legacy ред (created_by_role=NULL) → третиран като НЕ exempt', () => {
      assert(candidateIds.has('topic-legacy-null-role'), 'NULL snapshot = "не е доказано privileged" ⇒ следва нормалния 72h lifecycle')
    })
  } finally {
    hardDeleteService.close()
    messageStore.close()
    topicStore.close()
  }
})

// ─── Section C: Predicate purity ────────────────────────────────────────────

console.log('\n=== Section C: isTopicAutoDeleteExemptByAuthorRole — predicate purity ===\n')

await check('[C1] Всяка от 5-те privileged роли → true', () => {
  for (const role of ['admin', 'subadmin', 'chat_admin', 'top_chat_admin', 'pika_team']) {
    assert(isTopicAutoDeleteExemptByAuthorRole(role) === true, `${role} трябва да е exempt`)
  }
})
await check('[C2] \'player\' → false', () => {
  assert(isTopicAutoDeleteExemptByAuthorRole('player') === false, 'player НЕ е exempt роля')
})
await check('[C3] null (unknown/legacy snapshot) → false', () => {
  assert(isTopicAutoDeleteExemptByAuthorRole(null) === false, 'null (недоказана роля) НЕ е exempt')
})
await check('[C4] Произволен непознат string (defensive) → false', () => {
  assert(isTopicAutoDeleteExemptByAuthorRole('guest') === false, 'непозната стойност НЕ е exempt')
  assert(isTopicAutoDeleteExemptByAuthorRole('') === false, 'празен string НЕ е exempt')
})
await check('[C5] TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES съдържа ТОЧНО 5-те изисквани роли', () => {
  const expected = new Set(['admin', 'subadmin', 'chat_admin', 'top_chat_admin', 'pika_team'])
  const actual = new Set<string>(TOPIC_AUTO_DELETE_EXEMPT_CREATOR_ROLES)
  assert(actual.size === expected.size, `очаквани ${expected.size} роли, намерени ${actual.size}`)
  for (const role of expected) {
    assert(actual.has(role), `липсва изисквана роля: ${role}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
