import type Stripe from 'stripe'
import type { CoinPurchaseSnapshot, CoinPurchaseStore } from '../db/coinPurchaseStore.js'

export type ResumeCoinPurchaseCheckoutParams = {
  store: CoinPurchaseStore
  stripe: Pick<Stripe, 'checkout'>
  purchaseId: string
  profileId: string
  successUrl: string
  cancelUrl: string
}

export type ResumeCoinPurchaseCheckoutResult =
  | { ok: true; checkoutUrl: string; purchase: CoinPurchaseSnapshot }
  | { ok: false; status: number; message: string }

export async function resumeCoinPurchaseCheckout(
  params: ResumeCoinPurchaseCheckoutParams,
): Promise<ResumeCoinPurchaseCheckoutResult> {
  const { store, stripe, purchaseId, profileId, successUrl, cancelUrl } = params

  const purchase = store.getPurchaseWithOwnerCheck(purchaseId, profileId)

  if (purchase === null) {
    return { ok: false, status: 404, message: 'Покупката не беше намерена.' }
  }

  if (purchase.hiddenAt !== null) {
    return { ok: false, status: 404, message: 'Покупката не беше намерена.' }
  }

  if (purchase.status === 'paid') {
    return {
      ok: false,
      status: 409,
      message: 'Тази покупка вече е платена. Жълтиците са добавени към баланса ти.',
    }
  }

  if (purchase.status !== 'pending') {
    return {
      ok: false,
      status: 409,
      message: 'Тази покупка не може да бъде продължена.',
    }
  }

  // Ако вече има Stripe сесия — трябва задължително да я retrieve-нем
  if (purchase.providerCheckoutSessionId) {
    let stripeSession: Stripe.Checkout.Session

    try {
      stripeSession = await stripe.checkout.sessions.retrieve(purchase.providerCheckoutSessionId)
    } catch {
      // При всяка retrieve грешка (network, auth, rate limit, timeout) —
      // НЕ създаваме нова сесия. Старата остава непокътната в ledger-а.
      return {
        ok: false,
        status: 503,
        message: 'Не може да се провери статусът на плащането в момента. Моля, опитай отново след малко.',
      }
    }

    if (stripeSession.status === 'open') {
      if (!stripeSession.url) {
        return {
          ok: false,
          status: 500,
          message: 'Stripe сесията е отворена, но не върна валиден линк.',
        }
      }
      return { ok: true, checkoutUrl: stripeSession.url, purchase }
    }

    if (stripeSession.status === 'complete') {
      // Webhook още не е пристигнал — не правим нова сесия, race condition
      return {
        ok: false,
        status: 409,
        message: 'Плащането е завършено и се обработва. Жълтиците ще бъдат добавени скоро.',
      }
    }

    if (stripeSession.status !== 'expired') {
      // Неочакван статус — не правим нова сесия
      return {
        ok: false,
        status: 409,
        message: `Неочакван статус на Stripe сесията: ${stripeSession.status}. Моля, свържи се с поддръжката.`,
      }
    }

    // status === 'expired' — продължаваме към нова сесия по-долу
  }

  // Нова Stripe сесия върху СЪЩЕСТВУВАЩИЯ purchase record.
  // Данните за цена, пакет и жълтици идват само от server-side snapshot-а —
  // клиентът не подава нито едно от тях.
  //
  // Idempotency key е обвързан с purchaseId + старата session ID (ако има такава).
  // При две едновременни заявки след expired — Stripe ще върне същата нова сесия.
  const oldSessionId = purchase.providerCheckoutSessionId ?? 'none'
  const idempotencyKey = `resume-${purchase.purchaseId}-${oldSessionId}`

  let newStripeSession: Stripe.Checkout.Session

  try {
    newStripeSession = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [
          {
            price_data: {
              currency: purchase.currency.toLowerCase(),
              unit_amount: purchase.priceCents,
              product_data: {
                name: purchase.title,
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          purchaseId: purchase.purchaseId,
          profileId,
          packageId: purchase.packageId ?? '',
          packageKey: purchase.packageKey,
          coins: String(purchase.yellowCoinsAmount),
        },
      },
      { idempotencyKey },
    )
  } catch {
    // Логваме само безопасни идентификатори — без error.message, stack trace,
    // API ключове, payload или payment данни, за да не попаднат в PM2 logs.
    console.error('[resumeCoinPurchaseCheckout] Stripe session creation failed', {
      purchaseId: purchase.purchaseId,
      profileId,
    })
    return {
      ok: false,
      status: 500,
      message: 'Плащането не можа да бъде стартирано. Моля, опитай отново.',
    }
  }

  if (!newStripeSession.url) {
    return {
      ok: false,
      status: 500,
      message: 'Stripe не върна валиден линк за плащане. Моля, опитай отново.',
    }
  }

  const attached = store.attachCheckoutSession(purchase.purchaseId, newStripeSession.id)

  if (attached === null) {
    return {
      ok: false,
      status: 500,
      message: 'Checkout сесията не беше записана към покупката.',
    }
  }

  return { ok: true, checkoutUrl: newStripeSession.url, purchase: attached }
}
