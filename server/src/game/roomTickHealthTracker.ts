// Runtime-only (NO DB persistence — reconstructable from nothing on every
// restart) per-room liveness/health tracking for the game-worker tick
// pipeline. See the "zombie Belot room / session_in_game lock" root-cause
// audit: tickRoomGameRuntimes() previously treated 'not_assigned' and
// 'compute_failed' tick results as silent no-ops forever, with zero
// tracking, zero recovery, zero escalation. This module is the missing
// liveness layer that drives bounded automatic recovery (see
// roomTickRecoveryPipeline.ts) AND two-phase (fast then slow, indefinite)
// automatic refund-retry (economy-safety follow-up: a TRANSIENT DB
// failure during technical-abort refund must never leave a room
// sticky-quarantined forever just because a handful of fast attempts
// failed — only a POSITIVELY PROVEN permanent/data-inconsistency failure
// is allowed to become a terminal, admin-required state).
//
// Deliberately NOT persisted to a table — a freshly (re)registered room
// always starts 'healthy' here, exactly matching the "no DB migration"
// scope constraint. If the server restarts, health state resets, which is
// safe: a genuinely-unhealthy room will simply re-accumulate failures
// within the same bounded thresholds again (see §6 startup resilience in
// index.ts, which goes through the SAME tick/recovery path, not a special
// case) — and a room that reaches quarantine again after restart retries
// refund fresh, idempotently (see matchEconomyStore's ledger-based
// idempotency, proven in checkPartialRefundSafety.ts/checkMatchEconomyRefund.ts).

export type RoomTickFailureKind = 'not_assigned' | 'compute_failed' | 'apply_failed'

// Six operationally distinct states (exact strings not load-bearing
// elsewhere, but worth naming clearly — see fix brief §1-§4 of the
// "refund retry exhaustion" follow-up):
//  - 'healthy'                         — ticking normally, or legitimately
//                                         waiting on a timer/human action.
//  - 'recovering'                      — a worker-level recovery attempt is
//                                         in flight (dead-worker reassign,
//                                         or deliberately NOT reassigning
//                                         against a live worker).
//  - 'quarantined_awaiting_refund_retry' — FAST retry phase. Worker-level
//                                         recovery exhausted, room IS
//                                         auto-abort eligible, but the
//                                         refund attempt failed — and every
//                                         failure classified so far is
//                                         TRANSIENT (see
//                                         matchEconomyStore's
//                                         classifyRefundThrowAsRetryKind).
//                                         Short, bounded cooldown
//                                         (ROOM_REFUND_FAST_RETRY_COOLDOWN_MS,
//                                         up to ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS
//                                         attempts).
//  - 'quarantined_awaiting_refund_slow_retry' — SLOW retry phase. Entered
//                                         once the fast phase's bounded
//                                         attempts are exhausted WITHOUT any
//                                         failure ever being classified
//                                         permanent. Longer cooldown
//                                         (ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS),
//                                         UNBOUNDED attempt count — this is
//                                         deliberately NOT terminal. A DB
//                                         outage lasting 30+ minutes (or
//                                         longer) is ridden out here: every
//                                         failure keeps the room in this
//                                         same state and simply reschedules
//                                         the next attempt. Exits only via
//                                         refund success (teardown) or a
//                                         failure newly classified
//                                         'permanent' (-> terminal below).
//  - 'quarantined_refund_permanently_refused' — Terminal. A refund attempt
//                                         failed with a POSITIVELY PROVEN
//                                         permanent/data-inconsistency
//                                         classification (never derived
//                                         from attempt count alone — see
//                                         fix brief §2). Never retried
//                                         automatically. High-signal
//                                         operator state — a real stake may
//                                         be sitting in limbo and needs a
//                                         human.
//  - 'quarantined_ineligible'          — evaluateAutoAbortEligibility
//                                         refused outright (a legacy
//                                         matchmaking room with unprovable
//                                         stake provenance — see §10 of the
//                                         fix brief; tournament-origin rooms
//                                         are no longer refused here, see
//                                         evaluateAutoAbortEligibility.ts).
//                                         Terminal: refund is never even
//                                         ATTEMPTED, let alone retried —
//                                         there is nothing transient to
//                                         retry.
export type RoomTickHealthStatus =
  | 'healthy'
  | 'recovering'
  | 'quarantined_awaiting_refund_retry'
  | 'quarantined_awaiting_refund_slow_retry'
  | 'quarantined_refund_permanently_refused'
  | 'quarantined_ineligible'

export type RoomTickHealthSnapshot = {
  roomId: string
  status: RoomTickHealthStatus
  consecutiveFailures: number
  lastFailureKind: RoomTickFailureKind | null
  // Epoch ms of the last REAL game-progress signal for this room — the only
  // authoritative "the engine is actually alive" marker. Only ever updated
  // from the worker-tick path (advanced-and-applied, or a legitimate
  // unchanged/waiting-for-timer result) — NEVER from a human
  // reconnect/resume, which commits a fresh snapshot (commitServerRoomWithSnapshot
  // in tryResumeRoomForConnection) without ever going through this tracker.
  // This is exactly the distinction §7 of the fix brief requires between
  // "profile touched the room" and "the engine progressed".
  lastSuccessAt: number
  // Epoch ms since when this room has been continuously non-healthy. null
  // while healthy. Reset on every successful tick.
  unhealthySince: number | null
  recoveryAttempts: number
  lastRecoveryAttemptAt: number | null
  quarantinedAt: number | null
  // Refund-retry bookkeeping — independent counters/timestamps from the
  // worker-recovery ones above (a different, two-phase fast/slow retry
  // concern, see ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS /
  // ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS). One shared counter across both
  // phases — the status field alone distinguishes fast vs slow.
  refundAttempts: number
  lastRefundAttemptAt: number | null
  // Free-text detail for operator logs/diagnostics — WHY this room is
  // quarantined, set once when the terminal 'quarantined_ineligible'/
  // 'quarantined_refund_permanently_refused' status is reached.
  quarantineDetail: string | null
}

type MutableHealth = {
  status: RoomTickHealthStatus
  consecutiveFailures: number
  lastFailureKind: RoomTickFailureKind | null
  lastSuccessAt: number
  unhealthySince: number | null
  recoveryAttempts: number
  lastRecoveryAttemptAt: number | null
  quarantinedAt: number | null
  refundAttempts: number
  lastRefundAttemptAt: number | null
  quarantineDetail: string | null
}

// ─── Named thresholds (rationale required by the fix brief — no bare magic
// numbers). All derived against the largest NORMAL/legitimate wait a
// healthy room can have, so a real human playing normally, or a room
// legitimately idling inside its reconnect grace, is never mistaken for a
// zombie:
//   - cut/bid/play human timeout = 20_000ms (SERVER_TIMING_CONFIG)
//   - sweep-offer human timeout  = 15_000ms
//   - default reconnectGraceMs   = 30_000ms (createServerRoom.ts)
//   - worker request timeout     = 5_000ms (pool requestTimeoutMs)
//   - tick cadence               = 250ms (gameRuntimeTickInterval)
// The largest of these is 30_000ms. None of them, by themselves, ever
// produce a 'not_assigned'/'compute_failed' tick result — those are error
// conditions that never occur during healthy operation, so we do not need
// to wait as long as a human timeout before reacting; we only need to rule
// out a single-tick blip (a momentary busy-batch overlap, one dropped
// request). ─────────────────────────────────────────────────────────────

// Require this many CONSECUTIVE failed ticks before even considering
// recovery — at 250ms cadence this is ~2s, far above a one-off blip, far
// below any legitimate timeout.
export const ROOM_TICK_RECOVERY_TRIGGER_CONSECUTIVE_FAILURES = 8

// ...AND require this much elapsed wall-clock time unhealthy, independent
// of tick cadence (defends against a degraded/slow tick loop still
// counting as "only 8 ticks" while actually spanning much longer).
export const ROOM_TICK_RECOVERY_TRIGGER_MIN_ELAPSED_MS = 10_000

// Space out recovery attempts — never hammer reassignment every 250ms tick
// while a room is still unhealthy right after an attempt.
export const ROOM_TICK_RECOVERY_ATTEMPT_COOLDOWN_MS = 20_000

// Bounded — if 3 reassignments to (presumably healthy, different) workers
// all still fail, it stops being plausible that this is "worker flakiness"
// and strongly indicates a deterministic room-state failure (§4 of the
// brief: reassignment must never become an infinite loop).
export const ROOM_TICK_MAX_RECOVERY_ATTEMPTS = 3

// Absolute ceiling, independent of recoveryAttempts — covers the
// deterministic-compute-error case where the assigned worker is confirmed
// alive (so no worker-level recovery is ever attempted at all, see
// roomTickRecoveryPipeline.ts) and would otherwise never reach the
// recoveryAttempts-based quarantine check. Significantly larger than
// reconnect grace (30s) + the longest human timeout (20s) combined, but
// far short of "hours" — matches the brief's explicit requirement.
export const ROOM_TICK_QUARANTINE_AFTER_UNHEALTHY_MS = 5 * 60_000

// ─── Refund-retry thresholds (economy-safety follow-up) — deliberately MORE
// conservative than the worker-recovery ones above: a refund retry means
// "we already know this room is eligible, we just need the DB to
// cooperate", which is rarer and more consequential (a real stake is in
// limbo) than a worker reassignment, so it gets a longer, simpler
// (non-exponential, flat) backoff. Two phases, not one bound — see the
// "refund retry exhaustion" fix brief §1-§3: exhausting the FAST phase's
// bounded attempts must never by itself become a terminal give-up, because
// a real DB outage can outlast it. Only a POSITIVELY classified permanent
// failure (see matchEconomyStore.classifyRefundThrowAsRetryKind) is
// terminal — attempt count alone never is. ───────────────────────────────

// Flat (not exponential) backoff between FAST-phase refund attempts —
// simple, predictable, easy to reason about and test. 60s is long enough
// that a handful of attempts spans minutes, not seconds (never hammers the
// DB on every 250ms tick), while still resolving a merely-momentary
// failure (e.g. a single SQLITE_BUSY lock contention) quickly.
export const ROOM_REFUND_FAST_RETRY_COOLDOWN_MS = 60_000

// Bounded — after 5 FAST attempts (5 x 60s = ~5 minutes), a transient
// failure that keeps recurring is no longer "a single momentary blip" —
// but it is STILL not assumed permanent. It transitions to the SLOW phase
// instead of giving up (see ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS below).
export const ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS = 5

// Flat backoff for the SLOW phase, entered once FAST attempts are
// exhausted while every failure so far is still classified transient.
// 5 minutes keeps retries rare enough to never busy-loop (at most ~12
// attempts/hour) while still resolving even a long infrastructure outage
// (the fix brief's explicit 30-minute example resolves in ~6 slow
// attempts) well within the process's lifetime. Deliberately UNBOUNDED —
// there is no max-attempts constant for this phase; a plain JS counter
// ticking once every 5 minutes cannot practically overflow
// Number.MAX_SAFE_INTEGER within any operationally meaningful timeframe
// (it would take longer than the age of this project run many times over),
// so no artificial attempt cap is needed to avoid overflow, and adding one
// would just reintroduce the exact "5 attempts then give up" bug this fix
// removes.
export const ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS = 5 * 60_000

export type RoomTickHealthTracker = {
  recordSuccess(roomId: string, now?: number): void
  recordFailure(roomId: string, kind: RoomTickFailureKind, now?: number): void
  recordRecoveryAttempt(roomId: string, now?: number): void
  markRecovering(roomId: string): void
  // First-time entry into quarantine, BEFORE eligibility/refund has even
  // been evaluated — tentatively 'quarantined_awaiting_refund_retry' (the
  // caller refines this immediately afterwards via
  // markQuarantinedIneligible/markEnteringSlowRefundRetry/
  // markQuarantinedRefundPermanentlyRefused/remove, based on what the first
  // abort attempt actually found). Also used to STAY in the fast phase on a
  // repeat transient failure that has not yet exhausted fast attempts —
  // idempotent re-set.
  markQuarantinedAwaitingRefundRetry(roomId: string, now?: number): void
  // Terminal — evaluateAutoAbortEligibility refused outright. Refund is
  // never attempted, so there is nothing to retry; sticky until an admin
  // resolves it out-of-band.
  markQuarantinedIneligible(roomId: string, detail: string, now?: number): void
  // NOT terminal — transitions from the fast phase into the slow phase
  // once ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS is reached while every
  // failure so far is still classified transient. Idempotent: calling it
  // again while already in the slow phase is a safe no-op re-set (keeps
  // retrying indefinitely at the slow cadence).
  markEnteringSlowRefundRetry(roomId: string, now?: number): void
  // Terminal — a refund failure was POSITIVELY classified 'permanent' (see
  // matchEconomyStore.classifyRefundThrowAsRetryKind). Never derived from
  // attempt count. Sticky until an admin resolves it.
  markQuarantinedRefundPermanentlyRefused(roomId: string, detail: string, now?: number): void
  recordRefundAttempt(roomId: string, now?: number): void
  getSnapshot(roomId: string): RoomTickHealthSnapshot | null
  remove(roomId: string): void
  // True once consecutive-failure + elapsed-time triggers are both met —
  // i.e. "this room is unhealthy enough to even consider recovery", before
  // any worker-aliveness decision is made.
  isRecoveryDue(roomId: string, now?: number): boolean
  isQuarantineDue(roomId: string, now?: number): boolean
  hasExhaustedRecoveryAttempts(roomId: string): boolean
  // True for ANY of the four quarantined_* statuses — used to gate
  // worker-level recovery (never re-attempt reassignment once quarantined,
  // regardless of which quarantine sub-state).
  isQuarantined(roomId: string): boolean
  // True for 'quarantined_awaiting_refund_retry' OR
  // 'quarantined_awaiting_refund_slow_retry', each gated by ITS OWN
  // cooldown (fast vs slow) since the last attempt (or no attempt yet).
  // False for both terminal quarantine states (nothing to retry) and for
  // every non-quarantined status.
  isRefundRetryDue(roomId: string, now?: number): boolean
  // True once ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS is reached — the signal
  // the caller uses to decide fast -> slow transition. Does NOT mean
  // "give up"; see markEnteringSlowRefundRetry.
  hasExhaustedFastRefundAttempts(roomId: string): boolean
  listUnhealthy(): RoomTickHealthSnapshot[]
}

function toSnapshot(roomId: string, health: MutableHealth): RoomTickHealthSnapshot {
  return { roomId, ...health }
}

function isQuarantinedStatus(status: RoomTickHealthStatus): boolean {
  return (
    status === 'quarantined_awaiting_refund_retry' ||
    status === 'quarantined_awaiting_refund_slow_retry' ||
    status === 'quarantined_refund_permanently_refused' ||
    status === 'quarantined_ineligible'
  )
}

export function createRoomTickHealthTracker(): RoomTickHealthTracker {
  const healthByRoomId = new Map<string, MutableHealth>()

  function ensure(roomId: string, now: number): MutableHealth {
    const existing = healthByRoomId.get(roomId)
    if (existing !== undefined) return existing
    const fresh: MutableHealth = {
      status: 'healthy',
      consecutiveFailures: 0,
      lastFailureKind: null,
      lastSuccessAt: now,
      unhealthySince: null,
      recoveryAttempts: 0,
      lastRecoveryAttemptAt: null,
      quarantinedAt: null,
      refundAttempts: 0,
      lastRefundAttemptAt: null,
      quarantineDetail: null,
    }
    healthByRoomId.set(roomId, fresh)
    return fresh
  }

  return {
    recordSuccess(roomId, now = Date.now()) {
      const health = ensure(roomId, now)
      health.status = 'healthy'
      health.consecutiveFailures = 0
      health.lastFailureKind = null
      health.lastSuccessAt = now
      health.unhealthySince = null
      health.recoveryAttempts = 0
      health.lastRecoveryAttemptAt = null
      health.quarantinedAt = null
      health.refundAttempts = 0
      health.lastRefundAttemptAt = null
      health.quarantineDetail = null
    },

    recordFailure(roomId, kind, now = Date.now()) {
      const health = ensure(roomId, now)
      if (isQuarantinedStatus(health.status)) {
        // Quarantine (any sub-state) is terminal for FAILURE counting —
        // never resume counting worker-tick failures for a room already
        // past the worker-recovery stage. A fresh registration (remove()
        // + re-ensure, e.g. after an explicit admin/server cleanup or a
        // successful abort) is required to leave quarantine.
        return
      }
      health.consecutiveFailures += 1
      health.lastFailureKind = kind
      if (health.unhealthySince === null) {
        health.unhealthySince = now
      }
    },

    recordRecoveryAttempt(roomId, now = Date.now()) {
      const health = ensure(roomId, now)
      health.recoveryAttempts += 1
      health.lastRecoveryAttemptAt = now
    },

    markRecovering(roomId) {
      const health = healthByRoomId.get(roomId)
      if (health === undefined || isQuarantinedStatus(health.status)) return
      health.status = 'recovering'
    },

    markQuarantinedAwaitingRefundRetry(roomId, now = Date.now()) {
      const health = ensure(roomId, now)
      health.status = 'quarantined_awaiting_refund_retry'
      if (health.quarantinedAt === null) {
        health.quarantinedAt = now
      }
    },

    markQuarantinedIneligible(roomId, detail, now = Date.now()) {
      const health = ensure(roomId, now)
      health.status = 'quarantined_ineligible'
      if (health.quarantinedAt === null) {
        health.quarantinedAt = now
      }
      health.quarantineDetail = detail
    },

    markEnteringSlowRefundRetry(roomId, now = Date.now()) {
      const health = ensure(roomId, now)
      health.status = 'quarantined_awaiting_refund_slow_retry'
      if (health.quarantinedAt === null) {
        health.quarantinedAt = now
      }
    },

    markQuarantinedRefundPermanentlyRefused(roomId, detail, now = Date.now()) {
      const health = ensure(roomId, now)
      health.status = 'quarantined_refund_permanently_refused'
      if (health.quarantinedAt === null) {
        health.quarantinedAt = now
      }
      health.quarantineDetail = detail
    },

    recordRefundAttempt(roomId, now = Date.now()) {
      const health = ensure(roomId, now)
      health.refundAttempts += 1
      health.lastRefundAttemptAt = now
    },

    getSnapshot(roomId) {
      const health = healthByRoomId.get(roomId)
      return health === undefined ? null : toSnapshot(roomId, health)
    },

    remove(roomId) {
      healthByRoomId.delete(roomId)
    },

    isRecoveryDue(roomId, now = Date.now()) {
      const health = healthByRoomId.get(roomId)
      if (health === undefined || isQuarantinedStatus(health.status)) return false
      if (health.consecutiveFailures < ROOM_TICK_RECOVERY_TRIGGER_CONSECUTIVE_FAILURES) return false
      if (health.unhealthySince === null) return false
      if (now - health.unhealthySince < ROOM_TICK_RECOVERY_TRIGGER_MIN_ELAPSED_MS) return false
      if (
        health.lastRecoveryAttemptAt !== null &&
        now - health.lastRecoveryAttemptAt < ROOM_TICK_RECOVERY_ATTEMPT_COOLDOWN_MS
      ) {
        return false
      }
      return true
    },

    isQuarantineDue(roomId, now = Date.now()) {
      const health = healthByRoomId.get(roomId)
      if (health === undefined || isQuarantinedStatus(health.status)) return false
      if (health.unhealthySince === null) return false
      return now - health.unhealthySince >= ROOM_TICK_QUARANTINE_AFTER_UNHEALTHY_MS
    },

    hasExhaustedRecoveryAttempts(roomId) {
      const health = healthByRoomId.get(roomId)
      if (health === undefined) return false
      return health.recoveryAttempts >= ROOM_TICK_MAX_RECOVERY_ATTEMPTS
    },

    isQuarantined(roomId) {
      const health = healthByRoomId.get(roomId)
      return health !== undefined && isQuarantinedStatus(health.status)
    },

    isRefundRetryDue(roomId, now = Date.now()) {
      const health = healthByRoomId.get(roomId)
      if (health === undefined) return false

      if (health.status === 'quarantined_awaiting_refund_retry') {
        if (health.lastRefundAttemptAt === null) return true
        return now - health.lastRefundAttemptAt >= ROOM_REFUND_FAST_RETRY_COOLDOWN_MS
      }

      if (health.status === 'quarantined_awaiting_refund_slow_retry') {
        if (health.lastRefundAttemptAt === null) return true
        return now - health.lastRefundAttemptAt >= ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS
      }

      return false
    },

    hasExhaustedFastRefundAttempts(roomId) {
      const health = healthByRoomId.get(roomId)
      if (health === undefined) return false
      return health.refundAttempts >= ROOM_REFUND_FAST_RETRY_MAX_ATTEMPTS
    },

    listUnhealthy() {
      const result: RoomTickHealthSnapshot[] = []
      for (const [roomId, health] of healthByRoomId) {
        if (health.status !== 'healthy') {
          result.push(toSnapshot(roomId, health))
        }
      }
      return result
    },
  }
}
