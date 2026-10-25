// Самоизтриване, Етап 4J1B — шлюз на историята след restore (сървърно наложен).
//
// Необратимите операции (решение/изтриване от worker-а, административно
// изпълнение и финализиране) са разрешени САМО ако текущата база и текущият
// регистър си съответстват. Оценката се изчислява наново от двете (не е
// съхранен флаг "reconcile е минал", който стар backup би върнал):
//
//   ledger_unreadable          — невалиден ред/конфликт/разклонен genesis;
//   ledger_missing / mismatch  — базата е обвързана с регистър (admin_settings
//                                profile_deletion_ledger_id = ledger_genesis),
//                                а той липсва или е друг;
//   ledger_behind_db           — базата знае събития, които регистърът няма
//                                (изтрити заявки, записани/финализирани отмени,
//                                административни изтривания и намерения);
//   unreconciled_deletion      — регистърът доказва изтриване (решение/COMMIT
//                                или административно завършване), а профилът е
//                                във възстановената база и няма активна заявка,
//                                която worker-ът да довърши -> reconcile
//                                (НЕ и доказано създаден наново профил със
//                                същия ID — isAdminDeletedProfileProvenRecreated);
//   ledger_cancel_conflict     — отмяна преди намерението.
//
// restoreHold — регистърът е възстановен без живото копие (маркер от `merge`
// или открит от сървъра: има история, изискваща offsite потвърждение, а
// валиден ack няма). Изгубени отмени/решения НЕ могат да бъдат открити, затова
// нови необратими решения чакат изричното освобождаване от оператора
// (`release-restore`, запис в същия регистър — оцелява при следващ restore).
//
// blockedProfileIds — профили, които регистърът доказва като изтрити, а
// базата ги има: достъпът им се спира (без вход, сесиите се отнемат), докато
// reconcile не приложи изтриването отново.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  ensureProfileDeletionLedgerRecord,
  getProfileDeletionLedgerOffsiteAckPath,
  isAdminDeletedProfileProvenRecreated,
  isAdminProfileDeletionLedgerRecord,
  isRequestLifecycleLedgerRecord,
  readProfileDeletionLedger,
  readProfileDeletionLedgerOffsiteAck,
  sha256Hex,
  summarizeAdminLedgerOperations,
  summarizeLedgerControl,
  summarizeRequestLedgerState,
  withProfileDeletionLedgerLock,
} from '../db/profileDeletionLedger.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const PROFILE_DELETION_LEDGER_ID_SETTING = 'profile_deletion_ledger_id'

export type ProfileDeletionHistoryAssessment = {
  verified: boolean
  restoreHold: boolean
  reasons: string[]
  blockedProfileIds: string[]
  unreleasedRestoreIds: string[]
}

export type ProfileDeletionHistoryGuard = {
  /** При старт: обвързва базата с регистъра (genesis) и открива restore без ack. */
  initialize: () => { binding: 'bound' | 'created' | 'existing' | 'refused'; restoreDetected: boolean }
  assess: () => ProfileDeletionHistoryAssessment
  close: () => void
}

export async function createProfileDeletionHistoryGuard(input: {
  databaseFilePath: string
  ledgerPath: string
  offsiteRequired: boolean
  log?: (line: string) => void
}): Promise<ProfileDeletionHistoryGuard> {
  const log = input.log ?? (() => {})
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(input.databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectSetting = database.prepare('SELECT setting_value FROM admin_settings WHERE setting_key = ? LIMIT 1;')
  const insertSetting = database.prepare('INSERT INTO admin_settings (setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO NOTHING;')
  const selectDbDeletedRequests = database.prepare('SELECT request_id FROM profile_deletion_requests WHERE db_deleted_at IS NOT NULL;')
  const selectRecordedCancellations = database.prepare('SELECT request_id FROM profile_deletion_cancellations WHERE ledger_recorded_at IS NOT NULL;')
  const selectAdminDeletions = database.prepare('SELECT log_id FROM admin_profile_deletions;')
  const selectPendingAdminOps = database.prepare(`SELECT ledger_operation_id, target_profile_id FROM pending_profile_moderation WHERE action = 'delete';`)
  const selectRequest = database.prepare('SELECT request_id, status FROM profile_deletion_requests WHERE request_id = ? LIMIT 1;')
  const selectProfile = database.prepare('SELECT 1 FROM profiles WHERE profile_id = ? LIMIT 1;')
  const selectProfileIdentity = database.prepare('SELECT account_id, created_at FROM profiles WHERE profile_id = ? LIMIT 1;')
  const selectHistoryExists = database.prepare(`
    SELECT
      EXISTS (SELECT 1 FROM profile_deletion_requests WHERE attempt_count > 0 OR db_deleted_at IS NOT NULL) OR
      EXISTS (SELECT 1 FROM profile_deletion_cancellations WHERE ledger_recorded_at IS NOT NULL) OR
      EXISTS (SELECT 1 FROM admin_profile_deletions) OR
      EXISTS (SELECT 1 FROM pending_profile_moderation WHERE ledger_operation_id IS NOT NULL) AS has_history;
  `)
  const selectAckRequiringDbHistory = database.prepare(`
    SELECT
      EXISTS (SELECT 1 FROM profile_deletion_requests WHERE db_deleted_at IS NOT NULL) OR
      EXISTS (SELECT 1 FROM profile_deletion_cancellations WHERE finalized_at IS NOT NULL) OR
      EXISTS (SELECT 1 FROM admin_profile_deletions WHERE file_cleanup_status IS NOT NULL) AS has_history;
  `)

  const getBoundLedgerId = (): string | null => (selectSetting.get(PROFILE_DELETION_LEDGER_ID_SETTING) as { setting_value: string } | undefined)?.setting_value ?? null
  const dbHasLedgerHistory = (): boolean => Number((selectHistoryExists.get() as { has_history: number }).has_history) === 1

  /** Валиден offsite ack: точен префикс на текущия регистър (същото правило като worker-а). */
  function isAckValid(): boolean {
    const ack = readProfileDeletionLedgerOffsiteAck(getProfileDeletionLedgerOffsiteAckPath(input.ledgerPath))
    if (ack === null || ack.bytes === 0) return false
    let buffer: Buffer
    try { buffer = readFileSync(input.ledgerPath) } catch { return false }
    if (buffer.length < ack.bytes) return false
    const prefix = buffer.subarray(0, ack.bytes)
    return prefix[prefix.length - 1] === 0x0a && sha256Hex(prefix) === ack.sha256
  }

  function initialize(): { binding: 'bound' | 'created' | 'existing' | 'refused'; restoreDetected: boolean } {
    // Базата се чете ПРЕДИ заключването, а се пише СЛЕД него: под заключването
    // на регистъра има само файлови операции (ред: база -> регистър, без deadlock).
    const boundId = getBoundLedgerId()
    const hasHistory = dbHasLedgerHistory()
    const ackRequiringInDb = Number((selectAckRequiringDbHistory.get() as { has_history: number }).has_history) === 1
    const outcome = withProfileDeletionLedgerLock(input.ledgerPath, () => {
      const ledger = readProfileDeletionLedger(input.ledgerPath)
      if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) return { binding: 'refused' as const, bindId: null, restoreDetected: false }
      const control = summarizeLedgerControl(ledger.records)
      if (control.genesisIds.length > 1) return { binding: 'refused' as const, bindId: null, restoreDetected: false }
      let binding: 'bound' | 'created' | 'existing' | 'refused'
      let bindId: string | null = null
      if (boundId !== null) {
        binding = control.genesisIds[0] === boundId ? 'existing' : 'refused'
      } else if (control.genesisIds.length === 1) {
        binding = 'bound'
        bindId = control.genesisIds[0]!
      } else if (ledger.records.length === 0 && hasHistory) {
        // Базата има история на изтривания, а регистър няма -> изгубен; нищо не се създава.
        binding = 'refused'
      } else {
        // Първо стартиране (празен регистър без история) или регистър отпреди 4J1B.
        bindId = randomUUID()
        ensureProfileDeletionLedgerRecord(input.ledgerPath, { v: 1, kind: 'ledger_genesis', ledgerId: bindId, recordedAt: new Date().toISOString() })
        binding = 'created'
      }
      let restoreDetected = false
      if (binding !== 'refused' && input.offsiteRequired && control.unreleasedRestoreIds.length === 0 && !isAckValid()) {
        // Има история, която в оригиналната среда изисква offsite потвърждение,
        // а валиден ack няма -> регистърът е възстановен/подменен извън `merge`.
        const ackRequiringInLedger = ledger.records.some((record) =>
          (isRequestLifecycleLedgerRecord(record) && (record.kind === 'request_deletion_decided' || record.kind === 'request_db_deleted')) ||
          (isAdminProfileDeletionLedgerRecord(record) && record.kind === 'admin_delete_completed'))
        if (ackRequiringInLedger || ackRequiringInDb) {
          ensureProfileDeletionLedgerRecord(input.ledgerPath, { v: 1, kind: 'ledger_restored', restoreId: randomUUID(), origin: 'server_detected', newestSnapshotCreatedAt: null, recordedAt: new Date().toISOString() })
          restoreDetected = true
        }
      }
      return { binding, bindId, restoreDetected }
    })
    if (outcome.bindId !== null) insertSetting.run(PROFILE_DELETION_LEDGER_ID_SETTING, outcome.bindId)
    if (outcome.restoreDetected) log('[profile-deletion-history] RESTORE DETECTED: история без валиден offsite ack — нови необратими решения чакат release-restore')
    return { binding: outcome.binding, restoreDetected: outcome.restoreDetected }
  }

  function assess(): ProfileDeletionHistoryAssessment {
    const reasons: string[] = []
    const blocked = new Set<string>()
    let ledger: ReturnType<typeof readProfileDeletionLedger>
    try {
      ledger = readProfileDeletionLedger(input.ledgerPath)
    } catch {
      return { verified: false, restoreHold: true, reasons: ['ledger_unreadable'], blockedProfileIds: [], unreleasedRestoreIds: [] }
    }
    if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) {
      return { verified: false, restoreHold: true, reasons: ['ledger_unreadable'], blockedProfileIds: [], unreleasedRestoreIds: [] }
    }
    const control = summarizeLedgerControl(ledger.records)
    if (control.genesisIds.length > 1) reasons.push('ledger_genesis_conflict')
    const boundId = getBoundLedgerId()
    if (boundId !== null) {
      if (!ledger.exists) reasons.push('ledger_missing')
      else if (control.genesisIds[0] !== boundId) reasons.push('ledger_mismatch')
    } else if (ledger.records.length === 0 && dbHasLedgerHistory()) {
      reasons.push('ledger_missing')
    } else if (control.genesisIds.length === 0) {
      reasons.push('ledger_unbound')
    }

    const requestStates = summarizeRequestLedgerState(ledger.records)
    const adminOperations = summarizeAdminLedgerOperations(ledger.records)

    // Регистърът е по-стар от базата.
    for (const { request_id } of selectDbDeletedRequests.all() as Array<{ request_id: string }>) {
      const state = requestStates.get(request_id)
      if (state === undefined || (state.intent === null && state.decided === null && state.dbDeleted === null)) reasons.push(`ledger_behind_db:request:${request_id}`)
    }
    for (const { request_id } of selectRecordedCancellations.all() as Array<{ request_id: string }>) {
      if (requestStates.get(request_id)?.cancel == null) reasons.push(`ledger_behind_db:cancellation:${request_id}`)
    }
    for (const { log_id } of selectAdminDeletions.all() as Array<{ log_id: string }>) {
      if (!adminOperations.has(log_id)) reasons.push(`ledger_behind_db:admin:${log_id}`)
    }
    const pendingOps = selectPendingAdminOps.all() as Array<{ ledger_operation_id: string | null; target_profile_id: string }>
    for (const pending of pendingOps) {
      if (pending.ledger_operation_id !== null && !adminOperations.has(pending.ledger_operation_id)) reasons.push(`ledger_behind_db:admin_intent:${pending.ledger_operation_id}`)
    }

    // Базата е по-стара от регистъра (restore без reconcile).
    for (const state of requestStates.values()) {
      if (state.resolution === 'cancel_conflict') reasons.push(`ledger_cancel_conflict:${state.requestId}`)
      // 'intent' — регистър отпреди 4J1B (намерението е доказателство, както в reconcile).
      if (state.resolution !== 'deleted' && state.resolution !== 'intent') continue
      const profileId = state.decided?.profileId ?? state.dbDeleted?.profileId ?? state.intent?.profileId
      if (profileId === undefined || selectProfile.get(profileId) === undefined) continue
      const request = selectRequest.get(state.requestId) as { request_id: string; status: string } | undefined
      // Активна заявка във възстановената база -> worker-ът я довършва сам (решението важи).
      if (request !== undefined && ['pending', 'executing', 'blocked', 'failed'].includes(request.status)) continue
      reasons.push(`unreconciled_deletion:${state.requestId}`)
      blocked.add(profileId)
    }
    const pendingTargets = new Set(pendingOps.map((pending) => pending.target_profile_id))
    for (const operation of adminOperations.values()) {
      if (operation.state !== 'completed' && operation.state !== 'intent_only') continue
      const profile = selectProfileIdentity.get(operation.profileId) as { account_id: string | null; created_at: string } | undefined
      if (profile === undefined) continue
      if (operation.state === 'completed') {
        // Нов профил със същия фиксиран ID (друг акаунт, създаден след изтриването).
        if (isAdminDeletedProfileProvenRecreated(operation, profile)) continue
        reasons.push(`unreconciled_admin_deletion:${operation.operationId}`)
        blocked.add(operation.profileId)
      } else if (control.unreleasedRestoreIds.length > 0 && !pendingTargets.has(operation.profileId)) {
        // При restore hold: намерение без висящ ред — изпълнението може да е изгубено.
        blocked.add(operation.profileId)
      }
    }

    return {
      verified: reasons.length === 0,
      restoreHold: control.unreleasedRestoreIds.length > 0,
      reasons,
      blockedProfileIds: [...blocked],
      unreleasedRestoreIds: control.unreleasedRestoreIds,
    }
  }

  return { initialize, assess, close: () => database.close() }
}
