/**
 * checkGiftRecipientMigration.ts
 *
 * Smoke test за 20260923_002_add_gift_recipient_to_purchase_ledgers.sql —
 * потвърждава, че цялата migration verига (от нулева temp DB) прилага
 * чисто върху реалната текуща схема на coin_purchase_ledger/
 * vip_purchase_ledger/bundle_purchase_ledger, включително DROP+CREATE на
 * трите "pending package" UNIQUE index-а. НЕ пипа production DB — работи
 * изцяло върху temp файл (databaseFilePathOverride), reuse-вайки реалния
 * migrations directory (serverRootOverride) само за READ на .sql файловете.
 */

import { mkdtemp, rm } from 'node:fs/promises'
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
  const dir = await mkdtemp(join(tmpdir(), 'belot-gift-migration-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'belot-v2.sqlite')

  await check('[M0] Пълната migration верига (от нула) прилага без грешка', async () => {
    const result = await ensureServerDatabaseReady({
      serverRootOverride: process.cwd(),
      databaseFilePathOverride: dbPath,
    })
    assert(result.appliedCount > 0, 'трябва да е приложила поне 1 миграция')
  })

  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })

  await check('[M1] coin_purchase_ledger.recipient_profile_id колона съществува', () => {
    const cols = db.prepare(`PRAGMA table_info(coin_purchase_ledger)`).all() as Array<{ name: string }>
    assert(cols.some((c) => c.name === 'recipient_profile_id'), 'липсва recipient_profile_id')
    assert(cols.some((c) => c.name === 'recipient_display_name_snapshot'), 'липсва recipient_display_name_snapshot')
  })

  await check('[M2] vip_purchase_ledger.recipient_profile_id колона съществува', () => {
    const cols = db.prepare(`PRAGMA table_info(vip_purchase_ledger)`).all() as Array<{ name: string }>
    assert(cols.some((c) => c.name === 'recipient_profile_id'), 'липсва recipient_profile_id')
  })

  await check('[M3] bundle_purchase_ledger.recipient_profile_id колона съществува', () => {
    const cols = db.prepare(`PRAGMA table_info(bundle_purchase_ledger)`).all() as Array<{ name: string }>
    assert(cols.some((c) => c.name === 'recipient_profile_id'), 'липсва recipient_profile_id')
  })

  // Review finding §2 fix — индексите вече са EXPRESSION indexes
  // (COALESCE(recipient_profile_id, profile_id)), не plain column reference.
  // PRAGMA index_info() показва expression columns с name=NULL (SQLite не
  // разкрива expression текста през тази PRAGMA), затова проверяваме
  // директно през sqlite_master.sql текста — по-точен verification за
  // expression indexes. Виж checkGiftPendingUniqueIndexNullSemantics.ts за
  // dedicated behavioral доказателство (before/after duplicate-insert тест).
  await check('[M4] idx_coin_purchase_ledger_pending_package е COALESCE expression index (не plain column)', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_coin_purchase_ledger_pending_package'`).get() as { sql: string } | undefined
    assert(row !== undefined, 'индексът трябва да съществува')
    assert(!!row && row.sql.includes('COALESCE(recipient_profile_id, profile_id)'), `индексът трябва да използва COALESCE(recipient_profile_id, profile_id): ${row?.sql}`)
  })

  await check('[M5] idx_vip_purchase_ledger_pending_package е COALESCE expression index (не plain column)', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_vip_purchase_ledger_pending_package'`).get() as { sql: string } | undefined
    assert(row !== undefined, 'индексът трябва да съществува')
    assert(!!row && row.sql.includes('COALESCE(recipient_profile_id, profile_id)'), `индексът трябва да използва COALESCE(recipient_profile_id, profile_id): ${row?.sql}`)
  })

  await check('[M6] idx_bundle_purchase_ledger_pending_package е COALESCE expression index (не plain column)', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_bundle_purchase_ledger_pending_package'`).get() as { sql: string } | undefined
    assert(row !== undefined, 'индексът трябва да съществува')
    assert(!!row && row.sql.includes('COALESCE(recipient_profile_id, profile_id)'), `индексът трябва да използва COALESCE(recipient_profile_id, profile_id): ${row?.sql}`)
  })

  // Production incident regression (2026-09-24): _002 бе изпуснала established
  // hidden_at IS NULL predicate-и при пресъздаването на coin/bundle
  // индексите — виж checkGiftPendingUniqueIndexNullSemantics.ts за пълния
  // behavioral regression test. Тук потвърждаваме само, че финалната schema
  // (след ЦЯЛАТА migration верига, вкл. 20260923_004-ия bundle rebuild) носи
  // предиката правилно.
  await check('[M8] idx_coin_purchase_ledger_pending_package пази established hidden_at IS NULL predicate', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_coin_purchase_ledger_pending_package'`).get() as { sql: string } | undefined
    assert(row !== undefined, 'индексът трябва да съществува')
    assert(!!row && row.sql.includes('hidden_at IS NULL'), `coin индексът трябва да пази hidden_at IS NULL (production incident fix): ${row?.sql}`)
  })

  await check('[M9] idx_bundle_purchase_ledger_pending_package пази hidden_at IS NULL predicate след 20260923_004 rebuild', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_bundle_purchase_ledger_pending_package'`).get() as { sql: string } | undefined
    assert(row !== undefined, 'индексът трябва да съществува')
    assert(!!row && row.sql.includes('hidden_at IS NULL'), `bundle индексът трябва да пази hidden_at IS NULL след 20260923_004 rebuild-а: ${row?.sql}`)
  })

  await check('[M10] idx_vip_purchase_ledger_pending_package НЯМА hidden_at predicate (VIP няма hide-purchase feature)', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_vip_purchase_ledger_pending_package'`).get() as { sql: string } | undefined
    assert(row !== undefined, 'индексът трябва да съществува')
    assert(!!row && !row.sql.includes('hidden_at'), `VIP индексът НЕ трябва да реферира hidden_at (VIP таблицата няма тази колона): ${row?.sql}`)
  })

  await check('[M7] Повторно прилагане (idempotent) не хвърля грешка', async () => {
    const result = await ensureServerDatabaseReady({
      serverRootOverride: process.cwd(),
      databaseFilePathOverride: dbPath,
    })
    assert(result.skippedCount > 0, 'втория run трябва да skip-не вече приложените миграции')
  })

  db.close()
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
