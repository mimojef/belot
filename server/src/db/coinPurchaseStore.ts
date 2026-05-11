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
  status: CoinPurchaseStatus
  createdAt: string
  updatedAt: string
}

export type CoinPurchaseStore = {
  listProfilePurchases: (profileId: string) => CoinPurchaseSnapshot[]
  createPendingPurchase: (
    profileId: string,
    packageId: string,
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
  status: CoinPurchaseStatus
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
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
      status,
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
      status,
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
      status,
      created_at,
      updated_at
    FROM coin_purchase_ledger
    WHERE purchase_id = ?;
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

  function close(): void {
    database.close()
  }

  return {
    listProfilePurchases,
    createPendingPurchase,
    close,
  }
}
