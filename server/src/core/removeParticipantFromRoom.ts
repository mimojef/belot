import type { ServerRoom, Seat } from './serverTypes.js'

export function removeParticipantFromRoom(room: ServerRoom, seat: Seat): ServerRoom {
  const seatSlot = room.seats[seat]

  if (seatSlot.participant === null) {
    return room
  }

  const removedParticipant = seatSlot.participant

  return {
    ...room,
    updatedAt: Date.now(),
    hostPlayerId:
      room.hostPlayerId === removedParticipant.playerId ? null : room.hostPlayerId,
    seats: {
      ...room.seats,
      [seat]: {
        ...seatSlot,
        participant: null,
      },
    },
  }
}