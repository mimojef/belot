/**
 * checkTournamentPartnerGlobalSearch.ts
 *
 * Regression за global partner search (§ "НОВО ИЗИСКВАНЕ" — "Избери
 * партньор" вече не е ограничен само до приятели). Store-level, реална
 * SQLite база с всички migrations, директно извикване на
 * createTournamentEconomyStore (огледало на
 * checkTournamentActiveParticipationGuard.ts's seed pattern).
 *
 * [1]  non-friend registered human се намира от getGlobalPartnerCandidatesForTournament.
 * [2]  friend user СЪЩО се намира от global search (двата source-а са независими,
 *      не dedupe-нати — виж § "UX DETAILS").
 * [3]  friends list (getPartnerCandidatesForTournament) продължава да работи
 *      независимо от global search — приятелят остава в резултата дори ако
 *      никога не е бил търсен глобално.
 * [6]  self (inviterProfileId) никога не се появява в global search резултатите.
 * [7]  bot профил никога не се появява в global search резултатите (само
 *      profile_kind='human' е валиден tournament partner).
 * [8]  празен normalizedTerm → [] (defensive early return, огледало на
 *      searchPublicProfiles).
 * [9]  LIMIT: > 20 съвпадения → точно 20 резултата.
 * [10] case-insensitive bg-BG normalization (кирилица) работи идентично на
 *      normalizeProfileSearchTerm/normalized_display_name pipeline-а.
 * [14] non-friend МОЖЕ да получи invite — createPartnerInviteAtomically вече
 *      НЕ връща 'not_friend' за non-friend eligible target (root fix-ът).
 * [15] friend invite продължава да работи (не е счупен от премахването на gate-а).
 * [16] nonexistent target се отказва server-side (invalid_invitee) независимо
 *      дали идва от global search UI-я или директно forged request.
 * [17] duplicate/pending invite behavior остава: втори create за същата двойка
 *      връща idempotent success (същия invite id), не нов ред.
 * [Block] blocked non-friend target остава excluded от eligibility (reason
 *      'blocked'), дори вече да не е 'not_friend' — доказва, че премахването
 *      на friends-only gate-а НЕ е отслабило block guard-а.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { normalizeProfileSearchTerm } from '../src/db/normalizeProfileIdentityText.js'

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

function bgLower(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('bg-BG')
}

function insertProfile(
  database: DatabaseSync,
  opts: {
    profileId: string
    displayName?: string
    profileKind?: 'human' | 'bot'
    accountId?: string
  },
): void {
  const displayName = opts.displayName ?? opts.profileId
  const kind = opts.profileKind ?? 'human'
  const accountId = opts.accountId ?? opts.profileId
  if (kind === 'human') {
    database.prepare(`
      INSERT OR IGNORE INTO accounts (account_id, email, password_hash, role, status)
      VALUES (?, ?, 'hash', 'player', 'active');
    `).run(accountId, `${opts.profileId}@example.test`)
  }
  database.prepare(`
    INSERT OR IGNORE INTO profiles (
      profile_id, account_id, display_name, normalized_display_name, profile_kind, status
    ) VALUES (?, ?, ?, ?, ?, 'active');
  `).run(opts.profileId, kind === 'human' ? accountId : null, displayName, bgLower(displayName), kind)
  database.prepare(`
    INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 1000000);
  `).run(opts.profileId)
}

function insertTournament(
  database: DatabaseSync,
  tournamentId: string,
  creatorProfileId: string,
  status = 'open',
): void {
  insertProfile(database, { profileId: creatorProfileId })
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status,
      started_at, finished_at
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 5000, 8, 'fill', NULL, ?, CURRENT_TIMESTAMP, NULL);
  `).run(tournamentId, `Search test ${tournamentId}`, creatorProfileId, status)
}

function insertAcceptedFriendship(database: DatabaseSync, profileA: string, profileB: string): void {
  const [lower, higher] = [profileA, profileB].sort()
  database.prepare(`
    INSERT INTO profile_friendships (
      friendship_id, requester_profile_id, addressee_profile_id,
      lower_profile_id, higher_profile_id, status
    ) VALUES (?, ?, ?, ?, ?, 'accepted');
  `).run(randomUUID(), profileA, profileB, lower, higher)
}

function insertBlock(database: DatabaseSync, blockerProfileId: string, blockedProfileId: string): void {
  database.prepare(`
    INSERT INTO player_blocks (blocker_profile_id, blocked_profile_id)
    VALUES (?, ?);
  `).run(blockerProfileId, blockedProfileId)
}

const tempDir = await mkdtemp(join(tmpdir(), 'belot-partner-global-search-'))
const dbPath = join(tempDir, 'server.db')

const database = new DatabaseSync(dbPath)
await applyMigrations(database)

const economyStore = await createTournamentEconomyStore(dbPath)

console.log('\n=== Tournament Partner Global Search ===\n')

const inviter = 'inviter-profile'
insertProfile(database, { profileId: inviter, displayName: 'Inviter' })

const tournamentId = 'search-tournament-1'
insertTournament(database, tournamentId, 'creator-search-1')

// [1] non-friend registered human is found by global search.
const nonFriend = 'nonfriend-mimo'
insertProfile(database, { profileId: nonFriend, displayName: 'Mimo123' })
{
  const term = normalizeProfileSearchTerm('Mimo')
  const results = economyStore.getGlobalPartnerCandidatesForTournament(tournamentId, inviter, term)
  check(
    '[1] non-friend registered human is found by global search',
    results.some((r) => r.profileId === nonFriend && r.eligible === true),
    JSON.stringify(results),
  )
}

// [2] friend is ALSO found by global search (independent, not deduped away).
const friend = 'friend-mimosa'
insertProfile(database, { profileId: friend, displayName: 'Mimosa' })
insertAcceptedFriendship(database, inviter, friend)
{
  const term = normalizeProfileSearchTerm('Mimo')
  const results = economyStore.getGlobalPartnerCandidatesForTournament(tournamentId, inviter, term)
  check(
    '[2] friend user is ALSO found by global search',
    results.some((r) => r.profileId === friend && r.eligible === true),
    JSON.stringify(results),
  )
}

// [3] friends list is independent — friend appears there regardless of any search.
{
  const friendsList = economyStore.getPartnerCandidatesForTournament(tournamentId, inviter)
  check(
    '[3] friends list (getPartnerCandidatesForTournament) still returns the friend',
    friendsList.some((r) => r.profileId === friend),
    JSON.stringify(friendsList),
  )
  check(
    '[3b] friends list does NOT include the non-friend (friends source untouched)',
    !friendsList.some((r) => r.profileId === nonFriend),
    JSON.stringify(friendsList),
  )
}

// [6] self never appears in global search results.
{
  const term = normalizeProfileSearchTerm('Inviter')
  const results = economyStore.getGlobalPartnerCandidatesForTournament(tournamentId, inviter, term)
  check(
    '[6] self (inviterProfileId) never appears in global search results',
    !results.some((r) => r.profileId === inviter),
    JSON.stringify(results),
  )
}

// [7] bots never appear in global search results.
const botProfile = 'bot-search-target'
insertProfile(database, { profileId: botProfile, displayName: 'BotSearchTarget', profileKind: 'bot' })
{
  const term = normalizeProfileSearchTerm('BotSearchTarget')
  const results = economyStore.getGlobalPartnerCandidatesForTournament(tournamentId, inviter, term)
  check(
    '[7] bot profiles never appear in global search results',
    !results.some((r) => r.profileId === botProfile),
    JSON.stringify(results),
  )
}

// [8] empty normalized term -> [].
{
  const results = economyStore.getGlobalPartnerCandidatesForTournament(tournamentId, inviter, '')
  check('[8] empty normalized term returns []', Array.isArray(results) && results.length === 0)
}

// [9] LIMIT enforced: > 20 matches -> exactly 20 results.
{
  for (let i = 0; i < 25; i++) {
    insertProfile(database, { profileId: `limit-target-${i}`, displayName: `LimitTarget${i}` })
  }
  const term = normalizeProfileSearchTerm('LimitTarget')
  const results = economyStore.getGlobalPartnerCandidatesForTournament(tournamentId, inviter, term)
  check('[9] result is capped at LIMIT 20 even with 25 matches', results.length === 20, `got ${results.length}`)
}

// [10] Cyrillic case-insensitive normalization.
{
  const cyrillicProfile = 'cyrillic-target'
  insertProfile(database, { profileId: cyrillicProfile, displayName: 'Ивайло' })
  const term = normalizeProfileSearchTerm('ИВАЙЛО')
  const results = economyStore.getGlobalPartnerCandidatesForTournament(tournamentId, inviter, term)
  check(
    '[10] Cyrillic case-insensitive search finds the profile',
    results.some((r) => r.profileId === cyrillicProfile),
    JSON.stringify(results),
  )
}

// [14] non-friend CAN receive an invite — the root fix.
{
  const target = 'invite-target-nonfriend'
  insertProfile(database, { profileId: target, displayName: 'InviteTargetNonFriend' })
  const result = economyStore.createPartnerInviteAtomically(tournamentId, inviter, target, {})
  check(
    '[14] non-friend eligible target CAN receive a tournament partner invite',
    result.ok === true,
    JSON.stringify(result),
  )
}

// [15] friend invite still works (not broken by removing the gate). Uses a
// FRESH inviter (not the shared `inviter` from earlier tests, which is
// already confirmed in `tournamentId` from [14] — the pre-existing,
// unrelated "one active tournament per account" restriction would otherwise
// correctly reject a second create from that same account, which is not
// what this check is about).
{
  const friendTournamentId = 'search-tournament-friend-invite'
  const freshInviter = 'fresh-inviter-for-friend-invite'
  insertProfile(database, { profileId: freshInviter, displayName: 'FreshInviterForFriendInvite' })
  insertAcceptedFriendship(database, freshInviter, friend)
  insertTournament(database, friendTournamentId, 'creator-friend-invite')
  const result = economyStore.createPartnerInviteAtomically(friendTournamentId, freshInviter, friend, {})
  check('[15] friend invite still works', result.ok === true, JSON.stringify(result))
}

// [16] nonexistent target is rejected server-side.
{
  const rejectTournamentId = 'search-tournament-reject'
  insertTournament(database, rejectTournamentId, 'creator-reject')
  const result = economyStore.createPartnerInviteAtomically(rejectTournamentId, inviter, 'does-not-exist-profile-id', {})
  check(
    '[16] nonexistent/invalid target is rejected server-side',
    result.ok === false && result.reason === 'invalid_invitee',
    JSON.stringify(result),
  )
}

// [17] duplicate/pending invite idempotency preserved. Fresh inviter account
// (same reasoning as [15] — the shared `inviter` is already confirmed
// elsewhere by this point in the script).
{
  const dupTournamentId = 'search-tournament-dup'
  const dupInviter = 'fresh-inviter-for-dup-test'
  insertProfile(database, { profileId: dupInviter, displayName: 'FreshInviterForDupTest' })
  insertTournament(database, dupTournamentId, 'creator-dup')
  const target = 'dup-invite-target'
  insertProfile(database, { profileId: target, displayName: 'DupInviteTarget' })
  const first = economyStore.createPartnerInviteAtomically(dupTournamentId, dupInviter, target, {})
  assert(first.ok === true, `first invite unexpectedly failed: ${JSON.stringify(first)}`)
  const second = economyStore.createPartnerInviteAtomically(dupTournamentId, dupInviter, target, {})
  check(
    '[17] duplicate pending invite is idempotent (same invite, no error)',
    second.ok === true && first.ok === true && second.invite.inviteId === first.invite.inviteId,
    JSON.stringify({ first, second }),
  )
}

// [Block] blocked non-friend target remains excluded — friends-only removal did not weaken block guard.
{
  const blockedTournamentId = 'search-tournament-blocked'
  insertTournament(database, blockedTournamentId, 'creator-blocked')
  const blockedTarget = 'blocked-nonfriend-target'
  insertProfile(database, { profileId: blockedTarget, displayName: 'BlockedNonFriendTarget' })
  insertBlock(database, inviter, blockedTarget)
  const result = economyStore.createPartnerInviteAtomically(blockedTournamentId, inviter, blockedTarget, {})
  check(
    '[Block] blocked non-friend target is still rejected (reason blocked)',
    result.ok === false && result.reason === 'blocked',
    JSON.stringify(result),
  )
}

assert(failed === 0, `${failed} checks failed`)

console.log(`\ncheckTournamentPartnerGlobalSearch passed=${passed} failed=${failed}`)
