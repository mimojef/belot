// Проверява §10/§14-I от final fix pass брифа: onTickTiming callback никога
// не трябва да може да счупи production tick логиката (runTick behavior /
// process path не се променя), дори когато самият callback хвърли.
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'
import { createTournamentCoordinator } from '../src/tournament/tournamentCoordinator.js'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
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

console.log('\ncheckOnTickTimingSafety')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-on-tick-timing-safety-'))
const dbPath = join(tempDir, 'test.sqlite')

try {
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  await applyMigrations(db)
  db.close()

  console.log('\n[1] tournamentScheduler — throwing onTickTiming does not crash tickNow() or corrupt scheduler state')
  {
    const economyStore = await createTournamentEconomyStore(dbPath)
    let onTickTimingCalled = false
    const scheduler = await createTournamentScheduler({
      databaseFilePath: dbPath,
      economyStore,
      now: () => new Date('2026-07-30T10:00:00.000Z'),
      setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
      clearInterval: () => {},
      onTickTiming: () => {
        onTickTimingCalled = true
        throw new Error('injected onTickTiming failure — must never escape runTick()')
      },
    })

    let threw = false
    try {
      scheduler.tickNow()
    } catch {
      threw = true
    }
    assert(onTickTimingCalled, 'onTickTiming was actually invoked (the test is exercising the real path)')
    assert(!threw, 'tickNow() did NOT throw even though the injected onTickTiming callback threw — monitoring hook is fully isolated')

    // Verify the scheduler is still usable afterwards — a second tick must
    // succeed normally, proving the throwing callback did not corrupt any
    // internal state (e.g. a stuck inFlight flag).
    let secondTickThrew = false
    try {
      scheduler.tickNow()
    } catch {
      secondTickThrew = true
    }
    assert(!secondTickThrew, 'a SECOND tick after the throwing callback still runs cleanly — no stuck inFlight guard, no corrupted state')
    scheduler.close()
  }

  console.log('\n[2] tournamentCoordinator — throwing onTickTiming does not crash tickNow() or corrupt coordinator state')
  {
    let onTickTimingCalled = false
    const coordinator = await createTournamentCoordinator({
      databaseFilePath: dbPath,
      getPublicProfile: () => null,
      getRoom: () => null,
      commitRoom: () => {},
      closeCompletedRoom: () => {},
      ensureRoomRuntime: () => ({ ok: true }),
      settleTournamentPrizes: () => ({ ok: true }),
      notifyAssignment: () => {},
      notifyFeederMatchCompleted: () => {},
      notifyFeederScoreProgress: () => {},
      isConnectionAttached: () => false,
      isProfileOnline: () => false,
      setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
      clearInterval: () => {},
      onTickTiming: () => {
        onTickTimingCalled = true
        throw new Error('injected onTickTiming failure — must never escape runTick()')
      },
    })

    let threw = false
    try {
      coordinator.tickNow()
    } catch {
      threw = true
    }
    assert(onTickTimingCalled, 'onTickTiming was actually invoked (the test is exercising the real path)')
    assert(!threw, 'tickNow() did NOT throw even though the injected onTickTiming callback threw — monitoring hook is fully isolated')

    let secondTickThrew = false
    try {
      coordinator.tickNow()
    } catch {
      secondTickThrew = true
    }
    assert(!secondTickThrew, 'a SECOND tick after the throwing callback still runs cleanly — no stuck inFlight guard, no corrupted state')
    coordinator.close()
  }
} finally {
  // Windows file-lock retry — SQLite WAL sidecar files (и допълнителни
  // connections, напр. tournamentEconomyStore) могат за кратко да задържат
  // OS-level lock след close(). Best-effort — ако cleanup-ът не успее, това
  // е temp directory noise, не test failure.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(tempDir, { recursive: true, force: true })
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
