// DST-safe начало на текущия календарен ден в Europe/Sofia, върнато като
// UTC timestamp във формата, който SQLite datetime()/сравненията с
// CURRENT_TIMESTAMP очакват ("YYYY-MM-DD HH:MM:SS"). Не подава hardcoded
// UTC+2/+3 offset — Intl.DateTimeFormat с timeZone:'Europe/Sofia' познава
// действителните IANA DST правила (последна неделя на март/октомври),
// значи работи коректно и през прехода зимно/лятно часово време.
const sofiaDatePartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Sofia',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const sofiaOffsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Sofia',
  timeZoneName: 'shortOffset',
})

/**
 * Връща UTC offset-а на Europe/Sofia (в минути, положителен на изток от UTC)
 * в момента nowMs — напр. +120 през зимата (EET), +180 през лятото (EEST).
 */
function getSofiaOffsetMinutes(nowMs: number): number {
  const parts = sofiaOffsetFormatter.formatToParts(new Date(nowMs))
  const offsetPart = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+2'
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(offsetPart)
  if (match === null) {
    return 120
  }
  const hours = Number.parseInt(match[1], 10)
  const minutes = match[2] !== undefined ? Number.parseInt(match[2], 10) : 0
  return hours >= 0 ? hours * 60 + minutes : hours * 60 - minutes
}

/**
 * Началото (00:00:00) на текущия календарен ден в Europe/Sofia, изразено
 * като UTC timestamp "YYYY-MM-DD HH:MM:SS" — директно сравним с
 * yellow_coin_gift_ledger.created_at (naive UTC SQLite CURRENT_TIMESTAMP,
 * виж dbDate.ts). Изчислено чрез: вземи Sofia calendar date частите за
 * nowMs, после извади текущия Sofia UTC offset от "полунощ по Sofia дата,
 * тълкувана буквално като UTC" — това винаги дава правилния UTC instant,
 * независимо дали nowMs пада в EET или EEST, защото offset-ът се чете за
 * СЪЩИЯ nowMs (не се предполага фиксиран).
 */
export function getSofiaDayStartUtcSqliteString(nowMs: number = Date.now()): string {
  const [year, month, day] = sofiaDatePartsFormatter.format(new Date(nowMs)).split('-')
  const offsetMinutes = getSofiaOffsetMinutes(nowMs)
  const midnightAsUtcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0)
  const trueUtcMs = midnightAsUtcMs - offsetMinutes * 60_000
  const iso = new Date(trueUtcMs).toISOString()
  return iso.slice(0, 19).replace('T', ' ')
}
