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

export type AdminPaymentListRow = {
  purchaseId: string
  profileId: string
  accountId: string | null
  username: string | null
  displayName: string | null
  email: string | null
  profileKind: string | null
  packageKey: string
  packageTitle: string
  yellowCoinsAmount: number
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
  purchaseId: string
  profileId: string
  accountId: string | null
  username: string | null
  displayName: string | null
  email: string | null
  profileKind: string | null
  packageKey: string
  packageTitle: string
  yellowCoinsAmount: number
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
