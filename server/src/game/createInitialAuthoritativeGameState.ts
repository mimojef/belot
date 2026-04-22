import type { Seat, ServerRoom, Team } from '../core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerPlayerState,
} from './serverGameTypes.js'
import {
  createEmptyBiddingState,
  createEmptyCarryOverPoints,
  createEmptyDeclarations,
  createEmptyHands,
  createEmptyPlayingState,
  createEmptyScoreBreakdown,
  createEmptyTimerState,
  createEmptyTrickState,
  createEmptyWonTricks,
} from './createServerRoundDefaults.js'

function getTeamBySeat(seat: Seat): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function createPlayerStateFromRoomSeat(room: ServerRoom, seat: Seat): ServerPlayerState {
  const participant = room.seats[seat].participant

  return {
    seat,
    team: getTeamBySeat(seat),
    mode: participant?.kind === 'bot' ? 'bot' : 'human',
    controlledByBot: false,
  }
}

function createPlayersStateFromRoom(
  room: ServerRoom,
): Record<Seat, ServerPlayerState> {
  return {
    bottom: createPlayerStateFromRoomSeat(room, 'bottom'),
    right: createPlayerStateFromRoomSeat(room, 'right'),
    top: createPlayerStateFromRoomSeat(room, 'top'),
    left: createPlayerStateFromRoomSeat(room, 'left'),
  }
}

export function createInitialAuthoritativeGameState(
  room: ServerRoom,
): ServerAuthoritativeGameState {
  return {
    phase: 'new-game',
    phaseEnteredAt: null,
    players: createPlayersStateFromRoom(room),
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
    declarations: createEmptyDeclarations(),
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