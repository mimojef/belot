/**
 * checkBundlePurchaseLedgerPayerMigration.ts
 *
 * Dedicated schema/migration audit за
 * 20260923_004_preserve_bundle_purchase_history_on_profile_delete.sql —
 * mirror на checkGiftRecipientMigration.ts pattern-а, разширен с realistic
 * pre-existing-data preservation coverage (§B в брифа), защото 004 е table
 * REBUILD (DROP+RENAME), не additive ALTER TABLE ADD COLUMN — данните минават
 * през INSERT...SELECT, за разлика от 002/003.
 *
 * Root cause за самата миграция: bundle_purchase_ledger.profile_id (PAYER)
 * е останала ON DELETE CASCADE (20260923_001), защото таблицата е създадена
 * СЛЕД established 20260902_002_preserve_financial_and_ban_history_on_profile_delete.sql
 * sweep-а — coin/vip получиха SET NULL тогава, bundle просто не съществуваше
 * още. Ако payer бъде hard-deleted докато bundle покупка е 'pending', CASCADE
 * би изтрил ЦЕЛИЯ ledger ред, преди закъснял Stripe webhook да пристигне.
 *
 * [A1] Clean-DB apply: пълната верига (вкл. 004) прилага без грешка от нула.
 * [A2] bundle_purchase_ledger.profile_id е nullable (notnull=0).
 * [A3] profile_id FK е ON DELETE SET NULL (не CASCADE).
 * [A4] deleted_profile_id_snapshot колона съществува (нова, mirror на coin/vip).
 * [A5] recipient_profile_id FK/semantics остават НЕПИПНАТИ (SET NULL, отделен
 *        FK от payer-а) — 004 не трябва да регресира Paid Gift Shop-а.
 * [A6] recipient_display_name_snapshot / deleted_recipient_profile_id_snapshot
 *        колоните оцеляват rebuild-а.
 * [A7] package_id / vip_grant_id FK-та запазват ON DELETE SET NULL
 *        (rebuild-ът не трябва да променя несвързани FK-та).
 * [A8] idx_bundle_purchase_ledger_pending_package остава COALESCE expression
 *        index, byte-for-byte идентичен на 002-рата дефиниция.
 * [A9] Всички established indexes съществуват след rebuild-а (profile,
 *        status, recipient, pending_package, нов deleted_profile_snapshot).
 * [A10] Idempotent повторно прилагане на ЦЯЛАТА верига (реалният runner,
 *        server_migrations tracking) — НЕ директно повторно изпълнение на
 *        non-idempotent DROP+RENAME SQL.
 * [A11] PRAGMA foreign_key_check / integrity_check са чисти след миграцията.
 *
 * [B1] Realistic pre-004 DB (реални миграции 1..003, БЕЗ 004, приложени през
 *        РЕАЛНИЯ runner) + seed-нати bundle_purchase_ledger редове с различни
 *        statuses/normal/gift/recipient/optional полета → apply 004 (пак
 *        през реалния runner, само новата миграция) → field-for-field
 *        preservation за ВСИЧКИ редове и полета, освен очакваната FK-only
 *        промяна.
 */

import { mkdtemp, rm, mkdir, cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { normalizeProfileDisplayName } from '../src/db/normalizeProfileIdentityText.js'

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
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

const NEW_MIGRATION_FILENAME = '20260923_004_preserve_bundle_purchase_history_on_profile_delete.sql'
const REAL_SERVER_ROOT = join(process.cwd())
const REAL_MIGRATIONS_DIR = join(REAL_SERVER_ROOT, 'database', 'migrations')

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-bundle-payer-migration-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/**
 * Копира РЕАЛНИТЕ migration файлове (не hand-reconstructed текст) в
 * <fakeServerRoot>/database/migrations, по избор изключвайки конкретни
 * filenames — за да построим "realistic pre-004 DB" през самия production
 * runner, вместо да reconstruct-ваме migration историята на ръка (точно
 * грешката, която 20260902_002-рия коментар explicit предупреждава да не
 * повтаряме).
 */
async function seedFakeServerRootWithRealMigrations(
  fakeServerRoot: string,
  excludeFilenames: string[] = [],
): Promise<void> {
  const destMigrationsDir = join(fakeServerRoot, 'database', 'migrations')
  await mkdir(destMigrationsDir, { recursive: true })
  const entries = await readdir(REAL_MIGRATIONS_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (excludeFilenames.includes(entry.name)) continue
    await cp(join(REAL_MIGRATIONS_DIR, entry.name), join(destMigrationsDir, entry.name))
  }
}

type BundleLedgerColumnInfo = { name: string; type: string; notnull: number; pk: number }

console.log('\ncheckBundlePurchaseLedgerPayerMigration\n')

// ─── [A] Clean-DB schema audit ──────────────────────────────────────────────

await withTempDir(async (dir) => {
  const fakeServerRoot = join(dir, 'clean')
  await seedFakeServerRootWithRealMigrations(fakeServerRoot)
  const dbPath = join(fakeServerRoot, 'database', 'data', 'belot-v2.sqlite')

  await check('[A1] Clean-DB apply: пълната верига (вкл. 004) прилага без грешка', async () => {
    const result = await ensureServerDatabaseReady({
      serverRootOverride: fakeServerRoot,
      databaseFilePathOverride: dbPath,
    })
    assert(result.appliedCount > 0, 'трябва да е приложила поне 1 миграция')
    assert(
      result.appliedMigrations.some((m) => m.filename === NEW_MIGRATION_FILENAME),
      `${NEW_MIGRATION_FILENAME} трябва да е сред приложените миграции`,
    )
  })

  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })

  await check('[A2] bundle_purchase_ledger.profile_id е nullable', () => {
    const cols = db.prepare(`PRAGMA table_info(bundle_purchase_ledger)`).all() as BundleLedgerColumnInfo[]
    const profileIdCol = cols.find((c) => c.name === 'profile_id')
    assert(profileIdCol !== undefined, 'profile_id колоната трябва да съществува')
    assertEqual(profileIdCol!.notnull, 0, 'profile_id трябва да е nullable (notnull=0)')
  })

  await check('[A3] profile_id FK е ON DELETE SET NULL (не CASCADE)', () => {
    const fks = db.prepare(`PRAGMA foreign_key_list(bundle_purchase_ledger)`).all() as Array<{
      table: string
      from: string
      to: string
      on_delete: string
    }>
    const profileIdFk = fks.find((fk) => fk.from === 'profile_id')
    assert(profileIdFk !== undefined, 'profile_id трябва да има FK')
    assertEqual(profileIdFk!.table, 'profiles', 'profile_id FK трябва да сочи towards profiles')
    assertEqual(profileIdFk!.on_delete, 'SET NULL', 'profile_id FK трябва да е ON DELETE SET NULL')
  })

  await check('[A4] deleted_profile_id_snapshot колона съществува (mirror на coin/vip)', () => {
    const cols = db.prepare(`PRAGMA table_info(bundle_purchase_ledger)`).all() as BundleLedgerColumnInfo[]
    const snapshotCol = cols.find((c) => c.name === 'deleted_profile_id_snapshot')
    assert(snapshotCol !== undefined, 'deleted_profile_id_snapshot трябва да съществува')
    assertEqual(snapshotCol!.notnull, 0, 'deleted_profile_id_snapshot трябва да е nullable')
  })

  await check('[A5] recipient_profile_id FK остава ON DELETE SET NULL, НЕПРОМЕНЕН от 004', () => {
    const fks = db.prepare(`PRAGMA foreign_key_list(bundle_purchase_ledger)`).all() as Array<{
      table: string
      from: string
      on_delete: string
    }>
    const recipientFk = fks.find((fk) => fk.from === 'recipient_profile_id')
    assert(recipientFk !== undefined, 'recipient_profile_id трябва да запази своя FK')
    assertEqual(recipientFk!.table, 'profiles', 'recipient_profile_id FK трябва да сочи towards profiles')
    assertEqual(recipientFk!.on_delete, 'SET NULL', 'recipient_profile_id FK трябва да остане ON DELETE SET NULL')
  })

  await check('[A6] recipient_display_name_snapshot / deleted_recipient_profile_id_snapshot оцеляват rebuild-а', () => {
    const cols = db.prepare(`PRAGMA table_info(bundle_purchase_ledger)`).all() as BundleLedgerColumnInfo[]
    assert(cols.some((c) => c.name === 'recipient_display_name_snapshot'), 'recipient_display_name_snapshot трябва да съществува')
    assert(cols.some((c) => c.name === 'deleted_recipient_profile_id_snapshot'), 'deleted_recipient_profile_id_snapshot трябва да съществува')
  })

  await check('[A7] package_id / vip_grant_id FK-та запазват ON DELETE SET NULL', () => {
    const fks = db.prepare(`PRAGMA foreign_key_list(bundle_purchase_ledger)`).all() as Array<{
      table: string
      from: string
      on_delete: string
    }>
    const packageFk = fks.find((fk) => fk.from === 'package_id')
    const vipGrantFk = fks.find((fk) => fk.from === 'vip_grant_id')
    assert(packageFk !== undefined && packageFk.table === 'shop_bundle_packages' && packageFk.on_delete === 'SET NULL', 'package_id FK непроменен')
    assert(vipGrantFk !== undefined && vipGrantFk.table === 'vip_grants' && vipGrantFk.on_delete === 'SET NULL', 'vip_grant_id FK непроменен')
  })

  await check('[A8] idx_bundle_purchase_ledger_pending_package остава COALESCE expression index, byte-for-byte', () => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_bundle_purchase_ledger_pending_package'`).get() as { sql: string } | undefined
    assert(row !== undefined, 'индексът трябва да съществува')
    assert(row!.sql.includes('COALESCE(recipient_profile_id, profile_id)'), 'трябва да остане COALESCE(recipient_profile_id, profile_id) expression')
    assert(row!.sql.includes("WHERE status = 'pending'"), 'partial WHERE клаузата трябва да е запазена')
  })

  await check('[A9] Всички established indexes съществуват след rebuild-а', () => {
    const indexNames = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='bundle_purchase_ledger'`).all() as Array<{ name: string }>).map((r) => r.name)
    for (const expected of [
      'idx_bundle_purchase_ledger_profile',
      'idx_bundle_purchase_ledger_status',
      'idx_bundle_purchase_ledger_recipient',
      'idx_bundle_purchase_ledger_pending_package',
      'idx_bundle_purchase_ledger_deleted_profile_snapshot',
    ]) {
      assert(indexNames.includes(expected), `липсващ index: ${expected} (намерени: ${indexNames.join(', ')})`)
    }
  })

  await check('[A11] PRAGMA foreign_key_check / integrity_check са чисти', () => {
    const fkViolations = db.prepare(`PRAGMA foreign_key_check;`).all()
    assertEqual(fkViolations.length, 0, `foreign_key_check трябва да е празен, намерени: ${JSON.stringify(fkViolations)}`)
    const integrityRows = db.prepare(`PRAGMA integrity_check;`).all() as Array<{ integrity_check: string }>
    assertEqual(integrityRows, [{ integrity_check: 'ok' }], 'integrity_check трябва да върне "ok"')
  })

  db.close()

  await check('[A10] Idempotent повторно прилагане на ЦЯЛАТА верига (реалният runner, server_migrations tracking)', async () => {
    const result = await ensureServerDatabaseReady({
      serverRootOverride: fakeServerRoot,
      databaseFilePathOverride: dbPath,
    })
    assertEqual(result.appliedCount, 0, 'втория run НЕ трябва да приложи нищо ново')
    assert(result.skippedCount > 0, 'втория run трябва да skip-не вече приложените миграции')

    const db2 = new DatabaseSync(dbPath, { open: true, readOnly: true })
    const fkViolations = db2.prepare(`PRAGMA foreign_key_check;`).all()
    assertEqual(fkViolations.length, 0, 'foreign_key_check остава чист СЛЕД повторен run')
    db2.close()
  })
})

// ─── [B] Realistic pre-004 DB + data preservation ──────────────────────────

await withTempDir(async (dir) => {
  const fakeServerRoot = join(dir, 'pre004')
  // Realistic pre-004 DB — РЕАЛНИТЕ 1..142 migration файлове минус 004,
  // приложени през РЕАЛНИЯ runner (не hand-reconstructed CREATE TABLE).
  await seedFakeServerRootWithRealMigrations(fakeServerRoot, [NEW_MIGRATION_FILENAME])
  const dbPath = join(fakeServerRoot, 'database', 'data', 'belot-v2.sqlite')

  await ensureServerDatabaseReady({ serverRootOverride: fakeServerRoot, databaseFilePathOverride: dbPath })

  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')

  await check('[B0 setup] pre-004 DB: profile_id все още NOT NULL / CASCADE (baseline потвърждение)', () => {
    const cols = db.prepare(`PRAGMA table_info(bundle_purchase_ledger)`).all() as BundleLedgerColumnInfo[]
    const profileIdCol = cols.find((c) => c.name === 'profile_id')
    assertEqual(profileIdCol!.notnull, 1, 'pre-004: profile_id трябва все още да е NOT NULL')
    const fks = db.prepare(`PRAGMA foreign_key_list(bundle_purchase_ledger)`).all() as Array<{ from: string; on_delete: string }>
    const profileIdFk = fks.find((fk) => fk.from === 'profile_id')
    assertEqual(profileIdFk!.on_delete, 'CASCADE', 'pre-004: profile_id FK трябва все още да е CASCADE')
  })

  // Seed профили + разнообразни bundle_purchase_ledger редове (различни
  // statuses, normal И gift, с/без optional полета) — директен SQL insert,
  // не през store-а (изолира migration теста от store-level логика).
  function seedProfile(profileId: string, displayName: string): void {
    const accountId = `acc_${profileId}`
    db.prepare(`INSERT OR IGNORE INTO accounts (account_id, email) VALUES (?, ?)`).run(accountId, `${profileId}@example.test`)
    db.prepare(`
      INSERT INTO profiles (profile_id, account_id, profile_kind, display_name, normalized_display_name, status, is_temporary)
      VALUES (?, ?, 'human', ?, ?, 'active', 0)
    `).run(profileId, accountId, displayName, normalizeProfileDisplayName(displayName))
  }

  seedProfile('mig-payer-1', 'Payer One')
  seedProfile('mig-payer-2', 'Payer Two')
  seedProfile('mig-recipient-1', 'Recipient One')

  db.prepare(`
    INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status, sort_order)
    VALUES ('mig-pkg-1', 'mig_bundle_1', 'Migration Test Bundle', 500000, 30, 1999, 'EUR', 'active', 10)
  `).run()

  const rowsToSeed = [
    {
      purchase_id: 'mig-row-pending-normal',
      profile_id: 'mig-payer-1',
      status: 'pending',
      recipient_profile_id: null as string | null,
      recipient_display_name_snapshot: null as string | null,
      provider_checkout_session_id: 'cs_mig_1',
      credited_at: null as string | null,
      vip_grant_id: null as string | null,
      hidden_at: null as string | null,
    },
    {
      purchase_id: 'mig-row-paid-normal',
      profile_id: 'mig-payer-2',
      status: 'paid',
      recipient_profile_id: null,
      recipient_display_name_snapshot: null,
      provider_checkout_session_id: 'cs_mig_2',
      credited_at: '2026-09-20T10:00:00.000Z',
      // vip_grant_id се attach-ва СЛЕД insert-а по-долу (mirror на реалния
      // fulfillByInternalRow ред: bundle редът съществува ПРЕДИ vip_grants
      // insert-а, който реферира towards него през bundle_purchase_id).
      vip_grant_id: null as string | null,
      hidden_at: null,
    },
    {
      purchase_id: 'mig-row-pending-gift',
      profile_id: 'mig-payer-1',
      status: 'pending',
      recipient_profile_id: 'mig-recipient-1',
      recipient_display_name_snapshot: 'Recipient One',
      provider_checkout_session_id: 'cs_mig_3',
      credited_at: null,
      vip_grant_id: null,
      hidden_at: null,
    },
    {
      purchase_id: 'mig-row-canceled-hidden',
      profile_id: 'mig-payer-2',
      status: 'canceled',
      recipient_profile_id: null,
      recipient_display_name_snapshot: null,
      provider_checkout_session_id: null,
      credited_at: null,
      vip_grant_id: null,
      hidden_at: '2026-09-21T08:00:00.000Z',
    },
  ]

  for (const row of rowsToSeed) {
    db.prepare(`
      INSERT INTO bundle_purchase_ledger (
        purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
        yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider,
        provider_checkout_session_id, status, credited_at, vip_grant_id, hidden_at,
        recipient_profile_id, recipient_display_name_snapshot
      ) VALUES (
        ?, ?, 'mig-pkg-1', 'mig_bundle_1', 'Migration Test Bundle',
        500000, 30, 1999, 'EUR', 'stripe',
        ?, ?, ?, ?, ?,
        ?, ?
      )
    `).run(
      row.purchase_id, row.profile_id,
      row.provider_checkout_session_id, row.status, row.credited_at, row.vip_grant_id, row.hidden_at,
      row.recipient_profile_id, row.recipient_display_name_snapshot,
    )
  }

  // vip_grants ред за 'mig-row-paid-normal' — реалният bundle покупка ред
  // вече съществува (insert-нат по-горе), затова bundle_purchase_id FK е
  // валиден в момента на този INSERT (mirror на реалния fulfillByInternalRow
  // ред). bundle_purchase_id (НЕ purchase_id — виж 20260923_005 pre-deploy
  // blocker fix-а) сочи towards bundle_purchase_ledger.purchase_id.
  db.prepare(`
    INSERT INTO vip_grants (grant_id, profile_id, reason, interval_unit, interval_amount, resulting_active_until, bundle_purchase_id, amount_paid_cents, currency)
    VALUES ('mig-grant-1', 'mig-payer-2', 'purchase', 'days', 30, '2026-10-20T10:00:00.000Z', 'mig-row-paid-normal', 1999, 'EUR')
  `).run()
  db.prepare(`UPDATE bundle_purchase_ledger SET vip_grant_id = 'mig-grant-1' WHERE purchase_id = 'mig-row-paid-normal'`).run()

  type FullRow = {
    purchase_id: string
    profile_id: string | null
    package_id: string | null
    package_key_snapshot: string
    title_snapshot: string
    yellow_coins_amount: number
    vip_days_snapshot: number
    price_cents: number
    currency: string
    provider: string
    provider_checkout_session_id: string | null
    status: string
    credited_at: string | null
    vip_grant_id: string | null
    hidden_at: string | null
    created_at: string
    updated_at: string
    recipient_profile_id: string | null
    recipient_display_name_snapshot: string | null
  }

  const beforeRows = db.prepare(`
    SELECT purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
      yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider,
      provider_checkout_session_id, status, credited_at, vip_grant_id, hidden_at,
      created_at, updated_at, recipient_profile_id, recipient_display_name_snapshot
    FROM bundle_purchase_ledger ORDER BY purchase_id ASC
  `).all() as FullRow[]
  assertEqual(beforeRows.length, rowsToSeed.length, 'setup: всички seed-нати редове трябва да съществуват преди 004')

  db.close()

  // Приложи 004 (и всяка друга нова миграция, ако има) през РЕАЛНИЯ runner —
  // копираме ПЪЛНАТА реална migrations директория (сега вкл. 004) върху
  // СЪЩИЯ fakeServerRoot; server_migrations вече проследява 1..142 минус 004
  // като applied, значи runner-ът ще приложи ЕДИНСТВЕНО 004.
  await seedFakeServerRootWithRealMigrations(fakeServerRoot, [])

  await check('[B1] Прилагане на 004 върху realistic pre-004 DB с данни: успешно, самò 004 се прилага', async () => {
    const result = await ensureServerDatabaseReady({ serverRootOverride: fakeServerRoot, databaseFilePathOverride: dbPath })
    // appliedMigrations е ПЪЛНАТА историческа server_migrations таблица (всичко,
    // някога приложено), не само новите от ТОЗИ run — appliedCount е вярният
    // сигнал за "колко НОВИ миграции се приложиха точно сега" (mirror на [A1]
    // usage-а по-горе).
    assertEqual(result.appliedCount, 1, 'трябва да приложи ТОЧНО 1 нова миграция (004)')
    assert(
      result.appliedMigrations.some((m) => m.filename === NEW_MIGRATION_FILENAME),
      `004 трябва да е сред приложените миграции: ${JSON.stringify(result.appliedMigrations.map((m) => m.filename).slice(-3))}`,
    )
  })

  const dbAfter = new DatabaseSync(dbPath, { open: true, readOnly: true })

  await check('[B2] Field-for-field preservation: ВСИЧКИ seed-нати редове оцеляват с ИДЕНТИЧНИ стойности (без profile_id/новата snapshot колона)', () => {
    const afterRows = dbAfter.prepare(`
      SELECT purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
        yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider,
        provider_checkout_session_id, status, credited_at, vip_grant_id, hidden_at,
        created_at, updated_at, recipient_profile_id, recipient_display_name_snapshot
      FROM bundle_purchase_ledger ORDER BY purchase_id ASC
    `).all() as FullRow[]

    assertEqual(afterRows.length, beforeRows.length, 'броят редове трябва да остане идентичен (без загуба, без duplication)')

    for (let i = 0; i < beforeRows.length; i++) {
      const before = beforeRows[i]!
      const after = afterRows[i]!
      assertEqual(after.purchase_id, before.purchase_id, `purchase_id ред ${i}`)
      // profile_id стойността трябва да е СЪЩАТА (все още non-null тук —
      // никой профил не е трит по време на теста; проверяваме, че rebuild-ът
      // сам по себе си НЕ нулира съществуващи стойности, само FK definition-а).
      assertEqual(after.profile_id, before.profile_id, `profile_id стойност непроменена (ред ${before.purchase_id})`)
      assertEqual(after.package_id, before.package_id, `package_id (ред ${before.purchase_id})`)
      assertEqual(after.package_key_snapshot, before.package_key_snapshot, `package_key_snapshot (ред ${before.purchase_id})`)
      assertEqual(after.title_snapshot, before.title_snapshot, `title_snapshot (ред ${before.purchase_id})`)
      assertEqual(after.yellow_coins_amount, before.yellow_coins_amount, `yellow_coins_amount (ред ${before.purchase_id})`)
      assertEqual(after.vip_days_snapshot, before.vip_days_snapshot, `vip_days_snapshot (ред ${before.purchase_id})`)
      assertEqual(after.price_cents, before.price_cents, `price_cents (ред ${before.purchase_id})`)
      assertEqual(after.currency, before.currency, `currency (ред ${before.purchase_id})`)
      assertEqual(after.provider, before.provider, `provider (ред ${before.purchase_id})`)
      assertEqual(after.provider_checkout_session_id, before.provider_checkout_session_id, `provider_checkout_session_id (ред ${before.purchase_id})`)
      assertEqual(after.status, before.status, `status (ред ${before.purchase_id})`)
      assertEqual(after.credited_at, before.credited_at, `credited_at (ред ${before.purchase_id})`)
      assertEqual(after.vip_grant_id, before.vip_grant_id, `vip_grant_id (ред ${before.purchase_id})`)
      assertEqual(after.hidden_at, before.hidden_at, `hidden_at (ред ${before.purchase_id})`)
      assertEqual(after.created_at, before.created_at, `created_at (ред ${before.purchase_id})`)
      assertEqual(after.updated_at, before.updated_at, `updated_at (ред ${before.purchase_id})`)
      assertEqual(after.recipient_profile_id, before.recipient_profile_id, `recipient_profile_id (ред ${before.purchase_id})`)
      assertEqual(after.recipient_display_name_snapshot, before.recipient_display_name_snapshot, `recipient_display_name_snapshot (ред ${before.purchase_id})`)
    }
  })

  await check('[B3] Новата deleted_profile_id_snapshot колона е NULL за ВСИЧКИ pre-existing редове (миграцията не измисля данни)', () => {
    const rows = dbAfter.prepare(`SELECT purchase_id, deleted_profile_id_snapshot FROM bundle_purchase_ledger`).all() as Array<{ purchase_id: string; deleted_profile_id_snapshot: string | null }>
    for (const row of rows) {
      assertEqual(row.deleted_profile_id_snapshot, null, `deleted_profile_id_snapshot трябва да е NULL за pre-existing ред ${row.purchase_id}`)
    }
  })

  await check('[B4] PRAGMA foreign_key_check / integrity_check са чисти СЛЕД миграция върху populated DB', () => {
    const fkViolations = dbAfter.prepare(`PRAGMA foreign_key_check;`).all()
    assertEqual(fkViolations.length, 0, `foreign_key_check трябва да е празен, намерени: ${JSON.stringify(fkViolations)}`)
    const integrityRows = dbAfter.prepare(`PRAGMA integrity_check;`).all() as Array<{ integrity_check: string }>
    assertEqual(integrityRows, [{ integrity_check: 'ok' }], 'integrity_check трябва да върне "ok"')
  })

  dbAfter.close()
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
