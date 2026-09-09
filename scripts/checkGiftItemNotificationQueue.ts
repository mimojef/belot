/**
 * checkGiftItemNotificationQueue.ts
 *
 * Regression checks за offline/realtime gift-item notification queue fix.
 *
 * Root cause (виж createLobbyFlowController.ts коментарите при
 * giftItemNotificationQueue): преди фикса `pending_gift_item_notifications`
 * презаписваше state.pendingGiftItemNotifications с целия масив, но само
 * message.deliveries[0] влизаше в giftItemReceivedModal — нищо не consume-
 * ваше остатъка след затваряне на popup-а, затова потребителят трябваше да
 * logout/login отново за всеки следващ подарък. Отделно, `gift_item_received`
 * (realtime push, получателят е online) нямаше handler изобщо.
 *
 * Част А (поведенчески): реimplementира ТОЧНО същия FIFO
 * push/shift + single-active-modal guard algorithm като production кода и
 * го тества директно срещу Scenarios A-F от брифа.
 *
 * Част Б (source-text): потвърждава, че реалният
 * src/app/lobby/createLobbyFlowController.ts действително wire-ва
 * enqueueGiftItemNotifications/showNextGiftItemNotification/
 * completeCurrentGiftItemNotification на правилните места — регрес guard
 * ако някой бъдещ рефакторинг счупи wiring-а, без да чупи самия algorithm.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server/DOM.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

// ─── Част А: FIFO queue harness (mirror на createLobbyFlowController.ts) ──
// Идентичен algorithm на enqueueGiftItemNotifications/
// showNextGiftItemNotification/completeCurrentGiftItemNotification — не
// import-ва controller-а директно (той е браузърен модул с DOM/WS
// зависимости), но replicate-ва ТОЧНО същата push/shift + single-active
// guard логика, за да упражни поведенческите сценарии от брифа.
type Entry = { transactionId: string; itemName: string; imageUrl: string; fromDisplayName: string }

function createQueueHarness() {
  const state = {
    giftItemNotificationQueue: [] as Entry[],
    giftItemReceivedModal: null as Entry | null,
  }
  const shownLog: string[] = []

  function showNext(): void {
    if (state.giftItemReceivedModal !== null) return
    const next = state.giftItemNotificationQueue.shift()
    if (!next) return
    state.giftItemReceivedModal = next
  }

  function enqueue(items: Entry[]): void {
    if (items.length === 0) return
    state.giftItemNotificationQueue.push(...items)
    showNext()
  }

  function complete(): void {
    const delivery = state.giftItemReceivedModal
    state.giftItemReceivedModal = null
    if (delivery) {
      shownLog.push(delivery.transactionId)
    }
    showNext()
  }

  return { state, enqueue, complete, shownLog }
}

function entry(transactionId: string, fromDisplayName: string = 'Sender'): Entry {
  return { transactionId, itemName: `Item ${transactionId}`, imageUrl: `/uploads/gift-items/${transactionId}.webp`, fromDisplayName }
}

console.log('\n=== Gift Item Notification Queue Checks ===\n')

// ── Scenario A: един sender, 3 подаръка, offline batch при login ─────────
await check('[A] Един sender -> 3 подаръка offline batch: всичките 3 се доставят последователно, без overlay collision', () => {
  const h = createQueueHarness()

  // WS connect flush — целият batch идва наведнъж (pending_gift_item_notifications).
  h.enqueue([entry('tx-a1'), entry('tx-a2'), entry('tx-a3')])

  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-a1', 'първият popup показва gift 1')
  assertEqual(h.state.giftItemNotificationQueue.length, 2, 'останалите 2 чакат в опашката')

  h.complete()
  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-a2', 'след затваряне на gift 1 се показва gift 2 БЕЗ logout/login')
  assertEqual(h.state.giftItemNotificationQueue.length, 1, '1 остава в опашката')

  h.complete()
  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-a3', 'след gift 2 се показва gift 3')
  assertEqual(h.state.giftItemNotificationQueue.length, 0, 'опашката е празна')

  h.complete()
  assertEqual(h.state.giftItemReceivedModal, null, 'няма повече popup-и след gift 3')
  assertEqual(h.shownLog, ['tx-a1', 'tx-a2', 'tx-a3'], 'mark-shown извикан точно 3 пъти, в правилния ред')
})

// ── Scenario B: 3 различни sender-а, един offline recipient ──────────────
await check('[B] 3 различни sender-а -> един offline recipient: всичките 3 се доставят', () => {
  const h = createQueueHarness()
  h.enqueue([entry('tx-b1', 'Sender One'), entry('tx-b2', 'Sender Two'), entry('tx-b3', 'Sender Three')])

  assertEqual(h.state.giftItemReceivedModal?.fromDisplayName, 'Sender One', 'първи sender се показва първи')
  h.complete()
  assertEqual(h.state.giftItemReceivedModal?.fromDisplayName, 'Sender Two', 'втори sender се показва след първия')
  h.complete()
  assertEqual(h.state.giftItemReceivedModal?.fromDisplayName, 'Sender Three', 'трети sender се показва след втория')
  h.complete()
  assertEqual(h.shownLog.length, 3, 'всичките 3 различни sender-и са markнати shown')
})

// ── Scenario C: 3 еднакви подаръка от един sender — БЕЗ dedup ────────────
await check('[C] Един sender изпраща 3 еднакви подаръка: 3 отделни notifications, никакъв dedup', () => {
  const h = createQueueHarness()
  // Три РАЗЛИЧНИ transaction_id (всеки gift е отделно събитие), но
  // ИДЕНТИЧНИ item/sender данни — точно "3 еднакви подаръка" сценария.
  const sameItemName = 'Роза'
  const sameSender = 'Same Sender'
  const sameImage = '/uploads/gift-items/rose.webp'
  h.enqueue([
    { transactionId: 'tx-c1', itemName: sameItemName, imageUrl: sameImage, fromDisplayName: sameSender },
    { transactionId: 'tx-c2', itemName: sameItemName, imageUrl: sameImage, fromDisplayName: sameSender },
    { transactionId: 'tx-c3', itemName: sameItemName, imageUrl: sameImage, fromDisplayName: sameSender },
  ])

  assertEqual(h.state.giftItemNotificationQueue.length + 1, 3, 'нищо не е collapse-нато — 3 items общо (1 активен + 2 в опашка)')
  h.complete()
  h.complete()
  h.complete()
  assertEqual(h.shownLog, ['tx-c1', 'tx-c2', 'tx-c3'], 'и трите еднакви подаръка са показани и markнати shown поотделно')
})

// ── Scenario D: само текущо показаният е shown, останалите остават pending до реален show ──
await check('[D] След показване на gift 1: само gift 1 е shown, gift 2/3 остават pending до реалното им показване', () => {
  const h = createQueueHarness()
  h.enqueue([entry('tx-d1'), entry('tx-d2'), entry('tx-d3')])

  assertEqual(h.shownLog, [], 'нищо не е markнато shown само защото е enqueue-нато/push-нато по WS')
  h.complete()
  assertEqual(h.shownLog, ['tx-d1'], 'само gift 1 е markнат shown след неговото приключване')
  assertEqual(h.state.giftItemNotificationQueue.map((e) => e.transactionId), ['tx-d3'], 'gift 3 все още чака, gift 2 вече е active модал')
  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-d2', 'gift 2 е активният модал, но ОЩЕ не е shown')
})

// ── Scenario E: disconnect по средата — client queue се губи, но in-flight active модал не се markва shown ──
await check('[E] Disconnect след gift 1 (преди gift 2 да е complete-нат): само gift 1 е markнат shown', () => {
  const h = createQueueHarness()
  h.enqueue([entry('tx-e1'), entry('tx-e2'), entry('tx-e3')])
  h.complete() // gift 1 shown, gift 2 е сега active модал

  // Симулира disconnect ТОЧНО тук — client in-memory state (queue + active
  // modal) се губи при page reload/reconnect, но НИКОЙ mark-shown request
  // не е изпратен за gift 2/3 (те никога не са минали през complete()).
  assertEqual(h.shownLog, ['tx-e1'], 'при disconnect след gift 1, само gift 1 е бил markнат shown')

  // При следващ connect, сървърът пак праща pending batch — само gift 2/3
  // (gift 1 вече shown_at != NULL в DB, значи selectPendingDeliveriesStatement
  // вече не го връща). Симулираме fresh harness за "новата сесия".
  const h2 = createQueueHarness()
  h2.enqueue([entry('tx-e2'), entry('tx-e3')]) // сървърът НЕ праща tx-e1 отново
  assertEqual(h2.state.giftItemReceivedModal?.transactionId, 'tx-e2', 'gift 2 се възстановява при следващия connect')
  h2.complete()
  assertEqual(h2.state.giftItemReceivedModal?.transactionId, 'tx-e3', 'gift 3 се възстановява след gift 2')
  h2.complete()
  assertEqual(h2.shownLog, ['tx-e2', 'tx-e3'], 'gift 1 НЕ се повтаря във втората сесия')
})

// ── Scenario F: realtime gift пристига докато offline queue се показва ───
await check('[F] Realtime gift по време на pending queue се append-ва СЛЕД текущата опашка, без overlay collision', () => {
  const h = createQueueHarness()
  // Login: pending batch A1, A2, A3.
  h.enqueue([entry('tx-a1'), entry('tx-a2'), entry('tx-a3')])
  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-a1', 'A1 се показва първи')

  // Докато потребителят гледа A1, идва realtime push B1 (gift_item_received).
  h.enqueue([entry('tx-b1', 'Realtime Sender')])

  // B1 НЕ трябва да презапише текущия активен модал (no overlay collision).
  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-a1', 'A1 остава активният модал, B1 не го измества')
  assertEqual(
    h.state.giftItemNotificationQueue.map((e) => e.transactionId),
    ['tx-a2', 'tx-a3', 'tx-b1'],
    'редът е A2 -> A3 -> B1 (B1 добавен СЛЕД съществуващата опашка, canonical received ordering)',
  )

  h.complete()
  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-a2', 'A2 следващ')
  h.complete()
  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-a3', 'A3 следващ')
  h.complete()
  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-b1', 'B1 показан последен, след цялата offline опашка')
  h.complete()
  assertEqual(h.shownLog, ['tx-a1', 'tx-a2', 'tx-a3', 'tx-b1'], 'пълен ред: A1 -> A2 -> A3 -> B1')
})

// ── Never more than one active modal at a time (structural invariant) ────
await check('[Invariant] Никога повече от 1 активен giftItemReceivedModal едновременно', () => {
  const h = createQueueHarness()
  h.enqueue([entry('tx-x1'), entry('tx-x2')])
  // Втори enqueue докато x1 е активен — showNext() вътре в enqueue() е no-op
  // заради (state.giftItemReceivedModal !== null) guard-а.
  h.enqueue([entry('tx-x3')])
  assertEqual(h.state.giftItemReceivedModal?.transactionId, 'tx-x1', 'единственият активен модал остава x1')
  assertEqual(h.state.giftItemNotificationQueue.length, 2, 'x2 и x3 чакат в опашката, не се показват едновременно')
})

// ─── Част Б: source-text wiring verification ───────────────────────────────

const controllerSrc = await readFile(CONTROLLER_PATH, 'utf8')

function extractNestedFunctionBody(src: string, signature: string, label: string): string {
  const startIdx = src.indexOf(signature)
  assert(startIdx !== -1, `${label}: сигнатура "${signature}" не е намерена`)
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf('\n  }')
  assert(endIdx !== -1, `${label}: край на функция не е намерен след "${signature}"`)
  return afterStart.slice(0, endIdx)
}

function extractBlock(src: string, startMarker: string, label: string): string {
  const startIdx = src.indexOf(startMarker)
  assert(startIdx !== -1, `${label}: маркер "${startMarker}" не е намерен`)
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf('\n      },')
  assert(endIdx !== -1, `${label}: край на блок не е намерен след "${startMarker}"`)
  return afterStart.slice(0, endIdx)
}

await check('[G1] enqueueGiftItemNotifications съществува и push-ва в опашката + вика showNext', () => {
  const fn = extractNestedFunctionBody(controllerSrc, 'function enqueueGiftItemNotifications(', 'enqueueGiftItemNotifications')
  assert(fn.includes('state.giftItemNotificationQueue.push'), 'трябва да push-ва в giftItemNotificationQueue')
  assert(fn.includes('showNextGiftItemNotification()'), 'трябва да вика showNextGiftItemNotification след push')
})

await check('[G2] showNextGiftItemNotification guard-ва срещу overlay collision (single active modal)', () => {
  const fn = extractNestedFunctionBody(controllerSrc, 'function showNextGiftItemNotification(', 'showNextGiftItemNotification')
  assert(fn.includes('if (state.giftItemReceivedModal !== null) return'), 'трябва да early-return-ва ако вече има активен модал')
  assert(fn.includes('state.giftItemNotificationQueue.shift()'), 'трябва да shift-ва (FIFO, не pop/LIFO) от опашката')
})

await check('[G3] completeCurrentGiftItemNotification маркира shown ЕДИНСТВЕНО текущия, после показва следващия', () => {
  const fn = extractNestedFunctionBody(controllerSrc, 'function completeCurrentGiftItemNotification(', 'completeCurrentGiftItemNotification')
  assert(fn.includes('state.giftItemReceivedModal = null'), 'трябва да нулира текущия активен модал')
  assert(fn.includes('onMarkGiftItemDeliveryShown'), 'трябва да вика onMarkGiftItemDeliveryShown за текущия delivery')
  assert(fn.includes('showNextGiftItemNotification()'), 'трябва да продължи към следващия в опашката')
})

await check('[G4] onGiftItemReceivedClose (X/OK бутон) минава през completeCurrentGiftItemNotification, не ad-hoc nulling', () => {
  const block = extractBlock(controllerSrc, 'onGiftItemReceivedClose: () => {', 'onGiftItemReceivedClose')
  assert(block.includes('completeCurrentGiftItemNotification()'), 'затварянето (X или OK) трябва да минава през централната queue completion функция, не директно state.giftItemReceivedModal = null')
})

await check('[G5] pending_gift_item_notifications (offline batch) enqueue-ва ЦЕЛИЯ масив в опашката', () => {
  const idx = controllerSrc.indexOf(`message.type === 'pending_gift_item_notifications'`)
  assert(idx !== -1, 'handler-ът трябва да съществува')
  const block = controllerSrc.slice(idx, idx + 700)
  assert(block.includes('enqueueGiftItemNotifications('), 'offline batch handler-ът трябва да вика enqueueGiftItemNotifications (не директно state.giftItemReceivedModal presetting само на [0])')
  assert(block.includes('message.deliveries.map'), 'трябва да мапне ЦЕЛИЯ message.deliveries масив, не само deliveries[0]')
})

await check('[G6] gift_item_received (realtime push) handler съществува и enqueue-ва в СЪЩАТА опашка', () => {
  const idx = controllerSrc.indexOf(`message.type === 'gift_item_received'`)
  assert(idx !== -1, 'РЕГРЕСИЯ: gift_item_received handler липсва — realtime подаръци никога няма да покажат popup')
  const block = controllerSrc.slice(idx, idx + 500)
  assert(block.includes('enqueueGiftItemNotifications('), 'realtime handler-ът трябва да enqueue-ва в СЪЩАТА опашка като offline batch-а (§4 брифа), не отделен presetting механизъм')
})

await check('[G7] Няма dedup логика (Set/filter по sender или gift) около queue enqueue пътя', () => {
  const idx = controllerSrc.indexOf('type GiftItemNotificationEntry')
  assert(idx !== -1, 'GiftItemNotificationEntry типът трябва да съществува близо до queue функциите')
  const region = controllerSrc.slice(idx, idx + 2400)
  assert(!/new Set\(.*(sender|giftItemId|fromDisplayName)/i.test(region), 'queue региона НЕ трябва да съдържа dedup-by-sender/gift Set логика')
  assert(!region.includes('.filter((item, index, arr) =>'), 'queue региона НЕ трябва да съдържа dedup filter логика')
})

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
