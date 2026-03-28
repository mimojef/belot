import { SEAT_ORDER, type Seat } from '../../data/constants/seatOrder'
import type { PhaseType } from './phaseTypes'

export function getNextSeat(seat: Seat): Seat {
  const index = SEAT_ORDER.indexOf(seat)

  if (index === -1) {
    return 'bottom'
  }

  return SEAT_ORDER[(index + 1) % SEAT_ORDER.length]
}

export function getPreviousSeat(seat: Seat): Seat {
  const index = SEAT_ORDER.indexOf(seat)

  if (index === -1) {
    return 'left'
  }

  return SEAT_ORDER[(index - 1 + SEAT_ORDER.length) % SEAT_ORDER.length]
}

export function getSeatAfterDealer(dealerSeat: Seat): Seat {
  return getNextSeat(dealerSeat)
}

export function getSeatBeforeDealer(dealerSeat: Seat): Seat {
  return getPreviousSeat(dealerSeat)
}

export function isRoundSetupPhase(phase: PhaseType): boolean {
  return (
    phase === 'new-game' ||
    phase === 'choose-first-dealer' ||
    phase === 'cutting' ||
    phase === 'cut-resolve' ||
    phase === 'deal-first-3' ||
    phase === 'deal-next-2' ||
    phase === 'bidding' ||
    phase === 'deal-last-3'
  )
}

export function isPlayingPhase(phase: PhaseType): boolean {
  return phase === 'playing'
}

export function isScoringPhase(phase: PhaseType): boolean {
  return phase === 'scoring' || phase === 'summary' || phase === 'next-round'
}