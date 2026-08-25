/**
 * checkGiftSuccessMessageStaleCleanup.ts
 *
 * Source-text проверки за bug fix-а на stale gift success inline съобщение
 * ("Подаръкът от X жълтици е изпратен.", state.friendActionMessage, рендирано
 * в profile popup-а под action бутоните). Преди фикса, съобщението никога не
 * се clear-ваше — оцеляваше след затваряне/повторно отваряне на profile
 * popup-а, след logout/login (controller-ът е дълготраен singleton, не се
 * пресъздава на auth промяна), и след следващ gift опит.
 *
 * Този скрипт не рендира DOM (jsdom не е налична зависимост тук, виж
 * checkGiftNotificationModalFix.ts за established прецедент) — вместо това
 * чете реалния source на src/app/lobby/createLobbyFlowController.ts и
 * потвърждава чрез string/regex checks, че clearGiftSuccessInlineMessage()
 * се вика на всяка изисквана точка.
 *
 * Покрива (bug report §"ЖЕЛАНО ПОВЕДЕНИЕ" + §TEST):
 *  [1] clearGiftSuccessInlineMessage() съществува и нулира и двете полета
 *      (state.friendActionMessage, state.friendActionMessageProfileId) плюс
 *      pending timeout-а.
 *  [A] submitGiftCoinsCore сетва success съобщението при успешен gift.
 *  [A.1] submitGiftCoinsCore планира bounded auto-hide (window.setTimeout,
 *        3000ms) — не global polling/interval.
 *  [B] getPopupCallbacks().onClose (targeted popup close) вика cleanup-а.
 *  [B.1] onProfileClose (top-level popup close, renderLobbyScreen options)
 *        вика cleanup-а.
 *  [C] openProtectedProfileById (отваряне на профил — друг ИЛИ същия) вика
 *      cleanup-а, преди да зареди новия профил.
 *  [D] resetToLobby() (единствената обща точка за logout И login/register
 *      success — main.ts) вика cleanup-а.
 *  [E] submitGiftCoinsCore вика cleanup-а В НАЧАЛОТО, преди нов network
 *      опит — стар success state не оцелява в нов gift attempt.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
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

function extractFunctionBody(src: string, signature: string, label: string): string {
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

// ─── Load real source ────────────────────────────────────────────────────────

const controllerSrc = await readFile(CONTROLLER_PATH, 'utf8')

console.log('\n=== Gift Success Message Stale Cleanup Checks ===\n')

// [1] clearGiftSuccessInlineMessage съществува и нулира и двете полета + timeout
await check('[1] clearGiftSuccessInlineMessage() нулира friendActionMessage/friendActionMessageProfileId и timeout-а', () => {
  const fn = extractFunctionBody(
    controllerSrc,
    'function clearGiftSuccessInlineMessage(targetProfileId?: string): void {',
    'clearGiftSuccessInlineMessage',
  )
  assert(fn.includes('window.clearTimeout(giftSuccessMessageTimeoutId)'), 'clearGiftSuccessInlineMessage трябва да чисти pending timeout')
  assert(fn.includes('giftSuccessMessageTimeoutId = null'), 'clearGiftSuccessInlineMessage трябва да нулира timeout id-то')
  assert(fn.includes('state.friendActionMessage = null'), 'clearGiftSuccessInlineMessage трябва да нулира state.friendActionMessage')
  assert(fn.includes('state.friendActionMessageProfileId = null'), 'clearGiftSuccessInlineMessage трябва да нулира state.friendActionMessageProfileId')
})

// [A] submitGiftCoinsCore сетва success съобщението при успешен gift (непроменено поведение)
await check('[A] submitGiftCoinsCore сетва success съобщение при успешен gift', () => {
  const fn = extractFunctionBody(
    controllerSrc,
    'async function submitGiftCoinsCore(',
    'submitGiftCoinsCore',
  )
  assert(
    /state\.friendActionMessage\s*=\s*`Подаръкът от \$\{amount\} жълтици е изпратен\.`/.test(fn),
    'submitGiftCoinsCore трябва да сетва success текста при успех',
  )
  assert(fn.includes('state.friendActionMessageProfileId = recipientProfileId'), 'submitGiftCoinsCore трябва да асоциира съобщението с recipientProfileId')
})

// [A.1] Bounded auto-hide timeout (3000ms), не global polling
await check('[A.1] submitGiftCoinsCore планира bounded 3000ms auto-hide (window.setTimeout), не interval/polling', () => {
  const fn = extractFunctionBody(
    controllerSrc,
    'async function submitGiftCoinsCore(',
    'submitGiftCoinsCore',
  )
  assert(
    /giftSuccessMessageTimeoutId\s*=\s*window\.setTimeout\(/.test(fn),
    'submitGiftCoinsCore трябва да планира window.setTimeout, записан в giftSuccessMessageTimeoutId',
  )
  assert(/\},\s*3000\)/.test(fn), 'auto-hide timeout трябва да е точно 3000ms')
  assert(!fn.includes('setInterval'), 'НЕ трябва да ползва setInterval/polling за auto-hide')
  assert(
    fn.includes('clearGiftSuccessInlineMessage(recipientProfileId ?? undefined)'),
    'auto-hide callback-ът трябва да вика clearGiftSuccessInlineMessage guard-нато с recipientProfileId',
  )
})

// [B] getPopupCallbacks().onClose (targeted popup close) вика cleanup-а
await check('[B] getPopupCallbacks().onClose вика clearGiftSuccessInlineMessage()', () => {
  const block = extractBlock(controllerSrc, 'onClose: () => {', 'getPopupCallbacks onClose')
  assert(block.includes('clearGiftSuccessInlineMessage()'), 'onClose (ProfilePopupCallbacks) трябва да вика clearGiftSuccessInlineMessage()')
})

// [B.1] onProfileClose (top-level popup close, renderLobbyScreen options) вика cleanup-а
await check('[B.1] onProfileClose (top-level RenderLobbyScreenOptions) вика clearGiftSuccessInlineMessage()', () => {
  const block = extractBlock(controllerSrc, 'onProfileClose: () => {', 'onProfileClose')
  assert(block.includes('clearGiftSuccessInlineMessage()'), 'onProfileClose трябва да вика clearGiftSuccessInlineMessage()')
})

// [C] openProtectedProfileById (отваряне на профил) вика cleanup-а преди зареждане
await check('[C] openProtectedProfileById вика clearGiftSuccessInlineMessage() при отваряне на профил', () => {
  const fn = extractFunctionBody(
    controllerSrc,
    'async function openProtectedProfileById(profileId: string, displayNameHint: string | null = null, context: ProfilePopupContext = \'other\'): Promise<void> {',
    'openProtectedProfileById',
  )
  assert(fn.includes('clearGiftSuccessInlineMessage()'), 'openProtectedProfileById трябва да вика clearGiftSuccessInlineMessage()')
  // Трябва да се извиква преди async fetch-а на новия профил (result = await options.onProfileByIdLoad),
  // не след — иначе stale message-ът за момент би останал видим по време на loading.
  const clearIdx = fn.indexOf('clearGiftSuccessInlineMessage()')
  const fetchIdx = fn.indexOf('await options.onProfileByIdLoad(profileId)')
  assert(clearIdx !== -1 && fetchIdx !== -1 && clearIdx < fetchIdx, 'clearGiftSuccessInlineMessage() трябва да се извика ПРЕДИ onProfileByIdLoad fetch-а')
})

// [D] resetToLobby() (обща точка за logout И login/register success) вика cleanup-а
await check('[D] resetToLobby() вика clearGiftSuccessInlineMessage() — покрива и logout, и login', () => {
  const fn = extractFunctionBody(
    controllerSrc,
    'function resetToLobby(): void {',
    'resetToLobby',
  )
  assert(fn.includes('clearGiftSuccessInlineMessage()'), 'resetToLobby трябва да вика clearGiftSuccessInlineMessage()')
})

// [E] submitGiftCoinsCore вика cleanup-а В НАЧАЛОТО, преди нов network опит
await check('[E] submitGiftCoinsCore чисти stale success state В НАЧАЛОТО, преди callNetwork()', () => {
  const fn = extractFunctionBody(
    controllerSrc,
    'async function submitGiftCoinsCore(',
    'submitGiftCoinsCore',
  )
  const clearIdx = fn.indexOf('clearGiftSuccessInlineMessage()')
  const networkIdx = fn.indexOf('await callNetwork()')
  assert(clearIdx !== -1, 'submitGiftCoinsCore трябва да вика clearGiftSuccessInlineMessage() в началото')
  assert(networkIdx !== -1, 'submitGiftCoinsCore трябва да вика callNetwork()')
  assert(clearIdx < networkIdx, 'clearGiftSuccessInlineMessage() трябва да се извика ПРЕДИ callNetwork() (нов gift attempt)')
})

// [extra] Guard-ът в clearGiftSuccessInlineMessage не трябва да трие ЧУЖДО
// (non-gift) friendActionMessage безусловно навсякъде — само явно посочените
// jизисквани точки (close/profile-change/logout-login/new-submit) викат
// unconditional-функцията; wildcard проверка, че извикванията остават точно
// 5 (не са добавени случайно на неподходящи места, което би скрило легитимни
// съобщения като "Поканата е изпратена.").
await check('[extra] clearGiftSuccessInlineMessage() се вика точно на изискваните места (targeted, не widespread)', () => {
  const occurrences = controllerSrc.split('clearGiftSuccessInlineMessage(').length - 1
  // 1x дефиниция (function clearGiftSuccessInlineMessage) + 1x unconditional call в началото на
  // submitGiftCoinsCore (нов gift attempt) + 1x guard-нат call в auto-hide timeout callback-а
  // (recipientProfileId variant) + 4x explicit unconditional call sites (onClose, onProfileClose,
  // openProtectedProfileById, resetToLobby) = 7 общо.
  assert(
    occurrences === 7,
    `Очаквани точно 7 usages (1 дефиниция + 2 calls в submitGiftCoinsCore + 4 explicit clear points), намерени: ${occurrences}`,
  )
})

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
