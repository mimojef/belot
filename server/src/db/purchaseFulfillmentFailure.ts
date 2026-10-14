// Структуриран отказ на fulfillPaidPurchase (coin/VIP/bundle) — webhook-ът
// записва всеки отказ при ПОТВЪРДЕНО плащане в payment_review_issues
// (виж paymentReviewIssueStore.ts). reason липсва само при неочаквани пътища;
// тогава webhook-ът го третира като 'credit_failed'.
export type PurchaseFulfillmentFailureReason =
  /** Stripe payment_status != 'paid' — няма потвърдено плащане, не е проблем за преглед. */
  | 'not_paid'
  | 'purchase_not_found'
  | 'purchase_id_mismatch'
  | 'currency_mismatch'
  | 'amount_mismatch'
  /** Второ реално плащане (друга checkout сесия) за вече кредитирана поръчка. */
  | 'duplicate_payment'
  /** Поръчката е canceled/failed или получателят/купувачът вече не съществува. */
  | 'not_creditable'
  | 'credit_failed'

export type PurchaseFulfillmentFailure = {
  ok: false
  message: string
  reason?: PurchaseFulfillmentFailureReason
  /** Намереният ledger ред (null/липсва, ако не е намерен). */
  purchaseId?: string | null
  payerProfileId?: string | null
  expectedAmountCents?: number | null
  expectedCurrency?: string | null
}
