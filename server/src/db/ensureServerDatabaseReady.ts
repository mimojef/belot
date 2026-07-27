import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type AppliedServerMigration = {
  filename: string
  appliedAt: string
}

export type EnsureServerDatabaseReadyResult = {
  databaseFilePath: string
  migrationsDirectoryPath: string
  appliedCount: number
  skippedCount: number
  appliedMigrations: AppliedServerMigration[]
}

const DATABASE_DIRECTORY_NAME = 'database'
const DATABASE_STORAGE_DIRECTORY_NAME = 'data'
const DATABASE_FILENAME = 'belot-v2.sqlite'
const MIGRATIONS_DIRECTORY_NAME = 'migrations'
const MIGRATIONS_TABLE_NAME = 'server_migrations'

// Маркер за миграции, които трябва да управляват собствената си транзакция
// (напр. защото toggle-ват `PRAGMA foreign_keys`, което SQLite отказва да
// промени вътре в отворена транзакция). Такъв файл съдържа собствени
// BEGIN/COMMIT + INSERT в server_migrations — runner-ът само го изпълнява
// с един exec() и НЕ добавя своя BEGIN/COMMIT/insertAppliedMigrationStatement.
const MANUAL_TRANSACTION_MARKER = '-- MANUAL_TRANSACTION_MIGRATION'

function getServerRootPath(): string {
  const currentFilePath = fileURLToPath(import.meta.url)
  return resolve(dirname(currentFilePath), '..', '..')
}

function getDatabaseDirectoryPath(serverRootPath: string): string {
  return join(serverRootPath, DATABASE_DIRECTORY_NAME)
}

function getMigrationsDirectoryPath(databaseDirectoryPath: string): string {
  return join(databaseDirectoryPath, MIGRATIONS_DIRECTORY_NAME)
}

function getDatabaseStorageDirectoryPath(databaseDirectoryPath: string): string {
  return join(databaseDirectoryPath, DATABASE_STORAGE_DIRECTORY_NAME)
}

function getDatabaseFilePath(databaseStorageDirectoryPath: string): string {
  return join(databaseStorageDirectoryPath, DATABASE_FILENAME)
}

export function getServerDatabaseFilePath(serverRootOverride?: string): string {
  const serverRootPath = serverRootOverride ?? getServerRootPath()
  const databaseDirectoryPath = getDatabaseDirectoryPath(serverRootPath)
  const databaseStorageDirectoryPath =
    getDatabaseStorageDirectoryPath(databaseDirectoryPath)

  return getDatabaseFilePath(databaseStorageDirectoryPath)
}

function compareMigrationFileNames(a: string, b: string): number {
  return a.localeCompare(b, 'en')
}

async function loadMigrationFileNames(
  migrationsDirectoryPath: string,
): Promise<string[]> {
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })

  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort(compareMigrationFileNames)
}

function normalizeSqlContent(sqlContent: string): string {
  return sqlContent.trim()
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function ensureServerDatabaseReady(): Promise<EnsureServerDatabaseReadyResult> {
  const serverRootPath = getServerRootPath()
  const databaseDirectoryPath = getDatabaseDirectoryPath(serverRootPath)
  const migrationsDirectoryPath = getMigrationsDirectoryPath(databaseDirectoryPath)
  const databaseStorageDirectoryPath =
    getDatabaseStorageDirectoryPath(databaseDirectoryPath)
  const databaseFilePath = getDatabaseFilePath(databaseStorageDirectoryPath)

  await mkdir(migrationsDirectoryPath, { recursive: true })
  await mkdir(databaseStorageDirectoryPath, { recursive: true })

  const migrationFileNames = await loadMigrationFileNames(migrationsDirectoryPath)

  let sqliteModule: typeof import('node:sqlite')

  try {
    sqliteModule = await import('node:sqlite')
  } catch (error) {
    throw new Error(
      `SQLite runtime is not available in this Node version. ` +
        `Belot V2 server DB bootstrap requires node:sqlite (Node 22.5+). ` +
        `Original error: ${toErrorMessage(error)}`,
    )
  }

  const database = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  try {
    database.exec('PRAGMA foreign_keys = ON;')
    database.exec('PRAGMA journal_mode = WAL;')

    database.exec(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE_NAME} (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)

    const getAppliedMigrationStatement = database.prepare(`
      SELECT filename
      FROM ${MIGRATIONS_TABLE_NAME}
      WHERE filename = ?
      LIMIT 1;
    `)

    const insertAppliedMigrationStatement = database.prepare(`
      INSERT INTO ${MIGRATIONS_TABLE_NAME} (
        filename
      ) VALUES (?);
    `)

    let appliedCount = 0
    let skippedCount = 0

    for (const migrationFileName of migrationFileNames) {
      const existingMigrationRow = getAppliedMigrationStatement.get(
        migrationFileName,
      ) as { filename: string } | undefined

      if (existingMigrationRow) {
        skippedCount += 1
        continue
      }

      const migrationFilePath = join(migrationsDirectoryPath, migrationFileName)
      const migrationSqlRaw = await readFile(migrationFilePath, 'utf8')
      const migrationSql = normalizeSqlContent(migrationSqlRaw)

      if (!migrationSql) {
        skippedCount += 1
        continue
      }

      if (migrationSql.startsWith(MANUAL_TRANSACTION_MARKER)) {
        // Файлът сам управлява BEGIN/COMMIT и сам вмъква реда си в
        // server_migrations (виж коментара до MANUAL_TRANSACTION_MARKER).
        try {
          database.exec(migrationSql)
          appliedCount += 1
        } catch (error) {
          // Възстановяване на инвариантите, ако файлът е паднал по средата.
          // Редът има значение: PRAGMA foreign_keys не може да се промени
          // вътре в отворена транзакция (SQLite го прави мълчаливо no-op) —
          // ако файлът е паднал СЛЕД своя BEGIN, но ПРЕДИ COMMIT,
          // транзакцията е още отворена и трябва първо изрично да се затвори
          // с ROLLBACK. (Empирично потвърдено: затваряне на connection-а
          // също би отменило отворената транзакция автоматично — този
          // explicit ROLLBACK прави възстановяването коректно дори ако
          // connection-ът не бъде затворен веднага след тази грешка.)
          try {
            database.exec('ROLLBACK;')
          } catch {
            // Няма отворена транзакция (файлът е паднал преди своя BEGIN,
            // напр. на самия `PRAGMA foreign_keys = OFF;` ред) — очаквано, игнорираме.
          }
          try {
            database.exec('PRAGMA foreign_keys = ON;')
          } catch {
            // ignore — оригиналната грешка е по-важна
          }

          throw new Error(
            `Failed to apply migration "${migrationFileName}": ${toErrorMessage(error)}`,
          )
        }

        continue
      }

      database.exec('BEGIN;')

      try {
        database.exec(migrationSql)
        insertAppliedMigrationStatement.run(migrationFileName)
        database.exec('COMMIT;')
        appliedCount += 1
      } catch (error) {
        try {
          database.exec('ROLLBACK;')
        } catch {
          // ignore rollback failure and surface the original migration error
        }

        throw new Error(
          `Failed to apply migration "${migrationFileName}": ${toErrorMessage(error)}`,
        )
      }
    }

    const appliedMigrations = database
      .prepare(`
        SELECT filename, applied_at
        FROM ${MIGRATIONS_TABLE_NAME}
        ORDER BY filename ASC;
      `)
      .all() as AppliedServerMigration[]

    return {
      databaseFilePath,
      migrationsDirectoryPath,
      appliedCount,
      skippedCount,
      appliedMigrations,
    }
  } finally {
    database.close()
  }
}
