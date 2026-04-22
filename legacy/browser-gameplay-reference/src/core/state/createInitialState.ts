import { SEAT_ORDER } from '../../data/constants/seatOrder'
import type { Seat } from '../../data/constants/seatOrder'
import type { GameState, Team } from './gameTypes'
import {
  createEmptyBiddingState,
  createEmptyCarryOverPoints,
  createEmptyHands,
  createEmptyPlayingState,
  createEmptyScoreBreakdown,
  createEmptyTimerState,
  createEmptyTrickState,
  createEmptyWonTricks,
  createPlayersState,
} from './createRoundDefaults'

export function getNextSeatCounterClockwise(seat: Seat): Seat {
  const currentIndex = SEAT_ORDER.indexOf(seat)

  if (currentIndex === -1) {
    return 'bottom'
  }

  return SEAT_ORDER[(currentIndex + 1) % SEAT_ORDER.length]
}

export function getPreviousSeatCounterClockwise(seat: Seat): Seat {
  const currentIndex = SEAT_ORDER.indexOf(seat)

  if (currentIndex === -1) {
    return 'left'
  }

  return SEAT_ORDER[(currentIndex - 1 + SEAT_ORDER.length) % SEAT_ORDER.length]
}

export function getTeamBySeat(seat: Seat): Team {
  if (seat === 'bottom' || seat === 'top') {
    return 'A'
  }

  return 'B'
}

export function createInitialState(): GameState {
  return {
    phase: 'new-game',
    phaseEnteredAt: null,
    players: createPlayersState(),
    round: {
      dealerSeat: null,
      cutterSeat: null,
      firstBidderSeat: null,
      firstDealSeat: null,
      selectedCutIndex: null,
    },
    deck: [],
    hands: createEmptyHands(),
    bidding: createEmptyBiddingState(),
    declarations: [],
    currentTrick: createEmptyTrickState(),
    wonTricks: createEmptyWonTricks(),
    playing: createEmptyPlayingState(),
    score: {
      round: createEmptyScoreBreakdown(),
      match: {
        teamA: 0,
        teamB: 0,
      },
      carryOver: createEmptyCarryOverPoints(),
    },
    timer: createEmptyTimerState(),
  }
}