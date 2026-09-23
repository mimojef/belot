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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
