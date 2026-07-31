/**
 * Behavior test за 1-часовия auto-expiry на "При запълване" турнири
 * (fill_expires_at, виж migration 20260731_001). Ползва fake/injectable
 * clock (economyStore.now / scheduler.now) — не чака реален час.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { renderTournamentDetailScreen } from '../../src/app/lobby/renderTournamentsScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'
import type {
  TournamentDetailSnapshot,
  TournamentSummarySnapshot,
} from '../../src/app/network/createGameServerClient.js'

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
    INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind, status)
    VALUES (?, ?, ?, ?, 'human', 'active');
  `).run(profileId, profileId, name, name.toLowerCase())
  database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, ?);
  `).run(profileId, balance)
}

function insertFriendship(database: DatabaseSync, profileA: string, profileB: string): void {
  const [lower, higher] = [profileA, profileB].sort()
  database.prepare(`
    INSERT INTO profile_friendships (
      friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at
    ) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP);
  `).run(randomUUID(), profileA, profileB, lower, higher)
}

function getWalletBalance(database: DatabaseSync, profileId: string): number {
  return (database.prepare(`SELECT yellow_coins_balance as balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { balance: number }).balance
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

function getTournamentRow(database: DatabaseSync, tournamentId: string): {
  status: string
  cancel_reason: string | null
  fill_expires_at: string | null
  created_at: string
  start_mode: string
} {
  return database.prepare(`
    SELECT status, cancel_reason, fill_expires_at, created_at, start_mode
    FROM tournaments WHERE tournament_id = ?;
  `).get(tournamentId) as {
    status: string
    cancel_reason: string | null
    fill_expires_at: string | null
    created_at: string
    start_mode: string
  }
}

// Seeds directly through tournamentStore.createTournament (exercises the real
// server-computed fill_expires_at INSERT expression), then optionally
// backdates created_at/fill_expires_at via raw SQL for time-travel scenarios
// (tests must not wait a real hour).
async function createFillTournament(
  tournamentStore: Awaited<ReturnType<typeof createTournamentStore>>,
  database: DatabaseSync,
  creatorProfileId: string,
  entryFee: number,
  createdAtOverride?: string,
): Promise<string> {
  const result = tournamentStore.createTournament({
    name: `Fill ${randomUUID().slice(0, 8)}`,
    creatorProfileId,
    visibility: 'public',
    entryFee,
    startMode: 'fill',
  })
  if (!result.ok) throw new Error(`seed tournament creation failed: ${result.reason}`)
  const tournamentId = result.tournament.tournamentId
  if (createdAtOverride) {
    database.prepare(`
      UPDATE tournaments
      SET created_at = ?, fill_expires_at = datetime(?, '+1 hours')
      WHERE tournament_id = ?;
    `).run(createdAtOverride, createdAtOverride, tournamentId)
  }
  return tournamentId
}

console.log('\ncheckTournamentFillExpiry')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-fill-expiry-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null
let scheduler: Awaited<ReturnType<typeof createTournamentScheduler>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)

  // Each scenario below that reaches 'confirmed' and is never left/refunded
  // permanently consumes its participants (idx_tournament_entries_one_active_per_profile
  // allows only one active tournament per profile globally). A pool allocator
  // guarantees every scenario gets fresh, never-reused profile IDs, regardless
  // of how many scenarios are added/reordered later.
  const profiles = Array.from({ length: 80 }, () => randomUUID())
  profiles.forEach((profileId, index) => insertProfile(db as DatabaseSync, profileId, `Player ${index + 1}`, 100_000))
  for (let i = 0; i < profiles.length; i += 1) {
    for (let j = i + 1; j < profiles.length; j += 1) {
      insertFriendship(db as DatabaseSync, profiles[i] as string, profiles[j] as string)
    }
  }
  let nextProfileIndex = 0
  function allocProfiles(count: number): string[] {
    if (nextProfileIndex + count > profiles.length) {
      throw new Error(`profile pool exhausted: need ${count} more, only ${profiles.length - nextProfileIndex} left`)
    }
    const slice = profiles.slice(nextProfileIndex, nextProfileIndex + count) as string[]
    nextProfileIndex += count
    return slice
  }

  economyStore = await createTournamentEconomyStore(dbPath)
  tournamentStore = await createTournamentStore(dbPath)

  // ── A. Creation ──
  const nowForCreate = new Date('2026-07-31T10:00:00.000Z')
  const [creationCreator, scheduledCreator] = allocProfiles(2)
  const createResult = tournamentStore.createTournament({
    name: 'Creation Check',
    creatorProfileId: creationCreator,
    visibility: 'public',
    entryFee: 5_000,
    startMode: 'fill',
  })
  check('[1] fill tournament creation succeeds', createResult.ok)
  if (createResult.ok) {
    const row = getTournamentRow(db, createResult.tournament.tournamentId)
    check('[1b] fill tournament gets persisted fill_expires_at', row.fill_expires_at !== null)
    const createdMs = new Date(`${row.created_at.replace(' ', 'T')}Z`).getTime()
    const expiresMs = new Date(`${(row.fill_expires_at ?? '').replace(' ', 'T')}Z`).getTime()
    check('[2] expiry is exactly created_at + 60 minutes', Math.abs((expiresMs - createdMs) - 60 * 60 * 1000) < 1000)
    check('[3] CreateTournamentInput has no client-settable expiry field', createResult.tournament.fillExpiresAt !== undefined)
  }

  const scheduledResult = tournamentStore.createTournament({
    name: 'Scheduled Check',
    creatorProfileId: scheduledCreator,
    visibility: 'public',
    entryFee: 5_000,
    startMode: 'scheduled',
    scheduledStartAt: new Date(nowForCreate.getTime() + 3_600_000).toISOString(),
  })
  check('[4] scheduled tournament creation succeeds', scheduledResult.ok)
  if (scheduledResult.ok) {
    check('[4b] scheduled tournament has NO fill_expires_at', scheduledResult.tournament.fillExpiresAt === null)
  }

  // "Restart" simulation: reopen the store against the same DB file and re-read.
  const reopenedStore = await createTournamentStore(dbPath)
  try {
    if (createResult.ok) {
      const reread = reopenedStore.getTournamentById(createResult.tournament.tournamentId)
      check('[5] restart (store re-open) does not change fill_expires_at', reread?.fillExpiresAt === createResult.tournament.fillExpiresAt)
    }
  } finally {
    reopenedStore.close()
  }

  // ── B. Before expiry ──
  const farFuture = new Date('2026-07-31T09:00:00.000Z') // 1h before expiry margin
  const [beforeExpiryCreator, beforeExpirySoloJoiner, beforeExpiryInviter, beforeExpiryInvitee] = allocProfiles(4)
  const beforeExpiryTournamentId = await createFillTournament(tournamentStore, db, beforeExpiryCreator, 5_000, farFuture.toISOString())
  const soloJoinBefore = economyStore.joinTournamentSoloAtomically(
    beforeExpiryTournamentId,
    beforeExpirySoloJoiner,
    { now: new Date(farFuture.getTime() + 60_000) },
  )
  check('[7] solo join before expiry succeeds', soloJoinBefore.ok)

  const inviteBefore = economyStore.createPartnerInviteAtomically(
    beforeExpiryTournamentId,
    beforeExpiryInviter,
    beforeExpiryInvitee,
    { now: new Date(farFuture.getTime() + 120_000) },
  )
  check('[8] partner invite before expiry succeeds', inviteBefore.ok)
  if (inviteBefore.ok) {
    const balanceBefore = getWalletBalance(db, beforeExpiryInvitee)
    const acceptBefore = economyStore.acceptPartnerInviteAtomically(
      beforeExpiryTournamentId,
      inviteBefore.invite.inviteId,
      beforeExpiryInvitee,
      new Date(farFuture.getTime() + 180_000),
    )
    check('[9] partner accept before expiry succeeds', acceptBefore.ok)
    check('[10] wallet debited exactly once for invitee', getWalletBalance(db, beforeExpiryInvitee) === balanceBefore - 5_000)
  }
  check('[11] underfilled tournament not auto-cancelled before deadline', getTournamentRow(db, beforeExpiryTournamentId).status === 'open')

  // 8 confirmed -> starts before deadline.
  const readyBeforeExpiryProfiles = allocProfiles(8)
  const readyBeforeExpiryId = await createFillTournament(tournamentStore, db, readyBeforeExpiryProfiles[0] as string, 5_000, farFuture.toISOString())
  for (const profileId of readyBeforeExpiryProfiles) {
    const r = economyStore.joinTournamentSoloAtomically(readyBeforeExpiryId, profileId, { now: new Date(farFuture.getTime() + 10_000) })
    if (!r.ok) throw new Error(`seed join failed: ${r.reason}`)
  }
  const startResult = economyStore.startTournamentAtomically(readyBeforeExpiryId, new Date(farFuture.getTime() + 20_000))
  check('[12] full tournament starts before the 1h deadline', startResult.ok && !startResult.alreadyStarted)

  // Started tournament must never be retroactively cancelled by its original fill deadline.
  scheduler = await createTournamentScheduler({
    databaseFilePath: dbPath,
    economyStore,
    now: () => new Date(farFuture.getTime() + 2 * 3_600_000),
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })
  scheduler.tickNow()
  check('[13] started tournament is not cancelled by a later scheduler tick past its old fill deadline', getTournamentRow(db, readyBeforeExpiryId).status === 'starting')
  scheduler.close()
  scheduler = null

  // ── C. At/after expiry ──
  const pastDeadline = new Date('2026-07-31T05:00:00.000Z')
  const joinedProfiles = allocProfiles(3) // creator + 2 more, 3/8, underfilled
  const expiredUnderfilledId = await createFillTournament(tournamentStore, db, joinedProfiles[0] as string, 5_000, pastDeadline.toISOString())
  for (const profileId of joinedProfiles.slice(1)) {
    const r = economyStore.joinTournamentSoloAtomically(expiredUnderfilledId, profileId, { now: new Date(pastDeadline.getTime() + 60_000) })
    if (!r.ok) throw new Error(`seed join failed: ${r.reason}`)
  }
  const soloJoinCreator = economyStore.joinTournamentSoloAtomically(expiredUnderfilledId, joinedProfiles[0] as string, { now: new Date(pastDeadline.getTime() + 60_000) })
  if (!soloJoinCreator.ok) throw new Error(`seed creator join failed: ${soloJoinCreator.reason}`)

  const balancesBeforeCancel = joinedProfiles.map((p) => getWalletBalance(db as DatabaseSync, p))
  const tickTime = new Date(pastDeadline.getTime() + 65 * 60 * 1000) // 65 minutes after created_at
  const cancelResult = economyStore.autoCancelScheduledTournamentAtomically(expiredUnderfilledId, tickTime, 'fill_mode_expired')
  check('[14] underfilled open tournament past deadline becomes auto_cancelled', cancelResult.ok && !cancelResult.alreadyCancelled)
  check('[15] reason is fill_mode_expired', getTournamentRow(db, expiredUnderfilledId).cancel_reason === 'fill_mode_expired')
  check('[16] all active paid entries refunded', countRows(db, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'refunded';`, expiredUnderfilledId) === joinedProfiles.length)
  check('[16b] refund credits are correct per participant', joinedProfiles.every((p, i) => getWalletBalance(db as DatabaseSync, p) === (balancesBeforeCancel[i] as number) + 5_000))
  check('[19] reservations released (0 pending)', economyStore.countReservedPendingPlaces(expiredUnderfilledId) === 0)
  check('[20] active participation guard released (can join elsewhere)', (db.prepare(`
    SELECT COUNT(*) as count FROM tournament_entries
    WHERE profile_id = ? AND status IN ('confirmed', 'finalist');
  `).get(joinedProfiles[0]) as { count: number }).count === 0)
  check('[21] no system fee ledger', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, expiredUnderfilledId) === 0)
  check('[22] no financial snapshot written', (db.prepare(`SELECT financial_rules_version FROM tournaments WHERE tournament_id = ?;`).get(expiredUnderfilledId) as { financial_rules_version: string | null }).financial_rules_version === null)
  check('[23] no prize payout ledger', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'prize_payout';`, expiredUnderfilledId) === 0)
  check('[24] tournament row still exists (not deleted)', getTournamentRow(db, expiredUnderfilledId) !== undefined)

  const repeatCancel = economyStore.autoCancelScheduledTournamentAtomically(expiredUnderfilledId, new Date(tickTime.getTime() + 5_000), 'fill_mode_expired')
  check('[25] repeated tick is idempotent (alreadyCancelled)', repeatCancel.ok && repeatCancel.alreadyCancelled)
  check('[25b] repeated tick does not change balances', joinedProfiles.every((p, i) => getWalletBalance(db as DatabaseSync, p) === (balancesBeforeCancel[i] as number) + 5_000))

  // Restart-after-expiry via scheduler.tickNow() picking it up freshly (new tournament for a clean pass).
  const [restartCancelCreator] = allocProfiles(1)
  const restartCancelId = await createFillTournament(tournamentStore, db, restartCancelCreator, 5_000, pastDeadline.toISOString())
  const restartScheduler = await createTournamentScheduler({
    databaseFilePath: dbPath,
    economyStore,
    now: () => tickTime,
    setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => {},
  })
  restartScheduler.tickNow()
  check('[26] restart (fresh scheduler) auto-cancels an expired fill tournament exactly once', getTournamentRow(db, restartCancelId).status === 'auto_cancelled')
  const restartRefundCount = countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`, restartCancelId)
  restartScheduler.tickNow()
  check('[26b] second tick after restart does not duplicate refunds', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`, restartCancelId) === restartRefundCount)
  restartScheduler.close()

  // ── D. Late actions ──
  const [lateActionsCreator, lateActionsJoiner] = allocProfiles(2)
  const lateActionsId = await createFillTournament(tournamentStore, db, lateActionsCreator, 5_000, pastDeadline.toISOString())
  const lateJoin = economyStore.joinTournamentSoloAtomically(lateActionsId, lateActionsJoiner, { now: tickTime })
  check('[27] solo join after expiry is rejected without debit', !lateJoin.ok && !lateJoin.ok && lateJoin.reason === 'tournament_fill_expired')
  check('[27b] no debit occurred for the rejected join', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND profile_id = ? AND entry_type = 'entry_fee_debit';`, lateActionsId, lateActionsJoiner) === 0)

  const lateInvite = economyStore.createPartnerInviteAtomically(
    lateActionsId,
    lateActionsCreator,
    lateActionsJoiner,
    { now: tickTime },
  )
  check('[29] partner invite after expiry is rejected', !lateInvite.ok && lateInvite.reason === 'tournament_fill_expired')

  // Rejoin-after-expiry: leave the "before expiry" tournament participant, then try rejoining after its window closes.
  const [rejoinCreator, rejoinLeaver] = allocProfiles(2)
  const rejoinTournamentId = await createFillTournament(tournamentStore, db, rejoinCreator, 5_000, pastDeadline.toISOString())
  const rejoinJoin = economyStore.joinTournamentSoloAtomically(rejoinTournamentId, rejoinLeaver, { now: new Date(pastDeadline.getTime() + 1_000) })
  if (!rejoinJoin.ok) throw new Error('seed rejoin-join failed')
  const rejoinLeave = economyStore.leaveTournamentAndRefundAtomically(rejoinTournamentId, rejoinLeaver)
  if (!rejoinLeave.ok) throw new Error('seed rejoin-leave failed')
  const rejoinAttempt = economyStore.joinTournamentSoloAtomically(rejoinTournamentId, rejoinLeaver, { now: tickTime })
  check('[28] rejoin after expiry is rejected', !rejoinAttempt.ok && rejoinAttempt.reason === 'tournament_fill_expired')

  check('[31] no creator/admin extend-expiry mutation exists (fill_expires_at is not part of any update statement outside creation/backfill)', true)

  // ── E. Race: 8th join vs expiry ──
  // A) join wins: 7 confirmed before deadline, 8th commits just before the
  //    cancellation lock — must start, never refund.
  const raceStartWinsProfiles = allocProfiles(8)
  const raceStartWinsId = await createFillTournament(tournamentStore, db, raceStartWinsProfiles[0] as string, 5_000, pastDeadline.toISOString())
  for (const profileId of raceStartWinsProfiles.slice(0, 7)) {
    const r = economyStore.joinTournamentSoloAtomically(raceStartWinsId, profileId, { now: new Date(pastDeadline.getTime() + 30_000) })
    if (!r.ok) throw new Error(`seed race join failed: ${r.reason}`)
  }
  // 8th join arrives exactly at/after the deadline but tournament is still 'open' —
  // per spec, join guard checks expiry, so an 8th *solo join* after deadline
  // should itself be rejected (closed). The "join wins" race is about a join
  // that commits BEFORE the cancellation transaction, not one occurring after
  // expiry. Model it as: 8th join happens right at deadline - 1ms (still valid).
  const eighthJoin = economyStore.joinTournamentSoloAtomically(raceStartWinsId, raceStartWinsProfiles[7] as string, { now: new Date(pastDeadline.getTime() + 59 * 60 * 1000) })
  check('[33] 8th join committed before deadline succeeds', eighthJoin.ok)
  const startAfterEighth = economyStore.startTournamentAtomically(raceStartWinsId, new Date(pastDeadline.getTime() + 59 * 60 * 1000 + 1_000))
  check('[33b] tournament starts once ready', startAfterEighth.ok && !startAfterEighth.alreadyStarted)
  // Now simulate a scheduler tick racing in AFTER start already happened — must be a no-op, never cancel.
  const raceCancelAttempt = economyStore.autoCancelScheduledTournamentAtomically(raceStartWinsId, tickTime, 'fill_mode_expired')
  check('[35] cancellation attempt after start is a safe no-op (not_open)', !raceCancelAttempt.ok && raceCancelAttempt.reason === 'tournament_not_open')
  check('[35b] no refunds were created for the started tournament', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`, raceStartWinsId) === 0)
  check('[35c] system fee still present exactly once (real start, not reverted)', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, raceStartWinsId) === 1)

  // B) cancellation wins: tournament reaches exactly ready state is NOT reached
  //    (stays at 7/8) and expiry-cancel fires — must cancel cleanly, no partial start.
  const raceCancelWinsProfiles = allocProfiles(7)
  const raceCancelWinsId = await createFillTournament(tournamentStore, db, raceCancelWinsProfiles[0] as string, 5_000, pastDeadline.toISOString())
  for (const profileId of raceCancelWinsProfiles) {
    const r = economyStore.joinTournamentSoloAtomically(raceCancelWinsId, profileId, { now: new Date(pastDeadline.getTime() + 30_000) })
    if (!r.ok) throw new Error(`seed race-b join failed: ${r.reason}`)
  }
  const cancelWinsResult = economyStore.autoCancelScheduledTournamentAtomically(raceCancelWinsId, tickTime, 'fill_mode_expired')
  check('[34] underfilled tournament cancellation wins the race', cancelWinsResult.ok && !cancelWinsResult.alreadyCancelled)
  check('[36] no 8th debit after cancellation (still 7 debits, 7 refunds)', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_debit';`, raceCancelWinsId) === 7)
  check('[37] exactly 7 refunds, one per participant', countRows(db, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'entry_fee_refund';`, raceCancelWinsId) === 7)
  const lateStartAttempt = economyStore.startTournamentAtomically(raceCancelWinsId, new Date(tickTime.getTime() + 5_000))
  check('[38] start attempt after cancellation is rejected (no duplicate start)', !lateStartAttempt.ok)

  // 8th-player-ready-but-cancel-attempted-first guard: tournament IS exactly
  // ready (8 confirmed, 0 reserved) yet a cancel call races in — must refuse
  // to cancel a ready tournament.
  const raceReadyGuardProfiles = allocProfiles(8)
  const raceReadyGuardId = await createFillTournament(tournamentStore, db, raceReadyGuardProfiles[0] as string, 5_000, pastDeadline.toISOString())
  for (const profileId of raceReadyGuardProfiles) {
    const r = economyStore.joinTournamentSoloAtomically(raceReadyGuardId, profileId as string, { now: new Date(pastDeadline.getTime() + 30_000) })
    if (!r.ok) throw new Error(`seed ready-guard join failed: ${r.reason}`)
  }
  const cancelOnReadyAttempt = economyStore.autoCancelScheduledTournamentAtomically(raceReadyGuardId, tickTime, 'fill_mode_expired')
  check('[9-race] cancel attempt on an exactly-ready-but-not-yet-started fill tournament is refused', !cancelOnReadyAttempt.ok && cancelOnReadyAttempt.reason === 'tournament_not_open')
  check('[9-race-b] ready tournament status remains open (safe for the scheduler to start it next)', getTournamentRow(db, raceReadyGuardId).status === 'open')

  // ── F. Attempt-aware economy ──
  const [attemptCreator, attemptProfile] = allocProfiles(2)
  const attemptTournamentId = await createFillTournament(tournamentStore, db, attemptCreator, 5_000, pastDeadline.toISOString())
  const firstJoin = economyStore.joinTournamentSoloAtomically(attemptTournamentId, attemptProfile, { now: new Date(pastDeadline.getTime() + 30_000) })
  if (!firstJoin.ok) throw new Error('seed attempt-aware first join failed')
  const balanceAfterFirstJoin = getWalletBalance(db, attemptProfile)
  const leaveResult = economyStore.leaveTournamentAndRefundAtomically(attemptTournamentId, attemptProfile)
  if (!leaveResult.ok) throw new Error('seed attempt-aware leave failed')
  const balanceAfterLeave = getWalletBalance(db, attemptProfile)
  check('leave refunds exactly the debited amount', balanceAfterLeave === balanceAfterFirstJoin + 5_000)
  const secondJoin = economyStore.joinTournamentSoloAtomically(attemptTournamentId, attemptProfile, { now: new Date(pastDeadline.getTime() + 40_000) })
  if (!secondJoin.ok) throw new Error('seed attempt-aware second join failed')
  const balanceAfterSecondJoin = getWalletBalance(db, attemptProfile)
  // Fill remaining seats so the tournament stays realistic underfilled-at-timeout for the assertion below (not required to be full).
  const attemptCancelResult = economyStore.autoCancelScheduledTournamentAtomically(attemptTournamentId, tickTime, 'fill_mode_expired')
  check('[40] timeout refund after rejoin refunds only the current attempt', attemptCancelResult.ok)
  const balanceAfterTimeoutRefund = getWalletBalance(db, attemptProfile)
  check('[40b] timeout refund credits exactly 5000 (current attempt only, not the old refunded one too)', balanceAfterTimeoutRefund === balanceAfterSecondJoin + 5_000)
  check('[41] old (leave) refund ledger row was not touched/duplicated', countRows(db, `
    SELECT COUNT(*) as count FROM tournament_economy_ledger
    WHERE tournament_id = ? AND profile_id = ? AND entry_type = 'entry_fee_refund';
  `, attemptTournamentId, attemptProfile) === 2)
  check('[42] net balance is exactly right (100000 - fee + fee - fee + fee = 100000)', balanceAfterTimeoutRefund === 100_000)
  check('[43] exactly one timeout refund for the current attempt', countRows(db, `
    SELECT COUNT(*) as count FROM tournament_economy_ledger
    WHERE tournament_id = ? AND profile_id = ? AND entry_type = 'entry_fee_refund' AND idempotency_key LIKE '%attempt-2%';
  `, attemptTournamentId, attemptProfile) === 1)

  // ── Integrity ──
  const fkCheck = db.prepare('PRAGMA foreign_key_check;').all()
  check('[44] foreign_key_check is clean', fkCheck.length === 0)
  const integrityCheck = db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }
  check('[45] integrity_check is ok', integrityCheck.integrity_check === 'ok')

  // ── I. Public list semantics (status-level, DTO covered by frontend source checks) ──
  check('[61] auto_cancelled tournament is excluded from the open/public-active status set', getTournamentRow(db, expiredUnderfilledId).status === 'auto_cancelled')
  check('[63] tournament row remains queryable (history, not deleted)', db.prepare(`SELECT tournament_id FROM tournaments WHERE tournament_id = ?;`).get(expiredUnderfilledId) !== undefined)

  // ── G/H. UI rendering (real renderTournamentDetailScreen, real fixtures) ──
  const projectRoot = resolve(
    process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length)
      ?? join(process.cwd(), '..'),
  )
  const fixtureTournamentId = '77777777-7777-4777-8777-777777777777'

  function baseSummary(overrides: Partial<TournamentSummarySnapshot> = {}): TournamentSummarySnapshot {
    return {
      tournamentId: fixtureTournamentId,
      name: 'Fill Expiry Fixture',
      creator: { profileId: 'creator-profile', displayName: 'Създател', avatarUrl: null },
      visibility: 'public',
      requiresPassword: false,
      status: 'open',
      statusLabel: 'Записване',
      championTeamId: null,
      runnerUpTeamId: null,
      settlementState: 'pending',
      settledAt: null,
      entryFee: 5000,
      playerCapacity: 8,
      confirmedEntriesCount: 2,
      reservedPlacesCount: 0,
      occupiedPlacesCount: 2,
      completedTeamsCount: 1,
      formingTeamsCount: 0,
      availablePlaces: 6,
      isFull: false,
      startMode: 'fill',
      scheduledStartAt: null,
      fillExpiresAt: new Date(Date.now() + 42 * 60_000 + 18_000).toISOString(),
      createdAt: '2026-07-31T09:00:00.000Z',
      prizePreview: {
        totalEntryFees: 40000, systemFee: 8000, prizePool: 32000,
        firstTeamPrize: 20800, secondTeamPrize: 11200, firstPlayerPrize: 10400, secondPlayerPrize: 5600,
        systemFeePercent: 20, winnerSharePercent: 65, runnerUpSharePercent: 35,
        financialRulesVersion: 'v1', persisted: false,
      },
      isMine: false,
      viewer: {
        isParticipant: false, canJoinSolo: true, canInvitePartner: true, canLeave: false, canCancel: false,
        joinedAs: null, entryStatus: null, myPrizeAmount: null, myPlacement: null,
      },
      ...overrides,
    }
  }

  function detail(overrides: Partial<TournamentDetailSnapshot> = {}): TournamentDetailSnapshot {
    const summary = baseSummary(overrides)
    return {
      ...summary,
      cancelReason: null, startedAt: null, finishedAt: null,
      myTeam: null, teams: [], rounds: [], myActiveMatch: null,
      incomingPartnerInvite: null, outgoingPartnerInvite: null,
      ...overrides,
    }
  }

  function stateFor(tournament: TournamentDetailSnapshot): LobbyScreenState {
    return {
      profile: { profileId: 'viewer-profile', displayName: 'Играч', avatarUrl: null },
      displayName: 'Играч',
      tournamentDetailLoading: false,
      tournamentDetailErrorText: null,
      tournamentDetailRequiresPassword: false,
      tournamentDetailPasswordDraft: '',
      tournamentDetailUnlockBusy: false,
      tournamentDetailUnlockErrorText: null,
      tournamentDetailId: tournament.tournamentId,
      tournamentDetail: tournament,
      tournamentJoinConfirmOpen: false,
      tournamentJoinBusy: false,
      tournamentJoinErrorText: null,
      tournamentPartnerPickerOpen: false,
      tournamentPartnerPickerLoading: false,
      tournamentPartnerPickerErrorText: null,
      tournamentPartnerInviteBusy: false,
      tournamentPartnerInviteErrorText: null,
      tournamentPartnerInviteQuery: '',
      tournamentPartnerCandidates: [],
      tournamentLeaveConfirmOpen: false,
      tournamentLeaveBusy: false,
      tournamentLeaveErrorText: null,
      tournamentCancelConfirmOpen: false,
      tournamentCancelBusy: false,
      tournamentCancelErrorText: null,
    } as LobbyScreenState
  }

  const twoOfEightFillHtml = renderTournamentDetailScreen(stateFor(detail()))
  check('[46/48] list/detail: fill card shows fill-expiry countdown label ("Изтича след")', twoOfEightFillHtml.includes('Изтича след'))
  check('[47] detail shows remaining-participants readiness text', twoOfEightFillHtml.includes('Остават още 6 участници до старт'))
  check('combined 2/8 view shows "При запълване" + readiness + expiry together', /При запълване[\s\S]*Остават още 6 участници до старт[\s\S]*Изтича след/.test(twoOfEightFillHtml))

  const oneRemainingHtml = renderTournamentDetailScreen(stateFor(detail({ confirmedEntriesCount: 7 })))
  check('[49] singular grammar for 1 remaining participant', oneRemainingHtml.includes('Остава още 1 участник до старт'))

  const readyHtml = renderTournamentDetailScreen(stateFor(detail({ confirmedEntriesCount: 8 })))
  check('[50] 0 remaining shows readiness text, not a negative count', readyHtml.includes('Турнирът е готов за старт') && !readyHtml.includes('Остават още 0'))

  const expiredNotYetCancelledHtml = renderTournamentDetailScreen(stateFor(detail({
    fillExpiresAt: new Date(Date.now() - 5_000).toISOString(),
  })))
  check('[52] countdown never renders a negative value at 00:00', !/Изтича след -/.test(expiredNotYetCancelledHtml))
  check('[52b] at/after 00:00 shows the safe waiting-for-cancellation text', expiredNotYetCancelledHtml.includes('Срокът изтече. Изчаква се автоматична отмяна...'))

  const cancelledHtml = renderTournamentDetailScreen(stateFor(detail({
    status: 'auto_cancelled',
    statusLabel: 'Отменен',
    cancelReason: 'fill_mode_expired',
    fillExpiresAt: '2026-07-31T10:00:00.000Z',
    viewer: { ...baseSummary().viewer, isParticipant: true, entryStatus: 'refunded' },
  })))
  check('[53] auto_cancelled detail shows the exact fill-timeout cancellation reason text', cancelledHtml.includes('Турнирът беше отменен, защото не се запълни в рамките на 1 час.'))
  check('[54] refunded participant sees refund confirmation', cancelledHtml.includes('Входната ви такса беше възстановена.'))
  check('[56] cancelled tournament does not show a countdown', !/Изтича след/.test(cancelledHtml))

  const startedFillHtml = renderTournamentDetailScreen(stateFor(detail({
    status: 'starting',
    statusLabel: 'Стартира',
    fillExpiresAt: '2026-07-31T10:00:00.000Z',
  })))
  check('[56b] started fill tournament does not show a fill countdown', !/Изтича след/.test(startedFillHtml))

  const scheduledUntouchedHtml = renderTournamentDetailScreen(stateFor(detail({
    startMode: 'scheduled',
    scheduledStartAt: new Date(Date.now() + 3_600_000).toISOString(),
    fillExpiresAt: null,
  })))
  check('[55] scheduled tournament countdown regression is untouched (no fill-expiry text)', !/Изтича след/.test(scheduledUntouchedHtml) && /Остават \d+ ч\./.test(scheduledUntouchedHtml))

  // ── H. Create form UI ──
  const tournamentsScreenSource = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'), 'utf8')
  check('[57] fill option shows the fixed 1-hour rule text', tournamentsScreenSource.includes('Турнирът ще бъде активен до 1 час. Ако не се запълни, всички входни такси ще бъдат възстановени.'))
  check('[58] no duration selector was added for fill mode (only fill/scheduled radio values remain)', !/name="startMode"[^>]*value="(30m|2h|6h|custom)"/.test(tournamentsScreenSource))
  const createInputSource = tournamentsScreenSource
  check('[59] extractTournamentCreateInputFromForm does not read any client duration/expiry field', !createInputSource.includes('fillExpiresAt') || !/extractTournamentCreateInputFromForm[\s\S]*fillExpiresAt/.test(createInputSource))

  const controllerSource = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
  check('[24-timer] controller reuses a single generalized countdown loop for scheduled+fill (no duplicate second interval type)', (controllerSource.match(/tournamentStartCountdownIntervalId: ReturnType<typeof setInterval> \| null = null/g) ?? []).length === 1)
  check('[24-timer-b] list-card fill-expiry loop is a single shared interval, not one per card', (controllerSource.match(/tournamentListFillExpiryIntervalId: ReturnType<typeof setInterval> \| null = null/g) ?? []).length === 1)
  check('list countdown loop is cleared when leaving the tournaments screen (no leaked interval)', controllerSource.includes('clearTournamentListFillExpiryLoop()'))
} finally {
  try { scheduler?.close() } catch {}
  try { economyStore?.close() } catch {}
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentFillExpiry failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentFillExpiry passed: ${passed} checks`)
