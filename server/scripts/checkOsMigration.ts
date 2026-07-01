/**
 * Real migration test for 20260701_003_add_last_os_type_to_site_visitors.sql
 *
 * [1] Column is created by the migration
 * [2] Column is NOT NULL
 * [3] Column default is 'unknown'
 * [4] A row created BEFORE the migration reads back as last_os_type = 'unknown'
 * [5] Allowed values are accepted
 * [6] Invalid values are rejected by the CHECK constraint
 * [7] NULL is rejected (NOT NULL constraint)
 * [8] Migration performs no separate UPDATE/backfill (additive only)
 */

import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err) }
}

// Schema BEFORE the migration (no last_os_type column)
const PRE_MIGRATION_SCHEMA = `
CREATE TABLE site_visitors (
  anonymous_visitor_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_profile_id TEXT NULL, last_profile_id TEXT NULL,
  first_ip_address TEXT NULL, last_ip_address TEXT NULL,
  first_user_agent TEXT NULL, last_user_agent TEXT NULL,
  last_device_type TEXT NULL CHECK (last_device_type IN ('mobile', 'desktop', 'tablet', 'unknown')),
  first_referrer TEXT NULL, last_referrer TEXT NULL,
  first_source TEXT NULL, last_source TEXT NULL
);
CREATE TABLE site_visit_events (
  page_view_id TEXT PRIMARY KEY,
  anonymous_visitor_id TEXT NOT NULL,
  profile_id TEXT NULL, path TEXT NOT NULL,
  navigation_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (anonymous_visitor_id) REFERENCES site_visitors(anonymous_visitor_id) ON DELETE CASCADE
);
`

const MIGRATION_PATH = resolve(
  process.argv.slice(2).find(a => a.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
  'database', 'migrations', '20260701_003_add_last_os_type_to_site_visitors.sql',
)

// Rows that pre-date OS tracking — include some with a recognisable UA to prove
// the migration does NOT try to reconstruct their OS from it.
const PRE_EXISTING_ROWS: Array<[string, string | null]> = [
  ['iphone-old',  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'],
  ['windows-old', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'],
  ['no-ua-old',   null],
]

async function retryRm(path: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, 200))
  }
}

const dir = await mkdtemp(join(tmpdir(), 'belot-os-migration-'))
const dbPath = join(dir, 'test.sqlite')

try {
  const migrationSql = await readFile(MIGRATION_PATH, 'utf8')

  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  db.exec(PRE_MIGRATION_SCHEMA)

  // Rows inserted BEFORE the migration runs — these simulate real pre-existing data.
  for (const [id, ua] of PRE_EXISTING_ROWS) {
    const uaVal = ua ? `'${ua.replace(/'/g, "''")}'` : 'NULL'
    db.exec(`INSERT INTO site_visitors
      (anonymous_visitor_id, first_seen_at, last_seen_at, last_user_agent)
      VALUES ('${id}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ${uaVal})`)
  }

  console.log('\n[0] Pre-migration sanity check')
  check('[0.1] last_os_type absent before migration', () => {
    const cols = db.prepare(`PRAGMA table_info(site_visitors)`).all() as Array<{ name: string }>
    if (cols.some(c => c.name === 'last_os_type')) throw new Error('column exists before migration')
  })

  db.exec(migrationSql)

  console.log('\n[1] Column is created by the migration')
  let columnInfo: { name: string; notnull: number; dflt_value: string | null } | undefined
  check('[1.1] last_os_type column exists after migration', () => {
    const cols = db.prepare(`PRAGMA table_info(site_visitors)`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>
    columnInfo = cols.find(c => c.name === 'last_os_type')
    if (!columnInfo) throw new Error('column missing after migration')
  })

  console.log('\n[2] Column is NOT NULL')
  check('[2.1] last_os_type has NOT NULL constraint (PRAGMA notnull=1)', () => {
    if (columnInfo?.notnull !== 1) throw new Error(`notnull=${String(columnInfo?.notnull)}`)
  })

  console.log("\n[3] Column default is 'unknown'")
  check("[3.1] PRAGMA table_info reports default 'unknown'", () => {
    // SQLite reports the default literal including its quotes, e.g. "'unknown'"
    if (columnInfo?.dflt_value !== "'unknown'") throw new Error(`dflt_value=${String(columnInfo?.dflt_value)}`)
  })

  console.log("\n[4] Row created BEFORE the migration reads back as 'unknown'")
  for (const [id] of PRE_EXISTING_ROWS) {
    const row = db.prepare(`SELECT last_os_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(id) as { last_os_type: string | null } | undefined
    check(`[4] ${id} → last_os_type = 'unknown' (no reconstruction from UA)`, () => {
      if (row?.last_os_type !== 'unknown') throw new Error(`got=${String(row?.last_os_type)}, want=unknown`)
    })
  }

  console.log('\n[5] Allowed values are accepted')
  check('[5.1] all 7 valid values accepted', () => {
    for (const val of ['android', 'ios', 'windows', 'macos', 'linux', 'chromeos', 'unknown']) {
      db.exec(`UPDATE site_visitors SET last_os_type = '${val}' WHERE anonymous_visitor_id = 'iphone-old'`)
    }
  })

  console.log('\n[6] Invalid values are rejected by the CHECK constraint')
  check('[6.1] unrecognised value rejected', () => {
    try {
      db.exec(`UPDATE site_visitors SET last_os_type = 'symbian' WHERE anonymous_visitor_id = 'iphone-old'`)
      throw new Error('Expected CHECK constraint violation, but UPDATE succeeded')
    } catch (e) {
      if (e instanceof Error && e.message.includes('Expected CHECK constraint violation')) throw e
      // Any SQLite constraint error is the expected outcome
    }
  })

  console.log('\n[7] NULL is rejected (NOT NULL constraint)')
  check('[7.1] explicit NULL rejected', () => {
    try {
      db.exec(`UPDATE site_visitors SET last_os_type = NULL WHERE anonymous_visitor_id = 'iphone-old'`)
      throw new Error('Expected NOT NULL constraint violation, but UPDATE succeeded')
    } catch (e) {
      if (e instanceof Error && e.message.includes('Expected NOT NULL constraint violation')) throw e
      // Any SQLite constraint error is the expected outcome
    }
  })
  check('[7.2] INSERT without last_os_type still succeeds via DEFAULT (not a NULL insert)', () => {
    db.exec(`INSERT INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at) VALUES ('new-no-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    const row = db.prepare(`SELECT last_os_type FROM site_visitors WHERE anonymous_visitor_id = 'new-no-os'`).get() as { last_os_type: string | null }
    if (row.last_os_type !== 'unknown') throw new Error(`got=${String(row.last_os_type)}`)
  })

  console.log('\n[8] Migration performs no separate UPDATE/backfill (additive only)')
  check('[8.1] migration SQL contains no UPDATE statement', () => {
    if (/\bUPDATE\b/i.test(migrationSql)) throw new Error('migration performs a backfill UPDATE')
  })

  db.close()

} finally {
  await retryRm(dir)
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
