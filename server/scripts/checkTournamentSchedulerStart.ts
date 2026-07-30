import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'
import { calculateTournamentPrizePreview } from '../src/tournament/tournamentPrizeRules.js'

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

function insertProfile(database: DatabaseSync, profileId: string, name: string, balance: number): void {
  database.prepare(`
    INSERT INTO profiles (profile_id, display_name, normalized_display_name)
    VALUES (?, ?, ?);
  `).run(profileId, name, name.toLowerCase())
  database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, ?);
  `).run(profileId, balance)
}

function insertReadyTournament(database: DatabaseSync, input: {
  tournamentId: string
  creatorProfileId: string
  startMode: 'fill' | 'scheduled'
  scheduledStartAt: string | null
  entryFee: number
  profiles: string[]
}): void {
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status
    ) VALUES (?, 'community', ?, ?, 'public', NULL, ?, 8, ?, ?, 'open');
  `).run(
    input.tournamentId,
    `Tournament ${input.tournamentId.slice(0, 8)}`,
    input.creatorProfileId,
    input.entryFee,
    input.startMode,
    input.scheduledStartAt,
  )
  for (const profileId of input.profiles) {
    const entryId = randomUUID()
    database.prepare(`
      INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
      VALUES (?, ?, ?, NULL, 'solo', 'confirmed');
    `).run(entryId, input.tournamentId, profileId)
    database.prepare(`
      INSERT INTO tournament_economy_ledger (
        ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after
      ) VALUES (?, ?, ?, ?, 'entry_fee_debit', ?, ?);
    `).run(
      randomUUID(),
      `tournament:${input.tournamentId}:profile:${profileId}:entry-fee-debit`,
      input.tournamentId,
      profileId,
      input.entryFee,
      100_000 - input.entryFee,
    )
    database.prepare(`
      UPDATE profile_wallets
      SET yellow_coins_balance = yellow_coins_balance - ?
      WHERE profile_id = ?;
    `).run(input.entryFee, profileId)
  }
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

console.log('\ncheckTournamentSchedulerStart')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-scheduler-start-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let scheduler: Awaited<ReturnType<typeof createTournamentScheduler>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)

  for (const fee of [5_000, 10_000, 20_000, 50_000, 100_000]) {
    const preview = calculateTournamentPrizePreview(fee, 8)
    check(`financial preview integer-safe for ${fee}`, Number.isInteger(preview.systemFee) && Number.isInteger(preview.firstPlayerPrize))
    check(`financial preview balances for ${fee}`, preview.systemFee + preview.prizePool === preview.totalEntryFees)
    check(`prize preview balances for ${fee}`, preview.firstTeamPrize + preview.secondTeamPrize === preview.prizePool)
    check(`team/player split balances for ${fee}`, preview.firstPlayerPrize * 2 === preview.firstTeamPrize && preview.secondPlayerPrize * 2 === preview.secondTeamPrize)
  }

  const profiles = Array.from({ length: 24 }, (_, i) => randomUUID())
  profiles.forEach((profileId, index) => insertProfile(db, profileId, `Player ${index + 1}`, 100_000))

  economyStore = await createTournamentEconomyStore(dbPath)
  const fillTournamentId = randomUUID()
  insertReadyTournament(db, {
    tournamentId: fillTournamentId,
    creatorProfileId: profiles[0] as string,
    startMode: 'fill',
    scheduledStartAt: null,
    entryFee: 5_000,
    profiles: profiles.slice(0, 8),
  })
  const beforeStartBalances = profiles.slice(0, 8).map((profileId) =>
    (db.prepare(`SELECT yellow_coins_balance as balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { balance: number }).balance,
  )
  const startResult = economyStore.startTournamentAtomically(fillTournamentId, new Date('2026-07-30T10:00:00.000Z'))
  check('fill tournament with 8 confirmed starts', startResult.ok && !startResult.alreadyStarted)
  check('start writes exactly one system fee ledger', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, fillTournamentId) === 1)
  check('start locks exactly four teams', countRows(db, `SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ? AND status = 'locked';`, fillTournamentId) === 4)
  check('seed slots are unique 1-4', countRows(db, `SELECT COUNT(DISTINCT seed_slot) as count FROM tournament_teams WHERE tournament_id = ? AND status = 'locked';`, fillTournamentId) === 4)
  check('start creates semifinal skeletons only', countRows(db, `SELECT COUNT(*) as count FROM tournament_matches WHERE tournament_id = ? AND room_id IS NULL AND status = 'awaiting_players';`, fillTournamentId) === 2)
  check('start does not mutate wallets', profiles.slice(0, 8).every((profileId, index) => {
    const row = db.prepare(`SELECT yellow_coins_balance as balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { balance: number }
    return row.balance === beforeStartBalances[index]
  }))
  const retryStart = economyStore.startTournamentAtomically(fillTournamentId, new Date('2026-07-30T10:00:01.000Z'))
  check('repeated start is idempotent', retryStart.ok && retryStart.alreadyStarted && countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, fillTournamentId) === 1)

  const cancelTournamentId = randomUUID()
  insertReadyTournament(db, {
    tournamentId: cancelTournamentId,
    creatorProfileId: profiles[8] as string,
    startMode: 'scheduled',
    scheduledStartAt: '2026-07-30T09:00:00.000Z',
    entryFee: 10_000,
    profiles: profiles.slice(8, 15),
  })
  const cancelResult = economyStore.autoCancelScheduledTournamentAtomically(
    cancelTournamentId,
    new Date('2026-07-30T10:00:00.000Z'),
    'scheduled_start_not_ready',
  )
  check('scheduled not-ready tournament auto-cancels', cancelResult.ok && !cancelResult.alreadyCancelled)
  check('auto-cancel refunds all confirmed entries', countRows(db, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'refunded';`, cancelTournamentId) === 7)
  check('auto-cancel creates no system fee', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, cancelTournamentId) === 0)
  check('auto-cancel leaves no snapshot', (db.prepare(`SELECT financial_rules_version FROM tournaments WHERE tournament_id = ?;`).get(cancelTournamentId) as { financial_rules_version: string | null }).financial_rules_version === null)

  const scheduledTournamentId = randomUUID()
  insertReadyTournament(db, {
    tournamentId: scheduledTournamentId,
    creatorProfileId: profiles[15] as string,
    startMode: 'scheduled',
    scheduledStartAt: '2026-07-30T09:00:00.000Z',
    entryFee: 20_000,
    profiles: profiles.slice(16, 24),
  })
  scheduler = await createTournamentScheduler({
    databaseFilePath: dbPath,
    economyStore,
    now: () => new Date('2026-07-30T10:00:00.000Z'),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })
  scheduler.tickNow()
  const scheduledRow = db.prepare(`SELECT status, financial_rules_version FROM tournaments WHERE tournament_id = ?;`).get(scheduledTournamentId) as {
    status: string
    financial_rules_version: string | null
  }
  check('scheduler starts due ready scheduled tournament', scheduledRow.status === 'starting' && scheduledRow.financial_rules_version === 'v1_20_65_35')
  check('scheduler health records successful tick', scheduler.getHealth().lastSuccessAt !== null)
} finally {
  try { scheduler?.close() } catch {}
  try { economyStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentSchedulerStart failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentSchedulerStart passed: ${passed} checks`)
