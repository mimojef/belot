import type { ServerRoom } from './serverTypes.js'
import { SERVER_SEAT_ORDER } from './serverTypes.js'

// Pure, side-effect-free eligibility gate for the SECOND-layer zombie-room
// fix's economy-safety follow-up (root-cause audit: "session_in_game lock"
// — matchmaking stake-loss blocker). Called BEFORE any refund/teardown is
// attempted — see abortQuarantinedRoom.ts. No DI needed: every input is a
// plain field already on ServerRoom, so this is directly unit-testable with
// zero mocks.
export type AutoAbortEligibility =
  | { safe: true }
  | { safe: false; reason: string }

// Reused by matchEconomyStore refund call sites too, so "was this room
// actually staked at all" is decided in exactly one place.
export function getRoomStakeAmount(room: ServerRoom): number {
  return room.config.stakeAmount ?? 0
}

export function evaluateAutoAbortEligibility(room: ServerRoom): AutoAbortEligibility {
  // §7 of the "technical rematch" fix brief — tournament-origin rooms are
  // DELIBERATELY NOT special-cased here anymore (a prior revision refused
  // them outright). Proven via a read-only audit of tournamentCoordinator.ts
  // (see roomTickRecoveryPipeline.ts's doc comment for the full trace):
  // every tournament match room is built with config.stakeAmount = 0 (see
  // buildRoom in tournamentCoordinator.ts — tournament entry fees live
  // entirely in the separate tournament_economy_ledger, never in a
  // room-scoped match_economy_ledger debit), so such a room ALWAYS falls
  // through to the stakeAmount<=0 "safe:true" branch below, exactly like
  // any other unstaked room — refundStakes() for it is a guaranteed,
  // already-proven no-op (zero matching ledger rows). Technical removal of
  // an unrecoverable tournament room therefore mutates NOTHING tournament-
  // specific (no winner, no payout, no walkover, no bracket advancement —
  // abortQuarantinedRoom has no dependency capable of any of that); it only
  // ever does the exact same generic serverState/snapshot/runtime/health
  // teardown every other auto-abort does. The actual match/bracket
  // continuity is handled entirely by tournamentCoordinator's OWN,
  // already-shipped ensureMatchRoom() self-heal, which unconditionally
  // re-checks every 'in_progress' match's room on its next reconciliation
  // tick and rebuilds a fresh (0-0) room for the SAME match_id/room_id if
  // it finds the room missing — see ensureMatchRoom's `existingRoom ===
  // null` branch. This file calls no tournament code at all; it only stops
  // refusing to let the generic teardown run.

  const stakeAmount = getRoomStakeAmount(room)

  if (
    room.config.isTournamentMatchOrigin === true &&
    Boolean(room.config.tournamentMatchId) &&
    stakeAmount > 0
  ) {
    // Defensive-only: this should be IMPOSSIBLE given buildRoom always
    // sets stakeAmount=0 for tournament matches (see the audit trace
    // above), but if that invariant were ever violated, a real tournament
    // entry fee must NEVER be auto-refunded through the generic
    // room/queue-scoped match_economy_ledger path below — tournament
    // stakes live entirely in the separate tournament_economy_ledger, and
    // a stakeLedgerScope (if one even happened to be set) would not mean
    // what it means for a normal matchmaking room. Refuse outright rather
    // than silently trusting an unrelated scope string.
    return {
      safe: false,
      reason:
        'tournament-origin-room-unexpectedly-staked: stakeAmount>0 on a tournament match room violates the buildRoom invariant this policy depends on — refusing automatic refund/abort',
    }
  }

  if (stakeAmount <= 0) {
    // Unstaked (incl. guest trial, and every real tournament match room)
    // — nothing to lose, nothing to trace.
    return { safe: true }
  }

  if (room.config.isPrivateTableOrigin === true) {
    // Private-room stakes (both human and bot) are ALWAYS room-scoped
    // (`${roomId}:v{N}` — see matchEconomyStore.getRoomStakeLedgerScope),
    // discoverable purely via a DB LIKE query on room_id. This does NOT
    // depend on HumanRoomParticipant.stakeLedgerScope at all, so legacy
    // (pre-fix) private rooms are equally safe to auto-abort.
    return { safe: true }
  }

  // Normal matchmaking: human stakes are QUEUE-scoped
  // (`queue:${entryId}`), which has no relationship to the room id at all
  // and is only recoverable via HumanRoomParticipant.stakeLedgerScope
  // (set at match-creation time — see createMatchedRoomFromEntries.ts). A
  // room persisted/created before that field existed will have it
  // missing (undefined after a JSON round-trip) for its human seats —
  // `?? null` normalizes undefined/null together deliberately, since a
  // runtime JSON round-trip does not reliably preserve the TS-only
  // distinction between "field never existed" and "field explicitly
  // null".
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant
    if (participant?.kind === 'human' && (participant.stakeLedgerScope ?? null) === null) {
      return {
        safe: false,
        reason: `legacy-stake-provenance-missing:seat=${seat}: pre-fix room without a persisted stakeLedgerScope for this human — refusing automatic refund/abort`,
      }
    }
  }

  return { safe: true }
}
