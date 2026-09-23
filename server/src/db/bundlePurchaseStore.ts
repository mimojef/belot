import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'
import { addCalendarInterval, type VipInterval } from './vipStore.js'
import type { PaymentMethodSnapshot } from './coinPurchaseStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type BundlePurchaseStatus = 'pending' | 'paid' | 'canceled' | 'failed'

export type BundlePurchaseSnapshot = {
  purchaseId: string
  packageId: string | null
  packageKeySnapshot: string
  titleSnapshot: string
  yellowCoinsAmount: number
  vipDays: number
  priceCents: number
  currency: string
  provider: string
  providerCheckoutSessionId: string | null
  status: BundlePurchaseStatus
  creditedAt: string | null
  hiddenAt: string | null
  createdAt: string
  updatedAt: string
}

export type FulfillPaidBundlePurchaseParams = {
  checkoutSessionId: string
  purchaseId: string
  /**
   * Stripe-съобщени факти за ТАЗИ конкретна сесия — САМО за server-side
   * cross-check срещу локалния snapshot (price_cents/currency), НИКОГА
   * authority за coins/vip_days/active_until (mirror на
   * vipPurchaseStore.FulfillPaidVipPurchaseParams-a rationale).
   */
  stripePaymentStatus: string
  stripeCurrency: string
  stripeAmountTotalCents: number
}

export type BundlePurchaseStore = {
  listProfilePurchases: (profileId: string) => BundlePurchaseSnapshot[]
  createPendingPurchase: (
    profileId: string,
    packageId: string,
  ) => { ok: true; purchase: BundlePurchaseSnapshot } | { ok: false; message: string }
  getPurchaseById: (purchaseId: string) => BundlePurchaseSnapshot | null
  attachCheckoutSession: (purchaseId: string, checkoutSessionId: string) => BundlePurchaseSnapshot | null
  findByCheckoutSessionId: (checkoutSessionId: string) => BundlePurchaseSnapshot | null
  markPurchaseCanceledByCheckoutSessionId: (checkoutSessionId: string) => void
  markPurchaseFailedByCheckoutSessionId: (checkoutSessionId: string) => void
  /**
   * Единствената atomic settlement точка за bundle покупки — CAS
   * (pending->paid) на bundle_purchase_ledger + wallet credit (coins) +
   * vip_grants insert + vip_status upsert (VIP extend), ВСИЧКО в ЕДНА
   * транзакция (Магазин Пакети брифа §8/§9: "и двете награди трябва да
   * принадлежат на ЕДНА покупка", "не трябва да стига до състояние
   * жълтиците са дадени, VIP не е даден"). Реimplementира
   * coinPurchaseStore.fulfillByInternalRow (wallet credit CAS) И
   * vipPurchaseStore.fulfillByInternalRow (VIP extend CAS) логиката тук
   * директно (не ги вика) — и двата store-а имат собствени DatabaseSync
   * connections и собствен BEGIN/COMMIT, не могат безопасно да участват в
   * ТАЗИ обща транзакция (идентичен reasoning като
   * vipPurchaseStore.fulfillByInternalRow doc коментара).
   */
  fulfillPaidPurchase: (params: FulfillPaidBundlePurchaseParams) =>
    | { ok: true; purchase: BundlePurchaseSnapshot; alreadyCredited: boolean; newActiveUntil: string }
    | { ok: false; message: string }
  needsPaymentMethodSnapshot: (purchaseId: string) => boolean
  updatePaymentMethodSnapshot: (purchaseId: string, snapshot: PaymentMethodSnapshot) => void
  hidePurchaseForUser: (
    purchaseId: string,
    profileId: string,
  ) => { ok: true; purchase: BundlePurchaseSnapshot } | { ok: false; message: string }
  close: () => void
}

type BundlePurchaseRow = {
  purchase_id: string
  package_id: string | null
  package_key_snapshot: string
  title_snapshot: string
  yellow_coins_amount: number
  vip_days_snapshot: number
  price_cents: number
  currency: string
  provider: string
  provider_checkout_session_id: string | null
  status: BundlePurchaseStatus
  credited_at: string | null
  hidden_at: string | null
  created_at: string
  updated_at: string
}

type BundlePurchaseInternalRow = BundlePurchaseRow & {
  profile_id: string
}

type ActiveBundlePackageRow = {
  package_id: string
  package_key: string
  title: string
  yellow_coins_amount: number
  vip_days: number
  price_cents: number
  currency: string
}

type VipStatusRow = {
  active_until: string
}

const SELECT_COLUMNS = `
  purchase_id,
  package_id,
  package_key_snapshot,
  title_snapshot,
  yellow_coins_amount,
  vip_days_snapshot,
  price_cents,
  currency,
  provider,
  provider_checkout_session_id,
  status,
  credited_at,
  hidden_at,
  created_at,
  updated_at
`

function rowToSnapshot(row: BundlePurchaseRow): BundlePurchaseSnapshot {
  return {
    purchaseId: row.purchase_id,
    packageId: row.package_id,
    packageKeySnapshot: row.package_key_snapshot,
    titleSnapshot: row.title_snapshot,
    yellowCoinsAmount: row.yellow_coins_amount,
    vipDays: row.vip_days_snapshot,
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

function toSqliteDateTimeString(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

export async function createBundlePurchaseStore(
  databaseFilePath: string,
): Promise<BundlePurchaseStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectProfilePurchasesStatement = database.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM bundle_purchase_ledger
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
      vip_days,
      price_cents,
      currency
    FROM shop_bundle_packages
    WHERE package_id = ?
      AND status = 'active';
  `)

  const selectPendingPurchaseStatement = database.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM bundle_purchase_ledger
    WHERE profile_id = ?
      AND package_id = ?
      AND status = 'pending'
      AND hidden_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;
  `)

  const insertPendingPurchaseStatement = database.prepare(`
    INSERT INTO bundle_purchase_ledger (
      purchase_id,
      profile_id,
      package_id,
      package_key_snapshot,
      title_snapshot,
      yellow_coins_amount,
      vip_days_snapshot,
      price_cents,
      currency,
      provider,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stripe', 'pending');
  `)

  const selectPurchaseStatement = database.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM bundle_purchase_ledger
    WHERE purchase_id = ?
    LIMIT 1;
  `)

  const selectPurchaseWithProfileStatement = database.prepare(`
    SELECT profile_id, ${SELECT_COLUMNS}
    FROM bundle_purchase_ledger
    WHERE purchase_id = ?
    LIMIT 1;
  `)

  const selectPurchaseBySessionStatement = database.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM bundle_purchase_ledger
    WHERE provider_checkout_session_id = ?
    LIMIT 1;
  `)

  const selectPurchaseBySessionWithProfileStatement = database.prepare(`
    SELECT profile_id, ${SELECT_COLUMNS}
    FROM bundle_purchase_ledger
    WHERE provider_checkout_session_id = ?
    LIMIT 1;
  `)

  const attachCheckoutSessionStatement = database.prepare(`
    UPDATE bundle_purchase_ledger
    SET provider_checkout_session_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND status = 'pending';
  `)

  const markCanceledBySessionStatement = database.prepare(`
    UPDATE bundle_purchase_ledger
    SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
    WHERE provider_checkout_session_id = ?
      AND status = 'pending';
  `)

  const markFailedBySessionStatement = database.prepare(`
    UPDATE bundle_purchase_ledger
    SET status = 'failed', updated_at = CURRENT_TIMESTAMP
    WHERE provider_checkout_session_id = ?
      AND status = 'pending';
  `)

  const hidePurchaseStatement = database.prepare(`
    UPDATE bundle_purchase_ledger
    SET hidden_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND profile_id = ?
      AND hidden_at IS NULL;
  `)

  const updatePaymentMethodSnapshotStatement = database.prepare(`
    UPDATE bundle_purchase_ledger
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
    SELECT 1 FROM bundle_purchase_ledger
    WHERE purchase_id = ?
      AND (stripe_payment_intent_id IS NULL OR payment_method_type IS NULL)
    LIMIT 1;
  `)

  // CAS guard — идентичен pattern на coinPurchaseStore/vipPurchaseStore
  // markPaidByPurchaseIdStatement: WHERE status='pending' гарантира само
  // ЕДНО от N конкурентни webhook повторения реално flip-ва реда.
  const markPaidByPurchaseIdStatement = database.prepare(`
    UPDATE bundle_purchase_ledger
    SET status = 'paid', credited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND status = 'pending';
  `)

  const attachVipGrantIdStatement = database.prepare(`
    UPDATE bundle_purchase_ledger
    SET vip_grant_id = ?
    WHERE purchase_id = ?;
  `)

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 0)
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const creditWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET yellow_coins_balance = yellow_coins_balance + ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  const selectVipStatusStatement = database.prepare(`
    SELECT active_until FROM vip_status WHERE profile_id = ? LIMIT 1;
  `)

  const upsertVipStatusStatement = database.prepare(`
    INSERT INTO vip_status (profile_id, active_until, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(profile_id) DO UPDATE SET
      active_until = excluded.active_until,
      updated_at = CURRENT_TIMESTAMP;
  `)

  // reason='purchase' reuse-нат (vip_grants CHECK constraint вече го
  // допуска, виж 20260810_001_create_vip_status_and_grants.sql) — bundle
  // покупка Е "purchase" семантично, не нов reason enum член. purchase_id
  // тук сочи bundle_purchase_ledger.purchase_id (различен UUID namespace от
  // vip_purchase_ledger) — idx_vip_grants_purchase_id_once partial index
  // покрива И двата източника заедно.
  const insertVipGrantStatement = database.prepare(`
    INSERT INTO vip_grants (
      grant_id, profile_id, reason, interval_unit, interval_amount,
      granted_by_profile_id, resulting_active_until,
      purchase_id, amount_paid_cents, currency
    ) VALUES (?, ?, 'purchase', 'days', ?, NULL, ?, ?, ?, ?);
  `)

  function listProfilePurchases(profileId: string): BundlePurchaseSnapshot[] {
    const normalizedProfileId = normalizeId(profileId)
    if (normalizedProfileId.length === 0) return []
    return (selectProfilePurchasesStatement.all(normalizedProfileId) as BundlePurchaseRow[]).map(rowToSnapshot)
  }

  function getPurchaseById(purchaseId: string): BundlePurchaseSnapshot | null {
    const row = selectPurchaseStatement.get(purchaseId) as BundlePurchaseRow | undefined
    return row ? rowToSnapshot(row) : null
  }

  function getPurchaseWithProfileById(purchaseId: string): BundlePurchaseInternalRow | null {
    return (selectPurchaseWithProfileStatement.get(purchaseId) as BundlePurchaseInternalRow | undefined) ?? null
  }

  function getPurchaseWithProfileBySessionId(sessionId: string): BundlePurchaseInternalRow | null {
    return (selectPurchaseBySessionWithProfileStatement.get(sessionId) as BundlePurchaseInternalRow | undefined) ?? null
  }

  // Клиентът праща САМО packageId (§3 "Frontend трябва да изпраща само
  // идентификатора на избрания пакет") — coins/vip_days/price идват ИЗЦЯЛО
  // от активния DB ред тук, никога от client input.
  function createPendingPurchase(
    profileId: string,
    packageId: string,
  ): { ok: true; purchase: BundlePurchaseSnapshot } | { ok: false; message: string } {
    const normalizedProfileId = normalizeId(profileId)
    const normalizedPackageId = normalizeId(packageId)

    if (normalizedProfileId.length === 0 || normalizedPackageId.length === 0) {
      return { ok: false, message: 'Невалидна заявка за покупка.' }
    }

    const activePackage = selectActivePackageStatement.get(normalizedPackageId) as ActiveBundlePackageRow | undefined

    if (!activePackage) {
      return { ok: false, message: 'Този пакет не е активен в магазина.' }
    }

    const existingPending = selectPendingPurchaseStatement.get(
      normalizedProfileId,
      normalizedPackageId,
    ) as BundlePurchaseRow | undefined

    if (existingPending) {
      return { ok: true, purchase: rowToSnapshot(existingPending) }
    }

    const purchaseId = randomUUID()

    insertPendingPurchaseStatement.run(
      purchaseId,
      normalizedProfileId,
      activePackage.package_id,
      activePackage.package_key,
      activePackage.title,
      activePackage.yellow_coins_amount,
      activePackage.vip_days,
      activePackage.price_cents,
      activePackage.currency,
    )

    const purchase = getPurchaseById(purchaseId)

    if (purchase === null) {
      return { ok: false, message: 'Покупката не беше записана.' }
    }

    return { ok: true, purchase }
  }

  function attachCheckoutSession(purchaseId: string, checkoutSessionId: string): BundlePurchaseSnapshot | null {
    attachCheckoutSessionStatement.run(checkoutSessionId, purchaseId)
    return getPurchaseById(purchaseId)
  }

  function findByCheckoutSessionId(checkoutSessionId: string): BundlePurchaseSnapshot | null {
    const row = selectPurchaseBySessionStatement.get(checkoutSessionId) as BundlePurchaseRow | undefined
    return row ? rowToSnapshot(row) : null
  }

  function markPurchaseCanceledByCheckoutSessionId(checkoutSessionId: string): void {
    markCanceledBySessionStatement.run(checkoutSessionId)
  }

  function markPurchaseFailedByCheckoutSessionId(checkoutSessionId: string): void {
    markFailedBySessionStatement.run(checkoutSessionId)
  }

  function fulfillByInternalRow(
    row: BundlePurchaseInternalRow,
  ):
    | { ok: true; purchase: BundlePurchaseSnapshot; alreadyCredited: boolean; newActiveUntil: string }
    | { ok: false; message: string } {
    if (row.status === 'paid' && row.credited_at !== null) {
      const statusRow = selectVipStatusStatement.get(row.profile_id) as VipStatusRow | undefined
      return {
        ok: true,
        purchase: rowToSnapshot(row),
        alreadyCredited: true,
        newActiveUntil: statusRow ? dbDateToUtc(statusRow.active_until) : '',
      }
    }

    if (row.status !== 'pending') {
      return {
        ok: false,
        message: `Покупката е в статус "${row.status}" и не може да бъде кредитирана.`,
      }
    }

    let newActiveUntilSqlite = ''

    try {
      // BEGIN IMMEDIATE (mirror на vipPurchaseStore.fulfillByInternalRow doc
      // коментара за пълния concurrency rationale) — взима write lock
      // веднага, предотвратява "database is locked" race при конкурентни
      // webhook процеси.
      database.exec('BEGIN IMMEDIATE;')

      // 27+30=57 семантика (VIP extend, §7 в брифа) — идентична логика на
      // vipStore.applyGrant/vipPurchaseStore.fulfillByInternalRow,
      // реimplementирана тук за да остане в СЪЩАТА транзакция като wallet
      // credit-а и ledger CAS-а по-долу (§9 "atomicity/consistency").
      const currentStatusRow = selectVipStatusStatement.get(row.profile_id) as VipStatusRow | undefined
      const now = new Date()
      const currentActiveUntil = currentStatusRow ? new Date(dbDateToUtc(currentStatusRow.active_until)) : null
      const extensionBase = currentActiveUntil && currentActiveUntil.getTime() > now.getTime()
        ? currentActiveUntil
        : now

      const interval: VipInterval = { unit: 'days', amount: row.vip_days_snapshot }
      const newActiveUntil = addCalendarInterval(extensionBase, interval)
      newActiveUntilSqlite = toSqliteDateTimeString(newActiveUntil)

      // CAS ПЪРВО, ПРЕДИ КАКВАТО И ДА Е REWARD MUTATION (wallet credit ИЛИ
      // vip_grants insert) — губещият конкурентен опит спира тук с
      // changes=0, преди да докосне wallet-а или vip_grants (mirror на
      // vipPurchaseStore.fulfillByInternalRow doc коментара за "insert-first
      // би ударил raw UNIQUE constraint" rationale, разширено тук и до
      // wallet credit-а: никаква награда не се пипа, докато CAS claim-ът не
      // е потвърдено спечелен от ТОЗИ процес).
      const updateResult = markPaidByPurchaseIdStatement.run(row.purchase_id) as { changes?: number }

      if ((updateResult.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')

        const fresh = getPurchaseWithProfileById(row.purchase_id)
        if (fresh?.status === 'paid') {
          const statusRow = selectVipStatusStatement.get(row.profile_id) as VipStatusRow | undefined
          return {
            ok: true,
            purchase: rowToSnapshot(fresh),
            alreadyCredited: true,
            newActiveUntil: statusRow ? dbDateToUtc(statusRow.active_until) : '',
          }
        }
        return { ok: false, message: 'Покупката вече беше обработена от друг процес.' }
      }

      // CAS спечелен от ТОЗИ процес — чак СЕГА се пипат наградите
      // (wallet credit + vip_grants insert + vip_status upsert), всички в
      // СЪЩАТА транзакция, атомарно с CAS-а по-горе.
      ensureWalletStatement.run(row.profile_id)
      creditWalletStatement.run(row.yellow_coins_amount, row.profile_id)

      const grantId = randomUUID()
      insertVipGrantStatement.run(
        grantId,
        row.profile_id,
        row.vip_days_snapshot,
        newActiveUntilSqlite,
        row.purchase_id,
        row.price_cents,
        row.currency,
      )

      attachVipGrantIdStatement.run(grantId, row.purchase_id)
      upsertVipStatusStatement.run(row.profile_id, newActiveUntilSqlite)

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original error
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Грешка при активиране на пакета.',
      }
    }

    const fulfilled = getPurchaseById(row.purchase_id)
    if (fulfilled === null) {
      return { ok: false, message: 'Пакетът беше активиран, но покупката не може да се прочете.' }
    }

    return { ok: true, purchase: fulfilled, alreadyCredited: false, newActiveUntil: dbDateToUtc(newActiveUntilSqlite) }
  }

  function fulfillPaidPurchase(
    params: FulfillPaidBundlePurchaseParams,
  ):
    | { ok: true; purchase: BundlePurchaseSnapshot; alreadyCredited: boolean; newActiveUntil: string }
    | { ok: false; message: string } {
    const { checkoutSessionId, purchaseId, stripePaymentStatus, stripeCurrency, stripeAmountTotalCents } = params

    if (!checkoutSessionId) {
      return { ok: false, message: 'Липсва checkout session id.' }
    }

    const internalRow = getPurchaseWithProfileBySessionId(checkoutSessionId)

    if (internalRow === null) {
      return { ok: false, message: 'Покупката не беше намерена за тази checkout сесия.' }
    }

    if (purchaseId && internalRow.purchase_id !== purchaseId) {
      return { ok: false, message: 'Несъответствие между checkout сесията и purchaseId.' }
    }

    if (internalRow.status === 'paid' && internalRow.credited_at !== null) {
      return fulfillByInternalRow(internalRow)
    }

    if (stripePaymentStatus !== 'paid') {
      return { ok: false, message: `Stripe payment_status "${stripePaymentStatus}" не е "paid".` }
    }

    if (stripeCurrency.toUpperCase() !== internalRow.currency.toUpperCase()) {
      return {
        ok: false,
        message: `Валутата от Stripe (${stripeCurrency}) не съвпада с очакваната (${internalRow.currency}).`,
      }
    }

    if (stripeAmountTotalCents !== internalRow.price_cents) {
      return {
        ok: false,
        message: `Платената сума от Stripe (${stripeAmountTotalCents}) не съвпада с очакваната цена (${internalRow.price_cents}).`,
      }
    }

    return fulfillByInternalRow(internalRow)
  }

  function needsPaymentMethodSnapshot(purchaseId: string): boolean {
    const row = needsPaymentMethodSnapshotStatement.get(purchaseId)
    return row !== undefined
  }

  function updatePaymentMethodSnapshot(purchaseId: string, snapshot: PaymentMethodSnapshot): void {
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
  ): { ok: true; purchase: BundlePurchaseSnapshot } | { ok: false; message: string } {
    const normalizedPurchaseId = normalizeId(purchaseId)
    const normalizedProfileId = normalizeId(profileId)

    if (normalizedPurchaseId.length === 0 || normalizedProfileId.length === 0) {
      return { ok: false, message: 'Невалидна покупка.' }
    }

    hidePurchaseStatement.run(normalizedPurchaseId, normalizedProfileId)

    const updated = getPurchaseById(normalizedPurchaseId)
    if (updated === null) {
      return { ok: false, message: 'Покупката не беше намерена.' }
    }

    return { ok: true, purchase: updated }
  }

  function close(): void {
    database.close()
  }

  return {
    listProfilePurchases,
    createPendingPurchase,
    getPurchaseById,
    attachCheckoutSession,
    findByCheckoutSessionId,
    markPurchaseCanceledByCheckoutSessionId,
    markPurchaseFailedByCheckoutSessionId,
    fulfillPaidPurchase,
    needsPaymentMethodSnapshot,
    updatePaymentMethodSnapshot,
    hidePurchaseForUser,
    close,
  }
}
