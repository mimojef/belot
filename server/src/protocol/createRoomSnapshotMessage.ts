import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'
import {
  getDisplayNameFromIdentity,
  type RoomGameSnapshot,
  type RoomSeatSnapshot,
  type RoomSnapshotMessage,
} from './messageTypes.js'

function createSeatSnapshot(room: ServerRoom, seat: Seat): RoomSeatSnapshot {
  const participant = room.seats[seat].participant

  if (participant === null) {
    return {
      seat,
      displayName: 'Празно място',
      isOccupied: false,
      isBot: false,
      isConnected: false,
      avatarUrl: null,
      level: null,
      rankTitle: null,
      skillRating: null,
    }
  }

  return {
    seat,
    displayName: getDisplayNameFromIdentity(participant.identity),
    isOccupied: true,
    isBot: participant.kind === 'bot',
    isConnected: participant.kind === 'bot' ? true : participant.isConnected,
    avatarUrl: participant.identity.avatarUrl,
    level: participant.identity.level,
    rankTitle: participant.identity.rankTitle,
    skillRating: participant.identity.skillRating,
  }
}

function getReconnectTokenForSeat(
  room: ServerRoom,
  yourSeat: Seat | null,
): string | null {
  if (yourSeat === null) {
    return null
  }

  const participant = room.seats[yourSeat].participant

  if (participant === null || participant.kind !== 'human') {
    return null
  }

  return participant.reconnectToken
}

function isAuthoritativeGameState(
  value: ServerRoom['game']['authoritativeState'],
): value is ServerAuthoritativeGameState {
  return value !== null && !('kind' in value)
}

function createGameSnapshot(
  room: ServerRoom,
  yourSeat: Seat | null,
): RoomGameSnapshot | null {
  const authoritativeState = room.game.authoritativeState

  if (!isAuthoritativeGameState(authoritativeState)) {
    return null
  }

  return {
    phase: room.game.phase,
    authoritativePhase: authoritativeState.phase,
    timerDeadlineAt: room.game.timerDeadlineAt,
    dealerSeat: authoritativeState.round.dealerSeat,
    cutting: {
      cutterSeat: authoritativeState.round.cutterSeat,
      selectedCutIndex: authoritativeState.round.selectedCutIndex,
      deckCount: authoritativeState.deck.length,
      canSubmitCut:
        yourSeat !== null &&
        yourSeat === authoritativeState.round.cutterSeat &&
        authoritativeState.phase === 'cutting' &&
        authoritativeState.round.selectedCutIndex === null,
    },
  }
}

export function createRoomSnapshotMessage(
  room: ServerRoom,
  yourSeat: Seat | null,
): RoomSnapshotMessage {
  return {
    type: 'room_snapshot',
    roomId: room.id,
    roomStatus: room.status,
    yourSeat,
    reconnectToken: getReconnectTokenForSeat(room, yourSeat),
    seats: SERVER_SEAT_ORDER.map((seat) => createSeatSnapshot(room, seat)),
    game: createGameSnapshot(room, yourSeat),
  }
}
