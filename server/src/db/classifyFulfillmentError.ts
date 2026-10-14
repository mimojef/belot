// Класификация на техническа грешка при кредитиране: временна (Stripe да
// опита отново → webhook 500) или детерминистична (повторението би дало
// същия резултат → запис за преглед, webhook 200, без безкрайни retry-та).
//
// node:sqlite хвърля Error с числов `errcode` (extended result code); долните
// 8 бита са primary кодът. Временни са само състояния на средата — заключена
// база, I/O, пълен диск, памет. CONSTRAINT/ERROR/CORRUPT/MISMATCH и
// не-SQLite грешки (бъг в кода) се повтарят детерминистично.
const TRANSIENT_SQLITE_PRIMARY_CODES = new Set<number>([
  5, // SQLITE_BUSY
  6, // SQLITE_LOCKED
  7, // SQLITE_NOMEM
  8, // SQLITE_READONLY (напр. временно read-only mount)
  9, // SQLITE_INTERRUPT
  10, // SQLITE_IOERR
  13, // SQLITE_FULL
  14, // SQLITE_CANTOPEN
  15, // SQLITE_PROTOCOL
])

export function isTransientDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) {
    return false
  }

  const errcode = (error as { errcode: unknown }).errcode

  return typeof errcode === 'number' && TRANSIENT_SQLITE_PRIMARY_CODES.has(errcode & 0xff)
}
