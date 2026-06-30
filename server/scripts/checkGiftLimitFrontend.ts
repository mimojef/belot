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
 * [11] renderLobbyScreen.ts: input съдържа min="100", max="30000", step="100"
 * [12] renderLobbyScreen.ts: текст "между 100 и 30 000 жълтици"
 * [13] main.ts: API обработка запазва code, receivedInWindow, remainingAllowance, attemptedAmount, nextReleaseAt, nextReleaseAmount
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatGiftLimitError } from '../../src/app/lobby/formatGiftLimitError.js'

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
check('[11] renderLobbyScreen gift modal: max="30000"', giftModalSrc.includes('max="30000"'))
check('[11] renderLobbyScreen gift modal: step="1000"', giftModalSrc.includes('step="1000"'))
check('[11] renderLobbyScreen gift modal: value="1000"', giftModalSrc.includes('value="1000"'))
check('[11] renderLobbyScreen gift modal: не съдържа min="100"', !giftModalSrc.includes('min="100"'))
check('[11] renderLobbyScreen gift modal: не съдържа step="100"', !giftModalSrc.includes('step="100"'))

// [12] renderLobbyScreen.ts: видим текст
check('[12] renderLobbyScreen: "между 1 000 и 30 000 жълтици"', renderSrc.includes('между 1 000 и 30 000 жълтици'))

// [13] main.ts: API обработка запазва всички limit error полета
const mainSrc = readFileSync(resolve(PROJECT_ROOT, 'src/main.ts'), 'utf8')
const limitFields = ['code', 'receivedInWindow', 'remainingAllowance', 'attemptedAmount', 'nextReleaseAt', 'nextReleaseAmount']
for (const field of limitFields) {
  check(`[13] main.ts: запазва ${field}`, mainSrc.includes(field))
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
