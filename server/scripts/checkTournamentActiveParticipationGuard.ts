import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, details = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${details ? `: ${details}` : ''}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
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
  const insertApplied = database.prepare(`INSERT OR IGNORE INTO server_migrations (filename) VALUES (?);`)
  for (const filename of await loadMigrationFileNames()) {
    if (getApplied.get(filename) !== undefined) continue
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      insertApplied.run(filename)
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

function insertProfile(database: DatabaseSync, profileId: string, accountId = profileId): void {
  database.prepare(`
    INSERT OR IGNORE INTO accounts (account_id, email, password_hash, role, status)
    VALUES (?, ?, 'hash', 'player', 'active');
  `).run(accountId, `${profileId}@example.test`)
  database.prepare(`
    INSERT OR IGNORE INTO profiles (
      profile_id, account_id, display_name, normalized_display_name, profile_kind, status
    ) VALUES (?, ?, ?, ?, 'human', 'active');
  `).run(profileId, accountId, profileId, profileId.toLowerCase())
  database.prepare(`
    INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 1000000);
  `).run(profileId)
}

function insertTournament(
  database: DatabaseSync,
  tournamentId: string,
  creatorProfileId: string,
  status: string,
  name = `Guard ${tournamentId}`,
): void {
  insertProfile(database, creatorProfileId)
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status,
      started_at, finished_at
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 5000, 8, 'fill', NULL, ?, CURRENT_TIMESTAMP,
      CASE WHEN ? IN ('finished', 'cancelled', 'admin_cancelled', 'auto_cancelled', 'failed')
        THEN CURRENT_TIMESTAMP
        ELSE NULL
      END
    );
  `).run(tournamentId, name, creatorProfileId, status, status)
}

function insertEntry(database: DatabaseSync, tournamentId: string, profileId: string, status: string): void {
  database.prepare(`
    INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
    VALUES (?, ?, ?, NULL, 'solo', ?);
  `).run(randomUUID(), tournamentId, profileId, status)
}

function countEntries(database: DatabaseSync, tournamentId: string, profileId: string): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count
    FROM tournament_entries
    WHERE tournament_id = ? AND profile_id = ?;
  `).get(tournamentId, profileId) as { count: number }).count
}

const tempDir = await mkdtemp(join(tmpdir(), 'belot-active-participation-guard-'))
const dbPath = join(tempDir, 'server.db')

const database = new DatabaseSync(dbPath)
await applyMigrations(database)

const uniqueIndex = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_tournament_entries_one_active_per_profile';
  `).get()
check('old profile-only active unique index is removed', uniqueIndex === undefined)

const economyStore = await createTournamentEconomyStore(dbPath)

const terminalCases: Array<{ label: string; tournamentStatus: string; entryStatus: string; profileId: string }> = [
    { label: 'finished finalist does not block', tournamentStatus: 'finished', entryStatus: 'finalist', profileId: 'finished-finalist' },
    { label: 'finished champion does not block', tournamentStatus: 'finished', entryStatus: 'champion', profileId: 'finished-champion' },
    { label: 'finished eliminated does not block', tournamentStatus: 'finished', entryStatus: 'eliminated', profileId: 'finished-eliminated' },
    { label: 'cancelled confirmed does not block', tournamentStatus: 'cancelled', entryStatus: 'confirmed', profileId: 'cancelled-confirmed' },
    { label: 'local oxs2aj bot-f-023 finalist does not block', tournamentStatus: 'finished', entryStatus: 'finalist', profileId: 'bot-f-023' },
]

for (const testCase of terminalCases) {
    insertProfile(database, testCase.profileId)
    const oldTournamentId = `old-${testCase.profileId}`
    const newTournamentId = `new-${testCase.profileId}`
    insertTournament(
      database,
      oldTournamentId,
      `creator-${oldTournamentId}`,
      testCase.tournamentStatus,
      testCase.profileId === 'bot-f-023' ? '[local-test:oxs2aj] 4t/one_human' : undefined,
    )
    insertEntry(database, oldTournamentId, testCase.profileId, testCase.entryStatus)
    insertTournament(database, newTournamentId, `creator-${newTournamentId}`, 'open')

    const result = economyStore.joinTournamentSoloAtomically(newTournamentId, testCase.profileId)
    check(
      testCase.label,
      result.ok === true && countEntries(database, newTournamentId, testCase.profileId) === 1,
      JSON.stringify(result),
    )
}

for (const status of ['open', 'starting', 'semifinal_in_progress', 'final_in_progress']) {
    const profileId = `active-${status}`
    insertProfile(database, profileId)
    insertTournament(database, `active-old-${status}`, `creator-active-old-${status}`, status)
    insertEntry(database, `active-old-${status}`, profileId, 'confirmed')
    insertTournament(database, `active-new-${status}`, `creator-active-new-${status}`, 'open')

    const result = economyStore.joinTournamentSoloAtomically(`active-new-${status}`, profileId)
    check(
      `confirmed entry in ${status} tournament blocks`,
      result.ok === false && result.reason === 'already_participating_elsewhere',
      JSON.stringify(result),
    )
}

const finalistProfileId = 'active-finalist-profile'
insertProfile(database, finalistProfileId)
insertTournament(database, 'active-finalist-old', 'creator-active-finalist-old', 'final_in_progress')
insertEntry(database, 'active-finalist-old', finalistProfileId, 'finalist')
insertTournament(database, 'active-finalist-new', 'creator-active-finalist-new', 'open')
const finalistResult = economyStore.joinTournamentSoloAtomically('active-finalist-new', finalistProfileId)
check(
  'finalist entry in active tournament blocks',
  finalistResult.ok === false && finalistResult.reason === 'already_participating_elsewhere',
  JSON.stringify(finalistResult),
)

const sharedAccountId = 'shared-account'
insertProfile(database, 'shared-profile-a', sharedAccountId)
database.prepare(`
    INSERT INTO profiles (
      profile_id, account_id, display_name, normalized_display_name, profile_kind, status
    ) VALUES ('shared-profile-b', ?, 'shared-profile-b', 'shared-profile-b', 'human', 'active');
`).run(sharedAccountId)
database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES ('shared-profile-b', 1000000);
`).run()
insertTournament(database, 'shared-active-old', 'creator-shared-active-old', 'semifinal_in_progress')
insertEntry(database, 'shared-active-old', 'shared-profile-a', 'confirmed')
insertTournament(database, 'shared-active-new', 'creator-shared-active-new', 'open')
const sharedResult = economyStore.joinTournamentSoloAtomically('shared-active-new', 'shared-profile-b')
check(
  'account-level guard blocks another profile on same account in active tournament',
  sharedResult.ok === false && sharedResult.reason === 'already_participating_elsewhere',
  JSON.stringify(sharedResult),
)

assert(failed === 0, `${failed} checks failed`)

console.log(`checkTournamentActiveParticipationGuard passed=${passed} failed=${failed}`)
