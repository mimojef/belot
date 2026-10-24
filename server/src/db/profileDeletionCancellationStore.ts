// Самоизтриване, Етап 4J1 — трайни отмени на доброволни заявки (база).
//
// Приемането (фаза 1) е в profileDeletionRequestStore (потребител/система)
// и profileDeletionAdminStore (администратор): ред в
// profile_deletion_cancellations, който веднага блокира worker-а.
// Тук са фаза 2 и 3 (виж core/profileDeletionCancellationFinalizer.ts):
//   * recordInLedger — записът в регистъра се прави, докато се държи
//     writer lock-ът на SQLite (кратък локален append + fsync, НЕ чакане на
//     offsite backup): два процеса не могат да запишат един и същ ред два
//     пъти, а срив след append-а и преди COMMIT се довършва идемпотентно;
//   * finalize — едва след offsite потвърждение: finalized_at + статус
//     'cancelled' + събитие (видимостта се връща от обичайния път);
//   * applyRecoveredCancellation — restore/reconcile възстановява отмяна,
//     открита в регистъра (recovered_from_ledger = 1).

import { randomUUID } from 'node:crypto'
import type { ProfileDeletionCancellationSource, ProfileDeletionRequestCancelledRecord } from './profileDeletionLedger.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type ProfileDeletionCancellationRow = {
  cancellationId: string
  requestId: string
  profileId: string
  source: ProfileDeletionCancellationSource
  recoveredFromLedger: boolean
  previousStatus: 'pending' | 'blocked' | 'failed'
  acceptedAt: string
  ledgerRecordedAt: string | null
  finalizedAt: string | null
}

export type FinalizeProfileDeletionCancellationResult =
  | { ok: true; requestId: string; profileId: string; source: ProfileDeletionCancellationSource; eventSeq: number }
  | { ok: false; code: 'not_found' | 'not_recorded' | 'already_finalized' | 'request_not_cancellable' }

export type ApplyRecoveredCancellationResult =
  | { ok: true; state: 'inserted' | 'already_present' | 'already_cancelled' }
  | { ok: false; code: 'request_missing' | 'profile_mismatch' | 'irreversible' | 'profile_missing' | 'lease_held' | 'conflicting_cancellation' }

export type ProfileDeletionCancellationStore = {
  getByCancellationId: (cancellationId: string) => ProfileDeletionCancellationRow | null
  getForRequest: (requestId: string) => ProfileDeletionCancellationRow | null
  /** Нефинализирана отмяна на активната заявка на профила (за входа/интерфейса). */
  getPendingForProfile: (profileId: string) => ProfileDeletionCancellationRow | null
  listUnfinalized: (limit?: number) => ProfileDeletionCancellationRow[]
  /**
   * Фаза 2. writeLedger се вика ВЪТРЕ в BEGIN IMMEDIATE (след проверката, че
   * редът още не е записан); хвърля при неуспех -> нищо не се маркира.
   */
  recordInLedger: (cancellationId: string, writeLedger: (row: ProfileDeletionCancellationRow) => void) =>
    'recorded' | 'already_recorded' | 'not_found'
  /** Изпълнява fn, докато се държи writer lock-ът (за дописване в регистъра без дублиране между процесите). */
  runInWriterLock: (fn: () => void) => void
  /** Фаза 3 — само след offsite потвърждение (проверява се от извикващия). */
  finalize: (cancellationId: string) => FinalizeProfileDeletionCancellationResult
  /**
   * Restore: запис "request_cancelled" в регистъра, а във възстановената база
   * заявката е активна -> трайна защита (recovered_from_ledger = 1). Финализира
   * се от обичайния finalizer след offsite потвърждение. releaseExecuting —
   * само процедурата след restore (сървърът е спрян): висящ lease от backup-а
   * се освобождава, ако изтриването в базата не е започнало.
   */
  applyRecoveredCancellation: (record: ProfileDeletionRequestCancelledRecord, options?: { releaseExecuting?: boolean }) => ApplyRecoveredCancellationResult
  close: () => void
}

type Row = {
  cancellation_id: string
  request_id: string
  profile_id: string
  source: ProfileDeletionCancellationSource
  recovered_from_ledger: number
  previous_status: 'pending' | 'blocked' | 'failed'
  accepted_at: string
  ledger_recorded_at: string | null
  finalized_at: string | null
}

const COLUMNS = 'cancellation_id, request_id, profile_id, source, recovered_from_ledger, previous_status, accepted_at, ledger_recorded_at, finalized_at'

function toRow(row: Row): ProfileDeletionCancellationRow {
  return {
    cancellationId: row.cancellation_id,
    requestId: row.request_id,
    profileId: row.profile_id,
    source: row.source,
    recoveredFromLedger: Number(row.recovered_from_ledger) === 1,
    previousStatus: row.previous_status,
    acceptedAt: row.accepted_at,
    ledgerRecordedAt: row.ledger_recorded_at,
    finalizedAt: row.finalized_at,
  }
}

export async function createProfileDeletionCancellationStore(databaseFilePath: string): Promise<ProfileDeletionCancellationStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectByIdStatement = database.prepare(`SELECT ${COLUMNS} FROM profile_deletion_cancellations WHERE cancellation_id = ? LIMIT 1;`)
  const selectByRequestStatement = database.prepare(`SELECT ${COLUMNS} FROM profile_deletion_cancellations WHERE request_id = ? LIMIT 1;`)
  const selectPendingForProfileStatement = database.prepare(`
    SELECT ${COLUMNS.split(', ').map((column) => `c.${column}`).join(', ')}
    FROM profile_deletion_cancellations c
    JOIN profile_deletion_requests r ON r.request_id = c.request_id
    WHERE c.profile_id = ? AND c.finalized_at IS NULL AND r.status IN ('pending', 'blocked', 'failed')
    LIMIT 1;
  `)
  const selectUnfinalizedStatement = database.prepare(`
    SELECT ${COLUMNS} FROM profile_deletion_cancellations
    WHERE finalized_at IS NULL
    ORDER BY accepted_at ASC, cancellation_id ASC
    LIMIT ?;
  `)
  const markRecordedStatement = database.prepare(`
    UPDATE profile_deletion_cancellations
    SET ledger_recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE cancellation_id = ? AND ledger_recorded_at IS NULL;
  `)
  const markFinalizedStatement = database.prepare(`
    UPDATE profile_deletion_cancellations
    SET finalized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE cancellation_id = ? AND finalized_at IS NULL AND ledger_recorded_at IS NOT NULL;
  `)
  const selectRequestStatement = database.prepare(`
    SELECT request_id, profile_id, status, lease_owner, db_deleted_at FROM profile_deletion_requests WHERE request_id = ? LIMIT 1;
  `)
  const cancelRequestStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET status = 'cancelled',
        cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        next_attempt_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE request_id = ? AND status IN ('pending', 'blocked', 'failed') AND lease_owner IS NULL AND db_deleted_at IS NULL;
  `)
  const insertEventStatement = database.prepare(`
    INSERT INTO profile_deletion_events (request_id, profile_id, event_type, actor_kind, detail_json)
    VALUES (?, ?, ?, ?, ?);
  `)
  const insertRecoveredStatement = database.prepare(`
    INSERT INTO profile_deletion_cancellations (cancellation_id, request_id, profile_id, source, recovered_from_ledger, previous_status, ledger_recorded_at)
    VALUES (?, ?, ?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `)
  const selectProfileStatement = database.prepare('SELECT 1 FROM profiles WHERE profile_id = ? LIMIT 1;')
  const releaseExecutingForRestoreStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
        last_error_code = 'restore_cancellation_recorded',
        last_error_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE request_id = ? AND status = 'executing' AND db_deleted_at IS NULL;
  `)

  function rollbackQuietly(): void {
    try { database.exec('ROLLBACK;') } catch { /* няма отворена транзакция */ }
  }

  function getByCancellationId(cancellationId: string): ProfileDeletionCancellationRow | null {
    const row = selectByIdStatement.get(cancellationId) as Row | undefined
    return row === undefined ? null : toRow(row)
  }

  function recordInLedger(cancellationId: string, writeLedger: (row: ProfileDeletionCancellationRow) => void): 'recorded' | 'already_recorded' | 'not_found' {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const row = selectByIdStatement.get(cancellationId) as Row | undefined
      if (row === undefined) {
        database.exec('ROLLBACK;')
        return 'not_found'
      }
      if (row.ledger_recorded_at !== null) {
        database.exec('ROLLBACK;')
        return 'already_recorded'
      }
      writeLedger(toRow(row))
      markRecordedStatement.run(cancellationId)
      database.exec('COMMIT;')
      return 'recorded'
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function finalize(cancellationId: string): FinalizeProfileDeletionCancellationResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const row = selectByIdStatement.get(cancellationId) as Row | undefined
      if (row === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'not_found' }
      }
      if (row.finalized_at !== null) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'already_finalized' }
      }
      if (row.ledger_recorded_at === null) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'not_recorded' }
      }
      const request = selectRequestStatement.get(row.request_id) as
        | { request_id: string; profile_id: string; status: string; lease_owner: string | null; db_deleted_at: string | null }
        | undefined
      if (request === undefined || !['pending', 'blocked', 'failed'].includes(request.status) || request.lease_owner !== null || request.db_deleted_at !== null) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'request_not_cancellable' }
      }
      markFinalizedStatement.run(cancellationId)
      const updated = cancelRequestStatement.run(row.request_id) as { changes: number }
      if (Number(updated.changes) !== 1) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'request_not_cancellable' }
      }
      const event = insertEventStatement.run(
        row.request_id,
        row.profile_id,
        'cancelled',
        row.source,
        JSON.stringify({
          source: row.source === 'user' ? 'self' : row.source,
          cancellationId: row.cancellation_id,
          previousStatus: row.previous_status,
          recoveredFromLedger: Number(row.recovered_from_ledger) === 1,
        }),
      ) as { lastInsertRowid: number | bigint }
      database.exec('COMMIT;')
      return { ok: true, requestId: row.request_id, profileId: row.profile_id, source: row.source, eventSeq: Number(event.lastInsertRowid) }
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function applyRecoveredCancellation(
    record: ProfileDeletionRequestCancelledRecord,
    options: { releaseExecuting?: boolean } = {},
  ): ApplyRecoveredCancellationResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = selectByRequestStatement.get(record.requestId) as Row | undefined
      const request = selectRequestStatement.get(record.requestId) as
        | { request_id: string; profile_id: string; status: string; lease_owner: string | null; db_deleted_at: string | null }
        | undefined
      const finish = (result: ApplyRecoveredCancellationResult, commit: boolean): ApplyRecoveredCancellationResult => {
        database.exec(commit ? 'COMMIT;' : 'ROLLBACK;')
        return result
      }
      if (request === undefined) return finish({ ok: false, code: 'request_missing' }, false)
      if (request.profile_id !== record.profileId) return finish({ ok: false, code: 'profile_mismatch' }, false)
      if (request.db_deleted_at !== null || request.status === 'completed') return finish({ ok: false, code: 'irreversible' }, false)
      if (request.status === 'cancelled') return finish({ ok: true, state: 'already_cancelled' }, false)
      if (existing !== undefined) {
        // Една отмяна на заявка; друг cancellationId е същият факт от друга
        // "времева линия" (restore) — защитата вече е налице.
        return finish({ ok: true, state: 'already_present' }, false)
      }
      let status = request.status
      if (status === 'executing') {
        if (options.releaseExecuting !== true) return finish({ ok: false, code: 'lease_held' }, false)
        const released = releaseExecutingForRestoreStatement.run(record.requestId) as { changes: number }
        if (Number(released.changes) !== 1) return finish({ ok: false, code: 'irreversible' }, false)
        status = 'blocked'
      }
      if (selectProfileStatement.get(request.profile_id) === undefined) return finish({ ok: false, code: 'profile_missing' }, false)
      insertRecoveredStatement.run(
        /^[A-Za-z0-9_.:-]{1,64}$/.test(record.cancellationId) ? record.cancellationId : randomUUID(),
        record.requestId,
        record.profileId,
        record.source,
        status,
      )
      return finish({ ok: true, state: 'inserted' }, true)
    } catch (error) {
      rollbackQuietly()
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return { ok: false, code: 'conflicting_cancellation' }
      }
      throw error
    }
  }

  function runInWriterLock(fn: () => void): void {
    database.exec('BEGIN IMMEDIATE;')
    try {
      fn()
      database.exec('COMMIT;')
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  return {
    getByCancellationId,
    runInWriterLock,
    getForRequest: (requestId) => {
      const row = selectByRequestStatement.get(requestId) as Row | undefined
      return row === undefined ? null : toRow(row)
    },
    getPendingForProfile: (profileId) => {
      const row = selectPendingForProfileStatement.get(profileId) as Row | undefined
      return row === undefined ? null : toRow(row)
    },
    listUnfinalized: (limit = 100) => (selectUnfinalizedStatement.all(Math.max(1, Math.min(1000, limit))) as Row[]).map(toRow),
    recordInLedger,
    finalize,
    applyRecoveredCancellation,
    close: () => database.close(),
  }
}
