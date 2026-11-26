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
//   'belot-legacy-fixed-prize-v1' — наградата е фиксираната prize_amount от
//     match_rooms (ЕДИНСТВЕНАТА активна версия; всички реални изплащания).
//   Бъдещата версия по формула (prizeFormula.ts) НЕ е включена тук и не
//   участва в изплащания — ще получи собствен rulesVersion при активиране.
//
// Размерът на наградите НЕ се променя: фиксира се същата стойност, която
// payout-ът би прочел. Разликата е само кога се чете — при създаване на
// масата, а не при приключване на мача.

export const BELOT_LEGACY_FIXED_PRIZE_RULES = 'belot-legacy-fixed-prize-v1' as const

export type BelotFinancialRulesVersion = typeof BELOT_LEGACY_FIXED_PRIZE_RULES

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
  resolvePrize: (entryFee: number) => number | null,
  pinSource: BelotFinancialTermsPinSource,
  now: number = Date.now(),
): BelotFinancialTerms | null {
  if (!isPositiveSafeInteger(entryFee)) return null
  const prize = resolvePrize(entryFee)
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
  resolvePrize: (entryFee: number) => number | null,
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
