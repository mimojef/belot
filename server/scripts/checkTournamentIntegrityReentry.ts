/**
 * checkTournamentIntegrityReentry.ts
 *
 * Targeted regression for analyzeTournamentIntegrity() (tournamentAdmin.ts)
 * incorrectly flagging a valid, correctly-settled tournament as
 * integrity-error after a legitimate debit -> refund -> re-entry lifecycle
 * (production incident: tournament 1b238da8-..., /health reported
 * integrityErrorCount:1 despite a correctly settled tournament).
 *
 * ROOT CAUSE: the check compared historical GROSS entry_fee_debit ledger
 * count/sum (ledgerCountSumStatement — sums EVERY debit row ever recorded
 * for the tournament) against CURRENT paid participant entries / the
 * financial snapshot. After a valid debit -> refund -> re-entry debit for
 * any participant, gross debit history naturally exceeds current paid
 * participation (10 debit rows for 8 current paid entries in the production
 * case) — a false positive, not a real mismatch.
 *
 * FIX: netPaidEntryDebitsStatement joins CURRENT paid tournament_entries
 * (confirmed/finalist/champion/eliminated) to the LATEST entry_fee_debit
 * ledger row per profile — mirroring the domain semantics already fixed in
 * tournamentEconomyStore.ts's settlement path (commit 8d537cf,
 * selectActiveEntriesWithLatestDebitLedgerStatement). A profile refunded
 * without re-entry is excluded (it's no longer a paid tournament_entries
 * row), and a re-entered profile correctly counts its newest debit, not the
 * refunded older one.
 *
 * Cases covered:
 *  A. Normal finished tournament: 8 debits, 0 refunds, 8 current paid
 *     entries -> healthy (no invalid_entry_debit_count/sum).
 *  B. Production re-entry shape: 10 debits / 50000, 2 refunds / 10000, 8
 *     current paid entries, total_entry_amount 40000 -> healthy.
 *  C. Refund without re-entry: refunded profile replaced by a new one who
 *     pays normally -> healthy (the refunded profile's stale debit must not
 *     count as an active paid entry).
 *  D. Genuine mismatch: financial snapshot deliberately drifted from the
 *     real net debit sum -> analyzer MUST still report an error (proves the
 *     fix doesn't just suppress the check to force green health).
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentAdminStore } from '../src/tournament/tournamentAdmin.js'

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

// Симулира debit -> refund -> re-entry debit history за профил (§ "LEDGER
// EVIDENCE" в production incident-а): 3 ledger реда, entries.status остава
// 'confirmed' (реалистичен leave+rejoin). Explicit created_at timestamps
// гарантират детерминистичен "latest debit" ordering.
function insertReentryLedgerHistory(
  database: DatabaseSync,
  tournamentId: string,
  profileId: string,
  entryFee: number,
): void {
  database.prepare(`
    INSERT INTO tournament_economy_ledger (
      ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after, created_at
    ) VALUES (?, ?, ?, ?, 'entry_fee_debit', ?, ?, '2026-07-30T09:00:00.000Z');
  `).run(randomUUID(), `tournament:${tournamentId}:profile:${profileId}:entry-fee-debit`, tournamentId, profileId, entryFee, 100_000 - entryFee)
  database.prepare(`
    INSERT INTO tournament_economy_ledger (
      ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after, created_at
    ) VALUES (?, ?, ?, ?, 'entry_fee_refund', ?, ?, '2026-07-30T09:05:00.000Z');
  `).run(randomUUID(), `tournament:${tournamentId}:profile:${profileId}:entry-fee-refund`, tournamentId, profileId, entryFee, 100_000)
  database.prepare(`
    INSERT INTO tournament_economy_ledger (
      ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after, created_at
    ) VALUES (?, ?, ?, ?, 'entry_fee_debit', ?, ?, '2026-07-30T09:10:00.000Z');
  `).run(randomUUID(), `tournament:${tournamentId}:profile:${profileId}:entry-fee-debit:attempt-2`, tournamentId, profileId, entryFee, 100_000 - entryFee)
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
  // status='confirmed' филтър тук е важен — в реалния settlement flow
  // единствените entries по време на bracket фазата ВИНАГИ са 'confirmed'
  // (startTournamentAtomically изисква точно player_capacity confirmed
  // entries), но сценарий C в този тест-файл нарочно вкарва допълнителен
  // 'refunded' entry directly чрез raw SQL ПРЕДИ да извика тази функция —
  // без филтъра, UPDATE-ът без WHERE status би презаписал и refunded
  // записа обратно на 'eliminated', давайки 9 paid entries вместо 8.
  database.prepare(`
    UPDATE tournament_entries
    SET status = CASE WHEN team_id = ? THEN 'champion' WHEN team_id = ? THEN 'finalist' ELSE 'eliminated' END
    WHERE tournament_id = ? AND status = 'confirmed';
  `).run(championTeamId, runnerUpTeamId, tournamentId)
  database.prepare(`
    UPDATE tournaments
    SET status = 'final_in_progress'
    WHERE tournament_id = ?;
  `).run(tournamentId)
  return { championTeamId, runnerUpTeamId }
}

console.log('\ncheckTournamentIntegrityReentry')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-integrity-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let adminStore: Awaited<ReturnType<typeof createTournamentAdminStore>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  economyStore = await createTournamentEconomyStore(dbPath)
  adminStore = await createTournamentAdminStore({
    databaseFilePath: dbPath,
    getPublicProfile: () => null,
  })

  // ---- Сценарий A: нормален finished турнир, 0 refunds ----
  const profilesA = Array.from({ length: 8 }, () => randomUUID())
  profilesA.forEach((profileId, index) => insertProfile(db!, profileId, `NormalPlayer${index}`, 100_000))
  const tournamentIdA = randomUUID()
  const feeA = 5_000
  insertReadyTournament(db, { tournamentId: tournamentIdA, creatorProfileId: profilesA[0]!, entryFee: feeA, profiles: profilesA })
  const startA = economyStore.startTournamentAtomically(tournamentIdA, new Date('2026-07-30T10:00:00.000Z'))
  check('[A] normal tournament starts', startA.ok)
  finishFinalForSettlement(db, tournamentIdA)
  const settleA = economyStore.settleTournamentPrizesAtomically(tournamentIdA, new Date('2026-07-30T12:01:00.000Z'))
  check('[A] normal tournament settles', settleA.ok)
  const reportA = adminStore.analyzeTournamentIntegrity(tournamentIdA)
  check('[A] normal finished tournament (8 debits, 0 refunds): integrity healthy', reportA.state === 'healthy')
  check('[A] no invalid_entry_debit_count', !reportA.issues.some((i) => i.code === 'invalid_entry_debit_count'))
  check('[A] no invalid_entry_debit_sum', !reportA.issues.some((i) => i.code === 'invalid_entry_debit_sum'))

  // ---- Сценарий B: production re-entry shape ----
  const profilesB = Array.from({ length: 8 }, () => randomUUID())
  profilesB.forEach((profileId, index) => insertProfile(db!, profileId, `ReentryPlayer${index}`, 100_000))
  const tournamentIdB = randomUUID()
  const feeB = 5_000
  insertReadyTournament(db, { tournamentId: tournamentIdB, creatorProfileId: profilesB[0]!, entryFee: feeB, profiles: profilesB.slice(2, 8) })
  for (const profileId of profilesB.slice(0, 2)) {
    db.prepare(`
      INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
      VALUES (?, ?, ?, NULL, 'solo', 'confirmed');
    `).run(randomUUID(), tournamentIdB, profileId)
    insertReentryLedgerHistory(db, tournamentIdB, profileId, feeB)
    db.prepare(`UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?;`).run(100_000 - feeB, profileId)
  }
  check(
    '[B] fixture has 10 gross debit rows and 2 refunds',
    (db.prepare(`SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_debit';`).get(tournamentIdB) as { count: number }).count === 10
      && (db.prepare(`SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`).get(tournamentIdB) as { count: number }).count === 2,
  )
  const startB = economyStore.startTournamentAtomically(tournamentIdB, new Date('2026-07-30T10:00:00.000Z'))
  check('[B] re-entry tournament starts despite historical debit/refund rows', startB.ok)
  finishFinalForSettlement(db, tournamentIdB)
  const settleB = economyStore.settleTournamentPrizesAtomically(tournamentIdB, new Date('2026-07-30T12:01:00.000Z'))
  check('[B] re-entry tournament settles (production settlement fix)', settleB.ok)
  const reportB = adminStore.analyzeTournamentIntegrity(tournamentIdB)
  check('[B] production re-entry shape (10 debits/50000, 2 refunds/10000, 8 current paid, net 40000): integrity healthy', reportB.state === 'healthy')
  check('[B] no invalid_entry_debit_count (false positive from prior bug)', !reportB.issues.some((i) => i.code === 'invalid_entry_debit_count'))
  check('[B] no invalid_entry_debit_sum (false positive from prior bug)', !reportB.issues.some((i) => i.code === 'invalid_entry_debit_sum'))

  // ---- Сценарий C: refund без re-entry, заменен от нов платил профил ----
  const profilesC = Array.from({ length: 8 }, () => randomUUID())
  profilesC.forEach((profileId, index) => insertProfile(db!, profileId, `NoReentryPlayer${index}`, 100_000))
  const refundedProfileC = randomUUID()
  insertProfile(db!, refundedProfileC, 'NoReentryRefunded', 100_000)
  const tournamentIdC = randomUUID()
  const feeC = 5_000
  insertReadyTournament(db, { tournamentId: tournamentIdC, creatorProfileId: profilesC[0]!, entryFee: feeC, profiles: profilesC })
  // refundedProfileC: debit -> refund, БЕЗ re-entry, entry остава 'refunded'.
  db.prepare(`
    INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status, refunded_at, withdrawn_at)
    VALUES (?, ?, ?, NULL, 'solo', 'refunded', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `).run(randomUUID(), tournamentIdC, refundedProfileC)
  db.prepare(`
    INSERT INTO tournament_economy_ledger (
      ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after
    ) VALUES (?, ?, ?, ?, 'entry_fee_debit', ?, ?);
  `).run(randomUUID(), `tournament:${tournamentIdC}:profile:${refundedProfileC}:entry-fee-debit`, tournamentIdC, refundedProfileC, feeC, 100_000 - feeC)
  db.prepare(`
    INSERT INTO tournament_economy_ledger (
      ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after
    ) VALUES (?, ?, ?, ?, 'entry_fee_refund', ?, ?);
  `).run(randomUUID(), `tournament:${tournamentIdC}:profile:${refundedProfileC}:entry-fee-refund`, tournamentIdC, refundedProfileC, feeC, 100_000)
  const startC = economyStore.startTournamentAtomically(tournamentIdC, new Date('2026-07-30T10:00:00.000Z'))
  check('[C] no-reentry tournament starts (refunded-without-reentry profile excluded)', startC.ok)
  finishFinalForSettlement(db, tournamentIdC)
  const settleC = economyStore.settleTournamentPrizesAtomically(tournamentIdC, new Date('2026-07-30T12:01:00.000Z'))
  check('[C] no-reentry tournament settles', settleC.ok)
  const reportC = adminStore.analyzeTournamentIntegrity(tournamentIdC)
  check('[C] refund-without-reentry profile does not break integrity: healthy', reportC.state === 'healthy')
  check('[C] no invalid_entry_debit_count', !reportC.issues.some((i) => i.code === 'invalid_entry_debit_count'))
  check('[C] no invalid_entry_debit_sum', !reportC.issues.some((i) => i.code === 'invalid_entry_debit_sum'))

  // ---- Сценарий D: истински mismatch (financial snapshot изкуствено разминат) ----
  const profilesD = Array.from({ length: 8 }, () => randomUUID())
  profilesD.forEach((profileId, index) => insertProfile(db!, profileId, `MismatchPlayer${index}`, 100_000))
  const tournamentIdD = randomUUID()
  const feeD = 5_000
  insertReadyTournament(db, { tournamentId: tournamentIdD, creatorProfileId: profilesD[0]!, entryFee: feeD, profiles: profilesD })
  const startD = economyStore.startTournamentAtomically(tournamentIdD, new Date('2026-07-30T10:00:00.000Z'))
  check('[D] mismatch fixture starts', startD.ok)
  finishFinalForSettlement(db, tournamentIdD)
  // Изкуствено разместваме total_entry_amount, за да симулираме реален
  // финансов mismatch (не свързан с re-entry lifecycle) — analyzer-ът трябва
  // ОЩЕ да го хване, доказвайки че fix-ът не е обезсилил проверката.
  db.prepare(`UPDATE tournaments SET total_entry_amount = total_entry_amount + 12345 WHERE tournament_id = ?;`).run(tournamentIdD)
  const reportD = adminStore.analyzeTournamentIntegrity(tournamentIdD)
  check('[D] genuine financial snapshot mismatch is still caught as an error', reportD.state === 'error')
  check('[D] invalid_entry_debit_sum fires for the genuine mismatch', reportD.issues.some((i) => i.code === 'invalid_entry_debit_sum'))

  // ---- Сценарий E: missing debit corruption (8 paid entries, 1 без ledger) ----
  // Регресия за LEFT JOIN COUNT(*) bug — с COUNT(*), 8 tournament_entries
  // редове (дори когато tel е NULL за един от тях) биха дали count=8,
  // маскирайки реална липса на debit ledger запис за профила. COUNT(tel.ledger_id)
  // брои само редовете с реално намерен debit — трябва да даде count=7 != 8
  // paid participant entries, откривайки корупцията.
  const profilesE = Array.from({ length: 8 }, () => randomUUID())
  profilesE.forEach((profileId, index) => insertProfile(db!, profileId, `MissingDebitPlayer${index}`, 100_000))
  const tournamentIdE = randomUUID()
  const feeE = 5_000
  insertReadyTournament(db, { tournamentId: tournamentIdE, creatorProfileId: profilesE[0]!, entryFee: feeE, profiles: profilesE })
  const startE = economyStore.startTournamentAtomically(tournamentIdE, new Date('2026-07-30T10:00:00.000Z'))
  check('[E] missing-debit fixture starts', startE.ok)
  finishFinalForSettlement(db, tournamentIdE)
  // Изкуствено премахваме debit ledger реда за един paid участник, симулирайки
  // истинска корупция (не re-entry lifecycle) — entry остава 'eliminated'/
  // 'finalist'/'champion' (still a paid participant), но няма никакъв
  // entry_fee_debit запис за него.
  db.prepare(`
    DELETE FROM tournament_economy_ledger
    WHERE tournament_id = ? AND profile_id = ? AND entry_type = 'entry_fee_debit';
  `).run(tournamentIdE, profilesE[1])
  const reportE = adminStore.analyzeTournamentIntegrity(tournamentIdE)
  check('[E] missing debit for a current paid participant is caught as an error', reportE.state === 'error')
  check('[E] invalid_entry_debit_count fires for the missing debit', reportE.issues.some((i) => i.code === 'invalid_entry_debit_count'))
} finally {
  try { economyStore?.close() } catch {}
  try { adminStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentIntegrityReentry failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentIntegrityReentry passed: ${passed} checks`)
