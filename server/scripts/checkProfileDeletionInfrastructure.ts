/**
 * checkProfileDeletionInfrastructure.ts
 *
 * Самоизтриване на профили — Етап 1. Детерминирани проверки на неактивната
 * инфраструктура от 20261024_001_create_profile_deletion_infrastructure.sql
 * (profile_deletion_requests / profile_deletion_events /
 * profile_deletion_file_queue) и на чистите helper-и в
 * src/db/profileDeletionSchedule.ts.
 *
 * Всичко се изпълнява върху ИЗОЛИРАНИ temp бази, подготвени през РЕАЛНИЯ
 * ensureServerDatabaseReady() runner — никога локалната/продукционната база.
 * Не се изтриват профили или файлове: файловата опашка се проверява само
 * като структура/статуси, без файлова система.
 *
 * [A] Миграционна съвместимост (чиста база, upgrade на съществуваща база,
 *     идемпотентен повторен старт, profiles/accounts непроменени,
 *     integrity_check, foreign_key_check).
 * [B] 45-дневен срок, граници, UTC (чисти функции).
 * [C] Създаване на заявка и тригер за идентичност/начален статус/прозорец.
 * [D] Уникалност на активната заявка.
 * [E] Статусни преходи (пълна матрица DB ↔ TS) и времеви граници в базата.
 * [F] Неизменимост на идентичността и срока.
 * [G] Журнал на събитията (append-only).
 * [H] Предпазване от двойна обработка (две връзки = два процеса, lease).
 * [I] Файлова опашка — структура, статуси, повторни опити, guard-ове.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import {
  PROFILE_DELETION_ACTIVE_REQUEST_STATUSES,
  PROFILE_DELETION_FILE_STATUSES,
  PROFILE_DELETION_GRACE_PERIOD_MS,
  PROFILE_DELETION_REQUEST_STATUSES,
  PROFILE_DELETION_RETRY_MAX_DELAY_MS,
  computeProfileDeletionRetryDelayMs,
  computeProfileDeletionSchedule,
  getProfileDeletionRemainingMs,
  isAllowedProfileDeletionFileTransition,
  isAllowedProfileDeletionTransition,
  isCanonicalUtcIsoTimestamp,
  isProfileDeletionCancellable,
  isProfileDeletionDue,
  type ProfileDeletionFileStatus,
  type ProfileDeletionRequestStatus,
} from '../src/db/profileDeletionSchedule.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

const NEW_MIGRATION = '20261024_001_create_profile_deletion_infrastructure.sql'
const NEW_TABLES = ['profile_deletion_requests', 'profile_deletion_events', 'profile_deletion_file_queue'] as const
const DAY_MS = 24 * 60 * 60 * 1000

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}

/** Очаква грешка, чийто текст съдържа expectedFragment (напр. RAISE кода от тригера). */
function assertRejects(fn: () => unknown, expectedFragment: string, message: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!text.includes(expectedFragment)) {
      throw new Error(`${message}: очаквана грешка "${expectedFragment}", получена "${text}"`)
    }
    return
  }
  throw new Error(`${message}: операцията не беше отхвърлена`)
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckProfileDeletionInfrastructure')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

const tempRoots: string[] = []

async function createTempServerRoot(migrationFileNames: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-infra-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const filename of migrationFileNames) {
    await copyMigration(root, filename)
  }
  return root
}

async function copyMigration(root: string, filename: string): Promise<void> {
  await cp(join(sourceMigrationsDirectoryPath, filename), join(root, 'database', 'migrations', filename))
}

async function openDatabase(databaseFilePath: string): Promise<SqliteDatabase> {
  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA busy_timeout = 5000;')
  return database
}

function dbNow(database: SqliteDatabase): string {
  return (database.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
}

function isoPlus(iso: string, deltaMs: number): string {
  return new Date(Date.parse(iso) + deltaMs).toISOString()
}

type HumanProfile = { profileId: string; accountId: string; createdAt: string }

function insertHumanProfile(database: SqliteDatabase, overrides: { kind?: 'human' | 'bot'; isTemporary?: 0 | 1 } = {}): HumanProfile {
  const accountId = randomUUID()
  const profileId = randomUUID()
  const tag = profileId.slice(0, 8)
  database.prepare(`
    INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, 'test-hash');
  `).run(accountId, `deletion-${tag}@example.test`)
  database.prepare(`
    INSERT INTO profiles (profile_id, account_id, profile_kind, username, normalized_username, display_name, normalized_display_name, is_temporary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
  `).run(profileId, accountId, overrides.kind ?? 'human', `user-${tag}`, `user-${tag}`, `User ${tag}`, `user ${tag}`, overrides.isTemporary ?? 0)
  const createdAt = (database.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(profileId) as { created_at: string }).created_at
  return { profileId, accountId, createdAt }
}

function insertRequest(database: SqliteDatabase, profile: HumanProfile, requestedAtIso?: string): string {
  const requestId = randomUUID()
  const schedule = computeProfileDeletionSchedule(new Date(requestedAtIso ?? dbNow(database)))
  database.prepare(`
    INSERT INTO profile_deletion_requests (
      request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for
    ) VALUES (?, ?, ?, ?, ?, ?);
  `).run(requestId, profile.profileId, profile.accountId, profile.createdAt, schedule.requestedAt, schedule.scheduledFor)
  return requestId
}

/**
 * Fixture backdating: insert-guard тригерът (правилно) отказва requested_at
 * извън ±5 мин от часовника на базата, затова "вече изтекла" заявка не може
 * да бъде създадена нормално. Само за fixture-ите тук тригерът се сваля за
 * един INSERT и веднага се пресъздава от СЪЩИЯ SQL текст в sqlite_master —
 * всички следващи проверки работят срещу непроменения production тригер.
 */
function insertBackdatedRequest(database: SqliteDatabase, profile: HumanProfile, requestedAtIso: string): string {
  const triggerName = 'trg_profile_deletion_requests_insert_guard'
  const triggerSql = (database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?;`).get(triggerName) as { sql: string }).sql
  database.exec(`DROP TRIGGER ${triggerName};`)
  try {
    return insertRequest(database, profile, requestedAtIso)
  } finally {
    database.exec(triggerSql)
  }
}

function getRequest(database: SqliteDatabase, requestId: string): Record<string, unknown> {
  return database.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
}

function insertDueRequest(database: SqliteDatabase): { requestId: string; profile: HumanProfile } {
  const profile = insertHumanProfile(database)
  const requestId = insertBackdatedRequest(database, profile, isoPlus(dbNow(database), -46 * DAY_MS))
  return { requestId, profile }
}

const LEASE_MS = 10 * 60 * 1000

function claim(database: SqliteDatabase, requestId: string, workerId: string): number {
  const now = dbNow(database)
  const result = database.prepare(`
    UPDATE profile_deletion_requests
    SET status = 'executing', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE request_id = ?
      AND status = 'pending'
      AND scheduled_for <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `).run(workerId, isoPlus(now, LEASE_MS), requestId) as { changes: number }
  return Number(result.changes)
}

function insertExecutingRequest(database: SqliteDatabase, workerId = 'worker-a'): { requestId: string; profile: HumanProfile } {
  const fixture = insertDueRequest(database)
  assertEqual(claim(database, fixture.requestId, workerId), 1, 'fixture claim')
  return fixture
}

/** UPDATE, който задава статус + всички колони, които CHECK-овете изискват за целевия статус. */
function setRequestStatus(database: SqliteDatabase, requestId: string, to: ProfileDeletionRequestStatus): void {
  const now = dbNow(database)
  database.prepare(`
    UPDATE profile_deletion_requests
    SET status = ?,
        lease_owner = ?, lease_expires_at = ?,
        cancelled_at = ?, completed_at = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE request_id = ?;
  `).run(
    to,
    to === 'executing' ? 'worker-matrix' : null,
    to === 'executing' ? isoPlus(now, LEASE_MS) : null,
    to === 'cancelled' ? now : null,
    to === 'completed' ? now : null,
    requestId,
  )
}

/**
 * Строи заявка в статус `from` по ЛЕГАЛЕН път (insert винаги е pending).
 * pending: notDue=true дава свежа заявка (може да се отмени), иначе изтекла.
 */
function buildRequestInStatus(database: SqliteDatabase, from: ProfileDeletionRequestStatus, notDue: boolean): string {
  if (from === 'pending') {
    return notDue ? insertRequest(database, insertHumanProfile(database)) : insertDueRequest(database).requestId
  }
  if (from === 'cancelled') {
    const requestId = insertRequest(database, insertHumanProfile(database))
    setRequestStatus(database, requestId, 'cancelled')
    return requestId
  }
  const { requestId } = insertExecutingRequest(database)
  if (from !== 'executing') setRequestStatus(database, requestId, from)
  return requestId
}

function insertEvent(database: SqliteDatabase, requestId: string, profileId: string, eventType: string, detail: string | null = null): void {
  database.prepare(`
    INSERT INTO profile_deletion_events (request_id, profile_id, event_type, actor_kind, worker_id, detail_json)
    VALUES (?, ?, ?, 'system', 'worker-a', ?);
  `).run(requestId, profileId, eventType, detail)
}

function enqueueFile(database: SqliteDatabase, requestId: string, storageRef: string, fileKind = 'avatar', orIgnore = false): number {
  const result = database.prepare(`
    INSERT ${orIgnore ? 'OR IGNORE' : ''} INTO profile_deletion_file_queue (request_id, file_kind, storage_ref)
    VALUES (?, ?, ?);
  `).run(requestId, fileKind, storageRef) as { changes: number; lastInsertRowid: number | bigint }
  return Number(result.changes) === 0 ? 0 : Number(result.lastInsertRowid)
}

function setFileStatus(database: SqliteDatabase, queueId: number, to: ProfileDeletionFileStatus): void {
  const now = dbNow(database)
  database.prepare(`
    UPDATE profile_deletion_file_queue
    SET status = ?, lease_owner = ?, lease_expires_at = ?, completed_at = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE queue_id = ?;
  `).run(
    to,
    to === 'processing' ? 'file-worker' : null,
    to === 'processing' ? isoPlus(now, LEASE_MS) : null,
    to === 'done' || to === 'skipped_shared' ? now : null,
    queueId,
  )
}

function buildFileInStatus(database: SqliteDatabase, from: ProfileDeletionFileStatus): number {
  const { requestId } = insertExecutingRequest(database)
  const queueId = enqueueFile(database, requestId, `/uploads/avatars/${randomUUID()}.webp`)
  if (from === 'pending') return queueId
  setFileStatus(database, queueId, 'processing')
  if (from !== 'processing') setFileStatus(database, queueId, from)
  return queueId
}

function assertDatabaseHealthy(database: SqliteDatabase): void {
  const integrity = (database.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
  assertEqual(integrity, 'ok', 'integrity_check')
  const violations = database.prepare('PRAGMA foreign_key_check;').all()
  assertEqual(violations.length, 0, 'foreign_key_check нарушения')
}

function tableSql(database: SqliteDatabase, name: string): string | null {
  return (database.prepare(`SELECT sql FROM sqlite_master WHERE name = ?;`).get(name) as { sql: string } | undefined)?.sql ?? null
}

function schemaObjectsFor(database: SqliteDatabase, tableName: string): string[] {
  return (database.prepare(`SELECT type || ':' || name AS id FROM sqlite_master WHERE tbl_name = ? ORDER BY id;`).all(tableName) as Array<{ id: string }>).map((row) => row.id)
}

const allMigrations = await loadRealMigrationFileNames()

try {
  // ═══ [A] Миграционна съвместимост ═══════════════════════════════════════
  console.log('\n[A] Миграционна съвместимост')

  // Етап 3 добави допълващата 20261025_001 СЛЕД тази миграция — затова
  // проверката е "всички по-ранни миграции се сортират преди нея", а не
  // "тя е последна".
  const newMigrationIndex = allMigrations.indexOf(NEW_MIGRATION)
  await check('[A1] Миграцията се изпълнява след всички по-стари миграции (сортиране localeCompare en)', () => {
    assert(newMigrationIndex > 0, `${NEW_MIGRATION} липсва в database/migrations`)
    assert(allMigrations.slice(0, newMigrationIndex).every((name) => name.localeCompare(NEW_MIGRATION, 'en') < 0), 'по-стара миграция след новата')
    assert(allMigrations.slice(newMigrationIndex + 1).every((name) => name.localeCompare('20261024_999', 'en') > 0), 'миграция със същата дата след новата')
  })

  // Upgrade път: база с ВСИЧКИ по-ранни миграции + реални данни, после новата
  // (по-късните допълващи миграции зависят от нея и не участват тук).
  const previousMigrations = allMigrations.slice(0, newMigrationIndex)
  const upgradeRoot = await createTempServerRoot(previousMigrations)
  const firstRun = await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
  const upgradeDb = await openDatabase(firstRun.databaseFilePath)
  const seededProfiles = [insertHumanProfile(upgradeDb), insertHumanProfile(upgradeDb), insertHumanProfile(upgradeDb)]
  const profilesSqlBefore = tableSql(upgradeDb, 'profiles')
  const accountsSqlBefore = tableSql(upgradeDb, 'accounts')
  const profilesObjectsBefore = schemaObjectsFor(upgradeDb, 'profiles')
  const accountsObjectsBefore = schemaObjectsFor(upgradeDb, 'accounts')
  const dataFingerprintBefore = JSON.stringify(upgradeDb.prepare('SELECT * FROM profiles ORDER BY profile_id;').all())
    + JSON.stringify(upgradeDb.prepare('SELECT * FROM accounts ORDER BY account_id;').all())
  upgradeDb.close()

  await copyMigration(upgradeRoot, NEW_MIGRATION)
  const upgradeRun = await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
  const upgraded = await openDatabase(upgradeRun.databaseFilePath)

  await check('[A2] Upgrade на съществуваща база прилага точно 1 нова миграция и я записва в server_migrations', () => {
    assertEqual(upgradeRun.appliedCount, 1, 'appliedCount')
    assert(upgradeRun.appliedMigrations.some((m) => m.filename === NEW_MIGRATION), 'новата миграция не е в ledger-а')
  })

  await check('[A3] Трите нови таблици съществуват и са празни след upgrade', () => {
    for (const table of NEW_TABLES) {
      const count = (upgraded.prepare(`SELECT COUNT(*) AS cnt FROM ${table};`).get() as { cnt: number }).cnt
      assertEqual(count, 0, `${table} брой редове`)
    }
  })

  await check('[A4] profiles и accounts: схемата, индексите, тригерите и данните са непроменени', () => {
    assertEqual(tableSql(upgraded, 'profiles'), profilesSqlBefore, 'profiles CREATE TABLE')
    assertEqual(tableSql(upgraded, 'accounts'), accountsSqlBefore, 'accounts CREATE TABLE')
    assertEqual(JSON.stringify(schemaObjectsFor(upgraded, 'profiles')), JSON.stringify(profilesObjectsBefore), 'profiles индекси/тригери')
    assertEqual(JSON.stringify(schemaObjectsFor(upgraded, 'accounts')), JSON.stringify(accountsObjectsBefore), 'accounts индекси/тригери')
    const dataFingerprintAfter = JSON.stringify(upgraded.prepare('SELECT * FROM profiles ORDER BY profile_id;').all())
      + JSON.stringify(upgraded.prepare('SELECT * FROM accounts ORDER BY account_id;').all())
    assertEqual(dataFingerprintAfter, dataFingerprintBefore, 'данни в profiles/accounts')
  })

  await check('[A5] Новите тригери са закачени само за новите таблици', () => {
    const triggers = upgraded.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_profile_deletion_%';`).all() as Array<{ name: string; tbl_name: string }>
    assert(triggers.length === 11, `очаквани 11 тригера, намерени ${triggers.length}`)
    for (const trigger of triggers) {
      assert((NEW_TABLES as readonly string[]).includes(trigger.tbl_name), `${trigger.name} е закачен за ${trigger.tbl_name}`)
    }
  })

  await check('[A6] Нито една нова таблица няма FOREIGN KEY към profiles/accounts (tombstone оцелява изтриването)', () => {
    for (const table of NEW_TABLES) {
      const fks = upgraded.prepare(`PRAGMA foreign_key_list(${table});`).all() as Array<{ table: string }>
      for (const fk of fks) {
        assert(fk.table === 'profile_deletion_requests', `${table} има FK към ${fk.table}`)
      }
    }
  })

  await check('[A7] integrity_check=ok и foreign_key_check празен след upgrade', () => {
    assertDatabaseHealthy(upgraded)
  })

  await check('[A8] Повторен старт на runner-а е идемпотентен (0 приложени миграции)', async () => {
    const rerun = await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    assertEqual(rerun.appliedCount, 0, 'appliedCount при повторен старт')
  })

  await check('[A9] Чиста база: целият реален набор миграции се прилага без грешка', async () => {
    const freshRoot = await createTempServerRoot(allMigrations)
    const freshRun = await ensureServerDatabaseReady({ serverRootOverride: freshRoot })
    assertEqual(freshRun.appliedCount, allMigrations.length, 'appliedCount на чиста база')
    const fresh = await openDatabase(freshRun.databaseFilePath)
    try {
      assertDatabaseHealthy(fresh)
    } finally {
      fresh.close()
    }
  })
  upgraded.close()

  // Обща работна база за останалите групи.
  const workRoot = await createTempServerRoot(allMigrations)
  const workRun = await ensureServerDatabaseReady({ serverRootOverride: workRoot })
  const db = await openDatabase(workRun.databaseFilePath)

  // ═══ [B] Срок, граници, UTC (чисти функции) ═════════════════════════════
  console.log('\n[B] 45-дневен срок, граници, UTC')

  await check('[B1] 45 дни = точно 3 888 000 000 ms', () => {
    assertEqual(PROFILE_DELETION_GRACE_PERIOD_MS, 3_888_000_000, 'PROFILE_DELETION_GRACE_PERIOD_MS')
  })

  await check('[B2] computeProfileDeletionSchedule: точни очаквани дати (обикновен, високосен, нов година)', () => {
    const cases: Array<[string, string]> = [
      ['2026-10-21T12:34:56.789Z', '2026-12-05T12:34:56.789Z'],
      ['2028-02-01T00:00:00.000Z', '2028-03-17T00:00:00.000Z'], // високосна 2028
      ['2027-02-01T00:00:00.000Z', '2027-03-18T00:00:00.000Z'], // невисокосна 2027
      ['2026-12-20T23:59:59.999Z', '2027-02-03T23:59:59.999Z'], // през нова година
    ]
    for (const [requestedAt, expected] of cases) {
      const schedule = computeProfileDeletionSchedule(new Date(requestedAt))
      assertEqual(schedule.requestedAt, requestedAt, 'requestedAt')
      assertEqual(schedule.scheduledFor, expected, `scheduledFor за ${requestedAt}`)
    }
  })

  await check('[B3] Смяна на часовото време (Европа/София, 25.10.2026): 45 × 24 ч в UTC, локалният час се измества с 1 ч', () => {
    const schedule = computeProfileDeletionSchedule(new Date('2026-10-01T10:00:00.000Z'))
    assertEqual(schedule.scheduledFor, '2026-11-15T10:00:00.000Z', 'scheduledFor')
    const sofiaHour = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
    assertEqual(sofiaHour(schedule.requestedAt), '13', 'локален час на подаване (EEST)')
    assertEqual(sofiaHour(schedule.scheduledFor), '12', 'локален час на изтичане (EET)')
  })

  await check('[B4] Граница с точност до милисекунда: due/cancellable са точно допълващи се', () => {
    const scheduledFor = '2026-12-05T10:00:00.000Z'
    const before = new Date('2026-12-05T09:59:59.999Z')
    const exact = new Date('2026-12-05T10:00:00.000Z')
    const after = new Date('2026-12-05T10:00:00.001Z')
    assert(!isProfileDeletionDue(scheduledFor, before) && isProfileDeletionCancellable(scheduledFor, before), '1 ms преди: може да се отмени, не е изтекла')
    assert(isProfileDeletionDue(scheduledFor, exact) && !isProfileDeletionCancellable(scheduledFor, exact), 'точно в момента: изтекла, не може да се отмени')
    assert(isProfileDeletionDue(scheduledFor, after) && !isProfileDeletionCancellable(scheduledFor, after), '1 ms след: изтекла')
    assertEqual(getProfileDeletionRemainingMs(scheduledFor, before), 1, 'оставащо 1 ms преди')
    assertEqual(getProfileDeletionRemainingMs(scheduledFor, after), 0, 'оставащо след срока')
  })

  await check('[B5] Часовата зона на процеса (TZ) не влияе на изчислението', () => {
    const originalTz = process.env.TZ
    const results = new Set<string>()
    try {
      for (const tz of ['UTC', 'Europe/Sofia', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
        process.env.TZ = tz
        const schedule = computeProfileDeletionSchedule(new Date(Date.UTC(2026, 9, 21, 21, 30, 0, 0)))
        results.add(`${schedule.requestedAt}|${schedule.scheduledFor}`)
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    }
    assertEqual(results.size, 1, 'различни резултати при различни TZ')
    assertEqual([...results][0], '2026-10-21T21:30:00.000Z|2026-12-05T21:30:00.000Z', 'резултат')
  })

  await check('[B6] isCanonicalUtcIsoTimestamp приема само каноничен UTC формат', () => {
    assert(isCanonicalUtcIsoTimestamp('2026-10-21T12:00:00.000Z'), 'каноничен')
    for (const bad of ['2026-10-21 12:00:00', '2026-10-21T12:00:00Z', '2026-10-21T12:00:00.000+02:00', '2026-13-01T00:00:00.000Z', '2026-02-30T00:00:00.000Z', '']) {
      assert(!isCanonicalUtcIsoTimestamp(bad), `"${bad}" не трябва да е каноничен`)
    }
  })

  await check('[B7] Часовникът на SQLite е UTC и в същия формат като toISOString()', () => {
    const now = dbNow(db)
    assert(isCanonicalUtcIsoTimestamp(now), `strftime now не е каноничен: ${now}`)
    assert(Math.abs(Date.parse(now) - Date.now()) < 5000, 'часовникът на базата се разминава с JS > 5 s')
  })

  await check('[B8] Експоненциално изчакване при повторен опит: 5, 10, 20 мин ... таван 6 ч; невалиден вход се отхвърля', () => {
    assertEqual(computeProfileDeletionRetryDelayMs(1), 5 * 60 * 1000, 'опит 1')
    assertEqual(computeProfileDeletionRetryDelayMs(2), 10 * 60 * 1000, 'опит 2')
    assertEqual(computeProfileDeletionRetryDelayMs(3), 20 * 60 * 1000, 'опит 3')
    assertEqual(computeProfileDeletionRetryDelayMs(8), PROFILE_DELETION_RETRY_MAX_DELAY_MS, 'опит 8 (таван)')
    assertEqual(computeProfileDeletionRetryDelayMs(1000), PROFILE_DELETION_RETRY_MAX_DELAY_MS, 'опит 1000 (таван)')
    assertRejects(() => computeProfileDeletionRetryDelayMs(0), 'Невалиден', 'опит 0')
  })

  // ═══ [C] Създаване на заявка ════════════════════════════════════════════
  console.log('\n[C] Създаване на заявка')

  await check('[C1] Валидна заявка: pending, 0 опита, без lease, scheduled_for = requested_at + 45 дни', () => {
    const profile = insertHumanProfile(db)
    const requestId = insertRequest(db, profile)
    const row = getRequest(db, requestId)
    assertEqual(row.status, 'pending', 'status')
    assertEqual(row.attempt_count, 0, 'attempt_count')
    assertEqual(row.lease_owner, null, 'lease_owner')
    assertEqual(Date.parse(String(row.scheduled_for)) - Date.parse(String(row.requested_at)), PROFILE_DELETION_GRACE_PERIOD_MS, 'разлика')
    assertEqual(row.account_id_snapshot, profile.accountId, 'account snapshot')
    assertEqual(row.profile_created_at_snapshot, profile.createdAt, 'created_at snapshot')
    assert(isCanonicalUtcIsoTimestamp(String(row.created_at)) && isCanonicalUtcIsoTimestamp(String(row.updated_at)), 'created_at/updated_at DEFAULT в UTC ISO')
  })

  await check('[C2] Срок, различен от точно 45 дни (±1 ms, 44 дни), се отхвърля от CHECK', () => {
    const profile = insertHumanProfile(db)
    const requestedAt = dbNow(db)
    for (const scheduledFor of [isoPlus(requestedAt, PROFILE_DELETION_GRACE_PERIOD_MS + 1), isoPlus(requestedAt, PROFILE_DELETION_GRACE_PERIOD_MS - 1), isoPlus(requestedAt, 44 * DAY_MS)]) {
      assertRejects(() => db.prepare(`
        INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for)
        VALUES (?, ?, ?, ?, ?, ?);
      `).run(randomUUID(), profile.profileId, profile.accountId, profile.createdAt, requestedAt, scheduledFor), 'CHECK constraint failed', `scheduled_for=${scheduledFor}`)
    }
  })

  await check('[C3] Неканоничен формат на времето се отхвърля от CHECK', () => {
    const profile = insertHumanProfile(db)
    const triggerName = 'trg_profile_deletion_requests_insert_guard'
    const triggerSql = tableSql(db, triggerName) as string
    db.exec(`DROP TRIGGER ${triggerName};`)
    try {
      for (const requestedAt of ['2026-10-21 12:00:00', '2026-10-21T12:00:00Z', '2026-10-21T12:00:00.000+02:00']) {
        assertRejects(() => db.prepare(`
          INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for)
          VALUES (?, ?, ?, ?, ?, '2026-12-05T12:00:00.000Z');
        `).run(randomUUID(), profile.profileId, profile.accountId, profile.createdAt, requestedAt), 'CHECK constraint failed', `requested_at=${requestedAt}`)
      }
    } finally {
      db.exec(triggerSql)
    }
  })

  await check('[C4] Заявка не може да започне в друг статус освен pending (или с опити/lease)', () => {
    const profile = insertHumanProfile(db)
    const schedule = computeProfileDeletionSchedule(new Date(dbNow(db)))
    for (const [column, value] of [['status', "'cancelled'"], ['status', "'executing'"], ['attempt_count', '1']] as const) {
      assertRejects(() => db.prepare(`
        INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, ${column})
        VALUES (?, ?, ?, ?, ?, ?, ${value});
      `).run(randomUUID(), profile.profileId, profile.accountId, profile.createdAt, schedule.requestedAt, schedule.scheduledFor), 'profile_deletion_request_must_start_pending', `${column}=${value}`)
    }
  })

  await check('[C5] requested_at не може да бъде датирана назад/напред с повече от 5 мин (срокът не се съкращава)', () => {
    const profile = insertHumanProfile(db)
    const now = dbNow(db)
    for (const offset of [-10 * 60 * 1000, 10 * 60 * 1000, -46 * DAY_MS]) {
      assertRejects(() => insertRequest(db, profile, isoPlus(now, offset)), 'profile_deletion_requested_at_out_of_window', `offset=${offset}`)
    }
    // ±1 мин е в прозореца (разминаване между процеси).
    insertRequest(db, profile, isoPlus(now, -60 * 1000))
  })

  await check('[C6] Идентичност: несъществуващ профил, чужд акаунт, грешен created_at, бот и временен профил се отхвърлят', () => {
    const real = insertHumanProfile(db)
    const other = insertHumanProfile(db)
    const bot = insertHumanProfile(db, { kind: 'bot' })
    const temporary = insertHumanProfile(db, { isTemporary: 1 })
    const cases: Array<[string, HumanProfile]> = [
      ['несъществуващ профил', { ...real, profileId: randomUUID() }],
      ['чужд акаунт', { ...real, accountId: other.accountId }],
      ['грешен created_at', { ...real, createdAt: '2000-01-01 00:00:00' }],
      ['бот профил', bot],
      ['временен профил', temporary],
    ]
    for (const [label, profile] of cases) {
      assertRejects(() => insertRequest(db, profile), 'profile_deletion_identity_mismatch', label)
    }
  })

  // ═══ [D] Уникалност на активната заявка ═════════════════════════════════
  console.log('\n[D] Уникалност на активната заявка')

  await check('[D1] Втора pending заявка за същия профил се отхвърля', () => {
    const profile = insertHumanProfile(db)
    insertRequest(db, profile)
    assertRejects(() => insertRequest(db, profile), 'UNIQUE constraint failed', 'втора pending')
  })

  await check('[D2] След отмяна може да се подаде нова заявка; старата остава в историята', () => {
    const profile = insertHumanProfile(db)
    const first = insertRequest(db, profile)
    setRequestStatus(db, first, 'cancelled')
    const second = insertRequest(db, profile)
    const rows = db.prepare('SELECT status FROM profile_deletion_requests WHERE profile_id = ? ORDER BY requested_at, request_id;').all(profile.profileId) as Array<{ status: string }>
    assertEqual(rows.length, 2, 'брой заявки в историята')
    assertEqual(getRequest(db, second).status, 'pending', 'нова заявка')
  })

  await check('[D3] executing/blocked/failed заявка също блокира нова заявка за профила', () => {
    for (const status of ['executing', 'blocked', 'failed'] as const) {
      const requestId = buildRequestInStatus(db, status, false)
      const row = getRequest(db, requestId)
      const profile: HumanProfile = { profileId: String(row.profile_id), accountId: String(row.account_id_snapshot), createdAt: String(row.profile_created_at_snapshot) }
      assertRejects(() => insertRequest(db, profile), 'UNIQUE constraint failed', `нова заявка при ${status}`)
    }
  })

  await check('[D4] Активните статуси в TS съвпадат с WHERE клаузата на partial unique индекса', () => {
    const indexSql = tableSql(db, 'idx_profile_deletion_requests_active_profile') as string
    for (const status of PROFILE_DELETION_REQUEST_STATUSES) {
      const inIndex = indexSql.includes(`'${status}'`)
      assertEqual(inIndex, PROFILE_DELETION_ACTIVE_REQUEST_STATUSES.includes(status), `статус ${status}`)
    }
  })

  // ═══ [E] Статусни преходи ═══════════════════════════════════════════════
  console.log('\n[E] Статусни преходи')

  await check('[E1] Пълна матрица 6×6: базата позволява точно преходите от ALLOWED_TRANSITIONS', () => {
    const mismatches: string[] = []
    for (const from of PROFILE_DELETION_REQUEST_STATUSES) {
      for (const to of PROFILE_DELETION_REQUEST_STATUSES) {
        if (from === to) continue
        const requestId = buildRequestInStatus(db, from, from === 'pending' && to === 'cancelled')
        const expectedAllowed = isAllowedProfileDeletionTransition(from, to)
        let actualAllowed = true
        let errorText = ''
        try {
          setRequestStatus(db, requestId, to)
        } catch (error) {
          actualAllowed = false
          errorText = error instanceof Error ? error.message : String(error)
        }
        if (actualAllowed !== expectedAllowed) {
          mismatches.push(`${from}->${to}: очаквано ${expectedAllowed}, база ${actualAllowed} ${errorText}`)
        } else if (!actualAllowed && !errorText.includes('profile_deletion_invalid_status_transition')) {
          mismatches.push(`${from}->${to}: отхвърлен с неочаквана грешка ${errorText}`)
        }
      }
    }
    assert(mismatches.length === 0, mismatches.join(' | '))
  })

  await check('[E2] cancelled и completed са терминални (няма изход към никой статус)', () => {
    for (const terminal of ['cancelled', 'completed'] as const) {
      for (const to of PROFILE_DELETION_REQUEST_STATUSES) {
        if (to !== terminal) assert(!isAllowedProfileDeletionTransition(terminal, to), `${terminal}->${to} е позволен`)
      }
    }
  })

  await check('[E3] Изпълнение преди срока се отхвърля от базата (profile_deletion_not_due)', () => {
    const requestId = insertRequest(db, insertHumanProfile(db))
    assertRejects(() => setRequestStatus(db, requestId, 'executing'), 'profile_deletion_not_due', 'pending (свежа) -> executing')
    assertEqual(claim(db, requestId, 'worker-a'), 0, 'claim заявка преди срока')
  })

  await check('[E4] Отмяна след изтичане на срока се отхвърля от базата (profile_deletion_cancel_window_closed)', () => {
    const { requestId } = insertDueRequest(db)
    assertRejects(() => setRequestStatus(db, requestId, 'cancelled'), 'profile_deletion_cancel_window_closed', 'pending (изтекла) -> cancelled')
  })

  await check('[E5] Точна граница в базата: при scheduled_for = now отмяната е затворена, изпълнението е позволено', () => {
    const profile = insertHumanProfile(db)
    const boundary = dbNow(db)
    const requestId = insertBackdatedRequest(db, profile, isoPlus(boundary, -PROFILE_DELETION_GRACE_PERIOD_MS))
    assertEqual(getRequest(db, requestId).scheduled_for, boundary, 'scheduled_for = момента на границата')
    assertRejects(() => setRequestStatus(db, requestId, 'cancelled'), 'profile_deletion_cancel_window_closed', 'отмяна на границата')
    assertEqual(claim(db, requestId, 'worker-a'), 1, 'claim на границата')
  })

  await check('[E6] 30 s преди срока: отмяната е позволена, изпълнението — не', () => {
    const profile = insertHumanProfile(db)
    const requestId = insertBackdatedRequest(db, profile, isoPlus(dbNow(db), -PROFILE_DELETION_GRACE_PERIOD_MS + 30_000))
    assertEqual(claim(db, requestId, 'worker-a'), 0, 'claim 30 s преди срока')
    setRequestStatus(db, requestId, 'cancelled')
    assertEqual(getRequest(db, requestId).status, 'cancelled', 'status след отмяна')
  })

  await check('[E7] CHECK инварианти: lease само при executing, cancelled_at/completed_at само в съответния статус', () => {
    const requestId = insertRequest(db, insertHumanProfile(db))
    assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET lease_owner = 'w', lease_expires_at = ? WHERE request_id = ?;`).run(isoPlus(dbNow(db), LEASE_MS), requestId), 'CHECK constraint failed', 'lease при pending')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET completed_at = ? WHERE request_id = ?;`).run(dbNow(db), requestId), 'CHECK constraint failed', 'completed_at при pending')
    const executing = insertExecutingRequest(db).requestId
    assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET status = 'completed' WHERE request_id = ?;`).run(executing), 'CHECK constraint failed', 'completed без completed_at и с lease')
  })

  // ═══ [F] Неизменимост ═══════════════════════════════════════════════════
  console.log('\n[F] Неизменимост на идентичността и срока')

  await check('[F1] profile_id, account/created_at snapshot, requested_at и scheduled_for не могат да се променят', () => {
    const requestId = insertRequest(db, insertHumanProfile(db))
    const row = getRequest(db, requestId)
    const shifted = computeProfileDeletionSchedule(new Date(Date.parse(String(row.requested_at)) - DAY_MS))
    const updates: Array<[string, unknown[]]> = [
      ['profile_id = ?', [randomUUID()]],
      ['account_id_snapshot = ?', [randomUUID()]],
      ['profile_created_at_snapshot = ?', ['2000-01-01 00:00:00']],
      // Валиден 45-дневен чифт, изместен с 1 ден назад — все пак трябва да се откаже.
      ['requested_at = ?, scheduled_for = ?', [shifted.requestedAt, shifted.scheduledFor]],
    ]
    for (const [setClause, params] of updates) {
      assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET ${setClause} WHERE request_id = ?;`).run(...(params as string[]), requestId), 'profile_deletion_request_identity_immutable', setClause)
    }
    assertEqual(getRequest(db, requestId).scheduled_for, row.scheduled_for, 'scheduled_for непроменен')
  })

  // ═══ [G] Журнал на събитията ════════════════════════════════════════════
  console.log('\n[G] Журнал на събитията')

  await check('[G1] Събитията се записват подредени по event_seq с валиден detail_json и UTC време', () => {
    const { requestId, profile } = insertExecutingRequest(db)
    insertEvent(db, requestId, profile.profileId, 'requested')
    insertEvent(db, requestId, profile.profileId, 'claimed', JSON.stringify({ attempt: 1 }))
    insertEvent(db, requestId, profile.profileId, 'retry_scheduled', JSON.stringify({ code: 'sqlite_busy' }))
    const rows = db.prepare('SELECT event_seq, event_type, created_at FROM profile_deletion_events WHERE request_id = ? ORDER BY event_seq;').all(requestId) as Array<{ event_seq: number; event_type: string; created_at: string }>
    assertEqual(rows.map((row) => row.event_type).join(','), 'requested,claimed,retry_scheduled', 'ред на събитията')
    assert(rows[0].event_seq < rows[1].event_seq && rows[1].event_seq < rows[2].event_seq, 'event_seq не е строго нарастващ')
    assert(rows.every((row) => isCanonicalUtcIsoTimestamp(row.created_at)), 'created_at не е UTC ISO')
  })

  await check('[G2] Невалиден тип, невалиден JSON, несъвпадащ profile_id и несъществуваща заявка се отхвърлят', () => {
    const { requestId, profile } = insertExecutingRequest(db)
    assertRejects(() => insertEvent(db, requestId, profile.profileId, 'hacked'), 'CHECK constraint failed', 'event_type')
    assertRejects(() => insertEvent(db, requestId, profile.profileId, 'claimed', '{not json'), 'CHECK constraint failed', 'detail_json')
    assertRejects(() => insertEvent(db, requestId, randomUUID(), 'claimed'), 'profile_deletion_event_profile_mismatch', 'profile_id')
    assertRejects(() => insertEvent(db, randomUUID(), profile.profileId, 'claimed'), 'profile_deletion_event_profile_mismatch', 'несъществуваща заявка')
  })

  await check('[G3] Журналът е append-only: UPDATE и DELETE се отхвърлят', () => {
    const { requestId, profile } = insertExecutingRequest(db)
    insertEvent(db, requestId, profile.profileId, 'claimed')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_events SET event_type = 'completed' WHERE request_id = ?;`).run(requestId), 'profile_deletion_events_append_only', 'UPDATE')
    assertRejects(() => db.prepare('DELETE FROM profile_deletion_events WHERE request_id = ?;').run(requestId), 'profile_deletion_events_append_only', 'DELETE')
  })

  await check('[G4] Заявка със събития не може да бъде изтрита (FK RESTRICT пази tombstone-а)', () => {
    const { requestId, profile } = insertExecutingRequest(db)
    insertEvent(db, requestId, profile.profileId, 'claimed')
    assertRejects(() => db.prepare('DELETE FROM profile_deletion_requests WHERE request_id = ?;').run(requestId), 'FOREIGN KEY constraint failed', 'DELETE на заявка')
  })

  // ═══ [H] Двойна обработка ═══════════════════════════════════════════════
  console.log('\n[H] Предпазване от двойна обработка')

  // Втора независима връзка към СЪЩИЯ файл = втори процес (PM2 инстанция).
  const db2 = await openDatabase(workRun.databaseFilePath)

  await check('[H1] Два worker-а вземат една и съща заявка: само единият успява', () => {
    const { requestId } = insertDueRequest(db)
    const first = claim(db, requestId, 'worker-a')
    const second = claim(db2, requestId, 'worker-b')
    assertEqual(first + second, 1, 'общ брой успешни claim-ове')
    assertEqual(getRequest(db2, requestId).lease_owner, 'worker-a', 'lease_owner')
    assertEqual(getRequest(db2, requestId).attempt_count, 1, 'attempt_count')
  })

  await check('[H2] Жив lease не може да бъде отнет от друг worker (тригер в базата)', () => {
    const { requestId } = insertExecutingRequest(db, 'worker-a')
    assertRejects(() => db2.prepare(`UPDATE profile_deletion_requests SET lease_owner = 'worker-b', lease_expires_at = ? WHERE request_id = ? AND status = 'executing';`).run(isoPlus(dbNow(db2), LEASE_MS), requestId), 'profile_deletion_lease_held', 'отнемане на жив lease')
  })

  await check('[H3] Изтекъл lease се поема; старият worker вече не може да завърши (условие lease_owner)', () => {
    const { requestId } = insertExecutingRequest(db, 'worker-a')
    // Симулира срив на worker-a: lease-ът му изтича.
    db.prepare('UPDATE profile_deletion_requests SET lease_expires_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(db), -1000), requestId)
    const takeover = db2.prepare(`
      UPDATE profile_deletion_requests
      SET lease_owner = 'worker-b', lease_expires_at = ?, attempt_count = attempt_count + 1
      WHERE request_id = ? AND status = 'executing' AND lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
    `).run(isoPlus(dbNow(db2), LEASE_MS), requestId) as { changes: number }
    assertEqual(Number(takeover.changes), 1, 'поемане на изтекъл lease')
    const staleComplete = db.prepare(`
      UPDATE profile_deletion_requests
      SET status = 'completed', completed_at = ?, lease_owner = NULL, lease_expires_at = NULL
      WHERE request_id = ? AND status = 'executing' AND lease_owner = 'worker-a';
    `).run(dbNow(db), requestId) as { changes: number }
    assertEqual(Number(staleComplete.changes), 0, 'стар worker завърши заявка')
    assertEqual(getRequest(db, requestId).status, 'executing', 'статус')
    assertEqual(getRequest(db, requestId).attempt_count, 2, 'attempt_count след поемане')
  })

  await check('[H4] Отмяна, изпратена след claim, не променя нищо (условно UPDATE WHERE status=pending)', () => {
    const { requestId } = insertExecutingRequest(db, 'worker-a')
    const cancel = db2.prepare(`
      UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = ?
      WHERE request_id = ? AND status = 'pending';
    `).run(dbNow(db2), requestId) as { changes: number }
    assertEqual(Number(cancel.changes), 0, 'отмяна след claim')
    assertEqual(getRequest(db, requestId).status, 'executing', 'статус')
  })

  await check('[H5] Claim след отмяна не взема заявката', () => {
    const profile = insertHumanProfile(db)
    const requestId = insertBackdatedRequest(db, profile, isoPlus(dbNow(db), -PROFILE_DELETION_GRACE_PERIOD_MS + 30_000))
    setRequestStatus(db, requestId, 'cancelled')
    assertEqual(claim(db2, requestId, 'worker-b'), 0, 'claim на отменена заявка')
  })

  await check('[H6] BEGIN IMMEDIATE сериализира писачите между процесите', () => {
    db2.exec('PRAGMA busy_timeout = 0;')
    db.exec('BEGIN IMMEDIATE;')
    try {
      assertRejects(() => db2.exec('BEGIN IMMEDIATE;'), 'database is locked', 'втори BEGIN IMMEDIATE')
    } finally {
      db.exec('COMMIT;')
      db2.exec('PRAGMA busy_timeout = 5000;')
    }
  })

  await check('[H7] Повторен опит: executing -> pending с next_attempt_at; claim преди него не взема заявката', () => {
    const { requestId } = insertExecutingRequest(db, 'worker-a')
    const retryAt = isoPlus(dbNow(db), computeProfileDeletionRetryDelayMs(1))
    db.prepare(`
      UPDATE profile_deletion_requests
      SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
          next_attempt_at = ?, last_error_code = 'sqlite_busy', last_error_at = ?
      WHERE request_id = ? AND lease_owner = 'worker-a';
    `).run(retryAt, dbNow(db), requestId)
    assertEqual(claim(db2, requestId, 'worker-b'), 0, 'claim преди next_attempt_at')
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(db), -1), requestId)
    assertEqual(claim(db2, requestId, 'worker-b'), 1, 'claim след next_attempt_at')
    assertEqual(getRequest(db, requestId).attempt_count, 2, 'attempt_count')
  })

  db2.close()

  // ═══ [I] Файлова опашка ═════════════════════════════════════════════════
  console.log('\n[I] Файлова опашка')

  await check('[I1] Файл може да влезе в опашката само за заявка в статус executing', () => {
    const pending = insertRequest(db, insertHumanProfile(db))
    assertRejects(() => enqueueFile(db, pending, '/uploads/avatars/a.webp'), 'profile_deletion_file_requires_executing_request', 'pending (45-дневен период)')
    const cancelled = buildRequestInStatus(db, 'cancelled', true)
    assertRejects(() => enqueueFile(db, cancelled, '/uploads/avatars/b.webp'), 'profile_deletion_file_requires_executing_request', 'cancelled')
    const completed = buildRequestInStatus(db, 'completed', false)
    assertRejects(() => enqueueFile(db, completed, '/uploads/avatars/c.webp'), 'profile_deletion_file_requires_executing_request', 'completed')
    assertRejects(() => enqueueFile(db, randomUUID(), '/uploads/avatars/d.webp'), 'profile_deletion_file_requires_executing_request', 'несъществуваща заявка')
    const { requestId } = insertExecutingRequest(db)
    assert(enqueueFile(db, requestId, '/uploads/avatars/e.webp') > 0, 'executing трябва да е позволено')
  })

  await check('[I2] Структура: pending, 0 опита, без lease; идемпотентно enqueue-ване (UNIQUE + INSERT OR IGNORE)', () => {
    const { requestId } = insertExecutingRequest(db)
    const queueId = enqueueFile(db, requestId, 'f-1.webp', 'chat_attachment')
    const row = db.prepare('SELECT * FROM profile_deletion_file_queue WHERE queue_id = ?;').get(queueId) as Record<string, unknown>
    assertEqual(row.status, 'pending', 'status')
    assertEqual(row.attempt_count, 0, 'attempt_count')
    assertEqual(row.lease_owner, null, 'lease_owner')
    assertRejects(() => enqueueFile(db, requestId, 'f-1.webp', 'chat_attachment'), 'UNIQUE constraint failed', 'дубликат')
    assertEqual(enqueueFile(db, requestId, 'f-1.webp', 'chat_attachment', true), 0, 'INSERT OR IGNORE дубликат')
    // Същото име, но друг вид файл/друга заявка е отделен запис.
    assert(enqueueFile(db, requestId, 'f-1.webp', 'topic_attachment') > 0, 'друг file_kind')
  })

  await check('[I3] Невалиден вид файл и опасни пътища (.., \\, NUL) се отхвърлят от CHECK', () => {
    const { requestId } = insertExecutingRequest(db)
    assertRejects(() => enqueueFile(db, requestId, 'x.webp', 'database'), 'CHECK constraint failed', 'file_kind')
    for (const bad of ['/uploads/../database/data/belot-v2.sqlite', '..\\x.webp', 'a\\b.webp', `x${String.fromCharCode(0)}.webp`, '']) {
      assertRejects(() => enqueueFile(db, requestId, bad), 'CHECK constraint failed', `storage_ref=${JSON.stringify(bad)}`)
    }
  })

  await check('[I4] Пълна матрица 5×5: базата позволява точно преходите от ALLOWED_FILE_TRANSITIONS', () => {
    const mismatches: string[] = []
    for (const from of PROFILE_DELETION_FILE_STATUSES) {
      for (const to of PROFILE_DELETION_FILE_STATUSES) {
        if (from === to) continue
        const queueId = buildFileInStatus(db, from)
        const expectedAllowed = isAllowedProfileDeletionFileTransition(from, to)
        let actualAllowed = true
        let errorText = ''
        try {
          setFileStatus(db, queueId, to)
        } catch (error) {
          actualAllowed = false
          errorText = error instanceof Error ? error.message : String(error)
        }
        if (actualAllowed !== expectedAllowed) {
          mismatches.push(`${from}->${to}: очаквано ${expectedAllowed}, база ${actualAllowed} ${errorText}`)
        } else if (!actualAllowed && !errorText.includes('profile_deletion_file_invalid_status_transition')) {
          mismatches.push(`${from}->${to}: отхвърлен с неочаквана грешка ${errorText}`)
        }
      }
    }
    assert(mismatches.length === 0, mismatches.join(' | '))
  })

  await check('[I5] Повторни опити: processing -> failed -> processing -> done; опашката оцелява completed заявката', () => {
    const { requestId } = insertExecutingRequest(db)
    const queueId = enqueueFile(db, requestId, '/uploads/gallery/p/x.webp', 'gallery_image')
    // Заявката приключва в базата (същата транзакция, в която се enqueue-ват файловете).
    setRequestStatus(db, requestId, 'completed')
    const takeFile = db.prepare(`
      UPDATE profile_deletion_file_queue
      SET status = 'processing', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1
      WHERE queue_id = ? AND status IN ('pending', 'failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `)
    assertEqual(Number((takeFile.run('file-worker', isoPlus(dbNow(db), LEASE_MS), queueId) as { changes: number }).changes), 1, 'първи опит')
    db.prepare(`
      UPDATE profile_deletion_file_queue
      SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, last_error_code = 'EBUSY', next_attempt_at = ?
      WHERE queue_id = ?;
    `).run(isoPlus(dbNow(db), computeProfileDeletionRetryDelayMs(1)), queueId)
    assertEqual(Number((takeFile.run('file-worker', isoPlus(dbNow(db), LEASE_MS), queueId) as { changes: number }).changes), 0, 'опит преди next_attempt_at')
    db.prepare('UPDATE profile_deletion_file_queue SET next_attempt_at = ? WHERE queue_id = ?;').run(isoPlus(dbNow(db), -1), queueId)
    assertEqual(Number((takeFile.run('file-worker', isoPlus(dbNow(db), LEASE_MS), queueId) as { changes: number }).changes), 1, 'втори опит')
    setFileStatus(db, queueId, 'done')
    const row = db.prepare('SELECT status, attempt_count, last_error_code, completed_at FROM profile_deletion_file_queue WHERE queue_id = ?;').get(queueId) as Record<string, unknown>
    assertEqual(row.status, 'done', 'status')
    assertEqual(row.attempt_count, 2, 'attempt_count')
    assertEqual(row.last_error_code, 'EBUSY', 'последна грешка се пази')
    assert(isCanonicalUtcIsoTimestamp(String(row.completed_at)), 'completed_at')
  })

  await check('[I6] Файлов lease: жив не може да се отнеме; запис не може да започне извън pending; идентичността е неизменима', () => {
    const queueId = buildFileInStatus(db, 'processing')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_file_queue SET lease_owner = 'other', lease_expires_at = ? WHERE queue_id = ?;`).run(isoPlus(dbNow(db), LEASE_MS), queueId), 'profile_deletion_file_lease_held', 'отнемане на жив lease')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_file_queue SET storage_ref = 'other.webp' WHERE queue_id = ?;`).run(queueId), 'profile_deletion_file_identity_immutable', 'смяна на storage_ref')
    const { requestId } = insertExecutingRequest(db)
    assertRejects(() => db.prepare(`INSERT INTO profile_deletion_file_queue (request_id, file_kind, storage_ref, status, completed_at) VALUES (?, 'avatar', 'z.webp', 'done', ?);`).run(requestId, dbNow(db)), 'profile_deletion_file_must_start_pending', 'INSERT като done')
  })

  await check('[I7] Заявка с файлове в опашката не може да бъде изтрита (FK RESTRICT)', () => {
    const { requestId } = insertExecutingRequest(db)
    enqueueFile(db, requestId, 'r.webp', 'support_attachment')
    assertRejects(() => db.prepare('DELETE FROM profile_deletion_requests WHERE request_id = ?;').run(requestId), 'FOREIGN KEY constraint failed', 'DELETE на заявка')
  })

  // ═══ Финал ══════════════════════════════════════════════════════════════
  await check('[Z] След всички сценарии: foreign_keys=1, integrity_check=ok, foreign_key_check празен', () => {
    const fk = (db.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number }).foreign_keys
    assertEqual(fk, 1, 'PRAGMA foreign_keys')
    assertDatabaseHealthy(db)
  })

  db.close()
} finally {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
