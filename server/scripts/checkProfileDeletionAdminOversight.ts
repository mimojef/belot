/**
 * checkProfileDeletionAdminOversight.ts
 *
 * Самоизтриване, Етап 4J — административен преглед на заявките/операциите по
 * изтриване и контролирана административна отмяна на ДОБРОВОЛНА заявка.
 *
 * Само временни бази и временен регистър — никога реалната база.
 *
 * [M] Миграция 20261102_001 върху копие "отпреди 4G" (историческа 45-дневна)
 *     и копие "след 4G, отпреди 4J" (30-дневни, отменени): записите са
 *     непроменени, интегритет/външни ключове, обектите съществуват.
 * [L] Преглед: категории по реалните статуси, лимит 300 в SQL, подреждане,
 *     филтри, поверителност на изтрити профили.
 * [C] Отмяна: в срока, историческа 45-дневна, след 30-дневния срок, блокирана
 *     преди регистъра, неуспешен запис в регистъра, причина, одит; откази —
 *     бан/offsite (намерението е в регистъра), lease, файлова фаза,
 *     приключена, вече отменена, административна операция, отнета роля,
 *     повреден/липсващ регистър; потребителската отмяна след срока остава
 *     забранена.
 * [R] Състезания: две едновременни отмени, отмяна срещу claim на worker-а,
 *     worker срещу отмяна, грешка преди COMMIT.
 * [T] Тригери в базата (одитът е append-only, отмяна без одит не заобикаля
 *     правилата, необратимата граница).
 * [W] Worker и restore: отменена заявка никога не се изпълнява; restore на
 *     копие след отмяната + reconcile не изтрива профила; известното
 *     ограничение (копие отпреди отмяната) е документирано.
 * [H] HTTP през реален сървър (изолирано копие): само admin (403 за всички
 *     останали роли и гост), отнета роля, лимит/филтри, отмяна с причина,
 *     видимостта се връща, банът остава, без нова/стара сесия, без лични
 *     данни и файлови пътища в отговора.
 *
 * Употреба (от server/): npx tsx scripts/checkProfileDeletionAdminOversight.ts --server-root=.
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createPasswordHash } from '../src/db/authHelpers.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import {
  PROFILE_DELETION_ADMIN_LIST_MAX,
  createProfileDeletionAdminStore,
  loadProfileDeletionLedgerView,
  type ProfileDeletionAdminRow,
  type ProfileDeletionAdminStore,
} from '../src/db/profileDeletionAdminStore.js'
import {
  ensureProfileDeletionLedgerEntry,
  getProfileDeletionLedgerOffsiteAckPath,
  isProfileDeletionLedgerRequestConfirmedOffsite,
  readProfileDeletionLedger,
  writeProfileDeletionLedgerOffsiteAck,
} from '../src/db/profileDeletionLedger.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { REAPPLY_CONFIRMATION_PHRASE, runProfileDeletionLedgerReconcile } from '../src/ops/profileDeletionLedgerReconcile.js'
import type { ProfileDeletionUploadRoots } from '../src/uploads/profileDeletionFileRemoval.js'

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
const FORTY_FIVE_DAYS_MS = 45 * DAY_MS
const MIGRATION_4G = '20261101_001_voluntary_deletion_30_day_grace_period.sql'
const MIGRATION_4J = '20261102_001_admin_profile_deletion_cancellations.sql'
const SECRET = 'profile-deletion-admin-oversight-secret-0123456789'
const PASSWORD = 'secret123'
const REASON_HTTP = 'Отмяна по искане на потребителя, потвърдено по телефона.'

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\ncheckProfileDeletionAdminOversight')
console.log(`Server root: ${sourceServerRoot}`)

const sqliteModule = await import('node:sqlite')
const tempRoots: string[] = []
const closers: Array<() => void> = []

function isoPlus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

async function makeRoot(prefix: string, filter: (name: string) => boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql' && filter(entry.name)) {
      await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  return root
}

function openDb(path: string): SqliteDatabase {
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(path, { open: true, enableForeignKeyConstraints: true })
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  return database
}

function withTriggerDropped<T>(database: SqliteDatabase, name: string, fn: () => T): T {
  const sql = (database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?;`).get(name) as { sql: string }).sql
  database.exec(`DROP TRIGGER ${name};`)
  try { return fn() } finally { database.exec(sql) }
}

function dbNow(database: SqliteDatabase): string {
  return (database.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
}

function tableHash(database: SqliteDatabase, table: string): string {
  return createHash('sha256').update(database.prepare(`SELECT * FROM "${table}";`).all().map((row) => JSON.stringify(row)).sort().join('\n')).digest('hex')
}

/** Директен потребител (без authStore) — за миграционните копия. */
function insertRawUser(database: SqliteDatabase, label: string): { profileId: string; accountId: string; createdAt: string } {
  const accountId = randomUUID()
  const profileId = randomUUID()
  const name = `${label}${Math.floor(Math.random() * 1e9)}`
  database.prepare('INSERT INTO accounts (account_id, email, password_hash) VALUES (?, ?, ?);').run(accountId, `${name.toLowerCase()}@example.test`, createPasswordHash(PASSWORD))
  database.prepare('INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, username, normalized_username) VALUES (?, ?, ?, ?, ?, ?);')
    .run(profileId, accountId, name, name.toLowerCase(), name.toLowerCase(), name.toLowerCase())
  const createdAt = (database.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(profileId) as { created_at: string }).created_at
  return { profileId, accountId, createdAt }
}

try {
  // ═══ [M] Миграция ════════════════════════════════════════════════════════
  console.log('\n[M] Миграция 20261102_001 върху временни копия')

  await check('[M1] Копие отпреди 4G (историческа 45-дневна чакаща): 4G + 4J се прилагат, заявката е непроменена, интегритет и външни ключове', async () => {
    const root = await makeRoot('belot-4j-pre4g-', (name) => name < MIGRATION_4G)
    const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
    const pre = openDb(databaseFilePath)
    const user = insertRawUser(pre, 'Pre4g')
    const requestedAt = dbNow(pre)
    const requestId = randomUUID()
    withTriggerDropped(pre, 'trg_profile_deletion_requests_insert_guard', () => {
      pre.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for) VALUES (?, ?, ?, ?, ?, ?);`)
        .run(requestId, user.profileId, user.accountId, user.createdAt, requestedAt, isoPlus(requestedAt, FORTY_FIVE_DAYS_MS))
    })
    const before = pre.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
    pre.close()
    for (const name of [MIGRATION_4G, MIGRATION_4J]) await cp(join(sourceServerRoot, 'database', 'migrations', name), join(root, 'database', 'migrations', name))
    await ensureServerDatabaseReady({ serverRootOverride: root })
    const post = openDb(databaseFilePath)
    try {
      for (const name of [MIGRATION_4G, MIGRATION_4J]) assert(post.prepare('SELECT 1 FROM server_migrations WHERE filename = ?;').get(name) !== undefined, `не е записана ${name}`)
      assertEqual((post.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check, 'ok', 'integrity_check')
      assertEqual((post.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
      const after = post.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
      for (const [column, value] of Object.entries(before)) assertEqual(after[column], value, column)
      assertEqual(Number(after.grace_period_days), 45, 'grace_period_days')
      for (const name of ['profile_deletion_admin_cancellations', 'trg_profile_deletion_admin_cancellations_insert_guard', 'trg_profile_deletion_admin_cancellations_no_update', 'trg_profile_deletion_admin_cancellations_no_delete', 'trg_profile_deletion_requests_status_transition']) {
        assert(post.prepare('SELECT 1 FROM sqlite_master WHERE name = ?;').get(name) !== undefined, `липсва ${name}`)
      }
    } finally {
      post.close()
    }
  })

  await check('[M2] Копие след 4G, отпреди 4J (30-дневна чакаща, отменена): 4J не променя нито един ред; поведението без одитен ред е както преди', async () => {
    const root = await makeRoot('belot-4j-post4g-', (name) => name < MIGRATION_4J)
    const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
    const pre = openDb(databaseFilePath)
    const a = insertRawUser(pre, 'Post4gA')
    const b = insertRawUser(pre, 'Post4gB')
    const store = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
    const pending = store.createRequest({ profileId: a.profileId, accountId: a.accountId })
    const toCancel = store.createRequest({ profileId: b.profileId, accountId: b.accountId })
    assert(pending.ok && toCancel.ok, 'заявки')
    const token = store.issueRestoreToken(b.profileId)
    assert(token.ok && store.cancelWithToken(token.ok ? token.restoreToken : '').ok, 'отмяна')
    store.close()
    const hashes = ['profile_deletion_requests', 'profile_deletion_events', 'profile_deletion_restore_tokens', 'accounts', 'profiles'].map((t) => `${t}:${tableHash(pre, t)}`).join('|')
    pre.close()
    await cp(join(sourceServerRoot, 'database', 'migrations', MIGRATION_4J), join(root, 'database', 'migrations', MIGRATION_4J))
    await ensureServerDatabaseReady({ serverRootOverride: root })
    const post = openDb(databaseFilePath)
    try {
      assert(post.prepare('SELECT 1 FROM server_migrations WHERE filename = ?;').get(MIGRATION_4J) !== undefined, 'server_migrations')
      assertEqual((post.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check, 'ok', 'integrity_check')
      assertEqual((post.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
      assertEqual(['profile_deletion_requests', 'profile_deletion_events', 'profile_deletion_restore_tokens', 'accounts', 'profiles'].map((t) => `${t}:${tableHash(post, t)}`).join('|'), hashes, 'редовете са променени')
      const pendingId = pending.ok ? pending.request.requestId : ''
      // Без одитен ред: pending -> blocked/failed/completed остават забранени,
      // pending -> executing преди срока — not_due.
      assertRejects(() => post.prepare(`UPDATE profile_deletion_requests SET status = 'completed' WHERE request_id = ?;`).run(pendingId), 'profile_deletion_invalid_status_transition', 'pending -> completed')
      assertRejects(() => post.prepare(`UPDATE profile_deletion_requests SET status = 'executing', lease_owner = 'w', lease_expires_at = ? WHERE request_id = ?;`).run(isoPlus(dbNow(post), 60_000), pendingId), 'profile_deletion_not_due', 'not_due')
    } finally {
      post.close()
    }
  })

  // ═══ Основна временна база (всички миграции) ═════════════════════════════
  const root = await makeRoot('belot-4j-main-', () => true)
  const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const db = openDb(databaseFilePath)
  closers.push(() => db.close())
  const progressStore = await createPlayerProgressStore(databaseFilePath)
  closers.push(() => progressStore.close())
  const authStore = await createAuthStore(databaseFilePath, progressStore, {
    registrationVerificationCodeSecret: SECRET,
    getRegistrationVerificationMode: () => 'direct',
    getActiveBanForProfile: () => null,
  })
  closers.push(() => authStore.close())
  const requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
  closers.push(() => requestStore.close())
  const executor = await createProfileDeletionExecutor(databaseFilePath)
  closers.push(() => executor.close())
  const adminStore = await createProfileDeletionAdminStore(databaseFilePath)
  closers.push(() => adminStore.close())
  const adminStore2 = await createProfileDeletionAdminStore(databaseFilePath)
  closers.push(() => adminStore2.close())

  const uploadsRoot = join(root, 'uploads')
  const roots: ProfileDeletionUploadRoots = {
    avatars: join(uploadsRoot, 'avatars'),
    profileGallery: join(uploadsRoot, 'profile-gallery'),
    chatAttachments: join(uploadsRoot, 'chat-attachments'),
    topicAttachments: join(uploadsRoot, 'topic-attachments'),
    topicMuteEvidenceAttachments: join(uploadsRoot, 'topic-mute-evidence-attachments'),
    supportAttachments: join(uploadsRoot, 'support-attachments'),
  }
  for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })
  const ledgerPath = join(root, 'deletion-ledger', 'profile-deletions.jsonl')
  const ackPath = getProfileDeletionLedgerOffsiteAckPath(ledgerPath)

  function ackLedger(): void {
    const buffer = readFileSync(ledgerPath)
    const parsed = readProfileDeletionLedger(ledgerPath)
    writeProfileDeletionLedgerOffsiteAck(ackPath, {
      v: 1,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      lineCount: parsed.lineCount,
      entryCount: parsed.records.length,
      remotePath: 'test-offsite:/admin-oversight/profile-deletions.jsonl',
      confirmedAt: new Date().toISOString(),
    })
  }

  type User = { profileId: string; accountId: string; email: string; displayName: string; username: string }
  let counter = 0
  function registerUser(label: string): User {
    counter += 1
    const email = `adm4j-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `Adm4j${label}${counter}`
    const result = authStore.register({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
    const profileId = result.session.profile.profileId as string
    const username = (db.prepare('SELECT username FROM profiles WHERE profile_id = ?;').get(profileId) as { username: string }).username
    return { profileId, accountId: result.session.account.accountId, email, displayName, username }
  }
  const createdAtOf = (user: User) => (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at

  /** Заявка с произволен срок (тригерът за подаване временно изключен — само тестовата база). */
  function insertRequest(user: User, options: { scheduledFor: string; grace: 30 | 45 }): string {
    const requestId = randomUUID()
    const durationMs = options.grace === 30 ? PROFILE_DELETION_GRACE_PERIOD_MS : FORTY_FIVE_DAYS_MS
    withTriggerDropped(db, 'trg_profile_deletion_requests_insert_guard', () => {
      db.prepare(`
        INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days)
        VALUES (?, ?, ?, ?, ?, ?, ?);
      `).run(requestId, user.profileId, user.accountId, createdAtOf(user), isoPlus(options.scheduledFor, -durationMs), options.scheduledFor, options.grace)
    })
    return requestId
  }
  const overdue = (user: User, grace: 30 | 45 = 30) => insertRequest(user, { scheduledFor: isoPlus(dbNow(db), -60_000), grace })
  const requestRow = (requestId: string) => db.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, any>
  const profileExists = (profileId: string) => db.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(profileId) !== undefined
  const makeRetryDue = (requestId: string) => db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(db), -1000), requestId)

  type WorkerOptions = { ledger?: 'normal' | 'throw'; activeGame?: boolean; removeFile?: (path: string) => Promise<void> | void }
  function makeWorker(onlyRequestIds: string[] | undefined, options: WorkerOptions = {}) {
    return createProfileDeletionWorker({
      executor,
      workerId: `test-worker-${randomUUID().slice(0, 6)}`,
      uploadRoots: roots,
      removeFile: options.removeFile ?? (async () => {}),
      appendLedgerEntry: options.ledger === 'throw'
        ? () => { throw new Error('disk full') }
        : (entry) => { ensureProfileDeletionLedgerEntry(ledgerPath, entry) },
      isLedgerEntryConfirmedOffsite: (requestId) => isProfileDeletionLedgerRequestConfirmedOffsite(ledgerPath, requestId),
      isProfileInActiveGameLocally: () => options.activeGame === true,
      ...(onlyRequestIds !== undefined ? { onlyRequestIds } : {}),
    } as Parameters<typeof createProfileDeletionWorker>[0])
  }

  const admin = registerUser('Admin')
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)
  const REASON = 'Потребителят се обади в поддръжката и потвърди, че иска да запази профила.'

  function cancel(store: ProfileDeletionAdminStore, requestId: string, extra: { reason?: string; actor?: User; beforeCommit?: () => void; ledgerPath?: string } = {}) {
    const actor = extra.actor ?? admin
    return store.cancelVoluntaryRequestByAdmin({
      requestId,
      actorProfileId: actor.profileId,
      actorAccountId: actor.accountId,
      reason: 'reason' in extra ? extra.reason as string : REASON,
      loadLedger: () => loadProfileDeletionLedgerView(extra.ledgerPath ?? ledgerPath),
      ...(extra.beforeCommit !== undefined ? { beforeCommit: extra.beforeCommit } : {}),
    })
  }
  const ledgerBytes = () => (existsSync(ledgerPath) ? createHash('sha256').update(readFileSync(ledgerPath)).digest('hex') : 'missing')
  const stateFingerprint = () => ['profile_deletion_requests', 'profile_deletion_events', 'profile_deletion_admin_cancellations', 'account_sessions', 'profiles', 'profile_bans']
    .map((t) => `${t}:${tableHash(db, t)}`).join('|') + `|ledger:${ledgerBytes()}`
  const list = (input: { kind?: 'voluntary' | 'admin' | null; category?: any; limit?: number } = {}) =>
    adminStore.listOverview({ ...input, ledger: loadProfileDeletionLedgerView(ledgerPath) })
  const rowFor = (operationId: string): ProfileDeletionAdminRow | undefined => list().find((row) => row.operationId === operationId)

  // ─── Сценарии ────────────────────────────────────────────────────────────
  const uWindow = registerUser('Window')
  const created = requestStore.createRequest({ profileId: uWindow.profileId, accountId: uWindow.accountId })
  assert(created.ok, 'createRequest')
  const windowId = created.ok ? created.request.requestId : ''

  const uLegacy = registerUser('Legacy')
  const legacyId = insertRequest(uLegacy, { scheduledFor: isoPlus(dbNow(db), 10 * DAY_MS), grace: 45 })

  const uOverdue = registerUser('Overdue')
  const overdueId = overdue(uOverdue)

  const uLocalGame = registerUser('LocalGame')
  const localGameId = overdue(uLocalGame)
  await makeWorker([localGameId], { activeGame: true }).runOnce()

  const uLedgerFail = registerUser('LedgerFail')
  const ledgerFailId = overdue(uLedgerFail)
  await makeWorker([ledgerFailId], { ledger: 'throw' }).runOnce()

  const uOffsite = registerUser('Offsite')
  const offsiteId = overdue(uOffsite)
  await makeWorker([offsiteId]).runOnce()

  const uBan = registerUser('Ban')
  const banId = overdue(uBan)
  db.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason) VALUES (?, ?, datetime('now', '+5 days'), 'тест');`).run(randomUUID(), uBan.profileId)
  ensureProfileDeletionLedgerEntry(ledgerPath, (() => {
    const row = requestRow(banId)
    return { v: 1 as const, requestId: banId, profileId: uBan.profileId, accountIdSnapshot: row.account_id_snapshot, profileCreatedAtSnapshot: row.profile_created_at_snapshot, requestedAt: row.requested_at, scheduledFor: row.scheduled_for, recordedAt: new Date().toISOString() }
  })())
  ackLedger()
  await makeWorker([banId]).runOnce()

  const uFiles = registerUser('Files')
  db.prepare(`UPDATE profiles SET avatar_url = '/uploads/avatars/adm4j-secret-avatar.png' WHERE profile_id = ?;`).run(uFiles.profileId)
  writeFileSync(join(roots.avatars, 'adm4j-secret-avatar.png'), 'x')
  const filesId = overdue(uFiles)
  await makeWorker([filesId]).runOnce() // регистър -> offsite_pending
  ackLedger()
  makeRetryDue(filesId)
  await makeWorker([filesId], { removeFile: () => { throw new Error('EBUSY') } }).runOnce()

  const uDone = registerUser('Done')
  const doneId = overdue(uDone)
  await makeWorker([doneId]).runOnce()
  ackLedger()
  makeRetryDue(doneId)
  await makeWorker([doneId]).runOnce()

  const uUserCancelled = registerUser('UserCancelled')
  const userCancelledReq = requestStore.createRequest({ profileId: uUserCancelled.profileId, accountId: uUserCancelled.accountId })
  const userCancelledId = userCancelledReq.ok ? userCancelledReq.request.requestId : ''
  const tok = requestStore.issueRestoreToken(uUserCancelled.profileId)
  assert(tok.ok && requestStore.cancelWithToken(tok.ok ? tok.restoreToken : '').ok, 'потребителска отмяна')

  const uExecuting = registerUser('Executing')
  const executingId = overdue(uExecuting)
  const claimed = executor.claimNextDueRequest('held-worker', executingId)
  assert(claimed !== null, 'claim')

  // Административни операции: висяща и приключила (само преглед).
  const uAdminTarget = registerUser('AdminTarget')
  const adminPendingOpId = randomUUID()
  db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, requested_by_profile_id, requested_by_account_id, reason, ledger_operation_id) VALUES (?, ?, 'delete', ?, ?, 'тест', ?);`)
    .run(randomUUID(), uAdminTarget.profileId, admin.profileId, admin.accountId, adminPendingOpId)
  const adminDoneLogId = randomUUID()
  db.prepare(`INSERT INTO admin_profile_deletions (log_id, deleted_profile_id, deleted_account_id, username_snapshot, deleted_by_profile_id, reason) VALUES (?, ?, ?, 'adm4j-deleted-username-secret', ?, 'тест');`)
    .run(adminDoneLogId, randomUUID(), randomUUID(), admin.profileId)

  // ═══ [L] Преглед ═══════════════════════════════════════════════════════
  console.log('\n[L] Преглед')

  await check('[L1] Категориите следват реалните статуси (в срока, след срока, участие, неуспешен регистър, offsite, бан, изпълнение, файлове, приключена, отменена, административни)', () => {
    const expected: Array<[string, string, string]> = [
      [windowId, 'pending_cancellable', 'voluntary'],
      [legacyId, 'pending_cancellable', 'voluntary'],
      [overdueId, 'pending_overdue', 'voluntary'],
      [localGameId, 'blocked_participation', 'voluntary'],
      [ledgerFailId, 'failed', 'voluntary'],
      [offsiteId, 'awaiting_offsite', 'voluntary'],
      [banId, 'blocked_ban', 'voluntary'],
      [executingId, 'executing', 'voluntary'],
      [filesId, 'files_pending', 'voluntary'],
      [doneId, 'completed', 'voluntary'],
      [userCancelledId, 'cancelled', 'voluntary'],
      [adminPendingOpId, 'admin_scheduled', 'admin'],
      [adminDoneLogId, 'completed', 'admin'],
    ]
    for (const [id, category, kind] of expected) {
      const row = rowFor(id)
      assert(row !== undefined, `липсва ${category}`)
      assertEqual(row!.category, category, `категория ${id}`)
      assertEqual(row!.kind, kind, `вид ${id}`)
    }
    assertEqual(rowFor(legacyId)!.gracePeriodDays, 45, 'историческа 45')
    assertEqual(rowFor(windowId)!.gracePeriodDays, 30, 'нова 30')
    assertEqual(rowFor(userCancelledId)!.cancelledBy, 'user', 'отменена от потребителя')
    assertEqual(rowFor(adminPendingOpId)!.awaitingOffsite, true, 'административно намерение без offsite потвърждение')
    assertEqual(rowFor(banId)!.lastErrorCode, 'active_ban', 'код на бана')
    assert(rowFor(filesId)!.filesPending >= 1 && rowFor(filesId)!.dbDeletedAt !== null, 'файлова фаза')
  })

  await check('[L2] Право на отмяна и причина за отказ на всеки ред (административните — само преглед)', () => {
    const expected: Array<[string, boolean, string | null]> = [
      [windowId, true, null], [legacyId, true, null], [overdueId, true, null], [localGameId, true, null], [ledgerFailId, true, null],
      [offsiteId, false, 'ledger_intent_recorded'], [banId, false, 'ledger_intent_recorded'], [executingId, false, 'lease_held'],
      [filesId, false, 'irreversible'], [doneId, false, 'irreversible'], [userCancelledId, false, 'status_not_cancellable'],
      [adminPendingOpId, false, 'not_voluntary'], [adminDoneLogId, false, 'not_voluntary'],
    ]
    for (const [id, canCancel, blocker] of expected) {
      const row = rowFor(id)!
      assertEqual(row.canCancel, canCancel, `canCancel ${row.category}`)
      assertEqual(row.cancelBlocker, blocker, `blocker ${row.category}`)
    }
  })

  await check('[L3] Поверителност: изтрит профил — без профил/име/имейл/username snapshot; без файлови пътища, IP, visitor ID, токени', () => {
    const json = JSON.stringify(list())
    assertEqual(rowFor(doneId)!.profile, null, 'приключена: профил')
    assertEqual(rowFor(filesId)!.profile, null, 'файлова фаза: профил')
    assertEqual(rowFor(adminDoneLogId)!.profile, null, 'административно приключена: профил')
    for (const secret of [uDone.displayName, uDone.email, uDone.username, uFiles.displayName, uFiles.email, 'adm4j-deleted-username-secret', 'adm4j-secret-avatar', '/uploads/', 'visitor', 'password', 'token', 'ip_address', uDone.accountId]) {
      assert(!json.includes(secret), `изтича: ${secret}`)
    }
    // Жив профил се показва (само ID + текущо име).
    const live = rowFor(windowId)!.profile
    assert(live !== null && live.profileId === uWindow.profileId && live.displayName === uWindow.displayName, 'жив профил')
    assert(!json.includes(uWindow.email), 'имейл на жив профил')
    assertEqual(Object.keys(rowFor(windowId)!).includes('email'), false, 'поле email')
  })

  await check('[L4] Лимит 300 в SQL, най-новите първи, филтри по вид и статус', () => {
    const insert = db.prepare(`INSERT INTO admin_profile_deletions (log_id, deleted_profile_id, username_snapshot, reason, deleted_at, file_cleanup_status) VALUES (?, ?, 'bulk-secret', 'bulk', ?, 'done');`)
    for (let i = 0; i < 310; i += 1) insert.run(`bulk-${String(i).padStart(4, '0')}`, randomUUID(), new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString().replace('T', ' ').slice(0, 19))
    const all = list()
    assertEqual(all.length, PROFILE_DELETION_ADMIN_LIST_MAX, 'лимит')
    assertEqual(list({ limit: 5000 }).length, PROFILE_DELETION_ADMIN_LIST_MAX, 'по-голям лимит не минава')
    for (let i = 1; i < all.length; i += 1) {
      const prev = all[i - 1]!.requestedAt ?? all[i - 1]!.completedAt ?? ''
      const cur = all[i]!.requestedAt ?? all[i]!.completedAt ?? ''
      assert(prev >= cur, `подреждане ${i}: ${prev} < ${cur}`)
    }
    assert(all.some((row) => row.operationId === windowId), 'най-новата заявка е в първите 300')
    assert(!all.some((row) => row.operationId === 'bulk-0000'), 'най-старата е извън лимита')
    const voluntary = list({ kind: 'voluntary' })
    assert(voluntary.length > 0 && voluntary.every((row) => row.kind === 'voluntary'), 'филтър voluntary')
    const adminOnly = list({ kind: 'admin' })
    assert(adminOnly.length === PROFILE_DELETION_ADMIN_LIST_MAX && adminOnly.every((row) => row.kind === 'admin'), 'филтър admin (+ лимит)')
    const offsiteRows = list({ category: 'awaiting_offsite' })
    assert(offsiteRows.length === 1 && offsiteRows[0]!.operationId === offsiteId, 'филтър по статус')
    assert(!JSON.stringify(all).includes('bulk-secret'), 'username_snapshot')
  })

  // ═══ [C] Отмяна ════════════════════════════════════════════════════════
  console.log('\n[C] Отмяна от администратор')

  await check('[C1] Невалидна причина (липсва, празна, само интервали, > 500 знака, не-текст) -> invalid_reason, нищо не се променя', () => {
    const before = stateFingerprint()
    for (const reason of ['', '   \n\t ', 'x'.repeat(501), undefined as unknown as string, 42 as unknown as string]) {
      const result = cancel(adminStore, windowId, { reason })
      assert(!result.ok && result.code === 'invalid_reason', `${JSON.stringify(reason)?.slice(0, 20)}: ${JSON.stringify(result)}`)
    }
    assertEqual(stateFingerprint(), before, 'състояние')
  })

  await check('[C2] Отнета/липсваща администраторска роля по базата (subadmin, player, чужд профил) -> forbidden, нищо не се променя', () => {
    const before = stateFingerprint()
    for (const role of ['subadmin', 'pika_team', 'marketing', 'top_chat_admin', 'chat_admin', 'player']) {
      db.prepare('UPDATE accounts SET role = ? WHERE account_id = ?;').run(role, admin.accountId)
      const result = cancel(adminStore, windowId)
      assert(!result.ok && result.code === 'forbidden', `${role}: ${JSON.stringify(result)}`)
      assertEqual(adminStore.isActorAdmin(admin.accountId, admin.profileId), false, `${role}: isActorAdmin`)
    }
    db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)
    const foreign = cancel(adminStore, windowId, { actor: { ...admin, profileId: uWindow.profileId } })
    assert(!foreign.ok && foreign.code === 'forbidden', `чужд профил: ${JSON.stringify(foreign)}`)
    assertEqual(stateFingerprint(), before, 'състояние')
  })

  await check('[C3] Заявка в срока: отмяна с причина — статус, одит (актьор, причина, предишен статус), събитие admin; без сесия; регистърът не се пипа', () => {
    const ledgerBefore = ledgerBytes()
    const result = cancel(adminStore, windowId, { reason: `  ${REASON}\u0007  ` })
    assert(result.ok, JSON.stringify(result))
    const row = requestRow(windowId)
    assertEqual(row.status, 'cancelled', 'статус')
    assert(row.cancelled_at !== null && row.lease_owner === null && row.next_attempt_at === null, 'полета')
    const audit = db.prepare('SELECT * FROM profile_deletion_admin_cancellations WHERE request_id = ?;').get(windowId) as Record<string, any>
    assertEqual(audit.reason, REASON, 'причина (изчистена)')
    assertEqual(audit.actor_profile_id, admin.profileId, 'актьор профил')
    assertEqual(audit.actor_account_id, admin.accountId, 'актьор акаунт')
    assertEqual(audit.previous_status, 'pending', 'предишен статус')
    const event = db.prepare(`SELECT * FROM profile_deletion_events WHERE request_id = ? AND event_type = 'cancelled';`).get(windowId) as Record<string, any>
    assertEqual(event.actor_kind, 'admin', 'actor_kind')
    assert(!String(event.detail_json).includes(REASON), 'причината не се дублира в журнала')
    assertEqual(Number((db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE profile_id = ? AND revoked_at IS NULL;').get(uWindow.profileId) as { c: number }).c), 0, 'активна сесия')
    assertEqual(ledgerBytes(), ledgerBefore, 'регистър')
    const listed = rowFor(windowId)!
    assert(listed.category === 'cancelled' && listed.cancelledBy === 'admin' && listed.adminCancellation?.reason === REASON && listed.adminCancellation.actorDisplayName === admin.displayName, `в прегледа: ${JSON.stringify(listed)}`)
  })

  await check('[C4] Историческа 45-дневна заявка: отмяната е разрешена', () => {
    const result = cancel(adminStore, legacyId)
    assert(result.ok, JSON.stringify(result))
    assertEqual(requestRow(legacyId).status, 'cancelled', 'статус')
    assertEqual(Number(requestRow(legacyId).grace_period_days), 45, 'срокът не е пипан')
  })

  await check('[C5] След 30-дневния срок: потребителят НЕ може (функция + тригер), администраторът може (само с одитен ред в същата транзакция)', async () => {
    const user = registerUser('Deadline')
    const requestId = insertRequest(user, { scheduledFor: isoPlus(dbNow(db), 2500), grace: 30 })
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok, 'токен преди срока')
    await new Promise((r) => setTimeout(r, 3000))
    const userCancel = requestStore.cancelWithToken(issued.ok ? issued.restoreToken : '')
    assert(!userCancel.ok && userCancel.code === 'window_closed', `потребител: ${JSON.stringify(userCancel)}`)
    assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = ? WHERE request_id = ?;`).run(dbNow(db), requestId), 'profile_deletion_cancel_window_closed', 'тригер без одит')
    assertEqual(requestRow(requestId).status, 'pending', 'непроменена')
    const result = cancel(adminStore, overdueId)
    assert(result.ok, `админ: ${JSON.stringify(result)}`)
    const adminAfterDeadline = cancel(adminStore, requestId)
    assert(adminAfterDeadline.ok, `админ след срока: ${JSON.stringify(adminAfterDeadline)}`)
  })

  await check('[C6] Блокирана преди регистъра (активна игра в процеса) и неуспешен запис в регистъра: отмяната е разрешена (няма намерение в регистъра)', () => {
    assert(readProfileDeletionLedger(ledgerPath).entries.every((e) => e.requestId !== localGameId && e.requestId !== ledgerFailId), 'няма запис')
    const a = cancel(adminStore, localGameId)
    const b = cancel(adminStore, ledgerFailId)
    assert(a.ok && b.ok, `${JSON.stringify(a)} ${JSON.stringify(b)}`)
    const auditA = db.prepare('SELECT previous_status FROM profile_deletion_admin_cancellations WHERE request_id = ?;').get(localGameId) as { previous_status: string }
    const auditB = db.prepare('SELECT previous_status FROM profile_deletion_admin_cancellations WHERE request_id = ?;').get(ledgerFailId) as { previous_status: string }
    assert(auditA.previous_status === 'blocked' && auditB.previous_status === 'failed', 'предишни статуси')
  })

  await check('[C7] Бан след регистъра и чакащо offsite потвърждение: намерението е в регистъра -> отказ ledger_intent_recorded, без никаква промяна (вкл. регистъра)', () => {
    const before = stateFingerprint()
    for (const requestId of [banId, offsiteId]) {
      const result = cancel(adminStore, requestId)
      assert(!result.ok && result.code === 'ledger_intent_recorded', `${requestId}: ${JSON.stringify(result)}`)
    }
    assertEqual(stateFingerprint(), before, 'състояние')
    // Offsite потвърждението пристига — пак отказ (намерението е необратимо потвърдено).
    ackLedger()
    const again = cancel(adminStore, offsiteId)
    assert(!again.ok && again.code === 'ledger_intent_recorded', JSON.stringify(again))
  })

  await check('[C8] Активен lease, файлова фаза, приключена, вече отменена от потребителя, административна операция, непозната -> отказ без промяна', () => {
    const before = stateFingerprint()
    const expectations: Array<[string, string]> = [
      [executingId, 'lease_held'], [filesId, 'irreversible'], [doneId, 'irreversible'], [userCancelledId, 'status_not_cancellable'],
      [adminDoneLogId, 'not_found'], [adminPendingOpId, 'not_found'], [randomUUID(), 'not_found'],
    ]
    for (const [requestId, code] of expectations) {
      const result = cancel(adminStore, requestId)
      assert(!result.ok && result.code === code, `${code}: ${JSON.stringify(result)}`)
    }
    assertEqual(stateFingerprint(), before, 'състояние')
    assert(!profileExists(uDone.profileId), 'изтритият профил не се възстановява')
  })

  await check('[C9] Регистърът не може да бъде проверен -> отказ ledger_unavailable (повреден ред; липсващ файл при вече взимана заявка); следа от недовършен запис -> отказ', () => {
    const user = registerUser('LedgerCheck')
    const requestId = overdue(user)
    const corruptPath = join(root, 'corrupt-ledger', 'profile-deletions.jsonl')
    return (async () => {
      await mkdir(join(root, 'corrupt-ledger'), { recursive: true })
      writeFileSync(corruptPath, 'not json\n')
      const corrupt = cancel(adminStore, requestId, { ledgerPath: corruptPath })
      assert(!corrupt.ok && corrupt.code === 'ledger_unavailable', `повреден: ${JSON.stringify(corrupt)}`)
      const listedCorrupt = adminStore.listOverview({ ledger: loadProfileDeletionLedgerView(corruptPath) }).find((row) => row.operationId === requestId)!
      assertEqual(listedCorrupt.cancelBlocker, 'ledger_unavailable', 'в прегледа')
      // Липсващ регистър: заявка, която worker-ът вече е взимал -> не може да се докаже.
      makeRetryDue(requestId)
      await makeWorker([requestId], { activeGame: true }).runOnce()
      const missingPath = join(root, 'missing-ledger', 'profile-deletions.jsonl')
      const missing = cancel(adminStore, requestId, { ledgerPath: missingPath })
      assert(!missing.ok && missing.code === 'ledger_unavailable', `липсващ: ${JSON.stringify(missing)}`)
      // Недовършен (без '\n') ред, съдържащ requestId-то.
      const partialPath = join(root, 'corrupt-ledger', 'partial.jsonl')
      writeFileSync(partialPath, `{"v":1,"requestId":"${requestId}","profileId":"`)
      const partial = cancel(adminStore, requestId, { ledgerPath: partialPath })
      assert(!partial.ok && partial.code === 'ledger_intent_recorded', `недовършен: ${JSON.stringify(partial)}`)
      assertEqual(requestRow(requestId).status, 'blocked', 'статус')
      // Липсващ регистър и никога невзимана заявка -> доказано без запис.
      const fresh = registerUser('NeverClaimed')
      const freshId = overdue(fresh)
      const ok = cancel(adminStore, freshId, { ledgerPath: missingPath })
      assert(ok.ok, `невзимана: ${JSON.stringify(ok)}`)
      // Почистване: основната заявка се отменя с реалния регистър.
      assert(cancel(adminStore, requestId).ok, 'отмяна с реалния регистър')
    })()
  })

  // ═══ [R] Състезания ════════════════════════════════════════════════════
  console.log('\n[R] Състезания и атомарност')

  await check('[R1] Две едновременни отмени: втората чака writer lock-а и после получава status_not_cancellable; точно един одитен ред и едно събитие', () => {
    const user = registerUser('Concurrent')
    const requestId = overdue(user)
    let lockHeld = false
    let second: ReturnType<typeof cancel> | null = null
    const probe = openDb(databaseFilePath)
    probe.exec('PRAGMA busy_timeout = 0;')
    const first = cancel(adminStore, requestId, {
      beforeCommit: () => {
        try { probe.exec('BEGIN IMMEDIATE;'); probe.exec('ROLLBACK;') } catch (error) { lockHeld = String(error).includes('locked') || String(error).includes('busy') }
      },
    })
    probe.close()
    second = cancel(adminStore2, requestId, { reason: 'Втори администратор' })
    assert(first.ok, `първа: ${JSON.stringify(first)}`)
    assert(lockHeld, 'writer lock-ът не е държан до COMMIT')
    assert(!second.ok && second.code === 'status_not_cancellable', `втора: ${JSON.stringify(second)}`)
    assertEqual(Number((db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_admin_cancellations WHERE request_id = ?;').get(requestId) as { c: number }).c), 1, 'одитни редове')
    assertEqual(Number((db.prepare(`SELECT COUNT(*) AS c FROM profile_deletion_events WHERE request_id = ? AND event_type = 'cancelled';`).get(requestId) as { c: number }).c), 1, 'събития')
  })

  await check('[R2] Отмяна срещу claim на worker-а: по време на отмяната worker-ът не може да вземе заявката; след COMMIT тя не е изпълнима — регистърът остава без запис', async () => {
    const user = registerUser('CancelVsClaim')
    const requestId = overdue(user)
    let claimDuringCancel: unknown = 'not-run'
    const workerDb = openDb(databaseFilePath)
    workerDb.exec('PRAGMA busy_timeout = 0;')
    const result = cancel(adminStore, requestId, {
      beforeCommit: () => {
        try {
          workerDb.prepare(`UPDATE profile_deletion_requests SET status = 'executing', lease_owner = 'w', lease_expires_at = ? WHERE request_id = ?;`).run(isoPlus(new Date().toISOString(), 60_000), requestId)
          claimDuringCancel = 'claimed'
        } catch (error) {
          claimDuringCancel = String(error)
        }
      },
    })
    workerDb.close()
    assert(result.ok, JSON.stringify(result))
    assert(typeof claimDuringCancel === 'string' && /locked|busy/i.test(claimDuringCancel), `claim по време на отмяната: ${claimDuringCancel}`)
    const summary = await makeWorker([requestId]).runOnce()
    assertEqual(summary.claimed, 0, 'worker взе отменена заявка')
    assertEqual(requestRow(requestId).status, 'cancelled', 'статус')
    assert(!readProfileDeletionLedger(ledgerPath).entries.some((e) => e.requestId === requestId), 'запис в регистъра')
    assert(profileExists(user.profileId), 'профилът е запазен')
  })

  await check('[R3] Worker срещу отмяна: worker-ът взема първи (lease) -> отказ lease_held; след записа в регистъра -> отказ ledger_intent_recorded', async () => {
    const user = registerUser('ClaimVsCancel')
    const requestId = overdue(user)
    const claimedRow = executor.claimNextDueRequest('race-worker', requestId)
    assert(claimedRow !== null, 'claim')
    const duringLease = cancel(adminStore, requestId)
    assert(!duringLease.ok && duringLease.code === 'lease_held', JSON.stringify(duringLease))
    // Worker-ът продължава: записва в регистъра, чака offsite -> blocked.
    ensureProfileDeletionLedgerEntry(ledgerPath, {
      v: 1, requestId, profileId: user.profileId, accountIdSnapshot: claimedRow!.accountIdSnapshot, profileCreatedAtSnapshot: claimedRow!.profileCreatedAtSnapshot,
      requestedAt: claimedRow!.requestedAt, scheduledFor: claimedRow!.scheduledFor, recordedAt: new Date().toISOString(),
    })
    executor.blockRequest(requestId, 'race-worker', 'ledger_offsite_pending')
    const after = cancel(adminStore, requestId)
    assert(!after.ok && after.code === 'ledger_intent_recorded', JSON.stringify(after))
    assertEqual(requestRow(requestId).status, 'blocked', 'статус')
  })

  await check('[R4] Грешка в базата преди COMMIT: всичко се връща (статус, одит, събитие, сесии, регистър)', () => {
    const user = registerUser('DbError')
    const requestId = overdue(user)
    const before = stateFingerprint()
    let thrown = false
    try {
      cancel(adminStore, requestId, { beforeCommit: () => { throw new Error('simulated disk I/O error') } })
    } catch {
      thrown = true
    }
    assert(thrown, 'грешката не е предадена')
    assertEqual(stateFingerprint(), before, 'частична промяна')
    assertEqual(requestRow(requestId).status, 'pending', 'статус')
    // Store-ът остава използваем след грешката.
    assert(cancel(adminStore, requestId).ok, 'повторен опит')
  })

  // ═══ [T] Тригери ═══════════════════════════════════════════════════════
  console.log('\n[T] Защити в базата')

  await check('[T1] Одитът е append-only; одитен ред само за отменима заявка (lease/статус/db_deleted); blocked -> cancelled без одит е забранено', () => {
    const anyAudit = db.prepare('SELECT cancellation_id FROM profile_deletion_admin_cancellations LIMIT 1;').get() as { cancellation_id: string }
    assertRejects(() => db.prepare(`UPDATE profile_deletion_admin_cancellations SET reason = 'x' WHERE cancellation_id = ?;`).run(anyAudit.cancellation_id), 'append_only', 'UPDATE')
    assertRejects(() => db.prepare('DELETE FROM profile_deletion_admin_cancellations WHERE cancellation_id = ?;').run(anyAudit.cancellation_id), 'append_only', 'DELETE')
    const insertAudit = (requestId: string, previous: string) => db.prepare(`INSERT INTO profile_deletion_admin_cancellations (cancellation_id, request_id, actor_profile_id, actor_account_id, reason, previous_status) VALUES (?, ?, ?, ?, 'r', ?);`)
      .run(randomUUID(), requestId, admin.profileId, admin.accountId, previous)
    assertRejects(() => insertAudit(executingId, 'pending'), 'profile_deletion_admin_cancellation_not_allowed', 'executing')
    assertRejects(() => insertAudit(filesId, 'failed'), 'profile_deletion_admin_cancellation_not_allowed', 'db_deleted')
    assertRejects(() => insertAudit(doneId, 'pending'), 'profile_deletion_admin_cancellation_not_allowed', 'completed')
    assertRejects(() => insertAudit(banId, 'pending'), 'profile_deletion_admin_cancellation_not_allowed', 'грешен предишен статус')
    assertRejects(() => db.prepare(`INSERT INTO profile_deletion_admin_cancellations (cancellation_id, request_id, actor_profile_id, actor_account_id, reason, previous_status) VALUES (?, ?, ?, ?, '   ', 'blocked');`).run(randomUUID(), banId, admin.profileId, admin.accountId), 'CHECK constraint failed', 'празна причина')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = ?, next_attempt_at = NULL WHERE request_id = ?;`).run(dbNow(db), banId), 'profile_deletion_invalid_status_transition', 'blocked -> cancelled без одит')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = ? WHERE request_id = ?;`).run(dbNow(db), doneId), 'profile_deletion_invalid_status_transition', 'completed -> cancelled')
    assertEqual(requestRow(banId).status, 'blocked', 'бан заявката')
  })

  await check('[T2] Необратимата граница: отмяна след db_deleted_at се отказва и с одитен ред (тригерът)', () => {
    // Временно премахнат insert guard само за да се провери вторият слой.
    withTriggerDropped(db, 'trg_profile_deletion_admin_cancellations_insert_guard', () => {
      db.exec('BEGIN;')
      try {
        db.prepare(`INSERT INTO profile_deletion_admin_cancellations (cancellation_id, request_id, actor_profile_id, actor_account_id, reason, previous_status) VALUES (?, ?, ?, ?, 'r', 'failed');`)
          .run(randomUUID(), filesId, admin.profileId, admin.accountId)
        assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = ?, next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE request_id = ?;`).run(dbNow(db), filesId), 'profile_deletion', 'cancel след db_deleted')
      } finally {
        db.exec('ROLLBACK;')
      }
    })
    assert(requestRow(filesId).db_deleted_at !== null && requestRow(filesId).status !== 'cancelled', 'статус')
  })

  // ═══ [W] Worker и restore ══════════════════════════════════════════════
  console.log('\n[W] Worker и restore')

  await check('[W1] Пълен цикъл на worker-а след административните отмени: нито една отменена заявка не е взета, профилите им съществуват', async () => {
    ackLedger()
    const cancelledIds = (db.prepare(`SELECT request_id, profile_id FROM profile_deletion_requests r WHERE EXISTS (SELECT 1 FROM profile_deletion_admin_cancellations a WHERE a.request_id = r.request_id);`).all() as Array<{ request_id: string; profile_id: string }>)
    assert(cancelledIds.length >= 7, `отменени: ${cancelledIds.length}`)
    db.prepare(`UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE status IN ('blocked', 'failed');`).run(isoPlus(dbNow(db), -1000))
    await makeWorker(undefined).runOnce()
    await makeWorker(undefined).runOnce()
    const ledgerIds = new Set(readProfileDeletionLedger(ledgerPath).entries.map((e) => e.requestId))
    for (const { request_id, profile_id } of cancelledIds) {
      assertEqual(requestRow(request_id).status, 'cancelled', 'статус')
      assert(profileExists(profile_id), `профилът ${profile_id} е изтрит`)
      assert(!ledgerIds.has(request_id), 'запис в регистъра за отменена заявка')
    }
  })

  await check('[W2] Restore на копие СЛЕД административната отмяна + reconcile --apply: профилът остава, заявката е отменена, одитът е налице', async () => {
    const copy = join(root, 'restore-after-cancel.sqlite')
    await mkdir(join(root, 'restored-uploads'), { recursive: true })
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}';`)
    const lines: string[] = []
    const code = await runProfileDeletionLedgerReconcile(
      [`--db=${copy}`, `--ledger=${ledgerPath}`, '--apply', `--confirm=${REAPPLY_CONFIRMATION_PHRASE}`, `--uploads-root=${join(root, 'restored-uploads')}`],
      { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    )
    assert(code === 0 || code === 1, `exit ${code}: ${lines.slice(-5).join(' | ')}`)
    const restored = new sqliteModule.DatabaseSync(copy, { readOnly: true })
    try {
      assert(restored.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(uWindow.profileId) !== undefined, 'профилът изчезна след restore')
      assertEqual((restored.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(windowId) as { status: string }).status, 'cancelled', 'статус')
      assert(restored.prepare('SELECT 1 FROM profile_deletion_admin_cancellations WHERE request_id = ?;').get(windowId) !== undefined, 'одит')
      assert(restored.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(uDone.profileId) === undefined, 'изтритият (по регистъра) се върна')
    } finally {
      restored.close()
    }
  })

  await check('[W3] Известно ограничение (документирано): отмяната не е в регистъра — копие ОТПРЕДИ отмяната възстановява чакащата заявка; reconcile не я изтрива', async () => {
    const user = registerUser('PreCancelBackup')
    const requestId = overdue(user)
    const copy = join(root, 'restore-before-cancel.sqlite')
    await mkdir(join(root, 'restored-uploads-2'), { recursive: true })
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}';`)
    assert(cancel(adminStore, requestId).ok, 'отмяна')
    const lines: string[] = []
    const code = await runProfileDeletionLedgerReconcile(
      [`--db=${copy}`, `--ledger=${ledgerPath}`, '--apply', `--confirm=${REAPPLY_CONFIRMATION_PHRASE}`, `--uploads-root=${join(root, 'restored-uploads-2')}`],
      { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    )
    assert(code === 0 || code === 1, `exit ${code}`)
    const restored = new sqliteModule.DatabaseSync(copy, { readOnly: true })
    try {
      assert(restored.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) !== undefined, 'reconcile изтри профил без запис в регистъра')
      assertEqual((restored.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string }).status, 'pending', 'ограничението вече не съществува — обнови доклада')
    } finally {
      restored.close()
    }
  })

  await check('[W4] Административните операции и защитите на регистъра са непокътнати: висящата операция и одитът ѝ са непроменени', () => {
    assert(db.prepare('SELECT 1 FROM pending_profile_moderation WHERE ledger_operation_id = ?;').get(adminPendingOpId) !== undefined, 'висящата операция')
    assert(db.prepare('SELECT 1 FROM admin_profile_deletions WHERE log_id = ?;').get(adminDoneLogId) !== undefined, 'одитът')
    const parsed = readProfileDeletionLedger(ledgerPath)
    assertEqual(parsed.invalidLineCount + parsed.conflictingDuplicateCount, 0, 'регистърът е валиден')
    assert(!readFileSync(ledgerPath, 'utf8').includes('cancel'), 'в регистъра има запис за отмяна')
  })

  await check('[W5] Интегритет и външни ключове на основната временна база', () => {
    assertEqual((db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check, 'ok', 'integrity_check')
    assertEqual((db.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
  })

  for (const close of closers.splice(0).reverse()) { try { close() } catch { /* ignore */ } }

  // ═══ [H] HTTP ══════════════════════════════════════════════════════════
  console.log('\n[H] HTTP през реален сървър (изолирано копие)')
  await runHttpPhase()
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const close of closers.splice(0).reverse()) { try { close() } catch { /* ignore */ } }
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

async function runHttpPhase(): Promise<void> {
  const getFreePort = async (): Promise<number> => await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })

  const isolatedRoot = await mkdtemp(join(tmpdir(), 'belot-4j-http-'))
  tempRoots.push(isolatedRoot)
  const serverDir = join(isolatedRoot, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(sourceServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(sourceServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(sourceServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(sourceServerRoot, '..', 'node_modules'), join(isolatedRoot, 'node_modules'), linkType)
  const ledgerPath = join(isolatedRoot, 'ledger', 'profile-deletions.jsonl')

  const bootstrap = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
  const db = openDb(bootstrap.databaseFilePath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()

  const port = await getFreePort()
  const base = `http://127.0.0.1:${port}`
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: SECRET,
    PROFILE_SELF_DELETION_ENABLED: '1',
    PROFILE_DELETION_LEDGER_PATH: ledgerPath,
  }
  delete env.PROFILE_SELF_DELETION_WORKER_ENABLED
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))

  try {
    const deadline = Date.now() + 90_000
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Сървърът спря:\n${chunks.join('').slice(-2000)}`)
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* not ready */ }
      if (Date.now() > deadline) throw new Error('Timeout: health')
      await new Promise((r) => setTimeout(r, 250))
    }

    async function api(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; json: any; text: string; setCookie: string; cacheControl: string }> {
      const res = await fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
      const text = await res.text()
      let json: any = null
      try { json = JSON.parse(text) } catch { json = text }
      return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') ?? '', cacheControl: res.headers.get('cache-control') ?? '' }
    }
    type HttpUser = { profileId: string; accountId: string; email: string; displayName: string; cookie: string }
    let n = 0
    async function register(label: string): Promise<HttpUser> {
      n += 1
      db.prepare(`DELETE FROM registration_rate_limit_events;`).run()
      const email = `adm4j-http-${label.toLowerCase()}-${n}@example.test`
      const displayName = `Adm4jH${label}${n}`
      const res = await api('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() } })
      if (res.status !== 200 || !res.json.ok) throw new Error(`регистрация ${label}: ${res.status} ${JSON.stringify(res.json)}`)
      return { profileId: res.json.session.profile.profileId, accountId: res.json.session.account.accountId, email, displayName, cookie: res.setCookie.split(';')[0]! }
    }
    const login = async (email: string) => {
      const res = await api('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } })
      return { ...res, cookie: res.setCookie.split(';')[0] ?? '' }
    }
    const submitDeletion = async (user: HttpUser) => {
      db.prepare(`DELETE FROM registration_rate_limit_events;`).run()
      return api('/api/account/deletion-request', { method: 'POST', cookie: user.cookie, body: { password: PASSWORD, confirm: true } })
    }
    const requestIdOf = (profileId: string) => (db.prepare(`SELECT request_id FROM profile_deletion_requests WHERE profile_id = ? ORDER BY requested_at DESC LIMIT 1;`).get(profileId) as { request_id: string }).request_id
    const statusOf = (requestId: string) => (db.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string }).status

    const adminUser = await register('Admin')
    db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(adminUser.accountId)
    const staff = await register('Staff')
    const player = await register('Player')
    const viewer = await register('Viewer')
    const target = await register('Target')
    assert((await submitDeletion(target)).status === 200, 'подаване target')
    const targetRequestId = requestIdOf(target.profileId)

    await check('[H1] Гост, играч и всички служебни роли без admin -> 403 за прегледа и отмяната; заявката не се променя', async () => {
      const guestList = await api('/api/admin/profile-deletions')
      assert(guestList.status === 403, `гост: ${guestList.status}`)
      const guestCancel = await api(`/api/admin/profile-deletions/${targetRequestId}/cancel`, { method: 'POST', body: { reason: 'x' } })
      assert(guestCancel.status === 403, `гост отмяна: ${guestCancel.status}`)
      const playerList = await api('/api/admin/profile-deletions', { cookie: player.cookie })
      assert(playerList.status === 403, `играч: ${playerList.status}`)
      for (const role of ['subadmin', 'pika_team', 'marketing', 'top_chat_admin', 'chat_admin']) {
        db.prepare('UPDATE accounts SET role = ? WHERE account_id = ?;').run(role, staff.accountId)
        const l = await api('/api/admin/profile-deletions', { cookie: staff.cookie })
        const c = await api(`/api/admin/profile-deletions/${targetRequestId}/cancel`, { method: 'POST', cookie: staff.cookie, body: { reason: 'Опит' } })
        assert(l.status === 403 && c.status === 403, `${role}: ${l.status}/${c.status}`)
        assert(!l.text.includes(target.displayName), `${role}: изтичане на данни`)
      }
      assertEqual(statusOf(targetRequestId), 'pending', 'статус')
    })

    await check('[H2] Admin: прегледът — 200, no-store, лимит 300, най-новите първи, филтри; невалиден филтър -> 400; без имейли и файлови пътища', async () => {
      const res = await api('/api/admin/profile-deletions', { cookie: adminUser.cookie })
      assert(res.status === 200 && res.json.ok === true && res.json.limit === 300, `${res.status} ${res.text.slice(0, 200)}`)
      assert(/no-store/.test(res.cacheControl), `Cache-Control: ${res.cacheControl}`)
      const row = (res.json.rows as ProfileDeletionAdminRow[]).find((r) => r.operationId === targetRequestId)
      assert(row !== undefined && row.category === 'pending_cancellable' && row.canCancel === true && row.profile?.displayName === target.displayName, JSON.stringify(row))
      assert(!res.text.includes(target.email) && !res.text.includes('/uploads/'), 'имейл/път')
      const filtered = await api('/api/admin/profile-deletions?kind=admin', { cookie: adminUser.cookie })
      assert(filtered.status === 200 && (filtered.json.rows as ProfileDeletionAdminRow[]).every((r) => r.kind === 'admin'), 'филтър kind')
      const byCategory = await api('/api/admin/profile-deletions?category=pending_cancellable', { cookie: adminUser.cookie })
      assert(byCategory.status === 200 && (byCategory.json.rows as ProfileDeletionAdminRow[]).every((r) => r.category === 'pending_cancellable'), 'филтър category')
      for (const bad of ['?kind=x', '?category=drop%20table', '?category=1']) {
        assert((await api(`/api/admin/profile-deletions${bad}`, { cookie: adminUser.cookie })).status === 400, `невалиден ${bad}`)
      }
      assert((await api('/api/admin/profile-deletions', { method: 'DELETE', cookie: adminUser.cookie })).status === 405, 'метод')
    })

    await check('[H3] Отнета роля преди потвърждението (admin -> subadmin в базата) -> 403, заявката не се променя', async () => {
      db.prepare(`UPDATE accounts SET role = 'subadmin' WHERE account_id = ?;`).run(adminUser.accountId)
      try {
        const res = await api(`/api/admin/profile-deletions/${targetRequestId}/cancel`, { method: 'POST', cookie: adminUser.cookie, body: { reason: REASON_HTTP } })
        assert(res.status === 403, `${res.status}`)
        assertEqual(statusOf(targetRequestId), 'pending', 'статус')
      } finally {
        db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(adminUser.accountId)
      }
    })

    await check('[H4] Празна причина / допълнителни полета / невалиден id -> 400; нищо не се променя', async () => {
      for (const body of [{ reason: '' }, { reason: '    ' }, {}, { reason: 'ok', extra: 1 }, { reason: 'x'.repeat(501) }]) {
        const res = await api(`/api/admin/profile-deletions/${targetRequestId}/cancel`, { method: 'POST', cookie: adminUser.cookie, body })
        assert(res.status === 400, `${JSON.stringify(body).slice(0, 40)}: ${res.status}`)
      }
      assert((await api('/api/admin/profile-deletions/..%2F..%2Fx/cancel', { method: 'POST', cookie: adminUser.cookie, body: { reason: 'x' } })).status === 400, 'невалиден id')
      assertEqual(statusOf(targetRequestId), 'pending', 'статус')
      assertEqual(Number((db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_admin_cancellations;').get() as { c: number }).c), 0, 'одит')
    })

    await check('[H5] Отмяна: 200 без Set-Cookie; одит с причина; профилът е видим отново; старата сесия остава отнета; следва нормален вход', async () => {
      assert((await api(`/api/profiles/${target.profileId}`, { cookie: viewer.cookie })).status !== 200, 'профилът е видим преди отмяната')
      const res = await api(`/api/admin/profile-deletions/${targetRequestId}/cancel`, { method: 'POST', cookie: adminUser.cookie, body: { reason: REASON_HTTP } })
      assert(res.status === 200 && res.json.ok === true, `${res.status} ${res.text}`)
      assert(res.setCookie === '', 'Set-Cookie при отмяна')
      assertEqual(statusOf(targetRequestId), 'cancelled', 'статус')
      const audit = db.prepare('SELECT reason, actor_profile_id FROM profile_deletion_admin_cancellations WHERE request_id = ?;').get(targetRequestId) as { reason: string; actor_profile_id: string }
      assert(audit.reason === REASON_HTTP && audit.actor_profile_id === adminUser.profileId, 'одит')
      assert((await api(`/api/profiles/${target.profileId}`, { cookie: viewer.cookie })).status === 200, 'видимостта не е възстановена')
      assert((await api('/api/friends', { cookie: target.cookie })).status === 401, 'старата сесия се възстанови')
      const again = await login(target.email)
      assert(again.status === 200 && again.json.ok === true, `нормален вход ${again.status}`)
      const repeat = await api(`/api/admin/profile-deletions/${targetRequestId}/cancel`, { method: 'POST', cookie: adminUser.cookie, body: { reason: REASON_HTTP } })
      assert(repeat.status === 409 && repeat.json.code === 'status_not_cancellable', `повторна: ${repeat.status} ${repeat.text}`)
    })

    await check('[H6] Бан + чакаща заявка: административната отмяна не маха бана — следващият вход е PROFILE_BANNED', async () => {
      const banned = await register('Banned')
      assert((await submitDeletion(banned)).status === 200, 'подаване')
      const banRowId = randomUUID()
      db.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason) VALUES (?, ?, datetime('now', '+5 days'), 'тест');`).run(banRowId, banned.profileId)
      const requestId = requestIdOf(banned.profileId)
      const res = await api(`/api/admin/profile-deletions/${requestId}/cancel`, { method: 'POST', cookie: adminUser.cookie, body: { reason: REASON_HTTP } })
      assert(res.status === 200, `${res.status} ${res.text}`)
      assert(db.prepare('SELECT 1 FROM profile_bans WHERE ban_id = ?;').get(banRowId) !== undefined, 'банът е изтрит')
      const after = await login(banned.email)
      assert(after.status === 403 && after.json.code === 'PROFILE_BANNED', `${after.status} ${JSON.stringify(after.json)}`)
    })

    await check('[H7] Намерение в регистъра (симулиран запис) -> 409 ledger_intent_recorded с обяснение; повреден регистър -> 503', async () => {
      const user = await register('Ledger')
      assert((await submitDeletion(user)).status === 200, 'подаване')
      const requestId = requestIdOf(user.profileId)
      const row = db.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, string>
      await mkdir(join(isolatedRoot, 'ledger'), { recursive: true })
      ensureProfileDeletionLedgerEntry(ledgerPath, {
        v: 1, requestId, profileId: user.profileId, accountIdSnapshot: row.account_id_snapshot!, profileCreatedAtSnapshot: row.profile_created_at_snapshot!,
        requestedAt: row.requested_at!, scheduledFor: row.scheduled_for!, recordedAt: new Date().toISOString(),
      })
      const res = await api(`/api/admin/profile-deletions/${requestId}/cancel`, { method: 'POST', cookie: adminUser.cookie, body: { reason: REASON_HTTP } })
      assert(res.status === 409 && res.json.code === 'ledger_intent_recorded' && /регистъра/.test(res.json.message), `${res.status} ${res.text}`)
      appendFileSync(ledgerPath, 'garbage\n')
      const other = await register('Ledger2')
      assert((await submitDeletion(other)).status === 200, 'подаване 2')
      const corrupt = await api(`/api/admin/profile-deletions/${requestIdOf(other.profileId)}/cancel`, { method: 'POST', cookie: adminUser.cookie, body: { reason: REASON_HTTP } })
      assert(corrupt.status === 503 && corrupt.json.code === 'ledger_unavailable', `${corrupt.status} ${corrupt.text}`)
      assertEqual(statusOf(requestId), 'pending', 'статус')
    })
  } finally {
    db.close()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((res) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); res() }, 10_000)
        child.once('exit', () => { clearTimeout(timer); res() })
      })
    }
  }
}


console.log('\n════════════════════════════════════════════════════════════')
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
