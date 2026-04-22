import type { Seat, Team } from '../core/serverTypes.js'
import { SERVER_SEAT_ORDER } from '../core/serverTypes.js'

export function getNextSeatCounterClockwise(seat: Seat): Seat {
  const currentIndex = SERVER_SEAT_ORDER.indexOf(seat)

  if (currentIndex === -1) {
    return 'bottom'
  }

  return SERVER_SEAT_ORDER[(currentIndex + 1) % SERVER_SEAT_ORDER.length]
}

export function getPreviousSeatCounterClockwise(seat: Seat): Seat {
  const currentIndex = SERVER_SEAT_ORDER.indexOf(seat)

  if (currentIndex === -1) {
    return 'left'
  }

  return SERVER_SEAT_ORDER[
    (currentIndex - 1 + SERVER_SEAT_ORDER.length) % SERVER_SEAT_ORDER.length
  ]
}

export function getTeamBySeat(seat: Seat): Team {
  if (seat === 'bottom' || seat === 'top') {
    return 'A'
  }

  return 'B'
}