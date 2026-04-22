import { SERVER_SEAT_ORDER, type Seat } from '../core/serverTypes.js'

export function getNextSeat(seat: Seat): Seat {
  const index = SERVER_SEAT_ORDER.indexOf(seat)

  if (index === -1) {
    return 'bottom'
  }

  return SERVER_SEAT_ORDER[(index + 1) % SERVER_SEAT_ORDER.length]
}

export function getPreviousSeat(seat: Seat): Seat {
  const index = SERVER_SEAT_ORDER.indexOf(seat)

  if (index === -1) {
    return 'left'
  }

  return SERVER_SEAT_ORDER[
    (index - 1 + SERVER_SEAT_ORDER.length) % SERVER_SEAT_ORDER.length
  ]
}

export function getSeatAfterDealer(dealerSeat: Seat): Seat {
  return getNextSeat(dealerSeat)
}

export function getSeatBeforeDealer(dealerSeat: Seat): Seat {
  return getPreviousSeat(dealerSeat)
}