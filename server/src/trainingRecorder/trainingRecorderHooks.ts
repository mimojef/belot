import type { ServerRoom } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'
import type { TrainingRecorder } from './trainingRecorder.js'

type RoomLike = ServerRoom

function getAuthState(room: RoomLike): ServerAuthoritativeGameState | null {
  const s = room.game.authoritativeState
  if (s === null || typeof s !== 'object' || !('phase' in s)) return null
  return s as ServerAuthoritativeGameState
}

// Returns a stable deal index based on the round score state.
// We use teamA+teamB match score as a discriminator — it changes every round.
// Combined with dealerSeat it gives a unique-enough key per process.
function getDealIndex(state: ServerAuthoritativeGameState): number {
  // Use stateVersion-independent key: sum of match scores + dealer seat index
  const seatOrder = ['bottom', 'right', 'top', 'left']
  const dealerIdx = seatOrder.indexOf(state.round.dealerSeat ?? 'bottom')
  // Encode as a small integer — good enough for within-room deduplication
  return state.score.match.teamA * 10000 + state.score.match.teamB * 100 + dealerIdx
}

export function handleTrainingRecorderOnApplied(
  recorder: TrainingRecorder,
  previousRoom: RoomLike,
  nextRoom: RoomLike,
): void {
  try {
    const prevState = getAuthState(previousRoom)
    const nextState = getAuthState(nextRoom)

    if (!nextState) return

    const prevPhase = prevState?.phase ?? null
    const nextPhase = nextState.phase

    // ── Deal start: transition INTO bidding after deal-last-3 ──────────────
    // At this point all 8 cards are in hands.
    if (prevPhase === 'deal-last-3' && nextPhase === 'bidding') {
      const dealIndex = getDealIndex(nextState)
      recorder.onDealStart(nextRoom, nextState, dealIndex)
      return
    }

    // ── Bid action: a new bidding entry appeared ──────────────────────────
    if (nextPhase === 'bidding' && prevState !== null) {
      const prevEntries = prevState.bidding.entries
      const nextEntries = nextState.bidding.entries

      if (nextEntries.length > prevEntries.length) {
        const dealIndex = getDealIndex(nextState)
        const lastEntry = nextEntries[nextEntries.length - 1]!
        const seat = lastEntry.seat

        // Determine if this was a timeout action
        // If prev state had the same seat in timer.activeSeat and timer.expiresAt
        // has passed → timeout. We detect by checking if the seat is controlled by bot
        // in nextState but was NOT in prevState (takeover happened).
        const prevPlayer = prevState.players[seat]
        const nextPlayer = nextState.players[seat]
        const wasTimedOut =
          (!prevPlayer?.controlledByBot && nextPlayer?.controlledByBot) ||
          (prevPlayer?.mode !== 'bot' && nextPlayer?.controlledByBot)

        recorder.onBidAction(nextRoom.id, dealIndex, nextState, seat, wasTimedOut)
      }
      return
    }

    // ── Card played: a new card appeared in currentTrick or completedTricks ─
    if (nextPhase === 'playing' && prevState?.phase === 'playing') {
      const prevPlaying = prevState.playing
      const nextPlaying = nextState.playing

      if (!prevPlaying || !nextPlaying) return

      const prevTotalPlayed =
        prevPlaying.completedTricks.reduce((s, t) => s + t.plays.length, 0) +
        prevPlaying.currentTrick.plays.length

      const nextTotalPlayed =
        nextPlaying.completedTricks.reduce((s, t) => s + t.plays.length, 0) +
        nextPlaying.currentTrick.plays.length

      if (nextTotalPlayed > prevTotalPlayed) {
        // Find the card that was just played
        // It's either the last play in currentTrick or the last play in the newest completedTrick
        let seat = null as null | import('../core/serverTypes.js').Seat
        let cardId: string | null = null

        if (nextPlaying.currentTrick.plays.length > prevPlaying.currentTrick.plays.length) {
          // Card went into currentTrick
          const newPlay =
            nextPlaying.currentTrick.plays[nextPlaying.currentTrick.plays.length - 1]
          if (newPlay) {
            seat = newPlay.seat
            cardId = newPlay.card.id
          }
        } else {
          // A trick was completed and reset — check last completedTrick
          const lastCompleted =
            nextPlaying.completedTricks[nextPlaying.completedTricks.length - 1]
          if (lastCompleted) {
            const lastPlay = lastCompleted.plays[lastCompleted.plays.length - 1]
            if (lastPlay) {
              seat = lastPlay.seat
              cardId = lastPlay.card.id
            }
          }
        }

        if (seat && cardId) {
          const dealIndex = getDealIndex(nextState)

          const prevPlayer = prevState.players[seat]
          const nextPlayer = nextState.players[seat]
          const wasTimedOut =
            (!prevPlayer?.controlledByBot && nextPlayer?.controlledByBot) ||
            (prevPlayer?.mode !== 'bot' && nextPlayer?.controlledByBot)

          recorder.onCardPlayed(
            nextRoom.id,
            dealIndex,
            prevState,
            nextState,
            seat,
            cardId,
            wasTimedOut,
          )
        }
      }
      return
    }

    // ── Deal complete: transition playing → scoring ────────────────────────
    if (prevPhase === 'playing' && nextPhase === 'scoring') {
      const dealIndex = getDealIndex(nextState)
      recorder.onDealComplete(nextRoom.id, dealIndex, nextState)
      return
    }

    // ── Deal abandoned: next-round without scoring (all pass) ─────────────
    if (prevPhase === 'bidding' && nextPhase === 'next-round') {
      if (prevState !== null) {
        const dealIndex = getDealIndex(prevState)
        recorder.onDealAbandoned(nextRoom.id, dealIndex)
      }
      return
    }

  } catch {
    // Recorder must never throw into gameplay
  }
}
