/**
 * backupHelpers.ts — споделени функции за backup и restore verification.
 *
 * Всяка публична функция оттук може да се изполва от production скриптове
 * и от тестове без дублиране на логика.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// ── Константи ─────────────────────────────────────────────────────────────────

export const BACKUP_DAILY_NAME_RE = /^belot-v2-(\d{4}-\d{2}-\d{2})\.sqlite$/
export const RETENTION_COUNT = 14
export const REQUIRED_TABLES = [
  'server_migrations',
  'accounts',
  'profiles',
  'profile_wallets',
] as const

export type RequiredTable = (typeof REQUIRED_TABLES)[number]

// ── verifyBackupFile ──────────────────────────────────────────────────────────

/**
 * Отваря SQLite файл, изпълнява PRAGMA integrity_check и проверява
 * присъствието на задължителните таблици. Хвърля при всяко отклонение.
 * Затваря базата преди да хвърли или да върне.
 */
export function verifyBackupFile(filePath: string): void {
  const db = new DatabaseSync(filePath, { open: true })
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check: string }
      | undefined
    if (!integrityRow || integrityRow.integrity_check !== 'ok') {
      throw new Error(
        `integrity_check върна: ${integrityRow?.integrity_check ?? '(празен резултат)'}`,
      )
    }
    const existingTables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map(r => r.name),
    )
    for (const table of REQUIRED_TABLES) {
      if (!existingTables.has(table)) {
        throw new Error(`Липсваща таблица: ${table}`)
      }
    }
  } finally {
    db.close()
  }
}

// ── verifyIsolatedDb ──────────────────────────────────────────────────────────

export type VerifyIsolatedResult = {
  integrityOk: boolean
  tables: string[]
  migrationCount: number
  accountCount: number
  profileCount: number
  walletCount: number
}

/**
 * Отваря SQLite файл (трябва да е изолирано копие, не production) и
 * събира данни за верификация. Не хвърля при невалидна база — връща
 * `integrityOk: false` и `tables: []` вместо това.
 */
export function verifyIsolatedDb(dbPath: string): VerifyIsolatedResult {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check: string }
      | undefined
    const integrityOk = integrityRow?.integrity_check === 'ok'

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map(r => r.name)

    // Безопасни COUNT заявки — само статистики, без лични данни
    const migrationCount = (db.prepare('SELECT COUNT(*) AS n FROM server_migrations').get() as { n: number }).n
    const accountCount   = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
    const profileCount   = (db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n
    const walletCount    = (db.prepare('SELECT COUNT(*) AS n FROM profile_wallets').get() as { n: number }).n

    return { integrityOk, tables, migrationCount, accountCount, profileCount, walletCount }
  } finally {
    db.close()
  }
}

// ── applyRetention ────────────────────────────────────────────────────────────

/**
 * Изтрива най-старите дневни backup файлове, като пази само последните
 * RETENTION_COUNT. Докосва единствено файлове с имена по BACKUP_DAILY_NAME_RE —
 * подпапки и непознати файлове остават непокътнати.
 * Връща списък с изтритите имена.
 */
export async function applyRetention(backupDir: string): Promise<string[]> {
  const entries = await readdir(backupDir)
  const dailyFiles = entries
    .filter(f => BACKUP_DAILY_NAME_RE.test(f))
    .sort() // ISO имена → правилен хронологичен ред без dateparse

  const toDelete = dailyFiles.slice(0, Math.max(0, dailyFiles.length - RETENTION_COUNT))
  for (const f of toDelete) {
    await unlink(join(backupDir, f))
  }
  return toDelete
}

// ── formatBytes ───────────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} МБ`
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} КБ`
  return `${n} Б`
}

// ── runDatabaseBackup ─────────────────────────────────────────────────────────

/** Тип на `backup()` функцията от `node:sqlite`. */
export type BackupFn = (source: InstanceType<typeof DatabaseSync>, destPath: string) => Promise<unknown>

export type RunDatabaseBackupOptions = {
  /** Пълен път до source SQLite файл. */
  sourceFile: string
  /** Директория, в която се записват дневните backup файлове. */
  backupDir: string
  /** ISO дата за днешния ден (YYYY-MM-DD). */
  dateStr: string
  /**
   * Функция за копиране на базата. По подразбиране `backup` от `node:sqlite`.
   * Позволява DI само в тестове.
   */
  backupFn?: BackupFn
}

export type RunDatabaseBackupResult = {
  /** Пълен път до финалния backup файл. */
  finalPath: string
  /**
   * Кратък лог за случилото се. Всяко събитие е ред от вида:
   * `OK: …`, `SKIP: …`, `REPLACE: …`, `STALE_TMP_REMOVED`, `DELETED: …`
   */
  log: string[]
}

/**
 * Изпълнява пълния backup flow:
 *   1. Изтрива stale `.tmp` от прекъснато предишно изпълнение.
 *   2. Ако финалният файл за деня вече съществува и е валиден → SKIP + retention.
 *   3. Ако финалният файл е невалиден → изтрива го и продължава.
 *   4. Прави online backup в `.tmp` чрез `backupFn`.
 *   5. Верифицира `.tmp`; при грешка изтрива `.tmp` и хвърля.
 *   6. Атомарно преименуване `.tmp` → финален файл.
 *   7. Прилага retention.
 *
 * Хвърля при всяка невъзстановима грешка. `.tmp` е гарантирано изтрит
 * при хвърляне. Не вика `process.exit()`.
 */
export async function runDatabaseBackup(
  options: RunDatabaseBackupOptions,
): Promise<RunDatabaseBackupResult> {
  const { sourceFile, backupDir, dateStr } = options

  // Production default: import-ваме `backup` от node:sqlite мързеливо,
  // за да не се зарежда модулът при тестове с fake backupFn.
  const backupFn: BackupFn = options.backupFn ?? (await import('node:sqlite')).backup

  await mkdir(backupDir, { recursive: true })

  const finalName = `belot-v2-${dateStr}.sqlite`
  const finalPath = join(backupDir, finalName)
  const tmpPath   = join(backupDir, `belot-v2-${dateStr}.sqlite.tmp`)
  const log: string[] = []

  // 1. Stale .tmp
  try {
    await stat(tmpPath)
    log.push('STALE_TMP_REMOVED')
    await unlink(tmpPath)
  } catch { /* не съществува — нормално */ }

  // 2-3. Проверка на съществуващ финален файл
  let finalExists = false
  try { await stat(finalPath); finalExists = true } catch { /* не съществува */ }

  if (finalExists) {
    try {
      verifyBackupFile(finalPath)
      log.push(`SKIP: ${finalName} вече съществува и е валиден`)
      // Retention се изпълнява и при SKIP — предишно изпълнение може да не е стигнало до него.
      const deleted = await applyRetention(backupDir)
      if (deleted.length > 0) log.push(`DELETED: ${deleted.join(', ')}`)
      return { finalPath, log }
    } catch (verifyErr) {
      log.push(`REPLACE: ${finalName} е невалиден — ${(verifyErr as Error).message}`)
      await unlink(finalPath).catch(() => { /* игнорирай */ })
    }
  }

  // 4. Online backup
  const sourceDb = new DatabaseSync(sourceFile, { open: true })
  try {
    await backupFn(sourceDb, tmpPath)
  } catch (backupErr) {
    await unlink(tmpPath).catch(() => { /* игнорирай */ })
    throw new Error(`backup() провали: ${(backupErr as Error).message}`)
  } finally {
    sourceDb.close()
  }

  // 5-6. Verify + атомарно rename
  try {
    verifyBackupFile(tmpPath)
    await rename(tmpPath, finalPath)
  } catch (err) {
    await unlink(tmpPath).catch(() => { /* игнорирай */ })
    throw new Error(`Verification/rename провали: ${(err as Error).message}`)
  }

  log.push(`OK: ${finalName}`)

  // 7. Retention
  const deleted = await applyRetention(backupDir)
  if (deleted.length > 0) log.push(`DELETED: ${deleted.join(', ')}`)

  return { finalPath, log }
}
