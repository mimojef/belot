import type { RoomParticipant, Seat, ServerRoom } from './serverTypes.js'

export function seatParticipantInRoom(
  room: ServerRoom,
  seat: Seat,
  participant: RoomParticipant,
): ServerRoom {
  const seatSlot = room.seats[seat]

  if (seatSlot.participant !== null) {
    throw new Error(`Seat "${seat}" is already occupied.`)
  }

  const nextHostPlayerId =
    room.hostPlayerId ?? (participant.kind === 'human' ? participant.playerId : null)

  return {
    ...room,
    updatedAt: Date.now(),
    hostPlayerId: nextHostPlayerId,
    seats: {
      ...room.seats,
      [seat]: {
        ...seatSlot,
        participant,
      },
    },
  }
}