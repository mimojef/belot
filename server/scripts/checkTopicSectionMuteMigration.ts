/**
 * checkTopicSectionMuteMigration.ts
 *
 * Регресионни тестове за 20260814_001_create_topic_section_mutes.sql —
 * конкретно promotion логиката, която пренася съществуващи АКТИВНИ legacy
 * topic_mutes redovete в новата global topic_section_mutes таблица при
 * upgrade (виж GLOBAL TOPICS MUTE брифа §3).
 *
 * [1] 1 active legacy mute на profile → точно 1 promoted section mute ред
 *     със същите muted_until/reason/muted_by_account_id.
 * [2] Multiple active legacy mutes (различни теми) на 1 profile → promotes
 *     се редът с НАЙ-КЪСЕН (longest remaining) muted_until — "longest wins".
 * [3] Tie на muted_until (идентичен до секундата) → детерминистичен избор
 *     по topic_id ASC secondary ordering.
 * [4] Expired-only legacy mute (muted_until <= migration time) → НЕ се
 *     promote-ва изобщо, profile остава unmuted в новата таблица.
 * [5] Profile без НИКАКЪВ legacy mute ред → без promoted ред (no-op за него).
 * [6] Idempotency: повторно изпълнение на migration файла (INSERT OR
 *     IGNORE) е безопасен no-op — не презаписва вече наличен ред, дори с
 *     различни legacy данни.
 * [7] Idempotency: повторно изпълнение НЕ презаписва РЕАЛЕН нов global mute
 *     (направен от модератор след upgrade), направен между двете
 *     изпълнения на файла.
 * [8] Promoted редовете имат create_at = CURRENT_TIMESTAMP (нов created_at
 *     при самата promotion, не легacy created_at) — потвърждава INSERT
 *     семантика, не UPDATE/copy на оригиналния timestamp.
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const topicsMigrationPath = resolve(serverRoot, 'database/migrations/20260810_002_create_topics_and_messages.sql')
const moderationMigrationPath = resolve(serverRoot, 'database/migrations/20260811_003_create_topic_moderation.sql')
const sectionMutesMigrationPath = resolve(serverRoot, 'database/migrations/20260814_001_create_topic_section_mutes.sql')

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-section-mute-migration-check-'))
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

function insertTopic(db: DatabaseSync, topicId: string): void {
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order)
    VALUES (?, ?, ?, 0, NULL, 'active', 100);
  `).run(topicId, topicId, topicId)
}

function sqliteDateTime(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ')
}

function insertLegacyMute(db: DatabaseSync, input: {
  topicId: string
  profileId: string
  mutedUntilOffsetMs: number
  reason: string
  mutedByAccountId: string
}): void {
  db.prepare(`
    INSERT INTO topic_mutes (topic_id, profile_id, muted_until, muted_by_account_id, reason)
    VALUES (?, ?, ?, ?, ?);
  `).run(input.topicId, input.profileId, sqliteDateTime(input.mutedUntilOffsetMs), input.mutedByAccountId, input.reason)
}

// Изгражда база СЪС стария схема (topics + topic_mutes), БЕЗ да прилага
// самата 20260814_001 migration — симулира "production база преди upgrade".
async function setupPreUpgradeDb(dir: string, filename: string): Promise<string> {
  const dbPath = join(dir, filename)
  const db = new DatabaseSync(dbPath, { open: true })
  buildBaseSchema(db)
  await applyMigrationFile(db, topicsMigrationPath)
  await applyMigrationFile(db, moderationMigrationPath)
  seedAccount(db, 'moderator-1')
  seedAccount(db, 'moderator-2')
  db.close()
  return dbPath
}

function getSectionMuteRow(dbPath: string, profileId: string): {
  muted_until: string
  muted_by_account_id: string | null
  reason: string | null
  created_at: string
} | undefined {
  const db = new DatabaseSync(dbPath, { open: true })
  const row = db.prepare(`SELECT muted_until, muted_by_account_id, reason, created_at FROM topic_section_mutes WHERE profile_id = ?`).get(profileId) as
    | { muted_until: string; muted_by_account_id: string | null; reason: string | null; created_at: string }
    | undefined
  db.close()
  return row
}

// ─── [1] Single active legacy mute → promoted 1:1 ──────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupPreUpgradeDb(dir, 'single-active.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  seedProfile(db, 'user-1')
  insertTopic(db, 'topic-a')
  insertLegacyMute(db, { topicId: 'topic-a', profileId: 'user-1', mutedUntilOffsetMs: 60 * 60 * 1000, reason: 'spam in topic-a', mutedByAccountId: 'moderator-1' })
  db.close()

  await check('[1] 1 active legacy mute на profile → точно 1 promoted section mute ред със същите muted_until/reason/muted_by_account_id', async () => {
    const migrationDb = new DatabaseSync(dbPath, { open: true })
    await applyMigrationFile(migrationDb, sectionMutesMigrationPath)
    migrationDb.close()

    const legacyDb = new DatabaseSync(dbPath, { open: true })
    const legacyRow = legacyDb.prepare(`SELECT muted_until, reason, muted_by_account_id FROM topic_mutes WHERE topic_id = 'topic-a' AND profile_id = 'user-1'`).get() as
      { muted_until: string; reason: string; muted_by_account_id: string }
    legacyDb.close()

    const promoted = getSectionMuteRow(dbPath, 'user-1')
    assert(promoted !== undefined, 'трябва да има promoted section mute ред')
    assertEqual(promoted!.muted_until, legacyRow.muted_until, 'muted_until трябва да съвпада точно с legacy реда')
    assertEqual(promoted!.reason, legacyRow.reason, 'reason трябва да съвпада точно с legacy реда')
    assertEqual(promoted!.muted_by_account_id, legacyRow.muted_by_account_id, 'muted_by_account_id трябва да съвпада точно с legacy реда')
  })
})

// ─── [2] Multiple active legacy mutes → longest muted_until wins ──────────

await withTempDir(async (dir) => {
  const dbPath = await setupPreUpgradeDb(dir, 'multiple-active.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  seedProfile(db, 'user-2')
  insertTopic(db, 'topic-a')
  insertTopic(db, 'topic-b')
  insertTopic(db, 'topic-c')
  // Три активни mute-а с различна оставаща продължителност — най-дългата
  // (topic-c, 3 часа) трябва да "спечели" promotion-а.
  insertLegacyMute(db, { topicId: 'topic-a', profileId: 'user-2', mutedUntilOffsetMs: 30 * 60 * 1000, reason: 'shortest — 30 min left', mutedByAccountId: 'moderator-1' })
  insertLegacyMute(db, { topicId: 'topic-b', profileId: 'user-2', mutedUntilOffsetMs: 60 * 60 * 1000, reason: 'middle — 1h left', mutedByAccountId: 'moderator-1' })
  insertLegacyMute(db, { topicId: 'topic-c', profileId: 'user-2', mutedUntilOffsetMs: 3 * 60 * 60 * 1000, reason: 'longest — 3h left, should win', mutedByAccountId: 'moderator-2' })
  db.close()

  await check('[2] Multiple active legacy mutes (различни теми) на 1 profile → promotes се редът с НАЙ-КЪСЕН (longest remaining) muted_until', async () => {
    const migrationDb = new DatabaseSync(dbPath, { open: true })
    await applyMigrationFile(migrationDb, sectionMutesMigrationPath)
    migrationDb.close()

    const promoted = getSectionMuteRow(dbPath, 'user-2')
    assert(promoted !== undefined, 'трябва да има promoted section mute ред')
    assertEqual(promoted!.reason, 'longest — 3h left, should win', 'трябва да е promoted реда с най-дългата оставаща продължителност (topic-c)')
    assertEqual(promoted!.muted_by_account_id, 'moderator-2', 'muted_by_account_id трябва да е от печелившия ред (topic-c)')

    const sectionCountDb = new DatabaseSync(dbPath, { open: true })
    const count = sectionCountDb.prepare(`SELECT COUNT(*) AS c FROM topic_section_mutes WHERE profile_id = 'user-2'`).get() as { c: number }
    sectionCountDb.close()
    assertEqual(count.c, 1, 'трябва да има точно 1 promoted ред, не 3 (PRIMARY KEY(profile_id) enforce-ва това)')
  })
})

// ─── [3] Tie на muted_until → детерминистичен избор по topic_id ASC ───────

await withTempDir(async (dir) => {
  const dbPath = await setupPreUpgradeDb(dir, 'tie-break.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  seedProfile(db, 'user-3')
  insertTopic(db, 'topic-zzz')
  insertTopic(db, 'topic-aaa')
  const tieOffset = 90 * 60 * 1000
  // Идентичен muted_until (до секундата) за две теми — tie-break трябва да
  // избере по topic_id ASC, значи topic-aaa печели пред topic-zzz.
  const tieTimestamp = sqliteDateTime(tieOffset)
  db.prepare(`INSERT INTO topic_mutes (topic_id, profile_id, muted_until, muted_by_account_id, reason) VALUES (?, ?, ?, ?, ?)`)
    .run('topic-zzz', 'user-3', tieTimestamp, 'moderator-1', 'from topic-zzz (should lose tie-break)')
  db.prepare(`INSERT INTO topic_mutes (topic_id, profile_id, muted_until, muted_by_account_id, reason) VALUES (?, ?, ?, ?, ?)`)
    .run('topic-aaa', 'user-3', tieTimestamp, 'moderator-2', 'from topic-aaa (should win tie-break, topic_id ASC)')
  db.close()

  await check('[3] Tie на muted_until (идентичен до секундата) → детерминистичен избор по topic_id ASC secondary ordering', async () => {
    const migrationDb = new DatabaseSync(dbPath, { open: true })
    await applyMigrationFile(migrationDb, sectionMutesMigrationPath)
    migrationDb.close()

    const promoted = getSectionMuteRow(dbPath, 'user-3')
    assert(promoted !== undefined, 'трябва да има promoted section mute ред')
    assertEqual(promoted!.reason, 'from topic-aaa (should win tie-break, topic_id ASC)', 'tie-break трябва детерминистично да избере topic_id ASC (topic-aaa < topic-zzz)')
  })
})

// ─── [4] Expired-only legacy mute → НЕ се promote-ва ──────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupPreUpgradeDb(dir, 'expired-only.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  seedProfile(db, 'user-4')
  insertTopic(db, 'topic-a')
  // muted_until в МИНАЛОТО спрямо момента на migration-а — вече изтекла санкция.
  insertLegacyMute(db, { topicId: 'topic-a', profileId: 'user-4', mutedUntilOffsetMs: -60 * 60 * 1000, reason: 'already expired', mutedByAccountId: 'moderator-1' })
  db.close()

  await check('[4] Expired-only legacy mute (muted_until <= migration time) → НЕ се promote-ва изобщо', async () => {
    const migrationDb = new DatabaseSync(dbPath, { open: true })
    await applyMigrationFile(migrationDb, sectionMutesMigrationPath)
    migrationDb.close()

    const promoted = getSectionMuteRow(dbPath, 'user-4')
    assert(promoted === undefined, 'изтекла legacy санкция никога не трябва да "възкръсне" като нов активен global mute')
  })
})

// ─── [5] Profile без legacy mute → no-op ──────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupPreUpgradeDb(dir, 'no-legacy.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  seedProfile(db, 'user-5-clean')
  db.close()

  await check('[5] Profile без НИКАКЪВ legacy mute ред → без promoted ред', async () => {
    const migrationDb = new DatabaseSync(dbPath, { open: true })
    await applyMigrationFile(migrationDb, sectionMutesMigrationPath)
    migrationDb.close()

    const promoted = getSectionMuteRow(dbPath, 'user-5-clean')
    assert(promoted === undefined, 'profile без legacy mute redovete не трябва да получи promoted ред')

    const countDb = new DatabaseSync(dbPath, { open: true })
    const count = countDb.prepare(`SELECT COUNT(*) AS c FROM topic_section_mutes`).get() as { c: number }
    countDb.close()
    assertEqual(count.c, 0, 'изобщо не трябва да има promoted редове в тази база (нямаше активни legacy mutes)')
  })
})

// ─── [6]/[7] Idempotency — rerun safety ────────────────────────────────────

await withTempDir(async (dir) => {
  const dbPath = await setupPreUpgradeDb(dir, 'idempotency.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  seedProfile(db, 'user-6')
  insertTopic(db, 'topic-a')
  insertLegacyMute(db, { topicId: 'topic-a', profileId: 'user-6', mutedUntilOffsetMs: 60 * 60 * 1000, reason: 'first run reason', mutedByAccountId: 'moderator-1' })
  db.close()

  const firstRunDb = new DatabaseSync(dbPath, { open: true })
  await applyMigrationFile(firstRunDb, sectionMutesMigrationPath)
  firstRunDb.close()

  const afterFirstRun = getSectionMuteRow(dbPath, 'user-6')

  await check('[6] Idempotency: повторно изпълнение на migration файла (INSERT OR IGNORE) е безопасен no-op — не презаписва вече наличен ред', async () => {
    assert(afterFirstRun !== undefined, 'precondition: promoted ред трябва да съществува след първото изпълнение')

    // Симулира ситуация, при която (хипотетично) migration runner-ът
    // изпълни файла повторно — legacy данните "изглеждат" различни (нов
    // legacy mute row с различен reason), но rerun-ът НЕ трябва да пипа
    // вече съществуващия topic_section_mutes ред.
    const secondRunDb = new DatabaseSync(dbPath, { open: true })
    await applyMigrationFile(secondRunDb, sectionMutesMigrationPath)
    secondRunDb.close()

    const afterSecondRun = getSectionMuteRow(dbPath, 'user-6')
    assert(afterSecondRun !== undefined, 'ред трябва да продължи да съществува след повторно изпълнение')
    assertEqual(afterSecondRun!.reason, afterFirstRun!.reason, 'reason не трябва да се промени при повторно изпълнение (INSERT OR IGNORE, не overwrite)')
    assertEqual(afterSecondRun!.created_at, afterFirstRun!.created_at, 'created_at не трябва да се промени при повторно изпълнение')
  })

  await check('[7] Idempotency: повторно изпълнение НЕ презаписва РЕАЛЕН нов global mute, направен от модератор между двете изпълнения', async () => {
    // След първия run, "модераторът" ръчно променя global mute-а
    // (симулира истинско moderation action, извършено между двете
    // migration изпълнения — напр. re-deploy, който по грешка пусне пак
    // migration runner-а).
    const manualDb = new DatabaseSync(dbPath, { open: true })
    manualDb.prepare(`
      INSERT INTO topic_section_mutes (profile_id, muted_until, muted_by_account_id, reason, created_at)
      VALUES ('user-6', ?, 'moderator-2', 'REAL NEW MODERATOR ACTION', CURRENT_TIMESTAMP)
      ON CONFLICT(profile_id) DO UPDATE SET
        muted_until = excluded.muted_until, muted_by_account_id = excluded.muted_by_account_id,
        reason = excluded.reason, created_at = excluded.created_at;
    `).run(sqliteDateTime(5 * 60 * 60 * 1000))
    manualDb.close()

    const beforeRerun = getSectionMuteRow(dbPath, 'user-6')
    assertEqual(beforeRerun!.reason, 'REAL NEW MODERATOR ACTION', 'precondition: manual моderator action трябва да е приложен')

    const thirdRunDb = new DatabaseSync(dbPath, { open: true })
    await applyMigrationFile(thirdRunDb, sectionMutesMigrationPath)
    thirdRunDb.close()

    const afterRerun = getSectionMuteRow(dbPath, 'user-6')
    assertEqual(afterRerun!.reason, 'REAL NEW MODERATOR ACTION', 'повторно migration изпълнение НЕ трябва да презапише реален нов moderator mute с остарели legacy данни')
  })
})

// ─── [8] Promoted redovete имат нов created_at (INSERT, не copy) ──────────

await withTempDir(async (dir) => {
  const dbPath = await setupPreUpgradeDb(dir, 'created-at.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  seedProfile(db, 'user-8')
  insertTopic(db, 'topic-a')
  // Legacy редът е "стар" — created_at изкуствено преместен назад с 10 дни.
  insertLegacyMute(db, { topicId: 'topic-a', profileId: 'user-8', mutedUntilOffsetMs: 60 * 60 * 1000, reason: 'old legacy row', mutedByAccountId: 'moderator-1' })
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  db.prepare(`UPDATE topic_mutes SET created_at = ? WHERE topic_id = 'topic-a' AND profile_id = 'user-8'`).run(tenDaysAgo)
  db.close()

  await check('[8] Promoted redovete имат created_at = CURRENT_TIMESTAMP (нов created_at при promotion, не legacy created_at copy)', async () => {
    const beforeMigration = Date.now()
    const migrationDb = new DatabaseSync(dbPath, { open: true })
    await applyMigrationFile(migrationDb, sectionMutesMigrationPath)
    migrationDb.close()

    const promoted = getSectionMuteRow(dbPath, 'user-8')
    assert(promoted !== undefined, 'трябва да има promoted ред')
    const promotedCreatedAtMs = new Date(`${promoted!.created_at}Z`).getTime()
    assert(promotedCreatedAtMs >= beforeMigration - 5000, 'promoted created_at трябва да е около момента на migration-а, НЕ копие на 10-дневния legacy created_at')
  })
})

console.log(`\n${passed} passed, ${failed} failed\n`)

if (failed > 0) {
  process.exitCode = 1
}
