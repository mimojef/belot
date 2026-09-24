import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'
import { buildPeriodWhereClause, type AdminPaymentPeriod as SharedAdminPaymentPeriod } from './sofiaDayBounds.js'
import { composePayerCoinGiftSuccessText, composeRecipientCoinGiftNotificationText } from './paidGiftNotificationText.js'

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
  /**
   * "Подари авоари" (Paid Gift Shop) payer/recipient split. NULL => normal
   * purchase (payer==recipient); non-NULL => gift purchase, сочи towards
   * получателя. НИКОГА authoritative от client — resolve-нат server-side при
   * createPendingPurchase, snapshot-нат тук immutable за историята.
   */
  recipientProfileId: string | null
  /** Display name snapshot на получателя В МОМЕНТА на покупката — преживява recipient hard-delete. */
  recipientDisplayNameSnapshot: string | null
  /**
   * §3 в брифа — payer success popup текст ("Вие успешно подарихте на
   * <recipient> <reward>."), computed от immutable snapshot данни. Non-null
   * САМО за paid (status='paid') gift покупки; normal self-purchase остава
   * null винаги (established success поведение непроменено).
   */
  payerSuccessText: string | null
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

// Re-exported от sofiaDayBounds.ts (shared с vipPurchaseStore.ts) — запазва
// съществуващия import contract (server/src/index.ts import-ва
// ADMIN_PAYMENT_PERIODS от тук), без дублиране на дефиницията.
export { ADMIN_PAYMENT_PERIODS } from './sofiaDayBounds.js'
export type AdminPaymentPeriod = SharedAdminPaymentPeriod

// source различава coin ('/api/shop/checkout') от VIP ('/api/vip/checkout')
// покупки в combined admin payment listing-а (виж getAdminPaymentListByPeriod
// в server/src/index.ts, който merge-ва coin+VIP резултати). VIP редовете
// НЯМАТ yellowCoinsAmount/packageKey/payment-method snapshot полета (различна
// domain схема — vip_purchase_ledger) — тия полета остават null за тях,
// НИКОГА не се "измислят" за VIP.
export type AdminPaymentSource = 'coin' | 'vip'

export type AdminPaymentListRow = {
  source: AdminPaymentSource
  purchaseId: string
  // NULL за исторически redове, чийто payer профил е hard-deleted
  // (ON DELETE SET NULL, виж 20260902_002).
  profileId: string | null
  accountId: string | null
  username: string | null
  displayName: string | null
  email: string | null
  profileKind: string | null
  packageKey: string | null
  packageTitle: string
  yellowCoinsAmount: number | null
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
  source: AdminPaymentSource
  purchaseId: string
  // NULL за исторически redове, чийто payer профил е hard-deleted
  // (ON DELETE SET NULL, виж 20260902_002).
  profileId: string | null
  accountId: string | null
  username: string | null
  displayName: string | null
  email: string | null
  profileKind: string | null
  packageKey: string | null
  packageTitle: string
  yellowCoinsAmount: number | null
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
    recipientProfileId?: string | null,
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
    | { ok: true; purchase: CoinPurchaseSnapshot; alreadyCredited: boolean; payerSuccessText: string | null; recipientNotificationText: string | null }
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
  recipient_profile_id: string | null
  recipient_display_name_snapshot: string | null
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
  // §3 в брифа — payerSuccessText е computed derived field (не персистиран
  // отделно) от immutable snapshot полетата на ТОЗИ ред: non-null само за
  // paid gift покупки, независимо КЪДЕ/КОГА снапшотът се чете (fulfillment
  // резултат ИЛИ по-късен listProfilePurchases/getPurchaseById lookup за
  // polling след Stripe redirect) — единна логика, computed веднъж тук.
  const payerSuccessText = row.status === 'paid' && row.recipient_display_name_snapshot !== null
    ? composePayerCoinGiftSuccessText(row.recipient_display_name_snapshot, row.yellow_coins_amount)
    : null

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
    recipientProfileId: row.recipient_profile_id ?? null,
    recipientDisplayNameSnapshot: row.recipient_display_name_snapshot ?? null,
    payerSuccessText,
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
      updated_at,
      recipient_profile_id,
      recipient_display_name_snapshot
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
      updated_at,
      recipient_profile_id,
      recipient_display_name_snapshot
    FROM coin_purchase_ledger
    WHERE profile_id = ?
      AND package_id = ?
      AND status = 'pending'
      AND hidden_at IS NULL
      -- Recipient трябва да съвпада точно (§21/§14 в брифа: normal purchase
      -- НЕ трябва да reuse-не gift pending ред и обратно, gift-за-X НЕ трябва
      -- да reuse-не gift-за-Y pending ред). IS NOT DISTINCT FROM третира
      -- NULL=NULL като match (normal==normal), докато обикновен '=' би
      -- пропуснал NULL-срещу-NULL сравнения в SQLite.
      AND recipient_profile_id IS NOT DISTINCT FROM ?
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
      status,
      recipient_profile_id,
      recipient_display_name_snapshot
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
      'pending',
      ?,
      ?
    );
  `)

  // Recipient eligibility (§13 в брифа) — reuse established
  // registered-human WHERE clause (friendshipStore.selectRegisteredHumanProfileStatement:
  // profile_kind='human' AND status='active' AND account_id IS NOT NULL),
  // РАЗШИРЕН тук с is_temporary=0 (guest/temporary профили изключени — нямат
  // стабилна самоличност за paid reward target) И explicit active-ban
  // изключване (profile_bans.lifted_at IS NULL AND banned_until >
  // CURRENT_TIMESTAMP — profiles.status НИКОГА не се променя от banProfile(),
  // виж profileBanStore.ts, затова status='active' сам по себе си НЕ
  // изключва банnат профил). Bot профили изрично изключени — нямат account
  // и не могат легитимно да бъдат gift recipient за paid покупка.
  const selectGiftRecipientEligibilityStatement = database.prepare(`
    SELECT p.display_name AS display_name
    FROM profiles p
    WHERE p.profile_id = ?
      AND p.profile_kind = 'human'
      AND p.status = 'active'
      AND p.account_id IS NOT NULL
      AND p.is_temporary = 0
      AND NOT EXISTS (
        SELECT 1 FROM profile_bans pb
        WHERE pb.profile_id = p.profile_id
          AND pb.lifted_at IS NULL
          AND pb.banned_until > CURRENT_TIMESTAMP
      )
    LIMIT 1;
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
      updated_at,
      recipient_profile_id,
      recipient_display_name_snapshot
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
      updated_at,
      recipient_profile_id,
      recipient_display_name_snapshot
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
      updated_at,
      recipient_profile_id,
      recipient_display_name_snapshot
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
      updated_at,
      recipient_profile_id,
      recipient_display_name_snapshot
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
      updated_at,
      recipient_profile_id,
      recipient_display_name_snapshot
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

  // "Подари авоари" durable recipient notification (Round 3 §5) — payer
  // display name snapshot в МОМЕНТА на fulfillment (не checkout момента).
  // Read-only, безопасно дори payer вече да е изтрит (връща undefined,
  // fallback към generic текст по-долу) — SELECT никога не enforce-ва FK.
  const selectProfileDisplayNameStatement = database.prepare(`
    SELECT display_name FROM profiles WHERE profile_id = ? LIMIT 1;
  `)

  // INSERT OR IGNORE + composite PK (purchase_id, purchase_type) —
  // duplicate webhook/fulfillment retry е natural no-op idempotency guard
  // (mirror на established gift_notification_log.gift_id PK pattern,
  // 20260923_003 migration коментара). Извиква се ВЪТРЕ в fulfillment
  // BEGIN/COMMIT-а по-долу — durable-first invariant: reward commit и
  // notification create успяват/провалят се АТОМАРНО заедно.
  const insertPaidGiftNotificationStatement = database.prepare(`
    INSERT OR IGNORE INTO paid_gift_notification_log (
      purchase_id, purchase_type, recipient_profile_id, sender_display_name_snapshot, body_text
    ) VALUES (?, 'coin', ?, ?, ?);
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
    recipientProfileId?: string | null,
  ): { ok: true; purchase: CoinPurchaseSnapshot } | { ok: false; message: string } {
    const normalizedProfileId = normalizeId(profileId)
    const normalizedPackageId = normalizeId(packageId)

    if (normalizedProfileId.length === 0 || normalizedPackageId.length === 0) {
      return {
        ok: false,
        message: 'Невалидна заявка за покупка.',
      }
    }

    // §14 в брифа — self-gift защита, backend задължителна: recipient !=
    // purchaser се проверява ПРЕДИ каквото и да е друго recipient
    // resolution, за да не изтече дори eligibility грешка вместо ясния
    // self-gift отказ.
    const normalizedRecipientProfileId = recipientProfileId ? normalizeId(recipientProfileId) : null

    if (normalizedRecipientProfileId !== null && normalizedRecipientProfileId === normalizedProfileId) {
      return {
        ok: false,
        message: 'Не можете да подарите на себе си.',
      }
    }

    let recipientDisplayName: string | null = null

    if (normalizedRecipientProfileId !== null) {
      // §12/§13 в брифа — recipient се resolve-ва canonical server-side,
      // client-provided displayName НИКОГА не е authoritative. Eligibility
      // WHERE clause (виж selectGiftRecipientEligibilityStatement по-горе)
      // изключва bot/disabled/temporary/guest/banned профили.
      const recipientRow = selectGiftRecipientEligibilityStatement.get(
        normalizedRecipientProfileId,
      ) as { display_name: string } | undefined

      if (!recipientRow) {
        return {
          ok: false,
          message: 'Получателят не може да приеме подарък в момента.',
        }
      }

      recipientDisplayName = recipientRow.display_name
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
      normalizedRecipientProfileId,
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
      normalizedRecipientProfileId,
      recipientDisplayName,
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
    | { ok: true; purchase: CoinPurchaseSnapshot; alreadyCredited: boolean; payerSuccessText: string | null; recipientNotificationText: string | null }
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
    | {
        ok: true
        purchase: CoinPurchaseSnapshot
        alreadyCredited: boolean
        payerSuccessText: string | null
        /** Non-null САМО при реален нов fulfillment — виж identичния коментар в vipPurchaseStore.ts. */
        recipientNotificationText: string | null
      }
    | { ok: false; message: string } {
    if (row.status === 'paid' && row.credited_at !== null) {
      // alreadyCredited: purchase.payerSuccessText вече е computed от
      // rowToSnapshot (immutable snapshot данни) — безопасно за повторно
      // връщане при duplicate webhook (caller-ът решава дали вече е показал
      // success popup-а, виж index.ts wiring).
      const purchase = rowToSnapshot(row)
      return { ok: true, purchase, alreadyCredited: true, payerSuccessText: purchase.payerSuccessText, recipientNotificationText: null }
    }

    if (row.status !== 'pending') {
      return {
        ok: false,
        message: `Покупката е в статус "${row.status}" и не може да бъде кредитирана.`,
      }
    }

    // §15-20/§24 в брифа — наградата отива на RECIPIENT-а, не на PAYER-а.
    // row.profile_id остава семантично "payer" навсякъде (Stripe checkout
    // session собственик).
    //
    // КРИТИЧНО (review finding §1) — recipient_profile_id САМО ПО СЕБЕ СИ
    // НЕ Е безопасен gift discriminator: то е FK колона с ON DELETE SET
    // NULL, значи ако recipient профилът бъде hard-deleted МЕЖДУ checkout и
    // fulfillment, SQLite нулира ТОЧНО тази колона В LEDGER РЕДА веднага
    // при DELETE-а (cascade се изпълнява синхронно, не lazily) — ПРЕДИ
    // webhook-ът изобщо да прочете реда. Старият код
    // `row.recipient_profile_id ?? row.profile_id` следователно fallback-ваше
    // към PAYER-а точно в този сценарий (доказано от
    // checkGiftRecipientHardDeleteFallback.ts с реален FK enforcement, БЕЗ
    // PRAGMA foreign_keys=OFF заобикаляне) — payer погрешно получаваше
    // чуждата gift награда. recipient_display_name_snapshot (plain TEXT, НЕ
    // FK) е durable gift marker — той НЕ се засяга от SET NULL cascade-а и
    // остава non-null завинаги за всеки ред, който Е бил gift, независимо
    // дали recipient-ът по-късно изчезва физически. Затова discriminator-ът
    // тук е snapshot текста, не FK колоната:
    //   - recipient_display_name_snapshot === null  => НИКОГА не е бил gift
    //     (истински normal purchase) => payer==recipient established.
    //   - recipient_display_name_snapshot !== null   => Е бил gift =>
    //     recipient_profile_id казва КЪМ КОГО точно сега (жив recipient) или
    //     NULL (recipient вече не съществува) — в НИКОЙ от двата случая
    //     payer не е валиден fallback target.
    const wasGiftPurchase = row.recipient_display_name_snapshot !== null

    if (wasGiftPurchase && row.recipient_profile_id === null) {
      // Recipient е бил валиден при checkout (snapshot доказва gift intent),
      // но вече физически не съществува — safe-fail explicit, БЕЗ да се
      // опитваме дори да пипнем wallet-а. Редът остава 'pending' (не
      // 'failed') — идентично поведение на §30 permanently-pending
      // договорката, само достигнато с explicit проверка вместо разчитане
      // на FK constraint exception по-долу.
      return {
        ok: false,
        message: 'Получателят на подаръка вече не съществува. Плащането не е кредитирано автоматично — необходим е ръчен преглед.',
      }
    }

    const rewardRecipientProfileId = wasGiftPurchase
      ? (row.recipient_profile_id as string)
      : row.profile_id

    let recipientNotificationText: string | null = null

    try {
      database.exec('BEGIN;')

      // Defense-in-depth: ако recipient профилът изчезне В ТОЧНИЯ момент
      // между горната explicit проверка и тук (race срещу конкурентен hard
      // delete), ensureWalletStatement/creditWalletStatement пак УДРЯТ FK
      // constraint violation (profile_wallets.profile_id REFERENCES
      // profiles), catch блокът по-долу ROLLBACK-ва, редът остава 'pending'
      // permanently — safe-fail, НИКАКВА награда никога не отива към payer-а
      // или друг профил.
      ensureWalletStatement.run(rewardRecipientProfileId)
      creditWalletStatement.run(row.yellow_coins_amount, rewardRecipientProfileId)

      const updateResult = markPaidByPurchaseIdStatement.run(row.purchase_id) as {
        changes?: number
      }

      if ((updateResult.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')

        const fresh = getPurchaseWithProfileById(row.purchase_id)

        if (fresh?.status === 'paid') {
          const purchase = rowToSnapshot(fresh)
          return { ok: true, purchase, alreadyCredited: true, payerSuccessText: purchase.payerSuccessText, recipientNotificationText: null }
        }

        return { ok: false, message: 'Покупката вече беше обработена от друг процес.' }
      }

      // "Подари авоари" durable recipient notification (Round 3 §5) — СЛЕД
      // успешен CAS (тоя процес спечели reward claim-а), ПРЕДИ COMMIT —
      // notification INSERT участва в СЪЩАТА транзакция като reward credit-а
      // по-горе: ако процесът crash-не тук, ROLLBACK-ва и двете заедно
      // (нито reward, нито notification); ако COMMIT-не успешно, и двете
      // committed заедно. Durable-first invariant, no partial states.
      if (wasGiftPurchase) {
        const senderProfileRow = selectProfileDisplayNameStatement.get(row.profile_id) as
          | { display_name: string }
          | undefined
        const senderDisplayName = senderProfileRow?.display_name?.trim() || 'Играч'
        const bodyText = composeRecipientCoinGiftNotificationText(senderDisplayName, row.yellow_coins_amount)

        insertPaidGiftNotificationStatement.run(
          row.purchase_id,
          rewardRecipientProfileId,
          senderDisplayName,
          bodyText,
        )
        recipientNotificationText = bodyText
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

    return { ok: true, purchase: fulfilled, alreadyCredited: false, payerSuccessText: fulfilled.payerSuccessText, recipientNotificationText }
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
      // profile_id е NULL за исторически redове, чийто payer е hard-deleted
      // (ON DELETE SET NULL, виж 20260902_002) — deleted_profile_id_snapshot
      // пази forensic reference, но не участва в тази заявка.
      profile_id: string | null
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
      source:                      'coin' as const,
      purchaseId:                  r.purchase_id,
      profileId:                   r.profile_id ?? null,
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
      // profile_id е NULL за исторически redове, чийто payer е hard-deleted
      // (ON DELETE SET NULL, виж 20260902_002).
      profile_id: string | null
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
      source:                     'coin' as const,
      purchaseId:                 r.purchase_id,
      profileId:                  r.profile_id ?? null,
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
