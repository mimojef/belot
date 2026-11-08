import type Stripe from 'stripe'
import type { CoinPurchaseSnapshot } from '../db/coinPurchaseStore.js'
import type { VipPurchaseSnapshot } from '../db/vipPurchaseStore.js'
import type { BundlePurchaseSnapshot } from '../db/bundlePurchaseStore.js'
import type { ProfileCustomizationOrderSnapshot } from '../profileCustomization/profileCustomizationStore.js'
import { PROFILE_CUSTOMIZATION_KIND_LABELS, getProfileCustomizationItemType } from '../profileCustomization/profileCustomizationCatalog.js'
import {
  buildBundleCheckoutProductName,
  buildCoinCheckoutProductName,
  buildProfileCustomizationCheckoutProductName,
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

// Персонализация на профила. ВАЖНО за Етап 2: webhook-ът трябва да има
// собствен клон за purchaseType='profile_customization' ПРЕДИ coin
// fallback-а (handleStripeWebhookRequest третира непознат тип като coin).
/**
 * Една обща поръчка (1..4 екстри) = ЕДНА Stripe Checkout сесия. Всяка екстра
 * е отделен ред в Checkout (вид, артикул, срок, цена), а Stripe показва и
 * общата сума. Сумите са от snapshot-а на редовете; webhook-ът сравнява
 * amount_total с общата сума на поръчката.
 */
export function buildProfileCustomizationCheckoutSessionParams(
  order: ProfileCustomizationOrderSnapshot,
  profileId: string,
  urls: SessionUrls,
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: 'payment',
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
    // „Pika.bg — <вид>: <цвят/емоджи> — <дни>“ за всеки ред
    line_items: order.lines.map((line) => lineItem(line.currency, line.priceCents, buildProfileCustomizationCheckoutProductName({
      kindLabel: PROFILE_CUSTOMIZATION_KIND_LABELS[line.kind],
      itemType: getProfileCustomizationItemType(line.kind),
      itemValue: line.itemValue,
      itemLabel: line.itemLabel,
      days: line.days,
    }))),
    metadata: {
      purchaseType: 'profile_customization',
      orderId: order.orderId,
      // Общият pointer, който ползват логовете/payment_review_issues.
      purchaseId: order.orderId,
      profileId,
      itemCount: String(order.lines.length),
      kinds: order.lines.map((line) => line.kind).join(','),
      totalCents: String(order.totalCents),
    },
  }
}

const STRIPE_CHECKOUT_SESSION_ID_TEMPLATE = '{CHECKOUT_SESSION_ID}'

function originOf(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * Return URL-и на персонализацията. Собствени (/lobby?customization=…),
 * за да не стартират lookup-ите на магазина. Stripe замества литерала
 * {CHECKOUT_SESSION_ID} с id-то на сесията — клиентът го чете от
 * session_id и проверява ТОЧНО тази поръчка на сървъра. Произходът:
 * CLIENT_ORIGIN, иначе произходът на вече конфигурирания
 * STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL (production може да задава само тях),
 * иначе локалният dev адрес.
 */
export function buildProfileCustomizationReturnUrls(env: Record<string, string | undefined>): { successUrl: string; cancelUrl: string; origin: string } {
  const origin = originOf(env.CLIENT_ORIGIN)
    ?? originOf(env.STRIPE_SUCCESS_URL)
    ?? originOf(env.STRIPE_CANCEL_URL)
    ?? 'http://localhost:5173'
  return {
    origin,
    successUrl: `${origin}/lobby?customization=success&session_id=${STRIPE_CHECKOUT_SESSION_ID_TEMPLATE}`,
    cancelUrl: `${origin}/lobby?customization=cancel`,
  }
}
