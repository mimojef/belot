import { SEAT_ORDER, type Seat } from '../../data/constants/seatOrder'
import type { Card } from '../state/gameTypes'

type DealPacketsResult = {
  hands: Record<Seat, Card[]>
  remainingDeck: Card[]
}

function getSeatIndex(seat: Seat): number {
  return SEAT_ORDER.indexOf(seat)
}

function getCounterClockwiseDealOrder(firstSeat: Seat): Seat[] {
  const firstSeatIndex = getSeatIndex(firstSeat)

  if (firstSeatIndex === -1) {
    return [...SEAT_ORDER]
  }

  return [
    SEAT_ORDER[firstSeatIndex],
    SEAT_ORDER[(firstSeatIndex + 1) % SEAT_ORDER.length],
    SEAT_ORDER[(firstSeatIndex + 2) % SEAT_ORDER.length],
    SEAT_ORDER[(firstSeatIndex + 3) % SEAT_ORDER.length],
  ]
}

export function dealCardsInPackets(
  deck: Card[],
  initialHands: Record<Seat, Card[]>,
  firstSeat: Seat,
  packetSize: number,
  rounds: number
): DealPacketsResult {
  const workingDeck = [...deck]
  const hands: Record<Seat, Card[]> = {
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