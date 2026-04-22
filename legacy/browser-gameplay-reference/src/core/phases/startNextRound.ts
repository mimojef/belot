import type { GameState } from '../state/gameTypes'
import { createRoundStartState } from './createRoundStartState'
import { getNextSeat } from './phaseHelpers'

export function startNextRound(state: GameState): GameState {
  const currentDealerSeat = state.round.dealerSeat

  if (!currentDealerSeat) {
    return state
  }

  const nextDealerSeat = getNextSeat(currentDealerSeat)

  return createRoundStartState(state, nextDealerSeat)
}