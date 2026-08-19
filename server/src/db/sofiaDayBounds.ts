// Converts Europe/Sofia calendar day boundaries to UTC SQLite text timestamps.
// DST-aware: no hard-coded offsets — works for both EET (UTC+2) and EEST (UTC+3).

export type SofiaDayBoundsUtc = {
  yesterdayStart: string // "YYYY-MM-DD HH:MM:SS" UTC
  todayStart: string
  tomorrowStart: string
}

// Format a Date as SQLite UTC text "YYYY-MM-DD HH:MM:SS".
export function toSqliteUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

// Returns the UTC instant for 00:00:00 Europe/Sofia on the given calendar date.
// Handles out-of-range days (day=0 → last day of previous month, etc.).
// Algorithm: at UTC midnight of the target date, read what hour Sofia shows
// (Sofia = UTC + offset, so sofiaHour at UTC midnight equals the offset in hours).
// Then subtract that many hours from UTC midnight to get Sofia's actual midnight.
export function sofiaMidnightUtc(year: number, month: number, day: number): Date {
  // Normalise (handles day=0, day=32, month=0, month=13, etc.)
  const ref = new Date(Date.UTC(year, month - 1, day))
  const y = ref.getUTCFullYear()
  const m = ref.getUTCMonth() + 1
  const d = ref.getUTCDate()

  // At UTC midnight of the target date, Sofia shows (UTC offset) o'clock.
  // E.g.: EEST = UTC+3 → Sofia 03:00 when UTC is 00:00 → offset = 3.
  const utcMidnight = new Date(Date.UTC(y, m - 1, d))
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Sofia',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(utcMidnight)
  const hourValue = parts.find(p => p.type === 'hour')?.value
  if (hourValue === undefined) throw new Error(`sofiaMidnightUtc: Intl did not return hour part for ${y}-${m}-${d}`)
  const parsedHour = Number.parseInt(hourValue, 10)
  if (!Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 24) {
    throw new Error(`sofiaMidnightUtc: unexpected hour value "${hourValue}" for ${y}-${m}-${d}`)
  }
  // 24 is a valid Intl output meaning "midnight next day"; normalise it to 0.
  const sofiaHour = parsedHour % 24

  // Sofia midnight in UTC = UTC midnight − offset hours.
  return new Date(utcMidnight.getTime() - sofiaHour * 3_600_000)
}

// Returns the UTC-text boundaries for yesterday, today, and tomorrow
// according to the Europe/Sofia calendar, for the given instant `now`.
export function getSofiaDayBoundsUtc(now: Date = new Date()): SofiaDayBoundsUtc {
  // Find what calendar date `now` is in Sofia.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const year  = parseInt(parts.find(p => p.type === 'year')!.value,  10)
  const month = parseInt(parts.find(p => p.type === 'month')!.value, 10)
  const day   = parseInt(parts.find(p => p.type === 'day')!.value,   10)

  return {
    yesterdayStart: toSqliteUtc(sofiaMidnightUtc(year, month, day - 1)),
    todayStart:     toSqliteUtc(sofiaMidnightUtc(year, month, day)),
    tomorrowStart:  toSqliteUtc(sofiaMidnightUtc(year, month, day + 1)),
  }
}

export const ADMIN_PAYMENT_PERIODS = ['today', 'yesterday', 'last7days', 'thisMonth', 'allTime'] as const
export type AdminPaymentPeriod = (typeof ADMIN_PAYMENT_PERIODS)[number]

// Builds a WHERE clause fragment for settlement-timestamp filtering by period
// using Europe/Sofia calendar boundaries. Extracted from coinPurchaseStore.ts
// (originally coin-only) so vipPurchaseStore.ts can reuse the EXACT SAME
// timezone/period logic for VIP payment statistics, instead of a parallel
// reimplementation. `col` must be a hardcoded column reference (qualified or
// not) — never derived from HTTP input. `now` is injectable for deterministic
// tests.
export function buildPeriodWhereClause(
  period: AdminPaymentPeriod,
  now: Date,
  col: string,
): { sql: string; params: string[] } {
  const bounds = getSofiaDayBoundsUtc(now)
  // Base guard: paid records must have the settlement timestamp set.
  const notNull = `${col} IS NOT NULL`

  switch (period) {
    case 'today':
      return {
        sql: `${notNull} AND ${col} >= ? AND ${col} < ?`,
        params: [bounds.todayStart, bounds.tomorrowStart],
      }
    case 'yesterday':
      return {
        sql: `${notNull} AND ${col} >= ? AND ${col} < ?`,
        params: [bounds.yesterdayStart, bounds.todayStart],
      }
    case 'last7days': {
      // Current Sofia calendar day + previous 6 full days (7 days total).
      // Start = Sofia midnight 6 days before today; end = tomorrowStart (exclusive).
      const sofiaToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Sofia',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now)
      const y = parseInt(sofiaToday.find(p => p.type === 'year')!.value,  10)
      const m = parseInt(sofiaToday.find(p => p.type === 'month')!.value, 10)
      const d = parseInt(sofiaToday.find(p => p.type === 'day')!.value,   10)
      const windowStart = toSqliteUtc(sofiaMidnightUtc(y, m, d - 6))
      return {
        sql: `${notNull} AND ${col} >= ? AND ${col} < ?`,
        params: [windowStart, bounds.tomorrowStart],
      }
    }
    case 'thisMonth': {
      // Sofia calendar month: from midnight on the 1st of the current Sofia month.
      const sofiaToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Sofia',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now)
      const y = parseInt(sofiaToday.find(p => p.type === 'year')!.value,  10)
      const m = parseInt(sofiaToday.find(p => p.type === 'month')!.value, 10)
      const monthStart = toSqliteUtc(sofiaMidnightUtc(y, m, 1))
      return {
        sql: `${notNull} AND ${col} >= ? AND ${col} < ?`,
        params: [monthStart, bounds.tomorrowStart],
      }
    }
    case 'allTime':
      return { sql: notNull, params: [] }
  }
}
