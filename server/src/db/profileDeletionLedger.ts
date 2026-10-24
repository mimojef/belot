// Самоизтриване на профили — Етап 4: независим регистър на необратимите
// изтривания (append-only JSONL файл ИЗВЪН SQLite базата и uploads/).
//
// Защо: backup-ите на SQLite и uploads се пазят до 90 дни. Restore на стар
// backup би "възкресил" вече окончателно изтрит профил. Редовете в
// profile_deletion_requests са в същата база и биха се върнали заедно с нея,
// затова регистърът живее в отделен файл, който НЕ е част от
// belot-v2.sqlite и НЕ се презаписва от restore процедурата
// (ops/pikabg-backup/scripts/pikabg-restore пише само в scratch директория).
// След restore src/ops/profileDeletionLedgerReconcile.ts сравнява
// регистъра с възстановената база (по подразбиране само отчет).
//
// Съдържание — само псевдонимни идентификатори, нужни за повторно
// прилагане: request_id, profile_id, account_id_snapshot,
// profile_created_at_snapshot и времената. БЕЗ имейл, име, IP или токени.
//
// Записът се прави ПРЕДИ транзакцията за изтриване в базата, когато
// заявката вече е необратима (scheduled_for е минал, отмяната е затворена от
// тригер), и е идемпотентен (ensureProfileDeletionLedgerEntry — един ред на
// заявка). Етап 4C: изтриването в базата се извършва САМО след като редът е
// потвърдено копиран извън VPS (offsite ack, виж по-долу).
//
// Етап 4F1: в същия регистър са и административните окончателни изтривания
// (записи с поле kind — виж AdminProfileDeletionLedgerRecord по-долу).
//
// Етап 4J1: жизнен цикъл на доброволната заявка в същия регистър (поле kind,
// виж ProfileDeletionRequestLifecycleLedgerRecord):
//   * request_cancelled — отмяна; reconcile/worker я спазват, ако е СЛЕД
//     намерението за изтриване (или намерение няма);
//   * request_db_deleted — необратимото изтриване е започнало: записва се
//     (fsync) ВЪТРЕ в транзакцията на изтриването, непосредствено преди
//     COMMIT (Етап 4J1A). Срив между записа и COMMIT -> повторният опит
//     довършва изтриването. Има предимство пред по-късна отмяна.
// Редът на редовете е значим: файлът е append-only, архивите са байтови
// префикси един на друг, а parse/merge пазят реда на първото срещане.
//
// Формат на файла: всеки ред завършва с '\n'. Непълна "опашка" без '\n'
// (срив по средата на запис) не е записан ред — игнорира се при четене и се
// отрязва преди следващия запис. Невалиден ПЪЛЕН ред е повреда.
//
// Етап 4J1A — междупроцесно заключване (withProfileDeletionLedgerLock):
// всяка промяна на края на файла (отрязване на недовършена опашка + append,
// вкл. проверката "вече има ли такъв запис" в ensure*) става под изключително
// заключване на отделен файл <регистър>.lock (SQLite BEGIN IMMEDIATE ->
// fcntl / LockFileEx). Операционната система го освобождава при смърт на
// процеса — "заседнал" lock няма. Под заключването никой друг не пише, затова
// недовършена опашка е САМО остатък от срив и отрязването никога не засяга
// завършен ред (нито offsite-потвърден префикс — snapshot/ack покриват само
// завършени редове). Читателите (snapshot, confirm, offsite проверки) не
// заключват — те ползват само завършените редове. Ред на заключванията:
// основната база -> регистъра, никога обратното (без deadlock).

import { createHash } from 'node:crypto'
import {
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isCanonicalUtcIsoTimestamp } from './profileDeletionSchedule.js'

export type ProfileDeletionLedgerEntry = {
  v: 1
  requestId: string
  profileId: string
  accountIdSnapshot: string
  profileCreatedAtSnapshot: string
  requestedAt: string
  scheduledFor: string
  recordedAt: string
}

// ─── Етап 4F1: административни окончателни изтривания ─────────────────────
// Същият регистър, отделни видове записи (поле kind) за една административна
// операция (operationId = admin_profile_deletions.log_id):
//   * admin_delete_intent — намерение; пише се ПРЕДИ изтриването и
//     изтриването чака offsite потвърждението му. НЕ е доказателство за
//     изтриване.
//   * admin_delete_completed — изтриването в базата е COMMIT-нато.
//   * admin_delete_resolved_by_self — приключено от самоизтриване (4E6C).
//   * admin_delete_aborted — не е изпълнено (отказ/заменено).
//   * admin_delete_historical — backfill от admin_profile_deletions за
//     изтривания отпреди регистъра (доказано завършени, без намерение).
// Идентификация САМО по immutable profile UUID (+ акаунт/дата на създаване,
// когато са известни). Без имена, имейли, IP или причина (свободен текст).
export type AdminProfileDeletionLedgerRecord =
  | {
      v: 1
      kind: 'admin_delete_intent'
      operationId: string
      profileId: string
      accountIdSnapshot: string | null
      profileCreatedAtSnapshot: string
      actorProfileId: string | null
      supportRequestMessageId: string | null
      requestedAt: string
      recordedAt: string
    }
  | { v: 1; kind: 'admin_delete_completed'; operationId: string; profileId: string; deletedAt: string; recordedAt: string }
  | { v: 1; kind: 'admin_delete_resolved_by_self'; operationId: string; profileId: string; requestId: string; recordedAt: string }
  | { v: 1; kind: 'admin_delete_aborted'; operationId: string; profileId: string; code: string; recordedAt: string }
  | {
      v: 1
      kind: 'admin_delete_historical'
      operationId: string
      profileId: string
      accountIdSnapshot: string | null
      actorProfileId: string | null
      deletedAt: string
      recordedAt: string
    }

export type AdminProfileDeletionLedgerKind = AdminProfileDeletionLedgerRecord['kind']

// ─── Етап 4J1: жизнен цикъл на доброволната заявка ────────────────────────
// Само технически идентификатори: без причина (свободен текст), имейл, име,
// IP или токени. Източникът е само вид (потребител/администратор/система).
export type ProfileDeletionCancellationSource = 'user' | 'admin' | 'system'

export type ProfileDeletionRequestLifecycleLedgerRecord =
  | {
      v: 1
      kind: 'request_cancelled'
      requestId: string
      profileId: string
      cancellationId: string
      source: ProfileDeletionCancellationSource
      recordedAt: string
    }
  | { v: 1; kind: 'request_db_deleted'; requestId: string; profileId: string; dbDeletedAt: string; recordedAt: string }

export type ProfileDeletionRequestCancelledRecord = Extract<ProfileDeletionRequestLifecycleLedgerRecord, { kind: 'request_cancelled' }>
export type ProfileDeletionRequestDbDeletedRecord = Extract<ProfileDeletionRequestLifecycleLedgerRecord, { kind: 'request_db_deleted' }>

/** Всеки запис в регистъра: намерение за самоизтриване (без kind), жизнен цикъл на заявката или административен. */
export type ProfileDeletionLedgerRecord = ProfileDeletionLedgerEntry | AdminProfileDeletionLedgerRecord | ProfileDeletionRequestLifecycleLedgerRecord

export function isAdminProfileDeletionLedgerRecord(record: ProfileDeletionLedgerRecord): record is AdminProfileDeletionLedgerRecord {
  return 'kind' in record && record.kind.startsWith('admin_')
}

export function isRequestLifecycleLedgerRecord(record: ProfileDeletionLedgerRecord): record is ProfileDeletionRequestLifecycleLedgerRecord {
  return 'kind' in record && record.kind.startsWith('request_')
}

/** Намерението за самоизтриване (записът без kind). */
export function isProfileDeletionLedgerIntentEntry(record: ProfileDeletionLedgerRecord): record is ProfileDeletionLedgerEntry {
  return !('kind' in record)
}

/** Ключ за дедупликация: requestId за намерението, kind:requestId за жизнения цикъл, kind:operationId за административните. */
export function profileDeletionLedgerRecordKey(record: ProfileDeletionLedgerRecord): string {
  if (isAdminProfileDeletionLedgerRecord(record)) return `${record.kind}:${record.operationId}`
  if (isRequestLifecycleLedgerRecord(record)) return `${record.kind}:${record.requestId}`
  return record.requestId
}

export function profileDeletionCancellationLedgerKey(requestId: string): string {
  return `request_cancelled:${requestId}`
}

export const PROFILE_DELETION_LEDGER_FILENAME = 'profile-deletions.jsonl'
export const PROFILE_DELETION_LEDGER_OFFSITE_ACK_FILENAME = 'profile-deletions.offsite-ack.json'

export function getDefaultProfileDeletionLedgerPath(serverRootPath: string): string {
  return join(serverRootPath, 'database', 'deletion-ledger', PROFILE_DELETION_LEDGER_FILENAME)
}

export function getProfileDeletionLedgerOffsiteAckPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), PROFILE_DELETION_LEDGER_OFFSITE_ACK_FILENAME)
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const SHA256_RE = /^[0-9a-f]{64}$/

export function isValidProfileDeletionLedgerEntry(value: unknown): value is ProfileDeletionLedgerEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    entry.v === 1 &&
    typeof entry.requestId === 'string' && ID_RE.test(entry.requestId) &&
    typeof entry.profileId === 'string' && ID_RE.test(entry.profileId) &&
    typeof entry.accountIdSnapshot === 'string' && ID_RE.test(entry.accountIdSnapshot) &&
    typeof entry.profileCreatedAtSnapshot === 'string' && entry.profileCreatedAtSnapshot.length >= 1 && entry.profileCreatedAtSnapshot.length <= 64 &&
    typeof entry.requestedAt === 'string' && isCanonicalUtcIsoTimestamp(entry.requestedAt) &&
    typeof entry.scheduledFor === 'string' && isCanonicalUtcIsoTimestamp(entry.scheduledFor) &&
    typeof entry.recordedAt === 'string' && isCanonicalUtcIsoTimestamp(entry.recordedAt)
  )
}

/** Една и съща необратима заявка (recordedAt може да се различава). */
export function isSameProfileDeletionIdentity(a: ProfileDeletionLedgerEntry, b: ProfileDeletionLedgerEntry): boolean {
  return (
    a.requestId === b.requestId &&
    a.profileId === b.profileId &&
    a.accountIdSnapshot === b.accountIdSnapshot &&
    a.profileCreatedAtSnapshot === b.profileCreatedAtSnapshot &&
    a.requestedAt === b.requestedAt &&
    a.scheduledFor === b.scheduledFor
  )
}

const NULLABLE_ID = (value: unknown): boolean => value === null || (typeof value === 'string' && ID_RE.test(value))
const CODE_RE = /^[a-z0-9_]{1,64}$/
const ADMIN_RECORD_KEYS: Record<AdminProfileDeletionLedgerKind, string[]> = {
  admin_delete_intent: ['v', 'kind', 'operationId', 'profileId', 'accountIdSnapshot', 'profileCreatedAtSnapshot', 'actorProfileId', 'supportRequestMessageId', 'requestedAt', 'recordedAt'],
  admin_delete_completed: ['v', 'kind', 'operationId', 'profileId', 'deletedAt', 'recordedAt'],
  admin_delete_resolved_by_self: ['v', 'kind', 'operationId', 'profileId', 'requestId', 'recordedAt'],
  admin_delete_aborted: ['v', 'kind', 'operationId', 'profileId', 'code', 'recordedAt'],
  admin_delete_historical: ['v', 'kind', 'operationId', 'profileId', 'accountIdSnapshot', 'actorProfileId', 'deletedAt', 'recordedAt'],
}

export function isValidAdminProfileDeletionLedgerRecord(value: unknown): value is AdminProfileDeletionLedgerRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const kind = record.kind as AdminProfileDeletionLedgerKind
  const expectedKeys = ADMIN_RECORD_KEYS[kind]
  if (expectedKeys === undefined) return false
  // Точно определените полета — нищо повече (без лични данни "по погрешка").
  const keys = Object.keys(record).sort()
  if (keys.length !== expectedKeys.length || [...expectedKeys].sort().some((key, index) => keys[index] !== key)) return false
  if (record.v !== 1) return false
  if (typeof record.operationId !== 'string' || !ID_RE.test(record.operationId)) return false
  if (typeof record.profileId !== 'string' || !ID_RE.test(record.profileId)) return false
  if (typeof record.recordedAt !== 'string' || !isCanonicalUtcIsoTimestamp(record.recordedAt)) return false
  switch (kind) {
    case 'admin_delete_intent':
      return (
        NULLABLE_ID(record.accountIdSnapshot) &&
        typeof record.profileCreatedAtSnapshot === 'string' && record.profileCreatedAtSnapshot.length >= 1 && record.profileCreatedAtSnapshot.length <= 64 &&
        NULLABLE_ID(record.actorProfileId) &&
        NULLABLE_ID(record.supportRequestMessageId) &&
        typeof record.requestedAt === 'string' && isCanonicalUtcIsoTimestamp(record.requestedAt)
      )
    case 'admin_delete_completed':
      return typeof record.deletedAt === 'string' && isCanonicalUtcIsoTimestamp(record.deletedAt)
    case 'admin_delete_resolved_by_self':
      return typeof record.requestId === 'string' && ID_RE.test(record.requestId)
    case 'admin_delete_aborted':
      return typeof record.code === 'string' && CODE_RE.test(record.code)
    case 'admin_delete_historical':
      return (
        NULLABLE_ID(record.accountIdSnapshot) &&
        NULLABLE_ID(record.actorProfileId) &&
        typeof record.deletedAt === 'string' && isCanonicalUtcIsoTimestamp(record.deletedAt)
      )
    default:
      return false
  }
}

const LIFECYCLE_RECORD_KEYS: Record<ProfileDeletionRequestLifecycleLedgerRecord['kind'], string[]> = {
  request_cancelled: ['v', 'kind', 'requestId', 'profileId', 'cancellationId', 'source', 'recordedAt'],
  request_db_deleted: ['v', 'kind', 'requestId', 'profileId', 'dbDeletedAt', 'recordedAt'],
}

export function isValidRequestLifecycleLedgerRecord(value: unknown): value is ProfileDeletionRequestLifecycleLedgerRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const kind = record.kind as ProfileDeletionRequestLifecycleLedgerRecord['kind']
  const expectedKeys = LIFECYCLE_RECORD_KEYS[kind]
  if (expectedKeys === undefined) return false
  // Точно определените полета — нищо повече (без лични данни "по погрешка").
  const keys = Object.keys(record).sort()
  if (keys.length !== expectedKeys.length || [...expectedKeys].sort().some((key, index) => keys[index] !== key)) return false
  if (record.v !== 1) return false
  if (typeof record.requestId !== 'string' || !ID_RE.test(record.requestId)) return false
  if (typeof record.profileId !== 'string' || !ID_RE.test(record.profileId)) return false
  if (typeof record.recordedAt !== 'string' || !isCanonicalUtcIsoTimestamp(record.recordedAt)) return false
  if (kind === 'request_cancelled') {
    return (
      typeof record.cancellationId === 'string' && ID_RE.test(record.cancellationId) &&
      (record.source === 'user' || record.source === 'admin' || record.source === 'system')
    )
  }
  return typeof record.dbDeletedAt === 'string' && isCanonicalUtcIsoTimestamp(record.dbDeletedAt)
}

export function isValidProfileDeletionLedgerRecord(value: unknown): value is ProfileDeletionLedgerRecord {
  if (value !== null && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)) {
    const kind = (value as Record<string, unknown>).kind
    if (typeof kind === 'string' && kind.startsWith('request_')) return isValidRequestLifecycleLedgerRecord(value)
    return isValidAdminProfileDeletionLedgerRecord(value)
  }
  return isValidProfileDeletionLedgerEntry(value)
}

/** Един и същ запис (recordedAt може да се различава). */
export function isSameProfileDeletionLedgerRecord(a: ProfileDeletionLedgerRecord, b: ProfileDeletionLedgerRecord): boolean {
  if (isProfileDeletionLedgerIntentEntry(a) !== isProfileDeletionLedgerIntentEntry(b)) return false
  if (isProfileDeletionLedgerIntentEntry(a)) return isSameProfileDeletionIdentity(a, b as ProfileDeletionLedgerEntry)
  // Етап 4J1A — "request_db_deleted" се записва преди COMMIT; повторен опит
  // след срив носи нов dbDeletedAt, но е същият факт (заявка + профил).
  const ignored = new Set(isRequestLifecycleLedgerRecord(a) && a.kind === 'request_db_deleted' ? ['recordedAt', 'dbDeletedAt'] : ['recordedAt'])
  const canonical = (record: ProfileDeletionLedgerRecord) => JSON.stringify(
    Object.entries(record).filter(([key]) => !ignored.has(key)).sort(([x], [y]) => x.localeCompare(y)),
  )
  return canonical(a) === canonical(b)
}

export type ParsedProfileDeletionLedger = {
  /** Всички записи, дедуплицирани по ключ (първото срещане). */
  records: ProfileDeletionLedgerRecord[]
  /** Само заявките за самоизтриване (подмножество на records). */
  entries: ProfileDeletionLedgerEntry[]
  /** Пълни (завършващи с '\n') непразни редове. */
  lineCount: number
  /** Пълни редове, които не са валиден запис — повреда. */
  invalidLineCount: number
  /** Същият requestId с различна идентичност — повреда. */
  conflictingDuplicateCount: number
  /** Байтове след последния '\n' (недовършен запис при срив) — не е запис. */
  trailingPartialBytes: number
  /** Дължина до и вкл. последния '\n'. */
  completeBytes: number
}

export function parseProfileDeletionLedgerBuffer(buffer: Buffer): ParsedProfileDeletionLedger {
  const lastNewline = buffer.lastIndexOf(0x0a)
  const completeBytes = lastNewline + 1
  const text = buffer.subarray(0, completeBytes).toString('utf8')
  const byKey = new Map<string, ProfileDeletionLedgerRecord>()
  let lineCount = 0
  let invalidLineCount = 0
  let conflictingDuplicateCount = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    lineCount += 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      invalidLineCount += 1
      continue
    }
    if (!isValidProfileDeletionLedgerRecord(parsed)) {
      invalidLineCount += 1
      continue
    }
    const key = profileDeletionLedgerRecordKey(parsed)
    const existing = byKey.get(key)
    if (existing === undefined) byKey.set(key, parsed)
    else if (!isSameProfileDeletionLedgerRecord(existing, parsed)) conflictingDuplicateCount += 1
  }
  const records = [...byKey.values()]
  return {
    records,
    entries: records.filter(isProfileDeletionLedgerIntentEntry),
    lineCount,
    invalidLineCount,
    conflictingDuplicateCount,
    trailingPartialBytes: buffer.length - completeBytes,
    completeBytes,
  }
}

function readFileOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Липсващ файл = празен регистър (exists=false — извикващият решава дали това е допустимо). */
export function readProfileDeletionLedger(ledgerPath: string): ParsedProfileDeletionLedger & { exists: boolean } {
  const buffer = readFileOrNull(ledgerPath)
  if (buffer === null) {
    return { records: [], entries: [], lineCount: 0, invalidLineCount: 0, conflictingDuplicateCount: 0, trailingPartialBytes: 0, completeBytes: 0, exists: false }
  }
  return { ...parseProfileDeletionLedgerBuffer(buffer), exists: true }
}

export function serializeProfileDeletionLedgerEntry(entry: ProfileDeletionLedgerRecord): string {
  return `${JSON.stringify(entry)}\n`
}

// ─── Етап 4J1A: междупроцесно заключване ──────────────────────────────────
/** Колко дълго се чака заключването (държи се само за кратък локален append + fsync). */
export const PROFILE_DELETION_LEDGER_LOCK_TIMEOUT_MS = 15_000

export function getProfileDeletionLedgerLockPath(ledgerPath: string): string {
  return `${ledgerPath}.lock`
}

const heldLedgerLocks = new Map<string, number>()

/**
 * fn се изпълнява под изключителното заключване на регистъра (между всички
 * процеси). Реентрантно в рамките на процеса (синхронен код). При изтекло
 * чакане хвърля — извикващите го третират като неуспешен запис (fail-closed).
 * fn не трябва да чака основната база (виж реда на заключванията горе).
 */
export function withProfileDeletionLedgerLock<T>(ledgerPath: string, fn: () => T): T {
  const lockPath = getProfileDeletionLedgerLockPath(ledgerPath)
  const depth = heldLedgerLocks.get(lockPath) ?? 0
  if (depth > 0) {
    heldLedgerLocks.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      heldLedgerLocks.set(lockPath, depth)
    }
  }
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  if (!existsSync(lockPath)) {
    closeSync(openSync(lockPath, 'a', 0o600))
    // Създаден от root (ops CLI) -> същият собственик като регистъра, иначе
    // процесът на сървъра не би могъл да заключва (а би отказвал записи).
    if (typeof process.getuid === 'function' && process.getuid() === 0 && existsSync(ledgerPath)) {
      const owner = statSync(ledgerPath)
      chownSync(lockPath, owner.uid, owner.gid)
    }
  }
  const lock = new DatabaseSync(lockPath)
  try {
    lock.exec(`PRAGMA busy_timeout = ${PROFILE_DELETION_LEDGER_LOCK_TIMEOUT_MS};`)
    lock.exec('BEGIN IMMEDIATE;')
    heldLedgerLocks.set(lockPath, 1)
    try {
      return fn()
    } finally {
      heldLedgerLocks.delete(lockPath)
      try { lock.exec('ROLLBACK;') } catch { /* close освобождава заключването */ }
    }
  } finally {
    lock.close()
  }
}

/** Синхронен append + fsync — връща се едва когато редът е на диска. Под междупроцесното заключване. */
export function appendProfileDeletionLedgerEntry(ledgerPath: string, entry: ProfileDeletionLedgerRecord): void {
  if (!isValidProfileDeletionLedgerRecord(entry)) {
    throw new Error('profile_deletion_ledger_invalid_entry')
  }
  withProfileDeletionLedgerLock(ledgerPath, () => appendUnderLock(ledgerPath, entry))
}

function appendUnderLock(ledgerPath: string, entry: ProfileDeletionLedgerRecord): void {
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 })
  // Непълна опашка от прекъснат запис се отрязва, за да не се "залепи"
  // новият ред към нея (би станал невалиден пълен ред). Отделен r+
  // дескриптор: ftruncate върху append дескриптор не е позволен под Windows.
  const existing = readFileOrNull(ledgerPath)
  if (existing !== null) {
    const parsed = parseProfileDeletionLedgerBuffer(existing)
    if (parsed.trailingPartialBytes > 0) {
      const truncateFd = openSync(ledgerPath, 'r+')
      try {
        ftruncateSync(truncateFd, parsed.completeBytes)
        fsyncSync(truncateFd)
      } finally {
        closeSync(truncateFd)
      }
    }
  }
  const fd = openSync(ledgerPath, 'a', 0o600)
  try {
    const bytes = Buffer.from(serializeProfileDeletionLedgerEntry(entry), 'utf8')
    let written = 0
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  fsyncDirectory(dirname(ledgerPath))
}

/**
 * Идемпотентно: ред за същата заявка вече има -> 'exists' (нищо не се
 * пише). Същият requestId с друга идентичност -> грешка (повреда).
 */
export function ensureProfileDeletionLedgerEntry(ledgerPath: string, entry: ProfileDeletionLedgerEntry): 'appended' | 'exists' {
  return ensureProfileDeletionLedgerRecord(ledgerPath, entry)
}

/** Същото за всеки вид запис (Етап 4F1) — един ред на ключ; проверката и записът са под едно заключване. */
export function ensureProfileDeletionLedgerRecord(ledgerPath: string, record: ProfileDeletionLedgerRecord): 'appended' | 'exists' {
  return withProfileDeletionLedgerLock(ledgerPath, () => ensureUnderLock(ledgerPath, record))
}

function ensureUnderLock(ledgerPath: string, record: ProfileDeletionLedgerRecord): 'appended' | 'exists' {
  const ledger = readProfileDeletionLedger(ledgerPath)
  if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) {
    throw new Error('profile_deletion_ledger_corrupt')
  }
  const key = profileDeletionLedgerRecordKey(record)
  const existing = ledger.records.find((candidate) => profileDeletionLedgerRecordKey(candidate) === key)
  if (existing !== undefined) {
    if (!isSameProfileDeletionLedgerRecord(existing, record)) throw new Error('profile_deletion_ledger_conflict')
    return 'exists'
  }
  appendProfileDeletionLedgerEntry(ledgerPath, record)
  return 'appended'
}

// ─── Етап 4J1: състояние на доброволните заявки по регистъра ─────────────
export type RequestLedgerState = {
  requestId: string
  /** Позиция в реда на записите (първо срещане), -1 = няма. */
  intentIndex: number
  intent: ProfileDeletionLedgerEntry | null
  cancelIndex: number
  cancel: ProfileDeletionRequestCancelledRecord | null
  dbDeletedIndex: number
  dbDeleted: ProfileDeletionRequestDbDeletedRecord | null
  /**
   * 'deleted' — доказано изтриване (има предимство; отмяна е недопустима);
   * 'cancelled' — отмяна след намерението (или без намерение): намерението е невалидно;
   * 'cancel_conflict' — отмяна ПРЕДИ намерението: невалидна последователност (fail-closed — нито изтриване, нито отмяна);
   * 'intent' — само намерение (досегашното поведение: изтриването се прилага повторно).
   */
  resolution: 'deleted' | 'cancelled' | 'cancel_conflict' | 'intent'
  /** Има и изтриване, и отмяна — отмяната се пренебрегва (за отчета). */
  cancelIgnored: boolean
}

export function summarizeRequestLedgerState(records: readonly ProfileDeletionLedgerRecord[]): Map<string, RequestLedgerState> {
  const result = new Map<string, RequestLedgerState>()
  const stateFor = (requestId: string): RequestLedgerState => {
    let state = result.get(requestId)
    if (state === undefined) {
      state = { requestId, intentIndex: -1, intent: null, cancelIndex: -1, cancel: null, dbDeletedIndex: -1, dbDeleted: null, resolution: 'intent', cancelIgnored: false }
      result.set(requestId, state)
    }
    return state
  }
  records.forEach((record, index) => {
    if (isAdminProfileDeletionLedgerRecord(record)) return
    const state = stateFor(record.requestId)
    if (isProfileDeletionLedgerIntentEntry(record)) {
      if (state.intent === null) { state.intent = record; state.intentIndex = index }
    } else if (record.kind === 'request_cancelled') {
      if (state.cancel === null) { state.cancel = record; state.cancelIndex = index }
    } else if (state.dbDeleted === null) {
      state.dbDeleted = record
      state.dbDeletedIndex = index
    }
  })
  for (const state of result.values()) {
    if (state.dbDeleted !== null) {
      state.resolution = 'deleted'
      state.cancelIgnored = state.cancel !== null
    } else if (state.cancel !== null) {
      state.resolution = state.intent !== null && state.cancelIndex < state.intentIndex ? 'cancel_conflict' : 'cancelled'
    } else {
      state.resolution = 'intent'
    }
  }
  return result
}

// ─── Етап 4F1: състояние на административните операции ───────────────────
export type AdminLedgerOperationState = 'intent_only' | 'completed' | 'resolved_by_self' | 'aborted' | 'conflict'

export type AdminLedgerOperation = {
  operationId: string
  profileId: string
  state: AdminLedgerOperationState
  intent: Extract<AdminProfileDeletionLedgerRecord, { kind: 'admin_delete_intent' }> | null
  /** completed/historical — доказано завършено изтриване. */
  deletedAt: string | null
  accountIdSnapshot: string | null
  profileCreatedAtSnapshot: string | null
  actorProfileId: string | null
  supportRequestMessageId: string | null
  resolvedByRequestId: string | null
}

/**
 * Обобщава административните записи по operationId. Повече от един краен
 * запис (завършено + отказано и т.н.) или различен profileId -> 'conflict'
 * (повреда — извикващият отказва fail-closed).
 */
export function summarizeAdminLedgerOperations(records: readonly ProfileDeletionLedgerRecord[]): Map<string, AdminLedgerOperation> {
  const grouped = new Map<string, AdminProfileDeletionLedgerRecord[]>()
  for (const record of records) {
    if (!isAdminProfileDeletionLedgerRecord(record)) continue
    const list = grouped.get(record.operationId) ?? []
    list.push(record)
    grouped.set(record.operationId, list)
  }
  const result = new Map<string, AdminLedgerOperation>()
  for (const [operationId, list] of grouped) {
    const intent = (list.find((record) => record.kind === 'admin_delete_intent') ?? null) as AdminLedgerOperation['intent']
    const historical = list.find((record) => record.kind === 'admin_delete_historical') as Extract<AdminProfileDeletionLedgerRecord, { kind: 'admin_delete_historical' }> | undefined
    const completed = list.find((record) => record.kind === 'admin_delete_completed') as Extract<AdminProfileDeletionLedgerRecord, { kind: 'admin_delete_completed' }> | undefined
    const resolved = list.find((record) => record.kind === 'admin_delete_resolved_by_self') as Extract<AdminProfileDeletionLedgerRecord, { kind: 'admin_delete_resolved_by_self' }> | undefined
    const aborted = list.find((record) => record.kind === 'admin_delete_aborted')
    const terminals = [historical, completed, resolved, aborted].filter((record) => record !== undefined).length
    const profileIds = new Set(list.map((record) => record.profileId))
    let state: AdminLedgerOperationState
    if (profileIds.size !== 1 || terminals > 1 || (historical !== undefined && intent !== null)) state = 'conflict'
    else if (completed !== undefined || historical !== undefined) state = 'completed'
    else if (resolved !== undefined) state = 'resolved_by_self'
    else if (aborted !== undefined) state = 'aborted'
    else state = 'intent_only'
    result.set(operationId, {
      operationId,
      profileId: list[0]!.profileId,
      state,
      intent,
      deletedAt: completed?.deletedAt ?? historical?.deletedAt ?? null,
      accountIdSnapshot: intent?.accountIdSnapshot ?? historical?.accountIdSnapshot ?? null,
      profileCreatedAtSnapshot: intent?.profileCreatedAtSnapshot ?? null,
      actorProfileId: intent?.actorProfileId ?? historical?.actorProfileId ?? null,
      supportRequestMessageId: intent?.supportRequestMessageId ?? null,
      resolvedByRequestId: resolved?.requestId ?? null,
    })
  }
  return result
}

function fsyncDirectory(directoryPath: string): void {
  // Windows не позволява fsync на директория — там rename/append са
  // достатъчни за тестовете; production (Linux) получава истински fsync.
  if (process.platform === 'win32') return
  const fd = openSync(directoryPath, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Атомичен запис: временен файл + fsync + rename (+ fsync на директорията). */
export function writeFileAtomicallySync(path: string, content: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(tmpPath, 'w', mode)
  try {
    writeSync(fd, typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
  fsyncDirectory(dirname(path))
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

// ─── Етап 4C: потвърждение, че регистърът е копиран извън VPS ─────────────
// Пише се от ops/pikabg-backup/scripts/pikabg-ledger-backup СЛЕД проверено
// качване (хеш на отдалеченото копие). Описва точен ПРЕФИКС на регистъра
// (bytes + sha256): всеки ред в този префикс е извън VPS. Без лични данни.
export type ProfileDeletionLedgerOffsiteAck = {
  v: 1
  bytes: number
  sha256: string
  lineCount: number
  entryCount: number
  remotePath: string
  confirmedAt: string
}

export function isValidProfileDeletionLedgerOffsiteAck(value: unknown): value is ProfileDeletionLedgerOffsiteAck {
  if (value === null || typeof value !== 'object') return false
  const ack = value as Record<string, unknown>
  return (
    ack.v === 1 &&
    Number.isInteger(ack.bytes) && (ack.bytes as number) >= 0 &&
    typeof ack.sha256 === 'string' && SHA256_RE.test(ack.sha256) &&
    Number.isInteger(ack.lineCount) && (ack.lineCount as number) >= 0 &&
    Number.isInteger(ack.entryCount) && (ack.entryCount as number) >= 0 &&
    typeof ack.remotePath === 'string' && ack.remotePath.length >= 1 && ack.remotePath.length <= 1024 &&
    typeof ack.confirmedAt === 'string' && isCanonicalUtcIsoTimestamp(ack.confirmedAt)
  )
}

export function readProfileDeletionLedgerOffsiteAck(ackPath: string): ProfileDeletionLedgerOffsiteAck | null {
  const buffer = readFileOrNull(ackPath)
  if (buffer === null) return null
  try {
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown
    return isValidProfileDeletionLedgerOffsiteAck(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeProfileDeletionLedgerOffsiteAck(ackPath: string, ack: ProfileDeletionLedgerOffsiteAck): void {
  if (!isValidProfileDeletionLedgerOffsiteAck(ack)) throw new Error('profile_deletion_ledger_invalid_ack')
  writeFileAtomicallySync(ackPath, `${JSON.stringify(ack)}\n`, 0o644)
}

/**
 * true САМО ако текущият регистър започва точно с потвърдения префикс
 * (същите байтове — регистърът само е растял) И заявката е в този префикс.
 * Липсващ/невалиден ack, съкратен или подменен регистър -> false (fail-closed).
 */
export function isProfileDeletionLedgerRequestConfirmedOffsite(
  ledgerPath: string,
  requestId: string,
  ackPath: string = getProfileDeletionLedgerOffsiteAckPath(ledgerPath),
): boolean {
  return isProfileDeletionLedgerRecordConfirmedOffsite(ledgerPath, requestId, ackPath)
}

/** Етап 4F1: същото по ключ на запис (напр. 'admin_delete_intent:<operationId>'). */
export function isProfileDeletionLedgerRecordConfirmedOffsite(
  ledgerPath: string,
  recordKey: string,
  ackPath: string = getProfileDeletionLedgerOffsiteAckPath(ledgerPath),
): boolean {
  const ack = readProfileDeletionLedgerOffsiteAck(ackPath)
  if (ack === null || ack.bytes === 0) return false
  const buffer = readFileOrNull(ledgerPath)
  if (buffer === null || buffer.length < ack.bytes) return false
  const prefix = buffer.subarray(0, ack.bytes)
  if (prefix[prefix.length - 1] !== 0x0a || sha256Hex(prefix) !== ack.sha256) return false
  const parsed = parseProfileDeletionLedgerBuffer(prefix)
  if (parsed.invalidLineCount > 0 || parsed.conflictingDuplicateCount > 0) return false
  return parsed.records.some((record) => profileDeletionLedgerRecordKey(record) === recordKey)
}
