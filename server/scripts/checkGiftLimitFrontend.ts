/**
 * checkGiftLimitFrontend.ts — Frontend форматиране на gift limit грешки.
 *
 * Тества реалния production helper от formatGiftLimitError.ts (без DOM).
 * Изпълнява се с `tsx` (не е в build:scripts tsconfig).
 *
 * [1]  PARTIAL при remainingAllowance=10_000 → точен текст
 * [2]  PARTIAL не съдържа attemptedAmount, nextReleaseAmount, дата, "Опита се"
 * [3]  FULL с nowMs=2026-07-05T08:30Z, nextReleaseAt=2026-07-15T08:30Z → точен текст (10 дни, 15.07.2026 г.)
 * [4]  FULL използва Europe/Sofia (датата е 15.07.2026)
 * [5]  FULL не съдържа nextReleaseAmount
 * [6]  FULL с nextReleaseAt в миналото → "след 0 дни", не отрицателна стойност
 * [7]  FULL при null nextReleaseAt → точен fallback, без дата
 * [8]  FULL при invalid nextReleaseAt → точен fallback, без дата
 * [9]  Fallback не съдържа "Invalid Date", "NaN", "undefined", "null"
 * [10] Controller flow: непозната грешка (без code) → message се показва директно (source check)
 * [11] renderLobbyScreen.ts: input съдържа min="1000", server-derived max (state.giftModalMaxAmount), step="1000"
 * [12] renderLobbyScreen.ts/controller: MIN hardcoded "1 000", MAX е server-derived giftModalMaxAmount (exact bypass profile ID, не role)
 * [13] main.ts: API обработка запазва code, receivedInWindow, remainingAllowance, attemptedAmount, nextReleaseAt, nextReleaseAmount
 * [14] formatPikaTeamDailyGiftLimitError: remaining>0 → "Можеш да подариш още максимум X жълтици днес."
 * [15] formatPikaTeamDailyGiftLimitError: remaining=0 → "Достигнат е дневният лимит..." (не generic грешка)
 * [16] renderLobbyScreen.ts gift modal: informational блок "Дневен лимит/Подарени днес/Остават днес"
 * [17] Controller: success notification при remaining===0 използва server-returned result.pikaTeamDailyGiftLimitStatus (не клиентско изчисление)
 * [18] Controller: success notification текст точно "Достигна дневния си лимит за подаряване. Новият лимит ще бъде наличен след 00:00 ч."
 *
 * Stale giftModalPikaTeamDailyLimitStatus НЕ е authoritative blocker:
 * [19] gift form submit handler (renderLobbyScreen.ts) няма early return/guard, базиран на remaining/pikaTeamDailyGiftLimitStatus — request винаги стига до server
 * [20] submit бутонът в gift modal-а няма disabled атрибут (не е conditionally disabled от remaining)
 * [21] amount input max="${state.giftModalMaxAmount}" — server-derived single-операция таван, НЕ giftModalPikaTeamDailyLimitStatus.remaining
 * [22] submitGiftCoinsCore (controller) вика callNetwork() безусловно — единственият guard е липсваща callback функция, не remaining
 * [23] main.ts: PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED error branch синхронизира currentAuthSession.pikaTeamDailyGiftLimitStatus от fresh server error payload (Admin decrease UI sync), чрез saveSessionCache directly (не syncLobbyWithAuthSession — избягва двоен render() в рамките на едно gift error handling преминаване)
 * [24] giftModalPikaTeamDailyLimitStatus (render prop) е derived от authSession.pikaTeamDailyGiftLimitStatus при всеки render — automatic reflect на error-branch sync-а от [23]
 * [25] main.ts: success branch (gift response ok:true) също вика saveSessionCache directly, не syncLobbyWithAuthSession — consistency fix, същия double-render risk важи и за success path
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatGiftLimitError, formatPikaTeamDailyGiftLimitError } from '../../src/app/lobby/formatGiftLimitError.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

const FALLBACK = 'Този играч вече е получил максималния размер от 30 000 подарени жълтици за последните 60 дни.'

// Детерминистични стойности
const NOW_MS = new Date('2026-07-05T08:30:00.000Z').getTime()
const RELEASE_AT = '2026-07-15T08:30:00.000Z'

console.log('\ncheckGiftLimitFrontend')

// [1] PARTIAL с remainingAllowance=10_000 → точен текст
const msg1 = formatGiftLimitError(
  {
    code: 'RECIPIENT_WINDOW_LIMIT_PARTIAL',
    receivedInWindow: 20_000,
    remainingAllowance: 10_000,
    attemptedAmount: 15_000,
    nextReleaseAt: null,
    nextReleaseAmount: 5_000,
  },
  NOW_MS,
)
const formatted10000 = new Intl.NumberFormat('bg-BG').format(10_000)
const expectedPartial = `Този играч може да получи още най-много ${formatted10000} жълтици в текущия 60-дневен период.`
check('[1] PARTIAL: точен текст', normalizeWs(msg1) === normalizeWs(expectedPartial))

// [2] PARTIAL не съдържа нежелано съдържание
check('[2] PARTIAL: без attemptedAmount (15 000)', !msg1.includes('15'))
check('[2] PARTIAL: без nextReleaseAmount', !msg1.includes('5 000') && !msg1.includes('5000'))
check('[2] PARTIAL: без дата (DD.MM.YYYY)', !/\d{2}\.\d{2}\.\d{4}/.test(msg1))
check('[2] PARTIAL: без "Опита се"', !msg1.includes('Опита се'))

// [3] FULL с конкретни дати → точен текст (10 дни, 15.07.2026 г.)
const msg3 = formatGiftLimitError(
  {
    code: 'RECIPIENT_WINDOW_LIMIT_FULL',
    receivedInWindow: 30_000,
    remainingAllowance: 0,
    attemptedAmount: 500,
    nextReleaseAt: RELEASE_AT,
    nextReleaseAmount: 8_000,
  },
  NOW_MS,
)
const expectedFull = `${FALLBACK} Ще може да получава отново след 10 дни — на 15.07.2026 г.`
check('[3] FULL: точен текст (10 дни, 15.07.2026 г.)', normalizeWs(msg3) === normalizeWs(expectedFull))

// [4] FULL използва Europe/Sofia (датата е 15.07.2026)
check('[4] FULL: дата е 15.07.2026', msg3.includes('15.07.2026'))

// [5] FULL не съдържа nextReleaseAmount (8 000)
const formatted8000 = new Intl.NumberFormat('bg-BG').format(8_000)
check('[5] FULL: без nextReleaseAmount', !msg3.includes(formatted8000))

// [6] FULL с nextReleaseAt в миналото → "след 0 дни"
const PAST_AT = '2026-01-01T00:00:00.000Z'
const msg6 = formatGiftLimitError(
  {
    code: 'RECIPIENT_WINDOW_LIMIT_FULL',
    receivedInWindow: 30_000,
    remainingAllowance: 0,
    attemptedAmount: 500,
    nextReleaseAt: PAST_AT,
    nextReleaseAmount: 1_000,
  },
  NOW_MS,
)
check('[6] FULL с дата в миналото: "след 0 дни"', msg6.includes('след 0 дни'))
check('[6] FULL с дата в миналото: без отрицателни дни', !/-\d+\s*дни/.test(msg6))

// [7] FULL при null nextReleaseAt → точен fallback
const msg7 = formatGiftLimitError(
  {
    code: 'RECIPIENT_WINDOW_LIMIT_FULL',
    receivedInWindow: 30_000,
    remainingAllowance: 0,
    attemptedAmount: 500,
    nextReleaseAt: null,
    nextReleaseAmount: 0,
  },
  NOW_MS,
)
check('[7] FULL null nextReleaseAt: точен fallback', normalizeWs(msg7) === normalizeWs(FALLBACK))

// [8] FULL при invalid nextReleaseAt → точен fallback
const msg8 = formatGiftLimitError(
  {
    code: 'RECIPIENT_WINDOW_LIMIT_FULL',
    receivedInWindow: 30_000,
    remainingAllowance: 0,
    attemptedAmount: 500,
    nextReleaseAt: 'не-е-дата',
    nextReleaseAmount: 0,
  },
  NOW_MS,
)
check('[8] FULL invalid nextReleaseAt: точен fallback', normalizeWs(msg8) === normalizeWs(FALLBACK))

// [9] Fallback не съдържа нежелано
for (const bad of ['Invalid Date', 'NaN', 'undefined', 'null']) {
  check(`[9] Fallback: без "${bad}"`, !msg7.includes(bad) && !msg8.includes(bad))
}

// [10] Source check: controller използва result.message при обикновена грешка
const controllerSrc = readFileSync(
  resolve(PROJECT_ROOT, 'src/app/lobby/createLobbyFlowController.ts'),
  'utf8',
)
check(
  '[10] Controller: result.message при обикновена грешка',
  controllerSrc.includes('state.giftModalErrorText = result.message'),
)

// [11] renderLobbyScreen.ts: gift modal input атрибути
const renderSrc = readFileSync(
  resolve(PROJECT_ROOT, 'src/app/lobby/renderLobbyScreen.ts'),
  'utf8',
)
// Изолираме gift modal секцията за да избегнем влияние от други number inputs
const giftModalMatch = renderSrc.match(/data-lobby-gift-form[\s\S]*?<\/form>/)
const giftModalSrc = giftModalMatch ? giftModalMatch[0] : ''
check('[11] renderLobbyScreen gift modal: min="1000"', giftModalSrc.includes('min="1000"'))
// max е server-derived (giftModalMaxAmount) — 30000 за обикновени profiles,
// 100000 само за pika_team gift bypass profile-а (виж index.ts
// withPikaTeamGiftBypassFlag). Source-ът вече не hardcode-ва "30000" тук.
check('[11] renderLobbyScreen gift modal: max е server-derived (state.giftModalMaxAmount)', giftModalSrc.includes('max="${state.giftModalMaxAmount}"'))
check('[11] renderLobbyScreen gift modal: step="1000"', giftModalSrc.includes('step="1000"'))
check('[11] renderLobbyScreen gift modal: value="1000"', giftModalSrc.includes('value="1000"'))
check('[11] renderLobbyScreen gift modal: не съдържа min="100"', !giftModalSrc.includes('min="100"'))
check('[11] renderLobbyScreen gift modal: не съдържа step="100"', !giftModalSrc.includes('step="100"'))

// [12] renderLobbyScreen.ts: видим текст — MIN частта остава hardcoded
// ("1 000" regular space), MAX частта е server-derived (state.giftModalMaxAmount).
check('[12] renderLobbyScreen: текстът съдържа "между 1 000 и" (MIN hardcoded)', giftModalSrc.includes('между 1 000 и'))
check('[12] renderLobbyScreen: текстът показва state.giftModalMaxAmount', giftModalSrc.includes('${state.giftModalMaxAmount.toLocaleString'))
// LobbyScreenState/InternalLobbyFlowState носят полето, а InternalLobbyFlowState
// го computира от authSession?.pikaTeamGiftMaxAmount (server-derived, exact
// bypass profile ID match — НЕ role==='pika_team', виж index.ts).
check('[12] LobbyScreenState декларира giftModalMaxAmount: number', renderSrc.includes('giftModalMaxAmount: number'))
const controllerSrcForGift = readFileSync(
  resolve(PROJECT_ROOT, 'src/app/lobby/createLobbyFlowController.ts'),
  'utf8',
)
check(
  '[12] Controller: giftModalMaxAmount = authSession?.pikaTeamGiftMaxAmount ?? default',
  controllerSrcForGift.includes('giftModalMaxAmount: authSession?.pikaTeamGiftMaxAmount ?? DEFAULT_GIFT_MAX_AMOUNT'),
)

// [13] main.ts: API обработка запазва всички limit error полета
const mainSrc = readFileSync(resolve(PROJECT_ROOT, 'src/main.ts'), 'utf8')
const limitFields = ['code', 'receivedInWindow', 'remainingAllowance', 'attemptedAmount', 'nextReleaseAt', 'nextReleaseAmount']
for (const field of limitFields) {
  check(`[13] main.ts: запазва ${field}`, mainSrc.includes(field))
}

// [14]-[15] formatPikaTeamDailyGiftLimitError — точните error текстове
const pikaErr14 = formatPikaTeamDailyGiftLimitError({
  code: 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED',
  limit: 200_000,
  used: 175_000,
  remaining: 25_000,
})
check(
  '[14] formatPikaTeamDailyGiftLimitError remaining>0: точен текст',
  // Intl.NumberFormat('bg-BG') групира с U+00A0 (non-breaking space), не
  // regular space — виж numFmt в formatGiftLimitError.ts.
  pikaErr14 === 'Можеш да подариш още максимум 25 000 жълтици днес.',
)

const pikaErr15 = formatPikaTeamDailyGiftLimitError({
  code: 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED',
  limit: 200_000,
  used: 200_000,
  remaining: 0,
})
check(
  '[15] formatPikaTeamDailyGiftLimitError remaining=0: точен текст',
  pikaErr15 === 'Достигнат е дневният лимит за подаряване на жълтици. Лимитът се занулява в 00:00 ч.',
)

// [16] renderLobbyScreen.ts gift modal: informational блок за pika_team
const giftModalPikaStatusMatch = renderSrc.match(/giftModalPikaTeamDailyLimitStatus \? `[\s\S]*?` : ''/)
const giftModalPikaStatusSrc = giftModalPikaStatusMatch ? giftModalPikaStatusMatch[0] : ''
check('[16] renderLobbyScreen gift modal: "Дневен лимит:"', giftModalPikaStatusSrc.includes('Дневен лимит:'))
check('[16] renderLobbyScreen gift modal: "Подарени днес:"', giftModalPikaStatusSrc.includes('Подарени днес:'))
check('[16] renderLobbyScreen gift modal: "Остават днес:"', giftModalPikaStatusSrc.includes('Остават днес:'))

// [17]-[18] Controller: success notification при remaining===0 — server-
// returned result.pikaTeamDailyGiftLimitStatus (НЕ клиентско изчисление),
// reuse на съществуващия friendActionMessage inline механизъм (без нов
// notification/toast subsystem).
check(
  '[17] Controller: success notification използва result.pikaTeamDailyGiftLimitStatus?.remaining === 0 (server-returned)',
  controllerSrcForGift.includes('result.pikaTeamDailyGiftLimitStatus?.remaining === 0'),
)
check(
  '[18] Controller: success notification текст точен при remaining=0',
  controllerSrcForGift.includes('Достигна дневния си лимит за подаряване. Новият лимит ще бъде наличен след 00:00 ч.'),
)
check(
  '[18] Controller: reuse на съществуващия friendActionMessage (не нов popup/toast state поле)',
  /state\.friendActionMessage = result\.pikaTeamDailyGiftLimitStatus\?\.remaining === 0[\s\S]{0,40}\?[\s\S]{0,200}: `Подаръкът от \$\{amount\} жълтици е изпратен\.`/.test(controllerSrcForGift),
)

// [19]-[24] Stale giftModalPikaTeamDailyLimitStatus НЕ е authoritative
// blocker — informational-only, server остава единственият enforcement gate.

// [19] Submit handler-ът (form 'submit' listener) не прави early
// return/guard заради remaining/pikaTeamDailyGiftLimitStatus — само target
// (bypass:/friendship:) routing и amount extraction, после directly вика
// options.onGiftCoinsSubmit/onGiftCoinsBypassSubmit.
const submitHandlerStartIdx = renderSrc.indexOf(
  `root.querySelectorAll<HTMLFormElement>('[data-lobby-gift-form]').forEach((form) => {`,
)
const submitHandlerSrc = submitHandlerStartIdx >= 0
  ? renderSrc.slice(submitHandlerStartIdx, submitHandlerStartIdx + 900)
  : ''
check(
  '[19] Gift form submit handler съществува и е изолиран за проверка',
  submitHandlerSrc.length > 0,
)
check(
  '[19] Submit handler НЕ reference-ва pikaTeamDailyGiftLimitStatus/remaining (без cached-remaining guard)',
  submitHandlerSrc.length > 0 &&
    !submitHandlerSrc.includes('pikaTeamDailyGiftLimitStatus') &&
    !submitHandlerSrc.includes('remaining'),
)
check(
  '[19] Submit handler винаги вика onGiftCoinsSubmit/onGiftCoinsBypassSubmit при непразен target (request винаги стига до server)',
  submitHandlerSrc.includes('options.onGiftCoinsSubmit(friendshipId, amount)') &&
    submitHandlerSrc.includes('options.onGiftCoinsBypassSubmit(recipientProfileId, amount)'),
)

// [20] Submit бутонът в gift modal-а няма disabled атрибут — не е
// conditionally disabled от remaining/pikaTeamDailyGiftLimitStatus.
check(
  '[20] Submit бутон в gift modal-а: type="submit", без disabled',
  giftModalSrc.includes('type="submit"') && !/type="submit"[^>]*disabled/.test(giftModalSrc),
)

// [21] amount input max е server-derived giftModalMaxAmount (single-
// операция таван — 30 000/100 000), НЕ giftModalPikaTeamDailyLimitStatus.
// remaining. Вече проверено имплицитно от [11], тук explicit негативна
// проверка за remaining-based max.
check(
  '[21] amount input max="${state.giftModalMaxAmount}" (server-derived single-операция таван)',
  giftModalSrc.includes('max="${state.giftModalMaxAmount}"'),
)
check(
  '[21] amount input НЕ използва giftModalPikaTeamDailyLimitStatus.remaining за max (informational-only, не hard blocker)',
  !giftModalSrc.includes('max="${state.giftModalPikaTeamDailyLimitStatus'),
)

// [22] submitGiftCoinsCore (controller ядро за submitGiftCoins/
// submitGiftCoinsBypass) вика callNetwork() безусловно — единственият guard
// е `if (!callNetwork)` (липсваща callback функция), не remaining-базирана
// проверка преди мрежовия request.
const submitGiftCoinsCoreStartIdx = controllerSrcForGift.indexOf('async function submitGiftCoinsCore(')
const submitGiftCoinsCoreSrc = submitGiftCoinsCoreStartIdx >= 0
  ? controllerSrcForGift.slice(submitGiftCoinsCoreStartIdx, submitGiftCoinsCoreStartIdx + 900)
  : ''
check(
  '[22] submitGiftCoinsCore съществува и е изолиран за проверка',
  submitGiftCoinsCoreSrc.length > 0,
)
check(
  '[22] submitGiftCoinsCore единственият early-return guard е "if (!callNetwork)" (не remaining)',
  submitGiftCoinsCoreSrc.includes('if (!callNetwork) {'),
)
check(
  '[22] submitGiftCoinsCore не проверява remaining/pikaTeamDailyGiftLimitStatus преди callNetwork() извикването',
  (() => {
    const beforeCallIdx = submitGiftCoinsCoreSrc.indexOf('const result = await callNetwork()')
    const beforeCall = beforeCallIdx >= 0 ? submitGiftCoinsCoreSrc.slice(0, beforeCallIdx) : submitGiftCoinsCoreSrc
    return !beforeCall.includes('pikaTeamDailyGiftLimitStatus') && !beforeCall.includes('.remaining')
  })(),
)

// [23] main.ts: PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED error branch
// синхронизира currentAuthSession.pikaTeamDailyGiftLimitStatus от fresh
// server error payload — Admin decrease сценарий (stale client remaining,
// server отказва с по-нисък fresh лимит, UI трябва да се синхронизира).
const mainSrcForSync = readFileSync(resolve(PROJECT_ROOT, 'src/main.ts'), 'utf8')
const pikaErrorBranchStartIdx = mainSrcForSync.indexOf(`if (data.code === 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED') {`)
const pikaErrorBranchSrc = pikaErrorBranchStartIdx >= 0
  ? mainSrcForSync.slice(pikaErrorBranchStartIdx, pikaErrorBranchStartIdx + 1700)
  : ''
check(
  '[23] main.ts: PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED error branch изолиран за проверка',
  pikaErrorBranchSrc.length > 0,
)
check(
  '[23] main.ts: error branch update-ва currentAuthSession.pikaTeamDailyGiftLimitStatus от fresh server data',
  pikaErrorBranchSrc.includes('currentAuthSession = {') &&
    pikaErrorBranchSrc.includes('pikaTeamDailyGiftLimitStatus: {') &&
    pikaErrorBranchSrc.includes('limit: data.limit ?? 0') &&
    pikaErrorBranchSrc.includes('used: data.used ?? 0') &&
    pikaErrorBranchSrc.includes('remaining: data.remaining ?? 0'),
)
// Double-render fix: error branch вика saveSessionCache directly (НЕ
// syncLobbyWithAuthSession — онази вика setDisplayName/setLocalAvatarUrl,
// които ВИНАГИ render() вътрешно, а submitGiftCoinsCore вече ще извика
// render() веднага след като получи резултата обратно; двоен render() в
// рамките на едно gift error handling преминаване е излишен work и риск от
// intermediate frame). Проверяваме action code реда (не коментара, който
// explicit споменава syncLobbyWithAuthSession за да обясни защо НЕ се ползва).
check(
  '[23] main.ts: error branch вика saveSessionCache(currentAuthSession) directly (без двоен render)',
  /\r?\n {10}saveSessionCache\(currentAuthSession\)\r?\n/.test(pikaErrorBranchSrc),
)
check(
  '[23] main.ts: error branch НЕ вика syncLobbyWithAuthSession() като action (само в explanatory коментар)',
  !/[^/]\r?\n\s*syncLobbyWithAuthSession\(\)\r?\n/.test(pikaErrorBranchSrc.replace(/\/\/.*\r?\n/g, '')),
)

// [24] giftModalPikaTeamDailyLimitStatus render prop е derived от
// authSession.pikaTeamDailyGiftLimitStatus при всеки render() call —
// значи [23] sync-ът автоматично reflect-ва в UI при следващия render,
// без отделен modal-specific state update path.
check(
  '[24] Controller render(): giftModalPikaTeamDailyLimitStatus derived от authSession?.pikaTeamDailyGiftLimitStatus',
  controllerSrcForGift.includes('giftModalPikaTeamDailyLimitStatus: authSession?.pikaTeamDailyGiftLimitStatus ?? null'),
)

// [25] main.ts success branch (gift response ok:true) — същия double-render
// fix като error branch-а [23]: saveSessionCache directly, не
// syncLobbyWithAuthSession (setDisplayName/setLocalAvatarUrl ВИНАГИ render()
// вътрешно, а submitGiftCoinsCore после пак ще извика render()).
const successBranchStartIdx = mainSrcForSync.indexOf('profile: data.senderProfile,')
const successBranchSrc = successBranchStartIdx >= 0
  ? mainSrcForSync.slice(successBranchStartIdx, successBranchStartIdx + 900)
  : ''
check(
  '[25] main.ts success branch изолиран за проверка',
  successBranchSrc.length > 0,
)
check(
  '[25] main.ts success branch вика saveSessionCache(currentAuthSession) directly (без двоен render)',
  /\r?\n {6}saveSessionCache\(currentAuthSession\)\r?\n/.test(successBranchSrc),
)
check(
  '[25] main.ts success branch НЕ вика syncLobbyWithAuthSession() като action (само в explanatory коментар)',
  !/[^/]\r?\n\s*syncLobbyWithAuthSession\(\)\r?\n/.test(successBranchSrc.replace(/\/\/.*\r?\n/g, '')),
)

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
