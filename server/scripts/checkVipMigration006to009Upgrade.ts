/**
 * checkVipMigration006to009Upgrade.ts
 *
 * Realistic production-upgrade simulation за VIP migrations 006-009 (rename-
 * нати от 001-004 след cleanup audit-а — виж git history, оригиналните VIP
 * migration файлове бяха преименувани, за да пазят честна ledger хронология
 * СЛЕД вече-приложената production 20260818_005_add_topic_mute_evidence_
 * attachment_copy.sql). Използва РЕАЛНИЯ ensureServerDatabaseReady() runner
 * (serverRootOverride, isolated temp dir) — established checkServerMigration
 * RestartSafety.ts pattern, никаква copy-paste re-implementation на runner
 * логиката.
 *
 * Сценарий:
 * [1] Temp DB зарежда ВСИЧКИ реални migration файлове ДО и ВКЛЮЧИТЕЛНО
 *       20260818_005 (пълната production история, не hand-picked subset)
 * [2] Seed representative existing vip_grants редове ПРЕДИ 006-009 да
 *       съществуват:
 *       - launch_gift grant (purchase_id NULL, celebrating pre-Stripe state)
 *       - admin_grant grant (purchase_id NULL, granted_by_profile_id filled)
 * [3] Копира 006/007/008/009 файловете в migrations директорията (симулира
 *       "новият код пристига")
 * [4] Реален ensureServerDatabaseReady() run — 006-009 се прилагат
 * [5] Всичките 4 се записват в server_migrations ledger-а точно ВЕДНЪЖ
 * [6] Restart (втори run) → appliedCount=0 за 006-009 (skip via ledger, не
 *       повторно приложение — "table already exists"/"duplicate column"
 *       производствен incident клас грешка НЕ се случва)
 * [7] integrity_check = ok, foreign_keys = 1, foreign_key_check празен
 * [8] Съществуващите launch_gift/admin_grant redове остават НАПЪЛНО
 *       непроменени (grant_id/profile_id/reason/interval/granted_at same)
 *       СЛЕД ALTER TABLE ADD COLUMN-ите (008 добавя purchase_id/
 *       amount_paid_cents/currency — трите нови колони трябва да са NULL за
 *       тях, не грешка/data loss)
 * [9] Новият UNIQUE partial index (009, idx_vip_grants_purchase_id_once) НЕ
 *       блокира legacy редовете — партиалният WHERE clause ги игнорира
 *       (purchase_id IS NULL), потвърдено чрез директен опит за INSERT на
 *       ощe един launch_gift-style ред (различен profile) СЛЕД 009
 * [10] admin_settings VIP price seed (006) присъства с default стойности
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed += 1
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed += 1
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${message}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

const MIGRATION_006 = '20260818_006_seed_vip_price_settings.sql'
const MIGRATION_007 = '20260818_007_create_vip_purchase_ledger.sql'
const MIGRATION_008 = '20260818_008_add_vip_purchase_audit_fields.sql'
const MIGRATION_009 = '20260818_009_add_vip_grants_purchase_unique_index.sql'
const ALREADY_APPLIED_005 = '20260818_005_add_topic_mute_evidence_attachment_copy.sql'

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckVipMigration006to009Upgrade')
console.log(`Server root: ${sourceServerRoot}`)

async function loadRealMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

type TempServerRoot = {
  root: string
  migrationsDirectoryPath: string
  databaseFilePath: string
  cleanup: () => Promise<void>
}

async function createTempServerRoot(migrationFileNames: string[]): Promise<TempServerRoot> {
  const root = await mkdtemp(join(tmpdir(), 'belot-vip-migration-upgrade-'))
  const migrationsDirectoryPath = join(root, 'database', 'migrations')
  const dataDirectoryPath = join(root, 'database', 'data')
  await mkdir(migrationsDirectoryPath, { recursive: true })
  await mkdir(dataDirectoryPath, { recursive: true })
  for (const filename of migrationFileNames) {
    await cp(join(sourceMigrationsDirectoryPath, filename), join(migrationsDirectoryPath, filename))
  }
  return {
    root,
    migrationsDirectoryPath,
    databaseFilePath: join(dataDirectoryPath, 'belot-v2.sqlite'),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function openDatabase(databaseFilePath: string) {
  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  return database
}

function ledgerHas(database: Awaited<ReturnType<typeof openDatabase>>, filename: string): boolean {
  return database
    .prepare(`SELECT filename FROM server_migrations WHERE filename = ?;`)
    .get(filename) !== undefined
}

function getColumnNames(database: Awaited<ReturnType<typeof openDatabase>>, tableName: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${tableName});`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

const realMigrationFileNames = await loadRealMigrationFileNames()
assert(realMigrationFileNames.includes(ALREADY_APPLIED_005), `${ALREADY_APPLIED_005} not found — test assumption invalid`)
assert(realMigrationFileNames.includes(MIGRATION_006), `${MIGRATION_006} not found`)
assert(realMigrationFileNames.includes(MIGRATION_007), `${MIGRATION_007} not found`)
assert(realMigrationFileNames.includes(MIGRATION_008), `${MIGRATION_008} not found`)
assert(realMigrationFileNames.includes(MIGRATION_009), `${MIGRATION_009} not found`)

// Пълната production история ДО и ВКЛЮЧИТЕЛНО 005 (лексикографски "005" и
// по-рано) — реален upgrade сценарий, не hand-picked subset.
const migrationsThrough005 = realMigrationFileNames.filter((name) => name <= ALREADY_APPLIED_005)
const migrations006to009 = [MIGRATION_006, MIGRATION_007, MIGRATION_008, MIGRATION_009]
assert(
  !migrationsThrough005.some((name) => migrations006to009.includes(name)),
  '006-009 не трябва да са в "before" сета',
)

const temp = await createTempServerRoot(migrationsThrough005)
try {
  await check('[1] Схема ДО 005 (реалната production история) се прилага без грешка', async () => {
    const result = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
    assert(result.appliedCount === migrationsThrough005.length, `appliedCount=${result.appliedCount}, очаквах ${migrationsThrough005.length}`)
  })

  let launchGiftProfileId = ''
  let adminGrantProfileId = ''
  let launchGiftGrantId = ''
  let adminGrantGrantId = ''

  await check('[2] Seed: representative legacy vip_grants редове (launch_gift + admin_grant, purchase_id концепцията все още не съществува)', async () => {
    const database = await openDatabase(temp.databaseFilePath)
    try {
      launchGiftProfileId = randomUUID()
      adminGrantProfileId = randomUUID()
      const adminActorProfileId = randomUUID()
      launchGiftGrantId = randomUUID()
      adminGrantGrantId = randomUUID()

      database.exec('BEGIN;')
      database.prepare(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name)
        VALUES (?, 'Legacy Launch Gift Player', 'legacy launch gift player');
      `).run(launchGiftProfileId)
      database.prepare(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name)
        VALUES (?, 'Legacy Admin Grant Player', 'legacy admin grant player');
      `).run(adminGrantProfileId)
      database.prepare(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name)
        VALUES (?, 'Legacy Admin Actor', 'legacy admin actor');
      `).run(adminActorProfileId)

      // launch_gift — pre-006 schema, само базовите колони (granted_by_profile_id/
      // resulting_active_until вече съществуват от 20260815_001, но purchase_id/
      // amount_paid_cents/currency НЕ съществуват все още на тази схема версия).
      database.prepare(`
        INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount)
        VALUES (?, ?, 'launch_gift', 'days', 30);
      `).run(launchGiftGrantId, launchGiftProfileId)

      // admin_grant — попълва granted_by_profile_id/resulting_active_until
      // (вече съществуващи полета), НЕ purchase-специфичните (те идват едва с 008).
      database.prepare(`
        INSERT INTO vip_grants (
          grant_id, profile_id, reason, interval_unit, interval_amount,
          granted_by_profile_id, resulting_active_until
        ) VALUES (?, ?, 'admin_grant', 'months', 1, ?, '2026-09-18 00:00:00');
      `).run(adminGrantGrantId, adminGrantProfileId, adminActorProfileId)

      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    } finally {
      database.close()
    }
  })

  await check('[3]-[4] 006-009 се копират и РЕАЛНИЯТ runner ги прилага без грешка', async () => {
    for (const filename of migrations006to009) {
      await cp(join(sourceMigrationsDirectoryPath, filename), join(temp.migrationsDirectoryPath, filename))
    }
    const result = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
    assert(result.appliedCount === 4, `appliedCount=${result.appliedCount}, очаквах точно 4 (006/007/008/009)`)
  })

  await check('[5] Всичките 4 нови миграции са записани в server_migrations ledger-а', async () => {
    const database = await openDatabase(temp.databaseFilePath)
    try {
      for (const filename of migrations006to009) {
        assert(ledgerHas(database, filename), `${filename} липсва от ledger-а`)
      }
    } finally {
      database.close()
    }
  })

  await check('[6] Restart (втори run) → appliedCount=0 за 006-009, skip чрез ledger (не повторно приложение)', async () => {
    const result = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
    assert(result.appliedCount === 0, `втори run appliedCount=${result.appliedCount}, очаквах 0`)
    assert(
      result.skippedCount === migrationsThrough005.length + migrations006to009.length,
      `skippedCount=${result.skippedCount}, очаквах ${migrationsThrough005.length + migrations006to009.length}`,
    )
  })

  await check('[7] integrity_check=ok, foreign_keys=1, foreign_key_check празен', async () => {
    const database = await openDatabase(temp.databaseFilePath)
    try {
      const fk = (database.prepare('PRAGMA foreign_keys;').get() as { foreign_keys: number }).foreign_keys
      assertEqual(fk, 1, 'PRAGMA foreign_keys трябва да е 1')
      const integrity = (database.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
      assertEqual(integrity, 'ok', 'integrity_check трябва да е ok')
      const fkCheck = database.prepare('PRAGMA foreign_key_check;').all()
      assertEqual(fkCheck.length, 0, 'foreign_key_check трябва да е празен')
    } finally {
      database.close()
    }
  })

  await check('[8] Existing legacy vip_grants (launch_gift/admin_grant) остават НАПЪЛНО непроменени след ALTER TABLE (008)', async () => {
    const database = await openDatabase(temp.databaseFilePath)
    try {
      const columns = getColumnNames(database, 'vip_grants')
      assert(columns.includes('purchase_id'), 'purchase_id колоната трябва да съществува след 008')
      assert(columns.includes('amount_paid_cents'), 'amount_paid_cents колоната трябва да съществува след 008')
      assert(columns.includes('currency'), 'currency колоната трябва да съществува след 008')

      const launchGiftRow = database.prepare(`
        SELECT grant_id, profile_id, reason, interval_unit, interval_amount, purchase_id, amount_paid_cents, currency
        FROM vip_grants WHERE grant_id = ?;
      `).get(launchGiftGrantId) as {
        grant_id: string; profile_id: string; reason: string; interval_unit: string
        interval_amount: number; purchase_id: string | null; amount_paid_cents: number | null; currency: string | null
      } | undefined
      assert(launchGiftRow !== undefined, 'launch_gift редът трябва да съществува непокътнат')
      assertEqual(launchGiftRow?.reason, 'launch_gift', 'reason непроменен')
      assertEqual(launchGiftRow?.interval_unit, 'days', 'interval_unit непроменен')
      assertEqual(launchGiftRow?.interval_amount, 30, 'interval_amount непроменен')
      assertEqual(launchGiftRow?.purchase_id, null, 'legacy launch_gift ред трябва да има purchase_id=NULL (backward compatible default)')
      assertEqual(launchGiftRow?.amount_paid_cents, null, 'legacy launch_gift ред трябва да има amount_paid_cents=NULL')
      assertEqual(launchGiftRow?.currency, null, 'legacy launch_gift ред трябва да има currency=NULL')

      const adminGrantRow = database.prepare(`
        SELECT grant_id, profile_id, reason, interval_unit, interval_amount, granted_by_profile_id, resulting_active_until, purchase_id
        FROM vip_grants WHERE grant_id = ?;
      `).get(adminGrantGrantId) as {
        grant_id: string; profile_id: string; reason: string; interval_unit: string; interval_amount: number
        granted_by_profile_id: string | null; resulting_active_until: string | null; purchase_id: string | null
      } | undefined
      assert(adminGrantRow !== undefined, 'admin_grant редът трябва да съществува непокътнат')
      assertEqual(adminGrantRow?.reason, 'admin_grant', 'reason непроменен')
      assertEqual(adminGrantRow?.interval_unit, 'months', 'interval_unit непроменен')
      assertEqual(adminGrantRow?.resulting_active_until, '2026-09-18 00:00:00', 'resulting_active_until непроменен от преди 008')
      assertEqual(adminGrantRow?.purchase_id, null, 'legacy admin_grant ред трябва да има purchase_id=NULL')
    } finally {
      database.close()
    }
  })

  await check('[9] Новият UNIQUE partial index (009) НЕ блокира втори legacy launch_gift-style ред (purchase_id IS NULL, различен profile)', async () => {
    const database = await openDatabase(temp.databaseFilePath)
    try {
      const anotherProfileId = randomUUID()
      database.prepare(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name)
        VALUES (?, 'Another Legacy Player', 'another legacy player');
      `).run(anotherProfileId)

      // Легитимен нов launch_gift ред СЛЕД 009 — purchase_id остава NULL
      // (launch_gift никога не носи purchase_id). Партиалният UNIQUE index
      // (WHERE reason='purchase' AND purchase_id IS NOT NULL) НЕ трябва да
      // третира този INSERT като конфликт с launch_gift реда от [2].
      let threw = false
      try {
        database.prepare(`
          INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount)
          VALUES (?, ?, 'launch_gift', 'days', 30);
        `).run(randomUUID(), anotherProfileId)
      } catch {
        threw = true
      }
      assert(!threw, 'нов legacy-style launch_gift ред (purchase_id=NULL) НЕ трябва да бъде блокиран от idx_vip_grants_purchase_id_once')
    } finally {
      database.close()
    }
  })

  await check('[10] admin_settings VIP price seed (006) присъства с default стойности', async () => {
    const database = await openDatabase(temp.databaseFilePath)
    try {
      const rows = database.prepare(`
        SELECT setting_key, setting_value FROM admin_settings
        WHERE setting_key IN ('vip_price_30_days_cents', 'vip_price_180_days_cents', 'vip_price_365_days_cents');
      `).all() as Array<{ setting_key: string; setting_value: string }>
      const values = new Map(rows.map((r) => [r.setting_key, r.setting_value]))
      assertEqual(values.get('vip_price_30_days_cents'), '789', 'VIP 30 дни default цена')
      assertEqual(values.get('vip_price_180_days_cents'), '3989', 'VIP 180 дни default цена')
      assertEqual(values.get('vip_price_365_days_cents'), '6989', 'VIP 365 дни default цена')
    } finally {
      database.close()
    }
  })
} finally {
  await temp.cleanup()
}

console.log(`\n${'═'.repeat(64)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
