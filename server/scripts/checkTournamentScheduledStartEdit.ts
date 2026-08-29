/**
 * checkTournamentScheduledStartEdit.ts
 *
 * Targeted regression за "EDIT SCHEDULED START" — tournament creator може да
 * редактира ИЗКЛЮЧИТЕЛНО scheduled_start_at на не-стартирал 'scheduled'
 * турнир (PATCH /api/tournaments/:id/scheduled-start,
 * tournamentStore.updateScheduledStartAt). Проверява authorization,
 * state-machine guard, reuse на creation validator/timezone semantics,
 * пълна изолация от entries/teams/economy/invites, и че scheduler-ът реално
 * следва новия deadline (не cached timer).
 *
 * Покрива точно 10-те DB/scheduler-related сценария от task spec-а
 * (номерирани по-долу) плюс кратка "source wiring" проверка за HTTP
 * handler-а/client-а (§11-14, огледално на checkTournamentPartnerInviteNotifications.ts
 * pattern-а — не спъва пълен HTTP/browser stack за самата wiring проверка).
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'
import { validateTournamentScheduledStartAt } from '../src/tournament/tournamentValidation.js'

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

function countRows(database: DatabaseSync, sql: string, ...params: unknown[]): number {
  return (database.prepare(sql).get(...params) as { count: number }).count
}

function getTournamentRow(database: DatabaseSync, tournamentId: string): { status: string; scheduled_start_at: string | null } {
  return database.prepare(`SELECT status, scheduled_start_at FROM tournaments WHERE tournament_id = ?;`).get(tournamentId) as {
    status: string
    scheduled_start_at: string | null
  }
}

type SnapshotRow = Record<string, unknown>

function snapshot(database: DatabaseSync, sql: string, ...params: unknown[]): SnapshotRow[] {
  return database.prepare(sql).all(...params) as SnapshotRow[]
}

console.log('\ncheckTournamentScheduledStartEdit')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-schedule-edit-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let tournamentStore: Awaited<ReturnType<typeof createTournamentStore>> | null = null
let economyStore: Awaited<ReturnType<typeof createTournamentEconomyStore>> | null = null
let scheduler: Awaited<ReturnType<typeof createTournamentScheduler>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)

  const profiles = Array.from({ length: 60 }, () => randomUUID())
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

  function createScheduledTournament(creatorProfileId: string, scheduledStartAt: string, name: string): string {
    const result = store.createTournament({
      name,
      creatorProfileId,
      visibility: 'public',
      entryFee: 5_000,
      playerCapacity: 8,
      startMode: 'scheduled',
      scheduledStartAt,
    })
    if (!result.ok) throw new Error(`seed tournament creation failed: ${result.reason}`)
    return result.tournament.tournamentId
  }

  // Exactly mirrors handleTournamentScheduledStartUpdateRequest's composition
  // (server/src/index.ts): validate via the SAME creation validator, THEN
  // call the narrow store mutation — proves the real integration, not just
  // the store function in isolation.
  function attemptScheduleEdit(
    tournamentId: string,
    requesterProfileId: string,
    rawNewIso: string,
    nowMs: number,
  ) {
    const validation = validateTournamentScheduledStartAt(rawNewIso, nowMs)
    if (!validation.ok) {
      return { ok: false as const, reason: validation.code }
    }
    return store.updateScheduledStartAt(tournamentId, requesterProfileId, validation.scheduledStartAt)
  }

  const baseNowMs = new Date('2026-08-30T10:00:00.000Z').getTime()

  // ── [1] Creator edits a future scheduled start successfully ──
  await check('[1] creator edits future scheduled start successfully', () => {
    const [creator] = allocProfiles(1)
    const tournamentId = createScheduledTournament(creator, '2026-08-30T22:00:00.000Z', 'Scenario 1')
    const newIso = '2026-08-30T23:00:00.000Z'
    const result = attemptScheduleEdit(tournamentId, creator, newIso, baseNowMs)
    assert(result.ok, `edit failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.tournament.scheduledStartAt === newIso, `expected ${newIso}, got ${result.tournament.scheduledStartAt}`)
    assert(getTournamentRow(db!, tournamentId).scheduled_start_at === newIso, 'DB row should hold the new timestamp')
  })

  // ── [2] 22:00 -> 21:00 records correctly (the exact real-world use case) ──
  await check('[2] 22:00 -> 21:00 is recorded exactly', () => {
    const [creator] = allocProfiles(1)
    const tournamentId = createScheduledTournament(creator, '2026-08-30T22:00:00.000Z', 'Scenario 2')
    const result = attemptScheduleEdit(tournamentId, creator, '2026-08-30T21:00:00.000Z', baseNowMs)
    assert(result.ok, `edit failed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    assert(result.tournament.scheduledStartAt === '2026-08-30T21:00:00.000Z', `expected 21:00, got ${result.tournament.scheduledStartAt}`)
  })

  // ── [3] Non-creator participant gets a server refusal ──
  await check('[3] a participant who is not the creator gets not_creator, no mutation', () => {
    const [creator, other] = allocProfiles(2)
    const originalIso = '2026-08-30T22:00:00.000Z'
    const tournamentId = createScheduledTournament(creator, originalIso, 'Scenario 3')
    const result = attemptScheduleEdit(tournamentId, other, '2026-08-30T21:00:00.000Z', baseNowMs)
    assert(!result.ok && result.reason === 'not_creator', `expected not_creator, got ${JSON.stringify(result)}`)
    assert(getTournamentRow(db!, tournamentId).scheduled_start_at === originalIso, 'scheduled_start_at must remain unchanged')
  })

  // ── [4] A tournament that already started cannot be edited ──
  await check('[4] a started tournament cannot have its schedule edited', () => {
    const [creator] = allocProfiles(1)
    const originalIso = '2026-08-30T22:00:00.000Z'
    const tournamentId = createScheduledTournament(creator, originalIso, 'Scenario 4')
    const statusChanged = store.updateTournamentStatus(tournamentId, 'open', 'starting')
    if (!statusChanged) throw new Error('seed status transition failed')
    const result = attemptScheduleEdit(tournamentId, creator, '2026-08-30T21:00:00.000Z', baseNowMs)
    assert(!result.ok && result.reason === 'tournament_not_open', `expected tournament_not_open, got ${JSON.stringify(result)}`)
    assert(getTournamentRow(db!, tournamentId).scheduled_start_at === originalIso, 'scheduled_start_at must remain unchanged')
  })

  // Every other terminal/active status must be equally blocked (not just 'starting').
  await check('[4b] every non-open status blocks the edit (semifinal/final/finished/cancelled/failed)', () => {
    const blockedStatuses = ['semifinal_in_progress', 'final_in_progress', 'finished', 'cancelled', 'admin_cancelled', 'auto_cancelled', 'failed'] as const
    for (const status of blockedStatuses) {
      const [creator] = allocProfiles(1)
      const tournamentId = createScheduledTournament(creator, '2026-08-30T22:00:00.000Z', `Scenario 4b ${status}`)
      db!.prepare(`UPDATE tournaments SET status = ? WHERE tournament_id = ?;`).run(status, tournamentId)
      const result = attemptScheduleEdit(tournamentId, creator, '2026-08-30T21:00:00.000Z', baseNowMs)
      assert(!result.ok && result.reason === 'tournament_not_open', `status=${status}: expected tournament_not_open, got ${JSON.stringify(result)}`)
    }
  })

  // A fill-mode tournament (no scheduled start concept) must also be rejected.
  await check('[4c] a fill-mode tournament (no scheduled start) is rejected as not_scheduled_mode', () => {
    const [creator] = allocProfiles(1)
    const fillResult = store.createTournament({
      name: 'Scenario 4c',
      creatorProfileId: creator,
      visibility: 'public',
      entryFee: 5_000,
      playerCapacity: 8,
      startMode: 'fill',
    })
    if (!fillResult.ok) throw new Error('seed fill tournament creation failed')
    const result = attemptScheduleEdit(fillResult.tournament.tournamentId, creator, '2026-08-30T21:00:00.000Z', baseNowMs)
    assert(!result.ok && result.reason === 'not_scheduled_mode', `expected not_scheduled_mode, got ${JSON.stringify(result)}`)
  })

  // ── [5] Invalid/malformed datetime is rejected ──
  await check('[5] malformed datetime is rejected (invalid_timestamp), no mutation', () => {
    const [creator] = allocProfiles(1)
    const originalIso = '2026-08-30T22:00:00.000Z'
    const tournamentId = createScheduledTournament(creator, originalIso, 'Scenario 5')
    const result = attemptScheduleEdit(tournamentId, creator, 'not-a-real-date', baseNowMs)
    assert(!result.ok && result.reason === 'invalid_timestamp', `expected invalid_timestamp, got ${JSON.stringify(result)}`)
    assert(getTournamentRow(db!, tournamentId).scheduled_start_at === originalIso, 'scheduled_start_at must remain unchanged')
  })

  // ── [6] Past datetime (relative to server time) is rejected ──
  await check('[6] a past datetime is rejected (too_soon), no mutation', () => {
    const [creator] = allocProfiles(1)
    const originalIso = '2026-08-30T22:00:00.000Z'
    const tournamentId = createScheduledTournament(creator, originalIso, 'Scenario 6')
    const pastIso = new Date(baseNowMs - 60_000).toISOString()
    const result = attemptScheduleEdit(tournamentId, creator, pastIso, baseNowMs)
    assert(!result.ok && result.reason === 'too_soon', `expected too_soon, got ${JSON.stringify(result)}`)
    assert(getTournamentRow(db!, tournamentId).scheduled_start_at === originalIso, 'scheduled_start_at must remain unchanged')
  })

  await check('[6b] a datetime more than 7 days out is rejected (too_late)', () => {
    const [creator] = allocProfiles(1)
    const tournamentId = createScheduledTournament(creator, '2026-08-30T22:00:00.000Z', 'Scenario 6b')
    const tooLateIso = new Date(baseNowMs + 8 * 24 * 60 * 60 * 1000).toISOString()
    const result = attemptScheduleEdit(tournamentId, creator, tooLateIso, baseNowMs)
    assert(!result.ok && result.reason === 'too_late', `expected too_late, got ${JSON.stringify(result)}`)
  })

  // ── [7]-[10]: editing the schedule must not touch entries/teams/ledger/invites ──
  await check('[7]-[10] existing participants, teams, ledger, and partner invites are byte-for-byte unchanged after a schedule edit', () => {
    const [creator, soloA, soloB, inviter, invitee] = allocProfiles(5)
    const tournamentId = createScheduledTournament(creator, '2026-08-30T22:00:00.000Z', 'Scenario 7-10')

    // Populate realistic pre-existing state: two solo joins (auto-pair into
    // a ready team) + a pending explicit partner invite.
    const joinA = economy.joinTournamentSoloAtomically(tournamentId, soloA, { now: new Date(baseNowMs) })
    if (!joinA.ok) throw new Error('seed join A failed')
    const joinB = economy.joinTournamentSoloAtomically(tournamentId, soloB, { now: new Date(baseNowMs) })
    if (!joinB.ok) throw new Error('seed join B failed')
    const invite = economy.createPartnerInviteAtomically(tournamentId, inviter, invitee, { now: new Date(baseNowMs) })
    if (!invite.ok) throw new Error('seed invite failed')

    const entriesBefore = snapshot(db!, `SELECT * FROM tournament_entries WHERE tournament_id = ? ORDER BY entry_id;`, tournamentId)
    const teamsBefore = snapshot(db!, `SELECT * FROM tournament_teams WHERE tournament_id = ? ORDER BY team_id;`, tournamentId)
    const ledgerBefore = snapshot(db!, `SELECT * FROM tournament_economy_ledger WHERE tournament_id = ? ORDER BY ledger_id;`, tournamentId)
    const invitesBefore = snapshot(db!, `SELECT * FROM tournament_partner_invites WHERE tournament_id = ? ORDER BY invite_id;`, tournamentId)
    const walletsBefore = [soloA, soloB, inviter, invitee].map((p) =>
      (db!.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;`).get(p) as { yellow_coins_balance: number }).yellow_coins_balance,
    )

    const editResult = attemptScheduleEdit(tournamentId, creator, '2026-08-30T21:00:00.000Z', baseNowMs)
    assert(editResult.ok, `edit failed: ${JSON.stringify(editResult)}`)

    const entriesAfter = snapshot(db!, `SELECT * FROM tournament_entries WHERE tournament_id = ? ORDER BY entry_id;`, tournamentId)
    const teamsAfter = snapshot(db!, `SELECT * FROM tournament_teams WHERE tournament_id = ? ORDER BY team_id;`, tournamentId)
    const ledgerAfter = snapshot(db!, `SELECT * FROM tournament_economy_ledger WHERE tournament_id = ? ORDER BY ledger_id;`, tournamentId)
    const invitesAfter = snapshot(db!, `SELECT * FROM tournament_partner_invites WHERE tournament_id = ? ORDER BY invite_id;`, tournamentId)
    const walletsAfter = [soloA, soloB, inviter, invitee].map((p) =>
      (db!.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?;`).get(p) as { yellow_coins_balance: number }).yellow_coins_balance,
    )

    assert(entriesBefore.length > 0 && JSON.stringify(entriesBefore) === JSON.stringify(entriesAfter), '[7] tournament_entries must be byte-for-byte unchanged')
    assert(teamsBefore.length > 0 && JSON.stringify(teamsBefore) === JSON.stringify(teamsAfter), '[8] tournament_teams must be byte-for-byte unchanged')
    assert(ledgerBefore.length > 0 && JSON.stringify(ledgerBefore) === JSON.stringify(ledgerAfter), '[9] tournament_economy_ledger must be byte-for-byte unchanged (no new debit/refund)')
    assert(invitesBefore.length > 0 && JSON.stringify(invitesBefore) === JSON.stringify(invitesAfter), '[10] tournament_partner_invites must be byte-for-byte unchanged')
    assert(JSON.stringify(walletsBefore) === JSON.stringify(walletsAfter), 'wallet balances must be untouched (no debit/refund)')
  })

  // ── [16] Scheduler follows the NEW deadline, not a stale cached one ──
  // Tick strictly BETWEEN the new (21:00) and old (22:00) deadlines below —
  // this proves the scheduler reads scheduled_start_at fresh from the DB on
  // every tick (no per-tournament cached timer/deadline object anywhere in
  // tournamentScheduler.ts — see selectDueScheduledTournamentIdsStatement, a
  // plain `datetime(scheduled_start_at) <= datetime(?)` query), not stuck on
  // whatever deadline existed at tournament-creation time.
  await check('[16b] scheduler tick at 21:30 (after new deadline, before old one) actually starts the tournament', async () => {
    const [creator, ...players] = allocProfiles(9)
    const tournamentId = createScheduledTournament(creator, '2026-08-30T22:00:00.000Z', 'Scenario 16b')
    for (const profileId of players.slice(0, 8)) {
      const r = economy.joinTournamentSoloAtomically(tournamentId, profileId, { now: new Date(baseNowMs) })
      if (!r.ok) throw new Error(`seed fill join failed: ${JSON.stringify(r)}`)
    }
    const editResult = attemptScheduleEdit(tournamentId, creator, '2026-08-30T21:00:00.000Z', baseNowMs)
    if (!editResult.ok) throw new Error('seed edit failed')

    scheduler = await createTournamentScheduler({
      databaseFilePath: dbPath,
      economyStore: economy,
      now: () => new Date('2026-08-30T21:30:00.000Z'),
      setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
      clearInterval: () => {},
    })
    scheduler.tickNow()
    assert(getTournamentRow(db!, tournamentId).status === 'starting', 'tournament must have started at 21:30 — new deadline is authoritative, not the stale 22:00')
    assert(countRows(db!, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, tournamentId) === 1, 'exactly one start (one system fee ledger row)')

    // No double-start: tick again well past the OLD 22:00 deadline too.
    scheduler.close()
    scheduler = await createTournamentScheduler({
      databaseFilePath: dbPath,
      economyStore: economy,
      now: () => new Date('2026-08-30T23:00:00.000Z'),
      setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
      clearInterval: () => {},
    })
    scheduler.tickNow()
    assert(countRows(db!, `SELECT COUNT(*) as count FROM tournament_economy_ledger WHERE tournament_id = ? AND entry_type = 'system_fee';`, tournamentId) === 1, 'no double-start: still exactly one system fee ledger row after a later tick')
  })

  await check('[16c] restart-safe: a BRAND NEW scheduler instance (simulating server restart) still sees the edited deadline from persistence', async () => {
    const [creator, ...players] = allocProfiles(9)
    const tournamentId = createScheduledTournament(creator, '2026-08-30T22:00:00.000Z', 'Scenario 16c')
    for (const profileId of players.slice(0, 8)) {
      const r = economy.joinTournamentSoloAtomically(tournamentId, profileId, { now: new Date(baseNowMs) })
      if (!r.ok) throw new Error(`seed fill join failed: ${JSON.stringify(r)}`)
    }
    const editResult = attemptScheduleEdit(tournamentId, creator, '2026-08-30T21:00:00.000Z', baseNowMs)
    if (!editResult.ok) throw new Error('seed edit failed')

    // No process/store re-use at all from earlier scenarios — a fresh
    // economyStore AND a fresh scheduler against the SAME db file, exactly
    // like a real server restart.
    const restartedEconomy = await createTournamentEconomyStore(dbPath)
    const restartedScheduler = await createTournamentScheduler({
      databaseFilePath: dbPath,
      economyStore: restartedEconomy,
      now: () => new Date('2026-08-30T21:15:00.000Z'),
      setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
      clearInterval: () => {},
    })
    try {
      restartedScheduler.tickNow()
      assert(getTournamentRow(db!, tournamentId).status === 'starting', 'restarted process must still start at the edited 21:00 deadline (read from persistence, no stale in-memory state)')
    } finally {
      restartedScheduler.close()
      restartedEconomy.close()
    }
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

  // ── [11]-[14] Source-wiring proof (mirrors checkTournamentPartnerInviteNotifications.ts —
  // full HTTP/browser stack for wiring-only claims is out of scope here; the
  // functional behavior above is proven by real execution) ──
  const projectRoot = resolve(
    process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length) ?? join(process.cwd(), '..'),
  )
  const indexSource = await readFile(join(projectRoot, 'server', 'src', 'index.ts'), 'utf8')
  const tournamentsScreenSource = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'), 'utf8')
  const controllerSource = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
  const clientTypesSource = await readFile(join(projectRoot, 'src', 'app', 'network', 'createGameServerClient.ts'), 'utf8')

  await check('[server wiring] narrow PATCH endpoint exists, and its handler reads/mutates ONLY scheduledStartAt', () => {
    assert(indexSource.includes("/^\\/api\\/tournaments\\/([^/]+)\\/scheduled-start$/"), 'expected the narrow scheduled-start route regex')
    // Non-greedy \n}\n stops at the first inner block's closing brace, not
    // the function's own — bound the extraction by the next top-level
    // declaration that immediately follows it in index.ts instead.
    const handlerStart = indexSource.indexOf('async function handleTournamentScheduledStartUpdateRequest(')
    const handlerEnd = indexSource.indexOf('const adminTournamentActionRateLimitByProfileId', handlerStart)
    assert(handlerStart !== -1 && handlerEnd !== -1 && handlerEnd > handlerStart, 'expected handleTournamentScheduledStartUpdateRequest to exist')
    const handlerBody = indexSource.slice(handlerStart, handlerEnd)
    assert(
      !/body\.(name|entryFee|playerCapacity|teamCapacity|password|visibility)\b/.test(handlerBody),
      'handler must not read any other tournament field (name/entryFee/capacity/password/visibility) from the request body — not a generic tournament PATCH',
    )
    assert(
      (handlerBody.match(/tournamentStore\.updateScheduledStartAt\(/g) ?? []).length === 1,
      'must call the narrow single-field mutation exactly once',
    )
  })
  await check('[server wiring] reuses the creation validator/session/beta-access guards, no ad-hoc reimplementation', () => {
    assert(indexSource.includes('validateTournamentScheduledStartAt(body.scheduledStartAt)'), 'must reuse validateTournamentScheduledStartAt')
    assert(indexSource.includes('tournamentStore.updateScheduledStartAt('), 'must call the narrow store mutation')
    assert(indexSource.includes('requireRegisteredHumanSession(req)') && indexSource.match(/scheduled-start[\s\S]{0,4000}requireTournamentBetaAccessOrRespond/), 'must gate behind session + beta access like other tournament mutations')
  })
  await check('[server wiring] broadcasts a semantically distinct realtime event, not a misleading reuse of tournament_team_updated', () => {
    assert(indexSource.includes("type: 'tournament_schedule_updated'"), 'expected a dedicated tournament_schedule_updated push')
    assert(clientTypesSource.includes('TournamentScheduleUpdatedMessage'), 'expected the client message type to exist')
  })
  await check('[client wiring §11/§12] the edit button is gated on isMine (creator-only) via canEditTournamentSchedule', () => {
    assert(tournamentsScreenSource.includes('function canEditTournamentSchedule'), 'expected a dedicated visibility helper')
    assert(/function canEditTournamentSchedule[\s\S]{0,200}t\.isMine/.test(tournamentsScreenSource), 'visibility must require t.isMine (creator)')
    assert(tournamentsScreenSource.includes("canEditTournamentSchedule(t) ? `"), 'the button markup must be gated by the helper')
  })
  await check('[client wiring] the popup edits ONLY date/time — no name/entryFee/capacity/format fields', () => {
    const popupMatch = tournamentsScreenSource.match(/function renderTournamentScheduleEditPopup[\s\S]*?\n}/)
    assert(popupMatch !== null, 'expected renderTournamentScheduleEditPopup to exist')
    const popupBody = popupMatch![0]
    assert(popupBody.includes('type="date"') && popupBody.includes('type="time"'), 'must have separate date and time inputs')
    assert(!/name="name"|entryFee|playerCapacity|teamCapacity|password/.test(popupBody), 'must not expose any other tournament field')
  })
  await check('[client wiring §13] a successful save triggers the canonical fetchTournamentDetail refetch', () => {
    assert(/submitTournamentScheduleEdit[\s\S]*?fetchTournamentDetail\(tournamentId\)/.test(controllerSource), 'expected fetchTournamentDetail to be called on success')
  })
  await check('[client wiring] realtime push handler triggers the same canonical refetch for other open viewers', () => {
    assert(/tournament_schedule_updated'\)\s*\{[\s\S]{0,300}fetchTournamentDetail\(message\.tournamentId\)/.test(controllerSource), 'expected the WS handler to call fetchTournamentDetail')
  })
} finally {
  try { scheduler?.close() } catch {}
  try { economyStore?.close() } catch {}
  try { tournamentStore?.close() } catch {}
  try { db?.close() } catch {}
  await rm(tempDir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\ncheckTournamentScheduledStartEdit failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckTournamentScheduledStartEdit passed: ${passed} checks`)
