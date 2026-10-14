import type Stripe from 'stripe'
import type { CoinPurchaseSnapshot } from '../db/coinPurchaseStore.js'
import type { VipPurchaseSnapshot } from '../db/vipPurchaseStore.js'
import type { BundlePurchaseSnapshot } from '../db/bundlePurchaseStore.js'
import {
  buildBundleCheckoutProductName,
  buildCoinCheckoutProductName,
  buildVipCheckoutProductName,
} from './checkoutProductNames.js'

// Единствен източник на Stripe Checkout параметрите за coin/VIP/bundle.
//
// - Сума, валута, количество и име идват САМО от server-side snapshot-а на
//   ledger реда (поръчката), никога от текущите настройки на магазина.
// - Продуктите са динамични (price_data), без глобални Stripe продукти.
// - За една поръчка всички пътища („Купи“, resume) подават идентични
//   параметри — те споделят idempotency key (виж
//   obtainPendingPurchaseCheckoutSession.ts), а Stripe отказва същия key с
//   различни параметри.
// - purchaseId в metadata е единственият pointer за webhook-а; останалата
//   metadata е за debugging/Stripe dashboard.

type SessionUrls = { successUrl: string; cancelUrl: string }

function lineItem(currency: string, priceCents: number, productName: string): NonNullable<Stripe.Checkout.SessionCreateParams['line_items']>[number] {
  return {
    price_data: {
      currency: currency.toLowerCase(),
      unit_amount: priceCents,
      product_data: {
        name: productName,
      },
    },
    quantity: 1,
  }
}

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
    // „<пакет> — <жълтици>“
    line_items: [lineItem(purchase.currency, purchase.priceCents, buildCoinCheckoutProductName(purchase))],
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

export function buildVipCheckoutSessionParams(
  purchase: VipPurchaseSnapshot,
  profileId: string,
  urls: SessionUrls,
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: 'payment',
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    // „VIP — <дни>“
    line_items: [lineItem(purchase.currency, purchase.priceCents, buildVipCheckoutProductName(purchase))],
    metadata: {
      purchaseType: 'vip',
      purchaseId: purchase.purchaseId,
      profileId,
      recipientProfileId: purchase.recipientProfileId ?? '',
      packageId: purchase.packageId,
    },
  }
}

export function buildBundleCheckoutSessionParams(
  purchase: BundlePurchaseSnapshot,
  profileId: string,
  urls: SessionUrls,
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: 'payment',
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    // „<пакет> — <жълтици> + <дни> VIP“
    line_items: [lineItem(purchase.currency, purchase.priceCents, buildBundleCheckoutProductName(purchase))],
    metadata: {
      // purchaseType='bundle' — disambiguator за webhook routing-а.
      purchaseType: 'bundle',
      purchaseId: purchase.purchaseId,
      profileId,
      recipientProfileId: purchase.recipientProfileId ?? '',
      packageId: purchase.packageId ?? '',
    },
  }
}
