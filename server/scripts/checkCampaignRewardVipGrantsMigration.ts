/**
 * checkCampaignRewardVipGrantsMigration.ts
 *
 * Фаза 2 корекции (т.5) — задълбочена проверка на
 * 20261012_001_add_campaign_reward_to_vip_grants_reason.sql върху изолирана
 * база със РЕАЛИСТИЧНИ пред-съществуващи VIP данни (всичките 3 стари
 * reason стойности + различни профили + launch_gift/purchase partial unique
 * индекси + bundle_purchase_id колона от 20260923_005): запазване byte-for-
 * byte на старите redове, индекси/constraints, foreign_key_check, VIP
 * периоди (active_until) непроменени, и идемпотентен повторен restart.
 * Никога не изпълнява миграцията върху local/production база — изцяло
 * изолирана temp SQLite.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, cp } from 'node:fs/promises'
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

const TARGET_MIGRATION = '20261012_001_add_campaign_reward_to_vip_grants_reason.sql'

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')

console.log('\ncheckCampaignRewardVipGrantsMigration')
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
  const root = await mkdtemp(join(tmpdir(), 'belot-vip-grants-migration-'))
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
  const database = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  database.exec('PRAGMA foreign_keys = ON;')
  return database
}

type VipGrantRow = {
  grant_id: string
  profile_id: string | null
  deleted_profile_id_snapshot: string | null
  reason: string
  interval_unit: string
  interval_amount: number
  granted_at: string
  granted_by_profile_id: string | null
  resulting_active_until: string | null
  purchase_id: string | null
  amount_paid_cents: number | null
  currency: string | null
  bundle_purchase_id: string | null
}

function seedRealisticVipData(database: Awaited<ReturnType<typeof openDatabase>>): {
  profileIds: string[]
  grantIds: string[]
  statusByProfile: Map<string, string>
} {
  const profileIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  for (const [index, profileId] of profileIds.entries()) {
    database.prepare(`
      INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);
    `).run(profileId, `VIP Seed Player ${index}`, `vip seed player ${index}`)
  }

  const grantIds: string[] = []
  const statusByProfile = new Map<string, string>()

  // launch_gift — profile 0
  {
    const grantId = randomUUID()
    const activeUntil = '2026-11-15 10:00:00'
    database.prepare(`
      INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount, resulting_active_until)
      VALUES (?, ?, 'launch_gift', 'days', 30, ?);
    `).run(grantId, profileIds[0], activeUntil)
    database.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?);`).run(profileIds[0], activeUntil)
    grantIds.push(grantId)
    statusByProfile.set(profileIds[0], activeUntil)
  }

  // purchase — profile 1, със покупков audit trail (amount_paid_cents/currency/purchase_id реферира съществуващ vip_purchase_ledger ред)
  {
    const purchaseId = randomUUID()
    database.prepare(`
      INSERT INTO vip_purchase_ledger (
        purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status, credited_at
      ) VALUES (?, ?, 'vip_30', 30, 999, 'BGN', 'paid', CURRENT_TIMESTAMP);
    `).run(purchaseId, profileIds[1])
    const grantId = randomUUID()
    const activeUntil = '2026-12-01 00:00:00'
    database.prepare(`
      INSERT INTO vip_grants (
        grant_id, profile_id, reason, interval_unit, interval_amount, resulting_active_until, purchase_id, amount_paid_cents, currency
      ) VALUES (?, ?, 'purchase', 'days', 30, ?, ?, 999, 'BGN');
    `).run(grantId, profileIds[1], activeUntil, purchaseId)
    database.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?);`).run(profileIds[1], activeUntil)
    grantIds.push(grantId)
    statusByProfile.set(profileIds[1], activeUntil)
  }

  // admin_grant — profile 2, с granted_by_profile_id реферираш profile 0 (реален admin actor)
  {
    const grantId = randomUUID()
    const activeUntil = '2026-10-20 00:00:00'
    database.prepare(`
      INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount, granted_by_profile_id, resulting_active_until)
      VALUES (?, ?, 'admin_grant', 'months', 1, ?, ?);
    `).run(grantId, profileIds[2], profileIds[0], activeUntil)
    database.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?);`).run(profileIds[2], activeUntil)
    grantIds.push(grantId)
    statusByProfile.set(profileIds[2], activeUntil)
  }

  // Два purchase grants за profile 3 (кумулативно удължени, тества multi-row + partial unique index purchase_id_once с 2 различни purchase_id)
  {
    const purchaseId1 = randomUUID()
    const purchaseId2 = randomUUID()
    database.prepare(`
      INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status, credited_at)
      VALUES (?, ?, 'vip_30', 30, 500, 'BGN', 'paid', CURRENT_TIMESTAMP);
    `).run(purchaseId1, profileIds[3])
    database.prepare(`
      INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status, credited_at)
      VALUES (?, ?, 'vip_30', 30, 500, 'BGN', 'paid', CURRENT_TIMESTAMP);
    `).run(purchaseId2, profileIds[3])
    const grantId1 = randomUUID()
    const grantId2 = randomUUID()
    database.prepare(`
      INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount, resulting_active_until, purchase_id, amount_paid_cents, currency)
      VALUES (?, ?, 'purchase', 'days', 30, '2026-11-01 00:00:00', ?, 500, 'BGN');
    `).run(grantId1, profileIds[3], purchaseId1)
    database.prepare(`
      INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount, resulting_active_until, purchase_id, amount_paid_cents, currency)
      VALUES (?, ?, 'purchase', 'days', 30, '2026-12-01 00:00:00', ?, 500, 'BGN');
    `).run(grantId2, profileIds[3], purchaseId2)
    database.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, '2026-12-01 00:00:00');`).run(profileIds[3])
    grantIds.push(grantId1, grantId2)
    statusByProfile.set(profileIds[3], '2026-12-01 00:00:00')
  }

  return { profileIds, grantIds, statusByProfile }
}

function snapshotVipGrants(database: Awaited<ReturnType<typeof openDatabase>>): Map<string, VipGrantRow> {
  const rows = database.prepare(`
    SELECT grant_id, profile_id, deleted_profile_id_snapshot, reason, interval_unit, interval_amount,
           granted_at, granted_by_profile_id, resulting_active_until, purchase_id, amount_paid_cents, currency, bundle_purchase_id
    FROM vip_grants ORDER BY grant_id ASC;
  `).all() as VipGrantRow[]
  return new Map(rows.map((row) => [row.grant_id, row]))
}

// SQLite пази CREATE INDEX текста verbatim (не го нормализира) — различни
// migration файлове могат да изразят ФУНКЦИОНАЛНО идентичен индекс с леко
// различен whitespace (напр. line-wrap стил), без да има РЕАЛНА разлика в
// покритите колони/WHERE клауза. Сравняваме с нормализиран whitespace, не
// byte-for-byte текст — това е вярната проверка (поведение, не форматиране).
function normalizeSql(sql: string | null): string | null {
  return sql === null ? null : sql.replace(/\s+/g, ' ').trim()
}

function getIndexList(database: Awaited<ReturnType<typeof openDatabase>>, tableName: string): Map<string, string | null> {
  const rows = database.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?;`).all(tableName) as Array<{
    name: string
    sql: string | null
  }>
  return new Map(rows.map((row) => [row.name, normalizeSql(row.sql)]))
}

const realMigrationFileNames = await loadRealMigrationFileNames()
assert(realMigrationFileNames.includes(TARGET_MIGRATION), `${TARGET_MIGRATION} not found under ${sourceMigrationsDirectoryPath}`)
const beforeFileNames = realMigrationFileNames.filter((name) => name !== TARGET_MIGRATION)

{
  const temp = await createTempServerRoot(beforeFileNames)
  try {
    await ensureServerDatabaseReady({ serverRootOverride: temp.root })

    let seed!: ReturnType<typeof seedRealisticVipData>
    let indexesBefore!: Map<string, string | null>
    let grantsBefore!: Map<string, VipGrantRow>
    let fkCheckBeforeCount!: number

    await check('[1] Seed реалистични VIP данни (launch_gift/purchase/admin_grant + bundle-era схема) върху pre-migration схема', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        seed = seedRealisticVipData(database)
        assert(seed.grantIds.length === 5, `expected 5 seeded grants, got ${seed.grantIds.length}`)
        indexesBefore = getIndexList(database, 'vip_grants')
        grantsBefore = snapshotVipGrants(database)
        const fkCheck = database.prepare('PRAGMA foreign_key_check;').all()
        fkCheckBeforeCount = fkCheck.length
        assert(fkCheckBeforeCount === 0, 'sanity: foreign_key_check should be clean before the migration too')
      } finally {
        database.close()
      }
    })

    await cp(join(sourceMigrationsDirectoryPath, TARGET_MIGRATION), join(temp.migrationsDirectoryPath, TARGET_MIGRATION))

    await check('[2] Миграцията се прилага без грешка върху база със съществуващи VIP данни', async () => {
      const result = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(result.appliedCount === 1, `expected appliedCount=1, got ${result.appliedCount}`)
    })

    await check('[3] Всички стари vip_grants redове са запазени byte-for-byte (всички колони, включително bundle_purchase_id)', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        const grantsAfter = snapshotVipGrants(database)
        assert(grantsAfter.size === grantsBefore.size, `row count changed: before=${grantsBefore.size}, after=${grantsAfter.size}`)
        for (const [grantId, before] of grantsBefore) {
          const after = grantsAfter.get(grantId)
          assert(after !== undefined, `grant ${grantId} missing after migration`)
          assert(JSON.stringify(after) === JSON.stringify(before), `grant ${grantId} changed:\nbefore=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`)
        }
      } finally {
        database.close()
      }
    })

    await check('[4] Индексите са запазени (имена + SQL дефиниции идентични, вкл. partial unique индекси)', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        const indexesAfter = getIndexList(database, 'vip_grants')
        assert(indexesAfter.size === indexesBefore.size, `index count changed: before=${indexesBefore.size}, after=${indexesAfter.size}`)
        for (const [name, sqlBefore] of indexesBefore) {
          const sqlAfter = indexesAfter.get(name)
          assert(sqlAfter !== undefined, `index ${name} missing after migration`)
          assert(sqlAfter === sqlBefore, `index ${name} SQL changed:\nbefore=${sqlBefore}\nafter=${sqlAfter}`)
        }
      } finally {
        database.close()
      }
    })

    await check('[5] PRAGMA foreign_key_check е чист след миграцията', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        const fkCheck = database.prepare('PRAGMA foreign_key_check;').all()
        assert(fkCheck.length === 0, `expected 0 foreign_key_check violations, got ${fkCheck.length}: ${JSON.stringify(fkCheck)}`)
        const integrity = (database.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
        assert(integrity === 'ok', `integrity_check = ${integrity}`)
      } finally {
        database.close()
      }
    })

    await check('[6] VIP периодите (active_until в vip_status) остават напълно непроменени', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        for (const [profileId, expectedActiveUntil] of seed.statusByProfile) {
          const row = database.prepare(`SELECT active_until FROM vip_status WHERE profile_id = ?;`).get(profileId) as
            | { active_until: string }
            | undefined
          assert(row !== undefined, `vip_status missing for profile ${profileId}`)
          assert(row!.active_until === expectedActiveUntil, `active_until changed for ${profileId}: expected ${expectedActiveUntil}, got ${row!.active_until}`)
        }
      } finally {
        database.close()
      }
    })

    await check('[7] Новата reason стойност "campaign_reward" е приета от CHECK constraint-а', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        const testGrantId = randomUUID()
        database.prepare(`
          INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount, resulting_active_until)
          VALUES (?, ?, 'campaign_reward', 'days', 3, '2026-10-20 00:00:00');
        `).run(testGrantId, seed.profileIds[0])
        const row = database.prepare(`SELECT reason FROM vip_grants WHERE grant_id = ?;`).get(testGrantId) as { reason: string }
        assert(row.reason === 'campaign_reward', 'campaign_reward insert did not persist correctly')
      } finally {
        database.close()
      }
    })

    await check('[8] Старите 3 reason стойности продължават да се валидират нормално (CHECK не е broken от rebuild-а)', async () => {
      const database = await openDatabase(temp.databaseFilePath)
      try {
        let threw = false
        try {
          database.prepare(`
            INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount)
            VALUES (?, ?, 'not_a_real_reason', 'days', 1);
          `).run(randomUUID(), seed.profileIds[0])
        } catch {
          threw = true
        }
        assert(threw, 'invalid reason value must still be rejected by the CHECK constraint after rebuild')
      } finally {
        database.close()
      }
    })

    await check('[9] Повторен (restart) migration runner е идемпотентен — appliedCount=0, нулева промяна', async () => {
      const grantsBeforeRestart = await (async () => {
        const database = await openDatabase(temp.databaseFilePath)
        try {
          return snapshotVipGrants(database)
        } finally {
          database.close()
        }
      })()

      const result = await ensureServerDatabaseReady({ serverRootOverride: temp.root })
      assert(result.appliedCount === 0, `expected appliedCount=0 on restart, got ${result.appliedCount}`)

      const database = await openDatabase(temp.databaseFilePath)
      try {
        const grantsAfterRestart = snapshotVipGrants(database)
        assert(grantsAfterRestart.size === grantsBeforeRestart.size, 'row count changed after idempotent restart')
        const fkCheck = database.prepare('PRAGMA foreign_key_check;').all()
        assert(fkCheck.length === 0, 'foreign_key_check must stay clean after restart')
      } finally {
        database.close()
      }
    })
  } finally {
    await temp.cleanup()
  }
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
