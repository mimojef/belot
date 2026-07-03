import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'
import { getSofiaDayBoundsUtc, sofiaMidnightUtc, toSqliteUtc } from './sofiaDayBounds.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type CoinPurchaseStatus = 'pending' | 'paid' | 'canceled' | 'failed'

export type CoinPurchaseSnapshot = {
  purchaseId: string
  packageId: string | null
  packageKey: string
  title: string
  yellowCoinsAmount: number
  priceCents: number
  currency: string
  provider: string
  providerCheckoutSessionId: string | null
  status: CoinPurchaseStatus
  creditedAt: string | null
  hiddenAt: string | null
  createdAt: string
  updatedAt: string
}

export type FulfillPaidPurchaseParams = {
  checkoutSessionId: string
  purchaseId: string
  amountPaidCents: number
  currency: string
}

export type PaymentMethodSnapshot = {
  stripePaymentIntentId: string | null
  stripeChargeId: string | null
  paymentMethodType: string | null
  walletType: string | null
  cardBrand: string | null
  cardLast4: string | null
  cardCountry: string | null
}

export type PaymentPeriodStats = {
  count: number
  totalCents: number
}

export type AdminPaymentStats = {
  today: PaymentPeriodStats
  yesterday: PaymentPeriodStats
  last7days: PaymentPeriodStats
  thisMonth: PaymentPeriodStats
  allTime: PaymentPeriodStats
}

export const ADMIN_PAYMENT_PERIODS = ['today', 'yesterday', 'last7days', 'thisMonth', 'allTime'] as const
export type AdminPaymentPeriod = (typeof ADMIN_PAYMENT_PERIODS)[number]

export type AdminPaymentListRow = {
  purchaseId: string
  profileId: string
  accountId: string | null
  username: string | null
  displayName: string | null
  email: string | null
  profileKind: string | null
  packageKey: string
  packageTitle: string
  yellowCoinsAmount: number
  priceCents: number
  currency: string
  provider: string
  status: CoinPurchaseStatus
  providerCheckoutSessionId: string | null
  paymentMethodType: string | null
  walletType: string | null
  cardBrand: string | null
  cardLast4: string | null
  cardCountry: string | null
  createdAt: string
  creditedAt: string | null
  hiddenAt: string | null
}

export type AdminPaymentDetailRow = {
  purchaseId: string
  profileId: string
  accountId: string | null
  username: string | null
  displayName: string | null
  email: string | null
  profileKind: string | null
  packageKey: string
  packageTitle: string
  yellowCoinsAmount: number
  priceCents: number
  currency: string
  provider: string
  status: string
  providerCheckoutSessionId: string | null
  stripePaymentIntentId: string | null
  stripeChargeId: string | null
  paymentMethodType: string | null
  walletType: string | null
  cardBrand: string | null
  cardLast4: string | null
  cardCountry: string | null
  createdAt: string
  creditedAt: string | null
  updatedAt: string
  hiddenAt: string | null
  currentYellowCoinsBalance: number | null
}

export type AdminPaymentListResult = {
  rows: AdminPaymentListRow[]
  total: number
  totalsByCurrency: Record<string, number>
}

export type CoinPurchaseStore = {
  listProfilePurchases: (profileId: string) => CoinPurchaseSnapshot[]
  getAdminPaymentStats: (now?: Date) => AdminPaymentStats
  getAdminPaymentListByPeriod: (params: {
    period: AdminPaymentPeriod
    limit: number
    offset: number
    now?: Date
  }) => AdminPaymentListResult
  getAdminPaymentDetail: (purchaseId: string) => AdminPaymentDetailRow | null
  createPendingPurchase: (
    profileId: string,
    packageId: string,
  ) => { ok: true; purchase: CoinPurchaseSnapshot } | { ok: false; message: string }
  getPurchaseById: (purchaseId: string) => CoinPurchaseSnapshot | null
  getPurchaseWithOwnerCheck: (
    purchaseId: string,
    profileId: string,
  ) => CoinPurchaseSnapshot | null
  attachCheckoutSession: (
    purchaseId: string,
    checkoutSessionId: string,
  ) => CoinPurchaseSnapshot | null
  findByCheckoutSessionId: (checkoutSessionId: string) => CoinPurchaseSnapshot | null
  markPurchaseCanceledByCheckoutSessionId: (checkoutSessionId: string) => void
  markPurchaseFailedByCheckoutSessionId: (checkoutSessionId: string) => void
  fulfillPaidPurchase: (params: FulfillPaidPurchaseParams) =>
    | { ok: true; purchase: CoinPurchaseSnapshot; alreadyCredited: boolean }
    | { ok: false; message: string }
  needsPaymentMethodSnapshot: (purchaseId: string) => boolean
  updatePaymentMethodSnapshot: (
    purchaseId: string,
    snapshot: PaymentMethodSnapshot,
  ) => void
  hidePurchaseForUser: (
    purchaseId: string,
    profileId: string,
  ) => { ok: true; purchase: CoinPurchaseSnapshot } | { ok: false; message: string }
  close: () => void
}

type CoinPurchaseRow = {
  purchase_id: string
  package_id: string | null
  package_key_snapshot: string
  title_snapshot: string
  yellow_coins_amount: number
  price_cents: number
  currency: string
  provider: string
  provider_checkout_session_id: string | null
  status: CoinPurchaseStatus
  credited_at: string | null
  hidden_at: string | null
  created_at: string
  updated_at: string
  stripe_payment_intent_id: string | null
  stripe_charge_id: string | null
  payment_method_type: string | null
  wallet_type: string | null
  card_brand: string | null
  card_last4: string | null
  card_country: string | null
}

type CoinPurchaseInternalRow = CoinPurchaseRow & {
  profile_id: string
}

type ActivePackageRow = {
  package_id: string
  package_key: string
  title: string
  yellow_coins_amount: number
  price_cents: number
  currency: string
}

type WalletRow = {
  yellow_coins_balance: number
}

function rowToSnapshot(row: CoinPurchaseRow): CoinPurchaseSnapshot {
  return {
    purchaseId: row.purchase_id,
    packageId: row.package_id,
    packageKey: row.package_key_snapshot,
    title: row.title_snapshot,
    yellowCoinsAmount: row.yellow_coins_amount,
    priceCents: row.price_cents,
    currency: row.currency,
    provider: row.provider,
    providerCheckoutSessionId: row.provider_checkout_session_id,
    status: row.status,
    creditedAt: row.credited_at,
    hiddenAt: row.hidden_at ?? null,
    createdAt: dbDateToUtc(row.created_at),
    updatedAt: dbDateToUtc(row.updated_at),
  }
}

function normalizeId(value: string): string {
  return value.trim().slice(0, 96)
}

export async function createCoinPurchaseStore(
  databaseFilePath: string,
): Promise<CoinPurchaseStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectProfilePurchasesStatement = database.prepare(`
    SELECT
      purchase_id,
      package_id,
      package_key_snapshot,
      title_snapshot,
      yellow_coins_amount,
      price_cents,
      currency,
      provider,
      provider_checkout_session_id,
      status,
      credited_at,
      hidden_at,
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE profile_id = ?
      AND hidden_at IS NULL
    ORDER BY created_at DESC
    LIMIT 30;
  `)

  const selectActivePackageStatement = database.prepare(`
    SELECT
      package_id,
      package_key,
      title,
      yellow_coins_amount,
      price_cents,
      currency
    FROM coin_packages
    WHERE package_id = ?
      AND status = 'active';
  `)

  const selectPendingPurchaseStatement = database.prepare(`
    SELECT
      purchase_id,
      package_id,
      package_key_snapshot,
      title_snapshot,
      yellow_coins_amount,
      price_cents,
      currency,
      provider,
      provider_checkout_session_id,
      status,
      credited_at,
      hidden_at,
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE profile_id = ?
      AND package_id = ?
      AND status = 'pending'
      AND hidden_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;
  `)

  const insertPendingPurchaseStatement = database.prepare(`
    INSERT INTO coin_purchase_ledger (
      purchase_id,
      profile_id,
      package_id,
      package_key_snapshot,
      title_snapshot,
      yellow_coins_amount,
      price_cents,
      currency,
      provider,
      status
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      'stripe',
      'pending'
    );
  `)

  const selectPurchaseStatement = database.prepare(`
    SELECT
      purchase_id,
      package_id,
      package_key_snapshot,
      title_snapshot,
      yellow_coins_amount,
      price_cents,
      currency,
      provider,
      provider_checkout_session_id,
      status,
      credited_at,
      hidden_at,
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE purchase_id = ?
    LIMIT 1;
  `)

  const selectPurchaseWithProfileStatement = database.prepare(`
    SELECT
      purchase_id,
      profile_id,
      package_id,
      package_key_snapshot,
      title_snapshot,
      yellow_coins_amount,
      price_cents,
      currency,
      provider,
      provider_checkout_session_id,
      status,
      credited_at,
      hidden_at,
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE purchase_id = ?
    LIMIT 1;
  `)

  const selectPurchaseByOwnerStatement = database.prepare(`
    SELECT
      purchase_id,
      package_id,
      package_key_snapshot,
      title_snapshot,
      yellow_coins_amount,
      price_cents,
      currency,
      provider,
      provider_checkout_session_id,
      status,
      credited_at,
      hidden_at,
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE purchase_id = ?
      AND profile_id = ?
    LIMIT 1;
  `)

  const selectPurchaseBySessionStatement = database.prepare(`
    SELECT
      purchase_id,
      package_id,
      package_key_snapshot,
      title_snapshot,
      yellow_coins_amount,
      price_cents,
      currency,
      provider,
      provider_checkout_session_id,
      status,
      credited_at,
      hidden_at,
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE provider_checkout_session_id = ?
    LIMIT 1;
  `)

  const selectPurchaseBySessionWithProfileStatement = database.prepare(`
    SELECT
      purchase_id,
      profile_id,
      package_id,
      package_key_snapshot,
      title_snapshot,
      yellow_coins_amount,
      price_cents,
      currency,
      provider,
      provider_checkout_session_id,
      status,
      credited_at,
      hidden_at,
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE provider_checkout_session_id = ?
    LIMIT 1;
  `)

  const attachCheckoutSessionStatement = database.prepare(`
    UPDATE coin_purchase_ledger
    SET
      provider_checkout_session_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND status = 'pending';
  `)

  const hidePurchaseStatement = database.prepare(`
    UPDATE coin_purchase_ledger
    SET
      hidden_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND profile_id = ?
      AND hidden_at IS NULL;
  `)

  const markCanceledBySessionStatement = database.prepare(`
    UPDATE coin_purchase_ledger
    SET
      status = 'canceled',
      updated_at = CURRENT_TIMESTAMP
    WHERE provider_checkout_session_id = ?
      AND status = 'pending';
  `)

  const markFailedBySessionStatement = database.prepare(`
    UPDATE coin_purchase_ledger
    SET
      status = 'failed',
      updated_at = CURRENT_TIMESTAMP
    WHERE provider_checkout_session_id = ?
      AND status = 'pending';
  `)

  const markPaidByPurchaseIdStatement = database.prepare(`
    UPDATE coin_purchase_ledger
    SET
      status = 'paid',
      credited_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND status = 'pending';
  `)

  // Non-destructive: COALESCE keeps existing non-null values.
  // Webhook and backfill may call this multiple times safely.
  const updatePaymentMethodSnapshotStatement = database.prepare(`
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
    WHERE purchase_id = ?;
  `)

  const needsPaymentMethodSnapshotStatement = database.prepare(`
    SELECT 1 FROM coin_purchase_ledger
    WHERE purchase_id = ?
      AND (stripe_payment_intent_id IS NULL OR payment_method_type IS NULL)
    LIMIT 1;
  `)

  const adminPaymentDetailStatement = database.prepare(`
    SELECT
      cpl.purchase_id,
      cpl.profile_id,
      p.account_id,
      p.username,
      p.display_name,
      a.email,
      p.profile_kind,
      cpl.package_key_snapshot,
      cpl.title_snapshot,
      cpl.yellow_coins_amount,
      cpl.price_cents,
      cpl.currency,
      cpl.provider,
      cpl.status,
      cpl.provider_checkout_session_id,
      cpl.stripe_payment_intent_id,
      cpl.stripe_charge_id,
      cpl.payment_method_type,
      cpl.wallet_type,
      cpl.card_brand,
      cpl.card_last4,
      cpl.card_country,
      cpl.created_at,
      cpl.credited_at,
      cpl.updated_at,
      cpl.hidden_at,
      pw.yellow_coins_balance
    FROM coin_purchase_ledger cpl
    LEFT JOIN profiles p ON p.profile_id = cpl.profile_id
    LEFT JOIN accounts a ON a.account_id = p.account_id
    LEFT JOIN profile_wallets pw ON pw.profile_id = cpl.profile_id
    WHERE cpl.purchase_id = ?
    LIMIT 1;
  `)

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (
      profile_id,
      yellow_coins_balance
    ) VALUES (
      ?,
      0
    )
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const creditWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET
      yellow_coins_balance = yellow_coins_balance + ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  function listProfilePurchases(profileId: string): CoinPurchaseSnapshot[] {
    const normalizedProfileId = normalizeId(profileId)

    if (normalizedProfileId.length === 0) {
      return []
    }

    return (selectProfilePurchasesStatement.all(normalizedProfileId) as CoinPurchaseRow[])
      .map(rowToSnapshot)
  }

  function getPurchaseById(purchaseId: string): CoinPurchaseSnapshot | null {
    const row = selectPurchaseStatement.get(purchaseId) as CoinPurchaseRow | undefined

    return row ? rowToSnapshot(row) : null
  }

  function getPurchaseWithOwnerCheck(purchaseId: string, profileId: string): CoinPurchaseSnapshot | null {
    const normalizedPurchaseId = normalizeId(purchaseId)
    const normalizedProfileId = normalizeId(profileId)

    if (normalizedPurchaseId.length === 0 || normalizedProfileId.length === 0) {
      return null
    }

    const row = selectPurchaseByOwnerStatement.get(normalizedPurchaseId, normalizedProfileId) as CoinPurchaseRow | undefined

    return row ? rowToSnapshot(row) : null
  }

  function getPurchaseWithProfileById(purchaseId: string): CoinPurchaseInternalRow | null {
    return (selectPurchaseWithProfileStatement.get(purchaseId) as CoinPurchaseInternalRow | undefined) ?? null
  }

  function getPurchaseWithProfileBySessionId(sessionId: string): CoinPurchaseInternalRow | null {
    return (selectPurchaseBySessionWithProfileStatement.get(sessionId) as CoinPurchaseInternalRow | undefined) ?? null
  }

  function createPendingPurchase(
    profileId: string,
    packageId: string,
  ): { ok: true; purchase: CoinPurchaseSnapshot } | { ok: false; message: string } {
    const normalizedProfileId = normalizeId(profileId)
    const normalizedPackageId = normalizeId(packageId)

    if (normalizedProfileId.length === 0 || normalizedPackageId.length === 0) {
      return {
        ok: false,
        message: 'Невалидна заявка за покупка.',
      }
    }

    const activePackage = selectActivePackageStatement.get(
      normalizedPackageId,
    ) as ActivePackageRow | undefined

    if (!activePackage) {
      return {
        ok: false,
        message: 'Този пакет не е активен в магазина.',
      }
    }

    const existingPending = selectPendingPurchaseStatement.get(
      normalizedProfileId,
      normalizedPackageId,
    ) as CoinPurchaseRow | undefined

    if (existingPending) {
      return {
        ok: true,
        purchase: rowToSnapshot(existingPending),
      }
    }

    const purchaseId = randomUUID()

    insertPendingPurchaseStatement.run(
      purchaseId,
      normalizedProfileId,
      activePackage.package_id,
      activePackage.package_key,
      activePackage.title,
      activePackage.yellow_coins_amount,
      activePackage.price_cents,
      activePackage.currency,
    )

    const purchase = getPurchaseById(purchaseId)

    if (purchase === null) {
      return {
        ok: false,
        message: 'Покупката не беше записана.',
      }
    }

    return {
      ok: true,
      purchase,
    }
  }

  function attachCheckoutSession(
    purchaseId: string,
    checkoutSessionId: string,
  ): CoinPurchaseSnapshot | null {
    attachCheckoutSessionStatement.run(checkoutSessionId, purchaseId)

    return getPurchaseById(purchaseId)
  }

  function findByCheckoutSessionId(checkoutSessionId: string): CoinPurchaseSnapshot | null {
    const row = selectPurchaseBySessionStatement.get(checkoutSessionId) as CoinPurchaseRow | undefined

    return row ? rowToSnapshot(row) : null
  }

  function markPurchaseCanceledByCheckoutSessionId(checkoutSessionId: string): void {
    markCanceledBySessionStatement.run(checkoutSessionId)
  }

  function markPurchaseFailedByCheckoutSessionId(checkoutSessionId: string): void {
    markFailedBySessionStatement.run(checkoutSessionId)
  }

  function fulfillPaidPurchase(
    params: FulfillPaidPurchaseParams,
  ):
    | { ok: true; purchase: CoinPurchaseSnapshot; alreadyCredited: boolean }
    | { ok: false; message: string } {
    const { checkoutSessionId, purchaseId } = params

    const internalRow = checkoutSessionId
      ? getPurchaseWithProfileBySessionId(checkoutSessionId)
      : purchaseId
        ? getPurchaseWithProfileById(purchaseId)
        : null

    if (internalRow === null) {
      if (purchaseId) {
        const fallback = getPurchaseWithProfileById(purchaseId)
        if (fallback === null) {
          return { ok: false, message: 'Покупката не беше намерена.' }
        }
        return fulfillByInternalRow(fallback)
      }
      return { ok: false, message: 'Покупката не беше намерена.' }
    }

    return fulfillByInternalRow(internalRow)
  }

  function fulfillByInternalRow(
    row: CoinPurchaseInternalRow,
  ):
    | { ok: true; purchase: CoinPurchaseSnapshot; alreadyCredited: boolean }
    | { ok: false; message: string } {
    if (row.status === 'paid' && row.credited_at !== null) {
      return { ok: true, purchase: rowToSnapshot(row), alreadyCredited: true }
    }

    if (row.status !== 'pending') {
      return {
        ok: false,
        message: `Покупката е в статус "${row.status}" и не може да бъде кредитирана.`,
      }
    }

    try {
      database.exec('BEGIN;')

      ensureWalletStatement.run(row.profile_id)
      creditWalletStatement.run(row.yellow_coins_amount, row.profile_id)

      const updateResult = markPaidByPurchaseIdStatement.run(row.purchase_id) as {
        changes?: number
      }

      if ((updateResult.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')

        const fresh = getPurchaseWithProfileById(row.purchase_id)

        if (fresh?.status === 'paid') {
          return { ok: true, purchase: rowToSnapshot(fresh), alreadyCredited: true }
        }

        return { ok: false, message: 'Покупката вече беше обработена от друг процес.' }
      }

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original error
      }

      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Грешка при кредитиране на жълтици.',
      }
    }

    const fulfilled = getPurchaseById(row.purchase_id)

    if (fulfilled === null) {
      return { ok: false, message: 'Жълтиците бяха кредитирани, но покупката не може да се прочете.' }
    }

    return { ok: true, purchase: fulfilled, alreadyCredited: false }
  }

  function needsPaymentMethodSnapshot(purchaseId: string): boolean {
    const row = needsPaymentMethodSnapshotStatement.get(purchaseId)
    return row !== undefined
  }

  function updatePaymentMethodSnapshot(
    purchaseId: string,
    snapshot: PaymentMethodSnapshot,
  ): void {
    // Parameters match COALESCE(column, ?) order — existing non-null values are preserved.
    updatePaymentMethodSnapshotStatement.run(
      snapshot.stripePaymentIntentId,
      snapshot.stripeChargeId,
      snapshot.paymentMethodType,
      snapshot.walletType,
      snapshot.cardBrand,
      snapshot.cardLast4,
      snapshot.cardCountry,
      purchaseId,
    )
  }

  function hidePurchaseForUser(
    purchaseId: string,
    profileId: string,
  ): { ok: true; purchase: CoinPurchaseSnapshot } | { ok: false; message: string } {
    const normalizedPurchaseId = normalizeId(purchaseId)
    const normalizedProfileId = normalizeId(profileId)

    if (normalizedPurchaseId.length === 0 || normalizedProfileId.length === 0) {
      return { ok: false, message: 'Невалидна заявка.' }
    }

    const existing = getPurchaseWithOwnerCheck(normalizedPurchaseId, normalizedProfileId)

    if (existing === null) {
      return { ok: false, message: 'Покупката не беше намерена.' }
    }

    if (existing.hiddenAt !== null) {
      return { ok: true, purchase: existing }
    }

    hidePurchaseStatement.run(normalizedPurchaseId, normalizedProfileId)

    const updated = getPurchaseWithOwnerCheck(normalizedPurchaseId, normalizedProfileId)

    if (updated === null) {
      return { ok: false, message: 'Покупката не може да се прочете след скриване.' }
    }

    return { ok: true, purchase: updated }
  }

  // Builds the WHERE clause fragment for credited_at filtering by period using
  // Europe/Sofia calendar boundaries. `now` is injectable for deterministic tests.
  // `col` must be a hardcoded column reference — never derived from HTTP input.
  function buildPeriodWhereClause(
    period: AdminPaymentPeriod,
    now: Date,
    col: 'credited_at' | 'cpl.credited_at',
  ): { sql: string; params: string[] } {
    const bounds = getSofiaDayBoundsUtc(now)
    // Base guard: paid records must have credited_at set.
    const notNull = `${col} IS NOT NULL`

    switch (period) {
      case 'today':
        return {
          sql: `${notNull} AND ${col} >= ? AND ${col} < ?`,
          params: [bounds.todayStart, bounds.tomorrowStart],
        }
      case 'yesterday':
        return {
          sql: `${notNull} AND ${col} >= ? AND ${col} < ?`,
          params: [bounds.yesterdayStart, bounds.todayStart],
        }
      case 'last7days': {
        // Current Sofia calendar day + previous 6 full days (7 days total).
        // Start = Sofia midnight 6 days before today; end = tomorrowStart (exclusive).
        const sofiaToday = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Sofia',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(now)
        const y = parseInt(sofiaToday.find(p => p.type === 'year')!.value,  10)
        const m = parseInt(sofiaToday.find(p => p.type === 'month')!.value, 10)
        const d = parseInt(sofiaToday.find(p => p.type === 'day')!.value,   10)
        const windowStart = toSqliteUtc(sofiaMidnightUtc(y, m, d - 6))
        return {
          sql: `${notNull} AND ${col} >= ? AND ${col} < ?`,
          params: [windowStart, bounds.tomorrowStart],
        }
      }
      case 'thisMonth': {
        // Sofia calendar month: from midnight on the 1st of the current Sofia month.
        const sofiaToday = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Sofia',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(now)
        const y = parseInt(sofiaToday.find(p => p.type === 'year')!.value,  10)
        const m = parseInt(sofiaToday.find(p => p.type === 'month')!.value, 10)
        const monthStart = toSqliteUtc(sofiaMidnightUtc(y, m, 1))
        return {
          sql: `${notNull} AND ${col} >= ? AND ${col} < ?`,
          params: [monthStart, bounds.tomorrowStart],
        }
      }
      case 'allTime':
        return { sql: notNull, params: [] }
    }
  }

  function getAdminPaymentStats(now: Date = new Date()): AdminPaymentStats {
    function query(period: AdminPaymentPeriod): PaymentPeriodStats {
      const { sql, params } = buildPeriodWhereClause(period, now, 'credited_at')
      const row = database.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(price_cents), 0) AS total_cents
        FROM coin_purchase_ledger
        WHERE status = 'paid' AND ${sql}
      `).get(...params) as { count: number; total_cents: number }
      return { count: row.count, totalCents: row.total_cents }
    }

    return {
      today:     query('today'),
      yesterday: query('yesterday'),
      last7days: query('last7days'),
      thisMonth: query('thisMonth'),
      allTime:   query('allTime'),
    }
  }

  function getAdminPaymentListByPeriod(params: {
    period: AdminPaymentPeriod
    limit: number
    offset: number
    now?: Date
  }): AdminPaymentListResult {
    const { period, limit, offset, now = new Date() } = params
    // Summary uses unqualified column (no JOIN); list uses cpl.credited_at.
    const { sql: summarySql, params: summaryParams } = buildPeriodWhereClause(period, now, 'credited_at')
    const { sql: listSql,    params: listParams }    = buildPeriodWhereClause(period, now, 'cpl.credited_at')

    // Total count + currency totals for the whole period (not just the page)
    type SummaryRow = { currency: string; cnt: number; total_cents: number }
    const summaryRows = database.prepare(`
      SELECT
        currency,
        COUNT(*) AS cnt,
        COALESCE(SUM(price_cents), 0) AS total_cents
      FROM coin_purchase_ledger
      WHERE status = 'paid' AND ${summarySql}
      GROUP BY currency
    `).all(...summaryParams) as SummaryRow[]

    let total = 0
    const totalsByCurrency: Record<string, number> = {}
    for (const sr of summaryRows) {
      total += sr.cnt
      totalsByCurrency[sr.currency.toUpperCase()] =
        (totalsByCurrency[sr.currency.toUpperCase()] ?? 0) + sr.total_cents
    }

    // Paged rows with JOIN to profiles and accounts.
    // hidden_at is returned as informational field — admin sees all paid records
    // regardless of whether the user chose to hide the purchase from their own view.
    type ListRow = {
      purchase_id: string
      profile_id: string
      account_id: string | null
      username: string | null
      display_name: string | null
      email: string | null
      profile_kind: string | null
      package_key_snapshot: string
      title_snapshot: string
      yellow_coins_amount: number
      price_cents: number
      currency: string
      provider: string
      status: CoinPurchaseStatus
      provider_checkout_session_id: string | null
      payment_method_type: string | null
      wallet_type: string | null
      card_brand: string | null
      card_last4: string | null
      card_country: string | null
      created_at: string
      credited_at: string | null
      hidden_at: string | null
    }

    const listRows = database.prepare(`
      SELECT
        cpl.purchase_id,
        cpl.profile_id,
        p.account_id,
        p.username,
        p.display_name,
        a.email,
        p.profile_kind,
        cpl.package_key_snapshot,
        cpl.title_snapshot,
        cpl.yellow_coins_amount,
        cpl.price_cents,
        cpl.currency,
        cpl.provider,
        cpl.status,
        cpl.provider_checkout_session_id,
        cpl.payment_method_type,
        cpl.wallet_type,
        cpl.card_brand,
        cpl.card_last4,
        cpl.card_country,
        cpl.created_at,
        cpl.credited_at,
        cpl.hidden_at
      FROM coin_purchase_ledger cpl
      LEFT JOIN profiles p ON p.profile_id = cpl.profile_id
      LEFT JOIN accounts a ON a.account_id = p.account_id
      WHERE cpl.status = 'paid' AND ${listSql}
      ORDER BY cpl.credited_at DESC, cpl.purchase_id DESC
      LIMIT ? OFFSET ?
    `).all(...listParams, limit, offset) as ListRow[]

    const rows: AdminPaymentListRow[] = listRows.map(r => ({
      purchaseId:                  r.purchase_id,
      profileId:                   r.profile_id,
      accountId:                   r.account_id ?? null,
      username:                    r.username ?? null,
      displayName:                 r.display_name ?? null,
      email:                       r.email ?? null,
      profileKind:                 r.profile_kind ?? null,
      packageKey:                  r.package_key_snapshot,
      packageTitle:                r.title_snapshot,
      yellowCoinsAmount:           r.yellow_coins_amount,
      priceCents:                  r.price_cents,
      currency:                    r.currency.toUpperCase(),
      provider:                    r.provider,
      status:                      r.status,
      providerCheckoutSessionId:   r.provider_checkout_session_id ?? null,
      paymentMethodType:           r.payment_method_type ?? null,
      walletType:                  r.wallet_type ?? null,
      cardBrand:                   r.card_brand ?? null,
      cardLast4:                   r.card_last4 ?? null,
      cardCountry:                 r.card_country ?? null,
      createdAt:                   dbDateToUtc(r.created_at),
      creditedAt:                  r.credited_at ? dbDateToUtc(r.credited_at) : null,
      hiddenAt:                    r.hidden_at ? dbDateToUtc(r.hidden_at) : null,
    }))

    return { rows, total, totalsByCurrency }
  }

  function getAdminPaymentDetail(purchaseId: string): AdminPaymentDetailRow | null {
    type DetailRow = {
      purchase_id: string
      profile_id: string
      account_id: string | null
      username: string | null
      display_name: string | null
      email: string | null
      profile_kind: string | null
      package_key_snapshot: string
      title_snapshot: string
      yellow_coins_amount: number
      price_cents: number
      currency: string
      provider: string
      status: string
      provider_checkout_session_id: string | null
      stripe_payment_intent_id: string | null
      stripe_charge_id: string | null
      payment_method_type: string | null
      wallet_type: string | null
      card_brand: string | null
      card_last4: string | null
      card_country: string | null
      created_at: string
      credited_at: string | null
      updated_at: string
      hidden_at: string | null
      yellow_coins_balance: number | null
    }
    const r = adminPaymentDetailStatement.get(normalizeId(purchaseId)) as DetailRow | undefined
    if (!r) return null
    return {
      purchaseId:                 r.purchase_id,
      profileId:                  r.profile_id,
      accountId:                  r.account_id ?? null,
      username:                   r.username ?? null,
      displayName:                r.display_name ?? null,
      email:                      r.email ?? null,
      profileKind:                r.profile_kind ?? null,
      packageKey:                 r.package_key_snapshot,
      packageTitle:               r.title_snapshot,
      yellowCoinsAmount:          r.yellow_coins_amount,
      priceCents:                 r.price_cents,
      currency:                   r.currency.toUpperCase(),
      provider:                   r.provider,
      status:                     r.status,
      providerCheckoutSessionId:  r.provider_checkout_session_id ?? null,
      stripePaymentIntentId:      r.stripe_payment_intent_id ?? null,
      stripeChargeId:             r.stripe_charge_id ?? null,
      paymentMethodType:          r.payment_method_type ?? null,
      walletType:                 r.wallet_type ?? null,
      cardBrand:                  r.card_brand ?? null,
      cardLast4:                  r.card_last4 ?? null,
      cardCountry:                r.card_country ?? null,
      createdAt:                  dbDateToUtc(r.created_at),
      creditedAt:                 r.credited_at ? dbDateToUtc(r.credited_at) : null,
      updatedAt:                  dbDateToUtc(r.updated_at),
      hiddenAt:                   r.hidden_at ? dbDateToUtc(r.hidden_at) : null,
      currentYellowCoinsBalance:  r.yellow_coins_balance ?? null,
    }
  }

  function close(): void {
    database.close()
  }

  return {
    listProfilePurchases,
    getAdminPaymentStats,
    getAdminPaymentListByPeriod,
    createPendingPurchase,
    getPurchaseById,
    getPurchaseWithOwnerCheck,
    attachCheckoutSession,
    findByCheckoutSessionId,
    markPurchaseCanceledByCheckoutSessionId,
    markPurchaseFailedByCheckoutSessionId,
    fulfillPaidPurchase,
    needsPaymentMethodSnapshot,
    updatePaymentMethodSnapshot,
    getAdminPaymentDetail,
    hidePurchaseForUser,
    close,
  }
}
