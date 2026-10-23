// Етап 4F1 — backfill на историческите административни изтривания в
// регистъра на изтриванията (за restore защитата).
//
// Източник: admin_profile_deletions (одитът на стария административен
// механизъм) — log_id, deleted_profile_id (immutable UUID), deleted_account_id,
// deleted_by_profile_id, deleted_at. Всеки ред, чийто профил наистина липсва
// в базата, става запис admin_delete_historical (operationId = log_id).
//
// Безопасност:
//   * базата се отваря САМО за четене — нищо не се изтрива и не се променя;
//   * по подразбиране само преглед (dry-run); запис в регистъра само с
//     --apply --confirm=BACKFILL-ADMIN-DELETIONS;
//   * идемпотентно — операция, която вече е в регистъра, се пропуска;
//   * идентификация САМО по UUID — никога по име (username_snapshot не се
//     ползва); ред с невалиден идентификатор/дата или профил, който още
//     съществува, НЕ се добавя и се докладва (exit 1).
// Изход: само operationId/profileId и кодове.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ensureProfileDeletionLedgerRecord,
  isValidAdminProfileDeletionLedgerRecord,
  readProfileDeletionLedger,
  summarizeAdminLedgerOperations,
  type AdminProfileDeletionLedgerRecord,
} from '../db/profileDeletionLedger.js'
import { sqliteDateTimeToCanonicalIso } from '../core/adminProfileDeletionCoordinator.js'

export const ADMIN_BACKFILL_CONFIRMATION_PHRASE = 'BACKFILL-ADMIN-DELETIONS'

export type AdminBackfillIo = { log: (line: string) => void; error: (line: string) => void }

function readArg(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`
  const found = argv.find((arg) => arg.startsWith(prefix))
  return found === undefined ? null : found.slice(prefix.length)
}

export async function runProfileDeletionAdminBackfill(
  argv: readonly string[],
  io: AdminBackfillIo,
  now: () => Date = () => new Date(),
): Promise<number> {
  const dbArg = readArg(argv, 'db')
  const ledgerArg = readArg(argv, 'ledger')
  const apply = argv.includes('--apply')
  const fail = (code: string, message: string): number => {
    io.error(`[admin-backfill] ERROR ${code}: ${message}`)
    return 2
  }
  if (dbArg === null || ledgerArg === null) return fail('usage', 'нужни са --db=<път> и --ledger=<път>')
  if (apply && readArg(argv, 'confirm') !== ADMIN_BACKFILL_CONFIRMATION_PHRASE) {
    return fail('confirmation_required', `--apply изисква --confirm=${ADMIN_BACKFILL_CONFIRMATION_PHRASE}`)
  }
  const dbPath = resolve(dbArg)
  const ledgerPath = resolve(ledgerArg)
  if (!existsSync(dbPath)) return fail('db_missing', 'базата не съществува')
  const ledger = readProfileDeletionLedger(ledgerPath)
  if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) {
    return fail('ledger_corrupt', `invalidLines=${ledger.invalidLineCount} conflictingDuplicates=${ledger.conflictingDuplicateCount}`)
  }
  const known = summarizeAdminLedgerOperations(ledger.records)

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  type Row = { log_id: string; deleted_profile_id: string; deleted_account_id: string | null; deleted_by_profile_id: string | null; deleted_at: string }
  let rows: Row[]
  let profileExists: (profileId: string) => boolean
  try {
    rows = db.prepare(`
      SELECT log_id, deleted_profile_id, deleted_account_id, deleted_by_profile_id, deleted_at
      FROM admin_profile_deletions
      ORDER BY deleted_at, log_id;
    `).all() as Row[]
    const selectProfile = db.prepare('SELECT 1 FROM profiles WHERE profile_id = ? LIMIT 1;')
    const present = new Set(rows.filter((row) => selectProfile.get(row.deleted_profile_id) !== undefined).map((row) => row.log_id))
    profileExists = (logId) => present.has(logId)
  } finally {
    db.close()
  }

  const counts = { total: rows.length, alreadyInLedger: 0, eligible: 0, appended: 0, insufficient: 0, profilePresent: 0 }
  const eligible: AdminProfileDeletionLedgerRecord[] = []
  for (const row of rows) {
    if (known.has(row.log_id)) {
      counts.alreadyInLedger += 1
      continue
    }
    const deletedAt = typeof row.deleted_at === 'string' ? sqliteDateTimeToCanonicalIso(row.deleted_at) : null
    const record: AdminProfileDeletionLedgerRecord = {
      v: 1,
      kind: 'admin_delete_historical',
      operationId: row.log_id,
      profileId: row.deleted_profile_id,
      accountIdSnapshot: row.deleted_account_id,
      actorProfileId: row.deleted_by_profile_id,
      deletedAt: deletedAt ?? '',
      recordedAt: now().toISOString(),
    }
    if (deletedAt === null || !isValidAdminProfileDeletionLedgerRecord(record)) {
      counts.insufficient += 1
      io.log(`[admin-backfill] insufficient operationId=${String(row.log_id).slice(0, 128)} (невалиден идентификатор или дата — не се добавя)`)
      continue
    }
    if (profileExists(row.log_id)) {
      counts.profilePresent += 1
      io.log(`[admin-backfill] profile_present operationId=${row.log_id} profileId=${row.deleted_profile_id} (профилът съществува — не се добавя)`)
      continue
    }
    counts.eligible += 1
    eligible.push(record)
    io.log(`[admin-backfill] eligible operationId=${row.log_id} profileId=${row.deleted_profile_id}`)
  }

  if (apply) {
    for (const record of eligible) {
      if (ensureProfileDeletionLedgerRecord(ledgerPath, record) === 'appended') counts.appended += 1
    }
  }
  io.log(`[admin-backfill] mode=${apply ? 'APPLY' : 'dry-run'} summary ${JSON.stringify(counts)}`)
  if (!apply) io.log('[admin-backfill] Нищо не е записано (dry-run).')
  return counts.insufficient > 0 || counts.profilePresent > 0 ? 1 : 0
}
