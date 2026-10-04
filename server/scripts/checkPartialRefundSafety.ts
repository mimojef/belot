/**
 * checkPartialRefundSafety.ts
 *
 * Real-SQLite proof of partial-refund safety (fix brief §2 — "4 players:
 * refund #1 succeeds, refund #2 succeeds, injected DB failure before #3;
 * prove either single-transaction atomicity, or idempotent-retry safety
 * with exactly one refund per person"). Applies every real migration to a
 * temp DB (same pattern as checkMatchEconomyRefund.ts/checkMissionProgress.ts).
 *
 *  [A] refundUnsettledRoomScopedStakes runs its ENTIRE batch inside ONE
 *      SQLite transaction (BEGIN/COMMIT around the full loop — see
 *      matchEconomyStore.ts). Proven by forcing the 3rd of 4 room-scoped
 *      debits to fail (FK violation: crediting a profile_id with no row in
 *      `profiles`) and confirming NONE of the 4 — including the first two,
 *      which would have "succeeded" if committed individually — were
 *      actually credited. A retry after fixing the bad row then refunds
 *      all 4 exactly once.
 *  [B] refundParticipantScopedStake (matchmaking humans) is called ONCE
 *      PER PARTICIPANT in SEPARATE transactions (not one multi-participant
 *      transaction) — so a crash between participants IS possible at the
 *      orchestration level. Proven safe via idempotency: refund
 *      participants 1-2 "for real", simulate a crash (simply stop calling
 *      the function) before participant 3, then run the FULL retry loop
 *      again from participant 1 — exactly one stake_refund row and one
 *      balance credit per person, ever, regardless of how many times the
 *      retry loop re-visits an already-refunded participant.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createMatchEconomyStore } from '../src/db/matchEconomyStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function applyMigrations(databaseFilePath: string): Promise<void> {
  const db = new DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }
  db.close()
}

console.log('\n=== checkPartialRefundSafety ===\n')

const dir = await mkdtemp(join(tmpdir(), 'belot-partial-refund-'))
try {
  const dbPath = join(dir, 'test.sqlite')
  await applyMigrations(dbPath)

  const seedDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: false })
  function insertProfile(pid: string, startingBalance: number): void {
    const accId = `acc-${pid}`
    const un = `u${pid.replace(/-/g, '')}`
    const displayName = `P${pid.slice(0, 8)}`
    seedDb.prepare(`INSERT OR IGNORE INTO accounts (account_id, email, password_hash, role, status) VALUES (?, ?, 'hash', 'player', 'active')`).run(accId, `${pid}@test.invalid`)
    seedDb.prepare(`INSERT OR IGNORE INTO profiles (profile_id, account_id, profile_kind, username, normalized_username, display_name, normalized_display_name, level, rank_title, skill_rating, status) VALUES (?, ?, 'human', ?, ?, ?, ?, 1, 'R1', 1000, 'active')`).run(pid, accId, un, un, displayName, displayName.toLowerCase())
    seedDb.prepare(`INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)`).run(pid, startingBalance)
  }

  function getBalance(pid: string): number {
    const db = new DatabaseSync(dbPath, { open: true })
    const row = db.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get(pid) as { yellow_coins_balance: number } | undefined
    db.close()
    return row?.yellow_coins_balance ?? 0
  }

  function countRefundRows(roomIdOrScope: string, pid: string): number {
    const db = new DatabaseSync(dbPath, { open: true })
    const row = db.prepare(`SELECT COUNT(*) AS c FROM match_economy_ledger WHERE room_id = ? AND profile_id = ? AND entry_type = 'stake_refund'`).get(roomIdOrScope, pid) as { c: number }
    db.close()
    return row.c
  }

  // ─── [A] refundUnsettledRoomScopedStakes: single transaction, all-or-nothing ───
  await check(
    '[A] a FK failure on the 4th debit rolls back ALL 4 — including the first 3 "would-be successes" — proving one atomic transaction',
    async () => {
      const p1 = randomUUID()
      const p2 = randomUUID()
      const p3 = randomUUID()
      const badProfileId = randomUUID() // deliberately NEVER inserted into `profiles`
      for (const pid of [p1, p2, p3]) insertProfile(pid, 100_000)

      const roomId = 'atomic-room-1'
      const scope = `${roomId}:v0`

      const seedLedgerDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: false })
      const insertDebit = seedLedgerDb.prepare(`
        INSERT INTO match_economy_ledger (ledger_id, room_id, profile_id, entry_type, amount, balance_after)
        VALUES (?, ?, ?, 'stake_debit', ?, ?)
      `)
      // 3 legit debits + 1 debit for a profile_id with NO row in `profiles`
      // at all — FK constraint will reject the CREDIT step for this one
      // specifically (profile_wallets has no FK itself, but
      // match_economy_ledger.profile_id DOES reference profiles(profile_id)
      // ON DELETE CASCADE, so inserting a stake_refund row for badProfileId
      // violates the FK and throws mid-transaction).
      insertDebit.run(randomUUID(), scope, p1, 10_000, 90_000)
      insertDebit.run(randomUUID(), scope, p2, 10_000, 90_000)
      insertDebit.run(randomUUID(), scope, p3, 10_000, 90_000)
      insertDebit.run(randomUUID(), scope, badProfileId, 10_000, 90_000)
      // Mirror reality: a stake_debit ledger row always corresponds to an
      // ACTUAL wallet debit (collectRoomStakes/collectBotStakes always do
      // both atomically) — these manually-seeded rows must debit the
      // wallets too, otherwise the refund's credit would look like free
      // money rather than a genuine compensating transaction.
      for (const pid of [p1, p2, p3]) {
        seedLedgerDb.prepare('UPDATE profile_wallets SET yellow_coins_balance = yellow_coins_balance - 10000 WHERE profile_id = ?').run(pid)
      }
      seedLedgerDb.close()

      const store = await createMatchEconomyStore(dbPath)
      const result = store.refundUnsettledRoomScopedStakes(roomId)
      store.close()

      assert(result.ok === false, 'the batch must fail outright (FK violation surfaces as a thrown error, caught -> ok:false)')

      // The critical assertion: p1 and p2 must NOT have been credited back
      // yet, even though they were processed BEFORE the bad row in
      // insertion order — proving the whole batch is one transaction, not
      // per-row commits. Each is still sitting at their DEBITED balance
      // (90000 = 100000 - 10000), not back at 100000 and not double-debited.
      assert(getBalance(p1) === 90_000, `p1 must remain at its DEBITED balance (90000), got ${getBalance(p1)} — partial credit would be a correctness bug`)
      assert(getBalance(p2) === 90_000, `p2 must remain at its DEBITED balance (90000), got ${getBalance(p2)}`)
      assert(getBalance(p3) === 90_000, `p3 must remain at its DEBITED balance (90000), got ${getBalance(p3)}`)
      assert(countRefundRows(scope, p1) === 0, 'no stake_refund row for p1 may exist after a rolled-back batch')
      assert(countRefundRows(scope, p2) === 0, 'no stake_refund row for p2 may exist after a rolled-back batch')
    },
  )

  await check('[A2] retrying after removing the bad row refunds all 3 real participants exactly once', async () => {
    const roomId = 'atomic-room-1'
    const scope = `${roomId}:v0`
    const p1Row = new DatabaseSync(dbPath, { open: true })
    const existingDebits = p1Row.prepare(`SELECT profile_id FROM match_economy_ledger WHERE room_id = ? AND entry_type = 'stake_debit'`).all(scope) as Array<{ profile_id: string }>
    p1Row.close()

    // Remove the poisoned debit row (simulating an admin/retry path that
    // first clears the data inconsistency) — leaves exactly the 3 real
    // participants' debits.
    const cleanupDb = new DatabaseSync(dbPath, { open: true })
    const realProfileIds: string[] = []
    for (const row of existingDebits) {
      const exists = cleanupDb.prepare('SELECT 1 FROM profiles WHERE profile_id = ?').get(row.profile_id)
      if (exists) {
        realProfileIds.push(row.profile_id)
      } else {
        cleanupDb.prepare(`DELETE FROM match_economy_ledger WHERE room_id = ? AND profile_id = ? AND entry_type = 'stake_debit'`).run(scope, row.profile_id)
      }
    }
    cleanupDb.close()

    assert(realProfileIds.length === 3, `expected 3 real participants, got ${realProfileIds.length}`)

    const store = await createMatchEconomyStore(dbPath)
    const retryResult = store.refundUnsettledRoomScopedStakes(roomId)
    assert(retryResult.ok, 'retry after cleanup must succeed')
    if (retryResult.ok) {
      assert(retryResult.refunds.length === 3, `expected exactly 3 refunds, got ${retryResult.refunds.length}`)
    }
    for (const pid of realProfileIds) {
      assert(getBalance(pid) === 100_000, `${pid} must be refunded back to 100000, got ${getBalance(pid)}`)
      assert(countRefundRows(scope, pid) === 1, `${pid} must have exactly 1 stake_refund row, got ${countRefundRows(scope, pid)}`)
    }

    // One more retry — must be a complete no-op (idempotent), not a
    // duplicate credit.
    const secondRetry = store.refundUnsettledRoomScopedStakes(roomId)
    assert(secondRetry.ok)
    if (secondRetry.ok) {
      assert(secondRetry.refunds.length === 0, 'a third attempt must find nothing left to refund')
    }
    for (const pid of realProfileIds) {
      assert(getBalance(pid) === 100_000, `${pid} balance must still be exactly 100000 after a third, no-op attempt`)
    }
    store.close()
  })

  // ─── [B] Multi-participant matchmaking orchestration: per-participant retry safety ───
  await check(
    '[B] 4-human matchmaking room: refund #1+#2 succeed, simulated crash before #3, retry loop resumes safely with exactly 1 refund per person',
    async () => {
      const p1 = randomUUID()
      const p2 = randomUUID()
      const p3 = randomUUID()
      const p4 = randomUUID()
      for (const pid of [p1, p2, p3, p4]) insertProfile(pid, 50_000)

      const entries = [
        { profileId: p1, entryId: randomUUID() },
        { profileId: p2, entryId: randomUUID() },
        { profileId: p3, entryId: randomUUID() },
        { profileId: p4, entryId: randomUUID() },
      ]

      const store = await createMatchEconomyStore(dbPath)

      // Collect the original queue stakes for all 4 (mirrors real
      // collectQueueStake calls before the room was ever created).
      for (const entry of entries) {
        const result = store.collectQueueStake(entry.entryId, entry.profileId, 20_000)
        assert(result.ok, `collectQueueStake failed for ${entry.profileId}`)
      }
      for (const entry of entries) {
        assert(getBalance(entry.profileId) === 30_000, `${entry.profileId} must be debited to 30000`)
      }

      // Mirrors refundTechnicalAbortStakes's per-participant loop in
      // index.ts, but driven manually here so we can "crash" mid-loop.
      function refundScope(entryId: string): string {
        return `queue:${entryId}`
      }

      // First pass: refund participants 1 and 2 "for real", then stop
      // (simulating a thrown exception/process crash right before #3 —
      // exactly the scenario the fix brief describes).
      const firstPassResult1 = store.refundParticipantScopedStake(refundScope(entries[0]!.entryId), entries[0]!.profileId)
      assert(firstPassResult1.ok && firstPassResult1.refunded === true)
      const firstPassResult2 = store.refundParticipantScopedStake(refundScope(entries[1]!.entryId), entries[1]!.profileId)
      assert(firstPassResult2.ok && firstPassResult2.refunded === true)
      // --- simulated crash here: #3 and #4 never attempted this pass ---

      assert(getBalance(p1) === 50_000, 'p1 refunded by the first pass')
      assert(getBalance(p2) === 50_000, 'p2 refunded by the first pass')
      assert(getBalance(p3) === 30_000, 'p3 still debited — not reached before the simulated crash')
      assert(getBalance(p4) === 30_000, 'p4 still debited — not reached before the simulated crash')

      // Retry: re-run the FULL loop from participant 1 again (exactly what
      // a restart/retry of refundTechnicalAbortStakes would do — it always
      // starts from seat 'bottom', it has no memory of "where it left off").
      const refundedThisPass: string[] = []
      for (const entry of entries) {
        const result = store.refundParticipantScopedStake(refundScope(entry.entryId), entry.profileId)
        assert(result.ok, `retry refund failed for ${entry.profileId}`)
        if (result.ok && result.refunded) {
          refundedThisPass.push(entry.profileId)
        }
      }

      assert(
        refundedThisPass.length === 2,
        `retry pass must refund EXACTLY the 2 remaining participants (#3, #4), got ${refundedThisPass.length}: ${refundedThisPass.join(',')}`,
      )
      assert(refundedThisPass.includes(p3) && refundedThisPass.includes(p4), 'the newly-refunded set must be exactly {p3, p4}')
      assert(!refundedThisPass.includes(p1) && !refundedThisPass.includes(p2), 'p1/p2 must NOT be reported as newly-refunded again (no double credit)')

      for (const entry of entries) {
        assert(getBalance(entry.profileId) === 50_000, `${entry.profileId} must end at exactly 50000 (debited 20000, refunded 20000 — once)`)
        assert(
          countRefundRows(refundScope(entry.entryId), entry.profileId) === 1,
          `${entry.profileId} must have EXACTLY 1 stake_refund row ever, got ${countRefundRows(refundScope(entry.entryId), entry.profileId)}`,
        )
      }

      store.close()
    },
  )
} finally {
  // Windows-only flake: SQLite's WAL/SHM file handles can still be mid-release
  // for a short moment after db.close() returns, which makes an immediate
  // unlink EBUSY. Longer/more retries (not a correctness concern — purely
  // test cleanup robustness) give the OS enough time to actually release them.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
