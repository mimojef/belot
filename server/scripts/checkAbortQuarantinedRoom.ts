/**
 * checkAbortQuarantinedRoom.ts
 *
 * Deterministic, pure unit tests for server/src/core/abortQuarantinedRoom.ts
 * — the SECOND-layer zombie-room fix (root-cause audit: "session_in_game
 * lock"), economy-safety follow-up revision: safe, idempotent
 * technical-abort cleanup that NEVER tears a room down while its stake
 * refund is unconfirmed, and NEVER auto-aborts a room it cannot prove safe
 * (tournament-origin, or a legacy matchmaking room without persisted stake
 * provenance).
 *
 * All dependencies are injected fakes (no real server, no real SQLite
 * database, no real timers) — this proves the ORCHESTRATION/sequencing
 * logic in isolation, specifically the NEW ordering constraint: eligibility
 * check -> refund -> ONLY THEN teardown.
 *
 * Covers:
 *  [E1]  normal (unstaked, non-private, non-tournament) room: refund is
 *        called (finds nothing to refund), full teardown runs
 *  [E2]  room is removed from the returned nextServerState.rooms after a
 *        successful abort
 *  [E3]  private-table-origin room: refund + match-row deletion +
 *        dedup cleanup + broadcast all run; refunds are reflected in the
 *        result
 *  [E4]  private-table-origin room where the match row was already gone
 *        -> no broadcast
 *  [E5]  tournament-origin room (stakeAmount=0 at this layer): now
 *        ELIGIBLE (§7 fix brief) — refund is a trivial no-op, generic
 *        teardown proceeds; no tournament-specific dependency exists for
 *        this function to touch
 *  [E6]/[E7] idempotency: second call after the room is already gone is a
 *        safe, defensive no-op
 *  [E8]  side-effect helpers receive the ORIGINAL room object
 *  [E9]  the structured log mentions the roomId/reason and the refund
 *        summary on a real abort
 *  [E10] log is called exactly once per real abort
 *  [E11] removeHealthTracking/removeRuntimeRoom run uniformly for every
 *        SUCCESSFUL abort
 *  [E12] structural guard: the dependency surface has no DIRECT
 *        wallet/ledger write primitives of its own — the only economy
 *        surface is the single injected refundStakes callback (whole-
 *        function, not individual credit/debit operations), so the
 *        orchestration itself cannot fabricate ad-hoc economy writes
 *  [E13] a room failing eligibility (legacy matchmaking, unprovable stake
 *        provenance) is NEVER torn down: refundStakes is never called,
 *        removeCommittedServerRoom is never called, aborted=false,
 *        refusalReason is populated
 *  [E14] a room passing eligibility but whose refund FAILS is NEVER torn
 *        down either: teardown primitives are never called,
 *        aborted=false, refusalReason mentions the refund failure
 *  [E15] a legacy matchmaking room (staked, human participant missing
 *        stakeLedgerScope) is refused — refundStakes never called
 *  [E16] a SAFE matchmaking room (staked, every human has
 *        stakeLedgerScope) proceeds through refund + teardown normally
 */

import assert from 'node:assert/strict'
import {
  abortQuarantinedRoom,
  type AbortQuarantinedRoomDependencies,
  type RefundEntry,
} from '../src/core/abortQuarantinedRoom.js'
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

function makeRoom(id: string, overrides: Partial<ServerRoom['config']> = {}, seats: Partial<ServerRoom['seats']> = {}): ServerRoom {
  return {
    id,
    status: 'playing',
    game: { phase: 'playing', stateVersion: 42 },
    config: { isPrivateTableOrigin: false, isTournamentMatchOrigin: false, stakeAmount: null, ...overrides },
    seats: {
      bottom: { seat: 'bottom', team: 'A', participant: null },
      right: { seat: 'right', team: 'B', participant: null },
      top: { seat: 'top', team: 'A', participant: null },
      left: { seat: 'left', team: 'B', participant: null },
      ...seats,
    },
  } as unknown as ServerRoom
}

function makeServerState(rooms: ServerRoom[]): ServerState {
  const roomsRecord: ServerState['rooms'] = {}
  for (const room of rooms) {
    roomsRecord[room.id] = room
  }
  return { startedAt: 0, connections: {}, rooms: roomsRecord }
}

type CallLog = {
  removeCommittedServerRoomCalls: Array<{ roomId: string }>
  finalizeCalls: ServerRoom[]
  cleanupTempBotsCalls: ServerRoom[]
  markSnapshotRemovedCalls: string[]
  removeRuntimeRoomCalls: string[]
  removeHealthTrackingCalls: string[]
  deleteOrphanedPrivateMatchRowCalls: string[]
  forgetPrivateGameScoreDedupCalls: string[]
  broadcastCalls: number
  refundStakesCalls: ServerRoom[]
  logMessages: string[]
}

function makeHarness(options: {
  deleteOrphanedPrivateMatchRowReturns?: boolean
  isPrivateTableOriginRoom?: boolean
  refundResult?: { ok: true; refunds: RefundEntry[] } | { ok: false; message: string; kind: 'transient' | 'permanent' }
} = {}): { deps: AbortQuarantinedRoomDependencies; calls: CallLog; removeCommittedServerRoom: (roomId: string, state: ServerState) => ServerState } {
  const calls: CallLog = {
    removeCommittedServerRoomCalls: [],
    finalizeCalls: [],
    cleanupTempBotsCalls: [],
    markSnapshotRemovedCalls: [],
    removeRuntimeRoomCalls: [],
    removeHealthTrackingCalls: [],
    deleteOrphanedPrivateMatchRowCalls: [],
    forgetPrivateGameScoreDedupCalls: [],
    broadcastCalls: 0,
    refundStakesCalls: [],
    logMessages: [],
  }

  const removeCommittedServerRoom = (roomId: string, state: ServerState): ServerState => {
    calls.removeCommittedServerRoomCalls.push({ roomId })
    const nextRooms = { ...state.rooms }
    delete nextRooms[roomId]
    return { ...state, rooms: nextRooms }
  }

  const deps: AbortQuarantinedRoomDependencies = {
    finalizeActiveTableGiftImagesForRoom: (room) => {
      calls.finalizeCalls.push(room)
    },
    cleanupTempBotsFromRoom: (room) => {
      calls.cleanupTempBotsCalls.push(room)
    },
    markRoomSnapshotRemoved: (roomId) => {
      calls.markSnapshotRemovedCalls.push(roomId)
    },
    removeRuntimeRoom: (roomId) => {
      calls.removeRuntimeRoomCalls.push(roomId)
    },
    removeHealthTracking: (roomId) => {
      calls.removeHealthTrackingCalls.push(roomId)
    },
    isPrivateTableOriginRoom: () => options.isPrivateTableOriginRoom ?? false,
    deleteOrphanedPrivateMatchRow: (roomId) => {
      calls.deleteOrphanedPrivateMatchRowCalls.push(roomId)
      return options.deleteOrphanedPrivateMatchRowReturns ?? true
    },
    forgetPrivateGameScoreDedup: (roomId) => {
      calls.forgetPrivateGameScoreDedupCalls.push(roomId)
    },
    broadcastPrivateGamesListToLobbyConnections: () => {
      calls.broadcastCalls += 1
    },
    refundStakes: (room) => {
      calls.refundStakesCalls.push(room)
      return options.refundResult ?? { ok: true, refunds: [] }
    },
    log: (message) => {
      calls.logMessages.push(message)
    },
  }

  return { deps, calls, removeCommittedServerRoom }
}

console.log('\n=== abortQuarantinedRoom ===')

check('[E1] unstaked normal room: refund called (finds nothing), full teardown runs', () => {
  const room = makeRoom('room-normal')
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness()

  const result = abortQuarantinedRoom(state, 'room-normal', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.ok, true)
  assert.equal(result.aborted, true)
  assert.equal(result.alreadyClean, false)
  assert.equal(calls.refundStakesCalls.length, 1)
  assert.deepEqual(calls.removeCommittedServerRoomCalls, [{ roomId: 'room-normal' }])
  assert.equal(calls.finalizeCalls.length, 1)
  assert.equal(calls.cleanupTempBotsCalls.length, 1)
  assert.deepEqual(calls.markSnapshotRemovedCalls, ['room-normal'])
  assert.deepEqual(calls.removeRuntimeRoomCalls, ['room-normal'])
  assert.deepEqual(calls.removeHealthTrackingCalls, ['room-normal'])
  assert.equal(calls.deleteOrphanedPrivateMatchRowCalls.length, 0, 'non-private room must never touch private_room_matches')
})

check('[E2] room is removed from the returned nextServerState.rooms', () => {
  const room = makeRoom('room-removed')
  const state = makeServerState([room, makeRoom('room-other')])
  const { deps, removeCommittedServerRoom } = makeHarness()

  const result = abortQuarantinedRoom(state, 'room-removed', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.nextServerState.rooms['room-removed'], undefined)
  assert.notEqual(result.nextServerState.rooms['room-other'], undefined)
})

check('[E3] private-origin room: refund + match-row deletion + dedup + broadcast', () => {
  const room = makeRoom('room-private', { isPrivateTableOrigin: true, stakeAmount: 50000 })
  const state = makeServerState([room])
  const refunds: RefundEntry[] = [{ profileId: 'p1', amount: 50000, scope: 'room-private:v0' }]
  const { deps, calls, removeCommittedServerRoom } = makeHarness({
    isPrivateTableOriginRoom: true,
    deleteOrphanedPrivateMatchRowReturns: true,
    refundResult: { ok: true, refunds },
  })

  const result = abortQuarantinedRoom(state, 'room-private', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.aborted, true)
  assert.deepEqual(result.refunds, refunds)
  assert.equal(result.deletedPrivateMatchRow, true)
  assert.deepEqual(calls.deleteOrphanedPrivateMatchRowCalls, ['room-private'])
  assert.deepEqual(calls.forgetPrivateGameScoreDedupCalls, ['room-private'])
  assert.equal(calls.broadcastCalls, 1)
})

check('[E4] private-origin room where the match row was already gone -> no broadcast', () => {
  const room = makeRoom('room-private-2', { isPrivateTableOrigin: true })
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness({
    isPrivateTableOriginRoom: true,
    deleteOrphanedPrivateMatchRowReturns: false,
  })

  const result = abortQuarantinedRoom(state, 'room-private-2', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.deletedPrivateMatchRow, false)
  assert.equal(calls.broadcastCalls, 0)
})

check('[E5] tournament-origin room (stakeAmount=0 at this layer) is now ELIGIBLE: refund is a trivial no-op, generic teardown proceeds', () => {
  // §7 of the "technical rematch" fix brief — tournament rooms are no
  // longer refused at eligibility (see evaluateAutoAbortEligibility.ts).
  // They always have stakeAmount=0 at the room layer (tournament entry
  // fees live in the separate tournament_economy_ledger), so they fall
  // through to the same "unstaked room" path as E1 — refundStakes is
  // CALLED but finds nothing, and teardown proceeds normally. This test
  // proves abortQuarantinedRoom touches NOTHING tournament-specific: no
  // winner, no payout, no walkover, no bracket mutation is even possible
  // here (no such dependency exists on AbortQuarantinedRoomDependencies).
  const room = makeRoom('room-tournament', { isTournamentMatchOrigin: true, tournamentMatchId: 'match-1', stakeAmount: 0 } as any)
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness()

  const result = abortQuarantinedRoom(state, 'room-tournament', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.aborted, true, 'tournament rooms are eligible for the generic technical-abort teardown')
  assert.equal(result.isTournamentOrigin, true)
  assert.equal(result.refusalReason, null)
  assert.equal(result.refusalKind, null)
  assert.equal(calls.refundStakesCalls.length, 1, 'refund IS attempted (generic path) — it is just guaranteed to find nothing')
  assert.equal(calls.removeCommittedServerRoomCalls.length, 1, 'generic teardown runs — tournamentCoordinator.ensureMatchRoom is solely responsible for any rematch, not this function')
  assert.equal(result.nextServerState.rooms['room-tournament'], undefined)
})

check('[E6]/[E7] idempotency: second call after the room is already gone is a safe, defensive no-op', () => {
  const room = makeRoom('room-idem', { isPrivateTableOrigin: true })
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness({
    isPrivateTableOriginRoom: true,
    deleteOrphanedPrivateMatchRowReturns: true,
  })

  const first = abortQuarantinedRoom(state, 'room-idem', 'test-reason', removeCommittedServerRoom, deps)
  assert.equal(first.aborted, true)
  assert.equal(calls.removeCommittedServerRoomCalls.length, 1)
  assert.equal(calls.refundStakesCalls.length, 1)

  const second = abortQuarantinedRoom(first.nextServerState, 'room-idem', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(second.ok, true)
  assert.equal(second.alreadyClean, true)
  assert.equal(calls.removeCommittedServerRoomCalls.length, 1, 'removeCommittedServerRoom must never run twice')
  assert.equal(calls.refundStakesCalls.length, 1, 'refund must never run twice (no room object left on the second call)')
  assert.equal(calls.markSnapshotRemovedCalls.length, 2, 'defensive tail cleanup still re-runs (idempotent on its own)')
})

check('[E8] side-effect helpers receive the ORIGINAL room object', () => {
  const room = makeRoom('room-identity')
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness()

  abortQuarantinedRoom(state, 'room-identity', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(calls.finalizeCalls[0], room)
  assert.equal(calls.cleanupTempBotsCalls[0], room)
  assert.equal(calls.refundStakesCalls[0], room)
})

check('[E9] log mentions roomId, reason, and refund summary on a real abort', () => {
  const room = makeRoom('room-log')
  const state = makeServerState([room])
  const refunds: RefundEntry[] = [{ profileId: 'p1', amount: 1000, scope: 'room-log:v0' }]
  const { deps, calls, removeCommittedServerRoom } = makeHarness({ refundResult: { ok: true, refunds } })

  abortQuarantinedRoom(state, 'room-log', 'my-test-reason', removeCommittedServerRoom, deps)

  // Two log lines per real abort as of the refund-retry observability
  // follow-up: a dedicated [room-tick-refund-success] line (so refund
  // success is independently greppable per §10 of the fix brief) plus the
  // original [room-tick-abort] teardown summary line.
  assert.equal(calls.logMessages.length, 2)
  const refundSuccessMessage = calls.logMessages[0]!
  assert.ok(refundSuccessMessage.includes('room-log'))
  assert.ok(refundSuccessMessage.includes('refundedEntries=1'))
  assert.ok(refundSuccessMessage.includes('refundedTotal=1000'))

  const abortMessage = calls.logMessages[1]!
  assert.ok(abortMessage.includes('room-log'))
  assert.ok(abortMessage.includes('my-test-reason'))
  assert.ok(abortMessage.includes('refundedEntries=1'))
  assert.ok(abortMessage.includes('refundedTotal=1000'))
})

check('[E10] log is called exactly twice per real abort (refund-success + abort summary)', () => {
  const room = makeRoom('room-log-once', { isPrivateTableOrigin: true })
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness({
    isPrivateTableOriginRoom: true,
    deleteOrphanedPrivateMatchRowReturns: true,
  })

  abortQuarantinedRoom(state, 'room-log-once', 'test-reason', removeCommittedServerRoom, deps)
  assert.equal(calls.logMessages.length, 2)
})

check('[E11] profile-unlock-critical cleanup runs for every successful abort', () => {
  const room = makeRoom('room-cleanup-uniform')
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness()

  const result = abortQuarantinedRoom(state, 'room-cleanup-uniform', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.nextServerState.rooms['room-cleanup-uniform'], undefined)
  assert.deepEqual(calls.removeRuntimeRoomCalls, ['room-cleanup-uniform'])
  assert.deepEqual(calls.removeHealthTrackingCalls, ['room-cleanup-uniform'])
})

check('[E12] structural guard: no DIRECT wallet/ledger primitives — only the single refundStakes callback', () => {
  const { deps } = makeHarness()
  const keys = Object.keys(deps)
  assert.ok(keys.includes('refundStakes'), 'the one sanctioned economy surface must exist')
  const forbiddenSubstrings = ['creditwallet', 'debitwallet', 'insertledger', 'payout', 'penalty', 'progress', 'settle']
  for (const key of keys) {
    if (key === 'refundStakes') continue
    const lowerKey = key.toLowerCase()
    for (const forbidden of forbiddenSubstrings) {
      assert.ok(
        !lowerKey.includes(forbidden),
        `dependency key "${key}" looks like a DIRECT economy primitive (matches "${forbidden}") — all economy writes must go through the single refundStakes callback`,
      )
    }
  }
})

check('[E13] a room failing eligibility (legacy matchmaking, unprovable stake provenance) is NEVER torn down', () => {
  const room = makeRoom(
    'room-refused',
    { stakeAmount: 15000 },
    {
      bottom: {
        seat: 'bottom',
        team: 'A',
        participant: {
          kind: 'human',
          identity: { profileId: 'p1' },
          publicProfile: null,
          // stakeLedgerScope deliberately absent — pre-fix legacy room.
        } as any,
      },
    },
  )
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness()

  const result = abortQuarantinedRoom(state, 'room-refused', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.aborted, false)
  assert.equal(result.refusalKind, 'ineligible')
  assert.notEqual(result.refusalReason, null)
  assert.equal(calls.refundStakesCalls.length, 0)
  assert.equal(calls.finalizeCalls.length, 0)
  assert.equal(calls.markSnapshotRemovedCalls.length, 0)
})

check('[E14] eligible room whose refund FAILS is NEVER torn down', () => {
  const room = makeRoom('room-refund-fails')
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness({
    refundResult: { ok: false, message: 'simulated ledger write failure', kind: 'transient' },
  })

  const result = abortQuarantinedRoom(state, 'room-refund-fails', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.aborted, false)
  assert.ok(result.refusalReason?.includes('refund-failed'))
  assert.equal(result.refusalKind, 'refund-failed', 'must be structurally classified as refund-failed, not ineligible')
  assert.equal(result.refundFailureKind, 'transient', 'the classification must flow through unchanged from the refund dependency')
  assert.equal(calls.refundStakesCalls.length, 1, 'refund WAS attempted')
  assert.equal(calls.removeCommittedServerRoomCalls.length, 0, 'but teardown must never run after a failed refund')
  assert.equal(calls.markSnapshotRemovedCalls.length, 0)
  assert.equal(result.nextServerState.rooms['room-refund-fails'], room)
})

check('[E15] legacy matchmaking room (staked human without stakeLedgerScope) is refused', () => {
  const room = makeRoom(
    'room-legacy',
    { stakeAmount: 15000 },
    {
      bottom: {
        seat: 'bottom',
        team: 'A',
        participant: {
          kind: 'human',
          identity: { profileId: 'p1' },
          publicProfile: null,
          // stakeLedgerScope deliberately absent — simulates a pre-fix
          // persisted room, round-tripped through JSON.
        } as any,
      },
    },
  )
  const state = makeServerState([room])
  const { deps, calls, removeCommittedServerRoom } = makeHarness()

  const result = abortQuarantinedRoom(state, 'room-legacy', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.aborted, false)
  assert.ok(result.refusalReason?.includes('legacy-stake-provenance-missing'))
  assert.equal(calls.refundStakesCalls.length, 0)
})

check('[E16] safe matchmaking room (every human has stakeLedgerScope) proceeds normally', () => {
  const room = makeRoom(
    'room-matchmaking-safe',
    { stakeAmount: 15000 },
    {
      bottom: {
        seat: 'bottom',
        team: 'A',
        participant: {
          kind: 'human',
          identity: { profileId: 'p1' },
          publicProfile: null,
          stakeLedgerScope: 'queue:entry-1',
        } as any,
      },
    },
  )
  const state = makeServerState([room])
  const refunds: RefundEntry[] = [{ profileId: 'p1', amount: 15000, scope: 'queue:entry-1' }]
  const { deps, calls, removeCommittedServerRoom } = makeHarness({ refundResult: { ok: true, refunds } })

  const result = abortQuarantinedRoom(state, 'room-matchmaking-safe', 'test-reason', removeCommittedServerRoom, deps)

  assert.equal(result.aborted, true)
  assert.deepEqual(result.refunds, refunds)
  assert.equal(calls.removeCommittedServerRoomCalls.length, 1)
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) {
  process.exit(1)
}
