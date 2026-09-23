/**
 * checkPaidGiftNotificationFrontend.ts
 *
 * Round 3 (Paid Gift Notifications) — frontend render-level coverage,
 * допълваща server-side coverage-a (checkPaidGiftNotificationDelivery.ts,
 * checkPaidGiftNotificationRealtimeDelivery.ts). Node import на реалните
 * production render функции (renderPaidGiftNotificationModal/
 * renderPaidGiftPayerSuccessModal, export-нати от renderLobbyScreen.ts
 * специално за тоя тест), established pattern (mirror на
 * checkPaidGiftShopFrontendRendering.ts / checkGiftItemNotificationQueue.ts /
 * checkTableGiftPresentation.ts — комбинация от pure-function render checks,
 * source-text wiring checks и поведенчески queue harness за логиката, която
 * не може да се репликира без DOM/WS (проектът няма jsdom).
 *
 * Реалните compose*GiftSuccessText/compose*GiftNotificationText функции
 * (server/src/db/paidGiftNotificationText.ts) са ЧИСТИ string helpers без
 * DB/network зависимости — import-ват се директно тук, за да се тества
 * реалния round-trip формат (server compose -> client render), не hardcoded
 * copy duplicate-нат в теста.
 *
 * [1]  Payer coin gift success copy: "Вие успешно подарихте на X Y жълтици."
 * [2]  Payer VIP gift success copy: "Вие успешно подарихте на X Y дни VIP."
 * [3]  Payer bundle gift success copy: multi-line (title + coins + VIP),
 *        white-space:pre-line пази форматирането без <br>
 * [4]  Recipient coin popup copy: "X ви подари Y жълтици."
 * [5]  Recipient VIP popup copy: "X ви подари Y дни VIP."
 * [6]  Recipient bundle popup copy: multi-line, аналогично на [3]
 * [7]  EUR-only + §15 no-price-leakage regression: нито payer success, нито
 *        recipient notification popup показват цена (лв./€/EUR) — recipient
 *        никога не трябва да разбере колко е платил payer-ът
 * [8]  HTML-escaping regression: bodyText/text минават през escapeHtml —
 *        embedded markup в display name не се inject-ва суров в DOM-а
 * [9]  Item Gift System остава напълно ОТДЕЛЕН domain — различни data
 *        атрибути, различни state полета, никакво кръстосано рефериране
 * [10] Duplicate notification id (offline bootstrap + realtime race) НЕ
 *        enqueue-ва duplicate popup — dedup срещу опашката И срещу текущо
 *        активния модал
 * [11] Multiple notifications се показват sequentially (FIFO), coin+VIP+
 *        bundle mixed
 * [12] OK бутонът ACK-ва ТОЧНО активната notification (purchaseId+
 *        purchaseType), никога stale/queue-head id
 * [13] Recipient popup може да се render-не при активна игра — routing
 *        решението (banner vs modal) се взима при ПОКАЗВАНЕ, не при enqueue
 * [14] Queue wiring source-text: enqueue/showNext/complete функциите
 *        действително имплементират горните инварианти в реалния код
 * [15] Desktop и Mobile рендиране: модалите са wired в ДВЕТЕ layout клона на
 *        renderLobbyScreen (identical markup stack adjacency)
 * [16] Normal (non-gift) Shop покупка НИКОГА не влиза в notification flow —
 *        showPaidGiftPayerSuccessModal се вика САМО зад payerSuccessText!==null
 *        guard-а, установените normal coin/vip/bundle success пътища остават
 *        непроменени
 * [17] payerSuccessText: string | null присъства и в трите purchase snapshot
 *        типа (coin/vip/bundle) — продуктова паритетност
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server/DOM.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { LobbyScreenState } from '../src/app/lobby/renderLobbyScreen'
import {
  renderPaidGiftNotificationModal,
  renderPaidGiftPayerSuccessModal,
} from '../src/app/lobby/renderLobbyScreen'
import {
  composePayerCoinGiftSuccessText,
  composePayerVipGiftSuccessText,
  composePayerBundleGiftSuccessText,
  composeRecipientCoinGiftNotificationText,
  composeRecipientVipGiftNotificationText,
  composeRecipientBundleGiftNotificationText,
  formatBgThousands,
} from '../server/src/db/paidGiftNotificationText'

// bg-BG toLocaleString thousands separator е NON-BREAKING SPACE (U+00A0), не
// обикновен space — hardcoded "500 000" литерали в теста НЕ биха match-нали
// реалния изход. formatBgThousands е реалният production formatter, преизползван
// тук, за да строи очакваните substring-и с точния разделител (established
// pitfall, виж и yellowCoinGiftStore.ts formatBgNumber коментара).

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')
const RENDER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'renderLobbyScreen.ts')
const MAIN_PATH = join(REPO_ROOT, 'src', 'main.ts')
const NETWORK_CLIENT_PATH = join(REPO_ROOT, 'src', 'app', 'network', 'createGameServerClient.ts')

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

/** Извлича тялото на функция по signature prefix, чрез броене на скоби (mirror на checkTableGiftPresentation.ts). */
function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert(start !== -1, `не е намерена сигнатура: ${signature}`)
  const braceStart = source.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(braceStart, i + 1)
    }
  }
  throw new Error(`небалансирани скоби за: ${signature}`)
}

/** Извлича тяло на nested функция, декларирана вътре в createLobbyFlowController closure-а (2-space indent затваряща скоба, mirror на checkGiftItemNotificationQueue.ts). */
function extractNestedFunctionBody(src: string, signature: string, label: string): string {
  const startIdx = src.indexOf(signature)
  assert(startIdx !== -1, `${label}: сигнатура "${signature}" не е намерена`)
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf('\n  }')
  assert(endIdx !== -1, `${label}: край на функция не е намерен след "${signature}"`)
  return afterStart.slice(0, endIdx)
}

// ─── Load real source files once ───────────────────────────────────────────

const controllerSrc = await readFile(CONTROLLER_PATH, 'utf8')
const renderSrc = await readFile(RENDER_PATH, 'utf8')
const mainSrc = await readFile(MAIN_PATH, 'utf8')
const networkSrc = await readFile(NETWORK_CLIENT_PATH, 'utf8')

// Минимален mock — попълва само полетата, които renderPaidGiftNotificationModal/
// renderPaidGiftPayerSuccessModal реално четат (mirror на
// checkPaidGiftShopFrontendRendering.ts buildBaseState pattern-а).
function buildState(overrides: {
  paidGiftNotificationModal?: { purchaseId: string; purchaseType: 'coin' | 'vip' | 'bundle'; bodyText: string } | null
  paidGiftPayerSuccessModal?: { text: string } | null
}): LobbyScreenState {
  return {
    paidGiftNotificationModal: overrides.paidGiftNotificationModal ?? null,
    paidGiftPayerSuccessModal: overrides.paidGiftPayerSuccessModal ?? null,
  } as unknown as LobbyScreenState
}

console.log('\ncheckPaidGiftNotificationFrontend\n')

// ─── [1]-[3] Payer success copy (реалния server compose*, не hardcoded) ────

await check('[1] Payer coin gift success copy: "Вие успешно подарихте на X Y жълтици."', () => {
  const text = composePayerCoinGiftSuccessText('Иван Иванов', 500000)
  const html = renderPaidGiftPayerSuccessModal(buildState({ paidGiftPayerSuccessModal: { text } }))
  assert(html.includes('Вие успешно подарихте на Иван Иванов'), 'трябва да съдържа "Вие успешно подарихте на <recipient>"')
  assert(html.includes(`${formatBgThousands(500000)} жълтици`), 'трябва да съдържа bg-BG форматираната сума + "жълтици"')
  assert(html.includes('data-lobby-paid-gift-payer-success-ok="1"'), 'трябва да съдържа OK бутона')
})

await check('[2] Payer VIP gift success copy: "Вие успешно подарихте на X Y дни VIP."', () => {
  const text = composePayerVipGiftSuccessText('Мария Петрова', 30)
  const html = renderPaidGiftPayerSuccessModal(buildState({ paidGiftPayerSuccessModal: { text } }))
  assert(html.includes('Вие успешно подарихте на Мария Петрова'), 'трябва да съдържа recipient-а')
  assert(html.includes('30 дни VIP'), 'трябва да съдържа "<days> дни VIP"')
})

await check('[3] Payer bundle gift success copy: multi-line (title + coins + VIP), пазено чрез white-space:pre-line', () => {
  const text = composePayerBundleGiftSuccessText('Петър Георгиев', 'Супер пакет', 500000, 30)
  const html = renderPaidGiftPayerSuccessModal(buildState({ paidGiftPayerSuccessModal: { text } }))
  assert(html.includes('Вие успешно подарихте на Петър Георгиев'), 'първи ред: recipient-а')
  assert(html.includes(`Супер пакет — ${formatBgThousands(500000)} жълтици + 30 дни VIP.`), 'втори ред: title + coins + VIP, непроменен формат')
  assert(html.includes('white-space:pre-line'), 'контейнерът трябва да пази multi-line формата без <br> инжекция')
  assert(!html.includes('<br'), 'НЕ трябва ръчно да вкарва <br> тагове (pre-line го прави ненужно)')
  const firstLineIdx = html.indexOf('Петър Георгиев')
  const secondLineIdx = html.indexOf('Супер пакет')
  assert(firstLineIdx !== -1 && secondLineIdx !== -1 && firstLineIdx < secondLineIdx, 'редовете трябва да са в правилния ред')
})

// ─── [4]-[6] Recipient popup copy (реалния server compose*) ────────────────

await check('[4] Recipient coin popup copy: "X ви подари Y жълтици."', () => {
  const bodyText = composeRecipientCoinGiftNotificationText('Георги Николов', 250000)
  const html = renderPaidGiftNotificationModal(buildState({
    paidGiftNotificationModal: { purchaseId: 'cp-1', purchaseType: 'coin', bodyText },
  }))
  assert(html.includes(`Георги Николов ви подари ${formatBgThousands(250000)} жълтици.`), 'трябва да показва точния recipient notification текст')
  assert(html.includes('data-lobby-paid-gift-notification-ok="1"'), 'трябва да съдържа OK бутона')
  assert(!html.includes('лв.') && !html.includes('€'), 'recipient НЕ трябва да вижда цена')
})

await check('[5] Recipient VIP popup copy: "X ви подари Y дни VIP."', () => {
  const bodyText = composeRecipientVipGiftNotificationText('Стефан Тодоров', 7)
  const html = renderPaidGiftNotificationModal(buildState({
    paidGiftNotificationModal: { purchaseId: 'vp-1', purchaseType: 'vip', bodyText },
  }))
  assert(html.includes('Стефан Тодоров ви подари 7 дни VIP.'), 'трябва да показва точния recipient notification текст')
})

await check('[6] Recipient bundle popup copy: multi-line, аналогично на payer bundle', () => {
  const bodyText = composeRecipientBundleGiftNotificationText('Николай Христов', 'Мега пакет', 1000000, 60)
  const html = renderPaidGiftNotificationModal(buildState({
    paidGiftNotificationModal: { purchaseId: 'bp-1', purchaseType: 'bundle', bodyText },
  }))
  assert(html.includes('Николай Христов ви подари:'), 'първи ред')
  assert(html.includes(`Мега пакет — ${formatBgThousands(1000000)} жълтици + 60 дни VIP.`), 'втори ред')
  assert(html.includes('white-space:pre-line'), 'multi-line формат пазен без <br>')
})

// ─── [7] EUR-only / §15 no-price-leakage regression ────────────────────────

await check('[7] EUR-only + §15: НИТО payer success, НИТО recipient notification показват цена', () => {
  const payerTexts = [
    composePayerCoinGiftSuccessText('Тест', 100000),
    composePayerVipGiftSuccessText('Тест', 30),
    composePayerBundleGiftSuccessText('Тест', 'Пакет', 100000, 30),
  ]
  for (const text of payerTexts) {
    const html = renderPaidGiftPayerSuccessModal(buildState({ paidGiftPayerSuccessModal: { text } }))
    assert(!html.includes('лв.'), 'payer success modal НЕ трябва да съдържа "лв."')
    assert(!html.includes('€'), 'payer success modal НЕ трябва да съдържа "€"')
    assert(!html.includes('EUR'), 'payer success modal НЕ трябва да съдържа "EUR"')
  }

  const recipientTexts: Array<{ purchaseType: 'coin' | 'vip' | 'bundle'; bodyText: string }> = [
    { purchaseType: 'coin', bodyText: composeRecipientCoinGiftNotificationText('Тест', 100000) },
    { purchaseType: 'vip', bodyText: composeRecipientVipGiftNotificationText('Тест', 30) },
    { purchaseType: 'bundle', bodyText: composeRecipientBundleGiftNotificationText('Тест', 'Пакет', 100000, 30) },
  ]
  for (const entry of recipientTexts) {
    const html = renderPaidGiftNotificationModal(buildState({
      paidGiftNotificationModal: { purchaseId: 'x', purchaseType: entry.purchaseType, bodyText: entry.bodyText },
    }))
    assert(!html.includes('лв.'), `recipient notification (${entry.purchaseType}) НЕ трябва да съдържа "лв."`)
    assert(!html.includes('€'), `recipient notification (${entry.purchaseType}) НЕ трябва да съдържа "€"`)
    assert(!html.includes('EUR'), `recipient notification (${entry.purchaseType}) НЕ трябва да съдържа "EUR"`)
  }
})

// ─── [8] HTML-escaping regression ───────────────────────────────────────────

await check('[8] bodyText/text минават през escapeHtml — embedded markup не се inject-ва суров', () => {
  const maliciousBodyText = '<img src=x onerror=alert(1)>ви подари 1 жълтица.'
  const html = renderPaidGiftNotificationModal(buildState({
    paidGiftNotificationModal: { purchaseId: 'x', purchaseType: 'coin', bodyText: maliciousBodyText },
  }))
  assert(!html.includes('<img src=x onerror=alert(1)>'), 'суров HTML не трябва да оцелее escape-нат')
  assert(html.includes('&lt;img'), 'трябва да е escape-нат до &lt;img')

  const maliciousText = '<script>alert(1)</script>'
  const successHtml = renderPaidGiftPayerSuccessModal(buildState({ paidGiftPayerSuccessModal: { text: maliciousText } }))
  assert(!successHtml.includes('<script>alert(1)</script>'), 'payer success text също трябва да е escape-нат')
  assert(successHtml.includes('&lt;script&gt;'), 'трябва да е escape-нат до &lt;script&gt;')
})

// ─── [9] Item Gift System остава ОТДЕЛЕН domain ────────────────────────────

await check('[9] Item Gift System остава напълно отделен domain (различни data атрибути, без кръстосано рефериране)', () => {
  const paidGiftHtml = renderPaidGiftNotificationModal(buildState({
    paidGiftNotificationModal: { purchaseId: 'x', purchaseType: 'coin', bodyText: 'Тест ви подари 1 жълтица.' },
  }))
  assert(!paidGiftHtml.includes('data-lobby-gift-item-received-ok'), 'paid gift notification НЕ трябва да реферира item-gift data атрибута')

  const itemGiftFn = extractFunctionBody(renderSrc, 'function renderGiftItemReceivedModal(state: LobbyScreenState): string {')
  assert(itemGiftFn.includes('data-lobby-gift-item-received-ok'), 'item gift received modal-ът трябва да пази собствения си data атрибут')
  assert(!itemGiftFn.includes('data-lobby-paid-gift-notification-ok'), 'item gift received modal НЕ трябва да реферира paid-gift data атрибута')
  assert(!itemGiftFn.includes('paidGiftNotificationModal'), 'item gift received modal НЕ трябва да чете paidGiftNotificationModal state')

  const paidGiftFn = extractFunctionBody(renderSrc, 'export function renderPaidGiftNotificationModal(state: LobbyScreenState): string {')
  assert(!paidGiftFn.includes('giftItemReceivedModal'), 'renderPaidGiftNotificationModal НЕ трябва да чете giftItemReceivedModal state')
  assert(!paidGiftFn.includes('giftReceivedModal'), 'renderPaidGiftNotificationModal НЕ трябва да чете (стария) giftReceivedModal state')

  const payerSuccessFn = extractFunctionBody(renderSrc, 'export function renderPaidGiftPayerSuccessModal(state: LobbyScreenState): string {')
  assert(!payerSuccessFn.includes('giftSuccessModal'), 'renderPaidGiftPayerSuccessModal НЕ трябва да чете established giftSuccessModal state')
})

// ─── Part B: queue harness (mirror ТОЧНО на createLobbyFlowController.ts) ──
//
// Реimplementира ТОЧНО същия dedup (queue + активен модал) + FIFO
// push/shift + single-active-modal guard + late presentation-routing
// algorithm, за да упражни поведенческите сценарии [10]-[13].

type Entry = { purchaseId: string; purchaseType: 'coin' | 'vip' | 'bundle'; bodyText: string }

function createQueueHarness(getIsInGame: () => boolean = () => false) {
  const state = {
    paidGiftNotificationQueue: [] as Entry[],
    paidGiftNotificationModal: null as Entry | null,
  }
  const ackLog: Array<{ purchaseId: string; purchaseType: string }> = []
  const presentationLog: Array<'modal' | 'banner'> = []

  function showNext(): void {
    if (state.paidGiftNotificationModal !== null) return
    const next = state.paidGiftNotificationQueue.shift()
    if (!next) return
    state.paidGiftNotificationModal = next
    presentationLog.push(getIsInGame() ? 'banner' : 'modal')
  }

  function enqueue(items: Entry[]): void {
    if (items.length === 0) return
    const activeKey = state.paidGiftNotificationModal
      ? `${state.paidGiftNotificationModal.purchaseType}:${state.paidGiftNotificationModal.purchaseId}`
      : null
    const queuedKeys = new Set(state.paidGiftNotificationQueue.map((q) => `${q.purchaseType}:${q.purchaseId}`))
    for (const item of items) {
      const key = `${item.purchaseType}:${item.purchaseId}`
      if (key === activeKey || queuedKeys.has(key)) continue
      queuedKeys.add(key)
      state.paidGiftNotificationQueue.push(item)
    }
    showNext()
  }

  function complete(): void {
    const notification = state.paidGiftNotificationModal
    state.paidGiftNotificationModal = null
    if (notification) {
      ackLog.push({ purchaseId: notification.purchaseId, purchaseType: notification.purchaseType })
    }
    showNext()
  }

  return { state, enqueue, complete, ackLog, presentationLog }
}

function entry(purchaseId: string, purchaseType: 'coin' | 'vip' | 'bundle' = 'coin', bodyText?: string): Entry {
  return { purchaseId, purchaseType, bodyText: bodyText ?? `Подарък ${purchaseId}` }
}

// ─── [10] Duplicate notification id НЕ enqueue-ва duplicate popup ──────────

await check('[10] Duplicate purchaseId+purchaseType (offline bootstrap + realtime race) НЕ enqueue-ва duplicate popup', () => {
  const h = createQueueHarness()

  // Сценарий А: duplicate спрямо ВЕЧЕ АКТИВНИЯ модал (bootstrap fetch и
  // realtime push пристигат почти едновременно за СЪЩИЯ notification).
  h.enqueue([entry('cp-1', 'coin')])
  assertEqual(h.state.paidGiftNotificationModal?.purchaseId, 'cp-1', 'cp-1 е активният модал')
  h.enqueue([entry('cp-1', 'coin')]) // race duplicate — вторият enqueue е no-op
  assertEqual(h.state.paidGiftNotificationQueue.length, 0, 'duplicate-ът НЕ трябва да влезе в опашката')

  // Сценарий Б: duplicate спрямо ВЕЧЕ ОПАШКУВАН (но още непоказан) notification.
  h.enqueue([entry('vp-1', 'vip'), entry('bp-1', 'bundle')])
  assertEqual(h.state.paidGiftNotificationQueue.length, 2, 'vp-1 и bp-1 чакат в опашката')
  h.enqueue([entry('vp-1', 'vip')]) // duplicate на вече-опашкуван notification
  assertEqual(h.state.paidGiftNotificationQueue.length, 2, 'duplicate-ът на опашкуван notification НЕ трябва да добави втори запис')

  // Различен purchaseType със СЪЩИЯ purchaseId литерал е РАЗЛИЧЕН key —
  // dedup-ът explicit включва purchaseType в ключа, не само purchaseId.
  h.enqueue([entry('cp-1', 'vip')])
  assertEqual(h.state.paidGiftNotificationQueue.length, 3, 'различен purchaseType със същия purchaseId литерал НЕ се третира като duplicate')
})

// ─── [11] Multiple notifications се показват sequentially ──────────────────

await check('[11] Multiple notifications (coin+VIP+bundle mixed) се показват sequentially, FIFO ред', () => {
  const h = createQueueHarness()
  h.enqueue([entry('cp-1', 'coin'), entry('vp-1', 'vip'), entry('bp-1', 'bundle')])

  assertEqual(h.state.paidGiftNotificationModal?.purchaseId, 'cp-1', 'първият (coin) се показва първи')
  assertEqual(h.state.paidGiftNotificationQueue.length, 2, 'останалите 2 чакат')

  h.complete()
  assertEqual(h.state.paidGiftNotificationModal?.purchaseId, 'vp-1', 'вторият (VIP) следва БЕЗ logout/login')

  h.complete()
  assertEqual(h.state.paidGiftNotificationModal?.purchaseId, 'bp-1', 'третият (bundle) следва последен')

  h.complete()
  assertEqual(h.state.paidGiftNotificationModal, null, 'няма повече popup-и след bp-1')
  assertEqual(h.ackLog.map((a) => a.purchaseId), ['cp-1', 'vp-1', 'bp-1'], 'ACK-нати в правилния FIFO ред, по един път всеки')
})

// ─── [12] OK ACK-ва ТОЧНО активната notification ────────────────────────────

await check('[12] OK бутонът ACK-ва ТОЧНО активната notification (purchaseId+purchaseType), никога stale id', () => {
  const h = createQueueHarness()
  h.enqueue([entry('cp-1', 'coin'), entry('vp-2', 'vip')])

  h.complete() // затваря cp-1, показва vp-2
  assertEqual(h.ackLog, [{ purchaseId: 'cp-1', purchaseType: 'coin' }], 'ACK-ва cp-1 (активния в момента на затваряне), не vp-2 (следващия)')
  assertEqual(h.state.paidGiftNotificationModal?.purchaseId, 'vp-2', 'vp-2 е сега активен, но ОЩЕ не е ACK-нат')

  h.complete() // затваря vp-2
  assertEqual(h.ackLog, [
    { purchaseId: 'cp-1', purchaseType: 'coin' },
    { purchaseId: 'vp-2', purchaseType: 'vip' },
  ], 'вторият ACK е за vp-2, точно по един ACK на всеки notification')

  // Source-text: completeCurrentPaidGiftNotification трябва да прочете
  // notification-a ПРЕДИ да нулира state.paidGiftNotificationModal (иначе
  // би ACK-нал undefined/грешен id).
  const completeFn = extractNestedFunctionBody(controllerSrc, 'function completeCurrentPaidGiftNotification(): void {', 'completeCurrentPaidGiftNotification')
  const readIdx = completeFn.indexOf('const notification = state.paidGiftNotificationModal')
  const nullIdx = completeFn.indexOf('state.paidGiftNotificationModal = null')
  const ackIdx = completeFn.indexOf('options.onAcknowledgePaidGiftNotification?.(notification.purchaseId, notification.purchaseType)')
  assert(readIdx !== -1 && nullIdx !== -1 && ackIdx !== -1, 'трябва да съдържа read/null/ack стъпките')
  assert(readIdx < nullIdx, 'notification-ът трябва да се прочете ПРЕДИ да се нулира state полето')
  assert(ackIdx > nullIdx, 'ACK-ът минава по прочетената референция, СЛЕД нулирането (не презаписва state отново)')
})

// ─── [13] Active-game routing: решение при показване, не при enqueue ───────

await check('[13] Recipient popup може да се render-не при активна игра — routing при ПОКАЗВАНЕ, не при enqueue', () => {
  const inGameHarness = createQueueHarness(() => true)
  inGameHarness.enqueue([entry('cp-1', 'coin')])
  assertEqual(inGameHarness.presentationLog, ['banner'], 'докато потребителят играе, notification-ът се показва като in-game banner, НЕ се drop-ва')

  const lobbyHarness = createQueueHarness(() => false)
  lobbyHarness.enqueue([entry('cp-1', 'coin')])
  assertEqual(lobbyHarness.presentationLog, ['modal'], 'извън игра се показва обичайният lobby модал')

  // Source-text: routing решението (getIsInGame) е ВЪТРЕ в showNext, НЕ в enqueue.
  const showNextFn = extractNestedFunctionBody(controllerSrc, 'function showNextPaidGiftNotification(): void {', 'showNextPaidGiftNotification')
  assert(showNextFn.includes('options.getIsInGame?.()'), 'showNext трябва да чете актуалния in-game статус')
  assert(showNextFn.includes('showPaidGiftNotificationBanner('), 'в игра трябва да покаже banner')
  assert(showNextFn.indexOf('showPaidGiftNotificationBanner(') < showNextFn.lastIndexOf('render()'), 'banner пътят трябва да върне ПРЕДИ обичайния lobby render()')

  const enqueueFn = extractNestedFunctionBody(controllerSrc, 'function enqueuePaidGiftNotifications(items: PaidGiftNotificationEntry[]): void {', 'enqueuePaidGiftNotifications')
  assert(!enqueueFn.includes('getIsInGame'), 'presentation routing НЕ трябва да се решава при enqueue — иначе notification, пристигнал докато потребителят е в лоби, но показан по-късно докато играе (или обратно), би получил грешен route')

  // Реалният realtime handler не трябва да guard-ва enqueue-а по in-game
  // статус (само presentation-ът, вътре в showNext, зависи от него) —
  // recipient трябва да получи notification дори по време на активна игра
  // (currentRoomId===null filter вече е премахнат, established review §16.13
  // изискване, потвърдено server-side в checkPaidGiftNotificationRealtimeDelivery.ts).
  const realtimeHandlerIdx = controllerSrc.indexOf(`message.type === 'paid_gift_notification_received'`)
  assert(realtimeHandlerIdx !== -1, 'realtime handler-ът трябва да съществува')
  const realtimeHandlerBlock = controllerSrc.slice(realtimeHandlerIdx, realtimeHandlerIdx + 400)
  assert(!realtimeHandlerBlock.includes('getIsInGame'), 'realtime handler-ът не трябва да guard-ва enqueue-а по in-game статус')
})

// ─── [14] Queue wiring source-text ──────────────────────────────────────────

await check('[14] enqueuePaidGiftNotifications push-ва в опашката (dedup срещу опашка И активен модал) + вика showNext', () => {
  const fn = extractNestedFunctionBody(controllerSrc, 'function enqueuePaidGiftNotifications(items: PaidGiftNotificationEntry[]): void {', 'enqueuePaidGiftNotifications')
  assert(fn.includes('state.paidGiftNotificationModal'), 'трябва да сравни срещу текущо активния модал (activeKey)')
  assert(fn.includes('state.paidGiftNotificationQueue.push'), 'трябва да push-ва в paidGiftNotificationQueue')
  assert(fn.includes('showNextPaidGiftNotification()'), 'трябва да вика showNextPaidGiftNotification след push')
})

await check('[14b] showNextPaidGiftNotification guard-ва single-active-modal (без overlay collision)', () => {
  const fn = extractNestedFunctionBody(controllerSrc, 'function showNextPaidGiftNotification(): void {', 'showNextPaidGiftNotification')
  assert(fn.includes('if (state.paidGiftNotificationModal !== null) return'), 'трябва да early-return-ва ако вече има активен модал')
  assert(fn.includes('state.paidGiftNotificationQueue.shift()'), 'трябва да shift-ва (FIFO), не pop (LIFO)')
})

await check('[15] pending_paid_gift_notifications (offline bootstrap) enqueue-ва ЦЕЛИЯ масив', () => {
  const idx = controllerSrc.indexOf(`message.type === 'pending_paid_gift_notifications'`)
  assert(idx !== -1, 'handler-ът трябва да съществува')
  const block = controllerSrc.slice(idx, idx + 500)
  assert(block.includes('enqueuePaidGiftNotifications('), 'offline bootstrap handler-ът трябва да вика enqueuePaidGiftNotifications')
  assert(block.includes('message.notifications.map'), 'трябва да мапне ЦЕЛИЯ message.notifications масив')
})

await check('[16] paid_gift_notification_received (realtime push) enqueue-ва в СЪЩАТА опашка като offline bootstrap-а', () => {
  const idx = controllerSrc.indexOf(`message.type === 'paid_gift_notification_received'`)
  assert(idx !== -1, 'РЕГРЕСИЯ: paid_gift_notification_received handler липсва — realtime notification никога няма да покаже popup')
  const block = controllerSrc.slice(idx, idx + 400)
  assert(block.includes('enqueuePaidGiftNotifications('), 'realtime handler-ът трябва да enqueue-ва в СЪЩАТА опашка като offline bootstrap-а')
})

// ─── [17] Desktop + Mobile wiring (adjacency check, mirror на другите модали) ──

await check('[17] Модалите са wired в ДВЕТЕ layout клона на renderLobbyScreen (desktop + mobile)', () => {
  const notifOccurrences = renderSrc.split('${renderPaidGiftNotificationModal(state)}').length - 1
  const successOccurrences = renderSrc.split('${renderPaidGiftPayerSuccessModal(state)}').length - 1
  assertEqual(notifOccurrences, 2, 'renderPaidGiftNotificationModal трябва да се вика точно в двата layout клона (mobile + desktop)')
  assertEqual(successOccurrences, 2, 'renderPaidGiftPayerSuccessModal трябва да се вика точно в двата layout клона (mobile + desktop)')

  // И двете двойки трябва да са в established модал-stack реда:
  // ...gift-item-received -> paid-gift-notification -> paid-gift-payer-success -> image-viewer...
  const pattern = /\$\{renderGiftItemReceivedModal\(state\)\}\s*\$\{renderPaidGiftNotificationModal\(state\)\}\s*\$\{renderPaidGiftPayerSuccessModal\(state\)\}\s*\$\{renderImageViewerOverlay\(state\)\}/g
  const matches = renderSrc.match(pattern)
  assert(matches !== null && matches.length === 2, 'ordering-ът трябва да е идентичен и в двата layout клона (без desktop/mobile divergence)')

  assert(renderSrc.includes(`.querySelector<HTMLButtonElement>('[data-lobby-paid-gift-notification-ok="1"]')`), 'recipient popup OK бутонът трябва да е wired')
  assert(renderSrc.includes(`.querySelector<HTMLButtonElement>('[data-lobby-paid-gift-payer-success-ok="1"]')`), 'payer success OK бутонът трябва да е wired')
})

// ─── [18] Normal Shop покупка НИКОГА не влиза в notification flow ──────────

await check('[18] Normal (non-gift) Shop покупка НЕ влиза в paid gift notification flow — payerSuccessText!==null guard', () => {
  const guardIdx = mainSrc.indexOf('if (resolved.purchase.payerSuccessText !== null) {')
  assert(guardIdx !== -1, 'трябва да съществува explicit payerSuccessText!==null guard')

  const coinIdx = mainSrc.indexOf(`if (resolved.kind === 'coin') {`, guardIdx)
  const bundleIdx = mainSrc.indexOf(`if (resolved.kind === 'bundle') {`, guardIdx)
  assert(coinIdx !== -1 && bundleIdx !== -1, 'established normal coin/bundle success branches трябва да съществуват СЛЕД guard-а')
  assert(guardIdx < coinIdx && guardIdx < bundleIdx, 'gift guard-ът трябва да е ПРЕДИ established normal success пътищата (early return при gift)')

  const guardBlock = mainSrc.slice(guardIdx, coinIdx)
  const showModalIdx = guardBlock.indexOf('lobby.showPaidGiftPayerSuccessModal(resolved.purchase.payerSuccessText)')
  assert(showModalIdx !== -1, 'guard-ът трябва да вика showPaidGiftPayerSuccessModal')
  // CRLF line endings в main.ts (\r\n) — сравняваме позиции вместо literal
  // "\n    return\n", за да не зависим от конкретния line-ending стил.
  const returnIdx = guardBlock.indexOf('return', showModalIdx)
  assert(returnIdx !== -1 && returnIdx > showModalIdx, 'guard-ът трябва да return-не СЛЕД showPaidGiftPayerSuccessModal (не fall-through към normal success UI)')

  // showPaidGiftPayerSuccessModal не трябва да се вика извън тоя единствен guard.
  const allCallSites = mainSrc.split('lobby.showPaidGiftPayerSuccessModal(').length - 1
  assertEqual(allCallSites, 1, 'showPaidGiftPayerSuccessModal трябва да се вика от ЕДНО-единствено място (guard-нат зад payerSuccessText!==null)')

  // Established normal coin/bundle success пътищата остават непроменени.
  const coinBlock = mainSrc.slice(coinIdx, mainSrc.indexOf('\n  }\n', coinIdx))
  assert(!coinBlock.includes('paidGift'), 'established normal coin success path НЕ трябва да реферира paid-gift state/modal')
  const bundleBlock = mainSrc.slice(bundleIdx, mainSrc.indexOf('\n  }\n', bundleIdx))
  assert(!bundleBlock.includes('paidGift'), 'established normal bundle success path НЕ трябва да реферира paid-gift state/modal')
})

// ─── [19] payerSuccessText продуктова паритетност (coin/VIP/bundle) ────────

await check('[19] payerSuccessText: string | null присъства и в трите purchase snapshot типа', () => {
  const occurrences = networkSrc.split('payerSuccessText: string | null').length - 1
  assert(occurrences >= 3, `payerSuccessText трябва да присъства в поне 3 snapshot типа (coin/VIP/bundle), намерени: ${occurrences}`)
})

// ─── Резултат ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
