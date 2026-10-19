import { svaraStartingChipsForEntry } from './engine/svaraChips.js'
import { computeSvaraEntryChips } from './engine/svaraMatch.js'

// Admission policy for NEW test tables. Historical snapshots retain their rules.
export const SVARA_TEST_ENTRY_FEES = [5000, 8000, 15000, 20000, 35000, 50000, 60000, 80000, 100000, 130000, 150000, 180000, 200000] as const
export const SVARA_TEST_ENTRY_PERCENT = 1

export function isSvaraTestEntryFee(value: unknown): value is number {
  return typeof value === 'number' && (SVARA_TEST_ENTRY_FEES as readonly number[]).includes(value)
}

export function getSvaraTableCreationOptions() {
  return {
    entryPercent: SVARA_TEST_ENTRY_PERCENT,
    entries: SVARA_TEST_ENTRY_FEES.map((entryFee) => {
      const startingChips = svaraStartingChipsForEntry(entryFee)
      return { entryFee, startingChips, entryChips: computeSvaraEntryChips(startingChips, SVARA_TEST_ENTRY_PERCENT) }
    }),
  }
}
