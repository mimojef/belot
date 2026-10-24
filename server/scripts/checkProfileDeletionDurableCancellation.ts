/**
 * checkProfileDeletionDurableCancellation.ts
 *
 * Самоизтриване, Етап 4J1 — отмяната на доброволна заявка оцелява при
 * restore на стар backup и никога не се губи заради неработещ offsite backup.
 *
 * Само временни бази и временен регистър. Реалните production модули:
 * request/admin/cancellation store, finalizer, executor, worker, reconcile и
 * реалната проверка на offsite ack-а (isProfileDeletionLedgerRecordConfirmedOffsite)
 * — нищо не се изключва с тестов флаг.
 *
 * [P] Протокол: потребител/администратор, бан, вече записано намерение,
 *     чакащ/невалиден/липсващ ack, прекъснат регистър, срокове.
 * [X] Срив между фазите (приемане, запис в регистъра, ack, финализиране).
 * [R] Restore/reconcile: А (отпреди отмяната), Б (между намерението и
 *     отмяната), след отмяната, В (изтриване преди отмяна), Г (непълен
 *     регистър), Д (повторно), невалидна последователност.
 * [C] Конкуренция: worker срещу отмяна, две отмени, без дублирани записи.
 * [K] Съвместимост: стари записи, строга схема на новите.
 *
 * Употреба (от server/): npx tsx scripts/checkProfileDeletionDurableCancellation.ts --server-root=.
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { createProfileDeletionAdminStore } from '../src/db/profileDeletionAdminStore.js'
import { createProfileDeletionCancellationStore } from '../src/db/profileDeletionCancellationStore.js'
import { createProfileDeletionCancellationFinalizer } from '../src/core/profileDeletionCancellationFinalizer.js'
import {
  appendProfileDeletionLedgerEntry,
  ensureProfileDeletionLedgerEntry,
  ensureProfileDeletionLedgerRecord,
  getProfileDeletionLedgerOffsiteAckPath,
  isProfileDeletionLedgerRequestConfirmedOffsite,
  isValidProfileDeletionLedgerRecord,
  parseProfileDeletionLedgerBuffer,
  readProfileDeletionLedger,
  summarizeAdminLedgerOperations,
  summarizeRequestLedgerState,
  writeProfileDeletionLedgerOffsiteAck,
  type ProfileDeletionRequestCancelledRecord,
} from '../src/db/profileDeletionLedger.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { REAPPLY_CONFIRMATION_PHRASE, runProfileDeletionLedgerReconcile } from '../src/ops/profileDeletionLedgerReconcile.js'
import type { ProfileDeletionUploadRoots } from '../src/uploads/profileDeletionFileRemoval.js'
import { writeTestLedgerAck } from './fixtures/profileDeletionCancellationKit.js'

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
function assert(condition: unknown, message: string): asserts condition {
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isoPlus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

const SECRET = 'profile-deletion-durable-cancellation-secret-0123456789'
const PASSWORD = 'secret123'
const REASON = 'Потребителят потвърди по телефона, че иска да запази профила.'
const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())

console.log('\ncheckProfileDeletionDurableCancellation')
console.log(`Server root: ${sourceServerRoot}`)

const sqliteModule = await import('node:sqlite')
const tempRoots: string[] = []
const closers: Array<() => void> = []

try {
  const root = await mkdtemp(join(tmpdir(), 'belot-4j1-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
      await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
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
  const requestStore2 = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
  closers.push(() => requestStore2.close())
  const executor = await createProfileDeletionExecutor(databaseFilePath)
  closers.push(() => executor.close())
  const adminStore = await createProfileDeletionAdminStore(databaseFilePath)
  closers.push(() => adminStore.close())
  const cancellationStore = await createProfileDeletionCancellationStore(databaseFilePath)
  closers.push(() => cancellationStore.close())
  const cancellationStore2 = await createProfileDeletionCancellationStore(databaseFilePath) // втори процес
  closers.push(() => cancellationStore2.close())

  const ledgerPath = join(root, 'deletion-ledger', 'profile-deletions.jsonl')
  const ackPath = getProfileDeletionLedgerOffsiteAckPath(ledgerPath)
  const finalizer = createProfileDeletionCancellationFinalizer({ store: cancellationStore, ledgerPath, offsiteRequired: true })
  const finalizer2 = createProfileDeletionCancellationFinalizer({ store: cancellationStore2, ledgerPath, offsiteRequired: true })
  const ack = () => writeTestLedgerAck(ledgerPath)

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

  /** Production конфигурацията на worker-а (index.ts): регистър + offsite + отмени + доказателство за изтриване. */
  const makeWorker = (onlyRequestIds?: string[], workerExecutor = executor, workerLedgerPath = ledgerPath) => createProfileDeletionWorker({
    executor: workerExecutor,
    workerId: `w-${randomUUID().slice(0, 6)}`,
    uploadRoots: roots,
    removeFile: async () => ({ outcome: 'deleted' }),
    appendLedgerEntry: (entry) => { ensureProfileDeletionLedgerEntry(workerLedgerPath, entry) },
    isLedgerEntryConfirmedOffsite: (requestId) => isProfileDeletionLedgerRequestConfirmedOffsite(workerLedgerPath, requestId),
    findLedgerCancellation: (requestId) => {
      const ledger = readProfileDeletionLedger(workerLedgerPath)
      if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) throw new Error('corrupt')
      return (ledger.records.find((r) => 'kind' in r && r.kind === 'request_cancelled' && r.requestId === requestId) as ProfileDeletionRequestCancelledRecord | undefined) ?? null
    },
    recordDbDeletion: (record) => { ensureProfileDeletionLedgerRecord(workerLedgerPath, record) },
    ...(onlyRequestIds !== undefined ? { onlyRequestIds } : {}),
  })

  type User = { profileId: string; accountId: string; email: string; displayName: string }
  let counter = 0
  function registerUser(label: string): User {
    counter += 1
    const email = `dur-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `Dur${label}${counter}`
    const result = authStore.register({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
    return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, email, displayName }
  }
  const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const createdAtOf = (user: User) => (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
  function insertRequest(user: User, scheduledFor: string, grace: 30 | 45 = 30): string {
    const requestId = randomUUID()
    const durationMs = grace === 30 ? PROFILE_DELETION_GRACE_PERIOD_MS : 45 * 24 * 3600 * 1000
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
    db.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
    try {
      db.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days) VALUES (?, ?, ?, ?, ?, ?, ?);`)
        .run(requestId, user.profileId, user.accountId, createdAtOf(user), isoPlus(scheduledFor, -durationMs), scheduledFor, grace)
    } finally {
      db.exec(sql)
    }
    return requestId
  }
  const overdue = (user: User, grace: 30 | 45 = 30) => insertRequest(user, isoPlus(dbNow(), -60_000), grace)
  const row = (requestId: string) => db.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, any>
  const cancellationRow = (requestId: string) => db.prepare('SELECT * FROM profile_deletion_cancellations WHERE request_id = ?;').get(requestId) as Record<string, any> | undefined
  const profileExists = (profileId: string) => db.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(profileId) !== undefined
  const retryNow = (requestId: string) => db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), requestId)
  const ledgerLinesFor = (key: string) => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '').split('\n').filter((line) => line.includes(`"kind":"${key}"`)).length
  const keyCount = (kind: string, requestId: string) => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '').split('\n')
    .filter((line) => line.includes(`"kind":"${kind}"`) && line.includes(`"requestId":"${requestId}"`)).length
  const userCancel = (user: User) => {
    const issued = requestStore.issueRestoreToken(user.profileId)
    if (!issued.ok) throw new Error(`токен: ${JSON.stringify(issued)}`)
    return requestStore.cancelWithToken(issued.restoreToken)
  }
  const admin = registerUser('Admin')
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)
  const adminCancel = (requestId: string) => adminStore.cancelVoluntaryRequestByAdmin({ requestId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: REASON })
  const ban = (user: User) => db.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason) VALUES (?, ?, datetime('now', '+5 days'), 'тест');`).run(randomUUID(), user.profileId)
  const vacuumTo = (name: string) => {
    const copy = join(root, name)
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}';`)
    return copy
  }
  async function reconcile(copy: string, extra: string[] = [], ledger = ledgerPath): Promise<{ code: number; lines: string[] }> {
    const uploads = join(root, `restored-uploads-${randomUUID().slice(0, 6)}`)
    await mkdir(uploads, { recursive: true })
    const lines: string[] = []
    const code = await runProfileDeletionLedgerReconcile(
      [`--db=${copy}`, `--ledger=${ledger}`, `--uploads-root=${uploads}`, ...extra],
      { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    )
    return { code, lines }
  }
  const APPLY = ['--apply', `--confirm=${REAPPLY_CONFIRMATION_PHRASE}`]
  const openCopy = (copy: string) => new sqliteModule.DatabaseSync(copy, { readOnly: true })

  // ═══ [P] Протокол ═══════════════════════════════════════════════════════
  console.log('\n[P] Протокол на трайната отмяна')

  await check('[1] Потребителска отмяна с валиден offsite ack: приета -> записана (source user) -> окончателна; събитие user; ledger без лични данни', () => {
    const user = registerUser('User')
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(created.ok, 'заявка')
    const result = userCancel(user)
    assert(result.ok && !result.alreadyAccepted, JSON.stringify(result))
    const requestId = created.ok ? created.request.requestId : ''
    assertEqual(row(requestId).status, 'pending', 'приета, не окончателна')
    assertEqual(finalizer.process(result.ok ? result.cancellationId : '').state, 'awaiting_offsite', 'без ack')
    assert(cancellationRow(requestId)!.ledger_recorded_at !== null, 'записана в регистъра')
    ack()
    const outcome = finalizer.process(result.ok ? result.cancellationId : '')
    assertEqual(outcome.state, 'finalized', 'след ack')
    assertEqual(row(requestId).status, 'cancelled', 'статус')
    const event = db.prepare(`SELECT actor_kind FROM profile_deletion_events WHERE request_id = ? AND event_type = 'cancelled';`).get(requestId) as { actor_kind: string }
    assertEqual(event.actor_kind, 'user', 'actor')
    const line = readFileSync(ledgerPath, 'utf8').split('\n').find((l) => l.includes('request_cancelled') && l.includes(requestId))!
    const parsed = JSON.parse(line) as Record<string, unknown>
    assertEqual(Object.keys(parsed).sort().join(','), 'cancellationId,kind,profileId,recordedAt,requestId,source,v', 'полета на записа')
    assertEqual(parsed.source, 'user', 'source')
    for (const secret of [user.email, user.displayName, PASSWORD]) assert(!line.includes(secret), `изтича ${secret}`)
  })

  await check('[2] Административна отмяна с причина: одит (причина + администратор) само в базата; в регистъра source admin без причина/администратор; окончателна след ack', () => {
    const user = registerUser('Admin2')
    const requestId = overdue(user)
    const result = adminCancel(requestId)
    assert(result.ok, JSON.stringify(result))
    const audit = db.prepare('SELECT reason, actor_profile_id FROM profile_deletion_admin_cancellations WHERE request_id = ?;').get(requestId) as { reason: string; actor_profile_id: string }
    assert(audit.reason === REASON && audit.actor_profile_id === admin.profileId, 'одит')
    finalizer.runOnce()
    ack()
    finalizer.runOnce()
    assertEqual(row(requestId).status, 'cancelled', 'статус')
    const text = readFileSync(ledgerPath, 'utf8')
    const line = text.split('\n').find((l) => l.includes('request_cancelled') && l.includes(requestId))!
    assert(line.includes('"source":"admin"') && !line.includes(REASON) && !line.includes(admin.profileId) && !line.includes(admin.accountId), 'регистърът')
  })

  await check('[3/4/22] Блокирана от бан заявка с вече записано и offsite-потвърдено намерение: отмяната е приета и окончателна; старото намерение е непроменено; банът остава; worker-ът никога не изтрива', async () => {
    const user = registerUser('Banned')
    const requestId = overdue(user)
    ban(user)
    await makeWorker([requestId]).runOnce() // намерение -> offsite_pending
    ack()
    retryNow(requestId)
    await makeWorker([requestId]).runOnce() // offsite ok -> DB фаза -> active_ban
    assertEqual(row(requestId).last_error_code, 'active_ban', 'блокирана от бан')
    assert(isProfileDeletionLedgerRequestConfirmedOffsite(ledgerPath, requestId), 'намерението е offsite')
    const intentBytes = readFileSync(ledgerPath)
    assert(adminCancel(requestId).ok, 'отмяна')
    finalizer.runOnce(); ack(); finalizer.runOnce()
    assertEqual(row(requestId).status, 'cancelled', 'статус')
    assert(readFileSync(ledgerPath).subarray(0, intentBytes.length).equals(intentBytes), 'по-ранните записи са променени')
    const state = summarizeRequestLedgerState(readProfileDeletionLedger(ledgerPath).records).get(requestId)!
    assert(state.intentIndex >= 0 && state.cancelIndex > state.intentIndex && state.resolution === 'cancelled', JSON.stringify(state))
    assert(db.prepare('SELECT 1 FROM profile_bans WHERE profile_id = ? AND lifted_at IS NULL;').get(user.profileId) !== undefined, 'банът остава')
    db.prepare(`UPDATE profile_bans SET lifted_at = CURRENT_TIMESTAMP WHERE profile_id = ?;`).run(user.profileId)
    await makeWorker().runOnce()
    assert(profileExists(user.profileId), 'профилът е изтрит след премахване на бана')
  })

  await check('[5/12] Чакащ offsite backup (backup-ът не работи): отмяната е приета на "29-ия ден", worker-ът НЕ изтрива след срока; ack след срока я прави окончателна', async () => {
    const user = registerUser('Day29')
    const requestId = insertRequest(user, isoPlus(dbNow(), 2000))
    const result = userCancel(user)
    assert(result.ok, JSON.stringify(result))
    finalizer.runOnce() // записана, без ack
    await sleep(2300)
    assert(row(requestId).scheduled_for < dbNow(), 'срокът изтече')
    assertEqual(executor.claimNextDueRequest('w-day30', requestId), null, 'claim след срока')
    const summary = await makeWorker([requestId]).runOnce()
    assertEqual(summary.claimed, 0, 'worker')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET status = 'executing', lease_owner = 'x', lease_expires_at = ? WHERE request_id = ?;`).run(isoPlus(dbNow(), 60_000), requestId), 'profile_deletion_cancellation_pending', 'тригерът срещу executing')
    assert(profileExists(user.profileId), 'профилът е запазен')
    ack()
    assertEqual(finalizer.process(result.ok ? result.cancellationId : '').state, 'finalized', 'финализиране след срока')
    assertEqual(row(requestId).status, 'cancelled', 'статус')
  })

  await check('[6/9] Невалиден ack (подменен SHA-256; регистърът е променен след ack-а): отмяната НЕ става окончателна', () => {
    const user = registerUser('BadAck')
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const result = userCancel(user)
    assert(created.ok && result.ok, 'fixture')
    finalizer.runOnce()
    const buffer = readFileSync(ledgerPath)
    const parsed = readProfileDeletionLedger(ledgerPath)
    writeProfileDeletionLedgerOffsiteAck(ackPath, { v: 1, bytes: buffer.length, sha256: 'f'.repeat(64), lineCount: parsed.lineCount, entryCount: parsed.records.length, remotePath: 'test-offsite:/x', confirmedAt: new Date().toISOString() })
    finalizer.runOnce()
    assertEqual(row(created.ok ? created.request.requestId : '').status, 'pending', 'SHA-256')
    // Валиден ack за ПРЕДИ последния запис (префикс без записа) — пак не.
    const prefixLength = buffer.lastIndexOf(0x0a, buffer.length - 2) + 1
    const prefix = buffer.subarray(0, prefixLength)
    const prefixParsed = parseProfileDeletionLedgerBuffer(prefix)
    writeProfileDeletionLedgerOffsiteAck(ackPath, { v: 1, bytes: prefix.length, sha256: createHash('sha256').update(prefix).digest('hex'), lineCount: prefixParsed.lineCount, entryCount: prefixParsed.records.length, remotePath: 'test-offsite:/x', confirmedAt: new Date().toISOString() })
    finalizer.runOnce()
    assertEqual(row(created.ok ? created.request.requestId : '').status, 'pending', 'префикс без записа')
    ack()
    finalizer.runOnce()
    assertEqual(row(created.ok ? created.request.requestId : '').status, 'cancelled', 'валиден ack')
  })

  await check('[7] Липсващ ack: отмяната остава приета (защитата е активна), не окончателна', () => {
    const user = registerUser('NoAck')
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(created.ok && userCancel(user).ok, 'fixture')
    invalidateAck(ackPath)
    finalizer.runOnce()
    assertEqual(row(created.ok ? created.request.requestId : '').status, 'pending', 'без ack')
    assert(cancellationRow(created.ok ? created.request.requestId : '')!.finalized_at === null, 'нефинализирана')
    ack()
    finalizer.runOnce()
    assertEqual(row(created.ok ? created.request.requestId : '').status, 'cancelled', 'с ack')
  })

  await check('[8] Прекъснат регистър: недовършена опашка се отрязва при записа; съкратен регистър (по-къс от ack-а) -> нищо не се финализира', () => {
    const user = registerUser('Partial')
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(created.ok && userCancel(user).ok, 'fixture')
    appendFileSync(ledgerPath, '{"v":1,"requestId":"half-writ')
    finalizer.runOnce()
    const parsed = readProfileDeletionLedger(ledgerPath)
    assert(parsed.invalidLineCount === 0 && parsed.trailingPartialBytes === 0, 'опашката не е отрязана')
    assertEqual(keyCount('request_cancelled', created.ok ? created.request.requestId : ''), 1, 'записът')
    // Ack за по-дълъг регистър от наличния (съкратен файл) -> отказ.
    const buffer = readFileSync(ledgerPath)
    writeProfileDeletionLedgerOffsiteAck(ackPath, { v: 1, bytes: buffer.length + 100, sha256: 'a'.repeat(64), lineCount: 1, entryCount: 1, remotePath: 'test-offsite:/x', confirmedAt: new Date().toISOString() })
    finalizer.runOnce()
    assertEqual(row(created.ok ? created.request.requestId : '').status, 'pending', 'съкратен регистър')
    ack()
    finalizer.runOnce()
    assertEqual(row(created.ok ? created.request.requestId : '').status, 'cancelled', 'валиден ack')
  })

  await check('[11/13] Потребител: приемане 2 s преди срока — да; нов опит след срока — отказ (функция и тригер); историческа 45-дневна — същото правило', async () => {
    const user = registerUser('Edge')
    const requestId = insertRequest(user, isoPlus(dbNow(), 2000))
    assert(userCancel(user).ok, 'преди срока')
    finalizer.runOnce(); ack(); finalizer.runOnce()
    assertEqual(row(requestId).status, 'cancelled', 'окончателна')
    const late = registerUser('Late')
    const lateId = insertRequest(late, isoPlus(dbNow(), 1200), 45)
    const issued = requestStore.issueRestoreToken(late.profileId)
    assert(issued.ok, 'токен')
    await sleep(1500)
    const refused = requestStore.cancelWithToken(issued.ok ? issued.restoreToken : '')
    assert(!refused.ok && refused.code === 'window_closed', JSON.stringify(refused))
    assertRejects(() => db.prepare(`INSERT INTO profile_deletion_cancellations (cancellation_id, request_id, profile_id, source, previous_status) VALUES (?, ?, ?, 'user', 'pending');`).run(randomUUID(), lateId, late.profileId), 'profile_deletion_cancel_window_closed', 'тригер')
    assertEqual(cancellationRow(lateId), undefined, 'няма трайна отмяна')
    assertEqual(Number(row(lateId).grace_period_days), 45, 'историческият срок')
  })

  await check('[14] Администратор след срока (историческа 45-дневна, безопасна): приета и окончателна', () => {
    const user = registerUser('Admin45')
    const requestId = overdue(user, 45)
    assert(adminCancel(requestId).ok, 'приета')
    finalizer.runOnce(); ack(); finalizer.runOnce()
    assertEqual(row(requestId).status, 'cancelled', 'окончателна')
  })

  await check('[15] След необратимо изтриване: администратор -> irreversible; потребителят няма токен; доказателство request_db_deleted в регистъра; профилът не се възстановява', async () => {
    const user = registerUser('Gone')
    const requestId = overdue(user)
    await makeWorker([requestId]).runOnce()
    ack()
    retryNow(requestId)
    await makeWorker([requestId]).runOnce()
    assertEqual(row(requestId).status, 'completed', 'изтрита')
    assertEqual(keyCount('request_db_deleted', requestId), 1, 'доказателство в регистъра')
    const result = adminCancel(requestId)
    assert(!result.ok && (result.code === 'irreversible' || result.code === 'not_found'), JSON.stringify(result))
    assertEqual(requestStore.issueRestoreToken(user.profileId).ok, false, 'токен')
    assert(!profileExists(user.profileId), 'профилът се върна')
    assertEqual(cancellationRow(requestId), undefined, 'трайна отмяна')
  })

  await check('[23] Служебните ограничения остават: само роля admin по базата може да приеме административна отмяна', () => {
    const user = registerUser('StaffTarget')
    const requestId = overdue(user)
    for (const role of ['subadmin', 'pika_team', 'marketing', 'top_chat_admin', 'chat_admin', 'player']) {
      db.prepare('UPDATE accounts SET role = ? WHERE account_id = ?;').run(role, admin.accountId)
      const result = adminCancel(requestId)
      assert(!result.ok && result.code === 'forbidden', `${role}: ${JSON.stringify(result)}`)
    }
    db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)
    assertEqual(cancellationRow(requestId), undefined, 'трайна отмяна')
  })

  // ═══ [X] Срив между фазите ══════════════════════════════════════════════
  console.log('\n[X] Срив между фазите')

  await check('[10a] Срив след приемането, преди записа в регистъра: при "рестарт" (нов store/finalizer) отмяната се записва и финализира; worker-ът е блокиран междувременно', async () => {
    const user = registerUser('CrashA')
    const requestId = overdue(user)
    assert(adminCancel(requestId).ok, 'приета')
    assertEqual(cancellationRow(requestId)!.ledger_recorded_at, null, 'незаписана')
    assertEqual((await makeWorker([requestId]).runOnce()).claimed, 0, 'worker')
    const restartedStore = await createProfileDeletionCancellationStore(databaseFilePath)
    try {
      const restarted = createProfileDeletionCancellationFinalizer({ store: restartedStore, ledgerPath, offsiteRequired: true })
      restarted.runOnce(); ack(); restarted.runOnce()
    } finally {
      restartedStore.close()
    }
    assertEqual(row(requestId).status, 'cancelled', 'окончателна')
    assertEqual(keyCount('request_cancelled', requestId), 1, 'един запис')
  })

  await check('[10b] Срив СЛЕД append в регистъра, ПРЕДИ COMMIT на маркировката: повторът не дублира реда; отмяната се довършва', () => {
    const user = registerUser('CrashB')
    const requestId = overdue(user)
    const accepted = adminCancel(requestId)
    assert(accepted.ok, 'приета')
    let crashed = false
    try {
      cancellationStore.recordInLedger(accepted.ok ? accepted.cancellationId : '', (r) => {
        appendProfileDeletionLedgerEntry(ledgerPath, { v: 1, kind: 'request_cancelled', requestId: r.requestId, profileId: r.profileId, cancellationId: r.cancellationId, source: r.source, recordedAt: new Date().toISOString() })
        throw new Error('simulated crash before COMMIT')
      })
    } catch {
      crashed = true
    }
    assert(crashed, 'симулиран срив')
    assertEqual(cancellationRow(requestId)!.ledger_recorded_at, null, 'маркировката е върната')
    assertEqual(keyCount('request_cancelled', requestId), 1, 'записът е в регистъра')
    finalizer.runOnce(); ack(); finalizer.runOnce()
    assertEqual(keyCount('request_cancelled', requestId), 1, 'без дубликат')
    assertEqual(row(requestId).status, 'cancelled', 'окончателна')
  })

  await check('[10c] Срив при финализирането (грешка преди COMMIT): нищо частично; следващото изпълнение финализира', () => {
    const user = registerUser('CrashC')
    const requestId = overdue(user)
    const accepted = adminCancel(requestId)
    assert(accepted.ok, 'приета')
    finalizer.runOnce(); ack()
    db.exec(`CREATE TRIGGER trg_test_fail_cancel_event BEFORE INSERT ON profile_deletion_events WHEN NEW.event_type = 'cancelled' AND NEW.request_id = '${requestId}' BEGIN SELECT RAISE(ABORT, 'simulated_crash'); END;`)
    try {
      assertRejects(() => cancellationStore.finalize(accepted.ok ? accepted.cancellationId : ''), 'simulated_crash', 'финализиране')
    } finally {
      db.exec('DROP TRIGGER trg_test_fail_cancel_event;')
    }
    assert(cancellationRow(requestId)!.finalized_at === null && row(requestId).status === 'pending', 'частична промяна')
    finalizer.runOnce()
    assertEqual(row(requestId).status, 'cancelled', 'окончателна')
  })

  // ═══ [C] Конкуренция ════════════════════════════════════════════════════
  console.log('\n[C] Конкуренция')

  await check('[20a] Worker claim по време на потребителска отмяна: writer lock-ът сериализира; след приемането worker-ът не може да вземе заявката', async () => {
    const user = registerUser('RaceUser')
    // Срокът е след busy_timeout-а (5 s), с който отмяната чака writer lock-а.
    const requestId = insertRequest(user, isoPlus(dbNow(), 9000))
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok, 'токен')
    const probe = new sqliteModule.DatabaseSync(databaseFilePath)
    probe.exec('PRAGMA busy_timeout = 0;')
    probe.exec('BEGIN IMMEDIATE;')
    let blocked = false
    try {
      requestStore2.cancelWithToken(issued.ok ? issued.restoreToken : '')
    } catch (error) {
      blocked = /locked|busy/i.test(String(error))
    } finally {
      probe.exec('ROLLBACK;')
      probe.close()
    }
    assert(blocked, 'отмяната не изчака writer lock-а')
    assert(requestStore2.cancelWithToken(issued.ok ? issued.restoreToken : '').ok, 'отмяна след освобождаване')
    while (dbNow() <= String(row(requestId).scheduled_for)) await sleep(200)
    assertEqual(executor.claimNextDueRequest('w-race', requestId), null, 'claim след срока')
  })

  await check('[20b] Worker взема първи (активен lease): административната отмяна -> lease_held без промяна; след освобождаването — приета; offsite ack по време на отмяната не я засяга', async () => {
    const user = registerUser('RaceLease')
    const requestId = overdue(user)
    const claimed = executor.claimNextDueRequest('w-lease', requestId)
    assert(claimed !== null, 'claim')
    const during = adminCancel(requestId)
    assert(!during.ok && during.code === 'lease_held', JSON.stringify(during))
    assertEqual(cancellationRow(requestId), undefined, 'без трайна отмяна')
    ensureProfileDeletionLedgerEntry(ledgerPath, { v: 1, requestId, profileId: user.profileId, accountIdSnapshot: claimed!.accountIdSnapshot, profileCreatedAtSnapshot: claimed!.profileCreatedAtSnapshot, requestedAt: claimed!.requestedAt, scheduledFor: claimed!.scheduledFor, recordedAt: new Date().toISOString() })
    executor.blockRequest(requestId, 'w-lease', 'ledger_offsite_pending')
    ack() // offsite потвърждението на намерението пристига
    assert(adminCancel(requestId).ok, 'приета')
    retryNow(requestId)
    assertEqual((await makeWorker([requestId]).runOnce()).claimed, 0, 'worker след приемането')
    finalizer.runOnce(); ack(); finalizer.runOnce()
    assertEqual(row(requestId).status, 'cancelled', 'окончателна')
    assert(profileExists(user.profileId), 'профилът')
  })

  await check('[20c] Паралелни отмени от администратор и потребител: една логическа отмяна; повторното подаване на потребителя е идемпотентно', () => {
    const user = registerUser('Both')
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(created.ok, 'заявка')
    const requestId = created.ok ? created.request.requestId : ''
    const first = userCancel(user)
    assert(first.ok, 'потребител')
    const second = adminCancel(requestId)
    assert(!second.ok && second.code === 'cancellation_pending', JSON.stringify(second))
    assertEqual(requestStore.issueRestoreToken(user.profileId).ok, false, 'нов токен при приета отмяна')
    assertEqual(Number((db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_cancellations WHERE request_id = ?;').get(requestId) as { c: number }).c), 1, 'една трайна отмяна')
    assertEqual(Number((db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_admin_cancellations WHERE request_id = ?;').get(requestId) as { c: number }).c), 0, 'без административен одит')
    finalizer.runOnce(); ack(); finalizer.runOnce()
  })

  await check('[21] Без дублирани записи: два "процеса" финализират едновременно и многократно -> един ред request_cancelled на заявка, едно събитие', () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const user = registerUser(`Dup${i}`)
      const requestId = overdue(user)
      assert(adminCancel(requestId).ok, 'приета')
      ids.push(requestId)
    }
    for (let i = 0; i < 3; i += 1) { finalizer.runOnce(); finalizer2.runOnce() }
    ack()
    for (let i = 0; i < 3; i += 1) { finalizer2.runOnce(); finalizer.runOnce() }
    for (const requestId of ids) {
      assertEqual(keyCount('request_cancelled', requestId), 1, `редове ${requestId}`)
      assertEqual(row(requestId).status, 'cancelled', 'статус')
      assertEqual(Number((db.prepare(`SELECT COUNT(*) AS c FROM profile_deletion_events WHERE request_id = ? AND event_type = 'cancelled';`).get(requestId) as { c: number }).c), 1, 'събития')
    }
    const parsed = readProfileDeletionLedger(ledgerPath)
    assertEqual(parsed.invalidLineCount + parsed.conflictingDuplicateCount, 0, 'регистърът е валиден')
  })

  await check('[22b] Бан, наложен по време на чакаща отмяна: финализирането е позволено, банът остава', () => {
    const user = registerUser('BanDuring')
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(created.ok && userCancel(user).ok, 'fixture')
    ban(user)
    finalizer.runOnce(); ack(); finalizer.runOnce()
    assertEqual(row(created.ok ? created.request.requestId : '').status, 'cancelled', 'статус')
    assert(db.prepare('SELECT 1 FROM profile_bans WHERE profile_id = ? AND lifted_at IS NULL;').get(user.profileId) !== undefined, 'банът')
  })

  // ═══ [R] Restore и reconcile ════════════════════════════════════════════
  console.log('\n[R] Restore и reconcile')

  await check('[16] Сценарий А — restore отпреди отмяната: reconcile възстановява трайната отмяна; worker-ът във възстановената база не изтрива; финализира се след ack', async () => {
    const user = registerUser('ScenarioA')
    const requestId = overdue(user)
    const copy = vacuumTo('scenario-a.sqlite')
    assert(adminCancel(requestId).ok, 'отмяна на живо')
    finalizer.runOnce(); ack(); finalizer.runOnce()
    const result = await reconcile(copy, [...APPLY, '--accept-stale-ledger'])
    assert(result.lines.some((l) => l.includes(`cancel_restore requestId=${requestId} result=inserted`)), result.lines.slice(-6).join(' | '))
    const restoredExecutor = await createProfileDeletionExecutor(copy)
    try {
      assertEqual(restoredExecutor.claimNextDueRequest('w-restored', requestId), null, 'claim във възстановената')
    } finally {
      restoredExecutor.close()
    }
    const restoredStore = await createProfileDeletionCancellationStore(copy)
    try {
      const restoredFinalizer = createProfileDeletionCancellationFinalizer({ store: restoredStore, ledgerPath, offsiteRequired: true })
      const outcomes = restoredFinalizer.runOnce()
      assert(outcomes.some((o) => o.state === 'finalized' && o.requestId === requestId), JSON.stringify(outcomes))
    } finally {
      restoredStore.close()
    }
    const restored = openCopy(copy)
    try {
      assertEqual((restored.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string }).status, 'cancelled', 'статус')
      assert(restored.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) !== undefined, 'профилът')
    } finally {
      restored.close()
    }
    assertEqual(keyCount('request_cancelled', requestId), 1, 'без дубликат в регистъра')
  })

  await check('[16b] Restore без reconcile: живият worker сам открива отмяната в регистъра и не изтрива', async () => {
    const user = registerUser('NoReconcile')
    const requestId = overdue(user)
    const copy = vacuumTo('no-reconcile.sqlite')
    assert(adminCancel(requestId).ok, 'отмяна')
    finalizer.runOnce(); ack(); finalizer.runOnce()
    const restoredExecutor = await createProfileDeletionExecutor(copy)
    try {
      const summary = await makeWorker([requestId], restoredExecutor).runOnce()
      assertEqual(summary.claimed, 1, 'взета (базата не знае за отмяната)')
      assertEqual(summary.completed, 0, 'изтрита')
    } finally {
      restoredExecutor.close()
    }
    const restored = openCopy(copy)
    try {
      assert(restored.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) !== undefined, 'профилът е изтрит')
      assert(restored.prepare('SELECT 1 FROM profile_deletion_cancellations WHERE request_id = ? AND recovered_from_ledger = 1;').get(requestId) !== undefined, 'трайната отмяна')
      assertEqual(keyCount(`request_db_deleted`, requestId), 0, 'доказателство за изтриване')
    } finally {
      restored.close()
    }
  })

  await check('[17] Сценарий Б — restore между намерението и отмяната: намерение в backup-а, по-нова отмяна в регистъра -> отмяната се спазва', async () => {
    const user = registerUser('ScenarioB')
    const requestId = overdue(user)
    await makeWorker([requestId]).runOnce() // намерение, чака offsite
    ack()
    const copy = vacuumTo('scenario-b.sqlite')
    assert(adminCancel(requestId).ok, 'отмяна')
    finalizer.runOnce(); ack(); finalizer.runOnce()
    const result = await reconcile(copy, [...APPLY, '--accept-stale-ledger'])
    assert(result.lines.some((l) => l.includes(`cancel_restore requestId=${requestId} result=inserted`)), result.lines.slice(-6).join(' | '))
    const restored = openCopy(copy)
    try {
      assert(restored.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) !== undefined, 'профилът е изтрит')
    } finally {
      restored.close()
    }
  })

  await check('[18/19] Restore след отмяната: чист (verify OK за отмените); повторен reconcile — идемпотентен, без нови редове и без промяна на регистъра', async () => {
    const copy = vacuumTo('after-cancel.sqlite')
    const ledgerHash = createHash('sha256').update(readFileSync(ledgerPath)).digest('hex')
    const first = await reconcile(copy, [...APPLY, '--accept-stale-ledger'])
    const countRows = () => {
      const restored = openCopy(copy)
      try { return Number((restored.prepare('SELECT COUNT(*) AS c FROM profile_deletion_cancellations;').get() as { c: number }).c) } finally { restored.close() }
    }
    const rowsAfterFirst = countRows()
    const second = await reconcile(copy, [...APPLY, '--accept-stale-ledger'])
    assertEqual(countRows(), rowsAfterFirst, 'нови редове при повторение')
    assert(!second.lines.some((l) => l.includes('cancel_restore ')), 'повторно възстановяване')
    assert(!first.lines.concat(second.lines).some((l) => l.includes('cancel_restore_needed') && l.includes('after-apply')), 'остава за възстановяване')
    assertEqual(createHash('sha256').update(readFileSync(ledgerPath)).digest('hex'), ledgerHash, 'reconcile промени регистъра')
    assert(second.lines.every((l) => !/\] cancel_conflict /.test(l)), 'конфликт')
  })

  await check('[В] Изтриване преди отмяна (доказателство в регистъра + по-късен запис за отмяна): изтриването има предимство — профилът не се възстановява', async () => {
    const user = registerUser('ScenarioC')
    const requestId = overdue(user)
    const copy = vacuumTo('scenario-c.sqlite')
    await makeWorker([requestId]).runOnce(); ack(); retryNow(requestId)
    await makeWorker([requestId]).runOnce()
    assertEqual(row(requestId).status, 'completed', 'изтрита на живо')
    // Невалидна последователност (напр. отмяна от невъзстановена база) — ръчно.
    appendProfileDeletionLedgerEntry(ledgerPath, { v: 1, kind: 'request_cancelled', requestId, profileId: user.profileId, cancellationId: randomUUID(), source: 'user', recordedAt: new Date().toISOString() })
    const state = summarizeRequestLedgerState(readProfileDeletionLedger(ledgerPath).records).get(requestId)!
    assert(state.resolution === 'deleted' && state.cancelIgnored, JSON.stringify(state))
    const result = await reconcile(copy, [...APPLY, '--accept-stale-ledger'])
    assert(result.lines.some((l) => l.includes(`cancel_ignored requestId=${requestId}`)), 'отчет')
    const restored = openCopy(copy)
    try {
      assert(restored.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) === undefined, 'профилът се върна след restore')
    } finally {
      restored.close()
    }
  })

  await check('[Г] Restore с непълен/невалиден/липсващ регистър: fail-closed (exit 2), нищо не се изтрива', async () => {
    const user = registerUser('ScenarioD')
    const requestId = overdue(user)
    await makeWorker([requestId]).runOnce() // намерение
    const copy = vacuumTo('scenario-d.sqlite')
    const missing = await reconcile(copy, [...APPLY], join(root, 'missing', 'profile-deletions.jsonl'))
    assertEqual(missing.code, 2, 'липсващ регистър')
    const corruptPath = join(root, 'corrupt', 'profile-deletions.jsonl')
    await mkdir(join(root, 'corrupt'), { recursive: true })
    writeFileSync(corruptPath, readFileSync(ledgerPath, 'utf8') + 'not-json\n')
    const corrupt = await reconcile(copy, [...APPLY], corruptPath)
    assertEqual(corrupt.code, 2, 'повреден регистър')
    const restored = openCopy(copy)
    try {
      assert(restored.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) !== undefined, 'изтрит при невалиден регистър')
    } finally {
      restored.close()
    }
    // Почистване: заявката се отменя (за да не пречи на следващите проверки).
    retryNow(requestId)
    assert(adminCancel(requestId).ok, 'отмяна')
    finalizer.runOnce(); ack(); finalizer.runOnce()
  })

  await check('[Д2] Невалидна последователност (отмяна ПРЕДИ намерението): cancel_conflict — нито изтриване, нито автоматична отмяна; exit ≠ 0', async () => {
    const user = registerUser('Conflict')
    const requestId = overdue(user)
    const conflictLedger = join(root, 'conflict', 'profile-deletions.jsonl')
    await mkdir(join(root, 'conflict'), { recursive: true })
    writeFileSync(conflictLedger, readFileSync(ledgerPath))
    const r = row(requestId)
    appendProfileDeletionLedgerEntry(conflictLedger, { v: 1, kind: 'request_cancelled', requestId, profileId: user.profileId, cancellationId: randomUUID(), source: 'user', recordedAt: new Date().toISOString() })
    appendProfileDeletionLedgerEntry(conflictLedger, { v: 1, requestId, profileId: user.profileId, accountIdSnapshot: r.account_id_snapshot, profileCreatedAtSnapshot: r.profile_created_at_snapshot, requestedAt: r.requested_at, scheduledFor: r.scheduled_for, recordedAt: new Date().toISOString() })
    const copy = vacuumTo('conflict.sqlite')
    const result = await reconcile(copy, [...APPLY, '--accept-stale-ledger'], conflictLedger)
    assert(result.code !== 0, `exit ${result.code}`)
    assert(result.lines.some((l) => l.includes(`cancel_conflict requestId=${requestId}`)), result.lines.slice(-5).join(' | '))
    const restored = openCopy(copy)
    try {
      assert(restored.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(user.profileId) !== undefined, 'изтрит при конфликт')
      assert(restored.prepare('SELECT 1 FROM profile_deletion_cancellations WHERE request_id = ?;').get(requestId) === undefined, 'автоматична отмяна при конфликт')
    } finally {
      restored.close()
    }
    retryNow(requestId)
    assert(adminCancel(requestId).ok, 'почистване')
    finalizer.runOnce(); ack(); finalizer.runOnce()
  })

  await check('[16c] Финализирана отмяна в базата, която липсва в регистъра (регистър по-стар от базата): reconcile -> ledger_stale', async () => {
    const copy = vacuumTo('stale.sqlite')
    const oldLedger = join(root, 'old', 'profile-deletions.jsonl')
    await mkdir(join(root, 'old'), { recursive: true })
    writeFileSync(oldLedger, '')
    const result = await reconcile(copy, [], oldLedger)
    assert(result.lines.some((l) => l.includes('ledger_stale')), result.lines.slice(-4).join(' | '))
    assert(result.code !== 0, `exit ${result.code}`)
  })

  // ═══ [K] Съвместимост ═══════════════════════════════════════════════════
  console.log('\n[K] Съвместимост')

  await check('[25] Стари валидни записи (намерение, административни) се четат непроменено; новите видове са строги (без допълнителни полета, напр. причина)', () => {
    const legacyIntent = { v: 1, requestId: 'req-1', profileId: 'p-1', accountIdSnapshot: 'a-1', profileCreatedAtSnapshot: '2026-01-01 00:00:00', requestedAt: '2026-01-01T00:00:00.000Z', scheduledFor: '2026-02-15T00:00:00.000Z', recordedAt: '2026-02-15T00:00:01.000Z' }
    const legacyAdmin = { v: 1, kind: 'admin_delete_completed', operationId: 'op-1', profileId: 'p-2', deletedAt: '2026-01-02T00:00:00.000Z', recordedAt: '2026-01-02T00:00:01.000Z' }
    assert(isValidProfileDeletionLedgerRecord(legacyIntent) && isValidProfileDeletionLedgerRecord(legacyAdmin), 'старите записи')
    const parsed = parseProfileDeletionLedgerBuffer(Buffer.from(`${JSON.stringify(legacyIntent)}\n${JSON.stringify(legacyAdmin)}\n`))
    assert(parsed.invalidLineCount === 0 && parsed.entries.length === 1 && summarizeAdminLedgerOperations(parsed.records).get('op-1')?.state === 'completed', 'парсване')
    assertEqual(summarizeRequestLedgerState(parsed.records).get('req-1')?.resolution, 'intent', 'старо намерение -> досегашното поведение')
    const cancelRecord = { v: 1, kind: 'request_cancelled', requestId: 'req-1', profileId: 'p-1', cancellationId: 'c-1', source: 'admin', recordedAt: '2026-02-01T00:00:00.000Z' }
    assert(isValidProfileDeletionLedgerRecord(cancelRecord), 'нов запис')
    assert(!isValidProfileDeletionLedgerRecord({ ...cancelRecord, reason: 'лична информация' }), 'допълнително поле (причина)')
    assert(!isValidProfileDeletionLedgerRecord({ ...cancelRecord, source: 'moderator' }), 'непознат източник')
    assert(!isValidProfileDeletionLedgerRecord({ ...cancelRecord, kind: 'request_restored' }), 'непознат вид')
    const withCancel = parseProfileDeletionLedgerBuffer(Buffer.from(`${JSON.stringify(legacyIntent)}\n${JSON.stringify(cancelRecord)}\n`))
    assertEqual(withCancel.entries.length, 1, 'отмяната не е "намерение"')
    assertEqual(summarizeAdminLedgerOperations(withCancel.records).size, 0, 'отмяната не е административна операция')
    assertEqual(summarizeRequestLedgerState(withCancel.records).get('req-1')?.resolution, 'cancelled', 'отмяната след намерението')
  })

  await check('[Z] Интегритет и външни ключове; регистърът е валиден', () => {
    assertEqual((db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check, 'ok', 'integrity_check')
    assertEqual((db.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
    const parsed = readProfileDeletionLedger(ledgerPath)
    assertEqual(parsed.invalidLineCount + parsed.conflictingDuplicateCount, 0, 'регистърът')
    assert(ledgerLinesFor('request_cancelled') > 0, 'има записи за отмяна')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const close of closers.splice(0).reverse()) { try { close() } catch { /* ignore */ } }
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** Празен ack файл = невалиден/липсващ ack (readProfileDeletionLedgerOffsiteAck -> null). */
function invalidateAck(path: string): void {
  writeFileSync(path, '')
}

console.log('\n════════════════════════════════════════════════════════════')
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
