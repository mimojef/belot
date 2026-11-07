// "Персонализация на профила" — единственият достъп до базата за
// настройките, каталога, регистъра на покупките и текущите активни екстри
// (миграция 20261107_001_create_profile_customization.sql).
//
// Платежният поток е mirror на vipPurchaseStore.ts (същата Stripe
// инфраструктура, не паралелна): createPendingPurchase -> Stripe Checkout ->
// fulfillPaidPurchase, извикан САМО от webhook-а за checkout.session.completed.
// Клиентски redirect не активира нищо.
//
// Правила при кредитиране (в ЕДНА BEGIN IMMEDIATE транзакция с CAS
// pending->paid, така че повторен/конкурентен webhook не кредитира два пъти):
//   * същият артикул е активен      -> 'extend':  срокът += дните;
//   * друг артикул е активен         -> 'replace': новият е активен веднага,
//                                       оставащото време на стария се губи;
//   * няма активен (или е изтекъл)   -> 'new':     нова верига от сега.
// Четирите вида са напълно независими (отделен ред в
// profile_customization_active на (profile_id, kind)).
//
// Refund (applyRefund): пълното възстановяване маркира покупката 'refunded'.
// Ако тя е от ТЕКУЩАТА верига, срокът се преизчислява като
// начало_на_веригата + сума(дни на оставащите платени покупки във веригата) —
// следващите удължавания запазват всичките си дни, а само възстановените дни
// изчезват. Покупка от вече заменена верига не променя текущата екстра.
// Частичното възстановяване се записва, без да променя правата (за преглед).
//
// Store-ът не проверява feature flag-а — това е отговорност на HTTP/WS
// слоя (profileCustomizationFeatureFlag.ts), за да може webhook-ът винаги да
// кредитира вече платени поръчки.

import { randomUUID } from 'node:crypto'
import type { PurchaseFulfillmentFailure } from '../db/purchaseFulfillmentFailure.js'
import { isTransientDatabaseError } from '../db/classifyFulfillmentError.js'
import type { PaymentMethodSnapshot } from '../db/coinPurchaseStore.js'
import {
  PROFILE_CUSTOMIZATION_COLOR_LABEL_MAX_LENGTH,
  PROFILE_CUSTOMIZATION_DAY_MS,
  PROFILE_CUSTOMIZATION_KINDS,
  PROFILE_CUSTOMIZATION_KIND_LABELS,
  buildProfileCustomizationPriceTable,
  computeProfileCustomizationColorContrast,
  computeProfileCustomizationPriceCents,
  computeProfileCustomizationRemainingDays,
  getProfileCustomizationItemType,
  isProfileCustomizationColorGroup,
  isProfileCustomizationDurationDays,
  isProfileCustomizationEmojiCategory,
  isProfileCustomizationKind,
  isReservedOrNearReservedStaffColor,
  isValidProfileCustomizationBasePriceCents,
  normalizeProfileCustomizationEmoji,
  normalizeProfileCustomizationHex,
  type ProfileCustomizationColorContrast,
  type ProfileCustomizationColorGroup,
  type ProfileCustomizationDurationDays,
  type ProfileCustomizationEmojiCategory,
  type ProfileCustomizationItemType,
  type ProfileCustomizationKind,
} from './profileCustomizationCatalog.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

// ─── Публични типове ─────────────────────────────────────────────────────

export type ProfileCustomizationKindSettings = {
  kind: ProfileCustomizationKind
  label: string
  itemType: ProfileCustomizationItemType
  basePrice30DaysCents: number
  salesEnabled: boolean
  priceTable: Array<{ days: ProfileCustomizationDurationDays; priceCents: number }>
  updatedAt: string
}

export type ProfileCustomizationColor = {
  colorId: string
  hex: string
  label: string
  groupKey: ProfileCustomizationColorGroup
  sortOrder: number
  isActive: boolean
  contrast: ProfileCustomizationColorContrast
  createdAt: string
  updatedAt: string
}

export type ProfileCustomizationEmoji = {
  emojiId: string
  emoji: string
  categoryKey: ProfileCustomizationEmojiCategory
  sortOrder: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type ProfileCustomizationActiveItem = {
  kind: ProfileCustomizationKind
  itemId: string
  /** '#RRGGBB' за цветовете, самото емоджи за емоджитата (snapshot от покупката). */
  value: string
  label: string | null
  chainStartedAt: string
  activeUntil: string
  remainingDays: number
}

/**
 * Само визуалните стойности — за груповото извличане при показване на
 * съобщения (Етап 3). *Until е изтичането на съответната екстра (ISO) —
 * клиентът спира да я показва в този момент, без нова заявка/polling.
 */
export type ProfileCustomizationAppearance = {
  nicknameColor: string | null
  nicknameColorUntil: string | null
  messageColor: string | null
  messageColorUntil: string | null
  emojiBefore: string | null
  emojiBeforeUntil: string | null
  emojiAfter: string | null
  emojiAfterUntil: string | null
}

/**
 * Това, което се изпраща към клиента за показване. standardDefaults=false
 * означава "ограничен изглед": клиентът запазва досегашното оцветяване и
 * прилага само изрично закупените стойности (виж index.ts, политиката по зрител).
 */
export type ProfileCustomizationDisplay = ProfileCustomizationAppearance & { standardDefaults: boolean }

/** Режим на достъп — виж profile_customization_mode_changes в миграцията. */
export type ProfileCustomizationAccessMode = 'admin_only' | 'public'

export type ProfileCustomizationAccessState = {
  mode: ProfileCustomizationAccessMode
  changedAt: string | null
  changedByProfileId: string | null
  changedByDisplayName: string | null
}

export type ProfileCustomizationModeChange = {
  changeId: string
  mode: ProfileCustomizationAccessMode
  previousMode: ProfileCustomizationAccessMode
  changedByDisplayName: string | null
  changedAt: string
}

export type ProfileCustomizationPurchaseStatus = 'pending' | 'paid' | 'canceled' | 'failed' | 'refunded'

export type ProfileCustomizationGrantEffect = 'new' | 'extend' | 'replace'

export type ProfileCustomizationRefundReviewStatus = 'pending' | 'reviewed'

export type ProfileCustomizationRefundReviewReason = 'partial_refund' | 'refund_failed'

export type ProfileCustomizationPurchaseSnapshot = {
  purchaseId: string
  kind: ProfileCustomizationKind
  itemId: string
  itemValue: string
  itemLabel: string | null
  days: ProfileCustomizationDurationDays
  basePrice30DaysCents: number
  priceCents: number
  currency: string
  provider: string
  providerCheckoutSessionId: string | null
  status: ProfileCustomizationPurchaseStatus
  creditedAt: string | null
  grantEffect: ProfileCustomizationGrantEffect | null
  chainId: string | null
  grantedUntil: string | null
  replacedItemValue: string | null
  replacedActiveUntil: string | null
  refundedAt: string | null
  refundedAmountCents: number | null
  /** 'pending' = частичен refund, чака администраторски преглед. */
  refundReviewStatus: ProfileCustomizationRefundReviewStatus | null
  refundReviewReason: ProfileCustomizationRefundReviewReason | null
  refundReviewedAt: string | null
  refundReviewedByDisplayName: string | null
  createdAt: string
  updatedAt: string
}

export type ProfileCustomizationFailureCode =
  | 'invalid_request'
  | 'invalid_kind'
  | 'invalid_duration'
  | 'profile_not_eligible'
  | 'sales_disabled'
  | 'item_not_found'
  | 'item_not_for_sale'
  | 'reserved_color'
  | 'invalid_price'
  | 'invalid_color'
  | 'invalid_emoji'
  | 'invalid_label'
  | 'invalid_group'
  | 'invalid_category'
  | 'duplicate'
  | 'not_found'

export type ProfileCustomizationFailure = { ok: false; code: ProfileCustomizationFailureCode; message: string }

export type ProfileCustomizationPurchasePreview = {
  kind: ProfileCustomizationKind
  item: { itemId: string; value: string; label: string | null; isForSale: boolean }
  days: ProfileCustomizationDurationDays
  basePrice30DaysCents: number
  priceCents: number
  currency: 'EUR'
  /**
   * Очакваният ефект СПОРЕД ТЕКУЩОТО състояние. Окончателният ефект се
   * определя при кредитирането (между двете състоянието може да се промени).
   */
  effect: ProfileCustomizationGrantEffect
  current: ProfileCustomizationActiveItem | null
  /** Само при 'replace' — оставащите дни на текущата екстра, които ще се загубят. */
  forfeitedDays: number
  resultingActiveUntil: string
}

export type FulfillPaidProfileCustomizationPurchaseParams = {
  checkoutSessionId: string
  purchaseId: string
  stripePaymentStatus: string
  stripeCurrency: string
  stripeAmountTotalCents: number
  /** Записва се веднага, за да може refund да намери покупката и без enrichment. */
  stripePaymentIntentId: string | null
  now?: Date
}

export type FulfillPaidProfileCustomizationPurchaseResult =
  | {
      ok: true
      purchase: ProfileCustomizationPurchaseSnapshot
      payerProfileId: string | null
      alreadyCredited: boolean
      /** Покупката е възстановена (refund) преди да бъде кредитирана — нищо не е активирано. */
      refundedBeforeCredit: boolean
      active: ProfileCustomizationActiveItem | null
    }
  | PurchaseFulfillmentFailure

export type ApplyProfileCustomizationRefundParams = {
  checkoutSessionId?: string | null
  paymentIntentId?: string | null
  /** Кумулативната възстановена сума от Stripe (charge.amount_refunded). */
  refundedAmountCents: number
  stripeEventId: string
  now?: Date
}

export type ApplyProfileCustomizationRefundResult =
  | {
      ok: true
      outcome:
        | 'revoked'
        | 'partial_recorded'
        | 'recorded_before_credit'
        | 'already_refunded'
        | 'recorded_without_grant'
      purchase: ProfileCustomizationPurchaseSnapshot
      /** Текущата екстра от този вид след refund-а (null = няма активна). */
      activeAfter: ProfileCustomizationActiveItem | null
    }
  | { ok: false; reason: 'purchase_not_found' | 'invalid_request' | 'refund_failed'; transient?: boolean; message: string }

export type ProfileCustomizationAdminPurchaseRow = ProfileCustomizationPurchaseSnapshot & {
  profileId: string | null
  displayName: string | null
  username: string | null
  email: string | null
  paymentMethodType: string | null
  cardBrand: string | null
  cardLast4: string | null
}

export type ProfileCustomizationAdminKindStats = {
  kind: ProfileCustomizationKind
  paidCount: number
  paidTotalCents: number
  refundedCount: number
  refundedTotalCents: number
  activeNowCount: number
}

export type ProfileCustomizationKindSettingsPatch = {
  basePrice30DaysCents?: number
  salesEnabled?: boolean
}

export type ProfileCustomizationColorPatch = {
  label?: string
  groupKey?: string
  sortOrder?: number
  isActive?: boolean
}

export type ProfileCustomizationEmojiPatch = {
  categoryKey?: string
  sortOrder?: number
  isActive?: boolean
}

export type ProfileCustomizationStore = {
  // Настройки
  listKindSettings: () => ProfileCustomizationKindSettings[]
  updateKindSettings: (kind: string, patch: ProfileCustomizationKindSettingsPatch) => { ok: true; settings: ProfileCustomizationKindSettings } | ProfileCustomizationFailure
  // Каталог
  listColors: (options?: { includeInactive?: boolean }) => ProfileCustomizationColor[]
  addColor: (input: { hex: string; label: string; groupKey: string }) => { ok: true; color: ProfileCustomizationColor } | ProfileCustomizationFailure
  updateColor: (colorId: string, patch: ProfileCustomizationColorPatch) => { ok: true; color: ProfileCustomizationColor } | ProfileCustomizationFailure
  listEmojis: (options?: { includeInactive?: boolean }) => ProfileCustomizationEmoji[]
  addEmoji: (input: { emoji: string; categoryKey: string }) => { ok: true; emoji: ProfileCustomizationEmoji } | ProfileCustomizationFailure
  updateEmoji: (emojiId: string, patch: ProfileCustomizationEmojiPatch) => { ok: true; emoji: ProfileCustomizationEmoji } | ProfileCustomizationFailure
  // Активни екстри
  getProfileActiveItems: (profileId: string, now?: Date) => Record<ProfileCustomizationKind, ProfileCustomizationActiveItem | null>
  /**
   * Групово извличане за показване на съобщения: ЕДНА заявка на до 500
   * профила (не заявка на автор/съобщение). Профил без активни екстри липсва
   * от map-а.
   */
  getAppearancesForProfiles: (profileIds: readonly string[], now?: Date) => Map<string, ProfileCustomizationAppearance>
  // Покупки
  /**
   * ignoreSalesToggle — само за пълен admin в режим "Само админ" (тест на
   * реалния поток, без да се включва публичната продажба на екстрата).
   */
  previewPurchase: (input: { profileId: string; kind: string; itemId: string; days: number; now?: Date; ignoreSalesToggle?: boolean }) => { ok: true; preview: ProfileCustomizationPurchasePreview } | ProfileCustomizationFailure
  createPendingPurchase: (input: { profileId: string; kind: string; itemId: string; days: number; now?: Date; ignoreSalesToggle?: boolean }) => { ok: true; purchase: ProfileCustomizationPurchaseSnapshot; preview: ProfileCustomizationPurchasePreview } | ProfileCustomizationFailure
  getPurchaseById: (purchaseId: string) => ProfileCustomizationPurchaseSnapshot | null
  getPurchaseOwnerProfileId: (purchaseId: string) => string | null
  listProfilePurchases: (profileId: string) => ProfileCustomizationPurchaseSnapshot[]
  attachCheckoutSession: (purchaseId: string, checkoutSessionId: string) => ProfileCustomizationPurchaseSnapshot | null
  retirePendingPurchase: (purchaseId: string) => boolean
  findByCheckoutSessionId: (checkoutSessionId: string) => ProfileCustomizationPurchaseSnapshot | null
  /** Само ако сесията е на този профил (връщане от Stripe) — иначе null. */
  findProfilePurchaseByCheckoutSessionId: (profileId: string, checkoutSessionId: string) => ProfileCustomizationPurchaseSnapshot | null
  markPurchaseCanceledByCheckoutSessionId: (checkoutSessionId: string) => void
  markPurchaseFailedByCheckoutSessionId: (checkoutSessionId: string) => void
  fulfillPaidPurchase: (params: FulfillPaidProfileCustomizationPurchaseParams) => FulfillPaidProfileCustomizationPurchaseResult
  applyRefund: (params: ApplyProfileCustomizationRefundParams) => ApplyProfileCustomizationRefundResult
  needsPaymentMethodSnapshot: (purchaseId: string) => boolean
  updatePaymentMethodSnapshot: (purchaseId: string, snapshot: PaymentMethodSnapshot) => void
  // Режим на достъп
  getAccessState: () => ProfileCustomizationAccessState
  /** Записва нов режим (одит: кой/кога). Същият режим -> без нов запис. */
  setAccessMode: (mode: ProfileCustomizationAccessMode, actor: { profileId: string | null; displayName: string | null }) => { changed: boolean; state: ProfileCustomizationAccessState }
  listModeChanges: (limit: number) => ProfileCustomizationModeChange[]
  // Админ
  listAdminPurchases: (input: { limit: number; offset: number; status?: string | null }) => { rows: ProfileCustomizationAdminPurchaseRow[]; total: number }
  getAdminKindStats: (now?: Date) => ProfileCustomizationAdminKindStats[]
  countPendingRefundReviews: () => number
  /** Записва кой admin е прегледал и кога (само ако покупката чака преглед). */
  markRefundReviewed: (purchaseId: string, actor?: { profileId: string | null; displayName: string | null }) => boolean
  /**
   * Stripe refund е неуспешен/отменен (refund.failed / refund.updated /
   * charge.refund.updated). Нищо не се възстановява автоматично (по-нова
   * покупка/замяна може да е валидна) — покупката се маркира за преглед с
   * причина 'refund_failed'. Idempotent по Stripe refund id.
   */
  recordRefundFailure: (params: { checkoutSessionId?: string | null; paymentIntentId?: string | null; stripeRefundId: string; stripeEventId: string; now?: Date }) =>
    | { ok: true; outcome: 'marked_for_review' | 'already_recorded'; purchase: ProfileCustomizationPurchaseSnapshot }
    | { ok: false; reason: 'purchase_not_found' | 'invalid_request'; message: string }
  close: () => void
}

// ─── Вътрешни редове ─────────────────────────────────────────────────────

type KindSettingsRow = {
  kind: ProfileCustomizationKind
  base_price_30_days_cents: number
  sales_enabled: number
  updated_at: string
}

type ColorRow = {
  color_id: string
  hex: string
  label: string
  group_key: ProfileCustomizationColorGroup
  sort_order: number
  is_active: number
  created_at: string
  updated_at: string
}

type EmojiRow = {
  emoji_id: string
  emoji: string
  category_key: ProfileCustomizationEmojiCategory
  sort_order: number
  is_active: number
  created_at: string
  updated_at: string
}

type ActiveRow = {
  profile_id: string
  kind: ProfileCustomizationKind
  item_id: string
  item_value_snapshot: string
  item_label_snapshot: string | null
  chain_id: string
  chain_started_at: string
  active_until: string
}

type PurchaseRow = {
  purchase_id: string
  profile_id: string | null
  kind: ProfileCustomizationKind
  item_id: string
  item_value_snapshot: string
  item_label_snapshot: string | null
  days_snapshot: ProfileCustomizationDurationDays
  base_price_30_days_cents_snapshot: number
  price_cents_snapshot: number
  currency: string
  provider: string
  provider_checkout_session_id: string | null
  status: ProfileCustomizationPurchaseStatus
  credited_at: string | null
  grant_effect: ProfileCustomizationGrantEffect | null
  chain_id: string | null
  granted_until_snapshot: string | null
  replaced_item_value_snapshot: string | null
  replaced_active_until_snapshot: string | null
  refunded_at: string | null
  refunded_amount_cents: number | null
  refund_review_status: ProfileCustomizationRefundReviewStatus | null
  refund_review_reason: ProfileCustomizationRefundReviewReason | null
  refund_reviewed_at: string | null
  refund_reviewed_by_display_name_snapshot: string | null
  refund_failed_refund_id: string | null
  stripe_payment_intent_id: string | null
  created_at: string
  updated_at: string
}

type CatalogItem = { itemId: string; value: string; label: string | null; isActive: boolean }

const PURCHASE_COLUMNS = `
  purchase_id, profile_id, kind, item_id, item_value_snapshot, item_label_snapshot,
  days_snapshot, base_price_30_days_cents_snapshot, price_cents_snapshot, currency,
  provider, provider_checkout_session_id, status, credited_at, grant_effect, chain_id,
  granted_until_snapshot, replaced_item_value_snapshot, replaced_active_until_snapshot,
  refunded_at, refunded_amount_cents, refund_review_status, refund_review_reason, refund_reviewed_at,
  refund_reviewed_by_display_name_snapshot, refund_failed_refund_id, stripe_payment_intent_id, created_at, updated_at
`

// SQLite лимитът за bind параметри е много по-висок, но страниците в
// Лафче/Теми са до 200 автора — chunk-ът е само предпазител.
const APPEARANCE_BATCH_CHUNK_SIZE = 500

const ADMIN_PURCHASE_STATUSES: readonly ProfileCustomizationPurchaseStatus[] = ['pending', 'paid', 'canceled', 'failed', 'refunded']

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 96) : ''
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * PROFILE_CUSTOMIZATION_DAY_MS).toISOString()
}

function failure(code: ProfileCustomizationFailureCode, message: string): ProfileCustomizationFailure {
  return { ok: false, code, message }
}

function rowToPurchase(row: PurchaseRow): ProfileCustomizationPurchaseSnapshot {
  return {
    purchaseId: row.purchase_id,
    kind: row.kind,
    itemId: row.item_id,
    itemValue: row.item_value_snapshot,
    itemLabel: row.item_label_snapshot,
    days: row.days_snapshot,
    basePrice30DaysCents: row.base_price_30_days_cents_snapshot,
    priceCents: row.price_cents_snapshot,
    currency: row.currency,
    provider: row.provider,
    providerCheckoutSessionId: row.provider_checkout_session_id,
    status: row.status,
    creditedAt: row.credited_at,
    grantEffect: row.grant_effect,
    chainId: row.chain_id,
    grantedUntil: row.granted_until_snapshot,
    replacedItemValue: row.replaced_item_value_snapshot,
    replacedActiveUntil: row.replaced_active_until_snapshot,
    refundedAt: row.refunded_at,
    refundedAmountCents: row.refunded_amount_cents,
    refundReviewStatus: row.refund_review_status ?? null,
    refundReviewReason: row.refund_review_reason ?? null,
    refundReviewedAt: row.refund_reviewed_at ?? null,
    refundReviewedByDisplayName: row.refund_reviewed_by_display_name_snapshot ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToColor(row: ColorRow): ProfileCustomizationColor {
  return {
    colorId: row.color_id,
    hex: row.hex,
    label: row.label,
    groupKey: row.group_key,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
    contrast: computeProfileCustomizationColorContrast(row.hex),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToEmoji(row: EmojiRow): ProfileCustomizationEmoji {
  return {
    emojiId: row.emoji_id,
    emoji: row.emoji,
    categoryKey: row.category_key,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToActiveItem(row: ActiveRow, now: Date): ProfileCustomizationActiveItem {
  return {
    kind: row.kind,
    itemId: row.item_id,
    value: row.item_value_snapshot,
    label: row.item_label_snapshot,
    chainStartedAt: row.chain_started_at,
    activeUntil: row.active_until,
    remainingDays: computeProfileCustomizationRemainingDays(row.active_until, now),
  }
}

export function emptyAppearance(): ProfileCustomizationAppearance {
  return {
    nicknameColor: null,
    nicknameColorUntil: null,
    messageColor: null,
    messageColorUntil: null,
    emojiBefore: null,
    emojiBeforeUntil: null,
    emojiAfter: null,
    emojiAfterUntil: null,
  }
}

function isConstraintError(error: unknown): boolean {
  // SQLITE_CONSTRAINT = 19 (долните 8 бита на extended кода).
  return typeof error === 'object' && error !== null && 'errcode' in error
    && typeof (error as { errcode: unknown }).errcode === 'number'
    && (((error as { errcode: number }).errcode) & 0xff) === 19
}

export async function createProfileCustomizationStore(databaseFilePath: string): Promise<ProfileCustomizationStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  // ─── Statements: настройки ─────────────────────────────────────────────
  const selectKindSettingsStatement = database.prepare(`
    SELECT kind, base_price_30_days_cents, sales_enabled, updated_at
    FROM profile_customization_kind_settings;
  `)
  const selectKindSettingStatement = database.prepare(`
    SELECT kind, base_price_30_days_cents, sales_enabled, updated_at
    FROM profile_customization_kind_settings
    WHERE kind = ?;
  `)
  const updateKindSettingStatement = database.prepare(`
    UPDATE profile_customization_kind_settings
    SET base_price_30_days_cents = ?, sales_enabled = ?, updated_at = ?
    WHERE kind = ?;
  `)

  // ─── Statements: каталог ───────────────────────────────────────────────
  const COLOR_COLUMNS = 'color_id, hex, label, group_key, sort_order, is_active, created_at, updated_at'
  const EMOJI_COLUMNS = 'emoji_id, emoji, category_key, sort_order, is_active, created_at, updated_at'
  const selectAllColorsStatement = database.prepare(`
    SELECT ${COLOR_COLUMNS} FROM profile_customization_colors
    ORDER BY CASE group_key
      WHEN 'red' THEN 1 WHEN 'orange' THEN 2 WHEN 'gold' THEN 3 WHEN 'green' THEN 4
      WHEN 'teal' THEN 5 WHEN 'blue' THEN 6 WHEN 'purple' THEN 7 ELSE 8 END,
      sort_order, color_id;
  `)
  const selectColorStatement = database.prepare(`SELECT ${COLOR_COLUMNS} FROM profile_customization_colors WHERE color_id = ?;`)
  const selectColorByHexStatement = database.prepare(`SELECT color_id FROM profile_customization_colors WHERE hex = ?;`)
  const selectMaxColorSortStatement = database.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM profile_customization_colors WHERE group_key = ?;`)
  const insertColorStatement = database.prepare(`
    INSERT INTO profile_customization_colors (color_id, hex, label, group_key, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?);
  `)
  const updateColorStatement = database.prepare(`
    UPDATE profile_customization_colors
    SET label = ?, group_key = ?, sort_order = ?, is_active = ?, updated_at = ?
    WHERE color_id = ?;
  `)
  const selectAllEmojisStatement = database.prepare(`
    SELECT ${EMOJI_COLUMNS} FROM profile_customization_emojis
    ORDER BY CASE category_key
      WHEN 'smileys' THEN 1 WHEN 'kisses' THEN 2 WHEN 'hearts' THEN 3 WHEN 'ghosts' THEN 4
      WHEN 'animals' THEN 5 WHEN 'bugs' THEN 6 WHEN 'flowers' THEN 7 WHEN 'fruits' THEN 8
      WHEN 'stars' THEN 9 WHEN 'crowns' THEN 10 WHEN 'games' THEN 11 WHEN 'gestures' THEN 12
      WHEN 'food' THEN 13 WHEN 'symbols' THEN 14 ELSE 15 END,
      sort_order, emoji_id;
  `)
  const selectEmojiStatement = database.prepare(`SELECT ${EMOJI_COLUMNS} FROM profile_customization_emojis WHERE emoji_id = ?;`)
  const selectEmojiByValueStatement = database.prepare(`SELECT emoji_id FROM profile_customization_emojis WHERE emoji = ?;`)
  const selectMaxEmojiSortStatement = database.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM profile_customization_emojis WHERE category_key = ?;`)
  const insertEmojiStatement = database.prepare(`
    INSERT INTO profile_customization_emojis (emoji_id, emoji, category_key, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?);
  `)
  const updateEmojiStatement = database.prepare(`
    UPDATE profile_customization_emojis
    SET category_key = ?, sort_order = ?, is_active = ?, updated_at = ?
    WHERE emoji_id = ?;
  `)

  // ─── Statements: активни екстри ────────────────────────────────────────
  const ACTIVE_COLUMNS = 'profile_id, kind, item_id, item_value_snapshot, item_label_snapshot, chain_id, chain_started_at, active_until'
  const selectActiveRowsForProfileStatement = database.prepare(`
    SELECT ${ACTIVE_COLUMNS} FROM profile_customization_active WHERE profile_id = ?;
  `)
  const selectActiveRowStatement = database.prepare(`
    SELECT ${ACTIVE_COLUMNS} FROM profile_customization_active WHERE profile_id = ? AND kind = ?;
  `)
  const upsertActiveRowStatement = database.prepare(`
    INSERT INTO profile_customization_active (
      profile_id, kind, item_id, item_value_snapshot, item_label_snapshot,
      chain_id, chain_started_at, active_until, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, kind) DO UPDATE SET
      item_id = excluded.item_id,
      item_value_snapshot = excluded.item_value_snapshot,
      item_label_snapshot = excluded.item_label_snapshot,
      chain_id = excluded.chain_id,
      chain_started_at = excluded.chain_started_at,
      active_until = excluded.active_until,
      updated_at = excluded.updated_at;
  `)
  const updateActiveUntilStatement = database.prepare(`
    UPDATE profile_customization_active SET active_until = ?, updated_at = ?
    WHERE profile_id = ? AND kind = ? AND chain_id = ?;
  `)
  const deleteActiveRowStatement = database.prepare(`
    DELETE FROM profile_customization_active WHERE profile_id = ? AND kind = ? AND chain_id = ?;
  `)
  const sumPaidChainDaysStatement = database.prepare(`
    SELECT COALESCE(SUM(days_snapshot), 0) AS total_days
    FROM profile_customization_purchases
    WHERE chain_id = ? AND status = 'paid';
  `)

  // ─── Statements: покупки ───────────────────────────────────────────────
  const selectEligibleProfileStatement = database.prepare(`
    SELECT 1 AS ok FROM profiles
    WHERE profile_id = ?
      AND profile_kind = 'human'
      AND status = 'active'
      AND account_id IS NOT NULL
      AND is_temporary = 0
    LIMIT 1;
  `)
  const selectPurchaseStatement = database.prepare(`SELECT ${PURCHASE_COLUMNS} FROM profile_customization_purchases WHERE purchase_id = ?;`)
  const selectPurchaseBySessionStatement = database.prepare(`SELECT ${PURCHASE_COLUMNS} FROM profile_customization_purchases WHERE provider_checkout_session_id = ?;`)
  const selectPurchaseByPaymentIntentStatement = database.prepare(`
    SELECT ${PURCHASE_COLUMNS} FROM profile_customization_purchases
    WHERE stripe_payment_intent_id = ?
    ORDER BY created_at DESC LIMIT 1;
  `)
  const selectProfilePurchasesStatement = database.prepare(`
    SELECT ${PURCHASE_COLUMNS} FROM profile_customization_purchases
    WHERE profile_id = ?
    ORDER BY created_at DESC LIMIT 50;
  `)
  const selectPendingPurchaseStatement = database.prepare(`
    SELECT ${PURCHASE_COLUMNS} FROM profile_customization_purchases
    WHERE profile_id = ? AND kind = ? AND item_id = ? AND days_snapshot = ?
      AND status = 'pending' AND hidden_at IS NULL
    ORDER BY created_at DESC LIMIT 1;
  `)
  const insertPendingPurchaseStatement = database.prepare(`
    INSERT INTO profile_customization_purchases (
      purchase_id, profile_id, kind, item_id, item_value_snapshot, item_label_snapshot,
      days_snapshot, base_price_30_days_cents_snapshot, price_cents_snapshot, currency,
      provider, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'EUR', 'stripe', 'pending', ?, ?);
  `)
  const retirePendingStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET hidden_at = ?, updated_at = ?
    WHERE purchase_id = ? AND status = 'pending' AND hidden_at IS NULL;
  `)
  const attachCheckoutSessionStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET provider_checkout_session_id = ?, updated_at = ?
    WHERE purchase_id = ? AND status = 'pending';
  `)
  const markCanceledBySessionStatement = database.prepare(`
    UPDATE profile_customization_purchases SET status = 'canceled', updated_at = ?
    WHERE provider_checkout_session_id = ? AND status = 'pending';
  `)
  const markFailedBySessionStatement = database.prepare(`
    UPDATE profile_customization_purchases SET status = 'failed', updated_at = ?
    WHERE provider_checkout_session_id = ? AND status = 'pending';
  `)
  // CAS — само един от N конкурентни/повторени webhook-а минава
  // (WHERE status = 'pending'); губещите виждат changes = 0.
  const markPaidStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET status = 'paid', credited_at = ?, grant_effect = ?, chain_id = ?, granted_until_snapshot = ?,
        replaced_item_value_snapshot = ?, replaced_active_until_snapshot = ?,
        stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), updated_at = ?,
        -- Частичен refund, пристигнал ПРЕДИ кредитирането: правата се
        -- активират, но покупката задължително чака преглед.
        refund_review_status = CASE
          WHEN COALESCE(refunded_amount_cents, 0) > 0 AND refund_review_status IS NULL THEN 'pending'
          ELSE refund_review_status
        END,
        refund_review_reason = CASE
          WHEN COALESCE(refunded_amount_cents, 0) > 0 AND refund_review_status IS NULL THEN 'partial_refund'
          ELSE refund_review_reason
        END
    WHERE purchase_id = ? AND status = 'pending';
  `)
  const markRefundReviewedStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET refund_review_status = 'reviewed', refund_reviewed_at = ?, updated_at = ?,
        refund_reviewed_by_profile_id = ?, refund_reviewed_by_display_name_snapshot = ?
    WHERE purchase_id = ? AND refund_review_status = 'pending';
  `)
  const markRefundedBeforeCreditStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET status = 'refunded', stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), updated_at = ?
    WHERE purchase_id = ? AND status = 'pending';
  `)
  const markRefundStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET status = ?, refunded_at = COALESCE(refunded_at, ?), refunded_amount_cents = ?,
        refund_stripe_event_id = ?, updated_at = ?,
        -- NULL = без промяна; 'pending' = частичен refund чака преглед (нова
        -- по-голяма частична сума връща вече прегледана покупка за преглед).
        refund_review_status = COALESCE(?, refund_review_status),
        -- При ново маркиране за преглед: причината и нулиране на предишния
        -- преглед (кой/кога) — иначе без промяна.
        refund_review_reason = COALESCE(?, refund_review_reason),
        refund_reviewed_at = CASE WHEN ? IS NULL THEN refund_reviewed_at ELSE NULL END,
        refund_reviewed_by_profile_id = CASE WHEN ? IS NULL THEN refund_reviewed_by_profile_id ELSE NULL END,
        refund_reviewed_by_display_name_snapshot = CASE WHEN ? IS NULL THEN refund_reviewed_by_display_name_snapshot ELSE NULL END
    WHERE purchase_id = ?;
  `)
  const markRefundFailedStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET refund_review_status = 'pending', refund_review_reason = 'refund_failed',
        refund_failed_refund_id = ?, refund_failed_at = ?, refund_stripe_event_id = ?, updated_at = ?,
        refund_reviewed_at = NULL, refund_reviewed_by_profile_id = NULL, refund_reviewed_by_display_name_snapshot = NULL
    WHERE purchase_id = ?;
  `)
  const updatePaymentMethodSnapshotStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET
      stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
      stripe_charge_id         = COALESCE(stripe_charge_id, ?),
      payment_method_type      = COALESCE(payment_method_type, ?),
      wallet_type              = COALESCE(wallet_type, ?),
      card_brand               = COALESCE(card_brand, ?),
      card_last4               = COALESCE(card_last4, ?),
      card_country             = COALESCE(card_country, ?),
      updated_at               = ?
    WHERE purchase_id = ?;
  `)
  const needsPaymentMethodSnapshotStatement = database.prepare(`
    SELECT 1 FROM profile_customization_purchases
    WHERE purchase_id = ? AND (stripe_charge_id IS NULL OR payment_method_type IS NULL)
    LIMIT 1;
  `)

  // ─── Помощни ───────────────────────────────────────────────────────────

  function rollbackQuietly(): void {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // оригиналната грешка е по-важна
    }
  }

  function toKindSettings(row: KindSettingsRow): ProfileCustomizationKindSettings {
    return {
      kind: row.kind,
      label: PROFILE_CUSTOMIZATION_KIND_LABELS[row.kind],
      itemType: getProfileCustomizationItemType(row.kind),
      basePrice30DaysCents: row.base_price_30_days_cents,
      salesEnabled: row.sales_enabled === 1,
      priceTable: buildProfileCustomizationPriceTable(row.base_price_30_days_cents),
      updatedAt: row.updated_at,
    }
  }

  function getKindSettingsRow(kind: ProfileCustomizationKind): KindSettingsRow | null {
    return (selectKindSettingStatement.get(kind) as KindSettingsRow | undefined) ?? null
  }

  function resolveCatalogItem(kind: ProfileCustomizationKind, itemId: string): CatalogItem | null {
    if (getProfileCustomizationItemType(kind) === 'color') {
      const row = selectColorStatement.get(itemId) as ColorRow | undefined
      return row ? { itemId: row.color_id, value: row.hex, label: row.label, isActive: row.is_active === 1 } : null
    }
    const row = selectEmojiStatement.get(itemId) as EmojiRow | undefined
    return row ? { itemId: row.emoji_id, value: row.emoji, label: null, isActive: row.is_active === 1 } : null
  }

  function getPurchaseRow(purchaseId: string): PurchaseRow | null {
    return (selectPurchaseStatement.get(purchaseId) as PurchaseRow | undefined) ?? null
  }

  function getLiveActiveRow(profileId: string, kind: ProfileCustomizationKind, nowIso: string): ActiveRow | null {
    const row = selectActiveRowStatement.get(profileId, kind) as ActiveRow | undefined
    return row && row.active_until > nowIso ? row : null
  }

  type ResolvedPurchaseRequest = {
    profileId: string
    kind: ProfileCustomizationKind
    days: ProfileCustomizationDurationDays
    item: CatalogItem
    basePrice30DaysCents: number
    priceCents: number
    preview: ProfileCustomizationPurchasePreview
  }

  /**
   * Обща валидация за preview и createPendingPurchase. Цената е винаги от
   * админ настройката към момента — клиентът никога не я подава.
   */
  function resolvePurchaseRequest(input: { profileId: string; kind: string; itemId: string; days: number; now?: Date; ignoreSalesToggle?: boolean }): ResolvedPurchaseRequest | ProfileCustomizationFailure {
    const profileId = normalizeId(input.profileId)
    const itemId = normalizeId(input.itemId)
    if (profileId.length === 0 || itemId.length === 0) return failure('invalid_request', 'Невалидна заявка за покупка.')
    if (!isProfileCustomizationKind(input.kind)) return failure('invalid_kind', 'Невалиден вид персонализация.')
    if (!isProfileCustomizationDurationDays(input.days)) return failure('invalid_duration', 'Невалиден срок.')
    const kind = input.kind
    const days = input.days
    const now = input.now ?? new Date()
    const nowIso = now.toISOString()

    if (selectEligibleProfileStatement.get(profileId) === undefined) {
      return failure('profile_not_eligible', 'Персонализацията е достъпна само за регистрирани профили.')
    }

    const settings = getKindSettingsRow(kind)
    if (settings === null || (settings.sales_enabled !== 1 && input.ignoreSalesToggle !== true)) {
      return failure('sales_disabled', 'Тази персонализация в момента не се продава.')
    }

    const item = resolveCatalogItem(kind, itemId)
    if (item === null) return failure('item_not_found', 'Избраният артикул не съществува.')

    const current = getLiveActiveRow(profileId, kind, nowIso)
    const isExtensionOfCurrent = current !== null && current.item_id === item.itemId
    // Скрит артикул не се продава на нови купувачи, но собственикът на
    // активния артикул може да го удължи ("Удължи").
    if (!item.isActive && !isExtensionOfCurrent) {
      return failure('item_not_for_sale', 'Този артикул вече не се продава.')
    }
    if (getProfileCustomizationItemType(kind) === 'color' && isReservedOrNearReservedStaffColor(item.value)) {
      return failure('reserved_color', 'Този цвят е запазен за екипа на Pika.bg.')
    }

    const basePrice30DaysCents = settings.base_price_30_days_cents
    const priceCents = computeProfileCustomizationPriceCents(basePrice30DaysCents, days)

    let effect: ProfileCustomizationGrantEffect = 'new'
    let resultingActiveUntil = addDays(nowIso, days)
    let forfeitedDays = 0
    if (current !== null && isExtensionOfCurrent) {
      effect = 'extend'
      resultingActiveUntil = addDays(current.active_until, days)
    } else if (current !== null) {
      effect = 'replace'
      forfeitedDays = computeProfileCustomizationRemainingDays(current.active_until, now)
    }

    return {
      profileId,
      kind,
      days,
      item,
      basePrice30DaysCents,
      priceCents,
      preview: {
        kind,
        item: { itemId: item.itemId, value: item.value, label: item.label, isForSale: item.isActive },
        days,
        basePrice30DaysCents,
        priceCents,
        currency: 'EUR',
        effect,
        current: current !== null ? rowToActiveItem(current, now) : null,
        forfeitedDays,
        resultingActiveUntil,
      },
    }
  }

  // ─── Настройки ─────────────────────────────────────────────────────────

  function listKindSettings(): ProfileCustomizationKindSettings[] {
    const rows = selectKindSettingsStatement.all() as KindSettingsRow[]
    const byKind = new Map(rows.map((row) => [row.kind, row]))
    return PROFILE_CUSTOMIZATION_KINDS
      .map((kind) => byKind.get(kind))
      .filter((row): row is KindSettingsRow => row !== undefined)
      .map(toKindSettings)
  }

  function updateKindSettings(kind: string, patch: ProfileCustomizationKindSettingsPatch): { ok: true; settings: ProfileCustomizationKindSettings } | ProfileCustomizationFailure {
    if (!isProfileCustomizationKind(kind)) return failure('invalid_kind', 'Невалиден вид персонализация.')
    const current = getKindSettingsRow(kind)
    if (current === null) return failure('not_found', 'Липсва настройка за този вид.')
    if (patch.basePrice30DaysCents !== undefined && !isValidProfileCustomizationBasePriceCents(patch.basePrice30DaysCents)) {
      return failure('invalid_price', 'Цената за 30 дни трябва да е между 0.50 € и 1000.00 €, в цели центове.')
    }
    if (patch.salesEnabled !== undefined && typeof patch.salesEnabled !== 'boolean') {
      return failure('invalid_request', 'Невалидна стойност за продажбата.')
    }
    const basePrice = patch.basePrice30DaysCents ?? current.base_price_30_days_cents
    const salesEnabled = patch.salesEnabled === undefined ? current.sales_enabled : patch.salesEnabled ? 1 : 0
    updateKindSettingStatement.run(basePrice, salesEnabled, new Date().toISOString(), kind)
    return { ok: true, settings: toKindSettings(getKindSettingsRow(kind) as KindSettingsRow) }
  }

  // ─── Каталог ───────────────────────────────────────────────────────────

  function listColors(options?: { includeInactive?: boolean }): ProfileCustomizationColor[] {
    const rows = (selectAllColorsStatement.all() as ColorRow[]).map(rowToColor)
    return options?.includeInactive === true ? rows : rows.filter((color) => color.isActive)
  }

  function normalizeLabel(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const label = value.trim().replace(/\s+/g, ' ')
    return label.length >= 1 && Array.from(label).length <= PROFILE_CUSTOMIZATION_COLOR_LABEL_MAX_LENGTH ? label : null
  }

  function addColor(input: { hex: string; label: string; groupKey: string }): { ok: true; color: ProfileCustomizationColor } | ProfileCustomizationFailure {
    const hex = normalizeProfileCustomizationHex(input.hex)
    if (hex === null) return failure('invalid_color', 'Невалиден цвят — използвай формат #RRGGBB.')
    if (isReservedOrNearReservedStaffColor(hex)) {
      return failure('reserved_color', 'Този цвят е запазен за екипа на Pika.bg (или е твърде близък до него).')
    }
    const label = normalizeLabel(input.label)
    if (label === null) return failure('invalid_label', `Името на цвета е задължително (до ${PROFILE_CUSTOMIZATION_COLOR_LABEL_MAX_LENGTH} символа).`)
    if (!isProfileCustomizationColorGroup(input.groupKey)) return failure('invalid_group', 'Невалидна група цветове.')
    if (selectColorByHexStatement.get(hex) !== undefined) return failure('duplicate', 'Този цвят вече е в каталога.')

    const colorId = randomUUID()
    const nowIso = new Date().toISOString()
    const maxSort = (selectMaxColorSortStatement.get(input.groupKey) as { max_sort: number }).max_sort
    try {
      insertColorStatement.run(colorId, hex, label, input.groupKey, maxSort + 10, nowIso, nowIso)
    } catch (error) {
      if (isConstraintError(error)) return failure('duplicate', 'Този цвят вече е в каталога.')
      throw error
    }
    return { ok: true, color: rowToColor(selectColorStatement.get(colorId) as ColorRow) }
  }

  function updateColor(colorId: string, patch: ProfileCustomizationColorPatch): { ok: true; color: ProfileCustomizationColor } | ProfileCustomizationFailure {
    const row = selectColorStatement.get(normalizeId(colorId)) as ColorRow | undefined
    if (!row) return failure('not_found', 'Цветът не е намерен.')
    let label = row.label
    if (patch.label !== undefined) {
      const normalized = normalizeLabel(patch.label)
      if (normalized === null) return failure('invalid_label', `Името на цвета е задължително (до ${PROFILE_CUSTOMIZATION_COLOR_LABEL_MAX_LENGTH} символа).`)
      label = normalized
    }
    let groupKey: string = row.group_key
    if (patch.groupKey !== undefined) {
      if (!isProfileCustomizationColorGroup(patch.groupKey)) return failure('invalid_group', 'Невалидна група цветове.')
      groupKey = patch.groupKey
    }
    let sortOrder = row.sort_order
    if (patch.sortOrder !== undefined) {
      if (!Number.isSafeInteger(patch.sortOrder) || patch.sortOrder < 0 || patch.sortOrder > 1_000_000) {
        return failure('invalid_request', 'Невалидна подредба.')
      }
      sortOrder = patch.sortOrder
    }
    let isActive = row.is_active
    if (patch.isActive !== undefined) {
      if (typeof patch.isActive !== 'boolean') return failure('invalid_request', 'Невалидна стойност за продажбата.')
      isActive = patch.isActive ? 1 : 0
    }
    // Скриването НЕ засяга вече закупените (те пазят snapshot в
    // profile_customization_active) — само нови покупки.
    updateColorStatement.run(label, groupKey, sortOrder, isActive, new Date().toISOString(), row.color_id)
    return { ok: true, color: rowToColor(selectColorStatement.get(row.color_id) as ColorRow) }
  }

  function listEmojis(options?: { includeInactive?: boolean }): ProfileCustomizationEmoji[] {
    const rows = (selectAllEmojisStatement.all() as EmojiRow[]).map(rowToEmoji)
    return options?.includeInactive === true ? rows : rows.filter((emoji) => emoji.isActive)
  }

  function addEmoji(input: { emoji: string; categoryKey: string }): { ok: true; emoji: ProfileCustomizationEmoji } | ProfileCustomizationFailure {
    const emoji = normalizeProfileCustomizationEmoji(input.emoji)
    if (emoji === null) return failure('invalid_emoji', 'Въведи точно едно емоджи.')
    if (!isProfileCustomizationEmojiCategory(input.categoryKey)) return failure('invalid_category', 'Невалидна категория.')
    if (selectEmojiByValueStatement.get(emoji) !== undefined) return failure('duplicate', 'Това емоджи вече е в каталога.')

    const emojiId = randomUUID()
    const nowIso = new Date().toISOString()
    const maxSort = (selectMaxEmojiSortStatement.get(input.categoryKey) as { max_sort: number }).max_sort
    try {
      insertEmojiStatement.run(emojiId, emoji, input.categoryKey, maxSort + 10, nowIso, nowIso)
    } catch (error) {
      if (isConstraintError(error)) return failure('duplicate', 'Това емоджи вече е в каталога.')
      throw error
    }
    return { ok: true, emoji: rowToEmoji(selectEmojiStatement.get(emojiId) as EmojiRow) }
  }

  function updateEmoji(emojiId: string, patch: ProfileCustomizationEmojiPatch): { ok: true; emoji: ProfileCustomizationEmoji } | ProfileCustomizationFailure {
    const row = selectEmojiStatement.get(normalizeId(emojiId)) as EmojiRow | undefined
    if (!row) return failure('not_found', 'Емоджито не е намерено.')
    let categoryKey: string = row.category_key
    if (patch.categoryKey !== undefined) {
      if (!isProfileCustomizationEmojiCategory(patch.categoryKey)) return failure('invalid_category', 'Невалидна категория.')
      categoryKey = patch.categoryKey
    }
    let sortOrder = row.sort_order
    if (patch.sortOrder !== undefined) {
      if (!Number.isSafeInteger(patch.sortOrder) || patch.sortOrder < 0 || patch.sortOrder > 1_000_000) {
        return failure('invalid_request', 'Невалидна подредба.')
      }
      sortOrder = patch.sortOrder
    }
    let isActive = row.is_active
    if (patch.isActive !== undefined) {
      if (typeof patch.isActive !== 'boolean') return failure('invalid_request', 'Невалидна стойност за продажбата.')
      isActive = patch.isActive ? 1 : 0
    }
    updateEmojiStatement.run(categoryKey, sortOrder, isActive, new Date().toISOString(), row.emoji_id)
    return { ok: true, emoji: rowToEmoji(selectEmojiStatement.get(row.emoji_id) as EmojiRow) }
  }

  // ─── Активни екстри ────────────────────────────────────────────────────

  function getProfileActiveItems(profileId: string, now: Date = new Date()): Record<ProfileCustomizationKind, ProfileCustomizationActiveItem | null> {
    const result: Record<ProfileCustomizationKind, ProfileCustomizationActiveItem | null> = {
      nickname_color: null,
      message_color: null,
      emoji_before: null,
      emoji_after: null,
    }
    const normalizedProfileId = normalizeId(profileId)
    if (normalizedProfileId.length === 0) return result
    const nowIso = now.toISOString()
    for (const row of selectActiveRowsForProfileStatement.all(normalizedProfileId) as ActiveRow[]) {
      if (row.active_until > nowIso) result[row.kind] = rowToActiveItem(row, now)
    }
    return result
  }

  function getAppearancesForProfiles(profileIds: readonly string[], now: Date = new Date()): Map<string, ProfileCustomizationAppearance> {
    const appearances = new Map<string, ProfileCustomizationAppearance>()
    const uniqueProfileIds = [...new Set(profileIds.map(normalizeId).filter((id) => id.length > 0))]
    const nowIso = now.toISOString()
    for (let start = 0; start < uniqueProfileIds.length; start += APPEARANCE_BATCH_CHUNK_SIZE) {
      const chunk = uniqueProfileIds.slice(start, start + APPEARANCE_BATCH_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = database.prepare(`
        SELECT profile_id, kind, item_value_snapshot, active_until
        FROM profile_customization_active
        WHERE profile_id IN (${placeholders}) AND active_until > ?;
      `).all(...chunk, nowIso) as Array<{ profile_id: string; kind: ProfileCustomizationKind; item_value_snapshot: string; active_until: string }>
      for (const row of rows) {
        const appearance = appearances.get(row.profile_id) ?? emptyAppearance()
        if (row.kind === 'nickname_color' || row.kind === 'message_color') {
          // Защита в дълбочина: служебният цвят никога не се връща като платен
          // (CHECK в схемата вече го забранява).
          if (isReservedOrNearReservedStaffColor(row.item_value_snapshot)) continue
          if (row.kind === 'nickname_color') {
            appearance.nicknameColor = row.item_value_snapshot
            appearance.nicknameColorUntil = row.active_until
          } else {
            appearance.messageColor = row.item_value_snapshot
            appearance.messageColorUntil = row.active_until
          }
        } else if (row.kind === 'emoji_before') {
          appearance.emojiBefore = row.item_value_snapshot
          appearance.emojiBeforeUntil = row.active_until
        } else {
          appearance.emojiAfter = row.item_value_snapshot
          appearance.emojiAfterUntil = row.active_until
        }
        appearances.set(row.profile_id, appearance)
      }
    }
    return appearances
  }

  // ─── Покупки ───────────────────────────────────────────────────────────

  function previewPurchase(input: { profileId: string; kind: string; itemId: string; days: number; now?: Date; ignoreSalesToggle?: boolean }): { ok: true; preview: ProfileCustomizationPurchasePreview } | ProfileCustomizationFailure {
    const resolved = resolvePurchaseRequest(input)
    if ('ok' in resolved) return resolved
    return { ok: true, preview: resolved.preview }
  }

  function createPendingPurchase(input: { profileId: string; kind: string; itemId: string; days: number; now?: Date; ignoreSalesToggle?: boolean }): { ok: true; purchase: ProfileCustomizationPurchaseSnapshot; preview: ProfileCustomizationPurchasePreview } | ProfileCustomizationFailure {
    const resolved = resolvePurchaseRequest(input)
    if ('ok' in resolved) return resolved
    const { profileId, kind, days, item, basePrice30DaysCents, priceCents, preview } = resolved
    const nowIso = (input.now ?? new Date()).toISOString()
    const purchaseId = randomUUID()
    let resultPurchaseId: string = purchaseId

    try {
      // Mirror на vipPurchaseStore.createPendingPurchase: видим pending ред за
      // същия артикул/срок се преизползва САМО при същата цена и същия
      // snapshot на артикула; иначе се скрива (отворена Stripe сесия за него
      // може още да завърши по първоначалните условия) и се създава нов.
      database.exec('BEGIN IMMEDIATE;')
      const existing = selectPendingPurchaseStatement.get(profileId, kind, item.itemId, days) as PurchaseRow | undefined
      if (
        existing
        && existing.price_cents_snapshot === priceCents
        && existing.base_price_30_days_cents_snapshot === basePrice30DaysCents
        && existing.item_value_snapshot === item.value
      ) {
        resultPurchaseId = existing.purchase_id
      } else {
        if (existing) retirePendingStatement.run(nowIso, nowIso, existing.purchase_id)
        insertPendingPurchaseStatement.run(
          purchaseId,
          profileId,
          kind,
          item.itemId,
          item.value,
          item.label,
          days,
          basePrice30DaysCents,
          priceCents,
          nowIso,
          nowIso,
        )
      }
      database.exec('COMMIT;')
    } catch (error) {
      rollbackQuietly()
      throw error
    }

    const row = getPurchaseRow(resultPurchaseId)
    if (row === null) return failure('not_found', 'Поръчката не беше записана.')
    return { ok: true, purchase: rowToPurchase(row), preview }
  }

  function getPurchaseById(purchaseId: string): ProfileCustomizationPurchaseSnapshot | null {
    const row = getPurchaseRow(normalizeId(purchaseId))
    return row ? rowToPurchase(row) : null
  }

  function getPurchaseOwnerProfileId(purchaseId: string): string | null {
    return getPurchaseRow(normalizeId(purchaseId))?.profile_id ?? null
  }

  function listProfilePurchases(profileId: string): ProfileCustomizationPurchaseSnapshot[] {
    const normalizedProfileId = normalizeId(profileId)
    if (normalizedProfileId.length === 0) return []
    return (selectProfilePurchasesStatement.all(normalizedProfileId) as PurchaseRow[]).map(rowToPurchase)
  }

  function attachCheckoutSession(purchaseId: string, checkoutSessionId: string): ProfileCustomizationPurchaseSnapshot | null {
    attachCheckoutSessionStatement.run(checkoutSessionId, new Date().toISOString(), purchaseId)
    return getPurchaseById(purchaseId)
  }

  function retirePendingPurchase(purchaseId: string): boolean {
    const nowIso = new Date().toISOString()
    const result = retirePendingStatement.run(nowIso, nowIso, purchaseId) as { changes?: number }
    return (result.changes ?? 0) > 0
  }

  function findByCheckoutSessionId(checkoutSessionId: string): ProfileCustomizationPurchaseSnapshot | null {
    const row = selectPurchaseBySessionStatement.get(checkoutSessionId) as PurchaseRow | undefined
    return row ? rowToPurchase(row) : null
  }

  function markPurchaseCanceledByCheckoutSessionId(checkoutSessionId: string): void {
    markCanceledBySessionStatement.run(new Date().toISOString(), checkoutSessionId)
  }

  function markPurchaseFailedByCheckoutSessionId(checkoutSessionId: string): void {
    markFailedBySessionStatement.run(new Date().toISOString(), checkoutSessionId)
  }

  function failureContext(row: PurchaseRow): Pick<PurchaseFulfillmentFailure, 'purchaseId' | 'payerProfileId' | 'expectedAmountCents' | 'expectedCurrency'> {
    return {
      purchaseId: row.purchase_id,
      payerProfileId: row.profile_id,
      expectedAmountCents: row.price_cents_snapshot,
      expectedCurrency: row.currency,
    }
  }

  function currentActiveItem(row: PurchaseRow, now: Date): ProfileCustomizationActiveItem | null {
    if (row.profile_id === null) return null
    const active = getLiveActiveRow(row.profile_id, row.kind, now.toISOString())
    return active ? rowToActiveItem(active, now) : null
  }

  function alreadyCreditedResult(row: PurchaseRow, now: Date): FulfillPaidProfileCustomizationPurchaseResult {
    return {
      ok: true,
      purchase: rowToPurchase(row),
      payerProfileId: row.profile_id,
      alreadyCredited: true,
      refundedBeforeCredit: false,
      active: currentActiveItem(row, now),
    }
  }

  function fulfillPaidPurchase(params: FulfillPaidProfileCustomizationPurchaseParams): FulfillPaidProfileCustomizationPurchaseResult {
    const now = params.now ?? new Date()
    const nowIso = now.toISOString()

    // Търсене СТРОГО по checkout session id (UNIQUE) — purchaseId от
    // metadata е само кръстосана проверка (mirror на vipPurchaseStore).
    if (!params.checkoutSessionId) {
      return { ok: false, reason: 'purchase_not_found', message: 'Липсва checkout session id.' }
    }
    const row = selectPurchaseBySessionStatement.get(params.checkoutSessionId) as PurchaseRow | undefined
    if (!row) {
      return { ok: false, reason: 'purchase_not_found', message: 'Покупката не беше намерена за тази checkout сесия.' }
    }
    if (params.purchaseId && row.purchase_id !== params.purchaseId) {
      return { ok: false, reason: 'purchase_id_mismatch', message: 'Несъответствие между checkout сесията и purchaseId.', ...failureContext(row) }
    }

    // Повторна доставка след кредитиране (вкл. по-късно възстановена покупка)
    // — потвърждава се idempotent, без повторна проверка и без нов ефект.
    if (row.credited_at !== null) return alreadyCreditedResult(row, now)
    if (row.status === 'refunded') {
      return { ok: true, purchase: rowToPurchase(row), payerProfileId: row.profile_id, alreadyCredited: true, refundedBeforeCredit: true, active: currentActiveItem(row, now) }
    }

    if (params.stripePaymentStatus !== 'paid') {
      return { ok: false, reason: 'not_paid', message: `Stripe payment_status "${params.stripePaymentStatus}" не е "paid".` }
    }
    if (params.stripeCurrency.toUpperCase() !== row.currency.toUpperCase()) {
      return { ok: false, reason: 'currency_mismatch', ...failureContext(row), message: `Валутата от Stripe (${params.stripeCurrency}) не съвпада с очакваната (${row.currency}).` }
    }
    if (params.stripeAmountTotalCents !== row.price_cents_snapshot) {
      return { ok: false, reason: 'amount_mismatch', ...failureContext(row), message: `Платената сума от Stripe (${params.stripeAmountTotalCents}) не съвпада с очакваната цена (${row.price_cents_snapshot}).` }
    }
    if (row.status !== 'pending') {
      return { ok: false, reason: 'not_creditable', ...failureContext(row), message: `Покупката е в статус "${row.status}" и не може да бъде кредитирана.` }
    }
    if (row.profile_id === null) {
      return { ok: false, reason: 'not_creditable', ...failureContext(row), message: 'Профилът на купувача вече не съществува. Плащането не е кредитирано — необходим е ръчен преглед.' }
    }
    const profileId = row.profile_id
    const paymentIntentId = params.stripePaymentIntentId?.trim() || null

    let activeAfter: ProfileCustomizationActiveItem | null = null
    let refundedBeforeCredit = false
    try {
      database.exec('BEGIN IMMEDIATE;')
      // Пресен прочит вътре в транзакцията (конкурентен webhook/refund).
      const fresh = getPurchaseRow(row.purchase_id) as PurchaseRow

      if (fresh.status === 'pending' && fresh.refunded_at !== null && (fresh.refunded_amount_cents ?? 0) >= fresh.price_cents_snapshot) {
        // Пълен refund пристигна ПРЕДИ checkout.session.completed — нищо не
        // се активира, поръчката приключва като възстановена.
        markRefundedBeforeCreditStatement.run(paymentIntentId, nowIso, fresh.purchase_id)
        refundedBeforeCredit = true
      } else {
        const current = getLiveActiveRow(profileId, fresh.kind, nowIso)
        let effect: ProfileCustomizationGrantEffect
        let chainId: string
        let chainStartedAt: string
        let activeUntil: string
        let replacedValue: string | null = null
        let replacedUntil: string | null = null
        if (current !== null && current.item_id === fresh.item_id) {
          effect = 'extend'
          chainId = current.chain_id
          chainStartedAt = current.chain_started_at
          activeUntil = addDays(current.active_until, fresh.days_snapshot)
        } else {
          effect = current !== null ? 'replace' : 'new'
          if (current !== null) {
            replacedValue = current.item_value_snapshot
            replacedUntil = current.active_until
          }
          chainId = randomUUID()
          chainStartedAt = nowIso
          activeUntil = addDays(nowIso, fresh.days_snapshot)
        }

        const cas = markPaidStatement.run(
          nowIso, effect, chainId, activeUntil, replacedValue, replacedUntil, paymentIntentId, nowIso, fresh.purchase_id,
        ) as { changes?: number }
        if ((cas.changes ?? 0) === 0) {
          rollbackQuietly()
          const after = getPurchaseRow(row.purchase_id)
          if (after?.credited_at) return alreadyCreditedResult(after, now)
          return { ok: false, reason: 'credit_failed', transient: true, message: 'Покупката вече беше обработена от друг процес.' }
        }

        upsertActiveRowStatement.run(
          profileId,
          fresh.kind,
          fresh.item_id,
          fresh.item_value_snapshot,
          fresh.item_label_snapshot,
          chainId,
          chainStartedAt,
          activeUntil,
          nowIso,
        )
      }
      database.exec('COMMIT;')
    } catch (error) {
      rollbackQuietly()
      return {
        ok: false,
        reason: 'credit_failed',
        transient: isTransientDatabaseError(error),
        ...failureContext(row),
        message: error instanceof Error ? error.message : 'Грешка при активиране на персонализацията.',
      }
    }

    const fulfilled = getPurchaseRow(row.purchase_id)
    if (fulfilled === null) {
      return { ok: false, reason: 'credit_failed', transient: true, message: 'Персонализацията беше активирана, но покупката не може да се прочете.' }
    }
    activeAfter = currentActiveItem(fulfilled, now)
    return { ok: true, purchase: rowToPurchase(fulfilled), payerProfileId: fulfilled.profile_id, alreadyCredited: false, refundedBeforeCredit, active: activeAfter }
  }

  function applyRefund(params: ApplyProfileCustomizationRefundParams): ApplyProfileCustomizationRefundResult {
    const now = params.now ?? new Date()
    const nowIso = now.toISOString()
    const sessionId = params.checkoutSessionId?.trim() || null
    const paymentIntentId = params.paymentIntentId?.trim() || null
    if (sessionId === null && paymentIntentId === null) {
      return { ok: false, reason: 'invalid_request', message: 'Липсва checkout session id и payment intent id.' }
    }
    if (!Number.isSafeInteger(params.refundedAmountCents) || params.refundedAmountCents < 0) {
      return { ok: false, reason: 'invalid_request', message: 'Невалидна възстановена сума.' }
    }

    const located = (sessionId !== null ? (selectPurchaseBySessionStatement.get(sessionId) as PurchaseRow | undefined) : undefined)
      ?? (paymentIntentId !== null ? (selectPurchaseByPaymentIntentStatement.get(paymentIntentId) as PurchaseRow | undefined) : undefined)
    if (!located) {
      return { ok: false, reason: 'purchase_not_found', message: 'Покупката за това възстановяване не е намерена.' }
    }

    let outcome: Extract<ApplyProfileCustomizationRefundResult, { ok: true }>['outcome']
    try {
      database.exec('BEGIN IMMEDIATE;')
      const row = getPurchaseRow(located.purchase_id) as PurchaseRow
      // Stripe праща кумулативната сума — по-малка/равна стойност от вече
      // записаната е повторна или закъсняла доставка.
      const refundedAmount = Math.max(params.refundedAmountCents, row.refunded_amount_cents ?? 0)
      const isFull = refundedAmount >= row.price_cents_snapshot

      if (row.status === 'refunded') {
        outcome = 'already_refunded'
      } else if (row.status === 'paid' && isFull) {
        markRefundStatement.run('refunded', nowIso, refundedAmount, params.stripeEventId, nowIso, null, null, null, null, null, row.purchase_id)
        outcome = 'revoked'
        // Само ако покупката е от ТЕКУЩАТА верига на профила — иначе вече е
        // заменена и текущата екстра (валидна, следваща покупка) не се пипа.
        if (row.profile_id !== null && row.chain_id !== null) {
          const active = selectActiveRowStatement.get(row.profile_id, row.kind) as ActiveRow | undefined
          if (active && active.chain_id === row.chain_id) {
            const remainingDays = (sumPaidChainDaysStatement.get(row.chain_id) as { total_days: number }).total_days
            if (remainingDays <= 0) {
              deleteActiveRowStatement.run(row.profile_id, row.kind, row.chain_id)
            } else {
              updateActiveUntilStatement.run(addDays(active.chain_started_at, remainingDays), nowIso, row.profile_id, row.kind, row.chain_id)
            }
          }
        }
      } else if (row.status === 'paid') {
        // Частично възстановяване: правата остават, но покупката задължително
        // чака администраторски преглед (само при НОВА, по-голяма сума —
        // повторена доставка не връща вече прегледана покупка за преглед).
        const increased = refundedAmount > (row.refunded_amount_cents ?? 0)
        const reviewMark = increased ? 'pending' : null
        markRefundStatement.run('paid', nowIso, refundedAmount, params.stripeEventId, nowIso, reviewMark, increased ? 'partial_refund' : null, reviewMark, reviewMark, reviewMark, row.purchase_id)
        outcome = 'partial_recorded'
      } else if (row.status === 'pending') {
        // Refund преди checkout.session.completed — кредитирането ще го
        // види и няма да активира нищо (при пълна сума).
        markRefundStatement.run('pending', nowIso, refundedAmount, params.stripeEventId, nowIso, null, null, null, null, null, row.purchase_id)
        outcome = 'recorded_before_credit'
      } else {
        markRefundStatement.run(row.status, nowIso, refundedAmount, params.stripeEventId, nowIso, null, null, null, null, null, row.purchase_id)
        outcome = 'recorded_without_grant'
      }
      database.exec('COMMIT;')
    } catch (error) {
      rollbackQuietly()
      return {
        ok: false,
        reason: 'refund_failed',
        transient: isTransientDatabaseError(error),
        message: error instanceof Error ? error.message : 'Грешка при обработка на възстановяването.',
      }
    }

    const updated = getPurchaseRow(located.purchase_id) as PurchaseRow
    return { ok: true, outcome, purchase: rowToPurchase(updated), activeAfter: currentActiveItem(updated, now) }
  }

  function needsPaymentMethodSnapshot(purchaseId: string): boolean {
    return needsPaymentMethodSnapshotStatement.get(purchaseId) !== undefined
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
      new Date().toISOString(),
      purchaseId,
    )
  }

  // ─── Режим на достъп ───────────────────────────────────────────────────

  const selectLatestModeStatement = database.prepare(`
    SELECT mode, changed_at, changed_by_profile_id, changed_by_display_name_snapshot
    FROM profile_customization_mode_changes
    ORDER BY changed_at DESC, rowid DESC
    LIMIT 1;
  `)
  const insertModeChangeStatement = database.prepare(`
    INSERT INTO profile_customization_mode_changes (
      change_id, mode, previous_mode, changed_by_profile_id, changed_by_display_name_snapshot, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)
  const selectModeChangesStatement = database.prepare(`
    SELECT change_id, mode, previous_mode, changed_by_display_name_snapshot, changed_at
    FROM profile_customization_mode_changes
    ORDER BY changed_at DESC, rowid DESC
    LIMIT ?;
  `)

  function getAccessState(): ProfileCustomizationAccessState {
    const row = selectLatestModeStatement.get() as
      | { mode: ProfileCustomizationAccessMode; changed_at: string; changed_by_profile_id: string | null; changed_by_display_name_snapshot: string | null }
      | undefined
    // Без записи (или непознат режим) -> 'admin_only' — никога публично по подразбиране.
    if (!row || (row.mode !== 'public' && row.mode !== 'admin_only')) {
      return { mode: 'admin_only', changedAt: null, changedByProfileId: null, changedByDisplayName: null }
    }
    return { mode: row.mode, changedAt: row.changed_at, changedByProfileId: row.changed_by_profile_id, changedByDisplayName: row.changed_by_display_name_snapshot }
  }

  function setAccessMode(mode: ProfileCustomizationAccessMode, actor: { profileId: string | null; displayName: string | null }): { changed: boolean; state: ProfileCustomizationAccessState } {
    if (mode !== 'public' && mode !== 'admin_only') throw new Error('profile_customization_invalid_mode')
    try {
      database.exec('BEGIN IMMEDIATE;')
      const current = getAccessState()
      if (current.mode === mode) {
        database.exec('COMMIT;')
        return { changed: false, state: current }
      }
      insertModeChangeStatement.run(randomUUID(), mode, current.mode, actor.profileId, actor.displayName?.trim().slice(0, 80) || null, new Date().toISOString())
      database.exec('COMMIT;')
    } catch (error) {
      rollbackQuietly()
      throw error
    }
    return { changed: true, state: getAccessState() }
  }

  function listModeChanges(limit: number): ProfileCustomizationModeChange[] {
    const rows = selectModeChangesStatement.all(Math.min(Math.max(Math.trunc(limit) || 1, 1), 100)) as Array<{
      change_id: string; mode: ProfileCustomizationAccessMode; previous_mode: ProfileCustomizationAccessMode; changed_by_display_name_snapshot: string | null; changed_at: string
    }>
    return rows.map((row) => ({ changeId: row.change_id, mode: row.mode, previousMode: row.previous_mode, changedByDisplayName: row.changed_by_display_name_snapshot, changedAt: row.changed_at }))
  }

  // ─── Админ ─────────────────────────────────────────────────────────────

  function listAdminPurchases(input: { limit: number; offset: number; status?: string | null }): { rows: ProfileCustomizationAdminPurchaseRow[]; total: number } {
    const limit = Math.min(Math.max(Number.isSafeInteger(input.limit) ? input.limit : 50, 1), 200)
    const offset = Math.max(Number.isSafeInteger(input.offset) ? input.offset : 0, 0)
    const status = typeof input.status === 'string' && (ADMIN_PURCHASE_STATUSES as readonly string[]).includes(input.status) ? input.status : null
    // По подразбиране без скритите (заменени) pending редове — те не са поръчки на потребителя.
    const where = input.status === 'review_pending'
      ? "WHERE pcp.refund_review_status = 'pending'"
      : status !== null ? 'WHERE pcp.status = ?' : 'WHERE pcp.hidden_at IS NULL'
    const whereParams = input.status !== 'review_pending' && status !== null ? [status] : []
    const total = (database.prepare(`SELECT COUNT(*) AS c FROM profile_customization_purchases pcp ${where};`).get(...whereParams) as { c: number }).c
    type AdminRow = PurchaseRow & {
      display_name: string | null
      username: string | null
      email: string | null
      payment_method_type: string | null
      card_brand: string | null
      card_last4: string | null
    }
    const rows = database.prepare(`
      SELECT ${PURCHASE_COLUMNS.split(',').map((column) => `pcp.${column.trim()}`).join(', ')},
             p.display_name, p.username, a.email, pcp.payment_method_type, pcp.card_brand, pcp.card_last4
      FROM profile_customization_purchases pcp
      LEFT JOIN profiles p ON p.profile_id = pcp.profile_id
      LEFT JOIN accounts a ON a.account_id = p.account_id
      ${where}
      ORDER BY pcp.created_at DESC, pcp.purchase_id DESC
      LIMIT ? OFFSET ?;
    `).all(...whereParams, limit, offset) as AdminRow[]
    return {
      total,
      rows: rows.map((row) => ({
        ...rowToPurchase(row),
        profileId: row.profile_id,
        displayName: row.display_name ?? null,
        username: row.username ?? null,
        email: row.email ?? null,
        paymentMethodType: row.payment_method_type ?? null,
        cardBrand: row.card_brand ?? null,
        cardLast4: row.card_last4 ?? null,
      })),
    }
  }

  function countPendingRefundReviews(): number {
    return (database.prepare("SELECT COUNT(*) AS c FROM profile_customization_purchases WHERE refund_review_status = 'pending';").get() as { c: number }).c
  }

  function markRefundReviewed(purchaseId: string, actor?: { profileId: string | null; displayName: string | null }): boolean {
    const nowIso = new Date().toISOString()
    const result = markRefundReviewedStatement.run(
      nowIso,
      nowIso,
      actor?.profileId ?? null,
      actor?.displayName?.trim().slice(0, 80) || null,
      normalizeId(purchaseId),
    ) as { changes?: number }
    return (result.changes ?? 0) > 0
  }

  function recordRefundFailure(params: { checkoutSessionId?: string | null; paymentIntentId?: string | null; stripeRefundId: string; stripeEventId: string; now?: Date }):
    | { ok: true; outcome: 'marked_for_review' | 'already_recorded'; purchase: ProfileCustomizationPurchaseSnapshot }
    | { ok: false; reason: 'purchase_not_found' | 'invalid_request'; message: string } {
    const sessionId = params.checkoutSessionId?.trim() || null
    const paymentIntentId = params.paymentIntentId?.trim() || null
    const refundId = params.stripeRefundId.trim()
    if ((sessionId === null && paymentIntentId === null) || refundId.length === 0) {
      return { ok: false, reason: 'invalid_request', message: 'Липсва идентификатор на плащането или на refund-а.' }
    }
    const row = (sessionId !== null ? (selectPurchaseBySessionStatement.get(sessionId) as PurchaseRow | undefined) : undefined)
      ?? (paymentIntentId !== null ? (selectPurchaseByPaymentIntentStatement.get(paymentIntentId) as PurchaseRow | undefined) : undefined)
    if (!row) return { ok: false, reason: 'purchase_not_found', message: 'Покупката за този refund не е намерена.' }
    // Повторна доставка за същия refund — без промяна (и без да отваря отново вече прегледан случай).
    if (row.refund_failed_refund_id === refundId) {
      return { ok: true, outcome: 'already_recorded', purchase: rowToPurchase(row) }
    }
    const nowIso = (params.now ?? new Date()).toISOString()
    markRefundFailedStatement.run(refundId, nowIso, params.stripeEventId, nowIso, row.purchase_id)
    return { ok: true, outcome: 'marked_for_review', purchase: rowToPurchase(getPurchaseRow(row.purchase_id) as PurchaseRow) }
  }

  function findProfilePurchaseByCheckoutSessionId(profileId: string, checkoutSessionId: string): ProfileCustomizationPurchaseSnapshot | null {
    const row = selectPurchaseBySessionStatement.get(checkoutSessionId.trim()) as PurchaseRow | undefined
    return row && row.profile_id !== null && row.profile_id === normalizeId(profileId) ? rowToPurchase(row) : null
  }

  function getAdminKindStats(now: Date = new Date()): ProfileCustomizationAdminKindStats[] {
    const purchaseRows = database.prepare(`
      SELECT kind,
             SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
             SUM(CASE WHEN status = 'paid' THEN price_cents_snapshot - COALESCE(refunded_amount_cents, 0) ELSE 0 END) AS paid_total,
             SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded_count,
             SUM(CASE WHEN status = 'refunded' THEN COALESCE(refunded_amount_cents, price_cents_snapshot) ELSE 0 END) AS refunded_total
      FROM profile_customization_purchases
      GROUP BY kind;
    `).all() as Array<{ kind: ProfileCustomizationKind; paid_count: number; paid_total: number; refunded_count: number; refunded_total: number }>
    const activeRows = database.prepare(`
      SELECT kind, COUNT(*) AS c FROM profile_customization_active WHERE active_until > ? GROUP BY kind;
    `).all(now.toISOString()) as Array<{ kind: ProfileCustomizationKind; c: number }>
    const purchasesByKind = new Map(purchaseRows.map((row) => [row.kind, row]))
    const activeByKind = new Map(activeRows.map((row) => [row.kind, row.c]))
    return PROFILE_CUSTOMIZATION_KINDS.map((kind) => {
      const row = purchasesByKind.get(kind)
      return {
        kind,
        paidCount: row?.paid_count ?? 0,
        paidTotalCents: row?.paid_total ?? 0,
        refundedCount: row?.refunded_count ?? 0,
        refundedTotalCents: row?.refunded_total ?? 0,
        activeNowCount: activeByKind.get(kind) ?? 0,
      }
    })
  }

  return {
    listKindSettings,
    updateKindSettings,
    listColors,
    addColor,
    updateColor,
    listEmojis,
    addEmoji,
    updateEmoji,
    getProfileActiveItems,
    getAppearancesForProfiles,
    previewPurchase,
    createPendingPurchase,
    getPurchaseById,
    getPurchaseOwnerProfileId,
    listProfilePurchases,
    attachCheckoutSession,
    retirePendingPurchase,
    findByCheckoutSessionId,
    markPurchaseCanceledByCheckoutSessionId,
    markPurchaseFailedByCheckoutSessionId,
    fulfillPaidPurchase,
    applyRefund,
    needsPaymentMethodSnapshot,
    updatePaymentMethodSnapshot,
    getAccessState,
    setAccessMode,
    listModeChanges,
    listAdminPurchases,
    countPendingRefundReviews,
    markRefundReviewed,
    recordRefundFailure,
    findProfilePurchaseByCheckoutSessionId,
    getAdminKindStats,
    close: () => database.close(),
  }
}
