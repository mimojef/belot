/**
 * checkPaidGiftShopFrontendRendering.ts
 *
 * Review finding §4 (MISSING VERIFICATION) — frontend render-level
 * coverage за "Подари авоари", допълваща server-side store/HTTP тестовете
 * (checkPaidGiftShopStores.ts, checkGiftRecipientHardDeleteFallback.ts,
 * checkPrivilegedGiftCoinsPolicyMatrix.ts). Node import на реалните
 * production render функции (без browser/jsdom), established pattern
 * (mirror на checkMobileShopTabRendering.ts).
 *
 * [1]  Desktop coin history row показва "Подарък за <recipient>" badge
 *        когато recipientDisplayNameSnapshot е зададен
 * [2]  Desktop bundle history row показва "Подарък за <recipient>" badge
 * [3]  Mobile coin history row показва "Подарък за <recipient>" badge
 * [4]  Mobile bundle history row показва "Подарък за <recipient>" badge
 * [5]  Normal (non-gift) purchase history ред НЕ показва gift badge
 *        (recipientDisplayNameSnapshot null) — normal history остава
 *        непроменена визуално
 * [6]  Checkout confirm modal (gift mode) показва "Потвърждение на подарък
 *        за <recipient>" заглавие + "за <recipient>" до сумата
 * [7]  Checkout confirm modal (normal mode, shopGiftRecipientProfileId
 *        отсъства от state обекта — partial/legacy state shape) показва
 *        established "Потвърждение на покупка" — regression guard за
 *        undefined-vs-null bug-а, хванат и поправен по-рано в review-a
 * [8]  Desktop Shop header (gift mode) показва "Подари на <recipient>" +
 *        subtitle, за трите таба (coins/vip/bundle)
 * [9]  Mobile Shop header (gift mode) показва "Подари на <recipient>" за
 *        трите таба
 * [10] EUR-only: gift mode header/confirm modal markup НИКЪДЕ не съдържа
 *        "лв." (BGN secondary price)
 * [11] Desktop и mobile header за СЪЩИЯ gift state дават КОХЕРЕНТЕН
 *        recipient текст (няма desktop/mobile divergence, mirror на
 *        established "active tab=bundle, content=coins" bug класа)
 * [12] Item Gift System render markup (data-player-profile-gift-item) е
 *        структурно НЕПРОМЕНЕН — все още рендира отделно от
 *        data-player-profile-gift-shop, различни data атрибути, различен
 *        recipient wiring
 */

import type { LobbyScreenState } from '../src/app/lobby/renderLobbyScreen'
import {
  renderShopPanel,
  renderMobileShopPanel,
  renderShopPurchaseConfirmModal,
} from '../src/app/lobby/renderLobbyScreen'
import { renderPlayerProfilePopup } from '../src/ui/overlays/renderPlayerProfilePopup'

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

// Минимален mock, mirror на checkMobileShopTabRendering.ts buildBaseState
// pattern-а — попълва точно полетата, които render функциите реално четат
// за shop/history/confirm-modal branch-овете, plus достатъчно от
// LobbyScreenState да satisfy-не типа structurally.
function buildBaseState(overrides: Partial<{
  shopActiveTab: 'coins' | 'vip' | 'bundle'
  shopGiftRecipientProfileId: string | null
  shopGiftRecipientDisplayName: string | null
  shopGiftRecipientErrorText: string | null
  shopPurchaseConfirmPackageId: string | null
  coinRecipientSnapshot: string | null
  bundleRecipientSnapshot: string | null
  omitGiftFieldsEntirely: boolean
}>): LobbyScreenState {
  const base: Record<string, unknown> = {
    profile: { profileId: 'test-profile-id', yellowCoinsBalance: 12345 },
    shopActiveTab: overrides.shopActiveTab ?? 'coins',
    shopPackages: [
      { packageId: 'coin-1', packageKey: 'starter', title: 'Starter', description: '', yellowCoinsAmount: 100000, priceCents: 499, currency: 'EUR', status: 'active', sortOrder: 10, showInLobby: true, isTopOffer: false },
    ],
    lobbyPackages: [],
    shopPackagesLoading: false,
    shopPackagesErrorText: null,
    shopPurchases: [
      {
        purchaseId: 'cp-normal-1',
        packageId: 'coin-1',
        packageKey: 'starter',
        title: 'Starter',
        yellowCoinsAmount: 100000,
        priceCents: 499,
        currency: 'EUR',
        provider: 'stripe',
        providerCheckoutSessionId: null,
        status: 'paid',
        creditedAt: '2026-01-01T00:00:00Z',
        hiddenAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        recipientProfileId: null,
        recipientDisplayNameSnapshot: overrides.coinRecipientSnapshot ?? null,
      },
    ],
    shopPurchasesVisible: true,
    shopPurchasesLoading: false,
    shopPurchaseConfirmPackageId: overrides.shopPurchaseConfirmPackageId ?? null,
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
        recipientProfileId: null,
        recipientDisplayNameSnapshot: overrides.bundleRecipientSnapshot ?? null,
      },
    ],
    bundlePurchasesVisible: true,
    bundlePurchaseActionPackageId: null,
    bundlePurchaseMessageText: null,
  }

  if (!overrides.omitGiftFieldsEntirely) {
    base.shopGiftRecipientProfileId = overrides.shopGiftRecipientProfileId ?? null
    base.shopGiftRecipientDisplayName = overrides.shopGiftRecipientDisplayName ?? null
    base.shopGiftRecipientErrorText = overrides.shopGiftRecipientErrorText ?? null
    base.shopGiftRecipientLoading = false
  }

  return base as unknown as LobbyScreenState
}

console.log('\ncheckPaidGiftShopFrontendRendering\n')

// ─── [1]-[4] Purchase history gift badge ───────────────────────────────────

check('[1] Desktop coin history row показва "Подарък за <recipient>" когато recipientDisplayNameSnapshot е зададен', () => {
  const state = buildBaseState({ shopActiveTab: 'coins', coinRecipientSnapshot: 'МоНии' })
  const html = renderShopPanel(state)
  assert(html.includes('Подарък за МоНии'), 'desktop coin history трябва да показва gift badge')
})

check('[2] Desktop bundle history row показва "Подарък за <recipient>"', () => {
  const state = buildBaseState({ shopActiveTab: 'bundle', bundleRecipientSnapshot: 'Иван' })
  const html = renderShopPanel(state)
  assert(html.includes('Подарък за Иван'), 'desktop bundle history трябва да показва gift badge')
})

check('[3] Mobile coin history row показва "Подарък за <recipient>"', () => {
  const state = buildBaseState({ shopActiveTab: 'coins', coinRecipientSnapshot: 'Петър' })
  const html = renderMobileShopPanel(state)
  assert(html.includes('Подарък за Петър'), 'mobile coin history трябва да показва gift badge')
})

check('[4] Mobile bundle history row показва "Подарък за <recipient>"', () => {
  const state = buildBaseState({ shopActiveTab: 'bundle', bundleRecipientSnapshot: 'Мария' })
  const html = renderMobileShopPanel(state)
  assert(html.includes('Подарък за Мария'), 'mobile bundle history трябва да показва gift badge')
})

// ─── [5] Normal purchase history остава непроменена ────────────────────────

check('[5] Normal (non-gift) purchase history ред НЕ показва gift badge (desktop+mobile, coin+bundle)', () => {
  const stateCoinDesktop = buildBaseState({ shopActiveTab: 'coins', coinRecipientSnapshot: null })
  const stateBundleDesktop = buildBaseState({ shopActiveTab: 'bundle', bundleRecipientSnapshot: null })
  const stateCoinMobile = buildBaseState({ shopActiveTab: 'coins', coinRecipientSnapshot: null })
  const stateBundleMobile = buildBaseState({ shopActiveTab: 'bundle', bundleRecipientSnapshot: null })

  assert(!renderShopPanel(stateCoinDesktop).includes('Подарък за'), 'desktop coin normal history НЕ трябва да съдържа gift badge')
  assert(!renderShopPanel(stateBundleDesktop).includes('Подарък за'), 'desktop bundle normal history НЕ трябва да съдържа gift badge')
  assert(!renderMobileShopPanel(stateCoinMobile).includes('Подарък за'), 'mobile coin normal history НЕ трябва да съдържа gift badge')
  assert(!renderMobileShopPanel(stateBundleMobile).includes('Подарък за'), 'mobile bundle normal history НЕ трябва да съдържа gift badge')
})

// ─── [6]-[7] Checkout confirm modal ─────────────────────────────────────────

check('[6] Checkout confirm modal (gift mode) показва "Потвърждение на подарък за <recipient>" + "за <recipient>" до сумата', () => {
  const state = buildBaseState({
    shopPurchaseConfirmPackageId: 'coin-1',
    shopGiftRecipientProfileId: 'recipient-xyz',
    shopGiftRecipientDisplayName: 'МоНии',
  })
  const html = renderShopPurchaseConfirmModal(state)
  assert(html.includes('Потвърждение на подарък за МоНии'), 'заглавието трябва да показва "за МоНии"')
  assert(html.includes('за МоНии'), 'редът с сумата трябва да показва "за МоНии"')
})

check('[7] REGRESSION GUARD: Checkout confirm modal с ЛИПСВАЩИ gift полета в state (partial/legacy shape) показва established "Потвърждение на покупка" (undefined != gift)', () => {
  const state = buildBaseState({
    shopPurchaseConfirmPackageId: 'coin-1',
    omitGiftFieldsEntirely: true,
  })
  const html = renderShopPurchaseConfirmModal(state)
  assert(html.includes('Потвърждение на покупка'), 'липсващи gift полета (undefined) НЕ трябва да се третират като gift mode')
  assert(!html.includes('Потвърждение на подарък'), 'НЕ трябва да покаже gift заглавие при undefined recipient полета')
})

// ─── [8]-[9] Shop header gift mode ──────────────────────────────────────────

check('[8] Desktop Shop header (gift mode) показва "Подари на <recipient>" за трите таба', () => {
  for (const tab of ['coins', 'vip', 'bundle'] as const) {
    const state = buildBaseState({
      shopActiveTab: tab,
      shopGiftRecipientProfileId: 'recipient-xyz',
      shopGiftRecipientDisplayName: 'Георги',
    })
    const html = renderShopPanel(state)
    assert(html.includes('Подари на Георги'), `desktop header (tab=${tab}) трябва да покаже "Подари на Георги"`)
  }
})

check('[9] Mobile Shop header (gift mode) показва "Подари на <recipient>" за трите таба', () => {
  for (const tab of ['coins', 'vip', 'bundle'] as const) {
    const state = buildBaseState({
      shopActiveTab: tab,
      shopGiftRecipientProfileId: 'recipient-xyz',
      shopGiftRecipientDisplayName: 'Георги',
    })
    const html = renderMobileShopPanel(state)
    assert(html.includes('Подари на Георги'), `mobile header (tab=${tab}) трябва да покаже "Подари на Георги"`)
  }
})

// ─── [10] EUR-only ───────────────────────────────────────────────────────────

check('[10] EUR-only: gift mode markup (desktop+mobile, трите таба, confirm modal) НИКЪДЕ не съдържа "лв."', () => {
  for (const tab of ['coins', 'vip', 'bundle'] as const) {
    const desktopState = buildBaseState({ shopActiveTab: tab, shopGiftRecipientProfileId: 'r', shopGiftRecipientDisplayName: 'Тест' })
    const mobileState = buildBaseState({ shopActiveTab: tab, shopGiftRecipientProfileId: 'r', shopGiftRecipientDisplayName: 'Тест' })
    assert(!renderShopPanel(desktopState).includes('лв.'), `desktop gift markup (tab=${tab}) НЕ трябва да съдържа "лв."`)
    assert(!renderMobileShopPanel(mobileState).includes('лв.'), `mobile gift markup (tab=${tab}) НЕ трябва да съдържа "лв."`)
  }
  const confirmState = buildBaseState({ shopPurchaseConfirmPackageId: 'coin-1', shopGiftRecipientProfileId: 'r', shopGiftRecipientDisplayName: 'Тест' })
  assert(!renderShopPurchaseConfirmModal(confirmState).includes('лв.'), 'confirm modal (gift) НЕ трябва да съдържа "лв."')
})

// ─── [11] Desktop/mobile coherence ──────────────────────────────────────────

check('[11] Desktop и mobile header за СЪЩИЯ gift state дават КОХЕРЕНТЕН recipient текст (без divergence)', () => {
  for (const tab of ['coins', 'vip', 'bundle'] as const) {
    const desktopState = buildBaseState({ shopActiveTab: tab, shopGiftRecipientProfileId: 'r', shopGiftRecipientDisplayName: 'Николай' })
    const mobileState = buildBaseState({ shopActiveTab: tab, shopGiftRecipientProfileId: 'r', shopGiftRecipientDisplayName: 'Николай' })
    const desktopHtml = renderShopPanel(desktopState)
    const mobileHtml = renderMobileShopPanel(mobileState)
    assert(desktopHtml.includes('Подари на Николай'), `desktop (tab=${tab}) трябва да съдържа recipient текста`)
    assert(mobileHtml.includes('Подари на Николай'), `mobile (tab=${tab}) трябва да съдържа recipient текста`)
  }
})

// ─── [12] Item Gift System untouched ────────────────────────────────────────

check('[12] Item Gift System markup структурно непроменен — data-player-profile-gift-item ОТДЕЛЕН от data-player-profile-gift-shop', () => {
  const html = renderPlayerProfilePopup({
    isOpen: true,
    seat: 'bottom',
    profile: {
      profileId: 'other-profile-id',
      displayName: 'Друг играч',
      avatarUrl: null,
      level: 1,
      rankTitle: 'Rank 1',
      skillRating: 1000,
      yellowCoinsBalance: 0,
      averageRating: null,
      totalRatingsCount: 0,
      completedGamesCount: 0,
      wonGamesCount: 0,
      gender: null,
      isBlockedByMe: false,
      isBlockingMe: false,
      profileKind: 'human',
    } as never,
    isOwnProfile: false,
    canEdit: false,
    giftItemRecipientProfileId: 'other-profile-id',
    giftShopRecipientProfileId: 'other-profile-id',
  })

  assert(html.includes('data-player-profile-gift-item="other-profile-id"'), 'Item Gift System бутонът трябва да присъства с точния data атрибут')
  assert(html.includes('data-player-profile-gift-shop="other-profile-id"'), '"Подари авоари" бутонът трябва да присъства с точния data атрибут')
  assert(html.includes('Подарък'), 'Item Gift System label "Подарък" трябва да присъства')
  assert(html.includes('Подари авоари'), '"Подари авоари" label трябва да присъства')
  // Двата бутона трябва да са ДВЕ отделни markup конструкции, не мерджнати
  const giftItemIndex = html.indexOf('data-player-profile-gift-item=')
  const giftShopIndex = html.indexOf('data-player-profile-gift-shop=')
  assert(giftItemIndex !== -1 && giftShopIndex !== -1 && giftItemIndex !== giftShopIndex, 'двата data атрибута трябва да са на различни позиции в markup-а (отделни елементи)')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
