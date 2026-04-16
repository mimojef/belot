import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from './serverTypes.js'

export function findFirstOpenSeat(room: ServerRoom): Seat | null {
  for (const seat of SERVER_SEAT_ORDER) {
    if (room.seats[seat].participant === null) {
      return seat
    }
  }

  return null
}