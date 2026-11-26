/**
 * checkGameFinancialConfigStage3V1.ts — целеви проверки за Етап 3В.1:
 * server/src/economy/gameFinancialConfig.ts (централизирани конфигурации,
 * валидиране, точни изчисления, неизменими условия на мач).
 *
 * Чисти проверки: без сървър, база, портфейли или ledger-и.
 * Пускане: npx tsx scripts/checkGameFinancialConfigStage3V1.ts
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computePositionPrizes,
  MAX_PRIZE_POSITIONS,
  pinGameMatchFinancialTerms,
  resolveCommissionBps,
  selectPrizeScheme,
  SVARA_DEFAULT_FINANCIAL_CONFIG,
  validateGameFinancialConfig,
  validateGameMatchFinancialTerms,
  validatePrizeScheme,
  type GameFinancialConfig,
} from '../src/economy/gameFinancialConfig.js'
import { computePrizeBreakdown } from '../src/economy/prizeFormula.js'
import { SVARA_TEST_ENTRY_FEES } from '../src/games/svara/svaraTableCreationOptions.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 1500)}`}`)
  }
}

const SERVER_ROOT = join(import.meta.dirname, '..')
const codes = (input: unknown) => {
  const r = validateGameFinancialConfig(input)
  return r.ok ? [] : r.errors.map((e) => e.code)
}
const base = (): Record<string, unknown> => ({
  gameKey: 'svara',
  configVersion: 'test-v1',
  entryFees: [5_000, 10_000],
  defaultCommissionBps: 2_000,
  commissionBpsByEntryFee: {},
  prizeSchemes: [{ minParticipants: 2, sharesBps: [10_000] }],
})

/** Независим референтен изчислител (рационално + BigInt) за кръстосана проверка. */
function referencePrize(entryFee: number, paid: number, bps: number, share: number): number {
  const num = BigInt(entryFee) * BigInt(paid) * BigInt(10_000 - bps) * BigInt(share)
  const den = 10_000n * 10_000n * 100n
  const units = num / den
  const remainder = num % den
  return Number((remainder * 2n >= den ? units + 1n : units) * 100n)
}

console.log('\n[1] Начална конфигурация за „Свара“')
{
  const c = SVARA_DEFAULT_FINANCIAL_CONFIG
  check('13-те входа = списъка на формата „Създай игра“', JSON.stringify(c.entryFees) === JSON.stringify([...SVARA_TEST_ENTRY_FEES]) && c.entryFees.length === 13)
  check('граници: 5 000 … 200 000', c.entryFees[0] === 5_000 && c.entryFees[12] === 200_000)
  check('комисиона 20% (2 000 bps), без индивидуални', c.defaultCommissionBps === 2_000 && Object.keys(c.commissionBpsByEntryFee).length === 0)
  check('една схема: 1 позиция = 100% от наградния фонд', c.prizeSchemes.length === 1 && c.prizeSchemes[0]!.minParticipants === 2 && JSON.stringify(c.prizeSchemes[0]!.sharesBps) === '[10000]')
  check('конфигурацията е замразена', Object.isFrozen(c) && Object.isFrozen(c.entryFees) && Object.isFrozen(c.prizeSchemes[0]!.sharesBps))
  let allMatch = true
  const mismatches: unknown[] = []
  for (const fee of c.entryFees) {
    for (const players of [2, 3, 4]) {
      const pin = pinGameMatchFinancialTerms(c, { entryFee: fee, paidEntries: players, pinnedAt: 1 })
      const legacy = computePrizeBreakdown({ entryFee: fee, paidEntries: players, winners: 1, siteCommissionBps: 2_000 })
      const visual = (fee * players * 4) / 5 // досегашният визуален разчет в UI
      const ok = pin.ok && legacy.ok && pin.terms.prizes[0] === legacy.breakdown.prizePerWinner && pin.terms.prizes[0] === visual
        && pin.terms.siteCommission === fee * players - visual
      if (!ok) { allMatch = false; mismatches.push({ fee, players }) }
    }
  }
  check('39 комбинации (13 входа × 2/3/4): 80% за победителя = computePrizeBreakdown = досегашния UI разчет', allMatch, mismatches)
}

console.log('\n[2] Валидиране: входове')
{
  check('валидна конфигурация', validateGameFinancialConfig(base()).ok)
  check('4 900 → под минимума', codes({ ...base(), entryFees: [4_900] }).includes('entry-fee-below-min'))
  check('1 000 000 100 → над максимума', codes({ ...base(), entryFees: [1_000_000_100] }).includes('entry-fee-above-max'))
  check('5 050 → не е кратно на 100', codes({ ...base(), entryFees: [5_050] }).includes('entry-fee-not-multiple'))
  check('1 000 000 000 (горна граница) ✓', validateGameFinancialConfig({ ...base(), entryFees: [1_000_000_000] }).ok)
  check('дублиран вход', codes({ ...base(), entryFees: [5_000, 5_000] }).includes('duplicate-entry-fee'))
  check('празен списък', codes({ ...base(), entryFees: [] }).includes('invalid-entry-fees'))
  check('„5000“ като низ → отказ', codes({ ...base(), entryFees: ['5000'] }).includes('entry-fee-not-integer'))
  const sorted = validateGameFinancialConfig({ ...base(), entryFees: [20_000, 5_000, 10_000] })
  check('нормализация: сортирани входове', sorted.ok && JSON.stringify(sorted.config.entryFees) === '[5000,10000,20000]')
  check('непозната игра', codes({ ...base(), gameKey: 'poker' }).includes('invalid-game'))
  check('липсваща версия', codes({ ...base(), configVersion: ' ' }).includes('invalid-version'))
  check('не е обект', codes(null).includes('invalid'))
}

console.log('\n[3] Валидиране: комисиони (10%–50%, стъпка 0,01 п.п.)')
{
  check('999 bps → под 10%', codes({ ...base(), defaultCommissionBps: 999 }).includes('commission-below-min'))
  check('5 001 bps → над 50%', codes({ ...base(), defaultCommissionBps: 5_001 }).includes('commission-above-max'))
  check('2 000,5 bps → под стъпката 0,01 п.п.', codes({ ...base(), defaultCommissionBps: 2000.5 }).includes('commission-precision'))
  check('1 000 и 5 000 (граници) ✓', validateGameFinancialConfig({ ...base(), defaultCommissionBps: 1_000 }).ok && validateGameFinancialConfig({ ...base(), defaultCommissionBps: 5_000 }).ok)
  const per = validateGameFinancialConfig({ ...base(), commissionBpsByEntryFee: { 10000: 1_234 } })
  check('комисиона по вход: 10 000 → 12,34%; 5 000 → по подразбиране 20%', per.ok && resolveCommissionBps(per.config, 10_000) === 1_234 && resolveCommissionBps(per.config, 5_000) === 2_000)
  check('комисиона за неразрешен вход → отказ', codes({ ...base(), commissionBpsByEntryFee: { 7000: 2_000 } }).includes('unknown-entry-fee'))
  check('комисиона по вход извън границите → отказ', codes({ ...base(), commissionBpsByEntryFee: { 5000: 6_000 } }).includes('commission-above-max'))
}

console.log('\n[4] Схеми за награди (до 100 позиции, праг по участници)')
{
  // 10 × 5% + 40 × 1% + 50 × 0,2% = 100%, ненарастващи.
  const hundred = Array.from({ length: 100 }, (_, i) => (i < 10 ? 500 : i < 50 ? 100 : 20))
  const sum = hundred.reduce((a, b) => a + b, 0)
  check('тестовата схема със 100 позиции има сума 10 000', sum === 10_000, sum)
  check('100 позиции, праг 100 ✓', validatePrizeScheme({ minParticipants: 100, sharesBps: hundred }).length === 0)
  check('101 позиции → отказ', validatePrizeScheme({ minParticipants: 200, sharesBps: [...hundred, 0] }).some((e) => e.code === 'invalid-positions'))
  check('сума ≠ 10 000 → отказ', validatePrizeScheme({ minParticipants: 2, sharesBps: [6_000, 3_000] }).some((e) => e.code === 'shares-sum'))
  check('нарастващ дял → отказ', validatePrizeScheme({ minParticipants: 3, sharesBps: [3_000, 7_000] }).some((e) => e.code === 'shares-increasing'))
  check('позиции > праг → отказ', validatePrizeScheme({ minParticipants: 2, sharesBps: [5_000, 3_000, 2_000] }).some((e) => e.code === 'positions-exceed-participants'))
  check('дял 0 → отказ', validatePrizeScheme({ minParticipants: 2, sharesBps: [10_000, 0] }).some((e) => e.code === 'invalid-share'))
  check('дублиран праг → отказ', codes({ ...base(), prizeSchemes: [{ minParticipants: 2, sharesBps: [10_000] }, { minParticipants: 2, sharesBps: [6_000, 4_000] }] }).includes('duplicate-threshold'))
  check(`MAX_PRIZE_POSITIONS = 100`, MAX_PRIZE_POSITIONS === 100)

  const multi = validateGameFinancialConfig({
    ...base(),
    prizeSchemes: [{ minParticipants: 50, sharesBps: hundred.slice(0, 50).map((s, i) => (i === 0 ? s + hundred.slice(50).reduce((a, b) => a + b, 0) : s)) }, { minParticipants: 2, sharesBps: [10_000] }, { minParticipants: 100, sharesBps: hundred }],
  })
  check('конфигурация с праг 2 / 50 / 100 е валидна (и се сортира)', multi.ok && multi.config.prizeSchemes.map((s) => s.minParticipants).join(',') === '2,50,100', multi.ok ? null : multi.errors)
  if (multi.ok) {
    check('1 участник → няма схема', selectPrizeScheme(multi.config, 1) === null)
    check('49 участници → схемата за 2+', selectPrizeScheme(multi.config, 49)?.minParticipants === 2)
    check('50 участници → схемата за 50+', selectPrizeScheme(multi.config, 50)?.minParticipants === 50)
    check('120 участници → схемата за 100+', selectPrizeScheme(multi.config, 120)?.minParticipants === 100)
  }
}

console.log('\n[5] Точни изчисления (BigInt, без floating-point)')
{
  // 10 × 5% + 40 × 1% + 50 × 0,2% = 100%, ненарастващи.
  const hundred = Array.from({ length: 100 }, (_, i) => (i < 10 ? 500 : i < 50 ? 100 : 20))
  const r = computePositionPrizes({ entryFee: 5_000, paidEntries: 120, commissionBps: 1_234, sharesBps: hundred })
  check('100 позиции, 120 участници, 12,34% → ok', r.ok)
  if (r.ok) {
    check('всяка награда = независимия референтен изчислител', r.value.prizes.every((p, i) => p === referencePrize(5_000, 120, 1_234, hundred[i]!)))
    check('всички кратни на 100 и > 0', r.value.prizes.every((p) => p > 0 && p % 100 === 0))
    check('комисиона = фонд − изплатено; изплатеното ≤ фонда', r.value.siteCommission === r.value.pot - r.value.totalPrize && r.value.totalPrize <= r.value.pot && r.value.pot === 600_000)
  }
  // Голям вход: float би загубил точност, BigInt — не.
  const big = computePositionPrizes({ entryFee: 1_000_000_000, paidEntries: 4, commissionBps: 1_001, sharesBps: [10_000] })
  check('1 000 000 000 × 4 при 10,01% → точно 3 599 600 000', big.ok && big.value.prizes[0] === 3_599_600_000 && big.value.siteCommission === 400_400_000, big)
  // Половината нагоре: 5 000 × 3 при 12,50% → 13 125 → 13 100; 5 000 × 3 при 11,50% → 13 275 → 13 300.
  const down = computePositionPrizes({ entryFee: 5_000, paidEntries: 3, commissionBps: 1_250, sharesBps: [10_000] })
  const up = computePositionPrizes({ entryFee: 5_000, paidEntries: 3, commissionBps: 1_150, sharesBps: [10_000] })
  check('закръгляне до 100: 13 125 → 13 100; 13 275 → 13 300', down.ok && down.value.prizes[0] === 13_100 && up.ok && up.value.prizes[0] === 13_300)
  const half = computePositionPrizes({ entryFee: 5_000, paidEntries: 2, commissionBps: 1_000, sharesBps: [5_250, 4_750] })
  check('9 000 × 52,5% = 4 725 → 4 700; × 47,5% = 4 275 → 4 300 (половината нагоре)', half.ok && half.value.prizes.join(',') === '4700,4300' && half.value.siteCommission === 1_000, half)
  const exactHalf = computePositionPrizes({ entryFee: 5_000, paidEntries: 2, commissionBps: 1_000, sharesBps: [5_500, 4_500] })
  check('точно ,50 → нагоре: 4 950 → 5 000; 4 050 → 4 100', exactHalf.ok && exactHalf.value.prizes.join(',') === '5000,4100', exactHalf)
  check('позиции > платени входове → грешка', !computePositionPrizes({ entryFee: 5_000, paidEntries: 2, commissionBps: 2_000, sharesBps: [5_000, 3_000, 2_000] }).ok)
  const zero = computePositionPrizes({ entryFee: 100, paidEntries: 2, commissionBps: 5_000, sharesBps: [9_999, 1] })
  check('награда, закръглена до 0 → грешка (не се изплаща 0)', !zero.ok && zero.code === 'prize-rounds-to-zero')
  const overflow = computePositionPrizes({ entryFee: Number.MAX_SAFE_INTEGER, paidEntries: 2, commissionBps: 2_000, sharesBps: [10_000] })
  check('фонд извън безопасния диапазон → грешка', !overflow.ok && overflow.code === 'pot-exceeds-safe-range')
}

console.log('\n[6] Условия на мача: фиксиране, неизменимост, проверка')
{
  const t = pinGameMatchFinancialTerms(SVARA_DEFAULT_FINANCIAL_CONFIG, { entryFee: 35_000, paidEntries: 3, pinnedAt: 1_700_000_000_000 })
  check('Свара 35 000 × 3: фонд 105 000, награда 84 000, сайт 21 000', t.ok && t.terms.pot === 105_000 && t.terms.prizes[0] === 84_000 && t.terms.siteCommission === 21_000)
  check('условията пазят версия, игра, конфигурация, схема', t.ok && t.terms.termsVersion === 'game-match-terms-v1' && t.terms.gameKey === 'svara'
    && t.terms.configVersion === 'svara-default-v1' && t.terms.commissionBps === 2_000 && t.terms.prizeSchemeMinParticipants === 2)
  check('условията са замразени', t.ok && Object.isFrozen(t.terms) && Object.isFrozen(t.terms.prizes) && Object.isFrozen(t.terms.sharesBps))
  check('неразрешен вход → отказ', (() => { const r = pinGameMatchFinancialTerms(SVARA_DEFAULT_FINANCIAL_CONFIG, { entryFee: 7_000, paidEntries: 2 }); return !r.ok && r.code === 'entry-fee-not-allowed' })())
  check('1 участник → няма схема', (() => { const r = pinGameMatchFinancialTerms(SVARA_DEFAULT_FINANCIAL_CONFIG, { entryFee: 5_000, paidEntries: 1 }); return !r.ok && r.code === 'no-prize-scheme' })())

  // „Промяна от администратор“: нова конфигурация с 35% — старите условия не се променят.
  const changed = validateGameFinancialConfig({ ...SVARA_DEFAULT_FINANCIAL_CONFIG, entryFees: [...SVARA_DEFAULT_FINANCIAL_CONFIG.entryFees], configVersion: 'svara-v2', defaultCommissionBps: 3_500, prizeSchemes: [{ minParticipants: 2, sharesBps: [10_000] }] })
  const after = changed.ok ? pinGameMatchFinancialTerms(changed.config, { entryFee: 35_000, paidEntries: 3 }) : null
  check('нова конфигурация → нов мач с 35% (68 250 → 68 300); вече фиксираният остава с 20% и 84 000', t.ok && after?.ok === true && after.terms.prizes[0] === 68_300
    && t.terms.commissionBps === 2_000 && t.terms.prizes[0] === 84_000 && t.terms.configVersion === 'svara-default-v1')
  let mutationBlocked = false
  try { (t.ok ? (t.terms as { prizes: number[] }).prizes : [])[0] = 1 } catch { mutationBlocked = true }
  check('опит за промяна на записа хвърля (strict mode)', mutationBlocked && t.ok && t.terms.prizes[0] === 84_000)

  if (t.ok) {
    const roundTrip = JSON.parse(JSON.stringify(t.terms)) as Record<string, unknown>
    check('JSON round-trip (рестарт) → валидни', validateGameMatchFinancialTerms(roundTrip).ok)
    check('подправена награда → невалидни', !validateGameMatchFinancialTerms({ ...roundTrip, prizes: [90_000] }).ok)
    check('подправена комисиона (без пресмятане) → невалидни', !validateGameMatchFinancialTerms({ ...roundTrip, commissionBps: 1_000 }).ok)
    check('комисиона извън политиката → невалидни', !validateGameMatchFinancialTerms({ ...roundTrip, commissionBps: 6_000 }).ok)
    check('чужда версия → невалидни', !validateGameMatchFinancialTerms({ ...roundTrip, termsVersion: 'v0' }).ok)
    check('по-малко участници от прага на схемата → невалидни', !validateGameMatchFinancialTerms({ ...roundTrip, paidEntries: 1 }).ok)
    check('не е обект → невалидни', !validateGameMatchFinancialTerms(null).ok)
  }
}

console.log('\n[7] Действащите игри не са засегнати')
{
  const diff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--',
    'src/economy/prizeFormula.ts', 'src/economy/entryLevelPolicy.ts', 'src/economy/entryLevelCatalog.ts',
    'src/db/matchEconomyStore.ts', 'src/db/ludoEconomyStore.ts', 'src/db/tournamentEconomyStore.ts',
    'src/tournament/tournamentPrizeRules.ts', 'src/games/svara', 'src/index.ts'], { cwd: SERVER_ROOT, encoding: 'utf8' }).trim()
  check('формулата, политиката, Белот/Ludo/турнири, Свара и index.ts — без промени', diff === '', diff)
  const index = readFileSync(join(SERVER_ROOT, 'src/index.ts'), 'utf8')
  check('новият модул не е свързан с работещия сървър (не активира платена Свара)', !index.includes('gameFinancialConfig'))
  const mod = readFileSync(join(SERVER_ROOT, 'src/economy/gameFinancialConfig.ts'), 'utf8')
  check('модулът е чист: без база, портфейли и ledger-и', !/node:sqlite|DatabaseSync|wallet|ledger_id|INSERT|UPDATE /.test(mod.replace(/\/\/.*$/gm, '')))
}

const typedConfigCheck: GameFinancialConfig = SVARA_DEFAULT_FINANCIAL_CONFIG
void typedConfigCheck

console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
process.exit(failed > 0 ? 1 : 0)
