/**
 * Real migration test for 20260630_002_add_last_device_type_to_site_visitors.sql
 *
 * [1] Column and CHECK constraint are created by the migration
 * [2] Backfill from last_user_agent: iPhone → mobile, Android+Mobile → mobile,
 *     Android tablet → tablet, iPad → tablet, iPadOS desktop-mode → tablet,
 *     Windows → desktop, unrecognised UA → unknown, NULL UA → unknown
 * [3] Idempotency: running the migration SQL twice does not overwrite values already set
 * [4] CHECK constraint rejects invalid values
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

// Schema BEFORE the migration (no last_device_type column)
const PRE_MIGRATION_SCHEMA = `
CREATE TABLE site_visitors (
  anonymous_visitor_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  first_profile_id TEXT NULL, last_profile_id TEXT NULL,
  first_ip_address TEXT NULL, last_ip_address TEXT NULL,
  first_user_agent TEXT NULL, last_user_agent TEXT NULL,
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
  'database', 'migrations', '20260630_002_add_last_device_type_to_site_visitors.sql',
)

// UA test vectors: [id, userAgent, expectedDevice]
const UA_CASES: Array<[string, string | null, string]> = [
  ['iphone',    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'mobile'],
  ['android-m', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',                   'mobile'],
  ['android-t', 'Mozilla/5.0 (Linux; Android 12; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',                          'tablet'],
  ['ipad',      'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',           'tablet'],
  ['ipados',    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/22B83 Safari/604.1',          'tablet'],
  ['windows',   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',                          'desktop'],
  ['unknown-ua','MyCustomBot/1.0',                                                                                                                            'unknown'],
  ['null-ua',   null,                                                                                                                                         'unknown'],
]

async function retryRm(path: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, 200))
  }
}

const dir = await mkdtemp(join(tmpdir(), 'belot-device-migration-'))
const dbPath = join(dir, 'test.sqlite')

try {
  const migrationSql = await readFile(MIGRATION_PATH, 'utf8')

  // ─── [1] Run migration on pre-migration schema ────────────────────────────
  console.log('\n[1] Column and CHECK constraint created by migration')
  {
    const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    db.exec(PRE_MIGRATION_SCHEMA)

    // Insert test rows BEFORE running the migration
    for (const [id, ua] of UA_CASES) {
      const uaVal = ua ? `'${ua.replace(/'/g, "''")}'` : 'NULL'
      db.exec(`INSERT INTO site_visitors
        (anonymous_visitor_id, first_seen_at, last_seen_at, last_user_agent)
        VALUES ('${id}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ${uaVal})`)
    }

    // Verify column does NOT exist before migration
    check('[1.0] last_device_type absent before migration', () => {
      const cols = db.prepare(`PRAGMA table_info(site_visitors)`).all() as Array<{ name: string }>
      if (cols.some(c => c.name === 'last_device_type')) throw new Error('column exists before migration')
    })

    // Apply the actual migration SQL
    db.exec(migrationSql)

    check('[1.1] last_device_type column exists after migration', () => {
      const cols = db.prepare(`PRAGMA table_info(site_visitors)`).all() as Array<{ name: string }>
      if (!cols.some(c => c.name === 'last_device_type')) throw new Error('column missing after migration')
    })

    // ─── [2] Backfill correctness ─────────────────────────────────────────
    console.log('\n[2] Backfill: each UA maps to the expected device type')
    for (const [id, , expected] of UA_CASES) {
      const row = db.prepare(`SELECT last_device_type FROM site_visitors WHERE anonymous_visitor_id = ?`).get(id) as { last_device_type: string | null } | undefined
      check(`[2] ${id} → ${expected}`, () => {
        if (row?.last_device_type !== expected) throw new Error(`got=${String(row?.last_device_type)}, want=${expected}`)
      })
    }

    check('[2.9] no rows remain NULL after migration', () => {
      const nullRow = db.prepare(`SELECT COUNT(*) AS n FROM site_visitors WHERE last_device_type IS NULL`).get() as { n: number }
      if (nullRow.n !== 0) throw new Error(`${nullRow.n} rows still NULL`)
    })

    // ─── [3] Idempotency ─────────────────────────────────────────────────
    console.log('\n[3] Idempotency: re-running migration SQL does not change already-set values')
    {
      // Remember current values
      const before = (db.prepare(`SELECT anonymous_visitor_id, last_device_type FROM site_visitors ORDER BY anonymous_visitor_id`).all() as Array<{ anonymous_visitor_id: string; last_device_type: string | null }>)

      // Run the UPDATE part of the migration again (ALTER TABLE would fail, so just the UPDATE)
      const updateOnly = migrationSql.split(';').filter(s => s.trim().toUpperCase().startsWith('UPDATE')).join(';') + ';'
      db.exec(updateOnly)

      const after = (db.prepare(`SELECT anonymous_visitor_id, last_device_type FROM site_visitors ORDER BY anonymous_visitor_id`).all() as Array<{ anonymous_visitor_id: string; last_device_type: string | null }>)

      check('[3.1] no device type values changed after re-run', () => {
        for (let i = 0; i < before.length; i++) {
          const b = before[i]!
          const a = after[i]!
          if (b.last_device_type !== a.last_device_type) {
            throw new Error(`${b.anonymous_visitor_id}: before=${b.last_device_type} after=${a.last_device_type}`)
          }
        }
      })
    }

    // ─── [4] CHECK constraint ─────────────────────────────────────────────
    console.log('\n[4] CHECK constraint rejects invalid values')
    check('[4.1] invalid value rejected by CHECK constraint', () => {
      try {
        db.exec(`UPDATE site_visitors SET last_device_type = 'phone' WHERE anonymous_visitor_id = 'iphone'`)
        throw new Error('Expected constraint violation, but UPDATE succeeded')
      } catch (e) {
        if (e instanceof Error && e.message.includes('Expected constraint violation')) throw e
        // Any SQLite constraint error is the expected outcome
      }
    })

    check('[4.2] valid values accepted', () => {
      for (const val of ['mobile', 'desktop', 'tablet', 'unknown']) {
        db.exec(`UPDATE site_visitors SET last_device_type = '${val}' WHERE anonymous_visitor_id = 'iphone'`)
      }
    })

    db.close()
  }

} finally {
  await retryRm(dir)
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
