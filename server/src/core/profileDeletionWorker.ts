// Самоизтриване на профили — Етап 4: един цикъл на worker-а за окончателно
// изтриване. Състоянието е изцяло в SQLite (lease, статуси, опашка), затова
// цикълът е безопасен при няколко Node процеса и продължава след рестарт на
// PM2 — нищо не се пази само в паметта.
//
// Ред за всяка заявка:
//   claim -> (ако базата още не е изтрита) игра в паметта на ТОЗИ процес ->
//   запис в независимия регистър (идемпотентно) -> [Етап 4C] потвърждение,
//   че записът е копиран извън VPS (иначе blocked 'ledger_offsite_pending'
//   и нов опит) -> DB фаза -> файлове -> completed.
//
// Етап 4J1: преди записа на намерението worker-ът проверява регистъра за
// отмяна на заявката ("request_cancelled", напр. база, възстановена отпреди
// отмяната) — ако има, НЕ изтрива, а възстановява трайната защита в базата.
// Етап 4J1B — двуфазно необратимо изтриване:
//   1. намерение потвърдено offsite -> проверки в транзакцията (decisionOnly,
//      нищо не се променя) -> запис "request_deletion_decided" (необратимото
//      решение) -> blocked 'decision_offsite_pending';
//   2. следващ опит: решението е потвърдено offsite -> изтриване (блокировките
//      се проверяват отново) -> COMMIT -> "request_db_deleted" (завършване).
// Така всяко изтриване има решение ИЗВЪН VPS преди COMMIT: restore от
// изоставащ архив не може да "възкреси" профила (отмяна след решението е
// недопустима, reconcile/worker го изтриват отново). Шлюзът на историята
// (historyGate) спира всичко необратимо, докато историята не е проверена, а
// при restore без живото копие нови решения не се вземат до освобождаване.
//
// Логовете съдържат само request_id и технически кодове — без имена, имейли,
// пътища до файлове или токени.

import type {
  ClaimedProfileDeletionRequest,
  ProfileDeletionExecutor,
  ProfileDeletionQueuedFile,
} from '../db/profileDeletionExecutor.js'
import type {
  ProfileDeletionLedgerEntry,
  ProfileDeletionRequestCancelledRecord,
  ProfileDeletionRequestDbDeletedRecord,
  ProfileDeletionRequestDecidedRecord,
} from '../db/profileDeletionLedger.js'
import type {
  ProfileDeletionFileKind,
  ProfileDeletionFileRemovalOutcome,
  ProfileDeletionUploadRoots,
} from '../uploads/profileDeletionFileRemoval.js'

export type ProfileDeletionWorkerDeps = {
  executor: ProfileDeletionExecutor
  workerId: string
  uploadRoots: ProfileDeletionUploadRoots
  removeFile: (kind: ProfileDeletionFileKind, storageRef: string, roots: ProfileDeletionUploadRoots) => Promise<ProfileDeletionFileRemovalOutcome>
  /** Регистър извън SQLite (идемпотентен запис); null = без регистър (само тестове и процедурата след restore). */
  appendLedgerEntry: ((entry: ProfileDeletionLedgerEntry) => void) | null
  /**
   * Етап 4C: true само ако записът за заявката вече е потвърдено копиран
   * извън VPS. Подаден -> изтриване в базата САМО след потвърждение.
   * undefined = без това условие (тестове, процедурата след restore).
   */
  isLedgerEntryConfirmedOffsite?: (requestId: string) => boolean
  /**
   * Етап 4J1: отмяна на заявката в регистъра (null = няма). Хвърля при
   * нечетим/повреден регистър -> нищо не се изтрива (fail-closed).
   * undefined = без проверка (само процедурата след restore — reconcile
   * обработва отмените преди worker-а).
   */
  findLedgerCancellation?: (requestId: string) => ProfileDeletionRequestCancelledRecord | null
  /**
   * Етап 4J1: идемпотентен запис "request_db_deleted" СЛЕД COMMIT на
   * изтриването (доказателство за завършване); грешка не спира файловата
   * фаза, допълва се при продължаване.
   */
  recordDbDeletion?: (record: ProfileDeletionRequestDbDeletedRecord) => void
  /**
   * Етап 4J1B — необратимото решение в регистъра. Подадено -> изтриване САМО
   * след записано решение (и, ако isDecisionConfirmedOffsite е подадено —
   * потвърдено извън VPS). hasDecision хвърля при нечетим регистър.
   */
  decision?: {
    hasDecision: (requestId: string) => boolean
    appendDecision: (record: ProfileDeletionRequestDecidedRecord) => void
    isDecisionConfirmedOffsite?: (requestId: string) => boolean
  }
  /**
   * Етап 4J1B — шлюз на историята (изчислява се от базата и регистъра, не е
   * съхранен флаг). verified=false -> нищо не се взема; restoreHold -> нови
   * решения не се вземат (вече решените се довършват).
   */
  historyGate?: () => { verified: boolean; restoreHold: boolean }
  /** Игра/маса/опашка в паметта на ТОЗИ процес (hasProfileActiveGameCommitment). */
  isProfileInActiveGameLocally?: (profileId: string) => boolean
  log?: (message: string) => void
  maxRequestsPerRun?: number
  /** Само тези заявки (процедурата след restore); по подразбиране — всички с изтекъл срок. */
  onlyRequestIds?: readonly string[]
}

/**
 * Обработка на файлови редове от опашката — ЕДИНСТВЕНАТА реализация, обща
 * за самоизтриването (по заявка) и административното изтриване (по
 * операция, Етап 4F2): claim с lease, споделен файл -> skipped_shared,
 * безопасно изтриване (path/symlink защити в removeFile), липсващ файл =
 * done, временна грешка -> failed с повторен опит, постоянен отказ -> failed
 * без автоматичен опит. beforeEach — напр. удължаване на lease-а на заявката
 * (false = спиране).
 */
export async function processQueuedProfileDeletionFiles(
  deps: Pick<ProfileDeletionWorkerDeps, 'executor' | 'workerId' | 'uploadRoots' | 'removeFile'>,
  files: readonly ProfileDeletionQueuedFile[],
  profileId: string,
  beforeEach?: () => boolean,
): Promise<{ deleted: number; skippedShared: number; failed: number; leaseLost: boolean }> {
  const result = { deleted: 0, skippedShared: 0, failed: 0, leaseLost: false }
  for (const file of files) {
    if (beforeEach !== undefined && !beforeEach()) {
      result.leaseLost = true
      break
    }
    if (!deps.executor.claimFile(file.queueId, deps.workerId)) continue
    if (deps.executor.isStorageRefReferenced(file.fileKind, file.storageRef)) {
      deps.executor.markFileSkippedShared(file, deps.workerId, profileId)
      result.skippedShared += 1
      continue
    }
    let outcome: ProfileDeletionFileRemovalOutcome
    try {
      outcome = await deps.removeFile(file.fileKind, file.storageRef, deps.uploadRoots)
    } catch {
      outcome = { outcome: 'error', code: 'fs_error' }
    }
    if (outcome.outcome === 'deleted' || outcome.outcome === 'missing') {
      deps.executor.markFileDone(file, deps.workerId, profileId, outcome.outcome)
      result.deleted += 1
    } else {
      deps.executor.markFileFailed(file, deps.workerId, profileId, outcome.code, outcome.outcome === 'rejected')
      result.failed += 1
    }
  }
  return result
}

export type ProfileDeletionWorkerRunSummary = {
  claimed: number
  completed: number
  blocked: number
  failed: number
  filesDeleted: number
  filesSkippedShared: number
  filesFailed: number
}

export function createProfileDeletionWorker(deps: ProfileDeletionWorkerDeps): { runOnce: () => Promise<ProfileDeletionWorkerRunSummary> } {
  const log = deps.log ?? (() => {})
  const maxRequests = deps.maxRequestsPerRun ?? 5
  let running = false

  async function processFiles(request: ClaimedProfileDeletionRequest, summary: ProfileDeletionWorkerRunSummary): Promise<boolean> {
    const result = await processQueuedProfileDeletionFiles(
      deps,
      deps.executor.listFilesToProcess(request.requestId),
      request.profileId,
      () => deps.executor.extendLease(request.requestId, deps.workerId),
    )
    summary.filesDeleted += result.deleted
    summary.filesSkippedShared += result.skippedShared
    summary.filesFailed += result.failed
    return !result.leaseLost
  }

  function recordDbDeletion(request: ClaimedProfileDeletionRequest, dbDeletedAt: string): void {
    if (deps.recordDbDeletion === undefined) return
    try {
      deps.recordDbDeletion({ v: 1, kind: 'request_db_deleted', requestId: request.requestId, profileId: request.profileId, dbDeletedAt, recordedAt: new Date().toISOString() })
    } catch {
      log(`[profile-deletion-worker] db_deleted_record_failed requestId=${request.requestId}`)
    }
  }

  /** false -> обработката на заявката спира (блокирана, неуспешна или загубен lease). */
  function handlePhaseResult(request: ClaimedProfileDeletionRequest, result: ReturnType<ProfileDeletionExecutor['runDatabasePhase']>, summary: ProfileDeletionWorkerRunSummary): boolean {
    if (result.kind === 'blocked') {
      summary.blocked += 1
      log(`[profile-deletion-worker] blocked requestId=${request.requestId} code=${result.code}`)
      return false
    }
    if (result.kind === 'failed') {
      summary.failed += 1
      log(`[profile-deletion-worker] failed requestId=${request.requestId} code=${result.code} retry=${result.willRetry}`)
      return false
    }
    return result.kind !== 'lease_lost'
  }

  async function processRequest(request: ClaimedProfileDeletionRequest, summary: ProfileDeletionWorkerRunSummary): Promise<void> {
    if (request.dbDeletedAt === null) {
      if (deps.findLedgerCancellation !== undefined) {
        let recorded: ProfileDeletionRequestCancelledRecord | null
        try {
          recorded = deps.findLedgerCancellation(request.requestId)
        } catch {
          deps.executor.failRequest(request.requestId, deps.workerId, 'ledger_write_failed')
          summary.failed += 1
          log(`[profile-deletion-worker] failed requestId=${request.requestId} code=ledger_unreadable`)
          return
        }
        if (recorded !== null) {
          deps.executor.applyRecordedCancellation(request.requestId, deps.workerId, recorded)
          summary.blocked += 1
          log(`[profile-deletion-worker] cancellation_recorded requestId=${request.requestId}`)
          return
        }
      }
      if (deps.isProfileInActiveGameLocally?.(request.profileId) === true) {
        deps.executor.blockRequest(request.requestId, deps.workerId, 'active_game_local')
        summary.blocked += 1
        log(`[profile-deletion-worker] blocked requestId=${request.requestId} code=active_game_local`)
        return
      }
      if (deps.appendLedgerEntry !== null) {
        try {
          deps.appendLedgerEntry({
            v: 1,
            requestId: request.requestId,
            profileId: request.profileId,
            accountIdSnapshot: request.accountIdSnapshot,
            profileCreatedAtSnapshot: request.profileCreatedAtSnapshot,
            requestedAt: request.requestedAt,
            scheduledFor: request.scheduledFor,
            recordedAt: new Date().toISOString(),
          })
        } catch {
          deps.executor.failRequest(request.requestId, deps.workerId, 'ledger_write_failed')
          summary.failed += 1
          log(`[profile-deletion-worker] failed requestId=${request.requestId} code=ledger_write_failed`)
          return
        }
      }
      if (deps.isLedgerEntryConfirmedOffsite !== undefined) {
        let confirmed = false
        try {
          confirmed = deps.isLedgerEntryConfirmedOffsite(request.requestId)
        } catch {
          confirmed = false
        }
        if (!confirmed) {
          deps.executor.blockRequest(request.requestId, deps.workerId, 'ledger_offsite_pending')
          summary.blocked += 1
          log(`[profile-deletion-worker] blocked requestId=${request.requestId} code=ledger_offsite_pending`)
          return
        }
      }
      // Етап 4J1B — необратимото решение преди изтриването.
      let deletedByCheck = false
      if (deps.decision !== undefined) {
        let decided: boolean
        try {
          decided = deps.decision.hasDecision(request.requestId)
        } catch {
          deps.executor.failRequest(request.requestId, deps.workerId, 'ledger_write_failed')
          summary.failed += 1
          log(`[profile-deletion-worker] failed requestId=${request.requestId} code=ledger_unreadable`)
          return
        }
        if (!decided) {
          if (deps.historyGate?.().restoreHold === true) {
            deps.executor.blockRequest(request.requestId, deps.workerId, 'restore_hold')
            summary.blocked += 1
            log(`[profile-deletion-worker] blocked requestId=${request.requestId} code=restore_hold`)
            return
          }
          const check = deps.executor.runDatabasePhase(request, deps.workerId, { decisionOnly: true })
          if (check.kind !== 'decidable') {
            if (!handlePhaseResult(request, check, summary)) return
            // Профилът вече е изтрит от администратор — само отбелязване, без решение.
            deletedByCheck = true
          } else {
            try {
              deps.decision.appendDecision({ v: 1, kind: 'request_deletion_decided', requestId: request.requestId, profileId: request.profileId, recordedAt: new Date().toISOString() })
            } catch {
              deps.executor.failRequest(request.requestId, deps.workerId, 'ledger_write_failed')
              summary.failed += 1
              log(`[profile-deletion-worker] failed requestId=${request.requestId} code=ledger_write_failed`)
              return
            }
            log(`[profile-deletion-worker] decided requestId=${request.requestId}`)
          }
        }
        if (!deletedByCheck && deps.decision.isDecisionConfirmedOffsite !== undefined) {
          let confirmed = false
          try {
            confirmed = deps.decision.isDecisionConfirmedOffsite(request.requestId)
          } catch {
            confirmed = false
          }
          if (!confirmed) {
            deps.executor.blockRequest(request.requestId, deps.workerId, 'decision_offsite_pending')
            summary.blocked += 1
            log(`[profile-deletion-worker] blocked requestId=${request.requestId} code=decision_offsite_pending`)
            return
          }
        }
      }
      if (!deletedByCheck) {
        const result = deps.executor.runDatabasePhase(request, deps.workerId)
        if (!handlePhaseResult(request, result, summary)) return
        if (result.kind === 'db_deleted') recordDbDeletion(request, result.dbDeletedAt)
      }
    } else {
      // Изтрита в базата преди този опит (срив след COMMIT) — допълване на доказателството.
      recordDbDeletion(request, request.dbDeletedAt)
    }

    if (!(await processFiles(request, summary))) return
    const finished = deps.executor.finishRequest(request.requestId, deps.workerId)
    if (finished.kind === 'completed') {
      summary.completed += 1
      log(`[profile-deletion-worker] completed requestId=${request.requestId}`)
    } else if (finished.kind === 'files_pending') {
      summary.failed += 1
      log(`[profile-deletion-worker] files pending requestId=${request.requestId} retry=${finished.willRetry}`)
    }
  }

  async function runOnce(): Promise<ProfileDeletionWorkerRunSummary> {
    const summary: ProfileDeletionWorkerRunSummary = {
      claimed: 0, completed: 0, blocked: 0, failed: 0, filesDeleted: 0, filesSkippedShared: 0, filesFailed: 0,
    }
    // Един цикъл наведнъж в процеса; между процесите защитава lease-ът в SQLite.
    if (running) return summary
    // Етап 4J1B — непроверена история (restore без reconcile, липсващ/подменен
    // регистър...) -> нищо не се взема.
    if (deps.historyGate !== undefined && !deps.historyGate().verified) {
      log('[profile-deletion-worker] history_unverified — нищо не се изпълнява')
      return summary
    }
    running = true
    try {
      if (deps.onlyRequestIds !== undefined) {
        for (const requestId of deps.onlyRequestIds) {
          const request = deps.executor.claimNextDueRequest(deps.workerId, requestId)
          if (request === null) continue
          summary.claimed += 1
          await processRequest(request, summary)
        }
      } else {
        for (let index = 0; index < maxRequests; index += 1) {
          const request = deps.executor.claimNextDueRequest(deps.workerId)
          if (request === null) break
          summary.claimed += 1
          await processRequest(request, summary)
        }
      }
    } finally {
      running = false
    }
    return summary
  }

  return { runOnce }
}
