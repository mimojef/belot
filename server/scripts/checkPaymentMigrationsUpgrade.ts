/**
 * checkPaymentMigrationsUpgrade.ts
 *
 * Съвместимост на новите платежни миграции с вече работеща база, през
 * ПРОДУКЦИОННИЯ runner (ensureServerDatabaseReady + server_migrations):
 *   20261019_001_add_hidden_at_to_vip_purchase_ledger.sql
 *   20261020_001_create_payment_review_issues.sql
 *   20261021_001_add_transient_flag_to_payment_review_issues.sql
 *
 * [1] база в състоянието ПРЕДИ тях (runner-ът прилага всички по-стари) с
 *     реални данни: VIP pending/gift pending/paid, coin paid (Meri86-подобен)
 *     + ръчна компенсация в wallet
 * [2] runner-ът прилага точно трите нови миграции
 * [3] съществуващите редове са непроменени (hidden_at = NULL), wallet непроменен
 * [4] новите индекси/колони съществуват с очакваните дефиниции
 * [5] повторно пускане на runner-а → нищо ново (идемпотентно)
 * [6] store-овете се отварят и работят върху надградената база
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, cp, rm, readdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createVipPurchaseStore } from '../src/db/vipPurchaseStore.js'
import { createPaymentReviewIssueStore } from '../src/db/paymentReviewIssueStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsSource = resolve(__dirname, '..', 'database', 'migrations')
const NEW_MIGRATIONS = [
  '20261019_001_add_hidden_at_to_vip_purchase_ledger.sql',
  '20261020_001_create_payment_review_issues.sql',
  '20261021_001_add_transient_flag_to_payment_review_issues.sql',
]

let passed = 0
let failed = 0

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'belot-payment-migrations-'))
  const migrationsDir = join(root, 'database', 'migrations')
  const dbPath = join(root, 'database', 'data', 'upgrade.sqlite')
  await mkdir(migrationsDir, { recursive: true })
  await mkdir(dirname(dbPath), { recursive: true })

  try {
    // Само по-старите миграции — „продукционното“ състояние преди deploy.
    for (const file of await readdir(migrationsSource)) {
      if (file.endsWith('.sql') && file < NEW_MIGRATIONS[0]) {
        await cp(join(migrationsSource, file), join(migrationsDir, file))
      }
    }
    await ensureServerDatabaseReady({ serverRootOverride: root, databaseFilePathOverride: dbPath })

    const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    db.exec('PRAGMA busy_timeout = 5000;')
    let snapshotBefore = ''
    try {
      await check('[1] база преди новите миграции + реални данни', () => {
        db.exec(`
          INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES ('u1', 'u1', 'u1'), ('u2', 'u2', 'u2'), ('meri', 'meri', 'meri');
          INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, provider_checkout_session_id, status)
            VALUES ('v-pending', 'u1', 'vip_30', 30, 499, 'EUR', 'cs_v1', 'pending');
          INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status, recipient_profile_id, recipient_display_name_snapshot)
            VALUES ('v-gift', 'u1', 'vip_30', 30, 499, 'EUR', 'pending', 'u2', 'u2');
          INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status, credited_at)
            VALUES ('v-paid', 'u1', 'vip_365', 365, 6989, 'EUR', 'paid', CURRENT_TIMESTAMP);
          INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
            yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status, credited_at)
            VALUES ('meri-paid', 'meri', NULL, 'elite', 'Елит', 1500000, 1699, 'EUR', 'cs_meri', 'paid', CURRENT_TIMESTAMP);
          INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES ('meri', 2250000);
        `)
        assert(!(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'payment_review_issues'`).get()), 'таблицата още не трябва да съществува')
        snapshotBefore = JSON.stringify({
          vip: db.prepare('SELECT * FROM vip_purchase_ledger ORDER BY purchase_id').all(),
          coin: db.prepare('SELECT * FROM coin_purchase_ledger ORDER BY purchase_id').all(),
          wallet: db.prepare('SELECT profile_id, yellow_coins_balance FROM profile_wallets ORDER BY profile_id').all(),
        })
      })
    } finally {
      db.close()
    }

    for (const file of NEW_MIGRATIONS) {
      await cp(join(migrationsSource, file), join(migrationsDir, file))
    }
    const upgrade = await ensureServerDatabaseReady({ serverRootOverride: root, databaseFilePathOverride: dbPath })

    await check('[2] runner-ът прилага точно трите нови миграции', () => {
      const applied = upgrade.appliedMigrations.map((m) => (m as { filename?: string }).filename ?? JSON.stringify(m))
      assert(upgrade.appliedCount === 3, `appliedCount ${upgrade.appliedCount}: ${JSON.stringify(applied)}`)
    })

    const after = new DatabaseSync(dbPath, { open: true })
    try {
      await check('[3] съществуващите редове и wallet са непроменени', () => {
        const vip = (after.prepare('SELECT * FROM vip_purchase_ledger ORDER BY purchase_id').all() as Array<Record<string, unknown>>)
        assert(vip.every((r) => r.hidden_at === null), 'hidden_at трябва да е NULL')
        const snapshotAfter = JSON.stringify({
          vip: vip.map(({ hidden_at: _h, ...rest }) => rest),
          coin: after.prepare('SELECT * FROM coin_purchase_ledger ORDER BY purchase_id').all(),
          wallet: after.prepare('SELECT profile_id, yellow_coins_balance FROM profile_wallets ORDER BY profile_id').all(),
        })
        assert(snapshotAfter === snapshotBefore, 'данните са променени от миграциите')
      })

      await check('[4] нови индекси/колони', () => {
        const idx = (after.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_vip_purchase_ledger_pending_package'`).get() as { sql: string }).sql
        assert(idx.includes('hidden_at IS NULL') && idx.includes('COALESCE(recipient_profile_id, profile_id)'), idx)
        const cols = (after.prepare(`PRAGMA table_info(payment_review_issues)`).all() as Array<{ name: string; dflt_value: string | null; notnull: number }>)
        const transient = cols.find((c) => c.name === 'is_transient')
        assert(transient !== undefined && transient.notnull === 1 && transient.dflt_value === '0', JSON.stringify(transient))
        assert(after.prepare(`SELECT name FROM sqlite_master WHERE name = 'idx_payment_review_issues_status'`).get() !== undefined, 'status индекс')
      })
    } finally {
      after.close()
    }

    await check('[5] повторно пускане → нищо ново', async () => {
      const again = await ensureServerDatabaseReady({ serverRootOverride: root, databaseFilePathOverride: dbPath })
      assert(again.appliedCount === 0, `appliedCount ${again.appliedCount}`)
    })

    await check('[6] store-овете работят върху надградената база', async () => {
      const vip = await createVipPurchaseStore(dbPath)
      const issues = await createPaymentReviewIssueStore(dbPath)
      try {
        // Съществуващият pending v-pending (499) при нова цена 599 → скрит + нов ред.
        const fresh = vip.createPendingPurchase('u1', 'vip_30', 599)
        assert(fresh.ok && fresh.purchase.purchaseId !== 'v-pending' && fresh.purchase.priceCents === 599, JSON.stringify(fresh))
        const issue = issues.recordIssue({
          checkoutSessionId: 'cs_upgrade', stripeEventId: null, stripePaymentIntentId: null, purchaseType: 'vip',
          purchaseId: 'v-pending', metadataPurchaseId: null, payerProfileId: 'u1', issueKind: 'amount_mismatch',
          isTransient: false, detail: 'test', stripeAmountTotal: 1, stripeCurrency: 'EUR', expectedAmount: 499, expectedCurrency: 'EUR',
        })
        assert(issue.status === 'open' && issue.isTransient === false, JSON.stringify(issue))
      } finally {
        vip.close()
        issues.close()
      }
    })
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main()
