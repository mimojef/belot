/**
 * checkTournamentSelfForceRemove.ts
 *
 * Regression: създателят (или admin) не може да „модерира“ самия себе си.
 * Преди fix-а „Отпиши играч“ / „Отпиши отбор“ върху СОБСТВЕНАТА карта
 * минаваше през forceRemove*Atomically и записваше
 * tournament_participation_blocks с blocked_profile_id = actor_profile_id →
 * при повторно записване: participation_blocked („Създателят не желае вие да
 * участвате в неговия турнир“), а при пълен отбор блокираше и партньора.
 *
 * Fix: forceRemoveEntryAtomically / forceRemoveTeamAtomically отказват с
 * 'cannot_force_remove_self', ако actor-ът е премахваният профил или член на
 * премахвания отбор — ROLLBACK преди refund/block/notice/event. UI-ят не
 * рендира moderation бутона върху картата, в която е viewer-ът.
 *
 * Покрива:
 *  1. Creator solo: join → „Откажи участие“ → join отново → ok.
 *  2. Creator + pending invite: invite → leave → нова покана към друг → ok.
 *  3. Creator в пълен отбор: leave → rejoin ok; бившият партньор не е блокиран.
 *  4. Creator force-remove на собствения solo entry (и като partner_inviter)
 *     → cannot_force_remove_self, нищо не се променя.
 *  5. Creator force-remove на собствения пълен отбор → cannot_force_remove_self,
 *     нищо не се променя, никой не е блокиран; admin-член на отбор — също.
 *  6. Непроменено: creator force-remove на ДРУГ → блокиран за solo join,
 *     create invite, accept invite; admin (не-член) премахва creator-а → ok.
 *  7. UI: renderTournamentTeamCard не показва moderation бутон върху картата
 *     на viewer-а, показва го върху чуждите.
 */

import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { renderTournamentTeamCard } from '../../src/app/lobby/renderTournamentsScreen.js'

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

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`CREATE TABLE IF NOT EXISTS server_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`)
  const files = (await readdir(migrationsDirectoryPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  const insertApplied = database.prepare(`INSERT OR IGNORE INTO server_migrations (filename) VALUES (?);`)
  for (const filename of files) {
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

function insertProfile(database: DatabaseSync, profileId: string, role = 'player'): void {
  database.prepare(`
    INSERT OR IGNORE INTO accounts (account_id, email, password_hash, role, status)
    VALUES (?, ?, 'hash', ?, 'active');
  `).run(profileId, `${profileId}@example.test`, role)
  database.prepare(`
    INSERT OR IGNORE INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind, status)
    VALUES (?, ?, ?, ?, 'human', 'active');
  `).run(profileId, profileId, profileId, profileId.toLowerCase())
  database.prepare(`INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 1000000);`).run(profileId)
}

function insertTournament(database: DatabaseSync, tournamentId: string, creatorProfileId: string): void {
  insertProfile(database, creatorProfileId)
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, fill_expires_at, status,
      started_at, finished_at
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 5000, 8, 'fill', NULL, datetime('now', '+1 hour'), 'open', NULL, NULL);
  `).run(tournamentId, `Self force-remove ${tournamentId}`, creatorProfileId)
}

const count = (database: DatabaseSync, sql: string, ...params: string[]): number =>
  (database.prepare(sql).get(...params) as { count: number }).count

const wallet = (database: DatabaseSync, profileId: string): number =>
  (database.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { yellow_coins_balance: number }).yellow_coins_balance

const entryStatus = (database: DatabaseSync, tournamentId: string, profileId: string): string | undefined =>
  (database.prepare(`SELECT status FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;`).get(tournamentId, profileId) as { status: string } | undefined)?.status

const isBlocked = (database: DatabaseSync, tournamentId: string, profileId: string): boolean =>
  count(database, `SELECT COUNT(*) as count FROM tournament_participation_blocks WHERE tournament_id = ? AND blocked_profile_id = ?;`, tournamentId, profileId) > 0

// Моментна снимка на всичко, което force-remove би пипнал.
function snapshot(database: DatabaseSync, tournamentId: string, profileIds: string[]): string {
  return JSON.stringify({
    wallets: profileIds.map((id) => wallet(database, id)),
    entries: database.prepare(`SELECT profile_id, status, team_id FROM tournament_entries WHERE tournament_id = ? ORDER BY profile_id;`).all(tournamentId),
    teams: database.prepare(`SELECT team_id, status FROM tournament_teams WHERE tournament_id = ? ORDER BY team_id;`).all(tournamentId),
    invites: database.prepare(`SELECT invite_id, status FROM tournament_partner_invites WHERE tournament_id = ? ORDER BY invite_id;`).all(tournamentId),
    blocks: count(database, `SELECT COUNT(*) as count FROM tournament_participation_blocks WHERE tournament_id = ?;`, tournamentId),
    ledger: count(database, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ?;`, tournamentId),
    notices: count(database, `SELECT COUNT(*) as count FROM tournament_economy_notice_log WHERE tournament_id = ?;`, tournamentId),
    events: count(database, `SELECT COUNT(*) as count FROM tournament_events WHERE tournament_id = ?;`, tournamentId),
  })
}

const tempDir = await mkdtemp(join(tmpdir(), 'belot-self-force-remove-'))
const dbPath = join(tempDir, 'server.db')
const database = new DatabaseSync(dbPath)
await applyMigrations(database)
const store = await createTournamentEconomyStore(dbPath)

// ─── 1. Creator solo: join → leave → join отново ───────────────────────────
{
  const tournamentId = 't1-solo'
  const creator = 'c1'
  insertTournament(database, tournamentId, creator)
  const join = store.joinTournamentSoloAtomically(tournamentId, creator)
  assert(join.ok, `setup join: ${JSON.stringify(join)}`)
  const leave = store.leaveTournamentAndRefundAtomically(tournamentId, creator)
  check('[1] creator solo „Откажи участие“ → ok', leave.ok === true, JSON.stringify(leave))
  check('[1] доброволното отписване не блокира', !isBlocked(database, tournamentId, creator))
  const rejoin = store.joinTournamentSoloAtomically(tournamentId, creator)
  check('[1] creator се записва отново сам → ok', rejoin.ok === true, JSON.stringify(rejoin))
}

// ─── 2. Creator + pending invite → leave → нова покана към друг ────────────
{
  const tournamentId = 't2-invite'
  const creator = 'c2'
  const partnerA = 'c2-partner-a'
  const partnerB = 'c2-partner-b'
  insertTournament(database, tournamentId, creator)
  insertProfile(database, partnerA)
  insertProfile(database, partnerB)
  const invite = store.createPartnerInviteAtomically(tournamentId, creator, partnerA)
  assert(invite.ok, `setup invite: ${JSON.stringify(invite)}`)
  const leave = store.leaveTournamentAndRefundAtomically(tournamentId, creator)
  check('[2] creator с чакаща покана „Откажи участие“ → ok', leave.ok === true, JSON.stringify(leave))
  const reinvite = store.createPartnerInviteAtomically(tournamentId, creator, partnerB)
  check('[2] нова покана към друг партньор → ok', reinvite.ok === true, JSON.stringify(reinvite))
  check('[2] creator не е блокиран', !isBlocked(database, tournamentId, creator))
}

// ─── 3. Creator в пълен отбор → leave → rejoin; партньорът не е блокиран ───
{
  const tournamentId = 't3-team'
  const creator = 'c3'
  const partner = 'c3-partner'
  insertTournament(database, tournamentId, creator)
  insertProfile(database, partner)
  const invite = store.createPartnerInviteAtomically(tournamentId, creator, partner)
  assert(invite.ok, `setup invite: ${JSON.stringify(invite)}`)
  const inviteId = (database.prepare(`SELECT invite_id FROM tournament_partner_invites WHERE tournament_id = ? AND invitee_profile_id = ?;`).get(tournamentId, partner) as { invite_id: string }).invite_id
  const accept = store.acceptPartnerInviteAtomically(tournamentId, inviteId, partner)
  assert(accept.ok, `setup accept: ${JSON.stringify(accept)}`)

  const leave = store.leaveTournamentAndRefundAtomically(tournamentId, creator)
  check('[3] creator в пълен отбор „Откажи участие“ → ok', leave.ok === true, JSON.stringify(leave))
  check('[3] бившият партньор НЕ е participation-blocked', !isBlocked(database, tournamentId, partner))
  check('[3] creator НЕ е participation-blocked', !isBlocked(database, tournamentId, creator))
  const rejoin = store.joinTournamentSoloAtomically(tournamentId, creator)
  check('[3] creator се записва отново → ok', rejoin.ok === true, JSON.stringify(rejoin))
  const partnerRejoin = store.joinTournamentSoloAtomically(tournamentId, partner)
  check('[3] бившият партньор също може да се запише отново → ok', partnerRejoin.ok === true, JSON.stringify(partnerRejoin))
}

// ─── 4. Creator force-remove на собствения entry ───────────────────────────
{
  const tournamentId = 't4-self-entry'
  const creator = 'c4'
  insertTournament(database, tournamentId, creator)
  const join = store.joinTournamentSoloAtomically(tournamentId, creator)
  assert(join.ok, `setup join: ${JSON.stringify(join)}`)
  const entryId = join.ok ? join.entry.entryId : ''

  const before = snapshot(database, tournamentId, [creator])
  const result = store.forceRemoveEntryAtomically(tournamentId, entryId, creator)
  check('[4] self force-remove на solo entry → cannot_force_remove_self', result.ok === false && result.reason === 'cannot_force_remove_self', JSON.stringify(result))
  check('[4] entry/status, wallet, blocks, ledger, notices, events — без промяна', snapshot(database, tournamentId, [creator]) === before)
  check('[4] entry остава confirmed', entryStatus(database, tournamentId, creator) === 'confirmed')
  check('[4] 0 participation blocks', !isBlocked(database, tournamentId, creator))
  const rejoinCheck = store.joinTournamentSoloAtomically(tournamentId, creator)
  check('[4] creator все още е записан (idempotent join, не participation_blocked)', rejoinCheck.ok === true && rejoinCheck.alreadyJoined === true, JSON.stringify(rejoinCheck))

  // Като partner_inviter с чакаща покана.
  const tournamentId2 = 't4-self-inviter'
  const creator2 = 'c4b'
  const invitee = 'c4b-invitee'
  insertTournament(database, tournamentId2, creator2)
  insertProfile(database, invitee)
  const invite = store.createPartnerInviteAtomically(tournamentId2, creator2, invitee)
  assert(invite.ok, `setup invite: ${JSON.stringify(invite)}`)
  const inviterEntryId = (database.prepare(`SELECT entry_id FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;`).get(tournamentId2, creator2) as { entry_id: string }).entry_id
  const before2 = snapshot(database, tournamentId2, [creator2, invitee])
  const result2 = store.forceRemoveEntryAtomically(tournamentId2, inviterEntryId, creator2)
  check('[4] self force-remove като partner_inviter → cannot_force_remove_self', result2.ok === false && result2.reason === 'cannot_force_remove_self', JSON.stringify(result2))
  check('[4] чакащата покана и всичко останало — без промяна', snapshot(database, tournamentId2, [creator2, invitee]) === before2)
}

// ─── 5. Creator force-remove на собствения пълен отбор ─────────────────────
{
  const tournamentId = 't5-self-team'
  const creator = 'c5'
  const partner = 'c5-partner'
  insertTournament(database, tournamentId, creator)
  insertProfile(database, partner)
  const joinCreator = store.joinTournamentSoloAtomically(tournamentId, creator)
  assert(joinCreator.ok, 'setup creator join')
  const joinPartner = store.joinTournamentSoloAtomically(tournamentId, partner)
  assert(joinPartner.ok && joinPartner.autoPairedWithProfileId === creator, 'setup auto-pair')
  const teamId = joinPartner.ok ? joinPartner.entry.teamId! : ''

  const before = snapshot(database, tournamentId, [creator, partner])
  const result = store.forceRemoveTeamAtomically(tournamentId, teamId, creator)
  check('[5] self force-remove на собствения отбор → cannot_force_remove_self', result.ok === false && result.reason === 'cannot_force_remove_self', JSON.stringify(result))
  check('[5] отбор, entries, wallet-и, ledger, notices, events — без промяна', snapshot(database, tournamentId, [creator, partner]) === before)
  check('[5] отборът остава complete', (database.prepare(`SELECT status FROM tournament_teams WHERE team_id = ?;`).get(teamId) as { status: string } | undefined)?.status === 'complete')
  check('[5] creator НЕ е блокиран', !isBlocked(database, tournamentId, creator))
  check('[5] партньорът НЕ е блокиран', !isBlocked(database, tournamentId, partner))

  // Admin, който е член на отбора — също не може да се премахне сам.
  const tournamentId2 = 't5-admin-member'
  const creator2 = 'c5b'
  const admin = 'c5b-admin'
  const adminPartner = 'c5b-admin-partner'
  insertTournament(database, tournamentId2, creator2)
  insertProfile(database, admin, 'admin')
  insertProfile(database, adminPartner)
  store.joinTournamentSoloAtomically(tournamentId2, admin)
  const joinAdminPartner = store.joinTournamentSoloAtomically(tournamentId2, adminPartner)
  const adminTeamId = joinAdminPartner.ok ? joinAdminPartner.entry.teamId! : ''
  const before2 = snapshot(database, tournamentId2, [admin, adminPartner])
  const result2 = store.forceRemoveTeamAtomically(tournamentId2, adminTeamId, admin)
  check('[5] admin-член на отбора → cannot_force_remove_self, без промяна',
    result2.ok === false && result2.reason === 'cannot_force_remove_self' && snapshot(database, tournamentId2, [admin, adminPartner]) === before2, JSON.stringify(result2))
}

// ─── 6. Непроменено: creator/admin force-remove на ДРУГ ────────────────────
{
  const tournamentId = 't6-other'
  const creator = 'c6'
  const target = 'c6-target'
  const inviter = 'c6-inviter'
  const someone = 'c6-someone'
  insertTournament(database, tournamentId, creator)
  insertProfile(database, target)
  insertProfile(database, inviter)
  insertProfile(database, someone)

  // Покана КЪМ target, създадена преди блокирането (за accept проверката).
  const pendingInvite = store.createPartnerInviteAtomically(tournamentId, inviter, target)
  assert(pendingInvite.ok, `setup invite: ${JSON.stringify(pendingInvite)}`)
  const pendingInviteId = (database.prepare(`SELECT invite_id FROM tournament_partner_invites WHERE tournament_id = ? AND invitee_profile_id = ?;`).get(tournamentId, target) as { invite_id: string }).invite_id

  // target е записан сам в друг отбор → creator го премахва.
  const joinTarget = store.joinTournamentSoloAtomically(tournamentId, target)
  assert(joinTarget.ok, `setup target join: ${JSON.stringify(joinTarget)}`)
  const targetEntryId = joinTarget.ok ? joinTarget.entry.entryId : ''
  const walletBefore = wallet(database, target)
  const removed = store.forceRemoveEntryAtomically(tournamentId, targetEntryId, creator)
  check('[6] creator премахва ДРУГ играч → ok', removed.ok === true, JSON.stringify(removed))
  check('[6] другият играч е refund-нат и блокиран', wallet(database, target) === walletBefore + 5000 && isBlocked(database, tournamentId, target))

  const soloJoin = store.joinTournamentSoloAtomically(tournamentId, target)
  check('[6] блокиран → solo join participation_blocked', soloJoin.ok === false && soloJoin.reason === 'participation_blocked', JSON.stringify(soloJoin))
  const createInvite = store.createPartnerInviteAtomically(tournamentId, target, someone)
  check('[6] блокиран → create invite participation_blocked', createInvite.ok === false && createInvite.reason === 'participation_blocked', JSON.stringify(createInvite))
  const acceptInvite = store.acceptPartnerInviteAtomically(tournamentId, pendingInviteId, target)
  check('[6] блокиран → accept invite participation_blocked', acceptInvite.ok === false && acceptInvite.reason === 'participation_blocked', JSON.stringify(acceptInvite))

  // Admin (не-член) премахва creator-а от собствения му турнир → разрешено (без creator bypass).
  const tournamentId2 = 't6-admin-removes-creator'
  const creator2 = 'c6b'
  const admin = 'c6b-admin'
  insertTournament(database, tournamentId2, creator2)
  insertProfile(database, admin, 'admin')
  const joinCreator2 = store.joinTournamentSoloAtomically(tournamentId2, creator2)
  const creatorEntryId = joinCreator2.ok ? joinCreator2.entry.entryId : ''
  const adminRemoval = store.forceRemoveEntryAtomically(tournamentId2, creatorEntryId, admin)
  check('[6] admin (не-член) премахва creator-а → ok и creator-ът е блокиран (без creator bypass)',
    adminRemoval.ok === true && isBlocked(database, tournamentId2, creator2), JSON.stringify(adminRemoval))
}

// ─── 7. UI: moderation бутонът липсва върху собствената карта ──────────────
{
  const member = (profileId: string, entryId: string) => ({
    entryId, profileId, displayName: profileId, avatarUrl: null, joinedAt: '2026-01-01T00:00:00Z', joinedAs: 'solo' as const,
  })
  const ownComplete = { teamId: 'team-own', status: 'complete', members: [member('viewer', 'e1'), member('partner', 'e2')] }
  const otherComplete = { teamId: 'team-other', status: 'complete', members: [member('x', 'e3'), member('y', 'e4')] }
  const ownSolo = { teamId: 'team-own-solo', status: 'forming', members: [member('viewer', 'e5')] }
  const otherSolo = { teamId: 'team-other-solo', status: 'forming', members: [member('z', 'e6')] }
  const hasTeamButton = (html: string) => html.includes('data-tournament-force-remove-team-open')
  const hasEntryButton = (html: string) => html.includes('data-tournament-force-remove-entry-open')

  check('[7] собствен пълен отбор → без „Отпиши отбор“', !hasTeamButton(renderTournamentTeamCard(ownComplete as never, 'Отбор 1', true, 'viewer')))
  check('[7] собствен solo запис → без „Отпиши играч“', !hasEntryButton(renderTournamentTeamCard(ownSolo as never, 'Отбор 2', true, 'viewer')))
  check('[7] чужд пълен отбор → „Отпиши отбор“ остава', hasTeamButton(renderTournamentTeamCard(otherComplete as never, 'Отбор 3', true, 'viewer')))
  check('[7] чужд solo запис → „Отпиши играч“ остава', hasEntryButton(renderTournamentTeamCard(otherSolo as never, 'Отбор 4', true, 'viewer')))
  check('[7] без canModerateTeams → без бутони', !hasTeamButton(renderTournamentTeamCard(otherComplete as never, 'Отбор 5', false, 'viewer')))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
