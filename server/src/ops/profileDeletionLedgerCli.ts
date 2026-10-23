// Самоизтриване, Етап 4C — команден ред за регистъра на окончателните
// изтривания. Компилира се в dist/ops/profileDeletionLedgerCli.js и се пуска
// с обикновен `node` на VPS (без tsx), от ops/pikabg-backup/scripts/.
//
//   snapshot  --ledger=<jsonl> --out-dir=<dir> [--ack=<json>]
//   confirm   --ledger=<jsonl> --snapshot=<file> --manifest=<file> --remote-path=<str> [--ack=<json>]
//   merge     --snapshot-dir=<dir> --out=<jsonl> [--local-ledger=<jsonl>]
//             [--accept-missing-newest] [--confirm-no-deletions-ever]
//   migrate   --db=<ВЪЗСТАНОВЕНА sqlite> — миграциите на текущата версия (живата база се отказва)
//   reconcile --db=<sqlite> --ledger=<jsonl> [--apply --confirm=... --uploads-root=<dir>]
//             [--verify-only] [--state-dir=<dir>] [--accept-stale-ledger]
//   admin-backfill --db=<sqlite> --ledger=<jsonl> [--apply --confirm=BACKFILL-ADMIN-DELETIONS]
//             — Етап 4F1: старите административни изтривания в регистъра (базата само се чете)
//
// Изход: един JSON ред за snapshot/confirm/merge (машинно четим от bash);
// exit 0 = успех, 1 = нужна намеса, 2 = грешка/отказ.

import { getProfileDeletionLedgerOffsiteAckPath } from '../db/profileDeletionLedger.js'
import {
  confirmLedgerSnapshotOffsite,
  createLedgerSnapshot,
  LedgerArchiveError,
  mergeLedgerSnapshots,
  writeMergedLedger,
} from './profileDeletionLedgerArchive.js'
import { runProfileDeletionLedgerReconcile } from './profileDeletionLedgerReconcile.js'
import { runProfileDeletionAdminBackfill } from './profileDeletionAdminBackfill.js'
import { migrateRestoredDatabase, RestoredDbMigrationError } from './profileDeletionRestoredDbMigrations.js'

function readArg(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`
  const found = argv.find((arg) => arg.startsWith(prefix))
  return found === undefined ? null : found.slice(prefix.length)
}

function required(argv: readonly string[], name: string): string {
  const value = readArg(argv, name)
  if (value === null || value.length === 0) throw new LedgerArchiveError('usage', `липсва --${name}=`)
  return value
}

export async function runProfileDeletionLedgerCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'snapshot': {
        const ledgerPath = required(rest, 'ledger')
        const result = createLedgerSnapshot({
          ledgerPath,
          outDir: required(rest, 'out-dir'),
          ackPath: readArg(rest, 'ack') ?? getProfileDeletionLedgerOffsiteAckPath(ledgerPath),
        })
        console.log(JSON.stringify(result.status === 'created'
          ? { ok: true, status: 'created', snapshot: result.snapshotPath, manifest: result.manifestPath, md5: result.manifest.md5, sha256: result.manifest.sha256, bytes: result.manifest.bytes, entryCount: result.manifest.entryCount, file: result.manifest.file }
          : { ok: true, status: 'unchanged', sha256: result.sha256, bytes: result.bytes }))
        return 0
      }
      case 'confirm': {
        const ledgerPath = required(rest, 'ledger')
        confirmLedgerSnapshotOffsite({
          ledgerPath,
          snapshotPath: required(rest, 'snapshot'),
          manifestPath: required(rest, 'manifest'),
          remotePath: required(rest, 'remote-path'),
          ackPath: readArg(rest, 'ack') ?? getProfileDeletionLedgerOffsiteAckPath(ledgerPath),
        })
        console.log(JSON.stringify({ ok: true, status: 'confirmed' }))
        return 0
      }
      case 'merge': {
        const { entries, report } = mergeLedgerSnapshots({
          snapshotDir: required(rest, 'snapshot-dir'),
          localLedgerPath: readArg(rest, 'local-ledger'),
          acceptMissingNewest: rest.includes('--accept-missing-newest'),
          confirmNoDeletionsEver: rest.includes('--confirm-no-deletions-ever'),
        })
        writeMergedLedger(required(rest, 'out'), entries)
        console.log(JSON.stringify({ ok: true, status: 'merged', ...report }))
        return 0
      }
      case 'migrate': {
        const result = await migrateRestoredDatabase(required(rest, 'db'))
        console.log(JSON.stringify({ ok: result.pendingAfter.length === 0, status: 'migrated', applied: result.applied, pendingAfter: result.pendingAfter }))
        return result.pendingAfter.length === 0 ? 0 : 2
      }
      case 'reconcile':
        return await runProfileDeletionLedgerReconcile(rest, {
          log: (line) => console.log(line),
          error: (line) => console.error(line),
        })
      case 'admin-backfill':
        return await runProfileDeletionAdminBackfill(rest, {
          log: (line) => console.log(line),
          error: (line) => console.error(line),
        })
      default:
        throw new LedgerArchiveError('usage', 'команда: snapshot | confirm | merge | migrate | reconcile | admin-backfill')
    }
  } catch (error) {
    const code = error instanceof LedgerArchiveError || error instanceof RestoredDbMigrationError ? error.code : 'unexpected'
    const message = error instanceof Error ? error.message : String(error)
    console.log(JSON.stringify({ ok: false, code, message }))
    console.error(`[profile-deletion-ledger] ERROR ${message}`)
    return 2
  }
}

// Пуска се само като самостоятелен скрипт (не при import от тестовете).
const invokedPath = process.argv[1]?.replace(/\\/g, '/') ?? ''
if (/\/profileDeletionLedgerCli\.(js|ts)$/.test(invokedPath)) {
  process.exitCode = await runProfileDeletionLedgerCli(process.argv.slice(2))
}
