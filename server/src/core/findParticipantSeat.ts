import { SERVER_SEAT_ORDER, type PlayerId, type Seat, type ServerRoom } from './serverTypes.js'

export function findParticipantSeat(room: ServerRoom, playerId: PlayerId): Seat | null {
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (participant?.playerId === playerId) {
      return seat
    }
  }

  return null
}