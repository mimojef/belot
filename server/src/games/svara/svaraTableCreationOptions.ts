import { svaraStartingChipsForEntry } from './engine/svaraChips.js'
import { computeSvaraEntryChips } from './engine/svaraMatch.js'

// Admission policy for NEW test tables. Historical snapshots retain their rules.
export const SVARA_TEST_ENTRY_FEES = [5000, 8000, 15000, 20000, 35000, 50000, 60000, 80000, 100000, 130000, 150000, 180000, 200000] as const
export const SVARA_TEST_ENTRY_PERCENT = 1

export function isSvaraTestEntryFee(value: unknown): value is number {
  return typeof value === 'number' && (SVARA_TEST_ENTRY_FEES as readonly number[]).includes(value)
}

/**
 * Етап 4В: структурна проверка на входа в парсера (без база): цяло число от
 * 5 000 до 1 000 000 000, кратно на 1 000. Дали входът е РАЗРЕШЕН (активен
 * в конфигурацията) решава lobby-то при създаване на масата.
 */
export function isSvaraEntryFeeShape(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 5_000 && value <= 1_000_000_000 && value % 1_000 === 0
}

/**
 * Етап 3В.2: prize — сървърна функция за наградата (вход, участници) → сума
 * или null. paid — дали масите са платени. Без prize наградите липсват
 * (клиентът не смята сам).
 */
export function getSvaraTableCreationOptions(prize?: { paid: boolean; prizeFor: (entryFee: number, participants: number) => number | null; entryFees?: () => readonly number[] }) {
  // Етап 4В: входовете идват от сървърната конфигурация (активните); без нея — началният списък.
  const entryFees = prize?.entryFees ? prize.entryFees() : SVARA_TEST_ENTRY_FEES
  return {
    entryPercent: SVARA_TEST_ENTRY_PERCENT,
    ...(prize ? { paid: prize.paid } : {}),
    entries: entryFees.map((entryFee) => {
      const startingChips = svaraStartingChipsForEntry(entryFee)
      const prizeByCapacity = prize
        ? { 2: prize.prizeFor(entryFee, 2), 3: prize.prizeFor(entryFee, 3), 4: prize.prizeFor(entryFee, 4) }
        : undefined
      return { entryFee, startingChips, entryChips: computeSvaraEntryChips(startingChips, SVARA_TEST_ENTRY_PERCENT), ...(prizeByCapacity ? { prizeByCapacity } : {}) }
    }),
  }
}
