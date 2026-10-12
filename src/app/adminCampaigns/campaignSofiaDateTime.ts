// Europe/Sofia <-> UTC конверсии за admin "Кампании" редактора на начална/
// крайна дата (<input type="datetime-local"> полета). DST-aware, без
// hardcoded +2/+3 офсет — mirror на established подхода в
// server/src/db/sofiaDayBounds.ts (Intl.DateTimeFormat timeZone:'Europe/Sofia'
// за да прочетем РЕАЛНИЯ wall-clock час в даден UTC момент).
//
// Защо е нужно (production defect, виж CLAUDE.md/repo history за пълния
// отчет): <input type="datetime-local">.value е "wall clock" низ БЕЗ
// timezone информация (напр. "2026-10-20T10:00"). Преди тая поправка:
//   - При показване: datetimeLocalValue() ползваше date.getTimezoneOffset()
//     — offset-ът на БРАУЗЪРА/ОС на оператора, не непременно Europe/Sofia.
//   - При запис: суровият datetime-local низ се пращаше directly към
//     backend-а, който го подаваше на Date.parse(...).toISOString() —
//     низ БЕЗ timezone суфикс се парсва от Date.parse спрямо LOCAL TIME НА
//     NODE ПРОЦЕСА (на production VPS това е системния TZ, обикновено UTC,
//     НЕ Europe/Sofia) -> въведен "10:00" местно Sofia време се записваше
//     като "10:00:00.000Z" (UTC), т.е. изместено с 2-3 часа (EET/EEST).
//     При следващо отваряне/презареждане тая вече изместена UTC стойност
//     се показваше обратно през datetimeLocalValue() -> още едно изместване
//     -> "въведох X, вижда се Y".
// Поправка: и показването, и записът явно конвертират спрямо Europe/Sofia
// (не browser/OS/server TZ), симетрично, с round-trip гаранция.

const SOFIA_TIME_ZONE = 'Europe/Sofia'

/**
 * UTC offset (в минути, Sofia минус UTC) на Europe/Sofia В МОМЕНТА `atUtcMs`.
 * EEST (лято, посл. нед. март - посл. нед. октомври) -> 180; EET (зима) -> 120.
 */
function getSofiaUtcOffsetMinutes(atUtcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SOFIA_TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atUtcMs))
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0')
  // Intl може да върне hour="24" за полунощ в някои ICU версии — нормализирай към 0
  // (mirror на sofiaMidnightUtc в server/src/db/sofiaDayBounds.ts).
  const hour = get('hour') % 24
  // Sofia wall-clock компонентите, прочетени КАТО АКО бяха UTC — разликата
  // с atUtcMs е точно офсета (в минути) в тоя момент.
  const asIfUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
  return Math.round((asIfUtcMs - atUtcMs) / 60_000)
}

/**
 * "YYYY-MM-DDTHH:mm" (Sofia wall-clock, точно форматът на
 * `<input type="datetime-local">.value`) -> коректен UTC ISO string.
 * Връща `null` за празен/невалиден вход (caller-ът пази старата стойност).
 *
 * Известно ограничение (споделено от всяка proста zone-conversion
 * библиотека): за низ, попадащ точно в "изчезналия" или "дублираният" час
 * на DST прехода (last Sunday of March/October, 03:00<->02:00 EET/EEST),
 * резултатът ползва офсета, валиден в приблизителния UTC момент на входа —
 * едно от двете валидни тълкувания, не произволна грешка. Кампании никога
 * не се планират нарочно в тоя едночасов прозорец, затова не е третирано
 * като блокиращ edge case тук.
 */
export function sofiaLocalInputToUtcIso(localValue: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localValue.trim())
  if (match === null) return null
  const [, y, mo, d, h, mi, s] = match
  const naiveUtcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? '0'))
  if (!Number.isFinite(naiveUtcMs)) return null
  const offsetMinutes = getSofiaUtcOffsetMinutes(naiveUtcMs)
  const result = new Date(naiveUtcMs - offsetMinutes * 60_000)
  if (!Number.isFinite(result.getTime())) return null
  return result.toISOString()
}

/**
 * UTC ISO string -> "YYYY-MM-DDTHH:mm" Sofia wall-clock, за
 * `<input type="datetime-local">.value`. Връща `''` за невалиден вход
 * (входът на <input type="datetime-local"> с празна стойност е валиден —
 * показва празно поле, не чупи рендера).
 */
export function utcIsoToSofiaLocalInput(isoValue: string): string {
  const utcMs = Date.parse(isoValue)
  if (!Number.isFinite(utcMs)) return ''
  const offsetMinutes = getSofiaUtcOffsetMinutes(utcMs)
  const sofiaMs = utcMs + offsetMinutes * 60_000
  const d = new Date(sofiaMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** Форматира UTC ISO string за read-only показване в Europe/Sofia местно
 * време (списъчния ред на кампаниите) — explicit timeZone, НЕ зависимост от
 * браузъра/ОС-а на оператора, който преглежда admin панела. */
export function formatSofiaDisplayDateTime(isoValue: string): string {
  const ms = Date.parse(isoValue)
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString('bg-BG', { timeZone: SOFIA_TIME_ZONE })
}
