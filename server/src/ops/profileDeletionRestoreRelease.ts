// Самоизтриване, Етап 4J1B — освобождаване на restore hold след проверка от
// оператора (регистърът е възстановен без живото копие: изгубени отмени и
// решения не могат да бъдат открити автоматично).
//
//   release-restore --db=<sqlite> --ledger=<jsonl>
//       отчет: шлюзът на историята + заявките/операциите в риск (нищо не се пише);
//   release-restore --db=... --ledger=... --confirm=RELEASE-PROFILE-DELETION-RESTORE-HOLD
//       записва ledger_restore_released за всеки неосвободен маркер.
//
// Отказва (exit 1), докато историята не е проверена (reconcile/merge не са
// довършени) — освобождаването не може да заобиколи шлюза. Изход: само
// технически идентификатори.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createProfileDeletionHistoryGuard } from '../core/profileDeletionHistoryGuard.js'
import { ensureProfileDeletionLedgerRecord, readProfileDeletionLedger, summarizeRequestLedgerState } from '../db/profileDeletionLedger.js'

export const RELEASE_RESTORE_CONFIRMATION_PHRASE = 'RELEASE-PROFILE-DELETION-RESTORE-HOLD'

function readArg(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`
  const found = argv.find((arg) => arg.startsWith(prefix))
  return found === undefined ? null : found.slice(prefix.length)
}

export async function runProfileDeletionRestoreRelease(
  argv: readonly string[],
  io: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  const dbArg = readArg(argv, 'db')
  const ledgerArg = readArg(argv, 'ledger')
  if (dbArg === null || ledgerArg === null) {
    io.error('[release-restore] ERROR usage: нужни са --db=<път> и --ledger=<път>')
    return 2
  }
  const dbPath = resolve(dbArg)
  const ledgerPath = resolve(ledgerArg)
  if (!existsSync(dbPath)) {
    io.error('[release-restore] ERROR db_missing')
    return 2
  }
  // Само оценка — без обвързване/откриване (offsiteRequired: false).
  const guard = await createProfileDeletionHistoryGuard({ databaseFilePath: dbPath, ledgerPath, offsiteRequired: false })
  try {
    const assessment = guard.assess()
    io.log(`[release-restore] verified=${assessment.verified} restoreHold=${assessment.restoreHold} unreleased=${assessment.unreleasedRestoreIds.length}`)
    for (const reason of assessment.reasons.slice(0, 50)) io.log(`[release-restore] reason ${reason}`)
    if (!assessment.verified) {
      io.error('[release-restore] ERROR history_unverified: първо merge/migrate/reconcile (виж runbook-а) — нищо не е освободено')
      return 1
    }
    if (assessment.unreleasedRestoreIds.length === 0) {
      io.log('[release-restore] няма неосвободен restore маркер')
      return 0
    }
    // В риск: активни заявки без необратимо решение и без приета отмяна —
    // отмяна, приета след последното оцеляло копие, би била изгубена.
    const { DatabaseSync } = await import('node:sqlite')
    const readDb = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const states = summarizeRequestLedgerState(readProfileDeletionLedger(ledgerPath).records)
      const active = readDb.prepare(`
        SELECT r.request_id, r.profile_id, r.status, r.scheduled_for FROM profile_deletion_requests r
        WHERE r.status IN ('pending', 'executing', 'blocked', 'failed')
          AND NOT EXISTS (SELECT 1 FROM profile_deletion_cancellations c WHERE c.request_id = r.request_id)
        ORDER BY r.scheduled_for;
      `).all() as Array<{ request_id: string; profile_id: string; status: string; scheduled_for: string }>
      let atRisk = 0
      for (const request of active) {
        if (states.get(request.request_id)?.resolution === 'deleted') continue
        atRisk += 1
        io.log(`[release-restore] at_risk requestId=${request.request_id} profileId=${request.profile_id} status=${request.status} scheduledFor=${request.scheduled_for}`)
      }
      for (const pending of readDb.prepare(`SELECT ledger_operation_id, target_profile_id FROM pending_profile_moderation WHERE action = 'delete';`).all() as Array<{ ledger_operation_id: string | null; target_profile_id: string }>) {
        atRisk += 1
        io.log(`[release-restore] at_risk adminOperationId=${pending.ledger_operation_id ?? 'none'} profileId=${pending.target_profile_id}`)
      }
      for (const profileId of assessment.blockedProfileIds) io.log(`[release-restore] blocked profileId=${profileId}`)
      io.log(`[release-restore] at_risk=${atRisk}`)
    } finally {
      readDb.close()
    }
    if (readArg(argv, 'confirm') !== RELEASE_RESTORE_CONFIRMATION_PHRASE) {
      io.log(`[release-restore] report-only — за освобождаване: --confirm=${RELEASE_RESTORE_CONFIRMATION_PHRASE}`)
      return 1
    }
    for (const restoreId of assessment.unreleasedRestoreIds) {
      ensureProfileDeletionLedgerRecord(ledgerPath, { v: 1, kind: 'ledger_restore_released', restoreId, recordedAt: new Date().toISOString() })
      io.log(`[release-restore] released restoreId=${restoreId}`)
    }
    return 0
  } finally {
    guard.close()
  }
}
