import type Stripe from 'stripe'
import type { CoinPurchaseSnapshot, CoinPurchaseStore } from '../db/coinPurchaseStore.js'

export type HideCoinPurchaseParams = {
  store: CoinPurchaseStore
  stripe: Pick<Stripe, 'checkout'>
  purchaseId: string
  profileId: string
}

export type HideCoinPurchaseResult =
  | { ok: true; purchase: CoinPurchaseSnapshot }
  | { ok: false; status: number; message: string }

export async function hideCoinPurchase(
  params: HideCoinPurchaseParams,
): Promise<HideCoinPurchaseResult> {
  const { store, stripe, purchaseId, profileId } = params

  const purchase = store.getPurchaseWithOwnerCheck(purchaseId, profileId)

  if (purchase === null) {
    return { ok: false, status: 404, message: 'Покупката не беше намерена.' }
  }

  // paid → директен soft hide, без Stripe
  if (purchase.status === 'paid') {
    return softHide(store, purchaseId, profileId)
  }

  // pending без Stripe session → директен soft hide
  if (!purchase.providerCheckoutSessionId) {
    return softHide(store, purchaseId, profileId)
  }

  // pending + Stripe session → retrieve + евентуален expire
  const sessionId = purchase.providerCheckoutSessionId

  let stripeSession: Stripe.Checkout.Session

  try {
    stripeSession = await stripe.checkout.sessions.retrieve(sessionId)
  } catch {
    console.error('[hideCoinPurchase] Stripe retrieve failed', { purchaseId, profileId })
    return {
      ok: false,
      status: 503,
      message: 'Не може да се провери статусът на плащането. Моля, опитай отново след малко.',
    }
  }

  if (stripeSession.status === 'expired') {
    return softHide(store, purchaseId, profileId)
  }

  if (stripeSession.status === 'complete') {
    // Webhook предстои — скриваме, но не пречим на crediting
    return softHide(store, purchaseId, profileId)
  }

  if (stripeSession.status !== 'open') {
    return {
      ok: false,
      status: 409,
      message: `Покупката не може да бъде скрита в момента. Моля, свържи се с поддръжката.`,
    }
  }

  // status === 'open' → трябва да expire преди hide
  try {
    await stripe.checkout.sessions.expire(sessionId)
    return softHide(store, purchaseId, profileId)
  } catch {
    // expire неуспешно — race condition: сесията може вече да е complete/expired
    console.error('[hideCoinPurchase] Stripe expire failed, retrying retrieve', { purchaseId, profileId })
  }

  // Повторен retrieve след неуспешен expire
  let retrySession: Stripe.Checkout.Session

  try {
    retrySession = await stripe.checkout.sessions.retrieve(sessionId)
  } catch {
    console.error('[hideCoinPurchase] Stripe retry retrieve failed', { purchaseId, profileId })
    return {
      ok: false,
      status: 503,
      message: 'Плащането не можа да бъде затворено. Моля, опитай отново.',
    }
  }

  if (retrySession.status === 'expired' || retrySession.status === 'complete') {
    return softHide(store, purchaseId, profileId)
  }

  // Все още open или непознат статус → не скриваме
  return {
    ok: false,
    status: 409,
    message: 'Плащането не можа да бъде затворено. Моля, опитай отново.',
  }
}

function softHide(
  store: CoinPurchaseStore,
  purchaseId: string,
  profileId: string,
): HideCoinPurchaseResult {
  const result = store.hidePurchaseForUser(purchaseId, profileId)
  if (!result.ok) {
    return { ok: false, status: 500, message: result.message }
  }
  return { ok: true, purchase: result.purchase }
}
