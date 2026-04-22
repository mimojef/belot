import { SERVER_SEAT_ORDER, type Seat } from '../core/serverTypes.js'
import type { ServerCard } from './serverGameTypes.js'

type DealPacketsResult = {
  hands: Record<Seat, ServerCard[]>
  remainingDeck: ServerCard[]
}

function getSeatIndex(seat: Seat): number {
  return SERVER_SEAT_ORDER.indexOf(seat)
}

function getCounterClockwiseDealOrder(firstSeat: Seat): Seat[] {
  const firstSeatIndex = getSeatIndex(firstSeat)

  if (firstSeatIndex === -1) {
    return [...SERVER_SEAT_ORDER]
  }

  return [
    SERVER_SEAT_ORDER[firstSeatIndex],
    SERVER_SEAT_ORDER[(firstSeatIndex + 1) % SERVER_SEAT_ORDER.length],
    SERVER_SEAT_ORDER[(firstSeatIndex + 2) % SERVER_SEAT_ORDER.length],
    SERVER_SEAT_ORDER[(firstSeatIndex + 3) % SERVER_SEAT_ORDER.length],
  ]
}

export function dealServerCardsInPackets(
  deck: ServerCard[],
  initialHands: Record<Seat, ServerCard[]>,
  firstSeat: Seat,
  packetSize: number,
  rounds: number,
): DealPacketsResult {
  const workingDeck = [...deck]
  const hands: Record<Seat, ServerCard[]> = {
    bottom: [...initialHands.bottom],
    right: [...initialHands.right],
    top: [...initialHands.top],
    left: [...initialHands.left],
  }

  const dealOrder = getCounterClockwiseDealOrder(firstSeat)

  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    for (const seat of dealOrder) {
      const packet = workingDeck.splice(0, packetSize)
      hands[seat].push(...packet)
    }
  }

  return {
    hands,
    remainingDeck: workingDeck,
  }
}