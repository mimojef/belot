import { randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type PendingProfileModerationAction = 'ban' | 'delete'

export type PendingProfileModeration = {
  pendingId: string
  targetProfileId: ProfileId
  action: PendingProfileModerationAction
  banId: string | null
  requestedByProfileId: ProfileId
  requestedByAccountId: string | null
  reason: string
  requestedAt: string
  /**
   * Само за action='delete' — explicit support-request attribution (виж
   * "Изтрий профила по тази заявка" в support chat UI-я), пренесена от
   * scheduling момента до terminal completion hardDeleteProfile() извикването.
   * NULL за normal admin delete без support context. Вече validate-нат ПРЕДИ
   * записване тук (виж recordPendingDelete doc коментара) — терминалният
   * completion hook пак re-validate-ва authoritative вътре в
   * hardDeleteProfile-овата транзакция (defense-in-depth, не приема доверие
   * само защото вече е бил валиден при scheduling — message може теоретично
   * да е станал невалиден междувременно).
   */
  supportRequestMessageId: string | null
  /**
   * Етап 4F1 — операцията в регистъра на изтриванията (admin_delete_intent),
   * само за action='delete'. NULL за pending бан и за редове отпреди 4F1.
   */
  ledgerOperationId: string | null
}

export type PendingProfileModerationStore = {
  /**
   * Записва pending BAN enforcement — извиква се вместо immediate
   * banProfileConnections(), когато target е реален human participant в
   * активна игра (spec round 4 §5/§9). Само socket disconnect-ът се отлага;
   * profile_bans редът вече е записан ПРЕДИ това извикване (banId reference
   * тук), session revocation вече е изпълнен. Idempotent по target: ако вече
   * има pending ред за този профил (race — два admin действия почти
   * едновременно), просто презаписва action/reason/banId, не throw-ва.
   */
  recordPendingBan: (input: {
    targetProfileId: ProfileId
    banId: string
    requestedByProfileId: ProfileId
  }) => void
  /**
   * Записва pending HARD DELETE — извиква се ВМЕСТО
   * profileHardDeleteService.hardDeleteProfile(), когато target е активен
   * participant (spec round 4 §6/§9). Физическото DELETE FROM profiles се
   * отлага изцяло до game-end hook-а (виж applyPendingModerationForRoom в
   * index.ts). Idempotent по target.
   *
   * supportRequestMessageId (round 3 корекция) — вече ВАЛИДИРАН от caller-а
   * (index.ts's handleAdminProfileHardDeleteRequest) ПРЕДИ да се извика тук
   * — този store слой не прави authoritative проверка (не има достъп до
   * support_messages в тази DB connection), само persist-ва каквото вече е
   * доверено. Terminal completion hook-ът пак re-validate-ва authoritative
   * вътре в hardDeleteProfile-овата транзакция.
   */
  recordPendingDelete: (input: {
    targetProfileId: ProfileId
    requestedByProfileId: ProfileId
    requestedByAccountId: string
    reason: string
    supportRequestMessageId?: string | null
    /** Етап 4F1 — операцията в регистъра (записва се ПРЕДИ намерението). */
    ledgerOperationId?: string | null
  }) => void
  /** Pending enforcement за конкретен профил, ако има такъв — null иначе. */
  getPending: (targetProfileId: ProfileId) => PendingProfileModeration | null
  /** Етап 4F1 — всички висящи административни изтривания. */
  listPendingDeletes: () => PendingProfileModeration[]
  /** Етап 4F1 — висящото изтриване на тази операция (ако още го има). */
  getPendingDeleteByOperation: (ledgerOperationId: string) => PendingProfileModeration | null
  /** Етап 4F1 — задава операция на висящо изтриване без такава (редове отпреди 4F1). */
  assignLedgerOperation: (pendingId: string, ledgerOperationId: string) => boolean
  /** Етап 4F1 — премахва висящото изтриване САМО ако е още същата операция. */
  clearPendingDeleteForOperation: (ledgerOperationId: string) => void
  /** Премахва pending реда след успешно приложено enforcement (game-end hook-а). */
  clearPending: (targetProfileId: ProfileId) => void
  close: () => void
}

export async function createPendingProfileModerationStore(
  databaseFilePath: string,
): Promise<PendingProfileModerationStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectPendingStatement = database.prepare(`
    SELECT pending_id, target_profile_id, action, ban_id,
           requested_by_profile_id, requested_by_account_id, reason, requested_at,
           support_request_message_id, ledger_operation_id
    FROM pending_profile_moderation
    WHERE target_profile_id = ?
    LIMIT 1;
  `)
  const selectPendingDeletesStatement = database.prepare(`
    SELECT pending_id, target_profile_id, action, ban_id,
           requested_by_profile_id, requested_by_account_id, reason, requested_at,
           support_request_message_id, ledger_operation_id
    FROM pending_profile_moderation
    WHERE action = 'delete'
    ORDER BY requested_at, pending_id;
  `)
  const selectPendingDeleteByOperationStatement = database.prepare(`
    SELECT pending_id, target_profile_id, action, ban_id,
           requested_by_profile_id, requested_by_account_id, reason, requested_at,
           support_request_message_id, ledger_operation_id
    FROM pending_profile_moderation
    WHERE ledger_operation_id = ? AND action = 'delete'
    LIMIT 1;
  `)
  const assignLedgerOperationStatement = database.prepare(`
    UPDATE pending_profile_moderation SET ledger_operation_id = ?
    WHERE pending_id = ? AND action = 'delete' AND ledger_operation_id IS NULL;
  `)
  const deletePendingForOperationStatement = database.prepare(`
    DELETE FROM pending_profile_moderation WHERE ledger_operation_id = ?;
  `)

  const upsertPendingStatement = database.prepare(`
    INSERT INTO pending_profile_moderation (
      pending_id, target_profile_id, action, ban_id,
      requested_by_profile_id, requested_by_account_id, reason, support_request_message_id,
      ledger_operation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (target_profile_id) DO UPDATE SET
      action = excluded.action,
      ban_id = excluded.ban_id,
      requested_by_profile_id = excluded.requested_by_profile_id,
      requested_by_account_id = excluded.requested_by_account_id,
      reason = excluded.reason,
      support_request_message_id = excluded.support_request_message_id,
      ledger_operation_id = excluded.ledger_operation_id,
      requested_at = CURRENT_TIMESTAMP;
  `)

  const deletePendingStatement = database.prepare(`
    DELETE FROM pending_profile_moderation WHERE target_profile_id = ?;
  `)

  function toPending(row: {
    pending_id: string
    target_profile_id: string
    action: string
    ban_id: string | null
    requested_by_profile_id: string
    requested_by_account_id: string | null
    reason: string
    requested_at: string
    support_request_message_id: string | null
    ledger_operation_id: string | null
  }): PendingProfileModeration {
    return {
      pendingId: row.pending_id,
      targetProfileId: row.target_profile_id,
      action: row.action as PendingProfileModerationAction,
      banId: row.ban_id,
      requestedByProfileId: row.requested_by_profile_id,
      requestedByAccountId: row.requested_by_account_id,
      reason: row.reason,
      requestedAt: row.requested_at,
      supportRequestMessageId: row.support_request_message_id,
      ledgerOperationId: row.ledger_operation_id,
    }
  }

  function getPending(targetProfileId: ProfileId): PendingProfileModeration | null {
    const row = selectPendingStatement.get(targetProfileId) as
      | {
          pending_id: string
          target_profile_id: string
          action: string
          ban_id: string | null
          requested_by_profile_id: string
          requested_by_account_id: string | null
          reason: string
          requested_at: string
          support_request_message_id: string | null
          ledger_operation_id: string | null
        }
      | undefined
    return row === undefined ? null : toPending(row)
  }

  function listPendingDeletes(): PendingProfileModeration[] {
    return (selectPendingDeletesStatement.all() as Parameters<typeof toPending>[0][]).map(toPending)
  }

  function getPendingDeleteByOperation(ledgerOperationId: string): PendingProfileModeration | null {
    const row = selectPendingDeleteByOperationStatement.get(ledgerOperationId) as Parameters<typeof toPending>[0] | undefined
    return row === undefined ? null : toPending(row)
  }

  function assignLedgerOperation(pendingId: string, ledgerOperationId: string): boolean {
    return Number((assignLedgerOperationStatement.run(ledgerOperationId, pendingId) as { changes: number }).changes) === 1
  }

  function clearPendingDeleteForOperation(ledgerOperationId: string): void {
    deletePendingForOperationStatement.run(ledgerOperationId)
  }

  function recordPendingBan(input: {
    targetProfileId: ProfileId
    banId: string
    requestedByProfileId: ProfileId
  }): void {
    upsertPendingStatement.run(
      randomUUID(),
      input.targetProfileId,
      'ban',
      input.banId,
      input.requestedByProfileId,
      null,
      // reason тук е чисто administrative placeholder — profile_bans.reason
      // (referenced през ban_id) остава единственият source of truth,
      // показван на клиента. trim(reason)<>'' CHECK изисква non-blank.
      'pending ban enforcement',
      null, // support_request_message_id — не се прилага за action='ban'
      null, // ledger_operation_id — само за action='delete'
    )
  }

  function recordPendingDelete(input: {
    targetProfileId: ProfileId
    requestedByProfileId: ProfileId
    requestedByAccountId: string
    reason: string
    supportRequestMessageId?: string | null
    ledgerOperationId?: string | null
  }): void {
    upsertPendingStatement.run(
      randomUUID(),
      input.targetProfileId,
      'delete',
      null,
      input.requestedByProfileId,
      input.requestedByAccountId,
      input.reason,
      input.supportRequestMessageId ?? null,
      input.ledgerOperationId ?? null,
    )
  }

  function clearPending(targetProfileId: ProfileId): void {
    deletePendingStatement.run(targetProfileId)
  }

  function close(): void {
    database.close()
  }

  return {
    recordPendingBan,
    recordPendingDelete,
    getPending,
    listPendingDeletes,
    getPendingDeleteByOperation,
    assignLedgerOperation,
    clearPendingDeleteForOperation,
    clearPending,
    close,
  }
}
