/**
 * checkRoomTickRecoveryPipeline.ts
 *
 * Direct end-to-end WIRING test (root-cause audit, item 8/economy-safety
 * follow-up item 9 — "I will not accept only separate unit tests of the
 * two components"). Drives the REAL control-flow modules together —
 * createRoomTickHealthTracker (real, unmodified), evaluateAutoAbortEligibility
 * (real), abortQuarantinedRoom (real) — through
 * roomTickRecoveryPipeline.ts's handleRoomTickFailure(), the EXACT function
 * index.ts's tickRoomGameRuntimes() calls on every failed tick. Only the
 * truly-external side effects (DB writes, socket detachment, worker pool)
 * are fakes — and an injected, instantly advanceable clock replaces real
 * wall-clock waiting, so this proves the full chain (including the bounded
 * refund-retry backoff, which would otherwise need several real minutes
 * per scenario) without ever actually sleeping.
 *
 * Scenarios (updated for the "refund retry exhaustion" fix — fast/slow
 * retry state machine, transient/permanent classification, tournament
 * technical-rematch policy):
 *  [1] persistent deterministic compute failure (worker confirmed ALIVE
 *      throughout), refund succeeds on the FIRST attempt -> quarantine ->
 *      abort -> room gone -> connections detached -> session lookup
 *      returns null
 *  [2] dead worker -> successful reassignment -> room NEVER
 *      quarantined/aborted, refund NEVER even considered
 *  [3] refund fails TRANSIENTLY twice, then succeeds on the 3rd fast
 *      retry -> eventual teardown + unlock, exactly 3 abort attempts, no
 *      busy-loop
 *  [4] refund fails TRANSIENTLY through all 5 fast attempts AND many slow
 *      attempts (simulated 30+ minute outage) -> NEVER terminal, enters
 *      and stays in the slow phase, eventually succeeds once "the DB
 *      recovers" -> teardown + unlock. Proves fast-exhaustion alone is not
 *      a give-up, and a long outage still resolves automatically (brief
 *      §1/§3/A-D)
 *  [5] refund fails with a POSITIVELY PROVEN PERMANENT classification on
 *      the very FIRST attempt -> immediately terminal
 *      'quarantined_refund_permanently_refused', NEVER retried again no
 *      matter how many further ticks run, room NEVER torn down (brief §4/E)
 *  [6] ineligible LEGACY matchmaking room (staked human missing
 *      stakeLedgerScope) -> terminal 'quarantined_ineligible' on the FIRST
 *      attempt, refund NEVER attempted, NEVER retried (unchanged policy,
 *      brief §10)
 *  [7] tournament-origin room (stakeAmount=0 at this layer) -> now
 *      ELIGIBLE under the new §7 policy -> refund is a guaranteed trivial
 *      no-op -> generic teardown proceeds, proving zero economy mutation
 *      and reuse of the exact same generic abort path (brief §7/§8)
 *  [8] "restart" mid-fast-retry: a FRESH health tracker (simulating process
 *      restart — health is runtime-only) re-discovers the same broken room
 *      and keeps retrying; the fake refund dependency persists its own
 *      ledger-like idempotency ACROSS the simulated restart (as the real
 *      DB would) -> eventual success credits exactly once, never double
 *      (brief §5/F/G/H)
 */

import assert from 'node:assert/strict'
import {
  createRoomTickHealthTracker,
  ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS,
} from '../src/game/roomTickHealthTracker.js'
import {
  abortQuarantinedRoom,
  type AbortQuarantinedRoomDependencies,
  type AbortQuarantinedRoomResult,
} from '../src/core/abortQuarantinedRoom.js'
import { handleRoomTickFailure } from '../src/core/roomTickRecoveryPipeline.js'
import type { RoomTickRecoveryDependencies } from '../src/core/roomTickRecoveryPipeline.js'
import type { ServerRoom, ServerState } from '../src/core/serverTypes.js'

let passCount = 0
let failCount = 0

function pass(label: string): void {
  passCount += 1
  console.log(`  PASS ${label}`)
}
function fail(label: string, error: unknown): void {
  failCount += 1
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`  FAIL ${label}: ${msg}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (error: unknown) {
    fail(label, error)
  }
}

function makeRoom(id: string, profileId: string, overrides: Partial<ServerRoom['config']> = {}): ServerRoom {
  return {
    id,
    status: 'playing',
    game: { phase: 'playing', stateVersion: 1 },
    config: { isPrivateTableOrigin: false, isTournamentMatchOrigin: false, stakeAmount: null, ...overrides },
    seats: {
      bottom: {
        seat: 'bottom',
        team: 'A',
        participant: {
          kind: 'human',
          identity: { profileId },
          publicProfile: null,
          reconnectToken: 'token-1',
          permanentlyLeftAt: null,
        },
      },
      right: { seat: 'right', team: 'B', participant: null },
      top: { seat: 'top', team: 'A', participant: null },
      left: { seat: 'left', team: 'B', participant: null },
    },
  } as unknown as ServerRoom
}

function findProfileInGameSessionLike(fakeState: { rooms: Record<string, ServerRoom> }, profileId: string): boolean {
  for (const room of Object.values(fakeState.rooms)) {
    for (const slot of Object.values(room.seats)) {
      const participant = slot.participant as any
      if (participant?.kind === 'human' && participant.identity?.profileId === profileId) {
        return true
      }
    }
  }
  return false
}

// Builds a REAL abortQuarantinedRoom-backed `abortRoom` dependency for the
// pipeline, exactly mirroring index.ts's runAbortQuarantinedRoom wrapper —
// including returning the AbortAttemptOutcome shape the pipeline needs to
// drive its refund-retry state machine.
function makeRealAbortRoomDependency(
  getFakeState: () => ServerState,
  setFakeState: (next: ServerState) => void,
  refundStakes: AbortQuarantinedRoomDependencies['refundStakes'],
  effects: { removeCommittedServerRoomCalls: number; connectionsDetached: boolean },
) {
  const removeCommittedServerRoom = (roomId: string, state: ServerState): ServerState => {
    effects.removeCommittedServerRoomCalls += 1
    const nextRooms = { ...state.rooms }
    delete nextRooms[roomId]
    effects.connectionsDetached = true
    return { ...state, rooms: nextRooms }
  }

  const abortDeps: AbortQuarantinedRoomDependencies = {
    finalizeActiveTableGiftImagesForRoom: () => {},
    cleanupTempBotsFromRoom: () => {},
    markRoomSnapshotRemoved: () => {},
    removeRuntimeRoom: () => {},
    removeHealthTracking: () => {},
    isPrivateTableOriginRoom: () => false,
    deleteOrphanedPrivateMatchRow: () => false,
    forgetPrivateGameScoreDedup: () => {},
    broadcastPrivateGamesListToLobbyConnections: () => {},
    refundStakes,
    log: () => {},
  }

  return (roomId: string, reason: string): AbortQuarantinedRoomResult => {
    const result = abortQuarantinedRoom(getFakeState(), roomId, reason, removeCommittedServerRoom, abortDeps)
    setFakeState(result.nextServerState)
    return result
  }
}

console.log('\n=== roomTickRecoveryPipeline (direct wiring) ===\n')

check(
  '[1] persistent deterministic compute failure, refund succeeds first try -> quarantine -> abort -> room gone -> session lookup returns null',
  () => {
    const PROFILE_ID = 'profile-stuck-1'
    const ROOM_ID = 'room-stuck-1'
    let fakeState: ServerState = { startedAt: 0, connections: {}, rooms: { [ROOM_ID]: makeRoom(ROOM_ID, PROFILE_ID) } }
    const effects = { removeCommittedServerRoomCalls: 0, connectionsDetached: false }
    let removeHealthTrackingCalled = false

    const health = createRoomTickHealthTracker()
    const deps: RoomTickRecoveryDependencies = {
      health,
      getRoom: (roomId) => fakeState.rooms[roomId] ?? null,
      hasWorkerPool: true,
      getWorkerIdForRoom: () => 'worker-1',
      releaseRoomIfWorkerUnavailable: () => ({ released: false, previousWorkerId: 'worker-1' }),
      ensureRoom: () => ({ ok: true }),
      abortRoom: makeRealAbortRoomDependency(
        () => fakeState,
        (next) => {
          fakeState = next
        },
        () => ({ ok: true, refunds: [] }),
        effects,
      ),
      log: () => {},
    }

    let now = 1_700_000_000_000
    const TICK_STEP_MS = 250
    let done = false

    for (let i = 0; i < 2000; i += 1) {
      handleRoomTickFailure(ROOM_ID, 'compute_failed', now, deps)
      now += TICK_STEP_MS
      if (findProfileInGameSessionLike(fakeState, PROFILE_ID) === false) {
        done = true
        break
      }
    }

    assert.equal(done, true, 'must reach abort within a bounded number of ticks')
    assert.equal(effects.removeCommittedServerRoomCalls, 1)
    assert.equal(effects.connectionsDetached, true)
    assert.equal(fakeState.rooms[ROOM_ID], undefined)
  },
)

check('[2] dead worker -> successful reassignment -> room NEVER quarantined/aborted, refund NEVER considered', () => {
  const PROFILE_ID = 'profile-recovers-1'
  const ROOM_ID = 'room-recovers-1'
  const room = makeRoom(ROOM_ID, PROFILE_ID)
  const fakeState: ServerState = { startedAt: 0, connections: {}, rooms: { [ROOM_ID]: room } }

  let abortCalled = false
  let currentWorkerId = 'worker-dead'
  let releasedOnce = false

  const health = createRoomTickHealthTracker()
  const deps: RoomTickRecoveryDependencies = {
    health,
    getRoom: (roomId) => fakeState.rooms[roomId] ?? null,
    hasWorkerPool: true,
    getWorkerIdForRoom: () => currentWorkerId,
    releaseRoomIfWorkerUnavailable: () => {
      if (!releasedOnce) {
        releasedOnce = true
        return { released: true, previousWorkerId: 'worker-dead' }
      }
      return { released: false, previousWorkerId: null }
    },
    ensureRoom: () => {
      currentWorkerId = 'worker-healthy'
      return { ok: true }
    },
    abortRoom: () => {
      abortCalled = true
      return { aborted: false, refusalKind: null, refundFailureKind: null, refusalReason: null }
    },
    log: () => {},
  }

  let now = 1_700_000_000_000
  const TICK_STEP_MS = 250

  for (let i = 0; i < 2000; i += 1) {
    handleRoomTickFailure(ROOM_ID, 'compute_failed', now, deps)
    now += TICK_STEP_MS
    if (currentWorkerId === 'worker-healthy') {
      health.recordSuccess(ROOM_ID, now)
      break
    }
  }

  assert.equal(currentWorkerId, 'worker-healthy')
  assert.equal(abortCalled, false, 'a room that successfully recovers must NEVER reach abort/refund')
  assert.equal(health.isQuarantined(ROOM_ID), false)
  assert.equal(fakeState.rooms[ROOM_ID], room)
})

check(
  '[3] refund fails transiently twice, succeeds on the 3rd bounded retry -> eventual teardown, exactly 3 abort attempts',
  () => {
    const PROFILE_ID = 'profile-transient-1'
    const ROOM_ID = 'room-transient-1'
    let fakeState: ServerState = { startedAt: 0, connections: {}, rooms: { [ROOM_ID]: makeRoom(ROOM_ID, PROFILE_ID) } }
    const effects = { removeCommittedServerRoomCalls: 0, connectionsDetached: false }
    let refundCallCount = 0

    const health = createRoomTickHealthTracker()
    const deps: RoomTickRecoveryDependencies = {
      health,
      getRoom: (roomId) => fakeState.rooms[roomId] ?? null,
      hasWorkerPool: true,
      getWorkerIdForRoom: () => 'worker-1',
      releaseRoomIfWorkerUnavailable: () => ({ released: false, previousWorkerId: 'worker-1' }),
      ensureRoom: () => ({ ok: true }),
      abortRoom: makeRealAbortRoomDependency(
        () => fakeState,
        (next) => {
          fakeState = next
        },
        () => {
          refundCallCount += 1
          if (refundCallCount < 3) {
            return { ok: false, message: `simulated transient DB failure #${refundCallCount}`, kind: 'transient' }
          }
          return { ok: true, refunds: [] }
        },
        effects,
      ),
      log: () => {},
    }

    let now = 1_700_000_000_000
    const TICK_STEP_MS = 250
    let done = false

    for (let i = 0; i < 20_000; i += 1) {
      handleRoomTickFailure(ROOM_ID, 'compute_failed', now, deps)
      now += TICK_STEP_MS
      if (fakeState.rooms[ROOM_ID] === undefined) {
        done = true
        break
      }
    }

    assert.equal(done, true, 'must eventually tear down once refund succeeds')
    assert.equal(refundCallCount, 3, 'exactly 3 refund attempts — the first 2 failures, the 3rd succeeded')
    assert.equal(effects.removeCommittedServerRoomCalls, 1, 'teardown must run exactly once, only after success')
  },
)

check(
  '[4] refund fails TRANSIENTLY through fast exhaustion into a long (30+ min simulated) slow-retry outage, then eventually succeeds -> teardown',
  () => {
    const PROFILE_ID = 'profile-outage-1'
    const ROOM_ID = 'room-outage-1'
    let fakeState: ServerState = { startedAt: 0, connections: {}, rooms: { [ROOM_ID]: makeRoom(ROOM_ID, PROFILE_ID) } }
    const effects = { removeCommittedServerRoomCalls: 0, connectionsDetached: false }
    let refundCallCount = 0
    // "DB outage" lasting through all 5 fast attempts (cooldown 60s each,
    // so ~4 minutes in) PLUS several slow attempts (cooldown 5min each).
    // refundStakes receives no clock of its own (same signature as the
    // real matchEconomyStore functions — pure function of the room), so
    // the outage is modeled by attempt COUNT: succeeding only on the 11th
    // attempt guarantees the fast-phase cooldowns (5 x 60s) plus 6 slow
    // cooldowns (6 x 300s) have elapsed first — comfortably past 30
    // minutes of real/simulated wall-clock time by construction of the
    // cooldown schedule itself (verified via the `now` advancement below).
    const ATTEMPTS_BEFORE_RECOVERY = 10

    const health = createRoomTickHealthTracker()
    const deps: RoomTickRecoveryDependencies = {
      health,
      getRoom: (roomId) => fakeState.rooms[roomId] ?? null,
      hasWorkerPool: true,
      getWorkerIdForRoom: () => 'worker-1',
      releaseRoomIfWorkerUnavailable: () => ({ released: false, previousWorkerId: 'worker-1' }),
      ensureRoom: () => ({ ok: true }),
      abortRoom: makeRealAbortRoomDependency(
        () => fakeState,
        (next) => {
          fakeState = next
        },
        () => {
          refundCallCount += 1
          if (refundCallCount <= ATTEMPTS_BEFORE_RECOVERY) {
            return { ok: false, message: 'simulated DB outage still ongoing', kind: 'transient' }
          }
          return { ok: true, refunds: [] }
        },
        effects,
      ),
      log: () => {},
    }

    const startedAt = 1_700_000_000_000
    let now = startedAt
    const TICK_STEP_MS = 250
    let reachedSlowPhase = false
    let done = false
    let resolvedAt: number | null = null

    for (let i = 0; i < 2_000_000; i += 1) {
      handleRoomTickFailure(ROOM_ID, 'compute_failed', now, deps)
      now += TICK_STEP_MS
      const status = health.getSnapshot(ROOM_ID)?.status
      if (status === 'quarantined_awaiting_refund_slow_retry') reachedSlowPhase = true
      // Must NEVER become terminal while the failure is still transient.
      assert.notEqual(status, 'quarantined_refund_permanently_refused', 'a transient failure must never turn terminal on its own')
      if (fakeState.rooms[ROOM_ID] === undefined) {
        done = true
        resolvedAt = now
        break
      }
    }

    assert.equal(reachedSlowPhase, true, 'fast attempts must exhaust into the slow phase, not a terminal state')
    assert.equal(done, true, 'a long (30+ minute) transient outage must still eventually resolve automatically')
    assert.equal(effects.removeCommittedServerRoomCalls, 1, 'teardown runs exactly once, only after the outage ends')
    assert.ok(refundCallCount >= ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS, 'at least the fast attempts must have run before slow retries took over')
    assert.ok(
      (resolvedAt ?? 0) - startedAt >= 30 * 60_000,
      `simulated wall-clock time elapsed before resolution must exceed 30 minutes (got ${((resolvedAt ?? 0) - startedAt) / 60_000} min) — proves this is a genuinely long-outage scenario, not just a high attempt count`,
    )
  },
)

check(
  '[5] refund fails with a PROVEN PERMANENT classification on the very first attempt -> immediately terminal, never retried, room never torn down',
  () => {
    const PROFILE_ID = 'profile-permanent-1'
    const ROOM_ID = 'room-permanent-1'
    let fakeState: ServerState = { startedAt: 0, connections: {}, rooms: { [ROOM_ID]: makeRoom(ROOM_ID, PROFILE_ID) } }
    const effects = { removeCommittedServerRoomCalls: 0, connectionsDetached: false }
    let refundCallCount = 0

    const health = createRoomTickHealthTracker()
    const deps: RoomTickRecoveryDependencies = {
      health,
      getRoom: (roomId) => fakeState.rooms[roomId] ?? null,
      hasWorkerPool: true,
      getWorkerIdForRoom: () => 'worker-1',
      releaseRoomIfWorkerUnavailable: () => ({ released: false, previousWorkerId: 'worker-1' }),
      ensureRoom: () => ({ ok: true }),
      abortRoom: makeRealAbortRoomDependency(
        () => fakeState,
        (next) => {
          fakeState = next
        },
        () => {
          refundCallCount += 1
          return { ok: false, message: 'stake_debit amount unreadable — impossible ledger state', kind: 'permanent' }
        },
        effects,
      ),
      log: () => {},
    }

    let now = 1_700_000_000_000
    const TICK_STEP_MS = 250

    for (let i = 0; i < 50_000; i += 1) {
      handleRoomTickFailure(ROOM_ID, 'compute_failed', now, deps)
      now += TICK_STEP_MS
    }

    const snapshot = health.getSnapshot(ROOM_ID)
    assert.equal(snapshot?.status, 'quarantined_refund_permanently_refused')
    assert.equal(refundCallCount, 1, 'a proven permanent failure must be terminal on the FIRST attempt, never retried')
    assert.notEqual(fakeState.rooms[ROOM_ID], undefined, 'room must NEVER be torn down while refund is unconfirmed')
    assert.equal(effects.removeCommittedServerRoomCalls, 0, 'teardown must never run')

    // Run a lot more ticks and confirm the call count does NOT keep
    // growing — proves "terminal" really means never-retried-again, not
    // merely "retried less often".
    for (let i = 0; i < 50_000; i += 1) {
      handleRoomTickFailure(ROOM_ID, 'compute_failed', now, deps)
      now += TICK_STEP_MS
    }
    assert.equal(refundCallCount, 1, 'refund must never be attempted again once proven permanent')
  },
)

check(
  '[6] ineligible legacy matchmaking room (staked human missing stakeLedgerScope) -> terminal on the FIRST attempt, refund NEVER attempted, NEVER retried',
  () => {
    const PROFILE_ID = 'profile-legacy-1'
    const ROOM_ID = 'room-legacy-1'
    let fakeState: ServerState = {
      startedAt: 0,
      connections: {},
      rooms: {
        [ROOM_ID]: makeRoom(ROOM_ID, PROFILE_ID, {
          isPrivateTableOrigin: false,
          stakeAmount: 5000,
        } as any),
      },
    }
    const effects = { removeCommittedServerRoomCalls: 0, connectionsDetached: false }
    let refundCallCount = 0

    const health = createRoomTickHealthTracker()
    const deps: RoomTickRecoveryDependencies = {
      health,
      getRoom: (roomId) => fakeState.rooms[roomId] ?? null,
      hasWorkerPool: true,
      getWorkerIdForRoom: () => 'worker-1',
      releaseRoomIfWorkerUnavailable: () => ({ released: false, previousWorkerId: 'worker-1' }),
      ensureRoom: () => ({ ok: true }),
      abortRoom: makeRealAbortRoomDependency(
        () => fakeState,
        (next) => {
          fakeState = next
        },
        () => {
          refundCallCount += 1
          return { ok: true, refunds: [] }
        },
        effects,
      ),
      log: () => {},
    }

    let now = 1_700_000_000_000
    const TICK_STEP_MS = 250

    for (let i = 0; i < 50_000; i += 1) {
      handleRoomTickFailure(ROOM_ID, 'compute_failed', now, deps)
      now += TICK_STEP_MS
    }

    const snapshot = health.getSnapshot(ROOM_ID)
    assert.equal(snapshot?.status, 'quarantined_ineligible')
    assert.equal(refundCallCount, 0, 'refund must NEVER be attempted for an ineligible legacy room, not even once')
    assert.equal(effects.removeCommittedServerRoomCalls, 0)
    assert.notEqual(fakeState.rooms[ROOM_ID], undefined)
  },
)

check(
  '[7] tournament-origin room (stakeAmount=0) is now ELIGIBLE -> refund is a trivial no-op -> generic teardown proceeds (technical removal, zero economy mutation)',
  () => {
    const PROFILE_ID = 'profile-tournament-1'
    const ROOM_ID = 'room-tournament-1'
    let fakeState: ServerState = {
      startedAt: 0,
      connections: {},
      rooms: {
        [ROOM_ID]: makeRoom(ROOM_ID, PROFILE_ID, {
          isTournamentMatchOrigin: true,
          tournamentMatchId: 'match-1',
          stakeAmount: 0,
        } as any),
      },
    }
    const effects = { removeCommittedServerRoomCalls: 0, connectionsDetached: false }
    let refundCallCount = 0

    const health = createRoomTickHealthTracker()
    const deps: RoomTickRecoveryDependencies = {
      health,
      getRoom: (roomId) => fakeState.rooms[roomId] ?? null,
      hasWorkerPool: true,
      getWorkerIdForRoom: () => 'worker-1',
      releaseRoomIfWorkerUnavailable: () => ({ released: false, previousWorkerId: 'worker-1' }),
      ensureRoom: () => ({ ok: true }),
      abortRoom: makeRealAbortRoomDependency(
        () => fakeState,
        (next) => {
          fakeState = next
        },
        () => {
          refundCallCount += 1
          // Mirrors the real refundUnsettledRoomScopedStakes/
          // refundParticipantScopedStake behavior for a room that never had
          // ANY match_economy_ledger debit — a guaranteed no-op, never a
          // fabricated/guessed refund.
          return { ok: true, refunds: [] }
        },
        effects,
      ),
      log: () => {},
    }

    let now = 1_700_000_000_000
    const TICK_STEP_MS = 250
    let done = false

    for (let i = 0; i < 2000; i += 1) {
      handleRoomTickFailure(ROOM_ID, 'compute_failed', now, deps)
      now += TICK_STEP_MS
      if (fakeState.rooms[ROOM_ID] === undefined) {
        done = true
        break
      }
    }

    assert.equal(done, true, 'an unrecoverable tournament room must still be technically removed')
    assert.equal(refundCallCount, 1, 'refund IS called (generic path) but is a guaranteed no-op for a tournament room')
    assert.equal(effects.removeCommittedServerRoomCalls, 1)
    assert.equal(fakeState.rooms[ROOM_ID], undefined, 'the corrupted room is gone — tournamentCoordinator.ensureMatchRoom is solely responsible for the 0-0 rematch on its own next reconciliation tick, never called from here')
  },
)

check(
  '[8] "restart" mid-fast-retry: a fresh health tracker re-discovers the same broken room; the DB-like refund dependency is idempotent ACROSS the simulated restart -> exactly one credit, never duplicated',
  () => {
    const PROFILE_ID = 'profile-restart-1'
    const ROOM_ID = 'room-restart-1'
    let fakeState: ServerState = { startedAt: 0, connections: {}, rooms: { [ROOM_ID]: makeRoom(ROOM_ID, PROFILE_ID) } }
    const effects = { removeCommittedServerRoomCalls: 0, connectionsDetached: false }
    let refundCallCount = 0
    let creditedCount = 0
    // Simulates the REAL matchEconomyStore ledger-idempotency guarantee
    // (hasLedgerEntry check before crediting) — this state persists
    // "in the DB" across the simulated restart below, unlike health
    // tracker state, which is intentionally runtime-only.
    let alreadyCreditedInLedger = false
    let attemptsBeforeRecovery = 2

    const abortRoomDependency = makeRealAbortRoomDependency(
      () => fakeState,
      (next) => {
        fakeState = next
      },
      () => {
        refundCallCount += 1
        if (alreadyCreditedInLedger) {
          return { ok: true, refunds: [] }
        }
        if (attemptsBeforeRecovery > 0) {
          attemptsBeforeRecovery -= 1
          return { ok: false, message: 'simulated transient DB failure', kind: 'transient' }
        }
        alreadyCreditedInLedger = true
        creditedCount += 1
        return { ok: true, refunds: [{ profileId: PROFILE_ID, amount: 1000, scope: `${ROOM_ID}:v1` }] }
      },
      effects,
    )

    const firstHealthTracker = createRoomTickHealthTracker()
    let now = 1_700_000_000_000
    const TICK_STEP_MS = 250

    // Run ticks on the FIRST (pre-restart) health tracker until quarantine
    // is reached and at least one refund attempt has happened, but stop
    // BEFORE it succeeds (attemptsBeforeRecovery=2 guarantees the first 2
    // attempts fail transiently).
    for (let i = 0; i < 5000 && refundCallCount < 1; i += 1) {
      handleRoomTickFailure(
        ROOM_ID,
        'compute_failed',
        now,
        {
          health: firstHealthTracker,
          getRoom: (roomId) => fakeState.rooms[roomId] ?? null,
          hasWorkerPool: true,
          getWorkerIdForRoom: () => 'worker-1',
          releaseRoomIfWorkerUnavailable: () => ({ released: false, previousWorkerId: 'worker-1' }),
          ensureRoom: () => ({ ok: true }),
          abortRoom: abortRoomDependency,
          log: () => {},
        },
      )
      now += TICK_STEP_MS
    }
    assert.ok(refundCallCount >= 1, 'at least one refund attempt must have happened before the simulated restart')
    assert.equal(fakeState.rooms[ROOM_ID], fakeState.rooms[ROOM_ID])
    assert.notEqual(fakeState.rooms[ROOM_ID], undefined, 'room must still be present — refund has not succeeded yet')

    // "Restart" — a brand-new health tracker, exactly as index.ts would
    // get on process boot (runtime-only state, intentionally not
    // persisted). The room itself (fakeState) survives, as a real SQLite
    // active_room_snapshots row would.
    const secondHealthTracker = createRoomTickHealthTracker()
    let done = false
    for (let i = 0; i < 20_000; i += 1) {
      handleRoomTickFailure(
        ROOM_ID,
        'compute_failed',
        now,
        {
          health: secondHealthTracker,
          getRoom: (roomId) => fakeState.rooms[roomId] ?? null,
          hasWorkerPool: true,
          getWorkerIdForRoom: () => 'worker-1',
          releaseRoomIfWorkerUnavailable: () => ({ released: false, previousWorkerId: 'worker-1' }),
          ensureRoom: () => ({ ok: true }),
          abortRoom: abortRoomDependency,
          log: () => {},
        },
      )
      now += TICK_STEP_MS
      if (fakeState.rooms[ROOM_ID] === undefined) {
        done = true
        break
      }
    }

    assert.equal(done, true, 'must eventually tear down after the simulated restart, re-accumulating failures fresh')
    assert.equal(creditedCount, 1, 'the stake must be credited EXACTLY ONCE across the whole pre+post-restart sequence — never duplicated')
    assert.equal(effects.removeCommittedServerRoomCalls, 1, 'teardown (and therefore profile unlock) runs exactly once, only after the confirmed single credit')
  },
)

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) {
  process.exit(1)
}
