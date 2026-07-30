import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
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
  entryFee: number
  profiles: string[]
}): void {
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status
    ) VALUES (?, 'community', ?, ?, 'public', NULL, ?, 8, 'fill', NULL, 'open');
  `).run(input.tournamentId, `Tournament ${input.tournamentId.slice(0, 8)}`, input.creatorProfileId, input.entryFee)

  for (const profileId of input.profiles) {
    database.prepare(`
      INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
      VALUES (?, ?, ?, NULL, 'solo', 'confirmed');
    `).run(randomUUID(), input.tournamentId, profileId)
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

function walletBalance(database: DatabaseSync, profileId: string): number {
  return (database.prepare(`
    SELECT yellow_coins_balance as balance
    FROM profile_wallets
    WHERE profile_id = ?;
  `).get(profileId) as { balance: number }).balance
}

function finishFinalForSettlement(database: DatabaseSync, tournamentId: string): { championTeamId: string; runnerUpTeamId: string } {
  const teams = database.prepare(`
    SELECT team_id as teamId
    FROM tournament_teams
    WHERE tournament_id = ?
    ORDER BY seed_slot ASC;
  `).all(tournamentId) as Array<{ teamId: string }>
  const championTeamId = teams[0]!.teamId
  const runnerUpTeamId = teams[1]!.teamId
  const roundId = randomUUID()
  const matchId = randomUUID()
  database.prepare(`
    INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index)
    VALUES (?, ?, 'final', 1);
  `).run(roundId, tournamentId)
  database.prepare(`
    INSERT INTO tournament_matches (
      match_id, tournament_id, round_id, room_id, team_a_id, team_b_id,
      status, winner_team_id, result_kind, completed_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'completed', ?, 'played_with_bots', ?);
  `).run(matchId, tournamentId, roundId, championTeamId, runnerUpTeamId, championTeamId, '2026-07-30T12:00:00.000Z')
  database.prepare(`
    UPDATE tournament_teams
    SET status = CASE WHEN team_id = ? THEN 'champion' WHEN team_id = ? THEN 'finalist' ELSE 'eliminated' END
    WHERE tournament_id = ?;
  `).run(championTeamId, runnerUpTeamId, tournamentId)
  database.prepare(`
    UPDATE tournament_entries
    SET status = CASE WHEN team_id = ? THEN 'champion' WHEN team_id = ? THEN 'finalist' ELSE 'eliminated' END
    WHERE tournament_id = ?;
  `).run(championTeamId, runnerUpTeamId, tournamentId)
  database.prepare(`
    UPDATE tournaments
    SET status = 'final_in_progress'
    WHERE tournament_id = ?;
  `).run(tournamentId)
  return { championTeamId, runnerUpTeamId }
}

console.log('\ncheckTournamentSettlementBehavior')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-settlement-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  economyStore = await createTournamentEconomyStore(dbPath)

  for (const fee of [5_000, 10_000, 20_000, 50_000, 100_000]) {
    const preview = calculateTournamentPrizePreview(fee, 8)
    check(`snapshot math balances for fee ${fee}`, preview.systemFee + preview.firstTeamPrize + preview.secondTeamPrize === preview.totalEntryFees)
    check(`winner players split exactly for fee ${fee}`, preview.firstPlayerPrize * 2 === preview.firstTeamPrize)
    check(`runner-up players split exactly for fee ${fee}`, preview.secondPlayerPrize * 2 === preview.secondTeamPrize)
    check(`prize pool split exactly for fee ${fee}`, preview.firstTeamPrize + preview.secondTeamPrize === preview.prizePool)
  }

  const profiles = Array.from({ length: 16 }, () => randomUUID())
  profiles.forEach((profileId, index) => insertProfile(db!, profileId, `Settlement Player ${index + 1}`, 100_000))

  const tournamentId = randomUUID()
  insertReadyTournament(db, {
    tournamentId,
    creatorProfileId: profiles[0]!,
    entryFee: 10_000,
    profiles: profiles.slice(0, 8),
  })
  const start = economyStore.startTournamentAtomically(tournamentId, new Date('2026-07-30T10:00:00.000Z'))
  check('tournament start persisted financial snapshot', start.ok && start.tournament?.financialRulesVersion === 'v1_20_65_35')
  const { championTeamId, runnerUpTeamId } = finishFinalForSettlement(db, tournamentId)
  const championProfiles = db.prepare(`SELECT profile_id as profileId FROM tournament_entries WHERE team_id = ? ORDER BY created_at ASC;`).all(championTeamId) as Array<{ profileId: string }>
  const runnerUpProfiles = db.prepare(`SELECT profile_id as profileId FROM tournament_entries WHERE team_id = ? ORDER BY created_at ASC;`).all(runnerUpTeamId) as Array<{ profileId: string }>
  const balancesBefore = new Map(profiles.slice(0, 8).map((profileId) => [profileId, walletBalance(db!, profileId)]))
  const preview = calculateTournamentPrizePreview(10_000, 8)

  const settlement = economyStore.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:01:00.000Z'))
  check('settlement succeeds once final is completed', settlement.ok && settlement.payoutRows === 4)
  const settled = db.prepare(`
    SELECT status, settlement_state as settlementState, champion_team_id as championTeamId,
           runner_up_team_id as runnerUpTeamId, settled_at as settledAt, finished_at as finishedAt
    FROM tournaments
    WHERE tournament_id = ?;
  `).get(tournamentId) as {
    status: string
    settlementState: string
    championTeamId: string | null
    runnerUpTeamId: string | null
    settledAt: string | null
    finishedAt: string | null
  }
  check('settlement finishes tournament lifecycle', settled.status === 'finished' && settled.settlementState === 'settled' && settled.settledAt !== null && settled.finishedAt !== null)
  check('settlement persists champion and runner-up', settled.championTeamId === championTeamId && settled.runnerUpTeamId === runnerUpTeamId)
  check('settlement creates four prize payout ledger rows', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId) === 4)
  check('settlement records one settlement event', countRows(db, `SELECT COUNT(*) as count FROM tournament_events WHERE tournament_id = ? AND event_type = 'tournament_prizes_settled';`, tournamentId) === 1)
  check('champion wallets receive player prize only', championProfiles.every((row) => walletBalance(db!, row.profileId) === balancesBefore.get(row.profileId)! + preview.firstPlayerPrize))
  check('runner-up wallets receive player prize only', runnerUpProfiles.every((row) => walletBalance(db!, row.profileId) === balancesBefore.get(row.profileId)! + preview.secondPlayerPrize))
  check('eliminated wallets receive no prize', profiles.slice(0, 8).filter((profileId) => !championProfiles.some((row) => row.profileId === profileId) && !runnerUpProfiles.some((row) => row.profileId === profileId)).every((profileId) => walletBalance(db!, profileId) === balancesBefore.get(profileId)))
  const prizeSum = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM tournament_economy_ledger
    WHERE tournament_id = ? AND entry_type = 'prize_payout';
  `).get(tournamentId) as { total: number }).total
  check('settlement pays the full persisted prize pool', prizeSum === preview.prizePool)

  const retryBalances = new Map(profiles.slice(0, 8).map((profileId) => [profileId, walletBalance(db!, profileId)]))
  const retry = economyStore.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:02:00.000Z'))
  check('settlement retry is idempotent', retry.ok && retry.alreadySettled === true)
  check('settlement retry does not duplicate ledger rows', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, tournamentId) === 4)
  check('settlement retry does not mutate wallets', profiles.slice(0, 8).every((profileId) => walletBalance(db!, profileId) === retryBalances.get(profileId)))

  const badTournamentId = randomUUID()
  insertReadyTournament(db, {
    tournamentId: badTournamentId,
    creatorProfileId: profiles[8]!,
    entryFee: 20_000,
    profiles: profiles.slice(8, 16),
  })
  const badStart = economyStore.startTournamentAtomically(badTournamentId, new Date('2026-07-30T11:00:00.000Z'))
  check('bad snapshot fixture starts', badStart.ok)
  finishFinalForSettlement(db, badTournamentId)
  const badBalancesBefore = new Map(profiles.slice(8, 16).map((profileId) => [profileId, walletBalance(db!, profileId)]))
  db.prepare(`
    UPDATE tournaments
    SET winner_player_prize_amount = winner_player_prize_amount + 1
    WHERE tournament_id = ?;
  `).run(badTournamentId)
  const badSettlement = economyStore.settleTournamentPrizesAtomically(badTournamentId, new Date('2026-07-30T12:03:00.000Z'))
  check('settlement rejects drifted financial snapshot', !badSettlement.ok)
  check('failed settlement rolls back prize payouts', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, badTournamentId) === 0)
  check('failed settlement leaves wallets unchanged', profiles.slice(8, 16).every((profileId) => walletBalance(db!, profileId) === badBalancesBefore.get(profileId)))
  const badRow = db.prepare(`SELECT status, settlement_state as settlementState FROM tournaments WHERE tournament_id = ?;`).get(badTournamentId) as { status: string; settlementState: string }
  check('failed settlement does not finish tournament', badRow.status === 'final_in_progress' && badRow.settlementState === 'pending')
} finally {
  try { economyStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentSettlementBehavior failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentSettlementBehavior passed: ${passed} checks`)
