import type {
  RoomBiddingSnapshot,
  Seat,
} from '../network/createGameServerClient'
import type { SeatBidBubble } from './cutting/renderCuttingSeatPanels'
import type { BiddingUiState } from './activeRoomTypes'
import { getBidActionLabel } from './renderBiddingScreen'

export function clearBiddingUiState(state: BiddingUiState): void {
  if (state.botTakeoverTimerId !== null) {
    window.clearTimeout(state.botTakeoverTimerId)
  }
  for (const timerId of Object.values(state.bubbleTimerIds)) {
    if (timerId !== undefined) {
      window.clearTimeout(timerId)
    }
  }
  state.lastKnownEntriesCount = 0
  state.pendingBidSent = false
  state.wasMyTurn = false
  state.recentBubbles = {}
  state.bubbleTimerIds = {}
  state.showBotTakeover = false
  state.botTakeoverTimerId = null
}

export function clearPendingBidSubmission(state: BiddingUiState): void {
  state.pendingBidSent = false
}

export function addBidBubble(
  state: BiddingUiState,
  seat: Seat,
  label: string,
  onBubbleExpired: () => void,
): void {
  const existing = state.bubbleTimerIds[seat]
  if (existing !== undefined) {
    window.clearTimeout(existing)
  }

  state.recentBubbles[seat] = { label, startedAt: performance.now() }
  state.bubbleTimerIds[seat] = window.setTimeout(() => {
    delete state.recentBubbles[seat]
    delete state.bubbleTimerIds[seat]
    onBubbleExpired()
  }, 3300)
}

export function getBidBubblesForRender(
  state: BiddingUiState,
): Partial<Record<Seat, SeatBidBubble>> | null {
  const bidBubbles: Partial<Record<Seat, SeatBidBubble>> = {}

  for (const [seat, bubble] of Object.entries(state.recentBubbles) as [
    Seat,
    { label: string; startedAt: number },
  ][]) {
    bidBubbles[seat] = {
      label: bubble.label,
      elapsedMs: Math.round(performance.now() - bubble.startedAt),
    }
  }

  return Object.keys(bidBubbles).length > 0 ? bidBubbles : null
}

export function syncBiddingUiState(
  state: BiddingUiState,
  biddingSnapshot: RoomBiddingSnapshot | null,
  localSeat: Seat,
  onBubbleExpired: () => void,
): void {
  if (!biddingSnapshot) {
    clearBiddingUiState(state)
    return
  }

  const currentCount = biddingSnapshot.entries.length

  if (currentCount > state.lastKnownEntriesCount) {
    for (let i = state.lastKnownEntriesCount; i < currentCount; i++) {
      const entry = biddingSnapshot.entries[i]
      if (entry) {
        addBidBubble(state, entry.seat, getBidActionLabel(entry.action), onBubbleExpired)
        if (entry.seat === localSeat && !state.pendingBidSent && state.wasMyTurn) {
          state.showBotTakeover = true
        }
        if (entry.seat === localSeat) {
          state.pendingBidSent = false
        }
      }
    }
    state.lastKnownEntriesCount = currentCount
  }

  state.wasMyTurn = biddingSnapshot.canSubmitBid
}
