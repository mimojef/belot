/**
 * checkTournamentForceRemove.ts
 *
 * Store-level regression за creator/admin moderation force-remove feature
 * (§ task spec: "Създателят на OPEN tournament трябва да може принудително
 * да отпише..."). Огледален pattern на checkTournamentActiveParticipationGuard.ts
 * / checkTournamentPartnerLifecycle.ts — реална SQLite база с всички
 * migrations, директно извикване на createTournamentEconomyStore, никакъв
 * HTTP/WS слой (authorization/route-level 403 gating е верифицирано чрез
 * code review на index.ts handleTournamentForceRemove{Team,Entry}Request,
 * не тук — focused store-level scope).
 *
 * Покрива:
 *  A. Complete team removal — двамата refunded точно веднъж, team изтрит,
 *     и двамата blocked от rejoin (solo join), несвързани teams непокътнати.
 *  B. Forming solo removal — refund веднъж, forming team изтрит, blocked.
 *  C. Explicit pending invite — remove inviter -> pending invite става
 *     non-pending, invitee НЕ е refunded/blocked само защото е бил поканен.
 *  D. Rejoin denial през и трите protected entry paths: join solo,
 *     create-invite като blocked inviter, accept-invite като blocked invitee.
 *  E. Account-scoped block guard — блокиран профил не може да заобиколи
 *     забраната чрез sibling профил на СЪЩИЯ акаунт.
 *  F. Idempotency — retry на force-remove след успешен removal не дублира
 *     refund (team/entry вече не съществува -> harmless failure, wallet
 *     balance стабилен).
 *  G. tournament_not_open / team_not_complete / entry_not_confirmed guard-и.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
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
  status = 'open',
): void {
  insertProfile(database, creatorProfileId)
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, fill_expires_at, status,
      started_at, finished_at
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 5000, 8, 'fill', NULL, datetime('now', '+1 hour'), ?,
      CASE WHEN ? = 'open' THEN NULL ELSE CURRENT_TIMESTAMP END, NULL
    );
  `).run(tournamentId, `Force-remove ${tournamentId}`, creatorProfileId, status, status)
}

function getWalletBalance(database: DatabaseSync, profileId: string): number {
  return (database.prepare(`
    SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;
  `).get(profileId) as { yellow_coins_balance: number }).yellow_coins_balance
}

function countRefundLedgerRows(database: DatabaseSync, tournamentId: string, profileId: string): number {
  return (database.prepare(`
    SELECT COUNT(*) as count FROM tournament_economy_ledger
    WHERE tournament_id = ? AND profile_id = ? AND entry_type = 'entry_fee_refund';
  `).get(tournamentId, profileId) as { count: number }).count
}

function countTeamsForTournament(database: DatabaseSync, tournamentId: string): number {
  return (database.prepare(`
    SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?;
  `).get(tournamentId) as { count: number }).count
}

function getEntryStatus(database: DatabaseSync, tournamentId: string, profileId: string): string | undefined {
  const row = database.prepare(`
    SELECT status FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;
  `).get(tournamentId, profileId) as { status: string } | undefined
  return row?.status
}

function getBlockRow(database: DatabaseSync, tournamentId: string, profileId: string):
  { actor_role: string; reason: string } | undefined {
  return database.prepare(`
    SELECT actor_role, reason FROM tournament_participation_blocks
    WHERE tournament_id = ? AND blocked_profile_id = ?;
  `).get(tournamentId, profileId) as { actor_role: string; reason: string } | undefined
}

const tempDir = await mkdtemp(join(tmpdir(), 'belot-force-remove-'))
const dbPath = join(tempDir, 'server.db')
const database = new DatabaseSync(dbPath)
await applyMigrations(database)
const economyStore = await createTournamentEconomyStore(dbPath)

// ─── A. Complete team removal ──────────────────────────────────────────────
{
  const tournamentId = 'tour-complete'
  const creatorId = 'creator-complete'
  const soloA = 'complete-a'
  const soloB = 'complete-b'
  const unrelatedC = 'complete-c'
  const unrelatedD = 'complete-d'
  insertTournament(database, tournamentId, creatorId)
  insertProfile(database, soloA)
  insertProfile(database, soloB)
  insertProfile(database, unrelatedC)
  insertProfile(database, unrelatedD)

  const joinA = economyStore.joinTournamentSoloAtomically(tournamentId, soloA)
  assert(joinA.ok, 'setup: A join failed')
  const joinB = economyStore.joinTournamentSoloAtomically(tournamentId, soloB)
  assert(joinB.ok, 'setup: B join failed')
  check('A+B auto-paired into a complete team', joinB.ok && joinB.autoPairedWithProfileId === soloA)

  // Unrelated complete team C+D, must stay untouched by A+B's removal.
  const joinC = economyStore.joinTournamentSoloAtomically(tournamentId, unrelatedC)
  assert(joinC.ok, 'setup: C join failed')
  const joinD = economyStore.joinTournamentSoloAtomically(tournamentId, unrelatedD)
  assert(joinD.ok, 'setup: D join failed')

  const teamAB = joinB.ok ? joinB.entry.teamId! : ''
  const teamCD = joinD.ok ? joinD.entry.teamId! : ''
  assert(teamAB !== '' && teamCD !== '' && teamAB !== teamCD, 'setup: expected two distinct complete teams')

  const balanceBeforeA = getWalletBalance(database, soloA)
  const balanceBeforeB = getWalletBalance(database, soloB)

  const removeResult = economyStore.forceRemoveTeamAtomically(tournamentId, teamAB, creatorId)
  check('forceRemoveTeamAtomically ok=true for complete team', removeResult.ok === true, JSON.stringify(removeResult))
  if (removeResult.ok) {
    check('removedProfiles has exactly A and B', removeResult.removedProfiles.length === 2 &&
      removeResult.removedProfiles.some((p) => p.profileId === soloA) &&
      removeResult.removedProfiles.some((p) => p.profileId === soloB))
    check('actorIsCreator true (creator acted)', removeResult.actorIsCreator === true)
  }

  check('A refunded exactly once (wallet)', getWalletBalance(database, soloA) === balanceBeforeA + 5000)
  check('B refunded exactly once (wallet)', getWalletBalance(database, soloB) === balanceBeforeB + 5000)
  check('A has exactly one refund ledger row', countRefundLedgerRows(database, tournamentId, soloA) === 1)
  check('B has exactly one refund ledger row', countRefundLedgerRows(database, tournamentId, soloB) === 1)
  check('A entry status is refunded', getEntryStatus(database, tournamentId, soloA) === 'refunded')
  check('B entry status is refunded', getEntryStatus(database, tournamentId, soloB) === 'refunded')
  check('team A+B row deleted', database.prepare(`SELECT 1 FROM tournament_teams WHERE team_id = ?;`).get(teamAB) === undefined)
  check('unrelated team C+D untouched', database.prepare(`SELECT status FROM tournament_teams WHERE team_id = ?;`).get(teamCD) !== undefined)
  check('C still confirmed', getEntryStatus(database, tournamentId, unrelatedC) === 'confirmed')
  check('D still confirmed', getEntryStatus(database, tournamentId, unrelatedD) === 'confirmed')

  const blockA = getBlockRow(database, tournamentId, soloA)
  const blockB = getBlockRow(database, tournamentId, soloB)
  check('A blocked with actor_role=player, reason=force_removed', blockA?.actor_role === 'player' && blockA?.reason === 'force_removed')
  check('B blocked with actor_role=player, reason=force_removed', blockB?.actor_role === 'player' && blockB?.reason === 'force_removed')

  const rejoinA = economyStore.joinTournamentSoloAtomically(tournamentId, soloA)
  check('A rejoin denied with participation_blocked', rejoinA.ok === false && rejoinA.reason === 'participation_blocked', JSON.stringify(rejoinA))
  const rejoinB = economyStore.joinTournamentSoloAtomically(tournamentId, soloB)
  check('B rejoin denied with participation_blocked', rejoinB.ok === false && rejoinB.reason === 'participation_blocked', JSON.stringify(rejoinB))
  check('no new debit for A on denied rejoin', countRefundLedgerRows(database, tournamentId, soloA) === 1)

  // Idempotency: retry against an already-deleted team must not double-refund.
  const balanceAfterFirstRemoval = getWalletBalance(database, soloA)
  const retryResult = economyStore.forceRemoveTeamAtomically(tournamentId, teamAB, creatorId)
  check('retry force-remove on deleted team fails harmlessly', retryResult.ok === false && retryResult.reason === 'team_not_found')
  check('retry does not change A wallet balance', getWalletBalance(database, soloA) === balanceAfterFirstRemoval)
  check('retry does not add a second refund ledger row for A', countRefundLedgerRows(database, tournamentId, soloA) === 1)
}

// ─── B/C. Forming solo removal + explicit pending invite cancellation ──────
{
  const tournamentId = 'tour-forming'
  const creatorId = 'creator-forming'
  const waitingSolo = 'forming-solo'
  const inviter = 'forming-inviter'
  const invitee = 'forming-invitee'
  insertTournament(database, tournamentId, creatorId)
  insertProfile(database, waitingSolo)
  insertProfile(database, inviter)

  // B: lone waiting solo.
  const joinSolo = economyStore.joinTournamentSoloAtomically(tournamentId, waitingSolo)
  assert(joinSolo.ok, 'setup: waiting solo join failed')
  const soloEntryId = joinSolo.ok ? joinSolo.entry.entryId : ''
  const soloTeamId = joinSolo.ok ? joinSolo.entry.teamId! : ''
  check('waiting solo team is forming', database.prepare(`SELECT status FROM tournament_teams WHERE team_id = ?;`).get(soloTeamId) !== undefined)

  const balanceBeforeSolo = getWalletBalance(database, waitingSolo)
  const removeSoloResult = economyStore.forceRemoveEntryAtomically(tournamentId, soloEntryId, creatorId)
  check('forceRemoveEntryAtomically ok=true for waiting solo', removeSoloResult.ok === true, JSON.stringify(removeSoloResult))
  if (removeSoloResult.ok) {
    check('removedProfileId matches waiting solo', removeSoloResult.removedProfileId === waitingSolo)
    check('cancelledInvite is null for plain solo', removeSoloResult.cancelledInvite === null)
  }
  check('solo refunded exactly once', getWalletBalance(database, waitingSolo) === balanceBeforeSolo + 5000)
  check('solo forming team row deleted', database.prepare(`SELECT 1 FROM tournament_teams WHERE team_id = ?;`).get(soloTeamId) === undefined)
  const soloBlock = getBlockRow(database, tournamentId, waitingSolo)
  check('waiting solo blocked from rejoin', soloBlock !== undefined)
  const rejoinSolo = economyStore.joinTournamentSoloAtomically(tournamentId, waitingSolo)
  check('waiting solo rejoin denied', rejoinSolo.ok === false && rejoinSolo.reason === 'participation_blocked')

  // C: partner_inviter with a pending explicit invite.
  insertProfile(database, invitee)
  const createInvite = economyStore.createPartnerInviteAtomically(tournamentId, inviter, invitee)
  assert(createInvite.ok, `setup: create invite failed: ${JSON.stringify(createInvite)}`)
  const inviterEntry = database.prepare(`
    SELECT entry_id, team_id FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;
  `).get(tournamentId, inviter) as { entry_id: string; team_id: string }
  const pendingInviteRow = database.prepare(`
    SELECT invite_id, status FROM tournament_partner_invites WHERE tournament_id = ? AND inviter_profile_id = ?;
  `).get(tournamentId, inviter) as { invite_id: string; status: string }
  check('pending invite is pending before removal', pendingInviteRow.status === 'pending')

  const balanceBeforeInviter = getWalletBalance(database, inviter)
  const balanceBeforeInvitee = getWalletBalance(database, invitee)
  const removeInviterResult = economyStore.forceRemoveEntryAtomically(tournamentId, inviterEntry.entry_id, creatorId)
  check('forceRemoveEntryAtomically ok=true for partner_inviter', removeInviterResult.ok === true, JSON.stringify(removeInviterResult))
  if (removeInviterResult.ok) {
    check('cancelledInvite matches the pending invite', removeInviterResult.cancelledInvite?.inviteId === pendingInviteRow.invite_id)
    check('cancelledInvite carries invitee profileId', removeInviterResult.cancelledInvite?.inviteeProfileId === invitee)
  }
  check('inviter refunded exactly once', getWalletBalance(database, inviter) === balanceBeforeInviter + 5000)
  check('invitee NOT refunded (was never a confirmed participant)', getWalletBalance(database, invitee) === balanceBeforeInvitee)
  // The invite row itself cascade-deletes with its team (FK ON DELETE
  // CASCADE, tournament_partner_invites.team_id -> tournament_teams —
  // same convention leaveTournamentAndRefundAtomically already relies on
  // for the explicit-partner-team branch) — "no longer pending" is
  // satisfied by the row no longer existing at all, not by a status flip
  // that would immediately be cascaded away anyway.
  const inviteAfter = database.prepare(`SELECT status FROM tournament_partner_invites WHERE invite_id = ?;`).get(pendingInviteRow.invite_id) as { status: string } | undefined
  check('pending invite row no longer exists (cascade-deleted with the team, no longer pending)', inviteAfter === undefined)
  check('inviter forming team row deleted', database.prepare(`SELECT 1 FROM tournament_teams WHERE team_id = ?;`).get(inviterEntry.team_id) === undefined)
  const inviterBlock = getBlockRow(database, tournamentId, inviter)
  const inviteeBlock = getBlockRow(database, tournamentId, invitee)
  check('inviter is blocked', inviterBlock !== undefined)
  check('invitee is NOT blocked (merely invited, never confirmed)', inviteeBlock === undefined)

  // D (remaining protected paths): blocked inviter cannot create a fresh
  // invite, and the (unblocked) invitee CAN still join solo elsewhere in
  // this same tournament without being treated as blocked.
  insertProfile(database, 'someone-else')
  const reinviteAttempt = economyStore.createPartnerInviteAtomically(tournamentId, inviter, 'someone-else')
  check('blocked ex-inviter cannot create a new invite', reinviteAttempt.ok === false && reinviteAttempt.reason === 'participation_blocked', JSON.stringify(reinviteAttempt))
  const inviteeJoinSolo = economyStore.joinTournamentSoloAtomically(tournamentId, invitee)
  check('never-blocked invitee can still join solo', inviteeJoinSolo.ok === true, JSON.stringify(inviteeJoinSolo))
}

// ─── D (continued). Blocked invitee cannot accept an invite, and a new
// invite can never even be CREATED targeting an already-blocked profile
// (defense-in-depth: getCandidateUnavailableReason checks the candidate/
// invitee side too, not just the inviter side) ─────────────────────────────
{
  const tournamentId = 'tour-accept-block'
  const creatorId = 'creator-accept-block'
  const blockedProfile = 'accept-block-target'
  const otherInviter = 'accept-block-inviter'
  const anotherInviter = 'accept-block-inviter-2'
  insertTournament(database, tournamentId, creatorId)
  insertProfile(database, blockedProfile)
  insertProfile(database, otherInviter)
  insertProfile(database, anotherInviter)

  // Invite created FIRST, while blockedProfile is still unblocked (realistic
  // race: an incoming invite already pending elsewhere at the moment the
  // creator force-removes this player from a DIFFERENT team in the same
  // tournament).
  const invite = economyStore.createPartnerInviteAtomically(tournamentId, otherInviter, blockedProfile)
  assert(invite.ok, `setup: invite creation before block should succeed: ${JSON.stringify(invite)}`)
  const inviteRow = database.prepare(`
    SELECT invite_id FROM tournament_partner_invites WHERE tournament_id = ? AND invitee_profile_id = ?;
  `).get(tournamentId, blockedProfile) as { invite_id: string }

  // Now seed the moderation block (simulating a prior force-remove having
  // just landed for this player in this same tournament).
  database.prepare(`
    INSERT INTO tournament_participation_blocks (
      block_id, tournament_id, blocked_profile_id, actor_profile_id, actor_role, reason
    ) VALUES (?, ?, ?, ?, 'player', 'force_removed');
  `).run(randomUUID(), tournamentId, blockedProfile, creatorId)

  const acceptResult = economyStore.acceptPartnerInviteAtomically(tournamentId, inviteRow.invite_id, blockedProfile)
  check('blocked invitee cannot accept a pending invite', acceptResult.ok === false && acceptResult.reason === 'participation_blocked', JSON.stringify(acceptResult))

  // Defense-in-depth: a FRESH invite (different inviter, so the "already
  // have an outgoing pending invite" idempotent short-circuit doesn't mask
  // the block check) targeting an already-blocked profile must also be
  // refused at creation time.
  const freshInviteAttempt = economyStore.createPartnerInviteAtomically(tournamentId, anotherInviter, blockedProfile)
  check(
    'new invite creation targeting an already-blocked profile is refused',
    freshInviteAttempt.ok === false && freshInviteAttempt.reason === 'participation_blocked',
    JSON.stringify(freshInviteAttempt),
  )
}

// ─── E. Account-scoped block guard ─────────────────────────────────────────
{
  const tournamentId = 'tour-account-scope'
  const creatorId = 'creator-account-scope'
  const sharedAccountId = 'shared-account-force-remove'
  const profileA = 'account-scope-a'
  const profileB = 'account-scope-b'
  insertTournament(database, tournamentId, creatorId)
  insertProfile(database, profileA, sharedAccountId)
  insertProfile(database, profileB, sharedAccountId)

  const joinA = economyStore.joinTournamentSoloAtomically(tournamentId, profileA)
  assert(joinA.ok, 'setup: profileA join failed')
  const entryIdA = joinA.ok ? joinA.entry.entryId : ''

  const removeResult = economyStore.forceRemoveEntryAtomically(tournamentId, entryIdA, creatorId)
  check('profileA force-removed', removeResult.ok === true, JSON.stringify(removeResult))

  const siblingJoinAttempt = economyStore.joinTournamentSoloAtomically(tournamentId, profileB)
  check(
    'sibling profile on the same account is also blocked (account-scoped enforcement)',
    siblingJoinAttempt.ok === false && siblingJoinAttempt.reason === 'participation_blocked',
    JSON.stringify(siblingJoinAttempt),
  )
}

// ─── G. Status/state guards ─────────────────────────────────────────────────
{
  // tournament_not_open guard.
  const tournamentId = 'tour-not-open'
  const creatorId = 'creator-not-open'
  insertTournament(database, tournamentId, creatorId, 'starting')
  const notOpenTeamResult = economyStore.forceRemoveTeamAtomically(tournamentId, 'no-such-team', creatorId)
  check('force-remove on non-open tournament refused', notOpenTeamResult.ok === false && notOpenTeamResult.reason === 'tournament_not_open')

  // team_not_complete guard: forming team cannot be removed via the team endpoint.
  const tournamentId2 = 'tour-not-complete'
  const creatorId2 = 'creator-not-complete'
  const solo2 = 'not-complete-solo'
  insertTournament(database, tournamentId2, creatorId2)
  insertProfile(database, solo2)
  const join2 = economyStore.joinTournamentSoloAtomically(tournamentId2, solo2)
  assert(join2.ok, 'setup: solo2 join failed')
  const teamId2 = join2.ok ? join2.entry.teamId! : ''
  const wrongEndpointResult = economyStore.forceRemoveTeamAtomically(tournamentId2, teamId2, creatorId2)
  check('forming team rejected via team-removal endpoint', wrongEndpointResult.ok === false && wrongEndpointResult.reason === 'team_not_complete')

  // entry_not_confirmed guard: already-refunded entry cannot be force-removed again.
  const entryId2 = join2.ok ? join2.entry.entryId : ''
  const leaveResult = economyStore.leaveTournamentAndRefundAtomically(tournamentId2, solo2)
  assert(leaveResult.ok, 'setup: voluntary leave failed')
  const doubleRemoveResult = economyStore.forceRemoveEntryAtomically(tournamentId2, entryId2, creatorId2)
  check('already-refunded entry rejected by force-remove', doubleRemoveResult.ok === false && doubleRemoveResult.reason === 'entry_not_confirmed')

  // team_not_found guard.
  const missingTeamResult = economyStore.forceRemoveTeamAtomically(tournamentId2, 'does-not-exist', creatorId2)
  check('unknown teamId rejected with team_not_found', missingTeamResult.ok === false && missingTeamResult.reason === 'team_not_found')

  // entry_not_found guard.
  const missingEntryResult = economyStore.forceRemoveEntryAtomically(tournamentId2, 'does-not-exist', creatorId2)
  check('unknown entryId rejected with entry_not_found', missingEntryResult.ok === false && missingEntryResult.reason === 'entry_not_found')
}

// ─── Admin-actor notice reason derivation ──────────────────────────────────
{
  const tournamentId = 'tour-admin-actor'
  const creatorId = 'creator-admin-actor'
  const adminProfileId = 'admin-actor-profile'
  const soloTarget = 'admin-actor-target'
  insertTournament(database, tournamentId, creatorId)
  insertProfile(database, adminProfileId)
  insertProfile(database, soloTarget)
  const join = economyStore.joinTournamentSoloAtomically(tournamentId, soloTarget)
  assert(join.ok, 'setup: admin-actor target join failed')
  const entryId = join.ok ? join.entry.entryId : ''

  const result = economyStore.forceRemoveEntryAtomically(tournamentId, entryId, adminProfileId)
  check('non-creator actor is treated as admin (actorIsCreator=false)', result.ok === true && result.actorIsCreator === false, JSON.stringify(result))
  const block = getBlockRow(database, tournamentId, soloTarget)
  check('block row records actor_role=admin for non-creator actor', block?.actor_role === 'admin')
}

assert(failed === 0, `${failed} checks failed`)

console.log(`checkTournamentForceRemove passed=${passed} failed=${failed}`)
