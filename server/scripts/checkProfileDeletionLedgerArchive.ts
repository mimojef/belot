/**
 * checkProfileDeletionLedgerArchive.ts
 *
 * Самоизтриване, Етап 4C — регистърът на окончателните изтривания извън VPS
 * и възстановяването му. ИЗОЛИРАНИ временни бази/директории; реалните bash
 * скриптове (ops/pikabg-backup/scripts/pikabg-ledger-*) се пускат със stub
 * rclone (локална "отдалечена" директория) и stub flock — по методологията
 * от ops/pikabg-backup/README.md. CLI-то се пуска от dist (продукционният
 * път) — изисква актуален `npm run build` (проверява се).
 *
 * [A] Регистър: идемпотентен запис, непълна опашка, повреда, потвърждение извън VPS.
 * [B] Worker: изтриване в базата само след потвърдено външно копие.
 * [C] pikabg-ledger-backup: успех, без промяна, недостъпно/повредено хранилище,
 *     повреден регистър, прекъсване между качване и потвърждение.
 * [D] merge: обединение, дубликати, повреден/непълен най-нов snapshot,
 *     разклонена история, конфликт, липса.
 * [E] Restore: стар backup + изтривания след него, повторно изпълнение,
 *     база отпреди нови миграции (migrate преди съгласуването),
 *     остарял/липсващ/повреден регистър, прекъсване по време на съгласуване,
 *     недостъпно хранилище, запазване на останалите данни.
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import {
  appendProfileDeletionLedgerEntry,
  ensureProfileDeletionLedgerEntry,
  getProfileDeletionLedgerOffsiteAckPath,
  isProfileDeletionLedgerRequestConfirmedOffsite,
  readProfileDeletionLedger,
  readProfileDeletionLedgerOffsiteAck,
  type ProfileDeletionLedgerEntry,
} from '../src/db/profileDeletionLedger.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { removeProfileDeletionFile, type ProfileDeletionUploadRoots } from '../src/uploads/profileDeletionFileRemoval.js'
import { confirmLedgerSnapshotOffsite, createLedgerSnapshot, mergeLedgerSnapshots } from '../src/ops/profileDeletionLedgerArchive.js'

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

const serverRoot = resolve(process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const repoRoot = resolve(serverRoot, '..')
const SECRET = 'profile-deletion-ledger-archive-test-secret-0123'
const CLI = join(serverRoot, 'dist', 'ops', 'profileDeletionLedgerCli.js')
const BACKUP_SCRIPT = join(repoRoot, 'ops', 'pikabg-backup', 'scripts', 'pikabg-ledger-backup')
const RESTORE_SCRIPT = join(repoRoot, 'ops', 'pikabg-backup', 'scripts', 'pikabg-ledger-restore')
const toPosix = (path: string) => path.replace(/\\/g, '/')

console.log('\ncheckProfileDeletionLedgerArchive')

// dist трябва да отговаря на src (bash скриптовете ползват dist).
{
  const newestSource = ['src/ops/profileDeletionLedgerCli.ts', 'src/ops/profileDeletionLedgerArchive.ts', 'src/ops/profileDeletionLedgerReconcile.ts', 'src/ops/profileDeletionRestoredDbMigrations.ts', 'src/db/profileDeletionLedger.ts', 'src/db/profileDeletionExecutor.ts']
    .map((file) => statSync(join(serverRoot, file)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0)
  if (!existsSync(CLI) || statSync(CLI).mtimeMs < newestSource) {
    console.error('  FAIL  dist е по-стар от src — пусни `npm run build` преди теста')
    process.exit(1)
  }
}

const root = await mkdtemp(join(tmpdir(), 'belot-ledger-archive-'))
await mkdir(join(root, 'database', 'migrations'), { recursive: true })
await mkdir(join(root, 'database', 'data'), { recursive: true })
for (const entry of await readdir(join(serverRoot, 'database', 'migrations'), { withFileTypes: true })) {
  if (entry.isFile() && extname(entry.name) === '.sql') await cp(join(serverRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
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
const executor = await createProfileDeletionExecutor(databaseFilePath)

const uploadsRoot = join(root, 'uploads')
const rootsFor = (base: string): ProfileDeletionUploadRoots => ({
  avatars: join(base, 'avatars'),
  profileGallery: join(base, 'profile-gallery'),
  chatAttachments: join(base, 'chat-attachments'),
  topicAttachments: join(base, 'topic-attachments'),
  topicMuteEvidenceAttachments: join(base, 'topic-mute-evidence-attachments'),
  supportAttachments: join(base, 'support-attachments'),
})
for (const dir of Object.values(rootsFor(uploadsRoot))) mkdirSync(dir, { recursive: true })
const liveLedger = join(root, 'deletion-ledger', 'profile-deletions.jsonl')
const liveAck = getProfileDeletionLedgerOffsiteAckPath(liveLedger)

// ─── stub rclone / flock ───────────────────────────────────────────────────
const stubDir = join(root, 'stub-bin')
const remoteDir = join(root, 'remote')
mkdirSync(stubDir, { recursive: true })
mkdirSync(remoteDir, { recursive: true })
const rcloneStubJs = join(stubDir, 'rclone-stub.cjs')
writeFileSync(rcloneStubJs, `
const fs = require('fs'); const path = require('path'); const crypto = require('crypto')
const [cmd, ...args] = process.argv.slice(2)
const fail = (process.env.STUB_RCLONE_FAIL || '').split(',')
const remote = (p) => p.startsWith('pikabg-drive:') ? path.join(process.env.STUB_REMOTE_DIR, p.slice('pikabg-drive:'.length)) : p
if (fail.includes(cmd)) { console.error('stub rclone: simulated failure ' + cmd); process.exit(1) }
if (cmd === 'mkdir') { fs.mkdirSync(remote(args[0]), { recursive: true }); process.exit(0) }
if (cmd === 'copyto') {
  const dst = remote(args[1]); fs.mkdirSync(path.dirname(dst), { recursive: true })
  let data = fs.readFileSync(args[0])
  if (process.env.STUB_RCLONE_CORRUPT === '1' && dst.endsWith('.jsonl')) data = Buffer.concat([data, Buffer.from('x')])
  fs.writeFileSync(dst, data); process.exit(0)
}
if (cmd === 'md5sum') {
  const p = remote(args[0]); if (!fs.existsSync(p)) process.exit(0)
  console.log(crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') + '  ' + path.basename(p)); process.exit(0)
}
if (cmd === 'copy') {
  const src = remote(args[0]); const dst = remote(args[1])
  if (!fs.existsSync(src)) { console.error('stub rclone: source missing'); process.exit(3) }
  fs.cpSync(src, dst, { recursive: true }); process.exit(0)
}
console.error('stub rclone: unsupported ' + cmd); process.exit(9)
`)
const rcloneStub = join(stubDir, 'rclone')
writeFileSync(rcloneStub, `#!/usr/bin/env bash\nexec "${toPosix(process.execPath)}" "${toPosix(rcloneStubJs)}" "$@"\n`, { mode: 0o755 })
writeFileSync(join(stubDir, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

function bashEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const pathSep = process.platform === 'win32' ? ';' : ':'
  return {
    ...process.env,
    PATH: `${stubDir}${pathSep}${process.env.PATH ?? ''}`,
    PIKABG_LEDGER_PATH: toPosix(liveLedger),
    PIKABG_LEDGER_ACK_PATH: toPosix(liveAck),
    PIKABG_LEDGER_CLI: toPosix(CLI),
    PIKABG_LEDGER_LOCAL_ROOT: toPosix(join(root, 'local-backups')),
    PIKABG_REMOTE_LEDGER_ROOT: 'pikabg-drive:PikaBG-Backups/deletion-ledger',
    PIKABG_LEDGER_LOCK_FILE: toPosix(join(root, 'ledger-backup.lock')),
    PIKABG_RCLONE: toPosix(rcloneStub),
    PIKABG_NODE: toPosix(process.execPath),
    STUB_REMOTE_DIR: remoteDir,
    ...extra,
  }
}
function runBash(script: string, args: string[] = [], extra: Record<string, string> = {}): { status: number | null; out: string } {
  const result = spawnSync('bash', [toPosix(script), ...args], { encoding: 'utf8', env: bashEnv(extra) })
  if (result.error) throw result.error
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}
function runCli(args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}
const remoteLedgerDir = join(remoteDir, 'PikaBG-Backups', 'deletion-ledger')
function remoteFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => { if (!existsSync(dir)) return; for (const name of readdirSync(dir)) { const full = join(dir, name); if (statSync(full).isDirectory()) walk(full); else out.push(full) } }
  walk(remoteLedgerDir)
  return out.sort()
}

// ─── помощни ───────────────────────────────────────────────────────────────
type User = { profileId: string; accountId: string }
let counter = 0
function registerUser(label: string): User {
  counter += 1
  const result = authStore.register({ email: `ledger-${label.toLowerCase()}-${counter}@example.test`, password: 'secret123', displayName: `Ledger${label}${counter}`, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
  return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId }
}
const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
const isoPlus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
function insertDueRequest(user: User): string {
  const requestId = randomUUID()
  const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
  const scheduledFor = isoPlus(dbNow(), -1000)
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
const makeRetryDue = (requestId: string) => db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), requestId)
const requestRow = (requestId: string) => db.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
const profileExistsIn = (database: SqliteDatabase, profileId: string) => database.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(profileId) !== undefined
function liveWorker(workerId: string, onlyRequestIds: string[]) {
  return createProfileDeletionWorker({
    executor,
    workerId,
    uploadRoots: rootsFor(uploadsRoot),
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: (entry) => { ensureProfileDeletionLedgerEntry(liveLedger, entry) },
    isLedgerEntryConfirmedOffsite: (requestId) => isProfileDeletionLedgerRequestConfirmedOffsite(liveLedger, requestId),
    onlyRequestIds,
  })
}
function giveAvatar(user: User): string {
  const name = `${randomUUID()}.webp`
  writeFileSync(join(uploadsRoot, 'avatars', name), 'avatar')
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${name}`, user.profileId)
  return name
}
function entryFor(user: User, requestId = randomUUID()): ProfileDeletionLedgerEntry {
  const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string } | undefined)?.created_at ?? '2026-01-01 00:00:00'
  const now = new Date().toISOString()
  return { v: 1, requestId, profileId: user.profileId, accountIdSnapshot: user.accountId, profileCreatedAtSnapshot: createdAt, requestedAt: now, scheduledFor: now, recordedAt: now }
}
/** Пълен цикъл на live изтриване: worker (блокира) -> pikabg-ledger-backup -> worker (изтрива). */
async function deleteWithOffsiteBackup(user: User): Promise<string> {
  return deleteRequestWithOffsiteBackup(insertDueRequest(user))
}
async function deleteRequestWithOffsiteBackup(requestId: string): Promise<string> {
  const first = await liveWorker(`w-${counter}`, [requestId]).runOnce()
  assertEqual(first.blocked, 1, 'преди качването — blocked')
  assertEqual(requestRow(requestId).last_error_code, 'ledger_offsite_pending', 'код')
  const backup = runBash(BACKUP_SCRIPT)
  assertEqual(backup.status, 0, `pikabg-ledger-backup (${backup.out.slice(-400)})`)
  makeRetryDue(requestId)
  assertEqual((await liveWorker(`w-${counter}b`, [requestId]).runOnce()).completed, 1, 'след потвърждението — completed')
  return requestId
}

try {
  const bashCheck = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' })
  if (bashCheck.status !== 0) throw new Error('bash не е наличен — тестът изисква bash (Linux или Git Bash)')

  console.log('\n[A] Регистър')
  const scratch = join(root, 'scratch')
  mkdirSync(scratch, { recursive: true })

  await check('[A1] Идемпотентен запис: един ред на заявка; същият requestId с друга идентичност — отказ', () => {
    const path = join(scratch, 'a1.jsonl')
    const user = registerUser('A1')
    const entry = entryFor(user)
    assertEqual(ensureProfileDeletionLedgerEntry(path, entry), 'appended', 'първи')
    assertEqual(ensureProfileDeletionLedgerEntry(path, { ...entry, recordedAt: new Date(Date.now() + 5000).toISOString() }), 'exists', 'повторен')
    assertEqual(readProfileDeletionLedger(path).lineCount, 1, 'редове')
    assertThrows(() => ensureProfileDeletionLedgerEntry(path, { ...entry, profileId: randomUUID() }), 'profile_deletion_ledger_conflict', 'конфликт')
  })

  await check('[A2] Прекъснат запис: непълната опашка не е запис и се отрязва при следващия; невалиден ПЪЛЕН ред = повреда', () => {
    const path = join(scratch, 'a2.jsonl')
    const first = entryFor(registerUser('A2a'))
    appendProfileDeletionLedgerEntry(path, first)
    appendFileSync(path, '{"v":1,"requestId":"half')
    const torn = readProfileDeletionLedger(path)
    assert(torn.trailingPartialBytes > 0 && torn.invalidLineCount === 0 && torn.entries.length === 1, 'непълната опашка е игнорирана')
    const second = entryFor(registerUser('A2b'))
    appendProfileDeletionLedgerEntry(path, second)
    const repaired = readProfileDeletionLedger(path)
    assert(repaired.trailingPartialBytes === 0 && repaired.invalidLineCount === 0 && repaired.entries.length === 2, 'отрязана и продължена')
    appendFileSync(path, 'not-json\n')
    assertThrows(() => ensureProfileDeletionLedgerEntry(path, entryFor(registerUser('A2c'))), 'profile_deletion_ledger_corrupt', 'повреда')
  })

  await check('[A3] Потвърждение извън VPS: липсващ ack, по-стар префикс, подменен или съкратен регистър -> false; точен префикс -> true', () => {
    const path = join(scratch, 'a3', 'profile-deletions.jsonl')
    const ack = getProfileDeletionLedgerOffsiteAckPath(path)
    const e1 = entryFor(registerUser('A3a'))
    const e2 = entryFor(registerUser('A3b'))
    appendProfileDeletionLedgerEntry(path, e1)
    assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(path, e1.requestId), false, 'без ack')
    const snap = createLedgerSnapshot({ ledgerPath: path, outDir: join(scratch, 'a3-out'), ackPath: ack })
    if (snap.status !== 'created') throw new Error('snapshot')
    confirmLedgerSnapshotOffsite({ ledgerPath: path, snapshotPath: snap.snapshotPath, manifestPath: snap.manifestPath, remotePath: 'remote:x', ackPath: ack })
    appendProfileDeletionLedgerEntry(path, e2)
    assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(path, e1.requestId), true, 'e1 е в префикса')
    assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(path, e2.requestId), false, 'e2 е след префикса')
    const original = readFileSync(path)
    writeFileSync(path, original.toString('utf8').replace(e1.profileId, randomUUID()))
    assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(path, e1.requestId), false, 'подменен регистър')
    writeFileSync(path, original.subarray(0, 10))
    assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(path, e1.requestId), false, 'съкратен регистър')
    writeFileSync(path, original)
    writeFileSync(ack, '{broken')
    assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(path, e1.requestId), false, 'повреден ack')
  })

  console.log('\n[B] Worker — изтриване в базата само след потвърдено външно копие')

  await check('[B1] Без потвърждение: blocked (ledger_offsite_pending), профилът е непокътнат, регистърът има точно 1 ред и при повторни опити; след pikabg-ledger-backup — изтрит', async () => {
    const user = registerUser('B1')
    const requestId = insertDueRequest(user)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const summary = await liveWorker('w-b1', [requestId]).runOnce()
      assertEqual(summary.blocked, 1, `опит ${attempt}`)
      makeRetryDue(requestId)
    }
    assert(profileExistsIn(db, user.profileId), 'профилът')
    assertEqual(requestRow(requestId).db_deleted_at, null, 'базата не е изтрита')
    assertEqual(readProfileDeletionLedger(liveLedger).entries.filter((e) => e.requestId === requestId).length, 1, 'един запис')
    assertEqual(readProfileDeletionLedger(liveLedger).lineCount, 1, 'без дублирани редове')
    const backup = runBash(BACKUP_SCRIPT)
    assertEqual(backup.status, 0, `backup (${backup.out.slice(-300)})`)
    assertEqual((await liveWorker('w-b1', [requestId]).runOnce()).completed, 1, 'completed')
    assert(!profileExistsIn(db, user.profileId), 'изтрит')
  })

  console.log('\n[C] pikabg-ledger-backup')

  await check('[C1] Успех: snapshot + manifest в отдалеченото хранилище, проверен MD5, ack за точния префикс; без промяна — нищо не се качва', () => {
    const files = remoteFiles()
    assert(files.some((f) => f.endsWith('.jsonl')) && files.some((f) => f.endsWith('.jsonl.manifest.json')), 'файловете в хранилището')
    const ack = readProfileDeletionLedgerOffsiteAck(liveAck)
    assert(ack !== null, 'ack')
    const live = readFileSync(liveLedger)
    assertEqual(ack!.bytes, live.length, 'ack покрива целия регистър')
    assertEqual(ack!.sha256, createHash('sha256').update(live).digest('hex'), 'sha256')
    const again = runBash(BACKUP_SCRIPT)
    assert(again.status === 0 && again.out.includes('unchanged'), `без промяна (${again.out.slice(-200)})`)
    assertEqual(remoteFiles().length, files.length, 'нищо ново не е качено')
  })

  await check('[C2] Недостъпно хранилище (copyto / md5sum се провалят): изход != 0, ack НЕ е променен, новият запис не е потвърден', () => {
    const before = readFileSync(liveAck, 'utf8')
    const entry = entryFor(registerUser('C2'))
    ensureProfileDeletionLedgerEntry(liveLedger, entry)
    for (const failing of ['copyto', 'md5sum', 'mkdir']) {
      const result = runBash(BACKUP_SCRIPT, [], { STUB_RCLONE_FAIL: failing })
      assert(result.status !== 0, `${failing}: изход ${result.status}`)
      assertEqual(readFileSync(liveAck, 'utf8'), before, `${failing}: ack`)
      assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(liveLedger, entry.requestId), false, `${failing}: не е потвърден`)
    }
  })

  await check('[C3] Повредено качване (различен MD5): изход 3, ack НЕ е променен; следващият нормален опит потвърждава', () => {
    const before = readFileSync(liveAck, 'utf8')
    const corrupt = runBash(BACKUP_SCRIPT, [], { STUB_RCLONE_CORRUPT: '1' })
    assertEqual(corrupt.status, 3, `изход (${corrupt.out.slice(-200)})`)
    assertEqual(readFileSync(liveAck, 'utf8'), before, 'ack')
    const ok = runBash(BACKUP_SCRIPT)
    assertEqual(ok.status, 0, `нормален опит (${ok.out.slice(-200)})`)
    const pending = readProfileDeletionLedger(liveLedger).entries
    assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(liveLedger, pending[pending.length - 1]!.requestId), true, 'потвърден')
  })

  await check('[C4] Прекъсване между snapshot/качване и потвърждение: ack не се променя, изтриванията чакат; следващото пускане довършва', () => {
    const entry = entryFor(registerUser('C4'))
    ensureProfileDeletionLedgerEntry(liveLedger, entry)
    const before = readFileSync(liveAck, 'utf8')
    const snap = runCli(['snapshot', `--ledger=${liveLedger}`, `--out-dir=${join(root, 'local-backups', 'pending')}`, `--ack=${liveAck}`])
    assertEqual(snap.status, 0, 'snapshot')
    // "срив" тук — няма качване и няма confirm
    assertEqual(readFileSync(liveAck, 'utf8'), before, 'ack')
    assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(liveLedger, entry.requestId), false, 'не е потвърден')
    assertEqual(runBash(BACKUP_SCRIPT).status, 0, 'следващо пускане')
    assertEqual(isProfileDeletionLedgerRequestConfirmedOffsite(liveLedger, entry.requestId), true, 'потвърден')
  })

  await check('[C5] Повреден регистър (невалиден пълен ред): изход != 0, нищо не се качва, ack НЕ е променен', () => {
    const scratchLedger = join(scratch, 'c5', 'profile-deletions.jsonl')
    mkdirSync(join(scratch, 'c5'), { recursive: true })
    writeFileSync(scratchLedger, `${readFileSync(liveLedger, 'utf8')}garbage\n`)
    const filesBefore = remoteFiles().length
    const result = runBash(BACKUP_SCRIPT, [], { PIKABG_LEDGER_PATH: toPosix(scratchLedger), PIKABG_LEDGER_ACK_PATH: toPosix(join(scratch, 'c5', 'ack.json')) })
    assert(result.status !== 0 && result.out.includes('ledger_corrupt'), `изход ${result.status} (${result.out.slice(-200)})`)
    assertEqual(remoteFiles().length, filesBefore, 'нищо не е качено')
    assert(!existsSync(join(scratch, 'c5', 'ack.json')), 'ack не е създаден')
  })

  console.log('\n[D] merge (най-новото надеждно състояние)')

  function makeSnapshotDir(name: string, ledgers: string[]): string {
    const dir = join(scratch, name)
    for (const [index, content] of ledgers.entries()) {
      const ledger = join(scratch, `${name}-src-${index}.jsonl`)
      writeFileSync(ledger, content)
      const snap = createLedgerSnapshot({ ledgerPath: ledger, outDir: join(dir, `day-${index}`), ackPath: join(scratch, `${name}-noack.json`), now: new Date(Date.UTC(2026, 9, 1 + index)) })
      if (snap.status !== 'created') throw new Error('snapshot')
    }
    return dir
  }
  const line = (entry: ProfileDeletionLedgerEntry) => `${JSON.stringify(entry)}\n`
  const d1 = entryFor(registerUser('D1'))
  const d2 = entryFor(registerUser('D2'))
  const d3 = entryFor(registerUser('D3'))

  await check('[D1] Обединение на всички snapshot-и + живия регистър; дублираните редове се свеждат до един', () => {
    const dir = makeSnapshotDir('d1', [line(d1), line(d1) + line(d2)])
    const local = join(scratch, 'd1-local.jsonl')
    writeFileSync(local, line(d1) + line(d2) + line(d3) + line({ ...d3, recordedAt: new Date(Date.now() + 1).toISOString() }))
    const { entries, report } = mergeLedgerSnapshots({ snapshotDir: dir, localLedgerPath: local })
    assertEqual(entries.map((e) => e.requestId).join(','), [d1, d2, d3].map((e) => e.requestId).join(','), 'обединение')
    assertEqual(report.validSnapshots.length, 2, 'валидни')
    assertEqual(report.localLedger, 'used', 'живият регистър')
  })

  await check('[D2] Повреден/непълен най-нов snapshot -> отказ; с --accept-missing-newest -> по-старите + предупреждение; snapshot без manifest -> отчетен', () => {
    const dir = makeSnapshotDir('d2', [line(d1), line(d1) + line(d2)])
    const newest = readdirSync(join(dir, 'day-1')).find((name) => name.endsWith('.jsonl'))!
    writeFileSync(join(dir, 'day-1', newest), line(d1)) // непълно качване
    writeFileSync(join(dir, 'day-1', 'orphan.jsonl'), line(d3)) // без manifest
    assertThrows(() => mergeLedgerSnapshots({ snapshotDir: dir }), 'newest_snapshot_invalid', 'отказ')
    const { entries, report } = mergeLedgerSnapshots({ snapshotDir: dir, acceptMissingNewest: true })
    assertEqual(entries.length, 1, 'само по-старият')
    assert(report.warnings.some((w) => w.startsWith('newest_snapshot_invalid_accepted')), 'предупреждение')
    assert(report.invalidSnapshots.some((s) => s.code === 'manifest_missing'), 'без manifest')
  })

  await check('[D3] Разклонена история, конфликт, липса на всякакъв регистър -> отказ; --confirm-no-deletions-ever -> празен', () => {
    assertThrows(() => mergeLedgerSnapshots({ snapshotDir: makeSnapshotDir('d3a', [line(d1), line(d2)]) }), 'ledger_history_diverged', 'разклонена')
    const local = join(scratch, 'd3-local.jsonl')
    writeFileSync(local, line({ ...d1, profileId: randomUUID() }))
    assertThrows(() => mergeLedgerSnapshots({ snapshotDir: makeSnapshotDir('d3b', [line(d1)]), localLedgerPath: local }), 'local_ledger_diverged', 'конфликт с живия')
    assertThrows(() => mergeLedgerSnapshots({ snapshotDir: join(scratch, 'd3-empty') }), 'no_ledger_available', 'липса')
    assertEqual(mergeLedgerSnapshots({ snapshotDir: join(scratch, 'd3-empty'), confirmNoDeletionsEver: true }).entries.length, 0, 'празен')
  })

  console.log('\n[E] Restore')

  // Сценарий: другите данни, стар backup, изтривания след него.
  const keeper = registerUser('Keeper')
  db.prepare(`INSERT INTO topic_messages (message_id, topic_id, sender_profile_id, sender_display_name, sender_role, body) VALUES (?, 'topic-general', ?, 'Keeper', 'player', 'остава');`).run(randomUUID(), keeper.profileId)
  const keeperAvatar = giveAvatar(keeper)
  const victim1 = registerUser('Victim1')
  const victim2 = registerUser('Victim2')
  const victim3 = registerUser('Victim3') // заявката е вече в backup-а
  const avatars = [giveAvatar(victim1), giveAvatar(victim2), giveAvatar(victim3)]
  const victim3Request = insertDueRequest(victim3)
  const backupDir = join(root, 'backups')
  mkdirSync(backupDir, { recursive: true })
  const oldBackup = join(backupDir, 'old.sqlite')
  db.exec(`VACUUM INTO '${oldBackup.replace(/'/g, "''")}';`)
  const oldUploads = join(backupDir, 'old-uploads')
  cpSync(uploadsRoot, oldUploads, { recursive: true })

  await deleteWithOffsiteBackup(victim1)
  const remoteAfterVictim1 = join(backupDir, 'remote-after-victim1')
  cpSync(remoteLedgerDir, remoteAfterVictim1, { recursive: true })
  await deleteWithOffsiteBackup(victim2)
  await deleteRequestWithOffsiteBackup(victim3Request) // заявката е и в стария backup
  assert(!profileExistsIn(db, victim3.profileId), 'victim3 е изтрит live')

  function freshRestore(name: string, backup: string): { dir: string; dbPath: string; uploads: string } {
    const dir = join(root, 'restore', name)
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, 'belot-v2.sqlite')
    cpSync(backup, dbPath)
    const uploads = join(dir, 'uploads')
    cpSync(oldUploads, uploads, { recursive: true })
    return { dir, dbPath, uploads }
  }
  function keeperFingerprint(dbPath: string): string {
    const restored = new sqliteModule.DatabaseSync(dbPath, { readOnly: true })
    try {
      return JSON.stringify({
        profile: restored.prepare('SELECT profile_id, display_name, avatar_url FROM profiles WHERE profile_id = ?;').get(keeper.profileId),
        wallet: restored.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;').get(keeper.profileId),
        posts: restored.prepare('SELECT message_id, body FROM topic_messages WHERE sender_profile_id = ? ORDER BY seq;').all(keeper.profileId),
      })
    } finally {
      restored.close()
    }
  }

  await check('[E1] Стар backup + 3 изтривания след него: pikabg-ledger-restore (всички отдалечени snapshot-и) -> reconcile --apply -> --verify-only OK; файловете са изтрити; другите данни непокътнати', () => {
    const restore = freshRestore('e1', oldBackup)
    const keeperBefore = keeperFingerprint(restore.dbPath)
    const target = join(root, 'ledger-restore-e1')
    const merged = runBash(RESTORE_SCRIPT, ['--target-dir', toPosix(target), '--restored-db', toPosix(restore.dbPath)])
    assertEqual(merged.status, 0, `ledger-restore (${merged.out.slice(-500)})`)
    const mergedLedger = join(target, 'merged-ledger.jsonl')
    const report = runCli(['reconcile', `--db=${restore.dbPath}`, `--ledger=${mergedLedger}`])
    assert(report.out.includes(`request_missing requestId=`) && report.out.includes(`request_present requestId=${victim3Request}`), `категории (${report.out.slice(-400)})`)
    const apply = runCli(['reconcile', `--db=${restore.dbPath}`, `--ledger=${mergedLedger}`, '--apply', '--confirm=REAPPLY-PROFILE-DELETIONS', `--uploads-root=${restore.uploads}`])
    assertEqual(apply.status, 0, `apply (${apply.out.slice(-600)})`)
    const verify = runCli(['reconcile', `--db=${restore.dbPath}`, `--ledger=${mergedLedger}`, '--verify-only'])
    assertEqual(verify.status, 0, `verify (${verify.out.slice(-300)})`)
    const restored = new sqliteModule.DatabaseSync(restore.dbPath, { readOnly: true })
    for (const victim of [victim1, victim2, victim3]) assert(!profileExistsIn(restored, victim.profileId), 'изтрит')
    assertEqual((restored.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'FK')
    restored.close()
    for (const avatar of avatars) assert(!existsSync(join(restore.uploads, 'avatars', avatar)), `файл ${avatar}`)
    assert(existsSync(join(restore.uploads, 'avatars', keeperAvatar)), 'файлът на другия потребител')
    assertEqual(keeperFingerprint(restore.dbPath), keeperBefore, 'данните на другия потребител')
  })

  await check('[E2] Повторно изпълнение на restore/reconcile: idempotent — exit 0, нищо ново не се променя', () => {
    const restore = join(root, 'restore', 'e1', 'belot-v2.sqlite')
    const ledger = join(root, 'ledger-restore-e1', 'merged-ledger.jsonl')
    const before = keeperFingerprint(restore)
    const again = runCli(['reconcile', `--db=${restore}`, `--ledger=${ledger}`, '--apply', '--confirm=REAPPLY-PROFILE-DELETIONS', `--uploads-root=${join(root, 'restore', 'e1', 'uploads')}`])
    assertEqual(again.status, 0, `exit (${again.out.slice(-300)})`)
    assertEqual(keeperFingerprint(restore), before, 'непроменено')
  })

  await check('[E3] Остарял външен регистър (само до victim1) с backup след victim2: отчетът е 1 (ledger_stale), --apply отказва и нищо не променя', () => {
    const lateBackup = join(backupDir, 'late.sqlite')
    db.exec(`VACUUM INTO '${lateBackup.replace(/'/g, "''")}';`)
    const restore = freshRestore('e3', lateBackup)
    const target = join(root, 'ledger-restore-e3')
    const merged = runBash(RESTORE_SCRIPT, ['--target-dir', toPosix(target), '--snapshots-dir', toPosix(remoteAfterVictim1)])
    assertEqual(merged.status, 0, `merge на старото копие (${merged.out.slice(-300)})`)
    const ledger = join(target, 'merged-ledger.jsonl')
    const report = runCli(['reconcile', `--db=${restore.dbPath}`, `--ledger=${ledger}`])
    assert(report.status === 1 && report.out.includes('ledger_stale'), `отчет (${report.out.slice(-300)})`)
    const before = readFileSync(restore.dbPath)
    const apply = runCli(['reconcile', `--db=${restore.dbPath}`, `--ledger=${ledger}`, '--apply', '--confirm=REAPPLY-PROFILE-DELETIONS', `--uploads-root=${restore.uploads}`])
    assertEqual(apply.status, 1, 'apply отказан')
    assert(readFileSync(restore.dbPath).equals(before), 'базата е непроменена')
  })

  await check('[E4] Липсващ / повреден регистър: reconcile -> exit 2; restore скриптът без нито един snapshot -> отказ', () => {
    const restore = freshRestore('e4', oldBackup)
    assertEqual(runCli(['reconcile', `--db=${restore.dbPath}`, `--ledger=${join(root, 'missing.jsonl')}`]).status, 2, 'липсващ')
    const corrupt = join(root, 'corrupt.jsonl')
    writeFileSync(corrupt, 'garbage\n')
    assertEqual(runCli(['reconcile', `--db=${restore.dbPath}`, `--ledger=${corrupt}`]).status, 2, 'повреден')
    const emptySnapshots = join(root, 'empty-snapshots')
    mkdirSync(emptySnapshots, { recursive: true })
    const result = runBash(RESTORE_SCRIPT, ['--target-dir', toPosix(join(root, 'ledger-restore-e4')), '--snapshots-dir', toPosix(emptySnapshots)])
    assertEqual(result.status, 4, `restore без регистър (${result.out.slice(-300)})`)
    assert(!existsSync(join(root, 'ledger-restore-e4', 'merged-ledger.jsonl')), 'няма обединен регистър')
  })

  await check('[E5] Недостъпно външно хранилище при restore: изход 3, без обединен регистър', () => {
    const result = runBash(RESTORE_SCRIPT, ['--target-dir', toPosix(join(root, 'ledger-restore-e5'))], { STUB_RCLONE_FAIL: 'copy' })
    assertEqual(result.status, 3, `изход (${result.out.slice(-300)})`)
    assert(!existsSync(join(root, 'ledger-restore-e5', 'merged-ledger.jsonl')), 'няма обединен регистър')
  })

  await check('[E6] Прекъсване по време на съгласуване (след COMMIT, преди файловете): файловете остават в журнала; повторното изпълнение ги довършва; verify OK', () => {
    const restore = freshRestore('e6', oldBackup)
    const ledger = join(root, 'ledger-restore-e1', 'merged-ledger.jsonl')
    const args = ['reconcile', `--db=${restore.dbPath}`, `--ledger=${ledger}`, '--apply', '--confirm=REAPPLY-PROFILE-DELETIONS', `--uploads-root=${restore.uploads}`]
    const crashed = runCli(args, { PIKABG_TEST_RECONCILE_EXIT_AFTER_COMMIT: '1' })
    assertEqual(crashed.status, 70, `симулиран срив (${crashed.out.slice(-300)})`)
    const journal = readFileSync(join(`${restore.dbPath}.reconcile-state`, 'journal.jsonl'), 'utf8')
    assert(journal.includes('"planned"'), 'журналът съдържа плана')
    assert(avatars.some((avatar) => existsSync(join(restore.uploads, 'avatars', avatar))), 'файловете още са там')
    const verifyEarly = runCli(['reconcile', `--db=${restore.dbPath}`, `--ledger=${ledger}`, '--verify-only'])
    assertEqual(verifyEarly.status, 1, 'verify преди довършване — FAILED')
    const resumed = runCli(args)
    assertEqual(resumed.status, 0, `довършване (${resumed.out.slice(-400)})`)
    for (const avatar of avatars) assert(!existsSync(join(restore.uploads, 'avatars', avatar)), `файл ${avatar}`)
    assertEqual(runCli(['reconcile', `--db=${restore.dbPath}`, `--ledger=${ledger}`, '--verify-only']).status, 0, 'verify OK')
  })

  await check('[E7] Непълен най-нов snapshot в хранилището: restore отказва (изход 4); с --accept-missing-newest продължава с предупреждение', () => {
    const remoteCopy = join(root, 'remote-broken-newest')
    cpSync(remoteLedgerDir, remoteCopy, { recursive: true })
    const manifests: string[] = []
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (name.endsWith('.manifest.json')) manifests.push(full) } }
    walk(remoteCopy)
    const newest = manifests.map((path) => ({ path, createdAt: JSON.parse(readFileSync(path, 'utf8')).createdAt as string })).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop()!
    writeFileSync(newest.path.replace(/\.manifest\.json$/, ''), 'truncated')
    const refused = runBash(RESTORE_SCRIPT, ['--target-dir', toPosix(join(root, 'ledger-restore-e7a')), '--snapshots-dir', toPosix(remoteCopy)])
    assertEqual(refused.status, 4, `отказ (${refused.out.slice(-300)})`)
    const accepted = runBash(RESTORE_SCRIPT, ['--target-dir', toPosix(join(root, 'ledger-restore-e7b')), '--snapshots-dir', toPosix(remoteCopy), '--accept-missing-newest'])
    assertEqual(accepted.status, 0, `приет (${accepted.out.slice(-300)})`)
    assert(accepted.out.includes('newest_snapshot_invalid_accepted'), 'предупреждението е в отчета')
  })

  await check('[E8] База отпреди нова миграция (20261027_001): reconcile отказва (exit 2) със списък; migrate отказва живата база без промяна; мигрира копието; reconcile продължава', async () => {
    const oldRoot = join(root, 'old-schema-root')
    mkdirSync(join(oldRoot, 'database', 'migrations'), { recursive: true })
    for (const name of readdirSync(join(serverRoot, 'database', 'migrations'))) {
      if (name.endsWith('.sql') && name < '20261027_001') cpSync(join(serverRoot, 'database', 'migrations', name), join(oldRoot, 'database', 'migrations', name))
    }
    const { databaseFilePath: oldDb } = await ensureServerDatabaseReady({ serverRootOverride: oldRoot })
    const ledger = join(root, 'ledger-restore-e1', 'merged-ledger.jsonl')
    const refused = runCli(['reconcile', `--db=${oldDb}`, `--ledger=${ledger}`])
    assert(refused.status === 2 && refused.out.includes('restored_db_migrations_pending') && refused.out.includes('20261027_001'), `отказ (${refused.out.slice(-300)})`)
    const before = readFileSync(oldDb)
    const liveRefused = runCli(['migrate', `--db=${oldDb}`], { PROFILE_DELETION_LIVE_DB_PATH: oldDb })
    assert(liveRefused.status === 2 && liveRefused.out.includes('live_db_refused'), `живата база (${liveRefused.out.slice(-200)})`)
    assert(readFileSync(oldDb).equals(before), 'живата база е непроменена')
    const migrated = runCli(['migrate', `--db=${oldDb}`], { PROFILE_DELETION_LIVE_DB_PATH: join(root, 'not-this.sqlite') })
    assert(migrated.status === 0 && migrated.out.includes('20261027_001'), `migrate (${migrated.out.slice(-300)})`)
    assertEqual(runCli(['reconcile', `--db=${oldDb}`, `--ledger=${ledger}`]).status, 0, 'reconcile след migrate')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  try { executor.close() } catch { /* ignore */ }
  try { authStore.close() } catch { /* ignore */ }
  try { progressStore.close() } catch { /* ignore */ }
  db.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
