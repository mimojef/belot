/**
 * checkGiftPendingUniqueIndexNullSemantics.ts
 *
 * Review finding §2 — raw DB regression за SQLite UNIQUE index NULL
 * semantics върху idx_coin_purchase_ledger_pending_package (mirror-нато за
 * vip/bundle). Тества директно чрез raw SQL INSERT (заобикаля
 * createPendingPurchase()'s application-level "reuse" guard), за да докаже
 * какво точно DB constraint-ът САМ ПО СЕБЕ СИ позволява/забранява —
 * application-level логиката е отделен defense layer, тестван другаде
 * (checkPaidGiftShopStores.ts [E2]-[E4]).
 *
 * Файлът съдържа ДВЕ секции:
 *  A) "BEFORE" — доказва проблема с оригиналната (plain column) UNIQUE
 *     index дефиниция: DB-level constraint САМ ПО СЕБЕ СИ НЕ хваща
 *     дублиращи NORMAL (recipient_profile_id IS NULL) pending редове,
 *     защото SQLite третира NULL != NULL за UNIQUE цели.
 *  B) "AFTER" — потвърждава fix-а (expression index с
 *     COALESCE(recipient_profile_id, profile_id) вместо plain
 *     recipient_profile_id колона) хваща duplicate normal pending redовете
 *     ДИРЕКТНО на DB ниво, docато пази всички останали разрешени
 *     комбинации (различни recipients, normal+gift edge cases).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqualNum(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${actual}, expected ${expected}`)
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-pending-unique-null-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

function buildLedgerTable(db: DatabaseSync, indexSql: string): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE coin_purchase_ledger (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      package_id TEXT,
      recipient_profile_id TEXT NULL REFERENCES profiles(profile_id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );
  `)
  db.exec(indexSql)
}

function seed(db: DatabaseSync, id: string): void {
  db.prepare(`INSERT INTO profiles (profile_id, display_name) VALUES (?, ?)`).run(id, id)
}

function insertPending(db: DatabaseSync, payer: string, pkg: string, recipient: string | null): { ok: boolean; error?: string } {
  try {
    db.prepare(`
      INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, recipient_profile_id, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(`p-${Math.random().toString(36).slice(2)}`, payer, pkg, recipient)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ═══ A) BEFORE — оригиналната (plain column) index дефиниция ═════════════

const PLAIN_COLUMN_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_coin_purchase_ledger_pending_package
    ON coin_purchase_ledger(profile_id, package_id, recipient_profile_id, status)
    WHERE status = 'pending' AND package_id IS NOT NULL;
`

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'before-fix.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildLedgerTable(db, PLAIN_COLUMN_INDEX_SQL)
  seed(db, 'payer-1')

  check('[BEFORE] plain-column index: две еднакви NORMAL pending (recipient NULL) — DB constraint НЕ ги спира (доказва finding §2)', () => {
    const r1 = insertPending(db, 'payer-1', 'pkg-x', null)
    const r2 = insertPending(db, 'payer-1', 'pkg-x', null)
    assert(r1.ok, `първи INSERT трябва да успее: ${r1.error}`)
    assert(r2.ok, `ВТОРИ INSERT (duplicate normal, recipient=NULL) МИНАВА raw с plain-column index — потвърждава проблема: ${r2.error ?? 'unexpectedly blocked'}`)
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM coin_purchase_ledger WHERE profile_id='payer-1' AND package_id='pkg-x' AND recipient_profile_id IS NULL AND status='pending'`).get() as { c: number }).c
    assertEqualNum(count, 2, 'plain-column index НАИСТИНА позволява 2 нормални pending redовете')
  })

  db.close()
})

// ═══ B) AFTER — fix: expression index с COALESCE(recipient_profile_id, profile_id) ═══
// COALESCE нормализира NULL recipient към PAYER-а самия (семантично точно:
// normal purchase === payer е "своя собствен recipient"), значи ВСЯКА
// стойност в композицията вече е non-NULL и участва в UNIQUE comparison
// нормално — SQLite НЕ third expression-index стойности различно от plain
// column стойности; веднъж "материализирани" през COALESCE, те следват
// обичайната UNIQUE семантика (non-NULL == non-NULL се сравнява).

const COALESCE_EXPRESSION_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_coin_purchase_ledger_pending_package
    ON coin_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
    WHERE status = 'pending' AND package_id IS NOT NULL;
`

await withTempDir(async (dir) => {
  const dbPath = join(dir, 'after-fix.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  buildLedgerTable(db, COALESCE_EXPRESSION_INDEX_SQL)
  seed(db, 'payer-1')
  seed(db, 'recipient-a')
  seed(db, 'recipient-b')

  check('[AFTER-1] COALESCE expression index: duplicate NORMAL pending (recipient NULL) — ХВАНАТ от DB constraint', () => {
    const r1 = insertPending(db, 'payer-1', 'pkg-x', null)
    const r2 = insertPending(db, 'payer-1', 'pkg-x', null)
    assert(r1.ok, `първи INSERT трябва да успее: ${r1.error}`)
    assert(!r2.ok, 'ВТОРИ duplicate normal INSERT ТРЯБВА да бъде отхвърлен от UNIQUE constraint СЛЕД fix-а')
    assert((r2.error ?? '').includes('UNIQUE'), `грешката трябва да е UNIQUE constraint violation: ${r2.error}`)
  })

  check('[AFTER-2] duplicate SAME-RECIPIENT gift pending — все още ХВАНАТ', () => {
    const r1 = insertPending(db, 'payer-1', 'pkg-y', 'recipient-a')
    const r2 = insertPending(db, 'payer-1', 'pkg-y', 'recipient-a')
    assert(r1.ok, `първи gift INSERT трябва да успее: ${r1.error}`)
    assert(!r2.ok, 'duplicate gift (same recipient) ТРЯБВА да бъде отхвърлен')
  })

  check('[AFTER-3] gift към ДВА различни recipients — все още ПОЗВОЛЕНО', () => {
    const r1 = insertPending(db, 'payer-1', 'pkg-z', 'recipient-a')
    const r2 = insertPending(db, 'payer-1', 'pkg-z', 'recipient-b')
    assert(r1.ok, `gift-за-A трябва да успее: ${r1.error}`)
    assert(r2.ok, `gift-за-B трябва да успее (различен recipient): ${r2.error}`)
  })

  check('[AFTER-4] NORMAL + GIFT за същия package — все още ПОЗВОЛЕНО (различни effective recipients)', () => {
    const r1 = insertPending(db, 'payer-1', 'pkg-w', null)
    const r2 = insertPending(db, 'payer-1', 'pkg-w', 'recipient-a')
    assert(r1.ok, `normal трябва да успее: ${r1.error}`)
    assert(r2.ok, `gift трябва да успее (различен recipient контекст от normal): ${r2.error}`)
  })

  check('[AFTER-5] edge case: gift КЪМ payer-а самия (recipient_profile_id === profile_id, hypothetically) vs normal purchase — КОЛИЗИРАТ (очаквано, семантично идентични: и двата ефективно credit-ват payer-а)', () => {
    // Този ред е чисто DB-level demonstration (self-gift вече е блокиран на
    // application ниво в createPendingPurchase — виж checkPaidGiftShopStores
    // [C0]). На DB ниво обаче COALESCE(recipient_profile_id, profile_id) за
    // recipient_profile_id='payer-1' дава СЪЩАТА ефективна стойност като
    // NULL (='payer-1'), затова двата биха колизирали тук — коректно, защото
    // и двата биха credit-нали payer-a, ако някога такъв ред стигнеше дотук.
    const r1 = insertPending(db, 'payer-1', 'pkg-v', null)
    const r2 = insertPending(db, 'payer-1', 'pkg-v', 'payer-1')
    assert(r1.ok, `normal трябва да успее: ${r1.error}`)
    assert(!r2.ok, 'self-recipient="payer-1" колизира със normal (recipient=NULL) — И ДВЕТЕ ефективно сочат към payer-a, коректно поведение на DB ниво')
  })

  db.close()
})

// ═══ C) PRODUCTION INCIDENT REGRESSION — hidden_at IS NULL predicate ═════
//
// Production deploy failure (2026-09-24, rollback-нат): 20260923_002 бе
// изпуснала established `hidden_at IS NULL` predicate при пресъздаването на
// idx_coin_purchase_ledger_pending_package (установен в
// 20260626_002_fix_pending_package_index_for_hidden.sql — "скрит pending ред
// не бива да блокира ново купуване на същия пакет"). Реален production
// сценарий: profile_id=55f576db-e308-4c61-b05d-9bea82e48796,
// package_id=coin-package-mini, 2 pending реда (единия hidden) — CREATE
// UNIQUE INDEX се блъсва в "UNIQUE constraint failed", migration транзакцията
// се rollback-ва, startup хвърля грешка.
//
// bundle_purchase_ledger носи същата hidden_at колона и същия
// hidePurchaseForUser() feature (bundlePurchaseStore.ts) от създаването си
// (20260923_001) — mirror на coin, затова същия predicate е established и
// там. vip_purchase_ledger НЯМА hidden_at колона/feature изобщо (виж
// коментара в 20260818_007_create_vip_purchase_ledger.sql) — тестваме, че
// COALESCE fix-ът за VIP работи и БЕЗ hidden_at predicate.

function buildLedgerTableWithHidden(db: DatabaseSync, tableName: string, indexSql: string): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE ${tableName} (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      package_id TEXT,
      recipient_profile_id TEXT NULL REFERENCES profiles(profile_id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      hidden_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );
  `)
  db.exec(indexSql)
}

function insertPendingWithHidden(
  db: DatabaseSync,
  tableName: string,
  payer: string,
  pkg: string,
  recipient: string | null,
  hiddenAt: string | null,
): { ok: boolean; error?: string } {
  try {
    db.prepare(`
      INSERT INTO ${tableName} (purchase_id, profile_id, package_id, recipient_profile_id, status, hidden_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(`p-${Math.random().toString(36).slice(2)}`, payer, pkg, recipient, hiddenAt)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const FIXED_COIN_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_coin_purchase_ledger_pending_package
    ON coin_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
    WHERE status = 'pending' AND package_id IS NOT NULL AND hidden_at IS NULL;
`

const FIXED_BUNDLE_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_bundle_purchase_ledger_pending_package
    ON bundle_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
    WHERE status = 'pending' AND hidden_at IS NULL;
`

const FIXED_VIP_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_vip_purchase_ledger_pending_package
    ON vip_purchase_ledger(profile_id, package_id, COALESCE(recipient_profile_id, profile_id), status)
    WHERE status = 'pending';
`

for (const spec of [
  { table: 'coin_purchase_ledger', indexSql: FIXED_COIN_INDEX_SQL, label: 'COIN' },
  { table: 'bundle_purchase_ledger', indexSql: FIXED_BUNDLE_INDEX_SQL, label: 'BUNDLE' },
] as const) {
  await withTempDir(async (dir) => {
    const dbPath = join(dir, `${spec.table}-hidden-fix.sqlite`)
    const db = new DatabaseSync(dbPath, { open: true })
    buildLedgerTableWithHidden(db, spec.table, spec.indexSql)
    seed(db, 'payer-1')
    seed(db, 'payer-2')
    seed(db, 'payer-3')
    seed(db, 'payer-4')
    seed(db, 'payer-5')
    seed(db, 'payer-6')
    seed(db, 'recipient-a')
    seed(db, 'recipient-b')

    check(`[${spec.label}-HIDDEN-1] production сценарий: hidden историческ pending + нов active pending (и двата normal, recipient=NULL) — ПОЗВОЛЕНО (hidden не блокира)`, () => {
      const historical = insertPendingWithHidden(db, spec.table, 'payer-1', 'coin-package-mini', null, '2026-01-01 00:00:00')
      const active = insertPendingWithHidden(db, spec.table, 'payer-1', 'coin-package-mini', null, null)
      assert(historical.ok, `hidden historical INSERT трябва да успее: ${historical.error}`)
      assert(active.ok, `нов active INSERT ТРЯБВА да успее въпреки hidden historical реда (production incident fix): ${active.error}`)
    })

    check(`[${spec.label}-HIDDEN-2] duplicate ACTIVE normal pending (и двата hidden_at=NULL) — все още ХВАНАТ`, () => {
      const r1 = insertPendingWithHidden(db, spec.table, 'payer-2', 'pkg-dup', null, null)
      const r2 = insertPendingWithHidden(db, spec.table, 'payer-2', 'pkg-dup', null, null)
      assert(r1.ok, `първи active INSERT трябва да успее: ${r1.error}`)
      assert(!r2.ok, 'втори active normal INSERT за същия payer/package ТРЯБВА да бъде отхвърлен')
    })

    check(`[${spec.label}-HIDDEN-3] duplicate ACTIVE same-recipient gift pending (и двата hidden_at=NULL) — все още ХВАНАТ`, () => {
      const r1 = insertPendingWithHidden(db, spec.table, 'payer-3', 'pkg-gift', 'recipient-a', null)
      const r2 = insertPendingWithHidden(db, spec.table, 'payer-3', 'pkg-gift', 'recipient-a', null)
      assert(r1.ok, `първи gift INSERT трябва да успее: ${r1.error}`)
      assert(!r2.ok, 'втори active gift INSERT (същия recipient) ТРЯБВА да бъде отхвърлен')
    })

    check(`[${spec.label}-HIDDEN-4] NORMAL + GIFT (и двата active) за същия package — ПОЗВОЛЕНО`, () => {
      const r1 = insertPendingWithHidden(db, spec.table, 'payer-4', 'pkg-mix', null, null)
      const r2 = insertPendingWithHidden(db, spec.table, 'payer-4', 'pkg-mix', 'recipient-a', null)
      assert(r1.ok, `normal трябва да успее: ${r1.error}`)
      assert(r2.ok, `gift трябва да успее (различен effective recipient): ${r2.error}`)
    })

    check(`[${spec.label}-HIDDEN-5] gift към различни recipients (и двата active) — ПОЗВОЛЕНО`, () => {
      const r1 = insertPendingWithHidden(db, spec.table, 'payer-5', 'pkg-multi', 'recipient-a', null)
      const r2 = insertPendingWithHidden(db, spec.table, 'payer-5', 'pkg-multi', 'recipient-b', null)
      assert(r1.ok, `gift-за-A трябва да успее: ${r1.error}`)
      assert(r2.ok, `gift-за-B трябва да успее (различен recipient): ${r2.error}`)
    })

    check(`[${spec.label}-HIDDEN-6] два hidden реда за същия payer/package — ПОЗВОЛЕНО (hidden редовете не участват в partial index-а изобщо)`, () => {
      const r1 = insertPendingWithHidden(db, spec.table, 'payer-6', 'pkg-multi-hidden', null, '2026-01-01 00:00:00')
      const r2 = insertPendingWithHidden(db, spec.table, 'payer-6', 'pkg-multi-hidden', null, '2026-01-02 00:00:00')
      assert(r1.ok, `първи hidden INSERT трябва да успее: ${r1.error}`)
      assert(r2.ok, `втори hidden INSERT трябва да успее (hidden редовете извън partial index-а): ${r2.error}`)
    })

    db.close()
  })
}

// VIP: без hidden_at колона/feature — потвърждаваме COALESCE fix-ът работи
// самостоятелно (established семантика, БЕЗ hidden_at predicate).
await withTempDir(async (dir) => {
  const dbPath = join(dir, 'vip-no-hidden.sqlite')
  const db = new DatabaseSync(dbPath, { open: true })
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE vip_purchase_ledger (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      package_id TEXT,
      recipient_profile_id TEXT NULL REFERENCES profiles(profile_id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );
  `)
  db.exec(FIXED_VIP_INDEX_SQL)
  seed(db, 'payer-1')
  seed(db, 'recipient-a')

  check('[VIP-NO-HIDDEN-1] duplicate normal pending — ХВАНАТ (без hidden_at concept)', () => {
    const r1 = db.prepare(`INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, recipient_profile_id, status) VALUES (?, ?, ?, ?, 'pending')`)
    let ok1 = true, ok2 = true, err2 = ''
    try { r1.run('vp-1', 'payer-1', 'vip_30', null) } catch { ok1 = false }
    try { r1.run('vp-2', 'payer-1', 'vip_30', null) } catch (err) { ok2 = false; err2 = err instanceof Error ? err.message : String(err) }
    assert(ok1, 'първи INSERT трябва да успее')
    assert(!ok2, `дублиращ INSERT ТРЯБВА да бъде отхвърлен: ${err2 || 'unexpectedly succeeded'}`)
  })

  check('[VIP-NO-HIDDEN-2] normal + gift за същия package — ПОЗВОЛЕНО', () => {
    const stmt = db.prepare(`INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, recipient_profile_id, status) VALUES (?, ?, ?, ?, 'pending')`)
    let ok1 = true, ok2 = true
    try { stmt.run('vp-3', 'payer-1', 'vip_180', null) } catch { ok1 = false }
    try { stmt.run('vp-4', 'payer-1', 'vip_180', 'recipient-a') } catch { ok2 = false }
    assert(ok1, 'normal трябва да успее')
    assert(ok2, 'gift трябва да успее')
  })

  db.close()
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
