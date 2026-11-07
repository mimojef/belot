import type { ServerAntiBadLuckConfig } from './antiBadLuck/serverAntiBadLuckTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { createServerRoundStartState } from './createServerRoundStartState.js'
import { resolveServerNextRoundDeck } from './physicalShuffle/resolveServerNextRoundDeck.js'
import { getNextSeat } from './serverPhaseHelpers.js'

// antiBadLuckConfig определя тестето на новото раздаване (виж
// resolveServerNextRoundDeck): при праг 0 → физическо размесване на
// камарата от ТОВА (приключило) раздаване — взятките или, при всички пас,
// ръцете + неразданите карти. Камарата се събира тук, преди
// createServerRoundStartState да нулира playing/hands/deck. null (стари
// тестови извиквания) → съществуващото случайно разбъркване.
export function startNextServerRound(
  state: ServerAuthoritativeGameState,
  antiBadLuckConfig: ServerAntiBadLuckConfig | null = null,
  nextRandom: () => number = Math.random,
): ServerAuthoritativeGameState {
  const currentDealerSeat = state.round.dealerSeat

  if (!currentDealerSeat) {
    return state
  }

  const nextDealerSeat = getNextSeat(currentDealerSeat)
  const nextRoundDeck = resolveServerNextRoundDeck(state, antiBadLuckConfig, nextRandom)

  return createServerRoundStartState(state, nextDealerSeat, nextRoundDeck.deck)
}
