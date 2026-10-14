import type Stripe from 'stripe'
import type { CoinPurchaseSnapshot } from '../db/coinPurchaseStore.js'

// Единствен източник на Stripe параметрите за coin checkout — ползва се и от
// /api/shop/checkout („Купи“), и от resume („Плати“). Двата пътя споделят
// idempotency key (виж obtainPendingPurchaseCheckoutSession.ts), а Stripe
// отказва същия key с различни параметри.
//
// Цена/жълтици/заглавие идват само от server-side snapshot-а на ledger реда.
// purchaseId е единственият authoritative pointer за webhook-а; останалата
// metadata е за debugging/Stripe dashboard.
export function buildCoinCheckoutSessionParams(
  purchase: CoinPurchaseSnapshot,
  profileId: string,
  successUrl: string,
  cancelUrl: string,
): Stripe.Checkout.SessionCreateParams {
  return {
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
      recipientProfileId: purchase.recipientProfileId ?? '',
      packageId: purchase.packageId ?? '',
      packageKey: purchase.packageKey,
      coins: String(purchase.yellowCoinsAmount),
    },
  }
}
