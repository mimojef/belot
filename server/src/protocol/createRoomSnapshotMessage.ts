import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../core/serverTypes.js'
import {
  getDisplayNameFromIdentity,
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

export function createRoomSnapshotMessage(
  room: ServerRoom,
  yourSeat: Seat | null,
): RoomSnapshotMessage {
  return {
    type: 'room_snapshot',
    roomId: room.id,
    roomStatus: room.status,
    yourSeat,
    seats: SERVER_SEAT_ORDER.map((seat) => createSeatSnapshot(room, seat)),
  }
}