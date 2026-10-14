import type Stripe from 'stripe'
import type { PurchaseFulfillmentFailure } from '../db/purchaseFulfillmentFailure.js'
import type {
  PaymentReviewIssuePurchaseType,
  PaymentReviewIssueSnapshot,
  PaymentReviewIssueStore,
} from '../db/paymentReviewIssueStore.js'

export type RecordUncreditedPaidCheckoutParams = {
  store: PaymentReviewIssueStore
  purchaseType: PaymentReviewIssuePurchaseType
  stripeSession: Pick<Stripe.Checkout.Session, 'id' | 'payment_status' | 'amount_total' | 'currency' | 'metadata' | 'payment_intent'>
  stripeEventId: string | null
  failure: PurchaseFulfillmentFailure
}

// Webhook helper: fulfillment отказа ПОТВЪРДЕНО плащане → устойчив запис за
// административен преглед. Без потвърдено плащане (payment_status != 'paid'
// или reason 'not_paid') няма какво да се преглежда → null.
//
// Хвърля, ако записът не успее — webhook-ът тогава връща 500, за да може
// Stripe да опита отново (fulfillment-ът е идемпотентен, а отказът остава
// отказ, така че повторението само ще опита пак да запише проблема).
export function recordUncreditedPaidCheckout(
  params: RecordUncreditedPaidCheckoutParams,
): PaymentReviewIssueSnapshot | null {
  const { store, purchaseType, stripeSession, stripeEventId, failure } = params

  if (stripeSession.payment_status !== 'paid' || failure.reason === 'not_paid') {
    return null
  }

  const paymentIntent = stripeSession.payment_intent
  const metadataPurchaseId = stripeSession.metadata?.purchaseId?.trim() || null

  return store.recordIssue({
    checkoutSessionId: stripeSession.id,
    stripeEventId,
    stripePaymentIntentId: typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id ?? null,
    purchaseType,
    purchaseId: failure.purchaseId ?? null,
    metadataPurchaseId,
    payerProfileId: failure.payerProfileId ?? stripeSession.metadata?.profileId?.trim() ?? null,
    issueKind: failure.reason ?? 'credit_failed',
    detail: failure.message,
    stripeAmountTotal: stripeSession.amount_total ?? null,
    stripeCurrency: stripeSession.currency ? stripeSession.currency.toUpperCase() : null,
    expectedAmount: failure.expectedAmountCents ?? null,
    expectedCurrency: failure.expectedCurrency ?? null,
  })
}
