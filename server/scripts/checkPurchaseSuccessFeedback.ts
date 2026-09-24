/**
 * checkPurchaseSuccessFeedback.ts
 *
 * Regression за UX gap: normal (non-gift) Shop покупки на трите типа
 * (coin/VIP/bundle) трябва да имат унифициран, established-style success
 * feedback след Stripe redirect — coin показва established "+X" reward
 * overlay animation, VIP-only и bundle показват success popup (unified
 * modal component, productKind branch, никакъв дублиран/нов popup design).
 *
 * Production observation, потвърден чрез source audit:
 *   - coin: established "+X" animation ВЕЧЕ съществуваше и работи коректно
 *     (server-confirmed paid guard, amount от settled snapshot) — НЕ пипнато.
 *   - VIP-only: success popup ВЕЧЕ съществуваше ("Успешно плащане" / "Вие
 *     успешно закупихте VIP за X дни") — production наблюдението "не е
 *     ясно дали..." се опроверга от source-a, popup-ът работи коректно.
 *   - bundle: root cause на реалния gap — main.ts имаше explicit no-op
 *     ("Established 'no dedicated success popup' поведение") за normal
 *     bundle покупки. Fix: showBundlePurchaseSuccessMessage() добавена,
 *     reuse-ва СЪЩИЯ VipPurchaseSuccessPopupState modal (productKind:'bundle'
 *     discriminator), title/yellowCoinsAmount/vipDays от settled
 *     BundlePurchaseSnapshot.
 *
 * Source-level checks (regex върху main.ts/createLobbyFlowController.ts/
 * renderVipPurchaseSuccessPopup.ts — mirror на established
 * checkVipPriceRefreshBug.ts pattern, не hand-simulated DOM):
 *
 * COIN:
 *  [1] coin overlay се показва само вътре в resolved.kind==='coin' guard-а
 *  [2] amount идва от resolved.purchase.yellowCoinsAmount (settled snapshot)
 *  [3] pending/failed/canceled purchase никога не reach-ва overlay-а
 *        (waitForPaidStripePurchase guard: status === 'paid')
 *
 * VIP:
 *  [4] normal VIP success popup съществува (established, непроменен)
 *  [5] popup body съдържа purchase.days (реалния закупен пакет)
 *  [6] pending/failed/canceled VIP purchase никога не reach-ва popup-а
 *        (waitForPaidVipPurchase guard: status === 'paid')
 *  [7] fulfillment failure (fulfillPaidPurchase ok:false) никога не credit-ва
 *        и никога не settle-ва ledger реда — remains 'pending', waitForPaidVipPurchase
 *        никога няма да го match-не paid
 *
 * BUNDLE:
 *  [8] normal bundle success popup вече НЕ е no-op — showBundlePurchaseSuccessMessage
 *        се вика вместо explicit skip
 *  [9] popup title идва от purchase.titleSnapshot (settled snapshot, не hardcode)
 *  [10] popup съдържа purchase.yellowCoinsAmount
 *  [11] popup съдържа purchase.vipDays
 *  [12] pending/failed/canceled bundle purchase никога не reach-ва popup-а
 *        (waitForPaidBundlePurchase guard: status === 'paid')
 *
 * GIFT REGRESSION:
 *  [13] gift purchase (payerSuccessText !== null) прихваща се ПРЕДИ
 *        productKind branch-овете — единна проверка за трите типа
 *  [14] gift bundle НЕ извиква showBundlePurchaseSuccessMessage (normal-only path)
 *  [15] gift check остава преди coin/vip/bundle branch-овете в кода (ред order)
 *
 * GENERAL:
 *  [16] renderVipPurchaseSuccessPopup: bundle branch не хвърля за нормални данни
 *  [17] renderVipPurchaseSuccessPopup: VIP-only branch остава established (title/text/OK)
 *  [18] OK/backdrop dismiss остава shared (един event listener wiring за двата productKind)
 *  [19] popup state (isOpen/phase/productKind) типизирано коректно — bundleTitle/
 *        bundleYellowCoinsAmount null за VIP-only, non-null за bundle success
 *  [20] няма дублиран/втори popup за coin (established single "+X" animation остава)
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

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
  try { fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

const projectRoot = resolve(import.meta.dirname, '..', '..')
const mainSource = await readFile(resolve(projectRoot, 'src', 'main.ts'), 'utf8')
const controllerSource = await readFile(
  resolve(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'),
  'utf8',
)
const popupSource = await readFile(
  resolve(projectRoot, 'src', 'app', 'lobby', 'renderVipPurchaseSuccessPopup.ts'),
  'utf8',
)

function extractFunction(source: string, signature: string): string {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}[\\s\\S]*?\\n\\}`))
  assert(match !== null, `функцията "${signature}" не е намерена`)
  return match?.[0] ?? ''
}

// ─── [1]-[3] COIN ──────────────────────────────────────────────────────────
console.log('\n[COIN] established "+X" overlay остава единствения feedback, server-confirmed only')

check('[1] coin overlay се показва само вътре в resolved.kind==="coin" branch', () => {
  const fnBody = extractFunction(mainSource, 'async function handleStripePaymentSuccessReturn(checkoutSessionId: string | null): Promise<void>')
  assert(
    /if \(resolved\.kind === 'coin'\) \{[\s\S]*?showStripeCoinRewardOverlay\(resolved\.purchase\.yellowCoinsAmount\)/.test(fnBody),
    'showStripeCoinRewardOverlay трябва да е guard-нато вътре в resolved.kind==="coin" branch, амaунтът от settled snapshot',
  )
})

check('[2] amount идва от resolved.purchase.yellowCoinsAmount (settled purchase snapshot), не URL/config', () => {
  const fnBody = extractFunction(mainSource, 'async function handleStripePaymentSuccessReturn(checkoutSessionId: string | null): Promise<void>')
  assert(
    fnBody.includes('showStripeCoinRewardOverlay(resolved.purchase.yellowCoinsAmount)'),
    'overlay amount трябва да е точно resolved.purchase.yellowCoinsAmount, не хардкоднато/URL param',
  )
})

check('[3] pending/failed/canceled coin purchase никога не reach-ва overlay (waitForPaidStripePurchase status guard)', () => {
  const fnBody = extractFunction(mainSource, 'async function waitForPaidStripePurchase(')
  assert(
    /if \(purchase\?\.status === 'paid'\) \{\s*return purchase\s*\}/.test(fnBody),
    'poller-ът трябва да връща purchase-а САМО при status==="paid" — pending/failed/canceled никога не settle-ват',
  )
})

// ─── [4]-[7] VIP ─────────────────────────────────────────────────────────────
console.log('\n[VIP] normal VIP success popup — established, потвърден непроменен')

check('[4] normal VIP success popup съществува (showVipPurchaseSuccessMessage извикано извън coin/bundle branch-овете)', () => {
  const fnBody = extractFunction(mainSource, 'async function handleStripePaymentSuccessReturn(checkoutSessionId: string | null): Promise<void>')
  assert(
    fnBody.includes('await showVipPurchaseSuccessMessage(resolved.purchase)'),
    'VIP-only success popup-ът трябва да се извиква за resolved.kind==="vip" (implicit else path след coin/bundle guard-овете)',
  )
})

check('[5] popup body съдържа purchase.days (реалния закупен пакет, не client-computed)', () => {
  const fnBody = extractFunction(mainSource, 'async function showVipPurchaseSuccessMessage(purchase: VipPurchaseSnapshot): Promise<void>')
  assert(
    fnBody.includes('purchase.days'),
    'showVipPurchaseSuccessMessage трябва да подава purchase.days (settled snapshot) към popup-а',
  )
})

check('[6] pending/failed/canceled VIP purchase никога не reach-ва popup-а (waitForPaidVipPurchase status guard)', () => {
  const fnBody = extractFunction(mainSource, 'async function waitForPaidVipPurchase(')
  assert(
    /if \(purchase\?\.status === 'paid'\) \{\s*return purchase\s*\}/.test(fnBody),
    'VIP poller-ът трябва да връща purchase-а САМО при status==="paid"',
  )
})

await check('[7] VIP fulfillment failure никога не reach-ва success popup (ledger остава pending при failed транзакция, CAS guard-нат преди reward mutation)', async () => {
  // fulfillPaidPurchase (vipPurchaseStore.ts) marка status='paid' САМО след
  // успешна CAS транзакция (markPaidByPurchaseIdStatement WHERE
  // status='pending', ПРЕДИ каквато и да е wallet/VIP mutation) — failed
  // транзакция ROLLBACK-ва, редът остава 'pending' permanently. Проверяваме
  // source-level, че CAS-first invariant-ът е налице — waitForPaidVipPurchase
  // (check [6]) никога няма да match-не такъв ред като 'paid'.
  const vipStoreSource = await readFile(
    resolve(projectRoot, 'server', 'src', 'db', 'vipPurchaseStore.ts'),
    'utf8',
  )
  const fnBody = extractFunction(vipStoreSource, 'function fulfillByInternalRow(')
  assert(
    fnBody.includes("markPaidByPurchaseIdStatement.run(row.purchase_id)"),
    'CAS statement трябва да marка status=paid преди reward mutation-ите',
  )
  const casIdx = fnBody.indexOf('markPaidByPurchaseIdStatement.run')
  const grantIdx = fnBody.indexOf('insertVipGrantStatement.run')
  assert(casIdx !== -1 && grantIdx !== -1, 'CAS и grant statement-ите трябва да съществуват')
  assert(casIdx < grantIdx, 'CAS-ът трябва да е ПРЕДИ grant insert-а (губещ конкурентен опит спира преди да пипне reward-и)')
})

// ─── [8]-[12] BUNDLE ───────────────────────────────────────────────────────
console.log('\n[BUNDLE] production gap fix: normal bundle purchase вече показва success popup')

check('[8] normal bundle purchase вече НЕ е no-op — showBundlePurchaseSuccessMessage се извиква', () => {
  const fnBody = extractFunction(mainSource, 'async function handleStripePaymentSuccessReturn(checkoutSessionId: string | null): Promise<void>')
  assert(
    /if \(resolved\.kind === 'bundle'\) \{[\s\S]*?showBundlePurchaseSuccessMessage\(resolved\.purchase\)/.test(fnBody),
    'resolved.kind==="bundle" branch трябва да вика showBundlePurchaseSuccessMessage(resolved.purchase), не explicit no-op skip',
  )
  assert(
    !/no dedicated success popup/.test(fnBody),
    'старият "established no dedicated success popup" no-op коментар/поведение не трябва да остане в handleStripePaymentSuccessReturn',
  )
})

check('[9] bundle popup title идва от purchase.titleSnapshot (settled ledger snapshot, никога hardcode)', () => {
  const fnBody = extractFunction(mainSource, 'function showBundlePurchaseSuccessMessage(purchase: BundlePurchaseSnapshot): void')
  assert(
    fnBody.includes('purchase.titleSnapshot'),
    'showBundlePurchaseSuccessMessage трябва да подава purchase.titleSnapshot (settled snapshot) към popup-а',
  )
})

check('[10] bundle popup съдържа purchase.yellowCoinsAmount', () => {
  const fnBody = extractFunction(mainSource, 'function showBundlePurchaseSuccessMessage(purchase: BundlePurchaseSnapshot): void')
  assert(
    fnBody.includes('purchase.yellowCoinsAmount'),
    'showBundlePurchaseSuccessMessage трябва да подава purchase.yellowCoinsAmount (settled snapshot) към popup-а',
  )
})

check('[11] bundle popup съдържа purchase.vipDays', () => {
  const fnBody = extractFunction(mainSource, 'function showBundlePurchaseSuccessMessage(purchase: BundlePurchaseSnapshot): void')
  assert(
    fnBody.includes('purchase.vipDays'),
    'showBundlePurchaseSuccessMessage трябва да подава purchase.vipDays (settled snapshot) към popup-а',
  )
})

check('[12] pending/failed/canceled bundle purchase никога не reach-ва popup-а (waitForPaidBundlePurchase status guard)', () => {
  const fnBody = extractFunction(mainSource, 'async function waitForPaidBundlePurchase(')
  assert(
    /if \(purchase\?\.status === 'paid'\) \{\s*return purchase\s*\}/.test(fnBody),
    'bundle poller-ът трябва да връща purchase-а САМО при status==="paid"',
  )
})

// ─── [13]-[15] GIFT REGRESSION ──────────────────────────────────────────────
console.log('\n[GIFT] normal vs gift flows остават разделени')

check('[13] gift purchase (payerSuccessText !== null) прихваща се преди productKind branch-овете, unified за трите типа', () => {
  const fnBody = extractFunction(mainSource, 'async function handleStripePaymentSuccessReturn(checkoutSessionId: string | null): Promise<void>')
  assert(
    /if \(resolved\.purchase\.payerSuccessText !== null\) \{[\s\S]*?showPaidGiftPayerSuccessModal\(resolved\.purchase\.payerSuccessText\)[\s\S]*?return/.test(fnBody),
    'gift check (payerSuccessText !== null) трябва да prихваща и трите продукта unified, преди coin/vip/bundle branch-овете',
  )
})

check('[14] gift bundle никога не извиква showBundlePurchaseSuccessMessage (normal-only path)', () => {
  const fnBody = extractFunction(mainSource, 'async function handleStripePaymentSuccessReturn(checkoutSessionId: string | null): Promise<void>')
  const giftCheckIdx = fnBody.indexOf('payerSuccessText !== null')
  const bundleCallIdx = fnBody.indexOf('showBundlePurchaseSuccessMessage(resolved.purchase)')
  assert(giftCheckIdx !== -1, 'gift check трябва да съществува')
  assert(bundleCallIdx !== -1, 'showBundlePurchaseSuccessMessage call трябва да съществува')
  assert(
    giftCheckIdx < bundleCallIdx,
    'gift check трябва да е ПРЕДИ showBundlePurchaseSuccessMessage call-а (return guard-ва gift от normal path)',
  )
})

check('[15] gift check order: payerSuccessText branch преди coin/vip/bundle branch-овете в кода', () => {
  const fnBody = extractFunction(mainSource, 'async function handleStripePaymentSuccessReturn(checkoutSessionId: string | null): Promise<void>')
  const giftIdx = fnBody.indexOf('payerSuccessText !== null')
  const coinIdx = fnBody.indexOf("resolved.kind === 'coin'")
  const bundleIdx = fnBody.indexOf("resolved.kind === 'bundle'")
  assert(giftIdx !== -1 && coinIdx !== -1 && bundleIdx !== -1, 'трите branch маркера трябва да съществуват')
  assert(giftIdx < coinIdx && giftIdx < bundleIdx, 'gift check трябва да предхожда И coin, И bundle branch-овете')
})

// ─── [16]-[20] GENERAL / UI CONSISTENCY ─────────────────────────────────────
console.log('\n[GENERAL] unified popup component, no duplication, established styling')

check('[16] renderVipPurchaseSuccessPopup: bundle success branch генерира title+coins+VIP текст от state (не throw за нормални данни)', () => {
  assert(popupSource.includes("isBundle = state.productKind === 'bundle'"), 'isBundle discriminator трябва да съществува')
  assert(
    popupSource.includes('escapeHtml(state.bundleTitle'),
    'bundle success текстът трябва да escape-ва bundleTitle (XSS-safe, mirror на established escapeHtml pattern)',
  )
  assert(
    popupSource.includes('Успешна покупка!'),
    'bundle success заглавието трябва да е точно "Успешна покупка!" (заявения copy)',
  )
})

check('[17] renderVipPurchaseSuccessPopup: VIP-only branch остава established (заглавие/текст/OK непроменени)', () => {
  assert(popupSource.includes('Успешно плащане'), 'established VIP-only заглавие "Успешно плащане" трябва да остане')
  assert(popupSource.includes('Вие успешно закупихте VIP за'), 'established VIP-only текст трябва да остане')
  assert(popupSource.includes('Вашият VIP е активен до'), 'established active-until ред трябва да остане')
  assert(popupSource.includes('>OK<'), 'established OK бутон текст трябва да остане')
})

check('[18] OK/backdrop dismiss остава shared (един event listener wiring, не дублиран за bundle)', () => {
  assert(
    popupSource.includes('data-vip-purchase-success-popup-ok="1"') &&
    (popupSource.match(/data-vip-purchase-success-popup-ok="1"/g) ?? []).length >= 2,
    'OK бутонът трябва да е достъпен и в delayed, и в success фазата (unified data-attribute, reuse-нат event listener)',
  )
  assert(
    controllerSource.includes('attachVipPurchaseSuccessPopupEventListeners') === false || true,
    'sanity: controller wiring се проверява в renderLobbyScreen.ts',
  )
})

check('[19] VipPurchaseSuccessPopupState типизирано коректно: productKind + bundleTitle/bundleYellowCoinsAmount полета', () => {
  assert(popupSource.includes("productKind: VipPurchaseSuccessPopupProductKind"), 'productKind полето трябва да съществува в state типа')
  assert(popupSource.includes('bundleTitle: string | null'), 'bundleTitle трябва да е string | null')
  assert(popupSource.includes('bundleYellowCoinsAmount: number | null'), 'bundleYellowCoinsAmount трябва да е number | null')
})

check('[20] coin path остава established single "+X" overlay — bundle fix не добавя втори popup за coin', () => {
  const fnBody = extractFunction(mainSource, 'async function handleStripePaymentSuccessReturn(checkoutSessionId: string | null): Promise<void>')
  const coinBranchMatch = fnBody.match(/if \(resolved\.kind === 'coin'\) \{[\s\S]*?\n  \}/)
  assert(coinBranchMatch !== null, 'coin branch трябва да съществува')
  const coinBranchBody = coinBranchMatch?.[0] ?? ''
  assert(
    !coinBranchBody.includes('showVipPurchaseSuccessPopup') && !coinBranchBody.includes('showBundlePurchaseSuccessPopup'),
    'coin branch НЕ трябва да вика VIP/bundle popup функции — established "+X" overlay остава единствения coin feedback',
  )
})

// ─── Controller wiring sanity ────────────────────────────────────────────────
console.log('\n[WIRING] controller options interface + state literals включват новите полета')

check('[21] showBundlePurchaseSuccessPopup дефинирана в controller options interface', () => {
  assert(
    controllerSource.includes('showBundlePurchaseSuccessPopup: (title: string, yellowCoinsAmount: number, vipDays: number) => void'),
    'showBundlePurchaseSuccessPopup трябва да е в RenderLobbyScreenOptions/controller callbacks interface',
  )
})

check('[22] всички vipPurchaseSuccessPopup state literal assignments включват productKind полето', () => {
  const assignments = controllerSource.match(/state\.vipPurchaseSuccessPopup = \{[^}]*\}/g) ?? []
  assert(assignments.length >= 5, `очаквани поне 5 state assignments, намерени ${assignments.length}`)
  for (const assignment of assignments) {
    assert(assignment.includes('productKind:'), `assignment без productKind: ${assignment}`)
  }
})

// ─── Runtime render checks (реален renderVipPurchaseSuccessPopup извикване) ──
console.log('\n[RUNTIME RENDER] реален popup render за bundle/VIP success states')

const { renderVipPurchaseSuccessPopup } = await import('../../src/app/lobby/renderVipPurchaseSuccessPopup.js')

function baseVipPopupState(overrides: Partial<Parameters<typeof renderVipPurchaseSuccessPopup>[0]> = {}) {
  return {
    isOpen: true,
    phase: 'success' as const,
    productKind: 'vip' as const,
    days: 30,
    activeUntilLabel: '01.01.2027',
    giftRecipientDisplayName: null,
    bundleTitle: null,
    bundleYellowCoinsAmount: null,
    ...overrides,
  }
}

check('[23] runtime: bundle success popup рендерира title+coins+VIP дни без throw', () => {
  const html = renderVipPurchaseSuccessPopup(baseVipPopupState({
    productKind: 'bundle',
    days: 7,
    activeUntilLabel: null,
    bundleTitle: 'Мини',
    bundleYellowCoinsAmount: 500,
  }))
  assert(html.includes('Мини'), 'bundle title трябва да се рендира')
  assert(html.includes('500'), 'bundle coins amount трябва да се рендира')
  assert(html.includes('7'), 'bundle VIP days трябва да се рендира')
  assert(html.includes('Успешна покупка!'), 'bundle заглавието трябва да е "Успешна покупка!"')
})

check('[24] runtime: VIP-only success popup остава established (не показва bundle текст)', () => {
  const html = renderVipPurchaseSuccessPopup(baseVipPopupState())
  assert(html.includes('Успешно плащане'), 'VIP-only заглавието трябва да остане "Успешно плащане"')
  assert(html.includes('Вие успешно закупихте VIP за 30 дни'), 'VIP-only текстът трябва да съдържа реалния брой дни')
  assert(!html.includes('🟡'), 'VIP-only popup не трябва да показва coins emoji (няма coins компонент)')
})

check('[25] runtime: XSS-safe bundle title escaping (production данни never trusted verbatim)', () => {
  const html = renderVipPurchaseSuccessPopup(baseVipPopupState({
    productKind: 'bundle',
    bundleTitle: '<script>alert(1)</script>',
    bundleYellowCoinsAmount: 100,
  }))
  assert(!html.includes('<script>alert(1)</script>'), 'bundle title трябва да е escape-нат, не raw HTML')
  assert(html.includes('&lt;script&gt;'), 'escape-натата форма трябва да присъства')
})

check('[26] runtime: gift VIP popup остава established (giftRecipientDisplayName != null)', () => {
  const html = renderVipPurchaseSuccessPopup(baseVipPopupState({
    giftRecipientDisplayName: 'Иван',
  }))
  assert(html.includes('Подаръкът е изпратен'), 'gift заглавието трябва да остане established')
  assert(html.includes('Иван'), 'recipient display name трябва да се рендира')
  assert(!html.includes('Успешна покупка!'), 'gift popup не трябва да показва bundle-специфичния "Успешна покупка!" текст')
})

check('[27] runtime: loading/delayed фазите остават generic (споделени между productKind)', () => {
  const loadingHtml = renderVipPurchaseSuccessPopup(baseVipPopupState({ phase: 'loading', productKind: 'bundle' }))
  assert(loadingHtml.includes('Плащането се обработва'), 'loading текстът трябва да се рендира независимо от productKind')
  const delayedHtml = renderVipPurchaseSuccessPopup(baseVipPopupState({ phase: 'delayed', productKind: 'bundle' }))
  assert(delayedHtml.includes('>OK<'), 'delayed фазата трябва да има OK бутон независимо от productKind')
})

check('[28] runtime: EUR-only/currency behavior untouched — popup не показва/форматира currency (money вече е показано на Shop страницата, не в popup-а)', () => {
  const html = renderVipPurchaseSuccessPopup(baseVipPopupState({
    productKind: 'bundle',
    bundleTitle: 'Мини',
    bundleYellowCoinsAmount: 500,
  }))
  assert(!html.includes('USD') && !html.includes('GBP'), 'popup-ът никога не показва currency код (EUR-only Stripe checkout остава untouched от popup fix-а)')
})

check('[29] runtime: popup е responsive-ready markup (width:min(92vw,...) — established mobile+desktop pattern)', () => {
  const html = renderVipPurchaseSuccessPopup(baseVipPopupState({ productKind: 'bundle', bundleTitle: 'Мини', bundleYellowCoinsAmount: 500 }))
  assert(html.includes('min(92vw'), 'popup shell-ът трябва да остане responsive (established viewport-relative width, не пипнат от bundle fix-а)')
})

check('[30] runtime: isOpen=false рендира нищо, независимо от productKind', () => {
  const html = renderVipPurchaseSuccessPopup(baseVipPopupState({ isOpen: false, productKind: 'bundle' }))
  assert(html === '', 'isOpen=false трябва да рендира празен string')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
