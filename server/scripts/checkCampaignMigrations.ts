/**
 * checkCampaignMigrations.ts
 *
 * Фаза 0 на системата "Кампании" — проверява, че
 * 20261010_001_create_campaign_system_tables.sql се прилага чисто чрез
 * РЕАЛНИЯ ensureServerDatabaseReady() runner (server/src/db/ensureServerDatabaseReady.ts),
 * върху:
 *   A) напълно празна база (само тази миграция и предпоставките й),
 *   B) изолирано копие на ЦЕЛИЯ реален migrations/ набор (доказва, че новата
 *      миграция сработва коректно след пълната съществуваща история, не
 *      само в изолация),
 * и че повторно изпълнение на runner-а (restart) е идемпотентно — без
 * повторно прилагане, без промяна на вече записани redове.
 *
 * Използва САМО изолирани temp-директории под OS temp — никога истинската
 * local/production база. Мирор на server/scripts/checkServerMigrationRestartSafety.ts.
 */

import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed += 1
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed += 1
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${message}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const NEW_MIGRATION_FILENAME = '20261010_001_create_campaign_system_tables.sql'

const EXPECTED_TABLES = [
  'campaigns',
  'campaign_earn_rules',
  'campaign_package_earn_rules',
  'campaign_reward_tiers',
  'campaign_tier_rewards',
  'campaign_unit_ledger',
  'campaign_profile_totals',
  'campaign_reward_claims',
  'campaign_reward_notifications',
  'campaign_manual_adjustments',
  'campaign_events',
  'campaign_archive_summary',
  'campaign_archive_top10',
]

const EXPECTED_INDEXES = [
  'idx_campaigns_single_active',
  'idx_campaigns_window',
  'idx_campaigns_status_archived',
  'idx_campaigns_active_list',
  'idx_campaign_reward_tiers_campaign_threshold',
  'idx_campaign_tier_rewards_tier',
  'idx_campaign_unit_ledger_profile',
  'idx_campaign_unit_ledger_event_at',
  'idx_campaign_profile_totals_campaign_units',
  'idx_campaign_reward_claims_profile',
  'idx_campaign_reward_notifications_profile_status',
  'idx_campaign_manual_adjustments_profile',
  'idx_campaign_events_campaign',
  'idx_campaign_archive_top10_profile',
]

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckCampaignMigrations')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

type TempServerRoot = {
  root: string
  migrationsDirectoryPath: string
  databaseFilePath: string
  cleanup: () => Promise<void>
}

async function createTempServerRoot(migrationFileNames: string[]): Promise<TempServerRoot> {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-migrations-'))
  const migrationsDirectoryPath = join(root, 'database', 'migrations')
  const dataDirectoryPath = join(root, 'database', 'data')
  await mkdir(migrationsDirectoryPath, { recursive: true })
  await mkdir(dataDirectoryPath, { recursive: true })
  for (const filename of migrationFileNames) {
    await cp(join(sourceMigrationsDirectoryPath, filename), join(migrationsDirectoryPath, filename))
  }
  return {
    root,
    migrationsDirectoryPath,
    databaseFilePath: join(dataDirectoryPath, 'belot-v2.sqlite'),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function openDatabase(databaseFilePath: string) {
  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  return database
}

function tableExists(database: Awaited<ReturnType<typeof openDatabase>>, tableName: string): boolean {
  return database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;`)
    .get(tableName) !== undefined
}

function indexExists(database: Awaited<ReturnType<typeof openDatabase>>, indexName: string): boolean {
  return database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?;`)
    .get(indexName) !== undefined
}

function ledgerHas(database: Awaited<ReturnType<typeof openDatabase>>, filename: string): boolean {
  return database
    .prepare(`SELECT filename FROM server_migrations WHERE filename = ?;`)
    .get(filename) !== undefined
}

function assertHealthyInvariants(database: Awaited<ReturnType<typeof openDatabase>>, label: string): void {
  const fk = (database.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number }).foreign_keys
  assert(fk === 1, `${label}: PRAGMA foreign_keys = ${fk}, expected 1`)

  const integrity = (database.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
  assert(integrity === 'ok', `${label}: integrity_check = ${integrity}`)

  const fkCheck = database.prepare('PRAGMA foreign_key_check;').all()
  assert(fkCheck.length === 0, `${label}: foreign_key_check has ${fkCheck.length} violations`)
}

const realMigrationFileNames = await loadRealMigrationFileNames()
assert(
  realMigrationFileNames.includes(NEW_MIGRATION_FILENAME),
  `${NEW_MIGRATION_FILENAME} not found under ${sourceMigrationsDirectoryPath}`,
)

// ═══ A. Пълният реален набор миграции (вкл. цялата история) → fresh DB ═══
{
  const temp = await createTempServerRoot(realMigrationFileNames)
  try {
    let firstRunResult!: Awaited<ReturnType<typeof ensureServerDatabaseReady>>
    await check('[A1] ensureServerDatabaseReady() прилага целия реален набор (вкл. новата миграция) без грешка', async () => {
      firstRunResult = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(firstRunResult.appliedCount === realMigrationFileNames.length, `appliedCount=${firstRunResult.appliedCount}, expected ${realMigrationFileNames.length}`)
    })

    await check('[A2] Новата миграция е записана в server_migrations ledger', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        assert(ledgerHas(database, NEW_MIGRATION_FILENAME), `${NEW_MIGRATION_FILENAME} missing from ledger`)
      } finally {
        database.close()
      }
    })

    await check('[A3] Всичките 13 нови campaign_* таблици съществуват', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        for (const tableName of EXPECTED_TABLES) {
          assert(tableExists(database, tableName), `missing table: ${tableName}`)
        }
      } finally {
        database.close()
      }
    })

    await check('[A4] Всичките очаквани индекси съществуват', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        for (const indexName of EXPECTED_INDEXES) {
          assert(indexExists(database, indexName), `missing index: ${indexName}`)
        }
      } finally {
        database.close()
      }
    })

    await check('[A5] foreign_keys=1, integrity_check=ok, foreign_key_check empty', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        assertHealthyInvariants(database, 'after full migration run')
      } finally {
        database.close()
      }
    })

    await check('[A6] Повторно (restart) изпълнение е идемпотентно — appliedCount=0, skippedCount=пълния брой', async () => {
      const secondRunResult = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(secondRunResult.appliedCount === 0, `second run appliedCount=${secondRunResult.appliedCount}, expected 0`)
      assert(
        secondRunResult.skippedCount === realMigrationFileNames.length,
        `second run skippedCount=${secondRunResult.skippedCount}, expected ${realMigrationFileNames.length}`,
      )
    })

    await check('[A7] Трети restart остава стабилен (без промяна в таблиците/индексите)', async () => {
      const thirdRunResult = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(thirdRunResult.appliedCount === 0, `third run appliedCount=${thirdRunResult.appliedCount}, expected 0`)
      const database = await openDatabase(temp.databaseFilePath)
      try {
        for (const tableName of EXPECTED_TABLES) {
          assert(tableExists(database, tableName), `missing table after third run: ${tableName}`)
        }
        assertHealthyInvariants(database, 'after third run')
      } finally {
        database.close()
      }
    })
  } finally {
    await temp.cleanup()
  }
}

// ═══ B. Само предпоставките (без новата миграция) → добавяне на новата, restart ═══
{
  const beforeFileNames = realMigrationFileNames.filter((name) => name !== NEW_MIGRATION_FILENAME)
  const temp = await createTempServerRoot(beforeFileNames)
  try {
    await ensureServerDatabaseReady({ serverRootOverride: temp.root })
    await check('[B1] Преди новата миграция — campaign_* таблиците НЕ съществуват', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        for (const tableName of EXPECTED_TABLES) {
          assert(!tableExists(database, tableName), `unexpected pre-existing table: ${tableName}`)
        }
      } finally {
        database.close()
      }
    })

    await cp(join(sourceMigrationsDirectoryPath, NEW_MIGRATION_FILENAME), join(temp.migrationsDirectoryPath, NEW_MIGRATION_FILENAME))

    await check('[B2] "Deploy" на новата миграция (restart) я прилага самостоятелно, без да пипа предходните таблици', async () => {
      const result = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(result.appliedCount === 1, `appliedCount=${result.appliedCount}, expected 1`)
      const database = await openDatabase(temp.databaseFilePath)
      try {
        for (const tableName of EXPECTED_TABLES) {
          assert(tableExists(database, tableName), `missing table after targeted apply: ${tableName}`)
        }
        assertHealthyInvariants(database, 'after targeted new-migration apply')
      } finally {
        database.close()
      }
    })
  } finally {
    await temp.cleanup()
  }
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
