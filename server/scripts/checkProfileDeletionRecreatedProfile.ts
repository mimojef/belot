/**
 * checkProfileDeletionRecreatedProfile.ts
 *
 * Историческо административно изтриване, след което профил със СЪЩИЯ
 * profile_id е създаден наново (официалният профил с фиксиран UUID): друг
 * акаунт, по-късна дата на създаване. Backfill записва реалното изтриване,
 * шлюзът и reconcile разпознават новия профил (без блокиране и без повторно
 * изтриване), а всяко друго несъответствие остава fail-closed. САМО временни бази.
 *
 * [P] Предикат.  [B] Backfill.  [G] Шлюз на историята.  [R] Reconcile.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileDeletionHistoryGuard } from '../src/core/profileDeletionHistoryGuard.js'
import {
  ensureProfileDeletionLedgerRecord,
  isAdminDeletedProfileProvenRecreated,
  readProfileDeletionLedger,
  summarizeAdminLedgerOperations,
} from '../src/db/profileDeletionLedger.js'
import { runProfileDeletionAdminBackfill, ADMIN_BACKFILL_CONFIRMATION_PHRASE } from '../src/ops/profileDeletionAdminBackfill.js'
import { runProfileDeletionLedgerReconcile, REAPPLY_CONFIRMATION_PHRASE } from '../src/ops/profileDeletionLedgerReconcile.js'

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
const SECRET = 'profile-deletion-recreated-profile-secret-0123456789'

console.log('\ncheckProfileDeletionRecreatedProfile')

const tempRoots: string[] = []
const sqliteModule = await import('node:sqlite')

try {
  console.log('\n[P] Предикат')
  const completed = { state: 'completed' as const, deletedAt: '2026-09-08T06:01:05.000Z', accountIdSnapshot: 'old-account', profileCreatedAtSnapshot: null }
  await check('[P1] Друг акаунт + създаден след изтриването -> създаден наново (SQLite и ISO формат)', () => {
    assert(isAdminDeletedProfileProvenRecreated(completed, { account_id: 'new-account', created_at: '2026-09-08 06:41:02' }), 'sqlite формат')
    assert(isAdminDeletedProfileProvenRecreated(completed, { account_id: 'new-account', created_at: '2026-09-08T06:41:02.000Z' }), 'iso формат')
  })
  await check('[P2] Всяко друго несъответствие НЕ е „създаден наново“', () => {
    const cases: Array<[string, Parameters<typeof isAdminDeletedProfileProvenRecreated>[0], { account_id: string | null; created_at: string }]> = [
      ['същият акаунт (restore на стар backup)', completed, { account_id: 'old-account', created_at: '2026-09-08 06:41:02' }],
      ['създаден преди изтриването', completed, { account_id: 'new-account', created_at: '2026-09-08 05:00:00' }],
      ['създаден в същата секунда', completed, { account_id: 'new-account', created_at: '2026-09-08 06:01:05' }],
      ['профил без акаунт', completed, { account_id: null, created_at: '2026-09-08 06:41:02' }],
      ['неизвестен акаунт при изтриването', { ...completed, accountIdSnapshot: null }, { account_id: 'new-account', created_at: '2026-09-08 06:41:02' }],
      ['неизвестен момент на изтриване', { ...completed, deletedAt: null }, { account_id: 'new-account', created_at: '2026-09-08 06:41:02' }],
      ['невалидна дата на създаване', completed, { account_id: 'new-account', created_at: 'не е дата' }],
      ['само намерение', { ...completed, state: 'intent_only' }, { account_id: 'new-account', created_at: '2026-09-08 06:41:02' }],
      ['профилът от snapshot-а на намерението', { ...completed, profileCreatedAtSnapshot: '2026-09-08 06:41:02' }, { account_id: 'new-account', created_at: '2026-09-08 06:41:02' }],
    ]
    for (const [label, operation, profile] of cases) {
      assert(!isAdminDeletedProfileProvenRecreated(operation, profile), label)
    }
  })

  const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-recreated-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
      await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const ledgerPath = join(root, 'ledger', 'profile-deletions.jsonl')
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const progressStore = await createPlayerProgressStore(databaseFilePath)
  const authStore = await createAuthStore(databaseFilePath, progressStore, {
    registrationVerificationCodeSecret: SECRET,
    getRegistrationVerificationMode: () => 'direct',
    getActiveBanForProfile: () => null,
  })

  type User = { profileId: string; accountId: string; createdAt: string }
  let counter = 0
  const registerUser = (label: string): User => {
    counter += 1
    const result = authStore.register({ email: `recreated-${label.toLowerCase()}-${counter}@example.test`, password: 'secret123', displayName: `Rc${label}${counter}`, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
    const profileId = result.session.profile.profileId as string
    const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(profileId) as { created_at: string }).created_at
    return { profileId, accountId: result.session.account.accountId, createdAt }
  }
  /** SQLite дата, изместена с минути спрямо датата на създаване на профила. */
  const shifted = (createdAt: string, minutes: number) =>
    new Date(Date.parse(`${createdAt.slice(0, 19).replace(' ', 'T')}Z`) + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ')
  const insertAudit = (profileId: string, deletedAccountId: string | null, deletedAt: string): string => {
    const logId = randomUUID()
    db.prepare(`INSERT INTO admin_profile_deletions (log_id, deleted_profile_id, deleted_account_id, username_snapshot, deleted_by_profile_id, reason, deleted_at) VALUES (?, ?, ?, 'Стар', NULL, 'х', ?);`)
      .run(logId, profileId, deletedAccountId, deletedAt)
    return logId
  }
  const profileCount = (profileId: string) => Number((db.prepare('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;').get(profileId) as { c: number }).c)
  const backfill = async (apply: boolean) => {
    const lines: string[] = []
    const argv = [`--db=${databaseFilePath}`, `--ledger=${ledgerPath}`]
    if (apply) argv.push('--apply', `--confirm=${ADMIN_BACKFILL_CONFIRMATION_PHRASE}`)
    const code = await runProfileDeletionAdminBackfill(argv, { log: (line) => lines.push(line), error: (line) => lines.push(line) })
    return { code, out: lines.join('\n'), summary: lines.find((line) => line.includes('summary')) ?? '' }
  }
  const assess = async () => {
    const guard = await createProfileDeletionHistoryGuard({ databaseFilePath, ledgerPath, offsiteRequired: true })
    try {
      const initialized = guard.initialize()
      return { initialized, assessment: guard.assess() }
    } finally {
      guard.close()
    }
  }
  let copyCounter = 0
  const reconcile = async (mode: 'verify' | 'apply') => {
    copyCounter += 1
    const dbCopy = join(root, `restore-${copyCounter}.sqlite`)
    db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}';`)
    const uploads = join(root, `restore-${copyCounter}-uploads`)
    for (const dir of ['avatars', 'profile-gallery', 'chat-attachments', 'topic-attachments', 'topic-mute-evidence-attachments', 'support-attachments']) {
      await mkdir(join(uploads, dir), { recursive: true })
    }
    const lines: string[] = []
    const argv = [`--db=${dbCopy}`, `--ledger=${ledgerPath}`, `--state-dir=${dbCopy}.state`]
    if (mode === 'verify') argv.push('--verify-only')
    else argv.push('--apply', `--confirm=${REAPPLY_CONFIRMATION_PHRASE}`, `--uploads-root=${uploads}`)
    const code = await runProfileDeletionLedgerReconcile(argv, { log: (line) => lines.push(line), error: (line) => lines.push(line) })
    const restored = new sqliteModule.DatabaseSync(dbCopy, { readOnly: true })
    const countInCopy = (profileId: string) => Number((restored.prepare('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;').get(profileId) as { c: number }).c)
    return { code, out: lines.join('\n'), countInCopy, close: () => restored.close() }
  }

  // Официалният профил: изтрит (стар акаунт), после създаден наново със същия ID.
  const official = registerUser('Official')
  const oldOfficialAccountId = randomUUID()
  const recreatedLogId = insertAudit(official.profileId, oldOfficialAccountId, shifted(official.createdAt, -40))

  console.log('\n[B] Backfill')
  await check('[B1] Създаден наново профил -> recreated + eligible; dry-run не пише; --apply добавя admin_delete_historical със СТАРИЯ акаунт; exit 0', async () => {
    const dry = await backfill(false)
    assertEqual(dry.code, 0, `dry-run (${dry.out})`)
    assert(dry.out.includes(`recreated operationId=${recreatedLogId}`) && dry.summary.includes('"recreated":1') && dry.summary.includes('"profilePresent":0'), dry.out)
    assertEqual(readProfileDeletionLedger(ledgerPath).exists, false, 'dry-run не създава регистър')
    const applied = await backfill(true)
    assertEqual(applied.code, 0, `apply (${applied.out})`)
    assert(applied.summary.includes('"appended":1'), applied.summary)
    const operation = summarizeAdminLedgerOperations(readProfileDeletionLedger(ledgerPath).records).get(recreatedLogId)
    assert(operation !== undefined && operation.state === 'completed', 'исторически запис')
    assertEqual(operation!.accountIdSnapshot, oldOfficialAccountId, 'старият акаунт')
    assertEqual(profileCount(official.profileId), 1, 'новият профил е непокътнат')
  })

  console.log('\n[G] Шлюз на историята')
  await check('[G1] След backfill: обвързване created, verified=true, без блокирани профили', async () => {
    const { initialized, assessment } = await assess()
    assertEqual(initialized.binding, 'created', 'binding')
    assertEqual(initialized.restoreDetected, false, 'restoreDetected')
    assert(assessment.verified && !assessment.restoreHold && assessment.reasons.length === 0, JSON.stringify(assessment))
    assertEqual(assessment.blockedProfileIds.length, 0, 'блокирани')
  })

  console.log('\n[R] Reconcile (restore)')
  await check('[R1] verify-only: admin_recreated -> verify OK; --apply не трие новия профил', async () => {
    const verify = await reconcile('verify')
    try {
      assertEqual(verify.code, 0, `verify (${verify.out.slice(-600)})`)
      assert(verify.out.includes(`admin_recreated operationId=${recreatedLogId}`) && verify.out.includes('verify OK'), verify.out.slice(-600))
    } finally {
      verify.close()
    }
    const applied = await reconcile('apply')
    try {
      assertEqual(applied.code, 0, `apply (${applied.out.slice(-600)})`)
      assertEqual(applied.countInCopy(official.profileId), 1, 'новият профил остава')
    } finally {
      applied.close()
    }
  })

  // Други несъответствия: същият акаунт (възкресен стар профил), друг акаунт,
  // но профилът е създаден ПРЕДИ изтриването, неизвестен акаунт.
  const restoredSame = registerUser('Same')
  const earlier = registerUser('Earlier')
  const unknown = registerUser('Unknown')
  const sameLogId = insertAudit(restoredSame.profileId, restoredSame.accountId, shifted(restoredSame.createdAt, 30))
  const earlierLogId = insertAudit(earlier.profileId, randomUUID(), shifted(earlier.createdAt, 30))
  insertAudit(unknown.profileId, null, shifted(unknown.createdAt, -30))

  await check('[B2] Другите несъответствия НЕ се добавят: profile_present, exit 1, регистърът е непроменен', async () => {
    const before = readFileSync(ledgerPath)
    const applied = await backfill(true)
    assertEqual(applied.code, 1, `apply (${applied.out})`)
    assert(applied.summary.includes('"profilePresent":3') && applied.summary.includes('"appended":0') && applied.summary.includes('"alreadyInLedger":1'), applied.summary)
    assert(readFileSync(ledgerPath).equals(before), 'регистърът е непроменен')
  })

  await check('[G2] Липсващите в регистъра остават ledger_behind_db (verified=false)', async () => {
    const { assessment } = await assess()
    assert(!assessment.verified, 'verified=false')
    for (const logId of [sameLogId, earlierLogId]) {
      assert(assessment.reasons.includes(`ledger_behind_db:admin:${logId}`), JSON.stringify(assessment.reasons))
    }
    assert(!assessment.reasons.some((reason) => reason.includes(recreatedLogId)), 'създаденият наново не е причина')
  })

  // Запис в регистъра за профил, който НЕ е доказано създаден наново
  // (напр. възстановен стар профил) -> блокиран, както досега.
  for (const user of [{ logId: sameLogId, user: restoredSame }, { logId: earlierLogId, user: earlier }]) {
    const audit = db.prepare('SELECT deleted_account_id, deleted_at FROM admin_profile_deletions WHERE log_id = ?;').get(user.logId) as { deleted_account_id: string | null; deleted_at: string }
    ensureProfileDeletionLedgerRecord(ledgerPath, {
      v: 1,
      kind: 'admin_delete_historical',
      operationId: user.logId,
      profileId: user.user.profileId,
      accountIdSnapshot: audit.deleted_account_id,
      actorProfileId: null,
      deletedAt: `${audit.deleted_at.replace(' ', 'T')}.000Z`,
      recordedAt: new Date().toISOString(),
    })
  }

  await check('[G3] Доказано изтриване + профил, който НЕ е създаден наново -> unreconciled_admin_deletion и блокиран; създаденият наново не е блокиран', async () => {
    const { assessment } = await assess()
    assert(!assessment.verified, 'verified=false')
    for (const logId of [sameLogId, earlierLogId]) {
      assert(assessment.reasons.includes(`unreconciled_admin_deletion:${logId}`), JSON.stringify(assessment.reasons))
    }
    assert(assessment.blockedProfileIds.includes(restoredSame.profileId) && assessment.blockedProfileIds.includes(earlier.profileId), JSON.stringify(assessment.blockedProfileIds))
    assert(!assessment.blockedProfileIds.includes(official.profileId), 'официалният профил не е блокиран')
  })

  await check('[R2] verify-only: admin_missing (същият акаунт) и admin_identity_mismatch (създаден преди изтриването) -> verify FAILED', async () => {
    const verify = await reconcile('verify')
    try {
      assertEqual(verify.code, 1, `verify (${verify.out.slice(-600)})`)
      assert(verify.out.includes(`admin_missing operationId=${sameLogId}`), verify.out.slice(-800))
      assert(verify.out.includes(`admin_identity_mismatch operationId=${earlierLogId}`), verify.out.slice(-800))
      assert(verify.out.includes(`admin_recreated operationId=${recreatedLogId}`) && verify.out.includes('verify FAILED'), verify.out.slice(-800))
    } finally {
      verify.close()
    }
  })

  db.close()
} finally {
  for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
