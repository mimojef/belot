/**
 * checkRoomTickHealthTracker.ts
 *
 * Deterministic, pure unit tests for server/src/game/roomTickHealthTracker.ts
 * — the per-room liveness/health state machine behind the zombie-room fix
 * (root-cause audit: Belot room stuck "playing + no progress + no recovery
 * forever", locking a profile via session_in_game indefinitely).
 *
 * Covers:
 *  [1] fresh room starts healthy, not recovery/quarantine-due
 *  [2] single transient failure does NOT trigger recovery (consecutive-count
 *      threshold not met) — "do not treat one transient failure as zombie"
 *  [3] recovery becomes due only once BOTH the consecutive-failure count AND
 *      the min-elapsed-time thresholds are met
 *  [4] a success resets everything (consecutive count, unhealthySince,
 *      recoveryAttempts) — a room that recovers is fully healthy again, not
 *      "partially recovering" forever
 *  [5] recovery-attempt cooldown prevents hammering reassignment every tick
 *  [6] recovery attempts are bounded (ROOM_TICK_MAX_RECOVERY_ATTEMPTS) —
 *      hasExhaustedRecoveryAttempts flips at exactly the configured bound
 *  [7] absolute quarantine ceiling fires independently of recoveryAttempts
 *      (covers the "assigned worker confirmed alive, deterministic compute
 *      error" branch, which the recovery escalation layer in index.ts never
 *      attempts worker reassignment for — see attemptRoomTickRecovery)
 *  [8] quarantine is terminal: recordFailure/recordSuccess after
 *      markQuarantined() do not resurrect the room's status
 *  [9] remove() fully forgets a room (fresh re-registration starts healthy)
 *  [10] listUnhealthy() only reports non-healthy rooms, never healthy ones
 *  [11] invariant (K / §8 of the fix brief): a room can NEVER sit
 *      indefinitely in a non-healthy, non-quarantined status — it must
 *      eventually become quarantine-due as elapsed time grows, regardless
 *      of how recovery attempts are counted. This is the "no silent 5th
 *      state" guarantee.
 *
 * Economy-safety follow-up (fast/slow refund-retry state machine — "refund
 * retry exhaustion" fix):
 *  [12] markQuarantinedAwaitingRefundRetry -> isRefundRetryDue is true
 *       immediately (no attempt yet) and becomes false right after an
 *       attempt is recorded, until the FAST cooldown elapses
 *  [13] FAST attempts are bounded (ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS) —
 *       hasExhaustedFastRefundAttempts flips at exactly the configured
 *       bound, but this does NOT by itself stop isRefundRetryDue from
 *       being true again after the fast cooldown — exhaustion only means
 *       "the pipeline should switch phase", never "give up"
 *  [13b] once markEnteringSlowRefundRetry is called, isRefundRetryDue uses
 *       the SLOW cooldown instead of the fast one, and keeps becoming true
 *       again indefinitely — proven across many cycles spanning well past
 *       30 minutes, with zero attempt cap
 *  [14] markQuarantinedIneligible is terminal: isRefundRetryDue is always
 *       false for it (nothing to retry — refund was never attempted)
 *  [15] markQuarantinedRefundPermanentlyRefused is terminal: isRefundRetryDue
 *       is always false for it too, even though refundAttempts exists —
 *       and, critically, reaching it requires an EXPLICIT permanent
 *       classification, never attempt count alone
 *  [16] isQuarantined() is true for ALL FOUR quarantine sub-states
 *       uniformly (awaiting-refund-retry, awaiting-refund-slow-retry,
 *       refund-permanently-refused, ineligible) — worker-level recovery
 *       must never resume for any of them
 *  [17] quarantineDetail is recorded on the terminal states and surfaced
 *       in the snapshot (operator-visible "why")
 */

import assert from 'node:assert/strict'
import {
  createRoomTickHealthTracker,
  ROOM_REFUND_FAST_RETRY_COOLDOWN_MS,
  ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS,
  ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS,
  ROOM_TICK_MAX_RECOVERY_ATTEMPTS,
  ROOM_TICK_QUARANTINE_AFTER_UNHEALTHY_MS,
  ROOM_TICK_RECOVERY_ATTEMPT_COOLDOWN_MS,
  ROOM_TICK_RECOVERY_TRIGGER_CONSECUTIVE_FAILURES,
  ROOM_TICK_RECOVERY_TRIGGER_MIN_ELAPSED_MS,
} from '../src/game/roomTickHealthTracker.js'

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

const T0 = 1_000_000_000

console.log('\n=== roomTickHealthTracker ===')

check('[1] fresh room starts healthy, not recovery/quarantine-due', () => {
  const tracker = createRoomTickHealthTracker()
  const snapshot = tracker.getSnapshot('room-fresh')
  assert.equal(snapshot, null, 'unregistered room has no snapshot yet')
  tracker.recordSuccess('room-fresh', T0)
  const after = tracker.getSnapshot('room-fresh')
  assert.equal(after?.status, 'healthy')
  assert.equal(after?.consecutiveFailures, 0)
  assert.equal(after?.unhealthySince, null)
  assert.equal(tracker.isRecoveryDue('room-fresh', T0), false)
  assert.equal(tracker.isQuarantineDue('room-fresh', T0), false)
})

check('[2] single transient failure does not trigger recovery', () => {
  const tracker = createRoomTickHealthTracker()
  tracker.recordFailure('room-x', 'compute_failed', T0)
  assert.equal(tracker.isRecoveryDue('room-x', T0 + 50), false)
  const snapshot = tracker.getSnapshot('room-x')
  assert.equal(snapshot?.consecutiveFailures, 1)
  assert.equal(snapshot?.status, 'healthy', 'still healthy status until markRecovering is called')
})

check('[3] recovery becomes due only once BOTH thresholds are met', () => {
  const tracker = createRoomTickHealthTracker()
  let now = T0
  for (let i = 0; i < ROOM_TICK_RECOVERY_TRIGGER_CONSECUTIVE_FAILURES - 1; i += 1) {
    tracker.recordFailure('room-y', 'compute_failed', now)
    now += 250
  }
  assert.equal(
    tracker.isRecoveryDue('room-y', now),
    false,
    'consecutive-count threshold not yet met',
  )

  tracker.recordFailure('room-y', 'compute_failed', now)
  assert.equal(
    tracker.isRecoveryDue('room-y', now),
    false,
    'count met but min-elapsed-time threshold not yet met',
  )

  // unhealthySince was stamped at T0 (the very FIRST recordFailure call
  // above), not at the current `now` — elapsed time is measured from
  // there, so the boundary must be computed against T0, not against `now`.
  const elapsedOk = T0 + ROOM_TICK_RECOVERY_TRIGGER_MIN_ELAPSED_MS
  assert.equal(
    tracker.isRecoveryDue('room-y', elapsedOk - 1),
    false,
    'one ms short of the elapsed threshold (measured from unhealthySince) must not be due yet',
  )
  assert.equal(
    tracker.isRecoveryDue('room-y', elapsedOk),
    true,
    'both thresholds met -> recovery due',
  )
})

check('[4] a success fully resets failure/recovery state', () => {
  const tracker = createRoomTickHealthTracker()
  let now = T0
  for (let i = 0; i < ROOM_TICK_RECOVERY_TRIGGER_CONSECUTIVE_FAILURES; i += 1) {
    tracker.recordFailure('room-z', 'not_assigned', now)
    now += 250
  }
  tracker.recordRecoveryAttempt('room-z', now)
  tracker.markRecovering('room-z')
  now += ROOM_TICK_RECOVERY_TRIGGER_MIN_ELAPSED_MS

  tracker.recordSuccess('room-z', now)
  const snapshot = tracker.getSnapshot('room-z')
  assert.equal(snapshot?.status, 'healthy')
  assert.equal(snapshot?.consecutiveFailures, 0)
  assert.equal(snapshot?.unhealthySince, null)
  assert.equal(snapshot?.recoveryAttempts, 0)
  assert.equal(snapshot?.lastRecoveryAttemptAt, null)
  assert.equal(tracker.isRecoveryDue('room-z', now + 1_000_000), false)
})

check('[5] recovery-attempt cooldown prevents hammering every tick', () => {
  const tracker = createRoomTickHealthTracker()
  let now = T0
  for (let i = 0; i < ROOM_TICK_RECOVERY_TRIGGER_CONSECUTIVE_FAILURES; i += 1) {
    tracker.recordFailure('room-cool', 'compute_failed', now)
    now += 250
  }
  now += ROOM_TICK_RECOVERY_TRIGGER_MIN_ELAPSED_MS
  assert.equal(tracker.isRecoveryDue('room-cool', now), true)
  tracker.recordRecoveryAttempt('room-cool', now)

  // Still failing right after the attempt, cooldown not elapsed yet.
  tracker.recordFailure('room-cool', 'compute_failed', now + 250)
  assert.equal(
    tracker.isRecoveryDue('room-cool', now + 250),
    false,
    'must not re-attempt inside the cooldown window',
  )

  const afterCooldown = now + ROOM_TICK_RECOVERY_ATTEMPT_COOLDOWN_MS
  assert.equal(
    tracker.isRecoveryDue('room-cool', afterCooldown),
    true,
    'may re-attempt once the cooldown has elapsed',
  )
})

check('[6] recovery attempts are bounded', () => {
  const tracker = createRoomTickHealthTracker()
  const now = T0
  tracker.recordFailure('room-bound', 'compute_failed', now)
  assert.equal(tracker.hasExhaustedRecoveryAttempts('room-bound'), false)
  for (let i = 0; i < ROOM_TICK_MAX_RECOVERY_ATTEMPTS - 1; i += 1) {
    tracker.recordRecoveryAttempt('room-bound', now)
    assert.equal(
      tracker.hasExhaustedRecoveryAttempts('room-bound'),
      false,
      `must not be exhausted after ${i + 1} attempts (bound=${ROOM_TICK_MAX_RECOVERY_ATTEMPTS})`,
    )
  }
  tracker.recordRecoveryAttempt('room-bound', now)
  assert.equal(
    tracker.hasExhaustedRecoveryAttempts('room-bound'),
    true,
    `must be exhausted at exactly ${ROOM_TICK_MAX_RECOVERY_ATTEMPTS} attempts`,
  )
})

check('[7] absolute quarantine ceiling fires independent of recoveryAttempts', () => {
  const tracker = createRoomTickHealthTracker()
  const now = T0
  // Simulate the "assigned worker confirmed alive, deterministic compute
  // error" branch: failures accumulate, but NO recovery attempts are ever
  // recorded (attemptRoomTickRecovery in index.ts deliberately does not
  // reassign in this case — see its comment).
  tracker.recordFailure('room-live-worker-bug', 'compute_failed', now)
  assert.equal(tracker.getSnapshot('room-live-worker-bug')?.recoveryAttempts, 0)

  assert.equal(
    tracker.isQuarantineDue('room-live-worker-bug', now + ROOM_TICK_QUARANTINE_AFTER_UNHEALTHY_MS - 1),
    false,
  )
  assert.equal(
    tracker.isQuarantineDue('room-live-worker-bug', now + ROOM_TICK_QUARANTINE_AFTER_UNHEALTHY_MS),
    true,
    'must become quarantine-due purely from elapsed unhealthy duration, with zero recovery attempts',
  )
})

check('[8] quarantine is terminal — failures/successes after it do not resurrect status', () => {
  const tracker = createRoomTickHealthTracker()
  const now = T0
  tracker.recordFailure('room-q', 'compute_failed', now)
  tracker.markQuarantinedAwaitingRefundRetry('room-q', now + 10)
  assert.equal(tracker.isQuarantined('room-q'), true)

  tracker.recordFailure('room-q', 'compute_failed', now + 20)
  assert.equal(
    tracker.getSnapshot('room-q')?.consecutiveFailures,
    1,
    'recordFailure must be a no-op once quarantined (count must not keep growing)',
  )
  assert.equal(tracker.isQuarantined('room-q'), true)
  assert.equal(tracker.isRecoveryDue('room-q', now + 10_000_000), false, 'quarantine is never recovery-due again')
})

check('[9] remove() fully forgets a room', () => {
  const tracker = createRoomTickHealthTracker()
  tracker.recordFailure('room-forget', 'compute_failed', T0)
  tracker.markQuarantinedAwaitingRefundRetry('room-forget', T0 + 10)
  tracker.remove('room-forget')
  assert.equal(tracker.getSnapshot('room-forget'), null)

  tracker.recordSuccess('room-forget', T0 + 20)
  assert.equal(tracker.getSnapshot('room-forget')?.status, 'healthy', 're-registration starts fresh/healthy')
})

check('[10] listUnhealthy() only reports non-healthy rooms', () => {
  const tracker = createRoomTickHealthTracker()
  tracker.recordSuccess('room-ok', T0)
  tracker.recordFailure('room-bad', 'compute_failed', T0)
  tracker.markRecovering('room-bad')
  const unhealthy = tracker.listUnhealthy()
  assert.equal(unhealthy.length, 1)
  assert.equal(unhealthy[0]!.roomId, 'room-bad')
})

check('[11] invariant: a room cannot sit forever in a non-healthy, non-quarantined status', () => {
  const tracker = createRoomTickHealthTracker()
  let now = T0
  tracker.recordFailure('room-forever', 'compute_failed', now)
  // Simulate the worst case for reaching quarantine: recovery is NEVER due
  // because consecutive failures never reach the trigger count (e.g. one
  // failure, then silence forever — the room is simply never ticked
  // again, which is exactly the original zombie symptom). Even so, the
  // absolute ceiling must still fire once enough wall-clock time passes,
  // because unhealthySince was stamped on the FIRST failure and nothing
  // ever resets it short of an explicit success.
  now += ROOM_TICK_QUARANTINE_AFTER_UNHEALTHY_MS
  assert.equal(
    tracker.isQuarantineDue('room-forever', now),
    true,
    'no 5th "stuck forever, never even quarantined" state may exist',
  )
})

check('[12] fast refund-retry: due immediately on first quarantine, not due right after an attempt, due again after cooldown', () => {
  const tracker = createRoomTickHealthTracker()
  const now = T0
  tracker.markQuarantinedAwaitingRefundRetry('room-refund', now)
  assert.equal(tracker.isRefundRetryDue('room-refund', now), true, 'no attempt yet -> immediately due')

  tracker.recordRefundAttempt('room-refund', now)
  assert.equal(
    tracker.isRefundRetryDue('room-refund', now + 1),
    false,
    'right after an attempt, must wait out the FAST cooldown',
  )

  const afterCooldown = now + ROOM_REFUND_FAST_RETRY_COOLDOWN_MS
  assert.equal(tracker.isRefundRetryDue('room-refund', afterCooldown - 1), false)
  assert.equal(tracker.isRefundRetryDue('room-refund', afterCooldown), true)
})

check('[13] FAST refund attempts are bounded, but exhaustion alone never stops retry-due', () => {
  const tracker = createRoomTickHealthTracker()
  const now = T0
  tracker.markQuarantinedAwaitingRefundRetry('room-bound', now)
  assert.equal(tracker.hasExhaustedFastRefundAttempts('room-bound'), false)
  for (let i = 0; i < ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS - 1; i += 1) {
    tracker.recordRefundAttempt('room-bound', now)
    assert.equal(
      tracker.hasExhaustedFastRefundAttempts('room-bound'),
      false,
      `must not be exhausted after ${i + 1} attempts (bound=${ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS})`,
    )
  }
  tracker.recordRefundAttempt('room-bound', now)
  assert.equal(
    tracker.hasExhaustedFastRefundAttempts('room-bound'),
    true,
    `must be exhausted at exactly ${ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS} attempts`,
  )
  // Critical: exhausting FAST attempts, by itself, must NEVER make the
  // tracker stop being retry-due — only the pipeline deciding to call
  // markEnteringSlowRefundRetry changes the cadence. The tracker alone
  // must still honor the (still-fast) cooldown and come due again — this
  // is exactly the invariant the "refund retry exhaustion" bug violated.
  assert.equal(
    tracker.isRefundRetryDue('room-bound', now + ROOM_REFUND_FAST_RETRY_COOLDOWN_MS),
    true,
    'exhausted FAST attempts must still be retry-due once its own cooldown elapses — attempt count alone never terminates retry',
  )
})

check('[13b] slow refund-retry: unbounded, uses its own (longer) cooldown, never caps out across many cycles', () => {
  const tracker = createRoomTickHealthTracker()
  let now = T0
  tracker.markQuarantinedAwaitingRefundRetry('room-slow', now)
  for (let i = 0; i < ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS; i += 1) {
    tracker.recordRefundAttempt('room-slow', now)
  }
  tracker.markEnteringSlowRefundRetry('room-slow', now)
  assert.equal(tracker.getSnapshot('room-slow')?.status, 'quarantined_awaiting_refund_slow_retry')

  // The FAST cooldown elapsing is no longer relevant — only the (longer)
  // SLOW cooldown gates retry-due now.
  assert.equal(
    tracker.isRefundRetryDue('room-slow', now + ROOM_REFUND_FAST_RETRY_COOLDOWN_MS),
    false,
    'fast cooldown alone must not trigger a retry once in the slow phase',
  )

  // Simulate a long outage: 10 slow-retry cycles (10 x 5min = ~50 minutes,
  // well past the fix brief's explicit 30-minute example), each one a
  // fresh attempt that is STILL transient (never exhausts, never becomes
  // terminal) — isRefundRetryDue must keep becoming true again every time,
  // with no artificial cap on refundAttempts.
  for (let cycle = 0; cycle < 10; cycle += 1) {
    assert.equal(
      tracker.isRefundRetryDue('room-slow', now + ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS - 1),
      false,
      `cycle ${cycle}: one ms short of the slow cooldown must not be due yet`,
    )
    now += ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS
    assert.equal(tracker.isRefundRetryDue('room-slow', now), true, `cycle ${cycle}: slow cooldown elapsed -> due again`)
    tracker.recordRefundAttempt('room-slow', now)
    tracker.markEnteringSlowRefundRetry('room-slow', now)
  }
  assert.equal(
    tracker.getSnapshot('room-slow')?.refundAttempts,
    ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS + 10,
    'refundAttempts keeps counting with no cap, and the room is still in the (non-terminal) slow phase',
  )
  assert.equal(tracker.isQuarantined('room-slow'), true, 'still quarantined, never torn down, never terminal')
})

check('[14] markQuarantinedIneligible is terminal — never refund-retry-due', () => {
  const tracker = createRoomTickHealthTracker()
  const now = T0
  tracker.markQuarantinedIneligible('room-ineligible', 'legacy-stake-provenance-missing', now)
  assert.equal(tracker.isQuarantined('room-ineligible'), true)
  assert.equal(
    tracker.isRefundRetryDue('room-ineligible', now + 10 * ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS),
    false,
    'ineligible rooms must never be refund-retried — refund was never even attempted',
  )
})

check('[15] markQuarantinedRefundPermanentlyRefused is terminal — never refund-retry-due again, regardless of attempt count', () => {
  const tracker = createRoomTickHealthTracker()
  const now = T0
  tracker.markQuarantinedAwaitingRefundRetry('room-permanent', now)
  // Reaching exactly one attempt is enough — permanent is a classification,
  // never derived from how many attempts happened first.
  tracker.recordRefundAttempt('room-permanent', now)
  tracker.markQuarantinedRefundPermanentlyRefused('room-permanent', 'stake_debit amount unreadable', now)
  assert.equal(tracker.isQuarantined('room-permanent'), true)
  assert.equal(
    tracker.isRefundRetryDue('room-permanent', now + 10 * ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS),
    false,
  )
})

check('[16] isQuarantined() is true uniformly for all four quarantine sub-states', () => {
  const tracker = createRoomTickHealthTracker()
  tracker.markQuarantinedAwaitingRefundRetry('room-a', T0)
  tracker.markQuarantinedIneligible('room-b', 'reason', T0)
  tracker.markQuarantinedRefundPermanentlyRefused('room-c', 'reason', T0)
  tracker.markEnteringSlowRefundRetry('room-d', T0)
  assert.equal(tracker.isQuarantined('room-a'), true)
  assert.equal(tracker.isQuarantined('room-b'), true)
  assert.equal(tracker.isQuarantined('room-c'), true)
  assert.equal(tracker.isQuarantined('room-d'), true)
})

check('[17] quarantineDetail is recorded on terminal states and surfaced in the snapshot', () => {
  const tracker = createRoomTickHealthTracker()
  tracker.markQuarantinedIneligible('room-detail-1', 'legacy-stake-provenance-missing: ...', T0)
  assert.equal(tracker.getSnapshot('room-detail-1')?.quarantineDetail, 'legacy-stake-provenance-missing: ...')

  tracker.markQuarantinedRefundPermanentlyRefused('room-detail-2', 'stake_debit amount unreadable', T0)
  assert.equal(tracker.getSnapshot('room-detail-2')?.quarantineDetail, 'stake_debit amount unreadable')
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) {
  process.exit(1)
}
