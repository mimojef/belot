/**
 * checkTournamentSoloLifecycleReconciliation.ts
 *
 * Targeted regression за "CLOSE THE SOLO REGISTRATION LIFECYCLE" — canonical
 * invariant: an 'open' tournament has AT MOST 1 confirmed waiting solo
 * player at any time, enforced not just at join-time (already covered by
 * checkTournamentAutoPairSolo.ts) but also:
 *
 *  A) legacy normalization — pre-existing team_id=NULL confirmed solo
 *     entries (the shape every solo join left behind before auto-pair
 *     existed) get FIFO-paired into the canonical forming/complete model,
 *     idempotently, restart-safe, with zero economy side effects (see
 *     reconcileLegacySoloEntriesForTournamentAtomically in
 *     tournamentEconomyStore.ts, called once per 'open' tournament at server
 *     boot — see reconcileLegacySoloTournamentEntriesOnBoot in index.ts).
 *  B) solo team member leave — leaving a solo-origin (both joined_as='solo')
 *     complete team NEVER refunds/removes the remaining member (unlike the
 *     unchanged explicit-partner-team leave path): an existing waiting solo
 *     immediately replaces the leaver on the SAME team, or the team demotes
 *     complete->forming and the remaining member becomes the new canonical
 *     waiting solo.
 *
 * Explicit partner teams/invites are proven untouched throughout — never
 * auto-paired, never consumed as a replacement candidate, never modified by
 * legacy reconciliation.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'

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

function getWalletBalance(database: DatabaseSync, profileId: string): number {
  return (database.prepare(`SELECT yellow_coins_balance as balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { balance: number }).balance
}

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

type EntryRow = { entry_id: string; profile_id: string; team_id: string | null; joined_as: string; status: string; created_at: string }
type TeamRow = { team_id: string; status: string }

function getEntry(database: DatabaseSync, tournamentId: string, profileId: string): EntryRow | undefined {
  return database.prepare(`
    SELECT entry_id, profile_id, team_id, joined_as, status, created_at
    FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;
  `).get(tournamentId, profileId) as EntryRow | undefined
}

function getTeam(database: DatabaseSync, teamId: string): TeamRow | undefined {
  return database.prepare(`SELECT team_id, status FROM tournament_teams WHERE team_id = ?;`).get(teamId) as TeamRow | undefined
}

function getTeamMembers(database: DatabaseSync, teamId: string): EntryRow[] {
  return database.prepare(`
    SELECT entry_id, profile_id, team_id, joined_as, status, created_at
    FROM tournament_entries WHERE team_id = ? AND status = 'confirmed';
  `).all(teamId) as EntryRow[]
}

function countWaitingSoloTeams(database: DatabaseSync, tournamentId: string): number {
  // Canonical "waiting solo" per §"КРИТИЧЕН INVARIANT": status='confirmed',
  // joined_as='solo', membership in a 'forming' team with exactly 1
  // confirmed solo member.
  return countRows(database, `
    SELECT COUNT(*) as count FROM tournament_teams tt
    WHERE tt.tournament_id = ? AND tt.status = 'forming'
      AND (SELECT COUNT(*) FROM tournament_entries te WHERE te.team_id = tt.team_id AND te.status = 'confirmed') = 1
      AND (SELECT te.joined_as FROM tournament_entries te WHERE te.team_id = tt.team_id AND te.status = 'confirmed' LIMIT 1) = 'solo';
  `, tournamentId)
}

function countLegacyNullTeamSolos(database: DatabaseSync, tournamentId: string): number {
  return countRows(database, `
    SELECT COUNT(*) as count FROM tournament_entries
    WHERE tournament_id = ? AND status = 'confirmed' AND joined_as = 'solo' AND team_id IS NULL;
  `, tournamentId)
}

function countOversizedTeams(database: DatabaseSync, tournamentId: string): number {
  return countRows(database, `
    SELECT COUNT(*) as count FROM (
      SELECT team_id, COUNT(*) as member_count FROM tournament_entries
      WHERE tournament_id = ? AND team_id IS NOT NULL AND status = 'confirmed'
      GROUP BY team_id HAVING member_count > 2
    );
  `, tournamentId)
}

// Seeds a raw team_id=NULL confirmed solo entry — the exact legacy
// production shape (§"PRODUCTION COMPATIBILITY CONTEXT") that no live
// code path produces anymore (every join/leave/invite-lifecycle path always
// assigns a team_id to a confirmed solo entry) — see the comment on
// selectLegacyOrphanSoloEntriesStatement in tournamentEconomyStore.ts.
function seedLegacyOrphanSoloEntry(
  database: DatabaseSync,
  tournamentId: string,
  profileId: string,
  createdAtIso: string,
  entryIdOverride?: string,
): string {
  const entryId = entryIdOverride ?? randomUUID()
  database.prepare(`
    INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'solo', 'confirmed', ?, ?);
  `).run(entryId, tournamentId, profileId, createdAtIso, createdAtIso)
  return entryId
}

console.log('\ncheckTournamentSoloLifecycleReconciliation')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-solo-lifecycle-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)

  const profiles = Array.from({ length: 200 }, () => randomUUID())
  profiles.forEach((profileId, index) => insertProfile(db as DatabaseSync, profileId, `Player ${index + 1}`, 1_000_000))
  let nextProfileIndex = 0
  function allocProfiles(count: number): string[] {
    if (nextProfileIndex + count > profiles.length) {
      throw new Error(`profile pool exhausted: need ${count} more, only ${profiles.length - nextProfileIndex} left`)
    }
    const slice = profiles.slice(nextProfileIndex, nextProfileIndex + count) as string[]
    nextProfileIndex += count
    return slice
  }

  tournamentStore = await createTournamentStore(dbPath)
  economyStore = await createTournamentEconomyStore(dbPath)
  const store = tournamentStore
  const economy = economyStore

  function createTournament(playerCapacity: number, creatorProfileId: string, name: string): string {
    const result = store.createTournament({
      name,
      creatorProfileId,
      visibility: 'public',
      entryFee: 5_000,
      startMode: 'fill',
      playerCapacity,
    })
    if (!result.ok) throw new Error(`seed tournament creation failed: ${result.reason}`)
    return result.tournament.tournamentId
  }

  function joinSolo(tournamentId: string, profileId: string) {
    return economy.joinTournamentSoloAtomically(tournamentId, profileId)
  }

  // ══════════════════════════════ SECTION A: LEGACY NORMALIZATION ══════════════════════════════

  await check('[A1] 0 legacy solos -> reconciliation is a clean no-op', () => {
    const [creator] = allocProfiles(1)
    const tournamentId = createTournament(32, creator, 'A1')
    const result = economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    assert(result.alreadyClean === true && result.pairedTeams === 0, `expected alreadyClean, got ${JSON.stringify(result)}`)
  })

  await check('[A2] 1 legacy solo -> exactly one forming waiting team', () => {
    const [creator, solo1] = allocProfiles(2)
    const tournamentId = createTournament(32, creator, 'A2')
    seedLegacyOrphanSoloEntry(db!, tournamentId, solo1, '2026-08-30T10:00:00.000Z')
    const result = economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    assert(!result.alreadyClean && result.pairedTeams === 0 && result.waitingTeamCreated, `expected 1 waiting team, got ${JSON.stringify(result)}`)
    const entry = getEntry(db!, tournamentId, solo1)!
    assert(entry.team_id !== null, 'legacy entry must now have a team_id')
    assert(getTeam(db!, entry.team_id as string)!.status === 'forming', 'expected forming status')
    assert(countLegacyNullTeamSolos(db!, tournamentId) === 0, 'no legacy orphans should remain')
  })

  await check('[A3] 2 legacy solos -> exactly one complete team', () => {
    const [creator, solo1, solo2] = allocProfiles(3)
    const tournamentId = createTournament(32, creator, 'A3')
    seedLegacyOrphanSoloEntry(db!, tournamentId, solo1, '2026-08-30T10:00:00.000Z')
    seedLegacyOrphanSoloEntry(db!, tournamentId, solo2, '2026-08-30T10:01:00.000Z')
    const result = economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    assert(!result.alreadyClean && result.pairedTeams === 1 && !result.waitingTeamCreated, `expected 1 complete team, got ${JSON.stringify(result)}`)
    const e1 = getEntry(db!, tournamentId, solo1)!
    const e2 = getEntry(db!, tournamentId, solo2)!
    assert(e1.team_id === e2.team_id, 'both legacy solos must land on the SAME team')
    assert(getTeam(db!, e1.team_id as string)!.status === 'complete', 'expected complete status')
  })

  await check('[A4] 3 legacy solos -> 1 complete + 1 forming, FIFO order matches production example', () => {
    const [creator, terminator, meteopa, joro81] = allocProfiles(4)
    const tournamentId = createTournament(32, creator, 'A4')
    seedLegacyOrphanSoloEntry(db!, tournamentId, terminator, '2026-08-30T10:00:00.000Z')
    seedLegacyOrphanSoloEntry(db!, tournamentId, meteopa, '2026-08-30T10:01:00.000Z')
    seedLegacyOrphanSoloEntry(db!, tournamentId, joro81, '2026-08-30T10:02:00.000Z')
    const result = economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    assert(!result.alreadyClean && result.pairedTeams === 1 && result.waitingTeamCreated, `expected complete+forming, got ${JSON.stringify(result)}`)
    const tTerm = getEntry(db!, tournamentId, terminator)!
    const tMeteo = getEntry(db!, tournamentId, meteopa)!
    const tJoro = getEntry(db!, tournamentId, joro81)!
    assert(tTerm.team_id === tMeteo.team_id, 'the two OLDEST (Terminator, METEOPA) must be paired together')
    assert(tJoro.team_id !== tTerm.team_id, 'Joro 81 (newest) must be on a separate team')
    assert(getTeam(db!, tTerm.team_id as string)!.status === 'complete', 'Terminator+METEOPA team must be complete')
    assert(getTeam(db!, tJoro.team_id as string)!.status === 'forming', 'Joro 81 must be the lone waiting solo')
    assert(countWaitingSoloTeams(db!, tournamentId) === 1, 'exactly 1 waiting solo after reconciliation')
  })

  await check('[A5] 5 legacy solos -> 2 complete + 1 forming (max 1 waiting solo)', () => {
    const [creator, ...solos] = allocProfiles(6)
    const tournamentId = createTournament(32, creator, 'A5')
    solos.forEach((profileId, i) => seedLegacyOrphanSoloEntry(db!, tournamentId, profileId, `2026-08-30T10:0${i}:00.000Z`))
    const result = economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    assert(!result.alreadyClean && result.pairedTeams === 2 && result.waitingTeamCreated, `expected 2 complete + 1 forming, got ${JSON.stringify(result)}`)
    assert(countWaitingSoloTeams(db!, tournamentId) === 1, 'invariant: at most 1 waiting solo')
    assert(countLegacyNullTeamSolos(db!, tournamentId) === 0, 'no legacy orphans should remain')
    assert(countOversizedTeams(db!, tournamentId) === 0, 'no team should exceed 2 confirmed members')
  })

  await check('[A6] FIFO tie-break: identical created_at falls back to entry_id ASC', () => {
    const [creator, low, high, third] = allocProfiles(4)
    const tournamentId = createTournament(32, creator, 'A6')
    const sameTs = '2026-08-30T10:00:00.000Z'
    seedLegacyOrphanSoloEntry(db!, tournamentId, high, sameTs, 'zzz-entry-high')
    seedLegacyOrphanSoloEntry(db!, tournamentId, low, sameTs, 'aaa-entry-low')
    seedLegacyOrphanSoloEntry(db!, tournamentId, third, '2026-08-30T10:05:00.000Z')
    economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    const lowEntry = getEntry(db!, tournamentId, low)!
    const highEntry = getEntry(db!, tournamentId, high)!
    const thirdEntry = getEntry(db!, tournamentId, third)!
    assert(lowEntry.team_id === highEntry.team_id, 'the two tied-timestamp entries must be paired together (entry_id tie-break)')
    assert(thirdEntry.team_id !== lowEntry.team_id, 'the later entry must be the waiting solo')
  })

  await check('[A7] rerunning reconciliation on an already-normalized tournament is a no-op (idempotent, no duplicate teams)', () => {
    const [creator, solo1, solo2, solo3] = allocProfiles(4)
    const tournamentId = createTournament(32, creator, 'A7')
    seedLegacyOrphanSoloEntry(db!, tournamentId, solo1, '2026-08-30T10:00:00.000Z')
    seedLegacyOrphanSoloEntry(db!, tournamentId, solo2, '2026-08-30T10:01:00.000Z')
    seedLegacyOrphanSoloEntry(db!, tournamentId, solo3, '2026-08-30T10:02:00.000Z')
    economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    const teamsBefore = countRows(db!, `SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?;`, tournamentId)
    const entriesSnapshotBefore = JSON.stringify(db!.prepare(`SELECT * FROM tournament_entries WHERE tournament_id = ? ORDER BY entry_id;`).all(tournamentId))

    const rerun1 = economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    const rerun2 = economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    assert(rerun1.alreadyClean && rerun2.alreadyClean, 'reruns must report alreadyClean')

    const teamsAfter = countRows(db!, `SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?;`, tournamentId)
    const entriesSnapshotAfter = JSON.stringify(db!.prepare(`SELECT * FROM tournament_entries WHERE tournament_id = ? ORDER BY entry_id;`).all(tournamentId))
    assert(teamsBefore === teamsAfter, `team count must not change on rerun (${teamsBefore} -> ${teamsAfter})`)
    assert(entriesSnapshotBefore === entriesSnapshotAfter, 'entries must be byte-for-byte unchanged on rerun')
  })

  await check('[A8]/[A9] explicit partner teams (complete + pending forming) are untouched by legacy reconciliation', () => {
    const [creator, inviter, invitee, acceptedInviter, acceptedInvitee, legacySolo] = allocProfiles(6)
    const tournamentId = createTournament(32, creator, 'A8-A9')

    // Pending explicit invite (forming team, inviter only confirmed).
    const pendingInvite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee)
    if (!pendingInvite.ok) throw new Error('seed pending invite failed')
    const pendingTeamIdBefore = pendingInvite.invite.teamId
    const inviterEntryBefore = getEntry(db!, tournamentId, inviter)!

    // Completed explicit partner team.
    const acceptedInvite = economy.createPartnerInviteAtomically(tournamentId, acceptedInviter, acceptedInvitee)
    if (!acceptedInvite.ok) throw new Error('seed accepted invite failed')
    const accept = economy.acceptPartnerInviteAtomically(tournamentId, acceptedInvite.invite.inviteId, acceptedInvitee)
    if (!accept.ok) throw new Error('seed accept failed')
    const acceptedTeamId = getEntry(db!, tournamentId, acceptedInviter)!.team_id

    // A legacy orphan solo, so reconciliation actually does something.
    seedLegacyOrphanSoloEntry(db!, tournamentId, legacySolo, '2026-08-30T10:00:00.000Z')

    const invitesSnapshotBefore = JSON.stringify(db!.prepare(`SELECT * FROM tournament_partner_invites WHERE tournament_id = ? ORDER BY invite_id;`).all(tournamentId))
    const acceptedTeamSnapshotBefore = JSON.stringify(getTeamMembers(db!, acceptedTeamId as string))

    const result = economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    assert(!result.alreadyClean, 'expected reconciliation to process the legacy solo')

    const invitesSnapshotAfter = JSON.stringify(db!.prepare(`SELECT * FROM tournament_partner_invites WHERE tournament_id = ? ORDER BY invite_id;`).all(tournamentId))
    assert(invitesSnapshotBefore === invitesSnapshotAfter, '[A9] pending invite row must be byte-for-byte unchanged')
    const inviterEntryAfter = getEntry(db!, tournamentId, inviter)!
    assert(inviterEntryAfter.team_id === pendingTeamIdBefore, 'pending inviter must stay on the SAME forming team')
    assert(inviterEntryAfter.joined_as === 'partner_inviter', 'pending inviter must remain joined_as=partner_inviter')
    assert(getTeam(db!, pendingTeamIdBefore)!.status === 'forming', 'pending invite team must remain forming')

    const acceptedTeamSnapshotAfter = JSON.stringify(getTeamMembers(db!, acceptedTeamId as string))
    assert(acceptedTeamSnapshotBefore === acceptedTeamSnapshotAfter, '[A8] accepted explicit partner team must be byte-for-byte unchanged')
    assert(inviterEntryBefore.created_at === inviterEntryAfter.created_at, 'inviter entry row must not have been re-created')
  })

  await check('[A10]/[A11]/[A12] legacy reconciliation touches ONLY team_id — ledger, wallets, and participant count are byte-for-byte unchanged', () => {
    const [creator, solo1, solo2, solo3] = allocProfiles(4)
    const tournamentId = createTournament(32, creator, 'A10-A12')
    const t1 = seedLegacyOrphanSoloEntry(db!, tournamentId, solo1, '2026-08-30T10:00:00.000Z')
    const t2 = seedLegacyOrphanSoloEntry(db!, tournamentId, solo2, '2026-08-30T10:01:00.000Z')
    const t3 = seedLegacyOrphanSoloEntry(db!, tournamentId, solo3, '2026-08-30T10:02:00.000Z')
    // Legacy production entries had real ledger rows too (paid at the time
    // via the old pre-auto-pair join path) — seed them for a faithful check.
    for (const [entryId, profileId] of [[t1, solo1], [t2, solo2], [t3, solo3]] as const) {
      db!.prepare(`
        INSERT INTO tournament_economy_ledger (ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount)
        VALUES (?, ?, ?, ?, 'entry_fee_debit', 5000);
      `).run(randomUUID(), `legacy-debit:${entryId}`, tournamentId, profileId)
    }

    const ledgerBefore = JSON.stringify(db!.prepare(`SELECT * FROM tournament_economy_ledger WHERE tournament_id = ? ORDER BY ledger_id;`).all(tournamentId))
    const walletsBefore = [solo1, solo2, solo3].map((p) => getWalletBalance(db!, p))
    const participantCountBefore = countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId)

    economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)

    const ledgerAfter = JSON.stringify(db!.prepare(`SELECT * FROM tournament_economy_ledger WHERE tournament_id = ? ORDER BY ledger_id;`).all(tournamentId))
    const walletsAfter = [solo1, solo2, solo3].map((p) => getWalletBalance(db!, p))
    const participantCountAfter = countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId)
    assert(ledgerBefore === ledgerAfter, '[A10] ledger must be byte-for-byte unchanged')
    assert(JSON.stringify(walletsBefore) === JSON.stringify(walletsAfter), '[A11] wallet balances must be unchanged')
    assert(participantCountBefore === participantCountAfter, '[A12] confirmed participant count must be unchanged')
  })

  // ══════════════════════════════ SECTION B: LEAVE LIFECYCLE ══════════════════════════════

  await check('[B1]/[B2]/[B3] A+B complete, C waiting -> B leaves -> A+C complete on the SAME team_id, C not re-debited/refunded', () => {
    const [creator, a, b, c] = allocProfiles(4)
    const tournamentId = createTournament(32, creator, 'B1-B3')
    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed A failed')
    const joinB = joinSolo(tournamentId, b)
    if (!joinB.ok) throw new Error('seed B failed')
    const abTeamId = joinA.entry.teamId as string
    const joinC = joinSolo(tournamentId, c)
    if (!joinC.ok) throw new Error('seed C failed')
    const cOldTeamId = joinC.entry.teamId as string
    assert(cOldTeamId !== abTeamId, 'sanity: C starts on a separate waiting team')

    const cWalletBefore = getWalletBalance(db!, c)
    const cLedgerCountBefore = countRows(db!, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND profile_id = ?;`, tournamentId, c)

    const leaveResult = economy.leaveTournamentAndRefundAtomically(tournamentId, b)
    assert(leaveResult.ok, `leave failed: ${JSON.stringify(leaveResult)}`)
    if (!leaveResult.ok) return
    assert(leaveResult.autoReleasedPartner === null, 'solo-origin leave must never report autoReleasedPartner')
    assert(leaveResult.soloTeamCompositionChanged !== null, 'expected soloTeamCompositionChanged to be reported')
    assert(leaveResult.soloTeamCompositionChanged!.teamId === abTeamId, '[B1] replacement must happen on the SAME team_id A already had')
    assert(
      new Set(leaveResult.soloTeamCompositionChanged!.affectedProfileIds).size === 2 &&
      leaveResult.soloTeamCompositionChanged!.affectedProfileIds.includes(a) &&
      leaveResult.soloTeamCompositionChanged!.affectedProfileIds.includes(c),
      'affectedProfileIds must be exactly [A, C]',
    )

    const aEntry = getEntry(db!, tournamentId, a)!
    const cEntry = getEntry(db!, tournamentId, c)!
    assert(aEntry.team_id === abTeamId, 'A must remain on the original team')
    assert(cEntry.team_id === abTeamId, '[B1] C must now be on A\'s team')
    assert(getTeam(db!, abTeamId)!.status === 'complete', 'A+C team must be complete')
    assert(getTeamMembers(db!, abTeamId).length === 2, 'exactly 2 confirmed members')
    assert(getTeam(db!, cOldTeamId) === undefined, '[13] C\'s old forming team must be cleanly removed')

    assert(getWalletBalance(db!, c) === cWalletBefore, '[B2]/[14] C must NOT be re-debited or refunded')
    assert(countRows(db!, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND profile_id = ?;`, tournamentId, c) === cLedgerCountBefore, 'C must have no new ledger rows')
    assert(getEntry(db!, tournamentId, b)!.status === 'refunded', 'B must be refunded via the normal leave path')
    assert(countWaitingSoloTeams(db!, tournamentId) === 0, '[17] no waiting solo should remain (C consumed the vacancy)')
    assert(countOversizedTeams(db!, tournamentId) === 0, 'no team must exceed 2 confirmed members')
  })

  await check('[B4]/[B5]/[16] A+B complete, no C -> B leaves -> A becomes the canonical waiting solo; next D join -> A+D complete', () => {
    const [creator, a, b, d] = allocProfiles(4)
    const tournamentId = createTournament(32, creator, 'B4-B5')
    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed A failed')
    const joinB = joinSolo(tournamentId, b)
    if (!joinB.ok) throw new Error('seed B failed')
    const abTeamId = joinA.entry.teamId as string

    const leaveResult = economy.leaveTournamentAndRefundAtomically(tournamentId, b)
    assert(leaveResult.ok, `leave failed: ${JSON.stringify(leaveResult)}`)
    if (!leaveResult.ok) return
    assert(leaveResult.soloTeamCompositionChanged !== null && leaveResult.soloTeamCompositionChanged!.affectedProfileIds.length === 1 && leaveResult.soloTeamCompositionChanged!.affectedProfileIds[0] === a, '[15] expected only A to be reported as affected')

    const aEntry = getEntry(db!, tournamentId, a)!
    assert(aEntry.team_id === abTeamId, 'A must stay on the SAME team_id')
    assert(aEntry.joined_as === 'solo', 'A must remain joined_as=solo')
    assert(getTeam(db!, abTeamId)!.status === 'forming', '[B4] team must demote complete -> forming')
    assert(countWaitingSoloTeams(db!, tournamentId) === 1, '[17] exactly 1 waiting solo now (A)')

    const joinD = joinSolo(tournamentId, d)
    assert(joinD.ok, `D join failed: ${JSON.stringify(joinD)}`)
    if (!joinD.ok) return
    assert(joinD.entry.teamId === abTeamId, '[16] D must land on A\'s (SAME) team via canonical FIFO join')
    assert(getTeam(db!, abTeamId)!.status === 'complete', 'A+D team must be complete')
    assert(countWaitingSoloTeams(db!, tournamentId) === 0, '[17] no waiting solo remains after D joins')
  })

  // ══════════════════════════════ SECTION C: CONCURRENCY / ATOMICITY ══════════════════════════════

  await check('[18] two concurrent solo joins against one waiting A never produce 2 waiting solos or a 3-member team', async () => {
    const [creator, a, x, y] = allocProfiles(4)
    const tournamentId = createTournament(32, creator, 'C18')
    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed A failed')

    const [rx, ry] = await Promise.all([
      Promise.resolve().then(() => joinSolo(tournamentId, x)),
      Promise.resolve().then(() => joinSolo(tournamentId, y)),
    ])
    assert(rx.ok && ry.ok, `both should succeed (capacity allows it): ${JSON.stringify([rx, ry])}`)
    assert(countWaitingSoloTeams(db!, tournamentId) === 1, 'exactly 1 waiting solo must remain (the racer who did not pair with A)')
    assert(countOversizedTeams(db!, tournamentId) === 0, 'no team must have >2 confirmed members')
    assert(
      countRows(db!, `SELECT COUNT(DISTINCT profile_id) as count FROM tournament_entries WHERE tournament_id = ?;`, tournamentId) === 3,
      'no duplicate participant rows',
    )
  })

  await check('[19]/[20]/[21] leave + concurrent solo join serialize cleanly: invariant holds, no double-assignment, no orphan team', async () => {
    const [creator, a, b, c, d] = allocProfiles(5)
    const tournamentId = createTournament(32, creator, 'C19-21')
    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed A failed')
    const joinB = joinSolo(tournamentId, b)
    if (!joinB.ok) throw new Error('seed B failed')
    const abTeamId = joinA.entry.teamId as string
    const joinC = joinSolo(tournamentId, c)
    if (!joinC.ok) throw new Error('seed C failed')

    // B leave (opens a vacancy on A's team, C is the existing waiting solo)
    // races against D's brand-new solo join — both mutations are fully
    // serialized by BEGIN IMMEDIATE (single synchronous SQLite connection,
    // no interleaving possible mid-transaction), so this proves the FINAL
    // state is consistent regardless of which commits first, not that they
    // literally execute in parallel.
    const [leaveResult, joinD] = await Promise.all([
      Promise.resolve().then(() => economy.leaveTournamentAndRefundAtomically(tournamentId, b)),
      Promise.resolve().then(() => joinSolo(tournamentId, d)),
    ])
    assert(leaveResult.ok, `leave failed: ${JSON.stringify(leaveResult)}`)
    assert(joinD.ok, `D join failed: ${JSON.stringify(joinD)}`)

    assert(countWaitingSoloTeams(db!, tournamentId) <= 1, `[19] invariant violated: waiting solo count > 1`)
    assert(countOversizedTeams(db!, tournamentId) === 0, '[20] no team must exceed 2 confirmed members')
    assert(countLegacyNullTeamSolos(db!, tournamentId) === 0, '[21] no confirmed solo orphan with team_id=NULL')
    // No lost/duplicated entries regardless of ordering.
    assert(
      countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId) === 3,
      'expected exactly 3 confirmed participants (A, C, D — B refunded)',
    )
    assert(getEntry(db!, tournamentId, a)!.team_id === abTeamId, 'A must still be on the original team_id throughout')
  })

  // ══════════════════════════════ SECTION D: EXPLICIT PARTNER ISOLATION ══════════════════════════════

  await check('[22]/[23] solo replacement NEVER consumes a partner_inviter or touches their pending invite', () => {
    const [creator, a, b, inviter, invitee] = allocProfiles(5)
    const tournamentId = createTournament(32, creator, 'D22-23')
    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed A failed')
    const joinB = joinSolo(tournamentId, b)
    if (!joinB.ok) throw new Error('seed B failed')
    const abTeamId = joinA.entry.teamId as string

    // An explicit pending invite exists — its forming team must NEVER be
    // picked as a "waiting solo" replacement candidate.
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee)
    if (!invite.ok) throw new Error('seed invite failed')
    const inviteTeamIdBefore = invite.invite.teamId
    const inviteSnapshotBefore = JSON.stringify(db!.prepare(`SELECT * FROM tournament_partner_invites WHERE invite_id = ?;`).get(invite.invite.inviteId))

    // B leaves A+B — there is no OTHER genuine waiting solo, so this should
    // demote A to forming, NOT reach for the pending inviter's team.
    const leaveResult = economy.leaveTournamentAndRefundAtomically(tournamentId, b)
    assert(leaveResult.ok, `leave failed: ${JSON.stringify(leaveResult)}`)
    if (!leaveResult.ok) return
    assert(leaveResult.soloTeamCompositionChanged?.affectedProfileIds.length === 1, 'expected the demote-to-forming path (no replacement found)')

    const inviterEntryAfter = getEntry(db!, tournamentId, inviter)!
    assert(inviterEntryAfter.team_id === inviteTeamIdBefore, 'inviter must stay on their own pending-invite team')
    assert(inviterEntryAfter.joined_as === 'partner_inviter', 'inviter must remain joined_as=partner_inviter (never consumed as solo)')
    const inviteSnapshotAfter = JSON.stringify(db!.prepare(`SELECT * FROM tournament_partner_invites WHERE invite_id = ?;`).get(invite.invite.inviteId))
    assert(inviteSnapshotBefore === inviteSnapshotAfter, 'the pending invite row must be byte-for-byte unchanged')
    assert(getTeam(db!, abTeamId)!.status === 'forming', 'A must be the canonical waiting solo, not the inviter')
  })

  await check('[24] an accepted explicit partner team remains untouched by an unrelated solo leave', () => {
    const [creator, a, b, inviter, invitee] = allocProfiles(5)
    const tournamentId = createTournament(32, creator, 'D24')
    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed A failed')
    const joinB = joinSolo(tournamentId, b)
    if (!joinB.ok) throw new Error('seed B failed')

    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee)
    if (!invite.ok) throw new Error('seed invite failed')
    const accept = economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, invitee)
    if (!accept.ok) throw new Error('seed accept failed')
    const explicitTeamId = getEntry(db!, tournamentId, inviter)!.team_id as string
    const explicitSnapshotBefore = JSON.stringify(getTeamMembers(db!, explicitTeamId))

    const leaveResult = economy.leaveTournamentAndRefundAtomically(tournamentId, b)
    assert(leaveResult.ok, `leave failed: ${JSON.stringify(leaveResult)}`)

    const explicitSnapshotAfter = JSON.stringify(getTeamMembers(db!, explicitTeamId))
    assert(explicitSnapshotBefore === explicitSnapshotAfter, 'accepted explicit partner team must be byte-for-byte unchanged')
    assert(getTeam(db!, explicitTeamId)!.status === 'complete', 'explicit team must remain complete')
  })

  // ══════════════════════════════ PRODUCTION-SHAPED FIXTURE ══════════════════════════════

  await check('[production fixture] exact reproduction of tournament 63e1d125 reconciles to the expected shape', () => {
    const [creator, vanyo, georgi, mi6etyyy, mimojef, terminator, meteopa, joro81] = allocProfiles(8)
    const tournamentId = createTournament(32, creator, 'Production Fixture')

    // Ваньо — partner_inviter, forming team, pending explicit invite.
    const vanyoInvite = economy.createPartnerInviteAtomically(tournamentId, vanyo, georgi)
    if (!vanyoInvite.ok) throw new Error('seed Ваньо invite failed')
    const vanyoTeamId = vanyoInvite.invite.teamId

    // Mi6etyyy + Mimojef — complete explicit partner team.
    const explicitInvite = economy.createPartnerInviteAtomically(tournamentId, mi6etyyy, mimojef)
    if (!explicitInvite.ok) throw new Error('seed Mi6etyyy invite failed')
    const explicitAccept = economy.acceptPartnerInviteAtomically(tournamentId, explicitInvite.invite.inviteId, mimojef)
    if (!explicitAccept.ok) throw new Error('seed Mimojef accept failed')
    const explicitTeamId = getEntry(db!, tournamentId, mi6etyyy)!.team_id as string

    // Terminator, METEOPA, Joro 81 — 3 legacy solo + team_id=NULL, FIFO order.
    seedLegacyOrphanSoloEntry(db!, tournamentId, terminator, '2026-08-29T18:00:00.000Z')
    seedLegacyOrphanSoloEntry(db!, tournamentId, meteopa, '2026-08-29T18:05:00.000Z')
    seedLegacyOrphanSoloEntry(db!, tournamentId, joro81, '2026-08-29T18:10:00.000Z')
    for (const [profileId] of [[terminator], [meteopa], [joro81]] as const) {
      db!.prepare(`
        INSERT INTO tournament_economy_ledger (ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount)
        VALUES (?, ?, ?, ?, 'entry_fee_debit', 5000);
      `).run(randomUUID(), `legacy-debit:${profileId}`, tournamentId, profileId)
    }

    assert(
      countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId) === 6,
      'sanity: exactly 6 confirmed participants before reconciliation',
    )

    const vanyoSnapshotBefore = JSON.stringify(getEntry(db!, tournamentId, vanyo))
    const explicitSnapshotBefore = JSON.stringify(getTeamMembers(db!, explicitTeamId))
    const ledgerBefore = JSON.stringify(db!.prepare(`SELECT * FROM tournament_economy_ledger WHERE tournament_id = ? ORDER BY ledger_id;`).all(tournamentId))
    const walletsBefore = [terminator, meteopa, joro81, vanyo, mi6etyyy, mimojef].map((p) => getWalletBalance(db!, p))

    const result = economy.reconcileLegacySoloEntriesForTournamentAtomically(tournamentId)
    assert(!result.alreadyClean && result.pairedTeams === 1 && result.waitingTeamCreated, `expected 1 complete + 1 forming from the 3 legacy solos, got ${JSON.stringify(result)}`)

    // Ваньо/pending invite untouched.
    assert(JSON.stringify(getEntry(db!, tournamentId, vanyo)) === vanyoSnapshotBefore, 'Ваньо must be byte-for-byte unchanged')
    assert(getTeam(db!, vanyoTeamId)!.status === 'forming', 'Ваньо\'s pending-invite team must remain forming')

    // Mi6etyyy + Mimojef untouched.
    assert(JSON.stringify(getTeamMembers(db!, explicitTeamId)) === explicitSnapshotBefore, 'Mi6etyyy+Mimojef team must be byte-for-byte unchanged')

    // Terminator + METEOPA -> complete solo team.
    const termEntry = getEntry(db!, tournamentId, terminator)!
    const meteoEntry = getEntry(db!, tournamentId, meteopa)!
    assert(termEntry.team_id === meteoEntry.team_id, 'Terminator + METEOPA must be paired (oldest two)')
    assert(getTeam(db!, termEntry.team_id as string)!.status === 'complete', 'Terminator+METEOPA must be a complete team')

    // Joro 81 -> the ONLY waiting solo.
    const joroEntry = getEntry(db!, tournamentId, joro81)!
    assert(joroEntry.team_id !== termEntry.team_id, 'Joro 81 must be on a separate team')
    assert(getTeam(db!, joroEntry.team_id as string)!.status === 'forming', 'Joro 81 must be the canonical waiting solo')
    assert(countWaitingSoloTeams(db!, tournamentId) === 1, 'exactly 1 waiting solo tournament-wide')
    assert(countLegacyNullTeamSolos(db!, tournamentId) === 0, 'no legacy orphans should remain')

    // All 6 still confirmed, economy untouched.
    assert(
      countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId) === 6,
      'all 6 confirmed participants must remain confirmed',
    )
    const ledgerAfter = JSON.stringify(db!.prepare(`SELECT * FROM tournament_economy_ledger WHERE tournament_id = ? ORDER BY ledger_id;`).all(tournamentId))
    const walletsAfter = [terminator, meteopa, joro81, vanyo, mi6etyyy, mimojef].map((p) => getWalletBalance(db!, p))
    assert(ledgerBefore === ledgerAfter, 'ledger snapshot must be byte-for-byte unchanged')
    assert(JSON.stringify(walletsBefore) === JSON.stringify(walletsAfter), 'wallet snapshots must be unchanged')
  })

  // ── Integrity ──
  await check('[integrity] foreign_key_check is clean', () => {
    const fkCheck = db!.prepare('PRAGMA foreign_key_check;').all()
    assert(fkCheck.length === 0, `foreign key violations: ${JSON.stringify(fkCheck)}`)
  })
  await check('[integrity] integrity_check is ok', () => {
    const integrityCheck = db!.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }
    assert(integrityCheck.integrity_check === 'ok', `integrity_check: ${integrityCheck.integrity_check}`)
  })
} finally {
  try { economyStore?.close() } catch {}
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentSoloLifecycleReconciliation failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentSoloLifecycleReconciliation passed: ${passed} checks`)
