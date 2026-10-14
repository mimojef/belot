import type Stripe from 'stripe'
import type { PurchaseFulfillmentFailure } from '../db/purchaseFulfillmentFailure.js'
import { isTransientDatabaseError } from '../db/classifyFulfillmentError.js'
import type {
  PaymentReviewIssuePurchaseType,
  PaymentReviewIssueSnapshot,
  PaymentReviewIssueStore,
} from '../db/paymentReviewIssueStore.js'

type WebhookCheckoutSession = Pick<Stripe.Checkout.Session, 'id' | 'payment_status' | 'amount_total' | 'currency' | 'metadata' | 'payment_intent'>

export type RecordUncreditedPaidCheckoutParams = {
  store: PaymentReviewIssueStore
  purchaseType: PaymentReviewIssuePurchaseType
  stripeSession: WebhookCheckoutSession
  stripeEventId: string | null
  failure: PurchaseFulfillmentFailure
}

export const AUTO_RESOLVED_AFTER_CREDIT_NOTE = 'Автоматично: успешно кредитирано при повторна доставка от Stripe.'

export function isTransientFulfillmentFailure(failure: PurchaseFulfillmentFailure): boolean {
  return failure.reason === 'credit_failed' && failure.transient === true
}

/**
 * Изпълнява fulfillment-а и превръща НЕОЧАКВАНО хвърлена грешка (напр.
 * SQLITE_BUSY при четене преди транзакцията) в структуриран отказ със
 * същата класификация временна/детерминистична.
 */
export function runFulfillment<R>(fn: () => R): R | PurchaseFulfillmentFailure {
  try {
    return fn()
  } catch (error) {
    return {
      ok: false,
      reason: 'credit_failed',
      transient: isTransientDatabaseError(error),
      message: `Неочаквана грешка при кредитиране: ${error instanceof Error ? error.message : 'unknown'}`,
    }
  }
}

// Устойчив запис на потвърдено, но некредитирано плащане. null, ако няма
// потвърдено плащане (payment_status != 'paid' / reason 'not_paid').
// Хвърля, ако записът не успее.
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
    isTransient: isTransientFulfillmentFailure(failure),
    detail: failure.message,
    stripeAmountTotal: stripeSession.amount_total ?? null,
    stripeCurrency: stripeSession.currency ? stripeSession.currency.toUpperCase() : null,
    expectedAmount: failure.expectedAmountCents ?? null,
    expectedCurrency: failure.expectedCurrency ?? null,
  })
}

export type WebhookSettlement = {
  /** HTTP статус за Stripe: 500 → Stripe опитва отново. */
  httpStatus: 200 | 500
  issue: PaymentReviewIssueSnapshot | null
  error: string | null
}

/**
 * Отказан fulfillment при webhook:
 *   - без потвърдено плащане → 200, нищо за преглед;
 *   - временна техническа грешка → запис is_transient (best-effort) и 500,
 *     за да опита Stripe отново (fulfillment-ът е идемпотентен; ако балансът
 *     вече е committed, повторението вижда alreadyCredited);
 *   - окончателен проблем (сума/валута/поръчка/второ плащане/детерминистична
 *     грешка) → устойчив запис, затваряне на предишни временни записи за
 *     сесията и 200 — без безкрайни retry-та и без кредитиране;
 *   - неуспешен запис на окончателен проблем → 500 (Stripe опитва отново).
 */
export function settleUncreditedPaidCheckout(params: RecordUncreditedPaidCheckoutParams): WebhookSettlement {
  const { store, stripeSession, failure } = params
  const transient = isTransientFulfillmentFailure(failure)

  if (transient) {
    let issue: PaymentReviewIssueSnapshot | null = null
    let error: string | null = null
    try {
      issue = recordUncreditedPaidCheckout(params)
    } catch (recordError) {
      // Вероятно същата временна причина — Stripe retry-ят ще опита пак.
      error = recordError instanceof Error ? recordError.message : 'unknown'
    }
    if (stripeSession.payment_status !== 'paid' || failure.reason === 'not_paid') {
      return { httpStatus: 200, issue: null, error }
    }
    return { httpStatus: 500, issue, error }
  }

  try {
    const issue = recordUncreditedPaidCheckout(params)
    if (issue !== null) {
      store.resolveTransientIssuesForSession(
        stripeSession.id,
        `Автоматично: повторната доставка завърши с окончателна класификация „${issue.issueKind}“.`,
      )
    }
    return { httpStatus: 200, issue, error: null }
  } catch (recordError) {
    return { httpStatus: 500, issue: null, error: recordError instanceof Error ? recordError.message : 'unknown' }
  }
}

/**
 * Успешен fulfillment (нов кредит или alreadyCredited): затваря отворените
 * временни записи за сесията. 500, ако това не успее — повторението ще види
 * alreadyCredited и ще опита пак, без повторен кредит.
 */
export function settleCreditedPaidCheckout(params: {
  store: PaymentReviewIssueStore
  checkoutSessionId: string
}): WebhookSettlement {
  try {
    params.store.resolveTransientIssuesForSession(params.checkoutSessionId, AUTO_RESOLVED_AFTER_CREDIT_NOTE)
    return { httpStatus: 200, issue: null, error: null }
  } catch (error) {
    return { httpStatus: 500, issue: null, error: error instanceof Error ? error.message : 'unknown' }
  }
}
