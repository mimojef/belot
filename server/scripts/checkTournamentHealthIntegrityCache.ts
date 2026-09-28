/**
 * checkTournamentHealthIntegrityCache.ts
 *
 * Regression coverage за /health CPU fix-а в tournamentAdmin.ts:
 *   - getHealthSnapshot() кешира САМО integrityErrorCount/recoverableWarningCount
 *     (sample query + до 100x analyzeTournamentIntegrity) за 30 сек;
 *   - activeTournamentCount/pendingSettlementCount и coordinator/scheduler
 *     полетата остават live при всяко извикване;
 *   - direct analyzeTournamentIntegrity() callers не са кеширани.
 *
 * Детерминиран clock: createTournamentAdminStore deps.now — без реално чакане.
 * "Recompute" се доказва наблюдаемо: между извикванията се добавя турнир с
 * integrity error; кешираният резултат не го вижда, recompute-натият — да.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createTournamentAdminStore } from '../src/tournament/tournamentAdmin.js'

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
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const serverRootPath = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  for (const file of files) {
    database.exec(await readFile(join(migrationsDirectoryPath, file), 'utf8'))
  }
}

function insertProfile(database: DatabaseSync, profileId: string, displayName: string): void {
  database.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`)
    .run(profileId, displayName, displayName.toLowerCase())
}

/** Започнал турнир без financial snapshot/отбори -> analyzeTournamentIntegrity дава state=error. */
function insertBrokenStartedTournament(database: DatabaseSync, creatorProfileId: string, status: string): string {
  const tournamentId = randomUUID()
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status, started_at, settlement_state
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 10000, 8, 'fill', NULL, ?, '2026-07-30T10:00:00.000Z', 'pending');
  `).run(tournamentId, `Health ${tournamentId.slice(0, 8)}`, creatorProfileId, status)
  return tournamentId
}

function insertOpenTournament(database: DatabaseSync, creatorProfileId: string): string {
  const tournamentId = randomUUID()
  database.prepare(`
    INSERT INTO tournaments (
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, fill_expires_at, status
    ) VALUES (?, 'community', ?, ?, 'public', NULL, 10000, 8, 'fill', NULL, datetime('now', '+1 hours'), 'open');
  `).run(tournamentId, `Open ${tournamentId.slice(0, 8)}`, creatorProfileId)
  return tournamentId
}

console.log('\ncheckTournamentHealthIntegrityCache')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-tournament-health-cache-'))
const dbPath = join(tempDir, 'test.sqlite')
let db: DatabaseSync | null = null
let adminStore: Awaited<ReturnType<typeof createTournamentAdminStore>> | null = null

try {
  db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  const database = db

  const creatorIds = Array.from({ length: 8 }, () => randomUUID())
  creatorIds.forEach((id, index) => insertProfile(database, id, `Health Creator ${index + 1}`))

  let clockMs = 1_000_000
  let coordinatorHealth: { state: string; lastSuccessAt: string | null; lastError: string | null } = {
    state: 'idle',
    lastSuccessAt: '2026-09-28T10:00:00.000Z',
    lastError: null,
  }

  adminStore = await createTournamentAdminStore({
    databaseFilePath: dbPath,
    getPublicProfile: () => null,
    getCoordinatorHealth: () => coordinatorHealth,
    runCoordinatorTick: () => {},
    now: () => clockMs,
  })
  const store = adminStore

  function expectedAggregatesFresh(): { integrityErrorCount: number; recoverableWarningCount: number } {
    // Референтна (pre-change) формула, изчислена директно — за equivalence проверка.
    const ids = (database.prepare(`
      SELECT tournament_id FROM tournaments
      WHERE status IN ('starting', 'semifinal_in_progress', 'final_in_progress', 'finished')
      ORDER BY updated_at DESC
      LIMIT 100;
    `).all() as Array<{ tournament_id: string }>).map((row) => row.tournament_id)
    const reports = ids.map((id) => store.analyzeTournamentIntegrity(id))
    return {
      integrityErrorCount: reports.filter((report) => report.state === 'error').length,
      recoverableWarningCount: reports.flatMap((report) => report.issues).filter((issue) => issue.recoverable).length,
    }
  }

  const firstBrokenId = insertBrokenStartedTournament(database, creatorIds[0]!, 'semifinal_in_progress')
  insertBrokenStartedTournament(database, creatorIds[1]!, 'final_in_progress')

  const first = store.getHealthSnapshot()

  await check('[4] integrity aggregates на първото извикване == референтната формула', () => {
    const expected = expectedAggregatesFresh()
    assert(first.integrityErrorCount === expected.integrityErrorCount, `errors ${first.integrityErrorCount} != ${expected.integrityErrorCount}`)
    assert(first.recoverableWarningCount === expected.recoverableWarningCount, `warnings ${first.recoverableWarningCount} != ${expected.recoverableWarningCount}`)
    assert(first.integrityErrorCount === 2, `очаквах 2 error турнира, got ${first.integrityErrorCount}`)
  })

  // Мутация в рамките на TTL: нов error турнир + нов open турнир + promotion до pending settlement.
  const cachedWindowBrokenId = insertBrokenStartedTournament(database, creatorIds[2]!, 'semifinal_in_progress')
  insertOpenTournament(database, creatorIds[3]!)
  database.prepare(`UPDATE tournaments SET status = 'final_in_progress' WHERE tournament_id = ?`).run(firstBrokenId)
  coordinatorHealth = { state: 'running', lastSuccessAt: '2026-09-28T10:00:05.000Z', lastError: 'boom' }
  clockMs += 29_999

  const second = store.getHealthSnapshot()

  await check('[1] второ извикване < 30s: integrity analysis НЕ се преизчислява (cached aggregates)', () => {
    assert(second.integrityErrorCount === first.integrityErrorCount, `errors се промениха в TTL: ${first.integrityErrorCount} -> ${second.integrityErrorCount}`)
    assert(second.recoverableWarningCount === first.recoverableWarningCount, 'warnings се промениха в TTL')
    assert(expectedAggregatesFresh().integrityErrorCount === 3, 'setup: fresh анализът трябваше да вижда 3 error турнира')
  })

  await check('[3] cheap counters + coordinator полета остават live по време на cached integrity', () => {
    assert(second.activeTournamentCount === first.activeTournamentCount + 2, `activeTournamentCount не е live: ${first.activeTournamentCount} -> ${second.activeTournamentCount}`)
    assert(second.pendingSettlementCount === first.pendingSettlementCount + 1, `pendingSettlementCount не е live: ${first.pendingSettlementCount} -> ${second.pendingSettlementCount}`)
    assert(second.lastSuccessfulReconciliation === '2026-09-28T10:00:05.000Z', 'lastSuccessfulReconciliation не е live')
    assert(second.lastFailedReconciliationCode === 'coordinator_error', 'lastFailedReconciliationCode не е live')
  })

  await check('[5] direct analyzeTournamentIntegrity() не е кеширан (вижда турнира, добавен в TTL прозореца)', () => {
    const report = store.analyzeTournamentIntegrity(cachedWindowBrokenId)
    assert(report.state === 'error', `state=${report.state}`)
  })

  clockMs += 1 // точно 30_000ms след изчислението -> изтекъл
  const third = store.getHealthSnapshot()

  await check('[2] след TTL (30s): recompute, резултатът == референтната формула', () => {
    const expected = expectedAggregatesFresh()
    assert(third.integrityErrorCount === 3, `очаквах 3 след recompute, got ${third.integrityErrorCount}`)
    assert(third.integrityErrorCount === expected.integrityErrorCount, 'errors != fresh формула')
    assert(third.recoverableWarningCount === expected.recoverableWarningCount, 'warnings != fresh формула')
  })

  insertBrokenStartedTournament(database, creatorIds[4]!, 'starting')
  clockMs += 10_000
  await check('[2b] новият кеш прозорец започва от recompute-а (t+10s -> все още cached)', () => {
    assert(store.getHealthSnapshot().integrityErrorCount === 3, 'кешът не беше презареден от recompute момента')
    clockMs += 20_000
    assert(store.getHealthSnapshot().integrityErrorCount === 4, 'recompute след втория TTL не се случи')
  })
} finally {
  adminStore?.close()
  db?.close()
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
}

if (failed > 0) {
  console.error(`checkTournamentHealthIntegrityCache failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`checkTournamentHealthIntegrityCache passed: ${passed} checks.`)
