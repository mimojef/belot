import type Stripe from 'stripe'

// Една платима Stripe сесия на pending ред в даден момент.
//
// Преди: всеки „Купи“ върху reuse-нат pending ред създаваше НОВА сесия и
// attachCheckoutSession презаписваше provider_checkout_session_id. Старата
// сесия оставаше платима до изтичането си (до 24 ч), но webhook-ът за VIP/
// bundle търси реда СТРОГО по session id → плащане по нея не намираше
// поръчката (платено, некредитирано). Сега:
//   - има закачена отворена сесия → връщаме НЕЯ (без нова);
//   - complete → code 'session_complete': тази сесия вече е платена (или
//     чака асинхронно потвърждение) — НЕ се закача нова към същия ред.
//     „Купи“ route-ът скрива реда (webhook-ът за сесията му пак го намира
//     по session id) и създава нов pending ред; resume връща 409;
//   - expired → нова сесия; изтекла сесия вече не може да бъде платена, така
//     че презаписът на session id-то е безопасен;
//   - idempotency key = purchaseId + предишната сесия → конкурентни заявки
//     (два таба, „Купи“ + „Плати“) получават ЕДНА И СЪЩА нова сесия от Stripe.
//     Затова всички пътища за един и същ тип покупка трябва да подават
//     идентични createParams (Stripe отказва същия key с различни параметри).

export type ObtainPendingPurchaseCheckoutSessionParams = {
  stripe: Pick<Stripe, 'checkout'>
  purchaseId: string
  existingCheckoutSessionId: string | null
  createParams: Stripe.Checkout.SessionCreateParams
  /** За логове — без payload/payment данни. */
  logLabel: string
}

export type ObtainPendingPurchaseCheckoutSessionResult =
  | { ok: true; session: Stripe.Checkout.Session; reused: boolean }
  | { ok: false; status: number; message: string; code?: 'session_complete' }

export function getPendingPurchaseCheckoutIdempotencyKey(
  purchaseId: string,
  previousCheckoutSessionId: string | null,
): string {
  return `checkout-${purchaseId}-${previousCheckoutSessionId ?? 'none'}`
}

export async function obtainPendingPurchaseCheckoutSession(
  params: ObtainPendingPurchaseCheckoutSessionParams,
): Promise<ObtainPendingPurchaseCheckoutSessionResult> {
  const { stripe, purchaseId, existingCheckoutSessionId, createParams, logLabel } = params

  if (existingCheckoutSessionId) {
    let existing: Stripe.Checkout.Session

    try {
      existing = await stripe.checkout.sessions.retrieve(existingCheckoutSessionId)
    } catch {
      // Без проверка не създаваме нова сесия — иначе старата може да остане
      // платима и неоткриваема.
      console.error(`[${logLabel}] Stripe session retrieve failed`, { purchaseId })
      return {
        ok: false,
        status: 503,
        message: 'Не може да се провери статусът на плащането в момента. Моля, опитай отново след малко.',
      }
    }

    if (existing.status === 'open') {
      if (!existing.url) {
        return { ok: false, status: 500, message: 'Stripe сесията е отворена, но не върна валиден линк.' }
      }
      return { ok: true, session: existing, reused: true }
    }

    if (existing.status === 'complete') {
      return {
        ok: false,
        status: 409,
        code: 'session_complete',
        message: 'Плащането е завършено и се обработва. Покупката ще бъде добавена скоро.',
      }
    }

    if (existing.status !== 'expired') {
      return {
        ok: false,
        status: 409,
        message: `Неочакван статус на Stripe сесията: ${existing.status}. Моля, свържи се с поддръжката.`,
      }
    }
  }

  let created: Stripe.Checkout.Session

  try {
    created = await stripe.checkout.sessions.create(createParams, {
      idempotencyKey: getPendingPurchaseCheckoutIdempotencyKey(purchaseId, existingCheckoutSessionId),
    })
  } catch {
    // Само безопасни идентификатори в логовете (без error.message/payload).
    console.error(`[${logLabel}] Stripe session creation failed`, { purchaseId })
    return { ok: false, status: 500, message: 'Плащането не можа да бъде стартирано. Моля, опитай отново.' }
  }

  if (!created.url) {
    return { ok: false, status: 500, message: 'Stripe не върна валиден линк за плащане. Моля, опитай отново.' }
  }

  return { ok: true, session: created, reused: false }
}

export type ObtainBuyCheckoutSessionParams<P extends { purchaseId: string; providerCheckoutSessionId: string | null }> = {
  stripe: Pick<Stripe, 'checkout'>
  purchase: P
  buildCreateParams: (purchase: P) => Stripe.Checkout.SessionCreateParams
  retirePendingPurchase: (purchaseId: string) => boolean
  createReplacementPurchase: () => { ok: true; purchase: P } | { ok: false; message: string }
  logLabel: string
}

export type ObtainBuyCheckoutSessionResult<P> =
  | { ok: true; purchase: P; session: Stripe.Checkout.Session; reused: boolean }
  | { ok: false; status: number; message: string }

// „Купи“ (не resume): ако сесията на reuse-натия pending ред вече е complete,
// редът се скрива и се създава НОВ pending ред с нова сесия. Старата сесия
// остава закачена към стария ред → webhook-ът я намира и кредитира веднъж;
// без това клиент с отказано/забавено плащане не би могъл да купи пакета
// отново (вечно „обработва се“).
export async function obtainBuyCheckoutSession<P extends { purchaseId: string; providerCheckoutSessionId: string | null }>(
  params: ObtainBuyCheckoutSessionParams<P>,
): Promise<ObtainBuyCheckoutSessionResult<P>> {
  const { stripe, buildCreateParams, retirePendingPurchase, createReplacementPurchase, logLabel } = params
  let purchase = params.purchase

  let obtained = await obtainPendingPurchaseCheckoutSession({
    stripe,
    purchaseId: purchase.purchaseId,
    existingCheckoutSessionId: purchase.providerCheckoutSessionId,
    createParams: buildCreateParams(purchase),
    logLabel,
  })

  if (!obtained.ok && obtained.code === 'session_complete') {
    const retired = retirePendingPurchase(purchase.purchaseId)
    const replacement = createReplacementPurchase()

    if (!replacement.ok) {
      return { ok: false, status: 400, message: replacement.message }
    }

    if (!retired || replacement.purchase.purchaseId === purchase.purchaseId) {
      return { ok: false, status: obtained.status, message: obtained.message }
    }

    purchase = replacement.purchase
    obtained = await obtainPendingPurchaseCheckoutSession({
      stripe,
      purchaseId: purchase.purchaseId,
      existingCheckoutSessionId: purchase.providerCheckoutSessionId,
      createParams: buildCreateParams(purchase),
      logLabel,
    })
  }

  if (!obtained.ok) {
    return { ok: false, status: obtained.status, message: obtained.message }
  }

  return { ok: true, purchase, session: obtained.session, reused: obtained.reused }
}
