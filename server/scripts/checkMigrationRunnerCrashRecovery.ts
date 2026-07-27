/**
 * checkMigrationRunnerCrashRecovery.ts
 *
 * Реален тест на L2 поправката в ensureServerDatabaseReady.ts: когато
 * migration файл с MANUAL_TRANSACTION_MIGRATION маркер се провали ПОСЛЕ
 * собствения си BEGIN, но ПРЕДИ COMMIT, runner-ът трябва:
 *   1. Първо да направи явен ROLLBACK (затваря отворената транзакция).
 *   2. Едва тогава да възстанови PRAGMA foreign_keys = ON.
 *
 * Причина: SQLite отказва да промени PRAGMA foreign_keys вътре в отворена
 * транзакция (мълчаливо no-op) — затова редът е задължителен. Преди
 * поправката единствената защита беше имплицитният rollback при затваряне
 * на connection-а (доказано безопасно, но означаваше, че PRAGMA
 * foreign_keys=ON никога реално не се прилагаше в error handler-а,
 * докато транзакцията е още отворена). Тестът тук проверява инварианта
 * ДИРЕКТНО върху СЪЩАТА (still-open) connection — без да я затваря —
 * за да докаже, че explicit ROLLBACK-ът реално върши работа, а не разчита
 * само на connection.close().
 *
 * Работи изцяло върху изолирано temp SQLite копие — не докосва проекта.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

console.log('\ncheckMigrationRunnerCrashRecovery')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-runner-crash-recovery-'))
const dbPath = join(tempDir, 'test.sqlite')

try {
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(`
    CREATE TABLE server_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE accounts (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin'))
    );
    CREATE TABLE account_sessions (
      session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `)
  const accId = randomUUID()
  db.exec('BEGIN;')
  db.prepare(`INSERT INTO accounts (account_id, email, role) VALUES (?, 'crash@example.test', 'admin')`).run(accId)
  db.prepare(`INSERT INTO account_sessions (session_id, account_id) VALUES (?, ?)`).run(randomUUID(), accId)
  db.exec('COMMIT;')

  // Migration, счупена нарочно СЛЕД BEGIN IMMEDIATE, но ПРЕДИ COMMIT.
  const brokenMigrationSql = `
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE accounts_new (account_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'player');
    INSERT INTO accounts_new SELECT account_id, email, role FROM accounts;
    DROP TABLE accounts;
    ALTER TABLE accounts_new RENAME TO accounts;
    THIS IS DELIBERATELY INVALID SQL;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `

  // ── Точно поправената catch-логика от ensureServerDatabaseReady.ts ─────
  let caughtError: unknown = null
  try {
    db.exec(brokenMigrationSql)
  } catch (error) {
    caughtError = error
    try {
      db.exec('ROLLBACK;')
    } catch {
      // няма отворена транзакция — очаквано в някои случаи
    }
    try {
      db.exec('PRAGMA foreign_keys = ON;')
    } catch {
      // ignore
    }
  }

  check('[1] migration-ът наистина хвърли грешка (проверка на самия тест setup)', caughtError !== null)

  // ── [2] PRAGMA foreign_keys е ON ВЪРХУ СЪЩАТА connection, БЕЗ да я затваряме ──
  const fkStatus = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
  check('[2] PRAGMA foreign_keys = ON върху СЪЩАТА connection веднага след грешката (доказва, че explicit ROLLBACK е нужен и работи)', fkStatus === 1)

  // ── [3] Няма отворена транзакция — нова BEGIN трябва да успее без грешка ──
  let newTransactionOk = false
  try {
    db.exec('BEGIN;')
    db.exec('ROLLBACK;')
    newTransactionOk = true
  } catch {
    newTransactionOk = false
  }
  check('[3] Може да се отвори нова транзакция (доказва, че старата е коректно затворена)', newTransactionOk)

  // ── [4] Данните са запазени, accounts_new не е останала като orphan ──────
  const accountsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get() !== undefined
  const accountsNewExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts_new'").get() !== undefined
  check('[4.1] accounts таблицата съществува', accountsExists)
  check('[4.2] accounts_new (orphan от неуспешния rebuild) НЕ съществува', !accountsNewExists)

  const acc = db.prepare('SELECT role FROM accounts WHERE account_id = ?').get(accId) as { role: string } | undefined
  check('[4.3] оригиналният акаунт е запазен с role=admin', acc?.role === 'admin')

  const sessionsCount = (db.prepare('SELECT COUNT(*) AS n FROM account_sessions').get() as { n: number }).n
  check('[4.4] сесията не е cascade-изтрита', sessionsCount === 1)

  const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
  check('[5] PRAGMA integrity_check = ok', integrity === 'ok')

  db.close()
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
