import { SERVER_SEAT_ORDER, type ConnectionId, type HumanRoomParticipant, type ServerRoom } from './serverTypes.js'

export function findHumanParticipantByConnectionId(
  room: ServerRoom,
  connectionId: ConnectionId,
): HumanRoomParticipant | null {
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (
      participant !== null &&
      participant.kind === 'human' &&
      participant.connectionId === connectionId
    ) {
      return participant
    }
  }

  return null
}