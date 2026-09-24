/**
 * checkGiftRecipientMigrationProductionIncident.ts
 *
 * End-to-end regression за production deploy failure-а (2026-09-24,
 * rollback-нат): 20260923_002_add_gift_recipient_to_purchase_ledgers.sql
 * пресъздаваше idx_coin_purchase_ledger_pending_package/
 * idx_bundle_purchase_ledger_pending_package БЕЗ established `hidden_at IS
 * NULL` predicate-а (установен в
 * 20260626_002_fix_pending_package_index_for_hidden.sql за coin), затова
 * `CREATE UNIQUE INDEX` се блъскаше в "UNIQUE constraint failed" винаги
 * когато payer вече имаше hidden historical pending ред + отделен active
 * pending ред за същия package — точно production state-а
 * (profile_id=55f576db-e308-4c61-b05d-9bea82e48796,
 * package_id=coin-package-mini, 2 pending реда, единия hidden).
 *
 * Този тест реконструира ТОЧНО тази последователност чрез РЕАЛНИТЕ .sql
 * migration файлове (не hand-rolled schema copies):
 *   1) прилага миграциите ЧАК до 20260626_002 (coin вече има hidden_at
 *      колона + hidden-aware pending index) в изолиран temp server root
 *   2) seed-ва production-like pending редове директно в coin_purchase_ledger
 *      (hidden historical + active), симулирайки реалния preexisting state
 *   3) разширява temp migrations директорията с ОСТАНАЛИТЕ реални файлове
 *      (вкл. фиксирания 20260923_002 и bundle rebuild-а 20260923_004) и
 *      пуска ensureServerDatabaseReady отново — трябва да мине БЕЗ грешка
 *   4) потвърждава hidden редът е останал непокътнат (без data cleanup/
 *      mutation) и че active pending guard-ите работят коректно след fix-а
 */

import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-prod-incident-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

const REAL_MIGRATIONS_DIR = join(process.cwd(), 'database', 'migrations')
// Границата на "pre-incident" production state-а — всичко до и вкл. тази
// миграция вече бе успешно приложено на production преди инцидента.
const PRE_INCIDENT_CUTOFF = '20260626_002_fix_pending_package_index_for_hidden.sql'

await withTempDir(async (rootDir) => {
  const migrationsDir = join(rootDir, 'database', 'migrations')
  await mkdir(migrationsDir, { recursive: true })

  const allRealFiles = (await readdir(REAL_MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'))

  const preIncidentFiles = allRealFiles.filter((f) => f.localeCompare(PRE_INCIDENT_CUTOFF, 'en') <= 0)
  assert(preIncidentFiles.includes(PRE_INCIDENT_CUTOFF), 'cutoff файлът трябва да съществува в реалната migrations директория')

  await check('[PRE] Копиране на pre-incident подмножество миграции (до 20260626_002 вкл.)', async () => {
    for (const f of preIncidentFiles) {
      await cp(join(REAL_MIGRATIONS_DIR, f), join(migrationsDir, f))
    }
  })

  const dbPath = join(rootDir, 'database', 'data', 'belot-v2.sqlite')

  await check('[PRE] Прилагане на pre-incident веригата успява (симулира production ПРЕДИ deploy-а)', async () => {
    const result = await ensureServerDatabaseReady({
      serverRootOverride: rootDir,
      databaseFilePathOverride: dbPath,
    })
    assert(result.appliedCount === preIncidentFiles.length, `очакваше ${preIncidentFiles.length} приложени, получи ${result.appliedCount}`)
  })

  const PAYER_ID = '55f576db-e308-4c61-b05d-9bea82e48796'
  const PACKAGE_ID = 'coin-package-mini'

  await check('[SEED] Seed на production-like state: hidden historical pending + active pending за същия payer/package', () => {
    const db = new DatabaseSync(dbPath, { open: true })
    try {
      db.exec('PRAGMA foreign_keys = OFF;')
      db.prepare(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name, created_at)
        VALUES (?, 'Test Payer', 'test payer', CURRENT_TIMESTAMP)
      `).run(PAYER_ID)

      const insertPurchase = db.prepare(`
        INSERT INTO coin_purchase_ledger (
          purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
          yellow_coins_amount, price_cents, currency, provider, status, hidden_at, created_at
        ) VALUES (?, ?, ?, 'coin-package-mini', 'Mini Pack', 100, 199, 'EUR', 'stripe', 'pending', ?, ?)
      `)
      // Historical hidden pending (потребителят го е "скрил" от историята си,
      // редът остава pending — никога не е бил fulfilled/canceled).
      // Параметри в реда на statement-а: (hidden_at, created_at).
      insertPurchase.run('purchase-historical-hidden', PAYER_ID, PACKAGE_ID, '2026-08-01 12:00:00', '2026-08-01 10:00:00')
      // Active (не-hidden) pending checkout — реалния "втори pending ред",
      // споменат в production incident описанието.
      insertPurchase.run('purchase-active', PAYER_ID, PACKAGE_ID, null, '2026-09-20 09:00:00')

      const count = (db.prepare(`SELECT COUNT(*) AS c FROM coin_purchase_ledger WHERE profile_id = ? AND package_id = ? AND status = 'pending'`).get(PAYER_ID, PACKAGE_ID) as { c: number }).c
      assert(count === 2, `seed трябва да остави 2 pending реда, намерени ${count}`)
    } finally {
      db.close()
    }
  })

  await check('[POST] Копиране на останалите миграции (вкл. фиксираната 20260923_002 и bundle rebuild-а 20260923_004)', async () => {
    const remainingFiles = allRealFiles.filter((f) => f.localeCompare(PRE_INCIDENT_CUTOFF, 'en') > 0)
    assert(remainingFiles.some((f) => f.includes('20260923_002')), 'трябва да включва 20260923_002')
    assert(remainingFiles.some((f) => f.includes('20260923_004')), 'трябва да включва 20260923_004')
    for (const f of remainingFiles) {
      await cp(join(REAL_MIGRATIONS_DIR, f), join(migrationsDir, f))
    }
  })

  await check('[POST] Пълната верига (вкл. фиксирания 20260923_002) се прилага БЕЗ грешка върху production-like state — ТОВА Е ROOT CAUSE РЕГРЕСИЯТА', async () => {
    const result = await ensureServerDatabaseReady({
      serverRootOverride: rootDir,
      databaseFilePathOverride: dbPath,
    })
    assert(result.appliedCount === allRealFiles.length - preIncidentFiles.length, `очакваше ${allRealFiles.length - preIncidentFiles.length} нови приложени миграции, получи ${result.appliedCount}`)
  })

  await check('[VERIFY] Hidden historical редът е НЕПОКЪТНАТ след migration-а (никакъв data cleanup/mutation)', () => {
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
    try {
      const row = db.prepare(`SELECT status, hidden_at FROM coin_purchase_ledger WHERE purchase_id = 'purchase-historical-hidden'`).get() as { status: string; hidden_at: string | null } | undefined
      assert(row !== undefined, 'historical hidden редът трябва да съществува все още')
      assert(row?.status === 'pending', `статусът не трябва да е променен: ${row?.status}`)
      assert(row?.hidden_at === '2026-08-01 12:00:00', `hidden_at не трябва да е променен: ${row?.hidden_at}`)
    } finally {
      db.close()
    }
  })

  await check('[VERIFY] Active pending редът е непокътнат', () => {
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
    try {
      const row = db.prepare(`SELECT status, hidden_at FROM coin_purchase_ledger WHERE purchase_id = 'purchase-active'`).get() as { status: string; hidden_at: string | null } | undefined
      assert(row !== undefined, 'active pending редът трябва да съществува')
      assert(row?.status === 'pending', `статусът не трябва да е променен: ${row?.status}`)
      assert(row?.hidden_at === null, `hidden_at трябва да остане NULL: ${row?.hidden_at}`)
    } finally {
      db.close()
    }
  })

  await check('[VERIFY] Нов duplicate ACTIVE pending за същия payer/package СЕГА се блокира от fix-натия index (guard работи)', () => {
    const db = new DatabaseSync(dbPath, { open: true })
    try {
      let threw = false
      try {
        db.prepare(`
          INSERT INTO coin_purchase_ledger (
            purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
            yellow_coins_amount, price_cents, currency, provider, status
          ) VALUES ('purchase-dup-active', ?, ?, 'coin-package-mini', 'Mini Pack', 100, 199, 'EUR', 'stripe', 'pending')
        `).run(PAYER_ID, PACKAGE_ID)
      } catch {
        threw = true
      }
      assert(threw, 'дублиращ active pending ред за същия payer/package ТРЯБВА да бъде отхвърлен от UNIQUE constraint')
    } finally {
      db.close()
    }
  })

  await check('[VERIFY] Друг hidden pending ред за същия payer/package все още е ПОЗВОЛЕН (hidden редовете не участват в constraint-а)', () => {
    const db = new DatabaseSync(dbPath, { open: true })
    try {
      let ok = true
      try {
        db.prepare(`
          INSERT INTO coin_purchase_ledger (
            purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
            yellow_coins_amount, price_cents, currency, provider, status, hidden_at
          ) VALUES ('purchase-second-hidden', ?, ?, 'coin-package-mini', 'Mini Pack', 100, 199, 'EUR', 'stripe', 'pending', CURRENT_TIMESTAMP)
        `).run(PAYER_ID, PACKAGE_ID)
      } catch {
        ok = false
      }
      assert(ok, 'втори hidden pending ред трябва да е позволен (hidden редовете извън partial index-а)')
    } finally {
      db.close()
    }
  })

  await check('[VERIFY] Idempotent повторно прилагане не хвърля грешка', async () => {
    const result = await ensureServerDatabaseReady({
      serverRootOverride: rootDir,
      databaseFilePathOverride: dbPath,
    })
    assert(result.skippedCount === allRealFiles.length, `втория run трябва да skip-не всички ${allRealFiles.length} миграции, skip-на ${result.skippedCount}`)
  })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
