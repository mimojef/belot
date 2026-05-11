import { randomUUID } from 'node:crypto'

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

export type CoinPurchaseFulfillmentInput = {
  purchaseId: string
  providerCheckoutSessionId: string
  paidPriceCents: number
  paidCurrency: string
}

export type CoinPurchaseStore = {
  listProfilePurchases: (profileId: string) => CoinPurchaseSnapshot[]
  createPendingPurchase: (
    profileId: string,
    packageId: string,
  ) => { ok: true; purchase: CoinPurchaseSnapshot } | { ok: false; message: string }
  getPurchaseById: (purchaseId: string) => CoinPurchaseSnapshot | null
  getPurchaseByProviderCheckoutSessionId: (
    providerCheckoutSessionId: string,
  ) => CoinPurchaseSnapshot | null
  attachCheckoutSessionToPurchase: (
    purchaseId: string,
    providerCheckoutSessionId: string,
  ) => { ok: true; purchase: CoinPurchaseSnapshot } | { ok: false; message: string }
  markPurchaseCanceled: (
    purchaseId: string,
    providerCheckoutSessionId?: string | null,
  ) => { ok: true; purchase: CoinPurchaseSnapshot | null } | { ok: false; message: string }
  markPurchaseFailed: (
    purchaseId: string,
    providerCheckoutSessionId?: string | null,
  ) => { ok: true; purchase: CoinPurchaseSnapshot | null } | { ok: false; message: string }
  fulfillPaidPurchase: (
    input: CoinPurchaseFulfillmentInput,
  ) =>
    | { ok: true; purchase: CoinPurchaseSnapshot; alreadyFulfilled: boolean }
    | { ok: false; message: string }
  close: () => void
}

type CoinPurchaseRow = {
  purchase_id: string
  profile_id: string
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

type ActivePackageRow = {
  package_id: string
  package_key: string
  title: string
  yellow_coins_amount: number
  price_cents: number
  currency: string
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeId(value: string): string {
  return value.trim().slice(0, 96)
}

function normalizeProviderId(value: string): string {
  return value.trim().slice(0, 255)
}

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase().slice(0, 3)
}

function isFinalStatus(status: CoinPurchaseStatus): boolean {
  return status === 'paid' || status === 'canceled' || status === 'failed'
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
    WHERE purchase_id = ?;
  `)

  const selectPurchaseByCheckoutSessionStatement = database.prepare(`
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
    WHERE provider_checkout_session_id = ?;
  `)

  const attachCheckoutSessionStatement = database.prepare(`
    UPDATE coin_purchase_ledger
    SET
      provider_checkout_session_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND status = 'pending'
      AND (
        provider_checkout_session_id IS NULL
        OR provider_checkout_session_id = ?
      );
  `)

  const markStatusStatement = database.prepare(`
    UPDATE coin_purchase_ledger
    SET
      status = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND status = 'pending'
      AND (
        ? IS NULL
        OR provider_checkout_session_id IS NULL
        OR provider_checkout_session_id = ?
      );
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

  const markPaidAndCreditedStatement = database.prepare(`
    UPDATE coin_purchase_ledger
    SET
      status = 'paid',
      provider_checkout_session_id = COALESCE(provider_checkout_session_id, ?),
      credited_at = COALESCE(credited_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND status = 'pending'
      AND credited_at IS NULL
      AND (
        provider_checkout_session_id IS NULL
        OR provider_checkout_session_id = ?
      );
  `)

  function listProfilePurchases(profileId: string): CoinPurchaseSnapshot[] {
    const normalizedProfileId = normalizeId(profileId)

    if (normalizedProfileId.length === 0) {
      return []
    }

    return (selectProfilePurchasesStatement.all(normalizedProfileId) as CoinPurchaseRow[])
      .map(rowToSnapshot)
  }

  function getPurchaseRowById(purchaseId: string): CoinPurchaseRow | null {
    const normalizedPurchaseId = normalizeId(purchaseId)

    if (normalizedPurchaseId.length === 0) {
      return null
    }

    const row = selectPurchaseStatement.get(normalizedPurchaseId) as
      | CoinPurchaseRow
      | undefined

    return row ?? null
  }

  function getPurchaseById(purchaseId: string): CoinPurchaseSnapshot | null {
    const row = getPurchaseRowById(purchaseId)

    return row ? rowToSnapshot(row) : null
  }

  function getPurchaseByProviderCheckoutSessionId(
    providerCheckoutSessionId: string,
  ): CoinPurchaseSnapshot | null {
    const normalizedCheckoutSessionId = normalizeProviderId(providerCheckoutSessionId)

    if (normalizedCheckoutSessionId.length === 0) {
      return null
    }

    const row = selectPurchaseByCheckoutSessionStatement.get(
      normalizedCheckoutSessionId,
    ) as CoinPurchaseRow | undefined

    return row ? rowToSnapshot(row) : null
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

  function attachCheckoutSessionToPurchase(
    purchaseId: string,
    providerCheckoutSessionId: string,
  ): { ok: true; purchase: CoinPurchaseSnapshot } | { ok: false; message: string } {
    const normalizedPurchaseId = normalizeId(purchaseId)
    const normalizedCheckoutSessionId = normalizeProviderId(providerCheckoutSessionId)

    if (normalizedPurchaseId.length === 0 || normalizedCheckoutSessionId.length === 0) {
      return {
        ok: false,
        message: 'Невалидна Stripe checkout сесия.',
      }
    }

    const existingBySession = getPurchaseByProviderCheckoutSessionId(
      normalizedCheckoutSessionId,
    )

    if (
      existingBySession !== null &&
      existingBySession.purchaseId !== normalizedPurchaseId
    ) {
      return {
        ok: false,
        message: 'Тази Stripe checkout сесия вече е вързана към друга покупка.',
      }
    }

    const purchaseBefore = getPurchaseById(normalizedPurchaseId)

    if (purchaseBefore === null) {
      return {
        ok: false,
        message: 'Покупката не беше намерена.',
      }
    }

    if (purchaseBefore.status !== 'pending') {
      return {
        ok: false,
        message: 'Покупката вече е приключена.',
      }
    }

    if (
      purchaseBefore.providerCheckoutSessionId !== null &&
      purchaseBefore.providerCheckoutSessionId !== normalizedCheckoutSessionId
    ) {
      return {
        ok: false,
        message: 'Покупката вече има друга Stripe checkout сесия.',
      }
    }

    attachCheckoutSessionStatement.run(
      normalizedCheckoutSessionId,
      normalizedPurchaseId,
      normalizedCheckoutSessionId,
    )

    const purchase = getPurchaseById(normalizedPurchaseId)

    if (purchase === null) {
      return {
        ok: false,
        message: 'Покупката не беше намерена след обновяване.',
      }
    }

    return {
      ok: true,
      purchase,
    }
  }

  function markPurchaseCanceled(
    purchaseId: string,
    providerCheckoutSessionId: string | null = null,
  ): { ok: true; purchase: CoinPurchaseSnapshot | null } | { ok: false; message: string } {
    return markPurchaseFinalStatus(purchaseId, 'canceled', providerCheckoutSessionId)
  }

  function markPurchaseFailed(
    purchaseId: string,
    providerCheckoutSessionId: string | null = null,
  ): { ok: true; purchase: CoinPurchaseSnapshot | null } | { ok: false; message: string } {
    return markPurchaseFinalStatus(purchaseId, 'failed', providerCheckoutSessionId)
  }

  function markPurchaseFinalStatus(
    purchaseId: string,
    status: Exclude<CoinPurchaseStatus, 'pending' | 'paid'>,
    providerCheckoutSessionId: string | null,
  ): { ok: true; purchase: CoinPurchaseSnapshot | null } | { ok: false; message: string } {
    const normalizedPurchaseId = normalizeId(purchaseId)
    const normalizedCheckoutSessionId =
      providerCheckoutSessionId === null
        ? null
        : normalizeProviderId(providerCheckoutSessionId)

    if (
      normalizedPurchaseId.length === 0 ||
      (providerCheckoutSessionId !== null && normalizedCheckoutSessionId?.length === 0)
    ) {
      return {
        ok: false,
        message: 'Невалидна заявка за обновяване на покупка.',
      }
    }

    const purchaseBefore = getPurchaseById(normalizedPurchaseId)

    if (purchaseBefore === null) {
      return { ok: true, purchase: null }
    }

    if (isFinalStatus(purchaseBefore.status)) {
      return { ok: true, purchase: purchaseBefore }
    }

    markStatusStatement.run(
      status,
      normalizedPurchaseId,
      normalizedCheckoutSessionId,
      normalizedCheckoutSessionId,
    )

    return {
      ok: true,
      purchase: getPurchaseById(normalizedPurchaseId),
    }
  }

  function fulfillPaidPurchase(
    input: CoinPurchaseFulfillmentInput,
  ):
    | { ok: true; purchase: CoinPurchaseSnapshot; alreadyFulfilled: boolean }
    | { ok: false; message: string } {
    const normalizedPurchaseId = normalizeId(input.purchaseId)
    const normalizedCheckoutSessionId = normalizeProviderId(
      input.providerCheckoutSessionId,
    )
    const normalizedCurrency = normalizeCurrency(input.paidCurrency)

    if (normalizedPurchaseId.length === 0 || normalizedCheckoutSessionId.length === 0) {
      return {
        ok: false,
        message: 'Невалидна платена покупка.',
      }
    }

    if (!Number.isInteger(input.paidPriceCents) || input.paidPriceCents < 0) {
      return {
        ok: false,
        message: 'Невалидна сума на платена покупка.',
      }
    }

    if (normalizedCurrency.length !== 3) {
      return {
        ok: false,
        message: 'Невалидна валута на платена покупка.',
      }
    }

    try {
      database.exec('BEGIN;')

      const purchaseRow = getPurchaseRowById(normalizedPurchaseId)

      if (purchaseRow === null) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Покупката не беше намерена.',
        }
      }

      if (
        purchaseRow.provider_checkout_session_id !== null &&
        purchaseRow.provider_checkout_session_id !== normalizedCheckoutSessionId
      ) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Stripe checkout сесията не съвпада с покупката.',
        }
      }

      if (purchaseRow.price_cents !== input.paidPriceCents) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Платената сума не съвпада с пакета.',
        }
      }

      if (purchaseRow.currency.toUpperCase() !== normalizedCurrency) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Платената валута не съвпада с пакета.',
        }
      }

      if (purchaseRow.status === 'paid' && purchaseRow.credited_at !== null) {
        database.exec('COMMIT;')
        return {
          ok: true,
          purchase: rowToSnapshot(purchaseRow),
          alreadyFulfilled: true,
        }
      }

      if (purchaseRow.status !== 'pending') {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Покупката вече е приключена без кредитиране.',
        }
      }

      ensureWalletStatement.run(purchaseRow.profile_id)
      creditWalletStatement.run(
        purchaseRow.yellow_coins_amount,
        purchaseRow.profile_id,
      )
      markPaidAndCreditedStatement.run(
        normalizedCheckoutSessionId,
        normalizedPurchaseId,
        normalizedCheckoutSessionId,
      )

      const purchaseAfter = getPurchaseById(normalizedPurchaseId)

      if (purchaseAfter === null) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Покупката не беше намерена след кредитиране.',
        }
      }

      database.exec('COMMIT;')

      return {
        ok: true,
        purchase: purchaseAfter,
        alreadyFulfilled: false,
      }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }

      return {
        ok: false,
        message:
          error instanceof Error ? error.message : 'Покупката не беше кредитирана.',
      }
    }
  }

  function close(): void {
    database.close()
  }

  return {
    listProfilePurchases,
    createPendingPurchase,
    getPurchaseById,
    getPurchaseByProviderCheckoutSessionId,
    attachCheckoutSessionToPurchase,
    markPurchaseCanceled,
    markPurchaseFailed,
    fulfillPaidPurchase,
    close,
  }
}
