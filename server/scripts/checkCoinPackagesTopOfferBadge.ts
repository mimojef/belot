/**
 * checkCoinPackagesTopOfferBadge.ts — Проверки за показването/скриването на баджа
 * "ТОП ОФЕРТА" в четирите изгледа (Lobby desktop/mobile, Shop desktop/mobile).
 *
 * Тества чрез pure render helper-и (без DOM), огледално на подхода в
 * checkShopPurchaseFlow.ts [16] (renderShopPurchaseConfirmModal + минимален
 * LobbyScreenState fixture чрез `as unknown as`).
 *
 * [0]  renderBottomSection (Lobby, desktop) показва баджа за isTopOffer:true пакет
 * [1]  renderBottomSection не показва баджа за isTopOffer:false пакет
 * [2]  renderBottomSection не крие сумата/цената/бутона за покупка при показан бадж
 * [3]  renderMobileOffersSection (Lobby, mobile) показва баджа за isTopOffer:true пакет
 * [4]  renderMobileOffersSection не показва баджа за isTopOffer:false пакет
 * [5]  renderShopPanel (Shop, desktop) показва баджа за isTopOffer:true пакет
 * [6]  renderShopPanel не показва баджа за isTopOffer:false пакет
 * [7]  renderShopPanel не крие сумата/цената/изображението/бутона при показан бадж
 * [8]  renderShopPanel (isAdmin:true) показва и чекбокса за "Топ оферта" редом с "Видима в лобито"
 * [9]  renderMobileShopPanel (Shop, mobile) показва баджа за isTopOffer:true пакет
 * [10] renderMobileShopPanel не показва баджа за isTopOffer:false пакет
 * [11] renderShopPanel с 7 пакета (непълен втори ред от 5-колонния grid) — всички 7 карета
 *      се рендират точно по веднъж (без изгубени/дублирани), баджът се показва точно
 *      веднъж за флагнатия пакет от втория (непълен) ред, картите пазят фиксирана 1/5
 *      ширина (не се разтягат, за да запълнят непълния ред)
 */

import {
  renderBottomSection,
  renderMobileOffersSection,
  renderShopPanel,
  renderMobileShopPanel,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'
import type { CoinPackageSnapshot } from '../../src/app/network/createGameServerClient.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

const BADGE_TEXT = 'ТОП ОФЕРТА'

function makePackage(overrides: Partial<CoinPackageSnapshot> = {}): CoinPackageSnapshot {
  return {
    packageId: 'pkg-1',
    packageKey: 'starter',
    title: 'Starter',
    description: 'Тестов пакет',
    yellowCoinsAmount: 40000,
    priceCents: 199,
    currency: 'EUR',
    status: 'active',
    sortOrder: 1,
    showInLobby: true,
    isTopOffer: false,
    ...overrides,
  }
}

function makeShopState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    shopPackagesLoading: false,
    shopPackagesErrorText: null,
    shopPackages: [],
    profile: { profileId: 'prof-1', yellowCoinsBalance: 5000 },
    isAdmin: false,
    shopPurchaseMessageText: null,
    shopPurchasesVisible: false,
    shopPurchasesLoading: false,
    shopPurchases: [],
    shopPurchaseActionPurchaseId: null,
    shopPurchaseHideConfirmId: null,
    shopPurchaseActionPackageId: null,
    ...overrides,
  } as unknown as LobbyScreenState
}

function main(): void {
  const topPkg = makePackage({ packageId: 'pkg-top', packageKey: 'top', isTopOffer: true })
  const normalPkg = makePackage({ packageId: 'pkg-normal', packageKey: 'normal', isTopOffer: false })

  check('[0] renderBottomSection показва баджа за isTopOffer:true', () => {
    const html = renderBottomSection([topPkg], true, 0, false, false)
    assert(html.includes(BADGE_TEXT), 'HTML трябва да съдържа "ТОП ОФЕРТА"')
  })

  check('[1] renderBottomSection не показва баджа за isTopOffer:false', () => {
    const html = renderBottomSection([normalPkg], true, 0, false, false)
    assert(!html.includes(BADGE_TEXT), 'HTML не трябва да съдържа "ТОП ОФЕРТА"')
  })

  check('[2] renderBottomSection: баджът не крие сума/цена/бутон за покупка', () => {
    const html = renderBottomSection([topPkg], true, 0, false, false)
    const expectedAmount = new Intl.NumberFormat('bg-BG').format(topPkg.yellowCoinsAmount)
    assert(html.includes(expectedAmount), 'сумата трябва да е видима')
    assert(html.includes(`data-lobby-buy-coins-package="${topPkg.packageId}"`), 'бутонът за покупка трябва да е наличен')
  })

  check('[3] renderMobileOffersSection показва баджа за isTopOffer:true', () => {
    const html = renderMobileOffersSection([topPkg], true)
    assert(html.includes(BADGE_TEXT), 'HTML трябва да съдържа "ТОП ОФЕРТА"')
  })

  check('[4] renderMobileOffersSection не показва баджа за isTopOffer:false', () => {
    const html = renderMobileOffersSection([normalPkg], true)
    assert(!html.includes(BADGE_TEXT), 'HTML не трябва да съдържа "ТОП ОФЕРТА"')
  })

  check('[5] renderShopPanel показва баджа за isTopOffer:true', () => {
    const html = renderShopPanel(makeShopState({ shopPackages: [topPkg] }))
    assert(html.includes(BADGE_TEXT), 'HTML трябва да съдържа "ТОП ОФЕРТА"')
  })

  check('[6] renderShopPanel не показва баджа за isTopOffer:false', () => {
    const html = renderShopPanel(makeShopState({ shopPackages: [normalPkg] }))
    assert(!html.includes(BADGE_TEXT), 'HTML не трябва да съдържа "ТОП ОФЕРТА"')
  })

  check('[7] renderShopPanel: баджът не крие сума/цена/изображение/бутон', () => {
    const html = renderShopPanel(makeShopState({ shopPackages: [topPkg] }))
    const expectedAmount = new Intl.NumberFormat('bg-BG').format(topPkg.yellowCoinsAmount)
    const expectedPrice = new Intl.NumberFormat('bg-BG', { style: 'currency', currency: topPkg.currency }).format(topPkg.priceCents / 100)
    assert(html.includes(expectedAmount), 'сумата трябва да е видима')
    assert(html.includes(expectedPrice), 'форматираната цена трябва да присъства')
    assert(html.includes('<img'), 'изображението на пакета трябва да е налично')
    assert(html.includes(`data-lobby-shop-package="${topPkg.packageId}"`), 'бутонът за покупка трябва да е наличен')
  })

  check('[8] renderShopPanel (isAdmin) показва чекбокс за "Топ оферта"', () => {
    const html = renderShopPanel(makeShopState({ shopPackages: [topPkg], isAdmin: true }))
    assert(html.includes(`data-lobby-shop-package-top-offer="${topPkg.packageId}"`), 'чекбоксът за топ оферта трябва да е наличен')
    assert(html.includes(`data-lobby-shop-package-lobby="${topPkg.packageId}"`), 'чекбоксът за лоби трябва да остане наличен')
  })

  check('[9] renderMobileShopPanel показва баджа за isTopOffer:true', () => {
    const html = renderMobileShopPanel(makeShopState({ shopPackages: [topPkg] }))
    assert(html.includes(BADGE_TEXT), 'HTML трябва да съдържа "ТОП ОФЕРТА"')
  })

  check('[10] renderMobileShopPanel не показва баджа за isTopOffer:false', () => {
    const html = renderMobileShopPanel(makeShopState({ shopPackages: [normalPkg] }))
    assert(!html.includes(BADGE_TEXT), 'HTML не трябва да съдържа "ТОП ОФЕРТА"')
  })

  check('[11] renderShopPanel с 7 пакета (непълен втори ред): без изгубени/дублирани карета, точно 1 бадж, фиксирана 1/5 ширина', () => {
    const packages = Array.from({ length: 7 }, (_, index) =>
      makePackage({
        packageId: `pkg-multi-${index}`,
        packageKey: `multi-${index}`,
        title: `Package ${index}`,
        isTopOffer: index === 5,
      }),
    )
    const html = renderShopPanel(makeShopState({ shopPackages: packages }))

    for (const pkg of packages) {
      assert(
        html.includes(`data-lobby-shop-package="${pkg.packageId}"`),
        `бутонът за ${pkg.packageId} трябва да присъства`,
      )
      const titleOccurrences = html.split(pkg.title).length - 1
      assert(
        titleOccurrences === 1,
        `заглавието "${pkg.title}" трябва да се появи точно веднъж, намерени ${titleOccurrences}`,
      )
    }

    const badgeOccurrences = html.split(BADGE_TEXT).length - 1
    assert(badgeOccurrences === 1, `очакван точно 1 бадж, намерени ${badgeOccurrences}`)

    const fixedWidthOccurrences = html.split('flex:0 0 calc((100% - 48px) / 5)').length - 1
    assert(
      fixedWidthOccurrences === 7,
      `всичките 7 карета трябва да пазят фиксирана 1/5 ширина, намерени ${fixedWidthOccurrences}`,
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)

  if (failed > 0) {
    process.exitCode = 1
  }
}

main()
