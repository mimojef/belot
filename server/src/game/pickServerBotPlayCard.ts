import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerCard } from './serverGameTypes.js'
import { getServerValidPlayCards } from './getServerValidPlayCards.js'

export function pickServerBotPlayCard(
  state: ServerAuthoritativeGameState,
  seat: Seat,
): ServerCard | null {
  const validCards = getServerValidPlayCards(state, seat)

  if (validCards.length > 0) {
    return validCards[0] ?? null
  }

  // Defensive fallback — should never happen if state is consistent.
  // TODO: investigate if this fires; it means validCards returned empty mid-round.
  const hand = state.hands[seat]
  return hand?.[0] ?? null
}
