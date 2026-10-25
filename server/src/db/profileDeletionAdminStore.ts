// Самоизтриване на профили — Етап 4J: административен преглед на заявките
// и операциите по изтриване + контролирана административна отмяна на
// ДОБРОВОЛНА заявка.
//
// Преглед (само четене, лимит в SQL, най-новите първи):
//   * доброволни заявки — profile_deletion_requests (+ файлова опашка,
//     одит на административна отмяна, кой е отменил);
//   * административни операции — висящи (pending_profile_moderation,
//     action='delete') и приключили (admin_profile_deletions). Само за
//     наблюдение — този етап НЕ дава право за отмяната им.
// Поверителност: профил (ID + текущо име) се показва САМО докато редът в
// profiles съществува. За изтрит профил — само техническият идентификатор на
// операцията (request_id / log_id); никога snapshot имена, имейли, IP,
// visitor ID, файлови пътища, ledger съдържание.
//
// Отмяна (cancelVoluntaryRequestByAdmin) — Етап 4J1, фаза 1 (ПРИЕМАНЕ) в една
// BEGIN IMMEDIATE транзакция (същият writer lock като worker-а):
//   * актьорът е admin ПО БАЗАТА (не по сесията) и профилът е негов;
//   * заявката е pending/blocked/failed, без lease, преди db_deleted_at,
//     профилът още съществува, няма вече приета отмяна;
//   * регистърът не съдържа необратимо решение или доказано изтриване;
//   * одитен ред (причина + администратор) + ред в
//     profile_deletion_cancellations — всичко или нищо. От този момент
//     worker-ът не може да изтрие профила.
// Записът в регистъра и финализирането след offsite потвърждение са в
// core/profileDeletionCancellationFinalizer.ts. Вече записано намерение за
// изтриване (бан/чакащо offsite) НЕ пречи: отмяната е по-късен запис в
// същия регистър и reconcile я спазва.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ADMIN_HARD_DELETE_ACTOR_AUTHORIZED_SQL } from './profileDeletionExecutor.js'
import {
  getProfileDeletionLedgerOffsiteAckPath,
  isRequestLifecycleLedgerRecord,
  parseProfileDeletionLedgerBuffer,
  profileDeletionCancellationLedgerKey,
  profileDeletionLedgerRecordKey,
  readProfileDeletionLedgerOffsiteAck,
  sha256Hex,
} from './profileDeletionLedger.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const PROFILE_DELETION_ADMIN_LIST_MAX = 300
export const PROFILE_DELETION_ADMIN_CANCEL_REASON_MAX = 500

export const PROFILE_DELETION_ADMIN_CATEGORIES = [
  'cancellation_pending',
  'pending_cancellable',
  'pending_overdue',
  'blocked_ban',
  'blocked_participation',
  'awaiting_offsite',
  'blocked_other',
  'failed',
  'executing',
  'files_pending',
  'cancelled',
  'completed',
  'admin_scheduled',
] as const
export type ProfileDeletionAdminCategory = (typeof PROFILE_DELETION_ADMIN_CATEGORIES)[number]

export type ProfileDeletionAdminCancelBlocker =
  | 'not_voluntary'
  | 'status_not_cancellable'
  | 'irreversible'
  | 'lease_held'
  | 'profile_missing'
  | 'cancellation_pending'

export type ProfileDeletionAdminRow = {
  kind: 'voluntary' | 'admin'
  operationId: string
  category: ProfileDeletionAdminCategory
  status: string
  /** Само докато профилът съществува (живите profiles/accounts); след изтриване — null. */
  profile: { profileId: string; displayName: string; email: string | null } | null
  requestedAt: string | null
  scheduledFor: string | null
  gracePeriodDays: number | null
  cancelledAt: string | null
  cancelledBy: 'user' | 'system' | 'admin' | null
  completedAt: string | null
  dbDeletedAt: string | null
  lastErrorCode: string | null
  nextAttemptAt: string | null
  attemptCount: number | null
  filesPending: number
  filesFailed: number
  fileCleanupStatus: string | null
  awaitingOffsite: boolean
  adminCancellation: { reason: string; createdAt: string; actorDisplayName: string | null } | null
  /** Етап 4J1 — приета отмяна (фаза: чака запис в регистъра / offsite потвърждение / окончателна). */
  cancellation: {
    source: 'user' | 'admin' | 'system'
    acceptedAt: string
    stage: 'awaiting_ledger' | 'awaiting_offsite' | 'finalized'
    recoveredFromLedger: boolean
  } | null
  canCancel: boolean
  cancelBlocker: ProfileDeletionAdminCancelBlocker | null
}

export type ProfileDeletionLedgerView = {
  /** Регистърът съдържа необратимо решение или доказано изтриване за заявката. Нечетим регистър -> false (решава базата). */
  hasDbDeletedRecord: (requestId: string) => boolean
  /** Отмяната на заявката е потвърдено копирана извън VPS (точен префикс + SHA-256). */
  isCancellationConfirmedOffsite: (requestId: string) => boolean
  /** Дали намерението на административна операция е потвърдено извън VPS. */
  isAdminIntentConfirmedOffsite: (operationId: string) => boolean
}

/**
 * Еднократно четене на регистъра (за списъка или вътре в транзакцията на
 * отмяната). Никога не пише и не връща съдържание навън — само булеви
 * отговори по requestId/operationId.
 */
export function loadProfileDeletionLedgerView(ledgerPath: string, ackPath: string = getProfileDeletionLedgerOffsiteAckPath(ledgerPath)): ProfileDeletionLedgerView {
  let buffer: Buffer | null = null
  try {
    buffer = readFileSync(ledgerPath)
  } catch {
    buffer = null
  }
  const dbDeletedRequestIds = new Set<string>()
  if (buffer !== null) {
    const parsed = parseProfileDeletionLedgerBuffer(buffer)
    if (parsed.invalidLineCount === 0 && parsed.conflictingDuplicateCount === 0) {
      for (const record of parsed.records) {
        if (isRequestLifecycleLedgerRecord(record) && (record.kind === 'request_db_deleted' || record.kind === 'request_deletion_decided')) dbDeletedRequestIds.add(record.requestId)
      }
    }
  }

  let confirmedKeys: Set<string> | null = null
  const loadConfirmedKeys = (): Set<string> => {
    if (confirmedKeys !== null) return confirmedKeys
    confirmedKeys = new Set()
    try {
      const ack = readProfileDeletionLedgerOffsiteAck(ackPath)
      if (ack !== null && ack.bytes > 0 && buffer !== null && buffer.length >= ack.bytes) {
        const prefix = buffer.subarray(0, ack.bytes)
        if (prefix[prefix.length - 1] === 0x0a && sha256Hex(prefix) === ack.sha256) {
          const parsedPrefix = parseProfileDeletionLedgerBuffer(prefix)
          if (parsedPrefix.invalidLineCount === 0 && parsedPrefix.conflictingDuplicateCount === 0) {
            for (const record of parsedPrefix.records) confirmedKeys.add(profileDeletionLedgerRecordKey(record))
          }
        }
      }
    } catch {
      // fail-closed: непотвърдено
    }
    return confirmedKeys
  }

  return {
    hasDbDeletedRecord: (requestId) => dbDeletedRequestIds.has(requestId),
    isCancellationConfirmedOffsite: (requestId) => loadConfirmedKeys().has(profileDeletionCancellationLedgerKey(requestId)),
    isAdminIntentConfirmedOffsite: (operationId) => loadConfirmedKeys().has(`admin_delete_intent:${operationId}`),
  }
}

export type CancelVoluntaryRequestByAdminResult =
  | { ok: true; requestId: string; profileId: string; cancellationId: string; revokedSessions: number }
  | {
      ok: false
      code:
        | 'forbidden'
        | 'invalid_reason'
        | 'not_found'
        | ProfileDeletionAdminCancelBlocker
    }

export type ProfileDeletionAdminStore = {
  isActorAdmin: (actorAccountId: string, actorProfileId: string) => boolean
  listOverview: (input: {
    limit?: number
    kind?: 'voluntary' | 'admin' | null
    category?: ProfileDeletionAdminCategory | null
    ledger: ProfileDeletionLedgerView
  }) => ProfileDeletionAdminRow[]
  cancelVoluntaryRequestByAdmin: (input: {
    requestId: string
    actorProfileId: string
    actorAccountId: string
    reason: string
    /** Регистърът съдържа доказано изтриване на заявката -> отказ 'irreversible'. */
    isDeletionProven?: (requestId: string) => boolean
    /** Само тестове: точка за симулиране на грешка преди COMMIT. */
    beforeCommit?: () => void
  }) => CancelVoluntaryRequestByAdminResult
  close: () => void
}

const PARTICIPATION_CODES = ['active_game', 'active_game_local', 'active_tournament', 'pending_tournament_invite']

export function normalizeAdminCancelReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Без управляващи символи; празна или само от интервали -> невалидна.
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
  if (cleaned.length === 0 || cleaned.length > PROFILE_DELETION_ADMIN_CANCEL_REASON_MAX) return null
  return cleaned
}

export async function createProfileDeletionAdminStore(databaseFilePath: string): Promise<ProfileDeletionAdminStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectActorAuthorizedStatement = database.prepare(ADMIN_HARD_DELETE_ACTOR_AUTHORIZED_SQL)
  const participationList = PARTICIPATION_CODES.map((code) => `'${code}'`).join(', ')

  // Един UNION ALL, филтрите и лимитът са в SQL. Ключът за подреждане е
  // нормализиран към каноничен UTC ISO (CURRENT_TIMESTAMP форматите в
  // pending_profile_moderation/admin_profile_deletions също се превръщат).
  const selectOverviewStatement = database.prepare(`
    SELECT * FROM (
      SELECT
        'voluntary' AS kind,
        r.request_id AS operation_id,
        CASE
          WHEN r.status = 'cancelled' THEN 'cancelled'
          WHEN r.status = 'completed' THEN 'completed'
          WHEN r.db_deleted_at IS NOT NULL THEN 'files_pending'
          WHEN r.status = 'executing' THEN 'executing'
          WHEN pc.request_id IS NOT NULL AND pc.finalized_at IS NULL THEN 'cancellation_pending'
          WHEN r.status = 'blocked' AND r.last_error_code = 'active_ban' THEN 'blocked_ban'
          WHEN r.status = 'blocked' AND r.last_error_code = 'ledger_offsite_pending' THEN 'awaiting_offsite'
          WHEN r.status = 'blocked' AND r.last_error_code IN (${participationList}) THEN 'blocked_participation'
          WHEN r.status = 'blocked' THEN 'blocked_other'
          WHEN r.status = 'failed' THEN 'failed'
          WHEN r.scheduled_for > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 'pending_cancellable'
          ELSE 'pending_overdue'
        END AS category,
        r.status AS status,
        p.profile_id AS live_profile_id,
        p.display_name AS live_display_name,
        (SELECT la.email FROM accounts la WHERE la.account_id = p.account_id) AS live_email,
        r.requested_at AS requested_at,
        r.scheduled_for AS scheduled_for,
        r.grace_period_days AS grace_period_days,
        r.cancelled_at AS cancelled_at,
        (SELECT e.actor_kind FROM profile_deletion_events e
          WHERE e.request_id = r.request_id AND e.event_type = 'cancelled'
          ORDER BY e.event_seq DESC LIMIT 1) AS cancelled_by,
        r.completed_at AS completed_at,
        r.db_deleted_at AS db_deleted_at,
        r.last_error_code AS last_error_code,
        r.next_attempt_at AS next_attempt_at,
        r.attempt_count AS attempt_count,
        r.lease_owner AS lease_owner,
        (SELECT COUNT(*) FROM profile_deletion_file_queue q
          WHERE q.request_id = r.request_id AND q.status NOT IN ('done', 'skipped_shared')) AS files_pending,
        (SELECT COUNT(*) FROM profile_deletion_file_queue q
          WHERE q.request_id = r.request_id AND q.status = 'failed') AS files_failed,
        NULL AS file_cleanup_status,
        ac.reason AS admin_cancel_reason,
        ac.created_at AS admin_cancel_at,
        ap.display_name AS admin_cancel_actor_name,
        pc.source AS cancellation_source,
        pc.accepted_at AS cancellation_accepted_at,
        pc.ledger_recorded_at AS cancellation_ledger_recorded_at,
        pc.finalized_at AS cancellation_finalized_at,
        pc.recovered_from_ledger AS cancellation_recovered,
        strftime('%Y-%m-%dT%H:%M:%fZ', r.requested_at) AS sort_at
      FROM profile_deletion_requests r
      LEFT JOIN profiles p ON p.profile_id = r.profile_id
      LEFT JOIN profile_deletion_admin_cancellations ac ON ac.request_id = r.request_id
      LEFT JOIN profiles ap ON ap.profile_id = ac.actor_profile_id
      LEFT JOIN profile_deletion_cancellations pc ON pc.request_id = r.request_id

      UNION ALL

      SELECT
        'admin' AS kind,
        COALESCE(m.ledger_operation_id, m.pending_id) AS operation_id,
        'admin_scheduled' AS category,
        'scheduled' AS status,
        p.profile_id AS live_profile_id,
        p.display_name AS live_display_name,
        (SELECT la.email FROM accounts la WHERE la.account_id = p.account_id) AS live_email,
        strftime('%Y-%m-%dT%H:%M:%fZ', m.requested_at) AS requested_at,
        NULL AS scheduled_for,
        NULL AS grace_period_days,
        NULL AS cancelled_at,
        NULL AS cancelled_by,
        NULL AS completed_at,
        NULL AS db_deleted_at,
        NULL AS last_error_code,
        NULL AS next_attempt_at,
        NULL AS attempt_count,
        NULL AS lease_owner,
        0 AS files_pending,
        0 AS files_failed,
        NULL AS file_cleanup_status,
        NULL AS admin_cancel_reason,
        NULL AS admin_cancel_at,
        NULL AS admin_cancel_actor_name,
        NULL AS cancellation_source,
        NULL AS cancellation_accepted_at,
        NULL AS cancellation_ledger_recorded_at,
        NULL AS cancellation_finalized_at,
        NULL AS cancellation_recovered,
        strftime('%Y-%m-%dT%H:%M:%fZ', m.requested_at) AS sort_at
      FROM pending_profile_moderation m
      LEFT JOIN profiles p ON p.profile_id = m.target_profile_id
      WHERE m.action = 'delete'

      UNION ALL

      SELECT
        'admin' AS kind,
        d.log_id AS operation_id,
        CASE WHEN d.file_cleanup_status = 'pending' THEN 'files_pending' ELSE 'completed' END AS category,
        'completed' AS status,
        NULL AS live_profile_id,
        NULL AS live_display_name,
        NULL AS live_email,
        NULL AS requested_at,
        NULL AS scheduled_for,
        NULL AS grace_period_days,
        NULL AS cancelled_at,
        NULL AS cancelled_by,
        strftime('%Y-%m-%dT%H:%M:%fZ', d.deleted_at) AS completed_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', d.deleted_at) AS db_deleted_at,
        NULL AS last_error_code,
        NULL AS next_attempt_at,
        NULL AS attempt_count,
        NULL AS lease_owner,
        (SELECT COUNT(*) FROM profile_deletion_file_queue q
          WHERE q.admin_operation_id = d.log_id AND q.status NOT IN ('done', 'skipped_shared')) AS files_pending,
        (SELECT COUNT(*) FROM profile_deletion_file_queue q
          WHERE q.admin_operation_id = d.log_id AND q.status = 'failed') AS files_failed,
        d.file_cleanup_status AS file_cleanup_status,
        NULL AS admin_cancel_reason,
        NULL AS admin_cancel_at,
        NULL AS admin_cancel_actor_name,
        NULL AS cancellation_source,
        NULL AS cancellation_accepted_at,
        NULL AS cancellation_ledger_recorded_at,
        NULL AS cancellation_finalized_at,
        NULL AS cancellation_recovered,
        strftime('%Y-%m-%dT%H:%M:%fZ', d.deleted_at) AS sort_at
      FROM admin_profile_deletions d
    )
    WHERE (?1 IS NULL OR kind = ?1)
      AND (?2 IS NULL OR category = ?2)
    ORDER BY sort_at DESC, operation_id DESC
    LIMIT ?3;
  `)

  const selectRequestForCancelStatement = database.prepare(`
    SELECT r.request_id, r.profile_id, r.status, r.lease_owner, r.db_deleted_at,
           EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = r.profile_id) AS profile_exists,
           EXISTS (SELECT 1 FROM profile_deletion_cancellations c WHERE c.request_id = r.request_id) AS has_cancellation
    FROM profile_deletion_requests r
    WHERE r.request_id = ?
    LIMIT 1;
  `)
  const insertAdminCancellationStatement = database.prepare(`
    INSERT INTO profile_deletion_admin_cancellations (cancellation_id, request_id, actor_profile_id, actor_account_id, reason, previous_status)
    VALUES (?, ?, ?, ?, ?, ?);
  `)
  const insertCancellationStatement = database.prepare(`
    INSERT INTO profile_deletion_cancellations (cancellation_id, request_id, profile_id, source, previous_status)
    VALUES (?, ?, ?, 'admin', ?);
  `)
  // Защитно: сесиите са отнети при подаването и никога не се възстановяват;
  // отмяната не създава и не "съживява" сесия — следва нов вход.
  const revokeSessionsStatement = database.prepare(`
    UPDATE account_sessions SET revoked_at = CURRENT_TIMESTAMP
    WHERE profile_id = ? AND revoked_at IS NULL;
  `)

  function isActorAdmin(actorAccountId: string, actorProfileId: string): boolean {
    return selectActorAuthorizedStatement.get(actorAccountId, actorProfileId) !== undefined
  }

  type OverviewRow = {
    kind: 'voluntary' | 'admin'
    operation_id: string
    category: ProfileDeletionAdminCategory
    status: string
    live_profile_id: string | null
    live_display_name: string | null
    live_email: string | null
    requested_at: string | null
    scheduled_for: string | null
    grace_period_days: number | null
    cancelled_at: string | null
    cancelled_by: string | null
    completed_at: string | null
    db_deleted_at: string | null
    last_error_code: string | null
    next_attempt_at: string | null
    attempt_count: number | null
    lease_owner: string | null
    files_pending: number
    files_failed: number
    file_cleanup_status: string | null
    admin_cancel_reason: string | null
    admin_cancel_at: string | null
    admin_cancel_actor_name: string | null
    cancellation_source: 'user' | 'admin' | 'system' | null
    cancellation_accepted_at: string | null
    cancellation_ledger_recorded_at: string | null
    cancellation_finalized_at: string | null
    cancellation_recovered: number | null
  }

  function cancelBlockerFor(row: OverviewRow, ledger: ProfileDeletionLedgerView): ProfileDeletionAdminCancelBlocker | null {
    if (row.kind !== 'voluntary') return 'not_voluntary'
    if (row.db_deleted_at !== null || row.status === 'completed') return 'irreversible'
    if (row.lease_owner !== null) return 'lease_held'
    if (!['pending', 'blocked', 'failed'].includes(row.status)) return 'status_not_cancellable'
    if (row.cancellation_source !== null) return 'cancellation_pending'
    if (row.live_profile_id === null) return 'profile_missing'
    if (ledger.hasDbDeletedRecord(row.operation_id)) return 'irreversible'
    return null
  }

  function listOverview(input: Parameters<ProfileDeletionAdminStore['listOverview']>[0]): ProfileDeletionAdminRow[] {
    const limit = Math.max(1, Math.min(PROFILE_DELETION_ADMIN_LIST_MAX, Math.floor(input.limit ?? PROFILE_DELETION_ADMIN_LIST_MAX)))
    const rows = selectOverviewStatement.all(input.kind ?? null, input.category ?? null, limit) as OverviewRow[]
    return rows.map((row) => {
      const blocker = cancelBlockerFor(row, input.ledger)
      const cancelledBy = row.cancelled_by === 'user' || row.cancelled_by === 'system' || row.cancelled_by === 'admin' ? row.cancelled_by : null
      return {
        kind: row.kind,
        operationId: row.operation_id,
        category: row.category,
        status: row.status,
        profile: row.live_profile_id !== null && row.live_display_name !== null
          ? { profileId: row.live_profile_id, displayName: row.live_display_name, email: row.live_email }
          : null,
        requestedAt: row.requested_at,
        scheduledFor: row.scheduled_for,
        gracePeriodDays: row.grace_period_days === null ? null : Number(row.grace_period_days),
        cancelledAt: row.cancelled_at,
        cancelledBy,
        completedAt: row.completed_at,
        dbDeletedAt: row.db_deleted_at,
        lastErrorCode: row.last_error_code,
        nextAttemptAt: row.next_attempt_at,
        attemptCount: row.attempt_count === null ? null : Number(row.attempt_count),
        filesPending: Number(row.files_pending ?? 0),
        filesFailed: Number(row.files_failed ?? 0),
        fileCleanupStatus: row.file_cleanup_status,
        awaitingOffsite: row.category === 'admin_scheduled' && !input.ledger.isAdminIntentConfirmedOffsite(row.operation_id),
        // Причината (свободен текст на администратор) — само докато профилът съществува.
        adminCancellation: row.live_profile_id !== null && row.admin_cancel_reason !== null && row.admin_cancel_at !== null
          ? { reason: row.admin_cancel_reason, createdAt: row.admin_cancel_at, actorDisplayName: row.admin_cancel_actor_name }
          : null,
        cancellation: row.cancellation_source !== null && row.cancellation_accepted_at !== null
          ? {
              source: row.cancellation_source,
              acceptedAt: row.cancellation_accepted_at,
              stage: row.cancellation_finalized_at !== null
                ? 'finalized'
                : row.cancellation_ledger_recorded_at !== null || input.ledger.isCancellationConfirmedOffsite(row.operation_id)
                  ? 'awaiting_offsite'
                  : 'awaiting_ledger',
              recoveredFromLedger: Number(row.cancellation_recovered) === 1,
            }
          : null,
        canCancel: blocker === null,
        cancelBlocker: blocker,
      }
    })
  }

  function rollbackQuietly(): void {
    try { database.exec('ROLLBACK;') } catch { /* няма отворена транзакция */ }
  }

  function cancelVoluntaryRequestByAdmin(input: Parameters<ProfileDeletionAdminStore['cancelVoluntaryRequestByAdmin']>[0]): CancelVoluntaryRequestByAdminResult {
    const reason = normalizeAdminCancelReason(input.reason)
    if (reason === null) return { ok: false, code: 'invalid_reason' }
    database.exec('BEGIN IMMEDIATE;')
    try {
      // Актуалната роля — по базата, вътре в транзакцията.
      if (!isActorAdmin(input.actorAccountId, input.actorProfileId)) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'forbidden' }
      }
      const row = selectRequestForCancelStatement.get(input.requestId) as
        | { request_id: string; profile_id: string; status: string; lease_owner: string | null; db_deleted_at: string | null; profile_exists: number; has_cancellation: number }
        | undefined
      if (row === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'not_found' }
      }
      let blocker: ProfileDeletionAdminCancelBlocker | null = null
      if (row.db_deleted_at !== null || row.status === 'completed') blocker = 'irreversible'
      else if (row.lease_owner !== null) blocker = 'lease_held'
      else if (!['pending', 'blocked', 'failed'].includes(row.status)) blocker = 'status_not_cancellable'
      else if (Number(row.has_cancellation) === 1) blocker = 'cancellation_pending'
      else if (Number(row.profile_exists) !== 1) blocker = 'profile_missing'
      else if (input.isDeletionProven?.(row.request_id) === true) blocker = 'irreversible'
      if (blocker !== null) {
        database.exec('ROLLBACK;')
        return { ok: false, code: blocker }
      }
      const cancellationId = randomUUID()
      // Одитът (причина + администратор) остава само в базата; в регистъра
      // отива единствено техническият запис "request_cancelled" (source admin).
      insertAdminCancellationStatement.run(cancellationId, row.request_id, input.actorProfileId, input.actorAccountId, reason, row.status)
      insertCancellationStatement.run(cancellationId, row.request_id, row.profile_id, row.status)
      const revoked = revokeSessionsStatement.run(row.profile_id) as { changes: number }
      input.beforeCommit?.()
      database.exec('COMMIT;')
      return {
        ok: true,
        requestId: row.request_id,
        profileId: row.profile_id,
        cancellationId,
        revokedSessions: Number(revoked.changes),
      }
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  return {
    isActorAdmin,
    listOverview,
    cancelVoluntaryRequestByAdmin,
    close: () => database.close(),
  }
}
