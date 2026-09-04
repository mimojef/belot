import { randomUUID } from 'node:crypto'
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

function insertTournament(
  database: DatabaseSync,
  tournamentId: string,
  creatorProfileId: string,
  status: string,
  name = `Guard ${tournamentId}`,
  startMode: string = 'fill',
  scheduledStartAt: string | null = null,
): void {
  insertProfile(database, creatorProfileId)
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status,
      started_at, finished_at
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 5000, 8, ?, ?, ?, CURRENT_TIMESTAMP,
      CASE WHEN ? IN ('finished', 'cancelled', 'admin_cancelled', 'auto_cancelled', 'failed')
        THEN CURRENT_TIMESTAMP
        ELSE NULL
      END
    );
  `).run(tournamentId, name, creatorProfileId, startMode, scheduledStartAt, status, status)
}

function insertEntry(database: DatabaseSync, tournamentId: string, profileId: string, status: string): void {
  database.prepare(`
    INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
    VALUES (?, ?, ?, NULL, 'solo', ?);
  `).run(randomUUID(), tournamentId, profileId, status)
}

function countEntries(database: DatabaseSync, tournamentId: string, profileId: string): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count
    FROM tournament_entries
    WHERE tournament_id = ? AND profile_id = ?;
  `).get(tournamentId, profileId) as { count: number }).count
}

const tempDir = await mkdtemp(join(tmpdir(), 'belot-active-participation-guard-'))
const dbPath = join(tempDir, 'server.db')

const database = new DatabaseSync(dbPath)
await applyMigrations(database)

const uniqueIndex = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_tournament_entries_one_active_per_profile';
  `).get()
check('old profile-only active unique index is removed', uniqueIndex === undefined)

const economyStore = await createTournamentEconomyStore(dbPath)

const terminalCases: Array<{ label: string; tournamentStatus: string; entryStatus: string; profileId: string }> = [
    { label: 'finished finalist does not block', tournamentStatus: 'finished', entryStatus: 'finalist', profileId: 'finished-finalist' },
    { label: 'finished champion does not block', tournamentStatus: 'finished', entryStatus: 'champion', profileId: 'finished-champion' },
    { label: 'finished eliminated does not block', tournamentStatus: 'finished', entryStatus: 'eliminated', profileId: 'finished-eliminated' },
    { label: 'cancelled confirmed does not block', tournamentStatus: 'cancelled', entryStatus: 'confirmed', profileId: 'cancelled-confirmed' },
    { label: 'local oxs2aj bot-f-023 finalist does not block', tournamentStatus: 'finished', entryStatus: 'finalist', profileId: 'bot-f-023' },
]

for (const testCase of terminalCases) {
    insertProfile(database, testCase.profileId)
    const oldTournamentId = `old-${testCase.profileId}`
    const newTournamentId = `new-${testCase.profileId}`
    insertTournament(
      database,
      oldTournamentId,
      `creator-${oldTournamentId}`,
      testCase.tournamentStatus,
      testCase.profileId === 'bot-f-023' ? '[local-test:oxs2aj] 4t/one_human' : undefined,
    )
    insertEntry(database, oldTournamentId, testCase.profileId, testCase.entryStatus)
    insertTournament(database, newTournamentId, `creator-${newTournamentId}`, 'open')

    const result = economyStore.joinTournamentSoloAtomically(newTournamentId, testCase.profileId)
    check(
      testCase.label,
      result.ok === true && countEntries(database, newTournamentId, testCase.profileId) === 1,
      JSON.stringify(result),
    )
}

for (const status of ['open', 'starting', 'semifinal_in_progress', 'final_in_progress']) {
    const profileId = `active-${status}`
    insertProfile(database, profileId)
    insertTournament(database, `active-old-${status}`, `creator-active-old-${status}`, status)
    insertEntry(database, `active-old-${status}`, profileId, 'confirmed')
    insertTournament(database, `active-new-${status}`, `creator-active-new-${status}`, 'open')

    const result = economyStore.joinTournamentSoloAtomically(`active-new-${status}`, profileId)
    check(
      `confirmed entry in ${status} tournament blocks`,
      result.ok === false && result.reason === 'already_participating_elsewhere',
      JSON.stringify(result),
    )
}

const finalistProfileId = 'active-finalist-profile'
insertProfile(database, finalistProfileId)
insertTournament(database, 'active-finalist-old', 'creator-active-finalist-old', 'final_in_progress')
insertEntry(database, 'active-finalist-old', finalistProfileId, 'finalist')
insertTournament(database, 'active-finalist-new', 'creator-active-finalist-new', 'open')
const finalistResult = economyStore.joinTournamentSoloAtomically('active-finalist-new', finalistProfileId)
check(
  'finalist entry in active tournament blocks',
  finalistResult.ok === false && finalistResult.reason === 'already_participating_elsewhere',
  JSON.stringify(finalistResult),
)

const sharedAccountId = 'shared-account'
insertProfile(database, 'shared-profile-a', sharedAccountId)
database.prepare(`
    INSERT INTO profiles (
      profile_id, account_id, display_name, normalized_display_name, profile_kind, status
    ) VALUES ('shared-profile-b', ?, 'shared-profile-b', 'shared-profile-b', 'human', 'active');
`).run(sharedAccountId)
database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES ('shared-profile-b', 1000000);
`).run()
insertTournament(database, 'shared-active-old', 'creator-shared-active-old', 'semifinal_in_progress')
insertEntry(database, 'shared-active-old', 'shared-profile-a', 'confirmed')
insertTournament(database, 'shared-active-new', 'creator-shared-active-new', 'open')
const sharedResult = economyStore.joinTournamentSoloAtomically('shared-active-new', 'shared-profile-b')
check(
  'account-level guard blocks another profile on same account in active tournament',
  sharedResult.ok === false && sharedResult.reason === 'already_participating_elsewhere',
  JSON.stringify(sharedResult),
)

// ─── Multi-tournament registration: Case A (60-min-from-now) + Case B ──────
// (pairwise <60-min между два SCHEDULED турнира) ─────────────────────────
// Профилът вече МОЖЕ да има регистрации в няколко бъдещи SCHEDULED турнира
// едновременно — блокира само (A) активна scheduled регистрация под 60 мин
// ОТ СЕГА, или (B) активна scheduled регистрация под 60 мин ABS разлика от
// ТОЗИ конкретен join опит, независимо от "сега" (виж resolveActiveEntryBlock
// в tournamentEconomyStore.ts). Started-tournament/start-when-full
// блокирането остава непроменено — вече покрито от loop-овете по-горе.
// Anchor-ът е relative спрямо реалния Date.now() (НЕ фиксирана календарна
// дата) — computePartnerInviteExpiresAt (pre-existing, tournamentEconomyStore.ts)
// няма injectable `now` за partner-invite window checks и винаги ползва
// реалния wall clock, затова един hardcoded минал anchor би провалил M/N
// тестовете с 'invite_window_closed'. Всички абсолютни времена по-долу са
// ФИКСИРАНИ offsets от този anchor, затова резултатите остават 100%
// детерминирани (не зависят КОГА се пуска тестът, само от relative delta-та).
const windowNow = new Date(Date.now() + 24 * 60 * 60 * 1000)

function isoAfterMinutes(minutes: number): string {
  return new Date(windowNow.getTime() + minutes * 60 * 1000).toISOString()
}

// A) existing +3h, new +5h (diff 2h) -> ALLOW
{
  const profileId = 'case-a-far'
  insertProfile(database, profileId)
  insertTournament(database, 'case-a-far-old', 'creator-case-a-far-old', 'open', undefined, 'scheduled', isoAfterMinutes(180))
  insertEntry(database, 'case-a-far-old', profileId, 'confirmed')
  insertTournament(database, 'case-a-far-new', 'creator-case-a-far-new', 'open', undefined, 'scheduled', isoAfterMinutes(300))
  const result = economyStore.joinTournamentSoloAtomically('case-a-far-new', profileId, { now: windowNow })
  check('A) existing +3h, new +5h (2h apart) -> ALLOW', result.ok === true, JSON.stringify(result))
}

// B) existing +65min, new +4h -> ALLOW
{
  const profileId = 'case-b-65'
  insertProfile(database, profileId)
  insertTournament(database, 'case-b-65-old', 'creator-case-b-65-old', 'open', undefined, 'scheduled', isoAfterMinutes(65))
  insertEntry(database, 'case-b-65-old', profileId, 'confirmed')
  insertTournament(database, 'case-b-65-new', 'creator-case-b-65-new', 'open', undefined, 'scheduled', isoAfterMinutes(240))
  const result = economyStore.joinTournamentSoloAtomically('case-b-65-new', profileId, { now: windowNow })
  check('B) existing +65min, new +4h -> ALLOW', result.ok === true, JSON.stringify(result))
}

// C) existing +59min, new +4h -> BLOCK Case A, reason=registered_tournament_starts_soon
{
  const profileId = 'case-c-59'
  insertProfile(database, profileId)
  const blockingScheduledStartAt = isoAfterMinutes(59)
  insertTournament(database, 'case-c-59-old', 'creator-case-c-59-old', 'open', undefined, 'scheduled', blockingScheduledStartAt)
  insertEntry(database, 'case-c-59-old', profileId, 'confirmed')
  insertTournament(database, 'case-c-59-new', 'creator-case-c-59-new', 'open', undefined, 'scheduled', isoAfterMinutes(240))
  const result = economyStore.joinTournamentSoloAtomically('case-c-59-new', profileId, { now: windowNow })
  check(
    'C) existing +59min, new +4h -> BLOCK Case A (registered_tournament_starts_soon)',
    result.ok === false
      && result.reason === 'registered_tournament_starts_soon'
      && result.blockingTournamentId === 'case-c-59-old'
      && result.scheduledStartAt === blockingScheduledStartAt,
    JSON.stringify(result),
  )
}

// D) existing exactly +60min, new +4h -> ALLOW by Case A (strictly "under" the window)
{
  const profileId = 'case-d-exact-60'
  insertProfile(database, profileId)
  insertTournament(database, 'case-d-exact-60-old', 'creator-case-d-exact-60-old', 'open', undefined, 'scheduled', isoAfterMinutes(60))
  insertEntry(database, 'case-d-exact-60-old', profileId, 'confirmed')
  insertTournament(database, 'case-d-exact-60-new', 'creator-case-d-exact-60-new', 'open', undefined, 'scheduled', isoAfterMinutes(240))
  const result = economyStore.joinTournamentSoloAtomically('case-d-exact-60-new', profileId, { now: windowNow })
  check('D) existing exactly +60min, new +4h -> ALLOW by Case A', result.ok === true, JSON.stringify(result))
}

// E) existing 20:00, new 20:45 (45min apart, "now"=12:00 far from both) -> BLOCK Case B
{
  const profileId = 'case-e-2045'
  insertProfile(database, profileId)
  const blockingScheduledStartAt = isoAfterMinutes(480)
  const requestedScheduledStartAt = isoAfterMinutes(525)
  insertTournament(database, 'case-e-old', 'creator-case-e-old', 'open', undefined, 'scheduled', blockingScheduledStartAt)
  insertEntry(database, 'case-e-old', profileId, 'confirmed')
  insertTournament(database, 'case-e-new', 'creator-case-e-new', 'open', undefined, 'scheduled', requestedScheduledStartAt)
  const result = economyStore.joinTournamentSoloAtomically('case-e-new', profileId, { now: windowNow })
  check(
    'E) existing 20:00, new 20:45 -> BLOCK Case B (scheduled_tournament_time_conflict)',
    result.ok === false
      && result.reason === 'scheduled_tournament_time_conflict'
      && result.blockingTournamentId === 'case-e-old'
      && result.blockingScheduledStartAt === blockingScheduledStartAt
      && result.requestedTournamentScheduledStartAt === requestedScheduledStartAt,
    JSON.stringify(result),
  )
}

// F) existing 20:00, new 19:30 (30min apart, symmetric — new earlier than existing) -> BLOCK Case B
{
  const profileId = 'case-f-1930'
  insertProfile(database, profileId)
  insertTournament(database, 'case-f-old', 'creator-case-f-old', 'open', undefined, 'scheduled', isoAfterMinutes(480))
  insertEntry(database, 'case-f-old', profileId, 'confirmed')
  insertTournament(database, 'case-f-new', 'creator-case-f-new', 'open', undefined, 'scheduled', isoAfterMinutes(450))
  const result = economyStore.joinTournamentSoloAtomically('case-f-new', profileId, { now: windowNow })
  check(
    'F) existing 20:00, new 19:30 -> BLOCK Case B',
    result.ok === false && result.reason === 'scheduled_tournament_time_conflict',
    JSON.stringify(result),
  )
}

// G) existing 20:00, new 21:00 (exactly 60min apart) -> ALLOW
{
  const profileId = 'case-g-2100'
  insertProfile(database, profileId)
  insertTournament(database, 'case-g-old', 'creator-case-g-old', 'open', undefined, 'scheduled', isoAfterMinutes(480))
  insertEntry(database, 'case-g-old', profileId, 'confirmed')
  insertTournament(database, 'case-g-new', 'creator-case-g-new', 'open', undefined, 'scheduled', isoAfterMinutes(540))
  const result = economyStore.joinTournamentSoloAtomically('case-g-new', profileId, { now: windowNow })
  check('G) existing 20:00, new 21:00 (exactly 60min) -> ALLOW', result.ok === true, JSON.stringify(result))
}

// H) existing 20:00, new 19:00 (exactly 60min apart, symmetric) -> ALLOW
{
  const profileId = 'case-h-1900'
  insertProfile(database, profileId)
  insertTournament(database, 'case-h-old', 'creator-case-h-old', 'open', undefined, 'scheduled', isoAfterMinutes(480))
  insertEntry(database, 'case-h-old', profileId, 'confirmed')
  insertTournament(database, 'case-h-new', 'creator-case-h-new', 'open', undefined, 'scheduled', isoAfterMinutes(420))
  const result = economyStore.joinTournamentSoloAtomically('case-h-new', profileId, { now: windowNow })
  check('H) existing 20:00, new 19:00 (exactly 60min) -> ALLOW', result.ok === true, JSON.stringify(result))
}

// I) existing 18:00/21:00/23:00, new=21:40 -> blocking tournament е 21:00 (min abs delta)
{
  const profileId = 'case-i-multi'
  insertProfile(database, profileId)
  insertTournament(database, 'case-i-1800', 'creator-case-i-1800', 'open', undefined, 'scheduled', isoAfterMinutes(360))
  insertEntry(database, 'case-i-1800', profileId, 'confirmed')
  insertTournament(database, 'case-i-2100', 'creator-case-i-2100', 'open', undefined, 'scheduled', isoAfterMinutes(540))
  insertEntry(database, 'case-i-2100', profileId, 'confirmed')
  insertTournament(database, 'case-i-2300', 'creator-case-i-2300', 'open', undefined, 'scheduled', isoAfterMinutes(660))
  insertEntry(database, 'case-i-2300', profileId, 'confirmed')
  insertTournament(database, 'case-i-new', 'creator-case-i-new', 'open', undefined, 'scheduled', isoAfterMinutes(580))
  const result = economyStore.joinTournamentSoloAtomically('case-i-new', profileId, { now: windowNow })
  check(
    'I) existing 18:00/21:00/23:00, new=21:40 -> blocking is 21:00 (min abs delta)',
    result.ok === false
      && result.reason === 'scheduled_tournament_time_conflict'
      && result.blockingTournamentId === 'case-i-2100',
    JSON.stringify(result),
  )
}

// Case A "nearest to now" with multiple active registrations (§5 "При case A:
// избери най-близкия upcoming tournament") — far (4h) does NOT block, near
// (45min) DOES, and the reported blockingTournamentId is the near one.
{
  const profileId = 'case-a-nearest-to-now'
  insertProfile(database, profileId)
  insertTournament(database, 'case-a-nearest-far', 'creator-case-a-nearest-far', 'open', undefined, 'scheduled', isoAfterMinutes(240))
  insertEntry(database, 'case-a-nearest-far', profileId, 'confirmed')
  insertTournament(database, 'case-a-nearest-near', 'creator-case-a-nearest-near', 'open', undefined, 'scheduled', isoAfterMinutes(45))
  insertEntry(database, 'case-a-nearest-near', profileId, 'confirmed')
  insertTournament(database, 'case-a-nearest-new', 'creator-case-a-nearest-new', 'open')
  const result = economyStore.joinTournamentSoloAtomically('case-a-nearest-new', profileId, { now: windowNow })
  check(
    'Case A nearest-to-now: 45min entry blocks, not the 4h one',
    result.ok === false
      && result.reason === 'registered_tournament_starts_soon'
      && result.blockingTournamentId === 'case-a-nearest-near',
    JSON.stringify(result),
  )
}

// J) cancelled/finished/withdrawn conflicting registration -> НЕ блокира (нито Case A, нито Case B)
{
  const profileId = 'case-j-cancelled'
  insertProfile(database, profileId)
  insertTournament(database, 'case-j-cancelled-old', 'creator-case-j-cancelled-old', 'cancelled', undefined, 'scheduled', isoAfterMinutes(480))
  insertEntry(database, 'case-j-cancelled-old', profileId, 'confirmed')
  insertTournament(database, 'case-j-cancelled-new', 'creator-case-j-cancelled-new', 'open', undefined, 'scheduled', isoAfterMinutes(525))
  const result = economyStore.joinTournamentSoloAtomically('case-j-cancelled-new', profileId, { now: windowNow })
  check('J) cancelled conflicting tournament does not block (Case B)', result.ok === true, JSON.stringify(result))
}
{
  const profileId = 'case-j-finished'
  insertProfile(database, profileId)
  insertTournament(database, 'case-j-finished-old', 'creator-case-j-finished-old', 'finished', undefined, 'scheduled', isoAfterMinutes(30))
  insertEntry(database, 'case-j-finished-old', profileId, 'finalist')
  insertTournament(database, 'case-j-finished-new', 'creator-case-j-finished-new', 'open', undefined, 'scheduled', isoAfterMinutes(240))
  const result = economyStore.joinTournamentSoloAtomically('case-j-finished-new', profileId, { now: windowNow })
  check('J) finished conflicting tournament does not block (Case A)', result.ok === true, JSON.stringify(result))
}
{
  const profileId = 'case-j-withdrawn'
  insertProfile(database, profileId)
  insertTournament(database, 'case-j-withdrawn-old', 'creator-case-j-withdrawn-old', 'open', undefined, 'scheduled', isoAfterMinutes(480))
  insertEntry(database, 'case-j-withdrawn-old', profileId, 'withdrawn')
  insertTournament(database, 'case-j-withdrawn-new', 'creator-case-j-withdrawn-new', 'open', undefined, 'scheduled', isoAfterMinutes(510))
  const result = economyStore.joinTournamentSoloAtomically('case-j-withdrawn-new', profileId, { now: windowNow })
  check('J) withdrawn (left) entry does not block (Case B)', result.ok === true, JSON.stringify(result))
}

// K) active start-when-full ('fill') registration -> старото unconditional BLOCK
// остава, дори когато НОВИЯТ турнир е scheduled и далеч във времето (не само
// когато новият е също fill, вече покрито от loop-а по-горе).
{
  const profileId = 'case-k-fill'
  insertProfile(database, profileId)
  insertTournament(database, 'case-k-fill-old', 'creator-case-k-fill-old', 'open') // default start_mode='fill'
  insertEntry(database, 'case-k-fill-old', profileId, 'confirmed')
  insertTournament(database, 'case-k-fill-new', 'creator-case-k-fill-new', 'open', undefined, 'scheduled', isoAfterMinutes(180))
  const result = economyStore.joinTournamentSoloAtomically('case-k-fill-new', profileId, { now: windowNow })
  check(
    'K) active fill registration blocks unconditionally, even vs a far scheduled new tournament',
    result.ok === false && result.reason === 'already_participating_elsewhere',
    JSON.stringify(result),
  )
}

// L) already in a STARTED tournament -> старото unconditional BLOCK остава,
// дори когато новият турнир е scheduled и далеч във времето.
{
  const profileId = 'case-l-started'
  insertProfile(database, profileId)
  insertTournament(database, 'case-l-started-old', 'creator-case-l-started-old', 'starting')
  insertEntry(database, 'case-l-started-old', profileId, 'confirmed')
  insertTournament(database, 'case-l-started-new', 'creator-case-l-started-new', 'open', undefined, 'scheduled', isoAfterMinutes(180))
  const result = economyStore.joinTournamentSoloAtomically('case-l-started-new', profileId, { now: windowNow })
  check(
    'L) already in a started tournament blocks unconditionally, even vs a far scheduled new tournament',
    result.ok === false && result.reason === 'already_participating_elsewhere',
    JSON.stringify(result),
  )
}

// M) partner invite create — solo+partner flow consistency (§7/§"SOLO + PARTNER FLOW CONSISTENCY")
{
  // M-A: inviter's OWN Case A conflict -> structured rejection on create.
  const inviterProfileId = 'case-m-a-inviter'
  const inviteeProfileId = 'case-m-a-invitee'
  insertProfile(database, inviterProfileId)
  insertProfile(database, inviteeProfileId)
  const blockingScheduledStartAt = isoAfterMinutes(59)
  insertTournament(database, 'case-m-a-old', 'creator-case-m-a-old', 'open', undefined, 'scheduled', blockingScheduledStartAt)
  insertEntry(database, 'case-m-a-old', inviterProfileId, 'confirmed')
  insertTournament(database, 'case-m-a-target', 'creator-case-m-a-target', 'open')
  const result = economyStore.createPartnerInviteAtomically(
    'case-m-a-target', inviterProfileId, inviteeProfileId, { now: windowNow },
  )
  check(
    'M-A) inviter own Case A conflict -> registered_tournament_starts_soon on create-invite',
    result.ok === false
      && result.reason === 'registered_tournament_starts_soon'
      && result.blockingTournamentId === 'case-m-a-old',
    JSON.stringify(result),
  )
}
{
  // M-B: invitee eligibility Case B conflict -> structured rejection on create.
  const inviterProfileId = 'case-m-b-inviter'
  const inviteeProfileId = 'case-m-b-invitee'
  insertProfile(database, inviterProfileId)
  insertProfile(database, inviteeProfileId)
  const blockingScheduledStartAt = isoAfterMinutes(480)
  const requestedScheduledStartAt = isoAfterMinutes(525)
  insertTournament(database, 'case-m-b-old', 'creator-case-m-b-old', 'open', undefined, 'scheduled', blockingScheduledStartAt)
  insertEntry(database, 'case-m-b-old', inviteeProfileId, 'confirmed')
  insertTournament(database, 'case-m-b-target', 'creator-case-m-b-target', 'open', undefined, 'scheduled', requestedScheduledStartAt)
  const result = economyStore.createPartnerInviteAtomically(
    'case-m-b-target', inviterProfileId, inviteeProfileId, { now: windowNow },
  )
  check(
    'M-B) invitee eligibility Case B conflict -> scheduled_tournament_time_conflict on create-invite',
    result.ok === false
      && result.reason === 'scheduled_tournament_time_conflict'
      && result.blockingTournamentId === 'case-m-b-old'
      && result.blockingScheduledStartAt === blockingScheduledStartAt
      && result.requestedTournamentScheduledStartAt === requestedScheduledStartAt,
    JSON.stringify(result),
  )
}

// N) accept partner invite — invitee eligibility re-checked at accept time
{
  // N-A: invitee acquires a Case A conflict AFTER the invite was created,
  // BEFORE accepting -> accept must re-check and reject (не bypass чрез
  // stale eligibility от create-time).
  const inviterProfileId = 'case-n-a-inviter'
  const inviteeProfileId = 'case-n-a-invitee'
  insertProfile(database, inviterProfileId)
  insertProfile(database, inviteeProfileId)
  insertTournament(database, 'case-n-a-target', 'creator-case-n-a-target', 'open', undefined, 'scheduled', isoAfterMinutes(240))
  const createResult = economyStore.createPartnerInviteAtomically(
    'case-n-a-target', inviterProfileId, inviteeProfileId, { now: windowNow },
  )
  assert(createResult.ok === true, `N-A setup: create-invite failed: ${JSON.stringify(createResult)}`)
  const blockingScheduledStartAt = isoAfterMinutes(59)
  insertTournament(database, 'case-n-a-old', 'creator-case-n-a-old', 'open', undefined, 'scheduled', blockingScheduledStartAt)
  insertEntry(database, 'case-n-a-old', inviteeProfileId, 'confirmed')
  const inviteId = createResult.ok === true ? createResult.invite.inviteId : ''
  const acceptResult = economyStore.acceptPartnerInviteAtomically('case-n-a-target', inviteId, inviteeProfileId, windowNow)
  check(
    'N-A) invitee Case A conflict at accept-time -> registered_tournament_starts_soon',
    acceptResult.ok === false
      && acceptResult.reason === 'registered_tournament_starts_soon'
      && acceptResult.blockingTournamentId === 'case-n-a-old',
    JSON.stringify(acceptResult),
  )
}
{
  // N-B: invitee acquires a Case B conflict (pairwise vs the invited
  // tournament's own time) before accepting.
  const inviterProfileId = 'case-n-b-inviter'
  const inviteeProfileId = 'case-n-b-invitee'
  insertProfile(database, inviterProfileId)
  insertProfile(database, inviteeProfileId)
  const requestedScheduledStartAt = isoAfterMinutes(525)
  insertTournament(database, 'case-n-b-target', 'creator-case-n-b-target', 'open', undefined, 'scheduled', requestedScheduledStartAt)
  const createResult = economyStore.createPartnerInviteAtomically(
    'case-n-b-target', inviterProfileId, inviteeProfileId, { now: windowNow },
  )
  assert(createResult.ok === true, `N-B setup: create-invite failed: ${JSON.stringify(createResult)}`)
  const blockingScheduledStartAt = isoAfterMinutes(480)
  insertTournament(database, 'case-n-b-old', 'creator-case-n-b-old', 'open', undefined, 'scheduled', blockingScheduledStartAt)
  insertEntry(database, 'case-n-b-old', inviteeProfileId, 'confirmed')
  const inviteId = createResult.ok === true ? createResult.invite.inviteId : ''
  const acceptResult = economyStore.acceptPartnerInviteAtomically('case-n-b-target', inviteId, inviteeProfileId, windowNow)
  check(
    'N-B) invitee Case B conflict at accept-time -> scheduled_tournament_time_conflict',
    acceptResult.ok === false
      && acceptResult.reason === 'scheduled_tournament_time_conflict'
      && acceptResult.blockingTournamentId === 'case-n-b-old'
      && acceptResult.blockingScheduledStartAt === blockingScheduledStartAt
      && acceptResult.requestedTournamentScheduledStartAt === requestedScheduledStartAt,
    JSON.stringify(acceptResult),
  )
}

assert(failed === 0, `${failed} checks failed`)

console.log(`checkTournamentActiveParticipationGuard passed=${passed} failed=${failed}`)
