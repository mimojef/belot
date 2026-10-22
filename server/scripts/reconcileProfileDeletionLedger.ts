/**
 * reconcileProfileDeletionLedger.ts
 *
 * Самоизтриване на профили — процедура СЛЕД restore на SQLite/uploads backup
 * и ПРЕДИ платформата да бъде пусната отново за потребители.
 *
 * Логиката е в src/ops/profileDeletionLedgerReconcile.ts (компилира се и в
 * dist — на VPS: `node dist/ops/profileDeletionLedgerCli.js reconcile ...`).
 * Този файл е само удобна входна точка за `npm run ops:reconcile-profile-deletion-ledger`.
 *
 * Употреба:
 *   npx tsx scripts/reconcileProfileDeletionLedger.ts \
 *     --db=<restored belot-v2.sqlite> --ledger=<обединен регистър от `merge`> \
 *     [--apply --confirm=REAPPLY-PROFILE-DELETIONS --uploads-root=<restored uploads dir>] \
 *     [--verify-only] [--state-dir=<dir>]
 */

import { runProfileDeletionLedgerReconcile } from '../src/ops/profileDeletionLedgerReconcile.js'

process.exitCode = await runProfileDeletionLedgerReconcile(process.argv.slice(2), {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
})
