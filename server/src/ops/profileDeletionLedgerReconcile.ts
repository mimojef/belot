// Самоизтриване на профили — процедура СЛЕД restore на SQLite/uploads backup
// и ПРЕДИ платформата да бъде пусната отново за потребители (Етап 4, 4C).
//
// Сравнява независимия регистър на окончателните изтривания (обикновено
// обединеното най-ново състояние от `merge`, виж profileDeletionLedgerArchive.ts)
// с възстановената база и открива профили, които backup-ът е "възкресил".
//
// Режими:
//   (по подразбиране) отчет — нищо не се променя;
//   --apply --confirm=REAPPLY-PROFILE-DELETIONS --uploads-root=<dir>
//       повторно прилагане (само при СПРЯН сървър);
//   --verify-only — финална проверка преди отваряне на платформата.
//
// Fail-closed:
//   * липсващ регистър, невалиден пълен ред или конфликт -> exit 2;
//   * повредена база (integrity_check) -> exit 2;
//   * остарял регистър: базата има изтрита в базата заявка (db_deleted_at),
//     която липсва в регистъра -> регистърът е по-стар от базата и може да
//     липсват и по-нови изтривания -> exit 1, --apply се отказва
//     (освен с --accept-stale-ledger след ръчна проверка);
//   * --apply / --verify-only завършват с 0 САМО ако всеки профил от
//     регистъра липсва в базата и няма недовършени файлови операции.
//
// Устойчивост при прекъсване: за заявки, които липсват в базата, файловете
// се записват в журнал (<state-dir>/journal.jsonl, fsync) ПРЕДИ COMMIT на
// изтриването; при повторно изпълнение недовършените се довършват. Заявките,
// които са във възстановената база, минават през същия worker и неговата
// постоянна файлова опашка.
//
// Етап 4F1 — административните окончателни изтривания (същият регистър):
//   * доказано завършени (admin_delete_completed / admin_delete_historical)
//     — профилът трябва да липсва; ако backup-ът го е "възкресил" и
//     идентичността съвпада (UUID + акаунт/дата на създаване, когато са
//     известни) -> --apply го изтрива отново със СЪЩИЯ административен път
//     (profileHardDeleteService, replay режим: одитният ред е със същия
//     log_id = operationId и оригиналния момент). Активен бан в стария
//     backup НЕ пречи — административното изтриване не зависи от бана.
//     Изпълнява се ПРЕДИ самоизтриванията;
//   * само намерение (admin_delete_intent без краен запис) и профилът е в
//     базата -> admin_unresolved: регистрираното намерение НЕ доказва
//     изтриване, затова нищо не се трие автоматично — fail-closed;
//   * admin_delete_resolved_by_self — довършва се от записа на
//     самоизтриването; admin_delete_aborted — пренебрегва се;
//   * одитен ред (admin_profile_deletions) във възстановената база, чиято
//     операция липсва в регистъра -> admin_ledger_stale (регистърът е
//     по-стар от базата, или старите изтривания не са добавени с
//     `admin-backfill`) — --apply се отказва като при ledger_stale.
//
// Етап 4J1 — отмени на доброволни заявки (запис "request_cancelled"):
//   * отмяна СЛЕД намерението (или без намерение) -> намерението е
//     невалидно: профилът НЕ се изтрива; ако във възстановената база заявката
//     е активна, --apply възстановява трайната защита (recovered_from_ledger)
//     — финализира я обичайният finalizer след offsite потвърждение;
//   * отмяна ПРЕДИ намерението -> cancel_conflict (невалидна
//     последователност): нищо не се трие и нищо не се отменя автоматично —
//     fail-closed, нужна е ръчна проверка;
//   * доказано изтриване ("request_db_deleted") има предимство пред отмяна
//     (cancel_ignored) — профилът не се възстановява;
//   * финализирана отмяна в базата, която липсва в регистъра -> ledger_stale.
//
// Изход: само request_id/profile_id и кодове — без имена, имейли или токени.

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createProfileDeletionWorker } from '../core/profileDeletionWorker.js'
import { createProfileDeletionExecutor } from '../db/profileDeletionExecutor.js'
import { createProfileHardDeleteService } from '../db/profileHardDeleteService.js'
import { createProfileDeletionCancellationStore } from '../db/profileDeletionCancellationStore.js'
import { canonicalIsoToSqliteDateTime } from '../core/adminProfileDeletionCoordinator.js'
import {
  readProfileDeletionLedger,
  summarizeAdminLedgerOperations,
  summarizeRequestLedgerState,
  type AdminLedgerOperation,
  type ProfileDeletionLedgerEntry,
  type ProfileDeletionRequestCancelledRecord,
} from '../db/profileDeletionLedger.js'
import { listPendingMigrationsForDatabase } from './profileDeletionRestoredDbMigrations.js'
import {
  removeProfileDeletionFile,
  type ProfileDeletionFileKind,
  type ProfileDeletionUploadRoots,
} from '../uploads/profileDeletionFileRemoval.js'

export const REAPPLY_CONFIRMATION_PHRASE = 'REAPPLY-PROFILE-DELETIONS'

export type ReconcileIo = { log: (line: string) => void; error: (line: string) => void }

type Category = 'absent' | 'request_present' | 'request_missing' | 'identity_mismatch'
/** Етап 4J1 — заявки с отмяна в регистъра. */
type CancelCategory = 'cancelled' | 'cancel_restore_needed' | 'cancel_conflict'
type AdminCategory =
  | 'admin_absent'
  | 'admin_missing'
  | 'admin_identity_mismatch'
  | 'admin_unresolved'
  | 'admin_via_self'
  | 'admin_ignored'

export const ADMIN_REPLAY_AUDIT_REASON = 'Повторно приложено административно изтриване след възстановяване от backup (оригиналната причина е в одита на живата база)'

type JournalRecord =
  | { type: 'planned'; requestId: string; profileId: string; files: Array<{ fileKind: ProfileDeletionFileKind; storageRef: string }> }
  | { type: 'done'; requestId: string }

function readArg(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`
  const found = argv.find((arg) => arg.startsWith(prefix))
  return found === undefined ? null : found.slice(prefix.length)
}

function readJournal(journalPath: string): Map<string, Extract<JournalRecord, { type: 'planned' }>> {
  const pending = new Map<string, Extract<JournalRecord, { type: 'planned' }>>()
  if (!existsSync(journalPath)) return pending
  const text = readFileSync(journalPath, 'utf8')
  const lastNewline = text.lastIndexOf('\n')
  for (const line of text.slice(0, lastNewline + 1).split('\n')) {
    if (line.trim().length === 0) continue
    const record = JSON.parse(line) as JournalRecord
    if (record.type === 'planned') pending.set(record.requestId, record)
    else pending.delete(record.requestId)
  }
  return pending
}

function appendJournal(journalPath: string, record: JournalRecord): void {
  appendFileSync(journalPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  const fd = openSync(journalPath, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export async function runProfileDeletionLedgerReconcile(argv: readonly string[], io: ReconcileIo): Promise<number> {
  const dbArg = readArg(argv, 'db')
  const ledgerArg = readArg(argv, 'ledger')
  const uploadsRoot = readArg(argv, 'uploads-root')
  const apply = argv.includes('--apply')
  const verifyOnly = argv.includes('--verify-only')
  const acceptStale = argv.includes('--accept-stale-ledger')
  const confirmation = readArg(argv, 'confirm')
  const fail = (code: string, message: string): number => {
    io.error(`[reconcile] ERROR ${code}: ${message}`)
    return 2
  }

  if (dbArg === null || ledgerArg === null) return fail('usage', 'нужни са --db=<път> и --ledger=<път>')
  if (apply && verifyOnly) return fail('usage', '--apply и --verify-only са взаимно изключващи се')
  const dbPath = resolve(dbArg)
  const ledgerPath = resolve(ledgerArg)
  const stateDir = resolve(readArg(argv, 'state-dir') ?? `${dbPath}.reconcile-state`)
  const journalPath = join(stateDir, 'journal.jsonl')
  if (!existsSync(dbPath)) return fail('db_missing', 'базата не съществува')
  // Етап 4E2: схемата на възстановената база трябва да е на текущата версия
  // (executor-ът и проверките ползват колоните от новите миграции).
  const pendingMigrations = await listPendingMigrationsForDatabase(dbPath)
  if (pendingMigrations.length > 0) {
    return fail(
      'restored_db_migrations_pending',
      `${pendingMigrations.length} неприложени миграции (напр. ${pendingMigrations.slice(-3).join(', ')}) — първо: profileDeletionLedgerCli migrate --db=<възстановената база>`,
    )
  }
  if (apply) {
    if (confirmation !== REAPPLY_CONFIRMATION_PHRASE) return fail('confirmation_required', `--apply изисква --confirm=${REAPPLY_CONFIRMATION_PHRASE}`)
    if (uploadsRoot === null || !existsSync(uploadsRoot)) return fail('uploads_root_missing', '--apply изисква съществуващ --uploads-root=<директория>')
  }

  // Регистър: задължителен и цял (непълна опашка = недовършен запис — само предупреждение).
  const ledger = readProfileDeletionLedger(ledgerPath)
  if (!ledger.exists) return fail('ledger_missing', 'регистърът липсва — използвай обединеното състояние от `merge`')
  if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) {
    return fail('ledger_corrupt', `invalidLines=${ledger.invalidLineCount} conflictingDuplicates=${ledger.conflictingDuplicateCount}`)
  }
  if (ledger.trailingPartialBytes > 0) io.log(`[reconcile] WARNING ledger_trailing_partial_ignored bytes=${ledger.trailingPartialBytes}`)
  const adminOperations = summarizeAdminLedgerOperations(ledger.records)
  const conflictingAdmin = [...adminOperations.values()].filter((operation) => operation.state === 'conflict')
  if (conflictingAdmin.length > 0) {
    return fail('ledger_corrupt', `admin_operation_conflict operationIds=${conflictingAdmin.map((operation) => operation.operationId).slice(0, 5).join(',')}`)
  }
  const requestStates = summarizeRequestLedgerState(ledger.records)
  // Намерения, които НЕ се прилагат повторно: отменени или с конфликтна последователност.
  const intentEntries = ledger.entries.filter((entry) => {
    const resolution = requestStates.get(entry.requestId)?.resolution
    return resolution !== 'cancelled' && resolution !== 'cancel_conflict'
  })
  const cancelStates = [...requestStates.values()].filter((state) => state.resolution === 'cancelled' || state.resolution === 'cancel_conflict')
  for (const state of requestStates.values()) {
    if (state.cancelIgnored) io.log(`[reconcile] cancel_ignored requestId=${state.requestId} (доказано изтриване има предимство)`)
  }
  const mode = apply ? 'APPLY' : verifyOnly ? 'verify-only' : 'report-only'
  io.log(`[reconcile] mode=${mode} ledgerEntries=${ledger.entries.length} cancellations=${cancelStates.length} adminOperations=${adminOperations.size}`)

  const { DatabaseSync } = await import('node:sqlite')

  type Snapshot = {
    classified: Array<{ entry: ProfileDeletionLedgerEntry; category: Category; requestStatus: string | null; pendingFiles: number }>
    cancelClassified: Array<{ requestId: string; record: ProfileDeletionRequestCancelledRecord; category: CancelCategory; requestStatus: string | null }>
    staleRequestIds: string[]
    adminClassified: Array<{ operation: AdminLedgerOperation; category: AdminCategory }>
    adminStaleLogIds: string[]
  }
  const inspect = (): Snapshot | { integrity: string } => {
    const readDb = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const integrity = (readDb.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check
      if (integrity !== 'ok') return { integrity }
      const selectProfile = readDb.prepare('SELECT account_id, created_at FROM profiles WHERE profile_id = ? LIMIT 1;')
      const selectRequest = readDb.prepare('SELECT status, db_deleted_at FROM profile_deletion_requests WHERE request_id = ? LIMIT 1;')
      const selectPendingFiles = readDb.prepare(`SELECT COUNT(*) AS c FROM profile_deletion_file_queue WHERE request_id = ? AND status NOT IN ('done', 'skipped_shared');`)
      const ledgerIds = new Set(ledger.entries.map((entry) => entry.requestId))
      const classified = intentEntries.map((entry) => {
        const profile = selectProfile.get(entry.profileId) as { account_id: string | null; created_at: string } | undefined
        const request = selectRequest.get(entry.requestId) as { status: string; db_deleted_at: string | null } | undefined
        const pendingFiles = request === undefined ? 0 : Number((selectPendingFiles.get(entry.requestId) as { c: number }).c)
        let category: Category
        if (profile === undefined) {
          // Изтрит в базата, но с недовършени файлове/статус -> същият worker го довършва.
          category = request !== undefined && request.status !== 'completed' && pendingFiles > 0 ? 'request_present' : 'absent'
        } else if (profile.account_id !== entry.accountIdSnapshot || profile.created_at !== entry.profileCreatedAtSnapshot) {
          category = 'identity_mismatch'
        } else {
          category = request === undefined ? 'request_missing' : 'request_present'
        }
        return { entry, category, requestStatus: request?.status ?? null, pendingFiles }
      })
      const selectCancellationRow = readDb.prepare('SELECT 1 FROM profile_deletion_cancellations WHERE request_id = ? LIMIT 1;')
      const cancelClassified = cancelStates.map((state) => {
        const record = state.cancel as ProfileDeletionRequestCancelledRecord
        const request = selectRequest.get(state.requestId) as { status: string; db_deleted_at: string | null } | undefined
        let category: CancelCategory
        if (state.resolution === 'cancel_conflict') category = 'cancel_conflict'
        else if (
          request !== undefined && request.db_deleted_at === null &&
          ['pending', 'blocked', 'failed', 'executing'].includes(request.status) &&
          selectCancellationRow.get(state.requestId) === undefined
        ) category = 'cancel_restore_needed'
        else category = 'cancelled'
        return { requestId: state.requestId, record, category, requestStatus: request?.status ?? null }
      })
      const ledgerCancelIds = new Set(cancelStates.map((state) => state.requestId))
      const staleRequestIds = (readDb.prepare('SELECT request_id FROM profile_deletion_requests WHERE db_deleted_at IS NOT NULL;').all() as Array<{ request_id: string }>)
        .map((row) => row.request_id)
        .filter((requestId) => !ledgerIds.has(requestId))
        // Финализирана отмяна в базата, която липсва в регистъра — регистърът е по-стар от базата.
        .concat((readDb.prepare('SELECT request_id FROM profile_deletion_cancellations WHERE finalized_at IS NOT NULL;').all() as Array<{ request_id: string }>)
          .map((row) => row.request_id)
          .filter((requestId) => !ledgerCancelIds.has(requestId)))
      // Етап 4F1 — административните операции (идентификация САМО по UUID +
      // акаунт/дата на създаване, когато са записани; никога по име).
      const adminClassified = [...adminOperations.values()].map((operation) => {
        const profile = selectProfile.get(operation.profileId) as { account_id: string | null; created_at: string } | undefined
        let category: AdminCategory
        if (operation.state === 'aborted') category = 'admin_ignored'
        else if (profile === undefined) category = 'admin_absent'
        else if (operation.state === 'intent_only') category = 'admin_unresolved'
        else if (operation.state === 'resolved_by_self') category = 'admin_via_self'
        else if (
          (operation.accountIdSnapshot !== null && profile.account_id !== operation.accountIdSnapshot) ||
          (operation.profileCreatedAtSnapshot !== null && profile.created_at !== operation.profileCreatedAtSnapshot)
        ) category = 'admin_identity_mismatch'
        else category = 'admin_missing'
        return { operation, category }
      })
      const adminStaleLogIds = (readDb.prepare('SELECT log_id FROM admin_profile_deletions;').all() as Array<{ log_id: string }>)
        .map((row) => row.log_id)
        .filter((logId) => !adminOperations.has(logId))
      return { classified, cancelClassified, staleRequestIds, adminClassified, adminStaleLogIds }
    } finally {
      readDb.close()
    }
  }

  const report = (snapshot: Snapshot): Record<string, number> => {
    for (const item of snapshot.classified) {
      io.log(`[reconcile] ${item.category} requestId=${item.entry.requestId} profileId=${item.entry.profileId}${item.requestStatus === null ? '' : ` requestStatus=${item.requestStatus}`}${item.pendingFiles > 0 ? ` pendingFiles=${item.pendingFiles}` : ''}`)
    }
    for (const item of snapshot.cancelClassified) {
      io.log(`[reconcile] ${item.category} requestId=${item.requestId} profileId=${item.record.profileId} source=${item.record.source}${item.requestStatus === null ? '' : ` requestStatus=${item.requestStatus}`}`)
    }
    for (const requestId of snapshot.staleRequestIds) {
      io.log(`[reconcile] ledger_stale requestId=${requestId} (изтрита в базата, липсва в регистъра)`)
    }
    for (const item of snapshot.adminClassified) {
      if (item.category === 'admin_ignored') continue
      io.log(`[reconcile] ${item.category} operationId=${item.operation.operationId} profileId=${item.operation.profileId} state=${item.operation.state}`)
    }
    for (const logId of snapshot.adminStaleLogIds) {
      io.log(`[reconcile] admin_ledger_stale operationId=${logId} (административно изтриване в базата, липсва в регистъра)`)
    }
    const counts = snapshot.classified.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.category]: (acc[item.category] ?? 0) + 1 }), {})
    for (const item of snapshot.cancelClassified) counts[item.category] = (counts[item.category] ?? 0) + 1
    counts.ledger_stale = snapshot.staleRequestIds.length
    for (const item of snapshot.adminClassified) counts[item.category] = (counts[item.category] ?? 0) + 1
    counts.admin_ledger_stale = snapshot.adminStaleLogIds.length
    io.log(`[reconcile] summary ${JSON.stringify(counts)}`)
    return counts
  }

  const before = inspect()
  if ('integrity' in before) return fail('db_integrity', `integrity_check=${before.integrity.slice(0, 200)}`)
  const counts = report(before)
  const pendingJournal = readJournal(journalPath)
  if (pendingJournal.size > 0) io.log(`[reconcile] journal_pending=${pendingJournal.size}`)
  const isClean = (snapshot: Snapshot, journalPending: number): boolean =>
    snapshot.staleRequestIds.length === 0 &&
    snapshot.adminStaleLogIds.length === 0 &&
    journalPending === 0 &&
    snapshot.classified.every((item) => item.category === 'absent') &&
    snapshot.cancelClassified.every((item) => item.category === 'cancelled') &&
    snapshot.adminClassified.every((item) => item.category === 'admin_absent' || item.category === 'admin_ignored')

  if (!apply && !verifyOnly) {
    io.log('[reconcile] Нищо не е променено (report-only).')
    return (counts.ledger_stale ?? 0) > 0 || (counts.identity_mismatch ?? 0) > 0 ||
      (counts.admin_ledger_stale ?? 0) > 0 || (counts.admin_identity_mismatch ?? 0) > 0 || (counts.admin_unresolved ?? 0) > 0 ||
      (counts.cancel_conflict ?? 0) > 0 || (counts.cancel_restore_needed ?? 0) > 0
      ? 1
      : 0
  }
  if (verifyOnly) {
    const clean = isClean(before, pendingJournal.size)
    io.log(`[reconcile] verify ${clean ? 'OK' : 'FAILED'}`)
    return clean ? 0 : 1
  }
  if ((before.staleRequestIds.length > 0 || before.adminStaleLogIds.length > 0) && !acceptStale) {
    io.error('[reconcile] ERROR ledger_stale: регистърът е по-стар от базата — нищо не е променено (виж runbook-а; --accept-stale-ledger само след ръчна проверка)')
    return 1
  }

  const roots: ProfileDeletionUploadRoots = {
    avatars: join(uploadsRoot as string, 'avatars'),
    profileGallery: join(uploadsRoot as string, 'profile-gallery'),
    chatAttachments: join(uploadsRoot as string, 'chat-attachments'),
    topicAttachments: join(uploadsRoot as string, 'topic-attachments'),
    topicMuteEvidenceAttachments: join(uploadsRoot as string, 'topic-mute-evidence-attachments'),
    supportAttachments: join(uploadsRoot as string, 'support-attachments'),
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  const executor = await createProfileDeletionExecutor(dbPath)
  let fileFailures = 0
  const deleteJournalFiles = async (record: Extract<JournalRecord, { type: 'planned' }>): Promise<void> => {
    let failedHere = 0
    for (const file of record.files) {
      if (executor.isStorageRefReferenced(file.fileKind, file.storageRef)) continue
      const outcome = await removeProfileDeletionFile(file.fileKind, file.storageRef, roots)
      if (outcome.outcome !== 'deleted' && outcome.outcome !== 'missing') failedHere += 1
    }
    if (failedHere === 0) appendJournal(journalPath, { type: 'done', requestId: record.requestId })
    fileFailures += failedHere
    io.log(`[reconcile] files requestId=${record.requestId} total=${record.files.length} failed=${failedHere}`)
  }

  try {
    // 0. Етап 4J1 — отмени от регистъра: ПРЕДИ всяко изтриване трайната
    //    защита се възстановява във възстановената база (worker-ът по-долу и
    //    живият worker след старта не могат да вземат тези заявки).
    {
      const cancellationStore = await createProfileDeletionCancellationStore(dbPath)
      try {
        for (const item of before.cancelClassified.filter((candidate) => candidate.category === 'cancel_restore_needed')) {
          const result = cancellationStore.applyRecoveredCancellation(item.record, { releaseExecuting: true })
          io.log(`[reconcile] cancel_restore requestId=${item.requestId} result=${result.ok ? result.state : result.code}`)
        }
      } finally {
        cancellationStore.close()
      }
    }

    // 1. Довършване на прекъснато предишно изпълнение (профилът вече липсва).
    const presentIds = new Set(before.classified.filter((item) => item.category !== 'absent').map((item) => item.entry.profileId))
    for (const record of pendingJournal.values()) {
      if (!presentIds.has(record.profileId)) await deleteJournalFiles(record)
    }

    // 1b. Етап 4F1 — доказано завършени административни изтривания, които
    //     backup-ът е върнал: същият административен път (replay режим),
    //     ПРЕДИ самоизтриванията (те виждат профила като вече изтрит).
    //     Етап 4F2 — същото ядро и същата файлова опашка като на живо: файловете
    //     се записват в опашката на възстановената база и се обработват с
    //     възстановените uploads (вкл. недовършени файлови фази от backup,
    //     направен между COMMIT и изтриването на файловете).
    const adminMissing = before.adminClassified.filter((item) => item.category === 'admin_missing')
    {
      const hardDeleteService = await createProfileHardDeleteService(dbPath, { uploadRoots: roots })
      try {
        for (const item of adminMissing) {
          const operation = item.operation
          const result = await hardDeleteService.hardDeleteProfile({
            targetProfileId: operation.profileId,
            actorProfileId: operation.actorProfileId ?? '',
            actorAccountId: '',
            reason: ADMIN_REPLAY_AUDIT_REASON,
            supportRequestMessageId: operation.supportRequestMessageId,
            auditLogId: operation.operationId,
            replay: { deletedAt: canonicalIsoToSqliteDateTime(operation.deletedAt as string) },
          })
          io.log(`[reconcile] admin_replay operationId=${operation.operationId} profileId=${operation.profileId} result=${result.ok ? `deleted filesPending=${result.filesPending}` : result.code}`)
        }
        const files = await hardDeleteService.processPendingAdminFileCleanup()
        fileFailures += files.filesFailed
        if (files.operations > 0) io.log(`[reconcile] admin_file_cleanup ${JSON.stringify(files)}`)
      } finally {
        hardDeleteService.close()
      }
    }

    // 2. Заявки във възстановената база -> същият worker и файлова опашка.
    const presentRequestIds = before.classified.filter((item) => item.category === 'request_present').map((item) => item.entry.requestId)
    for (const requestId of presentRequestIds) executor.prepareRequestForRestoreReconcile(requestId)
    if (presentRequestIds.length > 0) {
      const worker = createProfileDeletionWorker({
        executor,
        workerId: `reconcile:${process.pid}`,
        uploadRoots: roots,
        removeFile: removeProfileDeletionFile,
        appendLedgerEntry: null,
        onlyRequestIds: presentRequestIds,
        log: (message) => io.log(message),
      })
      io.log(`[reconcile] worker ${JSON.stringify(await worker.runOnce())}`)
    }

    // 3. Заявки, по-нови от backup-а -> същото изтриване + журнал на файловете.
    for (const item of before.classified.filter((candidate) => candidate.category === 'request_missing')) {
      const holder: { planned: Extract<JournalRecord, { type: 'planned' }> | null } = { planned: null }
      const result = executor.replayDeletionForRestore(item.entry, {
        beforeCommit: (files) => {
          holder.planned = { type: 'planned', requestId: item.entry.requestId, profileId: item.entry.profileId, files }
          appendJournal(journalPath, holder.planned)
        },
      })
      if (result.kind !== 'deleted') {
        io.log(`[reconcile] replay requestId=${item.entry.requestId} result=${result.kind}${result.kind === 'blocked' ? ` code=${result.code}` : ''}`)
        continue
      }
      // Само за тестове: симулиран срив след COMMIT, преди файловете.
      if (process.env.PIKABG_TEST_RECONCILE_EXIT_AFTER_COMMIT === '1') {
        executor.close()
        process.exit(70)
      }
      if (holder.planned !== null) await deleteJournalFiles(holder.planned)
    }
  } finally {
    executor.close()
  }

  // 4. Финална проверка — същите правила като --verify-only.
  const after = inspect()
  if ('integrity' in after) return fail('db_integrity', `integrity_check=${after.integrity.slice(0, 200)}`)
  io.log('[reconcile] after-apply:')
  report(after)
  const journalLeft = readJournal(journalPath).size
  const clean = isClean(after, journalLeft) && fileFailures === 0
  io.log(`[reconcile] verify ${clean ? 'OK' : 'FAILED'} journalPending=${journalLeft} fileFailures=${fileFailures}`)
  return clean ? 0 : 1
}
