// Наградата на „Не се сърди човече“ за показване в мобилния избор на вход.
//
// Огледален на server/src/db/ludoEconomyStore.ts::computeLudoFormulaPrize
// (server/src/economy/prizeFormula.ts::computePrizeBreakdown с 1 победител и
// проверката на комисионата от entryLevelPolicy). Сървърният модул не може да
// се внесе в клиента (erasableSyntaxOnly), затова формулата е повторена тук
// без промяна; съответствието се проверява от
// server/scripts/checkLudoEntryPickerPrizeMirror.ts. Само за показване —
// изплащането остава изцяло на сървъра.

const BASIS_POINTS_SCALE = BigInt(10_000)
const PRIZE_ROUNDING_UNIT = BigInt(100)
const DEFAULT_SITE_COMMISSION_BPS = 2_000
const MIN_COMMISSION_BPS = 1_000
const MAX_COMMISSION_BPS = 5_000

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (BigInt(2) * numerator + denominator) / (BigInt(2) * denominator)
}

/** null — входът/комисионата не дават валидна награда (сървърът също би отказал). */
export function computeLudoEntryPrize(entryFee: number, paidEntries: number, siteCommissionBps: number | null | undefined): number | null {
  const bps = siteCommissionBps ?? DEFAULT_SITE_COMMISSION_BPS
  if (!Number.isSafeInteger(bps) || bps < MIN_COMMISSION_BPS || bps > MAX_COMMISSION_BPS) return null
  if (!Number.isSafeInteger(entryFee) || entryFee <= 0 || !Number.isSafeInteger(paidEntries) || paidEntries <= 0) return null
  const pot = BigInt(entryFee) * BigInt(paidEntries)
  if (pot > BigInt(Number.MAX_SAFE_INTEGER)) return null
  const prize = roundHalfUp(pot * (BASIS_POINTS_SCALE - BigInt(bps)), BASIS_POINTS_SCALE * PRIZE_ROUNDING_UNIT) * PRIZE_ROUNDING_UNIT
  if (prize <= BigInt(0) || prize > pot) return null
  return Number(prize)
}
