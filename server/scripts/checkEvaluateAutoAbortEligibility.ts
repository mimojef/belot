/**
 * checkEvaluateAutoAbortEligibility.ts
 *
 * Pure unit tests for server/src/core/evaluateAutoAbortEligibility.ts — the
 * economy-safety gate that decides whether automatic technical-abort
 * refund+teardown is even allowed to proceed for a room (root-cause audit
 * follow-up: matchmaking stake-loss blocker).
 *
 *  [1] unstaked room (stakeAmount null/0) -> always safe, regardless of type
 *  [2] private-table-origin staked room -> always safe (room-scoped stakes
 *      are traceable via DB query alone, no participant field needed) —
 *      including a LEGACY private room with no stakeLedgerScope anywhere
 *  [3] tournament-origin room that is UNEXPECTEDLY staked (stakeAmount>0,
 *      violating the buildRoom invariant this policy depends on) ->
 *      refused defensively, even if every human has a stakeLedgerScope —
 *      a tournament entry fee must never be auto-refunded through the
 *      generic path
 *  [4] tournament-origin room that is unstaked (the real, ONLY case that
 *      ever actually occurs — see buildRoom in tournamentCoordinator.ts)
 *      -> safe (§7 fix brief: technical removal is a generic, zero-economy
 *      no-op; the actual 0-0 rematch is tournamentCoordinator's own job)
 *  [5] matchmaking staked room, every human has stakeLedgerScope -> safe
 *  [6] matchmaking staked room, ONE human missing stakeLedgerScope
 *      (undefined, simulating a legacy pre-fix JSON round-trip) -> refused
 *  [7] matchmaking staked room, a human has stakeLedgerScope === null
 *      explicitly -> ALSO refused (null and undefined are deliberately
 *      treated identically — see the type's own doc comment)
 *  [8] matchmaking staked room with only BOT participants (no humans at
 *      all) -> safe (nothing to trace — bot stakes are always room-scoped)
 *  [9] seat with no participant (null) is skipped without throwing
 */

import assert from 'node:assert/strict'
import { evaluateAutoAbortEligibility } from '../src/core/evaluateAutoAbortEligibility.js'
import type { ServerRoom } from '../src/core/serverTypes.js'

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

function makeRoom(
  config: Partial<ServerRoom['config']>,
  seats: Partial<ServerRoom['seats']> = {},
): ServerRoom {
  return {
    id: 'room-x',
    status: 'playing',
    game: { phase: 'playing', stateVersion: 1 },
    config: { isPrivateTableOrigin: false, isTournamentMatchOrigin: false, stakeAmount: null, ...config },
    seats: {
      bottom: { seat: 'bottom', team: 'A', participant: null },
      right: { seat: 'right', team: 'B', participant: null },
      top: { seat: 'top', team: 'A', participant: null },
      left: { seat: 'left', team: 'B', participant: null },
      ...seats,
    },
  } as unknown as ServerRoom
}

function humanSeat(profileId: string, stakeLedgerScope?: string | null) {
  return {
    participant: {
      kind: 'human',
      identity: { profileId },
      publicProfile: null,
      ...(stakeLedgerScope !== undefined ? { stakeLedgerScope } : {}),
    },
  }
}

function botSeat(botProfileId: string) {
  return { participant: { kind: 'bot', botProfileId } }
}

console.log('\n=== evaluateAutoAbortEligibility ===')

check('[1] unstaked room is always safe', () => {
  const room = makeRoom({ stakeAmount: null })
  assert.deepEqual(evaluateAutoAbortEligibility(room), { safe: true })

  const roomZero = makeRoom({ stakeAmount: 0 })
  assert.deepEqual(evaluateAutoAbortEligibility(roomZero), { safe: true })
})

check('[2] private-table staked room is always safe, even legacy (no stakeLedgerScope anywhere)', () => {
  const room = makeRoom(
    { isPrivateTableOrigin: true, stakeAmount: 50000 },
    { bottom: { ...makeRoom({}).seats.bottom, ...humanSeat('p1') } },
  )
  const result = evaluateAutoAbortEligibility(room)
  assert.equal(result.safe, true)
})

check('[3] tournament-origin room unexpectedly staked (invariant violation) is refused defensively', () => {
  const room = makeRoom(
    { isTournamentMatchOrigin: true, tournamentMatchId: 'm1', stakeAmount: 20000 } as any,
    { bottom: { ...makeRoom({}).seats.bottom, ...humanSeat('p1', 'queue:e1') } },
  )
  const result = evaluateAutoAbortEligibility(room)
  assert.equal(result.safe, false)
  if (!result.safe) {
    assert.ok(result.reason.includes('tournament-origin-room-unexpectedly-staked'))
  }
})

check('[4] tournament-origin room that is unstaked (the real, only case) is safe', () => {
  const room = makeRoom({ isTournamentMatchOrigin: true, tournamentMatchId: 'm1', stakeAmount: 0 } as any)
  const result = evaluateAutoAbortEligibility(room)
  assert.deepEqual(result, { safe: true }, 'a real tournament match room (stakeAmount=0) is eligible for generic technical removal')
})

check('[5] matchmaking staked room, every human has stakeLedgerScope -> safe', () => {
  const room = makeRoom(
    { stakeAmount: 15000 },
    {
      bottom: { ...makeRoom({}).seats.bottom, ...humanSeat('p1', 'queue:e1') },
      top: { ...makeRoom({}).seats.top, ...humanSeat('p2', 'queue:e2') },
    },
  )
  assert.deepEqual(evaluateAutoAbortEligibility(room), { safe: true })
})

check('[6] matchmaking staked room, one human missing stakeLedgerScope -> refused', () => {
  const room = makeRoom(
    { stakeAmount: 15000 },
    {
      bottom: { ...makeRoom({}).seats.bottom, ...humanSeat('p1', 'queue:e1') },
      top: { ...makeRoom({}).seats.top, ...humanSeat('p2') }, // no scope at all (legacy)
    },
  )
  const result = evaluateAutoAbortEligibility(room)
  assert.equal(result.safe, false)
  if (!result.safe) {
    assert.ok(result.reason.includes('legacy-stake-provenance-missing'))
    assert.ok(result.reason.includes('seat=top'))
  }
})

check('[7] matchmaking staked room, a human has stakeLedgerScope === null explicitly -> refused', () => {
  const room = makeRoom(
    { stakeAmount: 15000 },
    { bottom: { ...makeRoom({}).seats.bottom, ...humanSeat('p1', null) } },
  )
  const result = evaluateAutoAbortEligibility(room)
  assert.equal(result.safe, false, 'null and undefined must be treated identically')
})

check('[8] matchmaking staked room with only bot participants -> safe', () => {
  const room = makeRoom(
    { stakeAmount: 15000 },
    {
      bottom: { ...makeRoom({}).seats.bottom, ...botSeat('bot-1') },
      top: { ...makeRoom({}).seats.top, ...botSeat('bot-2') },
    },
  )
  assert.deepEqual(evaluateAutoAbortEligibility(room), { safe: true })
})

check('[9] empty seats (participant: null) are skipped without throwing', () => {
  const room = makeRoom({ stakeAmount: 15000 })
  assert.doesNotThrow(() => evaluateAutoAbortEligibility(room))
  assert.deepEqual(evaluateAutoAbortEligibility(room), { safe: true })
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) {
  process.exit(1)
}
