/**
 * checkComputePaginationItems.ts
 *
 * Unit тестове за src/app/lobby/computePaginationItems.ts — чиста функция,
 * генерираща номерацията за `< 1 2 3 4 … >` pagination компонента.
 *
 * [1] 0 страници → празен масив
 * [2] 1 страница → [1]
 * [3] Малко страници (<=7) → показва всички номера, без многоточие
 * [4] Много страници, currentPage в средата → 1 … (cur-1) cur (cur+1) … last
 * [5] Много страници, currentPage=1 (начало) → без ляво многоточие
 * [6] Много страници, currentPage=last (край) → без дясно многоточие
 * [7] currentPage извън [1,totalPages] → clamp-ва се безопасно (не хвърля грешка)
 * [8] Не съдържа дублирани номера
 */

import { computePaginationItems } from '../../src/app/lobby/computePaginationItems.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok ${label}`)
    passed++
  } else {
    console.error(`  FAIL ${label}`)
    failed++
  }
}

console.log('\ncheckComputePaginationItems')

check('[1] 0 страници → []', JSON.stringify(computePaginationItems(1, 0)) === '[]')
check('[2] 1 страница → [1]', JSON.stringify(computePaginationItems(1, 1)) === '[1]')
check(
  '[3] 5 страници (<=7) → всички номера, без многоточие',
  JSON.stringify(computePaginationItems(3, 5)) === JSON.stringify([1, 2, 3, 4, 5]),
)
check(
  '[3b] 7 страници (граница) → всички номера, без многоточие',
  JSON.stringify(computePaginationItems(4, 7)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
)

{
  const items = computePaginationItems(10, 20)
  check(
    '[4] 20 страници, currentPage=10 → 1 … 9 10 11 … 20',
    JSON.stringify(items) === JSON.stringify([1, 'ellipsis', 9, 10, 11, 'ellipsis', 20]),
  )
}

{
  const items = computePaginationItems(1, 20)
  check('[5] currentPage=1 (начало) → без ляво многоточие', items[0] === 1 && items[1] === 2)
  check('[5b] currentPage=1 → има дясно многоточие преди последната', items.includes('ellipsis') && items[items.length - 1] === 20)
}

{
  const items = computePaginationItems(20, 20)
  check('[6] currentPage=last (край) → без дясно многоточие', items[items.length - 1] === 20 && items[items.length - 2] === 19)
  check('[6b] currentPage=last → има ляво многоточие след първата', items.includes('ellipsis') && items[0] === 1)
}

check(
  '[7] currentPage=0 (под диапазона) не хвърля грешка и се clamp-ва към 1',
  (() => {
    const items = computePaginationItems(0, 20)
    return items[0] === 1
  })(),
)
check(
  '[7b] currentPage=999 (над диапазона) не хвърля грешка и се clamp-ва към last',
  (() => {
    const items = computePaginationItems(999, 20)
    return items[items.length - 1] === 20
  })(),
)

{
  const items = computePaginationItems(10, 20).filter((i): i is number => i !== 'ellipsis')
  check('[8] няма дублирани номера', new Set(items).size === items.length)
}

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
