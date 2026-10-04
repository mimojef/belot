/**
 * checkMatchEconomyRefund.ts
 *
 * Real-SQLite economy-invariant tests for the technical-abort refund
 * mechanism (root-cause audit follow-up: matchmaking stake-loss blocker).
 * Applies EVERY real migration to a temp DB (same established pattern as
 * checkMissionProgress.ts) and drives the REAL matchEconomyStore — no
 * server process, no mocks on the economy layer itself.
 *
 * Covers fix-brief §9 economy invariant tests:
 *  A. private staked room: stake collected -> refundUnsettledRoomScopedStakes
 *     -> exact refund -> balance restored -> second refund = no-op
 *  B. matchmaking staked room: queue stake collected -> stakeLedgerScope
 *     (`queue:${entryId}`) survives as the SOLE way to find it ->
 *     refundParticipantScopedStake -> exact debit refunded once
 *  E. a seat that already received a winner_payout is NEVER refunded (no
 *     double-paying a winner who also somehow has a pending-looking debit)
 *  F. no duplicate match_economy_ledger compensation — calling either
 *     refund function twice inserts exactly ONE stake_refund row (DB
 *     UNIQUE(room_id, profile_id, entry_type) constraint + the store's own
 *     pre-check both enforce this)
 *  [bonus] refundUnsettledRoomScopedStakes correctly refunds BOTH a human
 *     (private-room, room-scoped) AND a bot (room-scoped in any room type)
 *     debited under the exact same room, without needing the CURRENT
 *     room.game.stateVersion (proves the "scope embeds the stateVersion at
 *     DEBIT time, not NOW" fix actually works end-to-end)
 *  [bonus] refundParticipantScopedStake on a scope/profile with NO debit at
 *     all returns refunded:false without throwing or crediting anything
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createMatchEconomyStore } from '../src/db/matchEconomyStore.js'
import { getRoomStakeLedgerScope, isSqliteBusyError, classifyRefundThrowAsRetryKind } from '../src/db/matchEconomyStore.js'
import type { ServerRoom } from '../src/core/serverTypes.js'

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
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }
  db.close()
}

function makeRoom(id: string, stateVersion: number, seats: Partial<ServerRoom['seats']> = {}): ServerRoom {
  return {
    id,
    status: 'playing',
    game: { phase: 'playing', stateVersion },
    config: { isPrivateTableOrigin: true, stakeAmount: null },
    seats: {
      bottom: { seat: 'bottom', team: 'A', participant: null },
      right: { seat: 'right', team: 'B', participant: null },
      top: { seat: 'top', team: 'A', participant: null },
      left: { seat: 'left', team: 'B', participant: null },
      ...seats,
    },
  } as unknown as ServerRoom
}

function humanParticipant(profileId: string) {
  return {
    kind: 'human' as const,
    playerId: randomUUID(),
    connectionId: null,
    isConnected: false,
    joinedAt: 0,
    lastSeenAt: 0,
    reconnectToken: null,
    permanentlyLeftAt: null,
    identity: { profileId, accountId: null, username: null, displayName: profileId, avatarUrl: null, level: null, rankTitle: null, skillRating: null, gender: null },
    publicProfile: null,
  }
}

function botParticipant(botProfileId: string) {
  return {
    kind: 'bot' as const,
    playerId: randomUUID(),
    joinedAt: 0,
    botCode: 'B',
    difficulty: 'normal' as const,
    botProfileId,
    identity: { profileId: null, accountId: null, username: null, displayName: 'Bot', avatarUrl: null, level: null, rankTitle: null, skillRating: null, gender: null },
    publicProfile: null,
  }
}

console.log('\n=== checkMatchEconomyRefund ===\n')

const dir = await mkdtemp(join(tmpdir(), 'belot-match-economy-refund-'))
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

  const pHuman1 = randomUUID()
  const pHuman2 = randomUUID()
  const pBot1 = `temp-nonbot-${randomUUID()}` // real bot profile id (not temp-bot- prefixed, so getBotProfileIds includes it)
  const pMatchmakingHuman = randomUUID()
  const pWinner = randomUUID()
  const pBusy = randomUUID()

  for (const pid of [pHuman1, pHuman2, pBot1, pMatchmakingHuman, pWinner, pBusy]) {
    insertProfile(pid, 100_000)
  }
  seedDb.close()

  const store = await createMatchEconomyStore(dbPath)

  function getBalance(profileId: string): number {
    const db = new DatabaseSync(dbPath, { open: true })
    const row = db.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get(profileId) as { yellow_coins_balance: number } | undefined
    db.close()
    return row?.yellow_coins_balance ?? 0
  }

  function countLedgerRows(roomIdLike: string, profileId: string, entryType: string): number {
    const db = new DatabaseSync(dbPath, { open: true })
    const row = db.prepare('SELECT COUNT(*) AS c FROM match_economy_ledger WHERE room_id = ? AND profile_id = ? AND entry_type = ?').get(roomIdLike, profileId, entryType) as { c: number }
    db.close()
    return row.c
  }

  // ─── A. Private staked room: collect -> refund -> balance restored -> idempotent ───
  await check('[A1] private room: collectRoomStakes debits the human, collectBotStakes debits the bot', () => {
    const room = makeRoom('private-room-1', 0, {
      bottom: { seat: 'bottom', team: 'A', participant: humanParticipant(pHuman1) },
      top: { seat: 'top', team: 'A', participant: botParticipant(pBot1) },
    })
    const stakeResult = store.collectRoomStakes(room, 50_000)
    assert(stakeResult.ok, `collectRoomStakes failed: ${!stakeResult.ok ? stakeResult.message : ''}`)
    const botResult = store.collectBotStakes(room, 50_000)
    assert(botResult.ok, `collectBotStakes failed: ${!botResult.ok ? botResult.message : ''}`)
    assert(getBalance(pHuman1) === 50_000, `expected human balance 50000, got ${getBalance(pHuman1)}`)
    assert(getBalance(pBot1) === 50_000, `expected bot balance 50000, got ${getBalance(pBot1)}`)
  })

  await check(
    '[A2] technical-abort refund uses the room-scope recorded AT DEBIT TIME, not the CURRENT (much higher) stateVersion',
    () => {
      // Simulate the room having ticked forward a lot since the debit —
      // exactly the Hristina-incident shape (state_version=75 at
      // diagnosis time, vs whatever low version it was at room start).
      const roomMuchLater = makeRoom('private-room-1', 75)
      const result = store.refundUnsettledRoomScopedStakes(roomMuchLater.id)
      assert(result.ok, 'refundUnsettledRoomScopedStakes must succeed')
      if (result.ok) {
        assert(result.refunds.length === 2, `expected 2 refunds (human+bot), got ${result.refunds.length}`)
        const scopesUsed = new Set(result.refunds.map((r) => r.scope))
        assert(scopesUsed.has(getRoomStakeLedgerScope(makeRoom('private-room-1', 0))), 'refund must use the ORIGINAL v0 scope, not v75')
      }
    },
  )

  await check('[A3] balances are exactly restored after refund', () => {
    assert(getBalance(pHuman1) === 100_000, `expected human balance restored to 100000, got ${getBalance(pHuman1)}`)
    assert(getBalance(pBot1) === 100_000, `expected bot balance restored to 100000, got ${getBalance(pBot1)}`)
  })

  await check('[A4]/[F] second refund attempt is a no-op — no double credit, no duplicate ledger row', () => {
    const before = getBalance(pHuman1)
    const result = store.refundUnsettledRoomScopedStakes('private-room-1')
    assert(result.ok, 'second call must still succeed (not throw/error)')
    if (result.ok) {
      assert(result.refunds.length === 0, `second refund must find nothing left to refund, got ${result.refunds.length}`)
    }
    assert(getBalance(pHuman1) === before, 'balance must be unchanged by the second (no-op) refund attempt')
    const refundRowCount = countLedgerRows(`private-room-1:v0`, pHuman1, 'stake_refund')
    assert(refundRowCount === 1, `expected exactly 1 stake_refund row ever, got ${refundRowCount}`)
  })

  // ─── B. Matchmaking staked room: queue-scoped human debit, traced via stakeLedgerScope ───
  const matchmakingEntryId = randomUUID()
  const matchmakingScope = `queue:${matchmakingEntryId}`

  await check('[B1] collectQueueStake debits the human under the queue-scoped ledger entry', () => {
    const result = store.collectQueueStake(matchmakingEntryId, pMatchmakingHuman, 20_000)
    assert(result.ok, `collectQueueStake failed: ${!result.ok ? result.message : ''}`)
    assert(getBalance(pMatchmakingHuman) === 80_000, `expected 80000, got ${getBalance(pMatchmakingHuman)}`)
  })

  await check(
    '[B2] refundUnsettledRoomScopedStakes (room-scope LIKE pattern) does NOT find the matchmaking human — proves the two scope namespaces are genuinely disjoint',
    () => {
      const result = store.refundUnsettledRoomScopedStakes('some-matchmaking-room-id')
      assert(result.ok)
      if (result.ok) {
        assert(result.refunds.length === 0, 'room-scoped search must never accidentally find a queue-scoped debit')
      }
      assert(getBalance(pMatchmakingHuman) === 80_000, 'balance must be untouched by the room-scoped search')
    },
  )

  await check('[B3] refundParticipantScopedStake, using the persisted stakeLedgerScope, refunds the EXACT original debit once', () => {
    const result = store.refundParticipantScopedStake(matchmakingScope, pMatchmakingHuman)
    assert(result.ok, `refundParticipantScopedStake failed: ${!result.ok ? result.message : ''}`)
    if (result.ok) {
      assert(result.refunded === true, 'must report a real refund')
      assert(result.amount === 20_000, `expected refunded amount 20000, got ${result.amount}`)
    }
    assert(getBalance(pMatchmakingHuman) === 100_000, `expected balance restored to 100000, got ${getBalance(pMatchmakingHuman)}`)
  })

  await check('[B4]/[F] a second refundParticipantScopedStake call for the same scope+profile is idempotent', () => {
    const result = store.refundParticipantScopedStake(matchmakingScope, pMatchmakingHuman)
    assert(result.ok)
    if (result.ok) {
      assert(result.refunded === false, 'second call must report nothing new refunded')
    }
    assert(getBalance(pMatchmakingHuman) === 100_000, 'balance must not change on the idempotent second call')
    const refundRowCount = countLedgerRows(matchmakingScope, pMatchmakingHuman, 'stake_refund')
    assert(refundRowCount === 1, `expected exactly 1 stake_refund row ever for this scope, got ${refundRowCount}`)
  })

  await check('[bonus] refundParticipantScopedStake on a scope/profile with no debit at all is a safe no-op', () => {
    const result = store.refundParticipantScopedStake('queue:never-existed', pMatchmakingHuman)
    assert(result.ok)
    if (result.ok) {
      assert(result.refunded === false)
      assert(result.amount === null)
    }
  })

  // ─── E. A winner_payout blocks refund — never double-pay a settled winner ───
  await check('[E1] a stake_debit that already received a winner_payout is NEVER refunded', () => {
    const room = makeRoom('settled-room-1', 0, {
      bottom: { seat: 'bottom', team: 'A', participant: humanParticipant(pWinner) },
    })
    const stakeResult = store.collectRoomStakes(room, 10_000)
    assert(stakeResult.ok)
    assert(getBalance(pWinner) === 90_000)

    // Simulate a real settlement: payoutMatchWinners would insert a
    // winner_payout row under the SAME scope for this profile. We insert
    // it directly here (payoutMatchWinners itself requires a full
    // match-ended authoritative state, out of scope for this economy-only
    // test) to prove the refund query's own NOT EXISTS guard.
    const db = new DatabaseSync(dbPath, { open: true })
    db.prepare(`
      INSERT INTO match_economy_ledger (ledger_id, room_id, profile_id, entry_type, amount, balance_after)
      VALUES (?, ?, ?, 'winner_payout', ?, ?)
    `).run(randomUUID(), 'settled-room-1:v0', pWinner, 10_000, 100_000)
    db.close()

    const refundResult = store.refundUnsettledRoomScopedStakes('settled-room-1')
    assert(refundResult.ok)
    if (refundResult.ok) {
      assert(refundResult.refunds.length === 0, 'a debit that already has a winner_payout must never be refunded')
    }
  })

  // ─── G. Transient/permanent refund-failure classification ("refund retry
  // exhaustion" fix brief §2) — real SQLITE_BUSY, not a reimplementation ───
  await check('[G1] isSqliteBusyError classifies real node:sqlite error shapes correctly', () => {
    assert(isSqliteBusyError({ errcode: 5 }) === true, 'SQLITE_BUSY (5)')
    assert(isSqliteBusyError({ errcode: 6 }) === true, 'SQLITE_LOCKED (6)')
    assert(isSqliteBusyError({ errcode: 261 }) === true, 'extended code BUSY_SNAPSHOT (261 & 0xff === 5)')
    assert(isSqliteBusyError({ message: 'database is locked' }) === true, 'message fallback when errcode is absent')
    assert(isSqliteBusyError({ errcode: 19 }) === false, 'SQLITE_CONSTRAINT (19) is not busy/locked')
    assert(isSqliteBusyError(new Error('disk I/O error')) === false, 'unrelated error message')
    assert(isSqliteBusyError(null) === false)
  })

  await check('[G2] classifyRefundThrowAsRetryKind: busy/locked -> transient, anything else -> permanent', () => {
    assert(classifyRefundThrowAsRetryKind({ errcode: 5 }) === 'transient')
    assert(classifyRefundThrowAsRetryKind({ errcode: 6 }) === 'transient')
    assert(classifyRefundThrowAsRetryKind({ message: 'database is locked' }) === 'transient')
    assert(classifyRefundThrowAsRetryKind({ errcode: 19 }) === 'permanent', 'an unrelated thrown DB error must NOT be assumed safe to retry forever')
    assert(classifyRefundThrowAsRetryKind(new Error('disk I/O error')) === 'permanent')
  })

  await check('[G3] a REAL SQLITE_BUSY during refundParticipantScopedStake is classified transient, and succeeds once the lock clears', () => {
    const stakeResult = store.collectQueueStake('entry-busy-1', pBusy, 7_000)
    assert(stakeResult.ok)

    // A second raw connection grabs a write lock and holds it open —
    // node:sqlite's default busy_timeout is 0, so the store's OWN
    // connection must fail IMMEDIATELY with SQLITE_BUSY on its next write,
    // not hang or silently succeed.
    const blocker = new DatabaseSync(dbPath, { open: true })
    blocker.exec('BEGIN IMMEDIATE;')
    try {
      const result = store.refundParticipantScopedStake('queue:entry-busy-1', pBusy)
      assert(result.ok === false, 'refund must fail while a competing write lock is held')
      if (!result.ok) {
        assert(result.kind === 'transient', `a real SQLITE_BUSY must classify as transient, got kind=${result.kind}`)
      }
    } finally {
      blocker.exec('ROLLBACK;')
      blocker.close()
    }

    // Lock released — the exact same call must now succeed, refunding the
    // original debit exactly once.
    const retried = store.refundParticipantScopedStake('queue:entry-busy-1', pBusy)
    assert(retried.ok === true, 'retry after the lock clears must succeed')
    if (retried.ok) {
      assert(retried.refunded === true)
      assert(retried.amount === 7_000)
    }
    assert(getBalance(pBusy) === 100_000, 'balance fully restored after the real lock-contention retry succeeds')
  })

  store.close()
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}
