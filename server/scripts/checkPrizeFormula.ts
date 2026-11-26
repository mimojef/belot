/**
 * checkPrizeFormula.ts — целеви проверки за общата финансова основа (Етап 1):
 * server/src/economy/prizeFormula.ts и server/src/economy/entryLevelCatalog.ts.
 *
 * Чисти проверки: без сървър, без реална база (каталогът се чете от
 * in-memory SQLite), без портфейли и ledger-и.
 *
 * Пускане: npx tsx scripts/checkPrizeFormula.ts
 */

import { DatabaseSync } from 'node:sqlite'
import {
  computePrizeBreakdown,
  DEFAULT_SITE_COMMISSION_BPS,
  MAX_SAFE_FINANCIAL_AMOUNT,
  PrizeFormulaError,
  requirePrizeBreakdown,
  type PrizeFormulaInput,
} from '../src/economy/prizeFormula.js'
import {
  buildEntryLevelCatalog,
  ENTRY_FEE_TECHNICAL_MAX,
  GAME_PRIZE_FORMATS,
  readEntryLevelRowsFromMatchRooms,
  validateEntryLevelInput,
  type EntryLevelRow,
} from '../src/economy/entryLevelCatalog.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function ok(input: PrizeFormulaInput) {
  const result = computePrizeBreakdown(input)
  if (!result.ok) throw new Error(`unexpected error ${result.code} for ${JSON.stringify(input)}`)
  return result.breakdown
}

function expectBreakdown(label: string, input: PrizeFormulaInput, expected: { pot: number; prizePerWinner: number; totalPrize: number; siteCommission: number; roundingDeltaHundredths?: number }): void {
  const b = ok(input)
  const match = b.pot === expected.pot && b.prizePerWinner === expected.prizePerWinner && b.totalPrize === expected.totalPrize
    && b.siteCommission === expected.siteCommission
    && (expected.roundingDeltaHundredths === undefined || b.roundingDeltaHundredths === expected.roundingDeltaHundredths)
  check(label, match, { got: b, expected })
}

function expectError(label: string, input: PrizeFormulaInput, code: string): void {
  const result = computePrizeBreakdown(input)
  check(label, !result.ok && result.code === code, result)
}

const BPS = DEFAULT_SITE_COMMISSION_BPS

console.log('\n[1] Пример от заданието')
expectBreakdown('8 000 × 4, 1 победител, 20% → 32 000 / 25 600 / 6 400', { entryFee: 8000, paidEntries: 4, winners: 1, siteCommissionBps: BPS },
  { pot: 32_000, prizePerWinner: 25_600, totalPrize: 25_600, siteCommission: 6_400, roundingDeltaHundredths: 0 })
expectBreakdown('Белот 8 000 × 4, 2 победители → 12 800 на победител', { entryFee: 8000, paidEntries: 4, winners: 2, siteCommissionBps: BPS },
  { pot: 32_000, prizePerWinner: 12_800, totalPrize: 25_600, siteCommission: 6_400, roundingDeltaHundredths: 0 })

console.log('\n[2] Production нивата × всички формати — точни 80/20 без закръгляне')
const PRODUCTION_LEVELS = [5000, 8000, 15000, 20000, 35000, 50000, 60000, 80000, 100000, 130000, 150000, 180000, 200000]
const NEW_LEVELS = [500_000, 800_000, 1_000_000]
for (const entryFee of [...PRODUCTION_LEVELS, ...NEW_LEVELS]) {
  const allExact = GAME_PRIZE_FORMATS.every((format) => {
    const b = ok({ entryFee, paidEntries: format.paidEntries, winners: format.winners, siteCommissionBps: BPS })
    return b.pot === entryFee * format.paidEntries
      && b.totalPrize * 5 === b.pot * 4
      && b.siteCommission * 5 === b.pot
      && b.roundingDeltaHundredths === 0
      && b.prizePerWinner % 100 === 0
  })
  check(`вход ${entryFee}: Белот/Свара 2-3-4/Ludo 2-4 — точно 80/20`, allExact)
}
expectBreakdown('Свара 1 000 000 × 4 → 3 200 000', { entryFee: 1_000_000, paidEntries: 4, winners: 1, siteCommissionBps: BPS },
  { pot: 4_000_000, prizePerWinner: 3_200_000, totalPrize: 3_200_000, siteCommission: 800_000 })
expectBreakdown('Белот 200 000 → 320 000 на победител', { entryFee: 200_000, paidEntries: 4, winners: 2, siteCommissionBps: BPS },
  { pot: 800_000, prizePerWinner: 320_000, totalPrize: 640_000, siteCommission: 160_000 })

console.log('\n[3] Закръгляне до 100 (под 50 — надолу, 50+ — нагоре)')
expectBreakdown('2 666.4 → 2 700 (66.4 ≥ 50)', { entryFee: 1111, paidEntries: 3, winners: 1, siteCommissionBps: BPS },
  { pot: 3333, prizePerWinner: 2700, totalPrize: 2700, siteCommission: 633, roundingDeltaHundredths: -3360 })
expectBreakdown('2 649.6 → 2 600 (49.6 < 50)', { entryFee: 1104, paidEntries: 3, winners: 1, siteCommissionBps: BPS },
  { pot: 3312, prizePerWinner: 2600, totalPrize: 2600, siteCommission: 712, roundingDeltaHundredths: 4960 })
expectBreakdown('точно 2 450 → 2 500 (точно 50 — нагоре)', { entryFee: 1750, paidEntries: 2, winners: 1, siteCommissionBps: 3000 },
  { pot: 3500, prizePerWinner: 2500, totalPrize: 2500, siteCommission: 1000, roundingDeltaHundredths: -5000 })
expectBreakdown('2 449.6 → 2 400', { entryFee: 1531, paidEntries: 2, winners: 1, siteCommissionBps: BPS },
  { pot: 3062, prizePerWinner: 2400, totalPrize: 2400, siteCommission: 662 })
expectBreakdown('2 победители по точно 2 650 → по 2 700', { entryFee: 1325, paidEntries: 5, winners: 2, siteCommissionBps: BPS },
  { pot: 6625, prizePerWinner: 2700, totalPrize: 5400, siteCommission: 1225 })
expectBreakdown('3 победители: 8 000 / 3 = 2 666.67 → по 2 700, комисиона = остатъкът', { entryFee: 1000, paidEntries: 10, winners: 3, siteCommissionBps: BPS },
  { pot: 10_000, prizePerWinner: 2700, totalPrize: 8100, siteCommission: 1900 })

console.log('\n[4] Индивидуална комисиона')
expectBreakdown('15% на 8 000 × 4 → 27 200 / 4 800', { entryFee: 8000, paidEntries: 4, winners: 1, siteCommissionBps: 1500 },
  { pot: 32_000, prizePerWinner: 27_200, totalPrize: 27_200, siteCommission: 4800 })
expectBreakdown('12.5% на 10 000 × 3 → 26 250 → 26 300', { entryFee: 10_000, paidEntries: 3, winners: 1, siteCommissionBps: 1250 },
  { pot: 30_000, prizePerWinner: 26_300, totalPrize: 26_300, siteCommission: 3700 })
expectBreakdown('0% комисиона при кратен фонд', { entryFee: 5000, paidEntries: 2, winners: 1, siteCommissionBps: 0 },
  { pot: 10_000, prizePerWinner: 10_000, totalPrize: 10_000, siteCommission: 0 })

console.log('\n[5] Големи суми и безопасен диапазон')
const bigEntry = ENTRY_FEE_TECHNICAL_MAX
expectBreakdown('технически максимум 10^12 × 4', { entryFee: bigEntry, paidEntries: 4, winners: 1, siteCommissionBps: BPS },
  { pot: 4 * bigEntry, prizePerWinner: (bigEntry / 10) * 32, totalPrize: (bigEntry / 10) * 32, siteCommission: (bigEntry / 10) * 8 })
{
  const b = ok({ entryFee: MAX_SAFE_FINANCIAL_AMOUNT, paidEntries: 1, winners: 1, siteCommissionBps: BPS })
  const exact = BigInt(MAX_SAFE_FINANCIAL_AMOUNT) * 8000n
  const expectedPrize = ((2n * exact + 1_000_000n) / 2_000_000n) * 100n
  check('фонд = MAX_SAFE_INTEGER: точна BigInt награда', BigInt(b.prizePerWinner) === expectedPrize && Number.isSafeInteger(b.prizePerWinner) && Number.isSafeInteger(b.siteCommission) && b.totalPrize + b.siteCommission === b.pot, b)
}
expectError('фонд над MAX_SAFE_INTEGER → pot-exceeds-safe-range', { entryFee: MAX_SAFE_FINANCIAL_AMOUNT, paidEntries: 2, winners: 1, siteCommissionBps: BPS }, 'pot-exceeds-safe-range')
expectError('вход над безопасното цяло → invalid-entry-fee', { entryFee: MAX_SAFE_FINANCIAL_AMOUNT + 1, paidEntries: 1, winners: 1, siteCommissionBps: BPS }, 'invalid-entry-fee')

console.log('\n[6] Невалидни входни данни')
for (const [label, entryFee] of [['0', 0], ['-5000', -5000], ['1.5', 1.5], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['низ', '5000']] as const) {
  expectError(`вход ${label} → invalid-entry-fee`, { entryFee: entryFee as number, paidEntries: 2, winners: 1, siteCommissionBps: BPS }, 'invalid-entry-fee')
}
expectError('0 платени входа', { entryFee: 5000, paidEntries: 0, winners: 1, siteCommissionBps: BPS }, 'invalid-paid-entries')
expectError('0 победители', { entryFee: 5000, paidEntries: 2, winners: 0, siteCommissionBps: BPS }, 'invalid-winners')
expectError('победители > платени', { entryFee: 5000, paidEntries: 2, winners: 3, siteCommissionBps: BPS }, 'winners-exceed-paid-entries')
for (const bps of [-1, 10_000, 12.5, Number.NaN]) {
  expectError(`комисиона ${bps} bps → invalid-commission`, { entryFee: 5000, paidEntries: 2, winners: 1, siteCommissionBps: bps }, 'invalid-commission')
}
expectError('награда, закръглена до 0', { entryFee: 10, paidEntries: 2, winners: 1, siteCommissionBps: BPS }, 'prize-rounds-to-zero')
expectError('закръглената награда > фонда', { entryFee: 150, paidEntries: 1, winners: 1, siteCommissionBps: 0 }, 'prizes-exceed-pot')
{
  let thrown: unknown = null
  try { requirePrizeBreakdown({ entryFee: 0, paidEntries: 2, winners: 1, siteCommissionBps: BPS }) } catch (error) { thrown = error }
  check('requirePrizeBreakdown хвърля PrizeFormulaError', thrown instanceof PrizeFormulaError && thrown.code === 'invalid-entry-fee')
}

console.log('\n[7] Инварианти върху 20 000 псевдослучайни комбинации')
{
  let seed = 0x5eed
  const next = (max: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed % max }
  let violations = 0
  let errors = 0
  let unexpectedErrors = 0
  for (let i = 0; i < 20_000; i++) {
    const paidEntries = 1 + next(8)
    // Половината в „реалистичен“ диапазон (вход ≥ 1 000, комисиона ≥ 10%) —
    // там грешка е недопустима; другата половина е широка (вход ≥ 1, комисиона
    // от 0) — там са допустими само prizes-exceed-pot / prize-rounds-to-zero.
    const realistic = i % 2 === 0
    const input = realistic
      ? { entryFee: 1000 + next(2_000_000), paidEntries, winners: 1 + next(paidEntries), siteCommissionBps: 1000 + next(4000) }
      : { entryFee: 1 + next(5000), paidEntries, winners: 1 + next(paidEntries), siteCommissionBps: next(10_000) }
    const result = computePrizeBreakdown(input)
    if (!result.ok) {
      if (realistic) errors++
      else if (result.code !== 'prizes-exceed-pot' && result.code !== 'prize-rounds-to-zero') unexpectedErrors++
      continue
    }
    const b = result.breakdown
    const exactTimesScale = BigInt(b.pot) * BigInt(10_000 - b.siteCommissionBps)
    const prizeTimesScale = BigInt(b.prizePerWinner) * 10_000n * BigInt(b.winners)
    const diff = prizeTimesScale - exactTimesScale
    const half = 50n * 10_000n * BigInt(b.winners)
    const roundingOk = diff >= -half && diff < half
    if (b.totalPrize + b.siteCommission !== b.pot || b.prizePerWinner % 100 !== 0 || b.totalPrize !== b.prizePerWinner * b.winners
      || b.siteCommission < 0 || !roundingOk) violations++
  }
  check('фонд = награди + комисиона; награда кратна на 100; отклонение в [−50, +50)', violations === 0, { violations })
  check('без грешки в реалистичния диапазон (вход ≥ 1 000, комисиона ≥ 10%)', errors === 0, { errors })
  check('в широкия диапазон — само prizes-exceed-pot / prize-rounds-to-zero', unexpectedErrors === 0, { unexpectedErrors })
}

console.log('\n[8] Каталог: четене от match_rooms (in-memory SQLite)')
{
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE match_rooms (stake_amount INTEGER PRIMARY KEY, min_level INTEGER NOT NULL DEFAULT 1,
    prize_amount INTEGER NOT NULL, is_enabled INTEGER NOT NULL DEFAULT 1)`)
  const minLevels = [1, 3, 5, 7, 8, 10, 11, 13, 16, 20, 22, 25, 28]
  const insert = db.prepare('INSERT INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled) VALUES (?, ?, ?, 1)')
  // Подреждаме обратно — каталогът трябва сам да ги подреди; prize_amount е умишлено „грешен“.
  PRODUCTION_LEVELS.map((fee, index) => [fee, minLevels[index]!] as const).reverse().forEach(([fee, level]) => insert.run(fee, level, 1))
  for (const fee of NEW_LEVELS) insert.run(fee, 30, 1)
  db.prepare('UPDATE match_rooms SET is_enabled = 0 WHERE stake_amount = 800000').run()
  const rows = readEntryLevelRowsFromMatchRooms(db)
  db.close()
  check('prize_amount не се чете', rows.every((row) => !('prize_amount' in row)))
  const catalog = buildEntryLevelCatalog(rows)
  check('16 валидни нива, подредени по вход', catalog.levels.length === 16 && catalog.levels.every((level, i, all) => i === 0 || all[i - 1]!.entryFee < level.entryFee))
  check('изключеното 800 000 не е в активните', catalog.enabledLevels.length === 15 && !catalog.isEnabled(800_000) && catalog.getLevel(800_000)?.isEnabled === false)
  check('минималните нива са запазени (35 000 → 8, 200 000 → 28)', catalog.getLevel(35_000)?.minLevel === 8 && catalog.getLevel(200_000)?.minLevel === 28)
  check('комисиона по подразбиране 20%', catalog.levels.every((level) => level.siteCommissionBps === 2000 && level.commissionSource === 'default'))
  check('няма проблеми в каталога', catalog.issues.length === 0, catalog.issues)
  const preview = catalog.previewPrizes(1_000_000)
  check('преглед за 1 000 000: Белот 1 600 000 на победител, Свара 4 → 3 200 000', preview?.[0]?.status === 'ok' && preview[0].breakdown.prizePerWinner === 1_600_000
    && preview[3]?.status === 'ok' && preview[3].breakdown.prizePerWinner === 3_200_000)
  check('преглед на непознат вход → null', catalog.previewPrizes(12_345) === null)
}

console.log('\n[9] Каталог: невалидни редове, дубликати, индивидуална комисиона')
{
  const rows: EntryLevelRow[] = [
    { stake_amount: 5000, min_level: 1, is_enabled: 1 },
    { stake_amount: 8000, min_level: 3, is_enabled: 1 },
    { stake_amount: 8000, min_level: 3, is_enabled: 1 },
    { stake_amount: 0, min_level: 1, is_enabled: 1 },
    { stake_amount: 1.5, min_level: 1, is_enabled: 1 },
    { stake_amount: ENTRY_FEE_TECHNICAL_MAX + 1, min_level: 1, is_enabled: 1 },
    { stake_amount: 15000, min_level: 0, is_enabled: 1 },
    { stake_amount: 20000, min_level: 7, is_enabled: 2 },
    { stake_amount: 105, min_level: 1, is_enabled: 1 },
    { stake_amount: 50000, min_level: 10, is_enabled: 1 },
  ]
  const catalog = buildEntryLevelCatalog(rows, { commissionBpsByEntryFee: new Map([[50_000, 1500], [5000, 10_000], [999, 2000]]) })
  check('валидни остават само 105 и 50 000', catalog.levels.map((l) => l.entryFee).join(',') === '105,50000', catalog.levels)
  const codes = catalog.issues.map((issue) => `${String(issue.entryFee)}:${issue.code}`).sort()
  check('дублиран вход → изключен (и двата реда)', codes.filter((code) => code === '8000:duplicate-entry-fee').length === 2)
  check('невалидни вход / ниво / флаг → докладвани', ['0:invalid-entry-fee', '1.5:invalid-entry-fee', `${ENTRY_FEE_TECHNICAL_MAX + 1}:invalid-entry-fee`, '15000:invalid-min-level', '20000:invalid-enabled-flag'].every((code) => codes.includes(code)), codes)
  check('невалидна индивидуална комисиона → нивото е изключено', codes.includes('5000:invalid-commission-override') && catalog.getLevel(5000) === null)
  check('комисиона за несъществуващо ниво → докладвана', codes.includes('999:unknown-commission-override'))
  const level = catalog.getLevel(50_000)
  check('индивидуална 15% за 50 000', level?.siteCommissionBps === 1500 && level.commissionSource === 'override')
  const preview = catalog.previewPrizes(50_000)
  check('преглед 50 000 × 4 при 15% → 170 000', preview?.[3]?.status === 'ok' && preview[3].breakdown.prizePerWinner === 170_000)
  const small = catalog.previewPrizes(105)
  check('вход 105: Свара несъвместима (кратно на 10), Ludo изчислено', small?.[1]?.status === 'incompatible' && small[4]?.status === 'ok' && small[4].breakdown.prizePerWinner === 200)
}

console.log('\n[10] Валидиране на ново ниво (за бъдещото админ управление)')
check('500 000 / ниво 30 → валидно', validateEntryLevelInput({ entryFee: 500_000, minLevel: 30 }).length === 0)
check('1 000 000 / ниво 30 / 20% → валидно', validateEntryLevelInput({ entryFee: 1_000_000, minLevel: 30, siteCommissionBps: 2000 }).length === 0)
check('вход 99 → грешка', validateEntryLevelInput({ entryFee: 99, minLevel: 1 }).some((e) => e.field === 'entryFee'))
check('вход над техническия максимум → грешка', validateEntryLevelInput({ entryFee: ENTRY_FEE_TECHNICAL_MAX + 1, minLevel: 1 }).some((e) => e.field === 'entryFee'))
check('ниво 0 → грешка', validateEntryLevelInput({ entryFee: 5000, minLevel: 0 }).some((e) => e.field === 'minLevel'))
check('комисиона 100% → грешка', validateEntryLevelInput({ entryFee: 5000, minLevel: 1, siteCommissionBps: 10_000 }).some((e) => e.field === 'siteCommissionBps'))

console.log(`\n${failed === 0 ? 'OK' : 'FAILED'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
