// Етап 4J1A — отделен Node процес за тестовете за конкуренция и срив
// (checkProfileDeletionLedgerConcurrency.ts). Ползва САМО production
// функциите; сривовете се симулират с process.exit / убиване отвън, докато
// процесът държи заключването или е между фазите.
//
// Употреба: tsx scripts/fixtures/ledgerConcurrencyChild.ts <mode> <json-args>

import { existsSync, appendFileSync, writeFileSync } from 'node:fs'
import { createProfileDeletionExecutor } from '../../src/db/profileDeletionExecutor.js'
import { createProfileDeletionWorker } from '../../src/core/profileDeletionWorker.js'
import { createProfileDeletionCancellationStore } from '../../src/db/profileDeletionCancellationStore.js'
import {
  ensureProfileDeletionLedgerEntry,
  ensureProfileDeletionLedgerRecord,
  isProfileDeletionLedgerRequestConfirmedOffsite,
  readProfileDeletionLedger,
  withProfileDeletionLedgerLock,
  type ProfileDeletionRequestCancelledRecord,
} from '../../src/db/profileDeletionLedger.js'

const [mode, rawArgs] = process.argv.slice(2)
const args = JSON.parse(rawArgs ?? '{}') as Record<string, any>

const sleepCell = new Int32Array(new SharedArrayBuffer(4))
const sleepSync = (ms: number): void => { Atomics.wait(sleepCell, 0, 0, ms) }

function waitForGo(): void {
  if (typeof args.goFile !== 'string') return
  if (typeof args.readyFile === 'string') writeFileSync(args.readyFile, 'ready')
  while (!existsSync(args.goFile)) sleepSync(2) // синхронен старт на всички процеси
}

function intent(requestId: string): Parameters<typeof ensureProfileDeletionLedgerEntry>[1] {
  return {
    v: 1,
    requestId,
    profileId: `profile-${requestId}`,
    accountIdSnapshot: `account-${requestId}`,
    profileCreatedAtSnapshot: '2026-01-01 00:00:00',
    requestedAt: '2026-01-01T00:00:00.000Z',
    scheduledFor: '2026-01-31T00:00:00.000Z',
    recordedAt: new Date().toISOString(),
  }
}

async function main(): Promise<void> {
  switch (mode) {
    case 'append': {
      waitForGo()
      for (let i = 0; i < args.count; i += 1) ensureProfileDeletionLedgerEntry(args.ledgerPath, intent(`${args.tag}-${i}`))
      return
    }
    case 'ensure-same': {
      waitForGo()
      for (let i = 0; i < args.count; i += 1) ensureProfileDeletionLedgerEntry(args.ledgerPath, intent(args.requestId))
      return
    }
    case 'crash-mid-write': {
      // Срив по средата на запис: заключването е взето, половин ред е на диска.
      withProfileDeletionLedgerLock(args.ledgerPath, () => {
        appendFileSync(args.ledgerPath, '{"v":1,"requestId":"crashed-mid-wr')
        process.exit(9)
      })
      return
    }
    case 'hold-lock': {
      withProfileDeletionLedgerLock(args.ledgerPath, () => {
        writeFileSync(args.readyFile, 'held')
        const until = Date.now() + args.ms
        while (Date.now() < until) sleepSync(20) // държи заключването
      })
      return
    }
    case 'hold-lock-forever': {
      withProfileDeletionLedgerLock(args.ledgerPath, () => {
        writeFileSync(args.readyFile, 'held')
        for (;;) sleepSync(50) // до убиване отвън
      })
      return
    }
    case 'worker': {
      // Production конфигурацията на worker-а (index.ts) + точка на срив.
      const executor = await createProfileDeletionExecutor(args.databaseFilePath, {
        testHooks: args.crashAt === 'before_commit'
          ? { beforeDatabasePhaseCommit: () => process.exit(9) } // доказателството вече е в регистъра
          : {},
      })
      const worker = createProfileDeletionWorker({
        executor,
        workerId: `child-${process.pid}`,
        uploadRoots: args.uploadRoots,
        removeFile: async () => {
          if (args.crashAt === 'after_commit') process.exit(9) // COMMIT-ът е минал, файловете — не
          return { outcome: 'deleted' }
        },
        appendLedgerEntry: (entry) => { ensureProfileDeletionLedgerEntry(args.ledgerPath, entry) },
        isLedgerEntryConfirmedOffsite: (requestId) => isProfileDeletionLedgerRequestConfirmedOffsite(args.ledgerPath, requestId),
        findLedgerCancellation: (requestId) => {
          const ledger = readProfileDeletionLedger(args.ledgerPath)
          if (ledger.invalidLineCount > 0 || ledger.conflictingDuplicateCount > 0) throw new Error('profile_deletion_ledger_corrupt')
          return (ledger.records.find((r) => 'kind' in r && r.kind === 'request_cancelled' && r.requestId === requestId) as ProfileDeletionRequestCancelledRecord | undefined) ?? null
        },
        recordDbDeletion: (record) => { ensureProfileDeletionLedgerRecord(args.ledgerPath, record) },
        onlyRequestIds: args.requestIds,
      })
      const summary = await worker.runOnce()
      executor.close()
      process.stdout.write(`SUMMARY ${JSON.stringify(summary)}\n`)
      return
    }
    case 'finalizer-crash-after-append': {
      // Срив след append на "request_cancelled", преди COMMIT на маркировката.
      const store = await createProfileDeletionCancellationStore(args.databaseFilePath)
      store.recordInLedger(args.cancellationId, (row) => {
        ensureProfileDeletionLedgerRecord(args.ledgerPath, {
          v: 1, kind: 'request_cancelled', requestId: row.requestId, profileId: row.profileId, cancellationId: row.cancellationId, source: row.source, recordedAt: new Date().toISOString(),
        })
        process.exit(9)
      })
      return
    }
    default:
      throw new Error(`непознат режим ${mode}`)
  }
}

main().then(() => process.exit(0), (error) => {
  process.stderr.write(`CHILD_ERROR ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(3)
})
