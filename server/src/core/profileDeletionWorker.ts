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
// Логовете съдържат само request_id и технически кодове — без имена, имейли,
// пътища до файлове или токени.

import type {
  ClaimedProfileDeletionRequest,
  ProfileDeletionExecutor,
  ProfileDeletionQueuedFile,
} from '../db/profileDeletionExecutor.js'
import type { ProfileDeletionLedgerEntry } from '../db/profileDeletionLedger.js'
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

  async function processRequest(request: ClaimedProfileDeletionRequest, summary: ProfileDeletionWorkerRunSummary): Promise<void> {
    if (request.dbDeletedAt === null) {
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
      const result = deps.executor.runDatabasePhase(request, deps.workerId)
      if (result.kind === 'blocked') {
        summary.blocked += 1
        log(`[profile-deletion-worker] blocked requestId=${request.requestId} code=${result.code}`)
        return
      }
      if (result.kind === 'failed') {
        summary.failed += 1
        log(`[profile-deletion-worker] failed requestId=${request.requestId} code=${result.code} retry=${result.willRetry}`)
        return
      }
      if (result.kind === 'lease_lost') return
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
