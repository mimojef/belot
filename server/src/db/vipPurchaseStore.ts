import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'
import { addCalendarInterval, type VipInterval } from './vipStore.js'
import { buildPeriodWhereClause, type AdminPaymentPeriod } from './sofiaDayBounds.js'
import type { AdminPaymentListRow, AdminPaymentDetailRow, PaymentPeriodStats, AdminPaymentStats, PaymentMethodSnapshot } from './coinPurchaseStore.js'
import { composePayerVipGiftSuccessText, composeRecipientVipGiftNotificationText } from './paidGiftNotificationText.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type VipPackageId = 'vip_30' | 'vip_180' | 'vip_365'

export const VIP_PACKAGE_IDS: readonly VipPackageId[] = ['vip_30', 'vip_180', 'vip_365']

/**
 * Server-authoritative VIP package catalog — дните са code-level constants,
 * НЕ admin-editable (Магазин VIP брифа §4/§5: "Продължителностите ... са
 * фиксирани server-side и НЕ трябва да могат да се променят от admin UI").
 * `settingsKey` сочи към съответния admin_settings ред за ТЕКУЩАТА цена —
 * единственото admin-configurable поле. НЕ добавяй 90-дневен пакет тук
 * (изрично забранено в брифа).
 */
export const VIP_PACKAGE_CATALOG: Record<VipPackageId, { days: number; title: string; settingsKey: string }> = {
  vip_30: { days: 30, title: 'VIP 30 дни', settingsKey: 'vip_price_30_days_cents' },
  vip_180: { days: 180, title: 'VIP 180 дни', settingsKey: 'vip_price_180_days_cents' },
  vip_365: { days: 365, title: 'VIP 365 дни', settingsKey: 'vip_price_365_days_cents' },
}

export function isVipPackageId(value: string): value is VipPackageId {
  return (VIP_PACKAGE_IDS as readonly string[]).includes(value)
}

export type VipPurchaseStatus = 'pending' | 'paid' | 'canceled' | 'failed'

export type VipPurchaseSnapshot = {
  purchaseId: string
  packageId: VipPackageId
  days: number
  priceCents: number
  currency: string
  provider: string
  providerCheckoutSessionId: string | null
  status: VipPurchaseStatus
  creditedAt: string | null
  vipGrantId: string | null
  createdAt: string
  updatedAt: string
  /** Mirror на coinPurchaseStore.CoinPurchaseSnapshot recipient полетата — виж коментара там. */
  recipientProfileId: string | null
  recipientDisplayNameSnapshot: string | null
  /** Mirror на coinPurchaseStore.CoinPurchaseSnapshot.payerSuccessText — виж коментара там. */
  payerSuccessText: string | null
}

export type FulfillPaidVipPurchaseParams = {
  checkoutSessionId: string
  purchaseId: string
  /**
   * Stripe-съобщени факти за ТАЗИ конкретна сесия — използвани САМО за
   * server-side проверка срещу локалния snapshot (price_cents_snapshot/
   * currency), НИКОГА като authority за package/days/active_until (тези
   * идват изцяло от local ledger реда). Ако Stripe amount/currency не
   * съвпадат точно с snapshot-а, settlement се отказва — предпазва от
   * подправена/несъответстваща Stripe сесия да кредитира грешна сума дни.
   */
  stripePaymentStatus: string
  stripeCurrency: string
  stripeAmountTotalCents: number
}

export type VipPurchaseStore = {
  listProfilePurchases: (profileId: string) => VipPurchaseSnapshot[]
  createPendingPurchase: (
    profileId: string,
    packageId: VipPackageId,
    priceCents: number,
    recipientProfileId?: string | null,
  ) => { ok: true; purchase: VipPurchaseSnapshot } | { ok: false; message: string }
  getPurchaseById: (purchaseId: string) => VipPurchaseSnapshot | null
  attachCheckoutSession: (purchaseId: string, checkoutSessionId: string) => VipPurchaseSnapshot | null
  findByCheckoutSessionId: (checkoutSessionId: string) => VipPurchaseSnapshot | null
  markPurchaseCanceledByCheckoutSessionId: (checkoutSessionId: string) => void
  markPurchaseFailedByCheckoutSessionId: (checkoutSessionId: string) => void
  /**
   * Единствената atomic settlement точка — CAS (pending->paid) на
   * vip_purchase_ledger + vip_grants insert + vip_status upsert, всичко в
   * ЕДНА транзакция (VIP покупка брифа §7/§9: "27+30=57", idempotency).
   * Реimplementира vipStore.applyGrant логиката тук (не вика vipStore
   * директно) — vipStore има собствена DatabaseSync connection и собствена
   * BEGIN/COMMIT, не може безопасно да участва в ТАЗИ транзакция.
   */
  fulfillPaidPurchase: (params: FulfillPaidVipPurchaseParams) =>
    | { ok: true; purchase: VipPurchaseSnapshot; alreadyCredited: boolean; newActiveUntil: string; payerSuccessText: string | null; recipientNotificationText: string | null }
    | { ok: false; message: string }
  /**
   * Admin payment statistics contribution от VIP покупки — mirror на
   * coinPurchaseStore.getAdminPaymentStats(), reuse-ва СЪЩИЯ
   * buildPeriodWhereClause (sofiaDayBounds.ts) за identичните Europe/Sofia
   * period boundaries. Филтрира status='paid' по credited_at (settlement
   * timestamp), НЕ created_at — pending/canceled/failed VIP покупки никога
   * не допринасят. Caller-ът (server/src/index.ts) сумира резултата с
   * coinPurchaseStore.getAdminPaymentStats() за combined тотали.
   */
  getAdminPaymentStats: (now?: Date) => AdminPaymentStats
  /**
   * Admin payment listing contribution от VIP покупки — нормализиран
   * AdminPaymentListRow shape (source:'vip', yellowCoinsAmount/packageKey
   * null — VIP domain няма тия полета). Caller-ът merge-ва с coin редовете,
   * сортира по creditedAt DESC, и pagina-ва combined резултата.
   */
  getAdminPaymentListByPeriod: (params: { period: AdminPaymentPeriod; now?: Date }) => AdminPaymentListRow[]
  /** Detail lookup само по purchase_id — връща null ако редът не е VIP (caller fallback-ва към coin store). */
  getAdminPaymentDetail: (purchaseId: string) => AdminPaymentDetailRow | null
  /**
   * Payment-method snapshot contribution — mirror на coinPurchaseStore
   * needsPaymentMethodSnapshot/updatePaymentMethodSnapshot (established
   * COALESCE non-destructive semantics, виж updatePaymentMethodSnapshot
   * коментара по-долу). Webhook Step 2 enrichment (server/src/index.ts) ги
   * вика СЛЕД успешен VIP credit — enrichment failure никога не влияе на
   * вече settle-натата покупка.
   */
  needsPaymentMethodSnapshot: (purchaseId: string) => boolean
  updatePaymentMethodSnapshot: (purchaseId: string, snapshot: PaymentMethodSnapshot) => void
  close: () => void
}

type VipPurchaseRow = {
  purchase_id: string
  package_id: VipPackageId
  days_snapshot: number
  price_cents_snapshot: number
  currency: string
  provider: string
  provider_checkout_session_id: string | null
  status: VipPurchaseStatus
  credited_at: string | null
  vip_grant_id: string | null
  created_at: string
  updated_at: string
  recipient_profile_id: string | null
  recipient_display_name_snapshot: string | null
}

type VipPurchaseInternalRow = VipPurchaseRow & {
  profile_id: string
}

type VipStatusRow = {
  active_until: string
}

function rowToSnapshot(row: VipPurchaseRow): VipPurchaseSnapshot {
  // Mirror на coinPurchaseStore.rowToSnapshot payerSuccessText коментара.
  const payerSuccessText = row.status === 'paid' && row.recipient_display_name_snapshot !== null
    ? composePayerVipGiftSuccessText(row.recipient_display_name_snapshot, row.days_snapshot)
    : null

  return {
    purchaseId: row.purchase_id,
    packageId: row.package_id,
    days: row.days_snapshot,
    priceCents: row.price_cents_snapshot,
    currency: row.currency,
    provider: row.provider,
    providerCheckoutSessionId: row.provider_checkout_session_id,
    status: row.status,
    creditedAt: row.credited_at,
    vipGrantId: row.vip_grant_id,
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

const SELECT_COLUMNS = `
  purchase_id,
  package_id,
  days_snapshot,
  price_cents_snapshot,
  currency,
  provider,
  provider_checkout_session_id,
  status,
  credited_at,
  vip_grant_id,
  created_at,
  updated_at,
  recipient_profile_id,
  recipient_display_name_snapshot
`

export async function createVipPurchaseStore(
  databaseFilePath: string,
): Promise<VipPurchaseStore> {
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
    FROM vip_purchase_ledger
    WHERE profile_id = ?
    ORDER BY created_at DESC
    LIMIT 30;
  `)

  const selectPendingPurchaseStatement = database.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM vip_purchase_ledger
    WHERE profile_id = ?
      AND package_id = ?
      AND status = 'pending'
      -- Mirror на coinPurchaseStore.selectPendingPurchaseStatement коментара:
      -- recipient трябва да съвпада точно, за да не се reuse-не грешен
      -- pending ред между normal/gift или между различни recipients.
      AND recipient_profile_id IS NOT DISTINCT FROM ?
    ORDER BY created_at DESC
    LIMIT 1;
  `)

  const insertPendingPurchaseStatement = database.prepare(`
    INSERT INTO vip_purchase_ledger (
      purchase_id,
      profile_id,
      package_id,
      days_snapshot,
      price_cents_snapshot,
      currency,
      provider,
      status,
      recipient_profile_id,
      recipient_display_name_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?, 'stripe', 'pending', ?, ?);
  `)

  // Recipient eligibility — идентичен pattern на
  // coinPurchaseStore.selectGiftRecipientEligibilityStatement (виж коментара
  // там за пълния rationale).
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
    FROM vip_purchase_ledger
    WHERE purchase_id = ?
    LIMIT 1;
  `)

  const selectPurchaseWithProfileStatement = database.prepare(`
    SELECT profile_id, ${SELECT_COLUMNS}
    FROM vip_purchase_ledger
    WHERE purchase_id = ?
    LIMIT 1;
  `)

  const selectPurchaseBySessionStatement = database.prepare(`
    SELECT ${SELECT_COLUMNS}
    FROM vip_purchase_ledger
    WHERE provider_checkout_session_id = ?
    LIMIT 1;
  `)

  const selectPurchaseBySessionWithProfileStatement = database.prepare(`
    SELECT profile_id, ${SELECT_COLUMNS}
    FROM vip_purchase_ledger
    WHERE provider_checkout_session_id = ?
    LIMIT 1;
  `)

  const attachCheckoutSessionStatement = database.prepare(`
    UPDATE vip_purchase_ledger
    SET provider_checkout_session_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND status = 'pending';
  `)

  const markCanceledBySessionStatement = database.prepare(`
    UPDATE vip_purchase_ledger
    SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
    WHERE provider_checkout_session_id = ?
      AND status = 'pending';
  `)

  const markFailedBySessionStatement = database.prepare(`
    UPDATE vip_purchase_ledger
    SET status = 'failed', updated_at = CURRENT_TIMESTAMP
    WHERE provider_checkout_session_id = ?
      AND status = 'pending';
  `)

  // Payment-method snapshot — mirror на coinPurchaseStore
  // updatePaymentMethodSnapshotStatement/needsPaymentMethodSnapshotStatement
  // (20260703_001_add_payment_method_snapshot_to_coin_purchase_ledger.sql).
  // Non-destructive: COALESCE запазва вече наличните non-null стойности.
  // Webhook Step 2 enrichment и евентуален бъдещ backfill могат да викат
  // това многократно безопасно.
  const updatePaymentMethodSnapshotStatement = database.prepare(`
    UPDATE vip_purchase_ledger
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
    SELECT 1 FROM vip_purchase_ledger
    WHERE purchase_id = ?
      AND (stripe_payment_intent_id IS NULL OR payment_method_type IS NULL)
    LIMIT 1;
  `)

  // CAS guard — идентичен pattern на coinPurchaseStore markPaidByPurchaseIdStatement:
  // WHERE status='pending' гарантира, че само ЕДНО от N конкурентни webhook
  // повторения реално flip-ва реда; губещите виждат changes=0. Извиква се
  // ПРЕДИ insertVipGrantStatement (виж fulfillByInternalRow) — така губещият
  // конкурентен опит бива спрян ТУК (changes=0), вместо да стигне до
  // INSERT-а и да удари idx_vip_grants_purchase_id_once с raw constraint
  // грешка (по-грозен failure mode за same логическа причина).
  const markPaidByPurchaseIdStatement = database.prepare(`
    UPDATE vip_purchase_ledger
    SET status = 'paid', credited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ?
      AND status = 'pending';
  `)

  const attachVipGrantIdStatement = database.prepare(`
    UPDATE vip_purchase_ledger
    SET vip_grant_id = ?
    WHERE purchase_id = ?;
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

  const insertVipGrantStatement = database.prepare(`
    INSERT INTO vip_grants (
      grant_id, profile_id, reason, interval_unit, interval_amount,
      granted_by_profile_id, resulting_active_until,
      purchase_id, amount_paid_cents, currency
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
    ) VALUES (?, 'vip', ?, ?, ?);
  `)

  function listProfilePurchases(profileId: string): VipPurchaseSnapshot[] {
    const normalizedProfileId = normalizeId(profileId)
    if (normalizedProfileId.length === 0) return []
    return (selectProfilePurchasesStatement.all(normalizedProfileId) as VipPurchaseRow[]).map(rowToSnapshot)
  }

  function getPurchaseById(purchaseId: string): VipPurchaseSnapshot | null {
    const row = selectPurchaseStatement.get(purchaseId) as VipPurchaseRow | undefined
    return row ? rowToSnapshot(row) : null
  }

  function getPurchaseWithProfileById(purchaseId: string): VipPurchaseInternalRow | null {
    return (selectPurchaseWithProfileStatement.get(purchaseId) as VipPurchaseInternalRow | undefined) ?? null
  }

  function getPurchaseWithProfileBySessionId(sessionId: string): VipPurchaseInternalRow | null {
    return (selectPurchaseBySessionWithProfileStatement.get(sessionId) as VipPurchaseInternalRow | undefined) ?? null
  }

  function createPendingPurchase(
    profileId: string,
    packageId: VipPackageId,
    priceCents: number,
    recipientProfileId?: string | null,
  ): { ok: true; purchase: VipPurchaseSnapshot } | { ok: false; message: string } {
    const normalizedProfileId = normalizeId(profileId)
    if (normalizedProfileId.length === 0) {
      return { ok: false, message: 'Невалидна заявка за покупка.' }
    }
    if (!isVipPackageId(packageId)) {
      return { ok: false, message: 'Невалиден VIP пакет.' }
    }
    if (!Number.isInteger(priceCents) || priceCents < 1) {
      return { ok: false, message: 'Невалидна цена.' }
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

    const existingPending = selectPendingPurchaseStatement.get(
      normalizedProfileId,
      packageId,
      normalizedRecipientProfileId,
    ) as VipPurchaseRow | undefined

    if (existingPending) {
      return { ok: true, purchase: rowToSnapshot(existingPending) }
    }

    const purchaseId = randomUUID()
    const days = VIP_PACKAGE_CATALOG[packageId].days

    insertPendingPurchaseStatement.run(
      purchaseId,
      normalizedProfileId,
      packageId,
      days,
      priceCents,
      'EUR',
      normalizedRecipientProfileId,
      recipientDisplayName,
    )

    const purchase = getPurchaseById(purchaseId)
    if (purchase === null) {
      return { ok: false, message: 'Покупката не беше записана.' }
    }

    return { ok: true, purchase }
  }

  function attachCheckoutSession(purchaseId: string, checkoutSessionId: string): VipPurchaseSnapshot | null {
    attachCheckoutSessionStatement.run(checkoutSessionId, purchaseId)
    return getPurchaseById(purchaseId)
  }

  function findByCheckoutSessionId(checkoutSessionId: string): VipPurchaseSnapshot | null {
    const row = selectPurchaseBySessionStatement.get(checkoutSessionId) as VipPurchaseRow | undefined
    return row ? rowToSnapshot(row) : null
  }

  function markPurchaseCanceledByCheckoutSessionId(checkoutSessionId: string): void {
    markCanceledBySessionStatement.run(checkoutSessionId)
  }

  function markPurchaseFailedByCheckoutSessionId(checkoutSessionId: string): void {
    markFailedBySessionStatement.run(checkoutSessionId)
  }

  function fulfillByInternalRow(
    row: VipPurchaseInternalRow,
  ):
    | {
        ok: true
        purchase: VipPurchaseSnapshot
        alreadyCredited: boolean
        newActiveUntil: string
        payerSuccessText: string | null
        /**
         * Non-null САМО при реален нов fulfillment (alreadyCredited===false)
         * на gift покупка — index.ts webhook handler-ът го ползва за
         * realtime WS push към recipient-а. Винаги null при alreadyCredited
         * (duplicate webhook retry НЕ трябва да push-не повторно, notification
         * вече е персистиран idempotent от първия успешен fulfillment).
         */
        recipientNotificationText: string | null
      }
    | { ok: false; message: string } {
    // §15-20/§24 в брифа — наградата (VIP дни) отива на RECIPIENT-а, не на
    // PAYER-а. row.profile_id остава семантично "payer" (Stripe session
    // owner).
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
      // alreadyCredited: връщаме ТЕКУЩИЯ vip_status.active_until (не
      // resulting_active_until снапшота на grant реда) — идентичен reasoning
      // на established coinPurchaseStore alreadyCredited path: източникът на
      // истина за "текущо" състояние е винаги live таблицата, не snapshot-а.
      // Read-only lookup — безопасно дори recipient вече да не съществува
      // (просто връща undefined, SELECT не enforce-ва FK).
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
      // опитваме дори да четем/пипаме vip_status. Редът остава 'pending'.
      return {
        ok: false,
        message: 'Получателят на подаръка вече не съществува. Плащането не е кредитирано автоматично — необходим е ръчен преглед.',
      }
    }

    const rewardRecipientProfileId = wasGiftPurchase
      ? (row.recipient_profile_id as string)
      : row.profile_id

    let newActiveUntilSqlite = ''
    let recipientNotificationText: string | null = null

    try {
      // BEGIN IMMEDIATE (не deferred BEGIN) — взима write lock веднага при
      // старта на транзакцията, вместо само при първия write statement.
      // Established pattern от vipStore.ts (applyGrant/claimLaunchGift) за
      // точно този сценарий: два конкурентни webhook процеса на отделни
      // connections към същия SQLite файл. С deferred BEGIN двата могат да
      // преминат read-фазата паралелно и да се сблъскат едва на INSERT-а,
      // което наблюдавахме като "database is locked" при concurrency тест.
      database.exec('BEGIN IMMEDIATE;')

      // 27 + 30 = 57 семантиката (VIP покупка брифа §7): ако текущият
      // active_until е в бъдещето, удължаваме ОТ него; иначе тръгваме от
      // "сега". Идентична логика на vipStore.applyGrant, реimplementирана
      // тук за да остане в СЪЩАТА транзакция като ledger CAS-а по-долу.
      // §30 edge case: ако rewardRecipientProfileId вече не съществува
      // физически, insertVipGrantStatement/upsertVipStatusStatement по-долу
      // УДРЯТ FK constraint violation (vip_grants.profile_id,
      // vip_status.profile_id REFERENCES profiles) — catch блокът ROLLBACK-ва,
      // редът остава 'pending' permanently, safe-fail (mirror на
      // coinPurchaseStore.fulfillByInternalRow коментара).
      const currentStatusRow = selectVipStatusStatement.get(rewardRecipientProfileId) as VipStatusRow | undefined
      const now = new Date()
      const currentActiveUntil = currentStatusRow ? new Date(dbDateToUtc(currentStatusRow.active_until)) : null
      const extensionBase = currentActiveUntil && currentActiveUntil.getTime() > now.getTime()
        ? currentActiveUntil
        : now

      const interval: VipInterval = { unit: 'days', amount: row.days_snapshot }
      const newActiveUntil = addCalendarInterval(extensionBase, interval)
      newActiveUntilSqlite = toSqliteDateTimeString(newActiveUntil)

      // CAS ПЪРВО (без grant_id) — губещият конкурентен опит спира тук с
      // changes=0, преди изобщо да се опита INSERT в vip_grants. Редът е
      // критичен: insert-first (стар код) позволяваше на конкурентен губещ
      // процес да удари idx_vip_grants_purchase_id_once с raw UNIQUE
      // constraint грешка вместо чист "already processed" резултат.
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

      const grantId = randomUUID()
      insertVipGrantStatement.run(
        grantId,
        rewardRecipientProfileId,
        row.days_snapshot,
        newActiveUntilSqlite,
        row.purchase_id,
        row.price_cents_snapshot,
        row.currency,
      )

      attachVipGrantIdStatement.run(grantId, row.purchase_id)
      upsertVipStatusStatement.run(rewardRecipientProfileId, newActiveUntilSqlite)

      // "Подари авоари" durable recipient notification (Round 3 §5) — mirror
      // на coinPurchaseStore.ts identичния коментар/rationale. СЛЕД успешен
      // CAS+grant, ПРЕДИ COMMIT — атомарно с VIP extend-а по-горе.
      if (wasGiftPurchase) {
        const senderProfileRow = selectProfileDisplayNameStatement.get(row.profile_id) as
          | { display_name: string }
          | undefined
        const senderDisplayName = senderProfileRow?.display_name?.trim() || 'Играч'
        const bodyText = composeRecipientVipGiftNotificationText(senderDisplayName, row.days_snapshot)

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
        message: error instanceof Error ? error.message : 'Грешка при активиране на VIP.',
      }
    }

    const fulfilled = getPurchaseById(row.purchase_id)
    if (fulfilled === null) {
      return { ok: false, message: 'VIP беше активиран, но покупката не може да се прочете.' }
    }

    return { ok: true, purchase: fulfilled, alreadyCredited: false, newActiveUntil: dbDateToUtc(newActiveUntilSqlite), payerSuccessText: fulfilled.payerSuccessText, recipientNotificationText }
  }

  function fulfillPaidPurchase(
    params: FulfillPaidVipPurchaseParams,
  ):
    | { ok: true; purchase: VipPurchaseSnapshot; alreadyCredited: boolean; newActiveUntil: string; payerSuccessText: string | null; recipientNotificationText: string | null }
    | { ok: false; message: string } {
    const { checkoutSessionId, purchaseId, stripePaymentStatus, stripeCurrency, stripeAmountTotalCents } = params

    // Lookup СТРОГО по checkoutSessionId — доказва, че тази конкретна Stripe
    // сесия принадлежи на съществуващ local ledger ред (UNIQUE constraint на
    // provider_checkout_session_id гарантира 1:1). purchaseId от metadata е
    // САМО cross-check по-долу, никога самостоятелен lookup key — иначе
    // подправена/грешна metadata.purchaseId с произволна валидна сесия би
    // могла да сетълне чужд ред.
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

    // already-credited redelivery: пускаме БЕЗ повторна Stripe field проверка
    // — покупката вече е сетълната веднъж (валидирана тогава), duplicate
    // webhook само трябва да потвърди idempotently, не да пре-валидира.
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

    if (stripeAmountTotalCents !== internalRow.price_cents_snapshot) {
      return {
        ok: false,
        message: `Платената сума от Stripe (${stripeAmountTotalCents}) не съвпада с очакваната цена (${internalRow.price_cents_snapshot}).`,
      }
    }

    return fulfillByInternalRow(internalRow)
  }

  function getAdminPaymentStats(now: Date = new Date()): AdminPaymentStats {
    function query(period: AdminPaymentPeriod): PaymentPeriodStats {
      const { sql, params } = buildPeriodWhereClause(period, now, 'credited_at')
      const row = database.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(price_cents_snapshot), 0) AS total_cents
        FROM vip_purchase_ledger
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

  function getAdminPaymentListByPeriod(params: { period: AdminPaymentPeriod; now?: Date }): AdminPaymentListRow[] {
    const { period, now = new Date() } = params
    const { sql, params: whereParams } = buildPeriodWhereClause(period, now, 'vpl.credited_at')

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
      package_id: VipPackageId
      days_snapshot: number
      price_cents_snapshot: number
      currency: string
      provider: string
      status: VipPurchaseStatus
      provider_checkout_session_id: string | null
      payment_method_type: string | null
      wallet_type: string | null
      card_brand: string | null
      card_last4: string | null
      card_country: string | null
      created_at: string
      credited_at: string | null
      recipient_profile_id: string | null
      recipient_display_name_snapshot: string | null
    }

    const listRows = database.prepare(`
      SELECT
        vpl.purchase_id,
        vpl.profile_id,
        p.account_id,
        p.username,
        p.display_name,
        a.email,
        p.profile_kind,
        vpl.package_id,
        vpl.days_snapshot,
        vpl.price_cents_snapshot,
        vpl.currency,
        vpl.provider,
        vpl.status,
        vpl.provider_checkout_session_id,
        vpl.payment_method_type,
        vpl.wallet_type,
        vpl.card_brand,
        vpl.card_last4,
        vpl.card_country,
        vpl.created_at,
        vpl.credited_at,
        vpl.recipient_profile_id,
        vpl.recipient_display_name_snapshot
      FROM vip_purchase_ledger vpl
      LEFT JOIN profiles p ON p.profile_id = vpl.profile_id
      LEFT JOIN accounts a ON a.account_id = p.account_id
      WHERE vpl.status = 'paid' AND ${sql}
      ORDER BY vpl.credited_at DESC, vpl.purchase_id DESC;
    `).all(...whereParams) as ListRow[]

    return listRows.map((r): AdminPaymentListRow => ({
      source: 'vip',
      purchaseId: r.purchase_id,
      profileId: r.profile_id ?? null,
      accountId: r.account_id ?? null,
      username: r.username ?? null,
      displayName: r.display_name ?? null,
      email: r.email ?? null,
      profileKind: r.profile_kind ?? null,
      packageKey: null,
      // Explicit VIP title (брифа §7) — напр. "VIP 365 дни", никога представено
      // като coin package.
      packageTitle: VIP_PACKAGE_CATALOG[r.package_id].title,
      yellowCoinsAmount: null,
      vipDays: r.days_snapshot,
      priceCents: r.price_cents_snapshot,
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
      hiddenAt: null,
      recipientProfileId: r.recipient_profile_id ?? null,
      recipientDisplayName: r.recipient_display_name_snapshot ?? null,
    }))
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
      package_id: VipPackageId
      days_snapshot: number
      price_cents_snapshot: number
      currency: string
      provider: string
      status: VipPurchaseStatus
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
      recipient_profile_id: string | null
      recipient_display_name_snapshot: string | null
    }

    const r = database.prepare(`
      SELECT
        vpl.purchase_id,
        vpl.profile_id,
        p.account_id,
        p.username,
        p.display_name,
        a.email,
        p.profile_kind,
        vpl.package_id,
        vpl.days_snapshot,
        vpl.price_cents_snapshot,
        vpl.currency,
        vpl.provider,
        vpl.status,
        vpl.provider_checkout_session_id,
        vpl.stripe_payment_intent_id,
        vpl.stripe_charge_id,
        vpl.payment_method_type,
        vpl.wallet_type,
        vpl.card_brand,
        vpl.card_last4,
        vpl.card_country,
        vpl.created_at,
        vpl.credited_at,
        vpl.updated_at,
        vpl.recipient_profile_id,
        vpl.recipient_display_name_snapshot
      FROM vip_purchase_ledger vpl
      LEFT JOIN profiles p ON p.profile_id = vpl.profile_id
      LEFT JOIN accounts a ON a.account_id = p.account_id
      WHERE vpl.purchase_id = ?
      LIMIT 1;
    `).get(normalizeId(purchaseId)) as DetailRow | undefined

    if (!r) return null

    return {
      source: 'vip',
      purchaseId: r.purchase_id,
      profileId: r.profile_id ?? null,
      accountId: r.account_id ?? null,
      username: r.username ?? null,
      displayName: r.display_name ?? null,
      email: r.email ?? null,
      profileKind: r.profile_kind ?? null,
      packageKey: null,
      packageTitle: VIP_PACKAGE_CATALOG[r.package_id].title,
      yellowCoinsAmount: null,
      vipDays: r.days_snapshot,
      priceCents: r.price_cents_snapshot,
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
      hiddenAt: null,
      currentYellowCoinsBalance: null,
      recipientProfileId: r.recipient_profile_id ?? null,
      recipientDisplayName: r.recipient_display_name_snapshot ?? null,
    }
  }

  function needsPaymentMethodSnapshot(purchaseId: string): boolean {
    const row = needsPaymentMethodSnapshotStatement.get(purchaseId)
    return row !== undefined
  }

  function updatePaymentMethodSnapshot(purchaseId: string, snapshot: PaymentMethodSnapshot): void {
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
    getAdminPaymentStats,
    getAdminPaymentListByPeriod,
    getAdminPaymentDetail,
    close,
  }
}
