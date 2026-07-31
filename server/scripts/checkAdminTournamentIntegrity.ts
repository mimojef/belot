import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
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

function insertProfile(database: DatabaseSync, profileId: string, displayName: string, balance = 100_000): void {
  database.prepare(`
    INSERT INTO profiles (profile_id, display_name, normalized_display_name)
    VALUES (?, ?, ?);
  `).run(profileId, displayName, displayName.toLowerCase())
  database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, ?);
  `).run(profileId, balance)
}

function getBalance(database: DatabaseSync, profileId: string): number {
  return (database.prepare(`
    SELECT yellow_coins_balance AS balance
    FROM profile_wallets
    WHERE profile_id = ?;
  `).get(profileId) as { balance: number }).balance
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

function insertOpenTournament(database: DatabaseSync, input: {
  tournamentId: string
  creatorProfileId: string
  participantProfileIds: string[]
  entryFee?: number
}): void {
  const entryFee = input.entryFee ?? 10_000
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status
    ) VALUES (?, 'community', ?, ?, 'public', NULL, ?, 8, 'fill', NULL, 'open');
  `).run(input.tournamentId, `Admin smoke ${input.tournamentId.slice(0, 8)}`, input.creatorProfileId, entryFee)

  for (const profileId of input.participantProfileIds) {
    database.prepare(`
      INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
      VALUES (?, ?, ?, NULL, 'solo', 'confirmed');
    `).run(randomUUID(), input.tournamentId, profileId)
    database.prepare(`
      UPDATE profile_wallets
      SET yellow_coins_balance = yellow_coins_balance - ?, updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ?;
    `).run(entryFee, profileId)
    database.prepare(`
      INSERT INTO tournament_economy_ledger (
        ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after
      ) VALUES (?, ?, ?, ?, 'entry_fee_debit', ?, ?);
    `).run(
      randomUUID(),
      `tournament:${input.tournamentId}:profile:${profileId}:entry-fee-debit`,
      input.tournamentId,
      profileId,
      entryFee,
      getBalance(database, profileId),
    )
  }
}

function insertStartedTournament(database: DatabaseSync, input: {
  tournamentId: string
  creatorProfileId: string
  status: 'starting' | 'semifinal_in_progress' | 'final_in_progress' | 'finished'
  participantProfileIds: string[]
  withFinancialSnapshot?: boolean
  settled?: boolean
}): { teamIds: string[]; semifinalRoundId: string; finalRoundId: string } {
  const entryFee = 10_000
  const totalEntry = 80_000
  const systemFee = 16_000
  const prizePool = 64_000
  const winnerTeamPrize = 41_600
  const runnerUpTeamPrize = 22_400
  const winnerPlayerPrize = 20_800
  const runnerUpPlayerPrize = 11_200
  const settled = input.settled === true

  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status,
      started_at, finished_at, settlement_state, settled_at,
      total_entry_amount, system_fee_percent, system_fee_amount, prize_pool_amount,
      winner_share_percent, runner_up_share_percent,
      winner_team_prize_amount, runner_up_team_prize_amount,
      winner_player_prize_amount, runner_up_player_prize_amount, financial_rules_version
    ) VALUES (
      ?, 'community', ?, ?, 'public', NULL,
      ?, 8, 'fill', NULL, ?,
      '2026-07-30T10:00:00.000Z', ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    );
  `).run(
    input.tournamentId,
    `Started smoke ${input.tournamentId.slice(0, 8)}`,
    input.creatorProfileId,
    entryFee,
    input.status,
    input.status === 'finished' ? '2026-07-30T12:00:00.000Z' : null,
    settled ? 'settled' : 'pending',
    settled ? '2026-07-30T12:01:00.000Z' : null,
    input.withFinancialSnapshot === false ? null : totalEntry,
    input.withFinancialSnapshot === false ? null : 20,
    input.withFinancialSnapshot === false ? null : systemFee,
    input.withFinancialSnapshot === false ? null : prizePool,
    input.withFinancialSnapshot === false ? null : 65,
    input.withFinancialSnapshot === false ? null : 35,
    input.withFinancialSnapshot === false ? null : winnerTeamPrize,
    input.withFinancialSnapshot === false ? null : runnerUpTeamPrize,
    input.withFinancialSnapshot === false ? null : winnerPlayerPrize,
    input.withFinancialSnapshot === false ? null : runnerUpPlayerPrize,
    input.withFinancialSnapshot === false ? null : 'v1_20_65_35',
  )

  const teamIds = Array.from({ length: 4 }, () => randomUUID())
  teamIds.forEach((teamId, index) => {
    database.prepare(`
      INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot)
      VALUES (?, ?, ?, ?);
    `).run(
      teamId,
      input.tournamentId,
      index === 0 && settled ? 'champion' : index === 1 && settled ? 'finalist' : 'locked',
      index + 1,
    )
  })

  input.participantProfileIds.forEach((profileId, index) => {
    const teamId = teamIds[Math.floor(index / 2)]!
    const status = settled && index < 2 ? 'champion' : settled && index < 4 ? 'finalist' : 'eliminated'
    database.prepare(`
      INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
      VALUES (?, ?, ?, ?, 'solo', ?);
    `).run(randomUUID(), input.tournamentId, profileId, teamId, status)
    database.prepare(`
      INSERT INTO tournament_economy_ledger (
        ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after
      ) VALUES (?, ?, ?, ?, 'entry_fee_debit', ?, ?);
    `).run(
      randomUUID(),
      `tournament:${input.tournamentId}:profile:${profileId}:entry-fee-debit`,
      input.tournamentId,
      profileId,
      entryFee,
      90_000,
    )
  })

  if (input.withFinancialSnapshot !== false) {
    database.prepare(`
      INSERT INTO tournament_economy_ledger (
        ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after
      ) VALUES (?, ?, ?, NULL, 'system_fee', ?, NULL);
    `).run(randomUUID(), `tournament:${input.tournamentId}:system-fee`, input.tournamentId, systemFee)
  }

  const semifinalRoundId = randomUUID()
  const finalRoundId = randomUUID()
  database.prepare(`
    INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index)
    VALUES (?, ?, 'semifinal', 1);
  `).run(semifinalRoundId, input.tournamentId)
  database.prepare(`
    INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index)
    VALUES (?, ?, 'final', 1);
  `).run(finalRoundId, input.tournamentId)
  return { teamIds, semifinalRoundId, finalRoundId }
}

console.log('\ncheckAdminTournamentIntegrity')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-admin-tournament-integrity-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let adminStore: Awaited<ReturnType<typeof createTournamentAdminStore>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)

  const profileIds = Array.from({ length: 24 }, () => randomUUID())
  profileIds.forEach((profileId, index) => insertProfile(db!, profileId, `Admin Tournament ${index + 1}`))
  adminStore = await createTournamentAdminStore({
    databaseFilePath: dbPath,
    getPublicProfile: (profileId) => ({
      profileId,
      displayName: `Profile ${profileId.slice(0, 8)}`,
      avatarUrl: null,
      level: 1,
      rankTitle: null,
      skillRating: 1000,
      completedGamesCount: 0,
      wonGamesCount: 0,
      currentRankGames: 0,
      nextRankGames: 10,
      gamesUntilNextRank: 10,
      rankProgressRatio: 0,
      averageRating: 0,
      totalRatingsCount: 0,
      yellowCoinsBalance: 0,
      galleryImages: [],
      gender: null,
      likesCount: 0,
      hasLikedByMe: null,
      isBlockedByMe: null,
    }),
    runCoordinatorTick: () => {},
  })

  const openTournamentId = randomUUID()
  insertOpenTournament(db, {
    tournamentId: openTournamentId,
    creatorProfileId: profileIds[0]!,
    participantProfileIds: profileIds.slice(0, 2),
  })

  await check('open tournament analyzes as healthy before admin cancel', () => {
    const report = adminStore!.analyzeTournamentIntegrity(openTournamentId)
    assert(report.state === 'healthy', `state=${report.state}, issues=${JSON.stringify(report.issues)}`)
  })

  await check('cancel-open refunds entries atomically and records audit event', () => {
    const result = adminStore!.cancelOpenTournament(openTournamentId, profileIds[0]!)
    assert(result.ok === true && result.refundedEntries === 2 && result.totalRefunded === 20_000, JSON.stringify(result))
    assert(getBalance(db!, profileIds[0]!) === 100_000, 'creator balance was not refunded')
    assert(getBalance(db!, profileIds[1]!) === 100_000, 'participant balance was not refunded')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`, openTournamentId) === 2, 'refund ledger mismatch')
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_events WHERE tournament_id = ? AND event_type = 'admin_tournament_cancel_open';`, openTournamentId) === 1, 'admin audit event missing')
  })

  await check('cancel-open retry is idempotent and creates no second refund', () => {
    const result = adminStore!.cancelOpenTournament(openTournamentId, profileIds[0]!)
    assert(result.ok === true && result.alreadyCancelled === true, JSON.stringify(result))
    assert(countRows(db!, `SELECT COUNT(*) AS count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`, openTournamentId) === 2, 'duplicate refund rows')
  })

  const missingSnapshotId = randomUUID()
  insertStartedTournament(db, {
    tournamentId: missingSnapshotId,
    creatorProfileId: profileIds[2]!,
    participantProfileIds: profileIds.slice(2, 10),
    status: 'semifinal_in_progress',
    withFinancialSnapshot: false,
  })
  await check('analyzer reports missing financial snapshot as an error', () => {
    const report = adminStore!.analyzeTournamentIntegrity(missingSnapshotId)
    assert(report.state === 'error', `state=${report.state}`)
    assert(report.issues.some((issue) => issue.code === 'missing_financial_snapshot'), JSON.stringify(report.issues))
  })

  const badMatchId = randomUUID()
  const badMatchFixture = insertStartedTournament(db, {
    tournamentId: badMatchId,
    creatorProfileId: profileIds[10]!,
    participantProfileIds: profileIds.slice(10, 18),
    status: 'semifinal_in_progress',
  })
  db.prepare(`
    INSERT INTO tournament_matches (
      match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status, winner_team_id,
      result_kind, attendance_resolution_kind, completed_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'completed', NULL, 'played_with_bots', 'all_present', ?);
  `).run(
    randomUUID(),
    badMatchId,
    badMatchFixture.semifinalRoundId,
    badMatchFixture.teamIds[0],
    badMatchFixture.teamIds[1],
    '2026-07-30T11:00:00.000Z',
  )
  await check('analyzer reports completed match without winner', () => {
    const report = adminStore!.analyzeTournamentIntegrity(badMatchId)
    assert(report.issues.some((issue) => issue.code === 'completed_match_without_winner'), JSON.stringify(report.issues))
  })

  const finishedId = randomUUID()
  const finishedFixture = insertStartedTournament(db, {
    tournamentId: finishedId,
    creatorProfileId: profileIds[18]!,
    participantProfileIds: profileIds.slice(16, 24),
    status: 'finished',
    settled: false,
  })
  db.prepare(`
    INSERT INTO tournament_matches (
      match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status, winner_team_id,
      result_kind, attendance_resolution_kind, completed_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'completed', ?, 'played_with_bots', 'all_present', ?);
  `).run(
    randomUUID(),
    finishedId,
    finishedFixture.finalRoundId,
    finishedFixture.teamIds[0],
    finishedFixture.teamIds[1],
    finishedFixture.teamIds[0],
    '2026-07-30T12:00:00.000Z',
  )
  await check('finished pending-settlement tournament does not get a false snapshot error', () => {
    const report = adminStore!.analyzeTournamentIntegrity(finishedId)
    assert(report.issues.some((issue) => issue.code === 'finished_without_settlement'), JSON.stringify(report.issues))
    assert(!report.issues.some((issue) => issue.code === 'invalid_financial_snapshot'), JSON.stringify(report.issues))
  })

  await check('health snapshot returns bounded aggregate fields only', () => {
    const health = adminStore!.getHealthSnapshot()
    const raw = JSON.stringify(health)
    assert(typeof health.activeTournamentCount === 'number', 'missing active count')
    assert(!raw.includes(openTournamentId) && !raw.includes(profileIds[0]!), 'health leaked identifiers')
  })
} finally {
  adminStore?.close()
  db?.close()
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`checkAdminTournamentIntegrity failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkAdminTournamentIntegrity passed: ${passed} checks.`)
