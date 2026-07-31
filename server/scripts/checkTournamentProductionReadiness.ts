import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentAdminStore } from '../src/tournament/tournamentAdmin.js'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`  FAIL ${label}: ${message}`)
  }
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? join(dirname(currentFilePath), '..'),
)
const projectRootPath = resolve(serverRootPath, '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function loadMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function applyMigrations(database: DatabaseSync): Promise<number> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  let applied = 0
  const getApplied = database.prepare(`SELECT filename FROM server_migrations WHERE filename = ? LIMIT 1;`)
  const insertApplied = database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`)
  for (const filename of await loadMigrationFileNames()) {
    if (getApplied.get(filename) !== undefined) continue
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      applied += 1
      continue
    }
    database.exec('BEGIN;')
    try {
      database.exec(sql)
      insertApplied.run(filename)
      database.exec('COMMIT;')
      applied += 1
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw new Error(`Failed to apply migration ${filename}: ${String(error)}`)
    }
  }
  return applied
}

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table';
  `).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function indexNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index';
  `).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

console.log('\ncheckTournamentProductionReadiness')
console.log(`Server root: ${serverRootPath}`)

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-production-readiness-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let adminStore: Awaited<ReturnType<typeof createTournamentAdminStore>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })

  await check('all migrations apply cleanly to an empty SQLite database', async () => {
    const applied = await applyMigrations(db!)
    assert(applied > 0, 'no migrations were applied')
  })

  await check('SQLite integrity_check and foreign_key_check pass after migrations', () => {
    const integrity = (db!.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
    const fkRows = db!.prepare('PRAGMA foreign_key_check;').all()
    assert(integrity === 'ok', `integrity_check=${integrity}`)
    assert(fkRows.length === 0, `foreign_key_check rows=${fkRows.length}`)
  })

  await check('tournament production tables and due-queue indexes exist', () => {
    const tables = tableNames(db!)
    const indexes = indexNames(db!)
    for (const table of [
      'tournaments',
      'tournament_entries',
      'tournament_teams',
      'tournament_rounds',
      'tournament_matches',
      'tournament_economy_ledger',
      'tournament_events',
      'tournament_match_no_show_replacements',
    ]) {
      assert(tables.has(table), `missing table ${table}`)
    }
    for (const index of [
      'idx_tournaments_status',
      'idx_tournaments_scheduled_due',
      'idx_tournament_entries_one_active_per_profile',
      'idx_tournament_economy_ledger_tournament_entry_type',
      'idx_tournament_matches_game_start_due',
      'idx_tournament_economy_ledger_prize_payout',
    ]) {
      assert(indexes.has(index), `missing index ${index}`)
    }
  })

  await check('admin store opens on migrated DB and health snapshot is aggregate-only', async () => {
    adminStore = await createTournamentAdminStore({
      databaseFilePath: dbPath,
      getPublicProfile: () => null,
      getCoordinatorHealth: () => ({ state: 'idle', lastSuccessAt: null, lastError: null }),
      getSchedulerHealth: () => ({ state: 'idle', lastSuccessAt: null, lastError: null }),
      runCoordinatorTick: () => {},
    })
    const health = adminStore.getHealthSnapshot()
    assert(typeof health.activeTournamentCount === 'number', 'missing activeTournamentCount')
    assert(typeof health.pendingSettlementCount === 'number', 'missing pendingSettlementCount')
    assert(!/tournamentId|profileId|session|token|connection/i.test(JSON.stringify(health)), 'health snapshot contains identifiers')
  })

  const serverIndex = await readFile(join(serverRootPath, 'src', 'index.ts'), 'utf8')
  const adminStoreSource = await readFile(join(serverRootPath, 'src', 'tournament', 'tournamentAdmin.ts'), 'utf8')
  const frontendRenderer = await readFile(join(projectRootPath, 'src', 'app', 'adminTournaments', 'renderAdminTournamentsPanel.ts'), 'utf8')
  const runbook = await readFile(join(projectRootPath, 'docs', 'tournament-production-deploy.md'), 'utf8').catch(() => '')

  await check('admin tournament routes are read/write role separated', () => {
    assert(serverIndex.includes('isAdminOrSubadminSession(session)'), 'missing read auth guard')
    assert(serverIndex.includes('isFullAdminSession(session)'), 'missing write auth guard')
    assert(serverIndex.includes('isAllowedVisitorRequestOrigin(req)'), 'missing write origin guard')
    assert(serverIndex.includes('ADMIN_TOURNAMENT_ACTION_RATE_LIMIT_MAX_PER_WINDOW'), 'missing action rate limit')
  })

  await check('admin operations do not add forbidden tournament powers', () => {
    const combined = `${serverIndex}\n${adminStoreSource}\n${frontendRenderer}`
    for (const forbidden of [
      'forceWinner',
      'force-winner',
      'forcePrize',
      'force-prize',
      'forcePayout',
      'force-payout',
      'deleteTournament',
      'delete-tournament',
      'third-place',
      'thirdPlace',
    ]) {
      assert(!combined.includes(forbidden), `forbidden surface found: ${forbidden}`)
    }
    assert(!frontendRenderer.includes('official'), 'frontend should not expose official tournament creation/control')
  })

  await check('production runbook documents no-deploy verification and rollback commands', () => {
    assert(runbook.includes('No deploy is performed by this checklist.'), 'runbook missing no-deploy guard')
    assert(runbook.includes('npm run check:tournament-end-to-end'), 'runbook missing end-to-end check')
    assert(runbook.includes('npm run check:tournament-concurrency'), 'runbook missing concurrency check')
    assert(runbook.includes('npm run check:admin-tournament-api'), 'runbook missing admin API check')
    assert(runbook.includes('npm run check:tournament-integrity'), 'runbook missing integrity check')
    assert(runbook.includes('backup:db:prod'), 'runbook missing production backup command')
    assert(runbook.includes('verify:db:prod'), 'runbook missing production backup verification')
    assert(runbook.includes('ROLLBACK'), 'runbook missing rollback section')
  })
} finally {
  adminStore?.close()
  db?.close()
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`checkTournamentProductionReadiness failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkTournamentProductionReadiness passed: ${passed} checks.`)
