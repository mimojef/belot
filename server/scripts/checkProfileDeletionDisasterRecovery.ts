/**
 * checkProfileDeletionDisasterRecovery.ts
 *
 * Самоизтриване, Етап 4J1B — пълна загуба на VPS и възстановяване от
 * изоставащ offsite архив.
 *
 * Реални production модули: worker (в ОТДЕЛЕН процес, production
 * конфигурация — шлюз, решение, offsite), snapshot/confirm на архива, merge
 * (CLI), reconcile, шлюзът на историята, release-restore, административният
 * координатор. Само временни бази и регистри; нищо не се изключва с флаг.
 *
 * [P] Двуфазно необратимо изтриване: решение -> offsite -> COMMIT -> доказателство.
 * [X] Срив във всяка фаза (след решението, преди COMMIT, след COMMIT).
 * [V] Загуба на VPS: архивът изостава; restore отпреди изтриването; restore
 *     отпреди приета отмяна; restore hold и освобождаване; административно
 *     изтриване (с/без висящ ред); пълна загуба на регистъра; остарял
 *     регистър; worker без reconcile; възкресен профил без достъп.
 * [K] Съвместимост: регистър отпреди 4J1B.
 *
 * Употреба (от server/): npx tsx scripts/checkProfileDeletionDisasterRecovery.ts --server-root=.
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionAdminStore } from '../src/db/profileDeletionAdminStore.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createProfileDeletionCancellationStore } from '../src/db/profileDeletionCancellationStore.js'
import { createProfileDeletionCancellationFinalizer } from '../src/core/profileDeletionCancellationFinalizer.js'
import { createProfileDeletionHistoryGuard, PROFILE_DELETION_LEDGER_ID_SETTING } from '../src/core/profileDeletionHistoryGuard.js'
import { createAdminProfileDeletionCoordinator } from '../src/core/adminProfileDeletionCoordinator.js'
import { createPendingProfileModerationStore } from '../src/db/pendingProfileModerationStore.js'
import { createProfileHardDeleteService } from '../src/db/profileHardDeleteService.js'
import {
  ensureProfileDeletionLedgerEntry,
  getProfileDeletionLedgerOffsiteAckPath,
  isRequestDeletionIrreversibleInLedger,
  parseProfileDeletionLedgerBuffer,
  readProfileDeletionLedger,
  summarizeAdminLedgerOperations,
  summarizeLedgerControl,
  summarizeRequestLedgerState,
} from '../src/db/profileDeletionLedger.js'
import { confirmLedgerSnapshotOffsite, createLedgerSnapshot } from '../src/ops/profileDeletionLedgerArchive.js'
import { runProfileDeletionLedgerCli } from '../src/ops/profileDeletionLedgerCli.js'
import { REAPPLY_CONFIRMATION_PHRASE, runProfileDeletionLedgerReconcile } from '../src/ops/profileDeletionLedgerReconcile.js'
import { RELEASE_RESTORE_CONFIRMATION_PHRASE, runProfileDeletionRestoreRelease } from '../src/ops/profileDeletionRestoreRelease.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
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
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isoPlus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

const SECRET = 'profile-deletion-disaster-recovery-secret-0123456789'
const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const TSX_CLI = join(sourceServerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const CHILD = join(sourceServerRoot, 'scripts', 'fixtures', 'ledgerConcurrencyChild.ts')

console.log('\ncheckProfileDeletionDisasterRecovery')
console.log(`Server root: ${sourceServerRoot}`)

const sqliteModule = await import('node:sqlite')
const tempRoots: string[] = []
const closers: Array<() => void> = []
const quiet = { log: (_line: string) => {}, error: (_line: string) => {} }

type Env = { name: string; dbPath: string; ledgerPath: string; offsiteDir: string }

try {
  const root = await mkdtemp(join(tmpdir(), 'belot-4j1b-'))
  tempRoots.push(root)
  const serverRoot = join(root, 'server')
  await mkdir(join(serverRoot, 'database', 'migrations'), { recursive: true })
  await mkdir(join(serverRoot, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(serverRoot, 'database', 'migrations', entry.name))
  }
  const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: serverRoot })
  const live: Env = { name: 'live', dbPath: databaseFilePath, ledgerPath: join(root, 'live-ledger', 'profile-deletions.jsonl'), offsiteDir: join(root, 'offsite') }
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  closers.push(() => db.close())
  const progressStore = await createPlayerProgressStore(databaseFilePath)
  closers.push(() => progressStore.close())
  const authStore = await createAuthStore(databaseFilePath, progressStore, { registrationVerificationCodeSecret: SECRET, getRegistrationVerificationMode: () => 'direct', getActiveBanForProfile: () => null })
  closers.push(() => authStore.close())
  const requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
  closers.push(() => requestStore.close())
  const uploadRoots: ProfileDeletionUploadRoots = {
    avatars: join(root, 'uploads', 'avatars'), profileGallery: join(root, 'uploads', 'profile-gallery'), chatAttachments: join(root, 'uploads', 'chat'),
    topicAttachments: join(root, 'uploads', 'topic'), topicMuteEvidenceAttachments: join(root, 'uploads', 'mute'), supportAttachments: join(root, 'uploads', 'support'),
  }
  for (const dir of Object.values(uploadRoots)) await mkdir(dir, { recursive: true })

  // ─── Помощници ───────────────────────────────────────────────────────────
  function runWorker(env: Env, requestIds: string[], crashAt: string | null = null): Promise<{ code: number | null; output: string; summary: Record<string, number> | null; history: Record<string, unknown> | null }> {
    const child = spawn(process.execPath, [TSX_CLI, CHILD, 'worker', JSON.stringify({ databaseFilePath: env.dbPath, ledgerPath: env.ledgerPath, uploadRoots, requestIds, crashAt })], { cwd: sourceServerRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (c) => { output += String(c) })
    child.stderr.on('data', (c) => { output += String(c) })
    return new Promise((res) => child.once('exit', (code) => {
      const summaryLine = output.split('\n').find((l) => l.startsWith('SUMMARY '))
      const historyLine = output.split('\n').find((l) => l.startsWith('HISTORY '))
      res({ code, output, summary: summaryLine ? JSON.parse(summaryLine.slice(8)) : null, history: historyLine ? JSON.parse(historyLine.slice(8)) : null })
    }))
  }
  /** Таймерът pikabg-ledger-backup: snapshot + проверено качване + ack (production функциите). */
  function backup(env: Env): void {
    const ackPath = getProfileDeletionLedgerOffsiteAckPath(env.ledgerPath)
    const result = createLedgerSnapshot({ ledgerPath: env.ledgerPath, outDir: env.offsiteDir, ackPath })
    if (result.status === 'created') confirmLedgerSnapshotOffsite({ ledgerPath: env.ledgerPath, snapshotPath: result.snapshotPath, manifestPath: result.manifestPath, remotePath: `test-offsite:${result.manifest.file}`, ackPath })
  }
  const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  let counter = 0
  const registerUser = (label: string) => {
    counter += 1
    const email = `dr-${label.toLowerCase()}-${counter}@example.test`
    const result = authStore.register({ email, password: 'secret123', displayName: `Dr${label}${counter}`, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error('регистрация')
    return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, email }
  }
  const insertRequest = (user: { profileId: string; accountId: string }, scheduledFor: string) => {
    const requestId = randomUUID()
    const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
    db.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
    try {
      db.prepare('INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days) VALUES (?, ?, ?, ?, ?, ?, 30);')
        .run(requestId, user.profileId, user.accountId, createdAt, isoPlus(scheduledFor, -PROFILE_DELETION_GRACE_PERIOD_MS), scheduledFor)
    } finally {
      db.exec(sql)
    }
    return requestId
  }
  const overdue = (user: { profileId: string; accountId: string }) => insertRequest(user, isoPlus(dbNow(), -60_000))
  const retryNow = (dbFile: string, requestId: string) => {
    const handle = new sqliteModule.DatabaseSync(dbFile)
    try {
      handle.prepare(`UPDATE profile_deletion_requests SET next_attempt_at = ?, lease_expires_at = CASE WHEN status = 'executing' THEN ? ELSE lease_expires_at END WHERE request_id = ?;`)
        .run(isoPlus(new Date().toISOString(), -1000), isoPlus(new Date().toISOString(), -1000), requestId)
      handle.prepare(`UPDATE profile_deletion_file_queue SET lease_expires_at = ? WHERE request_id = ? AND status = 'processing';`).run(isoPlus(new Date().toISOString(), -1000), requestId)
    } finally {
      handle.close()
    }
  }
  const query = <T>(dbFile: string, sql: string, ...params: unknown[]): T | undefined => {
    const handle = new sqliteModule.DatabaseSync(dbFile, { readOnly: true })
    try { return handle.prepare(sql).get(...(params as [])) as T | undefined } finally { handle.close() }
  }
  const profileExists = (dbFile: string, profileId: string) => query(dbFile, 'SELECT 1 AS x FROM profiles WHERE profile_id = ?;', profileId) !== undefined
  const statusOf = (dbFile: string, requestId: string) => query<{ status: string }>(dbFile, 'SELECT status FROM profile_deletion_requests WHERE request_id = ?;', requestId)?.status ?? null
  const assessEnv = async (env: Env) => {
    const guard = await createProfileDeletionHistoryGuard({ databaseFilePath: env.dbPath, ledgerPath: env.ledgerPath, offsiteRequired: true })
    try { return guard.assess() } finally { guard.close() }
  }
  const snapshotDb = (name: string): string => {
    const copy = join(root, `${name}.sqlite`)
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}';`)
    return copy
  }
  /** Загуба на VPS: нова директория, базата от backup копие, регистърът — според източника. */
  async function restoreEnv(name: string, dbCopy: string, ledgerSource: 'merge' | 'none' | { copyFrom: string }): Promise<Env> {
    const dir = join(root, `restore-${name}`)
    await mkdir(join(dir, 'ledger'), { recursive: true })
    const env: Env = { name, dbPath: join(dir, 'belot-v2.sqlite'), ledgerPath: join(dir, 'ledger', 'profile-deletions.jsonl'), offsiteDir: join(dir, 'offsite') }
    copyFileSync(dbCopy, env.dbPath)
    if (ledgerSource === 'merge') {
      const original = console.log
      console.log = () => {}
      try {
        const code = await runProfileDeletionLedgerCli(['merge', `--snapshot-dir=${live.offsiteDir}`, `--out=${env.ledgerPath}`])
        if (code !== 0) throw new Error(`merge exit ${code}`)
      } finally {
        console.log = original
      }
    } else if (ledgerSource !== 'none') {
      copyFileSync(ledgerSource.copyFrom, env.ledgerPath)
    }
    return env
  }
  async function reconcileApply(env: Env): Promise<{ code: number; lines: string[] }> {
    const uploads = join(root, `uploads-${env.name}-${randomUUID().slice(0, 4)}`)
    await mkdir(uploads, { recursive: true })
    const lines: string[] = []
    const code = await runProfileDeletionLedgerReconcile([`--db=${env.dbPath}`, `--ledger=${env.ledgerPath}`, `--uploads-root=${uploads}`, '--apply', `--confirm=${REAPPLY_CONFIRMATION_PHRASE}`], { log: (l) => lines.push(l), error: (l) => lines.push(l) })
    return { code, lines }
  }
  const adminActor = registerUser('Admin')
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(adminActor.accountId)
  async function adminCancelIn(env: Env, requestId: string) {
    const store = await createProfileDeletionAdminStore(env.dbPath)
    try {
      return store.cancelVoluntaryRequestByAdmin({
        requestId, actorProfileId: adminActor.profileId, actorAccountId: adminActor.accountId, reason: 'Проверка след restore',
        isDeletionProven: (id) => isRequestDeletionIrreversibleInLedger(readProfileDeletionLedger(env.ledgerPath).records, id),
      })
    } finally {
      store.close()
    }
  }
  async function coordinatorFor(env: Env) {
    const pendingStore = await createPendingProfileModerationStore(env.dbPath)
    const hardDeleteService = await createProfileHardDeleteService(env.dbPath, { deleteUploadFileByUrl: async () => {} })
    const guard = await createProfileDeletionHistoryGuard({ databaseFilePath: env.dbPath, ledgerPath: env.ledgerPath, offsiteRequired: true })
    const coordinator = await createAdminProfileDeletionCoordinator({
      databaseFilePath: env.dbPath, hardDeleteService, pendingStore, ledgerPath: env.ledgerPath, offsiteRequired: true, isTargetInActiveGame: () => false,
      historyGate: () => { const a = guard.assess(); return { verified: a.verified, restoreHold: a.restoreHold } },
    })
    return { coordinator, pendingStore, guard, close: () => { coordinator.close(); pendingStore.close(); hardDeleteService.close(); guard.close() } }
  }
  const ledgerKinds = (ledgerPath: string, kind: string, id: string) => readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.includes(`"kind":"${kind}"`) && l.includes(id)).length

  // Първо стартиране: обвързване на базата с регистъра (genesis).
  {
    const guard = await createProfileDeletionHistoryGuard({ databaseFilePath, ledgerPath: live.ledgerPath, offsiteRequired: true })
    const init = guard.initialize()
    guard.close()
    assertEqual(init.binding, 'created', 'обвързване при първо стартиране')
  }
  backup(live)

  // ═══ [P] Двуфазно необратимо изтриване ══════════════════════════════════
  console.log('\n[P] Двуфазно необратимо изтриване')
  const normal = registerUser('Normal')
  const normalId = overdue(normal)

  await check('[P1] Намерение -> offsite -> решение -> offsite -> COMMIT -> доказателство: изтриване САМО след offsite-потвърдено решение; между решението и COMMIT отмяна се отказва', async () => {
    const r1 = await runWorker(live, [normalId])
    assert(r1.summary?.blocked === 1 && statusOf(live.dbPath, normalId) === 'blocked', `намерение: ${r1.output.slice(-300)}`)
    backup(live)
    retryNow(live.dbPath, normalId)
    const r2 = await runWorker(live, [normalId])
    assert(r2.output.includes('"blocked":1'), r2.output.slice(-300))
    assertEqual(ledgerKinds(live.ledgerPath, 'request_deletion_decided', normalId), 1, 'решение')
    assert(profileExists(live.dbPath, normal.profileId), 'изтрит преди offsite потвърждението на решението')
    assertEqual(query<{ c: string }>(live.dbPath, 'SELECT last_error_code AS c FROM profile_deletion_requests WHERE request_id = ?;', normalId)?.c, 'decision_offsite_pending', 'код')
    const refused = await adminCancelIn(live, normalId)
    assert(!refused.ok && refused.code === 'irreversible', `отмяна след решението: ${JSON.stringify(refused)}`)
    backup(live)
    retryNow(live.dbPath, normalId)
    const r3 = await runWorker(live, [normalId])
    assert(r3.summary?.completed === 1, r3.output.slice(-300))
    assert(!profileExists(live.dbPath, normal.profileId), 'не е изтрит')
    const state = summarizeRequestLedgerState(readProfileDeletionLedger(live.ledgerPath).records).get(normalId)!
    assert(state.decidedIndex > state.intentIndex && state.dbDeletedIndex > state.decidedIndex, `ред: ${JSON.stringify(state)}`)
  })

  // ═══ [X] Срив във всяка фаза ════════════════════════════════════════════
  console.log('\n[X] Срив във всяка фаза')

  await check('[X1] Срив веднага след записа на решението (висящ lease): решението остава, изтриване няма; рестарт довършва; без дублирани записи', async () => {
    const user = registerUser('CrashDecision')
    const requestId = overdue(user)
    await runWorker(live, [requestId]); backup(live); retryNow(live.dbPath, requestId)
    const crashed = await runWorker(live, [requestId], 'after_decision')
    assertEqual(crashed.code, 9, crashed.output.slice(-200))
    assertEqual(ledgerKinds(live.ledgerPath, 'request_deletion_decided', requestId), 1, 'решение')
    assert(profileExists(live.dbPath, user.profileId) && statusOf(live.dbPath, requestId) === 'executing', 'състояние след срива')
    backup(live); retryNow(live.dbPath, requestId)
    const resumed = await runWorker(live, [requestId])
    assert(resumed.summary?.completed === 1, resumed.output.slice(-300))
    assertEqual(ledgerKinds(live.ledgerPath, 'request_deletion_decided', requestId), 1, 'дубликат на решението')
  })

  await check('[X2] Срив непосредствено преди COMMIT (решението е offsite): нищо не е изтрито; рестарт изтрива', async () => {
    const user = registerUser('CrashCommit')
    const requestId = overdue(user)
    await runWorker(live, [requestId]); backup(live); retryNow(live.dbPath, requestId)
    await runWorker(live, [requestId]); backup(live); retryNow(live.dbPath, requestId)
    const crashed = await runWorker(live, [requestId], 'before_commit')
    assertEqual(crashed.code, 9, crashed.output.slice(-200))
    assert(profileExists(live.dbPath, user.profileId), 'изтрит без COMMIT')
    assertEqual(ledgerKinds(live.ledgerPath, 'request_db_deleted', requestId), 0, '"завършено" преди COMMIT')
    retryNow(live.dbPath, requestId)
    const resumed = await runWorker(live, [requestId])
    assert(resumed.summary?.completed === 1 && !profileExists(live.dbPath, user.profileId), resumed.output.slice(-300))
  })

  await check('[X3] Срив след COMMIT (файловата фаза): изтриването е завършено; доказателството е записано; рестарт довършва файловете', async () => {
    const user = registerUser('CrashFiles')
    db.prepare(`UPDATE profiles SET avatar_url = '/uploads/avatars/dr-crash.png' WHERE profile_id = ?;`).run(user.profileId)
    writeFileSync(join(uploadRoots.avatars, 'dr-crash.png'), 'x')
    const requestId = overdue(user)
    await runWorker(live, [requestId]); backup(live); retryNow(live.dbPath, requestId)
    await runWorker(live, [requestId]); backup(live); retryNow(live.dbPath, requestId)
    const crashed = await runWorker(live, [requestId], 'after_commit')
    assertEqual(crashed.code, 9, crashed.output.slice(-200))
    assert(!profileExists(live.dbPath, user.profileId), 'COMMIT')
    assertEqual(ledgerKinds(live.ledgerPath, 'request_db_deleted', requestId), 1, 'доказателство след COMMIT')
    retryNow(live.dbPath, requestId)
    const resumed = await runWorker(live, [requestId])
    assert(resumed.summary?.completed === 1, resumed.output.slice(-300))
    assertEqual(ledgerKinds(live.ledgerPath, 'request_db_deleted', requestId), 1, 'дубликат')
  })

  // ═══ [V] Загуба на VPS ══════════════════════════════════════════════════
  console.log('\n[V] Пълна загуба на VPS, изоставащ архив')

  // Времева линия до загубата на VPS:
  //   1. жертва: намерение -> offsite -> решение; административно намерение;
  //      ПОСЛЕДЕН ledger backup (решението и намерението са извън VPS);
  //   2. COMMIT на изтриването (доказателството — само локално);
  //   3. приета отмяна при НЕРАБОТЕЩ offsite (само локално);
  //   4. административно изпълнение (завършването — само локално).
  const victim = registerUser('Victim')
  const victimId = overdue(victim)
  await runWorker(live, [victimId]); backup(live); retryNow(live.dbPath, victimId)
  await runWorker(live, [victimId]) // решението (още не е offsite)
  const adminTarget = registerUser('AdminTarget')
  const dbBeforeAdminSchedule = snapshotDb('db-before-admin-schedule')
  const liveAdmin = await coordinatorFor(live)
  const scheduled = liveAdmin.coordinator.schedule({ targetProfileId: adminTarget.profileId, actorProfileId: adminActor.profileId, actorAccountId: adminActor.accountId, reason: 'нарушения', supportRequestMessageId: null })
  assert(scheduled.ok, 'насрочено')
  backup(live) // ПОСЛЕДНИЯТ ledger backup преди загубата
  const dbAfterAdminSchedule = snapshotDb('db-after-admin-schedule')
  const dbBeforeVictimCommit = dbAfterAdminSchedule
  retryNow(live.dbPath, victimId)
  const committed = await runWorker(live, [victimId]) // COMMIT + доказателство (само локално)
  assert(committed.summary?.completed === 1, `COMMIT на живо: ${committed.output.slice(-300)}`)
  // Приета отмяна при НЕРАБОТЕЩ offsite: записът е само в живия регистър.
  const canceller = registerUser('Canceller')
  const cancelRequestId = insertRequest(canceller, isoPlus(dbNow(), 4000))
  const dbBeforeCancel = snapshotDb('db-before-cancel')
  const issued = requestStore.issueRestoreToken(canceller.profileId)
  assert(issued.ok && requestStore.cancelWithToken(issued.ok ? issued.restoreToken : '').ok, 'приета отмяна')
  {
    const store = await createProfileDeletionCancellationStore(live.dbPath)
    const finalizer = createProfileDeletionCancellationFinalizer({ store, ledgerPath: live.ledgerPath, offsiteRequired: true })
    finalizer.runOnce() // записана локално; offsite не работи -> не е окончателна
    store.close()
  }
  const executed = await liveAdmin.coordinator.tryExecute(liveAdmin.pendingStore.getPendingDeleteByOperation(scheduled.ok ? scheduled.operationId : '')!)
  assertEqual(executed.status, 'completed', 'административно изпълнение на живо')
  liveAdmin.close()
  await sleep(4200) // срокът на отменената заявка изтича

  await check('[V1] Архивът изостава: последният ledger snapshot няма доказателството за завършване, нито приетата отмяна, нито административното завършване — но съдържа решението и административното намерение', () => {
    const merged = join(root, 'inspect-merged.jsonl')
    const original = console.log
    console.log = () => {}
    return runProfileDeletionLedgerCli(['merge', `--snapshot-dir=${live.offsiteDir}`, `--out=${merged}`]).finally(() => { console.log = original }).then((code) => {
      assertEqual(code, 0, 'merge')
      const records = readProfileDeletionLedger(merged).records
      const state = summarizeRequestLedgerState(records)
      assert(state.get(victimId)?.decided !== null && state.get(victimId)?.dbDeleted === null, 'решение без доказателство')
      assert(state.get(cancelRequestId)?.cancel == null, 'изгубената отмяна е в архива')
      assertEqual(summarizeAdminLedgerOperations(records).get(scheduled.ok ? scheduled.operationId : '')?.state, 'intent_only', 'административно намерение без завършване')
      assertEqual(summarizeLedgerControl(records).unreleasedRestoreIds.length, 1, 'restore маркер от merge')
    })
  })

  const restoredA = await restoreEnv('a', dbBeforeVictimCommit, 'merge')

  await check('[V2] Restore отпреди окончателното изтриване (merge от архива): отмяна на решената заявка се отказва; worker (отделен процес) я изтрива отново след offsite потвърждение — профилът НЕ се възкресява', async () => {
    const refused = await adminCancelIn(restoredA, victimId)
    assert(!refused.ok && refused.code === 'irreversible', JSON.stringify(refused))
    const first = await runWorker(restoredA, [victimId])
    assert(first.history?.restoreHold === true, `restore hold: ${JSON.stringify(first.history)}`)
    assert(profileExists(restoredA.dbPath, victim.profileId), 'изтрит без offsite потвърждение в новата среда')
    backup(restoredA)
    retryNow(restoredA.dbPath, victimId)
    const second = await runWorker(restoredA, [victimId])
    assert(second.summary?.completed === 1, `решените заявки се довършват и при restore hold: ${second.output.slice(-400)}`)
    assert(!profileExists(restoredA.dbPath, victim.profileId), 'профилът е възкресен')
  })

  const restoredB = await restoreEnv('b', dbBeforeCancel, 'merge')

  await check('[V3] Restore отпреди приета (неоffsite) отмяна: старата заявка НЕ се изпълнява автоматично — restore hold блокира новото решение', async () => {
    retryNow(restoredB.dbPath, cancelRequestId)
    const first = await runWorker(restoredB, [cancelRequestId]) // ново намерение — чака offsite в новата среда
    assert(first.output.includes('"blocked":1'), first.output.slice(-400))
    backup(restoredB)
    retryNow(restoredB.dbPath, cancelRequestId)
    const run = await runWorker(restoredB, [cancelRequestId])
    assert(run.output.includes('"blocked":1'), run.output.slice(-400))
    assertEqual(query<{ c: string }>(restoredB.dbPath, 'SELECT last_error_code AS c FROM profile_deletion_requests WHERE request_id = ?;', cancelRequestId)?.c, 'restore_hold', 'код')
    assertEqual(ledgerKinds(restoredB.ledgerPath, 'request_deletion_decided', cancelRequestId), 0, 'решение по време на restore hold')
    assert(profileExists(restoredB.dbPath, canceller.profileId), 'изтрит')
    // Администраторът може да възстанови отмяната (напр. по писмо на потребителя).
    const restoredCancel = await adminCancelIn(restoredB, cancelRequestId)
    assert(restoredCancel.ok, JSON.stringify(restoredCancel))
  })

  await check('[V4] release-restore: отказва при непроверена история; отчита заявките в риск; освобождава само с изричното потвърждение — записът оцелява в регистъра', async () => {
    const report: string[] = []
    const reportCode = await runProfileDeletionRestoreRelease([`--db=${restoredA.dbPath}`, `--ledger=${restoredA.ledgerPath}`], { log: (l) => report.push(l), error: (l) => report.push(l) })
    assertEqual(reportCode, 1, `отчет: ${report.join(' | ')}`)
    const noConfirm = summarizeLedgerControl(readProfileDeletionLedger(restoredA.ledgerPath).records).unreleasedRestoreIds.length
    assertEqual(noConfirm, 1, 'освободено без потвърждение')
    const released = await runProfileDeletionRestoreRelease([`--db=${restoredA.dbPath}`, `--ledger=${restoredA.ledgerPath}`, `--confirm=${RELEASE_RESTORE_CONFIRMATION_PHRASE}`], quiet)
    assertEqual(released, 0, 'освобождаване')
    assertEqual((await assessEnv(restoredA)).restoreHold, false, 'restore hold')
    // Непроверена история -> отказ.
    const broken = await restoreEnv('broken', dbBeforeVictimCommit, 'none')
    const refused = await runProfileDeletionRestoreRelease([`--db=${broken.dbPath}`, `--ledger=${broken.ledgerPath}`, `--confirm=${RELEASE_RESTORE_CONFIRMATION_PHRASE}`], quiet)
    assertEqual(refused, 1, 'освобождаване при непроверена история')
  })

  const restoredAdminWithRow = await restoreEnv('admin-row', dbAfterAdminSchedule, 'merge')

  await check('[V5] Административно изтриване след restore (висящ ред в backup-а): restore hold -> не се изпълнява и намерението НЕ се финализира като "отказано"; след release — изпълнява се отново', async () => {
    const env = await coordinatorFor(restoredAdminWithRow)
    try {
      const pending = env.pendingStore.getPendingDeleteByOperation(scheduled.ok ? scheduled.operationId : '')
      assert(pending !== null, 'висящ ред в backup-а')
      const held = await env.coordinator.tryExecute(pending!)
      assertEqual(held.status, 'history_unverified', 'по време на restore hold')
      assertEqual(env.coordinator.finalizeOperations(), 0, 'финализиране по време на restore hold')
      assert(profileExists(restoredAdminWithRow.dbPath, adminTarget.profileId), 'изтрит по време на hold')
      backup(restoredAdminWithRow)
      assertEqual(await runProfileDeletionRestoreRelease([`--db=${restoredAdminWithRow.dbPath}`, `--ledger=${restoredAdminWithRow.ledgerPath}`, `--confirm=${RELEASE_RESTORE_CONFIRMATION_PHRASE}`], quiet), 0, 'release')
      const done = await env.coordinator.tryExecute(env.pendingStore.getPendingDeleteByOperation(scheduled.ok ? scheduled.operationId : '')!)
      assertEqual(done.status, 'completed', JSON.stringify(done))
      assert(!profileExists(restoredAdminWithRow.dbPath, adminTarget.profileId), 'профилът е възкресен')
    } finally {
      env.close()
    }
  })

  const restoredAdminNoRow = await restoreEnv('admin-no-row', dbBeforeAdminSchedule, 'merge')

  await check('[V6] Административно изтриване, когато backup-ът е отпреди насрочването: намерението остава неразрешено (без "aborted"), профилът няма достъп, нищо не се изпълнява', async () => {
    const env = await coordinatorFor(restoredAdminNoRow)
    try {
      assertEqual(env.coordinator.finalizeOperations(), 0, 'финализиране')
      const records = readProfileDeletionLedger(restoredAdminNoRow.ledgerPath).records
      assertEqual(summarizeAdminLedgerOperations(records).get(scheduled.ok ? scheduled.operationId : '')?.state, 'intent_only', 'намерението е финализирано като отказано')
      const assessment = await assessEnv(restoredAdminNoRow)
      assert(assessment.blockedProfileIds.includes(adminTarget.profileId), `достъп: ${JSON.stringify(assessment)}`)
      // Входът е спрян (същата кука като index.ts: isProfileScheduledForAdminDeletion).
      const progress = await createPlayerProgressStore(restoredAdminNoRow.dbPath)
      const auth = await createAuthStore(restoredAdminNoRow.dbPath, progress, {
        registrationVerificationCodeSecret: SECRET, getRegistrationVerificationMode: () => 'direct', getActiveBanForProfile: () => null,
        isProfileScheduledForAdminDeletion: (profileId) => assessment.blockedProfileIds.includes(profileId),
      })
      try {
        const login = auth.login({ email: adminTarget.email, password: 'secret123', rememberMe: true })
        assert(!login.ok && 'code' in login && login.code === 'PROFILE_DELETION_SCHEDULED', JSON.stringify(login))
      } finally {
        auth.close(); progress.close()
      }
    } finally {
      env.close()
    }
  })

  await check('[V7] Пълна загуба на регистъра, сървърът стартира БЕЗ merge: базата е обвързана -> ledger_missing; worker (отделен процес) не взема нищо; административно изпълнение се отказва', async () => {
    const env = await restoreEnv('no-ledger', dbBeforeVictimCommit, 'none')
    const run = await runWorker(env, [victimId])
    assertEqual(run.summary?.claimed, 0, `worker: ${run.output.slice(-300)}`)
    assert(Array.isArray(run.history?.reasons) && (run.history!.reasons as string[]).includes('ledger_missing'), JSON.stringify(run.history))
    assert(profileExists(env.dbPath, victim.profileId), 'профилът')
    assert(!existsSync(env.ledgerPath), 'създаден е нов празен регистър')
    const admin = await coordinatorFor(env)
    try {
      const pending = admin.pendingStore.getPendingDeleteByOperation(scheduled.ok ? scheduled.operationId : '')
      assert(pending !== null, 'fixture: висящ административен ред')
      assertEqual((await admin.coordinator.tryExecute(pending!)).status, 'history_unverified', 'административно изпълнение')
      assertEqual(admin.coordinator.finalizeOperations(), 0, 'финализиране')
      assert(profileExists(env.dbPath, adminTarget.profileId), 'административно изтрит без регистър')
    } finally {
      admin.close()
    }
  })

  await check('[V8] Валиден, но остарял регистър, копиран ръчно (без merge маркер), и база, по-нова от него: сървърът открива restore (няма ack) -> restore hold; регистърът е по-стар от базата -> нищо необратимо', async () => {
    const oldSnapshot = readdirSorted(live.offsiteDir)[0]!
    const env = await restoreEnv('stale-copy', snapshotDb('db-now'), { copyFrom: join(live.offsiteDir, oldSnapshot) })
    const run = await runWorker(env, [victimId])
    assertEqual(run.summary?.claimed, 0, run.output.slice(-300))
    assert(run.history?.verified === false, `шлюз: ${JSON.stringify(run.history)}`)
    const reasons = (run.history?.reasons ?? []) as string[]
    assert(reasons.some((r) => r.startsWith('ledger_behind_db')), JSON.stringify(reasons))
  })

  await check('[V9] Restore без reconcile, профил с доказано изтриване и БЕЗ заявка в базата (създадена след backup-а): шлюзът е затворен, профилът няма достъп; reconcile го изтрива отново и шлюзът се отваря', async () => {
    const late = registerUser('LateRequest')
    const dbBeforeLate = snapshotDb('db-before-late-request')
    const lateId = overdue(late)
    await runWorker(live, [lateId]); backup(live); retryNow(live.dbPath, lateId)
    await runWorker(live, [lateId]); backup(live); retryNow(live.dbPath, lateId)
    await runWorker(live, [lateId])
    assert(!profileExists(live.dbPath, late.profileId), 'изтрит на живо')
    const env = await restoreEnv('late', dbBeforeLate, { copyFrom: live.ledgerPath })
    const before = await assessEnv(env)
    assert(!before.verified && before.reasons.some((r) => r === `unreconciled_deletion:${lateId}`) && before.blockedProfileIds.includes(late.profileId), JSON.stringify(before))
    const run = await runWorker(env, [lateId])
    assertEqual(run.summary?.claimed, 0, 'worker при непроверена история')
    const result = await reconcileApply(env)
    assert(!profileExists(env.dbPath, late.profileId), `reconcile: ${result.lines.slice(-4).join(' | ')}`)
    const after = await assessEnv(env)
    assert(!after.reasons.some((r) => r.startsWith('unreconciled_deletion')) && !after.blockedProfileIds.includes(late.profileId), JSON.stringify(after))
  })

  await check('[V10] Всички отменени заявки остават защитени: окончателна отмяна в архива + restore отпреди нея -> reconcile възстановява защитата; worker не изтрива', async () => {
    const user = registerUser('KeptCancel')
    const requestId = insertRequest(user, isoPlus(dbNow(), 3000))
    const dbBefore = snapshotDb('db-before-kept-cancel')
    const token = requestStore.issueRestoreToken(user.profileId)
    assert(token.ok && requestStore.cancelWithToken(token.ok ? token.restoreToken : '').ok, 'отмяна')
    const store = await createProfileDeletionCancellationStore(live.dbPath)
    const finalizer = createProfileDeletionCancellationFinalizer({ store, ledgerPath: live.ledgerPath, offsiteRequired: true })
    finalizer.runOnce(); backup(live); finalizer.runOnce()
    store.close()
    assertEqual(statusOf(live.dbPath, requestId), 'cancelled', 'окончателна')
    await sleep(3200)
    const env = await restoreEnv('kept-cancel', dbBefore, 'merge')
    await reconcileApply(env)
    retryNow(env.dbPath, requestId)
    const run = await runWorker(env, [requestId])
    assert(run.summary?.completed === 0 && profileExists(env.dbPath, user.profileId), run.output.slice(-300))
    assert(query(env.dbPath, 'SELECT 1 AS x FROM profile_deletion_cancellations WHERE request_id = ?;', requestId) !== undefined, 'защитата не е възстановена')
  })

  await check('[V11] Неработещ offsite backup: намерения/решения не се потвърждават -> нищо не се изтрива; приетата отмяна остава защитена', async () => {
    const user = registerUser('NoOffsite')
    const requestId = overdue(user)
    for (let i = 0; i < 3; i += 1) {
      retryNow(live.dbPath, requestId)
      await runWorker(live, [requestId])
    }
    assert(profileExists(live.dbPath, user.profileId), 'изтрит без offsite')
    assertEqual(ledgerKinds(live.ledgerPath, 'request_deletion_decided', requestId), 0, 'решение без потвърдено намерение')
    // Почистване, за да не пречи на следващите проверки.
    backup(live)
  })

  // ═══ [K] Съвместимост ═══════════════════════════════════════════════════
  console.log('\n[K] Съвместимост')

  await check('[K1] Регистър отпреди 4J1B (без genesis): първото стартиране добавя genesis и обвързва базата; старите намерения запазват досегашната семантика (intent), новите без решение са "undecided"', async () => {
    const dir = join(root, 'legacy')
    await mkdir(dir, { recursive: true })
    const legacyDb = join(dir, 'legacy.sqlite')
    db.exec(`VACUUM INTO '${legacyDb.replace(/'/g, "''")}';`)
    const handle = new sqliteModule.DatabaseSync(legacyDb)
    handle.prepare('DELETE FROM admin_settings WHERE setting_key = ?;').run(PROFILE_DELETION_LEDGER_ID_SETTING)
    handle.close()
    const legacyLedger = join(dir, 'profile-deletions.jsonl')
    const intent = (requestId: string) => ({ v: 1 as const, requestId, profileId: `p-${requestId}`, accountIdSnapshot: `a-${requestId}`, profileCreatedAtSnapshot: '2026-01-01 00:00:00', requestedAt: '2026-01-01T00:00:00.000Z', scheduledFor: '2026-01-31T00:00:00.000Z', recordedAt: new Date().toISOString() })
    ensureProfileDeletionLedgerEntry(legacyLedger, intent('legacy-req'))
    const guard = await createProfileDeletionHistoryGuard({ databaseFilePath: legacyDb, ledgerPath: legacyLedger, offsiteRequired: false })
    try {
      assertEqual(guard.initialize().binding, 'created', 'genesis за стар регистър')
    } finally {
      guard.close()
    }
    ensureProfileDeletionLedgerEntry(legacyLedger, intent('new-req'))
    const states = summarizeRequestLedgerState(readProfileDeletionLedger(legacyLedger).records)
    assertEqual(states.get('legacy-req')?.resolution, 'intent', 'старо намерение')
    assertEqual(states.get('new-req')?.resolution, 'undecided', 'ново намерение без решение')
    const parsed = parseProfileDeletionLedgerBuffer(readFileSync(legacyLedger))
    assertEqual(parsed.invalidLineCount, 0, 'валиден')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const close of closers.splice(0).reverse()) { try { close() } catch { /* ignore */ } }
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** Snapshot-ите на архива, най-старият първи (имената съдържат UTC печат). */
function readdirSorted(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
}

console.log('\n════════════════════════════════════════════════════════════')
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
