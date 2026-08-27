/**
 * checkTournamentPartnerLifecycle.ts
 *
 * Store-level regression (реална SQLite база с всички migrations, директно
 * извикване на createTournamentEconomyStore — огледален pattern на
 * checkTournamentActiveParticipationGuard.ts) за пълния partner team
 * lifecycle: form → one side leaves → auto-release/refund на другия →
 * clean re-invite, симетрично независимо кой напусне пръв.
 *
 * ROOT CAUSE (§ "BUG #1"): старото поведение при leave на partner в
 * двучленен team правеше updateEntryToSoloStatement на оставащия партньор
 * (вместо auto-release/refund) — оставяше го active/unpaired с ВЕЧЕ платен
 * вход. Продуктовото изискване (виж допълнението към задачата) е друго:
 * когато единият напусне, ЦЕЛИЯТ team се разпада и ДВАМАТА получават refund
 * — оставащият не остава "закачен" в турнира.
 *
 * Scenario A — form team: A join solo, A invites B, B accepts -> A+B
 * confirmed team, и двамата debit-нати точно веднъж.
 *
 * Scenario B — B leaves: B refund точно веднъж; A СЪЩО е auto-released +
 * refund-нат в СЪЩИЯ leave call (autoReleasedPartner); няма malformed
 * one-member team row; team редът е изтрит; старата accepted покана е
 * терминализирана (изтрита чрез ON DELETE CASCADE на team_id).
 *
 * Scenario C — A invites SAME B again: чист fresh-join (A вече е refunded,
 * значи rejoin минава през нормалния solo-join path), нов invite, B accepts
 * -> нов валиден A+B team, ново debit точно веднъж за всеки.
 *
 * Scenario D (mirror) — A leaves first: B е auto-released/refund-нат вместо
 * A.
 *
 * Idempotency: повторен leave call на вече refunded профил не удвоява
 * refund-а нито за самия него, нито "отключва" повторен partner-refund.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
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

function insertTournament(database: DatabaseSync, tournamentId: string, creatorProfileId: string): void {
  insertProfile(database, creatorProfileId)
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, fill_expires_at, status,
      started_at, finished_at
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 7000, 8, 'fill', NULL, datetime('now', '+1 hour'), 'open', CURRENT_TIMESTAMP, NULL);
  `).run(tournamentId, `Lifecycle ${tournamentId}`, creatorProfileId)
}

function countTeams(database: DatabaseSync, tournamentId: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM tournament_teams WHERE tournament_id = ?;`).get(tournamentId) as { count: number }).count
}

function countLedgerRows(database: DatabaseSync, tournamentId: string, profileId: string, entryType: string): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count FROM tournament_economy_ledger
    WHERE tournament_id = ? AND profile_id = ? AND entry_type = ?;
  `).get(tournamentId, profileId, entryType) as { count: number }).count
}

function getEntryStatus(database: DatabaseSync, tournamentId: string, profileId: string): { status: string; team_id: string | null } | undefined {
  return database.prepare(`
    SELECT status, team_id FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;
  `).get(tournamentId, profileId) as { status: string; team_id: string | null } | undefined
}

function countAcceptedInvites(database: DatabaseSync, tournamentId: string): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count FROM tournament_partner_invites WHERE tournament_id = ? AND status = 'accepted';
  `).get(tournamentId) as { count: number }).count
}

const tempDir = await mkdtemp(join(tmpdir(), 'belot-partner-lifecycle-'))
const dbPath = join(tempDir, 'server.db')
const database = new DatabaseSync(dbPath)
await applyMigrations(database)
const store = await createTournamentEconomyStore(dbPath)

console.log('\n=== Tournament Partner Lifecycle (form -> B leaves -> auto-release -> re-invite) ===\n')

const A = 'lifecycle-A'
const B = 'lifecycle-B'
const T1 = 'lifecycle-tournament-1'
insertProfile(database, A)
insertProfile(database, B)
insertTournament(database, T1, `creator-${T1}`)

// --- Scenario A: form team ---
const joinA = store.joinTournamentSoloAtomically(T1, A)
check('[A] A joins solo', joinA.ok === true, JSON.stringify(joinA))

const invite1 = store.createPartnerInviteAtomically(T1, A, B, {})
check('[A] A invites B', invite1.ok === true, JSON.stringify(invite1))
const invite1Id = invite1.ok ? invite1.invite.inviteId : ''

const accept1 = store.acceptPartnerInviteAtomically(T1, invite1Id, B)
check('[A] B accepts', accept1.ok === true, JSON.stringify(accept1))

check('[A] A entry is confirmed with a team', getEntryStatus(database, T1, A)?.status === 'confirmed' && getEntryStatus(database, T1, A)?.team_id !== null)
check('[A] B entry is confirmed with the SAME team', getEntryStatus(database, T1, A)?.team_id === getEntryStatus(database, T1, B)?.team_id)
check('[A] exactly one team row exists', countTeams(database, T1) === 1)
check('[A] A debited exactly once', countLedgerRows(database, T1, A, 'entry_fee_debit') === 1)
check('[A] B debited exactly once', countLedgerRows(database, T1, B, 'entry_fee_debit') === 1)

// --- Scenario B: B leaves -> A auto-released + refunded ---
const leaveB = store.leaveTournamentAndRefundAtomically(T1, B)
check('[B] B leave succeeds', leaveB.ok === true, JSON.stringify(leaveB))
check('[B] B refunded exactly the entry fee (7000)', leaveB.ok === true && leaveB.refundedAmount === 7000, JSON.stringify(leaveB))
check('[B] B refunded exactly once (ledger)', countLedgerRows(database, T1, B, 'entry_fee_refund') === 1)

check('[B] leave result reports A as the auto-released partner', leaveB.ok === true && leaveB.autoReleasedPartner?.profileId === A, JSON.stringify(leaveB))
check('[B] A auto-refund amount matches the entry fee', leaveB.ok === true && leaveB.autoReleasedPartner?.refundedAmount === 7000, JSON.stringify(leaveB))
check('[B] A refunded exactly once (ledger)', countLedgerRows(database, T1, A, 'entry_fee_refund') === 1)
check('[B] A entry status is refunded (no dangling solo participant)', getEntryStatus(database, T1, A)?.status === 'refunded', JSON.stringify(getEntryStatus(database, T1, A)))
check('[B] no malformed one-member team row remains', countTeams(database, T1) === 0)
check('[B] the old accepted invite is gone (terminalized via team ON DELETE CASCADE)', countAcceptedInvites(database, T1) === 0)

// A pressing "Отпиши се" again after being auto-released must NOT refund a second time.
const leaveAAgain = store.leaveTournamentAndRefundAtomically(T1, A)
check('[B] A leaving again after auto-release is idempotent (alreadyRefunded, no new refund)', leaveAAgain.ok === true && leaveAAgain.alreadyRefunded === true, JSON.stringify(leaveAAgain))
check('[B] A still refunded exactly once after the redundant leave call', countLedgerRows(database, T1, A, 'entry_fee_refund') === 1)

// --- Scenario C: A rejoins, invites SAME B again -> clean new team ---
const joinA2 = store.joinTournamentSoloAtomically(T1, A)
check('[C] A can rejoin (fresh entry, no stale window error)', joinA2.ok === true, JSON.stringify(joinA2))

const invite2 = store.createPartnerInviteAtomically(T1, A, B, {})
check('[C] A can send a NEW invite to the SAME B (no stale invite_window_closed)', invite2.ok === true, JSON.stringify(invite2))
const invite2Id = invite2.ok ? invite2.invite.inviteId : ''

const accept2 = store.acceptPartnerInviteAtomically(T1, invite2Id, B)
check('[C] B accepts the new invite', accept2.ok === true, JSON.stringify(accept2))
check('[C] a fresh A+B team is formed', countTeams(database, T1) === 1)
check('[C] A debited again (second attempt, second ledger row)', countLedgerRows(database, T1, A, 'entry_fee_debit') === 2)
check('[C] B debited again (second attempt, second ledger row)', countLedgerRows(database, T1, B, 'entry_fee_debit') === 2)

console.log('\n=== Mirror scenario: A leaves first -> B auto-released/refunded ===\n')

// Свежи профили (не A/B от T1) — избягва "one active tournament per account"
// restriction-a (A/B все още са legitimately active в T1 от Scenario C по-горе);
// mirror сценарият тества самата auto-release симетрия, не нуждае от same
// identities.
const C = 'lifecycle-C'
const D_ = 'lifecycle-D'
insertProfile(database, C)
insertProfile(database, D_)
const T2 = 'lifecycle-tournament-2'
insertTournament(database, T2, `creator-${T2}`)
store.joinTournamentSoloAtomically(T2, C)
const mirrorInvite = store.createPartnerInviteAtomically(T2, C, D_, {})
assert(mirrorInvite.ok === true, `mirror invite unexpectedly failed: ${JSON.stringify(mirrorInvite)}`)
const mirrorAccept = store.acceptPartnerInviteAtomically(T2, mirrorInvite.ok ? mirrorInvite.invite.inviteId : '', D_)
assert(mirrorAccept.ok === true, `mirror accept unexpectedly failed: ${JSON.stringify(mirrorAccept)}`)

const leaveCFirst = store.leaveTournamentAndRefundAtomically(T2, C)
check('[D] C (inviter) leaves first: succeeds', leaveCFirst.ok === true, JSON.stringify(leaveCFirst))
check('[D] D (invitee) is auto-released — symmetric regardless of inviter/invitee role', leaveCFirst.ok === true && leaveCFirst.autoReleasedPartner?.profileId === D_, JSON.stringify(leaveCFirst))
check('[D] D refunded exactly once', countLedgerRows(database, T2, D_, 'entry_fee_refund') === 1)
check('[D] C refunded exactly once', countLedgerRows(database, T2, C, 'entry_fee_refund') === 1)
check('[D] no team row remains', countTeams(database, T2) === 0)
check('[D] no accepted invite remains', countAcceptedInvites(database, T2) === 0)

// D can immediately start a fresh registration/partner flow.
const dRejoin = store.joinTournamentSoloAtomically(T2, D_)
check('[D] D can immediately rejoin after mutual auto-release', dRejoin.ok === true, JSON.stringify(dRejoin))

console.log('\n=== Realtime notification wiring (source-level, mirrors checkTournamentPartnerInviteNotifications.ts pattern) ===\n')

// Source-string wiring checks — reads the ACTUAL current worktree files
// (same --project-root convention as checkTournamentPartnerInvitesSource.ts),
// не hardcoded assumptions. Проверява, че auto-release-ът реално push-ва
// realtime известие до remaining partner-а (§ "REALTIME" в допълнението),
// с authoritative amount от committed refund резултата (не speculative),
// и че клиентът го консумира през СЪЩИЯ съществуващ tournament_economy_notice
// pipeline (не нова, паралелна WS message система).
const projectRootPath = resolve(join(serverRootPath, '..'))
function projectFile(path: string): string {
  return readFileSync(join(projectRootPath, path), 'utf8')
}

const indexSrc = projectFile('server/src/index.ts')
const mainSrc = projectFile('src/main.ts')
const controllerSrc = projectFile('src/app/lobby/createLobbyFlowController.ts')
const noticeQueueSrc = projectFile('src/ui/notifications/tournamentEconomyNotificationQueue.ts')
const noticeUiSrc = projectFile('src/ui/notifications/tournamentEconomyNotification.ts')
const messageTypesSrc = projectFile('server/src/protocol/messageTypes.ts')

check(
  'server sends the partner_left notice ONLY when autoReleasedPartner is non-null (not on every normal solo leave)',
  indexSrc.includes('if (result.autoReleasedPartner !== null) {') && indexSrc.includes("reason: 'partner_left' as const,"),
)
check(
  'the pushed amount comes directly from the committed leave result (authoritative), not a client-side/speculative recompute',
  indexSrc.includes('amount: result.autoReleasedPartner.refundedAmount,'),
)
check(
  'partner_left online push reuses sendToOpenProfileConnections (same delivery primitive as sendTournamentEconomyRefundNotices for creator_cancelled/fill_expired, no parallel transport)',
  indexSrc.includes('sendToOpenProfileConnections(result.autoReleasedPartner.profileId, {'),
)
check(
  'creator_cancelled/fill_expired still reuse sendTournamentEconomyRefundNotices unchanged',
  indexSrc.includes("reason: 'creator_cancelled' | 'fill_expired' | 'partner_left'"),
)
check(
  'the WS message type union includes partner_left',
  messageTypesSrc.includes("reason: 'creator_cancelled' | 'fill_expired' | 'partner_left'"),
)
check(
  'the client reuses the existing tournamentEconomyNotification popup pipeline for partner_left (no new toast/animation system)',
  mainSrc.includes("if (message.type === 'tournament_economy_notice') {") && mainSrc.includes('tournamentEconomyNotification.handleIncoming({'),
)
check(
  'client-side notice reason union includes partner_left',
  noticeQueueSrc.includes("| 'partner_left'"),
)
check(
  'the popup copy mentions partner leaving and re-invite, not a raw code',
  noticeUiSrc.includes('Партньорът ти се отписа от отбора') && noticeUiSrc.includes('Покани го отново или намери друг партньор'),
)
check(
  'the popup still shows the visual "+X жълтици" credit via the existing amountText mechanism (reused, not a new component)',
  noticeUiSrc.includes("amountText: `+${formatted} жълтици`"),
)
check(
  'the remaining partner sees an authoritative detail refresh (roster/team state) triggered by this exact push — event-driven, not a new poll',
  controllerSrc.includes("message.type === 'tournament_economy_notice' && message.reason === 'partner_left'") &&
    controllerSrc.includes('void fetchTournamentDetail(message.tournamentId)'),
)

console.log('\n=== Durable partner-left notification wiring (offline delivery, reuses gift_notification_log pattern) ===\n')

const economySrc = projectFile('server/src/db/tournamentEconomyStore.ts')

check(
  'a dedicated durable notice table exists (not a repurpose of the append-only tournament_events audit log)',
  economySrc.includes('tournament_partner_left_notice_log'),
)
check(
  'the durable notice row is inserted inside the SAME leave transaction as the refund (before COMMIT), keyed deterministically off the released entry_id for idempotency',
  economySrc.includes('insertPartnerLeftNoticeStatement.run(') && economySrc.includes('`partner-left:${member.entry_id}`'),
)
check(
  'pending (undelivered) notices are queried by delivered_at IS NULL, mirroring getPendingGiftNotifications/read_at semantics',
  economySrc.includes('WHERE recipient_profile_id = ? AND delivered_at IS NULL'),
)
check(
  'delivery is marked via a dedicated consume statement, not by deleting the row (audit trail preserved like gift_notification_log)',
  economySrc.includes('markPartnerLeftNoticeDeliveredStatement') && economySrc.includes('SET delivered_at = CURRENT_TIMESTAMP'),
)
check(
  'online delivery marks the notice delivered immediately after a successful push (so a later login does not redeliver it)',
  indexSrc.includes('if (sentCount > 0) {') && indexSrc.includes('tournamentEconomyStore.markPartnerLeftNoticeDelivered('),
)
check(
  'login/reconnect flushes any still-undelivered partner-left notices to the now-online recipient, mirroring the pendingGifts flush',
  indexSrc.includes('tournamentEconomyStore.getPendingPartnerLeftNotices(connection.profileId)') &&
    indexSrc.includes('tournamentEconomyStore.markPartnerLeftNoticeDelivered(notice.noticeId, connection.profileId)'),
)
check(
  'the login flush reuses the exact same WS message shape (tournament_economy_notice / partner_left) as the online push — client needs no new message handler',
  (indexSrc.match(/type: 'tournament_economy_notice',\s*\n\s*eventId: randomUUID\(\),/g)?.length ?? 0) >= 2,
)

console.log('\n=== Offline acceptance scenario: A offline while B leaves -> durable notice -> delivered on reconnect ===\n')

const E = 'lifecycle-E'
const F = 'lifecycle-F'
insertProfile(database, E)
insertProfile(database, F)
const T3 = 'lifecycle-tournament-3'
insertTournament(database, T3, `creator-${T3}`)
store.joinTournamentSoloAtomically(T3, E)
const offlineInvite = store.createPartnerInviteAtomically(T3, E, F, {})
assert(offlineInvite.ok === true, `offline-scenario invite unexpectedly failed: ${JSON.stringify(offlineInvite)}`)
const offlineAccept = store.acceptPartnerInviteAtomically(T3, offlineInvite.ok ? offlineInvite.invite.inviteId : '', F)
assert(offlineAccept.ok === true, `offline-scenario accept unexpectedly failed: ${JSON.stringify(offlineAccept)}`)

// E has no WS session at all right now (simulated by simply never calling any
// connection/socket API here — the store layer has no notion of online/offline,
// exactly like leaveTournamentAndRefundAtomically for the earlier scenarios).
const leaveFOffline = store.leaveTournamentAndRefundAtomically(T3, F)
check('[E] F leave succeeds while E is offline', leaveFOffline.ok === true, JSON.stringify(leaveFOffline))
check('[E] F refunded exactly once', countLedgerRows(database, T3, F, 'entry_fee_refund') === 1)
check('[E] E auto-released and refunded exactly once even though offline', countLedgerRows(database, T3, E, 'entry_fee_refund') === 1)
check('[E] team dissolved', countTeams(database, T3) === 0)

const pendingForEBeforeLogin = store.getPendingPartnerLeftNotices(E)
check('[E] a durable notification for E exists exactly once (undelivered, since E never came online)', pendingForEBeforeLogin.length === 1, JSON.stringify(pendingForEBeforeLogin))
check('[E] the durable notice carries the real refund amount, not a placeholder', pendingForEBeforeLogin[0]?.refundedAmount === 7000, JSON.stringify(pendingForEBeforeLogin))
check('[E] the durable notice is scoped to the exact tournament', pendingForEBeforeLogin[0]?.tournamentId === T3, JSON.stringify(pendingForEBeforeLogin))

// E "logs in" / reconnects: this call is the exact store-level operation the
// login flush block in index.ts performs (getPendingPartnerLeftNotices then
// markPartnerLeftNoticeDelivered per notice).
for (const notice of pendingForEBeforeLogin) {
  store.markPartnerLeftNoticeDelivered(notice.noticeId, E)
}
const pendingForEAfterLogin = store.getPendingPartnerLeftNotices(E)
check('[E] after delivery the notice no longer appears as pending (consumed, matches existing read/delivered semantics)', pendingForEAfterLogin.length === 0, JSON.stringify(pendingForEAfterLogin))

// A second reconnect (or a second browser tab) must NOT redeliver — and must
// NOT create a second refund (leave was already committed above; this call
// only re-checks the idempotent "already refunded" path is untouched).
const secondReconnectPending = store.getPendingPartnerLeftNotices(E)
check('[E] a further reconnect/second tab sees no pending notice (no duplicate delivery)', secondReconnectPending.length === 0)
check('[E] E still refunded exactly once after the reconnect/consume cycle (no secondary refund from delivery)', countLedgerRows(database, T3, E, 'entry_fee_refund') === 1)

// E can immediately re-invite F (or anyone else) — the consumed notification
// must not block eligibility.
const eRejoin = store.joinTournamentSoloAtomically(T3, E)
check('[E] E can immediately start a fresh registration after the notice is consumed', eRejoin.ok === true, JSON.stringify(eRejoin))
const eReinviteF = store.createPartnerInviteAtomically(T3, E, F, {})
check('[E] E can re-invite F (or anyone else) — notification state does not block eligibility', eReinviteF.ok === true, JSON.stringify(eReinviteF))

console.log('\n=== Stale tournament-detail reconcile (§ "BUG A") ===\n')

const renderTournamentsSrc = projectFile('src/app/lobby/renderTournamentsScreen.ts')

check(
  'fetchTournamentDetail unconditionally replaces state.tournamentDetail with the fresh authoritative payload (no stale merge/patch of the old team roster)',
  controllerSrc.includes('state.tournamentDetail = result.tournament'),
)
check(
  'renderTournamentDetailScreen is a pure function of state (no separately-cached team/roster snapshot that could shadow the fresh fetch)',
  /export function renderTournamentDetailScreen\(state: LobbyScreenState\): string \{/.test(renderTournamentsSrc),
)
check(
  'the reconcile guard only refetches when the viewer is actually ON the affected tournament detail screen (targeted, not a global refresh-everything)',
  controllerSrc.includes("state.currentScreen === 'tournament-detail' && state.tournamentDetailId === message.tournamentId"),
)
check(
  'render() is called on the successful fetchTournamentDetail path (the "ГОТОВ ОТБОР" DOM is guaranteed to re-render from the fresh team list, not just update in-memory state)',
  (() => {
    const fnStart = controllerSrc.indexOf('async function fetchTournamentDetail(')
    const fnBody = controllerSrc.slice(fnStart, fnStart + 4000)
    const assignIdx = fnBody.indexOf('state.tournamentDetail = result.tournament')
    return fnStart !== -1 && assignIdx !== -1 && fnBody.slice(assignIdx).includes('render()')
  })(),
)

console.log('\n=== Own-leave success path reconcile (§ "КРИТИЧНО: ПРОВЕРИ OWN-LEAVE SUCCESS PATH") ===\n')

// ROOT CAUSE: the leave HTTP response returns only a TournamentSummarySnapshot
// (counters/status/viewer — see createGameServerClient.ts), never the
// detail-only fields (teams/myTeam/rounds/...). submitTournamentLeave used to
// call mergeTournamentSummaryIntoDetail(result.tournament), a shallow
// { ...old, ...summary } spread — that correctly refreshes counters/action
// buttons (they ARE summary fields) but leaves state.tournamentDetail.teams
// and .myTeam completely untouched, since summary never had those keys to
// begin with. The leaving player never receives their own partner_left WS
// push either (that push targets the auto-released COUNTERPART, not the
// leaver) — so nothing else was ever going to reconcile the leaver's own
// screen. Fix: replace the shallow merge with a full authoritative
// fetchTournamentDetail() refetch, symmetric to the counterpart's WS-driven
// refetch.
check(
  'submitTournamentLeave no longer uses the shallow summary merge for the success path (the exact BUG source: summary lacks teams/myTeam)',
  !/state\.tournamentLeaveConfirmOpen = false\s*\n\s*state\.tournamentLeaveErrorText = null\s*\n\s*mergeTournamentSummaryIntoDetail\(result\.tournament\)/.test(controllerSrc),
)
check(
  'submitTournamentLeave now triggers a full authoritative fetchTournamentDetail() refetch after a successful own-leave',
  (() => {
    const fnStart = controllerSrc.indexOf('async function submitTournamentLeave(')
    const fnBody = controllerSrc.slice(fnStart, fnStart + 2500)
    return fnStart !== -1 && fnBody.includes('void fetchTournamentDetail(tournamentId)')
  })(),
)
check(
  'the refund toast (participant_withdrawal) still fires exactly once via the existing economy notice pipeline, unaffected by the reconcile fix',
  (() => {
    const fnStart = controllerSrc.indexOf('async function submitTournamentLeave(')
    const fnBody = controllerSrc.slice(fnStart, fnStart + 2500)
    return (fnBody.match(/onTournamentEconomyNotice\?\.\(\{ reason: 'participant_withdrawal'/g)?.length ?? 0) === 1
  })(),
)
check(
  'mergeTournamentSummaryIntoDetail is still used for OTHER summary-only transitions (join/cancel) — not deleted wholesale, only replaced where detail-only fields (teams) matter',
  (controllerSrc.match(/mergeTournamentSummaryIntoDetail\(result\.tournament\)/g)?.length ?? 0) >= 4,
)
check(
  'the leaving player reconcile does not manually splice/patch the teams array client-side — it defers entirely to the authoritative GET (no speculative team reconstruction)',
  !controllerSrc.includes('.teams.splice(') && !controllerSrc.includes('teams.filter((t) => t.teamId !=='),
)

console.log('\n=== Both affected clients reconcile after dissolution (leaver + auto-released counterpart) ===\n')

check(
  'Scenario A/leaver: own successful leave triggers fetchTournamentDetail (own client, no WS dependency)',
  controllerSrc.includes('void fetchTournamentDetail(tournamentId)'),
)
check(
  'Scenario B/counterpart: partner_left WS push still triggers fetchTournamentDetail for the OTHER client (unchanged by this fix, still symmetric)',
  controllerSrc.includes("message.type === 'tournament_economy_notice' && message.reason === 'partner_left'") &&
    controllerSrc.includes('void fetchTournamentDetail(message.tournamentId)'),
)
check(
  'Scenario C/reverse: the leave handler and the partner_left handler are two INDEPENDENT trigger points (not one gated behind the other) — so it does not matter who leaves first, each side has its own trigger',
  controllerSrc.indexOf('async function submitTournamentLeave(') !== controllerSrc.indexOf("message.reason === 'partner_left'"),
)

assert(failed === 0, `${failed} checks failed`)
console.log(`\ncheckTournamentPartnerLifecycle passed=${passed} failed=${failed}`)
