/**
 * checkProfileDeletion30DayGracePeriod.ts
 *
 * Самоизтриване, Етап 4G — срокът за отмяна на НОВА доброволна заявка е
 * точно 30 дни (2 592 000 секунди); заявките отпреди миграция 20261101_001
 * пазят оригиналния си 45-дневен краен срок.
 *
 * Само временни бази: база "отпреди 4G" (миграциите без 20261101_001) с
 * исторически заявки -> миграцията -> новото правило, worker, бан, offsite
 * регистър, restore на стари/нови копия (`migrate --db` + reconcile) и
 * fail-closed при неочакван исторически ред. Нищо реално не се изтрива.
 *
 * Употреба (от server/): npx tsx scripts/checkProfileDeletion30DayGracePeriod.ts --server-root=.
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionRequestStore, type ProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createProfileDeletionExecutor, type ProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import {
  ensureProfileDeletionLedgerEntry,
  getProfileDeletionLedgerOffsiteAckPath,
  isProfileDeletionLedgerRequestConfirmedOffsite,
  readProfileDeletionLedger,
  writeProfileDeletionLedgerOffsiteAck,
} from '../src/db/profileDeletionLedger.js'
import {
  computeProfileDeletionSchedule,
  isProfileDeletionCancellable,
  isProfileDeletionDue,
  PROFILE_DELETION_GRACE_PERIOD_DAYS,
  PROFILE_DELETION_GRACE_PERIOD_MS,
  PROFILE_DELETION_LEGACY_GRACE_PERIOD_DAYS,
} from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { migrateRestoredDatabase } from '../src/ops/profileDeletionRestoredDbMigrations.js'
import { REAPPLY_CONFIRMATION_PHRASE, runProfileDeletionLedgerReconcile } from '../src/ops/profileDeletionLedgerReconcile.js'
import { removeProfileDeletionFile, type ProfileDeletionUploadRoots } from '../src/uploads/profileDeletionFileRemoval.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

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
  if (actual !== expected) throw new Error(`${message}: очаквано ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}

function assertRejects(fn: () => unknown, fragment: string, message: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!text.includes(fragment)) throw new Error(`${message}: очаквана грешка "${fragment}", получена "${text}"`)
    return
  }
  throw new Error(`${message}: не беше отхвърлено`)
}

const DAY_MS = 24 * 60 * 60 * 1000
const THIRTY_DAYS_SECONDS = 2_592_000
const FORTY_FIVE_DAYS_SECONDS = 3_888_000
const MIGRATION_4G = '20261101_001_voluntary_deletion_30_day_grace_period.sql'

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const SECRET = 'profile-deletion-30-day-grace-test-secret-0123456789'
const PASSWORD = 'secret123'

console.log('\ncheckProfileDeletion30DayGracePeriod')
console.log(`Server root: ${sourceServerRoot}`)

const tempRoots: string[] = []
const root = await mkdtemp(join(tmpdir(), 'belot-deletion-30d-'))
tempRoots.push(root)
await mkdir(join(root, 'database', 'migrations'), { recursive: true })
await mkdir(join(root, 'database', 'data'), { recursive: true })
for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
  // Базата "отпреди 4G": всички миграции без 20261101_001.
  if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql' && entry.name !== MIGRATION_4G) {
    await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
  }
}
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })

const sqliteModule = await import('node:sqlite')
const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const progressStore = await createPlayerProgressStore(databaseFilePath)
const authStore = await createAuthStore(databaseFilePath, progressStore, {
  registrationVerificationCodeSecret: SECRET,
  getRegistrationVerificationMode: () => 'direct',
  getActiveBanForProfile: () => null,
})

type User = { profileId: string; accountId: string; email: string; displayName: string }
let counter = 0
function registerUser(label: string): User {
  counter += 1
  const email = `g30-${label.toLowerCase()}-${counter}@example.test`
  const displayName = `G30${label}${counter}`
  const result = authStore.register({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
  return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, email, displayName }
}

function dbNow(): string {
  return (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
}

function isoPlus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

function withTriggerDropped<T>(name: string, fn: () => T): T {
  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?;`).get(name) as { sql: string }).sql
  db.exec(`DROP TRIGGER ${name};`)
  try { return fn() } finally { db.exec(sql) }
}

function profileCreatedAt(user: User): string {
  return (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
}

/** Fixture отпреди 4G (стара схема — без grace_period_days): точно 45 × 24 ч. */
function insertLegacyRequest(user: User, requestedAtIso: string): string {
  const requestId = randomUUID()
  withTriggerDropped('trg_profile_deletion_requests_insert_guard', () => {
    db.prepare(`
      INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for)
      VALUES (?, ?, ?, ?, ?, ?);
    `).run(requestId, user.profileId, user.accountId, profileCreatedAt(user), requestedAtIso, isoPlus(requestedAtIso, FORTY_FIVE_DAYS_SECONDS * 1000))
  })
  return requestId
}

function requestRow(target: SqliteDatabase, requestId: string): Record<string, unknown> | undefined {
  return target.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown> | undefined
}

function profileExists(target: SqliteDatabase, profileId: string): boolean {
  return target.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(profileId) !== undefined
}

/** Хеш на всички таблици без изброените — "непроменени записи". */
function snapshotTables(target: SqliteDatabase, exclude: ReadonlySet<string>): string {
  const tables = (target.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`).all() as Array<{ name: string }>)
    .map((row) => row.name).filter((name) => !exclude.has(name))
  return tables.map((table) => `${table}:${createHash('sha256').update(target.prepare(`SELECT * FROM "${table}";`).all().map((row) => JSON.stringify(row)).sort().join('\n')).digest('hex')}`).join('|')
}

function makeRoots(base: string): ProfileDeletionUploadRoots {
  return {
    avatars: join(base, 'avatars'),
    profileGallery: join(base, 'profile-gallery'),
    chatAttachments: join(base, 'chat-attachments'),
    topicAttachments: join(base, 'topic-attachments'),
    topicMuteEvidenceAttachments: join(base, 'topic-mute-evidence-attachments'),
    supportAttachments: join(base, 'support-attachments'),
  }
}
const uploadsRoot = join(root, 'uploads')
const roots = makeRoots(uploadsRoot)
for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })
const ledgerPath = join(root, 'deletion-ledger', 'profile-deletions.jsonl')

/** Контролирано offsite потвърждение — формата на backup скрипта (байтове + SHA-256 на префикса). */
function ackLedger(): void {
  const buffer = readFileSync(ledgerPath)
  const parsed = readProfileDeletionLedger(ledgerPath)
  writeProfileDeletionLedgerOffsiteAck(getProfileDeletionLedgerOffsiteAckPath(ledgerPath), {
    v: 1,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    lineCount: parsed.lineCount,
    entryCount: parsed.records.length,
    remotePath: 'test-offsite:/deletion-30d/profile-deletions.jsonl',
    confirmedAt: new Date().toISOString(),
  })
}

function ledgerEntryCount(requestId: string): number {
  return (readProfileDeletionLedger(ledgerPath).records as unknown as Array<{ requestId?: string; kind?: string }>)
    .filter((record) => record.kind === undefined && record.requestId === requestId).length
}

const backupDir = await mkdtemp(join(tmpdir(), 'belot-deletion-30d-backup-'))
tempRoots.push(backupDir)
const vacuumInto = (target: SqliteDatabase, path: string) => target.exec(`VACUUM INTO '${path.replace(/'/g, "''")}';`)
const otherTables = new Set(['profile_deletion_requests', 'server_migrations'])

let requestStore: ProfileDeletionRequestStore | null = null
let executor: ProfileDeletionExecutor | null = null

try {
  // ─── Фаза 1: база отпреди 4G с исторически заявки ──────────────────────
  console.log('\n[P] База отпреди 4G')
  const emptyPre4gBackup = join(backupDir, 'pre4g-empty.sqlite')
  vacuumInto(db, emptyPre4gBackup)

  const legacyPending = registerUser('LegacyPending')
  const legacyCancelled = registerUser('LegacyCancelled')
  const legacyDue = registerUser('LegacyDue')
  const now0 = dbNow()
  const legacyPendingId = insertLegacyRequest(legacyPending, isoPlus(now0, -DAY_MS))
  const legacyCancelledId = insertLegacyRequest(legacyCancelled, isoPlus(now0, -10 * DAY_MS))
  db.prepare(`UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE request_id = ?;`).run(legacyCancelledId)
  const legacyDueId = insertLegacyRequest(legacyDue, isoPlus(now0, -(FORTY_FIVE_DAYS_SECONDS * 1000 + DAY_MS / 24)))
  const legacyRowsBefore = new Map([legacyPendingId, legacyCancelledId, legacyDueId].map((id) => [id, requestRow(db, id)!]))

  const pre4gBackup = join(backupDir, 'pre4g.sqlite')
  vacuumInto(db, pre4gBackup)

  await check('[P1] Fixture: старата схема налага точно 3 888 000 секунди (45-дневните заявки са валидни, 30-дневна — не)', () => {
    assert(String((db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'profile_deletion_requests';`).get() as { sql: string }).sql).includes('3888000'), 'стар CHECK')
    const user = registerUser('OldSchema30')
    assertRejects(() => withTriggerDropped('trg_profile_deletion_requests_insert_guard', () => db.prepare(`
      INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for) VALUES (?, ?, ?, ?, ?, ?);
    `).run(randomUUID(), user.profileId, user.accountId, profileCreatedAt(user), now0, isoPlus(now0, THIRTY_DAYS_SECONDS * 1000))), 'CHECK constraint failed', '30 дни в старата схема')
  })

  // [16b] Fail-closed: неочакван исторически ред (заобиколен CHECK) -> миграцията отказва, нищо не се променя.
  const tamperedBackup = join(backupDir, 'pre4g-tampered.sqlite')
  vacuumInto(db, tamperedBackup)
  {
    const tampered = new sqliteModule.DatabaseSync(tamperedBackup, { open: true })
    const user = (tampered.prepare('SELECT profile_id, account_id, created_at FROM profiles WHERE profile_id = ?;').get(legacyPending.profileId)) as { profile_id: string; account_id: string; created_at: string }
    tampered.exec('PRAGMA ignore_check_constraints = ON;')
    tampered.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
    tampered.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, status, requested_at, scheduled_for, cancelled_at)
      VALUES (?, ?, ?, ?, 'cancelled', ?, ?, ?);`).run('tampered-30d', user.profile_id, user.account_id, user.created_at, now0, isoPlus(now0, THIRTY_DAYS_SECONDS * 1000), now0)
    tampered.close()
  }
  await check('[G16b] Fail-closed: исторически ред с продължителност ≠ 3 888 000 s -> миграцията отказва и базата остава непроменена', async () => {
    let error = ''
    try {
      await migrateRestoredDatabase(tamperedBackup, { liveDbPath: databaseFilePath })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    assert(error.includes(MIGRATION_4G) && error.includes('NOT NULL'), `грешка: ${error}`)
    const tampered = new sqliteModule.DatabaseSync(tamperedBackup, { readOnly: true })
    try {
      assertEqual(tampered.prepare('SELECT 1 FROM server_migrations WHERE filename = ?;').get(MIGRATION_4G), undefined, 'миграцията не е записана')
      assert(String((tampered.prepare(`SELECT sql FROM sqlite_master WHERE name = 'profile_deletion_requests';`).get() as { sql: string }).sql).includes('3888000'), 'старата таблица е непроменена')
      assertEqual(Number((tampered.prepare(`SELECT COUNT(*) AS c FROM profile_deletion_requests WHERE request_id = 'tampered-30d';`).get() as { c: number }).c), 1, 'неочакваният ред не е променен/изтрит')
      assertEqual(tampered.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'profile_deletion_requests_new';`).get(), undefined, 'без остатъчна таблица')
    } finally {
      tampered.close()
    }
  })

  // ─── Фаза 2: миграцията ─────────────────────────────────────────────────
  console.log('\n[M] Миграция 20261101_001')
  // Отпечатък на всички останали таблици непосредствено преди миграцията.
  const othersBefore = snapshotTables(db, otherTables)
  await copyFile(join(sourceServerRoot, 'database', 'migrations', MIGRATION_4G), join(root, 'database', 'migrations', MIGRATION_4G))
  await ensureServerDatabaseReady({ serverRootOverride: root })
  db.close()
  const dbMigrated: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  dbMigrated.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  // Оттук нататък — през връзка, отворена след миграцията.
  const mdb = dbMigrated

  await check('[G16] Миграцията върху временна база: записана, интегритет, външни ключове, всички индекси/тригери', () => {
    assert(mdb.prepare('SELECT 1 FROM server_migrations WHERE filename = ?;').get(MIGRATION_4G) !== undefined, 'server_migrations')
    assertEqual((mdb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check, 'ok', 'integrity_check')
    assertEqual((mdb.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
    const names = (mdb.prepare(`SELECT name FROM sqlite_master WHERE sql LIKE '%profile_deletion_requests%' ORDER BY name;`).all() as Array<{ name: string }>).map((row) => row.name)
    for (const expected of [
      'idx_profile_deletion_requests_active_profile', 'idx_profile_deletion_requests_due', 'idx_profile_deletion_requests_lease',
      'idx_profile_deletion_requests_profile', 'idx_profile_deletion_requests_retry',
      'trg_profile_deletion_requests_insert_guard', 'trg_profile_deletion_requests_identity_immutable', 'trg_profile_deletion_requests_status_transition',
      'trg_profile_deletion_requests_lease_guard', 'trg_profile_deletion_requests_close_restore_tokens', 'trg_profile_deletion_requests_db_deleted_guard',
      'trg_profile_deletion_requests_after_db_deleted', 'trg_profile_deletion_requests_completion_guard', 'trg_profile_deletion_events_profile_match',
      'trg_profile_deletion_file_queue_insert_guard', 'trg_profile_deletion_restore_tokens_insert_guard',
      'trg_tournament_entries_profile_deletion_admission_insert', 'trg_tournament_entries_profile_deletion_admission_update',
    ]) assert(names.includes(expected), `липсва ${expected}`)
    assertEqual(mdb.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'profile_deletion_requests_new';`).get(), undefined, 'без остатъчна таблица')
  })

  await check('[G14] Историческите заявки пазят оригиналния 45-дневен срок (всички колони непроменени, grace_period_days = 45)', () => {
    for (const [requestId, before] of legacyRowsBefore) {
      const after = requestRow(mdb, requestId)!
      for (const [column, value] of Object.entries(before)) assertEqual(after[column], value, `${requestId}.${column}`)
      assertEqual(Number(after.grace_period_days), PROFILE_DELETION_LEGACY_GRACE_PERIOD_DAYS, 'grace_period_days')
      assertEqual((Date.parse(String(after.scheduled_for)) - Date.parse(String(after.requested_at))) / 1000, FORTY_FIVE_DAYS_SECONDS, 'продължителност')
    }
  })

  await check('[G21] Финансовите, административните и всички останали таблици са непроменени от миграцията', () => {
    const after = snapshotTables(mdb, otherTables).split('|')
    const before = othersBefore.split('|')
    const changed = after.filter((entry) => !before.includes(entry)).map((entry) => entry.split(':')[0])
    assert(changed.length === 0 && after.length === before.length, `променени таблици: ${changed.join(', ')}`)
  })

  requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
  executor = await createProfileDeletionExecutor(databaseFilePath)
  const store = requestStore
  const exec = executor

  // Helpers срещу мигрираната връзка.
  const mNow = () => (mdb.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const mWithTriggerDropped = <T,>(name: string, fn: () => T): T => {
    const sql = (mdb.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?;`).get(name) as { sql: string }).sql
    mdb.exec(`DROP TRIGGER ${name};`)
    try { return fn() } finally { mdb.exec(sql) }
  }
  const mCreatedAt = (user: User) => (mdb.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
  const mInsertNew = (user: User, scheduledForIso: string): string => {
    const requestId = randomUUID()
    mWithTriggerDropped('trg_profile_deletion_requests_insert_guard', () => {
      mdb.prepare(`
        INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days)
        VALUES (?, ?, ?, ?, ?, ?, 30);
      `).run(requestId, user.profileId, user.accountId, mCreatedAt(user), isoPlus(scheduledForIso, -PROFILE_DELETION_GRACE_PERIOD_MS), scheduledForIso)
    })
    return requestId
  }
  const makeRetryDue = (requestId: string) => mdb.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(mNow(), -1000), requestId)
  const makeWorker = (workerId: string, onlyRequestIds: string[]) => createProfileDeletionWorker({
    executor: exec,
    workerId,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: (entry) => { ensureProfileDeletionLedgerEntry(ledgerPath, entry) },
    isLedgerEntryConfirmedOffsite: (requestId) => isProfileDeletionLedgerRequestConfirmedOffsite(ledgerPath, requestId),
    onlyRequestIds,
  })

  // ─── Фаза 3: новото правило ─────────────────────────────────────────────
  console.log('\n[N] Нови заявки — 30 дни')
  const fresh = registerUser('Fresh')
  let freshRequestId = ''

  await check('[G1/G15] Нова заявка след миграцията: grace_period_days = 30 и точно 2 592 000 секунди', () => {
    assertEqual(PROFILE_DELETION_GRACE_PERIOD_DAYS, 30, 'константа')
    assertEqual(PROFILE_DELETION_GRACE_PERIOD_MS, THIRTY_DAYS_SECONDS * 1000, 'милисекунди')
    const result = store.createRequest({ profileId: fresh.profileId, accountId: fresh.accountId })
    assert(result.ok, JSON.stringify(result))
    if (!result.ok) return
    freshRequestId = result.request.requestId
    const row = requestRow(mdb, freshRequestId)!
    assertEqual(Number(row.grace_period_days), 30, 'grace_period_days')
    assertEqual((Date.parse(String(row.scheduled_for)) - Date.parse(String(row.requested_at))) / 1000, THIRTY_DAYS_SECONDS, 'продължителност')
  })

  await check('[G2/G20] Крайната дата е requested_at + 30 × 24 ч от часовника на базата; API стойностите = стойностите в базата (вкл. за историческа заявка)', () => {
    const row = requestRow(mdb, freshRequestId)!
    assert(Math.abs(Date.parse(String(row.requested_at)) - Date.parse(mNow())) < 60_000, 'requested_at е "сега" по часовника на базата')
    assertEqual(String(row.scheduled_for), computeProfileDeletionSchedule(new Date(String(row.requested_at))).scheduledFor, 'изчислена крайна дата')
    const pending = store.getPendingRequest(fresh.profileId)
    assert(pending !== null && pending.scheduledFor === row.scheduled_for && pending.requestedAt === row.requested_at && pending.gracePeriodDays === 30, `getPendingRequest: ${JSON.stringify(pending)}`)
    const issued = store.issueRestoreToken(fresh.profileId)
    assert(issued.ok && issued.request.scheduledFor === row.scheduled_for && issued.request.gracePeriodDays === 30, `issueRestoreToken: ${JSON.stringify(issued)}`)
    const legacyIssued = store.issueRestoreToken(legacyPending.profileId)
    const legacyRow = requestRow(mdb, legacyPendingId)!
    assert(legacyIssued.ok && legacyIssued.request.scheduledFor === legacyRow.scheduled_for && legacyIssued.request.gracePeriodDays === 45, `историческа: ${JSON.stringify(legacyIssued)}`)
  })

  await check('[G9] Повторна заявка при активна: отказ (already_pending), срокът не се удължава/съкращава', () => {
    const before = requestRow(mdb, freshRequestId)!
    const again = store.createRequest({ profileId: fresh.profileId, accountId: fresh.accountId })
    assert(!again.ok && again.code === 'already_pending', JSON.stringify(again))
    const after = requestRow(mdb, freshRequestId)!
    assertEqual(after.scheduled_for, before.scheduled_for, 'scheduled_for')
    assertEqual(Number((mdb.prepare('SELECT COUNT(*) AS c FROM profile_deletion_requests WHERE profile_id = ?;').get(fresh.profileId) as { c: number }).c), 1, 'една заявка')
    const legacyAgain = store.createRequest({ profileId: legacyPending.profileId, accountId: legacyPending.accountId })
    assert(!legacyAgain.ok && legacyAgain.code === 'already_pending', 'историческата не се заменя с нова 30-дневна')
  })

  await check('[G22] Клиентската дата не може да заобиколи срока: requested_at извън прозореца, 45 дни, грешна продължителност и промяна на срока се отказват', () => {
    const user = registerUser('Tamper')
    const createdAt = mCreatedAt(user)
    const now = mNow()
    const insert = (requestedAt: string, scheduledFor: string, grace: number) => mdb.prepare(`
      INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `).run(randomUUID(), user.profileId, user.accountId, createdAt, requestedAt, scheduledFor, grace)
    const pastRequested = isoPlus(now, -29 * DAY_MS)
    assertRejects(() => insert(pastRequested, isoPlus(pastRequested, PROFILE_DELETION_GRACE_PERIOD_MS), 30), 'profile_deletion_requested_at_out_of_window', 'датиране назад')
    assertRejects(() => insert(now, isoPlus(now, FORTY_FIVE_DAYS_SECONDS * 1000), 45), 'profile_deletion_grace_period_must_be_30_days', 'нова 45-дневна')
    assertRejects(() => insert(now, isoPlus(now, 29 * DAY_MS), 30), 'CHECK constraint failed', '29 дни')
    assertRejects(() => insert(now, isoPlus(now, 31 * DAY_MS), 30), 'CHECK constraint failed', '31 дни')
    assertRejects(() => mdb.prepare('UPDATE profile_deletion_requests SET scheduled_for = ? WHERE request_id = ?;').run(isoPlus(String(requestRow(mdb, freshRequestId)!.scheduled_for), DAY_MS), freshRequestId), 'profile_deletion_request_identity_immutable', 'удължаване')
    assertRejects(() => mdb.prepare('UPDATE profile_deletion_requests SET grace_period_days = 45 WHERE request_id = ?;').run(freshRequestId), 'profile_deletion_request_identity_immutable', 'смяна на grace_period_days')
    assertRejects(() => mdb.prepare('UPDATE profile_deletion_requests SET grace_period_days = 30 WHERE request_id = ?;').run(legacyPendingId), 'profile_deletion_request_identity_immutable', 'съкращаване на историческа')
  })

  console.log('\n[C] Отмяна около крайния срок')

  await check('[G3] Отмяна непосредствено преди крайния срок: разрешена', () => {
    const user = registerUser('CancelBefore')
    const requestId = mInsertNew(user, isoPlus(mNow(), 3000))
    const issued = store.issueRestoreToken(user.profileId)
    assert(issued.ok, 'токен преди края')
    if (!issued.ok) return
    const cancelled = store.cancelWithToken(issued.restoreToken)
    assert(cancelled.ok, JSON.stringify(cancelled))
    assertEqual(requestRow(mdb, requestId)!.status, 'cancelled', 'status')
  })

  await check('[G4] Точно на крайния срок: отмяната се отказва (функцията и тригерът в базата)', () => {
    const deadline = '2026-11-23T10:00:00.000Z'
    assert(!isProfileDeletionCancellable(deadline, new Date(deadline)), 'точно на срока')
    assert(isProfileDeletionCancellable(deadline, new Date(Date.parse(deadline) - 1)), '1 ms преди')
    assert(isProfileDeletionDue(deadline, new Date(deadline)), 'изтриването е допустимо точно от срока')
    const user = registerUser('CancelAt')
    const requestId = mInsertNew(user, mNow())
    const none = store.issueRestoreToken(user.profileId)
    assert(!none.ok && none.code === 'no_pending_request', 'токен на границата')
    assertRejects(() => mdb.prepare(`UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE request_id = ?;`).run(requestId), 'profile_deletion_cancel_window_closed', 'тригер')
    assertEqual(requestRow(mdb, requestId)!.status, 'pending', 'статусът е непроменен')
  })

  await check('[G5] След крайния срок: нов токен не се издава, издаден преди края токен се отказва (window_closed)', async () => {
    const after = registerUser('CancelAfter')
    mInsertNew(after, isoPlus(mNow(), -1000))
    const none = store.issueRestoreToken(after.profileId)
    assert(!none.ok && none.code === 'no_pending_request', 'нов токен')
    const crossing = registerUser('Crossing')
    const requestId = mInsertNew(crossing, isoPlus(mNow(), 1200))
    const issued = store.issueRestoreToken(crossing.profileId)
    assert(issued.ok, 'токен преди края')
    if (!issued.ok) return
    await new Promise((r) => setTimeout(r, 1800))
    const late = store.cancelWithToken(issued.restoreToken)
    assert(!late.ok && late.code === 'window_closed', JSON.stringify(late))
    assertEqual(requestRow(mdb, requestId)!.status, 'pending', 'статусът е непроменен')
  })

  await check('[G8] Смяна на часовото време: точно 30 × 24 ч в UTC (EU есен 2026 и пролет 2027), независимо от TZ на процеса; базата приема реда', () => {
    const originalTz = process.env.TZ
    try {
      for (const [requestedAt, expected] of [
        ['2026-10-20T12:00:00.000Z', '2026-11-19T12:00:00.000Z'],
        ['2027-03-20T12:00:00.000Z', '2027-04-19T12:00:00.000Z'],
      ] as const) {
        for (const tz of ['UTC', 'Europe/Sofia', 'America/New_York']) {
          process.env.TZ = tz
          assertEqual(computeProfileDeletionSchedule(new Date(requestedAt)).scheduledFor, expected, `${requestedAt} @ ${tz}`)
        }
      }
      const sofia = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', hour12: false }).format(new Date(iso))
      assertEqual(`${sofia('2026-10-20T12:00:00.000Z')}->${sofia('2026-11-19T12:00:00.000Z')}`, '15->14', 'локалният час се измества с 1 ч (реално изминалото време е еднакво)')
    } finally {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    }
    const user = registerUser('Dst')
    mWithTriggerDropped('trg_profile_deletion_requests_insert_guard', () => {
      mdb.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days)
        VALUES (?, ?, ?, ?, '2026-10-20T12:00:00.000Z', '2026-11-19T12:00:00.000Z', 30);`).run(randomUUID(), user.profileId, user.accountId, mCreatedAt(user))
    })
  })

  console.log('\n[W] Worker и крайният срок')

  const early = registerUser('Early')
  const earlyId = mInsertNew(early, isoPlus(mNow(), 60_000))
  await check('[G6] Няма ранно изтриване: нова заявка преди срока и историческа (още ~44 дни) не се вземат; тригерът отказва executing', async () => {
    const summary = await makeWorker('w-early', [earlyId, legacyPendingId]).runOnce()
    assertEqual(summary.claimed, 0, `claimed (${JSON.stringify(summary)})`)
    assert(profileExists(mdb, early.profileId) && profileExists(mdb, legacyPending.profileId), 'профилите съществуват')
    assertRejects(() => mdb.prepare(`UPDATE profile_deletion_requests SET status = 'executing', lease_owner = 'x', lease_expires_at = ? WHERE request_id = ?;`).run(isoPlus(mNow(), 60_000), earlyId), 'profile_deletion_not_due', 'тригер not_due')
  })

  const due30 = registerUser('Due30')
  const due30Id = mInsertNew(due30, isoPlus(mNow(), -1000))
  await check('[G19] Неуспешно offsite потвърждение: изтриване НЯМА само защото срокът е минал (blocked, без фиктивен успех)', async () => {
    const summary = await makeWorker('w-offsite', [due30Id, legacyDueId]).runOnce()
    assertEqual(summary.completed, 0, `completed (${JSON.stringify(summary)})`)
    assertEqual(summary.blocked, 2, 'blocked')
    for (const [id, user] of [[due30Id, due30], [legacyDueId, legacyDue]] as const) {
      const row = requestRow(mdb, id)!
      assertEqual(row.status, 'blocked', `${id} status`)
      assertEqual(row.last_error_code, 'ledger_offsite_pending', `${id} код`)
      assertEqual(row.db_deleted_at, null, `${id} db_deleted_at`)
      assert(profileExists(mdb, user.profileId), 'профилът съществува')
    }
  })

  await check('[G7/G18] След offsite ack: 30-дневната заявка (точно след срока) и историческата (при своя 45-дневен срок) се изтриват; повторният worker не прави нищо; срокът не се променя при retry', async () => {
    const scheduledBefore = [requestRow(mdb, due30Id)!.scheduled_for, requestRow(mdb, legacyDueId)!.scheduled_for]
    ackLedger()
    makeRetryDue(due30Id)
    makeRetryDue(legacyDueId)
    const summary = await makeWorker('w-ack', [due30Id, legacyDueId]).runOnce()
    assertEqual(summary.completed, 2, `completed (${JSON.stringify(summary)})`)
    assert(!profileExists(mdb, due30.profileId) && !profileExists(mdb, legacyDue.profileId), 'профилите са изтрити')
    assertEqual(requestRow(mdb, due30Id)!.scheduled_for, scheduledBefore[0], '30-дневният срок е непроменен')
    assertEqual(requestRow(mdb, legacyDueId)!.scheduled_for, scheduledBefore[1], '45-дневният срок е непроменен')
    const again = await makeWorker('w-again', [due30Id, legacyDueId]).runOnce()
    assertEqual(again.claimed, 0, 'повторен worker')
    assertEqual(ledgerEntryCount(due30Id), 1, 'регистър: 30 дни без дублиране')
    assertEqual(ledgerEntryCount(legacyDueId), 1, 'регистър: 45 дни без дублиране')
  })

  console.log('\n[B] Бан')

  await check('[G11] Активен бан при подаване: заявката се отказва, ред не се създава', () => {
    const user = registerUser('BannedSubmit')
    mdb.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason, banned_by_profile_id) VALUES (?, ?, datetime('now', '+7 days'), 'нарушение', ?);`).run(randomUUID(), user.profileId, fresh.profileId)
    const result = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(!result.ok && result.code === 'active_ban', JSON.stringify(result))
    assertEqual(Number((mdb.prepare('SELECT COUNT(*) AS c FROM profile_deletion_requests WHERE profile_id = ?;').get(user.profileId) as { c: number }).c), 0, 'без ред')
  })

  const bannedLater = registerUser('BannedLater')
  const bannedLaterId = mInsertNew(bannedLater, isoPlus(mNow(), -1000))
  const banId = randomUUID()
  await check('[G12] Бан, наложен след подаването: изтриването е блокирано до отпадането му, срокът НЕ се нулира', async () => {
    mdb.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason, banned_by_profile_id) VALUES (?, ?, datetime('now', '+7 days'), 'нарушение след заявката', ?);`).run(banId, bannedLater.profileId, fresh.profileId)
    const scheduledBefore = requestRow(mdb, bannedLaterId)!.scheduled_for
    // Записът в регистъра се прави преди проверката на бана — потвърждаваме го
    // offsite, за да е банът единствената причина за блокирането.
    await makeWorker('w-ban-ledger', [bannedLaterId]).runOnce()
    ackLedger()
    makeRetryDue(bannedLaterId)
    const summary = await makeWorker('w-ban', [bannedLaterId]).runOnce()
    assertEqual(summary.completed, 0, `completed (${JSON.stringify(summary)})`)
    const row = requestRow(mdb, bannedLaterId)!
    assertEqual(row.status, 'blocked', 'status')
    assertEqual(row.last_error_code, 'active_ban', 'код')
    assertEqual(row.scheduled_for, scheduledBefore, 'срокът е непроменен')
    assert(profileExists(mdb, bannedLater.profileId), 'профилът съществува')
  })

  await check('[G13] Бан, изтекъл след срока: следващият опит изпълнява изтриването (без нов срок)', async () => {
    mdb.prepare(`UPDATE profile_bans SET banned_until = datetime('now', '-1 minute') WHERE ban_id = ?;`).run(banId)
    makeRetryDue(bannedLaterId)
    const summary = await makeWorker('w-ban-expired', [bannedLaterId]).runOnce()
    assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
    assert(!profileExists(mdb, bannedLater.profileId), 'профилът е изтрит')
  })

  await check('[G10] Отменена заявка: worker-ът не я взема; нова заявка след отмяна получава свеж 30-дневен срок; историческата отменена е непроменена', async () => {
    const user = registerUser('Cancelled')
    const created = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(created.ok, 'заявка')
    if (!created.ok) return
    const issued = store.issueRestoreToken(user.profileId)
    assert(issued.ok, 'токен')
    if (!issued.ok) return
    assert(store.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    const summary = await makeWorker('w-cancelled', [created.request.requestId]).runOnce()
    assertEqual(summary.claimed, 0, 'worker')
    assert(profileExists(mdb, user.profileId), 'профилът съществува')
    await new Promise((r) => setTimeout(r, 5))
    const second = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(second.ok && second.request.gracePeriodDays === 30, JSON.stringify(second))
    if (!second.ok) return
    assert(second.request.requestedAt > created.request.requestedAt, 'нов requested_at')
    assertEqual((Date.parse(second.request.scheduledFor) - Date.parse(second.request.requestedAt)) / 1000, THIRTY_DAYS_SECONDS, '30 дни')
    const legacy = requestRow(mdb, legacyCancelledId)!
    for (const [column, value] of Object.entries(legacyRowsBefore.get(legacyCancelledId)!)) assertEqual(legacy[column], value, `историческа.${column}`)
  })

  // ─── Фаза 4: restore ────────────────────────────────────────────────────
  console.log('\n[R] Restore и обратна съвместимост')

  await check('[G17a] Restore на празна база отпреди 4G: `migrate --db` прилага 4G, няма заявки', async () => {
    const copy = join(backupDir, 'restore-empty.sqlite')
    await copyFile(emptyPre4gBackup, copy)
    const result = await migrateRestoredDatabase(copy, { liveDbPath: databaseFilePath })
    assert(result.applied.includes(MIGRATION_4G) && result.pendingAfter.length === 0, JSON.stringify(result))
    const restored = new sqliteModule.DatabaseSync(copy, { readOnly: true })
    try {
      assertEqual(Number((restored.prepare('SELECT COUNT(*) AS c FROM profile_deletion_requests;').get() as { c: number }).c), 0, 'заявки')
      assert(restored.prepare(`SELECT 1 FROM pragma_table_info('profile_deletion_requests') WHERE name = 'grace_period_days';`).get() !== undefined, 'grace_period_days')
    } finally {
      restored.close()
    }
  })

  const restoredPre4g = join(backupDir, 'restore-pre4g.sqlite')
  await copyFile(pre4gBackup, restoredPre4g)
  await check('[G17b] Restore на backup отпреди миграцията (стара 45-дневна чакаща, отменена, падежна): `migrate --db` запазва оригиналните срокове', async () => {
    const result = await migrateRestoredDatabase(restoredPre4g, { liveDbPath: databaseFilePath })
    assert(result.applied.includes(MIGRATION_4G) && result.pendingAfter.length === 0, JSON.stringify(result))
    const restored = new sqliteModule.DatabaseSync(restoredPre4g, { readOnly: true })
    try {
      for (const [requestId, before] of legacyRowsBefore) {
        const after = requestRow(restored, requestId)!
        for (const [column, value] of Object.entries(before)) assertEqual(after[column], value, `${requestId}.${column}`)
        assertEqual(Number(after.grace_period_days), 45, 'grace_period_days')
      }
      assertEqual((restored.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
    } finally {
      restored.close()
    }
  })

  await check('[G17c] Окончателно изтрит след backup-а профил не се връща: reconcile --apply върху мигрираното копие го изтрива отново; другите заявки са непокътнати', async () => {
    const lines: string[] = []
    const restoredUploads = join(backupDir, 'restore-uploads')
    await mkdir(restoredUploads, { recursive: true })
    const code = await runProfileDeletionLedgerReconcile(
      [`--db=${restoredPre4g}`, `--ledger=${ledgerPath}`, '--apply', `--confirm=${REAPPLY_CONFIRMATION_PHRASE}`, `--uploads-root=${restoredUploads}`],
      { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    )
    assert(code === 0 || code === 1, `exit ${code}: ${lines.slice(-5).join(' | ')}`)
    const restored = new sqliteModule.DatabaseSync(restoredPre4g, { readOnly: true })
    try {
      assert(!profileExists(restored, legacyDue.profileId), `изтритият профил се върна: ${lines.slice(-5).join(' | ')}`)
      assert(profileExists(restored, legacyPending.profileId), 'чакащата историческа заявка остава')
      const legacyPendingRow = requestRow(restored, legacyPendingId)!
      assertEqual(legacyPendingRow.status, 'pending', 'статус')
      assertEqual(legacyPendingRow.scheduled_for, legacyRowsBefore.get(legacyPendingId)!.scheduled_for, 'оригиналният 45-дневен срок')
      assertEqual(requestRow(restored, legacyCancelledId)!.status, 'cancelled', 'отменената остава отменена')
    } finally {
      restored.close()
    }
  })

  await check('[G17d] Restore на копие след 4G (нова 30-дневна + изтрит профил): `migrate --db` няма какво да прилага, срокът и изтриването са запазени', async () => {
    const copy = join(backupDir, 'restore-post4g.sqlite')
    vacuumInto(mdb, copy)
    const result = await migrateRestoredDatabase(copy, { liveDbPath: databaseFilePath })
    assertEqual(result.applied.length, 0, 'приложени')
    const restored = new sqliteModule.DatabaseSync(copy, { readOnly: true })
    try {
      const row = requestRow(restored, freshRequestId)!
      assertEqual(Number(row.grace_period_days), 30, 'grace_period_days')
      assertEqual(row.scheduled_for, requestRow(mdb, freshRequestId)!.scheduled_for, 'срок')
      assert(!profileExists(restored, due30.profileId), 'изтритият профил не се появява')
      assertEqual(requestRow(restored, due30Id)!.status, 'completed', 'tombstone')
    } finally {
      restored.close()
    }
  })

  mdb.close()
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try { requestStore?.close() } catch { /* ignore */ }
  try { executor?.close() } catch { /* ignore */ }
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
