// Етап 4J1 — общ помощник за тестовете, които отменят доброволна заявка.
//
// Отмяната вече е двуфазна: приемането (cancelWithToken / admin) поставя
// трайна защита, а окончателна е едва след запис в регистъра и offsite
// потвърждение. Тук се ползват РЕАЛНИТЕ production модули (store, finalizer,
// isProfileDeletionLedgerRecordConfirmedOffsite) с тестов регистър; offsite
// ack-ът се записва в точния формат на backup скрипта (байтове + SHA-256 на
// префикса) — проверките не се изключват.

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  createProfileDeletionCancellationFinalizer,
  type ProfileDeletionCancellationFinalizer,
  type ProfileDeletionCancellationOutcome,
} from '../../src/core/profileDeletionCancellationFinalizer.js'
import {
  createProfileDeletionCancellationStore,
  type ProfileDeletionCancellationStore,
} from '../../src/db/profileDeletionCancellationStore.js'
import {
  getProfileDeletionLedgerOffsiteAckPath,
  readProfileDeletionLedger,
  writeProfileDeletionLedgerOffsiteAck,
} from '../../src/db/profileDeletionLedger.js'

export type ProfileDeletionCancellationKit = {
  store: ProfileDeletionCancellationStore
  finalizer: ProfileDeletionCancellationFinalizer
  ledgerPath: string
  /** Контролирано offsite потвърждение на целия текущ регистър. */
  ackLedger: () => void
  /** Записва в регистъра, потвърждава offsite и финализира всички приети отмени. */
  confirmAll: () => ProfileDeletionCancellationOutcome[]
  close: () => void
}

export function writeTestLedgerAck(ledgerPath: string): void {
  const buffer = readFileSync(ledgerPath)
  const parsed = readProfileDeletionLedger(ledgerPath)
  writeProfileDeletionLedgerOffsiteAck(getProfileDeletionLedgerOffsiteAckPath(ledgerPath), {
    v: 1,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    lineCount: parsed.lineCount,
    entryCount: parsed.records.length,
    remotePath: 'test-offsite:/profile-deletions.jsonl',
    confirmedAt: new Date().toISOString(),
  })
}

export async function createProfileDeletionCancellationKit(input: { databaseFilePath: string; ledgerPath: string }): Promise<ProfileDeletionCancellationKit> {
  const store = await createProfileDeletionCancellationStore(input.databaseFilePath)
  const finalizer = createProfileDeletionCancellationFinalizer({ store, ledgerPath: input.ledgerPath, offsiteRequired: true })
  const ackLedger = () => writeTestLedgerAck(input.ledgerPath)
  return {
    store,
    finalizer,
    ledgerPath: input.ledgerPath,
    ackLedger,
    confirmAll: () => {
      finalizer.runOnce()
      if (store.listUnfinalized().length > 0) ackLedger()
      return finalizer.runOnce()
    },
    close: () => store.close(),
  }
}

type SqlDatabase = { prepare: (sql: string) => { run: (...params: unknown[]) => unknown; get: (...params: unknown[]) => unknown } }

/**
 * Пряк SQL (тестове на видимостта): отмяна, вече записана и потвърдена —
 * трайна отмяна (recovered_from_ledger = 1) + финализиране + статус
 * 'cancelled'. Тригерите на базата се спазват (без изключени защити).
 */
export function cancelRequestDirectlyForTest(database: SqlDatabase, requestId: string): void {
  const row = database.prepare('SELECT profile_id, status FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { profile_id: string; status: string }
  database.prepare(`
    INSERT INTO profile_deletion_cancellations (cancellation_id, request_id, profile_id, source, recovered_from_ledger, previous_status, ledger_recorded_at)
    VALUES (?, ?, ?, 'user', 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `).run(randomUUID(), requestId, row.profile_id, row.status)
  database.prepare(`UPDATE profile_deletion_cancellations SET finalized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE request_id = ?;`).run(requestId)
  database.prepare(`
    UPDATE profile_deletion_requests
    SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), next_attempt_at = NULL
    WHERE request_id = ?;
  `).run(requestId)
}
