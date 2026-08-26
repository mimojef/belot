/**
 * checkSofiaDayBoundary.ts
 *
 * Unit checks за getSofiaDayStartUtcSqliteString (server/src/db/sofiaDayBoundary.ts)
 * — календарен-ден (Europe/Sofia) boundary изчислението, ползвано от
 * pika_team дневния gift лимит (yellowCoinGiftStore.ts §4.5).
 *
 * [0] Лятно време (EEST, UTC+3): момент в средата на деня дава коректен start
 * [1] Зимно време (EET, UTC+2): момент в средата на деня дава коректен start
 * [2] Точно 23:59 Sofia (лято) все още е предишният ден
 * [3] Точно 00:00 Sofia (лято) вече е новият ден
 * [4] DST spring-forward (последна неделя март): преди прехода все още EET
 * [5] DST spring-forward: след прехода вече EEST, но същия Sofia calendar ден
 * [6] DST fall-back (последна неделя октомври): преди прехода все още EEST
 * [7] DST fall-back: след прехода вече EET, коректен нов ден
 */

import { getSofiaDayStartUtcSqliteString } from '../src/db/sofiaDayBoundary.js'

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
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`)
  }
}

console.log('\n=== checkSofiaDayBoundary ===\n')

check('[0] Лятно време (EEST, UTC+3): 26.08.2026 10:00 UTC → ден започва 25.08.2026 21:00 UTC', () => {
  const result = getSofiaDayStartUtcSqliteString(Date.parse('2026-08-26T10:00:00Z'))
  assertEqual(result, '2026-08-25 21:00:00', '[0]')
})

check('[1] Зимно време (EET, UTC+2): 15.01.2026 10:00 UTC → ден започва 14.01.2026 22:00 UTC', () => {
  const result = getSofiaDayStartUtcSqliteString(Date.parse('2026-01-15T10:00:00Z'))
  assertEqual(result, '2026-01-14 22:00:00', '[1]')
})

check('[2] 20:59 UTC (23:59 Sofia лято) все още е предишният Sofia ден', () => {
  const result = getSofiaDayStartUtcSqliteString(Date.parse('2026-08-25T20:59:00Z'))
  assertEqual(result, '2026-08-24 21:00:00', '[2]')
})

check('[3] 21:00 UTC (00:00 Sofia лято) вече е новият Sofia ден', () => {
  const result = getSofiaDayStartUtcSqliteString(Date.parse('2026-08-25T21:00:00Z'))
  assertEqual(result, '2026-08-25 21:00:00', '[3]')
})

check('[4] DST spring-forward 2026-03-29: 00:30 UTC все още EET (+2, преди прехода)', () => {
  // Sofia преминава EET→EEST точно в 01:00 UTC на последната неделя на март
  // (02:59:59 местно EET → 04:00:00 местно EEST). 00:30 UTC е преди прехода.
  const result = getSofiaDayStartUtcSqliteString(Date.parse('2026-03-29T00:30:00Z'))
  assertEqual(result, '2026-03-28 22:00:00', '[4]')
})

check('[5] DST spring-forward 2026-03-29: 01:30 UTC вече EEST (+3, след прехода), същия calendar ден', () => {
  const result = getSofiaDayStartUtcSqliteString(Date.parse('2026-03-29T01:30:00Z'))
  assertEqual(result, '2026-03-28 21:00:00', '[5]')
})

check('[6] DST fall-back 2026-10-25: 00:30 UTC все още EEST (+3, преди прехода)', () => {
  // Sofia преминава EEST→EET точно в 01:00 UTC на последната неделя на
  // октомври (03:59:59 местно EEST → 03:00:00 местно EET).
  const result = getSofiaDayStartUtcSqliteString(Date.parse('2026-10-25T00:30:00Z'))
  assertEqual(result, '2026-10-24 21:00:00', '[6]')
})

check('[7] DST fall-back 2026-10-25: 01:30 UTC вече EET (+2, след прехода)', () => {
  const result = getSofiaDayStartUtcSqliteString(Date.parse('2026-10-25T01:30:00Z'))
  assertEqual(result, '2026-10-24 22:00:00', '[7]')
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
