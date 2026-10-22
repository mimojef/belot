// Самоизтриване на профили — Етап 4: независим регистър на необратимите
// изтривания (append-only JSONL файл ИЗВЪН SQLite базата и uploads/).
//
// Защо: backup-ите на SQLite и uploads се пазят до 90 дни. Restore на стар
// backup би "възкресил" вече окончателно изтрит профил. Редовете в
// profile_deletion_requests са в същата база и биха се върнали заедно с нея,
// затова регистърът живее в отделен файл, който НЕ е част от
// belot-v2.sqlite и НЕ се презаписва от restore процедурата
// (ops/pikabg-backup/scripts/pikabg-restore пише само в scratch директория).
// След restore scripts/reconcileProfileDeletionLedger.ts сравнява
// регистъра с възстановената база (по подразбиране само отчет).
//
// Съдържание — само псевдонимни идентификатори, нужни за повторно
// прилагане: request_id, profile_id, account_id_snapshot,
// profile_created_at_snapshot и времената. БЕЗ имейл, име, IP или токени.
//
// Записът се прави ПРЕДИ транзакцията за изтриване в базата, когато
// заявката вече е необратима (scheduled_for е минал, отмяната е затворена от
// тригер). Дублиране е безвредно — четенето дедуплицира по request_id.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
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

export function getDefaultProfileDeletionLedgerPath(serverRootPath: string): string {
  return join(serverRootPath, 'database', 'deletion-ledger', 'profile-deletions.jsonl')
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

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

/** Синхронен append + fsync — връща се едва когато редът е на диска. */
export function appendProfileDeletionLedgerEntry(ledgerPath: string, entry: ProfileDeletionLedgerEntry): void {
  if (!isValidProfileDeletionLedgerEntry(entry)) {
    throw new Error('profile_deletion_ledger_invalid_entry')
  }
  mkdirSync(dirname(ledgerPath), { recursive: true })
  const line = `${JSON.stringify(entry)}\n`
  const fd = openSync(ledgerPath, 'a', 0o600)
  try {
    writeSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function readProfileDeletionLedger(ledgerPath: string): { entries: ProfileDeletionLedgerEntry[]; invalidLineCount: number } {
  let text: string
  try {
    text = readFileSync(ledgerPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], invalidLineCount: 0 }
    throw error
  }
  const byRequestId = new Map<string, ProfileDeletionLedgerEntry>()
  let invalidLineCount = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
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
    if (!byRequestId.has(parsed.requestId)) byRequestId.set(parsed.requestId, parsed)
  }
  return { entries: [...byRequestId.values()], invalidLineCount }
}
