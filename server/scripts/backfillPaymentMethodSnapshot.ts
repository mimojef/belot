/**
 * Backfill payment method snapshot for paid Stripe purchases that have
 * provider_checkout_session_id but lack stripe_payment_intent_id or payment_method_type.
 *
 * SAFETY:
 *  - Dry-run mode is DEFAULT. Nothing is written unless --apply is passed.
 *  - Non-destructive: UPDATE uses COALESCE — existing non-null values are never overwritten.
 *  - Idempotent: SELECT finds only records where stripe_payment_intent_id IS NULL
 *    OR payment_method_type IS NULL; already-complete records are skipped.
 *  - Only processes provider='stripe' records.
 *  - Never logs raw card numbers, fingerprints, CVCs, or secrets.
 *  - Does NOT modify credited_at, status, or coin balances.
 *  - Concurrency: processes 3 records at a time to avoid Stripe rate limits.
 *
 * USAGE:
 *   npx tsx server/scripts/backfillPaymentMethodSnapshot.ts [options]
 *
 * OPTIONS:
 *   --server-root=<path>        Path to server directory (default: cwd)
 *   --apply                     Write to DB (default: dry-run)
 *   --limit=<N>                 Process at most N records
 *   --purchase-id=<purchaseId>  Process only this specific purchase
 *   --session-id=<sessionId>    Process only the purchase with this checkout session ID
 *
 * COMMANDS:
 *   dry-run (default, from project root):
 *     npx tsx server/scripts/backfillPaymentMethodSnapshot.ts --server-root=server
 *
 *   apply (writes to DB):
 *     npx tsx server/scripts/backfillPaymentMethodSnapshot.ts --server-root=server --apply
 *
 *   single purchase test:
 *     npx tsx server/scripts/backfillPaymentMethodSnapshot.ts --server-root=server --purchase-id=<id>
 *
 *   single session test:
 *     npx tsx server/scripts/backfillPaymentMethodSnapshot.ts --server-root=server --session-id=cs_...
 */

import 'dotenv/config'
import { resolve } from 'node:path'
import Stripe from 'stripe'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

const args = process.argv.slice(2)
const applyMode = args.includes('--apply')
const serverRootArg = args.find(a => a.startsWith('--server-root='))?.split('=')[1]
const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1]
const purchaseIdFilter = args.find(a => a.startsWith('--purchase-id='))?.split('=').slice(1).join('=') ?? null
const sessionIdFilter = args.find(a => a.startsWith('--session-id='))?.split('=').slice(1).join('=') ?? null
const limitN = limitArg ? parseInt(limitArg, 10) : null

const serverRoot = serverRootArg ? resolve(serverRootArg) : resolve('.')
const dbFilePath = getServerDatabaseFilePath(serverRoot)

const CONCURRENCY = 3

type PendingRow = {
  purchase_id: string
  provider_checkout_session_id: string
}

async function main(): Promise<void> {
  console.log(`\nBackfill payment method snapshot`)
  console.log(`  Mode:        ${applyMode ? '⚡ APPLY (writes to DB)' : '🔍 DRY-RUN (no writes)'}`)
  console.log(`  DB:          ${dbFilePath}`)
  console.log(`  Limit:       ${limitN ?? 'none (all records)'}`)
  if (purchaseIdFilter) console.log(`  Purchase ID: ${purchaseIdFilter}`)
  if (sessionIdFilter)  console.log(`  Session ID:  ${sessionIdFilter}`)
  console.log()

  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (!stripeKey) {
    console.error('ERROR: STRIPE_SECRET_KEY env var is not set.')
    process.exit(1)
  }

  const stripe = new Stripe(stripeKey)

  const sqliteModule = await import('node:sqlite')
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(dbFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  db.exec('PRAGMA journal_mode = WAL;')

  // Build WHERE clause based on filters.
  // Always: provider='stripe', session ID present, snapshot incomplete.
  const whereClauses: string[] = [
    `status = 'paid'`,
    `provider = 'stripe'`,
    `provider_checkout_session_id IS NOT NULL`,
    `(stripe_payment_intent_id IS NULL OR payment_method_type IS NULL)`,
  ]
  if (purchaseIdFilter) {
    whereClauses.push(`purchase_id = '${purchaseIdFilter.replace(/'/g, "''")}'`)
  }
  if (sessionIdFilter) {
    whereClauses.push(`provider_checkout_session_id = '${sessionIdFilter.replace(/'/g, "''")}'`)
  }

  const limitSql = limitN ? `LIMIT ${limitN}` : ''
  const candidates = db.prepare(`
    SELECT purchase_id, provider_checkout_session_id
    FROM coin_purchase_ledger
    WHERE ${whereClauses.join('\n      AND ')}
    ORDER BY credited_at DESC
    ${limitSql}
  `).all() as PendingRow[]

  console.log(`Found ${candidates.length} purchase(s) to enrich.\n`)

  // Non-destructive: COALESCE keeps existing non-null evidence.
  const updateStmt = db.prepare(`
    UPDATE coin_purchase_ledger
    SET
      stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
      stripe_charge_id         = COALESCE(stripe_charge_id, ?),
      payment_method_type      = COALESCE(payment_method_type, ?),
      wallet_type              = COALESCE(wallet_type, ?),
      card_brand               = COALESCE(card_brand, ?),
      card_last4               = COALESCE(card_last4, ?),
      card_country             = COALESCE(card_country, ?),
      updated_at               = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
  `)

  let scanned = 0
  let enriched = 0
  let skipped = 0
  let failed = 0

  // Process in batches of CONCURRENCY to respect Stripe rate limits.
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY)

    await Promise.all(batch.map(async (row) => {
      scanned++
      const { purchase_id, provider_checkout_session_id } = row

      try {
        // Retrieve checkout session with expanded payment intent and charge.
        const session = await stripe.checkout.sessions.retrieve(provider_checkout_session_id, {
          expand: ['payment_intent.latest_charge'],
        })

        const pi = session.payment_intent as Stripe.PaymentIntent | null
        const piId = pi?.id ?? null

        // latest_charge may be an expanded Charge object or a bare string ID.
        let charge: Stripe.Charge | null = null
        if (pi?.latest_charge && typeof pi.latest_charge === 'object') {
          charge = pi.latest_charge as Stripe.Charge
        } else if (pi?.latest_charge && typeof pi.latest_charge === 'string') {
          charge = await stripe.charges.retrieve(pi.latest_charge)
        }

        const pmd = charge?.payment_method_details ?? null
        const cardDetails = pmd?.card ?? null
        const walletDetails = cardDetails?.wallet ?? null

        const snapshotType = pmd?.type ?? null
        const snapshotWallet = walletDetails?.type ?? null
        const snapshotBrand = cardDetails?.brand ?? null
        const snapshotLast4 = cardDetails?.last4 ?? null
        const snapshotCountry = cardDetails?.country ?? null
        const chargeId = charge?.id ?? null

        if (!snapshotType && !piId) {
          console.log(`  SKIP  ${purchase_id.slice(0, 8)}… session=${provider_checkout_session_id.slice(0, 16)}… — no payment data from Stripe`)
          skipped++
          return
        }

        // Log safe summary only (no card numbers, no fingerprints).
        const methodSummary = snapshotWallet
          ? `${snapshotType ?? 'unknown'}/${snapshotWallet}`
          : (snapshotType ?? 'null')
        const cardSummary = snapshotBrand && snapshotLast4
          ? `${snapshotBrand} ****${snapshotLast4}`
          : snapshotBrand ?? '—'

        if (applyMode) {
          updateStmt.run(
            piId,
            chargeId,
            snapshotType,
            snapshotWallet,
            snapshotBrand,
            snapshotLast4,
            snapshotCountry,
            purchase_id,
          )
          console.log(`  WRITE ${purchase_id.slice(0, 8)}… method=${methodSummary} card=${cardSummary}`)
        } else {
          console.log(`  DRY   ${purchase_id.slice(0, 8)}… method=${methodSummary} card=${cardSummary}`)
        }

        enriched++
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  FAIL  ${purchase_id.slice(0, 8)}… session=${provider_checkout_session_id.slice(0, 16)}… — ${msg}`)
      }
    }))
  }

  db.close()

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`Scanned:  ${scanned}`)
  console.log(`Enriched: ${enriched}${applyMode ? ' (written)' : ' (dry-run, not written)'}`)
  console.log(`Skipped:  ${skipped}`)
  console.log(`Failed:   ${failed}`)

  if (!applyMode && enriched > 0) {
    console.log(`\nRun with --apply to write the enriched data to the database.`)
  }

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
