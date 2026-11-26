// Обща финансова формула за входове и награди (Етап 1 на общата финансова
// основа). Чиста функция — без DB, портфейли, ledger-и или игрови обекти.
// Засега НЕ е свързана с действащите изплащания на Белот / „Не се сърди
// човече“ / Свара.
//
// Правила:
//   фонд            = вход × брой платени входове
//   точна награда   = фонд × (100% − комисиона) ÷ брой победители
//   награда         = точната награда, закръглена до най-близките 100
//                     (остатък под 50 — надолу; 50 и нагоре — нагоре)
//   комисиона сайт  = фонд − всички реално изплатени награди
//
// Комисионата се задава в базисни точки (1% = 100 bps, 20% = 2 000 bps), за да
// остане всичко в цели числа. Изчислението минава през BigInt — никакви
// floating-point операции върху сумите. Невалиден вход или резултат, който не
// може да бъде изплатен безопасно, връща грешка — никога тихо коригиране.

export const PRIZE_ROUNDING_UNIT = 100
export const BASIS_POINTS_SCALE = 10_000
export const DEFAULT_SITE_COMMISSION_BPS = 2_000
/** Комисиона 100% би означавала награда 0 — не е валидна конфигурация. */
export const MAX_SITE_COMMISSION_BPS = BASIS_POINTS_SCALE - 1
/** Техническа граница — фонд и всички суми остават в безопасния целочислен диапазон на JS. */
export const MAX_SAFE_FINANCIAL_AMOUNT = Number.MAX_SAFE_INTEGER

export type PrizeFormulaInput = {
  /** Вход в жълтици за един платен вход. */
  entryFee: number
  /** Брой реално платени входове (определя се от играта). */
  paidEntries: number
  /** Брой победители, които делят наградния фонд поравно. */
  winners: number
  /** Комисиона на сайта в базисни точки (20% = 2 000). */
  siteCommissionBps: number
}

export type PrizeBreakdown = {
  entryFee: number
  paidEntries: number
  winners: number
  siteCommissionBps: number
  /** Събран фонд = вход × платени входове. */
  pot: number
  /** Закръглената награда за ВСЕКИ победител. */
  prizePerWinner: number
  /** Общо изплатено = награда × победители. */
  totalPrize: number
  /** Реална комисиона = фонд − общо изплатено (вкл. ефекта от закръгляването). */
  siteCommission: number
  /**
   * Отклонение от закръгляването спрямо номиналната комисиона, в стотни от
   * жълтица (цяло число): >0 — сайтът е получил повече от номинала,
   * <0 — по-малко. Само за одит.
   */
  roundingDeltaHundredths: number
}

export type PrizeFormulaErrorCode =
  | 'invalid-entry-fee'
  | 'invalid-paid-entries'
  | 'invalid-winners'
  | 'winners-exceed-paid-entries'
  | 'invalid-commission'
  | 'pot-exceeds-safe-range'
  | 'prize-rounds-to-zero'
  | 'prizes-exceed-pot'

export type PrizeFormulaResult =
  | { ok: true; breakdown: PrizeBreakdown }
  | { ok: false; code: PrizeFormulaErrorCode; message: string }

export class PrizeFormulaError extends Error {
  constructor(readonly code: PrizeFormulaErrorCode, message: string) {
    super(message)
    this.name = 'PrizeFormulaError'
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isValidSiteCommissionBps(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SITE_COMMISSION_BPS
}

/** Закръгляне на неотрицателна дроб num/den до най-близкото цяло, половината — нагоре. */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator)
}

export function computePrizeBreakdown(input: PrizeFormulaInput): PrizeFormulaResult {
  const { entryFee, paidEntries, winners, siteCommissionBps } = input
  if (!isPositiveSafeInteger(entryFee)) {
    return { ok: false, code: 'invalid-entry-fee', message: 'Входът трябва да е цяло положително число в безопасния диапазон.' }
  }
  if (!isPositiveSafeInteger(paidEntries)) {
    return { ok: false, code: 'invalid-paid-entries', message: 'Броят платени входове трябва да е цяло положително число.' }
  }
  if (!isPositiveSafeInteger(winners)) {
    return { ok: false, code: 'invalid-winners', message: 'Броят победители трябва да е цяло положително число.' }
  }
  if (winners > paidEntries) {
    return { ok: false, code: 'winners-exceed-paid-entries', message: 'Победителите не може да са повече от платените входове.' }
  }
  if (!isValidSiteCommissionBps(siteCommissionBps)) {
    return { ok: false, code: 'invalid-commission', message: `Комисионата трябва да е цяло число базисни точки от 0 до ${MAX_SITE_COMMISSION_BPS}.` }
  }

  const potBig = BigInt(entryFee) * BigInt(paidEntries)
  if (potBig > BigInt(MAX_SAFE_FINANCIAL_AMOUNT)) {
    return { ok: false, code: 'pot-exceeds-safe-range', message: 'Фондът излиза извън безопасния целочислен диапазон.' }
  }

  const scale = BigInt(BASIS_POINTS_SCALE)
  const unit = BigInt(PRIZE_ROUNDING_UNIT)
  const winnersBig = BigInt(winners)
  // Точна награда на победител = pot × (scale − bps) / (scale × winners);
  // в единици по 100 жълтици: / (scale × winners × unit).
  const exactNumerator = potBig * (scale - BigInt(siteCommissionBps))
  const prizeUnits = roundHalfUp(exactNumerator, scale * winnersBig * unit)
  const prizePerWinnerBig = prizeUnits * unit
  const totalPrizeBig = prizePerWinnerBig * winnersBig

  if (prizePerWinnerBig === 0n) {
    return { ok: false, code: 'prize-rounds-to-zero', message: 'Наградата се закръглява до 0 — фондът е твърде малък.' }
  }
  if (totalPrizeBig > potBig) {
    return { ok: false, code: 'prizes-exceed-pot', message: 'Закръглените награди надхвърлят събрания фонд.' }
  }

  const siteCommissionBig = potBig - totalPrizeBig
  // Номинална комисиона = pot × bps / scale. В стотни: pot × bps / 100.
  // Реална в стотни: siteCommission × 100. Разликата е точна (pot × bps се
  // дели на 100 само понякога — затова сравняваме в общ знаменател).
  const nominalCommissionTimesScale = potBig * BigInt(siteCommissionBps)
  const actualCommissionTimesScale = siteCommissionBig * scale
  const deltaHundredths = roundHalfUp(
    absBig(actualCommissionTimesScale - nominalCommissionTimesScale) * 100n,
    scale,
  ) * (actualCommissionTimesScale >= nominalCommissionTimesScale ? 1n : -1n)

  return {
    ok: true,
    breakdown: {
      entryFee,
      paidEntries,
      winners,
      siteCommissionBps,
      pot: Number(potBig),
      prizePerWinner: Number(prizePerWinnerBig),
      totalPrize: Number(totalPrizeBig),
      siteCommission: Number(siteCommissionBig),
      roundingDeltaHundredths: Number(deltaHundredths),
    },
  }
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value
}

/** Вариант, който хвърля PrizeFormulaError — за места, където невалиден вход е програмна грешка. */
export function requirePrizeBreakdown(input: PrizeFormulaInput): PrizeBreakdown {
  const result = computePrizeBreakdown(input)
  if (!result.ok) throw new PrizeFormulaError(result.code, result.message)
  return result.breakdown
}
