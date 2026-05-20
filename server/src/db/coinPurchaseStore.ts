import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'

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
  createdAt: string
  updatedAt: string
}

export type FulfillPaidPurchaseParams = {
  checkoutSessionId: string
  purchaseId: string
  amountPaidCents: number
  currency: string
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

export type CoinPurchaseStore = {
  listProfilePurchases: (profileId: string) => CoinPurchaseSnapshot[]
  getAdminPaymentStats: () => AdminPaymentStats
  createPendingPurchase: (
    profileId: string,
    packageId: string,
  ) => { ok: true; purchase: CoinPurchaseSnapshot } | { ok: false; message: string }
  getPurchaseById: (purchaseId: string) => CoinPurchaseSnapshot | null
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
  created_at: string
  updated_at: string
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
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE profile_id = ?
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
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE profile_id = ?
      AND package_id = ?
      AND status = 'pending'
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
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE purchase_id = ?
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

  function getAdminPaymentStats(): AdminPaymentStats {
    function query(whereClause: string): PaymentPeriodStats {
      const row = database.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(price_cents), 0) AS total_cents
        FROM coin_purchase_ledger
        WHERE status = 'paid' AND ${whereClause}
      `).get() as { count: number; total_cents: number }
      return { count: row.count, totalCents: row.total_cents }
    }

    return {
      today:     query(`DATE(credited_at) = DATE('now')`),
      yesterday: query(`DATE(credited_at) = DATE('now', '-1 day')`),
      last7days: query(`credited_at >= DATETIME('now', '-7 days')`),
      thisMonth: query(`strftime('%Y-%m', credited_at) = strftime('%Y-%m', 'now')`),
      allTime:   query(`1=1`),
    }
  }

  function close(): void {
    database.close()
  }

  return {
    listProfilePurchases,
    getAdminPaymentStats,
    createPendingPurchase,
    getPurchaseById,
    attachCheckoutSession,
    findByCheckoutSessionId,
    markPurchaseCanceledByCheckoutSessionId,
    markPurchaseFailedByCheckoutSessionId,
    fulfillPaidPurchase,
    close,
  }
}
