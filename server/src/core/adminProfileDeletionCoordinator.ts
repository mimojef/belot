// Етап 4F1 — надеждно административно окончателно изтриване.
//
// Проблем: административното изтриване (profileHardDeleteService) не
// оставяше следа извън SQLite базата, затова restore на стар backup
// "възкресяваше" изтрития профил. Решение — същият независим регистър
// (profileDeletionLedger.ts) и същото offsite потвърждение като при
// самоизтриването, с отделни видове записи за административната операция.
//
// Поток (без 30-дневен срок, без парола на изтривания профил):
//   1. schedule — висящ ред в pending_profile_moderation (action='delete',
//      ledger_operation_id) и ЕДВА СЛЕД ТОВА admin_delete_intent в регистъра
//      (fsync). Неуспешен запис в регистъра -> висящият ред се премахва и
//      изтриване няма (fail-closed).
//   2. tryExecute — САМО ако намерението е потвърдено копирано извън VPS
//      (когато това се изисква) и извикващият е проверил, че профилът не е в
//      активна игра: hardDeleteProfile с одитен ред log_id = operationId.
//      Регистрираното намерение НЕ е доказателство за изтриване.
//   3. След COMMIT — admin_delete_completed. Срив между COMMIT и записа се
//      довършва от finalizeOperations по самата база (одитният ред с log_id
//      = operationId е доказателството).
//   4. finalizeOperations — намерение без краен запис: изпълнено
//      (completed), приключено от самоизтриване (Етап 4E6C —
//      resolved_by_self) или неизпълнено (aborted).
//
// Идентификация САМО по immutable profile UUID (+ акаунт и дата на
// създаване в намерението). Без имена, имейли, IP или причина в регистъра.

import { randomUUID } from 'node:crypto'
import {
  ensureProfileDeletionLedgerRecord,
  isProfileDeletionLedgerRecordConfirmedOffsite,
  readProfileDeletionLedger,
  summarizeAdminLedgerOperations,
  type AdminProfileDeletionLedgerRecord,
  type ProfileDeletionLedgerRecord,
} from '../db/profileDeletionLedger.js'
import type { PendingProfileModeration, PendingProfileModerationStore } from '../db/pendingProfileModerationStore.js'
import type { HardDeleteProfileResult, ProfileHardDeleteService } from '../db/profileHardDeleteService.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type AdminProfileDeletionScheduleResult =
  | { ok: true; operationId: string }
  | { ok: false; code: 'not_found' | 'ledger_unavailable' }

export type AdminProfileDeletionExecuteResult =
  | { status: 'completed'; result: Extract<HardDeleteProfileResult, { ok: true }> }
  | { status: 'waiting_offsite' }
  | { status: 'refused'; code: string }
  | { status: 'not_found' }
  | { status: 'busy' }
  | { status: 'ledger_unavailable' }

export type AdminProfileDeletionCoordinator = {
  schedule: (input: {
    targetProfileId: string
    actorProfileId: string
    actorAccountId: string
    reason: string
    supportRequestMessageId: string | null
  }) => AdminProfileDeletionScheduleResult
  /** Извикващият гарантира, че профилът НЕ е в активна игра. */
  tryExecute: (pending: PendingProfileModeration) => Promise<AdminProfileDeletionExecuteResult>
  /** Намерения без краен запис -> completed / resolved_by_self / aborted. */
  finalizeOperations: () => number
  /**
   * finalize + всички висящи изтривания извън активна игра + (Етап 4F2)
   * повторни опити за недовършената файлова фаза. onWaiting — изтриване,
   * което чака offsite потвърждение (профилът НЕ е в игра): извикващият
   * прекъсва достъпа, за да няма нови действия до изпълнението.
   */
  runOnce: (options?: {
    onExecuted?: (pending: PendingProfileModeration) => void
    onWaiting?: (pending: PendingProfileModeration) => void
  }) => Promise<{ executed: number; waiting: number; refused: number; finalized: number; fileCleanupCompleted: number }>
  close: () => void
}

export type AdminProfileDeletionCoordinatorDeps = {
  databaseFilePath: string
  hardDeleteService: Pick<ProfileHardDeleteService, 'hardDeleteProfile'> & Partial<Pick<ProfileHardDeleteService, 'processPendingAdminFileCleanup'>>
  pendingStore: Pick<
    PendingProfileModerationStore,
    'recordPendingDelete' | 'listPendingDeletes' | 'getPendingDeleteByOperation' | 'assignLedgerOperation' | 'clearPendingDeleteForOperation'
  >
  ledgerPath: string
  /** Етап 4C: изтриване САМО след offsite потвърждение (изключва се само за локална разработка). */
  offsiteRequired: boolean
  isTargetInActiveGame: (profileId: string) => boolean
  /** Само за тестове: подмяна на записа в регистъра (симулиран неуспех). */
  appendRecord?: (ledgerPath: string, record: ProfileDeletionLedgerRecord) => void
  now?: () => Date
  log?: (line: string) => void
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' -> каноничен UTC ISO (и обратно за replay). */
export function sqliteDateTimeToCanonicalIso(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?Z?$/.exec(value.trim())
  if (match === null) return null
  const millis = (match[3] ?? '.000').slice(1).padEnd(3, '0')
  const iso = `${match[1]}T${match[2]}.${millis}Z`
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === iso ? iso : null
}

export function canonicalIsoToSqliteDateTime(value: string): string {
  return value.slice(0, 19).replace('T', ' ')
}

export async function createAdminProfileDeletionCoordinator(
  deps: AdminProfileDeletionCoordinatorDeps,
): Promise<AdminProfileDeletionCoordinator> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(deps.databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  database.exec('PRAGMA busy_timeout = 5000;')
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const appendRecord = deps.appendRecord ?? ((ledgerPath, record) => { ensureProfileDeletionLedgerRecord(ledgerPath, record) })

  const selectProfileIdentityStatement = database.prepare(`
    SELECT account_id, created_at FROM profiles WHERE profile_id = ? LIMIT 1;
  `)
  const selectAuditByLogIdStatement = database.prepare(`
    SELECT deleted_profile_id, deleted_at FROM admin_profile_deletions WHERE log_id = ? LIMIT 1;
  `)
  const selectSelfDeletionForProfileStatement = database.prepare(`
    SELECT request_id FROM profile_deletion_requests
    WHERE profile_id = ? AND db_deleted_at IS NOT NULL
    ORDER BY db_deleted_at DESC
    LIMIT 1;
  `)

  const inFlight = new Set<string>()

  function intentFor(
    operationId: string,
    pending: { targetProfileId: string; requestedByProfileId: string | null; supportRequestMessageId: string | null },
    identity: { account_id: string | null; created_at: string },
    requestedAt: string,
  ): AdminProfileDeletionLedgerRecord {
    return {
      v: 1,
      kind: 'admin_delete_intent',
      operationId,
      profileId: pending.targetProfileId,
      accountIdSnapshot: identity.account_id,
      profileCreatedAtSnapshot: identity.created_at,
      actorProfileId: pending.requestedByProfileId,
      supportRequestMessageId: pending.supportRequestMessageId,
      requestedAt,
      recordedAt: now().toISOString(),
    }
  }

  function schedule(input: Parameters<AdminProfileDeletionCoordinator['schedule']>[0]): AdminProfileDeletionScheduleResult {
    const identity = selectProfileIdentityStatement.get(input.targetProfileId) as { account_id: string | null; created_at: string } | undefined
    if (identity === undefined) return { ok: false, code: 'not_found' }
    const operationId = randomUUID()
    // 1. Висящият ред (база) ПРЕДИ намерението (регистър): finalize никога не
    //    вижда намерение без ред, който още предстои да бъде създаден.
    deps.pendingStore.recordPendingDelete({
      targetProfileId: input.targetProfileId,
      requestedByProfileId: input.actorProfileId,
      requestedByAccountId: input.actorAccountId,
      reason: input.reason,
      supportRequestMessageId: input.supportRequestMessageId,
      ledgerOperationId: operationId,
    })
    try {
      const pending = deps.pendingStore.getPendingDeleteByOperation(operationId)
      if (pending === null) throw new Error('pending_row_missing')
      // Намерението се строи от висящия ред (както при ensureIntent) — един и
      // същ запис при всяко повторно извикване.
      appendRecord(deps.ledgerPath, intentFor(operationId, pending, identity, sqliteDateTimeToCanonicalIso(pending.requestedAt) ?? now().toISOString()))
    } catch (error) {
      deps.pendingStore.clearPendingDeleteForOperation(operationId)
      log(`[admin-profile-delete] ledger_unavailable targetProfileId=${input.targetProfileId} error=${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, code: 'ledger_unavailable' }
    }
    log(`[admin-profile-delete] scheduled operationId=${operationId} targetProfileId=${input.targetProfileId}`)
    return { ok: true, operationId }
  }

  /** Намерението е в регистъра (идемпотентно) — и за редове отпреди 4F1. */
  function ensureIntent(pending: PendingProfileModeration): string | null {
    const identity = selectProfileIdentityStatement.get(pending.targetProfileId) as { account_id: string | null; created_at: string } | undefined
    if (identity === undefined) return pending.ledgerOperationId
    let operationId = pending.ledgerOperationId
    if (operationId === null) {
      operationId = randomUUID()
      if (!deps.pendingStore.assignLedgerOperation(pending.pendingId, operationId)) return null
    }
    const requestedAt = sqliteDateTimeToCanonicalIso(pending.requestedAt) ?? now().toISOString()
    // requestedAt е от базата — повторното извикване дава същия запис.
    appendRecord(deps.ledgerPath, intentFor(operationId, pending, identity, requestedAt))
    return operationId
  }

  function appendSafely(record: AdminProfileDeletionLedgerRecord): boolean {
    try {
      appendRecord(deps.ledgerPath, record)
      return true
    } catch (error) {
      log(`[admin-profile-delete] ledger_append_failed kind=${record.kind} operationId=${record.operationId} error=${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  function completedRecordFromAudit(operationId: string, profileId: string): AdminProfileDeletionLedgerRecord | null {
    const audit = selectAuditByLogIdStatement.get(operationId) as { deleted_profile_id: string; deleted_at: string } | undefined
    if (audit === undefined || audit.deleted_profile_id !== profileId) return null
    const deletedAt = sqliteDateTimeToCanonicalIso(audit.deleted_at)
    if (deletedAt === null) return null
    return { v: 1, kind: 'admin_delete_completed', operationId, profileId, deletedAt, recordedAt: now().toISOString() }
  }

  async function tryExecute(pending: PendingProfileModeration): Promise<AdminProfileDeletionExecuteResult> {
    if (pending.action !== 'delete') return { status: 'refused', code: 'not_a_delete' }
    const key = pending.ledgerOperationId ?? `pending:${pending.pendingId}`
    if (inFlight.has(key)) return { status: 'busy' }
    inFlight.add(key)
    try {
      // Операция с краен запис в регистъра (напр. висящ ред, върнат от стар
      // backup за вече отказана/завършена операция) НЕ се изпълнява повторно.
      // Вече записано намерение не се записва отново (висящият ред от
      // backup-а може да има друг requested_at).
      let ledgerState: string | undefined
      if (pending.ledgerOperationId !== null) {
        const ledger = readProfileDeletionLedger(deps.ledgerPath)
        if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) return { status: 'ledger_unavailable' }
        ledgerState = summarizeAdminLedgerOperations(ledger.records).get(pending.ledgerOperationId)?.state
        if (ledgerState !== undefined && ledgerState !== 'intent_only') {
          deps.pendingStore.clearPendingDeleteForOperation(pending.ledgerOperationId)
          log(`[admin-profile-delete] stale_operation operationId=${pending.ledgerOperationId} state=${ledgerState}`)
          return { status: 'refused', code: 'operation_already_terminal' }
        }
      }
      let operationId: string | null
      try {
        operationId = ledgerState === 'intent_only' ? pending.ledgerOperationId : ensureIntent(pending)
      } catch (error) {
        log(`[admin-profile-delete] ledger_unavailable targetProfileId=${pending.targetProfileId} error=${error instanceof Error ? error.message : String(error)}`)
        return { status: 'ledger_unavailable' }
      }
      if (operationId === null) return { status: 'busy' }
      if (deps.offsiteRequired && !isProfileDeletionLedgerRecordConfirmedOffsite(deps.ledgerPath, `admin_delete_intent:${operationId}`)) {
        return { status: 'waiting_offsite' }
      }
      inFlight.add(operationId)
      const result = await deps.hardDeleteService.hardDeleteProfile({
        targetProfileId: pending.targetProfileId,
        actorProfileId: pending.requestedByProfileId,
        actorAccountId: pending.requestedByAccountId ?? '',
        reason: pending.reason,
        supportRequestMessageId: pending.supportRequestMessageId,
        auditLogId: operationId,
      })
      if (result.ok) {
        const completed = completedRecordFromAudit(operationId, pending.targetProfileId)
        // Неуспешен запис тук се довършва от finalizeOperations (по одитния ред).
        if (completed !== null) appendSafely(completed)
        deps.pendingStore.clearPendingDeleteForOperation(operationId)
        log(`[admin-profile-delete] completed operationId=${operationId} targetProfileId=${pending.targetProfileId}`)
        return { status: 'completed', result }
      }
      if (result.code === 'not_found') {
        deps.pendingStore.clearPendingDeleteForOperation(operationId)
        finalizeOne(operationId, pending.targetProfileId)
        return { status: 'not_found' }
      }
      appendSafely({ v: 1, kind: 'admin_delete_aborted', operationId, profileId: pending.targetProfileId, code: result.code, recordedAt: now().toISOString() })
      deps.pendingStore.clearPendingDeleteForOperation(operationId)
      log(`[admin-profile-delete] refused operationId=${operationId} targetProfileId=${pending.targetProfileId} code=${result.code}`)
      return { status: 'refused', code: result.code }
    } finally {
      inFlight.delete(key)
      if (pending.ledgerOperationId !== null) inFlight.delete(pending.ledgerOperationId)
    }
  }

  /** Едно намерение без краен запис: какво е станало според базата. */
  function finalizeOne(operationId: string, profileId: string): boolean {
    if (inFlight.has(operationId)) return false
    if (deps.pendingStore.getPendingDeleteByOperation(operationId) !== null) return false
    const completed = completedRecordFromAudit(operationId, profileId)
    if (completed !== null) return appendSafely(completed)
    if (selectProfileIdentityStatement.get(profileId) !== undefined) {
      // Профилът съществува, а висящият ред на тази операция го няма —
      // заменена от друга операция или отказана.
      return appendSafely({ v: 1, kind: 'admin_delete_aborted', operationId, profileId, code: 'superseded', recordedAt: now().toISOString() })
    }
    const self = selectSelfDeletionForProfileStatement.get(profileId) as { request_id: string } | undefined
    if (self !== undefined) {
      return appendSafely({ v: 1, kind: 'admin_delete_resolved_by_self', operationId, profileId, requestId: self.request_id, recordedAt: now().toISOString() })
    }
    // Профилът липсва по друга причина (друга административна операция).
    return appendSafely({ v: 1, kind: 'admin_delete_aborted', operationId, profileId, code: 'superseded', recordedAt: now().toISOString() })
  }

  function finalizeOperations(): number {
    const ledger = readProfileDeletionLedger(deps.ledgerPath)
    if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) {
      log('[admin-profile-delete] ledger_corrupt — finalize пропуснат')
      return 0
    }
    let finalized = 0
    for (const operation of summarizeAdminLedgerOperations(ledger.records).values()) {
      if (operation.state !== 'intent_only') continue
      if (finalizeOne(operation.operationId, operation.profileId)) finalized += 1
    }
    return finalized
  }

  async function runOnce(options: Parameters<AdminProfileDeletionCoordinator['runOnce']>[0] = {}): Promise<{ executed: number; waiting: number; refused: number; finalized: number; fileCleanupCompleted: number }> {
    const summary = { executed: 0, waiting: 0, refused: 0, finalized: 0, fileCleanupCompleted: 0 }
    summary.finalized = finalizeOperations()
    for (const pending of deps.pendingStore.listPendingDeletes()) {
      if (deps.isTargetInActiveGame(pending.targetProfileId)) continue
      const outcome = await tryExecute(pending)
      if (outcome.status === 'completed') {
        summary.executed += 1
        options.onExecuted?.(pending)
      }
      else if (outcome.status === 'waiting_offsite' || outcome.status === 'ledger_unavailable') {
        summary.waiting += 1
        options.onWaiting?.(pending)
      }
      else if (outcome.status === 'refused') summary.refused += 1
    }
    // Етап 4F2 — DB COMMIT-ът не значи, че файловете са изтрити: недовършената
    // файлова фаза (вкл. от възстановено копие) се довършва тук.
    if (deps.hardDeleteService.processPendingAdminFileCleanup !== undefined) {
      summary.fileCleanupCompleted = (await deps.hardDeleteService.processPendingAdminFileCleanup()).completed
    }
    return summary
  }

  return {
    schedule,
    tryExecute,
    finalizeOperations,
    runOnce,
    close: () => database.close(),
  }
}
