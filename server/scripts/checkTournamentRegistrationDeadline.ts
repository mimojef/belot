/**
 * checkTournamentRegistrationDeadline.ts
 *
 * Регистрацията в турнир е отворена ДО ПОСЛЕДНАТА милисекунда преди старта —
 * без 30-минутния (или какъвто и да е) буфер за партньорски покани.
 *
 *   Начало 20:00:00.000 (Europe/Sofia) = 18:00:00.000Z
 *   19:59:59.999 — самостоятелно записване, покана и приемане са позволени
 *   20:00:00.000 — регистрацията е затворена (сървърно време)
 *
 * Всички проверки са с ФИКСИРАНО сървърно време (`now`, подаден на store-а и
 * на scheduler-а) върху изолирана временна база.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'
import { toTournamentSummaryDto } from '../src/tournament/tournamentDto.js'

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

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  const fileNames = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  const getApplied = database.prepare(`SELECT filename FROM server_migrations WHERE filename = ? LIMIT 1;`)
  const insertApplied = database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`)
  for (const filename of fileNames) {
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

const START_BALANCE = 1_000_000
const ENTRY_FEE = 5_000

function insertProfile(database: DatabaseSync, profileId: string, name: string): void {
  database.prepare(`
    INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind, status)
    VALUES (?, ?, ?, ?, 'human', 'active');
  `).run(profileId, profileId, name, name.toLowerCase())
  database.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?);`).run(profileId, START_BALANCE)
}

console.log('\ncheckTournamentRegistrationDeadline')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-registration-deadline-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
const schedulers: Array<Awaited<ReturnType<typeof createTournamentScheduler>>> = []

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  const database = db

  const profiles = Array.from({ length: 400 }, () => randomUUID())
  profiles.forEach((profileId, index) => insertProfile(database, profileId, `Player ${index + 1}`))
  let nextProfileIndex = 0
  function allocProfiles(count: number): string[] {
    if (nextProfileIndex + count > profiles.length) throw new Error('profile pool exhausted')
    const slice = profiles.slice(nextProfileIndex, nextProfileIndex + count)
    nextProfileIndex += count
    return slice
  }

  tournamentStore = await createTournamentStore(dbPath)
  economyStore = await createTournamentEconomyStore(dbPath)
  const store = tournamentStore
  const economy = economyStore

  // Начало 20:00:00.000 българско време (EET, UTC+2 през ноември).
  const START_ISO = '2026-11-09T18:00:00.000Z'
  const START_MS = Date.parse(START_ISO)
  const at = (offsetMs: number) => new Date(START_MS + offsetMs)
  const LAST_MS = at(-1) // 19:59:59.999
  const AT_START = at(0) // 20:00:00.000
  const AT_1948 = at(-12 * 60 * 1000) // 19:48:00.000 — реалният отказан случай

  function createTournament(options: { startMode: 'scheduled' | 'fill'; shuffle?: boolean; scheduledStartAt?: string }): string {
    const creator = allocProfiles(1)[0] as string
    const result = store.createTournament({
      name: `Deadline ${randomUUID().slice(0, 8)}`,
      creatorProfileId: creator,
      visibility: 'public',
      entryFee: ENTRY_FEE,
      playerCapacity: 8,
      startMode: options.startMode,
      scheduledStartAt: options.startMode === 'scheduled' ? (options.scheduledStartAt ?? START_ISO) : null,
      shuffleEnabled: options.shuffle === true,
    })
    if (!result.ok) throw new Error(`tournament creation failed: ${result.reason}`)
    return result.tournament.tournamentId
  }

  function joinSolos(tournamentId: string, count: number, now: Date): string[] {
    const players = allocProfiles(count)
    for (const profileId of players) {
      const result = economy.joinTournamentSoloAtomically(tournamentId, profileId, { now })
      if (!result.ok) throw new Error(`seed solo join failed: ${result.reason}`)
    }
    return players
  }

  function tournamentStatus(tournamentId: string): string {
    return (database.prepare(`SELECT status FROM tournaments WHERE tournament_id = ?;`).get(tournamentId) as { status: string }).status
  }

  function countConfirmed(tournamentId: string): number {
    return (database.prepare(`SELECT COUNT(*) AS count FROM tournament_entries WHERE tournament_id = ? AND status = 'confirmed';`).get(tournamentId) as { count: number }).count
  }

  function inviteRow(inviteId: string): { status: string; expires_at: string } {
    return database.prepare(`SELECT status, expires_at FROM tournament_partner_invites WHERE invite_id = ?;`).get(inviteId) as { status: string; expires_at: string }
  }

  function countPendingInvites(tournamentId: string): number {
    return (database.prepare(`SELECT COUNT(*) AS count FROM tournament_partner_invites WHERE tournament_id = ? AND status = 'pending';`).get(tournamentId) as { count: number }).count
  }

  function balance(profileId: string): number {
    return (database.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;`).get(profileId) as { yellow_coins_balance: number }).yellow_coins_balance
  }

  async function tickAt(now: Date): Promise<void> {
    const scheduler = await createTournamentScheduler({
      databaseFilePath: dbPath,
      economyStore: economy,
      now: () => now,
      setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
      clearInterval: () => {},
      logError: (message, error) => console.error(message, error),
    })
    schedulers.push(scheduler)
    scheduler.tickNow()
  }

  function viewerFlags(tournamentId: string, viewerProfileId: string, nowMs: number) {
    const tournament = store.getTournamentById(tournamentId)
    if (tournament === null) throw new Error('tournament not found')
    const confirmedEntriesCount = countConfirmed(tournamentId)
    const reservedPlacesCount = countPendingInvites(tournamentId)
    const dto = toTournamentSummaryDto({
      tournament,
      creatorPublicProfile: null,
      confirmedEntriesCount,
      reservedPlacesCount,
      completedTeamsCount: 0,
      viewerProfileId,
      viewerEntryStatus: null,
      nowMs,
    })
    return dto.viewer
  }

  // ── [1] Реалният случай: 19:48, 2 свободни места, покана към партньор ──
  await check('[1] 19:48 с 2 свободни места: поканата се изпраща (без 30-мин отказ) и изтича точно в 20:00:00.000', () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    joinSolos(tournamentId, 6, AT_1948)
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const result = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: AT_1948 })
    assert(result.ok, `invite at 19:48 must succeed, got ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(new Date(result.invite.expiresAt).toISOString() === START_ISO, `expiresAt must equal start, got ${result.invite.expiresAt}`)
    const flags = viewerFlags(tournamentId, allocProfiles(1)[0] as string, AT_1948.getTime())
    assert(flags.canInvitePartner === false && flags.canJoinSolo === false, 'турнирът е пълен (6 + 2 резервирани) — външен зрител не може да влезе')
  })

  // ── [2] Изпращане и приемане в последната милисекунда ──
  await check('[2] покана в 19:59:59.999 + приемане в 19:59:59.999 завършва отбора; tick в 20:00:00.000 стартира турнира', async () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    joinSolos(tournamentId, 6, AT_1948)
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: LAST_MS })
    assert(invite.ok, `invite at 19:59:59.999 must succeed: ${JSON.stringify(invite)}`)
    if (!invite.ok) return
    const accept = economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, invitee, LAST_MS)
    assert(accept.ok, `accept at 19:59:59.999 must succeed: ${JSON.stringify(accept)}`)
    const team = database.prepare(`SELECT status FROM tournament_teams WHERE team_id = (SELECT team_id FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?);`).get(tournamentId, invitee) as { status: string }
    assert(team.status === 'complete', `team must be complete immediately, got ${team.status}`)
    assert(countConfirmed(tournamentId) === 8, 'all 8 places confirmed')
    await tickAt(AT_START)
    assert(tournamentStatus(tournamentId) === 'starting', `tournament must start at 20:00:00.000, got ${tournamentStatus(tournamentId)}`)
  })

  // ── [3] Самостоятелно записване: 19:59:59.999 да, 20:00:00.000 не ──
  await check('[3] самостоятелно записване: 19:59:59.999 — позволено; 20:00:00.000 — tournament_not_open (преди tick-а на scheduler-а)', () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    joinSolos(tournamentId, 5, AT_1948)
    const [last, late] = allocProfiles(2) as [string, string]
    const ok = economy.joinTournamentSoloAtomically(tournamentId, last, { now: LAST_MS })
    assert(ok.ok, `join at 19:59:59.999 must succeed: ${JSON.stringify(ok)}`)
    const lateBalance = balance(late)
    const closed = economy.joinTournamentSoloAtomically(tournamentId, late, { now: AT_START })
    assert(!closed.ok && closed.reason === 'tournament_not_open', `join at 20:00:00.000 must be refused, got ${JSON.stringify(closed)}`)
    assert(tournamentStatus(tournamentId) === 'open', 'status is still open (scheduler not ticked yet) — refusal comes from the time guard')
    assert(balance(late) === lateBalance, 'refused join must not debit')
  })

  // ── [4] Изпращане и приемане на покана при 20:00:00.000 ──
  await check('[4] покана в 20:00:00.000 → tournament_not_open; приемане в 20:00:00.000 на покана от 19:59 → tournament_not_open, поканата е изтекла', () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    joinSolos(tournamentId, 4, AT_1948)
    const [inviterA, inviteeA, inviterB, inviteeB] = allocProfiles(4) as [string, string, string, string]
    const balanceB = balance(inviterB)
    const lateInvite = economy.createPartnerInviteAtomically(tournamentId, inviterB, inviteeB, { now: AT_START })
    assert(!lateInvite.ok && lateInvite.reason === 'tournament_not_open', `invite at start must be refused: ${JSON.stringify(lateInvite)}`)
    assert(balance(inviterB) === balanceB, 'refused invite must not debit the inviter')

    const invite = economy.createPartnerInviteAtomically(tournamentId, inviterA, inviteeA, { now: at(-60_000) })
    assert(invite.ok, 'invite at 19:59:00 must succeed')
    if (!invite.ok) return
    const inviteeBalance = balance(inviteeA)
    const lateAccept = economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, inviteeA, AT_START)
    assert(!lateAccept.ok && lateAccept.reason === 'tournament_not_open', `accept at start must be refused: ${JSON.stringify(lateAccept)}`)
    assert(inviteRow(invite.invite.inviteId).status === 'expired', 'invite must be marked expired')
    assert(balance(inviteeA) === inviteeBalance, 'refused accept must not debit the invitee')
  })

  // ── [5] Изтичане на покана точно при старта ──
  await check('[5] изтичане: 19:59:59.999 — поканата е жива; 20:00:00.000 — изтича; поканилият остава платен самостоятелен участник', () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: AT_1948 })
    assert(invite.ok, 'invite must succeed')
    if (!invite.ok) return
    assert(economy.expireDuePartnerInvitesAtomically(tournamentId, LAST_MS) === 0, 'no expiry at 19:59:59.999')
    assert(inviteRow(invite.invite.inviteId).status === 'pending', 'still pending at 19:59:59.999')
    assert(economy.expireDuePartnerInvitesAtomically(tournamentId, AT_START) === 1, 'expires at 20:00:00.000')
    assert(inviteRow(invite.invite.inviteId).status === 'expired', 'marked expired')
    const entry = database.prepare(`SELECT status, joined_as FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;`).get(tournamentId, inviter) as { status: string; joined_as: string }
    assert(entry.status === 'confirmed' && entry.joined_as === 'solo', `inviter stays a confirmed solo entrant, got ${JSON.stringify(entry)}`)
    assert(balance(inviter) === START_BALANCE - ENTRY_FEE, 'inviter fee stays paid (existing rules, no refund on expiry)')
  })

  // ── [6] Старт с непотвърдена покана ──
  await check('[6] старт с чакаща покана: изтича атомарно в стартовата транзакция; отмяната е по съществуващото правило (7/8 потвърдени), с пълно връщане', async () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    const solos = joinSolos(tournamentId, 6, AT_1948)
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: AT_1948 })
    assert(invite.ok, 'invite must succeed')
    if (!invite.ok) return
    await tickAt(AT_START)
    assert(tournamentStatus(tournamentId) === 'auto_cancelled', `7 confirmed of 8 → auto-cancel, got ${tournamentStatus(tournamentId)}`)
    assert(countPendingInvites(tournamentId) === 0, 'no invite may remain pending after start time')
    // Отмяната почиства отборите (съществуващо поведение) — редът на
    // поканата може да е изтрит каскадно; важното е да не е 'pending'.
    const resolved = database.prepare(`SELECT status FROM tournament_partner_invites WHERE invite_id = ?;`).get(invite.invite.inviteId) as { status: string } | undefined
    assert(resolved === undefined || resolved.status !== 'pending', 'invite resolved')
    for (const profileId of [...solos, inviter]) {
      assert(balance(profileId) === START_BALANCE, `all confirmed participants refunded (${profileId})`)
    }
    assert(balance(invitee) === START_BALANCE, 'invitee was never charged')
  })

  await check('[6b] стартовата транзакция изтича и покани с expires_at след началния час (напр. стари данни/преместен по-рано старт) — без висящи покани', async () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    joinSolos(tournamentId, 6, AT_1948)
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: AT_1948 })
    assert(invite.ok, 'invite must succeed')
    if (!invite.ok) return
    database.prepare(`UPDATE tournament_partner_invites SET expires_at = ? WHERE invite_id = ?;`).run(at(60 * 60 * 1000).toISOString(), invite.invite.inviteId)
    const accept = economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, invitee, AT_START)
    assert(!accept.ok && accept.reason === 'tournament_not_open', `accept after start must be refused even with a later expires_at: ${JSON.stringify(accept)}`)
    const startResult = economy.startTournamentAtomically(tournamentId, AT_START)
    assert(!startResult.ok, 'cannot start with 7 confirmed')
    await tickAt(AT_START)
    assert(tournamentStatus(tournamentId) === 'auto_cancelled', 'underfilled → existing auto-cancel rule')
    assert(countPendingInvites(tournamentId) === 0, 'no invite left pending')
  })

  // ── [7] Две регистрации за последните 2 места ──
  await check('[7] последните 2 места в 19:59:59.999: първата покана ги резервира; втора покана и самостоятелно записване → отказ; без препълване', async () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    joinSolos(tournamentId, 6, AT_1948)
    const [p, q, r, s, u] = allocProfiles(5) as [string, string, string, string, string]
    const first = economy.createPartnerInviteAtomically(tournamentId, p, q, { now: LAST_MS })
    assert(first.ok, 'first invite wins the last 2 places')
    const second = economy.createPartnerInviteAtomically(tournamentId, r, s, { now: LAST_MS })
    assert(!second.ok && (second.reason === 'tournament_full' || second.reason === 'partner_requires_two_slots'), `second team must be refused: ${JSON.stringify(second)}`)
    const solo = economy.joinTournamentSoloAtomically(tournamentId, u, { now: LAST_MS })
    assert(!solo.ok && solo.reason === 'tournament_full', `solo must be refused: ${JSON.stringify(solo)}`)
    assert(balance(r) === START_BALANCE && balance(u) === START_BALANCE, 'refused players are not charged')
    if (!first.ok) return
    const accept = economy.acceptPartnerInviteAtomically(tournamentId, first.invite.inviteId, q, LAST_MS)
    assert(accept.ok, 'accept in the last millisecond succeeds')
    assert(countConfirmed(tournamentId) === 8, 'exactly 8 confirmed — no overfill')
    await tickAt(AT_START)
    assert(tournamentStatus(tournamentId) === 'starting', 'tournament starts')
  })

  // ── [8] Едновременно приемане и старт (SQLite сериализира — двата реда) ──
  await check('[8a] приемане (19:59:59.999) обработено ПРЕДИ стартовата транзакция → турнирът стартира с отбора', async () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    joinSolos(tournamentId, 6, AT_1948)
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: at(-5_000) })
    if (!invite.ok) throw new Error('invite failed')
    assert(economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, invitee, LAST_MS).ok, 'accept ok')
    await tickAt(at(3))
    assert(tournamentStatus(tournamentId) === 'starting', 'started including the accepted team')
  })

  await check('[8b] приемане, обработено СЛЕД стартовата транзакция (дори заявката да е от 19:59:59.999) → отказ, без такса', async () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    joinSolos(tournamentId, 6, AT_1948)
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: at(-5_000) })
    if (!invite.ok) throw new Error('invite failed')
    await tickAt(AT_START)
    assert(tournamentStatus(tournamentId) === 'auto_cancelled', 'start transaction ran first → underfilled → cancelled')
    const accept = economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, invitee, LAST_MS)
    assert(!accept.ok, `late-processed accept must fail: ${JSON.stringify(accept)}`)
    assert(balance(invitee) === START_BALANCE, 'invitee not charged')
  })

  // ── [9] Идемпотентният fast path не връща "мъртва" покана след старта ──
  await check('[9] повторно изпращане на същата покана в 20:00:00.000 → tournament_not_open (не stale ok)', () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: AT_1948 })
    assert(invite.ok, 'invite ok')
    const retryBefore = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: LAST_MS })
    assert(retryBefore.ok && invite.ok && retryBefore.invite.inviteId === invite.invite.inviteId, 'retry before start is idempotent')
    const retryAfter = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: AT_START })
    assert(!retryAfter.ok && retryAfter.reason === 'tournament_not_open', `retry at start must fail: ${JSON.stringify(retryAfter)}`)
  })

  // ── [10] Разбъркване: покани остават забранени, самостоятелно до старта ──
  await check('[10] турнир с разбъркване: покана → shuffle_mode_no_partner_invites; самостоятелно 19:59:59.999 да, 20:00:00.000 не; старт с разбъркване', async () => {
    const tournamentId = createTournament({ startMode: 'scheduled', shuffle: true })
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: LAST_MS })
    assert(!invite.ok && invite.reason === 'shuffle_mode_no_partner_invites', `invites forbidden: ${JSON.stringify(invite)}`)
    joinSolos(tournamentId, 7, AT_1948)
    const [last, late] = allocProfiles(2) as [string, string]
    const flags = viewerFlags(tournamentId, last, LAST_MS.getTime())
    assert(flags.canJoinSolo === true && flags.canInvitePartner === false, `DTO 19:59:59.999: solo yes, invite no — got ${JSON.stringify(flags)}`)
    assert(economy.joinTournamentSoloAtomically(tournamentId, last, { now: LAST_MS }).ok, 'last solo at 19:59:59.999 ok')
    const closed = economy.joinTournamentSoloAtomically(tournamentId, late, { now: AT_START })
    assert(!closed.ok, 'solo at start refused')
    await tickAt(AT_START)
    assert(tournamentStatus(tournamentId) === 'starting', 'shuffle tournament starts with 8 solos')
  })

  // ── [11] DTO: canInvitePartner/canJoinSolo без изкуствен буфер ──
  await check('[11] DTO: 19:48 и 19:59:59.999 → canInvitePartner/canJoinSolo = true (2 свободни места); 20:00:00.000 → false', () => {
    const tournamentId = createTournament({ startMode: 'scheduled' })
    joinSolos(tournamentId, 6, AT_1948)
    const viewer = allocProfiles(1)[0] as string
    for (const now of [AT_1948, LAST_MS]) {
      const flags = viewerFlags(tournamentId, viewer, now.getTime())
      assert(flags.canInvitePartner === true && flags.canJoinSolo === true, `at ${now.toISOString()}: ${JSON.stringify(flags)}`)
    }
    const closedFlags = viewerFlags(tournamentId, viewer, AT_START.getTime())
    assert(closedFlags.canInvitePartner === false && closedFlags.canJoinSolo === false, `at start: ${JSON.stringify(closedFlags)}`)
  })

  // ── [12] Scheduler-ът не стартира преди началния час (милисекундна точност) ──
  await check('[12] начало 20:00:00.500: tick в 20:00:00.100 не стартира, записване в 20:00:00.400 е позволено; tick в 20:00:00.500 стартира', async () => {
    const startIso = at(500).toISOString()
    const tournamentId = createTournament({ startMode: 'scheduled', scheduledStartAt: startIso })
    joinSolos(tournamentId, 7, AT_1948)
    await tickAt(at(100))
    assert(tournamentStatus(tournamentId) === 'open', `must not start before 20:00:00.500, got ${tournamentStatus(tournamentId)}`)
    const last = allocProfiles(1)[0] as string
    assert(economy.joinTournamentSoloAtomically(tournamentId, last, { now: at(400) }).ok, 'join at 20:00:00.400 ok')
    await tickAt(at(500))
    assert(tournamentStatus(tournamentId) === 'starting', 'starts at 20:00:00.500')
  })

  // ── [13] Преместен по-рано старт: поканата не надживява новия начален час ──
  await check('[13] старт преместен по-рано (22:00 → 20:00): приемане до 19:59:59.999 работи, в 20:00:00.000 — отказ', () => {
    const tournamentId = createTournament({ startMode: 'scheduled', scheduledStartAt: at(2 * 60 * 60 * 1000).toISOString() })
    const creator = (database.prepare(`SELECT creator_profile_id FROM tournaments WHERE tournament_id = ?;`).get(tournamentId) as { creator_profile_id: string }).creator_profile_id
    const [inviterA, inviteeA, inviterB, inviteeB] = allocProfiles(4) as [string, string, string, string]
    const inviteA = economy.createPartnerInviteAtomically(tournamentId, inviterA, inviteeA, { now: AT_1948 })
    const inviteB = economy.createPartnerInviteAtomically(tournamentId, inviterB, inviteeB, { now: AT_1948 })
    if (!inviteA.ok || !inviteB.ok) throw new Error('seed invites failed')
    const edit = store.updateScheduledStartAt(tournamentId, creator, START_ISO)
    assert(edit.ok, 'schedule edit ok')
    assert(economy.acceptPartnerInviteAtomically(tournamentId, inviteA.invite.inviteId, inviteeA, LAST_MS).ok, 'accept at 19:59:59.999 ok')
    const late = economy.acceptPartnerInviteAtomically(tournamentId, inviteB.invite.inviteId, inviteeB, AT_START)
    assert(!late.ok && late.reason === 'tournament_not_open', `accept at new start refused: ${JSON.stringify(late)}`)
  })

  // ── [14] Fill турнири: без нови времеви ограничения ──
  const FILL_NOW = new Date('2026-11-09T17:00:00.000Z')
  function setFillExpires(tournamentId: string, iso: string): void {
    database.prepare(`UPDATE tournaments SET fill_expires_at = ? WHERE tournament_id = ?;`).run(iso, tournamentId)
  }

  await check('[14a] fill: срокът на поканата е 60 мин, но не след fill_expires_at; покана и приемане в последната милисекунда преди срока', async () => {
    const tournamentId = createTournament({ startMode: 'fill' })
    const fillExpiresIso = new Date(FILL_NOW.getTime() + 20 * 60 * 1000).toISOString()
    setFillExpires(tournamentId, fillExpiresIso)
    joinSolos(tournamentId, 6, FILL_NOW)
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const lastMs = new Date(Date.parse(fillExpiresIso) - 1)
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: lastMs })
    assert(invite.ok, `invite 1 ms before fill deadline ok: ${JSON.stringify(invite)}`)
    if (!invite.ok) return
    assert(new Date(invite.invite.expiresAt).toISOString() === fillExpiresIso, `capped at fill_expires_at, got ${invite.invite.expiresAt}`)
    assert(economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, invitee, lastMs).ok, 'accept ok')
    await tickAt(lastMs)
    assert(tournamentStatus(tournamentId) === 'starting', `fill tournament auto-starts when full, got ${tournamentStatus(tournamentId)}`)
  })

  await check('[14b] fill: 60-мин срок, когато fill_expires_at е по-късно; чакаща покана не стартира турнира, след приемане — автоматичен старт', async () => {
    const tournamentId = createTournament({ startMode: 'fill' })
    setFillExpires(tournamentId, new Date(FILL_NOW.getTime() + 2 * 60 * 60 * 1000).toISOString())
    joinSolos(tournamentId, 6, FILL_NOW)
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: FILL_NOW })
    if (!invite.ok) throw new Error(`invite failed: ${JSON.stringify(invite)}`)
    assert(new Date(invite.invite.expiresAt).getTime() === FILL_NOW.getTime() + 60 * 60 * 1000, `60-minute TTL, got ${invite.invite.expiresAt}`)
    await tickAt(new Date(FILL_NOW.getTime() + 1_000))
    assert(tournamentStatus(tournamentId) === 'open', 'pending invite: not started yet (7 confirmed)')
    assert(economy.acceptPartnerInviteAtomically(tournamentId, invite.invite.inviteId, invitee, new Date(FILL_NOW.getTime() + 2_000)).ok, 'accept ok')
    await tickAt(new Date(FILL_NOW.getTime() + 3_000))
    assert(tournamentStatus(tournamentId) === 'starting', 'auto-start after acceptance')
  })

  await check('[14c] fill: изтекла непотвърдена покана освобождава мястото и турнирът може да се запълни и стартира', async () => {
    const tournamentId = createTournament({ startMode: 'fill' })
    setFillExpires(tournamentId, new Date(FILL_NOW.getTime() + 3 * 60 * 60 * 1000).toISOString())
    joinSolos(tournamentId, 6, FILL_NOW)
    const [inviter, invitee] = allocProfiles(2) as [string, string]
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: FILL_NOW })
    if (!invite.ok) throw new Error('invite failed')
    const afterTtl = new Date(FILL_NOW.getTime() + 60 * 60 * 1000)
    await tickAt(afterTtl)
    assert(inviteRow(invite.invite.inviteId).status === 'expired', 'invite expired at TTL')
    assert(tournamentStatus(tournamentId) === 'open', 'still open, 7 confirmed')
    const filler = allocProfiles(1)[0] as string
    assert(economy.joinTournamentSoloAtomically(tournamentId, filler, { now: afterTtl }).ok, 'freed place can be taken')
    await tickAt(new Date(afterTtl.getTime() + 1_000))
    assert(tournamentStatus(tournamentId) === 'starting', 'starts once really full')
  })

  // ── [15] Източник: няма останал 30-минутен буфер ──
  await check('[15] computePartnerInviteExpiresAt вече няма 30-минутен буфер', async () => {
    const source = await readFile(join(serverRootPath, 'src', 'db', 'tournamentEconomyStore.ts'), 'utf8')
    const fnStart = source.indexOf('function computePartnerInviteExpiresAt')
    const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart))
    assert(fnStart >= 0 && !fnBody.includes('30 * 60 * 1000'), 'no 30-minute buffer in computePartnerInviteExpiresAt')
  })
} finally {
  for (const scheduler of schedulers) {
    try { scheduler.stop() } catch {}
  }
  try { economyStore?.close?.() } catch {}
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\ncheckTournamentRegistrationDeadline: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
