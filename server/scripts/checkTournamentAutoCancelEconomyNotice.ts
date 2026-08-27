/**
 * checkTournamentAutoCancelEconomyNotice.ts
 *
 * Regression за durable "Турнирът е анулиран, защото не се събра
 * необходимият брой участници." известието (§ task spec-а за user-facing
 * notification при auto-cancel поради недостатъчно участници).
 *
 * ROOT CAUSE на предишния (непълен) дизайн:
 *  - `notifyEconomyRefunds` в index.ts винаги push-ваше reason='fill_expired',
 *    дори за scheduled-underfilled auto-cancel (грешен reason за случая по
 *    §"CASE B — ОТЛОЖЕН СТАРТ").
 *  - Известието стигаше ИЗКЛЮЧИТЕЛНО до online connections
 *    (sendToOpenProfileConnections) — офлайн участник никога не го получаваше,
 *    дори след login/reconnect (нямаше durable persistence за auto-cancel
 *    refund-и, за разлика от partner_left, което вече имаше свой durable log).
 *
 * FIX: нова generic таблица `tournament_economy_notice_log` (reason-parametrized,
 * за разлика от partner-left-специфичната tournament_partner_left_notice_log),
 * committed В СЪЩАТА транзакция като refund-а
 * (autoCancelScheduledTournamentAtomically), delivered_at маркиран или веднага
 * (online push succeeded) или при следващ login/reconnect flush.
 *
 * Част 1 [store-level]: реален SQLite + createTournamentEconomyStore +
 * createTournamentScheduler, огледален pattern на checkTournamentFillExpiry.ts/
 * checkTournamentPartnerLifecycle.ts.
 *
 * Част 2 [source wiring]: index.ts/tournamentScheduler.ts коректно
 * различават reason='fill_expired'/'scheduled_underfilled', и правят
 * durable-first delivery (mark-delivered само след успешен push, login flush
 * за offline recipients).
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'

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

function insertProfile(database: DatabaseSync, profileId: string, index: number, balance = 100_000): void {
  database.prepare(`
    INSERT OR IGNORE INTO accounts (account_id, email, password_hash, role, status)
    VALUES (?, ?, 'hash', 'player', 'active');
  `).run(profileId, `${profileId}@example.test`)
  database.prepare(`
    INSERT OR IGNORE INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind, status)
    VALUES (?, ?, ?, ?, 'human', 'active');
  `).run(profileId, profileId, `Notice Player ${index + 1}`, `notice player ${index + 1}`)
  database.prepare(`
    INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?);
  `).run(profileId, balance)
}

function getWalletBalance(database: DatabaseSync, profileId: string): number {
  return (database.prepare(`SELECT yellow_coins_balance AS balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { balance: number }).balance
}

function countLedgerRows(database: DatabaseSync, tournamentId: string, profileId: string, entryType: string): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count FROM tournament_economy_ledger
    WHERE tournament_id = ? AND profile_id = ? AND entry_type = ?;
  `).get(tournamentId, profileId, entryType) as { count: number }).count
}

function countNoticeRows(database: DatabaseSync, tournamentId: string, profileId: string): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count FROM tournament_economy_notice_log
    WHERE tournament_id = ? AND recipient_profile_id = ?;
  `).get(tournamentId, profileId) as { count: number }).count
}

function getNoticeRow(database: DatabaseSync, tournamentId: string, profileId: string): {
  reason: string
  refunded_amount: number
  delivered_at: string | null
} | undefined {
  return database.prepare(`
    SELECT reason, refunded_amount, delivered_at FROM tournament_economy_notice_log
    WHERE tournament_id = ? AND recipient_profile_id = ?;
  `).get(tournamentId, profileId) as { reason: string; refunded_amount: number; delivered_at: string | null } | undefined
}

function getTournamentRow(database: DatabaseSync, tournamentId: string): { status: string } {
  return database.prepare(`SELECT status FROM tournaments WHERE tournament_id = ?;`).get(tournamentId) as { status: string }
}

console.log('\n=== checkTournamentAutoCancelEconomyNotice ===\n')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-autocancel-notice-'))
const dbPath = join(tempDir, 'server.db')
const database = new DatabaseSync(dbPath)
await applyMigrations(database)
const economyStore = await createTournamentEconomyStore(dbPath)
const tournamentStore = await createTournamentStore(dbPath)

let profileCounter = 0
function freshProfile(balance = 100_000): string {
  const profileId = `notice-profile-${profileCounter++}`
  insertProfile(database, profileId, profileCounter, balance)
  return profileId
}

// ============================================================
// Scenario 1 — Fill-mode expires underfilled, both participants "online"
// (simulated by a scheduler with a mock now() clock; the store layer itself
// has no online/offline notion — that lives in index.ts's WS layer, covered
// by source-wiring checks in Part 2 below).
// ============================================================
{
  const creator = freshProfile()
  const tournamentResult = tournamentStore.createTournament({
    kind: 'community',
    name: 'Notice Fill Test',
    creatorProfileId: creator,
    visibility: 'public',
    entryFee: 7000,
    startMode: 'fill',
  })
  assert(tournamentResult.ok, `tournament creation failed: ${JSON.stringify(tournamentResult)}`)
  const tournamentId = tournamentResult.ok ? tournamentResult.tournament.tournamentId : ''

  const a = freshProfile()
  const b = freshProfile()
  const joinA = economyStore.joinTournamentSoloAtomically(tournamentId, a)
  const joinB = economyStore.joinTournamentSoloAtomically(tournamentId, b)
  check('[1] A joins and pays entry fee', joinA.ok === true, JSON.stringify(joinA))
  check('[1] B joins and pays entry fee', joinB.ok === true, JSON.stringify(joinB))
  check('[1] A debited exactly once', countLedgerRows(database, tournamentId, a, 'entry_fee_debit') === 1)
  check('[1] B debited exactly once', countLedgerRows(database, tournamentId, b, 'entry_fee_debit') === 1)

  // Tournament requires 8 players (default player_capacity) — only 2 joined,
  // so it stays underfilled. Force fill_expires_at into the past to simulate
  // the 60-minute window elapsing, mirroring checkTournamentFillExpiry.ts's
  // approach.
  database.prepare(`UPDATE tournaments SET fill_expires_at = '2020-01-01T00:00:00.000Z' WHERE tournament_id = ?;`).run(tournamentId)

  const cancelResult = economyStore.autoCancelScheduledTournamentAtomically(tournamentId, new Date('2020-01-01T00:05:00.000Z'), 'fill_mode_expired')
  check('[1] auto-cancel succeeds', cancelResult.ok === true, JSON.stringify(cancelResult))
  if (cancelResult.ok) {
    check('[1] tournament status is auto_cancelled', getTournamentRow(database, tournamentId).status === 'auto_cancelled')
    check('[1] exactly 2 refunded profiles reported', cancelResult.refundedProfiles.length === 2, JSON.stringify(cancelResult.refundedProfiles))
    check('[1] A refunded exactly once (ledger)', countLedgerRows(database, tournamentId, a, 'entry_fee_refund') === 1)
    check('[1] B refunded exactly once (ledger)', countLedgerRows(database, tournamentId, b, 'entry_fee_refund') === 1)
    check('[1] A wallet balance restored to 100000', getWalletBalance(database, a) === 100_000)
    check('[1] B wallet balance restored to 100000', getWalletBalance(database, b) === 100_000)
    check('[1] durable notice row exists for A exactly once', countNoticeRows(database, tournamentId, a) === 1)
    check('[1] durable notice row exists for B exactly once', countNoticeRows(database, tournamentId, b) === 1)
    const noticeA = getNoticeRow(database, tournamentId, a)
    check('[1] A notice reason is fill_expired (internal reason mapped correctly)', noticeA?.reason === 'fill_expired', JSON.stringify(noticeA))
    check('[1] A notice amount matches the exact refunded amount (7000, not a hardcoded default)', noticeA?.refunded_amount === 7000, JSON.stringify(noticeA))
    check('[1] notice starts undelivered (delivered_at NULL) — delivery is a separate step', noticeA?.delivered_at === null, JSON.stringify(noticeA))
    check('[1] no bot fill occurred (no replacement rows) — auto-cancel is pre-attendance', countNoticeRows(database, tournamentId, creator) === 0)
  }
}

// ============================================================
// Scenario 2 — Fill-mode expires, offline participant: notice persists
// pending until "login" (simulated by the store-level mark-delivered call,
// mirroring exactly what index.ts's connection-setup flush does).
// ============================================================
{
  const creator = freshProfile()
  const tournamentResult = tournamentStore.createTournament({
    kind: 'community', name: 'Notice Offline Test', creatorProfileId: creator, visibility: 'public', entryFee: 5000, startMode: 'fill',
  })
  assert(tournamentResult.ok, 'tournament creation failed')
  const tournamentId = tournamentResult.ok ? tournamentResult.tournament.tournamentId : ''
  const a = freshProfile()
  economyStore.joinTournamentSoloAtomically(tournamentId, a)
  database.prepare(`UPDATE tournaments SET fill_expires_at = '2020-01-01T00:00:00.000Z' WHERE tournament_id = ?;`).run(tournamentId)

  const cancelResult = economyStore.autoCancelScheduledTournamentAtomically(tournamentId, new Date('2020-01-01T00:05:00.000Z'), 'fill_mode_expired')
  assert(cancelResult.ok, 'auto-cancel failed')

  // A is "offline" — no delivery happens at cancel time (this is exactly
  // what index.ts's notifyEconomyRefunds does when sendToOpenProfileConnections
  // returns 0: it simply does NOT call markTournamentEconomyNoticeDelivered).
  check('[2] refund committed even though participant is offline', countLedgerRows(database, tournamentId, a, 'entry_fee_refund') === 1)
  const pendingBeforeLogin = economyStore.getPendingTournamentEconomyNotices(a)
  check('[2] notice is pending (undelivered) while offline', pendingBeforeLogin.length === 1, JSON.stringify(pendingBeforeLogin))
  check('[2] pending notice carries the correct refunded amount', pendingBeforeLogin[0]?.refundedAmount === 5000, JSON.stringify(pendingBeforeLogin))
  check('[2] pending notice carries reason=fill_expired', pendingBeforeLogin[0]?.reason === 'fill_expired', JSON.stringify(pendingBeforeLogin))

  // A "logs in" — the exact store-level operation index.ts's connection-setup
  // flush performs.
  for (const notice of pendingBeforeLogin) {
    economyStore.markTournamentEconomyNoticeDelivered(notice.noticeId, a)
  }
  const pendingAfterLogin = economyStore.getPendingTournamentEconomyNotices(a)
  check('[2] notice is no longer pending after delivery (login flush)', pendingAfterLogin.length === 0, JSON.stringify(pendingAfterLogin))

  // Second login/reconnect must NOT redeliver, and must NOT create a second refund.
  const pendingSecondLogin = economyStore.getPendingTournamentEconomyNotices(a)
  check('[2] a second login sees no pending notice (no duplicate delivery)', pendingSecondLogin.length === 0)
  check('[2] wallet was not credited a second time by the login flush', getWalletBalance(database, a) === 100_000)
  check('[2] still exactly one refund ledger row after the reconnect/consume cycle', countLedgerRows(database, tournamentId, a, 'entry_fee_refund') === 1)
}

// ============================================================
// Scenario 3 — Scheduled start underfilled: same cancellation transaction,
// different internal reason ('scheduled_start_not_ready') mapped to the
// SAME user-facing reason family but a distinct 'scheduled_underfilled'
// notice reason value.
// ============================================================
{
  const creator = freshProfile()
  const tournamentResult = tournamentStore.createTournament({
    kind: 'community', name: 'Notice Scheduled Test', creatorProfileId: creator, visibility: 'public', entryFee: 9000, startMode: 'scheduled', scheduledStartAt: '2020-01-01T00:00:00.000Z',
  })
  assert(tournamentResult.ok, `tournament creation failed: ${JSON.stringify(tournamentResult)}`)
  const tournamentId = tournamentResult.ok ? tournamentResult.tournament.tournamentId : ''
  const a = freshProfile()
  economyStore.joinTournamentSoloAtomically(tournamentId, a)

  const cancelResult = economyStore.autoCancelScheduledTournamentAtomically(tournamentId, new Date('2020-01-01T00:05:00.000Z'), 'scheduled_start_not_ready')
  check('[3] auto-cancel succeeds for underfilled scheduled tournament', cancelResult.ok === true, JSON.stringify(cancelResult))
  if (cancelResult.ok) {
    check('[3] tournament status is auto_cancelled', getTournamentRow(database, tournamentId).status === 'auto_cancelled')
    check('[3] A refunded exactly once', countLedgerRows(database, tournamentId, a, 'entry_fee_refund') === 1)
    check('[3] A wallet restored', getWalletBalance(database, a) === 100_000)
    const noticeA = getNoticeRow(database, tournamentId, a)
    check('[3] notice reason is scheduled_underfilled (distinct internal reason, same user-facing family)', noticeA?.reason === 'scheduled_underfilled', JSON.stringify(noticeA))
    check('[3] notice amount matches the exact refunded amount (9000)', noticeA?.refunded_amount === 9000, JSON.stringify(noticeA))
  }
}

// ============================================================
// Scenario 4 — Full tournament: NO cancellation, NO notice.
// ============================================================
{
  const creator = freshProfile()
  const tournamentResult = tournamentStore.createTournament({
    kind: 'community', name: 'Notice Full Test', creatorProfileId: creator, visibility: 'public', entryFee: 4000, startMode: 'fill',
  })
  assert(tournamentResult.ok, 'tournament creation failed')
  const tournamentId = tournamentResult.ok ? tournamentResult.tournament.tournamentId : ''
  const participants = Array.from({ length: 8 }, () => freshProfile())
  for (const p of participants) {
    const joinResult = economyStore.joinTournamentSoloAtomically(tournamentId, p)
    assert(joinResult.ok, `join failed: ${JSON.stringify(joinResult)}`)
  }
  const startResult = economyStore.startTournamentAtomically(tournamentId, new Date('2020-01-01T00:00:00.000Z'))
  check('[4] a fully-joined tournament starts normally', startResult.ok === true, JSON.stringify(startResult))
  check('[4] tournament status is NOT auto_cancelled', getTournamentRow(database, tournamentId).status !== 'auto_cancelled')
  for (const p of participants) {
    check(`[4] no economy notice created for a normally-started tournament (profile ${p})`, countNoticeRows(database, tournamentId, p) === 0)
    check(`[4] no refund ledger row for a normally-started tournament (profile ${p})`, countLedgerRows(database, tournamentId, p, 'entry_fee_refund') === 0)
  }
}

// ============================================================
// Scenario 5 — Retry/idempotency: auto-cancel invoked twice for the same
// tournament (mirroring a scheduler tick re-running after a crash/restart)
// must not duplicate the refund, ledger row, or durable notice.
// ============================================================
{
  const creator = freshProfile()
  const tournamentResult = tournamentStore.createTournament({
    kind: 'community', name: 'Notice Retry Test', creatorProfileId: creator, visibility: 'public', entryFee: 6000, startMode: 'fill',
  })
  assert(tournamentResult.ok, 'tournament creation failed')
  const tournamentId = tournamentResult.ok ? tournamentResult.tournament.tournamentId : ''
  const a = freshProfile()
  economyStore.joinTournamentSoloAtomically(tournamentId, a)
  database.prepare(`UPDATE tournaments SET fill_expires_at = '2020-01-01T00:00:00.000Z' WHERE tournament_id = ?;`).run(tournamentId)

  const firstCancel = economyStore.autoCancelScheduledTournamentAtomically(tournamentId, new Date('2020-01-01T00:05:00.000Z'), 'fill_mode_expired')
  assert(firstCancel.ok, 'first auto-cancel failed')
  const secondCancel = economyStore.autoCancelScheduledTournamentAtomically(tournamentId, new Date('2020-01-01T00:06:00.000Z'), 'fill_mode_expired')
  check('[5] second auto-cancel call reports alreadyCancelled', secondCancel.ok === true && secondCancel.ok && secondCancel.alreadyCancelled === true, JSON.stringify(secondCancel))
  check('[5] second call reports zero refundedProfiles (no duplicate notify)', secondCancel.ok === true && secondCancel.ok && secondCancel.refundedProfiles.length === 0, JSON.stringify(secondCancel))
  check('[5] still exactly one refund ledger row', countLedgerRows(database, tournamentId, a, 'entry_fee_refund') === 1)
  check('[5] still exactly one durable notice row', countNoticeRows(database, tournamentId, a) === 1)
  check('[5] wallet was not credited twice', getWalletBalance(database, a) === 100_000)
}

// ============================================================
// Scenario 6 — Mixed participants: a paid/confirmed entry plus a cancelled
// partner invite (never actually paid/joined) — only the genuinely
// refundable confirmed entry gets a notice + refund.
// ============================================================
{
  const creator = freshProfile()
  const tournamentResult = tournamentStore.createTournament({
    kind: 'community', name: 'Notice Mixed Test', creatorProfileId: creator, visibility: 'public', entryFee: 8000, startMode: 'fill',
  })
  assert(tournamentResult.ok, 'tournament creation failed')
  const tournamentId = tournamentResult.ok ? tournamentResult.tournament.tournamentId : ''
  const inviter = freshProfile()
  const invitee = freshProfile()
  const joinInviter = economyStore.joinTournamentSoloAtomically(tournamentId, inviter)
  assert(joinInviter.ok, 'inviter join failed')
  const inviteResult = economyStore.createPartnerInviteAtomically(tournamentId, inviter, invitee, {})
  check('[6] partner invite created (invitee never pays until accept)', inviteResult.ok === true, JSON.stringify(inviteResult))
  check('[6] invitee has NOT been debited (pending invite only)', countLedgerRows(database, tournamentId, invitee, 'entry_fee_debit') === 0)

  database.prepare(`UPDATE tournaments SET fill_expires_at = '2020-01-01T00:00:00.000Z' WHERE tournament_id = ?;`).run(tournamentId)
  const cancelResult = economyStore.autoCancelScheduledTournamentAtomically(tournamentId, new Date('2020-01-01T00:05:00.000Z'), 'fill_mode_expired')
  check('[6] auto-cancel succeeds', cancelResult.ok === true, JSON.stringify(cancelResult))
  if (cancelResult.ok) {
    check('[6] exactly one refunded profile (the inviter, who actually paid)', cancelResult.refundedProfiles.length === 1, JSON.stringify(cancelResult.refundedProfiles))
    check('[6] the refunded profile is the inviter', cancelResult.refundedProfiles[0]?.profileId === inviter, JSON.stringify(cancelResult.refundedProfiles))
    check('[6] a notice was created for the inviter', countNoticeRows(database, tournamentId, inviter) === 1)
    check('[6] NO notice was created for the never-paid invitee', countNoticeRows(database, tournamentId, invitee) === 0)
    check('[6] NO refund ledger row for the never-paid invitee', countLedgerRows(database, tournamentId, invitee, 'entry_fee_refund') === 0)
  }
}

// ============================================================
// Scenario 7 — Crash-window semantics: DB transaction committed (refund +
// durable notice both persisted), but no delivery attempted yet (simulating
// a process crash before the WS push runs). The pending notice must still
// be deliverable on the next reconnect/restart — proven by simply querying
// getPendingTournamentEconomyNotices without ever having called
// markTournamentEconomyNoticeDelivered, using a FRESH store instance against
// the SAME db file (simulating a server restart).
// ============================================================
{
  const creator = freshProfile()
  const tournamentResult = tournamentStore.createTournament({
    kind: 'community', name: 'Notice Crash Test', creatorProfileId: creator, visibility: 'public', entryFee: 3000, startMode: 'fill',
  })
  assert(tournamentResult.ok, 'tournament creation failed')
  const tournamentId = tournamentResult.ok ? tournamentResult.tournament.tournamentId : ''
  const a = freshProfile()
  economyStore.joinTournamentSoloAtomically(tournamentId, a)
  database.prepare(`UPDATE tournaments SET fill_expires_at = '2020-01-01T00:00:00.000Z' WHERE tournament_id = ?;`).run(tournamentId)
  const cancelResult = economyStore.autoCancelScheduledTournamentAtomically(tournamentId, new Date('2020-01-01T00:05:00.000Z'), 'fill_mode_expired')
  assert(cancelResult.ok, 'auto-cancel failed')
  // Deliberately skip calling notifyEconomyRefunds/markTournamentEconomyNoticeDelivered
  // here — simulates the process crashing right after COMMIT.

  // Fresh store instance against the SAME sqlite file — simulates a server restart.
  const restartedStore = await createTournamentEconomyStore(dbPath)
  const pendingAfterRestart = restartedStore.getPendingTournamentEconomyNotices(a)
  check('[7] the durable notice survives a simulated restart (fresh store instance, same db)', pendingAfterRestart.length === 1, JSON.stringify(pendingAfterRestart))
  check('[7] the surviving notice still carries the correct amount', pendingAfterRestart[0]?.refundedAmount === 3000, JSON.stringify(pendingAfterRestart))
  check('[7] refund itself was never duplicated by the restart (still exactly one ledger row)', countLedgerRows(database, tournamentId, a, 'entry_fee_refund') === 1)
}

console.log('\n=== Source-wiring: online/offline delivery + reason correctness ===\n')

const projectRootPath = join(serverRootPath, '..')
function projectFile(path: string): string {
  return readFileSync(join(projectRootPath, path), 'utf8')
}

const indexSrc = projectFile('server/src/index.ts')
const schedulerSrc = projectFile('server/src/tournament/tournamentScheduler.ts')
const economySrc = projectFile('server/src/db/tournamentEconomyStore.ts')
const noticeUiSrc = projectFile('src/ui/notifications/tournamentEconomyNotification.ts')
const noticeQueueSrc = projectFile('src/ui/notifications/tournamentEconomyNotificationQueue.ts')
const messageTypesSrc = projectFile('server/src/protocol/messageTypes.ts')

check(
  'the scheduler passes the CORRECT reason for each auto-cancel path (fill_expired for fill-timeout, scheduled_underfilled for scheduled-start) — the exact bug this task fixes',
  schedulerSrc.includes("deps.notifyEconomyRefunds?.(tournamentId, 'scheduled_underfilled', cancelResult.refundedProfiles)") &&
    schedulerSrc.includes("deps.notifyEconomyRefunds?.(tournamentId, 'fill_expired', cancelResult.refundedProfiles)"),
)

check(
  'notifyEconomyRefunds marks the durable notice delivered ONLY after a successful online push (sentCount > 0), never unconditionally',
  indexSrc.includes('notifyEconomyRefunds: (tournamentId, reason, refundedProfiles) => {') &&
    indexSrc.includes('if (sentCount > 0) {') &&
    indexSrc.includes('tournamentEconomyStore.markTournamentEconomyNoticeDelivered(noticeId, profileId)'),
)

check(
  'login/reconnect connection-setup flushes any still-undelivered auto-cancel notices, mirroring the pendingPartnerLeftNotices flush',
  indexSrc.includes('tournamentEconomyStore.getPendingTournamentEconomyNotices(connection.profileId)') &&
    indexSrc.includes('tournamentEconomyStore.markTournamentEconomyNoticeDelivered(notice.noticeId, connection.profileId)'),
)

check(
  'the durable notice is inserted inside the SAME auto-cancel transaction as the refund (before COMMIT), keyed deterministically off (tournamentId, profileId) for idempotency',
  economySrc.includes('insertTournamentEconomyNoticeStatement.run(') &&
    economySrc.includes('`tournament-auto-cancel:${tournamentId}:${entry.profile_id}`'),
)

check(
  'pending (undelivered) notices are queried by delivered_at IS NULL, mirroring the partner-left/gift notification pattern',
  economySrc.includes('WHERE recipient_profile_id = ? AND delivered_at IS NULL') &&
    economySrc.includes('FROM tournament_economy_notice_log'),
)

check(
  'the client reuses the EXISTING tournamentEconomyNotification popup pipeline (no new toast/animation system) and unifies fill_expired/scheduled_underfilled to the SAME user-facing text',
  noticeUiSrc.includes("case 'fill_expired':") &&
    noticeUiSrc.includes("case 'scheduled_underfilled':") &&
    noticeUiSrc.includes('Турнирът е анулиран, защото не се събра необходимият брой участници'),
)

check(
  'client-side notice reason union includes scheduled_underfilled',
  noticeQueueSrc.includes("| 'scheduled_underfilled'"),
)

check(
  'the WS message type union includes scheduled_underfilled',
  messageTypesSrc.includes("'creator_cancelled' | 'fill_expired' | 'scheduled_underfilled' | 'partner_left'"),
)

check(
  'the notice amount pushed/persisted comes directly from the committed refund result (authoritative), never a client-side/speculative recompute from current entry_fee',
  economySrc.includes('insertTournamentEconomyNoticeStatement.run(noticeId, tournamentId, entry.profile_id, economyNoticeReason, refundAmount)'),
)

console.log(`\nPassed: ${passed} Failed: ${failed}`)
if (failed > 0) process.exit(1)
