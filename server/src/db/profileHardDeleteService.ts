import { randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'
import { processQueuedProfileDeletionFiles } from '../core/profileDeletionWorker.js'
import {
  removeProfileDeletionFile,
  type ProfileDeletionFileKind,
  type ProfileDeletionFileRemovalOutcome,
  type ProfileDeletionUploadRoots,
} from '../uploads/profileDeletionFileRemoval.js'
import { createProfileDeletionExecutor, type ProfileDeletionExecutorOptions } from './profileDeletionExecutor.js'
import { createProfileDeletionParticipationChecks } from './profileDeletionParticipationChecks.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type HardDeleteProfileResult =
  | {
      ok: true
      deletedProfileId: ProfileId
      deletedAccountId: string | null
      /** Етап 4F2 — log_id на одитния ред = собственик на файловете в опашката. */
      operationId: string
      /** Етап 4F2 — файлови операции, които още не са приключили (0 = файловата фаза е done). */
      filesPending: number
    }
  | {
      ok: false
      code:
        | 'not_found'
        | 'self'
        | 'invalid_reason'
        | 'active_tournament_dependency'
        | 'invalid_support_request_message'
        | 'campaign_gift_sender_protected'
        | 'forbidden'
    }

export type AdminFileCleanupRunSummary = {
  operations: number
  completed: number
  filesDeleted: number
  filesSkippedShared: number
  filesFailed: number
}

export type ProfileHardDeleteService = {
  /**
   * Административното окончателно изтриване (Етап 4F2 — уеднаквено със
   * самоизтриването). Реалното заличаване е profileDeletionExecutor.
   * executeAdminHardDelete: административните проверки (незавършен турнир,
   * кампаниен подател, валидна support заявка), одитен ред ПРЕДИ
   * заличаването (log_id = auditLogId/operationId, file_cleanup_status =
   * 'pending'), support архив само при изрично валидирано съобщение, и СЪЩОТО
   * ядро (deleteProfileDataInTransaction) със СЪЩАТА файлова опашка като
   * самоизтриването — Теми (А1/Б1), лични разговори, поддръжка, история на
   * игрите, имена, кампании, оценки, модераторски записи, IP/visitor връзки,
   * финансови и модераторски инварианти, всичко в ЕДНА BEGIN IMMEDIATE
   * транзакция.
   *
   * Физическите файлове: записани в опашката в същата транзакция; веднага
   * след COMMIT се прави опит (когато са подадени uploadRoots), а
   * недовършените се довършват от processPendingAdminFileCleanup
   * (периодичния runner на adminProfileDeletionCoordinator) с повторни
   * опити. filesPending > 0 = базата е изтрита, файловата фаза — още не.
   *
   * Account cardinality: акаунтът се трие само ако това е бил единственият
   * му профил (преброено в същата транзакция).
   */
  hardDeleteProfile: (input: {
    targetProfileId: ProfileId
    actorProfileId: ProfileId
    actorAccountId: string
    reason: string
    /**
     * Optional — само когато admin е натиснал "Изтрий профила по тази
     * заявка" от вътре в конкретен support разговор. Validate-ва се
     * authoritative вътре в транзакцията, НЕ се приема на доверие от клиента.
     */
    supportRequestMessageId?: string | null
    /**
     * Етап 4F1 — log_id на одитния ред = operationId в регистъра на
     * изтриванията (иначе нов UUID).
     */
    auditLogId?: string
    /**
     * Етап 4F1 — повторно прилагане след restore на вече ЗАВЪРШЕНО
     * административно изтриване: оригиналният момент (SQLite datetime);
     * липсващ актьор -> NULL; support заявка, която я няма във
     * възстановеното копие -> без архивен ред (вместо отказ).
     */
    replay?: { deletedAt: string }
  }) => Promise<HardDeleteProfileResult>
  /**
   * Етап 4F2 — повторни опити за всички административни операции с
   * недовършена файлова фаза (file_cleanup_status = 'pending'). Без
   * uploadRoots — no-op (файловете остават в опашката).
   */
  processPendingAdminFileCleanup: () => Promise<AdminFileCleanupRunSummary>
  /**
   * Read-only pre-check: незавършен турнир (creator или активно участие).
   * hardDeleteProfile проверява отново authoritative в транзакцията.
   */
  hasActiveTournamentDependency: (profileId: ProfileId) => boolean
  /**
   * Read-only pre-check: профилът е предоставял кампанийни награди
   * (gift_item_transactions.context='campaign_reward'). Защитата не "изчезва"
   * сама; hardDeleteProfile проверява отново в транзакцията.
   */
  hasCampaignGiftSenderHistory: (profileId: ProfileId) => boolean
  /**
   * Forensic справка (без call site в runtime): изтрити профили, свързани с
   * този anonymous_visitor_id (стари admin snapshot-и + compact връзки).
   * Етап 4F2: нови snapshot-и не се създават, а връзките на изтрития профил
   * се трият — справката обхваща само наследени записи.
   */
  findDeletedProfileIdsForVisitorId: (visitorId: string) => ProfileId[]
  /** Като findDeletedProfileIdsForVisitorId, по ip_address, с 48h recency. */
  findDeletedProfileIdsForIp: (ipAddress: string) => ProfileId[]
  /**
   * true, ако изтритият профил е имал активно заглушаване в Теми/Лафче в
   * момента на административното изтриване и то още не е изтекло.
   */
  hasActiveMuteSnapshotForDeletedProfile: (deletedProfileId: ProfileId) => boolean
  close: () => void
}

export type ProfileHardDeleteFileCleanupDeps = {
  /**
   * Етап 4F2 — разрешените upload директории (същите като за
   * самоизтриването). С тях файловете се изтриват веднага след COMMIT и при
   * повторните опити; без тях остават в опашката, докато процес с
   * директориите ги обработи.
   */
  uploadRoots?: ProfileDeletionUploadRoots
  /** Само за тестове: подмяна на физическото изтриване (симулирани грешки). */
  removeFile?: (kind: ProfileDeletionFileKind, storageRef: string, roots: ProfileDeletionUploadRoots) => Promise<ProfileDeletionFileRemovalOutcome>
  /**
   * Остарял (до Етап 4F1): best-effort изтриване на аватар/галерия по URL.
   * Вече НЕ се използва — всички файлове минават през надеждната опашка.
   * Приема се само за съвместимост на съществуващите извиквания.
   */
  deleteUploadFileByUrl?: (uploadUrl: string) => Promise<void>
  /** Само за тестове: hooks на executor-а (симулиран срив преди COMMIT). */
  executorOptions?: ProfileDeletionExecutorOptions
}

export async function createProfileHardDeleteService(
  databaseFilePath: string,
  fileCleanup: ProfileHardDeleteFileCleanupDeps,
): Promise<ProfileHardDeleteService> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const executor = await createProfileDeletionExecutor(databaseFilePath, fileCleanup.executorOptions ?? {})
  const participationChecks = createProfileDeletionParticipationChecks(database)
  const workerId = `admin-delete:${process.pid}:${randomUUID().slice(0, 8)}`
  const removeFile = fileCleanup.removeFile ?? removeProfileDeletionFile

  const selectCampaignGiftSenderHistoryStatement = database.prepare(`
    SELECT 1 FROM gift_item_transactions
    WHERE sender_profile_id = ? AND context = 'campaign_reward'
    LIMIT 1;
  `)

  // Forensic справки върху наследени записи (виж типа по-горе).
  const selectDeletedProfileIdsForVisitorIdStatement = database.prepare(`
    SELECT deleted_profile_id
    FROM admin_profile_deletion_visitor_snapshots
    WHERE anonymous_visitor_id = ?
    UNION
    SELECT l.profile_id
    FROM profile_visitor_links l
    WHERE l.anonymous_visitor_id = ?
      AND EXISTS (SELECT 1 FROM admin_profile_deletions d WHERE d.deleted_profile_id = l.profile_id)
      AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = l.profile_id);
  `)

  const selectDeletedProfileIdsForIpStatement = database.prepare(`
    SELECT deleted_profile_id
    FROM admin_profile_deletion_visitor_snapshots
    WHERE ip_address = ?
      AND last_seen_at >= datetime('now', '-48 hours')
    UNION
    SELECT l.profile_id
    FROM profile_ip_links l
    WHERE l.ip_address = ?
      AND l.last_seen_at >= datetime('now', '-48 hours')
      AND EXISTS (SELECT 1 FROM admin_profile_deletions d WHERE d.deleted_profile_id = l.profile_id)
      AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = l.profile_id);
  `)

  const selectActiveMuteSnapshotForDeletedProfileStatement = database.prepare(`
    SELECT 1
    FROM admin_profile_deletion_moderation_snapshots
    WHERE deleted_profile_id = ?
      AND active_topics_mute_until > CURRENT_TIMESTAMP
    LIMIT 1;
  `)

  /** Файловата фаза на една операция: обработка на готовите редове + приключване при нужда. */
  async function runAdminFileCleanup(operationId: string, profileId: string, summary: AdminFileCleanupRunSummary): Promise<void> {
    const roots = fileCleanup.uploadRoots
    if (roots !== undefined) {
      const result = await processQueuedProfileDeletionFiles(
        { executor, workerId, uploadRoots: roots, removeFile },
        executor.listAdminFilesToProcess(operationId),
        profileId,
      )
      summary.filesDeleted += result.deleted
      summary.filesSkippedShared += result.skippedShared
      summary.filesFailed += result.failed
    }
    const finished = executor.finishAdminFileCleanup(operationId)
    if (finished.kind === 'done') {
      summary.completed += 1
    } else if (finished.kind === 'files_pending' && !finished.willRetry) {
      // Постоянен отказ (напр. опасен път/symlink) — ръчна проверка; без файлови пътища в лога.
      console.error(`[admin-profile-delete] file_cleanup_stuck operationId=${operationId}`)
    }
  }

  async function hardDeleteProfile(input: Parameters<ProfileHardDeleteService['hardDeleteProfile']>[0]): Promise<HardDeleteProfileResult> {
    const result = executor.executeAdminHardDelete(input)
    if (!result.ok) return result
    let filesPending = 0
    if (result.enqueuedFileCount > 0) {
      // DB COMMIT вече е необратим — грешка тук не прави изтриването "неуспешно";
      // файловете остават в опашката за повторните опити.
      try {
        const summary: AdminFileCleanupRunSummary = { operations: 1, completed: 0, filesDeleted: 0, filesSkippedShared: 0, filesFailed: 0 }
        await runAdminFileCleanup(result.operationId, result.deletedProfileId, summary)
        filesPending = summary.completed === 1 ? 0 : countPendingFiles(result.operationId)
      } catch (error) {
        console.error(`[admin-profile-delete] file_cleanup_failed operationId=${result.operationId}:`, error instanceof Error ? error.message : 'unknown error')
        filesPending = countPendingFiles(result.operationId)
      }
    }
    return {
      ok: true,
      deletedProfileId: result.deletedProfileId,
      deletedAccountId: result.deletedAccountId,
      operationId: result.operationId,
      filesPending,
    }
  }

  const countPendingFilesStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM profile_deletion_file_queue
    WHERE admin_operation_id = ? AND status NOT IN ('done', 'skipped_shared');
  `)

  function countPendingFiles(operationId: string): number {
    return (countPendingFilesStatement.get(operationId) as { cnt: number }).cnt
  }

  async function processPendingAdminFileCleanup(): Promise<AdminFileCleanupRunSummary> {
    const summary: AdminFileCleanupRunSummary = { operations: 0, completed: 0, filesDeleted: 0, filesSkippedShared: 0, filesFailed: 0 }
    for (const operation of executor.listAdminOperationsPendingFileCleanup()) {
      summary.operations += 1
      try {
        await runAdminFileCleanup(operation.operationId, operation.profileId, summary)
      } catch (error) {
        console.error(`[admin-profile-delete] file_cleanup_failed operationId=${operation.operationId}:`, error instanceof Error ? error.message : 'unknown error')
      }
    }
    return summary
  }

  return {
    hardDeleteProfile,
    processPendingAdminFileCleanup,
    hasActiveTournamentDependency: (profileId) => participationChecks.hasActiveTournamentDependency(profileId),
    hasCampaignGiftSenderHistory: (profileId) => selectCampaignGiftSenderHistoryStatement.get(profileId) !== undefined,
    findDeletedProfileIdsForVisitorId: (visitorId) =>
      (selectDeletedProfileIdsForVisitorIdStatement.all(visitorId, visitorId) as Array<{ deleted_profile_id: string }>).map((row) => row.deleted_profile_id),
    findDeletedProfileIdsForIp: (ipAddress) =>
      (selectDeletedProfileIdsForIpStatement.all(ipAddress, ipAddress) as Array<{ deleted_profile_id: string }>).map((row) => row.deleted_profile_id),
    hasActiveMuteSnapshotForDeletedProfile: (deletedProfileId) =>
      selectActiveMuteSnapshotForDeletedProfileStatement.get(deletedProfileId) !== undefined,
    close: () => {
      executor.close()
      database.close()
    },
  }
}
