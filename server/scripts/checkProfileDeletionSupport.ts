/**
 * checkProfileDeletionSupport.ts
 *
 * Самоизтриване, Етап 4E5 — кореспонденцията с поддръжката ("Връзка с
 * екипа") при окончателно изтриване:
 *   * всички support съобщения на профила (неговите и отговорите на екипа),
 *     маркерът "архивиран" и прикачените файлове изчезват;
 *   * физическите файлове минават през надеждната опашка на самоизтриването
 *     (support_attachment) с обичайните защити (споделен файл, path/symlink);
 *   * отложено административно изтриване с посочена support заявка
 *     (pending_profile_moderation) е защитено доказателство — изчаква се;
 *   * чуждите разговори и support_deletion_archives са непокътнати.
 * САМО временни бази. Съобщенията се пишат през реалния supportStore.
 *
 * [S] Разговори и файлове.  [P] Процес (отмяна, worker, прекъсване, restore,
 * rollback, API).  [N] Нормална поддръжка за останалите.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionExecutor, type ProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createSupportStore, type NewSupportAttachmentInput } from '../src/db/supportStore.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
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
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}
function assertThrows(fn: () => unknown, fragment: string, message: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!text.includes(fragment)) throw new Error(`${message}: очаквана грешка "${fragment}", получена "${text}"`)
    return
  }
  throw new Error(`${message}: не беше отхвърлено`)
}

const sourceServerRoot = resolve(process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const SECRET = 'profile-deletion-support-secret-0123456789'

console.log('\ncheckProfileDeletionSupport')

const tempRoots: string[] = []
const sqliteModule = await import('node:sqlite')

try {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-support-'))
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
  const requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
  const executor = await createProfileDeletionExecutor(databaseFilePath)
  // Същата зависимост като в index.ts (pendingProfileModerationStore.getPending).
  const supportStore = await createSupportStore(databaseFilePath, {
    hasPendingSupportRequestDelete: (profileId) => db.prepare(
      `SELECT 1 FROM pending_profile_moderation WHERE target_profile_id = ? AND action = 'delete' AND support_request_message_id IS NOT NULL;`,
    ).get(profileId) !== undefined,
  })

  const makeWorker = (exec: ProfileDeletionExecutor, onlyRequestIds: string[]) => createProfileDeletionWorker({
    executor: exec,
    workerId: `w-support-${randomUUID().slice(0, 6)}`,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: null,
    onlyRequestIds,
  })
  type User = { profileId: string; accountId: string; email: string; displayName: string }
  let counter = 0
  const registerUser = (label: string): User => {
    counter += 1
    const email = `support-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `Sp${label}${counter}`
    const result = authStore.register({ email, password: 'secret123', displayName, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
    return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, email, displayName }
  }
  const newImage = async (): Promise<NewSupportAttachmentInput> => {
    const storageFilename = `${randomUUID()}.webp`
    await writeFile(join(roots.supportAttachments, storageFilename), Buffer.from(`RIFF-test-${storageFilename}`))
    return { storageFilename, width: 10, height: 10, byteSize: 32, contentType: 'image/webp' }
  }
  const fileOnDisk = (name: string) => existsSync(join(roots.supportAttachments, name))
  const count = (sql: string, ...params: Array<string | number>) => Number((db.prepare(sql).get(...params) as { c: number }).c)
  const supportRowsOf = (profileId: string) =>
    count('SELECT COUNT(*) AS c FROM support_messages WHERE profile_id = ?;', profileId) +
    count('SELECT COUNT(*) AS c FROM support_message_attachments a JOIN support_messages m ON m.message_id = a.message_id WHERE m.profile_id = ?;', profileId) +
    count('SELECT COUNT(*) AS c FROM support_archived WHERE profile_id = ?;', profileId)
  const supportSnapshotOf = (profileId: string) => JSON.stringify([
    db.prepare('SELECT * FROM support_messages WHERE profile_id = ? ORDER BY created_at, message_id;').all(profileId),
    db.prepare('SELECT a.* FROM support_message_attachments a JOIN support_messages m ON m.message_id = a.message_id WHERE m.profile_id = ? ORDER BY a.message_id;').all(profileId),
    db.prepare('SELECT * FROM support_archived WHERE profile_id = ?;').all(profileId),
  ])
  const filesOf = (profileId: string) => (db.prepare('SELECT a.storage_filename AS f FROM support_message_attachments a JOIN support_messages m ON m.message_id = a.message_id WHERE m.profile_id = ? ORDER BY f;').all(profileId) as Array<{ f: string }>).map((row) => row.f)
  // Всички support таблици, без опашката на собствения support cleanup (там са само имена на файлове).
  const supportTablesDump = () => JSON.stringify([
    db.prepare('SELECT * FROM support_messages ORDER BY message_id;').all(),
    db.prepare('SELECT * FROM support_message_attachments ORDER BY message_id;').all(),
    db.prepare('SELECT * FROM support_archived ORDER BY profile_id;').all(),
    db.prepare('SELECT * FROM support_deletion_archives ORDER BY archive_id;').all(),
  ])
  const assertNoTrace = (user: User, message: string) => {
    assertEqual(supportRowsOf(user.profileId), 0, `${message}: support редове`)
    const dump = supportTablesDump()
    for (const needle of [user.profileId, user.email, user.displayName]) assert(!dump.includes(needle), `${message}: "${needle}" в support таблиците`)
  }
  const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const insertDueRequest = (user: User): string => {
    const requestId = randomUUID()
    const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
    const scheduledFor = new Date(Date.parse(dbNow()) - 1000).toISOString()
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
  const deleteViaWorker = async (user: User): Promise<string> => {
    const requestId = insertDueRequest(user)
    const summary = await makeWorker(executor, [requestId]).runOnce()
    assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
    return requestId
  }
  const queueOf = (requestId: string) => db.prepare(`SELECT storage_ref AS ref, status FROM profile_deletion_file_queue WHERE request_id = ? AND file_kind = 'support_attachment' ORDER BY storage_ref;`).all(requestId) as Array<{ ref: string; status: string }>
  const profileExists = (profileId: string) => count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', profileId) === 1

  // Трети лица — техният разговор трябва да остане байт по байт.
  const bystander = registerUser('Bystander')
  supportStore.sendUserMessage(bystander.profileId, 'Здравейте, имам въпрос', await newImage())
  supportStore.sendAdminReply(bystander.profileId, 'Здравейте, ето отговор', await newImage())
  const bystanderBefore = supportSnapshotOf(bystander.profileId)
  const bystanderFiles = filesOf(bystander.profileId)
  // Доказателствен архив от предишно административно изтриване (друг профил).
  const archivedDeletedProfileId = randomUUID()
  const archivedRequestMessageId = randomUUID()
  db.prepare(`INSERT INTO support_messages (message_id, profile_id, body, is_from_admin) VALUES (?, ?, 'Моля изтрийте профила ми', 0);`).run(archivedRequestMessageId, archivedDeletedProfileId)
  db.prepare(`INSERT INTO support_deletion_archives (archive_id, profile_id, username_snapshot, display_name_snapshot, request_message_id, requested_at, deleted_at, reason)
    VALUES (?, ?, 'oldUser', 'Old User', ?, '2026-09-01 10:00:00', '2026-09-02 10:00:00', 'по заявка');`).run(randomUUID(), archivedDeletedProfileId, archivedRequestMessageId)
  const evidenceArchiveBefore = JSON.stringify([
    db.prepare('SELECT * FROM support_messages WHERE profile_id = ?;').all(archivedDeletedProfileId),
    db.prepare('SELECT * FROM support_deletion_archives;').all(),
  ])

  console.log('\n[S] Разговори и файлове')

  await check('[S1] Разговор без файлове: всички съобщения (на потребителя и на екипа) изчезват; няма следи в support таблиците', async () => {
    const user = registerUser('NoFiles')
    supportStore.sendUserMessage(user.profileId, `Аз съм ${user.displayName}, пиша от ${user.email}`)
    supportStore.sendAdminReply(user.profileId, 'Отговор на екипа')
    supportStore.sendUserMessage(user.profileId, 'Благодаря')
    assertEqual(supportStore.getMessages(user.profileId).length, 3, 'преди')
    const requestId = await deleteViaWorker(user)
    assertEqual(queueOf(requestId).length, 0, 'няма файлове в опашката')
    assertNoTrace(user, 'след')
    assertEqual(supportStore.getMessages(user.profileId).length, 0, 'getMessages')
  })

  await check('[S2] Разговор с няколко изображения: редовете изчезват, файловете са в опашката (support_attachment) и са изтрити физически', async () => {
    const user = registerUser('Images')
    supportStore.sendUserMessage(user.profileId, 'Снимка 1', await newImage())
    supportStore.sendUserMessage(user.profileId, '', await newImage())
    supportStore.sendUserMessage(user.profileId, 'Снимка 3', await newImage())
    const files = filesOf(user.profileId)
    assertEqual(files.length, 3, 'файлове преди')
    const requestId = await deleteViaWorker(user)
    const queued = queueOf(requestId)
    assertEqual(JSON.stringify(queued.map((row) => row.ref)), JSON.stringify(files), 'опашка')
    assert(queued.every((row) => row.status === 'done'), JSON.stringify(queued))
    for (const name of files) assert(!fileOnDisk(name), `файлът ${name} е на диска`)
    assertNoTrace(user, 'след')
  })

  await check('[S3] Много съобщения в разговора (схемата позволява един разговор на профил, ключ profile_id): всички, вкл. по-стари от 5 дни, изчезват', async () => {
    const user = registerUser('Many')
    for (let index = 0; index < 12; index += 1) supportStore.sendUserMessage(user.profileId, `Съобщение ${index}`)
    db.prepare(`UPDATE support_messages SET created_at = datetime('now', '-30 days') WHERE profile_id = ? AND body IN ('Съобщение 0', 'Съобщение 1');`).run(user.profileId)
    assertEqual(count('SELECT COUNT(DISTINCT profile_id) AS c FROM support_messages WHERE profile_id = ?;', user.profileId), 1, 'един разговор')
    await deleteViaWorker(user)
    assertNoTrace(user, 'след')
  })

  await check('[S4] Архивиран разговор (support_archived): съобщенията, файловете и маркерът изчезват; изгледите "активни"/"архивирани" не го показват', async () => {
    const user = registerUser('Archived')
    supportStore.sendUserMessage(user.profileId, 'Въпрос', await newImage())
    supportStore.sendAdminReply(user.profileId, 'Решено')
    supportStore.archiveConversation(user.profileId)
    assertEqual(count('SELECT COUNT(*) AS c FROM support_archived WHERE profile_id = ?;', user.profileId), 1, 'архивиран')
    const files = filesOf(user.profileId)
    await deleteViaWorker(user)
    assertNoTrace(user, 'след')
    for (const name of files) assert(!fileOnDisk(name), 'файлът')
    const getProfile = (profileId: string) => (profileExists(profileId) ? { displayName: 'x', avatarUrl: null } : null)
    for (const filter of ['active', 'archived'] as const) {
      assert(!supportStore.getAllConversations(getProfile, filter).some((row) => JSON.stringify(row).includes(user.profileId)), `изглед ${filter}`)
    }
  })

  await check('[S5] Отговори на екипа с изображения: изтриват се заедно с разговора, файловете им — също', async () => {
    const user = registerUser('StaffReplies')
    supportStore.sendUserMessage(user.profileId, 'Проблем')
    supportStore.sendAdminReply(user.profileId, 'Вижте снимката', await newImage())
    supportStore.sendAdminReply(user.profileId, 'И тази', await newImage())
    const files = filesOf(user.profileId)
    assertEqual(files.length, 2, 'файлове на екипа')
    const requestId = await deleteViaWorker(user)
    assertEqual(queueOf(requestId).length, 2, 'опашка')
    for (const name of files) assert(!fileOnDisk(name), 'файлът')
    assertNoTrace(user, 'след')
  })

  await check('[S6] Два профила: изтрива се само разговорът на първия; вторият (и файловете му) — байт по байт непроменени', async () => {
    const first = registerUser('PairA')
    const second = registerUser('PairB')
    supportStore.sendUserMessage(first.profileId, 'A', await newImage())
    supportStore.sendUserMessage(second.profileId, 'B', await newImage())
    supportStore.sendAdminReply(second.profileId, 'B reply')
    const secondBefore = supportSnapshotOf(second.profileId)
    const secondFiles = filesOf(second.profileId)
    await deleteViaWorker(first)
    assertNoTrace(first, 'първият')
    assertEqual(supportSnapshotOf(second.profileId), secondBefore, 'вторият')
    for (const name of secondFiles) assert(fileOnDisk(name), 'файлът на втория')
  })

  await check('[S7] Файл с друга валидна препратка: UNIQUE не позволява две препратки едновременно; ако между DB фазата и файловата се появи нова препратка — файлът се пропуска (skipped_shared) и остава', async () => {
    const user = registerUser('Shared')
    const image = await newImage()
    supportStore.sendUserMessage(user.profileId, 'Споделен файл', image)
    const other = registerUser('SharedOther')
    assertThrows(() => supportStore.sendUserMessage(other.profileId, 'дубликат', image), 'UNIQUE', 'втора препратка')
    const requestId = insertDueRequest(user)
    const claimed = executor.claimNextDueRequest('w-shared', requestId)
    assert(claimed !== null, 'claim')
    assertEqual(executor.runDatabasePhase(claimed!, 'w-shared').kind, 'db_deleted', 'DB фаза')
    supportStore.sendUserMessage(other.profileId, 'вече валидна препратка', image)
    db.prepare('UPDATE profile_deletion_requests SET lease_expires_at = ? WHERE request_id = ?;').run(new Date(Date.parse(dbNow()) - 1000).toISOString(), requestId)
    const summary = await makeWorker(executor, [requestId]).runOnce()
    assert(summary.completed === 1 && summary.filesSkippedShared === 1, JSON.stringify(summary))
    assertEqual(queueOf(requestId)[0]!.status, 'skipped_shared', 'статус в опашката')
    assert(fileOnDisk(image.storageFilename), 'файлът остава')
    assertEqual(filesOf(other.profileId).length, 1, 'препратката на другия')
  })

  console.log('\n[P] Процес')

  await check('[P1] Заявка в периода за отмяна: worker-ът не я взема; разговорът и файловете са непроменени', async () => {
    const user = registerUser('Grace')
    supportStore.sendUserMessage(user.profileId, 'Още тук', await newImage())
    const before = supportSnapshotOf(user.profileId)
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    if (!created.ok) throw new Error(JSON.stringify(created))
    assertEqual((await makeWorker(executor, [created.request.requestId]).runOnce()).claimed, 0, 'не е взета преди срока')
    assertEqual(supportSnapshotOf(user.profileId), before, 'през периода')
    for (const name of filesOf(user.profileId)) assert(fileOnDisk(name), 'файлът')
  })

  await check('[P2] Отмяна: разговорът и файловете остават; поддръжката продължава нормално', async () => {
    const user = registerUser('Cancel')
    supportStore.sendUserMessage(user.profileId, 'Преди отмяна', await newImage())
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    if (!created.ok) throw new Error(JSON.stringify(created))
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok && requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    supportStore.sendUserMessage(user.profileId, 'След отмяна')
    assertEqual(supportStore.getMessages(user.profileId).length, 2, 'съобщения')
    for (const name of filesOf(user.profileId)) assert(fileOnDisk(name), 'файлът')
  })

  await check('[P3] Окончателно изтриване: completed само след файловете; профилът и разговорът липсват', async () => {
    const user = registerUser('Final')
    supportStore.sendUserMessage(user.profileId, 'Сбогом', await newImage())
    supportStore.sendAdminReply(user.profileId, 'Довиждане', await newImage())
    const files = filesOf(user.profileId)
    const requestId = await deleteViaWorker(user)
    const row = requestRow(requestId)
    assert(row.status === 'completed' && row.db_deleted_at !== null, JSON.stringify(row))
    assert(queueOf(requestId).every((entry) => entry.status === 'done'), 'всички файлове са обработени')
    assert(!profileExists(user.profileId), 'профилът')
    for (const name of files) assert(!fileOnDisk(name), 'файлът')
    assertNoTrace(user, 'след')
  })

  await check('[P4] Прекъсване между DB фазата и файловете: редовете ги няма, файловете още са на диска, заявката НЕ е completed; след рестарт worker-ът довършва', async () => {
    const user = registerUser('Interrupt')
    supportStore.sendUserMessage(user.profileId, 'Файл', await newImage())
    supportStore.sendAdminReply(user.profileId, 'Файл на екипа', await newImage())
    const files = filesOf(user.profileId)
    const requestId = insertDueRequest(user)
    const claimed = executor.claimNextDueRequest('w-interrupt', requestId)
    assert(claimed !== null, 'claim')
    assertEqual(executor.runDatabasePhase(claimed!, 'w-interrupt').kind, 'db_deleted', 'DB фаза')
    // "Срив" — файловата фаза не се изпълнява.
    const row = requestRow(requestId)
    assert(row.status === 'executing' && row.db_deleted_at !== null, JSON.stringify(row))
    assertNoTrace(user, 'редовете')
    for (const name of files) assert(fileOnDisk(name), 'файлът още е на диска')
    assert(queueOf(requestId).every((entry) => entry.status === 'pending'), 'опашката чака')
    db.prepare('UPDATE profile_deletion_requests SET lease_expires_at = ? WHERE request_id = ?;').run(new Date(Date.parse(dbNow()) - 1000).toISOString(), requestId)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).completed, 1, 'довършено')
    for (const name of files) assert(!fileOnDisk(name), 'файлът е изтрит')
    assertEqual(requestRow(requestId).status, 'completed', 'статус')
  })

  await check('[P5] Повторно изпълнение на worker-а: нищо не се взема; support таблиците и файловете са непроменени', async () => {
    const before = supportTablesDump() + JSON.stringify((await readdir(roots.supportAttachments)).sort())
    const requestIds = (db.prepare(`SELECT request_id FROM profile_deletion_requests WHERE status = 'completed';`).all() as Array<{ request_id: string }>).map((row) => row.request_id)
    assertEqual((await makeWorker(executor, requestIds).runOnce()).claimed, 0, 'нищо не е взето')
    assertEqual(supportTablesDump() + JSON.stringify((await readdir(roots.supportAttachments)).sort()), before, 'непроменено')
  })

  await check('[P6] Restore от стар backup: replayDeletionForRestore изтрива разговора и връща support файловете за премахване; чуждият разговор остава', async () => {
    const user = registerUser('Replay')
    supportStore.sendUserMessage(user.profileId, 'Стар разговор', await newImage())
    supportStore.sendAdminReply(user.profileId, 'Стар отговор', await newImage())
    supportStore.archiveConversation(user.profileId)
    const files = filesOf(user.profileId)
    const backupPath = join(root, `backup-${randomUUID()}.sqlite`)
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`)
    const restored = await createProfileDeletionExecutor(backupPath)
    try {
      const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
      const result = restored.replayDeletionForRestore({ profileId: user.profileId, accountIdSnapshot: user.accountId, profileCreatedAtSnapshot: createdAt })
      assert(result.kind === 'deleted', `резултат: ${result.kind}`)
      if (result.kind === 'deleted') {
        const supportFiles = result.files.filter((file) => file.fileKind === 'support_attachment').map((file) => file.storageRef).sort()
        assertEqual(JSON.stringify(supportFiles), JSON.stringify(files), 'файлове за премахване')
      }
    } finally {
      restored.close()
    }
    const backup = new sqliteModule.DatabaseSync(backupPath, { readOnly: true })
    try {
      const own = Number((backup.prepare('SELECT (SELECT COUNT(*) FROM support_messages WHERE profile_id = ?1) + (SELECT COUNT(*) FROM support_archived WHERE profile_id = ?1) AS c;').get(user.profileId) as { c: number }).c)
      assertEqual(own, 0, 'разговорът във възстановената база')
      assertEqual(Number((backup.prepare('SELECT COUNT(*) AS c FROM support_messages WHERE profile_id = ?;').get(bystander.profileId) as { c: number }).c), 2, 'чуждият разговор')
    } finally {
      backup.close()
    }
  })

  await check('[P7] Нарушен инвариант (чуждо support съобщение изчезва по време на изтриването): ROLLBACK, failed; профилът и двата разговора са непокътнати', async () => {
    const user = registerUser('Rollback')
    const other = registerUser('RollbackOther')
    supportStore.sendUserMessage(user.profileId, 'Мое', await newImage())
    supportStore.sendUserMessage(other.profileId, 'Чуждо')
    const before = supportSnapshotOf(user.profileId) + supportSnapshotOf(other.profileId)
    db.exec(`CREATE TRIGGER trg_test_lose_support AFTER DELETE ON profiles WHEN OLD.profile_id = '${user.profileId}'
      BEGIN DELETE FROM support_messages WHERE profile_id = '${other.profileId}'; END;`)
    let requestId = ''
    try {
      requestId = insertDueRequest(user)
      assertEqual((await makeWorker(executor, [requestId]).runOnce()).failed, 1, 'failed')
    } finally {
      db.exec('DROP TRIGGER trg_test_lose_support;')
    }
    const row = requestRow(requestId)
    assert(row.status === 'failed' && row.db_deleted_at === null && row.last_error_code === 'db_phase_error', JSON.stringify(row))
    assert(profileExists(user.profileId), 'профилът')
    assertEqual(supportSnapshotOf(user.profileId) + supportSnapshotOf(other.profileId), before, 'разговорите')
    assertEqual(queueOf(requestId).length, 0, 'опашката е върната')
    for (const name of filesOf(user.profileId)) assert(fileOnDisk(name), 'файлът')
  })

  await check('[P8] Защитено доказателство (отложено административно изтриване по support заявка): blocked support_evidence_hold, нищо не е изтрито; без него — изтриването минава', async () => {
    const user = registerUser('Hold')
    const admin = registerUser('HoldAdmin')
    const request = supportStore.sendUserMessage(user.profileId, 'Моля, изтрийте профила ми', await newImage())
    db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, requested_by_profile_id, reason, support_request_message_id)
      VALUES (?, ?, 'delete', ?, 'по заявка', ?);`).run(randomUUID(), user.profileId, admin.profileId, request.messageId)
    const before = supportSnapshotOf(user.profileId)
    const requestId = insertDueRequest(user)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).blocked, 1, 'blocked')
    const row = requestRow(requestId)
    assert(row.status === 'blocked' && row.last_error_code === 'support_evidence_hold' && row.db_deleted_at === null, JSON.stringify(row))
    assert(profileExists(user.profileId), 'профилът')
    assertEqual(supportSnapshotOf(user.profileId), before, 'разговорът')
    db.prepare('DELETE FROM pending_profile_moderation WHERE target_profile_id = ?;').run(user.profileId)
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(new Date(Date.parse(dbNow()) - 1000).toISOString(), requestId)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).completed, 1, 'completed след освобождаване')
    assertNoTrace(user, 'след')
  })

  await check('[P9] Няма осиротели support записи: нито ред, нито файл в support-attachments без ред (освен пропуснатия споделен); support_deletion_archives — непроменен', async () => {
    const deletedIds = (db.prepare(`SELECT profile_id FROM profile_deletion_requests WHERE status = 'completed';`).all() as Array<{ profile_id: string }>).map((row) => row.profile_id)
    assert(deletedIds.length >= 9, `изтрити: ${deletedIds.length}`)
    for (const profileId of deletedIds) assertEqual(supportRowsOf(profileId), 0, `редове на ${profileId}`)
    const orphanRows = count(`SELECT COUNT(*) AS c FROM support_messages m WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = m.profile_id) AND m.profile_id <> ?;`, archivedDeletedProfileId)
    assertEqual(orphanRows, 0, 'осиротели съобщения (без доказателствения архив)')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_archived sa WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = sa.profile_id);'), 0, 'осиротели маркери')
    const referenced = new Set((db.prepare('SELECT storage_filename AS f FROM support_message_attachments;').all() as Array<{ f: string }>).map((row) => row.f))
    const strayFiles = (await readdir(roots.supportAttachments)).filter((name) => !referenced.has(name))
    assertEqual(strayFiles.length, 0, `файлове без ред: ${strayFiles.join(',')}`)
    assertEqual(JSON.stringify([
      db.prepare('SELECT * FROM support_messages WHERE profile_id = ?;').all(archivedDeletedProfileId),
      db.prepare('SELECT * FROM support_deletion_archives;').all(),
    ]), evidenceArchiveBefore, 'доказателствен архив')
  })

  await check('[P10] Изтрит файл не се отваря през API-то: getAttachmentForDownload връща null за собственика и за пълен администратор; файлът го няма', async () => {
    const user = registerUser('Api')
    const image = await newImage()
    supportStore.sendUserMessage(user.profileId, 'Файл', image)
    assert(supportStore.getAttachmentForDownload(user.profileId, false, image.storageFilename) !== null, 'преди: собственикът')
    await deleteViaWorker(user)
    assertEqual(supportStore.getAttachmentForDownload(user.profileId, false, image.storageFilename), null, 'собственикът')
    assertEqual(supportStore.getAttachmentForDownload(randomUUID(), true, image.storageFilename), null, 'пълен администратор')
    assertEqual(supportStore.attachmentExistsForFilename(image.storageFilename), false, 'attachmentExistsForFilename')
    assert(!fileOnDisk(image.storageFilename), 'файлът')
  })

  console.log('\n[N] Нормална поддръжка за останалите')

  await check('[N1] Чуждият разговор (текст, файлове, отговори) е байт по байт непроменен след всички изтривания', () => {
    assertEqual(supportSnapshotOf(bystander.profileId), bystanderBefore, 'разговорът')
    for (const name of bystanderFiles) assert(fileOnDisk(name), 'файлът')
    assert(supportStore.getAttachmentForDownload(bystander.profileId, false, bystanderFiles[0]!) !== null, 'достъп на собственика')
  })

  await check('[N2] Нормалният поток работи: ново съобщение, отговор, прочитане, архивиране/разархивиране, 5-дневно почистване', async () => {
    const user = registerUser('Normal')
    supportStore.sendUserMessage(user.profileId, 'Нов въпрос', await newImage())
    assert(supportStore.sendAdminReply(user.profileId, 'Нов отговор') !== null, 'отговор')
    assertEqual(supportStore.getUnreadCountForUser(user.profileId), 1, 'непрочетени')
    supportStore.markReadByUser(user.profileId)
    assertEqual(supportStore.getUnreadCountForUser(user.profileId), 0, 'прочетени')
    supportStore.archiveConversation(user.profileId)
    supportStore.unarchiveConversation(user.profileId)
    assertEqual(supportStore.getMessages(user.profileId).length, 2, 'съобщения')
    const stale = registerUser('Stale')
    supportStore.sendUserMessage(stale.profileId, 'Стар')
    supportStore.sendAdminReply(stale.profileId, 'Стар отговор')
    db.prepare(`UPDATE support_messages SET created_at = datetime('now', '-6 days') WHERE profile_id = ?;`).run(stale.profileId)
    assert(supportStore.cleanupInactiveConversations() >= 1, 'почистване')
    assertEqual(supportStore.getMessages(stale.profileId).length, 0, 'старият разговор е почистен')
    assertEqual(supportStore.getMessages(user.profileId).length, 2, 'активният остава')
    assertEqual(supportSnapshotOf(bystander.profileId), bystanderBefore, 'чуждият')
  })

  for (const store of [executor, requestStore, authStore, progressStore, supportStore] as Array<{ close: () => void }>) {
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
