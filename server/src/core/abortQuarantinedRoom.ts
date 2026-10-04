import type { ServerRoom, ServerState } from './serverTypes.js'
import { evaluateAutoAbortEligibility } from './evaluateAutoAbortEligibility.js'

// Technical-abort cleanup for a room whose automatic worker-level recovery
// is exhausted (root-cause audit: "zombie Belot room / session_in_game
// lock" — second-layer fix, economy-safety follow-up).
//
// Flow:
//  1. evaluateAutoAbortEligibility(room) — pure, no side effects. Refuses
//     tournament-origin rooms outright (separate domain/ledger, no safe
//     generic automatic bracket resolution), and refuses ANY staked
//     matchmaking room where a human participant's stake-debit provenance
//     is not traceable (legacy room, created before this fix). In either
//     refusal case, this function does NOTHING destructive — the room
//     stays exactly as it was (still quarantined, still tracked), and the
//     caller (quarantineRoomTick) simply logs a loud alert. No guessed
//     refund, no silent teardown of an un-refundable staked room.
//  2. deps.refundStakes(room) — ONLY reached once step 1 confirms safety.
//     Idempotent compensating refund of every real stake debit this room
//     ever collected (private-room/bot room-scoped debits via
//     matchEconomyStore.refundUnsettledRoomScopedStakes, matchmaking human
//     queue-scoped debits via matchEconomyStore.refundParticipantScopedStake
//     — see runAbortQuarantinedRoom's wiring in index.ts). If refund fails,
//     teardown is skipped entirely — a room is never destroyed while its
//     stake refund is unconfirmed.
//  3. Only after a successful refund does the actual lifecycle teardown run
//     — reusing the exact same primitives the normal "inactive room"
//     cleanup path already uses, plus the narrowly-scoped
//     deleteOrphanedPlayingMatch addition for private rooms.
//
// This function NEVER fabricates a winner/score, NEVER writes
// profile_match_results/table_exit_penalties, and NEVER touches tournament
// settlement/bracket state — those are structurally impossible here (no
// injected dependency exists for any of them).
//
// Idempotent end-to-end: calling it twice for the same roomId is safe.
// Once torn down, the second call takes the alreadyClean branch. If an
// earlier call was refused or its refund failed, the room is untouched and
// a later call simply re-evaluates from scratch (refundStakes itself is
// idempotent, so even a partially-applied refund from a crashed earlier
// attempt is safe to retry).
export type RefundEntry = { profileId: string; amount: number; scope: string }

export type AbortQuarantinedRoomDependencies = {
  finalizeActiveTableGiftImagesForRoom: (room: ServerRoom) => void
  cleanupTempBotsFromRoom: (room: ServerRoom) => void
  markRoomSnapshotRemoved: (roomId: string) => void
  removeRuntimeRoom: (roomId: string) => void
  removeHealthTracking: (roomId: string) => void
  isPrivateTableOriginRoom: (room: ServerRoom) => boolean
  // Returns true only if a row was actually deleted (never touches
  // 'finished' rows — see privateRoomMatchStore.deleteOrphanedPlayingMatch).
  deleteOrphanedPrivateMatchRow: (roomId: string) => boolean
  forgetPrivateGameScoreDedup: (roomId: string) => void
  broadcastPrivateGamesListToLobbyConnections: () => void
  // See flow step 2 above. MUST be idempotent — abortQuarantinedRoom may
  // invoke it on a retried attempt after an earlier partial failure.
  refundStakes: (
    room: ServerRoom,
  ) =>
    | { ok: true; refunds: RefundEntry[] }
    | { ok: false; message: string; kind: 'transient' | 'permanent' }
  log: (message: string) => void
}

export type AbortQuarantinedRoomResult = {
  ok: true
  nextServerState: ServerState
  // true only if the lifecycle teardown actually ran this call (false for
  // both the "refused — ineligible" and "refund failed" branches, and for
  // the idempotent "already clean" branch, which has nothing left to tear
  // down).
  aborted: boolean
  alreadyClean: boolean
  deletedPrivateMatchRow: boolean
  isTournamentOrigin: boolean
  refunds: RefundEntry[]
  refusalReason: string | null
  // Structured companion to refusalReason — lets callers (specifically
  // roomTickRecoveryPipeline.ts's refund-retry state machine) distinguish
  // "never attempt refund at all, sticky forever" (ineligible) from
  // "refund WAS attempted and failed, bounded-retry this" (refund-failed)
  // without parsing the free-text reason string. null whenever aborted is
  // true OR alreadyClean is true (nothing to classify).
  refusalKind: 'ineligible' | 'refund-failed' | null
  // Populated ONLY when refusalKind === 'refund-failed' — lets callers
  // (roomTickRecoveryPipeline.ts's fast/slow retry state machine) tell a
  // merely-transient DB hiccup (retry, possibly for a long time) apart from
  // a proven permanent data inconsistency (terminal, admin-required, never
  // retried). null in every other branch.
  refundFailureKind: 'transient' | 'permanent' | null
}

function isTournamentOriginRoom(room: ServerRoom): boolean {
  return room.config.isTournamentMatchOrigin === true && Boolean(room.config.tournamentMatchId)
}

export function abortQuarantinedRoom(
  serverState: ServerState,
  roomId: string,
  reason: string,
  removeCommittedServerRoom: (roomId: string, currentServerState: ServerState) => ServerState,
  deps: AbortQuarantinedRoomDependencies,
): AbortQuarantinedRoomResult {
  const room = serverState.rooms[roomId] ?? null

  if (room === null) {
    // Already gone from serverState.rooms — still run the idempotent
    // cleanup tail (snapshot/runtime/health/private-match-row), in case an
    // earlier partial failure left any of those behind, but there is no
    // room object to pass to the room-shaped side-effect helpers, and
    // nothing left to refund (a stake can only ever be refunded while the
    // room object — and therefore its participants — still exist).
    deps.markRoomSnapshotRemoved(roomId)
    deps.removeRuntimeRoom(roomId)
    deps.removeHealthTracking(roomId)
    deps.forgetPrivateGameScoreDedup(roomId)
    const deletedPrivateMatchRow = deps.deleteOrphanedPrivateMatchRow(roomId)
    if (deletedPrivateMatchRow) {
      deps.broadcastPrivateGamesListToLobbyConnections()
    }
    return {
      ok: true,
      nextServerState: serverState,
      aborted: true,
      alreadyClean: true,
      deletedPrivateMatchRow,
      isTournamentOrigin: false,
      refunds: [],
      refusalReason: null,
      refusalKind: null,
      refundFailureKind: null,
    }
  }

  const isTournamentOrigin = isTournamentOriginRoom(room)
  const isPrivateOrigin = deps.isPrivateTableOriginRoom(room)

  const eligibility = evaluateAutoAbortEligibility(room)

  if (!eligibility.safe) {
    deps.log(
      `[room-tick-abort-refused] room=${roomId} phase=${room.game.phase ?? 'unknown'} ` +
        `reason=${eligibility.reason} -- automatic teardown skipped; room remains quarantined ` +
        'pending manual/admin resolution. No refund attempted, no state touched.',
    )
    return {
      ok: true,
      nextServerState: serverState,
      aborted: false,
      alreadyClean: false,
      deletedPrivateMatchRow: false,
      isTournamentOrigin,
      refunds: [],
      refusalReason: eligibility.reason,
      refusalKind: 'ineligible',
      refundFailureKind: null,
    }
  }

  const refundResult = deps.refundStakes(room)

  if (!refundResult.ok) {
    deps.log(
      `[room-tick-abort-refund-failed] room=${roomId} phase=${room.game.phase ?? 'unknown'} ` +
        `kind=${refundResult.kind} message=${refundResult.message} -- automatic teardown skipped; ` +
        'room remains quarantined. A room is never torn down while its stake refund is unconfirmed.',
    )
    return {
      ok: true,
      nextServerState: serverState,
      aborted: false,
      alreadyClean: false,
      deletedPrivateMatchRow: false,
      isTournamentOrigin,
      refunds: [],
      refusalReason: `refund-failed:${refundResult.message}`,
      refusalKind: 'refund-failed',
      refundFailureKind: refundResult.kind,
    }
  }

  const nextServerState = removeCommittedServerRoom(roomId, serverState)
  deps.finalizeActiveTableGiftImagesForRoom(room)
  deps.cleanupTempBotsFromRoom(room)
  deps.markRoomSnapshotRemoved(roomId)
  deps.removeRuntimeRoom(roomId)
  deps.removeHealthTracking(roomId)

  let deletedPrivateMatchRow = false
  if (isPrivateOrigin) {
    deps.forgetPrivateGameScoreDedup(roomId)
    deletedPrivateMatchRow = deps.deleteOrphanedPrivateMatchRow(roomId)
    if (deletedPrivateMatchRow) {
      deps.broadcastPrivateGamesListToLobbyConnections()
    }
  }

  const refundedTotal = refundResult.refunds.reduce((sum, entry) => sum + entry.amount, 0)

  deps.log(
    `[room-tick-refund-success] room=${roomId} refundedEntries=${refundResult.refunds.length} ` +
      `refundedTotal=${refundedTotal} -- stake refund confirmed; proceeding to lifecycle teardown.`,
  )

  deps.log(
    `[room-tick-abort] room=${roomId} phase=${room.game.phase ?? 'unknown'} reason=${reason} ` +
      `isPrivateOrigin=${isPrivateOrigin} deletedPrivateMatchRow=${deletedPrivateMatchRow} ` +
      `refundedEntries=${refundResult.refunds.length} refundedTotal=${refundedTotal} -- ` +
      'technical-abort lifecycle teardown complete (serverState/runtime/snapshot/connections). ' +
      'Every real stake debit this room collected was compensated via idempotent ledger refund; ' +
      'NO winner was fabricated, NO profile_match_results/table_exit_penalties were written.',
  )

  return {
    ok: true,
    nextServerState,
    aborted: true,
    alreadyClean: false,
    deletedPrivateMatchRow,
    isTournamentOrigin,
    refunds: refundResult.refunds,
    refusalReason: null,
    refusalKind: null,
    refundFailureKind: null,
  }
}
