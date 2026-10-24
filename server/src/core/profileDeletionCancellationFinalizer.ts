// Самоизтриване, Етап 4J1 — довършване на приетите отмени.
//
// Протокол за всяка отмяна (ред в profile_deletion_cancellations):
//   1. ПРИЕТА (в базата) — worker-ът вече не може да изтрие профила, дори
//      offsite backup-ът да не работи дни наред.
//   2. ЗАПИСАНА — ред "request_cancelled" в регистъра на изтриванията (същият
//      append-only файл). Ако регистърът вече има отмяна за заявката (напр.
//      от по-стар backup) — тя се използва; дублиран ред не се пише.
//   3. ОКОНЧАТЕЛНА — само когато offsite ack-ът (реалната проверка
//      isProfileDeletionLedgerRecordConfirmedOffsite: точен байтов префикс +
//      SHA-256) покрива записа. Едва тогава заявката става 'cancelled' и
//      профилът се показва отново.
// Всяка стъпка е идемпотентна: срив между тях се довършва при следващото
// изпълнение (периодично във всеки процес + веднага след приемането).
//
// Регистърът съдържа доказано изтриване ("request_db_deleted") за заявката —
// базата е възстановена и reconcile не е изпълнен: отмяната НЕ се записва и
// не се финализира (изтриването има предимство); приетият ред продължава да
// блокира worker-а, а операторът вижда конфликта (виж runbook-а).

import {
  appendProfileDeletionLedgerEntry,
  isProfileDeletionLedgerRecordConfirmedOffsite,
  profileDeletionCancellationLedgerKey,
  profileDeletionLedgerRecordKey,
  readProfileDeletionLedger,
  type ProfileDeletionRequestCancelledRecord,
} from '../db/profileDeletionLedger.js'
import type { ProfileDeletionCancellationRow, ProfileDeletionCancellationStore } from '../db/profileDeletionCancellationStore.js'
import type { ProfileDeletionCancellationSource } from '../db/profileDeletionLedger.js'

export type ProfileDeletionCancellationOutcome =
  | { state: 'finalized'; requestId: string; profileId: string; source: ProfileDeletionCancellationSource; eventSeq: number }
  | { state: 'awaiting_offsite'; requestId: string }
  | { state: 'ledger_failed'; requestId: string; code: string }
  | { state: 'deletion_proven'; requestId: string }
  | { state: 'gone' }

export type ProfileDeletionCancellationFinalizerDeps = {
  store: ProfileDeletionCancellationStore
  ledgerPath: string
  /** Същата настройка като за worker-а (PROFILE_DELETION_LEDGER_OFFSITE_REQUIRED); изключва се само за локална разработка. */
  offsiteRequired: boolean
  log?: (line: string) => void
}

export type ProfileDeletionCancellationFinalizer = {
  process: (cancellationId: string) => ProfileDeletionCancellationOutcome
  runOnce: (limit?: number) => ProfileDeletionCancellationOutcome[]
}

class LedgerDeletionProvenError extends Error {
  constructor() {
    super('profile_deletion_ledger_deletion_proven')
  }
}

export function createProfileDeletionCancellationFinalizer(deps: ProfileDeletionCancellationFinalizerDeps): ProfileDeletionCancellationFinalizer {
  const log = deps.log ?? (() => {})

  function writeLedger(row: ProfileDeletionCancellationRow): void {
    const ledger = readProfileDeletionLedger(deps.ledgerPath)
    if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) throw new Error('profile_deletion_ledger_corrupt')
    const cancelKey = profileDeletionCancellationLedgerKey(row.requestId)
    const deletedKey = `request_db_deleted:${row.requestId}`
    if (ledger.records.some((record) => profileDeletionLedgerRecordKey(record) === deletedKey)) throw new LedgerDeletionProvenError()
    if (ledger.records.some((record) => profileDeletionLedgerRecordKey(record) === cancelKey)) return
    const record: ProfileDeletionRequestCancelledRecord = {
      v: 1,
      kind: 'request_cancelled',
      requestId: row.requestId,
      profileId: row.profileId,
      cancellationId: row.cancellationId,
      source: row.source,
      recordedAt: new Date().toISOString(),
    }
    appendProfileDeletionLedgerEntry(deps.ledgerPath, record)
  }

  function hasCancellationRecord(requestId: string): boolean {
    const ledger = readProfileDeletionLedger(deps.ledgerPath)
    if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) throw new Error('profile_deletion_ledger_corrupt')
    const key = profileDeletionCancellationLedgerKey(requestId)
    return ledger.records.some((record) => profileDeletionLedgerRecordKey(record) === key)
  }

  function isConfirmed(requestId: string): boolean {
    if (!deps.offsiteRequired) return true
    try {
      return isProfileDeletionLedgerRecordConfirmedOffsite(deps.ledgerPath, profileDeletionCancellationLedgerKey(requestId))
    } catch {
      return false
    }
  }

  function process(cancellationId: string): ProfileDeletionCancellationOutcome {
    const row = deps.store.getByCancellationId(cancellationId)
    if (row === null || row.finalizedAt !== null) return { state: 'gone' }
    try {
      if (row.ledgerRecordedAt === null) deps.store.recordInLedger(cancellationId, writeLedger)
      // Възстановена от регистъра отмяна (restore), а живият регистър още
      // няма записа -> дописва се (иначе offsite потвърждение не би дошло).
      else if (!hasCancellationRecord(row.requestId)) deps.store.runInWriterLock(() => writeLedger(row))
    } catch (error) {
      if (error instanceof LedgerDeletionProvenError) {
        log(`[profile-deletion-cancellation] CONFLICT deletion_proven requestId=${row.requestId} cancellationId=${cancellationId} (run reconcile)`)
        return { state: 'deletion_proven', requestId: row.requestId }
      }
      const code = error instanceof Error ? error.message.slice(0, 80) : 'ledger_write_failed'
      log(`[profile-deletion-cancellation] ledger_failed requestId=${row.requestId} code=${code}`)
      return { state: 'ledger_failed', requestId: row.requestId, code }
    }
    if (!isConfirmed(row.requestId)) return { state: 'awaiting_offsite', requestId: row.requestId }
    const finalized = deps.store.finalize(cancellationId)
    if (!finalized.ok) {
      if (finalized.code !== 'already_finalized') log(`[profile-deletion-cancellation] finalize_refused requestId=${row.requestId} code=${finalized.code}`)
      return { state: 'gone' }
    }
    log(`[profile-deletion-cancellation] finalized requestId=${finalized.requestId} source=${finalized.source}`)
    return { state: 'finalized', requestId: finalized.requestId, profileId: finalized.profileId, source: finalized.source, eventSeq: finalized.eventSeq }
  }

  function runOnce(limit = 100): ProfileDeletionCancellationOutcome[] {
    return deps.store.listUnfinalized(limit).map((row) => {
      try {
        return process(row.cancellationId)
      } catch (error) {
        log(`[profile-deletion-cancellation] error requestId=${row.requestId}: ${error instanceof Error ? error.message : String(error)}`)
        return { state: 'ledger_failed', requestId: row.requestId, code: 'error' } as const
      }
    })
  }

  return { process, runOnce }
}
