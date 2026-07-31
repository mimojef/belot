/**
 * checkServerMigrationRestartSafety.ts
 *
 * Behavior-level restart-safety test for the REAL ensureServerDatabaseReady()
 * migration runner (server/src/db/ensureServerDatabaseReady.ts), targeting
 * the production incident root cause: 20260801_001/20260801_002 were marked
 * (001) or accidentally treated as needing (002) a self-managed manual
 * transaction, but did not actually implement that contract (no BEGIN/COMMIT,
 * no self-inserted ledger row) — so the schema change could be applied while
 * the server_migrations ledger row was never written, causing the file to be
 * re-applied on the next restart and fail with "table already exists" /
 * "duplicate column name".
 *
 * This test invokes the REAL ensureServerDatabaseReady() function (via a
 * serverRootOverride pointing at an isolated temp directory) — never a
 * reimplemented copy, and never the real local/production database. All
 * SQLite databases and migration directories used here are created under
 * the OS temp directory and removed at the end.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
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

const MANUAL_TRANSACTION_MARKER = '-- MANUAL_TRANSACTION_MIGRATION'
const MIGRATION_001 = '20260801_001_add_variable_team_capacity_bracket_rounds.sql'
const MIGRATION_002 = '20260801_002_add_tournament_match_deadline_kind_and_score.sql'

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckServerMigrationRestartSafety')
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
  const root = await mkdtemp(join(tmpdir(), 'belot-migration-restart-safety-'))
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

function countRows(database: Awaited<ReturnType<typeof openDatabase>>, tableName: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${tableName};`).get() as { count: number }).count
}

function tableExists(database: Awaited<ReturnType<typeof openDatabase>>, tableName: string): boolean {
  return database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;`)
    .get(tableName) !== undefined
}

function ledgerHas(database: Awaited<ReturnType<typeof openDatabase>>, filename: string): boolean {
  return database
    .prepare(`SELECT filename FROM server_migrations WHERE filename = ?;`)
    .get(filename) !== undefined
}

// Точните redове, seed-нати преди 001/002 — идентификатори, пазени през
// целия тест, за да потвърдим, че rebuild-ите на tournament_teams/
// tournament_rounds не губят/дублират/пренаписват съществуващи данни.
type SeedIds = {
  profileId: string
  tournamentId: string
  teamAId: string
  teamBId: string
  roundId: string
  matchId: string
}

function seedPreMigrationTournamentData(database: Awaited<ReturnType<typeof openDatabase>>): SeedIds {
  const profileId = randomUUID()
  const tournamentId = randomUUID()
  const teamAId = randomUUID()
  const teamBId = randomUUID()
  const roundId = randomUUID()
  const matchId = randomUUID()

  database.exec('BEGIN;')
  try {
    database.prepare(`
      INSERT INTO profiles (profile_id, display_name, normalized_display_name)
      VALUES (?, 'Restart Safety Player', 'restart safety player');
    `).run(profileId)

    database.prepare(`
      INSERT INTO tournaments (
        tournament_id, creator_profile_id, name, entry_fee, player_capacity, start_mode, status
      ) VALUES (?, ?, 'Restart Safety Tournament', 10000, 4, 'fill', 'starting');
    `).run(tournamentId, profileId)

    // Стар (pre-001) schema: seed_slot само 1-4.
    database.prepare(`
      INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot)
      VALUES (?, ?, 'locked', 1);
    `).run(teamAId, tournamentId)
    database.prepare(`
      INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot)
      VALUES (?, ?, 'locked', 2);
    `).run(teamBId, tournamentId)

    // Стар (pre-001) schema: round_type само 'semifinal'/'final'.
    database.prepare(`
      INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index)
      VALUES (?, ?, 'semifinal', 1);
    `).run(roundId, tournamentId)

    database.prepare(`
      INSERT INTO tournament_matches (match_id, tournament_id, round_id, team_a_id, team_b_id, status)
      VALUES (?, ?, ?, ?, ?, 'awaiting_players');
    `).run(matchId, tournamentId, roundId, teamAId, teamBId)

    database.exec('COMMIT;')
  } catch (error) {
    database.exec('ROLLBACK;')
    throw error
  }

  return { profileId, tournamentId, teamAId, teamBId, roundId, matchId }
}

function assertSeedDataIntact(database: Awaited<ReturnType<typeof openDatabase>>, seed: SeedIds, label: string): void {
  const team = database.prepare(`SELECT team_id, seed_slot FROM tournament_teams WHERE team_id = ?;`).get(seed.teamAId) as
    | { team_id: string; seed_slot: number }
    | undefined
  assert(team !== undefined, `${label}: teamA row missing`)
  assert(team!.seed_slot === 1, `${label}: teamA seed_slot changed to ${team!.seed_slot}`)

  const round = database.prepare(`SELECT round_id, round_type FROM tournament_rounds WHERE round_id = ?;`).get(seed.roundId) as
    | { round_id: string; round_type: string }
    | undefined
  assert(round !== undefined, `${label}: round row missing`)
  assert(round!.round_type === 'semifinal', `${label}: round_type changed to ${round!.round_type}`)

  const match = database.prepare(`SELECT match_id FROM tournament_matches WHERE match_id = ?;`).get(seed.matchId) as
    | { match_id: string }
    | undefined
  assert(match !== undefined, `${label}: match row missing`)

  const tournament = database.prepare(`SELECT tournament_id FROM tournaments WHERE tournament_id = ?;`).get(seed.tournamentId) as
    | { tournament_id: string }
    | undefined
  assert(tournament !== undefined, `${label}: tournament row missing`)
}

function getColumnType(
  database: Awaited<ReturnType<typeof openDatabase>>,
  tableName: string,
  columnName: string,
): string | undefined {
  const rows = database.prepare(`PRAGMA table_info(${tableName});`).all() as Array<{ name: string; type: string }>
  return rows.find((row) => row.name === columnName)?.type
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
assert(realMigrationFileNames.includes(MIGRATION_001), `${MIGRATION_001} not found under ${sourceMigrationsDirectoryPath}`)
assert(realMigrationFileNames.includes(MIGRATION_002), `${MIGRATION_002} not found under ${sourceMigrationsDirectoryPath}`)
const beforeMigrationFileNames = realMigrationFileNames.filter((name) => !name.startsWith('20260801_'))
assert(beforeMigrationFileNames.length < realMigrationFileNames.length, 'expected at least one 20260801_* migration to be excluded from the "before" set')

// ═══ A. Fresh DB → full startup (001+002) → restart safety [1]-[9] ═══
{
  const temp = await createTempServerRoot(beforeMigrationFileNames)
  try {
    await ensureServerDatabaseReady({ serverRootOverride: temp.root })

    let seed!: SeedIds
    await check('[1]-[2] Seed tournament/team/round/match on the schema version immediately before 001', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        seed = seedPreMigrationTournamentData(database)
      } finally {
        database.close()
      }
    })

    // Добавя 001/002 файловете, за да симулира "новият код пристига".
    await cp(join(sourceMigrationsDirectoryPath, MIGRATION_001), join(temp.migrationsDirectoryPath, MIGRATION_001))
    await cp(join(sourceMigrationsDirectoryPath, MIGRATION_002), join(temp.migrationsDirectoryPath, MIGRATION_002))

    let firstRunResult: Awaited<ReturnType<typeof ensureServerDatabaseReady>>
    await check('[3] Real ensureServerDatabaseReady() applies 001 and 002 without throwing', async () => {
      firstRunResult = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(firstRunResult.appliedCount >= 2, `appliedCount=${firstRunResult.appliedCount}, expected >= 2`)
    })

    await check('[4] Both 001 and 002 are recorded in the server_migrations ledger', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        assert(ledgerHas(database, MIGRATION_001), '001 missing from ledger')
        assert(ledgerHas(database, MIGRATION_002), '002 missing from ledger')
      } finally {
        database.close()
      }
    })

    await check('[5] New constraints/columns are in place (seed_slot<=16, round_of_16/quarterfinal allowed, deadline_kind/final_score_* columns)', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        // seed_slot до 16 вече позволено (би хвърлило CHECK violation при старата schema).
        const wideSeedProfileId = randomUUID()
        database.prepare(`
          INSERT INTO profiles (profile_id, display_name, normalized_display_name)
          VALUES (?, 'Wide Seed Owner', 'wide seed owner');
        `).run(wideSeedProfileId)
        const wideSeedTournamentId = randomUUID()
        database.prepare(`
          INSERT INTO tournaments (tournament_id, creator_profile_id, name, entry_fee, player_capacity, start_mode, status)
          VALUES (?, ?, 'Wide Seed Tournament', 10000, 16, 'fill', 'starting');
        `).run(wideSeedTournamentId, wideSeedProfileId)
        const wideSeedTeamId = randomUUID()
        database.prepare(`
          INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot) VALUES (?, ?, 'locked', 16);
        `).run(wideSeedTeamId, wideSeedTournamentId)
        const wideSeedRoundId = randomUUID()
        database.prepare(`
          INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, 'round_of_16', 8);
        `).run(wideSeedRoundId, wideSeedTournamentId)
        database.prepare(`
          INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, 'quarterfinal', 4);
        `).run(randomUUID(), wideSeedTournamentId)

        assert(getColumnType(database, 'tournament_matches', 'deadline_kind') === 'TEXT', 'deadline_kind missing/wrong type')
        assert(getColumnType(database, 'tournament_matches', 'final_score_team_a') === 'INTEGER', 'final_score_team_a missing/wrong type')
        assert(getColumnType(database, 'tournament_matches', 'final_score_team_b') === 'INTEGER', 'final_score_team_b missing/wrong type')
      } finally {
        database.close()
      }
    })

    await check('[6] Pre-migration seed data (profile/tournament/team/round/match) is preserved with the same IDs', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        assertSeedDataIntact(database, seed, 'after first 001/002 run')
      } finally {
        database.close()
      }
    })

    await check('[7] No stage20260801 tables remain after a successful run', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        assert(!tableExists(database, 'tournament_teams_stage20260801'), 'tournament_teams_stage20260801 still exists')
        assert(!tableExists(database, 'tournament_rounds_stage20260801'), 'tournament_rounds_stage20260801 still exists')
      } finally {
        database.close()
      }
    })

    let rowCountsAfterFirstRun: Record<string, number>
    {
      const database = await openDatabase(temp.databaseFilePath)
      rowCountsAfterFirstRun = {
        tournaments: countRows(database, 'tournaments'),
        tournament_teams: countRows(database, 'tournament_teams'),
        tournament_rounds: countRows(database, 'tournament_rounds'),
        tournament_matches: countRows(database, 'tournament_matches'),
        server_migrations: countRows(database, 'server_migrations'),
      }
      database.close()
    }

    await check('[8]-[9] A second real startup skips 001/002 via the ledger (no re-apply, no row-count drift)', async () => {
      const secondRunResult = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(secondRunResult.appliedCount === 0, `second run appliedCount=${secondRunResult.appliedCount}, expected 0`)
      assert(secondRunResult.skippedCount === realMigrationFileNames.length, `second run skippedCount=${secondRunResult.skippedCount}, expected ${realMigrationFileNames.length}`)

      const database = await openDatabase(temp.databaseFilePath)
      try {
        for (const [table, before] of Object.entries(rowCountsAfterFirstRun)) {
          const after = countRows(database, table)
          assert(after === before, `${table} row count changed on second startup: before=${before}, after=${after}`)
        }
        assertSeedDataIntact(database, seed, 'after second startup')
        assertHealthyInvariants(database, 'after second startup')
      } finally {
        database.close()
      }
    })

    await check('[19] A third startup still leaves row counts unchanged', async () => {
      const thirdRunResult = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(thirdRunResult.appliedCount === 0, `third run appliedCount=${thirdRunResult.appliedCount}, expected 0`)
      const database = await openDatabase(temp.databaseFilePath)
      try {
        for (const [table, before] of Object.entries(rowCountsAfterFirstRun)) {
          const after = countRows(database, table)
          assert(after === before, `${table} row count changed on third startup: before=${before}, after=${after}`)
        }
      } finally {
        database.close()
      }
    })

    await check('[16]-[18] foreign_keys=1, integrity_check=ok, foreign_key_check empty after the full flow', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        assertHealthyInvariants(database, 'after full A-flow')
      } finally {
        database.close()
      }
    })
  } finally {
    await temp.cleanup()
  }
}

// ═══ B. 001 schema applied + ledger missing + empty stale stage table [10]-[11] ═══
{
  const temp = await createTempServerRoot(beforeMigrationFileNames)
  try {
    await ensureServerDatabaseReady({ serverRootOverride: temp.root })
    let seed!: SeedIds
    {
      const database = await openDatabase(temp.databaseFilePath)
      seed = seedPreMigrationTournamentData(database)
      database.close()
    }

    await cp(join(sourceMigrationsDirectoryPath, MIGRATION_001), join(temp.migrationsDirectoryPath, MIGRATION_001))
    await cp(join(sourceMigrationsDirectoryPath, MIGRATION_002), join(temp.migrationsDirectoryPath, MIGRATION_002))

    await check('[10] Simulate: 001 already applied to the live schema, but its own ledger insert never happened (+ a stale empty stage table)', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        const migration001Sql = await readFile(join(sourceMigrationsDirectoryPath, MIGRATION_001), 'utf8')
        assert(migration001Sql.trim().startsWith(MANUAL_TRANSACTION_MARKER), '001 no longer starts with the manual marker — test assumption invalid')
        // Прилага РЕАЛНИЯ (поправен) SQL directly (не през runner-а), после
        // изтрива ledger реда — конструира точно "schema applied, ledger
        // missing" без да се налага отделна hand-written "счупена" версия.
        database.exec(migration001Sql)
        assert(ledgerHas(database, MIGRATION_001), 'sanity: direct exec should have inserted the ledger row')
        database.prepare(`DELETE FROM server_migrations WHERE filename = ?;`).run(MIGRATION_001)
        assert(!ledgerHas(database, MIGRATION_001), 'sanity: ledger row should now be gone')

        // Stale empty stage artifact, като от прекъснат pre-fix опит.
        database.exec(`CREATE TABLE tournament_rounds_stage20260801 (round_id TEXT PRIMARY KEY);`)
        assert(tableExists(database, 'tournament_rounds_stage20260801'), 'sanity: stale stage table should exist now')
      } finally {
        database.close()
      }
    })

    await check('[11] Real ensureServerDatabaseReady() safely recovers: no "table already exists", ledger written, stale stage table gone, data intact', async () => {
      const result = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(result.appliedCount >= 1, `appliedCount=${result.appliedCount}, expected >= 1 (001 recovery + 002 fresh apply)`)

      const database = await openDatabase(temp.databaseFilePath)
      try {
        assert(ledgerHas(database, MIGRATION_001), '001 still missing from ledger after recovery')
        assert(ledgerHas(database, MIGRATION_002), '002 missing from ledger after recovery run')
        assert(!tableExists(database, 'tournament_rounds_stage20260801'), 'stale stage table survived recovery')
        assert(!tableExists(database, 'tournament_teams_stage20260801'), 'unexpected stage table present')
        assertSeedDataIntact(database, seed, 'after 001 ledger-missing recovery')
        assertHealthyInvariants(database, 'after 001 ledger-missing recovery')
      } finally {
        database.close()
      }
    })
  } finally {
    await temp.cleanup()
  }
}

async function buildTempRootJustBefore002(): Promise<{ temp: TempServerRoot; seed: SeedIds }> {
  const filesUpToAnd001 = [...beforeMigrationFileNames, MIGRATION_001]
  const temp = await createTempServerRoot(filesUpToAnd001)
  await ensureServerDatabaseReady({ serverRootOverride: temp.root })
  const database = await openDatabase(temp.databaseFilePath)
  const seed = seedPreMigrationTournamentData(database)
  database.close()
  await cp(join(sourceMigrationsDirectoryPath, MIGRATION_002), join(temp.migrationsDirectoryPath, MIGRATION_002))
  return { temp, seed }
}

// ═══ C. 002 all three columns present, ledger missing [12]-[13] ═══
{
  const { temp, seed } = await buildTempRootJustBefore002()
  try {
    await check('[12] Simulate: all three tournament_matches columns already present, 002 missing from ledger', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        database.exec(`
          ALTER TABLE tournament_matches ADD COLUMN deadline_kind TEXT NULL CHECK (
            deadline_kind IS NULL OR deadline_kind IN ('first_match', 'round_transition')
          );
        `)
        database.exec(`ALTER TABLE tournament_matches ADD COLUMN final_score_team_a INTEGER NULL;`)
        database.exec(`ALTER TABLE tournament_matches ADD COLUMN final_score_team_b INTEGER NULL;`)
        assert(!ledgerHas(database, MIGRATION_002), 'sanity: 002 ledger row should not exist yet')
      } finally {
        database.close()
      }
    })

    await check('[13] Real ensureServerDatabaseReady() recovers the ledger row without a duplicate-column error', async () => {
      const result = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(result.appliedCount === 1, `appliedCount=${result.appliedCount}, expected 1 (002 ledger-only recovery)`)
      const database = await openDatabase(temp.databaseFilePath)
      try {
        assert(ledgerHas(database, MIGRATION_002), '002 still missing from ledger')
        assert(getColumnType(database, 'tournament_matches', 'deadline_kind') === 'TEXT', 'deadline_kind wrong type after recovery')
        assert(getColumnType(database, 'tournament_matches', 'final_score_team_a') === 'INTEGER', 'final_score_team_a wrong type after recovery')
        assert(getColumnType(database, 'tournament_matches', 'final_score_team_b') === 'INTEGER', 'final_score_team_b wrong type after recovery')
        assertSeedDataIntact(database, seed, 'after 002 ledger-only recovery')
        assertHealthyInvariants(database, 'after 002 ledger-only recovery')
      } finally {
        database.close()
      }
    })
  } finally {
    await temp.cleanup()
  }
}

// ═══ D. Partial 002 state (only one of three columns present) [14]-[15] ═══
{
  const { temp, seed } = await buildTempRootJustBefore002()
  try {
    await check('[14] Simulate: only final_score_team_a already present (partial prior attempt), 002 missing from ledger', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        database.exec(`ALTER TABLE tournament_matches ADD COLUMN final_score_team_a INTEGER NULL;`)
        assert(getColumnType(database, 'tournament_matches', 'deadline_kind') === undefined, 'sanity: deadline_kind should not exist yet')
        assert(getColumnType(database, 'tournament_matches', 'final_score_team_b') === undefined, 'sanity: final_score_team_b should not exist yet')
      } finally {
        database.close()
      }
    })

    await check('[15] Real ensureServerDatabaseReady() safely completes the missing columns only, then records the ledger row', async () => {
      const result = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(result.appliedCount === 1, `appliedCount=${result.appliedCount}, expected 1 (002 partial completion)`)
      const database = await openDatabase(temp.databaseFilePath)
      try {
        assert(ledgerHas(database, MIGRATION_002), '002 missing from ledger after partial-completion recovery')
        assert(getColumnType(database, 'tournament_matches', 'deadline_kind') === 'TEXT', 'deadline_kind not safely completed')
        assert(getColumnType(database, 'tournament_matches', 'final_score_team_a') === 'INTEGER', 'final_score_team_a lost/changed')
        assert(getColumnType(database, 'tournament_matches', 'final_score_team_b') === 'INTEGER', 'final_score_team_b not safely completed')
        assertSeedDataIntact(database, seed, 'after 002 partial-completion recovery')
        assertHealthyInvariants(database, 'after 002 partial-completion recovery')
      } finally {
        database.close()
      }
    })
  } finally {
    await temp.cleanup()
  }
}

// ═══ E. Invalid postcondition never gets a ledger row [20] ═══
{
  const { temp } = await buildTempRootJustBefore002()
  try {
    await check('[20] An unsafe/invalid postcondition (wrong column type) is rejected and does NOT write a ledger row', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        // deadline_kind вече съществува, но с грешен тип — handler-ът трябва
        // да го открие и да откаже, вместо да приема произволна schema.
        database.exec(`ALTER TABLE tournament_matches ADD COLUMN deadline_kind INTEGER NULL;`)
      } finally {
        database.close()
      }

      let threw = false
      try {
        await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      } catch {
        threw = true
      }
      assert(threw, 'expected ensureServerDatabaseReady() to throw on an invalid postcondition')

      const verifyDatabase = await openDatabase(temp.databaseFilePath)
      try {
        assert(!ledgerHas(verifyDatabase, MIGRATION_002), '002 ledger row was written despite an invalid postcondition')
        // Атомарност: другите две колони не трябва да са останали "наполовина" добавени.
        assert(getColumnType(verifyDatabase, 'tournament_matches', 'final_score_team_a') === undefined, 'final_score_team_a leaked from a rolled-back transaction')
        assert(getColumnType(verifyDatabase, 'tournament_matches', 'final_score_team_b') === undefined, 'final_score_team_b leaked from a rolled-back transaction')
      } finally {
        verifyDatabase.close()
      }
    })
  } finally {
    await temp.cleanup()
  }
}

// ═══ F. Static + runtime contract check for ALL manual-transaction migrations (§7 в task spec-а) ═══
await check('Every manual-transaction migration file has a real transaction boundary and a ledger-insert mechanism', async () => {
  const manualFileNames: string[] = []
  for (const filename of realMigrationFileNames) {
    const raw = await readFile(join(sourceMigrationsDirectoryPath, filename), 'utf8')
    if (raw.trim().startsWith(MANUAL_TRANSACTION_MARKER)) {
      manualFileNames.push(filename)
    }
  }
  assert(manualFileNames.length > 0, 'expected at least one manual-transaction migration to exist')
  assert(!manualFileNames.includes(MIGRATION_002), '002 should no longer claim to be a manual-transaction migration')

  for (const filename of manualFileNames) {
    const raw = await readFile(join(sourceMigrationsDirectoryPath, filename), 'utf8')
    const hasBegin = /\bBEGIN\b/i.test(raw)
    const hasCommit = /\bCOMMIT\b/i.test(raw)
    const hasLedgerInsert = /INSERT\s+INTO\s+server_migrations/i.test(raw)
    assert(hasBegin, `${filename}: manual migration is missing a BEGIN transaction boundary`)
    assert(hasCommit, `${filename}: manual migration is missing a COMMIT transaction boundary`)
    assert(hasLedgerInsert, `${filename}: manual migration is missing its own INSERT INTO server_migrations`)
  }
})

await check('A manual-transaction migration that violates the ledger contract is rejected at runtime, not silently accepted', async () => {
  const temp = await createTempServerRoot(beforeMigrationFileNames)
  try {
    await ensureServerDatabaseReady({ serverRootOverride: temp.root })
    const brokenFileName = '99999999_999_fake_broken_manual_migration.sql'
    const brokenSql = `${MANUAL_TRANSACTION_MARKER}\nCREATE TABLE fake_broken_migration_probe (id TEXT PRIMARY KEY);\n`
    await (await import('node:fs/promises')).writeFile(join(temp.migrationsDirectoryPath, brokenFileName), brokenSql, 'utf8')

    let threw = false
    let message = ''
    try {
      await ensureServerDatabaseReady({ serverRootOverride: temp.root })
    } catch (error) {
      threw = true
      message = error instanceof Error ? error.message : String(error)
    }
    assert(threw, 'runner accepted a manual migration that never inserted its own ledger row')
    assert(
      message.toLowerCase().includes('ledger') || message.toLowerCase().includes('server_migrations') || message.toLowerCase().includes('contract'),
      `error message did not mention the ledger contract violation: ${message}`,
    )

    const database = await openDatabase(temp.databaseFilePath)
    try {
      assert(!ledgerHas(database, brokenFileName), 'broken migration was recorded in the ledger despite violating the contract')
    } finally {
      database.close()
    }
  } finally {
    await temp.cleanup()
  }
})

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
