/**
 * checkProfileDeletionPendingAdminConflict.ts
 *
 * Самоизтриване, Етап 4E6C (одобрен вариант А) — висящо административно
 * изтриване (pending_profile_moderation, action='delete', със или без
 * support заявка) на СЪЩИЯ профил вече не блокира окончателното
 * самоизтриване: то приключва и двете процедури в една транзакция, без нов
 * support архив и без admin_profile_deletions. Активен бан и останалите
 * блокери важат както преди. САМО временни бази.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileBanStore } from '../src/db/profileBanStore.js'
import { createSupportStore, type NewSupportAttachmentInput } from '../src/db/supportStore.js'
import { createProfileDeletionExecutor, type ProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createProfileHardDeleteService } from '../src/db/profileHardDeleteService.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { removeProfileDeletionFile, type ProfileDeletionUploadRoots } from '../src/uploads/profileDeletionFileRemoval.js'
import { createProfileDeletionCancellationKit } from './fixtures/profileDeletionCancellationKit.js'

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
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}

const sourceServerRoot = resolve(process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const SECRET = 'profile-deletion-pending-admin-secret-0123456789'

console.log('\ncheckProfileDeletionPendingAdminConflict')

const tempRoots: string[] = []
const sqliteModule = await import('node:sqlite')

try {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-pending-admin-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
      await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const roots: ProfileDeletionUploadRoots = {
    avatars: join(root, 'uploads', 'avatars'),
    profileGallery: join(root, 'uploads', 'profile-gallery'),
    chatAttachments: join(root, 'uploads', 'chat-attachments'),
    topicAttachments: join(root, 'uploads', 'topic-attachments'),
    topicMuteEvidenceAttachments: join(root, 'uploads', 'topic-mute-evidence-attachments'),
    supportAttachments: join(root, 'uploads', 'support-attachments'),
  }
  for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const progressStore = await createPlayerProgressStore(databaseFilePath)
  const authStore = await createAuthStore(databaseFilePath, progressStore, {
    registrationVerificationCodeSecret: SECRET,
    getRegistrationVerificationMode: () => 'direct',
    getActiveBanForProfile: () => null,
  })
  const banStore = await createProfileBanStore(databaseFilePath)
  const supportStore = await createSupportStore(databaseFilePath, {
    hasPendingSupportRequestDelete: (profileId) => db.prepare(
      `SELECT 1 FROM pending_profile_moderation WHERE target_profile_id = ? AND action = 'delete' AND support_request_message_id IS NOT NULL;`,
    ).get(profileId) !== undefined,
  })
  const requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
  // Етап 4J1 — отмяната е окончателна след запис в регистъра + offsite ack.
  const cancellationKit = await createProfileDeletionCancellationKit({ databaseFilePath, ledgerPath: `${databaseFilePath}-cancellation-ledger/profile-deletions.jsonl` })
  const executor = await createProfileDeletionExecutor(databaseFilePath)
  const hardDeleteService = await createProfileHardDeleteService(databaseFilePath, { deleteUploadFileByUrl: async () => {} })

  const makeWorker = (exec: ProfileDeletionExecutor, onlyRequestIds: string[]) => createProfileDeletionWorker({
    executor: exec,
    workerId: `w-pending-admin-${randomUUID().slice(0, 6)}`,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: null,
    onlyRequestIds,
  })
  type User = { profileId: string; accountId: string; email: string; displayName: string }
  let counter = 0
  const registerUser = (label: string): User => {
    counter += 1
    const email = `pending-admin-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `Pa${label}${counter}`
    const result = authStore.register({ email, password: 'secret123', displayName, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
    return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, email, displayName }
  }
  const count = (sql: string, ...params: Array<string | number | null>) => Number((db.prepare(sql).get(...params) as { c: number }).c)
  const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const pastIso = () => new Date(Date.parse(dbNow()) - 1000).toISOString()
  const insertDueRequest = (user: User): string => {
    const requestId = randomUUID()
    const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
    const scheduledFor = pastIso()
    const requestedAt = new Date(Date.parse(scheduledFor) - PROFILE_DELETION_GRACE_PERIOD_MS).toISOString()
    const guard = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
    db.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
    try {
      db.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for) VALUES (?, ?, ?, ?, ?, ?);`)
        .run(requestId, user.profileId, user.accountId, createdAt, requestedAt, scheduledFor)
    } finally {
      db.exec(guard)
    }
    return requestId
  }
  const requestRow = (requestId: string) => db.prepare('SELECT status, db_deleted_at, last_error_code FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string; db_deleted_at: string | null; last_error_code: string | null }
  const profileExists = (profileId: string) => count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', profileId) === 1
  const newImage = async (): Promise<NewSupportAttachmentInput> => {
    const storageFilename = `${randomUUID()}.webp`
    await writeFile(join(roots.supportAttachments, storageFilename), Buffer.from(`RIFF-${storageFilename}`))
    return { storageFilename, width: 10, height: 10, byteSize: 32, contentType: 'image/webp' }
  }
  const fileOnDisk = (name: string) => existsSync(join(roots.supportAttachments, name))

  const admin = registerUser('Admin')
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)

  // Сценарий: потребителят пише "изтрийте профила ми", админът натиска
  // "Изтрий профила по тази заявка", докато потребителят е в игра (pending),
  // играта не приключва нормално; потребителят подава заявка за
  // самоизтриване и срокът изтича.
  type Scenario = { user: User; pendingId: string; requestMessageId: string; files: string[] }
  const setupScenario = async (label: string, withSupport = true): Promise<Scenario> => {
    const user = registerUser(label)
    const files: string[] = []
    const first = await newImage()
    files.push(first.storageFilename)
    const request = supportStore.sendUserMessage(user.profileId, 'Моля, изтрийте профила ми', first)
    const reply = await newImage()
    files.push(reply.storageFilename)
    supportStore.sendAdminReply(user.profileId, 'Ще го изтрием след края на играта', reply)
    const pendingId = randomUUID()
    db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, requested_by_profile_id, requested_by_account_id, reason, support_request_message_id)
      VALUES (?, ?, 'delete', ?, ?, 'по заявка на потребителя', ?);`).run(pendingId, user.profileId, admin.profileId, admin.accountId, withSupport ? request.messageId : null)
    return { user, pendingId, requestMessageId: request.messageId, files }
  }

  // Чужди записи — трябва да останат байт по байт.
  const other = await setupScenario('Other')
  const archivedProfileId = randomUUID()
  const archivedMessageId = randomUUID()
  db.prepare(`INSERT INTO support_messages (message_id, profile_id, body, is_from_admin) VALUES (?, ?, 'стара заявка', 0);`).run(archivedMessageId, archivedProfileId)
  db.prepare(`INSERT INTO support_deletion_archives (archive_id, profile_id, username_snapshot, display_name_snapshot, request_message_id, requested_at, deleted_at, reason)
    VALUES (?, ?, 'old', 'Old', ?, '2026-09-01 10:00:00', '2026-09-02 10:00:00', 'по заявка');`).run(randomUUID(), archivedProfileId, archivedMessageId)
  const foreignDump = () => JSON.stringify([
    db.prepare('SELECT * FROM pending_profile_moderation WHERE target_profile_id = ?;').all(other.user.profileId),
    db.prepare('SELECT * FROM support_messages WHERE profile_id IN (?, ?) ORDER BY message_id;').all(other.user.profileId, archivedProfileId),
    db.prepare('SELECT * FROM support_message_attachments a JOIN support_messages m ON m.message_id = a.message_id WHERE m.profile_id = ? ORDER BY a.message_id;').all(other.user.profileId),
    db.prepare('SELECT * FROM support_deletion_archives ORDER BY archive_id;').all(),
  ])
  const foreignBefore = foreignDump()
  const archivesCount = () => count('SELECT COUNT(*) AS c FROM support_deletion_archives;')
  const archivesBefore = archivesCount()

  let resolved: Scenario | null = null
  let resolvedRequestId = ''

  await check('[C1] Висящо административно изтриване със support заявка + валидна самоизтриваща заявка за същия профил: completed; двете процедури са приключени', async () => {
    const scenario = await setupScenario('Main')
    const requestId = insertDueRequest(scenario.user)
    const summary = await makeWorker(executor, [requestId]).runOnce()
    assert(summary.completed === 1 && summary.blocked === 0 && summary.failed === 0, JSON.stringify(summary))
    const row = requestRow(requestId)
    assert(row.status === 'completed' && row.db_deleted_at !== null, JSON.stringify(row))
    assert(!profileExists(scenario.user.profileId), 'профилът')
    assertEqual(count('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE pending_id = ? OR target_profile_id = ?;', scenario.pendingId, scenario.user.profileId), 0, 'pending записът')
    const event = db.prepare(`SELECT detail_json FROM profile_deletion_events WHERE request_id = ? AND event_type = 'db_deleted';`).get(requestId) as { detail_json: string }
    assertEqual((JSON.parse(event.detail_json) as { pendingAdminDeleteResolved: number }).pendingAdminDeleteResolved, 1, 'журналът отбелязва приключването')
    resolved = scenario
    resolvedRequestId = requestId
  })

  await check('[C2] Без допълнителен архив: support_deletion_archives и admin_profile_deletions нямат нов ред', () => {
    assert(resolved !== null, 'няма данни от C1')
    assertEqual(archivesCount(), archivesBefore, 'support_deletion_archives')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_deletion_archives WHERE profile_id = ?;', resolved!.user.profileId), 0, 'архив за профила')
    assertEqual(count('SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE deleted_profile_id = ?;', resolved!.user.profileId), 0, 'admin_profile_deletions')
  })

  await check('[C3] Support кореспонденцията (вкл. заявката и отговора на екипа) е изтрита по правилата от 4E5; файловете — през опашката', () => {
    assert(resolved !== null, 'няма данни от C1')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_messages WHERE profile_id = ? OR message_id = ?;', resolved!.user.profileId, resolved!.requestMessageId), 0, 'съобщенията')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_archived WHERE profile_id = ?;', resolved!.user.profileId), 0, 'маркерът')
    const queued = db.prepare(`SELECT storage_ref AS ref, status FROM profile_deletion_file_queue WHERE request_id = ? AND file_kind = 'support_attachment' ORDER BY storage_ref;`).all(resolvedRequestId) as Array<{ ref: string; status: string }>
    assertEqual(JSON.stringify(queued.map((row) => row.ref)), JSON.stringify([...resolved!.files].sort()), 'опашката')
    assert(queued.every((row) => row.status === 'done'), JSON.stringify(queued))
    for (const name of resolved!.files) assert(!fileOnDisk(name), `файлът ${name}`)
  })

  await check('[C4] Чуждите административни и support записи (друг pending, друг разговор, стар архив) са байт по байт непроменени', () => {
    assertEqual(foreignDump(), foreignBefore, 'чуждите записи')
    for (const name of other.files) assert(fileOnDisk(name), 'чуждият файл')
  })

  await check('[C5] Висящо административно изтриване БЕЗ support заявка: също се приключва', async () => {
    const scenario = await setupScenario('NoSupportRef', false)
    const requestId = insertDueRequest(scenario.user)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).completed, 1, 'completed')
    assertEqual(count('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE pending_id = ?;', scenario.pendingId), 0, 'pending')
  })

  await check('[C6] Активен бан продължава да блокира (active_ban): нищо не е променено, pending записът и разговорът остават', async () => {
    const scenario = await setupScenario('Banned')
    const requestId = insertDueRequest(scenario.user)
    assert(banStore.banProfile({ targetProfileId: scenario.user.profileId, actorProfileId: admin.profileId, days: 5, reason: 'х' }).ok, 'бан')
    const snapshot = () => JSON.stringify([
      db.prepare('SELECT * FROM pending_profile_moderation WHERE target_profile_id = ?;').all(scenario.user.profileId),
      db.prepare('SELECT * FROM support_messages WHERE profile_id = ? ORDER BY message_id;').all(scenario.user.profileId),
    ])
    const before = snapshot()
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).blocked, 1, 'blocked')
    const row = requestRow(requestId)
    assert(row.status === 'blocked' && row.last_error_code === 'active_ban' && row.db_deleted_at === null, JSON.stringify(row))
    assert(profileExists(scenario.user.profileId), 'профилът')
    assertEqual(snapshot(), before, 'непроменено')
    for (const name of scenario.files) assert(fileOnDisk(name), 'файлът')
  })

  await check('[C7] Изтекъл бан не пречи: completed, pending записът е приключен', async () => {
    const scenario = await setupScenario('ExpiredBan')
    assert(banStore.banProfile({ targetProfileId: scenario.user.profileId, actorProfileId: admin.profileId, days: 1, reason: 'х' }).ok, 'бан')
    db.prepare(`UPDATE profile_bans SET banned_until = datetime('now', '-1 minute') WHERE profile_id = ?;`).run(scenario.user.profileId)
    const requestId = insertDueRequest(scenario.user)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).completed, 1, 'completed')
    assertEqual(count('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE pending_id = ?;', scenario.pendingId), 0, 'pending')
  })

  await check('[C8] Отменена заявка за самоизтриване: worker-ът не я взема; pending административното действие и разговорът остават непроменени', async () => {
    const scenario = await setupScenario('Cancelled')
    const created = requestStore.createRequest({ profileId: scenario.user.profileId, accountId: scenario.user.accountId })
    if (!created.ok) throw new Error(JSON.stringify(created))
    const issued = requestStore.issueRestoreToken(scenario.user.profileId)
    assert(issued.ok && requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    cancellationKit.confirmAll()
    assertEqual(requestRow(created.request.requestId).status, 'cancelled', 'статус')
    assertEqual((await makeWorker(executor, [created.request.requestId]).runOnce()).claimed, 0, 'не е взета')
    assert(profileExists(scenario.user.profileId), 'профилът')
    assertEqual(count('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE pending_id = ?;', scenario.pendingId), 1, 'pending')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_messages WHERE profile_id = ?;', scenario.user.profileId), 2, 'разговорът')
  })

  await check('[C9] Висящо административно действие от друг тип (pending бан при активен бан): продължава да блокира; редът остава', async () => {
    const user = registerUser('PendingBan')
    const requestId = insertDueRequest(user)
    const ban = banStore.banProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, days: 5, reason: 'отложен' })
    if (!ban.ok) throw new Error('бан')
    db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, ban_id, requested_by_profile_id, reason) VALUES (?, ?, 'ban', ?, ?, 'отложен');`)
      .run(randomUUID(), user.profileId, ban.ban.banId, admin.profileId)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).blocked, 1, 'blocked')
    assertEqual(requestRow(requestId).last_error_code, 'active_ban', 'код')
    assertEqual(count(`SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE target_profile_id = ? AND action = 'ban';`, user.profileId), 1, 'pending бан')
  })

  await check('[C10] ROLLBACK при грешка (нарушен support инвариант): failed; профилът, pending административното действие и разговорът са непокътнати', async () => {
    const scenario = await setupScenario('Rollback')
    const snapshot = () => JSON.stringify([
      db.prepare('SELECT * FROM pending_profile_moderation WHERE target_profile_id = ?;').all(scenario.user.profileId),
      db.prepare('SELECT * FROM support_messages WHERE profile_id = ? ORDER BY message_id;').all(scenario.user.profileId),
      db.prepare('SELECT * FROM profiles WHERE profile_id = ?;').all(scenario.user.profileId),
    ])
    const before = snapshot()
    db.exec(`CREATE TRIGGER trg_test_lose_foreign_support AFTER DELETE ON profiles WHEN OLD.profile_id = '${scenario.user.profileId}'
      BEGIN DELETE FROM support_messages WHERE profile_id = '${archivedProfileId}'; END;`)
    let requestId = ''
    try {
      requestId = insertDueRequest(scenario.user)
      assertEqual((await makeWorker(executor, [requestId]).runOnce()).failed, 1, 'failed')
    } finally {
      db.exec('DROP TRIGGER trg_test_lose_foreign_support;')
    }
    const row = requestRow(requestId)
    assert(row.status === 'failed' && row.db_deleted_at === null && row.last_error_code === 'db_phase_error', JSON.stringify(row))
    assertEqual(snapshot(), before, 'състоянието')
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_deletion_file_queue WHERE request_id = ?;', requestId), 0, 'опашката')
    for (const name of scenario.files) assert(fileOnDisk(name), 'файлът')
    assertEqual(foreignDump(), foreignBefore, 'чуждите записи')
    // След премахване на причината повторният опит завършва.
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(pastIso(), requestId)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).completed, 1, 'повторният опит')
    assertEqual(count('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE pending_id = ?;', scenario.pendingId), 0, 'pending')
  })

  await check('[C11] Повторно изпълнение на worker-а: нищо не се взема; pending, support и архивите са непроменени', async () => {
    const dump = () => JSON.stringify([
      db.prepare('SELECT * FROM pending_profile_moderation ORDER BY pending_id;').all(),
      db.prepare('SELECT * FROM support_messages ORDER BY message_id;').all(),
      db.prepare('SELECT * FROM support_deletion_archives ORDER BY archive_id;').all(),
      db.prepare('SELECT * FROM admin_profile_deletions ORDER BY log_id;').all(),
    ])
    const before = dump()
    const requestIds = (db.prepare(`SELECT request_id FROM profile_deletion_requests WHERE status = 'completed';`).all() as Array<{ request_id: string }>).map((row) => row.request_id)
    assert(requestIds.length >= 4, `completed: ${requestIds.length}`)
    assertEqual((await makeWorker(executor, requestIds).runOnce()).claimed, 0, 'нищо не е взето')
    assertEqual(dump(), before, 'непроменено')
  })

  await check('[C12] Restore от стар backup със стар pending запис: replayDeletionForRestore НЕ е блокиран — изтрива профила, приключва pending записа, без нов архив; файловете са върнати за премахване', async () => {
    const scenario = await setupScenario('Replay')
    const backupPath = join(root, `backup-${randomUUID()}.sqlite`)
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`)
    const restored = await createProfileDeletionExecutor(backupPath)
    try {
      const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(scenario.user.profileId) as { created_at: string }).created_at
      const result = restored.replayDeletionForRestore({ profileId: scenario.user.profileId, accountIdSnapshot: scenario.user.accountId, profileCreatedAtSnapshot: createdAt })
      assert(result.kind === 'deleted', `резултат: ${JSON.stringify(result)}`)
      if (result.kind === 'deleted') {
        const files = result.files.filter((file) => file.fileKind === 'support_attachment').map((file) => file.storageRef).sort()
        assertEqual(JSON.stringify(files), JSON.stringify([...scenario.files].sort()), 'файловете')
      }
      // Повторен replay: профилът вече го няма — без второ изтриване.
      const createdAgain = restored.replayDeletionForRestore({ profileId: scenario.user.profileId, accountIdSnapshot: scenario.user.accountId, profileCreatedAtSnapshot: createdAt })
      assertEqual(createdAgain.kind, 'absent', 'повторен replay')
    } finally {
      restored.close()
    }
    const backup = new sqliteModule.DatabaseSync(backupPath, { readOnly: true })
    try {
      const one = (sql: string, ...params: string[]) => Number((backup.prepare(sql).get(...params) as { c: number }).c)
      assertEqual(one('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', scenario.user.profileId), 0, 'профилът')
      assertEqual(one('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE target_profile_id = ?;', scenario.user.profileId), 0, 'pending')
      assertEqual(one('SELECT COUNT(*) AS c FROM support_messages WHERE profile_id = ?;', scenario.user.profileId), 0, 'разговорът')
      assertEqual(one('SELECT COUNT(*) AS c FROM support_deletion_archives;'), archivesBefore, 'архивите')
      assertEqual(one('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE target_profile_id = ?;', other.user.profileId), 1, 'чуждият pending')
    } finally {
      backup.close()
    }
  })

  await check('[C13] Невъзможност за двойно изтриване: след самоизтриването отложеното административно изтриване връща not_found и не създава архив/журнал', async () => {
    assert(resolved !== null, 'няма данни от C1')
    const result = await hardDeleteService.hardDeleteProfile({
      targetProfileId: resolved!.user.profileId,
      actorProfileId: admin.profileId,
      actorAccountId: admin.accountId,
      reason: 'по заявка на потребителя',
      supportRequestMessageId: resolved!.requestMessageId,
    })
    assert(!result.ok && result.code === 'not_found', JSON.stringify(result))
    assertEqual(archivesCount(), archivesBefore, 'архивите')
    assertEqual(count('SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE deleted_profile_id = ?;', resolved!.user.profileId), 0, 'admin_profile_deletions')
  })

  await check('[C14] Обратният ред (административното изтриване завърши първо): самоизтриването е completed без второ изтриване; архивът на админа е единственият', async () => {
    const scenario = await setupScenario('AdminFirst')
    const requestId = insertDueRequest(scenario.user)
    const result = await hardDeleteService.hardDeleteProfile({
      targetProfileId: scenario.user.profileId,
      actorProfileId: admin.profileId,
      actorAccountId: admin.accountId,
      reason: 'по заявка на потребителя',
      supportRequestMessageId: scenario.requestMessageId,
    })
    assert(result.ok, JSON.stringify(result))
    assertEqual(count('SELECT COUNT(*) AS c FROM support_deletion_archives WHERE profile_id = ?;', scenario.user.profileId), 1, 'архивът на админа')
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).completed, 1, 'completed')
    const event = db.prepare(`SELECT detail_json FROM profile_deletion_events WHERE request_id = ? AND event_type = 'db_deleted';`).get(requestId) as { detail_json: string }
    assertEqual((JSON.parse(event.detail_json) as { alreadyDeletedByAdmin: boolean }).alreadyDeletedByAdmin, true, 'alreadyDeletedByAdmin')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_deletion_archives WHERE profile_id = ?;', scenario.user.profileId), 1, 'без втори архив')
    assertEqual(count('SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE deleted_profile_id = ?;', scenario.user.profileId), 1, 'един журнален ред')
  })

  await check('[C15] Невъзможност за частично изтриване: срив преди COMMIT — нищо не е изтрито, pending записът остава; след изтекъл lease worker-ът довършва', async () => {
    const scenario = await setupScenario('Crash')
    const requestId = insertDueRequest(scenario.user)
    const crashing = await createProfileDeletionExecutor(databaseFilePath, {
      testHooks: { beforeDatabasePhaseCommit: () => { throw Object.assign(new Error('simulated crash'), { profileDeletionSimulatedCrash: true }) } },
    })
    try {
      let crashed = false
      try { await makeWorker(crashing, [requestId]).runOnce() } catch { crashed = true }
      assert(crashed, 'сривът прекъсна worker-а')
    } finally {
      crashing.close()
    }
    assert(profileExists(scenario.user.profileId), 'профилът')
    assertEqual(count('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE pending_id = ?;', scenario.pendingId), 1, 'pending')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_messages WHERE profile_id = ?;', scenario.user.profileId), 2, 'разговорът')
    assertEqual(requestRow(requestId).db_deleted_at, null, 'db_deleted_at')
    db.prepare('UPDATE profile_deletion_requests SET lease_expires_at = ? WHERE request_id = ?;').run(pastIso(), requestId)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).completed, 1, 'довършено')
    assertEqual(count('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE pending_id = ?;', scenario.pendingId), 0, 'pending след довършване')
  })

  for (const store of [executor, requestStore, authStore, progressStore, banStore, supportStore] as Array<{ close: () => void }>) {
    try { store.close() } catch { /* ignore */ }
  }
  db.close()
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
