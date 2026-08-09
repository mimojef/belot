import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getLocalTournamentTestDatabaseFilePath,
  isLocalTournamentTestModeEnabled,
} from '../localTournamentTest/localTournamentTestModeGuard.js'

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

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

// "Smart" миграции — registry по filename за migration файлове, които се
// нуждаят от реална процедурна проверка на текущото schema състояние преди
// DDL (напр. ALTER TABLE ADD COLUMN, за което SQLite няма "IF NOT EXISTS"),
// затова НЕ могат да бъдат безопасно self-managed чрез статичен .sql текст
// сам по себе си. Handler-ът получава само DDL responsibility — не отваря/
// затваря транзакция и не пипа server_migrations; runner-ът (по-долу)
// увива извикването му в собствен BEGIN/COMMIT + insertAppliedMigrationStatement,
// точно както за нормалните миграции. Handler-ът трябва да хвърли грешка,
// ако крайните postcondition-и (колони + типове) не са изпълнени — виж
// §4/§5 в task spec-а: "не приемай автоматично произволна schema за валидна".
const SMART_MIGRATION_HANDLERS: Record<string, (database: SqliteDatabase) => void> = {
  '20260801_002_add_tournament_match_deadline_kind_and_score.sql':
    applyTournamentMatchDeadlineKindAndScoreMigration,
  '20260801_003_add_tournament_inter_round_waiting.sql':
    applyTournamentInterRoundWaitingMigration,
}

function getTableColumnTypes(
  database: SqliteDatabase,
  tableName: string,
): Map<string, string> {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName});`)
    .all() as Array<{ name: string; type: string }>
  return new Map(rows.map((row) => [row.name, row.type]))
}

// 20260801_002_add_tournament_match_deadline_kind_and_score.sql — добавя
// deadline_kind/final_score_team_a/final_score_team_b към tournament_matches.
// Всяка ALTER TABLE ADD COLUMN се изпълнява само ако колоната реално
// липсва (safe restart recovery за частично приложена миграция), после се
// потвърждават и трите postcondition-и (колона присъства + очакван тип)
// преди runner-ът да запише ledger реда. Ако вече всички колони
// съществуват с правилния тип (schema приложена, ledger липсва), функцията
// не изпълнява никакъв DDL — само валидира и връща успешно.
function applyTournamentMatchDeadlineKindAndScoreMigration(database: SqliteDatabase): void {
  const tableName = 'tournament_matches'
  const columnsBefore = getTableColumnTypes(database, tableName)

  if (!columnsBefore.has('deadline_kind')) {
    database.exec(`
      ALTER TABLE ${tableName} ADD COLUMN deadline_kind TEXT NULL CHECK (
        deadline_kind IS NULL OR deadline_kind IN ('first_match', 'round_transition')
      );
    `)
  }
  if (!columnsBefore.has('final_score_team_a')) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN final_score_team_a INTEGER NULL;`)
  }
  if (!columnsBefore.has('final_score_team_b')) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN final_score_team_b INTEGER NULL;`)
  }

  const columnsAfter = getTableColumnTypes(database, tableName)
  const expectedColumnTypes: Record<string, string> = {
    deadline_kind: 'TEXT',
    final_score_team_a: 'INTEGER',
    final_score_team_b: 'INTEGER',
  }

  for (const [columnName, expectedType] of Object.entries(expectedColumnTypes)) {
    const actualType = columnsAfter.get(columnName)
    if (actualType === undefined || actualType.toUpperCase() !== expectedType) {
      throw new Error(
        `Postcondition failed for ${tableName}.${columnName}: expected type ${expectedType}, got ${
          actualType ?? 'MISSING COLUMN'
        }.`,
      )
    }
  }
}

function applyTournamentInterRoundWaitingMigration(database: SqliteDatabase): void {
  const tableName = 'tournament_matches'
  const columnsBefore = getTableColumnTypes(database, tableName)

  if (!columnsBefore.has('final_start_at')) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN final_start_at TEXT NULL;`)
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS tournament_semifinal_result_acknowledgements (
      acknowledgement_id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL,
      semifinal_match_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (tournament_id) REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
      FOREIGN KEY (semifinal_match_id) REFERENCES tournament_matches(match_id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
      UNIQUE (tournament_id, semifinal_match_id, profile_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tournament_semifinal_ack_match
      ON tournament_semifinal_result_acknowledgements(tournament_id, semifinal_match_id);

    CREATE INDEX IF NOT EXISTS idx_tournament_semifinal_ack_profile
      ON tournament_semifinal_result_acknowledgements(profile_id);
  `)

  const columnsAfter = getTableColumnTypes(database, tableName)
  const finalStartAtType = columnsAfter.get('final_start_at')
  if (finalStartAtType === undefined || finalStartAtType.toUpperCase() !== 'TEXT') {
    throw new Error(
      `Postcondition failed for ${tableName}.final_start_at: expected type TEXT, got ${
        finalStartAtType ?? 'MISSING COLUMN'
      }.`,
    )
  }
}

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

// Само когато serverRootOverride НЕ е подаден изрично (т.е. истинският
// production/dev call site, вкл. независими call sites като
// pickEligibleBotProfileFromDb.ts) — ако local tournament test mode е
// активен, пренасочва към отделната тестова база (виж
// localTournamentTestModeGuard.ts). Explicit serverRootOverride (ползван от
// restart-safety/isolated check скриптове) винаги печели и НЕ се пренасочва —
// тези извиквания вече сочат към собствено изолирано дърво.
export function getServerDatabaseFilePath(serverRootOverride?: string): string {
  const serverRootPath = serverRootOverride ?? getServerRootPath()
  const databaseDirectoryPath = getDatabaseDirectoryPath(serverRootPath)
  const databaseStorageDirectoryPath =
    getDatabaseStorageDirectoryPath(databaseDirectoryPath)

  if (serverRootOverride === undefined && isLocalTournamentTestModeEnabled()) {
    return getLocalTournamentTestDatabaseFilePath()
  }

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

export type EnsureServerDatabaseReadyOptions = {
  /** Same override mechanism as getServerDatabaseFilePath — за restart-safety
   * тестове с изолиран temp server root (собствена database/migrations +
   * database/data), без да пипа реалната постоянна база. Production
   * call site-ът (index.ts) не подава нищо и запазва точно текущото
   * поведение. */
  serverRootOverride?: string
  /** Точен override за самия .sqlite файл (различен от миграциите, които
   * винаги идват от database/migrations под serverRootOverride/production
   * root-а) — ползва се единствено от local-tournament-test режима (виж
   * server/src/localTournamentTest/localTournamentTestModeGuard.ts), за да
   * пише в отделен database/data/belot-v2-tournament-test.sqlite вместо
   * споделената belot-v2.sqlite. Production call site-ът (index.ts) не
   * подава нищо и запазва точно текущото поведение. */
  databaseFilePathOverride?: string
}

export async function ensureServerDatabaseReady(
  options: EnsureServerDatabaseReadyOptions = {},
): Promise<EnsureServerDatabaseReadyResult> {
  const serverRootPath = options.serverRootOverride ?? getServerRootPath()
  const databaseDirectoryPath = getDatabaseDirectoryPath(serverRootPath)
  const migrationsDirectoryPath = getMigrationsDirectoryPath(databaseDirectoryPath)
  const databaseStorageDirectoryPath =
    getDatabaseStorageDirectoryPath(databaseDirectoryPath)
  const databaseFilePath =
    options.databaseFilePathOverride ??
    (options.serverRootOverride === undefined && isLocalTournamentTestModeEnabled()
      ? getLocalTournamentTestDatabaseFilePath()
      : getDatabaseFilePath(databaseStorageDirectoryPath))

  await mkdir(migrationsDirectoryPath, { recursive: true })
  await mkdir(dirname(databaseFilePath), { recursive: true })

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

      const smartMigrationHandler = SMART_MIGRATION_HANDLERS[migrationFileName]
      if (smartMigrationHandler !== undefined) {
        // Виж SMART_MIGRATION_HANDLERS по-горе — DDL-ът трябва да е
        // условен (напр. ADD COLUMN само ако липсва), затова живее като
        // TypeScript функция, не статичен .sql текст. Транзакцията и
        // ledger insert-ът тук са identично управлявани както за нормалните
        // миграции по-долу (BEGIN → handler → insertLedger → COMMIT,
        // ROLLBACK при грешка) — handler-ът само отговаря за DDL/postcondition.
        database.exec('BEGIN;')
        try {
          smartMigrationHandler(database)
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

        continue
      }

      if (migrationSql.startsWith(MANUAL_TRANSACTION_MARKER)) {
        // Файлът сам управлява BEGIN/COMMIT и сам вмъква реда си в
        // server_migrations (виж коментара до MANUAL_TRANSACTION_MARKER).
        try {
          database.exec(migrationSql)
          // Contract enforcement (виж §7 в task spec-а): manual-transaction
          // миграция ТРЯБВА сама да запише реда си в server_migrations като
          // част от собствената си успешна транзакция. Ако мълчаливо не го
          // е направила, schema промяната може вече да е приложена, но при
          // следващ restart файлът ще се изпълни отново и ще гръмне с
          // "table already exists"/"duplicate column" — точно бъгът, който
          // причини production incident-а. Хващаме го тук, веднага, вместо
          // да отложим счупването за следващия startup.
          const recordedRow = getAppliedMigrationStatement.get(
            migrationFileName,
          ) as { filename: string } | undefined
          if (recordedRow === undefined) {
            throw new Error(
              `Manual transaction migration "${migrationFileName}" completed without recording itself ` +
                `in ${MIGRATIONS_TABLE_NAME} (violates the MANUAL_TRANSACTION_MIGRATION contract — ` +
                `the file must INSERT its own ledger row inside its own successful transaction).`,
            )
          }
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
