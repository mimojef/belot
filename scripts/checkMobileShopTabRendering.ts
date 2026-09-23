/**
 * checkMobileShopTabRendering.ts
 *
 * Regression check за production mobile-only bug: Shop -> "Пакети" tab
 * визуално ставаше active на mobile (data-shop-tab="bundle" бутонът
 * получаваше active styling), НО съдържанието оставаше coin shop
 * ("Магазин Жълтици" header, balance subtitle, coin package cards).
 *
 * Root cause: renderMobileShopPanel() (renderLobbyScreen.ts) е ОТДЕЛЕН
 * renderer от desktop renderShopPanel() — имаше `if (shopActiveTab==='vip')`
 * branch, после directно fall-through към coin rendering. Липсваше
 * `if (shopActiveTab==='bundle')` branch изцяло — класически
 * "if vip -> VIP else -> coins" bug, който не разпознава третата валидна
 * стойност 'bundle'. Desktop renderShopPanel() винаги е имал explicit
 * bundle branch — само mobile беше засегнат.
 *
 * Проверява ДИРЕКТНО produced markup от реалната production render функция
 * (Node import, БЕЗ browser/jsdom — renderLobbyScreen.ts е чисто
 * функционален HTML-string builder, established pattern за render-функции
 * в проекта, mirror на checkChatDraftPreserved.ts doc коментара "jsdom не е
 * налична зависимост"). Минимален LobbyScreenState mock, попълва само
 * полетата, които renderMobileShopPanel() реално чете за shop branch-овете.
 *
 * Покрива:
 *  [1] shopActiveTab='coins' -> mobile markup показва "Магазин Жълтици"
 *        header, coin package card, coin buy button (data-lobby-shop-package)
 *  [2] shopActiveTab='vip' -> mobile markup показва "Магазин VIP" header,
 *        VIP package card, VIP buy button (data-vip-purchase-package)
 *  [3] shopActiveTab='bundle' -> mobile markup показва "Магазин Пакети"
 *        header, bundle package card, bundle buy button
 *        (data-bundle-purchase-package)
 *  [4] shopActiveTab='bundle' -> markup НЕ съдържа coin package title/
 *        cards (не fall-through към coin rendering)
 *  [5] shopActiveTab='bundle' -> markup НЕ съдържа VIP-specific markup
 *  [6] shopActiveTab='bundle' -> buy button data атрибутът носи
 *        bundlePackage.packageId (не coin/VIP package id) — доказва, че
 *        клик-ът ще подаде bundle packageId, не coin/VIP id
 *  [7] shopActiveTab='bundle' -> purchase history секцията чете от
 *        bundlePurchases (titleSnapshot/vipDays), не от shopPurchases
 *  [8] active tab бутонът (data-shop-tab="bundle") носи active styling
 *        МАРКЕР (border/background разлика) точно когато shopActiveTab='bundle'
 *        — доказва tab visual state и content branch са consistent, не
 *        независими (production bug-ът беше именно tab active=true, content=coins)
 */

import type { LobbyScreenState } from '../src/app/lobby/renderLobbyScreen'
import { renderMobileShopPanel } from '../src/app/lobby/renderLobbyScreen'

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

// Минимален mock — попълва точно полетата, които renderMobileShopPanel()
// реално чете (потвърдено чрез статичен review на функцията) плюс
// достатъчно от LobbyScreenState да satisfy-не типа structurally.
function buildBaseState(shopActiveTab: 'coins' | 'vip' | 'bundle'): LobbyScreenState {
  return {
    profile: { profileId: 'test-profile-id', yellowCoinsBalance: 12345 },
    shopActiveTab,
    shopPackages: [
      { packageId: 'coin-1', packageKey: 'starter', title: 'Starter', description: '', yellowCoinsAmount: 100000, priceCents: 499, currency: 'EUR', status: 'active', sortOrder: 10, showInLobby: true, isTopOffer: false },
    ],
    shopPackagesLoading: false,
    shopPackagesErrorText: null,
    shopPurchases: [],
    shopPurchasesVisible: false,
    shopPurchaseActionPackageId: null,
    shopPurchaseActionPurchaseId: null,
    shopPurchaseHideConfirmId: null,
    shopPurchaseMessageText: null,
    vipPackages: [
      { packageId: 'vip_30', title: 'VIP 30 дни', days: 30, priceCents: 789, currency: 'EUR' },
    ],
    vipPackagesLoading: false,
    vipPackagesErrorText: null,
    vipPurchaseActionPackageId: null,
    vipPurchaseMessageText: null,
    bundlePackages: [
      {
        packageId: 'bundle-abc123',
        packageKey: 'bundle-abc123',
        title: 'Супер пакет',
        description: 'Тестово описание',
        yellowCoinsAmount: 500000,
        vipDays: 30,
        priceCents: 999,
        currency: 'EUR',
        status: 'active',
        sortOrder: 10,
      },
    ],
    bundlePackagesLoading: false,
    bundlePackagesErrorText: null,
    bundlePurchases: [
      {
        purchaseId: 'bp-1',
        packageId: 'bundle-abc123',
        packageKeySnapshot: 'bundle-abc123',
        titleSnapshot: 'Супер пакет (архив)',
        yellowCoinsAmount: 500000,
        vipDays: 30,
        priceCents: 999,
        currency: 'EUR',
        provider: 'stripe',
        providerCheckoutSessionId: null,
        status: 'paid',
        creditedAt: '2026-01-01T00:00:00Z',
        hiddenAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
    bundlePurchasesVisible: true,
    bundlePurchaseActionPackageId: null,
    bundlePurchaseMessageText: null,
  } as unknown as LobbyScreenState
}

console.log('\ncheckMobileShopTabRendering\n')

check("[1] shopActiveTab='coins' -> mobile markup показва coin header/card/buy-button", () => {
  const html = renderMobileShopPanel(buildBaseState('coins'))
  assert(html.includes('Магазин Жълтици'), 'очаквах "Магазин Жълтици" header')
  assert(html.includes('Starter'), 'очаквах coin package title в markup-а')
  assert(html.includes('data-lobby-shop-package="coin-1"'), 'очаквах coin buy button с coin packageId')
})

check("[2] shopActiveTab='vip' -> mobile markup показва VIP header/card/buy-button", () => {
  const html = renderMobileShopPanel(buildBaseState('vip'))
  assert(html.includes('Магазин VIP'), 'очаквах "Магазин VIP" header')
  assert(html.includes('data-vip-purchase-package="vip_30"'), 'очаквах VIP buy button с VIP packageId')
})

check("[3] shopActiveTab='bundle' -> mobile markup показва bundle header/card/buy-button (FIX за production bug-а)", () => {
  const html = renderMobileShopPanel(buildBaseState('bundle'))
  assert(html.includes('Магазин Пакети'), 'очаквах "Магазин Пакети" header — ТОЧНО тук production bug-ът показваше "Магазин Жълтици"')
  assert(html.includes('Супер пакет'), 'очаквах bundle package title в markup-а')
  assert(html.includes('data-bundle-purchase-package="bundle-abc123"'), 'очаквах bundle buy button с bundle packageId')
})

check("[4] shopActiveTab='bundle' -> markup НЕ съдържа coin package data (не fall-through към coin rendering)", () => {
  const html = renderMobileShopPanel(buildBaseState('bundle'))
  assert(!html.includes('Starter'), 'bundle markup не трябва да съдържа coin package title')
  assert(!html.includes('data-lobby-shop-package='), 'bundle markup не трябва да съдържа coin buy button')
  assert(!html.includes('Баланс:'), 'bundle markup не трябва да показва coin balance subtitle (само coin tab-ът го показва)')
})

check("[5] shopActiveTab='bundle' -> markup НЕ съдържа VIP-specific buy button", () => {
  const html = renderMobileShopPanel(buildBaseState('bundle'))
  assert(!html.includes('data-vip-purchase-package='), 'bundle markup не трябва да съдържа VIP buy button')
})

check("[6] shopActiveTab='bundle' -> buy button data атрибутът носи bundlePackage.packageId (никога coin/VIP id)", () => {
  const html = renderMobileShopPanel(buildBaseState('bundle'))
  const match = html.match(/data-bundle-purchase-package="([^"]*)"/)
  assert(match !== null, 'очаквах data-bundle-purchase-package атрибут в markup-а')
  assert(match?.[1] === 'bundle-abc123', `очаквах bundle packageId "bundle-abc123", получих "${match?.[1]}"`)
})

check("[7] shopActiveTab='bundle' -> purchase history чете от bundlePurchases (titleSnapshot/vipDays), не от shopPurchases", () => {
  const html = renderMobileShopPanel(buildBaseState('bundle'))
  assert(html.includes('Супер пакет (архив)'), 'очаквах bundlePurchases.titleSnapshot в историята')
  assert(html.includes('30д VIP') || html.includes('30 дни VIP') || /30\s*д\s*VIP/.test(html), 'очаквах vipDays показан в bundle purchase history реда')
})

check('[8] active tab button маркерът (data-shop-tab="bundle") е coherent с рендирания content branch (tab active state === content branch)', () => {
  const htmlBundleActive = renderMobileShopPanel(buildBaseState('bundle'))
  // renderShopTabBar() маркира активния таб с различен border/background
  // inline style — точно тук production bug-ът демонстрираше
  // "tab visually active" (produced от renderShopTabBar, споделен между
  // desktop/mobile) БЕЗ съответен content branch. Тестът потвърждава, че
  // когато tab bar-ът маркира bundle като active, съдържанието СЪЩО e bundle.
  const bundleButtonMatch = htmlBundleActive.match(/<button type="button" data-shop-tab="bundle" style="([^"]*)">/)
  assert(bundleButtonMatch !== null, 'очаквах data-shop-tab="bundle" бутон в tab bar-а')
  const bundleButtonStyle = bundleButtonMatch?.[1] ?? ''
  assert(bundleButtonStyle.includes('rgba(212,165,32,0.85)') || bundleButtonStyle.includes('linear-gradient'), 'bundle табът трябва да носи active border/background стил, когато shopActiveTab=\'bundle\'')
  assert(htmlBundleActive.includes('Магазин Пакети'), 'и content-ът трябва да е bundle content — tab active state и content branch трябва да са consistent')
})

// ─── EUR-only price display (BGN двойно обозначаване премахнато 23.09.2026) ─
check("[9] mobile 'coins' markup показва EUR цена, НЕ съдържа 'лв.' secondary price", () => {
  const html = renderMobileShopPanel(buildBaseState('coins'))
  assert(html.includes('4,99'), 'очаквах EUR цена (4,99 €) в markup-а')
  assert(!html.includes('лв.'), 'mobile coin card НЕ трябва да съдържа BGN secondary price')
  assert(!html.includes('BGN'), 'mobile coin card НЕ трябва да съдържа BGN currency code')
})

check("[10] mobile 'vip' markup показва EUR цена, НЕ съдържа 'лв.' secondary price", () => {
  const html = renderMobileShopPanel(buildBaseState('vip'))
  assert(!html.includes('лв.'), 'mobile VIP card НЕ трябва да съдържа BGN secondary price (никога не е показвал)')
  assert(!html.includes('BGN'), 'mobile VIP card НЕ трябва да съдържа BGN currency code')
})

check("[11] mobile 'bundle' markup показва EUR цена, НЕ съдържа 'лв.' secondary price", () => {
  const html = renderMobileShopPanel(buildBaseState('bundle'))
  assert(html.includes('9,99'), 'очаквах EUR цена (9,99 €) в markup-а')
  assert(!html.includes('лв.'), 'mobile bundle card НЕ трябва да съдържа BGN secondary price')
  assert(!html.includes('BGN'), 'mobile bundle card НЕ трябва да съдържа BGN currency code')
})

console.log('\n' + '═'.repeat(72))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exitCode = 1
