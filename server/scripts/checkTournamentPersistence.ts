/**
 * checkTournamentPersistence.ts
 *
 * Доказва, че турнирната persistence основа (миграции 20260730_001,
 * 20260730_002 + tournamentStore.ts) е коректна и безопасна:
 *   - реалните migration файлове от server/database/migrations/ се
 *     прилагат чисто върху празна temp SQLite база (не production!);
 *   - runner-ът е idempotent (повторен run не поврежда schema);
 *   - всички очаквани таблици/индекси съществуват;
 *   - CHECK constraints (enum-и, public/password, fill/scheduled,
 *     system_fee/profile_id консистентност) отхвърлят невалидни данни;
 *   - UNIQUE constraints (entry дублиране, seed_slot, pending invite,
 *     idempotency_key) работят;
 *   - JSON validity checks работят;
 *   - foreign-key violations се отхвърлят;
 *   - tournamentStore CRUD методите четат/пишат/мапват коректно.
 *
 * Работи изцяло върху изолирано temp SQLite копие (mkdtemp) — никога не
 * докосва server/database/data/belot-v2.sqlite.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createTournamentStore, type TournamentStore } from '../src/db/tournamentStore.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok ${label}`)
    passed++
  } else {
    console.error(`  FAIL ${label}`)
    failed++
  }
}

function checkThrows(label: string, fn: () => void): void {
  try {
    fn()
    console.error(`  FAIL ${label} (expected throw, none happened)`)
    failed++
  } catch {
    console.log(`  ok ${label}`)
    passed++
  }
}

console.log('\ncheckTournamentPersistence')

// ─── Локиране на реалната migrations директория (readonly source) ─────────

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
const realMigrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')

async function loadMigrationFileNames(migrationsDirectoryPath: string): Promise<string[]> {
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

const MANUAL_TRANSACTION_MARKER = '-- MANUAL_TRANSACTION_MIGRATION'

/**
 * Минимална копия на runner-логиката от ensureServerDatabaseReady.ts,
 * параметризирана по database path — за да можем да приложим РЕАЛНИТЕ
 * .sql файлове от диска върху изолирана temp база, без да пипаме
 * production database файла (ensureServerDatabaseReady() самата винаги
 * пише в server/database/data/belot-v2.sqlite и няма override параметър).
 */
async function applyMigrations(
  database: DatabaseSync,
  migrationsDirectoryPath: string,
): Promise<{ appliedCount: number; skippedCount: number }> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  const getAppliedStatement = database.prepare(
    `SELECT filename FROM server_migrations WHERE filename = ? LIMIT 1;`,
  )
  const insertAppliedStatement = database.prepare(
    `INSERT INTO server_migrations (filename) VALUES (?);`,
  )

  const migrationFileNames = await loadMigrationFileNames(migrationsDirectoryPath)
  let appliedCount = 0
  let skippedCount = 0

  for (const filename of migrationFileNames) {
    const existing = getAppliedStatement.get(filename) as { filename: string } | undefined
    if (existing) {
      skippedCount++
      continue
    }

    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (!sql) {
      skippedCount++
      continue
    }

    if (sql.startsWith(MANUAL_TRANSACTION_MARKER)) {
      database.exec(sql)
      appliedCount++
      continue
    }

    database.exec('BEGIN;')
    try {
      database.exec(sql)
      insertAppliedStatement.run(filename)
      database.exec('COMMIT;')
      appliedCount++
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // ignore rollback failure, surface original error
      }
      throw new Error(`Failed to apply migration "${filename}": ${String(error)}`)
    }
  }

  return { appliedCount, skippedCount }
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;`)
    .get(tableName) as { name: string } | undefined
  return row !== undefined
}

function indexExists(database: DatabaseSync, indexName: string): boolean {
  const row = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=? LIMIT 1;`)
    .get(indexName) as { name: string } | undefined
  return row !== undefined
}

function insertTestProfile(database: DatabaseSync, profileId: string, displayName: string): void {
  database
    .prepare(
      `INSERT INTO profiles (profile_id, display_name, normalized_display_name)
       VALUES (?, ?, ?);`,
    )
    .run(profileId, displayName, displayName.toLowerCase())
}

// ─── [1]-[5] Migration runner: прилагане, idempotency, таблици, индекси ───

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-persistence-'))
const dbPath = join(tempDir, 'test.sqlite')

try {
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })

  try {
    // [1] Прилагане на реалните migrations върху празна temp база.
    const firstRun = await applyMigrations(db, realMigrationsDirectoryPath)
    check('[1] Всички migrations се прилагат чисто върху празна temp база', firstRun.appliedCount > 0)

    // [2] Прилагане върху база, на която всички предишни migrations вече
    // са приложени (втори runner instance върху СЪЩИЯ файл — reopen).
    db.close()
    const dbReopened = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    const secondRun = await applyMigrations(dbReopened, realMigrationsDirectoryPath)
    check(
      '[2] Migrations се прилагат коректно върху база с вече приложени migrations (0 нови)',
      secondRun.appliedCount === 0 && secondRun.skippedCount === firstRun.appliedCount,
    )

    // [3] Повторно стартиране на runner-а не поврежда schema (таблиците пак съществуват).
    check(
      '[3] Повторното стартиране на migration runner не поврежда schema',
      tableExists(dbReopened, 'tournaments') && tableExists(dbReopened, 'tournament_matches'),
    )

    // [4] Всички очаквани таблици съществуват.
    const expectedTables = [
      'tournaments',
      'tournament_teams',
      'tournament_entries',
      'tournament_partner_invites',
      'tournament_rounds',
      'tournament_matches',
      'tournament_economy_ledger',
      'tournament_events',
    ]
    check(
      '[4] Всички 8 очаквани таблици съществуват',
      expectedTables.every((t) => tableExists(dbReopened, t)),
    )

    // [5] Очакваните индекси съществуват.
    const expectedIndexes = [
      'idx_tournaments_status',
      'idx_tournaments_creator',
      'idx_tournaments_scheduled_due',
      'idx_tournaments_public_active',
      'idx_tournament_teams_seed_slot_unique',
      'idx_tournament_entries_tournament_status',
      'idx_tournament_entries_profile',
      'idx_tpi_invitee_pending',
      'idx_tpi_expiry_due',
      'idx_tpi_one_pending_per_pair',
      'idx_tournament_matches_noshow_due',
      'idx_tournament_economy_ledger_tournament',
      'idx_tournament_events_tournament',
    ]
    check(
      '[5] Всички очаквани индекси съществуват',
      expectedIndexes.every((i) => indexExists(dbReopened, i)),
    )

    dbReopened.close()
  } catch (error) {
    console.error('  Migration setup failed:', error)
    failed++
    throw error
  }

  // ─── [6]-[25] Constraint / store CRUD проверки ─────────────────────────

  const db2 = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db2.exec('PRAGMA foreign_keys = ON;')

  const profileA = randomUUID()
  const profileB = randomUUID()
  const profileC = randomUUID()
  const profileD = randomUUID()
  insertTestProfile(db2, profileA, 'Test Player A')
  insertTestProfile(db2, profileB, 'Test Player B')
  insertTestProfile(db2, profileC, 'Test Player C')
  insertTestProfile(db2, profileD, 'Test Player D')

  const insertTournamentStatement = db2.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, start_mode, scheduled_start_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
  `)

  // [6] Валиден community/public/fill турнир.
  {
    const id = randomUUID()
    try {
      insertTournamentStatement.run(id, 'community', 'Турнир 1', profileA, 'public', null, 20000, 'fill', null)
      check('[6] Валиден community/public/fill турнир се записва', true)
    } catch (error) {
      check(`[6] Валиден community/public/fill турнир се записва (${String(error)})`, false)
    }
  }

  // [7] Валиден community/password/scheduled турнир.
  // Различен creator от [6] — idx_tournaments_one_active_per_creator (нов
  // partial UNIQUE index) позволява само 1 активен ('open'/...) турнир на
  // profile; profileA вече има активен турнир от теста по-горе.
  {
    const id = randomUUID()
    try {
      insertTournamentStatement.run(
        id,
        'community',
        'Турнир 2',
        profileB,
        'password',
        'fake-hash-123',
        20000,
        'scheduled',
        '2026-08-01T10:00:00.000Z',
      )
      check('[7] Валиден community/password/scheduled турнир се записва', true)
    } catch (error) {
      check(`[7] Валиден community/password/scheduled турнир се записва (${String(error)})`, false)
    }
  }

  // [8] Public турнир с password_hash → отхвърлен.
  checkThrows('[8] Public турнир с password_hash се отхвърля', () => {
    insertTournamentStatement.run(
      randomUUID(),
      'community',
      'Invalid 1',
      profileA,
      'public',
      'should-not-be-allowed',
      20000,
      'fill',
      null,
    )
  })

  // [9] Password турнир без password_hash → отхвърлен.
  checkThrows('[9] Password турнир без password_hash се отхвърля', () => {
    insertTournamentStatement.run(
      randomUUID(),
      'community',
      'Invalid 2',
      profileA,
      'password',
      null,
      20000,
      'fill',
      null,
    )
  })

  // [10] Scheduled турнир без scheduled_start_at → отхвърлен.
  checkThrows('[10] Scheduled турнир без scheduled_start_at се отхвърля', () => {
    insertTournamentStatement.run(
      randomUUID(),
      'community',
      'Invalid 3',
      profileA,
      'public',
      null,
      20000,
      'scheduled',
      null,
    )
  })

  // [11] Fill турнир със scheduled_start_at → отхвърлен.
  checkThrows('[11] Fill турнир със scheduled_start_at се отхвърля', () => {
    insertTournamentStatement.run(
      randomUUID(),
      'community',
      'Invalid 4',
      profileA,
      'public',
      null,
      20000,
      'fill',
      '2026-08-01T10:00:00.000Z',
    )
  })

  // [12] Невалидна enum стойност → отхвърлена.
  checkThrows('[12] Невалидна kind enum стойност се отхвърля', () => {
    insertTournamentStatement.run(
      randomUUID(),
      'not-a-real-kind',
      'Invalid 5',
      profileA,
      'public',
      null,
      20000,
      'fill',
      null,
    )
  })

  // ── tournamentStore CRUD за останалите проверки ──
  db2.close()
  const store: TournamentStore = await createTournamentStore(dbPath)

  // profileD (не profileA/profileB) — и двата вече имат активен турнир от
  // constraint тестовете по-горе (idx_tournaments_one_active_per_creator).
  const createResult = store.createTournament({
    name: 'Store Турнир',
    creatorProfileId: profileD,
    visibility: 'public',
    entryFee: 20000,
    startMode: 'fill',
  })
  if (!createResult.ok) throw new Error('Setup failure: createTournament() failed unexpectedly')
  const tournament = createResult.tournament

  // [13] Duplicate tournament entry за същия profile → отхвърлен.
  store.createEntry({ tournamentId: tournament.tournamentId, profileId: profileB, joinedAs: 'solo' })
  checkThrows('[13] Duplicate tournament entry за същия profile се отхвърля', () => {
    store.createEntry({ tournamentId: tournament.tournamentId, profileId: profileB, joinedAs: 'solo' })
  })

  // [14] Duplicate seed slot → отхвърлен.
  store.createTeam({ tournamentId: tournament.tournamentId, seedSlot: 1 })
  checkThrows('[14] Duplicate seed slot за същия турнир се отхвърля', () => {
    store.createTeam({ tournamentId: tournament.tournamentId, seedSlot: 1 })
  })

  // [15] Дублирана pending покана → отхвърлена.
  const teamForInvite = store.createTeam({ tournamentId: tournament.tournamentId })
  const firstInvite = store.createPartnerInvite({
    tournamentId: tournament.tournamentId,
    teamId: teamForInvite.teamId,
    inviterProfileId: profileA,
    inviteeProfileId: profileC,
    expiresAt: '2026-08-01T00:00:00.000Z',
  })
  checkThrows('[15] Дублирана pending покана (същия inviter/invitee/tournament) се отхвърля', () => {
    store.createPartnerInvite({
      tournamentId: tournament.tournamentId,
      teamId: teamForInvite.teamId,
      inviterProfileId: profileA,
      inviteeProfileId: profileC,
      expiresAt: '2026-08-01T00:00:00.000Z',
    })
  })

  // [16] inviter == invitee → отхвърлен.
  checkThrows('[16] inviter_profile_id == invitee_profile_id се отхвърля', () => {
    store.createPartnerInvite({
      tournamentId: tournament.tournamentId,
      teamId: teamForInvite.teamId,
      inviterProfileId: profileA,
      inviteeProfileId: profileA,
      expiresAt: '2026-08-01T00:00:00.000Z',
    })
  })

  // [17] popup_dismissed_at и notification_read_at се променят независимо.
  {
    const beforeDismiss = store.getPartnerInviteById(firstInvite.inviteId)
    check(
      '[17a] Преди действие: popup_dismissed_at и notification_read_at са NULL',
      beforeDismiss?.popupDismissedAt === null && beforeDismiss?.notificationReadAt === null,
    )

    const dismissedOk = store.dismissInvitePopup(firstInvite.inviteId)
    const afterDismiss = store.getPartnerInviteById(firstInvite.inviteId)
    check(
      '[17b] dismissInvitePopup() задава САМО popup_dismissed_at (X бутон)',
      dismissedOk &&
        afterDismiss?.popupDismissedAt !== null &&
        afterDismiss?.notificationReadAt === null &&
        afterDismiss?.status === 'pending',
    )

    const readOk = store.markInviteNotificationRead(firstInvite.inviteId)
    const afterRead = store.getPartnerInviteById(firstInvite.inviteId)
    check(
      '[17c] markInviteNotificationRead() допълнително задава notification_read_at, status остава pending',
      readOk &&
        afterRead?.notificationReadAt !== null &&
        afterRead?.popupDismissedAt !== null &&
        afterRead?.status === 'pending',
    )
  }

  // [18] Invalid JSON в JSON колона → отхвърлен (missing_profile_ids, json_valid CHECK).
  {
    const round = store.createRound({
      tournamentId: tournament.tournamentId,
      roundType: 'semifinal',
      roundIndex: 1,
    })
    const teamX = store.createTeam({ tournamentId: tournament.tournamentId })
    const teamY = store.createTeam({ tournamentId: tournament.tournamentId })
    const rawDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    rawDb.exec('PRAGMA foreign_keys = ON;')
    checkThrows('[18] Невалиден JSON в missing_profile_ids се отхвърля (json_valid CHECK)', () => {
      rawDb
        .prepare(
          `INSERT INTO tournament_matches (
             match_id, tournament_id, round_id, team_a_id, team_b_id, missing_profile_ids
           ) VALUES (?, ?, ?, ?, ?, ?);`,
        )
        .run(randomUUID(), tournament.tournamentId, round.roundId, teamX.teamId, teamY.teamId, 'not-json{{{')
    })
    rawDb.close()
  }

  // [19] system_fee позволява profile_id NULL.
  {
    const rawDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    rawDb.exec('PRAGMA foreign_keys = ON;')
    try {
      rawDb
        .prepare(
          `INSERT INTO tournament_economy_ledger (
             ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount
           ) VALUES (?, ?, ?, NULL, 'system_fee', ?);`,
        )
        .run(randomUUID(), `sysfee:${tournament.tournamentId}`, tournament.tournamentId, 16000)
      check('[19] system_fee позволява profile_id NULL', true)
    } catch (error) {
      check(`[19] system_fee позволява profile_id NULL (${String(error)})`, false)
    }

    // [20] Несистемен ledger entry с profile_id NULL → отхвърлен.
    checkThrows('[20] Несистемен (entry_fee_debit) ledger entry с profile_id NULL се отхвърля', () => {
      rawDb
        .prepare(
          `INSERT INTO tournament_economy_ledger (
             ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount
           ) VALUES (?, ?, ?, NULL, 'entry_fee_debit', ?);`,
        )
        .run(randomUUID(), randomUUID(), tournament.tournamentId, 20000)
    })

    // [21] Duplicate idempotency_key → отхвърлен.
    const sharedKey = `debit:${tournament.tournamentId}:${profileB}`
    rawDb
      .prepare(
        `INSERT INTO tournament_economy_ledger (
           ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount
         ) VALUES (?, ?, ?, ?, 'entry_fee_debit', ?);`,
      )
      .run(randomUUID(), sharedKey, tournament.tournamentId, profileB, 20000)
    checkThrows('[21] Duplicate idempotency_key се отхвърля', () => {
      rawDb
        .prepare(
          `INSERT INTO tournament_economy_ledger (
             ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount
           ) VALUES (?, ?, ?, ?, 'entry_fee_debit', ?);`,
        )
        .run(randomUUID(), sharedKey, tournament.tournamentId, profileC, 20000)
    })

    rawDb.close()
  }

  // [22] Store create/read/list методите връщат правилно mapper-нати стойности.
  {
    const fetched = store.getTournamentById(tournament.tournamentId)
    check(
      '[22a] getTournamentById връща правилно mapper-нати стойности',
      fetched !== null &&
        fetched.tournamentId === tournament.tournamentId &&
        fetched.name === 'Store Турнир' &&
        fetched.creatorProfileId === profileD &&
        fetched.visibility === 'public' &&
        fetched.entryFee === 20000 &&
        fetched.startMode === 'fill' &&
        fetched.status === 'open' &&
        typeof fetched.createdAt === 'string',
    )

    const listed = store.listTournaments({ statuses: ['open'] })
    check(
      '[22b] listTournaments({statuses}) връща записания турнир',
      listed.some((t) => t.tournamentId === tournament.tournamentId),
    )

    const entries = store.getEntriesForTournament(tournament.tournamentId)
    check(
      '[22c] getEntriesForTournament връща правилно mapper-натия entry',
      entries.length === 1 && entries[0].profileId === profileB && entries[0].status === 'confirmed',
    )

    const teams = store.getTeamsForTournament(tournament.tournamentId)
    check('[22d] getTeamsForTournament връща създадените отбори', teams.length >= 3)

    const event = store.appendTournamentEvent({
      tournamentId: tournament.tournamentId,
      eventType: 'created',
      actorProfileId: profileA,
      actorRole: 'player',
      payload: { note: 'test' },
    })
    check(
      '[22e] appendTournamentEvent записва и връща payload обекта коректно',
      event.payload !== null && (event.payload as { note: string }).note === 'test',
    )
  }

  // [23] Conditional status update успява само при очаквания стар статус.
  {
    const wrongExpected = store.updateTournamentStatus(tournament.tournamentId, 'finished', 'starting')
    check('[23a] updateTournamentStatus с грешен expectedStatus не прави промяна', wrongExpected === false)

    const correctExpected = store.updateTournamentStatus(tournament.tournamentId, 'open', 'starting')
    const afterUpdate = store.getTournamentById(tournament.tournamentId)
    check(
      '[23b] updateTournamentStatus с правилен expectedStatus променя статуса',
      correctExpected === true && afterUpdate?.status === 'starting',
    )
  }

  // [24] Foreign-key violations се отхвърлят.
  checkThrows('[24] FK violation (несъществуващ tournament_id за entry) се отхвърля', () => {
    store.createEntry({ tournamentId: randomUUID(), profileId: profileC, joinedAs: 'solo' })
  })

  store.close()

  // [25] Migration/store проверката не променя production database.
  const productionDbPath = join(serverRootPath, 'database', 'data', 'belot-v2.sqlite')
  check(
    '[25] Тестовата база е изолиран temp файл, различен от production database пътя',
    dbPath !== productionDbPath && dbPath.includes(tmpdir()),
  )
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
