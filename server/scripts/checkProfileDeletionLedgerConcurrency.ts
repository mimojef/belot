/**
 * checkProfileDeletionLedgerConcurrency.ts
 *
 * Самоизтриване, Етап 4J1A — регистърът на изтриванията при конкуренция
 * между ОТДЕЛНИ процеси и при срив; доказателството "request_db_deleted"
 * около необратимото изтриване.
 *
 * Всеки конкурентен участник е отделен Node процес
 * (scripts/fixtures/ledgerConcurrencyChild.ts) с production функциите.
 * Само временни бази и регистри.
 *
 * [L] Заключване: едновременни append-и, логически дубликати, прекъснат ред
 *     + два конкурентни опита за възстановяване, срив по време на запис,
 *     убит процес със заключването, fail-closed при изтекло чакане,
 *     append + offsite snapshot/confirm, потвърденият префикс, без deadlock
 *     с основната база, повреден/липсващ регистър.
 * [D] request_db_deleted: срив непосредствено преди/след COMMIT, restore от
 *     различни моменти, worker без reconcile, предходна отмяна, повреден
 *     регистър, рестарт на finalizer/worker.
 *
 * Употреба (от server/): npx tsx scripts/checkProfileDeletionLedgerConcurrency.ts --server-root=.
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { createProfileDeletionAdminStore } from '../src/db/profileDeletionAdminStore.js'
import { createProfileDeletionCancellationStore } from '../src/db/profileDeletionCancellationStore.js'
import { createProfileDeletionCancellationFinalizer } from '../src/core/profileDeletionCancellationFinalizer.js'
import {
  ensureProfileDeletionLedgerEntry,
  isProfileDeletionLedgerRecordConfirmedOffsite,
  isProfileDeletionLedgerRequestConfirmedOffsite,
  parseProfileDeletionLedgerBuffer,
  readProfileDeletionLedger,
  getProfileDeletionLedgerOffsiteAckPath,
  readProfileDeletionLedgerOffsiteAck,
  summarizeRequestLedgerState,
} from '../src/db/profileDeletionLedger.js'
import { confirmLedgerSnapshotOffsite, createLedgerSnapshot, verifyLedgerSnapshot, readLedgerSnapshotManifest } from '../src/ops/profileDeletionLedgerArchive.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isoPlus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

const SECRET = 'profile-deletion-ledger-concurrency-secret-0123456789'
const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const TSX_CLI = join(sourceServerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const CHILD = join(sourceServerRoot, 'scripts', 'fixtures', 'ledgerConcurrencyChild.ts')

console.log('\ncheckProfileDeletionLedgerConcurrency')
console.log(`Server root: ${sourceServerRoot}`)

type Child = { done: Promise<{ code: number | null; output: string }>; kill: () => void; pid: number | undefined }
function runChild(mode: string, args: Record<string, unknown>): Child {
  const child = spawn(process.execPath, [TSX_CLI, CHILD, mode, JSON.stringify(args)], { cwd: sourceServerRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  const done = new Promise<{ code: number | null; output: string }>((res) => child.once('exit', (code) => res({ code, output })))
  return { done, kill: () => child.kill('SIGKILL'), pid: child.pid }
}
async function waitFile(path: string, timeoutMs = 60_000): Promise<void> {
  const limit = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > limit) throw new Error(`timeout: ${path}`)
    await sleep(20)
  }
}
/** Стартира процесите, изчаква всички да са готови и ги пуска едновременно. */
async function runSimultaneously(dir: string, specs: Array<{ mode: string; args: Record<string, unknown> }>): Promise<Array<{ code: number | null; output: string }>> {
  const goFile = join(dir, `go-${randomUUID()}`)
  const children = specs.map((spec, index) => {
    const readyFile = join(dir, `ready-${index}-${randomUUID()}`)
    return { readyFile, child: runChild(spec.mode, { ...spec.args, goFile, readyFile }) }
  })
  for (const { readyFile } of children) await waitFile(readyFile)
  writeFileSync(goFile, 'go')
  return await Promise.all(children.map(({ child }) => child.done))
}

const sqliteModule = await import('node:sqlite')
const tempRoots: string[] = []
const closers: Array<() => void> = []

try {
  const root = await mkdtemp(join(tmpdir(), 'belot-4j1a-'))
  tempRoots.push(root)
  const ledgerDir = join(root, 'ledgers')
  await mkdir(ledgerDir, { recursive: true })
  const newLedger = () => join(ledgerDir, `ledger-${randomUUID().slice(0, 8)}`, 'profile-deletions.jsonl')
  const keyLines = (ledgerPath: string, needle: string) => readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.includes(needle)).length

  // ═══ [L] Заключване ═════════════════════════════════════════════════════
  console.log('\n[L] Междупроцесно заключване на регистъра')

  await check('[L1] Два процеса × 150 едновременни append-а: 300 валидни реда, без повреда, загуба или дубликати', async () => {
    const ledgerPath = newLedger()
    const results = await runSimultaneously(ledgerDir, [
      { mode: 'append', args: { ledgerPath, count: 150, tag: 'a' } },
      { mode: 'append', args: { ledgerPath, count: 150, tag: 'b' } },
    ])
    assert(results.every((r) => r.code === 0), results.map((r) => r.output).join(' | '))
    const parsed = readProfileDeletionLedger(ledgerPath)
    assertEqual(parsed.invalidLineCount + parsed.conflictingDuplicateCount + parsed.trailingPartialBytes, 0, 'повреда')
    assertEqual(parsed.lineCount, 300, 'редове')
    assertEqual(parsed.entries.length, 300, 'записи')
    for (const tag of ['a', 'b']) {
      const order = parsed.entries.filter((e) => e.requestId.startsWith(`${tag}-`)).map((e) => Number(e.requestId.split('-')[1]))
      assert(order.every((value, index) => value === index), `пренареждане в ${tag}`)
    }
  })

  await check('[L2] Един и същ запис от два процеса едновременно (ensure × 40 всеки): точно един ред', async () => {
    const ledgerPath = newLedger()
    const results = await runSimultaneously(ledgerDir, [
      { mode: 'ensure-same', args: { ledgerPath, count: 40, requestId: 'same-request' } },
      { mode: 'ensure-same', args: { ledgerPath, count: 40, requestId: 'same-request' } },
    ])
    assert(results.every((r) => r.code === 0), results.map((r) => r.output).join(' | '))
    assertEqual(keyLines(ledgerPath, '"requestId":"same-request"'), 1, 'логически дубликат')
  })

  await check('[L3] Прекъснат последен ред + два конкурентни процеса, които "възстановяват" и дописват: опашката изчезва точно веднъж, завършените редове са непокътнати', async () => {
    const ledgerPath = newLedger()
    for (let i = 0; i < 20; i += 1) ensureProfileDeletionLedgerEntry(ledgerPath, intentFor(`base-${i}`))
    const completePrefix = readFileSync(ledgerPath)
    appendFileSync(ledgerPath, '{"v":1,"requestId":"torn-tail-from-crash","prof')
    const results = await runSimultaneously(ledgerDir, [
      { mode: 'append', args: { ledgerPath, count: 60, tag: 'x' } },
      { mode: 'append', args: { ledgerPath, count: 60, tag: 'y' } },
    ])
    assert(results.every((r) => r.code === 0), results.map((r) => r.output).join(' | '))
    const buffer = readFileSync(ledgerPath)
    assert(buffer.subarray(0, completePrefix.length).equals(completePrefix), 'завършен ред е засегнат')
    const parsed = parseProfileDeletionLedgerBuffer(buffer)
    assertEqual(parsed.invalidLineCount + parsed.trailingPartialBytes, 0, 'повреда')
    assertEqual(parsed.entries.length, 140, 'записи')
    assert(!buffer.toString('utf8').includes('torn-tail-from-crash'), 'опашката остана')
  })

  await check('[L4] Срив по време на запис (процесът умира със заключването и половин ред): заключването е освободено от ОС; следващият запис отрязва само опашката; потвърденият префикс е непроменен', async () => {
    const ledgerPath = newLedger()
    for (let i = 0; i < 5; i += 1) ensureProfileDeletionLedgerEntry(ledgerPath, intentFor(`pre-${i}`))
    writeTestLedgerAck(ledgerPath)
    const acked = readFileSync(ledgerPath)
    const crashed = await runChild('crash-mid-write', { ledgerPath }).done
    assertEqual(crashed.code, 9, `изход: ${crashed.output}`)
    assert(readProfileDeletionLedger(ledgerPath).trailingPartialBytes > 0, 'половин ред')
    const started = Date.now()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('after-crash'))
    assert(Date.now() - started < 3000, 'заключването не е освободено')
    const buffer = readFileSync(ledgerPath)
    assert(buffer.subarray(0, acked.length).equals(acked), 'потвърденият префикс е променен')
    const parsed = parseProfileDeletionLedgerBuffer(buffer)
    assertEqual(parsed.invalidLineCount + parsed.trailingPartialBytes, 0, 'повреда')
    assertEqual(parsed.entries.length, 6, 'записи')
    for (let i = 0; i < 5; i += 1) assert(isProfileDeletionLedgerRequestConfirmedOffsite(ledgerPath, `pre-${i}`), `потвърждение pre-${i}`)
  })

  await check('[L5] Процес, убит (SIGKILL) докато държи заключването: друг процес го получава веднага (няма "заседнал" lock)', async () => {
    const ledgerPath = newLedger()
    const readyFile = join(ledgerDir, `held-${randomUUID()}`)
    const holder = runChild('hold-lock-forever', { ledgerPath, readyFile })
    await waitFile(readyFile)
    holder.kill()
    await holder.done
    const started = Date.now()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('after-kill'))
    assert(Date.now() - started < 3000, `чакане ${Date.now() - started} ms`)
    assertEqual(readProfileDeletionLedger(ledgerPath).entries.length, 1, 'записът')
  })

  await check('[L6] Докато друг процес държи заключването, записът чака (не пише паралелно) и после успява', async () => {
    const ledgerPath = newLedger()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('first'))
    const readyFile = join(ledgerDir, `held-${randomUUID()}`)
    const holder = runChild('hold-lock', { ledgerPath, readyFile, ms: 2500 })
    await waitFile(readyFile)
    const started = Date.now()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('second'))
    const waited = Date.now() - started
    await holder.done
    assert(waited >= 1500, `не изчака заключването (${waited} ms)`)
    assertEqual(readProfileDeletionLedger(ledgerPath).entries.length, 2, 'записи')
  })

  await check('[L7] Изтекло чакане (заключването е заето > 15 s): записът се отказва с грешка (fail-closed), файлът е непроменен', async () => {
    const ledgerPath = newLedger()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('only'))
    const before = readFileSync(ledgerPath)
    const readyFile = join(ledgerDir, `held-${randomUUID()}`)
    const holder = runChild('hold-lock', { ledgerPath, readyFile, ms: 19_000 })
    await waitFile(readyFile)
    let thrown = ''
    try {
      ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('blocked'))
    } catch (error) {
      thrown = String(error)
    }
    await holder.done
    assert(/locked|busy/i.test(thrown), `грешка: ${thrown}`)
    assert(readFileSync(ledgerPath).equals(before), 'файлът е променен')
  })

  await check('[L8] Конкурентен append (отделен процес) и offsite snapshot + confirm: всеки snapshot е валиден префикс; ack-ът остава валиден и след още записи', async () => {
    const ledgerPath = newLedger()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('seed'))
    const ackPath = getProfileDeletionLedgerOffsiteAckPath(ledgerPath)
    const outDir = join(ledgerDir, `snapshots-${randomUUID().slice(0, 6)}`)
    const appender = runChild('append', { ledgerPath, count: 250, tag: 'snap' })
    let snapshots = 0
    let exited = false
    void appender.done.then(() => { exited = true })
    while (!exited) {
      const result = createLedgerSnapshot({ ledgerPath, outDir, ackPath })
      if (result.status === 'created') {
        verifyLedgerSnapshot(result.snapshotPath, readLedgerSnapshotManifest(result.manifestPath))
        confirmLedgerSnapshotOffsite({ ledgerPath, snapshotPath: result.snapshotPath, manifestPath: result.manifestPath, remotePath: 'test-offsite:/x', ackPath })
        snapshots += 1
      }
      await sleep(5)
    }
    assertEqual((await appender.done).code, 0, 'appender')
    assert(snapshots >= 2, `snapshot-и: ${snapshots}`)
    const ack = readProfileDeletionLedgerOffsiteAck(ackPath)!
    const buffer = readFileSync(ledgerPath)
    assert(createHash('sha256').update(buffer.subarray(0, ack.bytes)).digest('hex') === ack.sha256, 'потвърденият префикс е променен')
    assert(isProfileDeletionLedgerRequestConfirmedOffsite(ledgerPath, 'seed'), 'seed е потвърден')
    assertEqual(parseProfileDeletionLedgerBuffer(buffer).entries.length, 251, 'записи')
  })

  await check('[L9] Без deadlock с основната база: процесът държи writer lock-а на SQLite и пише в регистъра, докато друг процес също пише', async () => {
    const ledgerPath = newLedger()
    const dbPath = join(ledgerDir, `main-${randomUUID().slice(0, 6)}.sqlite`)
    const mainDb: SqliteDatabase = new sqliteModule.DatabaseSync(dbPath)
    mainDb.exec('CREATE TABLE t (x INTEGER); BEGIN IMMEDIATE; INSERT INTO t VALUES (1);')
    try {
      const other = runChild('append', { ledgerPath, count: 50, tag: 'other' })
      for (let i = 0; i < 50; i += 1) ensureProfileDeletionLedgerEntry(ledgerPath, intentFor(`main-${i}`))
      assertEqual((await other.done).code, 0, 'другият процес')
    } finally {
      mainDb.exec('COMMIT;')
      mainDb.close()
    }
    assertEqual(readProfileDeletionLedger(ledgerPath).entries.length, 100, 'записи')
  })

  await check('[L10] Повреден регистър: ensure отказва (fail-closed), нищо не се дописва; липсващ — създава се', () => {
    const ledgerPath = newLedger()
    ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('ok'))
    appendFileSync(ledgerPath, 'not-json\n')
    const before = readFileSync(ledgerPath)
    let thrown = ''
    try { ensureProfileDeletionLedgerEntry(ledgerPath, intentFor('next')) } catch (error) { thrown = String(error) }
    assert(thrown.includes('profile_deletion_ledger_corrupt'), thrown)
    assert(readFileSync(ledgerPath).equals(before), 'дописване в повреден регистър')
    const missing = newLedger()
    ensureProfileDeletionLedgerEntry(missing, intentFor('fresh'))
    assertEqual(readProfileDeletionLedger(missing).entries.length, 1, 'нов регистър')
  })

  // ═══ [D] request_db_deleted около необратимото изтриване ════════════════
  console.log('\n[D] Доказателство за изтриване, срив и restore')

  const serverRoot = join(root, 'server')
  await mkdir(join(serverRoot, 'database', 'migrations'), { recursive: true })
  await mkdir(join(serverRoot, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(serverRoot, 'database', 'migrations', entry.name))
  }
  const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: serverRoot })
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  closers.push(() => db.close())
  const progressStore = await createPlayerProgressStore(databaseFilePath)
  closers.push(() => progressStore.close())
  const authStore = await createAuthStore(databaseFilePath, progressStore, { registrationVerificationCodeSecret: SECRET, getRegistrationVerificationMode: () => 'direct', getActiveBanForProfile: () => null })
  closers.push(() => authStore.close())
  const adminStore = await createProfileDeletionAdminStore(databaseFilePath)
  closers.push(() => adminStore.close())
  const executor = await createProfileDeletionExecutor(databaseFilePath)
  closers.push(() => executor.close())
  const ledgerPath = join(root, 'deletion-ledger', 'profile-deletions.jsonl')
  const uploadRoots: ProfileDeletionUploadRoots = {
    avatars: join(root, 'uploads', 'avatars'), profileGallery: join(root, 'uploads', 'profile-gallery'), chatAttachments: join(root, 'uploads', 'chat'),
    topicAttachments: join(root, 'uploads', 'topic'), topicMuteEvidenceAttachments: join(root, 'uploads', 'mute'), supportAttachments: join(root, 'uploads', 'support'),
  }
  for (const dir of Object.values(uploadRoots)) await mkdir(dir, { recursive: true })

  let counter = 0
  const registerUser = (label: string) => {
    counter += 1
    const result = authStore.register({ email: `lc-${label.toLowerCase()}-${counter}@example.test`, password: 'secret123', displayName: `Lc${label}${counter}`, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error('регистрация')
    return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId }
  }
  const admin = registerUser('Admin')
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)
  const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const overdueRequest = (user: { profileId: string; accountId: string }) => {
    const requestId = randomUUID()
    const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
    const scheduledFor = isoPlus(dbNow(), -60_000)
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
  const row = (requestId: string) => db.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, any>
  const profileExistsIn = (dbFile: string, profileId: string) => {
    const copy = new sqliteModule.DatabaseSync(dbFile, { readOnly: true })
    try { return copy.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(profileId) !== undefined } finally { copy.close() }
  }
  const vacuumTo = (name: string) => {
    const copy = join(root, name)
    db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}';`)
    return copy
  }
  /** Същата проверка като index.ts (isProfileDeletionProvenInLedger). */
  const isDeletionProven = (requestId: string) => readProfileDeletionLedger(ledgerPath).records.some((r) => 'kind' in r && r.kind === 'request_db_deleted' && r.requestId === requestId)
  const adminCancel = (store: Awaited<ReturnType<typeof createProfileDeletionAdminStore>>, requestId: string) =>
    store.cancelVoluntaryRequestByAdmin({ requestId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'Проверка след restore', isDeletionProven })
  const workerChild = (dbFile: string, requestIds: string[], crashAt: string | null = null) =>
    runChild('worker', { databaseFilePath: dbFile, ledgerPath, uploadRoots, requestIds, crashAt })
  // Изтекли lease-ове на заявката и на файловете ѝ (както след рестарт на убит процес).
  const expireLease = (requestId: string) => {
    db.prepare('UPDATE profile_deletion_requests SET lease_expires_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), requestId)
    db.prepare("UPDATE profile_deletion_file_queue SET lease_expires_at = ? WHERE request_id = ? AND status = 'processing';").run(isoPlus(dbNow(), -1000), requestId)
  }
  async function reconcileApply(copy: string): Promise<{ code: number; lines: string[] }> {
    const uploads = join(root, `restored-${randomUUID().slice(0, 6)}`)
    await mkdir(uploads, { recursive: true })
    const lines: string[] = []
    const code = await runProfileDeletionLedgerReconcile([`--db=${copy}`, `--ledger=${ledgerPath}`, `--uploads-root=${uploads}`, '--apply', `--confirm=${REAPPLY_CONFIRMATION_PHRASE}`, '--accept-stale-ledger'], { log: (l) => lines.push(l), error: (l) => lines.push(l) })
    return { code, lines }
  }

  // Подготовка: заявка с намерение, потвърдено извън VPS.
  const victim = registerUser('Victim')
  // Аватар -> файлова фаза СЛЕД COMMIT (точката на срив в [D2]).
  db.prepare("UPDATE profiles SET avatar_url = '/uploads/avatars/lc-victim.png' WHERE profile_id = ?;").run(victim.profileId)
  writeFileSync(join(uploadRoots.avatars, 'lc-victim.png'), 'x')
  const victimId = overdueRequest(victim)
  const restoreBeforeIntent = vacuumTo('restore-m0-before-intent.sqlite')
  const firstRun = await workerChild(databaseFilePath, [victimId]).done
  assert(firstRun.code === 0, firstRun.output)
  writeTestLedgerAck(ledgerPath)
  const restoreAfterIntent = vacuumTo('restore-m1-after-intent.sqlite')

  await check('[D1] Срив НЕПОСРЕДСТВЕНО ПРЕДИ COMMIT (отделен процес умира след записа на доказателството): нищо не е изтрито, но доказателството е в регистъра — отмяна се отказва (irreversible)', async () => {
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), victimId)
    const crashed = await workerChild(databaseFilePath, [victimId], 'before_commit').done
    assertEqual(crashed.code, 9, `изход: ${crashed.output}`)
    assert(isDeletionProven(victimId), 'доказателството липсва')
    assertEqual(row(victimId).db_deleted_at, null, 'изтрито въпреки срива преди COMMIT')
    assert(profileExistsIn(databaseFilePath, victim.profileId), 'профилът')
    assertEqual(row(victimId).status, 'executing', 'висящ lease (както при истински срив)')
    expireLease(victimId)
    db.prepare(`UPDATE profile_deletion_requests SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ? WHERE request_id = ?;`).run(isoPlus(dbNow(), 3_600_000), victimId)
    const refused = adminCancel(adminStore, victimId)
    assert(!refused.ok && refused.code === 'irreversible', JSON.stringify(refused))
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), victimId)
  })

  const restoreAfterDBeforeCommit = vacuumTo('restore-m2-proof-no-commit.sqlite')

  await check('[D2] Срив НЕПОСРЕДСТВЕНО СЛЕД COMMIT (процесът умира във файловата фаза): изтриването е с доказателство; рестартиран worker довършва без дублиран запис', async () => {
    const crashed = await workerChild(databaseFilePath, [victimId], 'after_commit').done
    assertEqual(crashed.code, 9, `изход: ${crashed.output}`)
    assert(row(victimId).db_deleted_at !== null, 'COMMIT')
    assert(!profileExistsIn(databaseFilePath, victim.profileId), 'профилът')
    assertEqual(readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.includes('request_db_deleted') && l.includes(victimId)).length, 1, 'един запис')
    expireLease(victimId)
    const resumed = await workerChild(databaseFilePath, [victimId]).done
    assert(resumed.code === 0 && resumed.output.includes('"completed":1'), resumed.output)
    assertEqual(row(victimId).status, 'completed', 'статус')
    assertEqual(readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.includes('request_db_deleted') && l.includes(victimId)).length, 1, 'без дубликат')
  })

  const restoreAfterCommit = vacuumTo('restore-m3-after-commit.sqlite')

  await check('[D3] Restore от 4 момента (преди намерението, след намерението, доказателство без COMMIT, след COMMIT), БЕЗ reconcile: отмяна се отказва навсякъде; worker (отделен процес) изтрива отново — профилът не се възкресява', async () => {
    for (const [label, copy] of [['m0', restoreBeforeIntent], ['m1', restoreAfterIntent], ['m2', restoreAfterDBeforeCommit], ['m3', restoreAfterCommit]] as const) {
      const restoredAdmin = await createProfileDeletionAdminStore(copy)
      try {
        const result = adminCancel(restoredAdmin, victimId)
        assert(!result.ok && ['irreversible', 'lease_held', 'not_found'].includes(result.code), `${label}: ${JSON.stringify(result)}`)
      } finally {
        restoredAdmin.close()
      }
      const restored = new sqliteModule.DatabaseSync(copy)
      try {
        restored.prepare(`UPDATE profile_deletion_requests SET next_attempt_at = ?, lease_expires_at = CASE WHEN status = 'executing' THEN ? ELSE lease_expires_at END WHERE request_id = ?;`)
          .run(isoPlus(new Date().toISOString(), -1000), isoPlus(new Date().toISOString(), -1000), victimId)
      } finally {
        restored.close()
      }
      const run = await workerChild(copy, [victimId]).done
      assert(run.code === 0, `${label}: ${run.output}`)
      assert(!profileExistsIn(copy, victim.profileId), `${label}: профилът е възкресен`)
    }
  })

  await check('[D4] Restore + reconcile: доказаното изтриване се прилага повторно; отмяна в регистъра след доказателството се пренебрегва', async () => {
    const copy = join(root, 'restore-m1-reconcile.sqlite')
    writeFileSync(copy, readFileSync(restoreAfterIntent))
    const result = await reconcileApply(copy)
    assert(!profileExistsIn(copy, victim.profileId), `възкресен: ${result.lines.slice(-4).join(' | ')}`)
    const state = summarizeRequestLedgerState(readProfileDeletionLedger(ledgerPath).records).get(victimId)!
    assertEqual(state.resolution, 'deleted', 'регистърът')
  })

  await check('[D5] Предходна отмяна в регистъра продължава да блокира изтриването: restore отпреди отмяната + worker в отделен процес — профилът остава', async () => {
    const user = registerUser('Cancelled')
    const requestId = overdueRequest(user)
    const copy = vacuumTo('restore-before-cancel.sqlite')
    assert(adminCancel(adminStore, requestId).ok, 'приета')
    const cancellationStore = await createProfileDeletionCancellationStore(databaseFilePath)
    try {
      const finalizer = createProfileDeletionCancellationFinalizer({ store: cancellationStore, ledgerPath, offsiteRequired: true })
      finalizer.runOnce(); writeTestLedgerAck(ledgerPath); finalizer.runOnce()
    } finally {
      cancellationStore.close()
    }
    assertEqual(row(requestId).status, 'cancelled', 'окончателна')
    const run = await workerChild(copy, [requestId]).done
    assert(run.code === 0 && run.output.includes('"completed":0'), run.output)
    assert(profileExistsIn(copy, user.profileId), 'профилът е изтрит въпреки отмяната')
  })

  await check('[D6] Рестарт на finalizer-а: процесът умира след записа на отмяната и преди COMMIT; нов процес/инстанция довършва без дубликат', async () => {
    const user = registerUser('FinalizerCrash')
    const requestId = overdueRequest(user)
    const accepted = adminCancel(adminStore, requestId)
    assert(accepted.ok, 'приета')
    const crashed = await runChild('finalizer-crash-after-append', { databaseFilePath, ledgerPath, cancellationId: accepted.ok ? accepted.cancellationId : '' }).done
    assertEqual(crashed.code, 9, crashed.output)
    const cancellationStore = await createProfileDeletionCancellationStore(databaseFilePath)
    try {
      assertEqual(cancellationStore.getForRequest(requestId)!.ledgerRecordedAt, null, 'маркировката е върната')
      const finalizer = createProfileDeletionCancellationFinalizer({ store: cancellationStore, ledgerPath, offsiteRequired: true })
      finalizer.runOnce(); writeTestLedgerAck(ledgerPath); finalizer.runOnce()
    } finally {
      cancellationStore.close()
    }
    assertEqual(row(requestId).status, 'cancelled', 'окончателна')
    assertEqual(readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.includes('request_cancelled') && l.includes(requestId)).length, 1, 'дубликат')
    assert(isProfileDeletionLedgerRecordConfirmedOffsite(ledgerPath, `request_cancelled:${requestId}`), 'offsite')
  })

  await check('[D7] Неуспешен запис на доказателството (повреден регистър): ROLLBACK — нищо не е изтрито; заявката е failed ledger_write_failed с нов опит', async () => {
    const user = registerUser('NoProof')
    const requestId = overdueRequest(user)
    const first = await workerChild(databaseFilePath, [requestId]).done // намерение
    assert(first.code === 0, first.output)
    writeTestLedgerAck(ledgerPath)
    const cleanLedger = readFileSync(ledgerPath)
    appendFileSync(ledgerPath, 'corrupt-line\n')
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), requestId)
    // Регистърът е повреден -> още проверката за отмяна отказва (fail-closed).
    const run = await workerChild(databaseFilePath, [requestId]).done
    assert(run.code === 0, run.output)
    assertEqual(row(requestId).db_deleted_at, null, 'изтрито при повреден регистър')
    assert(profileExistsIn(databaseFilePath, user.profileId), 'профилът')
    writeFileSync(ledgerPath, cleanLedger)
    // Отказ точно при записа на доказателството: регистърът се поврежда между проверките.
    const executorFail = await createProfileDeletionExecutor(databaseFilePath)
    try {
      db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), requestId)
      const claimed = executorFail.claimNextDueRequest('w-proof', requestId)
      assert(claimed !== null, 'claim')
      const result = executorFail.runDatabasePhase(claimed!, 'w-proof', { beforeCommit: () => { throw new Error('disk full') } })
      assert(result.kind === 'failed' && result.code === 'ledger_write_failed' && result.willRetry, JSON.stringify(result))
    } finally {
      executorFail.close()
    }
    assertEqual(row(requestId).db_deleted_at, null, 'изтрито без доказателство')
    assertEqual(row(requestId).last_error_code, 'ledger_write_failed', 'код')
    assert(profileExistsIn(databaseFilePath, user.profileId), 'профилът')
  })

  await check('[D8] Липсващ регистър: worker-ът не изтрива (няма потвърдено намерение) — fail-closed', async () => {
    const user = registerUser('NoLedger')
    const requestId = overdueRequest(user)
    const missingLedger = join(root, 'missing-ledger', 'profile-deletions.jsonl')
    const run = await runChild('worker', { databaseFilePath, ledgerPath: missingLedger, uploadRoots, requestIds: [requestId], crashAt: null }).done
    assert(run.code === 0, run.output)
    assert(profileExistsIn(databaseFilePath, user.profileId), 'изтрит без потвърден регистър')
    assertEqual(row(requestId).db_deleted_at, null, 'db_deleted_at')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const close of closers.splice(0).reverse()) { try { close() } catch { /* ignore */ } }
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

function intentFor(requestId: string): Parameters<typeof ensureProfileDeletionLedgerEntry>[1] {
  return {
    v: 1, requestId, profileId: `profile-${requestId}`, accountIdSnapshot: `account-${requestId}`, profileCreatedAtSnapshot: '2026-01-01 00:00:00',
    requestedAt: '2026-01-01T00:00:00.000Z', scheduledFor: '2026-01-31T00:00:00.000Z', recordedAt: new Date().toISOString(),
  }
}

console.log('\n════════════════════════════════════════════════════════════')
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
