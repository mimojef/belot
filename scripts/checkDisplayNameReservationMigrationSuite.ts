// checkDisplayNameReservationMigrationSuite.ts
//
// FINAL PLAN v5 — migration-specific focused tests (TESTS 13/14/15/20/21/22
// from the approved test list). These need a DB SEEDED WITH LEGACY STATE
// *before* the new migration runs, so they use a different harness shape
// than checkDisplayNameReservationFullSuite.ts: no live server process,
// direct calls to ensureServerDatabaseReady() (server/src/db/
// ensureServerDatabaseReady.ts) against an isolated server root, using its
// existing serverRootOverride hook (the SAME hook already used by other
// restart-safety tests in this codebase).
//
// Flow per scenario:
//   1. Create an isolated <root>/server/database/{migrations,data} tree.
//   2. Copy ONLY the migrations up to (and NOT including) the new
//      20260921_001_add_pending_registration_display_name_reservation.sql
//      file, to simulate "production before this feature shipped".
//   3. Run ensureServerDatabaseReady() once — creates the DB with the OLD
//      schema (no normalized_display_name column yet).
//   4. Seed legacy pending_registrations rows directly via raw INSERT
//      (old-shape: no normalized_display_name column exists yet).
//   5. Copy the new migration file in.
//   6. Run ensureServerDatabaseReady() again — this is the exact moment the
//      real production upgrade would apply the new migration against
//      already-existing legacy data.
//   7. Assert the resulting DB state against the plan's exact rules.

import { mkdir, cp, mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

const projectRoot = process.cwd()
const NEW_MIGRATION_FILENAME = '20260921_001_add_pending_registration_display_name_reservation.sql'

async function buildIsolatedRootWithLegacySchema(): Promise<{ serverRoot: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'belot-name-reservation-migration-'))
  const migrationsDir = join(root, 'database', 'migrations')
  const dataDir = join(root, 'database', 'data')
  await mkdir(migrationsDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  const allMigrationFiles = (await readdir(join(projectRoot, 'server', 'database', 'migrations')))
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'))

  // Copy everything EXCEPT the new migration — simulates "before this
  // feature shipped".
  for (const filename of allMigrationFiles) {
    if (filename === NEW_MIGRATION_FILENAME) continue
    await cp(
      join(projectRoot, 'server', 'database', 'migrations', filename),
      join(migrationsDir, filename),
    )
  }

  return { serverRoot: root, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined) }
}

async function addNewMigrationFile(serverRoot: string): Promise<void> {
  await cp(
    join(projectRoot, 'server', 'database', 'migrations', NEW_MIGRATION_FILENAME),
    join(serverRoot, 'database', 'migrations', NEW_MIGRATION_FILENAME),
  )
}

function dbFilePath(serverRoot: string): string {
  return join(serverRoot, 'database', 'data', 'belot-v2.sqlite')
}

let legacyRowCounter = 0
function insertLegacyPendingRow(
  db: DatabaseSync,
  fields: { displayName: string; createdAt: string; expiresAt?: string; email?: string },
): string {
  legacyRowCounter += 1
  const id = `legacy-${legacyRowCounter}-${Math.random().toString(36).slice(2, 8)}`
  const expiresAt = fields.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const email = fields.email ?? `legacy-${legacyRowCounter}@example.test`
  db.prepare(`
    INSERT INTO pending_registrations (
      pending_registration_id, normalized_email, password_hash, display_name,
      gender, visitor_id, ip_address, user_agent, code_hash, created_at, expires_at, last_code_sent_at
    ) VALUES (?, ?, 'x', ?, NULL, NULL, NULL, NULL, 'x', ?, ?, ?);
  `).run(id, email, fields.displayName, fields.createdAt, expiresAt, fields.createdAt)
  return id
}

console.log('\ncheckDisplayNameReservationMigrationSuite\n')

// ═══════════════════════════════════════════════════════════════════════
// TEST 13/15 — Legacy duplicate migration: oldest deterministic winner,
// loser remains NULL/unreserved (never deleted). Also covers TEST 21
// (normalization collision — different raw spellings, same normalized key).
// ═══════════════════════════════════════════════════════════════════════
{
  const { serverRoot, cleanup } = await buildIsolatedRootWithLegacySchema()
  try {
    const { ensureServerDatabaseReady } = await import(
      pathToFileURL(join(projectRoot, 'server', 'dist', 'db', 'ensureServerDatabaseReady.js')).href
    )
    await ensureServerDatabaseReady({ serverRootOverride: serverRoot })

    const older = new Date(Date.now() - 10_000).toISOString()
    const newer = new Date(Date.now() - 5_000).toISOString()
    let winnerId = ''
    let loserId = ''
    {
      const db = new DatabaseSync(dbFilePath(serverRoot))
      try {
        // Same normalized key ("milen"), different raw spelling — proves
        // both duplicate-group resolution AND normalization-collision
        // classification (NFKC/case difference) in one seed.
        winnerId = insertLegacyPendingRow(db, { displayName: 'Milen', createdAt: older })
        loserId = insertLegacyPendingRow(db, { displayName: 'MILEN', createdAt: newer })
      } finally {
        db.close()
      }
    }

    await addNewMigrationFile(serverRoot)
    await check('[TEST 13/15/21] legacy duplicate + normalization collision: oldest wins, loser -> NULL, neither row deleted', async () => {
      const result = await ensureServerDatabaseReady({ serverRootOverride: serverRoot })
      assert(result.appliedCount >= 1, 'expected the new migration to be applied')

      const db = new DatabaseSync(dbFilePath(serverRoot), { readOnly: true })
      try {
        const winnerRow = db.prepare('SELECT normalized_display_name FROM pending_registrations WHERE pending_registration_id = ?').get(winnerId) as { normalized_display_name: string | null } | undefined
        const loserRow = db.prepare('SELECT normalized_display_name FROM pending_registrations WHERE pending_registration_id = ?').get(loserId) as { normalized_display_name: string | null } | undefined
        assert(winnerRow !== undefined, 'winner row should NOT be deleted')
        assert(loserRow !== undefined, 'loser row should NOT be deleted')
        assert(winnerRow!.normalized_display_name === 'milen', `expected winner reserved as 'milen', got '${winnerRow!.normalized_display_name}'`)
        assert(loserRow!.normalized_display_name === null, `expected loser to be unreserved (NULL), got '${loserRow!.normalized_display_name}'`)
      } finally {
        db.close()
      }
    })
  } finally {
    await cleanup()
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST 14 — Legacy pending conflicting with a completed profile becomes
// unreserved (NULL), not deleted.
// ═══════════════════════════════════════════════════════════════════════
{
  const { serverRoot, cleanup } = await buildIsolatedRootWithLegacySchema()
  try {
    const { ensureServerDatabaseReady } = await import(
      pathToFileURL(join(projectRoot, 'server', 'dist', 'db', 'ensureServerDatabaseReady.js')).href
    )
    await ensureServerDatabaseReady({ serverRootOverride: serverRoot })

    let pendingId = ''
    {
      const db = new DatabaseSync(dbFilePath(serverRoot))
      try {
        db.exec('PRAGMA foreign_keys = OFF;') // minimal seed, skip unrelated FK-required columns
        db.prepare(`
          INSERT INTO profiles (
            profile_id, account_id, profile_kind, username, normalized_username,
            display_name, normalized_display_name, level, rank_title, skill_rating, status
          ) VALUES ('legacy-profile-1', NULL, 'human', 'takenname', 'takenname', 'TakenName', 'takenname', 1, 'Rank', 1000, 'active');
        `).run()
        pendingId = insertLegacyPendingRow(db, { displayName: 'TakenName', createdAt: new Date().toISOString() })
      } finally {
        db.close()
      }
    }

    await addNewMigrationFile(serverRoot)
    await check('[TEST 14] legacy pending conflicting with a completed profile -> unreserved, NOT deleted', async () => {
      await ensureServerDatabaseReady({ serverRootOverride: serverRoot })
      const db = new DatabaseSync(dbFilePath(serverRoot), { readOnly: true })
      try {
        const row = db.prepare('SELECT normalized_display_name FROM pending_registrations WHERE pending_registration_id = ?').get(pendingId) as { normalized_display_name: string | null } | undefined
        assert(row !== undefined, 'row should NOT be deleted')
        assert(row!.normalized_display_name === null, `expected unreserved (NULL) due to profile conflict, got '${row!.normalized_display_name}'`)
      } finally {
        db.close()
      }
    })
  } finally {
    await cleanup()
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST 15 — Malformed legacy pending (fails CURRENT validateProfileDisplayName
// rules) survives the migration as unreserved (NULL), never deleted.
// ═══════════════════════════════════════════════════════════════════════
{
  const { serverRoot, cleanup } = await buildIsolatedRootWithLegacySchema()
  try {
    const { ensureServerDatabaseReady } = await import(
      pathToFileURL(join(projectRoot, 'server', 'dist', 'db', 'ensureServerDatabaseReady.js')).href
    )
    await ensureServerDatabaseReady({ serverRootOverride: serverRoot })

    let malformedId = ''
    {
      const db = new DatabaseSync(dbFilePath(serverRoot))
      try {
        // Emoji is outside ALLOWED_DISPLAY_NAME_RE (letters/digits/single
        // spaces only) — guaranteed to fail validateProfileDisplayName().
        malformedId = insertLegacyPendingRow(db, { displayName: 'Bad🙂Name', createdAt: new Date().toISOString() })
      } finally {
        db.close()
      }
    }

    await addNewMigrationFile(serverRoot)
    await check('[TEST 15] malformed legacy display name survives migration as unreserved (NULL), NOT deleted', async () => {
      await ensureServerDatabaseReady({ serverRootOverride: serverRoot })
      const db = new DatabaseSync(dbFilePath(serverRoot), { readOnly: true })
      try {
        const row = db.prepare('SELECT display_name, normalized_display_name FROM pending_registrations WHERE pending_registration_id = ?').get(malformedId) as { display_name: string; normalized_display_name: string | null } | undefined
        assert(row !== undefined, 'malformed row should NOT be deleted')
        assert(row!.display_name === 'Bad🙂Name', 'display_name should remain untouched')
        assert(row!.normalized_display_name === null, `expected unreserved (NULL) for malformed name, got '${row!.normalized_display_name}'`)
      } finally {
        db.close()
      }
    })
  } finally {
    await cleanup()
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST 20 — Canonical normalization collision coverage (NFKC/case/
// whitespace equivalents classify correctly as ONE duplicate group).
// ═══════════════════════════════════════════════════════════════════════
{
  const { serverRoot, cleanup } = await buildIsolatedRootWithLegacySchema()
  try {
    const { ensureServerDatabaseReady } = await import(
      pathToFileURL(join(projectRoot, 'server', 'dist', 'db', 'ensureServerDatabaseReady.js')).href
    )
    await ensureServerDatabaseReady({ serverRootOverride: serverRoot })

    const t0 = new Date(Date.now() - 30_000).toISOString()
    const t1 = new Date(Date.now() - 20_000).toISOString()
    const t2 = new Date(Date.now() - 10_000).toISOString()
    let idPlain = '', idDoubleSpace = '', idUpper = ''
    {
      const db = new DatabaseSync(dbFilePath(serverRoot))
      try {
        idPlain = insertLegacyPendingRow(db, { displayName: 'Ivan', createdAt: t0 })
        idDoubleSpace = insertLegacyPendingRow(db, { displayName: 'Ivan', createdAt: t1 }) // exact duplicate, different row
        idUpper = insertLegacyPendingRow(db, { displayName: 'IVAN', createdAt: t2 })
      } finally {
        db.close()
      }
    }

    await addNewMigrationFile(serverRoot)
    await check('[TEST 20] NFKC/case-equivalent values (Ivan / Ivan / IVAN) classify as one duplicate group, oldest wins', async () => {
      await ensureServerDatabaseReady({ serverRootOverride: serverRoot })
      const db = new DatabaseSync(dbFilePath(serverRoot), { readOnly: true })
      try {
        const rows = [idPlain, idDoubleSpace, idUpper].map((id) =>
          db.prepare('SELECT normalized_display_name FROM pending_registrations WHERE pending_registration_id = ?').get(id) as { normalized_display_name: string | null },
        )
        const reservedCount = rows.filter((r) => r.normalized_display_name !== null).length
        assert(reservedCount === 1, `expected exactly 1 reserved row among the 3-way duplicate group, got ${reservedCount}`)
        const winnerRow = db.prepare('SELECT normalized_display_name FROM pending_registrations WHERE pending_registration_id = ?').get(idPlain) as { normalized_display_name: string | null }
        assert(winnerRow.normalized_display_name === 'ivan', `expected the OLDEST row (idPlain) to win, got normalized_display_name='${winnerRow.normalized_display_name}'`)
      } finally {
        db.close()
      }
    })
  } finally {
    await cleanup()
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEST 22 — Migration postcondition/index behavior: unique index actually
// exists after migration, and duplicate non-NULL inserts against it fail.
// ═══════════════════════════════════════════════════════════════════════
{
  const { serverRoot, cleanup } = await buildIsolatedRootWithLegacySchema()
  try {
    const { ensureServerDatabaseReady } = await import(
      pathToFileURL(join(projectRoot, 'server', 'dist', 'db', 'ensureServerDatabaseReady.js')).href
    )
    await ensureServerDatabaseReady({ serverRootOverride: serverRoot })
    await addNewMigrationFile(serverRoot)
    await ensureServerDatabaseReady({ serverRootOverride: serverRoot })

    await check('[TEST 22a] unique index idx_pending_registrations_display_name_unique exists after migration', async () => {
      const db = new DatabaseSync(dbFilePath(serverRoot), { readOnly: true })
      try {
        const indexRow = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pending_registrations_display_name_unique';`).get()
        assert(indexRow !== undefined, 'expected the unique index to exist after migration')
      } finally {
        db.close()
      }
    })

    await check('[TEST 22b] duplicate non-NULL normalized_display_name INSERT violates the new unique index', async () => {
      const db = new DatabaseSync(dbFilePath(serverRoot))
      try {
        db.prepare(`
          INSERT INTO pending_registrations (
            pending_registration_id, normalized_email, password_hash, display_name,
            gender, visitor_id, ip_address, user_agent, code_hash, expires_at, last_code_sent_at,
            normalized_display_name
          ) VALUES ('idx-test-1', 'idxtest1@example.test', 'x', 'IdxTest', NULL, NULL, NULL, NULL, 'x', ?, ?, 'idxtest');
        `).run(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), new Date().toISOString())

        let threw = false
        try {
          db.prepare(`
            INSERT INTO pending_registrations (
              pending_registration_id, normalized_email, password_hash, display_name,
              gender, visitor_id, ip_address, user_agent, code_hash, expires_at, last_code_sent_at,
              normalized_display_name
            ) VALUES ('idx-test-2', 'idxtest2@example.test', 'x', 'IdxTest', NULL, NULL, NULL, NULL, 'x', ?, ?, 'idxtest');
          `).run(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), new Date().toISOString())
        } catch {
          threw = true
        }
        assert(threw, 'expected the second INSERT with a duplicate non-NULL normalized_display_name to violate the unique index')

        // Two NULL rows must NOT conflict (SQLite unique indexes ignore NULL).
        db.prepare(`
          INSERT INTO pending_registrations (
            pending_registration_id, normalized_email, password_hash, display_name,
            gender, visitor_id, ip_address, user_agent, code_hash, expires_at, last_code_sent_at,
            normalized_display_name
          ) VALUES ('idx-test-3', 'idxtest3@example.test', 'x', 'IdxNullA', NULL, NULL, NULL, NULL, 'x', ?, ?, NULL);
        `).run(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), new Date().toISOString())
        db.prepare(`
          INSERT INTO pending_registrations (
            pending_registration_id, normalized_email, password_hash, display_name,
            gender, visitor_id, ip_address, user_agent, code_hash, expires_at, last_code_sent_at,
            normalized_display_name
          ) VALUES ('idx-test-4', 'idxtest4@example.test', 'x', 'IdxNullB', NULL, NULL, NULL, NULL, 'x', ?, ?, NULL);
        `).run(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), new Date().toISOString())
      } finally {
        db.close()
      }
    })
  } finally {
    await cleanup()
  }
}

console.log('\n' + '═'.repeat(72))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exitCode = 1
await sleep(0)
