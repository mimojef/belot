import type { ServerRoom } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'
import type { TrainingRecorder } from './trainingRecorder.js'
import type { TrainingActionOrigin } from './trainingRecorderTypes.js'
import { findAddedBidEntry, findAddedPlayedCard } from './trainingRecorderStateDiff.js'

type RoomLike = ServerRoom

function getAuthState(room: RoomLike): ServerAuthoritativeGameState | null {
  const s = room.game.authoritativeState
  if (s === null || typeof s !== 'object' || !('phase' in s)) return null
  return s as ServerAuthoritativeGameState
}

// Called from worker onApplied (bot ticks, timer expiry)
export function handleTrainingRecorderOnApplied(
  recorder: TrainingRecorder,
  previousRoom: RoomLike,
  nextRoom: RoomLike,
): void {
  handleTrainingRecorderTransition(recorder, previousRoom, nextRoom, 'auto')
}

// Called from human submitBid success path
export function handleTrainingRecorderHumanBid(
  recorder: TrainingRecorder,
  previousRoom: RoomLike,
  nextRoom: RoomLike,
): void {
  handleTrainingRecorderTransition(recorder, previousRoom, nextRoom, 'human_manual')
}

// Called from human submitPlay success path
export function handleTrainingRecorderHumanCard(
  recorder: TrainingRecorder,
  previousRoom: RoomLike,
  nextRoom: RoomLike,
): void {
  handleTrainingRecorderTransition(recorder, previousRoom, nextRoom, 'human_manual')
}

function handleTrainingRecorderTransition(
  recorder: TrainingRecorder,
  previousRoom: RoomLike,
  nextRoom: RoomLike,
  actionOrigin: TrainingActionOrigin,
): void {
  try {
    const prevState = getAuthState(previousRoom)
    const nextState = getAuthState(nextRoom)

    if (!nextState) return

    const prevPhase = prevState?.phase ?? null
    const nextPhase = nextState.phase
    const roomId = nextRoom.id

    // ── Deal start: deal-next-2 → bidding (5 cards per seat) ─────────────────
    if (prevPhase === 'deal-next-2' && nextPhase === 'bidding') {
      recorder.onBiddingStart(nextRoom, nextState)
      return
    }

    // ── Playing start: deal-last-3 → playing (8 cards per seat) ──────────────
    if (prevPhase === 'deal-last-3' && nextPhase === 'playing') {
      recorder.onPlayingStart(roomId, nextState)
      return
    }

    // ── Bid actions (including the LAST bid that exits bidding phase) ─────────
    //
    //  normal bid: prevPhase='bidding', nextPhase='bidding'
    //  last bid (won):    prevPhase='bidding', nextPhase='deal-last-3'
    //  last bid (all-pass): prevPhase='bidding', nextPhase='next-round'
    //
    // findAddedBidEntry diffs prevState.bidding.entries against
    // nextState.bidding.entries directly — no assumption about which state
    // "still has" the final entry, works identically for all three cases.
    if (prevPhase === 'bidding' && prevState !== null) {
      const bidDiff = findAddedBidEntry(prevState, nextState)

      if (bidDiff.kind === 'added') {
        recorder.onBidAction(roomId, prevState, nextState, bidDiff.entry, actionOrigin)
      } else if (bidDiff.kind === 'mismatch') {
        recorder.onInvalidTransition('bid-diff-mismatch')
      }

      // All-pass: write bidding_only record
      if (nextPhase === 'next-round') {
        recorder.onAllPass(roomId, nextState)
      }
      return
    }

    // ── Card actions (including the LAST card that ends the round) ────────────
    //
    //  normal card: prevPhase='playing', nextPhase='playing'
    //  last card:   prevPhase='playing', nextPhase='scoring'
    //
    // findAddedPlayedCard diffs the flattened play history (completed tricks +
    // current trick) — works identically whether or not the round just ended.
    if (prevPhase === 'playing' && prevState !== null) {
      const cardDiff = findAddedPlayedCard(prevState, nextState)

      if (cardDiff.kind === 'added') {
        recorder.onCardPlayed(
          roomId, prevState, nextState, cardDiff.play, actionOrigin,
        )
      } else if (cardDiff.kind === 'mismatch') {
        recorder.onInvalidTransition('card-diff-mismatch')
      }

      if (nextPhase === 'scoring') {
        recorder.onDealComplete(roomId, nextState)
      }
      return
    }

  } catch {
    // Recorder must never throw into gameplay
  }
}
