import type { ServerRoom } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'
import type { TrainingRecorder } from './trainingRecorder.js'
import type { TrainingActionOrigin } from './trainingRecorderTypes.js'

type RoomLike = ServerRoom

function getAuthState(room: RoomLike): ServerAuthoritativeGameState | null {
  const s = room.game.authoritativeState
  if (s === null || typeof s !== 'object' || !('phase' in s)) return null
  return s as ServerAuthoritativeGameState
}

// Score-based deal index — good enough for within-process deduplication.
// The authoritative unique ID is the random recordingId created in the collector.
function getDealIndex(state: ServerAuthoritativeGameState): number {
  const seatOrder = ['bottom', 'right', 'top', 'left']
  const dealerIdx = seatOrder.indexOf(state.round.dealerSeat ?? 'bottom')
  return state.score.match.teamA * 10000 + state.score.match.teamB * 100 + dealerIdx
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

    // ── Deal start: deal-next-2 → bidding (5 cards per seat) ─────────────────
    if (prevPhase === 'deal-next-2' && nextPhase === 'bidding') {
      const dealIndex = getDealIndex(nextState)
      recorder.onBiddingStart(nextRoom, nextState, dealIndex)
      return
    }

    // ── Playing start: deal-last-3 → playing (8 cards per seat) ──────────────
    if (prevPhase === 'deal-last-3' && nextPhase === 'playing') {
      const dealIndex = getDealIndex(nextState)
      recorder.onPlayingStart(nextRoom.id, dealIndex, nextState)
      return
    }

    // ── Bid actions (including the LAST bid that exits bidding phase) ─────────
    //
    //  normal bid: prevPhase='bidding', nextPhase='bidding'
    //  last bid (won):    prevPhase='bidding', nextPhase='deal-last-3'
    //  last bid (all-pass): prevPhase='bidding', nextPhase='next-round'
    //
    // In all cases prevState is in 'bidding' phase and has the entries list.
    if (prevPhase === 'bidding' && prevState !== null) {
      const prevEntries = prevState.bidding.entries

      if (nextPhase === 'bidding') {
        // Normal bid: new entry appeared in nextState
        const nextEntries = nextState.bidding.entries
        if (nextEntries.length > prevEntries.length) {
          const dealIndex = getDealIndex(nextState)
          const lastEntry = nextEntries[nextEntries.length - 1]!
          recorder.onBidAction(
            nextRoom.id, dealIndex, prevState, nextState, lastEntry.seat, actionOrigin,
          )
        }
      } else if (nextPhase === 'deal-last-3' || nextPhase === 'next-round') {
        // Last bid: the final entry is still in prevState.bidding.entries
        const lastEntry = prevEntries[prevEntries.length - 1]
        if (lastEntry) {
          const dealIndex = getDealIndex(nextState)
          recorder.onBidAction(
            nextRoom.id, dealIndex, prevState, nextState, lastEntry.seat, actionOrigin,
          )
        }

        // All-pass: write bidding_only record
        if (nextPhase === 'next-round') {
          const dealIndex = getDealIndex(nextState)
          recorder.onAllPass(nextRoom.id, dealIndex, nextState)
        }
      }
      return
    }

    // ── Card actions (including the LAST card that ends the round) ────────────
    //
    //  normal card: prevPhase='playing', nextPhase='playing'
    //  last card:   prevPhase='playing', nextPhase='scoring'
    //
    // In both cases prevState is in 'playing' phase.
    if (prevPhase === 'playing' && prevState !== null) {
      const prevPlaying = prevState.playing
      if (!prevPlaying) return

      if (nextPhase === 'playing') {
        // Normal card: detect new play in nextState
        const nextPlaying = nextState.playing
        if (!nextPlaying) return

        const prevTotal =
          prevPlaying.completedTricks.reduce((s, t) => s + t.plays.length, 0) +
          prevPlaying.currentTrick.plays.length
        const nextTotal =
          nextPlaying.completedTricks.reduce((s, t) => s + t.plays.length, 0) +
          nextPlaying.currentTrick.plays.length

        if (nextTotal > prevTotal) {
          const { seat, cardId } = findNewCard(prevPlaying, nextPlaying)
          if (seat && cardId) {
            const dealIndex = getDealIndex(nextState)
            recorder.onCardPlayed(
              nextRoom.id, dealIndex, prevState, nextState, seat, cardId, actionOrigin,
            )
          }
        }
      } else if (nextPhase === 'scoring') {
        // Last card (32nd): it completed the 8th trick.
        // prevState.playing.completedTricks now has 8 tricks, last entry is trick 8.
        const lastTrick = prevPlaying.completedTricks[prevPlaying.completedTricks.length - 1]
        if (lastTrick) {
          const lastPlay = lastTrick.plays[lastTrick.plays.length - 1]
          if (lastPlay) {
            const dealIndex = getDealIndex(nextState)
            recorder.onCardPlayed(
              nextRoom.id, dealIndex, prevState, nextState,
              lastPlay.seat, lastPlay.card.id, actionOrigin,
            )
          }
        }

        // Deal complete
        const dealIndex = getDealIndex(nextState)
        recorder.onDealComplete(nextRoom.id, dealIndex, nextState)
      }
      return
    }

  } catch {
    // Recorder must never throw into gameplay
  }
}

function findNewCard(
  prevPlaying: NonNullable<ServerAuthoritativeGameState['playing']>,
  nextPlaying: NonNullable<ServerAuthoritativeGameState['playing']>,
): { seat: import('../core/serverTypes.js').Seat | null; cardId: string | null } {
  if (nextPlaying.currentTrick.plays.length > prevPlaying.currentTrick.plays.length) {
    const newPlay = nextPlaying.currentTrick.plays[nextPlaying.currentTrick.plays.length - 1]
    if (newPlay) return { seat: newPlay.seat, cardId: newPlay.card.id }
  } else {
    const lastCompleted = nextPlaying.completedTricks[nextPlaying.completedTricks.length - 1]
    if (lastCompleted) {
      const lastPlay = lastCompleted.plays[lastCompleted.plays.length - 1]
      if (lastPlay) return { seat: lastPlay.seat, cardId: lastPlay.card.id }
    }
  }
  return { seat: null, cardId: null }
}
