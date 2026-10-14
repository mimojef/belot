import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'

// Устойчив запис на потвърдени плащания, които не са кредитирани автоматично
// (таблица payment_review_issues, migration 20261020_001). Само за
// административен преглед — store-ът НИКОГА не кредитира.

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type PaymentReviewIssueKind =
  | 'purchase_not_found'
  | 'purchase_id_mismatch'
  | 'currency_mismatch'
  | 'amount_mismatch'
  | 'duplicate_payment'
  | 'not_creditable'
  | 'credit_failed'

export type PaymentReviewIssuePurchaseType = 'coin' | 'vip' | 'bundle'

export type RecordPaymentReviewIssueInput = {
  checkoutSessionId: string
  stripeEventId: string | null
  stripePaymentIntentId: string | null
  purchaseType: PaymentReviewIssuePurchaseType
  purchaseId: string | null
  metadataPurchaseId: string | null
  payerProfileId: string | null
  issueKind: PaymentReviewIssueKind
  /** Временна техническа грешка (webhook 500, Stripe retry) — затваря се автоматично при окончателен резултат. */
  isTransient: boolean
  detail: string
  stripeAmountTotal: number | null
  stripeCurrency: string | null
  expectedAmount: number | null
  expectedCurrency: string | null
}

export type PaymentReviewIssueSnapshot = {
  issueId: string
  checkoutSessionId: string
  stripeEventId: string | null
  stripePaymentIntentId: string | null
  purchaseType: PaymentReviewIssuePurchaseType
  purchaseId: string | null
  metadataPurchaseId: string | null
  payerProfileId: string | null
  issueKind: PaymentReviewIssueKind
  /** Временна техническа грешка (webhook 500, Stripe retry) — затваря се автоматично при окончателен резултат. */
  isTransient: boolean
  detail: string
  stripeAmountTotal: number | null
  stripeCurrency: string | null
  expectedAmount: number | null
  expectedCurrency: string | null
  status: 'open' | 'resolved'
  resolutionNote: string | null
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
}

export type PaymentReviewIssueStore = {
  /** Идемпотентно по (checkoutSessionId, issueKind): повторение увеличава occurrences. */
  recordIssue: (input: RecordPaymentReviewIssueInput) => PaymentReviewIssueSnapshot
  listOpenIssues: () => PaymentReviewIssueSnapshot[]
  /**
   * Затваря ОТВОРЕНИТЕ временни записи за сесията, когато повторна доставка
   * стигне до окончателен резултат. Окончателните проблеми не се пипат.
   */
  resolveTransientIssuesForSession: (checkoutSessionId: string, resolutionNote: string) => number
  close: () => void
}

type PaymentReviewIssueRow = {
  issue_id: string
  checkout_session_id: string
  stripe_event_id: string | null
  stripe_payment_intent_id: string | null
  purchase_type: PaymentReviewIssuePurchaseType
  purchase_id: string | null
  metadata_purchase_id: string | null
  payer_profile_id: string | null
  issue_kind: PaymentReviewIssueKind
  is_transient: number
  detail: string
  stripe_amount_total: number | null
  stripe_currency: string | null
  expected_amount: number | null
  expected_currency: string | null
  status: 'open' | 'resolved'
  resolution_note: string | null
  occurrences: number
  first_seen_at: string
  last_seen_at: string
}

function rowToSnapshot(row: PaymentReviewIssueRow): PaymentReviewIssueSnapshot {
  return {
    issueId: row.issue_id,
    checkoutSessionId: row.checkout_session_id,
    stripeEventId: row.stripe_event_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    purchaseType: row.purchase_type,
    purchaseId: row.purchase_id,
    metadataPurchaseId: row.metadata_purchase_id,
    payerProfileId: row.payer_profile_id,
    issueKind: row.issue_kind,
    isTransient: row.is_transient === 1,
    detail: row.detail,
    stripeAmountTotal: row.stripe_amount_total,
    stripeCurrency: row.stripe_currency,
    expectedAmount: row.expected_amount,
    expectedCurrency: row.expected_currency,
    status: row.status,
    resolutionNote: row.resolution_note,
    occurrences: row.occurrences,
    firstSeenAt: dbDateToUtc(row.first_seen_at),
    lastSeenAt: dbDateToUtc(row.last_seen_at),
  }
}

export async function createPaymentReviewIssueStore(
  databaseFilePath: string,
): Promise<PaymentReviewIssueStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  // Първото наблюдение пази оригиналните факти (суми, сесия, поръчка);
  // повторенията броят, обновяват last_seen_at/stripe_event_id и ПОСЛЕДНАТА
  // класификация (is_transient/detail) — напр. временна грешка, повторена
  // като детерминистична. resolved остава resolved.
  const upsertIssueStatement = database.prepare(`
    INSERT INTO payment_review_issues (
      issue_id, checkout_session_id, stripe_event_id, stripe_payment_intent_id,
      purchase_type, purchase_id, metadata_purchase_id, payer_profile_id,
      issue_kind, is_transient, detail, stripe_amount_total, stripe_currency,
      expected_amount, expected_currency
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (checkout_session_id, issue_kind) DO UPDATE SET
      occurrences = occurrences + 1,
      last_seen_at = CURRENT_TIMESTAMP,
      stripe_event_id = COALESCE(excluded.stripe_event_id, stripe_event_id),
      is_transient = excluded.is_transient,
      detail = excluded.detail;
  `)

  const resolveTransientIssuesStatement = database.prepare(`
    UPDATE payment_review_issues
    SET status = 'resolved',
      resolved_at = CURRENT_TIMESTAMP,
      resolution_note = ?
    WHERE checkout_session_id = ?
      AND is_transient = 1
      AND status = 'open';
  `)

  const selectIssueStatement = database.prepare(`
    SELECT * FROM payment_review_issues
    WHERE checkout_session_id = ? AND issue_kind = ?
    LIMIT 1;
  `)

  const selectOpenIssuesStatement = database.prepare(`
    SELECT * FROM payment_review_issues
    WHERE status = 'open'
    ORDER BY first_seen_at DESC, issue_id ASC
    LIMIT 500;
  `)

  function recordIssue(input: RecordPaymentReviewIssueInput): PaymentReviewIssueSnapshot {
    upsertIssueStatement.run(
      randomUUID(),
      input.checkoutSessionId,
      input.stripeEventId,
      input.stripePaymentIntentId,
      input.purchaseType,
      input.purchaseId,
      input.metadataPurchaseId,
      input.payerProfileId,
      input.issueKind,
      input.isTransient ? 1 : 0,
      input.detail,
      input.stripeAmountTotal,
      input.stripeCurrency,
      input.expectedAmount,
      input.expectedCurrency,
    )

    const row = selectIssueStatement.get(input.checkoutSessionId, input.issueKind) as PaymentReviewIssueRow | undefined

    if (!row) {
      throw new Error('payment_review_issues: записът не може да се прочете след запис.')
    }

    return rowToSnapshot(row)
  }

  function listOpenIssues(): PaymentReviewIssueSnapshot[] {
    return (selectOpenIssuesStatement.all() as PaymentReviewIssueRow[]).map(rowToSnapshot)
  }

  function resolveTransientIssuesForSession(checkoutSessionId: string, resolutionNote: string): number {
    const result = resolveTransientIssuesStatement.run(resolutionNote, checkoutSessionId) as { changes?: number }
    return result.changes ?? 0
  }

  function close(): void {
    database.close()
  }

  return { recordIssue, listOpenIssues, resolveTransientIssuesForSession, close }
}
