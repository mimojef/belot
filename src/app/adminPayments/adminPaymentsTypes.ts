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

// source различава coin ('/api/shop/checkout') от VIP ('/api/vip/checkout')
// покупки в combined admin payment listing-а. VIP редовете НЯМАТ
// yellowCoinsAmount/packageKey (различна domain схема) — тия полета са
// nullable, НИКОГА "измислени" за VIP.
export type AdminPaymentSource = 'coin' | 'vip'

export type AdminPaymentListRow = {
  source: AdminPaymentSource
  purchaseId: string
  profileId: string
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
  paymentMethodType: string | null
  walletType: string | null
  cardBrand: string | null
  cardLast4: string | null
  cardCountry: string | null
  createdAt: string
  creditedAt: string | null
  hiddenAt: string | null
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
  profileId: string
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
