import type {
  HumanRoomParticipant,
  Seat,
  ServerRoom,
} from './serverTypes.js'

export function updateHumanParticipantInRoom(
  room: ServerRoom,
  seat: Seat,
  participant: HumanRoomParticipant,
): ServerRoom {
  const seatSlot = room.seats[seat]
  const currentParticipant = seatSlot.participant

  if (currentParticipant === null) {
    throw new Error(`Seat "${seat}" has no participant to update.`)
  }

  if (currentParticipant.kind !== 'human') {
    throw new Error(`Seat "${seat}" is not occupied by a human participant.`)
  }

  if (currentParticipant.playerId !== participant.playerId) {
    throw new Error(
      `Human participant mismatch on seat "${seat}". Expected "${currentParticipant.playerId}", got "${participant.playerId}".`,
    )
  }

  return {
    ...room,
    updatedAt: Date.now(),
    seats: {
      ...room.seats,
      [seat]: {
        ...seatSlot,
        participant,
      },
    },
  }
}