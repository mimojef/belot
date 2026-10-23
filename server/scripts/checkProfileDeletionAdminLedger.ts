/**
 * checkProfileDeletionAdminLedger.ts
 *
 * Етап 4F1 — административното окончателно изтриване минава през
 * независимия регистър (admin_delete_* записи), изпълнява се САМО след
 * offsite потвърждение и извън активна игра, а restore на стар backup
 * прилага отново доказано завършените изтривания. САМО временни бази.
 *
 * [A] Живо изтриване.  [R] Restore.  [H] Исторически изтривания (backfill).
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileBanStore } from '../src/db/profileBanStore.js'
import { createSupportStore } from '../src/db/supportStore.js'
import { createPendingProfileModerationStore } from '../src/db/pendingProfileModerationStore.js'
import { createProfileHardDeleteService } from '../src/db/profileHardDeleteService.js'
import { createProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { createAdminProfileDeletionCoordinator, type AdminProfileDeletionCoordinator } from '../src/core/adminProfileDeletionCoordinator.js'
import {
  ensureProfileDeletionLedgerEntry,
  ensureProfileDeletionLedgerRecord,
  getProfileDeletionLedgerOffsiteAckPath,
  isProfileDeletionLedgerRequestConfirmedOffsite,
  parseProfileDeletionLedgerBuffer,
  readProfileDeletionLedger,
  sha256Hex,
  summarizeAdminLedgerOperations,
  writeProfileDeletionLedgerOffsiteAck,
  type ProfileDeletionLedgerRecord,
} from '../src/db/profileDeletionLedger.js'
import { runProfileDeletionLedgerReconcile, REAPPLY_CONFIRMATION_PHRASE } from '../src/ops/profileDeletionLedgerReconcile.js'
import { runProfileDeletionAdminBackfill, ADMIN_BACKFILL_CONFIRMATION_PHRASE } from '../src/ops/profileDeletionAdminBackfill.js'
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

const sourceServerRoot = resolve(process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const SECRET = 'profile-deletion-admin-ledger-secret-0123456789'

console.log('\ncheckProfileDeletionAdminLedger')

const tempRoots: string[] = []
const sqliteModule = await import('node:sqlite')

try {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-admin-ledger-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
      await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const makeRoots = (base: string): ProfileDeletionUploadRoots => ({
    avatars: join(base, 'avatars'),
    profileGallery: join(base, 'profile-gallery'),
    chatAttachments: join(base, 'chat-attachments'),
    topicAttachments: join(base, 'topic-attachments'),
    topicMuteEvidenceAttachments: join(base, 'topic-mute-evidence-attachments'),
    supportAttachments: join(base, 'support-attachments'),
  })
  const uploadsBase = join(root, 'uploads')
  const roots = makeRoots(uploadsBase)
  for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })
  const ledgerPath = join(root, 'ledger', 'profile-deletions.jsonl')

  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const progressStore = await createPlayerProgressStore(databaseFilePath)
  const authStore = await createAuthStore(databaseFilePath, progressStore, {
    registrationVerificationCodeSecret: SECRET,
    getRegistrationVerificationMode: () => 'direct',
    getActiveBanForProfile: () => null,
  })
  const banStore = await createProfileBanStore(databaseFilePath)
  const supportStore = await createSupportStore(databaseFilePath, { hasPendingSupportRequestDelete: () => false })
  const pendingStore = await createPendingProfileModerationStore(databaseFilePath)
  const deleteUploadFileByUrl = async (url: string) => {
    const kind = url.startsWith('/uploads/avatars/') ? 'avatar' : url.startsWith('/uploads/profile-gallery/') ? 'gallery_image' : null
    if (kind !== null) await removeProfileDeletionFile(kind, url, roots)
  }
  const hardDeleteService = await createProfileHardDeleteService(databaseFilePath, { deleteUploadFileByUrl })
  const executor = await createProfileDeletionExecutor(databaseFilePath)
  const activeGame = new Set<string>()
  const coordinators: AdminProfileDeletionCoordinator[] = []
  const makeCoordinator = async (overrides: Partial<Parameters<typeof createAdminProfileDeletionCoordinator>[0]> = {}) => {
    const coordinator = await createAdminProfileDeletionCoordinator({
      databaseFilePath,
      hardDeleteService,
      pendingStore,
      ledgerPath,
      offsiteRequired: true,
      isTargetInActiveGame: (profileId) => activeGame.has(profileId),
      ...overrides,
    })
    coordinators.push(coordinator)
    return coordinator
  }
  const coordinator = await makeCoordinator()
  const selfWorker = (requestIds: string[]) => createProfileDeletionWorker({
    executor,
    workerId: `w-admin-ledger-${randomUUID().slice(0, 6)}`,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: (entry) => { ensureProfileDeletionLedgerEntry(ledgerPath, entry) },
    isLedgerEntryConfirmedOffsite: (requestId) => isProfileDeletionLedgerRequestConfirmedOffsite(ledgerPath, requestId),
    onlyRequestIds: requestIds,
  })

  type User = { profileId: string; accountId: string; displayName: string }
  let counter = 0
  const registerUser = (label: string, displayName?: string): User => {
    counter += 1
    const name = displayName ?? `Al${label}${counter}`
    const result = authStore.register({ email: `admin-ledger-${label.toLowerCase()}-${counter}@example.test`, password: 'secret123', displayName: name, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
    return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, displayName: name }
  }
  const count = (sql: string, ...params: Array<string | number | null>) => Number((db.prepare(sql).get(...params) as { c: number }).c)
  const profileExists = (profileId: string) => count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', profileId) === 1
  const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const pastIso = () => new Date(Date.parse(dbNow()) - 1000).toISOString()
  const ledgerRecords = (): ProfileDeletionLedgerRecord[] => readProfileDeletionLedger(ledgerPath).records
  const operationState = (operationId: string) => summarizeAdminLedgerOperations(ledgerRecords()).get(operationId)?.state ?? null
  /** Симулира pikabg-ledger-backup: потвърждава ТЕКУЩИЯ префикс на регистъра. */
  const confirmOffsite = () => {
    const buffer = readFileSync(ledgerPath)
    const parsed = parseProfileDeletionLedgerBuffer(buffer)
    const complete = buffer.subarray(0, parsed.completeBytes)
    writeProfileDeletionLedgerOffsiteAck(getProfileDeletionLedgerOffsiteAckPath(ledgerPath), {
      v: 1, bytes: complete.length, sha256: sha256Hex(complete), lineCount: parsed.lineCount, entryCount: parsed.records.length, remotePath: 'test:', confirmedAt: new Date().toISOString(),
    })
  }
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
  const runSelfDeletion = async (requestId: string) => {
    // 1) запис в регистъра -> blocked (чака offsite); 2) потвърждение; 3) изпълнение.
    await selfWorker([requestId]).runOnce()
    confirmOffsite()
    db.prepare(`UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ? AND status = 'blocked';`).run(pastIso(), requestId)
    return selfWorker([requestId]).runOnce()
  }
  const schedule = (target: User, supportRequestMessageId: string | null = null) => {
    const result = coordinator.schedule({ targetProfileId: target.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'нарушения', supportRequestMessageId })
    if (!result.ok) throw new Error(`schedule: ${JSON.stringify(result)}`)
    return result.operationId
  }
  const pendingFor = (operationId: string) => {
    const pending = pendingStore.getPendingDeleteByOperation(operationId)
    if (pending === null) throw new Error('няма висящ ред')
    return pending
  }
  const backup = (label: string): string => {
    const path = join(root, `backup-${label}.sqlite`)
    db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}';`)
    return path
  }
  const restore = async (backupPath: string, label: string, mode: 'apply' | 'verify' | 'report', existingCopy?: string) => {
    const dbCopy = existingCopy ?? join(root, `restore-${label}.sqlite`)
    if (existingCopy === undefined) copyFileSync(backupPath, dbCopy)
    const uploadsCopy = join(root, `restore-${label}-uploads`)
    for (const dir of Object.values(makeRoots(uploadsCopy))) await mkdir(dir, { recursive: true })
    const lines: string[] = []
    const argv = [`--db=${dbCopy}`, `--ledger=${ledgerPath}`, `--state-dir=${dbCopy}.state`]
    if (mode === 'apply') argv.push('--apply', `--confirm=${REAPPLY_CONFIRMATION_PHRASE}`, `--uploads-root=${uploadsCopy}`)
    if (mode === 'verify') argv.push('--verify-only')
    const code = await runProfileDeletionLedgerReconcile(argv, { log: (line) => lines.push(line), error: (line) => lines.push(line) })
    return { code, out: lines.join('\n'), dbCopy }
  }
  const inRestored = (dbCopy: string, sql: string, ...params: string[]) => {
    const restored = new sqliteModule.DatabaseSync(dbCopy, { readOnly: true })
    try {
      return Number((restored.prepare(sql).get(...params) as { c: number }).c)
    } finally {
      restored.close()
    }
  }

  const admin = registerUser('Admin')
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)

  // ─── Профили, които ще бъдат изтрити ПОСЛЕ — в стария backup те съществуват.
  const normal = registerUser('Normal')
  const inGame = registerUser('InGame')
  const legacy = registerUser('Legacy')
  const supportUser = registerUser('Support')
  const crashBefore = registerUser('CrashBefore')
  const crashAfter = registerUser('CrashAfter')
  const twin = registerUser('Twin', 'TwinName')
  const twinOther = registerUser('TwinOther')
  const selfFirst = registerUser('SelfFirst')
  const adminFirst = registerUser('AdminFirst')
  const historical = registerUser('Historical')
  const banned = registerUser('Banned')
  const unresolved = registerUser('Unresolved')
  const refused = registerUser('Refused')
  const bystander = registerUser('Bystander')
  assert(banStore.banProfile({ targetProfileId: banned.profileId, actorProfileId: admin.profileId, days: 30, reason: 'активен' }).ok, 'активен бан')
  const supportRequest = supportStore.sendUserMessage(supportUser.profileId, 'Моля, изтрийте профила ми')
  db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id) VALUES (?, 'Активен', 100, 'fill', 'open', ?);`).run(randomUUID(), refused.profileId)
  const oldBackup = backup('old')

  console.log('\n[A] Живо административно изтриване')

  let normalOp = ''
  await check('[A1] Нормално изтриване: намерение в регистъра; без offsite потвърждение НЕ се изпълнява; след потвърждение — изтрит, одитен ред log_id = operationId, admin_delete_completed', async () => {
    normalOp = schedule(normal)
    assertEqual(operationState(normalOp), 'intent_only', 'намерение')
    assertEqual((await coordinator.tryExecute(pendingFor(normalOp))).status, 'waiting_offsite', 'без потвърждение')
    assert(profileExists(normal.profileId), 'профилът още съществува')
    confirmOffsite()
    const summary = await coordinator.runOnce()
    assert(summary.executed >= 1, JSON.stringify(summary))
    assert(!profileExists(normal.profileId), 'профилът')
    assertEqual(count('SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE log_id = ? AND deleted_profile_id = ?;', normalOp, normal.profileId), 1, 'одит')
    assertEqual(operationState(normalOp), 'completed', 'регистърът')
    assertEqual(pendingStore.getPendingDeleteByOperation(normalOp), null, 'висящият ред')
    const intent = ledgerRecords().find((record) => 'kind' in record && record.kind === 'admin_delete_intent' && record.operationId === normalOp)
    assert(intent !== undefined && !JSON.stringify(intent).includes(normal.displayName) && !JSON.stringify(intent).includes('нарушения'), 'без име/причина в регистъра')
  })

  await check('[A2] Активен мач: runner-ът не изпълнява, докато профилът е в игра (дори при потвърден регистър); в края на мача — изпълнено', async () => {
    activeGame.add(inGame.profileId)
    const op = schedule(inGame)
    confirmOffsite()
    await coordinator.runOnce()
    assert(profileExists(inGame.profileId), 'не по време на игра')
    activeGame.delete(inGame.profileId)
    assertEqual((await coordinator.tryExecute(pendingFor(op))).status, 'completed', 'край на мача (hook)')
    assert(!profileExists(inGame.profileId), 'профилът')
    assertEqual(operationState(op), 'completed', 'регистърът')
  })

  await check('[A3] Отложено изтриване отпреди 4F1 (висящ ред без операция): получава операция и намерение; чака потвърждение; после — изпълнено', async () => {
    pendingStore.recordPendingDelete({ targetProfileId: legacy.profileId, requestedByProfileId: admin.profileId, requestedByAccountId: admin.accountId, reason: 'стар ред' })
    await coordinator.runOnce()
    const pending = pendingStore.getPending(legacy.profileId)
    assert(pending !== null && pending.ledgerOperationId !== null, 'операция')
    assertEqual(operationState(pending!.ledgerOperationId!), 'intent_only', 'намерение')
    assert(profileExists(legacy.profileId), 'чака потвърждение')
    confirmOffsite()
    await coordinator.runOnce()
    assert(!profileExists(legacy.profileId), 'изпълнено')
    assertEqual(operationState(pending!.ledgerOperationId!), 'completed', 'регистърът')
  })

  await check('[A4] Изтриване чрез support заявка: support_deletion_archives е създаден; намерението пази само идентификатора на съобщението', async () => {
    const op = schedule(supportUser, supportRequest.messageId)
    confirmOffsite()
    assertEqual((await coordinator.tryExecute(pendingFor(op))).status, 'completed', 'изпълнено')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_deletion_archives WHERE profile_id = ? AND request_message_id = ?;', supportUser.profileId, supportRequest.messageId), 1, 'архивът')
    const intent = summarizeAdminLedgerOperations(ledgerRecords()).get(op)
    assertEqual(intent?.supportRequestMessageId ?? null, supportRequest.messageId, 'идентификаторът')
  })

  await check('[A5] Неуспешно offsite потвърждение: без ack, ack за по-стар префикс, подменен регистър — изтриване няма; неуспешен запис в регистъра — няма и висящ ред (503)', async () => {
    const user = registerUser('Offsite')
    const ackPath = getProfileDeletionLedgerOffsiteAckPath(ledgerPath)
    confirmOffsite()
    const op = schedule(user) // след потвърждението -> не е в потвърдения префикс
    assertEqual((await coordinator.tryExecute(pendingFor(op))).status, 'waiting_offsite', 'по-стар префикс')
    await rm(ackPath, { force: true })
    assertEqual((await coordinator.tryExecute(pendingFor(op))).status, 'waiting_offsite', 'без ack')
    confirmOffsite()
    const original = readFileSync(ledgerPath)
    try {
      // Подменен (вече невалиден) регистър: fail-closed — никакво изтриване.
      await writeFile(ledgerPath, Buffer.concat([Buffer.from(original.subarray(0, 10)).fill(0x20, 0, 1), original.subarray(10)]))
      const tampered = (await coordinator.tryExecute(pendingFor(op))).status
      assert(tampered === 'waiting_offsite' || tampered === 'ledger_unavailable', `подменен регистър: ${tampered}`)
      // Регистър, чийто потвърден префикс е различен (байтът е в стойност): само чакане.
      const text = original.toString('utf8').replace(/"recordedAt":"(\d{4})/, (_m, year: string) => `"recordedAt":"${Number(year) - 1}`)
      await writeFile(ledgerPath, text)
      assertEqual((await coordinator.tryExecute(pendingFor(op))).status, 'waiting_offsite', 'различен префикс')
    } finally {
      await writeFile(ledgerPath, original)
    }
    assert(profileExists(user.profileId), 'профилът')
    const failing = await makeCoordinator({ appendRecord: () => { throw new Error('disk full') } })
    const refusedSchedule = failing.schedule({ targetProfileId: bystander.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'х', supportRequestMessageId: null })
    assert(!refusedSchedule.ok && refusedSchedule.code === 'ledger_unavailable', JSON.stringify(refusedSchedule))
    assertEqual(pendingStore.getPending(bystander.profileId), null, 'без висящ ред')
    // Почистване: операцията остава висяща (само намерение) — ще бъде отказана.
    pendingStore.clearPendingDeleteForOperation(op)
    coordinator.finalizeOperations()
    assertEqual(operationState(op), 'aborted', 'неизпълнена операция')
  })

  await check('[A6] Прекъсване преди DB COMMIT (грешка в транзакцията): нищо не е изтрито, висящият ред и намерението остават; после — изпълнено', async () => {
    const op = schedule(crashBefore)
    confirmOffsite()
    db.exec(`CREATE TRIGGER trg_test_crash BEFORE DELETE ON profiles WHEN OLD.profile_id = '${crashBefore.profileId}' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`)
    let threw = false
    try {
      await coordinator.tryExecute(pendingFor(op))
    } catch {
      threw = true
    } finally {
      db.exec('DROP TRIGGER trg_test_crash;')
    }
    assert(threw, 'грешката е видима')
    assert(profileExists(crashBefore.profileId), 'профилът')
    assertEqual(count('SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE log_id = ?;', op), 0, 'одитният ред е върнат')
    assertEqual(operationState(op), 'intent_only', 'само намерение')
    assertEqual((await coordinator.tryExecute(pendingFor(op))).status, 'completed', 'повторен опит')
  })

  await check('[A7] Прекъсване след COMMIT (записът за завършване се проваля): профилът е изтрит; finalize довършва записа по одитния ред', async () => {
    const op = schedule(crashAfter)
    confirmOffsite()
    const failing = await makeCoordinator({
      appendRecord: (path, record) => {
        if ('kind' in record && record.kind === 'admin_delete_completed') throw new Error('crash after commit')
        ensureProfileDeletionLedgerRecord(path, record)
      },
    })
    assertEqual((await failing.tryExecute(pendingFor(op))).status, 'completed', 'изпълнено')
    assert(!profileExists(crashAfter.profileId), 'профилът')
    assertEqual(operationState(op), 'intent_only', 'без запис за завършване')
    assert(coordinator.finalizeOperations() >= 1, 'finalize')
    assertEqual(operationState(op), 'completed', 'довършено')
  })

  await check('[A10a] Еднакви имена: изтрит е само профилът с този UUID; след това друг профил приема освободеното име', async () => {
    const op = schedule(twin)
    confirmOffsite()
    assertEqual((await coordinator.tryExecute(pendingFor(op))).status, 'completed', 'изпълнено')
    db.prepare(`UPDATE profiles SET display_name = 'TwinName', normalized_display_name = 'twinname' WHERE profile_id = ?;`).run(twinOther.profileId)
    assert(profileExists(twinOther.profileId), 'другият профил')
  })

  await check('[A11] Самоизтриване преди административното (4E6C): висящото административно изтриване е приключено; регистърът — admin_delete_resolved_by_self, без второ "завършено"', async () => {
    const requestId = insertDueRequest(selfFirst)
    const op = schedule(selfFirst)
    const summary = await runSelfDeletion(requestId)
    assertEqual(summary.completed, 1, `самоизтриването (${JSON.stringify(summary)})`)
    assertEqual(pendingStore.getPendingDeleteByOperation(op), null, 'висящият ред')
    coordinator.finalizeOperations()
    assertEqual(operationState(op), 'resolved_by_self', 'регистърът')
    assertEqual(count('SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE deleted_profile_id = ?;', selfFirst.profileId), 0, 'без административен одит')
  })

  await check('[A12] Административното изтриване преди самоизтриването: worker-ът отчита alreadyDeletedByAdmin; регистърът има и двата записа', async () => {
    const requestId = insertDueRequest(adminFirst)
    const op = schedule(adminFirst)
    confirmOffsite()
    assertEqual((await coordinator.tryExecute(pendingFor(op))).status, 'completed', 'административното')
    const summary = await runSelfDeletion(requestId)
    assertEqual(summary.completed, 1, `самоизтриването (${JSON.stringify(summary)})`)
    const event = db.prepare(`SELECT detail_json FROM profile_deletion_events WHERE request_id = ? AND event_type = 'db_deleted';`).get(requestId) as { detail_json: string }
    assertEqual((JSON.parse(event.detail_json) as { alreadyDeletedByAdmin: boolean }).alreadyDeletedByAdmin, true, 'alreadyDeletedByAdmin')
    assertEqual(operationState(op), 'completed', 'регистърът')
  })

  await check('[A15a] Активен бан не пречи на административното изтриване', async () => {
    const op = schedule(banned)
    confirmOffsite()
    assertEqual((await coordinator.tryExecute(pendingFor(op))).status, 'completed', 'изпълнено')
  })

  let refusedOp = ''
  await check('[A17] Отказано изпълнение (активен турнир): admin_delete_aborted; висящият ред е премахнат; профилът е непроменен', async () => {
    pendingStore.recordPendingDelete({ targetProfileId: refused.profileId, requestedByProfileId: admin.profileId, requestedByAccountId: admin.accountId, reason: 'х' })
    await coordinator.runOnce() // намерение
    refusedOp = pendingStore.getPending(refused.profileId)!.ledgerOperationId!
    confirmOffsite()
    const outcome = await coordinator.tryExecute(pendingFor(refusedOp))
    assert(outcome.status === 'refused' && outcome.code === 'active_tournament_dependency', JSON.stringify(outcome))
    assertEqual(operationState(refusedOp), 'aborted', 'регистърът')
    assert(profileExists(refused.profileId), 'профилът')
  })

  // Намерение, което никога не е било изпълнено (остава само намерение).
  const unresolvedOp = schedule(unresolved)

  console.log('\n[H] Исторически административни изтривания')

  await check('[H1] Старо административно изтриване (без регистър): restore на по-нова база -> admin_ledger_stale (fail-closed); backfill dry-run не пише; --apply добавя admin_delete_historical; повторно — нищо ново', async () => {
    const result = await hardDeleteService.hardDeleteProfile({ targetProfileId: historical.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'стар механизъм' })
    assert(result.ok, JSON.stringify(result))
    const newer = backup('newer')
    const stale = await restore(newer, 'stale', 'apply')
    assert(
      stale.code === 1 && stale.out.includes('admin_ledger_stale operationId=') && stale.out.includes('ERROR ledger_stale') && !stale.out.includes('admin_replay'),
      `stale (${stale.out.slice(-400)})`,
    )
    // --apply е отказан: нищо не е изтрито във възстановената база.
    assertEqual(inRestored(stale.dbCopy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', unresolved.profileId), 1, 'без промени')
    const lines: string[] = []
    const io = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) }
    const before = readFileSync(ledgerPath)
    assertEqual(await runProfileDeletionAdminBackfill([`--db=${databaseFilePath}`, `--ledger=${ledgerPath}`], io), 0, 'dry-run')
    assert(readFileSync(ledgerPath).equals(before), 'dry-run не пише')
    assert(lines.some((line) => line.includes(`eligible`) && line.includes(historical.profileId)), lines.join('\n'))
    assertEqual(await runProfileDeletionAdminBackfill([`--db=${databaseFilePath}`, `--ledger=${ledgerPath}`, '--apply'], io), 2, 'без потвърждение')
    assertEqual(await runProfileDeletionAdminBackfill([`--db=${databaseFilePath}`, `--ledger=${ledgerPath}`, '--apply', `--confirm=${ADMIN_BACKFILL_CONFIRMATION_PHRASE}`], io), 0, 'apply')
    const logId = (db.prepare('SELECT log_id FROM admin_profile_deletions WHERE deleted_profile_id = ?;').get(historical.profileId) as { log_id: string }).log_id
    assertEqual(operationState(logId), 'completed', 'исторически запис')
    const afterFirst = readFileSync(ledgerPath)
    lines.length = 0
    assertEqual(await runProfileDeletionAdminBackfill([`--db=${databaseFilePath}`, `--ledger=${ledgerPath}`, '--apply', `--confirm=${ADMIN_BACKFILL_CONFIRMATION_PHRASE}`], io), 0, 'повторно')
    assert(readFileSync(ledgerPath).equals(afterFirst), 'идемпотентно')
    assert(lines.some((line) => line.includes('"appended":0')), lines.join('\n'))
  })

  await check('[H2] Стар запис с недостатъчна информация: невалиден идентификатор/дата или профил, който съществува — НЕ се добавя, exit 1; съвпадение по име не се ползва', async () => {
    const insert = db.prepare(`INSERT INTO admin_profile_deletions (log_id, deleted_profile_id, deleted_account_id, username_snapshot, deleted_by_profile_id, reason, deleted_at) VALUES (?, ?, NULL, ?, NULL, 'х', ?);`)
    insert.run(randomUUID(), 'bad id!', 'Someone', '2026-01-01 10:00:00')
    insert.run(randomUUID(), randomUUID(), 'Other', 'не е дата')
    insert.run(randomUUID(), bystander.profileId, 'Bystander', '2026-01-01 10:00:00')
    // Име на изтрит профил, което сега носи друг (жив) профил — само UUID решава.
    insert.run(randomUUID(), randomUUID(), twinOther.displayName, '2026-01-02 10:00:00')
    const lines: string[] = []
    const code = await runProfileDeletionAdminBackfill([`--db=${databaseFilePath}`, `--ledger=${ledgerPath}`, '--apply', `--confirm=${ADMIN_BACKFILL_CONFIRMATION_PHRASE}`], { log: (line) => lines.push(line), error: (line) => lines.push(line) })
    assertEqual(code, 1, 'изисква внимание')
    const summary = lines.find((line) => line.includes('summary')) ?? ''
    assert(summary.includes('"insufficient":2') && summary.includes('"profilePresent":1') && summary.includes('"appended":1'), summary)
    assert(!ledgerRecords().some((record) => record.profileId === bystander.profileId), 'съществуващият профил не е добавен')
    assert(profileExists(twinOther.profileId), 'профилът със същото име')
    // Тестовите редове не са реални изтривания — махат се, за да не пречат на restore проверките.
    db.prepare(`DELETE FROM admin_profile_deletions WHERE deleted_profile_id IN ('bad id!', ?) OR deleted_at = 'не е дата';`).run(bystander.profileId)
  })

  console.log('\n[R] Restore на стар backup')

  const otherDump = (dbCopy: string) => {
    const restored = new sqliteModule.DatabaseSync(dbCopy, { readOnly: true })
    try {
      return JSON.stringify([
        restored.prepare('SELECT * FROM profile_wallets WHERE profile_id IN (?, ?, ?) ORDER BY profile_id;').all(bystander.profileId, twinOther.profileId, admin.profileId),
        restored.prepare('SELECT * FROM profile_bans WHERE COALESCE(profile_id, deleted_profile_id_snapshot) IS NOT ? ORDER BY ban_id;').all(banned.profileId),
        restored.prepare('SELECT * FROM coin_purchase_ledger ORDER BY purchase_id;').all(),
        restored.prepare('SELECT * FROM match_economy_ledger ORDER BY rowid;').all(),
        restored.prepare('SELECT * FROM profiles WHERE profile_id IN (?, ?, ?, ?) ORDER BY profile_id;').all(bystander.profileId, twinOther.profileId, admin.profileId, refused.profileId),
      ])
    } finally {
      restored.close()
    }
  }

  let restored = { code: -1, out: '', dbCopy: '' }
  const deletedLive = [normal, inGame, legacy, supportUser, crashBefore, crashAfter, twin, selfFirst, adminFirst, banned, historical]
  await check('[R1] Restore на база отпреди изтриванията: преди --apply профилите са "възкресени" (admin_missing); след --apply — изтрити със същия одит; activeban в стария backup не пречи; намерение без завършване — admin_unresolved (fail-closed)', async () => {
    const report = await restore(oldBackup, 'r1', 'report')
    assert(report.code === 1 && report.out.includes('admin_missing') && report.out.includes('admin_unresolved'), `report (${report.out.slice(-500)})`)
    const otherBefore = otherDump(report.dbCopy)
    restored = await restore(oldBackup, 'r1', 'apply', report.dbCopy)
    for (const user of deletedLive) {
      assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', user.profileId), 0, `${user.displayName} е върнат`)
    }
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE log_id = ? AND deleted_profile_id = ?;', normalOp, normal.profileId), 1, 'одитът със същия log_id')
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', unresolved.profileId), 1, 'неразрешеното намерение НЕ е изпълнено')
    assert(restored.out.includes(`admin_unresolved operationId=${unresolvedOp}`), 'диагностика')
    assertEqual(restored.code, 1, 'verify не е OK, докато има admin_unresolved')
    assertEqual(otherDump(restored.dbCopy), otherBefore, '[A16] финансовите и одитните стойности на другите профили')
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', refused.profileId), 1, 'отказаната операция не е изпълнена')
  })

  await check('[R1b] Различна идентичност (същият UUID, друг акаунт във възстановената база): admin_identity_mismatch — НЕ се изтрива, fail-closed', async () => {
    const copy = join(root, 'restore-mismatch.sqlite')
    copyFileSync(oldBackup, copy)
    const tamper = new sqliteModule.DatabaseSync(copy, { open: true })
    try {
      tamper.prepare('UPDATE profiles SET account_id = ? WHERE profile_id = ?;').run(bystander.accountId, normal.profileId)
    } finally {
      tamper.close()
    }
    const result = await restore(oldBackup, 'mismatch', 'apply', copy)
    assert(result.code !== 0 && result.out.includes(`admin_identity_mismatch operationId=${normalOp}`), `mismatch (${result.out.slice(-400)})`)
    assertEqual(inRestored(copy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', normal.profileId), 1, 'не е изтрит')
  })

  await check('[R2] [A15] Активен бан в стария backup + завършено административно изтриване: профилът е изтрит при restore', () => {
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM profile_bans WHERE deleted_profile_id_snapshot = ? AND profile_id IS NULL;', banned.profileId), 1, 'банът остава като следа')
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', banned.profileId), 0, 'профилът')
  })

  await check('[R3] [A10] Еднакви исторически имена: restore изтрива само UUID-то от регистъра; профилът, носещ сега същото име, е непроменен', () => {
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', twin.profileId), 0, 'изтритият')
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', twinOther.profileId), 1, 'другият')
  })

  await check('[R4] Повторен restore (--apply отново): нищо не се променя; без дублирани одитни редове', async () => {
    const auditCount = () => inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM admin_profile_deletions;')
    const before = auditCount()
    const again = await restore(oldBackup, 'r1', 'apply', restored.dbCopy)
    assert(!again.out.includes('admin_replay'), `без повторно прилагане (${again.out.slice(-300)})`)
    assertEqual(auditCount(), before, 'одитните редове')
  })

  await check('[R5] Висящ ред от стария backup за вече отказана операция НЕ се изпълнява повторно след restore', async () => {
    // Във възстановената база има висящ ред за refusedOp? Създаваме го както би бил в backup-а.
    const restoredDb = new sqliteModule.DatabaseSync(restored.dbCopy, { open: true, enableForeignKeyConstraints: true })
    try {
      restoredDb.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, requested_by_profile_id, requested_by_account_id, reason, ledger_operation_id) VALUES (?, ?, 'delete', ?, ?, 'х', ?);`)
        .run(randomUUID(), refused.profileId, admin.profileId, admin.accountId, refusedOp)
      restoredDb.prepare(`UPDATE tournaments SET status = 'finished' WHERE creator_profile_id = ?;`).run(refused.profileId)
    } finally {
      restoredDb.close()
    }
    const restoredPending = await createPendingProfileModerationStore(restored.dbCopy)
    const restoredHard = await createProfileHardDeleteService(restored.dbCopy, { deleteUploadFileByUrl: async () => {} })
    const restoredCoordinator = await createAdminProfileDeletionCoordinator({
      databaseFilePath: restored.dbCopy, hardDeleteService: restoredHard, pendingStore: restoredPending, ledgerPath, offsiteRequired: false, isTargetInActiveGame: () => false,
    })
    try {
      const summary = await restoredCoordinator.runOnce()
      assertEqual(summary.executed, 0, `изпълнени (${JSON.stringify(summary)})`)
    } finally {
      restoredCoordinator.close()
      restoredPending.close()
      restoredHard.close()
    }
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', refused.profileId), 1, 'профилът')
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE ledger_operation_id = ?;', refusedOp), 0, 'остарелият висящ ред е премахнат')
  })

  await check('[R6] [A11][A12] Самоизтриване преди/след административното: и двата профила липсват след restore; verify OK, след като неразрешеното намерение е приключено', async () => {
    assertEqual(inRestored(restored.dbCopy, 'SELECT COUNT(*) AS c FROM profiles WHERE profile_id IN (?, ?);', selfFirst.profileId, adminFirst.profileId), 0, 'профилите')
    // Неизпълненото намерение се приключва на живо (finalize) -> регистърът е последователен.
    pendingStore.clearPendingDeleteForOperation(unresolvedOp)
    coordinator.finalizeOperations()
    assertEqual(operationState(unresolvedOp), 'aborted', 'приключено')
    const verify = await restore(oldBackup, 'r1', 'verify', restored.dbCopy)
    assertEqual(verify.code, 0, `verify (${verify.out.slice(-400)})`)
  })

  for (const store of [executor, authStore, progressStore, banStore, supportStore, pendingStore, hardDeleteService, ...coordinators] as Array<{ close: () => void }>) {
    try { store.close() } catch { /* ignore */ }
  }
  db.close()
  void existsSync
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
