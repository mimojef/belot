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
// Формат на файла: всеки ред завършва с '\n'. Непълна "опашка" без '\n'
// (срив по средата на запис) не е записан ред — игнорира се при четене и се
// отрязва преди следващия запис. Невалиден ПЪЛЕН ред е повреда.

import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
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

export type ParsedProfileDeletionLedger = {
  /** Дедуплицирани по requestId (първото срещане). */
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
  const byRequestId = new Map<string, ProfileDeletionLedgerEntry>()
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
    if (!isValidProfileDeletionLedgerEntry(parsed)) {
      invalidLineCount += 1
      continue
    }
    const existing = byRequestId.get(parsed.requestId)
    if (existing === undefined) byRequestId.set(parsed.requestId, parsed)
    else if (!isSameProfileDeletionIdentity(existing, parsed)) conflictingDuplicateCount += 1
  }
  return {
    entries: [...byRequestId.values()],
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
    return { entries: [], lineCount: 0, invalidLineCount: 0, conflictingDuplicateCount: 0, trailingPartialBytes: 0, completeBytes: 0, exists: false }
  }
  return { ...parseProfileDeletionLedgerBuffer(buffer), exists: true }
}

export function serializeProfileDeletionLedgerEntry(entry: ProfileDeletionLedgerEntry): string {
  return `${JSON.stringify(entry)}\n`
}

/** Синхронен append + fsync — връща се едва когато редът е на диска. */
export function appendProfileDeletionLedgerEntry(ledgerPath: string, entry: ProfileDeletionLedgerEntry): void {
  if (!isValidProfileDeletionLedgerEntry(entry)) {
    throw new Error('profile_deletion_ledger_invalid_entry')
  }
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
    writeSync(fd, serializeProfileDeletionLedgerEntry(entry))
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
  const ledger = readProfileDeletionLedger(ledgerPath)
  if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) {
    throw new Error('profile_deletion_ledger_corrupt')
  }
  const existing = ledger.entries.find((candidate) => candidate.requestId === entry.requestId)
  if (existing !== undefined) {
    if (!isSameProfileDeletionIdentity(existing, entry)) throw new Error('profile_deletion_ledger_conflict')
    return 'exists'
  }
  appendProfileDeletionLedgerEntry(ledgerPath, entry)
  return 'appended'
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
  const ack = readProfileDeletionLedgerOffsiteAck(ackPath)
  if (ack === null || ack.bytes === 0) return false
  const buffer = readFileOrNull(ledgerPath)
  if (buffer === null || buffer.length < ack.bytes) return false
  const prefix = buffer.subarray(0, ack.bytes)
  if (prefix[prefix.length - 1] !== 0x0a || sha256Hex(prefix) !== ack.sha256) return false
  const parsed = parseProfileDeletionLedgerBuffer(prefix)
  if (parsed.invalidLineCount > 0 || parsed.conflictingDuplicateCount > 0) return false
  return parsed.entries.some((entry) => entry.requestId === requestId)
}
