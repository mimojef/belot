// "Персонализация на профила" — единственият достъп до базата за
// настройките, каталога, регистъра на покупките и текущите активни екстри
// (миграция 20261107_001_create_profile_customization.sql).
//
// Платежният поток е mirror на vipPurchaseStore.ts (същата Stripe
// инфраструктура, не паралелна), но за обща поръчка с 1..4 екстри
// (миграция 20261108_001): createPendingOrder -> ЕДНА Stripe Checkout сесия ->
// fulfillPaidOrder, извикан САМО от webhook-а за checkout.session.completed.
// Клиентски redirect не активира нищо. Сумата/плащането/refund-ът/прегледът
// са на поръчката; всеки ред е отделно платено право със собствен срок.
//
// Правила при кредитиране — за всеки ред (в ЕДНА BEGIN IMMEDIATE транзакция
// за цялата поръчка с CAS pending->paid, така че повторен/конкурентен webhook
// не кредитира два пъти и няма частично активирана поръчка):
//   * същият вариант е притежаван и валиден -> 'extend': срокът му += дните
//                                              (без второ копие в инвентара);
//   * иначе (не е притежаван или е изтекъл) -> 'new': вариантът се добавя в
//                                              инвентара с нова верига от сега
//                                              и автоматично става използван.
// Инвентар (миграция 20261108_002): всеки притежаван вариант има собствен
// срок (profile_customization_owned_items); използва се най-много един на
// вид (profile_customization_equipped). Покупка на друг вариант НЕ губи дни
// ('replace' остава само в старите записи). "Използвай"/"Премахни" сменят
// само използвания — безплатно, без промяна на правата и сроковете.
//
// Refund (applyRefund): пълното възстановяване на поръчката маркира нея и
// всичките ѝ редове 'refunded'. За всеки ред от ТЕКУЩАТА верига срокът се
// преизчислява като начало_на_веригата + сума(дни на оставащите платени
// покупки във веригата) — следващите удължавания (и от други поръчки)
// запазват всичките си дни, а само възстановените дни изчезват. Ред от вече
// заменена верига не променя текущата екстра. Частичното възстановяване не
// може да се отнесе еднозначно към конкретна екстра — записва се, без да
// променя правата, и поръчката чака администраторски преглед.
//
// Store-ът не проверява feature flag-а — това е отговорност на HTTP/WS
// слоя (profileCustomizationFeatureFlag.ts), за да може webhook-ът винаги да
// кредитира вече платени поръчки.

import { randomUUID } from 'node:crypto'
import type { PurchaseFulfillmentFailure } from '../db/purchaseFulfillmentFailure.js'
import { isTransientDatabaseError } from '../db/classifyFulfillmentError.js'
import type { AdminPaymentDetailRow, AdminPaymentListRow, PaymentMethodSnapshot } from '../db/coinPurchaseStore.js'
import { buildPeriodWhereClause, type AdminPaymentPeriod } from '../db/sofiaDayBounds.js'
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

/** Притежаван и неизтекъл вариант в "Моите персонализации". */
export type ProfileCustomizationOwnedItem = ProfileCustomizationActiveItem & {
  /** true = "Използва се" (най-много един на вид); false = "Наличен". */
  equipped: boolean
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

/**
 * Един ред от поръчката = едно платено право (вид + артикул + срок). Сумата,
 * Stripe сесията, refund-ът и прегледът са на ниво поръчка
 * (ProfileCustomizationOrderSnapshot).
 */
export type ProfileCustomizationPurchaseSnapshot = {
  purchaseId: string
  orderId: string | null
  kind: ProfileCustomizationKind
  itemId: string
  itemValue: string
  itemLabel: string | null
  days: ProfileCustomizationDurationDays
  basePrice30DaysCents: number
  priceCents: number
  currency: string
  status: ProfileCustomizationPurchaseStatus
  creditedAt: string | null
  grantEffect: ProfileCustomizationGrantEffect | null
  chainId: string | null
  grantedUntil: string | null
  replacedItemValue: string | null
  replacedActiveUntil: string | null
  /** Само при пълен refund на поръчката (или частичен на поръчка с един ред). */
  refundedAt: string | null
  refundedAmountCents: number | null
  createdAt: string
  updatedAt: string
}

/** Една Stripe поръчка/плащане с 1..4 отделни платени права. */
export type ProfileCustomizationOrderSnapshot = {
  orderId: string
  status: ProfileCustomizationPurchaseStatus
  itemCount: number
  totalCents: number
  currency: string
  provider: string
  providerCheckoutSessionId: string | null
  paidAt: string | null
  refundedAt: string | null
  refundedAmountCents: number | null
  /** 'pending' = чака администраторски преглед (частичен или неуспешен refund). */
  refundReviewStatus: ProfileCustomizationRefundReviewStatus | null
  refundReviewReason: ProfileCustomizationRefundReviewReason | null
  refundReviewedAt: string | null
  refundReviewedByDisplayName: string | null
  createdAt: string
  updatedAt: string
  /** Подредени по вид (nickname_color, message_color, emoji_before, emoji_after). */
  lines: ProfileCustomizationPurchaseSnapshot[]
}

export type ProfileCustomizationOrderItemInput = { kind: string; itemId: string; days: number }

export type ProfileCustomizationOrderInput = {
  profileId: string
  items: readonly ProfileCustomizationOrderItemInput[]
  now?: Date
  /** Само за пълен admin в режим "Само админ" (тест без публична продажба). */
  ignoreSalesToggle?: boolean
}

/** Безплатно предоставяне от пълен admin (без цена/Stripe/жълтици). */
export type ProfileCustomizationGrantInput = {
  /** Кой admin (одит; FK SET NULL при изтриване). */
  adminProfileId: string | null
  adminDisplayName: string | null
  /** Получателят — чужд профил или собственият на admin. */
  targetProfileId: string
  items: readonly ProfileCustomizationOrderItemInput[]
  now?: Date
}

/** Един ред от одита на предоставянията (= едно предоставено право). */
export type ProfileCustomizationGrantRecord = {
  grantId: string
  /** Общо за редовете от едно "Приложи безплатно". */
  batchId: string
  profileId: string | null
  targetDisplayName: string | null
  kind: ProfileCustomizationKind
  kindLabel: string
  itemType: ProfileCustomizationItemType
  itemId: string
  itemValue: string
  itemLabel: string | null
  days: number
  grantEffect: 'new' | 'extend'
  /** Новата крайна дата на варианта след предоставянето. */
  grantedUntil: string
  grantedByProfileId: string | null
  grantedByDisplayName: string | null
  createdAt: string
}

/** Ред за /admin/payments (формата на AdminPaymentListRow + нетната сума за оборота). */
export type ProfileCustomizationAdminPaymentRow = AdminPaymentListRow & { netCents: number }
export type ProfileCustomizationAdminPaymentDetail = AdminPaymentDetailRow & { netCents: number }

export type ProfileCustomizationOrderPreview = {
  lines: ProfileCustomizationPurchasePreview[]
  totalCents: number
  currency: 'EUR'
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
  | 'empty_order'
  | 'too_many_items'
  | 'duplicate_kind'
  | 'not_owned'
  | 'expired'

/** kind — при поръчка: видът на реда, който е отказан. */
export type ProfileCustomizationFailure = { ok: false; code: ProfileCustomizationFailureCode; message: string; kind?: ProfileCustomizationKind }

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
  /** 'extend' = вече притежаван валиден вариант; 'new' = добавя се в инвентара. */
  effect: ProfileCustomizationGrantEffect
  /** Притежаваният валиден вариант, който се удължава (null при 'new'). */
  current: ProfileCustomizationActiveItem | null
  /** Винаги 0 — с инвентара покупка на друг вариант не губи дни (старото поле за 'replace'). */
  forfeitedDays: number
  resultingActiveUntil: string
}

export type FulfillPaidProfileCustomizationOrderParams = {
  checkoutSessionId: string
  /** orderId от Stripe metadata — само кръстосана проверка (търсенето е по session id). */
  orderId: string
  stripePaymentStatus: string
  stripeCurrency: string
  stripeAmountTotalCents: number
  /** Записва се веднага, за да може refund да намери поръчката и без enrichment. */
  stripePaymentIntentId: string | null
  now?: Date
}

export type ProfileCustomizationActiveItems = Record<ProfileCustomizationKind, ProfileCustomizationActiveItem | null>

export type FulfillPaidProfileCustomizationOrderResult =
  | {
      ok: true
      order: ProfileCustomizationOrderSnapshot
      payerProfileId: string | null
      alreadyCredited: boolean
      /** Поръчката е възстановена (refund) преди да бъде кредитирана — нищо не е активирано. */
      refundedBeforeCredit: boolean
      active: ProfileCustomizationActiveItems
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
      order: ProfileCustomizationOrderSnapshot
      /** Текущите екстри на купувача след refund-а (null = няма активна). */
      activeAfter: ProfileCustomizationActiveItems
    }
  | { ok: false; reason: 'purchase_not_found' | 'invalid_request' | 'refund_failed'; transient?: boolean; message: string }

export type ProfileCustomizationAdminOrderRow = ProfileCustomizationOrderSnapshot & {
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
  // Използвани екстри и инвентар
  /** Използваните в момента (по една на вид, неизтекли). */
  getProfileActiveItems: (profileId: string, now?: Date) => Record<ProfileCustomizationKind, ProfileCustomizationActiveItem | null>
  /** "Моите персонализации": всички притежавани неизтекли варианти. */
  getProfileOwnedItems: (profileId: string, now?: Date) => ProfileCustomizationOwnedItem[]
  /** "Използвай" — само притежаван и неизтекъл вариант; безплатно. */
  equipItem: (input: { profileId: string; kind: string; itemId: string; now?: Date }) => { ok: true; active: ProfileCustomizationActiveItems; owned: ProfileCustomizationOwnedItem[] } | ProfileCustomizationFailure
  /** "Премахни" — спира само визуалния ефект; правото остава. */
  unequipItem: (input: { profileId: string; kind: string; now?: Date }) => { ok: true; removed: boolean; active: ProfileCustomizationActiveItems; owned: ProfileCustomizationOwnedItem[] } | ProfileCustomizationFailure
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
  /** 1..4 реда, всеки вид най-много веднъж; цената е от админ настройката. */
  previewOrder: (input: ProfileCustomizationOrderInput) => { ok: true; preview: ProfileCustomizationOrderPreview } | ProfileCustomizationFailure
  /**
   * Видима неплатена поръчка със същите редове (и същите цени) се използва
   * повторно; иначе тя се скрива (отворената ѝ сесия още може да бъде
   * платена) и се създава нова.
   */
  createPendingOrder: (input: ProfileCustomizationOrderInput) => { ok: true; order: ProfileCustomizationOrderSnapshot; preview: ProfileCustomizationOrderPreview } | ProfileCustomizationFailure
  getOrderById: (orderId: string) => ProfileCustomizationOrderSnapshot | null
  getPurchaseById: (purchaseId: string) => ProfileCustomizationPurchaseSnapshot | null
  attachOrderCheckoutSession: (orderId: string, checkoutSessionId: string) => ProfileCustomizationOrderSnapshot | null
  retirePendingOrder: (orderId: string) => boolean
  findOrderByCheckoutSessionId: (checkoutSessionId: string) => ProfileCustomizationOrderSnapshot | null
  /** Само ако сесията е на този профил (връщане от Stripe) — иначе null. */
  findProfileOrderByCheckoutSessionId: (profileId: string, checkoutSessionId: string) => ProfileCustomizationOrderSnapshot | null
  markOrderCanceledByCheckoutSessionId: (checkoutSessionId: string) => void
  markOrderFailedByCheckoutSessionId: (checkoutSessionId: string) => void
  fulfillPaidOrder: (params: FulfillPaidProfileCustomizationOrderParams) => FulfillPaidProfileCustomizationOrderResult
  applyRefund: (params: ApplyProfileCustomizationRefundParams) => ApplyProfileCustomizationRefundResult
  needsPaymentMethodSnapshot: (orderId: string) => boolean
  updatePaymentMethodSnapshot: (orderId: string, snapshot: PaymentMethodSnapshot) => void
  // Безплатно предоставяне от admin (ролята се проверява в HTTP слоя)
  grantItems: (input: ProfileCustomizationGrantInput) => { ok: true; batchId: string; grants: ProfileCustomizationGrantRecord[]; active: ProfileCustomizationActiveItems; owned: ProfileCustomizationOwnedItem[] } | ProfileCustomizationFailure
  listGrants: (input: { limit: number; offset: number; profileId?: string | null }) => { rows: ProfileCustomizationGrantRecord[]; total: number }
  getGrantTarget: (profileId: string) => { profileId: string; displayName: string; accountRole: string | null; eligible: boolean } | null
  // /admin/payments — ЕДИН ред на Stripe поръчка (без безплатните предоставяния)
  getAdminPaymentListByPeriod: (params: { period: AdminPaymentPeriod; now?: Date }) => ProfileCustomizationAdminPaymentRow[]
  getAdminPaymentDetail: (orderId: string) => ProfileCustomizationAdminPaymentDetail | null
  // Режим на достъп
  getAccessState: () => ProfileCustomizationAccessState
  /** Записва нов режим (одит: кой/кога). Същият режим -> без нов запис. */
  setAccessMode: (mode: ProfileCustomizationAccessMode, actor: { profileId: string | null; displayName: string | null }) => { changed: boolean; state: ProfileCustomizationAccessState }
  listModeChanges: (limit: number) => ProfileCustomizationModeChange[]
  // Админ
  listAdminOrders: (input: { limit: number; offset: number; status?: string | null }) => { rows: ProfileCustomizationAdminOrderRow[]; total: number }
  getAdminKindStats: (now?: Date) => ProfileCustomizationAdminKindStats[]
  countPendingRefundReviews: () => number
  /**
   * Записва кой admin е прегледал и кога (само ако поръчката чака преглед).
   * id = id на поръчката или на неин ред.
   */
  markRefundReviewed: (orderOrPurchaseId: string, actor?: { profileId: string | null; displayName: string | null }) => boolean
  /**
   * Stripe refund е неуспешен/отменен (refund.failed / refund.updated /
   * charge.refund.updated). Нищо не се възстановява автоматично (по-нова
   * покупка/замяна може да е валидна) — покупката се маркира за преглед с
   * причина 'refund_failed'. Idempotent по Stripe refund id.
   */
  recordRefundFailure: (params: { checkoutSessionId?: string | null; paymentIntentId?: string | null; stripeRefundId: string; stripeEventId: string; now?: Date }) =>
    | { ok: true; outcome: 'marked_for_review' | 'already_recorded'; order: ProfileCustomizationOrderSnapshot }
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
  order_id: string | null
  profile_id: string | null
  kind: ProfileCustomizationKind
  item_id: string
  item_value_snapshot: string
  item_label_snapshot: string | null
  days_snapshot: ProfileCustomizationDurationDays
  base_price_30_days_cents_snapshot: number
  price_cents_snapshot: number
  currency: string
  status: ProfileCustomizationPurchaseStatus
  credited_at: string | null
  grant_effect: ProfileCustomizationGrantEffect | null
  chain_id: string | null
  granted_until_snapshot: string | null
  replaced_item_value_snapshot: string | null
  replaced_active_until_snapshot: string | null
  refunded_at: string | null
  refunded_amount_cents: number | null
  created_at: string
  updated_at: string
}

type OrderRow = {
  order_id: string
  profile_id: string | null
  item_count: number
  total_cents: number
  currency: string
  provider: string
  provider_checkout_session_id: string | null
  status: ProfileCustomizationPurchaseStatus
  paid_at: string | null
  refunded_at: string | null
  refunded_amount_cents: number | null
  refund_review_status: ProfileCustomizationRefundReviewStatus | null
  refund_review_reason: ProfileCustomizationRefundReviewReason | null
  refund_reviewed_at: string | null
  refund_reviewed_by_display_name_snapshot: string | null
  refund_failed_refund_id: string | null
  stripe_payment_intent_id: string | null
  hidden_at: string | null
  created_at: string
  updated_at: string
}

type CatalogItem = { itemId: string; value: string; label: string | null; isActive: boolean }

const PURCHASE_COLUMNS = `
  purchase_id, order_id, profile_id, kind, item_id, item_value_snapshot, item_label_snapshot,
  days_snapshot, base_price_30_days_cents_snapshot, price_cents_snapshot, currency,
  status, credited_at, grant_effect, chain_id,
  granted_until_snapshot, replaced_item_value_snapshot, replaced_active_until_snapshot,
  refunded_at, refunded_amount_cents, created_at, updated_at
`

const ORDER_COLUMNS = `
  order_id, profile_id, item_count, total_cents, currency, provider, provider_checkout_session_id,
  status, paid_at, refunded_at, refunded_amount_cents, refund_review_status, refund_review_reason,
  refund_reviewed_at, refund_reviewed_by_display_name_snapshot, refund_failed_refund_id,
  stripe_payment_intent_id, hidden_at, created_at, updated_at
`

/** Най-много една екстра от вид в поръчка — значи най-много 4 реда. */
const PROFILE_CUSTOMIZATION_MAX_ORDER_ITEMS = PROFILE_CUSTOMIZATION_KINDS.length

const KIND_ORDER_SQL = `CASE kind WHEN 'nickname_color' THEN 1 WHEN 'message_color' THEN 2 WHEN 'emoji_before' THEN 3 ELSE 4 END`

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
    orderId: row.order_id,
    kind: row.kind,
    itemId: row.item_id,
    itemValue: row.item_value_snapshot,
    itemLabel: row.item_label_snapshot,
    days: row.days_snapshot,
    basePrice30DaysCents: row.base_price_30_days_cents_snapshot,
    priceCents: row.price_cents_snapshot,
    currency: row.currency,
    status: row.status,
    creditedAt: row.credited_at,
    grantEffect: row.grant_effect,
    chainId: row.chain_id,
    grantedUntil: row.granted_until_snapshot,
    replacedItemValue: row.replaced_item_value_snapshot,
    replacedActiveUntil: row.replaced_active_until_snapshot,
    refundedAt: row.refunded_at,
    refundedAmountCents: row.refunded_amount_cents,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToOrder(row: OrderRow, lines: PurchaseRow[]): ProfileCustomizationOrderSnapshot {
  return {
    orderId: row.order_id,
    status: row.status,
    itemCount: row.item_count,
    totalCents: row.total_cents,
    currency: row.currency,
    provider: row.provider,
    providerCheckoutSessionId: row.provider_checkout_session_id,
    paidAt: row.paid_at,
    refundedAt: row.refunded_at,
    refundedAmountCents: row.refunded_amount_cents,
    refundReviewStatus: row.refund_review_status ?? null,
    refundReviewReason: row.refund_review_reason ?? null,
    refundReviewedAt: row.refund_reviewed_at ?? null,
    refundReviewedByDisplayName: row.refund_reviewed_by_display_name_snapshot ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: lines.map(rowToPurchase),
  }
}

/** Подпис на редовете — за повторно използване на същата неплатена поръчка. */
function orderLineSignature(lines: ReadonlyArray<{ kind: string; itemId: string; days: number; priceCents: number; basePrice30DaysCents: number; value: string }>): string {
  return lines
    .map((line) => `${line.kind}|${line.itemId}|${line.days}|${line.priceCents}|${line.basePrice30DaysCents}|${line.value}`)
    .sort()
    .join('\n')
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

  // ─── Statements: инвентар (притежавани) и използвани екстри ────────────
  // (миграция 20261108_002). profile_customization_active вече не се пише.
  const OWNED_COLUMNS = 'profile_id, kind, item_id, item_value_snapshot, item_label_snapshot, chain_id, chain_started_at, active_until'
  const selectOwnedRowStatement = database.prepare(`
    SELECT ${OWNED_COLUMNS} FROM profile_customization_owned_items WHERE profile_id = ? AND kind = ? AND item_id = ?;
  `)
  const selectOwnedRowsForProfileStatement = database.prepare(`
    SELECT ${OWNED_COLUMNS} FROM profile_customization_owned_items
    WHERE profile_id = ? AND active_until > ?
    ORDER BY ${KIND_ORDER_SQL}, active_until DESC, item_id;
  `)
  const selectEquippedRowsForProfileStatement = database.prepare(`
    SELECT ${OWNED_COLUMNS.split(',').map((column) => `o.${column.trim()}`).join(', ')}
    FROM profile_customization_equipped e
    JOIN profile_customization_owned_items o ON o.profile_id = e.profile_id AND o.kind = e.kind AND o.item_id = e.item_id
    WHERE e.profile_id = ?;
  `)
  const selectEquippedItemIdStatement = database.prepare(`
    SELECT item_id FROM profile_customization_equipped WHERE profile_id = ? AND kind = ?;
  `)
  const upsertOwnedRowStatement = database.prepare(`
    INSERT INTO profile_customization_owned_items (
      profile_id, kind, item_id, item_value_snapshot, item_label_snapshot,
      chain_id, chain_started_at, active_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, kind, item_id) DO UPDATE SET
      item_value_snapshot = excluded.item_value_snapshot,
      item_label_snapshot = excluded.item_label_snapshot,
      chain_id = excluded.chain_id,
      chain_started_at = excluded.chain_started_at,
      active_until = excluded.active_until,
      updated_at = excluded.updated_at;
  `)
  const updateOwnedUntilStatement = database.prepare(`
    UPDATE profile_customization_owned_items SET active_until = ?, updated_at = ?
    WHERE profile_id = ? AND kind = ? AND item_id = ? AND chain_id = ?;
  `)
  const deleteOwnedRowStatement = database.prepare(`
    DELETE FROM profile_customization_owned_items WHERE profile_id = ? AND kind = ? AND item_id = ? AND chain_id = ?;
  `)
  const upsertEquippedStatement = database.prepare(`
    INSERT INTO profile_customization_equipped (profile_id, kind, item_id, equipped_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, kind) DO UPDATE SET item_id = excluded.item_id, equipped_at = excluded.equipped_at;
  `)
  const deleteEquippedStatement = database.prepare(`
    DELETE FROM profile_customization_equipped WHERE profile_id = ? AND kind = ?;
  `)
  // Срокът на веригата = платените дни + безплатно предоставените дни
  // (20261108_003). Refund отнема само платените — предоставените остават.
  const sumPaidChainDaysStatement = database.prepare(`
    SELECT
      (SELECT COALESCE(SUM(days_snapshot), 0) FROM profile_customization_purchases WHERE chain_id = ?1 AND status = 'paid')
      + (SELECT COALESCE(SUM(days), 0) FROM profile_customization_grants WHERE chain_id = ?1) AS total_days;
  `)
  const insertGrantStatement = database.prepare(`
    INSERT INTO profile_customization_grants (
      grant_id, batch_id, profile_id, target_display_name_snapshot, kind, item_id, item_value_snapshot,
      item_label_snapshot, days, grant_effect, chain_id, granted_until_snapshot,
      granted_by_profile_id, granted_by_display_name_snapshot, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `)
  const selectProfileDisplayNameStatement = database.prepare(`SELECT display_name FROM profiles WHERE profile_id = ?;`)

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
  const selectOrderLinesStatement = database.prepare(`
    SELECT ${PURCHASE_COLUMNS} FROM profile_customization_purchases
    WHERE order_id = ?
    ORDER BY ${KIND_ORDER_SQL}, purchase_id;
  `)
  const selectOrderStatement = database.prepare(`SELECT ${ORDER_COLUMNS} FROM profile_customization_orders WHERE order_id = ?;`)
  const selectOrderBySessionStatement = database.prepare(`SELECT ${ORDER_COLUMNS} FROM profile_customization_orders WHERE provider_checkout_session_id = ?;`)
  const selectOrderByPaymentIntentStatement = database.prepare(`
    SELECT ${ORDER_COLUMNS} FROM profile_customization_orders
    WHERE stripe_payment_intent_id = ?
    ORDER BY created_at DESC LIMIT 1;
  `)
  const selectVisiblePendingOrderStatement = database.prepare(`
    SELECT ${ORDER_COLUMNS} FROM profile_customization_orders
    WHERE profile_id = ? AND status = 'pending' AND hidden_at IS NULL
    ORDER BY created_at DESC LIMIT 1;
  `)
  const insertPendingOrderStatement = database.prepare(`
    INSERT INTO profile_customization_orders (
      order_id, profile_id, item_count, total_cents, currency, provider, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'EUR', 'stripe', 'pending', ?, ?);
  `)
  const insertPendingLineStatement = database.prepare(`
    INSERT INTO profile_customization_purchases (
      purchase_id, order_id, profile_id, kind, item_id, item_value_snapshot, item_label_snapshot,
      days_snapshot, base_price_30_days_cents_snapshot, price_cents_snapshot, currency,
      provider, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EUR', 'stripe', 'pending', ?, ?);
  `)
  const retirePendingOrderStatement = database.prepare(`
    UPDATE profile_customization_orders
    SET hidden_at = ?, updated_at = ?
    WHERE order_id = ? AND status = 'pending' AND hidden_at IS NULL;
  `)
  const retirePendingLinesStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET hidden_at = ?, updated_at = ?
    WHERE order_id = ? AND status = 'pending' AND hidden_at IS NULL;
  `)
  const attachOrderCheckoutSessionStatement = database.prepare(`
    UPDATE profile_customization_orders
    SET provider_checkout_session_id = ?, updated_at = ?
    WHERE order_id = ? AND status = 'pending';
  `)
  const setOrderStatusFromPendingStatement = database.prepare(`
    UPDATE profile_customization_orders SET status = ?, updated_at = ?
    WHERE order_id = ? AND status = 'pending';
  `)
  const setLinesStatusFromPendingStatement = database.prepare(`
    UPDATE profile_customization_purchases SET status = ?, updated_at = ?
    WHERE order_id = ? AND status = 'pending';
  `)
  // CAS — само един от N конкурентни/повторени webhook-а минава
  // (WHERE status = 'pending'); губещите виждат changes = 0.
  const markOrderPaidStatement = database.prepare(`
    UPDATE profile_customization_orders
    SET status = 'paid', paid_at = ?, stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), updated_at = ?,
        -- Частичен refund, пристигнал ПРЕДИ кредитирането: правата се
        -- активират, но поръчката задължително чака преглед.
        refund_review_status = CASE
          WHEN COALESCE(refunded_amount_cents, 0) > 0 AND refund_review_status IS NULL THEN 'pending'
          ELSE refund_review_status
        END,
        refund_review_reason = CASE
          WHEN COALESCE(refunded_amount_cents, 0) > 0 AND refund_review_status IS NULL THEN 'partial_refund'
          ELSE refund_review_reason
        END
    WHERE order_id = ? AND status = 'pending';
  `)
  const markLinePaidStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET status = 'paid', credited_at = ?, grant_effect = ?, chain_id = ?, granted_until_snapshot = ?,
        replaced_item_value_snapshot = ?, replaced_active_until_snapshot = ?, updated_at = ?
    WHERE purchase_id = ? AND status = 'pending';
  `)
  const markOrderRefundedBeforeCreditStatement = database.prepare(`
    UPDATE profile_customization_orders
    SET status = 'refunded', stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?), updated_at = ?
    WHERE order_id = ? AND status = 'pending';
  `)
  const markLineRefundedStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET status = 'refunded', refunded_at = COALESCE(refunded_at, ?), refunded_amount_cents = price_cents_snapshot, updated_at = ?
    WHERE purchase_id = ?;
  `)
  const markLinePartialRefundStatement = database.prepare(`
    UPDATE profile_customization_purchases
    SET refunded_at = COALESCE(refunded_at, ?), refunded_amount_cents = ?, updated_at = ?
    WHERE purchase_id = ?;
  `)
  const markOrderRefundStatement = database.prepare(`
    UPDATE profile_customization_orders
    SET status = ?, refunded_at = COALESCE(refunded_at, ?), refunded_amount_cents = ?,
        refund_stripe_event_id = ?, updated_at = ?,
        -- NULL = без промяна; 'pending' = частичен refund чака преглед (нова
        -- по-голяма частична сума връща вече прегледана поръчка за преглед).
        refund_review_status = COALESCE(?, refund_review_status),
        -- При ново маркиране за преглед: причината и нулиране на предишния
        -- преглед (кой/кога) — иначе без промяна.
        refund_review_reason = COALESCE(?, refund_review_reason),
        refund_reviewed_at = CASE WHEN ? IS NULL THEN refund_reviewed_at ELSE NULL END,
        refund_reviewed_by_profile_id = CASE WHEN ? IS NULL THEN refund_reviewed_by_profile_id ELSE NULL END,
        refund_reviewed_by_display_name_snapshot = CASE WHEN ? IS NULL THEN refund_reviewed_by_display_name_snapshot ELSE NULL END
    WHERE order_id = ?;
  `)
  const markRefundReviewedStatement = database.prepare(`
    UPDATE profile_customization_orders
    SET refund_review_status = 'reviewed', refund_reviewed_at = ?, updated_at = ?,
        refund_reviewed_by_profile_id = ?, refund_reviewed_by_display_name_snapshot = ?
    WHERE order_id = ? AND refund_review_status = 'pending';
  `)
  const markRefundFailedStatement = database.prepare(`
    UPDATE profile_customization_orders
    SET refund_review_status = 'pending', refund_review_reason = 'refund_failed',
        refund_failed_refund_id = ?, refund_failed_at = ?, refund_stripe_event_id = ?, updated_at = ?,
        refund_reviewed_at = NULL, refund_reviewed_by_profile_id = NULL, refund_reviewed_by_display_name_snapshot = NULL
    WHERE order_id = ?;
  `)
  const updatePaymentMethodSnapshotStatement = database.prepare(`
    UPDATE profile_customization_orders
    SET
      stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
      stripe_charge_id         = COALESCE(stripe_charge_id, ?),
      payment_method_type      = COALESCE(payment_method_type, ?),
      wallet_type              = COALESCE(wallet_type, ?),
      card_brand               = COALESCE(card_brand, ?),
      card_last4               = COALESCE(card_last4, ?),
      card_country             = COALESCE(card_country, ?),
      updated_at               = ?
    WHERE order_id = ?;
  `)
  const needsPaymentMethodSnapshotStatement = database.prepare(`
    SELECT 1 FROM profile_customization_orders
    WHERE order_id = ? AND (stripe_charge_id IS NULL OR payment_method_type IS NULL)
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

  /** Притежаван и неизтекъл вариант (профил + вид + артикул). */
  function getLiveOwnedRow(profileId: string, kind: ProfileCustomizationKind, itemId: string, nowIso: string): ActiveRow | null {
    const row = selectOwnedRowStatement.get(profileId, kind, itemId) as ActiveRow | undefined
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

    // Същият вариант, който потребителят вече притежава (валиден) -> удължаване.
    const owned = getLiveOwnedRow(profileId, kind, item.itemId, nowIso)
    const isExtensionOfOwned = owned !== null
    // Скрит артикул не се продава на нови купувачи, но притежателят на
    // валиден вариант може да го удължи ("Удължи").
    if (!item.isActive && !isExtensionOfOwned) {
      return failure('item_not_for_sale', 'Този артикул вече не се продава.')
    }
    if (getProfileCustomizationItemType(kind) === 'color' && isReservedOrNearReservedStaffColor(item.value)) {
      return failure('reserved_color', 'Този цвят е запазен за екипа на Pika.bg.')
    }

    const basePrice30DaysCents = settings.base_price_30_days_cents
    const priceCents = computeProfileCustomizationPriceCents(basePrice30DaysCents, days)

    // Инвентар: различен вариант се ДОБАВЯ (нищо не се губи) — 'replace'
    // вече не се създава; съществува само в старите записи.
    const effect: ProfileCustomizationGrantEffect = isExtensionOfOwned ? 'extend' : 'new'
    const resultingActiveUntil = owned !== null ? addDays(owned.active_until, days) : addDays(nowIso, days)
    const forfeitedDays = 0

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
        current: owned !== null ? rowToActiveItem(owned, now) : null,
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

  // ─── Използвани екстри и инвентар ──────────────────────────────────────

  /** Използваните в момента (най-много една на вид); изтекъл използван -> null (без автоматична замяна). */
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
    for (const row of selectEquippedRowsForProfileStatement.all(normalizedProfileId) as ActiveRow[]) {
      if (row.active_until > nowIso) result[row.kind] = rowToActiveItem(row, now)
    }
    return result
  }

  /** "Моите персонализации": всички притежавани и неизтекли варианти + дали се използват. */
  function getProfileOwnedItems(profileId: string, now: Date = new Date()): ProfileCustomizationOwnedItem[] {
    const normalizedProfileId = normalizeId(profileId)
    if (normalizedProfileId.length === 0) return []
    const nowIso = now.toISOString()
    const equipped = new Map((selectEquippedRowsForProfileStatement.all(normalizedProfileId) as ActiveRow[]).map((row) => [row.kind, row.item_id]))
    return (selectOwnedRowsForProfileStatement.all(normalizedProfileId, nowIso) as ActiveRow[]).map((row) => ({
      ...rowToActiveItem(row, now),
      equipped: equipped.get(row.kind) === row.item_id,
    }))
  }

  /**
   * "Използвай": прави притежаван и неизтекъл вариант използван (предишният
   * от същия вид става "Наличен"). Безплатно — правата/сроковете не се пипат.
   */
  function equipItem(input: { profileId: string; kind: string; itemId: string; now?: Date }): { ok: true; active: ProfileCustomizationActiveItems; owned: ProfileCustomizationOwnedItem[] } | ProfileCustomizationFailure {
    const profileId = normalizeId(input.profileId)
    const itemId = normalizeId(input.itemId)
    if (profileId.length === 0 || itemId.length === 0) return failure('invalid_request', 'Невалидна заявка.')
    if (!isProfileCustomizationKind(input.kind)) return failure('invalid_kind', 'Невалиден вид персонализация.')
    const now = input.now ?? new Date()
    const nowIso = now.toISOString()
    // Проверка + запис в една транзакция (конкурентен refund/изтичане).
    try {
      database.exec('BEGIN IMMEDIATE;')
      const owned = selectOwnedRowStatement.get(profileId, input.kind, itemId) as ActiveRow | undefined
      if (!owned) {
        rollbackQuietly()
        return failure('not_owned', 'Не притежаваш тази персонализация.')
      }
      if (owned.active_until <= nowIso) {
        rollbackQuietly()
        return failure('expired', 'Срокът на тази персонализация е изтекъл.')
      }
      upsertEquippedStatement.run(profileId, input.kind, itemId, nowIso)
      database.exec('COMMIT;')
    } catch (error) {
      rollbackQuietly()
      throw error
    }
    return { ok: true, active: getProfileActiveItems(profileId, now), owned: getProfileOwnedItems(profileId, now) }
  }

  /** "Премахни": спира само визуалния ефект; правото и срокът остават, без refund. */
  function unequipItem(input: { profileId: string; kind: string; now?: Date }): { ok: true; removed: boolean; active: ProfileCustomizationActiveItems; owned: ProfileCustomizationOwnedItem[] } | ProfileCustomizationFailure {
    const profileId = normalizeId(input.profileId)
    if (profileId.length === 0) return failure('invalid_request', 'Невалидна заявка.')
    if (!isProfileCustomizationKind(input.kind)) return failure('invalid_kind', 'Невалиден вид персонализация.')
    const now = input.now ?? new Date()
    const result = deleteEquippedStatement.run(profileId, input.kind) as { changes?: number }
    return { ok: true, removed: (result.changes ?? 0) > 0, active: getProfileActiveItems(profileId, now), owned: getProfileOwnedItems(profileId, now) }
  }

  function getAppearancesForProfiles(profileIds: readonly string[], now: Date = new Date()): Map<string, ProfileCustomizationAppearance> {
    const appearances = new Map<string, ProfileCustomizationAppearance>()
    const uniqueProfileIds = [...new Set(profileIds.map(normalizeId).filter((id) => id.length > 0))]
    const nowIso = now.toISOString()
    for (let start = 0; start < uniqueProfileIds.length; start += APPEARANCE_BATCH_CHUNK_SIZE) {
      const chunk = uniqueProfileIds.slice(start, start + APPEARANCE_BATCH_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      // САМО използваният вариант на вид (и само ако не е изтекъл).
      const rows = database.prepare(`
        SELECT e.profile_id, e.kind, o.item_value_snapshot, o.active_until
        FROM profile_customization_equipped e
        JOIN profile_customization_owned_items o ON o.profile_id = e.profile_id AND o.kind = e.kind AND o.item_id = e.item_id
        WHERE e.profile_id IN (${placeholders}) AND o.active_until > ?;
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

  // ─── Покупки (поръчки с 1..4 реда) ─────────────────────────────────────

  function previewPurchase(input: { profileId: string; kind: string; itemId: string; days: number; now?: Date; ignoreSalesToggle?: boolean }): { ok: true; preview: ProfileCustomizationPurchasePreview } | ProfileCustomizationFailure {
    const resolved = resolvePurchaseRequest(input)
    if ('ok' in resolved) return resolved
    return { ok: true, preview: resolved.preview }
  }

  /**
   * Валидира цялата поръчка: 1..4 реда, всеки вид най-много веднъж, всеки ред
   * поотделно (продажба, артикул, срок, запазен цвят). Обща сума = сумата на
   * редовете (всеки = база × дни/30) — клиентът никога не подава цена.
   */
  function resolveOrderRequest(input: ProfileCustomizationOrderInput): { profileId: string; lines: ResolvedPurchaseRequest[]; preview: ProfileCustomizationOrderPreview } | ProfileCustomizationFailure {
    if (!Array.isArray(input.items)) return failure('invalid_request', 'Невалидна заявка за покупка.')
    if (input.items.length === 0) return failure('empty_order', 'Избери поне една персонализация.')
    if (input.items.length > PROFILE_CUSTOMIZATION_MAX_ORDER_ITEMS) {
      return failure('too_many_items', `Една поръчка може да съдържа най-много ${PROFILE_CUSTOMIZATION_MAX_ORDER_ITEMS} персонализации.`)
    }
    const seenKinds = new Set<string>()
    const lines: ResolvedPurchaseRequest[] = []
    for (const rawItem of input.items as readonly unknown[]) {
      if (typeof rawItem !== 'object' || rawItem === null) return failure('invalid_request', 'Невалидна заявка за покупка.')
      const item = rawItem as Record<string, unknown>
      const kind = typeof item.kind === 'string' ? item.kind : ''
      if (seenKinds.has(kind)) {
        return { ...failure('duplicate_kind', 'Всяка персонализация може да присъства само веднъж в поръчката.'), ...(isProfileCustomizationKind(kind) ? { kind } : {}) }
      }
      seenKinds.add(kind)
      const resolved = resolvePurchaseRequest({
        profileId: input.profileId,
        kind,
        itemId: typeof item.itemId === 'string' ? item.itemId : '',
        days: typeof item.days === 'number' ? item.days : Number.NaN,
        now: input.now,
        ignoreSalesToggle: input.ignoreSalesToggle,
      })
      if ('ok' in resolved) {
        if (!isProfileCustomizationKind(kind)) return resolved
        return { ...resolved, message: `${PROFILE_CUSTOMIZATION_KIND_LABELS[kind]}: ${resolved.message}`, kind }
      }
      lines.push(resolved)
    }
    lines.sort((a, b) => PROFILE_CUSTOMIZATION_KINDS.indexOf(a.kind) - PROFILE_CUSTOMIZATION_KINDS.indexOf(b.kind))
    const totalCents = lines.reduce((sum, line) => sum + line.priceCents, 0)
    return {
      profileId: lines[0]!.profileId,
      lines,
      preview: { lines: lines.map((line) => line.preview), totalCents, currency: 'EUR' },
    }
  }

  function previewOrder(input: ProfileCustomizationOrderInput): { ok: true; preview: ProfileCustomizationOrderPreview } | ProfileCustomizationFailure {
    const resolved = resolveOrderRequest(input)
    if ('ok' in resolved) return resolved
    return { ok: true, preview: resolved.preview }
  }

  function getOrderRow(orderId: string): OrderRow | null {
    return (selectOrderStatement.get(orderId) as OrderRow | undefined) ?? null
  }

  function getOrderLines(orderId: string): PurchaseRow[] {
    return selectOrderLinesStatement.all(orderId) as PurchaseRow[]
  }

  function orderSnapshot(row: OrderRow): ProfileCustomizationOrderSnapshot {
    return rowToOrder(row, getOrderLines(row.order_id))
  }

  function createPendingOrder(input: ProfileCustomizationOrderInput): { ok: true; order: ProfileCustomizationOrderSnapshot; preview: ProfileCustomizationOrderPreview } | ProfileCustomizationFailure {
    const resolved = resolveOrderRequest(input)
    if ('ok' in resolved) return resolved
    const { profileId, lines, preview } = resolved
    const nowIso = (input.now ?? new Date()).toISOString()
    const requestedSignature = orderLineSignature(lines.map((line) => ({
      kind: line.kind,
      itemId: line.item.itemId,
      days: line.days,
      priceCents: line.priceCents,
      basePrice30DaysCents: line.basePrice30DaysCents,
      value: line.item.value,
    })))
    let resultOrderId: string = randomUUID()

    try {
      // Mirror на vipPurchaseStore.createPendingPurchase, но за цялата
      // поръчка: видима неплатена поръчка със СЪЩИТЕ редове и цени се
      // използва повторно; иначе се скрива (отворената ѝ Stripe сесия може
      // още да завърши по първоначалните условия) и се създава нова.
      database.exec('BEGIN IMMEDIATE;')
      const existing = selectVisiblePendingOrderStatement.get(profileId) as OrderRow | undefined
      const existingSignature = existing !== undefined
        ? orderLineSignature(getOrderLines(existing.order_id).map((line) => ({
            kind: line.kind,
            itemId: line.item_id,
            days: line.days_snapshot,
            priceCents: line.price_cents_snapshot,
            basePrice30DaysCents: line.base_price_30_days_cents_snapshot,
            value: line.item_value_snapshot,
          })))
        : null
      if (existing !== undefined && existingSignature === requestedSignature && existing.total_cents === preview.totalCents) {
        resultOrderId = existing.order_id
      } else {
        if (existing !== undefined) {
          retirePendingOrderStatement.run(nowIso, nowIso, existing.order_id)
          retirePendingLinesStatement.run(nowIso, nowIso, existing.order_id)
        }
        insertPendingOrderStatement.run(resultOrderId, profileId, lines.length, preview.totalCents, nowIso, nowIso)
        for (const line of lines) {
          insertPendingLineStatement.run(
            randomUUID(),
            resultOrderId,
            profileId,
            line.kind,
            line.item.itemId,
            line.item.value,
            line.item.label,
            line.days,
            line.basePrice30DaysCents,
            line.priceCents,
            nowIso,
            nowIso,
          )
        }
      }
      database.exec('COMMIT;')
    } catch (error) {
      rollbackQuietly()
      throw error
    }

    const row = getOrderRow(resultOrderId)
    if (row === null) return failure('not_found', 'Поръчката не беше записана.')
    return { ok: true, order: orderSnapshot(row), preview }
  }

  function getOrderById(orderId: string): ProfileCustomizationOrderSnapshot | null {
    const row = getOrderRow(normalizeId(orderId))
    return row ? orderSnapshot(row) : null
  }

  function getPurchaseById(purchaseId: string): ProfileCustomizationPurchaseSnapshot | null {
    const row = getPurchaseRow(normalizeId(purchaseId))
    return row ? rowToPurchase(row) : null
  }

  function attachOrderCheckoutSession(orderId: string, checkoutSessionId: string): ProfileCustomizationOrderSnapshot | null {
    attachOrderCheckoutSessionStatement.run(checkoutSessionId, new Date().toISOString(), orderId)
    return getOrderById(orderId)
  }

  function retirePendingOrder(orderId: string): boolean {
    const nowIso = new Date().toISOString()
    try {
      database.exec('BEGIN IMMEDIATE;')
      const result = retirePendingOrderStatement.run(nowIso, nowIso, orderId) as { changes?: number }
      retirePendingLinesStatement.run(nowIso, nowIso, orderId)
      database.exec('COMMIT;')
      return (result.changes ?? 0) > 0
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function findOrderByCheckoutSessionId(checkoutSessionId: string): ProfileCustomizationOrderSnapshot | null {
    const row = selectOrderBySessionStatement.get(checkoutSessionId) as OrderRow | undefined
    return row ? orderSnapshot(row) : null
  }

  function findProfileOrderByCheckoutSessionId(profileId: string, checkoutSessionId: string): ProfileCustomizationOrderSnapshot | null {
    const row = selectOrderBySessionStatement.get(checkoutSessionId.trim()) as OrderRow | undefined
    return row && row.profile_id !== null && row.profile_id === normalizeId(profileId) ? orderSnapshot(row) : null
  }

  /** Неплатена поръчка -> canceled/failed заедно с редовете ѝ (само от 'pending'). */
  function closePendingOrderBySession(checkoutSessionId: string, status: 'canceled' | 'failed'): void {
    const row = selectOrderBySessionStatement.get(checkoutSessionId) as OrderRow | undefined
    if (!row || row.status !== 'pending') return
    const nowIso = new Date().toISOString()
    try {
      database.exec('BEGIN IMMEDIATE;')
      const result = setOrderStatusFromPendingStatement.run(status, nowIso, row.order_id) as { changes?: number }
      if ((result.changes ?? 0) > 0) setLinesStatusFromPendingStatement.run(status, nowIso, row.order_id)
      database.exec('COMMIT;')
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function markOrderCanceledByCheckoutSessionId(checkoutSessionId: string): void {
    closePendingOrderBySession(checkoutSessionId, 'canceled')
  }

  function markOrderFailedByCheckoutSessionId(checkoutSessionId: string): void {
    closePendingOrderBySession(checkoutSessionId, 'failed')
  }

  function failureContext(row: OrderRow): Pick<PurchaseFulfillmentFailure, 'purchaseId' | 'payerProfileId' | 'expectedAmountCents' | 'expectedCurrency'> {
    return {
      purchaseId: row.order_id,
      payerProfileId: row.profile_id,
      expectedAmountCents: row.total_cents,
      expectedCurrency: row.currency,
    }
  }

  function activeItemsFor(profileId: string | null, now: Date): ProfileCustomizationActiveItems {
    return profileId === null ? getProfileActiveItems('', now) : getProfileActiveItems(profileId, now)
  }

  function alreadyCreditedResult(row: OrderRow, now: Date, refundedBeforeCredit = false): FulfillPaidProfileCustomizationOrderResult {
    return {
      ok: true,
      order: orderSnapshot(row),
      payerProfileId: row.profile_id,
      alreadyCredited: true,
      refundedBeforeCredit,
      active: activeItemsFor(row.profile_id, now),
    }
  }

  /**
   * Кредитиране на цялата поръчка — САМО от webhook-а. Една BEGIN IMMEDIATE
   * транзакция: CAS на поръчката pending->paid, после всеки ред (CAS
   * pending->paid + активната екстра). Грешка в който и да е ред връща
   * всичко назад — няма частично активирана поръчка. Повторен/закъснял
   * webhook вижда 'paid' и не кредитира втори път.
   */
  function fulfillPaidOrder(params: FulfillPaidProfileCustomizationOrderParams): FulfillPaidProfileCustomizationOrderResult {
    const now = params.now ?? new Date()
    const nowIso = now.toISOString()

    // Търсене СТРОГО по checkout session id (UNIQUE) — orderId от metadata е
    // само кръстосана проверка.
    if (!params.checkoutSessionId) {
      return { ok: false, reason: 'purchase_not_found', message: 'Липсва checkout session id.' }
    }
    const row = selectOrderBySessionStatement.get(params.checkoutSessionId) as OrderRow | undefined
    if (!row) {
      return { ok: false, reason: 'purchase_not_found', message: 'Поръчката не беше намерена за тази checkout сесия.' }
    }
    if (params.orderId && row.order_id !== params.orderId) {
      return { ok: false, reason: 'purchase_id_mismatch', message: 'Несъответствие между checkout сесията и orderId.', ...failureContext(row) }
    }

    // Повторна доставка след кредитиране (вкл. по-късно възстановена поръчка)
    // — потвърждава се idempotent, без повторна проверка и без нов ефект.
    if (row.paid_at !== null) return alreadyCreditedResult(row, now)
    if (row.status === 'refunded') return alreadyCreditedResult(row, now, true)

    if (params.stripePaymentStatus !== 'paid') {
      return { ok: false, reason: 'not_paid', message: `Stripe payment_status "${params.stripePaymentStatus}" не е "paid".` }
    }
    if (params.stripeCurrency.toUpperCase() !== row.currency.toUpperCase()) {
      return { ok: false, reason: 'currency_mismatch', ...failureContext(row), message: `Валутата от Stripe (${params.stripeCurrency}) не съвпада с очакваната (${row.currency}).` }
    }
    const lines = getOrderLines(row.order_id)
    const linesTotal = lines.reduce((sum, line) => sum + line.price_cents_snapshot, 0)
    if (lines.length !== row.item_count || linesTotal !== row.total_cents) {
      return { ok: false, reason: 'amount_mismatch', ...failureContext(row), message: `Редовете на поръчката (${lines.length}, ${linesTotal}) не съвпадат с общата сума (${row.item_count}, ${row.total_cents}).` }
    }
    if (params.stripeAmountTotalCents !== row.total_cents) {
      return { ok: false, reason: 'amount_mismatch', ...failureContext(row), message: `Платената сума от Stripe (${params.stripeAmountTotalCents}) не съвпада с очакваната обща сума (${row.total_cents}).` }
    }
    if (row.status !== 'pending') {
      return { ok: false, reason: 'not_creditable', ...failureContext(row), message: `Поръчката е в статус "${row.status}" и не може да бъде кредитирана.` }
    }
    if (row.profile_id === null) {
      return { ok: false, reason: 'not_creditable', ...failureContext(row), message: 'Профилът на купувача вече не съществува. Плащането не е кредитирано — необходим е ръчен преглед.' }
    }
    const profileId = row.profile_id
    const paymentIntentId = params.stripePaymentIntentId?.trim() || null

    let refundedBeforeCredit = false
    try {
      database.exec('BEGIN IMMEDIATE;')
      // Пресен прочит вътре в транзакцията (конкурентен webhook/refund).
      const fresh = getOrderRow(row.order_id) as OrderRow

      if (fresh.status === 'pending' && fresh.refunded_at !== null && (fresh.refunded_amount_cents ?? 0) >= fresh.total_cents) {
        // Пълен refund пристигна ПРЕДИ checkout.session.completed — нищо не
        // се активира, поръчката и редовете приключват като възстановени.
        markOrderRefundedBeforeCreditStatement.run(paymentIntentId, nowIso, fresh.order_id)
        for (const line of getOrderLines(fresh.order_id)) {
          if (line.status === 'pending') markLineRefundedStatement.run(nowIso, nowIso, line.purchase_id)
        }
        refundedBeforeCredit = true
      } else {
        const cas = markOrderPaidStatement.run(nowIso, paymentIntentId, nowIso, fresh.order_id) as { changes?: number }
        if ((cas.changes ?? 0) === 0) {
          rollbackQuietly()
          const after = getOrderRow(row.order_id)
          if (after?.paid_at) return alreadyCreditedResult(after, now)
          return { ok: false, reason: 'credit_failed', transient: true, message: 'Поръчката вече беше обработена от друг процес.' }
        }

        for (const line of getOrderLines(fresh.order_id)) {
          if (line.status !== 'pending') {
            throw new Error(`Редът ${line.purchase_id} е в статус "${line.status}" — поръчката не е кредитирана.`)
          }
          // Инвентар: виж creditOwnedItem (общо с безплатното предоставяне).
          const credited = creditOwnedItem(profileId, line.kind, line.item_id, line.item_value_snapshot, line.item_label_snapshot, line.days_snapshot, nowIso)
          const lineCas = markLinePaidStatement.run(
            nowIso, credited.effect, credited.chainId, credited.activeUntil, null, null, nowIso, line.purchase_id,
          ) as { changes?: number }
          if ((lineCas.changes ?? 0) === 0) {
            throw new Error(`Редът ${line.purchase_id} вече е обработен — поръчката не е кредитирана.`)
          }
        }
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

    const fulfilled = getOrderRow(row.order_id)
    if (fulfilled === null) {
      return { ok: false, reason: 'credit_failed', transient: true, message: 'Персонализацията беше активирана, но поръчката не може да се прочете.' }
    }
    return {
      ok: true,
      order: orderSnapshot(fulfilled),
      payerProfileId: fulfilled.profile_id,
      alreadyCredited: false,
      refundedBeforeCredit,
      active: activeItemsFor(fulfilled.profile_id, now),
    }
  }

  /**
   * Анулира правото на един ред (пълен refund на поръчката) — само в
   * притежавания вариант, от който е редът, и само ако редът е от
   * ТЕКУЩАТА му верига (иначе вариантът вече е бил изтекъл и купен наново).
   * Срокът = начало на веригата + сума(дни на оставащите платени редове във
   * веригата): другите удължавания на същия вариант (и от други поръчки)
   * запазват всичките си дни; другите варианти не се пипат. Нула дни ->
   * вариантът изчезва от инвентара (и от "използва се" — FK CASCADE), без
   * автоматично използване на друг.
   */
  function revokeLineGrant(line: PurchaseRow, nowIso: string): void {
    if (line.profile_id === null || line.chain_id === null) return
    const owned = selectOwnedRowStatement.get(line.profile_id, line.kind, line.item_id) as ActiveRow | undefined
    if (!owned || owned.chain_id !== line.chain_id) return
    const remainingDays = (sumPaidChainDaysStatement.get(line.chain_id) as { total_days: number }).total_days
    if (remainingDays <= 0) {
      deleteOwnedRowStatement.run(line.profile_id, line.kind, line.item_id, line.chain_id)
    } else {
      updateOwnedUntilStatement.run(addDays(owned.chain_started_at, remainingDays), nowIso, line.profile_id, line.kind, line.item_id, line.chain_id)
    }
  }

  /**
   * Добавя дни към притежаван вариант — ОБЩО за платен ред и за безплатно
   * предоставяне (извиква се вътре в транзакцията на извикващия):
   *   * същият вариант е притежаван и валиден -> 'extend': срокът += дните
   *     в СЪЩАТА верига (без второ копие);
   *   * иначе -> 'new': нова верига от сега и вариантът автоматично става
   *     използван (предишният от същия вид остава "Наличен").
   * Другите притежавани варианти не се пипат — никой не губи дни.
   */
  function creditOwnedItem(profileId: string, kind: ProfileCustomizationKind, itemId: string, value: string, label: string | null, days: number, nowIso: string): { effect: 'new' | 'extend'; chainId: string; activeUntil: string } {
    const owned = getLiveOwnedRow(profileId, kind, itemId, nowIso)
    const effect: 'new' | 'extend' = owned !== null ? 'extend' : 'new'
    const chainId = owned !== null ? owned.chain_id : randomUUID()
    const chainStartedAt = owned !== null ? owned.chain_started_at : nowIso
    const activeUntil = owned !== null ? addDays(owned.active_until, days) : addDays(nowIso, days)
    upsertOwnedRowStatement.run(profileId, kind, itemId, value, label, chainId, chainStartedAt, activeUntil, nowIso, nowIso)
    if (effect === 'new') upsertEquippedStatement.run(profileId, kind, itemId, nowIso)
    return { effect, chainId, activeUntil }
  }

  // ─── Безплатно предоставяне от admin ───────────────────────────────────

  type GrantRowDb = {
    grant_id: string
    batch_id: string
    profile_id: string | null
    target_display_name_snapshot: string | null
    current_display_name: string | null
    kind: ProfileCustomizationKind
    item_id: string
    item_value_snapshot: string
    item_label_snapshot: string | null
    days: number
    grant_effect: 'new' | 'extend'
    granted_until_snapshot: string
    granted_by_profile_id: string | null
    granted_by_display_name_snapshot: string | null
    created_at: string
  }

  function rowToGrant(row: GrantRowDb): ProfileCustomizationGrantRecord {
    return {
      grantId: row.grant_id,
      batchId: row.batch_id,
      profileId: row.profile_id,
      targetDisplayName: row.current_display_name ?? row.target_display_name_snapshot,
      kind: row.kind,
      kindLabel: PROFILE_CUSTOMIZATION_KIND_LABELS[row.kind],
      itemType: getProfileCustomizationItemType(row.kind),
      itemId: row.item_id,
      itemValue: row.item_value_snapshot,
      itemLabel: row.item_label_snapshot,
      days: row.days,
      grantEffect: row.grant_effect,
      grantedUntil: row.granted_until_snapshot,
      grantedByProfileId: row.granted_by_profile_id,
      grantedByDisplayName: row.granted_by_display_name_snapshot,
      createdAt: row.created_at,
    }
  }

  const GRANT_SELECT = `
    SELECT g.grant_id, g.batch_id, g.profile_id, g.target_display_name_snapshot, p.display_name AS current_display_name,
           g.kind, g.item_id, g.item_value_snapshot, g.item_label_snapshot, g.days, g.grant_effect,
           g.granted_until_snapshot, g.granted_by_profile_id, g.granted_by_display_name_snapshot, g.created_at
    FROM profile_customization_grants g
    LEFT JOIN profiles p ON p.profile_id = g.profile_id
  `

  /**
   * "Приложи безплатно" — само извикващият HTTP слой проверява пълната роля
   * admin. Същата валидация като поръчката (1..4 реда, по един вид, артикул
   * в продажба или притежаван от получателя, запазен цвят, срок), но без
   * цена/Stripe/жълтици. Всички редове в ЕДНА транзакция: невалиден ред ->
   * нищо не се прилага. Всеки ред е и одит (кой/на кого/кога/какво/дни/нов
   * срок/ефект).
   */
  function grantItems(input: ProfileCustomizationGrantInput): { ok: true; batchId: string; grants: ProfileCustomizationGrantRecord[]; active: ProfileCustomizationActiveItems; owned: ProfileCustomizationOwnedItem[] } | ProfileCustomizationFailure {
    const now = input.now ?? new Date()
    const nowIso = now.toISOString()
    // ignoreSalesToggle: предоставянето не зависи от публичната продажба.
    const resolved = resolveOrderRequest({ profileId: input.targetProfileId, items: input.items, now, ignoreSalesToggle: true })
    if ('ok' in resolved) return resolved
    const { profileId, lines } = resolved
    const batchId = randomUUID()
    const targetName = (selectProfileDisplayNameStatement.get(profileId) as { display_name: string | null } | undefined)?.display_name ?? null
    const adminName = input.adminDisplayName?.trim().slice(0, 80) || null
    try {
      database.exec('BEGIN IMMEDIATE;')
      for (const line of lines) {
        const credited = creditOwnedItem(profileId, line.kind, line.item.itemId, line.item.value, line.item.label, line.days, nowIso)
        insertGrantStatement.run(
          randomUUID(), batchId, profileId, targetName, line.kind, line.item.itemId, line.item.value, line.item.label,
          line.days, credited.effect, credited.chainId, credited.activeUntil, input.adminProfileId, adminName, nowIso,
        )
      }
      database.exec('COMMIT;')
    } catch (error) {
      rollbackQuietly()
      throw error
    }
    const grants = (database.prepare(`${GRANT_SELECT} WHERE g.batch_id = ? ORDER BY ${KIND_ORDER_SQL.replace('kind', 'g.kind')};`).all(batchId) as GrantRowDb[]).map(rowToGrant)
    return { ok: true, batchId, grants, active: getProfileActiveItems(profileId, now), owned: getProfileOwnedItems(profileId, now) }
  }

  /** Получател на предоставяне: името, ролята на акаунта (служебният цвят има приоритет) и допустим ли е. */
  function getGrantTarget(profileId: string): { profileId: string; displayName: string; accountRole: string | null; eligible: boolean } | null {
    const id = normalizeId(profileId)
    if (id.length === 0) return null
    const row = database.prepare(`
      SELECT p.profile_id, p.display_name, a.role
      FROM profiles p LEFT JOIN accounts a ON a.account_id = p.account_id
      WHERE p.profile_id = ?;
    `).get(id) as { profile_id: string; display_name: string; role: string | null } | undefined
    if (!row) return null
    return { profileId: row.profile_id, displayName: row.display_name, accountRole: row.role ?? null, eligible: selectEligibleProfileStatement.get(id) !== undefined }
  }

  function listGrants(input: { limit: number; offset: number; profileId?: string | null }): { rows: ProfileCustomizationGrantRecord[]; total: number } {
    const limit = Math.min(Math.max(Number.isSafeInteger(input.limit) ? input.limit : 50, 1), 200)
    const offset = Math.max(Number.isSafeInteger(input.offset) ? input.offset : 0, 0)
    const profileId = typeof input.profileId === 'string' && input.profileId.trim() !== '' ? normalizeId(input.profileId) : null
    const where = profileId !== null ? 'WHERE g.profile_id = ?' : ''
    const params = profileId !== null ? [profileId] : []
    const total = (database.prepare(`SELECT COUNT(*) AS c FROM profile_customization_grants g ${where};`).get(...params) as { c: number }).c
    const rows = (database.prepare(`${GRANT_SELECT} ${where} ORDER BY g.created_at DESC, g.batch_id DESC, g.grant_id LIMIT ? OFFSET ?;`).all(...params, limit, offset) as GrantRowDb[]).map(rowToGrant)
    return { rows, total }
  }

  // ─── Общата страница "Плащания" (/admin/payments) ──────────────────────

  type PaymentOrderRow = OrderRow & {
    account_id: string | null
    username: string | null
    display_name: string | null
    email: string | null
    profile_kind: string | null
    payment_method_type: string | null
    wallet_type: string | null
    card_brand: string | null
    card_last4: string | null
    card_country: string | null
    stripe_charge_id: string | null
  }

  const PAYMENT_ORDER_SELECT = `
    SELECT ${ORDER_COLUMNS.split(',').map((column) => `pco.${column.trim()}`).join(', ')},
           p.account_id, p.username, p.display_name, a.email, p.profile_kind,
           pco.payment_method_type, pco.wallet_type, pco.card_brand, pco.card_last4, pco.card_country, pco.stripe_charge_id
    FROM profile_customization_orders pco
    LEFT JOIN profiles p ON p.profile_id = pco.profile_id
    LEFT JOIN accounts a ON a.account_id = p.account_id
  `

  /** Нетно получена сума: платена обща сума минус възстановеното (не под 0). */
  function netCents(row: OrderRow): number {
    return Math.max(row.total_cents - (row.refunded_amount_cents ?? 0), 0)
  }

  function paymentStatus(row: OrderRow): 'paid' | 'partially_refunded' | 'refunded' {
    if (row.status === 'refunded') return 'refunded'
    return (row.refunded_amount_cents ?? 0) > 0 ? 'partially_refunded' : 'paid'
  }

  function toPaymentListRow(row: PaymentOrderRow) {
    return {
      source: 'profile_customization' as const,
      purchaseId: row.order_id,
      profileId: row.profile_id ?? null,
      accountId: row.account_id ?? null,
      username: row.username ?? null,
      displayName: row.display_name ?? null,
      email: row.email ?? null,
      profileKind: row.profile_kind ?? null,
      packageKey: null,
      packageTitle: 'Персонализация',
      yellowCoinsAmount: null,
      vipDays: null,
      // Реално платената обща сума на поръчката (всички редове заедно).
      priceCents: row.total_cents,
      currency: row.currency.toUpperCase(),
      provider: row.provider,
      status: paymentStatus(row),
      providerCheckoutSessionId: row.provider_checkout_session_id ?? null,
      paymentMethodType: row.payment_method_type ?? null,
      walletType: row.wallet_type ?? null,
      cardBrand: row.card_brand ?? null,
      cardLast4: row.card_last4 ?? null,
      cardCountry: row.card_country ?? null,
      createdAt: row.created_at,
      creditedAt: row.paid_at,
      hiddenAt: null,
      recipientProfileId: null,
      recipientDisplayName: null,
      netCents: netCents(row),
    }
  }

  /**
   * ЕДНА Stripe поръчка = ЕДИН ред (обща сума, не по ред на екстра). Само
   * реално платени поръчки (paid_at — кредитирани от webhook-а), вкл. по-късно
   * възстановените (статус 'refunded'/'partially_refunded'; netCents е
   * сумата за оборота). Периодът е по датата на плащане (Sofia дни, същият
   * buildPeriodWhereClause като другите източници). Безплатните admin
   * предоставяния са в отделна таблица и НЕ участват.
   */
  function getAdminPaymentListByPeriod(params: { period: AdminPaymentPeriod; now?: Date }) {
    // paid_at е ISO ("…T…Z"), а границите са "YYYY-MM-DD HH:MM:SS" UTC —
    // сравнява се в същия формат.
    const column = "replace(substr(pco.paid_at, 1, 19), 'T', ' ')"
    const { sql, params: whereParams } = buildPeriodWhereClause(params.period, params.now ?? new Date(), column)
    const rows = database.prepare(`
      ${PAYMENT_ORDER_SELECT}
      WHERE pco.paid_at IS NOT NULL AND pco.status IN ('paid', 'refunded') AND ${sql}
      ORDER BY pco.paid_at DESC, pco.order_id DESC;
    `).all(...whereParams) as PaymentOrderRow[]
    return rows.map(toPaymentListRow)
  }

  function getAdminPaymentDetail(orderId: string) {
    const row = database.prepare(`${PAYMENT_ORDER_SELECT} WHERE pco.order_id = ? AND pco.paid_at IS NOT NULL;`).get(normalizeId(orderId)) as PaymentOrderRow | undefined
    if (!row) return null
    const lines = getOrderLines(row.order_id)
    return {
      ...toPaymentListRow(row),
      stripePaymentIntentId: row.stripe_payment_intent_id ?? null,
      stripeChargeId: row.stripe_charge_id ?? null,
      updatedAt: row.updated_at,
      currentYellowCoinsBalance: null,
      customization: {
        items: lines.map((line) => ({
          kind: line.kind,
          kindLabel: PROFILE_CUSTOMIZATION_KIND_LABELS[line.kind],
          itemType: getProfileCustomizationItemType(line.kind),
          itemValue: line.item_value_snapshot,
          itemLabel: line.item_label_snapshot,
          days: line.days_snapshot,
          priceCents: line.price_cents_snapshot,
          status: line.status,
          grantEffect: line.grant_effect,
          grantedUntil: line.granted_until_snapshot,
        })),
        totalCents: row.total_cents,
        paidAt: row.paid_at,
        refundedAt: row.refunded_at,
        refundedAmountCents: row.refunded_amount_cents,
        refundReviewStatus: row.refund_review_status ?? null,
        refundReviewReason: row.refund_review_reason ?? null,
      },
    }
  }

  function locateOrder(sessionId: string | null, paymentIntentId: string | null): OrderRow | undefined {
    return (sessionId !== null ? (selectOrderBySessionStatement.get(sessionId) as OrderRow | undefined) : undefined)
      ?? (paymentIntentId !== null ? (selectOrderByPaymentIntentStatement.get(paymentIntentId) as OrderRow | undefined) : undefined)
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

    const located = locateOrder(sessionId, paymentIntentId)
    if (!located) {
      return { ok: false, reason: 'purchase_not_found', message: 'Поръчката за това възстановяване не е намерена.' }
    }

    let outcome: Extract<ApplyProfileCustomizationRefundResult, { ok: true }>['outcome']
    try {
      database.exec('BEGIN IMMEDIATE;')
      const row = getOrderRow(located.order_id) as OrderRow
      // Stripe праща кумулативната сума — по-малка/равна стойност от вече
      // записаната е повторна или закъсняла доставка.
      const refundedAmount = Math.max(params.refundedAmountCents, row.refunded_amount_cents ?? 0)
      const isFull = refundedAmount >= row.total_cents
      const lines = getOrderLines(row.order_id)

      if (row.status === 'refunded') {
        outcome = 'already_refunded'
      } else if (row.status === 'paid' && isFull) {
        // Пълен refund: всички права от ТАЗИ поръчка се отменят (по реда на
        // веригата им), без да се засягат по-нови валидни покупки.
        markOrderRefundStatement.run('refunded', nowIso, refundedAmount, params.stripeEventId, nowIso, null, null, null, null, null, row.order_id)
        for (const line of lines) {
          if (line.status !== 'paid') continue
          markLineRefundedStatement.run(nowIso, nowIso, line.purchase_id)
          revokeLineGrant(line, nowIso)
        }
        outcome = 'revoked'
      } else if (row.status === 'paid') {
        // Частично възстановяване: Stripe не казва за коя екстра е — правата
        // остават, а поръчката задължително чака администраторски преглед
        // (само при НОВА, по-голяма сума — повторена доставка не връща вече
        // прегледана поръчка за преглед).
        const increased = refundedAmount > (row.refunded_amount_cents ?? 0)
        const reviewMark = increased ? 'pending' : null
        markOrderRefundStatement.run('paid', nowIso, refundedAmount, params.stripeEventId, nowIso, reviewMark, increased ? 'partial_refund' : null, reviewMark, reviewMark, reviewMark, row.order_id)
        // Поръчка с един ред: сумата се отнася еднозначно към него (за статистиката).
        if (lines.length === 1 && lines[0]!.status === 'paid') {
          markLinePartialRefundStatement.run(nowIso, refundedAmount, nowIso, lines[0]!.purchase_id)
        }
        outcome = 'partial_recorded'
      } else if (row.status === 'pending') {
        // Refund преди checkout.session.completed — кредитирането ще го
        // види и няма да активира нищо (при пълна сума).
        markOrderRefundStatement.run('pending', nowIso, refundedAmount, params.stripeEventId, nowIso, null, null, null, null, null, row.order_id)
        outcome = 'recorded_before_credit'
      } else {
        markOrderRefundStatement.run(row.status, nowIso, refundedAmount, params.stripeEventId, nowIso, null, null, null, null, null, row.order_id)
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

    const updated = getOrderRow(located.order_id) as OrderRow
    return { ok: true, outcome, order: orderSnapshot(updated), activeAfter: activeItemsFor(updated.profile_id, now) }
  }

  function needsPaymentMethodSnapshot(orderId: string): boolean {
    return needsPaymentMethodSnapshotStatement.get(orderId) !== undefined
  }

  function updatePaymentMethodSnapshot(orderId: string, snapshot: PaymentMethodSnapshot): void {
    updatePaymentMethodSnapshotStatement.run(
      snapshot.stripePaymentIntentId,
      snapshot.stripeChargeId,
      snapshot.paymentMethodType,
      snapshot.walletType,
      snapshot.cardBrand,
      snapshot.cardLast4,
      snapshot.cardCountry,
      new Date().toISOString(),
      orderId,
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

  function listAdminOrders(input: { limit: number; offset: number; status?: string | null }): { rows: ProfileCustomizationAdminOrderRow[]; total: number } {
    const limit = Math.min(Math.max(Number.isSafeInteger(input.limit) ? input.limit : 50, 1), 200)
    const offset = Math.max(Number.isSafeInteger(input.offset) ? input.offset : 0, 0)
    const status = typeof input.status === 'string' && (ADMIN_PURCHASE_STATUSES as readonly string[]).includes(input.status) ? input.status : null
    // По подразбиране без скритите (заменени) неплатени поръчки — те не са
    // поръчки на потребителя (платена скрита поръчка се показва).
    const where = input.status === 'review_pending'
      ? "WHERE pco.refund_review_status = 'pending'"
      : status !== null ? 'WHERE pco.status = ?' : "WHERE (pco.hidden_at IS NULL OR pco.status <> 'pending')"
    const whereParams = input.status !== 'review_pending' && status !== null ? [status] : []
    const total = (database.prepare(`SELECT COUNT(*) AS c FROM profile_customization_orders pco ${where};`).get(...whereParams) as { c: number }).c
    type AdminRow = OrderRow & {
      display_name: string | null
      username: string | null
      email: string | null
      payment_method_type: string | null
      card_brand: string | null
      card_last4: string | null
    }
    const rows = database.prepare(`
      SELECT ${ORDER_COLUMNS.split(',').map((column) => `pco.${column.trim()}`).join(', ')},
             p.display_name, p.username, a.email, pco.payment_method_type, pco.card_brand, pco.card_last4
      FROM profile_customization_orders pco
      LEFT JOIN profiles p ON p.profile_id = pco.profile_id
      LEFT JOIN accounts a ON a.account_id = p.account_id
      ${where}
      ORDER BY pco.created_at DESC, pco.order_id DESC
      LIMIT ? OFFSET ?;
    `).all(...whereParams, limit, offset) as AdminRow[]
    // Редовете на показаните поръчки — ЕДНА заявка за страницата (без N+1).
    const linesByOrder = new Map<string, PurchaseRow[]>()
    if (rows.length > 0) {
      const placeholders = rows.map(() => '?').join(',')
      const lineRows = database.prepare(`
        SELECT ${PURCHASE_COLUMNS} FROM profile_customization_purchases
        WHERE order_id IN (${placeholders})
        ORDER BY ${KIND_ORDER_SQL}, purchase_id;
      `).all(...rows.map((row) => row.order_id)) as PurchaseRow[]
      for (const line of lineRows) {
        if (line.order_id === null) continue
        const list = linesByOrder.get(line.order_id) ?? []
        list.push(line)
        linesByOrder.set(line.order_id, list)
      }
    }
    return {
      total,
      rows: rows.map((row) => ({
        ...rowToOrder(row, linesByOrder.get(row.order_id) ?? []),
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
    return (database.prepare("SELECT COUNT(*) AS c FROM profile_customization_orders WHERE refund_review_status = 'pending';").get() as { c: number }).c
  }

  /** id на поръчка или на неин ред -> id на поръчката. */
  function resolveOrderId(orderOrPurchaseId: string): string | null {
    const id = normalizeId(orderOrPurchaseId)
    if (id.length === 0) return null
    if (getOrderRow(id) !== null) return id
    return getPurchaseRow(id)?.order_id ?? null
  }

  function markRefundReviewed(orderOrPurchaseId: string, actor?: { profileId: string | null; displayName: string | null }): boolean {
    const orderId = resolveOrderId(orderOrPurchaseId)
    if (orderId === null) return false
    const nowIso = new Date().toISOString()
    const result = markRefundReviewedStatement.run(
      nowIso,
      nowIso,
      actor?.profileId ?? null,
      actor?.displayName?.trim().slice(0, 80) || null,
      orderId,
    ) as { changes?: number }
    return (result.changes ?? 0) > 0
  }

  function recordRefundFailure(params: { checkoutSessionId?: string | null; paymentIntentId?: string | null; stripeRefundId: string; stripeEventId: string; now?: Date }):
    | { ok: true; outcome: 'marked_for_review' | 'already_recorded'; order: ProfileCustomizationOrderSnapshot }
    | { ok: false; reason: 'purchase_not_found' | 'invalid_request'; message: string } {
    const sessionId = params.checkoutSessionId?.trim() || null
    const paymentIntentId = params.paymentIntentId?.trim() || null
    const refundId = params.stripeRefundId.trim()
    if ((sessionId === null && paymentIntentId === null) || refundId.length === 0) {
      return { ok: false, reason: 'invalid_request', message: 'Липсва идентификатор на плащането или на refund-а.' }
    }
    const row = locateOrder(sessionId, paymentIntentId)
    if (!row) return { ok: false, reason: 'purchase_not_found', message: 'Поръчката за този refund не е намерена.' }
    // Повторна доставка за същия refund — без промяна (и без да отваря отново вече прегледан случай).
    if (row.refund_failed_refund_id === refundId) {
      return { ok: true, outcome: 'already_recorded', order: orderSnapshot(row) }
    }
    const nowIso = (params.now ?? new Date()).toISOString()
    markRefundFailedStatement.run(refundId, nowIso, params.stripeEventId, nowIso, row.order_id)
    return { ok: true, outcome: 'marked_for_review', order: orderSnapshot(getOrderRow(row.order_id) as OrderRow) }
  }

  function getAdminKindStats(now: Date = new Date()): ProfileCustomizationAdminKindStats[] {
    // По редове (отделните права). Частичен refund на поръчка с няколко реда
    // не се отнася към конкретен вид (виж applyRefund) — остава на поръчката.
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
      SELECT e.kind AS kind, COUNT(*) AS c
      FROM profile_customization_equipped e
      JOIN profile_customization_owned_items o ON o.profile_id = e.profile_id AND o.kind = e.kind AND o.item_id = e.item_id
      WHERE o.active_until > ?
      GROUP BY e.kind;
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
    getProfileOwnedItems,
    equipItem,
    unequipItem,
    getAppearancesForProfiles,
    previewPurchase,
    previewOrder,
    createPendingOrder,
    getOrderById,
    getPurchaseById,
    attachOrderCheckoutSession,
    retirePendingOrder,
    findOrderByCheckoutSessionId,
    findProfileOrderByCheckoutSessionId,
    markOrderCanceledByCheckoutSessionId,
    markOrderFailedByCheckoutSessionId,
    fulfillPaidOrder,
    applyRefund,
    needsPaymentMethodSnapshot,
    updatePaymentMethodSnapshot,
    grantItems,
    listGrants,
    getGrantTarget,
    getAdminPaymentListByPeriod,
    getAdminPaymentDetail,
    getAccessState,
    setAccessMode,
    listModeChanges,
    listAdminOrders,
    countPendingRefundReviews,
    markRefundReviewed,
    recordRefundFailure,
    getAdminKindStats,
    close: () => database.close(),
  }
}
