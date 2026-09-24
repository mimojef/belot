export const ADMIN_PAYMENT_PERIOD_VALUES = [
  'today',
  'yesterday',
  'last7days',
  'thisMonth',
  'allTime',
] as const

export type AdminPaymentPeriod = (typeof ADMIN_PAYMENT_PERIOD_VALUES)[number]

export function isAdminPaymentPeriod(v: unknown): v is AdminPaymentPeriod {
  return ADMIN_PAYMENT_PERIOD_VALUES.includes(v as AdminPaymentPeriod)
}

// source различава coin ('/api/shop/checkout'), VIP ('/api/vip/checkout') и
// bundle ('/api/shop/bundles/checkout') покупки в combined admin payment
// listing-а. VIP редовете НЯМАТ yellowCoinsAmount/packageKey (различна
// domain схема) — тия полета са nullable, НИКОГА "измислени" за VIP. Bundle
// редовете имат И yellowCoinsAmount, И vipDays едновременно — единична
// покупка credit-ва и двете.
export type AdminPaymentSource = 'coin' | 'vip' | 'bundle'

export type AdminPaymentListRow = {
  source: AdminPaymentSource
  purchaseId: string
  // NULL за исторически redове, чийто payer профил е hard-deleted
  // (ON DELETE SET NULL) — виж coinPurchaseStore/vipPurchaseStore/bundlePurchaseStore.
  profileId: string | null
  accountId: string | null
  username: string | null
  displayName: string | null
  email: string | null
  profileKind: string | null
  packageKey: string | null
  packageTitle: string
  yellowCoinsAmount: number | null
  // VIP дни, включени в покупката — non-null само за 'vip'/'bundle' source.
  vipDays: number | null
  priceCents: number
  currency: string
  provider: string
  status: string
  providerCheckoutSessionId: string | null
  paymentMethodType: string | null
  walletType: string | null
  cardBrand: string | null
  cardLast4: string | null
  cardCountry: string | null
  createdAt: string
  creditedAt: string | null
  hiddenAt: string | null
  // "Подари авоари" (Paid Gift Shop) — non-null означава ТАЗИ покупка е
  // gift. recipientDisplayName (immutable snapshot, НЕ FK) е canonical "е
  // ли gift" discriminator за UI — оцелява дори recipient hard-delete,
  // докато recipientProfileId може да стане NULL (ON DELETE SET NULL).
  // Normal (non-gift) покупки: и двете NULL.
  recipientProfileId: string | null
  recipientDisplayName: string | null
}

export type AdminPaymentListResult = {
  ok: true
  period: string
  purchases: AdminPaymentListRow[]
  pagination: {
    limit: number
    offset: number
    total: number
    hasMore: boolean
  }
  summary: {
    totalsByCurrency: Record<string, number>
  }
}

export type AdminPaymentDetailRow = {
  source: AdminPaymentSource
  purchaseId: string
  // NULL за исторически redове, чийто payer профил е hard-deleted
  // (ON DELETE SET NULL) — виж coinPurchaseStore/vipPurchaseStore/bundlePurchaseStore.
  profileId: string | null
  accountId: string | null
  username: string | null
  displayName: string | null
  email: string | null
  profileKind: string | null
  packageKey: string | null
  packageTitle: string
  yellowCoinsAmount: number | null
  vipDays: number | null
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
  recipientProfileId: string | null
  recipientDisplayName: string | null
}
