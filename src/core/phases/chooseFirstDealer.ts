import { SEAT_ORDER, type Seat } from '../../data/constants/seatOrder'
import type { GameState } from '../state/gameTypes'
import { createRoundStartState } from './createRoundStartState'

function getRandomSeat(): Seat {
  const randomIndex = Math.floor(Math.random() * SEAT_ORDER.length)
  return SEAT_ORDER[randomIndex]
}

export function chooseFirstDealer(state: GameState): GameState {
  const dealerSeat = getRandomSeat()
  return createRoundStartState(state, dealerSeat)
}