/**
 * checkTournamentAutoPairSolo.ts
 *
 * Targeted regression за "AUTO-PAIR SOLO PLAYERS + PARTNER CAPACITY" —
 * "Запиши се сам" вече auto-pair-ва с най-рано записания валиден чакащ solo
 * player в турнира (FIFO, deterministic DB ordering) вместо да оставя
 * team_id=NULL orphan до tournament start. "Участвай с партньор" остава
 * explicit флоу (не консумира чакащ solo) и връща специфичен
 * 'partner_requires_two_slots' reason, когато е останало точно 1 място.
 *
 * Покрива точно 12-те сценария от task spec-а (номерирани по-долу) плюс
 * допълнителни regression-и, директно причинени от промяната:
 *  [6b] BLOCKER fix — waiting solo A изпраща explicit покана (still pending)
 *       -> нов solo C НЕ трябва да auto-pair-не с A's team, защото
 *       createPartnerInviteAtomically флип-ва A's joined_as 'solo' ->
 *       'partner_inviter' В СЪЩАТА транзакция, в която създава поканата —
 *       точно полето, което FIFO query-то филтрира.
 *  [13] "Покани приятел за партньор" за вече waiting-solo участник реюзва
 *       собствения си forming отбор (не оставя orphan 0-член отбор).
 *  [14] validateAndLockTeamsForStart успешно стартира турнир, достигнал
 *       пълен капацитет с mix от genuine lone waiting-solo forming отбор и
 *       legacy team_id=NULL orphan (declined/expired invite) — виж fix-а в
 *       validateAndLockTeamsForStart за lonelyWaitingSoloTeamIds (guard-нат
 *       с joined_as==='solo' defense-in-depth).
 *  [15]/[16] CONSISTENCY fix — resetFormingTeamToSolo вече пази СЪЩИЯ
 *       forming отбор (flip joined_as обратно към 'solo') вместо team_id=NULL
 *       orphan, след cancel/decline/expire на explicit покана — следващият
 *       solo веднага auto-pair-ва deterministically, не чака tournament-start
 *       fallback shuffle-а.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'

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

type TeamRow = { team_id: string; status: string }
type EntryRow = { entry_id: string; profile_id: string; team_id: string | null; joined_as: string; status: string; created_at: string }

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

function countTeamsForTournament(database: DatabaseSync, tournamentId: string): number {
  return countRows(database, `SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ?;`, tournamentId)
}

console.log('\ncheckTournamentAutoPairSolo')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-auto-pair-solo-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)

  const profiles = Array.from({ length: 120 }, () => randomUUID())
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

  economyStore = await createTournamentEconomyStore(dbPath)
  tournamentStore = await createTournamentStore(dbPath)
  const economy = economyStore
  const store = tournamentStore

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

  // Raw seed helper — only used for the FIFO ordering probe ([5]), which
  // needs MULTIPLE simultaneously-existing waiting-solo teams to exercise
  // the ORDER BY tie-break; the atomic join flow itself only ever leaves at
  // most one such team per tournament (every 2nd solo join re-pairs it).
  function seedWaitingSoloTeam(
    tournamentId: string,
    profileId: string,
    createdAtIso: string,
    entryIdOverride?: string,
  ): { teamId: string; entryId: string } {
    const database = db as DatabaseSync
    const teamId = randomUUID()
    const entryId = entryIdOverride ?? randomUUID()
    database.prepare(`
      INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot, created_at, updated_at)
      VALUES (?, ?, 'forming', NULL, ?, ?);
    `).run(teamId, tournamentId, createdAtIso, createdAtIso)
    database.prepare(`
      INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'solo', 'confirmed', ?, ?);
    `).run(entryId, tournamentId, profileId, teamId, createdAtIso, createdAtIso)
    return { teamId, entryId }
  }

  // ── [1] First solo: 0 participants, A joins solo -> one waiting solo team ──
  await check('[1] first solo join creates a lone waiting ("forming") team', () => {
    const [creator, a] = allocProfiles(2)
    const tournamentId = createTournament(8, creator, 'Scenario 1')
    const result = joinSolo(tournamentId, a)
    assert(result.ok, `join failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.entry.teamId !== null, 'entry has no team_id')
    const team = getTeam(db!, result.entry.teamId as string)
    assert(team !== undefined, 'team row missing')
    assert(team!.status === 'forming', `expected forming, got ${team!.status}`)
    const members = getTeamMembers(db!, result.entry.teamId as string)
    assert(members.length === 1 && members[0]!.profile_id === a, 'team should contain exactly A')
    // §"REALTIME" — first solo (no match found) must NOT report a pairing;
    // this is the exact signal the HTTP handler uses to decide whether to
    // push a tournament_team_updated notice (must stay false/null here).
    assert(result.autoPairedWithProfileId === null, `expected no auto-pair on first solo, got ${result.autoPairedWithProfileId}`)
  })

  // ── [2] Second solo: A waiting, B joins -> same team A+B, ready, count=2 ──
  let scenario2TournamentId = ''
  let scenario2A = ''
  let scenario2B = ''
  await check('[2] second solo join pairs with the waiting solo -> ready team of 2', () => {
    const [creator, a, b] = allocProfiles(3)
    scenario2TournamentId = createTournament(8, creator, 'Scenario 2')
    scenario2A = a
    scenario2B = b
    const joinA = joinSolo(scenario2TournamentId, a)
    if (!joinA.ok) throw new Error('seed join A failed')
    const joinB = joinSolo(scenario2TournamentId, b)
    assert(joinB.ok, `join B failed: ${JSON.stringify(joinB)}`)
    if (!joinB.ok) return
    assert(joinA.entry.teamId === joinB.entry.teamId, 'A and B ended up on different teams')
    const team = getTeam(db!, joinB.entry.teamId as string)
    assert(team!.status === 'complete', `expected complete, got ${team!.status}`)
    const members = getTeamMembers(db!, joinB.entry.teamId as string)
    assert(members.length === 2, `expected 2 members, got ${members.length}`)
    assert(
      countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, scenario2TournamentId) === 2,
      'confirmed participant count should be 2',
    )
    // §"REALTIME" — exactly the signal the HTTP handler needs to push
    // tournament_team_updated to the waiting player (A), and only A.
    assert(joinA.autoPairedWithProfileId === null, 'A\'s own join must not report a pairing (nothing existed yet)')
    assert(joinB.autoPairedWithProfileId === a, `B's join must report auto-pairing with A, got ${joinB.autoPairedWithProfileId}`)
  })

  // ── [3] Third solo: A+B ready, C joins -> new waiting solo team ──
  let scenario3C = ''
  let scenario3CTeamId = ''
  await check('[3] third solo join (after a ready pair) starts a brand new waiting team', () => {
    const [c] = allocProfiles(1)
    scenario3C = c
    const joinC = joinSolo(scenario2TournamentId, c)
    assert(joinC.ok, `join C failed: ${JSON.stringify(joinC)}`)
    if (!joinC.ok) return
    assert(joinC.entry.teamId !== null && joinC.entry.teamId !== getEntry(db!, scenario2TournamentId, scenario2A)!.team_id, 'C should not join the already-complete A+B team')
    scenario3CTeamId = joinC.entry.teamId as string
    const team = getTeam(db!, scenario3CTeamId)
    assert(team!.status === 'forming', `expected forming, got ${team!.status}`)
    const members = getTeamMembers(db!, scenario3CTeamId)
    assert(members.length === 1 && members[0]!.profile_id === c, 'new team should contain only C')
  })

  // ── [4] Fourth solo: C waiting, D joins -> C+D ready ──
  await check('[4] fourth solo join pairs with C -> C+D ready', () => {
    const [d] = allocProfiles(1)
    const joinD = joinSolo(scenario2TournamentId, d)
    assert(joinD.ok, `join D failed: ${JSON.stringify(joinD)}`)
    if (!joinD.ok) return
    assert(joinD.entry.teamId === scenario3CTeamId, 'D should join C\'s waiting team')
    const team = getTeam(db!, scenario3CTeamId)
    assert(team!.status === 'complete', `expected complete, got ${team!.status}`)
    const members = getTeamMembers(db!, scenario3CTeamId)
    const memberIds = members.map((m) => m.profile_id).sort()
    assert(JSON.stringify(memberIds) === JSON.stringify([scenario3C, d].sort()), 'team should contain exactly C and D')
  })

  // ── [5] FIFO: multiple valid waiting solos -> next joins the oldest deterministically ──
  await check('[5a] FIFO: next solo entrant pairs with the OLDEST waiting solo team (by created_at)', () => {
    const [creator, older, newer, next] = allocProfiles(4)
    const tournamentId = createTournament(8, creator, 'Scenario 5a')
    const olderSeed = seedWaitingSoloTeam(tournamentId, older, '2026-01-01T00:00:00.000Z')
    const newerSeed = seedWaitingSoloTeam(tournamentId, newer, '2026-01-02T00:00:00.000Z')
    const result = joinSolo(tournamentId, next)
    assert(result.ok, `join failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.entry.teamId === olderSeed.teamId, 'should have paired with the older waiting team, not the newer one')
    assert(getTeam(db!, olderSeed.teamId)!.status === 'complete', 'older team should now be complete')
    assert(getTeam(db!, newerSeed.teamId)!.status === 'forming', 'newer team should remain untouched (still forming)')
  })

  await check('[5b] FIFO tie-break: identical created_at falls back to entry_id ASC (authoritative DB ordering)', () => {
    const [creator, low, high, next] = allocProfiles(4)
    const tournamentId = createTournament(8, creator, 'Scenario 5b')
    const sameTimestamp = '2026-01-01T00:00:00.000Z'
    const lowSeed = seedWaitingSoloTeam(tournamentId, low, sameTimestamp, 'entry-fifo-tie-aaa')
    const highSeed = seedWaitingSoloTeam(tournamentId, high, sameTimestamp, 'entry-fifo-tie-bbb')
    const result = joinSolo(tournamentId, next)
    assert(result.ok, `join failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.entry.teamId === lowSeed.teamId, 'tie-break should pick the lower entry_id')
    assert(getTeam(db!, highSeed.teamId)!.status === 'forming', 'the other tied team should remain untouched')
  })

  // ── [6] Explicit partner does NOT consume a waiting solo ──
  await check('[6] "Участвай с партньор" (brand new) never auto-pairs with an existing waiting solo', () => {
    const [creator, a, b, c] = allocProfiles(4)
    const tournamentId = createTournament(8, creator, 'Scenario 6')
    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed join A failed')
    const aTeamIdBefore = joinA.entry.teamId

    const invite = economy.createPartnerInviteAtomically(tournamentId, b, c)
    assert(invite.ok, `invite failed: ${JSON.stringify(invite)}`)
    if (!invite.ok) return

    const freshA = getEntry(db!, tournamentId, a)!
    assert(freshA.team_id === aTeamIdBefore, 'A must remain untouched, still alone in its own team')
    assert(getTeam(db!, freshA.team_id as string)!.status === 'forming', 'A\'s team should still be forming')
    assert(getTeamMembers(db!, freshA.team_id as string).length === 1, 'A\'s team should still have exactly 1 member')

    const bEntry = getEntry(db!, tournamentId, b)!
    assert(bEntry.team_id !== freshA.team_id, 'B must be on a SEPARATE team from A')
    assert(bEntry.joined_as === 'partner_inviter', 'B should be recorded as partner_inviter')
    // C has not accepted yet -> no confirmed entry for C.
    assert(getEntry(db!, tournamentId, c) === undefined, 'C should not have a confirmed entry until accepting')
  })

  // ── [6b] BLOCKER regression: waiting solo A sends an explicit invite to B
  // (still pending) -> a NEW solo joiner C must NOT be auto-paired with A's
  // team, because createPartnerInviteAtomically's reuse-own-team path
  // (§ already_teamed fix) flips A's joined_as from 'solo' to
  // 'partner_inviter' in the SAME transaction that creates the invite —
  // which is exactly the filter selectOldestWaitingSoloEntryStatement checks
  // (joined_as='solo'). Then B accepts -> A+B become ready; C stays a
  // separate, still-waiting solo. ──
  await check('[6b] waiting solo -> sends explicit invite -> next solo must NOT consume that team; then B accepts -> A+B ready, C stays separate', () => {
    const [creator, a, b, c] = allocProfiles(4)
    const tournamentId = createTournament(8, creator, 'Scenario 6b')

    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed join A failed')
    const aTeamId = joinA.entry.teamId as string
    assert(getTeam(db!, aTeamId)!.status === 'forming', 'sanity: A starts as a lone waiting solo')

    const invite = economy.createPartnerInviteAtomically(tournamentId, a, b)
    assert(invite.ok, `A's invite to B failed: ${JSON.stringify(invite)}`)
    if (!invite.ok) return
    // Proof (not assumption): A's own entry row now has joined_as flipped
    // away from 'solo', on the SAME team it already had.
    const aEntryAfterInvite = getEntry(db!, tournamentId, a)!
    assert(aEntryAfterInvite.team_id === aTeamId, 'A should still be on the same team (reused, not a new one)')
    assert(aEntryAfterInvite.joined_as === 'partner_inviter', 'A must no longer be joined_as=solo while the invite is pending')
    assert(getTeam(db!, aTeamId)!.status === 'forming', 'A\'s team status is untouched while the invite is pending')

    const joinC = joinSolo(tournamentId, c)
    assert(joinC.ok, `join C failed: ${JSON.stringify(joinC)}`)
    if (!joinC.ok) return
    assert(joinC.entry.teamId !== aTeamId, 'C must NOT be auto-paired with A\'s pending-invite team')
    assert(getTeamMembers(db!, aTeamId).length === 1, 'A\'s team must still have exactly 1 confirmed member (A only)')
    assert(getTeam(db!, joinC.entry.teamId as string)!.status === 'forming', 'C should have started its own fresh waiting team')

    const accept = economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, b)
    assert(accept.ok, `B's accept failed: ${JSON.stringify(accept)}`)
    if (!accept.ok) return
    assert(getTeam(db!, aTeamId)!.status === 'complete', 'A+B should now be a ready (complete) team')
    const abMembers = getTeamMembers(db!, aTeamId).map((m) => m.profile_id).sort()
    assert(JSON.stringify(abMembers) === JSON.stringify([a, b].sort()), 'A+B team should contain exactly A and B')

    const freshC = getEntry(db!, tournamentId, c)!
    assert(freshC.team_id !== aTeamId, 'C must remain on its own separate team, unaffected by A+B\'s acceptance')
    assert(getTeam(db!, freshC.team_id as string)!.status === 'forming', 'C is still just a waiting solo')
  })

  // ── [7]-[9]: 32-player tournament, 31/32 + waiting solo, capacity edge cases ──
  let bigTournamentId = ''
  const bigTeamCapacity = 16
  const bigPlayerCapacity = bigTeamCapacity * 2 // 32
  await check('[7] setup: fill a 32-capacity tournament to exactly 31/32 with one still-waiting solo', () => {
    const [creator] = allocProfiles(1)
    bigTournamentId = createTournament(bigPlayerCapacity, creator, 'Scenario 7-9')
    const solos = allocProfiles(31)
    for (const profileId of solos) {
      const r = joinSolo(bigTournamentId, profileId)
      if (!r.ok) throw new Error(`seed solo join failed: ${JSON.stringify(r)}`)
    }
    assert(
      countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, bigTournamentId) === 31,
      'expected exactly 31 confirmed entries',
    )
    // 31 solo joins -> 15 complete pairs (30 people) + exactly 1 lone waiting team.
    const formingTeams = (db!.prepare(`SELECT team_id FROM tournament_teams WHERE tournament_id = ? AND status = 'forming';`).all(bigTournamentId) as { team_id: string }[])
    assert(formingTeams.length === 1, `expected exactly 1 forming (waiting) team, got ${formingTeams.length}`)
    assert(getTeamMembers(db!, formingTeams[0]!.team_id).length === 1, 'the lone forming team should have exactly 1 member')
  })

  await check('[7b] "Участвай с партньор" with only 1 free slot is rejected with partner_requires_two_slots, no mutation', () => {
    const [requester, invitee] = allocProfiles(2)
    const balanceBefore = getWalletBalance(db!, requester)
    const entriesBefore = countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ?;`, bigTournamentId)
    const invitesBefore = countRows(db!, `SELECT COUNT(*) as count FROM tournament_partner_invites WHERE tournament_id = ?;`, bigTournamentId)

    const result = economy.createPartnerInviteAtomically(bigTournamentId, requester, invitee)
    assert(!result.ok, 'expected the invite to be rejected')
    if (result.ok) return
    assert(result.reason === 'partner_requires_two_slots', `expected partner_requires_two_slots, got ${result.reason}`)
    assert(getWalletBalance(db!, requester) === balanceBefore, 'requester must not be debited')
    assert(countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ?;`, bigTournamentId) === entriesBefore, 'no new entry should have been created')
    assert(countRows(db!, `SELECT COUNT(*) as count FROM tournament_partner_invites WHERE tournament_id = ?;`, bigTournamentId) === invitesBefore, 'no invite row should have been created')
  })

  await check('[8] "Влез сам" (canonical solo join) from the same 31/32 state auto-pairs and fills the tournament', () => {
    const [joiner] = allocProfiles(1)
    const result = joinSolo(bigTournamentId, joiner)
    assert(result.ok, `join failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    const team = getTeam(db!, result.entry.teamId as string)
    assert(team!.status === 'complete', `expected the pairing to complete the team, got ${team!.status}`)
    assert(
      countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, bigTournamentId) === bigPlayerCapacity,
      'tournament should now be exactly full (32/32)',
    )
    assert(
      countRows(db!, `SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ? AND status = 'forming';`, bigTournamentId) === 0,
      'no forming (waiting) team should remain once the tournament is full',
    )
  })

  await check('[9] full tournament: solo join AND partner join are both rejected as tournament_full', () => {
    const [soloAttempt, partnerRequester, partnerInvitee] = allocProfiles(3)
    const soloResult = joinSolo(bigTournamentId, soloAttempt)
    assert(!soloResult.ok && soloResult.reason === 'tournament_full', `expected tournament_full, got ${JSON.stringify(soloResult)}`)

    const partnerResult = economy.createPartnerInviteAtomically(bigTournamentId, partnerRequester, partnerInvitee)
    assert(!partnerResult.ok, 'expected partner invite to be rejected')
    if (partnerResult.ok) return
    // Genuinely 0 free places (not the 1-free-slot special case).
    assert(partnerResult.reason === 'tournament_full', `expected tournament_full, got ${partnerResult.reason}`)
  })

  // ── [10] Race/idempotency: two simultaneous solo joins against one waiting solo ──
  await check('[10] two concurrent solo joins against a single waiting solo: no 3-member team, no duplicates, capacity respected', async () => {
    const [creator, waiting, racerX, racerY] = allocProfiles(4)
    const tournamentId = createTournament(8, creator, 'Scenario 10')
    const joinWaiting = joinSolo(tournamentId, waiting)
    if (!joinWaiting.ok) throw new Error('seed waiting join failed')
    const waitingTeamId = joinWaiting.entry.teamId as string

    const [resultX, resultY] = await Promise.all([
      Promise.resolve().then(() => joinSolo(tournamentId, racerX)),
      Promise.resolve().then(() => joinSolo(tournamentId, racerY)),
    ])
    assert(resultX.ok && resultY.ok, `both racers should succeed (capacity allows it): ${JSON.stringify([resultX, resultY])}`)
    if (!resultX.ok || !resultY.ok) return

    const teams = db!.prepare(`SELECT team_id, status FROM tournament_teams WHERE tournament_id = ?;`).all(tournamentId) as TeamRow[]
    for (const team of teams) {
      const memberCount = getTeamMembers(db!, team.team_id).length
      assert(memberCount <= 2, `team ${team.team_id} has ${memberCount} members (must never exceed 2)`)
    }
    assert(getTeamMembers(db!, waitingTeamId).length === 2, 'exactly one of the two racers must have completed the waiting team')
    const confirmedCount = countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId)
    assert(confirmedCount === 3, `expected exactly 3 confirmed participants (waiting + 2 racers), got ${confirmedCount}`)
    assert(
      countRows(db!, `SELECT COUNT(DISTINCT profile_id) as count FROM tournament_entries WHERE tournament_id = ?;`, tournamentId) === 3,
      'no duplicate participant rows',
    )
  })

  // ── [11] Existing partner accept flow still works when capacity was properly reserved ──
  await check('[11] explicit partner invite + accept still works end-to-end with proper capacity reservation', () => {
    const [creator, inviter, invitee] = allocProfiles(3)
    const tournamentId = createTournament(8, creator, 'Scenario 11')
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee)
    assert(invite.ok, `invite creation failed: ${JSON.stringify(invite)}`)
    if (!invite.ok) return
    assert(economy.countReservedPendingPlaces(tournamentId) === 1, 'invite should reserve exactly 1 place for the invitee')

    const inviteeBalanceBefore = getWalletBalance(db!, invitee)
    const accept = economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, invitee)
    assert(accept.ok, `accept failed: ${JSON.stringify(accept)}`)
    if (!accept.ok) return
    assert(getWalletBalance(db!, invitee) === inviteeBalanceBefore - 5_000, 'invitee should be debited exactly the entry fee')

    const inviterEntry = getEntry(db!, tournamentId, inviter)!
    const inviteeEntry = getEntry(db!, tournamentId, invitee)!
    assert(inviterEntry.team_id === inviteeEntry.team_id, 'inviter and invitee should share a team')
    assert(getTeam(db!, inviterEntry.team_id as string)!.status === 'complete', 'team should be complete after accept')
  })

  // ── [12] Leave/refund regression for a solo waiting participant ──
  await check('[12] a still-waiting solo participant can leave cleanly (refunded, team cleaned up)', () => {
    const [creator, a] = allocProfiles(2)
    const tournamentId = createTournament(8, creator, 'Scenario 12')
    const join = joinSolo(tournamentId, a)
    if (!join.ok) throw new Error('seed join failed')
    const balanceBeforeLeave = getWalletBalance(db!, a)

    const leave = economy.leaveTournamentAndRefundAtomically(tournamentId, a)
    assert(leave.ok, `leave failed: ${JSON.stringify(leave)}`)
    if (!leave.ok) return
    assert(leave.autoReleasedPartner === null, 'a lone waiting solo has no partner to auto-release')
    assert(getWalletBalance(db!, a) === balanceBeforeLeave + 5_000, 'A should be refunded the full entry fee')
    assert(getEntry(db!, tournamentId, a)!.status === 'refunded', 'entry should be marked refunded')
    assert(countTeamsForTournament(db!, tournamentId) === 0, 'the now-empty waiting team should be cleaned up')

    // A fresh solo join afterwards must not resurrect stale team state.
    const [b] = allocProfiles(1)
    const rejoinB = joinSolo(tournamentId, b)
    assert(rejoinB.ok, `join B failed: ${JSON.stringify(rejoinB)}`)
    if (!rejoinB.ok) return
    assert(getTeam(db!, rejoinB.entry.teamId as string)!.status === 'forming', 'B should start a fresh waiting team')
    assert(getTeamMembers(db!, rejoinB.entry.teamId as string).length === 1, 'B\'s fresh team should have exactly 1 member')
  })

  // ── [13] (bonus) already-waiting solo can still invite a specific partner ──
  await check('[13] a still-waiting solo participant can use "Покани приятел за партньор" (reuses own team, no orphan)', () => {
    const [creator, a, friend] = allocProfiles(3)
    const tournamentId = createTournament(8, creator, 'Scenario 13')
    const join = joinSolo(tournamentId, a)
    if (!join.ok) throw new Error('seed join failed')
    const originalTeamId = join.entry.teamId as string

    const invite = economy.createPartnerInviteAtomically(tournamentId, a, friend)
    assert(invite.ok, `invite failed: ${JSON.stringify(invite)}`)
    if (!invite.ok) return
    assert(invite.debitedAmount === undefined, 'A already paid — inviting a friend must not debit again')

    const freshA = getEntry(db!, tournamentId, a)!
    assert(freshA.team_id === originalTeamId, 'the SAME team should be reused, not a new one')
    assert(freshA.joined_as === 'partner_inviter', 'A should now be recorded as partner_inviter')
    assert(countTeamsForTournament(db!, tournamentId) === 1, 'no orphan extra team should have been created')
  })

  // ── [14] (bonus) tournament-start regression: mixed lone-waiting-solo + legacy null-team orphan ──
  //
  // NOTE: after the [15]/[16] consistency fix, cancel/decline/expire of an
  // explicit invite no longer produces a team_id=NULL orphan (it now reverts
  // to a rediscoverable waiting-solo team instead — see resetFormingTeamToSolo).
  // A genuine team_id=NULL orphan can therefore no longer arise through the
  // normal invite lifecycle; this test seeds one directly via raw SQL to
  // represent the only remaining source of that shape (pre-existing/legacy
  // data, or resetFormingTeamToSolo's defensive else-branch for an inviter
  // whose entry is no longer 'confirmed') and proves
  // validateAndLockTeamsForStart still handles a MIX of that legacy shape
  // together with a genuine lone waiting-solo team correctly.
  await check('[14] tournament reaching full capacity with a lone waiting-solo team + a legacy null-team orphan still starts', () => {
    const teamCapacity = 4
    const playerCapacity = teamCapacity * 2 // 8
    const entryFee = 5_000
    const [creator] = allocProfiles(1)
    const tournamentId = createTournament(playerCapacity, creator, 'Scenario 14')

    // 4 solo joins -> 2 complete pairs (4 confirmed).
    for (const profileId of allocProfiles(4)) {
      const r = joinSolo(tournamentId, profileId)
      if (!r.ok) throw new Error(`seed pair join failed: ${JSON.stringify(r)}`)
    }
    // One lone genuinely-waiting solo (5th confirmed entry).
    const [lonelySolo] = allocProfiles(1)
    const lonelyJoin = joinSolo(tournamentId, lonelySolo)
    if (!lonelyJoin.ok) throw new Error('seed lonely solo join failed')

    // Raw-seeded legacy team_id=NULL orphan (6th confirmed entry) — see NOTE
    // above for why this can no longer be produced via a real invite
    // cancel/decline/expire.
    const [legacyOrphan] = allocProfiles(1)
    db!.prepare(`
      INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
      VALUES (?, ?, ?, NULL, 'solo', 'confirmed');
    `).run(randomUUID(), tournamentId, legacyOrphan)
    db!.prepare(`
      INSERT INTO tournament_economy_ledger (ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount)
      VALUES (?, ?, ?, ?, 'entry_fee_debit', ?);
    `).run(randomUUID(), `legacy-orphan-debit:${legacyOrphan}`, tournamentId, legacyOrphan, entryFee)
    assert(getEntry(db!, tournamentId, legacyOrphan)!.team_id === null, 'sanity: seeded a real team_id=NULL orphan')

    // A THIRD complete team via a normal invite+accept (deliberately NOT a
    // solo join — a solo join here would auto-pair with the still-lonely
    // solo above and defeat the scenario). Brings confirmed count to exactly
    // playerCapacity (4 solo pair + 1 lonely + 1 orphan + 2 invite pair = 8),
    // with the lonely-solo/orphan pairing left entirely to the start-time
    // fallback shuffle.
    const [thirdPairInviter, thirdPairInvitee] = allocProfiles(2)
    const thirdInvite = economy.createPartnerInviteAtomically(tournamentId, thirdPairInviter, thirdPairInvitee)
    if (!thirdInvite.ok) throw new Error('seed third-pair invite failed')
    const thirdAccept = economy.acceptPartnerInviteAtomically(tournamentId, thirdInvite.invite.inviteId, thirdPairInvitee)
    if (!thirdAccept.ok) throw new Error('seed third-pair accept failed')

    assert(
      countRows(db!, `SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`, tournamentId) === playerCapacity,
      'setup sanity: should be exactly at full capacity',
    )

    const startResult = economy.startTournamentAtomically(tournamentId, new Date())
    assert(startResult.ok, `tournament failed to start: ${JSON.stringify(startResult)}`)
    if (!startResult.ok) return
    assert(startResult.startedTeams.length === teamCapacity, `expected ${teamCapacity} locked teams, got ${startResult.startedTeams.length}`)
    assert(startResult.startedTeams.every((t) => t.status === 'locked'), 'all teams should be locked after start')
    assert(
      countRows(db!, `SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ? AND status = 'forming';`, tournamentId) === 0,
      'no forming team should remain after a successful start',
    )
  })

  // ── [15] CONSISTENCY regression: cancelled explicit invite reverts the
  // inviter to a REDISCOVERABLE waiting-solo state (same team, joined_as
  // flipped back to 'solo'), not an invisible team_id=NULL orphan — the next
  // solo joiner must deterministically auto-pair with them immediately,
  // without waiting for tournament-start fallback shuffle. cancelPartnerInviteAtomically
  // and declinePartnerInviteAtomically (and the background expiry sweep)
  // all funnel through the SAME resetFormingTeamToSolo helper (see
  // tournamentEconomyStore.ts), so this one representative case proves all
  // three call sites. ──
  await check('[15] cancelled explicit invite -> inviter becomes rediscoverable waiting solo -> next solo auto-pairs with them', () => {
    const [creator, a, b, c] = allocProfiles(4)
    const tournamentId = createTournament(8, creator, 'Scenario 15')

    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed join A failed')
    const aTeamId = joinA.entry.teamId as string

    const invite = economy.createPartnerInviteAtomically(tournamentId, a, b)
    if (!invite.ok) throw new Error('seed invite failed')
    assert(getEntry(db!, tournamentId, a)!.joined_as === 'partner_inviter', 'sanity: A is partner_inviter while pending')

    const cancel = economy.cancelPartnerInviteAtomically(tournamentId, invite.invite.inviteId, a)
    assert(cancel.ok, `cancel failed: ${JSON.stringify(cancel)}`)
    if (!cancel.ok) return

    const aEntryAfterCancel = getEntry(db!, tournamentId, a)!
    assert(aEntryAfterCancel.team_id === aTeamId, 'A must be back on the SAME team (not team_id=NULL, not a new team)')
    assert(aEntryAfterCancel.joined_as === 'solo', 'A must be joined_as=solo again after cancel')
    assert(getTeam(db!, aTeamId)!.status === 'forming', 'A\'s team should still be forming (waiting)')
    assert(countTeamsForTournament(db!, tournamentId) === 1, 'no orphan extra/leftover team should exist')

    const joinC = joinSolo(tournamentId, c)
    assert(joinC.ok, `join C failed: ${JSON.stringify(joinC)}`)
    if (!joinC.ok) return
    assert(joinC.entry.teamId === aTeamId, 'C should auto-pair with A immediately via FIFO — not fall through to start-time fallback')
    assert(getTeam(db!, aTeamId)!.status === 'complete', 'A+C should now be a ready team')
  })

  // ── [16] Same helper, invitee-initiated resolution (decline) — lighter
  // assertion-only pass proving the shared resetFormingTeamToSolo path
  // behaves identically regardless of who resolves the invite. ──
  await check('[16] declined explicit invite -> inviter becomes rediscoverable waiting solo (same shared helper as cancel/expire)', () => {
    const [creator, a, b] = allocProfiles(3)
    const tournamentId = createTournament(8, creator, 'Scenario 16')
    const joinA = joinSolo(tournamentId, a)
    if (!joinA.ok) throw new Error('seed join A failed')
    const aTeamId = joinA.entry.teamId as string
    const invite = economy.createPartnerInviteAtomically(tournamentId, a, b)
    if (!invite.ok) throw new Error('seed invite failed')

    const decline = economy.declinePartnerInviteAtomically(tournamentId, invite.invite.inviteId, b)
    assert(decline.ok, `decline failed: ${JSON.stringify(decline)}`)
    if (!decline.ok) return

    const aEntryAfterDecline = getEntry(db!, tournamentId, a)!
    assert(aEntryAfterDecline.team_id === aTeamId, 'A must be back on the SAME team')
    assert(aEntryAfterDecline.joined_as === 'solo', 'A must be joined_as=solo again after decline')
    assert(getTeam(db!, aTeamId)!.status === 'forming', 'A\'s team should still be forming (waiting)')
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
  console.error(`\ncheckTournamentAutoPairSolo failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentAutoPairSolo passed: ${passed} checks`)
