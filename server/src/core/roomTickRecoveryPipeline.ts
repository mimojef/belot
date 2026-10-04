import type { ServerRoom } from './serverTypes.js'
import type {
  RoomTickFailureKind,
  RoomTickHealthTracker,
} from '../game/roomTickHealthTracker.js'
import {
  ROOM_REFUND_FAST_RETRY_COOLDOWN_MS,
  ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS,
} from '../game/roomTickHealthTracker.js'

// §10 observability — "room type" tag shared by every quarantine/refund log
// line below. Pure classification off room.config, no new semantics.
function describeRoomType(room: ServerRoom | null): string {
  if (room === null) return 'unknown'
  if (room.config.isTournamentMatchOrigin === true) return 'tournament'
  if (room.config.stakeAmount != null && room.config.stakeAmount > 0) return 'staked-matchmaking-or-private'
  return 'unstaked'
}

function describeTournamentContext(room: ServerRoom | null): string {
  if (room === null || room.config.isTournamentMatchOrigin !== true) return ''
  return ` tournamentId=${room.config.tournamentId ?? 'unknown'} tournamentMatchId=${room.config.tournamentMatchId ?? 'unknown'}`
}

// Extracted, dependency-injected orchestration for the full zombie-room
// recovery/quarantine/abort/refund-retry decision chain (root-cause audit:
// "session_in_game lock", economy-safety follow-up, "refund retry
// exhaustion" fix). Previously this logic lived as index.ts closures that
// could only be exercised through a real running server waiting real
// wall-clock minutes. Extracting it here — same DI pattern as
// abortQuarantinedRoom.ts — lets a test drive the ENTIRE chain (failure ->
// recovery attempts -> exhaustion -> quarantine -> abort attempt -> fast
// retry -> slow retry (indefinite, for transient failures) -> eventual
// teardown OR terminal permanent-failure state) with an injected,
// instantly-advanceable clock, while still exercising the REAL control flow
// index.ts actually wires up (see checkRoomTickRecoveryPipeline.ts).
export type AbortAttemptOutcome = {
  aborted: boolean
  refusalKind: 'ineligible' | 'refund-failed' | null
  // Populated ONLY when refusalKind === 'refund-failed' — see
  // abortQuarantinedRoom.ts's AbortQuarantinedRoomResult.refundFailureKind.
  // This, NOT attempt count, is what decides fast/slow-retry vs terminal.
  refundFailureKind: 'transient' | 'permanent' | null
  refusalReason: string | null
}

export type RoomTickRecoveryDependencies = {
  health: RoomTickHealthTracker
  getRoom: (roomId: string) => ServerRoom | null
  hasWorkerPool: boolean
  getWorkerIdForRoom: (roomId: string) => string | null
  releaseRoomIfWorkerUnavailable: (
    roomId: string,
  ) => { released: boolean; previousWorkerId: string | null }
  ensureRoom: (room: ServerRoom) => { ok: boolean; reason?: string }
  // The SAME abortQuarantinedRoom-based function index.ts wires up
  // (runAbortQuarantinedRoom) — already proven independently in
  // checkAbortQuarantinedRoom.ts. Passed in, not reimplemented here. Called
  // BOTH on first reaching quarantine AND on every subsequent fast/slow
  // refund retry — abortQuarantinedRoom is idempotent, so re-invoking it is
  // always safe (see its own doc comment).
  abortRoom: (roomId: string, reason: string) => AbortAttemptOutcome
  log: (message: string) => void
}

// Single entry point for every abort ATTEMPT — the first one (from
// quarantineAndAbort, when worker-level recovery is exhausted) and every
// bounded refund retry (from maybeRetryQuarantinedRoomRefund) funnel
// through here, so the health-state transition logic lives in exactly one
// place.
function runAbortAttempt(
  roomId: string,
  now: number,
  reason: string,
  deps: RoomTickRecoveryDependencies,
): void {
  const outcome = deps.abortRoom(roomId, reason)
  const room = deps.getRoom(roomId)
  const roomType = describeRoomType(room)
  const tournamentContext = describeTournamentContext(room)

  if (outcome.aborted) {
    // abortQuarantinedRoom's own removeHealthTracking dependency already
    // called health.remove(roomId) as part of a successful teardown —
    // nothing further to do here.
    return
  }

  if (outcome.refusalKind === 'ineligible') {
    deps.health.markQuarantinedIneligible(roomId, outcome.refusalReason ?? 'unknown', now)
    deps.log(
      `[room-tick-quarantine-ineligible] room=${roomId} roomType=${roomType}${tournamentContext} ` +
        `reason=${outcome.refusalReason ?? 'unknown'} -- ` +
        'automatic abort will NEVER be retried for this room (no refund was even attempted); ' +
        'requires explicit manual/admin resolution.',
    )
    return
  }

  // refund-failed (or null refusalKind on a non-aborted outcome, which
  // should not happen in practice but is treated the same conservative
  // way — never silently give up without a visible state transition).
  deps.health.recordRefundAttempt(roomId, now)

  if (outcome.refundFailureKind === 'permanent') {
    // Terminal — but ONLY because the failure was POSITIVELY classified
    // permanent (see matchEconomyStore.classifyRefundThrowAsRetryKind),
    // never because of attempt count. This can fire on the very first
    // attempt just as well as the hundredth.
    deps.health.markQuarantinedRefundPermanentlyRefused(roomId, outcome.refusalReason ?? 'unknown', now)
    deps.log(
      `[room-tick-refund-permanent-failure] room=${roomId} roomType=${roomType}${tournamentContext} ` +
        `reason=${outcome.refusalReason ?? 'unknown'} -- ` +
        'refund failure proven to be a permanent data inconsistency, not transient infrastructure trouble; ' +
        'a real stake debit may remain unrefunded. Room stays quarantined, requires explicit manual/admin ' +
        'resolution. NOT retried automatically.',
    )
    return
  }

  // transient (or an abortRoom implementation that did not classify —
  // treated as transient, the conservative choice: never silently
  // terminal without positive proof).
  if (deps.health.hasExhaustedFastRefundAttempts(roomId)) {
    deps.health.markEnteringSlowRefundRetry(roomId, now)
    const snapshot = deps.health.getSnapshot(roomId)
    const nextRetryAt = now + ROOM_REFUND_SLOW_RETRY_COOLDOWN_MS
    deps.log(
      `[room-tick-refund-slow-retry-scheduled] room=${roomId} roomType=${roomType}${tournamentContext} ` +
        `attempt=${snapshot?.refundAttempts ?? 0} reason=${outcome.refusalReason ?? 'unknown'} ` +
        `nextRetryAt=${new Date(nextRetryAt).toISOString()} -- fast retries exhausted but failure is still ` +
        'transient; switching to a slower, indefinite retry cadence (never gives up on its own).',
    )
    return
  }

  deps.health.markQuarantinedAwaitingRefundRetry(roomId, now)
  const snapshot = deps.health.getSnapshot(roomId)
  const nextRetryAt = now + ROOM_REFUND_FAST_RETRY_COOLDOWN_MS
  deps.log(
    `[room-tick-refund-retry-scheduled] room=${roomId} roomType=${roomType}${tournamentContext} ` +
      `attempt=${snapshot?.refundAttempts ?? 0} reason=${outcome.refusalReason ?? 'unknown'} ` +
      `nextRetryAt=${new Date(nextRetryAt).toISOString()} -- will retry refund after a short cooldown.`,
  )
}

function quarantineAndAbort(roomId: string, now: number, deps: RoomTickRecoveryDependencies): void {
  const snapshot = deps.health.getSnapshot(roomId)
  const room = deps.getRoom(roomId)
  const unhealthyForMs = snapshot?.unhealthySince != null ? now - snapshot.unhealthySince : null

  deps.log(
    `[room-tick-quarantine] room=${roomId} phase=${room?.game.phase ?? 'unknown'} ` +
      `roomType=${describeRoomType(room)}${describeTournamentContext(room)} ` +
      `lastFailureKind=${snapshot?.lastFailureKind ?? 'unknown'} ` +
      `consecutiveFailures=${snapshot?.consecutiveFailures ?? 0} ` +
      `recoveryAttempts=${snapshot?.recoveryAttempts ?? 0} ` +
      `unhealthyForMs=${unhealthyForMs ?? 'unknown'} -- ` +
      'automatic worker-level recovery exhausted; proceeding to technical-abort evaluation.',
  )

  // Tentative state — runAbortAttempt immediately refines this to
  // 'quarantined_ineligible' or back to itself (with an incremented
  // refundAttempts) or, on success, removes health tracking entirely.
  deps.health.markQuarantinedAwaitingRefundRetry(roomId, now)
  runAbortAttempt(roomId, now, 'tick-recovery-exhausted', deps)
}

// Called every tick once a room is ALREADY quarantined — a cheap,
// near-always-false check (status lookup + timestamp comparison) in the
// common case, so a quarantined room costs nothing extra per tick beyond
// this single guard (see §12 performance requirement). Only actually
// re-invokes the abort attempt once the CURRENT phase's cooldown has
// elapsed (fast or slow — isRefundRetryDue picks the right one off the
// room's own status) AND the room is in one of the two retry-eligible
// sub-states (never for 'quarantined_ineligible'/
// 'quarantined_refund_permanently_refused' — both terminal).
function maybeRetryQuarantinedRoomRefund(
  roomId: string,
  now: number,
  deps: RoomTickRecoveryDependencies,
): void {
  if (!deps.health.isRefundRetryDue(roomId, now)) {
    return
  }
  runAbortAttempt(roomId, now, 'refund-retry', deps)
}

export function attemptRoomTickRecovery(
  roomId: string,
  now: number,
  deps: RoomTickRecoveryDependencies,
): void {
  if (deps.health.isQuarantined(roomId)) {
    maybeRetryQuarantinedRoomRefund(roomId, now, deps)
    return
  }

  if (!deps.health.isRecoveryDue(roomId, now)) {
    if (deps.health.isQuarantineDue(roomId, now)) {
      quarantineAndAbort(roomId, now, deps)
    }
    return
  }

  const room = deps.getRoom(roomId)

  if (room === null) {
    deps.health.remove(roomId)
    return
  }

  if (!deps.hasWorkerPool) {
    if (deps.health.isQuarantineDue(roomId, now)) {
      quarantineAndAbort(roomId, now, deps)
    }
    return
  }

  if (deps.health.hasExhaustedRecoveryAttempts(roomId)) {
    if (deps.health.isQuarantineDue(roomId, now)) {
      quarantineAndAbort(roomId, now, deps)
    }
    return
  }

  const snapshotBeforeAttempt = deps.health.getSnapshot(roomId)
  const oldWorkerId = deps.getWorkerIdForRoom(roomId)
  const releaseResult = deps.releaseRoomIfWorkerUnavailable(roomId)

  if (!releaseResult.released && releaseResult.previousWorkerId !== null) {
    deps.health.markRecovering(roomId)
    if (deps.health.isQuarantineDue(roomId, now)) {
      quarantineAndAbort(roomId, now, deps)
    }
    return
  }

  deps.health.recordRecoveryAttempt(roomId, now)
  deps.health.markRecovering(roomId)

  const ensureResult = deps.ensureRoom(room)
  const newWorkerId = ensureResult.ok ? deps.getWorkerIdForRoom(roomId) : null
  const attemptNumber = (snapshotBeforeAttempt?.recoveryAttempts ?? 0) + 1
  const unhealthyForMs =
    snapshotBeforeAttempt?.unhealthySince != null
      ? now - snapshotBeforeAttempt.unhealthySince
      : null

  deps.log(
    `[room-tick-recovery] room=${roomId} phase=${room.game.phase ?? 'unknown'} ` +
      `oldWorkerId=${oldWorkerId ?? 'none'} newWorkerId=${newWorkerId ?? 'none'} ` +
      `attempt=${attemptNumber} ` +
      `consecutiveFailures=${snapshotBeforeAttempt?.consecutiveFailures ?? 0} ` +
      `lastFailureKind=${snapshotBeforeAttempt?.lastFailureKind ?? 'unknown'} ` +
      `unhealthyForMs=${unhealthyForMs ?? 'unknown'} ` +
      `result=${ensureResult.ok ? 'ok' : `failed:${ensureResult.reason ?? 'unknown'}`}`,
  )
}

export function handleRoomTickFailure(
  roomId: string,
  kind: RoomTickFailureKind,
  now: number,
  deps: RoomTickRecoveryDependencies,
): void {
  deps.health.recordFailure(roomId, kind, now)
  attemptRoomTickRecovery(roomId, now, deps)
}
