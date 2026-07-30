import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentStore } from '../src/db/tournamentStore.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok ${label}`)
    passed += 1
  } else {
    console.error(`  FAIL ${label}`)
    failed += 1
  }
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
const projectRootPath = resolve(join(serverRootPath, '..'))
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function loadMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const getApplied = database.prepare(`SELECT filename FROM server_migrations WHERE filename = ? LIMIT 1;`)
  const insertApplied = database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`)
  for (const filename of await loadMigrationFileNames()) {
    if (getApplied.get(filename) !== undefined) continue
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      continue
    }
    database.exec('BEGIN;')
    try {
      database.exec(sql)
      insertApplied.run(filename)
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw new Error(`Failed to apply migration ${filename}: ${String(error)}`)
    }
  }
}

function insertProfile(database: DatabaseSync, profileId: string, index: number): void {
  database.prepare(`
    INSERT INTO profiles (profile_id, display_name, normalized_display_name)
    VALUES (?, ?, ?);
  `).run(profileId, `Finished List Player ${index + 1}`, `finished list player ${index + 1}`)
}

function insertTournament(database: DatabaseSync, input: {
  tournamentId: string
  creatorProfileId: string
  status: 'open' | 'starting' | 'semifinal_in_progress' | 'final_in_progress' | 'finished'
  createdAt: string
  finishedAt: string | null
}): void {
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status,
      settlement_state, settled_at, finished_at, created_at, updated_at
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 5000, 8, 'fill', NULL, ?, ?, ?, ?, ?, ?);
  `).run(
    input.tournamentId,
    `List ${input.tournamentId.slice(0, 8)}`,
    input.creatorProfileId,
    input.status,
    input.status === 'finished' ? 'settled' : 'pending',
    input.finishedAt,
    input.finishedAt,
    input.createdAt,
    input.createdAt,
  )
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

console.log('\ncheckTournamentFinishedListUi')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-finished-list-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)

  const creators = Array.from({ length: 13 }, () => randomUUID())
  creators.forEach((profileId, index) => insertProfile(db!, profileId, index))

  const finishedIds: string[] = []
  for (let i = 0; i < 11; i += 1) {
    const tournamentId = randomUUID()
    finishedIds.push(tournamentId)
    insertTournament(db, {
      tournamentId,
      creatorProfileId: creators[0]!,
      status: 'finished',
      createdAt: `2026-07-30T10:${String(i).padStart(2, '0')}:00.000Z`,
      finishedAt: `2026-07-30T12:${String(i).padStart(2, '0')}:00.000Z`,
    })
  }
  const activeIds = [randomUUID(), randomUUID()]
  insertTournament(db, {
    tournamentId: activeIds[0]!,
    creatorProfileId: creators[1]!,
    status: 'open',
    createdAt: '2026-07-30T13:00:00.000Z',
    finishedAt: null,
  })
  insertTournament(db, {
    tournamentId: activeIds[1]!,
    creatorProfileId: creators[2]!,
    status: 'final_in_progress',
    createdAt: '2026-07-30T13:01:00.000Z',
    finishedAt: null,
  })

  tournamentStore = await createTournamentStore(dbPath)
  const finished = tournamentStore.listTournaments({ statuses: ['finished'], limit: 10, offset: 0, orderBy: 'finished_desc' })
  check('finished list returns latest 10 by finished_at desc', finished.length === 10 && finished[0]?.tournamentId === finishedIds[10] && finished[9]?.tournamentId === finishedIds[1])
  check('11th finished tournament remains persisted', countRows(db, `SELECT COUNT(*) as count FROM tournaments WHERE tournament_id = ? AND status = 'finished';`, finishedIds[0]!) === 1)
  check('finished count is not truncated by list query', tournamentStore.countTournaments({ statuses: ['finished'] }) === 11)
  const active = tournamentStore.listTournaments({
    statuses: ['open', 'starting', 'semifinal_in_progress', 'final_in_progress'],
    limit: 50,
    offset: 0,
    orderBy: 'created_desc',
  })
  check('active list still includes non-finished tournaments', active.map((tournament) => tournament.tournamentId).includes(activeIds[0]!) && active.map((tournament) => tournament.tournamentId).includes(activeIds[1]!))

  const tournamentsScreen = await readFile(join(projectRootPath, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'), 'utf8')
  const networkTypes = await readFile(join(projectRootPath, 'src', 'app', 'network', 'createGameServerClient.ts'), 'utf8')
  const dtoSource = await readFile(join(projectRootPath, 'server', 'src', 'tournament', 'tournamentDto.ts'), 'utf8')
  check('frontend renders final settlement summary', [
    'renderTournamentFinalSummary',
    'championTeamId',
    'runnerUpTeamId',
    'settlementState',
    'myPrizeAmount',
  ].every((needle) => tournamentsScreen.includes(needle) || networkTypes.includes(needle) || dtoSource.includes(needle)))
  check('frontend shows pending settlement message before settled state', tournamentsScreen.includes('Наградите се обработват'))
} finally {
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentFinishedListUi failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentFinishedListUi passed: ${passed} checks`)
