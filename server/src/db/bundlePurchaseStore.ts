import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'
import { addCalendarInterval, type VipInterval } from './vipStore.js'
import { buildPeriodWhereClause, type AdminPaymentPeriod } from './sofiaDayBounds.js'
import type { PaymentMethodSnapshot, AdminPaymentListRow, AdminPaymentDetailRow, AdminPaymentStats, PaymentPeriodStats } from './coinPurchaseStore.js'
import { composePayerBundleGiftSuccessText, composeRecipientBundleGiftNotificationText } from './paidGiftNotificationText.js'

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
  /** Mirror на coinPurchaseStore.CoinPurchaseSnapshot recipient полетата — виж коментара там. */
  recipientProfileId: string | null
  recipientDisplayNameSnapshot: string | null
  /** Mirror на coinPurchaseStore.CoinPurchaseSnapshot.payerSuccessText — виж коментара там. */
  payerSuccessText: string | null
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
    recipientProfileId?: string | null,
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
    | { ok: true; purchase: BundlePurchaseSnapshot; alreadyCredited: boolean; newActiveUntil: string; payerSuccessText: string | null; recipientNotificationText: string | null }
    | { ok: false; message: string }
  needsPaymentMethodSnapshot: (purchaseId: string) => boolean
  updatePaymentMethodSnapshot: (purchaseId: string, snapshot: PaymentMethodSnapshot) => void
  hidePurchaseForUser: (
    purchaseId: string,
    profileId: string,
  ) => { ok: true; purchase: BundlePurchaseSnapshot } | { ok: false; message: string }
  /**
   * Admin payment listing contribution от bundle покупки — mirror на
   * vipPurchaseStore.getAdminPaymentListByPeriod (whole-period, БЕЗ SQL
   * LIMIT — caller-ът top-N-ва post-hoc в паметта, идентичен established
   * combined-pagination pattern в server/src/index.ts). Нормализиран
   * AdminPaymentListRow shape (source:'bundle', И yellowCoinsAmount, И
   * vipDays non-null едновременно — единична покупка credit-ва и двете,
   * за разлика от coin/VIP, при които е само едното).
   */
  getAdminPaymentListByPeriod: (params: { period: AdminPaymentPeriod; now?: Date }) => AdminPaymentListRow[]
  /** Detail lookup само по purchase_id — връща null ако редът не е bundle (caller fallback-ва към coin/VIP store). */
  getAdminPaymentDetail: (purchaseId: string) => AdminPaymentDetailRow | null
  /**
   * Admin Info aggregate statistics contribution от bundle покупки —
   * mirror на coinPurchaseStore/vipPurchaseStore.getAdminPaymentStats()
   * (СЪЩИЯТ buildPeriodWhereClause, СЪЩИЯТ status='paid' филтър, СЪЩИЯТ
   * count+SUM(price_cents) SQL shape). Production mismatch fix: Admin Info
   * таблото (/api/admin/stats) combine-ваше само coin+VIP stats
   * (combineAdminPaymentStats в server/src/index.ts) — bundle покупки
   * бяха преброени в Admin Payments detail списъка, но НЕ в aggregate
   * count/total картите, значи двата екрана се разминаваха тихо с точно
   * bundle-ите за периода (production доказан случай: 9 vs 6 плащания,
   * 141.11€ vs 118.64€ разлика = точно 3-те bundle покупки).
   */
  getAdminPaymentStats: (now?: Date) => AdminPaymentStats
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
  recipient_profile_id: string | null
  recipient_display_name_snapshot: string | null
}

type BundlePurchaseInternalRow = BundlePurchaseRow & {
  /**
   * PAYER — вече законно NULL (20260923_004 migration, profile_id FK
   * CASCADE -> SET NULL): ако payer-ят е hard-deleted, докато редът е бил
   * 'pending', колоната се нулира от FK cascade-а, НЕ редът се трие.
   * createPendingPurchase() продължава да ИЗИСКВА реален payer при checkout
   * (профилът винаги съществува в момента на INSERT) — NULL е ЕДИНСТВЕНО
   * post-hard-delete historical state, никога стойност, избрана при
   * създаване. fulfillByInternalRow explicit safe-fail-ва normal (non-gift)
   * покупка с profile_id===null, вместо тихо да credit-не "никой" — виж
   * коментара там.
   */
  profile_id: string | null
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
  updated_at,
  recipient_profile_id,
  recipient_display_name_snapshot
`

function rowToSnapshot(row: BundlePurchaseRow): BundlePurchaseSnapshot {
  // Mirror на coinPurchaseStore.rowToSnapshot payerSuccessText коментара.
  const payerSuccessText = row.status === 'paid' && row.recipient_display_name_snapshot !== null
    ? composePayerBundleGiftSuccessText(row.recipient_display_name_snapshot, row.title_snapshot, row.yellow_coins_amount, row.vip_days_snapshot)
    : null

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
    recipientProfileId: row.recipient_profile_id ?? null,
    recipientDisplayNameSnapshot: row.recipient_display_name_snapshot ?? null,
    payerSuccessText,
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
      -- Mirror на coinPurchaseStore.selectPendingPurchaseStatement коментара:
      -- recipient трябва да съвпада точно.
      AND recipient_profile_id IS NOT DISTINCT FROM ?
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
      status,
      recipient_profile_id,
      recipient_display_name_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stripe', 'pending', ?, ?);
  `)

  // Recipient eligibility — идентичен pattern на
  // coinPurchaseStore.selectGiftRecipientEligibilityStatement.
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
  // покупка Е "purchase" семантично, не нов reason enum член.
  //
  // КРИТИЧНО (pre-deploy blocker fix, 20260923_005) — тук се пише
  // bundle_purchase_id, НИКОГА purchase_id: vip_grants.purchase_id е FK
  // СТРИКТНО към vip_purchase_ledger(purchase_id) (20260818_008, отпреди
  // bundle feature-a) — bundle_purchase_ledger.purchase_id е РАЗЛИЧЕН UUID
  // namespace, никога не съществува в vip_purchase_ledger. По-стар код тук
  // пишеше bundle purchase_id В purchase_id колоната, което би fail-нало с
  // "FOREIGN KEY constraint failed" при ВСЯКА платена bundle покупка (виж
  // 20260923_005 migration коментара за пълния rationale и production
  // verification). idx_vip_grants_bundle_purchase_id_once (mirror на
  // established idx_vip_grants_purchase_id_once) гарантира DB-level exactly-
  // once grant за bundle_purchase_id, аналогично на VIP-direct.
  const insertVipGrantStatement = database.prepare(`
    INSERT INTO vip_grants (
      grant_id, profile_id, reason, interval_unit, interval_amount,
      granted_by_profile_id, resulting_active_until,
      bundle_purchase_id, amount_paid_cents, currency
    ) VALUES (?, ?, 'purchase', 'days', ?, NULL, ?, ?, ?, ?);
  `)

  // "Подари авоари" durable recipient notification (Round 3 §5) — mirror на
  // coinPurchaseStore.ts identичните statements/rationale.
  const selectProfileDisplayNameStatement = database.prepare(`
    SELECT display_name FROM profiles WHERE profile_id = ? LIMIT 1;
  `)

  const insertPaidGiftNotificationStatement = database.prepare(`
    INSERT OR IGNORE INTO paid_gift_notification_log (
      purchase_id, purchase_type, recipient_profile_id, sender_display_name_snapshot, body_text
    ) VALUES (?, 'bundle', ?, ?, ?);
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
    recipientProfileId?: string | null,
  ): { ok: true; purchase: BundlePurchaseSnapshot } | { ok: false; message: string } {
    const normalizedProfileId = normalizeId(profileId)
    const normalizedPackageId = normalizeId(packageId)

    if (normalizedProfileId.length === 0 || normalizedPackageId.length === 0) {
      return { ok: false, message: 'Невалидна заявка за покупка.' }
    }

    // §14 в брифа — self-gift защита (mirror на coinPurchaseStore).
    const normalizedRecipientProfileId = recipientProfileId ? normalizeId(recipientProfileId) : null

    if (normalizedRecipientProfileId !== null && normalizedRecipientProfileId === normalizedProfileId) {
      return { ok: false, message: 'Не можете да подарите на себе си.' }
    }

    let recipientDisplayName: string | null = null

    if (normalizedRecipientProfileId !== null) {
      const recipientRow = selectGiftRecipientEligibilityStatement.get(
        normalizedRecipientProfileId,
      ) as { display_name: string } | undefined

      if (!recipientRow) {
        return { ok: false, message: 'Получателят не може да приеме подарък в момента.' }
      }

      recipientDisplayName = recipientRow.display_name
    }

    const activePackage = selectActivePackageStatement.get(normalizedPackageId) as ActiveBundlePackageRow | undefined

    if (!activePackage) {
      return { ok: false, message: 'Този пакет не е активен в магазина.' }
    }

    const existingPending = selectPendingPurchaseStatement.get(
      normalizedProfileId,
      normalizedPackageId,
      normalizedRecipientProfileId,
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
      normalizedRecipientProfileId,
      recipientDisplayName,
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
    | {
        ok: true
        purchase: BundlePurchaseSnapshot
        alreadyCredited: boolean
        newActiveUntil: string
        payerSuccessText: string | null
        /** Non-null САМО при реален нов fulfillment — виж identичния коментар в vipPurchaseStore.ts. */
        recipientNotificationText: string | null
      }
    | { ok: false; message: string } {
    // §15-20/§24 в брифа — и двете награди (coins + VIP дни) отиват на
    // RECIPIENT-а, не на PAYER-а. row.profile_id остава семантично "payer".
    //
    // КРИТИЧНО (review finding §1) — recipient_profile_id е FK колона с ON
    // DELETE SET NULL: ако recipient hard-delete-не се МЕЖДУ checkout и
    // fulfillment, SQLite нулира тази колона В LEDGER РЕДА веднага при
    // DELETE-а (не lazily). Старият `row.recipient_profile_id ??
    // row.profile_id` fallback-ваше грешно към PAYER-а в този сценарий
    // (доказано от checkGiftRecipientHardDeleteFallback.ts с реален FK
    // enforcement). recipient_display_name_snapshot (plain TEXT, не FK) е
    // durable gift marker — оцелява SET NULL cascade-а. Виж identичния
    // коментар в coinPurchaseStore.ts fulfillByInternalRow за пълния
    // rationale.
    const wasGiftPurchase = row.recipient_display_name_snapshot !== null

    if (row.status === 'paid' && row.credited_at !== null) {
      const alreadyCreditedTarget = wasGiftPurchase ? row.recipient_profile_id : row.profile_id
      const statusRow = alreadyCreditedTarget
        ? (selectVipStatusStatement.get(alreadyCreditedTarget) as VipStatusRow | undefined)
        : undefined
      const purchase = rowToSnapshot(row)
      return {
        ok: true,
        purchase,
        alreadyCredited: true,
        newActiveUntil: statusRow ? dbDateToUtc(statusRow.active_until) : '',
        payerSuccessText: purchase.payerSuccessText,
        recipientNotificationText: null,
      }
    }

    if (row.status !== 'pending') {
      return {
        ok: false,
        message: `Покупката е в статус "${row.status}" и не може да бъде кредитирана.`,
      }
    }

    if (wasGiftPurchase && row.recipient_profile_id === null) {
      // Recipient е бил валиден при checkout (snapshot доказва gift intent),
      // но вече физически не съществува — safe-fail explicit, БЕЗ да се
      // опитваме дори да пипнем wallet-а/VIP-а. Редът остава 'pending'.
      return {
        ok: false,
        message: 'Получателят на подаръка вече не съществува. Плащането не е кредитирано автоматично — необходим е ръчен преглед.',
      }
    }

    // 20260923_004 companion fix — normal (non-gift) покупка, чийто PAYER е
    // бил hard-deleted МЕЖДУ checkout и fulfillment. За normal покупки
    // payer==reward recipient, значи rewardRecipientProfileId по-долу би
    // станал NULL. БЕЗ тази explicit проверка ensureWalletStatement/
    // insertVipGrantStatement/upsertVipStatusStatement биха приели
    // profile_id=NULL мълчаливо — FK ON DELETE SET NULL прави NULL валидна
    // FK стойност по SQL semantics (NULL никога не violate-ва FK
    // constraint), никакво exception не се хвърля. Резултатът без тази
    // проверка: profile_wallets/vip_status биха получили "ghost" редове с
    // profile_id=NULL (SQLite НЕ enforce-ва NOT NULL върху non-INTEGER
    // PRIMARY KEY колона), а creditWalletStatement UPDATE ... WHERE
    // profile_id = NULL никога не matchва нищо по SQL NULL semantics — самата
    // награда тихо изчезва в НИКЪДЕ, вместо да отиде към payer-а или да гръмне
    // с ясна грешка. Safe-fail explicit тук, mirror на gift-recipient-missing
    // проверката по-горе — редът остава 'pending' за ръчен преглед.
    if (!wasGiftPurchase && row.profile_id === null) {
      return {
        ok: false,
        message: 'Купувачът вече не съществува. Плащането не е кредитирано автоматично — необходим е ръчен преглед.',
      }
    }

    const rewardRecipientProfileId = wasGiftPurchase
      ? (row.recipient_profile_id as string)
      : (row.profile_id as string)

    let newActiveUntilSqlite = ''
    let recipientNotificationText: string | null = null

    try {
      // BEGIN IMMEDIATE (mirror на vipPurchaseStore.fulfillByInternalRow doc
      // коментара за пълния concurrency rationale) — взима write lock
      // веднага, предотвратява "database is locked" race при конкурентни
      // webhook процеси.
      database.exec('BEGIN IMMEDIATE;')

      // 27+30=57 семантика (VIP extend, §7 в брифа) — идентична логика на
      // vipStore.applyGrant/vipPurchaseStore.fulfillByInternalRow,
      // реimplementирана тук за да остане в СЪЩАТА транзакция като wallet
      // credit-а и ledger CAS-а по-долу (§9 "atomicity/consistency"). §30
      // edge case: explicit проверката по-горе (wasGiftPurchase &&
      // recipient_profile_id===null) вече хваща типичния случай ПРЕДИ тази
      // точка. FK constraint violation тук е само defense-in-depth за race
      // (recipient изтрит между explicit-проверката и този ред) —
      // ensureWalletStatement/insertVipGrantStatement/upsertVipStatusStatement
      // по-долу пак УДРЯТ FK violation в тоя race, catch блокът ROLLBACK-ва,
      // редът остава 'pending' permanently, safe-fail.
      const currentStatusRow = selectVipStatusStatement.get(rewardRecipientProfileId) as VipStatusRow | undefined
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
          const statusRow = selectVipStatusStatement.get(rewardRecipientProfileId) as VipStatusRow | undefined
          const purchase = rowToSnapshot(fresh)
          return {
            ok: true,
            purchase,
            alreadyCredited: true,
            newActiveUntil: statusRow ? dbDateToUtc(statusRow.active_until) : '',
            payerSuccessText: purchase.payerSuccessText,
            recipientNotificationText: null,
          }
        }
        return { ok: false, message: 'Покупката вече беше обработена от друг процес.' }
      }

      // CAS спечелен от ТОЗИ процес — чак СЕГА се пипат наградите
      // (wallet credit + vip_grants insert + vip_status upsert), всички в
      // СЪЩАТА транзакция, атомарно с CAS-а по-горе.
      ensureWalletStatement.run(rewardRecipientProfileId)
      creditWalletStatement.run(row.yellow_coins_amount, rewardRecipientProfileId)

      const grantId = randomUUID()
      // row.purchase_id тук бинд-ва позиционно към bundle_purchase_id
      // колоната (виж insertVipGrantStatement SQL-а по-горе) — НЕ към
      // purchase_id (тази остава запазена изключително за VIP-direct).
      insertVipGrantStatement.run(
        grantId,
        rewardRecipientProfileId,
        row.vip_days_snapshot,
        newActiveUntilSqlite,
        row.purchase_id,
        row.price_cents,
        row.currency,
      )

      attachVipGrantIdStatement.run(grantId, row.purchase_id)
      upsertVipStatusStatement.run(rewardRecipientProfileId, newActiveUntilSqlite)

      // "Подари авоари" durable recipient notification (Round 3 §5) — mirror
      // на coinPurchaseStore.ts identичния коментар/rationale. СЛЕД успешен
      // CAS+coins+VIP grant, ПРЕДИ COMMIT — атомарно с ЦЯЛАТА bundle
      // fulfillment транзакция (coins+VIP+notification заедно).
      if (wasGiftPurchase) {
        const senderProfileRow = selectProfileDisplayNameStatement.get(row.profile_id) as
          | { display_name: string }
          | undefined
        const senderDisplayName = senderProfileRow?.display_name?.trim() || 'Играч'
        const bodyText = composeRecipientBundleGiftNotificationText(
          senderDisplayName,
          row.title_snapshot,
          row.yellow_coins_amount,
          row.vip_days_snapshot,
        )

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
        message: error instanceof Error ? error.message : 'Грешка при активиране на пакета.',
      }
    }

    const fulfilled = getPurchaseById(row.purchase_id)
    if (fulfilled === null) {
      return { ok: false, message: 'Пакетът беше активиран, но покупката не може да се прочете.' }
    }

    return { ok: true, purchase: fulfilled, alreadyCredited: false, newActiveUntil: dbDateToUtc(newActiveUntilSqlite), payerSuccessText: fulfilled.payerSuccessText, recipientNotificationText }
  }

  function fulfillPaidPurchase(
    params: FulfillPaidBundlePurchaseParams,
  ):
    | { ok: true; purchase: BundlePurchaseSnapshot; alreadyCredited: boolean; newActiveUntil: string; payerSuccessText: string | null; recipientNotificationText: string | null }
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

  // Mirror byte-for-byte на coinPurchaseStore/vipPurchaseStore.getAdminPaymentStats
  // — СЪЩИЯТ buildPeriodWhereClause, СЪЩИЯТ status='paid' филтър, СЪЩИЯТ
  // count+SUM(price_cents) shape. Caller-ът (combineAdminPaymentStats в
  // server/src/index.ts) сумира резултата с coin+VIP за Admin Info
  // aggregate картите — виж doc коментара на getAdminPaymentStats в
  // BundlePurchaseStore type-а за пълния production mismatch rationale.
  function getAdminPaymentStats(now: Date = new Date()): AdminPaymentStats {
    function query(period: AdminPaymentPeriod): PaymentPeriodStats {
      const { sql, params } = buildPeriodWhereClause(period, now, 'credited_at')
      const row = database.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(price_cents), 0) AS total_cents
        FROM bundle_purchase_ledger
        WHERE status = 'paid' AND ${sql}
      `).get(...params) as { count: number; total_cents: number }
      return { count: row.count, totalCents: row.total_cents }
    }

    return {
      today: query('today'),
      yesterday: query('yesterday'),
      last7days: query('last7days'),
      thisMonth: query('thisMonth'),
      allTime: query('allTime'),
    }
  }

  // Mirror на coinPurchaseStore/vipPurchaseStore.getAdminPaymentListByPeriod
  // — whole-period (БЕЗ SQL LIMIT), caller-ът (server/src/index.ts) top-N-ва
  // post-hoc в паметта заедно с coin/VIP резултатите (established combined-
  // pagination pattern, разширен от 2 на 3 sources).
  function getAdminPaymentListByPeriod(params: { period: AdminPaymentPeriod; now?: Date }): AdminPaymentListRow[] {
    const { period, now = new Date() } = params
    const { sql, params: whereParams } = buildPeriodWhereClause(period, now, 'bpl.credited_at')

    type ListRow = {
      purchase_id: string
      profile_id: string | null
      account_id: string | null
      username: string | null
      display_name: string | null
      email: string | null
      profile_kind: string | null
      package_key_snapshot: string
      title_snapshot: string
      yellow_coins_amount: number
      vip_days_snapshot: number
      price_cents: number
      currency: string
      provider: string
      status: BundlePurchaseStatus
      provider_checkout_session_id: string | null
      payment_method_type: string | null
      wallet_type: string | null
      card_brand: string | null
      card_last4: string | null
      card_country: string | null
      created_at: string
      credited_at: string | null
      hidden_at: string | null
      recipient_profile_id: string | null
      recipient_display_name_snapshot: string | null
    }

    const listRows = database.prepare(`
      SELECT
        bpl.purchase_id,
        bpl.profile_id,
        p.account_id,
        p.username,
        p.display_name,
        a.email,
        p.profile_kind,
        bpl.package_key_snapshot,
        bpl.title_snapshot,
        bpl.yellow_coins_amount,
        bpl.vip_days_snapshot,
        bpl.price_cents,
        bpl.currency,
        bpl.provider,
        bpl.status,
        bpl.provider_checkout_session_id,
        bpl.payment_method_type,
        bpl.wallet_type,
        bpl.card_brand,
        bpl.card_last4,
        bpl.card_country,
        bpl.created_at,
        bpl.credited_at,
        bpl.hidden_at,
        bpl.recipient_profile_id,
        bpl.recipient_display_name_snapshot
      FROM bundle_purchase_ledger bpl
      LEFT JOIN profiles p ON p.profile_id = bpl.profile_id
      LEFT JOIN accounts a ON a.account_id = p.account_id
      WHERE bpl.status = 'paid' AND ${sql}
      ORDER BY bpl.credited_at DESC, bpl.purchase_id DESC;
    `).all(...whereParams) as ListRow[]

    return listRows.map((r): AdminPaymentListRow => ({
      source: 'bundle',
      purchaseId: r.purchase_id,
      profileId: r.profile_id ?? null,
      accountId: r.account_id ?? null,
      username: r.username ?? null,
      displayName: r.display_name ?? null,
      email: r.email ?? null,
      profileKind: r.profile_kind ?? null,
      packageKey: r.package_key_snapshot,
      packageTitle: r.title_snapshot,
      yellowCoinsAmount: r.yellow_coins_amount,
      vipDays: r.vip_days_snapshot,
      priceCents: r.price_cents,
      currency: r.currency.toUpperCase(),
      provider: r.provider,
      status: r.status,
      providerCheckoutSessionId: r.provider_checkout_session_id ?? null,
      paymentMethodType: r.payment_method_type ?? null,
      walletType: r.wallet_type ?? null,
      cardBrand: r.card_brand ?? null,
      cardLast4: r.card_last4 ?? null,
      cardCountry: r.card_country ?? null,
      createdAt: dbDateToUtc(r.created_at),
      creditedAt: r.credited_at ? dbDateToUtc(r.credited_at) : null,
      hiddenAt: r.hidden_at ? dbDateToUtc(r.hidden_at) : null,
      recipientProfileId: r.recipient_profile_id ?? null,
      recipientDisplayName: r.recipient_display_name_snapshot ?? null,
    }))
  }

  // Mirror на coinPurchaseStore.getAdminPaymentDetail (LEFT JOIN profile_wallets
  // за currentYellowCoinsBalance — bundle покупки credit-ват coins, за
  // разлика от VIP-only detail-а). JOIN-ва по profile_id (PAYER), established
  // pattern — не разграничава gift recipient balance (mirror на coin/VIP
  // detail-а, който прави същото).
  function getAdminPaymentDetail(purchaseId: string): AdminPaymentDetailRow | null {
    type DetailRow = {
      purchase_id: string
      profile_id: string | null
      account_id: string | null
      username: string | null
      display_name: string | null
      email: string | null
      profile_kind: string | null
      package_key_snapshot: string
      title_snapshot: string
      yellow_coins_amount: number
      vip_days_snapshot: number
      price_cents: number
      currency: string
      provider: string
      status: BundlePurchaseStatus
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
      recipient_profile_id: string | null
      recipient_display_name_snapshot: string | null
    }

    const r = database.prepare(`
      SELECT
        bpl.purchase_id,
        bpl.profile_id,
        p.account_id,
        p.username,
        p.display_name,
        a.email,
        p.profile_kind,
        bpl.package_key_snapshot,
        bpl.title_snapshot,
        bpl.yellow_coins_amount,
        bpl.vip_days_snapshot,
        bpl.price_cents,
        bpl.currency,
        bpl.provider,
        bpl.status,
        bpl.provider_checkout_session_id,
        bpl.stripe_payment_intent_id,
        bpl.stripe_charge_id,
        bpl.payment_method_type,
        bpl.wallet_type,
        bpl.card_brand,
        bpl.card_last4,
        bpl.card_country,
        bpl.created_at,
        bpl.credited_at,
        bpl.updated_at,
        bpl.hidden_at,
        bpl.recipient_profile_id,
        bpl.recipient_display_name_snapshot,
        pw.yellow_coins_balance
      FROM bundle_purchase_ledger bpl
      LEFT JOIN profiles p ON p.profile_id = bpl.profile_id
      LEFT JOIN accounts a ON a.account_id = p.account_id
      LEFT JOIN profile_wallets pw ON pw.profile_id = bpl.profile_id
      WHERE bpl.purchase_id = ?
      LIMIT 1;
    `).get(normalizeId(purchaseId)) as DetailRow | undefined

    if (!r) return null

    return {
      source: 'bundle',
      purchaseId: r.purchase_id,
      profileId: r.profile_id ?? null,
      accountId: r.account_id ?? null,
      username: r.username ?? null,
      displayName: r.display_name ?? null,
      email: r.email ?? null,
      profileKind: r.profile_kind ?? null,
      packageKey: r.package_key_snapshot,
      packageTitle: r.title_snapshot,
      yellowCoinsAmount: r.yellow_coins_amount,
      vipDays: r.vip_days_snapshot,
      priceCents: r.price_cents,
      currency: r.currency.toUpperCase(),
      provider: r.provider,
      status: r.status,
      providerCheckoutSessionId: r.provider_checkout_session_id ?? null,
      stripePaymentIntentId: r.stripe_payment_intent_id ?? null,
      stripeChargeId: r.stripe_charge_id ?? null,
      paymentMethodType: r.payment_method_type ?? null,
      walletType: r.wallet_type ?? null,
      cardBrand: r.card_brand ?? null,
      cardLast4: r.card_last4 ?? null,
      cardCountry: r.card_country ?? null,
      createdAt: dbDateToUtc(r.created_at),
      creditedAt: r.credited_at ? dbDateToUtc(r.credited_at) : null,
      updatedAt: dbDateToUtc(r.updated_at),
      hiddenAt: r.hidden_at ? dbDateToUtc(r.hidden_at) : null,
      currentYellowCoinsBalance: r.yellow_coins_balance ?? null,
      recipientProfileId: r.recipient_profile_id ?? null,
      recipientDisplayName: r.recipient_display_name_snapshot ?? null,
    }
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
    getAdminPaymentListByPeriod,
    getAdminPaymentDetail,
    getAdminPaymentStats,
    close,
  }
}
