import { SERVER_SEAT_ORDER, type ServerRoom } from './serverTypes.js'

export function getRoomParticipantCount(room: ServerRoom): number {
  let count = 0

  for (const seat of SERVER_SEAT_ORDER) {
    if (room.seats[seat].participant !== null) {
      count += 1
    }
  }

  return count
}