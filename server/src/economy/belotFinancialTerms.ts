// Етап 3Б на общата финансова основа: фиксирани финансови условия на маса
// в Белот.
//
// Всяка (не-турнирна, не-гост) Белот маса със залог получава при създаване
// `room.config.financialTerms` — входът и наградата за победител, валидни
// в този момент. Полето живее в ServerRoom → записва се в
// active_room_snapshots (JSON) и минава през game worker-ите, т.е. оцелява
// при рестарт и възстановяване.
//
// Версии на правилата:
//   'belot-legacy-fixed-prize-v1' — ръчната prize_amount от match_rooms.
//     Само за маси, създадени ПРЕДИ Етап 4В (boot-backfill / исторически).
//   'belot-formula-v1' (Етап 4В) — наградата е изчислена от общата формула
//     (prizeFormula.ts): фонд = 4 платени входа (ботовете също плащат),
//     2 победители, общата комисиона на входа от match_rooms. Комисионата
//     се фиксира заедно с наградата; при четене наградата се проверява
//     отново спрямо формулата (несъответствие → невалидни условия).
//
// И при двете версии наградата се фиксира при създаване на масата —
// по-късни промени в каталога не засягат започнали мачове.

import { computePrizeBreakdown } from './prizeFormula.js'
import { checkCommissionBpsPolicy } from './entryLevelPolicy.js'

export const BELOT_LEGACY_FIXED_PRIZE_RULES = 'belot-legacy-fixed-prize-v1' as const
export const BELOT_FORMULA_RULES = 'belot-formula-v1' as const
/** Белот: 4 платени входа, 2 победители (отборът). */
export const BELOT_PAID_ENTRIES = 4
export const BELOT_WINNERS = 2

export type BelotFinancialRulesVersion = typeof BELOT_LEGACY_FIXED_PRIZE_RULES | typeof BELOT_FORMULA_RULES

/** Наградата за всеки победител в Белот по общата формула (null — невалиден вход/комисиона). */
export function computeBelotPrizePerWinner(entryFee: number, siteCommissionBps: number): number | null {
  if (checkCommissionBpsPolicy(siteCommissionBps).length > 0) return null
  const result = computePrizeBreakdown({ entryFee, paidEntries: BELOT_PAID_ENTRIES, winners: BELOT_WINNERS, siteCommissionBps })
  return result.ok ? result.breakdown.prizePerWinner : null
}

/** Резолвър при фиксиране: число — legacy награда; обект — по формула. */
export type BelotPrizeResolver = (entryFee: number) => number | { prizePerWinner: number; siteCommissionBps: number } | null

export type BelotFinancialTermsPinSource =
  | 'matchmaking-room-created'
  | 'private-room-created'
  /** Маса, създадена преди Етап 3Б — фиксирана при първия старт след внедряване. */
  | 'boot-backfill'

export type BelotFinancialTerms = {
  rulesVersion: BelotFinancialRulesVersion
  /** Вход за един играч (= room.config.stakeAmount). */
  entryFee: number
  /** Награда за всеки победител. */
  prizePerWinner: number
  /** Само при 'belot-formula-v1': фиксираната обща комисиона (bps). */
  siteCommissionBps?: number
  pinnedAt: number
  pinSource: BelotFinancialTermsPinSource
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Фиксира текущите (legacy) условия. Връща null, ако наградата за входа не е
 * известна — тогава НЕ се измисля стойност; payout-ът остава на досегашното
 * поведение (виж resolvePinnedBelotPrize).
 */
export function pinLegacyBelotFinancialTerms(
  entryFee: unknown,
  resolvePrize: BelotPrizeResolver,
  pinSource: BelotFinancialTermsPinSource,
  now: number = Date.now(),
): BelotFinancialTerms | null {
  if (!isPositiveSafeInteger(entryFee)) return null
  const prize = resolvePrize(entryFee)
  if (prize !== null && typeof prize === 'object') {
    // Етап 4В: по формула — наградата се проверява спрямо комисионата.
    if (computeBelotPrizePerWinner(entryFee, prize.siteCommissionBps) !== prize.prizePerWinner) return null
    return {
      rulesVersion: BELOT_FORMULA_RULES,
      entryFee,
      prizePerWinner: prize.prizePerWinner,
      siteCommissionBps: prize.siteCommissionBps,
      pinnedAt: now,
      pinSource,
    }
  }
  if (!isPositiveSafeInteger(prize)) return null
  return {
    rulesVersion: BELOT_LEGACY_FIXED_PRIZE_RULES,
    entryFee,
    prizePerWinner: prize,
    pinnedAt: now,
    pinSource,
  }
}

/** Структурна проверка — данните идват и от JSON snapshot-и. */
export function isValidBelotFinancialTerms(value: unknown): value is BelotFinancialTerms {
  if (typeof value !== 'object' || value === null) return false
  const terms = value as Record<string, unknown>
  if (terms.rulesVersion === BELOT_FORMULA_RULES) {
    return isPositiveSafeInteger(terms.entryFee)
      && isPositiveSafeInteger(terms.prizePerWinner)
      && typeof terms.siteCommissionBps === 'number'
      && computeBelotPrizePerWinner(terms.entryFee, terms.siteCommissionBps) === terms.prizePerWinner
      && typeof terms.pinnedAt === 'number' && Number.isFinite(terms.pinnedAt)
      && typeof terms.pinSource === 'string'
  }
  return terms.rulesVersion === BELOT_LEGACY_FIXED_PRIZE_RULES
    && isPositiveSafeInteger(terms.entryFee)
    && isPositiveSafeInteger(terms.prizePerWinner)
    && typeof terms.pinnedAt === 'number' && Number.isFinite(terms.pinnedAt)
    && typeof terms.pinSource === 'string'
}

/**
 * Три състояния:
 *   - 'missing'  — полето ЛИПСВА (ключът го няма): историческа маса отпреди
 *                  фиксирането → извикващият може да ползва досегашния път;
 *   - валидни    — записаната награда;
 *   - 'invalid' / 'stake-mismatch' — полето Е налично, но повредено
 *                  (вкл. null) или с друг вход → извикващият НЕ бива да
 *                  ползва текущото prize_amount (изплащането се задържа).
 */
export function resolvePinnedBelotPrize(
  config: { stakeAmount?: number | null; financialTerms?: unknown },
): { prize: number } | { prize: null; reason: 'missing' | 'invalid' | 'stake-mismatch' } {
  const terms = config.financialTerms
  if (terms === undefined) return { prize: null, reason: 'missing' }
  if (!isValidBelotFinancialTerms(terms)) return { prize: null, reason: 'invalid' }
  if (terms.entryFee !== config.stakeAmount) return { prize: null, reason: 'stake-mismatch' }
  return { prize: terms.prizePerWinner }
}

/** Кои стаи подлежат на фиксиране: реален залог, не турнир, не гост. */
export function isBelotRoomEligibleForFinancialTerms(
  config: { stakeAmount?: number | null; isGuestTrial?: boolean; isTournamentMatchOrigin?: boolean },
): boolean {
  return isPositiveSafeInteger(config.stakeAmount)
    && config.isGuestTrial !== true
    && config.isTournamentMatchOrigin !== true
}

/**
 * Фиксира условия само ако стаята ги няма (идемпотентно). Връща СЪЩИЯ обект,
 * ако няма промяна — извикващият може да сравни по референция.
 */
export function withPinnedBelotFinancialTerms<
  T extends { config: { stakeAmount?: number | null; isGuestTrial?: boolean; isTournamentMatchOrigin?: boolean; financialTerms?: unknown } },
>(
  room: T,
  resolvePrize: BelotPrizeResolver,
  pinSource: BelotFinancialTermsPinSource,
  now: number = Date.now(),
  preset: BelotFinancialTerms | null = null,
): T {
  // Всяко налично поле (вкл. повредено/null) се оставя непокътнато — backfill
  // НЕ бива да „поправя“ повредени условия с текущата награда.
  if (room.config.financialTerms !== undefined) return room
  if (!isBelotRoomEligibleForFinancialTerms(room.config)) return room
  const terms = preset !== null && preset.entryFee === room.config.stakeAmount && isValidBelotFinancialTerms(preset)
    ? preset
    : pinLegacyBelotFinancialTerms(room.config.stakeAmount, resolvePrize, pinSource, now)
  if (terms === null) return room
  return { ...room, config: { ...room.config, financialTerms: terms } }
}
