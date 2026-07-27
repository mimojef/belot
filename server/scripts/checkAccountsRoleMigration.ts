/**
 * checkAccountsRoleMigration.ts
 *
 * Реален тест на 20260727_002_extend_accounts_role_subadmin.sql +
 * 20260727_003_create_admin_role_audit_log.sql — прилага ВСИЧКИ реални
 * migration файлове (server/database/migrations) върху прясна, изолирана
 * temp SQLite база, вкарва синтетични "съществуващи преди миграцията" данни
 * (admin акаунт, активна сесия, password reset token), после проверява:
 *
 * [1]  Всички редове в accounts/account_sessions/password_reset_tokens са
 *      запазени НЕПРОМЕНЕНИ (брой + admin роля) — доказва, че table rebuild-ът
 *      на accounts НЕ e cascade-изтрил decata (риск, описан в самата миграция).
 * [2]  CHECK constraint на accounts.role вече позволява 'subadmin'.
 * [3]  CHECK constraint отхвърля невалидна роля (напр. 'superadmin').
 * [4]  admin_role_audit_log таблицата съществува, приема валиден INSERT,
 *      и FK/CHECK constraint-ите ѝ работят коректно.
 * [5]  PRAGMA integrity_check = 'ok'.
 * [6]  PRAGMA foreign_key_check връща 0 нарушения.
 * [7]  Всички индекси/колони на accounts са възстановени след rebuild-а.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, extname } from 'node:path'
import { randomUUID } from 'node:crypto'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok ${label}`)
    passed++
  } else {
    console.error(`  FAIL ${label}`)
    failed++
  }
}

const MANUAL_TRANSACTION_MARKER = '-- MANUAL_TRANSACTION_MIGRATION'

/**
 * Прилага ЕДИН migration файл върху вече отворена connection — общата логика,
 * споделена и от "стъпка 1" (pre-existing миграции) и "стъпка 2" (новите два
 * файла) по-долу, за да няма дублиран inline BEGIN/exec/INSERT/COMMIT блок.
 * Не пипа server_migrations bootstrap-а (CREATE TABLE) — той се прави веднъж
 * от извикващия код, преди първия apply.
 */
async function applyOneMigrationFile(
  db: InstanceType<typeof DatabaseSync>,
  migrationsDir: string,
  fileName: string,
): Promise<void> {
  const raw = await readFile(join(migrationsDir, fileName), 'utf8')
  const sql = raw.trim()
  if (!sql) return

  if (sql.startsWith(MANUAL_TRANSACTION_MARKER)) {
    // Файлът сам управлява собствената си транзакция и сам се регистрира в server_migrations.
    db.exec(sql)
    return
  }

  db.exec('BEGIN;')
  try {
    db.exec(sql)
    db.prepare('INSERT INTO server_migrations (filename) VALUES (?);').run(fileName)
    db.exec('COMMIT;')
  } catch (err) {
    db.exec('ROLLBACK;')
    throw new Error(`Migration "${fileName}" провали: ${(err as Error).message}`)
  }
}

console.log('\ncheckAccountsRoleMigration')

const serverRoot = resolve(import.meta.dirname, '..')
const migrationsDir = join(serverRoot, 'database', 'migrations')

// За да тестваме "запазва съществуващите данни", прилагаме миграциите на ДВЕ
// стъпки: първо всичко ПРЕДИ моите нови файлове (за да вкараме синтетични
// "стари" данни в стар schema), после моите нови файлове (табличен rebuild).
const allMigrationFiles = (await readdir(migrationsDir))
  .filter((f) => extname(f).toLowerCase() === '.sql')
  .sort((a, b) => a.localeCompare(b, 'en'))

const NEW_MIGRATIONS = [
  '20260727_002_extend_accounts_role_subadmin.sql',
  '20260727_003_create_admin_role_audit_log.sql',
]

for (const f of NEW_MIGRATIONS) {
  if (!allMigrationFiles.includes(f)) {
    console.error(`FAIL: очакваният migration файл "${f}" липсва в ${migrationsDir}`)
    process.exit(1)
  }
}

const preExistingMigrationFiles = allMigrationFiles.filter((f) => !NEW_MIGRATIONS.includes(f))

const tempDir = await mkdtemp(join(tmpdir(), 'belot-role-migration-'))
const dbPath = join(tempDir, 'test.sqlite')

try {
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA journal_mode = WAL;')

  // ── Стъпка 1: приложи всички миграции ПРЕДИ моите нови ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  for (const fileName of preExistingMigrationFiles) {
    await applyOneMigrationFile(db, migrationsDir, fileName)
  }

  // ── Синтетични "съществуващи преди миграцията" данни ────────────────────
  const legacyAdminAccountId = randomUUID()
  const legacyProfileId = randomUUID()
  const legacySessionId = randomUUID()
  const legacyResetTokenId = randomUUID()

  db.exec('BEGIN;')
  db.prepare(`
    INSERT INTO accounts (account_id, email, password_hash, role, status)
    VALUES (?, 'legacy-admin@example.test', 'scrypt:salt:hash', 'admin', 'active')
  `).run(legacyAdminAccountId)
  db.prepare(`
    INSERT INTO profiles (profile_id, account_id, profile_kind, display_name, normalized_display_name)
    VALUES (?, ?, 'human', 'Legacy Admin', 'legacy admin')
  `).run(legacyProfileId, legacyAdminAccountId)
  db.prepare(`
    INSERT INTO account_sessions (session_id, account_id, profile_id, token_hash, expires_at)
    VALUES (?, ?, ?, 'fake-token-hash', datetime('now', '+30 days'))
  `).run(legacySessionId, legacyAdminAccountId, legacyProfileId)
  db.prepare(`
    INSERT INTO password_reset_tokens (token_id, account_id, token_hash, expires_at)
    VALUES (?, ?, 'fake-reset-hash', datetime('now', '+1 hour'))
  `).run(legacyResetTokenId, legacyAdminAccountId)
  db.exec('COMMIT;')

  const accountsBefore = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
  const sessionsBefore = (db.prepare('SELECT COUNT(*) AS n FROM account_sessions').get() as { n: number }).n
  const resetTokensBefore = (db.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get() as { n: number }).n
  const roleBefore = (db.prepare('SELECT role FROM accounts WHERE account_id = ?').get(legacyAdminAccountId) as { role: string }).role

  check('setup: legacy admin акаунт създаден с role=admin', roleBefore === 'admin')

  // ── Стъпка 2: приложи МОИТЕ нови миграции ────────────────────────────────
  for (const fileName of NEW_MIGRATIONS) {
    await applyOneMigrationFile(db, migrationsDir, fileName)
  }

  // ── [1] Данните са запазени ──────────────────────────────────────────────
  const accountsAfter = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
  const sessionsAfter = (db.prepare('SELECT COUNT(*) AS n FROM account_sessions').get() as { n: number }).n
  const resetTokensAfter = (db.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get() as { n: number }).n
  const roleAfter = (db.prepare('SELECT role FROM accounts WHERE account_id = ?').get(legacyAdminAccountId) as { role: string } | undefined)?.role

  check('[1.1] accounts count непроменен (без cascade delete)', accountsBefore === accountsAfter)
  check('[1.2] account_sessions count непроменен (НЯМА cascade delete на сесии)', sessionsBefore === sessionsAfter)
  check('[1.3] password_reset_tokens count непроменен (НЯМА cascade delete)', resetTokensBefore === resetTokensAfter)
  check('[1.4] legacy admin запазва role=admin след миграцията', roleAfter === 'admin')

  const sessionStillLinked = db.prepare('SELECT session_id FROM account_sessions WHERE session_id = ? AND account_id = ?')
    .get(legacySessionId, legacyAdminAccountId)
  check('[1.5] старата сесия все още сочи към същия account_id', sessionStillLinked !== undefined)

  // ── [2] CHECK позволява subadmin ─────────────────────────────────────────
  let subadminInsertOk = false
  try {
    db.exec('BEGIN;')
    db.prepare(`
      INSERT INTO accounts (account_id, email, password_hash, role, status)
      VALUES (?, 'new-subadmin@example.test', 'scrypt:salt:hash', 'subadmin', 'active')
    `).run(randomUUID())
    subadminInsertOk = true
    db.exec('COMMIT;')
  } catch {
    db.exec('ROLLBACK;')
  }
  check('[2] CHECK constraint позволява role=subadmin', subadminInsertOk)

  // ── [3] CHECK отхвърля невалидна роля ────────────────────────────────────
  let invalidRoleRejected = false
  try {
    db.exec('BEGIN;')
    db.prepare(`
      INSERT INTO accounts (account_id, email, password_hash, role, status)
      VALUES (?, 'bad-role@example.test', 'scrypt:salt:hash', 'superadmin', 'active')
    `).run(randomUUID())
    db.exec('COMMIT;')
  } catch {
    invalidRoleRejected = true
    db.exec('ROLLBACK;')
  }
  check('[3] CHECK constraint отхвърля невалидна роля (superadmin)', invalidRoleRejected)

  // ── [4] admin_role_audit_log ──────────────────────────────────────────────
  const auditTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_role_audit_log'").get() !== undefined
  check('[4.1] admin_role_audit_log таблица създадена', auditTableExists)

  let auditInsertOk = false
  try {
    db.exec('BEGIN;')
    db.prepare(`
      INSERT INTO admin_role_audit_log (log_id, actor_account_id, target_account_id, action, previous_role, new_role)
      VALUES (?, ?, ?, 'grant_subadmin', 'player', 'subadmin')
    `).run(randomUUID(), legacyAdminAccountId, legacyAdminAccountId)
    auditInsertOk = true
    db.exec('COMMIT;')
  } catch (err) {
    console.error('audit insert error:', err)
    db.exec('ROLLBACK;')
  }
  check('[4.2] admin_role_audit_log INSERT работи', auditInsertOk)

  let auditActionCheckRejects = false
  try {
    db.exec('BEGIN;')
    db.prepare(`
      INSERT INTO admin_role_audit_log (log_id, actor_account_id, target_account_id, action, previous_role, new_role)
      VALUES (?, ?, ?, 'delete_everything', 'player', 'subadmin')
    `).run(randomUUID(), legacyAdminAccountId, legacyAdminAccountId)
    db.exec('COMMIT;')
  } catch {
    auditActionCheckRejects = true
    db.exec('ROLLBACK;')
  }
  check('[4.3] admin_role_audit_log CHECK отхвърля невалиден action', auditActionCheckRejects)

  // ── [5]/[6] Интегритет ────────────────────────────────────────────────────
  const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
  check('[5] PRAGMA integrity_check = ok', integrity === 'ok')

  const fkViolations = db.prepare('PRAGMA foreign_key_check').all()
  check('[6] PRAGMA foreign_key_check = 0 нарушения', fkViolations.length === 0)

  // ── [7] Колони/индекси на accounts запазени ──────────────────────────────
  const columns = (db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map((r) => r.name)
  const expectedColumns = ['account_id', 'email', 'password_hash', 'role', 'status', 'created_at', 'updated_at', 'last_login_at']
  check('[7.1] всички колони на accounts запазени в оригиналния ред', JSON.stringify(columns) === JSON.stringify(expectedColumns))

  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='accounts'").all() as { name: string }[]).map((r) => r.name)
  check('[7.2] idx_accounts_role_status възстановен', indexes.includes('idx_accounts_role_status'))

  db.close()
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
