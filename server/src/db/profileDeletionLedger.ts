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

/** Всеки запис в регистъра: самоизтриване (без kind) или административен. */
export type ProfileDeletionLedgerRecord = ProfileDeletionLedgerEntry | AdminProfileDeletionLedgerRecord

export function isAdminProfileDeletionLedgerRecord(record: ProfileDeletionLedgerRecord): record is AdminProfileDeletionLedgerRecord {
  return 'kind' in record
}

/** Ключ за дедупликация: requestId за самоизтриване, kind:operationId за административните. */
export function profileDeletionLedgerRecordKey(record: ProfileDeletionLedgerRecord): string {
  return isAdminProfileDeletionLedgerRecord(record) ? `${record.kind}:${record.operationId}` : record.requestId
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

export function isValidProfileDeletionLedgerRecord(value: unknown): value is ProfileDeletionLedgerRecord {
  if (value !== null && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)) {
    return isValidAdminProfileDeletionLedgerRecord(value)
  }
  return isValidProfileDeletionLedgerEntry(value)
}

/** Един и същ запис (recordedAt може да се различава). */
export function isSameProfileDeletionLedgerRecord(a: ProfileDeletionLedgerRecord, b: ProfileDeletionLedgerRecord): boolean {
  if (isAdminProfileDeletionLedgerRecord(a) !== isAdminProfileDeletionLedgerRecord(b)) return false
  if (!isAdminProfileDeletionLedgerRecord(a)) return isSameProfileDeletionIdentity(a, b as ProfileDeletionLedgerEntry)
  const canonical = (record: ProfileDeletionLedgerRecord) => JSON.stringify(
    Object.entries(record).filter(([key]) => key !== 'recordedAt').sort(([x], [y]) => x.localeCompare(y)),
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
    entries: records.filter((record): record is ProfileDeletionLedgerEntry => !isAdminProfileDeletionLedgerRecord(record)),
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

/** Синхронен append + fsync — връща се едва когато редът е на диска. */
export function appendProfileDeletionLedgerEntry(ledgerPath: string, entry: ProfileDeletionLedgerRecord): void {
  if (!isValidProfileDeletionLedgerRecord(entry)) {
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
  return ensureProfileDeletionLedgerRecord(ledgerPath, entry)
}

/** Същото за всеки вид запис (Етап 4F1) — един ред на ключ. */
export function ensureProfileDeletionLedgerRecord(ledgerPath: string, record: ProfileDeletionLedgerRecord): 'appended' | 'exists' {
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
