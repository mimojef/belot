/**
 * checkGiftNotificationModalFix.ts
 *
 * Source-text проверки за bug fix-а на gift notification click handler-а:
 * преди фикса, click върху "получихте подарък" notification грешно
 * презаписваше giftSuccessModal (рендиран като "Подарихте X на Y") със
 * стойностите на ПОЛУЧЕНия подарък — резултат: "Подарихте 30000 на Mimojef"
 * вместо коректното "Mimojef ви подари 30000 жълтици".
 *
 * Този скрипт не рендира DOM (jsdom не е налична зависимост тук) — вместо
 * това чете реалния source на src/app/lobby/{createLobbyFlowController,
 * renderLobbyScreen}.ts и потвърждава чрез regex/string checks, че:
 *   1. onNotifGiftClick вече НЕ пипа state.giftSuccessModal.
 *   2. onNotifGiftClick сетва отделно giftReceivedModal = { amount, fromDisplayName }.
 *   3. giftReceivedModal е декларирано в двата state типа с правилната форма.
 *   4. renderGiftSuccessModal (sender success) продължава да показва
 *      "Подарихте {amount} жълтици" / "на {friendName}".
 *   5. Нова renderGiftReceivedModal (received notification) показва
 *      "{fromDisplayName} ви подари" / "{amount} жълтици".
 *   6. onGiftReceivedClose е wired (handler + click listener), аналогично
 *      на onGiftSuccessClose.
 *   7. submitGiftCoins (реалният "изпратих подарък" success path) остава
 *      непроменен — все още сетва giftSuccessModal.
 *   8. submitGiftCoinsCore (общото success/error ядро за submitGiftCoins И
 *      submitGiftCoinsBypass — извлечено в по-късен pika_team direct-gift
 *      рефакторинг) никога не пипа giftReceivedModal.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')
const RENDER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'renderLobbyScreen.ts')

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

// ─── Load real source files ─────────────────────────────────────────────────

const controllerSrc = await readFile(CONTROLLER_PATH, 'utf8')
const renderSrc = await readFile(RENDER_PATH, 'utf8')

function extractBlock(src: string, startMarker: string, label: string): string {
  const startIdx = src.indexOf(startMarker)
  assert(startIdx !== -1, `${label}: маркер "${startMarker}" не е намерен`)
  // Handlers в тоя файл са прости, плитки arrow functions — затварящата "},"
  // на същото ниво на indentation е края на блока.
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf('\n      },')
  assert(endIdx !== -1, `${label}: край на блок не е намерен след "${startMarker}"`)
  return afterStart.slice(0, endIdx)
}

function extractFunctionBody(src: string, signature: string, label: string): string {
  const startIdx = src.indexOf(signature)
  assert(startIdx !== -1, `${label}: сигнатура "${signature}" не е намерена`)
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf('\n}')
  assert(endIdx !== -1, `${label}: край на функция не е намерен след "${signature}"`)
  return afterStart.slice(0, endIdx)
}

// Вариант на extractFunctionBody за nested функции ВЪТРЕ в
// createLobbyFlowController() (2-space indent затваряща скоба "\n  }",
// не top-level "\n}") — submitGiftCoinsCore и други helper-и, дефинирани
// вътре в controller closure-а, не на module top-level.
function extractNestedFunctionBody(src: string, signature: string, label: string): string {
  const startIdx = src.indexOf(signature)
  assert(startIdx !== -1, `${label}: сигнатура "${signature}" не е намерена`)
  const afterStart = src.slice(startIdx)
  const endIdx = afterStart.indexOf('\n  }')
  assert(endIdx !== -1, `${label}: край на функция не е намерен след "${signature}"`)
  return afterStart.slice(0, endIdx)
}

console.log('\n=== Gift Notification Modal Fix Checks ===\n')

// [1] onNotifGiftClick вече НЕ пипа giftSuccessModal
await check('[1] onNotifGiftClick НЕ използва giftSuccessModal', () => {
  const block = extractBlock(controllerSrc, 'onNotifGiftClick: (giftId, amount, fromDisplayName) => {', 'onNotifGiftClick')
  assert(!block.includes('giftSuccessModal'), `onNotifGiftClick НЕ трябва да реферира giftSuccessModal, но блокът съдържа:\n${block}`)
})

// [2] onNotifGiftClick сетва giftReceivedModal с правилните полета
await check('[2] onNotifGiftClick сетва giftReceivedModal = { amount, fromDisplayName }', () => {
  const block = extractBlock(controllerSrc, 'onNotifGiftClick: (giftId, amount, fromDisplayName) => {', 'onNotifGiftClick')
  assert(
    /state\.giftReceivedModal\s*=\s*\{\s*amount,\s*fromDisplayName\s*\}/.test(block),
    `onNotifGiftClick трябва да сетне state.giftReceivedModal = { amount, fromDisplayName }, получен блок:\n${block}`,
  )
  assert(block.includes('pendingGiftNotifications = state.pendingGiftNotifications.filter'), 'onNotifGiftClick трябва да маха notification-а от pendingGiftNotifications')
  assert(block.includes('onMarkGiftNotificationRead'), 'onNotifGiftClick трябва да вика onMarkGiftNotificationRead')
})

// [3] giftReceivedModal е декларирано в двата state типа с правилната форма
await check('[3] giftReceivedModal state поле декларирано в контролер и render типа', () => {
  const fieldPattern = /giftReceivedModal:\s*\{\s*amount:\s*number;\s*fromDisplayName:\s*string\s*\}\s*\|\s*null/
  assert(fieldPattern.test(controllerSrc), 'createLobbyFlowController.ts трябва да декларира giftReceivedModal: { amount: number; fromDisplayName: string } | null')
  assert(fieldPattern.test(renderSrc), 'renderLobbyScreen.ts трябва да декларира giftReceivedModal: { amount: number; fromDisplayName: string } | null')
})

// [4] renderGiftSuccessModal (sender success) съдържанието остава коректно:
//     "Подарихте {amount} жълтици" / "на {friendName}" — използва friendName (recipient of a SENT gift)
await check('[4] Sender success modal показва "Подарихте ... на {friendName}"', () => {
  const fn = extractFunctionBody(renderSrc, 'function renderGiftSuccessModal(state: LobbyScreenState): string {', 'renderGiftSuccessModal')
  assert(fn.includes('const { amount, friendName } = state.giftSuccessModal'), 'renderGiftSuccessModal трябва да чете { amount, friendName } от state.giftSuccessModal')
  assert(/Подарихте\s*\$\{[^}]*amount[^}]*\}\s*жълтици/.test(fn), `Очаква се "Подарихте {amount} жълтици" в renderGiftSuccessModal:\n${fn}`)
  assert(/на\s*\$\{escapeHtml\(friendName\)\}/.test(fn), `Очаква се "на {friendName}" в renderGiftSuccessModal:\n${fn}`)
  assert(!fn.includes('fromDisplayName'), 'renderGiftSuccessModal НЕ трябва да реферира fromDisplayName')
})

// [5] renderGiftReceivedModal (received notification) съдържанието: "{fromDisplayName} ви подари" / "{amount} жълтици"
await check('[5] Received notification modal показва "{fromDisplayName} ви подари ... {amount} жълтици"', () => {
  const fn = extractFunctionBody(renderSrc, 'function renderGiftReceivedModal(state: LobbyScreenState): string {', 'renderGiftReceivedModal')
  assert(fn.includes('const { amount, fromDisplayName } = state.giftReceivedModal'), 'renderGiftReceivedModal трябва да чете { amount, fromDisplayName } от state.giftReceivedModal')
  assert(/\$\{escapeHtml\(fromDisplayName\)\}\s*ви подари/.test(fn), `Очаква се "{fromDisplayName} ви подари" в renderGiftReceivedModal:\n${fn}`)
  assert(/\$\{[^}]*amount[^}]*\}\s*жълтици/.test(fn), `Очаква се "{amount} жълтици" в renderGiftReceivedModal:\n${fn}`)
  assert(!fn.includes('friendName'), 'renderGiftReceivedModal НЕ трябва да реферира friendName')
})

// [6] onGiftReceivedClose е wired (handler декларация + click listener), аналогично на onGiftSuccessClose
await check('[6] onGiftReceivedClose е wired (handler + click listener)', () => {
  assert(controllerSrc.includes('onGiftReceivedClose: () => {'), 'createLobbyFlowController.ts трябва да дефинира onGiftReceivedClose handler')
  const closeBlock = extractBlock(controllerSrc, 'onGiftReceivedClose: () => {', 'onGiftReceivedClose')
  assert(closeBlock.includes('state.giftReceivedModal = null'), 'onGiftReceivedClose трябва да нулира state.giftReceivedModal')

  assert(/onGiftReceivedClose:\s*\(\)\s*=>\s*void/.test(renderSrc), 'renderLobbyScreen.ts трябва да декларира onGiftReceivedClose: () => void в callbacks типа')
  assert(
    renderSrc.includes(`.querySelector<HTMLButtonElement>('[data-lobby-gift-received-ok="1"]')`),
    'renderLobbyScreen.ts трябва да прикачи click listener за data-lobby-gift-received-ok',
  )
  assert(renderSrc.includes('data-lobby-gift-received-ok'), 'renderGiftReceivedModal трябва да съдържа data-lobby-gift-received-ok бутон')
})

// [7] submitGiftCoins (реалният "изпратих подарък" success) остава непроменен — все още сетва giftSuccessModal
await check('[7] Реалният sender success path (submitGiftCoins) остава непроменен', () => {
  assert(
    /state\.giftSuccessModal\s*=\s*\{\s*amount,\s*friendName\s*\}/.test(controllerSrc),
    'submitGiftCoins трябва да продължи да сетва state.giftSuccessModal = { amount, friendName } при реално успешно изпращане',
  )
})

// [8] giftSuccessModal и giftReceivedModal никога не се сетват в един и същ handler (взаимно изключващи се)
//
// Assertion history: оригинално търсеше буквалния низ
// "const result = await options.onGiftCoinsSubmit(friendshipId, amount)"
// вътре в submitGiftCoins. По-късен pika_team direct-gift рефакторинг
// извлече ОБЩОТО success/error ядро (submitGiftCoinsCore) — вика се и от
// submitGiftCoins (friendship gift), и от submitGiftCoinsBypass (pika_team
// direct gift), приемайки network извикването като callNetwork() параметър
// вместо директно options.onGiftCoinsSubmit(...). Старият литерал вече не
// съществува никъде в source-а — implementation поведението (giftReceivedModal
// никога не се пипа от sender success path-а) остава непроменено и коректно
// (проверено ръчно: submitGiftCoinsCore не реферира giftReceivedModal никъде
// в тялото си), затова тук се актуализира само anchor-ът на assertion-а към
// новата еквивалентна структура — submitGiftCoinsCore вместо literal-string
// търсене на стария директен call.
await check('[8] giftSuccessModal и giftReceivedModal не се смесват в един handler', () => {
  const notifBlock = extractBlock(controllerSrc, 'onNotifGiftClick: (giftId, amount, fromDisplayName) => {', 'onNotifGiftClick')
  assert(!notifBlock.includes('giftSuccessModal'), 'onNotifGiftClick не трябва да пипа giftSuccessModal')

  const coreBody = extractNestedFunctionBody(controllerSrc, 'async function submitGiftCoinsCore(', 'submitGiftCoinsCore')
  assert(coreBody.includes('state.giftSuccessModal ='), 'submitGiftCoinsCore трябва да продължи да сетва state.giftSuccessModal при успех')
  assert(!coreBody.includes('giftReceivedModal'), 'submitGiftCoinsCore (общото ядро за submitGiftCoins/submitGiftCoinsBypass) не трябва да пипа giftReceivedModal')
})

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
